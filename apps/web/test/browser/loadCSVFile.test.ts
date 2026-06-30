/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import Papa from "papaparse";

import { loadCSVFile } from "@psilink/core";

// Pin the no-silent-truncation invariant directly. loadCSVFile parses inline (NOT
// `worker: true` -- the bundled-worker corruption that fix avoids; see file.ts),
// and PapaParse streams a local File in LocalChunkSize chunks even inline, handing
// `complete` `undefined` once a `chunk` callback is present -- so the rows live
// only in what our `chunk` handler accumulates. Before that accumulation a file
// spanning more than one chunk parsed to a silently truncated subset with no
// error, which in a record-linkage tool is a wrong intersection. This builds a CSV
// deliberately larger than one chunk and asserts EVERY row survives.
describe("loadCSVFile multi-chunk parsing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("returns every row of a file that spans more than one PapaParse chunk", async () => {
    const header = "id,value";
    const pad = "v".repeat(200);
    // One full chunk plus a 1 MiB margin, so the input lands in (at least) two
    // chunks regardless of small future changes to LocalChunkSize.
    const targetBytes = Papa.LocalChunkSize + 1024 ** 2;

    const lines = [header];
    let bytes = header.length + 1; // trailing newline
    let rowCount = 0;
    while (bytes < targetBytes) {
      const line = `${rowCount},${pad}`;
      lines.push(line);
      bytes += line.length + 1;
      rowCount++;
    }
    const csv = lines.join("\n") + "\n";

    const file = new File([csv], "multichunk.csv", { type: "text/csv" });
    // Guard the premise: the ASCII payload is one byte per character, so the file
    // really does exceed a single chunk. A truncating parse would still pass row
    // assertions if the input fit in one chunk, so fail loudly if it does not.
    expect(file.size).toBeGreaterThan(Papa.LocalChunkSize);

    // Count how many times PapaParse actually fires the per-chunk callback, by
    // wrapping the chunk handler the wrapped config carries. This makes the
    // multi-chunk premise executable (it replaces the old `WORKERS_SUPPORTED`
    // assertion): if a future PapaParse delivered this file inline in a single
    // chunk, the accumulation would no longer be exercised and the row assertions
    // below could pass vacuously -- so assert more than one chunk was seen.
    let chunkCalls = 0;
    const realParse = Papa.parse;
    vi.spyOn(Papa, "parse").mockImplementation(((
      input: unknown,
      config: { chunk?: (r: unknown, p: unknown) => void } & Record<
        string,
        unknown
      >,
    ) => {
      const userChunk = config.chunk;
      return (realParse as unknown as (i: unknown, c: unknown) => void)(input, {
        ...config,
        chunk: (r: unknown, p: unknown) => {
          chunkCalls += 1;
          userChunk?.(r, p);
        },
      });
    }) as unknown as typeof Papa.parse);

    const result = await loadCSVFile(file);
    const rows = result.data as Array<Record<string, string>>;

    expect(chunkCalls).toBeGreaterThan(1);
    expect(rows.length).toBe(rowCount);
    expect(result.meta.fields).toEqual(["id", "value"]);
    // Spot-check both ends, including the row straddling the chunk boundary
    // implicitly via the last row, to confirm rows are accumulated in order and
    // intact rather than dropped or duplicated.
    expect(rows[0]).toEqual({ id: "0", value: pad });
    expect(rows[rowCount - 1]).toEqual({
      id: String(rowCount - 1),
      value: pad,
    });
  });
});

describe("loadCSVFile rejects a malformed header", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("rejects when a parsed field is not a string, rather than letting it crash a downstream consumer", async () => {
    // The shape the bundled PapaParse worker produced: the header row and the first
    // data row both land in meta.fields, so a field is an array, not a string. The
    // guard rejects loudly here; without it the non-string field flowed into
    // inferMetadata and surfaced as an opaque `e.toLowerCase is not a function`,
    // which the inviter saw only as "invitation generation failed: TypeError". Drive
    // it directly by having Papa.parse hand back that malformed meta.
    // Hand loadCSVFile the malformed result through its own callbacks. Typed against
    // a minimal local shape and cast to Papa.parse, so the test does not have to
    // satisfy PapaParse's overloaded parse signature.
    type MinimalConfig = {
      chunk?: (results: {
        data: Array<unknown>;
        errors: Array<unknown>;
        meta: { fields: Array<unknown> };
      }) => void;
      complete?: () => void;
    };
    vi.spyOn(Papa, "parse").mockImplementation(((
      _file: unknown,
      config: MinimalConfig,
    ) => {
      config.chunk?.({
        data: [],
        errors: [],
        meta: { fields: ["first_name", ["Alice", "Smith"]] },
      });
      config.complete?.();
    }) as unknown as typeof Papa.parse);

    await expect(
      loadCSVFile(new File(["x"], "data.csv", { type: "text/csv" })),
    ).rejects.toThrow(/non-string column/);
  });
});

// The non-stream (browser File) byte-ceiling bound, exercised end to end in a real
// browser where FileReader exists. loadCSVFile's stream `data`-event counter is
// inert for a File, so a bounded pre-read of the leading line enforces the ceiling
// for the web path; the core unit suite pins the pre-read's branches directly,
// these confirm it is wired through loadCSVFile against a genuine File.
describe("loadCSVFile bounds an oversized leading line for a browser File", () => {
  test("rejects a File whose leading line exceeds the byte ceiling", async () => {
    // One unterminated span past the ceiling: the pre-read rejects before parsing.
    // A small explicit ceiling keeps the input tiny.
    const ceiling = 512;
    const file = new File(["x".repeat(ceiling * 2)], "huge-line.csv", {
      type: "text/csv",
    });
    await expect(loadCSVFile(file, ceiling)).rejects.toThrow(
      /single-line limit/,
    );
  });

  test("parses a large File whose leading line is within the ceiling", async () => {
    // The header terminates immediately, then a body far past the small ceiling
    // streams through -- proving the pre-read gates only the LEADING line and a
    // well-formed File still parses whole, every row intact.
    const ceiling = 512;
    const header = "id,value";
    const rowCount = 2000;
    const rows = Array.from(
      { length: rowCount },
      (_v, i) => `${i},${"v".repeat(8)}`,
    ).join("\n");
    const csv = `${header}\n${rows}\n`;
    expect(csv.length).toBeGreaterThan(ceiling * 4);

    const file = new File([csv], "ok.csv", { type: "text/csv" });
    const result = await loadCSVFile(file, ceiling);
    const rowsParsed = result.data as Array<Record<string, string>>;
    expect(result.meta.fields).toEqual(["id", "value"]);
    expect(rowsParsed.length).toBe(rowCount);
    expect(rowsParsed[0]).toEqual({ id: "0", value: "vvvvvvvv" });
    expect(rowsParsed[rowCount - 1]).toEqual({
      id: String(rowCount - 1),
      value: "vvvvvvvv",
    });
  });
});
