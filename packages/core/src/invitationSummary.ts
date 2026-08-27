import { APPLIED_SETTINGS } from "./appliedSettings.js";
import {
  dateFormatComponents,
  describeTransformCoercions,
  FAN_OUT_FUNCTION_NAMES,
  parseDateInputDropsEveryRecord,
  pipelineAlwaysDrops,
} from "./standardization.js";
import { displayText } from "./utils/sanitizeForDisplay.js";
import { redactAndSanitizeForDisplay } from "./utils/sanitizeErrorForDisplay.js";
import { redactAndDisplayPartyIdentity } from "./partyIdentityDisplay.js";

import { endpointRequiresRetainedFiles } from "./config/invitation.js";
import type { InvitationToken } from "./config/invitation.js";
import { checkLinkageRuleSetCitation } from "./defaults/linkageTerms.js";
import type { LinkageRuleSetCitationVerdict } from "./defaults/linkageTerms.js";
import { deduplicateIsImplementedForStrategy } from "./config/linkageTerms.js";
import type {
  LinkageField,
  LinkageKey,
  LinkageKeyElement,
  LinkageStrategy,
  TransformStep,
} from "./config/linkageTerms.js";
import type { Algorithm } from "./types.js";
import type { Displayable } from "./utils/sanitizeForDisplay.js";

/**
 * Human-readable label for each linkage-field semantic type. The `type` is a
 * fixed enum the schema validates (not partner free-text), so these labels are
 * safe to render verbatim. The field's `name` is partner-controlled free text
 * and is deliberately not shown -- the semantic type is what matters for an
 * acceptor deciding whether to consent, and it cannot carry an injection.
 *
 * Typed {@link Displayable} because a label shares display fields with the
 * sanitized fallback for an unresolved field (see {@link summarizeKey}); fixed
 * copy enters through `displayText`, the compiler-policed way in for a literal
 * this file authors.
 */
