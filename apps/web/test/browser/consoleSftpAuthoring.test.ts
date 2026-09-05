/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";

// Load Mantine's stylesheet so components render with their real geometry.
import "@mantine/core/styles.css";

import { decodeInvitation } from "@psilink/core";

import { InviterScreen } from "@exchange/InviterScreen";
import styles from "@styles/app.module.css";

import { createAppMount, flushPendingUpdates } from "./renderApp";

// The console SFTP connection-authoring flow: the operator drives PUT /api/jobs/sftp
// from a file-reference credential (a secrets-mount locator or a typed @path). This
// suite exercises the console build; the hosted behaviors stay pinned by exchange.test.ts.
vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);

vi.mock("@utils/clientConfig", () => ({
  deploymentProfile: () => "console" as const,
  isConsoleBuild: () => true,
  psilinkVersion: () => undefined,
}));

vi.mock("@psi/rendezvous", async () =>
  (await import("./moduleMocks")).rendezvousMock(),
);

const FINGERPRINT = `SHA256:${"A".repeat(43)}`;
// A distinct valid fingerprint the probe returns, so a test can tell a
// probe-filled pin apart from a typed one.
const PROBE_FINGERPRINT = `SHA256:${"B".repeat(42)}A`;

// The fixed first-party name the console gives the field the peer's bytes land
// in: the string the browser resolves as that field's accessible name, which is
// what a screen reader announces ahead of the bytes.
const PEER_BYTES_LABEL = "Bytes that answered the port";

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

// The secrets mount: a loose password file and an .ssh directory with a key.
const SECRETS_ROOT = [
  { name: ".ssh", kind: "dir" },
  { name: "partner-password", kind: "file" },
];
const SECRETS_SSH = [{ name: "id_ed25519", kind: "file" }];

interface CapturedRequest {
  url: string;
  method: string;
  body?: string;
}

interface StubOptions {
  /** The initial sftp state the GET reports. */
  sftp?: unknown;
  /** Force the PUT /api/jobs/sftp response status (e.g. 413) instead of
   * authoring the connection. */
  putStatus?: number;
  /** Non-blocking credential warnings the PUT /api/jobs/sftp projection holds,
   * as the server returns when a credential resolves inside an excluded dir. */
  putWarnings?: Array<string>;
  /** The POST /api/jobs/sftp/probe response. Defaults to a 200 ok envelope
   * holding {@link PROBE_FINGERPRINT}; a `{status, body}` lets a test drive an
   * unreachable/error outcome. */
  probe?: { status?: number; body?: unknown };
  /** Gates the probe responses wait on, taken in order: the nth probe's response
   * settles when the nth promise does, so a test can act on the form while a
   * probe is in flight (the real one runs for as long as ~15s). A
   * probe past the end of the list settles immediately. */
  probeGates?: Array<Promise<void>>;
}

/** One held-open probe response, standing in for the seconds the real probe
 * spends reading the server. */
function createProbeGate(): { promise: Promise<void>; settle: () => void } {
  let settle = (): void => {};
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

/** The same-origin job API, stubbed at the global fetch boundary. PUT /api/jobs/sftp
 * captures the body and flips the GET to report the authored connection. */
function stubJobApi(options: StubOptions = {}): {
  captured: Array<CapturedRequest>;
} {
  const captured: Array<CapturedRequest> = [];
  const realFetch = window.fetch.bind(window);
  let sftp: unknown = options.sftp ?? { configured: false };
  let probeCount = 0;

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
      if (url === "/api/jobs/inputs")
        return Promise.resolve(
          jsonResponse({ configured: true, files: [CLIENTS_FILE] }),
        );
      if (url.startsWith("/api/jobs/inputs/profile"))
        return Promise.resolve(jsonResponse(CLIENTS_PROFILE));
      if (url === "/api/jobs/inputs/coverage")
        return Promise.resolve(jsonResponse({ rates: [] }));
      if (url === "/api/jobs/rendezvous")
        return Promise.resolve(jsonResponse({ configured: false }));
      if (url.startsWith("/api/jobs/mounts/secrets/entries")) {
        const params = new URL(url, "http://localhost").searchParams;
        const subPath = params.getAll("subPath");
        const entries =
          subPath.join("/") === ".ssh" ? SECRETS_SSH : SECRETS_ROOT;
        return Promise.resolve(
          jsonResponse({ configured: true, readable: true, entries }),
        );
      }
      if (url === "/api/jobs/sftp/probe") {
        const probe = options.probe ?? {
          status: 200,
          body: {
            status: "ok",
            fingerprint: PROBE_FINGERPRINT,
            keyType: "ssh-ed25519",
          },
        };
        const respond = () =>
          probe.body !== undefined
            ? jsonResponse(probe.body, probe.status ?? 200)
            : new Response(null, { status: probe.status ?? 200 });
        const gate = options.probeGates?.[probeCount++];
        return gate !== undefined
          ? gate.then(respond)
          : Promise.resolve(respond());
      }
      if (url === "/api/jobs/sftp") {
        if (method === "PUT") {
          if (options.putStatus !== undefined)
            return Promise.resolve(
              new Response(null, { status: options.putStatus }),
            );
          const parsed = JSON.parse(
            typeof init?.body === "string" ? init.body : "{}",
          ) as { host?: string; port?: number; path?: string };
          const projection: Record<string, unknown> = {
            configured: true,
            host: parsed.host,
          };
          if (parsed.port !== undefined) projection.port = parsed.port;
          if (parsed.path !== undefined) projection.path = parsed.path;
          if (options.putWarnings !== undefined)
            projection.credentialWarnings = options.putWarnings;
          sftp = projection;
          return Promise.resolve(jsonResponse(projection));
        }
        if (method === "DELETE") {
          sftp = { configured: false };
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        return Promise.resolve(jsonResponse(sftp));
      }
      if (url === "/api/jobs")
        return Promise.resolve(jsonResponse({ id: "job-7" }, 201));
      if (url === "/api/jobs/job-7/events")
        return Promise.resolve(
          new Response(new ReadableStream<Uint8Array>({ start() {} }), {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }),
        );
      return Promise.resolve(new Response(null, { status: 404 }));
    },
  );

  return { captured };
}

