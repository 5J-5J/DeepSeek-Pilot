/* global DTWMemory, DTWFS */
"use strict";

importScripts("../logic/memory-core.js", "../logic/fs-core.js");

const SIDEBAR_KEY = "dtw.sidebar.v1";
const MEMORY_KEY = "dtw.memory.v1";
const FS_KEY = "dtw.fs.v1";
const PROCESSING = new Set();
const MAX_PROMPT_CHARS = 60000;
const MAX_JOBS = 20;

const now = () => new Date().toISOString();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readWorkspace() {
  const stored = await chrome.storage.local.get([SIDEBAR_KEY, MEMORY_KEY]);
  return {
    sidebar: stored[SIDEBAR_KEY] || { tasks: [], conversations: {} },
    memory: DTWMemory.normalizeStore(stored[MEMORY_KEY]),
  };
}

// ---- 文件夹存储（File System Access）------------------------------------
// 文件夹是记忆（taskMemories/userFacts）的唯一真相源；chrome.storage.local 里的
// MEMORY_KEY 退化为副本 + 运行时状态（jobs/turnFingerprints/settings）。
// 所有文件 IO 都在这个 service worker 里：content script 的 IndexedDB 属于页面
// 源，拿不到这里存的目录 handle。

const fsRuntime = { root: undefined, queue: Promise.resolve(), records: null };
let fsState = { status: "unauthorized", lastError: "", lastSyncAt: "", factsStamp: "", factsSig: "" };

function factsSignature(facts) {
  let hash = 5381;
  const value = JSON.stringify(facts || []);
  for (let index = 0; index < value.length; index += 1) hash = ((hash << 5) + hash) ^ value.charCodeAt(index);
  return (hash >>> 0).toString(36);
}

// facts.json 的信封时间戳：内容（签名）变化时刷新，代表「副本这一侧最后一次变化」。
// 跨 SW 重启必须持久化，否则降级期间发生的变化会在合并时输给旧文件。
function refreshFactsStamp(store) {
  const signature = factsSignature(store.userFacts);
  if (signature !== fsState.factsSig) {
    fsState.factsSig = signature;
    fsState.factsStamp = now();
  } else if (!fsState.factsStamp) {
    fsState.factsStamp = now();
  }
  return fsState.factsStamp;
}

const loadStoredHandle = () => DTWFS.loadStoredHandle();

// 所有文件夹操作互斥，避免并发 createWritable 撕裂文件。
function runFs(task) {
  const next = fsRuntime.queue.then(task, task);
  fsRuntime.queue = next.catch(() => {});
  return next;
}

// undefined = 未加载；null = 没有存过 handle（未授权）；handle = 已授权缓存。
// 授权失效（重启后 queryPermission 回到 prompt）无法在 SW 里重授权 → degraded。
async function getRoot() {
  if (fsRuntime.root) {
    try {
      if (await fsRuntime.root.queryPermission({ mode: "readwrite" }) === "granted") return fsRuntime.root;
    } catch { /* handle 失效，重新从 IndexedDB 加载 */ }
    fsRuntime.root = undefined;
  }
  const handle = await loadStoredHandle();
  if (!handle) {
    await setFsStatus("unauthorized", "");
    return null;
  }
  let granted = false;
  try {
    granted = await handle.queryPermission({ mode: "readwrite" }) === "granted";
  } catch { granted = false; }
  if (!granted) {
    await setFsStatus("degraded", "记忆文件夹授权已失效，点击扩展图标重新授权");
    return null;
  }
  fsRuntime.root = handle;
  await setFsStatus("ok", "");
  return handle;
}

async function setFsStatus(status, error) {
  fsState.status = status;
  fsState.lastError = String(error || "").slice(0, 200);
  try {
    await chrome.action.setBadgeText({ text: status === "degraded" ? "!" : "" });
  } catch { /* action 上下文不可用时忽略 */ }
  const stored = (await chrome.storage.local.get(FS_KEY))[FS_KEY] || {};
  if (["status", "lastError", "lastSyncAt", "factsStamp", "factsSig"].some((key) => stored[key] !== fsState[key])) {
    await chrome.storage.local.set({ [FS_KEY]: fsState });
  }
}

async function readTextPath(root, path) {
  // 逐段拆目录，最后一段才是文件名；单段路径（meta.json/facts.json）若按
  // split 的 [dirName, fileName] 解构会把文件名当目录（曾把授权过的文件夹
  // 写出名为 meta.json 的目录，插件从此读写全静默失败）。
  const parts = path.split("/");
  const fileName = parts.pop();
  let dir = root;
  for (const part of parts) dir = await dir.getDirectoryHandle(part);
  const file = await (await dir.getFileHandle(fileName)).getFile();
  return file.text();
}

async function writeTextPath(root, path, text) {
  const parts = path.split("/");
  const fileName = parts.pop();
  let dir = root;
  for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
  const stream = await (await dir.getFileHandle(fileName, { create: true })).createWritable();
  // ponytail: createWritable 不是原子替换；写坏的文件会被 parseRecordFile 当作
  // 缺失处理，由副本在下次 reconcile 回填。需要真原子再换成写临时文件 + move。
  await stream.write(text);
  await stream.close();
}

