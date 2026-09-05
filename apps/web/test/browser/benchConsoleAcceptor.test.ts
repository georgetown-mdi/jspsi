/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";

// Load Mantine's stylesheet so components render with their real geometry.
import "@mantine/core/styles.css";

import {
  encodeInvitation,
  endpointRequiresRetainedFiles,
  generateSharedSecret,
} from "@psilink/core";

import {
  ACCEPT_UNSUPPORTED_TITLE,
  acceptUnsupported,
} from "@exchange/acceptorModel";
import {
  SERVER_JOB_KEEP_OPEN_BODY,
  UNDESCRIBABLE_RECORD_CONFIRM_BODY,
  UNTAKEN_RECORD_CONFIRM_BODY,
} from "@exchange/RunSurface";
import {
  TERMINATED_RECORD_LEAD,
  UNDESCRIBABLE_RECORD_LEAD,
} from "@exchange/RecordDownload";
import { AcceptorScreen } from "@exchange/AcceptorScreen";
import { RETAIN_MODE_BILATERAL_NOTICE } from "@console/exchangeFilesModel";
import { SPLIT_RENDEZVOUS_RETAIN_REQUIREMENT } from "@console/filedropRendezvousChoice";

import { createAppMount, flushPendingUpdates } from "./renderApp";

import type {
  ConnectionEndpoint,
  InvitationToken,
  LinkageTerms,
} from "@psilink/core";
import type { JobHandoff } from "@jobs/handoff";

// This suite exercises the CONSOLE acceptor seat: the accurate unsupported-shape
// gate, the shared-folder confirmation, and the server-job run surface (the
// keep-open callout through a stubbed filedrop accept). The dev server has no
// rendezvous mount configured, so a WebRTC accept is out of scope on the console,
// and a single-directory file-drop accept needs JOB_RENDEZVOUS_DIR; both stop at
// review with an accurate state naming where the operator CAN run the exchange.
// The hosted acceptor journey stays pinned by acceptJourney.test.ts.

// The bench and its recovery links touch the router boundary.
vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);

vi.mock("@utils/clientConfig", () => ({
  deploymentProfile: () => "console" as const,
  isConsoleBuild: () => true,
}));

// The unsupported gate never dials.
vi.mock("@psi/rendezvous", async () =>
  (await import("./moduleMocks")).rendezvousMock(),
);

// The inviter-perspective terms the accepted invitation holds. The terms render at
// the review step for transparency even though the console cannot run the exchange.
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
    // Core's mint requires the retain declaration beside an endpoint whose shape
    // puts every connection built from it in retain mode, and refuses one beside
    // a webrtc endpoint. Read which is which from core's own predicate rather
    // than restating it per endpoint below, so these tokens are minted the way a
    // real inviter mints them.
    ...(endpointRequiresRetainedFiles(endpoint)
      ? { inviterRetainsFiles: true }
      : {}),
  };
  return encodeInvitation(token);
}

// A file-drop endpoint holding a real external locator -- the shipped shape of a
// CLI-minted shared-directory invitation. The console ignores this path and polls
// its own private per-job directory, so the run could never rendezvous; the gate must
// refuse it rather than assert a (mock-only) successful run.
const FILEDROP_ENDPOINT: ConnectionEndpoint = {
  channel: "filedrop",
  path: "/drops/psilink",
};
// The split shape of the same invitation: the inviting party's inbound and outbound
// folders. An accept runs over the mounts on THIS console rather than these paths,
// so a split accept needs the console mounted the same shape -- and the pair here
// is stated from the inviter's side, which is why neither path is shown to this seat.
const SPLIT_FILEDROP_ENDPOINT: ConnectionEndpoint = {
  channel: "filedrop",
  inboundPath: "/drops/psilink-in",
  outboundPath: "/drops/psilink-out",
};
const WEBRTC_ENDPOINT: ConnectionEndpoint = {
  channel: "webrtc",
  host: "127.0.0.1",
  port: 3000,
  path: "/api/",
};

const app = createAppMount();

