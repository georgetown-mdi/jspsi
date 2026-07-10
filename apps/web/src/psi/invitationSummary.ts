import {
  describeTransformCoercions,
  parseDateInputDropsEveryRecord,
  pipelineAlwaysDrops,
  sanitizeForDisplay,
} from "@psilink/core";

import { APPLIED_SETTINGS } from "@psi/appliedSettings";

import type {
  Algorithm,
  DateFormatToken,
  InvitationToken,
  LinkageField,
  LinkageKey,
  LinkageKeyElement,
  LinkageStrategy,
  TransformStep,
} from "@psilink/core";

/**
 * Human-readable label for each linkage-field semantic type. The `type` is a
 * fixed enum the schema validates (not partner free-text), so these labels are
 * safe to render verbatim. The field's `name` is partner-controlled free text
 * and is deliberately not shown -- the semantic type is what matters for an
 * acceptor deciding whether to consent, and it cannot carry an injection.
 */
const FIELD_TYPE_LABELS: Record<LinkageField["type"], string> = {
  first_name: "First name",
  last_name: "Last name",
  date_of_birth: "Date of birth",
  ssn: "Social Security number",
  ssn4: "Last 4 of Social Security number",
  phone_number: "Phone number",
  email_address: "Email address",
  zip_code: "ZIP code",
};

/**
 * Compact label per linkage-field semantic type, for the always-visible per-key
 * field one-liner (see {@link InvitationKeySummary.headerFields}), where the
 * verbose {@link FIELD_TYPE_LABELS} would not fit on one line. Like those, the
 * `type` is a fixed enum the schema validates, so these are safe to render
 * verbatim. `ssn4` keeps the "(last 4)" qualifier rather than a bare "SSN": the
 * full-SSN and last-4 cases are a real disclosure difference the acceptor must
 * see, and "SSN4" is internal jargon.
 */
const COMPACT_FIELD_TYPE_LABELS: Record<LinkageField["type"], string> = {
  first_name: "first name",
  last_name: "last name",
  date_of_birth: "date of birth",
  ssn: "SSN",
  ssn4: "SSN (last 4)",
  phone_number: "phone",
  email_address: "email",
  zip_code: "ZIP",
};

/**
 * Plain-language label for each fuzzy-comparison expansion. Like the field
 * type, the value is a fixed enum the schema validates (not partner free text),
 * so these are safe to render verbatim. Each expands one value into several
 * match candidates, loosening the match -- and, under `psi`, widening what is
 * disclosed -- so the acceptor must see it.
 */
const FUZZY_COMPARISON_LABELS: Record<
  NonNullable<LinkageKeyElement["generateFuzzyComparisons"]>,
  string
> = {
  transpositions: "two-digit transpositions",
  edit_distances: "single-character edits",
  adjacent_years: "adjacent years",
};

/**
 * Plain-language description of what each transform function does to matching,
 * keyed by the function name core recognizes. The acceptor sees these alongside
 * the function name and its parameters so a non-expert can understand the
 * matching consequence of each declared transform, not just read its name. Each
 * entry names the consequence where there is one (e.g. `coalesce` can create
 * matches that would not otherwise occur), rather than restating the name.
 *
 * Keyed by the function's raw name (the schema-validated `snake_case` value the
 * cleaning library dispatches on), so the lookup is an exact match against what
 * core executes. A partner-declared name that core does not recognize has no
 * entry and falls back to the bare sanitized name; the glossary is asserted to
 * cover every name in core's `STANDARDIZATION_FUNCTION_NAMES` (see the coverage
 * test), so a function added to core cannot ship here without a description.
 *
 * Exported so the coverage test can assert its key set equals core's
 * {@link STANDARDIZATION_FUNCTION_NAMES} in both directions -- catching a core
 * function with no entry here and a stale entry for a function core dropped.
 */
export const TRANSFORM_FUNCTION_GLOSSARY: Record<string, string> = {
  remove_non_ascii:
    "Deletes every character outside the ASCII set before matching -- an accented letter, emoji, or symbol is dropped entirely, not simplified.",
  replace_separators_with_spaces:
    "Turns hyphens, apostrophes, ampersands, slashes, and underscores into spaces before matching.",
  squash_spaces:
    "Collapses runs of spaces into a single space before matching.",
  remove_punctuation: "Removes punctuation and symbols before matching.",
  remove_dashes: "Removes hyphens before matching.",
  trim_whitespace: "Removes leading and trailing spaces before matching.",
  to_upper_case:
    "Upper-cases the value before matching, so values differing only in letter case can match.",
  to_lower_case:
    "Lower-cases the value before matching, so values differing only in letter case can match.",
  remove_accents:
    "Strips accents and diacritics but keeps the base letter before matching, so accented and unaccented spellings can match.",
  remove_affixes:
    "Removes name titles and suffixes (Mr., Dr., Jr., III) before matching.",
  substring:
    "Matches on only part of the value, not the whole value, so more values can match.",
  parse_date:
    "Reformats the date to a canonical form before matching, so dates written in different formats can match.",
  pad_left:
    "Left-pads the value to a fixed length before matching (e.g. zero-filling a short identifier).",
  phonetic:
    "Matches names by a sound-alike code rather than the literal spelling, so different names that sound alike can match.",
  null_if: "Treats listed values as empty, dropping them from matching.",
  replace_regex:
    "Rewrites the parts of the value matching a pattern before matching.",
  extract_regex:
    "Matches on only the part of the value a pattern captures; a value with no match is dropped.",
  filter_regex:
    "Drops values that do not match a pattern, removing them from matching.",
  split_on:
    "Splits the value into several candidates, each able to match independently.",
  coalesce:
    "Substitutes a fallback value for an empty field, which can create matches that would not otherwise occur.",
};

/** Legal-agreement context, with the partner-controlled free text sanitized. */
export interface InvitationLegalAgreementSummary {
  /** Agreement identifier (e.g. "MOU-2025-0042"), sanitized for display. */
  reference: string;
  /** Stated purpose of the disclosure, sanitized for display. */
  purpose: string;
  /** ISO 8601 date (YYYY-MM-DD) after which the exchange is refused. */
  expirationDate: string;
}

