import { SaxesParser, type SaxesAttributeNS, type SaxesTagNS } from "saxes";

import { createDedupKey, normalizePublishedAt, type DedupSource } from "./dedup";
import { FeedPipelineError } from "./errors";

const DEFAULT_MAX_XML_DEPTH = 64;
const DEFAULT_MAX_FIELD_CHARACTERS = 8_192;
const DEFAULT_MAX_WINDOW_ITEMS = 5_000;
const DEFAULT_MAX_RETAINED_CHARACTERS = 4 * 1024 * 1024;
const DEFAULT_MAX_DESCRIPTION_CHARACTERS = 2_000;
const DEFAULT_MAX_LIST_VALUES = 100;
const ENCODING_SNIFF_BYTES = 1_024;

type ScalarField =
  | "author"
  | "description"
  | "duration"
  | "episode"
  | "episodeType"
  | "explicit"
  | "guid"
  | "imageUrl"
  | "link"
  | "mediaLength"
  | "mediaType"
  | "mediaUrl"
  | "publishedAt"
  | "season"
  | "title"
  | "transcriptUrl";
type CapturedField = ScalarField | "category" | "keywords";

type MutableItem = Record<ScalarField, string | null> & {
  categories: string[];
  descriptionPriority: number;
  descriptionTruncated: boolean;
  keywords: string[];
};

export type ParsedFeedItem = {
  author: string | null;
  description: string | null;
  description_truncated: boolean;
  duration: string | null;
  episode: string | null;
  episode_type: string | null;
  explicit: string | null;
  guid: string | null;
  image_url: string | null;
  keywords: string[];
  link: string | null;
  media_length: string | null;
  media_type: string | null;
  media_url: string | null;
  published_at: string;
  rss_categories: string[];
  season: string | null;
  title: string | null;
  transcript_url: string | null;
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
  maxDescriptionCharacters?: number;
  maxWindowItems?: number;
  maxRetainedCharacters?: number;
  softDeadlineAt?: number;
  onBytesRead?: (totalBytes: number) => void;
};

function emptyItem(): MutableItem {
  return {
    author: null,
    categories: [],
    description: null,
    descriptionPriority: -1,
    descriptionTruncated: false,
    duration: null,
    episode: null,
    episodeType: null,
    explicit: null,
    guid: null,
    imageUrl: null,
    keywords: [],
    link: null,
    mediaLength: null,
    mediaType: null,
    mediaUrl: null,
    publishedAt: null,
    season: null,
    title: null,
    transcriptUrl: null,
  };
}

function addUniqueValue(values: string[], value: string): void {
  const normalized = value.trim();
  if (
    normalized !== "" &&
    values.length < DEFAULT_MAX_LIST_VALUES &&
    !values.includes(normalized)
  ) {
    values.push(normalized);
  }
}

