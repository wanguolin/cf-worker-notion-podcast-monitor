import { FeedPipelineError } from "./errors";

const FORBIDDEN_EXACT_HOSTNAMES = new Set([
  "instance-data",
  "instance-data.ec2.internal",
  "localhost",
  "metadata",
  "metadata.google.internal",
]);

const FORBIDDEN_HOSTNAME_SUFFIXES = [
  ".example",
  ".home.arpa",
  ".internal",
  ".invalid",
  ".local",
  ".localhost",
  ".test",
];

function hostnameWithoutIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function looksLikeIpLiteral(hostname: string): boolean {
  const value = hostnameWithoutIpv6Brackets(hostname);
  return value.includes(":") || /^\d+(?:\.\d+){3}$/.test(value);
}

function validateHostname(hostname: string): void {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");

  if (looksLikeIpLiteral(normalized)) {
    // Workers cannot reliably validate DNS-rebinding safety for literal targets in
    // application code. RSS feeds are therefore restricted to public DNS names.
    throw new FeedPipelineError("url_ip_literal_forbidden");
  }

  if (
    normalized.length === 0 ||
    !normalized.includes(".") ||
    FORBIDDEN_EXACT_HOSTNAMES.has(normalized) ||
    FORBIDDEN_HOSTNAME_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
  ) {
    throw new FeedPipelineError("url_hostname_forbidden");
  }
}

export function normalizeAndValidateFeedUrl(input: string, base?: string): string {
  let url: URL;

  try {
    url = base === undefined ? new URL(input.trim()) : new URL(input.trim(), base);
  } catch {
    throw new FeedPipelineError("invalid_feed_url");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new FeedPipelineError("url_protocol_forbidden");
  }

  if (url.username !== "" || url.password !== "") {
    throw new FeedPipelineError("url_credentials_forbidden");
  }

  validateHostname(url.hostname);
  url.hash = "";

  return url.toString();
}

export function normalizeUrlForDedup(input: string): string | null {
  try {
    return normalizeAndValidateFeedUrl(input);
  } catch {
    return null;
  }
}
