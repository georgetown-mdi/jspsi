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
  /** Whether `GET /api/jobs/slot` reports the single slot occupied by `jobId` --
   * the signal the recovery panel probes when this browser holds no attachment. */
  slotOccupied?: boolean;
  /** The recurring-run hand-off body served for this job's `GET /handoff`; absent
   * leaves that route 404, keeping the graduation disclosure intrinsically gated
   * away (the way every existing recovery test sees no affordance). */
  handoff?: object;
}

/** A valid recurring-run hand-off body: enough for the finished render's collapsed
 * graduation disclosure to resolve and reveal its schedule snippets. */
const RECOVERY_HANDOFF = {
  mode: "exchange",
  channel: "sftp",
  usedKeyFile: true,
  credentialPasted: false,
  template: {
    kind: "config",
    yaml: "connection:\n  channel: sftp\n",
  },
};

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
      if (url === "/api/jobs/slot")
        return Promise.resolve(
          json(
            options.slotOccupied === true
              ? { occupied: true, id: jobId }
              : { occupied: false },
          ),
        );
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
      if (url === `/api/jobs/${jobId}/handoff`)
        return Promise.resolve(
          options.handoff !== undefined
            ? json(options.handoff)
            : new Response(null, { status: 404 }),
        );
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
    await vi.waitFor(() =>
      expect(
        page
          .getByText("An exchange started from this console", { exact: false })
          .query(),
      ).toBeNull(),
    );
  });
});

