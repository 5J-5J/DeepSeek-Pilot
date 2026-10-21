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
  globalThis.fixture = { state, syncRoute, rememberHistory, historyCalls: () => historyCalls };
  renderTree = () => {};
  renderMemoryButton = () => {};
  renderMessageInfo = () => true;
  currentHistory = async () => { historyCalls++; return null; };
`), context);

const { state, syncRoute, rememberHistory, historyCalls } = context.fixture;
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

console.log(JSON.stringify({ ok: true, checks: "recent history cache renders on route switch" }));
