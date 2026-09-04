/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";

// Load Mantine's stylesheet so components render with their real geometry.
import "@mantine/core/styles.css";

import { decodeInvitation } from "@psilink/core";

import {
  NO_RECORD_CONFIRM_BODY,
  PENDING_RECORD_CONFIRM_BODY,
  UNDESCRIBABLE_RECORD_CONFIRM_BODY,
  UNKNOWN_RECORD_CONFIRM_BODY,
  UNTAKEN_RECORD_CONFIRM_BODY,
} from "@bench/BenchRunSurface";
import {
  RECORD_UNANSWERED_LEAD,
  TERMINATED_RECORD_KEYS_NOTICE,
  TERMINATED_RECORD_LEAD,
  UNDESCRIBABLE_RECORD_LEAD,
} from "@bench/RecordDownload";
import {
  SWEEP_CONFIRMATION_LABEL,
  SWEEP_CONTROL_LABEL,
} from "@bench/runDiagnosticsModel";
import { InviterBench } from "@bench/InviterBench";
import { RECEIPT_MISSING_LEAD } from "@bench/ReceiptDownload";
import { RETAIN_MODE_BILATERAL_NOTICE } from "@bench/exchangeFilesModel";
import { SPLIT_RENDEZVOUS_RETAIN_REQUIREMENT } from "@bench/filedropRendezvousChoice";
import styles from "@bench/bench.module.css";

import { createAppMount, flushPendingUpdates } from "./renderApp";
import { captureDownloads } from "./captureDownloads";

import type { CapturedDownload } from "./captureDownloads";
import type { JobHandoff } from "@jobs/handoff";

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
  /** The receipt pair the job's status route reports. Unset, the status body
   * carries neither field, which is what a run that signed nothing answers. */
  receipt?: { requested: boolean; available: boolean };
  /** The exchange record the job's status route reports. Unset, the body denies
   * availability under `recordUnavailable` below. */
  record?: { createdAt: string; outcome: string };
  /** Why the status route says it is withholding the record pair, for a body that
   * denies availability. The default is the appliance's definitive denial, which
   * is what a run that owes no record answers. */
  recordUnavailable?: string;
  /** When true the job's status route answers 503 to every GET, which is what an
   * ask that establishes NOTHING looks like from the seat: the record ask
   * exhausts its bounded re-asks and resolves `unanswered`. DELETE is unaffected,
   * so a discard the seat commits is still observable. */
  statusFault?: boolean;
  /** When true the job's status route holds every GET open until `releaseStatus()`
   * is called, which is what an ask still IN FLIGHT looks like from the seat: the
   * record ask has neither answered nor given up. DELETE is unaffected, so a
   * discard the seat commits in that window is still observable. */
  holdStatus?: boolean;
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
  releaseStatus: () => void;
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
  // The gate every held status GET (holdStatus) awaits, so a test can stand the
  // seat in the window where its record ask has been put and not yet answered.
  let releaseStatus: (() => void) | undefined;
  const statusGate = new Promise<void>((resolve) => {
    releaseStatus = resolve;
  });
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
              recordUnavailableReason: options.recordUnavailable ?? "no-record",
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
        if (options.statusFault === true)
          return Promise.resolve(new Response(null, { status: 503 }));
        const respond = () =>
          jsonResponse({
            status: jobStatus,
            ...(options.record !== undefined
              ? {
                  recordAvailable: true,
                  recordCreatedAt: options.record.createdAt,
                  recordOutcome: options.record.outcome,
                }
              : {
                  recordAvailable: false,
                  recordUnavailableReason:
                    options.recordUnavailable ?? "no-record",
                }),
            ...(options.receipt !== undefined
              ? {
                  receiptRequested: options.receipt.requested,
                  receiptAvailable: options.receipt.available,
                }
              : {}),
          });
        if (options.holdStatus === true) return statusGate.then(respond);
        return Promise.resolve(respond());
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
    releaseStatus: () => releaseStatus?.(),
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

