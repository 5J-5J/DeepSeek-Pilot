/**
 * DeepSeek 任务工作台
 * 用任务列表覆盖原生左侧栏，并提供可关闭的任务详情右侧栏。
 * 聊天、输入、附件、模型选择等全部保留原版实现。
 */
(() => {
  "use strict";
  if (window.__dtwBootstrapped) return;
  window.__dtwBootstrapped = true;

  const STORAGE_KEY = "dtw.sidebar.v1";
  const MEMORY_KEY = "dtw.memory.v1";
  const EMPTY_STATE = { tasks: [], conversations: {}, selectedTaskId: "" };
  const root = document.createElement("div");
  root.id = "dtw-root";

  function injectPageNetworkHook() {
    if (!globalThis.chrome?.runtime?.getURL || document.getElementById("dtw-request-body-core")) return;
    const mount = document.head || document.documentElement;
    if (!mount) return;
    const coreScript = document.createElement("script");
    coreScript.id = "dtw-request-body-core";
    coreScript.src = chrome.runtime.getURL("request-body-core.js");
    coreScript.async = false;
    coreScript.addEventListener("load", () => {
      if (document.getElementById("dtw-page-network")) return;
      const networkScript = document.createElement("script");
      networkScript.id = "dtw-page-network";
      networkScript.src = chrome.runtime.getURL("page-network.js");
      networkScript.async = false;
      mount.appendChild(networkScript);
    }, { once: true });
    mount.appendChild(coreScript);
  }

  injectPageNetworkHook();

  let state = EMPTY_STATE;
  let memoryState = DTWMemory.emptyStore();
  let nativeSidebar = null;
  let nativeMode = false;
  let openMenuId = null;
  let openTaskMenuId = null;
  let visibleOrder = [];
  let searchQuery = "";
  let toastTimer = 0;
  let scanQueued = false;
  let lastRenderKey = "";
  let memoryView = "";
  let maintenanceRequestRunning = false;

  const esc = (value) => String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);

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
    const nonce = crypto.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const requestId = `history_${nonce}`;
    const result = waitForNetworkEvent("dtw:history-result", requestId, 15000, "DeepSeek 历史消息接口响应超时");
    window.dispatchEvent(new CustomEvent("dtw:history-request", {
      detail: JSON.stringify({ requestId, sessionId }),
    }));
    const detail = await result;
    return DTWHistory.parseHistoryResponse(detail.data, sessionId);
  }

  const idFromHref = (href) => {
    try {
      return new URL(href, location.href).pathname.match(/\/chat\/s\/([^/?#]+)/)?.[1] || "";
    } catch {
      return "";
    }
  };

  function cleanState(value) {
    if (!value || !Array.isArray(value.tasks) || typeof value.conversations !== "object") return structuredClone(EMPTY_STATE);
    const conversations = {};
    for (const [id, item] of Object.entries(value.conversations)) {
      if (id && item?.title && idFromHref(item.href) === id) conversations[id] = { id, title: String(item.title), href: String(item.href) };
    }
    const tasks = value.tasks
      .filter((task) => task?.id && task?.name && Array.isArray(task.conversationIds))
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
    return { tasks, conversations, selectedTaskId };
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
      console.warn("[DeepSeek 任务工作台] 保存失败：", error);
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
      if (globalThis.chrome?.storage?.local) await chrome.storage.local.set({ [MEMORY_KEY]: memoryState });
      else localStorage.setItem(MEMORY_KEY, JSON.stringify(memoryState));
    } catch (error) {
      showToast("记忆保存失败，请重试", 3200);
      console.warn("[DeepSeek 任务工作台] 记忆保存失败：", error);
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

  function orderedConversations() {
    const ordered = visibleOrder.map((id) => state.conversations[id]).filter(Boolean);
    const visible = new Set(visibleOrder);
    return [...ordered, ...Object.values(state.conversations).filter((item) => !visible.has(item.id))];
  }

  function conversationTemplate(item) {
    const active = location.pathname.includes(`/chat/s/${item.id}`);
    const taskId = assignedTaskId(item.id);
    const menu = openMenuId === item.id ? moveMenuTemplate(item, taskId) : "";
    return `
      <div class="dtw-conversation-wrap" data-filter="${esc(item.title.toLowerCase())}">
        <div class="dtw-conversation${active ? " is-active" : ""}">
          <button class="dtw-open-conversation" type="button" data-action="open" data-id="${esc(item.id)}" title="${esc(item.title)}">
            <span class="dtw-conversation-dot"></span><span>${esc(item.title)}</span>
          </button>
          <button class="dtw-more" type="button" data-action="menu" data-id="${esc(item.id)}" aria-label="管理会话">•••</button>
        </div>
        ${menu}
      </div>`;
  }

  function moveMenuTemplate(item, currentTaskId) {
    const taskButtons = state.tasks.map((task) => `
      <button type="button" data-action="move" data-id="${esc(item.id)}" data-task-id="${esc(task.id)}"${task.id === currentTaskId ? " disabled" : ""}>
        ${task.id === currentTaskId ? "✓ " : ""}${esc(task.name)}
      </button>`).join("");
    return `
      <div class="dtw-move-menu">
        <small>移动到任务</small>
        ${taskButtons || `<button type="button" data-action="new-task" data-id="${esc(item.id)}">＋ 先新建任务</button>`}
        ${currentTaskId ? `<button class="dtw-remove" type="button" data-action="remove" data-id="${esc(item.id)}">移出任务</button>` : ""}
        <button class="dtw-native-manage" type="button" data-action="native-manage" data-id="${esc(item.id)}">DeepSeek 原版管理…</button>
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

  function groupTemplate(task) {
    const items = task.conversationIds.map((id) => state.conversations[id]).filter(Boolean);
    return `
      <section class="dtw-task${task.collapsed ? " is-collapsed" : ""}${state.selectedTaskId === task.id ? " is-selected" : ""}" data-task-id="${esc(task.id)}" data-filter="${esc(task.name.toLowerCase())}">
        <div class="dtw-task-heading">
          <button class="dtw-task-collapse" type="button" data-action="toggle-task" data-task-id="${esc(task.id)}" aria-label="${task.collapsed ? "展开" : "折叠"}任务">
            <span class="dtw-chevron">⌄</span>
          </button>
          <button class="dtw-task-select" type="button" data-action="select-task" data-task-id="${esc(task.id)}" title="打开任务详情">
            <span class="dtw-task-name">${esc(task.name)}</span><small>${items.length}</small>
          </button>
          <button class="dtw-task-more" type="button" data-action="task-menu" data-task-id="${esc(task.id)}" aria-label="管理任务">•••</button>
        </div>
        ${openTaskMenuId === task.id ? `
          <div class="dtw-task-menu">
            <button type="button" data-action="select-task" data-task-id="${esc(task.id)}">打开任务详情</button>
            <button type="button" data-action="update-memory" data-task-id="${esc(task.id)}">用 DeepSeek 更新记忆</button>
            <button type="button" data-action="rename-task" data-task-id="${esc(task.id)}">重命名任务</button>
            <button class="dtw-delete-task" type="button" data-action="delete-task" data-task-id="${esc(task.id)}">删除任务</button>
          </div>` : ""}
        <div class="dtw-conversation-list">
          ${items.length ? items.map(conversationTemplate).join("") : '<p class="dtw-empty">暂无会话</p>'}
        </div>
      </section>`;
  }

  function itemStateLabel(item) {
    const labels = {
      active: "有效", todo: "待办", doing: "进行中", done: "已完成",
      proposed_done: "待确认完成", retired: "已退役",
    };
    return labels[item.state] || item.state;
  }

  function progressForTask(memory) {
    const trackable = memory.items.filter((item) =>
      item.state !== "retired" && ["goal", "milestone"].includes(item.kind));
    const completed = trackable.filter((item) => item.state === "done").length;
    const percent = trackable.length ? Math.round((completed / trackable.length) * 100) : 0;
    return { total: trackable.length, completed, percent };
  }

  function inspectorItemTemplate(task, item) {
    const canAdvance = ["goal", "milestone", "blocker"].includes(item.kind);
    const advanceLabel = item.state === "done" ? "重开" : item.state === "doing" ? "完成" : item.kind === "blocker" ? "已解决" : "推进";
    return `
      <article class="dtw-inspector-item ${item.state === "retired" ? "is-retired" : ""}">
        <div class="dtw-inspector-item-top">
          <span class="dtw-kind is-${esc(item.kind)}">${esc(item.kind)}</span>
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
    const progress = progressForTask(memory);
    const activeItems = memory.items.filter((item) => item.state !== "retired");
    const retiredItems = memory.items.filter((item) => item.state === "retired");
    const blockers = activeItems.filter((item) => item.kind === "blocker" && item.state !== "done").length;
    const decisions = activeItems.filter((item) => item.kind === "decision").length;
    const constraints = activeItems.filter((item) => item.kind === "constraint").length;
    const conversations = task.conversationIds.map((id) => state.conversations[id]).filter(Boolean);
    const latestConversation = conversations[0];
    const activeJob = job && ["queued", "running"].includes(job.status);
    const jobNotice = job && ["queued", "running", "failed"].includes(job.status) ? `
      <div class="dtw-inspector-job ${job.status === "failed" ? "is-error" : ""}">
        <div><strong>${job.status === "failed" ? "整理失败" : "正在更新任务记忆"}</strong><span>${esc(job.status === "failed" ? job.error : (job.status === "queued" ? "等待前一个整理作业完成" : job.phase === "capture" ? "正在读取任务会话" : "正在等待 DeepSeek 返回"))}</span></div>
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
      <aside class="dtw-inspector" aria-label="${esc(task.name)}任务详情">
        <header class="dtw-inspector-header">
          <div><small>任务详情</small><h2>${esc(task.name)}</h2></div>
          <button type="button" data-action="close-task-panel" aria-label="关闭任务详情">×</button>
        </header>
        <div class="dtw-inspector-scroll">
          <div class="dtw-inspector-meta"><span class="dtw-memory-status ${status.className}">${esc(status.label)}</span><span>${conversations.length} 个会话</span>${memory.updatedAt ? `<time>${esc(new Date(memory.updatedAt).toLocaleString())}</time>` : ""}</div>
          ${jobNotice}
          ${memory.captureIncomplete ? '<p class="dtw-capture-warning">上次只整理了页面当时可读取的消息，未加载历史未计入。</p>' : ""}

          <section class="dtw-progress-card">
            <div class="dtw-progress-heading"><div><small>当前进度</small><strong>${progress.total ? `${progress.completed} / ${progress.total}` : "待拆解"}</strong></div><b>${progress.percent}%</b></div>
            <div class="dtw-progress-track"><i style="width:${progress.percent}%"></i></div>
            <div class="dtw-progress-stats"><span><b>${constraints}</b>约束</span><span><b>${decisions}</b>决定</span><span class="${blockers ? "has-blocker" : ""}"><b>${blockers}</b>阻塞</span></div>
          </section>

          <section class="dtw-inspector-editor">
            <div><h3>当前概况</h3><span>${memory.summary.length}/1500</span></div>
            <textarea data-memory-field="summary" maxlength="1500" placeholder="概括任务目标、当前状态和重要结论">${esc(memory.summary)}</textarea>
            <button type="button" data-action="save-memory-field" data-task-id="${esc(task.id)}" data-field="summary">保存概况</button>
          </section>

          <section class="dtw-inspector-editor is-next">
            <div><h3>下一步</h3><span>${memory.nextStep.length}/600</span></div>
            <textarea data-memory-field="nextStep" maxlength="600" placeholder="写下下一项明确、可执行的动作">${esc(memory.nextStep)}</textarea>
            <button type="button" data-action="save-memory-field" data-task-id="${esc(task.id)}" data-field="nextStep">保存下一步</button>
          </section>

          <section class="dtw-quick-actions">
            <button class="is-primary" type="button" data-action="update-memory" data-task-id="${esc(task.id)}" ${activeJob ? "disabled" : ""}>↻ DeepSeek 更新</button>
            <button type="button" data-action="add-task-item" data-task-id="${esc(task.id)}">＋ 添加记忆</button>
            <button type="button" data-action="copy-task-context" data-task-id="${esc(task.id)}">复制上下文</button>
            <button type="button" data-action="open-latest-task-conversation" data-task-id="${esc(task.id)}" ${latestConversation ? "" : "disabled"}>打开最近会话</button>
          </section>

          <div class="dtw-inspector-section-title"><h3>任务记忆</h3><small>${activeItems.length} 条有效</small></div>
          <div class="dtw-inspector-groups">${grouped || '<p class="dtw-inspector-empty">还没有结构化记忆。可人工添加，或让 DeepSeek 从任务会话中整理。</p>'}</div>

          <details class="dtw-inspector-conversations">
            <summary>任务会话 <span>${conversations.length}</span></summary>
            ${conversations.length ? conversations.map((conversation) => `<button type="button" data-action="open" data-id="${esc(conversation.id)}"><span>${esc(conversation.title)}</span><em>打开</em></button>`).join("") : '<p>暂无会话</p>'}
          </details>
          ${retiredItems.length ? `<details class="dtw-retired"><summary>已退役记忆（${retiredItems.length}）</summary>${retiredItems.map((item) => inspectorItemTemplate(task, item)).join("")}</details>` : ""}
        </div>
        <footer class="dtw-inspector-footer">
          <button type="button" data-action="facts-memory">用户事实</button>
          ${memory.history.length ? `<button type="button" data-action="undo-task-memory" data-task-id="${esc(task.id)}">撤销更新</button>` : ""}
          ${memory.version ? `<button type="button" data-action="rebuild-task-memory" data-task-id="${esc(task.id)}">从原文重建</button>` : ""}
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
            <div><small>跨任务记忆</small><h2>用户事实</h2></div>
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

  function memoryModalTemplate() {
    return memoryView === "facts" ? factsModalTemplate() : "";
  }

  function render(force = false) {
    const maintenanceIds = new Set(memoryState.maintenanceConversationIds);
    const unassigned = orderedConversations().filter((item) => !assignedTaskId(item.id) && !maintenanceIds.has(item.id));
    const renderKey = JSON.stringify([state, memoryState, visibleOrder, location.pathname, openMenuId, openTaskMenuId, nativeMode, memoryView]);
    if (!force && renderKey === lastRenderKey) return;
    lastRenderKey = renderKey;

    root.classList.toggle("is-native-mode", nativeMode);
    root.innerHTML = `
      <aside class="dtw-sidebar" aria-label="DeepSeek 任务列表">
        <header class="dtw-brand"><span class="dtw-brand-mark"></span><strong>deepseek</strong><button type="button" data-action="facts-memory">记忆 ${memoryState.userFacts.filter((fact) => fact.status !== "disabled").length}</button></header>
        <button class="dtw-new-chat" type="button" data-action="new-chat">＋ 开启新对话</button>
        <div class="dtw-toolbar">
          <label class="dtw-search"><span>⌕</span><input type="search" placeholder="搜索任务或会话" value="${esc(searchQuery)}"></label>
          <button class="dtw-add-task" type="button" data-action="new-task" title="新建任务">＋</button>
        </div>
        <div class="dtw-task-scroll">
          ${state.tasks.map(groupTemplate).join("")}
          <section class="dtw-task dtw-unassigned" data-filter="未分类">
            <div class="dtw-task-heading is-static"><span class="dtw-chevron">⌄</span><span class="dtw-task-name">未分类会话</span><small>${unassigned.length}</small></div>
            <div class="dtw-conversation-list">
              ${unassigned.length ? unassigned.map(conversationTemplate).join("") : '<p class="dtw-empty">所有会话都已整理</p>'}
            </div>
          </section>
        </div>
        <button class="dtw-native-toggle" type="button" data-action="native-mode">显示 DeepSeek 原版侧栏</button>
      </aside>
      <button class="dtw-return-tab" type="button" data-action="task-mode">任务列表</button>
      ${taskInspectorTemplate()}
      ${memoryModalTemplate()}
      <div class="dtw-toast" role="status"></div>`;
    applyFilter();
  }

  function applyFilter() {
    const query = searchQuery.trim().toLowerCase();
    for (const group of root.querySelectorAll(".dtw-task")) {
      const groupMatch = group.dataset.filter.includes(query);
      let visibleChildren = 0;
      for (const item of group.querySelectorAll(".dtw-conversation-wrap")) {
        const visible = !query || groupMatch || item.dataset.filter.includes(query);
        item.hidden = !visible;
        if (visible) visibleChildren += 1;
      }
      group.hidden = Boolean(query) && !groupMatch && visibleChildren === 0;
    }
  }

  function showToast(message, duration = 1600) {
    const toast = root.querySelector(".dtw-toast");
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("is-visible"), duration);
  }

  function setNativeMode(value) {
    nativeMode = value;
    nativeSidebar?.classList.toggle("dtw-native-sidebar-covered", !nativeMode);
    render(true);
  }

  function createTask(conversationId = "") {
    const name = prompt("任务名称")?.trim();
    if (!name) return;
    if (name.length > 80) return showToast("任务名称不能超过 80 个字符");
    if (state.tasks.some((task) => task.name === name)) return showToast("同名任务已存在");
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
    openMenuId = null;
    openTaskMenuId = null;
    saveState();
    render(true);
  }

  function renameTask(taskId) {
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task) return;
    const name = prompt("重命名任务", task.name)?.trim();
    if (!name || name === task.name) return;
    if (name.length > 80) return showToast("任务名称不能超过 80 个字符");
    if (state.tasks.some((item) => item.id !== taskId && item.name === name)) return showToast("同名任务已存在");
    task.name = name;
    openTaskMenuId = null;
    saveState();
    render(true);
  }

  function deleteTask(taskId) {
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task || !confirm(`删除任务“${task.name}”？\n其中的会话不会被删除，将回到未分类。`)) return;
    state.tasks = state.tasks.filter((item) => item.id !== taskId);
    delete memoryState.taskMemories[taskId];
    for (const job of Object.values(memoryState.jobs)) {
      if (job.taskId === taskId && ["queued", "running"].includes(job.status)) job.status = "cancelled";
    }
    if (state.selectedTaskId === taskId) state.selectedTaskId = "";
    openTaskMenuId = null;
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
    openMenuId = null;
    openTaskMenuId = null;
    saveState();
    saveMemoryState();
    render(true);
  }

  function openNativeConversationMenu(conversationId) {
    const nativeLink = [...document.querySelectorAll('a[href*="/chat/s/"]')]
      .find((link) => !root.contains(link) && idFromHref(link.href) === conversationId);
    openMenuId = null;
    setNativeMode(true);
    requestAnimationFrame(() => nativeLink?.querySelector('[role="button"], button')?.click());
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

  function openNewChat() {
    const label = [...document.querySelectorAll("span")].find((element) => !root.contains(element) && element.textContent.trim() === "开启新对话");
    let control = label;
    for (let depth = 0; depth < 4 && control; depth += 1) {
      if (control.matches?.("button, a, [role=button]")) return control.click();
      control = control.parentElement;
    }
    location.assign("https://chat.deepseek.com/a/chat");
  }

  function selectTask(taskId) {
    if (!state.tasks.some((task) => task.id === taskId)) return;
    state.selectedTaskId = taskId;
    memoryView = "";
    openMenuId = null;
    openTaskMenuId = null;
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
    openMenuId = null;
    openTaskMenuId = null;
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
    if (!globalThis.chrome?.runtime?.sendMessage) return;
    showToast("正在重新创建整理作业…", 2400);
    const result = await chrome.runtime.sendMessage({ type: "dtw:retry-memory-update", jobId });
    if (!result?.ok) showToast(result?.error || "重试失败", 4200);
  }

  function saveMemoryField(taskId, field, button) {
    if (!["summary", "nextStep"].includes(field)) return;
    const editor = button.closest(".dtw-inspector-editor");
    const value = editor?.querySelector(`[data-memory-field="${field}"]`)?.value.trim();
    if (value == null) return;
    const max = field === "summary" ? 1500 : 600;
    if (value.length > max) return showToast(`内容不能超过 ${max} 个字符`, 2600);
    const current = DTWMemory.normalizeTaskMemory(memoryState.taskMemories[taskId]);
    if (current[field] === value) return showToast("内容没有变化");
    commitManualTaskMemory(taskId, (memory) => { memory[field] = value; });
    showToast(field === "summary" ? "任务概况已保存" : "下一步已保存");
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

  root.addEventListener("input", (event) => {
    if (event.target.matches(".dtw-search input")) {
      searchQuery = event.target.value;
      applyFilter();
      return;
    }
    if (event.target.matches(".dtw-inspector-editor textarea")) {
      const counter = event.target.closest(".dtw-inspector-editor")?.querySelector("div > span");
      if (counter) counter.textContent = `${event.target.value.length}/${event.target.maxLength}`;
    }
  });

  root.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const { action, id, taskId, itemId, factId, jobId, field } = button.dataset;
    if (action === "close-memory" && button.classList.contains("dtw-modal-backdrop") && event.target !== button) return;
    if (action === "new-chat") openNewChat();
    else if (action === "new-task") createTask(id);
    else if (action === "open") openConversation(id);
    else if (action === "menu") { openMenuId = openMenuId === id ? null : id; openTaskMenuId = null; render(true); }
    else if (action === "task-menu") { openTaskMenuId = openTaskMenuId === taskId ? null : taskId; openMenuId = null; render(true); }
    else if (action === "move") moveConversation(id, taskId);
    else if (action === "remove") moveConversation(id, "");
    else if (action === "rename-task") renameTask(taskId);
    else if (action === "delete-task") deleteTask(taskId);
    else if (action === "toggle-task") toggleTask(taskId);
    else if (action === "select-task") selectTask(taskId);
    else if (action === "close-task-panel") closeTaskPanel();
    else if (action === "facts-memory") openFactsMemory();
    else if (action === "close-memory") closeMemory();
    else if (action === "update-memory") startMemoryUpdate(taskId);
    else if (action === "retry-memory") retryMemoryUpdate(jobId);
    else if (action === "save-memory-field") saveMemoryField(taskId, field, button);
    else if (action === "add-task-item") addTaskItem(taskId);
    else if (action === "edit-task-item") editTaskItem(taskId, itemId);
    else if (action === "pin-task-item") pinTaskItem(taskId, itemId);
    else if (action === "retire-task-item") retireTaskItem(taskId, itemId);
    else if (action === "advance-task-item") advanceTaskItem(taskId, itemId);
    else if (action === "copy-task-context") copyTaskContext(taskId);
    else if (action === "open-latest-task-conversation") openLatestTaskConversation(taskId);
    else if (action === "undo-task-memory") undoTaskMemory(taskId);
    else if (action === "rebuild-task-memory") rebuildTaskMemory(taskId);
    else if (action === "add-fact") addFact();
    else if (action === "edit-fact") editFact(factId);
    else if (action === "toggle-fact") toggleFact(factId);
    else if (action === "confirm-fact") confirmFact(factId);
    else if (action === "native-manage") openNativeConversationMenu(id);
    else if (action === "native-mode") setNativeMode(true);
    else if (action === "task-mode") setNativeMode(false);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && memoryView) closeMemory();
    else if (event.key === "Escape" && (openMenuId || openTaskMenuId)) {
      openMenuId = null;
      openTaskMenuId = null;
      render(true);
    } else if (event.key === "Escape" && state.selectedTaskId) closeTaskPanel();
  });

  async function scan() {
    scanQueued = false;
    const sidebar = findNativeSidebar();
    if (!sidebar) return;
    if (nativeSidebar && nativeSidebar !== sidebar) nativeSidebar.classList.remove("dtw-native-sidebar-covered");
    nativeSidebar = sidebar;
    const width = Math.round(sidebar.getBoundingClientRect().width);
    if (width) document.documentElement.style.setProperty("--dtw-sidebar-width", `${width}px`);
    sidebar.classList.toggle("dtw-native-sidebar-covered", !nativeMode);

    const found = collectConversations();
    visibleOrder = found.map((item) => item.id);
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
  }

  function scheduleScan() {
    if (scanQueued) return;
    scanQueued = true;
    requestAnimationFrame(scan);
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

  async function runMemorySummary(jobId, promptText) {
    let command = null;
    let applied = null;
    try {
      const editor = await waitForNativeEditor();
      const initialAssistantCount = document.querySelectorAll("div.ds-message").length;
      command = await armRequestBody("memory-summary", jobId, promptText);
      applied = waitForNetworkEvent("dtw:network-applied", command.requestId, 15000);
      setNativeEditorText(editor, `${command.marker}\n任务工作台正在更新任务记忆`);
      await submitNativeEditor(editor);
      await applied;
      const raw = await waitForSummaryResult(initialAssistantCount);
      await chrome.runtime.sendMessage({
        type: "dtw:memory-summary-result",
        jobId,
        raw,
        conversationId: idFromHref(location.href),
      });
    } catch (error) {
      if (command?.requestId) cancelRequestBody(command.requestId);
      applied?.catch(() => {});
      await chrome.runtime.sendMessage({
        type: "dtw:memory-summary-result",
        jobId,
        raw: "",
        error: error.message,
        conversationId: idFromHref(location.href),
      });
    }
  }

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
      return false;
    });
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
    document.body.appendChild(root);
    await scan();

    new MutationObserver((records) => {
      if (records.some((record) => !root.contains(record.target))) scheduleScan();
    }).observe(document.body, { childList: true, subtree: true });
    addEventListener("focus", scheduleScan);
    document.addEventListener("visibilitychange", scheduleScan);
    setInterval(scheduleScan, 1500); // ponytail: cheap sidebar rescan; replace only if profiling shows it matters.

    if (globalThis.chrome?.storage?.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local") return;
        if (changes[STORAGE_KEY]) state = cleanState(changes[STORAGE_KEY].newValue);
        if (changes[MEMORY_KEY]) memoryState = DTWMemory.normalizeStore(changes[MEMORY_KEY].newValue);
        if (changes[STORAGE_KEY] || changes[MEMORY_KEY]) render(true);
      });
    }
  }

  start().catch((error) => console.warn("[DeepSeek 任务工作台] 启动失败，保留原版页面：", error));
})();
