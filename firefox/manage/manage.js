(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const replaceChildren = (id, ...children) => DTWUI.replaceChildren($(id), ...children);
  let accountId = ""; let data = null; let scope = "PERSONAL"; let projectId = null;
  let loadRevision = 0; let editingCategory = null; let selectionMode = false;
  const selectedIds = new Set();
  const PROJECT_KINDS = ["目标", "约束", "决定", "进展", "阻塞", "下一步", "其他"];
  const PERSONAL_KINDS = ["资料", "偏好", "工作方式", "术语", "其他"];
  const kindsFor = () => scope === "PERSONAL" ? PERSONAL_KINDS : PROJECT_KINDS;
  const categoryFor = (memory) => kindsFor().includes(memory.kind) ? memory.kind : "其他";
  const call = async (type, body = {}, targetAccountId = accountId) => {
    const result = await browser.runtime.sendMessage({ type: `dtw:${type}`, accountId: targetAccountId, ...body });
    if (!result?.ok) throw new Error(result?.error || "操作失败");
    return result;
  };
  let noticeTimer;
  const notice = (text, error = false) => {
    clearTimeout(noticeTimer); $("notice").textContent = text; $("notice").className = error ? "error" : "";
    if (!error) noticeTimer = setTimeout(() => { $("notice").textContent = ""; }, 3000);
  };
  const selected = () => data.memories.filter((item) => item.scope === scope && (scope === "PERSONAL" || item.projectId === projectId))
    .sort((a, b) => Number(b.pinnedByUser) - Number(a.pinnedByUser)
      || Number(b.state === "ACTIVE") - Number(a.state === "ACTIVE")
      || a.content.localeCompare(b.content, "zh") || a.memoryId.localeCompare(b.memoryId));
  function renderSelection() {
    const memories = selected();
    $("selectAll").checked = memories.length > 0 && memories.every((memory) => selectedIds.has(memory.memoryId));
    $("selectAll").indeterminate = selectedIds.size > 0 && !$("selectAll").checked;
    $("deleteSelected").disabled = selectedIds.size === 0;
    replaceChildren("deleteSelected", `删除所选（${selectedIds.size}）`);
    replaceChildren("selectionCount", `当前范围 ${memories.length} 条`);
    document.querySelector(".memory-selection").hidden = !selectionMode;
  }
  const statusFor = (memory) => memory.state === "ACTIVE" ? "生效" : memory.budgetLimited ? "超出预算，已停用"
    : memory.disabledReason === "AUTO_REVIEW" ? "整理时停用" : memory.state === "DISABLED" ? "已停用"
      : memory.state === "STALE" ? "来源已变" : "待确认";
  function memoryEntry(memory) {
    const card = document.createElement("article"); card.className = "memory-entry";
    card.dataset.entryId = memory.memoryId;
    if (selectionMode) {
      card.classList.add("selectable");
      const checkbox = document.createElement("input"); checkbox.type = "checkbox";
      checkbox.checked = selectedIds.has(memory.memoryId); checkbox.setAttribute("aria-label", `选择记忆：${memory.content}`);
      checkbox.toggleAttribute("checked", checkbox.checked);
      checkbox.onchange = () => { checkbox.checked ? selectedIds.add(memory.memoryId) : selectedIds.delete(memory.memoryId); renderSelection(); };
      card.append(checkbox);
    }
    const content = document.createElement("p"); content.textContent = memory.content;
    card.append(content);
    if (memory.state !== "ACTIVE") {
      const status = document.createElement("span"); status.className = "memory-state"; status.textContent = statusFor(memory);
      card.append(status);
    }
    return card;
  }
  function renderGroupedMemories(memories) {
    const kinds = kindsFor();
    const sections = kinds.map((kind) => {
      const entries = memories.filter((memory) => categoryFor(memory) === kind);
      const section = document.createElement("section"); section.className = "card memory-group";
      const head = document.createElement("div"); head.className = "memory-group-head";
      const title = document.createElement("h3"); title.textContent = kind;
      const count = document.createElement("span"); count.className = "memory-group-count"; count.textContent = entries.length;
      title.append(count);
      const edit = document.createElement("button"); edit.className = "category-edit"; edit.textContent = "编辑";
      edit.setAttribute("aria-label", `编辑${kind}类别`); edit.onclick = () => editCategory(kind);
      head.append(title, edit); section.append(head);
      if (entries.length) {
        const list = document.createElement("div"); list.className = "memory-items";
        list.replaceChildren(...entries.map(memoryEntry));
        section.append(list);
      } else {
        const empty = document.createElement("p"); empty.className = "muted memory-empty";
        empty.textContent = "暂无内容"; section.append(empty);
      }
      return section;
    });
    replaceChildren("memories", ...sections);
  }
  function render() {
    const userProjects = data.projects.filter((project) => !project.systemKind)
      .sort((a, b) => Number(Boolean(a.archived)) - Number(Boolean(b.archived))
        || (b.updatedAtMs ?? b.createdAtMs ?? 0) - (a.updatedAtMs ?? a.createdAtMs ?? 0)
        || a.name.localeCompare(b.name, "zh"));
    if (projectId && !userProjects.some((project) => project.projectId === projectId)) { projectId = null; scope = "PERSONAL"; }
    replaceChildren("accountInfo", `数据账号：${accountId} · ${userProjects.length} 个项目`);
    replaceChildren("sourceInfo", data.legacyMigration?.status === "other-account"
      ? "旧版数据已归入此前使用的账号；请确认当前 DeepSeek 账号。"
      : data.legacyMigration?.status === "error" ? `旧版数据迁移失败：${data.legacyMigration.error}`
        : userProjects.length ? "" : "暂无项目");
    const scopes = [{ id: null, name: "个人记忆" }, ...userProjects
      .map((project) => ({ id: project.projectId, name: project.name, archived: project.archived }))];
    replaceChildren("scopes", ...scopes.map((item) => {
      const button = document.createElement("button");
      button.dataset.projectId = item.id || "";
      const count = item.id ? data.memories.filter((memory) => memory.scope === "PROJECT" && memory.projectId === item.id).length
        : data.memories.filter((memory) => memory.scope === "PERSONAL").length;
      button.textContent = `${item.name}（${count}）${item.archived ? " · 已归档" : ""}`;
      button.className = item.id === projectId ? "selected" : "";
      button.onclick = () => { selectedIds.clear(); selectionMode = false; projectId = item.id; scope = item.id ? "PROJECT" : "PERSONAL"; render(); };
      return button;
    }));
    replaceChildren("scopeTitle", scopes.find((item) => item.id === projectId)?.name || "个人记忆");
    const project = data.projects.find((item) => item.projectId === projectId);
    const queue = scope === "PERSONAL" ? data.projects.find((item) => item.systemKind === "PERSONAL") : project;
    const pending = scope === "PERSONAL" ? (queue?.pendingSessionRefs || []).filter((ref) => !ref.scopes || ref.scopes.includes("PERSONAL")).length
      : queue?.pendingSessionRefs?.length || 0;
    const activeJobs = data.jobs.filter((job) => ["DISTILL", "COMPACT"].includes(job.type)
      && (scope === "PERSONAL" ? job.memoryScope === "PERSONAL" : job.projectId === projectId)
      && ["QUEUED", "PENDING", "RUNNING"].includes(job.status));
    const running = activeJobs.length > 0;
    const progress = activeJobs.some((job) => job.status === "RUNNING")
      ? activeJobs.some((job) => job.status === "RUNNING" && (job.type === "COMPACT" || job.compressionInput)) ? "正在压缩个人记忆" : "正在整理" : "排队中";
    const budget = data.personalMemoryBudget;
    const budgetHint = budget && Number.isFinite(budget.used) && Number.isFinite(budget.limit)
      ? `记忆预算 ${budget.used}/${budget.limit} 字` : "记忆预算暂不可用，请重新加载插件";
    const details = scope === "PERSONAL"
      ? `保存跨会话通用的个人偏好与工作习惯。${budgetHint}。`
      : "保存本项目的目标、决定和进展，供后续会话参考。";
    const protection = data.memoryRecovery;
    const recoveryHint = protection
      ? `本地保留最近 ${protection.snapshotCount} 份记忆快照，可自动恢复异常丢失的条目。${protection.unavailable ? `${protection.unavailable} 条因来源变化未恢复。` : ""}`
      : "";
    DTWUI.setHelp($("scopeDetails"), `${details}可按类别编辑，固定条目受保护，批量删除在「更多」中。${recoveryHint}`);
    replaceChildren("scopeSummary", `${selected().length} 条记忆 · 待更新 ${pending} 个会话${running ? ` · ${progress}` : ""}`);
    $("distill").hidden = false;
    $("distill").disabled = running;
    const memories = selected();
    for (const id of selectedIds) if (!memories.some((memory) => memory.memoryId === id)) selectedIds.delete(id);
    renderGroupedMemories(memories); renderSelection();
  }
  async function load() {
    const revision = ++loadRevision;
    const currentAccountId = (await browser.storage.local.get("accountId")).accountId || "";
    if (!currentAccountId) throw new Error("请先打开并登录 DeepSeek 页面");
    const snapshot = await call("snapshot", {}, currentAccountId);
    if (revision !== loadRevision) return;
    if (accountId && accountId !== currentAccountId) {
      selectedIds.clear(); selectionMode = false; projectId = null; scope = "PERSONAL";
      $("memoryEditor").close(); editingCategory = null;
    }
    accountId = currentAccountId;
    data = snapshot; render();
  }
  function editorEntry(memory = null) {
    const row = document.createElement("div"); row.className = "category-editor-item";
    const label = document.createElement("label");
    const input = document.createElement("textarea"); input.rows = 3; input.maxLength = 3000;
    const index = $("categoryEntries").children.length + 1;
    input.id = `category-entry-${index}`; label.htmlFor = input.id;
    label.textContent = memory ? `记忆 ${index}${memory.state !== "ACTIVE" ? ` · ${statusFor(memory)}` : ""}` : "补充记忆（可留空）";
    input.value = memory?.content || ""; input.placeholder = "写下需要保留的内容";
    if (memory) input.dataset.memoryId = memory.memoryId;
    else input.oninput = () => {
      if (input.value.trim() && row === $("categoryEntries").lastElementChild && $("categoryEntries").children.length < 1000)
        $("categoryEntries").append(editorEntry());
    };
    row.append(label, input); return row;
  }
  function editCategory(kind) {
    const originals = selected().filter((memory) => categoryFor(memory) === kind);
    editingCategory = { accountId, scope, projectId, kind, originals };
    $("categoryEntries").replaceChildren();
    for (const memory of originals) $("categoryEntries").append(editorEntry(memory));
    $("categoryEntries").append(editorEntry());
    $("editorNotice").textContent = "";
    $("memoryEditorTitle").textContent = `编辑${kind}`;
    $("memoryEditor").showModal(); $("categoryEntries").querySelector("textarea").focus();
  }
  $("memoryForm").onsubmit = async (event) => {
    event.preventDefault();
    const editing = editingCategory; if (!editing) return;
    const entries = [...$("categoryEntries").querySelectorAll("textarea")].map((input) => ({ memoryId: input.dataset.memoryId || null, content: input.value.trim() }));
    const deleted = editing.originals.filter((memory) => !entries.some((entry) => entry.memoryId === memory.memoryId && entry.content));
    if (deleted.length && !confirm(`保存此类别将删除 ${deleted.length} 条已清空的记忆，此操作不可撤销。继续？`)) return;
    $("saveCategory").disabled = true; $("cancelEdit").disabled = true;
    try {
      if ((await browser.storage.local.get("accountId")).accountId !== editing.accountId) throw new Error("账号已切换，请重新打开类别");
      await call("memory-save-category", { scope: editing.scope, projectId: editing.projectId, kind: editing.kind,
        expected: editing.originals.map(({ memoryId, version }) => ({ memoryId, version })), entries }, editing.accountId);
      $("memoryEditor").close(); editingCategory = null; await load(); notice(`「${editing.kind}」已保存`);
    } catch (error) { $("editorNotice").className = "error"; $("editorNotice").textContent = error.message; }
    finally { $("saveCategory").disabled = false; $("cancelEdit").disabled = false; }
  };
  $("cancelEdit").onclick = () => { $("memoryEditor").close(); editingCategory = null; };
  $("memoryEditor").addEventListener("cancel", (event) => { if ($("saveCategory").disabled) event.preventDefault(); });
  $("manageSelection").onclick = () => { selectionMode = true; selectedIds.clear(); document.querySelector(".menu").open = false; render(); };
  $("cancelSelection").onclick = () => { selectionMode = false; selectedIds.clear(); render(); };
  $("selectAll").onchange = () => {
    selectedIds.clear();
    if ($("selectAll").checked) for (const memory of selected()) selectedIds.add(memory.memoryId);
    render();
  };
  $("deleteSelected").onclick = async () => {
    const memories = selected().filter((memory) => selectedIds.has(memory.memoryId));
    if (!memories.length || !confirm(`删除当前${scope === "PERSONAL" ? "个人" : "项目"}记忆中的 ${memories.length} 条（含 ${memories.filter((memory) => memory.pinnedByUser).length} 条固定记忆）？此操作不可撤销。`)) return;
    $("deleteSelected").disabled = true;
    try {
      const currentAccountId = (await browser.storage.local.get("accountId")).accountId;
      if (currentAccountId !== accountId) { await load(); throw new Error("账号已切换，请重新选择记忆"); }
      const result = await call("memory-delete-batch", { scope, projectId,
        memories: memories.map(({ memoryId, version }) => ({ memoryId, version })) });
      selectedIds.clear(); await load(); notice(`已删除 ${result.deleted} 条记忆`);
    } catch (error) { notice(error.message, true); }
    finally { renderSelection(); }
  };
  $("refresh").onclick = () => load().then(() => notice("已刷新项目和记忆"))
    .catch((error) => notice(error.message, true));
  $("distill").onclick = async () => {
    try {
      const result = scope === "PERSONAL" ? await call("memory-distill-personal")
        : await call("memory-distill-project", { projectId });
      await load(); notice(result.started ? `${result.queued ? "已排队整理" : "已开始整理"}${scope === "PERSONAL" ? "个人" : "项目"}记忆`
        : "已有更新任务，或没有已同步的旧会话；请刷新 DeepSeek 页面后重试");
    } catch (error) { notice(error.message, true); }
  };
  $("export").onclick = () => {
    const payload = { format: "dtw-memories-v1", exportedAtMs: Date.now(), projects: scope === "PROJECT" ? data.projects.filter((p) => p.projectId === projectId).map((p) => ({ projectId: p.projectId, name: p.name })) : [], memories: selected() };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = `deepseek-${scope === "PERSONAL" ? "personal" : "project"}-memories.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  };
  $("import").onclick = () => $("file").click();
  $("file").onchange = async () => {
    const file = $("file").files[0]; if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      if (payload.format !== "dtw-memories-v1" || !Array.isArray(payload.memories)) throw new Error("文件格式不正确");
      const map = {};
      for (const project of payload.projects || []) {
        const match = data.projects.find((item) => item.projectId === project.projectId)
          || data.projects.find((item) => item.name === project.name);
        if (match) map[project.projectId] = match.projectId;
      }
      const mapped = payload.memories.filter((item) => item.scope === "PERSONAL" || map[item.projectId]).length;
      const existing = new Set(data.memories.map((item) => item.memoryId));
      const duplicates = payload.memories.filter((item) => existing.has(item.memoryId)).length;
      const preview = `将导入 ${mapped - duplicates} 条；重复 ID ${duplicates} 条；未映射项目 ${payload.memories.length - mapped} 条。继续？`;
      if (!confirm(preview)) return;
      const result = await call("memory-import", { payload, projectMap: map });
      await load(); notice(`已导入 ${result.imported} 条，跳过 ${result.skipped} 条`);
    } catch (error) { notice(error.message, true); }
    finally { $("file").value = ""; }
  };
  load().catch((error) => notice(error.message, true));
  window.addEventListener("dtw-settings-changed", () => load().catch((error) => notice(error.message, true)));
  window.addEventListener("focus", () => load().catch((error) => notice(error.message, true)));
  setInterval(() => { if (!document.hidden && data) load().catch((error) => notice(error.message, true)); }, 10000);
})();
