import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.dirname(here);
const pagePath = path.join(workspace, "deepseek当前页面", "DeepSeek - 探索未至之境.html");
const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const profilePath = await fs.mkdtemp(path.join(os.tmpdir(), "dtw-visual-test-"));
const outputPath = path.join(here, "preview.png");
const inspectorOutputPath = path.join(here, "preview-inspector.png");

const chrome = spawn(chromePath, [
  "--headless=new",
  "--disable-gpu",
  "--hide-scrollbars",
  "--no-first-run",
  "--remote-debugging-port=0",
  `--user-data-dir=${profilePath}`,
  // Windows headless Chrome subtracts 16 × 95 px from the requested outer size.
  // This produces the reference image's 1672 × 941 viewport on the test machine.
  "--window-size=1688,1036",
  "--allow-file-access-from-files",
  pathToFileURL(pagePath).href,
], { stdio: "ignore", windowsHide: true });

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForDebugPort() {
  const activePortPath = path.join(profilePath, "DevToolsActivePort");
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const [port] = (await fs.readFile(activePortPath, "utf8")).trim().split(/\r?\n/);
      if (port) return Number(port);
    } catch {
      // Chrome has not written the endpoint yet.
    }
    await delay(100);
  }
  throw new Error("Chrome DevTools endpoint did not start");
}

async function connect(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  let sequence = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
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
    close() {
      socket.close();
    },
  };
}

