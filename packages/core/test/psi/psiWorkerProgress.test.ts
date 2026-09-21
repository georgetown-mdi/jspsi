import { expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import {
  WorkerPsiEngine,
  servePsiWorker,
  type PsiWorkerHandle,
  type PsiWorkerResponse,
} from "../../src/psi/psiWorkerEngine";

// What a mid-operation tick may carry across the worker boundary, and what
// reaches the host. The ticks ride the same channel as the crypto results, so
// the shape assertion is the control: an id and a count, and nothing that could
// hold an element, a value, or an index.

const psiLibrary = await PSI();

const CHUNK_ELEMENTS = 20;
const VALUES = Array.from({ length: 100 }, (_, index) => `v-${index}`);
const BETWEEN_CHUNKS = [20, 40, 60, 80];

// A WorkerPsiEngine over an in-process dispatcher, chunking at a size a unit
// run can afford, with every posted message kept. structuredClone at the
// boundary is what a real worker does, so anything unclonable throws here
// exactly as it would in production.
function chunkingWorkerEngine(): {
  engine: WorkerPsiEngine;
  posted: Array<PsiWorkerResponse>;
} {
  const posted: Array<PsiWorkerResponse> = [];
  let deliver: (response: PsiWorkerResponse) => void = () => {};
  const dispatch = servePsiWorker(
    psiLibrary,
    { role: "starter", id: "server", mode: "identifier-revealing" },
    (response) => {
      const cloned = structuredClone(response);
      posted.push(cloned);
      deliver(cloned);
    },
    { chunkElements: CHUNK_ELEMENTS },
  );
  const handle: PsiWorkerHandle = {
    postMessage: (request) => dispatch(structuredClone(request)),
    setHandlers: ({ onMessage }) => {
      deliver = onMessage;
    },
    terminate: () => {},
  };
  return { engine: new WorkerPsiEngine(handle), posted };
}

test("a progress message holds an id and a count, and nothing else", async () => {
  const { engine, posted } = chunkingWorkerEngine();
  const seen: Array<number> = [];
  engine.observeProcessedElements((processed) => seen.push(processed));
  try {
    await engine.createServerSetup(VALUES);
  } finally {
    engine.dispose();
  }

  const ticks = posted.slice(0, -1);
  expect(seen).toStrictEqual(BETWEEN_CHUNKS);
  // Every tick precedes the one reply that settles the call: the worker posts
  // them while it is still inside the crypto.
  expect(posted.at(-1)).toHaveProperty("ok", true);
  expect(ticks).toHaveLength(BETWEEN_CHUNKS.length);
  for (const tick of ticks) {
    expect(Object.keys(tick).sort()).toStrictEqual(["id", "processed"]);
    const { id, processed } = tick as { id: number; processed: number };
    expect(Number.isInteger(id)).toBe(true);
    expect(Number.isInteger(processed)).toBe(true);
    expect(processed).toBeLessThan(VALUES.length);
  }
  expect(ticks.map((tick) => (tick as { id: number }).id)).toStrictEqual(
    ticks.map(() => (posted.at(-1) as { id: number }).id),
  );
});

test("a tick for a call no longer outstanding reaches no reporter", () => {
  let deliver: (response: PsiWorkerResponse) => void = () => {};
  const engine = new WorkerPsiEngine({
    postMessage: () => {},
    setHandlers: ({ onMessage }) => {
      deliver = onMessage;
    },
    terminate: () => {},
  });
  const seen: Array<number> = [];
  engine.observeProcessedElements((processed) => seen.push(processed));
  deliver({ id: 7, processed: 40 });
  expect(seen).toStrictEqual([]);
});
