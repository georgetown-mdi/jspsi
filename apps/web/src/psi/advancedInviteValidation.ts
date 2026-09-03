import {
  APPLIED_SETTINGS,
  CanonicalEncodingError,
  FAN_OUT_FUNCTION_NAMES,
  INVITATION_LIFETIME_SECONDS,
  MAX_INVITATION_LIFETIME_SECONDS,
  UsageError,
  assertDeduplicateImplemented,
  canonicalString,
  countOnlyShapeViolation,
  countOnlyTransmitsColumn,
  decideLinkageTermsVerdict,
  disclosedColumnNames,
  safeParseLinkageTerms,
  summarizeLinkageShortfall,
  swapPairTransformsDiffer,
} from "@psilink/core";

import {
  buildAdvancedTerms,
  importedCitationDropCause,
} from "./advancedInviteTerms";
import {
  declarableFieldNames,
  draftFromTerms,
  keyIsSupplyable,
} from "./advancedInviteDraft";
import {
  isStepValid,
  pipelineHasInertCoalesce,
} from "./standardizationAuthoring";
import { SEMANTIC_TYPE_LABELS } from "./metadataEditing";
import { outputForDirection } from "./advancedInviteTypes";

import type {
  CSVRow,
  CountOnlyShapeViolation,
  LinkageTerms,
  LinkageTermsVerdict,
} from "@psilink/core";

import type { ImportedCitationDropCause } from "./advancedInviteTerms";

import type {
  AdvancedField,
  AdvancedInviteDraft,
  AdvancedInviteSeed,
  AdvancedValidation,
} from "./advancedInviteTypes";

/**
 * The Generate gate, the import-refusal messages, and the two notices that refuse
 * nothing. {@link validateAdvancedInvite} runs a draft's built terms
 * through the core schema (the single validation source
 * for everything it covers) and adds only the gates the schema does not express;
 * {@link gatedActiveSettingMessage} and {@link importedConstraintDivergenceMessage}
 * refuse an import that carries a gated setting or a constraint the editor cannot
 * represent; {@link importedCitationDropNotice} tells the operator when the rebuilt
 * document loses the rule-set citation the imported one carried, and
 * {@link inertCoalesceNotice} when a declared default value will not be
 * substituted where it sits -- each a consequence to state rather than an
 * obstacle to clear. No React, no I/O.
 */

/** Today's date as YYYY-MM-DD, for the legal-agreement expiry check. Matches the
 * slice `validateCompatibility` uses for the same comparison at exchange time
 * (`new Date().toISOString().slice(0, 10)`), and the editor compares it the same
 * way (strictly before today is expired), so the editor refuses exactly the
 * expired dates the exchange would. */
function todayIso(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Shown when generation is blocked because an enabled linkage key references a
 * field the inviter's columns cannot supply, or no key is supplyable at all --
 * distinct from {@link messageForField}'s "Enable at least one linkage key." so an
 * operator can tell "a key needs a field your columns cannot supply" apart from
 * "you turned every key off." Deliberately names no specific field: the offending
 * element's `field` reference can be partner-controlled (it rides an imported
 * document), so echoing it here would surface partner text into the UI -- the same
 * reason {@link messageForField} and core's referential-integrity refine locate the
 * offender by issue path rather than by value. The operator identifies the key from
 * its red "not satisfiable" badge in the key list instead. */
const UNSUPPLYABLE_KEY_MESSAGE =
  "A linkage key needs a field your columns cannot supply. Add a column of that " +
  "type, or turn that key off.";

/** Whether a step list declares a function core classes as fan-out -- one that
 * expands a value into several match candidates. Read from core's
 * `FAN_OUT_FUNCTION_NAMES` rather than a second web-side list, so a producer
 * added there is gated here with no second edit. */
function declaresFanOut(
  steps: ReadonlyArray<{ function: string }> | undefined,
): boolean {
  return (steps ?? []).some((step) =>
    FAN_OUT_FUNCTION_NAMES.includes(step.function),
  );
}

/** Shown when a cleaning step or a linkage-key transform splits one value into
 * several match candidates. This editor authors no fan-out -- its add-step menu
 * offers none (`OFFERED_EXPERT_FUNCTION_GROUPS`), so one can only arrive on an
 * imported document -- and it is deliberately blocked at the moment of choice
 * rather than left to mint an invitation the editor cannot show the operator the
 * consequences of authoring. The gate is this editor's, wider than core's own
 * refusal, which admits a fan-out under single-pass; the message therefore points
 * at the surface that does author one rather than calling the capability unbuilt.
 * Names that capability and not the offending step: the step's function name can
 * arrive on an imported document, which is partner-influenceable, the same reason
 * {@link UNSUPPLYABLE_KEY_MESSAGE} names no field. */
const FAN_OUT_MESSAGE_BODY =
  "splits one value into several values to match on, which this editor does " +
  "not author. Remove that step before generating; an exchange that matches " +
  "on several values per record is authored from the command line, and runs " +
  "under single-pass linkage only.";

/** Shown when the value the built terms cannot canonically encode sits in an
 * enabled key element's transform -- the one such value this editor authors, since
 * the element editor offers `substring` and `pad_left` and writes their numeric
 * params into the draft beside the inline error rather than withholding them.
 *
 * The terms schema does not catch it: a transform param value is `z.unknown()`
 * there, so an integer past the safe range parses cleanly and only the encoder
 * refuses it. A non-finite one does raise a schema issue, but on the `linkageKeys`
 * path, which the generic mapping collapses to "Enable at least one linkage key."
 * on a draft whose keys are all enabled -- so this message has to be set ahead of
 * that mapping to be the one the operator reads.
 *
 * Names neither the key nor the parameter: an imported key's names are
 * partner-influenceable, the same reason {@link UNSUPPLYABLE_KEY_MESSAGE} names no
 * field, and the element editor marks the offending input where the operator fixes
 * it. */
