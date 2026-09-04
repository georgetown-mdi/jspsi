import { referencedLinkageFieldNames } from "../config/linkageTerms";
import type {
  LinkageRuleSetReference,
  LinkageSetIdentity,
  LinkageTerms,
  LinkageField,
  LinkageKey,
} from "../config/linkageTerms";
import type { Metadata } from "../config/metadata";
import { canonicalString } from "../utils/canonical";
import type {
  Standardization,
  StandardizationTransformation,
} from "../config/standardization";
import type { SemanticType } from "../types";

/**
 * Neutral, stable identifier of the built-in linkage FIELD set: the PII
 * substrate ({@link DEFAULT_LINKAGE_FIELDS}) that
 * {@link getDefaultLinkageTerms} emits when a party does not author its own. It
 * names which PII elements the built-in rules work from and how each is cleaned
 * and bounded -- not which combinations of them constitute a match, which is
 * what the key set ({@link DEFAULT_LINKAGE_KEY_SET_NAME}) names. The two are
 * separate artifacts because the substrate is generic where the keys are
 * specific: every built-in key is built from these fields, but the same fields
 * support key sets settled for other uses.
 *
 * Naming it is what lets "which rules did this linkage match on" be answered by
 * a name rather than by "the defaults", and lets the set be cited in a
 * data-sharing agreement or a governance review without quoting the field list.
 *
 * Deliberately says nothing about who validated anything: these fields carry no
 * validation lineage of their own -- what was validated, against what, and the
 * criticisms on record all attach to the key set, and belong in
 * `docs/notes/default-linkage-rule-set.md` rather than in either identifier.
 */
export const DEFAULT_LINKAGE_FIELD_SET_NAME = "baseline-pii";

/**
 * Version of the field set named by {@link DEFAULT_LINKAGE_FIELD_SET_NAME}.
 *
 * Distinct from `LinkageTerms.version`, which versions the terms SCHEMA and is
 * cross-checked between the parties at exchange time. This one versions the
 * CONTENT of the built-in field set -- which fields it declares and which
 * constraints they carry -- and is not on the wire. Neither it nor
 * {@link DEFAULT_LINKAGE_KEY_SET_VERSION} may ever be assigned to a terms
 * document's `version`.
 *
 * Bump it in the same change that edits {@link DEFAULT_LINKAGE_FIELDS}: a field
 * added or dropped, or a constraint loosened or tightened. The two sets version
 * independently, so an edit to the keys bumps
 * {@link DEFAULT_LINKAGE_KEY_SET_VERSION} and leaves this one alone.
 */
export const DEFAULT_LINKAGE_FIELD_SET_VERSION = "1.0.0";

/**
 * The linkage fields of the {@link DEFAULT_LINKAGE_FIELD_SET_NAME} field set:
 * the standardized form of each PII element the built-in keys are built from,
 * with the constraints each field commits both parties to.
 */
const DEFAULT_LINKAGE_FIELDS: ReadonlyArray<LinkageField> = [
  {
    name: "ssn",
    type: "ssn",
    constraints: {
      exclude: ["111111111", "123456789"],
      validOnly: true,
    },
  },
  {
    name: "ssn4",
    type: "ssn4",
    constraints: { validOnly: true },
  },
  {
    name: "first_name",
    type: "first_name",
    constraints: { affixesAllowed: false, allowedCharacters: "A-Z " },
  },
  {
    name: "last_name",
    type: "last_name",
    constraints: { affixesAllowed: false, allowedCharacters: "A-Z " },
  },
  { name: "date_of_birth", type: "date_of_birth" },
];

/**
 * Neutral, stable identifier of the built-in linkage KEY set: the key
 * combinations ({@link DEFAULT_LINKAGE_KEYS}) that
 * {@link getDefaultLinkageTerms} emits when a party does not author its own.
 * Every key is built from the fields of
 * {@link DEFAULT_LINKAGE_FIELD_SET_NAME}, so a citation of this set is a
 * citation of that one too; what this name adds is the specific part -- which
 * combinations of that substrate count as a match, and in what cascade order.
 *
 * Names the class of system the keys were settled for rather than the
 * engagement that settled them: the repository is public, and an attribution is
 * not the product's to publish. The validation lineage and the criticisms on
 * record attach to THIS set, not to the fields, and are recorded in
 * `docs/notes/default-linkage-rule-set.md` rather than in the identifier.
 */
export const DEFAULT_LINKAGE_KEY_SET_NAME = "hmis-keys";

