import { availableParallelism } from "node:os";
import { Worker, parentPort, workerData } from "node:worker_threads";

import PSI from "@openmined/psi.js";

import type { Client as PSIClient } from "@openmined/psi.js/implementation/client.d.ts";
import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";
import type { Server as PSIServer } from "@openmined/psi.js/implementation/server.d.ts";

import {
  chunkRanges,
  concatChunkElements,
  mergeAssociationChunks,
  mergeSetupChunks,
  serializeRequest,
  serializeResponse,
  serializeSetup,
} from "../../src/psi/psiChunks";

import type { MergedPsiSetup, PsiChunkRange } from "../../src/psi/psiChunks";

// Evaluation prototype for parallelizing the single-threaded WebAssembly PSI
// engine by splitting the value set across worker_threads workers, each holding
// its own WASM instance built from the SAME key via createFromKey. Nothing here
// is on the production path: the shipped engine (packages/core/src/psi) is
// untouched, and this module exists to measure the arm and to show its output
// is byte-identical to the single-threaded engine's. Masking is one independent
// curve multiplication per value (docs/spec/PROTOCOL.md, "Masking compute is a
// wall-clock expectation"), which is what makes the split exact rather than
// approximate.
//
// Run the measurement (the node path; the browser path uses Web Workers behind
// the same merge rules):
//
//   node packages/core/test/bench/shardedPsiWasmBench.ts \
//     --rows 12000 --workers 1,2,4,8 --repeats 3
//
// The ranges the split runs on and the merge rules each reassembly below
// follows live beside the shipped engine that chunks one operation for the
// same reasons: packages/core/src/psi/psiChunks.ts, whose header states them.

/** The keys a shard worker builds its own engine instances from. */
export interface ShardKeys {
  readonly serverKey: Uint8Array;
  readonly clientKey: Uint8Array;
}

interface ShardWorkerSeed extends ShardKeys {
  readonly shardWorker: true;
}

type ShardRequestBody =
  | { op: "maskServerValues"; values: string[] }
  | { op: "maskClientValues"; values: string[] }
  | { op: "reMaskElements"; elements: Uint8Array[] }
  | { op: "loadServerSetup"; setupBytes: Uint8Array }
  | { op: "matchResponseElements"; elements: Uint8Array[] }
  | { op: "reportMemory" };

type ShardRequest = ShardRequestBody & { id: number };

type ShardResult =
  | { elements: Uint8Array[]; permutation: number[] }
  | { elements: Uint8Array[] }
  | { localIndices: number[]; partnerIndices: number[] }
  | { processResidentBytes: number; isolateBytes: number }
  | Record<string, never>;

type ShardReply =
  | { id: number; ready: true }
  | { id: number; loadFailed: true; error: string }
  | { id: number; ok: true; result: ShardResult }
  | { id: number; ok: false; error: string };

const REVEAL_INTERSECTION = true;
const SETUP_FALSE_POSITIVE_RATE = 0.0;
const SETUP_CLIENT_INPUT_COUNT = -1;

function deserializeElements(
  psi: PSILibrary,
  bytes: Uint8Array,
  kind: "request" | "response",
): Uint8Array[] {
  const message =
    kind === "request"
      ? psi.request.deserializeBinary(bytes)
      : psi.response.deserializeBinary(bytes);
  return message.getEncryptedElementsList_asU8();
}

