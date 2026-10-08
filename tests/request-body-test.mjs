import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
const [coreSource, networkSource] = await Promise.all([
  readFile(path.join(here, "..", "core", "logic", "request-body-core.js"), "utf8"),
  readFile(path.join(here, "..", "core", "page", "page-network.js"), "utf8"),
]);

class FakeXhr {
  open(method, url) { this.method = method; this.url = url; }
  send(body) { this.sentBody = body; return "sent"; }
}

const sent = [];
const page = new EventTarget();
page.fetch = async (input, init) => {
  sent.push({ input, init });
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: { biz_data: { chat_session: { id: "session-1" }, chat_messages: [] } } }),
  };
};

const context = vm.createContext({
  console,
  window: page,
  XMLHttpRequest: FakeXhr,
  URL,
  URLSearchParams,
  Request,
  Headers,
  CustomEvent,
  EventTarget,
  Date,
  JSON,
  Object,
  Array,
  String,
  Number,
});
vm.runInContext(coreSource, context, { filename: "request-body-core.js" });
vm.runInContext(networkSource, context, { filename: "page-network.js" });

const core = context.DTWRequestBody;
assert.ok(core, "request body core should attach to globalThis");

const messagePayload = {
  messages: [
    { role: "assistant", content: "old" },
    { role: "user", content: "[DTW:req_messages] placeholder" },
  ],
};
const messageMutation = core.mutatePayload(messagePayload, {
  requestId: "req_messages",
  operation: "memory-summary",
  marker: "[DTW:req_messages]",
  prompt: "完整任务上下文",
});
assert.equal(messageMutation.changed, true);
assert.equal(messagePayload.messages[1].content, "完整任务上下文");

const nestedPayload = { data: { prompt: "[DTW:req_nested] placeholder" } };
assert.equal(core.mutatePayload(nestedPayload, {
  requestId: "req_nested",
  operation: "memory-summary",
  marker: "[DTW:req_nested]",
  prompt: "嵌套 prompt",
}).target, "data.prompt");
assert.equal(nestedPayload.data.prompt, "嵌套 prompt");

const untouched = { prompt: "普通用户消息" };
assert.equal(core.mutatePayload(untouched, {
  requestId: "req_safe",
  operation: "memory-summary",
  marker: "[DTW:req_safe]",
  prompt: "不能写入",
}).reason, "marker-mismatch");
assert.equal(untouched.prompt, "普通用户消息");

const appliedEvents = [];
page.addEventListener("dtw:network-applied", (event) => appliedEvents.push(JSON.parse(event.detail)));
page.dispatchEvent(new CustomEvent("dtw:network-arm", { detail: JSON.stringify({
  requestId: "req_fetch",
  operation: "memory-summary",
  marker: "[DTW:req_fetch]",
  prompt: "通过 fetch 写入的完整提示",
  expiresAt: Date.now() + 10000,
}) }));

await page.fetch("https://chat.deepseek.com/api/v0/chat/completion", {
  method: "POST",
  credentials: "include",
  headers: { "x-test": "kept" },
  body: JSON.stringify({ chat_session_id: "abc", prompt: "[DTW:req_fetch] visible placeholder" }),
});
assert.equal(sent.length, 1);
assert.equal(JSON.parse(sent[0].init.body).prompt, "通过 fetch 写入的完整提示");
assert.equal(sent[0].init.credentials, "include");
assert.equal(new Headers(sent[0].init.headers).get("x-test"), "kept");
assert.equal(appliedEvents[0].target, "prompt");

page.dispatchEvent(new CustomEvent("dtw:network-arm", { detail: JSON.stringify({
  requestId: "req_guard",
  operation: "memory-summary",
  marker: "[DTW:req_guard]",
  prompt: "不得写入普通请求",
  expiresAt: Date.now() + 10000,
}) }));
await page.fetch("https://chat.deepseek.com/api/v0/chat/completion", {
  method: "POST",
  body: JSON.stringify({ prompt: "普通用户消息" }),
});
assert.equal(JSON.parse(sent[1].init.body).prompt, "普通用户消息");
page.dispatchEvent(new CustomEvent("dtw:network-cancel", {
  detail: JSON.stringify({ requestId: "req_guard" }),
}));

