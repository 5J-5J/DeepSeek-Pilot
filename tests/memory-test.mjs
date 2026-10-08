import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
vm.runInThisContext(await readFile(path.join(here, "..", "core", "logic", "memory-core.js"), "utf8"), { filename: "memory-core.js" });

const core = globalThis.DTWMemory;
assert.ok(core, "memory core should attach to globalThis");

const job = { id: "job_1", taskId: "task_1", baseVersion: 1, sourceEpoch: 2 };
const messages = [
  { id: "conv:user:1:a", role: "user", revision: 1, conversationId: "conv", text: "以后默认中文，先给结论。" },
  { id: "conv:assistant:1:b", role: "assistant", revision: 1, conversationId: "conv", text: "明白。" },
  { id: "conv:user:2:c", role: "user", revision: 1, conversationId: "conv", text: "旧方案取消，交付一份可测试的插件。" },
];

const prompt = core.buildDistillPrompt({
  job,
  task: { id: "task_1", name: "测试任务" },
  currentMemory: { version: 1, sourceEpoch: 2, summary: "旧概况", items: [] },
  userFacts: [],
  messages,
});
assert.match(prompt, /不可信数据/);
assert.match(prompt, /conv:user:1:a/);

const rawResult = {
  meta: { jobId: "job_1", taskId: "task_1", baseVersion: 1, sourceEpoch: 2 },
  taskState: {
    summary: "正在交付可测试的插件。",
    nextStep: "运行浏览器自检。",
    items: [
      {
        id: "delivery_goal",
        kind: "goal",
        text: "交付一份可测试的插件",
        state: "active",
        evidence: [{ messageId: "conv:user:2:c", revision: 1 }],
      },
    ],
  },
  retirements: [{ itemId: "old_auto", evidence: [{ messageId: "conv:user:2:c", revision: 1 }] }],
  factChanges: [
    {
      operation: "upsert",
      key: "preferred_language",
      value: "默认使用中文并先给结论",
      category: "preference",
      scope: "global",
      status: "active",
      importance: "always",
      evidence: [{ messageId: "conv:user:1:a", revision: 1 }],
    },
    {
      operation: "upsert",
      key: "blocked_fact",
      value: "不应复活",
      category: "preference",
      scope: "global",
      status: "active",
      importance: "called",
      evidence: [{ messageId: "conv:user:1:a", revision: 1 }],
    },
  ],
};

const validationContext = {
  job,
  messages,
  currentMemory: { version: 1, sourceEpoch: 2, items: [{ id: "old_auto", kind: "decision", text: "旧方案", state: "active" }] },
  userFacts: [{ key: "blocked_fact", value: "已禁用", status: "disabled" }],
};
const validated = core.validateDistillResult(JSON.stringify(rawResult), validationContext);
assert.equal(validated.factChanges[0].status, "active");

const proposedGoal = structuredClone(rawResult);
proposedGoal.taskState.items[0].state = "proposed_done";
assert.equal(core.validateDistillResult(proposedGoal, validationContext).taskState.items[0].state, "proposed_done");

const escapedProposedGoal = structuredClone(rawResult);
escapedProposedGoal.taskState.items[0].state = "proposed\\_done";
assert.equal(core.validateDistillResult(escapedProposedGoal, validationContext).taskState.items[0].state, "proposed_done");

const proposedDecision = structuredClone(rawResult);
proposedDecision.taskState.items[0].kind = "decision";
proposedDecision.taskState.items[0].state = "proposed_done";
assert.equal(core.validateDistillResult(proposedDecision, validationContext).taskState.items[0].state, "active");

const store = core.normalizeStore({
  taskMemories: {
    task_1: {
      version: 1,
      sourceEpoch: 2,
      summary: "旧概况",
      nextStep: "旧步骤",
      items: [
        { id: "manual_constraint", kind: "constraint", text: "人工固定项", state: "active", pinned: true, source: "manual" },
        { id: "old_auto", kind: "decision", text: "旧方案", state: "active", pinned: false, source: "deepseek" },
      ],
    },
  },
  userFacts: [
    { id: "fact_blocked", key: "blocked_fact", value: "已禁用", category: "preference", scope: "global", status: "disabled", importance: "called" },
  ],
});
const merged = core.applyDistillResult(store, validated, { job, messages, now: "2026-09-19T00:00:00.000Z" });
assert.equal(merged.taskMemories.task_1.version, 2);
assert.equal(merged.taskMemories.task_1.items.find((item) => item.id === "manual_constraint").text, "人工固定项");
assert.equal(merged.taskMemories.task_1.items.find((item) => item.id === "old_auto").state, "retired");
assert.equal(merged.userFacts.find((fact) => fact.key === "preferred_language").status, "active");
assert.equal(merged.userFacts.find((fact) => fact.key === "blocked_fact").status, "disabled");

