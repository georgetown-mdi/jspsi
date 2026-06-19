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

// Stub the dialing exchange screen: this suite verifies the REVIEW screen -- that
// the exchange screen mounts (carrying the parsed file) only after consent + a
// satisfiable file, never before -- not the exchange itself, which would pull in
// peerjs and the PSI WASM. Capture the props the route hands it so the test can
// assert the bundle and the carried advisory; the no-dial-before-Start half lives
// in exchangeView.test.ts. (vitest hoists vi.mock above the imports.)
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
// parse and satisfiability pre-flight on submit, so the block/warn paths are
// genuinely exercised. The counter lets the test wait for the file-state commit
// before submitting, so handleSubmit never reads a stale (empty) selection.
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
    { name: "firstName", type: "firstName" },
    { name: "lastName", type: "lastName" },
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
  test("mounts the exchange only after consent, a name, a file, and Accept", async () => {
    window.location.hash = await encodeAcceptToken();
    mountAcceptRoute();

    // The decoded terms render once the async decode resolves.
    await expect
      .element(page.getByText("Invitation from County Health Department"))
      .toBeInTheDocument();

    // Pre-consent: the affirmative action is present but disabled, and the
    // exchange screen (which dials) has not mounted.
    const accept = page.getByTestId("accept");
    await expect.element(accept).toBeDisabled();
    expect(exchangeMounted()).toBe(false);

    // Consent + name + a fully satisfiable file enables the action.
    await reviewAndChoose(csvFile("first_name,last_name\nAlice,Smith\n"));
    await expect.element(accept).toBeEnabled();
    expect(exchangeMounted()).toBe(false);

    // Only the explicit Accept transitions to the exchange screen, carrying the
    // parsed file and the decoded invitation's terms to the acceptor role.
    await userEvent.click(accept);
    await expect
      .element(page.getByTestId("exchange-mounted"))
      .toBeInTheDocument();
    expect(exchange.lastProps?.role).toBe("acceptor");
    expect(exchange.lastProps?.partyName).toBe("Dana");
    if (exchange.lastProps?.role !== "acceptor")
      throw new Error("expected acceptor config");
    expect(exchange.lastProps.acquired.columns).toEqual([
      "first_name",
      "last_name",
    ]);
    expect(exchange.lastProps.acquired.rawRows).toEqual([
      { first_name: "Alice", last_name: "Smith" },
    ]);
    // A fully satisfiable file carries no partial-coverage advisory.
    expect(exchange.lastProps.initialWarning).toBeUndefined();
  });

  test("does not enable accept (or mount the exchange) without consent", async () => {
    window.location.hash = await encodeAcceptToken();
    mountAcceptRoute();

    await expect
      .element(page.getByText("Invitation from County Health Department"))
      .toBeInTheDocument();

    // A name and a satisfiable file, but consent unchecked: the action stays
    // disabled and nothing mounts the exchange.
    await userEvent.fill(page.getByRole("textbox"), "Dana");
    harness.files = [csvFile("first_name,last_name\nAlice,Smith\n")];
    await userEvent.click(page.getByTestId("select"));
    await expect.element(page.getByTestId("file-count")).toHaveTextContent("1");

    await expect.element(page.getByTestId("accept")).toBeDisabled();
    expect(exchangeMounted()).toBe(false);
  });
});

describe("accept review screen: satisfiability pre-flight", () => {
  test("blocks a file that satisfies no linkage key, naming the missing fields", async () => {
    window.location.hash = await encodeAcceptToken();
    mountAcceptRoute();

    await expect
      .element(page.getByText("Invitation from County Health Department"))
      .toBeInTheDocument();

    // No name columns at all: no linkage key can match.
    await reviewAndChoose(csvFile("notes\nhello\n"));
    await userEvent.click(page.getByTestId("accept"));

    // The block message appears on the review screen, naming the missing field
    // types, and the exchange screen never mounts -- nothing dials.
    await expect
      .element(page.getByText("This file cannot be linked"))
      .toBeInTheDocument();
    expect(document.body.textContent).toContain("firstName (firstName)");
    expect(document.body.textContent).toContain("lastName (lastName)");
    expect(exchangeMounted()).toBe(false);
  });

  test("warns on partial coverage but still transitions, carrying the advisory", async () => {
    window.location.hash = await encodeAcceptToken();
    mountAcceptRoute();

    await expect
      .element(page.getByText("Invitation from County Health Department"))
      .toBeInTheDocument();

    // Only first_name is present: the "first" key survives, "last" does not.
    await reviewAndChoose(csvFile("first_name\nAlice\n"));
    await userEvent.click(page.getByTestId("accept"));

    // Partial coverage still hands off: the exchange screen mounts, and the
    // advisory rides along as initialWarning so it stays visible through the run.
    await expect
      .element(page.getByTestId("exchange-mounted"))
      .toBeInTheDocument();
    if (exchange.lastProps?.role !== "acceptor")
      throw new Error("expected acceptor config");
    expect(exchange.lastProps.acquired.columns).toEqual(["first_name"]);
    expect(exchange.lastProps.initialWarning?.title).toBe(
      "Partial CSV coverage",
    );
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
