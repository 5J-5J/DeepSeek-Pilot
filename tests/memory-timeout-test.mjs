/** Offline memory deadlines with real background handlers and a simulated clock. */
import assert from "node:assert/strict";
import vm from "node:vm";
import { runWorkbench, memoryCommitFixture } from "./workbench-fixture.mjs";

async function fixture() {
  let clock = 1000000;
  class Clock extends Date { static now() { return clock; } }
  const accountId = "memory-timeout-account";
  const fields = { sessions: "sessionId", messages: "messageId", projects: "projectId", memberships: "sessionId",
    memories: "memoryId", memoryTurns: "turnKey", jobs: "jobId", settings: "key", metrics: "metricId" };
  const tables = Object.fromEntries(Object.keys(fields).map(name => [name, new Map()]));
  const db = {
    get: async (name, key) => structuredClone(tables[name].get(JSON.stringify(key)) || null),
    all: async (name, account) => [...tables[name].values()].filter(row => !account || row.accountId === account).map(row => structuredClone(row)),
    by: async (name, _index, [account, session]) => (await db.all(name, account)).filter(row => row.sessionId === session),
    put: async (name, row) => tables[name].set(JSON.stringify(name === "messages"
      ? [row.accountId, row.sessionId, row.messageId] : [row.accountId, row[fields[name]]]), structuredClone(row)),
    remove: async (name, key) => tables[name].delete(JSON.stringify(key)),
  };
  db.commitMemoryBatch = memoryCommitFixture(db);
  let listener; let alarmListener; let nextTab = 0;
  const alarms = new Map(); const created = []; const removed = []; const dispatched = [];
  const chrome = {
    runtime: { getURL: path => `chrome-extension://fixture/${path}`, onMessage: { addListener(fn) { listener = fn; } },
      onInstalled: { addListener() {} }, onStartup: { addListener() {} } },
    storage: { local: { get: async () => ({ accountId, "dtw.firstRunAtMs": 1 }), set: async () => {} } },
    alarms: { create: async (name, info) => alarms.set(name, info), get: async name => alarms.get(name),
      clear: async name => alarms.delete(name), onAlarm: { addListener(fn) { alarmListener = fn; } } },
    tabs: { create: async options => { const tab = { id: ++nextTab, ...options }; created.push(tab); return tab; },
      sendMessage: async (id, message) => { dispatched.push({ id, message }); return { ok: true }; },
      remove: async id => { removed.push(id); }, onRemoved: { addListener() {} } },
  };
  const restart = async () => {
    const context = vm.createContext({ DTWDB: db, chrome, crypto: globalThis.crypto, TextEncoder, structuredClone, Date: Clock, console, setTimeout });
    await runWorkbench(context);
  };
  await restart();
  const call = (type, body = {}, tabId = 900) => new Promise(resolve => listener({ type: `dtw:${type}`, accountId, ...body },
    { tab: { id: tabId, url: "https://chat.deepseek.com/" } }, resolve));
  const ok = async (...args) => { const result = await call(...args); assert.equal(result.ok, true, result.error); return result; };
  const jobs = () => db.all("jobs", accountId);
  const running = async () => (await jobs()).find(job => job.status === "RUNNING");
  const alarm = async name => { alarms.delete(name); await alarmListener({ name }); };
  const setup = async () => {
    await ok("settings-update", { key: "automationPaused", value: true });
    for (const [id, createdAtMs] of [["first", 100], ["second", 200]]) {
      await ok("session-observe", { sessionId: id, createdAtMs, loadedHistory: true });
      await ok("history-observe", { sessionId: id, currentMessageId: 2, deferMemoryUpdate: true, records: [
        { messageId: 1, parentId: null, role: "USER", status: "FINISHED", fragments: [{ type: "REQUEST", content: "以后使用中文" }] },
        { messageId: 2, parentId: 1, role: "ASSISTANT", status: "FINISHED", fragments: [{ type: "RESPONSE", content: "好的" }] },
      ] });
    }
    await ok("session-list-observe", { sessions: [{ sessionId: "first" }, { sessionId: "second" }] });
  };
  return { accountId, db, chrome, alarms, created, removed, dispatched, call, ok, jobs, running, alarm, setup, restart,
    now: () => clock, advance: ms => { clock += ms; } };
}

