# Parallelizing the WebAssembly PSI backend

Status: both arms measured, with the browser direction decided on 2026-09-16 --
Web Worker sharding, with the pthreads/SIMD build declined
([Decision](#decision-2026-09-16)). Nothing here is built into the production
path -- the backend selector (`packages/core/src/psi/psiBackend.ts`) and the
engine are untouched, and the prototype lives under two `test/bench`
directories.

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
- **pthreads/SIMD.** Rebuild the fork's WASM with threads and SIMD enabled.
  Needs Emscripten, Bazel and the fork's source, none of them in the development
  container, and needs COOP/COEP on the web app. Built and measured on a
  host-local x86 box: [The pthreads/SIMD arm](#the-pthreadssimd-arm).

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

## Both arms in headless Chromium, on one machine

The figures above are the sharding arm alone, in the development container,
under load. Both arms also ran in headless Chromium on one quiet x86 box, on the
same pinned core lists, sizes and repeat count, each against a single-instance
baseline on its own core list. The measurements are host-local, in
`research/wasm-threads/RESULTS.md` ("Throughput (Chromium, LXC)"), which is not
part of this repository.

- **The box.** A Proxmox LXC container on an Intel Core i3-14100, 4 physical
  cores and 8 logical, pinned to CPUs 2-7, which is 3 whole physical cores; the
  host's other guests hold CPUs 0 and 1.
- **The core lists.** `2` (1 core), `2,4` (2 cores), `2,4,6` (3 cores) and
  `2-7` (those same 3 cores with both SMT siblings, 6 logical CPUs).
  `navigator.hardwareConcurrency` follows `taskset` in Chromium, so each arm
  sized itself to the list: 1, 2, 3 and 6 pool threads or module workers.
- **One window.** Baseline, pthreads and workers ran back to back on 2026-09-16
  from 17:58 to 23:09 UTC, inside a quiet window with the CPU governor at
  `performance` and the other guest stopped. 108 runs, all of which exited 0
  with a result. Chrome Headless Shell 151.0.7922.34 under playwright-core
  1.62.1, browser sandbox on.

N = 100,000, best of 3, with each speedup taken against the baseline on the same
core list:

| core list | arm | CreateRequest el/s | speedup | ProcessRequest el/s | speedup |
| --- | --- | ---: | ---: | ---: | ---: |
| 1 core (`2`) | baseline | 2,827 | 1.00x | 3,445 | 1.00x |
| 1 core (`2`) | pthreads | 2,789 | 0.99x | 3,413 | 0.99x |
| 1 core (`2`) | Web Workers | 2,826 | 1.00x | 3,442 | 1.00x |
| 2 cores (`2,4`) | baseline | 2,840 | 1.00x | 3,455 | 1.00x |
| 2 cores (`2,4`) | pthreads | 5,478 | 1.93x | 6,726 | 1.95x |
| 2 cores (`2,4`) | Web Workers | 5,558 | 1.96x | 6,757 | 1.96x |
| 3 cores (`2,4,6`) | baseline | 2,841 | 1.00x | 3,454 | 1.00x |
| 3 cores (`2,4,6`) | pthreads | 7,975 | 2.81x | 9,750 | 2.82x |
| 3 cores (`2,4,6`) | Web Workers | 8,090 | 2.85x | 9,891 | 2.86x |
| 3 cores + SMT (`2-7`) | baseline | 2,841 | 1.00x | 3,459 | 1.00x |
| 3 cores + SMT (`2-7`) | pthreads | 7,019 | 2.47x | 8,237 | 2.38x |
| 3 cores + SMT (`2-7`) | Web Workers | 7,003 | 2.46x | 8,328 | 2.41x |

Web Workers match the pthreads build at every core list: across the full matrix
of 12 core-list and size combinations, pthreads over workers runs 0.970 to
1.002, with workers ahead in 23 of the 24 comparisons. Both arms peak at 3
physical cores, and the SMT siblings on those same cores cost both arms
throughput. The pthreads arm is served with COOP `same-origin` and COEP
`require-corp`, which it requires; a separate header check at N = 100,000 on 3
cores ran the workers arm both ways and found no difference in speed, 8,058 el/s
CreateRequest without the headers against 8,074 with them.

**Byte identity.** At N = 10,000, outside the timed region, every browser run
recorded the SHA-256 of the request and of the response. Over all 36 such runs --
three variants, four core lists, three repeats -- both hashes are one pair,
`9a2f4e0102c1...` for the request and `a2814e7136c5...` for the response, the
pair the Mac run produced as well. The workers arm additionally compared its
merged shard bytes against a single-instance CreateRequest and ProcessRequest
over all inputs in the same page, and reported them identical in all 12 of its
runs.

### Renderer crash in the workers arm on the Mac

While the harness was validated on the Mac before the x86 runs, the workers page
intermittently crashed its renderer.

- **Platform and build.** Apple M1 Max, macOS 26.6.2, Chrome Headless Shell
  151.0.7922.34, N = 10,000, unpinned (10 logical CPUs).
- **The signal.** Playwright reports `page.evaluate: Target crashed`, and
  Chromium's stderr prints `Received signal 4 ILL_ILLTRP <pc>` with the program
  counter outside the Chromium framework's address range. Every crash came
  before the warm-up finished.
- **Shard counts that crashed.** 10 workers, 4 of 75 runs with the browser
  sandbox on and 1 of 25 with it off, after 3 of 21 earlier validation runs; 6
  workers, 4 of 50.
- **Shard counts that did not.** 2 workers, 0 of 25; the pthreads page, 10 pool
  threads over one shared module, 0 of 25; baseline, 0 of 25. A page that only
  instantiates 6 module instances crashed 0 of 120 times, the same page also
  warming up each instance 4 of 120, and a single instance 0 of 60.
- **Not seen on the x86 box.** 0 crashes in 40 stability runs at 6 workers and 0
  in the 36 matrix workers runs at 1 to 6 workers, with the same Chromium build.
- **Untested.** A full Chrome on macOS, and the shipped rollup worker bundle in
  place of the raw module.

That several module instances must be computing at once for it to happen is
measured; nothing beyond that is.

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

Rebuilt from the fork with threads and SIMD enabled and measured on the same box
as the Chromium comparison, over the same core lists at 10,000, 100,000 and
1,000,000 inputs, on Node as well as in the browser. The figures are host-local,
in `research/wasm-threads/RESULTS.md`.

- **Matches worker sharding on speed.** Over the 12 core-list and size
  combinations, pthreads over workers runs 0.974 to 1.003 for CreateRequest and
  0.979 to 1.003 for ProcessRequest on Node -- inside the worst run-to-run
  spread there, 4.2% -- and 0.970 to 1.002 in Chromium. Both arms scale alike
  against the baseline on their own core list: 1.94x to 1.98x on 2 cores and
  2.81x to 2.87x on 3 under Node, 1.91x to 1.97x and 2.77x to 2.86x in
  Chromium.
- **SIMD is worth 1% to 2%**, single-threaded or threaded, with the same sign in
  every cell.
- **Memory favors pthreads at large N**, since its threads share one heap: at
  1,000,000 inputs on 3 cores, peak resident set is 875 MiB for workers against
  730 MiB for pthreads and 676 MiB for baseline.
- **Wire bytes do not change.** For fixed keys and 50,000 inputs, the threads,
  threads-plus-SIMD and SIMD-only builds produce byte-identical setup, request,
  response, sorting permutation, association table and intersection outputs,
  with reveal on and off, and the fork's own suite passes on each.
- **What adopting it would cost.** COOP/COEP on the web app, which constrains
  embedded third-party content; a loader change, since emcc hardcodes the
  pthread worker script name and the fork's rollup web bundle requests a file
  that does not exist; and a fork rebuild to maintain, whose emscripten build has
  exceptions disabled, so a failed thread spawn or an allocation failure inside a
  shard aborts the module rather than returning a status.

An earlier single run in a browser on the Mac put the threads build at 14,579
elements per second against 2,227 for the single-threaded build, 6.5x on 10
unpinned logical CPUs. That is not a comparison between the two arms: a
different host, no core pinning, and no browser run of the sharding arm to set
against it. The same-machine Chromium table above is the comparison.

## Decision (2026-09-16)

Browser parallelism is the Web Worker sharding arm, with the shard outputs
merged by the rules above. What remains is its realization, on the terms the
[Recommendation](#recommendation) states.

The pthreads/SIMD build is not adopted. It shows no throughput gain over
sharding at any core count, in Chromium or on Node, and adopting it would add
cross-origin isolation to the web app and a fork of the library to maintain. The
renderer crash the sharding arm showed on the Mac is tracked as a follow-up.