const FIELD_TYPE_LABELS: Record<LinkageField["type"], Displayable> = {
  first_name: displayText`First name`,
  last_name: displayText`Last name`,
  date_of_birth: displayText`Date of birth`,
  ssn: displayText`Social Security number`,
  ssn4: displayText`Last 4 of Social Security number`,
  phone_number: displayText`Phone number`,
  email_address: displayText`Email address`,
  zip_code: displayText`ZIP code`,
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
const COMPACT_FIELD_TYPE_LABELS: Record<LinkageField["type"], Displayable> = {
  first_name: displayText`first name`,
  last_name: displayText`last name`,
  date_of_birth: displayText`date of birth`,
  ssn: displayText`SSN`,
  ssn4: displayText`SSN (last 4)`,
  phone_number: displayText`phone`,
  email_address: displayText`email`,
  zip_code: displayText`ZIP`,
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
    "Splits the value into several candidates, each able to match " +
    "independently, so a record matches when any one of them does.",
  coalesce:
    "Substitutes a fallback value for an empty field, which can create matches that would not otherwise occur.",
};

/** Legal-agreement context, with the partner-controlled free text sanitized. */
export interface InvitationLegalAgreementSummary {
  /** Agreement identifier (e.g. "MOU-2025-0042"), sanitized for display. */
  reference: Displayable;
  /** Stated purpose of the disclosure, sanitized for display. */
  purpose: Displayable;
  /**
   * ISO 8601 date (YYYY-MM-DD) after which the exchange is refused, sanitized
   * for display like the free-text fields: the `z.iso` schema rejects anything
   * that could carry a deceptive character today, but the boundary does not
   * depend on that validation staying in place.
   */
  expirationDate: Displayable;
}

/**
 * One half of the rule-set citation the inviter declares -- the field set or the
 * key set -- with both strings sanitized for display.
 *
 * The name and version are the INVITER's declaration about its own rules: the
 * token is accepted on a transcription checksum, not an authenticity guarantee,
 * so a surface presents them as the inviting party's citation rather than as a
 * psilink-vouched provenance, and leaves the declared keys and fields beside them
 * -- which the acceptor's consent actually turns on -- to stand as the account of
 * what will run. Sanitized once here, at the single display boundary, like every
 * other partner string.
 *
 * The {@link verdict} is not the inviter's: it is this build's own check of that
 * half, so a surface reading it states what psilink found rather than what the
 * partner claimed. It resolves only the sets this build ships, so a name it
 * cannot resolve is `unchecked` -- carried and caveated exactly as before, since
 * nothing here resolves a partner's set name.
 */
export interface InvitationRuleSetIdentitySummary {
  /** The set's declared name, sanitized for display. */
  name: Displayable;
  /** The set's declared content version, sanitized for display. */
  version: Displayable;
  /** This build's verdict on whether the declared rules of this half are drawn
   * from the set named above. Fixed first-party values, not partner text. */
  verdict: LinkageRuleSetCitationVerdict;
}

/**
 * The named rule set the inviter cites its linkage fields and keys to. Present
 * only when the invitation declares one; terms whose rules were authored carry
 * no citation, and a surface renders nothing rather than inventing one.
 */
export interface InvitationRuleSetSummary {
  /** The set the declared linkage fields are cited to. */
  fieldSet: InvitationRuleSetIdentitySummary;
  /** The set the declared linkage keys are cited to. */
  keySet: InvitationRuleSetIdentitySummary;
}

/** The optional data columns the inviter declares, with names sanitized. */
export interface InvitationPayloadSummary {
  /** Columns the inviter will send for matched records (what the acceptor
   * receives), in the inviter's namespace, each sanitized for display. Empty when
   * the declared set is empty; read {@link sendDeclared} to tell that apart from
   * the lazy case. */
  send: Array<Displayable>;
  /**
   * Whether the send set is a definite DECLARATION -- the carried disclosed
   * subset (possibly empty), or an authored `payload.send` -- as opposed to the
   * lazy case (the inviter sends whatever its own metadata discloses, nothing
   * declared up front). When true and {@link send} is empty the acceptor is
   * locked in to "receive nothing" (a later non-empty payload aborts), so the
   * renderer states that explicitly ("(none)") rather than omitting the line;
   * when false the send side is lazy and is not shown. Whether the declaration is
   * one an acceptance can hold the inviter to is the narrower
   * {@link sendFromCarriedSubset}.
   */
  sendDeclared: boolean;
  /**
   * Whether {@link send} is the disclosed subset the invitation CARRIED -- the
   * inviter's own transmission predicate run over its own metadata -- rather than
   * the authored `payload.send` the summary falls back to when no subset was
   * carried. Strictly narrower than {@link sendDeclared}: a carried subset is
   * always a declaration, while an authored send is a declaration with no subset
   * behind it.
   *
   * The narrower condition is the one enforcement turns on. An acceptance locks
   * in the CARRIED subset as what it will receive, and reconciles the received
   * payload against it; where the invitation carried none there is no such set to
   * write, and an absent expectation is the lazy reconciliation path, so an online
   * run takes whatever the inviter transmits. A surface classifying the
   * received-columns fact reads this rather than {@link sendDeclared}.
   */
  sendFromCarriedSubset: boolean;
  /** Columns the inviter requests from the acceptor for matched records (what
   * the acceptor sends), each sanitized for display. Empty when the declared set
   * is empty; read {@link receiveDeclared} to tell that apart from the lazy
   * case. */
  receive: Array<Displayable>;
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
  function: Displayable;
  /**
   * One sanitized `key: value` string per declared parameter, in declaration
   * order, capped at {@link MAX_DISPLAYED_PARAMS} (a trailing "... N more"
   * entry marks any overflow). sanitizeForDisplay bounds each entry's length and
   * the count is capped, so an arbitrarily large partner-supplied `params`
   * record cannot flood the screen. Empty when the step declares no parameters.
   * Each parameter is shown verbatim; a parameter core coerces before applying
   * is clarified separately in {@link coercions}, not folded into its line.
   */
  params: Array<Displayable>;
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
   * The phrase is fixed copy carrying partner-supplied slice positions, so it is
   * composed through `displayText`, which admits a number but no partner string.
   */
  effect?: Displayable;
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
  /**
   * Human-readable label for the field this element derives from: the fixed
   * label for its semantic type, or the sanitized raw field name when the
   * reference does not resolve.
   */
  fieldLabel: Displayable;
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
   * obligation, so it is not sanitized. That it stays off both acceptance
   * surfaces is checked rather than stated: the web app's browser suite mounts
   * the consent screen, and the CLI suite renders the accept prompt, on linkage
   * terms whose every partner-controlled string carries a hostile code point, and
   * each fails on any output text outside printable ASCII.
   */
  id: string;
  /** The key's name, sanitized for display. */
  name: Displayable;
  /** Ordered elements combined to form the key. */
  elements: Array<InvitationKeyElementSummary>;
  /** True when the key declares a swap (two elements matched in either order). */
  hasSwap: boolean;
  /**
   * The two swapped elements' field labels, present only when both swap
   * references resolve to elements with *distinct* labels (the common case,
   * e.g. ["Last name", "First name"]). Absent when an identifier names no
   * element or the two would carry the same label: an unresolved swap
   * identifier never enters this tuple, raw or sanitized -- the renderer falls
   * back to a generic swap note keyed off {@link hasSwap} instead. The entries
   * are the same resolved labels {@link InvitationKeyElementSummary.fieldLabel}
   * carries, so like those they fall back to a sanitized raw field name for an
   * element whose field reference does not resolve.
   */
  swap?: [Displayable, Displayable];
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
  swapTransformDonor?: [Displayable, Displayable];
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
  headerFields: Array<Displayable>;
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
   * it is advisory and can hold hundreds of entries. The partner-authored
   * `allowedCharacters` class is NOT among these -- it is a raw partner-controlled
   * regular expression, so it is carried apart in {@link allowedCharacters} for
   * the renderer to bind in its own bounded element rather than fold into a joined
   * phrase (see the field doc there).
   */
  constraints: Array<string>;
  /**
   * The partner-authored `allowedCharacters` class the field declares, sanitized
   * for display, present only when the field declares one. Carried apart from
   * {@link constraints} -- not folded into a joined "allowed-character pattern: X"
   * phrase -- so the renderer can bind this partner-controlled value in its OWN
   * bounded element between the fixed, core-derived system label, the way the
   * transform-coercion notes bind their partner value (see
   * {@link InvitationTransformSummary.coercions}). A partner cannot then place
   * separator text inside the class to impersonate the surrounding system label.
   * The value arrives in an invitation accepted on a transcription checksum and is
   * never vetted (the evaluating check is warn-not-enforce, core's
   * `withinAllowedCharacters`); the renderer's fixed label marks it as
   * partner-supplied and unverified. Sanitized once here, at the single display
   * boundary, so no caller re-derives the escaping.
   */
  allowedCharacters?: Displayable;
}

/**
 * A display-ready, injection-safe view of the inviter's linkage terms, derived
 * from a decoded {@link InvitationToken}. Every partner-controlled value (the
 * self-asserted identity, linkage-key names, legal-agreement text, payload
 * column names, and the schema-validated date fields) is passed through
 * {@link redactAndSanitizeForDisplay} here, at the one boundary, so neither
 * acceptance surface -- the web consent screen nor the CLI accept prompt --
 * re-derives the escaping. The redaction half is what the CLI prompt's route
 * needs: it also goes to a log line (`consentSurfaceSink` in
 * `apps/cli/src/invitationDisplay.ts`), where the sink's own private-key pass
 * would otherwise let a marker planted in a key or column name consume the
 * consent text composed after it on the same line.
 * Neither renderer's own defenses suffice: React's JSX escaping covers
 * HTML metacharacters, and a terminal none, but neither covers the control, bidi,
 * zero-width, or homoglyph characters this neutralizes. The dates cannot carry
 * such characters today (the
 * `z.iso` schemas reject them), but routing them through the same boundary keeps
 * the contract uniform rather than depending on that validation staying in place.
 *
 * Every field a partner-controlled value can reach AND that is rendered is typed
 * {@link Displayable} rather than `string`, across this interface and the nested
 * summaries, so filling one of them from an un-sanitized value fails to compile.
 * The guarantee runs in that direction only: the brand rejects a plain `string`
 * assigned into a field already DECLARED `Displayable`, and nothing forces a
 * newly added field to be declared that way -- one declared `string` and filled
 * from a partner value still compiles. The runtime half covers that gap: a test
 * walks this whole returned value, built from linkage terms whose every
 * partner-controlled string carries a hostile code point, and fails on any string
 * outside printable ASCII, with no per-field list to keep current. What the brand
 * adds is the compile-time half: an existing field cannot silently lose its
 * sanitize call.
 *
 * Most fields left as `string` are ones no partner value reaches: fixed copy
 * keyed by a schema-validated enum, and the core-derived transform notes.
 * {@link InvitationKeySummary.id} is the exception -- it carries the partner's
 * raw key name verbatim, and is safe because it is never rendered, not because
 * its value is first-party. Rendering it would need the sanitize call its
 * unbranded type does not demand.
 */
export interface InvitationSummary {
  /** The inviter's self-asserted identity, sanitized for display, or the
   * absence marker `partyIdentityDisplay.ts` carries where the inviter supplied
   * none. */
  invitingParty: Displayable;
  /** `psi` reveals matched identifiers; `psi-c` reveals only the count. */
  algorithm: Algorithm;
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
   * Whether several of the inviting party's records may match the same one of
   * the accepting party's records (the inviter's declared deduplicate
   * setting).
   */
  deduplicate: boolean;
  /**
   * Whether an exchange on these terms applies the deduplicate setting above
   * (see {@link APPLIED_SETTINGS}). True: the cascade matches the resolved
   * cardinality and every surface downstream of the association table carries
   * the multiplicity. False where the strategy this invitation names matches no
   * deduplicating cardinality, which acceptance refuses outright
   * (`assertDeduplicateImplemented`) -- so a surface reading this flag never
   * states what a deduplicating run discloses for a run that cannot happen.
   *
   * Read alongside {@link deduplicate}, like `fansOut` and `fanOutApplied`: this
   * flag answers what the strategy would do with a deduplicating term, whether or
   * not these terms declare one. The one refusal it does NOT carry is the
   * both-sided pair, which is a property of the agreed PAIR and unreadable from
   * an invitation alone.
   */
  deduplicateApplied: boolean;
  /**
   * Whether any linkage key's element transforms split one value into several
   * match candidates -- the fan-out an element marker names, as "multiple" where
   * the strategy matches those candidates and "not supported" where it refuses
   * the exchange.
   *
   * Read from the AGREED terms alone, which is all an invitation carries: the
   * inviting party's own data standardization can fan out a field the terms do
   * not show, and no invitation carries one. So this is what the acceptor can be
   * told, not the whole of what the inviter may run.
   */
  fansOut: boolean;
  /**
   * Whether the exchange this invitation proposes matches on those candidates.
   *
   * True exactly for `single-pass`, the one strategy fan-out matching is
   * specified for (docs/spec/PROTOCOL.md, Fan-out runs under single-pass only);
   * under any other, terms declaring a fan-out are refused before the exchange
   * runs. Meaningful only alongside {@link fansOut}, and it selects which of the
   * two fan-out consent facts a surface renders, exactly as the pair of output
   * receipts is selected by value.
   */
  fanOutApplied: boolean;
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
  matchedFields: Array<Displayable>;
  /** PII fields involved, each with its label and declared constraints. */
  linkageFields: Array<InvitationFieldSummary>;
  /**
   * The named rule set the inviter cites the keys and fields above to. Present
   * only when the invitation declares one; see
   * {@link InvitationRuleSetSummary} for why a surface renders it as the
   * inviter's citation rather than as a vouched provenance.
   */
  linkageRuleSet?: InvitationRuleSetSummary;
  /** Present only when the inviter attached a legal agreement. */
  legalAgreement?: InvitationLegalAgreementSummary;
  /** Present only when the inviter declared payload columns to send or receive. */
  payload?: InvitationPayloadSummary;
  /**
   * The invitation's expiry instant (ISO 8601), if the token carries one,
   * sanitized for display on the same uniform-contract grounds as the agreement
   * dates.
   */
  expires?: Displayable;
  /**
   * Whether the invitation discloses that its exchange keeps every file it writes
   * -- retain mode, which leaves the rendezvous location a permanent transcript
   * rather than deleting each file once it has been read.
   *
   * True on either of two grounds, of which a renderer is told only the outcome:
   * the invitation DECLARES retain mode (`inviterRetainsFiles: true`), or its
   * connection endpoint carries the split inbound/outbound directory pair, whose
   * shape requires retain mode of any connection built from it
   * ({@link endpointRequiresRetainedFiles}) -- so an acceptor seeded from such an
   * endpoint runs in retain mode whether or not the token declared it, and a
   * display gated on the declaration alone would leave that acceptor consenting
   * to a permanent transcript with nothing said.
   *
   * A one-way flag, not the inviter's setting mirrored: false means neither
   * ground holds -- a token declaring `inviterRetainsFiles: false`, one declaring
   * nothing (an older token, a mint with no settled connection, or a channel with
   * no retain mode), or the inviter's own pre-mint preview. Named for the
   * disclosure rather than for the mode so a renderer cannot read a false as
   * "your partner deletes the files" -- the claim the `retainedFiles` entry of
   * `CONSENT_FACTS` records as one no surface may make. A surface therefore
   * renders the retention fact on true and nothing on false.
   *
   * Derived from schema-validated values, not partner free text, so it carries no
   * display obligation.
   */
  disclosesRetainedFiles: boolean;
  /**
   * The partner's advisory shared-directory locator, sanitized for display: the
   * `path` a single-directory file-drop endpoint carries. Present only for such an
   * endpoint. Advisory only -- it never flows to any config, and it is the folder's
   * own name only where the inviting console could name the folder, so a surface
   * that presents it AS the shared folder's name overstates what it is. Sanitized
   * for TEXT display only: safe as a React text child, whose escaping is part of its
   * safety, and never to be interpolated into an attribute value or raw HTML.
   */
  connectionPath?: Displayable;
}