let cdp;
try {
  const port = await waitForDebugPort();
  let target;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
    target = targets.find((item) => item.type === "page");
    if (target) break;
    await delay(100);
  }
  if (!target) throw new Error("DeepSeek preview page was not created");

  cdp = await connect(target.webSocketDebuggerUrl);
  await cdp.call("Page.enable");
  await cdp.call("Runtime.enable");
  await delay(700);

  const [css, memoryCore, script] = await Promise.all([
    fs.readFile(path.join(here, "content.css"), "utf8"),
    fs.readFile(path.join(here, "memory-core.js"), "utf8"),
    fs.readFile(path.join(here, "content.js"), "utf8"),
  ]);

  await cdp.call("Runtime.evaluate", {
    expression: `(() => { const style = document.createElement("style"); style.textContent = ${JSON.stringify(css)}; document.head.appendChild(style); })()`,
  });
  const evaluated = await cdp.call("Runtime.evaluate", {
    expression: `${memoryCore}\n${script}`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.text);

  await delay(900);
  const metricsResult = await cdp.call("Runtime.evaluate", {
    expression: `JSON.stringify({
      viewport: [innerWidth, innerHeight],
      root: Boolean(document.querySelector("#dtw-root")),
      sidebar: document.querySelector(".dtw-sidebar")?.getBoundingClientRect().toJSON(),
      conversationCount: document.querySelectorAll("#dtw-root .dtw-conversation").length,
      nativeSidebarCovered: document.querySelectorAll(".dtw-native-sidebar-covered").length,
      customMainPanels: document.querySelectorAll(".dtw-task-header, .dtw-inspector, .dtw-composer").length,
      nativeComposerVisible: (() => {
        const input = [...document.querySelectorAll("textarea")].find((item) => !item.closest("#dtw-root"));
        return Boolean(input && getComputedStyle(input).visibility !== "hidden" && getComputedStyle(input).opacity !== "0");
      })()
    })`,
    returnByValue: true,
  });
  const metrics = JSON.parse(metricsResult.result.value);
  if (!metrics.root || !metrics.sidebar || !metrics.conversationCount || metrics.nativeSidebarCovered !== 1
      || metrics.customMainPanels !== 0 || !metrics.nativeComposerVisible) {
    throw new Error(`UI mount assertion failed: ${JSON.stringify(metrics)}`);
  }

  const screenshot = await cdp.call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile(outputPath, Buffer.from(screenshot.data, "base64"));

  await cdp.call("Runtime.evaluate", {
    expression: `(() => {
      window.prompt = () => "视觉预览任务";
      window.confirm = () => true;
      document.querySelector('[data-action="new-task"]').click();
    })()`,
  });
  await delay(150);
  const inspectorScreenshot = await cdp.call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile(inspectorOutputPath, Buffer.from(inspectorScreenshot.data, "base64"));
  await cdp.call("Runtime.evaluate", {
    expression: `(() => {
      const task = document.querySelector('.dtw-task:not(.dtw-unassigned)');
      task.querySelector('[data-action="task-menu"]').click();
      document.querySelector('[data-action="delete-task"]').click();
    })()`,
  });

  const interactionResult = await cdp.call("Runtime.evaluate", {
    expression: `(async () => {
      const promptAnswers = ["测试任务", "已改名任务", "constraint", "必须保留原文", "preferred_language", "中文"];
      window.prompt = () => promptAnswers.shift();
      window.confirm = () => true;
      document.querySelector('[data-action="new-task"]').click();
      let task = document.querySelector('.dtw-task:not(.dtw-unassigned)');
      const taskCreated = Boolean(task);

      task.querySelector('[data-action="task-menu"]').click();
      document.querySelector('[data-action="rename-task"]').click();
      task = document.querySelector('.dtw-task:not(.dtw-unassigned)');
      const taskRenamed = task.querySelector('.dtw-task-name').textContent === "已改名任务";

      task.querySelector('[data-action="toggle-task"]').click();
      task = document.querySelector('.dtw-task:not(.dtw-unassigned)');
      const taskCollapsed = task.classList.contains('is-collapsed');
      task.querySelector('[data-action="toggle-task"]').click();

      task = document.querySelector('.dtw-task:not(.dtw-unassigned)');
      const leftMemoryRemoved = !task.querySelector('.dtw-memory-peek, [data-action="task-memory"]');
      task.querySelector('[data-action="select-task"]').click();
      const inspectorOpened = Boolean(document.querySelector('.dtw-inspector'));
      document.querySelector('[data-action="add-task-item"]').click();
      const manualMemoryAdded = Boolean(document.querySelector('.dtw-inspector-item'));
      const summary = document.querySelector('[data-memory-field="summary"]');
      summary.value = "当前已完成右侧栏设计";
      summary.dispatchEvent(new Event("input", { bubbles: true }));
      summary.closest('.dtw-inspector-editor').querySelector('[data-action="save-memory-field"]').click();
      const inlineSummarySaved = document.querySelector('[data-memory-field="summary"]').value === "当前已完成右侧栏设计";

      document.querySelector('[data-action="facts-memory"]').click();
      document.querySelector('[data-action="add-fact"]').click();
      const factAdded = Boolean(document.querySelector('.dtw-fact'));
      document.querySelector('.dtw-modal-header [data-action="close-memory"]').click();

      const firstMenu = document.querySelector('.dtw-unassigned .dtw-more');
      firstMenu.click();
      document.querySelector('.dtw-move-menu [data-action="move"]').click();
      task = document.querySelector('.dtw-task:not(.dtw-unassigned)');
      const moved = task.querySelectorAll('.dtw-conversation').length === 1;
      task.querySelector('.dtw-more').click();
      task = document.querySelector('.dtw-task:not(.dtw-unassigned)');
      task.querySelector('[data-action="remove"]').click();
      task = document.querySelector('.dtw-task:not(.dtw-unassigned)');
      const removed = task.querySelectorAll('.dtw-conversation').length === 0;

      document.querySelector('.dtw-unassigned .dtw-more').click();
      document.querySelector('[data-action="native-manage"]').click();
      await new Promise(requestAnimationFrame);
      const nativeMode = document.querySelector('#dtw-root').classList.contains('is-native-mode')
        && !document.querySelector('.dtw-native-sidebar-covered');
      document.querySelector('[data-action="task-mode"]').click();

      task = document.querySelector('.dtw-task:not(.dtw-unassigned)');
      task.querySelector('[data-action="task-menu"]').click();
      document.querySelector('[data-action="delete-task"]').click();
      const taskDeleted = !document.querySelector('.dtw-task:not(.dtw-unassigned)');
      const conversationsKept = document.querySelectorAll('.dtw-unassigned .dtw-conversation').length > 0;
      return { taskCreated, taskRenamed, taskCollapsed, leftMemoryRemoved, inspectorOpened, manualMemoryAdded, inlineSummarySaved, factAdded, moved, removed, nativeMode, taskDeleted, conversationsKept };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (interactionResult.exceptionDetails) throw new Error(interactionResult.exceptionDetails.text);
  const interactions = interactionResult.result.value;
  if (Object.keys(interactions).length !== 13 || !Object.values(interactions).every(Boolean)) {
    throw new Error(`Interaction assertion failed: ${JSON.stringify(interactions)}`);
  }

  console.log(JSON.stringify({ ok: true, outputPath, inspectorOutputPath, metrics, interactions }, null, 2));
} finally {
  cdp?.close();
  chrome.kill();
}
