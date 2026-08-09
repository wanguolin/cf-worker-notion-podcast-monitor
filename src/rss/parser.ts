import { SaxesParser, type SaxesAttributeNS, type SaxesTagNS } from "saxes";

import { createDedupKey, normalizePublishedAt, type DedupSource } from "./dedup";
import { FeedPipelineError } from "./errors";

const DEFAULT_MAX_XML_DEPTH = 64;
const DEFAULT_MAX_FIELD_CHARACTERS = 8_192;
const DEFAULT_MAX_WINDOW_ITEMS = 5_000;
const DEFAULT_MAX_RETAINED_CHARACTERS = 4 * 1024 * 1024;
const ENCODING_SNIFF_BYTES = 1_024;

type CapturedField = "guid" | "link" | "mediaUrl" | "publishedAt" | "title";

type MutableItem = Record<CapturedField, string | null>;

export type ParsedFeedItem = {
  guid: string | null;
  link: string | null;
  media_url: string | null;
  published_at: string;
  title: string | null;
  dedup_key: string;
  dedup_source: DedupSource;
};

export type FeedParseResult = {
  parsed_item_count: number;
  window_item_count: number;
  items: ParsedFeedItem[];
  xml_encoding: string;
};

export type FeedWindow = {
  start: string;
  end: string;
};

export type ParseFeedOptions = {
  abortSignal?: AbortSignal;
  maxDepth?: number;
  maxFieldCharacters?: number;
  maxWindowItems?: number;
  maxRetainedCharacters?: number;
  softDeadlineAt?: number;
  onBytesRead?: (totalBytes: number) => void;
};

function emptyItem(): MutableItem {
  return { guid: null, link: null, mediaUrl: null, publishedAt: null, title: null };
}

function attributeValue(tag: SaxesTagNS, localName: string): string | null {
  for (const attribute of Object.values(tag.attributes)) {
    const typed = attribute as SaxesAttributeNS;
    if (typed.local.toLowerCase() === localName) {
      return typed.value;
    }
  }

  return null;
}

function detectXmlEncoding(prefix: Uint8Array): string {
  if (prefix.length >= 3 && prefix[0] === 0xef && prefix[1] === 0xbb && prefix[2] === 0xbf) {
    return "utf-8";
  }
  if (prefix.length >= 2 && prefix[0] === 0xff && prefix[1] === 0xfe) {
    return "utf-16le";
  }
  if (prefix.length >= 2 && prefix[0] === 0xfe && prefix[1] === 0xff) {
    return "utf-16be";
  }
  if (
    prefix.length >= 4 &&
    prefix[0] === 0x00 &&
    prefix[1] === 0x3c &&
    prefix[2] === 0x00 &&
    prefix[3] === 0x3f
  ) {
    return "utf-16be";
  }
  if (
    prefix.length >= 4 &&
    prefix[0] === 0x3c &&
    prefix[1] === 0x00 &&
    prefix[2] === 0x3f &&
    prefix[3] === 0x00
  ) {
    return "utf-16le";
  }

  const asciiPrefix = Array.from(prefix, (byte) => String.fromCharCode(byte)).join("");
  const declaration = asciiPrefix.match(
    /^\s*<\?xml\s+[^>]*encoding\s*=\s*["']\s*([^"']+?)\s*["']/i,
  );
  return declaration?.[1] ?? "utf-8";
}

function createDecoder(prefix: Uint8Array): TextDecoder {
  const requestedEncoding = detectXmlEncoding(prefix);

  try {
    return new TextDecoder(requestedEncoding, { fatal: true });
  } catch {
    throw new FeedPipelineError("unsupported_xml_encoding");
  }
}

