import { afterEach, describe, expect, test, vi } from "vitest";

import {
  SKIP_WAITING_MESSAGE,
  WARM_ROUTES_MESSAGE,
  appShellUpdateReady,
  applyAppShellUpdate,
  registerAppShell,
  resetAppShellUpdate,
  subscribeAppShellUpdate,
} from "@utils/appShellUpdate";

import {
  createServiceWorkerHarness,
  serviceWorkerString,
} from "../../utils/serviceWorkerHarness";

import type { ShellContainer, ShellWorker } from "@utils/appShellUpdate";

// The client half of the app-shell update path -- which worker states count as
// "update is ready", and what applying one does -- driven with a fabricated
// container. The worker's own half (install without skipWaiting, activate's
// cache purge, the skip-waiting message) is test/unit/utils/serviceWorker.test.ts.
// The apply tests use the shipped `apps/web/public/serviceWorker.js` behind
// the harness, so a pending update is measured by its own `skipWaiting()` call.

/** A worker whose state a test advances, firing `statechange` as a real one does. */
function fakeWorker(state = "installing") {
  const listeners: Array<() => void> = [];
  const messages: Array<unknown> = [];
  const worker = {
    state,
    postMessage: (message: unknown) => messages.push(message),
    addEventListener: (_type: "statechange", listener: () => void) =>
      listeners.push(listener),
  };
  return {
    worker: worker as ShellWorker,
    messages,
    advanceTo(next: string) {
      worker.state = next;
      for (const listener of listeners) listener();
    },
  };
}

/** A container and registration a test drives, standing in for
 * `navigator.serviceWorker`. */
function fakeContainer(options: {
  controller?: ShellWorker | null;
  waiting?: ShellWorker | null;
}) {
  const updateFound: Array<() => void> = [];
  const controllerChange: Array<() => void> = [];
  const registration = {
    installing: null as ShellWorker | null,
    waiting: options.waiting ?? null,
    addEventListener: (_type: "updatefound", listener: () => void) =>
      updateFound.push(listener),
  };
  const container: ShellContainer = {
    controller: options.controller ?? null,
    register: () => Promise.resolve(registration),
    addEventListener: (_type: "controllerchange", listener: () => void) =>
      controllerChange.push(listener),
  };
  return {
    container,
    registration,
    /** Announce a newly installing worker, as the browser does when it finds a
     * redeployed script. */
    findUpdate(worker: ShellWorker) {
      registration.installing = worker;
      for (const listener of updateFound) listener();
    },
    changeController() {
      for (const listener of controllerChange) listener();
    },
  };
}

/**
 * A waiting worker that is the shipped `public/serviceWorker.js`, running in the
 * harness: what the client posts is delivered to the file that deploys, and
 * whether the update was applied is read off that worker's `skipWaiting()`.
 */
function shippedWaitingWorker() {
  const harness = createServiceWorkerHarness();
  const delivered: Array<Promise<void>> = [];
  const worker: ShellWorker = {
    state: "installed",
    postMessage: (message: unknown) => {
      delivered.push(harness.postMessage(message));
    },
    addEventListener: () => undefined,
  };
  return {
    worker,
    /** How many times the shipped worker has been made to take over. */
    async takeovers(): Promise<number> {
      await Promise.all(delivered);
      return harness.skipWaitingCalls;
    },
  };
}

/** The page-unload boundary, which is where a test decides the fate of the reload
 * the operator pressed: `unloadPage` is the page going away, and never calling
 * it is the operator declining the browser's confirmation and staying. */
function fakePageUnloading() {
  const listeners: Array<() => void> = [];
  return {
    onPageUnloading: (listener: () => void) => {
      listeners.push(listener);
    },
    /** How many listeners the module has armed. */
    get armed(): number {
      return listeners.length;
    },
    unloadPage(): void {
      for (const listener of listeners) listener();
    },
  };
}

afterEach(() => {
  resetAppShellUpdate();
  vi.unstubAllGlobals();
});

describe("the first install", () => {
  test("is not announced as an update, since it activates by itself", async () => {
    const fake = fakeContainer({ controller: null });
    await registerAppShell(fake.container);
    const installed = fakeWorker();

    fake.findUpdate(installed.worker);
    installed.advanceTo("installed");

    expect(appShellUpdateReady()).toBe(false);
  });

  test("claiming the page does not reload it", async () => {
    let reloads = 0;
    const fake = fakeContainer({ controller: null });
    await registerAppShell(fake.container, { reload: () => (reloads += 1) });

    fake.changeController();

    expect(reloads).toBe(0);
  });
});

