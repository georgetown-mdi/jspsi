import type { LinkageTerms, LinkageField, LinkageKey } from "./linkageTerms";
import type { ColumnMetadata, ColumnType } from "./metadata";

const DEFAULT_LINKAGE_FIELDS: ReadonlyArray<LinkageField> = [
  {
    name: "ssn",
    semanticType: "ssn",
    constraints: {
      exclude: ["111111111", "123456789"],
      onlyValid: true,
    },
  },
  {
    name: "ssn4",
    semanticType: "ssnLast4",
    constraints: { onlyValid: true },
  },
  {
    name: "firstName",
    semanticType: "firstName",
    constraints: { affixesAllowed: false, allowedCharacters: "A-Z " },
  },
  {
    name: "lastName",
    semanticType: "lastName",
    constraints: { affixesAllowed: false, allowedCharacters: "A-Z " },
  },
  { name: "dateOfBirth", semanticType: "dateOfBirth" },
];

// Template linkage key combinations for the default agreement. Keys are listed
// from most precise (all PII) to least precise (name only). The filtering
// logic below removes any key whose elements cannot be satisfied by the
// columns present in the input.
//
// PLACEHOLDER: The hard-coded cascade in fixedLinkageKeys.ts also includes
// truncation variants (e.g. first 3 chars of lastName, year-month of DOB) and
// a first-4-digits-of-SSN key. Those are element transforms and cannot yet
// drive runtime behavior until data pipelines are implemented. Once pipelines
// exist, the template set should be expanded to cover the full cascade.
const TEMPLATE_KEYS: ReadonlyArray<LinkageKey> = [
  {
    name: "SSN + LN + DOB",
    elements: [
      { field: "ssn" },
      { field: "lastName" },
      { field: "dateOfBirth" },
    ],
  },
  {
    name: "SSN + LN + FN1",
    elements: [
      { field: "ssn" },
      { field: "lastName" },
      {
        field: "firstName",
        transform: [{ function: "substring", params: { start: 1, length: 1 } }],
      },
    ],
  },
  {
    name: "SSN + LN3 + FN1",
    elements: [
      { field: "ssn" },
      {
        field: "lastName",
        transform: [{ function: "substring", params: { start: 1, length: 3 } }],
      },
      {
        field: "firstName",
        transform: [{ function: "substring", params: { start: 1, length: 1 } }],
      },
    ],
  },
  {
    name: "SSN + LN4 + DOB",
    elements: [
      { field: "ssn" },
      {
        field: "lastName",
        transform: [{ function: "substring", params: { start: 1, length: 4 } }],
      },
      { field: "dateOfBirth" },
    ],
  },
  {
    name: "SSN + LN4 + YOB + MOB",
    elements: [
      { field: "ssn" },
      {
        field: "lastName",
        transform: [{ function: "substring", params: { start: 1, length: 4 } }],
      },
      {
        field: "dateOfBirth",
        transform: [{ function: "substring", params: { start: 1, length: 6 } }],
      },
    ],
  },
  {
    name: "SSN + LN3 + DOB",
    elements: [
      { field: "ssn" },
      {
        field: "lastName",
        transform: [{ function: "substring", params: { start: 1, length: 3 } }],
      },
      { field: "dateOfBirth" },
    ],
  },
  {
    name: "SSN + FN3 + DOB",
    elements: [
      { field: "ssn" },
      {
        field: "firstName",
        transform: [{ function: "substring", params: { start: 1, length: 3 } }],
      },
      { field: "dateOfBirth" },
    ],
  },
  {
    name: "SSN4 + LN + DOB",
    elements: [
      { field: "ssnLast4" },
      { field: "lastName" },
      { field: "dateOfBirth" },
    ],
  },
  {
    name: "SSN4 + LN4 + YOB + MOB",
    elements: [
      { field: "ssnLast4" },
      {
        field: "lastName",
        transform: [{ function: "substring", params: { start: 1, length: 4 } }],
      },
      {
        field: "dateOfBirth",
        transform: [{ function: "substring", params: { start: 1, length: 6 } }],
      },
    ],
  },
  {
    name: "LN + FN + DOB",
    elements: [
      { field: "lastName" },
      { field: "firstName" },
      { field: "dateOfBirth" },
    ],
  },
  {
    name: "swap(LN, FN) + DOB",
    elements: [
      { field: "lastName" },
      { field: "firstName" },
      { field: "dateOfBirth" },
    ],
    swap: ["lastName", "firstName"],
  },
  {
    name: "SSN + DOB + FN",
    elements: [
      { field: "ssn" },
      { field: "dateOfBirth" },
      { field: "firstName" },
    ],
  },
  {
    name: "SSN + YOB + MOB + FN3",
    elements: [
      { field: "ssn" },
      {
        field: "dateOfBirth",
        transform: [{ function: "substring", params: { start: 1, length: 6 } }],
      },
      {
        field: "firstName",
        transform: [{ function: "substring", params: { start: 1, length: 3 } }],
      },
    ],
  },
  {
    name: "SSN + FN + YOB + MOB", // this rule here doesn't make sense
    elements: [
      { field: "ssn" },
      { field: "firstName" },
      {
        field: "dateOfBirth",
        transform: [{ function: "substring", params: { start: 1, length: 6 } }],
      },
    ],
  },
];

/**
 * Returns a default {@link LinkageTerms} suitable for quick exchanges when no
 * linkage terms are specified explicitly.
 *
 * When `columns` are provided (the normalized header of the input CSV), only
 * linkage key templates whose elements can be satisfied by the present columns
 * are included. If no columns are provided, or if no template can be
 * satisfied, all templates are included as a fallback.
 *
 * Only the linkage fields referenced by the selected keys are included in the
 * returned linkage terms.
 */
export function getDefaultLinkageTerms(
  identity: string,
  metadata?: Array<ColumnMetadata>
): LinkageTerms {
  let linkageKeys: LinkageKey[];
  if (metadata !== undefined && metadata.length > 0) {
    const availableTypes = new Set(metadata.map((m) => m.type));
    const filtered = TEMPLATE_KEYS.filter((key) =>
      key.elements.every((el) => availableTypes.has(el.field as ColumnType)),
    );
    // Fall back to all templates if detection yields no usable keys, rather
    // than producing an invalid linkage terms. This can happen when column
    // names are unrecognized; the user will see a warning in the caller.
    linkageKeys = filtered.length > 0 ? filtered : [...TEMPLATE_KEYS];
  } else {
    linkageKeys = [...TEMPLATE_KEYS];
  }

  const referencedFields = new Set(
    linkageKeys.flatMap((key) => key.elements.map((el) => el.field)),
  );
  const linkageFields = DEFAULT_LINKAGE_FIELDS.filter((f) =>
    referencedFields.has(f.name),
  );

  return {
    version: "1.0.0",
    identity,
    date: new Date().toISOString().substring(0, 10),
    algorithm: "psi",
    output: {
      expectsOutput: true,
      shareWithPartner: true,
    },
    deduplicate: false,
    linkageFields,
    linkageKeys,
  };
}
