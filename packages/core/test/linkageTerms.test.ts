import { ZodError } from "zod";
import { expect, test } from "vitest";

import {
  parseLinkageTerms,
  safeParseLinkageTerms,
  validateCompatibility,
} from "../src/config/linkageTerms";
import type { LinkageTerms } from "../src/config/linkageTerms";

// Minimal valid set of terms used as a base for individual tests.
const base = {
  version: "1.0.0",
  identity: "Test Party",
  date: "2025-01-01",
  algorithm: "psi",
  output: { expectsOutput: true, shareWithPartner: false },
  deduplicate: false,
  linkageFields: [{ name: "ssn", type: "ssn" }],
  linkageKeys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
};

// ─── Happy path ──────────────────────────────────────────────────────────────

test("parses a complete valid set of terms", () => {
  const result = parseLinkageTerms({
    version: "2.1.0",
    identity: "Jane Smith, Agency A, jsmith@agency-a.gov",
    date: "2025-06-01",
    algorithm: "psi-c",
    output: { expectsOutput: true, shareWithPartner: true },
    deduplicate: true,
    linkageFields: [
      {
        name: "ssn4",
        type: "ssn4",
        constraints: { onlyValid: true, exclude: ["0000"] },
      },
      {
        name: "lastName",
        type: "lastName",
        constraints: { affixesAllowed: false, allowedCharacters: "A-Z " },
      },
      { name: "dateOfBirth", type: "dateOfBirth" },
      { name: "ssn", type: "ssn" },
    ],
    linkageKeys: [
      {
        name: "SSN4 + Last Name + DOB",
        elements: [
          { field: "ssn4" },
          { field: "lastName" },
          { field: "dateOfBirth" },
        ],
        swap: ["firstName", "lastName"],
      },
      {
        name: "SSN, transpositions",
        elements: [
          { field: "ssn", generateFuzzyComparisons: "transpositions" },
        ],
      },
    ],
    payload: {
      send: [{ name: "enrollment_date", description: "Date of enrollment" }],
      receive: [{ name: "case_id" }],
    },
    legalAgreement: {
      reference: "MOU-2025-0042",
      expirationDate: "2027-12-31",
    },
  });

  expect(result.algorithm).toBe("psi-c");
  expect(result.linkageFields).toHaveLength(4);
  expect(result.linkageKeys).toHaveLength(2);
  expect(result.legalAgreement?.reference).toBe("MOU-2025-0042");
  expect(result.payload?.send).toHaveLength(1);
});

// ─── Cross-field constraint: deduplicate → expectsOutput ─────────────────────

test("deduplicate: true with expectsOutput: true is valid", () => {
  const result = safeParseLinkageTerms({
    ...base,
    deduplicate: true,
    output: { expectsOutput: true, shareWithPartner: false },
  });
  expect(result.success).toBe(true);
});

test("deduplicate: true with expectsOutput: false is invalid", () => {
  const result = safeParseLinkageTerms({
    ...base,
    deduplicate: true,
    output: { expectsOutput: false, shareWithPartner: false },
  });
  expect(result.success).toBe(false);
  if (result.success) return;
  const paths = result.error.issues.map((i) => i.path.join("."));
  expect(paths).toContain("output.expectsOutput");
});

test("deduplicate: false with expectsOutput: false is valid", () => {
  const result = safeParseLinkageTerms({
    ...base,
    deduplicate: false,
    output: { expectsOutput: false, shareWithPartner: false },
  });
  expect(result.success).toBe(true);
});

// ─── allowedCharacters regex validation ──────────────────────────────────────

test("allowedCharacters accepts a valid character class", () => {
  const result = safeParseLinkageTerms({
    ...base,
    linkageFields: [
      {
        name: "lastName",
        type: "lastName",
        constraints: { allowedCharacters: "A-Z " },
      },
    ],
    linkageKeys: [{ name: "Last Name", elements: [{ field: "lastName" }] }],
  });
  expect(result.success).toBe(true);
});

test("allowedCharacters rejects an invalid character class", () => {
  const result = safeParseLinkageTerms({
    ...base,
    linkageFields: [
      {
        name: "lastName",
        type: "lastName",
        // "z-a" is a reversed range and throws when interpolated into /[z-a]/
        constraints: { allowedCharacters: "z-a" },
      },
    ],
    linkageKeys: [{ name: "Last Name", elements: [{ field: "lastName" }] }],
  });
  expect(result.success).toBe(false);
  if (result.success) return;
  expect(result.error.issues[0].message).toMatch(/character class/);
});

// ─── parse vs safeParse ──────────────────────────────────────────────────────

