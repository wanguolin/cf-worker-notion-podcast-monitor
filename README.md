# 财经播客 RSS 云端增量同步

用 Notion 管理播客清单，由 Cloudflare Worker 每天抓取 RSS/Atom，把近 26 小时的新单集严格排重后写回 Notion。整个流程运行在 Cloudflare Cron、Queues 和 D1 上，不依赖常驻服务器，也不需要每天启动 AI 会话。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/wanguolin/cf-worker-notion-podcast-monitor)

> [!WARNING]
> **Notion 公开模板尚未发布。** 模板结构已经完成，但维护者仍需打开「财经播客 RSS 云端增量同步 · 开源模板」，执行 **Share → Publish → Publish**，再到 **Site customization → Header** 打开 **Duplicate as template** 并选择 **Publish changes**。公开 `notion.site` 链接补到这里以前，普通用户无法完成“复制模板”阶段，也绝不能使用作者的私有 Data source ID。

**Notion 模板：待发布**

## 让 Agent 带你完成部署

本 README 同时是给人看的项目说明，也是给编码 Agent 执行的交互式部署规约。推荐使用 Codex、Claude Code 或其他同时具备仓库、终端和 MCP 能力的 Agent。

用户只需要先完成三件事：

1. 把本仓库 Clone 到本地并在编码 Agent 中打开。
2. 给 Agent 接通 Notion MCP 和 Cloudflare API MCP；配置方法见下一节。
3. 对 Agent 发送下面这句话：

```text
请从头到尾阅读 README.md，并严格按照其中“给 Agent 的执行协议”交互式指导我完成首次部署。每次只推进一个阶段；不要让我在聊天中粘贴任何 Secret；真实写入前必须再次征得我的明确同意。
```

从这一步开始，Agent 应主动检查能力、解释当前阶段、向用户索取必要的非敏感选择，并完成所有能够安全自动完成的读写与验证。用户不需要自己从 README 中拼装命令。

## 先给 Agent 接通能力

需要三类能力：

| 能力 | 用途 | 是否等同于 Worker 凭证 |
| --- | --- | --- |
| Notion MCP / Connector | Agent 查找和检查用户复制后的模板、读取两张数据库的 Data source ID | 否 |
| Cloudflare API MCP | Agent 检查账号、Worker、D1、Queues、Cron、Builds 与绑定状态 | 否 |
| 仓库与终端 | Agent 修改用户自己的配置、运行测试、Wrangler 和受保护的自检 | 否 |

Notion MCP 和 Cloudflare MCP 都通过用户 OAuth 授权 Agent。它们不能替代 Worker 运行时需要的 `NOTION_TOKEN` 和 `MANUAL_TRIGGER_TOKEN`。

Notion MCP 会以当前用户身份工作，并继承该用户在 workspace 中本来就能访问的内容范围。授权前应确认所用 Agent 值得信任；需要更严格隔离时，使用专门的 Notion workspace 或权限更小的 Notion 用户。Worker 的 Internal Integration 则应继续只共享模板根页面。

### Codex / ChatGPT 桌面端

Codex 桌面端可以打开 **Settings → MCP servers → Add server**，分别添加两个 Streamable HTTP server，保存后重启并完成 OAuth：

| 名称 | URL |
| --- | --- |
| `notion` | `https://mcp.notion.com/mcp` |
| `cloudflare-api` | `https://mcp.cloudflare.com/mcp` |

也可以在 `~/.codex/config.toml` 中配置：

```toml
[mcp_servers.notion]
url = "https://mcp.notion.com/mcp"

[mcp_servers.cloudflare-api]
url = "https://mcp.cloudflare.com/mcp"
```

然后运行：

```bash
codex mcp login notion
codex mcp login cloudflare-api
codex mcp list
```

