# DeepSeek Pilot 代码检查报告 测试

- 检查日期：2026-10-21
- 版本基线：`df400a1`（0.9.0，Chrome MV3）
- 检查范围：`core/` 全部前后端代码、`tests/` 全部测试、`manifest.json`、README 行为描述
- 方法：逐模块静态审查 + 离线测试执行 + 针对可疑路径的本地最小复现
- 结论：核心链路（项目树、记忆整理、队列、续接、请求改写）设计完整，版本/来源校验和原子写入做得较好；发现 1 个可稳定复现的功能性 bug、1 套已失效的测试基线、若干多账号/性能/数据增长和清洁度问题。

---

## 一、结论摘要

| 级别 | 问题 | 位置 | 状态 |
| --- | --- | --- | --- |
| 高 | 首条「仅附件、无文字」消息被插件拦截，无法发送 | `core/background/workbench.js:1261`、`core/content/workbench.js:1044` | 已本地复现 |
| 高 | 推荐测试中有 2 个断言/替换字符串过期，UI 测试直接失败；`native-ui-test` 已整体过期无法运行 | `tests/*` | 已复现并验证修法 |
| 中 | 多账号共用单一全局 `accountId`，多标签/多账号切换会串数据 | `core/content/workbench.js:1637`、`core/background/workbench.js:738` | 代码确认 |
| 中 | 页面事件通道无鉴权，任意页面脚本/其他扩展可伪造 `dtw:*` 事件 | `core/page/page-network.js:310`、`core/content/workbench.js:1583` | 代码确认 |
| 中 | IndexedDB 无保留期清理，消息/作业/指标无限增长 | `core/logic/db.js`、`core/background/workbench.js` | 代码确认 |
| 中 | 「默认带入项目记忆」开启且没有项目时，新会话发送进入无出口的选择框 | `core/content/workbench.js:1050` | 代码确认 |
| 中 | 消息流式输出期间 DOM 观察 + 1.5s 轮询 + 3s 全量快照，存在明显重复计算 | `core/content/workbench.js:697`、`core/options/options.js:245` | 评估 |
| 中 | 旧的 `dtw:memory-context` / `<task_memory>` 注入链已是死代码，且标签名与现有 `<project_memory>` 不一致 | `core/page/page-network.js:42`、`core/logic/request-body-core.js:95` | 已确认无生产者 |
| 低 | 发送失败后 `submittedAtMs` 未清空，后续指标可能记录错误时间 | `core/content/workbench.js:1026` | 代码确认 |
| 低 | 大多数后台消息无超时，后台卡住时发送按钮会静默失效 | `core/content/workbench.js:48` | 代码确认 |
| 低 | 设置页每 5s 调用的 `snapshot` 同时做迁移、恢复、预算检查，偏重 | `core/options/options.js:111`、`core/background/workbench.js:286` | 评估 |
| 低 | 元数据开关只在项目会话生效，但设置文案未说明 | `core/content/workbench.js:656`、`core/options/options.html:18` | 文档/UI 不一致 |
| 低 | `manage.html` 与 `options.html` 复制了同一份记忆界面，易漂移 | `core/manage/manage.html`、`core/options/options.html` | 维护性 |
| 低 | `knownAtStart` 等状态字段只写不读；`history-core` 返回未使用字段 | `core/content/workbench.js:9,1687`、`core/logic/history-core.js:71` | 死代码 |
| 低 | DeepSeek DOM 选择器依赖混淆类名，站点改版会静默失效 | `core/content/workbench.js`、`core/content/workbench.css` | 固有风险 |

---

## 二、验证结果

### 2.1 可离线运行的测试

