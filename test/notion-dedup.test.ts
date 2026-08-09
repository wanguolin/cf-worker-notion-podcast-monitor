import { describe, expect, it, vi } from "vitest";

import { createNotionClient } from "../src/notion/client";
import {
  buildDryRunDiff,
  buildEpisodeDedupFilter,
  resolveEpisodeDedupSchema,
} from "../src/notion/dedup";
import type { ParsedFeedItem } from "../src/rss/parser";

function candidate(dedupKey: string): ParsedFeedItem {
  return {
    guid: dedupKey,
    link: null,
    media_url: null,
    published_at: "2026-08-09T00:00:00.000Z",
    title: dedupKey,
    dedup_key: dedupKey,
    dedup_source: "guid",
  };
}

describe("Notion episode dedup queries", () => {
  it("discovers the real property names and builds an AND filter by schema type", () => {
    const schema = resolveEpisodeDedupSchema({
      properties: {
        单集标题: { type: "title" },
        播客名称: { type: "rich_text" },
        业务排重键: { type: "formula" },
      },
    });
    expect(schema).toEqual({
      podcastName: { name: "播客名称", type: "rich_text" },
      dedupKey: { name: "业务排重键", type: "formula" },
    });
    expect(buildEpisodeDedupFilter(schema, "知行小酒馆", "guid:abc")).toEqual({
      and: [
        { property: "播客名称", rich_text: { equals: "知行小酒馆" } },
        { property: "业务排重键", formula: { string: { equals: "guid:abc" } } },
      ],
    });
  });

  it("paginates every lookup, waits for all checks, and classifies the dry-run diff", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          object: "data_source",
          properties: {
            播客名称: { type: "rich_text" },
            排重键: { type: "rich_text" },
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ object: "list", results: [], has_more: true, next_cursor: "p2" }),
      )
      .mockResolvedValueOnce(
        Response.json({
          object: "list",
          results: [{ object: "page", id: "existing", archived: false, in_trash: false }],
          has_more: false,
          next_cursor: null,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ object: "list", results: [], has_more: false, next_cursor: null }),
      );
    const client = createNotionClient("test-token", {
      fetchImpl: fetchMock,
      requestGapMs: 0,
    });

    const diff = await buildDryRunDiff(
      client,
      "episode-source",
      "知行小酒馆",
      [candidate("guid:existing"), candidate("guid:new"), candidate("guid:new")],
      4,
    );

    expect(diff).toEqual({ will_write: 1, already_exists: 1, dedup_failed: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const firstQuery = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    const secondPage = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body));
    expect(firstQuery.filter).toEqual({
      and: [
        { property: "播客名称", rich_text: { equals: "知行小酒馆" } },
        { property: "排重键", rich_text: { equals: "guid:existing" } },
      ],
    });
    expect(firstQuery).not.toHaveProperty("start_cursor");
    expect(secondPage.start_cursor).toBe("p2");
  });

  it("fails closed when the dedup property cannot be identified", () => {
    expect(() =>
      resolveEpisodeDedupSchema({
        properties: {
          单集标题: { type: "title" },
          播客名称: { type: "rich_text" },
          其他字段: { type: "rich_text" },
        },
      }),
    ).toThrow("episode_schema_dedup_key_missing");
  });
});
