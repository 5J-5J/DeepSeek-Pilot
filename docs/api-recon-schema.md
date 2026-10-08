# DeepSeek Web 抓包字段参考（非开发 Spec）

> 开发请先读 [DeepSeek任务工作台-项目目标与功能流程.md](DeepSeek任务工作台-项目目标与功能流程.md) 和 [本地存储数据表设计.md](本地存储数据表设计.md)。本文件记录一次抓包观察及当时的 SQLite 分析，不要求照搬全部表、接口调用方式或旧会话同步方案。尤其不要按下文的 credentials 示例持久化登录令牌、设备指纹或风控数据；当前 Spec 只需保存必要的 DSW 会话与消息镜像。

## 原始抓包分析

> 全部字段与样例值来自 [api-recon.md](api-recon.md) 的真实抓包（2026-09-24，客户端 x-client-version 2.5.0）。
> 方言：SQLite。时间统一说明：**DeepSeek 原生时间是 unix 秒浮点**（如 `1790245739.842`），
> 落库直接用 `REAL` 存秒，或 `INTEGER` 存毫秒（×1000），二选一并保持一致。

## 0. 表总览

| 表 | 主键 | 数据来源接口 | 同步时机 | 对应 DSW 功能 |
|---|---|---|---|---|
| `chat_sessions` | `id`（UUID） | `GET /api/v0/chat_session/fetch_page` | 被动 clone 响应（页面每次打开/发消息/滚动翻页都会拉） | 左侧栏会话列表 + 置顶区 +「今天/昨天/7 天内/更早」分组 |
| `chat_messages` | (`chat_session_id`, `message_id`) 复合 | `GET /api/v0/chat/history_messages?chat_session_id=` | 主动拉（带 Bearer），或被动 clone | 打开会话后的消息流；编辑/重新生成产生消息分支树 |
| `message_fragments` | (`chat_session_id`, `message_id`, `fragment_id`) 复合 | 同上（`chat_messages[].fragments[]`） | 同上 | 用户输入原文 /「深度思考」折叠块 / 回复正文 |
| `users` | `id`（UUID） | `GET /api/v0/users/current` | 登录后一次 | 右上角头像 → 个人中心（昵称、微信绑定、掩码手机号） |
| `credentials` | `key` | localStorage（`userToken` / `deepseek-device-id:chat` / `hif_leim_cached` / `hif_dliq_cached`） | 每次抓包刷新 | 登录态本身（Bearer）+ 设备/风控指纹 |
| `client_settings` | (`scope`, `name`) | `GET /api/v0/client/settings?scope=…` | 低频；限额值用 | DSW 无直接 UI，但决定文件上限、token 限额、联网搜索默认态等全部行为 |

不建表的数据（原因见 §8）：SSE 原始事件流、PoW 挑战、`cache_control` 等同步元数据。
写操作与搜索 API（§5、§6）不落表，直接调用后刷新对应表即可。

## 1. chat_sessions —— 会话列表

**对应 DSW 功能**：原生左侧栏的整个会话列表——置顶区、「今天/昨天/N 天内/更早」分组、滚到底自动翻页，数据全部来自 `fetch_page`。标题两种来源：首轮回复后 SSE 里 `{"content":"…"}` 事件自动生成（`title_type='SYSTEM'`），或用户 ••• 菜单手动「重命名」（走 §5 `update_title`）。
**插件用途**：你的"项目工作台"按会话归类的底层数据；被动 clone 侧栏请求即可零成本全量同步（游标翻页拿 300+ 条）；`updated_at` 排序、置顶同步（`batch_update_pinned`）都直接映射。

来源响应路径：`data.biz_data.chat_sessions[]`（每页 100 条，`has_more` 翻页，游标 = 末条 `updated_at`）