桌面端、Codex CLI 和 IDE 扩展会共享同一 Codex host 的 MCP 配置。桌面端或 IDE 也可以在 MCP server 列表中选择 **Authenticate**；在会话中用 `/mcp` 检查连接状态。详见 [Codex MCP 官方说明](https://developers.openai.com/codex/mcp/)。

如果使用 ChatGPT Work 的托管会话，请从 **Plugins** 安装或启用相应连接器；ChatGPT 网页不会读取本机的 `~/.codex/config.toml`。

### Claude Code 与其他 MCP Client

Claude Code 可以运行：

```bash
claude mcp add --transport http notion https://mcp.notion.com/mcp
claude mcp add --transport http cloudflare-api https://mcp.cloudflare.com/mcp
```

然后在 Claude Code 中使用 `/mcp` 完成两次 OAuth。其他支持远程 MCP 的客户端，添加同样的两个 Streamable HTTP URL 即可。Notion 的各客户端配置示例见 [Notion MCP 官方指南](https://developers.notion.com/guides/mcp/get-started-with-mcp)，Cloudflare 的连接说明见 [Cloudflare API MCP](https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/)。

授权 Cloudflare 时，只选择本项目实际需要的 Workers、D1、Queues、Cron、Builds 和 Worker 配置权限；缺少权限时让 Agent 报告具体缺口，不要直接给整个账号的无限权限。

## 给 Agent 的执行协议

> [!IMPORTANT]
> 以下内容是给负责部署的 Agent 的强制指令。Agent 必须完整阅读 README、`AGENTS.md`、`CLAUDE.md`、`wrangler.jsonc` 和 `package.json` 后再开始操作。

Agent 必须遵守：

1. **一次只推进一个阶段。** 每个阶段先说明目标和需要用户完成的动作，完成后回读验证，再宣布进入下一阶段。
2. **先检查能力。** 如果 Notion MCP、Cloudflare MCP、仓库写权限或终端缺失，暂停部署，指导用户按上一节接通；不要用猜测或要求用户粘贴 token 代替 MCP。
3. **绝不接收或展示 Secret。** 不得要求用户把 Notion Integration secret、`MANUAL_TRIGGER_TOKEN`、Authorization header 或 Cloudflare token 粘贴到聊天、代码、Issue、提交、日志或 D1。
4. **区分三条授权链。** Agent 的 Notion OAuth、Agent 的 Cloudflare OAuth、Worker 的 Notion Internal Integration 互不替代。
5. **只使用用户自己的资源。** 不得让用户部署作者的 Notion Data source ID、D1 database ID、Worker、Queue 或账号资源。
6. **首次部署必须 dry-run。** 在用户环境首次上线前确保 `DRY_RUN=true`。没有完成全部 preflight，不得开启真实 Notion 写入。
7. **真实写入需要二次确认。** 在改为 `DRY_RUN=false` 前，向用户展示 dry-run 验证摘要，并明确询问是否开启真实写入；没有明确肯定答复就保持 dry-run。
8. **配置必须回读。** “已经填写”“命令返回 0”或“计划这样做”不等于成功。必须读取 Notion 模板结构、Cloudflare 绑定类型、Secret 名称、资源 ID、Build command 和线上端点结果。
9. **禁止弱化关键不变量。** 不得修改排重键格式、流式解析、SSRF 防护、Notion 串行限速、父页更新时间门控或日志脱敏约束来绕过错误。

Agent 在每个阶段结束时用下面的格式向用户汇报：

```text
阶段：<名称>
状态：通过 / 需要用户操作 / 阻塞
已验证：<只列不含 Secret 的证据>
下一步：<一个明确动作>
```

## 阶段 0：部署前检查

Agent 执行只读检查：

1. 确认当前仓库是用户准备部署的副本，并记录 Git remote；如果是作者仓库的只读 Clone，解释部署按钮会在用户账号创建自己的副本。
2. 检查 Node.js 20+、npm、Git；本地 Wrangler 命令使用仓库依赖，不要求全局安装。
3. 通过 Notion MCP 的 `fetch self` 或等价工具回读当前 workspace 和用户身份。
4. 通过 Cloudflare API MCP 回读当前 Cloudflare account；不得只依据 OAuth 成功页面判断。
5. 确认用户拥有 GitHub/GitLab 账号、Cloudflare Workers Paid 计划，以及创建 Worker、D1、Queues 和 Cron 的权限。本项目的 `cpu_ms=300000` 依赖 Workers Paid 能力。

若任何一项失败，停在本阶段完成修复，不得提前创建云资源。

## 阶段 1：复制并检查 Notion 模板

### 用户操作

1. 打开本 README 顶部的公开 Notion 模板链接。
2. 点击右上角 **Duplicate**，选择自己的 Notion workspace。
3. 告诉 Agent 已完成复制；不要把作者原始模板直接共享给自己的 Worker。

### Agent 操作

1. 通过 Notion MCP 搜索精确标题「财经播客 RSS 云端增量同步 · 开源模板」。
2. 如果出现多个结果，让用户确认哪一个位于自己的 workspace；不得凭 ID 猜测。
3. Fetch 模板根页面，确认它包含「财经播客监控」和「财经播客单集库」两张数据库。
4. 读取两张数据库的 schema，并取得返回的 `collection://...` Data source ID。
5. 检查「财经播客监控」安全示例行：RSS 为空，正文含且仅含一个 callout，并包含：

```text
内容同步时间：1970-01-01 00:00:00（Asia/Shanghai）
```

如果公开模板链接仍显示“尚未发布”，Agent 必须在此停止并告诉用户等待维护者发布；不得回退使用 README、Git 历史或作者 `wrangler.jsonc` 中的 ID。

### 模板契约

「财经播客监控」是唯一抓取清单：

| 属性 | 类型 | 用途 |
| --- | --- | --- |
| 播客名称 | Title | 稳定的播客身份；不要随意重命名 |
| RSS地址 | URL | RSS 或 Atom 地址；留空即跳过 |
| 分类 | Select | 写入单集库的分类 |
| 语言 | Select | 写入单集库的语言 |
| 主播 | Text | 展示字段 |
| 入选理由 | Text | 展示字段 |
| 封面 | Files | Gallery 封面 |
| 最后更新 | Last edited time | Notion 系统字段 |

「财经播客单集库」是结果库。`单集标题`、`播客名称`、`排重键` 是核心字段；其他字段为：

`分类`、`语言`、`发布日期`、`上海时间`、`GUID`、`原始链接`、`媒体下载`、`媒体类型`、`媒体长度(Byte)`、`作者`、`时长`、`季`、`集`、`节目类型`、`显式内容`、`RSS分类`、`关键词`、`封面链接`、`逐字稿链接`、`RSS源`、`简介`、`加入时间`、`行更新时间`。

Agent 发现字段缺失、重名或属性类型不符时必须 fail closed，向用户报告，不得自行发明映射。

## 阶段 2：创建 Worker 专用的 Notion Integration

Agent 先向用户解释区别：

| 连接 | 身份 | 用途 | 凭证去向 |
| --- | --- | --- | --- |
| Notion MCP | 用户 OAuth | Agent 查找、读取和配置模板 | MCP Client 的凭证存储 |
| Notion Internal Integration | Notion bot | 已部署 Worker 每日读写两张数据库 | Cloudflare Secret `NOTION_TOKEN` |

### 用户操作

1. 打开 [Notion Integrations](https://www.notion.so/profile/integrations)，创建一个 Internal Integration。
2. Content capabilities 只开启 **Read content、Insert content、Update content**。
3. 回到自己复制后的模板根页面，选择 **Share / Connections**，只把该模板页面及其两张子数据库共享给这个 Integration。
4. 保留 Integration secret，稍后直接填入 Cloudflare 的加密输入框或 Wrangler 的隐藏提示；不要发给 Agent。

### Agent 操作

1. 把阶段 1 读取到的两个 Data source ID 写入用户部署副本的 `wrangler.jsonc`：
   - `NOTION_MONITOR_DATA_SOURCE_ID`
   - `NOTION_EPISODE_DATA_SOURCE_ID`
2. 明确告诉用户这两个 ID 是可提交的明文定位符，不是凭证；没有 `NOTION_TOKEN` 和页面授权时，ID 本身不能访问数据。
3. 检查没有把任何 token 写入 `.dev.vars.example`、`wrangler.jsonc`、Git diff 或终端输出。
4. 修改 `wrangler.jsonc` 后运行 `npx wrangler types`，让生成类型与绑定一致。

## 阶段 3：首次部署到 Cloudflare

### 推荐路径：Deploy to Cloudflare

Agent 指导用户点击 README 顶部按钮。Cloudflare 会把仓库复制到用户自己的 GitHub/GitLab 账号，并自动创建：

- 1 个 Worker；
- 1 个 D1 database；
- 1 个 Feed task Queue；
- 1 个 DLQ；
- 每日 Cron Trigger；
- Workers Builds 持续部署。

部署表单中必须确认：

| 名称 | 类型 | 用户如何填写 |
| --- | --- | --- |
| `NOTION_MONITOR_DATA_SOURCE_ID` | 明文 var | 自己模板副本的监控库 Data source ID |
| `NOTION_EPISODE_DATA_SOURCE_ID` | 明文 var | 自己模板副本的单集库 Data source ID |
| `NOTION_TOKEN` | Secret | 用户直接粘贴到 Cloudflare 加密输入框，不经过 Agent 对话 |
| `MANUAL_TRIGGER_TOKEN` | Secret | 用户在不向 Agent 共享输出的终端或密码管理器中生成随机值，直接填入加密输入框并安全保存；可使用 `openssl rand -hex 32` |
| `DRY_RUN` | 明文 var | 首次部署必须为 `true` |

保持默认 Queue 名时不要修改 `FEED_TASKS_DLQ_NAME`；如果改了 DLQ 名，两者必须完全一致。

Workers Builds 的 Deploy command 必须是：

```bash
npm run deploy
```

不要改为裸 `wrangler deploy`。本项目的脚本会先运行 `npm run db:migrate:remote`，把 D1 migrations 应用到绑定名 `DB`，成功后才发布 `finance-production` Worker。Cloudflare 对自定义部署脚本和自动资源配置的说明见 [Deploy buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/)。

### CLI 备用路径

只有部署按钮不可用，且用户明确同意 Agent 创建 Cloudflare 资源时，才使用 Cloudflare API MCP 或 Wrangler 逐项创建新的 D1、两个 Queue 和 Worker，并把返回的资源 ID 写回用户副本。不得复用仓库作者的 D1 database ID。

设置 Secret 时，Agent 只启动交互式命令，把隐藏输入交给用户：

```bash
npx wrangler secret put NOTION_TOKEN --env finance-production
npx wrangler secret put MANUAL_TRIGGER_TOKEN --env finance-production
```

如果 Worker 尚不存在，Wrangler 可能询问是否创建；Agent 先向用户解释将创建的 Worker 名，再由用户确认。不要用会把 Secret 暴露在命令历史或进程参数里的写法。

### 部署后 Agent 回读

Agent 使用 Cloudflare MCP、Wrangler 或两者交叉验证：

1. Worker、D1、Feed Queue、DLQ 和 Cron 都属于用户当前账号。
2. D1 binding 名为 `DB`，Queue binding 名为 `FEED_TASKS_QUEUE`。
3. `NOTION_MONITOR_DATA_SOURCE_ID`、`NOTION_EPISODE_DATA_SOURCE_ID` 是 plaintext vars，值来自用户模板副本。
4. `NOTION_TOKEN`、`MANUAL_TRIGGER_TOKEN` 只以 Secret 名称出现，不能读取或显示值。
5. `DRY_RUN=true`，`CANARY_FEED_HASHES` 默认为空。
6. Build command 为 `npm run deploy`。
7. 部署按钮创建的用户仓库已持久化用户自己的 Data source ID 和新 D1 ID；如果没有，Agent 应修改用户仓库并提交，否则下一次构建可能把 Dashboard 配置覆盖回作者默认值。

## 阶段 4：零写入验收

用户把 `MANUAL_TRIGGER_TOKEN` 安全保存在本机 gitignored 的 `.env` 中。Agent 只能检查变量是否存在，不得读取、打印或总结其值。

Agent 从 Cloudflare 回读 Worker URL，等待新版本传播，然后验证：

```bash
curl -sS "$WORKER_URL/health" | jq
curl -sS "$WORKER_URL/logs.json" | jq
```

再从本机 `.env` 加载 token，调用受保护端点；命令和输出不得包含 Authorization 值：

```bash
curl -sS -X POST "$WORKER_URL/selftest" \
  -H "Authorization: Bearer $MANUAL_TRIGGER_TOKEN" | jq

curl -sS -X POST "$WORKER_URL/parent-check" \
  -H "Authorization: Bearer $MANUAL_TRIGGER_TOKEN" | jq
```

让用户选择一个真实公开 RSS，调用恒为零写入的解析测试：

```bash
curl -sS -X POST "$WORKER_URL/rss-selftest" \
  -H "Authorization: Bearer $MANUAL_TRIGGER_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"feed_url":"https://example.com/feed.xml"}' | jq
```

确认 `DRY_RUN=true` 后，再执行一次完整 Producer：

```bash
curl -sS -X POST "$WORKER_URL/trigger-run" \
  -H "Authorization: Bearer $MANUAL_TRIGGER_TOKEN" | jq
```

验收通过条件：

- `/health` 成功；
- `/selftest` 完成 Notion 身份、两张 schema、查询、测试页创建与回收；
- `/parent-check` 找到唯一正确的同步时间 callout；
- `/rss-selftest` 能流式下载和解析 Feed，且没有 Notion 写入；
- `/trigger-run` 成功创建并消费 dry-run 任务；
- `/logs` 只出现安全计数和稳定错误码，不出现 token、Authorization、完整 Feed URL 或原始错误详情。

部署后新版本可能有约 1 分钟传播延迟；紧接着出现旧行为时，Agent 应等待并重试确认，而不是立即修改代码。

## 阶段 5：开启真实写入

Agent 必须先向用户展示阶段 4 的无敏感信息摘要，并询问：

```text
所有 dry-run 验收已经通过。是否现在把 DRY_RUN 改为 false，并部署会真实写入你 Notion 模板副本的版本？
```

只有用户明确回答同意后，Agent 才能：

1. 在用户部署副本中把 `DRY_RUN` 改为 `false`；
2. 运行 `npx wrangler types`、`npm run typecheck`、`npm test`；
3. 使用 `npm run deploy` 发布；
4. 回读 `DRY_RUN=false`；
5. 先只配置一个真实播客做小范围验证，再根据用户决定扩展清单。

如果用户拒绝、没有回答或验证有任何失败，保持 `DRY_RUN=true`。

## 完成交付时 Agent 应报告

Agent 的最终报告必须包含：

- 用户自己的代码仓库与提交；
- Worker URL 和当前 version；
- D1、Queue、DLQ、Cron、Build command 的回读状态；
- 两个 Data source ID 已来自用户模板副本；
- 两个 Secret 名称已存在，但绝不显示值；
- dry-run 和真实写入开关的当前状态；
- `/health`、`/selftest`、`/parent-check`、`/rss-selftest`、`/trigger-run` 的结果摘要；
- 仍需用户完成的事项。

## 工作原理

![财经播客 RSS 云端增量同步架构](docs/architecture.png)

1. Cron 每天 `00:00 Asia/Shanghai`（`0 16 * * *` UTC）触发 Producer，也可通过受保护端点手动补跑。
2. Producer 查询「财经播客监控」的全部当前非归档行；同一 RSS 的多条父页映射会合并，每个唯一 RSS 生成一个 D1 outbox 任务。
3. 消息成功送入 Cloudflare Queue 后，任务从 `pending_enqueue` 变为 `queued`；发送结果不确定时可以安全重投。
4. Consumer 以 `max_batch_size=1`、`max_concurrency=1` 每次只处理一个 Feed。
5. Feed 下载逐跳做 SSRF 校验，使用 `ReadableStream + TextDecoder + saxes` 增量解析；超过 32 MiB 立即终止。
6. 只保留 26 小时窗口内的候选，按 `GUID → 原始链接 → 媒体链接 → 标题+发布日期` 生成历史兼容的明文排重键。
7. 先完成全部 Notion 回查，再按发布日期从旧到新写入；创建超时后先回查，禁止盲目重复 POST。
8. 该播客的全部新增单集写入成功后，才最小范围替换父页 callout 中的时间片段；部分失败或无新增都不更新父页。

Queue 是 at-least-once。项目用 D1 唯一约束、任务状态抢占和 Notion 业务键回查共同吸收重复投递；可重试错误按指数退避，超过 5 次进入 DLQ。

## 配置参考

默认参数位于 `wrangler.jsonc`：

| 配置 | 默认值 | 说明 |
| --- | ---: | --- |
| `RSS_WINDOW_HOURS` | `26` | 单集发布时间窗口 |
| `RSS_MAX_BYTES` | `33554432` | 单 Feed 最大 32 MiB |
| `RSS_CONNECT_TIMEOUT_MS` | `15000` | 建连超时 |
| `RSS_TIMEOUT_MS` | `300000` | 下载总超时 |
| `RSS_MAX_REDIRECTS` | `5` | 最大重定向次数，每跳重新做 SSRF 校验 |
| `RSS_MAX_WINDOW_ITEMS` | `100` | 窗口内最多处理的单集数 |
| `MESSAGE_SOFT_DEADLINE_MS` | `720000` | 单任务软截止时间 |
| `DRY_RUN` | `false` | `true` 时停止全部 Notion 写入；新用户首次部署必须覆盖为 `true` |
| `CANARY_FEED_HASHES` | 空 | 非空时只有白名单 Feed 可以真实写入 |

## 关键不变量

- 排重键格式必须保持 `guid:<原始GUID>`、`link:<url>`、`media:<url>`、`title_date:<title>\n<iso日期>`；不要改成全量哈希，否则旧库会被误判为全部新增。
- 不要把流式解析改成 `response.text()`、`arrayBuffer()` 或 DOM 全量解析。Worker isolate 只有 128 MB 内存。
- 不要移除 URL/IP/重定向的应用层 SSRF 校验，也不要移除 `global_fetch_strictly_public` compatibility flag。
- Notion 请求保持严格串行且不高于约 1 req/s；429/529 必须尊重 `Retry-After`。
- 没有新增时禁止更新父页；部分单集写入失败时也禁止更新父页。
- `/logs` 是公开端点，禁止输出 token、Authorization、完整 Feed URL 和原始错误详情。
- 播客名称参与历史排重身份；确需改名时，先迁移单集库中对应的名称和排重关系。

## 本地开发

```bash
npm install
npm run typecheck
npm test
```

本地启动：

```bash
cp .dev.vars.example .dev.vars.finance-production
# 只在 gitignored 文件中填写测试 Secret
npm run dev
```

常用命令：

```bash
npx wrangler types
npm run db:migrate:remote
npm run deploy
```

修改 `wrangler.jsonc` 后必须重新运行 `npx wrangler types`。生产部署包含新 D1 migration 时，应先应用 migration 再发布 Worker；`npm run deploy` 已按这个顺序执行。

## HTTP 端点

| 端点 | 鉴权 | 写入 | 用途 |
| --- | --- | --- | --- |
| `GET /health` | 无 | 否 | 健康检查 |
| `GET /logs` | 无 | 否 | 7 天滚动网页日志 |
| `GET /logs.json` | 无 | 否 | 同一份日志的 JSON |
| `POST /selftest` | Bearer token | 否 | Notion 连接与 schema preflight |
| `POST /rss-selftest` | Bearer token | 恒为 dry-run | 单 Feed 下载解析或入队测试 |
| `POST /parent-check` | Bearer token | 否 | 父页同步 callout preflight |
| `POST /trigger-run` | Bearer token | 取决于写入开关 | 手动执行完整 Producer |

## 维护者：发布 Notion 模板

这个开关只存在于 Notion 页面右上角，不在 Notion Integration 后台，也不在 Cloudflare：

1. 用维护者账号打开「财经播客 RSS 云端增量同步 · 开源模板」。
2. 点击右上角 **Share**。
3. 打开 **Publish** 标签，点击 **Publish**。
4. 进入 **Site customization → Header**。
5. 打开 **Duplicate as template**。
6. 点击顶部 **Publish changes**。
7. 返回 **Share → Publish**，复制生成的 `notion.site` URL。
8. 用该 URL 替换 README 顶部的“尚未发布”警告，并实际用另一个 Notion workspace 测试 Duplicate 是否同时复制两张数据库和安全示例行。

Notion 会默认连同子页面一起发布；操作前应再次确认模板不含私有播客清单、历史单集、内部规约、成员信息或其他不应公开的内容。详见 [Notion Sites 发布说明](https://www.notion.com/help/public-pages-and-web-publishing) 和 [公开页面复制说明](https://www.notion.com/help/duplicate-public-pages)。

## 许可证

本项目采用 [MIT License](LICENSE)。
