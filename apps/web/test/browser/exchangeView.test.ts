/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page } from "vitest/browser";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

import { MantineProvider } from "@mantine/core";

import { ExchangeView } from "@components/ExchangeView";

import type { Root } from "react-dom/client";

import type { ExchangeConfig } from "@components/ExchangeView";
import type { LinkageTerms } from "@psilink/core";

// Stub the rendezvous module: importing it runs a top-level config load that
// reads `process` (absent in the browser runner). Its dial/listen functions only
// run inside the run lifecycle's acquire closure, which the lifecycle stub below
// never invokes, so no-ops suffice and the import no longer crashes.
vi.mock("@psi/rendezvous", () => ({
  dialAsAcceptor: vi.fn(),
  listenAsInviter: vi.fn(),
}));

// Stub the run lifecycle so no exchange ever dials: record each invocation's
// options (role, secret, signal) and resolve. This isolates ExchangeView's
// Start->run wiring -- which role it runs as, that it starts once per mount, and
// that a remount resets the controller -- from the real peer/WASM machinery,
// which the lifecycle and live-exchange suites cover. `outcome` lets a test drive
// ExchangeView's own onResult/onError handling (e.g. the warning-on-success vs
// cleared-on-failure branch) without a real exchange: the stub fires the matching
// callback synchronously, inside the triggering click's act() scope.
const lifecycle = vi.hoisted(
  (): {
    outcome: "none" | "success" | "failure" | "withheld";
    calls: Array<{
      exchangeRole: "initiator" | "responder";
      sharedSecret: string;
      signal: AbortSignal;
      // Captured so a test can drive a stage transition (e.g. peer-connect)
      // without a real exchange.
      onStage: (stageId: string) => void;
    }>;
  } => ({ outcome: "none", calls: [] }),
);
vi.mock("@psi/exchangeLifecycle", () => ({
  runExchangeLifecycle: (options: {
    exchangeRole: "initiator" | "responder";
    sharedSecret: string;
    signal: AbortSignal;
    onStage: (stageId: string) => void;
    generateOutput: (
      result: unknown,
      prepared: unknown,
    ) => { resultsUrl?: string; resultWithheld?: boolean; record?: unknown };
    onResult: (outputs: {
      resultsUrl?: string;
      resultWithheld?: boolean;
      record?: unknown;
    }) => void;
    onError: (failure: { category: string; error: unknown }) => void;
  }) => {
    lifecycle.calls.push({
      exchangeRole: options.exchangeRole,
      sharedSecret: options.sharedSecret,
      signal: options.signal,
      onStage: options.onStage,
    });
    if (lifecycle.outcome === "success")
      options.onResult({ resultsUrl: "blob:results" });
    else if (lifecycle.outcome === "withheld")
      // Drive ExchangeView's REAL generateOutput with a withheld result
      // (associationTable undefined), so the web result path's withholding is
      // exercised end-to-end: generateOutput must produce no results URL and flag
      // the result as withheld, which Status then presents as "contributed, no
      // result". The withheld branch reads only result.associationTable/audit, so a
      // minimal result and an empty prepared suffice.
      options.onResult(
        options.generateOutput(
          { associationTable: undefined, audit: undefined },
          {},
        ),
      );
    else if (lifecycle.outcome === "failure")
      options.onError({ category: "exchange", error: new Error("transport") });
    return Promise.resolve();
  },
}));

// The acceptor arrives pre-acquired (its CSV was parsed and pre-flighted on the
// review screen) and auto-dials on mount, so ExchangeView renders no FileAcquire of
// its own -- there is no acquire seam to stub here. A partial-coverage advisory
// rides in as the `initialWarning` config field instead of being raised by a
// stubbed acquire phase.

const acceptorTerms: LinkageTerms = {
  version: "1.0.0",
  identity: "County Health Department",
  date: "2026-01-01",
  algorithm: "psi",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [{ name: "firstName", type: "first_name" }],
  linkageKeys: [{ name: "first", elements: [{ field: "firstName" }] }],
};

