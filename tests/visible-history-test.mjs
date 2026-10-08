import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tables = new Map();
for (const name of ["sessions", "messages", "projects", "memberships", "memories", "jobs", "settings", "metrics"]) tables.set(name, new Map());
const db = {
  get: async (name, key) => tables.get(name).get(JSON.stringify(key)) || null,
  all: async (name, accountId) => [...tables.get(name).values()].filter((row) => row.accountId === accountId),
  by: async (name, _index, [accountId, sessionId]) => [...tables.get(name).values()].filter((row) => row.accountId === accountId && row.sessionId === sessionId),
  put: async (name, row) => {
    const id = ({ sessions: row.sessionId, projects: row.projectId, memberships: row.sessionId,
      memories: row.memoryId, jobs: row.jobId, settings: row.key, metrics: row.metricId })[name];
    const key = name === "messages" ? [row.accountId, row.sessionId, row.messageId] : [row.accountId, id];
    tables.get(name).set(JSON.stringify(key), structuredClone(row));
  },
  remove: async (name, key) => { tables.get(name).delete(JSON.stringify(key)); },
};
let listener;
let alarmListener;
let automationTabs = 0;
let optionsOpened = 0;
const storageValues = { accountId: "account123" };
const chrome = {
  runtime: { id: "test-extension", getURL: (path = "") => `chrome-extension://test-extension/${path}`,
    onMessage: { addListener(fn) { listener = fn; } }, onInstalled: { addListener() {} },
    openOptionsPage: async () => { optionsOpened += 1; } },
  alarms: { onAlarm: { addListener(fn) { alarmListener = fn; } }, create() {} },
  tabs: { create: async () => ({ id: ++automationTabs }), sendMessage: async () => ({ ok: true }), remove: async () => {} },
  storage: { local: {
    get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys])
      .map((key) => [key, storageValues[key]])),
    set: async (values) => { Object.assign(storageValues, values); },
  } },
};
const source = await readFile(path.join(root, "core/background/workbench.js"), "utf8");
vm.runInNewContext(source, { DTWDB: db, chrome, importScripts() {}, crypto: globalThis.crypto, structuredClone,
  Date, Number, String, Boolean, Array, Object, Set, Map, Promise, JSON, Math, console, setTimeout }, { filename: "workbench.js" });
const accountId = "account123";
const request = (type, body) => new Promise((resolve) => listener({ type: `dtw:${type}`, accountId, ...body },
  { tab: { url: "https://chat.deepseek.com/a/chat" } }, resolve));
const projectDistillJobs = (snapshot) => snapshot.jobs.filter((job) => job.type === "DISTILL" && job.memoryScope !== "PERSONAL");
const extensionRequest = (type, body = {}) => new Promise((resolve) => listener({ type: `dtw:${type}`, accountId, ...body },
  { id: chrome.runtime.id, url: chrome.runtime.getURL("options/options.html"),
    tab: { url: chrome.runtime.getURL("options/options.html") } }, resolve));

assert.equal((await extensionRequest("snapshot")).ok, true);
const manageSnapshot = await new Promise((resolve) => listener({ type: "dtw:snapshot", accountId: "account123" },
  { url: chrome.runtime.getURL("manage/manage.html") }, resolve));
assert.equal(manageSnapshot.ok, true);
const rejected = await new Promise((resolve) => listener({ type: "dtw:snapshot", accountId: "account123" },
  { tab: { url: "https://example.com/" } }, resolve));
assert.equal(rejected.ok, false);

const oldId = "historical-session";
assert.equal((await request("session-observe", { sessionId: oldId, title: "旧对话", loadedHistory: true })).created, true);
let snap = await request("snapshot", {});
assert.equal(snap.sessions.length, 1);
assert.equal(snap.sessions[0].title, "旧对话");
assert.equal(snap.memberships[0].projectId, null);
assert.equal(snap.memberships[0].memoryModeEnabled, false);
assert.equal(snap.projects.find((project) => project.systemKind === "AUTOMATION")?.name, "自动化会话");
await request("session-observe", { sessionId: oldId, title: "旧对话改名" });
assert.equal(automationTabs, 0);

const historicalHistory = { records: [
  { messageId: 1, parentId: null, role: "USER", fragments: [{ type: "REQUEST", content: "旧问题" }] },
  { messageId: 2, parentId: 1, role: "ASSISTANT", status: "FINISHED", fragments: [{ type: "RESPONSE", content: "旧回答" }] },
], currentMessageId: 2, title: "旧对话改名" };
await request("turn-completed", { sessionId: oldId, newSession: false, title: "旧对话改名", history: historicalHistory });
assert.equal(automationTabs, 0);

