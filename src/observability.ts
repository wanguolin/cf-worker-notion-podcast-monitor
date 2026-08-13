const LOG_RETENTION_DAYS = 7;
// 公开匿名端点：行数上限与快照缓存共同封顶单请求的 D1 读取成本，
// 防止刷新风暴放大 D1 费用。7 天 × 每天 3 班 = 21 个常规 run；60 为手动补跑留足余量。
const LOG_MAX_RUN_ROWS = 60;
// 当前约 38 个 Feed：21 × 38 ≈ 800 条常规明细；4000 兼顾手动补跑与清单增长。
const LOG_MAX_FEED_TASK_ROWS = 4_000;
const LOG_SNAPSHOT_TTL_MS = 60_000;

const LOG_RESPONSE_HEADERS = {
  "Cache-Control": "public, max-age=60",
  "X-Robots-Tag": "noindex",
} as const;

type LogDatabase = Pick<D1Database, "prepare">;

type RunLogRow = {
  run_id: string;
  cron: string;
  scheduled_at: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  catalog_row_count: number;
  unique_feed_count: number;
  succeeded_feed_count: number;
  failed_feed_count: number;
  new_episode_count: number;
  parent_update_count: number;
};

type FeedTaskLogRow = {
  run_id: string;
  feed_url_hash: string;
  podcast_name: string | null;
  feed_host: string | null;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  parsed_item_count: number;
  window_item_count: number;
  new_episode_count: number;
  already_exists_count: number;
  parent_update_count: number;
  error_code: string | null;
};

export type PublicFeedTaskLog = {
  feed_id: string;
  podcast_name: string;
  feed_host: string;
  status: string;
  parsed_item_count: number;
  window_item_count: number;
  new_episode_count: number;
  already_exists_count: number;
  parent_update_count: number;
  error_code: string | null;
  duration_ms: number | null;
};

export type PublicRunLog = Omit<RunLogRow, "run_id"> & {
  run_id: string;
  already_exists_count: number;
  feeds: PublicFeedTaskLog[];
};

export type PublicLogSnapshot = {
  generated_at: string;
  retention_days: number;
  anomalies: PublicLogAnomaly[];
  runs: PublicRunLog[];
};

// 期望的每 8 小时 Cron 触发时刻（UTC）。必须与 wrangler.jsonc 保持同步；
// 任意非 manual Cron 运行落入覆盖窗口时，都视为对应 tick 已覆盖。
const EXPECTED_CRON_UTC_HOURS = [0, 8, 16] as const;
const EXPECTED_CRON_UTC_MINUTE = 0;
const CRON_COVERAGE_EARLY_MS = 30 * 60 * 1_000;
// +2h 是触发延迟/短时补跑容忍；最晚运行与前一准点 tick 相隔 10h，26h 窗口仍重叠 16h。
const CRON_COVERAGE_LATE_MS = 2 * 60 * 60 * 1_000;
// 三个等距 UTC 小时点将一天切成三个 8 小时 tick。
const CRON_TICK_INTERVAL_MS = 8 * 60 * 60 * 1_000;

export type PublicLogAnomaly = {
  type: "cron_missing";
  expected_at: string;
  detail: string;
};

// 纯派生检测：Cron 若某一班根本没触发，不存在任何能写日志的进程，
// 所以只能在渲染时对照期望时刻与 runs 记录补出异常，不落库、不写路径。
export function detectCronAnomalies(
  runs: ReadonlyArray<Pick<RunLogRow, "cron" | "scheduled_at" | "started_at">>,
  nowMs: number,
): PublicLogAnomaly[] {
  const startTimes = runs
    .map((run) => Date.parse(run.started_at))
    .filter((value) => Number.isFinite(value));
  if (startTimes.length === 0) {
    return [];
  }
  // 留存窗口内最早记录之前的时刻不判定：无法区分「Cron 缺失」与「当时尚未部署/日志已清理」。
  const earliestMs = Math.min(...startTimes);
  const cronScheduledTimes = runs
    .filter((run) => !run.cron.startsWith("manual"))
    .map((run) => Date.parse(run.scheduled_at))
    .filter((value) => Number.isFinite(value));
  const earliest = new Date(earliestMs);
  const firstTick = Date.UTC(
    earliest.getUTCFullYear(),
    earliest.getUTCMonth(),
    earliest.getUTCDate(),
    EXPECTED_CRON_UTC_HOURS[0],
    EXPECTED_CRON_UTC_MINUTE,
  );
  const anomalies: PublicLogAnomaly[] = [];
  for (
    let tick = firstTick;
    tick <= nowMs - CRON_COVERAGE_LATE_MS;
    tick += CRON_TICK_INTERVAL_MS
  ) {
    if (tick < earliestMs) {
      continue;
    }
    const covered = cronScheduledTimes.some(
      (scheduled) =>
        scheduled >= tick - CRON_COVERAGE_EARLY_MS &&
        scheduled <= tick + CRON_COVERAGE_LATE_MS,
    );
    if (!covered) {
      const expectedAt = new Date(tick).toISOString();
      anomalies.push({
        type: "cron_missing",
        expected_at: expectedAt,
        detail: `期望 ${formatShanghai(expectedAt)}（Asia/Shanghai）触发的每 8 小时 Cron 没有运行记录`,
      });
    }
  }
  return anomalies.reverse();
}