/**
 * Plain-language descriptions of a field's declared constraints, in a stable
 * order. The `exclude` denylist is reported as a count, not its values: it is
 * advisory and may hold hundreds of entries.
 *
 * The partner-authored `allowedCharacters` class is deliberately NOT among these
 * phrases -- it is surfaced apart in {@link allowedCharactersClass}, so the
 * renderer binds the raw partner value in its own bounded element rather than
 * folding it into a joined sentence a partner could impersonate. See that
 * function for the trust-boundary rationale.
 */
function describeConstraints(field: LinkageField): Array<string> {
  const constraints = field.constraints;
  if (constraints === undefined) return [];

  const descriptions: Array<string> = [];
  if ("validOnly" in constraints && constraints.validOnly === true)
    descriptions.push("values must be valid");
  if ("affixesAllowed" in constraints && constraints.affixesAllowed === false)
    descriptions.push("honorifics and suffixes removed");
  const exclude = constraints.exclude ?? [];
  if (exclude.length > 0)
    descriptions.push(
      `${exclude.length} excluded value${exclude.length === 1 ? "" : "s"}`,
    );
  return descriptions;
}

/**
 * The field's partner-authored `allowedCharacters` class, sanitized for display,
 * or undefined when the field declares none. Surfaced as the raw class alone
 * (with no joined system label) so the renderer can bind it in its own bounded
 * element between the fixed, core-derived label -- the way the transform-coercion
 * notes bind their partner value -- rather than concatenating label and value into
 * one string a partner could impersonate with separator text.
 *
 * The value is a partner-authored regular-expression character class: it arrives
 * in the invitation token, accepted on a transcription checksum -- not an
 * authenticity guarantee -- and is never vetted, so a crafted class reads very
 * differently to a human than the set it admits. A leading `^` negates it (`^A-Z`
 * admits every character EXCEPT A-Z), and a shorthand or bracket breakout (`\p{L}`,
 * `[:alpha:]`, `]|\w|[`) is opaque to a non-regex-literate operator -- so a
 * "limited to <class>" phrasing would present raw partner regex as a vetted,
 * plain-language promise it is not. The renderer instead labels it as the
 * partner-supplied, unverified regular expression it is, and shows the raw class
 * (sanitized) so a regex-literate reviewer can inspect the actual pattern. The
 * check that evaluates the class is warn-not-enforce (core's
 * `withinAllowedCharacters`); the display is that check's operator-facing
 * complement. `allowedCharacters` is a short, length-bounded, partner-controlled
 * string, so it is sanitized before display, once here at the single boundary.
 */
