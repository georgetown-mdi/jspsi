import { Readable } from "node:stream";

import { expect, test } from "vitest";

import { CSV_LINE_BYTE_CEILING, loadCSVFile, streamCSVRows } from "../src/file";
import type { CSVRow } from "../src/file";

/** A readable emitting `content` then EOF, standing in for a CSV file/stream. */
function streamOf(content: string): Readable {
  const s = new Readable({ read() {} });
  if (content.length > 0) s.push(Buffer.from(content, "utf8"));
  s.push(null);
  return s;
}

/** A readable emitting `content` split into fixed-size byte slices, so a multi-row
 * CSV crosses several parse chunks with slice boundaries falling mid-row: each stream
 * `data` event is one PapaParse chunk, so a value split across two slices exercises
 * the runner's partial-line rejoin. */
function streamOfSlices(content: string, sliceBytes: number): Readable {
  const s = new Readable({ read() {} });
  const buf = Buffer.from(content, "utf8");
  for (let at = 0; at < buf.length; at += sliceBytes)
    s.push(buf.subarray(at, Math.min(at + sliceBytes, buf.length)));
  s.push(null);
  return s;
}

/** A CSV over an `id,payload` pair with `rows` uniquely-valued data rows, each about
 * 90 bytes, so a modest row count exceeds one PapaParse chunk. Each row's `id` is its
 * index, so a dropped or mis-joined boundary row breaks the sequence. */
function csvWithSequentialRows(rows: number): string {
  const lines = ["id,payload"];
  for (let i = 0; i < rows; i++) {
    const index = String(i).padStart(8, "0");
    lines.push(`id${index},payload-${index}-${"z".repeat(60)}`);
  }
  return lines.join("\n") + "\n";
}

/** A CSV over four columns with `rows` data rows, some blanks interspersed. */
function csvWithRows(rows: number): string {
  const body = Array.from({ length: rows }, (_v, i) => {
    const last = i % 5 === 0 ? "" : `Last${i}`;
    return `First${i},${last},1990-01-${String((i % 28) + 1).padStart(2, "0")},${i}`;
  }).join("\n");
  return `first_name,last_name,dob,member_id\n${body}\n`;
}

test("streamCSVRows yields exactly the rows and columns loadCSVFile accumulates", async () => {
  const csv = csvWithRows(2000);
  const collected: Array<CSVRow> = [];
  const columns = await streamCSVRows(streamOf(csv), (rows) => {
    for (const row of rows) collected.push(row);
  });
  const full = await loadCSVFile(streamOf(csv));
  expect(collected).toEqual(full.data);
  expect(columns).toEqual(full.meta.fields);
});

test("streamCSVRows retains nothing: it hands each chunk's rows to the consumer", async () => {
  const csv = csvWithRows(50);
  let seen = 0;
  const columns = await streamCSVRows(streamOf(csv), (rows, cols) => {
    seen += rows.length;
    // The header column list is available on every chunk.
    expect(cols).toEqual(["first_name", "last_name", "dob", "member_id"]);
  });
  expect(seen).toBe(50);
  expect(columns).toEqual(["first_name", "last_name", "dob", "member_id"]);
});

test("streamCSVRows resolves an empty header list for a headerless empty input", async () => {
  const columns = await streamCSVRows(streamOf("\n"), () => undefined);
  expect(columns).toEqual([]);
});

test("streamCSVRows enforces the single-line byte ceiling like loadCSVFile", async () => {
  const giant = "x".repeat(CSV_LINE_BYTE_CEILING + 1024);
  await expect(streamCSVRows(streamOf(giant), () => undefined)).rejects.toThrow(
    /single-line limit/,
  );
});

// PapaParse's local chunk size (Papa.LocalChunkSize is 10 MB): a file past it parses
// in more than one chunk, so a row whose bytes straddle the boundary must be rejoined
// rather than dropped or truncated.
const PAPA_LOCAL_CHUNK_BYTES = 10 * 1024 * 1024;

test("streamCSVRows reassembles rows split across chunk boundaries in a >10MB file", async () => {
  const rowCount = 130_000;
  const csv = csvWithSequentialRows(rowCount);
  expect(Buffer.byteLength(csv)).toBeGreaterThan(PAPA_LOCAL_CHUNK_BYTES);

  const collected: Array<CSVRow> = [];
  const firstRowsAfterBoundary: Array<CSVRow> = [];
  let chunkCalls = 0;
  await streamCSVRows(streamOfSlices(csv, 4 * 1024 * 1024), (rows) => {
    if (chunkCalls > 0 && rows.length > 0) firstRowsAfterBoundary.push(rows[0]);
    chunkCalls++;
    for (const row of rows) collected.push(row);
  });

  // The >10MB input genuinely crossed a chunk boundary.
  expect(chunkCalls).toBeGreaterThan(1);
  // Every row survived, in order, with its value intact: a mis-joined boundary row
  // would break the sequential id run.
  expect(collected.length).toBe(rowCount);
  let idsInOrder = true;
  for (let i = 0; i < rowCount; i++)
    if (collected[i].id !== `id${String(i).padStart(8, "0")}`) {
      idsInOrder = false;
      break;
    }
  expect(idsInOrder).toBe(true);
  // The row straddling each boundary is the first of a later chunk; its payload is the
  // full 60-character tail, not a fragment truncated at the split.
  expect(firstRowsAfterBoundary.length).toBeGreaterThan(0);
  for (const row of firstRowsAfterBoundary)
    expect(row.payload).toMatch(/^payload-\d{8}-z{60}$/);
});
