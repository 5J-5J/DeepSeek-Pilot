import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { workbenchSource } from "./workbench-fixture.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = await workbenchSource();
const jobs = new Map();
const settingsRows = new Map();
const jobKey = (accountId, jobId) => JSON.stringify([accountId, jobId]);
const db = {
  get: async (table, key) => structuredClone((table === "jobs" ? jobs : settingsRows).get(JSON.stringify(key)) || null),
  all: async (table, accountId) => ["jobs", "settings"].includes(table) ? [...(table === "jobs" ? jobs : settingsRows).values()]
    .filter((job) => accountId === undefined || job.accountId === accountId).map((job) => structuredClone(job)) : [],
  put: async (table, row) => { if (["jobs", "settings"].includes(table)) (table === "jobs" ? jobs : settingsRows).set(jobKey(row.accountId, row.jobId || row.key), structuredClone(row)); },
};
let removedListener;
let alarmListener;
let accountChangedListener;
const created = [];
let nextTabId = 100;
let activeAccount = "account-a";
const chrome = {
  runtime: { onMessage: { addListener() {} }, onInstalled: { addListener() {} }, onStartup: { addListener() {} } },
  alarms: { onAlarm: { addListener(fn) { alarmListener = fn; } }, create() {} },
  tabs: {
    onRemoved: { addListener(fn) { removedListener = fn; } },
    create: async (options) => { const tab = { id: ++nextTabId, ...options }; created.push(tab); return tab; },
    sendMessage: async () => ({ ok: true }),
    remove: async () => {},
  },
  storage: { local: { get: async () => ({ accountId: activeAccount }) },
    onChanged: { addListener(fn) { accountChangedListener = fn; } } },
};
let clockMs = Date.now();
class Clock extends Date { static now() { return clockMs; } }
const context = vm.createContext({ DTWDB: db, chrome, importScripts() {}, crypto: globalThis.crypto,
  structuredClone, Date: Clock, Number, String, Boolean, Array, Object, Set, Map, Promise, JSON, Math, TextEncoder,
  console, setTimeout });
vm.runInContext(source, context, { filename: "workbench.js" });
const drain = vm.runInContext("drainJobQueue", context);
const automationResult = vm.runInContext("automationResult", context);
const sendStatus = vm.runInContext("sendStatus", context);
const startRollover = vm.runInContext("startRollover", context);
const get = (id) => jobs.get(jobKey("account-a", id));
const running = () => [...jobs.values()].filter((job) => job.status === "RUNNING");
const timestamp = Date.now();
for (const [index, [jobId, type, accountId]] of [
  ["first", "CLASSIFY", "account-a"], ["second", "CLASSIFY", "account-a"],
  ["third", "ROLLOVER", "account-a"], ["fourth", "CLASSIFY", "account-a"],
  ["fifth", "CLASSIFY", "account-a"],
].entries()) {
  await db.put("jobs", { accountId, jobId, type, status: "QUEUED", payload: jobId,
    createdAtMs: timestamp + index, updatedAtMs: timestamp });
}

