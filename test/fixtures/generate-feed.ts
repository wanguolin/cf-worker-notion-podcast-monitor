const MIB = 1024 * 1024;

export type SyntheticFeed = {
  bytesEnqueued: () => number;
  cancelled: () => boolean;
  response: Response;
};

export function mib(value: number): number {
  return value * MIB;
}

export function createSyntheticFeed(
  targetBytes: number,
  options: { contentLength?: boolean; chunkBytes?: number } = {},
): SyntheticFeed {
  const encoder = new TextEncoder();
  const prefix = encoder.encode(
    '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>fixture</title>' +
      '<item><guid>fixture-guid</guid><title>Fixture episode</title>' +
      '<link>https://example.com/episodes/fixture</link>' +
      '<enclosure url="https://cdn.example.com/fixture.mp3" type="audio/mpeg" />' +
      '<pubDate>Fri, 08 Aug 2026 20:00:00 GMT</pubDate></item><padding>',
  );
  const suffix = encoder.encode("</padding></channel></rss>");
  const paddingBytes = targetBytes - prefix.byteLength - suffix.byteLength;
  if (paddingBytes < 0) {
    throw new Error("targetBytes is too small for the synthetic feed envelope");
  }

  const chunkBytes = options.chunkBytes ?? 64 * 1024;
  const paddingChunk = new Uint8Array(chunkBytes).fill("x".charCodeAt(0));
  let sent = 0;
  let wasCancelled = false;
  let stage: "prefix" | "padding" | "suffix" | "done" = "prefix";
  let remainingPadding = paddingBytes;

  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (stage === "prefix") {
        controller.enqueue(prefix);
        sent += prefix.byteLength;
        stage = "padding";
        return;
      }
      if (stage === "padding" && remainingPadding > 0) {
        const length = Math.min(remainingPadding, paddingChunk.byteLength);
        controller.enqueue(length === paddingChunk.byteLength ? paddingChunk : paddingChunk.subarray(0, length));
        sent += length;
        remainingPadding -= length;
        return;
      }
      if (stage === "padding") {
        stage = "suffix";
      }
      if (stage === "suffix") {
        controller.enqueue(suffix);
        sent += suffix.byteLength;
        stage = "done";
        controller.close();
      }
    },
    cancel() {
      wasCancelled = true;
    },
  });

  const headers = new Headers({ "Content-Type": "application/rss+xml" });
  if (options.contentLength !== false) {
    headers.set("Content-Length", String(targetBytes));
  }

  return {
    bytesEnqueued: () => sent,
    cancelled: () => wasCancelled,
    response: new Response(stream, { status: 200, headers }),
  };
}

export function responseFromXml(xml: string, headers?: HeadersInit): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(xml));
        controller.close();
      },
    }),
    { status: 200, ...(headers === undefined ? {} : { headers }) },
  );
}
