/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

// Load Mantine's stylesheet so components render with their real geometry.
import "@mantine/core/styles.css";

import { BenchLobby } from "@bench/BenchLobby";
import { DirectExchangeBench } from "@bench/DirectExchangeBench";

import { renderApp } from "./renderApp";

import type { ReactNode } from "react";
import type { Root } from "react-dom/client";

// Stub the router seam the bench components touch.
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

// This suite exercises the CONSOLE build (the direct-exchange flow is console-only).
vi.mock("@utils/clientConfig", () => ({
  deploymentProfile: () => "console" as const,
  isConsoleBuild: () => true,
}));

// Stub the rendezvous module: importing it runs a top-level config load that reads
// `process` (absent in the browser runner). The direct flow drives no browser
// transport, so its functions are never called.
vi.mock("@psi/rendezvous", () => ({
  dialAsAcceptor: vi.fn(),
  listenAsInviter: vi.fn(),
}));

const CLIENTS_FILE = {
  name: "clients.csv",
  sizeBytes: 4096,
  modifiedAt: 1_700_000_000_000,
};

const CLIENTS_PROFILE = {
  ...CLIENTS_FILE,
  rowCount: 2,
  columns: ["client_id", "first_name", "last_name", "dob", "program_code"],
  dateInputFormat: "%m/%d/%Y",
  columnSamples: [
    { column: "client_id", values: ["1", "2"] },
    { column: "first_name", values: ["Ann", "Bo"] },
    { column: "last_name", values: ["Lee", "Ray"] },
    { column: "dob", values: ["01/02/1990", "03/04/1985"] },
    { column: "program_code", values: ["A", "B"] },
  ],
};

interface CapturedRequest {
  url: string;
  method: string;
  body?: string;
}

interface StubOptions {
  sftp?: unknown;
  rendezvous?: unknown;
}

/** The same-origin job API, stubbed at the global fetch seam. Unmatched URLs fall
 * through to the real fetch. */
function stubJobApi(options: StubOptions = {}): {
  captured: Array<CapturedRequest>;
  emitEvent: (event: object) => void;
  closeEvents: () => void;
} {
  const captured: Array<CapturedRequest> = [];
  const encoder = new TextEncoder();
  let sse: ReadableStreamDefaultController<Uint8Array> | undefined;
  const realFetch = window.fetch.bind(window);

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
        return Promise.resolve(
          jsonResponse({ configured: true, files: [CLIENTS_FILE] }),
        );
      if (url.startsWith("/api/jobs/inputs/profile"))
        return Promise.resolve(jsonResponse(CLIENTS_PROFILE));
      if (url === "/api/jobs/sftp")
        return Promise.resolve(
          jsonResponse(options.sftp ?? { configured: false }),
        );
      if (url === "/api/jobs/rendezvous")
        return Promise.resolve(
          jsonResponse(options.rendezvous ?? { configured: false }),
        );
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
      if (url === "/api/jobs/job-7") {
        if ((init?.method ?? "GET") === "DELETE")
          return Promise.resolve(new Response(null, { status: 204 }));
        return Promise.resolve(
          jsonResponse({ status: "running", recordAvailable: false }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    },
  );

  return {
    captured,
    emitEvent: (event) =>
      sse?.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)),
    closeEvents: () => sse?.close(),
  };
}