| 测试 | 结果 |
| --- | --- |
| `automation-cleanup-test.mjs` | 通过 |
| `automation-queue-test.mjs` | 通过 |
| `automation-reply-test.mjs` | 通过 |
| `classification-disabled-test.mjs` | 通过 |
| `content-send-test.mjs` | 通过 |
| `history-test.mjs` | 通过（32 断言） |
| `memory-display-test.mjs` | 通过 |
| `memory-management-test.mjs` | 通过 |
| `request-body-test.mjs` | 通过 |
| `rollover-test.mjs` | 通过 |
| `session-memory-test.mjs` | 通过 |
| `session-sync-test.mjs` | 通过 |
| `sidebar-ui-test.mjs` | 通过 |
| `visible-history-test.mjs` | 通过 |
| `cleanup-content-test.mjs` | **失败**：fixture 替换字符串过期 |
| `settings-ui-test.mjs` | **失败**：断言文案过期 |
| `native-ui-test.mjs` | **失败**：测试仍在匹配旧版侧边栏实现 |
| `workbench-smoke.mjs` | **环境失败**：Chrome 148 下未发现已加载扩展的 Service Worker |
| `api-recon-test.mjs` | 侦查工具，需要真实登录，未用于结论 |
| `recon-test.mjs` | 侦查工具，只读访问真实站点，未用于结论 |

> 说明：本次检查为定位问题运行了 `recon-test.mjs`（只读 DOM 侦察，写入已被 `.gitignore` 排除的 `docs/`），未发送真实消息。后续默认仍应只跑离线测试。

### 2.2 两个过期测试的验证

把测试中的过期字符串改成当前实现后，两个测试均完整通过：

- `settings-ui-test.mjs:115` 期望 `1 个旧会话 · 更新：…`，当前 `core/options/options.js:49` 输出 `1 个会话 · 更新：…`（`c17afe7` 改的文案，测试没同步）。
- `cleanup-content-test.mjs:20` 替换 `console.warn("[DeepSeek 项目工作台]", …)`，当前源码为 `console.warn("[DeepSeek Pilot]", …)`（品牌改名后测试没同步），导致 `context.fixture` 为 `undefined`，在第 25 行抛 `TypeError`。

也就是说，这两个失败**不是产品回归**，而是测试维护问题；但当前仓库的“已验证”结论不能覆盖它们。

---

## 三、详细问题

### 3.1 【高】首条仅附件消息被拦截（已复现）

**相关代码**

- `core/content/workbench.js:1487`：捕获阶段拦截原生发送按钮点击，`preventDefault()` 后走 `memorySend()`。
- `core/content/workbench.js:1044` `memorySend()`：无论输入是否为空都会请求 `prepare-send`。
- `core/background/workbench.js:1259-1262`：

```js
const block = firstMessage ? await sendMemoryBlock(accountId, project) : "";
if (!block && !project) return { ok: true, native: true };
const rawInput = String(message.rawInput ?? "").trim();
if (!rawInput) throw new Error("输入为空");
```

**触发条件**

1. 账号里存在任意个人记忆（长期使用后必然存在）；
2. 新会话首条消息只上传附件/图片，不输入文字（DeepSeek 允许附件单独发送）；
3. 用户点击发送 → 插件拦截 → 背景生成非空个人记忆块 → `rawInput` 为空 → 抛错；
4. 原生发送已被 `preventDefault()` 阻止，用户看到“输入为空”提示，附件发不出去。

**复现结果**（本地 vm fixture，真实后台源码）：

```
prepare-send empty rawInput -> {"ok":false,"error":"输入为空"}
```

**建议修复**：在 `prepareSend` 中把空输入直接回落原生发送，或允许“只发附件、不注入记忆”：

```js
const rawInput = String(message.rawInput ?? "").trim();
if (!rawInput) return { ok: true, native: true };
```

放在生成 `block` 之前更好，可避免无意义的记忆筛选和作业创建。同时补一条离线测试（附件-only 首条消息应回落到原生发送）。

---

### 3.2 【高】测试基线与实现脱节

| 测试 | 过期内容 | 证据 |
| --- | --- | --- |
| `tests/settings-ui-test.mjs:115` | 仍断言 `1 个旧会话` | 当前 `core/options/options.js:49` 为 `1 个会话`；仅改字符串后测试通过 |
| `tests/cleanup-content-test.mjs:20` | 仍替换 `[DeepSeek 项目工作台]` | 当前 `core/content/workbench.js:1703` 为 `[DeepSeek Pilot]`；仅改字符串后测试通过 |
| `tests/native-ui-test.mjs` | `dtw-tools-root`、`dtw-project-group`、`dtw-conversation-row`、`new-task`、`toggle-auto-classify`、`settings-memory`、`facts-memory`、`dtw.sidebar.v1`、`DTWFS`，以及等待 `/background.js$` | 当前实现使用 `.dtw-tree`、`data-action="create-project"`、IndexedDB，Service Worker 为 `/background/workbench.js`；`grep` 确认这些旧标识在 `core/` 中已不存在 |
| `tests/workbench-smoke.mjs` | 依赖 Chrome 通过 `--load-extension` 加载扩展 | 本机 Chrome 148 下 CDP 只看到页面目标，没有 `service_worker` 目标 |