describe("console strand recovery panel", () => {
  test("renders for a live persisted id and discards it (cancel + DELETE) after a confirm, clearing the record", async () => {
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

    // Discard is irreversible and removes appliance-only data, so it confirms
    // first: the first click only opens the modal -- nothing is deleted yet.
    await page.getByRole("button", { name: "Discard" }).click();
    await expect
      .element(page.getByText("This cannot be undone", { exact: false }))
      .toBeInTheDocument();
    expect(
      api.captured.some(
        (r) => r.url === "/api/jobs/job-live" && r.method === "DELETE",
      ),
    ).toBe(false);

    // Confirm the discard: the modal's own Discard, scoped to the dialog so the
    // panel's Discard behind the overlay is never the target. A running job is
    // cancelled first, then DELETEd -- the one disk-remover.
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Discard" })
      .click();
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
    await vi.waitFor(() =>
      expect(
        page
          .getByText("An exchange started from this console", { exact: false })
          .query(),
      ).toBeNull(),
    );
  });

  test("cancelling the discard confirm removes nothing and keeps the record", async () => {
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
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Cancel" })
      .click();

    // Dismissing the confirm is a no-op: no cancel, no DELETE, record intact, and
    // the panel is still there.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      api.captured.some((r) => r.url === "/api/jobs/job-live/cancel"),
    ).toBe(false);
    expect(
      api.captured.some(
        (r) => r.url === "/api/jobs/job-live" && r.method === "DELETE",
      ),
    ).toBe(false);
    expect(window.localStorage.getItem(ATTACHMENT_KEY)).not.toBeNull();
    await expect
      .element(
        page.getByText(
          "An exchange started from this console is still running",
        ),
      )
      .toBeInTheDocument();
  });

  test("a finished re-attach heads finished and renders the download rows", async () => {
    persistAttachment("job-done");
    const api = stubRecoveryApi({ jobId: "job-done", status: "succeeded" });
    mount(createElement(InviterBench));

    // The probe reads succeeded, so the panel heads as finished immediately.
    await expect
      .element(
        page.getByText("An exchange started from this console has finished"),
      )
      .toBeInTheDocument();

    // The replay delivers the result frame; the appliance download row renders.
    await vi.waitFor(() =>
      expect(
        api.captured.some((r) => r.url === "/api/jobs/job-done/events"),
      ).toBe(true),
    );
    api.emit({ v: 1, type: "result", resultWritten: true });
    api.close();

    await expect
      .element(page.getByRole("heading", { level: 3, name: "Downloads" }))
      .toBeInTheDocument();
    await expect.element(page.getByText("results.csv")).toBeInTheDocument();
    expect(
      page
        .getByText("An exchange started from this console is still running")
        .query(),
    ).toBeNull();
  });

  test("a re-attach whose replay fails heads stopped and promises no downloads", async () => {
    // A run that was still going when the operator left (status running); the
    // replay then delivers a FAILURE terminal (e.g. a peer-timeout while away).
    persistAttachment("job-fail");
    const api = stubRecoveryApi({ jobId: "job-fail", status: "running" });
    mount(createElement(InviterBench));

    await vi.waitFor(() =>
      expect(
        api.captured.some((r) => r.url === "/api/jobs/job-fail/events"),
      ).toBe(true),
    );
    api.emit({
      v: 1,
      type: "error",
      category: "exchange",
      message: "the partner never connected",
    });
    api.close();

    // The stopped render: heading and body must NOT promise downloads, and the
    // failure alert -- not a Downloads block -- is what the operator sees.
    await expect
      .element(page.getByText("An exchange started from this console stopped"))
      .toBeInTheDocument();
    await expect.element(page.getByText("Exchange failed")).toBeInTheDocument();
    expect(
      page.getByText("Download its results below", { exact: false }).query(),
    ).toBeNull();
    expect(
      page
        .getByText("An exchange started from this console has finished")
        .query(),
    ).toBeNull();
    expect(
      page.getByRole("heading", { level: 3, name: "Downloads" }).query(),
    ).toBeNull();
  });

  test("a transient status failure leaves the record intact for the next mount", async () => {
    // A non-404 fault on the status probe: unreachable, NOT a confirmed removal.
    persistAttachment("job-live");
    const api = stubRecoveryApi({ jobId: "job-live", statusCode: 503 });
    mount(createElement(InviterBench));

    // Let the probe resolve. The blip must not delete the orphan nor clear the
    // record -- the next mount has to be able to recover a still-live exchange.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      api.captured.some(
        (r) => r.url === "/api/jobs/job-live" && r.method === "DELETE",
      ),
    ).toBe(false);
    expect(window.localStorage.getItem(ATTACHMENT_KEY)).not.toBeNull();
    await vi.waitFor(() =>
      expect(
        page
          .getByText("An exchange started from this console", { exact: false })
          .query(),
      ).toBeNull(),
    );
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
    await vi.waitFor(() =>
      expect(
        page
          .getByText("An exchange started from this console", { exact: false })
          .query(),
      ).toBeNull(),
    );
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

  const graduationToggle = () =>
    page.getByRole("button", { name: /run this on a schedule/i });

  test("a finished re-attach offers the collapsed graduation disclosure, revealed on click", async () => {
    persistAttachment("job-done");
    const api = stubRecoveryApi({
      jobId: "job-done",
      status: "succeeded",
      handoff: RECOVERY_HANDOFF,
    });
    mount(createElement(InviterBench));

    await expect
      .element(
        page.getByText("An exchange started from this console has finished"),
      )
      .toBeInTheDocument();

    // Deliver the result frame so outputs are defined -- the steady state in which
    // the graduation disclosure accompanies the delivered results.
    await vi.waitFor(() =>
      expect(
        api.captured.some((r) => r.url === "/api/jobs/job-done/events"),
      ).toBe(true),
    );
    api.emit({ v: 1, type: "result", resultWritten: true });
    api.close();

    // Downloads and the graduation toggle coexist.
    await expect
      .element(page.getByRole("heading", { level: 3, name: "Downloads" }))
      .toBeInTheDocument();

    // The disclosure is present but starts collapsed -- aria-expanded is the
    // durable signal, and the schedule detail is not revealed yet.
    await expect.element(graduationToggle()).toBeInTheDocument();
    expect(graduationToggle().element().getAttribute("aria-expanded")).toBe(
      "false",
    );

    // Opening it reveals the hand-off body; the cron line is a stable marker that
    // survives either template kind.
    await graduationToggle().click();
    expect(graduationToggle().element().getAttribute("aria-expanded")).toBe(
      "true",
    );
    await expect
      .element(page.getByText("0 2 * * *", { exact: false }))
      .toBeVisible();
  });

  test("the running render offers no graduation disclosure", async () => {
    persistAttachment("job-live");
    stubRecoveryApi({
      jobId: "job-live",
      status: "running",
      handoff: RECOVERY_HANDOFF,
    });
    mount(createElement(InviterBench));

    await expect
      .element(
        page.getByText(
          "An exchange started from this console is still running",
        ),
      )
      .toBeInTheDocument();

    // Even with a hand-off available on the appliance, graduation is a
    // finished-only affordance: the running render never mounts the disclosure.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(graduationToggle().query()).toBeNull();
  });

  test("the stopped render offers no graduation disclosure", async () => {
    persistAttachment("job-fail");
    stubRecoveryApi({
      jobId: "job-fail",
      status: "failed",
      handoff: RECOVERY_HANDOFF,
    });
    mount(createElement(InviterBench));

    await expect
      .element(page.getByText("An exchange started from this console stopped"))
      .toBeInTheDocument();

    // A stopped (failed/cancelled) run has nothing to graduate; no disclosure even
    // when a hand-off is available.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(graduationToggle().query()).toBeNull();
  });

  test("a finished run with no hand-off shows no dangling graduation toggle", async () => {
    persistAttachment("job-done");
    const api = stubRecoveryApi({ jobId: "job-done", status: "succeeded" });
    mount(createElement(InviterBench));

    await expect
      .element(
        page.getByText("An exchange started from this console has finished"),
      )
      .toBeInTheDocument();

    // Deliver the result so outputs are defined -- the state in which the toggle
    // COULD show, so its absence here proves the intrinsic gate rather than a
    // not-yet-delivered result.
    await vi.waitFor(() =>
      expect(
        api.captured.some((r) => r.url === "/api/jobs/job-done/events"),
      ).toBe(true),
    );
    api.emit({ v: 1, type: "result", resultWritten: true });
    api.close();

    await expect
      .element(page.getByRole("heading", { level: 3, name: "Downloads" }))
      .toBeInTheDocument();

    // The hand-off route 404s: RecurringHandoff self-gates to null, so the
    // disclosure toggle never appears (no empty toggle over an unavailable body).
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(graduationToggle().query()).toBeNull();
  });
});