const newId = "fresh-session";
await db.put("settings", { accountId, key: "memoryModeDefault", value: true });
await request("session-observe", { sessionId: newId, title: "新对话", loadedHistory: true });
assert.equal((await request("snapshot", {})).memberships.find((m) => m.sessionId === newId).memoryModeEnabled, false);
await request("turn-completed", { sessionId: newId, newSession: true, title: "新对话", history: historicalHistory });
await new Promise((resolve) => setTimeout(resolve, 0));
snap = await request("snapshot", {});
assert.equal(snap.sessions.length, 2);
assert.equal(snap.sessions.find((s) => s.sessionId === newId).classificationPending, true);
assert.equal(snap.memberships.find((m) => m.sessionId === newId).memoryModeEnabled, true);
assert.equal(automationTabs, 1);
assert.equal(snap.jobs.filter((job) => job.type === "CLASSIFY").length, 1);
const classifyJob = snap.jobs.find((job) => job.type === "CLASSIFY");
await request("session-observe", { sessionId: "automation-1", title: "归类过程", loadedHistory: true });
const progress = await new Promise((resolve) => listener({ type: "dtw:automation-progress", accountId,
  jobId: classifyJob.jobId, phase: "WAITING_REPLY", automationSessionId: "automation-1" },
{ tab: { url: "https://chat.deepseek.com/", id: classifyJob.tabId } }, resolve));
assert.equal(progress.ok, true);
snap = await request("snapshot", {});
assert.equal(snap.sessions.find((session) => session.sessionId === "automation-1").purpose, "CLASSIFY");
assert.equal(snap.memberships.some((row) => row.sessionId === "automation-1"), false);
assert.equal((await request("memory-toggle", { sessionId: "automation-1", enabled: true })).ok, false);
assert.equal((await request("membership-move", { sessionId: newId, projectId: "dtw-automation" })).ok, false);
assert.equal((await request("memory-save", { memory: { scope: "PROJECT", projectId: "dtw-automation", content: "不应保存" } })).ok, false);
await request("session-observe", { sessionId: "orphan-automation", loadedHistory: true, title: "旧自动化会话" });
assert.equal((await request("automation-mark", { sessionId: "orphan-automation" })).ok, true);
snap = await request("snapshot", {});
assert.equal(snap.sessions.find((session) => session.sessionId === "orphan-automation").purpose, "AUTOMATION");
assert.equal(snap.memberships.some((row) => row.sessionId === "orphan-automation"), false);
assert.equal((await request("automation-unmark", { sessionId: "orphan-automation" })).ok, true);
snap = await request("snapshot", {});
assert.equal(snap.sessions.find((session) => session.sessionId === "orphan-automation").purpose, "USER");
assert.equal(snap.memberships.find((row) => row.sessionId === "orphan-automation").projectId, null);

const recent = Date.now() - 10000;
assert.equal((await request("session-times-observe", { sessions: [
  { sessionId: oldId, updatedAtMs: recent, currentMessageId: 2 },
  { sessionId: newId, updatedAtMs: recent - 5000, currentMessageId: 2 },
  { sessionId: "not-imported", updatedAtMs: recent + 1000 },
] })).changed, 2);
snap = await request("snapshot", {});
assert.equal(snap.sessions.find((s) => s.sessionId === oldId).updatedAtMs, recent);
assert.equal(snap.sessions.some((s) => s.sessionId === "not-imported"), false);
assert.equal((await request("session-times-observe", { sessions: [
  { sessionId: oldId, updatedAtMs: recent - 1000 },
] })).changed, 0);
assert.equal((await request("snapshot", {})).sessions.find((s) => s.sessionId === oldId).updatedAtMs, recent);
assert.equal((await request("session-times-observe", { sessions: [
  { sessionId: oldId, updatedAtMs: recent + 1000, currentMessageId: 2 },
] })).changed, 1);
snap = await request("snapshot", {});
assert.equal(snap.sessions.find((s) => s.sessionId === oldId).lastMessageAtMs, recent);
assert.equal((await request("session-times-observe", { sessions: [
  { sessionId: oldId, updatedAtMs: recent + 2000, currentMessageId: 3 },
] })).changed, 1);
assert.equal((await request("snapshot", {})).sessions.find((s) => s.sessionId === oldId).lastMessageAtMs, recent + 2000);
assert.equal((await request("open-options", {})).ok, true);
assert.equal(optionsOpened, 1);

const project = (await request("project-create", { name: "测试项目" })).project;
assert.equal((await extensionRequest("snapshot")).projects.some((row) => row.projectId === project.projectId), true);
await request("membership-move", { sessionId: oldId, projectId: project.projectId });
await request("memory-toggle", { sessionId: oldId, enabled: true });
const memoryHistory = { records: [
  { messageId: 1, parentId: null, role: "USER", status: "FINISHED", fragments: [{ type: "REQUEST", content: "项目需求" }] },
  { messageId: 2, parentId: 1, role: "ASSISTANT", status: "WIP", fragments: [{ type: "RESPONSE", content: "尚未完成" }] },
], currentMessageId: 2 };
await request("history-observe", { sessionId: oldId, ...memoryHistory });
assert.equal((await request("memory-distill-current", { sessionId: oldId })).started, false);
memoryHistory.records[1].status = "FINISHED";
await request("history-observe", { sessionId: oldId, ...memoryHistory });
assert.equal((await request("memory-distill-current", { sessionId: oldId })).started, true);
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal((await request("memory-distill-current", { sessionId: oldId })).started, false);
const distillJobs = (await request("snapshot", {})).jobs.filter((job) => job.type === "DISTILL");
assert.equal(distillJobs.length, 1);
const completedDistill = await new Promise((resolve) => listener({ type: "dtw:automation-result", accountId,
  jobId: distillJobs[0].jobId, raw: JSON.stringify({ memories: [{ kind: "目标", content: "完成测试项目" }] }) },
{ tab: { url: "https://chat.deepseek.com/", id: distillJobs[0].tabId } }, resolve));
assert.equal(completedDistill.status, "DONE");
assert.equal((await request("snapshot", {})).memories.some((memory) => memory.content === "完成测试项目"), true);

