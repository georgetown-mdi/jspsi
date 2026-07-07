// Single-pass PSI measurement harness for board item 206245686.
//
// Measures the two costs that bind the single-pass dataset ceiling -- they are
// NOT the wire size (see docs/spec/PROTOCOL.md, "Linkage strategies"):
//
//   1. ECDH masking compute -- one elliptic-curve scalar multiplication per
//      DISTINCT linkage-key value, single-threaded through @openmined/psi.js.
//      Across the exchange the curve work is c_enc*(D_send + D_recv) for the
//      first encryption of each party's set plus c_re*(2*D_recv) for the
//      sender's re-encryption and the receiver's match, where D is the count of
//      distinct values a party pools across all keys.
//   2. The RECEIVER's peak resident memory -- it holds the reply, decodes it,
//      builds its own and the sender's distinct-value index tables, and runs the
//      cascade replay, all resident at once. The receiver is the heavier side.
//
// Three memory quantities are reported, and they differ by more than an order of
// magnitude (board item 206377899; see docs/spec/PROTOCOL.md, the single-pass
// dataset ceiling): the lifetime peak RSS (transient allocation churn, the
// practical ceiling), the live V8 heap after a forced GC (retained JS), and the
// WebAssembly linear heap. The WASM heap must be measured DIRECTLY -- it is the
// emmalloc linear memory the OpenMined module exports, grow-only and never
// returned to the OS, and process.memoryUsage().arrayBuffers does NOT include it
// (arrayBuffers counts only the V8 wire-buffer copies). The harness captures the
// exported WebAssembly.Memory by wrapping WebAssembly.instantiate before the
// module instantiates and reads its byte length (installWasmHeapProbe below).
//
// Modes:
//
//   node scripts/single-pass-bench.mjs rates [D ...]
//     Times each masking op directly at the given distinct-value counts (no
//     network) and prints per-value microseconds, bytes-per-value, and the
//     cumulative WASM linear-heap size. Establishes that masking is linear in the
//     distinct-value count, so the table in the spec can extrapolate from these
//     slopes. The WASM heap is grow-only and shared across the D values in one run,
//     so its column is CUMULATIVE; for a clean per-D WASM floor (e.g. a high-D
//     point near the cell ceiling) run a SINGLE D: `rates 500000`.
//
//   node scripts/single-pass-bench.mjs sweep [--keys K] [--overlap F] [--sizes N,N,...] [--gc]
//     For each row count N it forks a sender and a receiver child running the real
//     linkViaSinglePassPSI over a parent-relayed pipe, so each process's peak RSS
//     (process.resourceUsage().maxRSS) is isolated and faithful -- the receiver
//     decode + index-table build + cascade replay are exercised exactly as in a
//     live exchange. Prints a table of masking wall-clock, peak RSS, and the WASM
//     linear heap per side. maxRSS is the WHOLE-PROCESS LIFETIME high-water mark, so
//     it captures transient allocation churn across all phases, not an isolated
//     single phase's peak; most of the per-value slope is collectable JS garbage,
//     not live retained memory (board item 206377899). With --gc the children fork
//     under --expose-gc, the same runtime flag the shipped CLI sets, which turns on
//     @psilink/core's relieveTransientMemory at the single-pass phase boundaries --
//     so the recv RSS the table reports is the real shipped relief, not a
//     bench-only collection. The table also adds the post-GC live heap, the
//     retained floor the transient peak sits above (the split that shows the peak
//     is mostly collectable churn).
//
// The masking ops require a shared PSI client key between the receiver's request
// and its match step, so the two sides cannot run as independent processes that
// each mint their own key; they must exchange live, which is why the sweep relays
// a real exchange rather than pre-building a reply offline.
//
// Datasets are near-unique within a party (every cell a distinct value, so
// D = keys * rows -- the worst case the ceiling must hold for) with the first
// `overlap * rows` rows shared across parties so the match path runs and the
// result can be checked. Both parties are sized equally (the symmetric case the
// role rule targets); the sender's row count drives the index table, the larger
// distinct-value counts drive everything else.

import { fileURLToPath } from "node:url";
import { fork } from "node:child_process";

const HERE = fileURLToPath(import.meta.url);

