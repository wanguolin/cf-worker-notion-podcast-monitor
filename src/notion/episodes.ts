import type { ParsedFeedItem } from "../rss/parser";
import { formatShanghaiTimestamp } from "./parent";
import {
  type NotionClient,
  type NotionResponse,
  notionJsonBody,
} from "./client";
import {
  queryEpisodeMatch,
  resolveEpisodeDedupSchema,
  type EpisodeDedupSchema,
} from "./dedup";
import {
  assertNotionRichText,
  assertNotionUrl,
  truncateNotionRichText,
} from "./payload";

type JsonRecord = Record<string, unknown>;
type WritablePropertyType =
  | "checkbox"
  | "date"
  | "files"
  | "multi_select"
  | "number"
  | "rich_text"
  | "select"
  | "title"
  | "url";

type EpisodeSemantic =
  | "author"
  | "cover"
  | "dedup_key"
  | "dedup_source"
  | "description"
  | "description_truncated"
  | "duration"
  | "episode"
  | "episode_type"
  | "explicit"
  | "guid"
  | "keywords"
  | "language"
  | "media_download"
  | "media_length"
  | "media_type"
  | "original_link"
  | "podcast_categories"
  | "podcast_name"
  | "published_at"
  | "rss_categories"
  | "rss_source"
  | "season"
  | "shanghai_time"
  | "title"
  | "transcript";

type EpisodeProperty = {
  name: string;
  option_names?: string[];
  type: WritablePropertyType;
};

export type EpisodeWriteSchema = {
  dedup: EpisodeDedupSchema;
  properties: Partial<Record<EpisodeSemantic, EpisodeProperty>>;
};

export type EpisodePropertyContext = {
  categories: string[];
  feedUrl: string;
  language: string | null;
  podcastName: string;
};

export type EpisodePropertiesResult = {
  description_truncated: boolean;
  properties: JsonRecord;
  skipped_categories: string[];
};

export type EpisodeWriteResult = {
  already_exists: number;
  dedup_failed: number;
  description_truncated: number;
  notion_write_count: number;
  skipped_categories: string[];
  will_write: number;
};

export type EpisodeWriterInput = EpisodePropertyContext & {
  candidates: ParsedFeedItem[];
  client: NotionClient;
  dataSourceId: string;
  database: D1Database;
  feedUrlHash: string;
  runId: string;
  taskId: string;
  windowItemCount: number;
};

export type EpisodeWriteErrorCode =
  | "episode_create_failed"
  | "episode_create_invalid_response"
  | "episode_create_uncertain"
  | "episode_create_verification_failed"
  | "episode_schema_invalid"
  | "episode_schema_write_property_unsupported";

export class EpisodeWriteError extends Error {
  readonly code: EpisodeWriteErrorCode;
  readonly retryable: boolean;
  readonly httpStatus: number | null;

  constructor(
    code: EpisodeWriteErrorCode,
    options: { retryable?: boolean; httpStatus?: number | null } = {},
  ) {
    super(code);
    this.name = "EpisodeWriteError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.httpStatus = options.httpStatus ?? null;
  }
}

const PROPERTY_ALIASES: Record<EpisodeSemantic, string[]> = {
  author: ["作者", "单集作者", "Author"],
  cover: ["封面", "单集封面", "Cover", "Image"],
  dedup_key: ["排重键", "去重键", "Dedup Key"],
  dedup_source: ["排重来源", "Dedup Source"],
  description: ["简介", "单集简介", "Description", "Summary"],
  description_truncated: ["简介已截断", "简介截断", "Description Truncated"],
  duration: ["时长", "单集时长", "Duration"],
  episode: ["集", "集数", "单集序号", "Episode"],
  episode_type: ["节目类型", "单集类型", "Episode Type"],
  explicit: ["显式内容", "限制级内容", "Explicit"],
  guid: ["GUID", "Guid"],
  keywords: ["关键词", "Keywords"],
  language: ["语言", "Language"],
  media_download: ["媒体下载", "媒体链接", "Media Download", "Enclosure"],
  media_length: ["媒体长度", "媒体大小", "Media Length"],
  media_type: ["媒体类型", "Media Type", "MIME Type"],
  original_link: ["原始链接", "单集链接", "Original Link"],
  podcast_categories: ["分类", "播客分类", "清单分类", "Podcast Categories"],
  podcast_name: ["播客名称", "Podcast Name"],
  published_at: ["发布日期", "发布时间", "Published At", "Publication Date"],
  rss_categories: ["RSS分类", "RSS 分类", "RSS Categories"],
  rss_source: ["RSS源", "RSS 来源", "RSS Source"],
  season: ["季", "季数", "Season"],
  shanghai_time: ["上海时间", "Asia/Shanghai", "Shanghai Time"],
  title: ["单集标题", "标题", "Episode Title", "Name"],
  transcript: ["逐字稿", "逐字稿链接", "Transcript"],
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePropertyName(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[\s_-]+/g, "");
}