const UNENCODABLE_KEY_TRANSFORM_MESSAGE =
  "A linkage key's transform carries a parameter that cannot be recorded in the " +
  "exact form both parties agree on, such as a number too large to store " +
  "precisely. Open that key and correct that transform's parameters, or remove " +
  "the step.";

/** Shown when a key's two swapped elements carry different cleaning steps.
 *
 * A swap has only the receiver read the pair in the other order, and each
 * element's steps stay on its own position, so a pair whose steps differ cleans a
 * column one way on the party that swaps and another on the party that does not.
 * The terms schema refuses it -- on the `linkageKeys` path, which the generic
 * mapping collapses to "Enable at least one linkage key." on a draft whose keys
 * are all enabled, so this message has to be set ahead of that mapping to be the
 * one the operator reads.
 *
 * Names neither the key nor the fields, for the reason
 * {@link UNSUPPLYABLE_KEY_MESSAGE} names none: an imported key's names are
 * partner-influenceable. Both remedies are the operator's to choose between --
 * matching the steps keeps the either-order matching, dropping the swap keeps the
 * differing steps. */
const SWAP_TRANSFORM_MISMATCH_MESSAGE =
  "A linkage key matches two of its fields in either order, but gives them " +
  "different cleaning steps. Open that key and give both fields the same steps, " +
  "or turn off matching them in either order.";

/** Shown when the built terms cannot be canonically encoded and the offending
 * value is not in any enabled key's transform -- the residual the editor's own
 * controls and the import path have no way to author, since every other term is a
 * string, a boolean, or an enum the schema types, and a linkage field's constraints
 * carry only strings, booleans, and string lists.
 *
 * Deliberately not "reset to defaults": the fault is one value, and discarding the
 * operator's whole authored draft is not a remedy for it. */
const UNENCODABLE_TERMS_MESSAGE =
  "These terms carry a value that cannot be recorded in the exact form both " +
  "parties agree on. Import them again from a corrected document, or rebuild the " +
  "key list from your columns.";

/** The control each count-only shape rule reports against. Every rule but the
 * payload one is a property of the matching arrangement the key list holds, which
 * is also where the fan-out and satisfiability messages land. */
const COUNT_ONLY_FIELDS: Record<CountOnlyShapeViolation, AdvancedField> = {
  linkageKeys: "keys",
  linkageStrategy: "keys",
  deduplicate: "keys",
  payload: "payload",
};

/** The way out every count-only message offers besides fixing the setting it
 * names: the other Matching method, quoted as the control labels it. */
const REVEAL_IDENTIFIERS_INSTEAD =
  'set Matching method to "Reveal the matched identifiers (standard)".';

/** What a count-only document outside the specified shape tells the operator to
 * change, in this editor's own words rather than core's refusal text -- the same
 * split {@link messageForField} keeps for a schema failure, whose Zod message is
 * technical. The rules themselves are core's ({@link countOnlyShapeViolation}), so
 * only the wording lives here, and each message names the control that carries
 * the setting it asks about. */
const COUNT_ONLY_MESSAGES: Record<CountOnlyShapeViolation, string> = {
  linkageKeys:
    "A count-only exchange matches on a single linkage key. Turn off all but " +
    `one key, or ${REVEAL_IDENTIFIERS_INSTEAD}`,
  linkageStrategy:
    "A count-only exchange runs one key at a time. Set Linkage strategy to " +
    `Cascade, or ${REVEAL_IDENTIFIERS_INSTEAD}`,
  deduplicate:
    "A count-only exchange reports how many records match and hands neither " +
    "party a record-by-record result, so several of your records cannot match " +
    'one partner record. Clear "Allow several of your records to match one ' +
    `partner record", or ${REVEAL_IDENTIFIERS_INSTEAD}`,
  payload:
    "A count-only exchange moves no data columns in either direction. Set " +
    `those columns so they are not sent, or ${REVEAL_IDENTIFIERS_INSTEAD}`,
};

/** Shown when the draft asks for a deduplicating match under a linkage strategy
 * that cannot run one. Core refuses that pair on both parties before matching
 * begins ({@link assertDeduplicateImplemented}), so an invitation minted on it is
 * one both sides abort on rather than one the partner can accept. Names the two
 * ways out in the words the controls carrying them are labelled, keeping the same
 * split the count-only messages do: the rule is core's, the wording this
 * editor's. It names no strategy, because which one cannot run a deduplicating
 * match is core's verdict rather than this message's -- every strategy this build
 * offers can. */
const DEDUPLICATE_STRATEGY_MESSAGE =
  "The linkage strategy this invitation names cannot run a deduplicating " +
  'match. Choose another Linkage strategy, or clear "Allow several of your ' +
  'records to match one partner record".';

/** Whether `value` survives the canonical encoding the cross-party agreement is
 * hashed in. Asked of a whole terms document and of one element transform at a
 * time, so the message the editor shows locates the fault by the encoder's own
 * answer rather than by parsing the error it threw. A rejection that is not a
 * {@link CanonicalEncodingError} is re-thrown: the encoder converts every
 * traversal failure to one (a throwing getter included), so anything else is a
 * broken contract rather than an un-encodable value. */
function isCanonicallyEncodable(value: unknown): boolean {
  try {
    canonicalString(value);
    return true;
  } catch (err) {
    if (err instanceof CanonicalEncodingError) return false;
    throw err;
  }
}