function combineChunks(chunks: Uint8Array[], totalBytes: number): Uint8Array {
  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

export async function parseFeedByteStream(
  stream: ReadableStream<Uint8Array>,
  window: FeedWindow,
  maxBytes: number,
  options: ParseFeedOptions = {},
): Promise<FeedParseResult & { downloaded_bytes: number }> {
  const windowStart = Date.parse(window.start);
  const windowEnd = Date.parse(window.end);
  if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd) || windowStart > windowEnd) {
    throw new FeedPipelineError("xml_malformed");
  }

  const maxDepth = options.maxDepth ?? DEFAULT_MAX_XML_DEPTH;
  const maxFieldCharacters = options.maxFieldCharacters ?? DEFAULT_MAX_FIELD_CHARACTERS;
  const maxWindowItems = options.maxWindowItems ?? DEFAULT_MAX_WINDOW_ITEMS;
  const maxRetainedCharacters =
    options.maxRetainedCharacters ?? DEFAULT_MAX_RETAINED_CHARACTERS;
  const items: ParsedFeedItem[] = [];
  const rawWindowItems: Array<MutableItem & { normalizedPublishedAt: string }> = [];
  let parsedItemCount = 0;
  let depth = 0;
  let itemDepth: number | null = null;
  let currentItem: MutableItem | null = null;
  let capturedField: { field: CapturedField; depth: number } | null = null;
  let parserError: FeedPipelineError | null = null;
  let sawFeedRoot = false;
  let retainedCharacters = 0;

  const parser = new SaxesParser({ xmlns: true });

  const fail = (error: FeedPipelineError): never => {
    parserError = error;
    throw error;
  };

  const appendText = (text: string): void => {
    if (currentItem === null || capturedField === null || text.length === 0) {
      return;
    }
    const previous = currentItem[capturedField.field] ?? "";
    if (previous.length + text.length > maxFieldCharacters) {
      fail(new FeedPipelineError("xml_field_too_large"));
    }
    currentItem[capturedField.field] = previous + text;
  };

  parser.on("error", () => {
    fail(parserError ?? new FeedPipelineError("xml_malformed"));
  });
  const startCapture = (field: CapturedField): void => {
    capturedField = { field, depth };
    parser.on("text", appendText);
    parser.on("cdata", appendText);
  };

  const stopCapture = (): void => {
    capturedField = null;
    parser.off("text");
    parser.off("cdata");
  };

  parser.on("opentag", (tag: SaxesTagNS) => {
    depth += 1;
    if (depth > maxDepth) {
      fail(new FeedPipelineError("xml_depth_exceeded"));
    }

    const local = tag.local.toLowerCase();
    if (depth === 1 && (local === "rss" || local === "feed" || local === "rdf")) {
      sawFeedRoot = true;
    }

    if (currentItem === null && (local === "item" || local === "entry")) {
      currentItem = emptyItem();
      itemDepth = depth;
      return;
    }

    if (currentItem === null) {
      return;
    }

    if (local === "enclosure" || (tag.prefix.toLowerCase() === "media" && local === "content")) {
      currentItem.mediaUrl ??= attributeValue(tag, "url");
      return;
    }

    if (local === "link") {
      const href = attributeValue(tag, "href");
      const rel = attributeValue(tag, "rel")?.toLowerCase() ?? "alternate";
      if (href !== null && (rel === "alternate" || currentItem.link === null)) {
        currentItem.link = href;
        return;
      }
      startCapture("link");
      return;
    }

    const field: CapturedField | null =
      local === "guid" || local === "id"
        ? "guid"
        : local === "title"
          ? "title"
          : local === "pubdate" || local === "published" || local === "updated" || local === "date"
            ? "publishedAt"
            : null;
    if (field !== null) {
      startCapture(field);
    }
  });
  parser.on("closetag", (tag: SaxesTagNS) => {
    const local = tag.local.toLowerCase();
    if (capturedField?.depth === depth) {
      stopCapture();
    }

    if (
      currentItem !== null &&
      itemDepth === depth &&
      (local === "item" || local === "entry")
    ) {
      const finishedItem = currentItem;
      parsedItemCount += 1;
      const normalizedPublishedAt =
        finishedItem.publishedAt === null
          ? null
          : normalizePublishedAt(finishedItem.publishedAt);

      if (normalizedPublishedAt !== null) {
        const timestamp = Date.parse(normalizedPublishedAt);
        if (timestamp >= windowStart && timestamp <= windowEnd) {
          if (rawWindowItems.length >= maxWindowItems) {
            fail(new FeedPipelineError("too_many_window_items"));
          }
          retainedCharacters +=
            (finishedItem.guid?.length ?? 0) +
            (finishedItem.link?.length ?? 0) +
            (finishedItem.mediaUrl?.length ?? 0) +
            (finishedItem.publishedAt?.length ?? 0) +
            (finishedItem.title?.length ?? 0);
          if (retainedCharacters > maxRetainedCharacters) {
            fail(new FeedPipelineError("window_items_too_large"));
          }
          rawWindowItems.push({ ...finishedItem, normalizedPublishedAt });
        }
      }

      currentItem = null;
      itemDepth = null;
      stopCapture();
    }

    depth -= 1;
  });

  const reader = stream.getReader();
  const prefixChunks: Uint8Array[] = [];
  let prefixBytes = 0;
  let downloadedBytes = 0;
  let decoder: TextDecoder | null = null;
  let xmlEncoding = "utf-8";
  let aborted = options.abortSignal?.aborted ?? false;
  const abortReader = (): void => {
    aborted = true;
    void reader.cancel().catch(() => undefined);
  };
  options.abortSignal?.addEventListener("abort", abortReader, { once: true });

  const writeBytes = (chunk: Uint8Array): void => {
    if (decoder === null) {
      throw new FeedPipelineError("xml_malformed");
    }
    try {
      const text = decoder.decode(chunk, { stream: true });
      if (text !== "") {
        parser.write(text);
      }
    } catch (error) {
      if (error instanceof FeedPipelineError) {
        throw error;
      }
      throw new FeedPipelineError("xml_malformed");
    }
  };

  try {
    while (true) {
      if (aborted) {
        throw new FeedPipelineError("feed_total_timeout", { retryable: true });
      }
      if (options.softDeadlineAt !== undefined && Date.now() >= options.softDeadlineAt) {
        throw new FeedPipelineError("soft_deadline_exceeded", { retryable: true });
      }

      const { done, value } = await reader.read();
      if (aborted) {
        throw new FeedPipelineError("feed_total_timeout", { retryable: true });
      }
      if (done) {
        break;
      }

      downloadedBytes += value.byteLength;
      options.onBytesRead?.(downloadedBytes);
      if (downloadedBytes > maxBytes) {
        throw new FeedPipelineError("feed_too_large");
      }

      if (decoder === null) {
        const remainingPrefixBytes = ENCODING_SNIFF_BYTES - prefixBytes;
        if (value.byteLength <= remainingPrefixBytes) {
          prefixChunks.push(value);
          prefixBytes += value.byteLength;
          if (prefixBytes < ENCODING_SNIFF_BYTES) {
            continue;
          }
        } else {
          prefixChunks.push(value.subarray(0, remainingPrefixBytes));
          prefixBytes += remainingPrefixBytes;
        }

        const prefix = combineChunks(prefixChunks, prefixBytes);
        decoder = createDecoder(prefix);
        xmlEncoding = decoder.encoding;
        writeBytes(prefix);
        if (value.byteLength > remainingPrefixBytes) {
          writeBytes(value.subarray(remainingPrefixBytes));
        }
        continue;
      }

      writeBytes(value);
    }

    if (decoder === null) {
      const prefix = combineChunks(prefixChunks, prefixBytes);
      decoder = createDecoder(prefix);
      xmlEncoding = decoder.encoding;
      writeBytes(prefix);
    }

    const tail = decoder.decode();
    if (tail !== "") {
      parser.write(tail);
    }
    parser.close();
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof FeedPipelineError) {
      throw error;
    }
    throw new FeedPipelineError("xml_malformed");
  } finally {
    options.abortSignal?.removeEventListener("abort", abortReader);
    reader.releaseLock();
  }

  if (!sawFeedRoot) {
    throw new FeedPipelineError("rss_or_atom_root_missing");
  }

  for (const rawItem of rawWindowItems) {
    if (options.softDeadlineAt !== undefined && Date.now() >= options.softDeadlineAt) {
      throw new FeedPipelineError("soft_deadline_exceeded", { retryable: true });
    }
    const dedup = await createDedupKey({
      guid: rawItem.guid,
      link: rawItem.link,
      mediaUrl: rawItem.mediaUrl,
      title: rawItem.title,
      publishedAt: rawItem.normalizedPublishedAt,
    });
    if (dedup !== null) {
      items.push({
        guid: rawItem.guid?.trim() || null,
        link: rawItem.link?.trim() || null,
        media_url: rawItem.mediaUrl?.trim() || null,
        published_at: rawItem.normalizedPublishedAt,
        title: rawItem.title?.trim() || null,
        dedup_key: dedup.key,
        dedup_source: dedup.source,
      });
    }
  }

  items.sort((left, right) => left.published_at.localeCompare(right.published_at));

  return {
    downloaded_bytes: downloadedBytes,
    parsed_item_count: parsedItemCount,
    window_item_count: rawWindowItems.length,
    items,
    xml_encoding: xmlEncoding,
  };
}