/**
 * Version of the key set named by {@link DEFAULT_LINKAGE_KEY_SET_NAME}.
 *
 * Distinct from `LinkageTerms.version`, which versions the terms SCHEMA and is
 * cross-checked between the parties at exchange time. This one versions the
 * CONTENT of the built-in key set -- which key combinations it declares and in
 * what order -- and is not on the wire. Neither it nor
 * {@link DEFAULT_LINKAGE_FIELD_SET_VERSION} may ever be assigned to a terms
 * document's `version`.
 *
 * Bump it in the same change that edits {@link DEFAULT_LINKAGE_KEYS}: a key
 * added or removed, an element or transform changed, or the keys REORDERED --
 * order is cascade order, so a reorder changes which key claims a record that
 * more than one would match. The recorded validation attaches to the name and
 * version together, so an edited set carrying the old version makes that record
 * describe rules nobody ran.
 */
export const DEFAULT_LINKAGE_KEY_SET_VERSION = "1.0.0";

/**
 * The linkage key combinations of the {@link DEFAULT_LINKAGE_KEY_SET_NAME} key
 * set, in the set's cascade order: an earlier key claims a record first, and a
 * record it claims is withheld from every later round.
 *
 * The order is not a ranking by precision or by strength of evidence, and
 * reading it as one misdescribes the set: keys carrying no SSN evidence sit
 * above SSN-bearing ones, and a key carrying an SSN but no last name sits above
 * both. What the published cascades order on instead, and what the per-key
 * measurements say about either arrangement, is set out in
 * `docs/notes/linkage-rule-grounding.md`.
 *
 * The ordering the set does hold to is over the date of birth: coarsening it to
 * a year and month is a fallback for a key's own full-date form rather than a
 * competitor to it, so wherever the set declares both, the full-date key
 * precedes the coarsened key built from the same other elements.
 *
 * Both statements are asserted over this array in
 * `test/builtInLinkageKeyOrder.test.ts` -- an ordering claim made only in prose
 * has nothing to fail when an edit breaks it.
 *
 * {@link linkageTermsFromRuleSet} emits a SUBSET of these: a key whose elements
 * the input's columns cannot satisfy is dropped.
 */
const DEFAULT_LINKAGE_KEYS: ReadonlyArray<LinkageKey> = [
  {
    name: "SSN + LN + DOB",
    elements: [
      { field: "ssn" },
      { field: "last_name" },
      { field: "date_of_birth" },
    ],
  },
  {
    name: "SSN + LN + FN1",
    elements: [
      { field: "ssn" },
      { field: "last_name" },
      {
        field: "first_name",
        transform: [{ function: "substring", params: { start: 1, length: 1 } }],
      },
    ],
  },
  {
    name: "SSN + LN3 + FN1",
    elements: [
      { field: "ssn" },
      {
        field: "last_name",
        transform: [{ function: "substring", params: { start: 1, length: 3 } }],
      },
      {
        field: "first_name",
        transform: [{ function: "substring", params: { start: 1, length: 1 } }],
      },
    ],
  },
  {
    name: "SSN + LN4 + DOB",
    elements: [
      { field: "ssn" },
      {
        field: "last_name",
        transform: [{ function: "substring", params: { start: 1, length: 4 } }],
      },
      { field: "date_of_birth" },
    ],
  },
  {
    name: "SSN + LN4 + YOB + MOB",
    elements: [
      { field: "ssn" },
      {
        field: "last_name",
        transform: [{ function: "substring", params: { start: 1, length: 4 } }],
      },
      {
        field: "date_of_birth",
        transform: [{ function: "substring", params: { start: 1, length: 6 } }],
      },
    ],
  },
  {
    name: "SSN + LN3 + DOB",
    elements: [
      { field: "ssn" },
      {
        field: "last_name",
        transform: [{ function: "substring", params: { start: 1, length: 3 } }],
      },
      { field: "date_of_birth" },
    ],
  },
  {
    name: "SSN + FN3 + DOB",
    elements: [
      { field: "ssn" },
      {
        field: "first_name",
        transform: [{ function: "substring", params: { start: 1, length: 3 } }],
      },
      { field: "date_of_birth" },
    ],
  },
  {
    name: "SSN4 + LN + DOB",
    elements: [
      { field: "ssn4" },
      { field: "last_name" },
      { field: "date_of_birth" },
    ],
  },
  {
    name: "SSN4 + LN4 + YOB + MOB",
    elements: [
      { field: "ssn4" },
      {
        field: "last_name",
        transform: [{ function: "substring", params: { start: 1, length: 4 } }],
      },
      {
        field: "date_of_birth",
        transform: [{ function: "substring", params: { start: 1, length: 6 } }],
      },
    ],
  },
  {
    name: "LN + FN + DOB",
    elements: [
      { field: "last_name" },
      { field: "first_name" },
      { field: "date_of_birth" },
    ],
  },
  {
    name: "swap(LN, FN) + DOB",
    elements: [
      { field: "last_name" },
      { field: "first_name" },
      { field: "date_of_birth" },
    ],
    swap: ["last_name", "first_name"],
  },
  {
    name: "SSN + DOB + FN",
    elements: [
      { field: "ssn" },
      { field: "date_of_birth" },
      { field: "first_name" },
    ],
  },
  {
    name: "SSN + FN + YOB + MOB",
    elements: [
      { field: "ssn" },
      { field: "first_name" },
      {
        field: "date_of_birth",
        transform: [{ function: "substring", params: { start: 1, length: 6 } }],
      },
    ],
  },
  {
    name: "SSN + FN3 + YOB + MOB",
    elements: [
      { field: "ssn" },
      {
        field: "first_name",
        transform: [{ function: "substring", params: { start: 1, length: 3 } }],
      },
      {
        field: "date_of_birth",
        transform: [{ function: "substring", params: { start: 1, length: 6 } }],
      },
    ],
  },
];

