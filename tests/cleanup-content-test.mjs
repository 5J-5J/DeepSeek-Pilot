/** Local content bridge checks, including account changes during throttling. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../core/content/workbench.js", import.meta.url), "utf8");
let listener; let afterWait; let slots; let remoteError;
const requests = []; const deletions = [];
const window = new EventTarget();
window.addEventListener("dtw:delete-request", event => deletions.push(JSON.parse(event.detail)));
const context = vm.createContext({ window, URL, CustomEvent, crypto: globalThis.crypto, console, setTimeout, clearTimeout,
  location: { href: "https://chat.deepseek.com/a/chat" },
  document: { createElement: () => ({}), head: { append() {} }, addEventListener() {} },
  chrome: { runtime: { getURL: value => value, onMessage: { addListener(fn) { listener = fn; } },
    sendMessage: async message => { requests.push(message); return { ok: true, ...(slots.shift() || {}) }; } } },
  fixtureDelay: async () => { await afterWait?.(); },
  fixtureResult: async () => { if (remoteError) throw new Error(remoteError); },
});
vm.runInContext(source.replace('  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));', '  const delay = fixtureDelay;')
  .replace('  start().catch((error) => console.warn("[DeepSeek 项目工作台]", error));', `
  globalThis.fixture = { state };
  requireSendAllowed = () => {};
  waitEvent = fixtureResult;
`), context);
const state = context.fixture.state;
const reset = () => {
  Object.assign(state, { accountId: "account123", automationRunning: false, rolloverRunning: false, snapshot: {
    settings: { automationPaused: false }, sessions: [
      { sessionId: "helper", purpose: "MEMORY", automationOrigin: "PLUGIN" },
      { sessionId: "manual", purpose: "AUTOMATION", automationOrigin: "MANUAL" },
      { sessionId: "unknown", purpose: "AUTOMATION", automationOrigin: "UNKNOWN" },
      { sessionId: "deleted", purpose: "MEMORY", automationOrigin: "PLUGIN", deleted: true },
    ],
  } });
  requests.length = 0; deletions.length = 0; slots = []; afterWait = null; remoteError = "";
};
const call = (sessionIds = ["helper"], accountId = "account123") => new Promise(resolve =>
  listener({ type: "dtw:automation-delete", accountId, sessionIds }, {}, resolve));
for (const id of ["manual", "unknown", "deleted"]) {
  reset(); assert.equal((await call([id])).ok, false);
  assert.equal(requests.length, 0); assert.equal(deletions.length, 0);
}
reset(); assert.equal((await call(["helper"], "other-account")).ok, false);
assert.equal(deletions.length, 0);
reset(); state.snapshot.settings.automationPaused = true;
assert.equal((await call()).ok, false);
assert.equal(deletions.length, 0);
for (const change of [
  () => { state.accountId = "other-account"; },
  () => { state.snapshot.sessions[0].automationOrigin = "MANUAL"; },
  () => { state.snapshot.settings.automationPaused = true; },
  () => { state.automationRunning = true; },
]) {
  reset(); slots = [{ waitMs: 1 }, { waitMs: 0 }]; afterWait = change;
  assert.equal((await call()).ok, false);
  assert.equal(deletions.length, 0, "等待期间保护条件变化，不进入远端删除");
}
reset(); slots = [{ blocked: true, message: "账号请求受限" }];
assert.equal((await call()).ok, false); assert.equal(deletions.length, 0);
reset(); assert.equal((await call()).ok, true);
assert.equal(deletions.length, 1); assert.equal(deletions[0].accountId, "account123");
assert.deepEqual(deletions[0].sessionIds, ["helper"]);
reset(); remoteError = "模拟删除结果未确认";
assert.equal((await call()).ok, false);
console.log(JSON.stringify({ ok: true, checks: "provenance, account, pause, restrictions and changes while waiting before deletion" }));