/**
 * What to do about a linkage shortfall, chosen by which shortfall holds -- the
 * split the acceptor's launch gate keeps (`acceptorLaunchBlockedReason`), and for
 * the same reason: a key the columns cannot produce is cleared at the column
 * mapping, while a key whose declared cleaning drops every record has columns that
 * already resolve, so pointing at the mapping would name a control that cannot
 * clear it. An unsatisfiable key takes precedence where both hold, as it does
 * there, since it is the shortfall the operator's own columns settle.
 *
 * The dead case points at the badge rather than the key, for the reason
 * {@link UNSUPPLYABLE_KEY_MESSAGE} names no field: an imported document's key names
 * are partner-influenceable, and the key list carries the badge beside this
 * message.
 */
function shortfallRemedy(verdict: LinkageTermsVerdict): string {
  if (verdict.unsatisfiableKeys.length > 0)
    return (
      "Turn off the keys your columns cannot produce, or map a column to " +
      "every field they need."
    );
  return 'Review the cleaning on the keys badged "won\'t match", or turn them off.';
}

/**
 * Validate a draft for the Generate gate. The core schema
 * ({@link safeParseLinkageTerms}) is the single source for everything it covers
 * (identity/legal-text presence, the date format, referential integrity); this
 * adds only the gates the schema does not express: the invitation-lifetime
 * bounds (not part of the terms), a not-yet-passed legal-agreement expiry (the
 * schema checks format, not that the date is still current -- the exchange
 * rejects an already-passed date later, so refuse it up front), at least one
 * column-satisfiable linkage key, a canonical-encode dry run (the byte form both
 * parties hash; refuse a value that cannot encode rather than fail cross-party,
 * naming the transform it sits in where it sits in one), and the two pairings the
 * schema admits and the run refuses (a declared fan-out step, and a deduplicating
 * term under a linkage strategy that matches one value per record).
 *
 * Schema errors are mapped back to the offending control by their issue path --
 * the editor re-derives the control because the referential-integrity refines
 * report at the array path by design, echoing no value.
 */
