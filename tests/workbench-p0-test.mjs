/** P0 boundaries and memory previews; every account and response is an offline fixture. */
import assert from "node:assert/strict";
import vm from "node:vm";
import { runWorkbench } from "./workbench-fixture.mjs";

const fields = { sessions: "sessionId", messages: "messageId", projects: "projectId", memberships: "sessionId",
  memories: "memoryId", memoryTurns: "turnKey", jobs: "jobId", settings: "key", metrics: "metricId" };
const tables = Object.fromEntries(Object.keys(fields).map(name => [name, new Map()]));
let writes = 0;
const db = {
  get: async (name, key) => structuredClone(tables[name].get(JSON.stringify(key)) || null),
  all: async (name, accountId) => [...tables[name].values()].filter(row => accountId === undefined || row.accountId === accountId).map(row => structuredClone(row)),
  by: async (name, _index, [accountId, sessionId]) => (await db.all(name, accountId)).filter(row => row.sessionId === sessionId),
  put: async (name, row) => { writes++; tables[name].set(JSON.stringify(name === "messages"
    ? [row.accountId, row.sessionId, row.messageId] : [row.accountId, row[fields[name]]]), structuredClone(row)); },
  remove: async (name, key) => { writes++; tables[name].delete(JSON.stringify(key)); },
};
const requests = []; let deleteOk = true;
const chrome = {
  runtime: { getURL: (path = "") => `chrome-extension://fixture/${path}`,
    onMessage: { addListener() {} }, onInstalled: { addListener() {} } },
  storage: { local: { get: async () => ({ accountId: "preview123", "dtw.firstRunAtMs": 1 }) } },
  tabs: { sendMessage: async (_id, message) => { requests.push(structuredClone(message)); return { ok: deleteOk, error: "模拟删除失败" }; },
    create: async () => { throw new Error("测试不允许启动远端任务"); }, remove: async () => {} },
  alarms: { create() {}, onAlarm: { addListener() {} } },
};
const boot = async () => {
  const context = vm.createContext({ DTWDB: db, chrome, crypto: globalThis.crypto, structuredClone, console, setTimeout });
  await runWorkbench(context); return context;
};
let context = await boot();
const fn = name => vm.runInContext(name, context);
const retention = "retention-p0";
const putSession = (id, purpose, extra = {}) => db.put("sessions", { accountId: retention, sessionId: id, purpose, updatedAtMs: 0, ...extra });
for (let i = 0; i < 14; i++) await putSession(`helper-${i}`, i % 2 ? "MEMORY" : "CLASSIFY", { updatedAtMs: i });
await putSession("manual", "USER");
await fn("markAutomationSession")(retention, { sessionId: "manual" });
await putSession("unknown", "AUTOMATION");
await putSession("linked", "AUTOMATION", { updatedAtMs: 20 });
await putSession("deleted", "MEMORY", { deleted: true });
await putSession("source-is-self", "AUTOMATION");
for (const id of ["linked", "manual", "deleted", "source-is-self"]) await db.put("jobs", {
  accountId: retention, jobId: `legacy-${id}`, type: "DISTILL", status: "DONE",
  automationSessionId: id, sourceSessionId: id === "source-is-self" ? id : "source", updatedAtMs: 1 });
await fn("migrateAutomationSessions")(retention);
const session = id => db.get("sessions", [retention, id]);
assert.equal((await session("manual")).automationOrigin, "MANUAL");
assert.equal((await session("unknown")).automationOrigin, "UNKNOWN");
assert.equal((await session("source-is-self")).automationOrigin, "UNKNOWN");
assert.equal((await session("linked")).automationOrigin, "PLUGIN");
assert.equal((await session("deleted")).deleted, true, "迁移不复活已删除的辅助会话");
const beforeMigration = writes;
context = await boot(); await fn("migrateAutomationSessions")(retention);
assert.equal(writes, beforeMigration, "后台重启后迁移仍幂等");
await db.put("jobs", { accountId: retention, jobId: "protect", status: "RUNNING", automationSessionId: "helper-0" });
const prune = automatic => fn("pruneAutomationSessions")(retention, { automatic }, { tab: { id: 42, url: "https://chat.deepseek.com/" } });
await db.put("settings", { accountId: retention, key: "automationPaused", value: true });
assert.equal((await prune()).deferred, true);
assert.equal(requests.length, 0);
await db.put("settings", { accountId: retention, key: "automationPaused", value: false });
for (const issue of [{ code: "RATE_LIMITED", untilMs: Date.now() + 60000 }, { code: "AUTH_REQUIRED" }, { code: "ACCOUNT_RESTRICTED" }]) {
  await db.put("settings", { accountId: retention, key: "requestIssue", value: issue });
  assert.equal((await prune()).deferred, true);
}
await db.remove("settings", [retention, "requestIssue"]);
await db.put("jobs", { accountId: retention, jobId: "queued", type: "DISTILL", status: "QUEUED" });
assert.equal((await prune()).deferred, true);
await db.remove("jobs", [retention, "queued"]);
deleteOk = false;
await assert.rejects(prune(), /模拟删除失败/);
assert.deepEqual(requests.at(-1).sessionIds, ["helper-4", "helper-3", "helper-2", "helper-1"]);
assert.equal((await session("helper-1")).deleted, undefined, "删除失败时保留本地会话");
deleteOk = true;
assert.equal((await prune()).deleted, 4);
for (const id of ["manual", "unknown", "source-is-self", "helper-0"]) assert.equal((await session(id)).deleted, undefined);
await fn("unmarkAutomationSession")(retention, { sessionId: "manual" });
context = await boot(); await fn("migrateAutomationSessions")(retention);
assert.equal((await session("manual")).purpose, "USER", "恢复的手动会话不会被旧任务重新收纳");
assert.equal((await session("manual")).automationOrigin, "MANUAL");

