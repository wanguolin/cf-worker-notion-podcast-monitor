# 财经播客 RSS → Notion 云端增量同步实施计划

> 状态：方案评估完成，尚未开始编码或部署  
> 目标平台：Cloudflare Workers Paid  
> 目标时区：Asia/Shanghai  
> 计划任务：每天 05:00（Cloudflare Cron：`0 21 * * *`，UTC）  
> 最后核对日期：2026-08-08

## 1. 结论

本项目可以在 Cloudflare Workers Paid 上可靠实现。

推荐主架构是：

> Cron Producer 每天只读取一次 Notion 播客清单，并为每个唯一 RSS 向 Cloudflare Queue 投递一条独立消息；Queue Consumer 同时只处理一条消息、一个 RSS，并在该 RSS 全部完成后才领取下一条。D1 只保存运行状态、Feed 任务、幂等账本和故障记录。

Notion 继续作为业务真源：

- “财经播客监控”决定当前应抓取哪些播客。
- “财经播客单集库”保存最终单集记录。
- 删除、增加或修改播客行，下一次运行自动生效。
- D1 不是第二个内容库，不保存完整节目正文，只承担技术状态和幂等控制。

本项目没有独立 RSS 解析服务，也不依赖任何外部解析中间层。Paid Worker 的 Queue Consumer 直接下载并流式解析 RSS。

## 2. 已核实的现状

### 2.1 Notion 数据源

目标说明页：

