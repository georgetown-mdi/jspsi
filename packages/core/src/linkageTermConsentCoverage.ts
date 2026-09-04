// The consent-surface representation check's shared half: which `LinkageTerms`
// fields an acceptor's consent turns on, and the per-field variants that decide
// whether a surface represents each one at all.
//
// It lives in core, behind the `./testing` subpath, because the expensive half --
// judging which fields consent turns on -- is identical for the web consent
// summary and the CLI consent prompt. Two copies of that judgment would drift,
// which is the failure this check exists to remove.
//
// The classification below is a table rather than the enumeration itself: the
// field paths it is keyed by are DERIVED from the `LinkageTerms` declaration with
// the compiler API (test/linkageTermConsentCoverage.test.ts), and the two are
// asserted to agree in both directions. A hand-kept list cannot notice a field
// added to core; a derivation cannot judge whether a field bears on consent. Each
// half covers what the other cannot.

import { parseLinkageTerms } from "./config/linkageTerms.js";
import {
  CONSENT_FACTS,
  DEDUPLICATE_ACCEPTOR_SIDE_NOTE,
  DEDUPLICATE_SHARED_RESULT_DISCLOSURE_STATEMENT,
  DEDUPLICATE_SOLE_RECEIVER_DISCLOSURE_STATEMENT,
} from "./consentFacts.js";

import type {
  LinkageField,
  LinkageTerms,
  TransformStep,
} from "./config/linkageTerms.js";

/**
 * @internal
 *
 * The two surfaces an acceptor consents from: the web app's structured
 * invitation summary and the CLI accept command's prompt output.
 */
type ConsentSurfaceName = "web" | "cli";

/**
 * @internal
 *
 * A `LinkageTerms` field an acceptor's consent turns on -- one that decides what
 * is matched or what is disclosed -- and so belongs on both consent surfaces.
 */
export interface ConsentRelevantTerm {
  classification: "consent-relevant";
  /** What about the acceptor's decision this field decides. */
  reason: string;
  /**
   * Adjustment applied to {@link CONSENT_PROBE_TERMS} before {@link vary}, for a
   * field whose variation would otherwise break a cross-field schema constraint
   * (`output.expectsOutput: false` requires an empty `payload.receive`). It is
   * applied to BOTH sides of the pair, so the pair still differs at this field
   * alone.
   */
  prepare?: (terms: LinkageTerms) => LinkageTerms;
  /**
   * A terms document differing from its base at this field and nowhere else.
   * Both sides are rendered and the renderings compared, so a surface that omits
   * the field produces identical output and is reported as not representing it.
   * A variation a surface collapses (an `exclude` denylist the web reports only
   * the SIZE of) has to move what the surface actually shows, or it measures the
   * rendering rather than the representation.
   */
  vary: (terms: LinkageTerms) => LinkageTerms;
  /**
   * Fixed copy every surface MUST render for the variant document and MUST NOT
   * render for the base -- for a field whose variant turns on a DISCLOSURE the
   * acceptor is entitled to read in the same words on either surface, not merely
   * a setting each surface may word for itself.
   *
   * The representation check below proves a surface moves when the field does;
   * it cannot tell a surface stating the disclosure from one stating only that
   * the setting is on. Pinning the sentence here rather than in each surface's
   * own test is what keeps a surface from dropping it: the pin is carried on the
   * probe both surfaces are measured with, so a surface that stops rendering it
   * fails on the same string the other surface is held to.
   *
   * A list rather than one string, because what an acceptor is entitled to read
   * about one setting can be more than one sentence: the disclosure a setting
   * makes and which party's records pay it are separate facts, and a surface
   * holding only the first leaves a reader unable to tell whose file the cost
   * lands on. Every entry is held to the same present-for-variant,
   * absent-for-base rule.
   *
   * Left unset by a field measured under {@link shapes}, which carries its copy
   * per shape instead. Declaring both is refused rather than merged: the pair
   * builder resolves one level or the other, so the entry-level list would be
   * dropped from measurement.
   */
  requiredVariantCopy?: ReadonlyArray<string>;
  /**
   * The surrounding shapes this field is measured under, for a field whose
   * variant discloses something DIFFERENT depending on the rest of the document.
   * One probe pair is built per shape, each still differing at this field alone.
   *
   * The pin above cannot express that on its own: it names copy a surface must
   * render for the variant, so a field with two truthful sentences would have to
   * pin the one both shapes share -- which is neither -- or pin one and let the
   * other shape render a sentence for a disclosure its run does not make. Naming
   * the shapes here holds both surfaces to both sentences, each present for its
   * own shape and absent for the other.
   */
  shapes?: ReadonlyArray<ConsentProbeShape>;
  /**
   * Surfaces that do not render this field, each with why it is still absent.
   * Recorded rather than closed here: surfacing a field changes what an acceptor
   * sees before consenting, which is a partner-facing consent change and takes
   * its own change and its own review. Recording it is what keeps the difference
   * between "we chose not to show this" and "this surface does not show it yet"
   * legible -- and the per-surface check pins this set exactly, so closing a gap
   * without striking its entry fails too.
   */
  unrepresented?: Partial<Record<ConsentSurfaceName, string>>;
}

