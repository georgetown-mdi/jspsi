/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import {
  RELAY_KEY_NOTICE,
  RELAY_OPERATOR_DISCLOSURE,
  RelaySettingsScreen,
} from "@exchange/RelaySettingsScreen";
import { readOwnRelaySetting } from "@psi/transport/ownRelaySetting";

import { createAppMount, flushPendingUpdates } from "./renderApp";

vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);

const TURN_URL = "turns:relay.example.org:443?transport=tcp";
const STUN_URL = "stun:stun.example.org:3478";

const app = createAppMount();

const turnField = () => page.getByRole("textbox", { name: "TURN server urls" });
const stunField = () => page.getByRole("textbox", { name: "STUN server urls" });
const saveButton = () => page.getByRole("button", { name: "Save" });
const removeButton = () => page.getByRole("button", { name: "Remove relay" });
const statusLine = () => page.getByRole("status");

/** Mount the screen afresh, as a page load does: it reads storage on mount. */
async function mountScreen(): Promise<void> {
  app.unmount();
  app.render(createElement(RelaySettingsScreen));
  await expect.element(turnField()).toBeInTheDocument();
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(async () => {
  await flushPendingUpdates();
  app.unmount();
  window.localStorage.clear();
});

describe("RelaySettingsScreen", () => {
  test("states what the relay's operator learns before anything is saved", async () => {
    await mountScreen();

    await expect
      .element(page.getByText(RELAY_OPERATOR_DISCLOSURE))
      .toBeVisible();
    expect(readOwnRelaySetting()).toEqual({ kind: "none" });
  });

  test("states that each run's relay key must be registered again", async () => {
    await mountScreen();

    await expect.element(page.getByText(RELAY_KEY_NOTICE)).toBeVisible();
  });

  test("an invalid TURN url is reported on the TURN field alone and nothing is saved", async () => {
    await mountScreen();

    await userEvent.fill(turnField(), "http://relay.example.org");
    await userEvent.fill(stunField(), STUN_URL);
    await userEvent.click(saveButton());

    await expect.element(turnField()).toHaveAccessibleDescription(/Line 1: /);
    await expect.element(turnField()).toHaveAttribute("aria-invalid", "true");
    await expect
      .element(stunField())
      .not.toHaveAttribute("aria-invalid", "true");
    expect(page.getByRole("alert").all()).toHaveLength(1);
    expect(statusLine().element().textContent).toBe("");
    expect(readOwnRelaySetting()).toEqual({ kind: "none" });
  });

  test("an invalid STUN url is reported on the STUN field alone and nothing is saved", async () => {
    await mountScreen();

    await userEvent.fill(turnField(), TURN_URL);
    await userEvent.fill(stunField(), `${STUN_URL}\nstun:`);
    await userEvent.click(saveButton());

    await expect.element(stunField()).toHaveAccessibleDescription(/Line 2: /);
    await expect.element(stunField()).toHaveAttribute("aria-invalid", "true");
    await expect
      .element(turnField())
      .not.toHaveAttribute("aria-invalid", "true");
    expect(page.getByRole("alert").all()).toHaveLength(1);
    expect(statusLine().element().textContent).toBe("");
    expect(readOwnRelaySetting()).toEqual({ kind: "none" });
  });

  test("a save is kept across a reload, and removing clears it", async () => {
    await mountScreen();

    await userEvent.fill(turnField(), TURN_URL);
    await userEvent.fill(stunField(), STUN_URL);
    await userEvent.click(saveButton());

    await expect
      .element(statusLine())
      .toHaveTextContent(
        "Saved. Exchanges started from now on use this relay.",
      );
    expect(readOwnRelaySetting()).toEqual({
      kind: "set",
      relay: { turn: [TURN_URL], stun: [STUN_URL] },
    });

    await mountScreen();
    await expect.element(turnField()).toHaveValue(TURN_URL);
    await expect.element(stunField()).toHaveValue(STUN_URL);

    await userEvent.click(removeButton());

    await expect
      .element(statusLine())
      .toHaveTextContent("No relay is set. Exchanges connect without one.");
    await expect.element(turnField()).toHaveValue("");
    await expect.element(stunField()).toHaveValue("");
    expect(readOwnRelaySetting()).toEqual({ kind: "none" });

    await mountScreen();
    await expect.element(turnField()).toHaveValue("");
    await expect.element(stunField()).toHaveValue("");
  });
});
