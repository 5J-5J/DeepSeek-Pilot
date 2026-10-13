/** Cleanup protection checks; every account and response is an offline fixture. */
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

console.log(JSON.stringify({ ok: true, checks: "cleanup provenance, idempotent migration, retention, pause and failed deletion" }));