function isWritablePropertyType(value: unknown): value is WritablePropertyType {
  return [
    "checkbox",
    "date",
    "files",
    "multi_select",
    "number",
    "rich_text",
    "select",
    "title",
    "url",
  ].includes(String(value));
}

function schemaProperty(
  name: string,
  property: JsonRecord,
  type: WritablePropertyType,
): EpisodeProperty {
  if (
    type !== "multi_select" ||
    !isRecord(property.multi_select) ||
    !Array.isArray(property.multi_select.options)
  ) {
    return { name, type };
  }
  const optionNames = property.multi_select.options.flatMap((option) =>
    isRecord(option) && typeof option.name === "string" ? [option.name] : [],
  );
  return { name, type, option_names: optionNames };
}

export function resolveEpisodeWriteSchema(data: unknown): EpisodeWriteSchema {
  if (!isRecord(data) || !isRecord(data.properties)) {
    throw new EpisodeWriteError("episode_schema_invalid");
  }
  const dedup = resolveEpisodeDedupSchema(data);
  const aliasToSemantic = new Map<string, EpisodeSemantic>();
  for (const [semantic, aliases] of Object.entries(PROPERTY_ALIASES) as Array<
    [EpisodeSemantic, string[]]
  >) {
    for (const alias of aliases) {
      aliasToSemantic.set(normalizePropertyName(alias), semantic);
    }
  }

  const properties: Partial<Record<EpisodeSemantic, EpisodeProperty>> = {};
  for (const [name, property] of Object.entries(data.properties)) {
    if (!isRecord(property) || !isWritablePropertyType(property.type)) {
      continue;
    }
    const semantic =
      property.type === "title"
        ? "title"
        : aliasToSemantic.get(normalizePropertyName(name));
    if (semantic !== undefined && properties[semantic] === undefined) {
      properties[semantic] = schemaProperty(name, property, property.type);
    }
  }

  const podcastProperty = data.properties[dedup.podcastName.name];
  const dedupProperty = data.properties[dedup.dedupKey.name];
  if (
    !isRecord(podcastProperty) ||
    !isWritablePropertyType(podcastProperty.type) ||
    !isRecord(dedupProperty) ||
    !isWritablePropertyType(dedupProperty.type)
  ) {
    throw new EpisodeWriteError("episode_schema_write_property_unsupported");
  }
  properties.podcast_name = {
    name: dedup.podcastName.name,
    type: podcastProperty.type,
  };
  properties.dedup_key = { name: dedup.dedupKey.name, type: dedupProperty.type };
  if (properties.title === undefined) {
    throw new EpisodeWriteError("episode_schema_invalid");
  }
  return { dedup, properties };
}

function selectName(value: string): string {
  return Array.from(value).slice(0, 100).join("");
}