function elapsedMilliseconds(startedAt: string | null, finishedAt: string | null): number | null {
  if (startedAt === null || finishedAt === null) {
    return null;
  }
  const started = Date.parse(startedAt);
  const finished = Date.parse(finishedAt);
  return Number.isFinite(started) && Number.isFinite(finished)
    ? Math.max(0, finished - started)
    : null;
}

function displayIdentity(row: FeedTaskLogRow): {
  feedId: string;
  feedHost: string;
  podcastName: string;
} {
  const feedId = row.feed_url_hash.slice(0, 8);
  return {
    feedId,
    feedHost: row.feed_host?.trim() || feedId,
    podcastName: row.podcast_name?.trim() || feedId,
  };
}

export async function loadLogSnapshot(database: LogDatabase): Promise<PublicLogSnapshot> {
  const runsResult = await database.prepare(
    `SELECT
      run_id,
      cron,
      scheduled_at,
      started_at,
      finished_at,
      status,
      catalog_row_count,
      unique_feed_count,
      succeeded_feed_count,
      failed_feed_count,
      new_episode_count,
      parent_update_count
    FROM runs
    WHERE datetime(started_at) >= datetime('now', '-7 days')
    ORDER BY datetime(started_at) DESC, run_id DESC
    LIMIT ${LOG_MAX_RUN_ROWS}`,
  ).all<RunLogRow>();
  const tasksResult = await database.prepare(
    `SELECT
      task.run_id,
      task.feed_url_hash,
      task.podcast_name,
      task.feed_host,
      task.status,
      task.started_at,
      task.finished_at,
      task.parsed_item_count,
      task.window_item_count,
      task.new_episode_count,
      task.already_exists_count,
      task.parent_update_count,
      task.error_code
    FROM feed_tasks AS task
    INNER JOIN runs AS run ON run.run_id = task.run_id
    WHERE datetime(run.started_at) >= datetime('now', '-7 days')
    ORDER BY datetime(run.started_at) DESC, task.podcast_name, task.feed_url_hash
    LIMIT ${LOG_MAX_FEED_TASK_ROWS}`,
  ).all<FeedTaskLogRow>();

  const feedsByRun = new Map<string, PublicFeedTaskLog[]>();
  for (const row of tasksResult.results) {
    const identity = displayIdentity(row);
    const feed: PublicFeedTaskLog = {
      feed_id: identity.feedId,
      podcast_name: identity.podcastName,
      feed_host: identity.feedHost,
      status: row.status,
      parsed_item_count: row.parsed_item_count,
      window_item_count: row.window_item_count,
      new_episode_count: row.new_episode_count,
      already_exists_count: row.already_exists_count,
      parent_update_count: row.parent_update_count,
      error_code: row.error_code,
      duration_ms: elapsedMilliseconds(row.started_at, row.finished_at),
    };
    const feeds = feedsByRun.get(row.run_id);
    if (feeds === undefined) {
      feedsByRun.set(row.run_id, [feed]);
    } else {
      feeds.push(feed);
    }
  }

  return {
    generated_at: new Date().toISOString(),
    retention_days: LOG_RETENTION_DAYS,
    anomalies: detectCronAnomalies(runsResult.results, Date.now()),
    runs: runsResult.results.map((row) => {
      const feeds = feedsByRun.get(row.run_id) ?? [];
      return {
        run_id: row.run_id,
        cron: row.cron,
        scheduled_at: row.scheduled_at,
        started_at: row.started_at,
        finished_at: row.finished_at,
        status: row.status,
        catalog_row_count: row.catalog_row_count,
        unique_feed_count: row.unique_feed_count,
        succeeded_feed_count: row.succeeded_feed_count,
        failed_feed_count: row.failed_feed_count,
        new_episode_count: row.new_episode_count,
        parent_update_count: row.parent_update_count,
        already_exists_count: feeds.reduce(
          (total, feed) => total + feed.already_exists_count,
          0,
        ),
        feeds,
      };
    }),
  };
}