/**
 * A named, versioned collection of linkage fields and keys terms can be drawn
 * from: the field set and the key set that
 * {@link LinkageRuleSetReference} cites, together with the content each names.
 *
 * The reference is what travels -- in a terms document, an invitation, and each
 * party's exchange record -- while the content is what a terms document is built
 * from. Keeping both on one object is what makes a set a selectable thing rather
 * than a pair of loose declarations: a caller selects a set and gets rules and
 * citation together, so the two cannot come apart.
 */
export interface BuiltInLinkageRuleSet {
  /** The name and version of each half, as a terms document cites them. */
  reference: LinkageRuleSetReference;
  /** The set's linkage fields, in declaration order. */
  linkageFields: ReadonlyArray<LinkageField>;
  /** The set's linkage keys, in the cascade order the set declares. */
  linkageKeys: ReadonlyArray<LinkageKey>;
}

/**
 * `value` frozen, and every array and object it holds frozen with it, returned at
 * its own type. `Object.freeze` alone reaches one level, which on an array of
 * declarations leaves each declaration writable.
 */
function frozenThroughContents<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  for (const held of Object.values(value)) frozenThroughContents(held);
  return Object.freeze(value);
}

/**
 * The one built-in rule set: the {@link DEFAULT_LINKAGE_KEY_SET_NAME} keys over
 * the {@link DEFAULT_LINKAGE_FIELD_SET_NAME} fields, at the version each
 * declares. It is the set every path that authors nothing selects, so a
 * zero-setup exchange, the `psilink init` template, and the web invite editors'
 * starting point all cite the same rules.
 *
 * Composed from the six declarations above rather than replacing them: the
 * built-in sets' drift and zero-setup checks read those declarations out of this
 * file by name and require each to be a literal (`scripts/lib/builtInRuleSets.mjs`).
 *
 * Frozen through every level, and this object with it. The reference, the fields,
 * and the keys are all ALIASED into every terms document derived from the set
 * ({@link linkageTermsFromRuleSet}) and from there into each party's exchange
 * record, so a single in-place edit of a name, a version, a constraint, or a key
 * element would rewrite the built-in set in every document the process later
 * derives, and in every record written from one -- without touching the
 * declarations above that the drift checks pin. The rules carry the same weight
 * the citation does: they are what {@link checkLinkageRuleSetCitation} compares a
 * cited document against, so an edited set decides later verdicts too. Freezing
 * makes such an edit throw where it is attempted instead, and it happens at this
 * composition because those declarations must stay plain literals for the checks
 * named above to read them.
 */
export const DEFAULT_LINKAGE_RULE_SET: BuiltInLinkageRuleSet = Object.freeze({
  reference: Object.freeze({
    fieldSet: Object.freeze({
      name: DEFAULT_LINKAGE_FIELD_SET_NAME,
      version: DEFAULT_LINKAGE_FIELD_SET_VERSION,
    }),
    keySet: Object.freeze({
      name: DEFAULT_LINKAGE_KEY_SET_NAME,
      version: DEFAULT_LINKAGE_KEY_SET_VERSION,
    }),
  }),
  linkageFields: frozenThroughContents(DEFAULT_LINKAGE_FIELDS),
  linkageKeys: frozenThroughContents(DEFAULT_LINKAGE_KEYS),
});

/**
 * Whether `rules` were drawn from `ruleSet`: every key byte-identical to a key
 * the set declares, in the set's own cascade order, and every field
 * byte-identical to a DISTINCT field it declares. A narrowed emission passes --
 * what an input file cannot supply is left out -- while an added, edited, or
 * repeated key or field, and a reordered cascade, do not.
 *
 * Order is part of the answer for the keys and not for the fields, for the same
 * reason each set versions its own content: key order is cascade order, so
 * moving one changes which key claims a record more than one would match,
 * whereas the field array's order is not significant.
 *
 * This is what keeps a citation honest where rules are EDITED after being seeded
 * from a set -- the web invite editors' path. A received document's citation is
 * judged by {@link checkLinkageRuleSetCitation} instead, which annotates it with
 * a verdict rather than rewriting or dropping it: the reference stays that
 * party's own statement about its own rules.
 *
 * Compared through the canonical encoding, the same equality the two parties'
 * terms are compared under, so property order does not enter it. A value outside
 * the canonical domain (a transform param beyond the safe integer range) cannot
 * be compared and answers `false` rather than throwing: such rules are not the
 * built-in set, which carries no such value.
 */