// --- WASM linear-heap probe ----------------------------------------------------
//
// The OpenMined module EXPORTS its emmalloc linear memory (grow-only under
// -sALLOW_MEMORY_GROWTH, never returned to the OS). process.memoryUsage().
// arrayBuffers does NOT capture it -- it counts the V8 ArrayBuffers holding the
// wire-buffer copies, a separate quantity. We capture the exported
// WebAssembly.Memory by wrapping WebAssembly.instantiate, then read its current
// byte length directly. Install BEFORE the first `await PSI()`; importing the
// module does not instantiate it (the factory instantiates on call).
let wasmMemory; // the psi.js instance's exported WebAssembly.Memory, once seen.
function installWasmHeapProbe() {
  const capture = (result) => {
    // WebAssembly.instantiate resolves to an Instance (module input) or to
    // { instance, module } (bytes input); the module here exports its memory, so
    // scan the exports for a WebAssembly.Memory rather than assume its name.
    const instance = result && result.instance ? result.instance : result;
    const exports = instance && instance.exports;
    if (!wasmMemory && exports) {
      for (const value of Object.values(exports)) {
        if (value instanceof WebAssembly.Memory) {
          wasmMemory = value;
          break;
        }
      }
    }
    return result;
  };
  const origInstantiate = WebAssembly.instantiate;
  WebAssembly.instantiate = function (...args) {
    return origInstantiate.apply(this, args).then(capture);
  };
  const origStreaming = WebAssembly.instantiateStreaming;
  if (origStreaming) {
    WebAssembly.instantiateStreaming = function (...args) {
      return origStreaming.apply(this, args).then(capture);
    };
  }
}

// Current WASM linear-heap size in bytes. emmalloc is grow-only, so this is also
// the process-lifetime high-water mark once the work has run. Returns 0 if the
// module has not instantiated or exported no memory -- callers warn on a 0 after a
// real run so a missed probe cannot masquerade as "no WASM heap".
function wasmHeapBytes() {
  return wasmMemory ? wasmMemory.buffer.byteLength : 0;
}

// --- shared dataset generation -------------------------------------------------

function makeColumns(role, rows, keys, overlapRows) {
  const cols = [];
  for (let j = 0; j < keys; ++j) {
    const col = new Array(rows);
    for (let i = 0; i < rows; ++i) {
      col[i] = i < overlapRows ? `sh_${j}_${i}` : `${role}_${j}_${i}`;
    }
    cols.push(col);
  }
  return cols;
}

function mb(kib) {
  return (kib / 1024).toFixed(0);
}

// --- mode: rates ---------------------------------------------------------------

async function runRates(argv) {
  installWasmHeapProbe();
  const { default: PSI } = await import("@openmined/psi.js");
  const { PSIParticipant } = await import("@psilink/core");
  const lib = await PSI();
  const Ds = argv.length ? argv.map(Number) : [2000, 8000, 32000];

  console.log(
    "Per-distinct-value masking cost (single-threaded @openmined/psi.js):\n",
  );
  console.log(
    "      D | setup us/v | request us/v | response us/v | match us/v | " +
      "bytes/v | wasm MB",
  );
  console.log(
    "  ------+------------+--------------+---------------+------------+" +
      "---------+--------",
  );
  for (const D of Ds) {
    // Per-message element-count bounds the participant enforces on every inbound
    // PSI frame (the required 4th constructor argument; see PsiElementBounds /
    // psiElementBounds in packages/core). Each flat set holds D distinct values,
    // so D is the exact, permissive bound for all three message kinds here.
    const bounds = { setup: D, request: D, response: D };
    const server = new PSIParticipant(
      "s",
      lib,
      { role: "starter", verbose: -1 },
      bounds,
    );
    const client = new PSIParticipant(
      "c",
      lib,
      { role: "joiner", verbose: -1 },
      bounds,
    );
    const sVals = Array.from({ length: D }, (_, i) => `s_${i}`);
    const cVals = Array.from({ length: D }, (_, i) => `c_${i}`);

    // The masking building blocks are async (the CLI runs them off-thread through
    // a worker-backed engine; board item 208035324). Awaiting each in turn still
    // times one operation at a time, so the per-op microsecond figures stand.
    let t = performance.now();
    const { setup } = await server.createServerSetup(sVals);
    const tSetup = performance.now() - t;
    t = performance.now();
    const request = await client.createClientRequest(cVals);
    const tReq = performance.now() - t;
    t = performance.now();
    const response = await server.processClientRequest(request);
    const tResp = performance.now() - t;
    t = performance.now();
    await client.computeValueMatches(setup, response);
    const tMatch = performance.now() - t;

    const us = (ms) => ((ms / D) * 1000).toFixed(1);
    const wasmMB = (wasmHeapBytes() / 1048576).toFixed(0);
    console.log(
      `  ${String(D).padStart(5)} | ${us(tSetup).padStart(10)} | ` +
        `${us(tReq).padStart(12)} | ${us(tResp).padStart(13)} | ` +
        `${us(tMatch).padStart(10)} | ${(setup.byteLength / D).toFixed(1).padStart(7)} | ` +
        `${wasmMB.padStart(7)}`,
    );
  }
  if (wasmHeapBytes() === 0)
    console.error(
      "  warning: WASM heap probe captured no memory -- the heap figure is 0",
    );
  console.log(
    `\n  peak RSS for this process: ${mb(process.resourceUsage().maxRSS)} MB`,
  );
  // The WASM heap column is grow-only and shared across the D values above, so it
  // is cumulative; for an isolated per-D WASM floor near the cell ceiling run a
  // single D (e.g. `rates 500000`) and divide the heap by D.
  console.log(
    `  WASM linear heap (cumulative, grow-only): ` +
      `${(wasmHeapBytes() / 1048576).toFixed(0)} MB`,
  );
}

