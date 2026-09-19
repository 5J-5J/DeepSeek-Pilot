/** Pure validation and conversion for DeepSeek history_messages responses. */
(() => {
  "use strict";

  function fragmentText(message) {
    const fragments = Array.isArray(message?.fragments) ? message.fragments : [];
    const preferred = fragments
      .filter((fragment) => ["REQUEST", "RESPONSE"].includes(String(fragment?.type || "").toUpperCase()))
      .map((fragment) => String(fragment?.content || "").trim()).filter(Boolean);
    if (preferred.length) return preferred.join("\n\n");
    const fallback = fragments.map((fragment) => String(fragment?.content || "").trim()).filter(Boolean);
    if (fallback.length) return fallback.join("\n\n");
    return String(message?.content || "").trim();
  }

  function parseHistoryResponse(data, expectedSessionId) {
    const expected = String(expectedSessionId || "").replace(/[^a-zA-Z0-9_-]/g, "");
    if (!expected) throw new Error("缺少目标会话 ID");
    const bizData = data?.data?.biz_data;
    if (!bizData || typeof bizData !== "object") throw new Error("DeepSeek 历史接口响应缺少 biz_data");
    const sessionId = String(bizData.chat_session?.id || "").replace(/[^a-zA-Z0-9_-]/g, "");
    if (!sessionId) throw new Error("DeepSeek 历史接口响应缺少会话 ID");
    if (sessionId !== expected) throw new Error("DeepSeek 历史接口返回了错误的会话");
    if (!Array.isArray(bizData.chat_messages)) throw new Error("DeepSeek 历史接口响应缺少消息数组");

    const seen = new Set();
    const messages = [];
    for (const raw of bizData.chat_messages) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("DeepSeek 历史接口包含无效消息");
      const nativeId = String(raw.message_id || "").trim();
      if (!nativeId) throw new Error("DeepSeek 历史接口包含无 ID 消息");
      const rawRole = String(raw.role || "").toUpperCase();
      if (!["USER", "HUMAN", "ASSISTANT"].includes(rawRole)) continue;
      const role = rawRole === "ASSISTANT" ? "assistant" : "user";
      const text = fragmentText(raw);
      const id = `${sessionId}:${nativeId}`;
      if (!text || seen.has(id)) continue;
      seen.add(id);
      messages.push({ id, role, text, revision: 1 });
    }
    if (!messages.length) throw new Error("DeepSeek 历史接口没有返回可整理的消息");
    return { ok: true, conversationId: sessionId, messages, captureIncomplete: false, source: "history-api", error: "" };
  }

  globalThis.DTWHistory = Object.freeze({ fragmentText, parseHistoryResponse });
})();
