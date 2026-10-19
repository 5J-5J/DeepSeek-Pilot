import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { workbenchSource, memoryCommitFixture } from "./workbench-fixture.mjs";

const source = await workbenchSource({ autoClassify: true });
const tables = new Map(["sessions", "messages", "projects", "memberships", "memories", "memoryTurns", "jobs", "settings", "metrics"].map((name) => [name, new Map()]));
const idFields = { sessions: "sessionId", projects: "projectId", memberships: "sessionId", memories: "memoryId", memoryTurns: "turnKey", jobs: "jobId", settings: "key", metrics: "metricId" };
const db = {
  get: async (name, key) => structuredClone(tables.get(name).get(JSON.stringify(key)) || null),
  all: async (name, accountId) => [...tables.get(name).values()].filter((row) => accountId === undefined || row.accountId === accountId).map((row) => structuredClone(row)),
  by: async (name, _index, [accountId, sessionId]) => (await db.all(name, accountId)).filter((row) => row.sessionId === sessionId),
  put: async (name, row) => tables.get(name).set(JSON.stringify(name === "messages" ? [row.accountId, row.sessionId, row.messageId] : [row.accountId, row[idFields[name]]]), structuredClone(row)),
  remove: async (name, key) => tables.get(name).delete(JSON.stringify(key)),
  removeMemories: async (accountId, memories, epochKey, epoch) => {
    for (const memory of memories) await db.remove("memories", [accountId, memory.memoryId]);
    await db.put("settings", { accountId, key: epochKey, value: epoch });
  },
};
db.commitMemoryBatch = memoryCommitFixture(db);
let listener;
const accountId = "feature-account";
const stored = { accountId };
const tabs = [];
const chrome = {
  runtime: { getURL: (path = "") => `chrome-extension://test/${path}`, onMessage: { addListener(fn) { listener = fn; } }, onInstalled: { addListener() {} } },
  storage: { local: { get: async (key) => ({ [key]: stored[key] }), set: async (values) => Object.assign(stored, values) } },
  alarms: { create() {}, onAlarm: { addListener() {} } },
  tabs: { create: async (options) => { const tab = { id: tabs.length + 1, ...options }; tabs.push(tab); return tab; }, sendMessage: async () => ({ ok: true }), remove: async () => {} },
};
const context = vm.createContext({ DTWDB: db, chrome, importScripts() {}, crypto: globalThis.crypto, TextEncoder,
  structuredClone, Date, Number, String, Boolean, Array, Object, Set, Map, Promise, JSON, Math, console, setTimeout });
const started = Date.now();
vm.runInContext(source, context);
const sender = { url: "chrome-extension://test/options/options.html", tab: { id: 1, url: "https://chat.deepseek.com/" } };
const request = (type, body = {}) => new Promise((resolve) => listener({ type: `dtw:${type}`, accountId, ...body }, sender, resolve));
const initial = await request("snapshot");
assert.ok(initial.settings.memoryStartAtMs >= started && initial.settings.memoryStartAtMs <= Date.now());
assert.equal((await request("snapshot")).settings.memoryStartAtMs, initial.settings.memoryStartAtMs);
assert.equal(stored["dtw.firstRunAtMs"], initial.settings.memoryStartAtMs);
assert.equal((await request("settings-update", { key: "memoryStartAtMs", value: "bad" })).ok, false);
assert.equal((await request("settings-update", { key: "memoryStartAtMs", value: 1000 })).value, 1000);
await request("settings-update", { key: "automationPaused", value: true });
const project = (await request("project-create", { name: "功能测试" })).project;
const history = (time) => ({ currentMessageId: 2, records: [
  { messageId: 1, parentId: null, role: "USER", insertedAtMs: time, fragments: [{ type: "REQUEST", content: "以后都用中文回答" }] },
  { messageId: 2, parentId: 1, role: "ASSISTANT", status: "FINISHED", insertedAtMs: 2000, fragments: [{ type: "RESPONSE", content: "好的" }] },
] });
for (const [sessionId, timestamp] of [["old", 999], ["boundary", 1000], ["unknown", null]]) {
  await request("session-observe", { sessionId, loadedHistory: true });
  await request("membership-move", { sessionId, projectId: project.projectId });
  await request("history-observe", { sessionId, ...history(timestamp) });
}
await request("session-observe", { sessionId: "current", loadedHistory: true, createdAtMs: 3000 });
await request("session-list-observe", { sessions: await db.all("sessions", accountId) });
let snapshot = await request("snapshot");
assert.equal(snapshot.sessions.find((session) => session.sessionId === "old").createdAtMs, 999);
assert.ok(snapshot.jobs.length === 2 && snapshot.jobs.every((job) => job.sourceSessionId === "boundary"));
assert.equal(tabs.length, 0, "暂停后归类和两种记忆都不能启动自动化会话");
assert.equal((await request("memory-distill-current", { sessionId: "old" })).started, false);
for (const job of snapshot.jobs) {
  await db.put('jobs',{...job,status:'RUNNING',tabId:1});
  assert.equal((await request('automation-result',{jobId:job.jobId,raw:JSON.stringify({memories:[]})})).status,'DONE');
}
assert.equal((await request("memory-distill-current", { sessionId: "old" })).started, false, "手动整理也不能绕过起始时间");
const scan = await request("memory-reconcile", { verifiedSessionIds: ["old", "boundary", "unknown"] });
assert.equal(scan.queuedSessions, 0);

