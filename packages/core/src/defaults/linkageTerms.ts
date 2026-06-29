import { referencedLinkageFieldNames } from "../config/linkageTerms";
import type {
  LinkageTerms,
  LinkageField,
  LinkageKey,
} from "../config/linkageTerms";
import type { Metadata } from "../config/metadata";
import type {
  Standardization,
  StandardizationTransformation,
} from "../config/standardization";
import type { SemanticType } from "../types";

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
 * Template linkage key combinations for the default agreement. Keys are listed
 * from most precise (all PII) to least precise (name only). The filtering
 * logic below removes any key whose elements cannot be satisfied by the
 * columns present in the input.
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
 * Returns a default {@link LinkageTerms} suitable for quick exchanges when no
 * linkage terms are specified explicitly.
 *
 * When metadata are provided, only linkage key templates whose elements can be
 * satisfied by the present columns are included. If no metadata is provided,
 * all templates are included as a fallback.
 */
export function getDefaultLinkageTerms(
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
    linkageKeys = DEFAULT_LINKAGE_KEYS.filter((key) =>
      key.elements.every((el) => availableTypes.has(el.field as SemanticType)),
    );
  } else {
    linkageKeys = [...DEFAULT_LINKAGE_KEYS];
  }

  const referencedFields = referencedLinkageFieldNames(linkageKeys);
  const linkageFields = DEFAULT_LINKAGE_FIELDS.filter((f) =>
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
  };
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
