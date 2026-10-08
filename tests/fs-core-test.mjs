import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
vm.runInThisContext(await readFile(path.join(here, "..", "core", "logic", "memory-core.js"), "utf8"), { filename: "memory-core.js" });
vm.runInThisContext(await readFile(path.join(here, "..", "core", "logic", "fs-core.js"), "utf8"), { filename: "fs-core.js" });

const core = globalThis.DTWMemory;
const fs = globalThis.DTWFS;
assert.ok(core && fs, "cores should attach to globalThis");

const T0 = "2026-09-20T10:00:00.000Z";
const T1 = "2026-09-20T11:00:00.000Z";
const T2 = "2026-09-20T12:00:00.000Z";

const taskMemory = (patch = {}) => core.normalizeTaskMemory({
  version: 2, sourceEpoch: 1, summary: "旧概况", updatedAt: T1,
  items: [{ id: "goal_1", kind: "goal", text: "验证目标", state: "active" }],
  ...patch,
});

// recordsFromStore：子集 + 补时间戳
{
  const store = core.normalizeStore({
    taskMemories: { task_1: taskMemory(), "task/坏 id!": taskMemory({ version: 3 }) },
    userFacts: [{ key: "language", value: "中文" }],
    jobs: { job_1: { id: "job_1", taskId: "task_1" } },
    settings: { autoInject: true },
    turnFingerprints: { conv_1: "fp" },
  });
  const records = fs.recordsFromStore(store, T2, T2);
  assert.deepEqual(Object.keys(records.tasks).sort(), ["task_1", "taskid"], "非法字符应被净化而不是丢弃");
  assert.equal(records.tasks.task_1.updatedAt, T1, "已有 updatedAt 保持不变");
  assert.equal(records.facts.updatedAt, T2, "facts 信封时间戳由调用方传入");
  assert.equal(records.facts.facts.length, 1);
  assert.equal(records.tasks.task_1.version, 2);
  assert.ok(!("jobs" in records) && !("settings" in records), "运行时状态不进记录");
}
{
  const store = core.normalizeStore({ taskMemories: { task_1: { version: 0, updatedAt: "" } } });
  const records = fs.recordsFromStore(store, T1, T1);
  assert.equal(records.tasks.task_1.updatedAt, T1, "空 updatedAt（clearTaskMemory 之后）用 now 补齐");
}

// recordsIntoStore：只换两个字段，运行时字段保留
{
  const store = core.normalizeStore({
    jobs: { job_1: { id: "job_1", taskId: "task_1" } },
    turnFingerprints: { conv_1: "fp" },
    settings: { autoInject: true, autoAnalyze: true },
    userFacts: [{ key: "old", value: "旧事实" }],
    taskMemories: { task_gone: taskMemory() },
  });
  const next = fs.recordsIntoStore(store, {
    tasks: { task_new: taskMemory({ version: 5 }) },
    facts: { updatedAt: T2, facts: [{ key: "new", value: "新事实" }] },
  });
  assert.ok(next.jobs.job_1, "jobs 保留");
  assert.equal(next.turnFingerprints.conv_1, "fp", "turnFingerprints 保留");
  assert.equal(next.settings.autoAnalyze, true, "settings 保留");
  assert.ok(!next.taskMemories.task_gone, "重载语义：副本中文件没有的任务被移除");
  assert.equal(next.taskMemories.task_new.version, 5);
  assert.equal(next.userFacts[0].key, "new");
}

// mergeRecords：三向合并
{
  const onlyCopy = fs.mergeRecords({ tasks: {}, facts: null }, { tasks: { task_1: taskMemory() }, facts: { updatedAt: T1, facts: [] } });
  assert.equal(onlyCopy.fileChanged, true, "只在副本 → 需写文件（迁移导出）");
  assert.equal(onlyCopy.copyChanged, false);
  assert.equal(onlyCopy.records.tasks.task_1.version, 2);
}
{
  const onlyFile = fs.mergeRecords({ tasks: { task_1: taskMemory() }, facts: null }, { tasks: {}, facts: null });
  assert.equal(onlyFile.copyChanged, true, "只在文件 → 并入副本");
  assert.equal(onlyFile.fileChanged, false);
}
{
  const newerFile = fs.mergeRecords(
    { tasks: { task_1: taskMemory({ version: 9, updatedAt: T2 }) }, facts: null },
    { tasks: { task_1: taskMemory({ version: 2, updatedAt: T1 }) }, facts: null },
  );
  assert.equal(newerFile.records.tasks.task_1.version, 9, "文件更新 → 文件胜");
  assert.equal(newerFile.copyChanged, true);
  assert.equal(newerFile.fileChanged, false);
}
{
  const newerCopy = fs.mergeRecords(
    { tasks: { task_1: taskMemory({ version: 9, updatedAt: T1 }) }, facts: null },
    { tasks: { task_1: taskMemory({ version: 2, updatedAt: T2 }) }, facts: null },
  );
  assert.equal(newerCopy.records.tasks.task_1.version, 2, "副本更新 → 副本胜");
  assert.equal(newerCopy.fileChanged, true);
}
{
  const tie = fs.mergeRecords(
    { tasks: { task_1: taskMemory({ version: 9, updatedAt: T1 }) }, facts: null },
    { tasks: { task_1: taskMemory({ version: 2, updatedAt: T1 }) }, facts: null },
  );
  assert.equal(tie.records.tasks.task_1.version, 9, "平局文件胜（手改保护）");
  assert.equal(tie.copyChanged, true);
}
{
  // 「只删除最新事实」不倒退：删除发生在副本（信封 T2 > 文件 T1）→ 副本整体胜
  const merged = fs.mergeRecords(
    { tasks: {}, facts: { updatedAt: T1, facts: [{ key: "a", value: "1" }, { key: "b", value: "2" }] } },
    { tasks: {}, facts: { updatedAt: T2, facts: [{ key: "a", value: "1" }] } },
  );
  assert.equal(merged.records.facts.facts.length, 1, "已删除的事实不复活");
  assert.equal(merged.fileChanged, true);
}

