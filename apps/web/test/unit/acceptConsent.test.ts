import { describe, expect, test } from "vitest";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { MantineProvider } from "@mantine/core";

import { generateSharedSecret } from "@psilink/core";

import { AcceptInvitationPanel } from "@components/AcceptInvitationPanel";
import { InvitationTerms } from "@components/InvitationTerms";

import { commitAcceptance } from "@psi/acceptConsent";
import { summarizeInvitation } from "@psi/invitationSummary";

import type { ReactElement } from "react";

import type { InvitationToken, LinkageTerms } from "@psilink/core";

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
    { name: "last_name", type: "lastName" },
    { name: "dob", type: "dateOfBirth" },
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
      onAccept: () => {},
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
            type: "firstName",
            constraints: { allowedCharacters: "A-Z" + BEL },
          },
        ],
        linkageKeys: [
          {
            name: "FN",
            elements: [
              {
                field: "first_name",
                transform: [{ function: "substring" + BEL }],
              },
            ],
          },
        ],
      }),
    );
    // A transform function name and a constraint's allowedCharacters are both
    // partner-controlled, so each is neutralized before it reaches the summary.
    const fn = summary.linkageKeys[0].elements[0].transforms[0];
    expect(fn).not.toContain(BEL);
    expect(fn).toContain("\\x07");
    const constraint = summary.linkageFields[0].constraints[0];
    expect(constraint).not.toContain(BEL);
    expect(constraint).toContain("\\x07");
  });

  test("surfaces a transform, swap, and fuzzy expansion, flagging only the affected keys", () => {
    const summary = summarizeInvitation(
      makeToken({
        linkageFields: [
          { name: "ssn", type: "ssn" },
          { name: "first_name", type: "firstName" },
          { name: "last_name", type: "lastName" },
          { name: "dob", type: "dateOfBirth" },
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
              { field: "dob", generateFuzzyComparisons: "adjacentYears" },
            ],
          },
        ],
      }),
    );

    const [plain, transformed, swapped, fuzzy] = summary.linkageKeys;

    // A plain key carries no rule and raises no flag.
    expect(plain.hasNonDefaultRule).toBe(false);
    expect(plain.swap).toBeUndefined();
    expect(
      plain.elements.every(
        (element) =>
          element.transforms.length === 0 &&
          element.fuzzyComparison === undefined,
      ),
    ).toBe(true);

    // A transform is flagged, and its (sanitized) function name surfaces on the
    // element it applies to.
    expect(transformed.hasNonDefaultRule).toBe(true);
    expect(transformed.elements[1].transforms).toEqual(["substring"]);

    // A swap is flagged, and resolves to the swapped elements' field labels.
    expect(swapped.hasNonDefaultRule).toBe(true);
    expect(swapped.hasSwap).toBe(true);
    expect(swapped.swap).toEqual(["Last name", "First name"]);

    // A fuzzy expansion is flagged, and maps to its plain-language label.
    expect(fuzzy.hasNonDefaultRule).toBe(true);
    expect(fuzzy.elements[0].fuzzyComparison).toBe("adjacent years");
  });

  test("flags a swap but withholds field labels when they would not distinguish the two elements", () => {
    const summary = summarizeInvitation(
      makeToken({
        linkageFields: [{ name: "first_name", type: "firstName" }],
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
      // The swap is still flagged so it is never silently consented to ...
      expect(key.hasSwap).toBe(true);
      expect(key.hasNonDefaultRule).toBe(true);
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
          { name: "given_name", type: "firstName" },
          { name: "preferred_name", type: "firstName" },
          // A third firstName field whose constraints differ stays distinct.
          {
            name: "legal_name",
            type: "firstName",
            constraints: { allowedCharacters: "A-Z " },
          },
          { name: "dob", type: "dateOfBirth" },
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
            type: "firstName",
            constraints: { affixesAllowed: false, allowedCharacters: "A-Z " },
          },
          { name: "dob", type: "dateOfBirth" },
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

  test("renders psi-c as the count-only description", () => {
    const html = renderPanel({
      decode: {
        status: "ready",
        invitation: makeInvitation({ algorithm: "psi-c" }),
      },
    });
    expect(html).toContain("number of records");
    expect(html).not.toContain("shared identifiers");
  });

  test("renders the transform, swap, fuzzy, and constraint rules that affect matching", () => {
    const html = renderPanel({
      decode: {
        status: "ready",
        invitation: makeInvitation({
          linkageFields: [
            {
              name: "first_name",
              type: "firstName",
              constraints: { allowedCharacters: "A-Z " },
            },
            { name: "last_name", type: "lastName" },
            { name: "dob", type: "dateOfBirth" },
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
                { field: "dob", generateFuzzyComparisons: "adjacentYears" },
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
    // The non-default-rule flag is present (both keys carry a rule).
    expect(html).toContain("Non-standard matching");
    // The transform's function name and the fuzzy expansion's plain-language
    // label surface on the elements.
    expect(html).toContain("transformed (substring)");
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
          linkageFields: [{ name: "first_name", type: "firstName" }],
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
    // The swap is still flagged, but the note is generic rather than naming
    // "First name and First name".
    expect(html).toContain("Non-standard matching");
    expect(html).toContain(
      "Two of these elements may be matched in either order",
    );
    expect(html).not.toContain("First name and First name");
  });

  test("shows no non-default-rule flag for a plain term", () => {
    const html = renderPanel({
      decode: { status: "ready", invitation: makeInvitation() },
    });
    // baseTerms carries a single key with no transform, swap, or fuzzy rule.
    expect(html).not.toContain("Non-standard matching");
  });

  test("escapes injection characters in the rendered identity", () => {
    const html = render(
      createElement(InvitationTerms, {
        token: makeToken({ identity: EVIL_IDENTITY }),
      }),
    );
    expect(html).not.toContain(ESC);
    expect(html).not.toContain(RLO);
    expect(html).toContain("\\x1b");
  });
});

describe("accept screen: the consent gate", () => {
  test("offers a consent action, disabled until consent and a name are given", () => {
    const html = renderPanel({
      decode: { status: "ready", invitation: makeInvitation() },
      consented: false,
      acceptorName: "Dana",
    });
    expect(html).toContain(CONSENT_LABEL);
    expect(html).toContain(ACCEPT_BUTTON);
    // Without consent the affirmative action is disabled, so the exchange cannot
    // be started. Match the real `disabled` HTML attribute (whitespace-led, then
    // `=`/`>`), not Mantine's `data-disabled`, so the assertion tracks the
    // button's actual disabled state rather than a data attribute.
    expect(html).toMatch(/<button[^>]*\sdisabled[=>]/);
  });

  test("enables the consent action once consented and named", () => {
    const html = renderPanel({
      decode: { status: "ready", invitation: makeInvitation() },
      consented: true,
      acceptorName: "Dana",
    });
    expect(html).toContain(ACCEPT_BUTTON);
    expect(html).not.toMatch(/<button[^>]*\sdisabled[=>]/);
  });

  test("the exchange replaces the consent controls only once it is supplied", () => {
    const html = renderPanel({
      decode: { status: "ready", invitation: makeInvitation() },
      exchange: createElement("div", null, "EXCHANGE-STARTED"),
    });
    expect(html).toContain("EXCHANGE-STARTED");
    // The exchange (which dials) appears in place of the consent controls; the
    // route supplies it only after commitAcceptance succeeds.
    expect(html).not.toContain(CONSENT_LABEL);
    expect(html).not.toContain(ACCEPT_BUTTON);
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