afterEach(async () => {
  // The invitation decode is async, so its state update can land at unmount.
  await flushPendingUpdates();
  app.unmount();
  window.location.hash = "";
  // A server-job accept persists a strand-recovery record; clear it so the next
  // test's idle bench does not re-attach to a prior run's id.
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe("console acceptor unsupported-shape gate", () => {
  test("a single-directory filedrop is blocked when no rendezvous mount is configured", async () => {
    window.location.hash = await encodeToken(FILEDROP_ENDPOINT);
    app.render(createElement(AcceptorScreen));

    // The terms still render (transparency), but with no rendezvous mount the accurate
    // block replaces the Continue action and names the env var to set.
    await expect
      .element(page.getByText("Invitation from County Health Department"))
      .toBeInTheDocument();
    await expect
      .element(page.getByText(ACCEPT_UNSUPPORTED_TITLE))
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText(
          acceptUnsupported(FILEDROP_ENDPOINT, { configured: false })!.message,
        ),
      )
      .toBeInTheDocument();
    expect(
      page
        .getByRole("button", { name: "Continue: consent & your file" })
        .query(),
    ).toBeNull();
  });

  test("a webrtc invitation is out of scope on the console, pointing at the web app", async () => {
    window.location.hash = await encodeToken(WEBRTC_ENDPOINT);
    app.render(createElement(AcceptorScreen));

    await expect
      .element(page.getByText("Invitation from County Health Department"))
      .toBeInTheDocument();
    await expect
      .element(page.getByText(ACCEPT_UNSUPPORTED_TITLE))
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText(
          acceptUnsupported(WEBRTC_ENDPOINT, { configured: false })!.message,
        ),
      )
      .toBeInTheDocument();
    expect(
      page
        .getByRole("button", { name: "Continue: consent & your file" })
        .query(),
    ).toBeNull();
  });
});

describe("console acceptor never renders the recurring-save offer", () => {
  // The offer's only acceptor render site is gated on a webrtc endpoint reaching the
  // launched step (AcceptorScreen: `endpoint.channel === "webrtc" && launched`). A
  // console build classifies a webrtc accept as unsupported and stops it at the review
  // step, so the offer -- whose /saved link is gated out of the console build -- never
  // mounts. Pin the webrtc accept blocked at review, before the launched step, with no
  // offer panel.
  test("a webrtc invitation is blocked at review with no offer", async () => {
    window.location.hash = await encodeToken(WEBRTC_ENDPOINT);
    app.render(createElement(AcceptorScreen));

    // The unsupported block replaces the Continue action, so the flow never reaches the
    // launched step the offer needs.
    await expect
      .element(page.getByText(ACCEPT_UNSUPPORTED_TITLE))
      .toBeInTheDocument();
    expect(
      page
        .getByRole("button", { name: "Continue: consent & your file" })
        .query(),
    ).toBeNull();
    expect(page.getByText("Save as a recurring exchange").query()).toBeNull();
  });
});

// The name THIS console's own rendezvous report gives the mounted directory --
// the only value the console may show as the shared folder's name.
const APPLIANCE_FOLDER_NAME = "county-exchange";
// The two names a split-provisioned console reports for its own mounts: the
// inbound leg the partner writes into, and the outbound one this seat writes.
const APPLIANCE_INBOUND_NAME = "from-partner";
const APPLIANCE_OUTBOUND_NAME = "to-partner";

/** The split pair this console reports, named or (with `named` false) holding
 * locators only -- the launcher-chosen mount points the console cannot name. */
function splitRendezvousBody(named = true): Record<string, unknown> {
  return {
    configured: true,
    split: true,
    locator: named ? APPLIANCE_INBOUND_NAME : "inbound-mount",
    outboundLocator: named ? APPLIANCE_OUTBOUND_NAME : "outbound-mount",
    ...(named
      ? {
          folderName: APPLIANCE_INBOUND_NAME,
          outboundFolderName: APPLIANCE_OUTBOUND_NAME,
        }
      : {}),
  };
}

/** Serve the console's own rendezvous report (`body`) and an empty work directory,
 * which is all the review and consent steps read. Every other job URL 404s; anything
 * off the job API falls through to the real fetch. */
function stubRendezvousReport(body: unknown): void {
  const realFetch = window.fetch.bind(window);
  const jsonResponse = (payload: unknown) =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  vi.stubGlobal(
    "fetch",
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url === "/api/jobs/rendezvous")
        return Promise.resolve(jsonResponse(body));
      if (url === "/api/jobs/inputs")
        return Promise.resolve(jsonResponse({ configured: true, files: [] }));
      if (url.startsWith("/api/jobs"))
        return Promise.resolve(new Response(null, { status: 404 }));
      return realFetch(input, init);
    },
  );
}

