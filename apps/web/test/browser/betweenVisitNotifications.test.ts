/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { createElement } from "react";

import { BetweenVisitNotifications } from "@recurring/BetweenVisitNotifications";

import { createAppMount, flushPendingUpdates } from "./renderApp";

import type { BetweenVisitNotificationState } from "@psi/managed/betweenVisitNotifier";

// The opt-in control, mounted in a real Chromium tab. What it holds to: nothing
// asks the browser for notification permission until the operator presses the
// control, and a runtime that runs no schedule between visits offers nothing to
// press. The copy per state is test/unit/recurring/betweenVisitNotificationModel.

const app = createAppMount();

/** What the control renders in words: its own paragraphs, leaving out the style
 * element the app provider injects beside them. */
function renderedText(): string {
  return Array.from(app.container.querySelectorAll("p"))
    .map((paragraph) => paragraph.textContent)
    .join(" ");
}

afterEach(async () => {
  await flushPendingUpdates();
  app.unmount();
});

/** Render the control for `state`, in a runtime of the caller's choosing. Each
 * test waits for the reading it is about, since the mount's own state read and
 * the render that follows it land a task apart. */
function mount(
  state: BetweenVisitNotificationState,
  overrides: {
    isInstalledRuntime?: () => boolean;
    enable?: () => Promise<BetweenVisitNotificationState>;
  } = {},
): { readState: () => BetweenVisitNotificationState } {
  const readState = vi.fn(() => state);
  app.render(
    createElement(BetweenVisitNotifications, {
      isInstalledRuntime: overrides.isInstalledRuntime ?? (() => true),
      isConsoleBuild: () => false,
      readState,
      ...(overrides.enable === undefined ? {} : { enable: overrides.enable }),
    }),
  );
  return { readState };
}

describe("the between-visit notification control", () => {
  test("renders nothing in an ordinary tab", async () => {
    const { readState } = mount("off", { isInstalledRuntime: () => false });
    await flushPendingUpdates();
    await flushPendingUpdates();

    expect(readState).not.toHaveBeenCalled();
    expect(renderedText()).toBe("");
    expect(app.container.querySelector("button")).toBeNull();
  });

  test("asks for nothing until the operator presses it", async () => {
    const enable = vi.fn(() =>
      Promise.resolve("on" as BetweenVisitNotificationState),
    );
    mount("off", { enable });
    await vi.waitFor(() => {
      expect(app.container.querySelector("button")).not.toBeNull();
    });

    expect(enable).not.toHaveBeenCalled();

    const control = app.container.querySelector("button");
    expect(control?.textContent).toBe("Notify me between visits");
    control?.click();
    await vi.waitFor(() => {
      expect(enable).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(renderedText()).toContain("Notifications are on");
    });
  });

  test("a browser refusing notifications leaves nothing to press", async () => {
    mount("blocked");
    await vi.waitFor(() => {
      expect(renderedText()).toContain("blocking notifications for this app");
    });

    expect(app.container.querySelector("button")).toBeNull();
  });

  test("an engine without notifications shows nothing at all", async () => {
    const { readState } = mount("unsupported");
    await vi.waitFor(() => {
      expect(readState).toHaveBeenCalled();
    });
    await flushPendingUpdates();

    expect(renderedText()).toBe("");
    expect(app.container.querySelector("button")).toBeNull();
  });
});
