/// <reference types="@vitest/browser-playwright/context" />

import { describe, expect, test } from "vitest";

import { createBrowserPsiEngineFactory } from "@psi/psiCryptoController";
import { defaultSpawnPsiCryptoWorker } from "@psi/psiCryptoWorkerClient";

import type {
  PsiCryptoWorker,
  SpawnPsiCryptoWorker,
} from "@psi/psiCryptoController";
import type { PsiEngine } from "@psilink/core";

// The browser PSI crypto offload (board item 209368277), exercised against the REAL
// Vite-native worker running the REAL WASM engine in a real browser. The host-side
// dispatch plumbing (reply routing, fault handling, dispose ordering) is pinned in
// Node with a fake worker (test/unit/psiCryptoController.test.ts); this closes the gap
// end to end -- that the actual worker module, constructed via `new Worker(new
// URL(...))` and loading `@openmined/psi.js/psi_wasm_worker`, runs the masking
// correctly (byte-identical intersection) AND tears down cleanly on every terminal
// path -- which only a real Worker + real WASM can prove.

// The starter's and joiner's value lists; the overlap is {charlie, delta}, so the
// joiner learns those two of its own values matched and nothing else.
const STARTER_VALUES = ["alpha", "bravo", "charlie", "delta"];
const JOINER_VALUES = ["charlie", "delta", "echo", "foxtrot"];
const EXPECTED_MATCH_VALUES = new Set(["charlie", "delta"]);

// A spawner that wraps the real one and counts terminate() calls per worker, so a test
// can assert the worker was actually torn down (a real Web Worker fires no event on
// terminate, so its disposal is otherwise unobservable). Wraps `terminate` in place on
// the real worker rather than proxying the whole object, so the host handle still sets
// onmessage/onerror on -- and posts to -- the genuine worker.
function trackingSpawner(): {
  spawn: SpawnPsiCryptoWorker;
  terminations: () => number;
} {
  let terminations = 0;
  const spawn: SpawnPsiCryptoWorker = (init) => {
    const worker: PsiCryptoWorker = defaultSpawnPsiCryptoWorker(init);
    const realTerminate = worker.terminate.bind(worker);
    worker.terminate = () => {
      terminations += 1;
      realTerminate();
    };
    return worker;
  };
  return { spawn, terminations: () => terminations };
}

// Drive the full engine round-trip in the participant's order and return the joiner's
// association table [localIndices, partnerIndices].
async function runRoundTrip(
  starter: PsiEngine,
  joiner: PsiEngine,
): Promise<[Array<number>, Array<number>]> {
  const { setup } = await starter.createServerSetup(STARTER_VALUES);
  await joiner.receiveServerSetup(setup);
  const request = await joiner.createClientRequest(JOINER_VALUES);
  const response = await starter.processClientRequest(request);
  return joiner.computeAssociationTable(response);
}

describe("PSI crypto Web Worker (real Vite-native worker, real WASM)", () => {
  test("the exchange completes correctly with the worker in place", async () => {
    const { spawn, terminations } = trackingSpawner();
    const factory = createBrowserPsiEngineFactory(spawn);
    const starter = factory("starter", "server");
    const joiner = factory("joiner", "client");

    let table: [Array<number>, Array<number>];
    try {
      table = await runRoundTrip(starter, joiner);
    } finally {
      starter.dispose();
      joiner.dispose();
    }

    // The real workers found exactly the overlap. table[0] indexes the joiner's own
    // request values (request order preserves input order, so it is key- and
    // backend-independent, unlike the partner index in table[1], which comes back in
    // the setup's key-dependent sorted order), so mapping those indices back to values
    // recovers the deterministic ground truth.
    expect(table[0]).toHaveLength(EXPECTED_MATCH_VALUES.size);
    expect(table[1]).toHaveLength(EXPECTED_MATCH_VALUES.size);
    const matchedJoinerValues = new Set(
      table[0].map((index) => JOINER_VALUES[index]),
    );
    expect(matchedJoinerValues).toEqual(EXPECTED_MATCH_VALUES);

    // Both workers were torn down by dispose() -- no leak past the exchange.
    expect(terminations()).toBe(2);
  }, 30_000);

  // The acceptance criterion: the worker is torn down on every exchange-end path.
  // runExchange funnels success, error, and abort through the participant's dispose()
  // in its finally; at the engine seam each is dispose() after that prior state.
  describe("the worker is torn down on each terminal path", () => {
    test("success: after a completed crypto call", async () => {
      const { spawn, terminations } = trackingSpawner();
      const engine = createBrowserPsiEngineFactory(spawn)("starter", "server");
      const { setup } = await engine.createServerSetup(STARTER_VALUES);
      expect(setup.byteLength).toBeGreaterThan(0);
      engine.dispose();
      expect(terminations()).toBe(1);
    }, 30_000);

    test("error: after a crypto call the worker rejects", async () => {
      const { spawn, terminations } = trackingSpawner();
      const engine = createBrowserPsiEngineFactory(spawn)("joiner", "client");
      // A role-guard violation (a joiner has no server key) rejects inside the worker
      // and surfaces as a rejected call over the boundary -- the error terminal path.
      await expect(
        engine.processClientRequest(new Uint8Array()),
      ).rejects.toThrow(/server role/);
      engine.dispose();
      expect(terminations()).toBe(1);
    }, 30_000);

    test("abort: while a crypto call is still in flight", async () => {
      const { spawn, terminations } = trackingSpawner();
      const engine = createBrowserPsiEngineFactory(spawn)("starter", "server");
      // Post a masking op and, without awaiting it, dispose the engine (an exchange
      // aborted mid-round): the outstanding call must reject and the worker terminate,
      // never leave the call hanging on a torn-down worker.
      const pending = engine.createServerSetup(STARTER_VALUES);
      engine.dispose();
      await expect(pending).rejects.toThrow(/disposed/);
      expect(terminations()).toBe(1);
    }, 30_000);
  });
});