// --- mode: sweep (parent) ------------------------------------------------------

function runChild(role, rows, keys, overlap, relayTo, onResult, gc) {
  const child = fork(
    HERE,
    ["child", role, String(rows), String(keys), String(overlap)],
    {
      serialization: "advanced",
      // --gc runs the child under --expose-gc, which is exactly what the shipped
      // CLI does: it turns on @psilink/core's relieveTransientMemory at the
      // single-pass phase boundaries (a no-op without the flag). So --gc measures
      // the real shipped relief by toggling the same runtime flag, rather than the
      // bench forcing its own collection. With gc exposed the child can also read
      // its post-GC live heap, the retained floor the transient peak sits above.
      execArgv: gc ? ["--expose-gc"] : [],
    },
  );
  child.on("message", (m) => {
    if (m && m.wire !== undefined) {
      relayTo().send({ wire: m.wire });
    } else if (m && m.result) {
      onResult(m.result);
    }
  });
  return child;
}

async function runOneSize(rows, keys, overlap, gc) {
  let senderChild;
  let receiverChild;
  const results = {};
  const wireMax = { toReceiver: 0, toSender: 0 };

  const done = new Promise((resolve) => {
    const finishIfReady = () => {
      if (results.sender && results.receiver) resolve();
    };
    senderChild = runChild(
      "sender",
      rows,
      keys,
      overlap,
      () => receiverChild,
      (r) => {
        results.sender = r;
        finishIfReady();
      },
      gc,
    );
    receiverChild = runChild(
      "receiver",
      rows,
      keys,
      overlap,
      () => senderChild,
      (r) => {
        results.receiver = r;
        finishIfReady();
      },
      gc,
    );
    // Measure the relayed frame sizes from the parent (the sender->receiver reply
    // is the large one). Re-wrap the message handlers to also size the payload.
    senderChild.on("message", (m) => {
      if (m && m.wire instanceof Uint8Array)
        wireMax.toReceiver = Math.max(wireMax.toReceiver, m.wire.byteLength);
    });
    receiverChild.on("message", (m) => {
      if (m && m.wire instanceof Uint8Array)
        wireMax.toSender = Math.max(wireMax.toSender, m.wire.byteLength);
    });
  });

  await done;
  return { rows, keys, ...results, wireMax };
}

