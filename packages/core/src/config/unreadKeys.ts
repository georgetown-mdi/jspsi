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
 *
 * A third pass ({@link unrecognizedKeysAsWritten}) names the keys of every such
 * issue -- the two above and the ones the strict blocks raise themselves -- as
 * the raw document spells them, the one place that naming is decided.
 */

import { z } from "zod";

import { camelizeKey, OPAQUE_VALUE_KEYS } from "../utils/camelizeKeys.js";

/** An object with keys to compare: an array is walked by element instead. */
function isKeyedObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * What an `unrecognized_keys` issue says, in the wording Zod's own strict
 * objects use, so a refusal this module raises and one the schema raises read
 * alike and {@link unrecognizedKeysAsWritten} can reword either.
 */
function unrecognizedKeysMessage(keys: ReadonlyArray<string>): string {
  const named = keys.map((key) => `"${key}"`).join(", ");
  return keys.length === 1
    ? `Unrecognized key: ${named}`
    : `Unrecognized keys: ${named}`;
}

/**
 * The issue one block's dropped keys raise: the block's own path with the keys
 * on `keys`, as a strict object's refusal reports them. The keys are the
 * camelized document's, which {@link unrecognizedKeysAsWritten} puts back into
 * the document's own spelling.
 *
 * It holds no `input`, as a strict object's own refusal holds none: the block a
 * dropped key sits in can hold a credential, and `ZodError.message` renders
 * every field of every issue.
 */
function unreadKeysIssue(
  path: ReadonlyArray<PropertyKey>,
  keys: ReadonlyArray<string>,
): z.core.$ZodIssue {
  return {
    code: "unrecognized_keys",
    keys: [...keys],
    path: [...path],
    message: unrecognizedKeysMessage(keys),
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

/**
 * The key one raw object writes for a camelized name: the sibling that
 * {@link camelizeKey} reads as that name, or the name itself where the object
 * holds no such sibling -- a caller that passed an already-camelized value, and
 * a key the case conversion leaves alone.
 */
function keyAsWritten(node: unknown, camelizedKey: string): string {
  if (!isKeyedObject(node) || Object.hasOwn(node, camelizedKey))
    return camelizedKey;
  return (
    Object.keys(node).find((key) => camelizeKey(key) === camelizedKey) ??
    camelizedKey
  );
}

/** The raw document's node at one issue path, whose segments are camelized. */
function nodeAtPath(
  document: unknown,
  path: ReadonlyArray<PropertyKey>,
): unknown {
  let node = document;
  for (const segment of path) {
    if (Array.isArray(node)) {
      node = node[Number(segment)];
      continue;
    }
    if (!isKeyedObject(node)) return undefined;
    node = node[keyAsWritten(node, String(segment))];
  }
  return node;
}

/**
 * One `unrecognized_keys` message with each renamed key put back into the
 * spelling the document holds. A message of this kind names the keys the issue
 * holds and nothing else of the document, so substituting them leaves the rest
 * of the wording as its author wrote it -- a block's own guidance for the
 * operator (`connection.ts`) as much as Zod's default.
 *
 * Longest key first, so one key that is the start of another is not rewritten
 * inside it.
 */
function messageNamingWrittenKeys(
  message: string,
  keys: ReadonlyArray<string>,
  written: ReadonlyArray<string>,
): string {
  return keys
    .map((key, index) => [key, written[index]] as const)
    .sort(([left], [right]) => right.length - left.length)
    .reduce((worded, [key, name]) => worded.split(key).join(name), message);
}

/**
 * Every `unrecognized_keys` issue of a camelize-then-parse refusal, with each
 * key named as the RAW document spells it and the message reworded to match:
 * the schema works on the camelized shape, so a key it reports is the case
 * conversion's output rather than a line the operator's file holds
 * (docs/spec/EXCHANGE_FILE.md, "How a setting is named"). Every other issue is
 * returned unchanged, keys and message both.
 *
 * The key is looked up rather than converted back, so a document that writes it
 * in camelCase or outside either convention (`Mystery-Key`) is named the way it
 * wrote it, which no conversion of the camelized name would yield.
 *
 * An issue whose keys the document already writes that way is returned
 * untouched: there is nothing to rename, which is the state the collision issue
 * below is always in ({@link collidingKeysIssue} names two spellings the
 * document holds side by side).
 *
 * @internal not a stable public API.
 */
export function unrecognizedKeysAsWritten(
  rawDocument: unknown,
  issues: ReadonlyArray<z.core.$ZodIssue>,
): Array<z.core.$ZodIssue> {
  return issues.map((issue) => {
    if (issue.code !== "unrecognized_keys") return issue;
    const node = nodeAtPath(rawDocument, issue.path ?? []);
    const written = issue.keys.map((key) => keyAsWritten(node, key));
    if (written.every((key, index) => key === issue.keys[index])) return issue;
    return {
      ...issue,
      keys: written,
      message: messageNamingWrittenKeys(issue.message, issue.keys, written),
    };
  });
}

/**
 * Every setting a document states that its parse result does not hold, as Zod
 * issues naming each key as the document wrote it: a key no block read, an
 * entry the one-entry-per-column collapse dropped, and a setting written under
 * two spellings of one key.
 *
 * The whole of the unread-key rule for a caller holding a successful parse,
 * applied to a whole exchange file (`parseExchangeSpec`) or to one block of it
 * read on its own.
 *
 * @param rawDocument the document as the file writes it.
 * @param camelizedDocument the same document as the schema read it.
 * @param parsed the schema's parse result.
 * @internal not a stable public API.
 */
export function droppedSettingIssues(
  rawDocument: unknown,
  camelizedDocument: unknown,
  parsed: unknown,
): Array<z.core.$ZodIssue> {
  return unrecognizedKeysAsWritten(rawDocument, [
    ...collidingKeyIssues(rawDocument),
    ...unreadKeyIssues(camelizedDocument, parsed),
  ]);
}