const accountId = "preview123";
const preview = body => fn("memoryPreview")(accountId, body || {});
const prepare = body => fn("prepareSend")(accountId, { rawInput: "测试问题", ...body }, { tab: { id: 50 } });
await db.put("settings", { accountId, key: "automationPaused", value: true });
assert.equal((await preview()).status, "PENDING");
assert.equal((await preview()).block, "");
assert.equal((await preview({ newChatMemoryEnabled: true })).chooseProject, true);
await db.put("sessions", { accountId, sessionId: "unread", purpose: "USER" });
assert.equal((await preview({ sessionId: "unread" })).status, "UNKNOWN");
await db.put("sessions", { accountId, sessionId: "helper", purpose: "MEMORY" });
assert.equal((await preview({ sessionId: "helper" })).status, "AUTOMATION");
assert.equal((await prepare({ sessionId: "helper" })).native, true);
await db.put("projects", { accountId, projectId: "p1", name: "测试项目", goalShort: "完成离线验证" });
await db.put("memories", { accountId, memoryId: "personal", scope: "PERSONAL", kind: "偏好", state: "ACTIVE", content: "回答用中文" });
for (let i = 0; i < 60; i++) await db.put("memories", {
  accountId, memoryId: `project-${i}`, projectId: "p1", scope: "PROJECT", kind: "约束", state: "ACTIVE", content: `约束 ${String(i).padStart(2, "0")}` });
const body = { newChatProjectId: "p1" };
let pending = await preview(body);
assert.equal(pending.personalCount, 1);
assert.equal(pending.projectCount, 44, "显示实际选择的条数，而非管理页总数");
assert.equal(pending.projectGoal, true);
const beforePreview = writes;
await preview(body); await preview(body);
assert.equal(writes, beforePreview, "预览不创建任务、不修改记忆或设置");
const first = await prepare({ ...body, previewRevision: pending.revision });
assert.equal(first.prompt.split("\n\n<current_question>")[0], pending.block);
assert.equal((await preview(body)).status, "UNKNOWN", "准备任务不等于确认发送");
await fn("sendStatus")(accountId, { jobId: first.jobId, error: "模拟首条发送失败" });
await db.put("sessions", { accountId, sessionId: "empty", purpose: "USER", historyObserved: true, currentMessageId: null });
assert.equal((await preview({ sessionId: "empty" })).status, "PENDING");
const failed = await prepare({ sessionId: "empty" });
await fn("sendStatus")(accountId, { jobId: failed.jobId, error: "未确认" });
assert.equal((await preview({ sessionId: "empty" })).status, "UNKNOWN");
assert.equal((await db.get("sessions", [accountId, "empty"])).hasUserMessage, undefined);
const retry = await prepare({ sessionId: "empty" });
assert.match(retry.prompt, /回答用中文/, "失败或未确认不会消耗首条机会");
await fn("sendStatus")(accountId, { jobId: retry.jobId, confirmed: true, sessionId: "empty", userMessageId: 1 });
const historical = await preview({ sessionId: "empty" });
assert.equal(historical.status, "APPLIED");
assert.match(historical.block, /回答用中文/);
await db.put("memories", { accountId, memoryId: "personal", scope: "PERSONAL", kind: "偏好", state: "ACTIVE", content: "最新内容" });
assert.equal((await preview({ sessionId: "empty" })).block, historical.block, "历史预览不读取最新记忆");
assert.equal((await prepare({ sessionId: "empty" })).native, true);
await db.put("memberships", { accountId, sessionId: "empty", projectId: "p1", memoryModeEnabled: false, version: 1 });
await fn("toggleMemory")(accountId, { sessionId: "empty", enabled: true });
assert.equal((await preview({ sessionId: "empty" })).block, historical.block);
assert.equal((await prepare({ sessionId: "empty" })).native, true, "中途开启项目记忆不会补发");
await fn("toggleMemory")(accountId, { sessionId: "empty", enabled: false });
assert.equal((await preview({ sessionId: "empty" })).status, "APPLIED", "关闭开关不会撤回已发送背景");
await db.put("sessions", { accountId, sessionId: "plain", purpose: "USER", hasUserMessage: true, historyObserved: true, currentMessageId: 1 });
await db.put("messages", { accountId, sessionId: "plain", messageId: 1, parentId: null, role: "USER", fragments: [{ type: "REQUEST", content: "普通消息" }] });
assert.equal((await preview({ sessionId: "plain" })).status, "NOT_APPLIED");
await db.put("sessions", { accountId, sessionId: "partial", purpose: "USER", hasUserMessage: true, historyObserved: true, currentMessageId: 3 });
await db.put("messages", { accountId, sessionId: "partial", messageId: 3, parentId: 2, role: "USER", fragments: [{ type: "REQUEST", content: "分支根缺失" }] });
assert.equal((await preview({ sessionId: "partial" })).status, "UNKNOWN");

