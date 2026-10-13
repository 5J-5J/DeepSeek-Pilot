/**
 * Runs in the page MAIN world. Rewrites armed requests and restores hidden
 * background only for a matching native message edit.
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
  let editContexts = [];
  let accountId = "";
  let accountObservedAtMs = 0;
  let nativeAuthorization = "";
  let requestState = {};
  const profileWaiters = new Set();
  const observedHistories = new Map();
  window.addEventListener("dtw:request-state", (event) => { requestState = parseDetail(event) || {}; });
  window.addEventListener("dtw:edit-context", (event) => {
    const detail = parseDetail(event);
    editContexts = (Array.isArray(detail?.contexts) ? detail.contexts : []).filter((entry) =>
      typeof entry?.sessionId === "string" && /^[\w-]{1,100}$/.test(entry.sessionId)
      && typeof entry.visible === "string" && typeof entry.prompt === "string" && entry.prompt.includes("<project_memory>"));
  });

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
    return isDeepSeekApi(url) && TARGET_PATHS.some((path) => String(url || "").includes(path));
  }
  function isDeepSeekApi(url) {
    try { const target = new URL(String(url), "https://chat.deepseek.com");
      return target.origin === "https://chat.deepseek.com" && target.pathname.startsWith("/api/v0/");
    } catch { return false; }
  }

  function shouldInspect(url, command) {
    return isTargetUrl(url) || Boolean(command && isDeepSeekApi(url) && String(url || "").includes("/api/v0/chat/"));
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
        currentMessageId: Number.isInteger(row.current_message_id) ? row.current_message_id : null,
        ...([0, 1, false, true].includes(row.pinned) ? { pinned: Boolean(row.pinned) } : {}) }));
    if (sessions.length) emit("dtw:session-times", { sessions });
  }

  function reportDeletedSessions(data, body) {
    if (data?.code !== 0 || (data?.data?.biz_code != null && data.data.biz_code !== 0)) return;
    try {
      const request = JSON.parse(typeof body === "string" ? body : "{}");
      const sessionIds = Array.isArray(request.chat_session_ids)
        ? request.chat_session_ids.filter((id) => typeof id === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(id)) : [];
      if (sessionIds.length) emit("dtw:sessions-deleted", { sessionIds });
    } catch { /* An unrecognized body must not change the local session list. */ }
  }

  function responseIssue(status, data) {
    const text = [data?.msg, data?.message, data?.data?.biz_msg].filter(Boolean).join(" · ");
    if ([401, 403].includes(status) || [401, 403, 40003].includes(Number(data?.code)) || /INVALID_TOKEN|UNAUTHORIZED|登录过期|未登录/i.test(text))
      return { code: "AUTH_REQUIRED", message: "DeepSeek 登录已失效，插件请求已停止，请通过原生页面重新登录" };
    if (/禁言|账号.*(?:封禁|限制)|account.*(?:suspend|ban)/i.test(text))
      return { code: "ACCOUNT_RESTRICTED", message: text || "DeepSeek 账号受限，插件请求已停止" };
    if (status === 429 || Number(data?.code) === 429 || Number(data?.data?.biz_code) === 429 || /请求.*频繁|too[ _-]?many|rate[ _-]?limit/i.test(text))
      return { code: "RATE_LIMITED", message: "DeepSeek 请求受限，插件主动请求暂停 60 秒", untilMs: Date.now() + 60000 };
    return null;
  }
  function reportIssue(issue) {
    if (!issue) return;
    if (issue.code === "RATE_LIMITED" && requestState.issue && requestState.issue.code !== "RATE_LIMITED") return;
    issue.observedAtMs ||= Date.now();
    if (issue.code === "AUTH_REQUIRED") { accountId = ""; nativeAuthorization = ""; observedHistories.clear(); }
    requestState.issue = issue;
    emit("dtw:request-issue", issue);
    for (const requestId of profileWaiters) emit("dtw:profile-result", { requestId, accountId: "", ...issue });
    profileWaiters.clear();
  }
  function requireRequest(detail) {
    const issue = requestState.issue;
    if (issue && (issue.code !== "RATE_LIMITED" || issue.untilMs > Date.now()))
      throw Object.assign(new Error(issue.message), { code: issue.code });
    if (requestState.paused && !requestState.allowCurrentTask)
      throw Object.assign(new Error("插件主动请求已暂停"), { code: "PAUSED" });
    if (!accountId || detail?.accountId && detail.accountId !== accountId)
      throw Object.assign(new Error("尚未收到原生页面的有效账号信息，插件不会调用登录接口验证"), { code: "AUTH_REQUIRED" });
  }
  function observeResponse(url, status, data, authorization = "") {
    if (!isDeepSeekApi(url)) return;
    const issue = responseIssue(status, data);
    if (issue) { reportIssue(issue); return; }
    if (url.includes("/api/v0/users/current")) {
      const user = data?.data?.biz_data?.user || data?.data?.biz_data;
      const id = String(user?.id || user?.user_id || "");
      if (status < 200 || status >= 300 || data?.code !== 0 || data?.data?.biz_code && data.data.biz_code !== 0 || !/^[\w-]{6,100}$/.test(id)) return;
      if (accountId && accountId !== id) observedHistories.clear();
      accountId = id; nativeAuthorization = authorization;
      accountObservedAtMs = Date.now();
      if (requestState.issue?.code === "AUTH_REQUIRED") requestState.issue = null;
      emit("dtw:account-ready", { accountId, observedAtMs: accountObservedAtMs });
      for (const requestId of profileWaiters) emit("dtw:profile-result", { requestId, accountId, observedAtMs: accountObservedAtMs });
      profileWaiters.clear();
      for (const [sessionId, history] of observedHistories) if (!nativeAuthorization || !history.authorization || history.authorization === nativeAuthorization)
        emit("dtw:history-observed", { accountId, sessionId, data: history.data });
      observedHistories.clear();
    } else if (url.includes("/api/v0/chat/history_messages")) {
      const sessionId = new URL(url, "https://chat.deepseek.com").searchParams.get("chat_session_id");
      if (!sessionId) return;
      if (accountId) {
        if (nativeAuthorization && authorization && authorization !== nativeAuthorization) return;
        emit("dtw:history-observed", { accountId, sessionId, data });
      } else {
        observedHistories.set(sessionId, { data, authorization });
        if (observedHistories.size > 20) observedHistories.delete(observedHistories.keys().next().value);
      }
    } else if (url.includes("/api/v0/chat_session/fetch_page")) reportSessionTimes(data);
  }
  async function observeStreamError(response) {
    const reader = response.clone().body?.getReader();
    if (!reader) return;
    try {
      const decoder = new TextDecoder(); let buffer = ""; let size = 0;
      while (size < 32768) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.length; buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n"); buffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          try {
            const data = JSON.parse(line.slice(5));
            if (data?.error || Number(data?.code) > 0 || Number(data?.data?.biz_code) > 0) {
              const issue = responseIssue(response.status, data.error || data); if (issue) reportIssue(issue);
            }
          } catch { /* Stream text is not a status response. */ }
        }
      }
    } finally { reader.cancel().catch(() => {}); }
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
    if (command.operation === "automation") requireRequest({ accountId });
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
      sessionId: typeof payload.chat_session_id === "string" && /^[\w-]{1,100}$/.test(payload.chat_session_id)
        ? payload.chat_session_id : "",
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

  function restoreEditBody(bodyText, url) {
    if (!String(url).includes("/api/v0/chat/edit_message") || !editContexts.length) return null;
    const payload = JSON.parse(bodyText);
    const target = Core.resolvePromptTarget(payload);
    if (!target) return null;
    const context = editContexts.find((entry) => entry.sessionId === payload.chat_session_id
      && (entry.messageId == null || entry.messageId === payload.message_id)
      && entry.visible.trim() === target.get().trim());
    if (!context) return null;
    target.set(context.prompt);
    return JSON.stringify(payload);
  }

  window.addEventListener("dtw:network-arm", (event) => {
    const command = Core.normalizeCommand(parseDetail(event));
    if (!command) {
      emit("dtw:network-error", { requestId: "", error: "请求体改写指令不合法" });
      return;
    }
    if (command.operation === "automation" && requestState.issue) {
      const issue = requestState.issue;
      if (issue.code !== "RATE_LIMITED" || issue.untilMs > Date.now()) { emit("dtw:network-error", { requestId: command.requestId, code: issue.code, error: issue.message }); return; }
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
  window.addEventListener("dtw:delete-request", async (event) => {
    const detail = parseDetail(event);
    const requestId = detail?.requestId;
    try {
      const ids = detail?.sessionIds;
      if (!requestId || !Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== "string" || !/^[\w-]{1,100}$/.test(id)))
        throw new Error("删除会话参数不合法");
      const headers = { "Content-Type": "application/json" };
      requireRequest(detail);
      if (nativeAuthorization) headers.Authorization = nativeAuthorization;
      const body = JSON.stringify({ chat_session_ids: ids });
      const response = await originalFetch.call(window, "/api/v0/chat_session/delete", {
        method: "POST", credentials: "include", headers, body });
      const result = await response.json().catch(() => null);
      const issue = responseIssue(response.status, result);
      if (issue) { reportIssue(issue); throw Object.assign(new Error(issue.message), { code: issue.code }); }
      if (!response.ok || result?.code !== 0 || result?.data?.biz_code !== 0)
        throw new Error(result?.data?.biz_msg || result?.msg || "DeepSeek 删除会话失败");
      emit("dtw:delete-result", { requestId });
    } catch (error) { emit("dtw:network-error", { requestId, code: error.code, error: String(error.message || error) }); }
  });
  window.addEventListener("dtw:profile-request", (event) => {
    const requestId = parseDetail(event)?.requestId;
    if (accountId) emit("dtw:profile-result", { requestId, accountId, observedAtMs: accountObservedAtMs });
    else if (requestState.issue) emit("dtw:profile-result", { requestId, accountId: "", ...requestState.issue });
    else if (requestId) profileWaiters.add(requestId);
  });
  window.addEventListener("dtw:history-request", async (event) => {
    const detail = parseDetail(event);
    const requestId = String(detail?.requestId || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 160);
    const sessionId = String(detail?.sessionId || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 160);
    if (!requestId || !sessionId || typeof originalFetch !== "function") {
      emit("dtw:network-error", { requestId, error: "历史消息请求参数不合法" });
      return;
    }
    try {
      requireRequest(detail);
      const url = `/api/v0/chat/history_messages?chat_session_id=${encodeURIComponent(sessionId)}`;
      const headers = new Headers({ Accept: "application/json" });
      if (nativeAuthorization) headers.set("Authorization", nativeAuthorization);
      const response = await originalFetch.call(window, url, { method: "GET", headers, credentials: "include" });
      const data = await response.json().catch(() => null);
      const issue = responseIssue(response.status, data);
      if (issue) { reportIssue(issue); throw Object.assign(new Error(issue.message), { code: issue.code }); }
      if (!response?.ok) throw new Error(`DeepSeek 历史接口返回 HTTP ${response?.status || 0}`);
      emit("dtw:history-result", { requestId, sessionId, data });
    } catch (error) {
      emit("dtw:network-error", { requestId, code: error?.code, error: String(error?.message || error || "读取历史消息失败") });
    }
  });
  if (typeof originalFetch === "function") {
    window.fetch = async function dtwPatchedFetch(input, init) {
      const url = requestUrl(input);
      const observe = (response) => {
        if (!isDeepSeekApi(url) || typeof response?.clone !== "function") return response;
        const authorization = new Headers(init?.headers || (input instanceof Request ? input.headers : {})).get("Authorization") || "";
        if (response.headers?.get("content-type")?.includes("text/event-stream")) {
          const issue = responseIssue(response.status, null); if (issue) reportIssue(issue);
          else observeStreamError(response).catch(() => {});
        } else response.clone().json().then((data) => observeResponse(url, response.status, data, authorization))
          .catch(() => reportIssue(responseIssue(response.status, null)));
        return response;
      };
      if (url.includes("/api/v0/chat_session/fetch_page")) {
        const response = await originalFetch.apply(this, arguments);
        return observe(response);
      }
      if (url.includes("/api/v0/chat_session/delete")) {
        // Capture a Request body before fetch consumes it. Keep the original
        // request and response untouched for the native application.
        const body = typeof init?.body === "string" ? Promise.resolve(init.body)
          : input instanceof Request && init?.body == null ? input.clone().text().catch(() => "") : Promise.resolve("");
        const response = await originalFetch.apply(this, arguments);
        if (response.ok) Promise.all([response.clone().json(), body])
          .then(([data, requestBody]) => reportDeletedSessions(data, requestBody)).catch(() => {});
        return observe(response);
      }
      const command = currentCommand();
      if (!shouldInspect(url, command)) return observe(await originalFetch.apply(this, arguments));
      if (!command && !memoryBlock && !editContexts.length) return observe(await originalFetch.apply(this, arguments));
      const commandId = command?.requestId || "";
      let bodyText = "";
      try {
        if (typeof init?.body === "string") bodyText = init.body;
        else if (init?.body instanceof URLSearchParams) bodyText = init.body.toString();
        else if (input instanceof Request) bodyText = await input.clone().text();
        if (!bodyText) return originalFetch.apply(this, arguments).then(observe);
        // Edits retain their original background; new messages never use an edit draft.
        const nextBody = command ? mutateBody(bodyText, url) : restoreEditBody(bodyText, url) || injectMemoryBody(bodyText, url);
        if (!nextBody) return originalFetch.apply(this, arguments).then(observe);

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
        return originalFetch.call(this, nextInput, nextInit).then(observe);
      } catch (error) {
        if (command) {
          failCommand(error, commandId);
          throw error;
        }
        return originalFetch.apply(this, arguments).then(observe);
      }
    };
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const originalSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  if (originalSetHeader) XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
    if (String(name).toLowerCase() === "authorization") this.__dtwAuthorization = value;
    return originalSetHeader.apply(this, arguments);
  };
  XMLHttpRequest.prototype.open = function dtwPatchedOpen(method, url) {
    this.__dtwRequestUrl = String(url || "");
    this.__dtwAuthorization = "";
    return originalOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function dtwPatchedSend(body) {
    const url = this.__dtwRequestUrl || "";
    if (isDeepSeekApi(url)) this.addEventListener("load", () => {
      try { observeResponse(url, this.status, this.responseType === "json" ? this.response : JSON.parse(this.responseText), this.__dtwAuthorization || ""); }
      catch { reportIssue(responseIssue(this.status, null)); }
    }, { once: true });
    if (url.includes("/api/v0/chat_session/delete")) {
      this.addEventListener("load", () => {
        if (this.status < 200 || this.status >= 300) return;
        try { reportDeletedSessions(this.responseType === "json" ? this.response : JSON.parse(this.responseText), body); }
        catch { /* Ignore an unsuccessful or unrecognized native response. */ }
      }, { once: true });
      return originalSend.call(this, body);
    }
    if (url.includes("/api/v0/chat_session/fetch_page")) return originalSend.call(this, body);
    const command = currentCommand();
    if (!shouldInspect(url, command)) return originalSend.call(this, body);
    if (!command && !memoryBlock && !editContexts.length) return originalSend.call(this, body);
    const commandId = command?.requestId || "";
    try {
      const bodyText = typeof body === "string" ? body
        : body instanceof URLSearchParams ? body.toString() : "";
      if (!bodyText) return originalSend.call(this, body);
      const nextBody = command ? mutateBody(bodyText, url) : restoreEditBody(bodyText, url) || injectMemoryBody(bodyText, url);
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
