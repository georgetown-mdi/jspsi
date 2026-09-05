/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import log from "loglevel";

import { Fragment, createElement } from "react";

import {
  RUNNER_LOAD_FAILURE_NOTICE,
  ScheduledExchangeRunner,
  startInstalledRuntimeRunner,
} from "@components/ScheduledExchangeRunner";
import { isInstalledRuntime } from "@utils/installedRuntime";

import { createAppMount, flushPendingUpdates } from "./renderApp";

import type { ManagedScheduleRuntimeOptions } from "@psi/managed/managedScheduleRuntime";

// This suite mounts in a real Chromium tab, the runtime the runner must not
// fire in. The runner it starts is injected -- this file tests the gate and
// the mount's lifetime, not the tick, which is
// test/unit/managedScheduleRunner.test.ts.

const app = createAppMount();

afterEach(async () => {
  await flushPendingUpdates();
  app.unmount();
});

describe("the scheduled runner's mount", () => {
  test("classifies this ordinary tab as a non-installed runtime", () => {
    // The assumption the gate rests on, measured rather than assumed: a tab
    // the operator opened is not the installed app runtime, and the
    // display-mode query is what says so.
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

  test("stays out of a console build even in an installed runtime", async () => {
    const inTheConsole = vi.fn();
    const inTheHostedApp = vi.fn();

    // Both installed, so the console build is the only difference between them.
    app.render(
      createElement(
        Fragment,
        null,
        createElement(ScheduledExchangeRunner, {
          start: inTheConsole,
          isInstalledRuntime: () => true,
          isConsoleBuild: () => true,
        }),
        createElement(ScheduledExchangeRunner, {
          start: inTheHostedApp,
          isInstalledRuntime: () => true,
          isConsoleBuild: () => false,
        }),
      ),
    );
    await vi.waitFor(() => {
      expect(inTheHostedApp).toHaveBeenCalledTimes(1);
    });

    expect(inTheConsole).not.toHaveBeenCalled();
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

describe("the runner's chunk, which the mount loads on demand", () => {
  /** A load that resolves, handing back a runtime start the test can watch and
   * the promise it resolved on -- the runner's own continuation is registered on
   * that promise first, so awaiting it puts an assertion after the continuation
   * ran rather than racing it. */
  function loaderFor(started: () => void) {
    const loads: Array<Promise<unknown>> = [];
    return {
      load: () => {
        const chunk = Promise.resolve({ startManagedScheduleRuntime: started });
        loads.push(chunk);
        return chunk;
      },
      lastLoad: () => loads[loads.length - 1],
    };
  }

  test("starts the runtime it loaded, and not one whose mount already went", async () => {
    const started = vi.fn();
    const loader = loaderFor(started);

    const live = new AbortController();
    startInstalledRuntimeRunner({ signal: live.signal }, loader.load);
    await vi.waitFor(() => {
      expect(started).toHaveBeenCalledTimes(1);
    });

    const gone = new AbortController();
    gone.abort();
    startInstalledRuntimeRunner({ signal: gone.signal }, loader.load);
    await loader.lastLoad();

    expect(started).toHaveBeenCalledTimes(1);
  });

  test("makes a load that never arrives visible rather than silently never running", async () => {
    const error = vi.spyOn(log, "error").mockImplementation(() => undefined);
    // What an offline first launch or a cached shell asking a newer deployment
    // for a chunk it no longer serves produces: a rejected import that nothing
    // else in this mount is watching.
    const failure = new Error("this deployment serves no such chunk");

    startInstalledRuntimeRunner({ signal: new AbortController().signal }, () =>
      Promise.reject(failure),
    );

    await vi.waitFor(() => {
      expect(error).toHaveBeenCalledTimes(1);
    });
    expect(error).toHaveBeenCalledWith(RUNNER_LOAD_FAILURE_NOTICE, failure);
    error.mockRestore();
  });
});
