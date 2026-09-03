import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import { FAN_OUT_CANDIDATES_PER_ELEMENT } from "../src/fanOutFunctions";
import {
  decodeFixedWidthIndexTable,
  decodeInt32LE,
  decodeRaggedIndexTable,
  decodeSinglePassReply,
  encodeInt32LE,
  encodeSinglePassReply,
  getSortedDistinctValueIndices,
} from "../src/link";

import type { KeyCells, LocalKeyColumn } from "../src/link";

/**
 * Conformance replay of test/vectors/index-table-vectors.json: the wire layout of
 * the single-pass distinct-value index table, part (d) of message 2, in both the
 * forms a sender ships -- fixed-width from a sender declaring no fan-out, ragged
 * from one that declares one (docs/spec/PROTOCOL.md, Linkage strategies and
 * Wire-format deltas). The layout is chosen by authenticated per-party session
 * state with no wire flag, so a delta in either -- the -1 marker, the key-major
 * word order, the count prefix, the remap into the setup message's sorted order,
 * or the frame's part boundaries -- is one a partner on another build misreads.
 *
 * The guards that REFUSE a malformed table are driven from their own words in
 * singlePassFanOut.test.ts; what is pinned here is the conforming bytes.
 * Regenerate with vectors/generate-index-table-vectors.mjs.
 */

/** Per key, per record, the value indices that cell carries. */
type Cells = Array<Array<Array<number>>>;

interface FixedWidthTable {
  name: string;
  layout: "fixed-width";
  description: string;
  keyCount: number;
  recordCount: number;
  distinctValueCount: number;
  permutation: Array<number>;
  /** Per key, the build-order value id each record holds, -1 for none. */
  columns: Array<Array<number>>;
  words: Array<number>;
  wordsHex: string;
  cells: Cells;
}

interface RaggedTable {
  name: string;
  layout: "ragged";
  description: string;
  keyCount: number;
  recordCount: number;
  distinctValueCount: number;
  permutation: Array<number>;
  /** Per key, per record, the build-order value ids that record contributes. */
  columns: Cells;
  keyWidths: Array<number>;
  slotBound: number;
  words: Array<number>;
  wordsHex: string;
  cells: Cells;
}

type Table = FixedWidthTable | RaggedTable;

interface IndexTableVectors {
  fanOutCandidatesPerElement: number;
  tables: Array<Table>;
  replyFrames: Array<{
    name: string;
    description: string;
    table: string;
    setupHex: string;
    responseHex: string;
    recordCount: number;
    frameHex: string;
  }>;
}

const vectors: IndexTableVectors = JSON.parse(
  readFileSync(
    new URL("./vectors/index-table-vectors.json", import.meta.url),
    "utf-8",
  ),
);

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const fromHex = (text: string): Uint8Array =>
  Uint8Array.from(Buffer.from(text, "hex"));

/** The build-order columns as the sender's own table, in its layout. */
function localColumns(table: Table): Array<LocalKeyColumn> {
  if (table.layout === "fixed-width")
    return table.columns.map((indices) => ({ ragged: false, indices }));
  return table.columns.map((column) => {
    const starts = new Int32Array(column.length + 1);
    const values: Array<number> = [];
    column.forEach((cell, row) => {
      values.push(...cell);
      starts[row + 1] = values.length;
    });
    return { ragged: true, starts, values: Int32Array.from(values) };
  });
}

/** The decoded table read back out through the KeyCells interface. */
function readCells(cells: Array<KeyCells>, recordCount: number): Cells {
  return cells.map((key) =>
    Array.from({ length: recordCount }, (_row, row) =>
      Array.from({ length: key.count(row) }, (_k, k) => key.valueAt(row, k)),
    ),
  );
}

function decodeTable(table: Table, words: Int32Array): Array<KeyCells> {
  return table.layout === "fixed-width"
    ? decodeFixedWidthIndexTable(
        "partner",
        words,
        table.keyCount,
        table.recordCount,
      )
    : decodeRaggedIndexTable(
        "partner",
        words,
        table.keyWidths,
        table.recordCount,
        table.slotBound,
      );
}

const named = (table: Table): [string, Table] => [table.name, table];

