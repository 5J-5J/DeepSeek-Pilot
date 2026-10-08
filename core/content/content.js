/**
 * DeepSeek 项目工作台
 * 在原生左侧栏上渲染「项目 → 会话」树，并扩展原生 ••• 菜单；
 * 聊天、输入、附件和模型选择均保留原版。
 */
(() => {
  "use strict";
  if (window.__dtwBootstrapped) return;
  window.__dtwBootstrapped = true;
  console.info("[DeepSeek 项目工作台] content.js 0.8.0 已加载（项目树模式）");

  const STORAGE_KEY = "dtw.sidebar.v1";
  const MEMORY_KEY = "dtw.memory.v1";
  const FS_KEY = "dtw.fs.v1";
  const EMPTY_STATE = { tasks: [], conversations: {}, selectedTaskId: "", lastSelectedTaskId: "" };
  const root = document.createElement("div");
  root.id = "dtw-root";

  function injectPageNetworkHook() {
    if (!globalThis.chrome?.runtime?.getURL || document.getElementById("dtw-request-body-core")) return;
    const mount = document.head || document.documentElement;
    if (!mount) return;
    const coreScript = document.createElement("script");
    coreScript.id = "dtw-request-body-core";
    coreScript.src = chrome.runtime.getURL("logic/request-body-core.js");
    coreScript.async = false;
    coreScript.addEventListener("load", () => {
      if (document.getElementById("dtw-page-network")) return;
      const networkScript = document.createElement("script");
      networkScript.id = "dtw-page-network";
      networkScript.src = chrome.runtime.getURL("page/page-network.js");
      networkScript.async = false;
      mount.appendChild(networkScript);
    }, { once: true });
    mount.appendChild(coreScript);
  }

  injectPageNetworkHook();

  let state = EMPTY_STATE;
  let memoryState = DTWMemory.emptyStore();
  let fsState = null;
  let nativeSidebar = null;
  let nativeList = null;          // 原生会话列表内容容器（只作为工具行定位点）
  let pendingMenuRow = null;      // 捕获阶段记录的最近点击会话行（••• 菜单归属）
  let pendingMenuRowAt = 0;
  let pickerId = "";              // 任务选择浮层针对的会话 id
  let pickerAnchor = { x: 16, y: 16 };
  let degradedMenu = false;
  let toastTimer = 0;
  let scanQueued = false;
  let lastScanAt = 0;
  let scanTicks = 0;
  let lastRenderKey = "";
  let memoryView = "";
  let maintenanceRequestRunning = false;
  let summarizeInTab = false;
  const turnWatch = { conversationId: "", count: -1, text: "", since: 0, sawGenerating: false, lastSent: "", primed: false };

  const esc = (value) => String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);

  // After the extension is reloaded, this script is orphaned and every
  // runtime message throws "Receiving end does not exist" — fail silently.
  const runtimeAlive = () => Boolean(globalThis.chrome?.runtime?.id);

  function parseNetworkDetail(event) {
    try {
      return typeof event.detail === "string" ? JSON.parse(event.detail) : event.detail;
    } catch {
      return null;
    }
  }

  function waitForNetworkEvent(successEvent, requestId, timeoutMs = 12000, timeoutMessage = "等待 DeepSeek 页面网络响应超时") {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error(timeoutMessage)), timeoutMs);
      function onSuccess(event) {
        const detail = parseNetworkDetail(event);
        if (detail?.requestId !== requestId) return;
        finish(null, detail);
      }
      function onError(event) {
        const detail = parseNetworkDetail(event);
        if (detail?.requestId && detail.requestId !== requestId) return;
        finish(new Error(detail?.error || "DeepSeek 请求体改写失败"));
      }
      function finish(error, detail) {
        clearTimeout(timeout);
        window.removeEventListener(successEvent, onSuccess);
        window.removeEventListener("dtw:network-error", onError);
        if (error) reject(error); else resolve(detail);
      }
      window.addEventListener(successEvent, onSuccess);
      window.addEventListener("dtw:network-error", onError);
    });
  }

  async function armRequestBody(operation, jobId, prompt) {
    const nonce = crypto.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const requestId = `${String(jobId || "job").replace(/[^a-zA-Z0-9_-]/g, "")}_${nonce}`;
    const marker = `[DTW:${requestId}]`;
    const command = {
      requestId,
      operation,
      marker,
      prompt: String(prompt || ""),
      expiresAt: Date.now() + 30000,
    };
    const armed = waitForNetworkEvent("dtw:network-armed", requestId, 5000, "DeepSeek 请求体改写器没有响应");
    window.dispatchEvent(new CustomEvent("dtw:network-arm", { detail: JSON.stringify(command) }));
    await armed;
    return command;
  }

  function cancelRequestBody(requestId) {
    window.dispatchEvent(new CustomEvent("dtw:network-cancel", {
      detail: JSON.stringify({ requestId }),
    }));
  }

  async function requestConversationHistory(sessionId) {
    if (!globalThis.DTWHistory?.parseHistoryResponse) throw new Error("历史消息解析器未加载");
    let lastError = null;
    // DeepSeek sometimes answers 200 with an app-level error envelope (no
    // biz_data); a short retry clears most transient cases.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const nonce = crypto.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const requestId = `history_${nonce}`;
      const result = waitForNetworkEvent("dtw:history-result", requestId, 15000, "DeepSeek 历史消息接口响应超时");
      window.dispatchEvent(new CustomEvent("dtw:history-request", {
        detail: JSON.stringify({ requestId, sessionId }),
      }));
      try {
        const detail = await result;
        return DTWHistory.parseHistoryResponse(detail.data, sessionId);
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 900));
      }
    }
    throw lastError;
  }

  const idFromHref = (href) => {
    try {
      return new URL(href, location.href).pathname.match(/\/chat\/s\/([^/?#]+)/)?.[1] || "";
    } catch {
      return "";
    }
  };

  // Push the current task's memory block to the MAIN-world network hook.
  // Bound conversation → its task; unbound or brand-new chat → selected task.
  // Dispatched on every scan tick (cheap): the MAIN world may not have been
  // loaded yet when the first push happened.
  function pushMemoryContext() {
    let block = "";
    try {
      if (memoryState.settings.autoInject) {
        const conversationId = idFromHref(location.href);
        const taskId = (conversationId ? assignedTaskId(conversationId) : "")
          || state.selectedTaskId || state.lastSelectedTaskId;
        const task = state.tasks.find((item) => item.id === taskId);
        if (task) block = DTWMemory.buildTaskMemoryContext(task, memoryState);
      }
    } catch {
      block = "";
    }
    window.dispatchEvent(new CustomEvent("dtw:memory-context", { detail: JSON.stringify({ block }) }));
  }

  // Detect a finished assistant reply: message count/text stable for 3s with no
  // generation in flight, having seen generation happen. DeepSeek's stop button
  // is icon-only (no accessible label), so the primary generation signal is
  // streaming text growth between ticks; an exact +2 message jump (user message
  // + reply landed between ticks) counts too — a lazy-loaded history batch
  // (10+ messages) must not. The first observation after entering a
  // conversation is a pure baseline (priming) so navigation/refresh history
  // loading can never look like a completed turn. Fire-and-forget to the
  // service worker, which dedups by fingerprint (refresh-safe). Skipped in the
  // maintenance tab, whose own replies must never count as user turns.
  function checkTurnCompleted() {
    if (summarizeInTab || !runtimeAlive()) return;
    const conversationId = idFromHref(location.href);
    if (conversationId !== turnWatch.conversationId) {
      turnWatch.conversationId = conversationId;
      turnWatch.count = -1;
      turnWatch.text = "";
      turnWatch.since = Date.now();
      turnWatch.primed = false;
      // Keep the flag when this is the same generation whose id just
      // materialized in the URL; drop it on a real navigation.
      if (!isNativeGenerating()) turnWatch.sawGenerating = false;
    }
    if (!conversationId) return;
    const messages = collectMessageCandidates();
    const count = messages.length;
    const currentText = count ? elementToText(messages[count - 1]) : "";
    if (isNativeGenerating()) {
      turnWatch.count = count;
      turnWatch.text = currentText;
      turnWatch.since = Date.now();
      turnWatch.sawGenerating = true;
      turnWatch.primed = true;
      return;
    }
    if (count !== turnWatch.count || currentText !== turnWatch.text) {
      if (!turnWatch.primed) {
        turnWatch.count = count;
        turnWatch.text = currentText;
        turnWatch.since = Date.now();
        turnWatch.primed = true;
        return;
      }
      // ponytail: 增长即生成——纯文本流式信号，靠 1.5s 采样；一轮回复若在
      // 单个 tick 间隙内从零完整落地且未被采样到中间态，本轮会漏计（下一轮
      // 起正常）。需要零漏计时改用 MutationObserver 微观采样。
      if (currentText.length > turnWatch.text.length || count - turnWatch.count === 2) {
        turnWatch.sawGenerating = true;
      }
      turnWatch.count = count;
      turnWatch.text = currentText;
      turnWatch.since = Date.now();
      return;
    }
    if (!turnWatch.sawGenerating || !currentText || Date.now() - turnWatch.since < 3000) return;
    const fingerprint = `${count}:${simpleHash(currentText)}:${currentText.slice(0, 60)}`.slice(0, 120);
    if (fingerprint === turnWatch.lastSent) return;
    turnWatch.lastSent = fingerprint;
    turnWatch.sawGenerating = false;
    try {
      chrome.runtime.sendMessage({ type: "dtw:turn-completed", conversationId, fingerprint }).catch(() => {});
    } catch { /* Orphaned after an extension reload; ignore. */ }
  }

  function cleanState(value) {
    if (!value || !Array.isArray(value.tasks) || typeof value.conversations !== "object") return structuredClone(EMPTY_STATE);
    const conversations = {};
    for (const [id, item] of Object.entries(value.conversations)) {
      if (id && item?.title && idFromHref(item.href) === id) conversations[id] = { id, title: String(item.title), href: String(item.href) };
    }
    const tasks = [...value.tasks
      .filter((task) => task?.id && task?.name && Array.isArray(task.conversationIds))
      // 同 id 重复时后者胜（storage 污染防御），Map 保序：首个位置 + 最新值
      .reduce((map, task) => map.set(String(task.id), task), new Map()).values()]
      .map((task) => ({
        id: String(task.id),
        name: String(task.name).slice(0, 80),
        collapsed: Boolean(task.collapsed),
        conversationIds: [...new Set(task.conversationIds.filter((id) => conversations[id]))],
        sourceEpoch: Math.max(1, Number(task.sourceEpoch) || 1),
        createdAt: String(task.createdAt || ""),
      }));
    const selectedTaskId = tasks.some((task) => task.id === value.selectedTaskId)
      ? String(value.selectedTaskId) : "";
    const lastSelectedTaskId = tasks.some((task) => task.id === value.lastSelectedTaskId)
      ? String(value.lastSelectedTaskId) : "";
    return { tasks, conversations, selectedTaskId, lastSelectedTaskId };
  }

  async function loadState() {
    try {
      if (globalThis.chrome?.storage?.local) {
        const stored = await chrome.storage.local.get(STORAGE_KEY);
        return cleanState(stored[STORAGE_KEY]);
      }
      return cleanState(JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"));
    } catch {
      return structuredClone(EMPTY_STATE);
    }
  }

  async function saveState() {
    try {
      if (globalThis.chrome?.storage?.local) await chrome.storage.local.set({ [STORAGE_KEY]: state });
      else localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (error) {
      showToast("保存失败，请重试");
      console.warn("[DeepSeek 项目工作台] 保存失败：", error);
    }
  }

  async function loadMemoryState() {
    try {
      if (globalThis.chrome?.storage?.local) {
        const stored = await chrome.storage.local.get(MEMORY_KEY);
        return DTWMemory.normalizeStore(stored[MEMORY_KEY]);
      }
      return DTWMemory.normalizeStore(JSON.parse(localStorage.getItem(MEMORY_KEY) || "null"));
    } catch {
      return DTWMemory.emptyStore();
    }
  }

  async function saveMemoryState() {
    memoryState = DTWMemory.normalizeStore(memoryState);
    try {
      // 记忆写入收敛到后台（文件夹为真相源，storage 只是副本）。无 runtime
      // 环境时退回 localStorage。
      if (globalThis.chrome?.runtime?.sendMessage) {
        const result = await chrome.runtime.sendMessage({ type: "dtw:write-memory", store: memoryState });
        if (result && result.ok === false) throw new Error(result.error || "后台写入失败");
        return;
      }
      localStorage.setItem(MEMORY_KEY, JSON.stringify(memoryState));
    } catch (error) {
      showToast("记忆保存失败，请重试", 3200);
      console.warn("[DeepSeek 项目工作台] 记忆保存失败：", error);
    }
  }

  function findNativeSidebar() {
    const anchor = document.querySelector('a[href*="/chat/s/"]')
      || [...document.querySelectorAll("span")].find((element) => element.textContent.trim() === "开启新对话")
      || document.querySelector('svg[viewBox="0 0 143 23"]');
    if (!anchor || root.contains(anchor)) return null;

    let element = anchor;
    let best = null;
    while (element && element !== document.body) {
      const rect = element.getBoundingClientRect();
      if (rect.left <= 2 && rect.width >= 200 && rect.width <= 420 && rect.height >= innerHeight * 0.7) best = element;
      element = element.parentElement;
    }
    return best;
  }

  function collectConversations() {
    const found = [];
    const seen = new Set();
    for (const link of document.querySelectorAll('a[href*="/chat/s/"]')) {
      if (root.contains(link)) continue;
      const id = idFromHref(link.href);
      const title = link.textContent.trim().replace(/\s+/g, " ");
      if (!id || !title || seen.has(id)) continue;
      seen.add(id);
      found.push({ id, title, href: link.href });
    }
    return found;
  }

  function assignedTaskId(conversationId) {
    return state.tasks.find((task) => task.conversationIds.includes(conversationId))?.id || "";
  }

  // —— 原生侧栏增强 ——
  // 选择器依据 recon-dom.md（2026-09-21）：会话行 a[href*="/chat/s/"]，行内唯一
  // [role=button] 即 •••；列表内容容器 = .ds-scroll-area 的直接子 div（非虚拟化，
  // 100 行常驻）；••• 菜单 = .ds-dropdown-menu，条目 .ds-dropdown-menu-option
  // （--error 为删除项）；合成 Escape/空白点击关不掉菜单，需再点一次触发器。
  // 不移动、不重建 React 管理的会话节点；只隐藏其视觉输出，在同一
  // 滚动容器中渲染项目树，并复用原生链接与菜单事件。
  const nextFrames = (count = 3) => new Promise((resolve) => {
    const step = (left) => (left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1)));
    step(count);
  });

  function findNativeListContainer() {
    const row = document.querySelector('a[href*="/chat/s/"]');
    if (!row || root.contains(row)) return null;
    const scroller = row.closest(".ds-scroll-area");
    if (!scroller) return null;
    let element = row;
    while (element.parentElement && element.parentElement !== scroller) element = element.parentElement;
    return element.parentElement === scroller ? element : null;
  }

  function findNativeMoreButton(row) {
    return row?.querySelector('[role="button"], button') || null;
  }

  function findNativeMenu() {
    // 会话菜单特征：含 重命名/删除/分享 等条目（排除头像等其他下拉）
    return [...document.querySelectorAll(".ds-dropdown-menu")]
      .find((menu) => !menu.closest("#dtw-root") && menu.getBoundingClientRect().height > 0
        && /重命名|删除|分享/.test(menu.textContent || "")) || null;
  }

  function resolveMenuConversationId() {
    // 只信「点击时绑定」：捕获阶段记录的行 + 时间戳。菜单是浮层，退出动画时
    // rect 会移回原点，按位置反猜曾匹配到无关会话（把别的会话移进任务）。
    if (pendingMenuRow?.isConnected && Date.now() - pendingMenuRowAt < 4000) {
      return idFromHref(pendingMenuRow.href);
    }
    return "";
  }

  function makeNativeMenuItem(proto, label, dataset) {
    const item = proto.cloneNode(true);
    item.classList.remove("ds-dropdown-menu-option--error");
    item.classList.add("dtw-owned", "dtw-menu-item");
    const labelEl = item.querySelector(".ds-dropdown-menu-option__label");
    if (labelEl) labelEl.textContent = label;
    else item.textContent = label;
    for (const [key, value] of Object.entries(dataset)) item.dataset[key] = value;
    return item;
  }

  function reconcileNativeMenu() {
    if (degradedMenu) return;
    const menu = findNativeMenu();
    if (!menu || menu.querySelector(".dtw-owned")) return;
    const conversationId = resolveMenuConversationId();
    if (!conversationId || !state.conversations[conversationId]) return;
    const proto = [...menu.querySelectorAll(".ds-dropdown-menu-option")]
      .find((option) => !option.classList.contains("ds-dropdown-menu-option--error")
        && !option.classList.contains("dtw-owned"));
    if (!proto) { degradedMenu = true; return; }
    const taskId = assignedTaskId(conversationId);
    const items = [makeNativeMenuItem(proto, "移动到项目…", { action: "open-picker", id: conversationId })];
    if (taskId) {
      items.push(makeNativeMenuItem(proto, "移出项目", { action: "remove", id: conversationId }));
      items.push(makeNativeMenuItem(proto, "项目详情", { action: "select-task", taskId }));
    }
    menu.append(...items);
  }

  async function closeNativeMenu() {
    const menu = findNativeMenu();
    if (!menu) return;
    findNativeMoreButton(pendingMenuRow)?.click(); // ••• 是开关，再点一次即关闭
    await nextFrames();
    if (!findNativeMenu()) return;
    const outside = document.querySelector('a[href*="/chat/s/"]') || document.body;
    outside.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    outside.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    await nextFrames();
    const remaining = findNativeMenu();
    if (remaining) (remaining.closest(".ds-floating-container") || remaining).remove();
  }

  function openNativeConversationMenu(conversationId) {
    const nativeLink = [...document.querySelectorAll('a[href*="/chat/s/"]')]
      .find((link) => !root.contains(link) && idFromHref(link.href) === conversationId);
    const more = findNativeMoreButton(nativeLink);
    if (!nativeLink || !more) {
      const fallback = document.querySelector(`.dtw-conversation-row[data-id="${CSS.escape(conversationId)}"]`);
      return openTaskPicker(conversationId, fallback?.getBoundingClientRect() || { x: 16, y: 16 });
    }
    pendingMenuRow = nativeLink;
    pendingMenuRowAt = Date.now();
    more.click();
    // DeepSeek 在路由切换后偶尔保留了菜单状态，对已隐藏行的第二次
    // programmatic click 不再渲染浮层。优先等原生菜单，确实没出现才降级
    // 为项目选择器，至少保证分类操作不会失效。
    setTimeout(() => {
      if (pendingMenuRow !== nativeLink || pickerId || findNativeMenu()) return;
      const fallback = document.querySelector(`.dtw-conversation-row[data-id="${CSS.escape(conversationId)}"]`);
      openTaskPicker(conversationId, fallback?.getBoundingClientRect() || { x: 16, y: 16 });
    }, 700);
  }

  function unassignedConversations() {
    const maintenanceIds = new Set(memoryState.maintenanceConversationIds);
    return Object.values(state.conversations)
      .filter((conversation) => !assignedTaskId(conversation.id) && !maintenanceIds.has(conversation.id));
  }

  function makeProjectNode(key, label, taskId = "") {
    const isProject = Boolean(taskId);
    const section = document.createElement("section");
    section.className = "dtw-owned dtw-project-group";
    section.dataset.key = key;
    section.dataset.label = label;
    section.innerHTML = `
      <div class="dtw-project-head">
        ${isProject
          ? `<button class="dtw-project-caret" type="button" data-action="toggle-task" data-task-id="${esc(taskId)}" aria-label="展开或收起项目">⌄</button>`
          : '<span class="dtw-project-caret is-static">⌄</span>'}
        ${isProject
          ? `<button class="dtw-project-main" type="button" data-action="select-task" data-task-id="${esc(taskId)}" title="打开项目详情"><strong>${esc(label)}</strong><small></small></button>`
          : `<span class="dtw-project-main is-static"><strong>${esc(label)}</strong><small></small></span>`}
      </div>
      <div class="dtw-project-conversations"></div>`;
    return section;
  }

  function conversationRowTemplate(conversation, active) {
    return `<div class="dtw-conversation-row${active ? " is-active" : ""}" data-id="${esc(conversation.id)}">
      <button class="dtw-conversation-main" type="button" data-action="open" data-id="${esc(conversation.id)}" title="${esc(conversation.title)}"><span>${esc(conversation.title)}</span></button>
      <button class="dtw-conversation-more" type="button" data-action="native-menu" data-id="${esc(conversation.id)}" aria-label="会话操作">•••</button>
    </div>`;
  }

  function reconcileNativeSidebar() {
    const sidebar = findNativeSidebar();
    if (!sidebar) return;
    const list = findNativeListContainer();
    if (!list || !list.querySelector('a[href*="/chat/s/"]')) return;
    nativeList = list;
    const activeId = idFromHref(location.href);
    const groups = [
      ...state.tasks.map((task) => ({
        key: `p:${task.id}`,
        label: task.name,
        taskId: task.id,
        collapsed: Boolean(task.collapsed),
        items: task.conversationIds.map((id) => state.conversations[id]).filter(Boolean),
      })),
      { key: "unassigned", label: "未分类会话", taskId: "", collapsed: false, items: unassignedConversations() },
    ];
    const wanted = new Set(groups.map((group) => group.key));
    groups.forEach((group) => {
      let node = list.querySelector(`:scope > .dtw-project-group[data-key="${CSS.escape(group.key)}"]`);
      if (node && node.dataset.label !== group.label) { node.remove(); node = null; }
      if (!node) {
        node = makeProjectNode(group.key, group.label, group.taskId);
        list.append(node);
      }
      const box = node.querySelector(".dtw-project-conversations");
      const stamp = JSON.stringify([group.items.map((item) => [item.id, item.title]), activeId]);
      if (box.dataset.stamp !== stamp) {
        box.dataset.stamp = stamp;
        box.innerHTML = group.items.map((item) => conversationRowTemplate(item, item.id === activeId)).join("");
      }
      const count = String(group.items.length);
      const countNode = node.querySelector(".dtw-project-main small");
      if (countNode.textContent !== count) countNode.textContent = count;
      node.classList.toggle("is-collapsed", group.collapsed);
      node.classList.toggle("is-selected", group.taskId === state.selectedTaskId);
      const shouldHide = group.key === "unassigned" && group.items.length === 0;
      if (node.hidden !== shouldHide) node.hidden = shouldHide;
    });
    list.querySelectorAll(":scope > .dtw-project-group").forEach((node) => {
      if (!wanted.has(node.dataset.key)) node.remove();
    });
    // React 原节点留在原位，只隐藏视觉输出；项目树使用插件自己的轻量行。
    for (const child of list.children) {
      if (child.classList.contains("dtw-owned")) continue;
      if (child.style.display !== "none") child.style.display = "none";
      if (child.dataset.dtwHide !== "1") child.dataset.dtwHide = "1";
    }
  }

  function toolbarTemplate() {
    const facts = memoryState.userFacts.filter((fact) => fact.status !== "disabled").length;
    return `
      ${fsState?.status === "degraded" ? '<div class="dtw-fs-banner">记忆文件夹不可用，更改暂存于浏览器副本；点扩展图标重新授权。</div>' : ""}
      <div class="dtw-side-tools">
        <button class="is-primary" type="button" data-action="new-task">＋ 项目</button>
        <button class="${memoryState.settings.autoClassify ? "is-on" : ""}" type="button" data-action="toggle-auto-classify" title="让 DeepSeek 自动判断新会话所属项目">${memoryState.settings.autoClassify ? "✓ " : ""}AI 归类</button>
        <button type="button" data-action="facts-memory">记忆${facts ? ` ${facts}` : ""}</button>
        <button class="is-icon" type="button" data-action="settings-memory" title="插件设置" aria-label="插件设置">⚙</button>
      </div>`;
  }

  function reconcileToolbar() {
    if (!nativeSidebar || !nativeSidebar.isConnected) return;
    const stamp = JSON.stringify([
      state.tasks.length,
      state.selectedTaskId,
      state.lastSelectedTaskId,
      location.pathname,
      memoryState.settings.autoClassify,
      memoryState.userFacts.filter((fact) => fact.status !== "disabled").length,
      fsState?.status,
    ]);
    let toolbar = nativeSidebar.querySelector(":scope .dtw-tools-root");
    if (!toolbar) {
      toolbar = document.createElement("div");
      toolbar.className = "dtw-owned dtw-tools-root";
    }
    // 放在原生滚动列表顶部：作为唯一的插件块随历史一起滚动，不挤压聊天区，
    // 也不会落到账号栏之后。只插入自己的节点，不移动任何原生节点。
    if (nativeList?.isConnected && toolbar.parentElement !== nativeList) {
      nativeList.prepend(toolbar);
    } else if (!toolbar.isConnected) {
      nativeSidebar.append(toolbar);
    }
    if (toolbar.dataset.stamp !== stamp) {
      toolbar.dataset.stamp = stamp;
      toolbar.innerHTML = toolbarTemplate();
    }
  }

  function openTaskPicker(conversationId, anchor) {
    pickerId = conversationId;
    pickerAnchor = anchor;
    render(true);
  }

  function closeTaskPicker() {
    if (!pickerId) return;
    pickerId = "";
    render(true);
  }

  function pickerTemplate() {
    if (!pickerId) return "";
    const currentTaskId = assignedTaskId(pickerId);
    const taskButtons = state.tasks.map((task) => `
      <button type="button" data-action="move" data-id="${esc(pickerId)}" data-task-id="${esc(task.id)}"${task.id === currentTaskId ? " disabled" : ""}>
        ${task.id === currentTaskId ? "✓ " : ""}${esc(task.name)}
      </button>`).join("");
    const left = Math.min(Math.max(8, pickerAnchor.x), innerWidth - 250);
    const top = Math.min(Math.max(8, pickerAnchor.y), innerHeight - 260);
    return `
      <div class="dtw-picker-backdrop" data-action="close-picker"></div>
      <div class="dtw-picker" style="left:${Math.round(left)}px;top:${Math.round(top)}px">
        <small>移动到项目</small>
        ${taskButtons || `<button type="button" data-action="new-task" data-id="${esc(pickerId)}">＋ 先新建项目</button>`}
        ${currentTaskId ? `<button class="dtw-remove" type="button" data-action="remove" data-id="${esc(pickerId)}">移出项目</button>` : ""}
      </div>`;
  }

  function latestJobForTask(taskId) {
    return Object.values(memoryState.jobs)
      .filter((job) => job.taskId === taskId)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] || null;
  }

  function memoryStatusForTask(taskId) {
    const memory = DTWMemory.normalizeTaskMemory(memoryState.taskMemories[taskId]);
    const job = latestJobForTask(taskId);
    if (job && ["queued", "running"].includes(job.status)) return { label: "整理中", className: "is-running" };
    if (job?.status === "failed" || memory.status === "error") return { label: "需重试", className: "is-error" };
    if (memory.version) return { label: `记忆 v${memory.version}`, className: "is-ready" };
    return { label: "未整理", className: "" };
  }

  function itemStateLabel(item) {
    const labels = {
      active: "有效", todo: "待办", doing: "进行中", done: "已完成",
      proposed_done: "待确认完成", retired: "已退役",
    };
    return labels[item.state] || item.state;
  }

  function inspectorItemTemplate(task, item) {
    const canAdvance = ["goal", "milestone", "blocker"].includes(item.kind);
    const advanceLabel = item.state === "done" ? "重开" : item.state === "doing" ? "完成" : item.kind === "blocker" ? "已解决" : "推进";
    return `
      <article class="dtw-inspector-item ${item.state === "retired" ? "is-retired" : ""}">
        <div class="dtw-inspector-item-top">
          <em>${esc(itemStateLabel(item))}</em>${item.pinned ? '<b title="人工固定">固定</b>' : ""}
        </div>
        <p>${esc(item.text)}</p>
        <div class="dtw-inspector-item-actions">
          ${canAdvance && item.state !== "retired" ? `<button type="button" data-action="advance-task-item" data-task-id="${esc(task.id)}" data-item-id="${esc(item.id)}">${advanceLabel}</button>` : ""}
          <button type="button" data-action="edit-task-item" data-task-id="${esc(task.id)}" data-item-id="${esc(item.id)}">编辑</button>
          <button type="button" data-action="pin-task-item" data-task-id="${esc(task.id)}" data-item-id="${esc(item.id)}">${item.pinned ? "取消固定" : "固定"}</button>
          ${item.state !== "retired" ? `<button type="button" data-action="retire-task-item" data-task-id="${esc(task.id)}" data-item-id="${esc(item.id)}">退役</button>` : ""}
        </div>
      </article>`;
  }

  function taskInspectorTemplate() {
    const task = state.tasks.find((item) => item.id === state.selectedTaskId);
    if (!task) return "";
    const memory = DTWMemory.normalizeTaskMemory(memoryState.taskMemories[task.id]);
    const job = latestJobForTask(task.id);
    const status = memoryStatusForTask(task.id);
    const activeItems = memory.items.filter((item) => item.state !== "retired");
    const retiredItems = memory.items.filter((item) => item.state === "retired");
    const milestones = activeItems.filter((item) => item.kind === "milestone");
    const completedMilestones = milestones.filter((item) => item.state === "done").length;
    const conversations = task.conversationIds.map((id) => state.conversations[id]).filter(Boolean);
    const latestConversation = conversations[0];
    const activeJob = job && ["queued", "running"].includes(job.status);
    const jobNotice = job && ["queued", "running", "failed"].includes(job.status) ? `
      <div class="dtw-inspector-job ${job.status === "failed" ? "is-error" : ""}">
        <div><strong>${job.status === "failed" ? "整理失败" : "正在更新项目记忆"}</strong><span>${esc(job.status === "failed" ? job.error : (job.status === "queued" ? "等待前一个整理作业完成" : job.phase === "capture" ? "正在读取项目会话" : "正在等待 DeepSeek 返回"))}</span></div>
        ${job.status === "failed" ? `<button type="button" data-action="retry-memory" data-job-id="${esc(job.id)}">重试</button>` : '<i></i>'}
      </div>` : "";
    const grouped = ["goal", "constraint", "decision", "milestone", "blocker"]
      .map((kind) => {
        const items = activeItems.filter((item) => item.kind === kind);
        if (!items.length) return "";
        const labels = { goal: "目标", constraint: "约束", decision: "决定", milestone: "里程碑", blocker: "阻塞" };
        return `<section class="dtw-inspector-group"><h4>${labels[kind]} <small>${items.length}</small></h4>${items.map((item) => inspectorItemTemplate(task, item)).join("")}</section>`;
      }).join("");
    return `
      <aside class="dtw-inspector" aria-label="${esc(task.name)}项目详情">
        <header class="dtw-inspector-header">
          <div><h2>${esc(task.name)}</h2><small>${conversations.length} 个会话${milestones.length ? ` · ${completedMilestones}/${milestones.length} 里程碑` : ""}</small></div>
          <button type="button" data-action="close-task-panel" aria-label="关闭项目详情">×</button>
        </header>
        <div class="dtw-inspector-scroll">
          <div class="dtw-inspector-meta"><span class="dtw-memory-status ${status.className}">${esc(status.label)}</span><span>${activeItems.length} 条记忆</span>${memory.updatedAt ? `<time>更新于 ${esc(new Date(memory.updatedAt).toLocaleString())}</time>` : ""}</div>
          ${jobNotice}
          ${memory.captureIncomplete ? '<p class="dtw-capture-warning">上次只整理了页面当时可读取的消息，未加载历史未计入。</p>' : ""}

          <section class="dtw-project-brief is-next">
            <div><h3>下一步</h3><button type="button" data-action="edit-memory-field" data-task-id="${esc(task.id)}" data-field="nextStep">编辑</button></div>
            <p class="${memory.nextStep ? "" : "is-empty"}">${esc(memory.nextStep || "还没有明确的下一步")}</p>
          </section>

          <section class="dtw-project-brief">
            <div><h3>项目概况</h3><button type="button" data-action="edit-memory-field" data-task-id="${esc(task.id)}" data-field="summary">编辑</button></div>
            <p class="${memory.summary ? "" : "is-empty"}">${esc(memory.summary || "还没有项目概况，可以手动填写或让 DeepSeek 整理。")}</p>
          </section>

          <section class="dtw-quick-actions">
            <button class="is-primary" type="button" data-action="update-memory" data-task-id="${esc(task.id)}" ${activeJob ? "disabled" : ""}>↻ 用 DeepSeek 整理</button>
            <button type="button" data-action="add-task-item" data-task-id="${esc(task.id)}">＋ 记忆</button>
          </section>

          <div class="dtw-inspector-section-title"><h3>项目记忆</h3><small>${activeItems.length} 条有效</small></div>
          <div class="dtw-inspector-groups">${grouped || '<p class="dtw-inspector-empty">还没有结构化记忆。可人工添加，或让 DeepSeek 从项目会话中整理。</p>'}</div>

          ${retiredItems.length ? `<details class="dtw-retired"><summary>已退役记忆（${retiredItems.length}）</summary>${retiredItems.map((item) => inspectorItemTemplate(task, item)).join("")}</details>` : ""}
        </div>
        <footer class="dtw-inspector-footer">
          <button type="button" data-action="rename-task" data-task-id="${esc(task.id)}">重命名</button>
          <button type="button" data-action="open-latest-task-conversation" data-task-id="${esc(task.id)}" ${latestConversation ? "" : "disabled"}>打开最近会话</button>
          <details class="dtw-more-actions">
            <summary>更多</summary>
            <div>
              <button type="button" data-action="copy-task-context" data-task-id="${esc(task.id)}">复制项目上下文</button>
              ${memory.history.length ? `<button type="button" data-action="undo-task-memory" data-task-id="${esc(task.id)}">撤销更新</button>` : ""}
              ${memory.version ? `<button type="button" data-action="rebuild-task-memory" data-task-id="${esc(task.id)}">从原文重建</button>` : ""}
              ${(memory.version || memory.summary || memory.items.length) ? `<button type="button" data-action="clear-task-memory" data-task-id="${esc(task.id)}">清空记忆</button>` : ""}
              <button class="is-danger" type="button" data-action="delete-task" data-task-id="${esc(task.id)}">删除项目</button>
            </div>
          </details>
        </footer>
      </aside>`;
  }

  function factsModalTemplate() {
    const facts = [...memoryState.userFacts].sort((a, b) => {
      if (a.status === b.status) return a.key.localeCompare(b.key);
      return a.status === "disabled" ? 1 : -1;
    });
    const factTemplate = (fact) => `
      <article class="dtw-fact ${fact.status === "disabled" ? "is-disabled" : ""}">
        <div class="dtw-fact-heading"><strong>${esc(fact.key)}</strong><span>${esc(fact.status)}</span><em>${esc(fact.importance)}</em></div>
        <p>${esc(fact.value || "已禁用，整理旧历史时不会自动恢复")}</p>
        <small>${esc(fact.category)} · ${esc(fact.scope)}${fact.manual ? " · 人工" : " · DeepSeek 提取"}</small>
        <div class="dtw-memory-item-actions">
          ${fact.status === "candidate" ? `<button type="button" data-action="confirm-fact" data-fact-id="${esc(fact.id)}">确认保存</button>` : ""}
          <button type="button" data-action="edit-fact" data-fact-id="${esc(fact.id)}">编辑</button>
          <button type="button" data-action="toggle-fact" data-fact-id="${esc(fact.id)}">${fact.status === "disabled" ? "恢复" : "禁用"}</button>
        </div>
      </article>`;
    return `
      <div class="dtw-modal-backdrop" data-action="close-memory">
        <section class="dtw-memory-modal" role="dialog" aria-modal="true" aria-label="用户事实记忆">
          <header class="dtw-modal-header">
            <div><small>跨项目记忆</small><h2>用户事实</h2></div>
            <button type="button" data-action="close-memory" aria-label="关闭">×</button>
          </header>
          <div class="dtw-modal-body">
            <p class="dtw-memory-explainer">只保存稳定的非敏感资料、偏好、工作方式和术语。任务客户、预算、健康、财务和证件信息不会自动加入。</p>
            <div class="dtw-memory-section-title"><h3>${facts.filter((fact) => fact.status !== "disabled").length} 条有效记忆</h3><button type="button" data-action="add-fact">＋ 人工添加</button></div>
            <div class="dtw-memory-items">${facts.length ? facts.map(factTemplate).join("") : '<p class="dtw-modal-empty">任务整理时会在这里产生明确事实或待确认候选。</p>'}</div>
          </div>
          <footer class="dtw-modal-footer"><span>禁用会留下排除标记，避免旧历史把事实自动恢复。</span><button type="button" data-action="close-memory">完成</button></footer>
        </section>
      </div>`;
  }

  function settingsModalTemplate() {
    const settings = memoryState.settings;
    const fsStatus = fsState?.status || "unauthorized";
    const fsLabel = {
      ok: "已连接本地文件夹",
      degraded: "授权失效，记忆暂存于浏览器副本",
      unauthorized: "未选择文件夹（记忆只存浏览器本地）",
    }[fsStatus];
    const fsDetail = [
      fsState?.lastSyncAt ? `上次同步 ${fsState.lastSyncAt.replace("T", " ").slice(0, 19)}` : "",
      fsState?.lastError || "",
    ].filter(Boolean).join(" · ");
    const toggleButton = (action, on, onText = "开", offText = "关") =>
      `<button type="button" data-action="${action}"${on ? ' class="is-on"' : ""}>${on ? `✓ ${onText}` : offText}</button>`;
    return `
      <div class="dtw-modal-backdrop" data-action="close-memory">
        <section class="dtw-memory-modal" role="dialog" aria-modal="true" aria-label="插件设置">
          <header class="dtw-modal-header">
            <div><small>DeepSeek 项目工作台</small><h2>设置</h2></div>
            <button type="button" data-action="close-memory" aria-label="关闭">×</button>
          </header>
          <div class="dtw-modal-body">
            <div class="dtw-memory-section-title"><h3>项目管理</h3></div>
            <div class="dtw-setting-row">
              <div><strong>AI 自动归类</strong><small>新会话完成首轮对话后，让 DeepSeek 从现有项目中选择归属；不确定时保留未分类</small></div>
              ${toggleButton("toggle-auto-classify", settings.autoClassify)}
            </div>
            <div class="dtw-memory-section-title"><h3>记忆整理</h3></div>
            <div class="dtw-setting-row">
              <div><strong>自动注入</strong><small>任务会话每条消息发送前注入该任务记忆</small></div>
              ${toggleButton("toggle-auto-inject", settings.autoInject)}
            </div>
            <div class="dtw-setting-row">
              <div><strong>自动整理</strong><small>任务内累计 ${settings.turnsPerOrganize} 轮对话后自动更新任务记忆</small></div>
              <span class="dtw-turns-editor">
                ${toggleButton("toggle-auto-analyze", settings.autoAnalyze)}
                <input class="dtw-turns-input" type="number" min="3" max="30" step="1" value="${settings.turnsPerOrganize}" aria-label="自动整理轮数阈值">
                <button type="button" data-action="save-turns">轮 / 保存</button>
              </span>
            </div>
            <div class="dtw-setting-row">
              <div><strong>会话原文存档</strong><small>整理时把任务会话原文写入本地记忆文件夹</small></div>
              ${toggleButton("toggle-archive", settings.archiveConversations)}
            </div>
            <div class="dtw-memory-section-title"><h3>本地数据</h3></div>
            <div class="dtw-setting-row">
              <div><strong>记忆文件夹</strong><small>${esc(fsLabel)}${fsDetail ? ` · ${esc(fsDetail)}` : ""}</small></div>
              <span class="dtw-setting-actions">
                <button type="button" data-action="open-folder-page">管理文件夹</button>
                <button type="button" data-action="reload-from-folder">重新载入</button>
              </span>
            </div>
            <p class="dtw-memory-explainer">任务记忆与用户事实以 JSON 保存在本地记忆文件夹，可在其中手改后点「重新载入」生效。设置本身保存在浏览器本地。</p>
          </div>
          <footer class="dtw-modal-footer"><span>修改立即生效。</span><button type="button" data-action="close-memory">完成</button></footer>
        </section>
      </div>`;
  }

  function memoryModalTemplate() {
    if (memoryView === "facts") return factsModalTemplate();
    if (memoryView === "settings") return settingsModalTemplate();
    return "";
  }

  function renderRoot() {
    root.innerHTML = `
      ${taskInspectorTemplate()}
      ${memoryModalTemplate()}
      ${pickerTemplate()}
      <div class="dtw-toast" role="status"></div>`;
  }

  function render(force = false) {
    // location.pathname 驱动自绘行的当前会话高亮
    const renderKey = JSON.stringify([state, memoryState, fsState?.status, memoryView, pickerId, location.pathname]);
    if (force || renderKey !== lastRenderKey) {
      lastRenderKey = renderKey;
      renderRoot();
    }
    reconcileNativeSidebar();
    reconcileNativeMenu();
    reconcileToolbar();
  }

  function showToast(message, duration = 1600) {
    const toast = root.querySelector(".dtw-toast");
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("is-visible"), duration);
  }

  function createTask(conversationId = "") {
    const name = prompt("项目名称")?.trim();
    if (!name) return;
    if (name.length > 80) return showToast("项目名称不能超过 80 个字符");
    if (state.tasks.some((task) => task.name === name)) return showToast("同名项目已存在");
    const task = {
      id: crypto.randomUUID?.() || `task_${Date.now()}`,
      name,
      collapsed: false,
      conversationIds: state.conversations[conversationId] ? [conversationId] : [],
      sourceEpoch: 1,
      createdAt: new Date().toISOString(),
    };
    state.tasks.push(task);
    state.selectedTaskId = task.id;
    state.lastSelectedTaskId = task.id;
    pickerId = "";
    saveState();
    render(true);
  }

  function renameTask(taskId) {
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task) return;
    const name = prompt("重命名项目", task.name)?.trim();
    if (!name || name === task.name) return;
    if (name.length > 80) return showToast("项目名称不能超过 80 个字符");
    if (state.tasks.some((item) => item.id !== taskId && item.name === name)) return showToast("同名项目已存在");
    task.name = name;
    saveState();
    render(true);
  }

  function deleteTask(taskId) {
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task || !confirm(`删除项目“${task.name}”？\n其中的会话不会被删除，将回到未分类。`)) return;
    state.tasks = state.tasks.filter((item) => item.id !== taskId);
    delete memoryState.taskMemories[taskId];
    for (const job of Object.values(memoryState.jobs)) {
      if (job.taskId === taskId && ["queued", "running"].includes(job.status)) job.status = "cancelled";
    }
    if (state.selectedTaskId === taskId) state.selectedTaskId = "";
    saveState();
    saveMemoryState();
    render(true);
  }

  function toggleTask(taskId) {
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task) return;
    task.collapsed = !task.collapsed;
    saveState();
    render(true);
  }

  function moveConversation(conversationId, taskId) {
    const affected = new Set();
    for (const task of state.tasks) {
      if (task.conversationIds.includes(conversationId)) affected.add(task.id);
      task.conversationIds = task.conversationIds.filter((id) => id !== conversationId);
    }
    const target = state.tasks.find((task) => task.id === taskId);
    if (target && state.conversations[conversationId]) {
      target.conversationIds.unshift(conversationId);
      affected.add(target.id);
      state.selectedTaskId = target.id;
      state.lastSelectedTaskId = target.id;
    }
    for (const affectedId of affected) {
      const task = state.tasks.find((item) => item.id === affectedId);
      if (task) task.sourceEpoch = Math.max(1, Number(task.sourceEpoch) || 1) + 1;
      const taskMemory = memoryState.taskMemories[affectedId];
      if (taskMemory) {
        taskMemory.status = "error";
        taskMemory.error = "任务的会话归属已变化，需要重新整理";
      }
    }
    saveState();
    saveMemoryState();
    render(true);
  }

  function openConversation(conversationId) {
    const taskId = assignedTaskId(conversationId);
    if (taskId && state.selectedTaskId !== taskId) {
      state.selectedTaskId = taskId;
      saveState();
    }
    const nativeLink = [...document.querySelectorAll('a[href*="/chat/s/"]')]
      .find((link) => !root.contains(link) && idFromHref(link.href) === conversationId);
    if (nativeLink) nativeLink.click();
    else if (state.conversations[conversationId]) location.assign(state.conversations[conversationId].href);
  }

  function selectTask(taskId) {
    if (!state.tasks.some((task) => task.id === taskId)) return;
    state.selectedTaskId = taskId;
    state.lastSelectedTaskId = taskId;
    memoryView = "";
    saveState();
    render(true);
  }

  function closeTaskPanel() {
    state.selectedTaskId = "";
    saveState();
    render(true);
  }

  function openFactsMemory() {
    memoryView = "facts";
    render(true);
  }

  function closeMemory() {
    memoryView = "";
    render(true);
  }

  function commitManualTaskMemory(taskId, mutate) {
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task) return;
    const current = DTWMemory.normalizeTaskMemory(memoryState.taskMemories[taskId]);
    if (current.version || current.summary || current.items.length) {
      current.history.push({
        version: current.version,
        summary: current.summary,
        nextStep: current.nextStep,
        items: DTWMemory.clone(current.items),
        captureIncomplete: Boolean(current.captureIncomplete),
        updatedAt: current.updatedAt,
      });
      current.history = current.history.slice(-8);
    }
    mutate(current);
    current.version += 1;
    current.sourceEpoch = Math.max(1, Number(task.sourceEpoch) || 1);
    current.updatedAt = new Date().toISOString();
    current.status = "ready";
    current.error = "";
    memoryState.taskMemories[taskId] = current;
    saveMemoryState();
    render(true);
  }

  async function startMemoryUpdate(taskId) {
    if (maintenanceRequestRunning) return;
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task) return;
    if (!globalThis.chrome?.runtime?.sendMessage) return showToast("当前环境无法启动 DeepSeek 整理会话", 3000);
    if (!runtimeAlive()) return showToast("插件已重新加载，请刷新本页后再试", 3200);
    if (!memoryState.settings.acknowledgedCloudSummary) {
      const accepted = confirm("更新记忆会在一个非激活的 DeepSeek 标签页中发起整理请求。插件会在请求发送前直接改写请求体，把该任务当前可读取的对话原文交给 DeepSeek。记忆保存在本地，但整理过程不是离线的。是否继续？");
      if (!accepted) return;
      memoryState.settings.acknowledgedCloudSummary = true;
      await saveMemoryState();
    }
    maintenanceRequestRunning = true;
    selectTask(taskId);
    showToast("已排入 DeepSeek 整理队列", 2400);
    try {
      const result = await chrome.runtime.sendMessage({ type: "dtw:start-memory-update", taskId });
      if (!result?.ok) throw new Error(result?.error || "无法创建整理作业");
    } catch (error) {
      showToast(error.message || "无法创建整理作业", 4200);
    } finally {
      maintenanceRequestRunning = false;
    }
  }

  async function retryMemoryUpdate(jobId) {
    if (!runtimeAlive()) return showToast("插件已重新加载，请刷新本页后再试", 3200);
    try {
      showToast("正在重新创建整理作业…", 2400);
      const result = await chrome.runtime.sendMessage({ type: "dtw:retry-memory-update", jobId });
      if (!result?.ok) showToast(result?.error || "重试失败", 4200);
    } catch {
      showToast("插件已重新加载，请刷新本页后再试", 3200);
    }
  }

  function editMemoryField(taskId, field) {
    if (!["summary", "nextStep"].includes(field)) return;
    const current = DTWMemory.normalizeTaskMemory(memoryState.taskMemories[taskId]);
    const max = field === "summary" ? 1500 : 600;
    const label = field === "summary" ? "项目概况" : "下一步";
    const value = prompt(`编辑${label}`, current[field])?.trim();
    if (value == null) return;
    if (value.length > max) return showToast(`内容不能超过 ${max} 个字符`, 2600);
    if (current[field] === value) return showToast("内容没有变化");
    commitManualTaskMemory(taskId, (memory) => { memory[field] = value; });
    showToast(`${label}已保存`);
  }

  function addTaskItem(taskId) {
    const kind = prompt("条目类型：goal / constraint / decision / milestone / blocker", "constraint")?.trim().toLowerCase();
    if (!DTWMemory.TASK_KINDS.includes(kind)) return kind == null ? undefined : showToast("条目类型不受支持", 2600);
    const value = prompt("条目内容")?.trim();
    if (!value) return;
    commitManualTaskMemory(taskId, (memory) => {
      memory.items.push({
        id: DTWMemory.makeId("manual"), kind, text: value.slice(0, 600),
        state: kind === "milestone" ? "todo" : "active", evidence: [],
        pinned: true, source: "manual", updatedAt: new Date().toISOString(),
      });
    });
  }

  function editTaskItem(taskId, itemId) {
    const current = DTWMemory.normalizeTaskMemory(memoryState.taskMemories[taskId]);
    const item = current.items.find((entry) => entry.id === itemId);
    if (!item) return;
    const value = prompt("编辑记忆条目", item.text)?.trim();
    if (!value) return;
    commitManualTaskMemory(taskId, (memory) => {
      const target = memory.items.find((entry) => entry.id === itemId);
      if (target) Object.assign(target, { text: value.slice(0, 600), pinned: true, source: "manual", updatedAt: new Date().toISOString() });
    });
  }

  function pinTaskItem(taskId, itemId) {
    commitManualTaskMemory(taskId, (memory) => {
      const item = memory.items.find((entry) => entry.id === itemId);
      if (item) item.pinned = !item.pinned;
    });
  }

  function retireTaskItem(taskId, itemId) {
    commitManualTaskMemory(taskId, (memory) => {
      const item = memory.items.find((entry) => entry.id === itemId);
      if (item) Object.assign(item, { state: "retired", pinned: true, source: "manual", updatedAt: new Date().toISOString() });
    });
  }

  function advanceTaskItem(taskId, itemId) {
    commitManualTaskMemory(taskId, (memory) => {
      const item = memory.items.find((entry) => entry.id === itemId);
      if (!item || item.state === "retired") return;
      if (item.state === "done") item.state = item.kind === "milestone" ? "todo" : "active";
      else if (item.kind === "milestone" && !["doing", "proposed_done"].includes(item.state)) item.state = "doing";
      else item.state = "done";
      Object.assign(item, { pinned: true, source: "manual", updatedAt: new Date().toISOString() });
    });
  }

  async function copyTaskContext(taskId) {
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task) return;
    const memory = DTWMemory.normalizeTaskMemory(memoryState.taskMemories[taskId]);
    const labels = { goal: "目标", constraint: "约束", decision: "决定", milestone: "里程碑", blocker: "阻塞" };
    const lines = [`# 任务：${task.name}`];
    if (memory.summary) lines.push("", "## 当前概况", memory.summary);
    if (memory.nextStep) lines.push("", "## 下一步", memory.nextStep);
    for (const kind of Object.keys(labels)) {
      const items = memory.items.filter((item) => item.kind === kind && item.state !== "retired");
      if (!items.length) continue;
      lines.push("", `## ${labels[kind]}`, ...items.map((item) => `- [${itemStateLabel(item)}] ${item.text}`));
    }
    const facts = memoryState.userFacts.filter((fact) => fact.status === "active");
    if (facts.length) lines.push("", "## 用户事实", ...facts.map((fact) => `- ${fact.key}: ${fact.value}`));
    if (lines.length === 1) lines.push("", "尚未整理任务记忆。");
    const context = lines.join("\n");
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(context);
      else {
        const textarea = document.createElement("textarea");
        textarea.value = context;
        textarea.style.cssText = "position:fixed;left:-9999px;top:0";
        document.body.append(textarea);
        textarea.select();
        document.execCommand("copy");
        textarea.remove();
      }
      showToast("任务上下文已复制", 2200);
    } catch {
      showToast("复制失败，请检查浏览器剪贴板权限", 3200);
    }
  }

  function openLatestTaskConversation(taskId) {
    const task = state.tasks.find((item) => item.id === taskId);
    const conversationId = task?.conversationIds.find((id) => state.conversations[id]);
    if (conversationId) openConversation(conversationId);
  }

  function undoTaskMemory(taskId) {
    const task = state.tasks.find((item) => item.id === taskId);
    const current = DTWMemory.normalizeTaskMemory(memoryState.taskMemories[taskId]);
    const previous = current.history.pop();
    if (!task || !previous) return;
    current.summary = previous.summary;
    current.nextStep = previous.nextStep;
    current.items = previous.items;
    current.captureIncomplete = Boolean(previous.captureIncomplete);
    current.version += 1;
    current.sourceEpoch = Math.max(1, Number(task.sourceEpoch) || 1);
    current.updatedAt = new Date().toISOString();
    current.status = "ready";
    current.error = "";
    memoryState.taskMemories[taskId] = current;
    saveMemoryState();
    render(true);
  }

  function rebuildTaskMemory(taskId) {
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task || !confirm("从原文重建会清除模型生成的当前快照并重新整理；人工固定条目会保留。是否继续？")) return;
    const current = DTWMemory.normalizeTaskMemory(memoryState.taskMemories[taskId]);
    current.history.push({
      version: current.version,
      summary: current.summary,
      nextStep: current.nextStep,
      items: DTWMemory.clone(current.items),
      captureIncomplete: Boolean(current.captureIncomplete),
      updatedAt: current.updatedAt,
    });
    current.history = current.history.slice(-8);
    current.version += 1;
    current.sourceEpoch = Math.max(1, Number(task.sourceEpoch) || 1);
    current.summary = "";
    current.nextStep = "";
    current.items = current.items.filter((item) => item.pinned || item.source === "manual");
    current.coveredMessageIds = [];
    current.captureIncomplete = false;
    current.status = "empty";
    current.error = "";
    current.updatedAt = new Date().toISOString();
    memoryState.taskMemories[taskId] = current;
    const activeJob = latestJobForTask(taskId);
    saveMemoryState().then(() => {
      if (activeJob && ["queued", "running"].includes(activeJob.status)) showToast("当前整理会因版本变化被拒绝，结束后请重新更新", 4200);
      else startMemoryUpdate(taskId);
    });
    render(true);
  }

  function addFact() {
    const rawKey = prompt("事实 key（英文 snake_case，例如 preferred_language）")?.trim();
    if (rawKey == null) return;
    const key = DTWMemory.sanitizeFactKey(rawKey);
    if (!key) return showToast("key 必须包含英文字母或数字", 2600);
    const value = prompt("事实内容")?.trim();
    if (!value) return;
    const old = memoryState.userFacts.find((fact) => fact.key === key);
    const fact = DTWMemory.normalizeFact({
      id: old?.id || DTWMemory.makeId("fact"), key, value,
      category: old?.category || "preference", scope: old?.scope || "global",
      status: "active", importance: old?.importance || "called", evidence: old?.evidence || [],
      manual: true, updatedAt: new Date().toISOString(),
    });
    memoryState.userFacts = [...memoryState.userFacts.filter((entry) => entry.key !== key), fact];
    saveMemoryState();
    render(true);
  }

  function editFact(factId) {
    const fact = memoryState.userFacts.find((entry) => entry.id === factId);
    if (!fact) return;
    const value = prompt(`编辑 ${fact.key}`, fact.value)?.trim();
    if (!value) return;
    Object.assign(fact, { value: value.slice(0, 200), status: "active", manual: true, disabledAt: "", updatedAt: new Date().toISOString() });
    saveMemoryState();
    render(true);
  }

  function toggleFact(factId) {
    const fact = memoryState.userFacts.find((entry) => entry.id === factId);
    if (!fact) return;
    if (fact.status === "disabled") {
      Object.assign(fact, { status: "active", manual: true, disabledAt: "", updatedAt: new Date().toISOString() });
    } else {
      Object.assign(fact, { status: "disabled", manual: true, disabledAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    }
    saveMemoryState();
    render(true);
  }

  function confirmFact(factId) {
    const fact = memoryState.userFacts.find((entry) => entry.id === factId);
    if (!fact || fact.status !== "candidate") return;
    Object.assign(fact, { status: "active", manual: true, updatedAt: new Date().toISOString() });
    saveMemoryState();
    render(true);
  }

  const AUTO_SETTING_LABELS = {
    autoClassify: "AI 自动归类",
    autoInject: "自动注入",
    autoAnalyze: "自动整理",
    archiveConversations: "会话原文存档",
  };

  function toggleAutoSetting(name) {
    if (!AUTO_SETTING_LABELS[name]) return;
    const enabling = !memoryState.settings[name];
    if (name === "autoClassify" && enabling && !state.tasks.length) {
      return showToast("请先创建至少一个项目", 2600);
    }
    if (enabling && !memoryState.settings.acknowledgedCloudSummary) {
      const detail = name === "autoClassify"
        ? "开启后，新会话完成首轮对话时，插件会把会话标题与最多 12000 字符的对话原文发送给 DeepSeek，由它在现有项目中选择归属并自动移动。"
        : name === "autoInject"
        ? "开启后，任务会话的每条消息发送前，插件会把该任务的记忆注入 DeepSeek 请求；注入内容会保存在 DeepSeek 服务端对话历史中。"
        : name === "autoAnalyze"
          ? `开启后，任务内每累计 ${memoryState.settings.turnsPerOrganize} 轮对话，插件会自动在非激活标签页中发起 DeepSeek 整理请求，把任务会话原文交给 DeepSeek。`
          : "开启后，整理任务记忆时会把任务会话原文存档写入本地记忆文件夹；原文不发送给 DeepSeek。";
      if (!confirm(`${detail}\n记忆保存在本地，但该过程不是离线的。是否继续？`)) return;
      memoryState.settings.acknowledgedCloudSummary = true;
    }
    memoryState.settings[name] = enabling;
    saveMemoryState();
    render(true);
    pushMemoryContext();
    showToast(`${AUTO_SETTING_LABELS[name]}${enabling ? "已开启" : "已关闭"}`, 2000);
  }

  function saveTurnsSetting() {
    const input = root.querySelector(".dtw-turns-input");
    const turns = Math.min(30, Math.max(3, Number.parseInt(input?.value, 10) || 5));
    memoryState.settings.turnsPerOrganize = turns;
    saveMemoryState();
    render(true);
    showToast(`每 ${turns} 轮自动整理`, 2000);
  }

  async function reloadFromFolder() {
    showToast("正在从文件夹重新载入…", 2400);
    try {
      const result = await chrome.runtime.sendMessage({ type: "dtw:fs-reload" });
      if (!result?.ok) throw new Error(result?.error || `当前状态不支持（${result?.status || "未知"}）`);
      showToast(`已载入 ${result.loaded.tasks} 个任务、${result.loaded.facts} 条用户事实`, 3200);
    } catch (error) {
      showToast(error.message || "重新载入失败", 3600);
    }
  }

  function clearTaskMemoryAction(taskId) {
    if (!runtimeAlive()) return showToast("插件已重新加载，请刷新本页后再试", 3200);
    if (!confirm("清空会删除该任务的概况、下一步和全部记忆条目（含人工条目），且不可恢复。是否继续？")) return;
    try {
      chrome.runtime.sendMessage({ type: "dtw:clear-task-memory", taskId })
        .then((result) => {
          if (!result?.ok) throw new Error(result?.error || "清空失败");
          showToast("任务记忆已清空");
        })
        .catch((error) => showToast(error.message || "清空失败", 3200));
    } catch {
      showToast("插件已重新加载，请刷新本页后再试", 3200);
    }
  }

  // 委托挂 document：插件 UI 分散在 #dtw-root（浮层）与原生侧栏内（.dtw-owned 注入节点）
  document.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-action]");
    if (!button || !button.closest("#dtw-root, .dtw-owned")) return;
    const { action, id, taskId, itemId, factId, jobId, field } = button.dataset;
    if (action === "close-memory" && button.classList.contains("dtw-modal-backdrop") && event.target !== button) return;
    if (action === "new-task") createTask(id);
    else if (action === "open") openConversation(id);
    else if (action === "native-menu") openNativeConversationMenu(id);
    else if (action === "open-picker") {
      const rect = findNativeMenu()?.getBoundingClientRect() || button.getBoundingClientRect();
      openTaskPicker(id, { x: rect.right + 8, y: Math.max(rect.top - 6, 8) });
      closeNativeMenu();
    }
    else if (action === "close-picker") closeTaskPicker();
    else if (action === "move") { moveConversation(id, taskId); closeTaskPicker(); }
    else if (action === "remove") { moveConversation(id, ""); closeTaskPicker(); }
    else if (action === "rename-task") renameTask(taskId);
    else if (action === "delete-task") deleteTask(taskId);
    else if (action === "toggle-task") toggleTask(taskId);
    else if (action === "select-task") selectTask(taskId);
    else if (action === "close-task-panel") closeTaskPanel();
    else if (action === "facts-memory") openFactsMemory();
    else if (action === "settings-memory") { memoryView = "settings"; render(true); }
    else if (action === "toggle-archive") toggleAutoSetting("archiveConversations");
    else if (action === "save-turns") saveTurnsSetting();
    else if (action === "open-folder-page") {
      if (globalThis.chrome?.runtime?.getURL) window.open(chrome.runtime.getURL("popup/popup.html"), "_blank");
    }
    else if (action === "reload-from-folder") reloadFromFolder();
    else if (action === "close-memory") closeMemory();
    else if (action === "update-memory") startMemoryUpdate(taskId);
    else if (action === "retry-memory") retryMemoryUpdate(jobId);
    else if (action === "edit-memory-field") editMemoryField(taskId, field);
    else if (action === "add-task-item") addTaskItem(taskId);
    else if (action === "edit-task-item") editTaskItem(taskId, itemId);
    else if (action === "pin-task-item") pinTaskItem(taskId, itemId);
    else if (action === "retire-task-item") retireTaskItem(taskId, itemId);
    else if (action === "advance-task-item") advanceTaskItem(taskId, itemId);
    else if (action === "copy-task-context") copyTaskContext(taskId);
    else if (action === "open-latest-task-conversation") openLatestTaskConversation(taskId);
    else if (action === "undo-task-memory") undoTaskMemory(taskId);
    else if (action === "rebuild-task-memory") rebuildTaskMemory(taskId);
    else if (action === "clear-task-memory") clearTaskMemoryAction(taskId);
    else if (action === "toggle-auto-inject") toggleAutoSetting("autoInject");
    else if (action === "toggle-auto-analyze") toggleAutoSetting("autoAnalyze");
    else if (action === "toggle-auto-classify") toggleAutoSetting("autoClassify");
    else if (action === "add-fact") addFact();
    else if (action === "edit-fact") editFact(factId);
    else if (action === "toggle-fact") toggleFact(factId);
    else if (action === "confirm-fact") confirmFact(factId);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (pickerId) closeTaskPicker();
    else if (memoryView) closeMemory();
    else if (state.selectedTaskId) closeTaskPanel();
  });

  async function scan() {
    scanQueued = false;
    lastScanAt = Date.now();
    scanTicks += 1;
    root.dataset.scanTick = String(scanTicks); // 测试用：检测扫描循环是否收敛
    const sidebar = findNativeSidebar();
    if (!sidebar) return;
    nativeSidebar = sidebar;

    const found = collectConversations();
    let changed = false;
    for (const item of found) {
      const old = state.conversations[item.id];
      if (!old || old.title !== item.title || old.href !== item.href) {
        state.conversations[item.id] = item;
        changed = true;
      }
    }
    if (changed) await saveState();
    render(changed);
    pushMemoryContext();
  }

  function scheduleScan() {
    if (scanQueued) return;
    scanQueued = true;
    // 分组搬运自身也触发 body MutationObserver；没有最小间隔时会以 rAF 速率自激
    // 空转（生成期间曾把页面拖崩）。用 setTimeout 而非 rAF：窗口被遮挡时 rAF
    // 停摆，scanQueued 会卡死，整个扫描循环就此失效（表象：记忆上下文不再推送）。
    const wait = Math.max(0, 250 - (Date.now() - lastScanAt));
    setTimeout(scan, wait);
  }

  function simpleHash(value) {
    let hash = 5381;
    for (let index = 0; index < value.length; index += 1) hash = ((hash << 5) + hash) ^ value.charCodeAt(index);
    return (hash >>> 0).toString(36);
  }

  function elementToText(node) {
    const clone = node.cloneNode(true);
    clone.querySelectorAll("button, [role=button], svg, style, script, .ds-think-content, [class*=think], #dtw-root")
      .forEach((element) => element.remove());
    const walk = (element) => {
      let output = "";
      for (const child of element.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) output += child.textContent || "";
        else if (child.nodeType === Node.ELEMENT_NODE) {
          const tag = child.tagName.toLowerCase();
          if (tag === "br") output += "\n";
          else if (tag === "pre") {
            const code = child.querySelector("code");
            const language = code?.className?.match(/language-([\w-]+)/)?.[1] || "";
            output += `\n\`\`\`${language}\n${(code || child).textContent || ""}\n\`\`\`\n`;
          } else {
            const content = walk(child);
            if (tag === "li") output += `\n- ${content}`;
            else if (/^(p|div|section|article|h[1-6]|blockquote|ul|ol)$/.test(tag)) output += `\n${content}\n`;
            else output += content;
          }
        }
      }
      return output;
    };
    return walk(clone).replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  function detectCapturedRole(node) {
    const role = String(node.getAttribute?.("data-message-author-role") || "").toLowerCase();
    if (role === "user" || role === "human") return "user";
    if (role === "assistant") return "assistant";
    if (node.classList?.contains("d29f3d7d") || node.closest?.("div._9663006")) return "user";
    if (node.classList?.contains("ds-message") || node.closest?.("div._4f9bf79._43c05b5")) return "assistant";
    return "";
  }

  function collectMessageCandidates() {
    const raw = [...document.querySelectorAll('[data-message-author-role], div.d29f3d7d, div.ds-message')]
      .filter((node) => !root.contains(node) && detectCapturedRole(node));
    const candidates = raw.filter((node, index) => !raw.some((other, otherIndex) =>
      index !== otherIndex && detectCapturedRole(other) === detectCapturedRole(node) && other.contains(node)));
    return [...new Set(candidates)].sort((a, b) => {
      if (a === b) return 0;
      return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });
  }

  function captureCurrentConversation(expectedId = "") {
    const conversationId = idFromHref(location.href);
    if (expectedId && conversationId && expectedId !== conversationId) {
      return { ok: false, error: "页面打开的会话与整理目标不一致" };
    }
    const roleIndexes = { user: 0, assistant: 0 };
    const messages = [];
    for (const node of collectMessageCandidates()) {
      const role = detectCapturedRole(node);
      const messageText = elementToText(node);
      if (!role || !messageText) continue;
      roleIndexes[role] += 1;
      messages.push({
        id: `${conversationId || expectedId}:${role}:${roleIndexes[role]}:${simpleHash(messageText)}`,
        role,
        text: messageText,
        revision: 1,
      });
    }
    const totalChars = messages.reduce((total, message) => total + message.text.length, 0);
    if (totalChars > 50000) {
      return { ok: false, error: `当前会话原文共 ${totalChars} 字符，超过单次安全整理容量；插件没有截断原文` };
    }
    return {
      ok: messages.length > 0,
      conversationId: conversationId || expectedId,
      messages,
      captureIncomplete: !messages.some((message) => message.role === "user") || !messages.some((message) => message.role === "assistant"),
      error: messages.length ? "" : captureDiagnosticError(expectedId),
    };
  }

  function captureDiagnosticError(expectedId = "") {
    const bodyText = String(document.body?.innerText || document.body?.textContent || "");
    if (/登录|log\s*in|sign\s*in/i.test(bodyText) && !findNativeEditor()) return "DeepSeek 整理标签页没有登录，无法读取会话";
    if (/会话不存在|对话不存在|not found|无权访问/i.test(bodyText)) return "DeepSeek 无法打开这个会话，可能已删除或当前账号无权访问";
    const routeId = idFromHref(location.href);
    const counts = {
      assistant: document.querySelectorAll("div.ds-message").length,
      userLegacy: document.querySelectorAll("div.d29f3d7d, div._9663006").length,
      role: document.querySelectorAll("[data-message-author-role]").length,
      markdown: document.querySelectorAll(".ds-markdown, .ds-message-content").length,
    };
    const route = routeId || location.pathname;
    return `等待 DeepSeek 渲染会话消息超时（目标 ${expectedId || "未知"}，当前 ${route}；节点 assistant=${counts.assistant}, user=${counts.userLegacy}, role=${counts.role}, markdown=${counts.markdown}）`;
  }

  async function waitForConversationCapture(expectedId, timeoutMs = 45000) {
    const started = Date.now();
    let stableKey = "";
    let stableSince = 0;
    let lastResult = null;
    while (Date.now() - started < timeoutMs) {
      lastResult = captureCurrentConversation(expectedId);
      if (lastResult.ok) {
        const key = lastResult.messages.map((message) => `${message.id}:${message.text.length}`).join("|");
        if (key !== stableKey) {
          stableKey = key;
          stableSince = Date.now();
        } else if (Date.now() - stableSince >= 2500 && Date.now() - started >= 3000) {
          return lastResult;
        }
      } else {
        stableKey = "";
        stableSince = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
    return { ok: false, messages: [], error: lastResult?.error || captureDiagnosticError(expectedId) };
  }

  async function captureConversationForMemory(expectedId) {
    try {
      return await requestConversationHistory(expectedId);
    } catch (apiError) {
      const fallback = await waitForConversationCapture(expectedId, 15000);
      if (fallback.ok) return { ...fallback, source: "dom-fallback" };
      return {
        ...fallback,
        error: `历史消息接口读取失败（${apiError.message}）；DOM 回退也失败：${fallback.error}`,
      };
    }
  }

  function findNativeEditor() {
    const selectors = [
      "textarea#chat-input", ".ds-textarea textarea", '[role="textbox"][contenteditable]',
      '[role="textbox"]', ".ProseMirror[contenteditable]", "textarea[placeholder]", "[contenteditable]",
    ];
    for (const selector of selectors) {
      const editor = [...document.querySelectorAll(selector)].find((candidate) => !root.contains(candidate));
      if (editor) return editor;
    }
    return null;
  }

  async function waitForNativeEditor(timeoutMs = 30000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const editor = findNativeEditor();
      if (editor) return editor;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new Error("找不到 DeepSeek 输入框");
  }

  function setNativeEditorText(editor, value) {
    editor.focus();
    const tag = editor.tagName.toLowerCase();
    if (tag === "textarea" || tag === "input") {
      const prototype = tag === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (setter) setter.call(editor, value); else editor.value = value;
    } else {
      editor.textContent = value;
    }
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    editor.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function controlLabel(control) {
    return `${control.getAttribute?.("aria-label") || ""} ${control.getAttribute?.("title") || ""} ${control.textContent || ""}`.trim();
  }

  function findNativeSendControl(editor) {
    const controls = [...document.querySelectorAll('button, div[role="button"]')]
      .filter((control) => !root.contains(control) && !(control.compareDocumentPosition(editor) & Node.DOCUMENT_POSITION_FOLLOWING));
    return controls.find((control) => /^(send|发送|提交)$/i.test(controlLabel(control)))
      || controls.find((control) => control.querySelector(".ds-icon-send") || /send|发送/i.test(controlLabel(control)))
      || null;
  }

  function isNativeGenerating() {
    return [...document.querySelectorAll('button, div[role="button"]')]
      .some((control) => !root.contains(control) && /stop|停止生成|停止回答/i.test(controlLabel(control)));
  }

  async function submitNativeEditor(editor) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const control = findNativeSendControl(editor);
    if (control && control.getAttribute("aria-disabled") !== "true" && !control.hasAttribute("disabled")) {
      control.click();
      return;
    }
    editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
    editor.dispatchEvent(new KeyboardEvent("keypress", { key: "Enter", code: "Enter", bubbles: true }));
    editor.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true }));
  }

  async function waitForSummaryResult(initialAssistantCount, timeoutMs = 180000) {
    const started = Date.now();
    let stableSince = 0;
    let previous = "";
    while (Date.now() - started < timeoutMs) {
      const assistants = [...document.querySelectorAll("div.ds-message")].filter((node) => !root.contains(node));
      const latest = assistants.at(-1);
      const current = latest ? elementToText(latest) : "";
      if (assistants.length > initialAssistantCount && current.length > 20) {
        if (current === previous) {
          if (!stableSince) stableSince = Date.now();
          if (!isNativeGenerating() && Date.now() - stableSince >= 3500) return current;
        } else {
          previous = current;
          stableSince = Date.now();
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("等待 DeepSeek 整理结果超时");
  }

  async function runStructuredMaintenance(jobId, promptText, operation, resultType, statusText) {
    let command = null;
    let applied = null;
    summarizeInTab = true;
    try {
      const editor = await waitForNativeEditor();
      const initialAssistantCount = document.querySelectorAll("div.ds-message").length;
      command = await armRequestBody(operation, jobId, promptText);
      applied = waitForNetworkEvent("dtw:network-applied", command.requestId, 15000);
      setNativeEditorText(editor, `${command.marker}\n${statusText}`);
      await submitNativeEditor(editor);
      await applied;
      const raw = await waitForSummaryResult(initialAssistantCount);
      await chrome.runtime.sendMessage({
        type: resultType,
        jobId,
        raw,
        conversationId: idFromHref(location.href),
      });
    } catch (error) {
      if (command?.requestId) cancelRequestBody(command.requestId);
      applied?.catch(() => {});
      try {
        await chrome.runtime.sendMessage({
          type: resultType,
          jobId,
          raw: "",
          error: error.message,
          conversationId: idFromHref(location.href),
        });
      } catch { /* Orphaned after an extension reload; the job times out. */ }
    } finally {
      summarizeInTab = false;
    }
  }

  const runMemorySummary = (jobId, promptText) => runStructuredMaintenance(
    jobId, promptText, "memory-summary", "dtw:memory-summary-result", "项目工作台正在更新项目记忆",
  );
  const runProjectClassifier = (jobId, promptText) => runStructuredMaintenance(
    jobId, promptText, "project-classify", "dtw:project-classify-result", "项目工作台正在判断会话归属",
  );

  if (globalThis.chrome?.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type === "dtw:capture-conversation") {
        captureConversationForMemory(message.expectedId)
          .then(sendResponse)
          .catch((error) => sendResponse({ ok: false, messages: [], error: error.message }));
        return true;
      }
      if (message?.type === "dtw:run-memory-summary") {
        waitForNativeEditor().then((editor) => {
          sendResponse({ ok: Boolean(editor) });
          runMemorySummary(message.jobId, message.prompt);
        }).catch((error) => sendResponse({ ok: false, error: error.message }));
        return true;
      }
      if (message?.type === "dtw:run-project-classifier") {
        waitForNativeEditor().then((editor) => {
          sendResponse({ ok: Boolean(editor) });
          runProjectClassifier(message.jobId, message.prompt);
        }).catch((error) => sendResponse({ ok: false, error: error.message }));
        return true;
      }
      return false;
    });
  }

  // Auto-organize runs in a hidden tab; surface its start/finish/failure for
  // the task the user is chatting in — otherwise the feature is invisible.
  function notifyJobTransitions(previous, next) {
    try {
      const conversationId = idFromHref(location.href);
      const taskId = (conversationId ? assignedTaskId(conversationId) : "")
        || state.selectedTaskId || state.lastSelectedTaskId;
      const taskName = state.tasks.find((task) => task.id === taskId)?.name || "当前任务";
      for (const job of Object.values(next.jobs)) {
        const was = previous.jobs[job.id]?.status || "";
        if (job.kind === "classify" && job.conversationId === conversationId) {
          if (["queued", "running"].includes(job.status) && !["queued", "running"].includes(was)) {
            showToast("DeepSeek 正在判断该会话所属项目", 3200);
          } else if (job.status === "done" && was !== "done" && was) {
            showToast(job.resultTaskName
              ? `已自动归类到「${job.resultTaskName}」`
              : "未找到足够匹配的项目，已保留在未分类", 3600);
          } else if (job.status === "failed" && was !== "failed" && was) {
            showToast(`自动归类失败：${job.error}`, 4200);
          }
          continue;
        }
        if (job.taskId !== taskId) continue;
        if (["queued", "running"].includes(job.status) && !["queued", "running"].includes(was)) {
          showToast(`「${taskName}」开始整理任务记忆`, 3200);
        } else if (job.status === "done" && was !== "done" && was) {
          showToast(`「${taskName}」任务记忆已更新`, 3200);
        } else if (job.status === "failed" && was !== "failed" && was) {
          showToast(`「${taskName}」整理失败：${job.error}`, 4200);
        }
      }
    } catch { /* notification only */ }
  }

  async function start() {
    if (!document.body) {
      new MutationObserver((_, observer) => {
        if (!document.body) return;
        observer.disconnect();
        start();
      }).observe(document.documentElement, { childList: true });
      return;
    }
    [state, memoryState] = await Promise.all([loadState(), loadMemoryState()]);
    if (globalThis.chrome?.storage?.local) {
      fsState = (await chrome.storage.local.get(FS_KEY))[FS_KEY] || null;
    }
    document.body.appendChild(root);
    // 捕获阶段记录 ••• 点击所在行，供原生菜单注入时解析归属会话
    document.addEventListener("click", (event) => {
      const row = event.target?.closest?.('a[href*="/chat/s/"]');
      if (row && !root.contains(row)) {
        pendingMenuRow = row;
        pendingMenuRowAt = Date.now();
      }
    }, true);
    await scan();

    new MutationObserver((records) => {
      if (records.some((record) => !root.contains(record.target))) scheduleScan();
    }).observe(document.body, { childList: true, subtree: true });
    addEventListener("focus", scheduleScan);
    document.addEventListener("visibilitychange", scheduleScan);
    // ponytail: cheap sidebar rescan; replace only if profiling shows it matters.
    setInterval(() => {
      scheduleScan();
      checkTurnCompleted();
    }, 1500);

    if (globalThis.chrome?.storage?.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local") return;
        if (changes[STORAGE_KEY]) state = cleanState(changes[STORAGE_KEY].newValue);
        if (changes[MEMORY_KEY]) {
          const next = DTWMemory.normalizeStore(changes[MEMORY_KEY].newValue);
          notifyJobTransitions(memoryState, next);
          memoryState = next;
        }
        if (changes[FS_KEY]) fsState = changes[FS_KEY].newValue || null;
        if (changes[STORAGE_KEY] || changes[MEMORY_KEY]) {
          render(true);
          pushMemoryContext();
        }
      });
    }
  }

  start().catch((error) => console.warn("[DeepSeek 项目工作台] 启动失败，保留原版页面：", error));
})();
