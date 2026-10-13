import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { workbenchSource, memoryCommitFixture } from "./workbench-fixture.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tables = new Map();
for (const name of ["sessions", "messages", "projects", "memberships", "memories", "memoryTurns", "jobs", "settings", "metrics"]) tables.set(name, new Map());
const db = {
  get: async (name, key) => tables.get(name).get(JSON.stringify(key)) || null,
  all: async (name, accountId) => [...tables.get(name).values()].filter((row) => accountId === undefined || row.accountId === accountId),
  by: async (name, _index, [accountId, sessionId]) => [...tables.get(name).values()].filter((row) => row.accountId === accountId && row.sessionId === sessionId),
  put: async (name, row) => {
    const id = ({ sessions: row.sessionId, projects: row.projectId, memberships: row.sessionId,
      memories: row.memoryId, memoryTurns: row.turnKey, jobs: row.jobId, settings: row.key, metrics: row.metricId })[name];
    const key = name === "messages" ? [row.accountId, row.sessionId, row.messageId] : [row.accountId, id];
    tables.get(name).set(JSON.stringify(key), structuredClone(row));
  },
  remove: async (name, key) => { tables.get(name).delete(JSON.stringify(key)); },
};
db.commitMemoryBatch = memoryCommitFixture(db);
let listener;
let alarmListener;
let automationTabs = 0;
let optionsOpened = 0;
const storageValues = { accountId: "account123", "dtw.firstRunAtMs": 1 };
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
const source = await workbenchSource();
vm.runInNewContext(source, { DTWDB: db, chrome, importScripts() {}, crypto: globalThis.crypto, structuredClone,
  Date, Number, String, Boolean, Array, Object, Set, Map, Promise, JSON, Math, TextEncoder, console, setTimeout }, { filename: "workbench.js" });
const accountId = "account123";
const request = (type, body) => new Promise((resolve) => listener({ type: `dtw:${type}`, createdAtMs: 1, accountId, ...body },
  { tab: { url: "https://chat.deepseek.com/a/chat" } }, resolve));
const extensionRequest = (type, body = {}) => new Promise((resolve) => listener({ type: `dtw:${type}`, createdAtMs: 1, accountId, ...body },
  { id: chrome.runtime.id, url: chrome.runtime.getURL("options/options.html"),
    tab: { url: chrome.runtime.getURL("options/options.html") } }, resolve));

assert.equal((await extensionRequest("snapshot")).ok, true);
const initialDisplaySettings = (await extensionRequest("snapshot")).settings;
assert.equal(initialDisplaySettings.maxContextTokens, 256000);
assert.equal(initialDisplaySettings.warningRatio, 1);
assert.equal(initialDisplaySettings.replyReserveTokens, 4000);
assert.equal(initialDisplaySettings.showPersonalMemory, false);
assert.equal(initialDisplaySettings.showProjectMemory, false);
assert.equal((await extensionRequest("settings-update", { key: "showPersonalMemory", value: true })).value, true);
assert.equal((await extensionRequest("settings-update", { key: "showProjectMemory", value: true })).value, true);
assert.equal((await extensionRequest("snapshot")).settings.showPersonalMemory, true);
assert.equal((await extensionRequest("snapshot")).settings.showProjectMemory, true);
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
assert.equal(automationTabs, 1, "自动化任务串行，归类等待旧会话记忆任务");
assert.equal(snap.jobs.filter((job) => job.type === "CLASSIFY").length, 1);
let classifyJob = snap.jobs.find((job) => job.type === "CLASSIFY");
assert.equal(classifyJob.status, "QUEUED");
const predecessor = snap.jobs.find((job) => job.status === "RUNNING");
await new Promise(resolve => listener({ type: "dtw:automation-result", accountId, jobId: predecessor.jobId, raw: '{"memories":[]}' },
  { tab: { id: predecessor.tabId, url: "https://chat.deepseek.com/" } }, resolve));