/**
 * Drive a checkbox on an open card to `on`, from whichever state it is in.
 *
 * The click sits inside the poll rather than ahead of it because a click the
 * browser reports as delivered can leave this control in the state it started in
 * under the CPU contention of the full browser suite -- the split-rendezvous gate
 * below reddened in CI that way while every local run passed. Re-reading before
 * each click is what makes that safe: a change that has already landed ends the
 * poll instead of being toggled back, so only a delivery that did nothing is
 * retried. The intended state is the only exit, so a UI that genuinely refuses
 * the change still fails here.
 */
async function setCheckbox(label: string, on: boolean) {
  const box = page.getByLabelText(label);
  const checked = () => (box.element() as HTMLInputElement).checked;
  await expect
    .poll(
      async () => {
        if (checked() !== on) await box.click();
        return checked();
      },
      { interval: 500, timeout: 5_000 },
    )
    .toBe(on);
}

/** Drive the retain-mode checkbox on the open file-handling card to `on`. */
async function setRetainMode(on: boolean) {
  await setCheckbox("Keep every exchange file", on);
}

/** Turn retain mode on the way an operator does: the file-handling card on
 * Review & create, before the invitation is minted. */
async function turnRetainModeOn() {
  await openExchangeFiles();
  await setRetainMode(true);
}

/** State the lockless rendezvous on its own, from the same card: the operator's
 * choice for a folder a sync tool keeps in step, with retain mode left off. */
async function turnLocklessRendezvousOn() {
  await openExchangeFiles();
  const lockless = page.getByLabelText("Lockless rendezvous");
  await userEvent.selectOptions(lockless, "on");
  await expect.element(lockless).toHaveValue("on");
}

/**
 * Wait until the failure recovery labelled `label` is the straight-through form.
 *
 * A settled failed run's recoveries confirm while their record ask is in flight
 * and advertise the dialog they open, so on an appliance that answers that it
 * holds no record this waits for that answer to land: a press before it would be a
 * press on the confirming form, and would remove nothing.
 */
async function awaitStraightThroughRecovery(label: string): Promise<void> {
  await expect
    .element(page.getByRole("button", { name: label }))
    .not.toHaveAttribute("aria-haspopup");
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

describe("console inviter diagnostics gate", () => {
  const RUN_HERE_SFTP = {
    configured: true,
    host: "dr.example.gov",
    port: 2222,
    path: "/drops/psilink",
  };

  test("an unconfirmed sweep blocks the mint and names the card in both places", async () => {
    stubJobApi({ sftp: RUN_HERE_SFTP });
    app.render(createElement(InviterBench));
    await reachReviewCreate();
    await page
      .getByRole("button", { name: /Diagnostics and recovery/ })
      .click();

    // A sweep deletes what a crashed run left behind, so it runs only on the
    // operator's word that nothing else is using the directory. Asking for one
    // without giving that word is a form problem, caught before the mint.
    await setCheckbox(SWEEP_CONTROL_LABEL, true);

    await expect
      .element(page.getByRole("button", { name: "Create the invitation" }))
      .toBeDisabled();
    // Shown beside the action, and voiced for a screen reader at the button.
    await expect
      .element(
        page.getByText(
          "Resolve the diagnostics-and-recovery settings above to continue.",
        ),
      )
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText(
          "Resolve the diagnostics-and-recovery settings above before you can create.",
        ),
      )
      .toBeInTheDocument();

    await setCheckbox(SWEEP_CONFIRMATION_LABEL, true);

    await expect
      .element(page.getByRole("button", { name: "Create the invitation" }))
      .toBeEnabled();
    await expect
      .element(page.getByText("Ready to create."))
      .toBeInTheDocument();
  });
});

