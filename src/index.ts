import {
  CatalogPipelineError,
  loadCatalogParentPages,
  loadPodcastCatalog,
} from "./catalog";
import { determineWriteMode, shouldWriteFeedTask } from "./canary";
import {
  createNotionClient,
  notionJsonBody,
  type NotionResponse,
} from "./notion/client";
import { buildDryRunDiff, NotionDedupError, type DryRunDiff } from "./notion/dedup";
import { NotionPayloadError } from "./notion/payload";
import {
  countTaskEpisodeWrites,
  EpisodeWriteError,
  writeEpisodes,
} from "./notion/episodes";
import {
  cacheParentSyncBlock,
  discoverParentSyncBlock,
  formatShanghaiTimestamp,
  ParentBlockError,
  updateParentPagesSequentially,
  updateParentSyncTime,
} from "./notion/parent";
import { sha256Hex } from "./rss/dedup";
import { FeedPipelineError } from "./rss/errors";
import { fetchAndParseFeed } from "./rss/fetch";
import { normalizeAndValidateFeedUrl } from "./rss/url";

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
  force_dry_run?: boolean;
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
  will_write?: number;
  already_exists?: number;
  dedup_failed?: number;
  notion_write_count?: number;
  parent_update_count?: number;
  description_truncated?: number;
  write_enabled?: boolean;
  skipped_categories?: string[];
};

type JsonRecord = Record<string, unknown>;

type StepResult = {
  step: string;
  ok: boolean;
  status: number;
  summary: string;
};

