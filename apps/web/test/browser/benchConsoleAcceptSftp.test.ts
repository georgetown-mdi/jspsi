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

// The CONSOLE acceptor seat over SFTP: the operator authors the connection to the
// SFTP server the PARTNER named in the invitation before the appliance can run the
// accept. The invitation endpoint carries only the credential-free locator
// (host/port/path); the operator supplies the username, the required host-key
// fingerprint, and the credential. No invitation field flows into any of those.
// The hosted acceptor journey (which rejects SFTP outright) stays pinned by
// acceptJourney.test.ts.

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

// The unsupported gate and the server-job accept never dial; stub the rendezvous
// module so importing it does not run its config load (which reads `process`).
vi.mock("@psi/rendezvous", () => ({
  dialAsAcceptor: vi.fn(),
  listenAsInviter: vi.fn(),
}));

const FINGERPRINT = `SHA256:${"A".repeat(43)}`;

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

// A single-directory SFTP endpoint: the partner-named rendezvous server, carrying
// only its credential-free locator.
const SFTP_ENDPOINT: ConnectionEndpoint = {
  channel: "sftp",
  host: "sftp.partner.example",
  port: 2022,
  path: "/drop",
};
// A split inbound/outbound SFTP endpoint the appliance does not run (the authored
// connection composes a single remote directory).
const SPLIT_SFTP_ENDPOINT: ConnectionEndpoint = {
  channel: "sftp",
  host: "sftp.partner.example",
  inboundPath: "/in",
  outboundPath: "/out",
};

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

interface CapturedRequest {
  url: string;
  method: string;
  body?: string;
}

/** The same-origin job API a console SFTP accept drives: the mounted work file and
 * its profile, the sftp connection endpoints (GET reports the effective connection,
 * PUT authors it and flips GET to report it), and the job POST plus event stream.
 * PUT/POST bodies are captured so the test can assert what left the browser. */
function stubSftpAccept(): {
  captured: Array<CapturedRequest>;
  emitEvent: (event: object) => void;
  closeEvents: () => void;
  hasEventStream: () => boolean;
} {
  const captured: Array<CapturedRequest> = [];
  const realFetch = window.fetch.bind(window);
  const encoder = new TextEncoder();
  let sse: ReadableStreamDefaultController<Uint8Array> | undefined;
  let sftp: unknown = { configured: false, bootPinned: false };
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
      const method = init?.method ?? "GET";
      captured.push({
        url,
        method,
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      if (url === "/api/jobs/rendezvous")
        return Promise.resolve(jsonResponse({ configured: false }));
      if (url === "/api/jobs/inputs")
        return Promise.resolve(
          jsonResponse({ configured: true, files: [ACCEPT_FILE] }),
        );
      if (url.startsWith("/api/jobs/inputs/profile"))
        return Promise.resolve(jsonResponse(ACCEPT_PROFILE));
      if (url === "/api/jobs/inputs/coverage")
        return Promise.resolve(jsonResponse({ rates: [] }));
      if (url === "/api/jobs/sftp") {
        if (method === "PUT") {
          const parsed = JSON.parse(
            typeof init?.body === "string" ? init.body : "{}",
          ) as { host?: string; port?: number; path?: string };
          const projection: Record<string, unknown> = {
            configured: true,
            bootPinned: false,
            host: parsed.host,
          };
          if (parsed.port !== undefined) projection.port = parsed.port;
          if (parsed.path !== undefined) projection.path = parsed.path;
          sftp = projection;
          return Promise.resolve(jsonResponse(projection));
        }
        if (method === "DELETE") {
          sftp = { configured: false, bootPinned: false };
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        return Promise.resolve(jsonResponse(sftp));
      }
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
    captured,
    emitEvent: (event) =>
      sse?.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)),
    closeEvents: () => sse?.close(),
    hasEventStream: () => sse !== undefined,
  };
}

let container: HTMLElement | undefined;
let root: Root | undefined;

function mount(content: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(renderApp(content));
}

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  root?.unmount();
  container?.remove();
  root = undefined;
  container = undefined;
  window.location.hash = "";
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

/** Review -> consent -> confirm columns: accept the terms, pick the mounted file,
 * and land on the columns step where the SFTP connection is authored. */
async function reachColumnsStep() {
  await page
    .getByRole("button", { name: "Continue: consent & your file" })
    .click();
  await userEvent.fill(page.getByLabelText("Your name"), "Sam Alvarez");
  await page.getByRole("checkbox").click();
  await page.getByRole("button", { name: "Select cohort.csv" }).click();
  await page.getByRole("button", { name: "Use this file" }).click();
  await page.getByRole("button", { name: "Accept and continue" }).click();
  await expect
    .element(page.getByRole("heading", { name: "Confirm your columns" }))
    .toBeInTheDocument();
}

