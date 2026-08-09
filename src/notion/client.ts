import {
  NOTION_REQUEST_MAX_BYTES,
  NotionPayloadError,
  serializeNotionPayload,
} from "./payload";

const NOTION_API_BASE = "https://api.notion.com";
const NOTION_VERSION = "2026-03-11";
const DEFAULT_REQUEST_GAP_MS = 1_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_RETRY_BASE_MS = 1_000;
const DEFAULT_RETRY_CAP_MS = 30_000;
const JITTER_LIMIT_MS = 250;

type JsonRecord = Record<string, unknown>;

export type NotionResponse = {
  ok: boolean;
  status: number;
  data: unknown;
  errorCode?: string;
  errorSummary?: string;
};

export type NotionRequestOptions = {
  retry?: boolean | "rate_limit";
};

export type NotionClient = {
  request(
    path: string,
    init?: RequestInit,
    options?: NotionRequestOptions,
  ): Promise<NotionResponse>;
};

export type NotionClientOptions = {
  fetchImpl?: typeof fetch;
  sleepImpl?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  requestGapMs?: number;
  requestTimeoutMs?: number;
  maxRetries?: number;
  retryBaseMs?: number;
  retryCapMs?: number;
  softDeadlineAt?: number;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultRandom(): number {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return value[0]! / 0x1_0000_0000;
}

function normalizedRandom(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(Math.max(value, 0), 1 - Number.EPSILON);
}

export function parseRetryAfterMs(value: string | null, nowMs: number): number | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) ? Math.max(0, Math.ceil(seconds * 1_000)) : null;
  }
  const timestamp = Date.parse(trimmed);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - nowMs) : null;
}

export function calculateNotionRetryDelayMs(
  retryIndex: number,
  retryAfterMs: number | null,
  randomValue: number,
  baseMs = DEFAULT_RETRY_BASE_MS,
  capMs = DEFAULT_RETRY_CAP_MS,
): number {
  const exponent = Math.max(0, Math.min(retryIndex, 20));
  const exponential = Math.min(baseMs * 2 ** exponent, capMs);
  const serverDelay = retryAfterMs ?? 0;
  const jitter = Math.floor(normalizedRandom(randomValue) * JITTER_LIMIT_MS);
  return Math.max(exponential, serverDelay) + jitter;
}

export function notionErrorSummary(status: number, data: unknown): {
  code: string;
  summary: string;
} {
  const code =
    isRecord(data) && data.object === "error" && typeof data.code === "string"
      ? data.code.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80)
      : `notion_http_${status}`;
  const message =
    isRecord(data) && data.object === "error" && typeof data.message === "string"
      ? data.message.replace(/[\r\n]+/g, " ").slice(0, 120)
      : "request failed";
  return { code, summary: `${code}: ${message}` };
}

function syntheticFailure(code: string, message: string): NotionResponse {
  return {
    ok: false,
    status: 0,
    data: null,
    errorCode: code,
    errorSummary: `${code}: ${message.slice(0, 120)}`,
  };
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 529 || [500, 502, 503, 504].includes(status);
}

function shouldRetryStatus(
  retry: NotionRequestOptions["retry"],
  status: number,
): boolean {
  if (retry === "rate_limit") {
    return status === 429 || status === 529;
  }
  return retry === true && isRetryableStatus(status);
}

export function createNotionClient(token: string, options: NotionClientOptions = {}): NotionClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleepImpl =
    options.sleepImpl ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const now = options.now ?? Date.now;
  const random = options.random ?? defaultRandom;
  const requestGapMs = options.requestGapMs ?? DEFAULT_REQUEST_GAP_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
  const retryCapMs = options.retryCapMs ?? DEFAULT_RETRY_CAP_MS;
  let nextRequestAt = 0;

  const wait = async (milliseconds: number): Promise<boolean> => {
    if (milliseconds <= 0) {
      return true;
    }
    if (
      options.softDeadlineAt !== undefined &&
      now() + milliseconds >= options.softDeadlineAt
    ) {
      return false;
    }
    await sleepImpl(milliseconds);
    return true;
  };

  return {
    async request(
      path: string,
      init: RequestInit = {},
      requestOptions: NotionRequestOptions = {},
    ): Promise<NotionResponse> {
      if (typeof init.body === "string") {
        if (new TextEncoder().encode(init.body).byteLength > NOTION_REQUEST_MAX_BYTES) {
          throw new NotionPayloadError("notion_request_too_large");
        }
      } else if (init.body !== undefined && init.body !== null) {
        throw new NotionPayloadError("notion_request_too_large");
      }

      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        if (!(await wait(Math.max(0, nextRequestAt - now())))) {
          return syntheticFailure("notion_soft_deadline", "soft deadline reached");
        }
        if (
          options.softDeadlineAt !== undefined &&
          now() + requestTimeoutMs >= options.softDeadlineAt
        ) {
          return syntheticFailure("notion_soft_deadline", "soft deadline reached");
        }
        nextRequestAt = now() + requestGapMs;

        let response: Response;
        try {
          const headers = new Headers(init.headers);
          headers.set("Authorization", `Bearer ${token}`);
          headers.set("Notion-Version", NOTION_VERSION);
          headers.set("Content-Type", "application/json");
          response = await fetchImpl(`${NOTION_API_BASE}${path}`, {
            ...init,
            headers,
            signal: AbortSignal.timeout(requestTimeoutMs),
          });
        } catch (error) {
          const timedOut = error instanceof DOMException && error.name === "TimeoutError";
          if (requestOptions.retry === true && attempt < maxRetries) {
            const delay = calculateNotionRetryDelayMs(
              attempt,
              null,
              random(),
              retryBaseMs,
              retryCapMs,
            );
            if (!(await wait(delay))) {
              return syntheticFailure("notion_soft_deadline", "soft deadline reached");
            }
            continue;
          }
          return syntheticFailure(
            timedOut ? "notion_request_timeout" : "notion_request_failed",
            timedOut ? "request timed out" : "request failed before receiving a response",
          );
        }

        const data: unknown = await response.json().catch(() => null);
        if (response.ok) {
          return { ok: true, status: response.status, data };
        }

        const details = notionErrorSummary(response.status, data);
        if (
          shouldRetryStatus(requestOptions.retry, response.status) &&
          attempt < maxRetries
        ) {
          const retryAfter = parseRetryAfterMs(response.headers.get("Retry-After"), now());
          const delay = calculateNotionRetryDelayMs(
            attempt,
            retryAfter,
            random(),
            retryBaseMs,
            retryCapMs,
          );
          if (!(await wait(delay))) {
            return syntheticFailure("notion_soft_deadline", "soft deadline reached");
          }
          continue;
        }
        return {
          ok: false,
          status: response.status,
          data,
          errorCode: details.code,
          errorSummary: details.summary,
        };
      }

      return syntheticFailure("notion_request_failed", "retry attempts exhausted");
    },
  };
}

export function notionJsonBody(value: unknown): string {
  return serializeNotionPayload(value);
}
