import { CatalogPipelineError, loadPodcastCatalog } from "./catalog";
import { sha256Hex } from "./rss/dedup";
import { FeedPipelineError } from "./rss/errors";
import { fetchAndParseFeed } from "./rss/fetch";
import { normalizeAndValidateFeedUrl } from "./rss/url";

const NOTION_API_BASE = "https://api.notion.com";
const NOTION_VERSION = "2026-03-11";
const NOTION_REQUEST_GAP_MS = 350;
const NOTION_REQUEST_TIMEOUT_MS = 10_000;
const FEED_TASK_SCHEMA_VERSION = 1;
const PROCESSING_LEASE_MS = 15 * 60 * 1_000;
const QUEUE_RETRY_BASE_SECONDS = 60;
const QUEUE_RETRY_MAX_SECONDS = 24 * 60 * 60;
const PREVIOUS_RUN_WINDOW_MS = 24 * 60 * 60 * 1_000;
const PRODUCER_LOCK_LEASE_MS = 5 * 60 * 1_000;
const PRODUCER_LOCK_NAME = "catalog_outbox_producer";
const QUEUE_SEND_BATCH_SIZE = 100;
const QUEUE_MESSAGE_SAFE_BYTES = 120_000;
const QUEUE_SEND_BATCH_SAFE_BYTES = 240_000;

type Secrets = {
  readonly NOTION_TOKEN?: string;
  readonly MANUAL_TRIGGER_TOKEN?: string;
};

type WorkerEnv = Cloudflare.FinanceProductionEnv & Secrets;

export type FeedTaskMessage = {
  schema_version: typeof FEED_TASK_SCHEMA_VERSION;
  run_id: string;
  task_id: string;
  feed_url: string;
  feed_url_hash: string;
  podcast_name: string;
  categories: string[];
  language: string | null;
  parent_page_ids: string[];
  window_start: string;
  window_end: string;
  content_fingerprint: string;
};

type StatusRow = {
  status: string;
};

type OutboxRow = {
  message_body_json: string | null;
  status: string;
  task_id: string;
};

type StructuredLog = {
  level: "info" | "warn" | "error";
  event: string;
  error_code?: string;
  run_id?: string;
  task_id?: string;
  status?: string;
  attempts?: number;
  catalog_row_count?: number;
  unique_feed_count?: number;
  downloaded_bytes?: number;
  parsed_item_count?: number;
  window_item_count?: number;
  redirect_count?: number;
  retry_delay_seconds?: number;
  issue_count?: number;
};

type JsonRecord = Record<string, unknown>;

type StepResult = {
  step: string;
  ok: boolean;
  status: number;
  summary: string;
};

type NotionResult = {
  ok: boolean;
  status: number;
  data: unknown;
  errorSummary?: string;
};

function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

async function readBoundedJson(request: Request, maxBytes: number): Promise<unknown> {
  if (request.body === null) {
    return null;
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("request_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isFeedTaskMessage(value: unknown): value is FeedTaskMessage {
  return (
    isRecord(value) &&
    value.schema_version === FEED_TASK_SCHEMA_VERSION &&
    typeof value.run_id === "string" &&
    typeof value.task_id === "string" &&
    typeof value.feed_url === "string" &&
    typeof value.feed_url_hash === "string" &&
    typeof value.podcast_name === "string" &&
    isStringArray(value.categories) &&
    (typeof value.language === "string" || value.language === null) &&
    isStringArray(value.parent_page_ids) &&
    typeof value.window_start === "string" &&
    typeof value.window_end === "string" &&
    typeof value.content_fingerprint === "string"
  );
}

function isTerminalTaskStatus(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "dead_lettered";
}

function writeLog(entry: StructuredLog): void {
  const line = JSON.stringify(entry);

  if (entry.level === "error") {
    console.error(line);
    return;
  }

  if (entry.level === "warn") {
    console.warn(line);
    return;
  }

  console.log(line);
}

function stableRunId(controller: ScheduledController): string {
  return `cron:${controller.cron}:scheduled:${controller.scheduledTime}`;
}

export function queueRetryDelaySeconds(attempts: number): number {
  const exponent = Math.max(0, Math.min(attempts - 1, 20));
  return Math.min(QUEUE_RETRY_BASE_SECONDS * 2 ** exponent, QUEUE_RETRY_MAX_SECONDS);
}

function taskIdFor(runId: string, feedUrlHash: string): string {
  return `${runId}:feed:${feedUrlHash}`;
}

function parseOutboxMessage(row: OutboxRow): FeedTaskMessage {
  if (row.message_body_json === null) {
    throw new Error("outbox_message_missing");
  }

  let body: unknown;
  try {
    body = JSON.parse(row.message_body_json);
  } catch {
    throw new Error("outbox_message_invalid");
  }
  if (!isFeedTaskMessage(body) || body.task_id !== row.task_id) {
    throw new Error("outbox_message_invalid");
  }
  return body;
}

async function acquireProducerLock(runId: string, env: WorkerEnv): Promise<boolean> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + PRODUCER_LOCK_LEASE_MS);
  const result = await env.DB.prepare(
    `INSERT INTO producer_locks (lock_name, owner_run_id, acquired_at, expires_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(lock_name) DO UPDATE SET
      owner_run_id = excluded.owner_run_id,
      acquired_at = excluded.acquired_at,
      expires_at = excluded.expires_at
    WHERE producer_locks.expires_at <= excluded.acquired_at`,
  )
    .bind(PRODUCER_LOCK_NAME, runId, now.toISOString(), expiresAt.toISOString())
    .run();
  return result.meta.changes > 0;
}