export function validateAdvancedInvite(
  draft: AdvancedInviteDraft,
  seed: AdvancedInviteSeed,
  now: Date = new Date(),
): AdvancedValidation {
  const terms = buildAdvancedTerms(draft);
  const errors: Partial<Record<AdvancedField, string>> = {};

  // Lifetime is a generateInvitation parameter, not part of the terms, so it is
  // not covered by the schema. Mirror generateInvitation's own bounds.
  if (
    !Number.isFinite(draft.lifetimeSeconds) ||
    draft.lifetimeSeconds <= 0 ||
    draft.lifetimeSeconds > MAX_INVITATION_LIFETIME_SECONDS
  ) {
    errors.lifetime =
      "Choose an invitation duration between 1 second and one year.";
  }

  // A key is supplyable when the inviter's columns can declare every field it
  // references; one that is not dangles the built terms (the referential-integrity
  // refine rejects the undeclared field) and blocks generation. The two checks below
  // set the accurate keys message up front so it wins over the generic
  // schema-failure mapping, which collapses every linkageKeys-path issue to
  // "Enable at least one linkage key."
  const declarable = declarableFieldNames(
    draft.metadata,
    draft.standardization,
  );
  const enabledKeys = draft.keys.filter((entry) => entry.enabled);
  // At least one key must be active. The schema's linkageKeys .min(1) also
  // catches the none-enabled case, but a dedicated message reads better against
  // the key list.
  if (enabledKeys.length === 0) {
    // No key is active. Enabling one fixes it ONLY if a supplyable key exists --
    // checked across ALL keys, enabled or not, since the question is whether
    // enabling one COULD help. When none is supplyable (a fully-unsupplyable
    // import, every key referencing a field the columns cannot supply), "turn one
    // on" would mislead, so name the real obstacle instead, preserving the
    // fail-closed refusal.
    const someKeyIsSupplyable = draft.keys.some((entry) =>
      keyIsSupplyable(entry.key, declarable),
    );
    errors.keys = someKeyIsSupplyable
      ? "Enable at least one linkage key."
      : UNSUPPLYABLE_KEY_MESSAGE;
  } else if (
    enabledKeys.some((entry) => !keyIsSupplyable(entry.key, declarable))
  ) {
    // An enabled key references a field the columns cannot supply: the built terms
    // dangle, so block with the accurate message rather than the misleading no-keys
    // one the schema-failure mapping would otherwise produce.
    errors.keys = UNSUPPLYABLE_KEY_MESSAGE;
  }

  // Canonical-encode dry run: the terms are hashed into the cross-party agreement
  // in this byte form, and a value outside the reproducible domain throws here
  // rather than desyncing two parties. Run up front so this message wins over the
  // schema mapping and the linkage grading -- the schema mapping reports a
  // non-finite transform param as "Enable at least one linkage key." on a draft
  // whose keys are all enabled. The later shape gates (fan-out, deduplicate
  // strategy, count-only) still overwrite errors.keys unconditionally; that
  // changes only which message shows, never whether generation is refused.
  //
  // Where the offending value sits is asked of the encoder too, one transform at a
  // time, rather than read off the error: its message quotes the value and a path
  // that can carry a partner-chosen param name, neither of which is surfaceable.
  const encodable = isCanonicallyEncodable(terms);
  if (!encodable && errors.keys === undefined) {
    errors.keys = terms.linkageKeys.some((key) =>
      key.elements.some(
        (element) =>
          element.transform !== undefined &&
          !isCanonicallyEncodable(element.transform),
      ),
    )
      ? UNENCODABLE_KEY_TRANSFORM_MESSAGE
      : UNENCODABLE_TERMS_MESSAGE;
  }

  // A swap pair whose two elements carry different transforms, which the schema
  // refuses on the linkageKeys path -- so it needs its own message ahead of the
  // mapping for the same reason the checks above do. Placed after the encode dry
  // run because an un-encodable param makes a pair unmatchable here too, and that
  // fault has the more precise remedy of the two. The verdict is core's own
  // reading of the rule, so the editor and the schema cannot disagree about which
  // pairs are refused.
  if (
    errors.keys === undefined &&
    terms.linkageKeys.some(swapPairTransformsDiffer)
  )
    errors.keys = SWAP_TRANSFORM_MISMATCH_MESSAGE;

  // The "non-receiving-party-cannot-receive" rule, enforced live: sending payload
  // to a partner that receives no result is incoherent -- the partner has no matched
  // records to attach it to, and the acceptor's mirror (receive = this send, with
  // expectsOutput false) is exactly what the schema rejects at accept time
  // (deriveAcceptedLinkageTerms throws). Block it here so the inviter never mints an
  // invitation the partner cannot accept. The check reads the same disclosed set
  // buildAdvancedTerms derives the send from, so it fires precisely when the built
  // terms carry a payload.send the chosen direction makes unacceptable.
  if (
    !outputForDirection(draft.outputDirection).shareWithPartner &&
    disclosedColumnNames(draft.metadata).length > 0
  ) {
    errors.payload =
      "Some columns are set to be sent to your partner, but you chose that only " +
      "you receive the matched results. Your partner cannot receive payload for a " +
      "result it does not get. Either share the results with your partner, or set " +
      "those columns so they are not sent.";
  }

  const parsed = safeParseLinkageTerms(terms);
  if (!parsed.success) {
    // Each control touched by a schema issue gets its control-specific message
    // (the message is keyed on the control, not the individual issue, so the set of
    // affected controls is all that matters). Keep the first message per control:
    // the keys control deliberately sets its accurate message up front so it wins
    // over the generic schema mapping, and stacking several messages on one input
    // is noise. The payload control is the one exception -- a schema payload error
    // (e.g. an over-long sent column name) is a second, distinct obstacle from the
    // direction-conflict message that may already occupy it, so both are surfaced
    // rather than letting the direction conflict mask the schema problem and leave
    // the operator unaware of an obstacle that still blocks generation.
    const schemaFields = new Set(
      parsed.error.issues.map((issue) => fieldForIssuePath(issue.path)),
    );
    for (const field of schemaFields) {
      const existing = errors[field];
      if (existing === undefined) {
        errors[field] = messageForField(field);
      } else if (field === "payload") {
        // Lead with the schema/column error and trail the direction conflict: the
        // schema error is the obstacle that persists after the operator reverses
        // the one-click direction choice, so it earns first position. Joined with a
        // newline (not a space) so the editor renders the two problems as separate
        // lines rather than one run-on paragraph.
        errors.payload = `${messageForField("payload")}\n${existing}`;
      }
    }
  }

  // An already-passed expiry is not a schema rule (it checks only the date
  // format), so add it -- mirroring the exchange, which rejects an expirationDate
  // strictly before today (config/linkageTerms.ts). A same-day expiry is still
  // honored at the exchange, so accept it here too rather than refuse an
  // invitation the exchange would. Apply it only once the date is a well-formed
  // date the schema accepted, so a malformed date shows the format error rather
  // than this one.
  const expiration = draft.legalAgreement?.expirationDate.trim();
  if (
    expiration !== undefined &&
    errors.legalExpiration === undefined &&
    expiration < todayIso(now)
  ) {
    errors.legalExpiration = "The expiration date cannot be in the past.";
  }

  // The linkage grading: an exchange runs every key its terms declare, so Generate
  // is refused unless the file can produce all of them and none declares cleaning
  // that drops every record -- core's `decideLinkageTermsVerdict`, the same verdict
  // the mint re-checks and the run boundary enforces, so an invitation this editor
  // hands out is never one the inviter's own run refuses.
  if (enabledKeys.length > 0 && errors.keys === undefined) {
    // Grade against the draft's edited metadata AND its authored standardization,
    // the same binding the inviter's exchange uses (both are threaded into the
    // spec), so the verdict matches the run: a column remap that makes a key
    // offerable is judged satisfiable here exactly when the run can produce it, and
    // two same-typed fields each resolve to their own bound column rather than the
    // type's first-match fallback (which would bind both to one column and mis-judge
    // a key needing the second).
    const verdict = decideLinkageTermsVerdict(
      seed.columns,
      terms,
      draft.standardization,
      draft.metadata,
    );
    if (!verdict.fullySatisfied) {
      // The shortfall fragment is core's, the one the run-boundary refusal states,
      // so the editor cannot describe the fault in words of its own. It carries
      // counts only; the key names stay off this message. Taken on the draft
      // standing: these terms are the inviter's own, and Generate is the step that
      // would first put them in front of a partner.
      errors.keys =
        `These terms cannot be run against your file: ${summarizeLinkageShortfall(verdict, "draft")}. ` +
        shortfallRemedy(verdict);
    }
  }

  // Every authored cleaning step must be well-formed before Generate -- the same
  // launch gate the acceptor applies (acceptorLaunchBlockedReason's step-validity
  // clause). A step left mid-edit (a cleared substring.start) or a
  // malformed/over-length raw pattern would otherwise reach the exchange, where
  // core runs it as a silent full-field exclusion or throws at compile. Raw
  // patterns being ungated for per-party cleaning is what makes this gate
  // load-bearing rather than defensive. Gated in this tested boundary (not only
  // the component wrapper) so it cannot be bypassed.
  //
  // Scoped to draft.standardization deliberately: a linkage-key element transform
  // does NOT take this descriptor gate. The descriptors are the authoring
  // surface's own typing, stricter than what core runs, and an element transform
  // arrives by a second door -- an imported partner document, whose params the
  // operator cannot edit one by one. A descriptor-shaped refusal there would
  // hard-block a document core runs benignly: a `coalesce` whose `default` is not
  // text and a `null_if` whose value is not a string are each a pass-through at
  // runtime, costing no match. So on a key element the encoder is the gate, not
  // the descriptors.
  //
  // What that stance does not extend to is a param the pipeline drops on
  // value-INDEPENDENTLY, which is not a tolerated shape but a key that matches
  // nothing for BOTH parties -- and the mint is the last point either of them
  // holds a control over it, since the terms are hashed into the agreement and
  // the acceptor cannot edit them. Those are refused, in core rather than here:
  // `pipelineAlwaysDrops` grades such an element dead, so the linkage grading
  // above blocks Generate, the mint and the run boundary refuse the same terms,
  // and the key list carries its "won't match" badge -- one refusal covering the
  // authored draft and the imported document alike. Its measured instance is a
  // `substring` whose declared window reads nothing at any value length -- an
  // absent or zero bound, which the terms schema admits and the factory nulls
  // every row for. (A present non-integer bound never reaches this grading: that
  // shape the terms schema rejects at parse.) Every window core grades dead is
  // one these descriptors also reject, so
  // the element editor marks the offending param inline while the badge names
  // the key: held by tests rather than by this note --
  // advancedInviteValidation.test.ts for the grading and that agreement,
  // stepListEditor.test.ts for the inline mark, and invitation.test.ts /
  // prepareForExchange.test.ts for the mint and run boundaries.
  if (
    !draft.standardization.every((transformation) =>
      (transformation.steps ?? []).every(isStepValid),
    )
  ) {
    errors.standardization =
      "Finish or fix the highlighted cleaning steps before generating.";
  }

  // The fan-out gate, read from the same list core's own refusal
  // (`assertFanOutImplemented`) reads, and deliberately wider than it: core
  // admits a fan-out under single-pass, while this editor authors none at any
  // strategy. Both surfaces a fan-out can reach are checked: an authored cleaning
  // step, and a linkage-key element transform, which an imported document carries
  // (the step editor offers the family on neither). Written last and
  // unconditionally -- a fan-out step blocks generation whatever else the control
  // reports, and removing it is the only fix here, so it is the message worth
  // showing.
  if (
    draft.standardization.some((transformation) =>
      declaresFanOut(transformation.steps),
    )
  )
    errors.standardization = `A cleaning step ${FAN_OUT_MESSAGE_BODY}`;
  if (
    terms.linkageKeys.some((key) =>
      key.elements.some((element) => declaresFanOut(element.transform)),
    )
  )
    errors.keys = `A linkage key's transform ${FAN_OUT_MESSAGE_BODY}`;

  // The deduplicating-pair gate, run as core's own refusal rather than a second
  // web-side copy of the pair it names -- the same reading-from-core the fan-out
  // gate above does with core's list, so a pair added there is refused here with
  // no second edit. Core refuses it symmetrically from the agreed terms, so an
  // exchange configured on it aborts both parties at the run boundary; refusing
  // it at Generate puts the answer where the operator still holds both controls.
  // Written over whatever else the key list reports, since generation stays
  // blocked until one of the two settings moves. The count-only gate below writes
  // over it in turn for a `psi-c` draft, whose own shape rules own these settings
  // and whose remedies stay valid for that algorithm.
  try {
    assertDeduplicateImplemented(terms);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    errors.keys = DEDUPLICATE_STRATEGY_MESSAGE;
  }

  // The count-only shape gate, at the same altitude as the fan-out one above and
  // read from core's own rules rather than a second web-side list, so this editor
  // refuses exactly the documents core refuses at parse and at accept. Written
  // last for the same reason: a count-only document outside the shape blocks
  // generation whatever else a control reports, and bringing it into the shape
  // (or choosing the identifier-revealing algorithm) is the only fix.
  const countOnlyViolation = countOnlyShapeViolation(terms);
  if (countOnlyViolation !== undefined)
    errors[COUNT_ONLY_FIELDS[countOnlyViolation]] =
      COUNT_ONLY_MESSAGES[countOnlyViolation];
  // The metadata rule takes the payload control from the terms rule where both
  // hold, which on this path is whenever either does: `buildAdvancedTerms`
  // authors `payload.send` from the marked columns, so the declaration and the
  // transmission are the same fact, and the marks are the half the operator
  // clears.
  if (countOnlyTransmitsColumn(terms.algorithm, draft.metadata))
    errors.payload =
      "A count-only exchange sends no data columns to your partner, but some " +
      "columns are set to be sent. Set those columns so they are not sent, or " +
      REVEAL_IDENTIFIERS_INSTEAD;

  const canGenerate =
    parsed.success && encodable && Object.keys(errors).length === 0;
  return {
    canGenerate,
    terms: canGenerate ? terms : undefined,
    errors,
  };
}

