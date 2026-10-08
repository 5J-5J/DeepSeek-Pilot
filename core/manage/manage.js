(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  let accountId = ""; let data = null; let scope = "PERSONAL"; let projectId = null;
  let loadRevision = 0; let editingMemory = null;
  const PROJECT_KINDS = ["目标", "约束", "决定", "进展", "阻塞", "下一步", "其他"];
  const PERSONAL_KINDS = ["资料", "偏好", "工作方式", "术语", "其他"];
  const call = async (type, body = {}, targetAccountId = accountId) => {
    const result = await chrome.runtime.sendMessage({ type: `dtw:${type}`, accountId: targetAccountId, ...body });
    if (!result?.ok) throw new Error(result?.error || "操作失败");
    return result;
  };
  const notice = (text, error = false) => { $("notice").textContent = text; $("notice").className = error ? "error" : ""; };
  const selected = () => data.memories.filter((item) => item.scope === scope && (scope === "PERSONAL" || item.projectId === projectId))
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  function memoryEntry(memory, grouped = false) {
    const card = document.createElement("article"); card.className = grouped ? "memory-entry" : "card memory";
    const top = document.createElement("div"); top.className = "memory-entry-top";
    if (!grouped || (memory.kind !== "其他" && !PROJECT_KINDS.includes(memory.kind))) {
      const kind = document.createElement("strong"); kind.textContent = memory.kind; top.append(kind);
    }
    const status = document.createElement("span"); status.className = "muted";
    status.textContent = `${memory.state === "ACTIVE" ? "生效" : memory.state === "DISABLED" ? "已停用" : memory.state === "STALE" ? "来源已变" : "待确认"}${memory.pinnedByUser ? " · 人工固定" : ""}`;
    top.append(status);
    const content = document.createElement("p"); content.textContent = memory.content;
    const actions = document.createElement("div"); actions.className = "actions";
    for (const [label, fn] of [
      ["编辑", () => edit(memory)],
      [memory.state === "ACTIVE" ? "停用" : "启用", () => save({ ...memory, state: memory.state === "ACTIVE" ? "DISABLED" : "ACTIVE" })],
      [memory.pinnedByUser ? "取消固定" : "固定", () => save({ ...memory, pinnedByUser: !memory.pinnedByUser })],
    ]) { const button = document.createElement("button"); button.textContent = label; button.onclick = fn; actions.append(button); }
    card.append(top, content, actions); return card;
  }
  function renderProjectMemories(memories, pending) {
    const sections = PROJECT_KINDS.map((kind) => {
      const entries = memories.filter((memory) => PROJECT_KINDS.includes(memory.kind) ? memory.kind === kind : kind === "其他");
      const section = document.createElement("section"); section.className = "card memory-group";
      const head = document.createElement("div"); head.className = "memory-group-head";
      const title = document.createElement("h3"); title.textContent = `${kind}（${entries.length}）`;
      const add = document.createElement("button"); add.textContent = "＋ 添加"; add.setAttribute("aria-label", `添加${kind}记忆`);
      add.onclick = () => edit(null, kind);
      head.append(title, add); section.append(head);
      if (entries.length) {
        const list = document.createElement("div"); list.className = "memory-items";
        list.replaceChildren(...entries.map((memory) => memoryEntry(memory, true)));
        section.append(list);
      } else {
        const empty = document.createElement("p"); empty.className = "muted memory-empty";
        empty.textContent = "暂无记忆"; section.append(empty);
      }
      return section;
    });
    const intro = document.createElement("p"); intro.className = "hint";
    intro.textContent = memories.length ? "项目记忆按固定类别整理；每类可保存多条。"
      : `这个项目还没有记忆。${pending
        ? "可以点击「立即整理待更新轮次」。" : "项目内完成的问答会按设置的轮数自动整理。"}`;
    $("memories").replaceChildren(intro, ...sections);
  }
  function render() {
    const userProjects = data.projects.filter((project) => !project.systemKind)
      .sort((a, b) => a.name.localeCompare(b.name, "zh"));
    if (projectId && !userProjects.some((project) => project.projectId === projectId)) { projectId = null; scope = "PERSONAL"; }
    $("accountInfo").textContent = `数据账号：${accountId} · ${userProjects.length} 个项目`;
    $("sourceInfo").textContent = data.legacyMigration?.status === "other-account"
      ? "旧版数据已归入此前使用的账号；请确认当前 DeepSeek 账号。"
      : data.legacyMigration?.status === "error" ? `旧版数据迁移失败：${data.legacyMigration.error}`
        : userProjects.length ? "" : "当前账号还没有项目。请在 DeepSeek 页面创建项目。";
    const scopes = [{ id: null, name: "个人记忆" }, ...userProjects
      .map((project) => ({ id: project.projectId, name: project.name }))];
    $("scopes").replaceChildren(...scopes.map((item) => {
      const button = document.createElement("button");
      const count = item.id ? data.memories.filter((memory) => memory.scope === "PROJECT" && memory.projectId === item.id).length
        : data.memories.filter((memory) => memory.scope === "PERSONAL").length;
      button.textContent = `${item.name}（${count}）`;
      button.className = item.id === projectId ? "selected" : "";
      button.onclick = () => { projectId = item.id; scope = item.id ? "PROJECT" : "PERSONAL"; render(); };
      return button;
    }));
    $("scopeTitle").textContent = scopes.find((item) => item.id === projectId)?.name || "个人记忆";
    const project = data.projects.find((item) => item.projectId === projectId);
    const queue = scope === "PERSONAL" ? data.projects.find((item) => item.systemKind === "PERSONAL") : project;
    const pending = queue?.pendingTurnRefs?.length || 0;
    const projectSessions = data.memberships.filter((item) => item.projectId === projectId);
    const enabledSessions = projectSessions.filter((item) => item.memoryModeEnabled).length;
    const personalSessions = data.sessions.filter((item) => item.purpose === "USER" && !item.deleted).length;
    const lastPersonalJob = data.jobs.filter((job) => job.type === "DISTILL" && job.memoryScope === "PERSONAL")
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs)[0];
    const personalResult = lastPersonalJob?.status === "DONE"
      ? ` · 上次整理${lastPersonalJob.result?.count ? `新增 ${lastPersonalJob.result.count} 条` : "没有新增事实"}`
      : ["FAILED", "NEEDS_REVIEW"].includes(lastPersonalJob?.status) ? " · 上次整理未完成（见设置页）" : "";
    const running = data.jobs.some((job) => job.type === "DISTILL"
      && (scope === "PERSONAL" ? job.memoryScope === "PERSONAL" : job.projectId === projectId)
      && ["PENDING", "RUNNING"].includes(job.status));
    $("scopeHint").textContent = scope === "PERSONAL"
      ? `普通会话 ${personalSessions} 个（含未归项目）· 每 ${data.settings.distillEveryTurns} 轮自动整理 · 待整理 ${pending} 轮${running ? " · 正在整理" : ""}${personalResult}`
      : `项目内 ${projectSessions.length} 个会话参与自动整理 · 每 ${data.settings.distillEveryTurns} 轮更新 · 待整理 ${pending} 轮${running ? " · 正在整理" : ""} · ${enabledSessions} 个会话发送时带入记忆`;
    $("distill").hidden = running || (scope === "PERSONAL" && pending === 0);
    const memories = selected();
    if (scope === "PROJECT") renderProjectMemories(memories, pending);
    else {
      $("memories").replaceChildren(...memories.map((memory) => memoryEntry(memory)));
      if (!memories.length) $("memories").textContent = `这里还没有个人记忆。${pending
        ? "可以点击「立即整理待更新轮次」。" : personalSessions
          ? "普通会话达到设置的轮数后会自动整理；只有明确且稳定的个人事实会被保存。"
          : "登录 DeepSeek 并完成普通对话后会自动检查。"}`;
    }
  }
  async function load() {
    const revision = ++loadRevision;
    const currentAccountId = (await chrome.storage.local.get("accountId")).accountId || "";
    if (!currentAccountId) throw new Error("请先打开并登录 DeepSeek 页面");
    const snapshot = await call("snapshot", {}, currentAccountId);
    if (revision !== loadRevision) return;
    if (accountId && accountId !== currentAccountId) { projectId = null; scope = "PERSONAL"; }
    accountId = currentAccountId;
    data = snapshot; render();
  }
  async function save(memory) { try { await call("memory-save", { memory }); await load(); notice("已保存"); return true; } catch (error) { notice(error.message, true); return false; } }
  function edit(memory = null, category = null) {
    editingMemory = memory;
    const kinds = scope === "PROJECT" ? PROJECT_KINDS : PERSONAL_KINDS;
    $("memoryKind").replaceChildren(...kinds.map((kind) => {
      const option = document.createElement("option"); option.value = kind; option.textContent = kind; return option;
    }));
    const previousKind = category || memory?.kind;
    $("memoryKind").value = kinds.includes(previousKind) ? previousKind
      : memory ? "其他" : scope === "PROJECT" ? "目标" : "偏好";
    $("memoryContent").value = memory?.content || "";
    $("memoryEditorTitle").textContent = memory ? "编辑记忆" : "新增记忆";
    $("memoryEditor").showModal();
    $("memoryContent").focus();
  }
  $("memoryForm").onsubmit = async (event) => {
    event.preventDefault();
    const content = $("memoryContent").value.trim();
    if (!content) return;
    const saved = await save({ ...editingMemory, scope, projectId, kind: $("memoryKind").value,
      content, state: editingMemory?.state || "ACTIVE", pinnedByUser: editingMemory?.pinnedByUser ?? true });
    if (saved) $("memoryEditor").close();
  };
  $("cancelEdit").onclick = () => $("memoryEditor").close();
  $("add").onclick = () => edit();
  $("refresh").onclick = () => load().then(() => notice("已刷新项目和记忆"))
    .catch((error) => notice(error.message, true));
  $("distill").onclick = async () => {
    try {
      const result = scope === "PERSONAL" ? await call("memory-distill-personal")
        : await call("memory-distill-project", { projectId });
      await load(); notice(result.started ? `已开始整理${scope === "PERSONAL" ? "个人" : "项目"}记忆`
        : "已有整理作业运行，或当前没有已同步的完整问答；请刷新 DeepSeek 页面后重试");
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
  window.addEventListener("focus", () => load().catch((error) => notice(error.message, true)));
  setInterval(() => { if (!document.hidden && data) load().catch((error) => notice(error.message, true)); }, 10000);
})();
