# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概览

Cloudflare Worker：每日 00:00（Asia/Shanghai，Cron `0 16 * * *` UTC）抓取"财经播客监控"Notion 库中的 RSS，流式解析后把 26 小时窗口内的新单集严格排重写入"财经播客单集库"，并更新播客父页的"内容同步时间"。**业务规则以 Notion 页面"财经播客 RSS 云端增量同步"为准**（排重、窗口、父页更新条件、禁止事项）；工程约束见本文件"关键不变量"。原实施计划 plan.md 已在上线后删除，历史版本可在 git 历史中查看。

## 常用命令

```bash
npm run typecheck                 # tsc --noEmit
npm test                          # vitest 全量
npx vitest run test/rss-pipeline.test.ts   # 单个测试文件
npm run dev                       # wrangler dev --env finance-production（--test-scheduled 可触发 scheduled）
npm run deploy                    # wrangler deploy --env finance-production（手动部署；push 到 main 会经后台 hook 自动部署，通常无需手动执行）
npm run trigger                   # 读取 .env 的 MANUAL_TRIGGER_TOKEN 手动补跑
npx wrangler types                # 改 wrangler.jsonc 后必须重新生成 worker-configuration.d.ts
npx wrangler d1 migrations apply podcast-monitor-finance-production --local --env finance-production
npx wrangler d1 migrations apply podcast-monitor-finance-production --remote --env finance-production  # 部署含新迁移的版本前必须先执行
# https://cf-worker-notion-podcast-monitor-finance-production.polymaster.workers.dev/logs  # 公开只读网页观测，日志滚动保留 7 天
```

- 唯一环境是 `env.finance-production`（用户决定不设 staging）；Worker 名 `cf-worker-notion-podcast-monitor-finance-production`。
- Secrets（`NOTION_TOKEN`、`MANUAL_TRIGGER_TOKEN`）用 `wrangler secret put <NAME> --env finance-production` 设置，绝不落盘进仓库。本地 `.env`（gitignored）保存 `MANUAL_TRIGGER_TOKEN`，供 `npm run trigger` 使用。
- 部署后新版本有约 1 分钟传播延迟：紧接着调用端点可能落在旧实例，判定结果前先重试确认。

## 架构

单一 Worker 脚本（`src/index.ts`）导出三个 handler，数据流：

```
scheduled()/POST /trigger-run → Producer：查 Notion 清单 → D1 outbox（feed_tasks
pending_enqueue→queued）→ 每个唯一 RSS 一条 Queue 消息
  ↓ Queue（max_batch_size=1, max_concurrency=1, retries=5, DLQ）
queue() → Consumer：单 Feed 串行——流式下载解析 → 26h 窗口 → dedupKey → Notion 排重
→（门控通过时）写单集 + 更新父页 callout → D1 记账
```

- **Notion 是业务真源，D1 只是技术账本**（runs / feed_tasks / producer_locks / episode_writes / parent_blocks，迁移在 `migrations/`）。所有幂等靠 D1 唯一约束 + Notion 回查双层保护；Queue 是 at-least-once，消息重投必须被终态 ack / 条件抢占吸收。
- **写入门控**：`DRY_RUN` var + `CANARY_FEED_HASHES`（逗号分隔 feed_url_hash 白名单，非空时仅白名单 Feed 真实写入，fail-closed）。`/rss-selftest` 恒零写入。
- **手动端点**（均需 `Authorization: Bearer <MANUAL_TRIGGER_TOKEN>`）：`/selftest`（Notion 连通性）、`/rss-selftest`（单 Feed 解析）、`/trigger-run`（完整 Producer 流程）、`/parent-check`（父页 callout 定位 preflight）。

## 关键不变量（违反会造成数据损坏或内存崩溃）

1. **排重键必须是与历史库兼容的明文格式**：`guid:<原始GUID>` / `link:<url>` / `media:<url>` / `title_date:<title>\n<iso日期>`（超 1900 字符才降级截断+sha256）。历史库 1387 条全部是 `guid:` 明文——改成哈希会把整库判为新增造成重复。涉及跨系统约定时先查真实数据。
2. **流式解析的内存边界不可退化**：禁止 `response.text()`/`arrayBuffer()`/DOM 解析；saxes 增量 write + TextDecoder stream 解码；字节数在每个 chunk 上累计、超 32MiB 立即 cancel；text/cdata handler 只在捕获目标字段时挂载。isolate 上限 128MB，实测 4.87MB Feed 峰值 ~3.5MB，保持这个量级。
3. **SSRF 双层防护**：`normalizeAndValidateFeedUrl` 拒绝所有 IP literal 与内网域名、逐跳重定向重校验（fetch 必须 `redirect:"manual"`）；`global_fetch_strictly_public` compat flag 是运行时兜底，不可移除。
4. **父页更新**："内容同步时间"在 callout 块内（非 paragraph），只替换时间 rich text 片段、保留其余文字与格式；只有该播客全部新增单集写入成功后才更新；无新增绝不触碰父页。
5. **Notion 请求**：严格串行 ≤1 req/s，429/529 按 Retry-After 退避；创建请求超时后先按业务键回查、禁止盲目重复 POST。
6. **Notion API 版本 2026-03-11**：归档只认 `in_trash`（`archived` 已移除）；建页 parent 用 `data_source_id`；属性名一律从 schema 动态解析，不硬编码。
7. **播客名称参与历史排重身份**：不要重命名“财经播客监控”库中的播客名称；如确需改名，必须先评估并迁移“财经播客单集库”中对应的播客名称与排重关系。

## 其他约定

- compatibility_date 受本地 wrangler 内置 workerd 上限约束（当前 2026-08-08），升级 wrangler 前不要手动调后。
- 生产 Cron 为 `0 16 * * *`（每日 00:00 Asia/Shanghai）；DRY_RUN=false、CANARY_FEED_HASHES 为空即全量真实写入。回滚开关：置 DRY_RUN=true 重新部署即停写。
- 大体积测试 fixture 由 `test/fixtures/generate-feed.ts` 生成，不提交大文件进 git。
- 日志为 JSON 单行结构化格式，含稳定 error_code；绝不输出 token、Authorization 或完整 Feed URL。
- `/logs` 与 `/logs.json` 是公开只读端点；渲染与 JSON 内容禁止出现 token、Authorization、完整 Feed URL 或 `error_summary` 原文。
