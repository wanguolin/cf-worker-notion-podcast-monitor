import { sha256Hex } from "./rss/dedup";
import { normalizeAndValidateFeedUrl } from "./rss/url";
import { type NotionClient, notionJsonBody } from "./notion/client";

type JsonRecord = Record<string, unknown>;

export type CatalogIssueCode =
  | "catalog_feed_mapping_conflict"
  | "catalog_row_missing_name"
  | "catalog_rss_empty"
  | "catalog_rss_url_rejected";

export class CatalogPipelineError extends Error {
  readonly code: "catalog_invalid_response" | "catalog_notion_request_failed" | CatalogIssueCode;

  constructor(
    code: "catalog_invalid_response" | "catalog_notion_request_failed" | CatalogIssueCode,
  ) {
    super(code);
    this.name = "CatalogPipelineError";
    this.code = code;
  }
}

export type CatalogFeed = {
  categories: string[];
  content_fingerprint: string;
  feed_url: string;
  feed_url_hash: string;
  language: string | null;
  parent_page_ids: string[];
  podcast_name: string;
};

export type CatalogSnapshot = {
  catalog_row_count: number;
  feeds: CatalogFeed[];
  issue_counts: Partial<Record<CatalogIssueCode, number>>;
  parent_pages: CatalogParentPage[];
};

export type CatalogParentPage = {
  page_id: string;
  podcast_name: string;
};