const personal = (await request("memory-save", { memory: { scope: "PERSONAL", content: "喜欢中文", kind: "偏好" } })).memory;
const projectMemory = (await request("memory-save", { memory: { scope: "PROJECT", projectId: project.projectId, content: "目标", kind: "目标" } })).memory;
const deletion = { scope: "PERSONAL", memories: [{ memoryId: personal.memoryId, version: personal.version }] };
assert.equal((await request("memory-delete-batch", { ...deletion, memories: [{ memoryId: personal.memoryId, version: 999 }] })).ok, false);
assert.equal((await request("memory-delete-batch", { ...deletion, memories: [{ memoryId: projectMemory.memoryId, version: projectMemory.version }] })).ok, false);
await db.put("memories", { ...personal, accountId: "other-account", memoryId: "foreign" });
assert.equal((await request("memory-delete-batch", { ...deletion, memories: [{ memoryId: "foreign", version: 1 }] })).ok, false);
assert.equal((await request("memory-delete-batch", { ...deletion, memories: [deletion.memories[0], { memoryId: "missing", version: 1 }] })).ok, false);
assert.ok(await db.get("memories", [accountId, personal.memoryId]), "批量校验失败不能部分删除");
const oldJob = snapshot.jobs.find((job) => job.memoryScope === "PERSONAL");
await db.put("jobs", { ...oldJob, status: "RUNNING", tabId: 1 });
assert.equal((await request("memory-delete-batch", deletion)).deleted, 1);
const stale = await request("automation-result", { jobId: oldJob.jobId, raw: JSON.stringify({ memories: [], disableMemoryIds: [] }) });
assert.equal(stale.status, "CANCELLED", "删除前启动的整理不能写回结果，也无需用户重试");
assert.equal((await request("memory-save", { memory: personal })).ok, false, "已删除条目的旧编辑窗口不能重建该条目");
assert.equal((await request("memory-delete-batch", { scope: "PROJECT", projectId: project.projectId,
  memories: [{ memoryId: projectMemory.memoryId, version: projectMemory.version }] })).deleted, 1);
assert.equal((await request("snapshot")).memories.length, 0);
assert.ok(await db.get("memories", ["other-account", "foreign"]));

tables.get("jobs").clear();
for (const [index, type] of ["CLASSIFY", "CLASSIFY", "ROLLOVER"].entries()) await db.put("jobs", {
  accountId, jobId: `queue-${index}`, type, status: "QUEUED", createdAtMs: Date.now() + index, updatedAtMs: Date.now(),
  sourceSessionId: "boundary", payload: "test",
  projectId: project.projectId, memoryEpoch: 1,
});
assert.equal((await request("job-queue-update", { jobId: "queue-2", action: "up" })).ok, true);
snapshot = await request("snapshot");
assert.deepEqual(snapshot.jobs.sort((a, b) => a.queueOrder - b.queueOrder).map((job) => job.jobId), ["queue-0", "queue-2", "queue-1"]);
assert.equal((await request("job-queue-update", { jobId: "queue-0", action: "cancel" })).ok, true);
assert.equal((await request("job-queue-update", { jobId: "queue-0", action: "up" })).ok, false);
assert.equal((await request("settings-update", { key: "automationPaused", value: false })).ok, true);
assert.equal(tabs.length, 1, "全局只启动一个自动化任务");
assert.equal(tabs[0].active, true, "重排后的接续先启动");
assert.equal((await request("job-queue-update", { jobId: "queue-2", action: "cancel" })).ok, false, "运行中任务不能被当作等待任务取消");

await request("settings-update", { key: "automationPaused", value: true });
tables.get("jobs").clear();
const manualUpdate = await request("memory-distill-personal");
const skippedJob = await db.get("jobs", [accountId, manualUpdate.jobId]);
assert.equal((await request("job-queue-update", { jobId: skippedJob.jobId, action: "cancel" })).ok, true);
assert.equal((await request("memory-reconcile", { verifiedSessionIds: ["boundary"] })).startedPersonal, false,
  "取消的会话版本不会在启动补扫时立即重新入队");
await db.put("jobs", { ...skippedJob, jobId: "outdated-cutoff", status: "QUEUED" });
await request("settings-update", { key: "memoryStartAtMs", value: 1001 });
await request("settings-update", { key: "automationPaused", value: false });
assert.equal((await db.get("jobs", [accountId, "outdated-cutoff"])).status, "CANCELLED");
assert.equal(tabs.length, 1, "修改起始时间后排队的旧会话不能再启动");
console.log(JSON.stringify({ ok: true, checks: "cutoff, queue controls, scoped batch deletion, stale results" }));
