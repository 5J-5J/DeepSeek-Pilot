/* global DTWHistory, DTWMemoryDisplay, DTWUI */
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
    menu: null, selectedSessions: null, nativeActionRunning: false, historyRecovery: new Set(), toastTimer: 0, rendering: false, startupFailed: false, uiRoute: "", messageInfoPending: false,
    automationRunning: false, rolloverRunning: false, syncingChanges: false, dirtySessions: new Set(), observedHistories: new Map(), networkIssue: null,
    bypassSend: false, pendingSend: false,
    submittedAtMs: null, submittedRoute: "", firstOutputAtMs: null, lastHistory: null, lastHistoryAt: 0,
    turn: { route: "", count: 0, text: "", since: 0, generating: false, primed: false } };
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const idFromHref = (href) => { try { return new URL(href, location.href).pathname.match(/\/chat\/s\/([^/?#]+)/)?.[1] || ""; } catch { return ""; } };
  const currentId = () => idFromHref(location.href);
  const icons = {
    folder: '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v2M3 7v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9H3Z"/>',
    folderOpen: '<path d="M3 10V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v2M3 10h19l-3 10H3L1 10Z"/>',
    chevron: '<path d="m9 5 7 7-7 7"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    edit: '<path d="m16 3 5 5-12 12-6 1 1-6Z M14 5l5 5"/>',
    compose: '<path d="M12 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-7M16 3l5 5-10 10-5 1 1-5Z"/>',
    settings: '<path d="m9 3-1 3-3 1-2 3 2 2v3l2 3 3-1 2 2 3-1 1-3 3-1 2-3-2-2V7l-2-3-3 1-2-2Z"/><circle cx="12" cy="11" r="3"/>',
    archive: '<path d="M3 3h18v5H3ZM5 8v13h14V8M9 12h6"/>',
    pin: '<path d="m15 3 6 6-4 1-4 5v3l-7-7h3l5-4ZM3 21l6-6"/>',
    share: '<path d="M12 3v12m-5-7 5-5 5 5M5 13v8h14v-8"/>',
    select: '<rect x="3" y="3" width="5" height="5" rx="1"/><rect x="3" y="16" width="5" height="5" rx="1"/><path d="M12 5h9M12 18h9"/>',
    trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
    move: '<path d="M3 12V5h7l2 3h9v4M3 16h13m-4-4 4 4-4 4"/>',
    remove: '<path d="M3 12V5h7l2 3h9v4M3 17h12M18 15l4 4m0-4-4 4"/>',
    automation: '<rect x="4" y="7" width="16" height="14" rx="3"/><path d="M12 3v4M8 12v2M16 12v2M9 18h6"/>',
    back: '<path d="m14 5-7 7 7 7"/>',
  };
  const icon = (name, className = "") => `<svg class="dtw-icon ${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.folder}</svg>`;
  function markPendingNewConversation() {
    state.pendingNewConversationAt = Date.now();
    state.pendingNewKnownIds = new Set([...(state.snapshot?.sessions || []).map((item) => item.sessionId),
      ...nativeLinks().map((item) => idFromHref(item.href))]);
  }
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const parse = (event) => { try { return JSON.parse(event.detail); } catch { return null; } };
  const send = async (type, body = {}) => {
    if (!state.accountId) throw new Error("无法确认 DeepSeek 账号");
    const result = await chrome.runtime.sendMessage({ type: `dtw:${type}`, accountId: state.accountId, ...body });
    if (result == null) throw new Error(`插件后台未响应「${type}」。请在扩展管理页重新加载插件，然后刷新 DeepSeek 页面`);
    if (result?.ok === false) throw new Error(result.error || "操作失败");
    return result;
  };

  function waitEvent(name, requestId, ms = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error("DSW 页面响应超时")), ms);
      const good = (event) => { const detail = parse(event); if (detail?.requestId === requestId) finish(null, detail); };
      const bad = (event) => { const detail = parse(event); if (!detail?.requestId || detail.requestId === requestId) finish(Object.assign(new Error(detail?.error || "DSW 请求失败"), { code: detail?.code })); };
      function finish(error, detail) {
        clearTimeout(timer); window.removeEventListener(name, good); window.removeEventListener("dtw:network-error", bad);
        if (error) reject(error); else resolve(detail);
      }
      window.addEventListener(name, good); window.addEventListener("dtw:network-error", bad);
    });
  }
  const historyRequests = new Map();
  async function history(sessionId, options) {
    requireSendAllowed();
    let pending = historyRequests.get(sessionId);
    if (!pending) {
      pending = (async () => {
        const userAction = options?.userAction !== false;
        let slot = await send("history-request-slot", { userAction });
        while (slot.waitMs > 0 && !slot.blocked && !slot.rateLimited) {
          await delay(slot.waitMs);
          slot = await send("history-request-slot", { userAction });
        }
        if (slot.blocked || slot.rateLimited) throw Object.assign(new Error(slot.message || "插件请求已暂停"), { code: slot.code || "RATE_LIMITED" });
        window.dispatchEvent(new CustomEvent("dtw:request-state", { detail: JSON.stringify({ paused: Boolean(state.snapshot?.settings.automationPaused), issue: state.networkIssue, allowCurrentTask: userAction }) }));
        const requestId = `history_${crypto.randomUUID()}`;
        const result = waitEvent("dtw:history-result", requestId, 18000);
        window.dispatchEvent(new CustomEvent("dtw:history-request", { detail: JSON.stringify({ requestId, sessionId, accountId: state.accountId }) }));
        try { return (await result).data; }
        catch (error) {
          if (["RATE_LIMITED", "AUTH_REQUIRED", "ACCOUNT_RESTRICTED"].includes(error.code) && state.networkIssue?.code !== error.code)
            await reportRequestIssue({ code: error.code, message: error.message });
          throw error;
        }
      })();
      historyRequests.set(sessionId, pending);
      pending.finally(() => { if (historyRequests.get(sessionId) === pending) historyRequests.delete(sessionId); }).catch(() => {});
    }
    try {
      return DTWHistory.parseHistoryResponse(await pending, sessionId, options);
    } catch (error) {
      if (error.code === "SESSION_NOT_FOUND") {
        await send("session-delete", { sessionIds: [sessionId] });
        await refresh();
      }
      throw error;
    }
  }
  async function arm(prompt, operation) {
    requireSendAllowed();
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
      <button data-action="${state.selectedSessions ? "select-session" : "open-session"}" data-id="${esc(session.sessionId)}" ${state.selectedSessions ? `role="checkbox" aria-checked="${state.selectedSessions.has(session.sessionId)}"` : ""} title="${esc(session.title || "新会话")}">${state.selectedSessions ? `<span aria-hidden="true">${state.selectedSessions.has(session.sessionId) ? "☑" : "☐"}</span> ` : ""}${esc(session.title || "新会话")}</button>${session.pinned ? icon("pin", "dtw-pinned") : ""}
      ${!state.selectedSessions && ["USER", "AUTOMATION"].includes(session.purpose) ? `<button class="dtw-session-menu dtw-row-action" data-action="session-menu" data-id="${esc(session.sessionId)}" aria-label="${esc(session.title || "新会话")}的操作" aria-haspopup="menu">${icon("more")}</button>` : ""}
    </div>`).join("");
  }
  let automationHelpButton = null;
  function renderTree() {
    const list = listContainer();
    if (!list || !state.snapshot) return;
    let tree = list.querySelector(":scope > .dtw-tree");
    if (!tree) { tree = document.createElement("section"); tree.className = "dtw-tree dtw-owned"; list.prepend(tree); }
    const nativeOrder = new Map(nativeLinks().map((link, index) => [idFromHref(link.href), index]));
    const all = state.snapshot.sessions.filter((item) => !item.deleted);
    const user = DTWHistory.sortSessionsNewestFirst(all.filter((item) => item.purpose === "USER"), nativeOrder);
    const helpers = all.filter((item) => ["CLASSIFY", "MEMORY", "AUTOMATION"].includes(item.purpose));
    const retained = new Set(DTWHistory.sortSessionsNewestFirst(helpers.filter((item) => item.automationOrigin === "PLUGIN"))
      .slice(0, 10).map((item) => item.sessionId));
    const jobs = DTWHistory.sortSessionsNewestFirst(helpers.filter((item) => item.automationOrigin !== "PLUGIN" || retained.has(item.sessionId)));
    const groups = state.snapshot.projects.filter((item) => !item.archived && (!item.systemKind || item.systemKind === "AUTOMATION"))
      .sort((a, b) => Number(Boolean(a.systemKind)) - Number(Boolean(b.systemKind))
      || Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || a.name.localeCompare(b.name, "zh"))
      .map((project) => ({ id: project.projectId, title: project.name,
      system: Boolean(project.systemKind), archived: Boolean(project.archived), pinned: Boolean(project.pinned),
      items: project.systemKind === "AUTOMATION" ? jobs : user.filter((item) => membership(item.sessionId)?.projectId === project.projectId) }));
    const unassigned = { id: "unassigned", title: "未归类", items: user.filter((item) => !membership(item.sessionId)?.projectId) };
    const suggestions = state.snapshot.jobs.filter((job) => job.type === "CLASSIFY" && job.status === "NEEDS_REVIEW" && job.result?.choice === "NEW");
    const alertCount = state.snapshot.alerts?.count || 0;
    const contentKey = JSON.stringify([currentId(), alertCount, state.selectedSessions && [...state.selectedSessions], [...groups, unassigned].map((group) => ({ ...group,
      items: group.items.map(({ sessionId, title, purpose, pinned }) => ({ sessionId, title, purpose, pinned })) })), suggestions]);
    if (tree.dtwContentKey === contentKey) { hideNativeSessions(list); return; }
    tree.dtwContentKey = contentKey;
    const focused = tree.contains(document.activeElement) ? { ...document.activeElement.dataset } : null;
    const groupHtml = (group) => {
      const collapsed = state.collapsed.has(group.id);
      const special = group.id === "unassigned";
      return `<section class="dtw-group ${collapsed ? "is-collapsed" : ""} ${special ? "dtw-unassigned" : ""}" data-group="${esc(group.id)}"><div class="dtw-group-head">
        <button class="dtw-group-name" data-action="collapse" data-id="${esc(group.id)}" aria-expanded="${!collapsed}" title="${esc(group.title)} · ${group.items.length} 个会话">
          ${special ? "" : `<span class="dtw-folder-icon">${icon(group.archived ? "archive" : group.system ? "automation" : "folder", "dtw-folder-closed")}${icon(group.archived ? "archive" : group.system ? "automation" : "folderOpen", "dtw-folder-open")}${icon("chevron", "dtw-folder-caret")}</span>`}
          <span class="dtw-group-label">${esc(group.title)}</span>${group.pinned ? icon("pin", "dtw-pinned") : ""}${special ? icon("chevron", "dtw-section-caret") : ""}
        </button>${group.system ? '<span class="dtw-automation-help"></span>' : special ? "" : `<div class="dtw-group-actions"><button class="dtw-row-action" data-action="project-menu" data-id="${esc(group.id)}" aria-label="${esc(group.title)}的操作" aria-haspopup="menu">${icon("more")}</button>${group.archived ? "" : `<button class="dtw-row-action" data-action="project-new-chat" data-id="${esc(group.id)}" title="在此项目新建会话" aria-label="在${esc(group.title)}新建会话">${icon("compose")}</button>`}</div>`}
        </div><div class="dtw-group-body" ${collapsed ? 'inert aria-hidden="true"' : 'aria-hidden="false"'}><div class="dtw-group-items">${sessionRows(group.items)}</div></div></section>`;
    };
    const focusedHelp = document.activeElement === automationHelpButton;
    if (automationHelpButton) document.getElementById(automationHelpButton.getAttribute("aria-describedby"))?.hidePopover();
    tree.innerHTML = `<div class="dtw-tools"><button class="dtw-section-title" data-action="collapse" data-id="__projects__" aria-expanded="${!state.collapsed.has("__projects__")}">项目${icon("chevron", "dtw-section-caret")}</button><button class="dtw-row-action" data-action="create-project" title="新建项目" aria-label="新建项目">${icon("plus")}</button><button class="dtw-row-action ${alertCount ? "has-alert" : ""}" data-action="open-options" title="${alertCount ? `${alertCount} 项问题需要处理` : "设置"}" aria-label="${alertCount ? `设置，${alertCount} 项问题需要处理` : "设置"}">${icon("settings")}${alertCount ? `<span class="dtw-alert-dot" aria-hidden="true"></span>` : ""}</button></div>
      ${state.selectedSessions ? `<div class="dtw-selection-tools"><span>已选 ${state.selectedSessions.size} 项</span><button data-action="delete-selected" ${state.selectedSessions.size ? "" : "disabled"}>删除</button><button data-action="cancel-selection">取消</button></div>` : ""}<div class="dtw-projects dtw-group-body ${state.collapsed.has("__projects__") ? "is-collapsed" : ""}" ${state.collapsed.has("__projects__") ? 'inert aria-hidden="true"' : 'aria-hidden="false"'}><div class="dtw-group-items">
      ${suggestions.map((job) => `<div class="dtw-suggestion">建议新建「${esc(job.result.suggestedName)}」<div><button data-action="accept-suggestion" data-id="${esc(job.jobId)}">创建并移入</button><button data-action="reject-suggestion" data-id="${esc(job.jobId)}">忽略</button></div></div>`).join("")}
      ${groups.map(groupHtml).join("")}</div></div>${groupHtml(unassigned)}`;
    const helpSlot = tree.querySelector(".dtw-automation-help");
    if (helpSlot) {
      if (!automationHelpButton) {
        automationHelpButton = document.createElement("button");
        automationHelpButton.type = "button"; automationHelpButton.className = "dtw-help-trigger";
        automationHelpButton.textContent = "i"; automationHelpButton.setAttribute("aria-label", "自动化会话详情");
        DTWUI.setHelp(automationHelpButton, "这里收纳插件用于会话归类、记忆整理和压缩的辅助会话，以及手动收纳的会话。这些会话不参与普通会话的自动归类和记忆学习；可打开查看执行内容。插件辅助会话保留最近 10 条，队列空闲时更早记录会从 DeepSeek 删除。手动收纳和来源不明的会话全部保留，不占用这 10 个名额；手动收纳可恢复为普通会话。");
        document.getElementById(automationHelpButton.getAttribute("aria-describedby")).classList.add("dtw-help-tip", "dtw-owned");
      }
      helpSlot.append(automationHelpButton);
      if (focusedHelp) automationHelpButton.focus({ preventScroll: true });
    }
    if (focused) [...tree.querySelectorAll("[data-action]")].find((button) => button.dataset.action === focused.action && button.dataset.id === focused.id)?.focus({ preventScroll: true });
    // Keep DSW's React nodes mounted so native navigation and menus still work.
    hideNativeSessions(list);
    if (state.menu && !state.menu.anchor.isConnected) {
      const action = state.menu.kind === "project" ? "project-menu" : "session-menu";
      const anchor = [...tree.querySelectorAll("[data-action]")].find((node) => node.dataset.action === action && node.dataset.id === state.menu.id);
      if (anchor) { state.menu.anchor = anchor; anchor.setAttribute("aria-expanded", "true"); positionMenu(root.querySelector(".dtw-menu"), anchor); }
      else closeMenu();
    }
  }
  function toggleGroup(id, collapsed = !state.collapsed.has(id)) {
    closeMenu();
    collapsed ? state.collapsed.add(id) : state.collapsed.delete(id);
    const tree = document.querySelector(".dtw-tree");
    const group = id === "__projects__" ? tree?.querySelector(".dtw-projects")
      : [...(tree?.querySelectorAll("[data-group]") || [])].find((node) => node.dataset.group === id);
    group?.classList.toggle("is-collapsed", collapsed);
    const body = id === "__projects__" ? group : group?.querySelector(".dtw-group-body");
    if (body) { body.inert = collapsed; body.setAttribute("aria-hidden", String(collapsed)); }
    const toggle = [...(tree?.querySelectorAll('[data-action="collapse"]') || [])].find((node) => node.dataset.id === id);
    toggle?.setAttribute("aria-expanded", String(!collapsed));
    chrome.storage.local.set({ [`dtw.collapsed:${state.accountId}`]: [...state.collapsed] }).catch(() => {});
  }
  function findEditor() {
    for (const selector of ["textarea#chat-input", ".ds-textarea textarea", ".ProseMirror[contenteditable]", '[role="textbox"][contenteditable]', "textarea[placeholder]", "[contenteditable]"]) {
      const found = [...document.querySelectorAll(selector)].find((node) => !root.contains(node)
        && !node.closest?.('[data-message-author-role="user"], div._9663006, div.d29f3d7d'));
      if (found) return found;
    }
    return null;
  }
  function accountRestrictionText() {
    if (!document.body) return "";
    const restricted = /禁言|(?:account|you).*(?:banned|suspended|muted)|(?:banned|suspended|muted).*account/i;
    const editor = findEditor();
    const editorVisible = editor?.getClientRects().length && getComputedStyle(editor).visibility === "visible";
    if (editorVisible && !editor.disabled && editor.getAttribute("aria-disabled") !== "true"
      && editor.getAttribute("contenteditable") !== "false") return "";
    const placeholder = editor?.getAttribute("placeholder") || "";
    if (editorVisible && restricted.test(placeholder)) return placeholder.slice(0, 220);
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const text = walker.currentNode.textContent.trim();
      const parent = walker.currentNode.parentElement;
      if (!restricted.test(text) || !parent || parent.closest('#dtw-root, .dtw-owned, .dtw-tree, [data-message-author-role], div._9663006, div.d29f3d7d, .ds-message, .ds-markdown, textarea, input, [contenteditable], nav, aside, a[href*="/chat/s/"]')) continue;
      const range = document.createRange(); range.selectNodeContents(walker.currentNode);
      if (range.getClientRects().length && getComputedStyle(parent).visibility === "visible")
        return (parent.innerText || text).trim().slice(0, 220);
    }
    return "";
  }
  let restrictionReportedFor = "";
  let restrictionReport = Promise.resolve();
  function currentRequestIssue() {
    const text = accountRestrictionText();
    const message = text && `DeepSeek 账号已被禁言，插件请求已停止：${text}`;
    if (message && (state.networkIssue?.code !== "ACCOUNT_RESTRICTED" || state.networkIssue.message !== message
      || state.accountId && restrictionReportedFor !== state.accountId)) {
      const issue = { code: "ACCOUNT_RESTRICTED", message, observedAtMs: Date.now() };
      if (state.accountId) {
        restrictionReportedFor = state.accountId;
        restrictionReport = reportRequestIssue(issue);
        restrictionReport.catch(() => { restrictionReportedFor = ""; });
      } else { state.networkIssue = issue; restrictionReportedFor = ""; }
      window.dispatchEvent(new CustomEvent("dtw:request-state", { detail: JSON.stringify({ issue,
        paused: Boolean(state.snapshot?.settings.automationPaused) }) }));
    }
    const issue = state.networkIssue;
    return issue && (issue.code !== "RATE_LIMITED" || issue.untilMs > Date.now()) ? issue : null;
  }
  function requireSendAllowed() {
    const issue = currentRequestIssue();
    if (issue) throw Object.assign(new Error(issue.message), { code: issue.code });
  }
  function editorText(editor) { return editor?.value ?? editor?.innerText ?? editor?.textContent ?? ""; }
  function setEditor(editor, value, focus = true) {
    if (focus) editor.focus();
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
      requireSendAllowed();
      button = nativeSend(editor);
      if (sendEnabled(button)) break;
      await delay(100);
    }
    requireSendAllowed();
    if (!sendEnabled(button)) throw new Error(button ? "DeepSeek 发送按钮未启用" : "找不到 DeepSeek 发送按钮");
    const nodes = messageNodes();
    state.submittedAtMs ??= Date.now(); state.submittedRoute = currentId();
    Object.assign(state.turn, { route: currentId(), count: nodes.length, text: nodes.at(-1) ? nodeText(nodes.at(-1)) : "",
      since: Date.now(), generating: false, primed: true });
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
    button.setAttribute("aria-label", `首条消息带入项目记忆，${enabled ? "已开启" : "已关闭"}`);
    button.title = isAutomation ? "自动化会话仅用于收纳，不使用项目记忆"
      : row?.projectId || state.pendingNewProjectId ? `首条消息带入项目记忆：${enabled ? "开" : "关"}；个人与项目记忆均只带入一次，接续新会话时重新带入` : "选择项目以在首条消息带入项目记忆；个人记忆也仅首条消息带入";
  }
  function messageRole(node) {
    const role = String(node.getAttribute?.("data-message-author-role") || "").toLowerCase();
    if (role === "user" || role === "human") return "USER";
    if (role === "assistant") return "ASSISTANT";
    if (node.classList?.contains("d29f3d7d") || node.closest?.("div._9663006")) return "USER";
    if (node.classList?.contains("ds-message") || node.closest?.("div._4f9bf79._43c05b5")) return "ASSISTANT";
    return "";
  }
  function messageNodes() {
    const raw = [...document.querySelectorAll('[data-message-author-role], div.d29f3d7d, div.ds-message')]
      .filter((node) => !node.closest("#dtw-root") && messageRole(node));
    return raw.filter((node) => !raw.some((other) => other !== node && messageRole(other) === messageRole(node) && other.contains(node)))
      .sort((a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
  }
  function nodeText(node) { const copy = node.cloneNode(true); copy.querySelectorAll(".dtw-message-meta").forEach((x) => x.remove()); return (copy.innerText || copy.textContent || "").trim(); }
  const visibleUserMessages = new WeakMap();
  const visibleMemoryPanels = new WeakMap();
  const memoryEditors = new Map();
  let renderingMemoryEditors = false;
  let lastEditContext = "";
  function renderMemoryEditors() {
    if (renderingMemoryEditors || !state.snapshot || state.automationRunning || state.rolloverRunning) return;
    renderingMemoryEditors = true;
    try {
      const sessionId = currentId();
      const personal = Boolean(state.snapshot.settings.showPersonalMemory);
      const project = Boolean(state.snapshot.settings.showProjectMemory);
      const composer = findEditor();
      const detachedDrafts = [];
      for (const [editor, draft] of memoryEditors) {
        if (!editor.isConnected && draft.sessionId === sessionId) detachedDrafts.push(draft);
        if (!editor.isConnected || draft.sessionId !== sessionId) memoryEditors.delete(editor);
      }
      for (const editor of document.querySelectorAll('textarea, [contenteditable="true"]')) {
        if (editor === composer || editor.id === "chat-input" || editor.closest("#dtw-root, .dtw-owned")) continue;
        const value = editorText(editor);
        const host = editor.closest('[data-message-author-role="user"], div._9663006, div.d29f3d7d') || editor.parentElement;
        let draft = memoryEditors.get(editor);
        // React can replace the editor while the same message remains open.
        if (!draft) {
          draft = detachedDrafts.find((item) => item.host === host && item.shown === value);
          if (draft) memoryEditors.set(editor, draft);
        }
        if (!draft) {
          if (DTWMemoryDisplay.visibleText(value, false, false) === null) continue;
          const record = state.lastHistory?.conversationId === sessionId
            && state.lastHistory.records.find((entry) => entry.role === "USER" && DTWHistory.fragmentText(entry) === value.trim());
          draft = { original: value, shown: value, personal: true, project: true, sessionId, host, messageId: record?.messageId ?? null };
          memoryEditors.set(editor, draft);
        } else if (value !== draft.shown && value !== draft.original) {
          draft.original = DTWMemoryDisplay.mergeEditedText(draft.original, value, draft.personal, draft.project);
        }
        const shown = DTWMemoryDisplay.visibleText(draft.original, personal, project);
        if (shown === null) { memoryEditors.delete(editor); continue; }
        draft.shown = shown; draft.personal = personal; draft.project = project;
        if (value !== shown) {
          const start = editor.selectionStart; const end = editor.selectionEnd;
          const direction = editor.selectionDirection;
          setEditor(editor, shown, false);
          if (document.activeElement === editor && Number.isInteger(start)) {
            const question = DTWMemoryDisplay.visibleText(draft.original, false, false);
            const previousOffset = question ? value.lastIndexOf(question) : -1;
            const nextOffset = question ? shown.lastIndexOf(question) : -1;
            const delta = previousOffset >= 0 && nextOffset >= 0 && start >= previousOffset && end <= previousOffset + question.length
              ? nextOffset - previousOffset : shown.length - value.length;
            editor.setSelectionRange(Math.max(0, start + delta), Math.max(0, end + delta), direction);
          }
        }
      }
      const contexts = [...memoryEditors.values()].filter((draft) => draft.original !== draft.shown)
        .map((draft) => ({ sessionId: draft.sessionId, messageId: draft.messageId, visible: draft.shown, prompt: draft.original }));
      const detail = JSON.stringify({ contexts });
      if (detail !== lastEditContext) {
        lastEditContext = detail;
        window.dispatchEvent(new CustomEvent("dtw:edit-context", { detail }));
      }
    } finally { renderingMemoryEditors = false; }
  }
  document.addEventListener("input", (event) => {
    if (memoryEditors.has(event.target)) renderMemoryEditors();
  }, true);
  document.addEventListener("focusin", renderMemoryEditors, true);
  function restoreUserMessage(node) {
    const prior = visibleUserMessages.get(node);
    if (!prior) return;
    for (const part of prior.parts) {
      if (node.contains(part.node) && part.node.nodeValue === part.display) part.node.nodeValue = part.original;
    }
    visibleUserMessages.delete(node);
  }
  function renderUserMessage(node, record) {
    if (node.matches('textarea, [contenteditable="true"]') || node.querySelector('textarea, [contenteditable="true"]')) {
      visibleMemoryPanels.get(node)?.remove(); visibleMemoryPanels.delete(node);
      return;
    }
    const original = DTWHistory.fragmentText(record);
    const shown = DTWMemoryDisplay.visibleText(original,
      state.snapshot?.settings.showPersonalMemory, state.snapshot?.settings.showProjectMemory);
    const prior = visibleUserMessages.get(node);
    if (prior?.messageId === record.messageId && prior.shown === shown
      && prior.parts.every((part) => node.contains(part.node) && part.node.nodeValue === part.display)) return;
    restoreUserMessage(node);
    const existingPanel = visibleMemoryPanels.get(node);
    const memoryText = shown?.match(/<project_memory>\s*([\s\S]*?)\s*<\/project_memory>/i)?.[1];
    if (!node.textContent.includes("<project_memory>") && memoryText) {
      const panel = existingPanel || document.createElement("div");
      panel.className = "dtw-visible-memory dtw-owned";
      const text = `本轮带入的记忆\n${memoryText}`;
      if (panel.textContent !== text) panel.textContent = text;
      if (node.nextElementSibling !== panel) node.after(panel);
      visibleMemoryPanels.set(node, panel);
      return;
    }
    existingPanel?.remove(); visibleMemoryPanels.delete(node);
    if (shown === null || shown === original || !node.textContent.includes("<project_memory>")) return;

    // Change only the text in the native user bubble. Keep its React elements and message actions mounted.
    const userInput = DTWMemoryDisplay.visibleText(original, false, false);
    const ending = userInput?.slice(-Math.min(24, userInput.length)).replace(/\s+/g, " ");
    const containsInput = (item) => !ending || item.textContent.replace(/\s+/g, " ").includes(ending);
    let surface = node;
    while (true) {
      const child = [...surface.children].find((item) => !item.matches("button,[role=button],[contenteditable],.dtw-owned")
        && item.textContent.includes("<project_memory>") && item.textContent.includes("</project_memory>")
        && containsInput(item));
      if (!child) break;
      surface = child;
    }
    if (surface.closest("[contenteditable]")) return;
    const walker = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) {
      const textNode = walker.currentNode;
      if (!textNode.parentElement?.closest("button,[role=button],[contenteditable],.dtw-owned")) nodes.push(textNode);
    }
    const first = nodes.findIndex((part) => part.nodeValue.includes("<project_memory>"));
    if (first < 0) return;
    let last = nodes.findLastIndex((part) => ending && part.nodeValue.replace(/\s+/g, " ").includes(ending));
    if (last < first) last = nodes.length - 1;
    const parts = nodes.slice(first, last + 1).map((part, index) => ({ node: part, original: part.nodeValue,
      display: index === 0 ? shown : "" }));
    for (const part of parts) part.node.nodeValue = part.display;
    visibleUserMessages.set(node, { messageId: record.messageId, original, shown, parts });
  }
  function userMessageText(node) {
    const prior = visibleUserMessages.get(node);
    if (prior?.parts.every((part) => node.contains(part.node) && part.node.nodeValue === part.display)) return prior.original;
    const clone = node.cloneNode(true);
    clone.querySelectorAll("button,[role=button],.dtw-owned").forEach((item) => item.remove());
    return clone.textContent.trim();
  }
  function renderMessageInfo() {
    const sessionId = currentId();
    if (!state.snapshot) return false;
    const showMetadata = Boolean(membership(sessionId)?.projectId);
    const records = state.lastHistory?.conversationId === sessionId ? state.lastHistory.records : [];
    const byId = new Map(records.map((entry) => [entry.messageId, entry]));
    const branch = []; let id = state.lastHistory?.conversationId === sessionId ? state.lastHistory.currentMessageId : null; const seen = new Set();
    while (Number.isInteger(id) && byId.has(id) && !seen.has(id)) { seen.add(id); branch.push(byId.get(id)); id = byId.get(id).parentId; }
    branch.reverse();
    const nodes = messageNodes();
    const labels = new Set(); const memoryPanels = new Set();
    const normalize = (text) => String(text).replace(/\s+/g, "");
    let aligned = true;
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index]; const role = messageRole(node); let record = branch[index];
      const original = role === "USER" ? userMessageText(node) : "";
      const question = (text) => DTWMemoryDisplay.visibleText(text, false, false) ?? text;
      aligned &&= record?.role === role && (role !== "USER" || normalize(question(original)) === normalize(question(DTWHistory.fragmentText(record))));
      if (!aligned) record = null;
      // Visibility uses the bubble itself, even before a new message reaches the history cache.
      if (role === "USER" && !automationSession(sessionId)) renderUserMessage(node,
        DTWMemoryDisplay.visibleText(original, false, false) !== null
          ? { messageId: record?.messageId ?? `visible_${index}`, fragments: [{ type: "REQUEST", content: original }] }
          : record || { messageId: `visible_${index}`, fragments: [{ type: "REQUEST", content: original }] });
      const panel = visibleMemoryPanels.get(node);
      if (panel?.isConnected) memoryPanels.add(panel);
      if (!showMetadata || !record || (role === "ASSISTANT" && index === nodes.length - 1 && isGenerating())) continue;
      const anchor = panel?.isConnected ? panel : node;
      let label = anchor.nextElementSibling?.classList.contains("dtw-message-meta")
        ? anchor.nextElementSibling : node.querySelector(":scope > .dtw-message-meta");
      if (!label) { label = document.createElement("div"); label.className = "dtw-message-meta dtw-owned"; }
      if (anchor.nextElementSibling !== label) anchor.after(label);
      labels.add(label);
      const date = record.insertedAtMs ? new Date(record.insertedAtMs).toLocaleString("zh-CN") : "日期未知";
      const local = DTWHistory.localTokenUsage(branch, index);
      const token = Number.isFinite(record.accumulatedTokenUsage)
        ? ` · ${local === null ? "" : `本次 ${local} tokens · `}累计 ${record.accumulatedTokenUsage} tokens` : "";
      const text = `${date}${token}`;
      if (label.textContent !== text) label.textContent = text;
    }
    document.querySelectorAll(".dtw-message-meta").forEach((label) => { if (!labels.has(label)) label.remove(); });
    document.querySelectorAll(".dtw-visible-memory").forEach((panel) => { if (!memoryPanels.has(panel)) panel.remove(); });
    return records.length > 0 && nodes.length === branch.length && aligned;
  }
  function observeMessageDisplay() {
    const observer = new MutationObserver((mutations) => {
      if (!state.snapshot) return;
      const nodes = messageNodes();
      if (!mutations.some((mutation) => nodes.some((node) => node.contains(mutation.target)
        || [...mutation.addedNodes, ...mutation.removedNodes].some((added) => added.contains(node))))) return;
      // Reapply visibility before paint when React restores a message after editing.
      renderMemoryEditors();
      if (renderMessageInfo()) state.messageInfoPending = false;
    });
    observer.observe(document.body, { childList: true, characterData: true, subtree: true });
    return observer;
  }
  async function refresh() {
    if (!state.accountId) return;
    state.snapshot = await send("snapshot");
    state.networkIssue = state.snapshot.alerts?.issue || null;
    currentRequestIssue();
    if (!state.networkIssue) root.querySelector(".dtw-request-notice")?.remove();
    window.dispatchEvent(new CustomEvent("dtw:request-state", { detail: JSON.stringify({ paused: state.snapshot.settings.automationPaused,
      issue: state.networkIssue, allowCurrentTask: state.automationRunning || state.rolloverRunning || state.pendingSend }) }));
    for (const session of state.snapshot.sessions) state.importedIds.add(session.sessionId);
    renderTree(); renderMemoryButton(); renderMessageInfo(); renderMemoryEditors();
    if (!state.automationRunning && !state.rolloverRunning && !state.pendingSend && !isGenerating()
      && !state.networkIssue && !state.snapshot.settings.automationPaused
      && !state.snapshot.jobs.some((job) => ["QUEUED", "PENDING", "RUNNING"].includes(job.status) && ["CLASSIFY", "DISTILL", "COMPACT", "ROLLOVER"].includes(job.type))) {
      const helpers = state.snapshot.sessions.filter((session) => !session.deleted && session.automationOrigin === "PLUGIN"
        && ["CLASSIFY", "MEMORY", "AUTOMATION"].includes(session.purpose));
      const signature = helpers.map((session) => session.sessionId).sort().join(",");
      if (helpers.length > 10 && signature !== state.cleanupSignature) {
        state.cleanupSignature = signature;
        send("automation-prune", { automatic: true }).catch((error) => showToast(`自动化会话清理未完成：${error.message}`, 6500));
      }
    }
  }
  async function syncSessionTimes() {
    if (!state.accountId || !state.snapshot || state.syncingTimes) return;
    const known = new Map(state.snapshot.sessions.filter((session) => !session.deleted).map((session) => [session.sessionId, session]));
    const sessions = [...state.sessionTimes].filter(([id, item]) => known.has(id) && (item.updatedAtMs > (known.get(id).updatedAtMs || 0)
      || item.updatedAtMs === known.get(id).updatedAtMs && typeof item.pinned === "boolean" && item.pinned !== Boolean(known.get(id).pinned)))
      .map(([sessionId, item]) => ({ sessionId, ...item }));
    if (!sessions.length) return;
    state.syncingTimes = true;
    try {
      for (const item of sessions) {
        const previous = known.get(item.sessionId);
        if (previous.historyObserved && previous.purpose === "USER" && Number.isInteger(item.currentMessageId) && item.currentMessageId !== previous.currentMessageId)
          state.dirtySessions.add(item.sessionId);
      }
      const result = await send("session-times-observe", { sessions });
      if (result.changed) {
        await refresh();
      }
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
    let result;
    if (force && state.dirtySessions.has(id)) { state.dirtySessions.delete(id); result = await history(id, { allowEmpty: true }); }
    else result = (await send("session-history", { sessionId: id })).history || (state.lastHistory?.conversationId === id ? state.lastHistory : null);
    if (!result) return null;
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
    if (state.lastHistory?.conversationId !== route) { state.lastHistory = null; state.lastHistoryAt = 0; }
    state.messageInfoPending = Boolean(route);
    document.querySelectorAll(".dtw-message-meta").forEach((node) => node.remove());
    renderTree(); renderMemoryButton();
    if (route && state.accountId && !state.automationRunning && !state.rolloverRunning) currentHistory().catch(() => {});
  }
  async function syncChangedSessions() {
    if (!state.snapshot || state.syncingChanges || state.automationRunning || state.rolloverRunning
      || state.snapshot.settings.automationPaused || state.networkIssue
      || state.snapshot.jobs?.some((job) => ["CLASSIFY", "DISTILL", "COMPACT", "ROLLOVER"].includes(job.type) && ["PENDING", "RUNNING"].includes(job.status))) return;
    state.syncingChanges = true;
    try {
      for (const id of [...state.dirtySessions]) {
        if (id === currentId() && isGenerating()) continue;
        state.dirtySessions.delete(id);
        const session = state.snapshot.sessions.find((item) => item.sessionId === id && !item.deleted && item.purpose === "USER");
        if (!session) continue;
        try { await saveObservedHistory(id, await history(id, { allowEmpty: true, userAction: false })); }
        catch (error) {
          showToast(`会话同步未完成：${error.message}`, 6500);
          if (["AUTH_REQUIRED", "RATE_LIMITED", "ACCOUNT_RESTRICTED", "PAUSED"].includes(error.code)) break;
        }
      }
    } finally { state.syncingChanges = false; }
  }
  async function saveObservedHistory(id, captured) {
    if (currentId() === id) { state.lastHistory = captured; state.lastHistoryAt = Date.now(); renderMessageInfo(); }
    await send("history-observe", { sessionId: id, records: captured.records, currentMessageId: captured.currentMessageId,
      title: captured.title, updatedAtMs: captured.updatedAtMs });
  }
  async function observeNativeHistory(detail) {
    if (!state.accountId || detail.accountId !== state.accountId) { state.observedHistories.set(detail.sessionId, detail); return; }
    try {
      const captured = DTWHistory.parseHistoryResponse(detail.data, detail.sessionId, { allowEmpty: true });
      if (state.automationRunning && state.automationJobId && detail.sessionId === currentId())
        await send("automation-progress", { jobId: state.automationJobId, phase: "WAITING_REPLY", automationSessionId: detail.sessionId });
      if (!state.snapshot?.sessions.some((session) => session.sessionId === detail.sessionId))
        await send("session-observe", { sessionId: detail.sessionId, loadedHistory: true, title: captured.title });
      if (captured.records.at(-1)?.status === "FINISHED" && !isGenerating()) state.dirtySessions.delete(detail.sessionId);
      await saveObservedHistory(detail.sessionId, captured);
      await refresh();
    } catch (error) {
      if (error.code === "SESSION_NOT_FOUND") { await send("session-delete", { sessionIds: [detail.sessionId] }); await refresh(); }
      else showToast(error.message, 5000);
    }
  }
  async function reportRequestIssue(issue) {
    if (!issue?.code) return;
    const first = state.networkIssue?.code !== issue.code;
    state.networkIssue = issue;
    const accountId = state.accountId || (await chrome.storage.local.get("accountId")).accountId;
    if (accountId) await chrome.runtime.sendMessage({ type: "dtw:request-issue", accountId, ...issue });
    if (first) showToast(issue.message, 10000);
    let notice = root.querySelector(".dtw-request-notice");
    if (!notice) { notice = document.createElement("div"); notice.className = "dtw-request-notice dtw-owned"; notice.setAttribute("role", "alert"); root.append(notice); }
    notice.innerHTML = `<span>${esc(issue.message)}</span><button data-action="open-options">设置</button>`;
    if (state.accountId) await refresh();
  }
  window.addEventListener("dtw:request-issue", (event) => { reportRequestIssue(parse(event)).catch(() => {}); });
  window.addEventListener("dtw:history-observed", (event) => { const detail = parse(event); if (detail?.sessionId) observeNativeHistory(detail).catch(() => {}); });

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
      const submitted = Boolean(state.submittedAtMs && (state.submittedRoute === route
        || !state.submittedRoute && state.newSessionIds.has(route)));
      Object.assign(watch, { route, count: 0, text: "", since: Date.now(), generating: submitted, primed: submitted });
      if (submitted) state.dirtySessions.add(route);
    }
    if (!route) return;
    const nodes = messageNodes(); const last = nodes.at(-1); const text = last ? nodeText(last) : "";
    const running = isGenerating();
    if (running) { if (!watch.generating) state.dirtySessions.add(route); watch.generating = true; watch.count = nodes.length; watch.text = text; watch.since = Date.now(); watch.primed = true;
      if (state.submittedAtMs && text && last?.matches?.('div.ds-message,[data-message-author-role="assistant"]') && !state.firstOutputAtMs)
        state.firstOutputAtMs = Date.now(); return; }
    if (nodes.length !== watch.count || text !== watch.text) {
      if (watch.primed && (text.length > watch.text.length || nodes.length - watch.count === 2)) {
        watch.generating = true; state.dirtySessions.add(route);
      }
      watch.count = nodes.length; watch.text = text; watch.since = Date.now(); watch.primed = true; return;
    }
    if (!watch.generating && text && Date.now() - watch.since >= 2500 && membership(route)?.projectId
      && !state.historyRecovery.has(route) && !renderMessageInfo() && !state.snapshot.settings.automationPaused && !state.networkIssue) {
      state.historyRecovery.add(route);
      // Recover missing metadata once after native loading settles; send confirmation remains local.
      try { await saveObservedHistory(route, await history(route, { allowEmpty: true, userAction: false })); }
      catch (error) { showToast(`消息 token 同步失败：${error.message}`, 6500); }
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
  async function confirmUserMessage(jobId, prompt, before, timeout = 30000) {
    const start = Date.now();
    const normalized = (text) => String(text || "").replace(/\s+/g, " ").trim();
    const expected = normalized(prompt);
    const question = normalized(DTWMemoryDisplay.visibleText(prompt, false, false) ?? prompt);
    while (Date.now() - start < timeout) {
      requireSendAllowed();
      const id = currentId();
      if (id && (before.sessionId ? id === before.sessionId : !before.knownSessionIds.has(id))) {
        try {
          const captured = await currentHistory();
          if (currentId() !== id) continue;
          const user = [...(captured?.conversationId === id ? captured.records : [])].reverse().find((entry) => entry.role === "USER");
          const stored = user && (id !== before.sessionId || !before.userMessageIds.has(user.messageId))
            && user.fragments.some((fragment) => fragment.type === "REQUEST" && normalized(fragment.content).includes(expected));
          const nodes = messageNodes(); const users = nodes.filter((node) => messageRole(node) === "USER");
          const latest = users.at(-1);
          // A user bubble can be optimistic; require a new matching turn with actual assistant output.
          const onPage = users.length > before.userCount && question && normalized(latest?.textContent).includes(question)
            && nodes.slice(nodes.indexOf(latest) + 1).some((node) => {
              if (messageRole(node) !== "ASSISTANT") return false;
              const content = node.cloneNode(true);
              content.querySelectorAll('button, [role="button"], .dtw-owned, .dtw-message-meta').forEach((element) => element.remove());
              return normalized(content.textContent);
            });
          if (stored || onPage) {
            if (stored && currentId() === id) {
              state.lastHistory = captured; state.lastHistoryAt = Date.now();
              renderMessageInfo();
            }
            await send("send-status", { jobId, confirmed: true, sessionId: id,
              userMessageId: stored ? user.messageId : undefined, title: captured?.title, waitForReply: state.rolloverRunning });
            if (state.pendingNewProjectId) {
              state.pendingNewProjectId = "";
              state.pendingNewConversationAt = 0;
              await refresh();
            }
            return true;
          }
        } catch (error) { if (["AUTH_REQUIRED", "RATE_LIMITED", "ACCOUNT_RESTRICTED"].includes(error.code)) throw error; /* DSW may still be creating the session. */ }
      }
      await delay(1200);
    }
    await send("send-status", { jobId, error: "无法确认 DSW 已收到用户消息" });
    return false;
  }
  async function doProjectSend(editor, prompt, jobId) {
    const original = editorText(editor);
    try {
      requireSendAllowed();
      const initialHistory = await currentHistory();
      const before = { sessionId: currentId(), userCount: messageNodes().filter((node) => messageRole(node) === "USER").length,
        userMessageIds: new Set((initialHistory?.records || []).filter((entry) => entry.role === "USER").map((entry) => entry.messageId)),
        knownSessionIds: new Set([...(state.snapshot?.sessions || []).map((entry) => entry.sessionId), ...nativeLinks().map((link) => idFromHref(link.href))]) };
      setEditor(editor, prompt);
      state.submittedAtMs = Date.now();
      await submit(editor);
      const sentNode = [...messageNodes()].reverse().find((node) => messageRole(node) === "USER"
        && node.textContent.includes("<project_memory>")
        && node.textContent.includes("</project_memory>")
        && node.textContent.includes(prompt.slice(-Math.min(prompt.length, 80))));
      if (sentNode) renderUserMessage(sentNode, { messageId: `pending-${jobId}`,
        fragments: [{ type: "REQUEST", content: prompt }] });
      const okay = await confirmUserMessage(jobId, prompt, before);
      if (!okay) showToast("发送结果不明，原始草稿已保存在作业记录中，请核对会话", 6000);
      return okay;
    } catch (error) {
      setEditor(editor, original);
      await send("send-status", { jobId, error: error.message }).catch(() => {});
      showToast(`发送未确认：${error.message}`, 6000);
      return false;
    }
  }
  async function memorySend(editor) {
    if (state.pendingSend) return;
    state.pendingSend = true;
    const rawInput = editorText(editor).trim();
    try {
      requireSendAllowed();
      if (!currentId() && newChatMemoryEnabled() && !state.pendingNewProjectId) {
        state.pickerSessionId = NEW_CHAT; renderModal(); return;
      }
      if (!currentId() && state.pendingNewProjectId) markPendingNewConversation();
      const prepared = await send("prepare-send", { sessionId: currentId(), newChatProjectId: state.pendingNewProjectId, rawInput });
      if (prepared.chooseProject) { state.pickerSessionId = currentId(); renderModal(); return; }
      if (prepared.native) { await submit(editor); return; }
      if (prepared.rollover) {
        const started = await send("rollover-start", { jobId: prepared.jobId });
        showToast(started.queued ? "后继会话已排队；发送确认后会清空原草稿"
          : "已打开后继会话；确认 DSW 收到消息后会清空原草稿", 5000);
        return;
      }
      await doProjectSend(editor, prepared.prompt, prepared.jobId);
    } catch (error) { showToast(error.message, 5000); }
    finally { state.pendingSend = false; }
  }
  async function runAutomation(message) {
    state.automationRunning = true;
    state.automationJobId = message.jobId;
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
      const start = Date.now(); let stable = ""; let stableAt = 0;
      let lastHeartbeat = start; let reportedAutomationId = "";
      while (Date.now() - start < 360000) {
        const route = currentId();
        if (route && route !== reportedAutomationId) {
          await send("automation-progress", { jobId: message.jobId, phase: "WAITING_REPLY", automationSessionId: route });
          reportedAutomationId = route;
        }
        requireSendAllowed();
        const nodes = messageNodes();
        const text = nodes.length > initial && messageRole(nodes.at(-1)) === "ASSISTANT" ? nodeText(nodes.at(-1)) : "";
        if (text.length > 2 && !isGenerating()) {
          if (text === stable && Date.now() - stableAt > 3000) {
            let raw = text;
            if (route) {
              try {
                const saved = await currentHistory();
                const captured = saved?.records.some((entry) => entry.messageId === saved.currentMessageId && entry.role === "ASSISTANT" && entry.status === "FINISHED")
                  ? saved : await history(route, { allowEmpty: true });
                const answer = captured.records.find((entry) => entry.messageId === captured.currentMessageId);
                if (answer?.role === "ASSISTANT" && answer.status === "FINISHED")
                  raw = answer.fragments.filter((part) => part.type === "RESPONSE").map((part) => part.content).join("\n\n") || raw;
              } catch (error) { if (["AUTH_REQUIRED", "RATE_LIMITED", "ACCOUNT_RESTRICTED"].includes(error.code)) throw error; }
            }
            await send("automation-result", { jobId: message.jobId, raw, automationSessionId: route }); return;
          }
          if (text !== stable) { stable = text; stableAt = Date.now(); }
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
      if (isGenerating()) document.querySelector('button[aria-label*="停止"], button[aria-label*="Stop"], button[title*="停止"]')?.click();
      await send("automation-result", { jobId: message.jobId, error: error.message, automationSessionId: currentId() }).catch(() => {});
    } finally { state.automationRunning = false; state.automationJobId = null; }
  }
  async function runRollover(message) {
    state.rolloverRunning = true;
    try {
      const editor = await waitEditor();
      if (!await doProjectSend(editor, message.prompt, message.jobId)) return;
      const startedAt = Date.now(); let stable = ""; let stableAt = 0;
      while (Date.now() - startedAt < 360000) {
        requireSendAllowed();
        const last = messageNodes().at(-1); const text = last && messageRole(last) === "ASSISTANT" ? nodeText(last) : "";
        if (text && !isGenerating()) {
          if (text === stable && Date.now() - stableAt > 3000) {
            const saved = await currentHistory();
            const captured = saved?.records.some((entry) => entry.messageId === saved.currentMessageId && entry.role === "ASSISTANT" && entry.status === "FINISHED")
              ? saved : await history(currentId(), { allowEmpty: true });
            await saveObservedHistory(currentId(), captured);
            await send("send-status", { jobId: message.jobId, replyFinished: true }); await refresh(); return;
          }
          if (text !== stable) { stable = text; stableAt = Date.now(); }
        }
        await delay(800);
      }
      throw new Error("接续回复超时，请核对会话");
    } catch (error) { await send("send-status", { jobId: message.jobId, error: error.message }).catch(() => {}); }
    finally { state.rolloverRunning = false; }
  }
  async function waitEditor() { for (let i = 0; i < 100; i++) { requireSendAllowed(); const editor = findEditor(); if (editor) return editor; await delay(300); } throw new Error("找不到 DSW 输入框"); }

  function positionMenu(menu, anchor) {
    if (!anchor?.isConnected) return;
    const rect = anchor.getBoundingClientRect();
    const width = menu.offsetWidth; const height = menu.offsetHeight;
    const left = Math.max(8, Math.min(rect.left, innerWidth - width - 8));
    const top = rect.bottom + height + 14 <= innerHeight ? rect.bottom + 6 : Math.max(8, rect.top - height - 6);
    for (const [key, value] of [["--dtw-menu-left", `${left}px`], ["--dtw-menu-top", `${top}px`]])
      if (menu.style.getPropertyValue(key) !== value) menu.style.setProperty(key, value);
  }
  function closeMenu(focus = false) {
    const menu = state.menu;
    if (!menu) return;
    state.menu = null;
    root.querySelector(".dtw-menu")?.remove();
    if (menu?.kind === "picker") state.pickerSessionId = "";
    menu?.anchor.setAttribute("aria-expanded", "false");
    if (focus) menu?.anchor.focus({ preventScroll: true });
  }
  function menuItem(action, id, label, symbol, extra = "") {
    return `<button class="dtw-menu-item ${action === "session-delete" ? "dtw-menu-danger" : ""}" role="menuitem" data-action="${action}" data-id="${esc(id)}" ${extra}>${icon(symbol)}<span>${esc(label)}</span></button>`;
  }
  function openMenu(kind, id, anchor) {
    closeMenu();
    state.menu = { kind, id, anchor };
    anchor.setAttribute("aria-expanded", "true");
    const box = document.createElement("div");
    box.className = "dtw-menu dtw-owned"; box.setAttribute("role", "menu");
    let html;
    if (kind === "project") {
      const project = state.snapshot.projects.find((item) => item.projectId === id);
      html = `${project.archived ? "" : menuItem("project-new-chat", id, "新建会话", "compose")}${menuItem("rename-project", id, "重命名项目", "edit")}${menuItem("edit-goal", id, "编辑项目目标", "settings")}<div role="separator" class="dtw-menu-divider"></div>${menuItem("pin-project", id, project.pinned ? "取消置顶" : "置顶项目", "pin")}${menuItem("archive-project", id, project.archived ? "恢复项目" : "归档项目", "archive")}`;
    } else if (kind === "picker") {
      state.pickerSessionId = id;
      html = `<div class="dtw-menu-label">移到项目</div>${projects().map((project) => menuItem("move-to", project.projectId, project.name, "folder", membership(id)?.projectId === project.projectId ? 'aria-current="true"' : "")).join("") || '<div class="dtw-menu-label">暂无项目</div>'}<div role="separator" class="dtw-menu-divider"></div>${menuItem("create-and-move", "", "新建项目", "plus")}${membership(id)?.projectId ? menuItem("move-to", "", "从项目中移除", "remove") : ""}`;
    } else {
      const selected = state.snapshot.sessions.find((item) => item.sessionId === id);
      const native = nativeLinks().some((item) => idFromHref(item.href) === id);
      html = `${menuItem("open-session", id, "打开会话", "compose")}${native ?
        `${menuItem("session-rename", id, "重命名", "edit")}${menuItem("session-pin", id, selected?.pinned ? "取消置顶" : "置顶", "pin")}${menuItem("session-share", id, "分享", "share")}${menuItem("session-select", id, "多选", "select")}` : ""}<div role="separator" class="dtw-menu-divider"></div>${sessionMenuExtras(id)}${native ? `<div role="separator" class="dtw-menu-divider"></div>${menuItem("session-delete", id, "删除会话", "trash")}` : ""}`;
    }
    box.innerHTML = html; root.append(box); positionMenu(box, anchor);
    box.querySelector("button")?.focus({ preventScroll: true });
  }
  function sessionMenuExtras(id) {
    const selected = state.snapshot.sessions.find((item) => item.sessionId === id);
    const row = membership(id);
    if (selected?.purpose === "AUTOMATION") return menuItem("automation-unmark", id, "恢复为普通会话", "back");
    return `${menuItem("open-picker", id, "移到项目", "move")}${row?.projectId ? menuItem("remove-from-project", id, "从项目中移除", "remove") : ""}${selected?.purpose === "USER" && !row?.projectId && !row?.memoryModeEnabled ? menuItem("automation-mark", id, "收纳到自动化会话", "automation") : ""}`;
  }
  async function nativeSessionAction(id, action, title) {
    if (state.nativeActionRunning) return;
    const link = nativeLinks().find((item) => idFromHref(item.href) === id);
    const trigger = link?.querySelector('[role="button"], button');
    const source = link?.closest("[data-dtw-original-display]") || link?.parentElement;
    if (!trigger) throw new Error("请先打开该会话，加载后即可使用改名、置顶、分享、多选和删除");
    closeMenu();
    const labels = { rename: /^(重命名|rename)$/i, pin: /置顶|^(?:un)?pin$/i,
      share: /^(分享|share)$/i, select: /^(多选|select|multi.?select)$/i, delete: /^(删除|delete)$/i };
    state.nativeActionRunning = true;
    // Keep DSW's action handlers and dialogs; its dropdown is never shown to the user.
    document.documentElement.classList.add("dtw-native-action");
    let menu; let invoked = false;
    try {
      trigger.click();
      for (let attempt = 0; attempt < 100; attempt++) {
        menu = [...document.querySelectorAll('.ds-dropdown-menu, [role="menu"]')].find((node) => !node.closest(".dtw-owned")
          && node.getBoundingClientRect().height > 0 && /重命名|rename/i.test(node.textContent));
        const entry = menu && [...menu.querySelectorAll('.ds-dropdown-menu-option,[role="menuitem"],button')]
          .find((node) => labels[action]?.test(node.textContent.trim()));
        if (entry) {
          menu.classList.add("dtw-native-action-menu");
          const pinned = action === "pin" && !/取消|unpin/i.test(entry.textContent);
          entry.click(); invoked = true;
          if (action === "rename") {
            let editor;
            for (let wait = 0; wait < 100; wait++) {
              editor = [...source.querySelectorAll('input[type="text"],input:not([type])')].find((node) => !node.disabled);
              if (editor) break;
              await delay(20);
            }
            if (!editor) throw new Error("找不到 DeepSeek 的改名输入框，请刷新页面后重试");
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(editor, title);
            editor.dispatchEvent(new Event("input", { bubbles: true }));
            editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
            editor.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
          }
          if (action === "pin") {
            const clock = state.sessionTimes.get(id); if (clock) clock.pinned = pinned;
            await send("session-observe", { sessionId: id, pinned }); await refresh();
          }
          break;
        }
        await delay(20);
      }
      if (!invoked) throw new Error("未找到 DeepSeek 的会话操作，请刷新页面后重试");
    } finally {
      if (!invoked) trigger.click();
      document.documentElement.classList.remove("dtw-native-action");
      setTimeout(() => { if (menu?.getAttribute("role") !== "menu" || !menu?.isConnected) menu?.classList.remove("dtw-native-action-menu"); }, 250);
      state.nativeActionRunning = false;
    }
  }
  function renderModal() {
    let box = root.querySelector(".dtw-modal");
    if (!state.pickerSessionId) { box?.remove(); return; }
    if (!box) { box = document.createElement("div"); box.className = "dtw-modal"; root.append(box); }
    const choices = projects().map((item) => `<button data-action="move-to" data-id="${esc(item.projectId)}">${esc(item.name)}</button>`).join("");
    const selected = state.snapshot?.sessions.find((item) => item.sessionId === state.pickerSessionId);
    const canMarkAutomation = selected?.purpose === "USER" && !membership(selected.sessionId)?.projectId
      && !membership(selected.sessionId)?.memoryModeEnabled;
    const nativeMenu = state.pickerSessionId === NEW_CHAT ? ""
      : `<button data-action="show-session-menu" data-id="${esc(state.pickerSessionId)}">会话操作</button>`;
    box.innerHTML = `<div class="dtw-dialog"><header><strong>${selected?.purpose === "AUTOMATION" ? "自动化会话" : "选择项目"}</strong><button data-action="close-modal" aria-label="关闭">×</button></header>
      <div class="dtw-picker-list">${selected?.purpose === "AUTOMATION"
        ? `<button data-action="automation-unmark" data-id="${esc(selected.sessionId)}">恢复为普通会话（未归类）</button>${nativeMenu}`
        : `${choices || "请先新建项目"}${state.pickerSessionId === NEW_CHAT ? "" : `<button data-action="move-to" data-id="">移到未归类</button>`}<button data-action="create-and-move">＋ 新项目</button>${canMarkAutomation ? `<button data-action="automation-mark" data-id="${esc(selected.sessionId)}">收纳到自动化会话</button>` : ""}${nativeMenu}`}</div></div>`;
  }
  async function move(sessionId, projectId) {
    await send("membership-move", { sessionId, projectId }); await refresh(); showToast("会话归属已更新");
  }
  async function enableMemory(sessionId) {
    await send("memory-toggle", { sessionId, enabled: true });
    await refresh();
    try {
      await currentHistory();
      showToast("项目记忆已开启，仅首条消息带入；正在检查旧会话");
    } catch { showToast("项目记忆已开启，仅首条消息带入；历史同步后会继续整理"); }
  }
  async function handleAction(button) {
    const action = button.dataset.action; const id = button.dataset.id || "";
    try {
      if (action === "collapse") toggleGroup(id);
      if (action === "open-session") {
        closeMenu();
        state.pendingNewProjectId = "";
        const link = nativeLinks().find((item) => idFromHref(item.href) === id);
        if (link) link.click();
        else {
          const sample = nativeLinks()[0]?.href || location.href;
          const prefix = new URL(sample, location.href).pathname.match(/^(.*?)\/chat(?:\/|$)/)?.[1] ?? "/a";
          location.href = `${location.origin}${prefix}/chat/s/${encodeURIComponent(id)}`;
        }
      }
      if (action === "session-menu") {
        if (state.menu?.kind === "session" && state.menu.id === id) closeMenu(true);
        else openMenu("session", id, button);
      }
      if (action === "session-rename") {
        closeMenu();
        const title = prompt("会话名称", state.snapshot.sessions.find((item) => item.sessionId === id)?.title)?.trim();
        if (title) await nativeSessionAction(id, "rename", title);
      }
      if (["session-pin", "session-share", "session-delete"].includes(action))
        await nativeSessionAction(id, action.slice("session-".length));
      if (action === "session-select") { closeMenu(); state.selectedSessions = new Set([id]); renderTree(); }
      if (action === "select-session" && state.selectedSessions) {
        state.selectedSessions.has(id) ? state.selectedSessions.delete(id) : state.selectedSessions.add(id); renderTree();
      }
      if (action === "cancel-selection") { state.selectedSessions = null; renderTree(); }
      if (action === "delete-selected") {
        const ids = [...(state.selectedSessions || [])];
        if (!ids.length || !confirm(`删除选中的 ${ids.length} 个会话？此操作无法恢复。`)) return;
        requireSendAllowed();
        const requestId = crypto.randomUUID(); const pending = waitEvent("dtw:delete-result", requestId);
        window.dispatchEvent(new CustomEvent("dtw:request-state", { detail: JSON.stringify({ paused: Boolean(state.snapshot?.settings.automationPaused), issue: state.networkIssue, allowCurrentTask: true }) }));
        window.dispatchEvent(new CustomEvent("dtw:delete-request", { detail: JSON.stringify({ requestId, accountId: state.accountId, sessionIds: ids }) }));
        await pending; await send("session-delete", { sessionIds: ids });
        state.selectedSessions = null; await refresh();
        if (ids.includes(currentId())) [...document.querySelectorAll("span")].find((node) => node.textContent.trim() === "开启新对话")?.click();
      }
      if (action === "open-picker") openMenu("picker", id, state.menu?.anchor || button);
      if (action === "remove-from-project") { closeMenu(); await move(id, null); }
      if (action === "automation-mark" || action === "automation-unmark") {
        closeMenu();
        await send(action, { sessionId: id });
        state.pickerSessionId = ""; renderModal(); await refresh();
        showToast(action === "automation-mark" ? "已收纳到自动化会话" : "已恢复到未归类");
      }
      if (action === "show-session-menu") {
        state.pickerSessionId = ""; renderModal();
        const anchor = [...document.querySelectorAll('.dtw-session-menu')].find((node) => node.dataset.id === id);
        if (anchor) openMenu("session", id, anchor); else showToast("请先展开该会话所在项目");
      }
      if (action === "project-menu") {
        if (state.menu?.kind === "project" && state.menu.id === id) closeMenu(true);
        else openMenu("project", id, button);
      }
      if (action === "project-new-chat") {
        closeMenu();
        const entry = [...document.querySelectorAll("span")].find((node) => node.textContent.trim() === "开启新对话");
        if (!entry) throw new Error("找不到 DeepSeek 新对话入口，请刷新页面后重试");
        entry.click();
        state.pendingNewProjectId = id; state.newChatMemoryOff = false;
        toggleGroup("__projects__", false); toggleGroup(id, false);
        renderMemoryButton();
      }
      if (action === "close-modal") { state.pickerSessionId = ""; state.enableMemoryAfterMove = ""; renderModal(); }
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
          state.pickerSessionId = ""; state.enableMemoryAfterMove = ""; closeMenu(); renderModal();
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
        state.pickerSessionId = ""; state.enableMemoryAfterMove = ""; closeMenu(); renderModal();
        renderMemoryButton();
      }
      if (action === "rename-project" || action === "edit-goal") {
        closeMenu();
        const project = state.snapshot.projects.find((item) => item.projectId === id);
        const value = prompt(action === "rename-project" ? "项目名称" : "简短目标", action === "rename-project" ? project?.name : project?.goalShort)?.trim();
        if (value === undefined) return;
        await send("project-update", { projectId: id, [action === "rename-project" ? "name" : "goalShort"]: value });
        renderModal(); await refresh();
      }
      if (action === "archive-project") {
        closeMenu();
        const project = state.snapshot.projects.find((item) => item.projectId === id);
        await send("project-update", { projectId: id, archived: !project?.archived }); renderModal(); await refresh();
      }
      if (action === "pin-project") {
        closeMenu();
        const project = state.snapshot.projects.find((item) => item.projectId === id);
        await send("project-update", { projectId: id, pinned: !project?.pinned }); await refresh();
      }
      if (action === "accept-suggestion" || action === "reject-suggestion") { await send("suggestion-confirm", { jobId: id, accept: action === "accept-suggestion" }); await refresh(); }
      if (action === "open-options") await chrome.runtime.sendMessage({ type: "dtw:open-options" });
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
        if (row.memoryModeEnabled) { await send("memory-toggle", { sessionId, enabled: false }); await refresh(); showToast("已关闭项目记忆；个人与项目记忆均仅在会话首条消息带入"); }
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
    if (state.menu && !event.target.closest?.(".dtw-menu")) closeMenu();
    if (state.bypassSend || state.automationRunning || state.rolloverRunning) return;
    const editor = findEditor(); const native = editor && nativeSend(editor);
    if (!native || !native.contains(event.target)) return;
    if (!currentId() && editorText(editor).trim()) markPendingNewConversation();
    if (automationSession(currentId())) return;
    event.preventDefault(); event.stopImmediatePropagation(); memorySend(editor);
  }, true);
  document.addEventListener("keydown", (event) => {
    const menu = state.menu && root.querySelector(".dtw-menu");
    if (state.menu && event.key === "Escape") { event.preventDefault(); closeMenu(true); return; }
    if (menu?.contains(event.target) && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const items = [...menu.querySelectorAll("button")]; const index = items.indexOf(document.activeElement);
      items[event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
      return;
    }
    const memoryButton = event.target.closest?.(".dtw-memory-button");
    if (memoryButton && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault(); event.stopImmediatePropagation(); handleAction(memoryButton); return;
    }
    if (state.bypassSend || state.automationRunning || state.rolloverRunning || event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    const editor = findEditor();
    if (!editor || (event.target !== editor && !editor.contains(event.target))) return;
    if (!currentId() && editorText(editor).trim()) markPendingNewConversation();
    if (automationSession(currentId())) return;
    event.preventDefault(); event.stopImmediatePropagation(); memorySend(editor);
  }, true);
  document.addEventListener("scroll", (event) => {
    if (event.target.closest?.(".dtw-menu")) return;
    closeMenu();
  }, true);
  window.addEventListener("resize", () => { closeMenu(); });
  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    if (message?.type === "dtw:automation-delete") {
      if (message.accountId !== state.accountId || state.automationRunning || state.rolloverRunning) {
        reply({ ok: false, error: "页面账号不匹配或正在执行任务" }); return false;
      }
      (async () => {
        const requireCleanupAllowed = () => {
          requireSendAllowed();
          if (message.accountId !== state.accountId || state.automationRunning || state.rolloverRunning || state.snapshot?.settings.automationPaused)
            throw new Error("页面账号或队列状态已变化，已保留会话");
          const eligible = new Set(state.snapshot?.sessions.filter((session) => !session.deleted && session.automationOrigin === "PLUGIN"
            && ["CLASSIFY", "MEMORY", "AUTOMATION"].includes(session.purpose)).map((session) => session.sessionId));
          if (!Array.isArray(message.sessionIds) || message.sessionIds.some((id) => !eligible.has(id)))
            throw new Error("清理范围待确认，已保留会话");
        };
        requireCleanupAllowed();
        let slot = await send("history-request-slot", { userAction: false });
        while (slot.waitMs > 0 && !slot.blocked) { await delay(slot.waitMs); slot = await send("history-request-slot", { userAction: false }); }
        if (slot.blocked) throw new Error(slot.message);
        requireCleanupAllowed();
        const requestId = crypto.randomUUID();
        const pending = waitEvent("dtw:delete-result", requestId);
        window.dispatchEvent(new CustomEvent("dtw:request-state", { detail: JSON.stringify({ paused: Boolean(state.snapshot?.settings.automationPaused), issue: state.networkIssue, allowCurrentTask: false }) }));
        window.dispatchEvent(new CustomEvent("dtw:delete-request", { detail: JSON.stringify({ requestId,
          accountId: state.accountId, sessionIds: message.sessionIds }) }));
        await pending;
      })().then(() => reply({ ok: true })).catch((error) => reply({ ok: false, error: error.message }));
      return true;
    }
    if (message?.type === "dtw:memory-rescan" && message.accountId === state.accountId) {
      reply({ ok: true });
      if (!state.automationRunning && !state.rolloverRunning)
        send("memory-reconcile").then(refresh).catch((error) => showToast(`本地记忆队列更新失败：${error.message}`, 6500));
      return false;
    }
    if (message?.type === "dtw:automation") {
      const issue = currentRequestIssue();
      if (issue) { reply({ ok: false, code: issue.code, error: issue.message }); return false; }
      reply({ ok: Boolean(state.accountId), code: state.accountId ? undefined : "NOT_READY" });
      if (state.accountId && !state.automationRunning) runAutomation(message); return false;
    }
    if (message?.type === "dtw:rollover") {
      const issue = currentRequestIssue();
      if (issue) { reply({ ok: false, code: issue.code, error: issue.message }); return false; }
      reply({ ok: Boolean(state.accountId), code: state.accountId ? undefined : "NOT_READY" });
      if (state.accountId && !state.rolloverRunning && !state.automationRunning) runRollover(message); return false;
    }
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
        ...(typeof item.pinned === "boolean" ? { pinned: item.pinned } : {}),
      });
    }
    syncSessionTimes().catch(() => {});
  });

  async function getAccount() {
    const requestId = `account_${crypto.randomUUID()}`;
    const result = waitEvent("dtw:profile-result", requestId, 15000).catch(() => null);
    window.dispatchEvent(new CustomEvent("dtw:profile-request", { detail: JSON.stringify({ requestId }) }));
    return await result;
  }
  async function initializeAccount(accountId, observedAtMs) {
    if (state.initializing || !/^[\w-]{6,100}$/.test(accountId)) return;
    state.initializing = true;
    try {
      if (state.accountId && state.accountId !== accountId) {
        state.snapshot = null; state.sessionTimes.clear(); state.dirtySessions.clear(); state.importedIds.clear(); restoreNativeSessions();
      }
      state.accountId = accountId; state.startupFailed = false;
      currentRequestIssue();
      await restrictionReport;
      const collapseKey = `dtw.collapsed:${accountId}`;
      const saved = (await chrome.storage.local.get(collapseKey))[collapseKey];
      state.collapsed = new Set(Array.isArray(saved) ? saved.filter((id) => typeof id === "string") : []);
      await chrome.storage.local.set({ accountId });
      await send("request-ready", { observedAtMs });
      await refresh(); await syncVisibleSessions(); await syncSessionTimes();
      for (const detail of state.observedHistories.values()) if (detail.accountId === accountId) await observeNativeHistory(detail);
      state.observedHistories.clear();
      if (!state.networkIssue) root.querySelector(".dtw-request-notice")?.remove();
      syncRoute();
    } finally { state.initializing = false; }
  }
  window.addEventListener("dtw:account-ready", (event) => {
    const detail = parse(event);
    if (detail?.accountId && (state.startupFailed || state.networkIssue?.code === "AUTH_REQUIRED" || state.accountId && state.accountId !== detail.accountId))
      initializeAccount(detail.accountId, detail.observedAtMs).catch((error) => showToast(error.message));
  });

  async function start() {
    if (!document.body) { await new Promise((resolve) => new MutationObserver((_, observer) => { if (document.body) { observer.disconnect(); resolve(); } }).observe(document.documentElement, { childList: true })); }
    document.body.append(root);
    currentRequestIssue();
    new MutationObserver(showLoadingTree).observe(document.body, { childList: true, subtree: true });
    let uiSyncScheduled = false;
    const scheduleUiSync = () => {
      if (uiSyncScheduled) return;
      uiSyncScheduled = true;
      requestAnimationFrame(() => {
        uiSyncScheduled = false;
        currentRequestIssue();
        syncRoute();
        if (!state.snapshot) return;
        renderMemoryEditors();
        if (!document.querySelector(".dtw-memory-button")) renderMemoryButton();
        if (state.messageInfoPending && renderMessageInfo()) state.messageInfoPending = false;
      });
    };
    new MutationObserver(scheduleUiSync).observe(document.body, { childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ["disabled", "aria-disabled", "contenteditable", "placeholder", "hidden"] });
    observeMessageDisplay();
    window.addEventListener("popstate", scheduleUiSync);
    window.navigation?.addEventListener("currententrychange", scheduleUiSync);
    showLoadingTree();
    state.knownAtStart = new Set([...nativeLinks().map((item) => idFromHref(item.href)), currentId()].filter(Boolean));
    const account = await getAccount();
    if (account?.accountId) await initializeAccount(account.accountId, account.observedAtMs);
    else { state.startupFailed = true; restoreNativeSessions(); showToast("等待原生页面的登录信息，插件不会主动验证登录", 10000); }
    setInterval(async () => {
      currentRequestIssue();
      if (!chrome.runtime?.id || !state.accountId || state.syncingUi) return;
      state.syncingUi = true;
      try { if (!state.automationRunning && !state.rolloverRunning) await syncVisibleSessions();
        await titleSync(); await checkTurn(); await syncSessionTimes(); renderTree(); renderMemoryButton();
        await syncChangedSessions();
        if (state.snapshot && Date.now() - (state.lastRefresh || 0) > 3000) { state.lastRefresh = Date.now(); await refresh(); }
      } catch { /* Leave native chat usable during transient DSW changes. */ }
      finally { state.syncingUi = false; }
    }, 1500);
  }
  start().catch((error) => console.warn("[DeepSeek Pilot]", error));
})();
