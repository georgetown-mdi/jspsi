/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { page } from "vitest/browser";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

// Load Mantine's stylesheet so components render with their real geometry.
import "@mantine/core/styles.css";

import { InviterBench } from "@bench/InviterBench";

import { renderApp } from "./renderApp";

import type { ReactNode } from "react";
import type { Root } from "react-dom/client";

// Stub the router seam the bench components touch (the benchConsoleInviter pattern).
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

// This suite exercises the CONSOLE build, where the recovery panel mounts.
vi.mock("@utils/clientConfig", () => ({
  deploymentProfile: () => "console" as const,
  isConsoleBuild: () => true,
}));

// The console disables the browser transport; nothing here drives it.
vi.mock("@psi/rendezvous", () => ({
  dialAsAcceptor: vi.fn(),
  listenAsInviter: vi.fn(),
}));

const ATTACHMENT_KEY = "psilink-console-last-job";

interface CapturedRequest {
  url: string;
  method: string;
}

interface RecoveryStubOptions {
  jobId?: string;
  status?: string;
  /** A non-2xx code for the job's status GET (e.g. 404 for a deleted/orphaned id). */
  statusCode?: number;
  /** A non-2xx code for the inputs listing (404 = API disabled). */
  inputsStatus?: number;
}

/** The same-origin job API stubbed at the global fetch seam, tailored to the
 * recovery panel: the inputs/sftp/rendezvous the idle bench reads, plus the
 * status / events / cancel / delete routes the panel drives for one job id. */
function stubRecoveryApi(options: RecoveryStubOptions = {}): {
  captured: Array<CapturedRequest>;
  emit: (event: object) => void;
  close: () => void;
} {
  const captured: Array<CapturedRequest> = [];
  const jobId = options.jobId ?? "job-live";
  let jobStatus = options.status ?? "running";
  let sse: ReadableStreamDefaultController<Uint8Array> | undefined;
  const encoder = new TextEncoder();
  const realFetch = window.fetch.bind(window);
  const json = (body: unknown, status = 200) =>
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
      captured.push({ url, method });
      if (url === "/api/jobs/inputs")
        return Promise.resolve(
          options.inputsStatus !== undefined
            ? new Response(null, { status: options.inputsStatus })
            : json({ configured: true, files: [] }),
        );
      if (url === "/api/jobs/sftp")
        return Promise.resolve(json({ configured: false }));
      if (url === "/api/jobs/rendezvous")
        return Promise.resolve(json({ configured: false }));
      if (url === `/api/jobs/${jobId}`) {
        if (method === "DELETE")
          return Promise.resolve(new Response(null, { status: 204 }));
        if (options.statusCode !== undefined)
          return Promise.resolve(
            new Response(null, { status: options.statusCode }),
          );
        return Promise.resolve(
          json({ status: jobStatus, recordAvailable: false }),
        );
      }
      if (url === `/api/jobs/${jobId}/cancel`) {
        // A graceful cancel drives the job to terminal, which the discard poll
        // then observes before deleting.
        jobStatus = "cancelled";
        return Promise.resolve(new Response(null, { status: 200 }));
      }
      if (url === `/api/jobs/${jobId}/events`)
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
      return Promise.resolve(new Response(null, { status: 404 }));
    },
  );

  return {
    captured,
    emit: (event) =>
      sse?.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)),
    close: () => sse?.close(),
  };
}

function persistAttachment(
  jobId: string,
  seat: "inviter" | "acceptor" = "inviter",
  channel = "sftp",
): void {
  window.localStorage.setItem(
    ATTACHMENT_KEY,
    JSON.stringify({ v: 1, jobId, seat, channel }),
  );
}

let container: HTMLElement | undefined;
let root: Root | undefined;