async function runSweep(argv) {
  let keys = 14;
  let overlap = 0.5;
  let sizes = [1000, 2000, 4000, 8000, 16000];
  let gc = false;
  for (let i = 0; i < argv.length; ++i) {
    if (argv[i] === "--keys") keys = Number(argv[++i]);
    else if (argv[i] === "--overlap") overlap = Number(argv[++i]);
    else if (argv[i] === "--gc") gc = true;
    else if (argv[i] === "--sizes")
      sizes = argv[++i].split(",").map((s) => Number(s.trim()));
  }

  console.log(
    `Single-pass sweep: keys=${keys}, overlap=${overlap}, ` +
      `equal-sized parties, near-unique keys (D = keys * rows)` +
      `${gc ? ", GC forced at phase boundaries" : ""}.\n`,
  );
  // recv wasm MB is the receiver's grow-only WASM linear-heap floor; recv live MB
  // (--gc only) is its post-GC RSS, the retained term the transient peak sits above.
  const gcCols = gc ? " | recv live MB" : "";
  const gcRule = gc ? "+-------------" : "";
  console.log(
    "   rows |       D | reply MB | recv mask s | " +
      "send RSS MB | recv RSS MB | recv wasm MB" +
      gcCols +
      " | matches",
  );
  console.log(
    "  ------+---------+----------+-------------+" +
      "-------------+-------------+-------------" +
      gcRule +
      "+--------",
  );

  const rows = [];
  for (const n of sizes) {
    const r = await runOneSize(n, keys, overlap, gc);
    const D = keys * n;
    const recvMask = (r.receiver.maskMs / 1000).toFixed(1);
    const recvWasmMB = mb((r.receiver.wasmHeapBytes ?? 0) / 1024);
    const liveCell = gc
      ? ` | ${mb(r.receiver.postGcLiveHeapKib ?? 0).padStart(12)}`
      : "";
    console.log(
      `  ${String(n).padStart(5)} | ${String(D).padStart(7)} | ` +
        `${(r.wireMax.toReceiver / 1048576).toFixed(1).padStart(8)} | ` +
        `${recvMask.padStart(11)} | ` +
        `${mb(r.sender.maxRSS).padStart(11)} | ` +
        `${mb(r.receiver.maxRSS).padStart(11)} | ` +
        `${recvWasmMB.padStart(12)}` +
        liveCell +
        ` | ${r.receiver.matches}`,
    );
    rows.push({
      rows: n,
      distinctPerParty: D,
      replyBytes: r.wireMax.toReceiver,
      senderMaskMs: r.sender.maskMs,
      receiverMaskMs: r.receiver.maskMs,
      senderMaxRssMB: Number(mb(r.sender.maxRSS)),
      receiverMaxRssMB: Number(mb(r.receiver.maxRSS)),
      senderWasmHeapMB: Number(mb((r.sender.wasmHeapBytes ?? 0) / 1024)),
      receiverWasmHeapMB: Number(mb((r.receiver.wasmHeapBytes ?? 0) / 1024)),
      ...(gc
        ? {
            senderPostGcLiveHeapMB: Number(mb(r.sender.postGcLiveHeapKib ?? 0)),
            receiverPostGcLiveHeapMB: Number(
              mb(r.receiver.postGcLiveHeapKib ?? 0),
            ),
          }
        : {}),
      matches: r.receiver.matches,
    });
  }
  console.log(
    "\nJSON:\n" + JSON.stringify({ keys, overlap, gc, rows }, null, 2),
  );
}

// --- mode: child ---------------------------------------------------------------

function ipcConnection() {
  const queue = [];
  const waiters = [];
  process.on("message", (msg) => {
    if (!msg || msg.wire === undefined) return;
    const w = waiters.shift();
    if (w) w(msg.wire);
    else queue.push(msg.wire);
  });
  return {
    send: (data) =>
      // Resolve only once the IPC message has been handed to the OS, not on the
      // bare synchronous return. process.send is fire-and-forget, so a child that
      // sends its final frame and then disconnects can drop it: at high D the
      // receiver's closing result frame raced its own process.disconnect() and was
      // lost, deadlocking the sender on its receiveParsed. The post-flush callback
      // serialises the send before any later disconnect.
      new Promise((resolve, reject) => {
        process.send({ wire: data }, (err) => (err ? reject(err) : resolve()));
      }),
    receive: () =>
      queue.length
        ? Promise.resolve(queue.shift())
        : new Promise((resolve) => waiters.push(resolve)),
    close: () => Promise.resolve(),
  };
}