function serveShardWorker(
  seed: ShardWorkerSeed,
  port: NonNullable<typeof parentPort>,
): void {
  let psi: PSILibrary | undefined;
  let server: PSIServer | undefined;
  let client: PSIClient | undefined;
  let heldSetup:
    ReturnType<PSILibrary["serverSetup"]["deserializeBinary"]> | undefined;

  const run = (request: ShardRequest): ShardResult => {
    const library = psi!;
    switch (request.op) {
      case "maskServerValues": {
        const permutation: number[] = [];
        const setup = server!.createSetupMessage(
          SETUP_FALSE_POSITIVE_RATE,
          SETUP_CLIENT_INPUT_COUNT,
          request.values,
          library.dataStructure.Raw,
          permutation,
        );
        return {
          elements: setup.getRaw()!.getEncryptedElementsList_asU8(),
          permutation,
        };
      }
      case "maskClientValues":
        return {
          elements: client!
            .createRequest(request.values)
            .getEncryptedElementsList_asU8(),
        };
      case "reMaskElements": {
        const shardRequest = library.request.deserializeBinary(
          serializeRequest(library, request.elements, REVEAL_INTERSECTION),
        );
        return {
          elements: server!
            .processRequest(shardRequest)
            .getEncryptedElementsList_asU8(),
        };
      }
      case "loadServerSetup":
        heldSetup = library.serverSetup.deserializeBinary(request.setupBytes);
        return {};
      case "matchResponseElements": {
        const shardResponse = library.response.deserializeBinary(
          serializeResponse(library, request.elements),
        );
        const table = client!.getAssociationTable(heldSetup!, shardResponse);
        return { localIndices: table[0]!, partnerIndices: table[1]! };
      }
      case "reportMemory": {
        // rss is the whole PROCESS, shared by every thread, so it stands for the
        // run rather than for one shard; what a shard costs on its own is its
        // isolate's heap plus its external memory, where its WASM instance sits.
        const usage = process.memoryUsage();
        return {
          processResidentBytes: usage.rss,
          isolateBytes: usage.heapUsed + usage.external,
        };
      }
    }
  };

  port.on("message", (request: ShardRequest) => {
    try {
      port.postMessage({ id: request.id, ok: true, result: run(request) });
    } catch (failure) {
      port.postMessage({
        id: request.id,
        ok: false,
        error: messageOf(failure),
      });
    }
  });

  void PSI()
    .then((library) => {
      psi = library;
      server = library.server!.createFromKey(
        seed.serverKey,
        REVEAL_INTERSECTION,
      );
      client = library.client!.createFromKey(
        seed.clientKey,
        REVEAL_INTERSECTION,
      );
      port.postMessage({ id: 0, ready: true });
    })
    .catch((failure: unknown) => {
      port.postMessage({ id: 0, loadFailed: true, error: messageOf(failure) });
    });
}

function messageOf(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

interface PendingShardRequest {
  readonly resolve: (result: ShardResult) => void;
  readonly reject: (failure: Error) => void;
}

interface ShardHandle {
  readonly worker: Worker;
  readonly pending: Map<number, PendingShardRequest>;
  nextId: number;
  failure?: Error;
  fail(failure: Error): void;
}

interface WatchedShard {
  readonly handle: ShardHandle;
  readonly ready: Promise<void>;
}

/**
 * Wires one shard worker's replies, its readiness and its failures. A worker
 * that fails to load its engine, throws, or exits fails both its readiness and
 * every request still waiting on it, so a broken shard ends the run with that
 * error rather than leaving the driver waiting on a reply that never comes.
 */
function watchShardWorker(worker: Worker): WatchedShard {
  let markReady!: () => void;
  let failReady!: (failure: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    markReady = resolve;
    failReady = reject;
  });
  const handle: ShardHandle = {
    worker,
    pending: new Map(),
    nextId: 1,
    fail(failure: Error): void {
      handle.failure ??= failure;
      failReady(handle.failure);
      for (const [id, pending] of [...handle.pending]) {
        handle.pending.delete(id);
        pending.reject(handle.failure);
      }
    },
  };
  worker.on("message", (reply: ShardReply) => {
    if ("ready" in reply) {
      markReady();
      return;
    }
    if ("loadFailed" in reply) {
      handle.fail(new Error(reply.error));
      return;
    }
    const pending = handle.pending.get(reply.id);
    handle.pending.delete(reply.id);
    if (!pending) return;
    if (reply.ok) pending.resolve(reply.result);
    else pending.reject(new Error(reply.error));
  });
  worker.on("error", (failure: unknown) => {
    handle.fail(
      failure instanceof Error ? failure : new Error(messageOf(failure)),
    );
  });
  worker.on("exit", (code: number) => {
    handle.fail(new Error(`shard worker exited with code ${String(code)}`));
  });
  return { handle, ready };
}

