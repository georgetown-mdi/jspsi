import { APPLIED_SETTINGS } from "./appliedSettings.js";
import {
  coalesceSubstitutesConstant,
  CONSENT_VERDICT_PARAM_NAMES,
  dateFormatComponents,
  DEFAULT_DATE_OUTPUT_FORMAT,
  describeTransformCoercions,
  FAN_OUT_FUNCTION_NAMES,
  parseDateInputDropsEveryRecord,
  pipelineAlwaysDrops,
  substringCollapsesParsedDateToConstant,
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
 * Human-readable label for each linkage-field semantic type. `type` is a
 * fixed enum the schema validates, not partner free text, so these labels are
 * safe to render verbatim; the field's own `name` is partner free text and
 * stays unshown here.
 *
 * Typed {@link Displayable} because a label shares display fields with the
 * sanitized fallback for an unresolved field (see {@link summarizeKey});
 * fixed copy enters through `displayText`, the compiler-policed way in for a
 * literal this file authors.
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
 * Plain-language description of what each transform function does to
 * matching, keyed by the function's raw `snake_case` name (the value core's
 * cleaning library dispatches on). The acceptor sees this alongside the
 * function name and its parameters, not just the name alone. A partner name
 * core does not recognize has no entry here and falls back to the bare
 * sanitized name.
 *
 * Exported so the coverage test can assert its key set equals core's
 * {@link STANDARDIZATION_FUNCTION_NAMES} in both directions: a core function
 * with no entry here, and a stale entry for a function core dropped.
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
    "Substitutes a fallback value where an earlier rule left the value empty, " +
    "which can create matches that would not otherwise occur.",
};

/**
 * The description a `coalesce` step earns where it cannot substitute anything
 * (core's {@link coalesceSubstitutesConstant} is false for it): a declared
 * `default` that is not text, a position no emptying rule precedes, or both.
 * Names both conditions rather than only the one that failed, so one line
 * covers every non-substituting shape.
 */
const COALESCE_WITHOUT_SUBSTITUTION_DESCRIPTION =
  "Declares a fallback value but substitutes nothing here: a value is replaced " +
  "only where an earlier rule left it empty, and only by a text default. " +
  "Records pass through this step unchanged.";

/** Legal-agreement context, with the partner-controlled free text sanitized. */
export interface InvitationLegalAgreementSummary {
  /** Agreement identifier (e.g. "MOU-2025-0042"), sanitized for display. */
  reference: Displayable;
  /** Stated purpose of the disclosure, sanitized for display. */
  purpose: Displayable;
  /**
   * ISO 8601 date (YYYY-MM-DD) after which the exchange is refused, sanitized
   * for display like the free-text fields: the `z.iso` schema rejects anything
   * that could hold a deceptive character today, but the boundary does not
   * depend on that validation staying in place.
   */
  expirationDate: Displayable;
}

/**
 * One half of the rule-set citation the inviter declares -- the field set or
 * the key set -- with both strings sanitized for display.
 *
 * The name and version are the inviter's own declaration about its rules: a
 * surface presents them as the inviting party's citation, not a
 * psilink-vouched provenance, since the token is accepted on a transcription
 * checksum rather than an authenticity guarantee.
 *
 * {@link verdict} is not the inviter's claim -- it is this build's own check
 * of that half, resolved only against the rule sets this build ships. A name
 * it cannot resolve reports `unchecked`.
 */
