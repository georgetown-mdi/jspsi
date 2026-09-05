/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";

// Load Mantine's stylesheet so the spine renders with its real geometry: without
// it the Stepper's completed-step icon has no size bound and blankets the top
// bar, intercepting the clicks this walk makes.
import "@mantine/core/styles.css";

import { encodeInvitation, generateSharedSecret } from "@psilink/core";

import { AcceptorBench } from "@bench/AcceptorBench";
import { InviterBench } from "@bench/InviterBench";

import { createAppMount } from "./renderApp";

import type { InvitationToken, LinkageTerms } from "@psilink/core";

// A console seat hosts the live WebRTC exchange itself, so unloading mid-run
// with nothing asking first would end the session for both parties. The
// unsaved-work guard disarms when the invitation is minted or the launch
// commits, which is when the run begins; this suite covers the guard from that
// moment until the run settles, in Chromium, where `beforeunload` is the
// platform contract under test.

vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);

// The rendezvous listen/dial runs only inside the run lifecycle's acquire
// closure, which the lifecycle stub below never invokes.
vi.mock("@psi/rendezvous", async () =>
  (await import("./moduleMocks")).rendezvousMock(),
);

// Stub the run lifecycle so a run never dials: each invocation's options are
// captured so a test can end the run through the same onResult/onError call
// sites the real lifecycle fires, with the seat still mounted -- which is what
// makes the disarm assertion meaningful rather than a by-product of unmounting
// (the bench.test.ts pattern).
interface CapturedLifecycle {
  onResult: (outputs: {
    kind: "counted";
    intersectionCount: number;
    countReportedByPartner: boolean;
  }) => void;
  onError: (failure: { category: string; error: unknown }) => void;
}
const lifecycleHarness = vi.hoisted(() => ({
  calls: [] as Array<unknown>,
}));
vi.mock("@psi/exchangeLifecycle", () => ({
  runExchangeLifecycle: (options: unknown) => {
    lifecycleHarness.calls.push(options);
    return Promise.resolve();
  },
}));

function lifecycleCall(index: number): CapturedLifecycle {
  return lifecycleHarness.calls[index] as CapturedLifecycle;
}

const acceptorTerms: LinkageTerms = {
  version: "1.0.0",
  identity: "County Health Department",
  date: "2026-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [
    { name: "firstName", type: "first_name" },
    { name: "lastName", type: "last_name" },
  ],
  linkageKeys: [
    { name: "first", elements: [{ field: "firstName" }] },
    { name: "last", elements: [{ field: "lastName" }] },
  ],
};

/** A live WebRTC invitation for the accepting seat to walk. */
async function encodeAcceptToken(): Promise<string> {
  const token: InvitationToken = {
    version: "1",
    linkageTerms: acceptorTerms,
    sharedSecret: generateSharedSecret(),
    expires: new Date(Date.now() + 3600 * 1000).toISOString(),
    connectionEndpoint: {
      channel: "webrtc",
      host: "127.0.0.1",
      port: 3000,
      path: "/api/",
    },
  };
  return encodeInvitation(token);
}

/** Whether the page would ask the operator to confirm leaving: fire the event a
 * tab close, a reload, or a typed URL fires, and read whether anything cancelled
 * it. */
function unloadWouldBeConfirmed(): boolean {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

const app = createAppMount();

afterEach(() => {
  app.unmount();
  lifecycleHarness.calls.length = 0;
  window.location.hash = "";
});

describe("leaving the page during a live console exchange", () => {
  test("the inviting seat confirms while the run is live, and not once it completes", async () => {
    app.render(createElement(InviterBench));
    await expect.element(page.getByLabelText("Your name")).toBeInTheDocument();
    // Nothing is loaded and nothing is running, so nothing is asked.
    expect(unloadWouldBeConfirmed()).toBe(false);

    await userEvent.fill(page.getByLabelText("Your name"), "Dana Okafor");
    const fileInput = document.querySelector('input[type="file"]');
    await userEvent.upload(
      page.elementLocator(fileInput as HTMLElement),
      new File(
        [
          "client_id,first_name,last_name,dob,program_code\n" +
            "1,Ann,Lee,01/02/1990,A\n2,Bo,Ray,03/04/1985,B\n",
        ],
        "clients.csv",
        { type: "text/csv" },
      ),
    );
    await expect.element(page.getByText("clients.csv")).toBeInTheDocument();
    await page
      .getByRole("button", { name: "Continue to matching & sharing" })
      .click();
    await page
      .getByRole("button", { name: "Continue to review & create" })
      .click();
    await page.getByRole("button", { name: "Create the invitation" }).click();

    // The mint is where the unsaved-work guard disarms and this browser starts
    // listening for the partner, so from here a confirmed unload is the live
    // run's own guard.
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Your invitation is ready");
    await vi.waitFor(() => expect(lifecycleHarness.calls).toHaveLength(1));
    expect(unloadWouldBeConfirmed()).toBe(true);

    lifecycleCall(0).onResult({
      kind: "counted",
      intersectionCount: 1847,
      countReportedByPartner: true,
    });

    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Exchange complete");
    expect(unloadWouldBeConfirmed()).toBe(false);
  });

  test("the accepting seat confirms while the run is live, and not once it fails", async () => {
    window.location.hash = await encodeAcceptToken();
    app.render(createElement(AcceptorBench));
    await expect
      .element(page.getByText("Invitation from County Health Department"))
      .toBeInTheDocument();
    expect(unloadWouldBeConfirmed()).toBe(false);

    await userEvent.click(
      page.getByRole("button", { name: "Continue: consent & your file" }),
    );
    await userEvent.click(page.getByRole("checkbox"));
    await userEvent.fill(page.getByLabelText("Your name"), "Sam Alvarez");
    const fileInput = document.querySelector('input[type="file"]');
    await userEvent.upload(
      page.elementLocator(fileInput as HTMLElement),
      new File(["first_name,last_name\nAlice,Smith\n"], "cohort_intake.csv", {
        type: "text/csv",
      }),
    );
    await expect
      .element(page.getByText("cohort_intake.csv"))
      .toBeInTheDocument();
    await userEvent.click(
      page.getByRole("button", { name: "Accept and continue" }),
    );
    await expect
      .element(page.getByRole("heading", { name: "Confirm your columns" }))
      .toBeInTheDocument();
    await userEvent.click(
      page.getByRole("button", { name: "Start the exchange" }),
    );

    // The launch is where the unsaved-work guard disarms and this seat starts
    // dialing, so from here a confirmed unload is the live run's own guard.
    await vi.waitFor(() => expect(lifecycleHarness.calls).toHaveLength(1));
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Exchange in progress");
    expect(unloadWouldBeConfirmed()).toBe(true);

    // A terminal failure ends the run without unmounting the seat, so the guard
    // has to come down on its own.
    lifecycleCall(0).onError({
      category: "security",
      error: new Error("kex failed"),
    });

    await expect
      .element(page.getByText("Could not verify your partner"))
      .toBeInTheDocument();
    expect(unloadWouldBeConfirmed()).toBe(false);
  });
});
