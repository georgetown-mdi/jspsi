/**
 * The keys a document held that its parse result does not: what a schema
 * dropped rather than read.
 *
 * The exchange file is one schema three applications consume, and a consumer
 * that parses a document, edits part of it, and writes it back out writes the
 * PARSE RESULT. A key the parse dropped is therefore gone from the file the next
 * writer produces, so dropping one silently loses a setting the operator wrote
 * (docs/spec/EXCHANGE_FILE.md, "What a consumer does with a setting it cannot
 * honor"). The top level, `authentication`, and the connection union's webrtc
 * member are strict and refuse an unrecognized key themselves; every other block
 * of the spec strips one, and this is what finds it.
 *
 * Reported as Zod `unrecognized_keys` issues, the exact shape a strict object
 * raises, so a reader that already words a refusal from those issues words this
 * one with no code of its own.
 */

import { z } from "zod";

import { OPAQUE_VALUE_KEYS, snakeizeKey } from "../utils/camelizeKeys.js";

/** An object with keys to compare: an array is walked by element instead. */
function isKeyedObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The issue one block's dropped keys raise: the block's own path with the keys
 * on `keys`, as a strict object's refusal reports them, and a message naming
 * each key in the snake_case the document writes ({@link snakeizeKey}, whose
 * limit on a key outside that convention is its own).
 *
 * It holds no `input`, as a strict object's own refusal holds none: the block a
 * dropped key sits in can hold a credential, and `ZodError.message` renders
 * every field of every issue.
 */
function unreadKeysIssue(
  path: ReadonlyArray<PropertyKey>,
  keys: ReadonlyArray<string>,
): z.core.$ZodIssue {
  const named = keys.map((key) => `"${snakeizeKey(key)}"`).join(", ");
  return {
    code: "unrecognized_keys",
    keys: [...keys],
    path: [...path],
    message:
      keys.length === 1
        ? `Unrecognized key: ${named}`
        : `Unrecognized keys: ${named}`,
  };
}

/**
 * Walk one node of the document against the value (or values) the parse result
 * holds at the same place, collecting the keys none of them holds.
 *
 * `parsed` is a list rather than one value because a normalizing schema can
 * shorten an array: the payload dictionary collapses two entries naming one
 * column to the first of them, so element `i` of the document is not element `i`
 * of the result. Where the lengths agree each element is compared with its own
 * counterpart; where they do not, every element of the document is compared
 * against all of the result's, which reports a key no surviving entry holds and
 * lets one that some entry does hold stand.
 *
 * An opaque subtree ({@link OPAQUE_VALUE_KEYS}) is not entered: its keys are the
 * author's own free-form record, kept verbatim by both the camelize pre-pass and
 * the schema, so there is nothing there to drop.
 */
function collectUnreadKeys(
  document: unknown,
  parsed: ReadonlyArray<unknown>,
  path: ReadonlyArray<PropertyKey>,
  issues: Array<z.core.$ZodIssue>,
): void {
  if (Array.isArray(document)) {
    const arrays = parsed.filter((value): value is unknown[] =>
      Array.isArray(value),
    );
    if (arrays.length === 0) return;
    const aligned =
      arrays.length === 1 && arrays[0].length === document.length
        ? arrays[0]
        : undefined;
    const elements = arrays.flat();
    document.forEach((element, index) => {
      collectUnreadKeys(
        element,
        aligned === undefined ? elements : [aligned[index]],
        [...path, index],
        issues,
      );
    });
    return;
  }
  if (!isKeyedObject(document)) return;
  const objects = parsed.filter(isKeyedObject);
  if (objects.length === 0) return;
  const unread: Array<string> = [];
  for (const [key, value] of Object.entries(document)) {
    // A key set to `undefined` states nothing for a writer to lose: the document
    // a file yields never holds one, and a caller passing an object can.
    if (value === undefined) continue;
    const holders = objects.filter((object) => Object.hasOwn(object, key));
    if (holders.length === 0) {
      unread.push(key);
      continue;
    }
    if (OPAQUE_VALUE_KEYS.has(key)) continue;
    collectUnreadKeys(
      value,
      holders.map((object) => object[key]),
      [...path, key],
      issues,
    );
  }
  if (unread.length > 0) issues.push(unreadKeysIssue(path, unread));
}

/**
 * Every key of a camelized document that its parse result does not hold, as
 * Zod `unrecognized_keys` issues.
 *
 * Runs on a SUCCESSFUL parse only: a field the schema accepts and then strips
 * for a type it does not declare is refused by that schema's own rule before
 * this ever sees it (the SFTP server block's `certificate` and `known_hosts`).
 *
 * @param camelizedDocument the document as the schema read it, after
 *   `camelizeKeys`, so both sides spell a key one way.
 * @param parsed the schema's parse result.
 * @internal not a stable public API.
 */
export function unreadKeyIssues(
  camelizedDocument: unknown,
  parsed: unknown,
): Array<z.core.$ZodIssue> {
  const issues: Array<z.core.$ZodIssue> = [];
  collectUnreadKeys(camelizedDocument, [parsed], [], issues);
  return issues;
}
