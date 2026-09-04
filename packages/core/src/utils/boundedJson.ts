import { decFatal } from "./crypto";
import { exceedsJsonStructureBound } from "./jsonStructureBound";

// Structural bounds applied to every untrusted JSON body before JSON.parse
// runs, and rejected ahead of the parse: a single object wide enough, or a
// single array long enough, drives JSON.parse into a process-terminating
// internal engine limit (a per-object property ceiling, or the array
// backing-store length limit) -- an uncatchable abort, not a thrown exception,
// so no surrounding try/catch can intercept it.
//
// MAX_JSON_OBJECT_KEYS caps the members of any one object. It sits above
// the widest legitimate object (the linkage-terms transform.params record,
// at MAX_PARAMS_ENTRIES = 256; every other message is shallower) and below
// the per-object engine limit.
//
// MAX_JSON_ARRAY_ELEMENTS caps the elements of any one array. Legitimate
// array-bearing messages (PSI association indices, payload rows / row
// indices, mapped-element pairs) are sized by the matched record count,
// itself transport-bounded to a few million, so this sits above any real
// array and below the engine's array length limit.
//
// MAX_JSON_NESTING_DEPTH caps structural nesting. Legitimate messages
// nest only a few levels (the parsed-config ceiling is camelizeKeys' 256),
// so this only catches a degenerate all-`{`/`[` body; it also bounds the
// pre-parse scan's own per-container stack.
//
// Each bound sits above any real container and below the engine limit,
// so none pre-empts a clean schema-level rejection or a legitimate large
// message. See docs/spec/CHANNEL_SECURITY.md.
/** @internal */
export const MAX_JSON_OBJECT_KEYS = 65536;
/** @internal */
const MAX_JSON_ARRAY_ELEMENTS = 16_777_216;
/** @internal */
export const MAX_JSON_NESTING_DEPTH = 4096;

/**
 * Thrown by {@link parseBoundedJson} when the input's structure exceeds a bound,
 * distinct from the `SyntaxError`/`TypeError` a malformed or invalid-UTF-8 body
 * throws. The message is fixed text holding no input bytes; a caller maps it to
 * its own domain error (a `ConnectionError` on the wire, a `UsageError` on a
 * transport file) and can distinguish a structural rejection from a syntax one
 * by `instanceof` when it wants different operator-facing text.
 */
export class JsonStructureBoundError extends Error {
  constructor() {
    super("JSON payload structure exceeds the permitted bound");
    this.name = "JsonStructureBoundError";
  }
}

/**
 * The sole entry point for parsing UNTRUSTED JSON -- a partner wire frame,
 * a transport-controlled file, an invitation token: any body an attacker can
 * shape. Bounds the body's structure before handing it to `JSON.parse`, so
 * an attacker-controlled body cannot trigger the abort described above. Bytes
 * decode UTF-8-fatal; a string (already decoded by the transport) is scanned
 * and parsed as is.
 *
 * Throws {@link JsonStructureBoundError} on an out-of-bound structure,
 * or the native error on malformed or invalid-UTF-8 input. An ESLint rule
 * requires every untrusted-JSON parse in `@psilink/core` to route through
 * here (a trusted parse opts out with a justified `eslint-disable`). See
 * docs/spec/CHANNEL_SECURITY.md.
 */
export function parseBoundedJson(input: Uint8Array | string): unknown {
  if (
    exceedsJsonStructureBound(
      input,
      MAX_JSON_OBJECT_KEYS,
      MAX_JSON_ARRAY_ELEMENTS,
      MAX_JSON_NESTING_DEPTH,
    )
  ) {
    throw new JsonStructureBoundError();
  }
  return JSON.parse(typeof input === "string" ? input : decFatal.decode(input));
}
