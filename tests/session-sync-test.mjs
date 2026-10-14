/** Offline tests: every DeepSeek response is an in-memory fake. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
const [requestSource, historySource, networkSource, contentSource] = await Promise.all([
  "logic/request-body-core.js", "logic/history-core.js", "page/page-network.js", "content/workbench.js",
].map(file => readFile(new URL(`../core/${file}`, import.meta.url), "utf8")));
const settle = () => new Promise(resolve => setTimeout(resolve, 20));
const profile = id => ({ code: 0, data: { biz_code: 0, biz_data: { user: { id } } } });
const historyData = id => ({ code: 0, data: { biz_code: 0, biz_data: {
  chat_session: { id, current_message_id: 2, title: "本地测试" }, chat_messages: [
    { message_id: 1, parent_id: null, role: "USER", status: "FINISHED", fragments: [{ type: "REQUEST", content: "问题" }] },
    { message_id: 2, parent_id: 1, role: "ASSISTANT", status: "FINISHED", fragments: [{ type: "RESPONSE", content: "回答" }] },
  ],
} } });
class FakeXhr extends EventTarget { open() {} send() {} setRequestHeader() {} }
function fixture() {
  const window = new EventTarget(); const calls = []; const events = [];
  let router = () => new Response('{}');
  window.fetch = async (input, options) => {
    const url = input instanceof Request ? input.url : String(input); calls.push({ url, options }); return router(url, options);
  };
  const context = vm.createContext({ window, XMLHttpRequest: class extends FakeXhr {}, Request, Response, Headers,
    URL, URLSearchParams, CustomEvent, Event, TextDecoder, crypto: globalThis.crypto, setTimeout, clearTimeout, console,
    localStorage: { getItem() { throw new Error("不得探测登录凭据"); } } });
  for (const name of ["profile-result", "account-ready", "history-observed", "network-error", "history-result", "delete-result", "request-issue", "sessions-deleted", "session-list", "session-list-result"])
    window.addEventListener(`dtw:${name}`, event => events.push({ name, ...JSON.parse(event.detail) }));
  vm.runInContext(requestSource, context); vm.runInContext(networkSource, context); vm.runInContext(historySource, context);
  const emit = (name, data = {}) => window.dispatchEvent(new CustomEvent(`dtw:${name}`, { detail: JSON.stringify(data) }));
  return { context, window, calls, events, emit, route(fn) { router = fn; },
    async login(id = "account123") { router = () => new Response(JSON.stringify(profile(id)));
      await window.fetch("/api/v0/users/current", { headers: { Authorization: `Bearer ${id}` } }); await settle(); },
    async read(id) { emit("history-request", { requestId: id, sessionId: id, accountId: "account123" }); await settle(); },
    async remove(ids = ["helper"]) { emit("delete-request", { requestId: "delete", accountId: "account123", sessionIds: ids }); await settle(); },
  };
}
const net = fixture();
for (let i = 0; i < 3; i++) net.emit("profile-request", { requestId: `wait-${i}` });
assert.equal(net.calls.length, 0);
await net.login();
assert.equal(net.events.filter(event => event.name === "profile-result").length, 3);
net.emit("profile-request", { requestId: "cached" }); assert.equal(net.calls.length, 1, "账号信息只来自原生请求");
net.route(url => new Response(JSON.stringify(historyData(new URL(url, "https://chat.deepseek.com").searchParams.get("chat_session_id")))));
await net.window.fetch("/api/v0/chat/history_messages?chat_session_id=valid"); await settle();
assert.equal(net.events.findLast(event => event.name === "history-observed").accountId, "account123");
net.route(() => new Response(JSON.stringify({ code: 0, data: { biz_code: 0 } })));
await net.remove(); assert.equal(net.calls.at(-1).url, "/api/v0/chat_session/delete");
assert.equal(net.calls.filter(call => call.url.includes("users/current")).length, 1, "删除前不重复验证登录");
const deleteUrl = "https://chat.deepseek.com/api/v0/chat_session/delete";
await net.window.fetch(new Request(deleteUrl, { method: "POST", body: JSON.stringify({ chat_session_ids: ["native-deleted"] }) })); await settle();
assert.deepEqual(net.events.findLast(event => event.name === "sessions-deleted").sessionIds, ["native-deleted"]);
const xhr = new net.context.XMLHttpRequest(); xhr.open("POST", deleteUrl); xhr.send(JSON.stringify({ chat_session_ids: ["xhr-deleted"] }));
xhr.status = 200; xhr.responseType = "json"; xhr.response = { code: 0, data: { biz_code: 0 } }; xhr.dispatchEvent(new Event("load"));
assert.deepEqual(net.events.findLast(event => event.name === "sessions-deleted").sessionIds, ["xhr-deleted"]);
await net.login("another-account"); const before = net.calls.length;
await net.remove(); await net.remove(["bad/id"]); assert.equal(net.calls.length, before, "账号不匹配或参数非法不发请求");

const expired = fixture(); await expired.login();
expired.route(() => new Response(JSON.stringify({ code: 40003, msg: "INVALID_TOKEN" }), { status: 401 }));
await expired.read("first"); await expired.read("second"); await expired.remove();
expired.emit("profile-request", { requestId: "no-revalidate" });
assert.equal(expired.calls.length, 2, "原生登录一次、历史一次；失效后零重试、零登录验证");
assert.equal(expired.events.findLast(event => event.name === "network-error").code, "AUTH_REQUIRED");
await expired.window.fetch("/api/v0/chat/completion", { method: "POST", body: '{}' });
assert.equal(expired.calls.length, 3, "原生用户请求不受插件队列阻断");
await expired.login(); expired.route(() => new Response(JSON.stringify(historyData("recovered")))); await expired.read("recovered");
assert.equal(expired.events.at(-1).name, "history-result");
expired.route(() => new Response('登录页', { status: 401 }));
await expired.window.fetch("/api/v0/users/current"); await settle();
assert.equal(expired.events.findLast(event => event.name === "request-issue").code, "AUTH_REQUIRED", "非 JSON 的登录失效响应也停止请求");
const limited = fixture(); await limited.login();
limited.route(() => new Response(JSON.stringify({ msg: "Too many requests" }), { status: 429 }));
await limited.read("limited"); await limited.remove();
assert.equal(limited.calls.length, 2); assert.equal(limited.events.findLast(event => event.name === "network-error").code, "RATE_LIMITED");
limited.emit("request-state"); limited.route(() => new Response(JSON.stringify({ code: 0, data: { biz_code: 88, biz_msg: "请求过于频繁" } })));
await limited.read("business"); assert.equal(limited.events.findLast(event => event.name === "request-issue").code, "RATE_LIMITED");
const stream = fixture(); await stream.login();
stream.route(() => new Response('data: {"code":100,"msg":"账号已被禁言"}\n\n', { headers: { "content-type": "text/event-stream" } }));
assert.match(await (await stream.window.fetch("/api/v0/chat/completion")).text(), /账号已被禁言/); await settle();
assert.equal(stream.events.findLast(event => event.name === "request-issue").code, "ACCOUNT_RESTRICTED");
const rejected = fixture(); rejected.emit("memory-context", { block: "<project_memory>本地记忆</project_memory>" });
rejected.route(() => { throw new Error("模拟网络断开"); });
await assert.rejects(rejected.window.fetch("/api/v0/chat/completion", { method: "POST", body: JSON.stringify({ prompt: "用户消息" }) }), /模拟网络断开/);
assert.equal(rejected.calls.length, 1, "改写请求失败不会重发消息");

const content = fixture(); const { context } = content; const calls = []; const links = [];
const rows = [{ sessionId: "valid", purpose: "USER", historyObserved: true, currentMessageId: 2, updatedAtMs: 1 }];
const snapshot = { ok: true, sessions: rows, memberships: [], projects: [], jobs: [], settings: {}, alerts: {} };
const stored = { conversationId: "valid", currentMessageId: 2, records: [{ messageId: 2, role: "ASSISTANT", status: "FINISHED", fragments: [] }] };
context.location = { href: "https://chat.deepseek.com/a/chat/s/valid", origin: "https://chat.deepseek.com" };
const node = () => ({ append() {}, querySelector: () => null, querySelectorAll: () => [], setAttribute() {}, remove() {} });
context.document = { createElement: node, head: node(), addEventListener() {}, querySelector: () => null,
  querySelectorAll: selector => selector.includes('a[href') ? links : [] };
context.chrome = { runtime: { getURL: path => path, onMessage: { addListener() {} }, sendMessage: async message => {
  calls.push(message);
  if (message.type === "dtw:sidebar-snapshot") return snapshot;
  if (message.type === "dtw:session-list-observe") snapshot.memoryListRequired = false;
  if (message.type === "dtw:session-history") return { ok: true, history: message.sessionId === "valid" ? stored : null };
  if (message.type === "dtw:request-issue") snapshot.alerts.issue = { code: message.code, message: message.message, untilMs: message.untilMs };
  if (message.type === "dtw:request-ready") snapshot.alerts.issue = null;
  if (message.type === "dtw:history-request-slot") return snapshot.alerts.issue ? { ok: true, blocked: true, ...snapshot.alerts.issue }
    : snapshot.settings.automationPaused && !message.userAction ? { ok: true, blocked: true, code: "PAUSED" } : { ok: true, waitMs: 0 };
  return { ok: true };
} }, storage: { local: { get: async () => ({ accountId: "account123" }), set: async () => {} } } };
const end = '  start().catch((error) => console.warn("[DeepSeek Pilot]", error));';
vm.runInContext(contentSource.replace(end, `
  globalThis.fixture = { state, refresh, handleAction, syncChangedSessions, currentHistory, observeNativeHistory, history, getAccount, toasts: [] };
  showToast = message => fixture.toasts.push(message);
  renderTree = renderMemoryButton = renderMemoryEditors = renderMessageInfo = restoreNativeSessions = () => {};
`), context);
content.emit("network-ready"); await content.login();
context.fixture.state.accountId = "account123"; context.fixture.state.snapshot = snapshot;
content.route(url => new Response(JSON.stringify(historyData(new URL(url, "https://chat.deepseek.com").searchParams.get("chat_session_id")))));
const baseline = content.calls.length;
for (let i = 0; i < 4; i++) { await context.fixture.syncChangedSessions(); await context.fixture.currentHistory(); }
assert.equal(content.calls.length, baseline, "已登记且未变化的会话不扫描、不补读");
let clicked = false; links.push({ href: "https://chat.deepseek.com/a/chat/s/valid", closest: () => null, click() { clicked = true; } });
await context.fixture.handleAction({ dataset: { action: "open-session", id: "valid" } });
assert.equal(clicked, true); assert.equal(content.calls.length, baseline, "打开会话不做额外校验");
links.length = 0; await context.fixture.handleAction({ dataset: { action: "open-session", id: "other" } });
assert.equal(context.location.href, "https://chat.deepseek.com/a/chat/s/other");
context.fixture.state.dirtySessions.add("valid"); snapshot.settings.automationPaused = true;
await context.fixture.syncChangedSessions(); assert.equal(content.calls.length, baseline);
snapshot.settings.automationPaused = false; snapshot.jobs.push({ type: "DISTILL", status: "RUNNING" });
await context.fixture.syncChangedSessions(); assert.equal(content.calls.length, baseline);
snapshot.jobs.length = 0; await context.fixture.syncChangedSessions(); await context.fixture.syncChangedSessions();
assert.equal(content.calls.length, baseline + 1, "变化的会话只补读一次");
assert.equal(calls.some(call => call.type === "dtw:history-observe"), true);
content.route(() => new Response(JSON.stringify({ code: 500, msg: "服务器繁忙" })));
context.fixture.state.dirtySessions.add("valid"); await context.fixture.syncChangedSessions(); await context.fixture.syncChangedSessions();
assert.equal(content.calls.length, baseline + 2, "读取失败不自动循环重试"); assert.match(context.fixture.toasts.at(-1), /服务器繁忙/);
await context.fixture.observeNativeHistory({ accountId: "account123", sessionId: "missing", data: { code: 100, msg: "Session does not exist" } });
assert.equal(calls.some(call => call.type === "dtw:session-delete" && call.sessionIds[0] === "missing"), true);
assert.equal(content.calls.length, baseline + 2, "原生删除通知仅更新本地");
content.route(() => new Response(JSON.stringify({ code: 40003, msg: "INVALID_TOKEN" }), { status: 401 }));
await assert.rejects(context.fixture.history("expired"), error => error.code === "AUTH_REQUIRED");
assert.equal(context.fixture.state.networkIssue.code, "AUTH_REQUIRED");
await content.login(); assert.equal(context.fixture.state.networkIssue, null, "同账号重新登录后清除失效提醒");
assert.equal((await context.fixture.getAccount()).accountId, "account123");
assert.equal(content.calls.filter(call => call.url.includes("users/current")).length, 2, "插件不额外调用账号接口");
content.emit("session-list", { accountId: "account123", sessions: [{ sessionId: "valid", createdAtMs: 100 }], hasMore: true });
await settle();
assert.deepEqual(Array.from(calls.findLast(call => call.type === "dtw:session-list-observe").sessions, row => row.sessionId), ["valid"],
  "内容脚本将本次官方列表提供给后台记忆判定");
const reports = calls.filter(call => call.type === "dtw:session-list-observe").length;
content.emit("session-list", { accountId: "other-account", sessions: [{ sessionId: "foreign" }] }); await settle();
assert.equal(calls.filter(call => call.type === "dtw:session-list-observe").length, reports);
snapshot.memoryListRequired = true; await context.fixture.refresh();
assert.equal(calls.filter(call => call.type === "dtw:session-list-observe").length, reports + 1,
  "后台重启后页面刷新重新提供官方列表，不依赖持久缓存");

// Official list pages are runtime data, replayable after the content script initializes.
const lists = fixture();
const listUrl = "https://chat.deepseek.com/api/v0/chat_session/fetch_page?lte_cursor.pinned=false&page_size=2";
const pageData = (rows, hasMore = false) => ({ code: 0, data: { biz_code: 0, biz_data: { chat_sessions: rows, has_more: hasMore } } });
const row = (id, updated_at) => ({ id, title: `官方标题 ${id}`, updated_at, pinned: false, current_message_id: 2 });
const readPage = async (rows, url = listUrl, hasMore = false, account = "account123") => {
  lists.route(() => new Response(JSON.stringify(pageData(rows, hasMore))));
  await lists.window.fetch(url, { headers: { Authorization: `Bearer ${account}` } }); await settle();
};
const liveIds = () => lists.events.findLast(event => event.name === "session-list")?.sessions.map(item => item.sessionId);
await readPage([row("live", 20), row("second", 10)], listUrl, true);
assert.equal(liveIds(), undefined, "账号尚未确认时不对外发布会话列表");
await lists.login();
assert.deepEqual(liveIds(), ["live", "second"], "登录信息到达后回放已收到的官方列表");
lists.route(() => new Response(JSON.stringify(pageData([row("older", 5)]))));
lists.emit("session-list-more", { requestId: "more", accountId: "account123" }); await settle();
assert.match(lists.calls.at(-1).url, /lte_cursor.updated_at=10/);
assert.deepEqual(liveIds(), ["live", "second", "older"], "分页补充旧会话，不替换前一页");
assert.equal(lists.events.findLast(event => event.name === "session-list").hasMore, false);
await readPage([row("second", 30)]);
assert.deepEqual(liveIds(), ["second"], "首屏重新返回时替换旧加载结果，旧缓存不能补回已消失的会话");
let finishOld;
lists.route(() => new Promise(resolve => { finishOld = resolve; }));
const stale = lists.window.fetch(listUrl, { headers: { Authorization: "Bearer account123" } });
await readPage([row("newest", 40)]);
finishOld(new Response(JSON.stringify(pageData([row("stale", 1)])))); await stale; await settle();
assert.deepEqual(liveIds(), ["newest"], "较旧请求迟到不会覆盖新列表");
const listXhr = new lists.context.XMLHttpRequest(); listXhr.open("GET", listUrl); listXhr.setRequestHeader("Authorization", "Bearer account123"); listXhr.send();
listXhr.status = 200; listXhr.responseType = "json"; listXhr.response = pageData([row("xhr-live", 50)]); listXhr.dispatchEvent(new Event("load"));
assert.deepEqual(liveIds(), ["xhr-live"], "XHR 原生列表也作为官方数据来源");
lists.emit("session-list-request"); assert.deepEqual(liveIds(), ["xhr-live"]);
await readPage([row("other-account-chat", 60)], listUrl, false, "another-account");
assert.deepEqual(liveIds(), ["xhr-live"], "另一账号的提前响应不会混入当前列表");
await lists.login("another-account");
assert.deepEqual(liveIds(), ["other-account-chat"]);
assert.equal(lists.events.findLast(event => event.name === "session-list").accountId, "another-account");
await readPage([], listUrl, false, "another-account"); assert.deepEqual(liveIds(), [], "有效空列表清空显示来源");
await readPage([row("remain", 70)], listUrl, false, "another-account");
lists.route(() => new Response(JSON.stringify({ code: 500, msg: "服务器繁忙" })));
await lists.window.fetch(listUrl); await settle();
assert.deepEqual(liveIds(), ["remain"], "错误响应不被当作空列表");
lists.route(() => new Response(JSON.stringify(pageData([{ id: "bad/id" }]))));
await lists.window.fetch(listUrl); await settle(); assert.deepEqual(liveIds(), ["remain"]);
lists.route(() => new Response(JSON.stringify({ code: 0, data: { biz_code: 0 } })));
lists.emit("delete-request", { requestId: "confirmed-delete", accountId: "another-account", sessionIds: ["remain"] }); await settle();
assert.deepEqual(liveIds(), []);
await readPage([row("remain", 1)], `${listUrl}&lte_cursor.updated_at=70`, false, "another-account");
assert.deepEqual(liveIds(), [], "已确认删除的 ID 不会被迟到分页补回");
const switching = fixture(); await switching.login();
switching.route(() => new Response(JSON.stringify(pageData([row("old-account", 10)], true))));
await switching.window.fetch(listUrl, { headers: { Authorization: "Bearer account123" } }); await settle();
let finishMore;
switching.route(() => new Promise(resolve => { finishMore = resolve; }));
switching.emit("session-list-more", { requestId: "old-more", accountId: "account123" });
await switching.login("another-account");
finishMore(new Response(JSON.stringify(pageData([row("private-old-page", 5)])))); await settle();
assert.match(switching.events.findLast(event => event.name === "network-error").error, /账号已切换/);
assert.equal(switching.events.some(event => event.name === "session-list" && event.accountId === "another-account"
  && event.sessions.some(item => item.sessionId === "private-old-page")), false, "切换账号期间的分页结果不会改用新账号身份发布");
console.log(JSON.stringify({ ok: true, checks: "passive login/history, no rescan, targeted sync, deletion, zero auth retries, pause, rate limit, streamed restriction, native request preservation" }));
