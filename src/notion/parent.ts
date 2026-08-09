import type { NotionClient, NotionResponse } from "./client";
import { notionJsonBody } from "./client";
import { sha256Hex } from "../rss/dedup";

type JsonRecord = Record<string, unknown>;

const SYNC_TIME_PATTERN =
  /内容同步时间：(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})（Asia\/Shanghai）/g;

export type ParentBlockErrorCode =
  | "parent_blocks_invalid_response"
  | "parent_sync_callout_ambiguous"
  | "parent_sync_callout_missing"
  | "parent_sync_callout_invalid"
  | "parent_sync_callout_read_failed"
  | "parent_sync_callout_update_failed";

export class ParentBlockError extends Error {
  readonly code: ParentBlockErrorCode;
  readonly retryable: boolean;
  readonly httpStatus: number | null;

  constructor(
    code: ParentBlockErrorCode,
    options: { retryable?: boolean; httpStatus?: number | null } = {},
  ) {
    super(code);
    this.name = "ParentBlockError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.httpStatus = options.httpStatus ?? null;
  }
}

export type ParentSyncBlock = {
  block_id: string;
  content_fingerprint: string;
  rich_text: JsonRecord[];
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responseFailure(
  response: NotionResponse,
  code: "parent_sync_callout_read_failed" | "parent_sync_callout_update_failed",
): ParentBlockError {
  return new ParentBlockError(code, {
    retryable:
      response.status === 0 ||
      response.status === 429 ||
      response.status === 529 ||
      response.status >= 500,
    httpStatus: response.status === 0 ? null : response.status,
  });
}

function richTextPlainText(part: JsonRecord): string {
  if (typeof part.plain_text === "string") {
    return part.plain_text;
  }
  if (part.type === "text" && isRecord(part.text) && typeof part.text.content === "string") {
    return part.text.content;
  }
  if (
    part.type === "equation" &&
    isRecord(part.equation) &&
    typeof part.equation.expression === "string"
  ) {
    return part.equation.expression;
  }
  return "";
}

function calloutRichText(value: unknown): JsonRecord[] | null {
  if (!isRecord(value) || value.object !== "block" || value.type !== "callout") {
    return null;
  }
  if (!isRecord(value.callout) || !Array.isArray(value.callout.rich_text)) {
    return null;
  }
  const parts: JsonRecord[] = [];
  for (const part of value.callout.rich_text) {
    if (!isRecord(part)) {
      return null;
    }
    parts.push(part);
  }
  return parts;
}

function findSyncTimestamp(text: string): { start: number; end: number } | null {
  const matches = [...text.matchAll(SYNC_TIME_PATTERN)];
  if (matches.length !== 1 || matches[0]?.index === undefined) {
    return null;
  }
  const timestamp = matches[0][1];
  if (timestamp === undefined) {
    return null;
  }
  const start = matches[0].index + "内容同步时间：".length;
  return { start, end: start + timestamp.length };
}

function toRichTextRequest(part: JsonRecord, content?: string): JsonRecord {
  const annotations = isRecord(part.annotations) ? part.annotations : undefined;
  if (part.type === "text" && isRecord(part.text) && typeof part.text.content === "string") {
    const link = part.text.link === null || isRecord(part.text.link) ? part.text.link : null;
    return {
      type: "text",
      text: { content: content ?? part.text.content, link },
      ...(annotations === undefined ? {} : { annotations }),
    };
  }
  if (part.type === "mention" && isRecord(part.mention)) {
    return {
      type: "mention",
      mention: part.mention,
      ...(annotations === undefined ? {} : { annotations }),
    };
  }
  if (part.type === "equation" && isRecord(part.equation)) {
    return {
      type: "equation",
      equation: part.equation,
      ...(annotations === undefined ? {} : { annotations }),
    };
  }
  throw new ParentBlockError("parent_sync_callout_invalid");
}

export function replaceSyncTimestamp(
  richText: JsonRecord[],
  timestamp: string,
): JsonRecord[] {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(timestamp)) {
    throw new ParentBlockError("parent_sync_callout_invalid");
  }
  const plainText = richText.map(richTextPlainText).join("");
  const range = findSyncTimestamp(plainText);
  if (range === null) {
    throw new ParentBlockError("parent_sync_callout_invalid");
  }

  let offset = 0;
  let replacedCharacters = 0;
  const replacement = Array.from(timestamp);
  const result = richText.map((part) => {
    const content = richTextPlainText(part);
    const partStart = offset;
    const partEnd = offset + content.length;
    offset = partEnd;
    if (partEnd <= range.start || partStart >= range.end) {
      return toRichTextRequest(part);
    }
    if (part.type !== "text" || !isRecord(part.text) || typeof part.text.content !== "string") {
      throw new ParentBlockError("parent_sync_callout_invalid");
    }
    const localStart = Math.max(0, range.start - partStart);
    const localEnd = Math.min(content.length, range.end - partStart);
    const count = localEnd - localStart;
    const next =
      content.slice(0, localStart) +
      replacement.slice(replacedCharacters, replacedCharacters + count).join("") +
      content.slice(localEnd);
    replacedCharacters += count;
    return toRichTextRequest(part, next);
  });

  if (replacedCharacters !== replacement.length) {
    throw new ParentBlockError("parent_sync_callout_invalid");
  }
  return result;
}

function parseSyncBlock(value: unknown): { block_id: string; rich_text: JsonRecord[] } | null {
  const richText = calloutRichText(value);
  if (richText === null || !isRecord(value) || typeof value.id !== "string") {
    return null;
  }
  const text = richText.map(richTextPlainText).join("");
  return findSyncTimestamp(text) === null ? null : { block_id: value.id, rich_text: richText };
}

