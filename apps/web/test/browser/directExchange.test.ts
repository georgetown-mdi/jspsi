/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";

// Load Mantine's stylesheet so components render with their real geometry.
import "@mantine/core/styles.css";

import { LINKAGE_RULE_SET_VERDICT_COPY } from "@psilink/core";

import {
  SINGLE_PASS_DISCLOSURE_BODY,
  SINGLE_PASS_DISCLOSURE_TITLE,
} from "@psi/linkageStrategyChoice";

import {
  UNDESCRIBABLE_RECORD_CONFIRM_BODY,
  UNTAKEN_RECORD_CONFIRM_BODY,
} from "@exchange/RunSurface";
import { Lobby } from "@exchange/Lobby";

import { DIRECT_LINKAGE_STRATEGY_AGREEMENT_NOTICE } from "@exchange/directExchangeModel";
import { DirectExchangeScreen } from "@exchange/DirectExchangeScreen";
import { RETAIN_MODE_BILATERAL_NOTICE } from "@console/exchangeFilesModel";
import { SPLIT_RENDEZVOUS_RETAIN_REQUIREMENT } from "@console/filedropRendezvousChoice";
import { UNDESCRIBABLE_RECORD_LEAD } from "@exchange/RecordDownload";

import { CONTROLS_ONLY_HEADER_PROFILE } from "../utils/unnamedColumnProfiles";

import { createAppMount, flushPendingUpdates } from "./renderApp";

import type { JobHandoff } from "@jobs/handoff";

// The exchange screens touch the router boundary.
vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);

// This suite exercises the CONSOLE build (the direct-exchange flow is console-only).
vi.mock("@utils/clientConfig", () => ({
  deploymentProfile: () => "console" as const,
  isConsoleBuild: () => true,
}));

// The direct flow drives no browser transport, so the rendezvous functions are
// never called.
vi.mock("@psi/transport/rendezvous", async () =>
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
  bidiStrippedColumns: [],
  dateInputFormat: "%m/%d/%Y",
  columnSamples: [
    { column: "client_id", values: ["1", "2"] },
    { column: "first_name", values: ["Ann", "Bo"] },
    { column: "last_name", values: ["Lee", "Ray"] },
    { column: "dob", values: ["01/02/1990", "03/04/1985"] },
    { column: "program_code", values: ["A", "B"] },
  ],
};

// A valid literal OpenSSH SHA256 fingerprint the host-key probe returns.
const PROBE_FINGERPRINT = `SHA256:${"B".repeat(42)}A`;

interface CapturedRequest {
  url: string;
  method: string;
  body?: string;
}

interface StubOptions {
  sftp?: unknown;
  rendezvous?: unknown;
  /** The body `GET /api/jobs/inputs/profile` serves. Defaults to
   * {@link CLIENTS_PROFILE}. */
  profile?: unknown;
  /** The run status a `GET /api/jobs/job-7` reports. Defaults to `running`; a
   * terminal value (`failed`) lets a discard skip the cancel-and-poll wait and DELETE
   * at once, so a start-over test does not sit through the 15 s discard budget. */
  jobStatus?: string;
  /** The POST /api/jobs/sftp/probe response. Defaults to a 200 ok envelope
   * holding {@link PROBE_FINGERPRINT}. */
  probe?: { status?: number; body?: unknown };
  /** When set, `POST /api/jobs` returns a busy (409) holding this id (the slot is
   * occupied), and the id's status/events routes are served so the client can
   * re-attach to it. `holdProbe` withholds the FIRST status GET (the liveness probe)
   * until `resolveProbe()` is called, so a test can observe the reconnecting interim
   * before the recovery view lands; `probeStatus` sets the HTTP status that status
   * GET returns (a 404 makes the occupant read as gone, so the re-attach falls back
   * to the busy alert). */
  conflict?: {
    jobId: string;
    status?: string;
    holdProbe?: boolean;
    probeStatus?: number;
  };
  /** The body `GET /api/jobs/:id/handoff` serves (the recurring-run hand-off); a 404
   * when unset, so the panel renders nothing. */
  handoff?: unknown;
  /** The exchange record the job's status route reports. Unset, the body denies
   * availability under `recordUnavailable` below. */
  record?: { createdAt: string; outcome: string };
  /** Why the status route says it is withholding the record pair, for a body that
   * denies availability. The default is the console's definitive denial, which
   * is what a run that owes no record answers. */
  recordUnavailable?: string;
}