/**
 * @internal
 *
 * One surrounding shape a {@link ConsentRelevantTerm} is measured under, with the
 * copy that shape's variant owes a reader and the copy it must not carry.
 */
interface ConsentProbeShape {
  /**
   * What this shape is, in a few words. Appended to the field path as the
   * probe's {@link ConsentRepresentationProbe.label}, so a failing assertion
   * names the shape rather than only the field.
   */
  name: string;
  /**
   * Applied to BOTH sides of this shape's pair, after
   * {@link ConsentRelevantTerm.prepare}, so the pair still differs at the field
   * under test alone. Absent where the shape is the prepared base as it stands.
   */
  shape?: (terms: LinkageTerms) => LinkageTerms;
  /**
   * Copy every surface MUST render for this shape's variant and MUST NOT render
   * for its base, exactly as {@link ConsentRelevantTerm.requiredVariantCopy}.
   */
  requiredVariantCopy: ReadonlyArray<string>;
  /**
   * Copy every surface MUST NOT render for this shape's variant: the sentence
   * another shape of the same field owes, which this one's run does not make.
   * Without it a surface could render one sentence for every shape and satisfy
   * that shape's required copy while stating a disclosure the other shape's run
   * does not make -- which apps/web's invitationTerms.test.ts and apps/cli's
   * accept.test.ts hold each rendered surface to.
   */
  forbiddenVariantCopy: ReadonlyArray<string>;
}

/**
 * @internal
 *
 * A `LinkageTerms` field an acceptor's consent does not turn on, with the reason
 * it is out of scope. An excluded field needs no variant: nothing asserts where
 * it does or does not appear.
 */
interface ExcludedTerm {
  classification: "excluded";
  /** Why consent does not turn on this field. */
  reason: string;
}

/** @internal */
type LinkageTermClassification = ConsentRelevantTerm | ExcludedTerm;

function edited(
  terms: LinkageTerms,
  edit: (draft: LinkageTerms) => void,
): LinkageTerms {
  const draft = structuredClone(terms);
  edit(draft);
  return draft;
}

// Every element transform a transform-position variation has to move. The base's
// swap pair carries one transform across both of its positions, and the terms
// refuse a pair whose transforms differ, so a variation that moved one alone
// would produce a variant no surface can be asked to render.
function probeTransforms(terms: LinkageTerms): Array<Array<TransformStep>> {
  const transforms = terms.linkageKeys[0].elements
    .map((element) => element.transform)
    .filter((transform) => transform !== undefined);
  if (transforms.length === 0)
    throw new Error("the consent probe base declares no element transform");
  return transforms;
}