export function isDrawnFromLinkageRuleSet(
  ruleSet: BuiltInLinkageRuleSet,
  rules: Pick<LinkageTerms, "linkageFields" | "linkageKeys">,
): boolean {
  return (
    fieldsDrawnFromSet(ruleSet.linkageFields, rules.linkageFields) &&
    keysDrawnFromSet(ruleSet.linkageKeys, rules.linkageKeys)
  );
}

/**
 * `value` in the canonical encoding, the equality the two parties' terms are
 * compared under, or `null` when it carries a value outside the canonical domain
 * (a transform param beyond the safe integer range) and so cannot be compared.
 * Every comparison here reads `null` as no match rather than throwing, the answer
 * {@link isDrawnFromLinkageRuleSet} and {@link isOptInLinkageKey} give such rules:
 * the built-in and offered sets carry no such value, so nothing incomparable is
 * one of them.
 *
 * @internal exported for the web editor's key reconciliation, which matches a
 * draft key to an offer under this same equality.
 */
export function encodeForComparison(value: unknown): string | null {
  try {
    return canonicalString(value);
  } catch {
    return null;
  }
}

/** The field half of {@link isDrawnFromLinkageRuleSet}: every candidate field
 * byte-identical to a DISTINCT declared field, order not significant. */
function fieldsDrawnFromSet(
  declaredFieldList: ReadonlyArray<LinkageField>,
  fields: ReadonlyArray<LinkageField>,
): boolean {
  // Each declaration is consumed on match, so a field the candidate repeats meets
  // no declaration the second time -- the same answer the key cursor gives a
  // repeated key, rather than a lookup that would accept the repeat.
  const declaredFields = new Map(
    declaredFieldList.map(
      (field) => [field.name, encodeForComparison(field)] as const,
    ),
  );
  for (const field of fields) {
    const declared = declaredFields.get(field.name);
    if (declared === undefined || declared === null) return false;
    if (encodeForComparison(field) !== declared) return false;
    declaredFields.delete(field.name);
  }
  return true;
}

/** The key half of {@link isDrawnFromLinkageRuleSet}: every candidate key
 * byte-identical to a declared key, in the set's own cascade order. */
function keysDrawnFromSet(
  declaredKeyList: ReadonlyArray<LinkageKey>,
  keys: ReadonlyArray<LinkageKey>,
): boolean {
  // Walk the set's keys and the candidate's together: each candidate key must
  // meet the next set key that matches it, so a key the set does not declare, a
  // repeated key, and a pair in the wrong cascade order all run the cursor off
  // the end.
  const declaredKeys = declaredKeyList.map(encodeForComparison);
  let cursor = 0;
  for (const key of keys) {
    const encoded = encodeForComparison(key);
    if (encoded === null) return false;
    let matched = false;
    while (cursor < declaredKeys.length && !matched) {
      matched = declaredKeys[cursor] === encoded;
      cursor += 1;
    }
    if (!matched) return false;
  }
  return true;
}

/**
 * One party's verdict on one half of a rule-set citation, reached by this build
 * against the sets it ships.
 *
 * - `consistent` -- the cited half names a set this build ships, and the rules
 *   the same document declares for that half are drawn from it.
 * - `contradicted` -- the cited half names a set this build ships, and the
 *   declared rules are NOT drawn from it: the citation states a provenance the
 *   rules beside it do not have.
 * - `unchecked` -- the cited half names a set this build does not ship, so
 *   nothing here resolves the name and no comparison was made.
 *
 * Three states rather than two because the absence of `contradicted` must never
 * read as verification: a build that cannot resolve a name has checked nothing,
 * which is a different statement from having checked and found the rules to
 * match.
 */
export type LinkageRuleSetCitationVerdict =
  "consistent" | "contradicted" | "unchecked";

/**
 * A verdict per citation half. The two halves are decided independently, for the
 * reason they are named and versioned independently: a document can truthfully
 * cite the built-in field set while its keys are not the built-in key set.
 */
interface LinkageRuleSetCitationVerdicts {
  /** The verdict on the set the declared linkage fields are cited to. */
  fieldSet: LinkageRuleSetCitationVerdict;
  /** The verdict on the set the declared linkage keys are cited to. */
  keySet: LinkageRuleSetCitationVerdict;
}

