/** Offline rendering regression: attachment-only requests must not break later token labels. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const root = process.env.DTW_BROWSER === "firefox" ? "firefox" : "core";
const [content, history, display] = await Promise.all(["content/workbench.js", "logic/history-core.js", "logic/memory-display.js"]
  .map(name => readFile(new URL(`../${root}/${name}`, import.meta.url), "utf8")));
const startCall = '  start().catch((error) => console.warn("[DeepSeek Pilot]", error));';
assert.ok(content.includes(startCall));

function fixture(texts, emptyFragments = [{ type: "REQUEST", content: "" }]) {
  const labels = [];
  const nodes = texts.map(([role, text, files = []]) => ({
    role, text, files, nextElementSibling: null,
    get textContent() { return this.files.join("") + this.text; },
    matches: () => false, querySelector: () => null,
    cloneNode() {
      const parts = [...this.files.map(textContent => ({ textContent })), { textContent: this.text }];
      return { textContent: this.textContent, querySelectorAll: selector => selector === "*" ? parts : [] };
    },
    after(label) { this.nextElementSibling = label; label.anchor = this; label.isConnected = true; },
  }));
  const createElement = () => {
    const node = { className: "", textContent: "", isConnected: false,
      remove() { this.isConnected = false; if (this.anchor?.nextElementSibling === this) this.anchor.nextElementSibling = null; } };
    node.classList = { contains: name => node.className.split(" ").includes(name) };
    labels.push(node); return node;
  };
  const runtime = { getURL: path => path, onMessage: { addListener() {} } };
  const context = vm.createContext({ window: new EventTarget(), location: { href: "https://chat.deepseek.com/chat/s/attachments" },
    URL, setTimeout, clearTimeout, console, fixtureNodes: nodes,
    document: { createElement, head: { append() {} }, addEventListener() {},
      querySelectorAll: selector => selector === ".dtw-message-meta" ? labels.filter(label => label.isConnected) : [] },
    chrome: { runtime }, browser: { runtime } });
  vm.runInContext(history, context); vm.runInContext(display, context);
  vm.runInContext(content.replace(startCall, `
    globalThis.fixture = { state, renderMessageInfo };
    messageNodes = () => fixtureNodes;
    messageRole = node => node.role;
    isGenerating = () => false;
  `), context);
  const parsed = context.DTWHistory.parseHistoryResponse({ data: { biz_data: {
    chat_session: { id: "attachments", current_message_id: texts.length },
    chat_messages: texts.map(([role, text], index) => ({ message_id: index + 1, parent_id: index ? index : null,
      role, status: "FINISHED", inserted_at: 100000 + index, accumulated_token_usage: (index + 1) * 100,
      fragments: role === "USER" && !text.trim() ? emptyFragments : [{ type: role === "USER" ? "REQUEST" : "RESPONSE", content: text }] })),
  } } }, "attachments");
  const { state, renderMessageInfo } = context.fixture;
  state.snapshot = { settings: { showMessageTokens: true }, sessions: [], memberships: [{ sessionId: "attachments", projectId: "project" }] };
  state.lastHistory = parsed;
  return { state, renderMessageInfo, nodes, parsed, labels: () => labels.filter(label => label.isConnected) };
}

const turns = [
  ["USER", "先分析需求"], ["ASSISTANT", "第一轮回答"],
  ["USER", "", ["报告.pdf 25 KB", "数据.csv 12 KB"]], ["ASSISTANT", "文件已收到"],
  ["USER", "继续分析"], ["ASSISTANT", "分析结果"],
];
for (const fragments of [[], [{ type: "REQUEST", content: "" }], [{ type: "REQUEST", content: " \n " }]]) {
  const f = fixture(turns, fragments);
  assert.equal(f.parsed.records.length, 6, "无正文用户消息仍保留在完整分支中");
  assert.equal(f.renderMessageInfo(), true, "纯附件消息不能让整条分支失去对齐");
  assert.equal(f.labels().length, 6, "附件消息前后的时间与 token 信息均显示");
  assert.match(f.labels()[5].textContent, /本次 100 tokens.*累计 600 tokens/);
  assert.equal(f.nodes[2].textContent, "报告.pdf 25 KB数据.csv 12 KB", "附件卡片保持原样");
  f.renderMessageInfo();
  assert.equal(f.labels().length, 6, "重复渲染不增加重复标签");
  f.state.snapshot.settings.showMessageTokens = false; f.renderMessageInfo();
  assert.equal(f.labels().length, 0);
  f.state.snapshot.settings.showMessageTokens = true; f.renderMessageInfo();
  assert.equal(f.labels().length, 6);
  f.nodes[4].text = "另一个分支的问题";
  assert.equal(f.renderMessageInfo(), false);
  assert.equal(f.labels().length, 4, "后续文字不匹配时仍停止标注，避免串用其他分支的 token");
  f.nodes[0].text = "最早一轮已切换分支"; f.renderMessageInfo();
  assert.equal(f.labels().length, 0, "纯附件消息不能恢复此前已失配的分支");
}
const firstFile = fixture(turns.slice(2));
assert.equal(firstFile.renderMessageInfo(), true, "首条消息仅有文件时也能正常对齐");
assert.equal(firstFile.labels().length, 4);
console.log(`${root}: attachment-only token labels passed, including later replies, first-message files, display toggles and branch protection.`);
