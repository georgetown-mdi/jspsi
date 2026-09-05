import { ZodError } from "zod";
import { describe, expect, test } from "vitest";

import {
  deriveAcceptedLinkageTerms,
  validateCompatibility,
} from "../src/linkageTermsNegotiation";
import {
  parseLinkageTerms,
  referencedLinkageFieldNames,
  safeParseLinkageTerms,
  MAX_NAME_LENGTH,
  MAX_TEXT_LENGTH,
  TEXT_CONTROL_CHAR_MESSAGE,
  MAX_LINKAGE_ENTRIES,
  MAX_PARAMS_ENTRIES,
  MAX_PAD_LEFT_LENGTH,
  MAX_DATE_FORMAT_LENGTH,
  MAX_TRANSFORM_PATTERN_LENGTH,
  MAX_TRANSFORM_PARAM_LENGTH,
  MAX_EXCLUDE_ENTRIES,
  MAX_TRANSFORM_STEPS,
  MAX_KEY_ELEMENTS,
  MAX_PAYLOAD_ENTRIES,
} from "../src/config/linkageTermsSchema";
import type { LinkageKey } from "../src/config/linkageTermsSchema";
import { pipelineAlwaysDrops } from "../src/linkageSatisfiability";
import { describeDecodeError } from "../src/utils/describeDecodeError";
import {
  MAX_NODE_COUNT,
  NestingDepthExceededError,
} from "../src/utils/camelizeKeys";

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

// --- Happy path --------------------------------------------------------------