/**
 * Drives N shard workers, each holding its own WASM engine built from the
 * supplied keys, and reassembles their masked output into the bytes a single
 * engine would have produced.
 */
export class ShardedPsiDriver {
  private readonly handles: ShardHandle[];

  private inFlight = false;

  private constructor(handles: ShardHandle[]) {
    this.handles = handles;
  }

  /** Spawns `shardCount` workers and resolves once every engine has loaded. */
  static spawn(keys: ShardKeys, shardCount: number): Promise<ShardedPsiDriver> {
    const seed: ShardWorkerSeed = { shardWorker: true, ...keys };
    return ShardedPsiDriver.over(
      Array.from(
        { length: shardCount },
        () => new Worker(new URL(import.meta.url), { workerData: seed }),
      ),
    );
  }

  /** @internal */
  static over(workers: ReadonlyArray<Worker>): Promise<ShardedPsiDriver> {
    const shards = workers.map(watchShardWorker);
    return Promise.all(shards.map((shard) => shard.ready)).then(
      () => new ShardedPsiDriver(shards.map((shard) => shard.handle)),
      async (failure: unknown) => {
        await Promise.all(
          shards.map((shard) => shard.handle.worker.terminate()),
        );
        throw failure instanceof Error
          ? failure
          : new Error(messageOf(failure));
      },
    );
  }

  /** How many shards this driver splits a value set across. */
  get shardCount(): number {
    return this.handles.length;
  }

  // The driver keeps one split for the operation in flight, so a second
  // operation started before the first settles would read the wrong ranges back.
  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.inFlight)
      return Promise.reject(
        new Error("the sharded PSI driver runs one operation at a time"),
      );
    this.inFlight = true;
    return operation().finally(() => {
      this.inFlight = false;
    });
  }

  private ask(
    handle: ShardHandle,
    body: ShardRequestBody,
  ): Promise<ShardResult> {
    if (handle.failure) return Promise.reject(handle.failure);
    const id = handle.nextId;
    handle.nextId += 1;
    return new Promise<ShardResult>((resolve, reject) => {
      handle.pending.set(id, { resolve, reject });
      handle.worker.postMessage({ id, ...body } as ShardRequest);
    });
  }

  private broadcast(
    body: (range: PsiChunkRange) => ShardRequestBody,
  ): Promise<ShardResult[]> {
    return Promise.all(
      this.handles.map((handle, shard) =>
        this.ask(handle, body(this.rangesFor(shard))),
      ),
    );
  }

  // The split the operation in flight is using, read back when its shard
  // results are merged.
  private ranges: PsiChunkRange[] = [];

  private rangesFor(shard: number): PsiChunkRange {
    return this.ranges[shard]!;
  }

  /** Masks the starter's values across the shards, merged into one setup. */
  maskServerValues(values: ReadonlyArray<string>): Promise<MergedPsiSetup> {
    return this.runExclusive(async () => {
      this.ranges = chunkRanges(values.length, this.shardCount);
      const results = await this.broadcast((range) => ({
        op: "maskServerValues",
        values: values.slice(range.start, range.end),
      }));
      return mergeSetupChunks(
        results.map((result, shard) => ({
          start: this.ranges[shard]!.start,
          elements: (result as { elements: Uint8Array[] }).elements,
          permutation: (result as { permutation: number[] }).permutation,
        })),
      );
    });
  }

  /** Masks the joiner's values across the shards, merged in input order. */
  maskClientValues(values: ReadonlyArray<string>): Promise<Uint8Array[]> {
    return this.runExclusive(async () => {
      this.ranges = chunkRanges(values.length, this.shardCount);
      const results = await this.broadcast((range) => ({
        op: "maskClientValues",
        values: values.slice(range.start, range.end),
      }));
      return concatChunkElements(
        results.map(
          (result) => (result as { elements: Uint8Array[] }).elements,
        ),
      );
    });
  }

  /** Re-masks the partner's request elements across the shards. */
  reMaskElements(elements: ReadonlyArray<Uint8Array>): Promise<Uint8Array[]> {
    return this.runExclusive(async () => {
      this.ranges = chunkRanges(elements.length, this.shardCount);
      const results = await this.broadcast((range) => ({
        op: "reMaskElements",
        elements: elements.slice(range.start, range.end),
      }));
      return concatChunkElements(
        results.map(
          (result) => (result as { elements: Uint8Array[] }).elements,
        ),
      );
    });
  }

  /** Hands every shard the partner's setup, which each one matches against. */
  loadServerSetup(setupBytes: Uint8Array): Promise<void> {
    return this.runExclusive(async () => {
      await Promise.all(
        this.handles.map((handle) =>
          this.ask(handle, { op: "loadServerSetup", setupBytes }),
        ),
      );
    });
  }

  /** Matches the partner's response across the shards, merged into one table. */
  matchResponseElements(
    elements: ReadonlyArray<Uint8Array>,
  ): Promise<[number[], number[]]> {
    return this.runExclusive(async () => {
      this.ranges = chunkRanges(elements.length, this.shardCount);
      const results = await this.broadcast((range) => ({
        op: "matchResponseElements",
        elements: elements.slice(range.start, range.end),
      }));
      return mergeAssociationChunks(
        results.map((result, shard) => ({
          start: this.ranges[shard]!.start,
          localIndices: (result as { localIndices: number[] }).localIndices,
          partnerIndices: (result as { partnerIndices: number[] })
            .partnerIndices,
        })),
      );
    });
  }

  /** What the shards cost: the process resident set, and each isolate's own. */
  memory(): Promise<ShardMemory> {
    return this.runExclusive(async () => {
      const results = (await Promise.all(
        this.handles.map((handle) => this.ask(handle, { op: "reportMemory" })),
      )) as Array<{ processResidentBytes: number; isolateBytes: number }>;
      return {
        processResidentBytes: Math.max(
          ...results.map((result) => result.processResidentBytes),
        ),
        isolateBytes: results.map((result) => result.isolateBytes),
      };
    });
  }

  /** Terminates every shard worker, freeing its engine with the isolate. */
  async dispose(): Promise<void> {
    await Promise.all(this.handles.map((handle) => handle.worker.terminate()));
  }
}

