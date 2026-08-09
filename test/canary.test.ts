import { describe, expect, it } from "vitest";

import {
  determineWriteMode,
  parseCanaryFeedHashes,
  shouldWriteFeed,
  shouldWriteFeedTask,
} from "../src/canary";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

describe("canary write allowlist", () => {
  it("lets an allowlisted feed override global DRY_RUN", () => {
    expect(shouldWriteFeed(true, HASH_A, HASH_A)).toBe(true);
    expect(shouldWriteFeed(true, HASH_A, HASH_B)).toBe(false);
  });

  it("restricts production writes whenever an allowlist is non-empty", () => {
    expect(shouldWriteFeed(false, HASH_A, HASH_A)).toBe(true);
    expect(shouldWriteFeed(false, HASH_A, HASH_B)).toBe(false);
  });

  it("fails closed on a non-empty but invalid allowlist", () => {
    expect(parseCanaryFeedHashes(` ${HASH_A.toUpperCase()},invalid `)).toEqual(
      new Set([HASH_A]),
    );
    expect(shouldWriteFeed(false, "invalid", HASH_A)).toBe(false);
    expect(shouldWriteFeed(false, "", HASH_B)).toBe(true);
    expect(shouldWriteFeed(true, "", HASH_B)).toBe(false);
  });

  it("keeps rss-selftest tasks dry even in full production mode", () => {
    expect(shouldWriteFeedTask(false, "", HASH_A, true)).toBe(false);
    expect(shouldWriteFeedTask(false, "", HASH_A, false)).toBe(true);
  });

  it("reports full mode for DRY_RUN=false with an empty canary allowlist", () => {
    expect(determineWriteMode(false, "")).toBe("full");
    expect(determineWriteMode(true, "")).toBe("dry_run");
    expect(determineWriteMode(false, HASH_A)).toBe("canary");
  });
});
