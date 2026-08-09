const FEED_HASH_PATTERN = /^[a-f0-9]{64}$/;

export function parseCanaryFeedHashes(value: string): Set<string> {
  const hashes = new Set<string>();
  for (const part of value.split(",")) {
    const normalized = part.trim().toLowerCase();
    if (FEED_HASH_PATTERN.test(normalized)) {
      hashes.add(normalized);
    }
  }
  return hashes;
}

export function shouldWriteFeed(
  dryRun: boolean,
  canaryFeedHashes: string,
  feedUrlHash: string,
): boolean {
  const allowlist = parseCanaryFeedHashes(canaryFeedHashes);
  return canaryFeedHashes.trim() !== ""
    ? allowlist.has(feedUrlHash.toLowerCase())
    : !dryRun;
}

export function shouldWriteFeedTask(
  dryRun: boolean,
  canaryFeedHashes: string,
  feedUrlHash: string,
  forceDryRun = false,
): boolean {
  return !forceDryRun && shouldWriteFeed(dryRun, canaryFeedHashes, feedUrlHash);
}

export function determineWriteMode(
  dryRun: boolean,
  canaryFeedHashes: string,
): "canary" | "dry_run" | "full" {
  if (canaryFeedHashes.trim() !== "") {
    return "canary";
  }
  return dryRun ? "dry_run" : "full";
}
