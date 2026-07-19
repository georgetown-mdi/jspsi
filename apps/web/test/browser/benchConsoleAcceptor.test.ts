/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

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
import { SERVER_JOB_KEEP_OPEN_BODY } from "@bench/BenchRunSurface";

import { renderApp } from "./renderApp";

import type { ReactNode } from "react";
import type { Root } from "react-dom/client";

import type {
  ConnectionEndpoint,
  InvitationToken,
  LinkageTerms,
} from "@psilink/core";

// This suite exercises the CONSOLE acceptor seat: the honest unsupported-shape
// gate, the advisory shared-folder locator, and the server-job run surface (the
// keep-open callout through a stubbed filedrop accept). For the gate, the dev
// server has no rendezvous mount configured, so `/api/jobs/rendezvous` reports
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
  // A server-job accept persists a strand-recovery record; clear it so the next
  // test's idle bench does not re-attach to a prior run's id.
  window.localStorage.clear();
  vi.unstubAllGlobals();
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

// The appliance HERE reports a configured rendezvous mount, so a single-directory
// filedrop accept is runnable and reaches the consent step.
function stubRendezvousMounted(): void {
  const realFetch = window.fetch.bind(window);
  const jsonResponse = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  vi.stubGlobal(
    "fetch",
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url === "/api/jobs/rendezvous")
        return Promise.resolve(
          jsonResponse({ configured: true, path: "/mnt/rendezvous" }),
        );
      if (url === "/api/jobs/inputs")
        return Promise.resolve(jsonResponse({ configured: true, files: [] }));
      if (url.startsWith("/api/jobs"))
        return Promise.resolve(new Response(null, { status: 404 }));
      return realFetch(input, init);
    },
  );
}

describe("console acceptor advisory shared-folder locator", () => {
  test("shows the partner's locator read-only and sanitized at the consent step", async () => {
    stubRendezvousMounted();
    window.location.hash = await encodeToken(FILEDROP_ENDPOINT);
    mount(createElement(AcceptorBench));

    // With a rendezvous mount configured the accept is runnable: the Continue action
    // replaces the unsupported block. Advancing reaches the consent step.
    await page
      .getByRole("button", { name: "Continue: consent & your file" })
      .click();

    // The consent step surfaces the partner's advisory shared-folder locator for the
    // operator to confirm against their own mounted directory -- display-only, and the
    // partner-supplied path is rendered through the sanitizing summary.
    await expect
      .element(page.getByText("Confirm the shared folder"))
      .toBeInTheDocument();
    await expect
      .element(page.getByText(FILEDROP_ENDPOINT.path!, { exact: false }))
      .toBeInTheDocument();
  });
});

// A profiled mounted file whose columns satisfy the invitation's linkage fields
// (first_name/last_name), so the confirm-columns verdict clears and the accept can
// launch on the appliance.
const ACCEPT_FILE = {
  name: "cohort.csv",
  sizeBytes: 4096,
  modifiedAt: 1_700_000_000_000,
};

const ACCEPT_PROFILE = {
  ...ACCEPT_FILE,
  rowCount: 2,
  columns: ["first_name", "last_name"],
  dateInputFormat: "%m/%d/%Y",
  columnSamples: [
    { column: "first_name", values: ["Ann", "Bo"] },
    { column: "last_name", values: ["Lee", "Ray"] },
  ],
};

// The full same-origin job API a console server-job accept drives: a mounted
// rendezvous and work directory, the file profile, the coverage sweep, and the job
// POST plus event stream the appliance run reads. Unmatched URLs fall through to the
// real fetch so the runner's own traffic is untouched.
function stubServerJobAccept(): {
  emitEvent: (event: object) => void;
  closeEvents: () => void;
  hasEventStream: () => boolean;
} {
  const realFetch = window.fetch.bind(window);
  const encoder = new TextEncoder();
  let sse: ReadableStreamDefaultController<Uint8Array> | undefined;
  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  vi.stubGlobal(
    "fetch",
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (!url.startsWith("/api/jobs")) return realFetch(input, init);
      if (url === "/api/jobs/rendezvous")
        return Promise.resolve(
          jsonResponse({ configured: true, path: "/mnt/rendezvous" }),
        );
      if (url === "/api/jobs/inputs")
        return Promise.resolve(
          jsonResponse({ configured: true, files: [ACCEPT_FILE] }),
        );
      if (url.startsWith("/api/jobs/inputs/profile"))
        return Promise.resolve(jsonResponse(ACCEPT_PROFILE));
      if (url === "/api/jobs/inputs/coverage")
        return Promise.resolve(jsonResponse({ rates: [] }));
      if (url === "/api/jobs")
        return Promise.resolve(jsonResponse({ id: "job-7" }, 201));
      if (url === "/api/jobs/job-7/events")
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                sse = controller;
              },
            }),
            { status: 200, headers: { "Content-Type": "text/event-stream" } },
          ),
        );
      if (url === "/api/jobs/job-7")
        return Promise.resolve(jsonResponse({ recordAvailable: false }));
      if (url === "/api/jobs/job-7/cancel")
        return Promise.resolve(new Response(null, { status: 200 }));
      return Promise.resolve(new Response(null, { status: 404 }));
    },
  );
  return {
    emitEvent: (event) =>
      sse?.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)),
    closeEvents: () => sse?.close(),
    hasEventStream: () => sse !== undefined,
  };
}

describe("console acceptor server-job keep-open callout", () => {
  test("holds the callout while the appliance runs the accept, then clears it once the run settles", async () => {
    const api = stubServerJobAccept();
    window.location.hash = await encodeToken(FILEDROP_ENDPOINT);
    mount(createElement(AcceptorBench));

    // Review -> consent: the rendezvous mount makes the filedrop accept runnable.
    await page
      .getByRole("button", { name: "Continue: consent & your file" })
      .click();
    await userEvent.fill(page.getByLabelText("Your name"), "Sam Alvarez");
    await page.getByRole("checkbox").click();
    await page.getByRole("button", { name: "Select cohort.csv" }).click();
    await page.getByRole("button", { name: "Use this file" }).click();
    await page.getByRole("button", { name: "Accept and continue" }).click();

    // Confirm columns -> start: the mounted file's columns satisfy the terms, so the
    // accept launches on the appliance.
    await expect
      .element(page.getByRole("heading", { name: "Confirm your columns" }))
      .toBeInTheDocument();
    await page.getByRole("button", { name: "Start the exchange" }).click();

    // The appliance is running the accept: the keep-open callout names the run the tab
    // is holding, the same copy the inviter's server-job run shows.
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Exchange in progress");
    await expect
      .element(page.getByText(SERVER_JOB_KEEP_OPEN_BODY))
      .toBeInTheDocument();

    // Settle the run from the appliance's event stream; the callout drops once results
    // exist -- there is no longer a live run for the tab to hold open.
    await vi.waitFor(() => expect(api.hasEventStream()).toBe(true));
    api.emitEvent({ v: 1, type: "result", resultWritten: true });
    api.closeEvents();
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Exchange complete");
    expect(page.getByText(SERVER_JOB_KEEP_OPEN_BODY).query()).toBeNull();
  });
});