**影响**：UI/端到端回归完全失效；README 与提交说明中“settings UI / native UI 已覆盖”的说法目前不可信。`native-ui-test` 还会覆盖 `.live-profile` 的登录态，已不适合作为当前回归测试。

**建议**：

1. 修复前 2 个字符串（低风险）。
2. 重写或删除 `native-ui-test.mjs`，按当前 `.dtw-tree`/`data-action` 重新实现；至少把 Service Worker 路径改为 `/background/workbench.js`。
3. 在 CI 中只跑离线套件，并明确列出“本机 Chrome 浏览器测试”单独执行。
4. 每次改 UI 文案时同步更新断言，或把文案断言改为更稳定的结构断言。

---

### 3.3 【中】多账号/多标签共用单一 `accountId`

**相关代码**

- `core/content/workbench.js:1637`：每个 DeepSeek 标签页初始化时写入全局 `chrome.storage.local.accountId`。
- `core/background/workbench.js:722,738,750`：队列调度、清理、重排都用全局 `accountId`。
- `core/background/workbench.js:1507`：`storage.onChanged` 一变化就重跑队列。

**现象/风险**

- 两个标签页登录不同 DeepSeek 账号时，后初始化的账号覆盖前一个；两个页面共用同一份作业队列和“当前账号”判断。
- 后台在 `drainJobQueueNow` 中可能按账号 A 的 `accountId` 取出账号 B 的 queued 作业并跳过，或后台记忆任务在切账号瞬间写入错误的账号命名空间。
- `state.pendingNewProjectId`、`pendingNewConversationAt` 等页面状态在账号切换时未清空（`initializeAccount` 只清了部分），存在跨账号误归属的极端路径。

**建议**：明确产品只支持单账号（写入 README/启动提示），或在 `chrome.storage.session`/标签页维度保存 `accountId`，后台以消息里的 accountId 为准，禁止从 global storage 推导队列账号。

---

### 3.4 【中】页面事件通道无鉴权

**相关代码**

- MAIN world 监听：`dtw:network-arm`、`dtw:delete-request`、`dtw:memory-context`、`dtw:edit-context`（`core/page/page-network.js:34-45, 310, 334`）。
- ISOLATED world 监听：`dtw:account-ready`、`dtw:history-observed`、`dtw:session-list`、`dtw:sessions-deleted`、`dtw:session-times`、`dtw:request-issue`（`core/content/workbench.js:903-904, 1583-1614, 1656`）。

这些 `CustomEvent` 在同一页面的所有 world 间可见。DeepSeek 页面脚本或**其他扩展的 content script** 都可以直接 `dispatchEvent` 伪造：

- `dtw:account-ready`：把数据写进任意伪造的 account 命名空间；
- `dtw:history-observed`：写入伪造的历史/消息；
- `dtw:delete-request`：以当前登录态删除任意 DeepSeek 会话；
- `dtw:network-arm`：改写下一次聊天请求的内容。

**评估**：正常站点代码不会这么做，但这属于可被第三方利用的信任边界。建议：

1. 页面→内容脚本的敏感事件携带一次性 token（由内容脚本生成、只在 `chrome.runtime` 握手时交换），MAIN world 只接受带 token 的事件；
2. 或把敏感操作改为经 `chrome.runtime.sendMessage` 走扩展内部通道，页面事件只做只读通知；
3. 至少对 `dtw:delete-request`、`dtw:network-arm` 校验来源请求的 accountId 与当前页面。

---

### 3.5 【中】IndexedDB 无保留期清理

**现状**

- `grep` 未发现对 `jobs`、`messages`、`metrics` 的 `DB.remove` 调用。
- `markDeleted` 只把 session 标记为 `deleted`，消息、membership、metrics 全部保留。
- 每个会话都会保存完整历史分支（每条消息一条记录），作业完成记录只影响 `readSnapshot` 的 7 天过滤，不删除。
- 记忆历史固定保留 5 份快照，属于有意设计；但 `messages` 和 `jobs` 会随使用无限增长。