function fieldOfType<T extends LinkageField["type"]>(
  terms: LinkageTerms,
  type: T,
): Extract<LinkageField, { type: T }> {
  const field = terms.linkageFields.find(
    (candidate): candidate is Extract<LinkageField, { type: T }> =>
      candidate.type === type,
  );
  if (field === undefined)
    throw new Error(`the consent probe base declares no ${type} field`);
  return field;
}

/**
 * @internal
 *
 * The coherent linkage terms both consent surfaces are rendered from. Every
 * consent-relevant field carries a value, so each variant in
 * {@link LINKAGE_TERM_CONSENT_CLASSIFICATION} can change one in place rather than
 * introducing the structure that holds it -- which would differ at more than the
 * field under test.
 *
 * Ordinary, readable terms rather than the web suite's hostile-code-point
 * fixture: that fixture answers whether a partner string reaching a surface is
 * escaped, which is a different question from whether a field reaches the surface
 * at all, and its escaped renderings would obscure the per-field difference this
 * probe reads. It is also shared with the CLI suite, which has no access to the
 * web app's test utilities.
 */
export const CONSENT_PROBE_TERMS: LinkageTerms = {
  version: "1.0.0",
  identity: "Probe County Health Department",
  date: "2026-01-15",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [
    {
      name: "given_name",
      type: "first_name",
      constraints: {
        allowedCharacters: "A-Za-z",
        affixesAllowed: false,
        exclude: ["UNKNOWN"],
      },
    },
    {
      name: "family_name",
      type: "last_name",
      constraints: {
        allowedCharacters: "A-Za-z",
        affixesAllowed: false,
        exclude: ["UNKNOWN"],
      },
    },
    {
      name: "birth_date",
      type: "date_of_birth",
      constraints: { validOnly: true, exclude: ["1900-01-01"] },
    },
  ],
  linkageKeys: [
    {
      name: "given name, family name, and date of birth",
      elements: [
        {
          field: "given_name",
          name: "given",
          transform: [
            { function: "to_upper_case" },
            { function: "substring", params: { start: 1, length: 3 } },
          ],
        },
        {
          // The swap pair carries ONE transform across both of its positions,
          // which is what the terms admit: a swap moves the field references and
          // leaves each transform on its position, so a pair whose transforms
          // differ is refused.
          field: "family_name",
          name: "family",
          transform: [
            { function: "to_upper_case" },
            { function: "substring", params: { start: 1, length: 3 } },
          ],
        },
        { field: "birth_date", generateFuzzyComparisons: "adjacent_years" },
      ],
      swap: ["given", "family"],
    },
  ],
  // A citation of its own rather than the built-in set's: the probe's fields and
  // keys are not the built-in ones, so citing `hmis-keys` here would make the
  // document claim rules it does not carry.
  linkageRuleSet: {
    fieldSet: { name: "probe-pii", version: "1.0.0" },
    keySet: { name: "probe-keys", version: "1.0.0" },
  },
  payload: {
    send: [
      { name: "risk_score", description: "Model score for the matched record" },
    ],
    receive: [
      {
        name: "program_outcome",
        description: "Observed outcome for the matched record",
      },
    ],
  },
  legalAgreement: {
    reference: "MOU-2026-0001",
    purpose: "Evaluation of the county tutoring program",
    expirationDate: "2027-12-31",
  },
};

/**
 * @internal
 *
 * {@link CONSENT_PROBE_TERMS} in the shape a count-only exchange accepts: the
 * `psi-c` algorithm over the probe's single cascade key, with no payload in
 * either direction and no deduplication, which is what
 * docs/spec/PROTOCOL.md's PSI-C section admits.
 *
 * It is the `algorithm` entry's variant document below, exported so each
 * surface's render test pins the count-only tier against the same terms the
 * coverage probe measures it on -- one document read by both suites, so neither
 * surface's pin can drift onto a shape the other never rendered.
 */
export const COUNT_ONLY_PROBE_TERMS: LinkageTerms = {
  ...CONSENT_PROBE_TERMS,
  algorithm: "psi-c",
  payload: { send: [], receive: [] },
};

