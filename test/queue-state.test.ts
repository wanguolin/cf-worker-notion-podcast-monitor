import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";

import {
  CATCHUP_CRON,
  handleQueue,
  PRIMARY_CRON,
  reconcilePreviousRuns,
  shouldRunCatchup,
  type FeedTaskMessage,
  type WorkerEnv,
} from "../src/index";

const migrations = [
  "0001_initial.sql",
  "0002_feed_task_outbox.sql",
  "0003_dry_run_diff_counts.sql",
  "0004_stage4_write_counts.sql",
  "0005_feed_task_display_fields.sql",
];

function d1Result<T>(
  results: T[] = [],
  changes = 0,
  lastRowId: number | bigint = 0,
): D1Result<T> {
  return {
    success: true,
    results,
    meta: {
      changes,
      duration: 0,
      last_row_id: Number(lastRowId),
      changed_db: changes > 0,
      size_after: 0,
      rows_read: results.length,
      rows_written: changes,
    },
  };
}

function d1FromSqlite(sqlite: DatabaseSync): D1Database {
  return {
    prepare(query: string): D1PreparedStatement {
      const statement = sqlite.prepare(query);
      let values: SQLInputValue[] = [];
      const prepared = {
        bind(...bound: unknown[]) {
          values = bound as SQLInputValue[];
          return prepared;
        },
        async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
          const result = statement.run(...values);
          return d1Result<T>([], Number(result.changes), result.lastInsertRowid);
        },
        async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
          const row = statement.get(...values) as Record<string, unknown> | undefined;
          if (row === undefined) {
            return null;
          }
          return (column === undefined ? row : row[column]) as T;
        },
        async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
          return d1Result(statement.all(...values) as T[]);
        },
        async raw<T = unknown[]>(): Promise<T[]> {
          return statement.all(...values).map((row) => Object.values(row) as T);
        },
      };
      return prepared as D1PreparedStatement;
    },
    async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      sqlite.exec("BEGIN");
      try {
        const results: D1Result<T>[] = [];
        for (const statement of statements) {
          results.push(await statement.run<T>());
        }
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    async exec(query: string): Promise<D1ExecResult> {
      sqlite.exec(query);
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

function migratedDatabase(): { database: D1Database; sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(":memory:");
  for (const migration of migrations) {
    sqlite.exec(
      readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"),
    );
  }
  return { database: d1FromSqlite(sqlite), sqlite };
}

function feedTaskMessage(runId: string, taskId: string): FeedTaskMessage {
  return {
    schema_version: 1,
    run_id: runId,
    task_id: taskId,
    feed_url: "https://feeds.example.com/show.xml",
    feed_url_hash: "0123456789abcdef",
    podcast_name: "Podcast",
    categories: [],
    language: null,
    parent_page_ids: ["parent"],
    window_start: "2026-08-08T04:00:00.000Z",
    window_end: "2026-08-09T06:00:00.000Z",
    content_fingerprint: "fingerprint",
  };
}

describe("Queue and run terminal-state recovery", () => {
  it("skips the watchdog without creating a run when the primary tick exists", async () => {
    const { database, sqlite } = migratedDatabase();
    sqlite
      .prepare(
        `INSERT INTO runs (
          run_id, cron, scheduled_at, started_at, status, heartbeat_at
        ) VALUES (?, ?, ?, ?, 'succeeded', ?)`,
      )
      .run(
        "primary-run",
        PRIMARY_CRON,
        "2026-08-09T16:00:02.000Z",
        "2026-08-09T16:00:03.000Z",
        "2026-08-09T16:01:00.000Z",
      );

    await expect(
      shouldRunCatchup(database, Date.parse("2026-08-09T16:30:07.000Z")),
    ).resolves.toBe(false);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM runs").get()).toEqual({ count: 1 });
    expect(
      sqlite.prepare("SELECT COUNT(*) AS count FROM runs WHERE cron = ?").get(CATCHUP_CRON),
    ).toEqual({ count: 0 });
    sqlite.close();
  });

  it("requests the watchdog producer when the guarded primary tick is absent", async () => {
    const { database, sqlite } = migratedDatabase();

    await expect(
      shouldRunCatchup(database, Date.parse("2026-08-09T16:30:07.000Z")),
    ).resolves.toBe(true);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM runs").get()).toEqual({ count: 0 });
    sqlite.close();
  });

  it("dead-letters a non-terminal task, finalizes its run, and always acknowledges the DLQ message", async () => {
    const { database, sqlite } = migratedDatabase();
    sqlite
      .prepare(
        `INSERT INTO runs (
          run_id, cron, scheduled_at, started_at, status, unique_feed_count,
          succeeded_feed_count, new_episode_count, heartbeat_at
        ) VALUES (?, 'manual-trigger', ?, ?, 'running', 2, 1, 1, ?)`,
      )
      .run(
        "run",
        "2026-08-09T06:00:00.000Z",
        "2026-08-09T06:00:00.000Z",
        "2026-08-09T06:10:00.000Z",
      );
    sqlite
      .prepare(
        `INSERT INTO feed_tasks (
          task_id, run_id, feed_url_hash, status, notion_write_count,
          parent_update_count, error_code, error_summary
        ) VALUES (?, 'run', ?, 'retrying', 2, 1, 'notion_request_failed', 'notion_request_failed')`,
      )
      .run("dead", "0123456789abcdef");

    const ack = vi.fn();
    const retry = vi.fn();
    const message = {
      id: "message",
      timestamp: new Date("2026-08-09T06:30:00.000Z"),
      body: feedTaskMessage("run", "dead"),
      attempts: 6,
      ack,
      retry,
    } as Message<FeedTaskMessage>;
    const batch = {
      queue: "podcast-monitor-dlq-finance-production",
      messages: [message],
      metadata: { metrics: { backlogCount: 1, backlogBytes: 1 } },
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    } as MessageBatch<FeedTaskMessage>;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await handleQueue(batch, {
        DB: database,
        FEED_TASKS_DLQ_NAME: "podcast-monitor-dlq-finance-production",
      } as WorkerEnv);
    } finally {
      consoleError.mockRestore();
    }

    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(
      sqlite.prepare("SELECT status, error_code FROM feed_tasks WHERE task_id = 'dead'").get(),
    ).toMatchObject({ status: "dead_lettered", error_code: "notion_request_failed" });
    expect(sqlite.prepare("SELECT * FROM runs WHERE run_id = 'run'").get()).toMatchObject({
      status: "partial",
      succeeded_feed_count: 1,
      failed_feed_count: 1,
      new_episode_count: 3,
      parent_update_count: 1,
      error_summary: "queue_retries_exhausted",
    });
    expect(
      sqlite.prepare("SELECT finished_at FROM runs WHERE run_id = 'run'").get(),
    ).toMatchObject({ finished_at: expect.any(String) });
    sqlite.close();
  });

  it("fails stale previous work without letting it block the new run", async () => {
    const { database, sqlite } = migratedDatabase();
    const insertRun = sqlite.prepare(
      `INSERT INTO runs (
        run_id, cron, scheduled_at, started_at, status, unique_feed_count,
        heartbeat_at
      ) VALUES (?, 'manual-trigger', ?, ?, ?, ?, ?)`,
    );
    insertRun.run(
      "old",
      "2026-08-09T03:00:00.000Z",
      "2026-08-09T03:00:00.000Z",
      "running",
      1,
      "2026-08-09T03:30:00.000Z",
    );
    insertRun.run(
      "current",
      "2026-08-09T06:00:00.000Z",
      "2026-08-09T06:00:00.000Z",
      "creating",
      0,
      "2026-08-09T06:00:00.000Z",
    );
    sqlite
      .prepare(
        `INSERT INTO feed_tasks (
          task_id, run_id, feed_url_hash, status, notion_write_count,
          error_code, error_summary
        ) VALUES ('old-task', 'old', ?, 'retrying', 1, 'feed_total_timeout', 'feed_total_timeout')`,
      )
      .run("0123456789abcdef");

    const result = await reconcilePreviousRuns({
      database,
      currentRunId: "current",
      previousRunWindowStart: "2026-08-08T06:00:00.000Z",
      scheduledAt: "2026-08-09T06:00:00.000Z",
      checkedAt: "2026-08-09T06:00:00.000Z",
    });

    expect(result).toEqual({ staleRunCount: 1, skipped: false });
    expect(
      sqlite
        .prepare("SELECT status, error_code FROM feed_tasks WHERE task_id = 'old-task'")
        .get(),
    ).toMatchObject({ status: "failed", error_code: "feed_total_timeout" });
    expect(sqlite.prepare("SELECT * FROM runs WHERE run_id = 'old'").get()).toMatchObject({
      status: "failed",
      failed_feed_count: 1,
      new_episode_count: 1,
      error_summary: "stale_run_timeout",
    });
    expect(
      sqlite.prepare("SELECT status, finished_at FROM runs WHERE run_id = 'current'").get(),
    ).toEqual({ status: "creating", finished_at: null });
    sqlite.close();
  });
});
