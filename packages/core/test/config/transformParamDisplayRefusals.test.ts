import { describe, expect, test } from "vitest";

import { summarizeInvitation } from "../../src/consent/invitationSummary";
import {
  MAX_TRANSFORM_PARAM_LENGTH,
  safeParseLinkageTerms,
  safeParseLinkageTermsTheReaderWrote,
} from "../../src/config/linkageTermsSchema";
import type {
  LinkageTerms,
  TransformStep,
} from "../../src/config/linkageTermsSchema";
import { safeParseStandardization } from "../../src/config/standardizationSchema";
import {
  MAX_DISPLAYED_PARAMS,
  NULL_IF_BOTH_VALUE_PARAMS_MESSAGE,
  PRIVATE_KEY_PARAM_MESSAGE,
  TRANSFORM_PARAM_COUNT_MESSAGE,
} from "../../src/config/transformParamDisplay";

// An obviously fake key block, whose BEGIN and END markers are what the
// display's redaction matches.
const FAKE_PRIVATE_KEY = [
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "MIIByteslookingsecret0123456789ABCDEFabcdef+/wEHEHE",
  "-----END OPENSSH PRIVATE KEY-----",
].join("\n");

// The values a document below declares. A refusal states a fixed literal and
// locates the offending param by its path, so none of these may reach a
// message: an acceptor is shown a decode error as it stands
// (describeDecodeError.ts).
const DECLARED_VALUES = [
  FAKE_PRIVATE_KEY,
  "MIIByteslookingsecret",
  "PARTNER_PLACEHOLDER",
  "partner_value",
];

const termsWithStep = (step: TransformStep): LinkageTerms => ({
  version: "1.0.0",
  identity: "Test Party",
  date: "2025-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: false },
  deduplicate: false,
  linkageFields: [{ name: "ssn", type: "ssn" }],
  linkageKeys: [
    { name: "SSN", elements: [{ field: "ssn", transform: [step] }] },
  ],
});

const standardizationWithStep = (step: TransformStep) => [
  { output: "ssn", input: "SSN", steps: [step] },
];

/**
 * Every message each of the three decode points raises for a step, or an
 * empty array from a decode point that accepted it.
 */
function refusalsOf(step: TransformStep): {
  partnerTerms: string[];
  ownTerms: string[];
  standardization: string[];
} {
  const messagesOf = (result: {
    success: boolean;
    error?: { issues: Array<{ message: string }> };
  }): string[] =>
    result.success ? [] : (result.error?.issues.map((i) => i.message) ?? []);
  return {
    partnerTerms: messagesOf(safeParseLinkageTerms(termsWithStep(step))),
    ownTerms: messagesOf(
      safeParseLinkageTermsTheReaderWrote(termsWithStep(step)),
    ),
    standardization: messagesOf(
      safeParseStandardization(standardizationWithStep(step)),
    ),
  };
}

function expectRefusedEverywhere(step: TransformStep, message: string): void {
  const refusals = refusalsOf(step);
  for (const [decodePoint, messages] of Object.entries(refusals)) {
    expect(messages, decodePoint).toContain(message);
    for (const declared of DECLARED_VALUES)
      for (const raised of messages)
        expect(raised, decodePoint).not.toContain(declared);
  }
}

function expectAcceptedEverywhere(step: TransformStep): void {
  const refusals = refusalsOf(step);
  for (const [decodePoint, messages] of Object.entries(refusals))
    expect(messages, decodePoint).toEqual([]);
}

/** The params the consent summary paints for a step, in display order. */
function displayedParamsOf(step: TransformStep): string[] {
  const summary = summarizeInvitation({ linkageTerms: termsWithStep(step) });
  return summary.linkageKeys[0].elements[0].transforms[0].params.map(String);
}