test("parseLinkageTerms throws ZodError on invalid input", () => {
  expect(() => parseLinkageTerms({ version: "not-semver" })).toThrow(ZodError);
});

test("safeParseLinkageTerms returns success: false on invalid input", () => {
  const result = safeParseLinkageTerms({ version: "not-semver" });
  expect(result.success).toBe(false);
});

// ─── version semver format ───────────────────────────────────────────────────

test.each([
  ["1.0", false],
  ["v1.0.0", false],
  ["1.0.0-beta", false],
  ["1.0.0", true],
  ["10.20.300", true],
])('version "%s" is %s', (version, valid) => {
  const result = safeParseLinkageTerms({ ...base, version });
  expect(result.success).toBe(valid);
});

// ─── uniqueness constraints ───────────────────────────────────────────────────

test("duplicate linkage field names are rejected", () => {
  const result = safeParseLinkageTerms({
    ...base,
    linkageFields: [
      { name: "ssn", type: "ssn" },
      { name: "ssn", type: "ssn" },
    ],
  });
  expect(result.success).toBe(false);
  if (result.success) return;
  expect(result.error.issues[0].path).toContain("linkageFields");
});

test("duplicate linkage key names are rejected", () => {
  const result = safeParseLinkageTerms({
    ...base,
    linkageKeys: [
      { name: "SSN", elements: [{ field: "ssn" }] },
      { name: "SSN", elements: [{ field: "ssn" }] },
    ],
  });
  expect(result.success).toBe(false);
  if (result.success) return;
  expect(result.error.issues[0].path).toContain("linkageKeys");
});

test("duplicate element field references within a key are rejected", () => {
  const result = safeParseLinkageTerms({
    ...base,
    linkageKeys: [
      {
        name: "Doubled SSN",
        elements: [{ field: "ssn" }, { field: "ssn" }],
      },
    ],
  });
  expect(result.success).toBe(false);
  if (result.success) return;
  expect(result.error.issues[0].path).toContain("linkageKeys");
});

test("same field used twice with distinct names is valid", () => {
  const result = safeParseLinkageTerms({
    ...base,
    linkageFields: [
      { name: "firstName", type: "firstName" },
      { name: "lastName", type: "lastName" },
      { name: "dateOfBirth", type: "dateOfBirth" },
    ],
    linkageKeys: [
      {
        name: "Swapped Names + DOB",
        elements: [
          { field: "firstName", name: "name1" },
          { field: "lastName", name: "name2" },
          { field: "dateOfBirth" },
        ],
        swap: ["name1", "name2"],
      },
    ],
  });
  expect(result.success).toBe(true);
});

// ─── linkageFields and linkageKeys constraints ────────────────────────────────

test("empty linkageFields array is rejected", () => {
  const result = safeParseLinkageTerms({ ...base, linkageFields: [] });
  expect(result.success).toBe(false);
});

test("empty linkageKeys array is rejected", () => {
  const result = safeParseLinkageTerms({ ...base, linkageKeys: [] });
  expect(result.success).toBe(false);
});

test("linkage key with empty elements array is rejected", () => {
  const result = safeParseLinkageTerms({
    ...base,
    linkageKeys: [{ name: "Empty", elements: [] }],
  });
  expect(result.success).toBe(false);
});

// ─── linkageField type discriminated union ────────────────────────────

test("unknown linkage field type is rejected", () => {
  const result = safeParseLinkageTerms({
    ...base,
    linkageFields: [{ name: "bad", type: "favoriteColor" }],
  });
  expect(result.success).toBe(false);
});

// ─── camelizeKeys integration ────────────────────────────────────────────────

test("parses snake_case keys from disk", () => {
  // The spec uses snake_case keys (e.g. linkage_fields, expects_output);
  // camelizeKeys converts them before validation. SemanticType values and
  // field name values are not transformed since camelizeKeys only touches keys.
  const result = parseLinkageTerms({
    version: "1.0.0",
    identity: "Test Party",
    date: "2025-01-01",
    algorithm: "psi",
    output: { expects_output: true, share_with_partner: false },
    deduplicate: false,
    linkage_fields: [
      {
        name: "ssn",
        type: "ssn",
        constraints: { only_valid: true, exclude: ["123456789"] },
      },
      {
        name: "lastName",
        type: "lastName",
        constraints: { affixes_allowed: false },
      },
    ],
    linkage_keys: [
      {
        name: "SSN + Last Name",
        elements: [
          { field: "ssn", generate_fuzzy_comparisons: "editDistances" },
          {
            field: "lastName",
            transform: [
              { function: "substring", params: { start: 0, length: 10 } },
            ],
          },
        ],
      },
    ],
    legal_agreement: {
      reference: "MOU-2025-0001",
      expiration_date: "2027-01-01",
    },
  });

  expect(result.output.expectsOutput).toBe(true);
  expect(result.output.shareWithPartner).toBe(false);
  expect(result.linkageFields[0].type).toBe("ssn");
  expect(result.linkageKeys[0].elements[0].field).toBe("ssn");
  expect(result.linkageKeys[0].elements[1].transform?.[0].function).toBe(
    "substring",
  );
  expect(result.legalAgreement?.expirationDate).toBe("2027-01-01");
});

