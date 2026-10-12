/** Read-only Chrome smoke test for the MV3 workbench. Uses the existing .live-profile. */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const profile = path.join(here, "..", ".live-profile");
const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let chrome;
const connect = async (url) => {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  let id = 0; const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id); pending.delete(message.id);
    message.error ? reject(new Error(message.error.message)) : resolve(message.result);
  });
  return { call(method, params = {}) { const next = ++id; return new Promise((resolve, reject) => {
    pending.set(next, { resolve, reject }); socket.send(JSON.stringify({ id: next, method, params }));
  }); }, close() { socket.close(); } };
};
const evaluate = async (cdp, expression) => {
  const result = await cdp.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
};
async function waitFor(label, get, ms = 45000) {
  const started = Date.now();
  while (Date.now() - started < ms) { const value = await get(); if (value) return value; await delay(500); }
  throw new Error(`${label}超时`);
}
let browser; let page; let worker; let options;
try {
  await fs.rm(path.join(profile, "DevToolsActivePort"), { force: true });
  chrome = spawn(chromePath, ["--no-first-run", "--remote-debugging-port=0", "--enable-unsafe-extension-debugging",
    `--user-data-dir=${profile}`, `--disable-extensions-except=${path.join(here, "..", "core")}`,
    `--load-extension=${path.join(here, "..", "core")}`, "--window-size=1280,900", "https://chat.deepseek.com/"], { windowsHide: true });
  const port = await waitFor("Chrome 调试端口", async () => {
    try { const content = await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8"); return Number(content.split(/\r?\n/)[0]) || null; }
    catch { return null; }
  }, 15000);
  const targets = () => fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
  const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((response) => response.json());
  browser = await connect(version.webSocketDebuggerUrl);
  let extensionId = "";
  try { extensionId = (await browser.call("Extensions.loadUnpacked", { path: path.join(here, "..", "core") }))?.id || ""; }
  catch { /* Some Chrome builds disable this CDP method; CLI loading may still work. */ }
  const pageTarget = await waitFor("DSW 页面", async () => (await targets()).find((item) => item.type === "page" && /chat\.deepseek\.com/.test(item.url || "")));
  page = await connect(pageTarget.webSocketDebuggerUrl); await page.call("Runtime.enable");
  if (extensionId) {
    const warmTarget = await browser.call("Target.createTarget", { url: `chrome-extension://${extensionId}/options/options.html` });
    const warmPage = await waitFor("扩展设置页", async () => (await targets()).find((item) => item.id === warmTarget.targetId));
    options = await connect(warmPage.webSocketDebuggerUrl); await options.call("Runtime.enable");
    await evaluate(options, "chrome.runtime.sendMessage({ type: 'dtw:snapshot', accountId: 'smoketest' }).catch(() => null)");
  }
  const workerTarget = await waitFor("扩展后台", async () => (await targets()).find((item) => item.type === "service_worker" && item.url?.endsWith("/background/workbench.js")))
    .catch(async (error) => { throw new Error(`${error.message}；当前目标：${(await targets()).map((item) => `${item.type}:${item.url}`).join(" | ")}`); });
  extensionId ||= workerTarget.url.match(/^chrome-extension:\/\/([^/]+)/)?.[1] || "";
  if (!extensionId) throw new Error("未获得扩展 ID");
  worker = await connect(workerTarget.webSocketDebuggerUrl); await worker.call("Runtime.enable");
  const stores = await evaluate(worker, "DTWDB.open().then(db => [...db.objectStoreNames])");
  if (stores.length !== 10 || !stores.includes("memoryTurns") || !stores.includes("memoryHistory")) throw new Error(`数据库表数错误：${stores.length}`);
  const pageState = await waitFor("工作台启动", () => evaluate(page,
    "(() => ({ loaded: Boolean(window.__dtwWorkbench), tree: Boolean(document.querySelector('.dtw-tree')), memoryButton: Boolean(document.querySelector('.dtw-memory-button')) }))()")
    .then((value) => value.loaded && value.tree && value.memoryButton ? value : null), 60000).catch(async () =>
      evaluate(page, "(() => ({ loaded: Boolean(window.__dtwWorkbench), tree: Boolean(document.querySelector('.dtw-tree')), memoryButton: Boolean(document.querySelector('.dtw-memory-button')), login: document.body.innerText.includes('登录') }))()"));
  const accountReady = await evaluate(worker, "chrome.storage.local.get('accountId').then(v => Boolean(v.accountId))");
  if (!options) {
    const target = await browser.call("Target.createTarget", { url: `chrome-extension://${extensionId}/options/options.html` });
    const optionTarget = await waitFor("设置页", async () => (await targets()).find((item) => item.id === target.targetId));
    options = await connect(optionTarget.webSocketDebuggerUrl); await options.call("Runtime.enable");
  }
  const optionsState = await waitFor("设置页加载", () => evaluate(options,
    "(() => ({ title: document.title, memoryPanel: Boolean(document.querySelector('.settings-app > .memory-app #memories')), reviewTitle: [...document.querySelectorAll('.settings-app h2')].some((item) => item.textContent === '需要核对的任务'), obsoleteThreshold: Boolean(document.querySelector('#distillEveryTurns')) }))()")
    .then((value) => value.title ? value : null));
  if (!optionsState.memoryPanel || !optionsState.reviewTitle || optionsState.obsoleteThreshold)
    throw new Error("设置页没有完整显示设置、记忆管理或待核对任务");
  console.log(JSON.stringify({ ok: true, stores, page: pageState, accountReady, options: optionsState }, null, 2));
} finally {
  options?.close(); worker?.close(); page?.close(); browser?.close();
  chrome?.kill();
}
