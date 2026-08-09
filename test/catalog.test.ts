import { afterEach, describe, expect, it, vi } from "vitest";

import { loadPodcastCatalog } from "../src/catalog";
import { createNotionClient } from "../src/notion/client";

function page(
  id: string,
  name: string,
  rss: string | null,
  category: string,
  options: { archived?: boolean; language?: string } = {},
): Record<string, unknown> {
  return {
    object: "page",
    id,
    archived: options.archived ?? false,
    in_trash: false,
    properties: {
      播客名称: {
        type: "title",
        title: [{ plain_text: name }],
      },
      RSS地址: { type: "url", url: rss },
      分类: { type: "multi_select", multi_select: [{ name: category }] },
      语言: { type: "select", select: { name: options.language ?? "中文" } },
    },
  };
}

describe("Notion catalog pagination and feed grouping", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads all pages, excludes archived rows, skips empty RSS, and preserves many parents", async () => {
    const firstPage = {
      object: "list",
      results: [
        page(
          "parent-a",
          "Masters in Business",
          "HTTPS://FEEDS.EXAMPLE.COM:443/master.xml#directory",
          "美股投资",
        ),
        page("archived", "Old", "https://feeds.example.com/old.xml", "旧", {
          archived: true,
        }),
      ],
      has_more: true,
      next_cursor: "next-page",
    };
    const secondPage = {
      object: "list",
      results: [
        page(
          "parent-b",
          "Masters in Business",
          "https://feeds.example.com/master.xml",
          "宏观经济金融",
        ),
        page("empty-rss", "No Feed", null, "美股投资"),
      ],
      has_more: false,
      next_cursor: null,
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(firstPage))
      .mockResolvedValueOnce(Response.json(secondPage));
    vi.stubGlobal("fetch", fetchMock);

    const snapshot = await loadPodcastCatalog(
      createNotionClient("test-token", { fetchImpl: fetchMock, requestGapMs: 0 }),
      "test-data-source",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(snapshot.catalog_row_count).toBe(3);
    expect(snapshot.issue_counts.catalog_rss_empty).toBe(1);
    expect(snapshot.feeds).toHaveLength(1);
    expect(snapshot.feeds[0]).toMatchObject({
      podcast_name: "Masters in Business",
      feed_url: "https://feeds.example.com/master.xml",
      categories: ["宏观经济金融", "美股投资"],
      parent_page_ids: ["parent-a", "parent-b"],
      language: "中文",
    });
    expect(snapshot.feeds[0]?.feed_url_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.feeds[0]?.content_fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
});
