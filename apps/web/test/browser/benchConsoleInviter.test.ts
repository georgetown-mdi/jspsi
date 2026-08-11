/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";

// Load Mantine's stylesheet so components render with their real geometry.
import "@mantine/core/styles.css";

import { decodeInvitation } from "@psilink/core";

import { InviterBench } from "@bench/InviterBench";
import { RETAIN_MODE_BILATERAL_NOTICE } from "@bench/exchangeFilesModel";
import styles from "@bench/bench.module.css";

import { createAppMount, flushPendingUpdates } from "./renderApp";
import { captureDownloads } from "./captureDownloads";

import type { CapturedDownload } from "./captureDownloads";

// The bench components touch the router seam.
vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);

// This suite exercises the CONSOLE build; the hosted-profile behaviors stay pinned
// by bench.test.ts, which runs on the real default profile.
vi.mock("@utils/clientConfig", () => ({
  deploymentProfile: () => "console" as const,
  isConsoleBuild: () => true,
  psilinkVersion: () => undefined,
}));

// Nothing here drives the browser transport (it is disabled on the console), so
// the rendezvous functions are never called.
vi.mock("@psi/rendezvous", async () =>
  (await import("./moduleMocks")).rendezvousMock(),
);

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
  listing?: unknown;
  profile?: unknown;
  profileStatus?: number;
  profileErrorCode?: string;
  sftp?: unknown;
  rendezvous?: unknown;
  coverageStatus?: number;
  /** When set, `POST /api/jobs` returns a busy (409) carrying this id (the slot is
   * occupied), and the id's status/events routes are served so the client can
   * re-attach to it. `holdProbe` withholds the FIRST status GET (the liveness
   * probe) until `resolveProbe()` is called, so a test can observe the reconnecting
   * interim before the recovery view lands. */
  conflict?: { jobId: string; status?: string; holdProbe?: boolean };
  /** The body `GET /api/jobs/:id/handoff` serves (the recurring-run hand-off); a
   * 404 when unset, so the panel renders nothing. */
  handoff?: unknown;
}

/** The same-origin job API, stubbed at the global fetch seam. Unmatched URLs fall
 * through to the real fetch so the runner's own traffic is untouched. */
function stubJobApi(options: StubOptions = {}): {
  captured: Array<CapturedRequest>;
  setListing: (listing: unknown) => void;
  setProfile: (profile: unknown) => void;
  setJobStatus: (status: string) => void;
  emitEvent: (event: object) => void;
  closeEvents: () => void;
  resolveProbe: () => void;
} {
  const captured: Array<CapturedRequest> = [];
  const encoder = new TextEncoder();
  let sse: ReadableStreamDefaultController<Uint8Array> | undefined;
  const realFetch = window.fetch.bind(window);
  // The gate the held liveness probe (conflict.holdProbe) awaits; the first
  // status GET blocks on it, later ones (record availability) resolve at once.
  let releaseProbe: (() => void) | undefined;
  const probeGate = new Promise<void>((resolve) => {
    releaseProbe = resolve;
  });
  let firstProbeHeld = false;
  let listing: unknown = options.listing ?? {
    configured: true,
    files: [CLIENTS_FILE],
  };
  let profile: unknown = options.profile ?? CLIENTS_PROFILE;
  // The run status the job's GET status endpoint reports (the discard poll reads
  // it); a test flips it to a terminal value to let a discard complete promptly.
  let jobStatus = "running";

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
        return Promise.resolve(
          options.profileErrorCode !== undefined
            ? jsonResponse({ error: options.profileErrorCode }, 400)
            : options.profileStatus !== undefined
              ? new Response(null, { status: options.profileStatus })
              : jsonResponse(profile),
        );
      if (url === "/api/jobs/inputs/coverage")
        return Promise.resolve(
          options.coverageStatus !== undefined
            ? new Response(null, { status: options.coverageStatus })
            : jsonResponse({ rates: [] }),
        );
      if (url === "/api/jobs/sftp")
        return Promise.resolve(
          jsonResponse(options.sftp ?? { configured: false }),
        );
      if (url === "/api/jobs/rendezvous")
        return Promise.resolve(
          jsonResponse(options.rendezvous ?? { configured: false }),
        );
      if (url === "/api/jobs")
        return Promise.resolve(
          options.conflict !== undefined
            ? jsonResponse({ id: options.conflict.jobId }, 409)
            : jsonResponse({ id: "job-7" }, 201),
        );
      if (url.endsWith("/handoff"))
        return Promise.resolve(
          options.handoff !== undefined
            ? jsonResponse(options.handoff)
            : new Response(null, { status: 404 }),
        );
      if (options.conflict !== undefined) {
        const cid = options.conflict.jobId;
        if (url === `/api/jobs/${cid}/events`)
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
        if (url === `/api/jobs/${cid}`) {
          const respond = () =>
            jsonResponse({
              status: options.conflict?.status ?? "running",
              recordAvailable: false,
            });
          if (options.conflict.holdProbe === true && !firstProbeHeld) {
            firstProbeHeld = true;
            return probeGate.then(respond);
          }
          return Promise.resolve(respond());
        }
      }
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
          jsonResponse({ status: jobStatus, recordAvailable: false }),
        );
      }
      if (url === "/api/jobs/job-7/cancel")
        return Promise.resolve(new Response(null, { status: 200 }));
      return Promise.resolve(new Response(null, { status: 404 }));
    },
  );

  return {
    captured,
    setListing: (next) => {
      listing = next;
    },
    setProfile: (next) => {
      profile = next;
    },
    setJobStatus: (next) => {
      jobStatus = next;
    },
    emitEvent: (event) =>
      sse?.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)),
    closeEvents: () => sse?.close(),
    resolveProbe: () => releaseProbe?.(),
  };
}

