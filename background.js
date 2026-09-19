/* global DTWMemory */
"use strict";

importScripts("memory-core.js");

const SIDEBAR_KEY = "dtw.sidebar.v1";
const MEMORY_KEY = "dtw.memory.v1";
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

async function writeMemory(memory) {
  await chrome.storage.local.set({ [MEMORY_KEY]: DTWMemory.normalizeStore(memory) });
}

function findTask(sidebar, taskId) {
  return (Array.isArray(sidebar?.tasks) ? sidebar.tasks : []).find((task) => task?.id === taskId) || null;
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

async function processJob(jobId) {
  if (PROCESSING.has(jobId)) return;
  PROCESSING.add(jobId);
  try {
    let { sidebar, memory } = await readWorkspace();
    let job = memory.jobs[jobId];
    if (!job || !["queued", "running"].includes(job.status)) return;
    const otherRunning = Object.values(memory.jobs).find((entry) => entry.id !== jobId && entry.status === "running");
    if (otherRunning) return;
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
      const tab = await chrome.tabs.create({ url: ref.href, active: false });
      try {
        await waitForTabComplete(tab.id);
        const result = await sendWithRetry(tab.id, { type: "dtw:capture-conversation", expectedId: ref.id });
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
        job.captured.push({
          conversationId: ref.id,
          title: ref.title,
          captureIncomplete: Boolean(result.captureIncomplete),
          messages: result.messages,
        });
        job.updatedAt = now();
        await saveJob(job);
      } finally {
        await safeCloseTab(tab.id);
      }
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
  const taskMemory = DTWMemory.normalizeTaskMemory(memory.taskMemories[job.taskId]);
  if (taskMemory.lastJobId === jobId) {
    taskMemory.status = "error";
    taskMemory.error = job.error;
    memory.taskMemories[job.taskId] = taskMemory;
  }
  await writeMemory(memory);
  await safeCloseTab(job.summaryTabId);
}

async function handleSummaryResult(message, sender) {
  const { sidebar, memory } = await readWorkspace();
  const job = memory.jobs[message.jobId];
  if (!job || job.status !== "running" || job.phase !== "summarize") throw new Error("整理作业已结束或不存在");
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

async function retryJob(jobId) {
  const { sidebar, memory } = await readWorkspace();
  const old = memory.jobs[jobId];
  if (!old) throw new Error("找不到要重试的整理作业");
  const task = findTask(sidebar, old.taskId);
  if (!task) throw new Error("任务已经被删除");
  old.status = "cancelled";
  old.updatedAt = now();
  memory.jobs[jobId] = old;
  await writeMemory(memory);
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
  if (message?.type === "dtw:retry-memory-update") {
    retryJob(message.jobId)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  return false;
});

chrome.runtime.onInstalled.addListener(async () => {
  chrome.alarms.create("dtw-memory-resume", { periodInMinutes: 1 });
  await resumeJobs();
});
chrome.runtime.onStartup.addListener(async () => {
  await resumeJobs();
});
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "dtw-memory-resume") await resumeJobs();
});
