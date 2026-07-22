/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

// Load Mantine's stylesheet so components render with their real geometry.
import "@mantine/core/styles.css";

import { decodeInvitation } from "@psilink/core";

import { InviterBench } from "@bench/InviterBench";
import styles from "@bench/bench.module.css";

import { renderApp } from "./renderApp";

import type { ReactNode } from "react";
import type { Root } from "react-dom/client";

// The console SFTP connection-authoring flow: the operator drives PUT /api/jobs/sftp
// from a file-reference credential (a secrets-mount locator or a typed @path). This
// suite exercises the console build; the hosted behaviors stay pinned by bench.test.ts.
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

vi.mock("@psi/rendezvous", () => ({
  dialAsAcceptor: vi.fn(),
  listenAsInviter: vi.fn(),
}));

const FINGERPRINT = `SHA256:${"A".repeat(43)}`;

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
}

/** The same-origin job API, stubbed at the global fetch seam. PUT /api/jobs/sftp
 * captures the body and flips the GET to report the authored connection. */
function stubJobApi(options: StubOptions = {}): {
  captured: Array<CapturedRequest>;
} {
  const captured: Array<CapturedRequest> = [];
  const realFetch = window.fetch.bind(window);
  let sftp: unknown = options.sftp ?? { configured: false, bootPinned: false };

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
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

/** From an already-mounted bench: fill the name, pick a file, walk to Review. */
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

describe("console SFTP connection authoring", () => {
  test("the empty state offers authoring and blocks Create until a connection lands", async () => {
    stubJobApi();
    mount(createElement(InviterBench));
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
    mount(createElement(InviterBench));
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

    // The PUT carried a mountRef locator -- no credential value, no absolute path.
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
    mount(createElement(InviterBench));
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

    // The PUT carried a raw credential -- the value, tagged with the auth method.
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
    mount(createElement(InviterBench));
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

  test("an emptied paste surfaces its own message at the paste field", async () => {
    const api = stubJobApi();
    mount(createElement(InviterBench));
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
    mount(createElement(InviterBench));
    await reachReviewCreate();
    await openAndFillForm();
    // The file-reference note scopes the never-uploaded claim to the file itself.
    await expect
      .element(page.getByText("the file itself is never uploaded"))
      .toBeInTheDocument();
    // The paste fallback openly states it writes to a file on the appliance.
    await page
      .getByRole("button", { name: "Or paste the value instead" })
      .click();
    await expect
      .element(
        page.getByText("written to a file on this appliance", { exact: false }),
      )
      .toBeInTheDocument();
  });

  test("authors from a typed @path escape hatch", async () => {
    const api = stubJobApi();
    mount(createElement(InviterBench));
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
    mount(createElement(InviterBench));
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
    mount(createElement(InviterBench));
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
        bootPinned: false,
        host: "sftp.example.gov",
        port: 2222,
      },
    });
    mount(createElement(InviterBench));
    await reachReviewCreate();
    await page.getByRole("button", { name: "Edit connection" }).click();
    await expect
      .element(page.getByText("never stored in the browser", { exact: false }))
      .toBeInTheDocument();
  });

  test("an invalid port under collapsed Advanced surfaces on Save", async () => {
    stubJobApi();
    mount(createElement(InviterBench));
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

  test("a 413 shows the too-large message, not the reachability one", async () => {
    stubJobApi({ putStatus: 413 });
    mount(createElement(InviterBench));
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

  test("the deliberate save-a-file alternative routes to the save surface", async () => {
    stubJobApi();
    mount(createElement(InviterBench));
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

  test("a boot-provisioned server is read-only, no authoring offered", async () => {
    stubJobApi({
      sftp: {
        configured: true,
        bootPinned: true,
        host: "sftp.example.gov",
        port: 2222,
      },
    });
    mount(createElement(InviterBench));
    await reachReviewCreate();
    await expect
      .element(
        page.getByText("provisioned on this appliance", { exact: false }),
      )
      .toBeInTheDocument();
    expect(
      page.getByRole("button", { name: "Add connection" }).query(),
    ).toBeNull();
    expect(
      page.getByRole("button", { name: "Edit connection" }).query(),
    ).toBeNull();
  });
});