const app = createAppMount();

afterEach(async () => {
  await flushPendingUpdates();
  app.unmount();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

/** From an already-mounted screen: fill the name, pick a file, walk to Review. */
async function reachReviewCreate() {
  await expect.element(page.getByLabelText("Your name")).toBeInTheDocument();
  await userEvent.fill(page.getByLabelText("Your name"), "Dana Okafor");
  await page.getByRole("button", { name: "Select clients.csv" }).click();
  await page.getByRole("button", { name: "Use this file" }).click();
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

/** Open the authoring form and fill the recognizable connection fields. */
async function openAndFillForm() {
  await page.getByRole("button", { name: "Add connection" }).click();
  await userEvent.fill(
    page.getByLabelText("SFTP server address"),
    "sftp.partner.example",
  );
  await userEvent.fill(page.getByLabelText("Username"), "linkage");
  await userEvent.fill(
    page.getByLabelText("Server identity fingerprint"),
    FINGERPRINT,
  );
}

/** Mount the screen, walk to the authoring form, and run one probe the console
 * diagnoses as a non-SSH answer holding `excerpt`. Returns the field the peer's
 * bytes render in. */
async function probeWithExcerpt(excerpt: string): Promise<HTMLTextAreaElement> {
  stubJobApi({
    probe: {
      status: 200,
      body: {
        status: "unreachable",
        peerAnswer: "nonSsh",
        peerAnswerShape: "http",
        peerAnswerExcerpt: excerpt,
      },
    },
  });
  app.render(createElement(InviterScreen));
  await reachReviewCreate();
  await openFormForProbe();
  await page
    .getByRole("button", { name: "Read the fingerprint from the server" })
    .click();
  await expect
    .element(page.getByText("HTTP response", { exact: false }))
    .toBeInTheDocument();
  await flushPendingUpdates();
  return document.querySelector(`.${styles.peerBytes}`) as HTMLTextAreaElement;
}

/** The teardown the afterEach performs, run mid-test, so one test can drive the
 * whole flow a second time against a different stubbed answer. */
async function resetMountedScreen(): Promise<void> {
  await flushPendingUpdates();
  app.unmount();
  window.localStorage.clear();
  vi.unstubAllGlobals();
}

// The markers the probe's regions are resolved from. A region derived by
// walking up from something inside it -- the alert, say -- moves whenever the
// markup around it is reshaped, so an assertion over that region would quietly
// cover less DOM and keep passing.
const PROBE_RESULT_MARKER = "probe-result";
const PROBE_ANNOUNCEMENT_MARKER = "probe-announcement";

/** The probe's whole visible result: the trigger, the outcome surface, and the
 * peer-bytes field when there is one. Resolved through the page locator, which
 * throws on an absent or duplicated marker: a region resolved that way is not
 * the region the assertion over it means, so it stops rather than scanning
 * whatever else the document offers. */
function probeResult(): HTMLElement {
  return page.getByTestId(PROBE_RESULT_MARKER).element() as HTMLElement;
}

/** The probe's one announcing channel: the stable polite region mounted in every
 * phase, first in the result. Resolved through the page locator (see
 * {@link probeResult}). */
function probeAnnouncement(): HTMLElement {
  return page.getByTestId(PROBE_ANNOUNCEMENT_MARKER).element() as HTMLElement;
}

/** The whole of what the announcing region says in each phase that produces an
 * outcome. Mirrored from the form's own copy rather than imported from it, so
 * the containment clause -- the region holds a fixed first-party sentence and
 * nothing else -- is measured against a literal that a copy change has to be
 * made against, instead of against whatever the form now says. */
const ANNOUNCED_SENTENCE = {
  probing: "Reading the fingerprint from the server...",
  presented:
    "The server presented a fingerprint. Compare it with the value whoever " +
    "runs the server published.",
  error: "Reading the fingerprint failed. You can still paste it above.",
} as const;

/** Assert the announcing region holds exactly `content` and nothing else: the
 * whole of its text, and no element child to hold what a text sweep would miss
 * -- a control's value is a property rather than text content, so a region whose
 * text matches can still hold something unread by that comparison alone. */
function expectRegionHoldsOnly(region: Element, content: string): void {
  expect(region.textContent).toBe(content);
  expect(region.childElementCount).toBe(0);
}

/** Wait until the announcing region holds `sentence` and nothing besides. The
 * region's text is deferred one commit past the phase that produces it, so the
 * visible outcome reaching the screen does not mean the region has caught up --
 * a read taken on that cue can still find the in-flight sentence, or nothing at
 * all. Retrying on the region's own text is what makes the read terminal. */
async function expectAnnounced(sentence: string): Promise<void> {
  await expect.poll(() => probeAnnouncement().textContent).toBe(sentence);
  expectRegionHoldsOnly(probeAnnouncement(), sentence);
}

/**
 * ARIA's global states and properties, matching the WAI-ARIA 1.2
 * Recommendation's Global States and Properties section, checked 2026-08-27.
 * Presentational-role-conflict resolution ignores `role="presentation"` on an
 * element holding one of these, not any other `aria-*` attribute -- the
 * assumption the check below rests on. A list that falls behind the
 * vocabulary under-counts without failing loud.
 */
const ARIA_GLOBAL_ATTRIBUTES = new Set([
  "aria-atomic",
  "aria-busy",
  "aria-controls",
  "aria-current",
  "aria-describedby",
  "aria-details",
  "aria-disabled",
  "aria-dropeffect",
  "aria-errormessage",
  "aria-flowto",
  "aria-grabbed",
  "aria-haspopup",
  "aria-hidden",
  "aria-invalid",
  "aria-keyshortcuts",
  "aria-label",
  "aria-labelledby",
  "aria-live",
  "aria-owns",
  "aria-relevant",
  "aria-roledescription",
]);

/** The {@link ARIA_GLOBAL_ATTRIBUTES} `element` holds. */
function globalAriaAttributesOf(element: Element): Array<string> {
  return Array.from(element.attributes)
    .map((attribute) => attribute.name)
    .filter((name) => ARIA_GLOBAL_ATTRIBUTES.has(name));
}

/** Everything an assistive technology reads out of a live region: its text, plus
 * the value of any form control inside it -- a control's value is a property,
 * not text content, so a text-only sweep would call a region holding one empty.
 * Written as a property of the region rather than of today's markup, so it still
 * measures the announced run if the peer's bytes are ever rendered another way. */
function announcedTextOf(region: Element): string {
  const values = Array.from(region.querySelectorAll("input, textarea"))
    .map((control) => (control as HTMLInputElement | HTMLTextAreaElement).value)
    .join(" ");
  return `${region.textContent} ${values}`;
}

/** Every text node under `root`, in document order. */
function textNodesOf(root: Node): Array<Text> {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Array<Text> = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode())
    nodes.push(node as Text);
  return nodes;
}

/** The console's own text that follows the peer's bytes within the probe
 * result: what terminality requires to be empty. The scanned region is the
 * marked result root, so what is covered is fixed by that marker and not by how
 * deeply the alert and the field happen to be nested inside it. */
function firstPartyTextAfterPeerBytes(peerBytes: Element): Array<string> {
  const result = probeResult();
  expect(result.contains(peerBytes)).toBe(true);
  return textNodesOf(result)
    .filter(
      (node) =>
        node.textContent.trim() !== "" &&
        !peerBytes.contains(node) &&
        (peerBytes.compareDocumentPosition(node) &
          Node.DOCUMENT_POSITION_FOLLOWING) !==
          0,
    )
    .map((node) => node.textContent);
}

/** Open the form and fill host + username only, leaving the fingerprint EMPTY so
 * the host-key probe can fill it. */
async function openFormForProbe() {
  await page.getByRole("button", { name: "Add connection" }).click();
  await userEvent.fill(
    page.getByLabelText("SFTP server address"),
    "sftp.partner.example",
  );
  await userEvent.fill(page.getByLabelText("Username"), "linkage");
}

describe("console SFTP connection authoring", () => {
  test("the empty state offers authoring and blocks Create until a connection lands", async () => {
    stubJobApi();
    app.render(createElement(InviterScreen));
    await reachReviewCreate();
    // Unconfigured SFTP is the default; the card invites authoring rather than
    // silently degrading to save-a-file.
    await expect
      .element(
        page.getByText("No SFTP connection set up for this exchange yet"),
      )
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Create the invitation" }))
      .toBeDisabled();
  });

  test("authors a connection from a picked secrets file, then runs it here", async () => {
    const api = stubJobApi();
    app.render(createElement(InviterScreen));
    await reachReviewCreate();
    await openAndFillForm();

    // Browse the secrets mount and pick the credential file.
    await page
      .getByRole("button", { name: "Choose a file from the secrets mount" })
      .click();
    await page.getByRole("button", { name: "Use partner-password" }).click();
    // The picked file is shown as a relative locator, never an absolute path.
    await expect
      .element(page.getByText("secrets / partner-password"))
      .toBeInTheDocument();

    await page.getByRole("button", { name: "Save connection" }).click();

    // The PUT held a mountRef locator -- no credential value, no absolute path.
    const put = api.captured.find(
      (request) => request.url === "/api/jobs/sftp" && request.method === "PUT",
    );
    expect(put).toBeDefined();
    const body = JSON.parse(put?.body ?? "{}") as Record<string, unknown>;
    expect(body.host).toBe("sftp.partner.example");
    expect(body.username).toBe("linkage");
    expect(body.hostKeyFingerprint).toBe(FINGERPRINT);
    expect(body.credential).toEqual({
      kind: "mountRef",
      mount: "secrets",
      subPath: ["partner-password"],
      credType: "password",
    });
    expect(put?.body).not.toContain("/run/");

    // The card flips to the authored, "Ready to try" state (not "connected").
    await expect.element(page.getByText("Ready to try")).toBeInTheDocument();
    await expect
      .element(page.getByText("not verified until the exchange runs"))
      .toBeInTheDocument();

    // Create now mints an invitation whose endpoint is the authored locator.
    await page.getByRole("button", { name: "Create the invitation" }).click();
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Your invitation is ready");
    await page.getByRole("button", { name: "Show full code" }).click();
    const encoded = (
      document.querySelector(`.${styles.revealArea}`) as HTMLTextAreaElement
    ).value;
    const token = await decodeInvitation(encoded);
    expect(token.connectionEndpoint).toEqual({
      channel: "sftp",
      host: "sftp.partner.example",
    });
  });

  test("authors from the de-emphasized paste-the-value fallback", async () => {
    const api = stubJobApi();
    app.render(createElement(InviterScreen));
    await reachReviewCreate();
    await openAndFillForm();

    // The paste field is a de-emphasized fallback, revealed on demand.
    await page
      .getByRole("button", { name: "Or paste the value instead" })
      .click();
    await userEvent.fill(
      page.getByLabelText("Paste value"),
      "s3cret-pasted-password",
    );
    await page.getByRole("button", { name: "Save connection" }).click();

    // The PUT held a raw credential -- the value, tagged with the auth method.
    const put = api.captured.find(
      (request) => request.url === "/api/jobs/sftp" && request.method === "PUT",
    );
    expect(put).toBeDefined();
    const body = JSON.parse(put?.body ?? "{}") as Record<string, unknown>;
    expect(body.credential).toEqual({
      kind: "raw",
      value: "s3cret-pasted-password",
      credType: "password",
    });

    // The card flips to the authored state (the form, and its paste field, unmount).
    await expect.element(page.getByText("Ready to try")).toBeInTheDocument();
    expect(page.getByLabelText("Paste value").query()).toBeNull();

    // The pasted value is never written to browser storage.
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i)!;
      expect(window.localStorage.getItem(key)).not.toContain(
        "s3cret-pasted-password",
      );
    }
  });

  test("a collapsed paste keeps an armed value visible with a Clear control", async () => {
    stubJobApi();
    app.render(createElement(InviterScreen));
    await reachReviewCreate();
    await openAndFillForm();

    await page
      .getByRole("button", { name: "Or paste the value instead" })
      .click();
    await userEvent.fill(page.getByLabelText("Paste value"), "armed-secret");
    // Collapse the fallback: the armed value must stay visible, not read as empty.
    await page
      .getByRole("button", { name: "Hide paste-the-value fallback" })
      .click();
    await expect
      .element(page.getByText("A pasted value is set."))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Edit the pasted value" }))
      .toBeInTheDocument();

    // Clear removes the armed value; the indicator and edit affordance go away.
    await page.getByRole("button", { name: "Clear" }).click();
    expect(page.getByText("A pasted value is set.").query()).toBeNull();
    await expect
      .element(page.getByRole("button", { name: "Or paste the value instead" }))
      .toBeInTheDocument();
  });

  test("an emptied paste shows its own message at the paste field", async () => {
    const api = stubJobApi();
    app.render(createElement(InviterScreen));
    await reachReviewCreate();
    await openAndFillForm();

    await page
      .getByRole("button", { name: "Or paste the value instead" })
      .click();
    // Type then empty the paste field: an opened-but-empty paste is the active
    // source, so its dedicated message is reachable rather than one on the file field.
    await userEvent.fill(page.getByLabelText("Paste value"), "temp");
    await userEvent.clear(page.getByLabelText("Paste value"));
    await page.getByRole("button", { name: "Save connection" }).click();
    await expect
      .element(
        page.getByText(
          "Enter the pasted credential value, or choose a file instead.",
        ),
      )
      .toBeInTheDocument();
    // The blocking error kept the request from being sent.
    expect(
      api.captured.some(
        (request) =>
          request.url === "/api/jobs/sftp" && request.method === "PUT",
      ),
    ).toBe(false);
  });

  test("scopes the never-uploaded note to the file reference, not the paste", async () => {
    stubJobApi();
    app.render(createElement(InviterScreen));
    await reachReviewCreate();
    await openAndFillForm();
    // The file-reference note scopes the never-uploaded claim to the file itself.
    await expect
      .element(page.getByText("the file itself is never uploaded"))
      .toBeInTheDocument();
    // The paste fallback openly states it writes to a file on the console.
    await page
      .getByRole("button", { name: "Or paste the value instead" })
      .click();
    await expect
      .element(
        page.getByText("written to a file on this console", { exact: false }),
      )
      .toBeInTheDocument();
  });

  test("authors from a typed @path override", async () => {
    const api = stubJobApi();
    app.render(createElement(InviterScreen));
    await reachReviewCreate();
    await openAndFillForm();
    await userEvent.fill(
      page.getByLabelText("File reference"),
      "@/run/secrets/partner-key",
    );
    await page.getByRole("button", { name: "Save connection" }).click();

    const put = api.captured.find(
      (request) => request.url === "/api/jobs/sftp" && request.method === "PUT",
    );
    const body = JSON.parse(put?.body ?? "{}") as Record<string, unknown>;
    expect(body.credential).toEqual({
      kind: "ref",
      ref: "@/run/secrets/partner-key",
      credType: "password",
    });
  });

  test("a signing fingerprint is caught before any PUT", async () => {
    const api = stubJobApi();
    app.render(createElement(InviterScreen));
    await reachReviewCreate();
    await page.getByRole("button", { name: "Add connection" }).click();
    await userEvent.fill(
      page.getByLabelText("SFTP server address"),
      "sftp.partner.example",
    );
    await userEvent.fill(page.getByLabelText("Username"), "linkage");
    // A 43-char base64url value with no SHA256: prefix is a signing fingerprint.
    await userEvent.fill(
      page.getByLabelText("Server identity fingerprint"),
      "A".repeat(43),
    );
    await page.getByRole("button", { name: "Save connection" }).click();
    await expect
      .element(page.getByText("signing fingerprint", { exact: false }))
      .toBeInTheDocument();
    expect(
      api.captured.some(
        (request) =>
          request.url === "/api/jobs/sftp" && request.method === "PUT",
      ),
    ).toBe(false);
  });

  test("revealing the add form focuses the first field, with no edit note", async () => {
    stubJobApi();
    app.render(createElement(InviterScreen));
    await reachReviewCreate();
    await page.getByRole("button", { name: "Add connection" }).click();
    await expect
      .element(page.getByLabelText("SFTP server address"))
      .toHaveFocus();
    // The re-enter note is for the edit case only, not a fresh add.
    expect(
      page.getByText("never stored in the browser", { exact: false }).query(),
    ).toBeNull();
  });

  test("editing an authored connection notes the re-entered fields", async () => {
    stubJobApi({
      sftp: {
        configured: true,
        host: "sftp.example.gov",
        port: 2222,
      },
    });
    app.render(createElement(InviterScreen));
    await reachReviewCreate();
    await page.getByRole("button", { name: "Edit connection" }).click();
    await expect
      .element(page.getByText("never stored in the browser", { exact: false }))
      .toBeInTheDocument();
  });

  test("an invalid port under collapsed Advanced shows on Save", async () => {
    stubJobApi();
    app.render(createElement(InviterScreen));
    await reachReviewCreate();
    await openAndFillForm();
    // Open Advanced, enter an out-of-range port, then collapse it again.
    await page.getByRole("button", { name: "Advanced" }).click();
    await userEvent.fill(page.getByLabelText("Port"), "70000");
    await page.getByRole("button", { name: "Hide advanced" }).click();
    await page.getByRole("button", { name: "Save connection" }).click();
    // Save reopens Advanced so the blocking port error is visible.
    await expect
      .element(page.getByText("Enter a port number between 0 and 65535"))
      .toBeVisible();
  });

  test("a credential warning renders below the authored connection", async () => {
    stubJobApi({
      putWarnings: [
        "The password credential file is inside the job data root, the folder " +
          "psilink writes the exchange's working files and results into.",
      ],
    });
    app.render(createElement(InviterScreen));
    await reachReviewCreate();
    await openAndFillForm();
    await userEvent.fill(
      page.getByLabelText("File reference"),
      "@/data/partner-key",
    );
    await page.getByRole("button", { name: "Save connection" }).click();
    // The connection is authored (it runs), and the non-blocking warning shows.
    await expect
      .element(page.getByText("Credential file location"))
      .toBeInTheDocument();
    await expect
      .element(page.getByText("inside the job data root", { exact: false }))
      .toBeInTheDocument();
  });

  test("a 413 shows the too-large message, not the reachability one", async () => {
    stubJobApi({ putStatus: 413 });
    app.render(createElement(InviterScreen));
    await reachReviewCreate();
    await openAndFillForm();
    await userEvent.fill(
      page.getByLabelText("File reference"),
      "@/run/secrets/partner-key",
    );
    await page.getByRole("button", { name: "Save connection" }).click();
    await expect
      .element(page.getByText("The connection details are too large."))
      .toBeInTheDocument();
  });

  test("probe-to-fill reads the fingerprint, fills the field, and Save PUTs it", async () => {
    const api = stubJobApi();
    app.render(createElement(InviterScreen));
    await reachReviewCreate();
    await openFormForProbe();

    // Read the fingerprint from the server; the presented result appears with the
    // comparison framing and, on the exchange path, the reconciliation note (no
    // out-of-band checkbox).
    await page
      .getByRole("button", { name: "Read the fingerprint from the server" })
      .click();
    await expect
      .element(page.getByText("The server presented this fingerprint"))
      .toBeInTheDocument();
    await expect.element(page.getByText(PROBE_FINGERPRINT)).toBeInTheDocument();
    await expect
      .element(page.getByText("warn on a mismatch", { exact: false }))
      .toBeInTheDocument();
    // The exchange ceremony has NO out-of-band affirmation checkbox; the
    // credential form's keyboard-interactive checkbox renders on a
    // password-method form, so absence is asserted by name.
    expect(
      page
        .getByRole("checkbox", {
          name: "I checked this fingerprint against a source other than this connection",
        })
        .query(),
    ).toBeNull();

    await page.getByRole("button", { name: "Use this fingerprint" }).click();
    // The field now holds the probed value (comparison, then fill).
    await expect
      .element(page.getByLabelText("Server identity fingerprint"))
      .toHaveValue(PROBE_FINGERPRINT);

    await userEvent.fill(
      page.getByLabelText("File reference"),
      "@/run/secrets/partner-key",
    );
    await page.getByRole("button", { name: "Save connection" }).click();
    const put = api.captured.find(
      (request) => request.url === "/api/jobs/sftp" && request.method === "PUT",
    );
    const body = JSON.parse(put?.body ?? "{}") as Record<string, unknown>;
    expect(body.hostKeyFingerprint).toBe(PROBE_FINGERPRINT);
  });

  test("a probe error keeps paste usable", async () => {
    const api = stubJobApi({
      probe: { status: 200, body: { status: "unreachable" } },
    });
    app.render(createElement(InviterScreen));
    await reachReviewCreate();
    await openFormForProbe();

    await page
      .getByRole("button", { name: "Read the fingerprint from the server" })
      .click();
    await expect
      .element(page.getByText("Could not read the fingerprint"))
      .toBeInTheDocument();
    // Nothing to attribute: an undiagnosed failure grows no peer-bytes field, so
    // the whole result is first-party and the recovery step is in it.
    const firstPartyOnly = probeResult();
    expect(firstPartyOnly.textContent).toContain(
      "You can still paste the fingerprint above.",
    );
    expect(document.querySelector(`.${styles.peerBytes}`)).toBeNull();
    // Paste stays primary: the operator types the fingerprint and saves.
    await userEvent.fill(
      page.getByLabelText("Server identity fingerprint"),
      FINGERPRINT,
    );
    await userEvent.fill(
      page.getByLabelText("File reference"),
      "@/run/secrets/partner-key",
    );
    await page.getByRole("button", { name: "Save connection" }).click();
    const put = api.captured.find(
      (request) => request.url === "/api/jobs/sftp" && request.method === "PUT",
    );
    const body = JSON.parse(put?.body ?? "{}") as Record<string, unknown>;
    expect(body.hostKeyFingerprint).toBe(FINGERPRINT);
  });

  test("the failure settle repairs focus back to the trigger it disabled", async () => {
    stubJobApi({
      probe: { status: 200, body: { status: "unreachable" } },
    });
    app.render(createElement(InviterScreen));
    await reachReviewCreate();
    await openFormForProbe();

    const trigger = page.getByRole("button", {
      name: "Read the fingerprint from the server",
    });
    await trigger.click();
    await expect
      .element(page.getByText("Could not read the fingerprint"))
      .toBeInTheDocument();
    await flushPendingUpdates();
    // The probe disables the trigger while it runs, so the operator's focus
    // anchor is destroyed for the duration; the settle repairs it rather than
    // moving focus to announce (the polite region does that, below).
    expect(document.activeElement).toBe(trigger.element());
    await expectAnnounced(ANNOUNCED_SENTENCE.error);
  });

  test("the probe announces from one stable region, and nothing else announces", async () => {
    stubJobApi({
      probe: { status: 200, body: { status: "unreachable" } },
    });
    app.render(createElement(InviterScreen));
    await reachReviewCreate();
    await openFormForProbe();

    // Mounted ahead of the outcome and empty before it: a settle reaches
    // assistive tech as a change to a region already being observed, never as a
    // freshly inserted node. Empty means holding nothing at all, elements
    // included, which is what the containment clause claims of every phase.
    const region = probeAnnouncement();
    expect(region.getAttribute("role")).toBe("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.getAttribute("aria-atomic")).toBe("true");
    expectRegionHoldsOnly(region, "");
    expect(probeResult().firstElementChild).toBe(region);

    await page
      .getByRole("button", { name: "Read the fingerprint from the server" })
      .click();
    await expect
      .element(page.getByText("Could not read the fingerprint"))
      .toBeInTheDocument();
    await flushPendingUpdates();

    // The same node, never remounted, holds the console's own sentence.
    await expectAnnounced(ANNOUNCED_SENTENCE.error);
    expect(probeAnnouncement()).toBe(region);
    // One channel announces: within the probe result nothing else holds live
    // semantics, and the visible alert is not one (Mantine's Alert defaults to
    // role="alert", so this also holds the explicit override in place).
    expect(Array.from(probeResult().querySelectorAll("[aria-live]"))).toEqual([
      region,
    ]);
    expect(probeResult().querySelector('[role="alert"]')).toBeNull();
    // What the override displaces is the default; the presentational role it
    // names does not itself apply, because ARIA's presentational-role-conflict
    // resolution ignores it on an element holding a GLOBAL aria-* state or
    // property -- which Mantine sets on this root. That assumption is pinned here,
    // against the rule's own set rather than against any aria-* attribute, so
    // the reasoning recorded around it cannot outlive it.
    const alert = probeResult().querySelector('[role="presentation"]');
    if (alert === null) throw new Error("The probe failure alert is missing.");
    expect(globalAriaAttributesOf(alert)).not.toEqual([]);
  });

  test("the presented result announces from the same region and is named for the focus it takes", async () => {
    stubJobApi();
    app.render(createElement(InviterScreen));
    await reachReviewCreate();
    await openFormForProbe();

    const region = probeAnnouncement();
    await page
      .getByRole("button", { name: "Read the fingerprint from the server" })
      .click();
    await expect
      .element(page.getByText("The server presented this fingerprint"))
      .toBeInTheDocument();
    await flushPendingUpdates();

    await expectAnnounced(ANNOUNCED_SENTENCE.presented);
    expect(probeAnnouncement()).toBe(region);
    // The presented panel replaces the trigger the operator pressed, so its focus
    // move is repair -- and what focus lands on names itself from its own visible
    // lead line rather than being an anonymous div.
    const panel = page
      .getByRole("group", { name: "The server presented this fingerprint:" })
      .element();
    expect(document.activeElement).toBe(panel);
    expect(panel.getAttribute("aria-live")).toBeNull();
    expect(Array.from(probeResult().querySelectorAll("[aria-live]"))).toEqual([
      region,
    ]);
  });

  test("an operator who moved on during the probe is not yanked back", async () => {
    const gate = createProbeGate();
    stubJobApi({
      probe: { status: 200, body: { status: "unreachable" } },
      probeGates: [gate.promise],
    });
    app.render(createElement(InviterScreen));
    await reachReviewCreate();
    await openFormForProbe();

    const trigger = page.getByRole("button", {
      name: "Read the fingerprint from the server",
    });
    await trigger.click();
    // The assumption the focus repair rests on: the trigger is disabled while the
    // probe is in flight, so the operator's anchor is gone for the duration.
    await expect.element(trigger).toBeDisabled();
    // The probe runs for as long as ~15s; the operator carries on filling the
    // form in the meantime.
    const fingerprintField = page.getByLabelText("Server identity fingerprint");
    fingerprintField.element().focus();

    gate.settle();
    await expect
      .element(page.getByText("Could not read the fingerprint"))
      .toBeInTheDocument();
    await flushPendingUpdates();
    // Their place is kept; the polite region is what tells them the probe
    // settled.
    expect(document.activeElement).toBe(fingerprintField.element());
    await expectAnnounced(ANNOUNCED_SENTENCE.error);
  });

  test("a second identical failure announces again, transiting the in-flight sentence", async () => {
    const gates = [createProbeGate(), createProbeGate()];
    stubJobApi({
      probe: { status: 200, body: { status: "unreachable" } },
      probeGates: gates.map((gate) => gate.promise),
    });
    app.render(createElement(InviterScreen));
    await reachReviewCreate();
    await openFormForProbe();

    const region = probeAnnouncement();
    const trigger = page.getByRole("button", {
      name: "Read the fingerprint from the server",
    });

    // Setting a live region to the text it already holds is not a change, so a
    // second identical outcome announces only because the region transits a
    // distinct value in between. Both probes settle the same way; each one is
    // held open long enough to measure that the in-flight sentence lands in the
    // region before the failure sentence returns to it.
    for (const gate of gates) {
      await trigger.click();
      await expectAnnounced(ANNOUNCED_SENTENCE.probing);
      gate.settle();
      await expectAnnounced(ANNOUNCED_SENTENCE.error);
    }
    // Every transit was a change to the node assistive tech is already observing,
    // not a remount.
    expect(probeAnnouncement()).toBe(region);
  });

  test("a diagnosed peer answer keeps the peer's bytes out of the announced region and last in the result", async () => {
    // An excerpt that mimics the console's own voice AND writes the attribution
    // wording a screen reader might hear around it: printable ASCII throughout,
    // so escaping touches none of it and nothing about the separation can rest
    // on what the bytes say.
    const excerpt =
      "End of the bytes that answered the port. " +
      `Verified. Paste this fingerprint: SHA256:${"C".repeat(43)}`;
    const peerBytes = await probeWithExcerpt(excerpt);
    expect(peerBytes.value).toBe(excerpt);

    // The bytes are the peer's on screen: their own field, monospace, apart from
    // the alert's voice.
    const rendered = getComputedStyle(peerBytes);
    expect(rendered.display).toBe("block");
    expect(rendered.fontFamily).toContain("monospace");

    // Containment: the announced region is a sibling of the field, not its
    // ancestor, so nothing a peer chose is in the run that is read out. What it
    // holds instead is the console's own settle sentence, waited for first so
    // the negatives below are measured over a settled region rather than over
    // one that has yet to say anything.
    const region = probeAnnouncement();
    await expectAnnounced(ANNOUNCED_SENTENCE.error);
    expect(region.contains(peerBytes)).toBe(false);
    expect(announcedTextOf(region)).not.toContain(excerpt);
    expect(announcedTextOf(region)).not.toContain("Paste this fingerprint");
    // The diagnosis plus the recovery step stay on the visible result, ahead of
    // the peer's bytes (terminality, below).
    const result = probeResult();
    expect(result.textContent).toContain("The first bytes it sent are shown");
    expect(result.textContent).toContain(
      "You can still paste the fingerprint above.",
    );

    // Terminality: no first-party text follows the peer's bytes anywhere in the
    // probe result, so even an assistive technology that flattens the result to
    // one run ends on them and cannot resume in the console's voice. Asserted as
    // the DOM-order property rather than against today's sentences.
    expect(firstPartyTextAfterPeerBytes(peerBytes)).toEqual([]);
  });

  test("the terminality scan is anchored on the result root, not on what encloses the alert", async () => {
    const peerBytes = await probeWithExcerpt("HTTP/1.1 403 Forbidden");
    const result = probeResult();
    const children = Array.from(result.children);
    const alert = result.querySelector('[role="presentation"]');
    if (alert === null) throw new Error("The probe failure alert is missing.");
    const scannedBefore = textNodesOf(result).map((node) => node.textContent);

    // The reshaping the anchor has to survive: an element introduced around the
    // alert and the peer's field, as a refactor grouping the two would leave.
    const regrouped = children.slice(children.indexOf(alert));
    const wrapper = document.createElement("div");
    // A console sentence left after that wrapper: inside the probe result, so
    // terminality is broken -- but outside what a walk up from the alert
    // resolves, so which region the scan covers decides whether it is seen.
    const trailing = document.createElement("p");
    trailing.textContent = "Try a different port.";
    result.append(wrapper);
    wrapper.append(...regrouped);
    try {
      // Narrowing is not hypothetical: what a walk up from the alert now
      // resolves holds neither the announcing region nor the trigger, so a scan
      // anchored there would pass over strictly less DOM without failing.
      expect(alert.parentElement).toBe(wrapper);
      expect(wrapper.contains(probeAnnouncement())).toBe(false);
      expect(textNodesOf(wrapper).length).toBeLessThan(scannedBefore.length);

      // Anchored on the marker, the region is the same node covering the same
      // text, and terminality still holds over it.
      expect(probeResult()).toBe(result);
      expect(textNodesOf(result).map((node) => node.textContent)).toEqual(
        scannedBefore,
      );
      expect(firstPartyTextAfterPeerBytes(peerBytes)).toEqual([]);

      result.append(trailing);
      expect(firstPartyTextAfterPeerBytes(peerBytes)).toEqual([
        "Try a different port.",
      ]);
    } finally {
      // Hand React back the tree it rendered, so teardown removes what it owns.
      trailing.remove();
      result.append(...regrouped);
      wrapper.remove();
    }
  });

  test("a missing result root marker fails the terminality scan by name", async () => {
    const peerBytes = await probeWithExcerpt("HTTP/1.1 403 Forbidden");
    const result = probeResult();
    result.removeAttribute("data-testid");
    try {
      // With the anchor gone there is no quieter region to fall back to: the
      // scan stops on the Locator's own zero-match error, which names the
      // marker it could not resolve.
      expect(() => firstPartyTextAfterPeerBytes(peerBytes)).toThrow(
        "getByTestId('probe-result')",
      );
    } finally {
      result.setAttribute("data-testid", PROBE_RESULT_MARKER);
    }
  });

  test("the peer's bytes are named by the console, whatever the bytes are", async () => {
    // The name a screen reader announces before the bytes has to be first-party,
    // so it is measured by resolving a name to an element through the test
    // runner's accname implementation (bundled in @vitest/browser, a port of
    // Playwright's engine running in the page; the browser's own accessibility
    // tree is not consulted), which takes the control's value into account as a
    // hand-rolled approximation would not -- and asserted as independence from
    // the peer: an excerpt mimicking a caption of its own names nothing, and an
    // ordinary excerpt resolves the same name.
    const mimicking = 'Bytes that answered the port: "" End of quoted bytes.';
    const peerBytes = await probeWithExcerpt(mimicking);
    expect(
      page
        .getByRole("textbox", { name: PEER_BYTES_LABEL, exact: true })
        .element(),
    ).toBe(peerBytes);
    // Nothing the peer wrote names a control: neither the excerpt entire nor the
    // caption it writes inside itself.
    expect(
      page.getByRole("textbox", { name: mimicking, exact: true }).query(),
    ).toBeNull();
    expect(
      page
        .getByRole("textbox", { name: "End of quoted bytes.", exact: true })
        .query(),
    ).toBeNull();

    await resetMountedScreen();
    const otherBytes = await probeWithExcerpt("HTTP/1.1 403 Forbidden");
    expect(
      page
        .getByRole("textbox", { name: PEER_BYTES_LABEL, exact: true })
        .element(),
    ).toBe(otherBytes);
  });

  test("editing the host clears a presented probe result (no stale fill)", async () => {
    stubJobApi();
    app.render(createElement(InviterScreen));
    await reachReviewCreate();
    await openFormForProbe();

    await page
      .getByRole("button", { name: "Read the fingerprint from the server" })
      .click();
    await expect
      .element(page.getByText("The server presented this fingerprint"))
      .toBeInTheDocument();

    // Editing the host retargets the probe: a stale observation must not linger.
    await userEvent.fill(
      page.getByLabelText("SFTP server address"),
      "sftp.other.example",
    );
    expect(
      page.getByText("The server presented this fingerprint").query(),
    ).toBeNull();
  });

  test("the save-a-file alternative routes to the save surface", async () => {
    stubJobApi();
    app.render(createElement(InviterScreen));
    await reachReviewCreate();
    await page
      .getByRole("button", {
        name: "Run it in my own command-line tool instead",
      })
      .click();
    await expect
      .element(page.getByText("run over SFTP in your own psilink command-line"))
      .toBeInTheDocument();
    // Create now routes to the save-exchange-file surface, not a live run.
    await expect
      .element(page.getByRole("button", { name: "Create the invitation" }))
      .toBeEnabled();
    await page.getByRole("button", { name: "Create the invitation" }).click();
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Save your exchange file");
  });
});
