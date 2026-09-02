// The encoder that builds every machine-readable JSON line the CLI prints: the
// two `probe-host-key --json` emits (apps/cli/src/commands/probeHostKey.ts:
// probeJsonLine and probeDiagnosisJsonLine) and the `doctor --json` verdict
// (apps/cli/src/doctor/verdict.ts: verdictJson). Each carries text chosen
// somewhere other than this codebase -- the probe's excerpt is a latin1 decode
// of bytes an untrusted peer sent, and a doctor check's meaning and action
// interpolate the operator's own SMB_* values and, on two arms, an smbclient
// NT_STATUS token -- so these lines have to be safe as BYTES, not only valid as
// JSON: `JSON.stringify` escapes U+0000-U+001F, the quote, and the backslash,
// which is enough to keep a line one line, but it passes DEL and the C1 range
// straight through, and a value some other party chose can carry either.
//
// One machine-readable stream sits outside that set and is named rather than
// covered: the opt-in fd-3 NDJSON events (apps/cli/src/eventStream.ts), which
// serialize with a bare `JSON.stringify`. Their text arrives display-escaped
// from composition (`redactAndSanitizeForDisplay` / `sanitizeErrorForDisplay`,
// whose output is printable ASCII), so what holds those bytes is that boundary
// one layer up rather than this encoder -- which is a property of the fields
// that stream carries today, pinned there rather than here (eventStream.test.ts,
// "every event serializes to a printable-ASCII line").
//
// This escapes them the way JSON already escapes a control byte, so the property
// costs nothing at the consumer: `\uHHHH` is JSON's own escape, and the document
// it produces parses to exactly the value `JSON.stringify` alone would have
// produced. That is what keeps it OFF the display-escaping ladder -- it is an
// encoding of the line, not a sanitization of the value, so a consumer that
// renders a parsed field to a human still escapes it there exactly once (see
// CONTRIBUTING.md, Operator-facing escaping).

/** A value {@link asciiSafeJsonLine} accepts: the JSON shapes a machine-readable
 * line is built from. `undefined` is admitted for the optional-key idiom
 * (`...(x !== undefined ? { k: x } : {})` and a plain `k: undefined`), which
 * `JSON.stringify` drops. */
export type JsonLineValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<JsonLineValue>
  | JsonLineObject;

/** The object a machine-readable line's top level is: a record of
 * {@link JsonLineValue}. */
export interface JsonLineObject {
  readonly [key: string]: JsonLineValue | undefined;
}

/**
 * Every UTF-16 code unit outside printable ASCII (U+0020-U+007E). Matched by
 * code UNIT rather than code point, and so without the `u` flag: a surrogate
 * pair then escapes as the two units JSON defines for it -- which `JSON.parse`
 * recombines -- rather than as one code point JSON has no escape for. Units
 * below U+0020 are in the class only so the rule is stated whole; `JSON.stringify`
 * has already escaped every one of them by the time this runs.
 */
const NON_PRINTABLE_ASCII_UNIT = /[^\x20-\x7e]/g;

/**
 * Serialize `fields` as ONE line of machine-readable JSON whose every byte is
 * printable ASCII, so the line is safe to print as it stands -- no DEL, no C1
 * byte, no ESC driving an ANSI sequence, and nothing that could break the line
 * in two -- however untrusted the values it carries.
 *
 * It is `JSON.stringify` plus a rewrite of the encoded TEXT, so the keys, the
 * value types, and the parsed values are exactly what `JSON.stringify` alone
 * produces: a consumer sees the same document, and one that escapes a parsed
 * field for display escapes it once, at its own sink, with nothing here to
 * double.
 *
 * This is not a redaction and not a display escape. A value carrying material
 * that must not be shown is redacted where it is composed, and a value rendered
 * to a human is escaped at the sink that renders it.
 */
export function asciiSafeJsonLine(fields: JsonLineObject): string {
  return JSON.stringify(fields).replace(
    NON_PRINTABLE_ASCII_UNIT,
    (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
