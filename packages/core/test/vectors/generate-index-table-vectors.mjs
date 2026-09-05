// Regenerates index-table-vectors.json: the wire layout of the single-pass
// distinct-value index table, in both the forms a sender ships. From the repo
// root:
//
//   npm run build -w packages/core   # the generator imports the built dist below
//   node packages/core/test/vectors/generate-index-table-vectors.mjs > \
//     packages/core/test/vectors/index-table-vectors.json
//   npm run format                   # apply the repo's JSON layout
//
// Purpose: single-pass message 2 packs the sender's whole reply into one binary
// frame whose fourth part is the distinct-value index table -- the remaining
// bytes, as a little-endian Int32 array (docs/spec/PROTOCOL.md, Linkage
// strategies: cascade and single-pass). It takes one of two layouts, chosen by
// the SENDER's declared effective key count with no wire flag:
//
//   - FIXED-WIDTH, from a sender that declares no fan-out: one word per (key,
//     record) in key-major order, -1 where the record has no value for the key.
//   - RAGGED, from a sender that declares a fan-out: per (key, record) a count
//     word then that many value-index words, strictly ascending within the cell,
//     with no absent marker -- an empty cell is a count of 0 (docs/spec/
//     PROTOCOL.md, Wire-format deltas: existing frames only, and no version bump).
//
// Both are read on the receiver from authenticated session state alone, so a
// delta in either -- the marker value, the word order, the count prefix, the
// remap into the setup message's sorted order, the frame's part boundaries -- is
// a wire-format delta a partner on another build would misread. The suites around
// them assert the guards that REFUSE a malformed table (singlePassFanOut.test.ts
// enumerates every ragged refusal) and that a whole exchange resolves; none pinned
// the conforming bytes. This file is those bytes, and
// packages/core/test/indexTableVectors.test.ts replays them.
//
// Not here, by design: the refusal corpus. A refused frame is not a wire format,
// and singlePassFanOut.test.ts already drives each ragged guard from its own
// words; a second copy here would pin diagnostics rather than a layout.
//
// The reply frames below contain SYNTHETIC setup and response bytes. Those two parts
// are the PSI engine's own serialization, whose byte stability is pinned by
// psi-engine-wire-vectors.json, and a real pair is not reproducible here anyway --
// the engine draws a fresh key per exchange. What this file pins about them is
// where they sit in the frame and how their lengths are included, which the
// synthetic bytes exercise exactly.

import {
  FAN_OUT_CANDIDATES_PER_ELEMENT,
  decodeFixedWidthIndexTable,
  decodeInt32LE,
  decodeRaggedIndexTable,
  decodeSinglePassReply,
  encodeInt32LE,
  encodeSinglePassReply,
  getSortedDistinctValueIndices,
} from "../../dist/testing.esm.js";

const hex = (bytes) => Buffer.from(bytes).toString("hex");
const fromHex = (text) => Uint8Array.from(Buffer.from(text, "hex"));