// The console HERE reports a configured rendezvous mount, so a single-directory
// filedrop accept is runnable and reaches the consent step. `folderName` is reported
// only when this console can name its own mount, which is the branch the confirm
// alert turns on.
function stubRendezvousMounted(folderName?: string): void {
  stubRendezvousReport({
    configured: true,
    locator: folderName ?? "rendezvous-folder",
    ...(folderName === undefined ? {} : { folderName }),
  });
}

describe("console acceptor shared-folder confirmation", () => {
  test("names this console's own mounted folder, never the invitation's locator", async () => {
    stubRendezvousMounted(APPLIANCE_FOLDER_NAME);
    window.location.hash = await encodeToken(FILEDROP_ENDPOINT);
    app.render(createElement(AcceptorScreen));

    // With a rendezvous mount configured the accept is runnable: the Continue action
    // replaces the unsupported block. Advancing reaches the consent step.
    await page
      .getByRole("button", { name: "Continue: consent & your file" })
      .click();

    await expect
      .element(page.getByText("Confirm the shared folder"))
      .toBeInTheDocument();
    await expect
      .element(page.getByText(APPLIANCE_FOLDER_NAME, { exact: false }))
      .toBeInTheDocument();
    // The invitation's locator is the inviting console's folder name only where that
    // console could name the folder, and its launcher's mount segment where it could
    // not; this seat cannot tell the two apart, so it renders neither as a name. Held
    // as a check because a claim about what a surface never shows cannot be a comment.
    expect(page.getByText(FILEDROP_ENDPOINT.path!).query()).toBeNull();
  });

  test("asks for the same confirmation where this console cannot name its mount", async () => {
    stubRendezvousMounted();
    window.location.hash = await encodeToken(FILEDROP_ENDPOINT);
    app.render(createElement(AcceptorScreen));

    await page
      .getByRole("button", { name: "Continue: consent & your file" })
      .click();

    await expect
      .element(page.getByText("Confirm the shared folder"))
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText("Check with your partner that you are both using", {
          exact: false,
        }),
      )
      .toBeInTheDocument();
    expect(page.getByText(FILEDROP_ENDPOINT.path!).query()).toBeNull();
  });

  test("a split accept confirms BOTH folders, naming which leg is read and which written", async () => {
    stubRendezvousReport(splitRendezvousBody());
    window.location.hash = await encodeToken(SPLIT_FILEDROP_ENDPOINT);
    app.render(createElement(AcceptorScreen));

    await page
      .getByRole("button", { name: "Continue: consent & your file" })
      .click();

    // A split rendezvous has no single shared folder, so the singular confirmation
    // would ask the partner to agree on a folder that does not exist; both legs are
    // named, with the direction that tells the partner which of theirs is which.
    await expect
      .element(page.getByText("Confirm the shared folders"))
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText("reads your partner's files out of one and writes", {
          exact: false,
        }),
      )
      .toBeInTheDocument();
    const alertText = app.container.textContent;
    expect(alertText).toContain(`You read from ${APPLIANCE_INBOUND_NAME}`);
    expect(alertText).toContain(`write to ${APPLIANCE_OUTBOUND_NAME}`);
    expect(alertText).toContain("the other way round");
    // The invitation's own paths name the INVITER's folders, so this seat renders
    // neither -- the same rule the single-folder confirmation holds.
    expect(alertText).not.toContain("/drops/psilink-in");
    expect(alertText).not.toContain("/drops/psilink-out");
  });

  test("asks for the same two-folder confirmation where this console cannot name its mounts", async () => {
    stubRendezvousReport(splitRendezvousBody(false));
    window.location.hash = await encodeToken(SPLIT_FILEDROP_ENDPOINT);
    app.render(createElement(AcceptorScreen));

    await page
      .getByRole("button", { name: "Continue: consent & your file" })
      .click();

    await expect
      .element(page.getByText("Confirm the shared folders"))
      .toBeInTheDocument();
    // Both names or neither: naming one folder of a two-folder rendezvous would
    // read as though the other did not exist.
    const alertText = app.container.textContent;
    expect(alertText).toContain("the other way round");
    expect(alertText).not.toContain("You read from");
    expect(alertText).not.toContain("inbound-mount");
    expect(alertText).not.toContain("outbound-mount");
  });
});

// A profiled mounted file whose columns satisfy the invitation's linkage fields
// (first_name/last_name), so the confirm-columns verdict clears and the accept can
// launch on the console.
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

