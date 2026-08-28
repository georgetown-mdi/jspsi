/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { Fragment, createElement } from "react";

import { ScheduledExchangeRunner } from "@components/ScheduledExchangeRunner";
import { isInstalledRuntime } from "@utils/installedRuntime";

import { createAppMount, flushPendingUpdates } from "./renderApp";

import type { ManagedScheduleRuntimeOptions } from "@psi/managedScheduleRuntime";

// The runtime-wide mount the app root carries, in a real browser, because the
// gate it turns on is a platform reading a fake cannot stand in for: this suite
// runs in an ordinary Chromium tab, which is exactly the runtime the runner must
// not fire in. The runner it starts is injected -- what is under test is the
// gate and the mount's lifetime, not the tick, which is
// test/unit/managedScheduleRunner.test.ts.

const app = createAppMount();

afterEach(async () => {
  await flushPendingUpdates();
  app.unmount();
});

describe("the scheduled runner's mount", () => {
  test("reads this ordinary tab as a non-installed runtime", () => {
    // The premise the gate rests on, measured rather than assumed: a tab the
    // operator opened is not the installed app runtime, and the display-mode
    // query is what says so.
    expect(isInstalledRuntime()).toBe(false);
  });

  test("fires in an installed runtime and not in this tab, from the same render", async () => {
    const inThisTab = vi.fn();
    const inAnInstalledRuntime = vi.fn();

    // Both mounts render and settle together, so "the tab did not fire" is not
    // a race the assertion won by being early.
    app.render(
      createElement(
        Fragment,
        null,
        createElement(ScheduledExchangeRunner, { start: inThisTab }),
        createElement(ScheduledExchangeRunner, {
          start: inAnInstalledRuntime,
          isInstalledRuntime: () => true,
        }),
      ),
    );
    await vi.waitFor(() => {
      expect(inAnInstalledRuntime).toHaveBeenCalledTimes(1);
    });

    expect(inThisTab).not.toHaveBeenCalled();
  });

  test("binds the runner it starts to the mount's own lifetime", async () => {
    const start = vi.fn();

    app.render(
      createElement(ScheduledExchangeRunner, {
        start,
        isInstalledRuntime: () => true,
      }),
    );
    await vi.waitFor(() => {
      expect(start).toHaveBeenCalledTimes(1);
    });

    const runtime = start.mock.calls[0][0] as ManagedScheduleRuntimeOptions;
    expect(runtime.signal.aborted).toBe(false);
    app.unmount();
    // The runtime is stopped when the mount goes, so a runner never outlives
    // the page that started it.
    expect(runtime.signal.aborted).toBe(true);
  });
});
