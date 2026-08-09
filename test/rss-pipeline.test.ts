import { createServer, type Server } from "node:http";
import { gzip } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

import { queueRetryDelaySeconds } from "../src/index";
import {
  createDedupKey,
  DEDUP_KEY_MAX_CHARACTERS,
  sha256Hex,
} from "../src/rss/dedup";
import { FeedPipelineError } from "../src/rss/errors";
import { fetchAndParseFeed } from "../src/rss/fetch";
import { normalizeAndValidateFeedUrl } from "../src/rss/url";
import { createSyntheticFeed, mib, responseFromXml } from "./fixtures/generate-feed";

const MAX_BYTES = mib(32);
const WINDOW = { start: "2026-08-07T19:00:00.000Z", end: "2026-08-08T21:00:00.000Z" };
const BASE_OPTIONS = {
  maxBytes: MAX_BYTES,
  maxRedirects: 3,
  connectTimeoutMs: 5_000,
  totalTimeoutMs: 120_000,
};

function errorCode(error: unknown): string | null {
  return error instanceof FeedPipelineError ? error.code : null;
}

describe("streaming RSS size boundaries", () => {
  it.each([5, 10, 20, 32])(
    "parses a %i MiB feed without buffering the full body",
    async (sizeMiB) => {
      const fixture = createSyntheticFeed(mib(sizeMiB), { contentLength: sizeMiB !== 10 });
      const heapAtStart = process.memoryUsage().heapUsed;
      let peakHeap = heapAtStart;
      const result = await fetchAndParseFeed("https://feeds.example.com/podcast.xml", WINDOW, {
        ...BASE_OPTIONS,
        fetchImpl: async () => fixture.response,
        onBytesRead: () => {
          peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
        },
      });

      expect(result.downloaded_bytes).toBe(mib(sizeMiB));
      expect(result.parsed_item_count).toBe(1);
      expect(result.window_item_count).toBe(1);
      expect(peakHeap - heapAtStart).toBeLessThan(mib(96));
    },
    120_000,
  );

  it("rejects a 33 MiB identity response from Content-Length before reading", async () => {
    const fixture = createSyntheticFeed(mib(33));
    await expect(
      fetchAndParseFeed("https://feeds.example.com/too-large.xml", WINDOW, {
        ...BASE_OPTIONS,
        fetchImpl: async () => fixture.response,
      }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "feed_too_large");
    expect(fixture.bytesEnqueued()).toBeLessThan(mib(1));
    expect(fixture.cancelled()).toBe(true);
  });

  it("rejects a 33 MiB chunked response while reading and cancels the stream", async () => {
    const fixture = createSyntheticFeed(mib(33), { contentLength: false });
    await expect(
      fetchAndParseFeed("https://feeds.example.com/chunked.xml", WINDOW, {
        ...BASE_OPTIONS,
        fetchImpl: async () => fixture.response,
      }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "feed_too_large");
    expect(fixture.bytesEnqueued()).toBeGreaterThan(MAX_BYTES);
    expect(fixture.bytesEnqueued()).toBeLessThan(MAX_BYTES + mib(1));
    expect(fixture.cancelled()).toBe(true);
  });
});

describe("gzip and HTTP streaming", () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (server !== null) {
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error === undefined ? resolve() : reject(error))),
      );
      server = null;
    }
  });

  it("counts the decompressed bytes when fetch transparently decodes gzip", async () => {
    const xml =
      '<?xml version="1.0"?><rss><channel><item><guid>gzip-guid</guid>' +
      '<title>Gzip episode</title><pubDate>Fri, 08 Aug 2026 20:00:00 GMT</pubDate>' +
      "</item></channel></rss>";
    const compressed = await new Promise<Buffer>((resolve, reject) =>
      gzip(xml, (error, value) => (error === null ? resolve(value) : reject(error))),
    );
    server = createServer((_request, response) => {
      response.writeHead(200, {
        "Content-Type": "application/rss+xml",
        "Content-Encoding": "gzip",
        "Content-Length": String(compressed.byteLength),
      });
      response.end(compressed);
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("test server did not expose a TCP port");
    }

    const result = await fetchAndParseFeed("https://feeds.example.com/gzip.xml", WINDOW, {
      ...BASE_OPTIONS,
      fetchImpl: async () => fetch(`http://127.0.0.1:${address.port}`),
    });
    expect(result.downloaded_bytes).toBe(new TextEncoder().encode(xml).byteLength);
    expect(result.downloaded_bytes).toBeGreaterThan(compressed.byteLength);
    expect(result.window_item_count).toBe(1);
  });

  it("does not trust compressed Content-Length as the decoded body size", async () => {
    const response = responseFromXml(
      "<rss><channel><item><guid>compressed-length</guid>" +
        "<pubDate>Fri, 08 Aug 2026 20:00:00 GMT</pubDate></item></channel></rss>",
      { "Content-Encoding": "gzip", "Content-Length": String(mib(33)) },
    );
    const result = await fetchAndParseFeed("https://feeds.example.com/compressed.xml", WINDOW, {
      ...BASE_OPTIONS,
      fetchImpl: async () => response,
    });
    expect(result.window_item_count).toBe(1);
    expect(result.downloaded_bytes).toBeLessThan(mib(1));
  });
});

