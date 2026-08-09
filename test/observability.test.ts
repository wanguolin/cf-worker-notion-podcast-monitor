import { describe, expect, it } from "vitest";

import worker, {
  prepareFeedTaskInsert,
  type FeedTaskMessage,
  type WorkerEnv,
} from "../src/index";
import { pruneOldRuns } from "../src/observability";

type Row = Record<string, unknown>;

function d1Result<T>(results: T[], changes = 0): D1Result<T> {
  return {
    success: true,
    results,
    meta: {
      changes,
      duration: 0,
      last_row_id: 0,
      changed_db: changes > 0,
      size_after: 0,
      rows_read: results.length,
      rows_written: changes,
    },
  };
}

function statement(options: {
  allRows?: Row[];
  onBind?: (values: unknown[]) => void;
  onRun?: () => number;
}): D1PreparedStatement {
  const prepared = {
    bind(...values: unknown[]) {
      options.onBind?.(values);
      return prepared;
    },
    async first<T = Record<string, unknown>>(): Promise<T | null> {
      return (options.allRows?.[0] as T | undefined) ?? null;
    },
    async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
      return d1Result<T>([], options.onRun?.() ?? 0);
    },
    async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
      return d1Result((options.allRows ?? []) as T[]);
    },
    async raw<T = unknown[]>(): Promise<T[]> {
      return [];
    },
  };
  return prepared as D1PreparedStatement;
}

function databaseForLogs(runs: Row[], tasks: Row[]): D1Database {
  return {
    prepare(query: string): D1PreparedStatement {
      return statement({
        allRows: query.includes("FROM feed_tasks AS task") ? tasks : runs,
      });
    },
    async batch<T = unknown>(): Promise<D1Result<T>[]> {
      return [];
    },
    async exec(): Promise<D1ExecResult> {
      return { count: 0, duration: 0 };
    },
    withSession(): never {
      throw new Error("not used by this test");
    },
    async dump(): Promise<ArrayBuffer> {
      return new ArrayBuffer(0);
    },
  };
}

function envWithDatabase(database: D1Database): WorkerEnv {
  return { DB: database } as WorkerEnv;
}

const secret = "manual-secret-must-not-leak";
const fullFeedUrl = "https://feeds.example.com/private/show.xml?account=42";
const errorSummary = `Authorization: Bearer ${secret}; failed ${fullFeedUrl}`;

const runs: Row[] = [
  {
    run_id: "manual-run:1",
    cron: "manual-trigger",
    scheduled_at: "2026-08-09T01:00:00.000Z",
    started_at: "2026-08-09T01:00:01.000Z",
    finished_at: "2026-08-09T01:00:05.000Z",
    status: "partial",
    catalog_row_count: 3,
    unique_feed_count: 2,
    succeeded_feed_count: 1,
    failed_feed_count: 1,
    new_episode_count: 4,
    parent_update_count: 2,
    error_summary: errorSummary,
  },
];

const tasks: Row[] = [
  {
    run_id: "manual-run:1",
    feed_url_hash: "0123456789abcdef",
    podcast_name: '市场<script>alert("x")</script>',
    feed_host: "feeds.example.com",
    status: "succeeded",
    started_at: "2026-08-09T01:00:01.250Z",
    finished_at: "2026-08-09T01:00:03.750Z",
    parsed_item_count: 20,
    window_item_count: 6,
    new_episode_count: 4,
    already_exists_count: 2,
    parent_update_count: 2,
    error_code: null,
    error_summary: errorSummary,
    message_body_json: JSON.stringify({ feed_url: fullFeedUrl, token: secret }),
    feed_url: fullFeedUrl,
  },
  {
    run_id: "manual-run:1",
    feed_url_hash: "deadbeef01234567",
    podcast_name: null,
    feed_host: null,
    status: "queued",
    started_at: null,
    finished_at: null,
    parsed_item_count: 0,
    window_item_count: 0,
    new_episode_count: 0,
    already_exists_count: 0,
    parent_update_count: 0,
    error_code: null,
  },
];