function allowedCharactersClass(field: LinkageField): Displayable | undefined {
  const constraints = field.constraints;
  if (
    constraints === undefined ||
    !("allowedCharacters" in constraints) ||
    constraints.allowedCharacters === undefined
  )
    return undefined;
  return redactAndSanitizeForDisplay(constraints.allowedCharacters);
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
): Displayable | undefined {
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
      ? displayText`the first character`
      : displayText`the first ${length} characters`;
  if (start > 1)
    return displayText`characters ${start} to ${start + length - 1}`;
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
    redactAndSanitizeForDisplay(`${entry[0]}: ${describeParamValue(entry[1])}`),
  );
  if (entries.length > MAX_DISPLAYED_PARAMS)
    params.push(displayText`... ${entries.length - MAX_DISPLAYED_PARAMS} more`);
  const summary: InvitationTransformSummary = {
    function: redactAndSanitizeForDisplay(step.function),
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

// Core's parseDateFactory defaults (standardization.ts): an absent format is the
// full MM/DD/YYYY -> YYYYMMDD layout, which carries every component, so an absent
// outputFormat drops nothing.
const DEFAULT_PARSE_DATE_INPUT = "MM/DD/YYYY";
const DEFAULT_PARSE_DATE_OUTPUT = "YYYYMMDD";

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
  // The output is classified in its OWN context: a `YY` in the output format is an
  // unsubstituted literal (the factory fills only YYYY/MM/DD), so it collapses the
  // year and carries no year component -- an output of "YY" is a total constant
  // ("any date"), and "MM/DD/YY" keeps month and day but drops the year.
  const outputComponents = dateFormatComponents(output, "output");
  if (outputComponents.size === 0) return "any date";
  const dropsComponent = [...dateFormatComponents(input, "input")].some(
    (component) => !outputComponents.has(component),
  );
  return dropsComponent ? "partial" : undefined;
}