async function readAllRecords(root) {
  const tasks = {};
  const skipped = [];
  const tasksDir = await root.getDirectoryHandle("tasks").catch(() => null);
  if (tasksDir) {
    for await (const [name, handle] of tasksDir.entries()) {
      if (handle.kind !== "file" || !name.endsWith(".json")) continue;
      const text = await handle.getFile().then((file) => file.text()).catch(() => null);
      const record = text === null ? null : DTWFS.parseRecordFile(text, "task");
      if (!record) {
        skipped.push(`tasks/${name}`);
        continue;
      }
      tasks[name.slice(0, -5)] = record;
    }
  }
  let facts = null;
  const factsText = await readTextPath(root, DTWFS.FACTS_FILE).catch(() => null);
  if (factsText !== null) {
    facts = DTWFS.parseRecordFile(factsText, "facts");
    if (!facts) skipped.push(DTWFS.FACTS_FILE);
  }
  return { tasks, facts, skipped };
}

// 落盘写操作；返回被磁盘「较新的手改文件」赢走的记录（调用方要采纳进副本）。
async function writeRecords(root, ops) {
  const adopted = { tasks: {}, facts: null };
  for (const path of ops.removes) {
    const [dirName, fileName] = path.split("/");
    const dir = dirName ? await root.getDirectoryHandle(dirName).catch(() => null) : root;
    if (dir) await dir.removeEntry(fileName).catch(() => {});
  }
  for (const write of ops.writes) {
    const diskText = await readTextPath(root, write.path).catch(() => null);
    const disk = diskText === null ? null : DTWFS.parseRecordFile(diskText, write.kind);
    if (disk && String(disk.updatedAt || "") > String(write.value.updatedAt || "")) {
      if (write.kind === "facts") adopted.facts = disk;
      else adopted.tasks[write.id] = disk;
      continue;
    }
    await writeTextPath(root, write.path, `${JSON.stringify(write.value, null, 2)}\n`);
  }
  return adopted;
}

// merge：按记录 updatedAt 新者胜（平局文件胜），用于启动/授权/降级恢复。
// reload：文件夹整体权威，副本中文件夹没有的任务被移除（显式按钮）。
// 文件夹为空而副本有数据时，merge 天然完成迁移导出。
async function reconcile(mode = "merge") {
  await ensureFsState();
  const root = await getRoot();
  if (!root) return { ok: false, status: fsState.status, loaded: {}, skipped: [] };
  return runFs(async () => {
    const fileRecords = await readAllRecords(root);
    const { memory } = await readWorkspace();
    const stamp = refreshFactsStamp(memory);
    if (mode === "reload") {
      fsRuntime.records = fileRecords;
      const store = DTWFS.recordsIntoStore(memory, fileRecords);
      if (fileRecords.facts) {
        fsState.factsStamp = fileRecords.facts.updatedAt || fsState.factsStamp;
        fsState.factsSig = factsSignature(store.userFacts);
      }
      await chrome.storage.local.set({ [MEMORY_KEY]: store });
      fsState.lastSyncAt = now();
      await setFsStatus("ok", "");
      return {
        ok: true,
        loaded: { tasks: Object.keys(fileRecords.tasks).length, facts: fileRecords.facts?.facts.length || 0 },
        skipped: fileRecords.skipped,
      };
    }
    const copyRecords = DTWFS.recordsFromStore(memory, stamp, fsState.factsStamp);
    const merged = DTWFS.mergeRecords(fileRecords, copyRecords);
    let store = memory;
    let recordsChanged = merged.copyChanged;
    if (merged.records.facts) {
      fsState.factsStamp = merged.records.facts.updatedAt || fsState.factsStamp;
    }
    if (merged.fileChanged) {
      const adopted = await writeRecords(root, DTWFS.diffRecords(fileRecords, merged.records));
      if (adopted.facts) merged.records.facts = adopted.facts;
      Object.assign(merged.records.tasks, adopted.tasks);
      recordsChanged = true;
    }
    if (recordsChanged) {
      store = DTWFS.recordsIntoStore(memory, merged.records);
      fsState.factsSig = factsSignature(store.userFacts);
      await chrome.storage.local.set({ [MEMORY_KEY]: store });
    }
    fsRuntime.records = merged.records;
    fsState.lastSyncAt = now();
    await setFsStatus("ok", "");
    return { ok: true, loaded: {}, skipped: fileRecords.skipped };
  });
}

// 会话原文存档：整理采集成功后立即落盘，只写不读（整理输入永远来自新鲜采集，
// 依赖 background.js 的旧消息编辑/删除检测）。可在设置里整体关闭。
async function persistConversationArchive(capture) {
  const { memory } = await readWorkspace();
  if (!memory.settings.archiveConversations) return;
  const root = await getRoot();
  if (!root) return;
  const archive = DTWFS.buildConversationArchive(capture, now());
  if (!archive.conversationId || !archive.messages.length) return;
  try {
    await runFs(() => writeTextPath(root, DTWFS.conversationFileName(archive.conversationId), `${JSON.stringify(archive, null, 2)}\n`));
  } catch (error) {
    await setFsStatus("degraded", `会话存档写入失败：${error?.message || error}`);
  }
}

