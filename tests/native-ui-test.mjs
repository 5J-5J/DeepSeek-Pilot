/**
 * 原生侧栏注入的端到端测试：真实 Chrome + 真实扩展 + 真实 chat.deepseek.com。
 * 纯 UI（不发消息）：项目→会话树、项目折叠/展开、项目详情、••• 菜单注入
 * 与「移动到项目」全链路、切换会话后的项目树自愈、Escape 关闭浮层。
 *
 *   node native-ui-test.mjs
 */
import { spawn, execSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const profilePath = path.join(here, "..", ".live-profile");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const step = (message) => console.log(`[native-ui] ${message}`);
const fail = (message) => { throw new Error(message); };

try {
  execSync(
    `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"name='chrome.exe'\\" | ` +
    `Where-Object { $_.CommandLine -like '*live-profile*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"`,
    { stdio: "ignore" },
  );
} catch { /* 无残留 */ }
await fs.rm(path.join(profilePath, "DevToolsActivePort"), { force: true });

let chromeExited = "";
const chrome = spawn(chromePath, [
  "--no-first-run",
  "--remote-debugging-port=0",
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
    } catch { /* 尚未写入 */ }
    await delay(100);
  }
  throw new Error("Chrome DevTools endpoint did not start");
}

const listTargets = (port) => fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());

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
  const result = await cdp.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result.value;
}