/** Whether the element's transform declares a step that expands its value into
 * several match candidates -- the rule behind the "multiple" marker, and, where
 * the strategy refuses such an exchange, behind the "not supported" one. */
function declaresFanOut(element: LinkageKeyElement): boolean {
  const functions = new Set((element.transform ?? []).map((s) => s.function));
  return FAN_OUT_FUNCTION_NAMES.some((name) => functions.has(name));
}

/**
 * Transform functions that derive a value the acceptor's own identifier need not
 * compose, so a later `substring` slicing that value is no longer a truncation of
 * the identifier and earns no "partial" (see {@link elementBreadthMarker}, which
 * carries the per-function reasoning and why the rest of the value-deriving family
 * is deliberately absent). Membership is a policy decision about the always-visible
 * consent marker, not core's runtime behavior; the names are core's own
 * schema-validated function names, so the marker stays derived from the validated
 * function set rather than from partner free text.
 */
const LITERAL_CORRESPONDENCE_BREAKING_FUNCTIONS: ReadonlySet<string> = new Set([
  "phonetic",
  "replace_regex",
]);

/**
 * The terse informative marker for a key element's collapsed-header entry.
 *
 * A rule the exchange refuses outright is named as one ("not supported") and
 * outranks every marker below: no matching of any breadth happens under it, so
 * naming a breadth would describe a run that does not occur. The fan-out family
 * is that case under a strategy that matches one value per record; under
 * single-pass, which matches the whole candidate set, the same element earns the
 * breadth marker "multiple" instead -- `fanOutMatches` is which of the two the
 * agreed strategy makes true.
 *
 * The marker is undefined when the element matches exactly or only canonicalizes
 * its value (case, whitespace, accents, affixes, padding, and a `parse_date` that merely
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
 * "fuzzy" / "sound-alike" / "fallback" for an expansion), and where an
 * arbitrary partner-authored pattern or value list makes the direction
 * indeterminate it names the RULE directly ("pattern replacement", "pattern
 * extraction", "pattern filter", "excludes values"). Informative, not a
 * broaden-only warning: `filter_regex` and `null_if` narrow matching but are
 * still surfaced. "fuzzy" is reserved for the genuine fuzzy-comparison expansion,
 * distinct from `substring`'s "partial". None of the regex/value rules appear on
 * the default or guided path (only `substring` and `swap` do), so an
 * expert-authored rule is what trips those markers.
 *
 * "partial" marks a LITERAL character-truncation, so it fires for a `substring`
 * only where the slice runs on a value the acceptor's own identifier still
 * composes. A prior step that derives a value the identifier need not compose
 * breaks that correspondence, and the substring after it earns no "partial": the
 * deriving step's own marker is then the dominant, honest one. Two functions break
 * it ({@link LITERAL_CORRESPONDENCE_BREAKING_FUNCTIONS}), and the rest of the
 * value-deriving family deliberately does not:
 *
 * - `phonetic` breaks it. The name is replaced by an opaque sound-alike code, so
 *   the slice truncates the code rather than the name and "sound-alike" is what
 *   the element does.
 * - `replace_regex` breaks it. An arbitrary partner-authored pattern and
 *   replacement compose the value, which need share no character with the
 *   identifier -- a `.*` pattern collapses every value to the replacement -- so
 *   "partial" would assert a determinate breadth the terms cannot support, and on
 *   a consent surface it would assert the reassuring direction. "pattern
 *   replacement" names the indeterminate rule instead, exactly as it does for the
 *   step standing alone. That is the existing precedence applied, not reversed:
 *   the effect-named rule does not fire, so the directly-named one shows.
 * - `extract_regex` keeps it. Core's extraction returns a contiguous run of the
 *   value's own characters, so a slice of that run is still part of the
 *   identifier and the effect stays determinate whatever the pattern.
 * - `parse_date` keeps it. The canonical date is laid out from the date's own
 *   components, so slicing it matches on only part of the date -- the same reading
 *   the output-drops-a-component branch below gives "partial". Keeping it is also
 *   what stops a date-collapsing slice from showing NO marker, since a merely
 *   reformatting `parse_date` earns none of its own.
 * - `coalesce` keeps it. It substitutes only where the value is absent, so a
 *   record that carries an identifier is truncated literally, and the substitution
 *   is order-independent -- suppressing here would mark `[coalesce, substring]`
 *   and `[substring, coalesce]` differently for the same matching behavior.
 * - `split_on` never reaches this rule: it is a fan-out, decided above.
 *
 * This mirrors the detail row's position-aware literal ({@link substringEffect} /
 * {@link summarizeKey}, which render "the first N characters" only for a substring
 * on the unmodified value) at the coarser grain the header claims. The detail
 * asserts a character POSITION, which any earlier step can shift, so it needs the
 * first step; the header asserts only that part of the value is matched on, which
 * survives a position-shifting normalizer. So a routine normalizer before the
 * substring (case/accents/...) keeps "partial", and a breaking step AFTER the
 * substring does too, since the literal is truncated first.
 *
 * Returns a SINGLE, most-salient marker, not one per rule: the always-visible
 * header is deliberately terse, so an element carrying more than one rule shows
 * just the first -- the fan-out rule ranks first, whichever of its two markers it
 * earns, then the maximal-breadth "any date" collapse, then the other
 * effect-named rules, then the directly-named ones -- while its complete rule set
 * is carried on {@link InvitationKeySummary.elements} for the renderer's per-key
 * detail. The element stays flagged either way.
 */
