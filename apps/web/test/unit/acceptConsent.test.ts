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

const CONSENT_LABEL =
  "I have reviewed these linkage terms and consent to this exchange";
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
    expect(summary.linkageKeyNames).toEqual(["SSN + LN + DOB"]);
    expect(summary.linkageFieldLabels).toEqual([
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
    expect(summary.linkageKeyNames[0]).not.toContain(BEL);
    expect(summary.linkageKeyNames[0]).toContain("\\x07");
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
    // be started.
    expect(html).toMatch(/<button[^>]*disabled/);
  });

  test("enables the consent action once consented and named", () => {
    const html = renderPanel({
      decode: { status: "ready", invitation: makeInvitation() },
      consented: true,
      acceptorName: "Dana",
    });
    expect(html).toContain(ACCEPT_BUTTON);
    expect(html).not.toMatch(/<button[^>]*disabled/);
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