describe("public observability endpoints", () => {
  it("serves /logs without auth, renders counts, escapes names, and omits sensitive fields", async () => {
    const response = await worker.fetch(
      new Request("https://worker.example/logs"),
      envWithDatabase(databaseForLogs(runs, tasks)),
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex");
    expect(html).toContain("频道总数");
    expect(html).toContain("新增单集");
    expect(html).toContain(">4<");
    expect(html).toContain(">2<");
    expect(html).toContain("feeds.example.com");
    expect(html).toContain("deadbeef");
    expect(html).toContain("市场&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain(secret);
    expect(html).not.toContain("Authorization");
    expect(html).not.toContain("/private/show.xml");
    expect(html).not.toContain(errorSummary);
  });

  it("serves a redacted /logs.json structure", async () => {
    const response = await worker.fetch(
      new Request("https://worker.example/logs.json"),
      envWithDatabase(databaseForLogs(runs, tasks)),
    );
    const body = await response.json<{
      retention_days: number;
      runs: Array<{
        already_exists_count: number;
        feeds: Array<{ podcast_name: string; feed_host: string; duration_ms: number }>;
      }>;
    }>();
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex");
    expect(body.retention_days).toBe(7);
    expect(body.runs[0]?.already_exists_count).toBe(2);
    expect(body.runs[0]?.feeds[0]).toMatchObject({
      podcast_name: '市场<script>alert("x")</script>',
      feed_host: "feeds.example.com",
      duration_ms: 2_500,
    });
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("Authorization");
    expect(serialized).not.toContain("/private/show.xml");
    expect(serialized).not.toContain("error_summary");
  });

  it("renders an empty database and rejects POST", async () => {
    const database = databaseForLogs([], []);
    const empty = await worker.fetch(
      new Request("https://worker.example/logs"),
      envWithDatabase(database),
    );
    expect(empty.status).toBe(200);
    expect(await empty.text()).toContain("近 7 天暂无运行记录");

    const rejected = await worker.fetch(
      new Request("https://worker.example/logs", { method: "POST" }),
      envWithDatabase(database),
    );
    expect(rejected.status).toBe(405);
    expect(rejected.headers.get("Allow")).toBe("GET");
  });
});

describe("D1 observability bookkeeping", () => {
  it("deletes runs older than seven days and cascades only their feed tasks", async () => {
    const now = Date.now();
    const storedRuns = [
      { run_id: "old", started_at: new Date(now - 8 * 86_400_000).toISOString() },
      { run_id: "recent", started_at: new Date(now - 3 * 86_400_000).toISOString() },
    ];
    const storedTasks = [
      { task_id: "old-task", run_id: "old" },
      { task_id: "recent-task", run_id: "recent" },
    ];
    let deleteQuery = "";
    const database: D1Database = {
      prepare(query: string): D1PreparedStatement {
        deleteQuery = query;
        return statement({
          onRun: () => {
            const cutoff = Date.now() - 7 * 86_400_000;
            const deleted = new Set(
              storedRuns
                .filter((run) => Date.parse(run.started_at) < cutoff)
                .map((run) => run.run_id),
            );
            const retainedRuns = storedRuns.filter((run) => !deleted.has(run.run_id));
            const retainedTasks = storedTasks.filter((task) => !deleted.has(task.run_id));
            storedRuns.splice(0, storedRuns.length, ...retainedRuns);
            storedTasks.splice(0, storedTasks.length, ...retainedTasks);
            return deleted.size;
          },
        });
      },
      async batch<T = unknown>(): Promise<D1Result<T>[]> {
        return [];
      },
      async exec(): Promise<D1ExecResult> {
        return { count: 0, duration: 0 };
      },
      withSession(): never {
        throw new Error("not used by this test");
      },
      async dump(): Promise<ArrayBuffer> {
        return new ArrayBuffer(0);
      },
    };

    await pruneOldRuns(database);

    expect(deleteQuery).toBe("DELETE FROM runs WHERE started_at < datetime('now','-7 days')");
    expect(storedRuns.map((run) => run.run_id)).toEqual(["recent"]);
    expect(storedTasks.map((task) => task.task_id)).toEqual(["recent-task"]);
  });

  it("passes the podcast name through and binds only the feed hostname to display columns", () => {
    let query = "";
    let values: unknown[] = [];
    const database = databaseForLogs([], []);
    database.prepare = (sql: string) => {
      query = sql;
      return statement({ onBind: (bound) => (values = bound) });
    };
    const body: FeedTaskMessage = {
      schema_version: 1,
      run_id: "run",
      task_id: "task",
      feed_url: fullFeedUrl,
      feed_url_hash: "0123456789abcdef",
      podcast_name: "Podcast A / Podcast B",
      categories: [],
      language: null,
      parent_page_ids: ["parent-a", "parent-b"],
      window_start: "2026-08-08T00:00:00.000Z",
      window_end: "2026-08-09T02:00:00.000Z",
      content_fingerprint: "fingerprint",
    };

    prepareFeedTaskInsert(database, body);

    expect(query).toContain("podcast_name");
    expect(query).toContain("feed_host");
    expect(values[3]).toBe("Podcast A / Podcast B");
    expect(values[4]).toBe("feeds.example.com");
    expect(values[4]).not.toBe(fullFeedUrl);
  });
});
