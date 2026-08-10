# Agent 初始化提示词

把本文件下面“提示词”一节完整交给你正在使用的编码 Agent。Agent 必须同时具备：

- 当前仓库的读写与终端权限；
- 已登录的 Cloudflare/Wrangler；
- 已连接到你自己 Notion 工作区的 Notion Connector 或 MCP，并且能访问你复制后的模板页面。

Notion Connector 是给 Agent 读写页面用的；Worker 使用的是另一套最小权限 Internal Integration。两者不要共用或互相替代。

## 提示词

```text
请完成这个仓库的首次配置和部署。先完整阅读 AGENTS.md、README.md、CLAUDE.md、wrangler.jsonc 和 package.json，再执行下面的工作；不要弱化其中的安全与幂等不变量。

目标 Notion 页面是我已经复制到自己工作区的「财经播客 RSS 云端增量同步 · 开源模板」。你必须通过当前 Agent 的 Notion Connector/MCP 搜索并读取这份副本，确认它包含「财经播客监控」和「财经播客单集库」两张数据库。不要使用仓库作者的原始页面或 wrangler.jsonc 中作者的默认 Data source ID。

1. 从我复制后的两张数据库读取各自的 Data source ID，并把 wrangler.jsonc 的 NOTION_MONITOR_DATA_SOURCE_ID 与 NOTION_EPISODE_DATA_SOURCE_ID 更新为我的值。它们是可提交的明文标识符，不是 Secret。
2. 检查「财经播客监控」的示例行正文含且仅含一个 callout，文字中有“内容同步时间：1970-01-01 00:00:00（Asia/Shanghai）”；检查两张数据库的属性类型符合 README。发现不一致时先报告，不要猜测字段或直接上线。
3. 确认我已经另行创建了只共享给这份模板副本的 Notion Internal Integration，权限仅为 Read content、Insert content、Update content。不要要求我把 token 发到聊天、代码或日志。用交互式 `npx wrangler secret put NOTION_TOKEN --env finance-production` 让我在终端提示中输入。
4. 用 `openssl rand -hex 32` 生成 MANUAL_TRIGGER_TOKEN；不要把值输出到聊天或提交到 Git。通过 `npx wrangler secret put MANUAL_TRIGGER_TOKEN --env finance-production` 设置，并让我把同一个值安全保存到本机 gitignored 的 .env 中供 `npm run trigger` 使用。
5. 首次验证阶段把 DRY_RUN 临时设为 true。执行 npm install、npx wrangler types、npm run typecheck、npm test。确认 Queue、DLQ、D1 和 Cron 配置一致，并确认 FEED_TASKS_DLQ_NAME 与 DLQ 名完全相同。
6. 使用 `npm run deploy` 部署；不要把它替换成裸 `wrangler deploy`，因为前者会先运行远程 D1 migrations。部署后等待传播，验证 /health、/logs.json、受 Bearer token 保护的 /selftest 和 /parent-check，并对我指定的一个真实 RSS 调用恒零写入的 /rss-selftest。
7. 在 DRY_RUN=true 下手动执行一次 /trigger-run，读取安全日志并总结结果。只有所有 preflight 都通过后，才请求我明确确认是否把 DRY_RUN 改为 false 并再次运行 `npm run deploy`。不要自行开启真实 Notion 写入。
8. 最后回读 Cloudflare 配置：两个 NOTION_*_DATA_SOURCE_ID 必须是 plaintext vars；NOTION_TOKEN 和 MANUAL_TRIGGER_TOKEN 必须是 Secrets。给我 Worker URL、验证结果、变更文件和仍需人工处理的事项，但不得显示任何 Secret、Authorization、完整 Feed URL 或敏感错误原文。

如果当前 Agent 无法访问 Notion，先停止配置并告诉我：需要在 Agent 产品中启用 Notion Connector/MCP、授权我的工作区，并让复制后的模板页面对该连接可见。不要退而要求我粘贴 Notion token。
```
