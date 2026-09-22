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
 * Two comparisons, run over one document:
 *
 * - the camelized document against the parse result ({@link unreadKeyIssues}),
 *   which reports a key no block read and an array entry a normalizing schema
 *   dropped;
 * - the RAW document against itself ({@link collidingKeyIssues}), which reports
 *   two sibling keys the camelize pre-pass reads as one name, where the pre-pass
 *   keeps one of the two and the comparison above cannot see the other.
 *
 * Both report Zod issues, the shape a schema's own refusal takes, so a reader
 * that already words a refusal from those issues words these with no code of its
 * own.
 */

import { z } from "zod";

import {
  camelizeKey,
  OPAQUE_VALUE_KEYS,
  snakeizeKey,
} from "../utils/camelizeKeys.js";

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
 * The issue a document entry dropped by the one-entry-per-column collapse
 * raises: its own path, and a message naming the column and the entry kept in
 * its place. The column NAME is the entry's identity -- the key the collapse
 * compares on -- and is the only part of the entry the message holds; a
 * description or any other value the entry states stays out, as it does
 * everywhere else here.
 */
function collapsedEntryIssue(
  path: ReadonlyArray<PropertyKey>,
  index: number,
  survivorIndex: number,
  name: string,
): z.core.$ZodIssue {
  return {
    code: "custom",
    path: [...path],
    message:
      `Entry ${index} names the column "${name}", which entry ` +
      `${survivorIndex} already names. Only the first entry naming a column ` +
      `is kept, so what entry ${index} states beyond it would be lost. Fold ` +
      `it into entry ${survivorIndex}, or remove it.`,
  };
}

/**
 * The issue two spellings of one key raise: the block's own path, both keys
 * exactly as the document writes them on `keys`, and a message naming them.
 *
 * Reported as the same `unrecognized_keys` issue an unread key is -- one of the
 * two spellings is not read, and which one is not the operator's to predict --
 * so a reader that names the keys of such an issue names both lines to fix with
 * no code of its own.
 */
