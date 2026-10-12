/* IndexedDB shared by the service worker and extension pages. */
(() => {
  "use strict";
  const NAME = "deepseek-task-workbench";
  const VERSION = 3;
  const definitions = {
    sessions: { keyPath: ["accountId", "sessionId"], indexes: [["byAccount", "accountId"], ["byPurpose", ["accountId", "purpose", "updatedAtMs"]]] },
    messages: { keyPath: ["accountId", "sessionId", "messageId"], indexes: [["byAccount", "accountId"], ["bySession", ["accountId", "sessionId"]]] },
    projects: { keyPath: ["accountId", "projectId"], indexes: [["byAccount", "accountId"]] },
    memberships: { keyPath: ["accountId", "sessionId"], indexes: [["byAccount", "accountId"]] },
    memories: { keyPath: ["accountId", "memoryId"], indexes: [["byAccount", "accountId"]] },
    memoryTurns: { keyPath: ["accountId", "turnKey"], indexes: [["byAccount", "accountId"]] },
    memoryHistory: { keyPath: "accountId", indexes: [["byAccount", "accountId"]] },
    jobs: { keyPath: ["accountId", "jobId"], indexes: [["byAccount", "accountId"]] },
    settings: { keyPath: ["accountId", "key"], indexes: [["byAccount", "accountId"]] },
    metrics: { keyPath: ["accountId", "metricId"], indexes: [["byAccount", "accountId"]] },
  };
  let pending;
  function open() {
    if (!pending) pending = new Promise((resolve, reject) => {
      const request = indexedDB.open(NAME, VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const [name, definition] of Object.entries(definitions)) {
          if (db.objectStoreNames.contains(name)) continue;
          const store = db.createObjectStore(name, { keyPath: definition.keyPath });
          for (const [index, keyPath] of definition.indexes) store.createIndex(index, keyPath);
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); pending = null; };
        resolve(db);
      };
      request.onerror = () => { pending = null; reject(request.error); };
    });
    return pending;
  }
  async function transaction(names, mode, callback) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(names, mode);
      let result;
      try { result = callback(tx); } catch (error) { tx.abort(); reject(error); return; }
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("数据库事务中止"));
    });
  }
  async function get(store, key) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const request = db.transaction(store).objectStore(store).get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }
  async function all(store, accountId) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const source = db.transaction(store).objectStore(store);
      const request = accountId === undefined ? source.getAll() : source.index("byAccount").getAll(accountId);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async function by(store, index, value) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const request = db.transaction(store).objectStore(store).index(index).getAll(value);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  const contentKey = (memory) => {
    const text = String(memory.content || "").normalize("NFKC").toLowerCase().replace(/\s+/g, "");
    let first = 2166136261; let second = 5381;
    for (let index = 0; index < text.length; index++) {
      first = Math.imul(first ^ text.charCodeAt(index), 16777619);
      second = Math.imul(second ^ text.charCodeAt(index), 33);
    }
    return `${text.length}:${first >>> 0}:${second >>> 0}`;
  };
  const isForgotten = (history, memory) => (history?.forgotten || []).some((item) =>
    item.memoryId === memory.memoryId || (item.scope === memory.scope && item.projectId === memory.projectId
      && item.contentKey === contentKey(memory)));
  const validMemory = (memory) => memory && typeof memory.content === "string" && Boolean(memory.content.trim())
    && typeof memory.memoryId === "string" && Boolean(memory.memoryId) && typeof memory.kind === "string"
    && ["PERSONAL", "PROJECT"].includes(memory.scope) && ["ACTIVE", "CANDIDATE", "DISABLED", "STALE"].includes(memory.state)
    && (memory.scope === "PERSONAL" ? memory.projectId == null : typeof memory.projectId === "string" && Boolean(memory.projectId))
    && Number.isInteger(memory.version) && memory.version > 0;
  const memoryIntact = (current, expected) => validMemory(current) && current.scope === expected.scope
    && current.projectId === expected.projectId && current.version >= expected.version;
  // Keep expected missing rows until the integrity check can validate their sources.
  function saveHistory(tx, accountId, removed = [], allowed = [], rememberDeletion = true) {
    const store = tx.objectStore("memoryHistory");
    const historyRequest = store.get(accountId);
    const memoriesRequest = tx.objectStore("memories").index("byAccount").getAll(accountId);
    let history; let memories;
    const save = () => {
      if (history === undefined || memories === undefined) return;
      history ||= { accountId, snapshots: [], forgotten: [] };
      const now = Date.now();
      const removedIds = new Set(removed.map((memory) => memory.memoryId));
      history.forgotten = (history.forgotten || []).filter((item) => !allowed.some((memory) =>
        isForgotten({ forgotten: [item] }, memory)));
      for (const memory of rememberDeletion ? removed : []) {
        history.forgotten = history.forgotten.filter((item) => item.memoryId !== memory.memoryId);
        history.forgotten.push({ memoryId: memory.memoryId, scope: memory.scope, projectId: memory.projectId,
          contentKey: contentKey(memory), deletedAtMs: now });
      }
      const previous = history.snapshots?.at(-1)?.memories || [];
      const previousById = new Map(previous.map((memory) => [memory.memoryId, memory]));
      const usable = memories.filter((memory) => validMemory(memory) && !isForgotten(history, memory)
        && memory.version >= (previousById.get(memory.memoryId)?.version || 0));
      const currentIds = new Set(usable.map((memory) => memory.memoryId));
      const expected = usable.concat(previous.filter((memory) => !currentIds.has(memory.memoryId)
        && !removedIds.has(memory.memoryId) && !isForgotten(history, memory)));
      // Remove deliberately deleted text from every retained snapshot.
      history.snapshots = (history.snapshots || []).map((snapshot) => ({ ...snapshot,
        memories: snapshot.memories.filter((memory) => !removedIds.has(memory.memoryId) && !isForgotten(history, memory)) }));
      if (JSON.stringify(previous) !== JSON.stringify(expected) || !history.snapshots.length)
        history.snapshots.push({ createdAtMs: now, memories: expected });
      history.snapshots = history.snapshots.slice(-5);
      history.updatedAtMs = now;
      store.put(history);
    };
    historyRequest.onsuccess = () => { history = historyRequest.result || null; save(); };
    memoriesRequest.onsuccess = () => { memories = memoriesRequest.result; save(); };
  }
  const put = (store, value, options = {}) => transaction(
    store === "memories" ? [store, "memoryHistory"] : [store], "readwrite", (tx) => {
      tx.objectStore(store).put(value);
      if (store === "memories") saveHistory(tx, value.accountId, [], options.allowForgotten ? [value] : []);
    });
  const remove = (store, key) => transaction([store], "readwrite", (tx) => tx.objectStore(store).delete(key));
  const removeMemories = (accountId, memories, epochKey, epoch) => transaction(["memories", "settings", "memoryHistory"], "readwrite", (tx) => {
    let remaining = memories.length;
    for (const memory of memories) {
      const store = tx.objectStore("memories");
      const request = store.get([accountId, memory.memoryId]);
      request.onsuccess = () => {
        const current = request.result;
        if (!current || current.version !== memory.version || current.scope !== memory.scope || current.projectId !== memory.projectId) {
          tx.abort(); return;
        }
        store.delete([accountId, memory.memoryId]);
        if (!--remaining) saveHistory(tx, accountId, memories);
      };
    }
    tx.objectStore("settings").put({ accountId, key: epochKey, value: epoch });
  });
  const saveMemoryCategory = (accountId, category, expected, updates, removed, epochKey, epoch, withinBudget) =>
    transaction(["memories", "settings", "memoryHistory"], "readwrite", (tx) => {
      const store = tx.objectStore("memories");
      const request = store.index("byAccount").getAll(accountId);
      request.onsuccess = () => {
        try {
          const rows = request.result;
          const current = rows.filter((memory) => memory.scope === category.scope && memory.projectId === category.projectId
            && (category.kinds.includes(memory.kind) ? memory.kind : "其他") === category.kind);
          if (current.length !== expected.length || current.some((memory) => !expected.some((entry) =>
            entry.memoryId === memory.memoryId && entry.version === memory.version)) || !withinBudget(rows)) {
            tx.abort(); return;
          }
          for (const memory of removed) store.delete([accountId, memory.memoryId]);
          for (const memory of updates) store.put(memory);
          tx.objectStore("settings").put({ accountId, key: epochKey, value: epoch });
          saveHistory(tx, accountId, removed, updates);
        } catch { tx.abort(); }
      };
    });
  // Commit the memories, processing ledger, pending queue and job together.
  const commitMemoryBatch = (accountId, sessionIds, decide) => {
    let failure;
    return transaction(
    ["memories", "memoryTurns", "projects", "jobs", "settings", "sessions", "memberships", "messages", "memoryHistory"], "readwrite", (tx) => {
      const rows = {}; let remaining = 8 + sessionIds.length;
      const complete = () => {
        if (--remaining) return;
        try {
          const changes = decide(rows);
          for (const [name, entries] of Object.entries(changes))
            if (name !== "removedMemories") for (const entry of entries) tx.objectStore(name).put(entry);
          for (const memory of changes.removedMemories || []) tx.objectStore("memories").delete([accountId, memory.memoryId]);
          if (changes.memories?.length || changes.removedMemories?.length)
            saveHistory(tx, accountId, changes.removedMemories || [], [], false);
        } catch (error) { failure = error; tx.abort(); }
      };
      for (const name of ["memories", "memoryTurns", "projects", "jobs", "settings", "sessions", "memberships"]) {
        const request = tx.objectStore(name).index("byAccount").getAll(accountId);
        request.onsuccess = () => { rows[name] = request.result; complete(); };
      }
      const historyRequest = tx.objectStore("memoryHistory").get(accountId);
      historyRequest.onsuccess = () => { rows.memoryHistory = historyRequest.result || null; complete(); };
      rows.messages = [];
      for (const sessionId of sessionIds) {
        const request = tx.objectStore("messages").index("bySession").getAll([accountId, sessionId]);
        request.onsuccess = () => { rows.messages.push(...request.result); complete(); };
      }
    }).catch((error) => { throw failure || error; });
  };
  const checkMemoryHistory = (accountId, validate) => {
    let result = { restored: 0, unavailable: 0 };
    return transaction(["memories", "memoryHistory", "sessions", "memberships", "projects", "messages", "settings"],
      "readwrite", (tx) => {
        const rows = {}; let remaining = 2;
        const complete = () => {
          if (--remaining) return;
          const history = rows.memoryHistory[0];
          if (!history) { saveHistory(tx, accountId); return; }
          for (const memory of rows.memories.filter((memory) => isForgotten(history, memory)))
            tx.objectStore("memories").delete([accountId, memory.memoryId]);
          rows.memories = rows.memories.filter((memory) => !isForgotten(history, memory));
          const latest = history.snapshots?.at(-1);
          if (!latest) return;
          const current = new Map(rows.memories.map((memory) => [memory.memoryId, memory]));
          const missing = latest.memories.filter((memory) => {
            const existing = current.get(memory.memoryId);
            return !isForgotten(history, memory) && !memoryIntact(existing, memory);
          });
          if (!missing.length) return;
          const sessionIds = [...new Set(missing.map((memory) => memory.sourceSessionId).filter(Boolean))];
          let needed = 4 + sessionIds.length;
          const recover = () => {
            if (--needed) return;
            for (const memory of missing) {
              if (!validate(memory, rows)) { result.unavailable++; continue; }
              tx.objectStore("memories").put(memory);
              rows.memories = rows.memories.filter((row) => row.memoryId !== memory.memoryId).concat(memory);
              result.restored++;
            }
            if (result.restored) {
              history.lastRecovery = { restored: result.restored, recoveredAtMs: Date.now() };
              tx.objectStore("memoryHistory").put(history);
            }
          };
          for (const name of ["sessions", "memberships", "projects", "settings"]) {
            const request = tx.objectStore(name).index("byAccount").getAll(accountId);
            request.onsuccess = () => { rows[name] = request.result; recover(); };
          }
          rows.messages = [];
          for (const sessionId of sessionIds) {
            const request = tx.objectStore("messages").index("bySession").getAll([accountId, sessionId]);
            request.onsuccess = () => { rows.messages.push(...request.result); recover(); };
          }
        };
        for (const name of ["memories", "memoryHistory"]) {
          const request = tx.objectStore(name).index("byAccount").getAll(accountId);
          request.onsuccess = () => { rows[name] = request.result; complete(); };
        }
      }).then(() => result);
  };
  globalThis.DTWDB = Object.freeze({ open, transaction, get, all, by, put, remove, removeMemories, saveMemoryCategory,
    commitMemoryBatch, checkMemoryHistory, isForgotten, validMemory, memoryIntact });
})();
