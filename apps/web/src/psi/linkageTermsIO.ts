// Only `stringify` is imported from `yaml`: the raw parsers are ESLint-banned in
// the web app (they leak source into errors), so import routes through core's
// shared sensitive-file chokepoint instead. `stringify` carries no such channel.
import { stringify as stringifyYaml } from "yaml";

import {
  parseSensitiveJson,
  parseSensitiveYaml,
  safeParseLinkageTerms,
  sanitizeForDisplay,
  snakeizeKeys,
} from "@psilink/core";

import type { LinkageTerms } from "@psilink/core";
import type { ZodError } from "zod";

/**
 * The JSON/YAML escape hatch for the expert linkage-terms editor: serialize the
 * authored terms to a portable document, and parse one back. Pure (string in,
 * string/result out) and React-free, so the round-trip contract is the single
 * tested boundary the editor drives rather than the UI.
 *
 * Export emits the snake_case on-disk form (via {@link snakeizeKeys}) -- the same
 * shape `psilink.yaml` and the `docs/EXCHANGE_REFERENCE.md` snippets use -- so an
 * exported file is the "exported from the GUI" reference that doc points at, and
 * re-imports cleanly: {@link safeParseLinkageTerms} camelizes before validating,
 * so export -> import round-trips equal.
 *
 * Import is the ONLY way authored-elsewhere terms reach the editor, and it routes
 * every document through {@link safeParseLinkageTerms} -- the single validation
 * source, which applies the referential-integrity refines and the linear-time
 * transform-regex dialect check. There is deliberately no verbatim-embed path: a
 * document that does not parse cleanly never becomes a draft, so import cannot
 * smuggle terms past the gate the GUI authoring surface enforces by construction
 * (a test pins this).
 *
 * The raw JSON/YAML parse goes through core's shared sensitive-file chokepoint
 * ({@link parseSensitiveJson} / {@link parseSensitiveYaml}), not a raw parser: an
 * imported document is untrusted free text an operator could have pasted a secret
 * into by mistake, and a raw parser leaks a span of the source into its error
 * message. The chokepoint reports path-only and is the sanctioned parse entry
 * point the web app's ESLint ban on raw `yaml` parsers points at.
 */

/** A document format the editor can write. Import auto-detects, so it needs no
 * format argument; export must choose one. */
export type LinkageTermsFormat = "json" | "yaml";

/**
 * Upper bound on an imported document, in characters (UTF-16 code units). A hard
 * ceiling applied BEFORE the JSON/YAML parse, so a pasted or dropped pathological
 * document cannot drive the parser before the schema's own structural bounds (the
 * camelize depth/node-count caps {@link safeParseLinkageTerms} applies) can bite.
 *
 * Generous on purpose: far above any real linkage-terms file -- the invitation
 * TOKEN path caps at 64 KiB, and a GUI-exported document carrying every key,
 * transform, and description is still well under this -- and sized for an operator
 * workstation, not a constrained tab. Tunable.
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
  | LinkageTermsImportSuccess
  | LinkageTermsImportFailure;

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
 * Parse a JSON or YAML document into validated {@link LinkageTerms}, or return a
 * readable rejection. Format is auto-detected: JSON is tried first (it is the
 * stricter, cheaper parse), then YAML (a superset that also accepts the JSON that
 * slipped through). The parsed value is validated by {@link safeParseLinkageTerms}
 * -- the single source -- which camelizes the snake_case input first, so a
 * document produced by {@link exportLinkageTerms} round-trips.
 *
 * Bounds, applied before the schema's own: the input is length-capped at
 * {@link MAX_IMPORT_CHARS}, and YAML alias expansion at {@link MAX_YAML_ALIAS_COUNT}.
 */
export function importLinkageTerms(text: string): LinkageTermsImportResult {
  if (text.length > MAX_IMPORT_CHARS)
    return {
      success: false,
      error:
        "This document is too large to import. Linkage terms are far smaller " +
        "than this; check that you pasted the right file.",
    };

  // Route both formats through the shared sensitive-file chokepoint so a parse
  // error never echoes the document's bytes. JSON is tried first (stricter,
  // cheaper); each chokepoint throws a path-only UsageError on failure, which we
  // discard in favor of our own value-free message. The chokepoint bounds YAML
  // alias expansion via the parser's default, and the length cap above bounds the
  // input before either parse runs.
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

  const parsed = safeParseLinkageTerms(raw);
  if (!parsed.success)
    return { success: false, error: readableTermsError(parsed.error) };

  return { success: true, terms: parsed.data };
}

/**
 * Reduce a linkage-terms {@link ZodError} to one readable line that locates the
 * first problem WITHOUT echoing any parsed value. Built-in Zod messages can quote
 * the offending value (an enum mismatch repeats what it received), so this never
 * forwards `issue.message` for a built-in code; it maps the code to fixed copy and
 * shows only the structural `path`. The schema's own referential-integrity /
 * dialect refines (`custom` code) carry deliberately value-free static messages,
 * so those are surfaced verbatim -- they are the useful, safe ones. The whole line
 * is run through {@link sanitizeForDisplay} as a backstop.
 */
function readableTermsError(error: ZodError): string {
  if (error.issues.length === 0)
    return "The imported terms are not valid linkage terms.";
  const issue = error.issues[0];

  const where =
    issue.path.length > 0
      ? issue.path.map((segment) => String(segment)).join(".")
      : "the document";

  // Fixed, value-free phrasing per Zod code. `custom` is the schema's own refines
  // (static, value-free messages by design), so those are shown verbatim; every
  // other code gets fixed copy so a built-in message cannot leak a parsed value.
  const reason =
    issue.code === "custom"
      ? issue.message
      : issue.code === "invalid_type"
        ? "is missing or has the wrong type"
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