const app = createAppMount();

afterEach(async () => {
  // The picker and coverage seams are fetch-driven, so a resolution can
  // otherwise land exactly at unmount.
  await flushPendingUpdates();
  app.unmount();
  // A server-job run persists a strand-recovery record; clear it so the next
  // test's idle bench does not re-attach to a prior run's id.
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

/** From an already-mounted bench: fill the name, pick and confirm a file from the
 * mounted directory (the two-stage commit), then walk to Review & create. */
async function reachReviewCreate() {
  await expect.element(page.getByLabelText("Your name")).toBeInTheDocument();
  await userEvent.fill(page.getByLabelText("Your name"), "Dana Okafor");
  await page.getByRole("button", { name: "Select clients.csv" }).click();
  await page.getByRole("button", { name: "Use this file" }).click();
  await expect
    .element(
      page.getByRole("button", { name: "Continue to matching & sharing" }),
    )
    .toBeEnabled();
  await page
    .getByRole("button", { name: "Continue to matching & sharing" })
    .click();
  await page
    .getByRole("button", { name: "Continue to review & create" })
    .click();
  await expect
    .element(page.getByRole("heading", { level: 1 }))
    .toHaveTextContent("Review & create");
}

/** Open the file-handling card on Review & create. Its accessible name carries the
 * collapsed summary, so match on the label rather than the whole name. */
async function openExchangeFiles() {
  await page.getByRole("button", { name: /How files are handled/ }).click();
}

/** Turn retain mode on the way an operator does: the file-handling card on
 * Review & create, before the invitation is minted. */
async function turnRetainModeOn() {
  await openExchangeFiles();
  const retain = page.getByLabelText("Keep every exchange file");
  await retain.click();
  await expect.element(retain).toBeChecked();
}

/** State the lockless rendezvous on its own, from the same card: the operator's
 * choice for a folder a sync tool keeps in step, with retain mode left off. */
async function turnLocklessRendezvousOn() {
  await openExchangeFiles();
  const lockless = page.getByLabelText("Lockless rendezvous");
  await userEvent.selectOptions(lockless, "on");
  await expect.element(lockless).toHaveValue("on");
}

describe("console inviter file picker states", () => {
  test("an empty listing shows the no-usable-files state", async () => {
    stubJobApi({ listing: { configured: true, files: [] } });
    app.render(createElement(InviterBench));
    await expect
      .element(
        page.getByText("No usable files in the work directory", {
          exact: true,
        }),
      )
      .toBeInTheDocument();
  });

  test("an unconfigured work directory names the env var to set", async () => {
    stubJobApi({ listing: { configured: false, files: [] } });
    app.render(createElement(InviterBench));
    // An unset JOB_INPUT_DIR is a deployment-config gap, distinct from an
    // empty-but-mounted directory: name the env var, do not tell the operator to
    // place a file in a directory that is not configured.
    await expect
      .element(page.getByText("No work directory configured", { exact: true }))
      .toBeInTheDocument();
    await expect
      .element(page.getByText("Set JOB_INPUT_DIR", { exact: false }))
      .toBeInTheDocument();
    expect(
      page
        .getByText("No usable files in the work directory", { exact: true })
        .query(),
    ).toBeNull();
  });

  test("a populated listing shows the file rows", async () => {
    stubJobApi({ listing: { configured: true, files: [CLIENTS_FILE] } });
    app.render(createElement(InviterBench));
    await expect.element(page.getByText("clients.csv")).toBeInTheDocument();
  });

  test("an unreadable mount is distinct from an empty directory", async () => {
    stubJobApi({
      listing: { configured: true, readable: false, files: [] },
    });
    app.render(createElement(InviterBench));
    // A mounted-but-unreadable directory tells the operator to check the mount, not
    // to place a file that may already be there (the empty-directory copy).
    await expect
      .element(
        page.getByText("Could not read the work directory", { exact: true }),
      )
      .toBeInTheDocument();
    expect(
      page
        .getByText("No usable files in the work directory", { exact: true })
        .query(),
    ).toBeNull();
  });

  test("a profile fault names its reason instead of a generic message", async () => {
    stubJobApi({ profileErrorCode: "too_large" });
    app.render(createElement(InviterBench));
    await userEvent.fill(page.getByLabelText("Your name"), "Dana Okafor");
    await page.getByRole("button", { name: "Select clients.csv" }).click();
    await expect
      .element(
        page.getByText("This file is too large to read", { exact: true }),
      )
      .toBeInTheDocument();
  });
});

describe("console inviter two-stage pick", () => {
  test("selecting a file shows a pre-commit confirm panel with columns, rows, and samples", async () => {
    stubJobApi();
    app.render(createElement(InviterBench));
    await userEvent.fill(page.getByLabelText("Your name"), "Dana Okafor");
    await page.getByRole("button", { name: "Select clients.csv" }).click();

    // The confirm panel appears BEFORE the file becomes the bench's acquired file.
    await expect
      .element(page.getByText("Confirm this file"))
      .toBeInTheDocument();
    // The per-column sample peek shows the profiled sample values (the dob sample
    // appears only here).
    await expect.element(page.getByText("Sample values")).toBeInTheDocument();
    await expect
      .element(page.getByText("01/02/1990", { exact: false }))
      .toBeInTheDocument();

    // Committing seeds the bench: the row is marked Selected and Continue enables.
    await page.getByRole("button", { name: "Use this file" }).click();
    await expect.element(page.getByText("Selected")).toBeInTheDocument();
    await expect
      .element(
        page.getByRole("button", { name: "Continue to matching & sharing" }),
      )
      .toBeEnabled();
  });
});

describe("console inviter transports and sample data", () => {
  test("the Browser card is disabled and the sample seed is hidden", async () => {
    stubJobApi();
    app.render(createElement(InviterBench));
    // The in-place sample seed is gone; the download stays.
    await expect
      .element(page.getByRole("button", { name: "download the CSVs" }))
      .toBeInTheDocument();
    expect(
      page.getByRole("button", { name: "load it into this exchange" }).query(),
    ).toBeNull();

    await reachReviewCreate();
    const browser = page.getByLabelText("Live, in this browser");
    await expect.element(browser).toBeDisabled();
    // The disabled card names its in-tab exchange as out of scope on the appliance
    // (this phrasing is unique to the Browser card's description).
    await expect
      .element(page.getByText("the public psilink web app's domain"))
      .toBeInTheDocument();
  });

  test("with an authored connection the default transport is SFTP (run here)", async () => {
    stubJobApi({
      sftp: { configured: true, host: "sftp.example.gov", port: 2222 },
    });
    app.render(createElement(InviterBench));
    await reachReviewCreate();
    // SFTP is selected by default and shows the run-here copy plus the single
    // connection's locator as static text (no picker).
    await expect
      .element(page.getByLabelText("Over SFTP, run here"))
      .toBeChecked();
    await expect
      .element(page.getByText("Runs through", { exact: false }))
      .toBeInTheDocument();
    await expect
      .element(page.getByText("sftp.example.gov:2222", { exact: false }))
      .toBeInTheDocument();
    // No remote picker: the operator selects nothing.
    expect(page.getByLabelText("SFTP server").query()).toBeNull();
  });

  test("with a rendezvous mount and no sftp server the filedrop card runs here by default", async () => {
    stubJobApi({
      sftp: { configured: false },
      rendezvous: {
        configured: true,
        locator: "rendezvous-folder",
        folderName: "rendezvous-folder",
      },
    });
    app.render(createElement(InviterBench));
    await reachReviewCreate();
    await expect
      .element(page.getByLabelText("Over a shared directory, run here"))
      .toBeChecked();
  });

  test("with no rendezvous mount the filedrop card is disabled", async () => {
    stubJobApi({
      sftp: { configured: false },
      rendezvous: { configured: false },
    });
    app.render(createElement(InviterBench));
    await reachReviewCreate();
    await expect
      .element(
        page.getByLabelText(
          "Over a shared directory, run by the command-line tool",
        ),
      )
      .toBeDisabled();
  });
});

describe("console inviter file-handling gate", () => {
  const RUN_HERE_SFTP = {
    configured: true,
    host: "dr.example.gov",
    port: 2222,
    path: "/drops/psilink",
  };

  test("offers the whole card, including what only a composed config carries", async () => {
    stubJobApi({ sftp: RUN_HERE_SFTP });
    app.render(createElement(InviterBench));
    await reachReviewCreate();
    await openExchangeFiles();

    // The invitation flow composes a psilink.yaml, so every control reaches the
    // run as a configuration key -- the foreign-file policy included.
    await expect
      .element(page.getByLabelText("If an unrecognised file appears"))
      .toBeInTheDocument();
  });

  test("states the bilateral agreement as soon as retain mode goes on", async () => {
    stubJobApi({ sftp: RUN_HERE_SFTP });
    app.render(createElement(InviterBench));
    await reachReviewCreate();
    await openExchangeFiles();
    expect(app.container.textContent).not.toContain(
      RETAIN_MODE_BILATERAL_NOTICE,
    );

    await page.getByLabelText("Keep every exchange file").click();
    await expect
      .element(page.getByText("Both sides must set this"))
      .toBeInTheDocument();
    expect(app.container.textContent).toContain(RETAIN_MODE_BILATERAL_NOTICE);
    await expect
      .element(page.getByRole("button", { name: "Create the invitation" }))
      .toBeEnabled();
  });

  test("an inadmissible draft blocks the mint and says why", async () => {
    stubJobApi({ sftp: RUN_HERE_SFTP });
    app.render(createElement(InviterBench));
    await reachReviewCreate();
    await turnRetainModeOn();

    // Retain mode requires timestamped filenames; stating them off is a
    // combination core refuses, caught before the terms are sealed.
    await userEvent.selectOptions(
      page.getByLabelText("Timestamped filenames"),
      "off",
    );
    await expect
      .element(
        page.getByText("retain_files requires timestamp_in_filename", {
          exact: false,
        }),
      )
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Create the invitation" }))
      .toBeDisabled();
    // Shown beside the action, and voiced for a screen reader at the button.
    await expect
      .element(
        page.getByText("Resolve the file-handling settings above to continue."),
      )
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText(
          "Resolve the file-handling settings above before you can create.",
        ),
      )
      .toBeInTheDocument();
    // The terms are unsealed: the step still stands, with no invitation minted.
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Review & create");

    // Restoring the implied toggle clears the problem and the gate together.
    await userEvent.selectOptions(
      page.getByLabelText("Timestamped filenames"),
      "auto",
    );
    await expect
      .element(page.getByRole("button", { name: "Create the invitation" }))
      .toBeEnabled();
    await expect
      .element(page.getByText("Ready to create."))
      .toBeInTheDocument();
  });
});

describe("console inviter mint and run", () => {
  test("seeds from the profile and runs a job whose intent carries inputFile, not inputCsv", async () => {
    const api = stubJobApi({
      sftp: {
        configured: true,
        host: "dr.example.gov",
        port: 2222,
        path: "/drops/psilink",
      },
    });
    app.render(createElement(InviterBench));
    await reachReviewCreate();

    // The ledger/answers seeded from the profile: the file and its row count.
    await expect
      .element(page.getByText("clients.csv - 2 rows"))
      .toBeInTheDocument();

    // SFTP is the default; create routes to the live run (share screen).
    await page.getByRole("button", { name: "Create the invitation" }).click();
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Your invitation is ready");

    // A server-job run: the keep-open callout names the appliance running the
    // exchange and that leaving leaves it running (the console re-attaches), never
    // a browser listener. The whole sentence is asserted -- a substring would also
    // pass a false "leaving abandons the run" claim.
    await expect
      .element(
        page.getByText(
          "This appliance is running the exchange. If you leave this page the " +
            "run continues here; return to this console to pick it up or discard " +
            "it.",
        ),
      )
      .toBeInTheDocument();
    expect(
      page.getByText("Your browser is listening for your partner").query(),
    ).toBeNull();

    // The minted code carries the authored connection's locator, never inline
    // content.
    await page.getByRole("button", { name: "Show full code" }).click();
    const encoded = (
      document.querySelector(`.${styles.revealArea}`) as HTMLTextAreaElement
    ).value;
    const token = await decodeInvitation(encoded);
    expect(token.connectionEndpoint).toEqual({
      channel: "sftp",
      host: "dr.example.gov",
      port: 2222,
      path: "/drops/psilink",
    });

    // The run POSTs an intent carrying the mounted-file REFERENCE, not the content,
    // and no connection field (the appliance provisions the one server).
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
    expect(intent.channel).toBe("sftp");
    expect(intent.remote).toBeUndefined();
    expect(intent.inputCsv).toBeUndefined();
    expect(intent.inputFile).toEqual({ name: "clients.csv" });

    await vi.waitFor(() =>
      expect(
        api.captured.some(
          (request) => request.url === "/api/jobs/job-7/events",
        ),
      ).toBe(true),
    );
    // Advancing past the wait flips the phase to the active run; the keep-open
    // callout persists through it.
    api.emitEvent({ v: 1, type: "stage", id: "confirming protocol" });
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Exchange in progress");
    await expect
      .element(
        page.getByText(
          "This appliance is running the exchange. If you leave this page the " +
            "run continues here; return to this console to pick it up or discard " +
            "it.",
        ),
      )
      .toBeInTheDocument();

    // A relay warning (the host-key divergence notice the security review requires
    // the operator to see) surfaces in the run UI without ending the run.
    api.emitEvent({
      v: 1,
      type: "warning",
      message: "the two parties pinned different host keys for this server",
    });
    await expect
      .element(page.getByText("The exchange reported a warning"))
      .toBeInTheDocument();

    // The result completes the run on the appliance's endpoint.
    api.emitEvent({ v: 1, type: "result", resultWritten: true });
    api.closeEvents();
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Exchange complete");
  });

  test("a filedrop invitation carries the shared folder's name the console reported", async () => {
    stubJobApi({
      sftp: { configured: false },
      rendezvous: {
        configured: true,
        locator: "psilink",
        folderName: "psilink",
      },
    });
    app.render(createElement(InviterBench));
    await reachReviewCreate();
    // Filedrop is the default (a rendezvous mount, no sftp server) and runs here.
    await expect
      .element(page.getByLabelText("Over a shared directory, run here"))
      .toBeChecked();

    await page.getByRole("button", { name: "Create the invitation" }).click();
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Your invitation is ready");

    await page.getByRole("button", { name: "Show full code" }).click();
    const encoded = (
      document.querySelector(`.${styles.revealArea}`) as HTMLTextAreaElement
    ).value;
    const token = await decodeInvitation(encoded);
    // The partner-bound token discloses only the shared folder's name; no path on
    // the appliance is representable in it -- the mount is never sent to the
    // browser to begin with.
    expect(token.connectionEndpoint).toEqual({
      channel: "filedrop",
      path: "psilink",
    });
  });

  test("the coverage sweep posts the mounted-file name only", async () => {
    const api = stubJobApi();
    app.render(createElement(InviterBench));
    await userEvent.fill(page.getByLabelText("Your name"), "Dana Okafor");
    await page.getByRole("button", { name: "Select clients.csv" }).click();
    await page.getByRole("button", { name: "Use this file" }).click();
    await expect.element(page.getByText("Selected")).toBeInTheDocument();

    // The bench's coverage provider posts to the appliance sweep with the file's
    // name (the CLI reads it in place; no freshness pair, no inline content).
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
    expect(body.name).toBe("clients.csv");
    expect(body.sizeBytes).toBeUndefined();
    expect(body.modifiedAt).toBeUndefined();
  });
});

describe("console inviter never renders the recurring-save offer", () => {
  // The offer's only inviter render site is gated on the browser transport
  // (InviterBench: `transport === "browser"` on the share surface). A console build
  // disables the Browser card and never defaults to it, so the offer -- whose
  // "recurring exchanges" link targets the /saved route gated out of the console
  // build -- must never mount. Pin the mount precondition unreachable, and the panel
  // absent at the share surface and through completion -- the panel a hosted,
  // browser-transport build would show.
  test("the offer stays absent from the share surface through completion", async () => {
    const api = stubJobApi({
      sftp: { configured: true, host: "dr.example.gov", port: 2222 },
    });
    app.render(createElement(InviterBench));
    await reachReviewCreate();

    // The offer's mount precondition is unreachable: SFTP is the default and the
    // Browser card is disabled, so the transport is never browser.
    await expect
      .element(page.getByLabelText("Over SFTP, run here"))
      .toBeChecked();
    await expect
      .element(page.getByLabelText("Live, in this browser"))
      .toBeDisabled();

    await page.getByRole("button", { name: "Create the invitation" }).click();
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Your invitation is ready");
    expect(page.getByText("Save as a recurring exchange").query()).toBeNull();

    await vi.waitFor(() =>
      expect(api.captured.some((r) => r.url === "/api/jobs/job-7/events")).toBe(
        true,
      ),
    );
    api.emitEvent({ v: 1, type: "stage", id: "confirming protocol" });
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Exchange in progress");
    expect(page.getByText("Save as a recurring exchange").query()).toBeNull();

    api.emitEvent({ v: 1, type: "result", resultWritten: true });
    api.closeEvents();
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Exchange complete");
    expect(page.getByText("Save as a recurring exchange").query()).toBeNull();
  });
});

describe("console inviter run teardown and abandonment", () => {
  /** Reach a running server-job run: create the invitation (SFTP default), then
   * advance past the wait so the appliance is conducting the exchange. */
  async function reachRunningRun(
    api: ReturnType<typeof stubJobApi>,
  ): Promise<void> {
    await reachReviewCreate();
    await page.getByRole("button", { name: "Create the invitation" }).click();
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Your invitation is ready");
    await vi.waitFor(() =>
      expect(api.captured.some((r) => r.url === "/api/jobs/job-7/events")).toBe(
        true,
      ),
    );
    api.emitEvent({ v: 1, type: "stage", id: "confirming protocol" });
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Exchange in progress");
  }

  test("leaving the page does not cancel the appliance run", async () => {
    const api = stubJobApi({
      sftp: { configured: true, host: "dr.example.gov", port: 2222 },
    });
    app.render(createElement(InviterBench));
    await reachRunningRun(api);

    // Unmount stands in for a navigation / reload / tab close. It must NOT POST a
    // cancel: the appliance keeps running the exchange and the recovery panel is
    // the way back. This is the whole point of the strand-recovery change.
    app.unmount();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(api.captured.some((r) => r.url === "/api/jobs/job-7/cancel")).toBe(
      false,
    );
  });

  test("start over from a failed run discards it, freeing the slot", async () => {
    const api = stubJobApi({
      sftp: { configured: true, host: "dr.example.gov", port: 2222 },
    });
    app.render(createElement(InviterBench));
    await reachRunningRun(api);

    // A non-retryable (security) failure offers start-over; mark the job terminal
    // on the appliance so the discard DELETEs it at once.
    api.setJobStatus("failed");
    api.emitEvent({
      v: 1,
      type: "error",
      category: "security",
      message: "could not verify the partner",
    });
    api.closeEvents();
    await expect
      .element(
        page.getByRole("button", {
          name: "Start over with a fresh invitation",
        }),
      )
      .toBeInTheDocument();

    await page
      .getByRole("button", { name: "Start over with a fresh invitation" })
      .click();

    // Start over abandons the failed run: the terminal job is DELETEd (no cancel
    // needed for an already-terminal job), freeing the appliance's single slot.
    await vi.waitFor(() =>
      expect(
        api.captured.some(
          (r) => r.url === "/api/jobs/job-7" && r.method === "DELETE",
        ),
      ).toBe(true),
    );
  });

  test("try again DELETEs the failed job before re-creating so the recreate is not 409'd", async () => {
    const api = stubJobApi({
      sftp: { configured: true, host: "dr.example.gov", port: 2222 },
    });
    app.render(createElement(InviterBench));
    await reachRunningRun(api);

    // A retryable (exchange) failure offers Try again; mark the job terminal on the
    // appliance so the discard goes straight to DELETE (no cancel/poll wait).
    api.setJobStatus("failed");
    api.emitEvent({
      v: 1,
      type: "error",
      category: "exchange",
      message: "temporary connection problem",
    });
    api.closeEvents();
    await expect
      .element(page.getByRole("button", { name: "Try again" }))
      .toBeInTheDocument();

    await page.getByRole("button", { name: "Try again" }).click();

    // The retry DELETEs the terminal job before POSTing the recreate: under
    // reject-until-DELETE a create that raced the still-occupied single slot 409s,
    // so the DELETE must land first.
    await vi.waitFor(() =>
      expect(
        api.captured.filter((r) => r.url === "/api/jobs" && r.method === "POST")
          .length,
      ).toBeGreaterThanOrEqual(2),
    );
    const deleteIndex = api.captured.findIndex(
      (r) => r.url === "/api/jobs/job-7" && r.method === "DELETE",
    );
    const secondPostIndex = api.captured
      .map((r, index) => ({ r, index }))
      .filter(({ r }) => r.url === "/api/jobs" && r.method === "POST")
      .map(({ index }) => index)[1];
    expect(deleteIndex).toBeGreaterThanOrEqual(0);
    expect(deleteIndex).toBeLessThan(secondPostIndex);
  });
});

describe("console inviter picker accessibility", () => {
  test("the picker stages are real h2 headings", async () => {
    stubJobApi();
    app.render(createElement(InviterBench));
    await expect
      .element(
        page.getByRole("heading", {
          level: 2,
          name: "Choose a file from the work directory",
        }),
      )
      .toBeInTheDocument();
    await page.getByRole("button", { name: "Select clients.csv" }).click();
    await expect
      .element(
        page.getByRole("heading", { level: 2, name: "Confirm this file" }),
      )
      .toBeInTheDocument();
  });

  test("a polite status region announces the loaded listing", async () => {
    stubJobApi();
    app.render(createElement(InviterBench));
    await vi.waitFor(() => {
      const status = document.querySelector(
        '[role="status"][aria-live="polite"]',
      );
      expect(status?.textContent).toContain("Loaded 1 file");
    });
  });

  test("selecting a file moves focus to the confirm stage", async () => {
    stubJobApi();
    app.render(createElement(InviterBench));
    await page.getByRole("button", { name: "Select clients.csv" }).click();
    // The stage swap sends focus to the confirm panel so a screen-reader user is not
    // stranded on the row button that just unmounted.
    await vi.waitFor(() => {
      expect(document.activeElement?.textContent).toContain(
        "Confirm this file",
      );
    });
  });

  test("each row's Select button names its file so the names do not collide", async () => {
    stubJobApi({
      listing: {
        configured: true,
        totalEntries: 2,
        truncated: false,
        files: [
          CLIENTS_FILE,
          {
            name: "roster.csv",
            sizeBytes: 8192,
            modifiedAt: 1_700_000_500_000,
          },
        ],
      },
    });
    app.render(createElement(InviterBench));
    await expect
      .element(page.getByRole("button", { name: "Select clients.csv" }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Select roster.csv" }))
      .toBeInTheDocument();
  });
});

describe("console inviter picker re-profile", () => {
  test("re-profiling with unchanged columns keeps the draft; changed columns reset it", async () => {
    const api = stubJobApi();
    app.render(createElement(InviterBench));
    await userEvent.fill(page.getByLabelText("Your name"), "Dana Okafor");
    await page.getByRole("button", { name: "Select clients.csv" }).click();
    await page.getByRole("button", { name: "Use this file" }).click();
    await expect.element(page.getByText("Selected")).toBeInTheDocument();

    // Re-profile the same file with the same columns: the draft is preserved.
    await page.getByRole("button", { name: "Re-profile clients.csv" }).click();
    await page.getByRole("button", { name: "Use this file" }).click();
    await expect
      .element(
        page.getByText("your customizations are unchanged", { exact: false }),
      )
      .toBeInTheDocument();

    // The file's columns change under the same name: reseeded, with an explicit
    // notice that the customizations were reset.
    api.setProfile({
      ...CLIENTS_PROFILE,
      columns: ["client_id", "email"],
      columnSamples: [
        { column: "client_id", values: ["1", "2"] },
        { column: "email", values: ["a@x.gov", "b@x.gov"] },
      ],
    });
    await page.getByRole("button", { name: "Re-profile clients.csv" }).click();
    await page.getByRole("button", { name: "Use this file" }).click();
    await expect
      .element(
        page.getByText("your customizations were reset", { exact: false }),
      )
      .toBeInTheDocument();
  });

  test("a profile with a blank header cell is refused without unmounting the bench", async () => {
    stubJobApi({
      profile: {
        ...CLIENTS_PROFILE,
        columns: ["client_id", "", "dob"],
        columnSamples: [
          { column: "client_id", values: ["1", "2"] },
          { column: "", values: ["x", "y"] },
          { column: "dob", values: ["01/02/1990", "03/04/1985"] },
        ],
      },
    });
    app.render(createElement(InviterBench));
    await userEvent.fill(page.getByLabelText("Your name"), "Dana Okafor");
    await page.getByRole("button", { name: "Select clients.csv" }).click();
    await page.getByRole("button", { name: "Use this file" }).click();
    // The shared unnameable-column alert, not a bench crash from core's throwing
    // inferMetadata: the name field is still on screen.
    await expect
      .element(page.getByText("This file has an unnamed column"))
      .toBeInTheDocument();
    await expect.element(page.getByLabelText("Your name")).toBeInTheDocument();
  });
});

describe("console inviter sample-data copy", () => {
  test("links the deployment guide instead of promising a walkthrough", async () => {
    stubJobApi();
    app.render(createElement(InviterBench));
    const link = page.getByRole("link", { name: "deployment guide" });
    await expect.element(link).toBeInTheDocument();
    await expect
      .element(link)
      .toHaveAttribute(
        "href",
        "https://github.com/georgetown-mdi/jspsi/blob/main/docs/DEPLOYMENT.md",
      );
  });
});

describe("console inviter re-attaches on a busy create", () => {
  const REATTACH_HANDOFF = {
    mode: "exchange",
    channel: "sftp",
    usedKeyFile: true,
    credentialPasted: false,
    template: {
      kind: "config",
      yaml: "connection:\n  channel: sftp\n  server:\n    host: sftp.example.gov\n",
    },
  };

  test("a 409 at create re-attaches with recovery-style copy, not the busy alert", async () => {
    // The slot is occupied: the create 409s carrying the live occupant's id.
    const api = stubJobApi({
      sftp: { configured: true, host: "dr.example.gov", port: 2222 },
      conflict: { jobId: "job-live", status: "running" },
      handoff: REATTACH_HANDOFF,
    });
    app.render(createElement(InviterBench));
    await reachReviewCreate();
    await page.getByRole("button", { name: "Create the invitation" }).click();

    // The busy create re-attaches to the occupying exchange under recovery-style
    // copy instead of dead-ending on the "already running an exchange" alert.
    await expect
      .element(
        page.getByRole("heading", {
          level: 1,
          name: "An exchange started from this console is still running",
        }),
      )
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText(
          "You are back on an exchange this appliance already holds.",
        ),
      )
      .toBeInTheDocument();
    expect(
      page
        .getByText("This appliance already holds an exchange", { exact: false })
        .query(),
    ).toBeNull();

    // The one surface built for leave-and-return carries the keep-open
    // reassurance -- leaving does not stop the appliance's run.
    await expect
      .element(
        page.getByText("the exchange keeps running here", { exact: false }),
      )
      .toBeInTheDocument();
    // A re-attached run must not re-offer sharing an invitation.
    expect(
      page.getByRole("heading", { name: "Share this invitation" }).query(),
    ).toBeNull();

    // The resolved id was probed live and its event stream re-attached to, and the
    // strand-recovery record now names it (a server-created orphan becomes
    // recoverable).
    await vi.waitFor(() =>
      expect(
        api.captured.some((r) => r.url === "/api/jobs/job-live/events"),
      ).toBe(true),
    );
    expect(
      JSON.parse(
        window.localStorage.getItem("psilink-console-last-job") ?? "null",
      ),
    ).toMatchObject({ jobId: "job-live", seat: "inviter" });

    // The replay's terminal result heads the surface finished (recovery copy, not
    // the fresh-run "Exchange complete" title) yet still shows the completion
    // affordances: the results summary panel AND the recurring-run hand-off, the
    // console's graduation payoff.
    api.emitEvent({ v: 1, type: "result", resultWritten: true });
    api.closeEvents();
    await expect
      .element(
        page.getByRole("heading", {
          level: 1,
          name: "An exchange started from this console has finished",
        }),
      )
      .toBeInTheDocument();
    await expect
      .element(page.getByText("Exchange complete", { exact: false }))
      .toBeInTheDocument();
    await expect
      .element(
        page.getByRole("heading", { name: "Run this exchange on a schedule" }),
      )
      .toBeInTheDocument();
  });

  test("a busy create shows an announced reconnecting interim before the recovery view", async () => {
    // Hold the liveness probe so the reconnecting interim is observable.
    const api = stubJobApi({
      sftp: { configured: true, host: "dr.example.gov", port: 2222 },
      conflict: { jobId: "job-live", status: "running", holdProbe: true },
    });
    app.render(createElement(InviterBench));
    await reachReviewCreate();
    await page.getByRole("button", { name: "Create the invitation" }).click();

    // The moment the 409 is known -- before the probe settles -- the surface heads
    // reconnecting and announces it in a live region, killing the fresh-run flash.
    await expect
      .element(
        page.getByRole("heading", {
          level: 1,
          name: "Reconnecting to your exchange",
        }),
      )
      .toBeInTheDocument();
    await vi.waitFor(() => {
      const region = Array.from(
        document.querySelectorAll('[role="status"]'),
      ).find((el) =>
        el.textContent.includes(
          "Reconnecting to the exchange this appliance already holds",
        ),
      );
      expect(region).toBeDefined();
    });
    // No fresh-run share block flashes during the interim.
    expect(
      page.getByRole("heading", { name: "Share this invitation" }).query(),
    ).toBeNull();

    // Releasing the probe resolves the interim into the full recovery view.
    api.resolveProbe();
    await expect
      .element(
        page.getByRole("heading", {
          level: 1,
          name: "An exchange started from this console is still running",
        }),
      )
      .toBeInTheDocument();
    await vi.waitFor(() =>
      expect(
        api.captured.some((r) => r.url === "/api/jobs/job-live/events"),
      ).toBe(true),
    );
  });
});

describe("console inviter partner accept kit", () => {
  const ACCEPT_KIT_BUTTON = "Download instructions for your partner";
  const SHEET_PREFIX = "psilink-accept-instructions-";

  /** The instruction sheet the share step just wrote, once the capture has read
   * its blob back. */
  async function capturedSheet(
    downloads: ReturnType<typeof captureDownloads>,
  ): Promise<CapturedDownload> {
    await vi.waitFor(() => {
      const entry = downloads.captured.find((item) =>
        item.fileName.startsWith(SHEET_PREFIX),
      );
      expect(entry?.text.length).toBeGreaterThan(0);
    });
    return downloads.captured.find((item) =>
      item.fileName.startsWith(SHEET_PREFIX),
    ) as CapturedDownload;
  }

  test("an sftp share step writes a sheet carrying the locator, no secret, no token", async () => {
    const downloads = captureDownloads();
    try {
      stubJobApi({
        sftp: {
          configured: true,
          host: "dr.example.gov",
          port: 2222,
          path: "/drops/psilink",
        },
      });
      app.render(createElement(InviterBench));
      await reachReviewCreate();
      await page.getByRole("button", { name: "Create the invitation" }).click();
      await expect
        .element(page.getByRole("heading", { level: 1 }))
        .toHaveTextContent("Your invitation is ready");

      await page.getByRole("button", { name: ACCEPT_KIT_BUTTON }).click();
      const sheet = await capturedSheet(downloads);
      expect(sheet.fileName).toMatch(
        /^psilink-accept-instructions-\d{4}-\d{2}-\d{2}\.txt$/,
      );

      // The sheet names the same rendezvous the token carries, and the field
      // the partner fills in themselves.
      expect(sheet.text).toContain("SFTP server:    dr.example.gov:2222");
      expect(sheet.text).toContain("Directory:      /drops/psilink");
      expect(sheet.text).toContain("REPLACE_WITH_SSH_USERNAME");

      // Retain mode was left off, so nothing of it reaches the sheet.
      expect(sheet.text).not.toContain("THIS EXCHANGE KEEPS ITS FILES");
      expect(sheet.text).not.toContain("--retain-files");

      // What it must never carry: the minted secret or the token itself. The
      // partner pastes their own copy over the placeholder.
      await page.getByRole("button", { name: "Show full code" }).click();
      const encoded = (
        document.querySelector(`.${styles.revealArea}`) as HTMLTextAreaElement
      ).value;
      const token = await decodeInvitation(encoded);
      expect(sheet.text).toContain("PASTE_YOUR_INVITATION");
      expect(sheet.text).not.toContain(encoded);
      expect(sheet.text).not.toContain(token.sharedSecret);
    } finally {
      downloads.restore();
    }
  });

  test("a retain-mode share step writes the transcript disclosure and the flag", async () => {
    const downloads = captureDownloads();
    try {
      stubJobApi({
        sftp: {
          configured: true,
          host: "dr.example.gov",
          port: 2222,
          path: "/drops/psilink",
        },
      });
      app.render(createElement(InviterBench));
      await reachReviewCreate();
      await turnRetainModeOn();
      await page.getByRole("button", { name: "Create the invitation" }).click();
      await expect
        .element(page.getByRole("heading", { level: 1 }))
        .toHaveTextContent("Your invitation is ready");

      await page.getByRole("button", { name: ACCEPT_KIT_BUTTON }).click();
      const sheet = await capturedSheet(downloads);

      // The choice the operator made before the mint reaches the sheet the
      // partner reads: what the exchange leaves behind and where it stays,
      // and the partner's half of the bilateral agreement on their command.
      expect(sheet.text).toContain("THIS EXCHANGE KEEPS ITS FILES");
      expect(sheet.text).toContain(
        "The files stay in the directory the two of you meet in",
      );
      expect(sheet.text).toContain("exchange --retain-files your-file.csv");
    } finally {
      downloads.restore();
    }
  });

  test("a lockless-rendezvous share step writes the flag without retain mode", async () => {
    const downloads = captureDownloads();
    try {
      stubJobApi({
        sftp: {
          configured: true,
          host: "dr.example.gov",
          port: 2222,
          path: "/drops/psilink",
        },
      });
      app.render(createElement(InviterBench));
      await reachReviewCreate();
      await turnLocklessRendezvousOn();
      await page.getByRole("button", { name: "Create the invitation" }).click();
      await expect
        .element(page.getByRole("heading", { level: 1 }))
        .toHaveTextContent("Your invitation is ready");

      await page.getByRole("button", { name: ACCEPT_KIT_BUTTON }).click();
      const sheet = await capturedSheet(downloads);

      // The setting the run carries reaches the command the partner is told to
      // run, so following the sheet verbatim meets this exchange instead of
      // stopping at rendezvous on a mismatch.
      expect(sheet.text).toContain(
        "exchange --lockless-rendezvous your-file.csv",
      );
      // Retain mode was left off, so none of its material rides along.
      expect(sheet.text).not.toContain("THIS EXCHANGE KEEPS ITS FILES");
      expect(sheet.text).not.toContain("--retain-files");
    } finally {
      downloads.restore();
    }
  });

  test("a filedrop share step writes the folder-routing sheet with the folder name only", async () => {
    const downloads = captureDownloads();
    try {
      stubJobApi({
        sftp: { configured: false },
        rendezvous: {
          configured: true,
          locator: "psilink",
          folderName: "psilink",
        },
      });
      app.render(createElement(InviterBench));
      await reachReviewCreate();
      await page.getByRole("button", { name: "Create the invitation" }).click();
      await expect
        .element(page.getByRole("heading", { level: 1 }))
        .toHaveTextContent("Your invitation is ready");

      await page.getByRole("button", { name: ACCEPT_KIT_BUTTON }).click();
      const sheet = await capturedSheet(downloads);

      // Both routing branches: the launcher for a network drive or DFS path,
      // and the direct docker commands for a folder Docker can open.
      expect(sheet.text).toContain("A. A Windows network drive or a DFS path");
      expect(sheet.text).toContain("Start-Psilink.ps1");
      expect(sheet.text).toContain("B. A folder that syncs on this PC");
      expect(sheet.text).toContain("accept PASTE_YOUR_INVITATION");

      // The appliance's absolute rendezvous path stays off the sheet exactly as
      // it stays off the token: the shared folder's name is the whole locator.
      expect(sheet.text).toContain("Shared folder:  psilink");
      expect(sheet.text).not.toContain("/srv/exchanges");
    } finally {
      downloads.restore();
    }
  });

  test("a filedrop sheet omits the folder name the console could not report", async () => {
    const downloads = captureDownloads();
    try {
      // A console whose mount point was chosen for it and whose folder it cannot
      // name: the locator still mints, and the sheet asks for no name check.
      stubJobApi({
        sftp: { configured: false },
        rendezvous: { configured: true, locator: "rendezvous" },
      });
      app.render(createElement(InviterBench));
      await reachReviewCreate();
      await page.getByRole("button", { name: "Create the invitation" }).click();
      await expect
        .element(page.getByRole("heading", { level: 1 }))
        .toHaveTextContent("Your invitation is ready");

      await page.getByRole("button", { name: ACCEPT_KIT_BUTTON }).click();
      const sheet = await capturedSheet(downloads);

      expect(sheet.text).not.toContain("Shared folder:");
      expect(sheet.text).toContain("could not put a name to the shared folder");
      expect(sheet.text).toContain("accept PASTE_YOUR_INVITATION");
    } finally {
      downloads.restore();
    }
  });
});

describe("console inviter recurring hand-off availability", () => {
  const SHARE_HANDOFF = {
    mode: "exchange",
    channel: "sftp",
    usedKeyFile: true,
    credentialPasted: false,
    template: {
      kind: "config",
      yaml: "connection:\n  channel: sftp\n  server:\n    host: sftp.example.gov\n",
    },
  };

  test("the hand-off is reachable from job creation, collapsed until the run completes", async () => {
    const api = stubJobApi({
      sftp: { configured: true, host: "dr.example.gov", port: 2222 },
      handoff: SHARE_HANDOFF,
    });
    app.render(createElement(InviterBench));
    await reachReviewCreate();
    await page.getByRole("button", { name: "Create the invitation" }).click();
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Your invitation is ready");

    // Still on the share screen, before any protocol stage: the hand-off the
    // appliance composed at job creation is already reachable, behind a
    // collapsed disclosure so the share step still leads.
    const toggle = page.getByRole("button", {
      name: /run this on a schedule/i,
    });
    await expect.element(toggle).toBeInTheDocument();
    expect(toggle.element().getAttribute("aria-expanded")).toBe("false");
    await toggle.click();
    await expect
      .element(page.getByText("0 2 * * *", { exact: false }))
      .toBeVisible();

    // At completion it becomes the full panel under its own heading.
    await vi.waitFor(() =>
      expect(api.captured.some((r) => r.url === "/api/jobs/job-7/events")).toBe(
        true,
      ),
    );
    api.emitEvent({ v: 1, type: "result", resultWritten: true });
    api.closeEvents();
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Exchange complete");
    await expect
      .element(
        page.getByRole("heading", { name: "Run this exchange on a schedule" }),
      )
      .toBeInTheDocument();
  });
});