page.dispatchEvent(new CustomEvent("dtw:network-arm", { detail: JSON.stringify({
  requestId: "req_xhr",
  operation: "memory-summary",
  marker: "[DTW:req_xhr]",
  prompt: "通过 XHR 写入的完整提示",
  expiresAt: Date.now() + 10000,
}) }));
const xhr = new FakeXhr();
xhr.open("POST", "https://chat.deepseek.com/api/v0/chat/completion");
xhr.send(JSON.stringify({ prompt: "[DTW:req_xhr] visible placeholder" }));
assert.equal(JSON.parse(xhr.sentBody).prompt, "通过 XHR 写入的完整提示");
assert.equal(appliedEvents[1].requestId, "req_xhr");

const historyResult = new Promise((resolve) => {
  page.addEventListener("dtw:history-result", (event) => resolve(JSON.parse(event.detail)), { once: true });
});
page.dispatchEvent(new CustomEvent("dtw:history-request", { detail: JSON.stringify({
  requestId: "history_1",
  sessionId: "session-1",
}) }));
const history = await historyResult;
assert.equal(history.sessionId, "session-1");
assert.match(String(sent[2].input), /history_messages\?chat_session_id=session-1/);

// --- 自动注入：纯函数 ---
const injectTarget = { prompt: "怎么继续开发" };
const injection = core.injectMemoryIntoRequest(injectTarget, "<task_memory>\n项目：X\n</task_memory>");
assert.equal(injection.changed, true);
assert.equal(injection.target, "prompt");
assert.equal(injectTarget.prompt, "<task_memory>\n项目：X\n</task_memory>\n\n怎么继续开发");

const messagesPayload = { messages: [{ role: "assistant", content: "hi" }, { role: "user", content: "继续" }] };
core.injectMemoryIntoRequest(messagesPayload, "<task_memory>块</task_memory>");
assert.equal(messagesPayload.messages[1].content, "<task_memory>块</task_memory>\n\n继续");

const invalidTarget = { prompt: "原文" };
assert.equal(core.injectMemoryIntoRequest(invalidTarget, "不是合法块").changed, false);
assert.equal(invalidTarget.prompt, "原文");
assert.equal(core.injectMemoryIntoRequest(null, "<task_memory>块</task_memory>").changed, false);

// 重复注入幂等：先剥旧块再前缀新块
const repeatTarget = { prompt: "<task_memory>旧块</task_memory>\n\n新消息" };
core.injectMemoryIntoRequest(repeatTarget, "<task_memory>新块</task_memory>");
assert.ok(!repeatTarget.prompt.includes("旧块"));
assert.equal(repeatTarget.prompt, "<task_memory>新块</task_memory>\n\n新消息");

// --- 自动注入：网络钩子 ---
const injectedEvents = [];
page.addEventListener("dtw:memory-injected", (event) => injectedEvents.push(JSON.parse(event.detail)));
page.dispatchEvent(new CustomEvent("dtw:memory-context", { detail: JSON.stringify({
  block: "<task_memory>\n项目：测试\n</task_memory>",
}) }));
await page.fetch("https://chat.deepseek.com/api/v0/chat/completion", {
  method: "POST",
  body: JSON.stringify({ prompt: "用户输入" }),
});
assert.equal(JSON.parse(sent[3].init.body).prompt, "<task_memory>\n项目：测试\n</task_memory>\n\n用户输入");
assert.equal(injectedEvents[0].target, "prompt");