/** The single-engine output every sharded run is checked against. */
interface Baseline {
  readonly setupBytes: Uint8Array;
  readonly permutation: number[];
  readonly requestBytes: Uint8Array;
  readonly responseBytes: Uint8Array;
  readonly table: [number[], number[]];
  readonly timings: Record<BenchOperation, number>;
  readonly residentBytes: number;
  readonly isolateBytes: number;
}

type BenchOperation =
  | "maskServerValues"
  | "maskClientValues"
  | "reMaskElements"
  | "matchResponseElements";

const OPERATIONS: BenchOperation[] = [
  "maskServerValues",
  "maskClientValues",
  "reMaskElements",
  "matchResponseElements",
];

function benchKey(fill: number): Uint8Array {
  const key = new Uint8Array(32).fill(fill);
  key[0] = 0x00;
  return key;
}

const BENCH_KEYS: ShardKeys = {
  serverKey: benchKey(0x11),
  clientKey: benchKey(0x22),
};

async function timed<T>(
  run: () => Promise<T> | T,
): Promise<{ value: T; ms: number }> {
  const started = performance.now();
  const value = await run();
  return { value, ms: performance.now() - started };
}

async function measureBaseline(
  serverValues: string[],
  clientValues: string[],
): Promise<Baseline> {
  const psi = await PSI();
  const server = psi.server!.createFromKey(
    BENCH_KEYS.serverKey,
    REVEAL_INTERSECTION,
  );
  const client = psi.client!.createFromKey(
    BENCH_KEYS.clientKey,
    REVEAL_INTERSECTION,
  );
  const permutation: number[] = [];
  const setup = await timed(() =>
    server.createSetupMessage(
      SETUP_FALSE_POSITIVE_RATE,
      SETUP_CLIENT_INPUT_COUNT,
      serverValues,
      psi.dataStructure.Raw,
      permutation,
    ),
  );
  const request = await timed(() => client.createRequest(clientValues));
  const response = await timed(() => server.processRequest(request.value));
  const table = await timed(() =>
    client.getAssociationTable(setup.value, response.value),
  );
  const usage = process.memoryUsage();
  server.delete();
  client.delete();
  return {
    setupBytes: setup.value.serializeBinary(),
    permutation,
    requestBytes: request.value.serializeBinary(),
    responseBytes: response.value.serializeBinary(),
    table: [table.value[0]!, table.value[1]!],
    timings: {
      maskServerValues: setup.ms,
      maskClientValues: request.ms,
      reMaskElements: response.ms,
      matchResponseElements: table.ms,
    },
    residentBytes: usage.rss,
    isolateBytes: usage.heapUsed + usage.external,
  };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1)
    if (a[index] !== b[index]) return false;
  return true;
}

