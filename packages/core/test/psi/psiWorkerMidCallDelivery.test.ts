import { Worker } from "node:worker_threads";

import { expect, test } from "vitest";

// The runtime assumption the whole mid-operation progress path rests on: a
// worker that posts while it is still inside ONE synchronous message handler
// reaches the host then, not when the handler returns. Without it the ticks
// servePsiWorker posts between chunks would all land with the reply and show
// the operator nothing. Driven against the real worker_threads runtime rather
// than argued, because it is Node's behavior, not this repository's.
//
// The browser's Web Worker is the same shape (the two share the PSI worker
// boundary in psiWorkerEngine.ts) but is not pinned here; a browser runtime is
// out of this suite's reach.

const BUSY_MS = 60;
const TICKS = 3;

// A worker whose single handler burns the CPU between posts, so a tick that
// arrived only on the handler's return would arrive after every burn rather
// than between them.
const WORKER_SOURCE = `
  const { parentPort } = require("node:worker_threads");
  parentPort.on("message", ({ ticks, busyMs }) => {
    for (let tick = 0; tick < ticks; tick += 1) {
      const until = Date.now() + busyMs;
      while (Date.now() < until);
      parentPort.postMessage({ id: 0, processed: tick + 1 });
    }
    parentPort.postMessage({ id: 0, ok: true });
  });
`;

test("a worker's post reaches the host mid-handler, not on its return", async () => {
  const worker = new Worker(WORKER_SOURCE, { eval: true });
  const arrivals: Array<{ message: unknown; atMs: number }> = [];
  const startedAt = Date.now();
  try {
    await new Promise<void>((resolve, reject) => {
      worker.on("error", reject);
      worker.on("message", (message: { ok?: true; processed?: number }) => {
        arrivals.push({ message, atMs: Date.now() - startedAt });
        if (message.ok === true) resolve();
      });
      worker.postMessage({ ticks: TICKS, busyMs: BUSY_MS });
    });
  } finally {
    await worker.terminate();
  }

  expect(arrivals.map(({ message }) => message)).toStrictEqual([
    { id: 0, processed: 1 },
    { id: 0, processed: 2 },
    { id: 0, processed: 3 },
    { id: 0, ok: true },
  ]);
  // Each tick arrives roughly one burn after the one before it. A runtime that
  // held them until the handler returned would put every arrival at the end,
  // so the first tick landing well before the last is the discriminating fact.
  const first = arrivals[0]!.atMs;
  const last = arrivals.at(-1)!.atMs;
  expect(last - first).toBeGreaterThanOrEqual(BUSY_MS);
});
