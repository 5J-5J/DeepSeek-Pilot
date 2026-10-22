/** Offline automation clock/history fixtures; no DeepSeek requests. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../core/content/workbench.js", import.meta.url), "utf8");
const startCall = '  start().catch((error) => console.warn("[DeepSeek Pilot]", error));';
assert.ok(source.includes(startCall));

async function run({ finishAt = Infinity, generating = false, hiddenAnswer = false, historyError = null, changing = false,
  routeMode = "normal", appliedSessionId = "helper", cachedOther = false, generatingUntil = finishAt, switchAt = 30000 } = {}) {
  const started = 1000000;
  let clock = started;
  let submitted = false;
  const requests = []; const polls = []; const sleeps = []; const generationEnds = [];
  let previouslyGenerating = false;
  const raw = '{"memories":[]}';
  const answer = {};
  class Clock extends Date { static now() { return clock; } }
  const scenario = {
    route: () => !submitted || routeMode === "missing" ? ""
      : routeMode === "switched" && clock - started >= switchAt ? "other" : "helper",
    nodes: () => submitted && !hiddenAnswer ? [answer] : [],
    text: () => clock - started >= finishAt ? raw : changing ? `partial ${clock}` : "partial",
    generating: () => {
      const running = generating && clock - started < generatingUntil;
      if (previouslyGenerating && !running) generationEnds.push(clock - started);
      previouslyGenerating = running;
      return running;
    },
    submit: () => { submitted = true; },
    sleep: async ms => { sleeps.push(ms); clock += ms; assert.ok(clock - started < 1800000, "任务应完成或报告停滞"); },
    applied: async () => ({ sessionId: appliedSessionId }),
    history: async sessionId => {
      assert.equal(sessionId, "helper", "始终读取本次请求的自动化会话，而非当前标签页地址");
      polls.push(clock - started);
      if (historyError) throw Object.assign(new Error("模拟历史请求失败"), { code: historyError });
      return { conversationId: "helper", currentMessageId: 2, records: [{ messageId: 2, role: "ASSISTANT",
        status: clock - started >= finishAt ? "FINISHED" : "GENERATING",
        fragments: [{ type: "RESPONSE", content: clock - started >= finishAt ? raw : "partial" }] }] };
    },
    send: async (type, body) => { requests.push({ type, ...body, elapsed: clock - started }); return { ok: true }; },
  };
  const context = vm.createContext({ window: new EventTarget(), location: { href: "https://chat.deepseek.com/" },
    crypto: globalThis.crypto, CustomEvent, URL, setTimeout, clearTimeout, Date: Clock, console, scenario,
    document: { createElement: () => ({}), head: { append() {} }, querySelectorAll: () => [],
      querySelector: () => null, addEventListener() {} },
    chrome: { runtime: { getURL: path => path, onMessage: { addListener() {} } } },
  });
  const fixtureSource = source.replace("const currentId =", "let currentId =")
    .replace("const delay =", "let delay =").replace("const send =", "let send =");
  vm.runInContext(fixtureSource.replace(startCall, `
    globalThis.fixture = { state, runAutomation };
    currentId = scenario.route;
    waitEditor = async () => ({});
    arm = async () => ({ marker: "marker", requestId: "request" });
    waitEvent = scenario.applied;
    setEditor = () => {};
    submit = scenario.submit;
    messageNodes = scenario.nodes;
    messageRole = () => "ASSISTANT";
    nodeText = scenario.text;
    isGenerating = scenario.generating;
    history = scenario.history;
    requireSendAllowed = () => {};
    delay = scenario.sleep;
    send = scenario.send;
    cancel = () => {};
    findEditor = () => null;
  `), context);
  if (cachedOther) context.fixture.state.lastHistory = { conversationId: "other", currentMessageId: 8,
    records: [{ messageId: 8, role: "ASSISTANT", status: "FINISHED", fragments: [{ type: "RESPONSE", content: "另一会话的回答" }] }] };
  await context.fixture.runAutomation({ jobId: "job", prompt: "模拟整理请求" });
  assert.equal(context.fixture.state.automationRunning, false);
  assert.equal(context.fixture.state.automationJobId, null);
  assert.equal(context.fixture.state.automationSessionId, "");
  assert.ok(sleeps.every(ms => ms === 5000), "页面状态每 5 秒检查一次");
  assert.ok(polls.slice(1).every((elapsed, index) => elapsed - polls[index] >= 30000 || generationEnds.includes(elapsed)),
    "仅生成结束时可提前核对历史，其他请求保持 30 秒间隔");
  assert.equal(requests.filter(request => request.type === "automation-result").length, 1);
  assert.ok(requests.every(request => request.automationSessionId === "helper"), "进度和结果均绑定同一自动化会话");
  return { ...requests.find(request => request.type === "automation-result"), polls };
}

let result = await run({ finishAt: 31000, generating: true });
assert.equal(result.raw, '{"memories":[]}');
assert.equal(result.elapsed, 35000, "生成结束后在下一次 5 秒检查即提交，不再等到第 60 秒");
assert.deepEqual(result.polls, [0, 30000, 35000]);
result = await run({ finishAt: 31000 });
assert.equal(result.elapsed, 60000, "未识别生成状态时仍按 30 秒历史检查兜底");
assert.deepEqual(result.polls, [0, 30000, 60000]);
result = await run({ finishAt: 41000, generating: true, generatingUntil: 31000 });
assert.equal(result.raw, '{"memories":[]}');
assert.equal(result.elapsed, 65000, "按钮消失时历史仍在生成，不能提前提交残缺回答");
assert.deepEqual(result.polls, [0, 30000, 35000, 65000], "结束信号只额外触发一次历史检查");
result = await run({ finishAt: 61000, generating: true, routeMode: "switched", switchAt: 35000 });
assert.equal(result.raw, '{"memories":[]}');
assert.deepEqual(result.polls, [0, 30000, 60000, 90000], "离开目标页面不应误触发生成结束检查");
result = await run({ finishAt: 12 * 60000, generating: true });
assert.equal(result.raw, '{"memories":[]}');
assert.ok(result.elapsed >= 12 * 60000, "持续生成超过旧的 6 分钟上限仍等待完成");
result = await run({ finishAt: 12 * 60000, changing: true });
assert.equal(result.error, undefined, "正文持续变化时，即使没有停止按钮也继续等待");
result = await run({ finishAt: 120000, hiddenAnswer: true });
assert.equal(result.raw, '{"memories":[]}', "DOM 消息未匹配时从历史中的 FINISHED 回答获取结果");
assert.ok(result.elapsed >= 120000, "稳定的残缺正文或 GENERATING 历史不能提前完成");
result = await run();
assert.match(result.error, /连续 10 分钟/);
assert.ok(result.elapsed >= 600000);
result = await run({ historyError: "AUTH_REQUIRED" });
assert.equal(result.error, "模拟历史请求失败", "登录失效时停止检查而非反复请求");
result = await run({ finishAt: 60000, hiddenAnswer: true, routeMode: "missing" });
assert.equal(result.raw, '{"memories":[]}', "地址及 DOM 都未出现时仍使用发送请求的会话 ID 检查完成结果");
result = await run({ finishAt: 120000, routeMode: "switched", cachedOther: true });
assert.equal(result.raw, '{"memories":[]}', "切换地址后仍获取对应任务的结果，忽略其它会话的完成缓存");
result = await run({ finishAt: 60000, appliedSessionId: "" });
assert.equal(result.raw, '{"memories":[]}', "旧网络事件未提供 ID 时绑定首次出现的路由");
result = await run({ historyError: "HTTP_ERROR" });
assert.match(result.error, /自动化会话：helper.*历史读取失败：模拟历史请求失败/);
console.log("Automation reply checks passed: prompt completion checks, unfinished-history protection, slow generation, missing DOM, low-frequency polling and stalls.");