let page;
let worker;
let workerKeepalive = null;
const pageLogs = [];
try {
  const port = await waitForDebugPort();
  const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((response) => response.json());
  const browser = await connect(version.webSocketDebuggerUrl);
  let extensionId = "";
  try {
    const loaded = await browser.call("Extensions.loadUnpacked", { path: path.join(here, "..", "core") });
    extensionId = loaded?.id || "";
    step(`已通过 CDP 加载扩展（${extensionId}）`);
  } catch {
    step("CDP 加载不可用，等待已加载的扩展…");
  } finally {
    browser.close();
  }

  const pageTarget = await (async () => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const target = (await listTargets(port)).find((item) => item.type === "page" && /chat\.deepseek\.com/.test(item.url || ""));
      if (target) return target;
      await delay(500);
    }
    fail("等待 DeepSeek 页面超时");
  })();
  page = await connect(pageTarget.webSocketDebuggerUrl, pageLogs);
  await page.call("Page.enable");
  await page.call("Runtime.enable");
  try { await page.call("Page.bringToFront"); } catch { /* 部分环境不支持 */ }

  const workerTarget = await (async () => {
    for (let attempt = 0; attempt < 90; attempt += 1) {
      const target = (await listTargets(port)).find((item) =>
        item.type === "service_worker" && /\/background\.js$/.test(item.url || ""));
      if (target) return target;
      await delay(2000);
    }
    fail("等待扩展 Service Worker 超时（可手动加载，最长 3 分钟）");
  })();
  worker = await connect(workerTarget.webSocketDebuggerUrl);
  await worker.call("Runtime.enable");
  const staleWorkerId = workerTarget.id;
  await Promise.race([
    evaluate(worker, "chrome.runtime.reload(), \"ok\"").catch(() => {}),
    delay(4000),
  ]);
  worker.close();
  worker = null;
  const freshWorkerTarget = await (async () => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const items = (await listTargets(port)).filter((item) => item.type === "service_worker"
        && /\/background\.js$/.test(item.url || "") && item.id !== staleWorkerId);
      if (items[0]) return items[0];
      await delay(1000);
    }
    fail("等待重载后的 Service Worker 超时");
  })();
  worker = await connect(freshWorkerTarget.webSocketDebuggerUrl);
  await worker.call("Runtime.enable");
  const freshness = await evaluate(worker, "typeof DTWFS");
  if (freshness !== "object") fail(`扩展 Service Worker 仍是旧代码（DTWFS=${freshness}）`);
  step("扩展已就绪（SW 已强制重载）");
  // 测试中段长时间只用页面 CDP：定期戳一下 SW，避免其空闲被杀导致连接上的 pending promise 被回收
  workerKeepalive = setInterval(() => {
    worker.call("Runtime.evaluate", { expression: "1" }).catch(() => {});
  }, 8000);

  await page.call("Page.reload");
  await delay(3000);
  step("已重载 DeepSeek 页面");

  const pageEval = (expression) => evaluate(page, expression);
  const waitUntil = async (description, check, timeoutMs = 60000, intervalMs = 1200) => {
    const started = Date.now();
    for (;;) {
      const value = await check();
      if (value) return value;
      if (Date.now() - started > timeoutMs) fail(`等待超时：${description}`);
      await delay(intervalMs);
    }
  };

  await waitUntil("DeepSeek 登录", () => pageEval(`[...document.querySelectorAll('span')]
    .some((element) => element.textContent.trim() === '开启新对话')`), 180000, 2500);
  await waitUntil("原生会话行", () => pageEval(`document.querySelectorAll('a[href*="/chat/s/"]').length >= 2`), 30000);
  await waitUntil("内容脚本挂载", () => pageEval(`Boolean(document.querySelector('#dtw-root'))`), 30000);
  step("已登录，页面就绪");

  // 取两个真实会话：第一个归属种子任务，第二个保持未分类（用于 ••• 移动）
  const convIds = await waitUntil("会话 id 采集", () => pageEval(`(() => {
    const ids = [...document.querySelectorAll('a[href*="/chat/s/"]')]
      .map((link) => (link.getAttribute('href').match(/\\/chat\\/s\\/([^/?#]+)/) || [])[1])
      .filter(Boolean);
    return ids.length >= 2 ? JSON.stringify([ids[0], ids[1]]) : null;
  })()`), 30000);
  const [seedId, moveId] = JSON.parse(convIds);
  const originalSidebar = await evaluate(worker,
    "(async () => (await chrome.storage.local.get('dtw.sidebar.v1'))['dtw.sidebar.v1'] || null)()");

  // cleanState 会过滤 conversations 里不存在的 id：先等扫描把真实会话入库，再在其上播种
  const seededBase = await waitUntil("真实会话入库", () => evaluate(worker,
    `(async () => { const s = (await chrome.storage.local.get('dtw.sidebar.v1'))['dtw.sidebar.v1'];
       return s?.conversations?.[${JSON.stringify(seedId)}] && s?.conversations?.[${JSON.stringify(moveId)}] ? JSON.stringify(s) : null; })()`), 30000, 1000).then(JSON.parse);
  await evaluate(worker, `chrome.storage.local.set(${JSON.stringify({
    "dtw.sidebar.v1": {
      ...seededBase,
      // 剔除历史运行残留的 task_ui1，避免重复 id 污染项目树
      tasks: [...(seededBase.tasks || []).filter((task) => task.id !== "task_ui1"),
        { id: "task_ui1", name: "UI实测项目", collapsed: false, conversationIds: [seedId], sourceEpoch: 1, createdAt: new Date().toISOString() }],
      selectedTaskId: "",
      lastSelectedTaskId: "task_ui1",
    },
  }).replace(/</g, "\\u003c")})`);
  step(`种子项目就绪（seed=${seedId.slice(0, 8)}… move=${moveId.slice(0, 8)}…）`);

  // —— 断言 1：原生列表节点保留在 DOM，视觉层改为项目→会话树 ——
  const layout = await waitUntil("项目会话树", () => pageEval(`(() => {
    const tools = document.querySelector('.dtw-tools-root');
    const toolsRect = tools?.getBoundingClientRect();
    const nativeRows = [...document.querySelectorAll('a[href*="/chat/s/"]')];
    const wanted = nativeRows.filter((link) => [${JSON.stringify(seedId)}, ${JSON.stringify(moveId)}]
      .includes((link.getAttribute('href').match(/\\/chat\\/s\\/([^/?#]+)/) || [])[1]));
    const project = document.querySelector('.dtw-project-group[data-key="p:task_ui1"]');
    const unassigned = document.querySelector('.dtw-project-group[data-key="unassigned"]');
    return JSON.stringify({
      toolsButtons: tools ? [...tools.querySelectorAll('[data-action]')].map((b) => b.dataset.action) : [],
      toolsVisible: Boolean(tools?.offsetParent && toolsRect.width > 0 && toolsRect.height > 0
        && toolsRect.top >= 0 && toolsRect.bottom <= innerHeight && toolsRect.top < 320),
      toolsRect: toolsRect ? [toolsRect.x, toolsRect.y, toolsRect.width, toolsRect.height] : [],
      nativeRows: nativeRows.length,
      nativeRowsHidden: wanted.length === 2 && wanted.every((link) => link.offsetParent === null),
      hiddenNative: document.querySelectorAll('[data-dtw-hide]').length,
      projectVisible: Boolean(project?.offsetParent),
      projectName: project?.querySelector('.dtw-project-main strong')?.textContent || '',
      projectSeed: Boolean(project?.querySelector('.dtw-conversation-row[data-id="${seedId}"]')),
      unassignedMove: Boolean(unassigned?.querySelector('.dtw-conversation-row[data-id="${moveId}"]')),
      customGroups: document.querySelectorAll('.dtw-project-group').length,
    });
  })()`), 20000).then(JSON.parse);
  const assert1 = {
    toolsInjected: ["new-task", "toggle-auto-classify", "settings-memory", "facts-memory"]
      .every((action) => layout.toolsButtons.includes(action)) && layout.toolsVisible,
    projectTreeVisible: layout.projectVisible && layout.projectName === "UI实测项目"
      && layout.projectSeed && layout.unassignedMove && layout.customGroups >= 2,
    nativeRowsPreservedHidden: layout.nativeRows >= 2 && layout.nativeRowsHidden && layout.hiddenNative > 0,
  };
  step(`项目树布局: ${JSON.stringify({ ...assert1, toolsRect: layout.toolsRect })}`);

  // —— 断言 2：项目可折叠/展开，点项目名打开详情 ——
  const collapse = await pageEval(`(() => {
    const group = document.querySelector('.dtw-project-group[data-key="p:task_ui1"]');
    group.querySelector('.dtw-project-caret').click();
    return new Promise((resolve) => setTimeout(() => {
      const collapsed = group.classList.contains('is-collapsed')
        && group.querySelector('.dtw-conversation-row[data-id="${seedId}"]').offsetParent === null;
      group.querySelector('.dtw-project-caret').click();
      setTimeout(() => resolve(JSON.stringify({ collapsed,
        expanded: !group.classList.contains('is-collapsed')
          && group.querySelector('.dtw-conversation-row[data-id="${seedId}"]').offsetParent !== null })), 500);
    }, 500));
  })()`).then(JSON.parse);
  await pageEval(`document.querySelector('.dtw-project-group[data-key="p:task_ui1"] .dtw-project-main').click()`);
  const inspectorResult = await waitUntil("项目详情", () => pageEval(`(() => ({
      inspectorOpen: Boolean(document.querySelector('.dtw-inspector')),
      compactWidth: document.querySelector('.dtw-inspector')?.getBoundingClientRect().width <= 360,
      hasRename: Boolean(document.querySelector('.dtw-inspector [data-action="rename-task"]')),
      hasDelete: Boolean(document.querySelector('.dtw-inspector [data-action="delete-task"]')),
      hasBriefEditors: document.querySelectorAll('.dtw-inspector [data-action="edit-memory-field"]').length === 2,
      noPersistentTextareas: !document.querySelector('.dtw-inspector textarea'),
      noDuplicateConversationList: !document.querySelector('.dtw-inspector-conversations'),
      globalSettingsRemoved: !document.querySelector('.dtw-inspector [data-action="toggle-auto-inject"], .dtw-inspector [data-action="toggle-auto-analyze"]'),
    }))()`), 10000);
  step(`项目折叠与详情: ${JSON.stringify({ ...collapse, ...inspectorResult })}`);
  if (process.env.DTW_SCREENSHOT) {
    const shot = await page.call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await fs.writeFile(path.resolve(process.env.DTW_SCREENSHOT), Buffer.from(shot.data, "base64"));
  }
  await pageEval(`document.querySelector('.dtw-inspector [data-action="close-task-panel"]')?.click()`);
  await delay(300);

  // —— 断言 3：项目树会话 ••• → 原生菜单+插件菜单项 → 项目选择浮层 → 移动 ——
  const menuFlow = await pageEval(`(() => {
    const row = document.querySelector('.dtw-project-group[data-key="unassigned"] .dtw-conversation-row[data-id="${moveId}"]');
    const more = row?.querySelector('.dtw-conversation-more');
    if (!more) return Promise.resolve(JSON.stringify({ rowFound: false }));
    more.click();
    return new Promise((resolve) => setTimeout(() => {
      const injected = document.querySelector('.ds-dropdown-menu .dtw-menu-item[data-action="open-picker"]');
      if (!injected) return resolve(JSON.stringify({ rowFound: true, menuInjected: false }));
      injected.click();
      setTimeout(() => {
        const picker = document.querySelector('.dtw-picker');
        const taskButton = picker?.querySelector('[data-action="move"][data-task-id="task_ui1"]');
        if (!taskButton) return resolve(JSON.stringify({ rowFound: true, menuInjected: true, pickerOpen: Boolean(picker) }));
        const pickerId = taskButton.dataset.id || "";
        taskButton.click();
        setTimeout(() => resolve(JSON.stringify({ rowFound: true, menuInjected: true, pickerOpen: true,
          pickerId, pickerClosedAfterMove: !document.querySelector('.dtw-picker') })), 1200);
      }, 500);
    }, 800));
  })()`).then(JSON.parse);
  step(`••• 全链路: ${JSON.stringify(menuFlow)}`);

  let moveResult;
  try {
    moveResult = await waitUntil("移动落库", () => evaluate(worker,
      `(async () => { const s = (await chrome.storage.local.get('dtw.sidebar.v1'))['dtw.sidebar.v1'];
         const t = s?.tasks?.find((task) => task.id === 'task_ui1');
         return t && t.conversationIds.includes(${JSON.stringify(moveId)}) ? 'moved' : null; })()`), 15000, 800);
  } catch (error) {
    const dump = await evaluate(worker,
      "(async () => JSON.stringify((await chrome.storage.local.get('dtw.sidebar.v1'))['dtw.sidebar.v1']?.tasks?.map((t) => [t.id, t.name, t.conversationIds])))()");
    step(`移动落库失败，storage tasks: ${dump}`);
    throw error;
  }
  const rowAfterMove = await waitUntil("项目树移动", () => pageEval(`(() => {
    const inProject = document.querySelector('.dtw-project-group[data-key="p:task_ui1"] .dtw-conversation-row[data-id="${moveId}"]');
    const inUnassigned = document.querySelector('.dtw-project-group[data-key="unassigned"] .dtw-conversation-row[data-id="${moveId}"]');
    return inProject && !inUnassigned ? 'project-visible' : null;
  })()`), 15000, 800);
  step(`移动结果: storage=${moveResult} dom=${rowAfterMove}`);

  // —— 断言 4：项目树导航后依然自愈，当前会话高亮 ——
  await pageEval(`document.querySelector('.dtw-project-group[data-key="p:task_ui1"] .dtw-conversation-row[data-id="${seedId}"] .dtw-conversation-main')?.click()`);
  await delay(3000);
  const heal = await pageEval(`(() => {
    const rows = [...document.querySelectorAll('a[href*="/chat/s/"]')];
    return JSON.stringify({ toolbarPresent: Boolean(document.querySelector('.dtw-tools-root')),
      nativeRows: rows.length, customGroups: document.querySelectorAll('.dtw-project-group').length,
      hiddenNative: document.querySelectorAll('[data-dtw-hide]').length,
      projectRows: document.querySelectorAll('.dtw-project-group[data-key="p:task_ui1"] .dtw-conversation-row').length,
      activeSeed: Boolean(document.querySelector('.dtw-project-group[data-key="p:task_ui1"] .dtw-conversation-row[data-id="${seedId}"].is-active')) });
  })()`).then(JSON.parse);
  step(`导航后自愈: ${JSON.stringify(heal)}`);

  // —— 断言 5：Escape 关闭项目选择浮层 ——
  const escapeStart = await pageEval(`(() => {
    const more = document.querySelector('.dtw-project-group[data-key="p:task_ui1"] .dtw-conversation-row[data-id="${moveId}"] .dtw-conversation-more');
    if (!more) return false;
    more.click();
    return true;
  })()`);
  const escapeEntry = escapeStart && await waitUntil("Escape 流程菜单或降级选择器", () => pageEval(`(() => {
    if (document.querySelector('.dtw-picker')) return 'fallback-picker';
    if (document.querySelector('.ds-dropdown-menu .dtw-menu-item[data-action="open-picker"]')) return 'native-menu';
    return '';
  })()`), 10000, 300);
  if (escapeEntry === "native-menu") await pageEval(
    `document.querySelector('.ds-dropdown-menu .dtw-menu-item[data-action="open-picker"]').click()`);
  const pickerOpened = escapeEntry && await waitUntil("Escape 流程项目选择器", () => pageEval(
    `Boolean(document.querySelector('.dtw-picker'))`), 10000, 300);
  if (pickerOpened) await pageEval(
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await delay(500);
  const escapeFlow = {
    entry: escapeEntry,
    pickerOpened: Boolean(pickerOpened),
    pickerClosedByEscape: !await pageEval(`Boolean(document.querySelector('.dtw-picker'))`),
  };
  step(`Escape: ${JSON.stringify(escapeFlow)}`);

  // —— 断言 6：扫描循环收敛（空闲 4s 内 tick 数应 ≈ 定时器 1.5s 一次；风暴时远超）——
  const churn = await pageEval(`(() => {
    return new Promise((resolve) => {
      const start = Number(document.querySelector('#dtw-root').dataset.scanTick || 0);
      setTimeout(() => resolve(Number(document.querySelector('#dtw-root').dataset.scanTick || 0) - start), 4000);
    });
  })()`);
  step(`扫描收敛(4s): ticks=${churn}`);

  const assertions = {
    ...assert1,
    collapseAndInspector: collapse.collapsed && collapse.expanded && inspectorResult.inspectorOpen
      && inspectorResult.compactWidth && inspectorResult.hasRename && inspectorResult.hasDelete
      && inspectorResult.hasBriefEditors && inspectorResult.noPersistentTextareas
      && inspectorResult.noDuplicateConversationList && inspectorResult.globalSettingsRemoved,
    rowPickerFlow: menuFlow.rowFound && menuFlow.menuInjected && menuFlow.pickerOpen && menuFlow.pickerClosedAfterMove,
    movePersisted: moveResult === "moved" && rowAfterMove === "project-visible",
    healAfterNav: heal.toolbarPresent && heal.nativeRows >= 2 && heal.customGroups >= 1
      && heal.hiddenNative > 0 && heal.projectRows >= 2 && heal.activeSeed,
    escapeClosesPicker: escapeFlow.pickerOpened && escapeFlow.pickerClosedByEscape,
    scanLoopSettled: churn <= 6,
  };
  const failed = Object.entries(assertions).filter(([, ok]) => !ok).map(([name]) => name);
  if (failed.length) fail(`断言失败：${failed.join(", ")}`);
  console.log(JSON.stringify({ ok: true, assertions }, null, 2));

  // 还原侧栏状态，避免污染后续手动测试
  if (originalSidebar) await evaluate(worker,
    `chrome.storage.local.set({ "dtw.sidebar.v1": ${JSON.stringify(originalSidebar).replace(/</g, "\\u003c")} })`);
} finally {
  if (pageLogs.length) console.log("[native-ui] 页面 console（最后 30 条）：\n  " + pageLogs.slice(-30).join("\n  "));
  clearInterval(workerKeepalive);
  worker?.close();
  page?.close();
  chrome.kill();
}