interface InvitationRuleSetIdentitySummary {
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
interface InvitationPayloadSummary {
  /** Columns the inviter will send for matched records (what the acceptor
   * receives), in the inviter's namespace, each sanitized for display. Empty
   * when the declared set is empty; read {@link sendDeclared} to tell that
   * apart from the lazy case. */
  send: Array<Displayable>;
  /**
   * Whether the send set is a definite DECLARATION -- the carried disclosed
   * subset (possibly empty), or an authored `payload.send` -- rather than the
   * lazy case (the inviter sends whatever its own metadata discloses, nothing
   * declared up front). When true and {@link send} is empty, the acceptor is
   * committed to "receive nothing" (a later non-empty payload aborts), so the
   * renderer states that explicitly ("(none)") instead of omitting the line;
   * when false, the send side is lazy and stays unshown. The narrower
   * {@link sendFromCarriedSubset} says whether an acceptance can hold the
   * inviter to this declaration.
   */
  sendDeclared: boolean;
  /**
   * Whether {@link send} is the disclosed subset the invitation CARRIED -- the
   * inviter's own transmission predicate run over its own metadata -- rather
   * than the authored `payload.send` fallback used when no subset was
   * carried. Strictly narrower than {@link sendDeclared}: a carried subset is
   * always a declaration, but an authored send is a declaration with no
   * subset behind it.
   *
   * Enforcement turns on this narrower condition: an acceptance commits to
   * the CARRIED subset as what it will receive and reconciles the received
   * payload against it. Where none was carried, there is no set to
   * reconcile against, so an online run accepts whatever the inviter
   * transmits. A surface classifying the received-columns fact reads this
   * flag, not {@link sendDeclared}.
   */
  sendFromCarriedSubset: boolean;
  /** Columns the inviter requests from the acceptor for matched records (what
   * the acceptor sends), each sanitized for display. Empty when the
   * declared set is empty; read {@link receiveDeclared} to tell that apart
   * from the lazy case. */
  receive: Array<Displayable>;
  /**
   * Whether the receive set is a definite DECLARATION (an authored
   * `payload.receive`, present even when empty) rather than the lazy case (no
   * `receive` authored: the inviter takes whatever the acceptor's metadata
   * discloses). When true and {@link receive} is empty, the inviter asserts
   * "the acceptor sends nothing" (a later non-empty payload aborts), so the
   * renderer states that explicitly ("(none)") instead of omitting the line;
   * when false, the receive side is lazy and stays unshown. Mirrors
   * {@link sendDeclared} for the opposite direction.
   */
  receiveDeclared: boolean;
}

/**
 * A single transform step applied to an element's value before hashing,
 * reduced to display form: the function name and a bounded, sanitized view of
 * its parameters -- which determine what the function does, and so what
 * matches.
 */
interface InvitationTransformSummary {
  /** Sanitized name of the transform function. */
  function: Displayable;
  /**
   * One sanitized `key: value` string per declared parameter -- the ones a
   * consent verdict reads first, then the rest in declaration order
   * ({@link orderedParamEntries}) -- capped at {@link MAX_DISPLAYED_PARAMS}
   * (a trailing "... N more" entry marks overflow). The cap keeps an
   * arbitrarily large partner-supplied `params` record from flooding the
   * screen, and the leading order keeps it off the rows a header marker
   * rests on. Empty when the step declares no parameters. A parameter core
   * coerces before applying is shown verbatim here; the executed value is
   * named separately in {@link coercions}.
   */
  params: Array<Displayable>;
  /**
   * Plain-language description of what this function does to matching, from
   * {@link TRANSFORM_FUNCTION_GLOSSARY}. Fixed copy keyed by the recognized
   * function name, safe to render verbatim; absent when the declared name is
   * one core does not recognize. A `coalesce` that substitutes nothing where
   * it sits takes {@link COALESCE_WITHOUT_SUBSTITUTION_DESCRIPTION} instead,
   * since the glossary line would assert a substitution that never runs.
   */
  description?: string;
  /**
   * Literal, parameter-derived phrase for a recognized parameterized function
   * (currently `substring` on a name field): "the first 3 characters". Leads
   * the element's detail in place of the function name when present, and
   * suppresses {@link description} so the slice is not stated twice. Absent
   * for a date or other reformatted field, a negative/non-integer slice, or a
   * function with no literal -- the renderer then leads with
   * {@link description} instead. Fixed copy holding partner-supplied slice
   * positions, composed through `displayText`, which admits a number but no
   * partner string.
   */
  effect?: Displayable;
  /**
   * Parameters this function coerces before applying, each naming the
   * parameter and the value it actually runs as (e.g. `replacement` runs as
   * the empty string for `replace_regex` `replacement: null`). Held apart
   * from {@link params} and rendered as its own element, not folded into the
   * param line, so partner text placed inside a param value cannot
   * impersonate this note. Both fields are core-derived, not
   * partner-controlled. Restricted to parameters whose {@link params} line is
   * shown, so a note never references one the display cap hid. Absent when
   * the step coerces no displayed parameter.
   */
  coercions?: Array<{ param: string; runsAs: string }>;
}

/**
 * One element of a linkage key, reduced to what determines whether records
 * match on it: the field it derives from and any non-default matching rule it
 * carries (a value transform or a fuzzy-comparison expansion).
 */
interface InvitationKeyElementSummary {
  /**
   * Human-readable label for the field this element derives from: the fixed
   * label for its semantic type, or the sanitized raw field name when the
   * reference does not resolve.
   */
  fieldLabel: Displayable;
  /**
   * Transform steps applied to the value before hashing, in order; empty when
   * the value is matched as-is. Each holds the sanitized function name and a
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
   * across a reorder. The raw (unsanitized) key name: schema-validated
   * `LinkageTerms` guarantees it unique across `linkageKeys`, unlike
   * {@link name}, whose sanitization/truncation can collapse two distinct raw
   * names to the same displayed string. Never rendered, so not sanitized.
   * That it stays off both acceptance surfaces is enforced by a check, not a
   * comment: the web browser suite and the CLI suite each mount their consent
   * surface on terms whose every partner-controlled string holds a hostile
   * code point, and each fails on any output text outside printable ASCII.
   */
  id: string;
  /** The key's name, sanitized for display. */
  name: Displayable;
  /** Ordered elements combined to form the key. */
  elements: Array<InvitationKeyElementSummary>;
  /** True when the key declares a swap (two elements matched in either
   * order). */
  hasSwap: boolean;
  /**
   * The two swapped elements' field labels, present only when both swap
   * references resolve to elements with *distinct* labels (the common case,
   * e.g. ["Last name", "First name"]). Absent when an identifier names no
   * element or the two would share a label: an unresolved swap identifier
   * never enters this tuple, raw or sanitized -- the renderer falls back to
   * a generic swap note keyed off {@link hasSwap} instead. Holds the same
   * resolved labels as {@link InvitationKeyElementSummary.fieldLabel}, so
   * like those it falls back to a sanitized raw field name when a field
   * reference does not resolve.
   */
  swap?: [Displayable, Displayable];
  /**
   * True when the two swapped elements (resolved in {@link swap}) BOTH hold a
   * transform. On the receiver a swap moves each element's field reference to
   * the other element while its transforms stay put (core's `swapElements`),
   * so each element's transforms apply to the OTHER element's field value.
   * When both sides hold transforms, the generic "matched in either order"
   * note understates this interchange, so the renderer states it
   * bidirectionally; implies {@link swap} is present. Mutually exclusive with
   * {@link swapTransformDonor}: false unless both elements hold a transform
   * and the labels resolved distinctly.
   */
  swapTransformInterchange: boolean;
  /**
   * `[donor, recipient]` field labels when EXACTLY ONE swapped element holds
   * a transform, else undefined. The receiver applies the donor's transforms
   * to the recipient's field value (core's `swapElements`), so the
   * recipient's header slot shows the donor's breadth marker (see
   * {@link headerFields}); the renderer states this cross-application in the
   * detail so the re-attributed marker is anchored. Mutually exclusive with
   * {@link swapTransformInterchange} (the both-transform case); implies
   * {@link swap} is present, using the same resolved labels, never the raw
   * swap-reference identifier.
   */
  swapTransformDonor?: [Displayable, Displayable];
  /**
   * The always-visible one-liner of the fields this key matches on: one entry
   * per element, each a COMPACT semantic-type label plus a terse breadth
   * marker when its element loosens matching ("last name (partial)", "date
   * of birth (fuzzy)"). Deduped by the full entry (label + marker) so a
   * truncated and a whole-value element of the same field stay distinct.
   * Fixed compact label plus fixed marker; an unresolved field falls back to
   * its sanitized identifier, though the terms schema already refuses an
   * element naming an undeclared field, so no decoded token reaches that
   * fallback. An anchor a partner-controlled key {@link name} cannot
   * misrepresent; the swap "either order" note is held by {@link hasSwap}.
   *
   * A swap re-attributes markers to the receiver's terms: each swapped
   * element keeps its own rules but reads the OTHER element's field value on
   * the receiver (core's `swapElements`), so its breadth marker is shown on
   * its swapped PARTNER's field here, not the field it is declared on. The
   * cross-application the detail lists is anchored by
   * {@link swapTransformInterchange} / {@link swapTransformDonor}.
   */
  headerFields: Array<Displayable>;
}

/**
 * A linkage field, reduced to its display label and any declared
 * constraints. Constraints are data standards both parties commit to
 * (advisory -- the application warns rather than enforces), shown so the
 * acceptor sees every rule attached to the matched data.
 */
interface InvitationFieldSummary {
  /** Human-readable label for the field's semantic type. */
  label: string;
  /**
   * Plain-language descriptions of the declared constraints, if any. The
   * `exclude` denylist is summarized as a count rather than listing its
   * values: it is advisory and can hold hundreds of entries. The
   * partner-authored `allowedCharacters` class is NOT among these -- it is
   * held apart in {@link allowedCharacters} so the renderer can bind it in
   * its own bounded element rather than fold it into a joined phrase (see
   * that field's doc).
   */
  constraints: Array<string>;
  /**
   * The partner-authored `allowedCharacters` class the field declares,
   * sanitized for display, present only when the field declares one. Held
   * apart from {@link constraints} rather than folded into a joined
   * "allowed-character pattern: X" phrase, so the renderer can bind this
   * partner-controlled value in its own bounded element and a partner cannot
   * place separator text inside the class to impersonate the surrounding
   * label (the same pattern {@link InvitationTransformSummary.coercions}
   * uses). The value is accepted on a transcription checksum and never
   * vetted (the evaluating check is advisory, core's
   * `withinAllowedCharacters`); the renderer's fixed label marks it
   * partner-supplied and unverified.
   */
  allowedCharacters?: Displayable;
}

/**
 * A display-ready, injection-safe view of the inviter's linkage terms,
 * derived from a decoded {@link InvitationToken}. Every partner-controlled
 * value (the self-asserted identity, linkage-key names, legal-agreement
 * text, payload column names, and the schema-validated date fields) passes
 * through {@link redactAndSanitizeForDisplay} here, at the one boundary, so
 * neither acceptance surface -- the web consent screen nor the CLI accept
 * prompt -- re-derives the escaping. The redaction half also protects a log
 * line (`consentSurfaceSink` in `apps/cli/src/invitationDisplay.ts`): without
 * it, a marker planted in a key or column name could consume the consent
 * text composed after it on the same line. Neither renderer's own defenses
 * cover this: React's JSX escaping handles HTML metacharacters and a
 * terminal handles none, but neither strips the control, bidi, zero-width,
 * or homoglyph characters this neutralizes. The dates are routed through the
 * same boundary for a uniform contract, even though the `z.iso` schemas
 * already reject such characters in them.
 *
 * Every field a partner-controlled value can reach AND that is rendered is
 * typed {@link Displayable} rather than `string`, so filling one from an
 * un-sanitized value fails to compile. The guarantee runs one way only: the
 * brand rejects a plain `string` assigned into a field already declared
 * `Displayable`, but nothing forces a newly added field to be declared that
 * way. A runtime test covers that gap: it walks the whole returned value,
 * built from terms whose every partner-controlled string holds a hostile
 * code point, and fails on any string outside printable ASCII.
 *
 * Most fields left as `string` are ones no partner value reaches: fixed
 * copy keyed by a schema-validated enum, and the core-derived transform
 * notes. {@link InvitationKeySummary.id} is the exception -- it holds the
 * partner's raw key name verbatim, safe only because it is never rendered.
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
   * `single-pass`. single-pass is disclosure-affecting: to run in one
   * batched round the sender hands the receiver its full per-key value
   * structure, so the receiver observes matches on less precise keys the
   * cascade would have filtered out first. The renderer shows it as an
   * always-visible consent note; cascade, the baseline that discloses less,
   * is not flagged. A fixed schema enum, not partner free text, so it
   * renders verbatim like {@link algorithm}.
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
   * cardinality and every surface downstream of the association table shows
   * the multiplicity. False: the strategy this invitation names matches no
   * deduplicating cardinality, which acceptance refuses outright
   * (`assertDeduplicateImplemented`), so this flag never claims a
   * disclosure for a run that cannot happen.
   *
   * Read alongside {@link deduplicate}, like `fansOut` and `fanOutApplied`:
   * answers what the strategy would do with a deduplicating term, whether or
   * not these terms declare one. Not covered: the both-sided pair under a
   * strategy that pairs no `many-to-many`, a property of the agreed PAIR
   * unreadable from an invitation alone -- acceptance derives this party's
   * own `deduplicate` as false, so no accepted invitation resolves that pair
   * without the accepting party declaring it afterwards.
   */
  deduplicateApplied: boolean;
  /**
   * Whether any linkage key's element transforms split one value into
   * several match candidates -- the fan-out an element marker names, as
   * "multiple" where the strategy matches those candidates and "not
   * supported" where it refuses the exchange.
   *
   * Read from the AGREED terms alone, which is all an invitation holds: the
   * inviting party's own data standardization can fan out a field the terms
   * do not show. This is what the acceptor can be told, not the whole of
   * what the inviter may run.
   */
  fansOut: boolean;
  /**
   * Whether the exchange this invitation proposes matches on those
   * candidates.
   *
   * True exactly for `single-pass`, the one strategy fan-out matching is
   * specified for (docs/spec/PROTOCOL.md, Fan-out runs under single-pass
   * only); under any other, terms declaring a fan-out are refused before the
   * exchange runs. Meaningful only alongside {@link fansOut}, selecting
   * which of the two fan-out consent facts a surface renders.
   */
  fanOutApplied: boolean;
  /**
   * Linkage keys (records are matched on these), in the inviter's order, each
   * carrying its ordered elements and matching rules.
   */
  linkageKeys: Array<InvitationKeySummary>;
  /**
   * The unique fields the linkage keys match on, in compact-label form and
   * order of first appearance -- no breadth markers, no per-key grouping.
   * Always visible, above the default-collapsed matching detail, so an
   * acceptor sees WHICH data is matched on without expanding it. A field
   * reference that does not resolve to a declared type falls back to its
   * sanitized raw name.
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
  /** Present only when the inviter declared payload columns to send or
   * receive. */
  payload?: InvitationPayloadSummary;
  /**
   * The invitation's expiry instant (ISO 8601), if the token holds one,
   * sanitized for display on the same uniform-contract grounds as the
   * agreement dates.
   */
  expires?: Displayable;
  /**
   * Whether the invitation discloses that its exchange keeps every file it
   * writes -- retain mode, which leaves the rendezvous location a permanent
   * transcript rather than deleting each file once it has been read.
   *
   * True on either of two grounds, of which a renderer is told only the
   * outcome: the invitation DECLARES retain mode
   * (`inviterRetainsFiles: true`), or its connection endpoint holds the
   * split inbound/outbound directory pair, whose shape requires retain mode
   * of any connection built from it ({@link endpointRequiresRetainedFiles}).
   * An acceptor seeded from such an endpoint runs in retain mode whether or
   * not the token declared it, so gating the display on the declaration
   * alone would leave that acceptor consenting with nothing said.
   *
   * A one-way flag, not the inviter's setting mirrored: false means neither
   * ground holds (a token declaring `inviterRetainsFiles: false`, one
   * declaring nothing, or the inviter's own pre-mint preview). Named for the
   * disclosure rather than the mode, so a renderer cannot read false as
   * "your partner deletes the files" -- a claim `CONSENT_FACTS`'
   * `retainedFiles` entry records as one no surface may make. A surface
   * renders the retention fact on true and nothing on false, and needs no
   * sanitize call: the value is schema-validated, not partner free text.
   */
  disclosesRetainedFiles: boolean;
  /**
   * The partner's advisory shared-directory locator, sanitized for display:
   * the `path` a single-directory file-drop endpoint holds. Present only for
   * such an endpoint. Advisory only -- it never flows to any config, and it
   * is the folder's own name only where the inviting console could name the
   * folder, so a surface presenting it AS the shared folder's name
   * overstates what it is. Sanitized for TEXT display only: safe as a React
   * text child, and never to be interpolated into an attribute value or raw
   * HTML.
   */
  connectionPath?: Displayable;
}