snap = await request("snapshot", {});
classifyJob = snap.jobs.find((job) => job.type === "CLASSIFY");
assert.equal(classifyJob.status, "RUNNING");
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
await request("session-observe", {sessionId:oldId,pinned:true});
assert.equal((await request("snapshot", {})).sessions.find(s=>s.sessionId===oldId).pinned,true);
assert.equal((await request("session-times-observe", {sessions:[{sessionId:oldId,updatedAtMs:recent+2000,pinned:false}]})).changed,1);
assert.equal((await request("snapshot", {})).sessions.find(s=>s.sessionId===oldId).pinned,false);
assert.equal((await request("session-times-observe", {sessions:[{sessionId:oldId,updatedAtMs:recent,pinned:true}]})).changed,0);
assert.equal((await request("snapshot", {})).sessions.find(s=>s.sessionId===oldId).pinned,false);
assert.equal((await request("open-options", {})).ok, true);
assert.equal(optionsOpened, 1);

const project = (await request("project-create", { name: "测试项目" })).project;
assert.equal((await extensionRequest("snapshot")).projects.some((row) => row.projectId === project.projectId), true);
await request("membership-move", { sessionId: oldId, projectId: project.projectId });
await request("memory-toggle", { sessionId: oldId, enabled: true });
// Memory update ordering, replacement and retries are covered in session-memory-test.mjs.

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
assert.equal((await request("snapshot", {})).jobs.find((job) => job.jobId === secondClassify.jobId).status, "DISMISSED");

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
assert.equal((await request("job-dismiss", { jobId: uncertain.jobId })).ok, true);
const ignoredSend = (await request("snapshot", {})).jobs.find((job) => job.jobId === uncertain.jobId);
assert.equal(ignoredSend.status, "DISMISSED");
assert.equal(ignoredSend.rawInput, "请保留的草稿");
assert.equal((await request("job-dismiss", { jobId: uncertain.jobId })).ok, false);

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

// Unified consolidation, scope validation and startup recovery are covered in session-memory-test.mjs.

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
  archived: false, pendingSessionRefs: [] });
