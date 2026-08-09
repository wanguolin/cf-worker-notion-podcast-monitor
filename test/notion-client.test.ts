import { describe, expect, it, vi } from "vitest";

import {
  calculateNotionRetryDelayMs,
  createNotionClient,
  notionErrorSummary,
  parseRetryAfterMs,
} from "../src/notion/client";
import {
  assertNotionRichText,
  assertNotionUrl,
  NOTION_REQUEST_MAX_BYTES,
  serializeNotionPayload,
  truncateNotionRichText,
} from "../src/notion/payload";

describe("Notion request pacing and retries", () => {
  it("keeps successful requests at least one second apart", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true }));
    const client = createNotionClient("test-token", {
      fetchImpl: fetchMock,
      now: () => now,
      sleepImpl: async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
      random: () => 0,
    });

    await client.request("/v1/users/me");
    await client.request("/v1/users/me");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([1_000]);
  });

  it("retries 429 and 529 with Retry-After, exponential backoff, and bounded jitter", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          { object: "error", code: "rate_limited", message: "slow down" },
          { status: 429, headers: { "Retry-After": "2" } },
        ),
      )
      .mockResolvedValueOnce(
        Response.json(
          { object: "error", code: "service_unavailable", message: "busy" },
          { status: 529, headers: { "Retry-After": "3" } },
        ),
      )
      .mockResolvedValueOnce(Response.json({ object: "list", results: [] }));
    const client = createNotionClient("test-token", {
      fetchImpl: fetchMock,
      now: () => now,
      sleepImpl: async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
      random: () => 0.999999,
    });

    const response = await client.request(
      "/v1/data_sources/example/query",
      { method: "POST", body: "{}" },
      { retry: true },
    );

    expect(response.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([2_249, 3_249]);
    expect(calculateNotionRetryDelayMs(20, null, 1)).toBe(30_249);
    expect(calculateNotionRetryDelayMs(20, 40_000, 1)).toBe(40_249);
  });

  it("parses Retry-After seconds and HTTP dates", () => {
    expect(parseRetryAfterMs("1.5", 0)).toBe(1_500);
    expect(parseRetryAfterMs("Thu, 01 Jan 1970 00:00:05 GMT", 1_000)).toBe(4_000);
    expect(parseRetryAfterMs("invalid", 0)).toBeNull();
  });

  it("returns only a sanitized code and truncated message in error summaries", () => {
    const details = notionErrorSummary(400, {
      object: "error",
      code: "validation_error",
      message: `${"x".repeat(130)}\nsecret-looking-tail`,
    });
    expect(details.code).toBe("validation_error");
    expect(details.summary).toBe(`validation_error: ${"x".repeat(120)}`);
  });

  it("returns a stable timeout error without exposing request headers", async () => {
    const client = createNotionClient("test-token", {
      fetchImpl: async () => {
        throw new DOMException("timed out", "TimeoutError");
      },
      maxRetries: 0,
    });
    const response = await client.request("/v1/users/me");
    expect(response).toMatchObject({
      ok: false,
      status: 0,
      errorCode: "notion_request_timeout",
      errorSummary: "notion_request_timeout: request timed out",
    });
  });
});

describe("Notion payload budgets", () => {
  it("enforces URL and rich-text boundaries by Unicode character", () => {
    expect(assertNotionUrl("u".repeat(2_000))).toHaveLength(2_000);
    expect(() => assertNotionUrl("u".repeat(2_001))).toThrow("notion_url_too_long");
    expect(assertNotionRichText("播".repeat(2_000))).toHaveLength(2_000);
    expect(() => assertNotionRichText("播".repeat(2_001))).toThrow(
      "notion_rich_text_too_long",
    );
    expect(assertNotionRichText("😀".repeat(2_000))).toHaveLength(4_000);
  });

  it("truncates rich text explicitly and reports that it changed", () => {
    expect(truncateNotionRichText("x".repeat(2_001))).toEqual({
      value: "x".repeat(2_000),
      truncated: true,
    });
    expect(truncateNotionRichText("short")).toEqual({ value: "short", truncated: false });
  });

  it("accepts exactly 500 KB and rejects one additional byte", () => {
    const exact = "x".repeat(NOTION_REQUEST_MAX_BYTES - 2);
    expect(new TextEncoder().encode(serializeNotionPayload(exact))).toHaveLength(
      NOTION_REQUEST_MAX_BYTES,
    );
    expect(() => serializeNotionPayload(`${exact}x`)).toThrow("notion_request_too_large");
  });
});
