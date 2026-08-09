import { normalizeUrlForDedup } from "./url";

export type DedupSource = "guid" | "link" | "media" | "title_date";

export type DedupInput = {
  guid: string | null;
  link: string | null;
  mediaUrl: string | null;
  title: string | null;
  publishedAt: string | null;
};

export type DedupResult = {
  key: string;
  source: DedupSource;
};

export const DEDUP_KEY_MAX_CHARACTERS = 1_900;
const DEDUP_KEY_RETAINED_CHARACTERS = 1_800;

export function normalizeOpaqueIdentifier(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function normalizeTitle(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ");
}

export function normalizePublishedAt(value: string): string | null {
  const timestamp = Date.parse(value.trim());
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

async function boundedDedupKey(prefix: DedupSource, normalizedValue: string): Promise<string> {
  const key = `${prefix}:${normalizedValue}`;
  if (Array.from(key).length <= DEDUP_KEY_MAX_CHARACTERS) {
    return key;
  }

  const characters = Array.from(normalizedValue);
  const retained = characters.slice(0, DEDUP_KEY_RETAINED_CHARACTERS).join("");
  const overflow = characters.slice(DEDUP_KEY_RETAINED_CHARACTERS).join("");
  return `${prefix}:${retained}#sha256:${await sha256Hex(overflow)}`;
}

export async function createDedupKey(input: DedupInput): Promise<DedupResult | null> {
  const guid = input.guid === null ? "" : normalizeOpaqueIdentifier(input.guid);
  if (guid !== "") {
    return { source: "guid", key: await boundedDedupKey("guid", guid) };
  }

  const link = input.link === null ? null : normalizeUrlForDedup(input.link);
  if (link !== null) {
    return { source: "link", key: await boundedDedupKey("link", link) };
  }

  const media = input.mediaUrl === null ? null : normalizeUrlForDedup(input.mediaUrl);
  if (media !== null) {
    return { source: "media", key: await boundedDedupKey("media", media) };
  }

  const title = input.title === null ? "" : normalizeTitle(input.title);
  const publishedAt = input.publishedAt === null ? null : normalizePublishedAt(input.publishedAt);
  if (title === "" || publishedAt === null) {
    return null;
  }

  return {
    source: "title_date",
    key: await boundedDedupKey("title_date", `${title}\n${publishedAt}`),
  };
}