/** Map a Zod issue path to the editor control it belongs to. The schema's
 * referential-integrity refines report at the array path (`["linkageKeys"]`),
 * which collapses to the key list here. */
function fieldForIssuePath(path: ReadonlyArray<PropertyKey>): AdvancedField {
  const head = path[0];
  if (head === "identity") return "identity";
  if (head === "legalAgreement") {
    const sub = path[1];
    if (sub === "reference") return "legalReference";
    if (sub === "purpose") return "legalPurpose";
    if (sub === "expirationDate") return "legalExpiration";
  }
  // A payload-column schema failure (e.g. a sent column whose name exceeds the
  // length bound) surfaces against the payload control, not the key list.
  if (head === "payload") return "payload";
  // The schema's deduplicate-requires-output refine reports here, against the
  // output pair rather than the setting that makes it incoherent. It belongs to
  // the result-direction control, not the key list, which is where the fallback
  // below would put it -- under a message about enabling a linkage key.
  if (head === "output") return "output";
  // linkageKeys, linkageFields, and anything else the editor can influence
  // surface against the key list (the only structural control it offers).
  return "keys";
}

/** A clear, control-specific message for a schema failure on that control. The
 * raw Zod message is not echoed: it is technical, and the offending value is
 * never partner-safe to surface here. */
