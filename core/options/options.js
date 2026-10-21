(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const replaceChildren = (id, ...children) => DTWUI.replaceChildren($(id), ...children);
  let accountId = "";
  let savedSettings = null;
  let queuePaused = false; let queueLoading = false;
  const jobName = (job) => job.type === "DISTILL" ? (job.memoryScope === "PERSONAL" ? "个人记忆整理" : "项目记忆整理")
    : ({ CLASSIFY: "自动归类", COMPACT: "个人记忆压缩", SEND: "消息发送", ROLLOVER: "会话接续", CLEANUP: "自动化会话清理" })[job.type] || job.type;
  const localDateInput = (timestamp) => {
    const date = new Date(timestamp);
    return Number.isFinite(date.getTime()) ? new Date(timestamp - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19) : "";
  };
  const call = async (type, body = {}) => {
    const result = await chrome.runtime.sendMessage({ type: `dtw:${type}`, accountId, ...body });
    if (!result?.ok) throw new Error(result?.error || "操作失败");
    return result;
  };
  let noticeTimer;
  function notice(text, error = false) {
    clearTimeout(noticeTimer); $("settingsNotice").textContent = text; $("settingsNotice").className = error ? "error" : "";
    if (!error) noticeTimer = setTimeout(() => { $("settingsNotice").textContent = ""; }, 3000);
  }
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
  async function queueAction(task) {
    try {
      if ((await chrome.storage.local.get("accountId")).accountId !== accountId) {
        await load(); throw new Error("账号已切换，请重新检查队列");
      }
      await task(); await refreshQueue(); notice("队列已更新");
    } catch (error) { notice(error.message, true); }
  }
  function batchDetails(job, data) {
    if (job.type === "COMPACT" || job.compressionInput) return `个人记忆达到上限 · AI 压缩至约 ${Math.floor((data.personalMemoryBudget?.limit ?? 5000) * 0.8)} 字 · 保留关键事实和固定条目`;
    if (job.type !== "DISTILL") return "";
    const project = data.projects.find((item) => item.projectId === job.projectId);
    const range = job.memoryScope === "PERSONAL" ? "个人记忆" : `项目记忆${project?.name ? `（${project.name}）` : ""}`;
    const retry = `${job.attempt > 1 ? `第 ${job.attempt - 1} 次重试` : "首次整理"}${job.savedFromCache ? ` · ${job.status === "QUEUED" ? "等待复用上次结果保存" : "复用上次结果保存"}` : ""}`;
    return `1 个会话 · 更新：${range} · ${retry}`;
  }
  function renderQueue(data) {
    const issue = data.alerts?.issue;
    const unfinished = data.jobs.filter((job) => ["FAILED", "NEEDS_REVIEW"].includes(job.status)).length;
    $("automationAlert").hidden = !issue && !unfinished;
    replaceChildren("automationAlertTitle", issue ? "插件请求已暂停" : `${unfinished} 个任务未完成`);
    replaceChildren("automationAlertDetail", issue?.message || "这些任务已跳过，其他任务继续按顺序执行。请在下方核对、重试或忽略。");
    $("viewIssues").hidden = !unfinished;
    $("resumeRequests").hidden = issue?.code !== "ACCOUNT_RESTRICTED";
    queuePaused = Boolean(data.settings.automationPaused);
    replaceChildren("pauseQueue", queuePaused ? "继续队列" : "暂停队列");
    const all = data.jobs.filter((job) => ["CLASSIFY", "DISTILL", "COMPACT", "ROLLOVER"].includes(job.type));
    const queued = all.filter((job) => job.status === "QUEUED").sort((a, b) =>
      (a.queueOrder ?? a.createdAtMs) - (b.queueOrder ?? b.createdAtMs) || a.jobId.localeCompare(b.jobId));
    const running = all.filter((job) => ["PENDING", "RUNNING"].includes(job.status));
    replaceChildren("queueSummary", `${queuePaused ? "已暂停" : "运行中"} · ${running.length} 个执行中 · ${queued.length} 个等待 · ${all.filter((job) => ["FAILED", "NEEDS_REVIEW"].includes(job.status)).length} 个需处理（见下方）`);
    const rowFor = (job, index = -1) => {
      const row = document.createElement("div"); row.className = "row wrap";
      row.dataset.jobId = job.jobId; row.dataset.accountId = accountId;
      row.dataset.tabId = String(job.tabId ?? "");
      const title = document.createElement("strong");
      title.textContent = `${index >= 0 ? `等待 ${index + 1} · ` : ""}${jobName(job)} · ${({ RUNNING: "执行中", PENDING: "待启动", DONE: "完成", CANCELLED: "已取消", DISMISSED: "已忽略", QUEUED: "排队中", FAILED: "失败", NEEDS_REVIEW: "需要核对" })[job.status] || job.status}`;
      const detail = document.createElement("span"); detail.className = "muted";
      const project = data.projects.find((item) => item.projectId === job.projectId);
      const session = data.sessions.find((item) => item.sessionId === job.sourceSessionId);
      detail.textContent = `${project?.name ? `${project.name} · ` : ""}${session?.title || job.sourceSessionId || "无来源会话"}${job.phase ? ` · ${({ WAITING_REPLY: "等待回复" })[job.phase] || job.phase}` : ""}`;
      detail.title = `入队 ${new Date(job.createdAtMs).toLocaleString("zh-CN")}`;
      row.append(title, detail);
      if (["DISTILL", "COMPACT"].includes(job.type)) {
        const batch = document.createElement("span"); batch.className = "muted queue-batch";
        batch.textContent = batchDetails(job, data); row.append(batch);
      }
      const actions = document.createElement("div"); actions.className = "actions";
      if (index >= 0) {
        for (const [action, label, disabled] of [["up", "上移", index === 0], ["down", "下移", index === queued.length - 1], ["cancel", "取消", false]]) {
          const button = document.createElement("button"); button.textContent = label; button.disabled = disabled || (job.type === "DISTILL" && action !== "cancel");
          if (action === "cancel") button.className = "danger";
          button.onclick = () => {
            if (action === "cancel" && !confirm(`取消「${jobName(job)}」？${job.type === "DISTILL" ? "该会话本次更新将跳过，已有记忆保留。" : ""}`)) return;
            button.disabled = true;
            queueAction(() => call("job-queue-update", { jobId: job.jobId, action })).finally(() => { button.disabled = disabled || (job.type === "DISTILL" && action !== "cancel"); });
          };
          actions.append(button);
        }
      } else if (job.status === "RUNNING" && Number.isInteger(job.tabId)) {
        const open = document.createElement("button"); open.textContent = "查看运行会话";
        open.onclick = () => chrome.tabs.update(job.tabId, { active: true }).catch((error) => notice(error.message, true));
        actions.append(open);
      }
      row.append(actions); return row;
    };
    replaceChildren("automationQueue", ...(!running.length && !queued.length ? ["当前没有等待或运行中的自动化任务"]
      : [...running.map((job) => rowFor(job)), ...queued.map(rowFor)]));
    replaceChildren("queueHistory", ...all.filter((job) => ["DONE", "CANCELLED", "DISMISSED"].includes(job.status))
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs).slice(0, 10).map((job) => rowFor(job)));
  }
  async function refreshQueue() {
    if (queueLoading || !accountId) return;
    queueLoading = true;
    try {
      const target = accountId;
      const data = await call("snapshot");
      if (target === accountId) { renderQueue(data); renderReviewJobs(data); }
    } finally { queueLoading = false; }
  }
  $("pauseQueue").onclick = () => queueAction(() => call("settings-update", { key: "automationPaused", value: !queuePaused }));
  $("viewIssues").onclick = () => $("jobs").scrollIntoView({ behavior: "smooth", block: "center" });
  $("resumeRequests").onclick = () => queueAction(() => call("request-resume"));
  $("refreshQueue").onclick = () => refreshQueue().catch((error) => notice(error.message, true));
  async function load() {
    accountId = (await chrome.storage.local.get("accountId")).accountId || "";
    if (!accountId) { notice("请先打开并登录 DeepSeek 页面。", true); return; }
    const data = await call("snapshot");
    savedSettings = data.settings;
    $("memoryStartAtMs").value = localDateInput(data.settings.memoryStartAtMs);
    renderQueue(data);
    $("settingsAccountInfo").textContent = `数据账号：${accountId}`;
    for (const field of ["maxContextTokens", "warningRatio", "replyReserveTokens"])
      selectValue(field, data.settings[field]);
    $("memoryModeDefault").checked = data.settings.memoryModeDefault;
    $("showPersonalMemory").checked = data.settings.showPersonalMemory;
    $("showProjectMemory").checked = data.settings.showProjectMemory;
    $("showMessageTokens").checked = data.settings.showMessageTokens;
    $("showAutomationSessions").checked = data.settings.showAutomationSessions;
    if (data.legacyMigration?.status === "error") notice(`旧版数据迁移失败：${data.legacyMigration.error}`, true);
    const archived = data.projects.filter((project) => project.archived && !project.systemKind)
      .sort((a, b) => (b.updatedAtMs ?? b.createdAtMs ?? 0) - (a.updatedAtMs ?? a.createdAtMs ?? 0)
        || a.name.localeCompare(b.name, "zh"));
    $("archived").replaceChildren(...archived.map((project) => {
      const row = document.createElement("div"); row.className = "row";
      const name = document.createElement("span"); name.textContent = project.name;
      const button = document.createElement("button"); button.textContent = "恢复";
      button.onclick = async () => { try { await call("project-update", { projectId: project.projectId, archived: false }); await load(); window.dispatchEvent(new Event("dtw-settings-changed")); } catch (error) { notice(error.message, true); } };
      row.append(name, button); return row;
    }));
    if (!archived.length) $("archived").textContent = "暂无归档项目";
    renderReviewJobs(data);
  }
  function renderReviewJobs(data) {
    const jobs = data.jobs.filter((job) => ["NEEDS_REVIEW", "FAILED"].includes(job.status))
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs);
    const rows = jobs.map((job) => {
      const row = document.createElement("div"); row.className = "row wrap";
      row.dataset.jobId = job.jobId; row.dataset.accountId = accountId;
      const name = document.createElement("strong");
      name.textContent = `${jobName(job)} · ${job.status === "FAILED" ? "失败" : "需要核对"}`;
      const session = data.sessions.find((item) => item.sessionId === job.sourceSessionId);
      const source = document.createElement("span"); source.textContent = `来源会话：${session?.title || job.sourceSessionId || "未知"}`;
      const detail = document.createElement("span");
      detail.textContent = job.result?.reason || job.error || (job.result?.choice === "NEW"
        ? `待确认新项目：${job.result.suggestedName}` : job.rawInput || "请在 DSW 历史核对该任务");
      row.append(name, source, detail);
      if (["DISTILL", "COMPACT"].includes(job.type)) {
        const batch = document.createElement("span"); batch.className = "muted queue-batch";
        batch.textContent = batchDetails(job, data); row.append(batch);
      }
      const actions = document.createElement("div"); actions.className = "actions";
      if (["SEND", "ROLLOVER"].includes(job.type) && job.rawInput) {
        const draft = document.createElement("textarea");
        draft.className = "draft-input"; draft.readOnly = true; draft.defaultValue = job.rawInput;
        draft.setAttribute("aria-label", "原始草稿");
        const copy = document.createElement("button"); copy.textContent = "复制原始草稿";
        copy.onclick = async () => {
          try { await navigator.clipboard.writeText(job.rawInput); notice("原始草稿已复制"); }
          catch (error) { draft.focus(); draft.select(); notice(`复制失败，请手动复制：${error.message}`, true); }
        };
        row.append(draft); actions.append(copy);
      }
      if (job.type === "CLASSIFY" && job.result?.choice !== "NEW") {
        const retry = document.createElement("button"); retry.textContent = "重新归类";
        retry.onclick = async () => {
          retry.disabled = true;
          try { await call("classification-retry", { jobId: job.jobId }); await load(); notice("已重新启动归类"); }
          catch (error) { notice(error.message, true); retry.disabled = false; }
        };
        actions.append(retry);
      }
      if (["DISTILL", "COMPACT"].includes(job.type) && ["FAILED", "NEEDS_REVIEW"].includes(job.status) && (job.sourceSessionId || job.type === "COMPACT")) {
        const retry = document.createElement("button"); retry.textContent = job.type === "COMPACT" || job.compressionInput ? "重试个人记忆压缩" : "重试记忆整理";
        retry.onclick = async () => {
          retry.disabled = true;
          try {
            const result = await call("memory-job-retry", { jobId: job.jobId });
            await load(); notice(result.cached ? "已使用上次结果保存记忆，无需再次请求模型" : result.started ? (result.queued ? "记忆整理已排队" : "已重新启动记忆整理")
              : "当前没有可整理的完整问答");
          } catch (error) { notice(error.message, true); retry.disabled = false; }
        };
        actions.append(retry);
      }
      const ignore = document.createElement("button"); ignore.textContent = "忽略";
      ignore.onclick = async () => {
        ignore.disabled = true;
        try { await call("job-dismiss", { jobId: job.jobId }); await load(); notice("已忽略任务"); }
        catch (error) { notice(error.message, true); ignore.disabled = false; }
      };
      actions.prepend(ignore); row.append(actions);
      return row;
    });
    replaceChildren("jobs", ...(rows.length ? rows : ["暂无待核对任务"]));
  }
  const checkboxSettings = ["memoryModeDefault", "showPersonalMemory", "showProjectMemory", "showMessageTokens", "showAutomationSessions"];
  for (const key of ["maxContextTokens", "warningRatio", "replyReserveTokens", "memoryStartAtMs", ...checkboxSettings]) {
    $(key).addEventListener("change", async () => {
      const input = $(key);
      const value = checkboxSettings.includes(key) ? input.checked
        : key === "memoryStartAtMs" ? new Date(input.value).getTime() : Number(input.value);
      const requestedAccount = accountId;
      input.disabled = true;
      try {
        if (!savedSettings) throw new Error("设置尚未加载完成");
        const currentAccountId = (await chrome.storage.local.get("accountId")).accountId || "";
        if (!currentAccountId || currentAccountId !== requestedAccount || accountId !== requestedAccount) {
          await load(); throw new Error("DeepSeek 账号已切换，请检查设置后重试");
        }
        if (key === "memoryStartAtMs" && (!input.value || !Number.isFinite(value) || value <= 0))
          throw new Error("请选择有效的记忆起始时间");
        const previous = key === "memoryStartAtMs" ? Math.floor(savedSettings[key] / 1000) * 1000 : savedSettings[key];
        if (value === previous) return;
        const result = await call("settings-update", { key, value });
        if (accountId !== requestedAccount) throw new Error("DeepSeek 账号已切换，请检查设置后重试");
        savedSettings[key] = result.value;
        notice("设置已生效");
        window.dispatchEvent(new Event("dtw-settings-changed"));
      } catch (error) {
        if (savedSettings) {
          if (checkboxSettings.includes(key)) input.checked = Boolean(savedSettings[key]);
          else if (key === "memoryStartAtMs") input.value = localDateInput(savedSettings[key]);
          else selectValue(key, savedSettings[key]);
        }
        notice(error.message, true);
      }
      finally { input.disabled = false; }
    });
  }
  load().catch((error) => notice(error.message, true));
  setInterval(() => { if (!document.hidden) refreshQueue().catch((error) => notice(error.message, true)); }, 5000);
  window.addEventListener("focus", async () => {
    try {
      if ((await chrome.storage.local.get("accountId")).accountId !== accountId) await load();
    } catch (error) { notice(error.message, true); }
  });
})();