async function releaseProducerLock(runId: string, env: WorkerEnv): Promise<void> {
  await env.DB.prepare(
    `DELETE FROM producer_locks
    WHERE lock_name = ?
      AND owner_run_id = ?`,
  )
    .bind(PRODUCER_LOCK_NAME, runId)
    .run();
}

async function getRunStatus(runId: string, env: WorkerEnv): Promise<string | null> {
  const row = await env.DB.prepare("SELECT status FROM runs WHERE run_id = ?")
    .bind(runId)
    .first<StatusRow>();
  return row?.status ?? null;
}

async function getRunOutbox(runId: string, env: WorkerEnv): Promise<OutboxRow[]> {
  const result = await env.DB.prepare(
    `SELECT task_id, status, message_body_json
    FROM feed_tasks
    WHERE run_id = ?
    ORDER BY task_id`,
  )
    .bind(runId)
    .all<OutboxRow>();
  return result.results;
}

function queueMessageBatches(rows: OutboxRow[]): FeedTaskMessage[][] {
  const batches: FeedTaskMessage[][] = [];
  let batch: FeedTaskMessage[] = [];
  let batchBytes = 0;

  for (const row of rows) {
    const body = parseOutboxMessage(row);
    const messageBytes = new TextEncoder().encode(row.message_body_json ?? "").byteLength;
    if (messageBytes > QUEUE_MESSAGE_SAFE_BYTES) {
      throw new Error("queue_message_too_large");
    }
    if (
      batch.length >= QUEUE_SEND_BATCH_SIZE ||
      (batch.length > 0 && batchBytes + messageBytes > QUEUE_SEND_BATCH_SAFE_BYTES)
    ) {
      batches.push(batch);
      batch = [];
      batchBytes = 0;
    }
    batch.push(body);
    batchBytes += messageBytes;
  }
  if (batch.length > 0) {
    batches.push(batch);
  }
  return batches;
}

function getProperties(value: unknown): JsonRecord | null {
  if (!isRecord(value) || !isRecord(value.properties)) {
    return null;
  }

  return value.properties;
}

function getTitlePropertyName(properties: JsonRecord): string | null {
  for (const [name, property] of Object.entries(properties)) {
    if (isRecord(property) && property.type === "title") {
      return name;
    }
  }

  return null;
}

function getResultCount(value: unknown): number | null {
  if (!isRecord(value) || !Array.isArray(value.results)) {
    return null;
  }

  return value.results.length;
}

function getPageId(value: unknown): string | null {
  if (!isRecord(value) || value.object !== "page" || typeof value.id !== "string") {
    return null;
  }

  return value.id;
}

function isTrashedPage(value: unknown): boolean {
  return isRecord(value) && value.object === "page" && value.in_trash === true;
}

function notionErrorSummary(status: number, data: unknown): string {
  let summary = `Notion API returned HTTP ${status}`;

  if (!isRecord(data) || data.object !== "error") {
    return summary;
  }

  if (typeof data.code === "string") {
    summary += ` (code: ${data.code})`;
  }

  if (typeof data.message === "string") {
    summary += `: ${data.message.replace(/[\r\n]+/g, " ").slice(0, 120)}`;
  }

  return summary;
}

async function constantTimeEqual(provided: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const providedBytes = new Uint8Array(providedHash);
  const expectedBytes = new Uint8Array(expectedHash);
  let difference = 0;

  for (let index = 0; index < providedBytes.length; index += 1) {
    difference |= providedBytes[index]! ^ expectedBytes[index]!;
  }

  return difference === 0;
}

async function isAuthorized(request: Request, expectedToken: string): Promise<boolean> {
  const authorization = request.headers.get("Authorization");
  const providedToken = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";

  return constantTimeEqual(providedToken, expectedToken);
}