function messageForField(field: AdvancedField): string {
  switch (field) {
    case "identity":
      return "Enter a name to identify yourself.";
    case "legalReference":
      return "Enter the agreement reference.";
    case "legalPurpose":
      return "Enter the purpose of the disclosure.";
    case "legalExpiration":
      return "Enter a valid date (YYYY-MM-DD).";
    case "lifetime":
      return "Choose an invitation duration between 1 second and one year.";
    case "output":
      // The one rule that reports against the output pair: a party that receives
      // no matched results has nothing to deduplicate its own records onto. Both
      // halves settle it, so both are named, the result-direction control first:
      // the issue path points at that pair, and it is the half the operator did
      // not choose deliberately when they turned deduplication on.
      return (
        "Deduplicating your own records needs you to receive the matched " +
        'results. Under "Who receives the matched results", choose an option ' +
        'that includes you, or clear "Allow several of your records to match ' +
        'one partner record".'
      );
    case "payload":
      // The common payload error (sending while only you receive) is set with its
      // own message in validateAdvancedInvite; this covers a schema failure on a
      // sent column (e.g. an over-long column name from the CSV).
      return "One or more columns you are sending cannot be used; adjust which columns are sent.";
    case "keys":
      return "Enable at least one linkage key.";
    case "standardization":
      // Set directly in validateAdvancedInvite (not via a schema-path mapping); this
      // keeps the switch exhaustive over AdvancedField.
      return "Finish or fix the highlighted cleaning steps before generating.";
  }
}

/** A message naming any setting an imported terms set turns on that the run does
 * not yet honor (gated by {@link APPLIED_SETTINGS}), or `undefined` when none. The
 * editor refuses such an import rather than load a draft whose headline behavior
 * silently does not happen -- the same gate the disabled GUI controls and the
 * {@link buildAdvancedTerms} clamp enforce, applied at the one door (import) that
 * could otherwise carry a gated setting in from outside. Without it the disabled
 * control would be the operator's only way to clear a setting an import turned
 * on. */
export function gatedActiveSettingMessage(
  terms: LinkageTerms,
): string | undefined {
  const blocked: Array<string> = [];
  if (terms.deduplicate && !APPLIED_SETTINGS.deduplicate)
    blocked.push("duplicate matches");
  if (
    !APPLIED_SETTINGS.fuzzyComparisons &&
    terms.linkageKeys.some((key) =>
      key.elements.some((el) => el.generateFuzzyComparisons !== undefined),
    )
  )
    blocked.push("fuzzy comparisons");
  if (blocked.length === 0) return undefined;
  return (
    `These terms turn on ${blocked.join(", ")}, which this version of the ` +
    "exchange does not yet apply. Remove those settings and import again."
  );
}

/**
 * A message refusing an import whose linkage fields carry constraints the editor
 * cannot represent, or `undefined` when none does -- the constraints counterpart of
 * {@link gatedActiveSettingMessage}, applied at the same door. The draft holds no
 * per-field constraint state ({@link AdvancedInviteDraft} has none) and
 * `authoredLinkageFields` re-stamps each rebuilt field with its semantic
 * type's DEFAULT-template constraints, so an imported field's own `constraints` -- a
 * non-default `exclude` denylist, `validOnly`, `allowedCharacters`, or
 * `affixesAllowed` -- would be silently normalized away on rebuild. Constraints are
 * warn-not-enforce (they govern the data-quality warning surface, not which records
 * match -- see core's `checkValueConstraints`), but they ARE hashed into the
 * cross-party agreement, so a silent normalization re-generates a DIFFERENT
 * agreement than the imported document declared, with no signal to the operator.
 *
 * Refuse, not preserve: the editor has no surface to view or edit per-field
 * constraints, so preserving them would carry hash- and warning-relevant state the
 * operator can neither see nor change -- a worse footgun than refusing. Fail-closed
 * at the one door (import) that can introduce a constraint the authoring UI never
 * produces.
 *
 * Rather than enumerate the constraint shapes, it asks the precise question -- would
 * the rebuild change any field's declaration? -- by reconstructing exactly what an
 * import would generate ({@link draftFromTerms} then {@link buildAdvancedTerms}) and
 * comparing each GENERATED field against the imported field of the same name in the
 * canonical form the agreement hashes (`canonicalString`). Name and type are
 * reproduced verbatim, so a surviving field whose canonical form differs differs
 * only in its constraints: exactly the silent-divergence case. This also catches the
 * inverse -- an import that STRIPS a default the rebuild adds back. An import
 * carrying only type-default constraints rebuilds to identical canonical fields and
 * is accepted unchanged -- so the guided and expert paths, which never author custom
 * constraints, always pass.
 *
 * The message names no field value: an imported document is partner-influenceable,
 * the same reason {@link UNSUPPLYABLE_KEY_MESSAGE} and core's schema refines locate
 * an offender by path, not value.
 *
 * Scope -- it owns the one divergence direction the faithful round-trip does NOT close:
 * a SURVIVING field (one a key references and the columns can bind) whose custom
 * constraint the rebuild re-stamps to the type default, the genuine silent-normalization
 * case. It need not own the others, because {@link buildAdvancedTerms} preserves the
 * imported field declaration on rebuild: (1) it does NOT falsely refuse the
 * disable-and-show case -- a field a key references but the inviter's columns cannot
 * supply is dropped rather than generated, so it is not compared and a legitimate
 * partial import is not refused; (2) a declared field NO key references is preserved
 * verbatim on rebuild, so it is compared and MATCHES rather than diverging -- an inert
 * field's custom constraint is carried, not refused (it is never standardized,
 * constraint-checked, or matched, so carrying it moves nothing but the agreement hash,
 * which faithful preservation keeps equal); and (3) field ORDER and a benign empty
 * `constraints: {}` (on a type whose default is absent) are likewise preserved, so
 * neither diverges here, and the empty `{}` no longer over-refuses. So this guard stays
 * scoped to the constraints a generated field actually runs, while the rest of the
 * round-trip fidelity is preserved upstream.
 */
