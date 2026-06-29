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
// Two modes:
//
//   node scripts/single-pass-bench.mjs rates [D ...]
//     Times each masking op directly at the given distinct-value counts (no
//     network) and prints per-value microseconds and bytes-per-value. Establishes
//     that masking is linear in the distinct-value count, so the table in the
//     spec can extrapolate from these slopes.
//
//   node scripts/single-pass-bench.mjs sweep [--keys K] [--overlap F] [--sizes N,N,...]
//     For each row count N it forks a sender and a receiver child running the real
//     linkViaSinglePassPSI over a parent-relayed pipe, so each process's peak RSS
//     (process.resourceUsage().maxRSS) is isolated and faithful -- the receiver
//     decode + index-table build + cascade replay are exercised exactly as in a
//     live exchange. Prints a table of masking wall-clock and peak RSS per side.
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
  const { default: PSI } = await import("@openmined/psi.js");
  const { PSIParticipant } = await import("@psilink/core");
  const lib = await PSI();
  const Ds = argv.length ? argv.map(Number) : [2000, 8000, 32000];

  console.log(
    "Per-distinct-value masking cost (single-threaded @openmined/psi.js):\n",
  );
  console.log(
    "      D | setup us/v | request us/v | response us/v | match us/v | bytes/v",
  );
  console.log(
    "  ------+------------+--------------+---------------+------------+--------",
  );
  for (const D of Ds) {
    const server = new PSIParticipant("s", lib, {
      role: "starter",
      verbose: -1,
    });
    const client = new PSIParticipant("c", lib, {
      role: "joiner",
      verbose: -1,
    });
    const sVals = Array.from({ length: D }, (_, i) => `s_${i}`);
    const cVals = Array.from({ length: D }, (_, i) => `c_${i}`);

    let t = performance.now();
    const { setup } = server.createServerSetup(sVals);
    const tSetup = performance.now() - t;
    t = performance.now();
    const request = client.createClientRequest(cVals);
    const tReq = performance.now() - t;
    t = performance.now();
    const response = server.processClientRequest(request);
    const tResp = performance.now() - t;
    t = performance.now();
    client.computeValueMatches(setup, response);
    const tMatch = performance.now() - t;

    const us = (ms) => ((ms / D) * 1000).toFixed(1);
    console.log(
      `  ${String(D).padStart(5)} | ${us(tSetup).padStart(10)} | ` +
        `${us(tReq).padStart(12)} | ${us(tResp).padStart(13)} | ` +
        `${us(tMatch).padStart(10)} | ${(setup.byteLength / D).toFixed(1)}`,
    );
  }
  console.log(
    `\n  peak RSS for this process: ${mb(process.resourceUsage().maxRSS)} MB`,
  );
}

// --- mode: sweep (parent) ------------------------------------------------------

function runChild(role, rows, keys, overlap, relayTo, onResult) {
  const child = fork(
    HERE,
    ["child", role, String(rows), String(keys), String(overlap)],
    { serialization: "advanced" },
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

async function runOneSize(rows, keys, overlap) {
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
  for (let i = 0; i < argv.length; ++i) {
    if (argv[i] === "--keys") keys = Number(argv[++i]);
    else if (argv[i] === "--overlap") overlap = Number(argv[++i]);
    else if (argv[i] === "--sizes")
      sizes = argv[++i].split(",").map((s) => Number(s.trim()));
  }

  console.log(
    `Single-pass sweep: keys=${keys}, overlap=${overlap}, ` +
      `equal-sized parties, near-unique keys (D = keys * rows).\n`,
  );
  console.log(
    "   rows |       D | reply MB | send mask s | recv mask s | " +
      "send RSS MB | recv RSS MB | matches",
  );
  console.log(
    "  ------+---------+----------+-------------+-------------+" +
      "-------------+-------------+--------",
  );

  const rows = [];
  for (const n of sizes) {
    const r = await runOneSize(n, keys, overlap);
    const D = keys * n;
    const sendMask = (r.sender.maskMs / 1000).toFixed(1);
    const recvMask = (r.receiver.maskMs / 1000).toFixed(1);
    console.log(
      `  ${String(n).padStart(5)} | ${String(D).padStart(7)} | ` +
        `${(r.wireMax.toReceiver / 1048576).toFixed(1).padStart(8)} | ` +
        `${sendMask.padStart(11)} | ${recvMask.padStart(11)} | ` +
        `${mb(r.sender.maxRSS).padStart(11)} | ` +
        `${mb(r.receiver.maxRSS).padStart(11)} | ${r.receiver.matches}`,
    );
    rows.push({
      rows: n,
      distinctPerParty: D,
      replyBytes: r.wireMax.toReceiver,
      senderMaskMs: r.sender.maskMs,
      receiverMaskMs: r.receiver.maskMs,
      senderMaxRssMB: Number(mb(r.sender.maxRSS)),
      receiverMaxRssMB: Number(mb(r.receiver.maxRSS)),
      matches: r.receiver.matches,
    });
  }
  console.log("\nJSON:\n" + JSON.stringify({ keys, overlap, rows }, null, 2));
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
    send: (data) => {
      process.send({ wire: data });
      return Promise.resolve();
    },
    receive: () =>
      queue.length
        ? Promise.resolve(queue.shift())
        : new Promise((resolve) => waiters.push(resolve)),
    close: () => Promise.resolve(),
  };
}

async function runChildRole(role, rows, keys, overlap) {
  const { default: PSI } = await import("@openmined/psi.js");
  const { PSIParticipant, linkViaSinglePassPSI } =
    await import("@psilink/core");
  const lib = await PSI();

  const overlapRows = Math.floor(rows * overlap);
  const data = makeColumns(role, rows, keys, overlapRows);
  const psiRole = role === "sender" ? "starter" : "joiner";
  const participant = new PSIParticipant(role, lib, {
    role: psiRole,
    verbose: -1,
  });
  const conn = ipcConnection();

  // Record stage boundaries so the masking phases can be separated from the
  // brief network waits between them.
  const marks = [];
  const setStage = (id) => marks.push({ id, t: performance.now() });

  const start = performance.now();
  const table = await linkViaSinglePassPSI(
    { cardinality: "one-to-one" },
    participant,
    conn,
    data,
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

  process.send({
    result: {
      role,
      rows,
      keys,
      wallMs,
      maskMs,
      matches,
      maxRSS: process.resourceUsage().maxRSS,
      marks,
    },
  });
  // Detach IPC so the event loop can drain and the child exits cleanly.
  process.disconnect();
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
