/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page } from "vitest/browser";

import { createElement } from "react";

import { CONSENT_FACTS, generateSharedSecret } from "@psilink/core";

import { InvitationTerms } from "@components/InvitationTerms";

import { createAppMount } from "./renderApp";

import type { ReactNode } from "react";

import type * as PsilinkCore from "@psilink/core";

import type { InvitationToken, LinkageTerms } from "@psilink/core";

// The two withholding flags the mocked summarizer answers with, read fresh on
// every call so one test can drive both directions. Hoisted because vi.mock's
// factory is lifted above every declaration in the file.
const forced = vi.hoisted(() => ({
  acceptorTableWithheld: false,
  inviterTableWithheld: false,
}));

// InvitationTerms summarizes the terms it is handed, so a summary that
// contradicts those terms can only reach the screen by answering for the
// summarizer. Every other export passes through, so the fixtures and the
// asserted copy stay core's own.
vi.mock("@psilink/core", async (importOriginal) => {
  const actual = await importOriginal<typeof PsilinkCore>();
  return {
    ...actual,
    summarizeInvitation: (token: InvitationToken) => ({
      ...actual.summarizeInvitation(token),
      acceptorTableWithheld: forced.acceptorTableWithheld,
      inviterTableWithheld: forced.inviterTableWithheld,
    }),
  };
});

const app = createAppMount();

afterEach(app.unmount);

function soleReceiverTerms(overrides: Partial<LinkageTerms>): LinkageTerms {
  return {
    version: "1.0.0",
    identity: "County Health Department",
    date: "2026-01-01",
    algorithm: "psi",
    linkageStrategy: "cascade",
    output: { expectsOutput: true, shareWithPartner: false },
    deduplicate: true,
    linkageFields: [
      { name: "last_name", type: "last_name" },
      { name: "dob", type: "date_of_birth" },
    ],
    linkageKeys: [
      {
        name: "LN + DOB",
        elements: [{ field: "last_name" }, { field: "dob" }],
      },
    ],
    ...overrides,
  };
}

// The document whose terms derive no withholding: a cascade carries each
// party's matched positions as the rounds go.
const CASCADE_TERMS = soleReceiverTerms({ linkageStrategy: "cascade" });

// The document whose terms derive the withholding: single-pass, the inviting
// party the sole receiver, and no column requested of this party.
const WITHHOLDING_TERMS = soleReceiverTerms({
  linkageStrategy: "single-pass",
  payload: { send: [], receive: [] },
});

// The mirrored pair, for the own-membership fact: the accepting party is the
// sole receiver, so the INVITING party is the helper whose half of the table
// the exchange may withhold.
function blindHelperTerms(overrides: Partial<LinkageTerms>): LinkageTerms {
  return soleReceiverTerms({
    deduplicate: false,
    output: { expectsOutput: false, shareWithPartner: true },
    payload: { send: [{ name: "risk_score" }], receive: [] },
    ...overrides,
  });
}

// A cascade returns the inviting party its matched positions as the rounds go.
const HELPER_CASCADE_TERMS = blindHelperTerms({ linkageStrategy: "cascade" });

// Single-pass with the inviting party declaring no column of its own to send:
// the one combination the exchange closes at the wire.
const HELPER_WITHHOLDING_TERMS = blindHelperTerms({
  linkageStrategy: "single-pass",
  payload: { send: [], receive: [] },
});

function tokenFor(linkageTerms: LinkageTerms): InvitationToken {
  return {
    version: "1",
    linkageTerms,
    sharedSecret: generateSharedSecret(),
  };
}

// The "Other details" disclosure body, read only once its content has committed
// (Mantine's Collapse commits a hidden panel at a deferred priority), so a
// negative assertion cannot pass against a panel that has not rendered yet.
async function readyOtherDetails(): Promise<HTMLElement> {
  const toggle = page.getByRole("button", { name: "Other details" });
  await expect
    .poll(() => {
      const id = toggle.query()?.getAttribute("aria-controls");
      return (
        (id ? document.getElementById(id) : null)?.textContent.trim() ?? ""
      );
    })
    .not.toBe("");
  const id = toggle.element().getAttribute("aria-controls");
  const panel = id ? document.getElementById(id) : null;
  if (!panel) throw new Error("disclosure panel not found for Other details");
  return panel;
}

// The mounted screen's text, read once React has committed the render: the root
// renders concurrently, so a synchronous read can see an empty container and
// pass a negative assertion vacuously.
async function renderedText(node: ReactNode): Promise<string> {
  app.render(node);
  await expect.poll(() => app.container.textContent.trim()).not.toBe("");
  return app.container.textContent;
}