const CONFIGURED_SFTP = {
  configured: true,
  host: "sftp.example.gov",
  port: 2222,
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
  // Flush any in-flight fetch resolution before the synchronous unmount, so teardown
  // never races a render.
  await new Promise((resolve) => setTimeout(resolve, 0));
  root?.unmount();
  container?.remove();
  root = undefined;
  container = undefined;
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

/** Reach the confirm step: pick and commit the mounted file (which auto-advances to
 * the server step), then continue past the agreed-server step (SFTP is configured
 * and selected by default). */
async function reachConfirm() {
  await page.getByRole("button", { name: "Select clients.csv" }).click();
  await page.getByRole("button", { name: "Use this file" }).click();
  await expect
    .element(page.getByRole("heading", { level: 1, name: "The agreed server" }))
    .toBeInTheDocument();
  await page
    .getByRole("button", { name: "Continue to confirm and run" })
    .click();
  await expect
    .element(page.getByRole("heading", { level: 1, name: "Confirm and run" }))
    .toBeInTheDocument();
}

describe("direct exchange confirm and run", () => {
  test("previews the inferred terms, gates Run on the affirmation, and runs a zero-setup job", async () => {
    const api = stubJobApi({ sftp: CONFIGURED_SFTP });
    mount(createElement(DirectExchangeBench));
    await reachConfirm();

    // The browser-side terms preview renders (the self-terms "proposing" framing).
    await expect
      .element(page.getByRole("heading", { name: "Exchange proposal" }))
      .toBeInTheDocument();

    // The two fixed symmetry notices frame the preview.
    await expect
      .element(
        page.getByText("Your partner runs the same step", { exact: false }),
      )
      .toBeInTheDocument();
    // The disclosure record is surfaced positively.
    await expect
      .element(page.getByText("writes a disclosure record", { exact: false }))
      .toBeInTheDocument();

    // Run is gated behind the trust affirmation.
    await expect
      .element(page.getByRole("button", { name: "Run the exchange" }))
      .toBeDisabled();

    await userEvent.fill(
      page.getByLabelText("Your identity (optional)"),
      "County Health",
    );
    await page.getByRole("checkbox").click();
    await expect
      .element(page.getByRole("button", { name: "Run the exchange" }))
      .toBeEnabled();

    await page.getByRole("button", { name: "Run the exchange" }).click();

    // The run POSTs a zero-setup intent: mode zeroSetup, the mounted-file REFERENCE,
    // the identity, no connection field, and none of the exchange mode's secret or
    // terms material.
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
    expect(intent.mode).toBe("zeroSetup");
    expect(intent.channel).toBe("sftp");
    expect(intent.inputFile).toEqual({ name: "clients.csv" });
    expect(intent.inputCsv).toBeUndefined();
    expect(intent.identity).toBe("County Health");
    expect(intent.sharedSecret).toBeUndefined();
    expect(intent.linkageTerms).toBeUndefined();
    expect(intent.remote).toBeUndefined();

    // The run advances through the appliance's event stream to completion.
    await vi.waitFor(() =>
      expect(api.captured.some((r) => r.url === "/api/jobs/job-7/events")).toBe(
        true,
      ),
    );
    api.emitEvent({ v: 1, type: "stage", id: "confirming protocol" });
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Exchange in progress");
    api.emitEvent({ v: 1, type: "result", resultWritten: true });
    api.closeEvents();
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Exchange complete");
  });

  test("a terms mismatch surfaces clearly through the job-error path", async () => {
    const api = stubJobApi({ sftp: CONFIGURED_SFTP });
    mount(createElement(DirectExchangeBench));
    await reachConfirm();
    await page.getByRole("checkbox").click();
    await page.getByRole("button", { name: "Run the exchange" }).click();

    await vi.waitFor(() =>
      expect(api.captured.some((r) => r.url === "/api/jobs/job-7/events")).toBe(
        true,
      ),
    );
    // The CLI aborts a two-party term divergence with a category-config error.
    api.emitEvent({
      v: 1,
      type: "error",
      category: "config",
      message: "linkage terms do not match the partner's inferred terms",
    });
    api.closeEvents();
    await expect
      .element(page.getByText("Could not prepare the exchange"))
      .toBeInTheDocument();
    await expect
      .element(page.getByText("linkage terms do not match", { exact: false }))
      .toBeInTheDocument();
  });
});

describe("direct exchange transport step", () => {
  test("with no rendezvous mount the shared-directory option is disabled", async () => {
    stubJobApi({ sftp: CONFIGURED_SFTP, rendezvous: { configured: false } });
    mount(createElement(DirectExchangeBench));
    await page.getByRole("button", { name: "Select clients.csv" }).click();
    await page.getByRole("button", { name: "Use this file" }).click();
    await expect
      .element(
        page.getByRole("heading", { level: 1, name: "The agreed server" }),
      )
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("radio", { name: "An SFTP server" }))
      .toBeChecked();
    await expect
      .element(page.getByLabelText("A shared directory", { exact: false }))
      .toBeDisabled();
  });
});

describe("console lobby direct-exchange card", () => {
  test("offers a third card that links to the direct-exchange route", async () => {
    stubJobApi();
    mount(createElement(BenchLobby));
    const link = page.getByRole("link", { name: "Run a direct exchange" });
    await expect.element(link).toBeInTheDocument();
    await expect.element(link).toHaveAttribute("href", "/direct");
  });
});
