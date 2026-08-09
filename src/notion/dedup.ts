import { type NotionClient, notionJsonBody } from "./client";
import { assertNotionRichText } from "./payload";
import type { ParsedFeedItem } from "../rss/parser";

type JsonRecord = Record<string, unknown>;
type TextFilterType = "rich_text" | "title" | "url" | "select" | "formula";

export type EpisodeDedupSchema = {
  dedupKey: { name: string; type: TextFilterType };
  podcastName: { name: string; type: TextFilterType };
};

export type DryRunDiff = {
  will_write: number;
  already_exists: number;
  dedup_failed: number;
};

export type DedupErrorCode =
  | "episode_schema_invalid"
  | "episode_schema_dedup_key_missing"
  | "episode_schema_dedup_key_ambiguous"
  | "episode_schema_podcast_name_missing"
  | "episode_schema_podcast_name_ambiguous"
  | "notion_dedup_invalid_response"
  | "notion_dedup_query_failed";

export class NotionDedupError extends Error {
  readonly code: DedupErrorCode | string;
  readonly retryable: boolean;
  readonly httpStatus: number | null;

  constructor(
    code: DedupErrorCode | string,
    options: { retryable?: boolean; httpStatus?: number | null } = {},
  ) {
    super(code);
    this.name = "NotionDedupError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.httpStatus = options.httpStatus ?? null;
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePropertyName(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[\s_-]+/g, "");
}

function isTextFilterType(value: unknown): value is TextFilterType {
  return ["rich_text", "title", "url", "select", "formula"].includes(String(value));
}

function resolveProperty(
  properties: JsonRecord,
  aliases: string[],
  fuzzyTerms: string[],
  missingCode: DedupErrorCode,
  ambiguousCode: DedupErrorCode,
): { name: string; type: TextFilterType } {
  const supported = Object.entries(properties).flatMap(([name, value]) => {
    if (!isRecord(value) || !isTextFilterType(value.type)) {
      return [];
    }
    return [{ name, normalizedName: normalizePropertyName(name), type: value.type }];
  });
  const normalizedAliases = new Set(aliases.map(normalizePropertyName));
  const exact = supported.filter((property) => normalizedAliases.has(property.normalizedName));
  const matches =
    exact.length > 0
      ? exact
      : supported.filter((property) =>
          fuzzyTerms.some((term) => property.normalizedName.includes(normalizePropertyName(term))),
        );

  if (matches.length === 0) {
    throw new NotionDedupError(missingCode);
  }
  if (matches.length > 1) {
    throw new NotionDedupError(ambiguousCode);
  }
  const match = matches[0]!;
  return { name: match.name, type: match.type };
}

export function resolveEpisodeDedupSchema(data: unknown): EpisodeDedupSchema {
  if (!isRecord(data) || !isRecord(data.properties)) {
    throw new NotionDedupError("episode_schema_invalid");
  }
  return {
    podcastName: resolveProperty(
      data.properties,
      ["播客名称", "Podcast Name", "podcast_name"],
      ["播客名称", "podcastname"],
      "episode_schema_podcast_name_missing",
      "episode_schema_podcast_name_ambiguous",
    ),
    dedupKey: resolveProperty(
      data.properties,
      ["排重键", "去重键", "Dedup Key", "dedup_key", "dedupKey"],
      ["排重", "去重", "dedup"],
      "episode_schema_dedup_key_missing",
      "episode_schema_dedup_key_ambiguous",
    ),
  };
}

function propertyFilter(
  property: { name: string; type: TextFilterType },
  value: string,
): JsonRecord {
  assertNotionRichText(value);
  if (property.type === "formula") {
    return { property: property.name, formula: { string: { equals: value } } };
  }
  return { property: property.name, [property.type]: { equals: value } };
}

function notionFailure(response: Awaited<ReturnType<NotionClient["request"]>>): NotionDedupError {
  const retryable =
    response.status === 0 ||
    response.status === 429 ||
    response.status === 529 ||
    response.status >= 500;
  return new NotionDedupError(response.errorCode ?? "notion_dedup_query_failed", {
    retryable,
    httpStatus: response.status === 0 ? null : response.status,
  });
}

export async function loadEpisodeDedupSchema(
  client: NotionClient,
  dataSourceId: string,
): Promise<EpisodeDedupSchema> {
  const response = await client.request(
    `/v1/data_sources/${encodeURIComponent(dataSourceId)}`,
    { method: "GET" },
    { retry: true },
  );
  if (!response.ok) {
    throw notionFailure(response);
  }
  return resolveEpisodeDedupSchema(response.data);
}

export function buildEpisodeDedupFilter(
  schema: EpisodeDedupSchema,
  podcastName: string,
  dedupKey: string,
): JsonRecord {
  return {
    and: [
      propertyFilter(schema.podcastName, podcastName),
      propertyFilter(schema.dedupKey, dedupKey),
    ],
  };
}

export async function queryEpisodeExists(
  client: NotionClient,
  dataSourceId: string,
  schema: EpisodeDedupSchema,
  podcastName: string,
  dedupKey: string,
): Promise<boolean> {
  let cursor: string | null = null;
  let found = false;

  do {
    const response = await client.request(
      `/v1/data_sources/${encodeURIComponent(dataSourceId)}/query`,
      {
        method: "POST",
        body: notionJsonBody({
          filter: buildEpisodeDedupFilter(schema, podcastName, dedupKey),
          page_size: 100,
          is_archived: false,
          ...(cursor === null ? {} : { start_cursor: cursor }),
        }),
      },
      { retry: true },
    );
    if (!response.ok) {
      throw notionFailure(response);
    }
    if (!isRecord(response.data) || !Array.isArray(response.data.results)) {
      throw new NotionDedupError("notion_dedup_invalid_response");
    }
    found ||= response.data.results.some(
      (result) => isRecord(result) && result.archived !== true && result.in_trash !== true,
    );

    if (response.data.has_more === true && typeof response.data.next_cursor === "string") {
      cursor = response.data.next_cursor;
    } else if (response.data.has_more === true) {
      throw new NotionDedupError("notion_dedup_invalid_response");
    } else {
      cursor = null;
    }
  } while (cursor !== null);

  return found;
}

export async function buildDryRunDiff(
  client: NotionClient,
  dataSourceId: string,
  podcastName: string,
  candidates: ParsedFeedItem[],
  windowItemCount: number,
): Promise<DryRunDiff> {
  let dedupFailed = Math.max(0, windowItemCount - candidates.length);
  const uniqueCandidates: ParsedFeedItem[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.dedup_key)) {
      dedupFailed += 1;
      continue;
    }
    seen.add(candidate.dedup_key);
    uniqueCandidates.push(candidate);
  }

  if (uniqueCandidates.length === 0) {
    return { will_write: 0, already_exists: 0, dedup_failed: dedupFailed };
  }

  const schema = await loadEpisodeDedupSchema(client, dataSourceId);
  const checks: boolean[] = [];
  for (const candidate of uniqueCandidates) {
    checks.push(
      await queryEpisodeExists(
        client,
        dataSourceId,
        schema,
        podcastName,
        candidate.dedup_key,
      ),
    );
  }

  // Decisions are derived only after every candidate lookup has completed.
  return {
    will_write: checks.filter((exists) => !exists).length,
    already_exists: checks.filter(Boolean).length,
    dedup_failed: dedupFailed,
  };
}