/** The optional data columns the inviter declares, with names sanitized. */
export interface InvitationPayloadSummary {
  /** Columns the inviter will send for matched records (what the acceptor
   * receives), in the inviter's namespace. Empty when the declared set is empty;
   * read {@link sendDeclared} to tell that apart from the lazy case. */
  send: Array<string>;
  /**
   * Whether the send set is a definite DECLARATION the acceptor is locked in to --
   * the carried disclosed subset (possibly empty), or an authored `payload.send` --
   * as opposed to the lazy case (the inviter sends whatever its own metadata
   * discloses, nothing declared up front). When true and {@link send} is empty the
   * acceptor is locked in to "receive nothing" (a later non-empty payload aborts),
   * so the renderer states that explicitly ("(none)") rather than omitting the
   * line; when false the send side is lazy and is not shown.
   */
  sendDeclared: boolean;
  /** Columns the inviter requests from the acceptor for matched records (what
   * the acceptor sends). Empty when the declared set is empty; read
   * {@link receiveDeclared} to tell that apart from the lazy case. */
  receive: Array<string>;
  /**
   * Whether the receive set is a definite DECLARATION (an authored
   * `payload.receive`, present even when empty) as opposed to the lazy case (no
   * `receive` authored: the inviter takes whatever the acceptor's own metadata
   * discloses, nothing requested up front). When true and {@link receive} is
   * empty the inviter has asserted "the acceptor sends nothing" (a later
   * non-empty payload from the acceptor aborts the exchange), so the renderer
   * states that explicitly ("(none)") rather than omitting the line; when false
   * the receive side is lazy and is not shown. Mirrors {@link sendDeclared} on
   * the opposite direction.
   */
  receiveDeclared: boolean;
}

/**
 * A single transform step applied to an element's value before hashing,
 * reduced to display form: the function name and a bounded, sanitized view of
 * its parameters -- which determine what the function does, and so what
 * matches.
 */
export interface InvitationTransformSummary {
  /** Sanitized name of the transform function. */
  function: string;
  /**
   * One sanitized `key: value` string per declared parameter, in declaration
   * order, capped at {@link MAX_DISPLAYED_PARAMS} (a trailing "... N more"
   * entry marks any overflow). sanitizeForDisplay bounds each entry's length and
   * the count is capped, so an arbitrarily large partner-supplied `params`
   * record cannot flood the screen. Empty when the step declares no parameters.
   * Each parameter is shown verbatim; a parameter core coerces before applying
   * is clarified separately in {@link coercions}, not folded into its line.
   */
  params: Array<string>;
  /**
   * Plain-language description of what this function does to matching, from
   * {@link TRANSFORM_FUNCTION_GLOSSARY}. Fixed copy keyed by the recognized
   * function name (not partner-controlled), so it is safe to render verbatim.
   * Absent when the declared function name is one core does not recognize.
   */
  description?: string;
  /**
   * Literal, parameter-derived phrase for a recognized parameterized function
   * (currently `substring` on a name field): "the first 3 characters". Leads the
   * element's detail in place of the function name when present, and suppresses
   * {@link description} so the slice is not stated twice. Computed only where the
   * character position maps to the value the acceptor sees (a name field); absent
   * for a date or other reformatted field, a negative/non-integer slice, or a
   * function with no literal -- the renderer then leads with {@link description}.
   */
  effect?: string;
  /**
   * Parameters this function coerces before applying, each naming the parameter
   * and the value it actually runs as (e.g. `replacement` runs as the empty
   * string for `replace_regex` `replacement: null`). Carried apart from
   * {@link params}, and rendered as its own element rather than folded into the
   * param line, so this note is not impersonable by partner text placed inside a
   * param value (which renders as a `key: value` line). Both fields are
   * core-derived -- the parameter name is the function's own parameter and the
   * runsAs value comes from core's coercion contract -- so neither is
   * partner-controlled. Restricted to coerced parameters whose {@link params}
   * line is shown, so a note never references one hidden by the display cap.
   * Absent when the step coerces no displayed parameter.
   */
  coercions?: Array<{ param: string; runsAs: string }>;
}

/**
 * One element of a linkage key, reduced to what determines whether records
 * match on it: the field it derives from and any non-default matching rule it
 * carries (a value transform or a fuzzy-comparison expansion).
 */
export interface InvitationKeyElementSummary {
  /** Human-readable label for the field this element derives from. */
  fieldLabel: string;
  /**
   * Transform steps applied to the value before hashing, in order; empty when
   * the value is matched as-is. Each carries the sanitized function name and a
   * bounded, sanitized view of its parameters.
   */
  transforms: Array<InvitationTransformSummary>;
  /** Plain-language label for the fuzzy-comparison expansion, if any. */
  fuzzyComparison?: string;
  /**
   * Whether today's exchange actually applies the fuzzy comparison above (see
   * {@link APPLIED_SETTINGS}). Meaningful only alongside a
   * `fuzzyComparison`; the renderer flags that annotation as proposed-but-not-
   * applied when this is false.
   */
  fuzzyComparisonApplied: boolean;
}

/**
 * A single linkage key, with the ordered elements and matching rules that
 * decide which records match -- and, under `psi`, which shared identifiers are
 * disclosed. Surfaced in full so no transform, swap, or fuzzy rule is silently
 * consented to.
 */
