// Only `stringify` is imported from `yaml`: the raw parsers are ESLint-banned in
// the web app (they leak source into errors), so import routes through core's
// shared sensitive-file chokepoint instead. `stringify` has no such channel.
import { stringify as stringifyYaml } from "yaml";

import {
  parseSensitiveJson,
  parseSensitiveYaml,
  safeParseLinkageTerms,
  sanitizeForDisplay,
  snakeizeKey,
  snakeizeKeys,
} from "@psilink/core";

import type { LinkageTerms } from "@psilink/core";
import type { ZodError } from "zod";

/**
 * The JSON/YAML authoring path for the expert linkage-terms editor: serialize
 * the authored terms to a portable document, and parse one back. Pure and
 * React-free, so the round-trip is the tested boundary.
 *
 * Export emits the snake_case on-disk form ({@link snakeizeKeys}), the same
 * shape `psilink.yaml` uses, and re-imports cleanly through
 * {@link safeParseLinkageTerms}. Import is the only path by which
 * authored-elsewhere terms reach the editor, and it is the single validation
 * source; there is no verbatim-embed path, by design.
 *
 * The raw parse goes through core's sensitive-file chokepoint
 * ({@link parseSensitiveJson} / {@link parseSensitiveYaml}), not a raw parser:
 * an imported document is untrusted free text that could hold a pasted
 * secret, and a raw parser leaks a span of source into its error message.
 */

/** A document format the editor can write. Import auto-detects, so it needs no
 * format argument; export must choose one. */
export type LinkageTermsFormat = "json" | "yaml";

/**
 * Upper bound on an imported document, in characters (UTF-16 code units): a
 * hard ceiling applied before the JSON/YAML parse, so a pathological document
 * cannot drive the parser before the schema's own structural bounds can bite.
 * Generous on purpose -- the invitation token path caps at 64 KiB, and a
 * GUI-exported document holding every key, transform, and description is
 * still well under this -- and sized for an operator workstation. Tunable.
 */
export const MAX_IMPORT_CHARS = 1_000_000;

/** A successfully imported, validated set of linkage terms. */
export interface LinkageTermsImportSuccess {
  success: true;
  terms: LinkageTerms;
}

/** A rejected import, with a readable, value-free reason for the editor to show
 * inline. The message never echoes a parsed value (an imported document is
 * untrusted free text), consistent with the no-echo parse-error contract the
 * core schema's referential-integrity refines rely on. */
export interface LinkageTermsImportFailure {
  success: false;
  error: string;
}

export type LinkageTermsImportResult =
  LinkageTermsImportSuccess | LinkageTermsImportFailure;

/**
 * Serialize linkage terms to a snake_case `format` document. JSON is pretty-
 * printed with a trailing newline; YAML is the library's block form. The keys are
 * snake_cased ({@link snakeizeKeys}) so the output matches the user-facing on-disk
 * form and re-imports through {@link importLinkageTerms} to equal terms.
 */
export function exportLinkageTerms(
  terms: LinkageTerms,
  format: LinkageTermsFormat,
): string {
  const snake = snakeizeKeys(terms);
  return format === "yaml"
    ? stringifyYaml(snake)
    : JSON.stringify(snake, null, 2) + "\n";
}

/**
 * The linkage-terms value inside a parsed document: the whole document when
 * it IS a terms document, or its `linkage_terms` block when it is an exchange
 * configuration wrapping one. Mirrors the CLI's `readConfigLinkageSource`
 * (both spellings), so a pasted `psilink.yaml` reads the same as
 * `--config-file`; only that one key is read, so nothing else in the
 * configuration is parsed or validated here. A document holding no such key
 * passes through unchanged.
 */
function linkageTermsWithin(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const document = raw as Record<string, unknown>;
  const wrapped = document["linkage_terms"] ?? document["linkageTerms"];
  return wrapped ?? raw;
}