```sql
CREATE TABLE chat_sessions (
  id                  TEXT PRIMARY KEY,     -- UUID：'837d6e8a-4f66-4b0d-b0cf-a6fbf0829540'
  title               TEXT,                 -- '会话标题自动生成'；title_type='WIP' 时为 NULL
  title_type          TEXT NOT NULL,        -- 实抓 'SYSTEM' | 'WIP'
  pinned              INTEGER NOT NULL DEFAULT 0,  -- 0/1
  model_type          TEXT,                 -- 实抓 'default'
  agent               TEXT,                 -- 实抓 'chat'
  seq_id              INTEGER,              -- 212409880（服务端全局递增，可当排序辅助键）
  version             INTEGER,              -- 2（编辑消息会增长）
  current_message_id  INTEGER,              -- 2：当前分支末端消息 id，分支解析入口（§4）
  is_empty            INTEGER,              -- 0/1
  inserted_at         REAL,                 -- unix 秒浮点：1790165329.203
  updated_at          REAL,                 -- unix 秒浮点：1790245739.842（★翻页游标字段）
  fetched_at          REAL NOT NULL         -- 本地抓取时间戳（毫秒），同步用
);
CREATE INDEX idx_sessions_updated ON chat_sessions(updated_at DESC);
```

## 2. chat_messages —— 消息（★主键陷阱：message_id 跨会话不唯一）

**对应 DSW 功能**：点进会话后渲染的整条消息流；消息悬停操作条（复制/编辑/重新生成）不改旧数据——**编辑和重新生成都是在 `parent_id` 树上追加新分支**（DSW 界面上方出现的分支切换器 `< 2/2 >` 就是遍历这棵树）。`ban_edit/ban_regenerate` 就是操作条按钮置灰的开关。
**插件用途**：会话原文存档（你的 live-test 已在做）、token 预算监控（末条 `accumulated_token_usage` ≈ 当前上下文体积，对照 §4 限额 890880 做进度条）、导出/检索都以此表为准；**只导当前分支**（§7 视图），否则编辑过的会话会把废弃分支一起导出去。

来源响应路径：`data.biz_data.chat_messages[]`

```sql
CREATE TABLE chat_messages (
  chat_session_id      TEXT NOT NULL REFERENCES chat_sessions(id),
  message_id           INTEGER NOT NULL,    -- 会话内自增小整数（1,2,3…），★新会话从 1 重新计数
  parent_id            INTEGER,             -- 同会话上一条消息 id；NULL=首条；★编辑会产生分叉
  role                 TEXT NOT NULL,       -- 'USER' | 'ASSISTANT'（实抓大写）
  status               TEXT,                -- 'FINISHED' | 'WIP'
  model                TEXT,                -- 实抓恒 ''，保留字段
  thinking_enabled     INTEGER NOT NULL DEFAULT 0,  -- 0/1
  search_enabled       INTEGER NOT NULL DEFAULT 0,  -- 0/1
  ban_edit             INTEGER,             -- 0/1
  ban_regenerate       INTEGER,             -- 0/1
  accumulated_token_usage INTEGER,          -- ★纯数字（INTEGER）。该分支截至此消息的累计 token。
                                            -- 实抓序列：39,40,92,129,72,74 —— 末条 ≈ 当前上下文体积
  auto_continue        INTEGER,
  search_triggered     INTEGER,
  has_pending_fragment INTEGER,
  inserted_at          REAL,                -- unix 秒浮点：1790247327.5749998
  PRIMARY KEY (chat_session_id, message_id)
);
CREATE INDEX idx_messages_parent ON chat_messages(chat_session_id, parent_id);
```

实抓注意：

- **`accumulated_token_usage` 是数字不是对象**（实抓纠正，别按 `{input_tokens,…}` 建列）。
- **编辑消息不改旧记录，而是追加新分支**：编辑 msg3 后生成 msg5/6，旧 msg3/4 仍在 history 里。当前分支要靠 `parent_id` 链解析（§4）。
- 服务端**没有** prompt/completion 拆分 token，别设计不存在的列。

