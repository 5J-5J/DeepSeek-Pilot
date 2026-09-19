import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
vm.runInThisContext(await readFile(path.join(here, "memory-core.js"), "utf8"), { filename: "memory-core.js" });

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

console.log(JSON.stringify({ ok: true, assertions: 15 }, null, 2));
