import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
vm.runInThisContext(await readFile(path.join(here, "..", "core", "logic", "history-core.js"), "utf8"), { filename: "history-core.js" });

const sessionId = "6e8a8869-77da-4375-8df6-0dadd637b786";
const response = {
  data: {
    biz_data: {
      chat_session: { id: sessionId },
      chat_messages: [
        {
          message_id: "m1",
          role: "USER",
          fragments: [{ type: "REQUEST", content: "用户问题" }],
        },
        {
          message_id: "m2",
          role: "ASSISTANT",
          fragments: [
            { type: "THINK", content: "隐藏思考" },
            { type: "RESPONSE", content: "最终回答" },
          ],
        },
      ],
    },
  },
};

const parsed = globalThis.DTWHistory.parseHistoryResponse(response, sessionId);
assert.equal(parsed.ok, true);
assert.equal(parsed.source, "history-api");
assert.equal(parsed.captureIncomplete, false);
assert.equal(parsed.messages.length, 2);
assert.equal(parsed.messages[0].id, `${sessionId}:m1`);
assert.equal(parsed.messages[0].role, "user");
assert.equal(parsed.messages[1].role, "assistant");
assert.equal(parsed.messages[1].text, "最终回答");
assert.throws(() => globalThis.DTWHistory.parseHistoryResponse(response, "wrong-session"), /错误的会话/);
assert.throws(() => globalThis.DTWHistory.parseHistoryResponse({ data: { biz_data: {} } }, sessionId), /会话 ID/);
assert.throws(() => globalThis.DTWHistory.parseHistoryResponse({
  data: { biz_data: { chat_session: { id: sessionId }, chat_messages: [{ role: "USER" }] } },
}, sessionId), /无 ID 消息/);

const branched = globalThis.DTWHistory.parseHistoryResponse({ data: { biz_data: {
  chat_session: { id: sessionId, title: "新版标题", current_message_id: 4, updated_at: 1790247327.5 },
  chat_messages: [
    { message_id: 1, parent_id: null, role: "USER", inserted_at: 1790247320.25,
      fragments: [{ fragment_id: 1, type: "REQUEST", content: "原问题" }] },
    { message_id: 2, parent_id: 1, role: "ASSISTANT", accumulated_token_usage: 40,
      fragments: [{ fragment_id: 2, type: "RESPONSE", content: "旧回答" }] },
    { message_id: 3, parent_id: 1, role: "USER", fragments: [{ type: "REQUEST", content: "编辑后问题" }] },
    { message_id: 4, parent_id: 3, role: "ASSISTANT", accumulated_token_usage: 72,
      fragments: [{ type: "RESPONSE", content: "新回答" }] },
  ],
} } }, sessionId);
assert.equal(branched.currentMessageId, 4);
assert.equal(branched.title, "新版标题");
assert.equal(branched.updatedAtMs, 1790247327500);
assert.equal(branched.records[0].insertedAtMs, 1790247320250);
assert.equal(branched.records[3].parentId, 3);
assert.equal(branched.records[3].accumulatedTokenUsage, 72);
const usageBranch = [10, 24, null, 50, 42].map((accumulatedTokenUsage) => ({ accumulatedTokenUsage }));
assert.equal(DTWHistory.localTokenUsage(usageBranch, 0), 10);
assert.equal(DTWHistory.localTokenUsage(usageBranch, 1), 14);
assert.equal(DTWHistory.localTokenUsage(usageBranch, 2), null);
assert.equal(DTWHistory.localTokenUsage(usageBranch, 3), null);
assert.equal(DTWHistory.localTokenUsage(usageBranch, 4), null);

const sessions = [
  { sessionId: "older", updatedAtMs: 1000 },
  { sessionId: "unknown", updatedAtMs: null },
  { sessionId: "newer", updatedAtMs: 3000 },
  { sessionId: "same-b", updatedAtMs: 2000 },
  { sessionId: "same-a", updatedAtMs: 2000 },
];
const ordered = globalThis.DTWHistory.sortSessionsNewestFirst(sessions, new Map([["same-b", 0], ["same-a", 1]]));
assert.deepEqual(ordered.map((entry) => entry.sessionId), ["newer", "same-b", "same-a", "older", "unknown"]);
assert.equal(sessions[0].sessionId, "older");
assert.deepEqual(globalThis.DTWHistory.sortSessionsNewestFirst([
  { sessionId: "renamed", updatedAtMs: 5000, lastMessageAtMs: 1000 },
  { sessionId: "active", updatedAtMs: 3000, lastMessageAtMs: 3000 },
]).map((entry) => entry.sessionId), ["active", "renamed"]);

assert.throws(() => DTWHistory.parseHistoryResponse({ code: 0, data: {
  biz_code: 100, biz_msg: "Chat session not found", biz_data: null,
} }, sessionId), (error) => error.code === "SESSION_NOT_FOUND");
assert.throws(() => DTWHistory.parseHistoryResponse({ code: 100, msg: "该会话不存在" }, sessionId),
  (error) => error.code === "SESSION_NOT_FOUND");
for (const msg of ["Session not found", "Session does not exist", "该会话已被删除"])
  assert.throws(() => DTWHistory.parseHistoryResponse({ code: 100, msg }, sessionId), (error) => error.code === "SESSION_NOT_FOUND");
for (const data of [
  { code: 40003, msg: "INVALID_TOKEN", data: { biz_code: 100, biz_msg: "Chat session not found" } },
  { code: 500, msg: "服务器繁忙" },
  { code: 0, data: { biz_data: null } },
]) assert.throws(() => DTWHistory.parseHistoryResponse(data, sessionId),
  (error) => error.code !== "SESSION_NOT_FOUND");
const empty = { code: 0, data: { biz_code: 0, biz_data: { chat_session: { id: sessionId }, chat_messages: [] } } };
assert.equal(DTWHistory.parseHistoryResponse(empty, sessionId, { allowEmpty: true }).ok, true);
assert.throws(() => DTWHistory.parseHistoryResponse(empty, sessionId), /没有返回可整理/);

console.log(JSON.stringify({ ok: true, assertions: 32 }, null, 2));