const f = await fixture();
await f.setup();
await f.ok("memory-save", { memory: { scope: "PERSONAL", kind: "偏好", content: "保留已有偏好" } });
const preserved = await f.db.all("memories", f.accountId);
f.advance(120000);
await f.ok("settings-update", { key: "automationPaused", value: false });
const first = await f.running();
const timeoutName = `dtw-memory-timeout:${first.jobId}`;
assert.equal(first.startedAtMs, f.now(), "排队时间不计入 30 秒执行期限");
assert.equal(f.alarms.get(timeoutName).when, first.startedAtMs + 30000);
assert.equal(f.created[0].active, false, "整理任务仅打开后台标签页");
assert.equal(f.dispatched[0].message.deadlineAtMs, first.startedAtMs + 30000);
f.advance(29000);
await f.ok("automation-progress", { jobId: first.jobId, phase: "WAITING_REPLY" }, first.tabId);
assert.equal((await f.running()).jobId, first.jobId, "不足 30 秒时继续等待");
assert.equal(f.alarms.get(timeoutName).when, first.startedAtMs + 30000, "心跳不会延长截止时间");
f.advance(1000);
await f.alarm(timeoutName);
assert.equal((await f.db.get("jobs", [f.accountId, first.jobId])).status, "NEEDS_REVIEW");
assert.match((await f.db.get("jobs", [f.accountId, first.jobId])).error, /30 秒.*跳过/);
assert.deepEqual(await f.db.all("memories", f.accountId), preserved, "超时不修改已有记忆");
assert.ok(f.removed.includes(first.tabId));
const second = await f.running();
assert.equal(second.sourceSessionId, "second", "跳过超时前序，立即执行下一会话");
assert.equal(second.startedAtMs, f.now(), "下一项获得独立的 30 秒期限");
assert.equal((await f.call("automation-result", { jobId: first.jobId, raw: '{"memories":[]}' }, first.tabId)).ok, false,
  "超时后的迟到结果不能写入记忆");
await f.ok("memory-reconcile");
assert.equal((await f.jobs()).filter(job => job.sourceSessionId === "first").length, 1, "超时任务不会自动循环重试");
f.advance(1000);
await f.ok("settings-update", { key: "automationPaused", value: true });
await f.ok("automation-result", { jobId: second.jobId, raw: JSON.stringify({ memories: preserved }) }, second.tabId);
assert.equal((await f.db.get("jobs", [f.accountId, second.jobId])).status, "DONE");
assert.equal(f.alarms.has(`dtw-memory-timeout:${second.jobId}`), false, "完成后清除该任务的闹钟");
await f.ok("memory-job-retry", { jobId: first.jobId });
await f.ok("settings-update", { key: "automationPaused", value: false });
const retry = await f.running();
assert.equal(retry.sourceSessionId, "first");
assert.equal(retry.startedAtMs, f.now(), "主动重试重新计时");

// The background can resume a deadline without relying on a live page or heartbeat.
const resumed = await fixture();
await resumed.setup();
await resumed.ok("settings-update", { key: "automationPaused", value: false });
const interrupted = await resumed.running();
resumed.advance(31000);
await resumed.restart();
await resumed.alarm(`dtw-memory-timeout:${interrupted.jobId}`);
assert.equal((await resumed.db.get("jobs", [resumed.accountId, interrupted.jobId])).status, "NEEDS_REVIEW");
assert.ok(resumed.removed.includes(interrupted.tabId));
assert.deepEqual(await resumed.db.all("memories", resumed.accountId), []);

// Late progress/results must enforce the deadline even if Chrome delays an alarm.
for (const type of ["automation-progress", "automation-result"]) {
  const delayed = await fixture();
  await delayed.setup();
  await delayed.ok("settings-update", { key: "automationPaused", value: false });
  const expired = await delayed.running();
  delayed.advance(30001);
  const reply = await delayed.ok(type, { jobId: expired.jobId, phase: "WAITING_REPLY", raw: '{"memories":[]}' }, expired.tabId);
  assert.equal(reply.status, "NEEDS_REVIEW");
  assert.equal((await delayed.running()).sourceSessionId, "second");
  assert.deepEqual(await delayed.db.all("memories", delayed.accountId), []);
}
const compact = await fixture();
await compact.ok("settings-update", { key: "automationPaused", value: true });
await compact.db.put("memories", { accountId: compact.accountId, memoryId: "large-personal", scope: "PERSONAL", projectId: null,
  kind: "偏好", content: "字".repeat(5000), pinnedByUser: false, state: "ACTIVE", version: 1 });
const uncompressed = await compact.db.all("memories", compact.accountId);
await compact.ok("snapshot");
await compact.ok("settings-update", { key: "automationPaused", value: false });
const compression = await compact.running();
assert.equal(compression.type, "COMPACT");
compact.advance(30000);
await compact.alarm(`dtw-memory-timeout:${compression.jobId}`);
assert.equal((await compact.db.get("jobs", [compact.accountId, compression.jobId])).status, "NEEDS_REVIEW");
assert.deepEqual(await compact.db.all("memories", compact.accountId), uncompressed, "压缩超时也保留原记忆");
const loading = await fixture();
await loading.setup();
const createTab = loading.chrome.tabs.create;
let releaseTab; let requestedTab;
const requested = new Promise(resolve => { requestedTab = resolve; });
loading.chrome.tabs.create = async options => {
  loading.chrome.tabs.create = createTab;
  requestedTab(); await new Promise(resolve => { releaseTab = resolve; }); return createTab(options);
};
const starting = loading.ok("settings-update", { key: "automationPaused", value: false });
await requested;
loading.advance(31000); releaseTab(); await starting;
assert.equal((await loading.jobs()).find(job => job.sourceSessionId === "first").status, "NEEDS_REVIEW");
assert.equal((await loading.running()).sourceSessionId, "second", "创建标签页超过期限时也跳过并推进队列");
assert.ok(loading.removed.includes(loading.created[0].id));
assert.equal(loading.dispatched.some(item => item.id === loading.created[0].id), false, "不能向已超时的新标签页发送消息");
console.log("Memory timeout checks passed: 30-second execution limit, queue progression, preserved memory, late results, retries and background restart.");