/**
 * Plain-language descriptions of a field's declared constraints, in a stable
 * order. The `exclude` denylist is reported as a count, not its values: it
 * is advisory and may hold hundreds of entries.
 *
 * The partner-authored `allowedCharacters` class is NOT among these
 * phrases -- it is held apart in {@link allowedCharactersClass}, so the
 * renderer binds the raw partner value in its own bounded element rather
 * than folding it into a joined sentence a partner could impersonate.
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
 * The field's partner-authored `allowedCharacters` class, sanitized for
 * display, or undefined when the field declares none. Returned as the raw
 * class alone (no joined system label) so the renderer can bind it in its
 * own bounded element rather than concatenate label and value into one
 * string a partner could impersonate with separator text.
 *
 * The value is a partner-authored regex character class, accepted on a
 * transcription checksum and never vetted, so a crafted class can read
 * very differently to a human than the set it admits: a leading `^`
 * negates it, and a shorthand or bracket breakout (`\p{L}`, `[:alpha:]`,
 * `]|\w|[`) is opaque to a non-regex-literate operator. The renderer labels
 * it as the partner-supplied, unverified expression it is rather than
 * paraphrasing it as a vetted "limited to <class>" promise. The evaluating
 * check is advisory (core's `withinAllowedCharacters`); this is its
 * operator-facing complement.
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
 * Upper bound on the number of transform parameters shown per step. A real
 * function takes a handful; the cap (with an overflow marker) keeps an
 * arbitrarily large partner-supplied `params` record from flooding the
 * screen -- the schema bounds the entry count only well above any real
 * parameter list, and bounds no value's content.
 *
 * Applied AFTER the verdict-bearing params lead
 * ({@link orderedParamEntries}), so it can only ever drop a row no consent
 * verdict reads. Sized far above the widest of those leading sets, so a
 * step's whole verdict-bearing set is shown whatever else it declares.
 */
