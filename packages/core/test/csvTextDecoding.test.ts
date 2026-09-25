import { Readable } from "node:stream";

import { describe, expect, test } from "vitest";

import { loadCSVColumnSample, loadCSVFile, streamCSVRows } from "../src/file";

/** A readable emitting `bytes` in `pieceSize`-byte chunks, as a file read does. */
function chunkedBytes(bytes: Uint8Array, pieceSize: number): Readable {
  let offset = 0;
  return new Readable({
    read() {
      if (offset >= bytes.length) {
        this.push(null);
        return;
      }
      const end = Math.min(offset + pieceSize, bytes.length);
      this.push(Buffer.from(bytes.subarray(offset, end)));
      offset = end;
    },
  });
}

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("a multi-byte character split across read chunks", () => {
  // Two-, three- and four-byte characters, so every piece size below splits at
  // least one of them between two chunks.
  const names = ["Søren", "Müller", "José", "€uro", "😀face"];
  const csv = `id,name\n${names.map((name, i) => `${i},${name}`).join("\n")}\n`;

  test.each([1, 2, 3, 5, 7, 11, 13])(
    "loadCSVFile reads every character at %i-byte chunks",
    async (pieceSize) => {
      const result = await loadCSVFile(chunkedBytes(utf8(csv), pieceSize));
      expect(result.data.map((row) => row["name"])).toEqual(names);
    },
  );

  test("streamCSVRows reads every character", async () => {
    const seen: Array<string | undefined> = [];
    await streamCSVRows(chunkedBytes(utf8(csv), 3), (rows) => {
      for (const row of rows) seen.push(row["name"]);
    });
    expect(seen).toEqual(names);
  });

  test("loadCSVColumnSample reads every character", async () => {
    const { sample } = await loadCSVColumnSample(
      chunkedBytes(utf8(csv), 3),
      () => "name",
      100,
    );
    expect(sample).toEqual(names);
  });

  test("a header character split across chunks is read whole", async () => {
    const result = await loadCSVFile(
      chunkedBytes(utf8("prénom,âge\nAnne,40\n"), 3),
    );
    expect(result.meta.fields).toEqual(["prénom", "âge"]);
    expect(result.meta.sanitizedColumnPositions).toEqual([]);
  });

  test("a byte-order mark split across chunks is dropped", async () => {
    const result = await loadCSVFile(chunkedBytes(utf8("﻿id,name\n1,a\n"), 2));
    expect(result.meta.fields).toEqual(["id", "name"]);
  });

  test("a browser File larger than one stream chunk reads every character", async () => {
    // Blob.stream() yields 64 KiB chunks in Node; a 3-byte character on every
    // position means the boundaries fall inside one.
    const rowCount = 20_000;
    const rows = Array.from({ length: rowCount }, (_, i) => `${i},€€€`);
    const file = new File([`id,sym\n${rows.join("\n")}\n`], "wide.csv");
    expect(file.size).toBeGreaterThan(4 * 65_536);
    const result = await loadCSVFile(file);
    expect(result.data).toHaveLength(rowCount);
    expect(result.data.every((row) => row["sym"] === "€€€")).toBe(true);
  });
});

test("a byte that is not UTF-8 still reads as U+FFFD", async () => {
  // Latin-1 "é" (0xe9): the read replaces it rather than refusing the file.
  const bytes = Uint8Array.from([...utf8("id,n\n1,"), 0xe9, ...utf8("t\n")]);
  const result = await loadCSVFile(chunkedBytes(bytes, 64));
  expect(result.data).toEqual([{ id: "1", n: "�t" }]);
});

describe("a CRLF file whose header spans more than one read chunk", () => {
  const columnCount = 400;
  const header = Array.from({ length: columnCount }, (_, i) => `c${i}`);
  const row = (r: number): string =>
    header.map((_, i) => `r${r}v${i}`).join(",");
  const csv = `${header.join(",")}\r\n${row(0)}\r\n${row(1)}\r\n`;

  test("leaves no CR on the last column", async () => {
    const bytes = utf8(csv);
    const result = await loadCSVFile(chunkedBytes(bytes, 1024));
    expect(header.join(",").length).toBeGreaterThan(1024);
    expect(result.meta.fields).toEqual(header);
    expect(result.meta.sanitizedColumnPositions).toEqual([]);
    const last = `c${columnCount - 1}`;
    expect(result.data.map((r) => r[last])).toEqual([
      `r0v${columnCount - 1}`,
      `r1v${columnCount - 1}`,
    ]);
  });

  test("reads a CR and LF that fall in different chunks", async () => {
    // The first chunk ends on the header's CR; its LF opens the next chunk.
    const headerLine = header.join(",");
    const result = await loadCSVFile(
      chunkedBytes(utf8(csv), headerLine.length + 1),
    );
    expect(result.meta.fields).toEqual(header);
    expect(result.data).toHaveLength(2);
  });

  test("loadCSVColumnSample leaves no CR on the sampled last column", async () => {
    const last = `c${columnCount - 1}`;
    const { sample } = await loadCSVColumnSample(
      chunkedBytes(utf8(csv), 1024),
      () => last,
      10,
    );
    expect(sample).toEqual([`r0v${columnCount - 1}`, `r1v${columnCount - 1}`]);
  });
});