// 记忆持久化的唯一入口：先文件（授权时），后 storage 副本；文件失败不阻塞副本。
async function writeMemory(memory) {
  await ensureFsState();
  const store = DTWMemory.normalizeStore(memory);
  const stamp = refreshFactsStamp(store);
  const records = DTWFS.recordsFromStore(store, stamp, fsState.factsStamp);
  const root = await getRoot();
  if (root) {
    try {
      await runFs(async () => {
        const adopted = await writeRecords(root, DTWFS.diffRecords(fsRuntime.records, records));
        if (adopted.facts) records.facts = adopted.facts;
        Object.assign(records.tasks, adopted.tasks);
      });
    } catch (error) {
      await setFsStatus("degraded", `记忆文件写入失败：${error?.message || error}`);
    }
  }
  fsRuntime.records = records;
  if (records.facts) fsState.factsSig = factsSignature(records.facts.facts);
  await chrome.storage.local.set({ [MEMORY_KEY]: DTWFS.recordsIntoStore(store, records) });
  await setFsStatus(fsState.status, fsState.lastError);
  return { ok: true, degraded: fsState.status === "degraded" };
}

async function writeSidebar(sidebar) {
  await chrome.storage.local.set({ [SIDEBAR_KEY]: sidebar });
}

function findTask(sidebar, taskId) {
  return (Array.isArray(sidebar?.tasks) ? sidebar.tasks : []).find((task) => task?.id === taskId) || null;
}

function taskOwningConversation(sidebar, conversationId) {
  return (Array.isArray(sidebar?.tasks) ? sidebar.tasks : [])
    .find((task) => Array.isArray(task?.conversationIds) && task.conversationIds.includes(conversationId)) || null;
}

function conversationRefsForTask(sidebar, task) {
  return (Array.isArray(task?.conversationIds) ? task.conversationIds : [])
    .map((id) => sidebar?.conversations?.[id])
    .filter((conversation) => conversation?.id && conversation?.href)
    .map((conversation) => ({ id: conversation.id, title: conversation.title || "", href: conversation.href }));
}

function pruneJobs(memory) {
  const jobs = Object.values(memory.jobs).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const live = jobs.filter((job) => ["queued", "running"].includes(job.status));
  const terminal = jobs.filter((job) => !["queued", "running"].includes(job.status))
    .slice(0, Math.max(0, MAX_JOBS - live.length));
  memory.jobs = Object.fromEntries([...live, ...terminal].map((job) => [job.id, job]));
}

async function startJob(taskId) {
  const { sidebar, memory } = await readWorkspace();
  const task = findTask(sidebar, taskId);
  if (!task) throw new Error("任务不存在或已经被删除");
  const refs = conversationRefsForTask(sidebar, task);
  if (!refs.length) throw new Error("任务中还没有可整理的 DeepSeek 会话");

  const existing = Object.values(memory.jobs).find((job) =>
    job.taskId === taskId && ["queued", "running"].includes(job.status));
  if (existing) return { ok: true, jobId: existing.id, reused: true };
  const activeJob = Object.values(memory.jobs).find((job) => job.status === "running");

  const current = DTWMemory.normalizeTaskMemory(memory.taskMemories[taskId]);
  const sourceEpoch = Math.max(1, Number(task.sourceEpoch) || 1);
  if (!current.version) current.sourceEpoch = sourceEpoch;
  const job = {
    id: DTWMemory.makeId("job"),
    kind: "memory",
    taskId,
    taskName: String(task.name || "").slice(0, 80),
    baseVersion: current.version,
    sourceEpoch,
    conversationRefs: refs,
    captured: [],
    status: "queued",
    phase: "capture",
    createdAt: now(),
    updatedAt: now(),
    error: "",
    summaryTabId: null,
    maintenanceConversationId: "",
  };
  memory.jobs[job.id] = job;
  current.status = "updating";
  current.error = "";
  current.lastJobId = job.id;
  current.sourceEpoch = sourceEpoch;
  memory.taskMemories[taskId] = current;
  pruneJobs(memory);
  await writeMemory(memory);
  return { ok: true, jobId: job.id, reused: false, queuedBehind: activeJob?.id || "" };
}

async function startClassificationJob(conversationId) {
  const { sidebar, memory } = await readWorkspace();
  const convId = String(conversationId || "").replace(/[^a-zA-Z0-9_-]/g, "");
  const conversation = sidebar.conversations?.[convId];
  if (!memory.settings.autoClassify) return { ok: true, skipped: "disabled" };
  if (!conversation?.href) throw new Error("找不到要归类的会话");
  if (taskOwningConversation(sidebar, convId)) return { ok: true, skipped: "already-assigned" };
  // 分类提示必须保持在请求体 60000 字符上限内；MVP 最多携带
  // 60 个项目，避免项目概况把会话样本挤出去。
  const candidateTaskIds = (sidebar.tasks || []).map((task) => task.id).filter(Boolean).slice(0, 60);
  if (!candidateTaskIds.length) return { ok: true, skipped: "no-projects" };
  const existing = Object.values(memory.jobs).find((job) =>
    job.kind === "classify" && job.conversationId === convId && ["queued", "running"].includes(job.status));
  if (existing) return { ok: true, jobId: existing.id, reused: true };
  const activeJob = Object.values(memory.jobs).find((job) => job.status === "running");
  const job = {
    id: DTWMemory.makeId("classify"),
    kind: "classify",
    taskId: "",
    taskName: "",
    conversationId: convId,
    candidateTaskIds,
    conversationRefs: [{ id: convId, title: conversation.title || "", href: conversation.href }],
    captured: [],
    status: "queued",
    phase: "capture",
    createdAt: now(),
    updatedAt: now(),
    error: "",
    summaryTabId: null,
    maintenanceConversationId: "",
  };
  memory.jobs[job.id] = job;
  pruneJobs(memory);
  await writeMemory(memory);
  return { ok: true, jobId: job.id, reused: false, queuedBehind: activeJob?.id || "" };
}