// parseRecordFile
{
  assert.equal(fs.parseRecordFile("{bad json", "task"), null, "坏 JSON → null");
  assert.equal(fs.parseRecordFile("42", "facts"), null, "非对象 → null");
  const roundTrip = fs.parseRecordFile(JSON.stringify(taskMemory()), "task");
  assert.equal(JSON.stringify(roundTrip), JSON.stringify(taskMemory()), "任务记录写读往返稳定");
  const facts = fs.parseRecordFile(JSON.stringify({ updatedAt: T1, facts: [{ key: "a", value: "1" }] }), "facts");
  assert.equal(facts.updatedAt, T1);
  assert.equal(facts.facts.length, 1);
  assert.equal(fs.parseRecordFile("{}", "facts").facts.length, 0, "缺 facts 字段按空处理");
}

// diffRecords
{
  const prev = fs.recordsFromStore(core.normalizeStore({
    taskMemories: { task_1: taskMemory(), task_2: taskMemory() },
    userFacts: [{ key: "a", value: "1" }],
  }), T1, T1);
  const next = fs.recordsFromStore(core.normalizeStore({
    taskMemories: { task_1: taskMemory({ version: 3 }) },
    userFacts: [{ key: "a", value: "1" }],
  }), T1, T1);
  const ops = fs.diffRecords(prev, next);
  assert.deepEqual(ops.writes.map((write) => write.path), ["tasks/task_1.json"], "只有变化的任务出一个文件");
  assert.deepEqual(ops.removes, ["tasks/task_2.json"], "副本中消失的任务出删除清单");
  const sameFacts = fs.diffRecords(prev, prev);
  assert.equal(sameFacts.writes.length, 0, "无变化不写任何文件");
  const factsOps = fs.diffRecords(
    prev,
    fs.recordsFromStore(core.normalizeStore({
      taskMemories: prev.tasks,
      userFacts: [{ key: "a", value: "2" }],
    }), T1, T2),
  );
  assert.deepEqual(factsOps.writes.map((write) => write.path), ["facts.json"]);
}

// buildConversationArchive
{
  const archive = fs.buildConversationArchive({
    conversationId: "conv/坏 id!",
    title: "测试会话",
    captureIncomplete: true,
    messages: [
      { id: "m1", role: "user", text: "你好", revision: 1 },
      { id: "", role: "assistant", text: "无 id 应被过滤", revision: 1 },
      { id: "m2", role: "assistant", text: "好的", revision: 2 },
    ],
  }, T1);
  assert.equal(archive.conversationId, "convid");
  assert.equal(archive.messages.length, 2);
  assert.equal(archive.messages[1].revision, 2);
  assert.equal(archive.captureIncomplete, true);
  assert.equal(fs.conversationFileName("conv/坏 id!"), "conversations/convid.json");
}

// isDirectoryHandle：识别（并拒绝）消息通道序列化后的空壳 handle
{
  const fakeDirectory = {
    kind: "directory",
    queryPermission() {}, requestPermission() {}, getDirectoryHandle() {},
  };
  assert.equal(fs.isDirectoryHandle(fakeDirectory), true, "具备完整方法的目录句柄");
  assert.equal(fs.isDirectoryHandle({}), false, "JSON 序列化后的空壳被拒");
  assert.equal(fs.isDirectoryHandle(null), false);
  assert.equal(fs.isDirectoryHandle({ kind: "file", queryPermission() {} }), false, "文件句柄不算目录");
}

console.log(JSON.stringify({ ok: true, assertions: 32 }, null, 2));