- [财经播客 RSS 云端增量同步](https://app.notion.com/p/3b6cc64d809c81eea696fb4ae547a3f6)

说明页的角色约定：

- 排重规则、26 小时窗口、父页“内容同步时间”更新条件、字段清单、报告格式与全部“禁止事项”以该说明页为准。
- 说明页“每次运行”中构造批量 GET 调用 `https://podcast-rss.polymaster.io/window?...` 的流程，描述的是当前由 Agent 手工驱动的旧管线；本项目上线后由 Worker 内部直接抓取并流式解析 RSS 取代该服务，不再构造批量 GET（该做法也受 Worker URL 16 KB 上限约束）。上线验收通过后需经用户确认再更新说明页以反映新架构。

播客清单：

- 数据库：`财经播客监控`
- Data source：`6770eb15-6002-4bd9-8791-53f8fc968cab`
- 当前查询结果：26 个 RSS 非空行、25 个唯一 RSS。
- 同一 RSS 可能对应多个父页；当前 “Masters in Business” 就存在这种映射。
- 关键字段：播客名称、RSS地址、分类、语言。
- “最后更新”是 Notion 系统字段，不能直接写入。

单集库：

- 数据库：`财经播客单集库`
- Data source：`c6518896-0a17-43bb-8f95-b88933d211cb`
- 当前 schema 已包含目标说明中要求的单集字段。
- 不新建第二个单集库，不向播客父页正文追加单集详情。

### 2.2 当前 RSS 体积

只读抽样显示：

- “知行小酒馆”当前 `Content-Length` 为 `4,871,172` 字节，已接近 5 MB。
- 该响应未提供 `ETag` 或 `Last-Modified`，不能依赖条件请求避免每日完整下载。
- 多个现有 Feed 在约 1.5–3 MB 范围。

因此，大 Feed 不是未来才会出现的假设，而是当前就需要覆盖的正常输入。

## 3. Paid Worker 的设计边界

以下数字以 2026-08-08 核对的 Cloudflare 官方文档为准：

- 每个 isolate 内存仍为 128 MB；付费不会提高这一项。
- Paid Worker 每次调用可使用更多 subrequest，当前上限足以覆盖本项目。
- 每日一次的 Cron 间隔大于一小时，Paid Cron 具有充足的 CPU 配额。
- Cron 单次 wall time 上限为 15 分钟。
- 同一调用最多同时保持 6 个对外连接。
- Worker 收到的响应体没有 5 MB 上限，但把响应完整缓冲到内存仍受 128 MB 限制。
- Worker URL 最大 16 KB，因此禁止把全部 RSS 地址长期堆进一个批量 GET 查询串。
- Queue 单条消息最大 128 KB；本项目消息只保存一个 Feed 的 URL、Notion 映射和运行标识，必须远低于该上限。
- Queue Consumer 单次 wall time 上限为 15 分钟，CPU 默认 30 秒，可在 Paid Plan 上配置到 5 分钟。
- Paid Queue 消息默认保留 4 天，可配置到 14 天，足以支持“跑一夜”和人工恢复。

设计上不能因为使用 Paid Plan 就忽略以下约束：

- 不把全部 RSS 同时读入内存。
- 不使用建立完整 XML DOM 的解析方式。
- 不以 15 分钟为正常运行目标；15 分钟只是硬上限。
- 不依赖进程内变量保存锁、游标或排重状态。
- 不假设 Cron 严格只投递一次。
- 不假设 Queue 消息只投递一次或严格按入队顺序处理。

## 4. 目标架构

```text
Cloudflare Cron（每日 21:00 UTC）
              │
              ▼
   scheduled() / Cron Producer
       ├─ 确认没有未完成的前一日运行
       ├─ 查询 Notion 当前播客清单
       ├─ 在 D1 创建 run + feed_tasks
       └─ 每个唯一 RSS 投递一条消息
              │
              ▼
      Cloudflare Queue
    max_batch_size = 1
    max_concurrency = 1
              │
              ▼
       queue() / Consumer
       ├─ 一次只领取一个 RSS
       ├─ 下载并流式解析 XML
       ├─ 提取 26 小时窗口
       ├─ 生成稳定排重键
       ├─ 以 1 请求/秒访问 Notion
       ├─ 写入成功后更新对应父页
       ├─ 完成后 ack 当前消息
       └─ 更新 D1 任务与运行汇总
              │
       ┌──────┴──────────┐
       ▼                 ▼
   Notion API       Cloudflare D1
  业务数据真源      任务/锁/幂等账本

处理失败且超过重试上限
              │
              ▼
       Dead Letter Queue
```

MVP 使用一个 Worker 脚本，同时实现 `scheduled()` Producer 和 `queue()` Consumer，并绑定：

- 一条主队列：每个消息只代表一个唯一 RSS。
- 一条 Dead Letter Queue：保存超过重试上限的消息，禁止静默删除。
- 一个 D1 数据库：聚合跨消息运行状态并提供幂等保护。

以下两个配置必须同时使用：

- `max_batch_size=1`：每个 consumer invocation 只收到一个 RSS 消息。
- `max_concurrency=1`：整个主队列同时最多只有一个活跃 consumer invocation。

只设置 batch size 不足以实现串行；Cloudflare 仍可能并发启动多个 consumer。Queues 按至少一次语义投递且不保证严格顺序，因此 D1 幂等和 Notion 回查仍是必需条件。

MVP 不引入 Workflows、Durable Objects 或 R2。只有在单个 RSS 的处理需要跨越 15 分钟，或未来要做历史全量回填时，再评估 Workflows。

按当前 25 个唯一 Feed 粗算，每天约 25 条消息、每月约 750 条。正常每条消息约产生写入、读取和删除三类 Queue 操作，即约 2,250 次标准操作/月；即使加上少量重试，也远低于 Workers Paid 当前每月包含的 1,000,000 次 Queue 标准操作，成本不是该架构的主要约束。

## 5. 每日运行流程

### 5.1 Cron Producer 与运行创建

1. Cron 使用 `0 21 * * *`，对应上海每天 05:00。
2. 以 `cron + scheduledTime` 形成稳定 `run_id`。
3. 在 D1 中原子创建运行记录；唯一约束阻止同一计划时间产生两套任务。
4. 如果同一个 `run_id` 已存在且仍为 `creating`，本次不是简单跳过，而是恢复投递其尚未确认入队的 `feed_tasks`。
5. 检查是否存在仍为 `queued` 或 `running` 的前一日运行。
6. 如果前一日运行尚未结束，本次标记为 `skipped_previous_run_active`，不再投递一套重复任务，并产生告警记录。
7. Producer 只负责生成任务并入队，不在 Cron invocation 内抓取 RSS 或写入单集。

Cron 和 Queue 都按 at-least-once 语义设计，不把“通常只执行一次”当成保证。

### 5.2 查询 Notion 清单并逐 Feed 入队

1. 使用 Notion API `2026-03-11` 查询 data source。
2. 完整处理分页，不假设播客数永远少于单页上限。
3. 只采用当前非归档行。
4. RSS 地址为空的行跳过并记录原因。
5. 对 RSS URL 做规范化后识别唯一 Feed，但保留 `feed → 多个父页` 映射。
6. 本次得到的 Notion 清单是唯一输入；不得从 D1 历史记录补回已删除 Feed。
7. 先在 D1 创建全部 `feed_tasks`，状态为 `pending_enqueue`，再向 Queue 投递消息，形成 D1 outbox。
8. 每个唯一 Feed 对应一条独立消息；可以使用 `sendBatch` 减少 Producer 调用，但不能把多个 Feed 合并进同一消息。
9. 消息 ID 使用 `run_id + feed_url_hash`，并与 D1 唯一任务键一致。
10. Queue send 成功后把任务改为 `queued`；如果 send 结果不确定，保留 `pending_enqueue`，后续恢复流程允许重复投递同一消息，由 Consumer 幂等层吸收重复。
11. 只有全部任务都确认入队后，run 才从 `creating` 进入 `queued`。

每条 Queue 消息只包含：

- `schema_version`。
- `run_id`、`task_id`。
- 一个规范化 RSS URL。
- 播客名称、分类、语言。
- 当前父页 ID 列表。
- 必要的请求时间窗口和内容指纹。

消息不包含完整 RSS、Notion Token、节目正文或音视频数据，并应远低于 128 KB 上限。

如果清单为空：

- 不抓取 RSS。
- 不写入单集库。
- 不更新任何父页。
- 将本次运行标记为成功的空运行。

### 5.3 Queue 串行消费、确认与重试

1. 主队列配置 `max_batch_size=1` 和 `max_concurrency=1`。
2. Consumer 收到消息后，先用 `task_id` 查询 D1。
3. 已处于 `succeeded` 或确定性 `failed` 的任务直接 `ack()`，避免重复副作用。
4. 待处理任务以条件更新切换到 `processing`；重复投递不能同时取得执行权。
5. 一个 invocation 从下载、解析、排重到 Notion 写入只处理该一个 RSS。
6. 全部成功并写完 D1 后才 `ack()`。
7. 网络错误、429、529 和可恢复 5xx 使用 Queue retry，结合消息 `attempts` 计算指数退避，单次延迟不超过 Cloudflare 允许的 24 小时。
8. 主队列建议 `max_retries=5`；超过上限的消息进入 DLQ，不得直接丢弃。
9. 主队列和 DLQ 的消息保留期都配置为 14 天。
10. Queue 不保证严格顺序；运行完成依赖 D1 任务计数，不依赖“最后入队的消息最后执行”。

每个任务进入终态时，使用 D1 原子更新运行计数。满足 `succeeded + failed = total_tasks` 的 consumer 负责将 run 标记为 `succeeded` 或 `partial` 并生成最终摘要。重复消息不能重复增加计数。

### 5.4 RSS 安全校验

RSS 地址来自可编辑的 Notion，必须视为不可信输入：

- 只允许 `https:` 和必要时明确批准的 `http:`。
- 拒绝 localhost、回环、链路本地、私网、保留地址和云元数据地址。
- 每次重定向后重新校验目标地址。
- 限制重定向次数。
- 设置连接及总读取超时。
- 不信任 `Content-Type`，但要求内容通过 XML/RSS/Atom 基本结构校验。
- 日志不记录 Secret、完整正文或可能含凭据的 URL 查询参数。

### 5.5 抓取与大型 RSS

默认参数：

| 参数 | 建议默认值 | 说明 |
|---|---:|---|
| Feed 并发 | 1 | Queue batch size 与 max concurrency 同时设为 1 |
| 单 Feed 总超时 | 5 分钟 | 用户接受整夜运行，优先容忍慢源；仍给单消息收尾留余量 |
| 单 Feed 最大原始体积 | 32 MiB | 明显覆盖当前 5 MB 场景，同时保护 128 MB 内存 |
| 单消息软截止 | 12 分钟 | Queue Consumer wall time 为 15 分钟，预留 3 分钟收尾 |
| RSS 时间窗口 | 26 小时 | 覆盖每日调度漂移与源站发布时间误差 |
| 单 Feed 重试 | 交给 Queue | 最多 5 次，使用延迟和退避；每次重试重新执行幂等检查 |

处理规则：

1. 如果可信的 `Content-Length` 大于 32 MiB，提前拒绝并记录 `feed_too_large`。
2. 对无 `Content-Length` 或 chunked 响应，在读取流上累计字节；超过上限立即取消。
3. 使用 SAX/事件式流解析，不调用会把整个 Feed 转为大字符串或完整 DOM 的路径。
4. 每个 Queue invocation 只存在一个 Feed 的解析状态；解析结束后立即释放缓冲和临时对象。
5. 只保留 26 小时窗口内可能需要写入的单集字段。
6. RSS 项目顺序不可信；除非实现已经证明可以安全提前终止，否则必须读到 EOF。
7. 单 Feed 失败通过 Queue 延迟重试；其他消息仍可继续处理，失败 Feed 的父页绝不更新时间。

验收时必须覆盖：

- 5 MiB、10 MiB、20 MiB 和 32 MiB 输入。
- 有 `Content-Length`、无 `Content-Length`、chunked 和 gzip 响应。
- 错误 XML、超深嵌套、超长字段、慢速响应和重定向循环。

### 5.6 字段提取与排重键

按现有规则生成 `dedupKey`：

1. GUID。
2. 原始单集链接。
3. enclosure/media 链接。
4. 标题 + 规范化发布日期回退键。

要求：

- GUID、URL 和文本在参与哈希前使用稳定规范化规则。
- 不允许仅按标题排重。
- `播客名称 + 排重键` 是 Notion 业务唯一组合。
- 同一 Feed 对应多个播客父页时，单集写入仍按当前 Notion 业务规则确定播客名称和分类映射，不把父页 URL 混入排重键。
- D1 对同一业务组合设置唯一约束，作为第一层并发保护。
- Notion 写入前再次查询目标组合，作为第二层事实核验。

### 5.7 Notion 写入

Notion API 当前约束：

- 单 connection 平均 3 请求/秒，并受 workspace 共享限额影响。
- 超限可能返回 429；服务过载可能返回 529。
- 必须读取 `Retry-After`，并使用指数退避和 jitter。
- 单个请求总体最大 500 KB。
- URL 最大 2,000 字符。
- 单个 rich text `text.content` 最大 2,000 字符。

本项目写入策略：

- Consumer 内所有 Notion 请求严格串行，主动限速到最多 1 请求/秒。
- 新单集按发布日期从旧到新写入。
- 每个 Notion 页面创建请求只包含一个单集。
- 简介、关键词、RSS 分类等长文本在进入属性前执行长度预算；不静默提交超限 payload。
- 超长简介优先安全截断并记录 `description_truncated=true`；MVP 不把全文拆成页面正文。
- 媒体下载必须来自 RSS enclosure/media 的音频或视频直链。
- 缺失字段留空，不编造。

Notion `POST /pages` 没有可依赖的业务幂等键，因此必须处理“请求超时但服务端可能已经创建成功”的不确定状态：

1. 创建前查询 `播客名称 + 排重键`。
2. 创建成功后把 Notion page ID 写入 D1。
3. 如果创建请求超时或连接中断，不立即重复 POST。
4. 先重新查询 Notion；存在则记录为成功，不存在才重试创建。

### 5.8 更新播客父页时间

只有某个播客本轮全部新增单集都写入成功后，才更新时间。

公共 Notion REST API 不支持当前 MCP 风格的整页 Markdown `update_content` 搜索替换，因此采用 block 级更新：

1. 首次读取父页 block children。
2. 找到唯一的 `内容同步时间：...（Asia/Shanghai）` paragraph block。
3. 验证只有一个匹配项；零个或多个匹配都停止更新并报警。
4. 用 Update block API 只替换该 paragraph 的 rich text。
5. 将 block ID 缓存在 D1；后续遇到 404、类型变化或内容前缀不匹配时重新发现。
6. 同一 RSS 映射多个当前父页时，全部父页都必须成功更新。

绝不执行：

- 没有新增单集时更新时间。
- 单集部分写入失败后更新时间。
- 修改父页其他正文、评论或内嵌数据库视图。
- 直接写入只读的 “最后更新” 系统属性。

## 6. D1 技术账本

D1 只保存必要技术状态，建议包含以下逻辑表：

### `runs`

- `run_id`：主键。
- `scheduled_at`、`started_at`、`finished_at`。
- `status`：creating / queued / running / succeeded / partial / failed / skipped_previous_run_active。
- 清单行数、唯一 Feed 数、成功/失败 Feed 数、新增单集数、父页更新数。
- `heartbeat_at`、`error_summary`。

### `feed_tasks`

- `task_id`：`run_id + feed_url_hash`，主键。
- `run_id`、`feed_url_hash`。
- `status`：pending_enqueue / queued / processing / retrying / succeeded / failed / dead_lettered。
- `attempt_count`、`queued_at`、`started_at`、`finished_at`。
- HTTP 状态、下载字节数、解析条目数、窗口内条目数。
- 新增单集数、Notion 写入数、父页更新数。
- 失败代码和脱敏错误摘要。
- 对 `run_id + feed_url_hash` 建唯一约束。

### `producer_locks`

- 只保护 Cron 查询清单和创建 Queue 消息的短过程。
- `owner_run_id`、`expires_at`。
- 使用原子条件写入，不能先查后写。
- Queue 消费期间不长期持有该锁；跨夜运行由 `runs` 和 `feed_tasks` 状态判断。

### `episode_writes`

- `podcast_name`。
- `dedup_key`。
- `feed_url_hash`。
- `status`：pending / written / uncertain / failed。
- `notion_page_id`。
- `first_seen_at`、`last_attempt_at`、`attempt_count`。
- 对 `podcast_name + dedup_key` 建唯一约束。

### `parent_blocks`

- `parent_page_id`。
- `sync_time_block_id`。
- `last_verified_at`。
- `content_fingerprint`。

D1 不保存：

- Notion Token。
- 完整 RSS XML。
- 完整节目简介或逐字稿。
- 音视频文件。

## 7. 失败模型

| 失败场景 | 行为 | 是否更新父页 |
|---|---|---|
| Notion 清单读取失败 | 整次运行失败，不抓 Feed | 否 |
| Queue 投递部分失败 | 根据 D1 `feed_tasks` 只补投未入队任务 | 否 |
| Queue 重复投递 | D1 任务键去重；终态任务直接 ack | 不重复更新 |
| 单个 Feed 超时/5xx/XML 错误 | 延迟重试；其他 Feed 继续排队 | 该 Feed 否 |
| Feed 超过 32 MiB | 终止该 Feed，记录明确错误 | 否 |
| Notion 排重查询失败 | 不写该单集，进入失败账本 | 否 |
| Notion 创建返回 429/529 | 按 Retry-After 退避重试 | 未全部成功前否 |
| Notion 创建结果不确定 | 先回查，禁止盲目重复 POST | 未确认前否 |
| 父页时间 block 找不到 | 单集保留，父页更新失败并报警 | 否 |
| 单消息接近 12 分钟 | 主动中止并请求 Queue 重试 | 否 |
| 超过 Queue 重试上限 | 消息进入 DLQ，任务标记失败 | 否 |
| 前一日队列仍未完成 | 次日 Cron 不创建重复 run，并报警 | 否 |
| Cron 重复投递 | D1 唯一 run 阻止重复入队 | 否 |

总原则：宁可漏报并留下可恢复记录，也不要重复写入或错误刷新父页时间。

## 8. 安全与权限

### 8.1 授权方式选择

当前已只读确认的 Notion 身份是：

- Workspace：`Personal Notes`
- User：`PolyMaster`

本项目只服务这一个 Notion 用户和一个 workspace，不提供给其他用户安装，因此不需要 Public Connection，也不需要实现 OAuth redirect、authorization code、access token/refresh token 交换流程。

默认采用 **Personal Access Token（PAT）**：

- PAT 是一个用户在一个 workspace 内的远端 bearer token。
- 它以创建者本人身份调用 Notion API，适合个人脚本、CLI 和受信任的远端 Worker。
- 它不需要通过 “Add connections” 把页面逐个共享给 bot。
- 它不能跨到其他 workspace；但在选定 workspace 内，它可以访问创建者本人有权限访问的所有页面、数据库和 data source。
- “自己账号”是用户权限边界，不是页面所有权边界：如果别人把页面共享给 `PolyMaster`，PAT 也可能访问；它并非天然只限本项目的两个数据库。
- PAT 创建时只需要选择 `Notion API` capability；本项目不使用 Notion Workers，因此不需要 `Workers` capability。
- PAT 创建时可选择 7、30、90、180 天或 1 年；如果不选择，默认 1 年。production 建议显式选择 1 年并在到期前轮换。

如果未来希望严格做到“Token 即使泄露也只能访问这两个数据库”，应改用下面的 Internal Connection。Worker 业务架构和 API 调用不需要改变，只替换 Token 与授权方式。

### 8.2 推荐路线：PAT 远端授权步骤

以下步骤由用户在浏览器和 Cloudflare 控制台/CLI 中完成，不把 Token 发给 Codex，也不写进本文件。

1. 使用 `PolyMaster` 登录 Notion，并确认当前 workspace 是 `Personal Notes`。
2. 打开 [Notion Developer portal 的 Personal access tokens](https://developers.notion.com/guides/get-started/personal-access-tokens) 页面入口。
3. 点击 `New personal access token`。
4. Token 名称建议使用环境隔离命名：
   - production：`cf-worker-notion-podcast-monitor-prod`
   - staging：`cf-worker-notion-podcast-monitor-staging`
5. Workspace 选择 `Personal Notes`。
6. Capability 只选择 `Notion API`；不要为本项目启用 `Workers`。Expiration 显式选择 `1 year`，并记录页面显示的准确到期日。
7. 点击 `Create token`，复制 Token，并立即保存到密码管理器或 Cloudflare Secret；Token 创建后不能再次查看。
8. 在项目目录执行 Cloudflare Secret 写入，按提示粘贴 Token：

   ```bash
   npx wrangler secret put NOTION_TOKEN --env finance-production
   ```

9. 当前只有 `finance-production` 一个环境，经用户确认使用单个 Token；未来新增环境时再评估是否拆分独立 Token。
10. 通过远端 API 做只读授权验证：
    - `GET /v1/users/me` 应返回 `PolyMaster` 对应身份。
    - 查询 `6770eb15-6002-4bd9-8791-53f8fc968cab` 应能读到播客清单。
    - 查询 `c6518896-0a17-43bb-8f95-b88933d211cb` 应能读到单集库 schema 和记录。
    - 读取一个播客父页的 block children，应能定位“内容同步时间”段落。
11. 所有请求带：
    - `Authorization: Bearer <NOTION_TOKEN>`
    - `Notion-Version: 2026-03-11`
    - `Content-Type: application/json`
12. 只读验证通过后再进入 Dry Run；真实创建页面和更新 block 必须留到金丝雀阶段。
13. 在日历中建立 PAT 到期前 30 天的轮换提醒。轮换步骤是创建新 PAT、更新 Cloudflare Secret、验证新 Token、再撤销旧 Token。
14. Token 泄露、设备丢失或项目停用时，立即在 Developer portal 撤销 PAT；撤销后远端请求应立刻失效。

如果 Developer portal 没有 PAT 创建入口或 API capability 不可选：

- 先检查该 workspace 的 PAT creation policy 和当前账号是否为 full member/workspace owner。
- 不要绕过管理员策略。
- 可以改用 Internal Connection，或由 workspace owner 调整允许范围。

### 8.3 更窄权限备选：Internal Connection

Internal Connection 作为独立 bot 工作，只能访问显式共享给它的页面和数据库，更符合最小权限，但创建者必须是 Workspace Owner。

操作步骤：

1. 打开 Notion Creator dashboard。
2. 进入 `Build` → `Internal connections`。
3. 点击 `Create a new connection`。
4. 名称填写 `cf-worker-notion-podcast-monitor-prod`，安装范围选择 `Personal Notes`。
5. 在 `Configuration` 中只启用：
   - Read content。
   - Insert content。
   - Update content。
6. 不启用本项目不需要的用户读取、评论或其他能力。
7. 在 `Content access` → `Edit access` 中选择：
   - “财经播客监控”数据库。
   - “财经播客单集库”数据库。
   - 如果数据库访问没有自动覆盖需要更新的父页，再补充对应父页或它们的共同父页面。
8. 也可以在 Notion 页面右上角 `•••` → `Connections` → `+ Add connection` 中添加该 connection。共享父页面会向子页面继承权限，授权前必须检查层级，避免把过大的页面树一起共享。
9. 从 `Configuration` 复制 Installation access token。
10. 使用相同的 `wrangler secret put NOTION_TOKEN --env production` 写入 Cloudflare Secret。
11. 执行与 PAT 路线相同的 `/v1/users/me`、两个 data source 和父页 block 只读验证。
12. 任一目标返回 404 时，优先检查 `Content access` / `Add connection`，不要误判为页面不存在。

Internal Connection 不需要 OAuth，也不需要 access token/refresh token 交换。它使用一个静态 installation token；泄露时从 Configuration 刷新并替换 Cloudflare Secret。

### 8.4 为什么不做 Public OAuth

Public Connection OAuth 适用于让多个 Notion 用户分别安装同一个产品。本项目只有一个固定用户，增加 OAuth 会额外引入：

- Redirect URI 和授权页面。
- Authorization code 交换。
- Access token / refresh token 的加密存储和轮换。
- 多 workspace 与多用户资源映射。

这些复杂度没有带来实际收益，因此明确不纳入 MVP。未来如果把项目变成可供他人安装的产品，再单独设计 Public OAuth。

### 8.5 Secrets

至少需要：

- `NOTION_TOKEN`：Cloudflare Secret。
- 可选 `MANUAL_TRIGGER_TOKEN`：如果开放人工触发端点。
- 可选 `ALERT_WEBHOOK_URL`：如果后续接入告警。

禁止：

- 把 Token 写进 `wrangler.jsonc`、源码、日志、D1 或 Git。
- 在错误输出中回显 Authorization header。
- 在生产环境暴露无鉴权的手工触发或测试入口。

## 9. 可观测性

每次运行必须生成一个结构化摘要：

- run ID、计划时间、实际开始/结束时间。
- 清单行数、唯一 Feed 数。
- 成功、失败、跳过 Feed 数。
- 下载总字节、最大 Feed 字节、总解析时间。
- 候选单集数、新增数、已存在数、失败写入数。
- 更新父页数。
- 429、529、网络重试次数。
- CPU time、wall time、峰值内存的可用观测值。
- Queue 待处理消息数、最老消息年龄、消费成功/重试数。
- DLQ 消息数和对应 `task_id`。

日志约束：

- 使用稳定错误码，不只记录自由文本。
- Feed URL 默认只记录 host + hash；需要排障时再安全展开。
- 单次日志总量保持远低于 Cloudflare 256 KB 限制。
- D1 `runs` 保存长期摘要；Cloudflare Logs 用于近期详细诊断。

第一阶段不强制接入第三方告警，但必须让 `partial`、`failed`、`dead_lettered` 和 `skipped_previous_run_active` 能在 D1 与 Cloudflare Logs 中被明确检索。只要 DLQ 非空或前一日运行未完成，就必须产生高优先级告警记录。上线稳定后再决定邮件、飞书或其他 webhook 告警。

## 10. 项目配置约定

当前只部署一个环境（经用户确认，不设 staging，直接在生产验证）：

- `finance-production`：财经播客组的生产环境，绑定真实 Notion 数据库与每日 Cron；Worker 名为 `cf-worker-notion-podcast-monitor-finance-production`，对应 git 分支 `main`。
- 本地开发用 `wrangler dev --env finance-production` 配合 `DRY_RUN` 与 fixture 控制副作用。

未来新增播客关注组时，再按 10.1/10.2 的分支绑定设计扩展出新环境；该设计当前仅留档，不实施。

### 10.1 多分支 → 多播客组/多 Notion 绑定

设计目标：允许未来用不同 git 分支绑定不同的“播客关注组 + Notion 数据库对”，而不复制代码。

- 所有分支的业务代码保持一致；分支只决定部署到哪个 wrangler 环境。
- Notion data source ID 不写死在代码中，改为 wrangler 环境变量：
  - `NOTION_MONITOR_DS_ID`：播客清单 data source ID。
  - `NOTION_EPISODE_DS_ID`：单集库 data source ID。
  - production 环境的取值即 2.1 节的两个 ID。
- `wrangler.jsonc` 顶层定义共享默认值，`env.<name>` 每个环境定义：
  - 独立 Worker 名称：`cf-worker-notion-podcast-monitor-<name>`。
  - 独立 vars（两个 data source ID、`DRY_RUN` 等）。
  - 独立 Queue、DLQ、D1 binding 与 Cron。
  - 独立 Secret：`wrangler secret put NOTION_TOKEN --env <name>`；`MANUAL_TRIGGER_TOKEN` 同理。
- 新增一个播客关注组的流程：
  1. 在 Notion 建立（或复用）一对“监控清单 + 单集库”数据库，并确保 Token 可访问。
  2. `wrangler.jsonc` 增加 `env.<group>`，填入新的 data source ID 与独立资源名。
  3. 创建同名 git 分支 `<group>`，首次本地 `wrangler deploy --env <group>` 创建 Worker。
  4. 按 10.2 在 Dashboard 中把仓库连接到该 Worker，并将其 production branch 设为 `<group>`。
  5. 写入该环境的 Secret。

### 10.2 部署方式：Workers Builds 按分支绑定（已核实官方支持）

Cloudflare Workers Builds 支持把同一个 GitHub 仓库连接到多个 Worker，每个 Worker 独立设置 production branch 与 deploy command，因此不需要 GitHub Actions：

1. 先在本地对每个环境执行一次 `npx wrangler deploy --env <name>`，在 Dashboard 创建对应 Worker。
2. 在 Dashboard 分别为每个环境 Worker 连接同一个 GitHub 仓库（Settings → Builds → Connect）。
3. 每个 Worker 的 Branch control 设置：
   - `cf-worker-notion-podcast-monitor-finance-production` → production branch = `main`。
   - 未来 `cf-worker-notion-podcast-monitor-<group>` → production branch = `<group>`。
4. 每个 Worker 的 deploy command 设为 `npx wrangler deploy --env <name>`。
5. 关闭 non-production branch builds，避免其他分支的 push 触发多余构建与预览部署。
6. 注意：Dashboard 中的 Worker 名称必须与 wrangler 配置中该环境解析出的最终 `name` 一致，否则构建失败。

上述第 2–5 步是 Dashboard 手动操作，属于上线前需要用户确认完成的后台配置。GitHub Actions 仅作为该路线不可用时的 fallback，不默认引入。

建议的非敏感变量：

- `NOTION_MONITOR_DS_ID=<播客清单 data source ID>`
- `NOTION_EPISODE_DS_ID=<单集库 data source ID>`

- `TIMEZONE=Asia/Shanghai`
- `RSS_WINDOW_HOURS=26`
- `RSS_MAX_BYTES=33554432`
- `RSS_TIMEOUT_MS=300000`
- `MESSAGE_SOFT_DEADLINE_MS=720000`
- `NOTION_RPS=1`
- `DRY_RUN=true|false`

主队列 consumer 配置固定为：

- `max_batch_size=1`
- `max_batch_timeout=0` 或平台允许的最小值
- `max_concurrency=1`
- `max_retries=5`
- `dead_letter_queue=<production-dlq-name>`
- 主队列与 DLQ retention：14 天
- Queue consumer `limits.cpu_ms=300000`，允许最高 5 分钟 CPU；wall time 仍为 15 分钟

生产 Cron 和生产 Queue binding 只配置在 production 环境。staging 不得意外继承生产触发器或连接生产队列。

## 11. 实施阶段

### 阶段 0：权限与基线

- 为 `Personal Notes` 创建独立 production PAT，Capability 只选 `Notion API`；如果改选最小权限路线，则创建 Internal Connection 并只共享目标数据库和必要父页。
- 把 Token 写入 Cloudflare Secret，不落盘、不提交 Git。
- 通过 `/v1/users/me` 确认远端身份和 workspace。
- 验证 REST API 能查询两个 data source。
- 确认每个播客父页只有一个固定“内容同步时间”段落。
- 导出现有单集库的 `播客名称 + 排重键` 基线，供验收对比。

完成标准：无写入地读完 26 行清单、识别 25 个唯一 Feed，并定位全部父页时间 block。

### 阶段 0.5：远端写入连通性验证（先行里程碑）

目的：在实现任何业务管线之前，先证明“Cloudflare 远端 Worker 可以读写本 Notion workspace”。

- 最小 Worker：`GET /health` 返回版本与环境名；`POST /selftest` 要求 `MANUAL_TRIGGER_TOKEN` 鉴权。
- `/selftest` 执行且仅执行：
  1. `GET /v1/users/me` 验证远端身份。
  2. 各查询两个 data source 一页，验证读权限（使用 env vars 中的 data source ID）。
  3. 在单集库创建一条标题以 `[连通性测试]` 开头的记录，随后立即 archive，验证写权限与回收路径。
  4. 返回结构化 JSON 结果；不写 D1、不触碰任何播客父页。
- 部署到 `finance-production` 环境（经用户确认不设 staging；Notion Token 单个共用）。
- 该端点必须始终有 `MANUAL_TRIGGER_TOKEN` 鉴权；全量上线前决定删除或保留。

完成标准：远端调用 `/selftest` 四步全部成功，且单集库中的测试记录已归档、无残留。

### 阶段 1：Worker、Queue 与 D1 基础设施

- 建立 Worker Paid 项目和 dev/staging/production 环境。
- 创建 D1 与迁移文件。
- 创建主队列和 DLQ。
- 配置 Producer binding、Consumer binding、batch size 1、max concurrency 1、重试和 retention。
- 配置 Secret、非敏感变量和生产 Cron。
- 按 10.2 把 GitHub 仓库连接到各环境 Worker，设置 production branch 与 deploy command。
- 建立结构化日志与 run ID。

完成标准：本地和 staging 能触发空运行；重复 Cron 不会形成两个有效 run；同时投递多条消息时最多只有一个 consumer invocation 活跃。

### 阶段 2：只读 RSS 管线

- 实现 URL 安全校验、超时、重定向和大小上限。
- 实现流式 XML 解析和字段规范化。
- 实现 26 小时窗口与 dedupKey。
- 验证 Producer 每个唯一 Feed 只创建一条独立消息。
- 验证 Queue 重复投递、延迟重试和 DLQ 路径。
- 先对“知行小酒馆”等大 Feed 做单源测试。

完成标准：在不写 Notion 的情况下，对全部当前 Feed 生成稳定、可复现的候选结果。

### 阶段 3：Notion 排重与 Dry Run

- 查询单集库候选组合。
- 生成“将写入/已存在/失败”的差异报告。
- 测试分页、429、529、超时和 payload 长度保护。

完成标准：连续运行两次 Dry Run，第二次候选结果一致；Notion 写入数始终为 0。

### 阶段 4：单 Feed 写入金丝雀

- 只允许一个播客产生真实写入。
- 写入单集后回查完整字段。
- 验证无新增时零写入。
- 验证全部写入成功后才更新父页时间 block。

完成标准：人工核对单集行、链接、日期、排重键和父页更新时间均正确。

### 阶段 5：全量上线

- 移除单 Feed allowlist。
- 保持 `DRY_RUN=false` 但保留一键关闭开关。
- 启用 production Cron：`0 21 * * *`。
- 前 7 天每日检查 Cron Events、Queue backlog、DLQ、Worker Logs、D1 摘要和 Notion 结果。

完成标准：连续 7 次运行无重复写入、无错误刷新父页、无未解释失败。

## 12. 验收标准

### 正确性

- 清单删除的 RSS 下一次运行不再抓取。
- 新增或修改 RSS 下一次运行自动生效。
- 同一 RSS 映射多个父页时，映射保持完整。
- 无新增时 Notion 写入数严格为 0。
- 仅标题相同不会错误排重。
- 双重触发、超时重试和 Worker 重启均不产生重复单集。
- 同时投递 25 个 Feed 时，消费端始终只有一个 RSS 在处理。
- Queue 消息重复投递不会重复增加 run 完成计数。
- Queue 不按入队顺序交付时，最终运行汇总仍然正确。
- 部分失败时，不更新受影响播客父页。

### 大 Feed 与性能

- 10 MiB RSS 可以稳定完成解析。
- 32 MiB 边界输入不会突破内存保护。
- 33 MiB 以上输入会被明确拒绝，不导致 isolate 失控。
- 单个 Queue consumer invocation 在 12 分钟软截止内完成或安全请求重试。
- 当前 25 个唯一 Feed 可以串行跑数小时，但应在 12 小时内清空队列，并且必须在下一次 05:00 Cron 前结束。
- 峰值内存目标小于 96 MB，为 128 MB 硬上限保留至少 25% 余量。
- 常规单消息 CPU 使用保持在 Queue Consumer 5 分钟 CPU 上限的安全余量内。
- 主队列消息超过重试上限后进入 DLQ，不能静默删除。

### Notion

- 主动发送速率不超过 1 请求/秒。
- 429/529 正确读取 `Retry-After`。
- 单次请求不超过 500 KB。
- 所有 URL 与 rich text 在提交前通过长度校验。
- 创建结果不确定时执行回查而不是盲重试。
- 父页更新只触及一个目标 paragraph block。

### 安全

- Secret 不存在于仓库、D1 或日志。
- 私网、localhost、元数据地址和不安全重定向被阻止。
- 生产测试/手工触发端点关闭或强鉴权。
- PAT 只属于 `PolyMaster` 的 `Personal Notes` workspace，且团队明确接受其“用户可见范围”权限边界；若不接受则改用只共享目标页面的 Internal Connection。

## 13. 回滚与停机

发生严重问题时按以下顺序处理：

1. 禁用 production Cron，并暂停主队列 Consumer；只禁用 Cron 不能停止已经排队的消息。
2. 不立即 purge 主队列或 DLQ，保留消息以便取证和恢复。
3. 保留 D1 运行账本和 Cloudflare Logs 作为证据。
4. 必要时轮换或撤销 Notion Token。
5. 根据 D1 保存的 Notion page ID 列出本次创建记录。
6. 任何 purge Queue、归档或删除 Notion 页面都必须另行人工确认，不自动执行。
7. 修复后先以 Dry Run 重放失败/DLQ 消息，再恢复 Consumer 和生产 Cron。

## 14. 明确不做的事项

MVP 不包含：

- 历史全量回填。
- 下载或转存音视频文件。
- 自动生成逐字稿、摘要或分类。
- 创建新的 Notion 单集库或内嵌视图。
- 修改播客父页除“内容同步时间”外的内容。
- 使用 Notion MCP 作为生产 Worker 的运行时依赖。
- 把完整 RSS、正文或媒体写入 D1/R2。
- 自动删除历史单集。
- Public Connection OAuth 和多用户安装流程。

## 15. 实施前的最终确认门

开始编码前只需确认以下五点：

1. 生产主链路采用 Cloudflare Queue，一个消息只处理一个 RSS，并同时配置 `max_batch_size=1`、`max_concurrency=1`。
2. Notion 默认使用 `PolyMaster` 在 `Personal Notes` workspace 创建的 PAT，接受其“以用户现有权限为边界”的范围；若不接受则改用 Internal Connection。
3. 单 Feed 默认硬上限采用 32 MiB。
4. D1 可以作为技术任务与幂等账本，但 Notion 继续是业务真源。
5. 超长“简介”允许截断到 Notion 属性安全长度，并在运行账本记录截断。

以上五点确认后即可进入阶段 0 和阶段 1。

## 参考文档

- [Cloudflare Workers Limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Cloudflare Queues Getting Started](https://developers.cloudflare.com/queues/get-started/)
- [How Cloudflare Queues Works](https://developers.cloudflare.com/queues/reference/how-queues-works/)
- [Cloudflare Queues Batching, Retries and Delays](https://developers.cloudflare.com/queues/configuration/batching-retries/)
- [Cloudflare Queues Delivery Guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
- [Cloudflare Queues Limits](https://developers.cloudflare.com/queues/platform/limits/)
- [Cloudflare Queues Pricing](https://developers.cloudflare.com/queues/platform/pricing/)
- [Cloudflare Dead Letter Queues](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/)
- [Notion Authorization](https://developers.notion.com/guides/get-started/authorization)
- [Notion Personal Access Tokens](https://developers.notion.com/guides/get-started/personal-access-tokens)
- [Notion Internal Connections](https://developers.notion.com/guides/get-started/internal-connections)
- [Notion Request Limits](https://developers.notion.com/reference/request-limits)
- [Notion Query a Data Source](https://developers.notion.com/reference/query-a-data-source)
- [Notion Create a Page](https://developers.notion.com/reference/post-page)
- [Notion Update a Block](https://developers.notion.com/reference/update-a-block)