async function saveJob(job) {
  const { memory } = await readWorkspace();
  memory.jobs[job.id] = job;
  pruneJobs(memory);
  await writeMemory(memory);
}

async function waitForTabComplete(tabId, timeoutMs = 45000) {
  const current = await chrome.tabs.get(tabId);
  if (current.status === "complete") return current;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("等待 DeepSeek 页面加载超时"));
    }, timeoutMs);
    function onUpdated(updatedId, change, tab) {
      if (updatedId !== tabId || change.status !== "complete") return;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve(tab);
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function sendWithRetry(tabId, message, attempts = 30) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (error) {
      lastError = error;
      await delay(500);
    }
  }
  throw new Error(lastError?.message || "无法连接 DeepSeek 页面");
}

async function safeCloseTab(tabId) {
  if (!Number.isInteger(tabId)) return;
  try { await chrome.tabs.remove(tabId); } catch { /* The user may already have closed it. */ }
}

function flattenCaptured(job) {
  return job.captured.flatMap((capture) => capture.messages.map((message) => ({
    ...message,
    conversationId: capture.conversationId,
  })));
}

// Prefer a tab that already shows this conversation: it is rendered (hidden
// tabs never hydrate DeepSeek's chat DOM) and its MAIN world can call the
// history API directly. Returns null to fall back to a fresh hidden tab.
async function captureFromExistingTab(conversationId) {
  try {
    const tabs = await chrome.tabs.query({ url: "https://chat.deepseek.com/*" });
    const escaped = String(conversationId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`/chat/s/${escaped}(?:[/?#]|$)`);
    for (const tab of tabs) {
      if (!pattern.test(tab.url || "")) continue;
      try {
        const result = await chrome.tabs.sendMessage(tab.id, {
          type: "dtw:capture-conversation",
          expectedId: conversationId,
        });
        if (result?.ok && Array.isArray(result.messages) && result.messages.length) return result;
      } catch { /* Tab without the content script; try the next one. */ }
    }
  } catch { /* tabs.query unavailable; use the hidden-tab path. */ }
  return null;
}

async function captureConversation(ref) {
  let result = await captureFromExistingTab(ref.id);
  if (result) return result;
  const tab = await chrome.tabs.create({ url: ref.href, active: false });
  try {
    await waitForTabComplete(tab.id);
    return await sendWithRetry(tab.id, { type: "dtw:capture-conversation", expectedId: ref.id });
  } finally {
    await safeCloseTab(tab.id);
  }
}

async function processClassificationJob(job, sidebar, memory) {
  if (!memory.settings.autoClassify) {
    job.status = "cancelled";
    job.phase = "done";
    job.updatedAt = now();
    await saveJob(job);
    return;
  }
  const conversation = sidebar.conversations?.[job.conversationId];
  if (!conversation?.href) throw new Error("待归类会话已不存在");
  if (taskOwningConversation(sidebar, job.conversationId)) {
    job.status = "cancelled";
    job.phase = "done";
    job.updatedAt = now();
    await saveJob(job);
    return;
  }
  const candidates = (sidebar.tasks || []).filter((task) => job.candidateTaskIds.includes(task.id));
  if (!candidates.length) throw new Error("没有可用项目可供归类");
  job.status = "running";
  job.phase = "capture";
  job.updatedAt = now();
  await saveJob(job);

  const result = await captureConversation(job.conversationRefs[0]);
  if (!result?.ok || !Array.isArray(result.messages) || !result.messages.length) {
    throw new Error(result?.error || "无法读取待归类会话");
  }
  let remaining = 12000;
  const messages = [];
  for (const message of result.messages.slice(0, 12)) {
    if (remaining <= 0) break;
    const body = String(message.text || "").slice(0, remaining);
    if (body) messages.push({ role: message.role, text: body });
    remaining -= body.length;
  }
  job.captured = [{
    conversationId: job.conversationId,
    title: conversation.title || "",
    captureIncomplete: Boolean(result.captureIncomplete),
    messages: result.messages,
  }];
  job.updatedAt = now();
  await saveJob(job);

  const prompt = DTWMemory.buildProjectClassificationPrompt({
    job,
    conversation,
    tasks: candidates.map((task) => ({
      id: task.id,
      name: task.name,
      summary: DTWMemory.normalizeTaskMemory(memory.taskMemories[task.id]).summary.slice(0, 300),
    })),
    messages,
  });
  if (prompt.length > MAX_PROMPT_CHARS) throw new Error("自动归类输入超过 60000 字符，已保留在未分类");
  const summaryTab = await chrome.tabs.create({ url: "https://chat.deepseek.com/a/chat", active: false });
  job.phase = "summarize";
  job.summaryTabId = summaryTab.id;
  job.updatedAt = now();
  await saveJob(job);
  await waitForTabComplete(summaryTab.id);
  const started = await sendWithRetry(summaryTab.id, {
    type: "dtw:run-project-classifier",
    jobId: job.id,
    prompt,
  });
  if (!started?.ok) throw new Error(started?.error || "DeepSeek 自动归类未能开始");
}