function propertyValue(
  property: EpisodeProperty,
  value: string | number | boolean | string[],
): JsonRecord | null {
  if (property.type === "checkbox") {
    const checked =
      typeof value === "boolean"
        ? value
        : /^(?:1|true|yes|explicit|是)$/i.test(String(value).trim());
    return { checkbox: checked };
  }
  if (property.type === "number") {
    const number = typeof value === "number" ? value : Number(String(value).replace(/,/g, ""));
    return Number.isFinite(number) ? { number } : null;
  }
  if (property.type === "date") {
    const raw = Array.isArray(value) ? value[0] : String(value);
    const timestamp = Date.parse(raw ?? "");
    return Number.isFinite(timestamp) ? { date: { start: new Date(timestamp).toISOString() } } : null;
  }
  if (property.type === "url") {
    const raw = Array.isArray(value) ? value[0] : String(value);
    return raw === undefined ? null : { url: assertNotionUrl(raw) };
  }
  if (property.type === "files") {
    const raw = Array.isArray(value) ? value[0] : String(value);
    const url = raw === undefined ? null : assertNotionUrl(raw);
    return url === null
      ? null
      : { files: [{ name: "external", type: "external", external: { url } }] };
  }
  const values = Array.isArray(value) ? value.filter(Boolean) : [String(value)];
  if (values.length === 0) {
    return null;
  }
  if (property.type === "multi_select") {
    return {
      multi_select: [...new Set(values)].slice(0, 100).map((name) => ({ name: selectName(name) })),
    };
  }
  if (property.type === "select") {
    return { select: { name: selectName(values[0]!) } };
  }
  const text = assertNotionRichText(values.join(", "));
  const richText = [{ type: "text", text: { content: text } }];
  return property.type === "title" ? { title: richText } : { rich_text: richText };
}

function addProperty(
  output: JsonRecord,
  schema: EpisodeWriteSchema,
  semantic: EpisodeSemantic,
  value: string | number | boolean | string[] | null | undefined,
): void {
  const property = schema.properties[semantic];
  if (property === undefined || value === null || value === undefined || value === "") {
    return;
  }
  const propertyPayload = propertyValue(property, value);
  if (propertyPayload !== null) {
    output[property.name] = propertyPayload;
  }
}

export function buildEpisodePageProperties(
  schema: EpisodeWriteSchema,
  item: ParsedFeedItem,
  context: EpisodePropertyContext,
): EpisodePropertiesResult {
  const properties: JsonRecord = {};
  const description = truncateNotionRichText(item.description ?? "");
  const descriptionTruncated = Boolean(item.description_truncated) || description.truncated;
  const shanghaiTime = formatShanghaiTimestamp(new Date(item.published_at));
  const categoryProperty = schema.properties.podcast_categories;
  const categorySelection = filterEpisodeCategories(
    context.categories,
    categoryProperty?.type === "multi_select"
      ? categoryProperty.option_names ?? []
      : [],
  );

  addProperty(properties, schema, "title", item.title);
  addProperty(properties, schema, "podcast_name", context.podcastName);
  addProperty(properties, schema, "guid", item.guid);
  addProperty(properties, schema, "dedup_key", item.dedup_key);
  addProperty(properties, schema, "original_link", item.link);
  addProperty(properties, schema, "media_download", item.media_url);
  addProperty(properties, schema, "rss_source", context.feedUrl);
  addProperty(properties, schema, "description", description.value);
  addProperty(properties, schema, "published_at", item.published_at);
  addProperty(
    properties,
    schema,
    "shanghai_time",
    schema.properties.shanghai_time?.type === "date" ? item.published_at : shanghaiTime,
  );
  addProperty(properties, schema, "author", item.author);
  addProperty(properties, schema, "duration", item.duration);
  addProperty(properties, schema, "season", item.season);
  addProperty(properties, schema, "episode", item.episode);
  addProperty(properties, schema, "episode_type", item.episode_type);
  addProperty(properties, schema, "explicit", item.explicit);
  addProperty(properties, schema, "rss_categories", item.rss_categories);
  addProperty(properties, schema, "keywords", item.keywords);
  addProperty(properties, schema, "cover", item.image_url);
  addProperty(properties, schema, "transcript", item.transcript_url);
  addProperty(properties, schema, "media_type", item.media_type);
  addProperty(properties, schema, "media_length", item.media_length);
  addProperty(properties, schema, "language", context.language);
  addProperty(properties, schema, "podcast_categories", categorySelection.accepted);
  addProperty(properties, schema, "dedup_source", item.dedup_source);
  addProperty(properties, schema, "description_truncated", descriptionTruncated);

  return {
    properties,
    description_truncated: descriptionTruncated,
    skipped_categories: categorySelection.skipped,
  };
}