/** Whether two set identities name the same set: both the name and the content
 * version, since a name without its version identifies no fixed content. */
function namesSameSet(
  cited: LinkageSetIdentity,
  shipped: LinkageSetIdentity,
): boolean {
  return cited.name === shipped.name && cited.version === shipped.version;
}

/**
 * This build's verdict on `citation`, the rule set `rules` are cited to, one half
 * at a time.
 *
 * Total over a citation that exists: a caller renders or records a verdict
 * exactly where it has a citation to be about, so the absence of one is the
 * caller's own branch rather than a fourth state here.
 *
 * The verdict is the checking build's OWN check, made at the moment it is asked
 * for and against the sets that build ships. It is not a property of the terms
 * and not a cross-party agreement: two parties on different builds may reach
 * different verdicts on one document, since a set one of them ships is a set the
 * other may not.
 *
 * Resolution is per half and by name AND version together, the pattern the web
 * import path already resolves a citation by: a half naming the shipped set is
 * compared against that set's own rules, and any other name is `unchecked`.
 * Nothing here resolves a partner's set name to content -- an unresolvable name
 * stays unresolvable, carried and caveated rather than guessed at.
 *
 * What "drawn from" means is exactly {@link isDrawnFromLinkageRuleSet}'s
 * answer for that half, so this widens and narrows nothing: a narrowed emission
 * is `consistent`, while an added, edited, or repeated rule, or a reordered
 * cascade, is `contradicted`.
 */
export function checkLinkageRuleSetCitation(
  citation: LinkageRuleSetReference,
  rules: Pick<LinkageTerms, "linkageFields" | "linkageKeys">,
): LinkageRuleSetCitationVerdicts {
  const shipped = DEFAULT_LINKAGE_RULE_SET.reference;
  return {
    fieldSet: !namesSameSet(citation.fieldSet, shipped.fieldSet)
      ? "unchecked"
      : fieldsDrawnFromSet(
            DEFAULT_LINKAGE_RULE_SET.linkageFields,
            rules.linkageFields,
          )
        ? "consistent"
        : "contradicted",
    keySet: !namesSameSet(citation.keySet, shipped.keySet)
      ? "unchecked"
      : keysDrawnFromSet(
            DEFAULT_LINKAGE_RULE_SET.linkageKeys,
            rules.linkageKeys,
          )
        ? "consistent"
        : "contradicted",
  };
}

/**
 * The citation `rules` are entitled to: {@link DEFAULT_LINKAGE_RULE_SET}'s
 * reference where the rules were drawn from that set, and `undefined` where they
 * were not -- edited, reordered, authored from scratch, or declaring no key. The
 * single place a builder that lets an operator EDIT seeded rules decides whether
 * the result may still cite the set it started from.
 *
 * A citation asserts that the keys came from the named set, so rules declaring
 * none carry no provenance to claim: they are drawn from every set vacuously,
 * and the predicate alone would hand them the built-in citation over whatever
 * field declarations outlived their keys. A builder reaches that state as an
 * intermediate (disabling every key in the web editor), so the keyless case is
 * excluded here rather than left to the downstream rejection.
 */
export function linkageRuleSetReferenceFor(
  rules: Pick<LinkageTerms, "linkageFields" | "linkageKeys">,
): LinkageRuleSetReference | undefined {
  if (rules.linkageKeys.length === 0) return undefined;
  return isDrawnFromLinkageRuleSet(DEFAULT_LINKAGE_RULE_SET, rules)
    ? DEFAULT_LINKAGE_RULE_SET.reference
    : undefined;
}

/**
 * Returns a {@link LinkageTerms} drawn from `ruleSet`, citing it: the terms a
 * party runs when it authors none of its own.
 *
 * When metadata are provided, only linkage key templates whose elements can be
 * satisfied by the present columns are included. If no metadata is provided,
 * all templates are included as a fallback. Either way the emitted keys are a
 * SUBSET of the set, never an addition to it: what the input supports narrows
 * the set, and nothing widens it -- which is what makes the emitted citation
 * honest, an upper bound on what was tried rather than a claim that every key
 * ran.
 *
 * Narrowed all the way to no key, the citation goes with the keys: it asserts
 * where the keys came from, so a derivation emitting none has no provenance to
 * claim -- the same exclusion {@link linkageRuleSetReferenceFor} makes.
 */
