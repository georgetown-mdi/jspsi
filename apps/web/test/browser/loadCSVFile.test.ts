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

    const result = await loadCSVFile(file);
    const rows = result.data as Array<Record<string, string>>;

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