// The inviter's terms come from its own file at compose time (identity is its own
// name); the acceptor adopts the inviter's terms. The values differ only in
// identity here -- enough to tell the two configs apart.
const inviterTerms: LinkageTerms = { ...acceptorTerms, identity: "Inviter" };

function inviterConfig(sharedSecret: string): ExchangeConfig {
  return {
    role: "inviter",
    partyName: "Inviter",
    sharedSecret,
    linkageTerms: inviterTerms,
    // The exchange screen owns the share block now, so the inviter config carries
    // the shareable artifacts.
    share: {
      deepLink: `https://example.org/accept#${sharedSecret}`,
      encoded: sharedSecret,
    },
    // Pre-acquired at compose time: the inviter does not prompt for a file again.
    acquired: { rawRows: [], columns: [] },
  };
}

function acceptorConfig(
  sharedSecret: string,
  initialWarning?: { title: string; message: string },
): ExchangeConfig {
  return {
    role: "acceptor",
    partyName: "Acceptor",
    sharedSecret,
    endpoint: {
      channel: "webrtc",
      host: "127.0.0.1",
      port: 3000,
      path: "/api/",
    },
    linkageTerms: acceptorTerms,
    // Pre-acquired on the review screen and prepared in the metadata editor: the
    // acceptor renders no file prompt and dials only on Start. The empty bundle
    // carries empty metadata/standardization to match.
    acquired: { rawRows: [], columns: [] },
    metadata: [],
    standardization: [],
    ...(initialWarning ? { initialWarning } : {}),
  };
}

let container: HTMLElement | undefined;
let root: Root | undefined;
// Set by a failure-path test to swallow the one expected dev-gated
// console.error (ExchangeView's whenDiagnostic sink, on in this env) so the run
// output stays quiet; restored in afterEach.
let consoleErrorSpy: ReturnType<typeof vi.spyOn> | undefined;

// Render ExchangeView keyed by its secret, exactly as the invite/accept screens
// do, so a new secret remounts the subtree.
function render(config: ExchangeConfig) {
  root!.render(
    createElement(
      MantineProvider,
      null,
      createElement(ExchangeView, { key: config.sharedSecret, ...config }),
    ),
  );
}

// Set the run outcome a test wants the lifecycle stub to deliver, then mount.
function setOutcome(outcome: "none" | "success" | "failure" | "withheld") {
  lifecycle.outcome = outcome;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
}

afterEach(() => {
  root?.unmount();
  container?.remove();
  root = undefined;
  container = undefined;
  lifecycle.calls = [];
  lifecycle.outcome = "none";
  consoleErrorSpy?.mockRestore();
  consoleErrorSpy = undefined;
});

