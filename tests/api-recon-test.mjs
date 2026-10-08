/**
 * API 侦查：采集 chat.deepseek.com 页面真实收发的 /api/v0/ 数据。
 *   node api-recon-test.mjs                    只读模式（不发消息）
 *   node api-recon-test.mjs --send             发一条真实消息，抓 completion 回合
 *   node api-recon-test.mjs --send --think --edit --leim   补齐：深度思考回合 /
 *       编辑消息回合（edit_message）/ x-hif-leim 源码定位与无头探测
 * 通道一（被动）：CDP Network 域监听页面自己发出的全部 /api/v0/ 请求
 *   （方法/请求头/请求体/状态/响应体原文）。通道二（主动）：页面上下文里
 *   fetch 只读 GET 接口（history_messages），等价于插件 MAIN world 能做的。
 * 输出 docs/api-recon.md：全部为真实抓包数据，token 类值只保留形状。
 */
import { spawn, execSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const profilePath = path.join(here, "..", ".live-profile");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SEND = process.argv.includes("--send");
const THINK = process.argv.includes("--think");
const EDIT = process.argv.includes("--edit");
const LEIM = process.argv.includes("--leim");
const OPS = process.argv.includes("--ops");
const SEARCH = process.argv.includes("--search"); // 独立轻量模式：不 --send，单独抓搜索 API
const outputPath = path.join(here, "..", "docs", SEND ? "api-recon.md" : "api-recon-search.md");
const sections = [];
const section = (title, body) => sections.push("## " + title + "\n\n" + body + "\n");

const redact = (value) => {
  const text = String(value);
  return `${text.slice(0, 12)}…（长度 ${text.length}，已脱敏）`;
};

try {
  execSync(
    "powershell -NoProfile -Command \"Get-CimInstance Win32_Process -Filter \\\"name='chrome.exe'\\\" | " +
    "Where-Object { $_.CommandLine -like '*live-profile*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }\"",
    { stdio: "ignore" },
  );
} catch { /* 无残留 */ }
await fs.rm(path.join(profilePath, "DevToolsActivePort"), { force: true });

let chromeExited = "";
const chrome = spawn(chromePath, [
  "--no-first-run",
  "--remote-debugging-port=0",
  "--user-data-dir=" + profilePath,
  "--window-size=1400,900",
  "https://chat.deepseek.com/",
], { windowsHide: false });
chrome.on("exit", (code) => { chromeExited = "Chrome 提前退出（code=" + code + "）"; });

async function waitForDebugPort() {
  const activePortPath = path.join(profilePath, "DevToolsActivePort");
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (chromeExited) throw new Error(chromeExited);
    try {
      const [port] = (await fs.readFile(activePortPath, "utf8")).trim().split(/\r?\n/);
      if (port) return Number(port);
    } catch { /* 尚未写入 */ }
    await delay(100);
  }
  throw new Error("Chrome DevTools endpoint did not start");
}

const listTargets = (port) => fetch("http://127.0.0.1:" + port + "/json/list").then((r) => r.json());

// 带 API 请求路由与 Network 事件分发的 CDP 连接
async function connect(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  const listeners = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve: ok, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else ok(message.result);
      return;
    }
    for (const listener of listeners) listener(message);
  });
  return {
    call(method, params = {}) {
      sequence += 1;
      return new Promise((resolve, reject) => {
        pending.set(sequence, { resolve, reject });
        socket.send(JSON.stringify({ id: sequence, method, params }));
      });
    },
    onEvent(listener) { listeners.push(listener); },
    close() { socket.close(); },
  };
}

async function evaluate(cdp, expression) {
  const result = await cdp.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result.value;
}

const waitUntil = async (description, check, timeoutMs = 60000, intervalMs = 1500) => {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error("等待超时：" + description);
    await delay(intervalMs);
  }
};

// XHR shim：记录 /api/v0/ 的 XHR 请求（method/url/头/体 + 流式 responseText 快照）
const XHR_SHIM = `(() => {
  if (window.__xhrCapInstalled) return "already";
  window.__xhrCapInstalled = true;
  window.__xhrCap = { requests: [] };
  const openOrig = XMLHttpRequest.prototype.open;
  const sendOrig = XMLHttpRequest.prototype.send;
  const setHeaderOrig = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__capRecord = { channel: "xhr", url: String(url || ""), method: String(method || "GET"),
      headers: {}, body: "", streamText: "", streamDone: false, startedAt: Date.now() };
    return openOrig.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (key, value) {
    if (this.__capRecord) this.__capRecord.headers[key] = value;
    return setHeaderOrig.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const record = this.__capRecord;
    if (record && record.url.indexOf("/api/v0/") !== -1) {
      window.__xhrCap.requests.push(record);
      if (typeof body === "string") record.body = body;
      this.addEventListener("readystatechange", () => {
        try { if (this.readyState >= 3) record.streamText = this.responseText; } catch (error) {}
        if (this.readyState === 4) record.streamDone = true;
      });
    }
    return sendOrig.apply(this, arguments);
  };
  return "installed";
})()`;