type TaskProcessingOutcome = DryRunDiff & {
  description_truncated: number;
  notion_write_count: number;
  parent_update_count: number;
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
    typeof value.content_fingerprint === "string" &&
    (value.force_dry_run === undefined || typeof value.force_dry_run === "boolean")
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

function failedCallStep(step: string, result: NotionResponse): StepResult {
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
  const notionClient = createNotionClient(notionToken);
  const notionRequest = (
    path: string,
    init: RequestInit = {},
    retry = true,
  ): Promise<NotionResponse> => notionClient.request(path, init, { retry });

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
    { method: "POST", body: notionJsonBody({ page_size: 1 }) },
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
    { method: "POST", body: notionJsonBody({ page_size: 1 }) },
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
  const createPage = await notionRequest(
    "/v1/pages",
    {
      method: "POST",
      body: notionJsonBody({
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
    },
    false,
  );
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
    body: notionJsonBody({ in_trash: true }),
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

async function handleProducer(
  input: { runId: string; triggerName: string; scheduledTime: number },
  env: WorkerEnv,
): Promise<void> {
  const runId = input.runId;
  const scheduledAt = new Date(input.scheduledTime).toISOString();
  const previousRunWindowStart = new Date(
    input.scheduledTime - PREVIOUS_RUN_WINDOW_MS,
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
      .bind(runId, input.triggerName, scheduledAt, startedAt, startedAt)
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

        const catalog = await loadPodcastCatalog(
          createNotionClient(env.NOTION_TOKEN),
          env.NOTION_MONITOR_DS_ID,
        );
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
          input.scheduledTime - env.RSS_WINDOW_HOURS * 60 * 60 * 1_000,
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

async function handleScheduled(controller: ScheduledController, env: WorkerEnv): Promise<void> {
  await handleProducer(
    {
      runId: stableRunId(controller),
      triggerName: controller.cron,
      scheduledTime: controller.scheduledTime,
    },
    env,
  );
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
  outcome: TaskProcessingOutcome,
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
          new_episode_count = ?,
          will_write_count = ?,
          already_exists_count = ?,
          dedup_failed_count = ?,
          notion_write_count = ?,
          parent_update_count = ?,
          description_truncated_count = ?,
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
      outcome.will_write,
      outcome.will_write,
      outcome.already_exists,
      outcome.dedup_failed,
      outcome.notion_write_count,
      outcome.parent_update_count,
      outcome.description_truncated,
      body.task_id,
      body.run_id,
    ),
    env.DB.prepare(
      `UPDATE runs
      SET succeeded_feed_count = succeeded_feed_count + 1,
          new_episode_count = new_episode_count + ?,
          parent_update_count = parent_update_count + ?,
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
    ).bind(
      outcome.notion_write_count,
      outcome.parent_update_count,
      finishedAt,
      finishedAt,
      body.run_id,
      body.task_id,
      body.run_id,
      finishedAt,
    ),
  ]);
  return (results[0]?.meta.changes ?? 0) > 0;
}

function toNotionFeedError(error: unknown): FeedPipelineError | null {
  if (error instanceof NotionPayloadError) {
    return new FeedPipelineError("notion_payload_invalid");
  }
  if (!(error instanceof NotionDedupError)) {
    if (error instanceof EpisodeWriteError) {
      return new FeedPipelineError(error.code, {
        retryable: error.retryable,
        httpStatus: error.httpStatus,
      });
    }
    if (error instanceof ParentBlockError) {
      return new FeedPipelineError("parent_update_failed", {
        retryable: true,
        httpStatus: error.httpStatus,
      });
    }
    return null;
  }
  switch (error.code) {
    case "episode_schema_invalid":
    case "episode_schema_dedup_key_missing":
    case "episode_schema_dedup_key_ambiguous":
    case "episode_schema_podcast_name_missing":
    case "episode_schema_podcast_name_ambiguous":
      return new FeedPipelineError(error.code, { httpStatus: error.httpStatus });
    default:
      return new FeedPipelineError("notion_dedup_query_failed", {
        retryable: error.retryable,
        httpStatus: error.httpStatus,
      });
  }
}

type TaskWriteProgress = {
  description_truncated_count: number;
  notion_write_count: number;
  parent_update_count: number;
};

async function loadTaskWriteProgress(
  body: FeedTaskMessage,
  env: WorkerEnv,
): Promise<TaskWriteProgress> {
  const row = await env.DB.prepare(
    `SELECT notion_write_count, parent_update_count, description_truncated_count
    FROM feed_tasks WHERE task_id = ? AND run_id = ?`,
  )
    .bind(body.task_id, body.run_id)
    .first<TaskWriteProgress>();
  return (
    row ?? {
      notion_write_count: 0,
      parent_update_count: 0,
      description_truncated_count: 0,
    }
  );
}

async function persistTaskWriteProgress(
  body: FeedTaskMessage,
  progress: TaskWriteProgress,
  env: WorkerEnv,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE feed_tasks
    SET notion_write_count = MAX(notion_write_count, ?),
        parent_update_count = MAX(parent_update_count, ?),
        description_truncated_count = MAX(description_truncated_count, ?),
        new_episode_count = MAX(new_episode_count, ?)
    WHERE task_id = ? AND run_id = ? AND status = 'processing'`,
  )
    .bind(
      progress.notion_write_count,
      progress.parent_update_count,
      progress.description_truncated_count,
      progress.notion_write_count,
      body.task_id,
      body.run_id,
    )
    .run();
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
          new_episode_count = new_episode_count + COALESCE((
            SELECT notion_write_count FROM feed_tasks
            WHERE task_id = ? AND run_id = ?
          ), 0),
          parent_update_count = parent_update_count + COALESCE((
            SELECT parent_update_count FROM feed_tasks
            WHERE task_id = ? AND run_id = ?
          ), 0),
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
      body.task_id,
      body.run_id,
      body.task_id,
      body.run_id,
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
        if (!env.NOTION_TOKEN) {
          throw new FeedPipelineError("notion_token_missing");
        }

        const softDeadlineAt = Date.now() + env.MESSAGE_SOFT_DEADLINE_MS;
        const result = await fetchAndParseFeed(
          body.feed_url,
          { start: body.window_start, end: body.window_end },
          {
            maxBytes: env.RSS_MAX_BYTES,
            maxRedirects: env.RSS_MAX_REDIRECTS,
            connectTimeoutMs: env.RSS_CONNECT_TIMEOUT_MS,
            totalTimeoutMs: env.RSS_TIMEOUT_MS,
            softDeadlineAt,
          },
        );
        const notionClient = createNotionClient(env.NOTION_TOKEN, { softDeadlineAt });
        const writeEnabled = shouldWriteFeedTask(
          Boolean(env.DRY_RUN),
          env.CANARY_FEED_HASHES,
          body.feed_url_hash,
          body.force_dry_run === true,
        );
        let outcome: TaskProcessingOutcome;
        if (writeEnabled) {
          const writes = await writeEpisodes({
            candidates: result.items,
            categories: body.categories,
            client: notionClient,
            database: env.DB,
            dataSourceId: env.NOTION_EPISODE_DS_ID,
            feedUrl: body.feed_url,
            feedUrlHash: body.feed_url_hash,
            language: body.language,
            podcastName: body.podcast_name,
            runId: body.run_id,
            taskId: body.task_id,
            windowItemCount: result.window_item_count,
          });
          if (writes.skipped_categories.length > 0) {
            writeLog({
              level: "warn",
              event: "episode_categories_skipped",
              error_code: "episode_category_not_allowed",
              run_id: body.run_id,
              task_id: body.task_id,
              issue_count: writes.skipped_categories.length,
              skipped_categories: writes.skipped_categories,
            });
          }
          const taskWriteCount = await countTaskEpisodeWrites(env.DB, body.task_id);
          let parentUpdateCount = 0;
          if (taskWriteCount > 0 && body.parent_page_ids.length > 0) {
            const timestamp = formatShanghaiTimestamp(new Date());
            const parentUpdates = await updateParentPagesSequentially(
              body.parent_page_ids,
              async (parentPageId) => {
                await updateParentSyncTime(
                  notionClient,
                  env.DB,
                  parentPageId,
                  timestamp,
                );
              },
            );
            parentUpdateCount = parentUpdates.updated_count;
            for (const failure of parentUpdates.failures) {
              const errorCode =
                failure.error instanceof ParentBlockError
                  ? failure.error.code
                  : "parent_sync_callout_update_failed";
              writeLog({
                level: "error",
                event: "parent_update_failed",
                error_code: errorCode,
                run_id: body.run_id,
                task_id: body.task_id,
              });
            }
            const previousProgress = await loadTaskWriteProgress(body, env);
            await persistTaskWriteProgress(
              body,
              {
                notion_write_count: taskWriteCount,
                parent_update_count: parentUpdateCount,
                description_truncated_count: Math.max(
                  previousProgress.description_truncated_count,
                  writes.description_truncated,
                ),
              },
              env,
            );
            if (parentUpdates.failures.length > 0) {
              throw new FeedPipelineError("parent_update_failed", { retryable: true });
            }
          }
          const retainedProgress = await loadTaskWriteProgress(body, env);
          outcome = {
            will_write: Math.max(writes.will_write, taskWriteCount),
            already_exists: writes.already_exists,
            dedup_failed: writes.dedup_failed,
            description_truncated: Math.max(
              writes.description_truncated,
              retainedProgress.description_truncated_count,
            ),
            notion_write_count: taskWriteCount,
            parent_update_count: Math.max(
              parentUpdateCount,
              retainedProgress.parent_update_count,
            ),
          };
        } else {
          const diff = await buildDryRunDiff(
            notionClient,
            env.NOTION_EPISODE_DS_ID,
            body.podcast_name,
            result.items,
            result.window_item_count,
          );
          outcome = {
            ...diff,
            description_truncated: result.items.filter(
              (item) => item.description_truncated,
            ).length,
            notion_write_count: 0,
            parent_update_count: 0,
          };
        }
        if (!(await finalizeTaskSucceeded(body, result, outcome, env))) {
          throw new Error("feed_task_not_finalized");
        }

        writeLog({
          level: "info",
          event: writeEnabled ? "queue_task_write_succeeded" : "queue_task_dry_run_succeeded",
          run_id: body.run_id,
          task_id: body.task_id,
          status: "succeeded",
          attempts: message.attempts,
          downloaded_bytes: result.downloaded_bytes,
          parsed_item_count: result.parsed_item_count,
          window_item_count: result.window_item_count,
          redirect_count: result.redirect_count,
          will_write: outcome.will_write,
          already_exists: outcome.already_exists,
          dedup_failed: outcome.dedup_failed,
          notion_write_count: outcome.notion_write_count,
          parent_update_count: outcome.parent_update_count,
          description_truncated: outcome.description_truncated,
          write_enabled: writeEnabled,
        });
        message.ack();
      } catch (error) {
        const partialWriteCount = await countTaskEpisodeWrites(env.DB, body.task_id);
        if (partialWriteCount > 0) {
          const progress = await loadTaskWriteProgress(body, env);
          await persistTaskWriteProgress(
            body,
            {
              ...progress,
              notion_write_count: Math.max(
                progress.notion_write_count,
                partialWriteCount,
              ),
            },
            env,
          );
        }
        const pipelineError =
          error instanceof FeedPipelineError ? error : toNotionFeedError(error);
        if (pipelineError === null) {
          throw error;
        }

        if (pipelineError.retryable) {
          await markTaskRetrying(body, pipelineError, env);
          writeLog({
            level: "warn",
            event: "queue_task_retrying",
            error_code: pipelineError.code,
            run_id: body.run_id,
            task_id: body.task_id,
            status: "retrying",
            attempts: message.attempts,
            retry_delay_seconds: retryDelaySeconds,
          });
          message.retry({ delaySeconds: retryDelaySeconds });
          continue;
        }

        if (!(await finalizeTaskFailed(body, pipelineError, env))) {
          throw new Error("feed_task_not_finalized");
        }
        writeLog({
          level: "error",
          event: "queue_task_failed_deterministic",
          error_code: pipelineError.code,
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
    const replayBody: FeedTaskMessage = {
      ...parseOutboxMessage(rows[0]!),
      force_dry_run: true,
    };
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
      force_dry_run: true,
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

async function runManualTrigger(env: WorkerEnv): Promise<Response> {
  const scheduledTime = Date.now();
  const runId = `manual-run:${scheduledTime}:${crypto.randomUUID()}`;
  try {
    await handleProducer(
      { runId, triggerName: "manual-trigger", scheduledTime },
      env,
    );
    const status = await getRunStatus(runId, env);
    if (status === null) {
      throw new Error("manual_run_missing");
    }
    if (status === "skipped_previous_run_active") {
      return json(
        {
          ok: false,
          error: "previous_run_active",
          run_id: runId,
          status,
        },
        409,
      );
    }
    const writeMode = determineWriteMode(
      Boolean(env.DRY_RUN),
      env.CANARY_FEED_HASHES,
    );
    const canaryWritesEnabled = writeMode === "canary";
    return json(
      {
        ok: true,
        dry_run: writeMode === "dry_run",
        canary_writes_enabled: canaryWritesEnabled,
        write_mode: writeMode,
        run_id: runId,
        status,
      },
      202,
    );
  } catch (error) {
    const errorCode =
      error instanceof Error && /^[a-z0-9_]+$/.test(error.message)
        ? error.message
        : "manual_run_failed";
    return json({ ok: false, error: errorCode, run_id: runId }, 503);
  }
}

type ParentCheckResult =
  | {
      page_id: string;
      podcast_name: string;
      ok: true;
      block_id: string;
    }
  | {
      page_id: string;
      podcast_name: string;
      ok: false;
      error_code: string;
    };

async function runParentCheck(env: WorkerEnv, notionToken: string): Promise<Response> {
  const client = createNotionClient(notionToken);
  let catalog: Awaited<ReturnType<typeof loadCatalogParentPages>>;
  try {
    catalog = await loadCatalogParentPages(client, env.NOTION_MONITOR_DS_ID);
  } catch (error) {
    const errorCode =
      error instanceof CatalogPipelineError ? error.code : "parent_check_catalog_failed";
    return json({ ok: false, error: errorCode, results: [] }, 502);
  }

  const results: ParentCheckResult[] = [];
  for (const parent of catalog.parent_pages) {
    try {
      const block = await discoverParentSyncBlock(client, parent.page_id);
      await cacheParentSyncBlock(env.DB, parent.page_id, block);
      results.push({
        page_id: parent.page_id,
        podcast_name: parent.podcast_name,
        ok: true,
        block_id: block.block_id,
      });
    } catch (error) {
      const errorCode =
        error instanceof ParentBlockError ? error.code : "parent_check_failed";
      results.push({
        page_id: parent.page_id,
        podcast_name: parent.podcast_name,
        ok: false,
        error_code: errorCode,
      });
      writeLog({
        level: "warn",
        event: "parent_check_page_failed",
        error_code: errorCode,
      });
    }
  }

  const ok = results.every((result) => result.ok);
  return json({ ok, results }, ok ? 200 : 207);
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

    if (url.pathname === "/trigger-run") {
      if (request.method !== "POST") {
        return json({ ok: false, error: "method_not_allowed" }, 405, { Allow: "POST" });
      }
      if (!env.MANUAL_TRIGGER_TOKEN) {
        return json({ ok: false, error: "service_not_configured" }, 503);
      }
      if (!(await isAuthorized(request, env.MANUAL_TRIGGER_TOKEN))) {
        return json({ ok: false, error: "unauthorized" }, 401);
      }
      if (!env.NOTION_TOKEN) {
        return json({ ok: false, error: "service_not_configured" }, 503);
      }
      return runManualTrigger(env);
    }

    if (url.pathname === "/parent-check") {
      if (request.method !== "POST") {
        return json({ ok: false, error: "method_not_allowed" }, 405, { Allow: "POST" });
      }
      if (!env.MANUAL_TRIGGER_TOKEN) {
        return json({ ok: false, error: "service_not_configured" }, 503);
      }
      if (!(await isAuthorized(request, env.MANUAL_TRIGGER_TOKEN))) {
        return json({ ok: false, error: "unauthorized" }, 401);
      }
      if (!env.NOTION_TOKEN) {
        return json({ ok: false, error: "service_not_configured" }, 503);
      }
      return runParentCheck(env, env.NOTION_TOKEN);
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
