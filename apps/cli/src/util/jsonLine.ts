// The encoder that builds every machine-readable JSON line the CLI prints
// (probe-host-key --json, doctor --json). The opt-in fd-3 NDJSON event
// stream sits outside it -- it is display-escaped at composition instead,
// which eventStream.test.ts pins. See docs/spec/CHANNEL_SECURITY.md, SFTP
// host-key verification, for why `JSON.stringify` alone is not enough and how
// this stays off the display-escaping ladder (CONTRIBUTING.md,
// Operator-facing escaping).

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
 * printable ASCII -- safe to print as it stands, however untrusted the
 * values it holds (see the file header). It is `JSON.stringify` plus a
 * rewrite of the encoded TEXT only: the keys, value types, and parsed values
 * are exactly what `JSON.stringify` alone produces. Not a redaction and not
 * a display escape -- see CONTRIBUTING.md, Operator-facing escaping.
 */
export function asciiSafeJsonLine(fields: JsonLineObject): string {
  return JSON.stringify(fields).replace(
    NON_PRINTABLE_ASCII_UNIT,
    (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