## 3. message_fragments —— 消息正文分片

**对应 DSW 功能**：一条消息在界面上的三种呈现——`REQUEST`=你输入框发出的原文、`THINK`=「已深度思考（用时 N 秒）」那个可折叠块（`elapsed_secs` 就是标题里的用时）、`RESPONSE`=正文；联网搜索的引用来源挂在 `references_json`（正文里的蓝色角标）。思考回合一条消息 = `[THINK, RESPONSE]` 两个分片。
**插件用途**：导出 Markdown 时按 `type` 分流（思考放 `<details>` 折叠、正文照排）；做"只搜思考过程/只搜正文"的检索过滤；`REQUEST` 分片是用户原文——比 DOM 抓取干净，你的记忆整理管线采集会话原文应从这里取。

来源路径：`chat_messages[].fragments[]`

```sql
CREATE TABLE message_fragments (
  chat_session_id TEXT NOT NULL,
  message_id      INTEGER NOT NULL,
  fragment_id     INTEGER NOT NULL,   -- 消息内编号；★不同消息各自编号（都见过的 1、2），仅三元组唯一
  type            TEXT NOT NULL,      -- 实抓三种：'REQUEST'(用户原文) | 'RESPONSE'(正文) | 'THINK'(思考过程)
  content         TEXT NOT NULL,      -- 原文；一条消息可多个分片（思考回合：[THINK, RESPONSE]）
  stage_id        INTEGER,            -- 实抓 1
  elapsed_secs    REAL,               -- 仅 THINK 有此字段（实抓 null）
  references_json TEXT,               -- JSON 数组原文存：实抓 []
  PRIMARY KEY (chat_session_id, message_id, fragment_id),
  FOREIGN KEY (chat_session_id, message_id)
    REFERENCES chat_messages(chat_session_id, message_id)
);
```

## 4. users / credentials / client_settings

**对应 DSW 功能与插件用途**：

- `users` —— 右上角头像 → 个人中心弹窗（昵称/微信头像/掩码手机号）。插件用途：多账号识别（换号时 `id` 变了 → 本地缓存的会话归类要按 user 隔离）、侧栏显示当前账号。
- `credentials` —— DSW 的登录态本身：`bearer_token`（localStorage `userToken`，64 字符）是**一切主动 API 调用的钥匙**（缺它 = `code 40003 INVALID_TOKEN`，实测）；`hif_leim/hif_dliq` 是风控指纹（服务端下发、带 TTL，插件照抄页面逻辑读 localStorage 即可）。插件用途：主动拉 `fetch_page`/`history_messages`/`index/query` 时组请求头；**永不出本地**。
- `client_settings` —— DSW 界面行为的隐形开关：`normal_history_and_file_token_limit=890880`（上下文+文件总预算）、`input_character_limit=2621440`（输入框字数上限）、`completion_request_timeout_ms=60000`（生成超时）、`search_state_on_launch`（联网搜索默认态）、`launch_clean_session_interval_seconds=21600`（空会话自动清理）。插件用途：预算守卫和注入长度上限直接查这张表，不用硬编码。

