/** Offline rollover lifecycle: real background handlers, simulated native chat and clock. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { runWorkbench, memoryCommitFixture } from "./workbench-fixture.mjs";

const content = await readFile(new URL("../core/content/workbench.js", import.meta.url), "utf8");
const startCall = '  start().catch((error) => console.warn("[DeepSeek Pilot]", error));';
assert.ok(content.includes(startCall));

async function run({ finishAt = 60000, hiddenAnswer = false, generating = false, switchRoute = false,
  historyError = null, confirmed = true } = {}) {
  const accountId = "rollover-fixture";
  let clock = 1000000; const started = clock;
  class Clock extends Date { static now() { return clock; } }
  const names = ["sessions", "messages", "projects", "memberships", "memories", "memoryTurns", "jobs", "settings", "metrics"];
  const tables = Object.fromEntries(names.map(name => [name, new Map()]));
  const fields = { sessions: "sessionId", projects: "projectId", memberships: "sessionId", memories: "memoryId",
    memoryTurns: "turnKey", jobs: "jobId", settings: "key", metrics: "metricId" };
  const db = {
    get: async (name, key) => structuredClone(tables[name].get(JSON.stringify(key)) || null),
    all: async (name, account) => [...tables[name].values()].filter(row => account === undefined || row.accountId === account).map(row => structuredClone(row)),
    by: async (name, _index, [account, session]) => (await db.all(name, account)).filter(row => row.sessionId === session),
    put: async (name, row) => tables[name].set(JSON.stringify(name === "messages"
      ? [row.accountId, row.sessionId, row.messageId] : [row.accountId, row[fields[name]]]), structuredClone(row)),
    remove: async (name, key) => tables[name].delete(JSON.stringify(key)),
  };
  db.commitMemoryBatch = memoryCommitFixture(db);
  let listener; let alarm;
  const tabs = []; const notifications = []; const removed = [];
  const chrome = {
    runtime: { getURL: (path = "") => `chrome-extension://fixture/${path}`, onMessage: { addListener(fn) { listener = fn; } }, onInstalled: { addListener() {} } },
    storage: { local: { get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key =>
      [key, key === "accountId" ? accountId : key === "dtw.firstRunAtMs" ? started : undefined])), set: async () => {} } },
    tabs: { create: async options => { const tab = { id: 201 + tabs.length, ...options }; tabs.push(tab); return tab; },
      sendMessage: async (tabId, message) => { notifications.push({ tabId, message }); return { ok: true }; },
      remove: async id => { removed.push(id); } },
    alarms: { create() {}, onAlarm: { addListener(fn) { alarm = fn; } } },
  };
  const background = vm.createContext({ DTWDB: db, chrome, crypto: globalThis.crypto, TextEncoder, structuredClone, Date: Clock, console, setTimeout });
  await runWorkbench(background);
  const call = async (type, body = {}, tabId = 11) => {
    const result = await new Promise(resolve => listener({ type: `dtw:${type}`, accountId, ...body },
      { tab: { id: tabId, url: "https://chat.deepseek.com/a/chat/s/source" } }, resolve));
    assert.equal(result.ok, true, result.error); return result;
  };
  const project = (await call("project-create", { name: "续接测试", goalShort: "交付离线报告" })).project;
  await call("settings-update", { key: "automationPaused", value: true });
  await call("settings-update", { key: "maxContextTokens", value: 4000 });
  await call("settings-update", { key: "replyReserveTokens", value: 400 });
  await call("session-observe", { sessionId: "source", loadedHistory: true, createdAtMs: 100 });
  await call("membership-move", { sessionId: "source", projectId: project.projectId });
  await call("memory-toggle", { sessionId: "source", enabled: true });
  await call("history-observe", { sessionId: "source", currentMessageId: 2, records: [
    { messageId: 1, parentId: null, role: "USER", status: "FINISHED", fragments: [{ type: "REQUEST", content: "原会话问题" }] },
    { messageId: 2, parentId: 1, role: "ASSISTANT", status: "FINISHED", accumulatedTokenUsage: 3600,
      fragments: [{ type: "RESPONSE", content: "已完成数据清理，下一步写报告" }] },
  ] });
  await call("memory-save", { memory: { scope: "PERSONAL", kind: "偏好", content: "先给结论" } });
  await call("memory-save", { memory: { scope: "PROJECT", projectId: project.projectId, kind: "约束", content: "必须离线可用" } });
  const rawInput = "继续编写报告";
  const tip = await db.get("messages", [accountId, "source", 2]);
  await call("memory-toggle", { sessionId: "source", enabled: false });
  assert.equal((await call("prepare-send", { sessionId: "source", rawInput })).native, true, "关闭项目记忆时不自动续接");
  await call("memory-toggle", { sessionId: "source", enabled: true });
  const boundary = 4000 - 400 - Math.ceil(rawInput.length / 2);
  await db.put("messages", { ...tip, accumulatedTokenUsage: boundary - 1 });
  assert.equal((await call("prepare-send", { sessionId: "source", rawInput })).native, true, "预算边界之前不续接");
  await call("settings-update", { key: "warningRatio", value: 0.9 });
  const early = await call("prepare-send", { sessionId: "source", rawInput });
  assert.equal(early.rollover, true, "降低提醒比例可提前续接");
  await db.put("jobs", { ...await db.get("jobs", [accountId, early.jobId]), status: "CANCELLED" });
  await call("settings-update", { key: "warningRatio", value: 1 });
  await db.put("messages", { ...tip, accumulatedTokenUsage: null, fragments: [{ type: "RESPONSE", content: "长".repeat(8000) }] });
  const estimated = await call("prepare-send", { sessionId: "source", rawInput });
  assert.equal(estimated.rollover, true, "没有真实 token 用量时按正文长度估算并触发续接");
  await db.put("jobs", { ...await db.get("jobs", [accountId, estimated.jobId]), status: "CANCELLED" });
  await db.put("messages", { ...tip, accumulatedTokenUsage: boundary });
  const prepared = await call("prepare-send", { sessionId: "source", rawInput });
  assert.equal(prepared.rollover, true, "达到包含本轮问题和回复预留的预算边界时续接");
  assert.match(prepared.prompt, /先给结论/); assert.match(prepared.prompt, /必须离线可用/);
  assert.match(prepared.prompt, /已完成数据清理/); assert.ok(prepared.prompt.endsWith(`<current_question>\n${rawInput}\n</current_question>`));
  assert.equal((await call("rollover-start", { jobId: prepared.jobId })).queued, true);
  assert.equal(tabs.length, 0, "暂停时不创建后继标签页");
  await call("settings-update", { key: "automationPaused", value: false });
  assert.equal(tabs.length, 1); assert.equal(tabs[0].active, true);
  assert.equal(notifications.filter(item => item.message.type === "dtw:rollover").length, 1, "只发送一次续接任务");
  const events = []; const polls = []; let route = ""; let sentPrompt = "";
  const sourceEditor = { value: rawInput };
  const capture = () => ({ conversationId: "successor", currentMessageId: 2, records: [
    { messageId: 1, parentId: null, role: "USER", status: "FINISHED", fragments: [{ type: "REQUEST", content: sentPrompt }] },
    { messageId: 2, parentId: 1, role: "ASSISTANT", status: clock - started >= finishAt ? "FINISHED" : "GENERATING",
      fragments: [{ type: "RESPONSE", content: clock - started >= finishAt ? "报告已完成" : "部分回答" }] },
  ] });
  const scenario = {
    route: () => route,
    nodes: () => hiddenAnswer ? [] : [{ role: "ASSISTANT", text: "页面上的稳定文字" }],
    generating: () => generating && clock - started < finishAt,
    sleep: async ms => {
      clock += ms;
      assert.ok(clock - started <= 1200000, "续接任务不应无限等待");
      if (switchRoute && clock - started >= 10000) route = "other";
      await alarm({ name: "dtw-job-check" });
    },
    send: async (type, body = {}) => {
      events.push({ type, ...body, elapsed: clock - started });
      return call(type, body, tabs[0].id);
    },
    nativeSend: async (_editor, prompt, jobId) => {
      sentPrompt = prompt;
      if (!confirmed) { await scenario.send("send-status", { jobId, error: "模拟发送未确认" }); return false; }
      route = "successor";
      // The real DOM confirmation is exercised by settings-ui-test.mjs.
      await scenario.send("send-status", { jobId, confirmed: true, sessionId: route, waitForReply: true });
      await assert.rejects(vm.runInContext("sendStatus", background)(accountId,
        { jobId, replyProgress: true, sessionId: "other" }), /与目标不匹配/);
      await assert.rejects(vm.runInContext("sendStatus", background)(accountId,
        { jobId, replyFinished: true, sessionId: "other" }), /与目标不匹配/);
      return true;
    },
    history: async id => {
      polls.push({ id, elapsed: clock - started });
      if (historyError) throw Object.assign(new Error("模拟历史读取失败"), { code: historyError });
      return capture();
    },
    save: async (id, captured) => scenario.send("history-observe", { sessionId: id, records: captured.records, currentMessageId: captured.currentMessageId }),
  };
  let contentListener;
  scenario.editor = sourceEditor;
  const context = vm.createContext({ window: new EventTarget(), location: { href: "https://chat.deepseek.com/" },
    crypto: globalThis.crypto, CustomEvent, URL, Date: Clock, console, setTimeout, clearTimeout, scenario,
    document: { createElement: () => ({}), head: { append() {} }, querySelectorAll: () => [], querySelector: () => null, addEventListener() {} },
    chrome: { runtime: { getURL: path => path, onMessage: { addListener(fn) { contentListener = fn; } } } },
  });
  const fixture = content.replace("const currentId =", "let currentId =").replace("const delay =", "let delay =").replace("const send =", "let send =");
  vm.runInContext(fixture.replace(startCall, `
    globalThis.fixture = { state, runRollover };
    currentId = scenario.route; delay = scenario.sleep; send = scenario.send;
    waitEditor = async () => ({}); doProjectSend = scenario.nativeSend;
    messageNodes = scenario.nodes; messageRole = node => node.role; nodeText = node => node.text;
    isGenerating = scenario.generating; requireSendAllowed = () => {};
    findEditor = () => scenario.editor; setEditor = (editor, value) => { editor.value = value; };
    currentHistory = async () => null; history = scenario.history;
    saveObservedHistory = scenario.save; refresh = async () => {};
  `), context);
  await context.fixture.runRollover({ jobId: prepared.jobId, prompt: prepared.prompt });
  const job = await db.get("jobs", [accountId, prepared.jobId]);
  assert.equal(context.fixture.state.rolloverRunning, false);
  assert.equal(context.fixture.state.rolloverSessionId, "");
  assert.equal(job.rawInput, rawInput, "任何结果都保留原始草稿记录");
  assert.equal((await db.get("sessions", [accountId, "source"])).currentMessageId, 2, "原会话不被改写");
  assert.equal(sourceEditor.value, rawInput, "收到确认通知之前保留原输入框的草稿");
  const clearDraft = notifications.find(item => item.message.type === "dtw:rollover-confirmed");
  if (clearDraft) {
    contentListener(clearDraft.message, {}, () => {});
    assert.equal(sourceEditor.value, "", "确认收到消息后清空匹配的原草稿");
    sourceEditor.value = "后来修改的新草稿";
    contentListener(clearDraft.message, {}, () => {});
    assert.equal(sourceEditor.value, "后来修改的新草稿", "延迟或重复确认不会清空用户新写的草稿");
  }
  assert.ok(polls.every(poll => poll.id === "successor"), "只核对绑定的后继会话");
  assert.ok(polls.slice(1).every((poll, index) => poll.elapsed - polls[index].elapsed >= 30000), "历史检查最多每 30 秒一次");
  if (!confirmed || historyError || !Number.isFinite(finishAt)) {
    assert.equal(job.status, "NEEDS_REVIEW", "异常需核对，不能报告成功");
    assert.equal(events.some(event => event.replyFinished), false);
    assert.equal(notifications.some(item => item.message.type === "dtw:rollover-confirmed"), confirmed);
  } else {
    assert.equal(job.status, "DONE");
    assert.ok(events.find(event => event.replyFinished)?.elapsed >= finishAt, "历史仍在生成时不能提前完成续接");
    assert.equal(job.targetSessionId, "successor");
    assert.equal((await db.get("memberships", [accountId, "successor"])).projectId, project.projectId);
    assert.equal((await db.get("projects", [accountId, project.projectId])).currentSessionId, "successor");
    assert.equal((await call("prepare-send", { sessionId: "successor", rawInput: "后续问题" })).native, true, "后续轮次不重复注入记忆");
    assert.equal(notifications.filter(item => item.message.type === "dtw:rollover-confirmed").length, 1, "确认收到才通知原标签页清空草稿");
  }
  return { polls, events, removed, job };
}

await run();
await run({ finishAt: 120000, hiddenAnswer: true });
await run({ finishAt: 120000, switchRoute: true });
const slow = await run({ finishAt: 7 * 60000, generating: true });
assert.equal(slow.removed.length, 0, "等待期间心跳阻止后台误关闭仍在回复的后继标签页");
assert.ok(slow.events.some(event => event.replyProgress));
await run({ historyError: "AUTH_REQUIRED" });
await run({ confirmed: false });
await run({ finishAt: Infinity });
console.log("Rollover checks passed: budget, pause, one successor, memory/context, confirmation, actual completion, missing DOM, route changes, long replies and preserved drafts.");
