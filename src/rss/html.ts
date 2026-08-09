const HTML_ENTITY_PATTERN = /&(amp|lt|gt|quot|#39|nbsp);/gi;

const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  nbsp: " ",
};

export function htmlToPlainText(value: string): string {
  const withoutNonContent = value
    .replace(/\r\n?/g, "\n")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<br\b[^>]*\/?\s*>/gi, "\n")
    .replace(/<\/(?:p|li)\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(HTML_ENTITY_PATTERN, (entity, name: string) => {
      return HTML_ENTITIES[name.toLowerCase()] ?? entity;
    });

  return withoutNonContent
    .split("\n")
    .map((line) => line.replace(/[\t \u00a0]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function truncatePlainText(
  value: string,
  maxCharacters: number,
): { value: string; truncated: boolean } {
  const characters = Array.from(value);
  if (characters.length <= maxCharacters) {
    return { value, truncated: false };
  }
  return {
    value: characters.slice(0, maxCharacters).join(""),
    truncated: true,
  };
}
