import { afterEach, describe, expect, test, vi } from "vitest";

import {
  appShellUpdateReady,
  registerAppShell,
  resetAppShellUpdate,
} from "@utils/appShellUpdate";
import { generateSharedSecret, getDefaultLinkageTerms } from "@psilink/core";

import {
  buildManagedExchangeRecord,
  composeManagedExchangeFile,
} from "@psi/managed/managedExchangeRecord";
import { startManagedScheduleRuntime } from "@psi/managed/managedScheduleRuntime";
import { tickManagedSchedules } from "@psi/managed/managedScheduleRunner";

import {
  createServiceWorkerHarness,
  serviceWorkerSourceModel,
} from "../../utils/serviceWorkerHarness";

import type { ShellContainer, ShellWorker } from "@utils/appShellUpdate";

import type { ManagedExchangeRecord } from "@psi/managed/managedExchangeRecord";
import type { ManagedLocalState } from "@psi/managed/managedLocalStateShape";
import type { ManagedScheduleTickSeams } from "@psi/managed/managedScheduleRunner";

/**
 * The two runtime boundaries the unattended runner rests on, as checks rather
 * than as prose: an exchange is executed by the app runtime and by nothing else,
 * and a scheduled run never applies a waiting app-shell update.
 *
 * Both are claims about what does NOT happen, which is exactly the kind a
 * comment cannot keep true (CONTRIBUTING.md, Code Conventions).
 */

// ---------------------------------------------------------------------------
// No exchange runs in the service worker.

/** The event types the shipped worker registers a listener for. Anything past
 * these is a way for the browser to WAKE the worker on its own. */
const REGISTERED_WORKER_EVENTS = ["install", "activate", "message", "fetch"];

/**
 * Capabilities running an exchange needs, none of which the worker may reach:
 * the record store the secret and schedule live in, the two transports a live
 * exchange uses, the PSI engine and the worker it runs in, and the one call a
 * classic worker script pulls further code in with.
 */
const EXCHANGE_CAPABILITIES = [
  "indexedDB",
  "RTCPeerConnection",
  "WebSocket",
  "WebAssembly",
  "Worker",
  "importScripts",
];

/** Which of {@link EXCHANGE_CAPABILITIES} a worker source reaches, from anywhere
 * in it. The guard, extracted so it can be run against a source that must fail
 * it as well as against the shipped one. */
function exchangeCapabilitiesReached(source?: string): Array<string> {
  const model = serviceWorkerSourceModel(source);
  const referenced = new Set<string>([
    ...[...model.functions.values()].flatMap((names) => [...names]),
    ...model.outsideFunctions.map((reference) => reference.name),
  ]);
  return EXCHANGE_CAPABILITIES.filter((capability) =>
    referenced.has(capability),
  );
}

describe("the app-shell service worker", () => {
  test("registers no background wakeup, so nothing can be scheduled into it", () => {
    const harness = createServiceWorkerHarness();

    expect([...harness.registeredEventTypes]).toEqual(REGISTERED_WORKER_EVENTS);
    // Named explicitly as well as bounded by the list above: Periodic
    // Background Sync's short opportunistic windows cannot sustain a live
    // two-party exchange, so the runner is an open app runtime and the worker
    // is not a second one by design (docs/MANAGED_EXCHANGE.md, "The
    // automation goal and its platform envelope").
    expect(harness.registeredEventTypes).not.toContain("periodicsync");
    expect(harness.registeredEventTypes).not.toContain("sync");
    expect(harness.registeredEventTypes).not.toContain("push");
  });

  test("reaches nothing an exchange would need, from any of its code", () => {
    expect(exchangeCapabilitiesReached()).toEqual([]);
  });

  test("would be caught reaching one through the global scope it runs in", () => {
    // A guard nothing can fail asserts nothing, and this one nearly was: a
    // capability captured as `self.indexedDB` -- a worker script's prevailing
    // idiom -- names the global object in scope and the capability as a
    // property off it, so a model reading only the scope half saw `self` and
    // passed.
    expect(
      exchangeCapabilitiesReached(
        'self.addEventListener("message", () => {\n' +
          '  const db = self.indexedDB.open("records");\n' +
          "  void db;\n" +
          "});\n",
      ),
    ).toEqual(["indexedDB"]);
    expect(
      exchangeCapabilitiesReached(
        "function compile(bytes) {\n" +
          "  return globalThis.WebAssembly.compile(bytes);\n" +
          "}\n",
      ),
    ).toEqual(["WebAssembly"]);
  });
});