describe("single-pass index-table layout vectors", () => {
  test("the file pins this build's per-element candidate factor", () => {
    // The ragged layout's declared key widths and the slot bounds derived beside
    // them are all relative to this constant, so a file pinned to another value
    // pins a table the receiver's own bounds would not admit.
    expect(vectors.fanOutCandidatesPerElement).toBe(
      FAN_OUT_CANDIDATES_PER_ELEMENT,
    );
  });

  test("both layouts are pinned, as a table and inside a whole reply frame", () => {
    // A layout that fell out of the file would be one nothing here holds, which
    // is the hole these vectors close.
    const layouts = new Set(vectors.tables.map((table) => table.layout));
    expect([...layouts].sort()).toEqual(["fixed-width", "ragged"]);
    const framed = new Set(
      vectors.replyFrames.map(
        (frame) =>
          vectors.tables.find((table) => table.name === frame.table)?.layout,
      ),
    );
    expect([...framed].sort()).toEqual(["fixed-width", "ragged"]);
  });

  test.each(vectors.tables.map(named))(
    "%s: the sender's remap produces the pinned words",
    (_name, table) => {
      expect(
        getSortedDistinctValueIndices(
          localColumns(table),
          table.permutation,
          table.recordCount,
        ),
      ).toEqual(table.words);
    },
  );

  test.each(vectors.tables.map(named))(
    "%s: the words are the pinned little-endian bytes",
    (_name, table) => {
      expect(hex(encodeInt32LE(table.words))).toBe(table.wordsHex);
      expect(Array.from(decodeInt32LE(fromHex(table.wordsHex)))).toEqual(
        table.words,
      );
    },
  );

  test.each(vectors.tables.map(named))(
    "%s: a receiver decodes the pinned bytes into the pinned cells",
    (_name, table) => {
      const cells = decodeTable(table, decodeInt32LE(fromHex(table.wordsHex)));
      expect(cells).toHaveLength(table.keyCount);
      expect(readCells(cells, table.recordCount)).toEqual(table.cells);
    },
  );

  test.each(vectors.tables.map(named))(
    "%s: the decoded cells are the sender's own values under the permutation",
    (_name, table) => {
      // The independent half: the words above are what the implementation
      // produces, and this is what they have to MEAN. The setup message carries
      // permutation[sortedPosition] = buildOrderValueId, so inverting it gives
      // the sorted position of each value the sender built, and a cell is the
      // ids it holds under that inverse, ascending.
      const sortedPosOf = new Array<number>(table.permutation.length);
      table.permutation.forEach((buildId, sortedPosition) => {
        sortedPosOf[buildId] = sortedPosition;
      });
      const expected =
        table.layout === "fixed-width"
          ? table.columns.map((column) =>
              column.map((id) => (id < 0 ? [] : [sortedPosOf[id]])),
            )
          : table.columns.map((column) =>
              column.map((cell) =>
                cell.map((id) => sortedPosOf[id]).sort((a, b) => a - b),
              ),
            );
      expect(table.cells).toEqual(expected);
    },
  );

  test.each(vectors.replyFrames.map((frame) => [frame.name, frame] as const))(
    "%s: message 2 packs its four parts into the pinned frame",
    (_name, entry) => {
      const table = vectors.tables.find((each) => each.name === entry.table);
      expect(table, `${entry.name} names an unpinned table`).toBeDefined();
      const pinned = table as Table;
      expect(entry.recordCount).toBe(pinned.recordCount);

      const frame = encodeSinglePassReply(
        fromHex(entry.setupHex),
        fromHex(entry.responseHex),
        entry.recordCount,
        pinned.words,
      );
      expect(hex(frame)).toBe(entry.frameHex);

      const split = decodeSinglePassReply(fromHex(entry.frameHex));
      expect(hex(split.setup)).toBe(entry.setupHex);
      expect(hex(split.response)).toBe(entry.responseHex);
      expect(split.numRecords).toBe(entry.recordCount);
      expect(Array.from(split.distinctValueIndices)).toEqual(pinned.words);

      // The table reached the receiver as the same table, through the frame
      // rather than on its own: part (d)'s boundary is where a length-prefix
      // change would land, and a table read one word off decodes differently.
      expect(
        readCells(
          decodeTable(pinned, split.distinctValueIndices),
          pinned.recordCount,
        ),
      ).toEqual(pinned.cells);
    },
  );
});