**影响**：长期使用后 IndexedDB 体积持续上涨，Chrome 扩展存储配额和 `getAll` 性能都会受影响；`DB.all("messages")` 类调用在 UI 轮询中也会变慢。

**建议**：

1. 增加清理作业：删除 30 天前的 `DONE/CANCELLED/DISMISSED/FAILED` jobs、已删除会话的 messages/memberships、N 天前的 metrics；
2. 在设置页提供“清理本地历史数据”入口；
3. 为 `messages` 增加按 session 的旧数据裁剪策略（仅保留当前分支 + 最近 N 个编辑分支）。

---

### 3.6 【中】「默认带入项目记忆」开启时的发送死路

**相关代码**：`core/content/workbench.js:1050-1052`、`1303-1312`。

```js
if (!currentId() && newChatMemoryEnabled() && !state.pendingNewProjectId) {
  state.pickerSessionId = NEW_CHAT; renderModal(); return;
}
```

当 `memoryModeDefault = true` 时，每个新会话首次发送都会弹出“选择项目”。弹窗只有项目列表、“新建项目”和关闭按钮，**没有“本次不带入项目记忆直接发送”**。如果没有项目，弹窗只显示“请先新建项目”，用户必须：

1. 关闭弹窗；
2. 点输入框下方的“项目记忆”按钮关闭记忆；
3. 再次发送。

这是一个不直观的出口。**建议**：在选择框底部增加“不带入记忆，直接发送”选项（等价于 `newChatMemoryOff = true` 后继续发送），或在没有项目时自动回落原生发送并提示。

---

### 3.7 【中】流式输出期间的重复 DOM/数据库工作

**证据**

- `core/content/workbench.js:697` `observeMessageDisplay` 的 MutationObserver 每收到消息区变更就同步执行 `messageNodes()`、`renderMemoryEditors()`、`renderMessageInfo()`，没有 rAF/时间节流。流式回答每秒产生多次 `characterData`/`childList` 变更。
- `core/content/workbench.js:1688` 的 1.5s 轮询又执行 `syncVisibleSessions`、`titleSync`、`checkTurn`、`syncSessionTimes`、`renderTree`、`renderMemoryButton`、`syncChangedSessions`，并且每 3s `refresh()` 拉一次 `sidebar-snapshot`（返回全部 memories/projects/sessions/memberships/jobs/metrics）。
- 设置页 `core/options/options.js:245` 每 5s 调一次 `snapshot`；`core/manage/manage.js:258` 每 10s 再调一次。`snapshot` 会跑旧数据迁移、`checkMemoryRecovery`（IndexedDB 完整性扫描）、`enforcePersonalMemoryBudget`，并在达到预算时计算 SHA-256 指纹和入队压缩。
- `core/background/workbench.js:182-186` 的 `settings()` 每次执行 `DB.all("settings")`，后台有 20+ 处调用。
- `core/background/workbench.js:531-548` 的 `observeHistory` 对最多 500 条消息逐条 `await DB.get`。

**影响**：长会话、记忆条目多时会出现滚动/输入卡顿，Service Worker 频繁唤醒和 IndexedDB 事务排队，也可能拖慢 `turn-completed` 等关键写入（所有记忆写入共享 `mutateMemories` 串行链）。

**建议**：

1. `observeMessageDisplay` 用 `requestAnimationFrame` 合并，只处理与本轮新增节点相关的消息；
2. 为设置页/侧边栏提供轻量 `*_summary` 查询，`snapshot` 只在显式刷新或状态变化时调用；
3. `settings()` 增加内存缓存（按账号），失效时由 `settings-update` 主动清空；
4. `observeHistory` 先 `by("messages", "bySession", …)` 一次性读出旧记录再合并；
5. 轮询周期按页面可见性调整（`document.hidden` 时降频或暂停）。

---

### 3.8 【中】失效的记忆注入链（死代码 + 潜在双注入）

**证据**

