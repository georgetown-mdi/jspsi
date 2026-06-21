/// <reference types="@vitest/browser-playwright/context" />

import { describe, expect, test } from "vitest";

import Papa from "papaparse";

import { loadCSVFile } from "@psilink/core";

// Pin the no-silent-truncation invariant directly, in the mode where it can
// actually break. loadCSVFile parses with `worker: true`, and PapaParse worker
// mode posts each LocalChunkSize chunk back separately while handing `complete`
// only the FINAL chunk -- so before the chunk-accumulation fix, any file spanning
// more than one chunk parsed to a silently truncated subset (the last chunk's
// rows) with no error, which in a record-linkage tool is a wrong intersection.
// This builds a CSV deliberately larger than one chunk, runs it through the real
// browser worker path, and asserts EVERY row survives -- it fails against the old
// final-chunk-only behavior rather than the cap-vs-chunk-size arithmetic the old
// fileSelect cap test stood in for.
describe("loadCSVFile multi-chunk parsing", () => {
  test("returns every row of a file that spans more than one PapaParse chunk", async () => {
    // The bug is worker-specific; if the browser could not spawn a worker the
    // parse would fall back to the inline path that never truncated, so this test
    // would not exercise the regression. Assert worker mode is actually available.
    expect(Papa.WORKERS_SUPPORTED).toBe(true);

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