function retainedItemCharacters(item: MutableItem): number {
  let total = item.categories.join("").length + item.keywords.join("").length;
  for (const [key, value] of Object.entries(item)) {
    if (
      key !== "categories" &&
      key !== "keywords" &&
      key !== "descriptionPriority" &&
      key !== "descriptionTruncated" &&
      typeof value === "string"
    ) {
      total += value.length;
    }
  }
  return total;
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
  const maxDescriptionCharacters =
    options.maxDescriptionCharacters ?? DEFAULT_MAX_DESCRIPTION_CHARACTERS;
  const maxWindowItems = options.maxWindowItems ?? DEFAULT_MAX_WINDOW_ITEMS;
  const maxRetainedCharacters =
    options.maxRetainedCharacters ?? DEFAULT_MAX_RETAINED_CHARACTERS;
  const items: ParsedFeedItem[] = [];
  const rawWindowItems: Array<MutableItem & { normalizedPublishedAt: string }> = [];
  let parsedItemCount = 0;
  let depth = 0;
  let itemDepth: number | null = null;
  let currentItem: MutableItem | null = null;
  let capturedField: {
    field: CapturedField;
    depth: number;
    priority: number;
    text: string;
    truncated: boolean;
  } | null = null;
  let parserError: FeedPipelineError | null = null;
  let sawFeedRoot = false;
  let retainedCharacters = 0;

  const parser = new SaxesParser({ xmlns: true });

  const fail = (error: FeedPipelineError): never => {
    parserError = error;
    throw error;
  };

  const boundedAttributeValue = (tag: SaxesTagNS, localName: string): string | null => {
    const value = attributeValue(tag, localName);
    if (value !== null && value.length > maxFieldCharacters) {
      fail(new FeedPipelineError("xml_field_too_large"));
    }
    return value;
  };

  const appendText = (text: string): void => {
    if (currentItem === null || capturedField === null || text.length === 0) {
      return;
    }
    const limit =
      capturedField.field === "description"
        ? maxDescriptionCharacters
        : maxFieldCharacters;
    const remaining = limit - capturedField.text.length;
    if (remaining <= 0) {
      if (capturedField.field === "description") {
        capturedField.truncated = true;
        return;
      }
      fail(new FeedPipelineError("xml_field_too_large"));
    }
    if (text.length > remaining) {
      if (capturedField.field !== "description") {
        fail(new FeedPipelineError("xml_field_too_large"));
      }
      capturedField.text += text.slice(0, remaining);
      capturedField.truncated = true;
      return;
    }
    capturedField.text += text;
  };

  parser.on("error", () => {
    fail(parserError ?? new FeedPipelineError("xml_malformed"));
  });
  const startCapture = (field: CapturedField, priority = 0): void => {
    if (capturedField !== null) {
      return;
    }
    capturedField = { field, depth, priority, text: "", truncated: false };
    parser.on("text", appendText);
    parser.on("cdata", appendText);
  };

  const stopCapture = (): void => {
    if (currentItem !== null && capturedField !== null) {
      const value = capturedField.text.trim();
      if (capturedField.field === "category") {
        addUniqueValue(currentItem.categories, value);
      } else if (capturedField.field === "keywords") {
        for (const keyword of value.split(/[,，]/)) {
          addUniqueValue(currentItem.keywords, keyword);
        }
      } else if (capturedField.field === "description") {
        if (value !== "" && capturedField.priority > currentItem.descriptionPriority) {
          currentItem.description = value;
          currentItem.descriptionPriority = capturedField.priority;
          currentItem.descriptionTruncated = capturedField.truncated;
        }
      } else if (value !== "" && currentItem[capturedField.field] === null) {
        currentItem[capturedField.field] = value;
      }
    }
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

    const prefix = tag.prefix.toLowerCase();
    if (local === "enclosure" || (prefix === "media" && local === "content")) {
      currentItem.mediaUrl ??= boundedAttributeValue(tag, "url");
      currentItem.mediaType ??= boundedAttributeValue(tag, "type");
      currentItem.mediaLength ??=
        boundedAttributeValue(tag, "length") ?? boundedAttributeValue(tag, "filesize");
      return;
    }

    if (local === "transcript" && prefix === "podcast") {
      currentItem.transcriptUrl ??= boundedAttributeValue(tag, "url");
      return;
    }

    if (local === "image" && prefix === "itunes") {
      currentItem.imageUrl ??= boundedAttributeValue(tag, "href");
      return;
    }

    if (local === "thumbnail" && prefix === "media") {
      currentItem.imageUrl ??= boundedAttributeValue(tag, "url");
      return;
    }

    if (local === "category") {
      const attributeCategory =
        boundedAttributeValue(tag, "text") ?? boundedAttributeValue(tag, "term");
      if (attributeCategory !== null) {
        addUniqueValue(currentItem.categories, attributeCategory);
        return;
      }
      startCapture("category");
      return;
    }

    if (local === "link") {
      const href = boundedAttributeValue(tag, "href");
      const rel = boundedAttributeValue(tag, "rel")?.toLowerCase() ?? "alternate";
      if (href !== null && rel === "enclosure") {
        currentItem.mediaUrl ??= href;
        currentItem.mediaType ??= boundedAttributeValue(tag, "type");
        currentItem.mediaLength ??= boundedAttributeValue(tag, "length");
        return;
      }
      if (href !== null && (rel === "alternate" || currentItem.link === null)) {
        currentItem.link ??= href;
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
            : local === "author" || local === "creator"
              ? "author"
              : local === "duration"
                ? "duration"
                : local === "season"
                  ? "season"
                  : local === "episode"
                    ? "episode"
                    : local === "episodetype"
                      ? "episodeType"
                      : local === "explicit"
                        ? "explicit"
                        : local === "keywords"
                          ? "keywords"
                          : local === "summary" || local === "subtitle"
                            ? "description"
                            : local === "description"
                              ? "description"
                              : local === "encoded" && prefix === "content"
                                ? "description"
            : null;
    if (field !== null) {
      const descriptionPriority =
        local === "encoded" ? 4 : local === "description" ? 3 : local === "summary" ? 2 : 1;
      startCapture(field, field === "description" ? descriptionPriority : 0);
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
          retainedCharacters += retainedItemCharacters(finishedItem);
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
        author: rawItem.author?.trim() || null,
        description: rawItem.description?.trim() || null,
        description_truncated: rawItem.descriptionTruncated,
        duration: rawItem.duration?.trim() || null,
        episode: rawItem.episode?.trim() || null,
        episode_type: rawItem.episodeType?.trim() || null,
        explicit: rawItem.explicit?.trim() || null,
        guid: rawItem.guid?.trim() || null,
        image_url: rawItem.imageUrl?.trim() || null,
        keywords: rawItem.keywords,
        link: rawItem.link?.trim() || null,
        media_length: rawItem.mediaLength?.trim() || null,
        media_type: rawItem.mediaType?.trim() || null,
        media_url: rawItem.mediaUrl?.trim() || null,
        published_at: rawItem.normalizedPublishedAt,
        rss_categories: rawItem.categories,
        season: rawItem.season?.trim() || null,
        title: rawItem.title?.trim() || null,
        transcript_url: rawItem.transcriptUrl?.trim() || null,
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