/**
 * @internal
 *
 * Every field path the `LinkageTerms` declaration reaches, classified as one an
 * acceptor's consent turns on or one it does not. Keyed by the paths derived from
 * that declaration, with array and tuple indices collapsed to `[]`, so a field
 * added to core has no entry here and fails the derivation check until someone
 * judges it.
 *
 * `linkageKeys[].elements[].transform[].params` terminates as a whole rather than
 * expanding: it is a `Record<string, unknown>`, whose index signature declares no
 * property paths to walk. Consent turns on the parameters as a set -- they decide
 * what each transform does to a value -- so classifying the record is the right
 * grain, not a workaround.
 */
export const LINKAGE_TERM_CONSENT_CLASSIFICATION: Record<
  string,
  LinkageTermClassification
> = {
  version: {
    classification: "excluded",
    reason:
      "A schema-compatibility gate. A version the acceptor cannot migrate to " +
      "aborts the exchange before any data moves, and it selects nothing about " +
      "what is matched or what is disclosed.",
  },
  identity: {
    classification: "consent-relevant",
    reason:
      "The party the acceptor is disclosing to -- the first thing consent turns " +
      "on.",
    vary: (terms) =>
      edited(terms, (draft) => {
        draft.identity = "Probe State Education Agency";
      }),
  },
  date: {
    classification: "excluded",
    reason:
      "A last-modified stamp on the terms. Consistency is soft (a mismatch warns " +
      "that one party may hold a stale copy) and it selects nothing matched or " +
      "disclosed.",
  },
  algorithm: {
    classification: "consent-relevant",
    reason:
      "Decides whether the exchange reveals the matched identifiers (`psi`) or " +
      "only their count (`psi-c`) -- and with the count, each party's record " +
      "count and the number of its records carrying the matched key, which the " +
      "count-only tier states and a surface omitting the tier does not.",
    // A count-only exchange accepts no payload in either direction, so the pair
    // is built on a base declaring none: varied against the probe's own payload
    // the psi-c side would be a document psi-c refuses, and what the surfaces
    // were measured on would not be the count-only tier. Both sides carry the
    // same empty pair, so they still differ at the algorithm alone.
    prepare: (terms) =>
      edited(terms, (draft) => {
        draft.payload = { send: [], receive: [] };
      }),
    vary: (terms) =>
      edited(terms, (draft) => {
        draft.algorithm = "psi-c";
      }),
  },
  linkageStrategy: {
    classification: "consent-relevant",
    reason:
      "`single-pass` hands the receiver the full per-key value structure in one " +
      "batch, so it observes matches on less precise keys a cascade would have " +
      "filtered out first.",
    vary: (terms) =>
      edited(terms, (draft) => {
        draft.linkageStrategy = "single-pass";
      }),
  },
  "output.expectsOutput": {
    classification: "consent-relevant",
    reason: "Whether the inviting party receives the intersection result.",
    // A party that receives no output may request no payload, so the pair is
    // built on a base with no requested columns; both sides carry that same
    // empty request.
    prepare: (terms) =>
      edited(terms, (draft) => {
        if (draft.payload !== undefined) draft.payload.receive = [];
      }),
    vary: (terms) =>
      edited(terms, (draft) => {
        draft.output.expectsOutput = false;
      }),
  },
  "output.shareWithPartner": {
    classification: "consent-relevant",
    reason: "Whether the accepting party receives the intersection result.",
    vary: (terms) =>
      edited(terms, (draft) => {
        draft.output.shareWithPartner = false;
      }),
  },
  deduplicate: {
    classification: "consent-relevant",
    reason:
      "Whether several of the inviter's records may match the same one of " +
      "the acceptor's, which changes how many records the intersection holds " +
      "-- and discloses to whichever party receives the result how the " +
      "inviter's records group onto each matched record of the acceptor's.",
    // Which party reads the grouping follows the output shape, so the two shapes
    // a deduplicating document can take are measured separately. The schema
    // requires the declaring party to receive output, so `shareWithPartner` is
    // the whole of the remaining axis: both parties receive, or the inviter
    // alone does.
    shapes: [
      {
        name: "both parties receive the result",
        requiredVariantCopy: [
          DEDUPLICATE_SHARED_RESULT_DISCLOSURE_STATEMENT,
          DEDUPLICATE_ACCEPTOR_SIDE_NOTE,
        ],
        forbiddenVariantCopy: [
          DEDUPLICATE_SOLE_RECEIVER_DISCLOSURE_STATEMENT,
          // The display limit belongs to the sole-receiver shape alone: this
          // shape presents the accepting party the grouping, so a sentence
          // saying what it is NOT shown would name a withholding that does not
          // happen.
          CONSENT_FACTS.duplicateGroupingDisplayLimit.note,
        ],
      },
      {
        name: "the inviting party is the sole receiver",
        // The acceptor mirrors to a party that receives nothing, so the inviter
        // may transmit no payload to it: an invitation declaring a `send` here
        // is one deriveAcceptedLinkageTerms refuses, and the probe would measure
        // the surfaces on a document no acceptance can reach. The request FROM
        // the acceptor stays, since that direction is exactly what the widening
        // the side note states reaches.
        shape: (terms) =>
          edited(terms, (draft) => {
            draft.output.shareWithPartner = false;
            if (draft.payload !== undefined) draft.payload.send = [];
          }),
        requiredVariantCopy: [
          DEDUPLICATE_SOLE_RECEIVER_DISCLOSURE_STATEMENT,
          // The statement's own display limit, split out so its trust-contingent
          // basis is carried and pinned rather than living inside the sentence.
          // Required beside the statement, at the same level, for the same
          // reason the direction note is: a reader met by the withholding is
          // entitled to what the rounds still reach in the same place.
          CONSENT_FACTS.duplicateGroupingDisplayLimit.note,
          DEDUPLICATE_ACCEPTOR_SIDE_NOTE,
        ],
        forbiddenVariantCopy: [DEDUPLICATE_SHARED_RESULT_DISCLOSURE_STATEMENT],
      },
    ],
    vary: (terms) =>
      edited(terms, (draft) => {
        draft.deduplicate = true;
      }),
  },
  "linkageFields[].name": {
    classification: "excluded",
    reason:
      "A partner-authored label that only binds a key element to a declared " +
      "field. It never reaches a matched value, and the web summary withholds " +
      "it deliberately -- unvetted partner text that could impersonate a system " +
      "label -- showing the semantic `type` it resolves to instead.",
  },
  "linkageFields[].type": {
    classification: "consent-relevant",
    reason:
      "Which category of PII participates in linkage -- a full SSN and its last " +
      "four digits are a real disclosure difference.",
    // A date-of-birth field becomes an SSN field: the two carry the same
    // constraint shape, so the replacement moves the semantic type and nothing
    // else.
    vary: (terms) =>
      edited(terms, (draft) => {
        const field = fieldOfType(draft, "date_of_birth");
        draft.linkageFields[draft.linkageFields.indexOf(field)] = {
          ...field,
          type: "ssn",
        };
      }),
  },
  "linkageFields[].constraints.allowedCharacters": {
    classification: "consent-relevant",
    reason:
      "The character class the party commits its values to, which decides which " +
      "values are flagged as off-standard before matching.",
    vary: (terms) =>
      edited(terms, (draft) => {
        fieldOfType(draft, "first_name").constraints = {
          ...fieldOfType(draft, "first_name").constraints,
          allowedCharacters: "A-Za-z0-9",
        };
      }),
  },
  "linkageFields[].constraints.affixesAllowed": {
    classification: "consent-relevant",
    reason:
      "Whether honorifics and suffixes are expected to have been removed, which " +
      "decides whether two spellings of the same name meet.",
    vary: (terms) =>
      edited(terms, (draft) => {
        fieldOfType(draft, "first_name").constraints = {
          ...fieldOfType(draft, "first_name").constraints,
          affixesAllowed: true,
        };
      }),
  },
  "linkageFields[].constraints.exclude": {
    classification: "consent-relevant",
    reason:
      "Values the party commits not to present for matching, so a record " +
      "carrying one is expected to go unmatched.",
    // The web summary reports this denylist by SIZE rather than by value, so the
    // variant adds an entry: changing one in place would leave the rendering
    // identical and read as an absent field.
    vary: (terms) =>
      edited(terms, (draft) => {
        fieldOfType(draft, "first_name").constraints = {
          ...fieldOfType(draft, "first_name").constraints,
          exclude: ["UNKNOWN", "TEST"],
        };
      }),
  },
  "linkageFields[].constraints.validOnly": {
    classification: "consent-relevant",
    reason:
      "Whether values are committed to be well-formed (a parseable date, an SSN " +
      "meeting SSA rules), which decides which records are expected to match.",
    vary: (terms) =>
      edited(terms, (draft) => {
        fieldOfType(draft, "date_of_birth").constraints = {
          ...fieldOfType(draft, "date_of_birth").constraints,
          validOnly: false,
        };
      }),
  },
  "linkageKeys[].name": {
    classification: "consent-relevant",
    reason:
      "Names the matching round the acceptor is agreeing to, and anchors the " +
      "per-key rules each surface lists under it.",
    vary: (terms) =>
      edited(terms, (draft) => {
        draft.linkageKeys[0].name = "given name and family name";
      }),
  },
  "linkageKeys[].elements[].field": {
    classification: "consent-relevant",
    reason:
      "Which declared field a key element matches on, and so which PII the " +
      "intersection is computed over.",
    vary: (terms) =>
      edited(terms, (draft) => {
        draft.linkageKeys[0].elements[2].field = "family_name";
      }),
  },
  "linkageKeys[].elements[].name": {
    classification: "excluded",
    reason:
      "An intra-key alias that exists only to make a `swap` reference " +
      "unambiguous when one field appears twice in a key. It never reaches a " +
      "matched value; the swap it identifies is classified on its own.",
  },
  "linkageKeys[].elements[].generateFuzzyComparisons": {
    classification: "consent-relevant",
    reason:
      "Expands one value into several match candidates, so records that do not " +
      "agree exactly still match -- and under `psi` their identifiers are " +
      "disclosed.",
    vary: (terms) =>
      edited(terms, (draft) => {
        draft.linkageKeys[0].elements[2].generateFuzzyComparisons =
          "transpositions";
      }),
  },
  "linkageKeys[].elements[].transform[].function": {
    classification: "consent-relevant",
    reason:
      "Rewrites the value before it is hashed, so it decides which records meet " +
      "-- a truncation or a sound-alike recoding matches records the raw values " +
      "never would.",
    vary: (terms) =>
      edited(terms, (draft) => {
        for (const transform of probeTransforms(draft))
          transform[0].function = "to_lower_case";
      }),
  },
  "linkageKeys[].elements[].transform[].params": {
    classification: "consent-relevant",
    reason:
      "Decides what a transform actually does: the same function under different " +
      "parameters matches a different set of records.",
    vary: (terms) =>
      edited(terms, (draft) => {
        for (const transform of probeTransforms(draft))
          transform[1].params = { start: 1, length: 4 };
      }),
  },
  "linkageKeys[].swap": {
    classification: "consent-relevant",
    reason:
      "Builds this key with the two named elements' values exchanged on the " +
      "receiving side, so records whose values are transposed between two " +
      "fields match.",
    vary: (terms) =>
      edited(terms, (draft) => {
        delete draft.linkageKeys[0].swap;
      }),
  },
  "linkageRuleSet.fieldSet.name": {
    classification: "consent-relevant",
    reason:
      "Names the artifact the declared linkage fields are cited to, which is " +
      "what an acceptor checks the exchange against an agreement or a " +
      "governance review by -- and what its own disclosure log records as the " +
      "substrate the match keyed on.",
    vary: (terms) =>
      edited(terms, (draft) => {
        if (draft.linkageRuleSet !== undefined)
          draft.linkageRuleSet.fieldSet.name = "probe-pii-extended";
      }),
  },
  "linkageRuleSet.fieldSet.version": {
    classification: "consent-relevant",
    reason:
      "Pins which content the field set's name stands for. Two versions of one " +
      "name are two different sets of fields and constraints, so a citation " +
      "without the version identifies nothing an acceptor can rely on.",
    vary: (terms) =>
      edited(terms, (draft) => {
        if (draft.linkageRuleSet !== undefined)
          draft.linkageRuleSet.fieldSet.version = "2.0.0";
      }),
  },
  "linkageRuleSet.keySet.name": {
    classification: "consent-relevant",
    reason:
      "Names the artifact the declared linkage keys are cited to -- which " +
      "combinations of PII count as a match, and the set any validation on " +
      "record attaches to. It is the citation an acceptor carries into an " +
      "agreement and into its own disclosure log.",
    vary: (terms) =>
      edited(terms, (draft) => {
        if (draft.linkageRuleSet !== undefined)
          draft.linkageRuleSet.keySet.name = "probe-keys-strict";
      }),
  },
  "linkageRuleSet.keySet.version": {
    classification: "consent-relevant",
    reason:
      "Pins which content the key set's name stands for. A key added, dropped, " +
      "or moved in the cascade is a new version, so the version is what makes " +
      "the citation identify the rules that ran rather than the name alone.",
    vary: (terms) =>
      edited(terms, (draft) => {
        if (draft.linkageRuleSet !== undefined)
          draft.linkageRuleSet.keySet.version = "2.0.0";
      }),
  },
  "payload.send[].name": {
    classification: "consent-relevant",
    reason:
      "The columns the inviter declares it will transmit for matched records -- " +
      "what the acceptor receives beyond the intersection itself.",
    vary: (terms) =>
      edited(terms, (draft) => {
        if (draft.payload?.send !== undefined)
          draft.payload.send[0].name = "risk_band";
      }),
  },
  "payload.send[].description": {
    classification: "excluded",
    reason:
      "A data-dictionary annotation on a column the same list already names. It " +
      "changes nothing about which columns are transmitted, matched on, or " +
      "disclosed.",
  },
  "payload.receive[].name": {
    classification: "consent-relevant",
    reason:
      "The columns the inviter requests FROM the acceptor for matched records -- " +
      "an outbound disclosure the acceptor is being asked to make.",
    vary: (terms) =>
      edited(terms, (draft) => {
        if (draft.payload?.receive !== undefined)
          draft.payload.receive[0].name = "program_status";
      }),
  },
  "payload.receive[].description": {
    classification: "excluded",
    reason:
      "A data-dictionary annotation on a column the same list already names. It " +
      "changes nothing about which columns are transmitted, matched on, or " +
      "disclosed.",
  },
  "legalAgreement.reference": {
    classification: "consent-relevant",
    reason:
      "Identifies the agreement that authorizes the disclosure, and is " +
      "cross-checked against the acceptor's own copy.",
    vary: (terms) =>
      edited(terms, (draft) => {
        if (draft.legalAgreement !== undefined)
          draft.legalAgreement.reference = "MOU-2026-0002";
      }),
  },
  "legalAgreement.purpose": {
    classification: "consent-relevant",
    reason:
      "States the purpose the disclosure is made for, and is recorded as the " +
      "disclosure-log entry the exchange stands on.",
    vary: (terms) =>
      edited(terms, (draft) => {
        if (draft.legalAgreement !== undefined)
          draft.legalAgreement.purpose =
            "Evaluation of the county after-school program";
      }),
  },
  "legalAgreement.expirationDate": {
    classification: "consent-relevant",
    reason:
      "The date past which the exchange is refused, cross-checked between the " +
      "parties before any data moves.",
    vary: (terms) =>
      edited(terms, (draft) => {
        if (draft.legalAgreement !== undefined)
          draft.legalAgreement.expirationDate = "2028-06-30";
      }),
  },
};

