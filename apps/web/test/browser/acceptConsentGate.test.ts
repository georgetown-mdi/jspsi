/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

import { MantineProvider } from "@mantine/core";

import { encodeInvitation, generateSharedSecret } from "@psilink/core";

import { AcceptInvitation } from "@components/AcceptInvitation";

import type { Root } from "react-dom/client";

import type { InvitationToken, LinkageTerms } from "@psilink/core";
import type { ExchangeConfig } from "@components/ExchangeView";

// Stub the dialing exchange screen: this suite verifies the REVIEW + PREPARE
// screens -- that the prepare editor mounts only after consent, and the exchange
// screen mounts (carrying the parsed file and the editor's metadata/standardization)
// only after the operator confirms in the editor, never before -- not the exchange
// itself, which would pull in peerjs and the PSI WASM. Capture the props the route
// hands it so the test can assert the bundle, the threaded edits, and the carried
// advisory; the no-dial-before-Start half lives in exchangeView.test.ts. (vitest
// hoists vi.mock above the imports.)
const exchange = vi.hoisted(() => ({
  lastProps: undefined as ExchangeConfig | undefined,
}));
vi.mock("@components/ExchangeView", () => ({
  ExchangeView: (props: ExchangeConfig) => {
    exchange.lastProps = props;
    return createElement(
      "div",
      { "data-testid": "exchange-mounted" },
      "exchange",
    );
  },
}));

// Stub the dropzone with a file counter and two buttons -- one seeds the selected
// file from `harness`, one is the real "Accept and continue" submit (honoring the
// consent gate via submitDisabled). The real FileAcquire still runs the real CSV
// parse on submit; the satisfiability verdict now lives in the prepare editor, not
// here. The counter lets the test wait for the file-state commit before
// submitting, so handleSubmit never reads a stale (empty) selection.
const harness = vi.hoisted(() => ({ files: [] as Array<File> }));
vi.mock("@components/FileSelect", () => ({
  default: (props: {
    submitLabel: string;
    submitted: boolean;
    submitDisabled?: boolean;
    files: Array<File>;
    handleSubmit: () => void;
    setFiles: (files: Array<File>) => void;
  }) =>
    createElement(
      "div",
      null,
      createElement(
        "span",
        { "data-testid": "file-count" },
        String(props.files.length),
      ),
      createElement(
        "button",
        {
          "data-testid": "select",
          onClick: () => props.setFiles(harness.files),
        },
        "select",
      ),
      createElement(
        "button",
        {
          "data-testid": "accept",
          disabled:
            props.submitted || props.files.length === 0 || props.submitDisabled,
          onClick: props.handleSubmit,
        },
        props.submitLabel,
      ),
    ),
}));

// Two single-element linkage keys, one per name field, so a CSV can satisfy both,
// one, or neither -- the three pre-flight outcomes the acceptor distinguishes. The
// identity drives the "Invitation from ..." heading the terms render.
const acceptorTerms: LinkageTerms = {
  version: "1.0.0",
  identity: "County Health Department",
  date: "2026-01-01",
  algorithm: "psi",
  output: { expectsOutput: true, shareWithPartner: true },
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

async function encodeAcceptToken(): Promise<string> {
  const token: InvitationToken = {
    version: "1",
    linkageTerms: acceptorTerms,
    sharedSecret: generateSharedSecret(),
    connectionEndpoint: {
      channel: "webrtc",
      host: "127.0.0.1",
      port: 3000,
      path: "/api/",
    },
  };
  return encodeInvitation(token);
}

// Encode a token WITHOUT schema validation, mirroring encodeInvitation's wire
// format (base64url body plus a 4-byte SHA-256 checksum), so a test can mint a
// checksum-valid string that fails the invitation schema and thus makes
// decodeInvitation throw a ZodError. encodeInvitation itself validates first, so
// it cannot produce a schema-invalid token.
async function encodeRaw(obj: unknown): Promise<string> {
  const toBase64Url = (b: Uint8Array): string =>
    btoa(Array.from(b, (x) => String.fromCharCode(x)).join(""))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  const body = toBase64Url(bytes);
  const hashBuf = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return body + toBase64Url(new Uint8Array(hashBuf).slice(0, 4));
}

// Flip the final checksum character of a valid encoded invitation so the body
// still decodes but the appended checksum no longer matches -- decodeInvitation
// then throws the plain "invitation checksum mismatch" Error (not a ZodError).
function corruptChecksum(encoded: string): string {
  const last = encoded.slice(-1);
  return encoded.slice(0, -1) + (last === "A" ? "B" : "A");
}

function csvFile(content: string): File {
  return new File([content], "data.csv", { type: "text/csv" });
}

let container: HTMLElement | undefined;
let root: Root | undefined;

function mountAcceptRoute() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(
    createElement(MantineProvider, null, createElement(AcceptInvitation)),
  );
}