// Every table is described in BUILD order -- the order the sender assigned value
// ids while walking its own records -- plus the sorting permutation the setup
// message holds internally. The remap into sorted order is the thing under
// test, so neither side of it is pre-baked.
const tables = [
  {
    name: "fixed-width-absent-marker-and-shared-values",
    layout: "fixed-width",
    description:
      "A sender declaring no fan-out, over two keys and three records. Key 0 " +
      "leaves record 1 with no value, which is the -1 marker on the wire; key 1 " +
      "gives records 1 and 2 the same value, which is the per-key duplicate " +
      "structure the receiver replays the cascade over. The permutation reorders " +
      "every value, so a remap that dropped it would ship different words.",
    // Per key, the build-order value id each record holds, -1 for none.
    columns: [
      [0, -1, 1],
      [2, 0, 0],
    ],
    // permutation[sortedPosition] = buildOrderValueId, as createServerSetup
    // yields it.
    permutation: [2, 0, 1],
  },
  {
    name: "ragged-widths-zero-one-and-many",
    layout: "ragged",
    description:
      "A sender declaring a fan-out, over two keys and three records, with cells " +
      "of width 0, 1, 2, and 3. Two cells list their candidates in an order that " +
      "is NOT ascending in build order, so the strict ascent the receiver " +
      "validates has to come from the re-sort applied after the remap rather " +
      "than from the order the sender built them in. The declared widths DIFFER " +
      "between the two keys -- the shape agreed terms take as soon as one key " +
      "declares a fan-out and another a narrower expansion -- and key 1's widest " +
      "cell sits exactly at its own width, so a receiver holding every cell to " +
      "one key's width reads this table wrong in one direction or the other.",
    // Per key, per record, the build-order value ids that record contributes.
    columns: [
      [[1, 0], [], [3]],
      [[2], [0, 2, 3], [1]],
    ],
    permutation: [3, 1, 0, 2],
    // The width the agreed terms declare for each key, which is the per-cell
    // bound the receiver applies and, summed and multiplied by the record count,
    // the slot bound beside it. Both are derived from the terms and never from
    // the frame. Key 1 declares the fuzzy ceiling of `adjacent_years` beside key
    // 0's fan-out width, so the vector is not uniform.
    keyWidths: [FAN_OUT_CANDIDATES_PER_ELEMENT, 3],
  },
];

const replyFrames = [
  {
    name: "fixed-width-table-in-a-full-reply",
    table: "fixed-width-absent-marker-and-shared-values",
    description:
      "The whole of message 2 around a fixed-width table: a uint32 setup length " +
      "and the setup, a uint32 response length and the response, a uint32 record " +
      "count, then the table as the remaining bytes.",
    setupHex: "0001020304050607",
    responseHex: "f0f1f2f3f4",
  },
  {
    name: "ragged-table-after-empty-setup-and-response",
    table: "ragged-widths-zero-one-and-many",
    description:
      "The same frame with both length-prefixed parts empty, so the table starts " +
      "at the fixed 12-byte header. A decoder that read a length prefix as " +
      "anything but a uint32, or that skipped a zero-length part's prefix, lands " +
      "on different words here.",
    setupHex: "",
    responseHex: "",
  },
];

/** The KeyCells the table decodes to, as per-key, per-record index lists. */
function readCells(cells, recordCount) {
  return cells.map((key) =>
    Array.from({ length: recordCount }, (_unused, row) =>
      Array.from({ length: key.count(row) }, (_also, k) => key.valueAt(row, k)),
    ),
  );
}

function buildTable(table) {
  const keyCount = table.columns.length;
  const recordCount = table.columns[0].length;

  for (const column of table.columns) {
    if (column.length !== recordCount)
      throw new Error(
        `${table.name}: every key column must cover the same ${recordCount} ` +
          `record(s); one covers ${column.length}.`,
      );
  }

  const columns = table.columns.map((column) => {
    if (table.layout === "fixed-width")
      return { ragged: false, indices: column };
    const starts = new Int32Array(column.length + 1);
    const values = [];
    column.forEach((cell, row) => {
      for (const value of cell) values.push(value);
      starts[row + 1] = values.length;
    });
    return { ragged: true, starts, values: Int32Array.from(values) };
  });

  const words = getSortedDistinctValueIndices(
    columns,
    table.permutation,
    recordCount,
  );
  const wordBytes = encodeInt32LE(words);

  // The decode side of the same layout, from the words alone -- so what the file
  // pins as `cells` is what a receiver reconstructs, not what the sender meant.
  const decoded = decodeInt32LE(wordBytes);
  const slotBound =
    table.layout === "ragged"
      ? table.keyWidths.reduce((sum, width) => sum + width, 0) * recordCount
      : undefined;
  const cells =
    table.layout === "fixed-width"
      ? decodeFixedWidthIndexTable("generator", decoded, keyCount, recordCount)
      : decodeRaggedIndexTable(
          "generator",
          decoded,
          table.keyWidths,
          recordCount,
          slotBound,
        );

  return {
    name: table.name,
    layout: table.layout,
    description: table.description,
    keyCount,
    recordCount,
    distinctValueCount: table.permutation.length,
    permutation: table.permutation,
    columns: table.columns,
    ...(slotBound === undefined
      ? {}
      : { keyWidths: table.keyWidths, slotBound }),
    words,
    wordsHex: hex(wordBytes),
    cells: readCells(cells, recordCount),
  };
}

