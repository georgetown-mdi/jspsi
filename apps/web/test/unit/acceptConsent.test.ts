import { describe, expect, test } from "vitest";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { MantineProvider } from "@mantine/core";

import {
  STANDARDIZATION_FUNCTION_NAMES,
  generateSharedSecret,
} from "@psilink/core";

import { AcceptInvitationPanel } from "@components/AcceptInvitationPanel";

import {
  TRANSFORM_FUNCTION_GLOSSARY,
  summarizeInvitation,
} from "@psi/invitationSummary";
import { commitAcceptance } from "@psi/acceptConsent";

import type { ReactElement } from "react";

import type {
  InvitationToken,
  LinkageKeyElement,
  LinkageTerms,
} from "@psilink/core";

import type { AcceptableInvitation } from "@psi/acceptInvitation";
import type { DecodeState } from "@components/AcceptInvitationPanel";

// Untrusted, inviter-crafted control characters JSX escaping does not
// neutralize, built from escapes so the source carries no raw control bytes: an
// ESC that drives ANSI, a right-to-left override, and a BEL.
const ESC = "\u001b";
const RLO = "\u202e";
const BEL = "\u0007";
const EVIL_IDENTITY = `Acme${ESC}[31m${RLO}org`;
const EVIL_KEY_NAME = `key${BEL}one`;

// A self-contained set of linkage terms with every optional block populated, so
// a single render exercises the full terms display.
const baseTerms: LinkageTerms = {
  version: "1.0.0",
  identity: "County Health Department",
  date: "2026-01-15",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: false },
  deduplicate: false,
  linkageFields: [
    { name: "ssn", type: "ssn" },
    { name: "last_name", type: "last_name" },
    { name: "dob", type: "date_of_birth" },
  ],
  linkageKeys: [
    {
      name: "SSN + LN + DOB",
      elements: [{ field: "ssn" }, { field: "last_name" }, { field: "dob" }],
    },
  ],
  payload: {
    send: [{ name: "risk_score" }],
    receive: [{ name: "program_outcome" }],
  },
  legalAgreement: {
    reference: "MOU-2025-0042",
    purpose: "Audit and evaluation of the State tutoring program",
    expirationDate: "2027-12-31",
  },
};

function makeToken(
  termsOverrides: Partial<LinkageTerms> = {},
): InvitationToken {
  return {
    version: "1",
    linkageTerms: { ...baseTerms, ...termsOverrides },
    sharedSecret: generateSharedSecret(),
    connectionEndpoint: {
      channel: "webrtc",
      host: "127.0.0.1",
      port: 3000,
      path: "/api/",
    },
  };
}

function makeInvitation(
  termsOverrides: Partial<LinkageTerms> = {},
): AcceptableInvitation {
  return {
    token: makeToken(termsOverrides),
    endpoint: {
      channel: "webrtc",
      host: "127.0.0.1",
      port: 3000,
      path: "/api/",
    },
  };
}

function render(node: ReactElement): string {
  return renderToStaticMarkup(createElement(MantineProvider, null, node));
}

/** Render the accept panel with sensible defaults, overriding only what a test
 * cares about. Handlers are no-ops: static markup runs no events. */
function renderPanel(
  overrides: Partial<Parameters<typeof AcceptInvitationPanel>[0]> = {},
): string {
  return render(
    createElement(AcceptInvitationPanel, {
      decode: { status: "pending" },
      consented: false,
      onConsentedChange: () => {},
      acceptorName: "",
      onAcceptorNameChange: () => {},
      onAcquireError: () => {},
      onAcquired: () => {},
      ...overrides,
    }),
  );
}

// A distinctive, apostrophe-free fragment of the consent checkbox label (the
// rendered markup HTML-escapes the apostrophe in "partner's", so match a span
// without it); unique to the checkbox, absent from the error/exchange states.
const CONSENT_LABEL = "proposed terms and consent to this exchange";
const ACCEPT_BUTTON = "Accept and continue";

describe("commitAcceptance (the consent gate)", () => {
  test("does not commit without explicit consent, even with a name", () => {
    expect(
      commitAcceptance({ consented: false, name: "Dana" }),
    ).toBeUndefined();
  });

  test("does not commit a consent with a blank or whitespace name", () => {
    expect(commitAcceptance({ consented: true, name: "" })).toBeUndefined();
    expect(commitAcceptance({ consented: true, name: "   " })).toBeUndefined();
  });

  test("commits the trimmed name once consented and named", () => {
    expect(commitAcceptance({ consented: true, name: "  Dana  " })).toBe(
      "Dana",
    );
  });
});