/**
 * @internal
 *
 * One rendering pair per consent-relevant field: a base document and a variant
 * differing from it at that field alone. A surface represents the field when it
 * renders the two differently.
 */
interface ConsentRepresentationProbe {
  /**
   * The derived `LinkageTerms` field path this pair varies. Shared by every pair
   * of a field measured under several {@link ConsentRelevantTerm.shapes}, which
   * {@link label} tells apart.
   */
  path: string;
  /** {@link path}, with the shape's name where the field carries shapes. */
  label: string;
  /** {@link ConsentRelevantTerm.reason} for the field. */
  reason: string;
  base: LinkageTerms;
  variant: LinkageTerms;
  /**
   * The copy this pair's variant must render and its base must not: the field's
   * {@link ConsentRelevantTerm.requiredVariantCopy}, or this shape's.
   */
  requiredVariantCopy?: ReadonlyArray<string>;
  /**
   * The copy this pair's variant must NOT render:
   * {@link ConsentProbeShape.forbiddenVariantCopy}, absent for a field measured
   * under one shape.
   */
  forbiddenVariantCopy?: ReadonlyArray<string>;
  /** {@link ConsentRelevantTerm.unrepresented} for the field, never absent. */
  unrepresented: Partial<Record<ConsentSurfaceName, string>>;
}

