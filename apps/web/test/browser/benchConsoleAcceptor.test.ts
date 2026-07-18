/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page } from "vitest/browser";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

// Load Mantine's stylesheet so components render with their real geometry.
import "@mantine/core/styles.css";

import { encodeInvitation, generateSharedSecret } from "@psilink/core";

import {
  ACCEPT_UNSUPPORTED_TITLE,
  acceptUnsupported,
} from "@bench/acceptorModel";
import { AcceptorBench } from "@bench/AcceptorBench";

import { renderApp } from "./renderApp";

import type { ReactNode } from "react";
import type { Root } from "react-dom/client";

import type {
  ConnectionEndpoint,
  InvitationToken,
  LinkageTerms,
} from "@psilink/core";

// This suite exercises the CONSOLE acceptor seat's honest unsupported-shape gate. The
// dev server has no rendezvous mount configured, so `/api/jobs/rendezvous` reports
// unavailable: a WebRTC accept is out of scope on the appliance, and a
// single-directory file-drop accept needs JOB_RENDEZVOUS_DIR. Both are stopped at the
// review step -- before consent or intake -- with an honest state naming where the
// operator CAN run the exchange. The hosted acceptor journey stays pinned by
// acceptJourney.test.ts, which runs on the real default profile.

// Stub the router seam the bench and its recovery links touch.
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

vi.mock("@utils/clientConfig", () => ({
  deploymentProfile: () => "console" as const,
  isConsoleBuild: () => true,
}));

// Stub the rendezvous module: importing it runs a top-level config load that reads
// `process` (absent in the browser runner). The unsupported gate never dials.
vi.mock("@psi/rendezvous", () => ({
  dialAsAcceptor: vi.fn(),
  listenAsInviter: vi.fn(),
}));

// The inviter-perspective terms the accepted invitation carries. The terms render at
// the review step for transparency even though the appliance cannot run the exchange.
const inviterTerms: LinkageTerms = {
  version: "1.0.0",
  identity: "County Health Department",
  date: "2026-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: false, shareWithPartner: true },
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

async function encodeToken(endpoint: ConnectionEndpoint): Promise<string> {
  const token: InvitationToken = {
    version: "1",
    linkageTerms: inviterTerms,
    sharedSecret: generateSharedSecret(),
    expires: new Date(Date.now() + 3600 * 1000).toISOString(),
    connectionEndpoint: endpoint,
  };
  return encodeInvitation(token);
}

// A file-drop endpoint carrying a real external locator -- the shipped shape of a
// CLI-minted shared-directory invitation. The appliance ignores this path and polls
// its own private per-job directory, so the run could never rendezvous; the gate must
// refuse it rather than assert a (mock-only) successful run.
const FILEDROP_ENDPOINT: ConnectionEndpoint = {
  channel: "filedrop",
  path: "/drops/psilink",
};
const WEBRTC_ENDPOINT: ConnectionEndpoint = {
  channel: "webrtc",
  host: "127.0.0.1",
  port: 3000,
  path: "/api/",
};

let container: HTMLElement | undefined;
let root: Root | undefined;

function mount(content: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(renderApp(content));
}

afterEach(async () => {
  // Let the async decode's state update flush before the synchronous unmount, so
  // teardown never races a render.
  await new Promise((resolve) => setTimeout(resolve, 0));
  root?.unmount();
  container?.remove();
  root = undefined;
  container = undefined;
  window.location.hash = "";
});

describe("console acceptor unsupported-shape gate", () => {
  test("a single-directory filedrop is blocked when no rendezvous mount is configured", async () => {
    window.location.hash = await encodeToken(FILEDROP_ENDPOINT);
    mount(createElement(AcceptorBench));

    // The terms still render (transparency), but with no rendezvous mount the honest
    // block replaces the Continue action and names the env var to set.
    await expect
      .element(page.getByText("Invitation from County Health Department"))
      .toBeInTheDocument();
    await expect
      .element(page.getByText(ACCEPT_UNSUPPORTED_TITLE))
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText(acceptUnsupported(FILEDROP_ENDPOINT, false)!.message),
      )
      .toBeInTheDocument();
    expect(
      page
        .getByRole("button", { name: "Continue: consent & your file" })
        .query(),
    ).toBeNull();
  });

  test("a webrtc invitation is out of scope on the appliance, pointing at the web app", async () => {
    window.location.hash = await encodeToken(WEBRTC_ENDPOINT);
    mount(createElement(AcceptorBench));

    await expect
      .element(page.getByText("Invitation from County Health Department"))
      .toBeInTheDocument();
    await expect
      .element(page.getByText(ACCEPT_UNSUPPORTED_TITLE))
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText(acceptUnsupported(WEBRTC_ENDPOINT, false)!.message),
      )
      .toBeInTheDocument();
    expect(
      page
        .getByRole("button", { name: "Continue: consent & your file" })
        .query(),
    ).toBeNull();
  });
});
