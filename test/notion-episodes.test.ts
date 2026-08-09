import { describe, expect, it, vi } from "vitest";

import { createNotionClient } from "../src/notion/client";
import {
  buildEpisodePageProperties,
  createEpisodeWithUncertainRecheck,
  filterEpisodeCategories,
  resolveEpisodeWriteSchema,
} from "../src/notion/episodes";
import type { ParsedFeedItem } from "../src/rss/parser";

function item(overrides: Partial<ParsedFeedItem> = {}): ParsedFeedItem {
  return {
    author: "作者 A",
    description: "简介",
    description_truncated: false,
    duration: "01:02:03",
    episode: "7",
    episode_type: "full",
    explicit: "no",
    guid: "episode-guid",
    image_url: "https://cdn.example.com/cover.jpg",
    keywords: ["投资", "AI"],
    link: "https://example.com/episode",
    media_length: "123456",
    media_type: "audio/mpeg",
    media_url: "https://cdn.example.com/episode.mp3",
    published_at: "2026-08-09T04:34:56.000Z",
    rss_categories: ["Business", "Technology"],
    season: "2",
    title: "单集标题",
    transcript_url: "https://example.com/transcript.json",
    dedup_key: "guid:episode-guid",
    dedup_source: "guid",
    ...overrides,
  };
}

describe("Notion episode field mapping", () => {
  it("resolves dynamic property names and maps all supported RSS fields by schema type", () => {
    const schema = resolveEpisodeWriteSchema({
      properties: {
        单集标题: { type: "title" },
        播客名称: { type: "rich_text" },
        排重键: { type: "rich_text" },
        GUID: { type: "rich_text" },
        原始链接: { type: "url" },
        媒体下载: { type: "url" },
        RSS源: { type: "url" },
        简介: { type: "rich_text" },
        发布日期: { type: "date" },
        上海时间: { type: "rich_text" },
        作者: { type: "rich_text" },
        时长: { type: "rich_text" },
        季: { type: "number" },
        集: { type: "number" },
        节目类型: { type: "select" },
        显式内容: { type: "checkbox" },
        RSS分类: { type: "multi_select" },
        关键词: { type: "multi_select" },
        封面: { type: "files" },
        逐字稿: { type: "url" },
        媒体类型: { type: "rich_text" },
        媒体长度: { type: "number" },
        语言: { type: "select" },
        分类: {
          type: "multi_select",
          multi_select: {
            options: [
              { name: "美股投资" },
              { name: "宏观经济金融" },
              { name: "大科技与AI" },
            ],
          },
        },
        排重来源: { type: "select" },
        简介已截断: { type: "checkbox" },
      },
    });
    const built = buildEpisodePageProperties(schema, item(), {
      podcastName: "知行小酒馆",
      feedUrl: "https://feeds.example.com/show.xml",
      categories: ["美股投资", "大科技与AI", "其他"],
      language: "中文",
    });

    expect(built.description_truncated).toBe(false);
    expect(built.properties).toMatchObject({
      单集标题: { title: [{ text: { content: "单集标题" } }] },
      播客名称: { rich_text: [{ text: { content: "知行小酒馆" } }] },
      排重键: { rich_text: [{ text: { content: "guid:episode-guid" } }] },
      原始链接: { url: "https://example.com/episode" },
      发布日期: { date: { start: "2026-08-09T04:34:56.000Z" } },
      上海时间: { rich_text: [{ text: { content: "2026-08-09 12:34:56" } }] },
      季: { number: 2 },
      显式内容: { checkbox: false },
      RSS分类: { multi_select: [{ name: "Business" }, { name: "Technology" }] },
      分类: { multi_select: [{ name: "美股投资" }, { name: "大科技与AI" }] },
      简介已截断: { checkbox: false },
    });
    expect(built.skipped_categories).toEqual(["其他"]);
    expect(Object.keys(built.properties)).toHaveLength(26);
  });

  it("never creates classification options outside the fixed and existing sets", () => {
    expect(
      filterEpisodeCategories(
        ["美股投资", "宏观经济金融", "大科技与AI", "未批准", "美股投资"],
        ["美股投资", "大科技与AI"],
      ),
    ).toEqual({
      accepted: ["美股投资", "大科技与AI"],
      skipped: ["宏观经济金融", "未批准"],
    });
  });

  it("truncates descriptions at the rich-text boundary and records the downgrade", () => {
    const schema = resolveEpisodeWriteSchema({
      properties: {
        单集标题: { type: "title" },
        播客名称: { type: "rich_text" },
        排重键: { type: "rich_text" },
        简介: { type: "rich_text" },
        简介已截断: { type: "checkbox" },
      },
    });
    const built = buildEpisodePageProperties(
      schema,
      item({ description: "长".repeat(2_001) }),
      {
        podcastName: "播客",
        feedUrl: "https://feeds.example.com/show.xml",
        categories: [],
        language: null,
      },
    );
    expect(built.description_truncated).toBe(true);
    expect(
      ((built.properties.简介 as { rich_text: Array<{ text: { content: string } }> })
        .rich_text[0]?.text.content ?? "").length,
    ).toBe(2_000);
    expect(built.properties.简介已截断).toEqual({ checkbox: true });
  });
});

describe("uncertain Notion create recovery", () => {
  it("requeries the business key after a connection failure and does not blindly POST again", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new DOMException("network failed", "NetworkError"))
      .mockResolvedValueOnce(
        Response.json({
          object: "list",
          results: [{ object: "page", id: "recovered-page", in_trash: false }],
          has_more: false,
          next_cursor: null,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          object: "page",
          id: "recovered-page",
          properties: {},
        }),
      );
    const client = createNotionClient("test-token", {
      fetchImpl: fetchMock,
      requestGapMs: 0,
      maxRetries: 0,
    });
    const statement = {
      bind() {
        return this;
      },
      async run() {
        return { success: true, meta: { changes: 1 } };
      },
      async first() {
        return null;
      },
    } as D1PreparedStatement;
    const database: D1Database = {
      prepare: () => statement,
      async batch<T = unknown>(): Promise<D1Result<T>[]> {
        return [];
      },
      async exec(): Promise<D1ExecResult> {
        return { count: 0, duration: 0 };
      },
      withSession(): never {
        throw new Error("not used by this test");
      },
      async dump(): Promise<ArrayBuffer> {
        return new ArrayBuffer(0);
      },
    };

    await expect(
      createEpisodeWithUncertainRecheck({
        client,
        dataSourceId: "episode-source",
        database,
        dedupSchema: {
          podcastName: { name: "播客名称", type: "rich_text" },
          dedupKey: { name: "排重键", type: "rich_text" },
        },
        podcastName: "播客",
        dedupKey: "guid:abc",
        properties: {},
      }),
    ).resolves.toBe("recovered-page");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/v1/pages");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/query");
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain("/v1/pages/recovered-page");
  });
});