export function linkageTermsFromRuleSet(
  ruleSet: BuiltInLinkageRuleSet,
  identity: string | undefined,
  metadata?: Metadata,
): LinkageTerms {
  let linkageKeys: LinkageKey[];
  if (metadata !== undefined && metadata.length > 0) {
    // Only `role: linkage` columns supply a matchable type: a key kept because a
    // non-linkage column (identifier/payload/ignored) is the only instance of its
    // type would bind nothing at exchange time (resolveFieldColumns binds only a
    // `role: linkage` column, so the field would resolve to nothing) -- drop the
    // key here instead of building an unusable one.
    const availableTypes = new Set(
      metadata.filter((m) => m.role === "linkage").map((m) => m.type),
    );
    linkageKeys = ruleSet.linkageKeys.filter((key) =>
      key.elements.every((el) => availableTypes.has(el.field as SemanticType)),
    );
  } else {
    linkageKeys = [...ruleSet.linkageKeys];
  }

  const referencedFields = referencedLinkageFieldNames(linkageKeys);
  const linkageFields = ruleSet.linkageFields.filter((f) =>
    referencedFields.has(f.name),
  );

  return {
    version: "1.0.0",
    // Omitted rather than emptied when the caller has no label: `identity` is
    // optional in the terms, and a party that supplied none sends none.
    ...(identity !== undefined && { identity }),
    date: new Date().toISOString().substring(0, 10),
    algorithm: "psi",
    linkageStrategy: "cascade",
    output: {
      expectsOutput: true,
      shareWithPartner: true,
    },
    deduplicate: false,
    linkageFields,
    linkageKeys,
    ...(linkageKeys.length > 0 && { linkageRuleSet: ruleSet.reference }),
  };
}

/**
 * Returns a default {@link LinkageTerms} suitable for quick exchanges when no
 * linkage terms are specified explicitly: {@link linkageTermsFromRuleSet} over
 * {@link DEFAULT_LINKAGE_RULE_SET}, the built-in set every path that authors
 * nothing selects.
 */
export function getDefaultLinkageTerms(
  identity: string | undefined,
  metadata?: Metadata,
): LinkageTerms {
  return linkageTermsFromRuleSet(DEFAULT_LINKAGE_RULE_SET, identity, metadata);
}

/**
 * The matchable semantic types no key of {@link DEFAULT_LINKAGE_KEY_SET_NAME}
 * references, so a party whose file carries one of these columns gets no
 * matching value from the built-in rules.
 *
 * They are offered as an addition a party OPTS IN to
 * ({@link optInLinkageKeys}), never folded into the built-in set: that set is
 * frozen, and its recorded validation covers the keys it declares, which say
 * nothing about how these types match. Their standardization pipelines are
 * settled ({@link getDefaultStandardization}) even though no built-in key uses
 * them, so opting one in cleans the column exactly as a partner cleans its own.
 *
 * Written out rather than derived from the difference between the semantic types
 * and the built-in fields', so each type is offered because it was decided on
 * rather than because it arrived in the enum. The difference is asserted equal to
 * this list by test, so a matchable type added without that decision fails there
 * instead of going silently unoffered.
 */
export const OPT_IN_LINKAGE_FIELD_TYPES = [
  "phone_number",
  "email_address",
  "zip_code",
] as const satisfies ReadonlyArray<LinkageField["type"]>;

/** A semantic type {@link OPT_IN_LINKAGE_FIELD_TYPES} offers. */
type OptInLinkageFieldType = (typeof OPT_IN_LINKAGE_FIELD_TYPES)[number];

/**
 * The one linkage key each {@link OPT_IN_LINKAGE_FIELD_TYPES} type is offered as:
 * the type's own field together with the backbone the published evidence pairs it
 * with, each element naming a field {@link authoredLinkageFields} declares for a
 * column of that type. The shapes and their cascade placement are derived in
 * `docs/notes/linkage-rule-grounding.md`.
 *
 * Compound and never the type alone, for two reasons that point the same way. A
 * key built from a single identifier is a membership oracle: a party holding a
 * candidate value learns from the result whether its holder is in the other
 * party's file, which is the differencing exposure `docs/SECURITY_DESIGN.md`
 * scopes the privacy guarantee against. And a contact value is a SHARED value in
 * program-application data -- one phone number or one email address carries across
 * a household and across the people an organization files for -- so a key over one
 * alone reports different people as the same person.
 *
 * One key per type is the whole offer. Any other combination is a rule with
 * precision and recall consequences nothing here has settled, which is what the
 * expert key editor is for.
 *
 * Frozen through every level, for the reason {@link DEFAULT_LINKAGE_RULE_SET} is:
 * {@link optInLinkageKeys} hands these objects out BY REFERENCE, into an editor
 * draft and from there into the terms a party generates, so a single in-place
 * edit of a name or an element would redefine what is offered for the rest of the
 * process. It would also desync {@link OPT_IN_LINKAGE_KEY_ENCODINGS}, encoded once
 * at load: {@link isOptInLinkageKey} would then answer `false` for the very key
 * the editor is holding, dropping the outside-the-default-set badge and the
 * departure guidance from a key that is still an addition to the built-in set.
 */