test("transform params keys are normalized (params are not opaque)", () => {
  // Unlike connection.provider_options, a transform `params` block is psilink's
  // own function vocabulary and follows the snake_case-YAML -> camelCase-TS
  // convention: the standardizing-function library reads camelCase param keys.
  const result = parseLinkageTerms({
    version: "1.0.0",
    identity: "Test Party",
    date: "2025-01-01",
    algorithm: "psi",
    output: { expects_output: true, share_with_partner: false },
    deduplicate: false,
    linkage_fields: [{ name: "dob", type: "dateOfBirth" }],
    linkage_keys: [
      {
        name: "DOB",
        elements: [
          {
            field: "dob",
            transform: [
              {
                function: "parse_date",
                params: {
                  input_format: "MM/DD/YYYY",
                  output_format: "YYYYMMDD",
                },
              },
            ],
          },
        ],
      },
    ],
  });
  expect(result.linkageKeys[0].elements[0].transform?.[0].params).toEqual({
    inputFormat: "MM/DD/YYYY",
    outputFormat: "YYYYMMDD",
  });
});

// ─── validateCompatibility ───────────────────────────────────────────────────

const sharedFields: LinkageTerms["linkageFields"] = [
  { name: "ssn", type: "ssn" },
];
const sharedKeys: LinkageTerms["linkageKeys"] = [
  { name: "SSN", elements: [{ field: "ssn" }] },
];

const termsA: LinkageTerms = {
  version: "1.0.0",
  identity: "Party A",
  date: "2025-01-01",
  algorithm: "psi",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: sharedFields,
  linkageKeys: sharedKeys,
};

const termsB: LinkageTerms = {
  ...termsA,
  identity: "Party B",
};

test("compatible terms produce no errors or warnings", () => {
  const { errors, warnings } = validateCompatibility(termsA, termsB);
  expect(errors).toHaveLength(0);
  expect(warnings).toHaveLength(0);
});

test("date mismatch produces a warning, not an error", () => {
  const { errors, warnings } = validateCompatibility(termsA, {
    ...termsB,
    date: "2025-06-01",
  });
  expect(errors).toHaveLength(0);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toMatch(/date mismatch/);
});

test("version mismatch is an error", () => {
  const { errors } = validateCompatibility(termsA, {
    ...termsB,
    version: "2.0.0",
  });
  expect(errors.some((e) => e.includes("version mismatch"))).toBe(true);
});

test("algorithm mismatch is an error", () => {
  const { errors } = validateCompatibility(termsA, {
    ...termsB,
    algorithm: "psi-c",
  });
  expect(errors.some((e) => e.includes("algorithm mismatch"))).toBe(true);
});

test("neither party expects output is an error", () => {
  const noOutput = { expectsOutput: false, shareWithPartner: false };
  const { errors } = validateCompatibility(
    { ...termsA, output: noOutput },
    { ...termsB, output: noOutput },
  );
  expect(errors.some((e) => e.includes("neither party expects output"))).toBe(
    true,
  );
});

test("output cross-check: I will share but partner does not expect is an error", () => {
  const { errors } = validateCompatibility(
    { ...termsA, output: { expectsOutput: false, shareWithPartner: true } },
    { ...termsB, output: { expectsOutput: false, shareWithPartner: false } },
  );
  expect(errors.some((e) => e.includes("output mismatch"))).toBe(true);
});

test("output cross-check: I expect but partner will not share is an error", () => {
  const { errors } = validateCompatibility(
    { ...termsA, output: { expectsOutput: true, shareWithPartner: false } },
    { ...termsB, output: { expectsOutput: false, shareWithPartner: false } },
  );
  expect(errors.some((e) => e.includes("output mismatch"))).toBe(true);
});

test("linkage fields mismatch is an error", () => {
  const { errors } = validateCompatibility(termsA, {
    ...termsB,
    linkageFields: [{ name: "firstName", type: "firstName" }],
  });
  expect(errors.some((e) => e.includes("linkage fields do not match"))).toBe(
    true,
  );
});