/**
 * Parse a JSON or YAML document into validated {@link LinkageTerms}, or
 * return a readable rejection. Accepts either an exported terms document or
 * an exchange configuration defining `linkage_terms` (see
 * {@link linkageTermsWithin}). Format is auto-detected: JSON first (stricter,
 * cheaper), then YAML. Validated by {@link safeParseLinkageTerms}, which
 * camelizes first, so a document from {@link exportLinkageTerms} round-trips.
 * Length-capped at {@link MAX_IMPORT_CHARS} before either parse; YAML alias
 * expansion is bounded by the `yaml` parser's default `maxAliasCount`.
 */
export function importLinkageTerms(text: string): LinkageTermsImportResult {
  if (text.length > MAX_IMPORT_CHARS)
    return {
      success: false,
      error:
        "This document is too large to import. Linkage terms are far smaller " +
        "than this; check that you pasted the right file.",
    };

  // Each chokepoint throws a path-only UsageError on failure; discarded in
  // favor of our own value-free message below.
  const label = "the imported document";
  let raw: unknown;
  try {
    raw = parseSensitiveJson(text, label);
  } catch {
    try {
      raw = parseSensitiveYaml(text, label);
    } catch {
      return {
        success: false,
        error:
          "This is not valid JSON or YAML. Check the document for a syntax " +
          "error and try again.",
      };
    }
  }

  const parsed = safeParseLinkageTerms(linkageTermsWithin(raw));
  if (!parsed.success)
    return { success: false, error: readableTermsError(parsed.error) };

  return { success: true, terms: parsed.data };
}

/**
 * Reduce a linkage-terms {@link ZodError} to one readable line that locates
 * the first problem without echoing any parsed value. Built-in Zod messages
 * can quote the offending value, so this never forwards `issue.message` for a
 * built-in code -- it maps the code to fixed copy and shows only the
 * structural `path`. The schema's own referential-integrity / dialect
 * refines (`custom` code) hold value-free static messages by design, so
 * those show verbatim. The whole line runs through
 * {@link sanitizeForDisplay} as a fallback.
 */
function readableTermsError(error: ZodError): string {
  if (error.issues.length === 0)
    return "The imported terms are not valid linkage terms.";
  const issue = error.issues[0];

  // Locate the problem by its structural path (schema field names and array
  // indices), never a parsed value. The one partner-controlled segment a path
  // can hold is a transform `params` record key (`params` is a `z.record` over
  // arbitrary keys); truncate the path at `params` so that key cannot leak into
  // the message -- everything before it is fixed schema structure.
  //
  // Each segment is named in the snake_case the document writes it in:
  // {@link safeParseLinkageTerms} camelizes before validating, so an issue path
  // locates its field by the camelCase name, while the operator is reading the
  // file {@link exportLinkageTerms} wrote -- through {@link snakeizeKeys}, of
  // which {@link snakeizeKey} is the per-key half.
  const paramsIndex = issue.path.indexOf("params");
  const safePath =
    paramsIndex >= 0 ? issue.path.slice(0, paramsIndex + 1) : issue.path;
  const where =
    safePath.length > 0
      ? safePath.map((segment) => snakeizeKey(String(segment))).join(".")
      : "the document";

  // Fixed, value-free phrasing per Zod code. `custom` is the schema's own refines
  // (static, value-free messages by design), so those are shown verbatim; every
  // other code gets fixed copy so a built-in message cannot leak a parsed value.
  const reason =
    issue.code === "custom"
      ? issue.message
      : issue.code === "invalid_type"
        ? "is missing or has the wrong type"
        : // `invalid_format` is Zod 4's code for a string-format failure (a
          // `.regex()` like the version field, or a `z.iso.date()` like a date);
          // its default message can quote the failing pattern, so map it to fixed
          // copy rather than forward issue.message.
          issue.code === "invalid_format"
          ? "is not in the expected format"
          : issue.code === "too_big" || issue.code === "too_small"
            ? "is out of the allowed range"
            : issue.code === "invalid_value" || issue.code === "invalid_union"
              ? "is not an allowed value"
              : "is not valid";

  const more =
    error.issues.length > 1
      ? ` (and ${error.issues.length - 1} more problem${error.issues.length - 1 === 1 ? "" : "s"})`
      : "";

  return sanitizeForDisplay(
    `The imported terms are not valid: ${where} ${reason}.${more}`,
  );
}
