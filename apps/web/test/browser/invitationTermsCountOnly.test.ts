/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page } from "vitest/browser";

import { createElement } from "react";

import {
  CONSENT_FACTS,
  COUNT_ONLY_DISCLOSURE_STATEMENT,
  OUTBOUND_SEND_NO_PAYLOAD_SENTENCE,
  PROPOSED_NOT_APPLIED_NOTES,
} from "@psilink/core";

import { InvitationTerms } from "@components/InvitationTerms";

import { COUNT_ONLY_PROBE_TERMS } from "@psilink/core/testing";
import { createAppMount } from "./renderApp";

import type * as PsilinkCore from "@psilink/core";
import type { LinkageTerms } from "@psilink/core";

// The consent screen renders the count-only tier behind the summary's
// `psiCApplied`, which `APPLIED_SETTINGS.psiC` holds false until the count-only run
// path lands -- so the tier the acceptance surfaces will show is unreachable from
// the terms alone. The flag is moved where the component reads it, by wrapping the
// summarizer it renders from: core's own binding is internal to the built bundle
// this app consumes, so overriding an export would not reach the read.
//
// What that leaves this file measuring is the renderer: which sentences it shows,
// in which tier, for which entitlements. That the gate itself holds -- that none of
// this reaches an operator while the exchange refuses a psi-c invitation -- is
// pinned in invitationTerms.test.ts, on the unmocked path.
vi.mock("@psilink/core", async (importOriginal) => {
  const actual = await importOriginal<typeof PsilinkCore>();
  return {
    ...actual,
    summarizeInvitation: (
      params: Parameters<typeof actual.summarizeInvitation>[0],
    ) => ({ ...actual.summarizeInvitation(params), psiCApplied: true }),
  };
});

const app = createAppMount();

afterEach(app.unmount);

function renderCountOnly(overrides?: Partial<LinkageTerms>): void {
  app.render(
    createElement(InvitationTerms, {
      linkageTerms: { ...COUNT_ONLY_PROBE_TERMS, ...overrides },
    }),
  );
}

// A named tier of the always-visible core (role=group + aria-labelledby). Asserting
// a sentence against its tier rather than against the whole container is what makes
// the assertion a placement pin: the collapsed "Other details" and "Matching
// strategies" disclosures sit outside every tier, so a tier's text is text the
// acceptor reads without expanding anything.
function tier(name: string) {
  return page.getByRole("group", { name });
}

describe("InvitationTerms: the count-only tier a run that honors psi-c renders", () => {
  test("states what the run reveals, what it still discloses, and what it does not bound -- all with the headline", async () => {
    renderCountOnly();
    await expect
      .element(tier("What the exchange produces"))
      .toBeInTheDocument();
    const produces = tier("What the exchange produces").element().textContent;
    expect(produces).toContain(COUNT_ONLY_DISCLOSURE_STATEMENT);
    expect(produces).toContain(CONSENT_FACTS.countOnlyResult.note);
    expect(produces).toContain(CONSENT_FACTS.countOnlyRoundDisclosures.note);
    // The bound belongs beside the guarantee it qualifies, by the same placement
    // rule the refusal caveat follows: a reader who takes "only a number" for the
    // safe option must not be able to reach that reading without meeting this.
    expect(produces).toContain(CONSENT_FACTS.countOnlyInputChoice.note);
    // And the caveat this tier replaces is gone: a run that honors the algorithm
    // does not refuse it.
    expect(app.container.textContent).not.toContain(
      PROPOSED_NOT_APPLIED_NOTES.psiC,
    );
  });

  test("names the algorithm, not the result entitlement, as the reason no columns leave", async () => {
    // Both parties are entitled to the count here, so the entitlement-driven
    // sentence would not fire at all and the slot would have listed the acceptor's
    // columns. Under psi-c no column moves in either direction whoever receives the
    // count, so the slot states that instead -- and states it in the words of the
    // fact rather than the words of the other case.
    renderCountOnly();
    await expect.element(tier("What you disclose")).toBeInTheDocument();
    expect(tier("What you disclose").element().textContent).toContain(
      CONSENT_FACTS.countOnlyNoPayload.note,
    );
    expect(app.container.textContent).not.toContain(
      OUTBOUND_SEND_NO_PAYLOAD_SENTENCE,
    );
    expect(app.container.textContent).not.toContain(
      "you will confirm exactly which of its columns",
    );
  });

  test("caveats the reported count only where both parties are entitled to one", async () => {
    // Where both are entitled, one party is sent the other's tally and psilink does
    // not check it. Where exactly one is, that party is the receiver by the role
    // rule and computes its own, so a line saying a count was reported would name a
    // frame the run does not send.
    renderCountOnly();
    await expect
      .element(tier("What the exchange produces"))
      .toBeInTheDocument();
    expect(tier("What the exchange produces").element().textContent).toContain(
      CONSENT_FACTS.countOnlyReportedCount.note,
    );

    app.unmount();
    renderCountOnly({
      output: { expectsOutput: false, shareWithPartner: true },
    });
    await expect
      .element(tier("What the exchange produces"))
      .toBeInTheDocument();
    expect(app.container.textContent).not.toContain(
      CONSENT_FACTS.countOnlyReportedCount.note,
    );
    expect(app.container.textContent).toContain(
      CONSENT_FACTS.countOnlyInputChoice.note,
    );
  });
});