describe("ExchangeView Start->run wiring", () => {
  test("inviter auto-starts from its pre-acquired bundle, with no file prompt", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    render(inviterConfig("secret-a"));

    // The inviter chose its file at compose time, so the run begins on mount with
    // no Start press and no file input of its own -- the bundle is pre-supplied.
    await vi.waitFor(() => expect(lifecycle.calls).toHaveLength(1));
    expect(lifecycle.calls[0].exchangeRole).toBe("responder");
    expect(lifecycle.calls[0].sharedSecret).toBe("secret-a");
    expect(container.querySelector('input[type="file"]')).toBeNull();
  });

  test("acceptor auto-dials as the initiator on mount from its pre-acquired bundle", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    render(acceptorConfig("secret-a"));

    // The acceptor reaches this screen pre-acquired (its file was chosen and
    // pre-flighted on the review screen) and already consented and prepared, so the
    // run begins on mount with no Start press: it dials as the PSI initiator and
    // holds no file input of its own. There is no Start gate any more.
    await vi.waitFor(() => expect(lifecycle.calls).toHaveLength(1));
    expect(lifecycle.calls[0].exchangeRole).toBe("initiator");
    expect(lifecycle.calls[0].sharedSecret).toBe("secret-a");
    expect(container.querySelector('input[type="file"]')).toBeNull();
    expect(page.getByRole("button", { name: "Start" }).query()).toBeNull();
  });

  test("a new secret remounts, aborting the old run and arming a fresh one", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    render(inviterConfig("secret-a"));

    // The inviter auto-starts on mount.
    await vi.waitFor(() => expect(lifecycle.calls).toHaveLength(1));
    const firstSignal = lifecycle.calls[0].signal;
    expect(firstSignal.aborted).toBe(false);

    // Regenerate: a new secret keys a fresh ExchangeView. The old subtree
    // unmounts, aborting its in-flight controller, and the new mount auto-starts a
    // fresh run. The unmount cleanup is a passive effect, so wait for the abort.
    render(inviterConfig("secret-b"));
    await vi.waitFor(() => expect(firstSignal.aborted).toBe(true));

    await vi.waitFor(() => expect(lifecycle.calls).toHaveLength(2));
    expect(lifecycle.calls[1].sharedSecret).toBe("secret-b");
    expect(lifecycle.calls[1].signal).not.toBe(firstSignal);
  });

  const warning = {
    title: "Partial CSV coverage",
    message: "some keys inactive",
  };

  test("keeps a partial-coverage warning when the run succeeds", async () => {
    setOutcome("success");
    // The review screen's pre-flight raised the advisory; it rides in as
    // initialWarning and shows before the run even starts.
    render(acceptorConfig("secret-a", warning));
    await expect
      .element(page.getByText("Partial CSV coverage"))
      .toBeInTheDocument();

    // The run succeeds (it auto-started on mount): the advisory must stay,
    // explaining why the match count may be lower, and no failure alert appears.
    await expect.element(page.getByText("Done")).toBeInTheDocument();
    expect(document.body.textContent).toContain("Partial CSV coverage");
    expect(document.body.textContent).not.toContain("Exchange failed");
  });

  test("clears a partial-coverage warning when the run fails", async () => {
    // The failure path dev-gates the raw error to console.error; swallow that
    // one expected line so the assertion output stays clean.
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    setOutcome("failure");
    render(acceptorConfig("secret-a", warning));

    // The run auto-starts on mount and fails (the lifecycle stub fires onError
    // synchronously), so the failure alert shows and the advisory is cleared --
    // it cannot read as the cause beside the failure. The warning's brief on-mount
    // presence is not asserted: the synchronous failure clears it in the same tick.
    await expect.element(page.getByText("Exchange failed")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("Partial CSV coverage");
  });

  test("a non-receiving party is shown it contributed but gets no result download", async () => {
    // The web half of the one-sided result-withholding gate: the exchange returns
    // no association table to a party not entitled to output, so generateOutput
    // produces no results file. The run still completes successfully -- it must read
    // as "you contributed, no result", not as a failure or an empty download.
    setOutcome("withheld");
    render(acceptorConfig("secret-a"));

    await expect.element(page.getByText("Done")).toBeInTheDocument();

    // The completion message states the contribution and the absence of a result...
    expect(document.body.textContent).toContain(
      "Your records contributed to the match",
    );
    // ...no results download is offered (the table was withheld)...
    expect(container!.querySelector('a[download="results.csv"]')).toBeNull();
    // ...and it is not presented as a failure.
    expect(document.body.textContent).not.toContain("Exchange failed");
  });
});

