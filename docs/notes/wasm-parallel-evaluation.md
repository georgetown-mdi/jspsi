# Parallelizing the WebAssembly PSI backend

Status: measured, with a recommendation for the worker-sharding arm only.
Nothing here is built into the production path -- the backend selector
(`packages/core/src/psi/psiBackend.ts`) and the engine are untouched, and the
prototype lives under two `test/bench` directories. The pthreads/SIMD arm is
unmeasured; its section below is a placeholder.

The quantity being attacked is the masking cost the protocol spec sets the
expectation for: one elliptic-curve scalar multiplication per distinct value,
linear in the value count, single-threaded on the WebAssembly backend. See
[PROTOCOL.md, The single-pass dataset ceiling: receiver memory and masking
compute](../spec/PROTOCOL.md#the-single-pass-dataset-ceiling-receiver-memory-and-masking-compute).

## The two arms

- **Worker sharding (measured here).** Split the value set across N workers,
  each holding its own WASM instance built from the same PSI key, and reassemble
  the masked output. Separate instances, separate linear memories: no
  SharedArrayBuffer, so no cross-origin isolation headers.
- **pthreads/SIMD (not measured here).** Rebuild the fork's WASM with threads
  and SIMD enabled. Needs Emscripten and Bazel and the fork's source, neither
  available in the development container, and needs COOP/COEP on the web app.

## What the vendored package contains

`lib/openmined-psi.js-2.0.6-seclink.3.tgz` ships **one** WebAssembly binary --
byte-identical (sha256 prefix `e19d57fe`, 1,428,515 bytes) across the three
environment entries `psi_wasm_node.js`, `psi_wasm_web.js` and
`psi_wasm_worker.js` -- plus the native N-API entry `psi_native_node.js` and
prebuilds for linux x64/arm64 (glibc and musl), darwin x64/arm64 and win32 x64.
The WASM module exports an unshared memory and the JS glue holds no pthread or
`Atomics` code, so no shipped variant is threads-enabled. A threads/SIMD build
has to come from a fork rebuild.

## Capability: the fork can build an engine from a supplied key

The arm requires constructing several engines under one key. The fork exposes it
on both roles -- `createFromKey(key, revealIntersection)` on the client and
server wrappers, with `getPrivateKeyBytes()` alongside
(`node_modules/@openmined/psi.js/implementation/{client,server}.d.ts`) -- and the
repository already drives it: the wire-vector generator
(`packages/core/test/vectors/generate-psi-engine-wire-vectors.mjs`) pins its
known-answer bytes with fixed keys through `createFromKey`. The arm is not
blocked.

Production generates the key inside the single worker and never lets it out
(`servePsiWorker`). Sharding changes that: the key has to reach every shard, so
it exists in N isolates instead of one.

## The merge rules, and the byte-identity condition

Established by driving the vendored engine, not by reading its source:

| Output | Rule | Merge |
| --- | --- | --- |
| Raw server setup | elements sorted by their bytes; the sorting permutation maps each sorted position to an input index | merge shard elements by byte order, carrying each shard's offset into its permutation |
| Request | elements in input order | concatenate shard results |
| Response | elements in request order | concatenate shard results |
| Association table | pairs in partner-index order, ties by local index | offset each shard's local indices, then sort by partner index |

The sharded output is byte-identical to the single-engine output for the same key
and inputs, with one condition: the engine's setup sort is **not stable**, so
where a value repeats, which input index a sorted position takes is an artifact
of that sort and no merge reproduces it. The element bytes are identical either
way, and the starter masks distinct values (`link.ts` passes `distinctValues` to
`createServerSetup`), which is the condition under which the merged permutation
is the engine's own. `packages/core/test/bench/shardedPsiWasmBench.test.ts` pins
both halves: full identity on distinct values at 1, 2, 3 and 5 shards, and, for a
repeated value, identical bytes with a permutation that still names an input
holding that position's value. The measurement driver re-checks identity on every
configuration it times and fails the run on a mismatch.

The existing wire and interop suites are untouched and pass:
`psiEngineWireVectors`, `psiEngineWireVectorsNative`, `psiParticipantNativeParity`
and the rest of the `packages/core` unit suite (151 files, 5,367 tests).

## The prototype

- `packages/core/test/bench/shardedPsiWasmBench.ts` -- merge rules, the
  `worker_threads` shard driver, and the node measurement.
  `node packages/core/test/bench/shardedPsiWasmBench.ts --rows 12000 --workers 1,2,4,8 --repeats 3`
- `apps/web/test/bench/shardedPsiBrowserBench.ts` -- the same split in real
  Chromium over Web Workers, served without a bundler.
  `node apps/web/test/bench/shardedPsiBrowserBench.ts --rows 8000 --workers 1,2,4,8 --repeats 3`

Both are run directly by Node (type stripping), neither is imported by the app or
the library, and the identity check runs inside each.

## Measurement conditions

A 10-core shared container running other agents' builds and browser suites
throughout. Load average was 27 falling to 16 across the node run and 9 to 12
across the browser run, so **every figure below is a floor**, and the
single-threaded baseline -- measured first, under the heaviest load -- is the
most depressed of them. Each configuration ran three times; the tables give the
best and the full spread. An uncontended single-engine reference taken separately
(load average 1.2, 20,000 values) ran at 1,842 / 1,920 / 2,264 / 2,285 rows per
second for the four operations, so against a clean baseline the 8-worker speedup
is about 5x rather than the 6x to 8x the same-run table shows.

## Node results (12,000 values per operation, best of 3)

| Operation | 1 thread | 1 worker | 2 workers | 4 workers | 8 workers |
| --- | --- | --- | --- | --- | --- |
| mask starter values (setup) | 1,628 rows/s | 2,032 | 3,174 | 6,247 | 9,663 |
| mask joiner values (request) | 1,718 rows/s | 1,993 | 3,420 | 5,254 | 9,813 |
| re-mask partner request (response) | 1,852 rows/s | 2,341 | 3,396 | 8,568 | 15,264 |
| match response against setup | 1,789 rows/s | 2,348 | 4,153 | 8,308 | 12,173 |

Speedup against the same run's single-threaded baseline: 1.95x to 2.59x at 2
workers, 2.74x to 4.65x at 4, 5.71x to 8.24x at 8. Spread across the three
repeats was wide under load -- for example the 8-worker response op ran 786 to
1,101 ms and its baseline 6,481 to 10,159 ms.

Worker startup (spawn plus WASM load, all shards in parallel) was 141 ms at 1
worker and 225 ms at 8. Handing every shard the partner's setup to match against
cost 5 ms at 1 worker and 22 ms at 8 for a 12,000-element setup.

## Browser results (8,000 values, masked into a request, best of 3)

The shipped browser path already runs one PSI worker, so one worker is the
baseline.

| Config | best ms | spread ms | rows/s | speedup |
| --- | --- | --- | --- | --- |
| 1 worker | 3,852 | 3,852-4,393 | 2,077 | 1.00x |
| 2 workers | 2,343 | 2,343-2,355 | 3,415 | 1.64x |
| 4 workers | 1,406 | 1,406-1,517 | 5,690 | 2.74x |
| 8 workers | 939 | 939-1,058 | 8,524 | 4.10x |

Headless Chromium 151.0.7922.34, the `chromium-1234` build playwright 1.62.1
installs, run with `--enable-precise-memory-info`. The concatenated masked
elements were identical across all four configurations.

## Memory

Node, 12,000 values: each shard isolate holds 30-35 MB of its own (V8 heap plus
external, where its WASM instance sits), and whole-process resident memory grew
from 327 MB at 1 worker to 706 MB at 8 -- about 54 MB per additional worker,
including what the host thread keeps. Process resident memory is shared by all
threads, so the per-shard isolate figure is the one that scales.

Each shard that matches a response also holds its own copy of the partner's
setup: 12,000 elements cost under 1 MB, but this is linear in the partner's
distinct-value count and is paid N times.

The browser side could not be measured per worker: `performance.memory` is
undefined in a dedicated worker, and
`performance.measureUserAgentSpecificMemory` needs cross-origin isolation, which
this arm is chosen to avoid. The page's own heap stayed at 13-36 MB regardless of
shard count, which says nothing about the workers'. Treat the node figure -- about
30 MB per shard, plus the WASM instance's linear memory -- as the browser
estimate.

## What shipping the sharded arm needs

- **No COOP/COEP, and no response-header change on the web app.** Separate WASM
  instances, structured-clone messaging; nothing shared. That is the arm's main
  advantage over pthreads.
- **Key distribution to N workers.** Today the key is generated inside the single
  worker and never crosses a boundary; sharding sends it to every shard at spawn.
  Same-origin dedicated workers in one renderer, and `worker_threads` in one
  process, so it does not leave the process -- but it is a change to where key
  material lives, and it is the piece a security review has to weigh.
- **A shard-count policy.** `navigator.hardwareConcurrency` in the browser and
  `os.availableParallelism()` under Node, capped: memory is about 30 MB per
  shard, and on a contended machine past-core counts stop paying.
- **The engine boundary.** The masking calls already cross a runtime-agnostic
  worker boundary (`WorkerPsiEngine` / `servePsiWorker`), so a sharded engine can
  stand behind the same `PsiEngine` interface. The merge rules move with it, and
  they are what a review has to hold: they encode observed engine behavior
  (element sort order, table pair order), so a fork re-roll that changes either
  breaks them. The existing wire-vector fixture already fails on such a re-roll.
- **The joiner's match step needs the partner's setup in every shard**, which is
  a per-shard memory multiplier rather than a compute problem.

## Recommendation

Worth building for the browser, where it is the only parallelism available and
where the shipped path is exactly one thread: 4 workers is the sweet spot on this
hardware (2.7x measured, 4 x ~30 MB), and 8 workers reached 4.1x. A browser party
at 100,000 rows and 14 keys currently faces about 28 minutes of masking
(PROTOCOL.md's figure); 4 to 8 shards puts that in the 7-to-11-minute range with
no header change and no new primitive.

Lower priority for the CLI: it defaults to the native N-API backend, which is
already an order of magnitude faster per value and parallel, so sharding earns
its keep there only on a platform with no prebuild.

Two things to settle before building: the key reaching N isolates (a security
review question, not a measurement one), and whether the merge rules are pinned
tightly enough by the existing wire-vector fixture plus the bench's identity test
to survive a fork re-roll.

## The pthreads/SIMD arm

Not measured -- no Emscripten or Bazel in the container and the fork's source is
host-local. To be filled by whoever rebuilds the fork:

| Operation | single-threaded WASM | pthreads/SIMD WASM | worker sharding (above) |
| --- | --- | --- | --- |
| mask starter values | 1,628 rows/s | | 9,663 rows/s at 8 workers |
| mask joiner values | 1,718 rows/s | | 9,813 rows/s at 8 workers |
| re-mask partner request | 1,852 rows/s | | 15,264 rows/s at 8 workers |
| match response against setup | 1,789 rows/s | | 12,173 rows/s at 8 workers |

That arm additionally has to price cross-origin isolation for the web app
(SharedArrayBuffer requires COOP/COEP, which constrains embedded third-party
content), and to show the same wire and interop invariants -- the suites named
above -- against the rebuilt binary.