async function processJob(jobId) {
  if (PROCESSING.has(jobId)) return;
  PROCESSING.add(jobId);
  try {
    let { sidebar, memory } = await readWorkspace();
    let job = memory.jobs[jobId];
    if (!job || !["queued", "running"].includes(job.status)) return;
    const otherRunning = Object.values(memory.jobs).find((entry) => entry.id !== jobId && entry.status === "running");
    if (otherRunning) return;
    if (job.kind === "classify") {
      await processClassificationJob(job, sidebar, memory);
      return;
    }
    const task = findTask(sidebar, job.taskId);
    if (!task) throw new Error("任务已被删除，整理已取消");
    if (Math.max(1, Number(task.sourceEpoch) || 1) !== job.sourceEpoch) {
      throw new Error("任务的会话归属已经改变，请重新整理");
    }
    job.status = "running";
    job.phase = "capture";
    job.updatedAt = now();
    await saveJob(job);

    const capturedIds = new Set(job.captured.map((entry) => entry.conversationId));
    for (const ref of job.conversationRefs) {
      if (capturedIds.has(ref.id)) continue;
      const result = await captureConversation(ref);
      if (!result?.ok || !Array.isArray(result.messages) || !result.messages.length) {
        throw new Error(result?.error || `无法从会话“${ref.title || ref.id}”读取对话原文`);
      }
      const prospectiveChars = [
        ...job.captured.flatMap((entry) => entry.messages),
        ...result.messages,
      ].reduce((total, message) => total + String(message.text || "").length, 0);
      if (prospectiveChars > 50000) {
        throw new Error(`任务原文共 ${prospectiveChars} 字符，超过当前单次安全整理容量；为避免静默截断，本次未更新记忆`);
      }
      const captureEntry = {
        conversationId: ref.id,
        title: ref.title,
        captureIncomplete: Boolean(result.captureIncomplete),
        messages: result.messages,
      };
      job.captured.push(captureEntry);
      job.updatedAt = now();
      await saveJob(job);
      await persistConversationArchive(captureEntry).catch(() => {});
    }

    ({ sidebar, memory } = await readWorkspace());
    job = memory.jobs[jobId];
    const freshTask = findTask(sidebar, job.taskId);
    const currentMemory = DTWMemory.normalizeTaskMemory(memory.taskMemories[job.taskId]);
    if (!freshTask || currentMemory.version !== job.baseVersion) {
      throw new Error("整理期间任务记忆已被修改，旧结果不会覆盖新版本");
    }
    for (const capture of job.captured) {
      const prefix = `${capture.conversationId}:`;
      const previouslyCovered = currentMemory.coveredMessageIds.filter((id) => id.startsWith(prefix));
      const currentlyVisible = new Set(capture.messages.map((message) => message.id));
      if (previouslyCovered.some((id) => !currentlyVisible.has(id))) {
        throw new Error(`会话“${capture.title || capture.conversationId}”的旧消息已编辑、删除或未完整加载；为避免沿用过时记忆，本次未自动合并`);
      }
    }
    const allMessages = flattenCaptured(job);
    const alreadyCovered = new Set(currentMemory.coveredMessageIds);
    const messages = allMessages.filter((message) => !alreadyCovered.has(message.id));
    if (!messages.length) throw new Error("没有发现尚未整理的新消息");
    const prompt = DTWMemory.buildDistillPrompt({
      job,
      task: freshTask,
      currentMemory,
      userFacts: memory.userFacts,
      messages,
    });
    if (prompt.length > MAX_PROMPT_CHARS) {
      throw new Error(`待整理原文共 ${prompt.length} 字符，超过当前单次 60000 字符上限；为避免静默截断，本次未更新记忆`);
    }

    const summaryTab = await chrome.tabs.create({ url: "https://chat.deepseek.com/a/chat", active: false });
    job.phase = "summarize";
    job.summaryTabId = summaryTab.id;
    job.updatedAt = now();
    await saveJob(job);
    await waitForTabComplete(summaryTab.id);
    const started = await sendWithRetry(summaryTab.id, {
      type: "dtw:run-memory-summary",
      jobId: job.id,
      prompt,
    });
    if (!started?.ok) throw new Error(started?.error || "DeepSeek 整理会话未能开始");
  } finally {
    PROCESSING.delete(jobId);
  }
}

