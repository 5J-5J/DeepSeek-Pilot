/* IndexedDB shared by the service worker and extension pages. */
(() => {
  "use strict";
  const NAME = "deepseek-task-workbench";
  const VERSION = 1;
  const definitions = {
    sessions: { keyPath: ["accountId", "sessionId"], indexes: [["byAccount", "accountId"], ["byPurpose", ["accountId", "purpose", "updatedAtMs"]]] },
    messages: { keyPath: ["accountId", "sessionId", "messageId"], indexes: [["byAccount", "accountId"], ["bySession", ["accountId", "sessionId"]]] },
    projects: { keyPath: ["accountId", "projectId"], indexes: [["byAccount", "accountId"]] },
    memberships: { keyPath: ["accountId", "sessionId"], indexes: [["byAccount", "accountId"]] },
    memories: { keyPath: ["accountId", "memoryId"], indexes: [["byAccount", "accountId"]] },
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
      request.onsuccess = () => resolve(request.result);
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
      const request = db.transaction(store).objectStore(store).index("byAccount").getAll(accountId);
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
  const put = (store, value) => transaction([store], "readwrite", (tx) => tx.objectStore(store).put(value));
  const remove = (store, key) => transaction([store], "readwrite", (tx) => tx.objectStore(store).delete(key));
  globalThis.DTWDB = Object.freeze({ open, transaction, get, all, by, put, remove });
})();