const ALLOWED_EPISODE_CATEGORIES = new Set([
  "美股投资",
  "宏观经济金融",
  "大科技与AI",
]);

export function filterEpisodeCategories(
  values: string[],
  existingOptions: string[],
): { accepted: string[]; skipped: string[] } {
  const accepted: string[] = [];
  const skipped: string[] = [];
  const existing = new Set(existingOptions);
  for (const rawValue of values) {
    const value = rawValue.trim();
    if (value === "" || accepted.includes(value) || skipped.includes(value)) {
      continue;
    }
    if (ALLOWED_EPISODE_CATEGORIES.has(value) && existing.has(value)) {
      accepted.push(value);
    } else {
      skipped.push(value);
    }
  }
  return { accepted, skipped };
}

async function loadWriteSchema(
  client: NotionClient,
  dataSourceId: string,
): Promise<EpisodeWriteSchema> {
  const response = await client.request(
    `/v1/data_sources/${encodeURIComponent(dataSourceId)}`,
    { method: "GET" },
    { retry: true },
  );
  if (!response.ok) {
    throw new EpisodeWriteError("episode_schema_invalid", {
      retryable: response.status === 0 || response.status >= 500,
      httpStatus: response.status === 0 ? null : response.status,
    });
  }
  return resolveEpisodeWriteSchema(response.data);
}

type LedgerRow = { notion_page_id: string | null; status: string };

async function claimLedger(
  database: D1Database,
  podcastName: string,
  dedupKey: string,
  feedUrlHash: string,
  runId: string,
  taskId: string,
): Promise<LedgerRow> {
  const now = new Date().toISOString();
  await database
    .prepare(
      `INSERT INTO episode_writes (
        podcast_name, dedup_key, feed_url_hash, status, first_seen_at, last_attempt_at,
        run_id, task_id
      ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)
      ON CONFLICT(podcast_name, dedup_key) DO NOTHING`,
    )
    .bind(podcastName, dedupKey, feedUrlHash, now, now, runId, taskId)
    .run();
  const row = await database
    .prepare(
      `SELECT status, notion_page_id FROM episode_writes
      WHERE podcast_name = ? AND dedup_key = ?`,
    )
    .bind(podcastName, dedupKey)
    .first<LedgerRow>();
  if (row === null) {
    throw new EpisodeWriteError("episode_create_failed", { retryable: true });
  }
  if (row.status !== "written") {
    await database
      .prepare(
        `UPDATE episode_writes SET run_id = ?, task_id = ?, feed_url_hash = ?
        WHERE podcast_name = ? AND dedup_key = ? AND status <> 'written'`,
      )
      .bind(runId, taskId, feedUrlHash, podcastName, dedupKey)
      .run();
  }
  return row;
}

async function clearLedgerOwnership(
  database: D1Database,
  podcastName: string,
  dedupKey: string,
): Promise<void> {
  await database
    .prepare(
      `UPDATE episode_writes SET run_id = NULL, task_id = NULL
      WHERE podcast_name = ? AND dedup_key = ?`,
    )
    .bind(podcastName, dedupKey)
    .run();
}

async function recoverOwnedLedger(
  database: D1Database,
  podcastName: string,
  dedupKey: string,
  taskId: string,
  notionPageId: string,
): Promise<void> {
  await database
    .prepare(
      `UPDATE episode_writes
      SET status = 'written', notion_page_id = ?, last_attempt_at = ?
      WHERE podcast_name = ? AND dedup_key = ? AND task_id = ?
        AND status IN ('pending', 'uncertain')`,
    )
    .bind(notionPageId, new Date().toISOString(), podcastName, dedupKey, taskId)
    .run();
}

async function hasRecoverableOwnedLedger(
  database: D1Database,
  podcastName: string,
  dedupKey: string,
  taskId: string,
): Promise<boolean> {
  const row = await database
    .prepare(
      `SELECT status FROM episode_writes
      WHERE podcast_name = ? AND dedup_key = ? AND task_id = ?
        AND status IN ('pending', 'uncertain')`,
    )
    .bind(podcastName, dedupKey, taskId)
    .first<{ status: string }>();
  return row !== null;
}

