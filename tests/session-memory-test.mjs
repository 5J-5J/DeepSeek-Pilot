import assert from "node:assert/strict";
import vm from "node:vm";
import { runWorkbench, memoryCommitFixture } from "./workbench-fixture.mjs";

const names = ["sessions", "messages", "projects", "memberships", "memories", "memoryTurns", "jobs", "settings", "metrics"];
const tables = Object.fromEntries(names.map(name => [name, new Map()]));
const idFields = { sessions: "sessionId", messages: "messageId", projects: "projectId", memberships: "sessionId",
  memories: "memoryId", memoryTurns: "turnKey", jobs: "jobId", settings: "key", metrics: "metricId" };
const db = {
  get: async (table, key) => structuredClone(tables[table].get(JSON.stringify(key)) || null),
  all: async (table, accountId) => [...tables[table].values()].filter(row => accountId === undefined || row.accountId === accountId).map(row => structuredClone(row)),
  by: async (table, _index, [accountId, sessionId]) => (await db.all(table, accountId)).filter(row => row.sessionId === sessionId),
  put: async (table, row) => tables[table].set(JSON.stringify(table === "messages"
    ? [row.accountId, row.sessionId, row.messageId] : [row.accountId, row[idFields[table]]]), structuredClone(row)),
  remove: async (table, key) => tables[table].delete(JSON.stringify(key)),
  removeMemories: async (accountId, rows, epochKey, epoch) => {
    for (const row of rows) await db.remove("memories", [accountId, row.memoryId]);
    await db.put("settings", { accountId, key: epochKey, value: epoch });
  },
};
const commit = memoryCommitFixture(db); let failCommit = false; let beforeCommit;
db.commitMemoryBatch = async (...args) => {
  if (failCommit) { failCommit = false; throw new Error("模拟保存失败"); }
  if (beforeCommit) { const action = beforeCommit; beforeCommit = null; await action(); }
  return commit(...args);
};
let listener; let nextTabId = 0; const sent = [];
const storage = { accountId: "incremental-account", "dtw.firstRunAtMs": 1 };
const chrome = {
  runtime: { getURL: (p = "") => `chrome-extension://test/${p}`, onMessage: { addListener(fn) { listener = fn; } }, onInstalled: { addListener() {} } },
  storage: { local: { get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, storage[key]])), set: async values => Object.assign(storage, values) } },
  alarms: { create() {}, onAlarm: { addListener() {} } },
  tabs: { create: async () => ({ id: ++nextTabId }), sendMessage: async (tabId, message) => { sent.push({ tabId, message }); return { ok: true }; }, remove: async () => {} },
};
const createContext = () => vm.createContext({ DTWDB: db, chrome, crypto: globalThis.crypto, TextEncoder, structuredClone, console, setTimeout });
let context = createContext(); await runWorkbench(context);
const accountId = storage.accountId;
const call = (type, body = {}, tabId = 900) => new Promise(resolve => listener({ type: `dtw:${type}`, accountId: storage.accountId, ...body },
  { url: "chrome-extension://test/options/options.html", tab: { id: tabId, url: "https://chat.deepseek.com/" } }, resolve));
