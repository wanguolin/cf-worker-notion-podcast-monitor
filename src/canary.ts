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