for (const job of await db.all("jobs", accountId)) if (job.type === "SEND" && !job.sourceSessionId && !job.result?.confirmed)
  await db.put("jobs", { ...job, status: "CANCELLED" });
pending = await preview(body);
await db.put("memories", { accountId, memoryId: "personal", scope: "PERSONAL", kind: "偏好", state: "ACTIVE", content: "预览后更新" });
const jobCount = (await db.all("jobs", accountId)).length;
const changed = await prepare({ ...body, previewRevision: pending.revision });
assert.equal(changed.previewChanged, true);
assert.equal((await db.all("jobs", accountId)).length, jobCount, "预览变化时不创建发送任务");
assert.match(changed.preview.block, /预览后更新/);
const refreshed = await prepare({ ...body, previewRevision: changed.preview.revision });
assert.equal(refreshed.prompt.split("\n\n<current_question>")[0], changed.preview.block);
await db.put("settings", { accountId, key: "showPersonalMemory", value: false });
await db.put("settings", { accountId, key: "showProjectMemory", value: false });
assert.equal((await preview(body)).revision, changed.preview.revision, "显示设置不改变发送内容");

for (const job of await db.all("jobs", accountId)) if (job.type === "SEND" && !job.sourceSessionId && !job.result?.confirmed)
  await db.put("jobs", { ...job, status: "CANCELLED" });
for (const row of await db.all("memories", accountId)) if (row.scope === "PROJECT") await db.remove("memories", [accountId, row.memoryId]);
for (let i = 0; i < 10; i++) await db.put("memories", {
  accountId, memoryId: `large-${i}`, projectId: "p1", scope: "PROJECT", kind: "约束", state: "ACTIVE", content: "长".repeat(3000) });
const bounded = await preview(body);
assert.equal(bounded.projectCount, 3, "12000 字符选择预算与预览一致");
const boundedSend = await prepare({ ...body, previewRevision: bounded.revision });
assert.equal(boundedSend.prompt.split("\n\n<current_question>")[0], bounded.block);
await db.put("memories", { accountId, memoryId: "over-budget", scope: "PERSONAL", kind: "其他", state: "ACTIVE", content: "超".repeat(5001) });
const beforeOverBudget = writes;
await preview(body);
assert.equal(writes, beforeOverBudget, "超额记忆的只读预览也不启动压缩任务");
context = await boot();
assert.equal((await preview({ sessionId: "empty" })).block, historical.block, "后台重启后保留真实历史预览");
assert.equal((await prepare({ sessionId: "empty" })).native, true);
await fn("toggleMemory")(accountId, { sessionId: "empty", enabled: true });
await db.put("settings", { accountId, key: "maxContextTokens", value: 4000 });
const rolloverPreview = await preview({ sessionId: "empty" });
await db.put("projects", { accountId, projectId: "p1", name: "测试项目", goalShort: "接续前更新目标" });
const rolloverChanged = await prepare({ sessionId: "empty", previewRevision: rolloverPreview.revision,
  rolloverPreviewRevision: rolloverPreview.rolloverRevision });
assert.equal(rolloverChanged.previewChanged, true, "接续发送也必须核对最新背景预览");
assert.match(rolloverChanged.preview.nextSelection.block, /接续前更新目标/);
const rollover = await prepare({ sessionId: "empty", previewRevision: rolloverChanged.preview.revision,
  rolloverPreviewRevision: rolloverChanged.preview.rolloverRevision });
assert.equal(rollover.rollover, true);
assert.equal(rollover.prompt.split("\n\n<recent_progress>")[0], rolloverChanged.preview.nextSelection.block);
await fn("observeHistory")(accountId, { sessionId: "empty", currentMessageId: 1, deferMemoryUpdate: true,
  records: [{ messageId: 1, parentId: null, role: "USER", fragments: [{ type: "REQUEST", content: "测试问题" }] }] });
assert.equal((await preview({ sessionId: "empty" })).block, historical.block, "原生历史仅返回问题时保留已确认的背景");
await fn("observeHistory")(accountId, { sessionId: "empty", currentMessageId: 1, deferMemoryUpdate: true,
  records: [{ messageId: 1, parentId: null, role: "USER", fragments: [{ type: "REQUEST", content: "编辑后的普通问题" }] }] });
assert.equal((await preview({ sessionId: "empty" })).status, "NOT_APPLIED", "编辑消息后不复用已经移除的历史背景");
console.log(JSON.stringify({ ok: true, checks: "safe cleanup provenance, idempotent migration, read-only bounded previews, confirmation, history, toggles and revision changes" }));