await Promise.all([drain(), drain(), drain()]);
assert.deepEqual(created.map(tab => tab.id), [101]);
assert.deepEqual(running().map(job => job.jobId), ["first"]);
await db.put("jobs", { ...get("fifth"), updatedAtMs: timestamp - 11 * 60000 });
await alarmListener({ name: "dtw-job-check" });
assert.equal(get("fifth").status, "QUEUED", "排队时间不计入执行超时");
assert.equal(created.length, 1);
assert.equal((await automationResult("account-a", { jobId: "first", error: "测试失败" }, { tab: { id: get("first").tabId } })).status, "FAILED");
assert.deepEqual(running().map(job => job.jobId), ["second"], "失败任务跳过，继续下一项");
await removedListener(get("second").tabId);
assert.equal(get("second").status, "NEEDS_REVIEW");
assert.deepEqual(running().map(job => job.jobId), ["third"]);
assert.equal(created[2].active, true, "接续任务启动时激活新标签页");
await sendStatus("account-a", { jobId: "third", error: "发送结果不明" });
assert.equal(get("third").status, "NEEDS_REVIEW");
assert.deepEqual(running().map(job => job.jobId), ["fourth"]);
await db.put("jobs", { accountId: "account-b", jobId: "other-account", type: "CLASSIFY", status: "QUEUED", payload: "other-account", createdAtMs: timestamp + 5, updatedAtMs: timestamp });
activeAccount = "account-b";
accountChangedListener({ accountId: { oldValue: "account-a", newValue: "account-b" } }, "local");
await drain();
assert.equal(created.length, 4, "切换账号也不能同时执行两个任务");
await removedListener(get("fourth").tabId);
assert.equal(created.length, 5);
assert.equal(jobs.get(jobKey("account-b", "other-account")).status, "RUNNING");
await db.put("jobs", { accountId: "account-b", jobId: "rollover-waiting", type: "ROLLOVER", status: "PENDING", payload: "接续请求", createdAtMs: timestamp + 6, updatedAtMs: timestamp });
assert.equal((await startRollover("account-b", { jobId: "rollover-waiting" })).queued, true);
await removedListener(jobs.get(jobKey("account-b", "other-account")).tabId);
assert.equal(jobs.get(jobKey("account-b", "rollover-waiting")).status, "RUNNING");
await db.put("jobs", { accountId: "account-b", jobId: "after-timeout", type: "CLASSIFY", status: "QUEUED", payload: "稍后整理", createdAtMs: timestamp + 7, updatedAtMs: timestamp });
const timed = jobs.get(jobKey("account-b", "rollover-waiting"));
await db.put("jobs", { ...timed, updatedAtMs: timestamp - 11 * 60000 });
await alarmListener({ name: "dtw-job-check" });
assert.equal(jobs.get(jobKey("account-b", "rollover-waiting")).status, "NEEDS_REVIEW");
assert.equal(jobs.get(jobKey("account-b", "after-timeout")).status, "RUNNING");
assert.equal(running().length, 1);
const historySlot = vm.runInContext("historyRequestSlot", context);
assert.equal((await historySlot("account-a", {})).waitMs, 0);
assert.equal((await historySlot("account-a", {})).waitMs, 1000);
assert.equal((await historySlot("account-b", {})).waitMs, 0);
clockMs += 1000;
assert.equal((await historySlot("account-a", {})).waitMs, 0);
assert.equal((await historySlot("account-a", { rateLimited: true })).rateLimited, true);
const restarted = vm.createContext({ DTWDB: db, chrome, importScripts() {}, crypto: globalThis.crypto, structuredClone, Date: Clock, TextEncoder, console, setTimeout });
vm.runInContext(source, restarted);
const afterRestart = vm.runInContext("historyRequestSlot", restarted);
assert.equal((await afterRestart("account-a", {})).rateLimited, true, "重载后台仍保留全账号冷却");
clockMs += 60000;
assert.equal((await afterRestart("account-a", {})).waitMs, 0);
await vm.runInContext("requestIssue", restarted)("account-a", { code: "AUTH_REQUIRED", message: "登录失效" });
assert.equal((await afterRestart("account-a", {})).code, "AUTH_REQUIRED");
await vm.runInContext("requestReady", restarted)("account-a", { observedAtMs: clockMs - 1 });
assert.equal((await afterRestart("account-a", {})).code, "AUTH_REQUIRED", "其它标签页的旧登录信息不能解除失效状态");
clockMs++;
await vm.runInContext("requestReady", restarted)("account-a", { observedAtMs: clockMs });
assert.equal((await afterRestart("account-a", {})).blocked, undefined, "原生页面提供有效账号后恢复，不验证登录接口");
await db.put("settings", { accountId: "account-b", key: "automationPaused", value: true });
assert.equal((await historySlot("account-b", {})).code, "PAUSED");
assert.equal((await historySlot("account-b", { userAction: true })).blocked, undefined, "人工发送引起的必要同步继续可用");
jobs.clear(); activeAccount = "account-a";
await db.put("jobs", { accountId: "account-a", jobId: "auth-dispatch", type: "CLASSIFY", status: "RUNNING", tabId: 999, updatedAtMs: clockMs });
let attempts = 0;
chrome.tabs.sendMessage = async () => { attempts++; return { ok: false, code: "AUTH_REQUIRED", error: "登录失效" }; };
await vm.runInContext("dispatchQueuedJob", context)(get("auth-dispatch"));
assert.equal(attempts, 1, "页面报告失效后，调度器不再重复询问或重试发送");
assert.equal(get("auth-dispatch").status, "FAILED");
assert.equal((await historySlot("account-a", {})).code, "AUTH_REQUIRED");
console.log(JSON.stringify({ ok: true, checks: "global serial queue, skip failed tasks, timeouts, account switching, persistent cooldown and request pause" }));
