/**
 * Live end-to-end test: real Chrome + real extension + real chat.deepseek.com.
 *
 * Requires a one-time manual login in the opened window (profile: .live-profile).
 * Sends ONE real chat message and runs ONE real memory-update job.
 *
 *   node live-test.mjs
 */
import { spawn, execSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const profilePath = path.join(here, "..", ".live-profile");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const step = (message) => console.log(`[live] ${message}`);
const fail = (message) => { throw new Error(message); };

// Clean up leftovers from a previous run: a Chrome still holding the profile
// would make the new instance exit silently, and a stale DevToolsActivePort
// would point at a dead port.
try {
  execSync(
    `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"name='chrome.exe'\\" | ` +
    `Where-Object { $_.CommandLine -like '*live-profile*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"`,
    { stdio: "ignore" },
  );
} catch { /* No leftover process. */ }
await fs.rm(path.join(profilePath, "DevToolsActivePort"), { force: true });

let chromeExited = "";
const chrome = spawn(chromePath, [
  "--no-first-run",
  "--remote-debugging-port=0",
  // Chrome 137+ removed --load-extension; unpacked loading goes through the
  // Extensions CDP domain, which this flag enables.
  "--enable-unsafe-extension-debugging",
  `--user-data-dir=${profilePath}`,
  "--window-size=1280,900",
  "https://chat.deepseek.com/",
], { windowsHide: false });
chrome.on("exit", (code) => { chromeExited = `Chrome 提前退出（code=${code}）`; });

async function waitForDebugPort() {
  const activePortPath = path.join(profilePath, "DevToolsActivePort");
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (chromeExited) fail(chromeExited);
    try {
      const [port] = (await fs.readFile(activePortPath, "utf8")).trim().split(/\r?\n/);
      if (port) return Number(port);
    } catch { /* endpoint not written yet */ }
    await delay(100);
  }
  throw new Error("Chrome DevTools endpoint did not start");
}

async function listTargets(port) {
  return fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
}

async function connect(webSocketUrl, logs = null) {
  const socket = new WebSocket(webSocketUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.consoleAPICalled" && logs) {
      logs.push(`[console.${message.params.type}] ` + message.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
    }
    if (message.method === "Runtime.exceptionThrown" && logs) {
      logs.push(`[exception] ` + (message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text));
    }
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });
  return {
    call(method, params = {}) {
      sequence += 1;
      return new Promise((resolve, reject) => {
        pending.set(sequence, { resolve, reject });
        socket.send(JSON.stringify({ id: sequence, method, params }));
      });
    },
    close() { socket.close(); },
  };
}

async function evaluate(cdp, expression) {
  const result = await cdp.call("Runtime.evaluate", {
    expression, awaitPromise: true, returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result.value;
}

const pageEval = (expression) => evaluate(page, expression);
const waitUntil = async (description, check, timeoutMs = 60000, intervalMs = 1500) => {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) fail(`等待超时：${description}`);
    await delay(intervalMs);
  }
};

