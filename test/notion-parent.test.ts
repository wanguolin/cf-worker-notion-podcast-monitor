import { describe, expect, it, vi } from "vitest";

import { createNotionClient } from "../src/notion/client";
import {
  discoverParentSyncBlock,
  formatShanghaiTimestamp,
  replaceSyncTimestamp,
  updateParentPagesSequentially,
} from "../src/notion/parent";

const annotations = {
  bold: true,
  italic: false,
  strikethrough: false,
  underline: false,
  code: false,
  color: "default",
};

function textPart(content: string, bold = true): Record<string, unknown> {
  return {
    type: "text",
    text: { content, link: null },
    annotations: { ...annotations, bold },
    plain_text: content,
    href: null,
  };
}

describe("parent sync-time callout", () => {
  it("replaces only the timestamp and preserves explanatory text and annotations", () => {
    const result = replaceSyncTimestamp(
      [
        textPart("内容同步时间：2026-08-08 09:10:11（Asia/Shanghai）"),
        textPart("\n此时间仅在全部新增单集同步成功后更新。", false),
      ],
      "2026-08-09 12:34:56",
    );

    expect(result).toEqual([
      {
        type: "text",
        text: {
          content: "内容同步时间：2026-08-09 12:34:56（Asia/Shanghai）",
          link: null,
        },
        annotations,
      },
      {
        type: "text",
        text: { content: "\n此时间仅在全部新增单集同步成功后更新。", link: null },
        annotations: { ...annotations, bold: false },
      },
    ]);
  });

  it("handles a timestamp split across adjacent rich-text fragments", () => {
    const result = replaceSyncTimestamp(
      [
        textPart("内容同步时间：2026-08-08 "),
        textPart("09:10:11（Asia/Shanghai）\n说明", false),
      ],
      "2026-12-31 23:59:58",
    );
    expect((result[0]?.text as { content: string }).content).toBe(
      "内容同步时间：2026-12-31 ",
    );
    expect((result[1]?.text as { content: string }).content).toBe(
      "23:59:58（Asia/Shanghai）\n说明",
    );
  });

  it("paginates children and rejects more than one matching callout", async () => {
    const callout = (id: string) => ({
      object: "block",
      id,
      type: "callout",
      callout: {
        rich_text: [textPart("内容同步时间：2026-08-08 09:10:11（Asia/Shanghai）")],
        icon: { type: "emoji", emoji: "🔄" },
        color: "blue_background",
      },
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ results: [callout("block-a")], has_more: true, next_cursor: "p2" }),
      )
      .mockResolvedValueOnce(
        Response.json({ results: [callout("block-b")], has_more: false, next_cursor: null }),
      );
    const client = createNotionClient("test-token", {
      fetchImpl: fetchMock,
      requestGapMs: 0,
    });
    await expect(discoverParentSyncBlock(client, "parent-id")).rejects.toThrow(
      "parent_sync_callout_ambiguous",
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("start_cursor=p2");
  });

  it("formats Shanghai wall time without depending on isolate locale", () => {
    expect(formatShanghaiTimestamp(new Date("2026-08-09T04:34:56.000Z"))).toBe(
      "2026-08-09 12:34:56",
    );
  });

  it("records a partial parent failure and continues checking remaining parents", async () => {
    const visited: string[] = [];
    const result = await updateParentPagesSequentially(
      ["parent-a", "parent-b", "parent-c"],
      async (parentPageId) => {
        visited.push(parentPageId);
        if (parentPageId === "parent-b") {
          throw new Error("failed");
        }
      },
    );
    expect(visited).toEqual(["parent-a", "parent-b", "parent-c"]);
    expect(result.updated_count).toBe(2);
    expect(result.failures.map((failure) => failure.parent_page_id)).toEqual(["parent-b"]);
  });
});