function createNotionRequester(token: string) {
  let requestCount = 0;

  return async (path: string, init: RequestInit = {}): Promise<NotionResult> => {
    if (requestCount > 0) {
      await sleep(NOTION_REQUEST_GAP_MS);
    }
    requestCount += 1;

    try {
      const response = await fetch(`${NOTION_API_BASE}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json",
          ...init.headers,
        },
        signal: AbortSignal.timeout(NOTION_REQUEST_TIMEOUT_MS),
      });
      const data: unknown = await response.json().catch(() => null);

      return {
        ok: response.ok,
        status: response.status,
        data,
        ...(response.ok
          ? {}
          : { errorSummary: notionErrorSummary(response.status, data) }),
      };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        data: null,
        errorSummary:
          error instanceof DOMException && error.name === "TimeoutError"
            ? "Notion API request timed out"
            : "Notion API request failed before receiving a response",
      };
    }
  };
}

function failedCallStep(step: string, result: NotionResult): StepResult {
  return {
    step,
    ok: false,
    status: result.status,
    summary: result.errorSummary ?? "Notion API response was invalid",
  };
}

function selftestResponse(env: WorkerEnv, steps: StepResult[], status: number): Response {
  return json(
    {
      ok: steps.every((step) => step.ok),
      env: env.ENV_NAME,
      steps,
    },
    status,
  );
}

async function runSelftest(env: WorkerEnv, notionToken: string): Promise<Response> {
  const steps: StepResult[] = [];
  const notionRequest = createNotionRequester(notionToken);

  const identity = await notionRequest("/v1/users/me");
  if (!identity.ok) {
    steps.push(failedCallStep("authenticate", identity));
    return selftestResponse(env, steps, 502);
  }
  if (!isRecord(identity.data) || identity.data.object !== "user") {
    steps.push({
      step: "authenticate",
      ok: false,
      status: identity.status,
      summary: "Notion identity response did not contain a user",
    });
    return selftestResponse(env, steps, 502);
  }
  steps.push({
    step: "authenticate",
    ok: true,
    status: identity.status,
    summary: "Notion identity verified",
  });

  const monitorSchema = await notionRequest(
    `/v1/data_sources/${encodeURIComponent(env.NOTION_MONITOR_DS_ID)}`,
  );
  if (!monitorSchema.ok) {
    steps.push(failedCallStep("retrieve_monitor_schema", monitorSchema));
    return selftestResponse(env, steps, 502);
  }
  const monitorProperties = getProperties(monitorSchema.data);
  if (monitorProperties === null) {
    steps.push({
      step: "retrieve_monitor_schema",
      ok: false,
      status: monitorSchema.status,
      summary: "Monitor data source response did not contain a property schema",
    });
    return selftestResponse(env, steps, 502);
  }
  steps.push({
    step: "retrieve_monitor_schema",
    ok: true,
    status: monitorSchema.status,
    summary: `Monitor schema contains ${Object.keys(monitorProperties).length} properties`,
  });

  const monitorQuery = await notionRequest(
    `/v1/data_sources/${encodeURIComponent(env.NOTION_MONITOR_DS_ID)}/query`,
    { method: "POST", body: JSON.stringify({ page_size: 1 }) },
  );
  if (!monitorQuery.ok) {
    steps.push(failedCallStep("query_monitor", monitorQuery));
    return selftestResponse(env, steps, 502);
  }
  const monitorResultCount = getResultCount(monitorQuery.data);
  if (monitorResultCount === null) {
    steps.push({
      step: "query_monitor",
      ok: false,
      status: monitorQuery.status,
      summary: "Monitor query response did not contain a results array",
    });
    return selftestResponse(env, steps, 502);
  }
  steps.push({
    step: "query_monitor",
    ok: true,
    status: monitorQuery.status,
    summary: `Monitor query returned ${monitorResultCount} result(s)`,
  });

  const episodeSchema = await notionRequest(
    `/v1/data_sources/${encodeURIComponent(env.NOTION_EPISODE_DS_ID)}`,
  );
  if (!episodeSchema.ok) {
    steps.push(failedCallStep("retrieve_episode_schema", episodeSchema));
    return selftestResponse(env, steps, 502);
  }
  const episodeProperties = getProperties(episodeSchema.data);
  const titlePropertyName =
    episodeProperties === null ? null : getTitlePropertyName(episodeProperties);
  if (episodeProperties === null || titlePropertyName === null) {
    steps.push({
      step: "retrieve_episode_schema",
      ok: false,
      status: episodeSchema.status,
      summary: "Episode data source schema did not contain a title property",
    });
    return selftestResponse(env, steps, 502);
  }
  steps.push({
    step: "retrieve_episode_schema",
    ok: true,
    status: episodeSchema.status,
    summary: `Episode schema contains ${Object.keys(episodeProperties).length} properties and a title property`,
  });

  const episodeQuery = await notionRequest(
    `/v1/data_sources/${encodeURIComponent(env.NOTION_EPISODE_DS_ID)}/query`,
    { method: "POST", body: JSON.stringify({ page_size: 1 }) },
  );
  if (!episodeQuery.ok) {
    steps.push(failedCallStep("query_episode", episodeQuery));
    return selftestResponse(env, steps, 502);
  }
  const episodeResultCount = getResultCount(episodeQuery.data);
  if (episodeResultCount === null) {
    steps.push({
      step: "query_episode",
      ok: false,
      status: episodeQuery.status,
      summary: "Episode query response did not contain a results array",
    });
    return selftestResponse(env, steps, 502);
  }
  steps.push({
    step: "query_episode",
    ok: true,
    status: episodeQuery.status,
    summary: `Episode query returned ${episodeResultCount} result(s)`,
  });

  const testPageTitle = `[连通性测试] ${new Date().toISOString()}`;
  const createPage = await notionRequest("/v1/pages", {
    method: "POST",
    body: JSON.stringify({
      parent: {
        type: "data_source_id",
        data_source_id: env.NOTION_EPISODE_DS_ID,
      },
      properties: {
        [titlePropertyName]: {
          title: [
            {
              type: "text",
              text: { content: testPageTitle },
            },
          ],
        },
      },
    }),
  });
  if (!createPage.ok) {
    steps.push(failedCallStep("create_test_page", createPage));
    return selftestResponse(env, steps, 502);
  }
  const testPageId = getPageId(createPage.data);
  if (testPageId === null) {
    steps.push({
      step: "create_test_page",
      ok: false,
      status: createPage.status,
      summary: "Create-page response did not contain a page ID",
    });
    return selftestResponse(env, steps, 502);
  }
  steps.push({
    step: "create_test_page",
    ok: true,
    status: createPage.status,
    summary: "Connectivity test page created",
  });

  const trashPage = await notionRequest(`/v1/pages/${encodeURIComponent(testPageId)}`, {
    method: "PATCH",
    body: JSON.stringify({ in_trash: true }),
  });
  if (!trashPage.ok) {
    steps.push(failedCallStep("trash_test_page", trashPage));
    return selftestResponse(env, steps, 502);
  }
  if (!isTrashedPage(trashPage.data)) {
    steps.push({
      step: "trash_test_page",
      ok: false,
      status: trashPage.status,
      summary: "Update-page response did not confirm that the page is in trash",
    });
    return selftestResponse(env, steps, 502);
  }
  steps.push({
    step: "trash_test_page",
    ok: true,
    status: trashPage.status,
    summary: "Connectivity test page moved to trash",
  });

  return selftestResponse(env, steps, 200);
}

async function handleScheduled(controller: ScheduledController, env: WorkerEnv): Promise<void> {
  const runId = stableRunId(controller);
  const scheduledAt = new Date(controller.scheduledTime).toISOString();
  const previousRunWindowStart = new Date(
    controller.scheduledTime - PREVIOUS_RUN_WINDOW_MS,
  ).toISOString();
  const startedAt = new Date().toISOString();

  try {
    const insert = await env.DB.prepare(
      `INSERT INTO runs (
        run_id,
        cron,
        scheduled_at,
        started_at,
        status,
        heartbeat_at
      ) VALUES (?, ?, ?, ?, 'creating', ?)
      ON CONFLICT(run_id) DO NOTHING`,
    )
      .bind(runId, controller.cron, scheduledAt, startedAt, startedAt)
      .run();

    if (insert.meta.changes === 0) {
      writeLog({
        level: "info",
        event: "scheduled_run_already_exists",
        error_code: "duplicate_run",
        run_id: runId,
      });
    }

    const initialStatus = await getRunStatus(runId, env);
    if (initialStatus !== "creating") {
      writeLog({
        level: "info",
        event: "scheduled_run_terminal",
        run_id: runId,
        ...(initialStatus === null ? {} : { status: initialStatus }),
      });
      return;
    }

    const checkedAt = new Date().toISOString();
    const skipped = await env.DB.prepare(
      `UPDATE runs
      SET status = 'skipped_previous_run_active',
          finished_at = ?,
          heartbeat_at = ?,
          error_summary = 'previous_run_active'
      WHERE run_id = ?
        AND status = 'creating'
        AND EXISTS (
          SELECT 1
          FROM runs AS previous
          WHERE previous.run_id <> ?
            AND previous.scheduled_at >= ?
            AND previous.scheduled_at < ?
            AND previous.status IN ('creating', 'queued', 'running')
        )`,
    )
      .bind(checkedAt, checkedAt, runId, runId, previousRunWindowStart, scheduledAt)
      .run();

    if (skipped.meta.changes > 0) {
      writeLog({
        level: "error",
        event: "scheduled_run_skipped",
        error_code: "previous_run_active",
        run_id: runId,
        status: "skipped_previous_run_active",
      });
      return;
    }

    if (!(await acquireProducerLock(runId, env))) {
      writeLog({
        level: "warn",
        event: "scheduled_producer_lock_busy",
        error_code: "producer_lock_busy",
        run_id: runId,
      });
      throw new Error("producer_lock_busy");
    }

    try {
      let outbox = await getRunOutbox(runId, env);
      if (outbox.length === 0) {
        if (!env.NOTION_TOKEN) {
          throw new Error("catalog_notion_token_missing");
        }

        const catalog = await loadPodcastCatalog(env.NOTION_TOKEN, env.NOTION_MONITOR_DS_ID);
        for (const [errorCode, issueCount] of Object.entries(catalog.issue_counts)) {
          if (issueCount !== undefined && issueCount > 0) {
            writeLog({
              level: "warn",
              event: "catalog_rows_skipped",
              error_code: errorCode,
              run_id: runId,
              issue_count: issueCount,
            });
          }
        }

        if (catalog.feeds.length === 0) {
          const finishedAt = new Date().toISOString();
          await env.DB.prepare(
            `UPDATE runs
            SET status = 'succeeded',
                catalog_row_count = ?,
                unique_feed_count = 0,
                finished_at = ?,
                heartbeat_at = ?,
                error_summary = NULL
            WHERE run_id = ?
              AND status = 'creating'`,
          )
            .bind(catalog.catalog_row_count, finishedAt, finishedAt, runId)
            .run();
          writeLog({
            level: "info",
            event: "scheduled_empty_run_succeeded",
            run_id: runId,
            status: "succeeded",
            catalog_row_count: catalog.catalog_row_count,
            unique_feed_count: 0,
          });
          return;
        }

        const windowStart = new Date(
          controller.scheduledTime - env.RSS_WINDOW_HOURS * 60 * 60 * 1_000,
        ).toISOString();
        const messages = catalog.feeds.map<FeedTaskMessage>((feed) => ({
          schema_version: FEED_TASK_SCHEMA_VERSION,
          run_id: runId,
          task_id: taskIdFor(runId, feed.feed_url_hash),
          feed_url: feed.feed_url,
          feed_url_hash: feed.feed_url_hash,
          podcast_name: feed.podcast_name,
          categories: feed.categories,
          language: feed.language,
          parent_page_ids: feed.parent_page_ids,
          window_start: windowStart,
          window_end: scheduledAt,
          content_fingerprint: feed.content_fingerprint,
        }));
        const now = new Date().toISOString();
        await env.DB.batch([
          ...messages.map((body) =>
            env.DB.prepare(
              `INSERT INTO feed_tasks (
                task_id,
                run_id,
                feed_url_hash,
                status,
                message_body_json
              ) VALUES (?, ?, ?, 'pending_enqueue', ?)
              ON CONFLICT(run_id, feed_url_hash) DO NOTHING`,
            ).bind(body.task_id, runId, body.feed_url_hash, JSON.stringify(body)),
          ),
          env.DB.prepare(
            `UPDATE runs
            SET catalog_row_count = ?,
                unique_feed_count = ?,
                heartbeat_at = ?,
                error_summary = NULL
            WHERE run_id = ?
              AND status = 'creating'`,
          ).bind(catalog.catalog_row_count, messages.length, now, runId),
        ]);
        outbox = await getRunOutbox(runId, env);
      }

      const pendingRows = outbox.filter((row) => row.status === "pending_enqueue");
      for (const messages of queueMessageBatches(pendingRows)) {
        await env.FEED_TASKS_QUEUE.sendBatch(
          messages.map((body) => ({ body, contentType: "json" as const })),
        );
        const queuedAt = new Date().toISOString();
        await env.DB.batch(
          messages.map((body) =>
            env.DB.prepare(
              `UPDATE feed_tasks
              SET status = 'queued',
                  queued_at = ?,
                  error_code = NULL,
                  error_summary = NULL
              WHERE task_id = ?
                AND run_id = ?
                AND status = 'pending_enqueue'`,
            ).bind(queuedAt, body.task_id, runId),
          ),
        );
      }

      const queuedAt = new Date().toISOString();
      await env.DB.prepare(
        `UPDATE runs
        SET status = 'queued',
            heartbeat_at = ?,
            error_summary = NULL
        WHERE run_id = ?
          AND status = 'creating'
          AND EXISTS (SELECT 1 FROM feed_tasks WHERE run_id = ?)
          AND NOT EXISTS (
            SELECT 1
            FROM feed_tasks
            WHERE run_id = ?
              AND status = 'pending_enqueue'
          )`,
      )
        .bind(queuedAt, runId, runId, runId)
        .run();

      writeLog({
        level: "info",
        event: "scheduled_outbox_queued",
        run_id: runId,
        status: "queued",
        unique_feed_count: outbox.length,
      });
    } catch (error) {
      const errorCode =
        error instanceof CatalogPipelineError
          ? error.code
          : error instanceof Error && /^[a-z0-9_]+$/.test(error.message)
            ? error.message
            : "scheduled_producer_error";
      const failedAt = new Date().toISOString();
      await env.DB.prepare(
        `UPDATE runs
        SET heartbeat_at = ?,
            error_summary = ?
        WHERE run_id = ?
          AND status = 'creating'`,
      )
        .bind(failedAt, errorCode, runId)
        .run()
        .catch(() => undefined);
      writeLog({
        level: "error",
        event: "scheduled_run_failed",
        error_code: errorCode,
        run_id: runId,
        status: "creating",
      });
      throw new Error(errorCode);
    } finally {
      await releaseProducerLock(runId, env).catch(() => {
        writeLog({
          level: "error",
          event: "scheduled_producer_lock_release_failed",
          error_code: "producer_lock_release_failed",
          run_id: runId,
        });
      });
    }
  } catch (error) {
    if (error instanceof Error && /^[a-z0-9_]+$/.test(error.message)) {
      throw error;
    }
    writeLog({
      level: "error",
      event: "scheduled_run_failed",
      error_code: "scheduled_d1_error",
      run_id: runId,
    });
    throw new Error("scheduled_d1_error");
  }
}

async function markRunProcessing(runId: string, env: WorkerEnv): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE runs
    SET status = 'running',
        heartbeat_at = ?
    WHERE run_id = ?
      AND status IN ('creating', 'queued')`,
  )
    .bind(now, runId)
    .run();
}

async function markTaskRetrying(
  body: FeedTaskMessage,
  error: FeedPipelineError,
  env: WorkerEnv,
): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE feed_tasks
      SET status = 'retrying',
          finished_at = NULL,
          http_status = COALESCE(?, http_status),
          error_code = ?,
          error_summary = ?
      WHERE task_id = ?
        AND run_id = ?
        AND status = 'processing'`,
    ).bind(error.httpStatus, error.code, error.code, body.task_id, body.run_id),
    env.DB.prepare(
      `UPDATE runs
      SET status = 'running',
          heartbeat_at = ?,
          error_summary = ?
      WHERE run_id = ?
        AND status IN ('creating', 'queued', 'running')`,
    ).bind(now, error.code, body.run_id),
  ]);
}

async function finalizeTaskSucceeded(
  body: FeedTaskMessage,
  result: Awaited<ReturnType<typeof fetchAndParseFeed>>,
  env: WorkerEnv,
): Promise<boolean> {
  const finishedAt = new Date().toISOString();
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE feed_tasks
      SET status = 'succeeded',
          finished_at = ?,
          http_status = ?,
          downloaded_bytes = ?,
          parsed_item_count = ?,
          window_item_count = ?,
          new_episode_count = 0,
          notion_write_count = 0,
          parent_update_count = 0,
          error_code = NULL,
          error_summary = NULL
      WHERE task_id = ?
        AND run_id = ?
        AND status = 'processing'`,
    ).bind(
      finishedAt,
      result.http_status,
      result.downloaded_bytes,
      result.parsed_item_count,
      result.window_item_count,
      body.task_id,
      body.run_id,
    ),
    env.DB.prepare(
      `UPDATE runs
      SET succeeded_feed_count = succeeded_feed_count + 1,
          status = CASE
            WHEN succeeded_feed_count + failed_feed_count + 1 >= unique_feed_count
              THEN CASE WHEN failed_feed_count = 0 THEN 'succeeded' ELSE 'partial' END
            ELSE 'running'
          END,
          finished_at = CASE
            WHEN succeeded_feed_count + failed_feed_count + 1 >= unique_feed_count
              THEN ?
            ELSE finished_at
          END,
          heartbeat_at = ?,
          error_summary = CASE
            WHEN succeeded_feed_count + failed_feed_count + 1 >= unique_feed_count
              AND failed_feed_count = 0
              THEN NULL
            ELSE error_summary
          END
      WHERE run_id = ?
        AND EXISTS (
          SELECT 1
          FROM feed_tasks
          WHERE task_id = ?
            AND run_id = ?
            AND status = 'succeeded'
            AND finished_at = ?
        )`,
    ).bind(finishedAt, finishedAt, body.run_id, body.task_id, body.run_id, finishedAt),
  ]);
  return (results[0]?.meta.changes ?? 0) > 0;
}