function requireIdentical(label: string, identical: boolean): void {
  if (!identical)
    throw new Error(`sharded ${label} differs from the single-engine output`);
}

interface ShardedRun {
  readonly timings: Record<BenchOperation, number>;
  readonly startupMs: number;
  readonly setupLoadMs: number;
  readonly memory: ShardMemory;
}

/** A run's memory: the whole process, and each shard isolate's own share. */
export interface ShardMemory {
  readonly processResidentBytes: number;
  readonly isolateBytes: number[];
}

async function measureSharded(
  shardCount: number,
  serverValues: string[],
  clientValues: string[],
  baseline: Baseline,
): Promise<ShardedRun> {
  const psi = await PSI();
  const startup = await timed(() =>
    ShardedPsiDriver.spawn(BENCH_KEYS, shardCount),
  );
  const driver = startup.value;
  try {
    const setup = await timed(() => driver.maskServerValues(serverValues));
    requireIdentical(
      "server setup",
      sameBytes(
        serializeSetup(psi, setup.value.elements),
        baseline.setupBytes,
      ) && setup.value.permutation.join(",") === baseline.permutation.join(","),
    );

    const request = await timed(() => driver.maskClientValues(clientValues));
    const requestBytes = serializeRequest(
      psi,
      request.value,
      REVEAL_INTERSECTION,
    );
    requireIdentical(
      "client request",
      sameBytes(requestBytes, baseline.requestBytes),
    );

    const response = await timed(() =>
      driver.reMaskElements(
        deserializeElements(psi, baseline.requestBytes, "request"),
      ),
    );
    const responseBytes = serializeResponse(psi, response.value);
    requireIdentical(
      "server response",
      sameBytes(responseBytes, baseline.responseBytes),
    );

    const setupLoad = await timed(() =>
      driver.loadServerSetup(baseline.setupBytes),
    );
    const table = await timed(() =>
      driver.matchResponseElements(
        deserializeElements(psi, baseline.responseBytes, "response"),
      ),
    );
    requireIdentical(
      "association table",
      table.value[0].join(",") === baseline.table[0].join(",") &&
        table.value[1].join(",") === baseline.table[1].join(","),
    );

    return {
      timings: {
        maskServerValues: setup.ms,
        maskClientValues: request.ms,
        reMaskElements: response.ms,
        matchResponseElements: table.ms,
      },
      startupMs: startup.ms,
      setupLoadMs: setupLoad.ms,
      memory: await driver.memory(),
    };
  } finally {
    await driver.dispose();
  }
}