async function verifyCreatedPage(
  client: NotionClient,
  notionPageId: string,
  expectedProperties: JsonRecord,
): Promise<void> {
  const response = await client.request(
    `/v1/pages/${encodeURIComponent(notionPageId)}`,
    { method: "GET" },
    { retry: true },
  );
  if (!response.ok) {
    throw new EpisodeWriteError("episode_create_verification_failed", {
      retryable: response.status === 0 || response.status >= 500,
      httpStatus: response.status === 0 ? null : response.status,
    });
  }
  const page = response.data;
  if (
    !isRecord(page) ||
    page.object !== "page" ||
    page.id !== notionPageId ||
    !isRecord(page.properties)
  ) {
    throw new EpisodeWriteError("episode_create_verification_failed", { retryable: true });
  }
  const returnedProperties = page.properties;
  if (!Object.keys(expectedProperties).every((name) => name in returnedProperties)) {
    throw new EpisodeWriteError("episode_create_verification_failed", { retryable: true });
  }
}

async function takeLedgerOwnership(
  database: D1Database,
  podcastName: string,
  dedupKey: string,
  feedUrlHash: string,
  runId: string,
  taskId: string,
): Promise<void> {
  await database
    .prepare(
      `UPDATE episode_writes
      SET status = 'pending', notion_page_id = NULL, feed_url_hash = ?,
          run_id = ?, task_id = ?, last_attempt_at = ?
      WHERE podcast_name = ? AND dedup_key = ?`,
    )
    .bind(
      feedUrlHash,
      runId,
      taskId,
      new Date().toISOString(),
      podcastName,
      dedupKey,
    )
    .run();
}

async function updateLedger(
  database: D1Database,
  podcastName: string,
  dedupKey: string,
  status: "pending" | "written" | "uncertain" | "failed",
  notionPageId: string | null,
  incrementAttempt = false,
): Promise<void> {
  await database
    .prepare(
      `UPDATE episode_writes
      SET status = ?,
          notion_page_id = COALESCE(?, notion_page_id),
          last_attempt_at = ?,
          attempt_count = attempt_count + ?
      WHERE podcast_name = ? AND dedup_key = ?`,
    )
    .bind(
      status,
      notionPageId,
      new Date().toISOString(),
      incrementAttempt ? 1 : 0,
      podcastName,
      dedupKey,
    )
    .run();
}

function pageId(response: NotionResponse): string | null {
  return isRecord(response.data) && response.data.object === "page" && typeof response.data.id === "string"
    ? response.data.id
    : null;
}

function responseIsUncertain(response: NotionResponse): boolean {
  return response.status === 0 || response.status >= 500;
}

export async function createEpisodeWithUncertainRecheck(input: {
  client: NotionClient;
  dataSourceId: string;
  database: D1Database;
  dedupSchema: EpisodeDedupSchema;
  podcastName: string;
  dedupKey: string;
  properties: JsonRecord;
}): Promise<string> {
  for (let createAttempt = 0; createAttempt < 2; createAttempt += 1) {
    await updateLedger(
      input.database,
      input.podcastName,
      input.dedupKey,
      "pending",
      null,
      true,
    );
    const response = await input.client.request(
      "/v1/pages",
      {
        method: "POST",
        body: notionJsonBody({
          parent: { type: "data_source_id", data_source_id: input.dataSourceId },
          properties: input.properties,
        }),
      },
      { retry: "rate_limit" },
    );
    if (response.ok) {
      const notionPageId = pageId(response);
      if (notionPageId !== null) {
        try {
          await verifyCreatedPage(input.client, notionPageId, input.properties);
        } catch (error) {
          await updateLedger(
            input.database,
            input.podcastName,
            input.dedupKey,
            "uncertain",
            notionPageId,
          );
          throw error;
        }
        await updateLedger(
          input.database,
          input.podcastName,
          input.dedupKey,
          "written",
          notionPageId,
        );
        return notionPageId;
      }
    } else if (!responseIsUncertain(response)) {
      await updateLedger(
        input.database,
        input.podcastName,
        input.dedupKey,
        "failed",
        null,
      );
      throw new EpisodeWriteError("episode_create_failed", {
        retryable: response.status === 429 || response.status === 529,
        httpStatus: response.status,
      });
    }

    await updateLedger(
      input.database,
      input.podcastName,
      input.dedupKey,
      "uncertain",
      null,
    );
    const recoveredPageId = await queryEpisodeMatch(
      input.client,
      input.dataSourceId,
      input.dedupSchema,
      input.podcastName,
      input.dedupKey,
    );
    if (recoveredPageId !== null) {
      await verifyCreatedPage(input.client, recoveredPageId, input.properties);
      await updateLedger(
        input.database,
        input.podcastName,
        input.dedupKey,
        "written",
        recoveredPageId,
      );
      return recoveredPageId;
    }
  }
  throw new EpisodeWriteError("episode_create_uncertain", { retryable: true });
}