function elementBreadthMarker(
  element: LinkageKeyElement,
  fanOutMatches: boolean,
): Displayable | undefined {
  const steps = element.transform ?? [];
  const functions = new Set(steps.map((s) => s.function));
  // Fan-out outranks every marker below, including the maximal-breadth "any
  // date" collapse and the dead-pipeline suppression, in both of its cases. Where
  // the strategy matches the candidate set a splitting record realizes, the
  // element matches on several values at once, which is a broader breadth than
  // any single-valued rule below could name. Where it does not, core refuses the
  // exchange before it runs (assertFanOutImplemented), so no matching of any
  // breadth happens and naming one would describe a run that does not occur.
  if (declaresFanOut(element))
    return fanOutMatches ? displayText`multiple` : displayText`not supported`;
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
  if (parseDateBreadths.includes("any date")) return displayText`any date`;
  // Effect named where the direction is determinable from the terms. "partial"
  // is a literal truncation, so a substring counts only where the value it slices
  // is still composed of the acceptor's identifier -- not after a step that
  // derives an unrelated value, whose own marker (below) is then the honest one.
  const truncatesLiteral = steps.some(
    (step, index) =>
      step.function === "substring" &&
      !steps
        .slice(0, index)
        .some((prior) =>
          LITERAL_CORRESPONDENCE_BREAKING_FUNCTIONS.has(prior.function),
        ),
  );
  if (truncatesLiteral) return displayText`partial`;
  if (element.generateFuzzyComparisons !== undefined) return displayText`fuzzy`;
  if (functions.has("phonetic")) return displayText`sound-alike`;
  if (functions.has("coalesce")) return displayText`fallback`;
  // parse_date is routine date canonicalization UNLESS its output layout narrows
  // matching: an output that keeps a date token but drops a component its input
  // carries matches on only part of the date ("partial"). The tokenless
  // every-date-to-one case is the stronger "any date", handled at the top.
  if (parseDateBreadths.includes("partial")) return displayText`partial`;
  // Rule named directly where a partner-authored pattern or value list makes the
  // matching direction indeterminate from the terms alone.
  if (functions.has("replace_regex")) return displayText`pattern replacement`;
  if (functions.has("extract_regex")) return displayText`pattern extraction`;
  if (functions.has("filter_regex")) return displayText`pattern filter`;
  if (functions.has("null_if")) return displayText`excludes values`;
  return undefined;
}

/**
 * Reduce one linkage key to its display summary, resolving each element's field
 * reference to a human-readable label and surfacing every non-default matching
 * rule. `fieldByName` maps a field `name` to its semantic type; an element or
 * swap reference that does not resolve falls back to the sanitized raw string.
 * `fanOutMatches` is whether the agreed strategy matches a record's whole
 * candidate set, which decides both fan-out markers below.
 */
