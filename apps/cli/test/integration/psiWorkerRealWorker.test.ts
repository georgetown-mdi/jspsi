import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import { afterEach, expect, test } from "vitest";
import { WorkerPsiEngine, type PsiEngine } from "@psilink/core";

import { createWorkerThreadHandle } from "../../src/psiWorkerHost";

// Exercises the CLI PSI crypto offload (board item 208035324) against the REAL
// shipping worker: a `worker_threads` worker running the built
// dist/psiWorker.worker.js, which loads the native-preferred backend, generates
// its own key, and answers the RPC. The rest of the suite drives the crypto
// through the in-process fallback (tests run from src, where no compiled worker
// sits beside psiWorkerHost.ts), so the worker path itself is only manually
// smoke-tested; this closes that gap end to end -- correctness AND clean teardown.
//
// The built bundle is emitted by `npm run build -w apps/cli`. CI's primary CLI
// job builds it before this suite runs; a local run must build first. When it is
// absent (the hardened-native CI legs skip the CLI build) these tests skip -- the
// worker path is unchanged there and the in-process fallback still covers the RPC.
const workerEntry = fileURLToPath(
  new URL("../../dist/psiWorker.worker.js", import.meta.url),
);
const workerBuilt = existsSync(workerEntry);
// A skipIf on a build artifact is convenient but silent: it can no-op GREEN in the
// primary CLI leg too if that leg's build step ever regresses, leaving the offload
// unexercised while the run reports success -- the exact silent-skip a prior round
// hit. So the primary leg sets PSILINK_REQUIRE_WORKER_BUILD=1, which turns a missing
// bundle into a hard failure here rather than a skip. This mirrors
// PSILINK_SFTP_CHROOT_REQUIRED in cli_build_and_test.yaml, which likewise fails rather
// than skips when its precondition is absent where it must hold. The var is unset in
// the hardened/native legs (which intentionally do not build the CLI) and in local
// src-only runs, so the suite still skips cleanly there.
if (process.env.PSILINK_REQUIRE_WORKER_BUILD === "1" && !workerBuilt) {
  throw new Error(
    `PSILINK_REQUIRE_WORKER_BUILD=1 but the CLI worker bundle is absent at ` +
      `${workerEntry}: the real-worker offload suite would silently skip. Build it ` +
      `first with \`npm run build -w apps/cli\`.`,
  );
}
const workerTest = test.skipIf(!workerBuilt);

// Every worker this file spawns, so a test that fails before its own teardown
// cannot leak a ref'd worker that would hold the vitest process open (the workers
// are deliberately NOT unref'd, exactly as production keeps the process alive
// while crypto is in flight).
const spawned: Worker[] = [];
afterEach(async () => {
  await Promise.all(
    spawned.splice(0).map((w) => w.terminate().catch(() => {})),
  );
});

interface SpawnedEngine {
  engine: WorkerPsiEngine;
  worker: Worker;
  // 'error' events the worker emitted during the run (a real fault, distinct from
  // the deliberate terminate() exit below); expected empty on a healthy exchange.
  errors: unknown[];
}

// Spawn a real worker on the shipping bundle and wrap it through the SAME
// createWorkerThreadHandle production uses, so this test exercises the real host-side
// wiring (including the exit-code handling: a worker terminated before it finishes
// starting exits 0, a started one exits 1, so a fault is any exit WE did not initiate,
// not any nonzero code) rather than a hand-rolled mirror that could drift from it. The
// Worker is returned so a test can drive and observe its teardown directly; a separate
// 'error' listener records faults for assertions -- an independent observer, not a
// reimplementation of the handle's own error routing (Node allows many listeners).
function spawnEngine(role: "starter" | "joiner", id: string): SpawnedEngine {
  const worker = new Worker(workerEntry, { workerData: { role, id } });
  spawned.push(worker);
  const errors: unknown[] = [];
  worker.on("error", (error) => errors.push(error));
  const engine = new WorkerPsiEngine(createWorkerThreadHandle(worker));
  return { engine, worker, errors };
}

// Drive the full engine round-trip in the participant's order and return the
// joiner's association table [localIndices, partnerIndices].
async function runRoundTrip(
  starter: PsiEngine,
  joiner: PsiEngine,
  starterValues: readonly string[],
  joinerValues: readonly string[],
): Promise<[number[], number[]]> {
  const { setup } = await starter.createServerSetup(starterValues);
  await joiner.receiveServerSetup(setup);
  const request = await joiner.createClientRequest(joinerValues);
  const response = await starter.processClientRequest(request);
  return joiner.computeAssociationTable(response);
}

