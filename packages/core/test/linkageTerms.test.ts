import { ZodError } from "zod";
import { expect, test } from "vitest";

import {
  parseLinkageTerms,
  safeParseLinkageTerms,
  validateCompatibility,
  MAX_NAME_LENGTH,
  MAX_TEXT_LENGTH,
  MAX_LINKAGE_ENTRIES,
  MAX_PARAMS_ENTRIES,
  MAX_EXCLUDE_ENTRIES,
  MAX_TRANSFORM_STEPS,
  MAX_KEY_ELEMENTS,
  MAX_PAYLOAD_ENTRIES,
} from "../src/config/linkageTerms";
import type { LinkageTerms } from "../src/config/linkageTerms";
import {
  DISPLAY_TRUNCATION_MARKER,
  DEFAULT_MAX_DISPLAY_LENGTH,
} from "../src/utils/sanitizeForDisplay";
import { describeDecodeError } from "../src/utils/describeDecodeError";
import { NestingDepthExceededError } from "../src/utils/camelizeKeys";

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
        type: "last_name",
        constraints: { affixesAllowed: false, allowedCharacters: "A-Z " },
      },
      { name: "dateOfBirth", type: "date_of_birth" },
      { name: "ssn", type: "ssn" },
      { name: "firstName", type: "first_name" },
    ],
    linkageKeys: [
      {
        name: "SSN4 + Last Name + First Name + DOB",
        elements: [
          { field: "ssn4" },
          { field: "lastName" },
          { field: "firstName" },
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
      purpose: "Audit and evaluation of the State tutoring program",
      expirationDate: "2027-12-31",
    },
  });

  expect(result.algorithm).toBe("psi-c");
  expect(result.linkageFields).toHaveLength(5);
  expect(result.linkageKeys).toHaveLength(2);
  expect(result.legalAgreement?.reference).toBe("MOU-2025-0042");
  expect(result.legalAgreement?.purpose).toBe(
    "Audit and evaluation of the State tutoring program",
  );
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

// ─── Cross-field constraint: expectsOutput: false → no payload.receive ───────

test("expectsOutput: false with a non-empty payload.receive is invalid", () => {
  // A party that receives no output cannot receive payload columns for matched
  // records it never gets; reject the incoherent configuration.
  const result = safeParseLinkageTerms({
    ...base,
    output: { expectsOutput: false, shareWithPartner: true },
    payload: { receive: [{ name: "case_id" }] },
  });
  expect(result.success).toBe(false);
  if (result.success) return;
  const paths = result.error.issues.map((i) => i.path.join("."));
  expect(paths).toContain("payload.receive");
});

test("expectsOutput: false with payload.send but no payload.receive is valid", () => {
  // A non-receiving party may still SEND payload (the receiver gets it); only
  // receiving payload is incoherent for it.
  const result = safeParseLinkageTerms({
    ...base,
    output: { expectsOutput: false, shareWithPartner: true },
    payload: { send: [{ name: "dose" }] },
  });
  expect(result.success).toBe(true);
});