export interface InvitationKeySummary {
  /**
   * A stable identity for this key, for a caller that needs to associate
   * per-key UI state (e.g. an expanded/collapsed disclosure) with the key
   * across a reorder. The raw (unsanitized) key name: for a schema-validated
   * `LinkageTerms` this is guaranteed unique across `linkageKeys`, unlike
   * {@link name}, whose sanitization/truncation can collapse two distinct raw
   * names to the same displayed string. Never rendered -- carries no display
   * obligation, so it is not sanitized.
   */
  id: string;
  /** The key's name, sanitized for display. */
  name: string;
  /** Ordered elements combined to form the key. */
  elements: Array<InvitationKeyElementSummary>;
  /** True when the key declares a swap (two elements matched in either order). */
  hasSwap: boolean;
  /**
   * The two swapped elements' field labels, present only when both swap
   * references resolve to elements with *distinct* labels (the common case,
   * e.g. ["Last name", "First name"]). Absent when an identifier names no
   * element or the two would carry the same label. No identifier, raw or
   * sanitized, ever enters this tuple: in those cases the renderer
   * falls back to a generic swap note keyed off {@link hasSwap} instead.
   */
  swap?: [string, string];
  /**
   * True when the two swapped elements (resolved in {@link swap}) BOTH carry a
   * transform. On the receiver side a swap moves each element's field reference
   * to the other element while its transforms stay put (see core's
   * `swapElements`), so each element's transforms are applied to the OTHER
   * element's field value. When both sides carry transforms the generic
   * "matched in either order" note understates this interchange, so the renderer
   * depicts it bidirectionally; implies {@link swap} is present (the interchange
   * is named in terms of the two distinct field labels). Mutually exclusive with
   * {@link swapTransformDonor}: false whenever fewer than both swapped elements
   * carry a transform, or the labels did not resolve distinctly.
   */
  swapTransformInterchange: boolean;
  /**
   * `[donor, recipient]` field labels when EXACTLY ONE swapped element carries a
   * transform, else undefined. The receiver applies the transform-carrier's
   * (donor's) transforms to the partner's (recipient's) field value (core's
   * `swapElements`), so the recipient's header slot shows the donor's breadth
   * marker (see {@link headerFields}); the renderer states that one-directional
   * cross-application in the detail so the re-attributed marker is anchored.
   * Mutually exclusive with {@link swapTransformInterchange} (the both-transform
   * case); implies {@link swap} is present, and its two labels are the same
   * resolved field labels {@link swap} holds, never the raw swap-reference
   * identifier.
   */
  swapTransformDonor?: [string, string];
  /**
   * The always-visible one-liner of the fields this key matches on: one entry per
   * element, each a COMPACT semantic-type label carrying a terse breadth marker
   * when its element loosens matching ("last name (partial)", "date of birth
   * (fuzzy)"). Deduped by the full entry (label + marker) so a truncated and a
   * whole-value element of the same field stay distinct. Each entry is a fixed
   * compact label for the element's schema-validated type plus a fixed marker; an
   * unresolved field would fall back to its sanitized identifier, but a dangling
   * field reference is rejected at decode, so that fallback is unreachable for a
   * decoded token (and cosmetic-only if ever reached -- the renderer joins these
   * for display). The honest anchor a partner-controlled key {@link name} cannot
   * misrepresent; the swap "either order" note is carried by {@link hasSwap}.
   *
   * A swap re-attributes markers to the receiver's terms: each swapped element
   * keeps all its own rules but reads the OTHER element's field value on the
   * receiver (core's `swapElements`), so each element's breadth marker is shown on
   * its swapped PARTNER's field here, not the sender-order field it is declared on.
   * The cross-application of the rules the detail lists is anchored there by
   * {@link swapTransformInterchange} / {@link swapTransformDonor}.
   */
  headerFields: Array<string>;
}

/**
 * A linkage field, reduced to its display label and any declared constraints.
 * Constraints are data standards both parties commit to (advisory -- the
 * application warns rather than enforces), surfaced so the acceptor sees every
 * rule attached to the matched data.
 */
export interface InvitationFieldSummary {
  /** Human-readable label for the field's semantic type. */
  label: string;
  /**
   * Plain-language descriptions of the declared constraints, if any. The
   * `exclude` denylist is summarized as a count rather than listing its values:
   * it is advisory and can hold hundreds of entries.
   */
  constraints: Array<string>;
}

/**
 * A display-ready, injection-safe view of the inviter's linkage terms, derived
 * from a decoded {@link InvitationToken}. Every partner-controlled value (the
 * self-asserted identity, linkage-key names, legal-agreement text, payload
 * column names, and the schema-validated date fields) is passed through
 * {@link sanitizeForDisplay} here, at the one boundary, so renderers can show
 * these fields without each re-deriving the escaping -- React's JSX escaping
 * covers HTML metacharacters but not the control, bidi, zero-width, or homoglyph
 * characters this neutralizes. The dates cannot carry such characters today (the
 * `z.iso` schemas reject them), but routing them through the same boundary keeps
 * the contract uniform rather than depending on that validation staying in place.
 */
export interface InvitationSummary {
  /** The inviter's self-asserted identity, sanitized for display. */
  invitingParty: string;
  /** `psi` reveals matched identifiers; `psi-c` reveals only the count. */
  algorithm: Algorithm;
  /**
   * Whether today's exchange actually applies `psi-c` when it is proposed (see
   * {@link APPLIED_SETTINGS}). Meaningful only when {@link algorithm} is
   * `psi-c`; the renderer flags a proposed `psi-c` as not-yet-applied -- the run
   * still reveals matched identifiers -- when this is false, so a count-only
   * claim cannot read as in force while it is not.
   */
  psiCApplied: boolean;
  /**
   * How the agreed linkage keys are exchanged: `cascade` (the default) or
   * `single-pass`. single-pass is disclosure-affecting -- to run in one batched
   * round the sender hands the receiver its full per-key value structure, so the
   * receiver observes matches on less precise keys the cascade would have filtered
   * out first -- so the renderer surfaces it as an always-visible consent note;
   * cascade, the baseline that discloses less, is not flagged. A fixed schema enum
   * (not partner free text), so it is rendered verbatim like {@link algorithm}.
   */
  linkageStrategy: LinkageStrategy;
  /** Whether the inviter expects to receive the intersection result. */
  inviterReceivesOutput: boolean;
  /** Whether the inviter will share the result with the accepting partner. */
  inviterSharesResult: boolean;
  /**
   * Whether a record may match more than one of the partner's records (the
   * inviter's declared deduplicate setting).
   */
  deduplicate: boolean;
  /**
   * Whether today's exchange actually applies the deduplicate setting above
   * (see {@link APPLIED_SETTINGS}). False while matching is hard-wired
   * one-to-one; the renderer flags the duplicate-matches row as proposed-but-
   * not-applied when a looser setting is proposed but this is false.
   */
  deduplicateApplied: boolean;
  /**
   * Linkage keys (records are matched on these), in the inviter's order, each
   * carrying its ordered elements and matching rules.
   */
  linkageKeys: Array<InvitationKeySummary>;
  /**
   * The unique fields the linkage keys match on, in compact-label form and order
   * of first appearance -- no breadth markers, no per-key grouping. Surfaced
   * always-visible (above the default-collapsed matching detail) so an acceptor
   * sees WHICH data is matched on without expanding it. A field reference that
   * does not resolve to a declared type falls back to its sanitized raw name.
   */
  matchedFields: Array<string>;
  /** PII fields involved, each with its label and declared constraints. */
  linkageFields: Array<InvitationFieldSummary>;
  /** Present only when the inviter attached a legal agreement. */
  legalAgreement?: InvitationLegalAgreementSummary;
  /** Present only when the inviter declared payload columns to send or receive. */
  payload?: InvitationPayloadSummary;
  /** The invitation's expiry instant (ISO 8601), if the token carries one. */
  expires?: string;
}