const MAX_DISPLAYED_PARAMS = 16;

/**
 * A step's declared params in the order they are displayed: the ones a
 * consent verdict reads ({@link CONSENT_VERDICT_PARAM_NAMES}) first, then
 * the rest in declaration order.
 *
 * Leading with the verdict-bearing params matters because the party that
 * authors the transform also authors what precedes them: if those rows sat
 * in plain declaration order, the same party that shapes a header's
 * understatement (see {@link elementBreadthMarker}) could push its own
 * compensating detail row -- a `parse_date`'s `outputFormat` above all --
 * past {@link MAX_DISPLAYED_PARAMS} into the overflow marker by declaring
 * enough entries ahead of it. Leading with the verdict-bearing rows fixes
 * that at the source.
 *
 * The lookup is guarded by `Object.hasOwn` rather than a bare index because
 * the function name is partner free text: an index signature would type a
 * name that only reaches `Object.prototype` (`constructor`, `toString`) as
 * a hit.
 */
function orderedParamEntries(step: TransformStep): Array<[string, unknown]> {
  const entries = Object.entries(step.params ?? {});
  const verdictBearing = new Set(
    Object.hasOwn(CONSENT_VERDICT_PARAM_NAMES, step.function)
      ? CONSENT_VERDICT_PARAM_NAMES[step.function]
      : [],
  );
  return [
    ...entries.filter(([name]) => verdictBearing.has(name)),
    ...entries.filter(([name]) => !verdictBearing.has(name)),
  ];
}

