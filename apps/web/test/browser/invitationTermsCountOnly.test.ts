/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page } from "vitest/browser";

import { Component, createElement } from "react";

import {
  CONSENT_FACTS,
  COUNT_ONLY_DISCLOSURE_STATEMENT,
  OUTBOUND_SEND_NO_PAYLOAD_SENTENCE,
} from "@psilink/core";

import { InvitationTerms } from "@components/InvitationTerms";

import { COUNT_ONLY_PROBE_TERMS } from "@psilink/core/testing";
import { createAppMount } from "./renderApp";

import type { ComponentProps, ReactNode } from "react";

import type { LinkageTerms } from "@psilink/core";

// What this file measures is the renderer: which count-only sentences the consent
// screen shows, in which tier, for which entitlements. The whole tier is reached
// from the algorithm alone, so every rendering here is driven from a psi-c terms
// document with nothing forced. The CLI accept prompt's half of the same pairs is
// in apps/cli/test/unit/accept.test.ts.

const app = createAppMount();

afterEach(app.unmount);

function renderCountOnly(overrides?: Partial<LinkageTerms>): void {
  app.render(
    createElement(InvitationTerms, {
      linkageTerms: { ...COUNT_ONLY_PROBE_TERMS, ...overrides },
    }),
  );
}

const REFUSAL_TESTID = "count-only-render-refusal";

/**
 * An error boundary that renders a caught render error's message, standing in for
 * the route-level catch boundary the app mounts these terms under. It is what lets
 * the count-only slot's fail-closed check be treated as a message rather than as an
 * unhandled error, on the surface whose impossible-state idiom is a render throw.
 */
class CaughtRenderError extends Component<
  { children: ReactNode },
  { message: string }
> {
  state: { message: string } = { message: "" };

  static getDerivedStateFromError(error: unknown): { message: string } {
    return {
      message:
        error instanceof Error ? error.message : "a non-Error was thrown",
    };
  }

  render(): ReactNode {
    return this.state.message === ""
      ? this.props.children
      : createElement(
          "p",
          { "data-testid": REFUSAL_TESTID },
          this.state.message,
        );
  }
}

/** The count-only terms mounted under {@link CaughtRenderError}. */
function renderCountOnlyUnderBoundary(
  overrides: Partial<ComponentProps<typeof InvitationTerms>> = {},
): void {
  app.render(
    createElement(
      CaughtRenderError,
      null,
      createElement(InvitationTerms, {
        linkageTerms: COUNT_ONLY_PROBE_TERMS,
        ...overrides,
      }),
    ),
  );
}

/** The caught message, absent while the terms render. */
function refusal() {
  return page.getByTestId(REFUSAL_TESTID);
}

// A named tier of the always-visible core (role=group + aria-labelledby). Asserting
// a sentence against its tier rather than against the whole container is what makes
// the assertion a placement pin: the collapsed "Other details" and "Matching
// strategies" disclosures sit outside every tier, so a tier's text is text the
// acceptor reads without expanding anything.
function tier(name: string) {
  return page.getByRole("group", { name });
}

