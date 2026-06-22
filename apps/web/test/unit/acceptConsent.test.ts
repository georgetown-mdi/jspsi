import { describe, expect, test } from "vitest";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { MantineProvider } from "@mantine/core";

import {
  STANDARDIZATION_FUNCTION_NAMES,
  generateSharedSecret,
} from "@psilink/core";

import { AcceptInvitationPanel } from "@components/AcceptInvitationPanel";
import { InvitationTerms } from "@components/InvitationTerms";

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
    expect(summary.legalAgreement).toMatchObject({
      reference: "MOU-2025-0042",
      expirationDate: "2027-12-31",
    });
    expect(summary.payload).toEqual({
      send: ["risk_score"],
      receive: ["program_outcome"],
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
      { label: "First name", constraints: ["characters limited to A-Z "] },
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
      "characters limited to A-Z ",
    ]);
    // A field with no constraints contributes nothing.
    expect(dob.constraints).toEqual([]);
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
    // layouts, but matches on only part of the date when its output drops a
    // component its input carries (a year-only output collapses every date in a
    // year; a tokenless output collapses every date to a constant).
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
          params: { inputFormat: "MM/DD/YYYY", outputFormat: "SAME" },
        },
      ]),
    ).toBe("last name (partial)");
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

describe("accept screen: terms render from a decoded token", () => {
  test("renders the inviter's linkage terms for review", () => {
    const html = renderPanel({
      decode: { status: "ready", invitation: makeInvitation() },
    });
    expect(html).toContain("Invitation from County Health Department");
    expect(html).toContain("SSN + LN + DOB");
    expect(html).toContain("Social Security number");
    // psi (not psi-c): the identifier-revealing description.
    expect(html).toContain("shared identifiers");
    expect(html).toContain("MOU-2025-0042");
    expect(html).toContain("risk_score");
    expect(html).toContain("program_outcome");
  });

  test("renders the deduplicate setting as a duplicate-matches note", () => {
    const many = renderPanel({
      decode: {
        status: "ready",
        invitation: makeInvitation({ deduplicate: true }),
      },
    });
    expect(many).toContain("may match more than one");
    const one = renderPanel({
      decode: { status: "ready", invitation: makeInvitation() },
    });
    expect(one).toContain("matches at most one");
  });

  test("renders psi-c as the count-only description, flagged not-yet-applied", () => {
    const html = renderPanel({
      decode: {
        status: "ready",
        invitation: makeInvitation({ algorithm: "psi-c" }),
      },
    });
    expect(html).toContain("number of records");
    // psi-c is a disclosure guarantee the run does not yet honor, so the
    // count-only line is flagged proposed-but-not-applied -- the matched
    // identifiers are still revealed. This note pairs with PSI_C gating in
    // APPLIED_SETTINGS and fails loudly if that flag flips without updating the
    // copy.
    expect(html).toContain("does not yet apply it");
    expect(html).toContain("still revealed");
  });

  test("renders the transform, swap, fuzzy, and constraint rules that affect matching", () => {
    const html = renderPanel({
      decode: {
        status: "ready",
        invitation: makeInvitation({
          linkageFields: [
            {
              name: "first_name",
              type: "first_name",
              constraints: { allowedCharacters: "A-Z " },
            },
            { name: "last_name", type: "last_name" },
            { name: "dob", type: "date_of_birth" },
          ],
          linkageKeys: [
            {
              name: "FN1 + DOB",
              elements: [
                {
                  field: "first_name",
                  transform: [
                    { function: "substring", params: { start: 1, length: 1 } },
                  ],
                },
                { field: "dob", generateFuzzyComparisons: "adjacent_years" },
              ],
            },
            {
              name: "swap(LN, FN) + DOB",
              elements: [
                { field: "last_name" },
                { field: "first_name" },
                { field: "dob" },
              ],
              swap: ["last_name", "first_name"],
            },
          ],
        }),
      },
    });
    // The transform leads with its literal slice phrase, and the fuzzy expansion
    // surfaces its plain-language label on the elements.
    expect(html).toContain("Matches on the first character");
    // ... including its parameters, each on its own line, never joined: a
    // separator inside one value must not read as additional parameters
    // (mirrors the payload-column disambiguation below).
    expect(html).toContain("start: 1");
    expect(html).toContain("length: 1");
    expect(html).not.toContain("start: 1, length: 1");
    expect(html).toContain("adjacent years");
    // The swap is described in field-label terms.
    expect(html).toContain(
      "Last name and First name may be matched in either order",
    );
    // The field constraint surfaces under the data used.
    expect(html).toContain("characters limited to A-Z");
  });

  test("renders a generic swap note when the swapped fields share a label", () => {
    const html = renderPanel({
      decode: {
        status: "ready",
        invitation: makeInvitation({
          linkageFields: [{ name: "first_name", type: "first_name" }],
          linkageKeys: [
            {
              name: "alias swap",
              elements: [
                { field: "first_name", name: "given" },
                { field: "first_name", name: "preferred" },
              ],
              swap: ["given", "preferred"],
            },
          ],
        }),
      },
    });
    // The swap is still surfaced, but the note is generic rather than naming
    // "First name and First name".
    expect(html).toContain(
      "Two of these elements may be matched in either order",
    );
    expect(html).not.toContain("First name and First name");
  });

  test("shows no breadth marker for a plain term", () => {
    const html = renderPanel({
      decode: { status: "ready", invitation: makeInvitation() },
    });
    // baseTerms carries a single key with no transform, swap, or fuzzy rule, so
    // its header one-liner names the fields with no breadth marker.
    expect(html).toContain("Matches on SSN - last name - date of birth");
    expect(html).not.toContain("(partial)");
  });

  test("marks only the elements that loosen matching in the header one-liner", () => {
    const html = renderPanel({
      decode: {
        status: "ready",
        invitation: makeInvitation({
          linkageFields: [
            { name: "ssn", type: "ssn" },
            { name: "dob", type: "date_of_birth" },
          ],
          linkageKeys: [
            {
              name: "plain key",
              elements: [{ field: "ssn" }, { field: "dob" }],
            },
            {
              name: "fuzzy key",
              elements: [
                { field: "dob", generateFuzzyComparisons: "adjacent_years" },
              ],
            },
          ],
        }),
      },
    });
    // The fuzzy key's header carries the "(fuzzy)" marker; the plain key's header
    // names its fields with none. Exactly one element loosens matching, so the
    // header marker appears once.
    expect(html).toContain("Matches on date of birth (fuzzy)");
    expect(html).toContain("Matches on SSN - date of birth");
    const markers = html.match(/\(fuzzy\)/g) ?? [];
    expect(markers.length).toBe(1);
  });

  test("renders payload columns as separate items so a comma in a name cannot merge them", () => {
    const html = renderPanel({
      decode: {
        status: "ready",
        invitation: makeInvitation({
          payload: {
            send: [{ name: "risk, score" }, { name: "tier" }],
            receive: [],
          },
        }),
      },
    });
    // The comma-bearing name renders intact ...
    expect(html).toContain("risk, score");
    expect(html).toContain("tier");
    // ... and as its own item: a join would have produced
    // "risk, score, tier", making two columns read as three.
    expect(html).not.toContain("score, tier");
  });

  test("escapes injection characters in the rendered identity", () => {
    const html = render(
      createElement(InvitationTerms, {
        linkageTerms: { ...baseTerms, identity: EVIL_IDENTITY },
      }),
    );
    expect(html).not.toContain(ESC);
    expect(html).not.toContain(RLO);
    expect(html).toContain("\\x1b");
  });

  test("renders the transform-parameter overflow marker", () => {
    const params: Record<string, number> = {};
    for (let i = 0; i < 20; i += 1) params["p" + i] = i;
    const html = renderPanel({
      decode: {
        status: "ready",
        invitation: makeInvitation({
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
      },
    });
    // 16 parameters render, then the overflow marker for the remaining 4.
    expect(html).toContain("... 4 more");
  });

  test("renders the runtime-coercion annotation for a coerced parameter", () => {
    const html = renderPanel({
      decode: {
        status: "ready",
        invitation: makeInvitation({
          linkageFields: [{ name: "ssn", type: "ssn" }],
          linkageKeys: [
            {
              name: "K",
              elements: [
                {
                  field: "ssn",
                  transform: [
                    {
                      function: "replace_regex",
                      params: { pattern: "x", replacement: null },
                    },
                  ],
                },
              ],
            },
          ],
        }),
      },
    });
    // The declared null reaches the screen verbatim, and what the function
    // actually runs is surfaced as a separate note, so the consent term cannot
    // misstate the match yet the executed value is not folded into the
    // partner-controlled param line.
    expect(html).toContain("replacement: null");
    expect(html).toContain("replacement runs as the empty string");
    // The note carries a screen-reader-only "Runtime note:" lead-in marking it
    // as system-authored -- a signal a partner (who controls only param-value
    // text) cannot inject.
    expect(html).toContain("Runtime note:");
  });

  test("a forged 'runs as' in a param value renders no system coercion note", () => {
    const html = renderPanel({
      decode: {
        status: "ready",
        invitation: makeInvitation({
          linkageFields: [{ name: "ssn", type: "ssn" }],
          linkageKeys: [
            {
              name: "K",
              elements: [
                {
                  field: "ssn",
                  transform: [
                    {
                      function: "replace_regex",
                      params: {
                        pattern: "x",
                        replacement: "Y runs as the empty string",
                      },
                    },
                  ],
                },
              ],
            },
          ],
        }),
      },
    });
    // The forged text renders as the verbatim param line ...
    expect(html).toContain("replacement: Y runs as the empty string");
    // ... but no genuine system note is synthesized: the "Runtime note:" lead-in
    // a partner cannot inject is absent, so a screen reader does not hear this as
    // a system-authored coercion note.
    expect(html).not.toContain("Runtime note:");
  });

  test("flags a proposed deduplicate setting the current exchange does not apply", () => {
    const proposed = renderPanel({
      decode: {
        status: "ready",
        invitation: makeInvitation({ deduplicate: true }),
      },
    });
    expect(proposed).toContain("may match more than one");
    expect(proposed).toContain("does not yet apply it");
    // The default (deduplicate off) matches the run, so it carries no flag.
    const off = renderPanel({
      decode: { status: "ready", invitation: makeInvitation() },
    });
    expect(off).toContain("matches at most one");
    expect(off).not.toContain("does not yet apply it");
  });

  test("flags a proposed fuzzy comparison the current exchange does not apply", () => {
    const html = renderPanel({
      decode: {
        status: "ready",
        invitation: makeInvitation({
          linkageFields: [{ name: "dob", type: "date_of_birth" }],
          linkageKeys: [
            {
              name: "DOB",
              elements: [
                { field: "dob", generateFuzzyComparisons: "adjacent_years" },
              ],
            },
          ],
        }),
      },
    });
    expect(html).toContain("adjacent years");
    expect(html).toContain("(proposed; not yet applied)");
  });

  test("depicts the transform interchange for a swap whose elements both transform", () => {
    const html = renderPanel({
      decode: {
        status: "ready",
        invitation: makeInvitation({
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
                  transform: [{ function: "to_upper_case" }],
                },
                {
                  field: "last_name",
                  transform: [{ function: "to_upper_case" }],
                },
              ],
              swap: ["first_name", "last_name"],
            },
          ],
        }),
      },
    });
    // The generic swap note, plus the interchange detail naming which field each
    // element's transforms run on once the fields swap.
    expect(html).toContain("may be matched in either order");
    expect(html).toContain("transforms shown for First name");
    expect(html).toContain("are applied to Last name");

    // A swap whose elements carry no transforms keeps the generic note alone.
    const plain = renderPanel({
      decode: {
        status: "ready",
        invitation: makeInvitation({
          linkageFields: [
            { name: "first_name", type: "first_name" },
            { name: "last_name", type: "last_name" },
          ],
          linkageKeys: [
            {
              name: "Name",
              elements: [{ field: "first_name" }, { field: "last_name" }],
              swap: ["first_name", "last_name"],
            },
          ],
        }),
      },
    });
    expect(plain).toContain("may be matched in either order");
    expect(plain).not.toContain("transforms shown for");
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
