import { availableParallelism } from "node:os";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

import { chromium } from "playwright";

import type { AddressInfo } from "node:net";

// Browser half of the worker-sharding evaluation: the same split measured on the
// node path (packages/core/test/bench/shardedPsiWasmBench.ts), run in real
// Chromium over Web Workers. Each worker loads the vendored WASM worker build
// and builds its own client from the SAME key, so the concatenated masked
// elements are the bytes one worker would have produced -- checked here on every
// configuration. The shipped browser path runs exactly one PSI worker
// (apps/web/src/psi/workers/psiCrypto.worker.ts), so that is the baseline the
// speedups are against.
//
// Nothing here is bundled into the app, and no cross-origin isolation is
// involved: the workers hold separate WASM instances rather than one shared
// memory, which is what makes this arm deployable under the app's current
// headers.
//
//   node apps/web/test/bench/shardedPsiBrowserBench.ts \
//     --rows 8000 --workers 1,2,4,8 --repeats 3

const require = createRequire(import.meta.url);
const PSI_WORKER_BUILD =
  require.resolve("@openmined/psi.js/psi_wasm_worker.js");

const CLIENT_KEY_FILL = 0x22;

const WORKER_SOURCE = `
importScripts("/psi_wasm_worker.js");
let client;
const ready = PSI().then((library) => {
  const key = new Uint8Array(32).fill(${CLIENT_KEY_FILL});
  key[0] = 0x00;
  client = library.client.createFromKey(key, true);
  postMessage({ ready: true });
});
onmessage = (event) => {
  void ready.then(() => {
    const elements = client
      .createRequest(event.data.values)
      .getEncryptedElementsList_asU8();
    const heap = self.performance.memory
      ? self.performance.memory.usedJSHeapSize
      : null;
    postMessage({ elements, heapBytes: heap }, elements.map((e) => e.buffer));
  });
};
`;

const PAGE_SOURCE = `
<!doctype html>
<meta charset="utf-8" />
<title>sharded PSI browser bench</title>
<script>
function spawnShards(count) {
  return Promise.all(
    Array.from({ length: count }, () => {
      const worker = new Worker("/shard-worker.js");
      return new Promise((resolve) => {
        worker.onmessage = () => {
          worker.onmessage = null;
          resolve(worker);
        };
      });
    }),
  );
}

function maskOn(worker, values) {
  return new Promise((resolve) => {
    worker.onmessage = (event) => resolve(event.data);
    worker.postMessage({ values });
  });
}

function hex(elements) {
  let out = "";
  for (const element of elements)
    for (const byte of element) out += byte.toString(16).padStart(2, "0");
  return out;
}

window.runShardedMasking = async function (values, shardCount) {
  const workers = await spawnShards(shardCount);
  try {
    const size = Math.ceil(values.length / shardCount);
    const slices = workers.map((_, index) =>
      values.slice(index * size, Math.min((index + 1) * size, values.length)),
    );
    const started = performance.now();
    const results = await Promise.all(
      workers.map((worker, index) => maskOn(worker, slices[index])),
    );
    const ms = performance.now() - started;
    return {
      ms,
      digest: hex(results.flatMap((result) => Array.from(result.elements))),
      workerHeapBytes: results.map((result) => result.heapBytes),
      pageHeapBytes: performance.memory ? performance.memory.usedJSHeapSize : null,
    };
  } finally {
    for (const worker of workers) worker.terminate();
  }
};
</script>
`;

function flagValue(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

// performance.memory is Chromium-only and absent in some contexts, so a missing
// reading is reported as such rather than as a zero.
function megabytes(bytes: number | null): string {
  return bytes === null ? "n/a" : (bytes / 1_000_000).toFixed(0);
}

interface ShardedMasking {
  readonly ms: number;
  readonly digest: string;
  readonly workerHeapBytes: Array<number | null>;
  readonly pageHeapBytes: number | null;
}

async function main(): Promise<void> {
  const rows = Number(flagValue("rows", "8000"));
  const repeats = Number(flagValue("repeats", "3"));
  const shardCounts = flagValue("workers", "1,2,4,8")
    .split(",")
    .map((value) => Number(value));
  const values = Array.from(
    { length: rows },
    (_, index) => `joiner-value-${index}`,
  );

  const psiWorkerBuild = readFileSync(PSI_WORKER_BUILD);
  const server = createServer((request, response) => {
    if (request.url === "/psi_wasm_worker.js") {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end(psiWorkerBuild);
      return;
    }
    if (request.url === "/shard-worker.js") {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end(WORKER_SOURCE);
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(PAGE_SOURCE);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  const browser = await chromium.launch({
    args: ["--enable-precise-memory-info"],
  });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    console.log(
      `rows=${rows} repeats=${repeats} workers=${shardCounts.join(",")} cpus=${String(availableParallelism())}`,
    );

    const samples = new Map<number, Array<ShardedMasking>>();
    let digest: string | undefined;
    for (const shardCount of shardCounts) {
      const runs: Array<ShardedMasking> = [];
      for (let repeat = 0; repeat < repeats; repeat += 1) {
        const run = await page.evaluate(
          ([pageValues, count]) =>
            (
              window as unknown as {
                runShardedMasking: (
                  values: Array<string>,
                  shardCount: number,
                ) => Promise<ShardedMasking>;
              }
            ).runShardedMasking(pageValues, count),
          [values, shardCount] as [Array<string>, number],
        );
        digest ??= run.digest;
        if (run.digest !== digest)
          throw new Error(
            `sharded masking at ${shardCount} workers differs from the single-worker output`,
          );
        runs.push(run);
        console.log(
          `sample workers=${shardCount} maskClientValues repeat=${repeat} ms=${run.ms.toFixed(0)} pageHeapMB=${megabytes(run.pageHeapBytes)} workerHeapMB=${run.workerHeapBytes.map(megabytes).join("/")}`,
        );
      }
      samples.set(shardCount, runs);
    }

    const best = (runs: Array<ShardedMasking>): number =>
      Math.min(...runs.map((run) => run.ms));
    const single = best(samples.get(shardCounts[0])!);
    console.log("");
    console.log("| config | best ms | spread ms | rows/s | speedup |");
    console.log("| --- | --- | --- | --- | --- |");
    for (const shardCount of shardCounts) {
      const runs = samples.get(shardCount)!;
      const bestMs = best(runs);
      const worst = Math.max(...runs.map((run) => run.ms));
      console.log(
        `| ${shardCount} worker(s) | ${bestMs.toFixed(0)} | ${bestMs.toFixed(0)}-${worst.toFixed(0)} | ${((rows / bestMs) * 1000).toFixed(0)} | ${(single / bestMs).toFixed(2)}x |`,
      );
    }
  } finally {
    await browser.close();
    server.close();
  }
}

await main();