- `core/page/page-network.js:42-45` 监听 `dtw:memory-context`，但 `grep` 全仓库只有测试会派发该事件，生产代码没有生产者。
- `core/page/page-network.js:279-295, 448, 516` 的 `injectMemoryBody` 依赖 `memoryBlock`，因此永远不生效。
- `core/logic/request-body-core.js:89-111` 的 `injectMemoryIntoRequest` 只接受 `<task_memory>…</task_memory>`，而当前后台 `sendMemoryBlock` 生成的是 `<project_memory>…</project_memory>`（`core/background/workbench.js:1243`）。
- `stripLeadingMemoryBlock` 同样只识别 `<task_memory>`。

**影响**：约 60 行 MAIN world/核心逻辑长期不执行，测试却在维护它；如果将来有人重新接上 `dtw:memory-context`，标签不匹配会导致注入失败或与 `prepare-send` 路径重复注入。

**建议**：删除该路径及对应测试，或统一改成 `<project_memory>` 并明确唯一注入点（推荐只保留 `prepare-send`）。

---

### 3.9 【低】其他逻辑问题

1. **发送失败指标残留**：`core/content/workbench.js:1026` 在 `doProjectSend` 中先写 `state.submittedAtMs`，失败路径（1037-1042）不回滚。之后下一次 `turn-completed` 可能把旧时间戳写入 metrics，得到错误的首字/总耗时。建议失败时清空 `submittedAtMs`、`firstOutputAtMs`、`submittedRoute`。
2. **后台消息无超时**：`core/content/workbench.js:48-60` 只有 `sidebar-snapshot` 有 10s 超时。若后台因 IndexedDB 事务卡住而不回消息，`pendingSend` 会一直为 `true`，用户再次点发送时直接静默返回（1045）。建议所有交互类消息统一超时并提示。
3. **`waitEvent` 会被无关错误打断**：`core/content/workbench.js:62-73` 的 `bad` 监听会在 `dtw:network-error` 的 `requestId` 为空时也 reject，例如 MAIN world 启动时 “请求体改写核心未加载”。启动阶段 `getAccount()` 可能因此提前返回 null，导致 `startupFailed`。建议只处理明确匹配的 `requestId`，空 id 单独记录日志。
4. **`sendStatus`/`prepareSend` 的 membership 空值**：`core/background/workbench.js:1317-1323` 在 ROLLOVER 确认时直接访问 `membership.projectId`；如果 `observeSession` 因会话已存在而没创建 membership，会抛 `TypeError`。建议 `membership ||= {…}` 后再写。
5. **其他标签页可能先把辅助会话登记成普通会话**：后台只有在“发送消息的标签页正处于该会话路由”时才调用 `recordAutomationSession`（`core/background/workbench.js:450-460`）。其他标签页的 `syncVisibleSessions` 可能先 `observeSession` 把辅助会话建成 `USER`，造成一次误入队/误记忆，随后才被修正。建议后台直接按 `RUNNING` job 的 `automationSessionId` 识别，而不是依赖发送标签页的路由。
6. **`enqueuePersonalCompression` 的 started 语义**：当已有同指纹的 `FAILED/NEEDS_REVIEW` 压缩作业时返回 `started: true`，但实际不会运行，UI 提示“已自动发起压缩，完成后请重新保存”会误导。建议区分 `started/running/awaitingRetry`。
7. **禁言检测可能误判**：`core/content/workbench.js:302-321` 在没有可见输入框的页面上扫描全页文本，任何包含“禁言/账号受限”的普通帮助文本都可能触发 `ACCOUNT_RESTRICTED` 并暂停所有主动请求。建议只匹配明确的错误容器/提示区域，或要求同时出现“无法发送/受限”等上下文。
8. **元数据只在项目会话显示**：`core/content/workbench.js:656` 要求 `membership.projectId`，而设置项文案是“显示消息 token 与时间”（`core/options/options.html:18`），README 也没说仅项目会话。建议在设置项帮助中注明，或对所有会话显示。
9. **首次运行时间按插件而非账号**：`core/background/workbench.js:40-49` 的 `dtw.firstRunAtMs` 是全局值，第二个 DeepSeek 账号的 `memoryStartAtMs` 会继承第一个账号的首次运行时间。通常无害，但账号迁移时语义不准确。
10. **`state` 字段隐式创建**：`cleanupSignature`、`initializing`、`syncingUi`、`lastRefresh`、`automationJobId`、`automationSessionId`、`rolloverSessionId` 未在初始 `state` 对象里声明，拼写错误不会被发现。建议集中声明。
11. **`history-core` 有未使用返回字段**：`messages`、`revision`、`captureIncomplete`、`source` 在生产代码中无人读取，`parsedMessages` 仍被构造（`core/logic/history-core.js:43-78`）。可随死代码清理一起删除。
12. **`knownAtStart` 死状态**：`core/content/workbench.js:9` 初始化、`1687` 只写一次，从未读取。
13. **`web_accessible_resources` 多余**：`core/manifest.json` 暴露了 `logic/request-body-core.js`、`page/page-network.js`；这两个文件已通过 `content_scripts` 的 `world: "MAIN"` 注入，无需页面可访问。建议删除，减少可被页面探测/加载的面。
14. **`tabs` 权限可能多余**：`chrome.tabs.create/sendMessage/remove` 不需要 `tabs` 权限；`chrome.tabs.query({url})` 可由 `host_permissions` 覆盖。建议验证后收紧权限。
15. **缺少扩展图标**：`manifest.json` 没有 `icons`，Chrome 会显示默认图标；不影响功能，但作为发布版不完整。
16. **`manage.html` 与设置页重复**：`core/manage/manage.html` 和 `core/options/options.html` 内嵌了几乎相同的记忆界面 DOM（约 6 行压缩 HTML），但 `manage.html` 未被 manifest 引用。建议合并为同一页面或删除 `manage.html`，避免两处漂移。