/**
 * Plain-language descriptions of a field's declared constraints, in a stable
 * order. The `exclude` denylist is reported as a count, not its values: it is
 * advisory and may hold hundreds of entries.
 *
 * `allowedCharacters` is deliberately NOT rendered as "characters limited to X".
 * The value is a partner-authored regular-expression character class: it arrives
 * in the invitation token, accepted on a transcription checksum -- not an
 * authenticity guarantee -- and is never vetted, so a crafted class reads very
 * differently to a human than the set it admits. A leading `^` negates it (`^A-Z`
 * admits every character EXCEPT A-Z), and a shorthand or bracket breakout (`\p{L}`,
 * `[:alpha:]`, `]|\w|[`) is opaque to a non-regex-literate operator -- so a
 * "limited to <class>" phrasing would present raw partner regex as a vetted,
 * plain-language promise it is not. It is instead labelled as the partner-supplied,
 * unverified regular expression it is, so its surface reading is no longer
 * presented as a guarantee -- a non-regex-literate operator can still misread a
 * crafted class, but the copy no longer asserts a promise the value cannot back,
 * and the "not verified by psilink" clause names the trust boundary (partner-
 * authored, warn-not-enforce) rather than only the regex syntax family. The raw
 * class is still shown (sanitized) so a regex-literate reviewer can inspect the
 * actual pattern. The check that evaluates the class is warn-not-enforce (core's
 * `withinAllowedCharacters`); this is that check's operator-facing display
 * complement. `allowedCharacters` is a short, length-bounded, partner-controlled
 * string, so it is sanitized before display.
 */
function describeConstraints(field: LinkageField): Array<string> {
  const constraints = field.constraints;
  if (constraints === undefined) return [];

  const descriptions: Array<string> = [];
  if ("validOnly" in constraints && constraints.validOnly === true)
    descriptions.push("values must be valid");
  if ("affixesAllowed" in constraints && constraints.affixesAllowed === false)
    descriptions.push("honorifics and suffixes removed");
  if (
    "allowedCharacters" in constraints &&
    constraints.allowedCharacters !== undefined
  )
    descriptions.push(
      `allowed-character pattern (partner-supplied regular expression, not verified by psilink): ${sanitizeForDisplay(constraints.allowedCharacters)}`,
    );
  const exclude = constraints.exclude ?? [];
  if (exclude.length > 0)
    descriptions.push(
      `${exclude.length} excluded value${exclude.length === 1 ? "" : "s"}`,
    );
  return descriptions;
}

/**
 * Upper bound on the number of transform parameters surfaced per step. A real
 * function takes a handful; the cap (with an overflow marker) keeps an
 * arbitrarily large partner-supplied `params` record -- the schema bounds
 * neither the entry count nor the value content -- from flooding the screen.
 */
const MAX_DISPLAYED_PARAMS = 16;

/**
 * Render a transform parameter value for display. Primitives become their plain
 * string form; anything structured is JSON-encoded (best effort). The result is
 * sanitized and length-bounded by the caller, so it need not be safe on its own.
 */
function describeParamValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (value === null) return "null";
  if (value === undefined) return "";
  try {
    // A value past the checks above is an object/array from a JSON-parsed
    // params record, so JSON.stringify yields a string (and throws only on the
    // unreachable circular/bigint cases, caught below).
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

/**
 * Render the value a coerced parameter actually executes as, from core's
 * coercion contract. The empty string is a real executed value (e.g.
 * `replace_regex` `replacement: null`), so name it rather than render a blank
 * that would read as "nothing shown".
 */
function describeExecutedValue(value: unknown): string {
  if (value === "") return "the empty string";
  return describeParamValue(value);
}

/**
 * The literal slice phrase for a `substring` step on a name field, or undefined
 * when no faithful literal applies. `positionalSafe` gates both the field kind and
 * the pipeline position -- the caller passes true only for a name field's FIRST
 * step, so the slice runs on the unmodified field value. A date or other
 * reformatted field is canonicalized by a standardization the token does not carry
 * (so "the first 6 characters" there would be unverifiable), and a substring after
 * an earlier step that already rewrote the value (e.g. phonetic then substring)
 * takes the first N of that intermediate value, not the field -- both are left to
 * the glossary description rather than a misstating literal. The params
 * are partner-controlled and typed `unknown`, so they are narrowed to integers
 * before use; only a positive integer start yields a literal. A non-positive start
 * has no faithful "first N" -- a negative counts from the end, and 0 is a no-op
 * (core's schema rejects it and the factory maps it to an always-null fn) -- and a
 * non-integer is not a usable slice, so all fall back to undefined and the caller
 * then leads with the glossary description. Core's `substring` is SQL SUBSTR:
 * 1-indexed positive `start`.
 */
function substringEffect(
  step: TransformStep,
  positionalSafe: boolean,
): string | undefined {
  if (step.function !== "substring" || !positionalSafe) return undefined;
  const start = step.params?.start;
  const length = step.params?.length;
  if (
    typeof start !== "number" ||
    !Number.isInteger(start) ||
    typeof length !== "number" ||
    !Number.isInteger(length) ||
    length < 1
  )
    return undefined;
  if (start === 1)
    return length === 1
      ? "the first character"
      : `the first ${length} characters`;
  if (start > 1) return `characters ${start} to ${start + length - 1}`;
  return undefined;
}

/**
 * Reduce one transform step to its display summary: the sanitized function name
 * and a bounded, sanitized `key: value` view of its parameters. Each entry is
 * sanitized as a whole (so a parameter key or value cannot carry control, bidi,
 * or homoglyph characters, and is truncated), and the entry count is capped.
 * `positionalSafe` lets a recognized `substring` lead with a literal slice phrase
 * (see {@link substringEffect}) on a name field.
 */
function summarizeTransform(
  step: TransformStep,
  positionalSafe: boolean,
): InvitationTransformSummary {
  const entries = Object.entries(step.params ?? {});
  const shown = entries.slice(0, MAX_DISPLAYED_PARAMS);
  const params = shown.map((entry) =>
    sanitizeForDisplay(`${entry[0]}: ${describeParamValue(entry[1])}`),
  );
  if (entries.length > MAX_DISPLAYED_PARAMS)
    params.push(`... ${entries.length - MAX_DISPLAYED_PARAMS} more`);
  const summary: InvitationTransformSummary = {
    function: sanitizeForDisplay(step.function),
    params,
  };
  // A literal slice phrase leads in place of the function name where it is
  // faithful (substring on a name field) and makes the generic glossary line
  // redundant, so the description is only the fallback when there is no literal.
  // The glossary lookup uses the RAW function name and the hasOwn guard (not a
  // bare index) so the absent case stays visible to the type system -- the
  // partner-controlled name may match no entry, which the Record index signature
  // alone would silently type as string.
  const effect = substringEffect(step, positionalSafe);
  if (effect !== undefined) summary.effect = effect;
  else if (Object.hasOwn(TRANSFORM_FUNCTION_GLOSSARY, step.function))
    summary.description = TRANSFORM_FUNCTION_GLOSSARY[step.function];
  // Surface each runtime-coerced param as its own note rather than folded into
  // the param line, so it cannot be impersonated by partner text in a param
  // value. Its content is wholly core-derived: the param name is the function's
  // own parameter and the executed value comes from core's coercion contract.
  // Restricted to params whose `key: value` line is actually shown, so a note
  // never references a param collapsed into the "... N more" overflow.
  const shownKeys = new Set(shown.map(([key]) => key));
  const coercions = describeTransformCoercions(step)
    .filter((c) => shownKeys.has(c.param))
    .map((c) => ({
      param: c.param,
      runsAs: describeExecutedValue(c.executed),
    }));
  if (coercions.length > 0) summary.coercions = coercions;
  return summary;
}

/**
 * The date-component vocabulary `parse_date` layouts are built from, pinned to
 * core's {@link DateFormatToken} so adding a token there breaks this build rather
 * than silently missing a dropped component below. Detection is set-membership
 * only -- which components a format string carries -- and these tokens are
 * pairwise non-substrings, so `String.includes` recovers core's greedy
 * tokenization exactly for this vocabulary; a future overlapping token (a 2-digit
 * year, say) would surface as a compile error to revisit the membership test.
 */
const DATE_FORMAT_COMPONENTS: Record<DateFormatToken, true> = {
  YYYY: true,
  MM: true,
  DD: true,
};

// Core's parseDateFactory defaults (standardization.ts): an absent format is the
// full MM/DD/YYYY -> YYYYMMDD layout, which carries every component, so an absent
// outputFormat drops nothing.
const DEFAULT_PARSE_DATE_INPUT = "MM/DD/YYYY";
const DEFAULT_PARSE_DATE_OUTPUT = "YYYYMMDD";

/** The date components a `parse_date` format layout carries. */
function dateComponentsOf(format: string): Set<DateFormatToken> {
  const present = new Set<DateFormatToken>();
  for (const token of Object.keys(
    DATE_FORMAT_COMPONENTS,
  ) as Array<DateFormatToken>)
    if (format.includes(token)) present.add(token);
  return present;
}

/**
 * The breadth marker a `parse_date` step's output layout earns, or undefined when
 * it merely reformats between equivalent full layouts (routine canonicalization,
 * deliberately unflagged) -- or when its INPUT format cannot supply a full date,
 * which is not a broadening at all (see below). Distinguishes two magnitudes of
 * date collapse:
 *
 * - "any date": the output layout carries NO date token at all, so every date
 *   collapses to one constant value and the element matches every record's date
 *   as that single value -- the maximal match breadth (e.g. an `outputFormat` of
 *   "registered").
 * - "partial": the output keeps at least one date token but omits a component its
 *   input carries, so distinct dates collapse onto a coarser bucket and the
 *   element matches on only part of the date (e.g. a year-only output matches
 *   every date within a year).
 *
 * A `parse_date` whose input format omits a component core requires drops EVERY
 * record (it returns null for every value), so the element matches NOTHING, not
 * more -- the opposite of a broadening -- and earns no breadth marker here: that
 * self-defeating key is a narrowing surfaced by the separate dead-key advisory,
 * and the output is classified only once a full date is actually parsed. This
 * defers to core's own runtime-faithful `parseDateInputDropsEveryRecord` (which
 * also covers a non-string input format) rather than re-deriving the
 * required-component rule here, so the marker cannot drift from the runtime.
 *
 * The output classification is keyed on the OUTPUT's token set: a tokenless output
 * is "any date" whatever the (now full) input, since no input layout can
 * un-collapse a constant output; the proper drop is then a component the input
 * carries that a non-empty output omits. The params are partner-controlled and
 * typed `unknown`, so each format is narrowed to a string, falling back to core's
 * default layout (which carries every component) when absent. The returned word is
 * one of these two fixed literals, never partner text, so the marker is
 * injection-safe by construction.
 */
function parseDateBreadth(
  step: TransformStep,
): "any date" | "partial" | undefined {
  if (step.function !== "parse_date") return undefined;
  // A parse_date whose input format cannot assemble a full date produces no value
  // to classify (core drops every such record), so emit no date marker. Defer to
  // core's check (which also covers a non-string input format). The element-level
  // pipelineAlwaysDrops guard in elementBreadthMarker suppresses ALL markers when
  // this kills the whole element; this step-level guard additionally stops a dead
  // parse_date that a later `coalesce` RESCUES to a constant from mislabelling the
  // element a date collapse (the honest marker there is the coalesce's "fallback").
  if (parseDateInputDropsEveryRecord(step.params)) return undefined;
  const rawInput = step.params?.inputFormat;
  const rawOutput = step.params?.outputFormat;
  const input =
    typeof rawInput === "string" ? rawInput : DEFAULT_PARSE_DATE_INPUT;
  const output =
    typeof rawOutput === "string" ? rawOutput : DEFAULT_PARSE_DATE_OUTPUT;
  const outputComponents = dateComponentsOf(output);
  if (outputComponents.size === 0) return "any date";
  const dropsComponent = [...dateComponentsOf(input)].some(
    (component) => !outputComponents.has(component),
  );
  return dropsComponent ? "partial" : undefined;
}

/**
 * The terse informative marker for a key element's collapsed-header entry, or
 * undefined when the element matches exactly or only canonicalizes its value
 * (case, whitespace, accents, affixes, padding, and a `parse_date` that merely
 * reformats between equivalent layouts -- routine standardization, deliberately
 * not flagged so the recommended setup stays clean). It is also undefined when the
 * element's pipeline matches NOTHING -- a `parse_date` whose input format drops
 * every record, unless a later `coalesce` rescues it to a constant -- since that is
 * a narrowing-to-empty, not a broadening, and is surfaced separately by the
 * dead-key advisory. `remove_affixes` is in that
 * routine set by deliberate decision: stripping titles and suffixes (Dr., Jr.)
 * is a BROADENING canonicalizer in the same family as accent and case folding --
 * it makes superficially-different spellings match -- not a record-DROPPING
 * narrower like the flagged `filter_regex` / `null_if`, so it earns no marker
 * despite removing characters. It names any rule that materially changes which
 * records match: where the direction is determinable from the terms it names the
 * EFFECT ("partial" for a truncation, or for a `parse_date` whose output layout
 * drops a date component its input carries and so matches on only part of the
 * date; "any date" for a `parse_date` whose output carries no date token at all,
 * collapsing every date to one value -- a stronger breadth than the partial drop;
 * "fuzzy" / "sound-alike" / "multiple" / "fallback" for an expansion), and where
 * an arbitrary partner-authored pattern or value list makes the direction
 * indeterminate it names the RULE directly ("pattern replacement", "pattern
 * extraction", "pattern filter", "excludes values"). Informative, not a
 * broaden-only warning: `filter_regex` and `null_if` narrow matching but are
 * still surfaced. "fuzzy" is reserved for the genuine fuzzy-comparison expansion,
 * distinct from `substring`'s "partial". None of the regex/value rules appear on
 * the default or guided path (only `substring` and `swap` do), so an
 * expert-authored rule is what trips those markers.
 *
 * "partial" marks a LITERAL character-truncation, so it fires for a `substring`
 * only where the slice runs on the literal value. A `substring` after a
 * value-recoding `phonetic` step (which replaces the name with a sound-alike
 * code) slices that code, not the name, so it is not flagged "partial" -- the
 * recoding's "sound-alike" is then the dominant, honest effect. This mirrors the
 * detail row's position-aware literal ({@link substringEffect} /
 * {@link summarizeKey}, which render "the first N characters" only for a
 * substring on the unmodified value). A routine normalizer before the substring
 * (case/accents/...) does not recode the value out of literal correspondence, so
 * it keeps "partial"; a `phonetic` AFTER the substring does too, since the
 * literal is truncated first.
 *
 * Returns a SINGLE, most-salient marker, not one per rule: the always-visible
 * header is deliberately terse, so an element carrying more than one rule shows
 * just the first -- the maximal-breadth "any date" collapse ranks first, then the
 * other effect-named rules, then the directly-named ones -- while its
 * complete rule set sits one expand down in {@link MatchKeyDetails}. The element
 * stays flagged either way.
 */
function elementBreadthMarker(element: LinkageKeyElement): string | undefined {
  const steps = element.transform ?? [];
  const functions = new Set(steps.map((s) => s.function));
  // An element whose pipeline produces no value for ANY record matches nothing,
  // not more -- the opposite of a broadening, and a narrowing-to-empty the separate
  // dead-key advisory surfaces -- so it earns no marker, whatever rule a later step
  // would otherwise name: a substring/phonetic/... after a dead `parse_date`
  // null-propagates, so the record is dropped regardless. Defer to core's
  // pipelineAlwaysDrops, which also accounts for a rescuing `coalesce`, so the
  // marker cannot drift from the runtime.
  if (pipelineAlwaysDrops(element.transform)) return undefined;
  // A tokenless `parse_date` output collapses every date to one constant value --
  // the maximal match breadth -- so it is checked first and outranks every other
  // rule the element might also carry: once every value collapses to one, a
  // further substring/fuzzy/expansion loosening is moot, so "any date" is the
  // honest dominant effect and is never understated as a milder word. (A
  // `parse_date` that drops only some components, not all, is the milder "partial"
  // handled below at the parse_date position.)
  const parseDateBreadths = steps.map(parseDateBreadth);
  if (parseDateBreadths.includes("any date")) return "any date";
  // Effect named where the direction is determinable from the terms. "partial"
  // is a literal truncation, so a substring counts only where it slices the
  // literal value -- not after a value-recoding `phonetic` step, where it slices
  // the sound-alike code and "sound-alike" (below) is the honest dominant effect.
  const truncatesLiteral = steps.some(
    (step, index) =>
      step.function === "substring" &&
      !steps.slice(0, index).some((prior) => prior.function === "phonetic"),
  );
  if (truncatesLiteral) return "partial";
  if (element.generateFuzzyComparisons !== undefined) return "fuzzy";
  if (functions.has("phonetic")) return "sound-alike";
  if (functions.has("split_on")) return "multiple";
  if (functions.has("coalesce")) return "fallback";
  // parse_date is routine date canonicalization UNLESS its output layout narrows
  // matching: an output that keeps a date token but drops a component its input
  // carries matches on only part of the date ("partial"). The tokenless
  // every-date-to-one case is the stronger "any date", handled at the top.
  if (parseDateBreadths.includes("partial")) return "partial";
  // Rule named directly where a partner-authored pattern or value list makes the
  // matching direction indeterminate from the terms alone.
  if (functions.has("replace_regex")) return "pattern replacement";
  if (functions.has("extract_regex")) return "pattern extraction";
  if (functions.has("filter_regex")) return "pattern filter";
  if (functions.has("null_if")) return "excludes values";
  return undefined;
}

/**
 * Reduce one linkage key to its display summary, resolving each element's field
 * reference to a human-readable label and surfacing every non-default matching
 * rule. `fieldByName` maps a field `name` to its semantic type; an element or
 * swap reference that does not resolve falls back to the sanitized raw string.
 */
function summarizeKey(
  key: LinkageKey,
  fieldByName: Map<string, LinkageField["type"]>,
): InvitationKeySummary {
  const labelForField = (fieldName: string): string => {
    const type = fieldByName.get(fieldName);
    return type !== undefined
      ? FIELD_TYPE_LABELS[type]
      : sanitizeForDisplay(fieldName);
  };

  const compactLabelForField = (fieldName: string): string => {
    const type = fieldByName.get(fieldName);
    return type !== undefined
      ? COMPACT_FIELD_TYPE_LABELS[type]
      : sanitizeForDisplay(fieldName);
  };

  const elements: Array<InvitationKeyElementSummary> = key.elements.map(
    (element) => {
      const type = fieldByName.get(element.field);
      // A character slice reads faithfully only where its position maps to the
      // value the acceptor sees -- a free-text name. A date or other reformatted
      // field is canonicalized by a standardization the token does not carry, so
      // a positional phrase there would be unverifiable; summarizeTransform falls
      // back to the glossary description for it.
      const positionalSafe = type === "first_name" || type === "last_name";
      return {
        fieldLabel: labelForField(element.field),
        // The substring literal is faithful only on a name field's FIRST step: a
        // later step runs on a value an earlier one already rewrote (e.g.
        // phonetic then substring takes the first N of the sound-alike code, not
        // the name), so "the first N characters" of the original would be wrong.
        transforms: (element.transform ?? []).map((step, stepIndex) =>
          summarizeTransform(step, positionalSafe && stepIndex === 0),
        ),
        fuzzyComparison:
          element.generateFuzzyComparisons !== undefined
            ? FUZZY_COMPARISON_LABELS[element.generateFuzzyComparisons]
            : undefined,
        fuzzyComparisonApplied: APPLIED_SETTINGS.fuzzyComparisons,
      };
    },
  );

  const hasSwap = key.swap !== undefined;
  let swap: [string, string] | undefined;
  let swapTransformInterchange = false;
  let swapTransformDonor: [string, string] | undefined;
  // Header-marker re-attribution across a swap: maps each swapped element to the
  // breadth marker its header entry should show INSTEAD of its own (an explicit
  // `undefined` blanks the marker). Empty for a non-swap or same-label swap, so
  // the header loop falls back to each element's own marker. Built here because
  // the swap resolution below supplies the element pairing it needs.
  const headerMarkerOverride = new Map<LinkageKeyElement, string | undefined>();
  if (key.swap !== undefined) {
    // A swap names two elements by their effective identifier (element `name`
    // if present, otherwise `field`); resolve each to its element so the note
    // reads in the same field-label terms as the element list and can see
    // whether each carries a transform. The schema enforces that `name ?? field`
    // is unique within a key, so this Map never drops an element. The note names
    // the two fields only when both references resolve to elements with distinct
    // labels; otherwise the renderer shows a generic note (see the `swap` field
    // doc); `swap` is left undefined, never holding a raw or sanitized
    // identifier, since either would mislead rather than inform.
    const elementByIdentifier = new Map(
      key.elements.map((element) => [element.name ?? element.field, element]),
    );
    const first = elementByIdentifier.get(key.swap[0]);
    const second = elementByIdentifier.get(key.swap[1]);
    if (first !== undefined && second !== undefined) {
      const firstLabel = labelForField(first.field);
      const secondLabel = labelForField(second.field);
      if (firstLabel !== secondLabel) {
        swap = [firstLabel, secondLabel];
        // On the receiver each swapped element keeps ALL its own rules but reads
        // the OTHER element's field value (core's `swapElements` rewrites only the
        // field reference). So every breadth marker an element earns describes,
        // for the acceptor, what happens to its PARTNER's field -- and the honest
        // header shows it on the partner's slot. Re-attribute uniformly: each
        // element's header entry shows its partner's marker. This is exact for
        // every configuration (one marker, two equal, two different, transform or
        // fuzzy), since the whole element moves; a same-marker pair swaps to an
        // identical header, and a no-marker pair to the bare labels.
        headerMarkerOverride.set(first, elementBreadthMarker(second));
        headerMarkerOverride.set(second, elementBreadthMarker(first));
        // The expanded detail lists each element's transforms under its DECLARED
        // field, so a re-attributed header marker has no anchor there unless the
        // detail also states the cross-application. Flag it for the renderer: a
        // bidirectional interchange when both swapped elements carry transforms,
        // else a one-directional donor -> recipient note when exactly one does
        // (`swapTransformDonor` names the transform-carrier first). Keyed on
        // transforms, the applied rules the detail enumerates; a not-yet-applied
        // fuzzy comparison carries its own "(proposed)" caveat in the detail and
        // earns no separate note here.
        const firstTransforms = (first.transform?.length ?? 0) > 0;
        const secondTransforms = (second.transform?.length ?? 0) > 0;
        if (firstTransforms && secondTransforms)
          swapTransformInterchange = true;
        else if (firstTransforms)
          swapTransformDonor = [firstLabel, secondLabel];
        else if (secondTransforms)
          swapTransformDonor = [secondLabel, firstLabel];
      }
    }
  }

  // The always-visible field one-liner: a compact label per element with a terse
  // breadth marker, deduped by the full entry so a truncated element does not
  // collapse onto a whole-value one of the same field. A swap re-attributes each
  // marker to its partner's field (see headerMarkerOverride above); a non-swapped
  // element shows its own marker.
  const headerFields: Array<string> = [];
  const seenHeaderFields = new Set<string>();
  for (const element of key.elements) {
    const label = compactLabelForField(element.field);
    const marker = headerMarkerOverride.has(element)
      ? headerMarkerOverride.get(element)
      : elementBreadthMarker(element);
    const entry = marker !== undefined ? `${label} (${marker})` : label;
    if (seenHeaderFields.has(entry)) continue;
    seenHeaderFields.add(entry);
    headerFields.push(entry);
  }

  return {
    id: key.name,
    name: sanitizeForDisplay(key.name),
    elements,
    headerFields,
    hasSwap,
    swap,
    swapTransformInterchange,
    swapTransformDonor,
  };
}

/**
 * Build a display-ready {@link InvitationSummary} from an invitation's linkage
 * terms, optional expiry, and optional carried disclosed-columns subset. The
 * parameter is a structural subset of {@link InvitationToken} (its
 * `linkageTerms`, `expires`, and `disclosedPayloadColumns`), so a full decoded
 * token is accepted as-is, but so is the terms/expiry pair the exchange screen
 * carries without a token. The "columns your partner will send" line derives from
 * the carried `disclosedPayloadColumns` when present (the wire's own disclosure
 * predicate), falling back to the authored `payload.send` otherwise. Pure and
 * side-effect-free: it derives only what the terms screen renders and sanitizes
 * every partner-controlled string, so it is the single tested boundary for that
 * escaping.
 */
export function summarizeInvitation(
  source: Pick<
    InvitationToken,
    "linkageTerms" | "expires" | "disclosedPayloadColumns"
  >,
): InvitationSummary {
  const terms = source.linkageTerms;

  const fieldByName = new Map(
    terms.linkageFields.map((field) => [field.name, field.type]),
  );

  // Collapse fields that are identical for display -- same semantic-type label
  // and same constraint phrases -- so several fields of one type (the schema
  // permits, e.g., a maiden and a current name both typed `first_name`) do not
  // list the same line twice with nothing to tell them apart (the field `name`
  // that would distinguish them is partner-controlled and deliberately not
  // shown). Fields whose constraints differ stay distinct, since the constraint
  // text then distinguishes them. The dedupe key is the JSON encoding of the
  // (label, constraints) pair, which is injective over that displayed content:
  // a plain join would not be, since a constraint phrase can itself contain the
  // separator (the allowed-character pattern phrase embeds the partner-controlled
  // regex class, which carries spaces). The key is built from the already-sanitized
  // display strings, so two
  // fields whose `allowedCharacters` differ only in characters sanitizeForDisplay
  // folds together collapse -- correctly, since they render identically and
  // nothing the acceptor could distinguish is lost.
  const seenFields = new Set<string>();
  const linkageFields: Array<InvitationFieldSummary> = [];
  for (const field of terms.linkageFields) {
    const summary = {
      label: FIELD_TYPE_LABELS[field.type],
      constraints: describeConstraints(field),
    };
    const dedupeKey = JSON.stringify([summary.label, summary.constraints]);
    if (seenFields.has(dedupeKey)) continue;
    seenFields.add(dedupeKey);
    linkageFields.push(summary);
  }

  // The unique fields the keys match on, compact and deduped in order of first
  // appearance, for the always-visible consent line above the collapsed matching
  // detail. Derived from the keys' elements (the fields actually matched on), not
  // the declared field list, through the same compact-label/sanitize path the
  // per-key sublines use; markers and per-key grouping stay in the disclosure.
  const matchedFields: Array<string> = [];
  const seenMatchedFields = new Set<string>();
  for (const key of terms.linkageKeys) {
    for (const element of key.elements) {
      const type = fieldByName.get(element.field);
      const label =
        type !== undefined
          ? COMPACT_FIELD_TYPE_LABELS[type]
          : sanitizeForDisplay(element.field);
      if (seenMatchedFields.has(label)) continue;
      seenMatchedFields.add(label);
      matchedFields.push(label);
    }
  }

  // The consent screen reflects the inviter's terms as proposed, not only what
  // today's exchange executes: deduplicate and the per-element
  // generateFuzzyComparisons are surfaced even though the run does not yet apply
  // them (matching is currently hard-wired to one-to-one, and fuzzy expansion is
  // unimplemented). The *Applied flags below carry that gap to the renderer; the
  // displayed terms are what the acceptor agrees to.
  const summary: InvitationSummary = {
    invitingParty: sanitizeForDisplay(terms.identity),
    algorithm: terms.algorithm,
    psiCApplied: APPLIED_SETTINGS.psiC,
    linkageStrategy: terms.linkageStrategy,
    inviterReceivesOutput: terms.output.expectsOutput,
    inviterSharesResult: terms.output.shareWithPartner,
    deduplicate: terms.deduplicate,
    deduplicateApplied: APPLIED_SETTINGS.deduplicate,
    linkageKeys: terms.linkageKeys.map((key) => summarizeKey(key, fieldByName)),
    matchedFields,
    linkageFields,
  };

  if (terms.legalAgreement !== undefined) {
    summary.legalAgreement = {
      reference: sanitizeForDisplay(terms.legalAgreement.reference),
      purpose: sanitizeForDisplay(terms.legalAgreement.purpose),
      expirationDate: sanitizeForDisplay(terms.legalAgreement.expirationDate),
    };
  }

  // The columns the acceptor will RECEIVE derive from the carried
  // disclosedPayloadColumns -- the inviter's own isDisclosedToPartner predicate
  // output, exactly the set preparePayload transmits -- so the displayed and
  // consented set cannot drift from the bytes that flow. Fall back to the
  // authored payload.send names for an invitation that carried no disclosed
  // subset (an older or metadata-unknown mint) and for the inviter's own pre-mint
  // "proposing" preview, which has authored its send but holds no token field
  // yet. `receive` (what the inviter requests FROM the acceptor) is unaffected:
  // it has no transmission predicate to derive from and stays the authored list.
  //
  // sendDeclared distinguishes a definite declaration (the carried subset --
  // present even when empty -- or an authored send) from the lazy case (no carried
  // subset and no authored send: the inviter sends whatever its metadata
  // discloses). A declared-but-empty set is the strict "receive nothing" lock-in,
  // which the renderer shows as "(none)" rather than suppressing -- so it is not
  // confused with the lazy case, which has the opposite runtime behavior (a stray
  // payload aborts under the lock-in, is accepted under lazy). receiveDeclared is
  // the mirror of sendDeclared for the opposite direction: an authored
  // `payload.receive` (present even when empty) is a definite request, while an
  // absent one is lazy. A declared-but-empty receive is the strict "the acceptor
  // sends nothing" assertion, rendered "(none)" for the same reason. The section
  // renders whenever the send OR the receive is declared.
  const sendDeclared =
    source.disclosedPayloadColumns !== undefined ||
    (terms.payload?.send ?? []).length > 0;
  const receiveDeclared = terms.payload?.receive !== undefined;
  const send =
    source.disclosedPayloadColumns ??
    (terms.payload?.send ?? []).map((column) => column.name);
  const receive = (terms.payload?.receive ?? []).map((column) => column.name);
  if (sendDeclared || receiveDeclared) {
    summary.payload = {
      send: send.map((name) => sanitizeForDisplay(name)),
      sendDeclared,
      receive: receive.map((name) => sanitizeForDisplay(name)),
      receiveDeclared,
    };
  }

  if (source.expires !== undefined)
    summary.expires = sanitizeForDisplay(source.expires);

  return summary;
}
