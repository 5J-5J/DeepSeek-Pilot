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
  let memoryBlock = "";

  window.addEventListener("dtw:memory-context", (event) => {
    const detail = parseDetail(event);
    memoryBlock = typeof detail?.block === "string" ? detail.block.slice(0, 40000) : "";
  });

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

  function shouldInspect(url, command) {
    return isTargetUrl(url) || Boolean(command && String(url || "").includes("/api/v0/chat/"));
  }

  function requestUrl(input) {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.toString();
    if (input instanceof Request) return input.url;
    return "";
  }

  function reportSessionTimes(data) {
    const rows = data?.data?.biz_data?.chat_sessions;
    if (!Array.isArray(rows)) return;
    const sessions = rows.filter((row) => typeof row?.id === "string" && Number.isFinite(row.updated_at))
      .map((row) => ({ sessionId: row.id, updatedAtMs: Math.round(row.updated_at * 1000),
        currentMessageId: Number.isInteger(row.current_message_id) ? row.current_message_id : null }));
    if (sessions.length) emit("dtw:session-times", { sessions });
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
            const token = value.token || value.accessToken || value.access_token || value.user_token || value.value || value.user?.token;
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
    if (!bodyText.includes(command.marker)) return null;
    let payload;
    try {
      payload = JSON.parse(bodyText);
    } catch {
      throw new Error("DeepSeek 请求体不是可改写的 JSON");
    }
    const mutation = Core.mutatePayload(payload, command);
    if (!mutation.changed) {
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

  // Always-on injection for normal chat requests. Never throws: on any
  // mismatch the request goes out unmodified so native chat keeps working.
  function injectMemoryBody(bodyText, url) {
    if (!memoryBlock || !bodyText) return null;
    let payload;
    try {
      payload = JSON.parse(bodyText);
    } catch {
      return null;
    }
    const injection = Core.injectMemoryIntoRequest(payload, memoryBlock);
    if (!injection.changed) return null;
    emit("dtw:memory-injected", {
      target: injection.target,
      blockChars: injection.blockChars,
      url: String(url || ""),
    });
    return JSON.stringify(injection.payload);
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
  window.addEventListener("dtw:profile-request", async () => {
    try {
      const token = findAuthToken();
      const response = await originalFetch.call(window, "/api/v0/users/current", {
        credentials: "include", headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      let data = await response.json();
      if (token && data?.code === 40003) {
        const retry = await originalFetch.call(window, "/api/v0/users/current", { credentials: "include" });
        data = await retry.json();
      }
      const user = data?.data?.biz_data?.user || data?.data?.biz_data || {};
      emit("dtw:profile-result", { accountId: String(user.id || user.user_id || "") });
    } catch (error) {
      emit("dtw:profile-result", { accountId: "", error: String(error?.message || error) });
    }
  });
  window.addEventListener("dtw:history-request", async (event) => {
    const detail = parseDetail(event);
    const requestId = String(detail?.requestId || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 160);
    const sessionId = String(detail?.sessionId || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 160);
    if (!requestId || !sessionId || typeof originalFetch !== "function") {
      emit("dtw:network-error", { requestId, error: "历史消息请求参数不合法" });
      return;
    }
    const token = findAuthToken();
    try {
      const url = `/api/v0/chat/history_messages?chat_session_id=${encodeURIComponent(sessionId)}`;
      const fetchHistory = (withToken) => {
        const requestHeaders = new Headers({ Accept: "application/json", "Content-Type": "application/json" });
        const bearer = withToken ? findAuthToken() : "";
        if (bearer) requestHeaders.set("Authorization", `Bearer ${bearer}`);
        return originalFetch.call(window, url, { method: "GET", headers: requestHeaders, credentials: "include" });
      };
      let response = await fetchHistory(true);
      let data = await response.json().catch(() => null);
      // DeepSeek wraps auth failures in HTTP 200 (code 40003 INVALID_TOKEN)
      // while the cookie session stays valid — the localStorage bearer may be
      // stale. Retry once with cookies only.
      const authRejected = !response?.ok
        || data?.code === 40003
        || String(data?.msg || "").toUpperCase() === "INVALID_TOKEN"
        || [401, 403].includes(Number(data?.code));
      if (token && authRejected) {
        response = await fetchHistory(false);
        data = await response.json().catch(() => null);
      }
      if (!response?.ok) throw new Error(`DeepSeek 历史接口返回 HTTP ${response?.status || 0}`);
      emit("dtw:history-result", { requestId, sessionId, data });
    } catch (error) {
      emit("dtw:network-error", { requestId, error: String(error?.message || error || "读取历史消息失败") });
    }
  });
  window.addEventListener("dtw:session-times-request", async () => {
    const token = findAuthToken();
    for (const pinned of [false, true]) {
      const url = `/api/v0/chat_session/fetch_page?lte_cursor.pinned=${pinned}`;
      try {
        const fetchPage = (withToken) => originalFetch.call(window, url, { credentials: "include",
          headers: withToken && token ? { Authorization: `Bearer ${token}` } : {} });
        let response = await fetchPage(true);
        let data = await response.json().catch(() => null);
        if (token && (!response.ok || data?.code === 40003)) {
          response = await fetchPage(false);
          data = await response.json().catch(() => null);
        }
        if (response.ok) reportSessionTimes(data);
      } catch { /* Native sidebar requests can still provide the timestamps. */ }
    }
  });

  if (typeof originalFetch === "function") {
    window.fetch = async function dtwPatchedFetch(input, init) {
      const url = requestUrl(input);
      if (url.includes("/api/v0/chat_session/fetch_page")) {
        const response = await originalFetch.apply(this, arguments);
        response.clone().json().then(reportSessionTimes).catch(() => {});
        return response;
      }
      if (url.includes("/api/v0/chat_session/delete")) {
        const response = await originalFetch.apply(this, arguments);
        response.clone().json().then((body) => {
          if (body?.code !== 0) return;
          const request = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
          emit("dtw:sessions-deleted", { sessionIds: request.chat_session_ids || [] });
        }).catch(() => {});
        return response;
      }
      const command = currentCommand();
      if (!shouldInspect(url, command)) return originalFetch.apply(this, arguments);
      if (!command && !memoryBlock) return originalFetch.apply(this, arguments);
      const commandId = command?.requestId || "";
      let bodyText = "";
      try {
        if (typeof init?.body === "string") bodyText = init.body;
        else if (init?.body instanceof URLSearchParams) bodyText = init.body.toString();
        else if (input instanceof Request) bodyText = await input.clone().text();
        if (!bodyText) return originalFetch.apply(this, arguments);
        // Armed maintenance requests are rewritten, never injected; normal
        // chat requests get the memory block when one was pushed.
        const nextBody = command ? mutateBody(bodyText, url) : injectMemoryBody(bodyText, url);
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
        if (command) {
          failCommand(error, commandId);
          throw error;
        }
        return originalFetch.apply(this, arguments);
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
    if (url.includes("/api/v0/chat_session/fetch_page")) {
      this.addEventListener("load", () => {
        try { reportSessionTimes(this.responseType === "json" ? this.response : JSON.parse(this.responseText)); }
        catch { /* Ignore unexpected native response formats. */ }
      }, { once: true });
      return originalSend.call(this, body);
    }
    const command = currentCommand();
    if (!shouldInspect(url, command)) return originalSend.call(this, body);
    if (!command && !memoryBlock) return originalSend.call(this, body);
    const commandId = command?.requestId || "";
    try {
      const bodyText = typeof body === "string" ? body
        : body instanceof URLSearchParams ? body.toString() : "";
      if (!bodyText) return originalSend.call(this, body);
      const nextBody = command ? mutateBody(bodyText, url) : injectMemoryBody(bodyText, url);
      return originalSend.call(this, nextBody || body);
    } catch (error) {
      if (command) {
        failCommand(error, commandId);
        return undefined;
      }
      return originalSend.call(this, body);
    }
  };

  emit("dtw:network-ready", { ready: true });
})();