export function importedConstraintDivergenceMessage(
  terms: LinkageTerms,
  seed: AdvancedInviteSeed,
  rawRows: ReadonlyArray<CSVRow> = [],
  dateInputFormat?: string,
): string | undefined {
  const rebuilt = buildAdvancedTerms(
    draftFromTerms(
      terms,
      seed,
      INVITATION_LIFETIME_SECONDS,
      rawRows,
      dateInputFormat,
    ),
  );
  const importedByName = new Map(
    terms.linkageFields.map((field) => [field.name, field]),
  );
  for (const generated of rebuilt.linkageFields) {
    const imported = importedByName.get(generated.name);
    // The comparison is scoped to name-matched pairs: a generated field the import
    // did not name takes its declaration from the editor rather than the document,
    // so there is nothing imported for it to diverge from -- skip it.
    if (imported === undefined) continue;
    if (canonicalString(generated) !== canonicalString(imported))
      return (
        "These terms set custom constraints on one or more linkage fields that " +
        "this editor cannot represent. Importing them would silently change the " +
        "agreement the parties commit to (and the data-quality warnings shown), so " +
        "they are refused. Edit the document to use the default field constraints, " +
        "or use it directly without the editor."
      );
  }
  return undefined;
}

/** What every dropped citation costs, in the words the consent surface uses for
 * the same fact (`CONSENT_FACTS.linkageRuleSet.note`): the citation is a claim
 * ABOUT the keys and fields, which travel either way, so losing it moves the
 * document the two parties compare without moving what they match on. */
const CITATION_DROP_CONSEQUENCE =
  "The keys and fields themselves are unchanged, and they are what the exchange " +
  "holds both parties to; only the citation goes, so the terms you create will " +
  "not match the document you imported exactly.";

/**
 * What each {@link ImportedCitationDropCause} tells the operator: that the rule-set
 * citation is left out of what the editor emits, why, and -- where an edit here
 * reaches the cause -- how to get it back.
 *
 * None of them names the set. An imported citation's names and versions are
 * partner-controlled free text, and a document carries exactly one citation, so a
 * name identifies nothing here that the sentence does not: the same reason
 * {@link UNSUPPLYABLE_KEY_MESSAGE} and core's schema refines locate an offender by
 * path rather than by value. The consent surface, which must show the operator the
 * partner's own words, is where those names render -- each escaped and bound in its
 * own chrome-free box (`InvitationTerms`), which prose cannot do.
 */
const CITATION_DROP_NOTICES: Record<ImportedCitationDropCause, string> = {
  "shipped-set-unmet":
    "The document you imported cites a rule set this application ships, but the " +
    "keys and fields it declares are not that set's, so the citation cannot be " +
    "verified and is left out of the terms you create. " +
    `${CITATION_DROP_CONSEQUENCE} No edit here restores the citation.`,
  "no-keys":
    "A rule-set citation says which set the linkage keys came from, and these " +
    "terms enable none, so the citation your imported document made is left out " +
    "of the terms you create. Turn a linkage key back on to carry it.",
  "rules-not-drawn":
    "The keys and fields these terms declare are no longer drawn from the rule " +
    "set your imported document cites, so that citation is left out of the terms " +
    `you create. ${CITATION_DROP_CONSEQUENCE} Undo the key edits to carry the ` +
    "citation, or create the invitation without it.",
};

/** The `no-keys` drop when NO key can be enabled: an import whose keys none of the
 * inviter's columns can supply lands with every one disabled, so the generic
 * "turn a key back on" remedy would only trade this notice for the blocking
 * unsupplyable-key error. It names the real obstacle and folds into that error's
 * guidance ({@link UNSUPPLYABLE_KEY_MESSAGE}) rather than pointing at a control
 * that cannot help. Named no field, for the reason {@link CITATION_DROP_NOTICES}
 * names no set. */
const CITATION_DROP_NO_SUPPLYABLE_KEY =
  "A rule-set citation says which set the linkage keys came from, but none of the " +
  "linkage keys your imported document declares can be supplied by your file's " +
  "columns, so the citation it made is left out of the terms you create. Add a " +
  "column of the type a linkage key needs to carry it.";