---

## 四、前端（内容脚本）专项检查

| 功能点 | 结论 |
| --- | --- |
| 侧边栏项目树挂载/隐藏原生列表 | 逻辑完整；依赖 `.ds-scroll-area`、宽度 190–430px 等启发式，窗口极窄/极宽时可能找不到列表（`findSidebar`，129-139） |
| 项目创建/重命名/目标/置顶/归档 | 正常；允许重名，重名项目只能靠 ID 区分 |
| 会话移动/移出/收纳/恢复 | 正常；自动化收纳要求先移出项目并关闭记忆，校验合理 |
| 新建项目会话 | 正常；`pendingNewProjectId` 在原生新对话按钮或页面跳转时可能残留（见 3.3） |
| 会话菜单（改名/置顶/分享/删除/多选） | 通过模拟原生菜单实现，原生菜单被隐藏；分享/删除依赖原生弹窗，后续交互需用户完成 |
| 消息记忆显示/编辑合并 | 逻辑完整（隐藏 `<project_memory>`、编辑时保留隐藏背景）；依赖文本节点替换，长会话有性能成本 |
| token/时间元数据 | 仅项目会话；见 3.9-8 |
| 发送拦截与记忆注入 | 正常路径通过；附件-only 首条消息被拦截（3.1） |
| 项目记忆按钮 | 克隆原生 toggle 实现；若 DeepSeek 同时隐藏“深度思考/智能搜索”两个开关，则按钮不渲染（`composerToggles`，391-425） |
| 主题/样式 | 使用 `body.dark` 判断；若站点改为 `html.dark` 会退回暗色变量，需跟随站点 |
| 可访问性 | 树按钮/焦点恢复/`aria-expanded` 基本到位；自定义菜单无 `aria-activedescendant`，但支持方向键与 Escape |

**DOM 选择器脆弱点**（站点改版会静默失效，建议集中到常量并加启动自检提示）：

- 混淆类名：`d29f3d7d`、`_9663006`、`_4f9bf79._43c05b5`（`messageRole`，491-498）
- `.ds-scroll-area`、`.ds-textarea textarea`、`.ProseMirror`（`findEditor`/`listContainer`）
- `button.ds-button--primary.ds-button--circle`（`nativeSend`）
- 原生下拉 `.ds-dropdown-menu` 与菜单项文本（`nativeSessionAction`）
- CSS 中按 SVG path 精确匹配隐藏原生图标（`core/content/workbench.css:3`）

---

## 五、后端（Service Worker）专项检查