assert.throws(() => core.validateDistillResult({
  ...rawResult,
  taskState: {
    ...rawResult.taskState,
    items: [{ ...rawResult.taskState.items[0], evidence: [{ messageId: "missing", revision: 1 }] }],
  },
}, validationContext), /来源消息不存在/);

assert.throws(() => core.validateDistillResult({
  ...rawResult,
  factChanges: [{ ...rawResult.factChanges[0], key: "health_diagnosis" }],
}, validationContext), /敏感信息/);

assert.throws(() => core.applyDistillResult({
  ...store,
  taskMemories: { task_1: { ...store.taskMemories.task_1, version: 2 } },
}, validated, { job, messages }), /已被修改/);

// --- 自动注入上下文 ---
const contextStore = core.normalizeStore({
  taskMemories: {
    task_1: {
      version: 2,
      summary: "增强 DeepSeek 的记忆插件。",
      nextStep: "验证自动注入。",
      items: [
        { id: "g1", kind: "goal", text: "跨会话项目记忆", state: "active" },
        { id: "d1", kind: "decision", text: "不用向量数据库", state: "active" },
        { id: "d2", kind: "decision", text: "已废弃的决定", state: "retired" },
      ],
    },
  },
});
const memoryBlockText = core.buildTaskMemoryContext({ id: "task_1", name: "DeepSeek Memory" }, contextStore);
assert.ok(memoryBlockText.startsWith("<task_memory>"));
assert.ok(memoryBlockText.endsWith("</task_memory>"));
assert.match(memoryBlockText, /项目：DeepSeek Memory/);
assert.match(memoryBlockText, /项目摘要：增强 DeepSeek 的记忆插件。/);
assert.match(memoryBlockText, /下一步：验证自动注入。/);
assert.match(memoryBlockText, /\[目标\]\n- 跨会话项目记忆/);
assert.match(memoryBlockText, /\[决定\]\n- 不用向量数据库/);
assert.ok(!memoryBlockText.includes("已废弃的决定"));
assert.match(memoryBlockText, /以最后一个为准/);

// 空记忆不注入；无任务 ID 不注入
assert.equal(core.buildTaskMemoryContext({ id: "task_empty", name: "空任务" }, contextStore), "");
assert.equal(core.buildTaskMemoryContext({ id: "", name: "无名" }, contextStore), "");
// 仅有人工条目也可以注入
const manualOnly = core.normalizeStore({
  taskMemories: { task_2: { items: [{ id: "m1", kind: "constraint", text: "保留原生会话", state: "active" }] } },
});
assert.match(core.buildTaskMemoryContext({ id: "task_2", name: "T2" }, manualOnly), /保留原生会话/);

// --- 轮次计数与指纹去重 ---
assert.equal(core.shouldCountTurn({}, "conv_1", "fp1"), true);
assert.equal(core.shouldCountTurn({ conv_1: "fp1" }, "conv_1", "fp1"), false);
assert.equal(core.shouldCountTurn({ conv_1: "fp1" }, "conv_1", "fp2"), true);
assert.equal(core.shouldCountTurn({ conv_1: "fp1" }, "", "fp1"), false);
assert.equal(core.shouldCountTurn({ conv_1: "fp1" }, "conv_1", ""), false);

const turnStore = core.normalizeStore({
  turnFingerprints: { conv_1: "fp1", "bad id!": "x", conv_2: "" },
  taskMemories: { task_1: { pendingTurns: 4 } },
});
assert.equal(turnStore.turnFingerprints.conv_1, "fp1");
assert.ok(!Object.keys(turnStore.turnFingerprints).includes("bad id!"));
assert.ok(!Object.keys(turnStore.turnFingerprints).includes("conv_2"));
assert.equal(turnStore.taskMemories.task_1.pendingTurns, 4);
assert.equal(core.normalizeTaskMemory({ pendingTurns: -3 }).pendingTurns, 0);
assert.equal(core.emptyTaskMemory().pendingTurns, 0);