interface AcceptStubOptions {
  /** When set, `POST /api/jobs` returns a busy (409) holding this id (the slot is
   * occupied), and the id's status/events routes are served so the accept can
   * re-attach to it. `holdProbe` withholds the FIRST status GET (the liveness
   * probe) until `resolveProbe()` is called, so a test can observe the reconnecting
   * interim before the recovery view lands. */
  conflict?: { jobId: string; status?: string; holdProbe?: boolean };
  /** The body `GET /api/jobs/:id/handoff` serves (the recurring-run hand-off); a
   * 404 when unset, so the panel renders nothing. */
  handoff?: unknown;
  /** The console's rendezvous report; a single named mount when unset. A split
   * pair here is the provisioning a split filedrop accept runs over. */
  rendezvous?: unknown;
  /** The run status the job's status route reports. A discard cancels and polls a
   * job it is told is still running, so a test whose recovery must reach the
   * DELETE promptly reports a terminal one. */
  jobStatus?: string;
  /** The exchange record the job's status route reports. Unset, the body denies
   * availability under `recordUnavailable` below. */
  record?: { createdAt: string; outcome: string };
  /** Why the status route says it is withholding the record pair, for a body that
   * denies availability. The default is the console's definitive denial, which
   * is what a run that owes no record answers. */
  recordUnavailable?: string;
}

// The full same-origin job API a console server-job accept drives: a mounted
// rendezvous and work directory, the file profile, the coverage sweep, and the job
// POST plus event stream the console run reads. With `conflict` the POST returns a
// busy (409) so the accept re-attaches to the occupying exchange instead. Unmatched
// URLs fall through to the real fetch so the runner's own traffic is untouched.
function stubServerJobAccept(options: AcceptStubOptions = {}): {
  captured: Array<{ url: string; method: string }>;
  emitEvent: (event: object) => void;
  closeEvents: () => void;
  hasEventStream: () => boolean;
  resolveProbe: () => void;
} {
  const captured: Array<{ url: string; method: string }> = [];
  const realFetch = window.fetch.bind(window);
  const encoder = new TextEncoder();
  let sse: ReadableStreamDefaultController<Uint8Array> | undefined;
  // The gate the held liveness probe (conflict.holdProbe) awaits; the first status
  // GET blocks on it, later ones resolve at once.
  let releaseProbe: (() => void) | undefined;
  const probeGate = new Promise<void>((resolve) => {
    releaseProbe = resolve;
  });
  let firstProbeHeld = false;
  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  const eventStream = () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          sse = controller;
        },
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );
  vi.stubGlobal(
    "fetch",
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (!url.startsWith("/api/jobs")) return realFetch(input, init);
      captured.push({ url, method: init?.method ?? "GET" });
      if (url === "/api/jobs/rendezvous")
        return Promise.resolve(
          jsonResponse(
            options.rendezvous ?? {
              configured: true,
              locator: "rendezvous-folder",
            },
          ),
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
          return Promise.resolve(eventStream());
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
        return Promise.resolve(eventStream());
      if (url === "/api/jobs/job-7") {
        if ((init?.method ?? "GET") === "DELETE")
          return Promise.resolve(new Response(null, { status: 204 }));
        return Promise.resolve(
          jsonResponse({
            status: options.jobStatus ?? "running",
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
          }),
        );
      }
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
    resolveProbe: () => releaseProbe?.(),
  };
}