function flagValue(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

function megabytes(bytes: number): string {
  return (bytes / 1_000_000).toFixed(0);
}

function rowsPerSecond(rows: number, ms: number): string {
  return ((rows / ms) * 1000).toFixed(0);
}

async function main(): Promise<void> {
  const rows = Number(flagValue("rows", "12000"));
  const repeats = Number(flagValue("repeats", "3"));
  const shardCounts = flagValue("workers", "1,2,4,8")
    .split(",")
    .map((value) => Number(value));
  const serverValues = Array.from(
    { length: rows },
    (_, index) => `starter-value-${index}`,
  );
  const clientValues = Array.from(
    { length: rows },
    (_, index) => `starter-value-${index + Math.floor(rows / 2)}`,
  );

  console.log(
    `rows=${rows} repeats=${repeats} workers=${shardCounts.join(",")} cpus=${String(availableParallelism())}`,
  );

  const baselineRuns: Array<Record<BenchOperation, number>> = [];
  let baseline: Baseline | undefined;
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    baseline = await measureBaseline(serverValues, clientValues);
    baselineRuns.push(baseline.timings);
    for (const operation of OPERATIONS)
      console.log(
        `sample baseline ${operation} repeat=${repeat} ms=${baseline.timings[operation].toFixed(0)}`,
      );
  }
  console.log(
    `baseline process RSS MB ${megabytes(baseline!.residentBytes)} isolate MB ${megabytes(baseline!.isolateBytes)}`,
  );

  const shardedRuns = new Map<number, ShardedRun[]>();
  for (const shardCount of shardCounts) {
    const runs: ShardedRun[] = [];
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      const run = await measureSharded(
        shardCount,
        serverValues,
        clientValues,
        baseline!,
      );
      runs.push(run);
      for (const operation of OPERATIONS)
        console.log(
          `sample workers=${shardCount} ${operation} repeat=${repeat} ms=${run.timings[operation].toFixed(0)}`,
        );
      console.log(
        `sample workers=${shardCount} startup repeat=${repeat} ms=${run.startupMs.toFixed(0)} setupLoad=${run.setupLoadMs.toFixed(0)} processRssMB=${megabytes(run.memory.processResidentBytes)} isolateMB=${run.memory.isolateBytes.map(megabytes).join("/")}`,
      );
    }
    shardedRuns.set(shardCount, runs);
  }

  const best = (samples: number[]): number => Math.min(...samples);
  const spread = (samples: number[]): string =>
    `${best(samples).toFixed(0)}-${Math.max(...samples).toFixed(0)}`;

  console.log("");
  console.log(
    "| operation | config | best ms | spread ms | rows/s | speedup |",
  );
  console.log("| --- | --- | --- | --- | --- | --- |");
  for (const operation of OPERATIONS) {
    const baselineSamples = baselineRuns.map((run) => run[operation]);
    const baselineBest = best(baselineSamples);
    console.log(
      `| ${operation} | single-threaded | ${baselineBest.toFixed(0)} | ${spread(baselineSamples)} | ${rowsPerSecond(rows, baselineBest)} | 1.00x |`,
    );
    for (const shardCount of shardCounts) {
      const samples = shardedRuns
        .get(shardCount)!
        .map((run) => run.timings[operation]);
      const shardBest = best(samples);
      console.log(
        `| ${operation} | ${shardCount} worker(s) | ${shardBest.toFixed(0)} | ${spread(samples)} | ${rowsPerSecond(rows, shardBest)} | ${(baselineBest / shardBest).toFixed(2)}x |`,
      );
    }
  }

  console.log("");
  console.log(
    "| config | startup ms | setup load ms | process RSS MB | per-shard isolate MB |",
  );
  console.log("| --- | --- | --- | --- | --- |");
  for (const shardCount of shardCounts) {
    const runs = shardedRuns.get(shardCount)!;
    const startups = runs.map((run) => run.startupMs);
    const loads = runs.map((run) => run.setupLoadMs);
    const processResident = runs.map((run) => run.memory.processResidentBytes);
    const isolates = runs.flatMap((run) => run.memory.isolateBytes);
    console.log(
      `| ${shardCount} worker(s) | ${best(startups).toFixed(0)} | ${best(loads).toFixed(0)} | ${megabytes(Math.max(...processResident))} | ${megabytes(Math.min(...isolates))}-${megabytes(Math.max(...isolates))} |`,
    );
  }
}

// One file in three roles: the shards spawn it as their own worker entry, the
// measurement runs when it is the program, and a test importing the merge rules
// must reach neither. The seed marker rather than isMainThread does the first
// test, because vitest runs a test file in a worker thread of its own.
const seed = workerData as ShardWorkerSeed | null;
if (seed?.shardWorker === true && parentPort)
  serveShardWorker(seed, parentPort);
else if (process.argv[1]?.endsWith("shardedPsiWasmBench.ts")) await main();
