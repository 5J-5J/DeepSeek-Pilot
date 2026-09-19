/**
 * Runs in the page MAIN world. It only mutates one explicitly armed request
 * whose visible placeholder contains the matching request id.
 */
(() => {
  "use strict";
  if (window.__dtwNetworkPatched) return;
  window.__dtwNetworkPatched = true;

  const Core = globalThis.DTWRequestBody;
  if (!Core) {
    window.dispatchEvent(new CustomEvent("dtw:network-error", {
      detail: JSON.stringify({ requestId: "", error: "请求体改写核心未加载" }),
    }));
    return;
  }

  const TARGET_PATHS = ["/api/v0/chat/completion", "/api/v0/chat/edit_message"];
  let armedCommand = null;

  const emit = (name, detail) => window.dispatchEvent(new CustomEvent(name, {
    detail: JSON.stringify(detail),
  }));

  function parseDetail(event) {
    try {
      return typeof event.detail === "string" ? JSON.parse(event.detail) : event.detail;
    } catch {
      return null;
    }
  }

  function isTargetUrl(url) {
    return TARGET_PATHS.some((path) => String(url || "").includes(path));
  }

  function requestUrl(input) {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.toString();
    if (input instanceof Request) return input.url;
    return "";
  }

  function findAuthToken() {
    try {
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (!key || !/token|auth|session/i.test(key)) continue;
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        if (raw.trim().startsWith("{")) {
          try {
            const value = JSON.parse(raw);
            const token = value.token || value.accessToken || value.access_token || value.user_token || value.user?.token;
            if (typeof token === "string" && token.length > 20) return token.replace(/^Bearer\s+/i, "");
          } catch { /* Ignore unrelated storage values. */ }
        } else if (/token/i.test(key) && raw.length > 20) {
          return raw.replace(/^Bearer\s+/i, "").replace(/^"|"$/g, "");
        }
      }
      const cookie = document.cookie.split("; ")
        .find((row) => /^(user_token|token)=/.test(row))?.split("=").slice(1).join("=");
      return cookie ? decodeURIComponent(cookie).replace(/^Bearer\s+/i, "") : "";
    } catch {
      return "";
    }
  }

  function failCommand(error, requestId = armedCommand?.requestId || "") {
    if (armedCommand?.requestId === requestId) armedCommand = null;
    emit("dtw:network-error", { requestId, error: String(error?.message || error || "请求体改写失败") });
  }

  function currentCommand() {
    if (!armedCommand) return null;
    if (armedCommand.expiresAt && Date.now() > armedCommand.expiresAt) {
      failCommand("请求体改写指令已过期", armedCommand.requestId);
      return null;
    }
    return armedCommand;
  }

  function mutateBody(bodyText, url) {
    const command = currentCommand();
    if (!command || !bodyText) return null;
    let payload;
    try {
      payload = JSON.parse(bodyText);
    } catch {
      throw new Error("DeepSeek 请求体不是可改写的 JSON");
    }
    const mutation = Core.mutatePayload(payload, command);
    if (!mutation.changed) {
      if (mutation.reason === "marker-mismatch") return null;
      throw new Error(`无法定位 DeepSeek 请求中的用户提示词（${mutation.reason}）`);
    }
    armedCommand = null;
    emit("dtw:network-applied", {
      requestId: mutation.requestId,
      operation: mutation.operation,
      target: mutation.target,
      promptChars: mutation.promptChars,
      url: String(url || ""),
    });
    return JSON.stringify(mutation.payload);
  }

  window.addEventListener("dtw:network-arm", (event) => {
    const command = Core.normalizeCommand(parseDetail(event));
    if (!command) {
      emit("dtw:network-error", { requestId: "", error: "请求体改写指令不合法" });
      return;
    }
    armedCommand = command;
    emit("dtw:network-armed", {
      requestId: command.requestId,
      operation: command.operation,
      expiresAt: command.expiresAt,
    });
  });

  window.addEventListener("dtw:network-cancel", (event) => {
    const detail = parseDetail(event);
    if (detail?.requestId && armedCommand?.requestId === detail.requestId) armedCommand = null;
  });

  const originalFetch = window.fetch;
  window.addEventListener("dtw:history-request", async (event) => {
    const detail = parseDetail(event);
    const requestId = String(detail?.requestId || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 160);
    const sessionId = String(detail?.sessionId || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 160);
    if (!requestId || !sessionId || typeof originalFetch !== "function") {
      emit("dtw:network-error", { requestId, error: "历史消息请求参数不合法" });
      return;
    }
    const headers = new Headers({ Accept: "application/json", "Content-Type": "application/json" });
    const token = findAuthToken();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    try {
      const url = `/api/v0/chat/history_messages?chat_session_id=${encodeURIComponent(sessionId)}`;
      let response = await originalFetch.call(window, url, { method: "GET", headers, credentials: "include" });
      if (token && [401, 403].includes(response?.status)) {
        headers.delete("Authorization");
        response = await originalFetch.call(window, url, { method: "GET", headers, credentials: "include" });
      }
      if (!response?.ok) throw new Error(`DeepSeek 历史接口返回 HTTP ${response?.status || 0}`);
      const data = await response.json();
      emit("dtw:history-result", { requestId, sessionId, data });
    } catch (error) {
      emit("dtw:network-error", { requestId, error: String(error?.message || error || "读取历史消息失败") });
    }
  });

  if (typeof originalFetch === "function") {
    window.fetch = async function dtwPatchedFetch(input, init) {
      const url = requestUrl(input);
      if (!isTargetUrl(url) || !currentCommand()) return originalFetch.apply(this, arguments);
      const commandId = armedCommand.requestId;
      let bodyText = "";
      try {
        if (typeof init?.body === "string") bodyText = init.body;
        else if (init?.body instanceof URLSearchParams) bodyText = init.body.toString();
        else if (input instanceof Request) bodyText = await input.clone().text();
        if (!bodyText) return originalFetch.apply(this, arguments);
        const nextBody = mutateBody(bodyText, url);
        if (!nextBody) return originalFetch.apply(this, arguments);

        const sourceHeaders = init?.headers || (input instanceof Request ? input.headers : undefined);
        const headers = new Headers(sourceHeaders || {});
        headers.set("content-type", "application/json");
        const nextInit = {
          method: init?.method || (input instanceof Request ? input.method : "POST"),
          headers,
          body: nextBody,
          credentials: init?.credentials || (input instanceof Request ? input.credentials : undefined),
          cache: init?.cache || (input instanceof Request ? input.cache : undefined),
          mode: init?.mode || (input instanceof Request ? input.mode : undefined),
          redirect: init?.redirect || (input instanceof Request ? input.redirect : undefined),
          referrer: init?.referrer || (input instanceof Request ? input.referrer : undefined),
          referrerPolicy: init?.referrerPolicy || (input instanceof Request ? input.referrerPolicy : undefined),
          keepalive: init?.keepalive ?? (input instanceof Request ? input.keepalive : undefined),
          integrity: init?.integrity || (input instanceof Request ? input.integrity : undefined),
          signal: init?.signal || (input instanceof Request ? input.signal : undefined),
        };
        const nextInput = input instanceof Request ? input.url : input;
        return originalFetch.call(this, nextInput, nextInit);
      } catch (error) {
        failCommand(error, commandId);
        throw error;
      }
    };
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function dtwPatchedOpen(method, url) {
    this.__dtwRequestUrl = String(url || "");
    return originalOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function dtwPatchedSend(body) {
    const url = this.__dtwRequestUrl || "";
    if (!isTargetUrl(url) || !currentCommand()) return originalSend.call(this, body);
    const commandId = armedCommand.requestId;
    try {
      const bodyText = typeof body === "string" ? body
        : body instanceof URLSearchParams ? body.toString() : "";
      if (!bodyText) return originalSend.call(this, body);
      const nextBody = mutateBody(bodyText, url);
      return originalSend.call(this, nextBody || body);
    } catch (error) {
      failCommand(error, commandId);
      return undefined;
    }
  };

  emit("dtw:network-ready", { ready: true });
})();
