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
  linkageKeys: [{ name: "SSN", elements: [{ semanticType: "ssn" }] }],
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
    linkageKeys: [
      {
        name: "SSN4 + Last Name + DOB",
        elements: [
          {
            semanticType: "ssnLast4",
            constraints: { ssaValid: true, exclude: ["0000"] },
          },
          {
            semanticType: "lastName",
            constraints: {
              maxLength: 10,
              affixesAllowed: false,
              allowedCharacters: "A-Z ",
            },
          },
          {
            semanticType: "dateOfBirth",
            constraints: { exclude: ["00000000"] },
          },
        ],
        swap: ["firstName", "lastName"],
      },
      {
        name: "SSN, transpositions",
        elements: [
          {
            semanticType: "ssn",
            generateCombinations: "transpositions",
            constraints: {
              ssaValid: true,
              exclude: ["123456789", "111111111"],
            },
          },
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
    linkageKeys: [
      {
        name: "Last Name",
        elements: [
          {
            semanticType: "lastName",
            constraints: { allowedCharacters: "A-Z " },
          },
        ],
      },
    ],
  });
  expect(result.success).toBe(true);
});

test("allowedCharacters rejects an invalid character class", () => {
  const result = safeParseExchangeAgreement({
    ...base,
    linkageKeys: [
      {
        name: "Last Name",
        // "z-a" is a reversed range and throws when interpolated into /[z-a]/
        elements: [
          {
            semanticType: "lastName",
            constraints: { allowedCharacters: "z-a" },
          },
        ],
      },
    ],
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

// ─── linkageKeys constraints ─────────────────────────────────────────────────

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

// ─── semanticType discriminated union ────────────────────────────────────────

test("unknown semanticType is rejected", () => {
  const result = safeParseExchangeAgreement({
    ...base,
    linkageKeys: [
      { name: "Bad Key", elements: [{ semanticType: "favoriteColor" }] },
    ],
  });
  expect(result.success).toBe(false);
});

// ─── maxLength positive integer constraint ───────────────────────────────────

test.each([0, -1, 1.5])("maxLength %i is rejected", (maxLength) => {
  const result = safeParseExchangeAgreement({
    ...base,
    linkageKeys: [
      {
        name: "Last Name",
        elements: [{ semanticType: "lastName", constraints: { maxLength } }],
      },
    ],
  });
  expect(result.success).toBe(false);
});

// ─── camelizeKeys integration ────────────────────────────────────────────────

test("parses snake_case keys from disk", () => {
  // The spec uses snake_case keys (e.g. linkage_keys, expects_output);
  // camelizeKeys converts them before validation. Semantic type values must
  // already be camelCase since camelizeKeys only transforms keys, not values.
  const result = parseExchangeAgreement({
    version: "1.0.0",
    identity: "Test Party",
    date: "2025-01-01",
    algorithm: "psi",
    output: { expects_output: true, share_with_partner: false },
    deduplicate: false,
    linkage_keys: [
      {
        name: "SSN + Last Name",
        elements: [
          {
            semantic_type: "ssn",
            generate_combinations: "deletions",
            constraints: { onlyValid: true, exclude: ["123456789"] },
          },
          {
            semantic_type: "lastName",
            constraints: { max_length: 10, affixes_allowed: false },
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
  expect(result.linkageKeys[0].elements[0].semanticType).toBe("ssn");
  expect(result.legalAgreement?.expirationDate).toBe("2027-01-01");
});
