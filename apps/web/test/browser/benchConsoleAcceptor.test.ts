/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

// Load Mantine's stylesheet so components render with their real geometry.
import "@mantine/core/styles.css";

import { encodeInvitation, generateSharedSecret } from "@psilink/core";

import { ACCEPT_UNSUPPORTED_TITLE } from "@bench/acceptorModel";
import { AcceptorBench } from "@bench/AcceptorBench";

import { renderApp } from "./renderApp";

import type { ReactNode } from "react";
import type { Root } from "react-dom/client";

import type {
  ConnectionEndpoint,
  InvitationToken,
  LinkageTerms,
} from "@psilink/core";

// This suite exercises the CONSOLE acceptor seat: the mounted-directory intake at
// the consent step, the launch that sources a server-job accept from the mounted
// file (inputFile, never inline content), and the honest unsupported-channel state
// for an endpoint the appliance cannot run. The hosted acceptor journey stays pinned
// by acceptJourney.test.ts, which runs on the real default profile.

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
// `process` (absent in the browser runner). The console filedrop accept drives the
// server-job path, which never dials, so its functions are never called.
vi.mock("@psi/rendezvous", () => ({
  dialAsAcceptor: vi.fn(),
  listenAsInviter: vi.fn(),
}));

const COHORT_FILE = {
  name: "cohort.csv",
  sizeBytes: 4096,
  modifiedAt: 1_700_000_000_000,
};

const COHORT_PROFILE = {
  ...COHORT_FILE,
  rowCount: 2,
  columns: ["first_name", "last_name"],
  columnSamples: {
    first_name: ["Ann", "Bo"],
    last_name: ["Lee", "Ray"],
  },
};

// The inviter-perspective terms the accepted invitation carries: two keys the
// mounted file's columns satisfy, so the columns step lands all-clear.
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

interface CapturedRequest {
  url: string;
  method: string;
  body?: string;
}

/** The same-origin job API, stubbed at the global fetch seam. Unmatched URLs fall
 * through to the real fetch so the runner's own traffic is untouched. */
function stubJobApi(options: { listing?: unknown } = {}): {
  captured: Array<CapturedRequest>;
  setListing: (listing: unknown) => void;
  emitEvent: (event: object) => void;
  closeEvents: () => void;
} {
  const captured: Array<CapturedRequest> = [];
  const encoder = new TextEncoder();
  let sse: ReadableStreamDefaultController<Uint8Array> | undefined;
  const realFetch = window.fetch.bind(window);
  let listing: unknown = options.listing ?? {
    configured: true,
    totalEntries: 1,
    truncated: false,
    files: [COHORT_FILE],
  };

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
      captured.push({
        url,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      if (url === "/api/jobs/inputs")
        return Promise.resolve(jsonResponse(listing));
      if (url.startsWith("/api/jobs/inputs/profile"))
        return Promise.resolve(jsonResponse(COHORT_PROFILE));
      if (url === "/api/jobs/inputs/coverage")
        return Promise.resolve(jsonResponse({ rates: [] }));
      if (url === "/api/jobs")
        return Promise.resolve(jsonResponse({ id: "job-9" }, 201));
      if (url === "/api/jobs/job-9/events")
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
      if (url === "/api/jobs/job-9")
        return Promise.resolve(jsonResponse({ recordAvailable: false }));
      if (url === "/api/jobs/job-9/cancel")
        return Promise.resolve(new Response(null, { status: 200 }));
      return Promise.resolve(new Response(null, { status: 404 }));
    },
  );

  return {
    captured,
    setListing: (next) => {
      listing = next;
    },
    emitEvent: (event) =>
      sse?.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)),
    closeEvents: () => sse?.close(),
  };
}

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
  // Let any in-flight fetch resolution and its state update flush before the
  // synchronous unmount, so teardown never races a render (the picker and coverage
  // seams are fetch-driven).
  await new Promise((resolve) => setTimeout(resolve, 0));
  root?.unmount();
  container?.remove();
  root = undefined;
  container = undefined;
  window.location.hash = "";
  vi.unstubAllGlobals();
});

/** From a decoded filedrop invitation: review terms, then pick and confirm the
 * mounted file at the consent step, consent and name, and accept. Leaves the bench
 * on the confirm-columns step. */
async function reachColumnsFromFiledrop() {
  window.location.hash = await encodeToken(FILEDROP_ENDPOINT);
  mount(createElement(AcceptorBench));

  await expect
    .element(page.getByText("Invitation from County Health Department"))
    .toBeInTheDocument();
  await userEvent.click(
    page.getByRole("button", { name: "Continue: consent & your file" }),
  );
  await expect
    .element(page.getByRole("heading", { level: 1 }))
    .toHaveTextContent("Consent & your file");

  // The mounted-directory picker's two-stage pick, in place of the dropzone.
  await page.getByRole("button", { name: "Select cohort.csv" }).click();
  await expect.element(page.getByText("Confirm this file")).toBeInTheDocument();
  await page.getByRole("button", { name: "Use this file" }).click();
  await expect.element(page.getByText("Selected")).toBeInTheDocument();

  await userEvent.click(page.getByRole("checkbox"));
  await userEvent.fill(page.getByLabelText("Your name"), "Sam Alvarez");
  await userEvent.click(
    page.getByRole("button", { name: "Accept and continue" }),
  );
  await expect
    .element(page.getByRole("heading", { name: "Confirm your columns" }))
    .toBeInTheDocument();
}