describe("a null_if step declaring both value and values", () => {
  const bothDeclared = {
    function: "null_if",
    params: { value: "PARTNER_PLACEHOLDER", values: ["partner_value"] },
  };

  test("is refused at every decode point", () => {
    expectRefusedEverywhere(bothDeclared, NULL_IF_BOTH_VALUE_PARAMS_MESSAGE);
  });

  test("would have been displayed as both, where only the list runs", () => {
    // What the refusal removes: a summary painting the single value beside the
    // list, of which `nullIfFactory` applies the list alone.
    expect(displayedParamsOf(bothDeclared)).toEqual([
      "value: PARTNER_PLACEHOLDER",
      'values: ["partner_value"]',
    ]);
  });

  test.each([
    ["value", { value: "PARTNER_PLACEHOLDER" }],
    ["values", { values: ["partner_value"] }],
  ])("declaring %s alone parses", (_name, params) => {
    expectAcceptedEverywhere({ function: "null_if", params });
  });
});

describe("a transform param holding private key material", () => {
  const keyInValue = {
    function: "coalesce",
    params: { default: FAKE_PRIVATE_KEY },
  };

  test("is refused at every decode point", () => {
    expectRefusedEverywhere(keyInValue, PRIVATE_KEY_PARAM_MESSAGE);
  });

  test("is refused where the material sits inside a list entry", () => {
    // A list value is displayed JSON-encoded, so its entries meet the same
    // redaction the record's own string values do.
    expectRefusedEverywhere(
      { function: "null_if", params: { values: [FAKE_PRIVATE_KEY] } },
      PRIVATE_KEY_PARAM_MESSAGE,
    );
  });

  test("is refused where the material has no END marker", () => {
    // The redaction's dangling rule replaces from a lone BEGIN marker to the
    // end of the text, so a sliced block is the same display difference.
    expectRefusedEverywhere(
      {
        function: "coalesce",
        params: { default: "-----BEGIN RSA PRIVATE KEY-----\nMIIBytes" },
      },
      PRIVATE_KEY_PARAM_MESSAGE,
    );
  });

  test("would have been displayed as the redaction marker", () => {
    // What the refusal removes: a line stating a marker where the step injects
    // the declared literal.
    expect(displayedParamsOf(keyInValue)).toEqual([
      "default: [redacted private key]",
    ]);
  });

  test("a value that mentions a key without holding one parses", () => {
    expectAcceptedEverywhere({
      function: "coalesce",
      params: { default: "use the private key at /keys/id_ed25519" },
    });
  });
});

describe("a string param longer than the terms schema admits", () => {
  // The key-material scan renders a param as its displayed line and runs the
  // redaction over that copy, work linear in the value. A string the calling
  // schema already refuses for its length is passed over instead, so a
  // partner's over-long value costs the length compare alone.
  const LENGTH_MESSAGE = `a linkage key element transform param must not exceed ${MAX_TRANSFORM_PARAM_LENGTH} characters`;
  const overBound = {
    function: "coalesce",
    params: {
      default: FAKE_PRIVATE_KEY + "x".repeat(MAX_TRANSFORM_PARAM_LENGTH),
    },
  };

  test("meets the length refusal alone where that bound is applied", () => {
    const refusals = refusalsOf(overBound);
    expect(refusals.partnerTerms).toEqual([LENGTH_MESSAGE]);
    expect(refusals.ownTerms).toEqual([LENGTH_MESSAGE]);
  });

  test("is still scanned by the schema that bounds no param length", () => {
    // The operator-local standardization schema refuses nothing for length, so
    // passing the value over there would drop the refusal rather than spare a
    // second one.
    expect(refusalsOf(overBound).standardization).toEqual([
      PRIVATE_KEY_PARAM_MESSAGE,
    ]);
  });

  test("a value at the bound holding key material is refused everywhere", () => {
    const atBound = {
      function: "coalesce",
      params: {
        default: FAKE_PRIVATE_KEY.padEnd(MAX_TRANSFORM_PARAM_LENGTH, "x"),
      },
    };
    expectRefusedEverywhere(atBound, PRIVATE_KEY_PARAM_MESSAGE);
    expect(refusalsOf(atBound).partnerTerms).toEqual([
      PRIVATE_KEY_PARAM_MESSAGE,
    ]);
  });

  test("key material inside a longer list entry is refused everywhere", () => {
    // The skip reads the length bound as the refine that applies it does: a
    // string value of the record, never a string nested in a list, whose
    // length no schema bounds.
    expectRefusedEverywhere(
      {
        function: "null_if",
        params: {
          values: [FAKE_PRIVATE_KEY + "x".repeat(MAX_TRANSFORM_PARAM_LENGTH)],
        },
      },
      PRIVATE_KEY_PARAM_MESSAGE,
    );
  });
});

