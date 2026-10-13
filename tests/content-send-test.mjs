import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../core/content/workbench.js", import.meta.url), "utf8");
const listeners = new Map();
const requests = [];
const sent = [];
let nativeSends = 0;
let nativeResult = false;
const editor = { value: "新会话的首条问题", contains: () => false };
const target = { closest: () => null };
const button = { contains: node => node === target };
const location = { href: "https://chat.deepseek.com/a/chat" };
const context = vm.createContext({ window: new EventTarget(), location, crypto: globalThis.crypto,
  CustomEvent, URL, setTimeout, clearTimeout, console,
  document: { createElement: () => ({}), head: { append() {} },
    querySelectorAll: () => [],
    addEventListener: (name, fn) => listeners.set(name, fn) },
  chrome: { runtime: { getURL: path => path, onMessage: { addListener() {} },
    sendMessage: async message => {
      requests.push(message);
      return nativeResult ? { ok: true, native: true }
        : { ok: true, jobId: "first-send", prompt: `<project_memory>\n## 个人记忆\n### 偏好\n1. 先给结论\n</project_memory>\n\n<current_question>\n${message.rawInput}\n</current_question>` };
    } } },
  testEditor: editor, testButton: button,
  recordSend: prompt => sent.push(prompt), recordNative: () => { nativeSends++; },
});
const end = '  start().catch((error) => console.warn("[DeepSeek 项目工作台]", error));';
assert.ok(source.includes(end));
vm.runInContext(source.replace(end, `
  globalThis.fixture = { state, toasts: [] };
  findEditor = () => testEditor;
  nativeSend = () => testButton;
  doProjectSend = async (_editor, prompt) => recordSend(prompt);
  submit = async () => recordNative();
  showToast = message => fixture.toasts.push(message);
  renderMemoryButton = () => {};
`), context);
Object.assign(context.fixture.state, { accountId: "account123", snapshot: {
  settings: { memoryModeDefault: false, showPersonalMemory: false, showProjectMemory: false },
  memberships: [], sessions: [], memories: [],
} });
const event = (eventTarget = target) => ({ target: eventTarget, key: "Enter", prevented: false,
  preventDefault() { this.prevented = true; }, stopImmediatePropagation() {} });
const settle = () => new Promise(resolve => setImmediate(resolve));

const click = event();
listeners.get("click")(click);
await settle();
assert.equal(click.prevented, true, "项目记忆默认关闭时，点击发送仍准备个人记忆");
assert.equal(requests[0].type, "dtw:prepare-send");
assert.equal(requests[0].sessionId, "");
assert.equal(requests[0].rawInput, editor.value);
assert.match(sent[0], /## 个人记忆\n### 偏好\n1\. 先给结论/);

const enter = event(editor);
listeners.get("keydown")(enter);
await settle();
assert.equal(enter.prevented, true);
assert.equal(sent.length, 2, "回车发送也走相同注入流程");
nativeResult = true;
location.href = "https://chat.deepseek.com/a/chat/s/normal";
context.fixture.state.snapshot.sessions.push({ sessionId: "normal", purpose: "USER", hasUserMessage: true });
const secondTurn = event(editor);
listeners.get("keydown")(secondTurn);
await settle();
assert.equal(nativeSends, 1, "首条发送后无项目记忆时沿用原生发送");
assert.equal(requests.at(-1).sessionId, "normal");
assert.equal(sent.length, 2, "后续轮次不重复发送带个人记忆的提示");

location.href = "https://chat.deepseek.com/a/chat/s/helper";
context.fixture.state.snapshot.sessions.push({ sessionId: "helper", purpose: "CLASSIFY" });
const beforeHelper = requests.length;
const helper = event();
listeners.get("click")(helper);
listeners.get("keydown")(event(editor));
await settle();
assert.equal(helper.prevented, false);
assert.equal(requests.length, beforeHelper, "自动化会话不注入个人记忆");
console.log(JSON.stringify({ ok: true }));