/**
 * Render a transform parameter value for display. Primitives become their
 * plain string form; anything structured is JSON-encoded (best effort). The
 * result is sanitized and length-bounded by the caller, so it need not be
 * safe on its own.
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
 * The literal slice phrase for a `substring` step on a name field, or
 * undefined when no faithful literal applies. `positionalSafe` gates both
 * the field kind and the pipeline position -- the caller passes true only
 * for a name field's FIRST step, so the slice runs on the unmodified field
 * value. A reformatted field (a date) has no verifiable literal, and a
 * substring after an earlier rewriting step (e.g. phonetic then substring)
 * would describe the intermediate value, not the field -- both fall back to
 * the glossary description instead of a misstating literal.
 *
 * The params are partner-controlled and typed `unknown`, narrowed to
 * integers before use; only a positive integer `start` yields a literal. A
 * negative `start` counts from the end, 0 is a no-op (core's schema rejects
 * it), and a non-integer is not a usable slice -- each falls back to
 * undefined. Core's `substring` is SQL SUBSTR: 1-indexed positive `start`.
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
 * Reduce one transform step to its display summary: the sanitized function
 * name and a bounded, sanitized `key: value` view of its parameters. Each
 * entry is sanitized and truncated as a whole (so a parameter key or value
 * cannot hold control, bidi, or homoglyph characters), and the entry count
 * is capped. `positionalSafe` lets a recognized `substring` lead with a
 * literal slice phrase (see {@link substringEffect}) on a name field.
 * `substitutesFallback` is core's verdict on whether a `coalesce`
 * substitutes where this step sits, which decides between its two
 * descriptions; false for every other function.
 */