| 功能点 | 结论 |
| --- | --- |
| 消息路由/来源校验 | `accountFor` 校验来源为扩展页或 `https://chat.deepseek.com/`，合理（`172-180`） |
| 项目/归属 CRUD | 正常；版本号和手动锁使用一致 |
| 历史观察与分支失效 | 正常；编辑/切换分支会把不再活跃来源的 ACTIVE 记忆置 STALE |
| 记忆整理队列 | 串行、按会话顺序、指纹去重、强制重试、取消保留已有记忆，设计完整 |
| 记忆压缩 | 有指纹、epoch、固定条目保护、字数必须下降的校验，较稳 |
| 记忆快照/恢复 | 5 份快照 + 删除意图（forgotten）+ 原子提交，是本项目最可靠的部分 |
| 作业队列 | 单并发、心跳、失联标签页检测、暂停、限流/登录/禁言熔断，完整 |
| 辅助会话清理 | 只清理 `automationOrigin=PLUGIN` 且 >10 条，保护运行中任务，合理 |
| 续接 | 预算估算/确认后清草稿/等待回复完成，完整；membership 空值见 3.9-4 |
| 设置更新 | 输入范围和枚举校验齐全；`memoryStartAtMs` 会清理待处理队列 |
| 数据保留 | 无清理（3.5） |

**值得保留的设计**：作业来源 tab 校验、`inputVersion`/`memoryEpoch`/`sessionRef.fingerprint` 三重防旧结果、`commitMemoryBatch` 原子写、删除意图与快照清理、限流冷却。

---

## 六、测试与文档建议

1. **修 2 个过期断言**（`settings-ui-test:115`、`cleanup-content-test:20`）。
2. **重写 `native-ui-test`**：它当前测的是 2025 年版本的侧边栏（`dtw-project-group`/`dtw.sidebar.v1`），与现有 `.dtw-tree` 架构不兼容；至少修 Service Worker 路径 `/background/workbench.js`。
3. **`workbench-smoke` 增加环境探测**：如果 CDP 未发现扩展 Service Worker，输出明确“当前 Chrome 不支持自动加载扩展，请手动加载后重试”，而不是超时。
4. **补关键路径测试**：
   - 附件-only 首条消息（应原生发送）；
   - 新会话 + `memoryModeDefault` + 无项目（应可退出选择框并发送）；
   - 两个标签页不同账号的隔离；
   - 两条 ROLLOVER/SEND 交错确认；
   - 流式长回答下的 MutationObserver 性能上限（可用计数断言）。
5. **文档**：在 README 中明确“token/时间行仅项目会话显示”；补充多账号限制；把“附件消息”行为写清楚（当前 README 只提到“上传附件并附带文字”）。
6. **CI**：把离线套件加入 CI；浏览器类测试标记为 `manual`，避免把需要真实登录的 recon 工具混进回归。

---

## 七、修复优先级建议

### 立即（本轮可做）

1. `prepareSend` 空输入回落原生发送（3.1）。
2. 更新 2 个过期测试字符串，恢复离线 UI 回归（3.2）。
3. 清空发送失败时的指标状态（3.9-1）。
4. 在选择框增加“不带入记忆直接发送”（3.6）。

### 近期

5. 删除或统一死注入链（3.8）。
6. 补充 IndexedDB 保留期清理（3.5）。
7. 设置页拆出轻量快照，降低 5s 轮询成本（3.7）。
8. 多账号：明确单账号约束，或改造 `accountId` 的标签页归属（3.3）。
9. 敏感 `dtw:*` 事件加 token/改走 runtime 消息（3.4）。

### 迭代

10. 重写 `native-ui-test` 与 `workbench-smoke` 的环境探测。
11. 清理死字段/未使用返回值和 `manage.html` 重复界面。
12. 收紧 `manifest` 权限与 `web_accessible_resources`。

---

## 八、总体评价

- **架构**：内容脚本负责 DOM/交互，MAIN world 负责网络改写，Service Worker 负责数据与队列，职责划分清楚。
- **数据安全**：记忆写入的多重版本/指纹/快照校验明显高于同类插件，删除意图和固定条目保护考虑周到。
- **主要短板**：测试基线未跟随重构；异常输入（附件-only）和少数空值/超时路径没有兜底；长会话与长期使用的性能/存储没有上限策略。
- **上线建议**：在修复 3.1、3.2、3.5 前不宜宣称“完整功能已验证”；修完后建议用真实账号做一次手动回归（新建项目 → 首条消息带附件 → 记忆整理 → 长对话续接 → 自动化清理）。

---

## 九、修复记录（2026-10-21）

本批次以“减少记忆管理动作、消除发送阻断”为优先，已完成：