describe("console acceptor mounted-file intake and launch", () => {
  test("a server-job accept sources the mounted file (inputFile, not inputCsv)", async () => {
    const api = stubJobApi();
    await reachColumnsFromFiledrop();

    // The seeded columns satisfy the adopted keys.
    await expect
      .element(page.getByText("All 2 keys can match"))
      .toBeInTheDocument();

    await userEvent.click(
      page.getByRole("button", { name: "Start the exchange" }),
    );

    // The run POSTs a filedrop intent carrying the mounted-file REFERENCE, never
    // inline content.
    await vi.waitFor(() => {
      expect(
        api.captured.some(
          (request) => request.url === "/api/jobs" && request.method === "POST",
        ),
      ).toBe(true);
    });
    const post = api.captured.find(
      (request) => request.url === "/api/jobs" && request.method === "POST",
    );
    const intent = JSON.parse(post?.body ?? "{}") as Record<string, unknown>;
    expect(intent.channel).toBe("filedrop");
    expect(intent.inputCsv).toBeUndefined();
    expect(intent.inputFile).toEqual(COHORT_FILE);

    // The result completes the run on the appliance's endpoint.
    await vi.waitFor(() =>
      expect(
        api.captured.some(
          (request) => request.url === "/api/jobs/job-9/events",
        ),
      ).toBe(true),
    );
    api.emitEvent({ v: 1, type: "result", resultWritten: true });
    api.closeEvents();
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Exchange complete");
  });

  test("the coverage sweep posts the mounted-file freshness reference", async () => {
    const api = stubJobApi();
    window.location.hash = await encodeToken(FILEDROP_ENDPOINT);
    mount(createElement(AcceptorBench));

    await userEvent.click(
      page.getByRole("button", { name: "Continue: consent & your file" }),
    );
    await page.getByRole("button", { name: "Select cohort.csv" }).click();
    await page.getByRole("button", { name: "Use this file" }).click();
    await expect.element(page.getByText("Selected")).toBeInTheDocument();

    // The bench's coverage provider posts to the appliance sweep with the file's
    // profiled freshness pair (no inline content).
    await vi.waitFor(() => {
      expect(
        api.captured.some(
          (request) =>
            request.url === "/api/jobs/inputs/coverage" &&
            request.method === "POST",
        ),
      ).toBe(true);
    });
    const post = api.captured.find(
      (request) => request.url === "/api/jobs/inputs/coverage",
    );
    const body = JSON.parse(post?.body ?? "{}") as Record<string, unknown>;
    expect(body.name).toBe("cohort.csv");
    expect(body.sizeBytes).toBe(COHORT_FILE.sizeBytes);
    expect(body.modifiedAt).toBe(COHORT_FILE.modifiedAt);
  });

  test("a listing refresh that finds a changed size/mtime shows the drift notice", async () => {
    const api = stubJobApi();
    window.location.hash = await encodeToken(FILEDROP_ENDPOINT);
    mount(createElement(AcceptorBench));

    await userEvent.click(
      page.getByRole("button", { name: "Continue: consent & your file" }),
    );
    await page.getByRole("button", { name: "Select cohort.csv" }).click();
    await page.getByRole("button", { name: "Use this file" }).click();
    await expect.element(page.getByText("Selected")).toBeInTheDocument();

    // The file changes on disk (size and mtime), then the operator refreshes.
    api.setListing({
      configured: true,
      totalEntries: 1,
      truncated: false,
      files: [
        { ...COHORT_FILE, sizeBytes: 9000, modifiedAt: 1_700_000_999_000 },
      ],
    });
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect
      .element(
        page.getByText("This file changed on disk since you profiled it"),
      )
      .toBeInTheDocument();
  });

  test("re-profiling the committed file re-commits and still reaches the columns step", async () => {
    stubJobApi();
    window.location.hash = await encodeToken(FILEDROP_ENDPOINT);
    mount(createElement(AcceptorBench));

    await userEvent.click(
      page.getByRole("button", { name: "Continue: consent & your file" }),
    );
    await page.getByRole("button", { name: "Select cohort.csv" }).click();
    await page.getByRole("button", { name: "Use this file" }).click();
    await expect.element(page.getByText("Selected")).toBeInTheDocument();

    // The committed row offers a re-profile; with the same columns it re-commits
    // through the acceptor's own commit path (reconcile-vs-reseed) without stranding
    // the intake, and the gate still advances to the columns step.
    await page.getByRole("button", { name: "Re-profile cohort.csv" }).click();
    await page.getByRole("button", { name: "Use this file" }).click();
    await expect.element(page.getByText("Selected")).toBeInTheDocument();

    await userEvent.click(page.getByRole("checkbox"));
    await userEvent.fill(page.getByLabelText("Your name"), "Sam Alvarez");
    await userEvent.click(
      page.getByRole("button", { name: "Accept and continue" }),
    );
    await expect
      .element(page.getByRole("heading", { name: "Confirm your columns" }))
      .toBeInTheDocument();
    await expect
      .element(page.getByText("All 2 keys can match"))
      .toBeInTheDocument();
  });
});

describe("console acceptor unsupported-channel state", () => {
  test("a webrtc invitation is blocked before consent, naming what the appliance can run", async () => {
    stubJobApi();
    window.location.hash = await encodeToken(WEBRTC_ENDPOINT);
    mount(createElement(AcceptorBench));

    // The terms still render (transparency), but the appliance cannot run an in-tab
    // WebRTC exchange, so the honest block replaces the Continue action.
    await expect
      .element(page.getByText("Invitation from County Health Department"))
      .toBeInTheDocument();
    await expect
      .element(page.getByText(ACCEPT_UNSUPPORTED_TITLE))
      .toBeInTheDocument();
    expect(
      page
        .getByRole("button", { name: "Continue: consent & your file" })
        .query(),
    ).toBeNull();
  });
});