function summarizeKey(
  key: LinkageKey,
  fieldByName: Map<string, LinkageField["type"]>,
  fanOutMatches: boolean,
): InvitationKeySummary {
  const labelForField = (fieldName: string): Displayable => {
    const type = fieldByName.get(fieldName);
    return type !== undefined
      ? FIELD_TYPE_LABELS[type]
      : redactAndSanitizeForDisplay(fieldName);
  };

  const compactLabelForField = (fieldName: string): Displayable => {
    const type = fieldByName.get(fieldName);
    return type !== undefined
      ? COMPACT_FIELD_TYPE_LABELS[type]
      : redactAndSanitizeForDisplay(fieldName);
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
  let swap: [Displayable, Displayable] | undefined;
  let swapTransformInterchange = false;
  let swapTransformDonor: [Displayable, Displayable] | undefined;
  // Header-marker re-attribution across a swap: maps each swapped element to the
  // breadth marker its header entry should show INSTEAD of its own (an explicit
  // `undefined` blanks the marker). Empty for a non-swap, a same-label swap, or a
  // pair carrying a refused rule (see below), so the header loop falls back to
  // each element's own marker. Built here because the swap resolution below
  // supplies the element pairing it needs.
  const headerMarkerOverride = new Map<
    LinkageKeyElement,
    Displayable | undefined
  >();
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
        // identical header, and a no-marker pair to the bare labels. A fan-out
        // that MATCHES re-attributes like any other rule: the element's
        // candidates are what the partner's field is matched on, which is what
        // the marker describes. The one exception is a refused rule: "not
        // supported" names a step the operator has to find and remove, and the
        // step sits in the element that DECLARES it, whichever field that element
        // reads on a receiver. Re-attribution describes what a run does to each
        // field, and a refused key has no run to describe, so a refused fan-out
        // anywhere in the pair leaves both markers on their declaring elements
        // rather than pointing the operator at a field carrying no such step.
        const refusedFanOut =
          !fanOutMatches && (declaresFanOut(first) || declaresFanOut(second));
        if (!refusedFanOut) {
          headerMarkerOverride.set(
            first,
            elementBreadthMarker(second, fanOutMatches),
          );
          headerMarkerOverride.set(
            second,
            elementBreadthMarker(first, fanOutMatches),
          );
        }
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
  const headerFields: Array<Displayable> = [];
  const seenHeaderFields = new Set<string>();
  for (const element of key.elements) {
    const label = compactLabelForField(element.field);
    const marker = headerMarkerOverride.has(element)
      ? headerMarkerOverride.get(element)
      : elementBreadthMarker(element, fanOutMatches);
    const entry =
      marker !== undefined ? displayText`${label} (${marker})` : label;
    if (seenHeaderFields.has(entry)) continue;
    seenHeaderFields.add(entry);
    headerFields.push(entry);
  }

  return {
    id: key.name,
    name: redactAndSanitizeForDisplay(key.name),
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
 * `linkageTerms`, `expires`, `disclosedPayloadColumns`, `connectionEndpoint`,
 * and `inviterRetainsFiles`), so a full decoded token is accepted as-is, but so
 * is the terms/expiry pair the exchange screen carries without a token. The
 * "columns your partner will send" line derives from the carried
 * `disclosedPayloadColumns` when present (the wire's own disclosure predicate),
 * falling back to the authored `payload.send` otherwise, and the retained-files
 * line from the declaration or the endpoint's split-directory shape (see
 * {@link InvitationSummary.disclosesRetainedFiles}). Pure and side-effect-free:
 * it derives only what the terms screen renders and sanitizes every
 * partner-controlled string, so it is the single tested boundary for that
 * escaping.
 */
export function summarizeInvitation(
  source: Pick<
    InvitationToken,
    | "linkageTerms"
    | "expires"
    | "disclosedPayloadColumns"
    | "connectionEndpoint"
    | "inviterRetainsFiles"
  >,
): InvitationSummary {
  const terms = source.linkageTerms;

  // A single-directory file-drop endpoint's advisory path is partner-controlled free
  // text, so it is sanitized here like every other displayed partner string; the
  // split inbound/outbound pair and non-filedrop endpoints carry no single locator.
  const endpoint = source.connectionEndpoint;
  const connectionPath =
    endpoint?.channel === "filedrop" && endpoint.path !== undefined
      ? redactAndSanitizeForDisplay(endpoint.path)
      : undefined;

  const fieldByName = new Map(
    terms.linkageFields.map((field) => [field.name, field.type]),
  );

  // Collapse fields that are identical for display -- same semantic-type label,
  // same constraint phrases, and same allowed-character class -- so several fields
  // of one type (the schema permits, e.g., a maiden and a current name both typed
  // `first_name`) do not list the same line twice with nothing to tell them apart
  // (the field `name` that would distinguish them is partner-controlled and
  // deliberately not shown). Fields whose constraints or allowed-character class
  // differ stay distinct, since that content then distinguishes them. The dedupe
  // key is the JSON encoding of the (label, constraints, allowedCharacters) triple,
  // which is injective over that displayed content: a plain join would not be,
  // since a constraint phrase or the regex class can itself contain the separator.
  // The key is built from the already-sanitized display strings, so two fields
  // whose `allowedCharacters` differ only in characters sanitizeForDisplay folds
  // together collapse -- correctly, since they render identically and nothing the
  // acceptor could distinguish is lost.
  const seenFields = new Set<string>();
  const linkageFields: Array<InvitationFieldSummary> = [];
  for (const field of terms.linkageFields) {
    const allowed = allowedCharactersClass(field);
    const summary: InvitationFieldSummary = {
      label: FIELD_TYPE_LABELS[field.type],
      constraints: describeConstraints(field),
      ...(allowed !== undefined ? { allowedCharacters: allowed } : {}),
    };
    const dedupeKey = JSON.stringify([
      summary.label,
      summary.constraints,
      summary.allowedCharacters ?? null,
    ]);
    if (seenFields.has(dedupeKey)) continue;
    seenFields.add(dedupeKey);
    linkageFields.push(summary);
  }

  // The unique fields the keys match on, compact and deduped in order of first
  // appearance, for the always-visible consent line above the collapsed matching
  // detail. Derived from the keys' elements (the fields actually matched on), not
  // the declared field list, through the same compact-label/sanitize path the
  // per-key sublines use; markers and per-key grouping stay in the disclosure.
  const matchedFields: Array<Displayable> = [];
  const seenMatchedFields = new Set<string>();
  for (const key of terms.linkageKeys) {
    for (const element of key.elements) {
      const type = fieldByName.get(element.field);
      const label =
        type !== undefined
          ? COMPACT_FIELD_TYPE_LABELS[type]
          : redactAndSanitizeForDisplay(element.field);
      if (seenMatchedFields.has(label)) continue;
      seenMatchedFields.add(label);
      matchedFields.push(label);
    }
  }

  // The consent screen reflects the inviter's terms as proposed, not only what
  // today's exchange executes: the per-element generateFuzzyComparisons is
  // surfaced even though the run does not yet apply the expansion. The *Applied
  // flags below carry that gap to the renderer; the displayed terms are what the
  // acceptor agrees to.
  // Which of the two fan-out registers this invitation is in: the strategy that
  // matches a candidate set, or one that refuses the terms outright. Read once
  // here so the element markers, the key summaries and the consent fact a surface
  // renders all follow the same verdict.
  const fanOutMatches = terms.linkageStrategy === "single-pass";
  // Whether the strategy this invitation names matches the deduplicating
  // cardinality its term asks for; a strategy that does not is refused at
  // acceptance rather than run. Read from the refusal's OWN predicate rather than
  // restated here, so the copy cannot stay withheld for a strategy the refusal has
  // stopped refusing, and read once so both surfaces withhold it on the same
  // verdict.
  const deduplicateApplied =
    APPLIED_SETTINGS.deduplicate &&
    deduplicateIsImplementedForStrategy(terms.linkageStrategy);

  const summary: InvitationSummary = {
    invitingParty: redactAndDisplayPartyIdentity(terms.identity),
    algorithm: terms.algorithm,
    linkageStrategy: terms.linkageStrategy,
    inviterReceivesOutput: terms.output.expectsOutput,
    inviterSharesResult: terms.output.shareWithPartner,
    deduplicate: terms.deduplicate,
    deduplicateApplied,
    fansOut: terms.linkageKeys.some((key) => key.elements.some(declaresFanOut)),
    fanOutApplied: fanOutMatches,
    linkageKeys: terms.linkageKeys.map((key) =>
      summarizeKey(key, fieldByName, fanOutMatches),
    ),
    matchedFields,
    linkageFields,
    // Narrowed to the one value a surface may state, over both grounds that put
    // an acceptor's run in retain mode: the inviter's declaration, and an
    // endpoint whose split-directory shape the acceptor's own connection is
    // seeded from -- read through the very predicate that seeding reads, so a
    // second shape test cannot drift from it. The declaration itself is
    // three-valued -- declared retain, declared delete, nothing declared -- and
    // only the first is a fact about the run an acceptor consents to, so the
    // other two collapse here rather than at each renderer, where a surface could
    // otherwise reach a "false" and word a cleanup promise around it.
    disclosesRetainedFiles:
      source.inviterRetainsFiles === true ||
      endpointRequiresRetainedFiles(endpoint),
  };

  if (terms.linkageRuleSet !== undefined) {
    // The verdict runs over the SAME terms the names are read from, so each half's
    // marker and its name cannot come apart on the surface that renders them.
    const verdicts = checkLinkageRuleSetCitation(terms.linkageRuleSet, terms);
    summary.linkageRuleSet = {
      fieldSet: {
        name: redactAndSanitizeForDisplay(terms.linkageRuleSet.fieldSet.name),
        version: redactAndSanitizeForDisplay(
          terms.linkageRuleSet.fieldSet.version,
        ),
        verdict: verdicts.fieldSet,
      },
      keySet: {
        name: redactAndSanitizeForDisplay(terms.linkageRuleSet.keySet.name),
        version: redactAndSanitizeForDisplay(
          terms.linkageRuleSet.keySet.version,
        ),
        verdict: verdicts.keySet,
      },
    };
  }

  if (terms.legalAgreement !== undefined) {
    summary.legalAgreement = {
      reference: redactAndSanitizeForDisplay(terms.legalAgreement.reference),
      purpose: redactAndSanitizeForDisplay(terms.legalAgreement.purpose),
      expirationDate: redactAndSanitizeForDisplay(
        terms.legalAgreement.expirationDate,
      ),
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
  //
  // sendFromCarriedSubset carries which of the two declaration cases produced the
  // displayed send, because only the carried subset becomes an acceptance's
  // received-column lock-in: the authored fallback writes no expectation, and an
  // absent expectation is the lazy path, so a surface marking that fact enforced
  // off sendDeclared alone would announce a check that does not run.
  const sendFromCarriedSubset = source.disclosedPayloadColumns !== undefined;
  const sendDeclared =
    sendFromCarriedSubset || (terms.payload?.send ?? []).length > 0;
  const receiveDeclared = terms.payload?.receive !== undefined;
  const send =
    source.disclosedPayloadColumns ??
    (terms.payload?.send ?? []).map((column) => column.name);
  const receive = (terms.payload?.receive ?? []).map((column) => column.name);
  if (sendDeclared || receiveDeclared) {
    summary.payload = {
      send: send.map((name) => redactAndSanitizeForDisplay(name)),
      sendDeclared,
      sendFromCarriedSubset,
      receive: receive.map((name) => redactAndSanitizeForDisplay(name)),
      receiveDeclared,
    };
  }

  if (source.expires !== undefined)
    summary.expires = redactAndSanitizeForDisplay(source.expires);

  if (connectionPath !== undefined) summary.connectionPath = connectionPath;

  return summary;
}
