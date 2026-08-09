const NOTION_API_BASE = "https://api.notion.com";
const NOTION_VERSION = "2026-03-11";
const NOTION_REQUEST_GAP_MS = 350;
const NOTION_REQUEST_TIMEOUT_MS = 10_000;

type Secrets = {
  readonly NOTION_TOKEN?: string;
  readonly MANUAL_TRIGGER_TOKEN?: string;
};

type WorkerEnv = Cloudflare.FinanceProductionEnv & Secrets;

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
} satisfies ExportedHandler<WorkerEnv>;