describe("InvitationTerms: the count-only tier a psi-c invitation renders", () => {
  test("states what the run reveals, what it still discloses, and what it does not bound -- all with the headline", async () => {
    renderCountOnly();
    await expect
      .element(tier("What the exchange produces"))
      .toBeInTheDocument();
    const produces = tier("What the exchange produces").element().textContent;
    expect(produces).toContain(COUNT_ONLY_DISCLOSURE_STATEMENT);
    expect(produces).toContain(CONSENT_FACTS.countOnlyResult.note);
    expect(produces).toContain(CONSENT_FACTS.countOnlyRoundDisclosures.note);
    // The bound belongs beside the guarantee it qualifies, by the placement rule
    // the screen applies to a disclosure guarantee: a reader who takes "only a
    // number" for the safe option must not be able to reach that reading without
    // meeting this.
    expect(produces).toContain(CONSENT_FACTS.countOnlyInputChoice.note);
    // And the psi consequence is gone: a count-only run reveals no identifier.
    expect(app.container.textContent).not.toContain(
      "shared identifiers of records you have in common are revealed",
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

  test("tells no operator that a partner receiving no count learns its own records' membership", async () => {
    // The honest-helper membership fact is true of a one-sided `psi` exchange and
    // false here: by the role rule the entitled party IS the receiver, so the
    // partner receiving no count is the SENDER, which computes nothing from the
    // round and is sent no count-report frame (docs/spec/PROTOCOL.md, PSI-C).
    renderCountOnly({
      output: { expectsOutput: false, shareWithPartner: true },
    });
    await expect
      .element(tier("What the exchange produces"))
      .toBeInTheDocument();
    const produces = tier("What the exchange produces").element().textContent;
    expect(app.container.textContent).not.toContain(
      CONSENT_FACTS.partnerLearnsOwnMembership.note,
    );
    // Not the whole branch going missing: the cooperative caveat the membership
    // sentence renders beside is still stated.
    expect(produces).toContain(CONSENT_FACTS.partnerReceivesNoResult.note);
    // And what a count-only round DOES disclose is stated in its place, from the
    // tier rather than from a softened version of the claim.
    expect(produces).toContain(CONSENT_FACTS.countOnlyResult.note);
    expect(produces).toContain(CONSENT_FACTS.countOnlyRoundDisclosures.note);
  });

  test("refuses a viewer's non-empty outbound set rather than state no columns are sent over it", async () => {
    // The slot states a precondition of the algorithm (psi-c refuses payload in
    // either direction) rather than reading a literal set. A viewer's set containing
    // a column means that precondition failed to hold, and "no data columns in
    // either direction" rendered over it would falsely reassure the operator that no
    // disclosure occurs. Driven on both viewers, so the check is measured firing,
    // not assumed.
    //
    // React logs a caught render error to console.error; silence it so an expected
    // throw does not spam the run (it is caught here, never window-unhandled).
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      renderCountOnlyUnderBoundary({ outboundColumns: ["risk_score"] });
      await expect.element(refusal()).toBeInTheDocument();
      expect(refusal().element().textContent).toContain(
        "sends no data column in either direction",
      );

      // The inviter's declared send occupies the same slot under "proposing", so the
      // check follows the viewer rather than the one prop the acceptor passes.
      app.unmount();
      renderCountOnlyUnderBoundary({
        perspective: "proposing",
        linkageTerms: {
          ...COUNT_ONLY_PROBE_TERMS,
          payload: { send: [{ name: "risk_score" }], receive: [] },
        },
      });
      await expect.element(refusal()).toBeInTheDocument();
      expect(refusal().element().textContent).toContain(
        "sends no data column in either direction",
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  test("refuses terms that declare a payload column rather than state the tier's guarantee beside them", async () => {
    // The invitation is partner-controlled, and a psi-c document declaring a send or
    // a receive is one the spec refuses. Rendered, it would put "A count-only
    // exchange sends no data columns in either direction" directly beside "You
    // will receive 1 data column from your partner" / "Your partner requests 1 data
    // column from you" -- a guarantee stated over the declaration that contradicts
    // it; the conforming document below is the positive control.
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      renderCountOnlyUnderBoundary({
        linkageTerms: {
          ...COUNT_ONLY_PROBE_TERMS,
          payload: { send: [{ name: "risk_score" }], receive: [] },
        },
      });
      await expect.element(refusal()).toBeInTheDocument();
      expect(refusal().element().textContent).toContain(
        "declare a payload column",
      );

      app.unmount();
      renderCountOnlyUnderBoundary({
        linkageTerms: {
          ...COUNT_ONLY_PROBE_TERMS,
          payload: { send: [], receive: [{ name: "risk_score" }] },
        },
      });
      await expect.element(refusal()).toBeInTheDocument();
      expect(refusal().element().textContent).toContain(
        "declare a payload column",
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  test("states the slot where the set the algorithm requires is empty", async () => {
    // The other half of the check above: with the empty set psi-c requires, the same
    // mount renders the block, so the refusals are the column's doing rather than
    // the mount's.
    renderCountOnlyUnderBoundary({ outboundColumns: [] });
    await expect.element(tier("What you disclose")).toBeInTheDocument();
    expect(tier("What you disclose").element().textContent).toContain(
      CONSENT_FACTS.countOnlyNoPayload.note,
    );
    expect(refusal().elements()).toHaveLength(0);
  });
});