function mount(content: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(renderApp(content));
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  root?.unmount();
  container?.remove();
  root = undefined;
  container = undefined;
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe("console inputs disabled state", () => {
  test("a 404 on the inputs listing shows the API-disabled picker state", async () => {
    stubRecoveryApi({ inputsStatus: 404 });
    mount(createElement(InviterBench));
    // The distinct informational state, not the red transient fault. The title and
    // the named env var are unique to it (the file section's sample-data copy also
    // links the deployment guide, so that link alone would not disambiguate).
    await expect
      .element(
        page.getByText("The job API is disabled on this appliance", {
          exact: true,
        }),
      )
      .toBeInTheDocument();
    await expect
      .element(page.getByText("JOB_DATA_ROOT", { exact: false }))
      .toBeInTheDocument();
    // The transient red fault must not be what shows for a deliberate 404.
    expect(
      page.getByText("check that the job API is reachable").query(),
    ).toBeNull();
    // Nothing to recover, so no recovery panel.
    expect(
      page
        .getByText("An exchange started from this console", { exact: false })
        .query(),
    ).toBeNull();
  });
});

describe("console strand recovery panel", () => {
  test("renders for a live persisted id and discards it (cancel + DELETE), clearing the record", async () => {
    persistAttachment("job-live");
    const api = stubRecoveryApi({ jobId: "job-live", status: "running" });
    mount(createElement(InviterBench));

    await expect
      .element(
        page.getByText(
          "An exchange started from this console is still running",
        ),
      )
      .toBeInTheDocument();

    await page.getByRole("button", { name: "Discard" }).click();

    // A running job is cancelled first, then DELETEd -- the one disk-remover.
    await vi.waitFor(
      () => {
        expect(
          api.captured.some((r) => r.url === "/api/jobs/job-live/cancel"),
        ).toBe(true);
        expect(
          api.captured.some(
            (r) => r.url === "/api/jobs/job-live" && r.method === "DELETE",
          ),
        ).toBe(true);
      },
      { timeout: 4000 },
    );
    // The recovery record is cleared, and the panel renders nothing.
    await vi.waitFor(() =>
      expect(window.localStorage.getItem(ATTACHMENT_KEY)).toBeNull(),
    );
    expect(
      page
        .getByText("An exchange started from this console", { exact: false })
        .query(),
    ).toBeNull();
  });

  test("a 404 probe deletes the orphan id and renders nothing", async () => {
    persistAttachment("job-gone", "acceptor", "filedrop");
    const api = stubRecoveryApi({ jobId: "job-gone", statusCode: 404 });
    mount(createElement(InviterBench));

    // The id is gone: the panel best-effort DELETEs it (bounding a
    // restart-orphaned workdir), clears the record, and renders nothing.
    await vi.waitFor(() =>
      expect(
        api.captured.some(
          (r) => r.url === "/api/jobs/job-gone" && r.method === "DELETE",
        ),
      ).toBe(true),
    );
    await vi.waitFor(() =>
      expect(window.localStorage.getItem(ATTACHMENT_KEY)).toBeNull(),
    );
    expect(
      page
        .getByText("An exchange started from this console", { exact: false })
        .query(),
    ).toBeNull();
  });

  test("unmounting the panel does NOT cancel the running exchange", async () => {
    persistAttachment("job-live");
    const api = stubRecoveryApi({ jobId: "job-live", status: "running" });
    mount(createElement(InviterBench));

    await expect
      .element(
        page.getByText(
          "An exchange started from this console is still running",
        ),
      )
      .toBeInTheDocument();

    // Unmount stands in for a navigation / tab close: it aborts the panel's own
    // stream consumption only, never POSTs a cancel. The run keeps going.
    root?.unmount();
    root = undefined;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      api.captured.some((r) => r.url === "/api/jobs/job-live/cancel"),
    ).toBe(false);
  });

  test("Stop this exchange POSTs a cancel", async () => {
    persistAttachment("job-live");
    const api = stubRecoveryApi({ jobId: "job-live", status: "running" });
    mount(createElement(InviterBench));

    await page.getByRole("button", { name: "Stop this exchange" }).click();

    await vi.waitFor(() =>
      expect(
        api.captured.some((r) => r.url === "/api/jobs/job-live/cancel"),
      ).toBe(true),
    );
  });
});
