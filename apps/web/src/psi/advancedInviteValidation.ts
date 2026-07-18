import {
  CanonicalEncodingError,
  INVITATION_LIFETIME_SECONDS,
  MAX_INVITATION_LIFETIME_SECONDS,
  assessLinkageSatisfiability,
  canonicalString,
  disclosedColumnNames,
  safeParseLinkageTerms,
} from "@psilink/core";

import {
  declarableFieldNames,
  draftFromTerms,
  keyIsSupplyable,
} from "./advancedInviteDraft";
import { APPLIED_SETTINGS } from "./appliedSettings";
import { buildAdvancedTerms } from "./advancedInviteTerms";
import { isStepValid } from "./standardizationAuthoring";
import { outputForDirection } from "./advancedInviteTypes";

import type { CSVRow, LinkageTerms } from "@psilink/core";

import type {
  AdvancedField,
  AdvancedInviteDraft,
  AdvancedInviteSeed,
  AdvancedValidation,
} from "./advancedInviteTypes";

/**
 * The Generate gate and the import-refusal messages. {@link validateAdvancedInvite}
 * runs a draft's built terms through the core schema (the single validation source
 * for everything it covers) and adds only the gates the schema does not express;
 * {@link gatedActiveSettingMessage} and {@link importedConstraintDivergenceMessage}
 * refuse an import that carries a gated setting or a constraint the editor cannot
 * represent. No React, no I/O.
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

/**
 * Validate a draft for the Generate gate. The core schema
 * ({@link safeParseLinkageTerms}) is the single source for everything it covers
 * (identity/legal-text presence, the date format, referential integrity); this
 * adds only the gates the schema does not express: the invitation-lifetime
 * bounds (not part of the terms), a not-yet-passed legal-agreement expiry (the
 * schema checks format, not that the date is still current -- the exchange
 * rejects an already-passed date later, so refuse it up front), at least one
 * column-satisfiable linkage key, and a
 * canonical-encode dry run (the byte form both parties hash; refuse a value that
 * cannot encode rather than fail cross-party).
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

  // Satisfiability is over column shape, not the schema: a key all of whose
  // fields the columns can produce is satisfiable. Block when none can (the
  // exchange would emit no key strings and yield a silent empty result), the same
  // gate generateInvitation and the acceptor pre-flight apply.
  if (enabledKeys.length > 0 && errors.keys === undefined) {
    // Assess against the draft's edited metadata AND its authored standardization,
    // the same binding the inviter's exchange uses (both are threaded into the
    // spec), so the verdict matches the run: a column remap that makes a key
    // offerable is judged satisfiable here exactly when the run can produce it, and
    // two same-typed fields each resolve to their own bound column rather than the
    // type's first-match fallback (which would bind both to one column and mis-judge
    // a key needing the second).
    const { satisfiableKeyCount } = assessLinkageSatisfiability(
      seed.columns,
      terms,
      draft.standardization,
      draft.metadata,
    );
    if (satisfiableKeyCount === 0) {
      errors.keys =
        "None of the enabled keys can be satisfied by your file's columns.";
    }
  }

  // Canonical-encode dry run: the terms are hashed into the cross-party agreement
  // in this byte form, and a value outside the reproducible domain throws here
  // rather than desyncing two parties. The editor authors no transform params (the
  // only partner-reachable un-encodable value), so this is defense-in-depth.
  let encodable = true;
  try {
    canonicalString(terms);
  } catch (err) {
    if (err instanceof CanonicalEncodingError) {
      encodable = false;
      if (errors.keys === undefined)
        errors.keys = "These terms cannot be encoded; reset to defaults.";
    } else {
      throw err;
    }
  }

  // Every authored cleaning step must be well-formed before Generate -- the same
  // launch gate the acceptor applies (acceptorLaunchDisabled's step-validity
  // clause). A step left
  // mid-edit (a cleared substring.start) or a malformed/over-length raw pattern would
  // otherwise reach the exchange, where core runs it as a silent full-field exclusion
  // or throws at compile. Now that raw patterns are ungated for per-party cleaning,
  // this gate is load-bearing rather than defensive. Gated in this tested boundary (not
  // only the component wrapper) so it cannot be bypassed.
  if (
    !draft.standardization.every((transformation) =>
      (transformation.steps ?? []).every(isStepValid),
    )
  ) {
    errors.standardization =
      "Finish or fix the highlighted cleaning steps before generating.";
  }

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
 * could otherwise carry a gated setting in from outside. */
export function gatedActiveSettingMessage(
  terms: LinkageTerms,
): string | undefined {
  const blocked: Array<string> = [];
  if (terms.algorithm === "psi-c" && !APPLIED_SETTINGS.psiC)
    blocked.push("count-only matching (psi-c)");
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
    // A generated field the import did not name cannot occur for a name-matched
    // rebuild; were it to, its declaration is the editor's, not the document's, so
    // there is nothing imported for it to diverge from -- skip it.
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