function exchangeMounted(): boolean {
  return document.querySelector('[data-testid="exchange-mounted"]') !== null;
}

// Consent, name, and choose a file -- the full review action short of pressing
// "Accept and continue". Waits for the file-state commit so the submit reads it.
async function reviewAndChoose(file: File) {
  await userEvent.click(page.getByRole("checkbox"));
  await userEvent.fill(page.getByRole("textbox"), "Dana");
  harness.files = [file];
  await userEvent.click(page.getByTestId("select"));
  await expect.element(page.getByTestId("file-count")).toHaveTextContent("1");
}

afterEach(() => {
  root?.unmount();
  container?.remove();
  root = undefined;
  container = undefined;
  harness.files = [];
  exchange.lastProps = undefined;
  window.location.hash = "";
});

describe("accept review screen (consent + file before any connection)", () => {
  test("mounts the prepare editor, not the exchange, after consent and Accept", async () => {
    window.location.hash = await encodeAcceptToken();
    mountAcceptRoute();

    // The decoded terms render once the async decode resolves.
    await expect
      .element(page.getByText("Invitation from County Health Department"))
      .toBeInTheDocument();

    // Pre-consent: the affirmative action is present but disabled, and neither the
    // editor nor the dialing exchange screen has mounted.
    const accept = page.getByTestId("accept");
    await expect.element(accept).toBeDisabled();
    expect(exchangeMounted()).toBe(false);

    // Consent + name + a parsed file enables the action.
    await reviewAndChoose(csvFile("first_name,last_name\nAlice,Smith\n"));
    await expect.element(accept).toBeEnabled();

    // Accept moves to the "Prepare your data" editor -- NOT straight to the
    // exchange. Nothing dials yet.
    await userEvent.click(accept);
    await expect
      .element(page.getByRole("heading", { name: "Prepare your data" }))
      .toBeInTheDocument();
    expect(exchangeMounted()).toBe(false);
  });

  test("does not enable accept (or mount anything) without consent", async () => {
    window.location.hash = await encodeAcceptToken();
    mountAcceptRoute();

    await expect
      .element(page.getByText("Invitation from County Health Department"))
      .toBeInTheDocument();

    // A name and a file, but consent unchecked: the action stays disabled and
    // nothing transitions.
    await userEvent.fill(page.getByRole("textbox"), "Dana");
    harness.files = [csvFile("first_name,last_name\nAlice,Smith\n")];
    await userEvent.click(page.getByTestId("select"));
    await expect.element(page.getByTestId("file-count")).toHaveTextContent("1");

    await expect.element(page.getByTestId("accept")).toBeDisabled();
    expect(exchangeMounted()).toBe(false);
    expect(document.body.textContent).not.toContain("Prepare your data");
  });
});

