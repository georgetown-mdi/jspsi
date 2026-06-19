import type {
  LinkageTerms,
  LinkageField,
  LinkageKey,
} from "../config/linkageTerms";
import type { Metadata } from "../config/metadata";
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
    const availableTypes = new Set(metadata.map((m) => m.type));
    linkageKeys = DEFAULT_LINKAGE_KEYS.filter((key) =>
      key.elements.every((el) => availableTypes.has(el.field as SemanticType)),
    );
  } else {
    linkageKeys = [...DEFAULT_LINKAGE_KEYS];
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
