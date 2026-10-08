/**
 * Pure helpers for replacing the prompt in a DeepSeek request payload.
 * Shared by the MAIN-world network hook and Node regression tests.
 */
(() => {
  "use strict";

  function resolveMessageArray(payload) {
    if (Array.isArray(payload?.messages)) return payload.messages;
    if (Array.isArray(payload?.data?.messages)) return payload.data.messages;
    if (Array.isArray(payload?.chat?.messages)) return payload.chat.messages;
    return null;
  }

  function findLastUserMessage(messages) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      const role = String(message?.role || message?.author || "").toLowerCase();
      if (role === "user" || role === "human") return message;
    }
    return null;
  }

  function extractMessageText(message) {
    if (!message) return "";
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      return message.content.map((part) => {
        if (typeof part === "string") return part;
        return typeof part?.text === "string" ? part.text : "";
      }).filter(Boolean).join("\n");
    }
    return typeof message.prompt === "string" ? message.prompt : "";
  }

  function setMessageText(message, text) {
    if (typeof message.content === "string" || message.content == null) {
      message.content = text;
      return;
    }
    if (Array.isArray(message.content)) {
      const nonTextParts = message.content.filter((part) =>
        typeof part === "object" && part && typeof part.text !== "string");
      message.content = [{ type: "text", text }, ...nonTextParts];
      return;
    }
    if (typeof message.prompt === "string") {
      message.prompt = text;
      return;
    }
    message.content = text;
  }

  function resolvePromptTarget(payload) {
    const messages = resolveMessageArray(payload);
    if (messages?.length) {
      const message = findLastUserMessage(messages);
      if (message) {
        return {
          kind: "messages",
          get: () => extractMessageText(message),
          set: (text) => setMessageText(message, text),
        };
      }
    }
    for (const [owner, key, kind] of [
      [payload, "prompt", "prompt"],
      [payload?.data, "prompt", "data.prompt"],
      [payload?.chat, "prompt", "chat.prompt"],
    ]) {
      if (owner && typeof owner[key] === "string") {
        return { kind, get: () => owner[key], set: (text) => { owner[key] = text; } };
      }
    }
    return null;
  }

  function normalizeCommand(value) {
    const requestId = String(value?.requestId || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 160);
    const operation = String(value?.operation || "").replace(/[^a-z0-9-]/g, "").slice(0, 40);
    const marker = String(value?.marker || "").slice(0, 220);
    const prompt = typeof value?.prompt === "string" ? value.prompt : "";
    const expiresAt = Number(value?.expiresAt) || 0;
    if (!requestId || !operation || !marker || !prompt || prompt.length > 60000) return null;
    if (!marker.includes(requestId)) return null;
    return { requestId, operation, marker, prompt, expiresAt };
  }

  const LEADING_MEMORY_BLOCK_RE = /^[ \t]*<task_memory>[\s\S]*?<\/task_memory>[ \t]*\n*/;

  function stripLeadingMemoryBlock(text) {
    return String(text ?? "").replace(LEADING_MEMORY_BLOCK_RE, "");
  }

  function injectMemoryIntoRequest(payload, block) {
    try {
      const blockText = String(block ?? "").trim();
      if (!blockText.startsWith("<task_memory>") || !blockText.endsWith("</task_memory>")) {
        return { changed: false, reason: "invalid-block", payload };
      }
      if (!payload || typeof payload !== "object") return { changed: false, reason: "invalid-payload", payload };
      const target = resolvePromptTarget(payload);
      if (!target) return { changed: false, reason: "prompt-not-found", payload };
      const currentText = target.get();
      if (!currentText || typeof currentText !== "string") return { changed: false, reason: "empty-prompt", payload };
      target.set(`${blockText}\n\n${stripLeadingMemoryBlock(currentText)}`);
      return { changed: true, payload, target: target.kind, blockChars: blockText.length };
    } catch {
      return { changed: false, reason: "inject-failed", payload };
    }
  }

  function mutatePayload(payload, commandValue) {
    const command = normalizeCommand(commandValue);
    if (!payload || typeof payload !== "object") return { changed: false, reason: "invalid-payload", payload };
    if (!command) return { changed: false, reason: "invalid-command", payload };
    const target = resolvePromptTarget(payload);
    if (!target) return { changed: false, reason: "prompt-not-found", payload };
    const currentText = target.get();
    if (!currentText.includes(command.marker)) return { changed: false, reason: "marker-mismatch", payload };
    target.set(command.prompt);
    return {
      changed: true,
      payload,
      target: target.kind,
      requestId: command.requestId,
      operation: command.operation,
      promptChars: command.prompt.length,
    };
  }

  globalThis.DTWRequestBody = Object.freeze({
    resolveMessageArray,
    findLastUserMessage,
    extractMessageText,
    setMessageText,
    resolvePromptTarget,
    normalizeCommand,
    mutatePayload,
    stripLeadingMemoryBlock,
    injectMemoryIntoRequest,
  });
})();
