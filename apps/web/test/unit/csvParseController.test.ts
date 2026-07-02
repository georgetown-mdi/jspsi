import { Readable } from "node:stream";

import { describe, expect, test, vi } from "vitest";

import {
  CSV_WORKER_FILE_BYTE_THRESHOLD,
  loadCSVFileOffMainThread,
  shouldParseOffThread,
} from "../../src/psi/csvParseController.js";

import type {
  CSVParseRequest,
  CSVParseResponse,
  CSVParseResult,
  CSVParseWorker,
} from "../../src/psi/csvParseController.js";

// A well-formed result the fake worker hands back, matching what core's loadCSVFile
// resolves (data plus meta.fields). The controller only passes it through, so a
// minimal-but-valid ParseResult is enough to assert the plumbing.
const OK_RESULT: CSVParseResult = {
  data: [{ a: "1", b: "2" }],
  errors: [],
  meta: {
    delimiter: ",",
    linebreak: "\n",
    aborted: false,
    truncated: false,
    cursor: 8,
    fields: ["a", "b"],
  },
};

// A fake worker mirroring the real one's contract: it records what it was posted and
// replies asynchronously (a microtask, like a real worker message) with either a
// response or an onerror event, so the controller's resolve/reject/terminate plumbing
// is driven without a real Worker (absent under Node).
class FakeCSVParseWorker implements CSVParseWorker {
  onmessage: ((event: { data: CSVParseResponse }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly received: Array<CSVParseRequest> = [];
  terminated = false;

  constructor(private readonly reply: CSVParseResponse | "error") {}

  postMessage(message: CSVParseRequest): void {
    this.received.push(message);
    queueMicrotask(() => {
      if (this.reply === "error")
        this.onerror?.({ message: "worker exploded" });
      else this.onmessage?.({ data: this.reply });
    });
  }

  terminate(): void {
    this.terminated = true;
  }
}

describe("loadCSVFileOffMainThread: inline fallback", () => {
  test("parses a Node readable stream inline, without a worker", async () => {
    // The CLI/test input is a Node stream, which is not structured-cloneable and has
    // no FileReader path, so it always parses inline through core's loadCSVFile.
    const result = await loadCSVFileOffMainThread(Readable.from("a,b\n1,2\n"));
    expect(result.data).toEqual([{ a: "1", b: "2" }]);
    expect(result.meta.fields).toEqual(["a", "b"]);
  });
});

describe("shouldParseOffThread: the routing predicate", () => {
  test("a large browser File goes off-thread; a small File and a stream stay inline", () => {
    // Worker is absent under Node, so stub it to exercise the browser branch of the
    // predicate; File is a real Node global.
    vi.stubGlobal("Worker", class {});
    try {
      const big = new File(
        ["x".repeat(CSV_WORKER_FILE_BYTE_THRESHOLD + 1)],
        "big.csv",
        { type: "text/csv" },
      );
      const small = new File(["x"], "small.csv", { type: "text/csv" });
      expect(shouldParseOffThread(big)).toBe(true);
      expect(shouldParseOffThread(small)).toBe(false);
      expect(shouldParseOffThread(Readable.from("a\n1\n"))).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("without a Worker global (Node/SSR) even a large File stays inline", () => {
    const big = new File(
      ["x".repeat(CSV_WORKER_FILE_BYTE_THRESHOLD + 1)],
      "big.csv",
      { type: "text/csv" },
    );
    expect(shouldParseOffThread(big)).toBe(false);
  });
});

describe("loadCSVFileOffMainThread: worker dispatch", () => {
  test("posts the File and ceiling, resolves the worker's result, and terminates it", async () => {
    const fake = new FakeCSVParseWorker({ ok: true, result: OK_RESULT });
    const file = new File(["a,b\n1,2\n"], "d.csv", { type: "text/csv" });
    const out = await loadCSVFileOffMainThread(file, {
      spawnWorker: () => fake,
      byteCeiling: 4096,
    });
    expect(out).toEqual(OK_RESULT);
    expect(fake.received).toEqual([{ file, byteCeiling: 4096 }]);
    // One-shot: the worker is torn down as soon as it answers.
    expect(fake.terminated).toBe(true);
  });

  test("surfaces a worker parse rejection as an Error the consumer can display", async () => {
    // The worker runs core's loadCSVFile verbatim, so its guards -- including the
    // non-string-header guard #307 added -- reject inside the worker exactly as
    // inline. A real File cannot produce a non-string header (only the removed
    // bundled-worker corruption could), so the guard's own firing is pinned in core's
    // browser suite; here the guard's exact rejection is carried back over the worker
    // boundary and must surface as an ordinary Error, not crash a downstream consumer.
    const fake = new FakeCSVParseWorker({
      ok: false,
      message:
        "CSV header parsed to a non-string column; the file could not be read correctly",
      name: "Error",
    });
    const file = new File(["a\n1\n"], "d.csv", { type: "text/csv" });
    await expect(
      loadCSVFileOffMainThread(file, { spawnWorker: () => fake }),
    ).rejects.toThrow(/non-string column/);
    expect(fake.terminated).toBe(true);
  });

  test("rejects rather than hangs when the worker itself fails", async () => {
    // A worker-level failure (module-load error, non-cloneable message) surfaces
    // through onerror; the controller must reject and terminate rather than leave the
    // caller waiting on a worker that can never answer.
    const fake = new FakeCSVParseWorker("error");
    const file = new File(["a\n1\n"], "d.csv", { type: "text/csv" });
    await expect(
      loadCSVFileOffMainThread(file, { spawnWorker: () => fake }),
    ).rejects.toThrow(/worker exploded/);
    expect(fake.terminated).toBe(true);
  });
});