// From an already-mounted acceptor bench with a rendezvous mount: consent to the
// terms, then pick and confirm the mounted file, landing on the confirm-columns
// step that holds the launch action.
async function reachAcceptColumns() {
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

// The same walk, through the launch: "Start the exchange" fires the console job
// create.
async function reachAcceptStart() {
  await reachAcceptColumns();
  await page.getByRole("button", { name: "Start the exchange" }).click();
}

describe("console acceptor file-handling gate", () => {
  /** Reach the confirm-columns step of a runnable console accept and open the
   * file-handling card the console run holds. */
  async function openExchangeFiles() {
    await reachAcceptColumns();
    // The disclosure's accessible name holds its collapsed summary, so match on
    // the label rather than the whole name.
    await page.getByRole("button", { name: /How files are handled/ }).click();
  }

  test("offers the whole card, including what only a composed config holds", async () => {
    stubServerJobAccept();
    window.location.hash = await encodeToken(FILEDROP_ENDPOINT);
    app.render(createElement(AcceptorScreen));
    await openExchangeFiles();

    // An accept the console conducts composes a configuration document, so the
    // foreign-file policy -- a configuration-only key -- is offered here.
    await expect
      .element(page.getByLabelText("If an unrecognised file appears"))
      .toBeInTheDocument();
  });

  test("states the bilateral agreement as soon as retain mode goes on", async () => {
    stubServerJobAccept();
    window.location.hash = await encodeToken(FILEDROP_ENDPOINT);
    app.render(createElement(AcceptorScreen));
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
      .element(page.getByRole("button", { name: "Start the exchange" }))
      .toBeEnabled();
  });

  test("an inadmissible draft blocks the launch and says why", async () => {
    stubServerJobAccept();
    window.location.hash = await encodeToken(FILEDROP_ENDPOINT);
    app.render(createElement(AcceptorScreen));
    await openExchangeFiles();

    // Retain mode requires the lockless rendezvous; turning that off is a
    // combination core refuses, reported in core's words before the run.
    await page.getByLabelText("Keep every exchange file").click();
    await userEvent.selectOptions(
      page.getByLabelText("Lockless rendezvous"),
      "off",
    );
    await expect
      .element(
        page.getByText("retain_files requires lockless_rendezvous", {
          exact: false,
        }),
      )
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Start the exchange" }))
      .toBeDisabled();
    // The disabled button's reason is spoken, not only shown.
    await expect
      .element(
        page.getByText(
          "Resolve the file-handling settings above before you can start.",
        ),
      )
      .toBeInTheDocument();

    // Restoring the implied toggle clears the problem and the gate together.
    await userEvent.selectOptions(
      page.getByLabelText("Lockless rendezvous"),
      "auto",
    );
    await expect
      .element(page.getByRole("button", { name: "Start the exchange" }))
      .toBeEnabled();
  });

  test("a split rendezvous blocks the launch until retain mode is on", async () => {
    stubServerJobAccept({ rendezvous: splitRendezvousBody() });
    window.location.hash = await encodeToken(SPLIT_FILEDROP_ENDPOINT);
    app.render(createElement(AcceptorScreen));
    await reachAcceptColumns();

    // Every filedrop exchange on a split console holds the inbound/outbound
    // pair, which core refuses without retain mode: the operator meets the control
    // to turn on here rather than a job the console refuses at composition.
    await expect
      .element(page.getByRole("button", { name: "Start the exchange" }))
      .toBeDisabled();
    await expect
      .element(page.getByText(SPLIT_RENDEZVOUS_RETAIN_REQUIREMENT))
      .toBeInTheDocument();

    await page.getByRole("button", { name: /How files are handled/ }).click();
    await page.getByLabelText("Keep every exchange file").click();
    await expect
      .element(page.getByRole("button", { name: "Start the exchange" }))
      .toBeEnabled();
  });
});

describe("console acceptor server-job keep-open callout", () => {
  test("holds the callout while the console runs the accept, then clears it once the run settles", async () => {
    const api = stubServerJobAccept();
    window.location.hash = await encodeToken(FILEDROP_ENDPOINT);
    app.render(createElement(AcceptorScreen));

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
    // accept launches on the console.
    await expect
      .element(page.getByRole("heading", { name: "Confirm your columns" }))
      .toBeInTheDocument();
    await page.getByRole("button", { name: "Start the exchange" }).click();

    // The console is running the accept: the keep-open callout names the run the tab
    // is holding, the same copy the inviter's server-job run shows.
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Exchange in progress");
    await expect
      .element(page.getByText(SERVER_JOB_KEEP_OPEN_BODY))
      .toBeInTheDocument();

    // Settle the run from the console's event stream; the callout drops once results
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

describe("console acceptor re-attaches on a busy create", () => {
  const REATTACH_HANDOFF = {
    mode: "exchange",
    channel: "filedrop",
    usedKeyFile: true,
    credentialPasted: false,
    usedSigningIdentity: false,
    template: {
      kind: "config",
      yaml: "connection:\n  channel: filedrop\n  path: /mnt/rendezvous\n",
    },
  } satisfies JobHandoff;

  test("a 409 at accept re-attaches with recovery copy and shows completion affordances", async () => {
    // The slot is occupied: the accept's create 409s holding the live occupant's id.
    const api = stubServerJobAccept({
      conflict: { jobId: "job-live", status: "running" },
      handoff: REATTACH_HANDOFF,
    });
    window.location.hash = await encodeToken(FILEDROP_ENDPOINT);
    app.render(createElement(AcceptorScreen));
    await reachAcceptStart();

    // The busy create re-attaches to the occupying exchange under recovery-style
    // copy instead of a fresh-run screen.
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

    // The resolved id was probed live and its event stream re-attached to.
    await vi.waitFor(() =>
      expect(
        api.captured.some((r) => r.url === "/api/jobs/job-live/events"),
      ).toBe(true),
    );

    // The replay's terminal result heads the surface finished (recovery copy, not
    // the fresh-run "Exchange complete" title) yet still shows the completion
    // affordances: the results summary panel AND the recurring-run hand-off.
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
    // No fresh-run success heading leaks in: the only h1 is the recovery title, and
    // the "Exchange complete" summary is the panel's text, not the page heading.
    expect(
      page
        .getByRole("heading", { level: 1, name: "Exchange complete" })
        .query(),
    ).toBeNull();
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
    const api = stubServerJobAccept({
      conflict: { jobId: "job-live", status: "running", holdProbe: true },
    });
    window.location.hash = await encodeToken(FILEDROP_ENDPOINT);
    app.render(createElement(AcceptorScreen));
    await reachAcceptStart();

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
    // No fresh-run keep-open callout flashes during the interim.
    expect(page.getByText(SERVER_JOB_KEEP_OPEN_BODY).query()).toBeNull();

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

// The two messages the console's rendezvous preflight raises, in order, when the
// mount is not empty. The listing names entries the PARTNER chose: the partner syncs
// its own files into the rendezvous directory, which is exactly why the accepting
// seat -- the one launching into a mount the partner has been syncing into -- has to
// see them.
const NOT_EMPTY_LEAD =
  "the rendezvous directory /mnt/rendezvous is not empty; an exchange refuses " +
  "to start on an earlier run's files. Turn on \"Clear leftover exchange " +
  'files" and re-run. Your own input and results are not what it refuses over.';
// A partner-chosen entry name holding a literal backslash and a non-ASCII code
// point, composed RAW by the console for the console sink's single escape.
const PARTNER_ENTRY = "q1\\cohorté.csv";
const PARTNER_ENTRY_ESCAPED = "q1\\\\cohort\\xe9.csv";

describe("console acceptor run warnings", () => {
  test("puts the console's preflight warnings in front of the accepting operator", async () => {
    const api = stubServerJobAccept();
    window.location.hash = await encodeToken(FILEDROP_ENDPOINT);
    app.render(createElement(AcceptorScreen));
    await reachAcceptStart();

    await vi.waitFor(() => expect(api.hasEventStream()).toBe(true));
    api.emitEvent({ v: 1, type: "warning", message: NOT_EMPTY_LEAD });
    api.emitEvent({
      v: 1,
      type: "warning",
      message: `the rendezvous directory holds ${PARTNER_ENTRY}`,
    });

    // Both stand together, in arrival order: the second never displaces the first.
    await expect
      .element(page.getByText("The exchange reported warnings"))
      .toBeInTheDocument();
    await expect.element(page.getByText(NOT_EMPTY_LEAD)).toBeInTheDocument();

    // The partner's entry name reaches the operator escaped EXACTLY ONCE -- the sink
    // escapes, the shared renderer does not. A second pass would double the
    // backslash, so the doubled form is what pins the single pass.
    await expect
      .element(
        page.getByText(
          `the rendezvous directory holds ${PARTNER_ENTRY_ESCAPED}`,
        ),
      )
      .toBeInTheDocument();
    expect(app.container.textContent).not.toContain(PARTNER_ENTRY);
    expect(app.container.textContent).not.toContain("q1\\\\\\\\cohort");

    // A warning is not a terminal: it survives the run finishing, so it cannot be
    // scrolled away by the completion panel arriving over it.
    api.emitEvent({ v: 1, type: "result", resultWritten: true });
    api.closeEvents();
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Exchange complete");
    await expect.element(page.getByText(NOT_EMPTY_LEAD)).toBeInTheDocument();
  });

  test("keeps the warning up when the run it preceded then fails", async () => {
    const api = stubServerJobAccept();
    window.location.hash = await encodeToken(FILEDROP_ENDPOINT);
    app.render(createElement(AcceptorScreen));
    await reachAcceptStart();

    await vi.waitFor(() => expect(api.hasEventStream()).toBe(true));
    api.emitEvent({ v: 1, type: "warning", message: NOT_EMPTY_LEAD });
    await expect.element(page.getByText(NOT_EMPTY_LEAD)).toBeInTheDocument();

    // The entry guard refusing over what the preflight named is the whole story the
    // warning exists to explain, so the failure alert must not take it off screen.
    api.emitEvent({
      v: 1,
      type: "error",
      category: "exchange",
      message: "the rendezvous directory is not empty",
    });
    api.closeEvents();
    await expect
      .element(page.getByText("The exchange reported a warning"))
      .toBeInTheDocument();
    await expect.element(page.getByText(NOT_EMPTY_LEAD)).toBeInTheDocument();
  });
});

// The acceptor seat's own recoveries, each of which DELETEs the run's folder on
// the console. The record ask that decides whether they confirm is this seat's
// own -- a different call site from the inviter's, with its own enabling gate --
// so its states are driven here rather than taken on trust from the inviter's.
describe("console acceptor recoveries against the run's exchange record", () => {
  const CREATED_AT = "2026-07-08T14:32:00.000Z";
  const RECORD_STAMP = "2026-07-08T14-32-00-000Z";

  /** Accept, reach the running run, then end it in a retryable transport
   * terminal -- the failure whose recovery is Try again, which discards the run's
   * folder on the console. */
  async function acceptToExchangeFailure(
    api: ReturnType<typeof stubServerJobAccept>,
  ): Promise<void> {
    window.location.hash = await encodeToken(FILEDROP_ENDPOINT);
    app.render(createElement(AcceptorScreen));
    await reachAcceptStart();
    await vi.waitFor(() => expect(api.hasEventStream()).toBe(true));
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

  test("offers the record the console holds and confirms before destroying it", async () => {
    const api = stubServerJobAccept({
      jobStatus: "failed",
      record: { createdAt: CREATED_AT, outcome: "receipt-swap-terminated" },
    });
    await acceptToExchangeFailure(api);

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

    await page.getByRole("button", { name: "Try again" }).click();
    await expect
      .element(page.getByText(UNTAKEN_RECORD_CONFIRM_BODY))
      .toBeInTheDocument();
    expect(api.captured.some((r) => r.method === "DELETE")).toBe(false);

    await page.getByRole("button", { name: "Cancel" }).click();
    await flushPendingUpdates();
    expect(api.captured.some((r) => r.method === "DELETE")).toBe(false);
  });

  test("a record the console cannot read confirms, and links no download", async () => {
    const api = stubServerJobAccept({
      jobStatus: "failed",
      recordUnavailable: "undescribable-record",
    });
    await acceptToExchangeFailure(api);

    await expect
      .element(page.getByText(UNDESCRIBABLE_RECORD_LEAD))
      .toBeInTheDocument();
    expect(
      page
        .getByRole("link", { name: /Download record \(safe to share\)/ })
        .query(),
    ).toBeNull();

    await page.getByRole("button", { name: "Try again" }).click();
    await expect
      .element(page.getByText(UNDESCRIBABLE_RECORD_CONFIRM_BODY))
      .toBeInTheDocument();
    expect(page.getByText(UNTAKEN_RECORD_CONFIRM_BODY).query()).toBeNull();
    expect(api.captured.some((r) => r.method === "DELETE")).toBe(false);

    await page.getByRole("button", { name: "Cancel" }).click();
    await flushPendingUpdates();
    expect(api.captured.some((r) => r.method === "DELETE")).toBe(false);
  });

  test("the console's own no-record answer retries straight through", async () => {
    const api = stubServerJobAccept({ jobStatus: "failed" });
    await acceptToExchangeFailure(api);

    // Wait for the ask to have LANDED, not merely to have been sent: a recovery
    // pressed while it is in flight confirms, which is a different state.
    await expect
      .element(page.getByRole("button", { name: "Try again" }))
      .not.toHaveAttribute("aria-haspopup");
    expect(page.getByText(UNDESCRIBABLE_RECORD_LEAD).query()).toBeNull();

    await page.getByRole("button", { name: "Try again" }).click();
    expect(page.getByText(UNTAKEN_RECORD_CONFIRM_BODY).query()).toBeNull();
    await vi.waitFor(() =>
      expect(
        api.captured.some(
          (r) => r.url === "/api/jobs/job-7" && r.method === "DELETE",
        ),
      ).toBe(true),
    );
  });
});
