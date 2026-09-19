import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
vm.runInThisContext(await readFile(path.join(here, "history-core.js"), "utf8"), { filename: "history-core.js" });

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

console.log(JSON.stringify({ ok: true, assertions: 11 }, null, 2));