const builtTables = tables.map(buildTable);
const tableByName = new Map(builtTables.map((table) => [table.name, table]));

function buildReplyFrame(entry) {
  const table = tableByName.get(entry.table);
  if (table === undefined)
    throw new Error(
      `${entry.name} names table "${entry.table}", which this generator does ` +
        "not build.",
    );

  const setup = fromHex(entry.setupHex);
  const response = fromHex(entry.responseHex);
  const frame = encodeSinglePassReply(
    setup,
    response,
    table.recordCount,
    table.words,
  );

  // Round-trip through the real splitter, so what lands in the file is a frame
  // the decoder reads back into the same four parts rather than one only the
  // encoder agrees with.
  const split = decodeSinglePassReply(frame);
  const mismatch =
    hex(split.setup) !== entry.setupHex
      ? "setup"
      : hex(split.response) !== entry.responseHex
        ? "response"
        : split.numRecords !== table.recordCount
          ? "record count"
          : Array.from(split.distinctValueIndices).join() !== table.words.join()
            ? "index table"
            : undefined;
  if (mismatch !== undefined)
    throw new Error(
      `${entry.name}: decodeSinglePassReply did not return the ${mismatch} ` +
        "encodeSinglePassReply was given; the frame is not a known answer.",
    );

  return {
    name: entry.name,
    description: entry.description,
    table: entry.table,
    setupHex: entry.setupHex,
    responseHex: entry.responseHex,
    recordCount: table.recordCount,
    frameHex: hex(frame),
  };
}

const vectors = {
  description:
    "Known-answer vectors for the single-pass distinct-value index table -- part " +
    "(d) of message 2 -- in both layouts a sender ships: fixed-width from a " +
    "sender declaring no fan-out (one word per (key, record), -1 for absent), " +
    "and ragged from one that declares a fan-out (a count word per cell then " +
    "that many strictly ascending value-index words, no absent marker). The " +
    "layout is chosen by authenticated per-party session state with no wire " +
    "flag, so both parties must agree on it from the same inputs. Each table is " +
    "given in BUILD order with the setup message's sorting permutation beside " +
    "it, and the remap into sorted order is applied here rather than pre-baked. " +
    "`words` is the flat Int32 array on the wire, `wordsHex` its little-endian " +
    "bytes, and `cells` what a receiver decodes those words back into. The reply " +
    "frames wrap each table in the whole of message 2, with synthetic setup and " +
    "response bytes: those two parts are the PSI engine's own serialization, " +
    "pinned for bytes by psi-engine-wire-vectors.json, and what is pinned here " +
    "is where they sit in the frame and how their lengths are carried. Replayed " +
    "by packages/core/test/indexTableVectors.test.ts; regenerate with " +
    "generate-index-table-vectors.mjs in this directory.",
  wordEncoding:
    "Every word is a little-endian two's-complement int32, so the fixed-width " +
    "layout's -1 absent marker is the four bytes ffffffff.",
  replyFrameLayout:
    "uint32 setup length | setup | uint32 response length | response | uint32 " +
    "record count | the index table as the remaining bytes. The two " +
    "length-prefixed parts carry explicit lengths; the table's length is implied " +
    "by the frame size.",
  fanOutCandidatesPerElement: FAN_OUT_CANDIDATES_PER_ELEMENT,
  tables: builtTables,
  replyFrames: replyFrames.map(buildReplyFrame),
};

process.stdout.write(`${JSON.stringify(vectors, null, 2)}\n`);