// Every structure the schema admits at once. `psi`, because several linkage
// keys, `deduplicate: true`, and payload in both directions are exactly the
// shape the count-only algorithm refuses (the psi-c section below covers that);
// this case is about the rest of the document parsing.
test("parses a complete valid set of terms", () => {
  const result = parseLinkageTerms({
    version: "2.1.0",
    identity: "Jane Smith, Agency A, jsmith@agency-a.gov",
    date: "2025-06-01",
    algorithm: "psi",
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

  expect(result.algorithm).toBe("psi");
  expect(result.linkageFields).toHaveLength(5);
  expect(result.linkageKeys).toHaveLength(2);
  expect(result.legalAgreement?.reference).toBe("MOU-2025-0042");
  expect(result.legalAgreement?.purpose).toBe(
    "Audit and evaluation of the State tutoring program",
  );
  expect(result.payload?.send).toHaveLength(1);
});

test("accepts a zip_code linkage field referenced by a key", () => {
  // zip_code is a matchable type with no default key (like phone_number /
  // email_address): it must still be a valid LinkageField the schema accepts and a
  // key may reference, even though getDefaultLinkageTerms never emits one.
  const result = safeParseLinkageTerms({
    ...base,
    linkageFields: [
      { name: "ssn", type: "ssn" },
      { name: "zip", type: "zip_code", constraints: { exclude: ["00000"] } },
    ],
    linkageKeys: [
      { name: "SSN + ZIP", elements: [{ field: "ssn" }, { field: "zip" }] },
    ],
  });
  expect(result.success).toBe(true);
  if (result.success) {
    const zip = result.data.linkageFields.find((f) => f.name === "zip");
    expect(zip?.type).toBe("zip_code");
  }
});

// --- Cross-field constraint: deduplicate -> expectsOutput --------------------

test("a missing or non-boolean deduplicate is rejected", () => {
  for (const malformed of [undefined, null, "true", 1, {}, []]) {
    const result = safeParseLinkageTerms({ ...base, deduplicate: malformed });
    expect(result.success).toBe(false);
    if (result.success) continue;
    const paths = result.error.issues.map((i) => i.path.join("."));
    expect(paths).toContain("deduplicate");
  }
});

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

// --- Cross-field constraint: expectsOutput: false -> no payload.receive ------

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

// --- allowedCharacters regex validation --------------------------------------

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

test("allowedCharacters rejects a class the runtime engine cannot compile", () => {
  // Validation runs the same linear-time engine the web constraint check uses, so
  // a class the native engine accepts but that engine rejects -- the degenerate
  // empty class, or a native-only construct like an octal/backreference escape --
  // is refused here rather than silently failing open at check time.
  for (const allowedCharacters of ["", "\\1"]) {
    const result = safeParseLinkageTerms({
      ...base,
      linkageFields: [
        {
          name: "lastName",
          type: "last_name",
          constraints: { allowedCharacters },
        },
      ],
      linkageKeys: [{ name: "Last Name", elements: [{ field: "lastName" }] }],
    });
    expect(result.success).toBe(false);
    if (result.success) continue;
    expect(result.error.issues[0].message).toMatch(/character class/);
  }
});

// --- parse vs safeParse ------------------------------------------------------

test("parseLinkageTerms throws ZodError on invalid input", () => {
  expect(() => parseLinkageTerms({ version: "not-semver" })).toThrow(ZodError);
});

test("safeParseLinkageTerms returns success: false on invalid input", () => {
  const result = safeParseLinkageTerms({ version: "not-semver" });
  expect(result.success).toBe(false);
});

test("a parse error does not echo a partner-supplied received value", () => {
  // describeDecodeError escapes each Zod issue-path segment via
  // sanitizeForDisplay and relays the schema-fixed message text. Two
  // mechanisms keep partner bytes out of the message; this test pins both.
  //
  // 1. Most codes (type mismatch, enum, semver/date format, too_small) report
  //    only the expected type/options, never the received value, so even the
  //    raw `error.message` holds no partner bytes.
  const evil = "\x1b[31mEVIL\x1b[0m\u202e";
  const enumSemver = safeParseLinkageTerms({
    ...base,
    algorithm: evil, // invalid enum
    version: evil, // invalid semver
  });
  expect(enumSemver.success).toBe(false);
  if (!enumSemver.success) {
    expect(enumSemver.error.message).not.toContain("\x1b");
    expect(enumSemver.error.message).not.toContain("\u202e");
  }

  // 2. The `invalid_key` code on the bounded `transform.params` record key
  //    (z.string().max(MAX_NAME_LENGTH)) DOES place the offending key VERBATIM
  //    in the issue PATH, which the raw `error.message` JSON-dumps -- so here
  //    the source escaping (describeDecodeError) does the protecting, not the
  //    schema. The dangerous bytes lead the key (with padding past the bound
  //    after them) so escaping, not the display-length cap, is what neutralizes
  //    them. Assert on the rendered message the exchange actually relays.
  const evilKey = "\x1b[31m\u202e" + "x".repeat(MAX_NAME_LENGTH);
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
    expect(invalidKey.error.message).toContain("\u202e");
    const relayed = describeDecodeError(invalidKey.error);
    expect(relayed).not.toContain("\x1b");
    expect(relayed).not.toContain("\u202e");
    expect(relayed).toContain("\\x1b");
    expect(relayed).toContain("\\u202e");
  }
});

test("a relayed parse error keeps an ordinary schema path readable", () => {
  // Acceptance counterpart to the sanitization pin above: the source escaping
  // must not over-escape an ordinary schema-fixed path. `sanitizeForDisplay`
  // leaves printable ASCII intact, so the `.` separators and numeric array
  // index of a path like `linkageFields.0.type` survive unchanged and an
  // ordinarily malformed config stays readable.
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
  // whose NAME holds control bytes -- is stripped and parsing still succeeds;
  // the raw key never reaches the (unsanitized) parse-error message. Adding
  // .strict() to the schema would fail this parse with the key echoed, failing
  // this test and flagging that the parse-error path then needs sanitizing.
  const result = safeParseLinkageTerms({
    ...base,
    "\x1b[2J\x1b[31mEVIL": 1,
  });
  expect(result.success).toBe(true);
});

// --- version semver format ---------------------------------------------------

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

// --- uniqueness constraints ---------------------------------------------------

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

// --- referential integrity: element fields and swap targets ------------------
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

// --- A swap pair's fuzzy designations ----------------------------------------
// The swap moves the field references and leaves each position's own
// generate_fuzzy_comparisons where it is, so a mismatched pair would expand a
// column one way on the party that swaps and another on the party that does not
// -- two readings of one agreed document, neither visible from a party's own
// copy. Bound here, at the layer every parse path inherits.

function swappedPair(
  first: string | undefined,
  second: string | undefined,
): unknown {
  return {
    ...base,
    linkageFields: [
      { name: "firstName", type: "first_name" },
      { name: "lastName", type: "last_name" },
    ],
    linkageKeys: [
      {
        name: "Swapped",
        elements: [
          { field: "firstName", generate_fuzzy_comparisons: first },
          { field: "lastName", generate_fuzzy_comparisons: second },
        ],
        swap: ["firstName", "lastName"],
      },
    ],
  };
}

test("a swap pair declaring different fuzzy comparisons is rejected", () => {
  const result = safeParseLinkageTerms(
    swappedPair("transpositions", "edit_distances"),
  );
  expect(result.success).toBe(false);
  if (result.success) return;
  expect(result.error.issues[0].path).toContain("linkageKeys");
  expect(result.error.issues[0].message).toMatch(
    /same generate_fuzzy_comparisons/,
  );
});

test("a swap pair with one position declaring a fuzzy comparison is rejected", () => {
  // The asymmetric shape the mismatch actually takes in an authored document: an
  // expansion added to one position of a pair and not the other.
  const result = safeParseLinkageTerms(
    swappedPair("transpositions", undefined),
  );
  expect(result.success).toBe(false);
  if (result.success) return;
  expect(result.error.issues[0].message).toMatch(
    /same generate_fuzzy_comparisons/,
  );
});

test("a swap pair declaring the same fuzzy comparison validates", () => {
  const matched = safeParseLinkageTerms(
    swappedPair("transpositions", "transpositions"),
  );
  expect(matched.success).toBe(true);
  const neither = safeParseLinkageTerms(swappedPair(undefined, undefined));
  expect(neither.success).toBe(true);
});

test("a fuzzy comparison outside a swap pair is unaffected", () => {
  const result = safeParseLinkageTerms({
    ...base,
    linkageFields: [
      { name: "firstName", type: "first_name" },
      { name: "lastName", type: "last_name" },
      { name: "ssn", type: "ssn" },
    ],
    linkageKeys: [
      {
        name: "Swapped",
        elements: [
          { field: "firstName" },
          { field: "lastName" },
          { field: "ssn", generate_fuzzy_comparisons: "transpositions" },
        ],
        swap: ["firstName", "lastName"],
      },
    ],
  });
  expect(result.success).toBe(true);
});

// --- A swap pair's transforms ------------------------------------------------
// Same rule, same reason, on the pair's other position-bound attribute: the swap
// moves the field references and leaves each position's transform where it is, so
// a mismatched pair transforms a column one way on the party that swaps and
// another on the party that does not. Role resolution is re-derived per run from
// the parties' record counts rather than held in the terms, so the pair would
// also decide the match set differently run to run.

function swappedTransforms(
  first: unknown,
  second: unknown,
): Record<string, unknown> {
  return {
    ...base,
    linkageFields: [
      { name: "firstName", type: "first_name" },
      { name: "lastName", type: "last_name" },
    ],
    linkageKeys: [
      {
        name: "Swapped",
        elements: [
          { field: "firstName", transform: first },
          { field: "lastName", transform: second },
        ],
        swap: ["firstName", "lastName"],
      },
    ],
  };
}

const upperCase = [{ function: "to_upper_case" }];

test("a swap pair declaring different transforms is rejected", () => {
  const result = safeParseLinkageTerms(
    swappedTransforms(upperCase, [{ function: "to_lower_case" }]),
  );
  expect(result.success).toBe(false);
  if (result.success) return;
  expect(result.error.issues[0].path).toContain("linkageKeys");
  expect(result.error.issues[0].message).toMatch(/same transform/);
});

test("a swap pair with one position declaring a transform is rejected", () => {
  // The asymmetric shape the mismatch actually takes in an authored document: a
  // pipeline added to one position of a pair and not the other.
  const result = safeParseLinkageTerms(swappedTransforms(upperCase, undefined));
  expect(result.success).toBe(false);
  if (result.success) return;
  expect(result.error.issues[0].message).toMatch(/same transform/);
});

test("a swap pair declaring the same transform validates", () => {
  const matched = safeParseLinkageTerms(
    swappedTransforms(upperCase, [{ function: "to_upper_case" }]),
  );
  expect(matched.success).toBe(true);
  // An absent pipeline and an empty one are the same identity pipeline, so a
  // pair spelling it either way is one transform, not two.
  const neither = safeParseLinkageTerms(swappedTransforms(undefined, []));
  expect(neither.success).toBe(true);
});

test("a swap pair's transform params are compared canonically, not by key order", () => {
  // Two spellings of one pipeline: `params` is a JSON object, whose key order
  // has no meaning and does not survive the canonical encoding the agreed
  // terms are hashed in. A pair differing only there declares one transform.
  const result = safeParseLinkageTerms(
    swappedTransforms(
      [{ function: "substring", params: { start: 1, length: 4 } }],
      [{ function: "substring", params: { length: 4, start: 1 } }],
    ),
  );
  expect(result.success).toBe(true);
});

test("a swap pair's transform params differing in value are rejected", () => {
  const result = safeParseLinkageTerms(
    swappedTransforms(
      [{ function: "substring", params: { start: 1, length: 4 } }],
      [{ function: "substring", params: { start: 1, length: 5 } }],
    ),
  );
  expect(result.success).toBe(false);
  if (result.success) return;
  expect(result.error.issues[0].message).toMatch(/same transform/);
});

test("a swap pair whose transform params cannot be canonically encoded is refused", () => {
  // A transform param's value is unconstrained by type, so a partner value
  // outside the reproducible canonical domain -- an integer past 2^53 -- reaches
  // the pair comparison. It is answered by a refusal, even for two identically
  // spelled pipelines, rather than by an exception escaping the safe parse.
  const unencodable = [{ function: "to_upper_case", params: { scale: 1e300 } }];
  const result = safeParseLinkageTerms(
    swappedTransforms(unencodable, unencodable),
  );
  expect(result.success).toBe(false);
  if (result.success) return;
  expect(result.error.issues[0].message).toMatch(/same transform/);
});

test("a transform outside a swap pair is unaffected", () => {
  const result = safeParseLinkageTerms({
    ...base,
    linkageFields: [
      { name: "firstName", type: "first_name" },
      { name: "lastName", type: "last_name" },
      { name: "ssn", type: "ssn" },
    ],
    linkageKeys: [
      {
        name: "Swapped",
        elements: [
          { field: "firstName" },
          { field: "lastName" },
          { field: "ssn", transform: upperCase },
        ],
        swap: ["firstName", "lastName"],
      },
    ],
  });
  expect(result.success).toBe(true);
});

// --- Transform-regex dialect conformance -------------------------------------
// Element-transform regex patterns are partner-controlled and run per row over
// the full dataset, under the linear-time engine (utils/linearRegex.ts), so they
// cannot backtrack catastrophically. The remaining validation control is dialect
// conformance: a pattern the engine cannot compile (a backreference, lookaround,
// or unsupported escape) is rejected before any execution. The check lives in
// LinkageTermsSchema so every parse path inherits it. (Engine semantics, and
// catastrophic-backtracking patterns running in linear time, are unit-tested in
// linearRegex.test.ts and standardization.test.ts.)

test("a transform regex outside the linear-time dialect is rejected at validation", () => {
  // A backreference is valid JavaScript regex but outside the RE2 dialect; it is
  // rejected at terms validation, fail closed, before any pattern executes.
  const result = safeParseLinkageTerms({
    ...base,
    linkageKeys: [
      {
        name: "SSN",
        elements: [
          {
            field: "ssn",
            transform: [
              { function: "filter_regex", params: { pattern: "(a)\\1" } },
            ],
          },
        ],
      },
    ],
  });
  expect(result.success).toBe(false);
  if (result.success) return;
  expect(result.error.issues[0].path).toContain("linkageKeys");
  expect(result.error.issues[0].message).toMatch(/linear-time dialect/);
});

test("a nested-quantifier pattern that backtracks on new RegExp now validates", () => {
  const result = safeParseLinkageTerms({
    ...base,
    linkageKeys: [
      {
        name: "SSN",
        elements: [
          {
            field: "ssn",
            transform: [
              { function: "filter_regex", params: { pattern: "(a+)+$" } },
            ],
          },
        ],
      },
    ],
  });
  expect(result.success).toBe(true);
});

test("the bundled email-filter pattern in an element transform validates (in-dialect)", () => {
  const result = safeParseLinkageTerms({
    ...base,
    linkageKeys: [
      {
        name: "SSN",
        elements: [
          {
            field: "ssn",
            transform: [
              {
                function: "filter_regex",
                params: { pattern: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$" },
              },
            ],
          },
        ],
      },
    ],
  });
  expect(result.success).toBe(true);
});

test("an element-transform regex the engine cannot compile is rejected at validation (fail closed)", () => {
  const result = safeParseLinkageTerms({
    ...base,
    linkageKeys: [
      {
        name: "SSN",
        elements: [
          {
            field: "ssn",
            transform: [{ function: "filter_regex", params: { pattern: "(" } }],
          },
        ],
      },
    ],
  });
  expect(result.success).toBe(false);
  if (result.success) return;
  expect(result.error.issues[0].message).toMatch(/linear-time dialect/);
});

// --- pad_left length bound (partner-controlled allocation DoS) ----------------
// A pad_left element transform reads a partner-controlled `length` and runs
// padStart(length, char) per row over the full dataset; an unbounded value
// allocates a giant string per row and exhausts the acceptor's memory (the
// memory-allocation sibling of the ReDoS vector above). The bound is enforced at
// LinkageTermsSchema validation, before any per-row key-building allocation. (The
// factory's positive-integer runtime check is unit-tested in
// standardization.test.ts; these assert the schema-level wiring on the
// partner-parsed path.)

const padLeftTerms = (params: Record<string, unknown>) => ({
  ...base,
  linkageKeys: [
    {
      name: "SSN",
      elements: [
        { field: "ssn", transform: [{ function: "pad_left", params }] },
      ],
    },
  ],
});

test("an over-large pad_left length is rejected at validation, before any per-row allocation", () => {
  const result = safeParseLinkageTerms(padLeftTerms({ length: 1e9 }));
  expect(result.success).toBe(false);
  if (result.success) return;
  expect(result.error.issues[0].path).toContain("length");
  expect(result.error.issues[0].message).toMatch(
    /pad_left length must not exceed/,
  );
});

test("a real-sized pad_left length parses and is preserved (no clamp)", () => {
  // Preservation matters: PSI requires both parties to derive byte-identical
  // keys, so the bound must reject out-of-range values, never silently rewrite an
  // in-range one.
  const result = safeParseLinkageTerms(padLeftTerms({ length: 9 }));
  expect(result.success).toBe(true);
  if (!result.success) return;
  expect(result.data.linkageKeys[0].elements[0].transform?.[0].params).toEqual({
    length: 9,
  });
});

test("a pad_left length at exactly the maximum parses; one over it is rejected", () => {
  expect(
    safeParseLinkageTerms(padLeftTerms({ length: MAX_PAD_LEFT_LENGTH }))
      .success,
  ).toBe(true);
  expect(
    safeParseLinkageTerms(padLeftTerms({ length: MAX_PAD_LEFT_LENGTH + 1 }))
      .success,
  ).toBe(false);
});

test("a malformed pad_left length still validates, so the runtime factory check handles it", () => {
  // The schema adds only the upper bound; a non-positive, non-integer, or
  // non-numeric length is not pre-empted here -- padLeftFactory throws on it at
  // key-build time and the exchange aborts through the existing error boundary,
  // behavior unchanged by this hardening (the runtime throws are pinned in
  // standardization.test.ts). None of these is an allocation risk: padStart is
  // never reached for them.
  expect(safeParseLinkageTerms(padLeftTerms({ length: -5 })).success).toBe(
    true,
  );
  expect(safeParseLinkageTerms(padLeftTerms({ length: 1.5 })).success).toBe(
    true,
  );
  expect(safeParseLinkageTerms(padLeftTerms({ length: "9" })).success).toBe(
    true,
  );
});

// --- parse_date format-string bound (partner-controlled per-row regex DoS) ----
// parse_date builds a regex from `inputFormat` and assembles its result from
// `outputFormat`, recompiled per row by applyElementTransform over the full
// dataset. An unbounded format makes every row compile / allocate work
// proportional to its length -- bounded by the MAX_DATE_FORMAT_LENGTH refine at
// LinkageTermsSchema validation. The other risk -- the format's MM/DD
// tokens expanding into adjacent `(\d{1,2})` groups that catastrophically
// backtrack at a length well under that cap -- is closed by running parse_date
// on the linear-time engine (standardization.ts), so no separate screen is needed.
// (parse_date's runtime behavior is unit-tested in standardization.test.ts.)

const parseDateTerms = (params: Record<string, unknown>) => ({
  ...base,
  linkageKeys: [
    {
      name: "DOB",
      elements: [
        { field: "ssn", transform: [{ function: "parse_date", params }] },
      ],
    },
  ],
});

test("an over-large parse_date inputFormat is rejected by the length cap", () => {
  const result = safeParseLinkageTerms(
    parseDateTerms({ inputFormat: "x".repeat(MAX_DATE_FORMAT_LENGTH + 1) }),
  );
  expect(result.success).toBe(false);
  if (result.success) return;
  expect(result.error.issues[0].path).toContain("params");
  expect(result.error.issues[0].message).toMatch(
    /parse_date inputFormat and outputFormat must not exceed/,
  );
});

test("an over-large parse_date outputFormat is rejected by the length cap", () => {
  // outputFormat is assembled, not compiled, so only the length cap guards it.
  const result = safeParseLinkageTerms(
    parseDateTerms({ outputFormat: "x".repeat(MAX_DATE_FORMAT_LENGTH + 1) }),
  );
  expect(result.success).toBe(false);
});

test("a real-sized parse_date format parses and is preserved (no clamp)", () => {
  // camelizeKeys maps the snake_case wire keys to the camelCase the factory reads.
  const result = safeParseLinkageTerms(
    parseDateTerms({ input_format: "YYYY-MM-DD", output_format: "MM/DD/YYYY" }),
  );
  expect(result.success).toBe(true);
  if (!result.success) return;
  expect(result.data.linkageKeys[0].elements[0].transform?.[0].params).toEqual({
    inputFormat: "YYYY-MM-DD",
    outputFormat: "MM/DD/YYYY",
  });
});

test("a parse_date format at exactly the length maximum parses; one over is rejected", () => {
  expect(
    safeParseLinkageTerms(
      parseDateTerms({ inputFormat: "x".repeat(MAX_DATE_FORMAT_LENGTH) }),
    ).success,
  ).toBe(true);
  expect(
    safeParseLinkageTerms(
      parseDateTerms({ inputFormat: "x".repeat(MAX_DATE_FORMAT_LENGTH + 1) }),
    ).success,
  ).toBe(false);
});

test("a former-ReDoS parse_date inputFormat now validates (linear-time engine bounds it)", () => {
  // "MM".repeat(24) is 48 chars -- under the length cap -- and expands to 24
  // adjacent `(\d{1,2})` groups, which catastrophically backtrack on `new RegExp`.
  // parse_date compiles this under the linear-time engine, which bounds it by
  // construction, so the format is accepted (not rejected by a screen) and its
  // per-row match stays linear over the full dataset.
  const result = safeParseLinkageTerms(
    parseDateTerms({ inputFormat: "MM".repeat(24) }),
  );
  expect(result.success).toBe(true);
});

test("common parse_date formats validate", () => {
  for (const inputFormat of [
    "MM/DD/YYYY",
    "YYYY-MM-DD",
    "YYYYMMDD",
    "DD/MM/YYYY",
  ]) {
    expect(safeParseLinkageTerms(parseDateTerms({ inputFormat })).success).toBe(
      true,
    );
  }
});

test("an empty parse_date outputFormat is rejected", () => {
  // The one width-shaping param a partner can declare that fixes a width of
  // ZERO: the derived width of a parse_date element is the rendered layout's
  // own length (elementValueWidthBound, keyElementWidth.ts), and a zero
  // declares a key narrower than the one candidate the row builder emits for it
  // -- refusing an ordinary row over a step the partner authored. No ordinary
  // template declares a date that renders to nothing, so the shape is refused
  // where the document is read. The message names the parameter and echoes no
  // partner value.
  const result = safeParseLinkageTerms(parseDateTerms({ output_format: "" }));
  expect(result.success).toBe(false);
  if (result.success) return;
  expect(result.error.issues[0].path).toContain("outputFormat");
  expect(result.error.issues[0].message).toMatch(
    /parse_date outputFormat must not be empty/,
  );
  // One character is the narrowest layout that renders anything, and it parses.
  expect(
    safeParseLinkageTerms(parseDateTerms({ output_format: "Y" })).success,
  ).toBe(true);
  // An empty INPUT format is a different question -- it drops every value rather
  // than rendering a zero-width one -- and is left to the dead-pipeline grading.
  expect(
    safeParseLinkageTerms(parseDateTerms({ input_format: "" })).success,
  ).toBe(true);
});

test("a non-string parse_date format still validates, so the runtime factory handles it", () => {
  // Only a string format drives the regex build / output allocation; the factory
  // treats a non-string as an empty/absent format, so the length cap does not
  // pre-empt it (behavior unchanged).
  expect(
    safeParseLinkageTerms(parseDateTerms({ inputFormat: 123 })).success,
  ).toBe(true);
});

// --- substring integer bounds (partner-controlled non-integer hazard) --------
// substring slices by numeric `start` / `length`; a non-integer bound never
// slices as intended (the factory drops it to an all-null fn, silently excluding
// every row). The refine rejects a present non-integer bound at validation; the
// degenerate windows it does not express are refused by the dead-key grading.

const substringTerms = (params: Record<string, unknown>) => ({
  ...base,
  linkageKeys: [
    {
      name: "SSN",
      elements: [
        { field: "ssn", transform: [{ function: "substring", params }] },
      ],
    },
  ],
});

test("a non-integer substring start or length is rejected at validation", () => {
  for (const params of [
    { start: 1, length: "5" },
    { start: "1", length: 5 },
    { start: 1, length: 5.5 },
    { start: 1.5, length: 5 },
    { start: 1, length: true },
  ]) {
    const result = safeParseLinkageTerms(substringTerms(params));
    expect(result.success, JSON.stringify(params)).toBe(false);
    if (result.success) continue;
    expect(
      result.error.issues.some((i) =>
        /substring start and length must be integers/.test(i.message),
      ),
    ).toBe(true);
  }
});

test("integer substring bounds parse and are preserved", () => {
  const result = safeParseLinkageTerms(substringTerms({ start: 3, length: 5 }));
  expect(result.success).toBe(true);
  if (!result.success) return;
  expect(result.data.linkageKeys[0].elements[0].transform?.[0].params).toEqual({
    start: 3,
    length: 5,
  });
});

test("a degenerate substring window validates here and is refused by the dead-pipeline grading", () => {
  // These are not no-op steps: the factory reads no window for any value and
  // nulls every row, exactly as a present non-integer bound does. They pass this
  // shape-level refine because the refusal that reaches all of them -- an absent
  // bound, a `start` of 0, a `length` of 0 -- lives in the dead-key grading,
  // which names the offending key instead of costing the document its parse.
  for (const params of [
    {},
    { start: 3 },
    { length: 5 },
    { start: 0, length: 5 },
    { start: 3, length: 0 },
  ]) {
    const result = safeParseLinkageTerms(substringTerms(params));
    expect(result.success, JSON.stringify(params)).toBe(true);
    if (!result.success) continue;
    expect(
      pipelineAlwaysDrops(result.data.linkageKeys[0].elements[0].transform),
      JSON.stringify(params),
    ).toBe(true);
  }
  // Not vacuous: a window that reads something parses and is not graded dead.
  const live = safeParseLinkageTerms(substringTerms({ start: 3, length: 5 }));
  expect(live.success).toBe(true);
  if (!live.success) return;
  expect(
    pipelineAlwaysDrops(live.data.linkageKeys[0].elements[0].transform),
  ).toBe(false);
});

// --- transform regex pattern-length bound (source sanity pre-filter) --
// The four tier:"regex" functions compile their raw pattern / delimiter under the
// linear-time engine (compiled once per transform array, memoized).
// MAX_TRANSFORM_PATTERN_LENGTH caps the pattern SOURCE length -- a cheap sanity
// pre-filter on parse cost. Pin both edges of the cap.

const regexStepTerms = (fn: string, params: Record<string, unknown>) => ({
  ...base,
  linkageKeys: [
    {
      name: "RX",
      elements: [{ field: "ssn", transform: [{ function: fn, params }] }],
    },
  ],
});

test("a replace_regex pattern at the length cap parses; one over is rejected", () => {
  expect(
    safeParseLinkageTerms(
      regexStepTerms("replace_regex", {
        pattern: "a".repeat(MAX_TRANSFORM_PATTERN_LENGTH),
        replacement: "",
      }),
    ).success,
  ).toBe(true);
  const over = safeParseLinkageTerms(
    regexStepTerms("replace_regex", {
      pattern: "a".repeat(MAX_TRANSFORM_PATTERN_LENGTH + 1),
      replacement: "",
    }),
  );
  expect(over.success).toBe(false);
  if (over.success) return;
  expect(
    over.error.issues.some((i) =>
      /transform regex pattern must not exceed/.test(i.message),
    ),
  ).toBe(true);
});

test("the pattern-length cap also covers split_on's delimiter param", () => {
  // split_on keys on `delimiter`, not `pattern`; REGEX_STEP_PATTERN_PARAM maps it,
  // so the same cap must apply -- a regression if the map and the refine drift apart.
  expect(
    safeParseLinkageTerms(
      regexStepTerms("split_on", {
        delimiter: "a".repeat(MAX_TRANSFORM_PATTERN_LENGTH),
      }),
    ).success,
  ).toBe(true);
  expect(
    safeParseLinkageTerms(
      regexStepTerms("split_on", {
        delimiter: "a".repeat(MAX_TRANSFORM_PATTERN_LENGTH + 1),
      }),
    ).success,
  ).toBe(false);
});

test("a short non-string transform regex pattern still validates, so coercion handles it", () => {
  // A scalar non-string coerces to a short literal (String(123) === "123"), which
  // the gate and factory both compile, so the length cap does not pre-empt it.
  expect(
    safeParseLinkageTerms(
      regexStepTerms("replace_regex", { pattern: 123, replacement: "" }),
    ).success,
  ).toBe(true);
});

test("an oversized NON-string pattern (array) is caught by the length cap", () => {
  // The cap measures the COERCED source, not just string-typed values: an array
  // renders via String(...) to its comma-joined elements, so a long array would
  // otherwise slip an oversized compile source past the bound. coerceToPatternString
  // here mirrors exactly what the refine and the factory compile.
  const overlong = Array.from(
    { length: MAX_TRANSFORM_PATTERN_LENGTH },
    () => "a",
  ); // String(...) === "a,a,a,..." -- ~2x over the cap
  const result = safeParseLinkageTerms(
    regexStepTerms("replace_regex", { pattern: overlong, replacement: "" }),
  );
  expect(result.success).toBe(false);
  if (result.success) return;
  expect(
    result.error.issues.some((i) =>
      /transform regex pattern must not exceed/.test(i.message),
    ),
  ).toBe(true);
});

test("a transform regex outside the dialect is rejected by the gate", () => {
  // A backreference is a feature RE2 drops, so the engine cannot compile it; the
  // dialect gate rejects it fail-closed, before any row runs.
  const result = safeParseLinkageTerms(
    regexStepTerms("filter_regex", { pattern: "(a)\\1" }),
  );
  expect(result.success).toBe(false);
  if (result.success) return;
  expect(
    result.error.issues.some((i) =>
      /outside the linear-time dialect/.test(i.message),
    ),
  ).toBe(true);
});

// --- transform param content bound (partner-controlled per-row amplification) --
// Every STRING-valued transform param is capped at MAX_TRANSFORM_PARAM_LENGTH by
// the params record's value stage, whatever function reads it. A string param
// sizes what the rest of the element pipeline holds on every row -- a
// replace_regex `replacement` rewrites the operator's own cell into a value of the
// replacement's own size -- so the cap is uniform across params rather than per
// measured amplifier, and rejects at validation before any row runs.

const transformStepTerms = (fn: string, params: Record<string, unknown>) => ({
  ...base,
  linkageKeys: [
    {
      name: "PARAM",
      elements: [{ field: "ssn", transform: [{ function: fn, params }] }],
    },
  ],
});

const overBoundValue = "x".repeat(MAX_TRANSFORM_PARAM_LENGTH + 1);

test("a transform param at exactly the content bound parses; one over it is refused", () => {
  expect(
    safeParseLinkageTerms(
      transformStepTerms("replace_regex", {
        pattern: "\\d",
        replacement: "x".repeat(MAX_TRANSFORM_PARAM_LENGTH),
      }),
    ).success,
  ).toBe(true);
  expect(
    safeParseLinkageTerms(
      transformStepTerms("replace_regex", {
        pattern: "\\d",
        replacement: overBoundValue,
      }),
    ).success,
  ).toBe(false);
});

test("a megabyte-scale replacement is refused as a terms error, not a mid-run allocation", () => {
  // The measured amplifier: a 1 MB replacement over a 10-character operator cell
  // rewrites every row's value to a megabyte, which each later step of the element
  // then holds. The refusal lands at terms validation, before any row runs.
  const result = safeParseLinkageTerms(
    transformStepTerms("replace_regex", {
      pattern: "^.*$",
      replacement: "x".repeat(1_000_000),
    }),
  );
  expect(result.success).toBe(false);
  if (result.success) return;
  expect(
    result.error.issues.some((i) =>
      /transform param must not exceed/.test(i.message),
    ),
  ).toBe(true);
});

test("an operator-sized replacement parses and is preserved (no clamp)", () => {
  // Preservation matters: PSI requires both parties to derive byte-identical keys,
  // so the bound rejects an out-of-range value rather than rewriting an in-range
  // one. A real replacement is a few characters.
  const result = safeParseLinkageTerms(
    transformStepTerms("replace_regex", { pattern: "-", replacement: " " }),
  );
  expect(result.success).toBe(true);
  if (!result.success) return;
  expect(result.data.linkageKeys[0].elements[0].transform?.[0].params).toEqual({
    pattern: "-",
    replacement: " ",
  });
});

test("the refusal locates the offending step and param by issue path, echoing no value", () => {
  const result = safeParseLinkageTerms(
    transformStepTerms("replace_regex", {
      pattern: "\\d",
      replacement: overBoundValue,
    }),
  );
  expect(result.success).toBe(false);
  if (result.success) return;
  const issue = result.error.issues.find((i) =>
    /transform param must not exceed/.test(i.message),
  );
  expect(issue?.path).toEqual([
    "linkageKeys",
    0,
    "elements",
    0,
    "transform",
    0,
    "params",
    "replacement",
  ]);
  expect(issue?.message).not.toContain("xxxx");
});

test("the refusal's path holds the param name escaped, not raw", () => {
  // The path locates the offender, so it holds a partner-controlled param NAME
  // -- and for a name UNDER the key-length bound, which the `invalid_key` route
  // never flags, this refusal is the first issue to place it there. The relay the
  // terms exchange uses escapes each path segment at the source, so the raw bytes
  // do not reach the operator.
  const evilName = "\x1b[31m\u202eEVIL";
  const result = safeParseLinkageTerms(
    transformStepTerms("replace_regex", {
      pattern: "\\d",
      [evilName]: overBoundValue,
    }),
  );
  expect(result.success).toBe(false);
  if (result.success) return;
  const relayed = describeDecodeError(result.error);
  expect(relayed).not.toContain("\x1b");
  expect(relayed).not.toContain("\u202e");
  expect(relayed).toContain("\\x1b");
  expect(relayed).toContain("\\u202e");
});

test("the content bound covers every string param, not only the measured amplifiers", () => {
  // Uniform by construction: the bound sits on the params record's value stage, so
  // it holds for a param no per-function refine covers and for a function this
  // build does not implement -- neither can be the route content is smuggled
  // through.
  const cases: Array<[string, Record<string, unknown>]> = [
    ["coalesce", { default: overBoundValue }],
    ["null_if", { value: overBoundValue }],
    ["pad_left", { length: 9, char: overBoundValue }],
    ["phonetic", { algorithm: overBoundValue }],
    ["not_a_standardization_function", { anything: overBoundValue }],
  ];
  for (const [fn, params] of cases) {
    const result = safeParseLinkageTerms(transformStepTerms(fn, params));
    expect(result.success).toBe(false);
    if (result.success) continue;
    expect(
      result.error.issues.some((i) =>
        /transform param must not exceed/.test(i.message),
      ),
    ).toBe(true);
  }
});

test("parseLinkageTerms throws on an over-bound param (the initiator/joiner path)", () => {
  expect(() =>
    parseLinkageTerms(
      transformStepTerms("coalesce", { default: overBoundValue }),
    ),
  ).toThrow(ZodError);
});

test("a replacement holding substitution sequences parses at the bound", () => {
  // The schema's half of the magnitude control: this bound reads a param's
  // LENGTH, so a replacement whose every character pair is a `$'` substitution
  // sequence -- which re-inserts the operator's own cell at each match position
  // -- is accepted like any other 1000-character string, and the sequences keep
  // their wire meaning. What such a replacement DERIVES per row is bounded where
  // the row runs, by the ceiling on the produced value (pinned in
  // valueConstraints.test.ts); neutralizing the sequences here would have been a
  // wire-semantics change, and is not the closer taken
  // (docs/spec/CHANNEL_SECURITY.md, Unbounded transform-parameter rejection).
  const substituting = "$'".repeat(MAX_TRANSFORM_PARAM_LENGTH / 2);
  expect(substituting.length).toBe(MAX_TRANSFORM_PARAM_LENGTH);
  const result = safeParseLinkageTerms(
    transformStepTerms("replace_regex", {
      pattern: "a*",
      replacement: substituting,
    }),
  );
  expect(result.success).toBe(true);
  if (!result.success) return;
  expect(
    result.data.linkageKeys[0].elements[0].transform?.[0].params?.replacement,
  ).toBe(substituting);
});

test("a non-string param value is untouched by the content bound", () => {
  // Only a string param holds content the pipeline amplifies; a non-string is
  // left to the factory's own coercion contract (a non-string `replacement` falls
  // back to the empty string, pinned in standardization.test.ts), as a malformed
  // pad_left length is.
  expect(
    safeParseLinkageTerms(
      transformStepTerms("replace_regex", { pattern: "\\d", replacement: 42 }),
    ).success,
  ).toBe(true);
});

test("the bound reaches a param VALUE, not a string nested in an array- or object-valued param", () => {
  // The stated reach, both halves of it, pinned as behavior rather than left to
  // prose. Nothing derives a per-row value from a nested string: null_if compares
  // its `values` entries against the cell and emits the cell or null, and an array
  // a regex factory would render into a compile source is bounded on the COERCED
  // source by MAX_TRANSFORM_PATTERN_LENGTH (pinned above).
  expect(
    safeParseLinkageTerms(
      transformStepTerms("null_if", { values: [overBoundValue] }),
    ).success,
  ).toBe(true);
  expect(
    safeParseLinkageTerms(
      transformStepTerms("null_if", { value: { deep: overBoundValue } }),
    ).success,
  ).toBe(true);
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
  // The same field may appear twice when each occurrence has a distinct
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

// --- linkageFields and linkageKeys constraints --------------------------------

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

// --- linkageField type discriminated union ----------------------------

test("unknown linkage field type is rejected", () => {
  const result = safeParseLinkageTerms({
    ...base,
    linkageFields: [{ name: "bad", type: "favoriteColor" }],
  });
  expect(result.success).toBe(false);
});

// --- semantic-type enum values are snake_case (strict) -----------------------

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
// enforced on the wire rather than keeping a dual-spelling normalization shim.
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
  // These enums ride a partner-controlled invitation token and operator config
  // that may hold secrets, so the strict-rejection path must stay a static
  // error located by issue path -- protocolSetup leaves the Zod parse-error
  // message unsanitized, relying on the reachable issue codes (invalid
  // discriminator, invalid enum) reporting the EXPECTED options and the schema
  // path, not the received value. Pin that the offending camelCase value
  // is not exposed raw in the message, for both the semantic-type discriminator
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

// --- camelizeKeys integration ------------------------------------------------

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

// --- linkageStrategy schema --------------------------------------------------

describe("linkageStrategy", () => {
  // snake_case `linkage_strategy` exercises the camelize pre-pass for the new
  // field; the hyphenated VALUE "single-pass" is a value, not a key, so it is
  // left untouched by camelizeKeys.
  test("defaults to cascade when unspecified", () => {
    const result = parseLinkageTerms(base);
    expect(result.linkageStrategy).toBe("cascade");
  });

  test("parses an explicit cascade", () => {
    const result = parseLinkageTerms({ ...base, linkage_strategy: "cascade" });
    expect(result.linkageStrategy).toBe("cascade");
  });

  test("parses single-pass", () => {
    const result = parseLinkageTerms({
      ...base,
      linkage_strategy: "single-pass",
    });
    expect(result.linkageStrategy).toBe("single-pass");
  });

  test("rejects an unknown strategy", () => {
    const result = safeParseLinkageTerms({
      ...base,
      linkage_strategy: "two-pass",
    });
    expect(result.success).toBe(false);
  });
});

// --- Untrusted-input bounds --------------------------------------------------
// These terms ride inside an invitation token whose only integrity check is a
// transcription checksum anyone can recompute, so each partner-controlled
// free-text and array field holds a generous `.max()`. The bounds are wide
// enough that no real configuration hits them (asserted by the boundary-accept
// cases) but still refuse a token padded to exhaust the recipient.

test("accepts terms holding no identity, and round-trips the absence", () => {
  // `identity` is optional: a party that supplied no name sends terms with the
  // key absent, and nothing downstream substitutes one. Parsing must leave the
  // field absent rather than materializing an empty string or a default, since
  // every surface treats that absence as "this party named itself none".
  const { identity: _unnamed, ...withoutIdentity } = base;
  const parsed = parseLinkageTerms(withoutIdentity);
  expect(parsed.identity).toBeUndefined();
  expect("identity" in parsed).toBe(false);
  // Round-trip: what the schema emits parses back to the same absence, so the
  // document a party sends and the one its partner reads agree.
  const reparsed = parseLinkageTerms(JSON.parse(JSON.stringify(parsed)));
  expect(reparsed).toEqual(parsed);
  expect("identity" in reparsed).toBe(false);
});

test("rejects an empty identity, which is a name nobody chose", () => {
  // Optional does not mean emptiable: a party either names itself or omits the
  // field. An empty label would print as a blank where a name belongs.
  expect(() => parseLinkageTerms({ ...base, identity: "" })).toThrow(ZodError);
});

test("two parties may differ on whether either is named", () => {
  // Consistency on `identity` is "none", and that holds across its absence: a
  // named party and an unnamed one exchange without a compatibility complaint.
  // A mutually satisfiable pair: `base` withholds its own result, which is an
  // output mismatch against itself and would mask what this asserts.
  const mutual = {
    ...base,
    output: { expectsOutput: true, shareWithPartner: true },
  };
  const named = parseLinkageTerms({ ...mutual, identity: "Party A" });
  const { identity: _unnamed, ...withoutIdentity } = mutual;
  const unnamed = parseLinkageTerms(withoutIdentity);
  expect(validateCompatibility(named, unnamed).errors).toEqual([]);
  expect(validateCompatibility(unnamed, named).errors).toEqual([]);
});

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

// --- Free-text control-character rule ----------------------------------------
// The document's four free-text fields -- the party `identity`, the legal
// agreement's `purpose`, a payload column's `description`, and each constraint
// `exclude` value -- hold one rule between them: no C0 control (NUL included),
// no DEL, no C1, and no exception for tab, line feed, or carriage return. The
// cases below pin the reach (every one of the four refuses) and the two edges
// the rule is drawn at: a control character is refused wherever it sits, and a
// value written in letters outside ASCII is not.

const NUL = "\u0000";
const ESC = "\u001b";
const DEL = "\u007f";
const C1_NEXT_LINE = "\u0085";
// The first code point above the refused C1 range, so the accepted case pins the
// upper edge of the rule rather than only sitting well clear of it.
const NBSP = "\u00a0";

// A denylist entry, a description, and a purpose alongside the identity, so a
// case that varies one field leaves the other three holding real values.
const freeTextTerms = (overrides: {
  identity?: string;
  purpose?: string;
  description?: string;
  exclude?: string;
}) => ({
  ...base,
  identity: overrides.identity ?? "Agency A",
  linkageFields: [
    {
      name: "ssn",
      type: "ssn",
      constraints: { exclude: [overrides.exclude ?? "123456789"] },
    },
  ],
  payload: {
    send: [
      {
        name: "enrollment_date",
        description: overrides.description ?? "Date of enrollment",
      },
    ],
  },
  legalAgreement: {
    reference: "MOU-2025-0042",
    purpose: overrides.purpose ?? "Audit of the State tutoring program",
    expirationDate: "2030-12-31",
  },
});

test("rejects an identity holding a NUL", () => {
  expect(() =>
    parseLinkageTerms(freeTextTerms({ identity: `Agency${NUL} A` })),
  ).toThrow(ZodError);
});

test.each([
  ["an ESC", ESC],
  ["a DEL", DEL],
  ["a C1 control", C1_NEXT_LINE],
  ["a tab", "\t"],
  ["a line feed", "\n"],
  ["a carriage return", "\r"],
])("rejects an identity holding %s", (_label, control) => {
  // Tab, LF, and CR take no exception here, unlike a note authored in a
  // multi-line field: an identity is a single-line label bound into the
  // exchange record, so whitespace controls are as unmeant as an ESC is.
  expect(() =>
    parseLinkageTerms(freeTextTerms({ identity: `Agency${control}A` })),
  ).toThrow(ZodError);
});

test("rejects a legal agreement purpose holding a control character", () => {
  expect(() =>
    parseLinkageTerms(freeTextTerms({ purpose: `Audit${NUL} of the program` })),
  ).toThrow(ZodError);
});

test("rejects a payload column description holding a control character", () => {
  expect(() =>
    parseLinkageTerms(freeTextTerms({ description: `Date${ESC}[2J` })),
  ).toThrow(ZodError);
});

test("rejects a constraint exclude value holding a control character", () => {
  expect(() =>
    parseLinkageTerms(freeTextTerms({ exclude: `123456789${NUL}` })),
  ).toThrow(ZodError);
});

test("accepts free text holding non-ASCII letters", () => {
  // The refused ranges stop below U+00A0, so a party writing its name, its
  // purpose, or its denylist in its own script is admissible -- as is the
  // no-break space at that first admitted code point, placed in the identity
  // here so the boundary is pinned from above as well as below.
  expect(() =>
    parseLinkageTerms(
      freeTextTerms({
        identity: `Ministère de la Santé,${NBSP}Zoë Ångström, 厚生労働省`,
        purpose: "Évaluation du programme national",
        description: "Fecha de inscripción",
        exclude: "señor",
      }),
    ),
  ).not.toThrow();
});

test("the control-character refusal names the field by path, not the value", () => {
  // The parse-error path is left unsanitized where the terms exchange relays it
  // (protocolSetup), so the issue must locate the offender by `path` and say
  // nothing about the bytes submitted.
  const result = safeParseLinkageTerms(
    freeTextTerms({ identity: `Agency A${NUL}unrepeatable-label` }),
  );
  expect(result.success).toBe(false);
  if (result.success) return;
  expect(result.error.issues.map((issue) => issue.path.join("."))).toContain(
    "identity",
  );
  const rendered = JSON.stringify(result.error.issues);
  expect(rendered).toContain(TEXT_CONTROL_CHAR_MESSAGE);
  expect(rendered).not.toContain("unrepeatable-label");
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

test("over-long allowedCharacters is rejected without compiling the class", () => {
  // "z-a" is an invalid (reversed) range: had the refine compiled this value it
  // would have produced the class-validity message. The value is also over the
  // length cap, so the refine's length short-circuit rejects on length alone and
  // never reaches the compiler. The absence of the class-validity message proves
  // the value was not compiled.
  const result = safeParseLinkageTerms({
    ...base,
    linkageFields: [
      {
        name: "firstName",
        type: "first_name",
        constraints: {
          allowedCharacters: "z-a" + "a".repeat(MAX_NAME_LENGTH),
        },
      },
    ],
    linkageKeys: [{ name: "FN", elements: [{ field: "firstName" }] }],
  });
  expect(result.success).toBe(false);
  if (result.success) return;
  expect(
    result.error.issues.some((issue) => /character class/.test(issue.message)),
  ).toBe(false);
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
    // A single count-bound issue, not one per key, and it holds no partner key
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
  // the parse-error sanitization relies on.
  const result = safeParseLinkageTerms(
    paramsTerms({ ["k".repeat(MAX_NAME_LENGTH + 1)]: 1 }),
  );
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues[0].code).toBe("invalid_key");
  }
});

test("an over-count transform params record is rejected without the per-key camelize rewrite or record validation", () => {
  // Pins the guard's defining property: the over-count
  // rejection skips the two EXPENSIVE per-key passes -- the snake->camel camelize
  // rewrite and the permissive record stage's per-key validation -- that an
  // over-count record would otherwise incur. The key count itself is still O(n)
  // (V8 enumerates eagerly; see exceedsOwnKeyCount); what this test catches is a
  // regression that subjects every key to the rewrite or to per-key parsing. A
  // Proxy tallies per-key property-descriptor reads: the count via for...in reads
  // descriptors lazily and stops at the bound, whereas a camelize rewrite
  // (Object.entries over every key) or a record-stage parse (a ZodType per key)
  // would read all TOTAL of them. So a bounded tally proves both expensive passes
  // were skipped; a tally near TOTAL would mean one of them ran.
  const TOTAL = 100_000;
  let inspected = 0;
  const params = new Proxy(
    {},
    {
      ownKeys: () => Array.from({ length: TOTAL }, (_, i) => `k${i}`),
      getOwnPropertyDescriptor: () => {
        inspected++;
        return { enumerable: true, configurable: true, value: 1 };
      },
      get: () => 1,
    },
  );
  const result = safeParseLinkageTerms(paramsTerms(params));
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(
      result.error.issues.some((i) => /must not exceed/.test(i.message)),
    ).toBe(true);
  }
  // Far below TOTAL: a camelize rewrite or per-key record parse would push this to
  // at least TOTAL.
  expect(inspected).toBeLessThan(MAX_PARAMS_ENTRIES * 10);
});

// --- Nested-collection count bounds ------------------------------------------
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

// --- Payload send/receive count bounds ---------------------------------------
// payload.send / payload.receive are partner-controlled column lists sitting one
// object-frame below the root, so they do not drive the ~130k STACK overflow the
// nested collections hit -- but at ~3.5M invalid entries Zod throws `Invalid
// string length` building its error string (a RangeError that safeParse does NOT
// catch). Unlike the post-handshake wire arrays, a payload legitimately holds at
// most a few hundred columns, so a count gate (MAX_PAYLOAD_ENTRIES, applied
// before per-element validation) fits. `base` declares expectsOutput: true, so a
// non-empty `receive` is permitted by the cross-field refine. A count past the
// camelize node budget (MAX_NODE_COUNT) is rejected by that budget before Zod;
// the count gate handles a moderate over-count that stays under it.

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

test("a pathological-count payload send list is rejected by the node budget, not with a RangeError", () => {
  // ~4M entries, past both the camelize node budget (MAX_NODE_COUNT) and the
  // ~3.5M `Invalid string length` threshold the unbounded schema hit. The
  // camelize pre-pass fronts the boundedArray count gate: an over-budget partner
  // collection is rejected by that budget before the O(n) walk -- and so before
  // Zod (path b) -- never a RangeError. safeParseLinkageTerms ABSORBS that
  // bound into a { success: false } result (the "safe" contract) instead of
  // throwing, so the rejection appears as the node-count issue, not an
  // exception.
  const send = Array.from({ length: 4_000_000 }, () => 123);
  let result: ReturnType<typeof safeParseLinkageTerms> | undefined;
  expect(() => {
    result = safeParseLinkageTerms(sendTerms(send));
  }).not.toThrow();
  expect(result?.success).toBe(false);
  expect(result?.success === false && result.error.issues[0]?.message).toBe(
    `input node count exceeds the maximum of ${MAX_NODE_COUNT}`,
  );
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

test("a pathological-count payload receive list is rejected by the node budget, not with a RangeError", () => {
  const receive = Array.from({ length: 4_000_000 }, () => 123);
  let result: ReturnType<typeof safeParseLinkageTerms> | undefined;
  expect(() => {
    result = safeParseLinkageTerms(receiveTerms(receive));
  }).not.toThrow();
  expect(result?.success).toBe(false);
  expect(result?.success === false && result.error.issues[0]?.message).toBe(
    `input node count exceeds the maximum of ${MAX_NODE_COUNT}`,
  );
});

// --- Top-level linkageFields / linkageKeys count bounds ----------------------
// These two flat top-level arrays sit directly below the root, so a pathological
// count does not overflow the call stack -- but a partner array of millions of
// invalid entries still makes Zod throw `Invalid string length` building its
// error from one issue per entry, because a bare `.max()` is checked only AFTER
// per-element validation. They take the boundedArray count gate (fired before
// per-element validation), with a .min(1) floor. A
// count past the camelize node budget (MAX_NODE_COUNT) is rejected by that budget
// before Zod; the count gate handles a moderate over-count that stays under it.

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

test("a pathological-count linkageFields is rejected by the node budget, not with a RangeError", () => {
  // ~4M entries, past both the camelize node budget (MAX_NODE_COUNT) and the
  // ~3.5M `Invalid string length` threshold the `.max()`-only schema hit. The
  // camelize node budget fronts the boundedArray count gate, rejecting the
  // over-budget array by that budget before the walk -- and so before Zod (path
  // b) -- never a RangeError. safeParseLinkageTerms absorbs the bound into a
  // { success: false } result rather than throwing (the "safe" contract).
  const fields = Array.from({ length: 4_000_000 }, () => 123);
  let result: ReturnType<typeof safeParseLinkageTerms> | undefined;
  expect(() => {
    result = safeParseLinkageTerms(linkageFieldsTerms(fields));
  }).not.toThrow();
  expect(result?.success).toBe(false);
  expect(result?.success === false && result.error.issues[0]?.message).toBe(
    `input node count exceeds the maximum of ${MAX_NODE_COUNT}`,
  );
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

test("a pathological-count linkageKeys is rejected by the node budget, not with a RangeError or a TypeError", () => {
  // ~4M entries, past the camelize node budget (MAX_NODE_COUNT). The node budget
  // fronts the boundedArray count gate, rejecting the over-budget array by that
  // budget before the walk -- and so before Zod (path b) -- never a RangeError,
  // and never the TypeError a raw non-object key would drive at the terms-level
  // refine (the over-budget array never reaches it). safeParseLinkageTerms
  // absorbs the bound into a { success: false } result rather than throwing (the
  // "safe" contract). The boundedArray `abort` that
  // guards that refine for a sub-budget over-count is pinned by the next test.
  const keys = Array.from({ length: 4_000_000 }, () => 123);
  let result: ReturnType<typeof safeParseLinkageTerms> | undefined;
  expect(() => {
    result = safeParseLinkageTerms(linkageKeysTerms(keys));
  }).not.toThrow();
  expect(result?.success).toBe(false);
  expect(result?.success === false && result.error.issues[0]?.message).toBe(
    `input node count exceeds the maximum of ${MAX_NODE_COUNT}`,
  );
});

test("an over-count linkageKeys of raw non-object entries aborts to a clean count issue", () => {
  // The boundedArray `abort` short-circuits an over-count array to the count
  // issue instead of letting the raw `unknown[]` flow to the terms-level refines
  // (which do `key.elements.map(...)` and would TypeError on a raw non-object
  // entry). Exercised JUST over MAX_LINKAGE_ENTRIES -- under the camelize node
  // budget -- so the boundedArray gate, not the node budget, is what rejects it,
  // and safeParse returns a clean result rather than throwing.
  const keys = Array.from({ length: MAX_LINKAGE_ENTRIES + 1 }, () => 123);
  const result = safeParseLinkageTerms(linkageKeysTerms(keys));
  expect(result.success).toBe(false);
  if (!result.success) {
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

describe("referencedLinkageFieldNames", () => {
  test("returns the union of element fields across keys, deduplicated", () => {
    const keys: LinkageKey[] = [
      { name: "k1", elements: [{ field: "a" }, { field: "b" }] },
      { name: "k2", elements: [{ field: "b" }, { field: "c" }] },
    ];
    expect(referencedLinkageFieldNames(keys)).toEqual(new Set(["a", "b", "c"]));
  });

  test("is unaffected by a key's swap directive", () => {
    // swap only permutes which slot holds which field at receive time, so the
    // union of referenced fields is identical with or without it -- the property
    // that lets every caller pass keys as authored, without resolving swap.
    const swapped: LinkageKey[] = [
      {
        name: "k",
        elements: [{ field: "a" }, { field: "b" }],
        swap: ["a", "b"],
      },
    ];
    expect(referencedLinkageFieldNames(swapped)).toEqual(new Set(["a", "b"]));
  });

  test("returns an empty set for no keys", () => {
    expect(referencedLinkageFieldNames([])).toEqual(new Set<string>());
  });
});

describe("linkageRuleSet", () => {
  const citation = {
    fieldSet: { name: "baseline-pii", version: "1.0.0" },
    keySet: { name: "hmis-keys", version: "1.0.0" },
  };

  test("parses a citation and leaves a document without one alone", () => {
    expect(
      parseLinkageTerms({ ...base, linkage_rule_set: citation }).linkageRuleSet,
    ).toStrictEqual(citation);
    expect(parseLinkageTerms(base).linkageRuleSet).toBeUndefined();
  });

  test("refuses a half-declared citation and a non-semver set version", () => {
    expect(() =>
      parseLinkageTerms({
        ...base,
        linkage_rule_set: { field_set: citation.fieldSet },
      }),
    ).toThrow(ZodError);
    expect(() =>
      parseLinkageTerms({
        ...base,
        linkage_rule_set: {
          ...citation,
          keySet: { name: "hmis-keys", version: "1" },
        },
      }),
    ).toThrow(ZodError);
    expect(() =>
      parseLinkageTerms({
        ...base,
        linkage_rule_set: {
          ...citation,
          keySet: { name: "", version: "1.0.0" },
        },
      }),
    ).toThrow(ZodError);
  });

  test("cancels the exchange when the two parties cite different sets", () => {
    const local = parseLinkageTerms({ ...base, linkage_rule_set: citation });
    const partner = parseLinkageTerms({
      ...base,
      output: { expectsOutput: false, shareWithPartner: true },
      linkage_rule_set: {
        ...citation,
        keySet: { name: "hmis-keys", version: "2.0.0" },
      },
    });
    const { errors } = validateCompatibility(local, partner);
    expect(errors).toEqual([
      'linkage rule set mismatch: local names "hmis-keys" 1.0.0 over ' +
        '"baseline-pii" 1.0.0, partner names "hmis-keys" 2.0.0 over ' +
        '"baseline-pii" 1.0.0',
    ]);
    // Symmetric: both parties reach the same verdict from their own copy.
    expect(validateCompatibility(partner, local).errors).toHaveLength(1);
  });

  test("delimits a partner set name that holds the clause's own connective", () => {
    // The name is free text the partner chooses, so an undelimited one could pass
    // itself off as the whole clause: "keys 1.0.0 over pii" as a name would be
    // treated as a rule set the partner does not cite. The quotes keep each
    // name one value.
    const local = parseLinkageTerms({ ...base, linkage_rule_set: citation });
    const partner = parseLinkageTerms({
      ...base,
      output: { expectsOutput: false, shareWithPartner: true },
      linkage_rule_set: {
        ...citation,
        keySet: { name: "hmis-keys 9.9.9 over baseline-pii", version: "1.0.0" },
      },
    });
    expect(validateCompatibility(local, partner).errors).toEqual([
      'linkage rule set mismatch: local names "hmis-keys" 1.0.0 over ' +
        '"baseline-pii" 1.0.0, partner names ' +
        '"hmis-keys 9.9.9 over baseline-pii" 1.0.0 over "baseline-pii" 1.0.0',
    ]);
  });

  test("is skipped where either party cites nothing", () => {
    // A hand-authored document holds no citation, and holding it to the
    // partner's would refuse an exchange whose fields and keys match exactly.
    const cited = parseLinkageTerms({ ...base, linkage_rule_set: citation });
    const uncited = parseLinkageTerms({
      ...base,
      output: { expectsOutput: false, shareWithPartner: true },
    });
    expect(validateCompatibility(cited, uncited).errors).toEqual([]);
    expect(validateCompatibility(uncited, cited).errors).toEqual([]);
  });

  test("agrees when the two parties cite the same set in either property order", () => {
    const local = parseLinkageTerms({ ...base, linkage_rule_set: citation });
    const partner = parseLinkageTerms({
      ...base,
      output: { expectsOutput: false, shareWithPartner: true },
      linkage_rule_set: {
        key_set: { version: "1.0.0", name: "hmis-keys" },
        field_set: { version: "1.0.0", name: "baseline-pii" },
      },
    });
    expect(validateCompatibility(local, partner).errors).toEqual([]);
  });

  test("is adopted verbatim by an acceptor, so both parties record one citation", () => {
    const inviter = parseLinkageTerms({ ...base, linkage_rule_set: citation });
    const derived = deriveAcceptedLinkageTerms(inviter, "Accepting Org");
    expect(derived.linkageRuleSet).toStrictEqual(citation);
    expect(validateCompatibility(inviter, derived).errors).toEqual([]);
  });
});