function collidingKeysIssue(
  path: ReadonlyArray<PropertyKey>,
  keys: ReadonlyArray<string>,
): z.core.$ZodIssue {
  const quoted = keys.map((key) => `"${key}"`);
  const named = `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
  return {
    code: "unrecognized_keys",
    keys: [...keys],
    path: [...path],
    message:
      `Keys ${named} are read as one setting, so only one of them is kept. ` +
      `Write the setting once.`,
  };
}

/**
 * The name the one-entry-per-column collapse (`columnsNamedOnce`) compares an
 * entry on: a payload dictionary entry's `name`, or the string itself in a list
 * written as bare column names. `undefined` for anything else, which is an array
 * this alignment cannot read.
 */
function collapsedEntryName(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (isKeyedObject(value) && typeof value.name === "string") return value.name;
  return undefined;
}

/** One document entry's place in a shortened result. */
type AlignedEntry = { counterpart: unknown } | { duplicateOf: number };

/**
 * Line each entry of a document array up with the result's, where the result is
 * shorter than the document because the one-entry-per-column collapse dropped
 * an entry naming a column an earlier entry names.
 *
 * `undefined` where the shortening is not that collapse -- an entry with no name
 * to compare on, or a result that is not the document's distinct names in
 * order -- leaving the caller to fall back on comparing every entry against all
 * of the result's.
 */
function alignCollapsedArray(
  document: ReadonlyArray<unknown>,
  result: ReadonlyArray<unknown>,
): Array<AlignedEntry> | undefined {
  const names: Array<string> = [];
  for (const element of document) {
    const name = collapsedEntryName(element);
    if (name === undefined) return undefined;
    names.push(name);
  }
  const survivorOf = new Map<string, number>();
  names.forEach((name, index) => {
    if (!survivorOf.has(name)) survivorOf.set(name, index);
  });
  if (survivorOf.size !== result.length) return undefined;
  const counterpartOf = new Map<string, unknown>();
  let position = 0;
  for (const name of survivorOf.keys()) {
    if (collapsedEntryName(result[position]) !== name) return undefined;
    counterpartOf.set(name, result[position]);
    position += 1;
  }
  return names.map((name, index) =>
    survivorOf.get(name) === index
      ? { counterpart: counterpartOf.get(name) }
      : { duplicateOf: survivorOf.get(name) as number },
  );
}

/**
 * Whether everything one document entry states the other states too, with the
 * same value: a dropped entry that states nothing beyond the entry kept in its
 * place loses nothing when it is dropped, so it is a line written twice rather
 * than a setting discarded. Both sides come from the same document, so the
 * comparison is between two authored values and no parse transform sits between
 * them.
 */
function statesNothingBeyond(entry: unknown, kept: unknown): boolean {
  if (isKeyedObject(entry))
    return (
      isKeyedObject(kept) &&
      Object.entries(entry).every(
        ([key, value]) =>
          value === undefined ||
          (Object.hasOwn(kept, key) && statesNothingBeyond(value, kept[key])),
      )
    );
  if (Array.isArray(entry))
    return (
      Array.isArray(kept) &&
      entry.length === kept.length &&
      entry.every((element, index) => statesNothingBeyond(element, kept[index]))
    );
  return Object.is(entry, kept);
}

/**
 * Walk one node of the document against the value (or values) the parse result
 * holds at the same place, collecting the keys none of them holds.
 *
 * `parsed` is a list rather than one value because a normalizing schema can
 * shorten an array: the payload dictionary collapses two entries naming one
 * column to the first of them, so element `i` of the document is not element `i`
 * of the result. Where the lengths agree each element is compared with its own
 * counterpart. Where the collapse shortened the array
 * ({@link alignCollapsedArray}), an entry that survived is compared with the
 * entry it became, and one that was dropped is reported as the duplicate it is
 * unless it states nothing beyond the entry kept in its place -- never as keys
 * no block reads, which is what a document entry with no counterpart would
 * otherwise look like. Where neither alignment holds, every element of the
 * document is compared against all of the result's, which reports a key no
 * surviving entry holds and lets one that some entry does hold stand.
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
    if (arrays.length === 1) {
      const result = arrays[0];
      if (result.length === document.length) {
        document.forEach((element, index) =>
          collectUnreadKeys(element, [result[index]], [...path, index], issues),
        );
        return;
      }
      const alignment = alignCollapsedArray(document, result);
      if (alignment !== undefined) {
        alignment.forEach((entry, index) => {
          if (!("duplicateOf" in entry)) {
            collectUnreadKeys(
              document[index],
              [entry.counterpart],
              [...path, index],
              issues,
            );
            return;
          }
          if (statesNothingBeyond(document[index], document[entry.duplicateOf]))
            return;
          issues.push(
            collapsedEntryIssue(
              [...path, index],
              index,
              entry.duplicateOf,
              collapsedEntryName(document[index]) as string,
            ),
          );
        });
        return;
      }
    }
    const elements = arrays.flat();
    document.forEach((element, index) =>
      collectUnreadKeys(element, elements, [...path, index], issues),
    );
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

/** Walk one node of the raw document for sibling keys that read as one name. */
function collectCollidingKeys(
  document: unknown,
  path: ReadonlyArray<PropertyKey>,
  issues: Array<z.core.$ZodIssue>,
): void {
  if (Array.isArray(document)) {
    document.forEach((element, index) =>
      collectCollidingKeys(element, [...path, index], issues),
    );
    return;
  }
  if (!isKeyedObject(document)) return;
  const spellings = new Map<string, Array<string>>();
  for (const [key, value] of Object.entries(document)) {
    const name = camelizeKey(key);
    const written = spellings.get(name);
    if (written === undefined) spellings.set(name, [key]);
    else written.push(key);
    if (OPAQUE_VALUE_KEYS.has(name)) continue;
    collectCollidingKeys(value, [...path, name], issues);
  }
  for (const written of spellings.values())
    if (written.length > 1) issues.push(collidingKeysIssue(path, written));
}

/**
 * Every key of a camelized document that its parse result does not hold, as
 * Zod `unrecognized_keys` issues, and every document entry the one-entry-per-
 * column collapse dropped that stated something the entry kept did not.
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

/**
 * Every place the RAW document writes one setting under two sibling keys that
 * `camelizeKeys` reads as one name -- `expected_payload_columns` beside
 * `expectedPayloadColumns` -- as Zod issues naming both keys as written, under
 * the path of the block holding them.
 *
 * The pre-pass keeps one of the two and the parse result holds that one, so the
 * document-against-result comparison sees nothing missing: this is the reading
 * of the rule for the step that runs BEFORE the schema. Every caller reaches it
 * with a value `camelizeKeys` has already walked, so the depth and width bounds
 * hold over this walk too.
 *
 * An opaque subtree is not entered, as the pre-pass does not enter it: its keys
 * are kept verbatim, so two spellings there are two keys.
 *
 * @internal not a stable public API.
 */
export function collidingKeyIssues(
  rawDocument: unknown,
): Array<z.core.$ZodIssue> {
  const issues: Array<z.core.$ZodIssue> = [];
  collectCollidingKeys(rawDocument, [], issues);
  return issues;
}
