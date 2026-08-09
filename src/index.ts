const NOTION_API_BASE = "https://api.notion.com";
const NOTION_VERSION = "2026-03-11";
const NOTION_REQUEST_GAP_MS = 350;
const NOTION_REQUEST_TIMEOUT_MS = 10_000;
const FEED_TASK_SCHEMA_VERSION = 1;
const PROCESSING_LEASE_MS = 15 * 60 * 1_000;
const QUEUE_RETRY_DELAY_SECONDS = 60;
const STAGE_ONE_NOT_IMPLEMENTED = "stage_1_consumer_not_implemented";
const PREVIOUS_RUN_WINDOW_MS = 24 * 60 * 60 * 1_000;

type Secrets = {
  readonly NOTION_TOKEN?: string;
  readonly MANUAL_TRIGGER_TOKEN?: string;
};

type WorkerEnv = Cloudflare.FinanceProductionEnv & Secrets;

type FeedTaskMessage = {
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

type TaskStatusRow = {
  status: string;
};

type StructuredLog = {
  level: "info" | "warn" | "error";
  event: string;
  error_code?: string;
  run_id?: string;
  task_id?: string;
  status?: string;
  attempts?: number;
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

    const finishedAt = new Date().toISOString();
    const completed = await env.DB.prepare(
      `UPDATE runs
      SET status = 'succeeded',
          finished_at = ?,
          heartbeat_at = ?,
          error_summary = NULL
      WHERE run_id = ?
        AND status = 'creating'`,
    )
      .bind(finishedAt, finishedAt, runId)
      .run();

    if (completed.meta.changes > 0) {
      writeLog({
        level: "info",
        event: "scheduled_empty_run_succeeded",
        run_id: runId,
        status: "succeeded",
      });
      return;
    }

    const current = await env.DB.prepare(
      `SELECT status
      FROM runs
      WHERE run_id = ?`,
    )
      .bind(runId)
      .first<TaskStatusRow>();

    writeLog({
      level: "info",
      event: "scheduled_run_terminal",
      run_id: runId,
      ...(current === null ? {} : { status: current.status }),
    });
  } catch {
    const failedAt = new Date().toISOString();

    try {
      await env.DB.prepare(
        `UPDATE runs
        SET status = 'failed',
            finished_at = ?,
            heartbeat_at = ?,
            error_summary = 'scheduled_d1_error'
        WHERE run_id = ?
          AND status = 'creating'`,
      )
        .bind(failedAt, failedAt, runId)
        .run();
    } catch {
      // The structured log below is the remaining failure signal if D1 is unavailable.
    }

    writeLog({
      level: "error",
      event: "scheduled_run_failed",
      error_code: "scheduled_d1_error",
      run_id: runId,
      status: "failed",
    });
    throw new Error("scheduled_d1_error");
  }
}

async function handleQueue(batch: MessageBatch<FeedTaskMessage>, env: WorkerEnv): Promise<void> {
  for (const message of batch.messages) {
    const body: unknown = message.body;

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
        .first<TaskStatusRow>();

      if (existing === null) {
        writeLog({
          level: "warn",
          event: "queue_task_missing",
          error_code: "feed_task_not_found",
          run_id: body.run_id,
          task_id: body.task_id,
          attempts: message.attempts,
        });
        message.retry({ delaySeconds: QUEUE_RETRY_DELAY_SECONDS });
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
          .first<TaskStatusRow>();

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
        });
        message.retry({ delaySeconds: QUEUE_RETRY_DELAY_SECONDS });
        continue;
      }

      const finishedAt = new Date().toISOString();
      const finalizeResults = await env.DB.batch([
        env.DB.prepare(
          `UPDATE feed_tasks
          SET status = 'failed',
              finished_at = ?,
              error_code = ?,
              error_summary = 'RSS processing is intentionally disabled in stage 1'
          WHERE task_id = ?
            AND run_id = ?
            AND status = 'processing'`,
        ).bind(finishedAt, STAGE_ONE_NOT_IMPLEMENTED, body.task_id, body.run_id),
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
              heartbeat_at = ?
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
          body.run_id,
          body.task_id,
          body.run_id,
          finishedAt,
          STAGE_ONE_NOT_IMPLEMENTED,
        ),
      ]);

      const finalizedTask = finalizeResults[0];

      if (finalizedTask === undefined || finalizedTask.meta.changes === 0) {
        writeLog({
          level: "warn",
          event: "queue_task_finalize_deferred",
          error_code: "feed_task_not_finalized",
          run_id: body.run_id,
          task_id: body.task_id,
          attempts: message.attempts,
        });
        message.retry({ delaySeconds: QUEUE_RETRY_DELAY_SECONDS });
        continue;
      }

      writeLog({
        level: "warn",
        event: "queue_task_stage_one_stub",
        error_code: STAGE_ONE_NOT_IMPLEMENTED,
        run_id: body.run_id,
        task_id: body.task_id,
        status: "failed",
        attempts: message.attempts,
      });
      message.ack();
    } catch {
      writeLog({
        level: "error",
        event: "queue_task_failed",
        error_code: "queue_d1_error",
        run_id: body.run_id,
        task_id: body.task_id,
        attempts: message.attempts,
      });
      message.retry({ delaySeconds: QUEUE_RETRY_DELAY_SECONDS });
    }
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

    return json({ ok: false, error: "not_found" }, 404);
  },
  async scheduled(controller: ScheduledController, env: WorkerEnv): Promise<void> {
    await handleScheduled(controller, env);
  },
  async queue(batch: MessageBatch<FeedTaskMessage>, env: WorkerEnv): Promise<void> {
    await handleQueue(batch, env);
  },
} satisfies ExportedHandler<WorkerEnv, FeedTaskMessage>;
