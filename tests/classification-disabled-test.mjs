/** Default classifier shutdown checks; all storage, tabs and replies are offline fixtures. */
import assert from "node:assert/strict";
import vm from "node:vm";
import { runWorkbench } from "./workbench-fixture.mjs";

const fields = { sessions: "sessionId", projects: "projectId", memberships: "sessionId", memories: "memoryId",
  memoryTurns: "turnKey", jobs: "jobId", settings: "key", metrics: "metricId" };
const tables = Object.fromEntries([...Object.keys(fields), "messages"].map(name => [name, new Map()]));
const db = {
  get: async (name, key) => structuredClone(tables[name].get(JSON.stringify(key)) || null),
  all: async (name, accountId) => [...tables[name].values()]
    .filter(row => accountId === undefined || row.accountId === accountId).map(row => structuredClone(row)),
  by: async (name, _index, [accountId, sessionId]) => (await db.all(name, accountId)).filter(row => row.sessionId === sessionId),
  put: async (name, row) => tables[name].set(JSON.stringify(name === "messages"
    ? [row.accountId, row.sessionId, row.messageId] : [row.accountId, row[fields[name]]]), structuredClone(row)),
  remove: async (name, key) => tables[name].delete(JSON.stringify(key)),
};
const accountId = "disabled123";
const created = []; const removed = []; const sent = [];
let alarmListener;
const chrome = {
  runtime: { onMessage: { addListener() {} }, onInstalled: { addListener() {} } },
  storage: { local: { get: async () => ({ accountId, "dtw.firstRunAtMs": Date.now() }) } },
  tabs: {
    create: async options => { const tab = { id: 100 + created.length, ...options }; created.push(tab); return tab; },
    sendMessage: async (id, message) => { sent.push({ id, message }); return { ok: true }; },
    remove: async id => { removed.push(id); },
  },
  alarms: { create() {}, onAlarm: { addListener(fn) { alarmListener = fn; } } },
};
const context = vm.createContext({ DTWDB: db, chrome, crypto: globalThis.crypto, structuredClone, console, setTimeout });
await runWorkbench(context);
const fn = name => vm.runInContext(name, context);
assert.equal(fn("AUTO_CLASSIFY_ENABLED"), false);
const history = { currentMessageId: 2, records: [
  { messageId: 1, parentId: null, role: "USER", fragments: [{ type: "REQUEST", content: "本地问题" }] },
  { messageId: 2, parentId: 1, role: "ASSISTANT", status: "FINISHED", fragments: [{ type: "RESPONSE", content: "本地回答" }] },
] };
await fn("observeSession")(accountId, { sessionId: "fresh", newSession: true, createdAtMs: 1 });
await fn("observeHistory")(accountId, { sessionId: "fresh", ...history });
await fn("observeSession")(accountId, { sessionId: "fresh", title: "标题已生成" });
await fn("completedTurn")(accountId, { sessionId: "fresh", newSession: true, createdAtMs: 1, title: "首轮完成", history });
await fn("classify")(accountId, "fresh", 1);
assert.equal((await db.all("jobs", accountId)).filter(job => job.type === "CLASSIFY").length, 0);
assert.equal(created.length, 0, "新会话与标题更新不会启动归类标签页");
const project = (await fn("createProject")(accountId, { name: "手动项目" })).project;
await fn("moveSession")(accountId, { sessionId: "fresh", projectId: project.projectId });
assert.equal((await db.get("memberships", [accountId, "fresh"])).projectId, project.projectId, "手动移动仍可用");

const putJob = (jobId, status, extra = {}) => db.put("jobs", { accountId, jobId, type: "CLASSIFY", status,
  sourceSessionId: "fresh", inputVersion: 1, payload: "保留的归类提示词", createdAtMs: 1, updatedAtMs: 1, ...extra });
await putJob("failed", "FAILED");
await assert.rejects(fn("retryClassification")(accountId, { jobId: "failed" }), /自动归类已关闭/);
assert.equal((await db.get("jobs", [accountId, "failed"])).status, "FAILED", "关闭期间重试保留旧任务");
await putJob("queued", "QUEUED");
await putJob("pending", "PENDING", { accountId: "other123" });
await putJob("running", "RUNNING", { tabId: 42 });
await putJob("done", "DONE", { result: { choice: "UNASSIGNED" } });
const rollover = { accountId, jobId: "rollover", type: "ROLLOVER", status: "QUEUED", payload: "接续问题",
  createdAtMs: 2, updatedAtMs: 2 };
await db.put("jobs", rollover);
await fn("dispatchQueuedJob")(await db.get("jobs", [accountId, "running"]));
assert.equal(sent.length, 0, "旧归类任务也不会重新派发");
const membershipBefore = await db.get("memberships", [accountId, "fresh"]);
const result = await fn("automationResult")(accountId, { jobId: "running",
  raw: JSON.stringify({ sessionId: "fresh", choice: "NEW", suggestedName: "迟到的建议" }) }, { tab: { id: 42 } });
assert.equal(result.ignored, true);
assert.deepEqual(await db.get("memberships", [accountId, "fresh"]), membershipBefore, "迟到结果不更改归属");
assert.equal((await db.all("projects", accountId)).some(row => row.name === "迟到的建议"), false);
for (const [id, account] of [["queued", accountId], ["pending", "other123"], ["running", accountId]]) {
  const job = await db.get("jobs", [account, id]);
  assert.equal(job.status, "CANCELLED");
  assert.equal(job.result.ignored, "classification-disabled");
  assert.equal(job.payload, "保留的归类提示词", "关闭功能保留任务记录和提示词");
}
assert.equal((await db.get("jobs", [accountId, "done"])).status, "DONE");
assert.deepEqual(removed, [42]);
assert.equal((await db.get("jobs", [accountId, "rollover"])).status, "RUNNING", "停止归类不占用接续的队列名额");
assert.equal(created.length, 1);
await putJob("expired", "RUNNING", { tabId: 43 });
await alarmListener({ name: "dtw-job-check" });
assert.equal((await db.get("jobs", [accountId, "expired"])).status, "CANCELLED", "定时恢复不会重新激活旧归类任务");
assert.equal(sent.every(row => row.message.type === "dtw:rollover"), true);
console.log(JSON.stringify({ ok: true, checks: "default shutdown, no classification requests, retained jobs, late replies, manual moves and unaffected rollover" }));
