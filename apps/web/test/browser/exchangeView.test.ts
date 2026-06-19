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
    }>;
  } => ({ outcome: "none", calls: [] }),
);
vi.mock("@psi/exchangeLifecycle", () => ({
  runExchangeLifecycle: (options: {
    exchangeRole: "initiator" | "responder";
    sharedSecret: string;
    signal: AbortSignal;
    onResult: (outputs: { resultsUrl: string }) => void;
    onError: (failure: { category: string; error: unknown }) => void;
  }) => {
    lifecycle.calls.push({
      exchangeRole: options.exchangeRole,
      sharedSecret: options.sharedSecret,
      signal: options.signal,
    });
    if (lifecycle.outcome === "success")
      options.onResult({ resultsUrl: "blob:results" });
    else if (lifecycle.outcome === "failure")
      options.onError({ category: "exchange", error: new Error("transport") });
    return Promise.resolve();
  },
}));

// Stub the acquire phase: capture the props ExchangeView forwards to it and
// expose a button that hands a bundle up via onAcquired. This is the seam the
// "no file-acquire state" criterion turns on -- the file state lives here, not in
// ExchangeView, which only reacts to the handoff.
const acquire = vi.hoisted(() => ({
  lastProps: undefined as
    | { linkageTerms?: LinkageTerms; onAcquired: (b: unknown) => void }
    | undefined,
}));
vi.mock("@components/FileAcquire", () => ({
  default: (props: {
    linkageTerms?: LinkageTerms;
    onWarning: (alert: { title: string; message: string } | undefined) => void;
    onAcquired: (b: unknown) => void;
  }) => {
    acquire.lastProps = props;
    // Two buttons stand in for the real acquire phase: "warn" raises the
    // partial-coverage advisory the acceptor pre-flight would, and "acquire"
    // hands up the bundle. A test clicks "warn" then "acquire" to exercise the
    // warning surviving (or being cleared) across the run it owns.
    return createElement(
      "div",
      null,
      createElement(
        "button",
        {
          "data-testid": "warn",
          onClick: () =>
            props.onWarning({
              title: "Partial CSV coverage",
              message: "some keys inactive",
            }),
        },
        "warn",
      ),
      createElement(
        "button",
        {
          "data-testid": "acquire",
          onClick: () => props.onAcquired({ rawRows: [], columns: [] }),
        },
        "acquire",
      ),
    );
  },
}));

const acceptorTerms: LinkageTerms = {
  version: "1.0.0",
  identity: "County Health Department",
  date: "2026-01-01",
  algorithm: "psi",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [{ name: "firstName", type: "firstName" }],
  linkageKeys: [{ name: "first", elements: [{ field: "firstName" }] }],
};

function inviterConfig(sharedSecret: string): ExchangeConfig {
  return { role: "inviter", partyName: "Inviter", sharedSecret };
}

function acceptorConfig(sharedSecret: string): ExchangeConfig {
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
  acquire.lastProps = undefined;
  lifecycle.calls = [];
  lifecycle.outcome = "none";
  consoleErrorSpy?.mockRestore();
  consoleErrorSpy = undefined;
});

describe("ExchangeView Start->run wiring", () => {
  test("delegates file acquisition and starts no run until a bundle arrives", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    render(inviterConfig("secret-a"));

    // It renders the acquire seam and the pre-start status, holding no file input
    // of its own.
    await expect.element(page.getByText("Before start")).toBeInTheDocument();
    expect(acquire.lastProps).toBeDefined();
    expect(typeof acquire.lastProps?.onAcquired).toBe("function");
    expect(container.querySelector('input[type="file"]')).toBeNull();
    // Crucially, ExchangeView never parses or pre-flights on its own: no run
    // begins until the acquire phase hands up a bundle.
    expect(lifecycle.calls).toHaveLength(0);
  });

  test("forwards the acceptor's adopted terms, none for the inviter", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    render(inviterConfig("secret-a"));
    // The inviter is the source of the terms, so it pre-flights nothing.
    await vi.waitFor(() => expect(acquire.lastProps).toBeDefined());
    expect(acquire.lastProps?.linkageTerms).toBeUndefined();

    render(acceptorConfig("secret-b"));
    // The acceptor forwards the adopted terms down for the pre-flight; the run
    // owner does not pre-flight itself.
    await vi.waitFor(() =>
      expect(acquire.lastProps?.linkageTerms).toBe(acceptorTerms),
    );
  });

  test("runs once per mount as the role's handshake side (one-exchange-per-mount)", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    render(inviterConfig("secret-a"));

    await userEvent.click(page.getByTestId("acquire"));
    expect(lifecycle.calls).toHaveLength(1);
    expect(lifecycle.calls[0].exchangeRole).toBe("responder");
    expect(lifecycle.calls[0].sharedSecret).toBe("secret-a");

    // A second handoff on the same mount is refused by the re-entry guard.
    await userEvent.click(page.getByTestId("acquire"));
    expect(lifecycle.calls).toHaveLength(1);
  });

  test("acceptor runs as the initiator", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    render(acceptorConfig("secret-a"));

    await userEvent.click(page.getByTestId("acquire"));
    expect(lifecycle.calls).toHaveLength(1);
    expect(lifecycle.calls[0].exchangeRole).toBe("initiator");
  });

  test("a new secret remounts, aborting the old run and arming a fresh one", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    render(inviterConfig("secret-a"));

    await userEvent.click(page.getByTestId("acquire"));
    expect(lifecycle.calls).toHaveLength(1);
    const firstSignal = lifecycle.calls[0].signal;
    expect(firstSignal.aborted).toBe(false);

    // Regenerate: a new secret keys a fresh ExchangeView. The old subtree
    // unmounts, aborting its in-flight controller, and the new mount's guard is
    // reset so the next handoff starts a fresh run. The unmount cleanup is a
    // passive effect, so wait for the abort rather than reading it synchronously.
    render(inviterConfig("secret-b"));
    await vi.waitFor(() => expect(firstSignal.aborted).toBe(true));

    await userEvent.click(page.getByTestId("acquire"));
    expect(lifecycle.calls).toHaveLength(2);
    expect(lifecycle.calls[1].sharedSecret).toBe("secret-b");
    expect(lifecycle.calls[1].signal).not.toBe(firstSignal);
  });

  test("keeps a partial-coverage warning when the run succeeds", async () => {
    setOutcome("success");
    render(acceptorConfig("secret-a"));

    // The acquire phase raised the partial-coverage advisory before handing off.
    await userEvent.click(page.getByTestId("warn"));
    await expect
      .element(page.getByText("Partial CSV coverage"))
      .toBeInTheDocument();

    // The run succeeds: the advisory must stay, explaining why the match count
    // may be lower, and no failure alert appears.
    await userEvent.click(page.getByTestId("acquire"));
    await expect.element(page.getByText("Done")).toBeInTheDocument();
    expect(document.body.textContent).toContain("Partial CSV coverage");
    expect(document.body.textContent).not.toContain("Exchange failed");
  });

  test("clears a partial-coverage warning when the run fails", async () => {
    // The failure path dev-gates the raw error to console.error; swallow that
    // one expected line so the assertion output stays clean.
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    setOutcome("failure");
    render(acceptorConfig("secret-a"));

    await userEvent.click(page.getByTestId("warn"));
    await expect
      .element(page.getByText("Partial CSV coverage"))
      .toBeInTheDocument();

    // The run fails: the advisory is cleared so it cannot read as the cause
    // beside the failure alert.
    await userEvent.click(page.getByTestId("acquire"));
    await expect.element(page.getByText("Exchange failed")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("Partial CSV coverage");
  });
});