// ---------------------------------------------------------------------------
// The scheduled runner never applies a waiting app-shell update.

/** A worker whose state never changes; the update path only reads it. */
function fakeWorker(state: string): ShellWorker {
  return {
    state,
    postMessage: () => undefined,
    addEventListener: () => undefined,
  };
}

/** A container reporting a worker already installed and waiting behind the one
 * controlling this page -- the state an announced update sits in. */
function containerWithWaitingUpdate(): ShellContainer {
  const registration = {
    installing: null,
    waiting: fakeWorker("installed"),
    addEventListener: () => undefined,
  };
  return {
    controller: fakeWorker("activated"),
    register: () => Promise.resolve(registration),
    addEventListener: () => undefined,
  };
}

function dueRecord(): ManagedExchangeRecord {
  return buildManagedExchangeRecord({
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: { channel: "webrtc", host: "signaling.example.org" },
      linkageTerms: getDefaultLinkageTerms("County Health Dept"),
    }),
    side: "inviter",
    sharedSecret: generateSharedSecret(),
    inputFileHandle: {} as FileSystemFileHandle,
    schedule: {
      anchor: "2026-01-06T14:00:00.000Z",
      intervalDays: 7,
      windowSeconds: 10_800,
      nextWindow: "2026-01-06T14:00:00.000Z",
      consecutiveMisses: 0,
    },
  });
}

/** Seams over one due record whose run succeeds, so a tick goes all the way
 * through: catch-up, an attempt, and the window's bookkeeping write. */
function seamsForDueWindow(record: ManagedExchangeRecord): {
  seams: ManagedScheduleTickSeams;
  attempts: () => number;
} {
  let attempts = 0;
  return {
    attempts: () => attempts,
    seams: {
      now: () => Date.parse("2026-01-06T14:30:00.000Z"),
      listRecords: () =>
        Promise.resolve({ records: [record], unreadableIds: [] }),
      listLocalState: () =>
        Promise.resolve(new Map<string, ManagedLocalState>()),
      persistAdvance: () => Promise.resolve(record),
      runAttempt: () => {
        attempts += 1;
        return Promise.resolve(undefined);
      },
      delay: () => Promise.resolve(),
      stopped: () => false,
    },
  };
}

afterEach(() => {
  resetAppShellUpdate();
  vi.useRealTimers();
});

describe("a scheduled run and a waiting app-shell update", () => {
  test("leaves the update waiting: the runner never reloads the runtime under itself", async () => {
    const reload = vi.fn();
    await registerAppShell(containerWithWaitingUpdate(), {
      reload,
      isInstalledRuntime: () => true,
      onPageUnloading: () => undefined,
    });
    expect(appShellUpdateReady()).toBe(true);

    const record = dueRecord();
    const { seams, attempts } = seamsForDueWindow(record);
    const [entry] = await tickManagedSchedules(seams);

    expect(attempts()).toBe(1);
    expect(entry.disposition).toBe("succeeded");
    // A waiting worker takes over at the next cold start. Applying it means a
    // reload, and a reload during a run raises a confirmation an unattended
    // runtime has nobody to answer -- so the runner leaves it alone and the
    // offer stands for whoever opens the app next.
    expect(reload).not.toHaveBeenCalled();
    expect(appShellUpdateReady()).toBe(true);
  });

  test("holds across the host loop that wakes the tick, not only one tick", async () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    await registerAppShell(containerWithWaitingUpdate(), {
      reload,
      isInstalledRuntime: () => true,
      onPageUnloading: () => undefined,
    });

    const { seams } = seamsForDueWindow(dueRecord());
    const controller = new AbortController();
    startManagedScheduleRuntime({
      signal: controller.signal,
      intervalMs: 1000,
      seams,
    });
    await vi.advanceTimersByTimeAsync(5000);
    controller.abort();

    expect(reload).not.toHaveBeenCalled();
    expect(appShellUpdateReady()).toBe(true);
  });
});