async function withFingerprint(block: {
  block_id: string;
  rich_text: JsonRecord[];
}): Promise<ParentSyncBlock> {
  return {
    ...block,
    content_fingerprint: await sha256Hex(block.rich_text.map(richTextPlainText).join("")),
  };
}

export async function discoverParentSyncBlock(
  client: NotionClient,
  parentPageId: string,
): Promise<ParentSyncBlock> {
  const matches: Array<{ block_id: string; rich_text: JsonRecord[] }> = [];
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ page_size: "100" });
    if (cursor !== null) {
      query.set("start_cursor", cursor);
    }
    const response = await client.request(
      `/v1/blocks/${encodeURIComponent(parentPageId)}/children?${query.toString()}`,
      { method: "GET" },
      { retry: true },
    );
    if (!response.ok) {
      throw responseFailure(response, "parent_sync_callout_read_failed");
    }
    if (!isRecord(response.data) || !Array.isArray(response.data.results)) {
      throw new ParentBlockError("parent_blocks_invalid_response");
    }
    for (const value of response.data.results) {
      const block = parseSyncBlock(value);
      if (block !== null) {
        matches.push(block);
      }
    }
    if (response.data.has_more === true && typeof response.data.next_cursor === "string") {
      cursor = response.data.next_cursor;
    } else if (response.data.has_more === true) {
      throw new ParentBlockError("parent_blocks_invalid_response");
    } else {
      cursor = null;
    }
  } while (cursor !== null);

  if (matches.length === 0) {
    throw new ParentBlockError("parent_sync_callout_missing");
  }
  if (matches.length > 1) {
    throw new ParentBlockError("parent_sync_callout_ambiguous");
  }
  return withFingerprint(matches[0]!);
}

export async function cacheParentSyncBlock(
  database: D1Database,
  parentPageId: string,
  block: ParentSyncBlock,
): Promise<void> {
  await database
    .prepare(
      `INSERT INTO parent_blocks (
        parent_page_id, sync_time_block_id, last_verified_at, content_fingerprint
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(parent_page_id) DO UPDATE SET
        sync_time_block_id = excluded.sync_time_block_id,
        last_verified_at = excluded.last_verified_at,
        content_fingerprint = excluded.content_fingerprint`,
    )
    .bind(
      parentPageId,
      block.block_id,
      new Date().toISOString(),
      block.content_fingerprint,
    )
    .run();
}

type CachedParentBlock = { sync_time_block_id: string };

async function loadCachedBlock(
  client: NotionClient,
  database: D1Database,
  parentPageId: string,
): Promise<ParentSyncBlock | null> {
  const cached = await database
    .prepare("SELECT sync_time_block_id FROM parent_blocks WHERE parent_page_id = ?")
    .bind(parentPageId)
    .first<CachedParentBlock>();
  if (cached === null) {
    return null;
  }
  const response = await client.request(
    `/v1/blocks/${encodeURIComponent(cached.sync_time_block_id)}`,
    { method: "GET" },
    { retry: true },
  );
  if (!response.ok) {
    if (response.status === 404) {
      return null;
    }
    throw responseFailure(response, "parent_sync_callout_read_failed");
  }
  const parsed = parseSyncBlock(response.data);
  return parsed === null ? null : withFingerprint(parsed);
}

export async function updateParentSyncTime(
  client: NotionClient,
  database: D1Database,
  parentPageId: string,
  timestamp: string,
): Promise<string> {
  let block = await loadCachedBlock(client, database, parentPageId);
  if (block === null) {
    block = await discoverParentSyncBlock(client, parentPageId);
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const richText = replaceSyncTimestamp(block.rich_text, timestamp);
    const response = await client.request(
      `/v1/blocks/${encodeURIComponent(block.block_id)}`,
      {
        method: "PATCH",
        body: notionJsonBody({ callout: { rich_text: richText } }),
      },
      { retry: true },
    );
    if (!response.ok) {
      if (response.status === 404 && attempt === 0) {
        block = await discoverParentSyncBlock(client, parentPageId);
        continue;
      }
      throw responseFailure(response, "parent_sync_callout_update_failed");
    }
    const updated = parseSyncBlock(response.data);
    if (updated === null) {
      if (attempt === 0) {
        block = await discoverParentSyncBlock(client, parentPageId);
        continue;
      }
      throw new ParentBlockError("parent_sync_callout_invalid");
    }
    await cacheParentSyncBlock(database, parentPageId, await withFingerprint(updated));
    return block.block_id;
  }
  throw new ParentBlockError("parent_sync_callout_update_failed", { retryable: true });
}

export function formatShanghaiTimestamp(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((valuePart) => valuePart.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}:${part("second")}`;
}

export type ParentUpdateBatchResult = {
  failures: Array<{ parent_page_id: string; error: unknown }>;
  updated_count: number;
};

export async function updateParentPagesSequentially(
  parentPageIds: string[],
  updateOne: (parentPageId: string) => Promise<void>,
): Promise<ParentUpdateBatchResult> {
  const failures: Array<{ parent_page_id: string; error: unknown }> = [];
  let updatedCount = 0;
  for (const parentPageId of parentPageIds) {
    try {
      await updateOne(parentPageId);
      updatedCount += 1;
    } catch (error) {
      failures.push({ parent_page_id: parentPageId, error });
    }
  }
  return { failures, updated_count: updatedCount };
}
