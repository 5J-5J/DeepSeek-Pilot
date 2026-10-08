/**
 * DOM 侦查：原生侧栏与 ••• 菜单结构 dump（只读；不加载扩展、不点击任何菜单条目）。
 *   node recon-test.mjs
 * 输出 recon-dom.md：会话行结构 / 列表容器 / 虚拟化结论 / ••• 菜单 DOM 与关闭手段 /
 * 日期标签 / 置顶重复 / 主题约定 / 窄屏隐藏方式。供 content.js 选择器函数定稿。
 */
import { spawn, execSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const profilePath = path.join(here, "..", ".live-profile");
const outputPath = path.join(here, "..", "docs", "recon-dom.md");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sections = [];
const section = (title, body) => sections.push("## " + title + "\n\n" + body + "\n");

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
    const { resolve: ok, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else ok(message.result);
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

const waitUntil = async (description, check, timeoutMs = 60000, intervalMs = 1500) => {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error("等待超时：" + description);
    await delay(intervalMs);
  }
};

// 页内工具：定位"当前打开的原生 ••• 菜单"（含重命名/删除文本的小节点树的最深公共容器）
const MENU_PROBE = `(() => {
  const divs = [...document.querySelectorAll('div')];
  const hits = divs.filter((el) => {
    const t = el.textContent || '';
    return (t.includes('重命名') || t.includes('删除')) && t.length < 300 && el.children.length < 30;
  });
  return hits.length ? hits[hits.length - 1] : null;
})()`;

let cdp;
try {
  const port = await waitForDebugPort();
  const target = await waitUntil("DeepSeek 页面", async () =>
    (await listTargets(port)).find((item) => item.type === "page" && /chat\.deepseek\.com/.test(item.url || "")), 30000, 500);
  cdp = await connect(target.webSocketDebuggerUrl);
  await cdp.call("Page.enable");
  await cdp.call("Runtime.enable");
  await delay(1500);

  await waitUntil("登录", () => evaluate(cdp, `[...document.querySelectorAll('span')].some((e) => e.textContent.trim() === '开启新对话')`), 180000, 2500);
  console.log("[recon] 已登录");

  // —— 1. 会话行结构 + 祖先链 ——
  const rowsInfo = await evaluate(cdp, `(() => {
    const links = [...document.querySelectorAll('a[href*="/chat/s/"]')];
    const rows = links.slice(0, 2).map((link) => {
      const chain = [];
      let el = link;
      while (el && el !== document.body) {
        const r = el.getBoundingClientRect();
        chain.push(el.tagName.toLowerCase() + '.' + [...el.classList].join('.') +
          ' [x=' + Math.round(r.x) + ' y=' + Math.round(r.y) + ' w=' + Math.round(r.width) + ' h=' + Math.round(r.height) + ']');
        el = el.parentElement;
      }
      return { href: link.getAttribute('href'), title: link.textContent.trim().slice(0, 30), chain, html: link.outerHTML.slice(0, 1500) };
    });
    return JSON.stringify({ count: links.length, rows }, null, 2);
  })()`);
  section("会话行结构", "```json\n" + rowsInfo + "\n```");

  // —— 2. 列表容器：所有行的共同祖先链 + 滚动信息 ——
  const containerInfo = await evaluate(cdp, `(() => {
    const links = [...document.querySelectorAll('a[href*="/chat/s/"]')];
    if (!links.length) return '无会话行';
    const chainOf = (el) => { const set = new Set(); while (el && el !== document.body) { set.add(el); el = el.parentElement; } return set; };
    let common = [...chainOf(links[0])];
    for (const link of links.slice(1)) {
      const set = chainOf(link);
      common = common.filter((el) => set.has(el));
    }
    const lines = common.map((el) => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return el.tagName.toLowerCase() + '.' + [...el.classList].join('.') +
        ' overflowY=' + cs.overflowY + ' scrollH=' + el.scrollHeight + ' clientH=' + el.clientHeight +
        ' [w=' + Math.round(r.width) + ' h=' + Math.round(r.height) + '] children=' + el.children.length +
        ' transform=' + (cs.transform !== 'none' ? cs.transform : '-');
    });
    const direct = links[0].parentElement;
    return JSON.stringify({
      directParent: direct.tagName.toLowerCase() + '.' + [...direct.classList].join('.') + ' children=' + direct.children.length,
      commonAncestorsLowToHigh: lines,
    }, null, 2);
  })()`);
  section("列表容器候选", "```json\n" + containerInfo + "\n```");

  // —— 3. 虚拟化检查：滚到底再回顶，节点身份是否存续 ——
  const virtTop = await evaluate(cdp, `(() => {
    const links = [...document.querySelectorAll('a[href*="/chat/s/"]')];
    window.__dtwFirst = links[0] || null;
    window.__dtwHrefsTop = links.map((l) => l.getAttribute('href'));
    return JSON.stringify({ topCount: links.length, topFirst3: window.__dtwHrefsTop.slice(0, 3) });
  })()`);
  const scrollerName = await evaluate(cdp, `(() => {
    const links = [...document.querySelectorAll('a[href*="/chat/s/"]')];
    let el = links[0];
    while (el && el !== document.body) {
      const cs = getComputedStyle(el);
      if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 50) {
        el.scrollTop = el.scrollHeight;
        window.__dtwScroller = el;
        return el.tagName.toLowerCase() + '.' + [...el.classList].join('.');
      }
      el = el.parentElement;
    }
    window.__dtwScroller = null;
    return '无可滚动容器';
  })()`);
  await delay(400);
  const virtBottom = await evaluate(cdp, `(() => {
    const links = [...document.querySelectorAll('a[href*="/chat/s/"]')];
    return JSON.stringify({ bottomCount: links.length,
      bottomFirst3: links.slice(0, 3).map((l) => l.getAttribute('href')),
      firstStillConnected: Boolean(window.__dtwFirst && window.__dtwFirst.isConnected),
      firstNowHref: window.__dtwFirst ? window.__dtwFirst.getAttribute('href') : null });
  })()`);
  await evaluate(cdp, `(() => { if (window.__dtwScroller) window.__dtwScroller.scrollTop = 0; })()`);
  await delay(400);
  const virtBack = await evaluate(cdp, `(() => {
    const links = [...document.querySelectorAll('a[href*="/chat/s/"]')];
    return JSON.stringify({ backCount: links.length,
      firstRestoredSameNode: Boolean(window.__dtwFirst && window.__dtwFirst.isConnected &&
        window.__dtwFirst.getAttribute('href') === window.__dtwHrefsTop[0]),
      backFirst3: links.slice(0, 3).map((l) => l.getAttribute('href')) });
  })()`);
  section("虚拟化检查", "scroller: " + scrollerName + "\n顶部: " + virtTop + "\n滚底: " + virtBottom + "\n回顶: " + virtBack +
    "\n\n判定：回顶后首节点仍连接且 href 一致 → 非虚拟化（方式 A 可行）；节点被复用/重挂 → 虚拟化。");

  // —— 4. 置顶重复：同 id 是否出现两行 ——
  const dupInfo = await evaluate(cdp, `(() => {
    const seen = {};
    for (const link of document.querySelectorAll('a[href*="/chat/s/"]')) {
      const id = (link.getAttribute('href').match(/\\/chat\\/s\\/([^/?#]+)/) || [])[1];
      if (id) seen[id] = (seen[id] || 0) + 1;
    }
    return JSON.stringify(Object.entries(seen).filter(([, n]) => n > 1));
  })()`);
  section("置顶重复会话", dupInfo === "[]" ? "无重复" : "```json\n" + dupInfo + "\n```");

  // —— 5. 行内按钮清单（hover 前后）——
  const rowCenter = await evaluate(cdp, `(() => {
    const link = document.querySelector('a[href*="/chat/s/"]');
    const r = link.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  const dumpButtons = `(() => {
    const link = document.querySelector('a[href*="/chat/s/"]');
    return JSON.stringify([...link.querySelectorAll('button, [role="button"]')].map((b, i) => {
      const r = b.getBoundingClientRect();
      const cs = getComputedStyle(b);
      return { i, tag: b.tagName.toLowerCase(), role: b.getAttribute('role'), aria: b.getAttribute('aria-label'),
        title: b.getAttribute('title'), text: b.textContent.trim().slice(0, 16), hasSvg: Boolean(b.querySelector('svg')),
        rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
        opacity: cs.opacity, pointerEvents: cs.pointerEvents };
    }), null, 2);
  })()`;
  const buttonsBefore = await evaluate(cdp, dumpButtons);
  await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: rowCenter.x, y: rowCenter.y });
  await delay(300);
  const buttonsAfter = await evaluate(cdp, dumpButtons);
  section("行内按钮（hover 前）", "```json\n" + buttonsBefore + "\n```");
  section("行内按钮（hover 后）", "```json\n" + buttonsAfter + "\n```");

  // —— 6. 打开 ••• 菜单：body 子节点 diff ——
  const themeClasses = await evaluate(cdp, `(() => ({
    bodyClass: document.body.className, htmlClass: document.documentElement.className,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    darkQuery: matchMedia('(prefers-color-scheme: dark)').matches,
  }))()`);
  await evaluate(cdp, `(() => {
    const link = document.querySelector('a[href*="/chat/s/"]');
    window.__dtwBefore = new Set([...document.body.children]);
    link.querySelector('button, [role="button"]').click();
  })()`);
  await delay(500);
  const menuInfo = await evaluate(cdp, `(() => {
    const fresh = [...document.body.children].filter((el) => !window.__dtwBefore.has(el));
    const menu = ${MENU_PROBE};
    const pick = menu || fresh[fresh.length - 1] || null;
    if (!pick) return JSON.stringify({ freshCount: fresh.length, menuFound: false }, null, 2);
    const chain = [];
    let el = pick;
    while (el && el !== document.body) {
      const cs = getComputedStyle(el);
      chain.push(el.tagName.toLowerCase() + '.' + [...el.classList].join('.') +
        ' pos=' + cs.position + ' z=' + cs.zIndex +
        ' [w=' + Math.round(el.getBoundingClientRect().width) + ' h=' + Math.round(el.getBoundingClientRect().height) + ']');
      el = el.parentElement;
    }
    return JSON.stringify({ freshCount: fresh.length, menuFound: true, chain, html: pick.outerHTML.slice(0, 6000) }, null, 2);
  })()`);
  section("••• 菜单 DOM", "theme: " + JSON.stringify(themeClasses) + "\n```json\n" + menuInfo + "\n```");

  // —— 7. 菜单条目结构树（克隆原型参考）——
  const itemInfo = await evaluate(cdp, `(() => {
    const menu = ${MENU_PROBE};
    if (!menu) return '菜单已关闭';
    const out = [];
    const walk = (el, depth) => {
      out.push('  '.repeat(depth) + el.tagName.toLowerCase() + '.' + [...el.classList].join('.') +
        (el.children.length ? '' : ' text="' + el.textContent.trim().slice(0, 16) + '"'));
      for (const child of [...el.children].slice(0, 8)) walk(child, depth + 1);
    };
    walk(menu, 0);
    return out.join('\\n');
  })()`);
  section("菜单条目结构树", "```\n" + itemInfo + "\n```");

  // —— 8. 关闭手段验证：Escape → 空白处合成点击 ——
  const menuOpen = `(() => {
    const menu = ${MENU_PROBE};
    return Boolean(menu && menu.isConnected && menu.getBoundingClientRect().height > 0);
  })()`;
  const escapeResult = await evaluate(cdp, `(() => {
    if (!${menuOpen}) return 'menu-not-open';
    for (const target of [document.activeElement || document.body, document]) {
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }));
      target.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
    }
    return 'dispatched';
  })()`);
  await delay(400);
  let closeVerdict = 'Escape: ' + escapeResult + ' → ' + (await evaluate(cdp, menuOpen) ? 'still-open' : 'closed');
  if (closeVerdict.endsWith('still-open')) {
    await evaluate(cdp, `(() => {
      const el = document.elementFromPoint(3, innerHeight - 6) || document.body;
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    })()`);
    await delay(400);
    closeVerdict += '；空白处合成点击 → ' + (await evaluate(cdp, menuOpen) ? 'still-open' : 'closed');
  }
  section("菜单关闭手段", closeVerdict);

  // —— 9. 日期标签 ——
  const dateInfo = await evaluate(cdp, `(() => {
    const pattern = /^(置顶|今天|昨天|\\d+\\s*天内|更早)/;
    const labels = [...document.querySelectorAll('div, span, p, h1, h2, h3, h4')]
      .filter((el) => {
        const t = el.textContent.trim();
        const r = el.getBoundingClientRect();
        return pattern.test(t) && t.length <= 8 && el.children.length === 0 && r.height > 0 && r.height < 40;
      })
      .slice(0, 20)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return '"' + el.textContent.trim() + '" <' + el.tagName.toLowerCase() + ' class="' + el.className + '">' +
          ' [y=' + Math.round(r.y) + ' h=' + Math.round(r.height) + ']' +
          ' parent=' + el.parentElement.tagName.toLowerCase() + '.' + [...el.parentElement.classList].join('.');
      });
    return labels.join('\\n') || '未找到';
  })()`);
  section("日期标签", "```\n" + dateInfo + "\n```");

  // —— 10. 窄屏隐藏方式 ——
  await cdp.call("Emulation.setDeviceMetricsOverride", { width: 600, height: 900, deviceScaleFactor: 0, mobile: false });
  await delay(600);
  const narrowInfo = await evaluate(cdp, `(() => {
    const link = document.querySelector('a[href*="/chat/s/"]');
    if (!link) return JSON.stringify({ innerWidth, link: 'none' });
    let el = link, hidden = '';
    while (el && el !== document.body) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') {
        hidden = el.tagName.toLowerCase() + '.' + [...el.classList].join('.') + ' → display=' + cs.display + ' visibility=' + cs.visibility;
        break;
      }
      el = el.parentElement;
    }
    return JSON.stringify({ innerWidth, hiddenAt: hidden || '未隐藏' });
  })()`);
  await cdp.call("Emulation.clearDeviceMetricsOverride");
  section("窄屏（600px）隐藏", "```json\n" + narrowInfo + "\n```");

  await fs.writeFile(outputPath, "# DeepSeek 原生侧栏 DOM 侦查（" + new Date().toISOString() + "）\n\n" + sections.join("\n"), "utf8");
  console.log("[recon] 完成 → " + outputPath);
} finally {
  cdp?.close();
  chrome.kill();
}
