/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

import { MantineProvider } from "@mantine/core";

import {
  encodeInvitation,
  generateSharedSecret,
  getDefaultLinkageTerms,
} from "@psilink/core";

import { AcceptInvitation } from "@components/AcceptInvitation";

import type { Root } from "react-dom/client";

import type { InvitationToken } from "@psilink/core";

// Stub the dialing exchange: this suite verifies the consent GATE -- that the
// exchange mounts only after consent -- not the exchange itself, which would
// pull in peerjs and the PSI WASM and set up a rendezvous. A test-controlled
// marker keeps the assertion independent of the real Exchange's UI. (vitest
// hoists vi.mock above the imports, so the container picks up the stub.)
vi.mock("@components/Exchange", () => ({
  Exchange: () =>
    createElement("div", { "data-testid": "exchange-mounted" }, "exchange"),
}));

async function encodeAcceptToken(): Promise<string> {
  const token: InvitationToken = {
    version: "1",
    linkageTerms: getDefaultLinkageTerms("County Health Department"),
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

afterEach(() => {
  root?.unmount();
  container?.remove();
  root = undefined;
  container = undefined;
  window.location.hash = "";
});

describe("accept consent gate (route wiring)", () => {
  test("mounts the exchange only after explicit consent, never before", async () => {
    window.location.hash = await encodeAcceptToken();
    mountAcceptRoute();

    // The decoded terms render once the async decode resolves.
    await expect
      .element(page.getByText("Invitation from County Health Department"))
      .toBeInTheDocument();

    // Pre-consent: the affirmative action is present but disabled, and the
    // exchange (which dials) has not been mounted.
    const acceptButton = page.getByRole("button", {
      name: "Accept and continue",
    });
    await expect.element(acceptButton).toBeDisabled();
    expect(exchangeMounted()).toBe(false);

    // Consenting and naming enables the action.
    await userEvent.click(page.getByRole("checkbox"));
    await userEvent.fill(page.getByRole("textbox"), "Dana");
    await expect.element(acceptButton).toBeEnabled();

    // Only the explicit click commits the consent and mounts the exchange.
    await userEvent.click(acceptButton);
    await expect
      .element(page.getByTestId("exchange-mounted"))
      .toBeInTheDocument();
  });

  test("does not start the exchange while consent is unchecked", async () => {
    window.location.hash = await encodeAcceptToken();
    mountAcceptRoute();

    await expect
      .element(page.getByText("Invitation from County Health Department"))
      .toBeInTheDocument();

    // A name alone, without checking consent, must not enable the action or
    // mount the exchange.
    await userEvent.fill(page.getByRole("textbox"), "Dana");
    await expect
      .element(page.getByRole("button", { name: "Accept and continue" }))
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
      linkageTerms: getDefaultLinkageTerms("County Health Department"),
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