/**
 * The notice for an imported rule-set citation the rebuilt document will not carry,
 * or `undefined` when it carries it (and for a draft that imported nothing, or
 * imported a document that cited nothing -- neither has a citation to lose).
 *
 * It blocks nothing: dropping the citation is the correct behavior in all three
 * cases -- re-emitting it would claim a provenance the rules do not have -- so the
 * operator is told what the outgoing document will say, not stopped from creating
 * it. That is why this is not one of {@link validateAdvancedInvite}'s errors, whose
 * every member holds the Generate gate shut.
 */
export function importedCitationDropNotice(
  draft: AdvancedInviteDraft,
  builtTerms?: Pick<LinkageTerms, "linkageFields" | "linkageKeys">,
): string | undefined {
  const cause = importedCitationDropCause(draft, builtTerms);
  if (cause === undefined) return undefined;
  // Split the `no-keys` cause on supplyability, which citationDropCause cannot see
  // (it reads the terms, not the draft's columns): when no key can be enabled at
  // all, "turn a key back on" is misdirection, so name the real obstacle instead.
  if (cause === "no-keys" && !draftHasSupplyableKey(draft))
    return CITATION_DROP_NO_SUPPLYABLE_KEY;
  return CITATION_DROP_NOTICES[cause];
}

/**
 * The fields whose declared cleaning or linkage-key transform carries a
 * `coalesce` that substitutes nothing where it sits, named by their safe
 * semantic-type label and de-duplicated in first-seen order.
 *
 * Both surfaces a coalesce can reach are read, because the two arrive by
 * different doors: the per-party cleaning the operator authors here, and a
 * linkage-key element transform, authored in the key editor or carried by an
 * imported document.
 *
 * Labels, never names: an imported document's field names are
 * partner-influenceable, the same reason {@link UNSUPPLYABLE_KEY_MESSAGE} names
 * no field. A transformation or element whose field the built terms do not
 * declare contributes nothing: an unreferenced field is not part of the
 * exchange, so its steps cannot cost a match.
 */
function inertCoalesceFieldLabels(
  draft: AdvancedInviteDraft,
  terms: Pick<LinkageTerms, "linkageFields" | "linkageKeys">,
): Array<string> {
  const labels = new Set<string>();
  const labelByDeclaredName = new Map(
    terms.linkageFields.map((field) => [
      field.name,
      Object.hasOwn(SEMANTIC_TYPE_LABELS, field.type)
        ? SEMANTIC_TYPE_LABELS[field.type]
        : undefined,
    ]),
  );
  for (const transformation of draft.standardization) {
    const label = labelByDeclaredName.get(transformation.output);
    if (
      label !== undefined &&
      pipelineHasInertCoalesce(transformation.steps ?? [])
    )
      labels.add(label);
  }
  for (const key of terms.linkageKeys)
    for (const element of key.elements) {
      const label = labelByDeclaredName.get(element.field);
      if (
        label !== undefined &&
        pipelineHasInertCoalesce(element.transform ?? [])
      )
        labels.add(label);
    }
  return [...labels];
}

/**
 * The notice for a declared default value the run will not substitute, or
 * `undefined` when every declared one substitutes where it sits.
 *
 * The failure it names is silent under-matching: the author declares a default
 * expecting blank-ish records to participate, and at runtime the step is a
 * pass-through, so those records quietly do not match. The verdict is core's own
 * position-aware, name-only one (see `pipelineHasInertCoalesce`, over
 * `coalesceSubstitutesConstant`): a preceding step is counted by what its
 * function NAME can do, not its params, so a params-degenerate shape (a
 * `null_if` with no exclusion list) counts as emptying and leaves its coalesce
 * unadvised even though the run never substitutes. Adding an emptying-capable
 * rule ahead of the step, moving the step after one, or declaring a text
 * default clears it.
 *
 * It speaks for several fields at once, so it names BOTH conditions rather than
 * whichever one a given step fails -- the same choice core's consent-side
 * description of a non-substituting coalesce makes, and for the same reason: one
 * sentence then covers every shape. The step editor, which has a row to attach
 * advice to, names the failing one instead (`INERT_COALESCE_ADVICE`).
 *
 * It blocks nothing: a terms document carrying this shape is valid, mints, and
 * runs, with the step as a pass-through, so the operator is told what their terms
 * will do rather than stopped from creating them. That is why this is not one of
 * {@link validateAdvancedInvite}'s errors, whose every member holds the Generate
 * gate shut -- the same reason {@link importedCitationDropNotice} is not.
 */
export function inertCoalesceNotice(
  draft: AdvancedInviteDraft,
  builtTerms?: Pick<LinkageTerms, "linkageFields" | "linkageKeys">,
): string | undefined {
  const labels = inertCoalesceFieldLabels(
    draft,
    builtTerms ?? buildAdvancedTerms(draft),
  );
  if (labels.length === 0) return undefined;
  return (
    `A default value declared for ${labels.join(", ")} is never substituted ` +
    "where it sits: a value is replaced only where an earlier rule in the same " +
    "pipeline left it empty, and only by a text default. A record with no value " +
    "for the column never reaches those steps at all. Records pass through them " +
    "unchanged, so they add no matches. Move each step after a rule that can " +
    "drop a value, give it a text default, or remove it."
  );
}

/** Whether any of the draft's keys -- enabled or not -- references only fields the
 * inviter's columns can supply, the same test {@link validateAdvancedInvite} uses
 * to decide whether enabling a key could help. */
function draftHasSupplyableKey(draft: AdvancedInviteDraft): boolean {
  const declarable = declarableFieldNames(
    draft.metadata,
    draft.standardization,
  );
  return draft.keys.some((entry) => keyIsSupplyable(entry.key, declarable));
}