const firstClassify = (await request("snapshot", {})).jobs.find((job) => job.type === "CLASSIFY");
firstClassify.updatedAtMs = Date.now() - 11 * 60000;
await db.put("jobs", firstClassify);
await alarmListener({ name: "dtw-job-check" });
assert.equal((await request("snapshot", {})).jobs.find((job) => job.jobId === firstClassify.jobId).status, "NEEDS_REVIEW");
assert.equal((await request("classification-retry", { jobId: firstClassify.jobId })).ok, true);
await new Promise((resolve) => setTimeout(resolve, 0));
const classifyJobs = (await request("snapshot", {})).jobs.filter((job) => job.type === "CLASSIFY");
assert.equal(classifyJobs.length, 2);
assert.equal(classifyJobs.find((job) => job.jobId === firstClassify.jobId).status, "DONE");
const secondClassify = classifyJobs.find((job) => job.jobId !== firstClassify.jobId);
secondClassify.status = "FAILED";
await db.put("jobs", secondClassify);
assert.equal((await request("classification-dismiss", { jobId: secondClassify.jobId })).ok, true);
assert.equal((await request("snapshot", {})).jobs.find((job) => job.jobId === secondClassify.jobId).status, "DONE");

const prepared = await request("prepare-send", { sessionId: "", newChatProjectId: project.projectId, rawInput: "新会话问题" });
assert.equal(prepared.rollover, false);
assert.match(prepared.prompt, /新会话问题/);
const sent = await request("send-status", { jobId: prepared.jobId, confirmed: true, sessionId: "new-memory-session" });
assert.equal(sent.ok, true, sent.error);
snap = await request("snapshot", {});
assert.equal(snap.memberships.find((row) => row.sessionId === "new-memory-session").projectId, project.projectId);
assert.equal(snap.memberships.find((row) => row.sessionId === "new-memory-session").memoryModeEnabled, true);
const uncertain = await request("prepare-send", { sessionId: "", newChatProjectId: project.projectId, rawInput: "请保留的草稿" });
await request("send-status", { jobId: uncertain.jobId, error: "发送结果无法确认" });
assert.equal((await request("snapshot", {})).jobs.find((job) => job.jobId === uncertain.jobId).rawInput, "请保留的草稿");

const legacyAccount = "legacy123";
await db.put("sessions", { accountId: legacyAccount, sessionId: "legacy-automation", purpose: "USER", title: "旧整理会话" });
await db.put("memberships", { accountId: legacyAccount, sessionId: "legacy-automation", projectId: null, memoryModeEnabled: false });
await db.put("jobs", { accountId: legacyAccount, jobId: "legacy-job", type: "DISTILL", status: "DONE",
  automationSessionId: "legacy-automation", sourceSessionId: "another-session", updatedAtMs: Date.now() });
const migrated = await new Promise((resolve) => listener({ type: "dtw:snapshot", accountId: legacyAccount },
  { tab: { url: "https://chat.deepseek.com/" } }, resolve));
assert.equal(migrated.sessions.find((session) => session.sessionId === "legacy-automation").purpose, "MEMORY");
assert.equal(migrated.memberships.some((row) => row.sessionId === "legacy-automation"), false);
assert.equal(migrated.projects.some((row) => row.systemKind === "AUTOMATION"), true);

