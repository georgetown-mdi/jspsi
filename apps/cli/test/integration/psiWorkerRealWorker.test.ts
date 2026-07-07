import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import { afterEach, expect, test } from "vitest";
import {
  WorkerPsiEngine,
  type PsiEngine,
  type PsiWorkerHandle,
  type PsiWorkerRequest,
  type PsiWorkerResponse,
} from "@psilink/core";

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
const workerTest = test.skipIf(!existsSync(workerEntry));

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

// Spawn a real worker on the shipping bundle and wrap it as psiWorkerHost.ts does,
// but expose the Worker so a test can observe its teardown directly.
function spawnEngine(role: "starter" | "joiner", id: string): SpawnedEngine {
  const worker = new Worker(workerEntry, { workerData: { role, id } });
  spawned.push(worker);
  const errors: unknown[] = [];
  // Mirror psiWorkerHost.ts, including its exit handling: an exit's CODE is
  // unreliable -- a worker terminated before it finishes starting exits 0, a
  // started one exits 1 -- so a fault is any exit WE did not initiate, not any
  // nonzero code. (Gating on `code !== 0` here would let an immediate terminate,
  // which exits 0, leave a pending call hanging.)
  let terminating = false;
  const handle: PsiWorkerHandle = {
    postMessage: (request: PsiWorkerRequest) => worker.postMessage(request),
    setHandlers: ({ onMessage, onError }) => {
      worker.on("message", (response: PsiWorkerResponse) =>
        onMessage(response),
      );
      worker.on("error", (error) => {
        errors.push(error);
        onError(error);
      });
      worker.on("exit", () => {
        if (!terminating) onError(new Error("PSI worker exited unexpectedly"));
      });
    },
    terminate: () => {
      terminating = true;
      void worker.terminate();
    },
  };
  return { engine: new WorkerPsiEngine(handle), worker, errors };
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