const STARTER_VALUES = ["alpha", "bravo", "charlie", "delta"];
const JOINER_VALUES = ["charlie", "delta", "echo", "foxtrot"];
// Overlap {charlie, delta}: the joiner learns those two of its own values matched.
const EXPECTED_MATCH_VALUES = new Set(["charlie", "delta"]);

workerTest(
  "runs the full masking round-trip in real workers, finds the correct intersection, and tears down cleanly",
  async () => {
    const starter = spawnEngine("starter", "worker-starter");
    const joiner = spawnEngine("joiner", "worker-joiner");

    let workerTable: [number[], number[]];
    try {
      workerTable = await runRoundTrip(
        starter.engine,
        joiner.engine,
        STARTER_VALUES,
        JOINER_VALUES,
      );
    } finally {
      // Teardown AFTER real crypto ran in the worker is exactly the path the
      // vendored addon's worker-teardown fix guards: before it, terminating a
      // worker that had performed a masking op segfaulted the whole process (exit
      // 139), which crashes this test file rather than letting it assert. That
      // both terminate() calls resolve at all is the regression check.
      const exitCodes = await Promise.all([
        starter.worker.terminate(),
        joiner.worker.terminate(),
      ]);
      expect(exitCodes).toEqual([1, 1]);
    }

    // No worker faulted during the exchange (a load or crypto failure would emit
    // 'error'); the only exit is the clean terminate above.
    expect(starter.errors).toEqual([]);
    expect(joiner.errors).toEqual([]);

    // The real workers found exactly the overlap. table[0] indexes the joiner's
    // own request values (request order preserves input order, so it is key- and
    // backend-independent, unlike the partner index in table[1], which the library
    // returns in the setup's key-dependent sorted order), so mapping those indices
    // back to values recovers the deterministic ground truth: the joiner learns
    // that its charlie and delta matched, and nothing else.
    expect(workerTable[0]).toHaveLength(EXPECTED_MATCH_VALUES.size);
    expect(workerTable[1]).toHaveLength(EXPECTED_MATCH_VALUES.size);
    const matchedJoinerValues = new Set(
      workerTable[0].map((index) => JOINER_VALUES[index]),
    );
    expect(matchedJoinerValues).toEqual(EXPECTED_MATCH_VALUES);
  },
  30_000,
);

workerTest(
  "dispose() terminates the worker and fails subsequent calls fast",
  async () => {
    const starter = spawnEngine("starter", "dispose-starter");
    // A real masking op runs in the worker first, so dispose() tears down a worker
    // that has touched the native backend (the crash-prone state), not a fresh one.
    const { setup } = await starter.engine.createServerSetup(["x", "y", "z"]);
    expect(setup.byteLength).toBeGreaterThan(0);

    const exited = new Promise<number>((resolve) =>
      starter.worker.once("exit", resolve),
    );
    // dispose() must terminate the worker so a ref'd handle never holds the process
    // open at teardown, and mark the engine terminal.
    starter.engine.dispose();
    expect(await exited).toBe(1);

    // A call after dispose fails fast (disposed) rather than posting to the dead
    // worker and hanging.
    await expect(starter.engine.createClientRequest(["w"])).rejects.toThrow(
      /disposed/,
    );
  },
  30_000,
);

workerTest(
  "a call outstanding when the worker exits unexpectedly settles rather than hanging",
  async () => {
    const starter = spawnEngine("starter", "exit-mid-call");
    // Issue a masking op and, without awaiting it, kill the worker out from under
    // it -- an unexpected exit (a crash's exit reaches the same handler). Whether
    // the op finished just before the kill (resolved) or the exit rejected the
    // pending call via onError -> failAll, it must SETTLE; the one outcome the
    // WorkerPsiEngine's fail-fast paths forbid is a call left hanging on a dead
    // worker, which would time this test out.
    const settled = starter.engine.createServerSetup(["a", "b", "c"]).then(
      () => "resolved",
      () => "rejected",
    );
    await starter.worker.terminate();
    await expect(settled).resolves.toMatch(/^(resolved|rejected)$/);
  },
  30_000,
);