describe("summarizeInvitation", () => {
  test("matchedFields lists each matched field once, in first-appearance order across keys", () => {
    const summary = summarizeInvitation(
      makeToken({
        linkageKeys: [
          { name: "SSN + DOB", elements: [{ field: "ssn" }, { field: "dob" }] },
          {
            name: "SSN + LN",
            elements: [{ field: "ssn" }, { field: "last_name" }],
          },
        ],
      }),
    );
    // ssn and dob first (key 1), then last_name (new in key 2); ssn not repeated.
    expect(summary.matchedFields).toEqual([
      "SSN",
      "date of birth",
      "last name",
    ]);
  });

  test("derives the inviter's terms for display", () => {
    const summary = summarizeInvitation(makeToken());
    expect(summary.invitingParty).toBe("County Health Department");
    expect(summary.algorithm).toBe("psi");
    expect(summary.inviterReceivesOutput).toBe(true);
    expect(summary.inviterSharesResult).toBe(false);
    expect(summary.linkageKeys.map((key) => key.name)).toEqual([
      "SSN + LN + DOB",
    ]);
    expect(summary.linkageFields.map((field) => field.label)).toEqual([
      "Social Security number",
      "Last name",
      "Date of birth",
    ]);
    // The always-visible consent line: the unique fields matched on, compact form.
    expect(summary.matchedFields).toEqual([
      "SSN",
      "last name",
      "date of birth",
    ]);
    expect(summary.legalAgreement).toMatchObject({
      reference: "MOU-2025-0042",
      expirationDate: "2027-12-31",
    });
    expect(summary.payload).toEqual({
      send: ["risk_score"],
      sendDeclared: true,
      receive: ["program_outcome"],
      receiveDeclared: true,
    });
  });

  test("omits optional blocks the inviter did not include", () => {
    const summary = summarizeInvitation(
      makeToken({ payload: undefined, legalAgreement: undefined }),
    );
    expect(summary.legalAgreement).toBeUndefined();
    expect(summary.payload).toBeUndefined();
  });

  test("surfaces the deduplicate setting", () => {
    expect(summarizeInvitation(makeToken()).deduplicate).toBe(false);
    expect(
      summarizeInvitation(makeToken({ deduplicate: true })).deduplicate,
    ).toBe(true);
  });

  test("sanitizes partner-controlled free text (identity and key names)", () => {
    const summary = summarizeInvitation(
      makeToken({
        identity: EVIL_IDENTITY,
        linkageKeys: [{ name: EVIL_KEY_NAME, elements: [{ field: "ssn" }] }],
      }),
    );
    // Raw control/bidi bytes gone, replaced by visible escapes.
    expect(summary.invitingParty).not.toContain(ESC);
    expect(summary.invitingParty).not.toContain(RLO);
    expect(summary.invitingParty).toContain("\\x1b");
    expect(summary.invitingParty).toContain("\\u202e");
    expect(summary.linkageKeys[0].name).not.toContain(BEL);
    expect(summary.linkageKeys[0].name).toContain("\\x07");
  });

  test("sanitizes the legal-agreement reference and purpose", () => {
    // reference and purpose are partner-controlled free text now promoted into the
    // always-visible consent core, so the sanitization boundary is load-bearing
    // here: raw control/bidi bytes must be neutralized in the summary the renderer
    // consumes, since none of the promoted fields reach the DOM except through it.
    // expirationDate is a schema-validated ISO date that cannot carry these bytes,
    // so it is not exercised.
    const summary = summarizeInvitation(
      makeToken({
        legalAgreement: {
          reference: `MOU${ESC}[31m${RLO}0042`,
          purpose: `Audit${BEL} and evaluation`,
          expirationDate: "2027-12-31",
        },
      }),
    );
    expect(summary.legalAgreement?.reference).not.toContain(ESC);
    expect(summary.legalAgreement?.reference).not.toContain(RLO);
    expect(summary.legalAgreement?.reference).toContain("\\x1b");
    expect(summary.legalAgreement?.reference).toContain("\\u202e");
    expect(summary.legalAgreement?.purpose).not.toContain(BEL);
    expect(summary.legalAgreement?.purpose).toContain("\\x07");
  });

  test("sanitizes partner-controlled transform and constraint text", () => {
    const summary = summarizeInvitation(
      makeToken({
        linkageFields: [
          {
            name: "first_name",
            type: "first_name",
            constraints: { allowedCharacters: "A-Z" + BEL },
          },
        ],
        linkageKeys: [
          {
            name: "FN",
            elements: [
              {
                field: "first_name",
                transform: [
                  {
                    function: "substring" + BEL,
                    params: { ["k" + BEL]: "v" + BEL },
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    // A transform function name, its parameters, and a constraint's
    // allowedCharacters are all partner-controlled, so each is neutralized
    // before it reaches the summary.
    const transform = summary.linkageKeys[0].elements[0].transforms[0];
    expect(transform.function).not.toContain(BEL);
    expect(transform.function).toContain("\\x07");
    expect(transform.params[0]).not.toContain(BEL);
    expect(transform.params[0]).toContain("\\x07");
    const constraint = summary.linkageFields[0].constraints[0];
    expect(constraint).not.toContain(BEL);
    expect(constraint).toContain("\\x07");
  });

  test("caps the number of transform parameters shown", () => {
    const params: Record<string, number> = {};
    for (let i = 0; i < 20; i += 1) params["p" + i] = i;
    const summary = summarizeInvitation(
      makeToken({
        linkageFields: [{ name: "ssn", type: "ssn" }],
        linkageKeys: [
          {
            name: "K",
            elements: [
              { field: "ssn", transform: [{ function: "f", params }] },
            ],
          },
        ],
      }),
    );
    const shown = summary.linkageKeys[0].elements[0].transforms[0].params;
    // 16 parameters shown, then one overflow marker for the remaining 4.
    expect(shown).toHaveLength(17);
    expect(shown[16]).toBe("... 4 more");
  });

  test("falls back to the sanitized field identifier for an unknown field reference", () => {
    const summary = summarizeInvitation(
      makeToken({
        linkageFields: [{ name: "ssn", type: "ssn" }],
        linkageKeys: [{ name: "K", elements: [{ field: "mystery" + BEL }] }],
      }),
    );
    // No linkageField is named "mystery...", so the element's field cannot
    // resolve to a semantic-type label; the raw identifier is surfaced as the
    // most transparent fallback, but sanitized first.
    const label = summary.linkageKeys[0].elements[0].fieldLabel;
    expect(label).toContain("mystery");
    expect(label).not.toContain(BEL);
    expect(label).toContain("\\x07");
  });

  test("surfaces a transform, swap, and fuzzy expansion on the affected elements", () => {
    const summary = summarizeInvitation(
      makeToken({
        linkageFields: [
          { name: "ssn", type: "ssn" },
          { name: "first_name", type: "first_name" },
          { name: "last_name", type: "last_name" },
          { name: "dob", type: "date_of_birth" },
        ],
        linkageKeys: [
          { name: "plain", elements: [{ field: "ssn" }, { field: "dob" }] },
          {
            name: "transformed",
            elements: [
              { field: "ssn" },
              {
                field: "first_name",
                transform: [
                  { function: "substring", params: { start: 1, length: 1 } },
                ],
              },
            ],
          },
          {
            name: "swapped",
            elements: [{ field: "last_name" }, { field: "first_name" }],
            swap: ["last_name", "first_name"],
          },
          {
            name: "fuzzy",
            elements: [
              { field: "dob", generateFuzzyComparisons: "adjacent_years" },
            ],
          },
        ],
      }),
    );

    const [plain, transformed, swapped, fuzzy] = summary.linkageKeys;

    // A plain key carries no rule.
    expect(plain.swap).toBeUndefined();
    expect(
      plain.elements.every(
        (element) =>
          element.transforms.length === 0 &&
          element.fuzzyComparison === undefined,
      ),
    ).toBe(true);

    // A substring on a name field leads with the literal slice phrase (effect),
    // which suppresses the now-redundant glossary description.
    expect(transformed.elements[1].transforms).toEqual([
      {
        function: "substring",
        params: ["start: 1", "length: 1"],
        effect: "the first character",
      },
    ]);

    // A swap resolves to the swapped elements' field labels.
    expect(swapped.hasSwap).toBe(true);
    expect(swapped.swap).toEqual(["Last name", "First name"]);

    // A fuzzy expansion maps to its plain-language label.
    expect(fuzzy.elements[0].fuzzyComparison).toBe("adjacent years");
  });

  test("flags a swap but withholds field labels when they would not distinguish the two elements", () => {
    const summary = summarizeInvitation(
      makeToken({
        linkageFields: [{ name: "first_name", type: "first_name" }],
        linkageKeys: [
          {
            // Two elements of the same type, distinguished only by alias: the
            // schema permits this, but both resolve to "First name", so naming
            // them would read as "First name and First name".
            name: "alias swap",
            elements: [
              { field: "first_name", name: "given" },
              { field: "first_name", name: "preferred" },
            ],
            swap: ["given", "preferred"],
          },
          {
            // A swap that references an element identifier present on no element
            // (schema-valid: swap references are not cross-checked against the
            // elements). The note must not echo the raw identifier.
            name: "dangling swap",
            elements: [{ field: "first_name" }],
            swap: ["first_name", "missing"],
          },
        ],
      }),
    );

    for (const key of summary.linkageKeys) {
      // The swap is still surfaced so it is never silently consented to ...
      expect(key.hasSwap).toBe(true);
      // ... but the specific labels are withheld, so the renderer falls back to
      // a generic note rather than a duplicated or raw-identifier one.
      expect(key.swap).toBeUndefined();
      // ... and an alias or dangling (unresolved) swap never spuriously sets the
      // marker re-attribution flags, which require a distinct-label resolution.
      expect(key.swapTransformInterchange).toBe(false);
      expect(key.swapTransformDonor).toBeUndefined();
    }
  });

  test("collapses fields that render identically but keeps constraint-distinct ones", () => {
    const summary = summarizeInvitation(
      makeToken({
        linkageFields: [
          // Two firstName fields with no constraints render identically.
          { name: "given_name", type: "first_name" },
          { name: "preferred_name", type: "first_name" },
          // A third firstName field whose constraints differ stays distinct.
          {
            name: "legal_name",
            type: "first_name",
            constraints: { allowedCharacters: "A-Z " },
          },
          { name: "dob", type: "date_of_birth" },
        ],
        linkageKeys: [{ name: "FN", elements: [{ field: "given_name" }] }],
      }),
    );

    // The two unconstrained "First name" entries collapse to one; the
    // constraint-bearing one and the date field stay distinct.
    expect(summary.linkageFields).toEqual([
      { label: "First name", constraints: [] },
      {
        label: "First name",
        constraints: [
          "allowed-character pattern (partner-supplied regular expression, not verified by psilink): A-Z ",
        ],
      },
      { label: "Date of birth", constraints: [] },
    ]);
  });

  test("surfaces each field's declared constraints, summarizing the denylist", () => {
    const summary = summarizeInvitation(
      makeToken({
        linkageFields: [
          {
            name: "ssn",
            type: "ssn",
            constraints: {
              validOnly: true,
              exclude: ["111111111", "123456789"],
            },
          },
          {
            name: "first_name",
            type: "first_name",
            constraints: { affixesAllowed: false, allowedCharacters: "A-Z " },
          },
          { name: "dob", type: "date_of_birth" },
        ],
        linkageKeys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
      }),
    );

    const [ssn, firstName, dob] = summary.linkageFields;
    // The exclude denylist is a count, not its values.
    expect(ssn.constraints).toEqual([
      "values must be valid",
      "2 excluded values",
    ]);
    expect(firstName.constraints).toEqual([
      "honorifics and suffixes removed",
      "allowed-character pattern (partner-supplied regular expression, not verified by psilink): A-Z ",
    ]);
    // A field with no constraints contributes nothing.
    expect(dob.constraints).toEqual([]);
  });

  test("frames a partner-authored allowedCharacters class as regex, not a plain-language guarantee", () => {
    // A leading `^` reads to a non-regex-literate operator as "allow caret and
    // A-Z" but is class negation (admits everything EXCEPT A-Z). The display must
    // not present this partner-authored, un-vetted regex as a "limited to"
    // promise; it is labelled as the regular expression it is, with the raw class
    // still shown so a regex-literate reviewer can inspect it.
    const summary = summarizeInvitation(
      makeToken({
        linkageFields: [
          {
            name: "first_name",
            type: "first_name",
            constraints: { allowedCharacters: "^A-Z" },
          },
        ],
        linkageKeys: [{ name: "FN", elements: [{ field: "first_name" }] }],
      }),
    );
    const [constraint] = summary.linkageFields[0].constraints;
    expect(constraint).toBe(
      "allowed-character pattern (partner-supplied regular expression, not verified by psilink): ^A-Z",
    );
    expect(constraint).not.toContain("limited to");
    // The trust boundary is named, not just the regex syntax family, so the
    // partner's un-vetted value is not read as one the app validated.
    expect(constraint).toContain("not verified by psilink");
  });

  test("labels every fuzzy-comparison expansion in plain language", () => {
    const fuzzyLabelFor = (
      value: NonNullable<LinkageKeyElement["generateFuzzyComparisons"]>,
    ) =>
      summarizeInvitation(
        makeToken({
          linkageFields: [{ name: "dob", type: "date_of_birth" }],
          linkageKeys: [
            {
              name: "K",
              elements: [{ field: "dob", generateFuzzyComparisons: value }],
            },
          ],
        }),
      ).linkageKeys[0].elements[0].fuzzyComparison;

    // All three enum values map to a distinct plain-language label, so a typo
    // or swapped entry in the lookup cannot ship unnoticed.
    expect(fuzzyLabelFor("transpositions")).toBe("two-digit transpositions");
    expect(fuzzyLabelFor("edit_distances")).toBe("single-character edits");
    expect(fuzzyLabelFor("adjacent_years")).toBe("adjacent years");
  });

  // The summary surfaced for a transform declaring `fn`.
  const transformFor = (fn: string) =>
    summarizeInvitation(
      makeToken({
        linkageFields: [{ name: "ssn", type: "ssn" }],
        linkageKeys: [
          {
            name: "K",
            elements: [{ field: "ssn", transform: [{ function: fn }] }],
          },
        ],
      }),
    ).linkageKeys[0].elements[0].transforms[0];

  test("the transform glossary stays in sync with core's function set", () => {
    // Two-directional: every function core recognizes has a description, and the
    // glossary carries no entry for a function core does not (a stale key). A new
    // core function therefore cannot ship without a consent-screen description,
    // and a removed one cannot leave dead copy behind.
    expect(Object.keys(TRANSFORM_FUNCTION_GLOSSARY).sort()).toEqual(
      [...STANDARDIZATION_FUNCTION_NAMES].sort(),
    );
  });

  test("describes a transform's matching effect alongside its name", () => {
    // coalesce is the headline match-widening case: its description must name the
    // consequence (it can create matches that would not otherwise occur), not
    // restate the name.
    const coalesce = transformFor("coalesce");
    expect(coalesce.function).toBe("coalesce");
    expect(coalesce.description).toBe(TRANSFORM_FUNCTION_GLOSSARY["coalesce"]);
    expect(coalesce.description).toMatch(/matches that would not otherwise/i);

    // A normalizing function is described too, so every step carries context.
    expect(transformFor("to_upper_case").description).toMatch(/case/i);
  });

  test("omits a description for a function name core does not recognize", () => {
    // A partner-declared name with no core match falls back to the bare
    // (sanitized) name with no description, rather than a misleading one.
    const unknown = transformFor("not_a_real_function");
    expect(unknown.function).toBe("not_a_real_function");
    expect(unknown.description).toBeUndefined();
  });

  test("renders transform parameter values of every type", () => {
    const summary = summarizeInvitation(
      makeToken({
        linkageFields: [{ name: "ssn", type: "ssn" }],
        linkageKeys: [
          {
            name: "K",
            elements: [
              {
                field: "ssn",
                transform: [
                  {
                    function: "f",
                    params: {
                      s: "text",
                      n: 5,
                      b: true,
                      nul: null,
                      undef: undefined,
                      obj: { a: 1 },
                    },
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    // Each parameter is a "key: value" line: primitives in plain form,
    // null/undefined made explicit, and a structured value JSON-encoded.
    expect(summary.linkageKeys[0].elements[0].transforms[0].params).toEqual([
      "s: text",
      "n: 5",
      "b: true",
      "nul: null",
      "undef: ",
      'obj: {"a":1}',
    ]);
  });

  test("surfaces a transform with no declared parameters as an empty list", () => {
    const summary = summarizeInvitation(
      makeToken({
        linkageFields: [{ name: "ssn", type: "ssn" }],
        linkageKeys: [
          {
            name: "K",
            elements: [{ field: "ssn", transform: [{ function: "trim" }] }],
          },
        ],
      }),
    );
    expect(summary.linkageKeys[0].elements[0].transforms).toEqual([
      { function: "trim", params: [] },
    ]);
  });

  // The display summary for a single transform step.
  const transformWith = (fn: string, params: Record<string, unknown>) =>
    summarizeInvitation(
      makeToken({
        linkageFields: [{ name: "ssn", type: "ssn" }],
        linkageKeys: [
          {
            name: "K",
            elements: [{ field: "ssn", transform: [{ function: fn, params }] }],
          },
        ],
      }),
    ).linkageKeys[0].elements[0].transforms[0];

  test("annotates a coerced parameter with the value the function actually runs", () => {
    // The headline case: replace_regex replacement: null executes as the empty
    // string. The param line stays verbatim and the executed value is surfaced
    // as a separate coercion note (not folded into the partner-controlled line).
    const transform = transformWith("replace_regex", {
      pattern: "x",
      replacement: null,
    });
    expect(transform.params).toEqual(["pattern: x", "replacement: null"]);
    expect(transform.coercions).toEqual([
      { param: "replacement", runsAs: "the empty string" },
    ]);
  });

  test("shows an un-coerced parameter verbatim, even when declared null", () => {
    // A declared, non-null value is applied as written -- no coercion note.
    const real = transformWith("replace_regex", {
      pattern: "x",
      replacement: "Y",
    });
    expect(real.params).toEqual(["pattern: x", "replacement: Y"]);
    expect(real.coercions).toBeUndefined();
    // The coercion is per-parameter: replace_regex coerces `replacement` but not
    // `pattern`, so a null pattern keeps its literal "null" and gains no note
    // where a blanket "(empty)" rendering would be wrong.
    const nullPattern = transformWith("replace_regex", { pattern: null });
    expect(nullPattern.params).toEqual(["pattern: null"]);
    expect(nullPattern.coercions).toBeUndefined();
  });

  test("a forged 'runs as' in a partner param value does not become a coercion note", () => {
    // A malicious inviter placing the annotation's literal text inside a param
    // VALUE stays a verbatim `key: value` line and yields no coercion note: the
    // genuine note is a separate element built only from core's table, so it
    // cannot be impersonated by partner-controlled param content.
    const transform = transformWith("replace_regex", {
      pattern: "x",
      replacement: "Y runs as the empty string",
    });
    expect(transform.params).toEqual([
      "pattern: x",
      "replacement: Y runs as the empty string",
    ]);
    expect(transform.coercions).toBeUndefined();
  });

  test("surfaces a note for each coerced parameter of a step", () => {
    // parse_date defaults both formats; declaring both null yields two notes, in
    // the function's parameter order.
    const transform = transformWith("parse_date", {
      inputFormat: null,
      outputFormat: null,
    });
    expect(transform.coercions).toEqual([
      { param: "inputFormat", runsAs: "MM/DD/YYYY" },
      { param: "outputFormat", runsAs: "YYYYMMDD" },
    ]);
  });

  test("names the executed value for non-empty-string fallbacks", () => {
    // Beyond the empty-string case: a boolean fallback (split_on includeOriginal)
    // and a string fallback (pad_left char) render their real executed value, so
    // the web "runs as" text matches core's actual fallback for every function.
    expect(
      transformWith("split_on", { delimiter: ",", includeOriginal: null })
        .coercions,
    ).toEqual([{ param: "includeOriginal", runsAs: "false" }]);
    expect(
      transformWith("pad_left", { length: 5, char: null }).coercions,
    ).toEqual([{ param: "char", runsAs: "0" }]);
  });

  test("does not annotate a coerced param hidden by the display cap", () => {
    // A coerced param past MAX_DISPLAYED_PARAMS collapses into the overflow
    // marker; its note is withheld too, so a note never references a param the
    // acceptor cannot see.
    const params: Record<string, unknown> = { pattern: "x" };
    for (let i = 0; i < 15; i += 1) params["f" + i] = i;
    params.replacement = null; // the 17th entry, beyond the cap
    const transform = transformWith("replace_regex", params);
    expect(transform.params).toContain("... 1 more");
    expect(transform.params).not.toContain("replacement: null");
    expect(transform.coercions).toBeUndefined();
  });

  test("sanitizes payload column names on both the send and receive sides", () => {
    const summary = summarizeInvitation(
      makeToken({
        payload: {
          send: [{ name: "out" + BEL }],
          receive: [{ name: "in" + BEL }],
        },
      }),
    );
    // Send and receive are independent partner-controlled paths; each is
    // sanitized before display.
    expect(summary.payload?.send[0]).not.toContain(BEL);
    expect(summary.payload?.send[0]).toContain("\\x07");
    expect(summary.payload?.receive[0]).not.toContain(BEL);
    expect(summary.payload?.receive[0]).toContain("\\x07");
  });

  test("sanitizes a swap label resolved from an unknown field identifier", () => {
    const summary = summarizeInvitation(
      makeToken({
        // Neither swapped element resolves to a known field, so each falls back
        // to its sanitized raw identifier -- which must not carry the raw byte
        // into the swap note.
        linkageFields: [{ name: "ssn", type: "ssn" }],
        linkageKeys: [
          {
            name: "K",
            elements: [{ field: "alpha" + BEL }, { field: "beta" + BEL }],
            swap: ["alpha" + BEL, "beta" + BEL],
          },
        ],
      }),
    );
    const swap = summary.linkageKeys[0].swap;
    expect(swap).toBeDefined();
    expect(swap?.[0]).not.toContain(BEL);
    expect(swap?.[0]).toContain("\\x07");
    expect(swap?.[1]).not.toContain(BEL);
  });

  test("depicts the transformed-value interchange only when both swapped elements transform", () => {
    // The summary for a two-element key swapped on its elements, with the given
    // transforms on each.
    const keyFor = (
      firstTransform: LinkageKeyElement["transform"],
      secondTransform: LinkageKeyElement["transform"],
    ) =>
      summarizeInvitation(
        makeToken({
          linkageFields: [
            { name: "first_name", type: "first_name" },
            { name: "last_name", type: "last_name" },
          ],
          linkageKeys: [
            {
              name: "Name",
              elements: [
                {
                  field: "first_name",
                  ...(firstTransform && { transform: firstTransform }),
                },
                {
                  field: "last_name",
                  ...(secondTransform && { transform: secondTransform }),
                },
              ],
              swap: ["first_name", "last_name"],
            },
          ],
        }),
      ).linkageKeys[0];

    const upper: LinkageKeyElement["transform"] = [
      { function: "to_upper_case" },
    ];

    // Both swapped elements carry a transform: on the receiver side each keeps
    // its transforms but reads the other's field value, so the interchange is
    // depicted, named in terms of the two resolved field labels.
    const both = keyFor(upper, upper);
    expect(both.swap).toEqual(["First name", "Last name"]);
    expect(both.swapTransformInterchange).toBe(true);

    // Only one side (or neither) carries a transform: nothing cross-applies both
    // ways, so the generic swap note stands and the interchange is not depicted.
    expect(keyFor(upper, undefined).swapTransformInterchange).toBe(false);
    expect(keyFor(undefined, undefined).swapTransformInterchange).toBe(false);
  });

  test("withholds the interchange when both swapped elements share a field label", () => {
    // Two firstName fields resolve to the same "First name" label, so the note
    // could not name the two sides distinctly. The interchange is suppressed even
    // though both elements carry a transform -- the distinct-label gate wins over
    // the both-transform gate, falling back to the generic swap note.
    const key = summarizeInvitation(
      makeToken({
        linkageFields: [
          { name: "given", type: "first_name" },
          { name: "preferred", type: "first_name" },
        ],
        linkageKeys: [
          {
            name: "FN",
            elements: [
              {
                field: "given",
                name: "g",
                transform: [{ function: "to_upper_case" }],
              },
              {
                field: "preferred",
                name: "p",
                transform: [{ function: "to_upper_case" }],
              },
            ],
            swap: ["g", "p"],
          },
        ],
      }),
    ).linkageKeys[0];
    expect(key.hasSwap).toBe(true);
    expect(key.swap).toBeUndefined();
    expect(key.swapTransformInterchange).toBe(false);
  });

  // A first_name/last_name swap key with the given overrides on each element.
  const swapKey = (
    firstEl: Partial<LinkageKeyElement>,
    secondEl: Partial<LinkageKeyElement>,
  ) =>
    summarizeInvitation(
      makeToken({
        linkageFields: [
          { name: "first_name", type: "first_name" },
          { name: "last_name", type: "last_name" },
        ],
        linkageKeys: [
          {
            name: "Name",
            elements: [
              { field: "first_name", ...firstEl },
              { field: "last_name", ...secondEl },
            ],
            swap: ["first_name", "last_name"],
          },
        ],
      }),
    ).linkageKeys[0];

  const partial: LinkageKeyElement["transform"] = [
    { function: "substring", params: { start: 1, length: 3 } },
  ];
  const soundAlike: LinkageKeyElement["transform"] = [{ function: "phonetic" }];

  test("swaps each header marker to its partner's field across a swap", () => {
    // One transform: on the receiver the first element reads the SECOND element's
    // field value (core's `swapElements`), so the truncation runs on last name's
    // value. "(partial)" therefore shows on "last name", not the declared "first
    // name", and a one-directional donor note (first name -> last name) anchors it.
    const single = swapKey({ transform: partial }, {});
    expect(single.headerFields).toEqual(["first name", "last name (partial)"]);
    expect(single.swap).toEqual(["First name", "Last name"]);
    expect(single.swapTransformInterchange).toBe(false);
    expect(single.swapTransformDonor).toEqual(["First name", "Last name"]);

    // Symmetric: a transform on the second element re-points to the first, and the
    // donor note names the transform-carrier (last name) first.
    const singleB = swapKey({}, { transform: partial });
    expect(singleB.headerFields).toEqual(["first name (partial)", "last name"]);
    expect(singleB.swapTransformDonor).toEqual(["Last name", "First name"]);

    // Both sides carry transforms with DIFFERENT markers: each marker moves to the
    // partner's field (substring truncates last name's value -> "partial" on last
    // name; phonetic recodes first name's value -> "sound-alike" on first name),
    // and the bidirectional interchange note fires. Leaving the markers on their
    // declared fields would mis-state which of the acceptor's fields each rule hits.
    const bothDiff = swapKey({ transform: partial }, { transform: soundAlike });
    expect(bothDiff.headerFields).toEqual([
      "first name (sound-alike)",
      "last name (partial)",
    ]);
    expect(bothDiff.swapTransformInterchange).toBe(true);
    expect(bothDiff.swapTransformDonor).toBeUndefined();

    // Both carry the SAME marker: the swap is a visual no-op, interchange still
    // fires (the cross-apply is real even when the markers coincide).
    const bothSame = swapKey({ transform: partial }, { transform: partial });
    expect(bothSame.headerFields).toEqual([
      "first name (partial)",
      "last name (partial)",
    ]);
    expect(bothSame.swapTransformInterchange).toBe(true);

    // Neither carries a transform: bare labels, no interchange, no donor note.
    const neither = swapKey({}, {});
    expect(neither.headerFields).toEqual(["first name", "last name"]);
    expect(neither.swapTransformInterchange).toBe(false);
    expect(neither.swapTransformDonor).toBeUndefined();
  });

  test("swaps a header marker to the partner's field whatever its source", () => {
    // A transform on one side, a fuzzy comparison on the other: each marker lands
    // on the field the receiver applies it to. The substring truncates last name's
    // value ("partial" -> last name); the fuzzy rides along with its element, which
    // reads first name's value, so it expands first name ("fuzzy" -> first name).
    // The applied transform is anchored by the donor note; the fuzzy axis carries
    // its own not-applied caveat in the detail.
    const txAndFuzzy = swapKey(
      { transform: partial },
      { generateFuzzyComparisons: "edit_distances" },
    );
    expect(txAndFuzzy.headerFields).toEqual([
      "first name (fuzzy)",
      "last name (partial)",
    ]);
    expect(txAndFuzzy.swapTransformInterchange).toBe(false);
    expect(txAndFuzzy.swapTransformDonor).toEqual(["First name", "Last name"]);

    // A fuzzy marker moves with its element even when no transform earns a marker:
    // the whole element reads the partner's value on the receiver, so "fuzzy" shows
    // on the partner's field. With no transform on either side there is no donor
    // note; the generic "matched in either order" note bridges it.
    const fuzzyOnly = swapKey(
      { generateFuzzyComparisons: "edit_distances" },
      {},
    );
    expect(fuzzyOnly.headerFields).toEqual(["first name", "last name (fuzzy)"]);
    expect(fuzzyOnly.swapTransformInterchange).toBe(false);
    expect(fuzzyOnly.swapTransformDonor).toBeUndefined();
  });

  test("re-attributes only the swapped pair, leaving a third element's marker put", () => {
    // Only first/last name are swapped; the un-swapped dob keeps its own "(fuzzy)"
    // marker on its own field while the pair crosses (partial -> last name). Pins
    // that the override touches only the two swapped elements.
    const key = summarizeInvitation(
      makeToken({
        linkageFields: [
          { name: "first_name", type: "first_name" },
          { name: "last_name", type: "last_name" },
          { name: "dob", type: "date_of_birth" },
        ],
        linkageKeys: [
          {
            name: "Name + DOB",
            elements: [
              {
                field: "first_name",
                transform: [
                  { function: "substring", params: { start: 1, length: 3 } },
                ],
              },
              { field: "last_name" },
              { field: "dob", generateFuzzyComparisons: "adjacent_years" },
            ],
            swap: ["first_name", "last_name"],
          },
        ],
      }),
    ).linkageKeys[0];
    expect(key.headerFields).toEqual([
      "first name",
      "last name (partial)",
      "date of birth (fuzzy)",
    ]);
  });

  test("does not re-attribute a same-label (alias) swap, even with distinct markers", () => {
    // Two first_name fields resolve to one "first name" label, so the swap resolves
    // no distinct labels and nothing is re-attributed: each element keeps its own
    // marker on its declared field (the re-attribution would be unobservable here).
    const key = summarizeInvitation(
      makeToken({
        linkageFields: [
          { name: "given", type: "first_name" },
          { name: "preferred", type: "first_name" },
        ],
        linkageKeys: [
          {
            name: "FN",
            elements: [
              {
                field: "given",
                name: "g",
                transform: [
                  { function: "substring", params: { start: 1, length: 3 } },
                ],
              },
              {
                field: "preferred",
                name: "p",
                transform: [{ function: "phonetic" }],
              },
            ],
            swap: ["g", "p"],
          },
        ],
      }),
    ).linkageKeys[0];
    expect(key.swap).toBeUndefined();
    expect(key.swapTransformInterchange).toBe(false);
    expect(key.swapTransformDonor).toBeUndefined();
    expect(key.headerFields).toEqual([
      "first name (partial)",
      "first name (sound-alike)",
    ]);
  });

  test("keeps a re-attributed marker distinct from a same-label markerless element", () => {
    // A second last_name-typed field (not swapped) renders as a bare "last name".
    // The swap re-attributes "(partial)" onto the first last_name slot; the
    // full-entry dedup keeps "last name (partial)" and the bare "last name"
    // distinct, so the re-attributed marker is never hidden behind the duplicate.
    const key = summarizeInvitation(
      makeToken({
        linkageFields: [
          { name: "first_name", type: "first_name" },
          { name: "last_name", type: "last_name" },
          { name: "ln2", type: "last_name" },
        ],
        linkageKeys: [
          {
            name: "Name",
            elements: [
              {
                field: "first_name",
                transform: [
                  { function: "substring", params: { start: 1, length: 3 } },
                ],
              },
              { field: "last_name" },
              { field: "ln2" },
            ],
            swap: ["first_name", "last_name"],
          },
        ],
      }),
    ).linkageKeys[0];
    expect(key.headerFields).toEqual([
      "first name",
      "last name (partial)",
      "last name",
    ]);
  });

  test("emits no constraint phrase for no-op constraint settings", () => {
    const summary = summarizeInvitation(
      makeToken({
        linkageFields: [
          // affixesAllowed=true and validOnly=false are the default direction:
          // neither should produce a phrase (only the opposite direction does).
          {
            name: "first_name",
            type: "first_name",
            constraints: { affixesAllowed: true },
          },
          { name: "ssn", type: "ssn", constraints: { validOnly: false } },
        ],
        linkageKeys: [{ name: "K", elements: [{ field: "ssn" }] }],
      }),
    );
    expect(summary.linkageFields.map((field) => field.constraints)).toEqual([
      [],
      [],
    ]);
  });

  test("marks deduplicate and fuzzy comparisons as proposed but not yet applied", () => {
    const summary = summarizeInvitation(
      makeToken({
        deduplicate: true,
        linkageFields: [{ name: "dob", type: "date_of_birth" }],
        linkageKeys: [
          {
            name: "K",
            elements: [
              { field: "dob", generateFuzzyComparisons: "adjacent_years" },
            ],
          },
        ],
      }),
    );
    // Both are surfaced (terms as proposed) but flagged as not run by today's
    // exchange, so the renderer marks them rather than state a behavior that
    // does not occur.
    expect(summary.deduplicateApplied).toBe(false);
    expect(summary.linkageKeys[0].elements[0].fuzzyComparisonApplied).toBe(
      false,
    );
  });

  test("marks psi-c as proposed but not yet applied", () => {
    // psi-c is surfaced (terms as proposed) but flagged not-applied, so the
    // count-only claim cannot read as in force while the run still reveals
    // matched identifiers.
    const summary = summarizeInvitation(
      makeToken({
        algorithm: "psi-c",
        linkageFields: [{ name: "ssn", type: "ssn" }],
        linkageKeys: [{ name: "K", elements: [{ field: "ssn" }] }],
      }),
    );
    expect(summary.algorithm).toBe("psi-c");
    expect(summary.psiCApplied).toBe(false);
  });

  test("leads a substring on a name field with a literal slice phrase", () => {
    // first_name/last_name are free text, so a character position maps to what
    // the acceptor sees: the slice is rendered literally and the now-redundant
    // glossary description is suppressed.
    const summary = summarizeInvitation(
      makeToken({
        linkageFields: [
          { name: "first_name", type: "first_name" },
          { name: "last_name", type: "last_name" },
        ],
        linkageKeys: [
          {
            name: "K",
            elements: [
              {
                field: "first_name",
                transform: [
                  { function: "substring", params: { start: 1, length: 1 } },
                ],
              },
              {
                field: "last_name",
                transform: [
                  { function: "substring", params: { start: 1, length: 3 } },
                ],
              },
            ],
          },
        ],
      }),
    );
    const [fn, ln] = summary.linkageKeys[0].elements;
    expect(fn.transforms[0].effect).toBe("the first character");
    expect(fn.transforms[0].description).toBeUndefined();
    expect(ln.transforms[0].effect).toBe("the first 3 characters");
  });

  test("renders an interior substring slice as a character range", () => {
    const summary = summarizeInvitation(
      makeToken({
        linkageFields: [{ name: "last_name", type: "last_name" }],
        linkageKeys: [
          {
            name: "K",
            elements: [
              {
                field: "last_name",
                transform: [
                  { function: "substring", params: { start: 3, length: 2 } },
                ],
              },
            ],
          },
        ],
      }),
    );
    expect(summary.linkageKeys[0].elements[0].transforms[0].effect).toBe(
      "characters 3 to 4",
    );
  });

  test("does not render a positional slice for a reformatted field", () => {
    // A date is canonicalized by a standardization the token does not carry, so a
    // positional phrase ("the first 6 characters") would be unverifiable; the
    // element falls back to the glossary description, with the "(partial)" header
    // marker still carrying the breadth.
    const summary = summarizeInvitation(
      makeToken({
        linkageFields: [{ name: "dob", type: "date_of_birth" }],
        linkageKeys: [
          {
            name: "K",
            elements: [
              {
                field: "dob",
                transform: [
                  { function: "substring", params: { start: 1, length: 6 } },
                ],
              },
            ],
          },
        ],
      }),
    );
    const transform = summary.linkageKeys[0].elements[0].transforms[0];
    expect(transform.effect).toBeUndefined();
    expect(transform.description).toBe(
      TRANSFORM_FUNCTION_GLOSSARY["substring"],
    );
  });

  test("falls back to the glossary for a negative or non-integer substring slice", () => {
    // A negative start counts from the end (no faithful "first N") and a
    // non-integer or missing param is not a usable slice; all fall back to the
    // description rather than assert a wrong literal.
    const effectFor = (params: Record<string, unknown>) =>
      summarizeInvitation(
        makeToken({
          linkageFields: [{ name: "last_name", type: "last_name" }],
          linkageKeys: [
            {
              name: "K",
              elements: [
                {
                  field: "last_name",
                  transform: [{ function: "substring", params }],
                },
              ],
            },
          ],
        }),
      ).linkageKeys[0].elements[0].transforms[0];
    expect(effectFor({ start: -3, length: 3 }).effect).toBeUndefined();
    expect(effectFor({ start: -3, length: 3 }).description).toBe(
      TRANSFORM_FUNCTION_GLOSSARY["substring"],
    );
    expect(effectFor({ start: 1.5, length: 2 }).effect).toBeUndefined();
    expect(effectFor({ length: 2 }).effect).toBeUndefined();
  });

  test("does not render a substring literal after an earlier reformatting step", () => {
    // On a name field, phonetic then substring takes the first 3 characters of
    // the sound-alike code, not the name, so the positional literal would misstate
    // the match -- the substring step falls back to the glossary description.
    const summary = summarizeInvitation(
      makeToken({
        linkageFields: [{ name: "last_name", type: "last_name" }],
        linkageKeys: [
          {
            name: "K",
            elements: [
              {
                field: "last_name",
                transform: [
                  { function: "phonetic" },
                  { function: "substring", params: { start: 1, length: 3 } },
                ],
              },
            ],
          },
        ],
      }),
    );
    const [phonetic, substring] = summary.linkageKeys[0].elements[0].transforms;
    expect(phonetic.description).toBe(TRANSFORM_FUNCTION_GLOSSARY["phonetic"]);
    expect(substring.effect).toBeUndefined();
    expect(substring.description).toBe(
      TRANSFORM_FUNCTION_GLOSSARY["substring"],
    );
  });

  test("builds the header one-liner from compact field labels", () => {
    const summary = summarizeInvitation(
      makeToken({
        linkageFields: [
          { name: "ssn", type: "ssn" },
          { name: "ssn4", type: "ssn4" },
          { name: "last_name", type: "last_name" },
          { name: "dob", type: "date_of_birth" },
        ],
        linkageKeys: [
          {
            name: "K",
            elements: [
              { field: "ssn" },
              { field: "ssn4" },
              { field: "last_name" },
              { field: "dob" },
            ],
          },
        ],
      }),
    );
    // ssn4 keeps its "(last 4)" qualifier -- the full-vs-last-4 difference is a
    // real disclosure distinction the bare "SSN" would hide.
    expect(summary.linkageKeys[0].headerFields).toEqual([
      "SSN",
      "SSN (last 4)",
      "last name",
      "date of birth",
    ]);
  });

  test("marks a loosening element in the header, reserving 'fuzzy' for fuzzy comparisons", () => {
    const summary = summarizeInvitation(
      makeToken({
        linkageFields: [
          { name: "first_name", type: "first_name" },
          { name: "last_name", type: "last_name" },
          { name: "dob", type: "date_of_birth" },
        ],
        linkageKeys: [
          {
            name: "K",
            elements: [
              {
                field: "first_name",
                transform: [
                  { function: "substring", params: { start: 1, length: 1 } },
                ],
              },
              { field: "last_name", transform: [{ function: "phonetic" }] },
              { field: "dob", generateFuzzyComparisons: "adjacent_years" },
            ],
          },
        ],
      }),
    );
    // substring -> "partial", phonetic -> "sound-alike", a fuzzy comparison ->
    // "fuzzy" (the genuine approximate-match feature, distinct from truncation).
    expect(summary.linkageKeys[0].headerFields).toEqual([
      "first name (partial)",
      "last name (sound-alike)",
      "date of birth (fuzzy)",
    ]);
  });

  test("does not mark a pure normalizer in the header", () => {
    // Case-folding does not change which distinct values match, so it carries no
    // breadth marker.
    const summary = summarizeInvitation(
      makeToken({
        linkageFields: [{ name: "last_name", type: "last_name" }],
        linkageKeys: [
          {
            name: "K",
            elements: [
              {
                field: "last_name",
                transform: [{ function: "to_upper_case" }],
              },
            ],
          },
        ],
      }),
    );
    expect(summary.linkageKeys[0].headerFields).toEqual(["last name"]);
  });

  test("names each materially-altering rule in the header by effect or directly", () => {
    // The header entry a single last-name element produces under a given rule.
    // Guards the whole categorization: an effect name where the matching
    // direction is determinable, a direct name where a partner pattern/value list
    // makes it indeterminate, and nothing for routine standardization.
    const headerFor = (transform: LinkageKeyElement["transform"]) =>
      summarizeInvitation(
        makeToken({
          linkageFields: [{ name: "ln", type: "last_name" }],
          linkageKeys: [
            {
              name: "K",
              elements: [{ field: "ln", ...(transform && { transform }) }],
            },
          ],
        }),
      ).linkageKeys[0].headerFields[0];

    // Effect named where the direction is determinable.
    expect(
      headerFor([{ function: "substring", params: { start: 1, length: 3 } }]),
    ).toBe("last name (partial)");
    expect(headerFor([{ function: "phonetic" }])).toBe(
      "last name (sound-alike)",
    );
    expect(
      headerFor([{ function: "split_on", params: { delimiter: " " } }]),
    ).toBe("last name (multiple)");
    expect(
      headerFor([{ function: "coalesce", params: { default: "X" } }]),
    ).toBe("last name (fallback)");

    // Rule named directly where a partner pattern/value list makes the direction
    // indeterminate -- including the narrowing ones, which are surfaced too.
    expect(
      headerFor([
        {
          function: "replace_regex",
          params: { pattern: "a", replacement: "b" },
        },
      ]),
    ).toBe("last name (pattern replacement)");
    expect(
      headerFor([{ function: "extract_regex", params: { pattern: "(.*)" } }]),
    ).toBe("last name (pattern extraction)");
    expect(
      headerFor([{ function: "filter_regex", params: { pattern: ".*" } }]),
    ).toBe("last name (pattern filter)");
    expect(
      headerFor([{ function: "null_if", params: { values: ["x"] } }]),
    ).toBe("last name (excludes values)");

    // parse_date is routine canonicalization when it reformats between full
    // layouts, but narrows matching when its output drops a date component. A
    // year-only output keeps a token yet collapses every date within a year, so
    // it matches on only part of the date ("partial"); a tokenless output carries
    // no date token at all and collapses every date to one constant value -- the
    // maximal breadth, marked distinctly ("any date").
    expect(
      headerFor([
        {
          function: "parse_date",
          params: { inputFormat: "MM/DD/YYYY", outputFormat: "YYYY" },
        },
      ]),
    ).toBe("last name (partial)");
    expect(
      headerFor([
        {
          function: "parse_date",
          params: { inputFormat: "MM/DD/YYYY", outputFormat: "registered" },
        },
      ]),
    ).toBe("last name (any date)");
    expect(
      headerFor([
        {
          function: "parse_date",
          params: { inputFormat: "MM/DD/YYYY", outputFormat: "YYYYMMDD" },
        },
      ]),
    ).toBe("last name");

    // Routine standardization is not flagged.
    expect(headerFor([{ function: "pad_left", params: { length: 5 } }])).toBe(
      "last name",
    );
    // A bare parse_date defaults to the full layout on both sides -- no drop.
    expect(headerFor([{ function: "parse_date" }])).toBe("last name");
    expect(headerFor(undefined)).toBe("last name");
  });

  test("marks a tokenless parse_date output as a stronger breadth than a partial drop", () => {
    const headerFor = (transform: LinkageKeyElement["transform"]) =>
      summarizeInvitation(
        makeToken({
          linkageFields: [{ name: "ln", type: "last_name" }],
          linkageKeys: [
            {
              name: "K",
              elements: [{ field: "ln", ...(transform && { transform }) }],
            },
          ],
        }),
      ).linkageKeys[0].headerFields[0];

    // An output that keeps a date token but drops a component its input carries
    // collapses dates onto a coarser bucket -- it matches on only part of the
    // date, so it wears the same "(partial)" marker a substring truncation does.
    expect(
      headerFor([
        {
          function: "parse_date",
          params: { inputFormat: "MM/DD/YYYY", outputFormat: "YYYY" },
        },
      ]),
    ).toBe("last name (partial)");
    // An output carrying NO date token collapses every date to one constant value
    // -- the maximal match breadth -- so it earns a distinct, stronger marker
    // rather than reading as the same magnitude as a one-component drop.
    expect(
      headerFor([
        {
          function: "parse_date",
          params: { inputFormat: "MM/DD/YYYY", outputFormat: "registered" },
        },
      ]),
    ).toBe("last name (any date)");
    // The "(any date)" collapse presupposes the date is actually parsed: a
    // tokenless OUTPUT whose INPUT also carries no date token drops every record at
    // the input stage -- the element matches NOTHING, not everything -- so it earns
    // no broadening marker (the dead-key advisory, a narrowing concern, surfaces it
    // instead). See the dedicated input-drop test below.
    expect(
      headerFor([
        {
          function: "parse_date",
          params: { inputFormat: "none", outputFormat: "none" },
        },
      ]),
    ).toBe("last name");
    // Across an element's steps the stronger word wins, so an "(any date)" collapse
    // is never understated as a partial drop by an accompanying partial step.
    expect(
      headerFor([
        {
          function: "parse_date",
          params: { inputFormat: "MM/DD/YYYY", outputFormat: "YYYY" },
        },
        {
          function: "parse_date",
          params: { inputFormat: "MM/DD/YYYY", outputFormat: "registered" },
        },
      ]),
    ).toBe("last name (any date)");
    // The "(any date)" collapse is an effect, so it wins over a directly-named
    // rule the same way the partial drop does.
    expect(
      headerFor([
        { function: "null_if", params: { values: ["x"] } },
        {
          function: "parse_date",
          params: { inputFormat: "MM/DD/YYYY", outputFormat: "registered" },
        },
      ]),
    ).toBe("last name (any date)");
    // Being the maximal breadth, it outranks even a literal-truncating substring
    // (the otherwise-highest-precedence marker), in either order: once every date
    // is one value, slicing that value leaves it constant, so "(partial)" would
    // understate the collapse.
    expect(
      headerFor([
        {
          function: "parse_date",
          params: { inputFormat: "MM/DD/YYYY", outputFormat: "registered" },
        },
        { function: "substring", params: { start: 1, length: 3 } },
      ]),
    ).toBe("last name (any date)");
    expect(
      headerFor([
        { function: "substring", params: { start: 1, length: 3 } },
        {
          function: "parse_date",
          params: { inputFormat: "MM/DD/YYYY", outputFormat: "registered" },
        },
      ]),
    ).toBe("last name (any date)");
  });

  test("shows no breadth marker for a parse_date whose input drops every record", () => {
    const headerFor = (transform: LinkageKeyElement["transform"]) =>
      summarizeInvitation(
        makeToken({
          linkageFields: [{ name: "ln", type: "last_name" }],
          linkageKeys: [
            {
              name: "K",
              elements: [{ field: "ln", ...(transform && { transform }) }],
            },
          ],
        }),
      ).linkageKeys[0].headerFields[0];

    // A parse_date whose input format omits a component core requires (here no
    // year) returns null for EVERY record -- the key matches nothing, a narrowing
    // the separate dead-key advisory surfaces -- so the breadth marker, which
    // signals BROADENING, stays silent rather than misreporting the drop as a
    // widening (it showed "(partial)"/"(any date)" before this was fixed).
    expect(
      headerFor([
        {
          function: "parse_date",
          params: { inputFormat: "MM/DD", outputFormat: "YYYYMMDD" },
        },
      ]),
    ).toBe("last name");
    // The input drop dominates the output classification: the value never reaches
    // the output stage, so neither a tokenless output ("any date") ...
    expect(
      headerFor([
        {
          function: "parse_date",
          params: { inputFormat: "MM/DD", outputFormat: "registered" },
        },
      ]),
    ).toBe("last name");
    // ... nor an output that itself drops a component ("partial") fires.
    expect(
      headerFor([
        {
          function: "parse_date",
          params: { inputFormat: "DD", outputFormat: "YYYY" },
        },
      ]),
    ).toBe("last name");
    // A non-string input format (params are partner-controlled `unknown`) also
    // drops every record at runtime; core's check reports it dead without parsing
    // it, so the web shows no marker rather than narrowing it to the default.
    expect(
      headerFor([
        {
          function: "parse_date",
          params: { inputFormat: 42, outputFormat: "registered" },
        },
      ]),
    ).toBe("last name");
  });

  test("shows no breadth marker when a dead parse_date kills the element via a later rule", () => {
    const headerFor = (transform: LinkageKeyElement["transform"]) =>
      summarizeInvitation(
        makeToken({
          linkageFields: [{ name: "ln", type: "last_name" }],
          linkageKeys: [
            {
              name: "K",
              elements: [{ field: "ln", ...(transform && { transform }) }],
            },
          ],
        }),
      ).linkageKeys[0].headerFields[0];

    // A parse_date whose input format omits a component drops every record, and a
    // later step null-propagates it, so the element matches NOTHING. The breadth
    // marker (a broadening signal) must stay silent even though the later rule,
    // judged alone, would name an effect -- before the element-level guard this
    // showed the later rule's marker (a wrong-direction "(partial)" / "(sound-
    // alike)" / ... on an empty key).
    const dead = {
      function: "parse_date",
      params: { inputFormat: "MM/DD", outputFormat: "YYYYMMDD" },
    };
    expect(
      headerFor([
        dead,
        { function: "substring", params: { start: 1, length: 3 } },
      ]),
    ).toBe("last name");
    expect(headerFor([dead, { function: "phonetic" }])).toBe("last name");
    expect(
      headerFor([dead, { function: "null_if", params: { values: ["x"] } }]),
    ).toBe("last name");

    // A later `coalesce` with a string default RESCUES every dropped value to that
    // constant, so the element is NOT dead -- it matches every record as the
    // fallback constant. That is a real broadening, honestly marked "(fallback)".
    expect(
      headerFor([dead, { function: "coalesce", params: { default: "X" } }]),
    ).toBe("last name (fallback)");
    // A coalesce with no string default does not rescue, so the element stays dead.
    expect(headerFor([dead, { function: "coalesce", params: {} }])).toBe(
      "last name",
    );

    // A fuzzy expansion declared on a dead element is likewise moot -- no marker.
    const fuzzyDead = summarizeInvitation(
      makeToken({
        linkageFields: [{ name: "ln", type: "last_name" }],
        linkageKeys: [
          {
            name: "K",
            elements: [
              {
                field: "ln",
                transform: [dead],
                generateFuzzyComparisons: "adjacent_years",
              },
            ],
          },
        ],
      }),
    ).linkageKeys[0].headerFields[0];
    expect(fuzzyDead).toBe("last name");
  });

  test("shows a single most-salient marker, effect-named before directly-named", () => {
    const headerFor = (transform: LinkageKeyElement["transform"]) =>
      summarizeInvitation(
        makeToken({
          linkageFields: [{ name: "ln", type: "last_name" }],
          linkageKeys: [
            {
              name: "K",
              elements: [{ field: "ln", ...(transform && { transform }) }],
            },
          ],
        }),
      ).linkageKeys[0].headerFields[0];

    // An element carrying more than one rule shows just the most salient: an
    // effect-named rule wins over a directly-named one ...
    expect(
      headerFor([
        {
          function: "replace_regex",
          params: { pattern: "a", replacement: "b" },
        },
        { function: "substring", params: { start: 1, length: 3 } },
      ]),
    ).toBe("last name (partial)");
    // ... and a component-dropping parse_date (effect "partial") wins over a
    // directly-named null_if ...
    expect(
      headerFor([
        { function: "null_if", params: { values: ["x"] } },
        {
          function: "parse_date",
          params: { inputFormat: "MM/DD/YYYY", outputFormat: "YYYY" },
        },
      ]),
    ).toBe("last name (partial)");
    // ... but a non-dropping parse_date adds no marker, so the directly-named
    // null_if shows instead.
    expect(
      headerFor([
        {
          function: "parse_date",
          params: { inputFormat: "MM/DD/YYYY", outputFormat: "YYYYMMDD" },
        },
        { function: "null_if", params: { values: ["x"] } },
      ]),
    ).toBe("last name (excludes values)");
  });

  test("does not mark a phonetic-then-substring element as a literal truncation", () => {
    const headerFor = (transform: LinkageKeyElement["transform"]) =>
      summarizeInvitation(
        makeToken({
          linkageFields: [{ name: "ln", type: "last_name" }],
          linkageKeys: [
            {
              name: "K",
              elements: [{ field: "ln", ...(transform && { transform }) }],
            },
          ],
        }),
      ).linkageKeys[0].headerFields[0];

    // The bug: a substring after a value-recoding phonetic step slices the
    // sound-alike code, not the literal name, so "partial" (a literal truncation)
    // would misdescribe the match -- "sound-alike" is the dominant honest effect.
    expect(
      headerFor([
        { function: "phonetic" },
        { function: "substring", params: { start: 1, length: 3 } },
      ]),
    ).toBe("last name (sound-alike)");
    // Order matters, mirroring the detail row's position-aware literal: a
    // substring FIRST does truncate the literal name (phonetic then codes that
    // truncation), so "partial" is faithful and stays.
    expect(
      headerFor([
        { function: "substring", params: { start: 1, length: 3 } },
        { function: "phonetic" },
      ]),
    ).toBe("last name (partial)");
    // A routine normalizer before the substring does not recode the value out of
    // literal correspondence, so "partial" still fires.
    expect(
      headerFor([
        { function: "to_lower_case" },
        { function: "substring", params: { start: 1, length: 3 } },
      ]),
    ).toBe("last name (partial)");
    // The single-transform baselines stay unchanged by the re-ordering.
    expect(
      headerFor([{ function: "substring", params: { start: 1, length: 3 } }]),
    ).toBe("last name (partial)");
    expect(headerFor([{ function: "phonetic" }])).toBe(
      "last name (sound-alike)",
    );
    // remove_affixes earns no marker: it is a broadening canonicalizer (like
    // accent/case folding), not a record-dropping narrower, so it is deliberately
    // routine despite stripping characters (see elementBreadthMarker's doc).
    expect(headerFor([{ function: "remove_affixes" }])).toBe("last name");
  });

  test("classifies every core standardization function as marked or routine", () => {
    // The header marker is a hand-maintained classification; pin it against core's
    // full function set in both directions, so a new core function cannot ship
    // without a deliberate marked/routine decision here (the glossary sync test
    // guards the one-expand-down description, not this always-visible marker).
    // Param-dependent edges (parse_date drops, substring positions) have their own
    // tests; here each function is shown with the params that yield its baseline.
    const EXPECTED: Record<string, string | null> = {
      // Effect named where the matching direction is determinable.
      substring: "partial",
      phonetic: "sound-alike",
      split_on: "multiple",
      coalesce: "fallback",
      // Rule named directly where a partner pattern or value list makes the
      // direction indeterminate.
      replace_regex: "pattern replacement",
      extract_regex: "pattern extraction",
      filter_regex: "pattern filter",
      null_if: "excludes values",
      // Routine standardization, not flagged (parse_date is routine until its
      // output drops a component).
      remove_non_ascii: null,
      replace_separators_with_spaces: null,
      squash_spaces: null,
      remove_punctuation: null,
      remove_dashes: null,
      trim_whitespace: null,
      to_upper_case: null,
      to_lower_case: null,
      remove_accents: null,
      remove_affixes: null,
      pad_left: null,
      parse_date: null,
    };
    // Two-directional: the classification covers exactly core's function set.
    expect(Object.keys(EXPECTED).sort()).toEqual(
      [...STANDARDIZATION_FUNCTION_NAMES].sort(),
    );
    for (const [fn, marker] of Object.entries(EXPECTED)) {
      const params = fn === "substring" ? { start: 1, length: 3 } : undefined;
      const entry = summarizeInvitation(
        makeToken({
          linkageFields: [{ name: "ln", type: "last_name" }],
          linkageKeys: [
            {
              name: "K",
              elements: [
                {
                  field: "ln",
                  transform: [{ function: fn, ...(params && { params }) }],
                },
              ],
            },
          ],
        }),
      ).linkageKeys[0].headerFields[0];
      expect(entry).toBe(
        marker === null ? "last name" : `last name (${marker})`,
      );
    }
  });

  test("dedupes header entries by label and marker, keeping a truncated field distinct", () => {
    const summary = summarizeInvitation(
      makeToken({
        linkageFields: [
          { name: "given", type: "first_name" },
          { name: "preferred", type: "first_name" },
          { name: "legal", type: "first_name" },
        ],
        linkageKeys: [
          {
            name: "K",
            elements: [
              { field: "given" },
              { field: "preferred" },
              {
                field: "legal",
                transform: [
                  { function: "substring", params: { start: 1, length: 1 } },
                ],
              },
            ],
          },
        ],
      }),
    );
    // Two whole "first name" elements collapse to one; the truncated one stays
    // distinct so the looser match is not hidden behind the dedup.
    expect(summary.linkageKeys[0].headerFields).toEqual([
      "first name",
      "first name (partial)",
    ]);
  });

  test("sanitizes an unknown field in the header one-liner", () => {
    const summary = summarizeInvitation(
      makeToken({
        linkageFields: [{ name: "ssn", type: "ssn" }],
        linkageKeys: [{ name: "K", elements: [{ field: "mystery" + BEL }] }],
      }),
    );
    // An element whose field resolves to no declared type falls back to its
    // sanitized identifier -- the one partner-influenced header entry, escaped.
    const [entry] = summary.linkageKeys[0].headerFields;
    expect(entry).toContain("mystery");
    expect(entry).not.toContain(BEL);
    expect(entry).toContain("\\x07");
  });
});

describe("accept screen: the consent gate", () => {
  test("offers a consent action the gate keeps disabled without consent", () => {
    const html = renderPanel({
      decode: { status: "ready", invitation: makeInvitation() },
      consented: false,
      acceptorName: "Dana",
    });
    expect(html).toContain(CONSENT_LABEL);
    expect(html).toContain(ACCEPT_BUTTON);
    // Without consent the affirmative action is disabled, so nothing is parsed or
    // dialed. (It is also gated on a chosen file, which a static render cannot
    // supply, so the enabled state -- consent + name + file -- is exercised in
    // test/browser/acceptConsentGate.test.ts.) Match the real `disabled` HTML
    // attribute (whitespace-led, then `=`/`>`), not Mantine's `data-disabled`, so
    // the assertion tracks the button's actual disabled state.
    expect(html).toMatch(/<button[^>]*\sdisabled[=>]/);
  });

  test("offers the consent controls and a file drop, not an exchange", () => {
    // The review screen presents the gate (consent label + name) and the
    // "Accept and continue" action that selects and pre-flights a file; the
    // dialing exchange is a separate screen the route swaps in only after a
    // satisfiable acceptance (covered in the browser test).
    const html = renderPanel({
      decode: { status: "ready", invitation: makeInvitation() },
    });
    expect(html).toContain(CONSENT_LABEL);
    expect(html).toContain(ACCEPT_BUTTON);
    expect(html).toContain("choose your data file");
  });
});

describe("accept screen: an invalid or expired invitation", () => {
  test("shows the error and offers no consent action", () => {
    const decode: DecodeState = {
      status: "error",
      message:
        "This invitation has expired. Ask your partner to send a new one.",
    };
    const html = renderPanel({ decode });
    expect(html).toContain("Cannot accept this invitation");
    expect(html).toContain("has expired");
    // No terms, no consent action: a bad invitation can never be consented to.
    expect(html).not.toContain(CONSENT_LABEL);
    expect(html).not.toContain(ACCEPT_BUTTON);
  });
});