function summarizeTransform(
  step: TransformStep,
  positionalSafe: boolean,
  substitutesFallback: boolean,
): InvitationTransformSummary {
  const entries = orderedParamEntries(step);
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
  // faithful (substring on a name field); the glossary description is the
  // fallback only when there is no literal. The lookup uses the RAW
  // function name with `Object.hasOwn`, not a bare index, since a Record
  // index signature would silently type an unmatched partner-controlled
  // name as `string`. A coalesce that substitutes nothing here takes
  // `COALESCE_WITHOUT_SUBSTITUTION_DESCRIPTION` instead of the glossary's,
  // so this row cannot assert a substitution the header's marker has
  // already declined to name.
  const effect = substringEffect(step, positionalSafe);
  if (effect !== undefined) summary.effect = effect;
  else if (step.function === "coalesce" && !substitutesFallback)
    summary.description = COALESCE_WITHOUT_SUBSTITUTION_DESCRIPTION;
  else if (Object.hasOwn(TRANSFORM_FUNCTION_GLOSSARY, step.function))
    summary.description = TRANSFORM_FUNCTION_GLOSSARY[step.function];
  // Report each runtime-coerced param as its own note rather than folding it
  // into the param line, so it cannot be impersonated by partner text in a
  // param value. Its content is wholly core-derived: the param name is the
  // function's own parameter and the executed value comes from core's
  // coercion contract. Restricted to params whose `key: value` line is
  // actually shown, so a note never references one collapsed into the
  // "... N more" overflow.
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

// Core's parseDateFactory default input format (standardization.ts): an
// absent format is the full MM/DD/YYYY layout, which holds every component,
// so an absent inputFormat drops nothing. The matching output default is
// DEFAULT_DATE_OUTPUT_FORMAT.
const DEFAULT_PARSE_DATE_INPUT = "MM/DD/YYYY";

/**
 * The breadth marker a `parse_date` step's output layout earns, or undefined
 * when it merely reformats between equivalent full layouts (routine
 * canonicalization, unflagged) or its INPUT format cannot supply a full date
 * (not a broadening; see below). Two magnitudes of date collapse:
 *
 * - "any date": the output layout holds NO date token at all, so every date
 *   collapses to one constant value -- the maximal match breadth (e.g. an
 *   `outputFormat` of "registered").
 * - "partial": the output keeps at least one date token but omits a
 *   component its input holds, so distinct dates collapse onto a coarser
 *   bucket (e.g. a year-only output matches every date within a year).
 *
 * A step read alone cannot see the other route to "any date": a `substring`
 * run following this one can read a window that holds only the format's own
 * characters, collapsing every date exactly as a tokenless output does.
 * That verdict is a property of the steps together, so
 * {@link elementBreadthMarker} takes it from core's
 * {@link substringCollapsesParsedDateToConstant} instead of this per-step
 * classification.
 *
 * A `parse_date` whose input format omits a component core requires drops
 * EVERY record, so the element matches nothing, not more, and earns no
 * marker here -- that is a narrowing the separate dead-key advisory reports
 * instead. This defers to core's `parseDateInputDropsEveryRecord` (which
 * also covers a non-string input format) rather than re-deriving the
 * required-component rule, so the marker cannot drift from the runtime.
 *
 * Classification is keyed on the OUTPUT's token set: a tokenless output is
 * "any date" whatever the input, since no input layout can un-collapse a
 * constant output. The params are partner-controlled and typed `unknown`,
 * narrowed to a string with a fallback to core's default layout when
 * absent. The returned word is one of the two fixed literals above, never
 * partner text, so the marker is injection-safe by construction.
 */
function parseDateBreadth(
  step: TransformStep,
): "any date" | "partial" | undefined {
  if (step.function !== "parse_date") return undefined;
  // A parse_date whose input format cannot assemble a full date produces no
  // value to classify (core drops every such record), so emit no marker
  // here; defer to core's check, which also covers a non-string input
  // format. This step-level guard additionally stops a dead parse_date that
  // a later `coalesce` RESCUES to a constant from mislabelling the element
  // a date collapse -- the correct marker there is the coalesce's
  // "fallback".
  if (parseDateInputDropsEveryRecord(step.params)) return undefined;
  const rawInput = step.params?.inputFormat;
  const rawOutput = step.params?.outputFormat;
  const input =
    typeof rawInput === "string" ? rawInput : DEFAULT_PARSE_DATE_INPUT;
  const output =
    typeof rawOutput === "string" ? rawOutput : DEFAULT_DATE_OUTPUT_FORMAT;
  // The output is classified in its OWN context: a `YY` in the output
  // format is an unsubstituted literal (the factory fills only
  // YYYY/MM/DD), so it collapses the year and holds no year component --
  // an output of "YY" is a total constant ("any date"), and "MM/DD/YY"
  // keeps month and day but drops the year.
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
 * Transform functions that derive a value the acceptor's own identifier need
 * not compose, so a later `substring` slicing that value is no longer a
 * truncation of the identifier and earns no "partial" (see
 * {@link elementBreadthMarker}, which classifies every function name core
 * admits against that axis, for the members here and the ones absent).
 * Membership is a policy decision about the consent marker, not core's
 * runtime behavior; the names are core's own schema-validated function
 * names, so the marker stays derived from the validated set rather than
 * partner free text.
 */
const LITERAL_CORRESPONDENCE_BREAKING_FUNCTIONS: ReadonlySet<string> = new Set([
  "phonetic",
  "replace_regex",
  "pad_left",
]);

/**
 * The terse informative marker for a key element's collapsed-header entry.
 * Returns a SINGLE, most-salient marker, not one per rule -- the header is
 * terse by design, so an element carrying more than one rule shows just the
 * first, while its complete rule set is carried on
 * {@link InvitationKeySummary.elements} for the per-key detail.
 *
 * A rule the exchange refuses outright is named as one ("not supported")
 * and outranks every marker below, since no matching of any breadth
 * happens under it. The fan-out family is that case under a strategy that
 * matches one value per record; under `single-pass`, which matches the
 * whole candidate set, the same element earns "multiple" instead --
 * `fanOutMatches` decides which.
 *
 * Undefined when the element matches exactly, only canonicalizes its value
 * (case, whitespace, accents, affixes, padding on its own, or a
 * `parse_date` that merely reformats between equivalent layouts), or its
 * pipeline matches NOTHING (a dead `parse_date` or a `substring` run whose
 * window falls outside every rendered layout, unless a later `coalesce`
 * rescues it) -- the latter is a narrowing-to-empty the dead-key advisory
 * reports separately, not a broadening.
 *
 * Where the direction is determinable from the terms, the marker names the
 * EFFECT:
 *
 * - "any date": a `parse_date` whose output layout holds no date token, or
 *   whose output a later `substring` run is measured to leave constant for
 *   every date ({@link substringCollapsesParsedDateToConstant}) -- the
 *   maximal collapse, checked first since it dominates any other rule the
 *   element also carries.
 * - "fallback": a `coalesce` that substitutes a constant on every record an
 *   earlier rule of the element emptied (core's
 *   {@link coalesceSubstitutesConstant}), the same collapse as "any date"
 *   bounded to the emptied records. Ranks above the coarsening markers
 *   below for the same reason.
 * - "partial": a truncating `substring` -- counts even after a routine
 *   normalizer, unlike the detail row's stricter first-step-only literal
 *   ({@link substringEffect}), but not after a step in
 *   {@link LITERAL_CORRESPONDENCE_BREAKING_FUNCTIONS} -- or a `parse_date`
 *   whose output keeps a date token but drops a component its input holds.
 * - "fuzzy" / "sound-alike": the fuzzy-comparison expansion, or `phonetic`.
 *
 * Where an arbitrary partner-authored pattern or value list -- or a fill
 * whose reach into the sliced value depends on each record rather than the
 * terms -- makes the direction indeterminate, the marker names the RULE:
 * "pattern replacement" (`replace_regex`) and "pattern extraction"
 * (`extract_regex`) rank above "padded slice" (a `substring` after a
 * `pad_left`, since padding alone is routine and earns no marker of its
 * own), which ranks above the two narrowing-only rules "pattern filter"
 * (`filter_regex`) and "excludes values" (`null_if`).
 *
 * The full ranking, widest first: (1) fan-out, (2) dead-pipeline
 * suppression, (3) the collapse markers ("any date" then "fallback"), (4)
 * the coarsening markers ("partial" truncation, "fuzzy", "sound-alike",
 * then a component-dropping `parse_date`'s "partial"), (5) the
 * directly-named rules in the order above.
 *
 * Two known, accepted limits. First: because "padded slice" ranks last, a
 * tier-3 or tier-4 marker can mask it -- e.g. `[pad_left, substring,
 * parse_date]` with a component-dropping output renders "partial" though a
 * window landing in the fill in fact collapses every short record onto one
 * constant. Neither masking shape is reachable from the built-in key sets
 * (only `substring` and `swap` appear there). Second: the date-collapse
 * measurement ({@link substringCollapsesParsedDateToConstant}) runs probe
 * dates through the steps between a `parse_date` and the end of a
 * substring run; it cannot see a value-DEPENDENT drop (a `filter_regex` or
 * `null_if` that passes the probes but drops a real record), so such an
 * element earns "any date" while some records it would have collapsed are
 * in fact dropped -- the same tradeoff {@link pipelineAlwaysDrops} makes,
 * to avoid flagging a legitimate pipeline as dead. The probe dates ship in
 * public source, so a dropped or unmeasurable probe resolves to the
 * collapse word, never the milder one; both halves are held by tests
 * driving the shipped pipeline, not by this note.
 */
function elementBreadthMarker(
  element: LinkageKeyElement,
  fanOutMatches: boolean,
): Displayable | undefined {
  const steps = element.transform ?? [];
  const functions = new Set(steps.map((s) => s.function));
  // Tier 1: fan-out outranks every marker below (see the function doc).
  if (declaresFanOut(element))
    return fanOutMatches ? displayText`multiple` : displayText`not supported`;
  // Tier 2: a pipeline that matches nothing earns no marker. Deferred to
  // core's pipelineAlwaysDrops, which accounts for a rescuing `coalesce`.
  if (pipelineAlwaysDrops(element.transform)) return undefined;
  // Tier 3a: "any date" -- checked before every other rule since it is the
  // maximal collapse. Every step index is offered to
  // substringCollapsesParsedDateToConstant because the predicate itself
  // decides which one ends a maximal substring run.
  const parseDateBreadths = steps.map(parseDateBreadth);
  if (
    parseDateBreadths.includes("any date") ||
    steps.some((_step, index) =>
      substringCollapsesParsedDateToConstant(steps, index),
    )
  )
    return displayText`any date`;
  // Tier 3b: "fallback" -- gated on core's position-aware predicate so the
  // marker fires exactly where the substitution runs.
  if (
    steps.some((step, index) =>
      coalesceSubstitutesConstant(step, steps.slice(0, index)),
    )
  )
    return displayText`fallback`;
  // Tier 4: the coarsening markers, in rank order.
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
  if (parseDateBreadths.includes("partial")) return displayText`partial`;
  // Tier 5: the directly-named rules. The two rewriting rules rank above
  // "padded slice" because a rewrite between the pad and the slice can
  // dissolve the padding.
  if (functions.has("replace_regex")) return displayText`pattern replacement`;
  if (functions.has("extract_regex")) return displayText`pattern extraction`;
  const slicesPaddedValue = steps.some(
    (step, index) =>
      step.function === "substring" &&
      steps.slice(0, index).some((prior) => prior.function === "pad_left"),
  );
  if (slicesPaddedValue) return displayText`padded slice`;
  // The two narrowing-only rules rank last: each substitutes nothing, so
  // "padded slice" stays exactly true beside them.
  if (functions.has("filter_regex")) return displayText`pattern filter`;
  if (functions.has("null_if")) return displayText`excludes values`;
  return undefined;
}

/**
 * Reduce one linkage key to its display summary, resolving each element's
 * field reference to a human-readable label and reporting every
 * non-default matching rule. `fieldByName` maps a field `name` to its
 * semantic type; an element or swap reference that does not resolve falls
 * back to the sanitized raw string. `fanOutMatches` is whether the agreed
 * strategy matches a record's whole candidate set, which decides both
 * fan-out markers below.
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
      // A character slice reads faithfully only where its position maps to
      // the value the acceptor sees -- a free-text name. A date or other
      // reformatted field is canonicalized by a standardization the token
      // does not hold, so a positional phrase there would be unverifiable;
      // summarizeTransform falls back to the glossary description for it.
      const positionalSafe = type === "first_name" || type === "last_name";
      const steps = element.transform ?? [];
      return {
        fieldLabel: labelForField(element.field),
        // The substring literal is faithful only on a name field's FIRST
        // step: a later step runs on a value an earlier one already rewrote
        // (e.g. phonetic then substring takes the first N of the
        // sound-alike code, not the name), so "the first N characters" of
        // the original would be wrong. A coalesce's description is
        // position-dependent for the same reason: what it does turns on
        // what the steps before it can leave for it.
        transforms: steps.map((step, stepIndex) =>
          summarizeTransform(
            step,
            positionalSafe && stepIndex === 0,
            coalesceSubstitutesConstant(step, steps.slice(0, stepIndex)),
          ),
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
  // Header-marker re-attribution across a swap: maps each swapped element
  // to the breadth marker its header entry should show INSTEAD of its own
  // (an explicit `undefined` blanks the marker). Empty for a non-swap, a
  // same-label swap, or a pair holding a refused rule (see below), so the
  // header loop falls back to each element's own marker. Built here because
  // the swap resolution below supplies the element pairing it needs.
  const headerMarkerOverride = new Map<
    LinkageKeyElement,
    Displayable | undefined
  >();
  if (key.swap !== undefined) {
    // A swap names two elements by their effective identifier (element
    // `name` if present, otherwise `field`); resolve each to its element so
    // the note reads in the same field-label terms as the element list and
    // can see whether each holds a transform. The schema enforces that
    // `name ?? field` is unique within a key, so this Map never drops an
    // element. The note names the two fields only when both references
    // resolve to elements with distinct labels; otherwise `swap` stays
    // undefined and the renderer shows a generic note (see the `swap`
    // field doc).
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
        // On the receiver each swapped element keeps ALL its own rules but
        // reads the OTHER element's field value (core's `swapElements`
        // rewrites only the field reference), so every breadth marker an
        // element earns describes what happens to its PARTNER's field, and
        // the header shows it on the partner's slot. Re-attribute
        // uniformly: each element's header entry shows its partner's
        // marker -- exact for every configuration, since the whole element
        // moves. The one exception is a refused rule: "not supported" names
        // a step the operator must find and remove, and that step sits in
        // the element that DECLARES it, whichever field it reads on a
        // receiver. A refused key has no run to describe, so a refused
        // fan-out anywhere in the pair leaves both markers on their
        // declaring elements rather than pointing at a field holding no
        // such step.
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
        // The expanded detail lists each element's transforms under its
        // DECLARED field, so a re-attributed header marker needs the detail
        // to also state the cross-application. Flag it for the renderer: a
        // bidirectional interchange when both swapped elements hold
        // transforms, else a one-directional donor -> recipient note when
        // exactly one does (`swapTransformDonor` names the donor first).
        // Keyed on transforms, not on fuzzy comparisons: a not-yet-applied
        // fuzzy expansion carries its own "(proposed)" caveat in the detail
        // and needs no separate note here.
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

  // The always-visible field one-liner: a compact label per element with a
  // terse breadth marker, deduped by the full entry so a truncated element
  // does not collapse onto a whole-value one of the same field. A swap
  // re-attributes each marker to its partner's field (see
  // headerMarkerOverride above); a non-swapped element shows its own marker.
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
 * Build a display-ready {@link InvitationSummary} from an invitation's
 * linkage terms, optional expiry, and optional carried disclosed-columns
 * subset. The parameter is a structural subset of {@link InvitationToken}
 * (`linkageTerms`, `expires`, `disclosedPayloadColumns`,
 * `connectionEndpoint`, `inviterRetainsFiles`), so a full decoded token is
 * accepted as-is, and so is the terms/expiry pair the exchange screen holds
 * without a token. The "columns your partner will send" line derives from
 * the carried `disclosedPayloadColumns` when present (the wire's own
 * disclosure predicate), falling back to the authored `payload.send`
 * otherwise; the retained-files line derives from the declaration or the
 * endpoint's split-directory shape (see
 * {@link InvitationSummary.disclosesRetainedFiles}). Pure and
 * side-effect-free: it sanitizes every partner-controlled string, so it is
 * the single tested boundary for that escaping.
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

  // A single-directory file-drop endpoint's advisory path is
  // partner-controlled free text, so it is sanitized here like every other
  // displayed partner string; the split inbound/outbound pair and
  // non-filedrop endpoints hold no single locator.
  const endpoint = source.connectionEndpoint;
  const connectionPath =
    endpoint?.channel === "filedrop" && endpoint.path !== undefined
      ? redactAndSanitizeForDisplay(endpoint.path)
      : undefined;

  const fieldByName = new Map(
    terms.linkageFields.map((field) => [field.name, field.type]),
  );

  // Collapse fields that are identical for display -- same semantic-type
  // label, same constraint phrases, and same allowed-character class -- so
  // several fields of one type (e.g. a maiden and a current name both typed
  // `first_name`) do not list the same line twice with nothing to tell them
  // apart (the field `name` that would distinguish them is partner-controlled
  // and stays unshown). Fields whose constraints or allowed-character class
  // differ stay distinct. The dedupe key is the JSON encoding of the
  // (label, constraints, allowedCharacters) triple: a plain join would not
  // be injective, since a constraint phrase or the regex class can itself
  // hold the separator. Built from the already-sanitized display strings,
  // so two fields whose `allowedCharacters` differ only in characters
  // sanitizeForDisplay folds together collapse too -- correctly, since they
  // render identically.
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

  // The unique fields the keys match on, compact and deduped in order of
  // first appearance, for the always-visible consent line above the
  // collapsed matching detail. Derived from the keys' elements (the fields
  // actually matched on), not the declared field list, through the same
  // compact-label/sanitize path the per-key sublines use; markers and
  // per-key grouping stay in the disclosure.
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

  // The consent screen reflects the inviter's terms as proposed, not only
  // what today's exchange executes: the per-element generateFuzzyComparisons
  // is shown even though the run does not yet apply the expansion. The
  // *Applied flags below report that gap to the renderer; the displayed
  // terms are what the acceptor agrees to.
  // Which of the two fan-out registers this invitation is in: the strategy
  // that matches a candidate set, or one that refuses the terms outright.
  // Read once here so the element markers, the key summaries, and the
  // consent fact a surface shows all follow the same verdict.
  const fanOutMatches = terms.linkageStrategy === "single-pass";
  // Whether the strategy this invitation names matches the deduplicating
  // cardinality its term asks for; a strategy that does not is refused at
  // acceptance rather than run. Read from the refusal's OWN predicate
  // rather than restated here, so the copy cannot stay withheld for a
  // strategy the refusal has stopped refusing, and read once so both
  // surfaces withhold it on the same verdict.
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
    // Narrowed to the one value a surface may state, over both grounds that
    // put an acceptor's run in retain mode: the inviter's declaration, and
    // an endpoint whose split-directory shape the acceptor's own connection
    // is seeded from -- read through the same predicate that seeding uses,
    // so a second shape test cannot drift from it. The declaration is
    // three-valued (declared retain, declared delete, nothing declared),
    // and only the first is a fact about the run an acceptor consents to,
    // so the other two collapse here rather than at each renderer.
    disclosesRetainedFiles:
      source.inviterRetainsFiles === true ||
      endpointRequiresRetainedFiles(endpoint),
  };

  if (terms.linkageRuleSet !== undefined) {
    // The verdict runs over the SAME terms the names are read from, so
    // each half's marker and its name cannot come apart on the surface
    // that renders them.
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
  // disclosedPayloadColumns -- the inviter's own isDisclosedToPartner
  // predicate output, exactly the set preparePayload transmits -- so the
  // displayed and consented set cannot drift from the bytes that flow.
  // Falls back to the authored payload.send names for an invitation that
  // carried no disclosed subset (an older or metadata-unknown mint) and for
  // the inviter's own pre-mint "proposing" preview, which has authored its
  // send but holds no token field yet. `receive` (what the inviter requests
  // FROM the acceptor) has no transmission predicate to derive from and
  // stays the authored list.
  //
  // sendDeclared, sendFromCarriedSubset, and receiveDeclared are documented
  // on InvitationPayloadSummary; the section below renders whenever the
  // send OR the receive is declared.
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