export async function writeEpisodes(input: EpisodeWriterInput): Promise<EpisodeWriteResult> {
  const schema = await loadWriteSchema(input.client, input.dataSourceId);
  let dedupFailed = Math.max(0, input.windowItemCount - input.candidates.length);
  const unique: ParsedFeedItem[] = [];
  const seen = new Set<string>();
  for (const candidate of input.candidates) {
    if (seen.has(candidate.dedup_key)) {
      dedupFailed += 1;
    } else {
      seen.add(candidate.dedup_key);
      unique.push(candidate);
    }
  }

  const missing: ParsedFeedItem[] = [];
  let alreadyExists = 0;
  for (const candidate of unique) {
    const match = await queryEpisodeMatch(
      input.client,
      input.dataSourceId,
      schema.dedup,
      input.podcastName,
      candidate.dedup_key,
    );
    if (match === null) {
      missing.push(candidate);
    } else {
      if (
        await hasRecoverableOwnedLedger(
          input.database,
          input.podcastName,
          candidate.dedup_key,
          input.taskId,
        )
      ) {
        const expected = buildEpisodePageProperties(schema, candidate, input);
        await verifyCreatedPage(input.client, match, expected.properties);
      }
      await recoverOwnedLedger(
        input.database,
        input.podcastName,
        candidate.dedup_key,
        input.taskId,
        match,
      );
      alreadyExists += 1;
    }
  }

  let notionWriteCount = 0;
  let descriptionTruncated = 0;
  const skippedCategories = new Set<string>();
  for (const candidate of missing) {
    await claimLedger(
      input.database,
      input.podcastName,
      candidate.dedup_key,
      input.feedUrlHash,
      input.runId,
      input.taskId,
    );
    const rechecked = await queryEpisodeMatch(
      input.client,
      input.dataSourceId,
      schema.dedup,
      input.podcastName,
      candidate.dedup_key,
    );
    if (rechecked !== null) {
      await updateLedger(
        input.database,
        input.podcastName,
        candidate.dedup_key,
        "written",
        rechecked,
      );
      await clearLedgerOwnership(input.database, input.podcastName, candidate.dedup_key);
      alreadyExists += 1;
      continue;
    }

    await takeLedgerOwnership(
      input.database,
      input.podcastName,
      candidate.dedup_key,
      input.feedUrlHash,
      input.runId,
      input.taskId,
    );

    const built = buildEpisodePageProperties(schema, candidate, input);
    for (const category of built.skipped_categories) {
      skippedCategories.add(category);
    }
    await createEpisodeWithUncertainRecheck({
      client: input.client,
      dataSourceId: input.dataSourceId,
      database: input.database,
      dedupSchema: schema.dedup,
      podcastName: input.podcastName,
      dedupKey: candidate.dedup_key,
      properties: built.properties,
    });
    notionWriteCount += 1;
    descriptionTruncated += built.description_truncated ? 1 : 0;
  }

  return {
    already_exists: alreadyExists,
    dedup_failed: dedupFailed,
    description_truncated: descriptionTruncated,
    notion_write_count: notionWriteCount,
    skipped_categories: [...skippedCategories].sort(),
    will_write: missing.length,
  };
}

export async function countTaskEpisodeWrites(
  database: D1Database,
  taskId: string,
): Promise<number> {
  const row = await database
    .prepare(
      `SELECT COUNT(*) AS count FROM episode_writes
      WHERE task_id = ? AND status = 'written'`,
    )
    .bind(taskId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}