async function failJob(jobId, error) {
  const { memory } = await readWorkspace();
  const job = memory.jobs[jobId];
  if (!job || ["done", "cancelled"].includes(job.status)) return;
  job.status = "failed";
  job.updatedAt = now();
  job.error = String(error?.message || error || "未知错误").slice(0, 500);
  memory.jobs[jobId] = job;
  if (job.kind !== "classify") {
    const taskMemory = DTWMemory.normalizeTaskMemory(memory.taskMemories[job.taskId]);
    if (taskMemory.lastJobId === jobId) {
      taskMemory.status = "error";
      taskMemory.error = job.error;
      memory.taskMemories[job.taskId] = taskMemory;
    }
  }
  await writeMemory(memory);
  await safeCloseTab(job.summaryTabId);
}

async function handleSummaryResult(message, sender) {
  const { sidebar, memory } = await readWorkspace();
  const job = memory.jobs[message.jobId];
  if (!job || job.kind === "classify" || job.status !== "running" || job.phase !== "summarize") {
    throw new Error("整理作业已结束或不存在");
  }
  if (job.summaryTabId && sender.tab?.id !== job.summaryTabId) throw new Error("整理结果来自错误的标签页");
  if (message.error) throw new Error(String(message.error).slice(0, 500));
  const task = findTask(sidebar, job.taskId);
  const current = DTWMemory.normalizeTaskMemory(memory.taskMemories[job.taskId]);
  if (!task || Math.max(1, Number(task.sourceEpoch) || 1) !== job.sourceEpoch) {
    throw new Error("任务来源已经变化，旧整理结果不会写入");
  }
  if (current.version !== job.baseVersion) throw new Error("任务记忆版本已经变化，旧整理结果不会写入");
  const messages = flattenCaptured(job).filter((entry) => !new Set(current.coveredMessageIds).has(entry.id));
  const validated = DTWMemory.validateDistillResult(message.raw, {
    job,
    messages,
    currentMemory: current,
    userFacts: memory.userFacts,
  });
  const nextStore = DTWMemory.applyDistillResult(memory, validated, {
    job,
    messages,
    now: now(),
    captureIncomplete: job.captured.some((entry) => entry.captureIncomplete),
  });
  const nextJob = nextStore.jobs[job.id];
  nextJob.status = "done";
  nextJob.phase = "done";
  nextJob.error = "";
  nextJob.updatedAt = now();
  nextJob.maintenanceConversationId = String(message.conversationId || "").replace(/[^a-zA-Z0-9_-]/g, "");
  nextJob.captured = [];
  if (nextJob.maintenanceConversationId) {
    nextStore.maintenanceConversationIds = [...new Set([
      ...nextStore.maintenanceConversationIds,
      nextJob.maintenanceConversationId,
    ])].slice(-500);
  }
  pruneJobs(nextStore);
  await writeMemory(nextStore);
  await safeCloseTab(job.summaryTabId);
  return { ok: true };
}

async function handleClassificationResult(message, sender) {
  const { sidebar, memory } = await readWorkspace();
  const job = memory.jobs[message.jobId];
  if (!job || job.kind !== "classify" || job.status !== "running" || job.phase !== "summarize") {
    throw new Error("自动归类作业已结束或不存在");
  }
  if (job.summaryTabId && sender.tab?.id !== job.summaryTabId) throw new Error("自动归类结果来自错误的标签页");
  if (message.error) throw new Error(String(message.error).slice(0, 500));
  const validated = DTWMemory.validateProjectClassificationResult(message.raw, {
    jobId: job.id,
    conversationId: job.conversationId,
    projectIds: job.candidateTaskIds,
  });
  const existingOwner = taskOwningConversation(sidebar, job.conversationId);
  let target = null;
  if (memory.settings.autoClassify && !existingOwner && validated.projectId && validated.confidence >= 0.6) {
    target = findTask(sidebar, validated.projectId);
    if (target && job.candidateTaskIds.includes(target.id)) {
      target.conversationIds = [...new Set([job.conversationId, ...(target.conversationIds || [])])];
      target.sourceEpoch = Math.max(1, Number(target.sourceEpoch) || 1) + 1;
      await writeSidebar(sidebar);
    }
  }
  // 分类请求进行期间，用户可能已手动移动会话。这一轮在
  // handleTurnCompleted 中只写了指纹、尚未计入项目，因此应计到最终
  // 实际拥有者；无归属/低置信度则不计入任何项目。
  const countedOwner = target || existingOwner;
  if (countedOwner) {
    const taskMemory = DTWMemory.normalizeTaskMemory(memory.taskMemories[countedOwner.id]);
    taskMemory.pendingTurns += 1;
    memory.taskMemories[countedOwner.id] = taskMemory;
  }
  job.status = "done";
  job.phase = "done";
  job.updatedAt = now();
  job.error = "";
  job.resultTaskId = target?.id || existingOwner?.id || "";
  job.resultTaskName = target?.name || existingOwner?.name || "";
  job.confidence = validated.confidence;
  job.reason = validated.reason;
  job.maintenanceConversationId = String(message.conversationId || "").replace(/[^a-zA-Z0-9_-]/g, "");
  job.captured = [];
  memory.jobs[job.id] = job;
  if (job.maintenanceConversationId) {
    memory.maintenanceConversationIds = [...new Set([
      ...memory.maintenanceConversationIds,
      job.maintenanceConversationId,
    ])].slice(-500);
  }
  pruneJobs(memory);
  await writeMemory(memory);
  await safeCloseTab(job.summaryTabId);
  return { ok: true, projectId: job.resultTaskId, confidence: job.confidence };
}

