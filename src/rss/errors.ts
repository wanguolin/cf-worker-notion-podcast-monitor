export type FeedErrorCode =
  | "feed_connect_timeout"
  | "feed_http_error"
  | "feed_redirect_invalid"
  | "feed_redirect_limit"
  | "feed_redirect_loop"
  | "feed_response_body_missing"
  | "feed_too_large"
  | "feed_total_timeout"
  | "invalid_feed_url"
  | "episode_schema_dedup_key_ambiguous"
  | "episode_schema_dedup_key_missing"
  | "episode_schema_invalid"
  | "episode_schema_podcast_name_ambiguous"
  | "episode_schema_podcast_name_missing"
  | "episode_create_failed"
  | "episode_create_invalid_response"
  | "episode_create_uncertain"
  | "episode_create_verification_failed"
  | "episode_schema_write_property_unsupported"
  | "notion_dedup_query_failed"
  | "notion_payload_invalid"
  | "notion_token_missing"
  | "parent_update_failed"
  | "rss_or_atom_root_missing"
  | "soft_deadline_exceeded"
  | "too_many_window_items"
  | "unsupported_xml_encoding"
  | "url_credentials_forbidden"
  | "url_hostname_forbidden"
  | "url_ip_literal_forbidden"
  | "url_protocol_forbidden"
  | "xml_depth_exceeded"
  | "xml_field_too_large"
  | "xml_malformed"
  | "window_items_too_large";

export class FeedPipelineError extends Error {
  readonly code: FeedErrorCode;
  readonly retryable: boolean;
  readonly httpStatus: number | null;

  constructor(
    code: FeedErrorCode,
    options: { retryable?: boolean; httpStatus?: number | null } = {},
  ) {
    super(code);
    this.name = "FeedPipelineError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.httpStatus = options.httpStatus ?? null;
  }
}

export function toFeedPipelineError(error: unknown): FeedPipelineError {
  if (error instanceof FeedPipelineError) {
    return error;
  }

  if (error instanceof DOMException && error.name === "TimeoutError") {
    return new FeedPipelineError("feed_total_timeout", { retryable: true });
  }

  return new FeedPipelineError("xml_malformed");
}