| 原问题 | 修复方式 |
| --- | --- |
| 3.1 附件-only 首条消息被拦截 | `prepareSend` 在生成记忆块前检查文本，空文本直接回落原生发送；新增 `tests/empty-send-test.mjs` |
| 3.2 两个测试字符串过期 | 同步 `settings-ui-test`、`cleanup-content-test` 到当前实现 |
| 3.6 新会话强制选择项目、无项目时无法发送 | 移除发送前的强制选择框；未选项目时按个人记忆规则直接发送。`memoryModeDefault` 只作用于已归属/之后移入项目的会话，按钮状态改为反映当前是否已选项目 |
| 3.5 本地历史无限增长 | 浏览器启动/扩展更新时清理：30 天前已完成作业、90 天前耗时指标、7 天前已删除会话的消息与归属记录 |
| 3.7 流式期间重复渲染 | 消息编辑仍同步恢复；生成中改为每帧最多一次；设置页 5s 队列轮询改用轻量 `queue-snapshot`；`observeHistory` 改为一次读取旧消息；删除未使用的 `knownAtStart` |
| 3.9-1 发送失败指标残留 | 失败/未确认时清空 `submittedAtMs`、`submittedRoute`、`firstOutputAtMs` |
| 3.9-4 续接 membership 空值 | 缺失时创建 membership，避免 `TypeError` |
| 3.9-5 其他标签页抢先登记辅助会话 | 新会话观察时同时按运行中作业的 `automationSessionId` 识别辅助会话 |
| 3.9-8 元数据仅项目会话显示 | 设置页帮助文案明确“项目会话” |
| 3.9-12 `knownAtStart` 死状态 | 删除 |

仍未处理（保留在报告中供后续排期）：

- 3.3 多账号全局 `accountId`（需要产品层面决定单账号或改造存储键）；已先清理账号切换时的页面级待发送/选择状态，并在前后台校验自动化/续接任务的账号，避免跨账号写入。
- 3.4 页面事件通道鉴权（受 MAIN/ISOLATED world 通信模型限制，需要单独设计）。
- 3.8 旧 `<task_memory>` 注入链（当前无生产者，删除会牵动多个测试，建议单独一次清理提交）。
- 3.9-7 禁言检测的误判风险：现有测试要求“编辑器被替换成禁言提示”时仍能识别，因此暂未缩小扫描范围；后续可改为只匹配提示容器。
- `native-ui-test.mjs` 重写、`manage.html` 合并、manifest 权限收紧、3.9 中其余低优先级项。

验证：`empty-send`、`content-send`、`cleanup-content`、`settings-ui`、`sidebar-ui`、`automation-*`、`session-memory`、`session-sync`、`rollover`、`memory-management`、`visible-history`、`history`、`request-body`、`memory-display` 全部通过；`git diff --check` 通过。

---

## 十、修复记录（2026-10-21，第二批）

本批聚焦“后台卡住时不静默失败”和“跨账号不串数据”：

| 原问题 | 修复方式 |
| --- | --- |
| 3.9-2 大多数后台消息无超时，后台卡住时发送按钮静默失效 | `send()` 为所有消息加超时：侧边栏快照 10s，完整快照/发送准备 30s，其余 20s；超时后提示并释放 `pendingSend` |
| 3.9-3 无 `requestId` 的全局错误会打断所有 wait | `waitEvent` 只处理 `requestId` 匹配的错误，MAIN world 启动提示不再导致初始化失败 |
| 3.3 自动化任务可能在其他账号标签页执行 | 后台下发任务时携带 `accountId`，内容脚本账号不一致时以 `ACCOUNT_MISMATCH` 停止发送/续接 |
| 3.7 侧边栏每 3s 拉取含全部记忆/指标的快照 | `sidebar-snapshot` 改为轻量读取，不再读取 memories/metrics/memoryHistory |
| 3.9-6 压缩已失败/取消时仍提示“已自动发起压缩” | 按任务实际状态返回提示：运行中、失败去设置页重试、已取消去重新发起、无可压缩旧记忆；新增测试锁定 |

验证：17 个离线测试（含新增断言）与 `git diff --check` 通过；`sidebar-ui-test` 连续运行时偶尔受本机 Chrome 时序影响，单独运行稳定通过。