async function retryJob(jobId) {
  const { sidebar, memory } = await readWorkspace();
  const old = memory.jobs[jobId];
  if (!old) throw new Error("找不到要重试的整理作业");
  old.status = "cancelled";
  old.updatedAt = now();
  memory.jobs[jobId] = old;
  await writeMemory(memory);
  if (old.kind === "classify") {
    const result = await startClassificationJob(old.conversationId);
    if (!result.reused && !result.queuedBehind && result.jobId) await processJob(result.jobId);
    return result;
  }
  const task = findTask(sidebar, old.taskId);
  if (!task) throw new Error("任务已经被删除");
  const result = await startJob(old.taskId);
  if (!result.reused) await processJob(result.jobId);
  return result;
}

async function resumeJobs() {
  const { memory } = await readWorkspace();
  const jobs = Object.values(memory.jobs).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const running = jobs.find((job) => job.status === "running");
  if (running?.phase === "summarize") {
    if (Date.now() - Date.parse(running.updatedAt || running.createdAt || 0) > 4 * 60 * 1000) {
      await failJob(running.id, new Error("DeepSeek 整理会话超过 4 分钟未返回，请重试"));
      return;
    }
    try {
      await chrome.tabs.get(running.summaryTabId);
    } catch {
      await failJob(running.id, new Error("DeepSeek 整理标签页已关闭，请重试"));
    }
    return;
  }
  const next = running || jobs.find((job) => job.status === "queued");
  if (next) await processJob(next.id).catch((error) => failJob(next.id, error));
}

// A completed reply arrived in a conversation: dedup by fingerprint, optionally
// ask DeepSeek to classify an unassigned conversation, count assigned turns, and
// at every settings.turnsPerOrganize turns reuse the manual organize pipeline.
async function handleTurnCompleted(conversationId, fingerprint) {
  const convId = String(conversationId || "").replace(/[^a-zA-Z0-9_-]/g, "");
  if (!convId) return { ok: false, error: "缺少会话 ID" };
  const { sidebar, memory } = await readWorkspace();
  if (memory.maintenanceConversationIds.includes(convId)) return { ok: true, counted: false };
  if (!DTWMemory.shouldCountTurn(memory.turnFingerprints, convId, fingerprint)) {
    return { ok: true, counted: false };
  }

  let task = taskOwningConversation(sidebar, convId);
  if (!task && !sidebar.conversations?.[convId]) {
    // 新会话的侧栏行可能晚于回复完成才出现（标题异步生成）：立刻判「未知会话」
    // 会让这一轮永久漏计。先不写指纹、挂一次性重试，行落位后再正常计数。
    const retrying = memory.pendingTurnRetries?.[convId];
    if (!retrying) {
      memory.pendingTurnRetries = { ...(memory.pendingTurnRetries || {}), [convId]: String(fingerprint || "") };
      await writeMemory(memory);
      chrome.alarms.create(`dtw-turn-retry:${convId}`, { when: Date.now() + 10000 });
    }
    return { ok: true, counted: false, deferred: true };
  }
  if (memory.pendingTurnRetries?.[convId]) {
    delete memory.pendingTurnRetries[convId];
  }

  memory.turnFingerprints[convId] = String(fingerprint || "").slice(0, 120);
  memory.turnFingerprints = Object.fromEntries(Object.entries(memory.turnFingerprints).slice(-50));
  if (task) {
    const taskMemory = DTWMemory.normalizeTaskMemory(memory.taskMemories[task.id]);
    taskMemory.pendingTurns += 1;
    memory.taskMemories[task.id] = taskMemory;
  }
  await writeMemory(memory);
  if (!task) {
    if (memory.settings.autoClassify && (sidebar.tasks || []).length) {
      try {
        const result = await startClassificationJob(convId);
        if (result.jobId && !result.reused && !result.queuedBehind) await processJob(result.jobId);
        return { ok: true, counted: true, classifying: Boolean(result.jobId) };
      } catch (error) {
        return { ok: false, counted: true, error: String(error?.message || error || "自动归类失败") };
      }
    }
    return { ok: true, counted: true, bound: false };
  }

  const turnThreshold = memory.settings.turnsPerOrganize;
  if (memory.settings.autoAnalyze
    && memory.taskMemories[task.id].pendingTurns >= turnThreshold
    && !Object.values(memory.jobs).some((job) =>
      job.taskId === task.id && ["queued", "running"].includes(job.status))) {
    const taskMemory = memory.taskMemories[task.id];
    taskMemory.pendingTurns = 0;
    await writeMemory(memory);
    try {
      const result = await startJob(task.id);
      if (!result.reused && !result.queuedBehind) await processJob(result.jobId);
      return { ok: true, counted: true, started: true };
    } catch (error) {
      const failed = Object.values((await readWorkspace()).memory.jobs)
        .find((job) => job.taskId === task.id && job.status === "running");
      if (failed) await failJob(failed.id, error);
      // The count was zeroed before startJob; a failed attempt must give it
      // back so the next completed turn re-triggers the organize (README
      // promises "失败时保留计数").
      const retry = await readWorkspace();
      const retryMemory = retry.memory.taskMemories[task.id];
      if (retryMemory) {
        retryMemory.pendingTurns += turnThreshold;
        retry.memory.taskMemories[task.id] = retryMemory;
        await writeMemory(retry.memory);
      }
      return { ok: false, error: String(error?.message || error || "自动整理失败") };
    }
  }
  return { ok: true, counted: true };
}

