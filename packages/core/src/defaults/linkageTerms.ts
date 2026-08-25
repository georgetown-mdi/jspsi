import { referencedLinkageFieldNames } from "../config/linkageTerms";
import type {
  LinkageRuleSetReference,
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
 * set. Keys are listed from most precise (all PII) to least precise (name only).
 * The filtering logic below removes any key whose elements cannot be satisfied
 * by the columns present in the input.
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
  /** The set's linkage keys, in cascade order (most to least precise). */
  linkageKeys: ReadonlyArray<LinkageKey>;
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
 */
export const DEFAULT_LINKAGE_RULE_SET: BuiltInLinkageRuleSet = {
  reference: {
    fieldSet: {
      name: DEFAULT_LINKAGE_FIELD_SET_NAME,
      version: DEFAULT_LINKAGE_FIELD_SET_VERSION,
    },
    keySet: {
      name: DEFAULT_LINKAGE_KEY_SET_NAME,
      version: DEFAULT_LINKAGE_KEY_SET_VERSION,
    },
  },
  linkageFields: DEFAULT_LINKAGE_FIELDS,
  linkageKeys: DEFAULT_LINKAGE_KEYS,
};

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
 * from a set -- the web invite editors' path. It is not a check on a partner's
 * declared citation: a received document's reference is that party's statement
 * about its own rules, and nothing here re-decides it.
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
  const encode = (value: unknown): string | null => {
    try {
      return canonicalString(value);
    } catch {
      return null;
    }
  };
  // Each declaration is consumed on match, so a field the candidate repeats meets
  // no declaration the second time -- the same answer the key cursor gives a
  // repeated key, rather than a lookup that would accept the repeat.
  const declaredFields = new Map(
    ruleSet.linkageFields.map((field) => [field.name, encode(field)] as const),
  );
  for (const field of rules.linkageFields) {
    const declared = declaredFields.get(field.name);
    if (declared === undefined || declared === null) return false;
    if (encode(field) !== declared) return false;
    declaredFields.delete(field.name);
  }
  // Walk the set's keys and the candidate's together: each candidate key must
  // meet the next set key that matches it, so a key the set does not declare, a
  // repeated key, and a pair in the wrong cascade order all run the cursor off
  // the end.
  const declaredKeys = ruleSet.linkageKeys.map(encode);
  let cursor = 0;
  for (const key of rules.linkageKeys) {
    const encoded = encode(key);
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
 * The citation `rules` are entitled to: {@link DEFAULT_LINKAGE_RULE_SET}'s
 * reference where the rules were drawn from that set, and `undefined` where they
 * were not -- edited, reordered, authored from scratch, or empty. The single
 * place a builder that lets an operator EDIT seeded rules decides whether the
 * result may still cite the set it started from.
 *
 * Rules declaring no key and no field are drawn from every set vacuously, so the
 * predicate alone would hand an empty document the built-in citation -- a
 * provenance claim over rules it does not carry. A builder reaches that state as
 * an intermediate (disabling every key in the web editor), so the empty case is
 * excluded here rather than left to the downstream rejection.
 */
export function linkageRuleSetReferenceFor(
  rules: Pick<LinkageTerms, "linkageFields" | "linkageKeys">,
): LinkageRuleSetReference | undefined {
  if (rules.linkageKeys.length === 0 && rules.linkageFields.length === 0)
    return undefined;
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
 */
export function linkageTermsFromRuleSet(
  ruleSet: BuiltInLinkageRuleSet,
  identity: string,
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
    identity,
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
    linkageRuleSet: ruleSet.reference,
  };
}

/**
 * Returns a default {@link LinkageTerms} suitable for quick exchanges when no
 * linkage terms are specified explicitly: {@link linkageTermsFromRuleSet} over
 * {@link DEFAULT_LINKAGE_RULE_SET}, the built-in set every path that authors
 * nothing selects.
 */
export function getDefaultLinkageTerms(
  identity: string,
  metadata?: Metadata,
): LinkageTerms {
  return linkageTermsFromRuleSet(DEFAULT_LINKAGE_RULE_SET, identity, metadata);
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