export type CatalogParentSnapshot = {
  catalog_row_count: number;
  parent_pages: CatalogParentPage[];
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addIssue(
  counts: Partial<Record<CatalogIssueCode, number>>,
  code: CatalogIssueCode,
): void {
  counts[code] = (counts[code] ?? 0) + 1;
}

function propertyRecord(page: JsonRecord, name: string): JsonRecord | null {
  if (!isRecord(page.properties)) {
    return null;
  }
  const property = page.properties[name];
  return isRecord(property) ? property : null;
}

function richTextValue(value: unknown): string {
  if (!Array.isArray(value)) {
    return "";
  }

  return value
    .map((part) => (isRecord(part) && typeof part.plain_text === "string" ? part.plain_text : ""))
    .join("")
    .trim();
}

function textProperty(page: JsonRecord, name: string): string {
  const property = propertyRecord(page, name);
  if (property === null) {
    return "";
  }
  if (property.type === "title") {
    return richTextValue(property.title);
  }
  if (property.type === "rich_text") {
    return richTextValue(property.rich_text);
  }
  return "";
}

function urlProperty(page: JsonRecord, name: string): string {
  const property = propertyRecord(page, name);
  if (property === null) {
    return "";
  }
  if (property.type === "url" && typeof property.url === "string") {
    return property.url.trim();
  }
  return textProperty(page, name);
}

function categoryProperty(page: JsonRecord, name: string): string[] {
  const property = propertyRecord(page, name);
  if (property === null) {
    return [];
  }
  if (property.type === "multi_select" && Array.isArray(property.multi_select)) {
    return property.multi_select
      .map((option) => (isRecord(option) && typeof option.name === "string" ? option.name.trim() : ""))
      .filter((value) => value !== "");
  }
  if (property.type === "select" && isRecord(property.select)) {
    return typeof property.select.name === "string" && property.select.name.trim() !== ""
      ? [property.select.name.trim()]
      : [];
  }
  const text = textProperty(page, name);
  return text === "" ? [] : text.split(/[,，]/).map((value) => value.trim()).filter(Boolean);
}

function selectProperty(page: JsonRecord, name: string): string | null {
  const property = propertyRecord(page, name);
  if (property === null) {
    return null;
  }
  if (property.type === "select" && isRecord(property.select)) {
    return typeof property.select.name === "string" && property.select.name.trim() !== ""
      ? property.select.name.trim()
      : null;
  }
  const text = textProperty(page, name);
  return text === "" ? null : text;
}

async function queryCatalogPages(
  client: NotionClient,
  dataSourceId: string,
): Promise<JsonRecord[]> {
  const pages: JsonRecord[] = [];
  let cursor: string | null = null;

  do {
    const response = await client.request(
      `/v1/data_sources/${encodeURIComponent(dataSourceId)}/query`,
      {
        method: "POST",
        body: notionJsonBody({
          page_size: 100,
          is_archived: false,
          ...(cursor === null ? {} : { start_cursor: cursor }),
        }),
      },
      { retry: true },
    );
    if (!response.ok) {
      throw new CatalogPipelineError("catalog_notion_request_failed");
    }
    const data = response.data;
    if (!isRecord(data) || !Array.isArray(data.results)) {
      throw new CatalogPipelineError("catalog_invalid_response");
    }

    for (const result of data.results) {
      if (isRecord(result)) {
        pages.push(result);
      }
    }

    if (data.has_more === true && typeof data.next_cursor === "string") {
      cursor = data.next_cursor;
    } else if (data.has_more === true) {
      throw new CatalogPipelineError("catalog_invalid_response");
    } else {
      cursor = null;
    }
  } while (cursor !== null);

  return pages;
}

function activeCatalogPages(pages: JsonRecord[]): JsonRecord[] {
  return pages.filter((page) => page.archived !== true && page.in_trash !== true);
}

function catalogParentPages(activePages: JsonRecord[]): CatalogParentPage[] {
  const parents = activePages.map((page) => {
    if (typeof page.id !== "string") {
      throw new CatalogPipelineError("catalog_invalid_response");
    }
    return {
      page_id: page.id,
      podcast_name: textProperty(page, "播客名称"),
    };
  });
  parents.sort((left, right) => left.page_id.localeCompare(right.page_id));
  return parents;
}

export async function loadCatalogParentPages(
  client: NotionClient,
  dataSourceId: string,
): Promise<CatalogParentSnapshot> {
  const activePages = activeCatalogPages(await queryCatalogPages(client, dataSourceId));
  return {
    catalog_row_count: activePages.length,
    parent_pages: catalogParentPages(activePages),
  };
}

export async function loadPodcastCatalog(
  client: NotionClient,
  dataSourceId: string,
): Promise<CatalogSnapshot> {
  const pages = await queryCatalogPages(client, dataSourceId);
  const issues: Partial<Record<CatalogIssueCode, number>> = {};
  const activePages = activeCatalogPages(pages);
  const parentPages = catalogParentPages(activePages);
  const grouped = new Map<
    string,
    {
      categories: Set<string>;
      feedUrl: string;
      language: string | null;
      parentPageIds: Set<string>;
      podcastName: string;
    }
  >();

  for (const page of activePages) {
    const rss = urlProperty(page, "RSS地址");
    if (rss === "") {
      addIssue(issues, "catalog_rss_empty");
      continue;
    }

    let normalizedFeedUrl: string;
    try {
      normalizedFeedUrl = normalizeAndValidateFeedUrl(rss);
    } catch {
      addIssue(issues, "catalog_rss_url_rejected");
      continue;
    }

    const podcastName = textProperty(page, "播客名称");
    if (podcastName === "") {
      addIssue(issues, "catalog_row_missing_name");
      continue;
    }
    if (typeof page.id !== "string") {
      throw new CatalogPipelineError("catalog_invalid_response");
    }

    const categories = categoryProperty(page, "分类");
    const language = selectProperty(page, "语言");
    const existing = grouped.get(normalizedFeedUrl);
    if (existing === undefined) {
      grouped.set(normalizedFeedUrl, {
        categories: new Set(categories),
        feedUrl: normalizedFeedUrl,
        language,
        parentPageIds: new Set([page.id]),
        podcastName,
      });
      continue;
    }

    if (
      existing.podcastName !== podcastName ||
      (existing.language !== null && language !== null && existing.language !== language)
    ) {
      throw new CatalogPipelineError("catalog_feed_mapping_conflict");
    }
    existing.language ??= language;
    existing.parentPageIds.add(page.id);
    for (const category of categories) {
      existing.categories.add(category);
    }
  }

  const feeds: CatalogFeed[] = [];
  for (const mapping of grouped.values()) {
    const categories = [...mapping.categories].sort();
    const parentPageIds = [...mapping.parentPageIds].sort();
    const feedUrlHash = await sha256Hex(mapping.feedUrl);
    const fingerprintPayload = JSON.stringify({
      categories,
      feed_url: mapping.feedUrl,
      language: mapping.language,
      parent_page_ids: parentPageIds,
      podcast_name: mapping.podcastName,
    });
    feeds.push({
      categories,
      content_fingerprint: await sha256Hex(fingerprintPayload),
      feed_url: mapping.feedUrl,
      feed_url_hash: feedUrlHash,
      language: mapping.language,
      parent_page_ids: parentPageIds,
      podcast_name: mapping.podcastName,
    });
  }
  feeds.sort((left, right) => left.feed_url_hash.localeCompare(right.feed_url_hash));

  return {
    catalog_row_count: activePages.length,
    feeds,
    issue_counts: issues,
    parent_pages: parentPages,
  };
}
