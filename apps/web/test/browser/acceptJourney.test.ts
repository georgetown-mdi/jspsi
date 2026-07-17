/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

// Load Mantine's stylesheet so components render with their real geometry:
// without it the Stepper's completed-step icon has no size bound and blankets
// the top bar, intercepting unrelated clicks.
import "@mantine/core/styles.css";

import {
  CONFIRMING_PROTOCOL_STAGE_ID,
  encodeInvitation,
  generateSharedSecret,
} from "@psilink/core";

import { WAITING_STAGE_ID, stagesFor } from "@bench/exchangeRun";
import { AcceptorBench } from "@bench/AcceptorBench";

import { renderApp } from "./renderApp";

import type { ReactNode } from "react";
import type { Root } from "react-dom/client";

import type {
  InvitationToken,
  LinkageTerms,
  PreparedExchange,
} from "@psilink/core";

// One composed journey: this file mounts the acceptor route tree and drives it
// end to end through the UI a user touches (file select, consent action,
// Start), asserting the real inter-screen prop/state handoff between the acquire
// phase, the consent gate, the columns step, and the run/completion screen. The
// per-screen behaviors and the run screen's individual states live in
// benchAccept.test.ts; the PSI mechanics live in invitedPSI.test.ts. What is
// only tested here is that the composed handoff wires those screens together so
// a real UI journey reaches Done and a downloadable result.

// Entry point: AcceptorBench, mounted directly. That is exactly the component
// the /accept route renders (routes/accept.tsx), so this is the acceptor route
// tree, and it matches the suite's mount idiom (direct createRoot, the router
// seam mocked). Driving from a higher composition point would only add the
// router shell this suite already stubs away, not more real handoff.

// Stub the router seam. AcceptorBench's recovery links and lobby use it; the
// journey never navigates, so a plain anchor and a no-op navigate suffice.
// (vitest hoists vi.mock above the imports.)
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    className,
    children,
  }: {
    to?: string;
    className?: string;
    children?: ReactNode;
  }) =>
    createElement(
      "a",
      { href: typeof to === "string" ? to : "#", className },
      children,
    ),
  useNavigate: () => () => undefined,
}));

// Stub the rendezvous module: importing it runs a top-level config load that
// reads `process` (absent in the browser runner). Its dial function only runs
// inside the real lifecycle's acquire closure, which the lifecycle stub below
// replaces wholesale, so it is never invoked.
vi.mock("@psi/rendezvous", () => ({
  dialAsAcceptor: vi.fn(),
  listenAsInviter: vi.fn(),
}));

// stagesFor reads only the linkage terms off the prepared exchange, so a
// terms-only stand-in drives the real acceptor stage-tree derivation for the
// timeline the stub emits.
function preparedWith(keyCount: number): PreparedExchange {
  return {
    linkageTerms: {
      linkageStrategy: "cascade",
      linkageKeys: Array.from({ length: keyCount }, (_, i) => ({
        name: `key ${i + 1}`,
      })),
    },
  } as unknown as PreparedExchange;
}

// The lifecycle stub for this journey: unlike benchAccept.test.ts, which records
// the call and lets the test hand-fire the seams after the fact, this stub
// SETTLES THE RUN itself. On invocation it captures the owner's AbortController
// (the run's `signal`), emits the real stage tree, walks the pre-run stages,
// then delivers a result with a downloadable results blob and resolves -- the
// same seam order the real lifecycle fires. The test then only touches UI
// affordances and observes the journey reach Done, so it proves the Start ->
// run -> completion -> download wiring without standing in for the lifecycle.
const journeyResultsUrl = URL.createObjectURL(new Blob(["a,b\nx,y\n"]));
const settledRun = vi.hoisted(() => ({
  capturedSignal: undefined as AbortSignal | undefined,
}));
vi.mock("@psi/exchangeLifecycle", () => ({
  runExchangeLifecycle: (options: {
    signal: AbortSignal;
    onStages: (stages: Array<unknown>) => void;
    onStage: (stageId: string) => void;
    onResult: (outputs: {
      resultsUrl: string;
      matchedRecordCount: number;
    }) => void;
  }) => {
    settledRun.capturedSignal = options.signal;
    return Promise.resolve().then(() => {
      if (options.signal.aborted) return;
      options.onStages(stagesFor(preparedWith(2), "acceptor"));
      options.onStage(WAITING_STAGE_ID);
      options.onStage(CONFIRMING_PROTOCOL_STAGE_ID);
      options.onResult({
        resultsUrl: journeyResultsUrl,
        matchedRecordCount: 1847,
      });
    });
  },
}));

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