describe("console inviter split-rendezvous retain gate", () => {
  /** A console mounted with two rendezvous folders, both of them named. */
  const SPLIT_RENDEZVOUS = {
    configured: true,
    split: true,
    locator: "from-partner",
    folderName: "from-partner",
    outboundLocator: "to-partner",
    outboundFolderName: "to-partner",
  };

  test("a split appliance blocks Create until retain mode is on", async () => {
    stubJobApi({ sftp: { configured: false }, rendezvous: SPLIT_RENDEZVOUS });
    app.render(createElement(InviterBench));
    await reachReviewCreate();
    // The two mounts make filedrop the default transport, and retain mode starts
    // off -- the state the appliance's provisioning and the operator's own choice
    // disagree in, which the create gate holds.
    await expect
      .element(page.getByLabelText("Over a shared directory, run here"))
      .toBeChecked();
    await expect
      .element(page.getByRole("button", { name: "Create the invitation" }))
      .toBeDisabled();
    expect(app.container.textContent).toContain(
      SPLIT_RENDEZVOUS_RETAIN_REQUIREMENT,
    );

    await turnRetainModeOn();
    await expect
      .element(page.getByRole("button", { name: "Create the invitation" }))
      .toBeEnabled();
  });

  test("retain mode turned off after the transport was chosen holds the mint", async () => {
    // The ordering the gate exists for: the transport is settled on the chooser
    // and retain mode on a card below it, so the requirement can be satisfied and
    // then withdrawn. Nothing partner-facing may be minted after that -- neither
    // the endpoint nor the accept kit's disclosure -- for a rendezvous the run
    // would refuse.
    stubJobApi({ sftp: { configured: false }, rendezvous: SPLIT_RENDEZVOUS });
    app.render(createElement(InviterBench));
    await reachReviewCreate();
    await turnRetainModeOn();
    await expect
      .element(page.getByRole("button", { name: "Create the invitation" }))
      .toBeEnabled();

    await setRetainMode(false);
    await expect
      .element(page.getByLabelText("Keep every exchange file"))
      .not.toBeChecked();
    await expect
      .element(page.getByRole("button", { name: "Create the invitation" }))
      .toBeDisabled();
    expect(app.container.textContent).toContain(
      SPLIT_RENDEZVOUS_RETAIN_REQUIREMENT,
    );
    // The terms stay unsealed: no invitation was minted.
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Review & create");
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
          "This console is running the exchange. If you leave this page the " +
            "run keeps going; come back here to pick it up or discard it.",
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
          "This console is running the exchange. If you leave this page the " +
            "run keeps going; come back here to pick it up or discard it.",
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

    await awaitStraightThroughRecovery("Start over with a fresh invitation");
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

    await awaitStraightThroughRecovery("Try again");
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
    usedSigningIdentity: false,
    template: {
      kind: "config",
      yaml: "connection:\n  channel: sftp\n  server:\n    host: sftp.example.gov\n",
    },
  } satisfies JobHandoff;

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
          "You are back on an exchange this console already holds.",
        ),
      )
      .toBeInTheDocument();
    expect(
      page
        .getByText("This console already holds an exchange", { exact: false })
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
          "Reconnecting to the exchange this console already holds",
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
    usedSigningIdentity: false,
    template: {
      kind: "config",
      yaml: "connection:\n  channel: sftp\n  server:\n    host: sftp.example.gov\n",
    },
  } satisfies JobHandoff;

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

// The receipt is written once the signature swap completes, before the run's
// terminal and independently of the local writes that follow it, so the run whose
// result file was the persistence loss -- an `output` error terminal -- is
// precisely the run whose receipt may be the only third-party-verifiable artifact
// left. These pin the offer against that terminal, where a control hung off the
// completion outputs would render nothing at all.
describe("console inviter receipt on a failed run", () => {
  /** Create the invitation, reach the running run, then end it in the CLI's
   * error terminal for a lost result file. */
  async function runToOutputFailure(
    api: ReturnType<typeof stubJobApi>,
  ): Promise<void> {
    await reachReviewCreate();
    await page.getByRole("button", { name: "Create the invitation" }).click();
    await vi.waitFor(() =>
      expect(api.captured.some((r) => r.url === "/api/jobs/job-7/events")).toBe(
        true,
      ),
    );
    api.emitEvent({ v: 1, type: "stage", id: "confirming protocol" });
    api.setJobStatus("failed");
    api.emitEvent({
      v: 1,
      type: "error",
      category: "output",
      message:
        "the exchange completed but the result file could not be written",
    });
    api.closeEvents();
    await expect
      .element(page.getByText("could not be written", { exact: false }))
      .toBeInTheDocument();
  }

  test("offers the receipt the appliance holds", async () => {
    const api = stubJobApi({
      sftp: { configured: true, host: "dr.example.gov", port: 2222 },
      receipt: { requested: true, available: true },
    });
    app.render(createElement(InviterBench));
    await runToOutputFailure(api);

    // No record built on this run, so the download name falls back to the job
    // id rather than the download being withheld for want of a stamp.
    await expect
      .element(
        page.getByRole("link", {
          name: "Download signed receipt (safe to share): psilink-receipt-job-7.json",
        }),
      )
      .toBeInTheDocument();
  });

  test("states a receipt the run asked for and the appliance does not hold", async () => {
    const api = stubJobApi({
      sftp: { configured: true, host: "dr.example.gov", port: 2222 },
      receipt: { requested: true, available: false },
    });
    app.render(createElement(InviterBench));
    await runToOutputFailure(api);

    await expect
      .element(page.getByText(RECEIPT_MISSING_LEAD))
      .toBeInTheDocument();
    expect(
      page.getByRole("link", { name: /Download signed receipt/ }).query(),
    ).toBeNull();
  });
});

// A run that disclosed and then terminated reaches this seat as a FAILURE, where
// the completion downloads render nothing at all -- so the record of that
// disclosure is offered only if something asks the appliance for it. These pin the
// offer against that terminal, and pin the recovery beside it against destroying
// the record without saying so.
describe("console inviter exchange record on a terminated run", () => {
  const CREATED_AT = "2026-07-08T14:32:00.000Z";
  const RECORD_STAMP = "2026-07-08T14-32-00-000Z";

  /** Create the invitation, reach the running run, then end it in a retryable
   * transport terminal -- the failure whose recovery is Try again, which discards
   * the run's folder on the appliance. */
  async function runToExchangeFailure(
    api: ReturnType<typeof stubJobApi>,
  ): Promise<void> {
    await reachReviewCreate();
    await page.getByRole("button", { name: "Create the invitation" }).click();
    await vi.waitFor(() =>
      expect(api.captured.some((r) => r.url === "/api/jobs/job-7/events")).toBe(
        true,
      ),
    );
    api.emitEvent({ v: 1, type: "stage", id: "confirming protocol" });
    api.setJobStatus("failed");
    api.emitEvent({
      v: 1,
      type: "error",
      category: "exchange",
      message: "the exchange stopped before it finished",
    });
    api.closeEvents();
    await expect
      .element(page.getByRole("button", { name: "Try again" }))
      .toBeInTheDocument();
  }

  test("offers the record the appliance holds, stamped from its own createdAt", async () => {
    const api = stubJobApi({
      sftp: { configured: true, host: "dr.example.gov", port: 2222 },
      record: { createdAt: CREATED_AT, outcome: "receipt-swap-terminated" },
    });
    app.render(createElement(InviterBench));
    await runToExchangeFailure(api);

    await expect
      .element(page.getByText(TERMINATED_RECORD_LEAD))
      .toBeInTheDocument();
    await expect
      .element(
        page.getByRole("link", {
          name: `Download record (safe to share): psilink-record-${RECORD_STAMP}.json`,
        }),
      )
      .toBeInTheDocument();
    // The keys half is offered, and offered honestly: this run wrote no result
    // file, so there is nothing for the salts beside the record to open.
    await expect
      .element(
        page.getByRole("link", {
          name: `Download verification keys (keep private): psilink-record-${RECORD_STAMP}.keys.json`,
        }),
      )
      .toBeInTheDocument();
    await expect
      .element(page.getByText(TERMINATED_RECORD_KEYS_NOTICE))
      .toBeInTheDocument();
  });

  test("the retry confirms before it destroys the record, and cancelling keeps the run", async () => {
    const api = stubJobApi({
      sftp: { configured: true, host: "dr.example.gov", port: 2222 },
      record: { createdAt: CREATED_AT, outcome: "receipt-swap-terminated" },
    });
    app.render(createElement(InviterBench));
    await runToExchangeFailure(api);
    // Wait for the ask to land, so the press below is the confirming form.
    await expect
      .element(page.getByText(TERMINATED_RECORD_LEAD))
      .toBeInTheDocument();

    await page.getByRole("button", { name: "Try again" }).click();
    await expect
      .element(page.getByText(UNTAKEN_RECORD_CONFIRM_BODY))
      .toBeInTheDocument();
    // Nothing has been removed while the operator is still deciding.
    expect(api.captured.some((r) => r.method === "DELETE")).toBe(false);

    await page.getByRole("button", { name: "Cancel" }).click();
    await flushPendingUpdates();
    expect(api.captured.some((r) => r.method === "DELETE")).toBe(false);
    await expect
      .element(
        page.getByRole("link", { name: /Download record \(safe to share\)/ }),
      )
      .toBeInTheDocument();
  });

  test("an ask that never answered confirms too, without claiming a record", async () => {
    // The appliance stopped answering about this run, so the seat cannot say
    // whether a record is standing -- and a run that got this far may well have
    // written one. The retry DELETEs the folder either way, so it confirms on
    // the silence, under copy that claims only what the silence supports.
    const api = stubJobApi({
      sftp: { configured: true, host: "dr.example.gov", port: 2222 },
      statusFault: true,
    });
    app.render(createElement(InviterBench));
    await runToExchangeFailure(api);
    // The ask paces its bounded re-asks over several seconds; this lead is the
    // seat saying it has given up on them, which is the state under test.
    await expect
      .element(page.getByText(RECORD_UNANSWERED_LEAD), { timeout: 20_000 })
      .toBeInTheDocument();

    await page.getByRole("button", { name: "Try again" }).click();
    await expect
      .element(page.getByText(UNKNOWN_RECORD_CONFIRM_BODY))
      .toBeInTheDocument();
    // The confirm does not assert a record exists, since nothing established
    // one -- and nothing is removed while the operator is deciding.
    expect(page.getByText(UNTAKEN_RECORD_CONFIRM_BODY).query()).toBeNull();
    expect(api.captured.some((r) => r.method === "DELETE")).toBe(false);

    await page.getByRole("button", { name: "Cancel" }).click();
    await flushPendingUpdates();
    expect(api.captured.some((r) => r.method === "DELETE")).toBe(false);
    await expect
      .element(page.getByText(RECORD_UNANSWERED_LEAD))
      .toBeInTheDocument();
  }, 30_000);

  test("the retry confirms while the record ask is still in flight", async () => {
    // Between the failure alert appearing and the ask landing, the seat knows no
    // more than an exhausted ask does -- and on the failure this exists for, an
    // appliance that has stopped answering, that window is the whole of the ask's
    // bound. The retry DELETEs the folder throughout it, so it confirms, saying
    // that the asking is what has not finished.
    const api = stubJobApi({
      sftp: { configured: true, host: "dr.example.gov", port: 2222 },
      holdStatus: true,
    });
    app.render(createElement(InviterBench));
    await runToExchangeFailure(api);

    // The recovery advertises the dialog it opens, which is how this test presses
    // the confirming form without racing the ask it is holding open.
    await expect
      .element(page.getByRole("button", { name: "Try again" }))
      .toHaveAttribute("aria-haspopup", "dialog");
    await page.getByRole("button", { name: "Try again" }).click();
    await expect
      .element(page.getByText(PENDING_RECORD_CONFIRM_BODY))
      .toBeInTheDocument();
    // Neither settled account of the record is claimed: nothing has stopped
    // answering, and nothing said a record is standing.
    expect(page.getByText(UNKNOWN_RECORD_CONFIRM_BODY).query()).toBeNull();
    expect(page.getByText(UNTAKEN_RECORD_CONFIRM_BODY).query()).toBeNull();
    expect(api.captured.some((r) => r.method === "DELETE")).toBe(false);

    await page.getByRole("button", { name: "Cancel" }).click();
    await flushPendingUpdates();
    expect(api.captured.some((r) => r.method === "DELETE")).toBe(false);
    api.releaseStatus();
  });

  test("a record the appliance cannot read confirms, and links no download", async () => {
    // A data root a differently-versioned psilink wrote: a record file is in the
    // run's folder and the appliance cannot describe it, so it withholds both
    // halves of the pair. The seat must not read that denial as the absence of a
    // record -- the retry beside it removes the folder the file sits in.
    const api = stubJobApi({
      sftp: { configured: true, host: "dr.example.gov", port: 2222 },
      recordUnavailable: "undescribable-record",
    });
    app.render(createElement(InviterBench));
    await runToExchangeFailure(api);

    await expect
      .element(page.getByText(UNDESCRIBABLE_RECORD_LEAD))
      .toBeInTheDocument();
    // The routes answer 404 for a pair the appliance cannot read whole, so the
    // panel that follows the status body links neither half.
    expect(
      page
        .getByRole("link", { name: /Download record \(safe to share\)/ })
        .query(),
    ).toBeNull();
    expect(
      page.getByRole("link", { name: /Download verification keys/ }).query(),
    ).toBeNull();

    await page.getByRole("button", { name: "Try again" }).click();
    await expect
      .element(page.getByText(UNDESCRIBABLE_RECORD_CONFIRM_BODY))
      .toBeInTheDocument();
    // Not the copy that offers a download, since none is standing here.
    expect(page.getByText(UNTAKEN_RECORD_CONFIRM_BODY).query()).toBeNull();
    expect(api.captured.some((r) => r.method === "DELETE")).toBe(false);

    await page.getByRole("button", { name: "Cancel" }).click();
    await flushPendingUpdates();
    expect(api.captured.some((r) => r.method === "DELETE")).toBe(false);
    await expect
      .element(page.getByText(UNDESCRIBABLE_RECORD_LEAD))
      .toBeInTheDocument();
  });

  test("a confirm open when the ask lands states the answer instead of vanishing", async () => {
    // The ask is in flight for the first seconds of a settled failed run, so it
    // can answer while the operator is reading the confirm it opened. Unmounting
    // the dialog there would take the question off the screen mid-read and leave a
    // pressed recovery that did nothing.
    const api = stubJobApi({
      sftp: { configured: true, host: "dr.example.gov", port: 2222 },
      holdStatus: true,
    });
    app.render(createElement(InviterBench));
    await runToExchangeFailure(api);

    await expect
      .element(page.getByRole("button", { name: "Try again" }))
      .toHaveAttribute("aria-haspopup", "dialog");
    await page.getByRole("button", { name: "Try again" }).click();
    await expect
      .element(page.getByText(PENDING_RECORD_CONFIRM_BODY))
      .toBeInTheDocument();

    // The appliance answers: no record, which is the state that owes no confirm
    // at all on a fresh press.
    api.releaseStatus();
    await expect
      .element(page.getByText(NO_RECORD_CONFIRM_BODY))
      .toBeInTheDocument();
    expect(page.getByText(PENDING_RECORD_CONFIRM_BODY).query()).toBeNull();
    // The recovery is still the operator's to take or leave: the answer landing
    // does not commit the press they had not yet confirmed.
    expect(api.captured.some((r) => r.method === "DELETE")).toBe(false);

    await page.getByRole("button", { name: "Cancel" }).click();
    await flushPendingUpdates();
    expect(api.captured.some((r) => r.method === "DELETE")).toBe(false);
  });

  test("a run that failed before disclosing offers nothing and retries straight through", async () => {
    // No record is owed and none was written, so the appliance reports none: the
    // panel renders nothing, and the recovery costs the operator nothing it has
    // not already seen, so it does not interrupt them.
    const api = stubJobApi({
      sftp: { configured: true, host: "dr.example.gov", port: 2222 },
    });
    app.render(createElement(InviterBench));
    await runToExchangeFailure(api);
    // Wait for the ask to have LANDED, not merely to have been sent: an ask still
    // in flight confirms, so a press before the answer would be exercising that
    // state rather than this one.
    await awaitStraightThroughRecovery("Try again");

    expect(page.getByText(TERMINATED_RECORD_LEAD).query()).toBeNull();
    expect(
      page
        .getByRole("link", { name: /Download record \(safe to share\)/ })
        .query(),
    ).toBeNull();

    await page.getByRole("button", { name: "Try again" }).click();
    expect(page.getByText(UNTAKEN_RECORD_CONFIRM_BODY).query()).toBeNull();
    await vi.waitFor(() =>
      expect(api.captured.some((r) => r.method === "DELETE")).toBe(true),
    );
  });
});
