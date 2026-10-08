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
    if (!bizData || typeof bizData !== "object") {
      throw new Error(`DeepSeek 历史接口响应缺少 biz_data：${JSON.stringify(data).slice(0, 200)}`);
    }
    const sessionId = String(bizData.chat_session?.id || "").replace(/[^a-zA-Z0-9_-]/g, "");
    if (!sessionId) throw new Error("DeepSeek 历史接口响应缺少会话 ID");
    if (sessionId !== expected) throw new Error("DeepSeek 历史接口返回了错误的会话");
    if (!Array.isArray(bizData.chat_messages)) throw new Error("DeepSeek 历史接口响应缺少消息数组");

    const seen = new Set();
    const messages = [];
    const records = [];
    for (const raw of bizData.chat_messages) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("DeepSeek 历史接口包含无效消息");
      const nativeId = String(raw.message_id || "").trim();
      if (!nativeId) throw new Error("DeepSeek 历史接口包含无 ID 消息");
      const rawRole = String(raw.role || "").toUpperCase();
      if (!["USER", "HUMAN", "ASSISTANT"].includes(rawRole)) continue;
      const role = rawRole === "ASSISTANT" ? "assistant" : "user";
      const text = fragmentText(raw);
      const id = `${sessionId}:${nativeId}`;
      const messageId = Number(raw.message_id);
      if (Number.isInteger(messageId)) records.push({
        messageId,
        parentId: Number.isInteger(raw.parent_id) ? raw.parent_id : null,
        role: role.toUpperCase(),
        status: String(raw.status || ""),
        insertedAtMs: Number.isFinite(raw.inserted_at) ? Math.round(raw.inserted_at * 1000) : null,
        accumulatedTokenUsage: Number.isFinite(raw.accumulated_token_usage) ? raw.accumulated_token_usage : null,
        fragments: (Array.isArray(raw.fragments) ? raw.fragments : []).map((fragment) => ({
          fragmentId: Number.isInteger(fragment.fragment_id) ? fragment.fragment_id : null,
          type: String(fragment.type || "").toUpperCase(), content: String(fragment.content || ""),
          elapsedSecs: Number.isFinite(fragment.elapsed_secs) ? fragment.elapsed_secs : null,
        })),
      });
      if (!text || seen.has(id)) continue;
      seen.add(id);
      messages.push({ id, role, text, revision: 1 });
    }
    if (!messages.length) throw new Error("DeepSeek 历史接口没有返回可整理的消息");
    return { ok: true, conversationId: sessionId, messages, records,
      currentMessageId: Number.isInteger(bizData.chat_session.current_message_id) ? bizData.chat_session.current_message_id : null,
      title: String(bizData.chat_session.title || ""),
      updatedAtMs: Number.isFinite(bizData.chat_session.updated_at) ? Math.round(bizData.chat_session.updated_at * 1000) : null,
      captureIncomplete: false, source: "history-api", error: "" };
  }

  function sortSessionsNewestFirst(sessions, nativeOrder = new Map()) {
    return [...sessions].sort((a, b) => {
      const aTime = Number.isFinite(a.lastMessageAtMs) ? a.lastMessageAtMs : (Number.isFinite(a.updatedAtMs) ? a.updatedAtMs : 0);
      const bTime = Number.isFinite(b.lastMessageAtMs) ? b.lastMessageAtMs : (Number.isFinite(b.updatedAtMs) ? b.updatedAtMs : 0);
      return bTime - aTime || (nativeOrder.get(a.sessionId) ?? Infinity) - (nativeOrder.get(b.sessionId) ?? Infinity)
        || String(a.sessionId).localeCompare(String(b.sessionId));
    });
  }

  function localTokenUsage(branch, index) {
    const total = branch[index]?.accumulatedTokenUsage;
    const previous = index === 0 ? 0 : branch[index - 1]?.accumulatedTokenUsage;
    return Number.isFinite(total) && Number.isFinite(previous) && total >= previous ? total - previous : null;
  }

  globalThis.DTWHistory = Object.freeze({ fragmentText, parseHistoryResponse, sortSessionsNewestFirst, localTokenUsage });
})();