const batchProject = (await request("project-create", { name: "多轮记忆" })).project;
assert.equal((await request("settings-update", { key: "distillEveryTurns", value: 2 })).value, 2);
const priorPersonalJob = (await request("snapshot", {})).jobs.find((job) => job.memoryScope === "PERSONAL");
assert.deepEqual(priorPersonalJob.turnRefs.map((ref) => ref.sessionId), [oldId, newId]);
assert.equal((await new Promise((resolve) => listener({ type: "dtw:automation-result", accountId,
  jobId: priorPersonalJob.jobId, raw: JSON.stringify({ memories: [] }) },
{ tab: { url: "https://chat.deepseek.com/", id: priorPersonalJob.tabId } }, resolve))).status, "DONE");
const jobsBeforeBatch = projectDistillJobs(await request("snapshot", {})).length;
for (const [index, sessionId] of ["batch-one", "batch-two"].entries()) {
  await request("session-observe", { sessionId, loadedHistory: true, title: sessionId });
  await request("membership-move", { sessionId, projectId: batchProject.projectId });
  await request("memory-toggle", { sessionId, enabled: true });
  const rawInput = `原始提问 ${index + 1}`;
  const preparedSend = await request("prepare-send", { sessionId, rawInput });
  assert.equal(preparedSend.rollover, false);
  await request("send-status", { jobId: preparedSend.jobId, confirmed: true, sessionId, userMessageId: 1 });
  await request("history-observe", { sessionId, currentMessageId: 2, records: [
    { messageId: 1, parentId: null, role: "USER", status: "FINISHED",
      fragments: [{ type: "REQUEST", content: `<project_memory>错误旧要求</project_memory>\n\n${rawInput}` }] },
    { messageId: 2, parentId: 1, role: "ASSISTANT", status: "FINISHED",
      fragments: [{ type: "RESPONSE", content: index === 0
        ? '# **已确认回答 1**\n<style>.card { color: red }</style>\n<div style="font-size: 20px">路线 &amp; 预算 [清单](https://example.com)</div>\n```css\n.extra { display: block }\n```'
        : `已确认回答 ${index + 1}` }] },
  ] });
  snap = await request("snapshot", {});
  assert.equal(snap.projects.find((row) => row.projectId === batchProject.projectId).pendingTurnRefs.length, index + 1);
  assert.equal(projectDistillJobs(snap).length, jobsBeforeBatch + index);
}
await new Promise((resolve) => setTimeout(resolve, 0));
snap = await request("snapshot", {});
const personalBatchJob = snap.jobs.filter((job) => job.memoryScope === "PERSONAL").at(-1);
assert.equal(personalBatchJob.turnRefs.length, 2);
assert.match(personalBatchJob.payload, /原始提问 1/);
assert.match(personalBatchJob.payload, /已确认回答 1 路线 & 预算 清单/);
assert.doesNotMatch(personalBatchJob.payload, /<style|style=|color: red|\\n|\*\*/);
const batchJob = projectDistillJobs(snap).at(-1);
assert.equal(batchJob.turnRefs.length, 2);
assert.match(batchJob.payload, /原始提问 1/);
assert.match(batchJob.payload, /原始提问 2/);
assert.match(batchJob.payload, /已确认回答 1 路线 & 预算 清单/);
assert.match(batchJob.payload, /会话 ID：batch-one；助手消息 ID：2/);
assert.doesNotMatch(batchJob.payload, /<style|style=|color: red|display: block|\\n|\*\*|```/);
assert.doesNotMatch(batchJob.payload, /错误旧要求/);
const batchDone = await new Promise((resolve) => listener({ type: "dtw:automation-result", accountId,
  jobId: batchJob.jobId, raw: JSON.stringify({ memories: [{ kind: "决定", content: "批量记忆已确认",
    sourceSessionId: "batch-one", sourceMessageId: 2 }] }) },
{ tab: { url: "https://chat.deepseek.com/", id: batchJob.tabId } }, resolve));
assert.equal(batchDone.status, "DONE");
snap = await request("snapshot", {});
assert.equal(snap.projects.find((row) => row.projectId === batchProject.projectId).pendingTurnRefs.length, 0);
assert.equal(snap.memories.find((row) => row.content === "批量记忆已确认").sourceSessionId, "batch-one");
assert.equal((await request("settings-update", { key: "distillEveryTurns", value: 1 })).value, 1);
await request("session-observe", { sessionId: "retry-memory", loadedHistory: true });
await request("membership-move", { sessionId: "retry-memory", projectId: batchProject.projectId });
await request("memory-toggle", { sessionId: "retry-memory", enabled: true });
await request("history-observe", { sessionId: "retry-memory", currentMessageId: 2, records: [
  { messageId: 1, parentId: null, role: "USER", fragments: [{ type: "REQUEST", content: "重试问题" }] },
  { messageId: 2, parentId: 1, role: "ASSISTANT", status: "FINISHED", fragments: [{ type: "RESPONSE", content: "重试回答" }] },
] });
await new Promise((resolve) => setTimeout(resolve, 0));
const failedJob = projectDistillJobs(await request("snapshot", {})).at(-1);
const failedResult = await new Promise((resolve) => listener({ type: "dtw:automation-result", accountId,
  jobId: failedJob.jobId, error: "模型暂时不可用" },
{ tab: { url: "https://chat.deepseek.com/", id: failedJob.tabId } }, resolve));
assert.equal(failedResult.status, "FAILED");
assert.equal((await request("snapshot", {})).projects.find((row) => row.projectId === batchProject.projectId).pendingTurnRefs.length, 1);
assert.equal((await extensionRequest("memory-distill-project", { projectId: batchProject.projectId })).started, true);

const startupAccount = "startup123";
const startupRequest = (type, body = {}) => new Promise((resolve) => listener({ type: `dtw:${type}`,
  accountId: startupAccount, ...body }, { tab: { id: 999, url: "https://chat.deepseek.com/" } }, resolve));
assert.equal((await startupRequest("startup-memory-unknown")).ok, false);
const startupProject = (await startupRequest("project-create", { name: "启动补扫项目" })).project;
await startupRequest("settings-update", { key: "distillEveryTurns", value: 2 });
await startupRequest("session-observe", { sessionId: "existing-memory-session", loadedHistory: true });
await startupRequest("membership-move", { sessionId: "existing-memory-session", projectId: startupProject.projectId });
await startupRequest("memory-toggle", { sessionId: "existing-memory-session", enabled: true });
await db.put("jobs", { accountId: startupAccount, jobId: "old-distill", type: "DISTILL", status: "DONE",
  projectId: startupProject.projectId, sourceSessionId: "existing-memory-session", sourceMessageId: 2,
  updatedAtMs: Date.now() });
await db.put("jobs", { accountId: startupAccount, jobId: "helper-tab", type: "CLASSIFY", status: "RUNNING",
  tabId: 998, updatedAtMs: Date.now() });
const helperClaim = await new Promise((resolve) => listener({ type: "dtw:startup-memory-claim", accountId: startupAccount },
  { tab: { id: 998, url: "https://chat.deepseek.com/" } }, resolve));
assert.equal(helperClaim.claimed, false);
const oldRecords = [];
for (let turn = 1; turn <= 3; turn++) {
  const userId = turn * 2 - 1;
  oldRecords.push({ messageId: userId, parentId: userId === 1 ? null : userId - 1,
    role: "USER", status: "FINISHED", fragments: [{ type: "REQUEST", content: `旧问题 ${turn}` }] });
  oldRecords.push({ messageId: userId + 1, parentId: userId, role: "ASSISTANT", status: "FINISHED",
    fragments: [{ type: "RESPONSE", content: `旧回答 ${turn}` }] });
}
await startupRequest("history-observe", { sessionId: "existing-memory-session", currentMessageId: 6,
  records: oldRecords, deferTurnCount: true });
assert.equal((await startupRequest("snapshot")).projects.find((row) => row.projectId === startupProject.projectId).pendingTurnRefs.length, 0);
assert.equal((await startupRequest("startup-memory-claim")).claimed, true);
assert.equal((await startupRequest("startup-memory-claim")).claimed, true);
const otherTabClaim = await new Promise((resolve) => listener({ type: "dtw:startup-memory-claim", accountId: startupAccount },
  { tab: { id: 1000, url: "https://chat.deepseek.com/" } }, resolve));
assert.equal(otherTabClaim.claimed, false);
assert.equal((await startupRequest("startup-memory-reconcile", { verifiedSessionIds: [] })).queuedTurns, 0);
assert.equal((await startupRequest("startup-memory-claim")).claimed, true);
const firstScan = await startupRequest("startup-memory-reconcile", { verifiedSessionIds: ["existing-memory-session"] });
assert.equal(firstScan.queuedTurns, 2);
assert.equal(firstScan.startedProjects, 1);
assert.equal(firstScan.queuedPersonalTurns, 3);
assert.equal(firstScan.startedPersonal, true);
await new Promise((resolve) => setTimeout(resolve, 0));
let startupSnapshot = await startupRequest("snapshot");
let startupJobs = projectDistillJobs(startupSnapshot);
const startupJob = startupJobs.find((job) => job.jobId !== "old-distill");
assert.deepEqual(startupJob.turnRefs.map((ref) => ref.assistantMessageId), [4, 6]);
const personalStartupJob = startupSnapshot.jobs.find((job) => job.memoryScope === "PERSONAL");
assert.deepEqual(personalStartupJob.turnRefs.map((ref) => ref.assistantMessageId), [2, 4, 6]);
assert.equal((await startupRequest("startup-memory-claim")).claimed, true);
const secondScan = await startupRequest("startup-memory-reconcile", { verifiedSessionIds: ["existing-memory-session"] });
assert.equal(secondScan.queuedTurns, 0);
startupJobs = projectDistillJobs(await startupRequest("snapshot"));
assert.equal(startupJobs.length, 2);
const startupDone = await new Promise((resolve) => listener({ type: "dtw:automation-result", accountId: startupAccount,
  jobId: startupJob.jobId, raw: JSON.stringify({ memories: [] }) },
{ tab: { id: startupJob.tabId, url: "https://chat.deepseek.com/" } }, resolve));
assert.equal(startupDone.status, "DONE");
const personalStartupDone = await new Promise((resolve) => listener({ type: "dtw:automation-result", accountId: startupAccount,
  jobId: personalStartupJob.jobId, raw: JSON.stringify({ memories: [{ kind: "偏好", content: "偏好中文说明",
    sourceSessionId: "existing-memory-session", sourceMessageId: 4 }, { kind: "偏好", content: "偏好中文说明",
    sourceSessionId: "existing-memory-session", sourceMessageId: 4 }] }) },
{ tab: { id: personalStartupJob.tabId, url: "https://chat.deepseek.com/" } }, resolve));
assert.equal(personalStartupDone.status, "DONE");
startupSnapshot = await startupRequest("snapshot");
assert.equal(startupSnapshot.memories.some((memory) => memory.scope === "PERSONAL"
  && memory.content === "偏好中文说明"), true);
assert.equal(startupSnapshot.jobs.find((job) => job.jobId === personalStartupJob.jobId).result.count, 1);
assert.equal(startupSnapshot.projects.find((row) => row.systemKind === "PERSONAL").pendingTurnRefs.length, 0);
assert.equal((await startupRequest("startup-memory-claim")).claimed, true);
const finalScan = await startupRequest("startup-memory-reconcile", { verifiedSessionIds: ["existing-memory-session"] });
assert.equal(finalScan.queuedTurns, 0);
assert.equal(finalScan.queuedPersonalTurns, 0);
assert.equal((await startupRequest("snapshot")).projects.find((row) => row.projectId === startupProject.projectId).pendingTurnRefs.length, 0);
await startupRequest("history-observe", { sessionId: "existing-memory-session", currentMessageId: 8, records: [
  { messageId: 7, parentId: 6, role: "USER", status: "FINISHED", fragments: [{ type: "REQUEST", content: "后续问题" }] },
  { messageId: 8, parentId: 7, role: "ASSISTANT", status: "FINISHED", fragments: [{ type: "RESPONSE", content: "后续回答" }] },
] });
let pendingBeforeOff = await startupRequest("snapshot");
assert.equal(pendingBeforeOff.projects.find((row) => row.projectId === startupProject.projectId).pendingTurnRefs.length, 1);
assert.equal(pendingBeforeOff.projects.find((row) => row.systemKind === "PERSONAL").pendingTurnRefs.length, 1);
await startupRequest("memory-toggle", { sessionId: "existing-memory-session", enabled: false });
pendingBeforeOff = await startupRequest("snapshot");
assert.equal(pendingBeforeOff.projects.find((row) => row.projectId === startupProject.projectId).pendingTurnRefs.length, 1);
assert.equal(pendingBeforeOff.projects.find((row) => row.systemKind === "PERSONAL").pendingTurnRefs.length, 1);

const projectAutoAccount = "projectauto123";
const projectAutoRequest = (type, body = {}) => new Promise((resolve) => listener({ type: `dtw:${type}`,
  accountId: projectAutoAccount, ...body }, { tab: { id: 777, url: "https://chat.deepseek.com/" } }, resolve));
const travelProject = (await projectAutoRequest("project-create", { name: "北京旅行计划" })).project;
await projectAutoRequest("settings-update", { key: "distillEveryTurns", value: 2 });
await projectAutoRequest("session-observe", { sessionId: "travel-old", loadedHistory: true });
await projectAutoRequest("membership-move", { sessionId: "travel-old", projectId: travelProject.projectId });
assert.equal((await projectAutoRequest("snapshot")).memberships.find((row) => row.sessionId === "travel-old").memoryModeEnabled, false);
const travelRecords = [
  { messageId: 1, parentId: null, role: "USER", fragments: [{ type: "REQUEST", content: "去北京的日期" }] },
  { messageId: 2, parentId: 1, role: "ASSISTANT", status: "FINISHED", fragments: [{ type: "RESPONSE", content: "十月出行" }] },
  { messageId: 3, parentId: 2, role: "USER", fragments: [{ type: "REQUEST", content: "安排拍摄地点" }] },
  { messageId: 4, parentId: 3, role: "ASSISTANT", status: "FINISHED", fragments: [{ type: "RESPONSE", content: "故宫和胡同" }] },
];
await projectAutoRequest("history-observe", { sessionId: "travel-old", currentMessageId: 4,
  records: travelRecords, deferTurnCount: true });
const travelMembership = (await projectAutoRequest("snapshot")).memberships.find((row) => row.sessionId === "travel-old");
travelMembership.countedTipIds = [4]; // Older versions marked the latest turn counted without queuing it.
await db.put("memberships", travelMembership);
await projectAutoRequest("startup-memory-claim");
const travelScan = await projectAutoRequest("startup-memory-reconcile", { verifiedSessionIds: ["travel-old"] });
assert.equal(travelScan.queuedTurns, 2);
assert.equal(travelScan.queuedPersonalTurns, 2);
assert.equal(travelScan.startedProjects, 1);
assert.equal(travelScan.startedPersonal, true);
const travelJob = projectDistillJobs(await projectAutoRequest("snapshot")).at(-1);
assert.deepEqual(travelJob.turnRefs.map((ref) => ref.assistantMessageId), [2, 4]);
assert.equal((await new Promise((resolve) => listener({ type: "dtw:automation-result", accountId: projectAutoAccount,
  jobId: travelJob.jobId, raw: JSON.stringify({ memories: [] }) },
{ tab: { id: travelJob.tabId, url: "https://chat.deepseek.com/" } }, resolve))).status, "DONE");
await projectAutoRequest("history-observe", { sessionId: "travel-old", currentMessageId: 6, records: [
  { messageId: 5, parentId: 4, role: "USER", fragments: [{ type: "REQUEST", content: "再加一天" }] },
  { messageId: 6, parentId: 5, role: "ASSISTANT", status: "FINISHED", fragments: [{ type: "RESPONSE", content: "加一天自由活动" }] },
] });
assert.equal((await projectAutoRequest("snapshot")).projects.find((row) => row.projectId === travelProject.projectId).pendingTurnRefs.length, 1);
const manualTravel = await new Promise((resolve) => listener({ type: "dtw:memory-distill-project",
  accountId: projectAutoAccount, projectId: travelProject.projectId },
{ url: chrome.runtime.getURL("manage/manage.html") }, resolve));
assert.equal(manualTravel.started, true);
const manualProject = (await projectAutoRequest("project-create", { name: "手动整理项目" })).project;
await projectAutoRequest("session-observe", { sessionId: "manual-old", loadedHistory: true });
await projectAutoRequest("membership-move", { sessionId: "manual-old", projectId: manualProject.projectId });
await projectAutoRequest("history-observe", { sessionId: "manual-old", currentMessageId: 2, deferTurnCount: true,
  records: travelRecords.slice(0, 2) });
assert.equal((await projectAutoRequest("snapshot")).projects.find((row) => row.projectId === manualProject.projectId).pendingTurnRefs.length, 0);
const manualNoQueue = await new Promise((resolve) => listener({ type: "dtw:memory-distill-project",
  accountId: projectAutoAccount, projectId: manualProject.projectId },
{ url: chrome.runtime.getURL("manage/manage.html") }, resolve));
assert.equal(manualNoQueue.started, true);

const classifyAccount = "classifyauto123";
const classifyRequest = (type, body = {}) => new Promise((resolve) => listener({ type: `dtw:${type}`,
  accountId: classifyAccount, ...body }, { tab: { id: 888, url: "https://chat.deepseek.com/" } }, resolve));
const classifiedProject = (await classifyRequest("project-create", { name: "自动归类目标" })).project;
await classifyRequest("settings-update", { key: "memoryModeDefault", value: true });
await classifyRequest("settings-update", { key: "distillEveryTurns", value: 1 });
await classifyRequest("turn-completed", { sessionId: "classify-new-session", newSession: true,
  title: "新会话标题", history: { currentMessageId: 2, records: [
    { messageId: 1, parentId: null, role: "USER", status: "FINISHED",
      fragments: [{ type: "REQUEST", content: "请用中文回答" }] },
    { messageId: 2, parentId: 1, role: "ASSISTANT", status: "FINISHED",
      fragments: [{ type: "RESPONSE", content: "好的" }] },
  ] } });
await new Promise((resolve) => setTimeout(resolve, 0));
const classifyAutoJob = (await classifyRequest("snapshot")).jobs.find((job) => job.type === "CLASSIFY");
const classifyAutoDone = await new Promise((resolve) => listener({ type: "dtw:automation-result", accountId: classifyAccount,
  jobId: classifyAutoJob.jobId, raw: JSON.stringify({ sessionId: "classify-new-session", choice: "EXISTING",
    projectId: classifiedProject.projectId }) },
{ tab: { id: classifyAutoJob.tabId, url: "https://chat.deepseek.com/" } }, resolve));
assert.equal(classifyAutoDone.status, "DONE");
const classifiedSnapshot = await classifyRequest("snapshot");
assert.equal(classifiedSnapshot.memberships.find((item) => item.sessionId === "classify-new-session").projectId,
  classifiedProject.projectId);
assert.equal(projectDistillJobs(classifiedSnapshot).length, 1);
assert.equal(classifiedSnapshot.jobs.filter((job) => job.memoryScope === "PERSONAL").length, 1);
const classifiedPersonalJob = classifiedSnapshot.jobs.find((job) => job.memoryScope === "PERSONAL");
const classifiedPersonalFailed = await new Promise((resolve) => listener({ type: "dtw:automation-result", accountId: classifyAccount,
  jobId: classifiedPersonalJob.jobId, error: "暂时无法整理" },
{ tab: { id: classifiedPersonalJob.tabId, url: "https://chat.deepseek.com/" } }, resolve));
assert.equal(classifiedPersonalFailed.status, "FAILED");
assert.equal((await classifyRequest("memory-distill-personal")).started, true);
assert.equal((await classifyRequest("snapshot")).jobs.filter((job) => job.memoryScope === "PERSONAL").length, 2);

const personalScopeAccount = "personalscope123";
const personalScopeRequest = (type, body = {}) => new Promise((resolve) => listener({ type: `dtw:${type}`,
  accountId: personalScopeAccount, ...body }, { tab: { id: 889, url: "https://chat.deepseek.com/" } }, resolve));
await personalScopeRequest("settings-update", { key: "distillEveryTurns", value: 1 });
await personalScopeRequest("session-observe", { sessionId: "unassigned-user", loadedHistory: true });
await personalScopeRequest("history-observe", { sessionId: "unassigned-user", currentMessageId: 2, records: [
  { messageId: 1, parentId: null, role: "USER", fragments: [{ type: "REQUEST", content: "以后回答请先给结论" }] },
  { messageId: 2, parentId: 1, role: "ASSISTANT", status: "FINISHED", fragments: [{ type: "RESPONSE", content: "好的" }] },
] });
let personalScopeSnapshot = await personalScopeRequest("snapshot");
assert.equal(personalScopeSnapshot.memberships.find((item) => item.sessionId === "unassigned-user").projectId, null);
assert.equal(personalScopeSnapshot.memberships.find((item) => item.sessionId === "unassigned-user").memoryModeEnabled, false);
const unassignedPersonalJob = personalScopeSnapshot.jobs.find((job) => job.memoryScope === "PERSONAL");
assert.match(unassignedPersonalJob.payload, /以后回答请先给结论/);
assert.equal((await new Promise((resolve) => listener({ type: "dtw:automation-result", accountId: personalScopeAccount,
  jobId: unassignedPersonalJob.jobId, raw: JSON.stringify({ memories: [{ kind: "偏好", content: "希望回答先给结论",
    sourceSessionId: "unassigned-user", sourceMessageId: 2 }] }) },
{ tab: { id: unassignedPersonalJob.tabId, url: "https://chat.deepseek.com/" } }, resolve))).status, "DONE");
assert.equal((await personalScopeRequest("snapshot")).memories.some((item) => item.scope === "PERSONAL"
  && item.content === "希望回答先给结论"), true);
await personalScopeRequest("automation-mark", { sessionId: "unassigned-user" });
assert.equal((await personalScopeRequest("snapshot")).memories.find((item) =>
  item.content === "希望回答先给结论").state, "STALE");
await personalScopeRequest("session-observe", { sessionId: "automation-only", loadedHistory: true });
await personalScopeRequest("automation-mark", { sessionId: "automation-only" });
await personalScopeRequest("history-observe", { sessionId: "automation-only", currentMessageId: 2, records: [
  { messageId: 1, parentId: null, role: "USER", fragments: [{ type: "REQUEST", content: "自动化提示" }] },
  { messageId: 2, parentId: 1, role: "ASSISTANT", status: "FINISHED", fragments: [{ type: "RESPONSE", content: "自动化回答" }] },
] });
personalScopeSnapshot = await personalScopeRequest("snapshot");
assert.equal(personalScopeSnapshot.jobs.filter((job) => job.memoryScope === "PERSONAL").length, 1);
assert.equal(personalScopeSnapshot.projects.find((item) => item.systemKind === "PERSONAL").pendingTurnRefs.length, 0);
await personalScopeRequest("session-observe", { sessionId: "old-unassigned", loadedHistory: true });
await personalScopeRequest("history-observe", { sessionId: "old-unassigned", currentMessageId: 2, deferTurnCount: true, records: [
  { messageId: 1, parentId: null, role: "USER", fragments: [{ type: "REQUEST", content: "我习惯使用中文" }] },
  { messageId: 2, parentId: 1, role: "ASSISTANT", status: "FINISHED", fragments: [{ type: "RESPONSE", content: "记住了" }] },
] });
assert.equal((await personalScopeRequest("startup-memory-claim")).claimed, true);
const unassignedScan = await personalScopeRequest("startup-memory-reconcile",
  { verifiedSessionIds: ["old-unassigned", "automation-only"] });
assert.equal(unassignedScan.queuedPersonalTurns, 1);
assert.equal(unassignedScan.startedPersonal, true);
personalScopeSnapshot = await personalScopeRequest("snapshot");
assert.deepEqual(personalScopeSnapshot.jobs.filter((job) => job.memoryScope === "PERSONAL").at(-1).turnRefs,
  [{ sessionId: "old-unassigned", assistantMessageId: 2 }]);

storageValues["dtw.sidebar.v1"] = { tasks: [{ id: "legacy-project", name: "旧项目",
  conversationIds: ["legacy-session"], createdAt: "2025-01-01T00:00:00.000Z" },
{ id: "another-legacy", name: "另一旧项目", conversationIds: [] }],
conversations: { "legacy-session": { title: "旧项目对话", href: "https://chat.deepseek.com/chat/s/legacy-session" } } };
storageValues["dtw.memory.v1"] = { taskMemories: { "legacy-project": { summary: "旧项目概况", nextStep: "继续实现",
  items: [{ id: "goal-1", kind: "goal", text: "完成迁移", state: "active", pinned: true }] } },
userFacts: [{ id: "fact-1", key: "language", value: "中文", category: "preference", status: "active" }],
settings: { turnsPerOrganize: 7, autoAnalyze: true } };
const migrationAccount = "migration123";
await db.put("projects", { accountId: migrationAccount, projectId: "existing-project", name: "旧项目",
  archived: false, pendingTurnRefs: [] });
const migrationRequest = (type) => new Promise((resolve) => listener({ type: `dtw:${type}`,
  accountId: migrationAccount }, { tab: { id: 777, url: "https://chat.deepseek.com/" } }, resolve));
const migratedLegacy = await migrationRequest("snapshot");
assert.equal(migratedLegacy.legacyMigration.status, "imported");
assert.equal(migratedLegacy.legacyMigration.importedProjects, 1);
assert.equal(migratedLegacy.projects.find((project) => project.name === "旧项目")?.projectId, "existing-project");
assert.equal(migratedLegacy.projects.some((project) => project.name === "另一旧项目"), true);
assert.equal(migratedLegacy.memberships.find((item) => item.sessionId === "legacy-session")?.memoryModeEnabled, true);
assert.equal(migratedLegacy.memberships.find((item) => item.sessionId === "legacy-session")?.projectId, "existing-project");
assert.equal(migratedLegacy.memories.filter((item) => item.projectId === "existing-project").length, 3);
assert.equal(migratedLegacy.memories.filter((item) => item.scope === "PERSONAL").length, 1);
assert.equal(migratedLegacy.settings.distillEveryTurns, 7);
assert.equal((await migrationRequest("snapshot")).memories.length, migratedLegacy.memories.length);
console.log(JSON.stringify({ ok: true }));