async function finalizeTaskFailed(
  body: FeedTaskMessage,
  error: FeedPipelineError,
  env: WorkerEnv,
): Promise<boolean> {
  const finishedAt = new Date().toISOString();
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE feed_tasks
      SET status = 'failed',
          finished_at = ?,
          http_status = COALESCE(?, http_status),
          error_code = ?,
          error_summary = ?
      WHERE task_id = ?
        AND run_id = ?
        AND status = 'processing'`,
    ).bind(
      finishedAt,
      error.httpStatus,
      error.code,
      error.code,
      body.task_id,
      body.run_id,
    ),
    env.DB.prepare(
      `UPDATE runs
      SET failed_feed_count = failed_feed_count + 1,
          status = CASE
            WHEN succeeded_feed_count + failed_feed_count + 1 >= unique_feed_count
              THEN CASE WHEN succeeded_feed_count = 0 THEN 'failed' ELSE 'partial' END
            ELSE 'running'
          END,
          finished_at = CASE
            WHEN succeeded_feed_count + failed_feed_count + 1 >= unique_feed_count
              THEN ?
            ELSE finished_at
          END,
          heartbeat_at = ?,
          error_summary = ?
      WHERE run_id = ?
        AND EXISTS (
          SELECT 1
          FROM feed_tasks
          WHERE task_id = ?
            AND run_id = ?
            AND status = 'failed'
            AND finished_at = ?
            AND error_code = ?
        )`,
    ).bind(
      finishedAt,
      finishedAt,
      error.code,
      body.run_id,
      body.task_id,
      body.run_id,
      finishedAt,
      error.code,
    ),
  ]);
  return (results[0]?.meta.changes ?? 0) > 0;
}

async function handleQueue(batch: MessageBatch<FeedTaskMessage>, env: WorkerEnv): Promise<void> {
  for (const message of batch.messages) {
    const body: unknown = message.body;
    const retryDelaySeconds = queueRetryDelaySeconds(message.attempts);

    if (!isFeedTaskMessage(body)) {
      writeLog({
        level: "error",
        event: "queue_message_rejected",
        error_code: "invalid_queue_message",
        attempts: message.attempts,
      });
      message.ack();
      continue;
    }

    try {
      const existing = await env.DB.prepare(
        `SELECT status
        FROM feed_tasks
        WHERE task_id = ?
          AND run_id = ?`,
      )
        .bind(body.task_id, body.run_id)
        .first<StatusRow>();

      if (existing === null) {
        writeLog({
          level: "warn",
          event: "queue_task_missing",
          error_code: "feed_task_not_found",
          run_id: body.run_id,
          task_id: body.task_id,
          attempts: message.attempts,
        });
        message.retry({ delaySeconds: retryDelaySeconds });
        continue;
      }

      if (isTerminalTaskStatus(existing.status)) {
        writeLog({
          level: "info",
          event: "queue_terminal_task_acked",
          run_id: body.run_id,
          task_id: body.task_id,
          status: existing.status,
          attempts: message.attempts,
        });
        message.ack();
        continue;
      }

      const startedAt = new Date().toISOString();
      const staleBefore = new Date(Date.now() - PROCESSING_LEASE_MS).toISOString();
      const claimed = await env.DB.prepare(
        `UPDATE feed_tasks
        SET status = 'processing',
            started_at = ?,
            finished_at = NULL,
            attempt_count = MAX(attempt_count, ?),
            error_code = NULL,
            error_summary = NULL
        WHERE task_id = ?
          AND run_id = ?
          AND (
            status IN ('pending_enqueue', 'queued', 'retrying')
            OR (
              status = 'processing'
              AND (started_at IS NULL OR started_at < ?)
            )
          )`,
      )
        .bind(startedAt, message.attempts, body.task_id, body.run_id, staleBefore)
        .run();

      if (claimed.meta.changes === 0) {
        const latest = await env.DB.prepare(
          `SELECT status
          FROM feed_tasks
          WHERE task_id = ?
            AND run_id = ?`,
        )
          .bind(body.task_id, body.run_id)
          .first<StatusRow>();

        if (latest !== null && isTerminalTaskStatus(latest.status)) {
          message.ack();
          continue;
        }

        writeLog({
          level: "warn",
          event: "queue_task_claim_deferred",
          error_code: "feed_task_not_claimed",
          run_id: body.run_id,
          task_id: body.task_id,
          ...(latest === null ? {} : { status: latest.status }),
          attempts: message.attempts,
          retry_delay_seconds: retryDelaySeconds,
        });
        message.retry({ delaySeconds: retryDelaySeconds });
        continue;
      }

      await markRunProcessing(body.run_id, env);

      try {
        if (!env.DRY_RUN) {
          throw new FeedPipelineError("stage_2_notion_writes_disabled");
        }

        const result = await fetchAndParseFeed(
          body.feed_url,
          { start: body.window_start, end: body.window_end },
          {
            maxBytes: env.RSS_MAX_BYTES,
            maxRedirects: env.RSS_MAX_REDIRECTS,
            connectTimeoutMs: env.RSS_CONNECT_TIMEOUT_MS,
            totalTimeoutMs: env.RSS_TIMEOUT_MS,
            softDeadlineAt: Date.now() + env.MESSAGE_SOFT_DEADLINE_MS,
          },
        );
        if (!(await finalizeTaskSucceeded(body, result, env))) {
          throw new Error("feed_task_not_finalized");
        }

        writeLog({
          level: "info",
          event: "queue_task_dry_run_succeeded",
          run_id: body.run_id,
          task_id: body.task_id,
          status: "succeeded",
          attempts: message.attempts,
          downloaded_bytes: result.downloaded_bytes,
          parsed_item_count: result.parsed_item_count,
          window_item_count: result.window_item_count,
          redirect_count: result.redirect_count,
        });
        message.ack();
      } catch (error) {
        if (!(error instanceof FeedPipelineError)) {
          throw error;
        }

        if (error.retryable) {
          await markTaskRetrying(body, error, env);
          writeLog({
            level: "warn",
            event: "queue_task_retrying",
            error_code: error.code,
            run_id: body.run_id,
            task_id: body.task_id,
            status: "retrying",
            attempts: message.attempts,
            retry_delay_seconds: retryDelaySeconds,
          });
          message.retry({ delaySeconds: retryDelaySeconds });
          continue;
        }

        if (!(await finalizeTaskFailed(body, error, env))) {
          throw new Error("feed_task_not_finalized");
        }
        writeLog({
          level: "error",
          event: "queue_task_failed_deterministic",
          error_code: error.code,
          run_id: body.run_id,
          task_id: body.task_id,
          status: "failed",
          attempts: message.attempts,
        });
        message.ack();
      }
    } catch {
      writeLog({
        level: "error",
        event: "queue_task_failed",
        error_code: "queue_d1_error",
        run_id: body.run_id,
        task_id: body.task_id,
        attempts: message.attempts,
        retry_delay_seconds: retryDelaySeconds,
      });
      message.retry({ delaySeconds: retryDelaySeconds });
    }
  }
}

async function runRssSelftest(request: Request, env: WorkerEnv): Promise<Response> {
  if (!env.DRY_RUN) {
    return json({ ok: false, error: "dry_run_required" }, 409);
  }

  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null && Number(contentLength) > 4_096) {
    return json({ ok: false, error: "request_too_large" }, 413);
  }

  let body: unknown;
  try {
    body = await readBoundedJson(request, 4_096);
  } catch (error) {
    if (error instanceof Error && error.message === "request_too_large") {
      return json({ ok: false, error: "request_too_large" }, 413);
    }
    return json({ ok: false, error: "invalid_request" }, 400);
  }
  if (!isRecord(body) || typeof body.feed_url !== "string") {
    return json({ ok: false, error: "invalid_request" }, 400);
  }

  if (
    typeof body.replay_run_id === "string" &&
    body.replay_run_id.startsWith("manual-rss-selftest:")
  ) {
    const rows = await getRunOutbox(body.replay_run_id, env);
    if (rows.length !== 1) {
      return json({ ok: false, error: "selftest_run_not_found" }, 404);
    }
    const replayBody = parseOutboxMessage(rows[0]!);
    await env.FEED_TASKS_QUEUE.send(replayBody, { contentType: "json" });
    writeLog({
      level: "info",
      event: "rss_selftest_replayed",
      run_id: replayBody.run_id,
      task_id: replayBody.task_id,
    });
    return json({
      ok: true,
      dry_run: true,
      replayed: true,
      run_id: replayBody.run_id,
      task_id: replayBody.task_id,
    });
  }

  if (body.enqueue === true) {
    let feedUrl: string;
    try {
      feedUrl = normalizeAndValidateFeedUrl(body.feed_url);
    } catch (error) {
      const code = error instanceof FeedPipelineError ? error.code : "invalid_feed_url";
      return json({ ok: false, error: code }, 422);
    }
    const nowMs = Date.now();
    const runId = `manual-rss-selftest:${nowMs}:${crypto.randomUUID()}`;
    const feedUrlHash = await sha256Hex(feedUrl);
    const taskId = taskIdFor(runId, feedUrlHash);
    const taskBody: FeedTaskMessage = {
      schema_version: FEED_TASK_SCHEMA_VERSION,
      run_id: runId,
      task_id: taskId,
      feed_url: feedUrl,
      feed_url_hash: feedUrlHash,
      podcast_name: "[RSS selftest]",
      categories: [],
      language: null,
      parent_page_ids: [],
      window_start: new Date(nowMs - env.RSS_WINDOW_HOURS * 60 * 60 * 1_000).toISOString(),
      window_end: new Date(nowMs).toISOString(),
      content_fingerprint: feedUrlHash,
    };
    const now = new Date(nowMs).toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO runs (
          run_id, cron, scheduled_at, started_at, status,
          catalog_row_count, unique_feed_count, heartbeat_at
        ) VALUES (?, 'manual', ?, ?, 'creating', 1, 1, ?)`,
      ).bind(runId, now, now, now),
      env.DB.prepare(
        `INSERT INTO feed_tasks (
          task_id, run_id, feed_url_hash, status, message_body_json
        ) VALUES (?, ?, ?, 'pending_enqueue', ?)`,
      ).bind(taskId, runId, feedUrlHash, JSON.stringify(taskBody)),
    ]);
    try {
      await env.FEED_TASKS_QUEUE.send(taskBody, { contentType: "json" });
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE feed_tasks
          SET status = 'queued', queued_at = ?
          WHERE task_id = ? AND run_id = ? AND status = 'pending_enqueue'`,
        ).bind(now, taskId, runId),
        env.DB.prepare(
          `UPDATE runs
          SET status = 'queued', heartbeat_at = ?
          WHERE run_id = ? AND status = 'creating'`,
        ).bind(now, runId),
      ]);
    } catch {
      writeLog({
        level: "error",
        event: "rss_selftest_enqueue_failed",
        error_code: "queue_send_failed",
        run_id: runId,
        task_id: taskId,
      });
      return json({ ok: false, error: "queue_send_failed", run_id: runId, task_id: taskId }, 503);
    }
    writeLog({
      level: "info",
      event: "rss_selftest_enqueued",
      run_id: runId,
      task_id: taskId,
      status: "queued",
    });
    return json({ ok: true, dry_run: true, enqueued: true, run_id: runId, task_id: taskId }, 202);
  }

  const windowEndMs = Date.now();
  const startedAt = performance.now();
  try {
    const result = await fetchAndParseFeed(
      body.feed_url,
      {
        start: new Date(windowEndMs - env.RSS_WINDOW_HOURS * 60 * 60 * 1_000).toISOString(),
        end: new Date(windowEndMs).toISOString(),
      },
      {
        maxBytes: env.RSS_MAX_BYTES,
        maxRedirects: env.RSS_MAX_REDIRECTS,
        connectTimeoutMs: env.RSS_CONNECT_TIMEOUT_MS,
        totalTimeoutMs: env.RSS_TIMEOUT_MS,
        softDeadlineAt: Date.now() + env.MESSAGE_SOFT_DEADLINE_MS,
      },
    );
    const durationMs = Math.round(performance.now() - startedAt);
    writeLog({
      level: "info",
      event: "rss_selftest_succeeded",
      downloaded_bytes: result.downloaded_bytes,
      parsed_item_count: result.parsed_item_count,
      window_item_count: result.window_item_count,
      redirect_count: result.redirect_count,
    });
    return json({
      ok: true,
      dry_run: true,
      duration_ms: durationMs,
      downloaded_bytes: result.downloaded_bytes,
      parsed_item_count: result.parsed_item_count,
      window_item_count: result.window_item_count,
      redirect_count: result.redirect_count,
      xml_encoding: result.xml_encoding,
    });
  } catch (error) {
    const pipelineError =
      error instanceof FeedPipelineError
        ? error
        : new FeedPipelineError("xml_malformed", { retryable: true });
    writeLog({
      level: "error",
      event: "rss_selftest_failed",
      error_code: pipelineError.code,
    });
    return json(
      { ok: false, error: pipelineError.code, retryable: pipelineError.retryable },
      pipelineError.retryable ? 503 : 422,
    );
  }
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      if (request.method !== "GET") {
        return json({ ok: false, error: "method_not_allowed" }, 405, { Allow: "GET" });
      }

      return json({ ok: true, env: env.ENV_NAME });
    }

    if (url.pathname === "/selftest") {
      if (request.method !== "POST") {
        return json({ ok: false, error: "method_not_allowed" }, 405, { Allow: "POST" });
      }

      if (!env.MANUAL_TRIGGER_TOKEN) {
        return json({ ok: false, error: "service_not_configured" }, 503);
      }

      if (!(await isAuthorized(request, env.MANUAL_TRIGGER_TOKEN))) {
        return json({ ok: false, error: "unauthorized" }, 401);
      }

      const notionToken = env.NOTION_TOKEN;
      if (!notionToken) {
        return json({ ok: false, error: "service_not_configured" }, 503);
      }

      return runSelftest(env, notionToken);
    }

    if (url.pathname === "/rss-selftest") {
      if (request.method !== "POST") {
        return json({ ok: false, error: "method_not_allowed" }, 405, { Allow: "POST" });
      }
      if (!env.MANUAL_TRIGGER_TOKEN) {
        return json({ ok: false, error: "service_not_configured" }, 503);
      }
      if (!(await isAuthorized(request, env.MANUAL_TRIGGER_TOKEN))) {
        return json({ ok: false, error: "unauthorized" }, 401);
      }
      return runRssSelftest(request, env);
    }

    return json({ ok: false, error: "not_found" }, 404);
  },
  async scheduled(controller: ScheduledController, env: WorkerEnv): Promise<void> {
    await handleScheduled(controller, env);
  },
  async queue(batch: MessageBatch<FeedTaskMessage>, env: WorkerEnv): Promise<void> {
    await handleQueue(batch, env);
  },
} satisfies ExportedHandler<WorkerEnv, FeedTaskMessage>;
