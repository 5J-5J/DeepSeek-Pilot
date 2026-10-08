/* global DTWHistory */
(() => {
  "use strict";
  if (window.__dtwWorkbench) return;
  window.__dtwWorkbench = true;
  const root = document.createElement("div");
  root.id = "dtw-root";
  const NEW_CHAT = "__dtw_new_chat__";
  const state = { accountId: "", snapshot: null, knownAtStart: new Set(), newSessionIds: new Set(), pendingNewConversationAt: 0, pendingNewKnownIds: new Set(),
    importedIds: new Set(), syncingVisible: false, syncingTimes: false, sessionTimes: new Map(), reportedTips: new Map(), titles: new Map(),
    collapsed: new Set(), pickerSessionId: "", enableMemoryAfterMove: "", pendingNewProjectId: "", newChatMemoryOff: false,
    modal: "", toastTimer: 0, rendering: false, startupFailed: false, uiRoute: "", messageInfoPending: false,
    automationRunning: false, rolloverRunning: false, startupScanning: false, startupRescanRequested: false, startupScanReady: false,
    bypassSend: false, pendingSend: false,
    submittedAtMs: null, firstOutputAtMs: null, lastHistory: null, lastHistoryAt: 0,
    turn: { route: "", count: 0, text: "", since: 0, generating: false, primed: false } };
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const idFromHref = (href) => { try { return new URL(href, location.href).pathname.match(/\/chat\/s\/([^/?#]+)/)?.[1] || ""; } catch { return ""; } };
  const currentId = () => idFromHref(location.href);
  function markPendingNewConversation() {
    state.pendingNewConversationAt = Date.now();
    state.pendingNewKnownIds = new Set([...(state.snapshot?.sessions || []).map((item) => item.sessionId),
      ...nativeLinks().map((item) => idFromHref(item.href))]);
  }
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const parse = (event) => { try { return JSON.parse(event.detail); } catch { return null; } };
  const pageHookReady = new Promise((resolve) => window.addEventListener("dtw:network-ready", () => resolve(true), { once: true }));
  const send = async (type, body = {}) => {
    if (!state.accountId) throw new Error("无法确认 DeepSeek 账号");
    const result = await chrome.runtime.sendMessage({ type: `dtw:${type}`, accountId: state.accountId, ...body });
    if (result == null) throw new Error(`插件后台未响应「${type}」。请在扩展管理页重新加载插件，然后刷新 DeepSeek 页面`);
    if (result?.ok === false) throw new Error(result.error || "操作失败");
    return result;
  };

  function injectPageHook() {
    const mount = document.head || document.documentElement;
    const core = document.createElement("script");
    core.src = chrome.runtime.getURL("logic/request-body-core.js");
    core.onload = () => {
      const network = document.createElement("script");
      network.src = chrome.runtime.getURL("page/page-network.js");
      mount.append(network);
    };
    mount.append(core);
  }
  injectPageHook();

  function waitEvent(name, requestId, ms = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error("DSW 页面响应超时")), ms);
      const good = (event) => { const detail = parse(event); if (detail?.requestId === requestId) finish(null, detail); };
      const bad = (event) => { const detail = parse(event); if (!detail?.requestId || detail.requestId === requestId) finish(new Error(detail?.error || "DSW 请求失败")); };
      function finish(error, detail) {
        clearTimeout(timer); window.removeEventListener(name, good); window.removeEventListener("dtw:network-error", bad);
        if (error) reject(error); else resolve(detail);
      }
      window.addEventListener(name, good); window.addEventListener("dtw:network-error", bad);
    });
  }
  async function history(sessionId) {
    const requestId = `history_${crypto.randomUUID()}`;
    const result = waitEvent("dtw:history-result", requestId, 18000);
    window.dispatchEvent(new CustomEvent("dtw:history-request", { detail: JSON.stringify({ requestId, sessionId }) }));
    return DTWHistory.parseHistoryResponse((await result).data, sessionId);
  }
  async function arm(prompt, operation) {
    const requestId = `send_${crypto.randomUUID()}`;
    const marker = `[DTW:${requestId}]`;
    const ready = waitEvent("dtw:network-armed", requestId, 5000);
    window.dispatchEvent(new CustomEvent("dtw:network-arm", { detail: JSON.stringify({ requestId, marker,
      operation, prompt, expiresAt: Date.now() + 30000 }) }));
    await ready;
    return { requestId, marker };
  }
  function cancel(requestId) {
    window.dispatchEvent(new CustomEvent("dtw:network-cancel", { detail: JSON.stringify({ requestId }) }));
  }

  function nativeLinks() {
    return [...document.querySelectorAll('a[href*="/chat/s/"]')].filter((node) => !node.closest("#dtw-root") && !node.closest(".dtw-tree"));
  }
  function findSidebar() {
    const anchor = nativeLinks()[0] || [...document.querySelectorAll("span")].find((node) => node.textContent.trim() === "开启新对话");
    if (!anchor) return null;
    let node = anchor; let best = null;
    while (node && node !== document.body) {
      const rect = node.getBoundingClientRect();
      if (rect.left <= 3 && rect.width >= 190 && rect.width <= 430 && rect.height > innerHeight * 0.65) best = node;
      node = node.parentElement;
    }
    return best;
  }
  function listContainer() {
    const row = nativeLinks().find((link) => link.closest(".ds-scroll-area"));
    const scroller = row?.closest(".ds-scroll-area");
    if (!scroller) return null;
    let node = row;
    while (node.parentElement && node.parentElement !== scroller) node = node.parentElement;
    return node.parentElement === scroller ? scroller : null;
  }
  function hideNativeSessions(list) {
    for (const child of list.children) {
      if (child.classList?.contains("dtw-tree")) continue;
      if (!child.querySelector?.('a[href*="/chat/s/"]') && !child.matches?.('a[href*="/chat/s/"]')) continue;
      if (!child.hasAttribute("data-dtw-original-display")) child.dataset.dtwOriginalDisplay = child.style.display;
      child.style.display = "none";
    }
  }
  function showLoadingTree() {
    if (state.startupFailed) return;
    const list = listContainer();
    if (!list) return;
    if (list.querySelector(":scope > .dtw-tree")) {
      if (!state.snapshot) hideNativeSessions(list);
      return;
    }
    if (state.snapshot) { renderTree(); return; }
    const tree = document.createElement("section");
    tree.className = "dtw-tree dtw-owned";
    tree.innerHTML = '<div class="dtw-tools"><strong>项目</strong></div><div class="dtw-loading">正在加载会话…</div>';
    list.prepend(tree);
    hideNativeSessions(list);
  }
  function restoreNativeSessions() {
    document.querySelectorAll(".dtw-tree").forEach((tree) => tree.remove());
    document.querySelectorAll("[data-dtw-original-display]").forEach((child) => {
      child.style.display = child.dataset.dtwOriginalDisplay;
      delete child.dataset.dtwOriginalDisplay;
    });
  }
  function showToast(message, ms = 3600) {
    let node = root.querySelector(".dtw-toast");
    if (!node) { node = document.createElement("div"); node.className = "dtw-toast"; root.append(node); }
    node.textContent = message; node.hidden = false;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => { node.hidden = true; }, ms);
  }
  function projects() { return (state.snapshot?.projects || []).filter((item) => !item.archived && !item.systemKind).sort((a, b) => a.name.localeCompare(b.name, "zh")); }
  function membership(sessionId) { return state.snapshot?.memberships.find((item) => item.sessionId === sessionId) || null; }
  function newChatMemoryEnabled() {
    return Boolean(state.pendingNewProjectId || (state.snapshot?.settings.memoryModeDefault && !state.newChatMemoryOff));
  }
  function automationSession(sessionId) { return state.snapshot?.sessions.some((item) => item.sessionId === sessionId
    && ["CLASSIFY", "MEMORY", "AUTOMATION"].includes(item.purpose)); }
  function sessionRows(items) {
    return items.map((session) => `<div class="dtw-session ${currentId() === session.sessionId ? "active" : ""}" data-session="${esc(session.sessionId)}">
      <button data-action="open-session" data-id="${esc(session.sessionId)}" title="${esc(session.title || "新会话")}">${esc(session.title || "新会话")}</button>
      ${["USER", "AUTOMATION"].includes(session.purpose) ? `<button class="dtw-session-menu" data-action="session-menu" data-id="${esc(session.sessionId)}" aria-label="会话操作">⋯</button>` : ""}
    </div>`).join("");
  }
  function renderTree() {
    const list = listContainer();
    if (!list || !state.snapshot) return;
    let tree = list.querySelector(":scope > .dtw-tree");
    if (!tree) { tree = document.createElement("section"); tree.className = "dtw-tree dtw-owned"; list.prepend(tree); }
    const nativeOrder = new Map(nativeLinks().map((link, index) => [idFromHref(link.href), index]));
    const all = state.snapshot.sessions.filter((item) => !item.deleted);
    const user = DTWHistory.sortSessionsNewestFirst(all.filter((item) => item.purpose === "USER"), nativeOrder);
    const jobs = DTWHistory.sortSessionsNewestFirst(all.filter((item) => ["CLASSIFY", "MEMORY", "AUTOMATION"].includes(item.purpose)), nativeOrder);
    const groups = state.snapshot.projects.filter((item) => !item.systemKind || item.systemKind === "AUTOMATION")
      .sort((a, b) => Number(Boolean(a.systemKind)) - Number(Boolean(b.systemKind))
      || Number(a.archived) - Number(b.archived) || a.name.localeCompare(b.name, "zh"))
      .map((project) => ({ id: project.projectId, title: `${project.archived ? "📦 " : ""}${project.name}`,
      system: Boolean(project.systemKind),
      items: project.systemKind === "AUTOMATION" ? jobs : user.filter((item) => membership(item.sessionId)?.projectId === project.projectId) }));
    groups.push({ id: "unassigned", title: "未归类", items: user.filter((item) => !membership(item.sessionId)?.projectId) });
    const suggestions = state.snapshot.jobs.filter((job) => job.type === "CLASSIFY" && job.status === "NEEDS_REVIEW" && job.result?.choice === "NEW");
    tree.innerHTML = `<div class="dtw-tools"><strong>项目</strong><button data-action="create-project">＋</button><button data-action="open-options" title="设置">⚙</button></div>
      ${suggestions.map((job) => `<div class="dtw-suggestion">建议新建「${esc(job.result.suggestedName)}」<div><button data-action="accept-suggestion" data-id="${esc(job.jobId)}">创建并移入</button><button data-action="reject-suggestion" data-id="${esc(job.jobId)}">忽略</button></div></div>`).join("")}
      ${groups.map((group) => `<section class="dtw-group"><div class="dtw-group-head">
        <button data-action="collapse" data-id="${esc(group.id)}" aria-label="展开或收起">${state.collapsed.has(group.id) ? "▸" : "▾"}</button>
        <button class="dtw-group-name" data-action="${group.id === "unassigned" || group.system ? "noop" : "project-menu"}" data-id="${esc(group.id)}">${esc(group.title)} <small>${group.items.length}</small></button>
      </div>${state.collapsed.has(group.id) ? "" : `<div class="dtw-group-items">${sessionRows(group.items)}</div>`}</section>`).join("")}`;
    // Keep DSW's React nodes mounted so native navigation and menus still work.
    hideNativeSessions(list);
  }
  function findEditor() {
    for (const selector of ["textarea#chat-input", ".ds-textarea textarea", ".ProseMirror[contenteditable]", '[role="textbox"][contenteditable]', "textarea[placeholder]", "[contenteditable]"]) {
      const found = [...document.querySelectorAll(selector)].find((node) => !root.contains(node));
      if (found) return found;
    }
    return null;
  }
  function editorText(editor) { return editor?.value ?? editor?.innerText ?? editor?.textContent ?? ""; }
  function setEditor(editor, value) {
    editor.focus();
    if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(editor), "value")?.set;
      if (setter) setter.call(editor, value); else editor.value = value;
    } else editor.textContent = value;
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  }
  function controlLabel(control) { return `${control.getAttribute("aria-label") || ""} ${control.getAttribute("title") || ""} ${control.textContent || ""}`.trim(); }
  function nativeSend(editor) {
    // DeepSeek's current send control has no label or .ds-icon-send class.
    // It is the primary round button inside the same composer as the editor.
    for (let parent = editor?.parentElement, depth = 0; parent && depth < 5; parent = parent.parentElement, depth += 1) {
      const button = parent.querySelector('button.ds-button--primary.ds-button--circle, [role="button"].ds-button--primary.ds-button--circle');
      if (button && !button.closest("#dtw-root")) return button;
    }
    const controls = [...document.querySelectorAll('button, div[role="button"]')].filter((node) => !node.closest("#dtw-root") && !node.closest(".dtw-tree"));
    return controls.find((node) => /^(send|发送|提交)$/i.test(controlLabel(node)))
      || controls.find((node) => node.querySelector(".ds-icon-send") || /send|发送/i.test(controlLabel(node))) || null;
  }
  function sendEnabled(button) {
    return Boolean(button && button.isConnected && !button.disabled && !button.hasAttribute("disabled")
      && button.getAttribute("aria-disabled") !== "true" && !button.classList.contains("ds-button--disabled"));
  }
  async function submit(editor) {
    let button;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      button = nativeSend(editor);
      if (sendEnabled(button)) break;
      await delay(100);
    }
    if (!sendEnabled(button)) throw new Error(button ? "DeepSeek 发送按钮未启用" : "找不到 DeepSeek 发送按钮");
    state.bypassSend = true;
    try { button.click(); } finally { state.bypassSend = false; }
  }
  function isGenerating() {
    return [...document.querySelectorAll('button, div[role="button"]')]
      .some((node) => !node.closest("#dtw-root") && /stop|停止生成|停止回答/i.test(controlLabel(node)));
  }
  function composerToggles(editor) {
    let container = editor;
    for (let depth = 0; container && depth < 12; depth++, container = container.parentElement) {
      const labels = { thinking: null, search: null };
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
      while (walker.nextNode() && (!labels.thinking || !labels.search)) {
        const node = walker.currentNode;
        const element = node.parentElement;
        const value = node.textContent.trim();
        if (!element || !value || value.length > 30 || editor.contains(element)
          || element.closest("#dtw-root, .dtw-memory-button")) continue;
        const kind = /^(深度思考|DeepThink)(?:\s.*)?$/i.test(value) ? "thinking"
          : /^(智能搜索|联网搜索|网络搜索|搜索|Web Search)(?:\s.*)?$/i.test(value) ? "search" : "";
        if (!kind || labels[kind]) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        if (range.getClientRects().length) labels[kind] = element;
      }
      if (labels.thinking && labels.search) {
        const control = (label, other) => {
          const interactive = label.closest('button, [role="button"]');
          if (interactive && !interactive.contains(other)) return interactive;
          let node = label;
          while (node.parentElement && !node.parentElement.contains(other)) node = node.parentElement;
          return node;
        };
        return {
          thinking: control(labels.thinking, labels.search),
          search: control(labels.search, labels.thinking),
        };
      }
      if (container === document.body) break;
    }
    return null;
  }
  function nativeToggleIsOn(control) {
    return control?.getAttribute("aria-pressed") === "true"
      || /^(on|true|checked|active)$/i.test(control?.getAttribute("data-state") || "")
      || control?.getAttribute("aria-checked") === "true";
  }
  function makeMemoryButton(prototype) {
    const button = prototype.cloneNode(true);
    button.classList.add("dtw-memory-button");
    button.dataset.action = "toggle-memory";
    button.removeAttribute("id");
    button.removeAttribute("aria-describedby");
    button.removeAttribute("aria-controls");
    button.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
    button.querySelectorAll("[data-action]").forEach((node) => node.removeAttribute("data-action"));
    if (button instanceof HTMLButtonElement) button.type = "button";
    else { button.setAttribute("role", "button"); button.tabIndex = 0; }
    const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
    const labels = [];
    while (walker.nextNode()) if (walker.currentNode.textContent.trim()) labels.push(walker.currentNode);
    const label = labels.find((node) => /深度思考|智能搜索|联网搜索|网络搜索|DeepThink|Web Search/i.test(node.textContent)) || labels.at(-1);
    if (label) label.textContent = "项目记忆";
    else { const span = document.createElement("span"); span.textContent = "项目记忆"; button.append(span); }
    const icon = button.querySelector("svg");
    if (icon) {
      icon.setAttribute("viewBox", "0 0 24 24");
      icon.setAttribute("fill", "none");
      icon.setAttribute("stroke", "currentColor");
      icon.setAttribute("stroke-width", "1.8");
      icon.setAttribute("stroke-linecap", "round");
      icon.setAttribute("stroke-linejoin", "round");
      icon.innerHTML = '<path d="M12 5.5c-2.4-1.5-5-1.6-8-.6v13c3-1 5.6-.9 8 .6 2.4-1.5 5-1.6 8-.6v-13c-3-1-5.6-.9-8 .6Z"/><path d="M12 5.5v13"/>';
    }
    return button;
  }
  function renderMemoryButton() {
    const editor = findEditor();
    if (!editor || !state.snapshot || state.automationRunning || state.rolloverRunning) return;
    const toggles = composerToggles(editor);
    if (!toggles) return;
    const { thinking, search } = toggles;
    const anchor = thinking.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING ? search : thinking;
    let button = document.querySelector(".dtw-memory-button");
    if (!button || !button.isConnected) button = makeMemoryButton(anchor);
    if (button.previousElementSibling !== anchor) anchor.after(button);
    const row = membership(currentId());
    const isAutomation = automationSession(currentId());
    const enabled = isAutomation ? false : currentId() ? Boolean(row?.memoryModeEnabled) : newChatMemoryEnabled();
    const exemplar = [thinking, search].find((node) => nativeToggleIsOn(node) === enabled);
    if (exemplar) {
      button.className = `${exemplar.className} dtw-memory-button`;
      button.style.cssText = exemplar.style.cssText;
      for (const attr of ["data-state", "aria-checked"]) {
        if (exemplar.hasAttribute(attr)) button.setAttribute(attr, exemplar.getAttribute(attr));
        else button.removeAttribute(attr);
      }
    } else if (button.hasAttribute("data-state")) {
      button.setAttribute("data-state", enabled ? "on" : "off");
    }
    button.classList.toggle("dtw-native-state-fallback", !exemplar);
    button.classList.toggle("is-on", enabled);
    button.setAttribute("aria-pressed", String(enabled));
    button.setAttribute("aria-label", `发送时带入项目记忆，${enabled ? "已开启" : "已关闭"}`);
    button.title = isAutomation ? "自动化会话仅用于收纳，不使用项目记忆"
      : row?.projectId || state.pendingNewProjectId ? `发送时带入项目记忆：${enabled ? "开" : "关"}；项目记忆会自动整理` : "发送前选择项目以使用记忆";
  }
  function messageNodes() {
    const roleOf = (node) => {
      const role = String(node.getAttribute?.("data-message-author-role") || "").toLowerCase();
      if (role === "user" || role === "human") return "USER";
      if (role === "assistant") return "ASSISTANT";
      if (node.classList?.contains("d29f3d7d") || node.closest?.("div._9663006")) return "USER";
      if (node.classList?.contains("ds-message") || node.closest?.("div._4f9bf79._43c05b5")) return "ASSISTANT";
      return "";
    };
    const raw = [...document.querySelectorAll('[data-message-author-role], div.d29f3d7d, div.ds-message')]
      .filter((node) => !node.closest("#dtw-root") && roleOf(node));
    return raw.filter((node) => !raw.some((other) => other !== node && roleOf(other) === roleOf(node) && other.contains(node)))
      .sort((a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
  }
  function nodeText(node) { const copy = node.cloneNode(true); copy.querySelectorAll(".dtw-message-meta").forEach((x) => x.remove()); return (copy.innerText || copy.textContent || "").trim(); }
  function renderMessageInfo() {
    const sessionId = currentId();
    if (!membership(sessionId)?.projectId || !state.lastHistory || state.lastHistory.conversationId !== sessionId) return false;
    const records = state.lastHistory.records;
    const byId = new Map(records.map((entry) => [entry.messageId, entry]));
    const branch = []; let id = state.lastHistory.currentMessageId; const seen = new Set();
    while (Number.isInteger(id) && byId.has(id) && !seen.has(id)) { seen.add(id); branch.push(byId.get(id)); id = byId.get(id).parentId; }
    branch.reverse();
    const nodes = messageNodes();
    if (nodes.length !== branch.length) return false;
    const labels = new Set();
    for (let index = 0; index < nodes.length; index++) {
      const record = branch[index]; const node = nodes[index];
      let label = node.nextElementSibling?.classList.contains("dtw-message-meta")
        ? node.nextElementSibling : node.querySelector(":scope > .dtw-message-meta");
      if (!label) { label = document.createElement("div"); label.className = "dtw-message-meta dtw-owned"; }
      if (node.nextElementSibling !== label) node.after(label);
      labels.add(label);
      const date = record.insertedAtMs ? new Date(record.insertedAtMs).toLocaleString("zh-CN") : "日期未知";
      const local = DTWHistory.localTokenUsage(branch, index);
      const token = Number.isFinite(record.accumulatedTokenUsage)
        ? ` · ${local === null ? "" : `本次 ${local} tokens · `}累计 ${record.accumulatedTokenUsage} tokens` : "";
      const text = `${date}${token}`;
      if (label.textContent !== text) label.textContent = text;
    }
    document.querySelectorAll(".dtw-message-meta").forEach((label) => { if (!labels.has(label)) label.remove(); });
    return true;
  }
  async function refresh() {
    if (!state.accountId) return;
    state.snapshot = await send("snapshot");
    for (const session of state.snapshot.sessions) state.importedIds.add(session.sessionId);
    renderTree(); renderMemoryButton(); renderMessageInfo();
  }
  async function syncSessionTimes() {
    if (!state.accountId || !state.snapshot || state.syncingTimes) return;
    const known = new Map(state.snapshot.sessions.filter((session) => !session.deleted)
      .map((session) => [session.sessionId, session.updatedAtMs || 0]));
    const sessions = [...state.sessionTimes].filter(([id, item]) => known.has(id) && item.updatedAtMs > known.get(id))
      .map(([sessionId, item]) => ({ sessionId, ...item }));
    if (!sessions.length) return;
    state.syncingTimes = true;
    try {
      const result = await send("session-times-observe", { sessions });
      if (result.changed) await refresh();
    } finally { state.syncingTimes = false; }
  }
  async function syncVisibleSessions() {
    if (!state.accountId || state.syncingVisible) return;
    state.syncingVisible = true;
    let added = false;
    try {
      for (const link of nativeLinks()) {
        const sessionId = idFromHref(link.href);
        if (!sessionId || state.importedIds.has(sessionId)) continue;
        const title = link.textContent.trim().replace(/\s+/g, " ");
        await send("session-observe", { sessionId, title, loadedHistory: true,
          ...state.sessionTimes.get(sessionId) });
        state.importedIds.add(sessionId);
        if (title) state.titles.set(sessionId, title);
        added = true;
      }
      if (added) {
        await refresh();
        if (state.startupScanReady) startupMemoryScan().catch((error) => showToast(`记忆补扫失败：${error.message}`, 6500));
      }
    } finally {
      state.syncingVisible = false;
    }
  }
  async function titleSync() {
    if (!state.accountId || !state.snapshot) return;
    const known = new Set(state.snapshot.sessions.map((entry) => entry.sessionId));
    for (const link of nativeLinks()) {
      const id = idFromHref(link.href); const title = link.textContent.trim().replace(/\s+/g, " ");
      if (!id || !known.has(id) || !title || state.titles.get(id) === title) continue;
      state.titles.set(id, title);
      await send("session-observe", { sessionId: id, title, newSession: false }).catch(() => {});
    }
  }
  async function currentHistory(force = false) {
    const id = currentId();
    if (!id || (!force && state.lastHistory?.conversationId === id && Date.now() - state.lastHistoryAt < 12000)) return state.lastHistory;
    const result = await history(id);
    if (currentId() !== id) return result;
    state.lastHistory = result; state.lastHistoryAt = Date.now();
    if (renderMessageInfo()) state.messageInfoPending = false;
    if (state.snapshot?.sessions.some((entry) => entry.sessionId === id)) {
      await send("history-observe", { sessionId: id, records: result.records, currentMessageId: result.currentMessageId,
        title: result.title, updatedAtMs: result.updatedAtMs });
    }
    return result;
  }
  function syncRoute() {
    if (!state.snapshot) return;
    const route = currentId();
    if (route === state.uiRoute) return;
    state.uiRoute = route;
    state.lastHistory = null; state.lastHistoryAt = 0;
    state.messageInfoPending = Boolean(route && membership(route)?.projectId);
    document.querySelectorAll(".dtw-message-meta").forEach((node) => node.remove());
    renderTree(); renderMemoryButton();
    if (route && state.accountId) currentHistory(true).catch(() => {});
  }
  async function startupMemoryScan() {
    if (state.startupScanning) { state.startupRescanRequested = true; return; }
    if (!state.snapshot) return;
    let claim;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { claim = await send("startup-memory-claim"); break; }
      catch (error) {
        if (attempt === 2 || !error.message.includes("插件后台未响应")) throw error;
        await delay(500 * (attempt + 1));
      }
    }
    if (typeof claim?.claimed !== "boolean") throw new Error("插件后台返回的启动检查结果无效，请重新加载插件并刷新 DeepSeek 页面");
    if (!claim.claimed) return;
    state.startupScanning = true;
    let failed = 0;
    const verifiedSessionIds = [];
    try {
      const sessions = new Map(state.snapshot.sessions.filter((item) => item.purpose === "USER" && !item.deleted)
        .map((item) => [item.sessionId, item]));
      const queue = [...sessions.keys()];
      const worker = async () => {
        for (;;) {
          const sessionId = queue.shift();
          if (!sessionId) return;
          let captured = null;
          for (let attempt = 0; attempt < 2 && !captured; attempt++) {
            try { captured = await history(sessionId); } catch { if (attempt === 0) await delay(1000); }
          }
          if (!captured) { failed += 1; continue; }
          try {
            await send("history-observe", { sessionId, records: captured.records,
              currentMessageId: captured.currentMessageId, title: captured.title,
              updatedAtMs: captured.updatedAtMs, deferTurnCount: true });
            verifiedSessionIds.push(sessionId);
          } catch { failed += 1; }
        }
      };
      await Promise.all(Array.from({ length: Math.min(2, queue.length) }, worker));
      const result = await send("startup-memory-reconcile", { verifiedSessionIds });
      await refresh();
      if (result.startedProjects || result.startedPersonal || failed)
        showToast(`启动记忆检查：${result.startedProjects} 个项目${result.startedPersonal ? "、个人记忆" : ""}开始更新${failed ? `，${failed} 段会话未能读取` : ""}`, 6500);
    } finally {
      state.startupScanning = false;
      await send("startup-memory-release").catch(() => {});
      if (state.startupRescanRequested) {
        state.startupRescanRequested = false;
        startupMemoryScan().catch((error) => showToast(`记忆补扫失败：${error.message}`, 6500));
      }
    }
  }
  async function checkTurn() {
    if (!state.accountId || state.automationRunning || state.rolloverRunning) return;
    const route = currentId();
    const watch = state.turn;
    if (route !== watch.route) {
      if (route && state.pendingNewConversationAt && Date.now() - state.pendingNewConversationAt < 300000
        && !state.pendingNewKnownIds.has(route)) {
        state.newSessionIds.add(route);
        state.pendingNewConversationAt = 0;
        if (state.pendingNewProjectId) {
          await send("session-observe", { sessionId: route, newSession: true });
          const row = membership(route);
          if (row?.projectId !== state.pendingNewProjectId) await send("membership-move", { sessionId: route, projectId: state.pendingNewProjectId });
          await send("memory-toggle", { sessionId: route, enabled: true });
          state.pendingNewProjectId = "";
          await refresh();
        }
      }
      state.newChatMemoryOff = false;
      Object.assign(watch, { route, count: 0, text: "", since: Date.now(), generating: false, primed: false });
    }
    if (!route) return;
    const nodes = messageNodes(); const last = nodes.at(-1); const text = last ? nodeText(last) : "";
    const running = isGenerating();
    if (running) { watch.generating = true; watch.count = nodes.length; watch.text = text; watch.since = Date.now(); watch.primed = true;
      if (state.submittedAtMs && text && last?.matches?.('div.ds-message,[data-message-author-role="assistant"]') && !state.firstOutputAtMs)
        state.firstOutputAtMs = Date.now(); return; }
    if (nodes.length !== watch.count || text !== watch.text) {
      if (watch.primed && (text.length > watch.text.length || nodes.length - watch.count === 2)) watch.generating = true;
      watch.count = nodes.length; watch.text = text; watch.since = Date.now(); watch.primed = true; return;
    }
    if (!watch.generating || !text || Date.now() - watch.since < 2500) return;
    watch.generating = false;
    try {
      const captured = await currentHistory(true);
      const tip = captured?.records.find((entry) => entry.messageId === captured.currentMessageId);
      if (!tip || tip.role !== "ASSISTANT" || state.reportedTips.get(route) === tip.messageId) return;
      state.reportedTips.set(route, tip.messageId);
      const newSession = state.newSessionIds.has(route);
      const title = nativeLinks().find((link) => idFromHref(link.href) === route)?.textContent.trim() || captured.title;
      const branch = captured.records;
      const latestUser = [...branch].reverse().find((entry) => entry.role === "USER");
      await send("turn-completed", { sessionId: route, newSession, title, history: captured,
        metric: state.submittedAtMs ? { submittedAtMs: state.submittedAtMs, firstOutputAtMs: state.firstOutputAtMs,
          userMessageId: latestUser?.messageId ?? null, assistantMessageId: tip.messageId,
          memoryModeUsed: Boolean(membership(route)?.memoryModeEnabled) } : null });
      state.submittedAtMs = null; state.firstOutputAtMs = null;
      state.newSessionIds.delete(route);
      await refresh();
    } catch (error) { showToast(`会话同步失败：${error.message}`); }
  }
  async function confirmUserMessage(jobId, expected, timeout = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const id = currentId();
      if (id) {
        try {
          const captured = await history(id);
          const user = [...captured.records].reverse().find((entry) => entry.role === "USER");
          if (user?.fragments.some((fragment) => fragment.type === "REQUEST" && fragment.content.includes(expected))) {
            await send("send-status", { jobId, confirmed: true, sessionId: id,
              userMessageId: user.messageId, title: captured.title });
            if (state.pendingNewProjectId) {
              state.pendingNewProjectId = "";
              state.pendingNewConversationAt = 0;
              await refresh();
            }
            return true;
          }
        } catch { /* DSW may still be creating the session. */ }
      }
      await delay(1200);
    }
    await send("send-status", { jobId, error: "无法确认 DSW 已收到用户消息" });
    return false;
  }
  async function doProjectSend(editor, prompt, jobId) {
    const original = editorText(editor);
    try {
      setEditor(editor, prompt);
      state.submittedAtMs = Date.now();
      await submit(editor);
      const okay = await confirmUserMessage(jobId, prompt.slice(-Math.min(prompt.length, 120)));
      if (!okay) showToast("发送结果不明，原始草稿已保存在作业记录中，请核对会话", 6000);
    } catch (error) {
      setEditor(editor, original);
      await send("send-status", { jobId, error: error.message }).catch(() => {});
      showToast(`发送未确认：${error.message}`, 6000);
    }
  }
  async function memorySend(editor) {
    if (state.pendingSend) return;
    state.pendingSend = true;
    const rawInput = editorText(editor).trim();
    try {
      if (!currentId() && newChatMemoryEnabled() && !state.pendingNewProjectId) {
        state.pickerSessionId = NEW_CHAT; renderModal(); return;
      }
      if (!currentId() && state.pendingNewProjectId) markPendingNewConversation();
      const prepared = await send("prepare-send", { sessionId: currentId(), newChatProjectId: state.pendingNewProjectId, rawInput });
      if (prepared.chooseProject) { state.pickerSessionId = currentId(); renderModal(); return; }
      if (prepared.native) { await submit(editor); return; }
      if (prepared.rollover) {
        await send("rollover-start", { jobId: prepared.jobId });
        showToast("已打开后继会话；确认 DSW 收到消息后会清空原草稿", 5000);
        return;
      }
      await doProjectSend(editor, prepared.prompt, prepared.jobId);
    } catch (error) { showToast(error.message, 5000); }
    finally { state.pendingSend = false; }
  }
  async function runAutomation(message) {
    state.automationRunning = true;
    let command = null;
    try {
      const editor = await waitEditor();
      if (currentId()) throw new Error("自动化页面未处于新会话，已停止发送以保护原会话");
      command = await arm(message.prompt, "automation");
      const initial = messageNodes().length;
      const applied = waitEvent("dtw:network-applied", command.requestId, 15000);
      applied.catch(() => {});
      setEditor(editor, command.marker);
      await submit(editor); await applied;
      await send("automation-progress", { jobId: message.jobId, phase: "WAITING_REPLY" });
      const start = Date.now(); let stable = ""; let stableAt = 0; let lastHistoryCheck = 0;
      let lastHeartbeat = start; let historyAvailable = false; let reportedAutomationId = "";
      while (Date.now() - start < 360000) {
        const route = currentId();
        if (route && route !== reportedAutomationId) {
          await send("automation-progress", { jobId: message.jobId, phase: "WAITING_REPLY", automationSessionId: route });
          reportedAutomationId = route;
        }
        if (route && Date.now() - lastHistoryCheck > 4000) {
          lastHistoryCheck = Date.now();
          try {
            const captured = await history(route);
            historyAvailable = true;
            const answer = captured.records.find((entry) => entry.messageId === captured.currentMessageId);
            const promptPrefix = message.prompt.slice(0, 80).replace(/\s+/g, " ").trim();
            const hasPrompt = captured.records.some((entry) => entry.role === "USER"
              && entry.fragments.some((part) => part.type === "REQUEST"
                && part.content.replace(/\s+/g, " ").includes(promptPrefix)));
            const response = answer?.fragments.filter((part) => part.type === "RESPONSE").map((part) => part.content).join("\n\n").trim();
            if (hasPrompt && answer?.role === "ASSISTANT" && answer.status === "FINISHED" && response) {
              await send("automation-result", { jobId: message.jobId, raw: response, automationSessionId: route }); return;
            }
          } catch { /* History may be unavailable until DSW creates the session. */ }
        }
        const nodes = messageNodes();
        const text = nodes.length > initial ? nodeText(nodes.at(-1)) : "";
        if (!historyAvailable && text.length > 2 && !isGenerating()) {
          if (text === stable) { if (Date.now() - stableAt > 3000) {
            await send("automation-result", { jobId: message.jobId, raw: text, automationSessionId: currentId() }); return;
          } } else { stable = text; stableAt = Date.now(); }
        }
        if (Date.now() - lastHeartbeat > 20000) {
          await send("automation-progress", { jobId: message.jobId, phase: "WAITING_REPLY", automationSessionId: route });
          lastHeartbeat = Date.now();
        }
        await delay(800);
      }
      throw new Error("DSW 结构化回答超时");
    } catch (error) {
      if (command) {
        cancel(command.requestId);
        const editor = findEditor();
        if (editor && editorText(editor).trim() === command.marker) setEditor(editor, "");
      }
      await send("automation-result", { jobId: message.jobId, error: error.message, automationSessionId: currentId() }).catch(() => {});
    } finally { state.automationRunning = false; }
  }
  async function runRollover(message) {
    state.rolloverRunning = true;
    try {
      const editor = await waitEditor();
      await doProjectSend(editor, message.prompt, message.jobId);
      await refresh();
    } catch (error) { await send("send-status", { jobId: message.jobId, error: error.message }).catch(() => {}); }
    finally { state.rolloverRunning = false; }
  }
  async function waitEditor() { for (let i = 0; i < 100; i++) { const editor = findEditor(); if (editor) return editor; await delay(300); } throw new Error("找不到 DSW 输入框"); }

  function renderModal() {
    let box = root.querySelector(".dtw-modal");
    if (!state.pickerSessionId && !state.modal) { box?.remove(); return; }
    if (!box) { box = document.createElement("div"); box.className = "dtw-modal"; root.append(box); }
    const choices = projects().map((item) => `<button data-action="move-to" data-id="${esc(item.projectId)}">${esc(item.name)}</button>`).join("");
    const selected = state.snapshot?.sessions.find((item) => item.sessionId === state.pickerSessionId);
    const canMarkAutomation = selected?.purpose === "USER" && !membership(selected.sessionId)?.projectId
      && !membership(selected.sessionId)?.memoryModeEnabled;
    const nativeMenu = state.pickerSessionId === NEW_CHAT ? ""
      : `<button data-action="native-menu" data-id="${esc(state.pickerSessionId)}">DSW 原生操作（改名、置顶、删除）</button>`;
    box.innerHTML = `<div class="dtw-dialog"><header><strong>${selected?.purpose === "AUTOMATION" ? "自动化会话" : state.pickerSessionId ? "选择项目" : "项目操作"}</strong><button data-action="close-modal">×</button></header>
      ${state.pickerSessionId ? `<div class="dtw-picker-list">${selected?.purpose === "AUTOMATION"
        ? `<button data-action="automation-unmark" data-id="${esc(selected.sessionId)}">恢复为普通会话（未归类）</button>${nativeMenu}`
        : `${choices || "请先新建项目"}${state.pickerSessionId === NEW_CHAT ? "" : `<button data-action="move-to" data-id="">移到未归类</button>`}<button data-action="create-and-move">＋ 新项目</button>${canMarkAutomation ? `<button data-action="automation-mark" data-id="${esc(selected.sessionId)}">收纳到自动化会话</button>` : ""}${nativeMenu}`}</div>`
        : `<div class="dtw-picker-list"><button data-action="rename-project" data-id="${esc(state.modal)}">重命名</button><button data-action="edit-goal" data-id="${esc(state.modal)}">编辑项目目标</button><button data-action="archive-project" data-id="${esc(state.modal)}">${state.snapshot?.projects.find((p) => p.projectId === state.modal)?.archived ? "恢复项目" : "归档项目"}</button></div>`}</div>`;
  }
  async function move(sessionId, projectId) {
    await send("membership-move", { sessionId, projectId }); await refresh(); showToast("会话归属已更新");
    if (projectId) startupMemoryScan().catch((error) => showToast(`记忆补扫失败：${error.message}`, 6500));
  }
  async function enableMemory(sessionId) {
    await send("memory-toggle", { sessionId, enabled: true });
    await refresh();
    try {
      await currentHistory(true);
      showToast("发送时带入项目记忆已开启，正在检查待整理轮次");
    } catch { showToast("发送时带入项目记忆已开启，历史同步后会继续整理"); }
    startupMemoryScan().catch((error) => showToast(`记忆补扫失败：${error.message}`, 6500));
  }
  async function handleAction(button) {
    const action = button.dataset.action; const id = button.dataset.id || "";
    try {
      if (action === "collapse") { state.collapsed.has(id) ? state.collapsed.delete(id) : state.collapsed.add(id); renderTree(); }
      if (action === "open-session") {
        const link = nativeLinks().find((item) => idFromHref(item.href) === id);
        if (link) link.click(); else location.href = `https://chat.deepseek.com/a/chat/s/${encodeURIComponent(id)}`;
      }
      if (action === "session-menu") {
        state.pickerSessionId = id; renderModal();
      }
      if (action === "automation-mark" || action === "automation-unmark") {
        await send(action, { sessionId: id });
        state.pickerSessionId = ""; renderModal(); await refresh();
        showToast(action === "automation-mark" ? "已收纳到自动化会话" : "已恢复到未归类");
      }
      if (action === "native-menu") {
        const link = nativeLinks().find((item) => idFromHref(item.href) === id);
        const native = link?.querySelector('[role="button"], button');
        state.pickerSessionId = ""; renderModal();
        if (native) native.click(); else showToast("当前会话不在 DSW 可见历史列表中，请先打开会话");
      }
      if (action === "project-menu") { state.modal = id; renderModal(); }
      if (action === "close-modal") { state.modal = ""; state.pickerSessionId = ""; state.enableMemoryAfterMove = ""; renderModal(); }
      if (action === "create-project" || action === "create-and-move") {
        const name = prompt("项目名称")?.trim(); if (!name) return;
        const created = await send("project-create", { name });
        if (action === "create-and-move") {
          const sessionId = state.pickerSessionId;
          if (sessionId === NEW_CHAT) {
            state.pendingNewProjectId = created.project.projectId;
            state.newChatMemoryOff = false;
            showToast("项目记忆已开启，发送首条消息后自动归入项目");
          } else {
            await move(sessionId, created.project.projectId);
            if (state.enableMemoryAfterMove === sessionId) await enableMemory(sessionId);
          }
          state.pickerSessionId = ""; state.enableMemoryAfterMove = ""; renderModal();
        }
        await refresh();
      }
      if (action === "move-to") {
        const sessionId = state.pickerSessionId;
        if (sessionId === NEW_CHAT) {
          state.pendingNewProjectId = id;
          state.newChatMemoryOff = false;
          showToast("项目记忆已开启，发送首条消息后自动归入项目");
        } else {
          await move(sessionId, id || null);
          if (id && state.enableMemoryAfterMove === sessionId) await enableMemory(sessionId);
        }
        state.pickerSessionId = ""; state.enableMemoryAfterMove = ""; renderModal();
        renderMemoryButton();
      }
      if (action === "rename-project" || action === "edit-goal") {
        const project = state.snapshot.projects.find((item) => item.projectId === id);
        const value = prompt(action === "rename-project" ? "项目名称" : "简短目标", action === "rename-project" ? project?.name : project?.goalShort)?.trim();
        if (value === undefined) return;
        await send("project-update", { projectId: id, [action === "rename-project" ? "name" : "goalShort"]: value });
        state.modal = ""; renderModal(); await refresh();
      }
      if (action === "archive-project") {
        const project = state.snapshot.projects.find((item) => item.projectId === id);
        await send("project-update", { projectId: id, archived: !project?.archived }); state.modal = ""; renderModal(); await refresh();
      }
      if (action === "accept-suggestion" || action === "reject-suggestion") { await send("suggestion-confirm", { jobId: id, accept: action === "accept-suggestion" }); await refresh(); }
      if (action === "open-options") await send("open-options");
      if (action === "toggle-memory") {
        const sessionId = currentId();
        if (automationSession(sessionId)) { showToast("自动化会话仅用于收纳，不使用项目记忆"); return; }
        if (!sessionId) {
          if (newChatMemoryEnabled()) {
            state.pendingNewProjectId = ""; state.newChatMemoryOff = true;
            renderMemoryButton(); showToast("项目记忆已关闭");
          } else { state.newChatMemoryOff = false; state.pickerSessionId = NEW_CHAT; renderModal(); }
          return;
        }
        let row = membership(sessionId);
        if (!row) {
          const title = nativeLinks().find((link) => idFromHref(link.href) === sessionId)?.textContent.trim();
          await send("session-observe", { sessionId, title, loadedHistory: true });
          await refresh();
          row = membership(sessionId);
        }
        if (!row) throw new Error("会话登记失败，请刷新后重试");
        if (!row.memoryModeEnabled && !row.projectId) {
          state.pickerSessionId = sessionId; state.enableMemoryAfterMove = sessionId; renderModal(); return;
        }
        if (row.memoryModeEnabled) { await send("memory-toggle", { sessionId, enabled: false }); await refresh(); showToast("发送时不再带入记忆；项目仍会自动整理"); }
        else await enableMemory(sessionId);
      }
    } catch (error) { showToast(error.message, 5000); }
  }
  document.addEventListener("click", (event) => {
    const memoryButton = event.target.closest?.(".dtw-memory-button");
    if (memoryButton) {
      event.preventDefault(); event.stopImmediatePropagation(); handleAction(memoryButton); return;
    }
    const action = event.target.closest?.("[data-action]");
    if (action && (action.closest("#dtw-root") || action.closest(".dtw-owned"))) {
      event.preventDefault(); event.stopImmediatePropagation(); handleAction(action); return;
    }
    if (state.bypassSend || state.automationRunning || state.rolloverRunning) return;
    const editor = findEditor(); const native = editor && nativeSend(editor);
    if (!native || !native.contains(event.target)) return;
    if (!currentId() && editorText(editor).trim()) markPendingNewConversation();
    if (!membership(currentId())?.memoryModeEnabled && !(!currentId() && newChatMemoryEnabled())) return;
    event.preventDefault(); event.stopImmediatePropagation(); memorySend(editor);
  }, true);
  document.addEventListener("keydown", (event) => {
    const memoryButton = event.target.closest?.(".dtw-memory-button");
    if (memoryButton && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault(); event.stopImmediatePropagation(); handleAction(memoryButton); return;
    }
    if (state.bypassSend || state.automationRunning || state.rolloverRunning || event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    const editor = findEditor();
    if (!editor || (event.target !== editor && !editor.contains(event.target))) return;
    if (!currentId() && editorText(editor).trim()) markPendingNewConversation();
    if (!membership(currentId())?.memoryModeEnabled && !(!currentId() && newChatMemoryEnabled())) return;
    event.preventDefault(); event.stopImmediatePropagation(); memorySend(editor);
  }, true);
  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    if (message?.type === "dtw:automation") { reply({ ok: Boolean(state.accountId) }); if (state.accountId) runAutomation(message); return false; }
    if (message?.type === "dtw:rollover") { reply({ ok: Boolean(state.accountId) }); if (state.accountId) runRollover(message); return false; }
    if (message?.type === "dtw:rollover-confirmed") {
      const editor = findEditor();
      if (editor && editorText(editor).trim() === String(message.rawInput || "").trim()) setEditor(editor, "");
      reply({ ok: true }); return false;
    }
    return false;
  });
  window.addEventListener("dtw:sessions-deleted", (event) => {
    const detail = parse(event);
    if (!state.accountId || !Array.isArray(detail?.sessionIds)) return;
    send("session-delete", { sessionIds: detail.sessionIds }).then(refresh).catch(() => {});
  });
  window.addEventListener("dtw:session-times", (event) => {
    const detail = parse(event);
    for (const item of (Array.isArray(detail?.sessions) ? detail.sessions : [])) {
      if (typeof item?.sessionId !== "string" || !Number.isFinite(item.updatedAtMs)) continue;
      const previous = state.sessionTimes.get(item.sessionId);
      if (!previous || item.updatedAtMs >= previous.updatedAtMs) state.sessionTimes.set(item.sessionId, {
        updatedAtMs: item.updatedAtMs, currentMessageId: item.currentMessageId,
      });
    }
    syncSessionTimes().catch(() => {});
  });

  async function getAccount() {
    await Promise.race([pageHookReady, delay(10000)]);
    for (let attempt = 0; attempt < 20; attempt++) {
      const result = new Promise((resolve) => {
        const timer = setTimeout(() => { window.removeEventListener("dtw:profile-result", listener); resolve(null); }, 2500);
        function listener(event) { clearTimeout(timer); window.removeEventListener("dtw:profile-result", listener); resolve(parse(event)); }
        window.addEventListener("dtw:profile-result", listener);
        window.dispatchEvent(new CustomEvent("dtw:profile-request"));
      });
      const profile = await result;
      if (/^[\w-]{6,100}$/.test(profile?.accountId || "")) return profile.accountId;
      await delay(500);
    }
    return "";
  }
  async function start() {
    if (!document.body) { await new Promise((resolve) => new MutationObserver((_, observer) => { if (document.body) { observer.disconnect(); resolve(); } }).observe(document.documentElement, { childList: true })); }
    document.body.append(root);
    new MutationObserver(showLoadingTree).observe(document.body, { childList: true, subtree: true });
    let uiSyncScheduled = false;
    const scheduleUiSync = () => {
      if (uiSyncScheduled) return;
      uiSyncScheduled = true;
      requestAnimationFrame(() => {
        uiSyncScheduled = false;
        syncRoute();
        if (!state.snapshot) return;
        if (!document.querySelector(".dtw-memory-button")) renderMemoryButton();
        if (state.messageInfoPending && renderMessageInfo()) state.messageInfoPending = false;
      });
    };
    new MutationObserver(scheduleUiSync).observe(document.body, { childList: true, subtree: true });
    window.addEventListener("popstate", scheduleUiSync);
    window.navigation?.addEventListener("currententrychange", scheduleUiSync);
    showLoadingTree();
    state.knownAtStart = new Set([...nativeLinks().map((item) => idFromHref(item.href)), currentId()].filter(Boolean));
    state.accountId = await getAccount();
    if (!state.accountId) { state.startupFailed = true; restoreNativeSessions(); showToast("无法识别 DSW 账号，项目工作台已暂停", 10000); return; }
    await chrome.storage.local.set({ accountId: state.accountId });
    window.dispatchEvent(new Event("dtw:session-times-request"));
    await refresh();
    syncRoute();
    await syncVisibleSessions();
    await syncSessionTimes();
    state.startupScanReady = true;
    startupMemoryScan().catch((error) => showToast(`启动记忆检查失败：${error.message}`, 6500));
    setInterval(async () => {
      if (!chrome.runtime?.id) return;
      try { if (!state.automationRunning && !state.rolloverRunning) await syncVisibleSessions();
        await titleSync(); await checkTurn(); await syncSessionTimes(); renderTree(); renderMemoryButton();
        if (!state.startupScanning && currentId() && Date.now() - state.lastHistoryAt > 20000) await currentHistory();
        if (state.snapshot && Date.now() - (state.lastRefresh || 0) > 3000) { state.lastRefresh = Date.now(); await refresh(); }
      } catch { /* Leave native chat usable during transient DSW changes. */ }
    }, 1500);
  }
  start().catch((error) => console.warn("[DeepSeek 项目工作台]", error));
})();