const migrationRequest = (type) => new Promise((resolve) => listener({ type: `dtw:${type}`, createdAtMs: 1,
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
assert.equal(migratedLegacy.settings.distillEveryTurns, undefined, "旧轮数设置不再迁入");
assert.equal((await migrationRequest("snapshot")).memories.length, migratedLegacy.memories.length);

const strictAccount = "strict123";
const strictRequest = (type, body = {}) => {
  storageValues.accountId = strictAccount;
  return new Promise(resolve=>listener({type:'dtw:'+type,accountId:strictAccount,...body},{tab:{id:1234,url:'https://chat.deepseek.com/'}},resolve));
};
let strictSnapshot;
await db.put('memories',{accountId:strictAccount,memoryId:'taste',scope:'PERSONAL',projectId:null,kind:'偏好',content:'喜欢古典音乐',state:'ACTIVE',pinnedByUser:true,version:1,updatedAtMs:Date.now()});
assert.equal((await strictRequest("memory-save", { memory: { scope: "PERSONAL", kind: "资料",
  content: "我".repeat(2500) } })).ok, true);
assert.equal((await strictRequest("memory-save", { memory: { scope: "PERSONAL", kind: "资料",
  content: "你".repeat(2400) } })).ok, true);
assert.equal((await strictRequest("snapshot")).jobs.some((job) => job.type === "COMPACT"), false,
  "超过旧的 2000 字上限但未到 5000 字时不启动压缩");
const overBudget = await strictRequest("memory-save", { memory: { scope: "PERSONAL", kind: "资料",
  content: "他".repeat(100) } });
assert.equal(overBudget.ok, false);
assert.match(overBudget.error, /5000 字/);
strictSnapshot = await strictRequest("snapshot");
assert.equal(strictSnapshot.personalMemoryBudget.limit, 5000);
assert.equal(strictSnapshot.personalMemoryBudget.used, 4906, "超限新增不能部分写入");
const imported = await strictRequest("memory-import", { payload: { format: "dtw-memories-v1", memories: [
  { scope: "PERSONAL", kind: "偏好", content: "喜欢".repeat(600) },
] } });
assert.equal(imported.imported, 1);
assert.equal((await strictRequest("snapshot")).memories.find((item) => item.content === "喜欢".repeat(600)).state, "ACTIVE");
assert.ok((await strictRequest("snapshot")).jobs.some((job) => job.type === "COMPACT"));
await db.put("memories", { accountId: strictAccount, memoryId: "legacy-oversize", scope: "PERSONAL",
  projectId: null, kind: "偏好", content: "旧".repeat(3000), state: "ACTIVE", pinnedByUser: false,
  version: 1, updatedAtMs: 1 });
strictSnapshot = await strictRequest("snapshot");
assert.equal(strictSnapshot.memories.find((item) => item.memoryId === "legacy-oversize").state, "ACTIVE");
assert.ok(strictSnapshot.personalMemoryBudget.used > 5000, "压缩完成前保留所有原文，不自动停用");
const strictProject = (await strictRequest("project-create", { name: "个人记忆注入测试" })).project;
const preparedStrictSend = await strictRequest("prepare-send", { sessionId: "", newChatProjectId: strictProject.projectId,
  rawInput: "测试记忆注入" });
assert.equal(preparedStrictSend.ok, true);
assert.match(preparedStrictSend.prompt, /喜欢古典音乐/);
assert.doesNotMatch(preparedStrictSend.prompt, /旧旧旧旧旧旧/);
const personalSection = preparedStrictSend.prompt.split("## 个人记忆\n")[1].split("## 项目记忆：")[0];
const personalLines = personalSection.split("\n").filter((line) => /^\d+\. /.test(line));
assert.ok(personalLines.length > 0);
const sentPersonalCharacters = personalLines.reduce((sum, line) => sum + Array.from(line.replace(/^\d+\. /, "")).length, 0);
assert.ok(sentPersonalCharacters > 2000 && sentPersonalCharacters <= 5000,
  "首条消息可附带超过旧上限的个人记忆，并遵守新预算");
// Both scopes attach only on the first message; personal memory is independent of the project switch.
const injectionAccount = "injection123";
const injectionRequest = (type, body = {}) => new Promise(resolve => listener({ type: `dtw:${type}`, accountId: injectionAccount, ...body },
  { tab: { id: 42, url: "https://chat.deepseek.com/" } }, resolve));
assert.equal((await injectionRequest("prepare-send", { rawInput: "普通首条消息" })).native, true);
const projectOnly = (await injectionRequest("project-create", { name: "仅项目记忆", goalShort: "完成报告" })).project;
const projectOnlySend = await injectionRequest("prepare-send", { newChatProjectId: projectOnly.projectId, rawInput: "开始报告" });
assert.match(projectOnlySend.prompt, /以下附带项目「仅项目记忆」的目标与记忆/);
assert.match(projectOnlySend.prompt, /## 项目记忆：仅项目记忆\n### 目标\n1\. 完成报告/);
assert.doesNotMatch(projectOnlySend.prompt, /## 个人记忆/);
await db.put("memories", { accountId: injectionAccount, memoryId: "personal", scope: "PERSONAL", projectId: null,
  kind: "偏好", content: "回答简短，先给结论", state: "ACTIVE", pinnedByUser: true, version: 1 });
await db.put("memories", { accountId: injectionAccount, memoryId: "disabled", scope: "PERSONAL", projectId: null,
  kind: "偏好", content: "已停用的偏好", state: "DISABLED", pinnedByUser: true, version: 1 });
const firstPersonal = await injectionRequest("prepare-send", { rawInput: "首条问题" });
assert.equal(firstPersonal.ok, true);
assert.equal(firstPersonal.chooseProject, undefined);
assert.equal(firstPersonal.rollover, false);
assert.match(firstPersonal.prompt, /## 个人记忆\n### 偏好\n1\. 回答简短，先给结论/);
assert.match(firstPersonal.prompt, /以下附带个人记忆/);
assert.match(firstPersonal.prompt, /回答下方的本轮问题/);
assert.match(firstPersonal.prompt, /以用户当前明确要求为准/);
assert.doesNotMatch(firstPersonal.prompt, /已停用的偏好|喜欢古典音乐/);
assert.ok(firstPersonal.prompt.endsWith("<current_question>\n首条问题\n</current_question>"));
await injectionRequest("send-status", { jobId: firstPersonal.jobId, confirmed: true, sessionId: "personal-first", userMessageId: 1 });
assert.equal((await db.get("memberships", [injectionAccount, "personal-first"])).projectId, null);
assert.equal((await db.get("memberships", [injectionAccount, "personal-first"])).memoryModeEnabled, false);
assert.equal((await db.get("messages", [injectionAccount, "personal-first", 1])).originalInput, "首条问题");
assert.equal((await db.get("sessions", [injectionAccount, "personal-first"])).hasUserMessage, true);
assert.equal((await injectionRequest("prepare-send", { sessionId: "personal-first", rawInput: "第二条问题" })).native, true,
  "首条确认后，即使分支末端尚未同步，也不能再附带个人记忆");
const nextPersonal = await injectionRequest("prepare-send", { rawInput: "另一会话的首条问题" });
assert.match(nextPersonal.prompt, /回答简短/);

// A precreated, verified-empty session still gets personal memory; preparation and failures do not consume it.
await injectionRequest("session-observe", { sessionId: "empty-first", loadedHistory: true });
await injectionRequest("history-observe", { sessionId: "empty-first", records: [], currentMessageId: null });
const emptyFirst = await injectionRequest("prepare-send", { sessionId: "empty-first", rawInput: "空会话首条问题" });
assert.match(emptyFirst.prompt, /回答简短/);
await injectionRequest("send-status", { jobId: emptyFirst.jobId, error: "尚未提交" });
const retryFirst = await injectionRequest("prepare-send", { sessionId: "empty-first", rawInput: "重试首条问题" });
assert.match(retryFirst.prompt, /回答简短/);
await injectionRequest("send-status", { jobId: retryFirst.jobId, confirmed: true, sessionId: "empty-first" });
await injectionRequest("history-observe", { sessionId: "empty-first", records: [], currentMessageId: null });
assert.equal((await injectionRequest("prepare-send", { sessionId: "empty-first", rawInput: "后续问题" })).native, true,
  "没有消息 ID 的确认或滞后空历史也不能导致重复注入");
await injectionRequest("session-observe", { sessionId: "existing-personal", loadedHistory: true });
assert.equal((await injectionRequest("prepare-send", { sessionId: "existing-personal", rawInput: "旧会话继续" })).native, true,
  "历史尚未核对的旧会话不能被当作首条发送");
await injectionRequest("history-observe", { sessionId: "existing-personal", ...historicalHistory });
assert.equal((await injectionRequest("prepare-send", { sessionId: "existing-personal", rawInput: "旧会话下一轮" })).native, true);

// Reload the worker against the same stored sessions, without retaining any page state.
let restartedListener;
const restartedChrome = { ...chrome, runtime: { ...chrome.runtime, onMessage: { addListener(fn) { restartedListener = fn; } } } };
vm.runInNewContext(source, { DTWDB: db, chrome: restartedChrome, importScripts() {}, crypto: globalThis.crypto, structuredClone,
  Date, Number, String, Boolean, Array, Object, Set, Map, Promise, JSON, Math, TextEncoder, console, setTimeout });
const afterReload = await new Promise(resolve => restartedListener({ type: "dtw:prepare-send", accountId: injectionAccount,
  sessionId: "personal-first", rawInput: "刷新后继续" }, { tab: { id: 42, url: "https://chat.deepseek.com/" } }, resolve));
assert.equal(afterReload.native, true, "重启后台和重新打开会话后仍不重复附带个人记忆");
const injectionProject = (await injectionRequest("project-create", { name: "文档项目", goalShort: "完成使用文档" })).project;
await injectionRequest("membership-move", { sessionId: "personal-first", projectId: injectionProject.projectId });
await db.put("memories", { accountId: injectionAccount, memoryId: "project", scope: "PROJECT", projectId: injectionProject.projectId,
  kind: "决定", content: "用中文编写", state: "ACTIVE", pinnedByUser: true, version: 1 });
const projectOff = await injectionRequest("prepare-send", { sessionId: "personal-first", rawInput: "第二条问题" });
assert.equal(projectOff.native, true);
await injectionRequest("memory-toggle", { sessionId: "personal-first", enabled: true });
const projectOn = await injectionRequest("prepare-send", { sessionId: "personal-first", rawInput: "第三条问题" });
assert.equal(projectOn.native, true, "会话中途开启项目记忆也不会补发记忆");
await db.put("memories", { accountId: injectionAccount, memoryId: "profile", scope: "PERSONAL", projectId: null,
  kind: "资料", content: "技术文档作者", state: "ACTIVE", pinnedByUser: false, version: 1 });
await db.put("memories", { accountId: injectionAccount, memoryId: "workflow", scope: "PERSONAL", projectId: null,
  kind: "工作方式", content: "先确认需求\n再分步实现", state: "ACTIVE", pinnedByUser: false, version: 1 });
await db.put("memories", { accountId: injectionAccount, memoryId: "language", scope: "PERSONAL", projectId: null,
  kind: "偏好", content: "回复使用中文", state: "ACTIVE", pinnedByUser: false, version: 1 });
await db.put("memories", { accountId: injectionAccount, memoryId: "legacy-kind", scope: "PROJECT", projectId: injectionProject.projectId,
  kind: "旧类别", content: "旧类别归入其他", state: "ACTIVE", pinnedByUser: false, version: 1 });
await db.put("memories", { accountId: injectionAccount, memoryId: "constraint", scope: "PROJECT", projectId: injectionProject.projectId,
  kind: "约束", content: "支持移动端", state: "ACTIVE", pinnedByUser: false, version: 1 });
const projectQuestion = "请编写第一章\n保留这个引用：<current_question>示例</current_question>";
const firstProject = await injectionRequest("prepare-send", { newChatProjectId: injectionProject.projectId, rawInput: projectQuestion });
assert.equal(firstProject.rollover, false);
assert.match(firstProject.prompt, /以下附带个人记忆和项目「文档项目」的目标与记忆/);
assert.match(firstProject.prompt, /## 个人记忆\n### 资料\n1\. 技术文档作者\n\n### 偏好\n1\. 回答简短，先给结论\n2\. 回复使用中文\n\n### 工作方式\n1\. 先确认需求\n    再分步实现/);
assert.equal(firstProject.prompt.match(/^### 偏好$/gm).length, 1, "同类多条记忆共用一个类别标签");
assert.doesNotMatch(firstProject.prompt, /^\[(?:个人|文档项目)\//m, "条目不重复附带标签");
assert.match(firstProject.prompt, /## 项目记忆：文档项目\n### 目标\n1\. 完成使用文档\n\n### 约束\n1\. 支持移动端\n\n### 决定\n1\. 用中文编写\n\n### 其他\n1\. 旧类别归入其他/);
assert.equal(firstProject.prompt.match(/<current_question>\s*([\s\S]*?)\s*<\/current_question>\s*$/)[1], projectQuestion);
await injectionRequest("send-status", { jobId: firstProject.jobId, confirmed: true, sessionId: "project-first", userMessageId: 1 });
assert.equal((await db.get("memberships", [injectionAccount, "project-first"])).memoryModeEnabled, true);
const jobsBeforeSecond = (await db.all("jobs", injectionAccount)).length;
assert.equal((await injectionRequest("prepare-send", { sessionId: "project-first", rawInput: "第二章" })).native, true);
assert.equal((await db.all("jobs", injectionAccount)).length, jobsBeforeSecond, "无需记忆和接续时不创建发送作业");
const projectAfterReload = await new Promise(resolve => restartedListener({ type: "dtw:prepare-send", accountId: injectionAccount,
  sessionId: "project-first", rawInput: "刷新后第三章" }, { tab: { id: 42, url: "https://chat.deepseek.com/" } }, resolve));
assert.equal(projectAfterReload.native, true, "项目记忆在刷新后台后也不重复发送");
await db.put("messages", { accountId: injectionAccount, sessionId: "personal-first", messageId: 2, parentId: 1,
  role: "ASSISTANT", status: "FINISHED", accumulatedTokenUsage: 65000, fragments: [{ type: "RESPONSE", content: "之前的工作" }] });
await db.put("sessions", { ...await db.get("sessions", [injectionAccount, "personal-first"]), currentMessageId: 2 });
assert.equal((await injectionRequest("prepare-send", { sessionId: "personal-first", rawInput: "接续问题" })).native, true,
  "旧的 64k 阈值不再触发默认预算接续");
let successor;
for (const budget of [256000, 512000, 1000000]) {
  if (budget !== 256000)
    assert.equal((await injectionRequest("settings-update", { key: "maxContextTokens", value: budget })).value, budget);
  const cfg = (await injectionRequest("snapshot")).settings;
  assert.equal(cfg.maxContextTokens, budget);
  const tip = await db.get("messages", [injectionAccount, "personal-first", 2]);
  const boundary = budget - cfg.replyReserveTokens - Math.ceil("接续问题".length / 2);
  await db.put("messages", { ...tip, accumulatedTokenUsage: boundary - 1 });
  const jobsBeforeBoundary = (await db.all("jobs", injectionAccount)).length;
  assert.equal((await injectionRequest("prepare-send", { sessionId: "personal-first", rawInput: "接续问题" })).native, true);
  assert.equal((await db.all("jobs", injectionAccount)).length, jobsBeforeBoundary);
  await db.put("messages", { ...tip, accumulatedTokenUsage: boundary });
  successor = await injectionRequest("prepare-send", { sessionId: "personal-first", rawInput: "接续问题" });
  assert.equal(successor.rollover, true, `${budget} 预算计入本轮输入和回答预留后才触发接续`);
  if (budget !== 1000000)
    await db.put("jobs", { ...await db.get("jobs", [injectionAccount, successor.jobId]), status: "DONE" });
}
assert.equal((await injectionRequest("settings-update", { key: "maxContextTokens", value: 1200000 })).value, 1000000,
  "工作预算不能超过 1m 上限");
const reloadedBudget = await new Promise(resolve => restartedListener({ type: "dtw:snapshot", accountId: injectionAccount },
  { tab: { url: "https://chat.deepseek.com/" } }, resolve));
assert.equal(reloadedBudget.settings.maxContextTokens, 1000000, "保存的用户预算优先于默认值");
assert.match(successor.prompt, /回答简短/);
assert.equal(successor.prompt.match(/## 个人记忆/g).length, 1, "接续新会话的首条消息带入一次个人记忆");
assert.equal(successor.prompt.match(/## 项目记忆：文档项目/g).length, 1);
assert.match(successor.prompt, /<recent_progress>\n用户: 首条问题/);
assert.ok(successor.prompt.endsWith("<current_question>\n接续问题\n</current_question>"));
// Finish unrelated fixture tasks before exercising the global rollover slot.
for (const job of await db.all("jobs")) if (job.status === "RUNNING") await db.put("jobs", { ...job, status: "DONE" });
await db.put("jobs", { ...await db.get("jobs", [injectionAccount, successor.jobId]), status: "RUNNING", tabId: 42 });
await injectionRequest("send-status", { jobId: successor.jobId, confirmed: true, sessionId: "personal-successor", userMessageId: 1, waitForReply: true });
assert.equal((await db.get("jobs", [injectionAccount, successor.jobId])).status, "RUNNING", "收到用户消息仍占用接续队列，等待回复完成");
await injectionRequest("send-status", { jobId: successor.jobId, replyFinished: true });
assert.equal((await db.get("jobs", [injectionAccount, successor.jobId])).status, "DONE");
const successorSecond = await injectionRequest("prepare-send", { sessionId: "personal-successor", rawInput: "接续会话第二条" });
assert.equal(successorSecond.native, true, "接续会话第二条不重复附带两类记忆");
await db.put("sessions", { accountId: injectionAccount, sessionId: "helper", purpose: "CLASSIFY" });
assert.equal((await injectionRequest("prepare-send", { sessionId: "helper", rawInput: "自动化输入" })).native, true);
const unicodeAccount = "unicode123";
const unicodeSave = (content) => new Promise(resolve => listener({ type: "dtw:memory-save", accountId: unicodeAccount,
  memory: { scope: "PERSONAL", kind: "资料", content } }, { tab: { id: 42, url: "https://chat.deepseek.com/" } }, resolve));
assert.equal((await unicodeSave("中".repeat(1000) + "😀".repeat(1000))).ok, true);
assert.equal((await unicodeSave("文".repeat(1500))).ok, true);
assert.equal((await unicodeSave("字".repeat(1500))).ok, true);
assert.equal((await unicodeSave("a")).ok, false); // Chinese and supplementary characters each count once; total is exactly 5000.
// Deletions survive delayed DOM observations and remove both pending scopes.
await request("session-observe", { sessionId: "deleted-session", loadedHistory: true, title: "AI复刻前端样式技巧" });
await db.put("memberships", { accountId, sessionId: "deleted-session", projectId: "delete-project" });
for (const projectId of ["delete-project", "dtw-personal-memory"]) {
  const project = await db.get("projects", [accountId, projectId]);
  await db.put("projects", { ...project, accountId, projectId,
    currentSessionId: "deleted-session", pendingSessionRefs: [{ sessionId: "deleted-session", assistantMessageId: 2 }], pendingTurnCount: 1 });
}
await db.put("jobs", { accountId, jobId: "deleted-source-job", type: "CLASSIFY", status: "QUEUED", sourceSessionId: "deleted-session" });
await Promise.all([
  request("session-observe", { sessionId: "deleted-session", title: "延迟改名" }),
  request("session-delete", { sessionIds: ["deleted-session"] }),
  request("session-observe", { sessionId: "deleted-session", title: "旧节点", loadedHistory: true }),
]);
assert.equal((await db.get("sessions", [accountId, "deleted-session"])).deleted, true);
assert.equal((await request("history-observe", { sessionId: "deleted-session", ...historicalHistory })).ignored, true);
for (const projectId of ["delete-project", "dtw-personal-memory"])
  assert.equal((await db.get("projects", [accountId, projectId])).pendingSessionRefs.length, 0);
assert.equal((await db.get("projects", [accountId, "delete-project"])).currentSessionId, null);
assert.equal((await db.get("jobs", [accountId, "deleted-source-job"])).status, "CANCELLED");
assert.equal((await request("session-observe", { sessionId: "deleted-session", newSession: true })).ignored, true);
const retentionAccount = "retention123";
for (let index = 0; index < 13; index++) await db.put("sessions", {
  accountId: retentionAccount, sessionId: `auto-${index}`, purpose: index % 2 ? "MEMORY" : "CLASSIFY", updatedAtMs: index });
await db.put("sessions", { accountId: retentionAccount, sessionId: "ordinary", purpose: "USER", updatedAtMs: -1 });
await db.put("sessions", { accountId: "another123", sessionId: "other-account-auto", purpose: "AUTOMATION", updatedAtMs: -1 });
await db.put("jobs", { accountId: retentionAccount, jobId: "active", status: "RUNNING", automationSessionId: "auto-0" });
const batches = [];
let remoteDeleteOk = false;
chrome.tabs.sendMessage = async (_tabId, message) => {
  batches.push(structuredClone(message)); return { ok: remoteDeleteOk, error: "remote failure" };
};
const prune = () => new Promise(resolve => listener({ type: "dtw:automation-prune", accountId: retentionAccount },
  { tab: { id: 42, url: "https://chat.deepseek.com/a/chat" } }, resolve));
assert.equal((await prune()).ok, false);
assert.equal((await db.get("sessions", [retentionAccount, "auto-1"])).deleted, undefined);
assert.deepEqual(Array.from(batches.at(-1).sessionIds), ["auto-2", "auto-1"]);
remoteDeleteOk = true;
await Promise.all([prune(), prune()]);
assert.equal(batches.length, 2); // Concurrent tabs cannot delete the same batch twice.
assert.equal((await db.get("sessions", [retentionAccount, "auto-1"])).deleted, true);
assert.equal((await db.get("sessions", [retentionAccount, "auto-0"])).deleted, undefined);
await db.put("jobs", { accountId: retentionAccount, jobId: "active", status: "DONE", automationSessionId: "auto-0" });
assert.equal((await prune()).deleted, 1);
assert.equal((await db.all("sessions", retentionAccount)).filter(s => !s.deleted && s.purpose !== "USER").length, 10);
assert.equal((await db.get("sessions", [retentionAccount, "ordinary"])).deleted, undefined);
assert.equal((await db.get("sessions", ["another123", "other-account-auto"])).deleted, undefined);
assert.equal((await prune()).deleted, undefined);
await db.put("sessions", { accountId: retentionAccount, sessionId: "new-helper", purpose: "MEMORY", automationOrigin: "PLUGIN", updatedAtMs: 100 });
remoteDeleteOk = false;
const automaticPrune = () => new Promise(resolve => listener({ type: "dtw:automation-prune", accountId: retentionAccount, automatic: true },
  { tab: { id: 42, url: "https://chat.deepseek.com/a/chat" } }, resolve));
assert.equal((await automaticPrune()).ok, false);
const failedAttempts = batches.length;
await automaticPrune();
assert.equal(batches.length, failedAttempts, "自动清理失败不循环重试");
const cleanupIssue = (await db.all("jobs", retentionAccount)).find(job => job.type === "CLEANUP");
assert.equal(cleanupIssue.status, "NEEDS_REVIEW", "清理未完成也保留提醒记录");
console.log(JSON.stringify({ ok: true }));