test("linkage fields in different order are still compatible", () => {
  const { errors } = validateCompatibility(
    {
      ...termsA,
      linkageFields: [
        { name: "ssn", type: "ssn" },
        { name: "dob", type: "dateOfBirth" },
      ],
      linkageKeys: [
        { name: "SSN+DOB", elements: [{ field: "ssn" }, { field: "dob" }] },
      ],
    },
    {
      ...termsB,
      linkageFields: [
        { name: "dob", type: "dateOfBirth" },
        { name: "ssn", type: "ssn" },
      ],
      linkageKeys: [
        { name: "SSN+DOB", elements: [{ field: "ssn" }, { field: "dob" }] },
      ],
    },
  );
  expect(errors.filter((e) => e.includes("linkage fields"))).toHaveLength(0);
});

test("linkage keys mismatch is an error", () => {
  const { errors } = validateCompatibility(termsA, {
    ...termsB,
    linkageKeys: [{ name: "Different", elements: [{ field: "ssn" }] }],
  });
  expect(errors.some((e) => e.includes("linkage keys do not match"))).toBe(
    true,
  );
});

test("legal agreement present on one side only is an error", () => {
  const { errors } = validateCompatibility(
    {
      ...termsA,
      legalAgreement: { reference: "MOU-001", expirationDate: "2030-01-01" },
    },
    termsB,
  );
  expect(errors.some((e) => e.includes("legal agreement"))).toBe(true);
});

test("mismatched legal agreement reference is an error", () => {
  const { errors } = validateCompatibility(
    {
      ...termsA,
      legalAgreement: { reference: "MOU-001", expirationDate: "2030-01-01" },
    },
    {
      ...termsB,
      legalAgreement: { reference: "MOU-002", expirationDate: "2030-01-01" },
    },
  );
  expect(
    errors.some((e) => e.includes("legal agreement reference mismatch")),
  ).toBe(true);
});

test("mismatched legal agreement expiration date is an error", () => {
  const { errors } = validateCompatibility(
    {
      ...termsA,
      legalAgreement: { reference: "MOU-001", expirationDate: "2030-01-01" },
    },
    {
      ...termsB,
      legalAgreement: { reference: "MOU-001", expirationDate: "2031-06-30" },
    },
  );
  expect(
    errors.some((e) => e.includes("legal agreement expiration date mismatch")),
  ).toBe(true);
});

test("expired legal agreement is an error", () => {
  const { errors } = validateCompatibility(
    {
      ...termsA,
      legalAgreement: { reference: "MOU-001", expirationDate: "2020-01-01" },
    },
    {
      ...termsB,
      legalAgreement: { reference: "MOU-001", expirationDate: "2020-01-01" },
    },
  );
  expect(errors.some((e) => e.includes("expired"))).toBe(true);
});

test("payload send/receive mismatch is an error", () => {
  const { errors } = validateCompatibility(
    {
      ...termsA,
      payload: {
        send: [{ name: "enrollment_date" }],
        receive: [{ name: "case_id" }],
      },
    },
    {
      ...termsB,
      payload: {
        send: [{ name: "case_id" }],
        receive: [{ name: "wrong_column" }],
      },
    },
  );
  expect(errors.some((e) => e.includes("payload mismatch"))).toBe(true);
});

test("matching payload send/receive columns are compatible", () => {
  const { errors } = validateCompatibility(
    {
      ...termsA,
      payload: {
        send: [{ name: "enrollment_date" }],
        receive: [{ name: "case_id" }],
      },
    },
    {
      ...termsB,
      payload: {
        send: [{ name: "case_id" }],
        receive: [{ name: "enrollment_date" }],
      },
    },
  );
  expect(errors.filter((e) => e.includes("payload"))).toHaveLength(0);
});

// ─── deduplicate: no cross-party consistency check ───────────────────────────
// Each party independently decides whether to deduplicate its own inputs.
// The only related cross-party constraint is that a deduplicating party must
// receive output, which is already enforced by the output cross-check.

test("mismatched deduplicate values are not an error", () => {
  const { errors } = validateCompatibility(
    {
      ...termsA,
      deduplicate: true,
      output: { expectsOutput: true, shareWithPartner: true },
    },
    {
      ...termsB,
      deduplicate: false,
      output: { expectsOutput: true, shareWithPartner: true },
    },
  );
  expect(errors).toHaveLength(0);
});

test("both parties deduplicating is compatible when both expect output", () => {
  const { errors } = validateCompatibility(
    {
      ...termsA,
      deduplicate: true,
      output: { expectsOutput: true, shareWithPartner: true },
    },
    {
      ...termsB,
      deduplicate: true,
      output: { expectsOutput: true, shareWithPartner: true },
    },
  );
  expect(errors).toHaveLength(0);
});