// 已 armed 的维护请求走改写路径，绝不注入
page.dispatchEvent(new CustomEvent("dtw:network-arm", { detail: JSON.stringify({
  requestId: "req_no_inject",
  operation: "memory-summary",
  marker: "[DTW:req_no_inject]",
  prompt: "维护提示",
  expiresAt: Date.now() + 10000,
}) }));
await page.fetch("https://chat.deepseek.com/api/v0/chat/completion", {
  method: "POST",
  body: JSON.stringify({ prompt: "[DTW:req_no_inject] placeholder" }),
});
assert.equal(JSON.parse(sent[4].init.body).prompt, "维护提示");
assert.equal(injectedEvents.length, 1);

// 清空上下文后不再注入
page.dispatchEvent(new CustomEvent("dtw:memory-context", { detail: JSON.stringify({ block: "" }) }));
await page.fetch("https://chat.deepseek.com/api/v0/chat/completion", {
  method: "POST",
  body: JSON.stringify({ prompt: "普通消息" }),
});
assert.equal(JSON.parse(sent[5].init.body).prompt, "普通消息");

// XHR 链同样注入
page.dispatchEvent(new CustomEvent("dtw:memory-context", { detail: JSON.stringify({
  block: "<task_memory>xhr 块</task_memory>",
}) }));
const injectXhr = new FakeXhr();
injectXhr.open("POST", "https://chat.deepseek.com/api/v0/chat/completion");
injectXhr.send(JSON.stringify({ prompt: "xhr 消息" }));
assert.equal(JSON.parse(injectXhr.sentBody).prompt, "<task_memory>xhr 块</task_memory>\n\nxhr 消息");

// Armed helpers can follow a renamed chat endpoint. An unknown payload shape
// must never transmit the one-time marker unchanged.
page.dispatchEvent(new CustomEvent("dtw:memory-context", { detail: JSON.stringify({ block: "" }) }));
page.dispatchEvent(new CustomEvent("dtw:network-arm", { detail: JSON.stringify({
  requestId: "req_new_path", operation: "automation", marker: "[DTW:req_new_path]",
  prompt: "新的整理提示", expiresAt: Date.now() + 10000,
}) }));
await page.fetch("https://chat.deepseek.com/api/v0/chat/complete_v2", {
  method: "POST", body: JSON.stringify({ prompt: "[DTW:req_new_path]" }),
});
assert.equal(JSON.parse(sent.at(-1).init.body).prompt, "新的整理提示");

const sentBeforeFailure = sent.length;
const errors = [];
page.addEventListener("dtw:network-error", (event) => errors.push(JSON.parse(event.detail)));
page.dispatchEvent(new CustomEvent("dtw:network-arm", { detail: JSON.stringify({
  requestId: "req_unknown", operation: "automation", marker: "[DTW:req_unknown]",
  prompt: "不能漏出的提示", expiresAt: Date.now() + 10000,
}) }));
await assert.rejects(page.fetch("https://chat.deepseek.com/api/v0/chat/completion", {
  method: "POST", body: JSON.stringify({ unknown: "[DTW:req_unknown]" }),
}), /prompt-not-found/);
assert.equal(sent.length, sentBeforeFailure);
assert.equal(errors.at(-1).requestId, "req_unknown");

page.dispatchEvent(new CustomEvent("dtw:network-arm", { detail: JSON.stringify({
  requestId: "req_unknown_xhr", operation: "automation", marker: "[DTW:req_unknown_xhr]",
  prompt: "不能漏出的提示", expiresAt: Date.now() + 10000,
}) }));
const blockedXhr = new FakeXhr();
blockedXhr.open("POST", "https://chat.deepseek.com/api/v0/chat/complete_v2");
blockedXhr.send(JSON.stringify({ unknown: "[DTW:req_unknown_xhr]" }));
assert.equal(blockedXhr.sentBody, undefined);
assert.equal(errors.at(-1).requestId, "req_unknown_xhr");

console.log(JSON.stringify({ ok: true, assertions: 37 }, null, 2));