const OPT_IN_LINKAGE_KEYS: Record<OptInLinkageFieldType, LinkageKey> =
  frozenThroughContents({
    phone_number: {
      name: "LN + FN + DOB + PHONE",
      elements: [
        { field: "last_name" },
        { field: "first_name" },
        { field: "date_of_birth" },
        { field: "phone_number" },
      ],
    },
    email_address: {
      name: "FN + EMAIL",
      elements: [{ field: "first_name" }, { field: "email_address" }],
    },
    zip_code: {
      name: "LN + FN + DOB + ZIP",
      elements: [
        { field: "last_name" },
        { field: "first_name" },
        { field: "date_of_birth" },
        { field: "zip_code" },
      ],
    },
  });

/**
 * The opt-in keys `metadata` can supply, in {@link OPT_IN_LINKAGE_FIELD_TYPES}
 * order -- one per type whose key EVERY element the columns supply, and none for
 * a key any element goes unsupplied for. Declaration order rather than column
 * order, so what an operator is offered does not shuffle with how their file
 * happens to be laid out.
 *
 * The same satisfiability rule {@link linkageTermsFromRuleSet} narrows the
 * built-in keys by, over the whole compound for the same reason it runs over the
 * whole of a built-in key: only a `role: linkage` column supplies a matchable
 * type, so an element resting on an identifier, payload, ignored, or absent
 * column would bind nothing at exchange time. A file carrying a phone number but
 * no date of birth is therefore offered no phone key rather than a thinner one.
 *
 * These are OFFERS, not terms: nothing here enables one, and a caller that
 * enables none emits exactly what it emitted before this existed. Enabling one
 * takes the emitted rules out of {@link DEFAULT_LINKAGE_RULE_SET} -- they are no
 * longer drawn from it -- so the terms carry no citation of the built-in set,
 * which is the honest reading of what a party that added a key of its own is
 * running.
 */
export function optInLinkageKeys(metadata: Metadata): Array<LinkageKey> {
  const available = new Set<SemanticType>(
    metadata.filter((column) => column.role === "linkage").map((c) => c.type),
  );
  return OPT_IN_LINKAGE_FIELD_TYPES.map(
    (type) => OPT_IN_LINKAGE_KEYS[type],
  ).filter((key) =>
    key.elements.every((element) =>
      available.has(element.field as SemanticType),
    ),
  );
}

/** The offered keys in the byte form {@link isOptInLinkageKey} compares against,
 * encoded once: the answer is asked per list row per render, and these are fixed
 * for the process. */
const OPT_IN_LINKAGE_KEY_ENCODINGS: ReadonlySet<string> = new Set(
  Object.values(OPT_IN_LINKAGE_KEYS)
    .map(encodeForComparison)
    .filter((encoded) => encoded !== null),
);

/**
 * Whether `key` is one of the keys {@link optInLinkageKeys} offers, so a surface
 * can tell an offered addition apart from a built-in key beside it in the same
 * list without holding a flag of its own.
 *
 * Compared through the canonical encoding, the equality the two parties' terms
 * are compared under, so a key that merely borrows an offered key's NAME -- one
 * an expert editor renamed, or an imported document declares -- is not mistaken
 * for the offer. A value outside the canonical domain cannot be compared and
 * answers `false` rather than throwing: the offered keys carry no such value.
 */
export function isOptInLinkageKey(key: LinkageKey): boolean {
  const encoded = encodeForComparison(key);
  return encoded !== null && OPT_IN_LINKAGE_KEY_ENCODINGS.has(encoded);
}

/**
 * Whether a semantic type can be a linkage field's type. `identifier` and `other`
 * are the non-matchable types -- a {@link LinkageField} is never one of them -- so
 * they are excluded. Written as the negation of those two literals (rather than an
 * allowlist) so that adding a non-matchable semantic type without excluding it here
 * fails to narrow to `LinkageField["type"]` and breaks the build, rather than
 * silently declaring an invalid field.
 */
function isLinkageFieldType(type: SemanticType): type is LinkageField["type"] {
  return type !== "identifier" && type !== "other";
}