describe("ExchangeView focus throughline", () => {
  test("moves focus to the results heading on done", async () => {
    setOutcome("success");
    render(acceptorConfig("secret-a"));

    // On done, focus lands on the Status ("results") heading so the outcome is
    // announced -- not on the mid-protocol stage label, which the live region
    // handles without stealing focus. The run auto-starts on mount.
    await expect.element(page.getByText("Done")).toBeInTheDocument();
    await vi.waitFor(() => {
      const active = document.activeElement;
      expect(active?.tagName).toBe("H2");
      expect(active?.textContent).toBe("Status");
    });
  });

  test("a blocking error alert takes focus", async () => {
    // Swallow the one expected dev-gated console.error from the failure path.
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    setOutcome("failure");
    render(acceptorConfig("secret-a"));

    await expect.element(page.getByText("Exchange failed")).toBeInTheDocument();
    await vi.waitFor(() => {
      // The focused element is the alert itself, carrying its title text -- not
      // <body> (whose textContent would also contain the title, so the not-body
      // check is what makes this assertion non-vacuous).
      expect(document.activeElement).not.toBe(document.body);
      expect(document.activeElement?.textContent).toContain("Exchange failed");
    });
  });

  test("moves focus to the exchange-summary heading on mount for the inviter", async () => {
    // Both roles now lead with the exchange-summary heading (the left column); the
    // inviter's share block moved below the columns. Entry focus lands on that
    // heading -- taking a keyboard/screen-reader user who pressed Generate to the
    // new screen rather than leaving focus on the unmounted compose button. The
    // inviter's summary heading is "Exchange proposal" (the proposing perspective).
    setOutcome("none");
    render(inviterConfig("secret-a"));

    await vi.waitFor(() => {
      const active = document.activeElement;
      expect(active?.tagName).toBe("H3");
      expect(active?.textContent).toBe("Exchange proposal");
    });
  });

  test("recovers focus onto the Status heading when the share block unmounts on connect", async () => {
    setOutcome("none");
    render(inviterConfig("secret-a"));

    // The inviter auto-starts; entry focus lands on the summary heading. Move it
    // into the share block (onto the copy-link button the inviter would use while
    // it waits), so the connect below orphans it.
    await vi.waitFor(() => {
      expect(document.activeElement?.textContent).toBe("Exchange proposal");
      expect(lifecycle.calls).toHaveLength(1);
    });
    const copyLink = page.getByRole("button", {
      name: "Copy invitation link",
    });
    await expect.element(copyLink).toBeInTheDocument();
    (copyLink.element() as HTMLElement).focus();
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Copy invitation link",
    );

    // Simulate the partner connecting: drive the captured onStage to a protocol
    // stage. The share block unmounts entirely (nothing left to share), dropping
    // the focused heading; the browser moves focus to <body>, and the peer-connect
    // effect recovers it onto the Status heading rather than leaving it stranded.
    // The state update flushes asynchronously; the waitFor below polls for it.
    lifecycle.calls[0].onStage("confirming protocol");

    await vi.waitFor(() => {
      expect(document.activeElement?.textContent).toBe("Status");
    });
  });

  test("does not move focus on peer-connect when focus is already on a live element", async () => {
    setOutcome("none");
    render(inviterConfig("secret-a"));
    await vi.waitFor(() => expect(lifecycle.calls).toHaveLength(1));

    // Focus rests on the summary heading (the left column, which stays mounted
    // through the connect), so it is NOT orphaned when the share block unmounts.
    const terms = page.getByRole("heading", {
      name: "Exchange proposal",
    });
    await expect.element(terms).toBeInTheDocument();
    (terms.element() as HTMLElement).focus();
    expect(document.activeElement?.textContent).toBe("Exchange proposal");

    // Partner connects and the share block unmounts; since focus was not on
    // <body>, the recovery must leave it where the user put it.
    lifecycle.calls[0].onStage("confirming protocol");
    await vi.waitFor(() =>
      expect(page.getByText("Share this invitation").query()).toBeNull(),
    );
    expect(document.activeElement?.textContent).toBe("Exchange proposal");
  });

  test("the acceptor exchange screen surfaces its own outbound disclosure", async () => {
    // The exchange screen now shows the acceptor's send set beside the agreed terms
    // (mirroring the inviter, whose declared send shows inside its proposing terms).
    // This config prepared empty metadata, so the acceptor discloses nothing and the
    // send block states that explicitly -- the empty-set confirmation the chips fall
    // back to.
    setOutcome("none");
    render(acceptorConfig("secret-a"));

    await expect
      .element(page.getByText(/No columns are sent to your partner/))
      .toBeInTheDocument();
  });
});
