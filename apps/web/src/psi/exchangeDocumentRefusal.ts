/**
 * Naming the settings a refused exchange file holds, as the FILE spells them.
 *
 * Two readers of an operator-written `alcove.yaml` share this: the managed
 * exchange's configuration import ({@link ./managed/managedCommandLineImport.ts})
 * and the console's mount load ({@link ../jobs/configLoad.ts}). Both refuse a
 * document the shared schema rejects, and both must point the operator at a line
 * of their own file -- snake_case under the path of the block holding it, never
 * the camelCase of the parsed shape (docs/spec/EXCHANGE_FILE.md, "How a setting
 * is named").
 *
 * Only NAMES leave here. A setting's value can be a credential, an address, or a
 * path, so no issue message and no document value ever enters a refusal: a
 * built-in Zod code composes the offending value into its own message.
 *
 * The two readers word their own sentences around this list. What an operator
 * does about a stored field they cannot see differs from what they do about a
 * line in the file in front of them, and the allowlists they measure against
 * differ too -- the managed import takes a credential-free webrtc locator, the
 * console owns the mount and takes credentials and paths.
 */

import { snakeizeKey } from "@alcove/core";

import type { ZodError } from "zod";

/**
 * How many offending fields a refusal names before it counts the rest. A
 * hand-edited file with one mistake names it; a file off the schema wholesale
 * would otherwise list every field of it in one message.
 */
export const MAX_REFUSED_FIELDS_NAMED = 5;

/** One field name joined onto the path of the block holding it. */
function joinFieldPath(parent: string, field: string): string {
  return parent === "" ? field : `${parent}.${field}`;
}

/**
 * One key of a document object as the FILE spells it, or undefined when the
 * object holds no such key. The schema reads a camelized copy of the document,
 * so a key the file wrote in snake_case reaches a Zod issue under its camelCase
 * name; the file's own object holds one spelling or the other.
 */
export function keyAsWritten(
  container: unknown,
  key: string,
): string | undefined {
  if (typeof container !== "object" || container === null) return undefined;
  const written = container as Record<string, unknown>;
  if (Object.hasOwn(written, key)) return key;
  const snakeized = snakeizeKey(key);
  return Object.hasOwn(written, snakeized) ? snakeized : undefined;
}

/**
 * The document's own value at a Zod issue's path, walked segment by segment in
 * whichever spelling the file writes ({@link keyAsWritten}).
 */
export function documentValueAt(
  document: unknown,
  path: ReadonlyArray<PropertyKey>,
): unknown {
  return path.reduce<unknown>((value, segment) => {
    if (typeof segment === "number")
      return Array.isArray(value) ? value[segment] : undefined;
    const key = keyAsWritten(value, String(segment));
    return key === undefined
      ? undefined
      : (value as Record<string, unknown>)[key];
  }, document);
}

/**
 * One Zod issue path as the FILE spells it: snake_case keys ({@link snakeizeKey},
 * since the schema parses the camelized shape), array indices in brackets, and
 * the path cut at a `params` segment -- the key inside that free-form record is
 * the author's own text, and the block locates the problem well enough.
 *
 * `writtenKey` is a key the schema does not name, joined onto that path as the
 * file spells it and NOT snakeized: it is read back out of the document rather
 * than derived from the camelized shape, and rewriting it would name a line the
 * file does not hold (`Mystery-Key` renders as `_mystery-_key`). A cut path
 * drops it, for the reason the cut has.
 */
export function documentFieldPath(
  path: ReadonlyArray<PropertyKey>,
  writtenKey?: string,
): string {
  const paramsIndex = path.indexOf("params");
  const segments = paramsIndex >= 0 ? path.slice(0, paramsIndex + 1) : path;
  const rendered = segments.reduce<string>(
    (renderedPath, segment) =>
      typeof segment === "number"
        ? `${renderedPath}[${segment}]`
        : joinFieldPath(renderedPath, snakeizeKey(String(segment))),
    "",
  );
  return writtenKey === undefined || paramsIndex >= 0
    ? rendered
    : joinFieldPath(rendered, writtenKey);
}

/**
 * The fields one Zod issue names, as the FILE spells them. A key outside the
 * schema is reported at its PARENT object's path -- empty for a top-level key --
 * with the offending names on `keys`, so naming the key itself takes joining
 * each of them onto that path, spelled as the document under that path spells
 * it. Every other issue names the field its path points at, and an issue at the
 * document root names none.
 */
function refusedFields(
  issue: ZodError["issues"][number],
  document: unknown,
): Array<string> {
  if (issue.code === "unrecognized_keys") {
    const container = documentValueAt(document, issue.path);
    return issue.keys.map((key) =>
      documentFieldPath(issue.path, keyAsWritten(container, key) ?? key),
    );
  }
  const field = documentFieldPath(issue.path);
  return field === "" ? [] : [field];
}

/**
 * Every field a schema refusal names, each once and in issue order. Empty for a
 * document the schema rejected at its root, which names no line to fix -- the
 * caller's own sentence says so.
 */
export function refusedDocumentFields(
  error: ZodError,
  document: unknown,
): Array<string> {
  return [
    ...new Set(error.issues.flatMap((issue) => refusedFields(issue, document))),
  ];
}

/**
 * A field list as a refusal states it: the first
 * {@link MAX_REFUSED_FIELDS_NAMED} names, then a count of the rest.
 */
export function namedFieldList(fields: ReadonlyArray<string>): string {
  const named = fields.slice(0, MAX_REFUSED_FIELDS_NAMED);
  const beyond = fields.length - named.length;
  return beyond > 0
    ? `${named.join(", ")}, and ${beyond} more`
    : named.join(", ");
}