describe("prepare your data editor (verdict, disclosure, launch)", () => {
  // Consent, name, choose the file, and press Accept to land in the editor.
  async function reachEditor(file: File) {
    await reviewAndChoose(file);
    await userEvent.click(page.getByTestId("accept"));
    await expect
      .element(page.getByRole("heading", { name: "Prepare your data" }))
      .toBeInTheDocument();
  }

  test("a satisfiable file reaches the exchange after Continue and Confirm, threading the edited spec", async () => {
    window.location.hash = await encodeAcceptToken();
    mountAcceptRoute();
    await expect
      .element(page.getByText("Invitation from County Health Department"))
      .toBeInTheDocument();

    // first_name + last_name satisfy both keys; the extra `zip` column is inferred
    // as payload, so the disclosure summary names exactly it.
    await reachEditor(csvFile("first_name,last_name,zip\nAlice,Smith,90210\n"));
    await expect
      .element(page.getByText("Columns sent to your partner: zip."))
      .toBeInTheDocument();

    // Continue opens the confirmation, which lists the disclosed column; only
    // confirming mounts the exchange.
    await userEvent.click(
      page.getByRole("button", { name: "Continue to exchange" }),
    );
    await expect
      .element(page.getByText("Confirm what you will send"))
      .toBeInTheDocument();
    expect(exchangeMounted()).toBe(false);
    await userEvent.click(
      page.getByRole("button", { name: "Confirm and continue" }),
    );

    await expect
      .element(page.getByTestId("exchange-mounted"))
      .toBeInTheDocument();
    if (exchange.lastProps?.role !== "acceptor")
      throw new Error("expected acceptor config");
    expect(exchange.lastProps.partyName).toBe("Dana");
    expect(exchange.lastProps.acquired.columns).toEqual([
      "first_name",
      "last_name",
      "zip",
    ]);
    // The editor's edited metadata and standardization are threaded to the run.
    expect(exchange.lastProps.metadata.map((c) => c.name)).toEqual([
      "first_name",
      "last_name",
      "zip",
    ]);
    expect(exchange.lastProps.standardization.length).toBeGreaterThan(0);
    // A fully satisfiable file carries no partial-coverage advisory.
    expect(exchange.lastProps.initialWarning).toBeUndefined();
  });

  test("Back returns to the review screen and a different file reseeds the editor", async () => {
    window.location.hash = await encodeAcceptToken();
    mountAcceptRoute();
    await expect
      .element(page.getByText("Invitation from County Health Department"))
      .toBeInTheDocument();

    // Reach the editor with a first file; `zip` is the inferred payload.
    await reachEditor(csvFile("first_name,last_name,zip\nAlice,Smith,90210\n"));
    await expect
      .element(page.getByText("Columns sent to your partner: zip."))
      .toBeInTheDocument();

    // Back returns to the review screen (the terms heading shows again) and the
    // editor unmounts -- nothing was committed, and consent is preserved.
    await userEvent.click(
      page.getByRole("button", { name: "Choose a different file" }),
    );
    await expect
      .element(page.getByText("Invitation from County Health Department"))
      .toBeInTheDocument();
    expect(document.body.textContent).not.toContain("Prepare your data");
    expect(exchangeMounted()).toBe(false);

    // A different file (consent already given, so only re-select) re-enters the
    // editor reseeded from the NEW columns: `notes` is the payload now, not `zip`.
    harness.files = [csvFile("first_name,last_name,notes\nBob,Jones,hi\n")];
    await userEvent.click(page.getByTestId("select"));
    await expect.element(page.getByTestId("file-count")).toHaveTextContent("1");
    await userEvent.click(page.getByTestId("accept"));
    await expect
      .element(page.getByRole("heading", { name: "Prepare your data" }))
      .toBeInTheDocument();
    await expect
      .element(page.getByText("Columns sent to your partner: notes."))
      .toBeInTheDocument();
  });

  test("a zero-coverage file shows the block and disables Continue, so nothing dials", async () => {
    window.location.hash = await encodeAcceptToken();
    mountAcceptRoute();
    await expect
      .element(page.getByText("Invitation from County Health Department"))
      .toBeInTheDocument();

    // No name columns at all: no linkage key can match. The dead-end is now an
    // editor entry -- the block message shows, Continue is disabled, and nothing
    // dials -- but the operator can fix it in place rather than being bounced out.
    await reachEditor(csvFile("notes\nhello\n"));
    await expect
      .element(page.getByText("This file cannot match yet"))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Continue to exchange" }))
      .toBeDisabled();
    expect(exchangeMounted()).toBe(false);
  });
});

describe("decode error rendering", () => {
  test("renders a schema failure as a readable line, not a raw ZodError blob", async () => {
    // A checksum-valid token that fails the invitation schema (an invalid
    // sharedSecret) makes decodeInvitation throw a ZodError. The acceptor must
    // see the collapsed `<path>: <message>` one-liner from describeDecodeError,
    // never Zod's serialized issues blob -- the readability this change delivers.
    window.location.hash = await encodeRaw({
      version: "1",
      linkageTerms: acceptorTerms,
      sharedSecret: "not-a-valid-shared-secret",
      connectionEndpoint: {
        channel: "webrtc",
        host: "127.0.0.1",
        port: 3000,
        path: "/api/",
      },
    });
    mountAcceptRoute();

    await expect
      .element(page.getByText("Cannot accept this invitation"))
      .toBeInTheDocument();
    const text = document.body.textContent;
    expect(text).toContain("sharedSecret:");
    // The raw blob is `JSON.stringify(issues)`, which always carries a "code"
    // key; the readable one-liner never does.
    expect(text).not.toContain('"code"');
  });

  test("surfaces a non-ZodError failure's plain message unchanged", async () => {
    // A corrupted checksum is a plain Error, not a ZodError; its fixed message
    // must pass through verbatim.
    window.location.hash = corruptChecksum(await encodeAcceptToken());
    mountAcceptRoute();

    await expect
      .element(page.getByText("invitation checksum mismatch"))
      .toBeInTheDocument();
  });
});
