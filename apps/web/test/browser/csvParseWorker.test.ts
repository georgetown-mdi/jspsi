/// <reference types="@vitest/browser-playwright/context" />

import { describe, expect, test } from "vitest";

import { loadCSVFile } from "@psilink/core";

import {
  CSV_WORKER_FILE_BYTE_THRESHOLD,
  loadCSVFileOffMainThread,
} from "@psi/csvParseController";
import { defaultSpawnCSVParseWorker } from "@psi/csvParseWorkerClient";

// The off-main-thread CSV parse, exercised against the REAL Vite-native worker in a
// real browser (dev). The controller's dispatch plumbing is pinned in Node with a
// fake worker (test/unit/csvParseController.test.ts); these confirm the actual worker
// module -- constructed via `new Worker(new URL(...))`, running core's loadCSVFile --
// parses correctly and surfaces core's guards, in a real Worker. The production-BUNDLE
// case (the regression #307 fixed) is a separate build-gated integration test, since
// Vitest's browser mode serves the dev transform, not a `vite build`.

describe("CSV worker parse (real Vite-native worker)", () => {
  test("a parse driven through the worker returns the same data and fields as inline", async () => {
    const csv = "id,value\n0,alpha\n1,beta\n2,gamma\n";
    // Inject the real spawner so the worker path is taken regardless of the size
    // threshold, then compare against the inline parse of the same content.
    const viaWorker = await loadCSVFileOffMainThread(
      new File([csv], "data.csv", { type: "text/csv" }),
      { spawnWorker: defaultSpawnCSVParseWorker },
    );
    const inline = await loadCSVFile(
      new File([csv], "data.csv", { type: "text/csv" }),
    );
    expect(viaWorker.meta.fields).toEqual(inline.meta.fields);
    expect(viaWorker.data).toEqual(inline.data);
    expect(viaWorker.meta.fields).toEqual(["id", "value"]);
    expect(viaWorker.data).toEqual([
      { id: "0", value: "alpha" },
      { id: "1", value: "beta" },
      { id: "2", value: "gamma" },
    ]);
  });

  test("a core guard (the single-line byte ceiling) rejects inside the worker path", async () => {
    // A real core guard fires INSIDE the worker (loadCSVFile runs there unchanged) and
    // its rejection is serialized back and rebuilt into an Error -- so a malformed parse
    // fails clearly rather than crashing a downstream consumer. The non-string-header
    // guard is the same mechanism; a real File cannot produce a non-string header, so
    // its firing is pinned in core's browser suite and its worker-path surfacing in the
    // controller unit test.
    const ceiling = 512;
    const file = new File(["x".repeat(ceiling * 2)], "huge-line.csv", {
      type: "text/csv",
    });
    await expect(
      loadCSVFileOffMainThread(file, {
        spawnWorker: defaultSpawnCSVParseWorker,
        byteCeiling: ceiling,
      }),
    ).rejects.toThrow(/single-line limit/);
  });

  test("a File above the threshold is parsed off-thread via the default routing, whole and correct", async () => {
    // No injected spawner: this exercises the real production wiring -- the size
    // predicate routes off-thread, the worker client is imported lazily, and the worker
    // is spawned -- and confirms the parse is accumulated whole (no truncation) with the
    // rows intact.
    const header = "id,value";
    const pad = "v".repeat(64);
    const row = (i: number): string => `${i},${pad}`;
    const lines = [header];
    let bytes = header.length + 1;
    let rowCount = 0;
    // Overshoot the threshold by a comfortable margin so the routing takes the worker.
    const targetBytes = CSV_WORKER_FILE_BYTE_THRESHOLD + 512 * 1024;
    while (bytes < targetBytes) {
      const line = row(rowCount);
      lines.push(line);
      bytes += line.length + 1;
      rowCount++;
    }
    const csv = lines.join("\n") + "\n";
    const file = new File([csv], "big.csv", { type: "text/csv" });
    expect(file.size).toBeGreaterThan(CSV_WORKER_FILE_BYTE_THRESHOLD);

    const result = await loadCSVFileOffMainThread(file);
    expect(result.meta.fields).toEqual(["id", "value"]);
    expect(result.data.length).toBe(rowCount);
    expect(result.data[0]).toEqual({ id: "0", value: pad });
    expect(result.data[rowCount - 1]).toEqual({
      id: String(rowCount - 1),
      value: pad,
    });
  });
});
