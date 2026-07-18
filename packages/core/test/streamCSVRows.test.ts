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
