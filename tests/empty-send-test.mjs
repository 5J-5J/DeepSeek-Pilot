/** First-message edge cases: attachment-only sends stay native; no project picker is forced. */
import assert from "node:assert/strict";
import vm from "node:vm";
import { runWorkbench, memoryCommitFixture } from "./workbench-fixture.mjs";

const accountId = "empty-send-fixture";
class Clock extends Date { static now() { return 1000000; } }
const names = ["sessions", "messages", "projects", "memberships", "memories", "memoryTurns", "jobs", "settings", "metrics"];
const tables = Object.fromEntries(names.map((name) => [name, new Map()]));
const fields = { sessions: "sessionId", projects: "projectId", memberships: "sessionId", memories: "memoryId",
  memoryTurns: "turnKey", jobs: "jobId", settings: "key", metrics: "metricId" };
const db = {
  get: async (name, key) => structuredClone(tables[name].get(JSON.stringify(key)) || null),
  all: async (name, account) => [...tables[name].values()].filter((row) => account === undefined || row.accountId === account).map((row) => structuredClone(row)),
  by: async (name, _index, [account, session]) => (await db.all(name, account)).filter((row) => row.sessionId === session),
  put: async (name, row) => tables[name].set(JSON.stringify(name === "messages"
    ? [row.accountId, row.sessionId, row.messageId] : [row.accountId, row[fields[name]]]), structuredClone(row)),
  remove: async (name, key) => tables[name].delete(JSON.stringify(key)),
};
db.commitMemoryBatch = memoryCommitFixture(db);
let listener;
const chrome = {
  runtime: { getURL: (path = "") => `chrome-extension://fixture/${path}`, onMessage: { addListener(fn) { listener = fn; } }, onInstalled: { addListener() {} } },
  storage: { local: { get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys])
    .map((key) => [key, key === "accountId" ? accountId : key === "dtw.firstRunAtMs" ? 1000000 : undefined])), set: async () => {} } },
  tabs: { create: async (options) => ({ id: 1, ...options }), sendMessage: async () => ({ ok: true }), remove: async () => {} },
  alarms: { create() {}, onAlarm: { addListener() {} } },
};
const context = vm.createContext({ DTWDB: db, chrome, crypto: globalThis.crypto, TextEncoder, structuredClone, Date: Clock, console, setTimeout });
await runWorkbench(context);
const call = (type, body = {}) => new Promise((resolve) => listener({ type: `dtw:${type}`, accountId, ...body },
  { tab: { id: 11, url: "https://chat.deepseek.com/a/chat" } }, resolve));

const saved = await call("memory-save", { memory: { scope: "PERSONAL", kind: "偏好", content: "先给结论" } });
assert.equal(saved.ok, true);

// A first message with only an attachment has no text to inject; the native send must survive.
const empty = await call("prepare-send", { sessionId: "", rawInput: "" });
assert.equal(empty.ok, true);
assert.equal(empty.native, true, "无文字的首条消息应回落到原生发送");

// With text, personal memory is still injected and no project selection is demanded.
const prepared = await call("prepare-send", { sessionId: "", rawInput: "继续" });
assert.equal(prepared.ok, true);
assert.equal(prepared.chooseProject, undefined, "未选择项目时不再要求先选项目");
assert.match(prepared.prompt, /先给结论/);
assert.match(prepared.prompt, /<current_question>\n继续\n<\/current_question>/);
console.log(JSON.stringify({ ok: true, checks: "attachment-only native send and no forced project picker" }));