describe("a redeployment", () => {
  test("is announced once the new worker reaches installed", async () => {
    const fake = fakeContainer({ controller: fakeWorker("activated").worker });
    const notified: Array<boolean> = [];
    subscribeAppShellUpdate(() => notified.push(appShellUpdateReady()));
    await registerAppShell(fake.container);
    const installing = fakeWorker();

    fake.findUpdate(installing.worker);
    expect(appShellUpdateReady()).toBe(false);

    installing.advanceTo("installed");

    expect(appShellUpdateReady()).toBe(true);
    expect(notified).toEqual([true]);
  });

  test("installed on an earlier visit is announced at registration", async () => {
    const waiting = fakeWorker("installed");
    const fake = fakeContainer({
      controller: fakeWorker("activated").worker,
      waiting: waiting.worker,
    });

    await registerAppShell(fake.container);

    expect(appShellUpdateReady()).toBe(true);
  });
});

describe("applying an update", () => {
  /** A registered page with the shipped worker waiting behind its banner, and
   * the boundaries that decide what pressing Reload comes to. */
  async function readyToApply() {
    const shipped = shippedWaitingWorker();
    const unloading = fakePageUnloading();
    const fake = fakeContainer({
      controller: fakeWorker("activated").worker,
      waiting: shipped.worker,
    });
    const reloads = { count: 0 };
    await registerAppShell(fake.container, {
      reload: () => (reloads.count += 1),
      onPageUnloading: unloading.onPageUnloading,
    });
    return { shipped, unloading, fake, reloads };
  }

  test("reloads the page and has the worker take over as it goes", async () => {
    const { shipped, unloading, reloads } = await readyToApply();

    applyAppShellUpdate();

    expect(reloads.count).toBe(1);
    expect(await shipped.takeovers()).toBe(0);

    unloading.unloadPage();

    expect(await shipped.takeovers()).toBe(1);
  });

  test("declined, leaves the update pending and applies it on a later confirmation", async () => {
    const { shipped, unloading, reloads } = await readyToApply();

    applyAppShellUpdate();

    // The operator answers the browser's confirmation with Stay, so the page
    // never unloads: its code, its worker, and the pending update are untouched.
    expect(await shipped.takeovers()).toBe(0);
    expect(appShellUpdateReady()).toBe(true);

    applyAppShellUpdate();

    expect(reloads.count).toBe(2);
    expect(unloading.armed).toBe(1);
    expect(await shipped.takeovers()).toBe(0);

    unloading.unloadPage();

    expect(await shipped.takeovers()).toBe(1);
  });

  test("applies the newest waiting worker, not the one the operator first pressed", async () => {
    const { shipped, unloading, fake } = await readyToApply();
    applyAppShellUpdate();

    const superseding = shippedWaitingWorker();
    fake.registration.waiting = superseding.worker;
    unloading.unloadPage();

    expect(await shipped.takeovers()).toBe(0);
    expect(await superseding.takeovers()).toBe(1);
  });

  test("does nothing when nothing is waiting and nothing was announced", async () => {
    const unloading = fakePageUnloading();
    const fake = fakeContainer({ controller: fakeWorker("activated").worker });
    let reloads = 0;
    await registerAppShell(fake.container, {
      reload: () => (reloads += 1),
      onPageUnloading: unloading.onPageUnloading,
    });

    applyAppShellUpdate();

    expect(reloads).toBe(0);
    expect(unloading.armed).toBe(0);
  });

  test("reloads onto the code another tab's takeover already activated", async () => {
    const controller = fakeWorker("activated");
    const shipped = shippedWaitingWorker();
    const unloading = fakePageUnloading();
    const fake = fakeContainer({
      controller: controller.worker,
      waiting: shipped.worker,
    });
    let reloads = 0;
    await registerAppShell(fake.container, {
      reload: () => (reloads += 1),
      onPageUnloading: unloading.onPageUnloading,
    });
    expect(appShellUpdateReady()).toBe(true);

    // The other tab applies: the worker takes over origin-wide, so this tab's
    // registration has nothing waiting left and the announcement it is still
    // showing has no worker behind it.
    fake.registration.waiting = null;
    fake.changeController();

    applyAppShellUpdate();
    unloading.unloadPage();

    expect(reloads).toBe(1);
    expect(unloading.armed).toBe(0);
    expect(controller.messages).toEqual([]);
    expect(await shipped.takeovers()).toBe(0);
  });

  test("declined and then applied from another tab, still reloads and posts nothing", async () => {
    const { shipped, unloading, fake, reloads } = await readyToApply();
    applyAppShellUpdate();

    // The operator answers the confirmation with Stay, and the other tab applies
    // while this page is still on the old code with its takeover armed.
    fake.registration.waiting = null;

    applyAppShellUpdate();
    unloading.unloadPage();

    expect(reloads.count).toBe(2);
    expect(unloading.armed).toBe(1);
    expect(await shipped.takeovers()).toBe(0);
  });

  test("waits, by default, for the page's own pagehide -- and not for a freeze", async () => {
    const shipped = shippedWaitingWorker();
    const fake = fakeContainer({
      controller: fakeWorker("activated").worker,
      waiting: shipped.worker,
    });
    const pageHidden: Array<(event: { persisted: boolean }) => void> = [];
    vi.stubGlobal("window", {
      addEventListener: (
        type: string,
        listener: (event: { persisted: boolean }) => void,
      ) => {
        if (type === "pagehide") pageHidden.push(listener);
      },
    });
    await registerAppShell(fake.container, {
      reload: () => undefined,
      isInstalledRuntime: () => false,
    });

    applyAppShellUpdate();
    for (const listener of pageHidden) listener({ persisted: true });

    // A persisted pagehide is the back/forward cache freezing the page, which
    // can be restored still running this code -- not the page going away.
    expect(pageHidden).toHaveLength(1);
    expect(await shipped.takeovers()).toBe(0);

    for (const listener of pageHidden) listener({ persisted: false });

    expect(await shipped.takeovers()).toBe(1);
  });
});