/**
 * @internal
 *
 * The rendering pairs for every consent-relevant entry of
 * {@link LINKAGE_TERM_CONSENT_CLASSIFICATION} -- one per entry, or one per shape
 * for an entry that names {@link ConsentRelevantTerm.shapes}.
 *
 * Both sides go through `parseLinkageTerms`, so a variant that is not a coherent
 * terms document -- a renamed field with no element updated to reference it, a
 * setting the schema forbids alongside another -- throws here instead of
 * rendering into a difference that would prove nothing about the field.
 *
 * `classification` is the table to build from, the live one unless a caller names
 * another: the structural guards here are what every suite reading the probes
 * runs, so exercising one takes a table that breaks it.
 */
export function consentRepresentationProbes(
  classification: Record<
    string,
    LinkageTermClassification
  > = LINKAGE_TERM_CONSENT_CLASSIFICATION,
): Array<ConsentRepresentationProbe> {
  const probes: Array<ConsentRepresentationProbe> = [];
  for (const [path, entry] of Object.entries(classification)) {
    if (entry.classification !== "consent-relevant") continue;
    if (entry.shapes !== undefined && entry.requiredVariantCopy !== undefined)
      throw new Error(
        `${path} declares shapes and an entry-level requiredVariantCopy: a ` +
          `field measured under shapes pins its copy per shape, so the ` +
          `entry-level list would go unmeasured. Move each sentence onto the ` +
          `shape whose variant owes it.`,
      );
    const prepared =
      entry.prepare?.(CONSENT_PROBE_TERMS) ?? CONSENT_PROBE_TERMS;
    const shapes: ReadonlyArray<ConsentProbeShape | undefined> =
      entry.shapes ?? [undefined];
    for (const shape of shapes) {
      const shaped = shape?.shape?.(prepared) ?? prepared;
      const requiredVariantCopy =
        shape?.requiredVariantCopy ?? entry.requiredVariantCopy;
      probes.push({
        path,
        label: shape === undefined ? path : `${path} (${shape.name})`,
        reason: entry.reason,
        base: parseLinkageTerms(shaped),
        variant: parseLinkageTerms(entry.vary(shaped)),
        ...(requiredVariantCopy !== undefined ? { requiredVariantCopy } : {}),
        ...(shape?.forbiddenVariantCopy !== undefined
          ? { forbiddenVariantCopy: shape.forbiddenVariantCopy }
          : {}),
        unrepresented: entry.unrepresented ?? {},
      });
    }
  }
  return probes;
}