```sql
CREATE TABLE users (
  id                TEXT PRIMARY KEY,  -- '4ab9eb3c-6239-4f54-911b-99c606c2e385'
  provider          TEXT,              -- 'WECHAT'
  name              TEXT,              -- '早睡精英'
  picture           TEXT,              -- 头像 URL
  email             TEXT,              -- 实抓 ''
  mobile_masked     TEXT,              -- '130******36'（服务端已掩码，拿不到全号）
  area_code         TEXT,              -- '+86'
  is_mainland       INTEGER,
  minor_mode_status TEXT               -- 'NONE'
);

-- 敏感：value 是可用凭据，只存本地，永不出 chrome.storage / 本库
CREATE TABLE credentials (
  key         TEXT PRIMARY KEY,  -- 'bearer_token' | 'device_id' | 'hif_leim' | 'hif_dliq'
  value       TEXT NOT NULL,     -- bearer_token：64 字符；hif_*：'base64.base64' 形状、带 TTL 需刷新
  captured_at REAL NOT NULL      -- 毫秒；hif_* 有 ttlSec，过期要重读 localStorage
);

CREATE TABLE client_settings (
  scope       TEXT NOT NULL,     -- 'main' | 'model' | 'provider' | 'web_upgrade' | 'banner'
  name        TEXT NOT NULL,     -- 'normal_history_and_file_token_limit' …
  setting_id  INTEGER,           -- 2037161179（服务端配置 id）
  value_json  TEXT NOT NULL,     -- 原样 JSON：890880 / true / {…}
  version     INTEGER,           -- 87（配置代次）
  PRIMARY KEY (scope, name)
);
```

实抓有用的 settings 行（做预算/限额直接查表）：`normal_history_and_file_token_limit = 890880`、`r1_history_and_file_token_limit = 890880`（scope=main）；`input_character_limit = 2621440`（scope=model）。

## 5. 管理写操作 API 速查（全部实抓，均为 POST + Bearer；★= 需 PoW 头 `x-ds-pow-response`）

**对应 DSW 功能**：侧栏每行 ••• 菜单（置顶/重命名/删除）+ 消息操作条（编辑/重新生成）背后的真实接口。
**插件用途**：你的工作台可以**绕过 DOM 直接调这些 API** 实现自己的批量管理界面（如"删除整个项目下的所有会话"= 一次 `delete` 传多个 id）；但 ★ 类（completion/edit/regenerate）带 PoW 门槛——**改写页面自身请求免 PoW，直连必须先解挑战**（5 分钟有效），所以注入类功能保持现有"页面请求改写"架构，管理类功能随便直连。

| 操作 | 端点 | 请求体（实抓原文） | 响应 |
|---|---|---|---|
| 重命名 | `/api/v0/chat_session/update_title` | `{"chat_session_id":"1b5f173c…","title":"侦查重命名测试"}` | `biz_data: {chat_session_updated_at: 1790252994.52, title}` |
| 置顶/取消（批量） | `/api/v0/chat_session/batch_update_pinned` | `{"chat_session_ids":["1b5f173c…"],"pinned":true}`（取消 = `false`） | 常规 code=0 |
| 删除（批量） | `/api/v0/chat_session/delete` | `{"chat_session_ids":["af3eccf2…"]}` | `biz_data: null`；页面随后自动 `chat_session/create` 新空会话 |
| 发消息 | `/api/v0/chat/completion` ★ | `{"chat_session_id","parent_message_id","model_type","prompt","ref_file_ids":[],"thinking_enabled","search_enabled","action":null,"preempt":false}` | SSE（§6） |
| 编辑重发 | `/api/v0/chat/edit_message` ★ | `{"chat_session_id","message_id","ref_file_ids":[],"prompt","search_enabled","thinking_enabled","action":null}` | SSE；**追加新分支**（msg3 编辑 → 生成新 msg5/6） |
| 重新生成 | `/api/v0/chat/regenerate` ★ | `{"chat_session_id","child_message_id":2,"search_enabled","thinking_enabled","user_options":null}` | SSE；`child_message_id`=要重生成的回复；同样产生新分支 msg7 |

实抓细节：思考回合 `thinking_enabled:true` 时 `model_type` 为 `null`；后续消息的 completion 带 `parent_message_id`（链式）；UI 菜单容器是 `div.ds-dropdown-menu`（条目 `.ds-dropdown-menu-option`），删除确认按钮文本是「删除该对话」。

## 6. 会话搜索 API（实抓；入口 = Ctrl+K）