async function runChildRole(role, rows, keys, overlap) {
  installWasmHeapProbe();
  const { default: PSI } = await import("@openmined/psi.js");
  const { PSIParticipant, linkViaSinglePassPSI } =
    await import("@psilink/core");
  const lib = await PSI();

  const overlapRows = Math.floor(rows * overlap);
  const data = makeColumns(role, rows, keys, overlapRows);
  const psiRole = role === "sender" ? "starter" : "joiner";
  // Per-message element-count bounds (the required 4th constructor argument): the
  // symmetric sweep pools at most keys * rows distinct values per party, the
  // worst-case cell count, so that is the exact upper bound for every frame kind.
  const cellBound = keys * rows;
  const participant = new PSIParticipant(
    role,
    lib,
    { role: psiRole, verbose: -1 },
    { setup: cellBound, request: cellBound, response: cellBound },
  );
  const conn = ipcConnection();

  // Under --gc the child is forked with --expose-gc, so @psilink/core's
  // relieveTransientMemory fires at the single-pass phase boundaries -- the bench
  // measures that shipped relief in the lifetime maxRSS, it does not force its own
  // collection. globalThis.gc is present iff --expose-gc, which the child also uses
  // for one final collection (below) to read the post-GC live heap: the retained
  // floor the transient peak sits above. RSS does not track the live heap down
  // because neither V8 nor emmalloc returns freed pages to the OS, which is why the
  // floor must be read from heapUsed, not RSS.
  const measureLiveHeap = typeof globalThis.gc === "function";

  // Record stage boundaries so the masking phases can be separated from the
  // brief network waits between them.
  const marks = [];
  const setStage = (id) => marks.push({ id, t: performance.now() });

  const start = performance.now();
  // partnerRecordCount is the peer's row count -- equal to `rows` in this
  // symmetric sweep. It must be the real count: the derived single-pass cap gate
  // (frameSize.ts, board item 206154573) rejects a negative placeholder. The 6th
  // argument withholds the sender's own table (false here -- both sides compute a
  // table, so the receiver's match count can be checked); verbosity is -1
  // (silent); setStage is the 8th argument.
  const table = await linkViaSinglePassPSI(
    { cardinality: "one-to-one" },
    participant,
    conn,
    data,
    rows,
    false,
    -1,
    setStage,
  );
  const wallMs = performance.now() - start;

  // Masking wall-clock: the span from the first masking stage to "done", minus
  // the idle gap each side spends waiting on the peer's frame. Both sides' first
  // stage is "encrypting my data"; the sender then waits for the request before
  // "doubly-encrypting partner's data", and the receiver waits for the reply
  // before "identifying shared elements". We approximate masking as the whole
  // span (the integer index-table and replay work is negligible beside the curve
  // operations), and also report the raw stage marks for inspection.
  const maskMs = wallMs;
  const matches = table[0].length;

  // Correctness gate, not eyeball-only: every shared row is a unique match on
  // key 0 (values are near-unique within a party), so the match count must equal
  // the overlap exactly. A wrong count means the relayed exchange computed the
  // wrong result and the timing/memory numbers describe the wrong workload.
  if (matches !== overlapRows) {
    throw new Error(
      `${role}: correctness check failed -- ${matches} matches, ` +
        `expected ${overlapRows} (rows=${rows} keys=${keys} overlap=${overlap})`,
    );
  }

  // The WASM linear heap is grow-only, so its size now is the lifetime floor.
  const wasmHeap = wasmHeapBytes();
  if (wasmHeap === 0)
    process.stderr.write(
      `${role}: warning: WASM heap probe captured no memory (reported as 0)\n`,
    );

  // One final collection (only when gc is exposed) reads the retained live heap
  // after all transients are collectable. maxRSS above already reflects core's
  // boundary relief; this isolates the floor it sits above.
  let postGcLiveHeapKib;
  if (measureLiveHeap) {
    globalThis.gc();
    postGcLiveHeapKib = process.memoryUsage().heapUsed / 1024;
  }

  process.send(
    {
      result: {
        role,
        rows,
        keys,
        wallMs,
        maskMs,
        matches,
        maxRSS: process.resourceUsage().maxRSS,
        wasmHeapBytes: wasmHeap,
        postGcLiveHeapKib,
        marks,
      },
    },
    // Detach IPC only after the result frame has flushed, so it is never dropped
    // by an early channel close (the same race as ipcConnection.send above). Then
    // the event loop drains and the child exits cleanly.
    () => process.disconnect(),
  );
}

// --- entry ---------------------------------------------------------------------

const [mode, ...rest] = process.argv.slice(2);
if (mode === "child") {
  const [role, rows, keys, overlap] = rest;
  await runChildRole(role, Number(rows), Number(keys), Number(overlap));
} else if (mode === "rates") {
  await runRates(rest);
} else if (mode === "sweep") {
  await runSweep(rest);
} else {
  console.error(
    "usage:\n" +
      "  node scripts/single-pass-bench.mjs rates [D ...]\n" +
      "  node scripts/single-pass-bench.mjs sweep " +
      "[--keys K] [--overlap F] [--sizes N,N,...]",
  );
  process.exit(2);
}