export async function pruneOldRuns(database: LogDatabase): Promise<void> {
  await database
    .prepare("DELETE FROM runs WHERE started_at < datetime('now','-7 days')")
    .run();
}

function escapeHtml(value: string | number): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatShanghai(value: string | null): string {
  if (value === null) {
    return "—";
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return "—";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

function formatDuration(durationMs: number | null): string {
  if (durationMs === null) {
    return "—";
  }
  if (durationMs < 1_000) {
    return `${durationMs} ms`;
  }
  if (durationMs < 60_000) {
    return `${(durationMs / 1_000).toFixed(1)} 秒`;
  }
  return `${Math.floor(durationMs / 60_000)} 分 ${Math.round((durationMs % 60_000) / 1_000)} 秒`;
}

function triggerLabel(cron: string): string {
  return cron.startsWith("manual") ? "manual" : `cron (${cron})`;
}

function statusClass(status: string): string {
  if (status === "succeeded") {
    return "good";
  }
  if (status === "failed" || status === "dead_lettered") {
    return "bad";
  }
  if (status === "partial" || status === "retrying") {
    return "warn";
  }
  return "neutral";
}

function summaryCards(run: PublicRunLog | undefined): string {
  if (run === undefined) {
    return '<div class="empty">近 7 天暂无运行记录</div>';
  }
  const cards: Array<[string, string | number]> = [
    ["状态", run.status],
    ["频道总数", run.unique_feed_count],
    ["成功", run.succeeded_feed_count],
    ["失败", run.failed_feed_count],
    ["新增单集", run.new_episode_count],
    ["排重", run.already_exists_count],
    ["父页更新", run.parent_update_count],
    ["开始时间", formatShanghai(run.started_at)],
    ["结束时间", formatShanghai(run.finished_at)],
  ];
  return cards
    .map(
      ([label, value]) =>
        `<div class="card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`,
    )
    .join("");
}

function feedRows(feeds: PublicFeedTaskLog[]): string {
  if (feeds.length === 0) {
    return '<tr><td colspan="10" class="empty-cell">暂无 Feed 明细</td></tr>';
  }
  return feeds
    .map(
      (feed) => `<tr>
        <td>${escapeHtml(feed.podcast_name)}</td>
        <td><code>${escapeHtml(feed.feed_host)}</code></td>
        <td><span class="status ${statusClass(feed.status)}">${escapeHtml(feed.status)}</span></td>
        <td>${escapeHtml(feed.parsed_item_count)}</td>
        <td>${escapeHtml(feed.window_item_count)}</td>
        <td>${escapeHtml(feed.new_episode_count)}</td>
        <td>${escapeHtml(feed.already_exists_count)}</td>
        <td>${escapeHtml(feed.parent_update_count)}</td>
        <td>${escapeHtml(feed.error_code ?? "—")}</td>
        <td>${escapeHtml(formatDuration(feed.duration_ms))}</td>
      </tr>`,
    )
    .join("");
}

function anomalyBanner(anomalies: PublicLogAnomaly[]): string {
  if (anomalies.length === 0) {
    return "";
  }
  const items = anomalies
    .map((anomaly) => `<li>${escapeHtml(anomaly.detail)}</li>`)
    .join("");
  return `<section class="anomaly"><h2>⚠ 异常</h2><ul>${items}</ul></section>`;
}

function runSections(runs: PublicRunLog[]): string {
  if (runs.length === 0) {
    return "";
  }
  return runs
    .map(
      (run) => `<section class="run">
        <div class="run-head">
          <div><h2>${escapeHtml(formatShanghai(run.started_at))}</h2><p>${escapeHtml(triggerLabel(run.cron))}</p></div>
          <span class="status ${statusClass(run.status)}">${escapeHtml(run.status)}</span>
        </div>
        <div class="run-summary">
          <span>频道 ${escapeHtml(run.unique_feed_count)}</span>
          <span>成功 ${escapeHtml(run.succeeded_feed_count)}</span>
          <span>失败 ${escapeHtml(run.failed_feed_count)}</span>
          <span>新增 ${escapeHtml(run.new_episode_count)}</span>
          <span>排重 ${escapeHtml(run.already_exists_count)}</span>
          <span>父页更新 ${escapeHtml(run.parent_update_count)}</span>
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th>播客名</th><th>Feed 主机</th><th>状态</th><th>解析</th><th>26h 窗口</th><th>新增</th><th>排重</th><th>父页更新</th><th>错误码</th><th>耗时</th></tr></thead>
          <tbody>${feedRows(run.feeds)}</tbody>
        </table></div>
      </section>`,
    )
    .join("");
}

export function renderLogsHtml(snapshot: PublicLogSnapshot): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>财经播客同步日志</title>
  <style>
    :root{color-scheme:light;--bg:#f4f6f8;--panel:#fff;--ink:#17202a;--muted:#68737d;--line:#dfe4e8;--good:#147d46;--bad:#bd2c2c;--warn:#9a6700}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}main{width:min(1180px,calc(100% - 24px));margin:28px auto}h1,h2,p{margin:0}header p,.run-head p,footer{color:var(--muted)}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin:18px 0 24px}.card,.run,.empty{background:var(--panel);border:1px solid var(--line);border-radius:12px}.card{padding:13px}.card span{display:block;color:var(--muted);font-size:12px}.card strong{display:block;margin-top:3px;font-size:17px;overflow-wrap:anywhere}.run{margin:14px 0;padding:16px}.run-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}.run-head h2{font-size:17px}.run-summary{display:flex;flex-wrap:wrap;gap:8px 16px;margin:12px 0;color:var(--muted)}.status{display:inline-flex;padding:2px 8px;border-radius:999px;background:#edf0f2;white-space:nowrap}.status.good{color:var(--good);background:#e7f6ed}.status.bad{color:var(--bad);background:#fdecec}.status.warn{color:var(--warn);background:#fff4d6}.table-wrap{overflow-x:auto}table{width:100%;min-width:920px;border-collapse:collapse}th,td{padding:9px 10px;border-top:1px solid var(--line);text-align:left;white-space:nowrap}th{color:var(--muted);font-size:12px}code{font-size:12px}.empty{padding:30px;text-align:center;color:var(--muted)}.empty-cell{text-align:center;color:var(--muted)}footer{text-align:center;padding:24px 0 8px}.anomaly{background:#fff4d6;border:1px solid #e5c65a;border-radius:12px;padding:14px 16px;margin:16px 0;color:var(--warn)}.anomaly h2{font-size:15px}.anomaly ul{margin:8px 0 0;padding-left:20px}@media(max-width:600px){main{margin-top:18px}.run{padding:12px}.cards{grid-template-columns:repeat(2,minmax(0,1fr))}}
  </style>
</head>
<body><main>
  <header><h1>财经播客同步日志</h1><p>时间均为 Asia/Shanghai</p></header>
  ${anomalyBanner(snapshot.anomalies)}
  <div class="cards">${summaryCards(snapshot.runs[0])}</div>
  ${runSections(snapshot.runs)}
  <footer>日志滚动保留 ${escapeHtml(snapshot.retention_days)} 天</footer>
</main></body>
</html>`;
}

// 按 D1 绑定对象缓存快照：同一 isolate 内的匿名刷新风暴最多每 60s 触发一次 D1 查询。
// 缓存的是 in-flight Promise 而非完成值，冷启动时的并发请求共享同一次查询；失败即驱逐。
const snapshotCache = new WeakMap<
  LogDatabase,
  { expiresAt: number; snapshot: Promise<PublicLogSnapshot> }
>();

function loadLogSnapshotCached(database: LogDatabase): Promise<PublicLogSnapshot> {
  const cached = snapshotCache.get(database);
  if (cached !== undefined && Date.now() < cached.expiresAt) {
    return cached.snapshot;
  }
  const entry = {
    expiresAt: Date.now() + LOG_SNAPSHOT_TTL_MS,
    snapshot: loadLogSnapshot(database),
  };
  snapshotCache.set(database, entry);
  entry.snapshot.catch(() => {
    if (snapshotCache.get(database) === entry) {
      snapshotCache.delete(database);
    }
  });
  return entry.snapshot;
}

export async function logsResponse(
  database: LogDatabase,
  format: "html" | "json",
): Promise<Response> {
  const snapshot = await loadLogSnapshotCached(database);
  if (format === "json") {
    return Response.json(snapshot, { headers: LOG_RESPONSE_HEADERS });
  }
  return new Response(renderLogsHtml(snapshot), {
    headers: {
      ...LOG_RESPONSE_HEADERS,
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}