**对应 DSW 功能**：Ctrl+K 唤出的全局搜索面板——跨全部会话搜消息内容（注意：**不是**只搜标题），结果带高亮和所属分支。
**插件用途**：做"跨会话找内容 → 点击跳转到该会话该消息"功能的最短路径——服务端把高亮、分支号、seq_id 翻页全给好了，前端零加工；比遍历 history_messages 本地建索引省几个数量级。

```json
GET  /api/v0/index/prepare            // 空预热，无参
POST /api/v0/index/query              // 响应是 SSE 流（每条 data = 一条命中消息）
     { "query": "收到", "before_seq_id": null }   // 翻页：传上一页尾条的 seq_id
```

每条命中事件的字段（实抓原文，插件做"全局搜索定位会话"直接用它）：

```json
{ "chat_session_id": "1b5f173c…", "message_id": 7, "message_role": "ASSISTANT",
  "parent_message_id": 1, "timestamp": 1790253007.379, "seq_id": "117326021091591597",
  "chat_session_title": { "parts": [{ "highlight": false, "text": "侦查重命名测试" }] },
  "content": { "parts": [{ "highlight": true, "text": "收到" }, { "highlight": false, "text": "啦" }] },
  "is_think": false, "files": [], "branch_index": 2, "total_branches": 2 }
```

- `seq_id` 是**全局字符串序号**（与 `chat_sessions.seq_id` 同族）→ 搜索翻页游标
- `content.parts[].highlight`：**服务端已算好高亮**，前端不用自己切词
- `branch_index/total_branches`：★官方分支语义实锤——一条消息属于哪个分支、共几条分支服务端直接给（history_messages 里没有，只有搜索接口暴露）
- 流结尾：`{"queried_seq_id":…}`（可作下一页 `before_seq_id`）×N → `{"close_reason":"success"}`

## 7. 当前分支视图（编辑分叉后的"真实对话线"）

**对应 DSW 功能**：打开一个编辑过/重生成的会话时，界面实际显示的那条对话线（消息分支切换器 `< 2/2 >` 切到的就是"当前分支"）。DSW 自己靠 `chat_session.current_message_id` + `parent_id` 链确定。
**插件用途**：导出会话原文、记忆整理采集、token 统计**都必须限定在当前分支**——否则一个编辑过 5 次的会话会把 5 条废弃分支全算进去（你的 `conversations/<id>.json` 存档就应该只存这个视图的结果）。

```sql
CREATE VIEW v_current_branch AS
WITH RECURSIVE branch(sid, mid) AS (
  SELECT id, current_message_id FROM chat_sessions WHERE current_message_id IS NOT NULL
  UNION
  SELECT m.chat_session_id, m.parent_id
  FROM chat_messages m JOIN branch b ON m.chat_session_id = b.sid AND m.message_id = b.mid
  WHERE m.parent_id IS NOT NULL
)
SELECT m.* FROM chat_messages m JOIN branch b
  ON m.chat_session_id = b.sid AND m.message_id = b.mid
ORDER BY m.chat_session_id, m.message_id;
```

上下文体积监控 = `v_current_branch` 末条消息的 `accumulated_token_usage`，对照 `client_settings` 里的 890880 上限。

## 8. 刻意不建表的数据

| 数据 | 原因 |
|---|---|
| SSE 事件流（`{"v":"…"}` 增量、`{"p":…,"o":"APPEND"}` 补丁） | 传输格式，消费完即弃；落库取整包结果（history_messages）即可。标题生成事件 `{"content":"…"}` 直接 UPDATE `chat_sessions.title` |
| PoW 挑战（challenge/salt/difficulty） | 5 分钟过期（`expire_after: 300000`），无留存价值 |
| `cache_control`（APPEND/REPLACE）、`cache_reset_at` | 只是 history 增量同步指令，不是数据 |
| `x-hif-leim` / `x-hif-dliq` 算法 | 无需实现：照页面逻辑读 localStorage 缓存值即可（`credentials` 表已覆盖） |
