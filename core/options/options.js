(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  let accountId = "";
  let savedSettings = null;
  let openingManage = null;
  const call = async (type, body = {}) => {
    const result = await chrome.runtime.sendMessage({ type: `dtw:${type}`, accountId, ...body });
    if (!result?.ok) throw new Error(result?.error || "操作失败");
    return result;
  };
  function notice(text, error = false) { $("notice").textContent = text; $("notice").className = error ? "error" : ""; }
  function selectValue(field, value) {
    const select = $(field);
    select.querySelector("option[data-custom]")?.remove();
    const current = String(value);
    if (![...select.options].some((option) => option.value === current)) {
      const option = new Option(`当前自定义值 · ${current}`, current);
      option.dataset.custom = "true";
      select.add(option);
    }
    select.value = current;
  }
  const turnLabels = { 1: "频繁", 3: "较频繁", 5: "适中 · 默认", 10: "较少", 20: "很少", 30: "最少" };
  for (let turns = 1; turns <= 30; turns++)
    $("distillEveryTurns").add(new Option(`${turnLabels[turns] ? `${turnLabels[turns]} · ` : ""}每 ${turns} 轮`, String(turns)));
  $("distillEveryTurns").value = "5";
  $("openManage").addEventListener("click", (event) => {
    event.preventDefault();
    if (openingManage) return;
    openingManage = (async () => {
      const url = chrome.runtime.getURL("manage/manage.html");
      const existing = (await chrome.tabs.query({})).find((tab) => tab.url === url);
      if (existing?.id != null) {
        await chrome.tabs.update(existing.id, { active: true });
        if (existing.windowId != null) await chrome.windows.update(existing.windowId, { focused: true });
      } else await chrome.tabs.create({ url, active: true });
    })().catch((error) => notice(`打开记忆管理失败：${error.message}`, true))
      .finally(() => { openingManage = null; });
  });
  async function load() {
    accountId = (await chrome.storage.local.get("accountId")).accountId || "";
    if (!accountId) { notice("请先打开并登录 DeepSeek 页面。", true); return; }
    const data = await call("snapshot");
    savedSettings = data.settings;
    $("accountInfo").textContent = `数据账号：${accountId}`;
    for (const field of ["maxContextTokens", "warningRatio", "replyReserveTokens", "distillEveryTurns"])
      selectValue(field, data.settings[field]);
    $("memoryModeDefault").checked = data.settings.memoryModeDefault;
    if (data.legacyMigration?.status === "error") notice(`旧版数据迁移失败：${data.legacyMigration.error}`, true);
    const archived = data.projects.filter((project) => project.archived && !project.systemKind);
    $("archived").replaceChildren(...archived.map((project) => {
      const row = document.createElement("div"); row.className = "row";
      const name = document.createElement("span"); name.textContent = project.name;
      const button = document.createElement("button"); button.textContent = "恢复";
      button.onclick = async () => { try { await call("project-update", { projectId: project.projectId, archived: false }); await load(); } catch (error) { notice(error.message, true); } };
      row.append(name, button); return row;
    }));
    if (!archived.length) $("archived").textContent = "暂无归档项目";
    const jobs = data.jobs.filter((job) => ["NEEDS_REVIEW", "FAILED"].includes(job.status));
    $("jobs").replaceChildren(...jobs.map((job) => {
      const row = document.createElement("div"); row.className = "row wrap";
      const name = document.createElement("strong");
      const jobName = job.type === "DISTILL" ? (job.memoryScope === "PERSONAL" ? "个人记忆整理" : "项目记忆整理")
        : ({ CLASSIFY: "自动归类", SEND: "消息发送", ROLLOVER: "会话接续" })[job.type] || job.type;
      name.textContent = `${jobName} · ${job.status === "FAILED" ? "失败" : "需要核对"}`;
      const session = data.sessions.find((item) => item.sessionId === job.sourceSessionId);
      const source = document.createElement("span"); source.textContent = `来源会话：${session?.title || job.sourceSessionId || "未知"}`;
      const detail = document.createElement("span");
      detail.textContent = job.result?.reason || job.error || (job.result?.choice === "NEW"
        ? `待确认新项目：${job.result.suggestedName}` : job.rawInput || "请在 DSW 历史核对该作业");
      row.append(name, source, detail);
      if (["SEND", "ROLLOVER"].includes(job.type) && job.rawInput) {
        const draft = document.createElement("textarea");
        draft.className = "draft-input"; draft.readOnly = true; draft.value = job.rawInput;
        draft.setAttribute("aria-label", "原始草稿");
        const hint = document.createElement("span"); hint.className = "muted";
        hint.textContent = "先核对 DeepSeek 历史，再决定是否重新发送。";
        const copy = document.createElement("button"); copy.textContent = "复制原始草稿";
        copy.onclick = async () => {
          try { await navigator.clipboard.writeText(job.rawInput); notice("原始草稿已复制"); }
          catch (error) { draft.focus(); draft.select(); notice(`复制失败，请手动复制：${error.message}`, true); }
        };
        row.append(hint, draft, copy);
      }
      if (job.type === "CLASSIFY" && job.result?.choice !== "NEW") {
        const actions = document.createElement("div"); actions.className = "actions";
        for (const [label, action] of [["重新归类", "classification-retry"], ["忽略提醒", "classification-dismiss"]]) {
          const button = document.createElement("button"); button.textContent = label;
          button.onclick = async () => {
            button.disabled = true;
            try { await call(action, { jobId: job.jobId }); await load(); notice(action === "classification-retry" ? "已重新启动归类" : "已忽略归类提醒"); }
            catch (error) { notice(error.message, true); button.disabled = false; }
          };
          actions.append(button);
        }
        row.append(actions);
      }
      if (job.type === "DISTILL" && ["FAILED", "NEEDS_REVIEW"].includes(job.status) && job.sourceSessionId) {
        const retry = document.createElement("button"); retry.textContent = "重试记忆整理";
        retry.onclick = async () => {
          retry.disabled = true;
          try {
            const result = job.memoryScope === "PERSONAL" ? await call("memory-distill-personal")
              : await call("memory-distill-current", { sessionId: job.sourceSessionId });
            await load(); notice(result.started ? "已重新启动记忆整理" : "当前没有可整理的完整问答");
          } catch (error) { notice(error.message, true); retry.disabled = false; }
        };
        row.append(retry);
      }
      return row;
    }));
    if (!jobs.length) $("jobs").textContent = "暂无待核对作业";
  }
  $("save").onclick = async () => {
    const button = $("save");
    button.disabled = true;
    try {
      const currentAccountId = (await chrome.storage.local.get("accountId")).accountId || "";
      if (!currentAccountId || currentAccountId !== accountId) {
        await load(); throw new Error("DeepSeek 账号已切换，请检查设置后再保存");
      }
      for (const field of ["maxContextTokens", "warningRatio", "replyReserveTokens", "distillEveryTurns"]) {
        const value = Number($(field).value);
        if (value !== savedSettings?.[field]) {
          await call("settings-update", { key: field, value });
          savedSettings[field] = value;
        }
      }
      const memoryModeDefault = $("memoryModeDefault").checked;
      if (memoryModeDefault !== savedSettings?.memoryModeDefault) {
        await call("settings-update", { key: "memoryModeDefault", value: memoryModeDefault });
        savedSettings.memoryModeDefault = memoryModeDefault;
      }
      notice("设置已保存"); await load();
    } catch (error) { notice(error.message, true); }
    finally { button.disabled = false; }
  };
  load().catch((error) => notice(error.message, true));
  window.addEventListener("focus", async () => {
    try {
      if ((await chrome.storage.local.get("accountId")).accountId !== accountId) await load();
    } catch (error) { notice(error.message, true); }
  });
})();