describe("console lobby occupancy probe (no stored attachment)", () => {
  test("an occupied slot renders the panel with the neutral copy and discards the probed id", async () => {
    // Empty localStorage: the slot-occupancy probe is the only signal that an
    // exchange is on the appliance.
    const api = stubRecoveryApi({
      jobId: "job-probe",
      status: "running",
      slotOccupied: true,
    });
    mount(createElement(InviterBench));

    // The panel appears from the probe alone, with the neutral lead ("started
    // here") rather than the inaccurate "you started here" -- another browser may
    // have started it.
    await expect
      .element(
        page.getByText(
          "An exchange started from this console is still running",
        ),
      )
      .toBeInTheDocument();
    await expect
      .element(page.getByText("an exchange started here", { exact: false }))
      .toBeInTheDocument();
    expect(
      page.getByText("an exchange you started here", { exact: false }).query(),
    ).toBeNull();

    // The probe drove the id, and adoption persisted nothing -- state only.
    expect(api.captured.some((r) => r.url === "/api/jobs/slot")).toBe(true);
    expect(window.localStorage.getItem(ATTACHMENT_KEY)).toBeNull();

    // Discard rides the existing per-id path against the PROBED id: confirm, then
    // cancel + DELETE.
    await page.getByRole("button", { name: "Discard" }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Discard" })
      .click();
    await vi.waitFor(
      () => {
        expect(
          api.captured.some((r) => r.url === "/api/jobs/job-probe/cancel"),
        ).toBe(true);
        expect(
          api.captured.some(
            (r) => r.url === "/api/jobs/job-probe" && r.method === "DELETE",
          ),
        ).toBe(true);
      },
      { timeout: 4000 },
    );
    await vi.waitFor(() =>
      expect(
        page
          .getByText("An exchange started from this console", { exact: false })
          .query(),
      ).toBeNull(),
    );
  });

  test("the probed slot re-attaches (pick-up) and its result renders downloads", async () => {
    const api = stubRecoveryApi({
      jobId: "job-probe",
      status: "succeeded",
      slotOccupied: true,
    });
    mount(createElement(InviterBench));

    await expect
      .element(
        page.getByText("An exchange started from this console has finished"),
      )
      .toBeInTheDocument();

    // The re-attach reads the PROBED id's event stream; its result frame renders
    // the appliance download row.
    await vi.waitFor(() =>
      expect(
        api.captured.some((r) => r.url === "/api/jobs/job-probe/events"),
      ).toBe(true),
    );
    api.emit({ v: 1, type: "result", resultWritten: true });
    api.close();

    await expect
      .element(page.getByRole("heading", { level: 3, name: "Downloads" }))
      .toBeInTheDocument();
    await expect.element(page.getByText("results.csv")).toBeInTheDocument();
  });

  test("a probed slot that already stopped shows the stopped lead and only Discard", async () => {
    // The slot probe surfaces an occupant whose run already stopped
    // (failed/cancelled): the panel heads stopped from the initial status,
    // promises no downloads, and offers only Discard -- the persisted stopped
    // path, reached through the probe rather than a stored attachment.
    const api = stubRecoveryApi({
      jobId: "job-probe",
      status: "failed",
      slotOccupied: true,
    });
    mount(createElement(InviterBench));

    await expect
      .element(page.getByText("An exchange started from this console stopped"))
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText("before it finished, so there are no results", {
          exact: false,
        }),
      )
      .toBeInTheDocument();
    // The neutral probe-adopted lead, not the "you started here" persisted copy.
    await expect
      .element(page.getByText("an exchange started here", { exact: false }))
      .toBeInTheDocument();
    expect(
      page.getByText("an exchange you started here", { exact: false }).query(),
    ).toBeNull();

    // The probe drove the id, and adoption persisted nothing.
    expect(api.captured.some((r) => r.url === "/api/jobs/slot")).toBe(true);
    expect(window.localStorage.getItem(ATTACHMENT_KEY)).toBeNull();

    // No result on a stopped run: no Downloads block, and no Stop -- only Discard.
    expect(
      page.getByText("Download its results below", { exact: false }).query(),
    ).toBeNull();
    expect(
      page.getByRole("heading", { level: 3, name: "Downloads" }).query(),
    ).toBeNull();
    expect(
      page.getByRole("button", { name: "Stop this exchange" }).query(),
    ).toBeNull();
    await expect
      .element(page.getByRole("button", { name: "Discard" }))
      .toBeInTheDocument();
  });

  test("a free slot with empty storage renders nothing", async () => {
    const api = stubRecoveryApi({ slotOccupied: false });
    mount(createElement(InviterBench));

    // The probe ran and reported free, so nothing is recovered.
    await vi.waitFor(() =>
      expect(api.captured.some((r) => r.url === "/api/jobs/slot")).toBe(true),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(
      page
        .getByText("An exchange started from this console", { exact: false })
        .query(),
    ).toBeNull();
    // Nothing to re-attach to, so no event stream was opened.
    expect(api.captured.some((r) => r.url.endsWith("/events"))).toBe(false);
  });
});