describe("warming every route's code", () => {
  test("is asked for from an installed app, at registration and on a claim", async () => {
    const controller = fakeWorker("activated");
    const fake = fakeContainer({ controller: controller.worker });

    await registerAppShell(fake.container, { isInstalledRuntime: () => true });
    expect(controller.messages).toEqual([WARM_ROUTES_MESSAGE]);

    fake.changeController();

    expect(controller.messages).toEqual([
      WARM_ROUTES_MESSAGE,
      WARM_ROUTES_MESSAGE,
    ]);
  });

  test("is not asked for from an ordinary browser tab", async () => {
    const controller = fakeWorker("activated");
    const fake = fakeContainer({ controller: controller.worker });

    await registerAppShell(fake.container, { isInstalledRuntime: () => false });
    fake.changeController();

    expect(controller.messages).toEqual([]);
  });

  test("is not asked for once this page has asked for a takeover", async () => {
    const controller = fakeWorker("activated");
    const waiting = fakeWorker("installed");
    const fake = fakeContainer({
      controller: controller.worker,
      waiting: waiting.worker,
    });
    await registerAppShell(fake.container, {
      reload: () => undefined,
      isInstalledRuntime: () => true,
      onPageUnloading: fakePageUnloading().onPageUnloading,
    });
    controller.messages.length = 0;

    applyAppShellUpdate();
    fake.changeController();

    expect(controller.messages).toEqual([]);
  });
});

describe("registration", () => {
  test("takes the origin root as its scope and keeps the HTTP cache out of the update check", async () => {
    const calls: Array<[string, unknown]> = [];
    const fake = fakeContainer({ controller: null });
    const container: ShellContainer = {
      ...fake.container,
      register: (scriptUrl, options) => {
        calls.push([scriptUrl, options]);
        return Promise.resolve(fake.registration);
      },
    };

    await registerAppShell(container);

    expect(calls).toEqual([
      ["/serviceWorker.js", { scope: "/", updateViaCache: "none" }],
    ]);
  });

  test("that the browser refuses leaves the app running from the network", async () => {
    const fake = fakeContainer({ controller: fakeWorker("activated").worker });
    let reloads = 0;
    const container: ShellContainer = {
      ...fake.container,
      register: () =>
        Promise.reject(new TypeError("Failed to register a ServiceWorker")),
    };

    // register() rejects on the offline first load this feature is for, and the
    // call site fires this without awaiting it: a rejection here would be an
    // unhandled one.
    await expect(
      registerAppShell(container, { reload: () => (reloads += 1) }),
    ).resolves.toBeUndefined();

    expect(appShellUpdateReady()).toBe(false);
    applyAppShellUpdate();
    fake.changeController();
    expect(reloads).toBe(0);
  });
});

describe("the messages the client and the worker exchange", () => {
  test("are the same strings on both sides", () => {
    expect(SKIP_WAITING_MESSAGE).toBe(
      serviceWorkerString("SKIP_WAITING_MESSAGE"),
    );
    expect(WARM_ROUTES_MESSAGE).toBe(
      serviceWorkerString("WARM_ROUTES_MESSAGE"),
    );
  });
});