/**
 * The linkage fields a `(metadata, standardization)` pair declares: the single
 * source the web invite editors derive both their pickable field list and the
 * emitted `linkageFields` from, replacing the
 * `getDefaultLinkageTerms(metadata).linkageFields` derivation. That derivation
 * collapses to one field per semantic type, so it cannot express two fields of the
 * same type -- e.g. a maiden and a current name -- bound to different columns; this
 * can.
 *
 * Per present `role: linkage` semantic type in `metadata`:
 *
 * - When `standardization` carries one or more transformations whose `input`
 *   column has that type, one field is emitted per transformation: `name` is the
 *   transformation's `output`, `type` is the column's type, and `constraints` are
 *   that type's default constraints (a same-typed field is bounded like the default
 *   one). The distinct `output` names -- the standardization schema forbids a
 *   duplicate `output` -- are what let two same-typed fields coexist, and the
 *   explicit `input` each transformation carries is what binds them to different
 *   columns at exchange time (see {@link resolveFieldColumns}).
 * - Otherwise a single field is emitted for the type: the type's default field
 *   ({@link DEFAULT_LINKAGE_FIELDS}) when it has one, else a synthetic default named
 *   for the type (`name` and `type` both the semantic type, no constraints). The
 *   synthetic case is what lets a column of a matchable type the default keys do not
 *   use (`zip_code`, `phone_number`, `email_address`) be referenced as a linkage
 *   field with no authored cleaning -- it resolves to that column by type at exchange
 *   time. A metadata-only pair (no `standardization`) thus yields exactly one field
 *   per present matchable type, and for the default types alone is byte-identical to
 *   the default per-type field set, so the guided path is unchanged.
 *
 * A transformation whose `input` is a non-`linkage` (identifier/payload/ignored)
 * or absent column declares no field: matching participation requires
 * `role: linkage`, which wins over an explicit binding in
 * {@link resolveFieldColumns}, so the field would resolve to no column anyway.
 *
 * Field order follows {@link DEFAULT_LINKAGE_FIELDS}, with a default type's explicit
 * fields emitted in `standardization` order at that type's position; any
 * explicit-only type (one with no default field, e.g. `phone_number`) follows in
 * `standardization` order, then any present matchable type with no field yet (the
 * synthetic case) in metadata order. The returned set is the CANDIDATE fields keys
 * may reference; a caller that emits final terms filters it to the fields its
 * enabled keys reference (as `buildAdvancedTerms` does), which leaves the
 * no-`standardization` emission byte-identical to today for the default types. Pure.
 */
export function authoredLinkageFields(
  metadata: Metadata,
  standardization?: Standardization,
): LinkageField[] {
  const columnByName = new Map(metadata.map((column) => [column.name, column]));
  // Explicit transformations grouped by their input column's semantic type. A
  // transformation is skipped when its input column is absent, not `role: linkage`
  // (only a linkage column participates in matching -- the role wins over an
  // explicit binding, see resolveFieldColumns), or of a type that cannot be a
  // linkage field (`identifier` / `other` are not matchable), so none of these
  // declares a field.
  const explicitByType = new Map<
    LinkageField["type"],
    StandardizationTransformation[]
  >();
  for (const transformation of standardization ?? []) {
    const column = columnByName.get(transformation.input);
    if (column === undefined || column.role !== "linkage") continue;
    if (!isLinkageFieldType(column.type)) continue;
    const forType = explicitByType.get(column.type) ?? [];
    forType.push(transformation);
    explicitByType.set(column.type, forType);
  }

  const presentTypes = new Set(
    metadata.filter((column) => column.role === "linkage").map((c) => c.type),
  );

  const fields: LinkageField[] = [];
  const emittedTypes = new Set<SemanticType>();
  // Default-typed fields first, in DEFAULT_LINKAGE_FIELDS order, so a
  // no-standardization pair yields exactly the default per-type set.
  for (const def of DEFAULT_LINKAGE_FIELDS) {
    if (!presentTypes.has(def.type)) continue;
    emittedTypes.add(def.type);
    const explicit = explicitByType.get(def.type);
    if (explicit === undefined) {
      fields.push(def);
      continue;
    }
    for (const transformation of explicit)
      fields.push({
        name: transformation.output,
        type: def.type,
        ...(def.constraints !== undefined && { constraints: def.constraints }),
      });
  }
  // Explicit fields for a present type with no default field (e.g. phone_number,
  // email_address, zip_code): there are no default constraints to inherit.
  for (const [type, transformations] of explicitByType) {
    if (emittedTypes.has(type)) continue;
    emittedTypes.add(type);
    for (const transformation of transformations)
      fields.push({ name: transformation.output, type });
  }
  // A present matchable type with neither a default field nor any authored
  // transformation still declares one field: a synthetic default named for the
  // type, in metadata order. DEFAULT_LINKAGE_FIELDS covers only the types the
  // default keys use, so without this a column of another matchable type
  // (`zip_code`, `phone_number`, `email_address`) roled `linkage` would be invisible
  // to the key editor and unmatchable -- even though resolveFieldColumns binds such
  // a field to that column (identity transform) at exchange time. One field per type
  // (deduped via emittedTypes); a second column of the type is matched by authoring a
  // distinct transformation, the same way two same-typed default fields are split.
  for (const column of metadata) {
    if (column.role !== "linkage") continue;
    if (!isLinkageFieldType(column.type)) continue;
    if (emittedTypes.has(column.type)) continue;
    emittedTypes.add(column.type);
    fields.push({ name: column.type, type: column.type });
  }
  return fields;
}