let cdp;
const apiCalls = new Map(); // requestId -> call record
try {
  const port = await waitForDebugPort();
  const target = await waitUntil("DeepSeek 页面", async () =>
    (await listTargets(port)).find((item) => item.type === "page" && /chat\.deepseek\.com/.test(item.url || "")), 30000, 500);
  cdp = await connect(target.webSocketDebuggerUrl);
  await cdp.call("Page.enable");
  await cdp.call("Runtime.enable");
  await cdp.call("Network.enable");
  await delay(1500);

  await waitUntil("登录", () => evaluate(cdp, `[...document.querySelectorAll('span')].some((e) => e.textContent.trim() === '开启新对话')`), 180000, 2500);
  console.log("[api-recon] 已登录");

  // —— 通道一：被动抓页面加载期间自己发的全部 /api/v0/ 请求 ——
  cdp.onEvent((message) => {
    const { method, params } = message;
    if (method === "Network.requestWillBeSent") {
      const url = params.request?.url || "";
      if (!url.includes("/api/v0/")) return;
      apiCalls.set(params.requestId, {
        url, method: params.request.method,
        requestHeaders: params.request.headers,
        postData: params.request.postData || "",
        status: 0, mimeType: "", body: null, sse: false, finished: false,
      });
    } else if (method === "Network.responseReceived") {
      const call = apiCalls.get(params.requestId);
      if (!call) return;
      call.status = params.response.status;
      call.mimeType = params.response.mimeType;
      if (/event-stream/i.test(call.mimeType)) call.sse = true;
    } else if (method === "Network.loadingFinished") {
      const call = apiCalls.get(params.requestId);
      if (call) call.finished = true;
    }
  });

  await evaluate(cdp, XHR_SHIM);
  await cdp.call("Page.reload");
  await delay(12000);

  for (const [requestId, call] of apiCalls) {
    if (!call.finished) continue;
    try {
      const body = await cdp.call("Network.getResponseBody", { requestId });
      call.body = body.base64Encoded ? Buffer.from(body.body, "base64").toString("utf8") : body.body;
    } catch (error) {
      call.bodyError = String(error.message);
    }
  }

  const apiLines = [];
  const bodies = [];
  let index = 0;
  for (const call of apiCalls.values()) {
    index += 1;
    apiLines.push(`${index}. ${call.method} ${call.url.replace("https://chat.deepseek.com", "")} → HTTP ${call.status} ${call.mimeType}${call.sse ? "（SSE 流）" : ""}`);
    if (call.postData) apiLines.push(`   请求体: ${call.postData.slice(0, 300)}`);
    const authHeader = Object.entries(call.requestHeaders || {}).find(([key]) => /authorization/i.test(key));
    if (authHeader) apiLines.push(`   Authorization: ${redact(authHeader[1])}`);
    if (call.body && !call.sse) bodies.push(`### ${index}. ${call.url.replace("https://chat.deepseek.com", "")}\n\n\`\`\`json\n${call.body.slice(0, 4000)}\n\`\`\``);
    if (call.bodyError) bodies.push(`### ${index}. ${call.url}\n\nbody 获取失败：${call.bodyError}`);
  }
  section("页面加载期间的 /api/v0/ 请求（被动抓包）", "```\n" + (apiLines.join("\n") || "无") + "\n```\n\n请求头完整键清单（首个请求）：" +
    JSON.stringify(Object.keys([...apiCalls.values()][0]?.requestHeaders || {})));
  section("各接口响应体原文（截断 4000 字符）", bodies.join("\n\n") || "无");

  // 从真实 fetch_page 响应里取第一个会话 id，供主动只读查询
  let firstSession = null;
  let sessionSample = null;
  for (const call of apiCalls.values()) {
    if (!call.url.includes("chat_session/fetch_page") || !call.body) continue;
    try {
      const parsed = JSON.parse(call.body);
      const list = parsed?.data?.biz_data?.chat_sessions;
      if (Array.isArray(list) && list.length) {
        firstSession = list[0];
        sessionSample = list.slice(0, 10);
      }
    } catch { /* 响应被截断则跳过 */ }
  }
  if (sessionSample) {
    // fetch_page 完整结构：数组之外的分页/统计字段
    for (const call of apiCalls.values()) {
      if (!call.url.includes("chat_session/fetch_page") || !call.body) continue;
      try {
        const parsed = JSON.parse(call.body);
        const biz = parsed?.data?.biz_data || {};
        section("fetch_page biz_data 完整结构", "```json\n" + JSON.stringify({
          biz_data键: Object.keys(biz),
          会话总数_本页: Array.isArray(biz.chat_sessions) ? biz.chat_sessions.length : null,
          非数组字段: Object.fromEntries(Object.entries(biz).filter(([, v]) => !Array.isArray(v))),
        }, null, 2) + "\n```");
        break;
      } catch { /* 截断 */ }
    }
    section("会话列表实样（前 10 条，fetch_page 响应原文）", "```json\n" + JSON.stringify(sessionSample, null, 2) + "\n```");
  }

  // —— localStorage / cookie：插件在页面里能读到的凭据形状 ——
  const storageInfo = await evaluate(cdp, `(() => {
    const keys = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      const value = localStorage.getItem(key) || "";
      keys.push({ key, length: value.length, preview: /token|auth|session/i.test(key) ? value.slice(0, 12) + "…" : value.slice(0, 80) });
    }
    return JSON.stringify({ localStorage: keys, cookieNames: document.cookie.split("; ").map((row) => row.split("=")[0]).filter(Boolean) }, null, 2);
  })()`);
  section("localStorage / cookie（token 类只留前 12 字符）", "```json\n" + storageInfo + "\n```");

  // —— 通道二：主动只读 GET（等价插件 MAIN world fetch）。两种鉴权各试一次 ——
  if (firstSession?.id) {
    const summarizeHistory = (bodyText) => {
      try {
        const data = JSON.parse(bodyText);
        const messages = data?.data?.biz_data?.chat_messages || [];
        const trim = (text) => (typeof text === "string" && text.length > 100 ? text.slice(0, 100) + `…（共 ${text.length} 字符）` : text);
        return {
          wrapper: { code: data?.code, msg: data?.msg, "data.biz_data keys": Object.keys(data?.data?.biz_data || {}) },
          session: data?.data?.biz_data?.chat_session,
          cache_control: data?.data?.biz_data?.cache_control,
          messageCount: messages.length,
          firstUserMessageShape: (() => {
            const message = messages.find((m) => String(m.role).toUpperCase() === "USER") || messages[0];
            if (!message) return null;
            const clone = JSON.parse(JSON.stringify(message));
            if (Array.isArray(clone.fragments)) clone.fragments = clone.fragments.map((f) => ({ ...f, content: trim(f.content) }));
            for (const key of ["content", "prompt"]) if (typeof clone[key] === "string") clone[key] = trim(clone[key]);
            return clone;
          })(),
          tokenUsageFields: [...new Set(messages.flatMap((m) => Object.keys(m.accumulated_token_usage || {})))],
          lastMessageTokenUsage: messages[messages.length - 1]?.accumulated_token_usage || null,
        };
      } catch (error) {
        return { parseError: String(error.message), raw: String(bodyText).slice(0, 500) };
      }
    };

    const history = await evaluate(cdp, `(async () => {
      const url = "/api/v0/chat/history_messages?chat_session_id=" + encodeURIComponent("${firstSession.id}");
      const tokenValue = (() => { try { return JSON.parse(localStorage.getItem("userToken") || "null").value || ""; } catch { return ""; } })();
      const attempts = { cookieOnly: null, withToken: null };
      let response = await fetch(url, { credentials: "include" });
      attempts.cookieOnly = { httpStatus: response.status, body: await response.text() };
      if (tokenValue) {
        response = await fetch(url, { credentials: "include", headers: { Authorization: "Bearer " + tokenValue } });
        attempts.withToken = { httpStatus: response.status, body: await response.text() };
      }
      return JSON.stringify({ tokenShape: tokenValue ? tokenValue.slice(0, 6) + "…（长度 " + tokenValue.length + "）" : "未取到", attempts });
    })()`);
    const parsed = JSON.parse(history);
    const lines = ["localStorage.userToken 形状: " + parsed.tokenShape];
    for (const [name, attempt] of Object.entries(parsed.attempts)) {
      if (!attempt) continue;
      lines.push("\n### " + name + "（HTTP " + attempt.httpStatus + "）\n\n```json\n" + JSON.stringify(summarizeHistory(attempt.body), null, 2) + "\n```");
    }
    section("主动 GET history_messages（会话 " + firstSession.id + "）", lines.join("\n"));
  } else {
    section("主动 GET history_messages", "未从 fetch_page 响应中拿到会话 id，跳过");
  }

  // —— 回合采集助手（--send 系列共用）——
  const snapshotIds = () => new Set(apiCalls.keys());
  const collectTurn = async (label, phaseIds) => {
    const turnIds = [...apiCalls.keys()].filter((id) => !phaseIds.has(id));
    await waitUntil("回合请求全部完成", () => turnIds.every((id) => apiCalls.get(id)?.finished), 30000, 1000).catch(() => {});
    const parts = [];
    for (const requestId of turnIds) {
      const call = apiCalls.get(requestId);
      const shortUrl = call.url.replace("https://chat.deepseek.com", "");
      let bodyPart = "（无请求体）";
      if (call.postData) {
        try { bodyPart = "```json\n" + JSON.stringify(JSON.parse(call.postData), null, 2).slice(0, 2500) + "\n```"; }
        catch { bodyPart = "```\n" + call.postData.slice(0, 800) + "\n```"; }
      }
      let responsePart = "";
      try {
        const body = await cdp.call("Network.getResponseBody", { requestId });
        const text = body.base64Encoded ? Buffer.from(body.body, "base64").toString("utf8") : body.body;
        if (call.sse) {
          const events = text.split("\n").filter((line) => line.startsWith("data:"));
          const usageEvents = events.filter((line) => /token|usage/i.test(line));
          const shown = events.length <= 60 ? events
            : [...events.slice(0, 3), `…（省略 ${events.length - 9} 条）`, ...events.slice(-6)];
          responsePart = `\n\nSSE data 事件共 ${events.length} 条（${events.length <= 60 ? "全量" : "首尾"}原文）：\n\n\`\`\`\n` +
            shown.join("\n").slice(0, 9000) + "\n```" +
            (usageEvents.length ? `\n\n含 token/usage 的事件（全量）：\n\n\`\`\`\n${usageEvents.join("\n").slice(0, 3000)}\n\`\`\`` : "");
        } else if (text.trim().startsWith("{")) {
          try {
            const biz = JSON.parse(text)?.data?.biz_data;
            responsePart = "\n\n响应体 biz_data 键：`" + JSON.stringify(Object.keys(biz || {})) + "`" +
              (Array.isArray(biz?.chat_sessions) ? `（chat_sessions ${biz.chat_sessions.length} 条，has_more=${JSON.stringify(biz.has_more)}）` : "") +
              "\n\n```json\n" + text.slice(0, 600) + "\n```";
          } catch { responsePart = "\n\n```json\n" + text.slice(0, 600) + "\n```"; }
        }
      } catch (error) { responsePart = "\n\n响应体获取失败：" + error.message; }
      const headerPart = Object.entries(call.requestHeaders || {})
        .filter(([key]) => !/^sec-|user-agent|referer/i.test(key))
        .map(([key, value]) => `- ${key}: ${/authorization|token|cookie/i.test(key) ? redact(value) : value}`)
        .join("\n");
      parts.push("### " + call.method + " " + shortUrl + "\n\n请求头（节选）：\n\n" + headerPart + "\n\n请求体：" + bodyPart + responsePart);
    }
    section(label, parts.join("\n\n") || "无新调用");
  };
  const sendViaEditor = async (text) => {
    const editorBox = await waitUntil("输入框", () => evaluate(cdp, `(() => {
      const editor = [...document.querySelectorAll('textarea, [contenteditable="true"]')]
        .find((item) => !item.closest("#dtw-root"));
      if (!editor) return null;
      editor.focus();
      const rect = editor.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`), 20000);
    await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", x: editorBox.x, y: editorBox.y, button: "left", clickCount: 1 });
    await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: editorBox.x, y: editorBox.y, button: "left", clickCount: 1 });
    await cdp.call("Input.insertText", { text });
    await delay(400);
    await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await delay(2000);
    const stillInEditor = await evaluate(cdp, `Boolean([...document.querySelectorAll('textarea, [contenteditable="true"]')]
      .find((item) => !item.closest('#dtw-root'))?.textContent?.includes(${JSON.stringify(text.slice(0, 8))}))`);
    if (stillInEditor) {
      await evaluate(cdp, `(() => {
        const control = [...document.querySelectorAll("button, div[role=button]")]
          .find((item) => /发送|send/i.test((item.getAttribute("aria-label") || "") + item.textContent));
        if (control) control.click();
      })()`);
    }
  };
  const waitReplyDone = (minMessages = 1) => waitUntil("回复完成", () => evaluate(cdp, `(() => {
    const generating = [...document.querySelectorAll("button, div[role=button]")]
      .some((item) => /停止生成|停止回答/i.test((item.getAttribute("aria-label") || "") + (item.textContent || "")));
    const replies = document.querySelectorAll("div.ds-message").length;
    return !generating && replies >= ${minMessages} ? replies : false;
  })()`), 120000, 2000);

  // —— 通道三（--send）：真实发一条消息，抓 completion 回合 ——
  let sessionUrl = "";
  if (SEND) {
    const loadPhaseIds = snapshotIds();

    // 本文档重新装双通道 shim（Page.reload 已把上一份清掉）：fetch 后装补丁 +
    // XHR 补丁，验证回合请求到底走哪条通道
    await evaluate(cdp, XHR_SHIM);
    await evaluate(cdp, `(() => {
      if (window.__sseCapInstalled) return "already";
      window.__sseCapInstalled = true;
      window.__sseCap = { requests: [] };
      const original = window.fetch.bind(window);
      window.fetch = async function (input, init) {
        const url = typeof input === "string" ? input : (input && input.url) || String(input || "");
        if (url.indexOf("/api/v0/") === -1) return original(input, init);
        let bodyText = "";
        try { if (init && typeof init.body === "string") bodyText = init.body; } catch (error) {}
        const headers = {};
        try {
          const source = init && init.headers ? init.headers
            : (typeof Request !== "undefined" && input instanceof Request ? input.headers : {});
          const normalized = source instanceof Headers ? source : new Headers(source || {});
          normalized.forEach((value, key) => { headers[key] = value; });
        } catch (error) {}
        const record = { url, method: (init && init.method) || "GET", headers, body: bodyText,
          streamText: "", streamDone: false, startedAt: Date.now() };
        window.__sseCap.requests.push(record);
        const response = await original(input, init);
        try {
          response.clone().text().then((text) => { record.streamText = text; record.streamDone = true; })
            .catch((error) => { record.streamError = String(error); });
        } catch (error) { record.cloneError = String(error); }
        return response;
      };
      return "installed";
    })()`);

    // 旧 live-test 装进 profile 的扩展可能开着自动注入：推一个空记忆块让本轮请求体保持原样
    await evaluate(cdp, `window.dispatchEvent(new CustomEvent("dtw:memory-context", { detail: JSON.stringify({ block: "" }) }))`);
    const sendStartedAt = Date.now();
    try { await cdp.call("Page.bringToFront"); } catch { /* 部分环境不支持 */ }

    // 新会话 + 输入 + Enter（沿用 live-test 的已验证序列）
    await evaluate(cdp, `(() => {
      const entry = [...document.querySelectorAll("span")].find((e) => e.textContent.trim() === "开启新对话");
      if (entry) (entry.closest("button, div[role=button], a") || entry).click();
    })()`);
    await delay(1500);
    await sendViaEditor("请只回复两个字：收到");
    sessionUrl = await evaluate(cdp, "location.pathname");
    console.log("[api-recon] 消息已发送（会话 " + sessionUrl + "），等待回复…");

    await waitReplyDone();
    await delay(8000); // 回合后的尾随调用（标题/列表刷新等）
    console.log("[api-recon] 回复完成");

    // 侧栏滚底 → 触发第二页 fetch_page（真实分页游标）
    for (let round = 0; round < 2; round += 1) {
      await evaluate(cdp, `(() => {
        const links = [...document.querySelectorAll('a[href*="/chat/s/"]')];
        let el = links[0];
        while (el && el !== document.body) {
          const cs = getComputedStyle(el);
          if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 50) {
            el.scrollTop = el.scrollHeight;
            return "scrolled";
          }
          el = el.parentElement;
        }
        return "no-scroller";
      })()`);
      await delay(2500);
    }
    await delay(2000);

    // 收 shim 数据（fetch + XHR 双通道，按时间序合并）——回答“回合请求走哪条通道”
    const captured = JSON.parse(await evaluate(cdp, `JSON.stringify({
      fetch: (window.__sseCap && window.__sseCap.requests) || [],
      xhr: (window.__xhrCap && window.__xhrCap.requests) || [],
    })`));
    const allCalls = [
      ...captured.fetch.map((r) => ({ ...r, channel: "fetch" })),
      ...captured.xhr.map((r) => ({ ...r, channel: "xhr" })),
    ].sort((a, b) => a.startedAt - b.startedAt);
    const loadCalls = allCalls.filter((r) => r.startedAt < sendStartedAt);
    const sendCalls = allCalls.filter((r) => r.startedAt >= sendStartedAt);
    const byChannel = (list) => list.reduce((acc, r) => { acc[r.channel] = (acc[r.channel] || 0) + 1; return acc; }, {});
    const sendLines = sendCalls.map((r, i) =>
      `${i + 1}. [${r.channel}] ${r.method} ${r.url.replace("https://chat.deepseek.com", "")}` +
      (r.streamText ? `（响应 ${r.streamText.length} 字符${r.streamDone ? "" : "，未收完"}）` : ""));
    section("发消息回合的通道验证（document_start 之后才装的 shim 视角）",
      "会话 URL：" + sessionUrl +
      "\n\nshim 安装后的通道统计 —— 加载期调用：" + JSON.stringify(byChannel(loadCalls)) +
      "，回合调用：" + JSON.stringify(byChannel(sendCalls)) +
      "\n\n```\n" + (sendLines.join("\n") || "两条通道均未捕获（请求绕过了后装补丁）") + "\n```");

    await collectTurn("发消息回合（CDP 全量实抓）", loadPhaseIds);
  }

  // —— --think：深度思考回合，看 SSE 是否出现更多 token 字段/事件类型 ——
  if (SEND && THINK) {
    const phaseIds = snapshotIds();
    const toggled = await evaluate(cdp, `(() => {
      const span = [...document.querySelectorAll("span")].find((e) => /^深度思考/.test(e.textContent.trim()));
      if (!span) return "not-found";
      (span.closest("button, div[role=button]") || span).click();
      return "clicked";
    })()`);
    await delay(600);
    await sendViaEditor("用一句话解释为什么天空是蓝色的");
    console.log("[api-recon] 深度思考消息已发送（toggle=" + toggled + "）…");
    await waitReplyDone(3);
    await delay(6000);
    // 关掉开关，恢复默认
    await evaluate(cdp, `(() => {
      const span = [...document.querySelectorAll("span")].find((e) => /^深度思考/.test(e.textContent.trim()));
      if (span) (span.closest("button, div[role=button]") || span).click();
    })()`);
    await collectTurn("深度思考回合（toggle=" + toggled + "，CDP 全量实抓）", phaseIds);
  }

  // —— --edit：编辑已发消息，抓 edit_message 请求体与响应 ——
  if (SEND && EDIT) {
    const phaseIds = snapshotIds();
    let editFlow = "no-message";
    const messageCount = await evaluate(cdp, `document.querySelectorAll("div.ds-message").length`);
    // 消息操作按钮全是无文字的图标：编辑只在用户消息条上 → 用户条里不属于助手条的图标
    // 逐个候选点击，用「出现含原文的编辑器」确认点中了编辑（textarea 用 value，contenteditable 用 textContent）
    let clicked = false;
    let finderNote = "";
    for (const userIndex of [2, 0]) {
      const spot = await evaluate(cdp, `(() => {
        const message = document.querySelectorAll("div.ds-message")[${userIndex}];
        if (!message) return null;
        const rect = message.getBoundingClientRect();
        return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.bottom - 14), marker: message.textContent.trim().slice(0, 12) };
      })()`);
      if (!spot) { finderNote += "msg" + userIndex + "-missing；"; continue; }
      await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: spot.x, y: spot.y });
      await delay(700);
      // 取用户条里不属于助手条的图标（= 编辑）的真实坐标，用可信鼠标事件点击
      const target = await evaluate(cdp, `(() => {
        const messages = [...document.querySelectorAll("div.ds-message")];
        const userRect = messages[${userIndex}] && messages[${userIndex}].getBoundingClientRect();
        const assistRect = messages[${userIndex + 1}] && messages[${userIndex + 1}].getBoundingClientRect();
        if (!userRect || !assistRect) return "rects-missing";
        const iconButtons = [...document.querySelectorAll("button, div[role=button]")].filter((b) => {
          if (b.offsetParent === null || (b.textContent || "").trim()) return false;
          const rect = b.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        }).map((b) => ({ rect: b.getBoundingClientRect(), svg: (b.querySelector("svg")?.innerHTML || "").replace(/\\s+/g, "") }));
        const near = (rect) => iconButtons.filter((x) => x.rect.y >= rect.bottom - 30 && x.rect.y <= rect.bottom + 60);
        const userBar = near(userRect);
        const assistBar = near(assistRect);
        const assistSvgs = new Set(assistBar.map((x) => x.svg));
        const distinct = userBar.filter((x) => !assistSvgs.has(x.svg));
        if (!distinct.length) return "no-distinct(userBar=" + userBar.length + ",assistBar=" + assistBar.length + ")";
        const rect = distinct[0].rect;
        return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
      })()`);
      if (typeof target !== "object") { finderNote += "msg" + userIndex + ": " + target + "；"; continue; }
      await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: target.x, y: target.y });
      await delay(150);
      await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", x: target.x, y: target.y, button: "left", clickCount: 1 });
      await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: target.x, y: target.y, button: "left", clickCount: 1 });
      // 编辑态判定：出现了「非空」的可编辑字段（此刻 composer 是空的，非空 = 编辑器已打开）
      try {
        await waitUntil("编辑态", () => evaluate(cdp, `(() => [...document.querySelectorAll("textarea, [contenteditable=true]")]
          .some((f) => !f.closest("#dtw-root") && ((f.value || "") + (f.textContent || "")).trim().length > 6))()`), 4000, 500);
        clicked = true;
        break;
      } catch { finderNote += "msg" + userIndex + "-click-miss；"; }
    }
    if (!clicked) {
      const dump = await evaluate(cdp, `(() => JSON.stringify([...document.querySelectorAll("textarea, input, [contenteditable=true]")]
        .map((f) => ({ tag: f.tagName, value: String(f.value || "").slice(0, 40), text: String(f.textContent || "").slice(0, 40) }))))()`);
      section("编辑按钮诊断（候选尝试与可编辑字段清单）", "```\n" + finderNote + "\n" + dump + "\n```");
      editFlow = "edit-button-not-found";
      console.log("[api-recon] 编辑按钮未找到：" + finderNote);
    } else {
      editFlow = "clicked";
      try {
        const where = await evaluate(cdp, `(() => {
          const fields = [...document.querySelectorAll("textarea, [contenteditable=true]")];
          const field = fields.find((item) => !item.closest("#dtw-root")
            && ((item.value || "") + (item.textContent || "")).trim().length > 6);
          if (!field) return null;
          field.focus();
          const rect = field.getBoundingClientRect();
          return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, tag: field.tagName.toLowerCase(),
            inline: Boolean(field.closest("div.ds-message")) };
        })()`);
        if (!where) throw new Error("编辑器消失");
        await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", x: where.x, y: where.y, button: "left", clickCount: 1 });
        await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: where.x, y: where.y, button: "left", clickCount: 1 });
        await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", modifiers: 2, key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
        await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 2, key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
        await cdp.call("Input.insertText", { text: "（编辑测试）请只回复三个字：收到啦" });
        await delay(400);
        await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
        await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
        // Enter 不一定提交：确认 edit_message 请求真的发出，没发就点编辑框下方的确认按钮
        const seenEdit = () => [...apiCalls.keys()].some((id) => !phaseIds.has(id) && apiCalls.get(id).url.includes("edit_message"));
        let sent = await waitUntil("edit_message 请求", seenEdit, 6000, 500).catch(() => false);
        if (!sent) {
          const confirm = await evaluate(cdp, `(() => {
            const field = [...document.querySelectorAll("textarea")].find((f) => (f.value || "").includes("（编辑测试）"));
            if (!field) return "no-field";
            const rect = field.getBoundingClientRect();
            const button = [...document.querySelectorAll("button, div[role=button]")].find((b) => {
              const r = b.getBoundingClientRect();
              return r.y > rect.bottom - 10 && r.y < rect.bottom + 140 && /发送|确定|保存/.test((b.textContent || "").trim());
            });
            if (!button) return "no-confirm";
            button.click();
            return "confirm-clicked";
          })()`);
          finderNote += "enter-miss(" + confirm + ")；";
          await waitUntil("edit_message 请求（确认按钮）", seenEdit, 6000, 500).catch(() => {});
        }
        editFlow = "resent(" + where.tag + (where.inline ? ",inline" : ",composer") + ")";
        console.log("[api-recon] 编辑后重发完成，等待回复…");
        await delay(3000);
        await waitReplyDone(2);
        await delay(6000);
      } catch (error) {
        editFlow = "flow-failed: " + error.message;
      }
    }
    await collectTurn("编辑消息回合（" + editFlow + "，CDP 全量实抓）", phaseIds);
  }

  // —— 逐消息 token 对账：编辑/思考回合后重新拉 history_messages ——
  if (SEND) {
    const usageDump = await evaluate(cdp, `(async () => {
      const sessionId = (location.pathname.match(/\\/chat\\/s\\/([^/?#]+)/) || [])[1];
      if (!sessionId) return "no-session";
      const token = JSON.parse(localStorage.getItem("userToken")).value;
      const response = await fetch("/api/v0/chat/history_messages?chat_session_id=" + encodeURIComponent(sessionId),
        { credentials: "include", headers: { Authorization: "Bearer " + token } });
      const data = await response.json();
      const messages = (data.data && data.data.biz_data && data.data.biz_data.chat_messages) || [];
      return JSON.stringify(messages.map((m) => ({ id: m.message_id, role: m.role,
        tokens: m.accumulated_token_usage, fragmentTypes: (m.fragments || []).map((f) => f.type) })), null, 2);
    })()`);
    section("本会话逐消息 token（" + sessionUrl + "，history_messages 实抓）", "```json\n" + usageDump + "\n```");
  }

  // —— --leim：x-hif-leim 源码定位 + 不带该头的 API 探测 ——
  if (LEIM) {
    const scriptUrls = JSON.parse(await evaluate(cdp, `JSON.stringify([...new Set(
      performance.getEntriesByType("resource").map((r) => r.name).filter((n) => /\\.js(\\?|$)/.test(n)))].slice(0, 60))`));
    const matches = [];
    for (const url of scriptUrls) {
      try {
        const text = await fetch(url).then((response) => response.text());
        const regex = /(.{220})(leim)(.{340})/gi;
        let match;
        while ((match = regex.exec(text)) && matches.length < 10) {
          matches.push("// " + url.split("/").pop().slice(0, 48) + "\n" + match[0].replace(/\s+/g, " "));
        }
      } catch { /* CDN 抓取失败 */ }
    }
    section("x-hif-leim 源码定位（bundle grep 关键词 leim）", matches.length
      ? "```js\n" + matches.join("\n\n") + "\n```"
      : "全部 " + scriptUrls.length + " 个 bundle 未命中 leim 字样");

    const probes = await evaluate(cdp, `(async () => {
      const token = JSON.parse(localStorage.getItem("userToken")).value;
      const headers = { "Content-Type": "application/json", Authorization: "Bearer " + token };
      const call = async (method, path, body) => {
        const response = await fetch(path, { method, headers, credentials: "include", body });
        const data = await response.json().catch(() => null);
        return method + " " + path + " → HTTP " + response.status + " code=" + (data && data.code) + " msg=" + JSON.stringify(data && data.msg);
      };
      return [
        await call("GET", "/api/v0/chat_session/fetch_page?lte_cursor.pinned=false"),
        await call("POST", "/api/v0/chat/create_pow_challenge", JSON.stringify({ target_path: "/api/v0/chat/completion" })),
      ].join("\\n");
    })()`);
    section("不带 x-hif-leim 的 API 探测（页面 fetch，仅 Bearer）", "```\n" + probes + "\n```");
  }

  // —— --ops：管理操作真实 API（全部作用于本次创建的测试会话，最后删除它）——
  if (SEND && OPS) {
    const sessionId = (sessionUrl.match(/\/chat\/s\/([^/?#]+)/) || [])[1] || "";
    const rowSelector = sessionId ? `a[href*="${sessionId}"]` : `a[href*="/chat/s/"]`;
    const openMenu = async () => {
      const opened = await evaluate(cdp, `(() => {
        const row = document.querySelector(${JSON.stringify(rowSelector)});
        if (!row) return "row-not-found";
        const button = row.querySelector("button, [role=button]");
        if (!button) return "no-button";
        button.click();
        return "opened";
      })()`);
      await delay(700);
      return opened;
    };
    const clickMenuItem = (patternSource) => evaluate(cdp, `(() => {
      const pattern = new RegExp(${JSON.stringify(patternSource)});
      // 真实菜单容器：ds-dropdown-menu（recon-dom 实抓），取最后一个可见的
      const menus = [...document.querySelectorAll("div.ds-dropdown-menu")].filter((m) => m.offsetParent !== null);
      const menu = menus[menus.length - 1];
      if (!menu) return "menu-not-found";
      const option = [...menu.querySelectorAll(".ds-dropdown-menu-option")]
        .find((item) => pattern.test((item.textContent || "").trim()));
      if (!option) return "item-not-found(菜单项实况: " +
        [...menu.querySelectorAll(".ds-dropdown-menu-option")].map((item) => item.textContent.trim()).join("|") + ")";
      option.click();
      return "clicked:" + option.textContent.trim();
    })()`);

    // 1. 重命名
    {
      const phaseIds = snapshotIds();
      const titleBefore = await evaluate(cdp, `(() => (document.querySelector(${JSON.stringify(rowSelector)}) || { textContent: "" }).textContent || "")()`);
      const menuOpened = await openMenu();
      const clickedItem = await clickMenuItem("^重命名$");
      let flow = menuOpened + "/" + clickedItem;
      const marker = titleBefore.trim().slice(0, 6);
      if (clickedItem.startsWith("clicked") && marker) {
        try {
          const box = await waitUntil("重命名输入框", () => evaluate(cdp, `(() => {
            const field = [...document.querySelectorAll("input, textarea")].find((x) =>
              !x.closest("#dtw-root") && (x.value || "").includes(${JSON.stringify(marker)}));
            if (!field) return null;
            field.focus();
            const rect = field.getBoundingClientRect();
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
          })()`), 6000, 600);
          await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
          await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
          await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", modifiers: 2, key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
          await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 2, key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
          await cdp.call("Input.insertText", { text: "侦查重命名测试" });
          await delay(300);
          await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
          await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
          flow += "/typed";
        } catch (error) { flow += "/editor-miss:" + error.message; }
      }
      console.log("[api-recon] 重命名：" + flow);
      await delay(4000);
      await collectTurn("管理操作·重命名（" + flow + "）", phaseIds);
    }

    // 2/3. 置顶 → 取消置顶
    for (const [label, name] of [["^置顶$", "置顶"], ["^取消置顶$", "取消置顶"]]) {
      const phaseIds = snapshotIds();
      const menuOpened = await openMenu();
      const clickedItem = await clickMenuItem(label);
      console.log("[api-recon] " + name + "：" + clickedItem);
      await delay(3000);
      await collectTurn("管理操作·" + name + "（" + menuOpened + "/" + clickedItem + "）", phaseIds);
      if (!clickedItem.startsWith("clicked")) break;
    }

    // 4. 重新生成（助手条里用户条没有的图标）
    {
      const phaseIds = snapshotIds();
      const spot = await evaluate(cdp, `(() => {
        const message = document.querySelectorAll("div.ds-message")[1];
        if (!message) return null;
        const rect = message.getBoundingClientRect();
        return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.bottom - 14) };
      })()`);
      let flow = "no-message";
      if (spot) {
        await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: spot.x, y: spot.y });
        await delay(700);
        const target = await evaluate(cdp, `(() => {
          const messages = [...document.querySelectorAll("div.ds-message")];
          const userRect = messages[0] && messages[0].getBoundingClientRect();
          const assistRect = messages[1] && messages[1].getBoundingClientRect();
          if (!userRect || !assistRect) return "rects-missing";
          const iconButtons = [...document.querySelectorAll("button, div[role=button]")].filter((b) => {
            if (b.offsetParent === null || (b.textContent || "").trim()) return false;
            const rect = b.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          }).map((b) => ({ rect: b.getBoundingClientRect(), svg: (b.querySelector("svg")?.innerHTML || "").replace(/\\s+/g, "") }));
          const near = (rect) => iconButtons.filter((x) => x.rect.y >= rect.bottom - 30 && x.rect.y <= rect.bottom + 60);
          const userBar = near(userRect);
          const assistBar = near(assistRect);
          const userSvgs = new Set(userBar.map((x) => x.svg));
          const distinct = assistBar.filter((x) => !userSvgs.has(x.svg));
          if (!distinct.length) return "no-distinct(userBar=" + userBar.length + ",assistBar=" + assistBar.length + ")";
          const rect = distinct[0].rect;
          return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
        })()`);
        if (typeof target === "object") {
          await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: target.x, y: target.y });
          await delay(150);
          await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", x: target.x, y: target.y, button: "left", clickCount: 1 });
          await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: target.x, y: target.y, button: "left", clickCount: 1 });
          flow = "clicked";
          await waitReplyDone(2).catch(() => {});
          await delay(5000);
        } else { flow = target; }
      }
      console.log("[api-recon] 重新生成：" + flow);
      await collectTurn("管理操作·重新生成（" + flow + "）", phaseIds);
    }

    // 5. 删除本测试会话（菜单项 → 确认弹窗）
    {
      const phaseIds = snapshotIds();
      const menuOpened = await openMenu();
      const clickedItem = await clickMenuItem("^删除$");
      let confirmNote = "skip";
      if (clickedItem.startsWith("clicked")) {
        await delay(1200);
        confirmNote = await evaluate(cdp, `(() => {
          const buttons = [...document.querySelectorAll("button, div[role=button]")].filter((b) => b.offsetParent !== null);
          const candidates = buttons.filter((b) => /删除|确认|确定/.test((b.textContent || "").trim()));
          if (!candidates.length) return "no-confirm(可见按钮: " +
            buttons.map((b) => (b.textContent || "").trim().slice(0, 8)).filter(Boolean).join("|").slice(0, 200) + ")";
          const confirm = candidates[candidates.length - 1];
          confirm.click();
          return "confirmed:" + (confirm.textContent || "").trim();
        })()`);
      }
      console.log("[api-recon] 删除会话：" + clickedItem + " / " + confirmNote);
      await delay(4000);
      await collectTurn("管理操作·删除会话（" + menuOpened + "/" + clickedItem + " / " + confirmNote + "）", phaseIds);
    }

    // 6. 会话搜索：输入框藏在图标后面 —— 逐个点侧栏顶部图标按钮直到出现可见 input
    {
      const phaseIds = snapshotIds();
      let searchNote = "";
      let searchBox = null;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        searchBox = await evaluate(cdp, `(() => {
          const input = [...document.querySelectorAll("input")]
            .find((x) => x.offsetParent !== null && x.getBoundingClientRect().width > 40);
          if (input) { input.focus(); const rect = input.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; }
          const buttons = [...document.querySelectorAll("button, div[role=button]")].filter((b) => {
            if (b.offsetParent === null || (b.textContent || "").trim() || b.closest("#dtw-root")) return false;
            const rect = b.getBoundingClientRect();
            return rect.width > 0 && rect.x < 320 && rect.y > 80 && rect.y < 280;
          });
          const button = buttons[${attempt}];
          if (!button) return null;
          const rect = button.getBoundingClientRect();
          return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, trigger: true };
        })()`);
        if (!searchBox) break;
        await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", x: searchBox.x, y: searchBox.y, button: "left", clickCount: 1 });
        await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: searchBox.x, y: searchBox.y, button: "left", clickCount: 1 });
        await delay(700);
        const opened = await evaluate(cdp, `Boolean([...document.querySelectorAll("input")]
          .find((x) => x.offsetParent !== null && x.getBoundingClientRect().width > 40))`);
        if (opened) { searchNote = "第" + (attempt + 1) + "个图标触发"; break; }
        if (searchBox.trigger) continue;
      }
      if (searchBox && !searchBox.trigger) {
        await cdp.call("Input.insertText", { text: "收到" });
        await delay(3500);
        console.log("[api-recon] 会话搜索已输入（" + searchNote + "）");
        await collectTurn("管理操作·会话搜索（" + searchNote + "，关键词：收到）", phaseIds);
        // 清空搜索，恢复侧栏
        await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", modifiers: 2, key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
        await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 2, key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
        await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
        await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
      } else {
        section("管理操作·会话搜索", "点击侧栏图标后仍未出现输入框（" + searchNote + "）");
      }
    }
  }

  // —— --search（独立模式）：定位会话搜索入口并抓搜索 API ——
  if (SEARCH && !SEND) {
    const phaseIds = snapshotIds();
    const findInput = `(() => {
      const input = [...document.querySelectorAll("input, [contenteditable=true]")]
        .find((x) => !x.closest("#dtw-root") && x.offsetParent !== null && x.getBoundingClientRect().width > 40);
      if (!input) return null;
      input.focus();
      const rect = input.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`;
    let box = null;
    let note = "";
    // 1) Ctrl+K
    await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", modifiers: 2, key: "k", code: "KeyK", windowsVirtualKeyCode: 75 });
    await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 2, key: "k", code: "KeyK", windowsVirtualKeyCode: 75 });
    await delay(800);
    box = await evaluate(cdp, findInput);
    if (box) note = "ctrl+k";
    // 2) 逐个点侧栏顶栏可点元素（含带文字的）直到出现输入框
    for (let attempt = 0; attempt < 10 && !box; attempt += 1) {
      const target = await evaluate(cdp, `(() => {
        const clicks = [...document.querySelectorAll("button, div[role=button], a")].filter((el) => {
          if (el.closest("#dtw-root") || el.offsetParent === null) return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.x < 330 && rect.y < 150;
        });
        const el = clicks[${attempt}];
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2,
          label: ((el.textContent || "").trim().slice(0, 10)) || "(icon)" };
      })()`);
      if (!target) break;
      await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", x: target.x, y: target.y, button: "left", clickCount: 1 });
      await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: target.x, y: target.y, button: "left", clickCount: 1 });
      await delay(800);
      box = await evaluate(cdp, findInput);
      if (box) { note = "点击「" + target.label + "」触发"; break; }
    }
    if (box) {
      await cdp.call("Input.insertText", { text: "收到" });
      await delay(3500);
      console.log("[api-recon] 搜索已输入（" + note + "）");
      await collectTurn("会话搜索（" + note + "，关键词：收到）", phaseIds);
    } else {
      const dump = await evaluate(cdp, `(() => JSON.stringify([...document.querySelectorAll("button, div[role=button], a")]
        .filter((el) => el.offsetParent !== null)
        .map((el) => { const rect = el.getBoundingClientRect(); return rect.width > 0 && rect.x < 330
          ? (((el.textContent || "").trim().slice(0, 12)) || "(icon)@y" + Math.round(rect.y)) : null; })
        .filter(Boolean)))()`);
      section("会话搜索", "Ctrl+K 与顶栏按钮均未唤出输入框。侧栏可点元素清单：\n\n```\n" + dump + "\n```");
    }
  }

  const modeTags = [SEND && "--send", THINK && "--think", EDIT && "--edit", LEIM && "--leim", OPS && "--ops", SEARCH && "--search"].filter(Boolean).join(" ");
  await fs.writeFile(outputPath, "# DeepSeek Web API 真实抓包侦查（" + new Date().toISOString() +
    (modeTags ? "，" + modeTags + "）\n\n" : "）\n\n") + sections.join("\n"), "utf8");
  console.log("[api-recon] 完成 → " + outputPath);
} finally {
  cdp?.close();
  chrome.kill();
}
