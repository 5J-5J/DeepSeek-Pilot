/** Route switches use recent history from memory instead of waiting for a background round-trip. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../core/content/workbench.js", import.meta.url), "utf8");
const location = { href: "https://chat.deepseek.com/chat/s/first" };
const context = vm.createContext({ window: new EventTarget(), location, crypto: globalThis.crypto,
  CustomEvent, URL, setTimeout, clearTimeout, console,
  document: { createElement: () => ({}), head: { append() {} },
    querySelectorAll: () => [], addEventListener() {} },
  chrome: { runtime: { getURL: path => path, onMessage: { addListener() {} }, sendMessage: async () => ({ ok: true }) },
    storage: { local: { get: async () => ({}), set: async () => {} } } } });

const end = '  start().catch((error) => console.warn("[DeepSeek Pilot]", error));';
assert.ok(source.includes(end));
vm.runInContext(source.replace(end, `
  let historyCalls = 0;
  const fetched = [];
  let renderResult = true;
  globalThis.fixture = { state, syncRoute, rememberHistory, fetched,
    historyCalls: () => historyCalls, setRender: (value) => { renderResult = value; } };
  renderTree = () => {};
  renderMemoryButton = () => {};
  renderMessageInfo = () => renderResult;
  currentHistory = async () => { historyCalls++; return null; };
  history = async (sessionId) => { fetched.push(sessionId); return { conversationId: sessionId, records: [] }; };
`), context);

const { state, syncRoute, rememberHistory, fetched, historyCalls, setRender } = context.fixture;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
state.snapshot = { settings: { showMessageTokens: true }, memberships: [], sessions: [], projects: [], memories: [], jobs: [] };
state.accountId = "cache-account";

rememberHistory({ conversationId: "second", records: [] });
assert.equal(state.lastHistory, null, "非当前会话只进缓存，不覆盖当前渲染");

syncRoute();
assert.equal(state.lastHistory, null);
assert.equal(state.messageInfoPending, true, "没有缓存时标记待渲染");
assert.equal(historyCalls(), 1, "当前会话仍会补读本地历史（验证流程跑到）");

location.href = "https://chat.deepseek.com/chat/s/second";
syncRoute();
assert.equal(state.lastHistory?.conversationId, "second", "切回最近会话时立即使用内存缓存");
assert.equal(state.messageInfoPending, false);

location.href = "https://chat.deepseek.com/chat/s/third";
syncRoute();
assert.equal(state.lastHistory, null, "没有缓存的会话不显示旧会话的数据");
assert.equal(state.messageInfoPending, true);

// Metadata enabled but labels still missing: fetch the conversation once instead of waiting for the idle fallback.
state.snapshot.memberships = [{ sessionId: "project-ok", projectId: "p1" }, { sessionId: "project-stale", projectId: "p1" }];
location.href = "https://chat.deepseek.com/chat/s/project-ok";
setRender(true); syncRoute(); await wait(250);
assert.deepEqual([...fetched], [], "标签已渲染时不再重复请求");

location.href = "https://chat.deepseek.com/chat/s/project-stale";
setRender(false); syncRoute(); await wait(250);
assert.deepEqual([...fetched], ["project-stale"], "标签缺失时立即补读历史");

console.log(JSON.stringify({ ok: true, checks: "recent history cache renders on route switch; missing labels fetch once" }));