describe("InvitationTerms: the deduplicate variant's one input", () => {
  test("the sole-receiver deduplicating variant follows core's resolved flag against the terms rendered beside it", async () => {
    // The screen states the exchange's own non-receipt only where the run
    // holds it, and the whole of what it reads that from is
    // acceptorTableWithheld. Both documents here render under the OPPOSITE
    // flag to the one their own terms derive, so a screen re-deriving the
    // verdict from the strategy and the payload request -- faithful to the
    // protocol rule until that rule grows a condition -- shows the other
    // sentence and fails.
    const core = await vi.importActual<typeof PsilinkCore>("@psilink/core");

    // Non-vacuity: each fixture contradicts the flag it renders under, so
    // neither case can pass by the two agreeing.
    expect(
      core.summarizeInvitation(tokenFor(CASCADE_TERMS)).acceptorTableWithheld,
    ).toBe(false);
    expect(
      core.summarizeInvitation(tokenFor(WITHHOLDING_TERMS))
        .acceptorTableWithheld,
    ).toBe(true);

    forced.acceptorTableWithheld = true;
    app.render(createElement(InvitationTerms, { linkageTerms: CASCADE_TERMS }));
    const cascadePanel = await readyOtherDetails();
    expect(cascadePanel.textContent).toContain(
      CONSENT_FACTS.duplicateGroupingWithheld.note,
    );
    expect(app.container.textContent).not.toContain(
      CONSENT_FACTS.duplicateGroupingDisplayLimit.note,
    );

    app.unmount();
    forced.acceptorTableWithheld = false;
    app.render(
      createElement(InvitationTerms, { linkageTerms: WITHHOLDING_TERMS }),
    );
    const withholdingPanel = await readyOtherDetails();
    expect(withholdingPanel.textContent).toContain(
      CONSENT_FACTS.duplicateGroupingDisplayLimit.note,
    );
    expect(app.container.textContent).not.toContain(
      CONSENT_FACTS.duplicateGroupingWithheld.note,
    );
  });
});

describe("InvitationTerms: the own-membership variant's one input", () => {
  test("the honest-helper membership sentence follows core's resolved flag against the terms rendered beside it", async () => {
    // What a non-receiving partner learns of its own records is stated as a
    // disclosure only where the run returns that party its half of the table,
    // and the whole of what this seat reads that from is inviterTableWithheld.
    // Both documents render under the OPPOSITE flag to the one their own terms
    // derive, so a screen re-deriving the verdict from the strategy and the
    // payload declaration shows the other sentence and fails.
    const core = await vi.importActual<typeof PsilinkCore>("@psilink/core");

    // Non-vacuity: each fixture contradicts the flag it renders under, so
    // neither case can pass by the two agreeing.
    expect(
      core.summarizeInvitation(tokenFor(HELPER_CASCADE_TERMS))
        .inviterTableWithheld,
    ).toBe(false);
    expect(
      core.summarizeInvitation(tokenFor(HELPER_WITHHOLDING_TERMS))
        .inviterTableWithheld,
    ).toBe(true);

    forced.inviterTableWithheld = true;
    const cascadeUnderWithheld = await renderedText(
      createElement(InvitationTerms, { linkageTerms: HELPER_CASCADE_TERMS }),
    );
    expect(cascadeUnderWithheld).toContain(
      CONSENT_FACTS.partnerOwnMembershipWithheld.note,
    );
    expect(cascadeUnderWithheld).not.toContain(
      CONSENT_FACTS.partnerLearnsOwnMembership.note,
    );

    app.unmount();
    forced.inviterTableWithheld = false;
    const withholdingUnderDisclosure = await renderedText(
      createElement(InvitationTerms, {
        linkageTerms: HELPER_WITHHOLDING_TERMS,
      }),
    );
    expect(withholdingUnderDisclosure).toContain(
      CONSENT_FACTS.partnerLearnsOwnMembership.note,
    );
    expect(withholdingUnderDisclosure).not.toContain(
      CONSENT_FACTS.partnerOwnMembershipWithheld.note,
    );
  });

  test("reads the accepting party's half of the verdict on the seat proposing its own terms", async () => {
    // There the partner the fact speaks about is the ACCEPTING party, so the
    // sentence follows acceptorTableWithheld: a seat reading the inviting
    // party's verdict would state the wrong half's withholding. The fixtures
    // are the deduplicate pair's own, whose terms make the accepting party the
    // helper, and each again renders under the opposite flag.
    forced.inviterTableWithheld = true;
    forced.acceptorTableWithheld = false;
    const exchangedHalf = await renderedText(
      createElement(InvitationTerms, {
        linkageTerms: WITHHOLDING_TERMS,
        perspective: "proposing",
      }),
    );
    expect(exchangedHalf).toContain(
      CONSENT_FACTS.partnerLearnsOwnMembership.note,
    );
    expect(exchangedHalf).not.toContain(
      CONSENT_FACTS.partnerOwnMembershipWithheld.note,
    );

    app.unmount();
    forced.inviterTableWithheld = false;
    forced.acceptorTableWithheld = true;
    const withheldHalf = await renderedText(
      createElement(InvitationTerms, {
        linkageTerms: CASCADE_TERMS,
        perspective: "proposing",
      }),
    );
    expect(withheldHalf).toContain(
      CONSENT_FACTS.partnerOwnMembershipWithheld.note,
    );
    expect(withheldHalf).not.toContain(
      CONSENT_FACTS.partnerLearnsOwnMembership.note,
    );
  });
});
