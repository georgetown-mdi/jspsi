import { describe, expect, test } from "vitest";

import {
  STANDARDIZATION_FUNCTION_NAMES,
  TRANSFORM_FUNCTION_GLOSSARY,
  generateSharedSecret,
  summarizeInvitation,
} from "@psilink/core";

import { commitAcceptance } from "@psi/acceptConsent";

import type {
  InvitationToken,
  LinkageKeyElement,
  LinkageTerms,
} from "@psilink/core";

// Untrusted, inviter-crafted control characters JSX escaping does not
// neutralize, built from escapes so the source contains no raw control bytes: an
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
  // The header entry a single last-name element produces under a given rule.
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
      sendFromCarriedSubset: false,
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

  test("shows the deduplicate setting", () => {
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
    // always-visible consent core, so the sanitization boundary is critical
    // here: raw control/bidi bytes must be neutralized in the summary the renderer
    // consumes, since none of the promoted fields reach the DOM except through it.
    // expirationDate is a schema-validated ISO date that cannot hold these bytes,
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
    // before it reaches the summary. The allowedCharacters class is kept apart
    // from the plain-language constraint phrases (shown as its own bounded
    // element), so it is asserted on that field rather than in `constraints`.
    const transform = summary.linkageKeys[0].elements[0].transforms[0];
    expect(transform.function).not.toContain(BEL);
    expect(transform.function).toContain("\\x07");
    expect(transform.params[0]).not.toContain(BEL);
    expect(transform.params[0]).toContain("\\x07");
    const allowed = summary.linkageFields[0].allowedCharacters;
    expect(allowed).not.toContain(BEL);
    expect(allowed).toContain("\\x07");
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
    // resolve to a semantic-type label; the raw identifier is shown as the
    // most transparent fallback, but sanitized first.
    const label = summary.linkageKeys[0].elements[0].fieldLabel;
    expect(label).toContain("mystery");
    expect(label).not.toContain(BEL);
    expect(label).toContain("\\x07");
  });

  test("shows a transform, swap, and fuzzy expansion on the affected elements", () => {
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

    // A plain key has no rule.
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
            // them would display as "First name and First name".
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
      // The swap is still shown so it is never silently consented to ...
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
    // constraint-bearing one and the date field stay distinct. The allowedCharacters
    // class is kept apart (its own field), not folded into a constraint phrase,
    // and it participates in the dedupe key so the constrained field stays distinct.
    expect(summary.linkageFields).toEqual([
      { label: "First name", constraints: [] },
      {
        label: "First name",
        constraints: [],
        allowedCharacters: "A-Z ",
      },
      { label: "Date of birth", constraints: [] },
    ]);
  });

  test("shows each field's declared constraints, summarizing the denylist", () => {
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
    // The plain-language constraint phrases; the partner-authored allowedCharacters
    // class is kept apart (its own field), not folded into a phrase here.
    expect(firstName.constraints).toEqual(["honorifics and suffixes removed"]);
    expect(firstName.allowedCharacters).toBe("A-Z ");
    // A field with no constraints contributes nothing.
    expect(dob.constraints).toEqual([]);
    expect(dob.allowedCharacters).toBeUndefined();
  });

  test("shows a partner-authored allowedCharacters class as its raw value apart from the constraint phrases", () => {
    // A leading `^` displays to a non-regex-literate operator as "allow caret and A-Z"
    // but is class negation (admits everything EXCEPT A-Z). The summary shows the
    // raw class ALONE -- not folded into a "limited to <class>" phrase, nor among
    // the plain-language constraint phrases -- so the renderer can bind it in its
    // own bounded element under a fixed, unverified system label, preserved verbatim
    // (sanitized) for a regex-literate reviewer to inspect.
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
    const field = summary.linkageFields[0];
    expect(field.allowedCharacters).toBe("^A-Z");
    // The raw class is not dressed up as a plain-language guarantee, nor folded
    // into the plain-language constraint phrases.
    expect(field.allowedCharacters).not.toContain("limited to");
    expect(field.constraints).toEqual([]);
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

  // The per-step detail summaries an element with `transform` produces, in
  // declaration order. The field is an SSN, so no step earns the name-field
  // literal slice phrase and every one is described by its own copy.
  const transformsFor = (transform: LinkageKeyElement["transform"]) =>
    summarizeInvitation(
      makeToken({
        linkageFields: [{ name: "ssn", type: "ssn" }],
        linkageKeys: [
          {
            name: "K",
            elements: [{ field: "ssn", ...(transform && { transform }) }],
          },
        ],
      }),
    ).linkageKeys[0].elements[0].transforms;

  // The summary shown for a lone transform declaring `fn`.
  const transformFor = (fn: string) => transformsFor([{ function: fn }])[0];

  test("the transform glossary stays in sync with core's function set", () => {
    // Two-directional: every function core recognizes has a description, and the
    // glossary has no entry for a function core does not (a stale key). A new
    // core function therefore cannot ship without a consent-screen description,
    // and a removed one cannot leave dead copy behind.
    expect(Object.keys(TRANSFORM_FUNCTION_GLOSSARY).sort()).toEqual(
      [...STANDARDIZATION_FUNCTION_NAMES].sort(),
    );
  });

  test("describes a transform's matching effect alongside its name", () => {
    // coalesce is the headline match-widening case: its description must name the
    // consequence (it can create matches that would not otherwise occur), not
    // restate the name. Read where the step actually substitutes -- after a rule
    // that can empty the value -- since one that cannot is described by what it
    // does instead (its own case below).
    const coalesce = transformsFor([
      { function: "substring", params: { start: 1, length: 3 } },
      { function: "coalesce", params: { default: "X" } },
    ])[1];
    expect(coalesce.function).toBe("coalesce");
    expect(coalesce.description).toBe(TRANSFORM_FUNCTION_GLOSSARY["coalesce"]);
    expect(coalesce.description).toMatch(/matches that would not otherwise/i);

    // A normalizing function is described too, so every step has context.
    expect(transformFor("to_upper_case").description).toMatch(/case/i);
  });

  test("does not describe a coalesce as substituting where it cannot", () => {
    // The header's collapse marker and this row are gated on the same core
    // predicate, so a step that substitutes nothing says so on both surfaces
    // rather than promising a fallback the run never applies. Two shapes reach
    // that state -- a default core cannot substitute (only a string is one), and a
    // position with no rule ahead of it that can empty a value -- and one line
    // covers both, since it names the conditions rather than the one that failed.
    const slice = { function: "substring", params: { start: 1, length: 3 } };
    const nonStringDefault = transformsFor([
      { function: "coalesce", params: { default: 7 } },
    ])[0].description;
    const firstPosition = transformsFor([
      { function: "coalesce", params: { default: "X" } },
      slice,
    ])[0].description;
    expect(nonStringDefault).toBe(firstPosition);
    expect(nonStringDefault).toMatch(/substitutes nothing/i);
    expect(nonStringDefault).not.toMatch(/matches that would not otherwise/i);
    // The header agrees on both: neither element has the collapse marker, and
    // the second shows what its slice does instead.
    expect(headerFor([{ function: "coalesce", params: { default: 7 } }])).toBe(
      "last name",
    );
    expect(
      headerFor([{ function: "coalesce", params: { default: "X" } }, slice]),
    ).toBe("last name (partial)");
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

  test("shows a transform with no declared parameters as an empty list", () => {
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
    // string. The param line stays verbatim and the executed value is shown
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

  test("shows a note for each coerced parameter of a step", () => {
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
        // to its sanitized raw identifier, keeping the raw byte out of the swap
        // note.
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

    // Both swapped elements have a transform: on the receiver side each keeps
    // its transforms but reads the other's field value, so the interchange is
    // depicted, named in terms of the two resolved field labels.
    const both = keyFor(upper, upper);
    expect(both.swap).toEqual(["First name", "Last name"]);
    expect(both.swapTransformInterchange).toBe(true);

    // Only one side (or neither) has a transform: nothing cross-applies both
    // ways, so the generic swap note stands and the interchange is not depicted.
    expect(keyFor(upper, undefined).swapTransformInterchange).toBe(false);
    expect(keyFor(undefined, undefined).swapTransformInterchange).toBe(false);
  });

  test("withholds the interchange when both swapped elements share a field label", () => {
    // Two firstName fields resolve to the same "First name" label, so the note
    // could not name the two sides distinctly. The interchange is suppressed even
    // though both elements have a transform -- the distinct-label gate wins over
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
  const fanOut: LinkageKeyElement["transform"] = [
    { function: "split_on", params: { delimiter: "-" } },
  ];

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
    // donor note names the element with the transform (last name) first.
    const singleB = swapKey({}, { transform: partial });
    expect(singleB.headerFields).toEqual(["first name (partial)", "last name"]);
    expect(singleB.swapTransformDonor).toEqual(["Last name", "First name"]);

    // Both sides have transforms with DIFFERENT markers: each marker moves to the
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

    // Both have the SAME marker: the swap is a visual no-op, interchange still
    // fires (the cross-apply is real even when the markers coincide).
    const bothSame = swapKey({ transform: partial }, { transform: partial });
    expect(bothSame.headerFields).toEqual([
      "first name (partial)",
      "last name (partial)",
    ]);
    expect(bothSame.swapTransformInterchange).toBe(true);

    // Neither has a transform: bare labels, no interchange, no donor note.
    const neither = swapKey({}, {});
    expect(neither.headerFields).toEqual(["first name", "last name"]);
    expect(neither.swapTransformInterchange).toBe(false);
    expect(neither.swapTransformDonor).toBeUndefined();
  });

  test("swaps a header marker to the partner's field whatever its source", () => {
    // A transform on one side, a fuzzy comparison on the other: each marker lands on
    // the field the receiver applies it to. The substring truncates last name's value
    // ("partial" -> last name); the fuzzy moves with its element, which reads first
    // name's value, so it expands first name ("fuzzy" -> first name). The applied
    // transform is anchored by the donor note; the fuzzy axis has its own
    // not-applied caveat in the detail.
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

  test("keeps a refused rule on the element that declares it, across a swap", () => {
    // "not supported" is not a breadth the receiver applies to a field; it names a
    // step the operator has to find and remove, and that step sits in the element
    // that declares it. Re-attributing it would put it on a field with no such
    // step, so the pair keeps its own markers -- the refused key has no run whose
    // per-field effect the swap could describe. The interchange note still fires:
    // the terms do interchange the two elements' rules.
    const lastNameFansOut = swapKey(
      { transform: soundAlike },
      { transform: fanOut },
    );
    expect(lastNameFansOut.headerFields).toEqual([
      "first name (sound-alike)",
      "last name (not supported)",
    ]);
    expect(lastNameFansOut.swapTransformInterchange).toBe(true);

    // Symmetric: declared on the first element, shown on the first element.
    const firstNameFansOut = swapKey(
      { transform: fanOut },
      { transform: soundAlike },
    );
    expect(firstNameFansOut.headerFields).toEqual([
      "first name (not supported)",
      "last name (sound-alike)",
    ]);

    // The lone declaring element holds it too, with nothing to trade markers with.
    expect(swapKey({}, { transform: fanOut }).headerFields).toEqual([
      "first name",
      "last name (not supported)",
    ]);
  });

  test("re-attributes a fan-out marker across a swap where the strategy matches candidates", () => {
    // The other half of the rule above. Under single-pass the key does run, and
    // what runs is the declaring element's candidate set against the OTHER
    // element's field -- so the marker re-attributes like any other breadth, and
    // the operator reads which field is matched on several values.
    const key = summarizeInvitation(
      makeToken({
        linkageStrategy: "single-pass",
        linkageFields: [
          { name: "first_name", type: "first_name" },
          { name: "last_name", type: "last_name" },
        ],
        linkageKeys: [
          {
            name: "Name",
            elements: [
              { field: "first_name", transform: soundAlike },
              { field: "last_name", transform: fanOut },
            ],
            swap: ["first_name", "last_name"],
          },
        ],
      }),
    ).linkageKeys[0];
    expect(key.headerFields).toEqual([
      "first name (multiple)",
      "last name (sound-alike)",
    ]);
  });

  test("keeps a refused rule on its own field without a swap", () => {
    // The plain shape, where no re-attribution runs at all: the marker sits on the
    // declaring element's field, and the sibling element is unmarked.
    const key = summarizeInvitation(
      makeToken({
        linkageFields: [
          { name: "first_name", type: "first_name" },
          { name: "last_name", type: "last_name" },
        ],
        linkageKeys: [
          {
            name: "Name",
            elements: [
              { field: "first_name", transform: soundAlike },
              { field: "last_name", transform: fanOut },
            ],
          },
        ],
      }),
    ).linkageKeys[0];
    expect(key.headerFields).toEqual([
      "first name (sound-alike)",
      "last name (not supported)",
    ]);
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

  test("marks the fuzzy expansion as proposed but not yet applied, and deduplicate as applied", () => {
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
    // The fuzzy expansion is shown (the term as proposed) but flagged as not
    // run by today's exchange, so the renderer marks it rather than state a
    // behavior that does not occur. Deduplication IS run, so it has no such
    // flag and the renderer states what it discloses instead.
    expect(summary.deduplicateApplied).toBe(true);
    expect(summary.linkageKeys[0].elements[0].fuzzyComparisonApplied).toBe(
      false,
    );
  });

  test("shows psi-c with no applied qualifier, since the run honors it", () => {
    // The algorithm is what a surface reads to decide whether the count-only tier
    // renders; the summary has no second flag that could hold it back while the
    // exchange conducts the run.
    const summary = summarizeInvitation(
      makeToken({
        algorithm: "psi-c",
        linkageFields: [{ name: "ssn", type: "ssn" }],
        linkageKeys: [{ name: "K", elements: [{ field: "ssn" }] }],
      }),
    );
    expect(summary.algorithm).toBe("psi-c");
    expect(summary).not.toHaveProperty("psiCApplied");
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
    // A date is canonicalized by a standardization the token does not hold, so a
    // positional phrase ("the first 6 characters") would be unverifiable; the
    // element falls back to the glossary description, with the "(partial)" header
    // marker still showing the breadth.
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
    // Case-folding does not change which distinct values match, so it has no
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
    // Guards the whole categorization: an effect name where the matching
    // direction is determinable, a direct name where a partner pattern/value list
    // makes it indeterminate, and nothing for routine standardization.

    // Effect named where the direction is determinable.
    expect(
      headerFor([{ function: "substring", params: { start: 1, length: 3 } }]),
    ).toBe("last name (partial)");
    expect(headerFor([{ function: "phonetic" }])).toBe(
      "last name (sound-alike)",
    );
    // Refused outright rather than named for its breadth: core refuses a declared
    // fan-out before the exchange runs, so no matching of any breadth happens.
    expect(
      headerFor([{ function: "split_on", params: { delimiter: " " } }]),
    ).toBe("last name (not supported)");
    // The collapse a coalesce names needs a rule ahead of it that can empty the
    // value, which is the only state its substituting branch fires in; as the only
    // step it substitutes nothing, so it earns no marker (the collapse ranking's
    // own test pins the position it does earn one in).
    expect(
      headerFor([
        { function: "substring", params: { start: 1, length: 3 } },
        { function: "coalesce", params: { default: "X" } },
      ]),
    ).toBe("last name (fallback)");
    expect(
      headerFor([{ function: "coalesce", params: { default: "X" } }]),
    ).toBe("last name");

    // Rule named directly where a partner pattern/value list makes the direction
    // indeterminate -- including the narrowing ones, which are shown too.
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
    // it matches on only part of the date ("partial"); a tokenless output has
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

    // A two-digit-year input (MM/DD/YY) to a four-digit-year output is not a drop:
    // in the INPUT context both YY and YYYY are the year component, so the input
    // has year/month/day and the output keeps all three -- routine
    // canonicalization, unflagged. This pins that the year-token collapse recovers
    // core's greedy tokenization rather than substring-counting a YY inside YYYY.
    expect(
      headerFor([
        {
          function: "parse_date",
          params: { inputFormat: "MM/DD/YY", outputFormat: "YYYYMMDD" },
        },
      ]),
    ).toBe("last name");

    // A YY in the OUTPUT format is NOT a resolved year -- the factory substitutes
    // only YYYY/MM/DD, so "MM/DD/YY" writes the literal "YY" where the year would
    // go, collapsing the year. It keeps month and day but drops the year, so it is
    // a partial collapse, not routine canonicalization.
    expect(
      headerFor([
        {
          function: "parse_date",
          params: { inputFormat: "MM/DD/YYYY", outputFormat: "MM/DD/YY" },
        },
      ]),
    ).toBe("last name (partial)");
    // A YY-only output collapses every date to the constant literal "YY" -- the
    // maximal breadth, the same as a tokenless output.
    expect(
      headerFor([
        {
          function: "parse_date",
          params: { inputFormat: "MM/DD/YYYY", outputFormat: "YY" },
        },
      ]),
    ).toBe("last name (any date)");

    // Routine standardization is not flagged.
    expect(headerFor([{ function: "pad_left", params: { length: 5 } }])).toBe(
      "last name",
    );
    // A bare parse_date defaults to the full layout on both sides -- no drop.
    expect(headerFor([{ function: "parse_date" }])).toBe("last name");
    expect(headerFor(undefined)).toBe("last name");
  });

  test("ranks the tokenless parse_date collapse above every other marker", () => {
    // The "(any date)" collapse presupposes the date is actually parsed: a
    // tokenless OUTPUT whose INPUT also has no date token drops every record at
    // the input stage -- the element matches NOTHING, not everything -- so it earns
    // no broadening marker (the dead-key advisory, a narrowing concern, reports it
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

  test("treats a slice of the date layout's literal region as the collapse it is", () => {
    // The output format is inviter-authored text with only YYYY/MM/DD substituted,
    // so its literal characters are the same for every record. A window landing
    // wholly inside one leaves every date on one constant -- the maximal breadth,
    // shown as the collapse it is rather than the truncation "(partial)" names.
    const literalRegion = {
      function: "parse_date",
      params: { inputFormat: "MM/DD/YYYY", outputFormat: "ACME-YYYYMMDD" },
    };
    expect(
      headerFor([
        literalRegion,
        { function: "substring", params: { start: 1, length: 4 } },
      ]),
    ).toBe("last name (any date)");
    // A bare separator between two components is the same collapse at one
    // character: "YYYY-MM-DD" puts a literal "-" at position 5.
    expect(
      headerFor([
        {
          function: "parse_date",
          params: { inputFormat: "MM/DD/YYYY", outputFormat: "YYYY-MM-DD" },
        },
        { function: "substring", params: { start: 5, length: 1 } },
      ]),
    ).toBe("last name (any date)");
    // A window straddling the literal and the token reads part of the date, so
    // the truncation is the accurate word and the collapse is not claimed.
    expect(
      headerFor([
        literalRegion,
        { function: "substring", params: { start: 1, length: 6 } },
      ]),
    ).toBe("last name (partial)");
    // A plain layout has no literal region to land in, so every verdict there is
    // the one it already earned: a slice of a reformatting parse_date truncates
    // the canonical date, and the parse_date's own component drop still displays
    // "(partial)" with no slice at all.
    expect(
      headerFor([
        {
          function: "parse_date",
          params: { inputFormat: "MM/DD/YYYY", outputFormat: "YYYYMMDD" },
        },
        { function: "substring", params: { start: 1, length: 4 } },
      ]),
    ).toBe("last name (partial)");
    expect(
      headerFor([
        {
          function: "parse_date",
          params: { inputFormat: "MM/DD/YYYY", outputFormat: "YYYY" },
        },
      ]),
    ).toBe("last name (partial)");
    // Being a collapse of EVERY record, it outranks the coalesce fallback that
    // collapses only the records an earlier rule emptied.
    expect(
      headerFor([
        literalRegion,
        { function: "substring", params: { start: 1, length: 4 } },
        { function: "coalesce", params: { default: "X" } },
      ]),
    ).toBe("last name (any date)");
    // And like the tokenless collapse it presupposes a date is parsed at all: an
    // input format that drops every record leaves the element matching nothing.
    expect(
      headerFor([
        {
          function: "parse_date",
          params: { inputFormat: "MM/DD", outputFormat: "ACME-YYYYMMDD" },
        },
        { function: "substring", params: { start: 1, length: 4 } },
      ]),
    ).toBe("last name");
  });

  test("composes a run of slices before reading the date layout", () => {
    // Each slice reads a contiguous range of the one before it, so a run of them
    // is one window of the rendered layout. Neither link here reads only the
    // format's own characters on its own -- the first spans the whole layout --
    // yet the run leaves every record on "ACME", so the header must name the
    // collapse rather than the truncation each link alone suggests.
    const literalRegion = {
      function: "parse_date",
      params: { inputFormat: "MM/DD/YYYY", outputFormat: "ACME-YYYYMMDD" },
    };
    expect(
      headerFor([
        literalRegion,
        { function: "substring", params: { start: 1, length: 13 } },
        { function: "substring", params: { start: 1, length: 4 } },
      ]),
    ).toBe("last name (any date)");
    // A run whose composed window still reaches the date truncates, exactly as a
    // single slice there would.
    expect(
      headerFor([
        literalRegion,
        { function: "substring", params: { start: 1, length: 13 } },
        { function: "substring", params: { start: 1, length: 6 } },
      ]),
    ).toBe("last name (partial)");
  });

  test("names the collapse through a step between the parse_date and the slice", () => {
    // A case fold leaves a date of digits and separators exactly where the layout
    // put it, so the runtime collapses every record onto "ACME" -- and core
    // measures that rather than reading it off the intervening step's name, so
    // the header names the collapse rather than the milder truncation.
    const literalRegion = {
      function: "parse_date",
      params: { inputFormat: "MM/DD/YYYY", outputFormat: "ACME-YYYYMMDD" },
    };
    expect(
      headerFor([
        literalRegion,
        { function: "to_upper_case" },
        { function: "substring", params: { start: 1, length: 4 } },
      ]),
    ).toBe("last name (any date)");
    // The same step over a window it DOES shift: removing the format's own dash
    // pulls the year's first digit into a five-character window, so the accurate
    // word there is the truncation. One function, opposite verdicts -- which is
    // why the header cannot read this off a step's name.
    expect(
      headerFor([
        literalRegion,
        { function: "remove_dashes" },
        { function: "substring", params: { start: 1, length: 5 } },
      ]),
    ).toBe("last name (partial)");
  });

  test("withholds every marker where the run's window leaves the layout", () => {
    // The first slice reads the literal region and the second composes out of
    // that four-character window, so the element matches no record at all.
    // Announcing the collapse at the first slice would name an element matching
    // nothing as matching every date, and the truncation word would name a slice
    // of a value no record holds -- so the header shows the field alone.
    expect(
      headerFor([
        {
          function: "parse_date",
          params: { inputFormat: "MM/DD/YYYY", outputFormat: "ACME-YYYYMMDD" },
        },
        { function: "substring", params: { start: 1, length: 4 } },
        { function: "substring", params: { start: 5, length: 2 } },
      ]),
    ).toBe("last name");
  });

  test("keeps the collapse where an authored step names one probe date", () => {
    // The dates the measurement probes ship in public source. A step naming what
    // one of them renders to drops that probe, and the surviving probes still
    // leave every other date on "ACME", so the header names the collapse rather
    // than the milder word a withdrawn verdict would leave.
    expect(
      headerFor([
        {
          function: "parse_date",
          params: { inputFormat: "MM/DD/YYYY", outputFormat: "ACME-YYYYMMDD" },
        },
        { function: "null_if", params: { values: ["ACME-19710102"] } },
        { function: "substring", params: { start: 1, length: 4 } },
      ]),
    ).toBe("last name (any date)");
  });

  test("shows no breadth marker for a parse_date whose input drops every record", () => {
    // A parse_date whose input format omits a component core requires (here no
    // year) returns null for EVERY record -- the key matches nothing, a narrowing
    // the separate dead-key advisory reports -- so the breadth marker, which
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
    // fallback constant. That is a real broadening, accurately marked "(fallback)".
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
    // An element with more than one rule shows just the most salient: an
    // effect-named rule wins over a directly-named one ...
    expect(
      headerFor([
        { function: "null_if", params: { values: ["x"] } },
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

  test("ranks a collapse onto one constant above a coarsening effect", () => {
    // A coalesce that substitutes puts every record an earlier rule emptied on one
    // constant, so those records match each other however the pipeline coarsens
    // that constant afterwards. Each marker it outranks names a coarsening, which
    // would understate the collapse in the reassuring direction on the surface
    // where the acceptor consents.
    const slice = { function: "substring", params: { start: 1, length: 3 } };
    const coalesce = { function: "coalesce", params: { default: "X" } };
    expect(headerFor([slice, coalesce])).toBe("last name (fallback)");
    expect(headerFor([{ function: "phonetic" }, coalesce])).toBe(
      "last name (fallback)",
    );
    expect(
      headerFor([
        { function: "filter_regex", params: { pattern: ".*" } },
        coalesce,
      ]),
    ).toBe("last name (fallback)");
    // The other order is a different element, not the same one written twice: the
    // coalesce is reached with the value still in hand -- an element pipeline
    // starts from a value the record realized, and a record whose field is absent
    // is dropped from the key rather than run through the steps -- so it
    // substitutes nothing and the element shows what its other rule does.
    expect(headerFor([coalesce, slice])).toBe("last name (partial)");
    expect(headerFor([coalesce, { function: "phonetic" }])).toBe(
      "last name (sound-alike)",
    );
    expect(headerFor([coalesce])).toBe("last name");
    // The collapse tier is also gated on a default that can substitute. The wire
    // schema puts no per-function shape on params, so a partner can declare a
    // default that is absent or not a string; core then runs the step as a
    // pass-through, nothing collapses, and the chain names what the element's other
    // rules do. Over-alarming misstates the terms as surely as understating them.
    const inertCoalesce = { function: "coalesce", params: {} };
    const nonStringCoalesce = { function: "coalesce", params: { default: 7 } };
    expect(headerFor([slice, inertCoalesce])).toBe("last name (partial)");
    expect(headerFor([slice, nonStringCoalesce])).toBe("last name (partial)");
    expect(headerFor([inertCoalesce, slice])).toBe("last name (partial)");
    expect(headerFor([nonStringCoalesce, slice])).toBe("last name (partial)");
    expect(headerFor([inertCoalesce])).toBe("last name");
    expect(headerFor([nonStringCoalesce])).toBe("last name");
    // A fuzzy expansion coarsens whatever value it is handed, so the collapse
    // outranks it too -- and where the coalesce cannot fire, "fuzzy" is the accurate
    // marker the element keeps.
    const withFuzzy = (transform: LinkageKeyElement["transform"]) =>
      summarizeInvitation(
        makeToken({
          linkageFields: [{ name: "ln", type: "last_name" }],
          linkageKeys: [
            {
              name: "K",
              elements: [
                {
                  field: "ln",
                  ...(transform && { transform }),
                  generateFuzzyComparisons: "adjacent_years",
                },
              ],
            },
          ],
        }),
      ).linkageKeys[0].headerFields[0];
    expect(withFuzzy([slice, coalesce])).toBe("last name (fallback)");
    expect(withFuzzy([coalesce])).toBe("last name (fuzzy)");
    // The wider collapse still wins: a tokenless parse_date output puts EVERY
    // record on one value, not only the emptied ones (and its own drops are what
    // the coalesce would substitute for).
    expect(
      headerFor([
        {
          function: "parse_date",
          params: { inputFormat: "MM/DD/YYYY", outputFormat: "registered" },
        },
        coalesce,
      ]),
    ).toBe("last name (any date)");
    // A refused fan-out still outranks every breadth marker: there is no run to
    // describe a breadth of.
    expect(
      headerFor([
        { function: "split_on", params: { delimiter: " " } },
        slice,
        coalesce,
      ]),
    ).toBe("last name (not supported)");
    // Single-step markers, pinned so compound precedence cannot change them.
    expect(headerFor([slice])).toBe("last name (partial)");
    expect(headerFor([{ function: "phonetic" }])).toBe(
      "last name (sound-alike)",
    );
  });

  test("ranks the padded slice above the rules that only narrow", () => {
    // A window landing in the fill collapses every short record onto one constant,
    // a broadening the terms establish. filter_regex and null_if name a NARROWING
    // and substitute nothing a slice could read, so the compound stays exactly true
    // beside them -- showing their milder word would hide the collapse.
    const pad = { function: "pad_left", params: { length: 9 } };
    const slice = { function: "substring", params: { start: 1, length: 3 } };
    const nullIf = { function: "null_if", params: { values: ["x"] } };
    const filterRegex = { function: "filter_regex", params: { pattern: ".*" } };
    expect(headerFor([pad, slice, nullIf])).toBe("last name (padded slice)");
    expect(headerFor([nullIf, pad, slice])).toBe("last name (padded slice)");
    expect(headerFor([pad, slice, filterRegex])).toBe(
      "last name (padded slice)",
    );
    // The two value-REWRITING pattern rules keep their rank above it: a rewrite
    // can dissolve the padding before the slice reads it, so the compound is no
    // longer established by the terms and the indeterminate rule is named instead.
    expect(
      headerFor([
        pad,
        {
          function: "replace_regex",
          params: { pattern: "a", replacement: "b" },
        },
        slice,
      ]),
    ).toBe("last name (pattern replacement)");
    expect(
      headerFor([
        pad,
        slice,
        { function: "extract_regex", params: { pattern: "(.*)" } },
      ]),
    ).toBe("last name (pattern extraction)");
    // An effect-named rule still outranks the whole directly-named group.
    expect(headerFor([pad, slice, { function: "phonetic" }])).toBe(
      "last name (sound-alike)",
    );
    // The stated limit of that rank, pinned rather than left to the prose: an
    // effect-named marker MASKS the padded slice, and the masking word can be the milder
    // one. Each of these collapses every short record onto one constant through a window
    // landing in the fill, and each renders the coarsening word. Both are expert-authored
    // edge cases (see elementBreadthMarker's ranking doc) the ranking is not re-cut
    // for by design, so this pin records the understatement rather than blessing it.
    expect(
      headerFor([
        pad,
        slice,
        {
          function: "parse_date",
          params: { inputFormat: "MM/DD/YYYY", outputFormat: "YYYY" },
        },
      ]),
    ).toBe("last name (partial)");
    expect(headerFor([slice, pad, slice])).toBe("last name (partial)");
    // Single-step markers, pinned so compound precedence cannot change them.
    expect(headerFor([nullIf])).toBe("last name (excludes values)");
    expect(headerFor([filterRegex])).toBe("last name (pattern filter)");
    expect(headerFor([pad])).toBe("last name");
    expect(headerFor([pad, slice])).toBe("last name (padded slice)");
  });

  test("does not mark a phonetic-then-substring element as a literal truncation", () => {
    // The bug: a substring after a value-recoding phonetic step slices the
    // sound-alike code, not the literal name, so "partial" (a literal truncation)
    // would misdescribe the match -- "sound-alike" is the dominant accurate effect.
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
    // accent/case folding), not a record-dropping narrower, so it is routine by
    // design despite stripping characters (see elementBreadthMarker's doc).
    expect(headerFor([{ function: "remove_affixes" }])).toBe("last name");
  });

  test("decides 'partial' per value-deriving step before a substring", () => {
    // "(partial)" claims the slice truncates the acceptor's own identifier, so
    // each transform that can derive a value before a substring gets a decided,
    // pinned answer: it keeps "(partial)" where the identifier still composes the
    // sliced value, and falls through to its own marker where it need not.
    const slice = { function: "substring", params: { start: 1, length: 3 } };

    // replace_regex composes the value from an arbitrary partner pattern and
    // replacement, which need share no character with the identifier (`.*`
    // collapses every value to the replacement), so a determinate "(partial)"
    // would assert a breadth the terms cannot support -- and assert it in the
    // reassuring direction. The indeterminate rule is named instead.
    expect(
      headerFor([
        {
          function: "replace_regex",
          params: { pattern: "a", replacement: "b" },
        },
        slice,
      ]),
    ).toBe("last name (pattern replacement)");

    // pad_left prepends fill the terms supply rather than the value, so whether
    // the window reads identifier characters, pure fill, or a mix turns on each
    // record's own value length -- "(partial)" would assert a determinate breadth
    // the terms cannot support. Padding alone is routine, so the suppressed
    // compound falls through to a marker named for the compound itself rather than
    // showing nothing.
    expect(
      headerFor([{ function: "pad_left", params: { length: 9 } }, slice]),
    ).toBe("last name (padded slice)");
    // Order matters here as it does for phonetic: the substring FIRST truncates
    // the literal identifier, and padding that truncation leaves "(partial)"
    // faithful.
    expect(
      headerFor([slice, { function: "pad_left", params: { length: 9 } }]),
    ).toBe("last name (partial)");

    // extract_regex returns a contiguous run of the value's own characters, so a
    // slice of that run is still part of the identifier whatever the pattern.
    expect(
      headerFor([
        { function: "extract_regex", params: { pattern: "(.*)" } },
        slice,
      ]),
    ).toBe("last name (partial)");

    // parse_date lays the canonical date out from the date's own components, so
    // slicing it matches on part of the date. Keeping "(partial)" is also what
    // stops this date-collapsing element from showing no marker at all: a merely
    // reformatting parse_date earns none of its own.
    expect(
      headerFor([
        {
          function: "parse_date",
          params: { inputFormat: "MM/DD/YYYY", outputFormat: "YYYYMMDD" },
        },
        slice,
      ]),
    ).toBe("last name (partial)");
    // A parse_date whose output also drops a component reads "(partial)" from
    // either rule, so no date-collapsing slice is left unmarked.
    expect(
      headerFor([
        {
          function: "parse_date",
          params: { inputFormat: "MM/DD/YYYY", outputFormat: "YYYY" },
        },
        slice,
      ]),
    ).toBe("last name (partial)");

    // coalesce substitutes only where an earlier rule emptied the value, so a
    // record that still has an identifier is truncated literally and the
    // truncation rule is not suppressed. Reached FIRST it substitutes nothing --
    // the value is still in hand -- so the slice's own "partial" is what the
    // element shows. The reverse order is a real collapse, which outranks the
    // truncation (its own case above), so the two orders part here.
    expect(
      headerFor([{ function: "coalesce", params: { default: "X" } }, slice]),
    ).toBe("last name (partial)");
    expect(
      headerFor([slice, { function: "coalesce", params: { default: "X" } }]),
    ).toBe("last name (fallback)");

    // split_on never reaches the truncation rule: it is a fan-out, decided above
    // every breadth marker -- refused under cascade, and named for the candidate
    // set under the strategy that matches it.
    const splitThenSlice = [
      { function: "split_on", params: { delimiter: " " } },
      slice,
    ];
    expect(headerFor(splitThenSlice)).toBe("last name (not supported)");
    expect(
      summarizeInvitation(
        makeToken({
          linkageStrategy: "single-pass",
          linkageFields: [{ name: "ln", type: "last_name" }],
          linkageKeys: [
            {
              name: "K",
              elements: [{ field: "ln", transform: splitThenSlice }],
            },
          ],
        }),
      ).linkageKeys[0].headerFields[0],
    ).toBe("last name (multiple)");

    // A breaking step AFTER the substring does not suppress it: the literal is
    // truncated first, so "(partial)" stays faithful.
    expect(
      headerFor([
        slice,
        {
          function: "replace_regex",
          params: { pattern: "a", replacement: "b" },
        },
      ]),
    ).toBe("last name (partial)");

    // Each of these steps standing alone still earns its own marker, so the
    // compound rule above reaches no element with a single transform --
    // except pad_left, whose standalone padding stays routine, which is why the
    // compound needs a marker of its own, and coalesce, which as the only step is
    // reached with the value in hand and substitutes nothing.
    expect(headerFor([{ function: "pad_left", params: { length: 9 } }])).toBe(
      "last name",
    );
    expect(headerFor([slice])).toBe("last name (partial)");
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
      headerFor([{ function: "coalesce", params: { default: "X" } }]),
    ).toBe("last name");
  });

  test("pins what each core function does to a substring that follows it", () => {
    // The suppression rule is order-sensitive and hand-maintained, and the JSDoc
    // enumeration behind it is prose, so pin its verdict for every function core
    // admits: the marker keeps "(partial)" where the acceptor's identifier still
    // composes the sliced value, and names another accurate rule where a window can
    // read text the value did not supply. The reverse order and the standalone
    // baselines have their own cases above.
    const slice = { function: "substring", params: { start: 1, length: 3 } };
    // Undefined-valued so the functions taking no params (every normalizer, and
    // phonetic) fall out of the lookup rather than needing an empty entry.
    const PARAMS: Record<string, Record<string, unknown> | undefined> = {
      substring: { start: 1, length: 3 },
      pad_left: { length: 9 },
      parse_date: { inputFormat: "MM/DD/YYYY", outputFormat: "YYYYMMDD" },
      null_if: { values: ["x"] },
      replace_regex: { pattern: "a", replacement: "b" },
      extract_regex: { pattern: "(.*)" },
      filter_regex: { pattern: ".*" },
      split_on: { delimiter: " " },
      coalesce: { default: "X" },
    };
    const MARKER_BEFORE_A_SUBSTRING: Record<string, string> = {
      // Every character of the output comes from the value itself -- folded,
      // dropped, or (a separator) mapped one for one -- so the slice still reads
      // the identifier.
      remove_non_ascii: "partial",
      replace_separators_with_spaces: "partial",
      squash_spaces: "partial",
      remove_punctuation: "partial",
      remove_dashes: "partial",
      trim_whitespace: "partial",
      to_upper_case: "partial",
      to_lower_case: "partial",
      remove_accents: "partial",
      remove_affixes: "partial",
      // Likewise for the value-deriving steps that still derive from the value: a
      // slice of a slice, a captured run of the value's own characters, a
      // pass-through-or-drop, a date laid out from its own components, and a
      // fallback that substitutes nothing in this leading position (a coalesce
      // reached with the value still in hand passes it through, so there is
      // nothing to collapse and the slice's truncation is what the element does).
      substring: "partial",
      extract_regex: "partial",
      filter_regex: "partial",
      null_if: "partial",
      parse_date: "partial",
      coalesce: "partial",
      // These three derive a value the identifier need not compose, so the
      // slice is not a truncation of it and each falls through to the accurate
      // marker for what the element actually does.
      phonetic: "sound-alike",
      replace_regex: "pattern replacement",
      pad_left: "padded slice",
      // A declared fan-out is decided above the truncation rule entirely: under
      // these cascade terms the exchange is refused rather than named a breadth.
      split_on: "not supported",
    };
    // Two-directional: the table covers exactly core's function set, so a new
    // core function fails here until it gets a verdict.
    expect(Object.keys(MARKER_BEFORE_A_SUBSTRING).sort()).toEqual(
      [...STANDARDIZATION_FUNCTION_NAMES].sort(),
    );
    for (const [fn, marker] of Object.entries(MARKER_BEFORE_A_SUBSTRING)) {
      const params = PARAMS[fn];
      expect(
        headerFor([{ function: fn, ...(params && { params }) }, slice]),
      ).toBe(`last name (${marker})`);
    }
  });

  test("classifies every core standardization function as marked or routine", () => {
    // The header marker is a hand-maintained classification; pin it against core's
    // full function set in both directions, so a new core function cannot ship
    // without an explicit marked/routine decision here (the glossary sync test
    // guards the one-expand-down description, not this always-visible marker).
    // Param-dependent edges (parse_date drops, substring positions) have their own
    // tests; here each function is shown with the params that yield its baseline.
    const EXPECTED: Record<string, string | null> = {
      // Effect named where the matching direction is determinable.
      substring: "partial",
      phonetic: "sound-alike",
      // Refused rather than named for a breadth: under these cascade terms the
      // exchange does not run at all with a declared fan-out step. Its other
      // marker, under the strategy that matches the candidate set, has its own
      // test below.
      split_on: "not supported",
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
      // Routine as the only step for a reason of position rather than of kind: a
      // coalesce is reached with the value the record realized still in hand, so
      // its substituting branch never fires and nothing collapses. It is shown
      // below with a string default, the shape that DOES substitute once a rule
      // that can empty the value runs ahead of it (the collapse ranking's test).
      coalesce: null,
    };
    // The params each function needs to reach its baseline: a substring that
    // actually truncates, and a coalesce whose default is the substitutable shape.
    // Every other function's baseline needs none.
    const BASELINE_PARAMS: Record<string, Record<string, unknown> | undefined> =
      {
        substring: { start: 1, length: 3 },
        coalesce: { default: "X" },
      };
    // Two-directional: the classification covers exactly core's function set.
    expect(Object.keys(EXPECTED).sort()).toEqual(
      [...STANDARDIZATION_FUNCTION_NAMES].sort(),
    );
    for (const [fn, marker] of Object.entries(EXPECTED)) {
      const params = BASELINE_PARAMS[fn];
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
