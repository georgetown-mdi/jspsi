import { ZodError } from "zod";
import { expect, test } from "vitest";

import {
  parseExchangeAgreement,
  safeParseExchangeAgreement,
} from "../src/exchangeAgreement";

// Minimal valid agreement used as a base for individual tests.
const base = {
  version: "1.0.0",
  identity: "Test Party",
  date: "2025-01-01",
  algorithm: "psi",
  output: { expectsOutput: true, shareWithPartner: false },
  deduplicate: false,
  linkageFields: [{ name: "ssn", semanticType: "ssn" }],
  linkageKeys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
};

// ─── Happy path ──────────────────────────────────────────────────────────────

test("parses a complete valid agreement", () => {
  const result = parseExchangeAgreement({
    version: "2.1.0",
    identity: "Jane Smith, Agency A, jsmith@agency-a.gov",
    date: "2025-06-01",
    algorithm: "psi-c",
    output: { expectsOutput: true, shareWithPartner: true },
    deduplicate: true,
    linkageFields: [
      {
        name: "ssn4",
        semanticType: "ssnLast4",
        constraints: { onlyValid: true, exclude: ["0000"] },
      },
      {
        name: "lastName",
        semanticType: "lastName",
        constraints: { affixesAllowed: false, allowedCharacters: "A-Z " },
      },
      { name: "dateOfBirth", semanticType: "dateOfBirth" },
      { name: "ssn", semanticType: "ssn" },
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
        elements: [{ field: "ssn", generateCombinations: "transpositions" }],
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
  const result = safeParseExchangeAgreement({
    ...base,
    deduplicate: true,
    output: { expectsOutput: true, shareWithPartner: false },
  });
  expect(result.success).toBe(true);
});

test("deduplicate: true with expectsOutput: false is invalid", () => {
  const result = safeParseExchangeAgreement({
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
  const result = safeParseExchangeAgreement({
    ...base,
    deduplicate: false,
    output: { expectsOutput: false, shareWithPartner: false },
  });
  expect(result.success).toBe(true);
});

// ─── allowedCharacters regex validation ──────────────────────────────────────

test("allowedCharacters accepts a valid character class", () => {
  const result = safeParseExchangeAgreement({
    ...base,
    linkageFields: [
      {
        name: "lastName",
        semanticType: "lastName",
        constraints: { allowedCharacters: "A-Z " },
      },
    ],
    linkageKeys: [{ name: "Last Name", elements: [{ field: "lastName" }] }],
  });
  expect(result.success).toBe(true);
});

test("allowedCharacters rejects an invalid character class", () => {
  const result = safeParseExchangeAgreement({
    ...base,
    linkageFields: [
      {
        name: "lastName",
        semanticType: "lastName",
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

test("parseExchangeAgreement throws ZodError on invalid input", () => {
  expect(() => parseExchangeAgreement({ version: "not-semver" })).toThrow(
    ZodError,
  );
});

test("safeParseExchangeAgreement returns success: false on invalid input", () => {
  const result = safeParseExchangeAgreement({ version: "not-semver" });
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
  const result = safeParseExchangeAgreement({ ...base, version });
  expect(result.success).toBe(valid);
});

// ─── uniqueness constraints ───────────────────────────────────────────────────

test("duplicate linkage field names are rejected", () => {
  const result = safeParseExchangeAgreement({
    ...base,
    linkageFields: [
      { name: "ssn", semanticType: "ssn" },
      { name: "ssn", semanticType: "ssn" },
    ],
  });
  expect(result.success).toBe(false);
  if (result.success) return;
  expect(result.error.issues[0].path).toContain("linkageFields");
});

test("duplicate linkage key names are rejected", () => {
  const result = safeParseExchangeAgreement({
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
  const result = safeParseExchangeAgreement({
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
  const result = safeParseExchangeAgreement({
    ...base,
    linkageFields: [
      { name: "firstName", semanticType: "firstName" },
      { name: "lastName", semanticType: "lastName" },
      { name: "dateOfBirth", semanticType: "dateOfBirth" },
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
  const result = safeParseExchangeAgreement({ ...base, linkageFields: [] });
  expect(result.success).toBe(false);
});

test("empty linkageKeys array is rejected", () => {
  const result = safeParseExchangeAgreement({ ...base, linkageKeys: [] });
  expect(result.success).toBe(false);
});

test("linkage key with empty elements array is rejected", () => {
  const result = safeParseExchangeAgreement({
    ...base,
    linkageKeys: [{ name: "Empty", elements: [] }],
  });
  expect(result.success).toBe(false);
});

// ─── linkageField semanticType discriminated union ────────────────────────────

test("unknown linkage field semanticType is rejected", () => {
  const result = safeParseExchangeAgreement({
    ...base,
    linkageFields: [{ name: "bad", semanticType: "favoriteColor" }],
  });
  expect(result.success).toBe(false);
});

// ─── camelizeKeys integration ────────────────────────────────────────────────

test("parses snake_case keys from disk", () => {
  // The spec uses snake_case keys (e.g. linkage_fields, expects_output);
  // camelizeKeys converts them before validation. SemanticType values and
  // field name values are not transformed since camelizeKeys only touches keys.
  const result = parseExchangeAgreement({
    version: "1.0.0",
    identity: "Test Party",
    date: "2025-01-01",
    algorithm: "psi",
    output: { expects_output: true, share_with_partner: false },
    deduplicate: false,
    linkage_fields: [
      {
        name: "ssn",
        semantic_type: "ssn",
        constraints: { only_valid: true, exclude: ["123456789"] },
      },
      {
        name: "lastName",
        semantic_type: "lastName",
        constraints: { affixes_allowed: false },
      },
    ],
    linkage_keys: [
      {
        name: "SSN + Last Name",
        elements: [
          { field: "ssn", generate_combinations: "deletions" },
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
  expect(result.linkageFields[0].semanticType).toBe("ssn");
  expect(result.linkageKeys[0].elements[0].field).toBe("ssn");
  expect(result.linkageKeys[0].elements[1].transform?.[0].function).toBe(
    "substring",
  );
  expect(result.legalAgreement?.expirationDate).toBe("2027-01-01");
});
