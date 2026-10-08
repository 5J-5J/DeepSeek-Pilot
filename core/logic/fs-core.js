/**
 * DeepSeek 任务工作台：文件夹存储领域逻辑。
 *
 * 记录映射、合并与比对是纯逻辑；目录 handle 的 IndexedDB 存取
 * （openHandleStore/loadStoredHandle/saveStoredHandle）是 service worker 和
 * popup 共用的薄壳——两者同属 chrome-extension:// 源，读写同一个库。
 * 注意：handle 不能经 chrome.runtime.sendMessage 传递（JSON 序列化会剥掉
 * 原型），只能通过这个共享的 IndexedDB 交接。真正的文件 IO 在 background.js。
 */
/* global DTWMemory */
(() => {
  "use strict";

  // 与 memory-core 的 safeId 同一字符集（safeId 未导出，这里复制保持一致）：
  // 文件名必须跨机器稳定，禁止路径分隔符与特殊字符。
  const fileSafeId = (value) => String(value ?? "").trim().replace(/[^a-zA-Z0-9:_-]/g, "").slice(0, 120);

  const FACTS_FILE = "facts.json";
  const META_FILE = "meta.json";
  const META = { schemaVersion: 1 };

  const taskFileName = (taskId) => `tasks/${fileSafeId(taskId)}.json`;
  const conversationFileName = (conversationId) => `conversations/${fileSafeId(conversationId)}.json`;

  const stableJson = (value) => JSON.stringify(value);
  const recordChanged = (a, b) => stableJson(a) !== stableJson(b);

  // store → 文件记录。facts 用显式信封 updatedAt（调用方维护，内容变化时刷新），
  // 不能从 facts 推导：只删除最新事实会让推导出的时间戳倒退，已删事实复活。
  // 任务记录的空 updatedAt（clearTaskMemory 之后）用 now 补齐，否则永远输给旧手改文件。
  function recordsFromStore(storeValue, now, factsStamp) {
    const store = DTWMemory.normalizeStore(storeValue);
    const tasks = {};
    for (const [taskId, taskMemory] of Object.entries(store.taskMemories)) {
      const id = fileSafeId(taskId);
      if (!id) continue;
      const record = DTWMemory.normalizeTaskMemory(taskMemory);
      if (!record.updatedAt) record.updatedAt = String(now || "").slice(0, 40);
      tasks[id] = record;
    }
    return {
      facts: { updatedAt: String(factsStamp || now || "").slice(0, 40), facts: store.userFacts },
      tasks,
    };
  }

  // 文件记录 → store：只替换 taskMemories/userFacts，运行时字段（jobs、
  // turnFingerprints、maintenanceConversationIds、settings）原样保留。
  function recordsIntoStore(storeValue, records) {
    const store = DTWMemory.normalizeStore(storeValue);
    if (records?.tasks && typeof records.tasks === "object") {
      const tasks = {};
      for (const [taskId, taskMemory] of Object.entries(records.tasks)) {
        const id = fileSafeId(taskId);
        if (id) tasks[id] = DTWMemory.normalizeTaskMemory(taskMemory);
      }
      store.taskMemories = tasks;
    }
    if (Array.isArray(records?.facts?.facts)) {
      store.userFacts = records.facts.facts
        .map((fact, index) => DTWMemory.normalizeFact(fact, index))
        .filter(Boolean);
    }
    return store;
  }

  // 三向合并：按记录 updatedAt 新者胜，平局文件胜（手改保护）。
  // 返回 { records, fileChanged, copyChanged }；fileChanged 表示需要把差异写回文件。
  function mergeRecords(fileRecords, copyRecords) {
    const fileTasks = fileRecords?.tasks || {};
    const copyTasks = copyRecords?.tasks || {};
    const tasks = {};
    let fileChanged = false;
    let copyChanged = false;
    for (const id of new Set([...Object.keys(fileTasks), ...Object.keys(copyTasks)])) {
      const fromFile = fileTasks[id];
      const fromCopy = copyTasks[id];
      if (!fromFile) { tasks[id] = fromCopy; fileChanged = true; continue; }
      if (!fromCopy) { tasks[id] = fromFile; copyChanged = true; continue; }
      const fileWins = String(fromFile.updatedAt || "") >= String(fromCopy.updatedAt || "");
      tasks[id] = fileWins ? fromFile : fromCopy;
      if (recordChanged(fromFile, tasks[id])) fileChanged = true;
      if (recordChanged(fromCopy, tasks[id])) copyChanged = true;
    }
    const fileFacts = fileRecords?.facts || null;
    const copyFacts = copyRecords?.facts || null;
    let facts = copyFacts;
    if (fileFacts && copyFacts) {
      facts = String(fileFacts.updatedAt || "") >= String(copyFacts.updatedAt || "") ? fileFacts : copyFacts;
    } else if (fileFacts || copyFacts) {
      facts = fileFacts || copyFacts;
      (facts === fileFacts ? (copyChanged = true) : (fileChanged = true));
    }
    if (facts && fileFacts && recordChanged(fileFacts, facts)) fileChanged = true;
    if (facts && copyFacts && recordChanged(copyFacts, facts)) copyChanged = true;
    return { records: { facts, tasks }, fileChanged, copyChanged };
  }

  // 单个记录文件 → 记录；坏 JSON / 非法结构返回 null（调用方把文件名计入 skipped）。
  function parseRecordFile(text, kind) {
    let value;
    try { value = JSON.parse(String(text)); } catch { return null; }
    if (!value || typeof value !== "object") return null;
    if (kind === "facts") {
      const facts = (Array.isArray(value.facts) ? value.facts : [])
        .map((fact, index) => DTWMemory.normalizeFact(fact, index))
        .filter(Boolean);
      return { updatedAt: String(value.updatedAt || "").slice(0, 40), facts };
    }
    return DTWMemory.normalizeTaskMemory(value);
  }

  // 记录级 diff：只输出需要写入/删除的文件，避免高频保存时全量重写。
  function diffRecords(prevRecords, nextRecords) {
    const prevTasks = prevRecords?.tasks || {};
    const nextTasks = nextRecords?.tasks || {};
    const writes = [];
    const removes = [];
    for (const [id, task] of Object.entries(nextTasks)) {
      if (!recordChanged(prevTasks[id], task)) continue;
      writes.push({ path: taskFileName(id), kind: "task", id, value: task });
    }
    for (const id of Object.keys(prevTasks)) {
      if (!nextTasks[id]) removes.push(taskFileName(id));
    }
    if (recordChanged(prevRecords?.facts, nextRecords?.facts)) {
      writes.push({ path: FACTS_FILE, kind: "facts", id: "", value: nextRecords.facts });
    }
    return { writes, removes };
  }

  // 整理采集条目 → 会话存档（字段与 job.captured 对齐；只写不读）。
  function buildConversationArchive(capture, now) {
    const messages = (Array.isArray(capture?.messages) ? capture.messages : [])
      .map((message) => ({
        id: String(message?.id || "").slice(0, 240),
        role: message?.role === "user" ? "user" : "assistant",
        text: String(message?.text || ""),
        revision: Math.max(1, Number(message?.revision) || 1),
      }))
      .filter((message) => message.id && message.text);
    return {
      schemaVersion: 1,
      conversationId: fileSafeId(capture?.conversationId),
      title: String(capture?.title || "").slice(0, 160),
      capturedAt: String(now || "").slice(0, 40),
      captureIncomplete: Boolean(capture?.captureIncomplete),
      messages,
    };
  }

  // ---- 目录 handle 的共享存取（IndexedDB，扩展源内 SW 与 popup 共见）----
  // 库：dtw-fs / store：handles / key：root。结构与 background.js 原实现一致，
  // 已保存的授权不需要重新选择。
  // 早期版本把消息通道传来的空壳 handle 存进过库里，因此读取时必须校验：
  // 不是真句柄一律当作没有授权（下次保存会覆盖它）。
  const isDirectoryHandle = (handle) => Boolean(handle)
    && handle.kind === "directory"
    && typeof handle.queryPermission === "function"
    && typeof handle.requestPermission === "function"
    && typeof handle.getDirectoryHandle === "function";

  function openHandleStore() {
    if (!globalThis.indexedDB) return Promise.reject(new Error("IndexedDB 不可用"));
    return new Promise((resolve, reject) => {
      const request = globalThis.indexedDB.open("dtw-fs", 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("handles")) request.result.createObjectStore("handles");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("IndexedDB 不可用"));
    });
  }

  async function swapStoredHandle(action, handle) {
    if (action === "put" && !isDirectoryHandle(handle)) {
      throw new Error("无效的目录句柄，拒绝保存");
    }
    const db = await openHandleStore();
    try {
      return await new Promise((resolve, reject) => {
        const store = db.transaction("handles", "readwrite").objectStore("handles");
        const request = action === "get" ? store.get("root") : store.put(handle, "root");
        request.onsuccess = () => {
          const value = request.result || null;
          resolve(action === "get" && !isDirectoryHandle(value) ? null : value);
        };
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  }

  const loadStoredHandle = () => swapStoredHandle("get").catch(() => null);
  const saveStoredHandle = (handle) => swapStoredHandle("put", handle);

  globalThis.DTWFS = Object.freeze({
    FACTS_FILE,
    META_FILE,
    META,
    taskFileName,
    conversationFileName,
    recordsFromStore,
    recordsIntoStore,
    mergeRecords,
    parseRecordFile,
    diffRecords,
    buildConversationArchive,
    isDirectoryHandle,
    loadStoredHandle,
    saveStoredHandle,
  });
})();
