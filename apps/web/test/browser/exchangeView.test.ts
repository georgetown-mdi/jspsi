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
// which the lifecycle and live-exchange suites cover.
const lifecycle = vi.hoisted(() => ({
  calls: [] as Array<{
    exchangeRole: "initiator" | "responder";
    sharedSecret: string;
    signal: AbortSignal;
  }>,
}));
vi.mock("@psi/exchangeLifecycle", () => ({
  runExchangeLifecycle: (options: {
    exchangeRole: "initiator" | "responder";
    sharedSecret: string;
    signal: AbortSignal;
  }) => {
    lifecycle.calls.push({
      exchangeRole: options.exchangeRole,
      sharedSecret: options.sharedSecret,
      signal: options.signal,
    });
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
    onAcquired: (b: unknown) => void;
  }) => {
    acquire.lastProps = props;
    return createElement(
      "button",
      {
        "data-testid": "acquire",
        onClick: () => props.onAcquired({ rawRows: [], columns: [] }),
      },
      "acquire",
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

afterEach(() => {
  root?.unmount();
  container?.remove();
  root = undefined;
  container = undefined;
  acquire.lastProps = undefined;
  lifecycle.calls = [];
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
});