/** The same-origin job API, stubbed at the global fetch boundary. Unmatched URLs fall
 * through to the real fetch. */
function stubJobApi(options: StubOptions = {}): {
  captured: Array<CapturedRequest>;
  emitEvent: (event: object) => void;
  closeEvents: () => void;
  resolveProbe: () => void;
} {
  const captured: Array<CapturedRequest> = [];
  const encoder = new TextEncoder();
  let sse: ReadableStreamDefaultController<Uint8Array> | undefined;
  const realFetch = window.fetch.bind(window);
  // The gate the held liveness probe (conflict.holdProbe) awaits; the first status
  // GET blocks on it, later ones (record availability) resolve at once.
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
        return Promise.resolve(
          jsonResponse(options.profile ?? CLIENTS_PROFILE),
        );
      if (url === "/api/jobs/sftp/probe") {
        const probe = options.probe ?? {
          status: 200,
          body: {
            status: "ok",
            fingerprint: PROBE_FINGERPRINT,
            keyType: "ssh-ed25519",
          },
        };
        return Promise.resolve(
          jsonResponse(probe.body ?? {}, probe.status ?? 200),
        );
      }
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
          if (options.conflict.probeStatus !== undefined)
            return Promise.resolve(
              new Response(null, { status: options.conflict.probeStatus }),
            );
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
        return Promise.resolve(new Response(null, { status: 202 }));
      return Promise.resolve(new Response(null, { status: 404 }));
    },
  );

  return {
    captured,
    emitEvent: (event) =>
      sse?.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)),
    closeEvents: () => sse?.close(),
    resolveProbe: () => releaseProbe?.(),
  };
}

const CONFIGURED_SFTP = {
  configured: true,
  host: "sftp.example.gov",
  port: 2222,
};

const app = createAppMount();