describe("a step declaring more params than are displayed", () => {
  const paramsNumbering = (count: number): Record<string, unknown> =>
    Object.fromEntries(
      Array.from({ length: count }, (_, i) => [`p${i}`, `partner_value`]),
    );
  const stepDeclaring = (count: number) => ({
    function: "trim",
    params: paramsNumbering(count),
  });

  test("is refused at every decode point", () => {
    expectRefusedEverywhere(
      stepDeclaring(MAX_DISPLAYED_PARAMS + 1),
      TRANSFORM_PARAM_COUNT_MESSAGE,
    );
  });

  test("raises that one refusal however wide the record is", () => {
    // The issue count one step raises stays bounded by the cap rather than
    // growing with the record, which is what keeps a safe parse safe.
    const refusals = refusalsOf(stepDeclaring(200));
    expect(refusals.partnerTerms).toEqual([TRANSFORM_PARAM_COUNT_MESSAGE]);
    expect(refusals.standardization).toEqual([TRANSFORM_PARAM_COUNT_MESSAGE]);
  });

  test("a step at exactly the cap parses and is displayed whole", () => {
    const atCap = stepDeclaring(MAX_DISPLAYED_PARAMS);
    expectAcceptedEverywhere(atCap);
    const displayed = displayedParamsOf(atCap);
    expect(displayed).toHaveLength(MAX_DISPLAYED_PARAMS);
    expect(displayed.some((line) => line.includes("more"))).toBe(false);
  });

  test("one param past the cap would have been displayed as a count", () => {
    // What the refusal removes: a count line standing for params the run
    // applies in full.
    const displayed = displayedParamsOf(
      stepDeclaring(MAX_DISPLAYED_PARAMS + 1),
    );
    expect(displayed[displayed.length - 1]).toBe("... 1 more");
  });
});

describe("a param declared with an explicit undefined value", () => {
  // No JSON or YAML document holds one, so this is the shape an in-process
  // caller passes; the record schema keeps the key, and the summary paints a
  // row for it. Both sides read one count (`declaredParamEntries`).
  const stepDeclaring = (declared: number) => ({
    function: "trim",
    params: {
      ...Object.fromEntries(
        Array.from({ length: declared - 1 }, (_, i) => [
          `p${i}`,
          "partner_value",
        ]),
      ),
      unset: undefined,
    },
  });

  test("takes a displayed row of its own", () => {
    expect(displayedParamsOf(stepDeclaring(1))).toEqual(["unset: "]);
  });

  test("counts toward the cap at the refusal as at the display", () => {
    const atCap = stepDeclaring(MAX_DISPLAYED_PARAMS);
    expectAcceptedEverywhere(atCap);
    const displayed = displayedParamsOf(atCap);
    expect(displayed).toHaveLength(MAX_DISPLAYED_PARAMS);
    expect(displayed.some((line) => line.includes("more"))).toBe(false);
  });

  test("one param past the cap is refused rather than excluded", () => {
    // What the refusal removes: a count line standing for params the run
    // applies, which an unset key past the cap would otherwise reach.
    const pastCap = stepDeclaring(MAX_DISPLAYED_PARAMS + 1);
    expectRefusedEverywhere(pastCap, TRANSFORM_PARAM_COUNT_MESSAGE);
    const displayed = displayedParamsOf(pastCap);
    expect(displayed[displayed.length - 1]).toBe("... 1 more");
  });
});
