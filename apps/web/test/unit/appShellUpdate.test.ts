import { afterEach, describe, expect, test } from "vitest";

import {
  SKIP_WAITING_MESSAGE,
  WARM_ROUTES_MESSAGE,
  appShellUpdateReady,
  applyAppShellUpdate,
  registerAppShell,
  resetAppShellUpdate,
  subscribeAppShellUpdate,
} from "@utils/appShellUpdate";

import { serviceWorkerString } from "../utils/serviceWorkerHarness";

import type { ShellContainer, ShellWorker } from "@utils/appShellUpdate";

// The client half of the app-shell update path: which worker states are an
// "update is ready" the operator is told about, and what applying one does. It is
// a state machine over the service-worker container's events, so it is driven
// here with a fabricated container rather than a real registration -- the
// worker's own half (install without skipWaiting, activate's cache purge, the
// skip-waiting message) is test/unit/serviceWorker.test.ts.

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

afterEach(() => {
  resetAppShellUpdate();
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
  test("tells the waiting worker to take over and reloads on the swap", async () => {
    const waiting = fakeWorker("installed");
    const fake = fakeContainer({
      controller: fakeWorker("activated").worker,
      waiting: waiting.worker,
    });
    let reloads = 0;
    await registerAppShell(fake.container, { reload: () => (reloads += 1) });

    applyAppShellUpdate();

    expect(waiting.messages).toEqual([SKIP_WAITING_MESSAGE]);
    expect(reloads).toBe(0);

    fake.changeController();

    expect(reloads).toBe(1);
  });

  test("does nothing when no worker is waiting", async () => {
    const fake = fakeContainer({ controller: fakeWorker("activated").worker });
    let reloads = 0;
    await registerAppShell(fake.container, { reload: () => (reloads += 1) });

    applyAppShellUpdate();
    fake.changeController();

    expect(reloads).toBe(0);
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

  test("is not asked for on the controller change an applied update causes", async () => {
    const controller = fakeWorker("activated");
    const waiting = fakeWorker("installed");
    const fake = fakeContainer({
      controller: controller.worker,
      waiting: waiting.worker,
    });
    await registerAppShell(fake.container, {
      reload: () => undefined,
      isInstalledRuntime: () => true,
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