afterEach(async () => {
  await flushPendingUpdates();
  app.unmount();
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
    app.render(createElement(DirectExchangeScreen));
    await reachConfirm();

    // The browser-side terms preview renders under the direct-exchange framing: the
    // accurate heading and intro, NOT the invitation flow's false "Exchange proposal"
    // heading or its partner review-and-consent claim (there is no invitation here).
    await expect
      .element(page.getByRole("heading", { name: "Terms your file produces" }))
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText("no invitation for your partner to review", {
          exact: false,
        }),
      )
      .toBeInTheDocument();
    expect(app.container.textContent).not.toContain("Exchange proposal");
    expect(app.container.textContent).not.toContain("must review and consent");

    // The inferred terms cite the built-in rule set, and here the citation is the
    // operator's OWN word: no partner has been contacted, so the acceptor's
    // partner-attribution caveat must not ride along with the names. The rules are
    // inferred from the file and so drawn from the set they cite, which is what
    // leaves the disproved-citation warning off this preview too.
    expect(app.container.textContent).toContain("Linkage rule set");
    expect(app.container.textContent).not.toContain(
      LINKAGE_RULE_SET_VERDICT_COPY.unchecked.note,
    );
    expect(app.container.textContent).not.toContain(
      LINKAGE_RULE_SET_VERDICT_COPY.contradicted.note,
    );

    // The two fixed symmetry notices frame the preview.
    await expect
      .element(
        page.getByText("Your partner runs the same step", { exact: false }),
      )
      .toBeInTheDocument();
    // The disclosure record is shown positively.
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
    // The strategy is left at the CLI's own default, which a zero-setup run
    // selects by including no flag at all.
    expect(intent.linkageStrategy).toBeUndefined();
    expect(intent.sharedSecret).toBeUndefined();
    expect(intent.linkageTerms).toBeUndefined();
    expect(intent.remote).toBeUndefined();

    // The run advances through the console's event stream to completion.
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

  test("a header the strip emptied is refused by that cause, notice beside it", async () => {
    // The committed profile is the body the console's own parse returns for a
    // header whose middle column is only direction characters
    // (unnamedColumnProfiles). The refusal drops the file, so the confirm screen
    // that otherwise states the removal is never reached: the file step states it
    // beside the refusal, which names the removal rather than a trailing comma.
    stubJobApi({
      sftp: CONFIGURED_SFTP,
      profile: { ...CLIENTS_PROFILE, ...CONTROLS_ONLY_HEADER_PROFILE },
    });
    app.render(createElement(DirectExchangeScreen));
    await page.getByRole("button", { name: "Select clients.csv" }).click();
    await page.getByRole("button", { name: "Use this file" }).click();

    await expect
      .element(page.getByText("This file has an unnamed column"))
      .toBeInTheDocument();
    await expect
      .element(page.getByText("That name held nothing but", { exact: false }))
      .toBeInTheDocument();
    await expect
      .element(page.getByText("trailing comma", { exact: false }))
      .not.toBeInTheDocument();
    await expect
      .element(
        page.getByText("A formatting character was removed from a column name"),
      )
      .toBeInTheDocument();
    // The refused file did not commit: the spine stays on its file step.
    await expect
      .element(page.getByRole("heading", { level: 1, name: "Your file" }))
      .toBeInTheDocument();
  });

  test("names the header positions the console's parse stripped", async () => {
    // The console reads the file on the server, so the positions ride the
    // profile; this spine states them on the confirm screen, the last one before
    // the run, since the file step it came through does not outlive the choice.
    // Positions only -- echoing the header would put the removed characters back
    // into the notice.
    stubJobApi({
      sftp: CONFIGURED_SFTP,
      profile: { ...CLIENTS_PROFILE, bidiStrippedColumns: [2, 5] },
    });
    app.render(createElement(DirectExchangeScreen));
    await reachConfirm();

    await expect
      .element(
        page.getByText("Formatting characters removed from column names"),
      )
      .toBeInTheDocument();
    await expect
      .element(page.getByText("Columns 2, 5", { exact: false }))
      .toBeInTheDocument();
    // A notice, not a refusal: the run is still reachable behind its affirmation.
    await page.getByRole("checkbox").click();
    await expect
      .element(page.getByRole("button", { name: "Run the exchange" }))
      .toBeEnabled();
  });

  test("a terms mismatch shows clearly through the job-error path", async () => {
    const api = stubJobApi({ sftp: CONFIGURED_SFTP });
    app.render(createElement(DirectExchangeScreen));
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

  test("Start over after a terminal failure frees the slot and re-enables Run", async () => {
    const api = stubJobApi({ sftp: CONFIGURED_SFTP, jobStatus: "failed" });
    app.render(createElement(DirectExchangeScreen));
    await reachConfirm();
    await page.getByRole("checkbox").click();
    await page.getByRole("button", { name: "Run the exchange" }).click();

    await vi.waitFor(() =>
      expect(api.captured.some((r) => r.url === "/api/jobs/job-7/events")).toBe(
        true,
      ),
    );
    // A terms mismatch is a terminal, non-retryable (config) failure: the alert
    // offers Start over, not Try again.
    api.emitEvent({
      v: 1,
      type: "error",
      category: "config",
      message: "linkage terms do not match the partner's inferred terms",
    });
    api.closeEvents();
    await expect
      .element(page.getByRole("button", { name: "Start over" }))
      .toBeInTheDocument();

    // A settled failed run confirms this recovery until its record ask lands, and
    // advertises the dialog while it does. This console answers that it holds no
    // record, so the wait is for that answer -- pressing ahead of it would be
    // pressing the confirming form.
    await expect
      .element(page.getByRole("button", { name: "Start over" }))
      .not.toHaveAttribute("aria-haspopup");
    await page.getByRole("button", { name: "Start over" }).click();

    // Start over returns to the file step AND discards the failed job, freeing the
    // console's single slot (a DELETE of the occupying job).
    await expect
      .element(page.getByRole("heading", { level: 1, name: "Your file" }))
      .toBeInTheDocument();
    await vi.waitFor(() =>
      expect(
        api.captured.some(
          (r) => r.url === "/api/jobs/job-7" && r.method === "DELETE",
        ),
      ).toBe(true),
    );

    const postsBefore = api.captured.filter(
      (r) => r.url === "/api/jobs" && r.method === "POST",
    ).length;
    await page.getByRole("button", { name: "Re-profile clients.csv" }).click();
    await page.getByRole("button", { name: "Use this file" }).click();
    await page
      .getByRole("button", { name: "Continue to confirm and run" })
      .click();
    await expect
      .element(page.getByRole("heading", { level: 1, name: "Confirm and run" }))
      .toBeInTheDocument();
    await page.getByRole("checkbox").click();
    await expect
      .element(page.getByRole("button", { name: "Run the exchange" }))
      .toBeEnabled();
    await page.getByRole("button", { name: "Run the exchange" }).click();
    await vi.waitFor(() =>
      expect(
        api.captured.filter((r) => r.url === "/api/jobs" && r.method === "POST")
          .length,
      ).toBe(postsBefore + 1),
    );
  });

  test("an invalid identity names the fault at the field and blocks Run", async () => {
    stubJobApi({ sftp: CONFIGURED_SFTP });
    app.render(createElement(DirectExchangeScreen));
    await reachConfirm();
    // Affirm first, so the identity guard is the only thing gating Run.
    await page.getByRole("checkbox").click();
    await expect
      .element(page.getByRole("button", { name: "Run the exchange" }))
      .toBeEnabled();

    // A leading-dash label is refused inline (the intent schema would 400 it, which
    // failureFor would misattribute to the file/SFTP destination) and Run is disabled.
    await userEvent.fill(
      page.getByLabelText("Your identity (optional)"),
      "-county",
    );
    await expect
      .element(page.getByText("Identity cannot begin with a dash"))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Run the exchange" }))
      .toBeDisabled();

    // Correcting it clears the error and re-enables Run.
    await userEvent.fill(
      page.getByLabelText("Your identity (optional)"),
      "county-health",
    );
    await expect
      .element(page.getByRole("button", { name: "Run the exchange" }))
      .toBeEnabled();
    expect(app.container.textContent).not.toContain(
      "Identity cannot begin with a dash",
    );
  });

  test("single-pass discloses its tradeoff, reshapes the preview, and rides the run", async () => {
    const api = stubJobApi({ sftp: CONFIGURED_SFTP });
    app.render(createElement(DirectExchangeScreen));
    await reachConfirm();

    // The default is the CLI's, and it raises no disclosure of its own.
    await expect
      .element(page.getByRole("radio", { name: "Cascade" }))
      .toBeChecked();
    expect(app.container.textContent).not.toContain(
      SINGLE_PASS_DISCLOSURE_TITLE,
    );
    // Both parties infer their own terms here, so the screen says the choice has
    // to be the same on both sides.
    expect(app.container.textContent).toContain(
      DIRECT_LINKAGE_STRATEGY_AGREEMENT_NOTICE,
    );

    await page.getByRole("radio", { name: "Single-pass" }).click();
    await expect
      .element(page.getByText(SINGLE_PASS_DISCLOSURE_TITLE))
      .toBeInTheDocument();
    expect(app.container.textContent).toContain(SINGLE_PASS_DISCLOSURE_BODY);
    // The preview is the terms the run uses, so the terms panel exposes the
    // strategy too rather than showing the cascade the run does not use.
    expect(app.container.textContent).toContain(
      "This exchange matches in a single pass",
    );

    await page.getByRole("checkbox").click();
    await page.getByRole("button", { name: "Run the exchange" }).click();
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
    expect(intent.linkageStrategy).toBe("single-pass");
  });
});

describe("console direct re-attaches on a busy create", () => {
  const REATTACH_HANDOFF = {
    mode: "zeroSetup",
    channel: "sftp",
    usedKeyFile: false,
    credentialPasted: false,
    usedSigningIdentity: false,
    template: {
      kind: "command",
      argv: ["psilink", "exchange", "clients.csv", "results.csv"],
    },
  } satisfies JobHandoff;

  test("a 409 at run re-attaches with recovery copy, not the busy alert", async () => {
    // The slot is occupied: the create 409s holding the live occupant's id.
    const api = stubJobApi({
      sftp: CONFIGURED_SFTP,
      conflict: { jobId: "job-live", status: "running" },
      handoff: REATTACH_HANDOFF,
    });
    app.render(createElement(DirectExchangeScreen));
    await reachConfirm();
    await page.getByRole("checkbox").click();
    await page.getByRole("button", { name: "Run the exchange" }).click();

    // The busy create re-attaches to the occupying exchange under recovery-style
    // copy instead of dead-ending on the "already running an exchange" busy alert.
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
        .getByText("This console is already running an exchange", {
          exact: false,
        })
        .query(),
    ).toBeNull();

    // The resolved id was probed live and its event stream re-attached to, and the
    // strand-recovery record now names it (a server-created orphan becomes
    // recoverable). Direct's symmetric run rides the inviter seat.
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
      sftp: CONFIGURED_SFTP,
      conflict: { jobId: "job-live", status: "running", holdProbe: true },
    });
    app.render(createElement(DirectExchangeScreen));
    await reachConfirm();
    await page.getByRole("checkbox").click();
    await page.getByRole("button", { name: "Run the exchange" }).click();

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
    // No fresh-run keep-open framing flashes during the interim.
    expect(page.getByText("Keep this tab open.").query()).toBeNull();

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

  test("falls back to the busy alert when the occupant is not live", async () => {
    // The 409 names an occupant, but the liveness probe 404s (gone): no live
    // exchange to re-attach to, so the surface falls back to today's busy alert.
    stubJobApi({
      sftp: CONFIGURED_SFTP,
      conflict: { jobId: "job-live", probeStatus: 404 },
    });
    app.render(createElement(DirectExchangeScreen));
    await reachConfirm();
    await page.getByRole("checkbox").click();
    await page.getByRole("button", { name: "Run the exchange" }).click();

    await expect
      .element(page.getByText("This console is already running an exchange"))
      .toBeInTheDocument();
    // No recovery framing: the fallback is the plain busy alert, not the re-attach
    // view.
    expect(
      page
        .getByText("You are back on an exchange this console already holds.")
        .query(),
    ).toBeNull();
  });
});