async function encodeRunToken(): Promise<string> {
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

function csvFile(content: string): File {
  return new File([content], "cohort_intake.csv", { type: "text/csv" });
}

let container: HTMLElement | undefined;
let root: Root | undefined;

function mount(content: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(renderApp(content));
}

afterEach(() => {
  root?.unmount();
  container?.remove();
  root = undefined;
  container = undefined;
  settledRun.capturedSignal = undefined;
  window.location.hash = "";
});

test("acceptor journey reaches Done with a downloadable result driven only through the UI", async () => {
  window.location.hash = await encodeRunToken();
  mount(createElement(AcceptorBench));

  // Review terms -> Continue. The decode-to-terms handoff is the acquire
  // phase's own state reaching the first rendered screen.
  await expect
    .element(page.getByText("Invitation from County Health Department"))
    .toBeInTheDocument();
  await userEvent.click(
    page.getByRole("button", { name: "Continue: consent & your file" }),
  );

  // The consent gate: the file select, the consent checkbox, and a name are the
  // affordances a user actually uses. Selecting the file does not parse it --
  // the parse stays behind the consent action, so the file must be chosen and
  // then Accept pressed for the columns step to receive it.
  await expect
    .element(page.getByRole("heading", { level: 1 }))
    .toHaveTextContent("Consent & your file");
  const fileInput = document.querySelector('input[type="file"]');
  await userEvent.upload(
    page.elementLocator(fileInput as HTMLElement),
    csvFile("first_name,last_name\nAlice,Smith\n"),
  );
  await expect.element(page.getByText("cohort_intake.csv")).toBeInTheDocument();
  await userEvent.click(page.getByRole("checkbox"));
  await userEvent.fill(page.getByLabelText("Your name"), "Sam Alvarez");
  await userEvent.click(
    page.getByRole("button", { name: "Accept and continue" }),
  );

  // The columns step receives the parsed file through the consent gate's
  // handoff: a fully-covered file is all-clear, so Start is offered.
  await expect
    .element(page.getByRole("heading", { name: "Confirm your columns" }))
    .toBeInTheDocument();
  await expect
    .element(page.getByText("All 2 keys can match"))
    .toBeInTheDocument();

  // Start launches the run. The stubbed lifecycle settles it, so the journey
  // advances Start -> run -> completion with no hand-fired seam: the run screen
  // is reached purely by the columns step handing its launch to the run hook.
  await userEvent.click(
    page.getByRole("button", { name: "Start the exchange" }),
  );

  // The composed journey reaches Done.
  await expect
    .element(page.getByRole("heading", { level: 1 }))
    .toHaveTextContent("Exchange complete");
  await expect
    .element(page.getByText(/1,847.*matched records/))
    .toBeInTheDocument();

  // A downloadable result is produced and points at the run's own results blob:
  // the completion screen received the settled outputs through the handoff, not
  // a fabricated fixture.
  const resultLink = Array.from(
    document.querySelectorAll<HTMLAnchorElement>("a[download]"),
  ).find((link) => link.textContent === "results.csv");
  expect(resultLink).toBeDefined();
  expect(resultLink?.getAttribute("href")).toBe(journeyResultsUrl);

  // The run owned a live AbortController the whole way -- the same signal the
  // real lifecycle observes for cancellation, threaded from the hook through the
  // driver to the stub.
  expect(settledRun.capturedSignal).toBeDefined();
  expect(settledRun.capturedSignal?.aborted).toBe(false);
});
