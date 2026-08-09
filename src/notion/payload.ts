export const NOTION_URL_MAX_CHARACTERS = 2_000;
export const NOTION_RICH_TEXT_MAX_CHARACTERS = 2_000;
export const NOTION_REQUEST_MAX_BYTES = 500 * 1024;

export type NotionPayloadErrorCode =
  | "notion_request_too_large"
  | "notion_rich_text_too_long"
  | "notion_url_too_long";

export class NotionPayloadError extends Error {
  readonly code: NotionPayloadErrorCode;

  constructor(code: NotionPayloadErrorCode) {
    super(code);
    this.name = "NotionPayloadError";
    this.code = code;
  }
}

export function unicodeCharacterCount(value: string): number {
  return Array.from(value).length;
}

export function assertNotionUrl(value: string): string {
  if (unicodeCharacterCount(value) > NOTION_URL_MAX_CHARACTERS) {
    throw new NotionPayloadError("notion_url_too_long");
  }
  return value;
}

export function assertNotionRichText(value: string): string {
  if (unicodeCharacterCount(value) > NOTION_RICH_TEXT_MAX_CHARACTERS) {
    throw new NotionPayloadError("notion_rich_text_too_long");
  }
  return value;
}

export function truncateNotionRichText(
  value: string,
): { value: string; truncated: boolean } {
  const characters = Array.from(value);
  if (characters.length <= NOTION_RICH_TEXT_MAX_CHARACTERS) {
    return { value, truncated: false };
  }
  return {
    value: characters.slice(0, NOTION_RICH_TEXT_MAX_CHARACTERS).join(""),
    truncated: true,
  };
}

export function serializeNotionPayload(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (new TextEncoder().encode(serialized).byteLength > NOTION_REQUEST_MAX_BYTES) {
    throw new NotionPayloadError("notion_request_too_large");
  }
  return serialized;
}