describe("direct exchange transport step", () => {
  test("with no rendezvous mount the shared-directory option is disabled", async () => {
    stubJobApi({ sftp: CONFIGURED_SFTP, rendezvous: { configured: false } });
    app.render(createElement(DirectExchangeScreen));
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

  test("names the shared directory the console reported a name for", async () => {
    stubJobApi({
      sftp: { configured: false },
      rendezvous: {
        configured: true,
        locator: "agency-a-agency-b",
        folderName: "agency-a-agency-b",
      },
    });
    app.render(createElement(DirectExchangeScreen));
    await page.getByRole("button", { name: "Select clients.csv" }).click();
    await page.getByRole("button", { name: "Use this file" }).click();
    await page
      .getByRole("radio", { name: "A shared directory", exact: false })
      .click();
    await expect
      .element(page.getByText("agency-a-agency-b", { exact: false }))
      .toBeInTheDocument();
  });

  test("names no shared directory where the console could not name one", async () => {
    // The mount point a launcher chose is not the folder's name, so the line
    // says only that the exchange runs through the mounted directory.
    stubJobApi({
      sftp: { configured: false },
      rendezvous: { configured: true, locator: "rendezvous" },
    });
    app.render(createElement(DirectExchangeScreen));
    await page.getByRole("button", { name: "Select clients.csv" }).click();
    await page.getByRole("button", { name: "Use this file" }).click();
    await page
      .getByRole("radio", { name: "A shared directory", exact: false })
      .click();
    await expect
      .element(
        page.getByText("Runs through the shared directory mounted on this"),
      )
      .toBeInTheDocument();
    expect(page.getByText("rendezvous", { exact: true }).query()).toBeNull();
  });

  test("a split rendezvous holds Continue until retain mode is on", async () => {
    // The mounts and the retain choice are settled on separate cards of this one
    // step, so the precondition is re-asked at its exit rather than inside a card
    // the operator has already left.
    stubJobApi({
      sftp: { configured: false },
      rendezvous: {
        configured: true,
        split: true,
        locator: "from-partner",
        folderName: "from-partner",
        outboundLocator: "to-partner",
        outboundFolderName: "to-partner",
      },
    });
    app.render(createElement(DirectExchangeScreen));
    await page.getByRole("button", { name: "Select clients.csv" }).click();
    await page.getByRole("button", { name: "Use this file" }).click();
    await page
      .getByRole("radio", { name: "A shared directory", exact: false })
      .click();
    await expect
      .element(
        page.getByRole("button", { name: "Continue to confirm and run" }),
      )
      .toBeDisabled();
    // Stated in full beside the cards, and the sentence at the button names which
    // of them to go back to.
    expect(app.container.textContent).toContain(
      SPLIT_RENDEZVOUS_RETAIN_REQUIREMENT,
    );
    await expect
      .element(
        page.getByText(
          "Resolve the retain-mode requirement above to continue.",
        ),
      )
      .toBeInTheDocument();

    await page.getByRole("button", { name: /How files are handled/ }).click();
    await page.getByLabelText("Keep every exchange file").click();
    await expect
      .element(
        page.getByRole("button", { name: "Continue to confirm and run" }),
      )
      .toBeEnabled();
  });
});

describe("direct exchange file-handling gate", () => {
  /** Reach the agreed-server step (SFTP is configured, so it is selected) and open
   * the file-handling card the way an operator does. */
  async function openExchangeFiles() {
    await page.getByRole("button", { name: "Select clients.csv" }).click();
    await page.getByRole("button", { name: "Use this file" }).click();
    await expect
      .element(
        page.getByRole("heading", { level: 1, name: "The agreed server" }),
      )
      .toBeInTheDocument();
    // The disclosure's accessible name has its collapsed summary, so match on
    // the label rather than the whole name.
    await page.getByRole("button", { name: /How files are handled/ }).click();
  }

  test("withholds the control a zero-setup command line cannot hold", async () => {
    stubJobApi({ sftp: CONFIGURED_SFTP });
    app.render(createElement(DirectExchangeScreen));
    await openExchangeFiles();

    // The direct flow composes no configuration document, and `unexpected_files`
    // has no CLI flag, so the card offers every control that rides the command
    // line and not the one that does not.
    await expect
      .element(page.getByLabelText("Timestamped filenames"))
      .toBeInTheDocument();
    await expect
      .element(page.getByLabelText("Lockless rendezvous"))
      .toBeInTheDocument();
    expect(
      page.getByLabelText("If an unrecognised file appears").query(),
    ).toBeNull();
  });

  test("states the bilateral agreement as soon as retain mode goes on", async () => {
    stubJobApi({ sftp: CONFIGURED_SFTP });
    app.render(createElement(DirectExchangeScreen));
    await openExchangeFiles();
    expect(app.container.textContent).not.toContain(
      RETAIN_MODE_BILATERAL_NOTICE,
    );

    await page.getByLabelText("Keep every exchange file").click();

    // Stated while the operator can still act on it -- by telling their partner --
    // rather than after the two sides fail to meet.
    await expect
      .element(page.getByText("Both sides must set this"))
      .toBeInTheDocument();
    expect(app.container.textContent).toContain(RETAIN_MODE_BILATERAL_NOTICE);
    // Retain mode alone is admissible: the notice is not a blocked state.
    await expect
      .element(
        page.getByRole("button", { name: "Continue to confirm and run" }),
      )
      .toBeEnabled();
  });

  test("an inadmissible draft blocks Continue, in core's own words", async () => {
    stubJobApi({ sftp: CONFIGURED_SFTP });
    app.render(createElement(DirectExchangeScreen));
    await openExchangeFiles();

    // A party name needs timestamped filenames, which core requires and the card
    // reports before the run rather than after a failed job.
    await userEvent.fill(page.getByLabelText("Name for this side"), "clinic-a");
    await expect
      .element(page.getByText("These settings cannot be used together"))
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText("peer_id requires timestamp_in_filename", {
          exact: false,
        }),
      )
      .toBeInTheDocument();
    await expect
      .element(
        page.getByRole("button", { name: "Continue to confirm and run" }),
      )
      .toBeDisabled();

    // Satisfying core's dependency clears the problem and the gate together.
    await userEvent.selectOptions(
      page.getByLabelText("Timestamped filenames"),
      "on",
    );
    await expect
      .element(
        page.getByRole("button", { name: "Continue to confirm and run" }),
      )
      .toBeEnabled();
    expect(
      page.getByText("These settings cannot be used together").query(),
    ).toBeNull();
  });
});

describe("direct exchange host-key probe (direct ceremony)", () => {
  /** Reach the agreed-server step with SFTP unconfigured, then open the authoring
   * form and fill host + username so the probe can run. */
  async function openDirectServerForm() {
    await page.getByRole("button", { name: "Select clients.csv" }).click();
    await page.getByRole("button", { name: "Use this file" }).click();
    await expect
      .element(
        page.getByRole("heading", { level: 1, name: "The agreed server" }),
      )
      .toBeInTheDocument();
    await page.getByRole("button", { name: "Add connection" }).click();
    await userEvent.fill(
      page.getByLabelText("SFTP server address"),
      "sftp.agreed.example",
    );
    await userEvent.fill(page.getByLabelText("Username"), "linkage");
  }

  test("the interstitial and out-of-band affirmation gate the fill", async () => {
    // SFTP unconfigured so the authoring form (with its probe) is reachable.
    stubJobApi({ sftp: { configured: false } });
    app.render(createElement(DirectExchangeScreen));
    await openDirectServerForm();

    await page
      .getByRole("button", { name: "Read the fingerprint from the server" })
      .click();
    await expect
      .element(page.getByText("The server presented this fingerprint"))
      .toBeInTheDocument();
    // The heavier Direct ceremony: an alert-weight interstitial naming the host key
    // as the only protection (a body phrase unique to the interstitial).
    await expect
      .element(
        page.getByText("no shared secret and no separate encryption", {
          exact: false,
        }),
      )
      .toBeInTheDocument();

    // Fill is gated behind the out-of-band affirmation checkbox.
    const useButton = page.getByRole("button", {
      name: "Use this fingerprint",
    });
    await expect.element(useButton).toBeDisabled();
    await page
      .getByRole("checkbox", {
        name: "I checked this fingerprint against a source other than this connection",
      })
      .click();
    await expect.element(useButton).toBeEnabled();
    await useButton.click();
    await expect
      .element(page.getByLabelText("Server identity fingerprint"))
      .toHaveValue(PROBE_FINGERPRINT);
  });
});

// The Direct seat's own recoveries, which DELETE the run's folder on the
// console. The record ask behind them is this seat's own call site, with its own
// enabling gate, so its states are driven here rather than inferred from the
// invitation seats'.
describe("direct-exchange recoveries against the run's exchange record", () => {
  const CREATED_AT = "2026-07-08T14:32:00.000Z";
  const RECORD_STAMP = "2026-07-08T14-32-00-000Z";

  /** Run the direct exchange and end it in a terms-mismatch (config) terminal --
   * a non-retryable failure whose recovery is Start over, which discards the run's
   * folder on the console. */
  async function runToConfigFailure(
    api: ReturnType<typeof stubJobApi>,
  ): Promise<void> {
    app.render(createElement(DirectExchangeScreen));
    await reachConfirm();
    await page.getByRole("checkbox").click();
    await page.getByRole("button", { name: "Run the exchange" }).click();
    await vi.waitFor(() =>
      expect(api.captured.some((r) => r.url === "/api/jobs/job-7/events")).toBe(
        true,
      ),
    );
    api.emitEvent({
      v: 1,
      type: "error",
      category: "config",
      message: "linkage terms do not match the partner's inferred terms",
    });
    api.closeEvents();
    await expect
      .element(page.getByRole("button", { name: "Start over" }))
      .toBeInTheDocument();
  }

  test("offers the record the console holds and confirms before destroying it", async () => {
    const api = stubJobApi({
      sftp: CONFIGURED_SFTP,
      jobStatus: "failed",
      record: { createdAt: CREATED_AT, outcome: "receipt-swap-terminated" },
    });
    await runToConfigFailure(api);

    await expect
      .element(
        page.getByRole("link", {
          name: `Download record (safe to share): psilink-record-${RECORD_STAMP}.json`,
        }),
      )
      .toBeInTheDocument();

    await page.getByRole("button", { name: "Start over" }).click();
    await expect
      .element(page.getByText(UNTAKEN_RECORD_CONFIRM_BODY))
      .toBeInTheDocument();
    expect(api.captured.some((r) => r.method === "DELETE")).toBe(false);

    await page.getByRole("button", { name: "Cancel" }).click();
    await flushPendingUpdates();
    expect(api.captured.some((r) => r.method === "DELETE")).toBe(false);
  });

  test("a record the console cannot read confirms, and links no download", async () => {
    const api = stubJobApi({
      sftp: CONFIGURED_SFTP,
      jobStatus: "failed",
      recordUnavailable: "undescribable-record",
    });
    await runToConfigFailure(api);

    await expect
      .element(page.getByText(UNDESCRIBABLE_RECORD_LEAD))
      .toBeInTheDocument();
    expect(
      page
        .getByRole("link", { name: /Download record \(safe to share\)/ })
        .query(),
    ).toBeNull();

    await page.getByRole("button", { name: "Start over" }).click();
    await expect
      .element(page.getByText(UNDESCRIBABLE_RECORD_CONFIRM_BODY))
      .toBeInTheDocument();
    expect(page.getByText(UNTAKEN_RECORD_CONFIRM_BODY).query()).toBeNull();
    expect(api.captured.some((r) => r.method === "DELETE")).toBe(false);

    await page.getByRole("button", { name: "Cancel" }).click();
    await flushPendingUpdates();
    expect(api.captured.some((r) => r.method === "DELETE")).toBe(false);
  });
});

describe("console lobby direct-exchange card", () => {
  test("offers a third card that links to the direct-exchange route", async () => {
    stubJobApi();
    app.render(createElement(Lobby));
    const link = page.getByRole("link", { name: "Run a direct exchange" });
    await expect.element(link).toBeInTheDocument();
    await expect.element(link).toHaveAttribute("href", "/direct");
  });
});

describe("console lobby recurring-exchange surface", () => {
  test("offers no /saved recurring-exchange pointer", async () => {
    stubJobApi();
    app.render(createElement(Lobby));
    // The lobby is fully rendered once its heading is present; the recurring
    // pointer is not a console concept, so neither framing nor the /saved link
    // stands.
    await expect
      .element(
        page.getByRole("heading", {
          name: "psilink - private record linkage",
        }),
      )
      .toBeInTheDocument();
    expect(
      page.getByRole("link", { name: "Recurring exchanges" }).query(),
    ).toBeNull();
    expect(
      page
        .getByText("Saved an exchange to run again?", { exact: false })
        .query(),
    ).toBeNull();
    expect(
      page.getByText("Cleared this browser", { exact: false }).query(),
    ).toBeNull();
  });
});
