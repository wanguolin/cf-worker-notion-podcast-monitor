import { FeedPipelineError } from "./errors";
import {
  parseFeedByteStream,
  type FeedParseResult,
  type FeedWindow,
  type ParseFeedOptions,
} from "./parser";
import { normalizeAndValidateFeedUrl } from "./url";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504, 529]);

export type FetchFeedOptions = ParseFeedOptions & {
  fetchImpl?: typeof fetch;
  maxBytes: number;
  maxRedirects: number;
  connectTimeoutMs: number;
  totalTimeoutMs: number;
};

export type FetchFeedResult = FeedParseResult & {
  downloaded_bytes: number;
  final_url: string;
  http_status: number;
  redirect_count: number;
};

function trustedIdentityContentLength(response: Response): number | null {
  const contentEncoding = response.headers.get("Content-Encoding")?.trim().toLowerCase();
  if (contentEncoding !== undefined && contentEncoding !== "" && contentEncoding !== "identity") {
    return null;
  }

  const value = response.headers.get("Content-Length");
  if (value === null || !/^\d+$/.test(value.trim())) {
    return null;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function cancelResponseBody(response: Response): Promise<void> {
  if (response.body !== null) {
    await response.body.cancel().catch(() => undefined);
  }
}

export async function fetchAndParseFeed(
  inputUrl: string,
  window: FeedWindow,
  options: FetchFeedOptions,
): Promise<FetchFeedResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const totalSignal = AbortSignal.timeout(options.totalTimeoutMs);
  let currentUrl = normalizeAndValidateFeedUrl(inputUrl);
  const visited = new Set<string>();

  for (let redirectCount = 0; redirectCount <= options.maxRedirects; redirectCount += 1) {
    if (visited.has(currentUrl)) {
      throw new FeedPipelineError("feed_redirect_loop");
    }
    visited.add(currentUrl);

    let response: Response;
    const connectController = new AbortController();
    const abortForTotalTimeout = (): void => {
      connectController.abort(totalSignal.reason);
    };
    totalSignal.addEventListener("abort", abortForTotalTimeout, { once: true });
    const connectTimer = setTimeout(() => {
      connectController.abort(new DOMException("connection timed out", "TimeoutError"));
    }, options.connectTimeoutMs);
    try {
      response = await fetchImpl(currentUrl, {
        method: "GET",
        redirect: "manual",
        headers: {
          Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.1",
          "Accept-Encoding": "gzip",
          "User-Agent": "cf-worker-notion-podcast-monitor/0.1",
        },
        signal: connectController.signal,
      });
    } catch {
      throw new FeedPipelineError(totalSignal.aborted ? "feed_total_timeout" : "feed_connect_timeout", {
        retryable: true,
      });
    } finally {
      clearTimeout(connectTimer);
      totalSignal.removeEventListener("abort", abortForTotalTimeout);
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get("Location");
      await cancelResponseBody(response);
      if (location === null) {
        throw new FeedPipelineError("feed_redirect_invalid");
      }
      if (redirectCount >= options.maxRedirects) {
        throw new FeedPipelineError("feed_redirect_limit");
      }
      currentUrl = normalizeAndValidateFeedUrl(location, currentUrl);
      continue;
    }

    if (!response.ok) {
      await cancelResponseBody(response);
      throw new FeedPipelineError("feed_http_error", {
        retryable: RETRYABLE_HTTP_STATUSES.has(response.status),
        httpStatus: response.status,
      });
    }

    const contentLength = trustedIdentityContentLength(response);
    if (contentLength !== null && contentLength > options.maxBytes) {
      await cancelResponseBody(response);
      throw new FeedPipelineError("feed_too_large", { httpStatus: response.status });
    }
    if (response.body === null) {
      throw new FeedPipelineError("feed_response_body_missing", {
        retryable: true,
        httpStatus: response.status,
      });
    }

    try {
      const parsed = await parseFeedByteStream(response.body, window, options.maxBytes, {
        ...options,
        abortSignal: totalSignal,
      });
      return {
        ...parsed,
        final_url: currentUrl,
        http_status: response.status,
        redirect_count: redirectCount,
      };
    } catch (error) {
      if (totalSignal.aborted) {
        throw new FeedPipelineError("feed_total_timeout", {
          retryable: true,
          httpStatus: response.status,
        });
      }
      throw error;
    }
  }

  throw new FeedPipelineError("feed_redirect_limit");
}