let page;
let worker;
const pageLogs = [];
const workerLogs = [];
let popupCdp;
try {
  const port = await waitForDebugPort();
  step(`DevTools 端口 ${port}`);

  // Try CDP unpacked loading first; this Chrome build may not expose it.
  const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((response) => response.json());
  const browser = await connect(version.webSocketDebuggerUrl);
  let extensionId = "";
  try {
    const loaded = await browser.call("Extensions.loadUnpacked", { path: path.join(here, "..", "core") });
    extensionId = loaded?.id || "";
    step(`已通过 CDP 加载扩展（${extensionId}）`);
  } catch {
    step("CDP 加载不可用，等待已加载的扩展（如未加载：请在打开的窗口中访问 chrome://extensions → 开发者模式 → 加载已解压的扩展程序 → 选择本目录）…");
  } finally {
    browser.close();
  }

  const pageTarget = await waitUntil("DeepSeek 页面", async () =>
    (await listTargets(port)).find((item) => item.type === "page" && /chat\.deepseek\.com/.test(item.url || "")), 30000, 500);
  page = await connect(pageTarget.webSocketDebuggerUrl, pageLogs);
  await page.call("Page.enable");
  await page.call("Runtime.enable");
  // 扫描循环是 rAF 门控的：窗口被最小化/遮挡时 rAF 停摆，上下文推送会超时
  try { await page.call("Page.bringToFront"); } catch { /* 部分环境不支持 */ }
  step("已连接 DeepSeek 页面");

  const workerTarget = await waitUntil("扩展 Service Worker（可手动加载，等待 3 分钟）", async () => {
    const targets = await listTargets(port);
    const workerItem = targets.find((item) =>
      item.type === "service_worker" && /\/background\.js$/.test(item.url || ""));
    if (workerItem) {
      if (extensionId && !workerItem.url.startsWith(`chrome-extension://${extensionId}/`)) return false;
      return workerItem;
    }
    return false;
  }, 180000, 2000);
  worker = await connect(workerTarget.webSocketDebuggerUrl);
  await worker.call("Runtime.enable");
  // Chrome 会缓存 profile 里解压扩展的 SW 字节码：不重载就会跑旧代码
  // （新 popup 打旧 SW，fs-* 消息全部无响应）。强制从磁盘重读。
  // reload 会当场杀掉 SW，evaluate 的 Promise 永远不落地 —— 用超时竞速，不 await 它。
  const staleWorkerId = workerTarget.id;
  await Promise.race([
    evaluate(worker, "chrome.runtime.reload(), \"ok\"").catch(() => {}),
    delay(4000),
  ]);
  worker.close();
  worker = null;
  const freshWorkerTarget = await waitUntil("重载后的 Service Worker", async () => {
    const targets = await listTargets(port);
    const items = targets.filter((item) => item.type === "service_worker"
      && /\/background\.js$/.test(item.url || "") && item.id !== staleWorkerId);
    return items[0] || null;
  }, 60000, 1000);
  worker = await connect(freshWorkerTarget.webSocketDebuggerUrl, workerLogs);
  await worker.call("Runtime.enable");
  const freshness = await evaluate(worker, "typeof DTWFS");
  if (freshness !== "object") fail(`扩展 Service Worker 仍是旧代码（DTWFS=${freshness}）`);
  step("已连接扩展 Service Worker（已强制重载，代码为最新）");

  // The page may have loaded before the extension existed; re-inject.
  await page.call("Page.reload");
  await delay(3000);
  step("已重载 DeepSeek 页面");

  // -- 登录检测：没有输入框或出现登录 CTA 则等用户在窗口里登录 --
  step("检测登录状态（若窗口显示登录页，请在其中登录 DeepSeek，最长等待 3 分钟）…");
  await waitUntil("DeepSeek 登录", () => pageEval(`(() => {
    // 登录后才有原生侧栏的「开启新对话」入口（DOM 存在即可，不含隐藏态）
    return [...document.querySelectorAll("span")]
      .some((element) => element.textContent.trim() === "开启新对话");
  })()`), 180000, 2500);
  step("已登录");

  // -- 种子项目与记忆（直接写 storage，绕过 prompt 类 UI）--
  const storageGet = async () => evaluate(worker, "chrome.storage.local.get(null)");
  const storageSet = (entries) => evaluate(worker,
    `chrome.storage.local.set(${JSON.stringify(entries).replace(/</g, "\\u003c")})`);

  await storageSet({
    "dtw.sidebar.v1": {
      tasks: [{ id: "task_live1", name: "MemoryMVP实测", collapsed: false, conversationIds: [], sourceEpoch: 1, createdAt: new Date().toISOString() }],
      conversations: {},
      selectedTaskId: "task_live1",
    },
    "dtw.memory.v1": {
      settings: { acknowledgedCloudSummary: true, autoInject: true, autoAnalyze: true },
      taskMemories: {
        task_live1: {
          version: 1, sourceEpoch: 1,
          summary: "这是浏览器插件记忆功能的真实测试任务。",
          nextStep: "验证自动注入与自动整理链路。",
          items: [{ id: "goal_live", kind: "goal", text: "验证自动注入与自动整理链路", state: "active" }],
        },
      },
    },
  });
  // 上一轮可能留下 status:"ok"，会让「文件夹授权」的等待瞬间假通过；
  // 残留的文件夹句柄更会让 SW 以「文件夹为真相源」合并、抹掉本轮只写进
  // storage 的种子记忆（taskMemories 被清空）——连句柄库一起清掉。
  // deleteDatabase 可能被挂起的连接阻塞、延迟到授权后才真正执行（曾把
  // popup 刚存的句柄删掉 → reconcile unauthorized），必须删后验证为空。
  await evaluate(worker, `chrome.storage.local.remove("dtw.fs.v1")`);
  const cleaned = await evaluate(worker, `(async () => {
    for (let i = 0; i < 15; i += 1) {
      await new Promise((resolve) => {
        const request = indexedDB.deleteDatabase("dtw-fs");
        request.onsuccess = request.onerror = request.onblocked = () => resolve();
      });
      const handle = await DTWFS.loadStoredHandle().catch(() => null);
      if (!handle) return "clean";
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return "dirty";
  })()`);
  if (cleaned !== "clean") fail("记忆文件夹句柄库清理失败（dtw-fs 删不掉）");
  step("已种子项目 task_live1（自动注入/自动整理已开启，记忆文件夹已去授权）");

  await waitUntil("工作台挂载", () => pageEval(
    `Boolean(document.querySelector('.dtw-tools-root') && document.querySelector('.dtw-project-group[data-key="p:task_live1"]'))`), 20000);
  step("工作台已挂载");

  // 监听注入事件（MAIN world）
  await pageEval(`(() => {
    window.__dtwLive = { context: "", injected: null };
    window.addEventListener("dtw:memory-context", (event) => {
      try { window.__dtwLive.context = JSON.parse(event.detail).block || ""; } catch {}
    });
    window.addEventListener("dtw:memory-injected", (event) => {
      try { window.__dtwLive.injected = JSON.parse(event.detail); } catch {}
    });
  })()`);
  const contextBlock = await waitUntil("记忆上下文推送", () =>
    pageEval(`window.__dtwLive.context.includes("真实测试任务") ? window.__dtwLive.context : ""`), 15000, 1000);
  step(`上下文已推送（${contextBlock.length} 字符）`);

  // -- 新会话发一条真实消息 --
  await pageEval(`(() => {
    const newChat = [...document.querySelectorAll("span")].find((element) => element.textContent.trim() === "开启新对话");
    if (newChat) newChat.closest("button, div[role=button], a")?.click() || newChat.click();
  })()`);
  await delay(1500);
  const editorBox = await waitUntil("输入框", () => pageEval(`(() => {
    const editor = [...document.querySelectorAll('textarea, [contenteditable="true"]')]
      .find((item) => !item.closest("#dtw-root"));
    if (!editor) return null;
    editor.focus();
    const rect = editor.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  })()`), 20000);
  await page.call("Input.dispatchMouseEvent", { type: "mousePressed", x: editorBox.x, y: editorBox.y, button: "left", clickCount: 1 });
  await page.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: editorBox.x, y: editorBox.y, button: "left", clickCount: 1 });
  await page.call("Input.insertText", { text: "插件记忆注入真实测试：请用大约两百字介绍一下你自己，正常流式输出，不要只回两三句。" });
  await delay(400);
  await page.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await page.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  // Enter 偶发不提交（今天出现过一次）：文本仍留在输入框时改点发送按钮兜底
  await delay(2000);
  const stillInEditor = await pageEval(`Boolean([...document.querySelectorAll('textarea, [contenteditable="true"]')]
    .find((item) => !item.closest('#dtw-root'))?.textContent?.includes('插件记忆注入真实测试'))`);
  if (stillInEditor) {
    const sent = await pageEval(`(() => {
      const control = [...document.querySelectorAll('button, div[role=button]')]
        .find((item) => /发送|send/i.test((item.getAttribute('aria-label') || '') + item.textContent));
      if (!control) return false;
      control.click();
      return true;
    })()`);
    step(`Enter 未提交，已改点发送按钮（${sent ? "找到" : "未找到发送按钮"}）`);
  }
  step("消息已发送，等待注入事件…");

  // 新会话默认先进「未分类会话」；真实整理测试需要一个已归属会话，
  // 因此在生成期间模拟用户手动把它移入项目，不依赖自动归类的模型判断。
  const liveConversationId = await waitUntil("新会话入库", async () => {
    const id = await pageEval(`(location.pathname.match(/\\/chat\\/s\\/([^/?#]+)/) || [])[1] || ""`);
    if (!id) return false;
    const stored = await storageGet();
    return stored["dtw.sidebar.v1"]?.conversations?.[id] ? id : false;
  }, 30000, 800);
  await evaluate(worker, `(async () => {
    const key = "dtw.sidebar.v1";
    const stored = await chrome.storage.local.get(key);
    const sidebar = stored[key];
    const task = sidebar.tasks.find((item) => item.id === "task_live1");
    for (const item of sidebar.tasks) item.conversationIds = item.conversationIds.filter((id) => id !== ${JSON.stringify(liveConversationId)});
    if (!task.conversationIds.includes(${JSON.stringify(liveConversationId)})) task.conversationIds.unshift(${JSON.stringify(liveConversationId)});
    sidebar.selectedTaskId = "task_live1";
    sidebar.lastSelectedTaskId = "task_live1";
    await chrome.storage.local.set({ [key]: sidebar });
  })()`);
  step(`已手动移入项目（conv=${liveConversationId.slice(0, 8)}…）`);

  let injected;
  try {
    injected = await waitUntil("自动注入事件", () => pageEval(`window.__dtwLive.injected`), 20000, 500);
  } catch (error) {
    const dump = await pageEval(`(() => JSON.stringify({
      path: location.pathname,
      editorText: [...document.querySelectorAll('textarea, [contenteditable="true"]')]
        .find((item) => !item.closest('#dtw-root'))?.textContent?.slice(0, 40) || "",
      messages: document.querySelectorAll('div.ds-message').length,
      generating: [...document.querySelectorAll('button, div[role=button]')]
        .some((item) => /停止生成|停止回答/i.test((item.getAttribute('aria-label') || '') + (item.textContent || ''))),
      scanTick: document.querySelector('#dtw-root')?.dataset.scanTick || '?',
      contextPushed: Boolean(window.__dtwLive && window.__dtwLive.context),
    }))()`);
    step(`注入事件未到，现场：${dump}`);
    throw error;
  }
  step(`已注入（target=${injected.target}, ${injected.blockChars} 字符）`);

  // -- 等回复完成（无停止按钮 + 消息稳定）--
  await waitUntil("回复完成", () => pageEval(`(() => {
    const generating = [...document.querySelectorAll('button, div[role=button]')]
      .some((item) => /停止生成|停止回答/i.test((item.getAttribute("aria-label") || "") + (item.textContent || "")));
    const replies = document.querySelectorAll("div.ds-message").length;
    return !generating && replies >= 1 ? replies : false;
  })()`), 120000, 2000);
  step("回复已完成");

  // -- 崩溃取证：生成期间是否有异常 DOM 节点累积 --
  const sidebarHealth = await pageEval(`(() => {
    const rows = [...document.querySelectorAll('a[href*="/chat/s/"]')];
    const ids = rows.map((row) => (row.getAttribute('href').match(/\\/chat\\/s\\/([^/?#]+)/) || [])[1]);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    return JSON.stringify({ rows: rows.length, dupes: [...new Set(dupes)].length,
      scanTick: document.querySelector('#dtw-root')?.dataset.scanTick || "?" });
  })()`);
  step(`侧栏健康: ${sidebarHealth}`);

  // -- 等后台计数（3 秒稳定 + 1.5 秒轮询）--
  step("等待后台轮次计数…");
  await delay(6000);
  let counted;
  try {
    counted = await waitUntil("轮次计数", async () => {
      const stored = await storageGet();
      const task = stored["dtw.sidebar.v1"]?.tasks?.find((item) => item.id === "task_live1");
      const memory = stored["dtw.memory.v1"] || {};
      if (!task?.conversationIds?.includes(liveConversationId)
        || memory.taskMemories?.task_live1?.pendingTurns !== 1) return false;
      return { convId: liveConversationId, fingerprints: Object.keys(memory.turnFingerprints || {}) };
    }, 30000, 2000);
  } catch (error) {
    const stored = await storageGet();
    const sidebarDump = stored["dtw.sidebar.v1"] || {};
    step(`计数未落地，现场：tasks=${JSON.stringify(sidebarDump.tasks?.map((t) => [t.id, t.conversationIds]))} ` +
      `selected=${JSON.stringify(sidebarDump.selectedTaskId)} last=${JSON.stringify(sidebarDump.lastSelectedTaskId)} ` +
      `convKnown=${Boolean(sidebarDump.conversations && Object.keys(sidebarDump.conversations).length)} ` +
      `jobs=${Object.values(stored["dtw.memory.v1"]?.jobs || {}).map((j) => `${j.taskId}:${j.status}`).join(",") || "none"} ` +
      `taskMemories=${JSON.stringify(stored["dtw.memory.v1"]?.taskMemories?.task_live1 ? { pending: stored["dtw.memory.v1"].taskMemories.task_live1.pendingTurns } : null)} ` +
      `fingerprints=${JSON.stringify(Object.keys(stored["dtw.memory.v1"]?.turnFingerprints || {}))} ` +
      `path=${await pageEval("location.pathname")}`);
    throw error;
  }
  step(`手动归项目后计数成功（conv=${counted.convId.slice(0, 8)}…），pendingTurns=1`);

  // -- 历史接口回归（INVALID_TOKEN 重试）+ 服务端已存注入块 --
  const history = await pageEval(`(async () => {
    const requestId = "live_" + Math.random().toString(36).slice(2);
    const result = new Promise((resolve) => {
      window.addEventListener("dtw:history-result", (event) => resolve(JSON.parse(event.detail)), { once: true });
    });
    window.dispatchEvent(new CustomEvent("dtw:history-request", { detail: JSON.stringify({ requestId, sessionId: ${JSON.stringify(counted.convId)} }) }));
    const timeout = new Promise((resolve) => setTimeout(() => resolve({ error: "timeout" }), 20000));
    return Promise.race([result, timeout]);
  })()`);
  if (history.error) fail(`历史接口失败：${history.error}`);
  const messages = history?.data?.data?.biz_data?.chat_messages || [];
  const storedInjected = messages.some((message) =>
    String(message.role).toUpperCase() === "USER"
    && JSON.stringify(message).includes("<task_memory>"));
  if (!messages.length) fail(`历史接口无消息（响应：${JSON.stringify(history.data).slice(0, 200)}）`);
  step(`历史接口 OK（${messages.length} 条消息，服务端已存注入块：${storedInjected}）`);

  // -- 文件夹存储：人工授权（任选文件夹）→ 迁移导出 → 存档 → 手改重载 → 降级恢复 --
  // 所有文件断言走句柄（扩展视角），不依赖 Node 磁盘路径。
  const extId = (workerTarget.url.match(/chrome-extension:\/\/([^/]+)/) || [])[1] || extensionId;
  if (!extId) fail("无法确定扩展 ID，无法打开 popup 页");
  // 清掉历史残留的目录句柄：否则 popup 会静默恢复旧授权（指向可能已不存在的
  // 目录），选择器不弹、文件写去别处，断言就失效了。
  // 注意不能用 deleteDatabase——被占用时 onblocked 不执行、连接空闲后补刀，
  // 会把刚保存的新句柄延迟删掉。精确删 "root" 这一个 key。
  await evaluate(worker, `(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("dtw-fs", 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("handles")) request.result.createObjectStore("handles");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction("handles", "readwrite");
        tx.objectStore("handles").delete("root");
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } finally { db.close(); }
    // 同时清掉 SW 的内存缓存：initFs 在测试清库之前就可能用旧句柄自愈并缓存
    fsRuntime.root = undefined;
    fsRuntime.records = null;
    return "cleared";
  })()`);
  // window.open 无用户激活会被弹窗拦截挡掉，直接用 CDP 建标签页
  const popupUrl = `chrome-extension://${extId}/popup/popup.html`;
  let popupInfo = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(popupUrl)}`, { method: "PUT" })
    .then((response) => response.json()).catch(() => null);
  if (!popupInfo?.webSocketDebuggerUrl) {
    popupInfo = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(popupUrl)}`)
      .then((response) => response.json()).catch(() => null);
  }
  const popupTarget = popupInfo?.webSocketDebuggerUrl
    ? popupInfo
    : await waitUntil("popup 标签页", async () =>
      (await listTargets(port)).find((item) => item.type === "page" && /popup\.html$/.test(item.url || "")), 30000, 500);
  popupCdp = await connect(popupTarget.webSocketDebuggerUrl);
  await popupCdp.call("Runtime.enable");

  const authorizeClick = async () => {
    const box = await waitUntil("授权按钮", () => evaluate(popupCdp, `(() => {
      const button = document.getElementById("authorize");
      if (!button) return null;
      const rect = button.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`), 15000, 1000);
    // CDP 合成输入带 transient activation，showDirectoryPicker 才会打开原生选择器
    await popupCdp.call("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
    await popupCdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
  };

  step("请在弹出的 popup 页中点击「选择或重新授权文件夹」，选择本仓库下的 .live-fs 文件夹（勿选其他已有内容的文件夹）…");
  await authorizeClick();
  await waitUntil("文件夹授权", async () =>
    (await storageGet())["dtw.fs.v1"]?.status === "ok", 600000, 2000);
  step("文件夹已授权");
  // status=ok 只说明 setFsStatus 跑过；reconcile 若抛错会被吞掉。直接向 SW 要结果。
  // 授权后 SW 可能刚好被闲置回收、随 evaluate 冷启动：先等自恢复跑完再问，
  // 失败时 dump 句柄库现场并重试一次。
  await delay(1500);
  let authorizeResult = await evaluate(worker, `(async () => {
    try { return await reconcile("merge"); } catch (error) { return { ok: false, error: String(error?.stack || error) }; }
  })()`);
  if (!authorizeResult?.ok) {
    const scene = await evaluate(worker, `(async () => ({
      handle: Boolean(await DTWFS.loadStoredHandle().catch(() => null)),
      dbs: (await indexedDB.databases().catch(() => [])).map((db) => db.name),
      fs: (await chrome.storage.local.get("dtw.fs.v1"))["dtw.fs.v1"] || null,
    }))()`);
    step(`reconcile 首试失败（${JSON.stringify(authorizeResult)}），现场：${JSON.stringify(scene)}，2.5s 后重试…`);
    await delay(2500);
    authorizeResult = await evaluate(worker, `(async () => {
      try { return await reconcile("merge"); } catch (error) { return { ok: false, error: String(error?.stack || error) }; }
    })()`);
  }
  if (!authorizeResult?.ok) fail(`reconcile 失败：${JSON.stringify(authorizeResult)}`);
  step(`reconcile OK（skipped=${JSON.stringify(authorizeResult.skipped || [])}）`);
  const handleInfo = await evaluate(worker, `(async () => {
    const handle = await DTWFS.loadStoredHandle();
    if (!handle) return { error: "NO HANDLE" };
    const entries = [];
    try { for await (const [name, entry] of handle.entries()) entries.push(entry.kind + ":" + name); }
    catch (error) { return { name: handle.name, error: String(error) }; }
    return { name: handle.name, entries };
  })()`);
  if (handleInfo.error) fail(`句柄异常：${JSON.stringify(handleInfo)}`);
  step(`记忆文件夹：${handleInfo.name}（${(handleInfo.entries || []).join("、") || "空"}）`);
  if (handleInfo.name !== ".live-fs") fail(`选错了文件夹：授权的是「${handleInfo.name}」，请选本仓库下的 .live-fs（空文件夹）后重跑`);

  const readViaHandle = (relativePath) => evaluate(worker, `(async () => {
    const root = await DTWFS.loadStoredHandle();
    const parts = ${JSON.stringify(relativePath)}.split("/");
    let dir = root;
    for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
    const file = await (await dir.getFileHandle(parts[parts.length - 1])).getFile();
    return await file.text();
  })()`);

  const metaFile = JSON.parse(await readViaHandle("meta.json"));
  if (metaFile.schemaVersion !== 1) fail(`meta.json 结构错误：${JSON.stringify(metaFile)}`);
  const exportedTask = JSON.parse(await readViaHandle("tasks/task_live1.json"));
  if (!exportedTask.summary.includes("真实测试任务")) fail(`迁移导出缺少种子任务记忆：${JSON.stringify(exportedTask).slice(0, 200)}`);
  await readViaHandle("facts.json").catch(() => fail("facts.json 未导出"));
  step(`迁移导出 OK（task_live1 v${exportedTask.version}，meta/facts 齐全）`);

  // -- 完整整理管线（原手动流程，含隐藏标签页真实模型调用）--
  await pageEval(
    `document.querySelector('.dtw-project-group[data-key="p:task_live1"] .dtw-project-main').click()`);
  await waitUntil("项目详情栏", () => pageEval(`Boolean(document.querySelector(".dtw-inspector [data-action=update-memory]"))`), 10000);
  await pageEval(`document.querySelector('.dtw-inspector [data-action="update-memory"]').click()`);
  step("已触发「用 DeepSeek 更新记忆」，等待整理完成…");

  const jobOutcome = await waitUntil("整理作业完成", async () => {
    const stored = await storageGet();
    const memory = stored["dtw.memory.v1"] || {};
    const jobs = Object.values(memory.jobs || {});
    const job = jobs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
    if (!job || job.taskId !== "task_live1") return false;
    if (job.status === "failed") fail(`整理失败：${job.error}`);
    if (job.status === "done") return { version: memory.taskMemories?.task_live1?.version };
    return false;
  }, 240000, 3000);
  step(`整理完成（任务记忆版本 v${jobOutcome.version}）`);

  // -- 会话原文存档（整理采集时落盘）--
  const convArchive = JSON.parse(await readViaHandle(`conversations/${counted.convId}.json`));
  if (convArchive.conversationId !== counted.convId || !convArchive.messages.length) {
    fail(`会话原文存档缺失或为空：${JSON.stringify(convArchive).slice(0, 200)}`);
  }
  step(`会话存档 OK（${convArchive.messages.length} 条消息）`);

  // -- 手改文件 + 显式重载（文件夹整体权威；手改经由句柄写入，等同人工编辑）--
  const editedSummary = `手改摘要 ${Date.now()}`;
  const freshTask = JSON.parse(await readViaHandle("tasks/task_live1.json"));
  freshTask.summary = editedSummary;
  freshTask.updatedAt = new Date(Date.now() + 60000).toISOString();
  await evaluate(worker, `(async () => {
    const root = await DTWFS.loadStoredHandle();
    await writeTextPath(root, "tasks/task_live1.json", ${JSON.stringify(`${JSON.stringify(freshTask, null, 2)}\n`)});
  })()`);
  await evaluate(popupCdp, `document.getElementById("reload").click()`);
  await waitUntil("手改文件重载生效", async () =>
    (await storageGet())["dtw.memory.v1"]?.taskMemories?.task_live1?.summary === editedSummary, 20000, 2000);
  step("手改文件 + 重载 OK");

  // -- 降级：投毒内存根句柄（换成 meta.json 的文件句柄），后续目录写入全部失败，
  //    与授权失效/目录被删走同一条 catch → degraded 路径；副本必须照写 --
  const degradedWrite = await evaluate(worker, `(async () => {
    fsRuntime.root = await (await DTWFS.loadStoredHandle()).getFileHandle("meta.json");
    const store = (await chrome.storage.local.get("dtw.memory.v1"))["dtw.memory.v1"];
    store.taskMemories.task_live1.nextStep = "降级触发 " + Date.now();
    // 真实降级期编辑走 commitManualTaskMemory，updatedAt 必然刷新；不刷新则与
    // 文件平局、按「平局文件胜」规则副本回填不了文件（测试曾在此误判为产品 bug）
    store.taskMemories.task_live1.updatedAt = new Date(Date.now() + 90000).toISOString();
    const result = await writeMemory(store);
    const after = await chrome.storage.local.get(["dtw.fs.v1", "dtw.memory.v1"]);
    return {
      result,
      fsStatus: after["dtw.fs.v1"]?.status,
      replica: String(after["dtw.memory.v1"]?.taskMemories?.task_live1?.nextStep || ""),
    };
  })()`);
  if (degradedWrite.fsStatus !== "degraded") fail(`投毒句柄后未进入 degraded：${JSON.stringify(degradedWrite)}`);
  if (!degradedWrite.replica.startsWith("降级触发")) fail("降级时副本未写入（数据丢失）");
  const badge = await evaluate(worker, `chrome.action.getBadgeText({})`);
  if (badge !== "!") fail(`降级后 badge 应为 !，实际「${badge}」`);
  step("降级 OK（副本照写，badge=!）");

  // -- 恢复：popup 再次授权（存量句柄 requestPermission，无需重选）→ merge 回填 --
  await authorizeClick();
  await waitUntil("重新授权", async () =>
    (await storageGet())["dtw.fs.v1"]?.status === "ok", 60000, 2000);
  const recoveredTask = JSON.parse(await readViaHandle("tasks/task_live1.json"));
  if (recoveredTask.summary !== editedSummary || !String(recoveredTask.nextStep || "").startsWith("降级触发")) {
    fail(`恢复后文件未回填副本内容：${JSON.stringify(recoveredTask).slice(0, 200)}`);
  }
  step("降级恢复 OK（副本已回填到文件）");

  console.log(JSON.stringify({
    ok: true,
    assertions: ["扩展加载", "登录", "上下文推送", "自动注入", "回复完成", "自动绑定+计数",
      "历史接口(含 INVALID_TOKEN 重试路径)", "服务端存储注入块", "整理管线完成",
      "文件夹授权+迁移导出", "会话原文存档", "手改文件重载", "降级与恢复"].map((name) => ({ name, pass: true })),
  }, null, 2));
} finally {
  if (pageLogs.length) console.log("[live] 页面 console（最后 40 条）：\n  " + pageLogs.slice(-40).join("\n  "));
  if (workerLogs.length) console.log("[live] SW console（最后 40 条）：\n  " + workerLogs.slice(-40).join("\n  "));
  page?.close();
  worker?.close();
  popupCdp?.close();
  chrome.kill();
}
