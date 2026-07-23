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
  /** The run status a `GET /api/jobs/job-7` reports. Defaults to `running`; a
   * terminal value (`failed`) lets a discard skip the cancel-and-poll wait and DELETE
   * at once, so a start-over test does not sit through the 15 s discard budget. */
  jobStatus?: string;
  /** The POST /api/jobs/sftp/probe response. Defaults to a 200 ok envelope
   * carrying {@link PROBE_FINGERPRINT}. */
  probe?: { status?: number; body?: unknown };
  /** When set, `POST /api/jobs` returns a busy (409) carrying this id (the slot is
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
}

/** The same-origin job API, stubbed at the global fetch seam. Unmatched URLs fall
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
        return Promise.resolve(jsonResponse(CLIENTS_PROFILE));
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
            recordAvailable: false,
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

    // The browser-side terms preview renders under the direct-exchange framing: the
    // honest heading and intro, NOT the invitation flow's false "Exchange proposal"
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
    expect(container?.textContent).not.toContain("Exchange proposal");
    expect(container?.textContent).not.toContain("must review and consent");

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

  test("Start over after a terminal failure frees the slot and re-enables Run", async () => {
    const api = stubJobApi({ sftp: CONFIGURED_SFTP, jobStatus: "failed" });
    mount(createElement(DirectExchangeBench));
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

    await page.getByRole("button", { name: "Start over" }).click();

    // Start over returns to the file step AND discards the failed job, freeing the
    // appliance's single slot (a DELETE of the occupying job).
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

    // The operator is no longer stranded: re-walk to confirm and Run is enabled again
    // (before the fix `started` stayed true, leaving Run permanently disabled), and a
    // fresh create is issued rather than blocked on the still-occupied slot.
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
    mount(createElement(DirectExchangeBench));
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
    expect(container?.textContent).not.toContain(
      "Identity cannot begin with a dash",
    );
  });
});

describe("console direct re-attaches on a busy create", () => {
  const REATTACH_HANDOFF = {
    mode: "zeroSetup",
    channel: "sftp",
    usedKeyFile: false,
    credentialPasted: false,
    template: {
      kind: "command",
      argv: ["psilink", "exchange", "clients.csv", "results.csv"],
    },
  };

  test("a 409 at run re-attaches with recovery copy, not the busy alert", async () => {
    // The slot is occupied: the create 409s carrying the live occupant's id.
    const api = stubJobApi({
      sftp: CONFIGURED_SFTP,
      conflict: { jobId: "job-live", status: "running" },
      handoff: REATTACH_HANDOFF,
    });
    mount(createElement(DirectExchangeBench));
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
          "You are back on an exchange this appliance already holds.",
        ),
      )
      .toBeInTheDocument();
    expect(
      page
        .getByText("This appliance is already running an exchange", {
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
    mount(createElement(DirectExchangeBench));
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
          "Reconnecting to the exchange this appliance already holds",
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
    mount(createElement(DirectExchangeBench));
    await reachConfirm();
    await page.getByRole("checkbox").click();
    await page.getByRole("button", { name: "Run the exchange" }).click();

    await expect
      .element(page.getByText("This appliance is already running an exchange"))
      .toBeInTheDocument();
    // No recovery framing: the fallback is the plain busy alert, not the re-attach
    // view.
    expect(
      page
        .getByText("You are back on an exchange this appliance already holds.")
        .query(),
    ).toBeNull();
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
    mount(createElement(DirectExchangeBench));
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

describe("console lobby direct-exchange card", () => {
  test("offers a third card that links to the direct-exchange route", async () => {
    stubJobApi();
    mount(createElement(BenchLobby));
    const link = page.getByRole("link", { name: "Run a direct exchange" });
    await expect.element(link).toBeInTheDocument();
    await expect.element(link).toHaveAttribute("href", "/direct");
  });
});

describe("console lobby recurring-exchange surface", () => {
  test("offers no /saved recurring-exchange pointer", async () => {
    stubJobApi();
    mount(createElement(BenchLobby));
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
