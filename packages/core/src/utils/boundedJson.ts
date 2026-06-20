import { decFatal } from "./crypto";
import { exceedsJsonStructureBound } from "./jsonStructureBound";

// Structural bounds enforced on every untrusted JSON body before JSON.parse
// runs. A single object wide enough, or a single array long enough, drives
// JSON.parse into a process-terminating internal engine limit (a per-object
// property ceiling, or the array backing-store length limit) that is an
// uncatchable abort, not a thrown exception, so no try/catch around the parse
// can intercept it -- the only defense is to reject the body before the parse
// can reach the limit. MAX_JSON_OBJECT_KEYS caps the members of any one object;
// it sits far above the widest legitimate object (the linkage-terms
// transform.params record at MAX_PARAMS_ENTRIES = 256, every other message
// being shallower) and far below the per-object engine limit. MAX_JSON_ARRAY_
// ELEMENTS caps the elements of any one array; legitimate array-bearing messages
// (the PSI association indices, payload rows / row indices, mapped-element pairs)
// are sized by the matched record count, itself transport-bounded to a few
// million, so this sits above any real array yet well below the engine's array
// length limit. MAX_JSON_NESTING_DEPTH caps structural nesting; legitimate
// messages nest only a few levels (the parsed-config ceiling is camelizeKeys'
// 256), so this only catches a degenerate all-`{`/`[` body, and it doubles as
// the bound on the pre-parse scan's own per-container stack. Each sits far above
// any real container and below the engine limit, so none ever pre-empts a clean
// schema-level rejection or a legitimate large message. See
// docs/spec/CHANNEL_SECURITY.md.
/** @internal */
export const MAX_JSON_OBJECT_KEYS = 65536;
/** @internal */
export const MAX_JSON_ARRAY_ELEMENTS = 16_777_216;
/** @internal */
export const MAX_JSON_NESTING_DEPTH = 4096;

/**
 * Thrown by {@link parseBoundedJson} when the input's structure exceeds a bound,
 * distinct from the `SyntaxError`/`TypeError` a malformed or invalid-UTF-8 body
 * throws. The message is fixed text carrying no input bytes; a caller maps it to
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
 * The single chokepoint for parsing UNTRUSTED JSON -- a partner wire frame, a
 * transport-controlled file, an invitation token: any body an attacker (the
 * exchange counterparty or a hostile transport/server admin) can shape. It
 * structurally bounds the body BEFORE handing it to `JSON.parse`, so a
 * partner-or-server-controlled object/array cannot drive the parser into an
 * uncatchable, process-terminating engine abort. Bytes are decoded UTF-8-fatal
 * (invalid UTF-8 throws rather than silently substituting U+FFFD); a string
 * (already decoded by the transport) is scanned and parsed as-is.
 *
 * Throws {@link JsonStructureBoundError} when a structural bound is exceeded, or
 * the native error of a malformed or invalid-UTF-8 body. Every parse of
 * untrusted JSON in `@psilink/core` MUST route through here; an ESLint rule
 * forbids a raw `JSON.parse` elsewhere in the package (a trusted parse opts out
 * with a justified `eslint-disable`). See docs/spec/CHANNEL_SECURITY.md.
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