async function clearTaskMemory(taskId) {
  const { sidebar, memory } = await readWorkspace();
  const task = findTask(sidebar, taskId);
  if (!task) throw new Error("任务不存在或已经被删除");
  memory.taskMemories[taskId] = DTWMemory.emptyTaskMemory(Math.max(1, Number(task.sourceEpoch) || 1));
  await writeMemory(memory);
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "dtw:start-memory-update") {
    (async () => {
      const result = await startJob(message.taskId);
      if (!result.reused && !result.queuedBehind) await processJob(result.jobId);
      sendResponse(result);
    })().catch(async (error) => {
      const { memory } = await readWorkspace();
      const job = Object.values(memory.jobs).find((entry) => entry.taskId === message.taskId && entry.status === "running");
      if (job) await failJob(job.id, error);
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  }
  if (message?.type === "dtw:memory-summary-result") {
    handleSummaryResult(message, sender)
      .then((result) => sendResponse(result))
      .catch(async (error) => {
        await failJob(message.jobId, error);
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }
  if (message?.type === "dtw:project-classify-result") {
    handleClassificationResult(message, sender)
      .then((result) => sendResponse(result))
      .catch(async (error) => {
        await failJob(message.jobId, error);
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }
  if (message?.type === "dtw:retry-memory-update") {
    retryJob(message.jobId)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "dtw:turn-completed") {
    handleTurnCompleted(message.conversationId, message.fingerprint)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "dtw:clear-task-memory") {
    clearTaskMemory(message.taskId)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "dtw:write-memory") {
    writeMemory(message.store)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "dtw:fs-status") {
    (async () => {
      const handle = await loadStoredHandle();
      // handle 本体不能过消息通道（JSON 序列化剥掉原型）；popup 从共享
      // IndexedDB 自取。这里只回报名字。
      return {
        ok: true,
        status: fsState.status,
        handleName: fsRuntime.root?.name || handle?.name || "",
        lastError: fsState.lastError,
        lastSyncAt: fsState.lastSyncAt,
      };
    })()
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "dtw:fs-authorize") {
    (async () => {
      // popup 已把 handle 存进共享 IndexedDB；这里只读取并调和。
      const handle = await loadStoredHandle();
      if (!handle) throw new Error("没有已保存的文件夹授权，请先在弹窗里选择");
      fsRuntime.root = handle;
      await setFsStatus("ok", "");
      const root = fsRuntime.root;
      await runFs(() => writeTextPath(root, DTWFS.META_FILE, `${JSON.stringify(DTWFS.META, null, 2)}\n`)).catch(() => {});
      return reconcile("merge");
    })()
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "dtw:fs-reload") {
    reconcile("reload")
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  return false;
});

// 启动时先恢复 fsState（facts 信封时间戳必须跨 SW 重启连续，否则重启后副本
// 侧时间戳归零回升，手改的 facts.json 会在合并中输给副本），再调和文件夹。
// MV3 的 SW 被 30 秒闲置杀掉后复活不会触发 onStartup，所以所有入口都先走
// ensureFsState 惰性恢复。
let fsStateLoaded = false;
async function ensureFsState() {
  if (fsStateLoaded) return;
  fsStateLoaded = true;
  const stored = (await chrome.storage.local.get(FS_KEY))[FS_KEY];
  if (stored && typeof stored === "object") fsState = { ...fsState, ...stored };
}

async function initFs() {
  await ensureFsState();
  await reconcile("merge").catch(() => {});
}

chrome.runtime.onInstalled.addListener(async () => {
  chrome.alarms.create("dtw-memory-resume", { periodInMinutes: 1 });
  await resumeJobs();
  await initFs();
});
chrome.runtime.onStartup.addListener(async () => {
  await resumeJobs();
  await initFs();
});
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "dtw-memory-resume") await resumeJobs();
  if (alarm.name.startsWith("dtw-turn-retry:")) {
    const convId = alarm.name.slice("dtw-turn-retry:".length);
    const memory = DTWMemory.normalizeStore((await chrome.storage.local.get(MEMORY_KEY))[MEMORY_KEY]);
    const fingerprint = memory.pendingTurnRetries?.[convId] || "";
    if (fingerprint) await handleTurnCompleted(convId, fingerprint);
  }
  // degraded 时每分钟轻试一次：重启后 Chrome 静默恢复授权的场景可自动回弹。
  if (fsState.status === "degraded") await reconcile("merge").catch(() => {});
});
