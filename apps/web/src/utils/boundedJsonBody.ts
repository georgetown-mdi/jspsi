import { parseBoundedJson } from "@psilink/core";

/**
 * The one byte-capped JSON body read the web app has, for both directions of the
 * console's job API: a route reading a browser's request body, and a browser
 * client reading the console's response body. Both are streamed under a hard
 * byte cap and parsed through `@psilink/core`'s `parseBoundedJson`, so neither
 * direction can buffer an unbounded body or drive `JSON.parse` into the
 * uncatchable engine abort that bound forestalls (see
 * packages/core/src/utils/boundedJson.ts and
 * docs/spec/CHANNEL_SECURITY.md).
 */

/**
 * The outcome of reading a body under a byte cap:
 * - `too-large`: the body exceeded the cap.
 * - `invalid`: the body was absent, failed part-way through the stream, was not
 *   valid UTF-8, was not valid JSON, or exceeded the structural bound
 *   parseBoundedJson enforces.
 * - `parsed`: the decoded JSON value.
 */
export type BoundedJsonBodyResult =
  | { kind: "too-large" }
  | { kind: "invalid" }
  | { kind: "parsed"; value: unknown };

/**
 * Read a `Request` or `Response` body as JSON under a hard byte cap, without
 * trusting `Content-Length` (absent or understated on a chunked message).
 * Streamed via {@link ReadableStream.getReader}; the read stops, and the reader
 * is cancelled, the moment the running byte total exceeds `maxBytes` -- the body
 * is never buffered first. Decodes and parses the accumulated bytes itself,
 * since consuming the stream leaves the message's own `json()` unavailable.
 * Pure over its arguments, so a test can drive it with any `Request` or
 * `Response`.
 *
 * Every failure is a returned refusal, never a raised one: a stream that errors
 * part-way through reads as `invalid`, so a caller's refusal path handles a
 * dropped connection the same way it handles an unparseable body.
 */
export async function readBoundedJsonBody(
  message: Request | Response,
  maxBytes: number,
): Promise<BoundedJsonBodyResult> {
  const body = message.body;
  if (body === null) return { kind: "invalid" };
  const reader = body.getReader();
  const chunks: Array<Uint8Array> = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        // A cancel that rejects leaves the verdict alone: the cap was already
        // passed, so the refusal is decided before the cancel runs.
        await reader.cancel().catch(() => undefined);
        return { kind: "too-large" };
      }
      chunks.push(value);
    }
  } catch {
    return { kind: "invalid" };
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let value: unknown;
  try {
    value = parseBoundedJson(merged);
  } catch {
    return { kind: "invalid" };
  }
  return { kind: "parsed", value };
}
