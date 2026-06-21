/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

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
    outcome: "none" | "success" | "failure";
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
    onResult: (outputs: { resultsUrl: string }) => void;
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
    else if (lifecycle.outcome === "failure")
      options.onError({ category: "exchange", error: new Error("transport") });
    return Promise.resolve();
  },
}));

// The acceptor now arrives pre-acquired (its CSV was parsed and pre-flighted on
// the review screen) and dials only on its explicit Start, so ExchangeView renders
// no FileAcquire of its own -- there is no acquire seam to stub here. A
// partial-coverage advisory rides in as the `initialWarning` config field instead
// of being raised by a stubbed acquire phase.

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
function setOutcome(outcome: "none" | "success" | "failure") {
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

  test("acceptor arrives pre-acquired and dials nothing before Start", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    render(acceptorConfig("secret-a"));

    // It shows the pre-start status and a Start button, holds no file input of its
    // own (the file was chosen on the review screen), and -- crucially -- has NOT
    // dialed: no run begins until the user presses Start.
    await expect.element(page.getByText("Before start")).toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Start" }))
      .toBeInTheDocument();
    expect(container.querySelector('input[type="file"]')).toBeNull();
    expect(lifecycle.calls).toHaveLength(0);
  });

  test("acceptor dials once as the initiator when Start is pressed", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    render(acceptorConfig("secret-a"));

    await userEvent.click(page.getByRole("button", { name: "Start" }));
    expect(lifecycle.calls).toHaveLength(1);
    expect(lifecycle.calls[0].exchangeRole).toBe("initiator");
    expect(lifecycle.calls[0].sharedSecret).toBe("secret-a");

    // The Start button hides once the run is underway, so it cannot start a
    // second racing run on the same mount (a fresh run comes from a fresh mount).
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

    // The run succeeds: the advisory must stay, explaining why the match count
    // may be lower, and no failure alert appears.
    await userEvent.click(page.getByRole("button", { name: "Start" }));
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
    await expect
      .element(page.getByText("Partial CSV coverage"))
      .toBeInTheDocument();

    // The run fails: the advisory is cleared so it cannot read as the cause
    // beside the failure alert.
    await userEvent.click(page.getByRole("button", { name: "Start" }));
    await expect.element(page.getByText("Exchange failed")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("Partial CSV coverage");
  });
});

describe("ExchangeView focus throughline", () => {
  test("moves focus to the results heading on done", async () => {
    setOutcome("success");
    render(acceptorConfig("secret-a"));

    // On done, focus lands on the Status ("results") heading so the outcome is
    // announced -- not on the mid-protocol stage label, which the live region
    // handles without stealing focus.
    await userEvent.click(page.getByRole("button", { name: "Start" }));
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

    await userEvent.click(page.getByRole("button", { name: "Start" }));
    await expect.element(page.getByText("Exchange failed")).toBeInTheDocument();
    await vi.waitFor(() => {
      // The focused element is the alert itself, carrying its title text -- not
      // <body> (whose textContent would also contain the title, so the not-body
      // check is what makes this assertion non-vacuous).
      expect(document.activeElement).not.toBe(document.body);
      expect(document.activeElement?.textContent).toContain("Exchange failed");
    });
  });

  test("moves focus to the share-block heading on mount for the inviter", async () => {
    // The inviter leads with the share block, so its entry focus lands on that
    // heading -- taking a keyboard/screen-reader user who pressed Generate to the
    // new screen rather than leaving focus on the unmounted compose button.
    setOutcome("none");
    render(inviterConfig("secret-a"));

    await vi.waitFor(() => {
      const active = document.activeElement;
      expect(active?.tagName).toBe("H3");
      expect(active?.textContent).toBe("Share this invitation");
    });
  });

  test("recovers focus onto 'Partner connected' when the share block collapses", async () => {
    setOutcome("none");
    render(inviterConfig("secret-a"));

    // The inviter auto-starts; its expanded share block holds the entry focus.
    await vi.waitFor(() => {
      expect(document.activeElement?.textContent).toBe("Share this invitation");
      expect(lifecycle.calls).toHaveLength(1);
    });

    // Simulate the partner connecting: drive the captured onStage to a protocol
    // stage, collapsing the share block and unmounting the focused heading. The
    // resulting state update flushes asynchronously; the waitFor below polls for
    // it (mirroring how the stub fires onResult/onError directly).
    lifecycle.calls[0].onStage("confirming protocol");

    // Focus is recovered onto the "Partner connected" indicator rather than left
    // to fall to <body>. The indicator's icon is aria-hidden with no text, so its
    // textContent is exactly "Partner connected" -- an exact match (not toContain),
    // so a focus left on <body> (whose textContent also includes that string)
    // would fail rather than pass vacuously.
    await vi.waitFor(() => {
      expect(document.activeElement?.textContent).toBe("Partner connected");
    });
  });

  test("does not move focus on peer-connect when focus is already elsewhere", async () => {
    setOutcome("none");
    render(inviterConfig("secret-a"));
    await vi.waitFor(() => expect(lifecycle.calls).toHaveLength(1));

    // The user navigates to the terms heading (outside the share block, and it
    // stays mounted through the collapse), so focus is NOT orphaned by the
    // collapse.
    const terms = page.getByRole("heading", {
      name: "Terms you are proposing",
    });
    await expect.element(terms).toBeInTheDocument();
    (terms.element() as HTMLElement).focus();
    expect(document.activeElement?.textContent).toBe("Terms you are proposing");

    // Partner connects and the share block collapses; since focus was not on
    // <body>, the recovery must leave it where the user put it.
    lifecycle.calls[0].onStage("confirming protocol");
    await expect
      .element(page.getByText("Partner connected"))
      .toBeInTheDocument();
    expect(document.activeElement?.textContent).toBe("Terms you are proposing");
  });
});