// 指纹表裁剪到最近 50 条
const manyTurns = Object.fromEntries(
  Array.from({ length: 80 }, (_, index) => [`conv_${index}`, `fp${index}`]));
assert.equal(Object.keys(core.normalizeStore({ turnFingerprints: manyTurns }).turnFingerprints).length, 50);

// settings 默认关闭，随 normalizeStore 保留
const defaultSettings = core.normalizeStore({});
assert.equal(defaultSettings.settings.autoInject, false);
assert.equal(defaultSettings.settings.autoAnalyze, false);
assert.equal(defaultSettings.settings.autoClassify, false);
assert.equal(defaultSettings.settings.turnsPerOrganize, 5, "轮数阈值默认 5");
assert.equal(defaultSettings.settings.archiveConversations, true, "原文存档默认开启且旧数据兼容");
const enabledSettings = core.normalizeStore({ settings: { autoInject: true, autoAnalyze: true, autoClassify: true } });
assert.equal(enabledSettings.settings.autoInject, true);
assert.equal(enabledSettings.settings.autoAnalyze, true);
assert.equal(enabledSettings.settings.autoClassify, true);
assert.equal(core.normalizeStore({ settings: { turnsPerOrganize: 99 } }).settings.turnsPerOrganize, 30, "轮数阈值上限 30");
assert.equal(core.normalizeStore({ settings: { turnsPerOrganize: 1 } }).settings.turnsPerOrganize, 3, "轮数阈值下限 3");
assert.equal(core.normalizeStore({ settings: { turnsPerOrganize: "8" } }).settings.turnsPerOrganize, 8, "轮数阈值接受数字字符串");
assert.equal(core.normalizeStore({ settings: { archiveConversations: false } }).settings.archiveConversations, false);

// 自动归类只允许一个受约束的模拟 function call。
const classifyJob = { id: "classify_1" };
const classifyPrompt = core.buildProjectClassificationPrompt({
  job: classifyJob,
  conversation: { id: "conv_1", title: "继续开发浏览器插件" },
  tasks: [
    { id: "project_plugin", name: "DeepSeek 插件", summary: "开发任务工作台" },
    { id: "project_trip", name: "旅行", summary: "规划行程" },
  ],
  messages: [{ role: "user", text: "给项目列表加折叠功能" }],
});
assert.match(classifyPrompt, /move_conversation_to_project/);
assert.match(classifyPrompt, /project_plugin/);
const classified = core.validateProjectClassificationResult({
  tool: "move_conversation_to_project",
  arguments: {
    job_id: "classify_1",
    conversation_id: "conv_1",
    project_id: "project_plugin",
    confidence: 0.91,
    reason: "会话在继续插件开发",
  },
}, { jobId: "classify_1", conversationId: "conv_1", projectIds: ["project_plugin", "project_trip"] });
assert.equal(classified.projectId, "project_plugin");
assert.equal(classified.confidence, 0.91);
assert.throws(() => core.validateProjectClassificationResult({
  tool: "delete_project",
  arguments: { job_id: "classify_1", conversation_id: "conv_1", project_id: "project_plugin", confidence: 1 },
}, { jobId: "classify_1", conversationId: "conv_1", projectIds: ["project_plugin"] }), /未允许的工具/);
assert.throws(() => core.validateProjectClassificationResult({
  tool: "move_conversation_to_project",
  arguments: { job_id: "classify_1", conversation_id: "conv_1", project_id: "missing", confidence: 1 },
}, { jobId: "classify_1", conversationId: "conv_1", projectIds: ["project_plugin"] }), /不存在的项目/);
assert.throws(() => core.validateProjectClassificationResult({
  tool: "move_conversation_to_project",
  arguments: { job_id: "classify_1!", conversation_id: "conv_1", project_id: "project_plugin", confidence: 1 },
}, { jobId: "classify_1", conversationId: "conv_1", projectIds: ["project_plugin"] }), /作业不匹配/);
assert.throws(() => core.validateProjectClassificationResult({
  tool: "move_conversation_to_project",
  arguments: { job_id: "classify_1", conversation_id: "conv_1", project_id: "project_plugin", confidence: 1, reason: "x".repeat(121) },
}, { jobId: "classify_1", conversationId: "conv_1", projectIds: ["project_plugin"] }), /reason 过长/);

console.log(JSON.stringify({ ok: true, assertions: 62 }, null, 2));