describe("XML safety limits", () => {
  it("rejects malformed XML", async () => {
    const response = responseFromXml("<rss><channel><item></channel></rss>");
    await expect(
      fetchAndParseFeed("https://feeds.example.com/malformed.xml", WINDOW, {
        ...BASE_OPTIONS,
        fetchImpl: async () => response,
      }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "xml_malformed");
  });

  it("rejects XML deeper than the configured maximum", async () => {
    const response = responseFromXml(`<rss>${"<x>".repeat(65)}${"</x>".repeat(65)}</rss>`);
    await expect(
      fetchAndParseFeed("https://feeds.example.com/deep.xml", WINDOW, {
        ...BASE_OPTIONS,
        fetchImpl: async () => response,
      }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "xml_depth_exceeded");
  });

  it("rejects an oversized retained field", async () => {
    const response = responseFromXml(
      `<rss><channel><item><title>${"x".repeat(9_000)}</title>` +
        "<pubDate>Fri, 08 Aug 2026 20:00:00 GMT</pubDate></item></channel></rss>",
    );
    await expect(
      fetchAndParseFeed("https://feeds.example.com/long-field.xml", WINDOW, {
        ...BASE_OPTIONS,
        fetchImpl: async () => response,
      }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "xml_field_too_large");
  });

  it("reports unsupported XML encodings explicitly", async () => {
    const response = responseFromXml(
      '<?xml version="1.0" encoding="x-not-an-encoding"?><rss><channel /></rss>',
    );
    await expect(
      fetchAndParseFeed("https://feeds.example.com/encoding.xml", WINDOW, {
        ...BASE_OPTIONS,
        fetchImpl: async () => response,
      }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "unsupported_xml_encoding");
  });

  it("decodes a declared GBK feed incrementally when the runtime supports it", async () => {
    const encoder = new TextEncoder();
    const prefix = encoder.encode(
      '<?xml version="1.0" encoding="GBK"?><rss><channel><item><guid>gbk</guid><title>',
    );
    const title = new Uint8Array([0xb2, 0xe2, 0xca, 0xd4]); // 测试 in GBK
    const suffix = encoder.encode(
      "</title><pubDate>Fri, 08 Aug 2026 20:00:00 GMT</pubDate></item></channel></rss>",
    );
    const bytes = new Uint8Array(prefix.byteLength + title.byteLength + suffix.byteLength);
    bytes.set(prefix, 0);
    bytes.set(title, prefix.byteLength);
    bytes.set(suffix, prefix.byteLength + title.byteLength);
    const response = new Response(bytes, { status: 200 });
    const result = await fetchAndParseFeed("https://feeds.example.com/gbk.xml", WINDOW, {
      ...BASE_OPTIONS,
      fetchImpl: async () => response,
    });
    expect(result.items[0]?.title).toBe("测试");
    expect(result.xml_encoding).toBe("gbk");
  });

  it("extracts extended podcast fields and truncates description while streaming", async () => {
    const response = responseFromXml(`<?xml version="1.0"?>
      <rss xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
           xmlns:content="http://purl.org/rss/1.0/modules/content/"
           xmlns:podcast="https://podcastindex.org/namespace/1.0">
        <channel><item>
          <guid>extended-guid</guid><title>Extended episode</title>
          <pubDate>Fri, 08 Aug 2026 20:00:00 GMT</pubDate>
          <itunes:author>Author A</itunes:author><itunes:duration>01:02:03</itunes:duration>
          <itunes:season>2</itunes:season><itunes:episode>7</itunes:episode>
          <itunes:episodeType>full</itunes:episodeType><itunes:explicit>no</itunes:explicit>
          <itunes:category text="Business"/><category>Technology</category>
          <itunes:keywords>investing, AI</itunes:keywords>
          <itunes:image href="https://cdn.example.com/cover.jpg"/>
          <podcast:transcript url="https://example.com/transcript.json" type="application/json"/>
          <enclosure url="https://cdn.example.com/episode.mp3" type="audio/mpeg" length="123456"/>
          <content:encoded><![CDATA[<p>Alpha &amp; Beta</p><p>${"长".repeat(100)}</p>]]></content:encoded>
        </item></channel>
      </rss>`);
    const result = await fetchAndParseFeed("https://feeds.example.com/extended.xml", WINDOW, {
      ...BASE_OPTIONS,
      maxDescriptionCharacters: 20,
      fetchImpl: async () => response,
    });
    expect(result.items[0]).toMatchObject({
      author: "Author A",
      description: `Alpha & Beta\n${"长".repeat(7)}`,
      description_truncated: true,
      duration: "01:02:03",
      season: "2",
      episode: "7",
      episode_type: "full",
      explicit: "no",
      rss_categories: ["Business", "Technology"],
      keywords: ["investing", "AI"],
      image_url: "https://cdn.example.com/cover.jpg",
      transcript_url: "https://example.com/transcript.json",
      media_url: "https://cdn.example.com/episode.mp3",
      media_type: "audio/mpeg",
      media_length: "123456",
    });
  });
});

describe("URL security and redirects", () => {
  it.each([
    "http://localhost/feed",
    "http://127.0.0.1/feed",
    "http://10.0.0.1/feed",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/feed",
    "http://metadata.google.internal/feed",
  ])("rejects non-public target %s", (url) => {
    expect(() => normalizeAndValidateFeedUrl(url)).toThrow(FeedPipelineError);
  });

  it("revalidates redirects and rejects a redirect to a private target", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(null, { status: 302, headers: { Location: "http://127.0.0.1/private" } });
    await expect(
      fetchAndParseFeed("https://feeds.example.com/start", WINDOW, {
        ...BASE_OPTIONS,
        fetchImpl,
      }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "url_ip_literal_forbidden");
  });

  it("detects a redirect loop", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      return new Response(null, {
        status: 302,
        headers: {
          Location: url.includes("/a")
            ? "https://feeds.example.com/b"
            : "https://feeds.example.com/a",
        },
      });
    };
    await expect(
      fetchAndParseFeed("https://feeds.example.com/a", WINDOW, {
        ...BASE_OPTIONS,
        fetchImpl,
      }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "feed_redirect_loop");
  });

  it("aborts a slow connection with a retryable stable error", async () => {
    const fetchImpl: typeof fetch = async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    await expect(
      fetchAndParseFeed("https://feeds.example.com/slow", WINDOW, {
        ...BASE_OPTIONS,
        connectTimeoutMs: 10,
        fetchImpl,
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof FeedPipelineError &&
        error.code === "feed_connect_timeout" &&
        error.retryable,
    );
  });

  it("cancels a stalled response body at the total read timeout", async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
      }),
    );
    await expect(
      fetchAndParseFeed("https://feeds.example.com/stalled-body", WINDOW, {
        ...BASE_OPTIONS,
        totalTimeoutMs: 10,
        fetchImpl: async () => response,
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof FeedPipelineError &&
        error.code === "feed_total_timeout" &&
        error.retryable,
    );
    expect(cancelled).toBe(true);
  });
});

describe("dedupKey normalization and precedence", () => {
  it("uses GUID first, trims whitespace, and preserves opaque identifier case", async () => {
    const first = await createDedupKey({
      guid: "  Episode-ID  ",
      link: "https://example.com/ignored",
      mediaUrl: null,
      title: "Ignored",
      publishedAt: "2026-08-08T20:00:00Z",
    });
    const same = await createDedupKey({
      guid: "Episode-ID",
      link: null,
      mediaUrl: null,
      title: null,
      publishedAt: null,
    });
    const differentCase = await createDedupKey({
      guid: "episode-id",
      link: null,
      mediaUrl: null,
      title: null,
      publishedAt: null,
    });
    expect(first).toEqual(same);
    expect(first).toEqual({ source: "guid", key: "guid:Episode-ID" });
    expect(differentCase).toEqual({ source: "guid", key: "guid:episode-id" });
  });

  it("normalizes URL scheme/host and fragment but preserves path/query case", async () => {
    const first = await createDedupKey({
      guid: null,
      link: " HTTPS://EXAMPLE.COM:443/Episode?ID=AbC#player ",
      mediaUrl: null,
      title: null,
      publishedAt: null,
    });
    const same = await createDedupKey({
      guid: null,
      link: "https://example.com/Episode?ID=AbC",
      mediaUrl: null,
      title: null,
      publishedAt: null,
    });
    const differentPathCase = await createDedupKey({
      guid: null,
      link: "https://example.com/episode?ID=AbC",
      mediaUrl: null,
      title: null,
      publishedAt: null,
    });
    expect(first).toEqual(same);
    expect(first).toEqual({
      source: "link",
      key: "link:https://example.com/Episode?ID=AbC",
    });
    expect(differentPathCase).toEqual({
      source: "link",
      key: "link:https://example.com/episode?ID=AbC",
    });
  });

  it("uses the normalized enclosure URL as a plaintext media key", async () => {
    const result = await createDedupKey({
      guid: null,
      link: null,
      mediaUrl: " HTTPS://CDN.EXAMPLE.COM:443/audio.mp3#player ",
      title: null,
      publishedAt: null,
    });
    expect(result).toEqual({
      source: "media",
      key: "media:https://cdn.example.com/audio.mp3",
    });
  });

  it("falls back to normalized title plus canonical publication time", async () => {
    const first = await createDedupKey({
      guid: null,
      link: null,
      mediaUrl: null,
      title: "  Ａ  Podcast   Episode  ",
      publishedAt: "Sat, 08 Aug 2026 20:00:00 GMT",
    });
    const same = await createDedupKey({
      guid: null,
      link: null,
      mediaUrl: null,
      title: "A Podcast Episode",
      publishedAt: "2026-08-08T20:00:00.000Z",
    });
    expect(first).toEqual(same);
    expect(first).toEqual({
      source: "title_date",
      key: "title_date:A Podcast Episode\n2026-08-08T20:00:00.000Z",
    });
  });

  it("keeps a long plaintext prefix and hashes only the truncated overflow", async () => {
    const boundaryGuid = "b".repeat(1_895);
    const boundary = await createDedupKey({
      guid: boundaryGuid,
      link: null,
      mediaUrl: null,
      title: null,
      publishedAt: null,
    });
    expect(boundary?.key).toBe(`guid:${boundaryGuid}`);
    expect(Array.from(boundary!.key)).toHaveLength(DEDUP_KEY_MAX_CHARACTERS);

    const normalizedGuid = "x".repeat(1_896);
    const overflow = normalizedGuid.slice(1_800);
    const result = await createDedupKey({
      guid: normalizedGuid,
      link: null,
      mediaUrl: null,
      title: null,
      publishedAt: null,
    });
    expect(result).toEqual({
      source: "guid",
      key: `guid:${"x".repeat(1_800)}#sha256:${await sha256Hex(overflow)}`,
    });
    expect(Array.from(result!.key).length).toBeLessThanOrEqual(DEDUP_KEY_MAX_CHARACTERS);
  });
});

describe("Queue retry policy", () => {
  it("uses attempts-based exponential backoff capped at 24 hours", () => {
    expect(queueRetryDelaySeconds(1)).toBe(60);
    expect(queueRetryDelaySeconds(2)).toBe(120);
    expect(queueRetryDelaySeconds(5)).toBe(960);
    expect(queueRetryDelaySeconds(20)).toBe(86_400);
  });
});