test("expectsOutput: true with a non-empty payload.receive is valid", () => {
  const result = safeParseLinkageTerms({
    ...base,
    output: { expectsOutput: true, shareWithPartner: true },
    payload: { receive: [{ name: "case_id" }] },
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
        type: "last_name",
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
        type: "last_name",
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

test("a parse error does not echo a partner-supplied received value", () => {
  // The terms exchange relays a parse error through describeDecodeError, which
  // escapes each Zod issue-path segment via sanitizeForDisplay and relays the
  // schema-fixed message text. Two distinct mechanisms keep partner bytes out
  // of the operator-facing message; pin both.
  //
  // 1. For most codes (type mismatch, enum, semver/date format, too_small) the
  //    Zod message reports the expected type/options, never the received value,
  //    so even the RAW `error.message` carries no partner bytes.
  const evil = "\x1b[31mEVIL\x1b[0m‮";
  const enumSemver = safeParseLinkageTerms({
    ...base,
    algorithm: evil, // invalid enum
    version: evil, // invalid semver
  });
  expect(enumSemver.success).toBe(false);
  if (!enumSemver.success) {
    expect(enumSemver.error.message).not.toContain("\x1b");
    expect(enumSemver.error.message).not.toContain("‮");
  }

  // 2. The `invalid_key` code on the bounded `transform.params` record key
  //    (z.string().max(MAX_NAME_LENGTH)) DOES place the offending key VERBATIM
  //    in the issue PATH, which the raw `error.message` JSON-dumps -- so here
  //    the source escaping (describeDecodeError) is load-bearing, not the
  //    schema. The dangerous bytes lead the key (with padding past the bound
  //    after them) so escaping, not the display-length cap, is what neutralizes
  //    them. Assert on the rendered message the exchange actually relays.
  const evilKey = "\x1b[31m‮" + "x".repeat(MAX_NAME_LENGTH);
  const invalidKey = safeParseLinkageTerms({
    ...base,
    linkageKeys: [
      {
        name: "SSN",
        elements: [
          {
            field: "ssn",
            transform: [{ function: "trim", params: { [evilKey]: 1 } }],
          },
        ],
      },
    ],
  });
  expect(invalidKey.success).toBe(false);
  if (!invalidKey.success) {
    // The raw dump leaks the bidi override -- this is exactly the gap the
    // source escaping closes. (The ESC byte is JSON-escaped by the dump, but a
    // bidi/zero-width/homoglyph byte is not.)
    expect(invalidKey.error.message).toContain("‮");
    const relayed = describeDecodeError(invalidKey.error);
    expect(relayed).not.toContain("\x1b");
    expect(relayed).not.toContain("‮");
    expect(relayed).toContain("\\x1b");
    expect(relayed).toContain("\\u202e");
  }
});

test("a relayed parse error keeps an honest schema path readable", () => {
  // Acceptance counterpart to the sanitization pin above: the source escaping
  // must not over-escape an ordinary schema-fixed path. `sanitizeForDisplay`
  // leaves printable ASCII intact, so the `.` separators and numeric array
  // index of a path like `linkageFields.0.type` survive unchanged and an
  // honestly malformed config stays readable.
  const result = safeParseLinkageTerms({
    ...base,
    linkageFields: [{ name: "ssn", type: 123 as unknown as string }],
  });
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(describeDecodeError(result.error)).toContain("linkageFields.0.type");
  }
});

test("an unknown partner key is stripped, not echoed (non-strict invariant)", () => {
  // The one default Zod message that echoes a received value is unrecognized_keys
  // ("Unrecognized key: \"<key>\""), raised only by a .strict() object. The
  // linkage-terms schemas are non-strict z.object, so an unknown key -- even one
  // whose NAME carries control bytes -- is stripped and parsing still succeeds;
  // the raw key never reaches the (unsanitized) parse-error message. Adding
  // .strict() to the schema would make this parse fail with the key echoed,
  // failing this test and flagging that the parse-error path now needs sanitizing.
  const result = safeParseLinkageTerms({
    ...base,
    "\x1b[2J\x1b[31mEVIL": 1,
  });
  expect(result.success).toBe(true);
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
      { name: "firstName", type: "first_name" },
      { name: "lastName", type: "last_name" },
      { name: "dateOfBirth", type: "date_of_birth" },
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

// ─── referential integrity: element fields and swap targets ──────────────────
// Linkage terms are partner-controlled, so an incoherent set (a key element
// naming an undeclared field, or a swap target matching no element in its key)
// must be rejected at decode rather than collapsing the affected key to a
// silent, undiagnosable empty result at exchange time.

test("an element field not declared in linkageFields is rejected", () => {
  const result = safeParseLinkageTerms({
    ...base,
    linkageFields: [{ name: "ssn", type: "ssn" }],
    linkageKeys: [{ name: "Dangling", elements: [{ field: "lastName" }] }],
  });
  expect(result.success).toBe(false);
  if (result.success) return;
  expect(result.error.issues[0].path).toContain("linkageKeys");
  expect(result.error.issues[0].message).toMatch(/declared linkage field/);
});

test("a swap target matching no element in its key is rejected", () => {
  const result = safeParseLinkageTerms({
    ...base,
    linkageFields: [
      { name: "ssn", type: "ssn" },
      { name: "lastName", type: "last_name" },
    ],
    linkageKeys: [
      {
        name: "Bad swap",
        elements: [{ field: "ssn" }, { field: "lastName" }],
        // "firstName" is a declared-elsewhere idea but no element of this key,
        // so the swap target resolves to nothing.
        swap: ["ssn", "firstName"],
      },
    ],
  });
  expect(result.success).toBe(false);
  if (result.success) return;
  expect(result.error.issues[0].path).toContain("linkageKeys");
  expect(result.error.issues[0].message).toMatch(/swap target/);
});

test("a swap resolving via element field names validates", () => {
  const result = safeParseLinkageTerms({
    ...base,
    linkageFields: [
      { name: "firstName", type: "first_name" },
      { name: "lastName", type: "last_name" },
    ],
    linkageKeys: [
      {
        name: "Swap by field",
        elements: [{ field: "firstName" }, { field: "lastName" }],
        swap: ["firstName", "lastName"],
      },
    ],
  });
  expect(result.success).toBe(true);
});

test("a swap resolving via an element name alias and a field both validate", () => {
  // One target resolves via an element `name` alias, the other via `field`;
  // both resolution forms must be accepted within the same swap.
  const result = safeParseLinkageTerms({
    ...base,
    linkageFields: [
      { name: "firstName", type: "first_name" },
      { name: "lastName", type: "last_name" },
    ],
    linkageKeys: [
      {
        name: "Swap by alias and field",
        elements: [
          { field: "firstName", name: "given" },
          { field: "lastName" },
        ],
        swap: ["given", "lastName"],
      },
    ],
  });
  expect(result.success).toBe(true);
});

test("a duplicate element field with distinct name aliases still validates", () => {
  // The same field may appear twice when each occurrence carries a distinct
  // `name`; the new referential-integrity checks must not regress the existing
  // element-identifier-uniqueness rule, and a swap may target the aliases.
  const result = safeParseLinkageTerms({
    ...base,
    linkageFields: [{ name: "phone", type: "phone_number" }],
    linkageKeys: [
      {
        name: "Two phones",
        elements: [
          { field: "phone", name: "home" },
          { field: "phone", name: "work" },
        ],
        swap: ["home", "work"],
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

// ─── semantic-type enum values are snake_case (strict) ───────────────────────

// Every user-facing semantic-type value is snake_case (matching the convention
// for everything users write in YAML/JSON); camelizeKeys transforms object KEYS
// only, never these VALUES, so the value the schema sees is exactly what was
// written. The multi-word PII types and the single-word ones all parse.
test.each([
  "first_name",
  "last_name",
  "date_of_birth",
  "phone_number",
  "email_address",
  "ssn",
  "ssn4",
] as const)('linkage field type "%s" parses', (type) => {
  const result = safeParseLinkageTerms({
    ...base,
    linkageFields: [{ name: "f", type }],
    linkageKeys: [{ name: "K", elements: [{ field: "f" }] }],
  });
  expect(result.success).toBe(true);
});

// The old camelCase spellings are rejected (strict): there are no legacy configs
// or in-flight tokens to accept, so a single canonical snake_case vocabulary is
// enforced on the wire rather than carrying a dual-spelling normalization shim.
test.each([
  "firstName",
  "lastName",
  "dateOfBirth",
  "phoneNumber",
  "emailAddress",
] as const)('the old camelCase field type "%s" is rejected', (type) => {
  const result = safeParseLinkageTerms({
    ...base,
    linkageFields: [{ name: "f", type }],
    linkageKeys: [{ name: "K", elements: [{ field: "f" }] }],
  });
  expect(result.success).toBe(false);
});

test.each(["transpositions", "edit_distances", "adjacent_years"] as const)(
  'fuzzy-comparison method "%s" parses',
  (method) => {
    const result = safeParseLinkageTerms({
      ...base,
      linkageKeys: [
        {
          name: "K",
          elements: [{ field: "ssn", generateFuzzyComparisons: method }],
        },
      ],
    });
    expect(result.success).toBe(true);
  },
);

test.each(["editDistances", "adjacentYears"] as const)(
  'the old camelCase fuzzy-comparison method "%s" is rejected',
  (method) => {
    const result = safeParseLinkageTerms({
      ...base,
      linkageKeys: [
        {
          name: "K",
          elements: [{ field: "ssn", generateFuzzyComparisons: method }],
        },
      ],
    });
    expect(result.success).toBe(false);
  },
);

test("a rejected camelCase enum value is not echoed in the parse error", () => {
  // These enums ride a partner-controlled invitation token (#162) and operator
  // config that may carry secrets (#169), so the strict-rejection path must stay
  // a static error located by issue path -- protocolSetup leaves the Zod
  // parse-error message unsanitized, relying on the reachable issue codes
  // (invalid discriminator, invalid enum) reporting the EXPECTED options and the
  // schema path, not the received value. Pin that the offending camelCase value
  // does not surface raw in the message, for both the semantic-type discriminator
  // and the fuzzy-comparison enum.
  const fieldResult = safeParseLinkageTerms({
    ...base,
    linkageFields: [{ name: "f", type: "firstName" }],
    linkageKeys: [{ name: "K", elements: [{ field: "f" }] }],
  });
  expect(fieldResult.success).toBe(false);
  if (!fieldResult.success)
    expect(fieldResult.error.message).not.toContain("firstName");

  const fuzzyResult = safeParseLinkageTerms({
    ...base,
    linkageKeys: [
      {
        name: "K",
        elements: [{ field: "ssn", generateFuzzyComparisons: "editDistances" }],
      },
    ],
  });
  expect(fuzzyResult.success).toBe(false);
  if (!fuzzyResult.success)
    expect(fuzzyResult.error.message).not.toContain("editDistances");
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
        type: "last_name",
        constraints: { affixes_allowed: false },
      },
    ],
    linkage_keys: [
      {
        name: "SSN + Last Name",
        elements: [
          { field: "ssn", generate_fuzzy_comparisons: "edit_distances" },
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
      purpose: "Care coordination for co-enrolled patients",
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
    linkage_fields: [{ name: "dob", type: "date_of_birth" }],
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
    linkageFields: [{ name: "firstName", type: "first_name" }],
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
        { name: "dob", type: "date_of_birth" },
      ],
      linkageKeys: [
        { name: "SSN+DOB", elements: [{ field: "ssn" }, { field: "dob" }] },
      ],
    },
    {
      ...termsB,
      linkageFields: [
        { name: "dob", type: "date_of_birth" },
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

test("a non-canonical linkage-key param is reported, not thrown", () => {
  // transform.params is Record<string, unknown>, so an integer beyond 2^53
  // survives schema parsing but cannot be canonically encoded. The canonical
  // comparison must surface that as an error rather than letting the thrown
  // CanonicalEncodingError escape validateCompatibility's {errors,warnings}
  // contract (the callers in protocolSetup abort the exchange on a non-empty
  // errors list; an uncaught throw would crash the process instead).
  const badKeys: LinkageTerms["linkageKeys"] = [
    {
      name: "SSN",
      elements: [
        {
          field: "ssn",
          transform: [{ function: "noop", params: { big: 2 ** 53 } }],
        },
      ],
    },
  ];
  const runLocalBad = () =>
    validateCompatibility({ ...termsA, linkageKeys: badKeys }, termsB);
  expect(runLocalBad).not.toThrow();
  expect(
    runLocalBad().errors.some((e) =>
      e.includes("local linkage keys cannot be canonically encoded"),
    ),
  ).toBe(true);

  // Symmetric: the partner's keys are the un-encodable ones.
  const runPartnerBad = () =>
    validateCompatibility(termsA, { ...termsB, linkageKeys: badKeys });
  expect(runPartnerBad).not.toThrow();
  expect(
    runPartnerBad().errors.some((e) =>
      e.includes("partner linkage keys cannot be canonically encoded"),
    ),
  ).toBe(true);
});

test("legal agreement present on one side only is an error", () => {
  const { errors } = validateCompatibility(
    {
      ...termsA,
      legalAgreement: {
        reference: "MOU-001",
        purpose: "Care coordination",
        expirationDate: "2030-01-01",
      },
    },
    termsB,
  );
  expect(errors.some((e) => e.includes("legal agreement"))).toBe(true);
});

test("mismatched legal agreement reference is an error", () => {
  const { errors } = validateCompatibility(
    {
      ...termsA,
      legalAgreement: {
        reference: "MOU-001",
        purpose: "Care coordination",
        expirationDate: "2030-01-01",
      },
    },
    {
      ...termsB,
      legalAgreement: {
        reference: "MOU-002",
        purpose: "Care coordination",
        expirationDate: "2030-01-01",
      },
    },
  );
  expect(
    errors.some((e) => e.includes("legal agreement reference mismatch")),
  ).toBe(true);
});

test("mismatched legal agreement purpose is an error", () => {
  const { errors } = validateCompatibility(
    {
      ...termsA,
      legalAgreement: {
        reference: "MOU-001",
        purpose: "Care coordination",
        expirationDate: "2030-01-01",
      },
    },
    {
      ...termsB,
      legalAgreement: {
        reference: "MOU-001",
        purpose: "Program audit and evaluation",
        expirationDate: "2030-01-01",
      },
    },
  );
  expect(
    errors.some((e) => e.includes("legal agreement purpose mismatch")),
  ).toBe(true);
});

test("legal agreement purpose differing only by Unicode normalization is a mismatch", () => {
  // purpose is compared byte-for-byte, so the same text in different Unicode
  // normalization forms (NFC vs NFD) does not match. This pins the byte-exact
  // semantics as a guardrail: a later .normalize() or localeCompare would
  // silently weaken the cross-party check (and split termsHash between the
  // parties, since purpose feeds the canonical encoding the hash covers).
  const nfc = "Care coordination caf\u00e9"; // NFC: e-acute, one code point
  const nfd = "Care coordination cafe\u0301"; // NFD: e + combining acute
  expect(nfc).not.toBe(nfd); // distinct bytes...
  expect(nfc.normalize("NFC")).toBe(nfd.normalize("NFC")); // ...but the same text
  const { errors } = validateCompatibility(
    {
      ...termsA,
      legalAgreement: {
        reference: "MOU-001",
        purpose: nfc,
        expirationDate: "2030-01-01",
      },
    },
    {
      ...termsB,
      legalAgreement: {
        reference: "MOU-001",
        purpose: nfd,
        expirationDate: "2030-01-01",
      },
    },
  );
  expect(
    errors.some((e) => e.includes("legal agreement purpose mismatch")),
  ).toBe(true);
});

test("mismatched legal agreement expiration date is an error", () => {
  const { errors } = validateCompatibility(
    {
      ...termsA,
      legalAgreement: {
        reference: "MOU-001",
        purpose: "Care coordination",
        expirationDate: "2030-01-01",
      },
    },
    {
      ...termsB,
      legalAgreement: {
        reference: "MOU-001",
        purpose: "Care coordination",
        expirationDate: "2031-06-30",
      },
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
      legalAgreement: {
        reference: "MOU-001",
        purpose: "Care coordination",
        expirationDate: "2020-01-01",
      },
    },
    {
      ...termsB,
      legalAgreement: {
        reference: "MOU-001",
        purpose: "Care coordination",
        expirationDate: "2020-01-01",
      },
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

// ─── validateCompatibility: partner-string sanitization ──────────────────────
// A mismatch echoes a partner-supplied value into operator-facing output; these
// pin that every such value is routed through sanitizeForDisplay (control/ANSI
// and deceptive Unicode neutralized, over-long values truncated) while ordinary
// values and the mismatch detection itself are unaffected.

const withAgreement = (
  terms: LinkageTerms,
  reference: string,
  purpose: string,
): LinkageTerms => ({
  ...terms,
  legalAgreement: { reference, purpose, expirationDate: "2030-01-01" },
});

test("a partner reference with an ANSI/control sequence is neutralized", () => {
  const { errors } = validateCompatibility(
    withAgreement(termsA, "MOU-001", "Care coordination"),
    withAgreement(termsB, "MOU-\x1b[31m002\x1b[0m", "Care coordination"),
  );
  const msg = errors.find((e) =>
    e.includes("legal agreement reference mismatch"),
  );
  expect(msg).toBeDefined();
  // The raw ESC is gone (no terminal injection); it survives only as visible text.
  expect(msg).not.toContain("\x1b");
  expect(msg).toContain("\\x1b");
  // The trusted local value is intact and the mismatch is still reported.
  expect(msg).toContain('"MOU-001"');
});

test("a partner value with bidi-override / zero-width characters is neutralized", () => {
  const { errors } = validateCompatibility(
    withAgreement(termsA, "MOU-001", "Care coordination"),
    withAgreement(termsB, "MOU-001", "Care​ coordination‮EVIL"),
  );
  const msg = errors.find((e) =>
    e.includes("legal agreement purpose mismatch"),
  );
  expect(msg).toBeDefined();
  expect(msg).not.toContain("​");
  expect(msg).not.toContain("‮");
  expect(msg).toContain("\\u200b");
  expect(msg).toContain("\\u202e");
});

test("an over-long partner value is truncated with the marker", () => {
  const hostile = "B".repeat(DEFAULT_MAX_DISPLAY_LENGTH + 100);
  const { errors } = validateCompatibility(
    withAgreement(termsA, "MOU-001", "Care coordination"),
    withAgreement(termsB, hostile, "Care coordination"),
  );
  const msg = errors.find((e) =>
    e.includes("legal agreement reference mismatch"),
  );
  expect(msg).toBeDefined();
  expect(msg).not.toContain(hostile);
  expect(msg).toContain(DISPLAY_TRUNCATION_MARKER);
});

test("an ordinary partner value passes through the error unchanged", () => {
  const { errors } = validateCompatibility(
    withAgreement(termsA, "MOU-001", "Care coordination"),
    withAgreement(termsB, "MOU-9999", "Care coordination"),
  );
  const msg = errors.find((e) =>
    e.includes("legal agreement reference mismatch"),
  );
  expect(msg).toBeDefined();
  expect(msg).toContain('"MOU-9999"');
});

test("a partner payload column name with a control sequence is neutralized", () => {
  const { errors } = validateCompatibility(
    {
      ...termsA,
      payload: { send: [{ name: "case_id" }], receive: [{ name: "x" }] },
    },
    {
      ...termsB,
      payload: {
        send: [{ name: "x" }],
        receive: [{ name: "case_id\x1b[31m" }],
      },
    },
  );
  const msg = errors.find((e) => e.includes("payload mismatch"));
  expect(msg).toBeDefined();
  expect(msg).not.toContain("\x1b");
  expect(msg).toContain("\\x1b");
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

// ─── Untrusted-input bounds ──────────────────────────────────────────────────
// These terms ride inside an invitation token whose only integrity check is a
// transcription checksum anyone can recompute, so each partner-controlled
// free-text and array field carries a generous `.max()`. The bounds are wide
// enough that no real configuration hits them (asserted by the boundary-accept
// cases) but still refuse a token padded to exhaust the recipient.

test("accepts an identity at exactly the maximum length", () => {
  expect(() =>
    parseLinkageTerms({ ...base, identity: "x".repeat(MAX_TEXT_LENGTH) }),
  ).not.toThrow();
});

test("rejects an identity longer than the maximum", () => {
  expect(() =>
    parseLinkageTerms({ ...base, identity: "x".repeat(MAX_TEXT_LENGTH + 1) }),
  ).toThrow(ZodError);
});

test("accepts linkageKeys at exactly the maximum count", () => {
  const linkageKeys = Array.from({ length: MAX_LINKAGE_ENTRIES }, (_, i) => ({
    name: `K${i}`,
    elements: [{ field: "ssn" }],
  }));
  expect(() => parseLinkageTerms({ ...base, linkageKeys })).not.toThrow();
});

test("rejects more linkageKeys than the maximum count", () => {
  const linkageKeys = Array.from(
    { length: MAX_LINKAGE_ENTRIES + 1 },
    (_, i) => ({ name: `K${i}`, elements: [{ field: "ssn" }] }),
  );
  expect(() => parseLinkageTerms({ ...base, linkageKeys })).toThrow(ZodError);
});

test("accepts linkageFields at exactly the maximum count", () => {
  const linkageFields = Array.from({ length: MAX_LINKAGE_ENTRIES }, (_, i) => ({
    name: `f${i}`,
    type: "ssn",
  }));
  // The key must reference a declared field, so point it at one of the f* names
  // rather than base's "ssn", which this override does not declare.
  expect(() =>
    parseLinkageTerms({
      ...base,
      linkageFields,
      linkageKeys: [{ name: "K", elements: [{ field: "f0" }] }],
    }),
  ).not.toThrow();
});

test("rejects more linkageFields than the maximum count", () => {
  const linkageFields = Array.from(
    { length: MAX_LINKAGE_ENTRIES + 1 },
    (_, i) => ({ name: `f${i}`, type: "ssn" }),
  );
  // Point the key at a declared field so the rejection is the count bound alone,
  // not base's "ssn" reference (undeclared under this override) tripping the
  // referential-integrity refine.
  expect(() =>
    parseLinkageTerms({
      ...base,
      linkageFields,
      linkageKeys: [{ name: "K", elements: [{ field: "f0" }] }],
    }),
  ).toThrow(ZodError);
});

test("rejects an over-long constraint exclude value", () => {
  expect(() =>
    parseLinkageTerms({
      ...base,
      linkageFields: [
        {
          name: "ssn",
          type: "ssn",
          constraints: { exclude: ["x".repeat(MAX_TEXT_LENGTH + 1)] },
        },
      ],
    }),
  ).toThrow(ZodError);
});

test("rejects an over-long linkage key swap reference", () => {
  // Declare both element fields so the rest of the fixture is coherent; the
  // rejection is then about the swap entry alone. An over-long swap value trips
  // the swap-entry length bound and, being un-matchable to any element, the
  // swap-target referential check too -- both are intrinsic to the over-long
  // value under test.
  expect(() =>
    parseLinkageTerms({
      ...base,
      linkageFields: [
        { name: "ssn", type: "ssn" },
        { name: "ssn4", type: "ssn4" },
      ],
      linkageKeys: [
        {
          name: "SSN",
          elements: [{ field: "ssn" }, { field: "ssn4" }],
          swap: ["ssn", "x".repeat(MAX_NAME_LENGTH + 1)],
        },
      ],
    }),
  ).toThrow(ZodError);
});

test("rejects an over-long allowedCharacters constraint", () => {
  // A run of one character is a valid (if redundant) regex character class, so it
  // passes the class-validity refine and the rejection is the length bound alone.
  // The key references firstName so base's "ssn" reference does not dangle under
  // this override and trip the referential-integrity refine.
  expect(() =>
    parseLinkageTerms({
      ...base,
      linkageFields: [
        {
          name: "firstName",
          type: "first_name",
          constraints: { allowedCharacters: "a".repeat(MAX_NAME_LENGTH + 1) },
        },
      ],
      linkageKeys: [{ name: "FN", elements: [{ field: "firstName" }] }],
    }),
  ).toThrow(ZodError);
});

test("rejects an over-long transform params key", () => {
  expect(() =>
    parseLinkageTerms({
      ...base,
      linkageKeys: [
        {
          name: "SSN",
          elements: [
            {
              field: "ssn",
              transform: [
                {
                  function: "substring",
                  params: { ["k".repeat(MAX_NAME_LENGTH + 1)]: 1 },
                },
              ],
            },
          ],
        },
      ],
    }),
  ).toThrow(ZodError);
});

const paramsTerms = (params: Record<string, unknown>) => ({
  ...base,
  linkageKeys: [
    {
      name: "SSN",
      elements: [{ field: "ssn", transform: [{ function: "trim", params }] }],
    },
  ],
});

test("accepts a transform params record at exactly the maximum entry count", () => {
  const params: Record<string, unknown> = {};
  for (let i = 0; i < MAX_PARAMS_ENTRIES; i++) params[`k${i}`] = 1;
  expect(() => parseLinkageTerms(paramsTerms(params))).not.toThrow();
});

test("rejects a transform params record over the maximum entry count", () => {
  const params: Record<string, unknown> = {};
  for (let i = 0; i <= MAX_PARAMS_ENTRIES; i++) params[`k${i}`] = 1;
  expect(() => parseLinkageTerms(paramsTerms(params))).toThrow(ZodError);
});

test("a pathological-count transform params record fails cleanly, not with a RangeError", () => {
  // Regression for the Zod issue-accumulation overflow: a record of ~200k keys
  // each too long for the per-key bound. On the unbounded-count schema Zod built
  // one issue per key and overflowed the call stack spreading that array up
  // through the nesting -- the RangeError escaped even safeParse (it converts a
  // ZodError to a result but not an internal throw). The count gate, applied
  // before the per-key length check, must turn this into one clean, bounded
  // issue. ~200k keys clears the empirical overflow threshold (~130k); a smaller
  // over-count would reject without ever exercising the overflow path.
  const params: Record<string, unknown> = {};
  const overlong = "k".repeat(MAX_NAME_LENGTH + 1);
  for (let i = 0; i < 200_000; i++) params[overlong + i] = 1;

  let result: ReturnType<typeof safeParseLinkageTerms> | undefined;
  expect(() => {
    result = safeParseLinkageTerms(paramsTerms(params));
  }).not.toThrow();
  expect(result?.success).toBe(false);
  if (result && !result.success) {
    // A single count-bound issue, not one per key, and it carries no partner key
    // bytes (the over-long keys never reach the per-key validation).
    expect(
      result.error.issues.some((i) => /must not exceed/.test(i.message)),
    ).toBe(true);
    expect(describeDecodeError(result.error)).toContain("params");
  }
});

test("an over-long transform params key within the count bound is still rejected per-key", () => {
  // The count gate must not mask the per-key length bound for an in-range record:
  // a single over-long key still trips the post-pipe `invalid_key` path, the one
  // item 202554679's parse-error sanitization relies on.
  const result = safeParseLinkageTerms(
    paramsTerms({ ["k".repeat(MAX_NAME_LENGTH + 1)]: 1 }),
  );
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues[0].code).toBe("invalid_key");
  }
});

// ─── Nested-collection count bounds ──────────────────────────────────────────
// Each constraint `exclude` list, a key element's `transform` step list, and a
// key's `elements` list is partner-controlled and nested beneath an outer array,
// so an over-count payload could make Zod accumulate one issue per invalid
// element and overflow its call stack spreading them (a RangeError, same class as
// the transform.params bound). Each list is count-bounded BEFORE per-element
// validation; pin the boundary, that a pathological count fails cleanly, and that
// the per-element validation under the gate is preserved.

const excludeTerms = (exclude: unknown[]) => ({
  ...base,
  linkageFields: [{ name: "ssn", type: "ssn", constraints: { exclude } }],
});

test("accepts a constraint exclude at exactly the maximum count", () => {
  const exclude = Array.from(
    { length: MAX_EXCLUDE_ENTRIES },
    (_, i) => `v${i}`,
  );
  expect(() => parseLinkageTerms(excludeTerms(exclude))).not.toThrow();
});

test("rejects a constraint exclude over the maximum count", () => {
  const exclude = Array.from(
    { length: MAX_EXCLUDE_ENTRIES + 1 },
    (_, i) => `v${i}`,
  );
  expect(() => parseLinkageTerms(excludeTerms(exclude))).toThrow(ZodError);
});

test("a pathological-count constraint exclude fails cleanly, not with a RangeError", () => {
  // ~200k over-long values: on the unbounded schema Zod built one too_big issue
  // per value and overflowed the call stack spreading them up through the
  // exclude/linkageFields frames. The count gate, applied before per-element
  // validation, must turn this into one clean, bounded issue. 200k clears the
  // empirical overflow threshold (~130k).
  const exclude = Array.from({ length: 200_000 }, () =>
    "x".repeat(MAX_TEXT_LENGTH + 1),
  );
  let result: ReturnType<typeof safeParseLinkageTerms> | undefined;
  expect(() => {
    result = safeParseLinkageTerms(excludeTerms(exclude));
  }).not.toThrow();
  expect(result?.success).toBe(false);
  if (result && !result.success) {
    expect(
      result.error.issues.some((i) =>
        /exclude must not exceed/.test(i.message),
      ),
    ).toBe(true);
  }
});

const transformTerms = (transform: unknown[]) => ({
  ...base,
  linkageKeys: [{ name: "SSN", elements: [{ field: "ssn", transform }] }],
});

test("accepts a transform step list at exactly the maximum count", () => {
  const transform = Array.from({ length: MAX_TRANSFORM_STEPS }, () => ({
    function: "trim",
  }));
  expect(() => parseLinkageTerms(transformTerms(transform))).not.toThrow();
});

test("rejects a transform step list over the maximum count", () => {
  const transform = Array.from({ length: MAX_TRANSFORM_STEPS + 1 }, () => ({
    function: "trim",
  }));
  expect(() => parseLinkageTerms(transformTerms(transform))).toThrow(ZodError);
});

test("a pathological-count transform step list fails cleanly, not with a RangeError", () => {
  const transform = Array.from({ length: 200_000 }, () => 123);
  let result: ReturnType<typeof safeParseLinkageTerms> | undefined;
  expect(() => {
    result = safeParseLinkageTerms(transformTerms(transform));
  }).not.toThrow();
  expect(result?.success).toBe(false);
  if (result && !result.success) {
    expect(
      result.error.issues.some((i) =>
        /transform must not exceed/.test(i.message),
      ),
    ).toBe(true);
  }
});

const elementsTerms = (elements: unknown[]) => ({
  ...base,
  linkageFields: [{ name: "ssn", type: "ssn" }],
  linkageKeys: [{ name: "SSN", elements }],
});

test("accepts a linkage key elements list at exactly the maximum count", () => {
  // Distinct element names keep the within-key identifier-uniqueness refine
  // satisfied; every element references the declared "ssn" field.
  const elements = Array.from({ length: MAX_KEY_ELEMENTS }, (_, i) => ({
    field: "ssn",
    name: `e${i}`,
  }));
  expect(() => parseLinkageTerms(elementsTerms(elements))).not.toThrow();
});

test("rejects a linkage key elements list over the maximum count", () => {
  const elements = Array.from({ length: MAX_KEY_ELEMENTS + 1 }, (_, i) => ({
    field: "ssn",
    name: `e${i}`,
  }));
  expect(() => parseLinkageTerms(elementsTerms(elements))).toThrow(ZodError);
});

test("a deeply-nested transform.params value fails cleanly, not with a RangeError", () => {
  // DISTINCT from the count-overflow above: parseLinkageTerms camelizes BEFORE
  // Zod, and camelizeKeys recurses once per nesting level, so a deeply-nested
  // partner value (here under transform.params, typed z.unknown(), so it would
  // otherwise survive into the parsed terms) overflows the call stack pre-Zod.
  // ~5000 levels is a few tens of KB of JSON, well within the invitation and
  // frame caps; the camelize depth guard must reject it as a clean bounded error.
  let deepValue: unknown = { leaf: 1 };
  for (let i = 0; i < 5000; i++) deepValue = { nested: deepValue };
  const terms = {
    ...base,
    linkageKeys: [
      {
        name: "SSN",
        elements: [
          {
            field: "ssn",
            transform: [{ function: "trim", params: { deep: deepValue } }],
          },
        ],
      },
    ],
  };
  let err: unknown;
  try {
    parseLinkageTerms(terms);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(NestingDepthExceededError);
  expect(err).not.toBeInstanceOf(RangeError);
});

test("a pathological-count linkage key elements list fails cleanly, not with a RangeError", () => {
  const elements = Array.from({ length: 200_000 }, () => 123);
  let result: ReturnType<typeof safeParseLinkageTerms> | undefined;
  expect(() => {
    result = safeParseLinkageTerms(elementsTerms(elements));
  }).not.toThrow();
  expect(result?.success).toBe(false);
  if (result && !result.success) {
    expect(
      result.error.issues.some((i) =>
        /elements must not exceed/.test(i.message),
      ),
    ).toBe(true);
  }
});

// ─── Payload send/receive count bounds ───────────────────────────────────────
// payload.send / payload.receive are partner-controlled column lists sitting one
// object-frame below the root, so they do not drive the ~130k STACK overflow the
// nested collections hit -- but at ~3.5M invalid entries Zod throws `Invalid
// string length` building its error string (a RangeError that safeParse does NOT
// catch). Unlike the post-handshake wire arrays, a payload legitimately holds at
// most a few hundred columns, so a count gate (MAX_PAYLOAD_ENTRIES, applied
// before per-element validation) fits. `base` declares expectsOutput: true, so a
// non-empty `receive` is permitted by the cross-field refine.

const sendTerms = (send: unknown[]) => ({ ...base, payload: { send } });
const receiveTerms = (receive: unknown[]) => ({
  ...base,
  payload: { receive },
});

test("accepts a payload send list at exactly the maximum count", () => {
  const send = Array.from({ length: MAX_PAYLOAD_ENTRIES }, (_, i) => ({
    name: `c${i}`,
  }));
  expect(() => parseLinkageTerms(sendTerms(send))).not.toThrow();
});

test("rejects a payload send list over the maximum count", () => {
  const send = Array.from({ length: MAX_PAYLOAD_ENTRIES + 1 }, (_, i) => ({
    name: `c${i}`,
  }));
  expect(() => parseLinkageTerms(sendTerms(send))).toThrow(ZodError);
});

test("a pathological-count payload send list fails cleanly, not with a RangeError", () => {
  // ~4M invalid entries, past the ~3.5M `Invalid string length` threshold the
  // unbounded `z.array(PayloadColumnSchema)` schema hit. The count gate, applied
  // before per-element validation, must turn this into one clean count issue.
  const send = Array.from({ length: 4_000_000 }, () => 123);
  let result: ReturnType<typeof safeParseLinkageTerms> | undefined;
  expect(() => {
    result = safeParseLinkageTerms(sendTerms(send));
  }).not.toThrow();
  expect(result?.success).toBe(false);
  if (result && !result.success) {
    expect(
      result.error.issues.some((i) => /send must not exceed/.test(i.message)),
    ).toBe(true);
  }
});

test("accepts a payload receive list at exactly the maximum count", () => {
  const receive = Array.from({ length: MAX_PAYLOAD_ENTRIES }, (_, i) => ({
    name: `c${i}`,
  }));
  expect(() => parseLinkageTerms(receiveTerms(receive))).not.toThrow();
});

test("rejects a payload receive list over the maximum count", () => {
  const receive = Array.from({ length: MAX_PAYLOAD_ENTRIES + 1 }, (_, i) => ({
    name: `c${i}`,
  }));
  expect(() => parseLinkageTerms(receiveTerms(receive))).toThrow(ZodError);
});

test("a pathological-count payload receive list fails cleanly, not with a RangeError", () => {
  const receive = Array.from({ length: 4_000_000 }, () => 123);
  let result: ReturnType<typeof safeParseLinkageTerms> | undefined;
  expect(() => {
    result = safeParseLinkageTerms(receiveTerms(receive));
  }).not.toThrow();
  expect(result?.success).toBe(false);
  if (result && !result.success) {
    expect(
      result.error.issues.some((i) =>
        /receive must not exceed/.test(i.message),
      ),
    ).toBe(true);
  }
});

// ─── Top-level linkageFields / linkageKeys count bounds ──────────────────────
// These two flat top-level arrays sit directly below the root, so a pathological
// count does not overflow the call stack -- but a partner array of millions of
// invalid entries still makes Zod throw `Invalid string length` building its
// error from one issue per entry, because a bare `.max()` is checked only AFTER
// per-element validation. They now take the boundedArray count gate (fired
// before per-element validation), with the existing .min(1) floor preserved.

const linkageFieldsTerms = (linkageFields: unknown[]) => ({
  ...base,
  linkageFields,
  linkageKeys: [{ name: "K", elements: [{ field: "f0" }] }],
});
const linkageKeysTerms = (linkageKeys: unknown[]) => ({
  ...base,
  linkageFields: [{ name: "ssn", type: "ssn" }],
  linkageKeys,
});

test("accepts linkageFields at exactly the maximum count", () => {
  const fields = Array.from({ length: MAX_LINKAGE_ENTRIES }, (_, i) => ({
    name: `f${i}`,
    type: "ssn",
  }));
  expect(() => parseLinkageTerms(linkageFieldsTerms(fields))).not.toThrow();
});

test("rejects linkageFields over the maximum count", () => {
  const fields = Array.from({ length: MAX_LINKAGE_ENTRIES + 1 }, (_, i) => ({
    name: `f${i}`,
    type: "ssn",
  }));
  expect(() => parseLinkageTerms(linkageFieldsTerms(fields))).toThrow(ZodError);
});

test("a pathological-count linkageFields fails cleanly, not with a RangeError", () => {
  // ~4M invalid entries, past the ~3.5M `Invalid string length` threshold the
  // `.max()`-only schema hit (the .max ran after per-element validation). The
  // count gate must turn this into one clean count issue.
  const fields = Array.from({ length: 4_000_000 }, () => 123);
  let result: ReturnType<typeof safeParseLinkageTerms> | undefined;
  expect(() => {
    result = safeParseLinkageTerms(linkageFieldsTerms(fields));
  }).not.toThrow();
  expect(result?.success).toBe(false);
  if (result && !result.success) {
    expect(
      result.error.issues.some((i) =>
        /linkageFields must not exceed/.test(i.message),
      ),
    ).toBe(true);
  }
});

test("accepts linkageKeys at exactly the maximum count", () => {
  const keys = Array.from({ length: MAX_LINKAGE_ENTRIES }, (_, i) => ({
    name: `K${i}`,
    elements: [{ field: "ssn" }],
  }));
  expect(() => parseLinkageTerms(linkageKeysTerms(keys))).not.toThrow();
});

test("rejects linkageKeys over the maximum count", () => {
  const keys = Array.from({ length: MAX_LINKAGE_ENTRIES + 1 }, (_, i) => ({
    name: `K${i}`,
    elements: [{ field: "ssn" }],
  }));
  expect(() => parseLinkageTerms(linkageKeysTerms(keys))).toThrow(ZodError);
});

test("a pathological-count linkageKeys fails cleanly, not with a RangeError or a TypeError", () => {
  // ~4M INVALID (non-object) entries. Besides the `Invalid string length` burst,
  // this also pins the boundedArray `abort`: without it the over-count refine is
  // non-fatal, the raw `unknown[]` flows on, and the terms-level refines that do
  // `key.elements.map(...)` throw a TypeError on a raw non-object key. The abort
  // makes the over-count failure short-circuit to the clean count issue.
  const keys = Array.from({ length: 4_000_000 }, () => 123);
  let result: ReturnType<typeof safeParseLinkageTerms> | undefined;
  expect(() => {
    result = safeParseLinkageTerms(linkageKeysTerms(keys));
  }).not.toThrow();
  expect(result?.success).toBe(false);
  if (result && !result.success) {
    expect(
      result.error.issues.some((i) =>
        /linkageKeys must not exceed/.test(i.message),
      ),
    ).toBe(true);
  }
});

test("rejects an over-long version string", () => {
  // Matches the semver regex (all digits, then `.0.0`) so the rejection is the
  // length bound, not the format check.
  expect(() =>
    parseLinkageTerms({
      ...base,
      version: "1".repeat(MAX_NAME_LENGTH + 1) + ".0.0",
    }),
  ).toThrow(ZodError);
});

test("rejects an over-long linkage key name", () => {
  expect(() =>
    parseLinkageTerms({
      ...base,
      linkageKeys: [
        { name: "x".repeat(MAX_NAME_LENGTH + 1), elements: [{ field: "ssn" }] },
      ],
    }),
  ).toThrow(ZodError);
});

test("rejects an over-long linkage field name", () => {
  // Declare a short field for base's key to reference so the rejection is the
  // field-name length bound alone; the over-long-named field is unreferenced, so
  // it does not also trip the element-field length bound or the referential
  // refine.
  expect(() =>
    parseLinkageTerms({
      ...base,
      linkageFields: [
        { name: "ssn", type: "ssn" },
        { name: "x".repeat(MAX_NAME_LENGTH + 1), type: "ssn" },
      ],
    }),
  ).toThrow(ZodError);
});

test("rejects an over-long payload column name", () => {
  expect(() =>
    parseLinkageTerms({
      ...base,
      output: { expectsOutput: true, shareWithPartner: true },
      payload: { send: [{ name: "x".repeat(MAX_NAME_LENGTH + 1) }] },
    }),
  ).toThrow(ZodError);
});

test("rejects an over-long payload column description", () => {
  expect(() =>
    parseLinkageTerms({
      ...base,
      output: { expectsOutput: true, shareWithPartner: true },
      payload: {
        send: [{ name: "col", description: "x".repeat(MAX_TEXT_LENGTH + 1) }],
      },
    }),
  ).toThrow(ZodError);
});

test("rejects an over-long legal agreement reference", () => {
  expect(() =>
    parseLinkageTerms({
      ...base,
      legalAgreement: {
        reference: "x".repeat(MAX_NAME_LENGTH + 1),
        purpose: "Audit",
        expirationDate: "2099-01-01",
      },
    }),
  ).toThrow(ZodError);
});

test("rejects an over-long legal agreement purpose", () => {
  expect(() =>
    parseLinkageTerms({
      ...base,
      legalAgreement: {
        reference: "MOU-1",
        purpose: "x".repeat(MAX_TEXT_LENGTH + 1),
        expirationDate: "2099-01-01",
      },
    }),
  ).toThrow(ZodError);
});