const ok = async (...args) => {
  let timer;
  try {
    const result = await Promise.race([call(...args), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${args[0]}`)), 5000);
    })]);
    assert.equal(result.ok, true, result.error); return result;
  } finally { clearTimeout(timer); }
};
const jobs = async () => (await db.all("jobs", storage.accountId)).filter(job => job.type === "DISTILL");
const latest = async () => (await jobs()).at(-1);
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const finish = async (job, memories) => {
  const reply = await ok("automation-result", { jobId: job.jobId, raw: JSON.stringify({ memories }) }, job.tabId);
  await settle(); return reply;
};
const running = async () => (await jobs()).find(job => job.status === "RUNNING");
const project = (await ok("project-create", { name: "项目 A", goalShort: "交付可离线使用的报表" })).project;
await ok("settings-update", { key: "automationPaused", value: true });
assert.equal((await call("settings-update", { key: "distillEveryTurns", value: 1 })).ok, false);
async function session(id, createdAtMs, lines, projectId = project.projectId) {
  await ok("session-observe", { sessionId: id, loadedHistory: true, createdAtMs });
  if (projectId) await ok("membership-move", { sessionId: id, projectId });
  await history(id, lines);
}
async function history(id, lines, deferMemoryUpdate = true) {
  const records = lines.flatMap((user, index) => [
    { messageId: index * 2 + 1, parentId: index ? index * 2 : null, role: "USER", status: "FINISHED", fragments: [{ type: "REQUEST", content: user }] },
    { messageId: index * 2 + 2, parentId: index * 2 + 1, role: "ASSISTANT", status: "FINISHED", fragments: [{ type: "RESPONSE", content: "确认" }] },
  ]);
  await ok("history-observe", { sessionId: id, records, currentMessageId: records.at(-1).messageId, deferMemoryUpdate });
}
await session("old-a", 100, ["回答用中文", "我做软件开发"]);
assert.equal((await jobs()).length, 0, "只有一个会话时没有旧会话");
await session("old-b", 200, ["项目已经完成"]);
await session("current", 300, ["当前会话不参与更新"]);
assert.equal((await jobs()).length, 4, "两个旧会话分别更新两种记忆");
assert.equal((await jobs()).some(job => job.sourceSessionId === "current"), false);
assert.deepEqual((await jobs()).map(job => [job.sourceSessionId, job.memoryScope]), [
  ["old-a", "PERSONAL"], ["old-a", "PROJECT"], ["old-b", "PERSONAL"], ["old-b", "PROJECT"],
]);
await ok("settings-update", { key: "automationPaused", value: false });
let job = await running();
assert.equal(job.sourceSessionId, "old-a"); assert.equal(job.memoryScope, "PERSONAL");
assert.match(job.payload, /回答用中文/); assert.match(job.payload, /我做软件开发/);
assert.doesNotMatch(job.payload, /交付可离线使用的报表/, "个人整理请求不带项目设置中的目标");
assert.match(job.payload, /追加、修改、合并、删除/); assert.doesNotMatch(job.payload, /"evidence"|disableMemoryIds|sourceMessageId/);
assert.equal((await finish(job, [{ memoryId: "", kind: "偏好", content: "使用中文回答" },
  { memoryId: "", kind: "资料", content: "软件开发者" }])).status, "DONE", "无需证据，也不限制措辞");
const profile = (await db.all("memories", accountId)).find(row => row.kind === "资料");
let preference = (await db.all("memories", accountId)).find(row => row.kind === "偏好");
assert.equal(Object.hasOwn(preference, "evidence"), false);
job = await running(); assert.equal(job.memoryScope, "PROJECT");
assert.match(job.payload, /更新项目记忆/); assert.doesNotMatch(job.payload, /使用中文回答|软件开发者/);
assert.match(job.payload, /项目设置中的目标说明：交付可离线使用的报表/);
await finish(job, [{ memoryId: "", kind: "进展", content: "实现中" }]);
const progress = (await db.all("memories", accountId)).find(row => row.scope === "PROJECT");
job = await running(); assert.equal(job.sourceSessionId, "old-b"); assert.equal(job.memoryScope, "PERSONAL");
assert.match(job.payload, /使用中文回答/); assert.match(job.payload, /软件开发者/);
assert.match(job.payload, /当前已有正文 11 字，其中固定正文 0 字/,
  "整理请求展示全部已有个人正文用量，不计项目记忆和 JSON 外壳");
await ok("project-update", { projectId: project.projectId, goalShort: "交付可导出的离线报表" });
await finish(job, [{ memoryId: preference.memoryId, kind: "偏好", content: "使用简洁中文回答" }]);
assert.equal(await db.get("memories", [accountId, profile.memoryId]), null, "完整列表省略旧条目即删除");
assert.equal((await db.get("memories", [accountId, preference.memoryId])).version, 2);
job = await running(); assert.equal(job.memoryScope, "PROJECT"); assert.match(job.payload, /实现中/);
assert.match(job.payload, /项目设置中的目标说明：交付可导出的离线报表/,
  "项目任务出队时读取当前目标说明");
assert.doesNotMatch(job.payload, /交付可离线使用的报表/);
await finish(job, [{ memoryId: progress.memoryId, kind: "进展", content: "已完成" }]);
assert.equal(await running(), undefined);
assert.equal((await db.all("memoryTurns", accountId)).length, 4, "每个会话每个范围一个处理版本");
const count = (await jobs()).length;
await history("old-a", ["回答用中文", "我做软件开发"], false);
assert.equal((await jobs()).length, count, "未变化的完整会话不会重复自动更新");

// Editing an old session replays it and subsequent sessions in creation order.
await history("old-a", ["回答用英文", "我做软件开发", "已撤回之前的中文偏好"], false);
assert.equal((await jobs()).length, count + 4);
job = await running(); assert.equal(job.sourceSessionId, "old-a"); assert.match(job.payload, /已撤回之前/);
await finish(job, [{ memoryId: preference.memoryId, kind: "偏好", content: "使用英文回答" }]);
await finish(await running(), [{ memoryId: progress.memoryId, kind: "进展", content: "实现中" }]);
job = await running(); assert.equal(job.sourceSessionId, "old-b"); assert.match(job.payload, /使用英文回答/);
await finish(job, [{ memoryId: preference.memoryId, kind: "偏好", content: "使用英文回答" }]);
await finish(await running(), [{ memoryId: progress.memoryId, kind: "进展", content: "已完成" }]);
assert.equal((await db.get("memories", [accountId, progress.memoryId])).content, "已完成", "后续会话恢复较新的项目进展");

// Manual entry points stay independent, including when every session was processed.
await ok("settings-update", { key: "automationPaused", value: true });
let response = await ok("memory-distill-personal");
assert.equal(response.started, true);
assert.deepEqual((await jobs()).filter(job => response.jobIds.includes(job.jobId)).map(job => job.memoryScope), ["PERSONAL", "PERSONAL"]);
for (const id of response.jobIds) await ok("job-queue-update", { jobId: id, action: "cancel" });
response = await ok("memory-distill-project", { projectId: project.projectId });
assert.deepEqual((await jobs()).filter(job => response.jobIds.includes(job.jobId)).map(job => job.memoryScope), ["PROJECT", "PROJECT"]);
assert.equal((await call("job-queue-update", { jobId: response.jobIds[0], action: "down" })).ok, false, "记忆任务不能打乱顺序");
for (const id of response.jobIds) await ok("job-queue-update", { jobId: id, action: "cancel" });

// Failed predecessors are skipped; retries still preserve ordering and reuse valid cached results.
await ok("memory-distill-personal");
await ok("settings-update", { key: "automationPaused", value: false });
job = await running();
const failed = await finish(job, [{ memoryId: "foreign-id", kind: "偏好", content: "错误引用" }]);
assert.equal(failed.status, "FAILED");
assert.equal((await running()).sourceSessionId, "old-b", "失败任务不会阻塞后面的同范围任务");
await finish(await running(), [{ memoryId: preference.memoryId, kind: "偏好", content: "使用英文回答" }]);
assert.equal((await db.get("memories", [accountId, preference.memoryId])).content, "使用英文回答");
await ok("memory-job-retry", { jobId: job.jobId }); job = await running();
await ok("settings-update", { key: "automationPaused", value: true });
failCommit = true;
assert.equal((await finish(job, [{ memoryId: preference.memoryId, kind: "偏好", content: "英文且简洁" }])).status, "FAILED");
assert.equal((await db.get("memories", [accountId, preference.memoryId])).content, "使用英文回答");
const cached = await ok("memory-job-retry", { jobId: job.jobId }); assert.equal(cached.queued, true);
await ok("settings-update", { key: "automationPaused", value: false });
assert.equal((await db.get("jobs", [accountId, job.jobId])).status, "DONE", "恢复队列后复用缓存保存，不重新发送");
await settle();
await finish(await running(), [{ memoryId: preference.memoryId, kind: "偏好", content: "英文且简洁" }]);

// Whole-session validation catches edits to earlier messages between validation and commit.
await ok("memory-distill-personal"); job = await running();
beforeCommit = async () => {
  const row = await db.get("messages", [accountId, "old-a", 1]);
  row.fragments[0].content = "提交时发生变化"; await db.put("messages", row);
};
assert.equal((await finish(job, [])).status, "FAILED");
assert.ok(await db.get("memories", [accountId, preference.memoryId]), "失败不删除旧记忆");
await history("old-a", ["最新内容"], false);
job = await running(); assert.equal(job.sourceSessionId, "old-a");
const staleResult = await call("automation-result", { jobId: (await jobs()).find(row => row.error === "消息或分支已变化").jobId, raw: '{"memories":[]}' });
assert.equal(staleResult.ok, false, "过时结果不得写入");
await finish(job, []); await finish(await running(), []);
assert.equal((await db.all("memories", accountId)).filter(row => row.scope === "PERSONAL").length, 0);
// Remaining project replay tasks can also return empty complete memories.
while (await running()) await finish(await running(), []);
const pinned = (await ok("memory-save", { memory: { scope: "PERSONAL", kind: "偏好", content: "人工固定内容" } })).memory;
await ok("memory-distill-personal");
assert.equal((await finish(await running(), [])).status, "FAILED");
assert.equal((await db.get("memories", [accountId, pinned.memoryId])).content, "人工固定内容", "模型不能删除人工固定内容");
job = (await jobs()).find(row => row.status === "FAILED" && row.error === "不能删除人工固定记忆");
const longPinned = (await ok("memory-save", { memory: { scope: "PERSONAL", kind: "资料", content: "x".repeat(1100) } })).memory;
await ok("memory-job-retry", { jobId: job.jobId });
assert.match((await running()).payload, /当前已有正文 1106 字，其中固定正文 1106 字/,
  "重试读取最新固定记忆用量，避免模型误把全部额度用于新增");
const fixedList = [pinned, longPinned].map(row => ({ memoryId: row.memoryId, kind: row.kind, content: row.content }));
assert.equal((await finish(await running(), fixedList)).status, "DONE", "完整输出允许保留合法的长手写条目");
assert.equal((await running()).sourceSessionId, "old-b", "主动重试前序会话后，后续会话按顺序重放");
await finish(await running(), fixedList);

// Migrate obsolete jobs and metadata without deleting existing memory content.
storage.accountId = "migration-account";
const migratedAccount = storage.accountId;
await db.put("settings", { accountId: migratedAccount, key: "distillEveryTurns", value: 5 });
await db.put("sessions", { accountId: migratedAccount, sessionId: "legacy-old", createdAtMs: 100, purpose: "USER", currentMessageId: 2 });
await db.put("sessions", { accountId: migratedAccount, sessionId: "new", createdAtMs: 200, purpose: "USER" });
await db.put("sessions", { accountId: migratedAccount, sessionId: "helper", createdAtMs: 300, purpose: "MEMORY" });
for (const row of [
  { messageId: 1, parentId: null, role: "USER", status: "FINISHED", fragments: [{ type: "REQUEST", content: "用中文" }] },
  { messageId: 2, parentId: 1, role: "ASSISTANT", status: "FINISHED", fragments: [{ type: "RESPONSE", content: "确认" }] },
]) await db.put("messages", { ...row, accountId: migratedAccount, sessionId: "legacy-old" });
const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([1, 2, "用中文", "确认"])));
await db.put("memories", { accountId: migratedAccount, memoryId: "legacy-memory", scope: "PERSONAL", projectId: null,
  kind: "偏好", content: "中文回答", state: "ACTIVE", version: 1, pinnedByUser: false, evidence: "用中文",
  sourceSessionId: "legacy-old", sourceMessageId: 2,
  sourceFingerprint: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("") });
await db.put("jobs", { accountId: migratedAccount, jobId: "obsolete", type: "DISTILL", status: "RUNNING", incrementalVersion: 1 });
const migrated = await ok("snapshot");
assert.equal((await db.get("jobs", [migratedAccount, "obsolete"])).status, "CANCELLED");
assert.equal(migrated.settings.distillEveryTurns, undefined);
const legacyMemory = migrated.memories.find(row => row.memoryId === "legacy-memory");
assert.equal(legacyMemory.content, "中文回答"); assert.equal(legacyMemory.state, "ACTIVE");
assert.equal(Object.hasOwn(legacyMemory, "evidence"), false); assert.ok(legacyMemory.sourceSessionFingerprint);
assert.equal((await ok("memory-distill-personal")).jobIds.length, 1, "自动化会话不会使最新普通会话成为旧会话");
await finish(await running(), []);
// An oversized session update launches a separate compression conversation before committing the update.
storage.accountId = "compression-session";
await session("compress-old", 100, ["保留我的个人工作方式"], null);
await session("compress-current", 200, ["当前对话"], null);
await ok("memory-distill-personal");
let updating = await running();
const firstTab = updating.tabId;
assert.match(updating.payload, /合计最多 5000 字/);
await finish(updating, [{ memoryId: "", kind: "工作方式", content: "中".repeat(2600) },
  { memoryId: "", kind: "资料", content: "文".repeat(2500) }]);
updating = await running();
assert.ok(updating.compressionInput);
assert.notEqual(updating.tabId, firstTab, "压缩必须启动新的 DeepSeek 会话");
assert.match(updating.payload, /个人长期记忆压缩器/);
assert.match(updating.payload, /约 4000 字，必须少于 5000 字/);
assert.match(updating.payload, /当前正文 5100 字，其中固定正文 0 字/);
assert.equal((await db.all("memories", storage.accountId)).length, 0, "超限结果尚未写入");
await finish(updating, [{ memoryId: updating.compressionInput[0].memoryId, kind: "工作方式", content: "中".repeat(2000) },
  { memoryId: updating.compressionInput[1].memoryId, kind: "资料", content: "文".repeat(2000) }]);
assert.equal((await ok("snapshot")).personalMemoryBudget.used, 4000);
assert.equal((await latest()).status, "DONE");

// Imports/legacy over-limit memories stay intact while a deduplicated COMPACT job runs.
storage.accountId = "compression-stored";
await ok("memory-import", { payload: { format: "dtw-memories-v1", memories: [
  { memoryId: "fixed-a", scope: "PERSONAL", kind: "资料", content: "甲".repeat(2700) },
  { memoryId: "fixed-b", scope: "PERSONAL", kind: "偏好", content: "乙".repeat(2500) },
] } });
const compactJobs = async () => (await db.all("jobs", storage.accountId)).filter(job => job.type === "COMPACT");
let compact = (await compactJobs()).at(-1);
assert.equal(compact.status, "RUNNING");
assert.match(compact.payload, /当前正文 5200 字，其中固定正文 5200 字/);
await ok("snapshot"); await ok("snapshot");
assert.equal((await compactJobs()).length, 1, "重复刷新不重复发起压缩");
assert.equal((await db.all("memories", storage.accountId)).filter(row => row.state === "ACTIVE").length, 2);
await finish(compact, [{ memoryId: "fixed-a", kind: "资料", content: "甲".repeat(700) }]);
assert.equal((await compactJobs()).at(-1).status, "FAILED", "固定条目不能删除");
assert.equal((await db.get("memories", [storage.accountId, "fixed-a"])).content.length, 2700);
await ok("snapshot");
assert.equal((await compactJobs()).length, 1, "失败任务不会自动循环调用模型");
await ok("memory-job-retry", { jobId: compact.jobId }); compact = (await compactJobs()).at(-1);
await finish(compact, [{ memoryId: "fixed-a", kind: "资料", content: "甲".repeat(2700) },
  { memoryId: "fixed-b", kind: "偏好", content: "乙".repeat(2500) }]);
assert.equal((await compactJobs()).at(-1).status, "FAILED", "仍超限或没有缩短时保留原文");
await ok("memory-job-retry", { jobId: compact.jobId }); compact = (await compactJobs()).at(-1);
await finish(compact, [{ memoryId: "fixed-a", kind: "资料", content: "甲".repeat(2000) },
  { memoryId: "fixed-b", kind: "偏好", content: "乙".repeat(2000) }]);
assert.equal((await compactJobs()).at(-1).status, "DONE");
assert.equal((await db.get("memories", [storage.accountId, "fixed-a"])).pinnedByUser, true);
assert.equal((await ok("snapshot")).personalMemoryBudget.used, 4000);

// Exactly 5000 characters across entries triggers compression; edits made during generation win.
const saveFullPersonal = async (character, kind = "资料", pinnedByUser = true) => {
  await ok("memory-save", { memory: { scope: "PERSONAL", kind: "其他", content: "基".repeat(3000), pinnedByUser: false } });
  assert.equal((await compactJobs()).length, 0, "低于 5000 字时不启动压缩");
  return ok("memory-save", { memory: { scope: "PERSONAL", kind, content: character.repeat(2000), pinnedByUser } });
};
storage.accountId = "compression-race";
const full = await saveFullPersonal("字");
compact = (await compactJobs()).at(-1);
assert.equal(compact.status, "RUNNING");
await ok("memory-save", { memory: { ...full.memory, content: "用户已修改的记忆" } });
await finish(compact, [{ memoryId: full.memory.memoryId, kind: "资料", content: "旧压缩结果" }]);
assert.equal((await db.get("memories", [storage.accountId, full.memory.memoryId])).content, "用户已修改的记忆");
assert.equal((await compactJobs()).at(-1).status, "CANCELLED");
storage.accountId = "compression-save-failure";
const savedFull = await saveFullPersonal("原", "偏好");
compact = (await compactJobs()).at(-1);
failCommit = true;
await finish(compact, [{ memoryId: savedFull.memory.memoryId, kind: "偏好", content: "保留关键偏好" }]);
compact = (await compactJobs()).at(-1);
assert.equal(compact.status, "FAILED");
assert.ok(compact.cachedResult);
assert.equal((await db.get("memories", [storage.accountId, savedFull.memory.memoryId])).content.length, 2000);
const tabsBeforeRetry = nextTabId;
await ok("memory-job-retry", { jobId: compact.jobId });
assert.equal(nextTabId, tabsBeforeRetry, "有效压缩结果保存失败后直接重试保存，不再请求模型");
assert.equal((await compactJobs()).at(-1).status, "DONE");
assert.equal((await db.get("memories", [storage.accountId, savedFull.memory.memoryId])).content, "保留关键偏好");
storage.accountId = "compression-cancel";
await ok("settings-update", { key: "automationPaused", value: true });
await saveFullPersonal("字");
compact = (await compactJobs()).at(-1);
assert.equal(compact.status, "QUEUED");
await ok("job-queue-update", { jobId: compact.jobId, action: "cancel" });
await ok("snapshot"); await ok("snapshot");
assert.equal((await compactJobs()).length, 1, "用户取消后相同记忆不立即重建压缩任务");
storage.accountId = "compression-discard";
await db.put("memories", { accountId: storage.accountId, memoryId: "identity", scope: "PERSONAL", projectId: null,
  kind: "资料", content: "软件工程师，经常开发程序", pinnedByUser: false, state: "ACTIVE", version: 1 });
await db.put("memories", { accountId: storage.accountId, memoryId: "one-off", scope: "PERSONAL", projectId: null,
  kind: "其他", content: "一次性请求".repeat(1050), pinnedByUser: false, state: "ACTIVE", version: 1 });
await ok("snapshot"); compact = (await compactJobs()).at(-1);
assert.match(compact.payload, /使用者身份、主要职业、经常从事的工作/);
assert.match(compact.payload, /主动放弃非必要的非固定记忆/);
await finish(compact, [{ memoryId: "identity", kind: "资料", content: "软件工程师，常开发程序" }]);
assert.equal((await db.get("memories", [storage.accountId, "one-off"])), null, "模型可主动放弃非必要条目");
assert.ok(await db.get("memories", [storage.accountId, "identity"]));
storage.accountId = "compression-empty";
await saveFullPersonal("临", "其他", false);
compact = (await compactJobs()).at(-1); await finish(compact, []);
assert.equal((await compactJobs()).at(-1).status, "DONE");
assert.equal((await db.all("memories", storage.accountId)).length, 0, "全部非固定条目均无长期价值时允许清空");
storage.accountId = "compression-resume";
const resumeFull = await saveFullPersonal("身");
compact = (await compactJobs()).at(-1);
await session("resume-old", 100, ["继续更新个人资料"], null);
await session("resume-current", 200, ["最新对话"], null);
await ok("memory-distill-personal");
assert.equal((await latest()).status, "QUEUED", "压缩运行期间个人更新等待");
await finish(compact, [{ memoryId: resumeFull.memory.memoryId, kind: "资料", content: "身".repeat(1000) }]);
// Compression resumes the queue asynchronously, including crypto work outside the timer queue.
await vm.runInContext('memoryPlanningChains.get("compression-resume")', context);
const resumed = await running();
assert.ok(resumed, "压缩成功后自动继续旧会话更新");
assert.equal(resumed.memoryEpoch, 1);
assert.match(resumed.payload, /身身身身/);
await finish(resumed, [{ memoryId: resumeFull.memory.memoryId, kind: "资料", content: "身".repeat(1000) }]);

// A helper can appear in the native sidebar before its first progress event arrives.
storage.accountId = "helper-registration";
await session("helper-source", 100, ["以后先给结论"], null);
await session("helper-current", 200, ["仍在聊天，不是旧会话"], null);
const helperJob = await running();
assert.ok(helperJob);
const beforeHelper = (await jobs()).length;
for (let index = 0; index < 5; index++) {
  const result = await new Promise(resolve => listener({ type: "dtw:session-observe", accountId: storage.accountId,
    sessionId: "helper-native", loadedHistory: true, createdAtMs: 300, title: "个人记忆整理" },
  { tab: { id: helperJob.tabId, url: "https://chat.deepseek.com/a/chat/s/helper-native" } }, resolve));
  assert.equal(result.ok, true, result.error);
  await history("helper-native", ["插件整理请求"], false);
  await ok("memory-reconcile");
  assert.equal((await jobs()).length, beforeHelper, "辅助会话首次出现及反复同步不会把当前普通会话入队或重建任务");
}
assert.equal((await db.get("sessions", [storage.accountId, "helper-native"])).purpose, "MEMORY");
assert.equal((await db.get("jobs", [storage.accountId, helperJob.jobId])).automationSessionId, "helper-native");
assert.equal(await db.get("memberships", [storage.accountId, "helper-native"]), null);
await finish(await running(), []);
await ok("memory-reconcile");
assert.equal(await running(), undefined);
assert.equal((await jobs()).length, beforeHelper, "已完成的同一版本不会因辅助会话同步再次整理");
console.log("Session memory checks passed: ordering, prompts, full replacement, compression, retries and atomic validation.");