describe("console SFTP accept unsupported-shape gate", () => {
  test("a split-directory SFTP endpoint is refused at review, pointing at the CLI", async () => {
    stubSftpAccept();
    window.location.hash = await encodeToken(SPLIT_SFTP_ENDPOINT);
    mount(createElement(AcceptorBench));

    await expect
      .element(page.getByText("Invitation from County Health Department"))
      .toBeInTheDocument();
    await expect
      .element(page.getByText(ACCEPT_UNSUPPORTED_TITLE))
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText(acceptUnsupported(SPLIT_SFTP_ENDPOINT, false)!.message),
      )
      .toBeInTheDocument();
    expect(
      page
        .getByRole("button", { name: "Continue: consent & your file" })
        .query(),
    ).toBeNull();
  });
});

describe("console SFTP accept: author-then-launch", () => {
  test("blocks launch until the operator authors a connection with a fingerprint", async () => {
    stubSftpAccept();
    window.location.hash = await encodeToken(SFTP_ENDPOINT);
    mount(createElement(AcceptorBench));
    await reachColumnsStep();

    // The partner-named server is shown, and launch is blocked with an explanatory
    // note until the connection is authored.
    await expect
      .element(page.getByText("sftp.partner.example:2022", { exact: false }))
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText(
          "Set up the SFTP connection above before you can start.",
        ),
      )
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Start the exchange" }))
      .toBeDisabled();
  });

  test("authors from the operator's own fields and runs on the appliance", async () => {
    const api = stubSftpAccept();
    window.location.hash = await encodeToken(SFTP_ENDPOINT);
    mount(createElement(AcceptorBench));
    await reachColumnsStep();

    // The partner-supplied locator is shown before authoring.
    await expect
      .element(page.getByText("sftp.partner.example:2022", { exact: false }))
      .toBeInTheDocument();

    // Opening the form shows the locator as a read-only review block, never an
    // editable server-address field: no invitation field can be retyped into a
    // credential or the fingerprint.
    await page.getByRole("button", { name: "Set up connection" }).click();
    await expect
      .element(page.getByText("Your partner's SFTP server", { exact: true }))
      .toBeInTheDocument();
    expect(page.getByLabelText("SFTP server address").query()).toBeNull();
    await userEvent.fill(page.getByLabelText("Username"), "linkage");
    await userEvent.fill(
      page.getByLabelText("Server identity fingerprint"),
      FINGERPRINT,
    );
    await userEvent.fill(
      page.getByLabelText("File reference"),
      "@/run/secrets/partner-key",
    );
    await page.getByRole("button", { name: "Save connection" }).click();

    // The PUT carried the partner's locator (host/port/path) as the connection
    // target, and the operator's own username, fingerprint, and credential -- no
    // invitation field reached the credential or the fingerprint.
    const put = api.captured.find(
      (request) => request.url === "/api/jobs/sftp" && request.method === "PUT",
    );
    expect(put).toBeDefined();
    const body = JSON.parse(put?.body ?? "{}") as Record<string, unknown>;
    expect(body.host).toBe("sftp.partner.example");
    expect(body.port).toBe(2022);
    expect(body.path).toBe("/drop");
    expect(body.username).toBe("linkage");
    expect(body.hostKeyFingerprint).toBe(FINGERPRINT);
    expect(body.credential).toEqual({
      kind: "ref",
      ref: "@/run/secrets/partner-key",
      credType: "password",
    });

    // The card flips to the authored state and launch unblocks.
    await expect.element(page.getByText("Ready to try")).toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Start the exchange" }))
      .toBeEnabled();

    // Start the exchange: the appliance runs it as a server job on the sftp arm.
    await page.getByRole("button", { name: "Start the exchange" }).click();
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Exchange in progress");
    await expect
      .element(page.getByText(SERVER_JOB_KEEP_OPEN_BODY))
      .toBeInTheDocument();

    // The job POST rode the sftp intent arm; the appliance reads the authored
    // connection, so no host, credential, or fingerprint is in the intent body.
    const post = api.captured.find(
      (request) => request.url === "/api/jobs" && request.method === "POST",
    );
    const intent = JSON.parse(post?.body ?? "{}") as Record<string, unknown>;
    expect(intent.channel).toBe("sftp");
    const intentText = post?.body ?? "";
    expect(intentText).not.toContain(FINGERPRINT);
    expect(intentText).not.toContain("partner-key");

    // Settle the run from the appliance's event stream.
    await vi.waitFor(() => expect(api.hasEventStream()).toBe(true));
    api.emitEvent({ v: 1, type: "result", resultWritten: true });
    api.closeEvents();
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Exchange complete");
  });
});
