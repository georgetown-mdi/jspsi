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
