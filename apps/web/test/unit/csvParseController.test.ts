import { Readable } from "node:stream";

import { describe, expect, test, vi } from "vitest";

import {
  CSV_WORKER_FILE_BYTE_THRESHOLD,
  CSV_WORKER_REPLY_BATCH_BYTES,
  loadCSVFileOffMainThread,
  replyBatchRows,
  shouldParseOffThread,
} from "../../src/psi/csvParseController.js";

import type {
  CSVParseRequest,
  CSVParseResponse,
  CSVParseResult,
  CSVParseRows,
  CSVParseWorker,
} from "../../src/psi/csvParseController.js";

// The header meta a well-formed reply carries -- what core's loadCSVFile puts in
// meta.fields. Shared by the result fixtures and the streamed done message.
const META: CSVParseResult["meta"] = {
  delimiter: ",",
  linebreak: "\n",
  aborted: false,
  truncated: false,
  cursor: 8,
  fields: ["a", "b"],
};

// A well-formed result, matching what core's loadCSVFile resolves (data plus
// meta.fields). The worker streams it back as batches + a done message; the controller
// reassembles it, so a minimal-but-valid ParseResult is enough to assert the plumbing.
const OK_RESULT: CSVParseResult = {
  data: [{ a: "1", b: "2" }],
  errors: [],
  meta: META,
};

// Split a result into the message sequence the real worker posts: one `done: false`
// batch per row group, then the terminal `done: true` carrying errors + meta. Used to
// drive the controller's reassembly with an explicit batch layout.
function streamedReply(
  result: CSVParseResult,
  batches: Array<CSVParseRows>,
): Array<CSVParseResponse> {
  return [
    ...batches.map(
      (rows): CSVParseResponse => ({ ok: true, done: false, rows }),
    ),
    { ok: true, done: true, errors: result.errors, meta: result.meta },
  ];
}

// A fake worker mirroring the real one's contract: it records what it was posted and
// replies asynchronously (each message its own microtask, like a real worker delivering
// separate messages) so the controller's accumulate/resolve/reject/terminate plumbing
// is driven without a real Worker (absent under Node). A `CSVParseResponse[]` scripts a
// streamed reply (batches then a terminal message), delivered in order.
class FakeCSVParseWorker implements CSVParseWorker {
  onmessage: ((event: { data: CSVParseResponse }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessageerror: ((event: unknown) => void) | null = null;
  readonly received: Array<CSVParseRequest> = [];
  terminated = false;

  // "never" leaves the request unanswered, so a test can drive the abort path (the
  // parse is torn down by the caller's signal, not by a worker reply);
  // "messageerror" fires the undeserializable-reply path.
  constructor(
    private readonly reply:
      | Array<CSVParseResponse>
      | "error"
      | "never"
      | "messageerror",
  ) {}

  postMessage(message: CSVParseRequest): void {
    this.received.push(message);
    if (this.reply === "never") return;
    const reply = this.reply;
    if (reply === "error") {
      queueMicrotask(() => this.onerror?.({ message: "worker exploded" }));
      return;
    }
    if (reply === "messageerror") {
      queueMicrotask(() => this.onmessageerror?.({}));
      return;
    }
    for (const data of reply) queueMicrotask(() => this.onmessage?.({ data }));
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
  test("posts the File and ceiling, reassembles the streamed reply, and terminates", async () => {
    const fake = new FakeCSVParseWorker(
      streamedReply(OK_RESULT, [OK_RESULT.data]),
    );
    const file = new File(["a,b\n1,2\n"], "d.csv", { type: "text/csv" });
    const out = await loadCSVFileOffMainThread(file, {
      spawnWorker: () => fake,
      byteCeiling: 4096,
    });
    expect(out).toEqual(OK_RESULT);
    expect(fake.received).toEqual([{ file, byteCeiling: 4096 }]);
    // One-shot: the worker is torn down as soon as the terminal message arrives.
    expect(fake.terminated).toBe(true);
  });

  test("reassembles a multi-batch reply to the same rows and fields as a single batch", async () => {
    // Acceptance criterion: a reply arriving in multiple batches reassembles to the same
    // rows (in order) and meta.fields as an equivalent single-batch reply, including a
    // batch boundary that falls mid-way through the rows.
    const rows: CSVParseRows = [
      { a: "1", b: "2" },
      { a: "3", b: "4" },
      { a: "5", b: "6" },
      { a: "7", b: "8" },
    ];
    const full: CSVParseResult = { data: rows, errors: [], meta: META };
    const file = (): File =>
      new File(["a,b\n1,2\n3,4\n5,6\n7,8\n"], "d.csv", { type: "text/csv" });

    // One batch of all four rows.
    const single = new FakeCSVParseWorker(streamedReply(full, [rows]));
    // Uneven batches whose boundaries fall mid-way through the rows (1 | 2 | 1).
    const multi = new FakeCSVParseWorker(
      streamedReply(full, [rows.slice(0, 1), rows.slice(1, 3), rows.slice(3)]),
    );

    const singleOut = await loadCSVFileOffMainThread(file(), {
      spawnWorker: () => single,
    });
    const multiOut = await loadCSVFileOffMainThread(file(), {
      spawnWorker: () => multi,
    });

    expect(multiOut.data).toEqual(rows);
    expect(multiOut.meta.fields).toEqual(["a", "b"]);
    // Identical to the single-batch reply -- the batch granularity is invisible.
    expect(multiOut).toEqual(singleOut);
    expect(single.terminated).toBe(true);
    expect(multi.terminated).toBe(true);
  });

  test("reassembles an empty (no-row) parse from a done message with no batches", async () => {
    // An empty file yields zero batches and only the terminal message; the controller
    // must still settle with an empty data array and the header meta.
    const empty: CSVParseResult = {
      data: [],
      errors: [],
      meta: { ...META, fields: [] },
    };
    const fake = new FakeCSVParseWorker(streamedReply(empty, []));
    const file = new File(["\n"], "d.csv", { type: "text/csv" });
    const out = await loadCSVFileOffMainThread(file, {
      spawnWorker: () => fake,
    });
    expect(out).toEqual(empty);
    expect(fake.terminated).toBe(true);
  });

  test("ignores a stray batch that arrives after the terminal message", async () => {
    // The `if (settled) return` guard in onmessage extends the never-double-settle
    // invariant to the stream: a batch delivered after the terminal `done` (a worker
    // that kept posting past completion) must not append to the resolved result. This
    // matters because the resolved `data` is the SAME array the accumulator mutates --
    // without the guard, a post-done push would corrupt an already-returned result.
    const rows: CSVParseRows = [{ a: "1", b: "2" }];
    const full: CSVParseResult = { data: rows, errors: [], meta: META };
    const fake = new FakeCSVParseWorker([
      ...streamedReply(full, [rows]),
      { ok: true, done: false, rows: [{ a: "9", b: "9" }] },
    ]);
    const file = new File(["a,b\n1,2\n"], "d.csv", { type: "text/csv" });
    const out = await loadCSVFileOffMainThread(file, {
      spawnWorker: () => fake,
    });
    // The stray post-`done` batch is gated out: it neither appends nor throws.
    expect(out.data).toEqual([{ a: "1", b: "2" }]);
    expect(fake.terminated).toBe(true);
  });

  test("carries non-empty errors and full meta through the terminal message", async () => {
    // The terminal message reassembles the non-row remainder of the result. Prior tests
    // use empty errors and only assert meta.fields; pin that a populated errors list and
    // a distinguishing meta field round-trip intact, not just `fields`.
    const result: CSVParseResult = {
      data: [{ a: "1", b: "2" }],
      errors: [
        {
          type: "FieldMismatch",
          code: "TooFewFields",
          message: "Too few fields: expected 2 fields but parsed 1",
          row: 0,
        },
      ],
      meta: { ...META, truncated: true },
    };
    const fake = new FakeCSVParseWorker(streamedReply(result, [result.data]));
    const file = new File(["a,b\n1,2\n"], "d.csv", { type: "text/csv" });
    const out = await loadCSVFileOffMainThread(file, {
      spawnWorker: () => fake,
    });
    expect(out).toEqual(result);
    expect(fake.terminated).toBe(true);
  });

  test("surfaces a worker parse rejection as an Error the consumer can display", async () => {
    // The worker runs core's loadCSVFile verbatim, so its guards -- including the
    // non-string-header guard #307 added -- reject inside the worker exactly as
    // inline. A real File cannot produce a non-string header (only the removed
    // bundled-worker corruption could), so the guard's own firing is pinned in core's
    // browser suite; here the guard's exact rejection is carried back over the worker
    // boundary and must surface as an ordinary Error, not crash a downstream consumer.
    const fake = new FakeCSVParseWorker([
      {
        ok: false,
        message:
          "CSV header parsed to a non-string column; the file could not be read correctly",
        name: "Error",
      },
    ]);
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

  test("rejects rather than hangs when the worker reply cannot be deserialized", async () => {
    // A structured-clone failure on the reply fires onmessageerror, not onmessage or
    // onerror; the controller must settle and terminate rather than hang -- the
    // never-hang guarantee the one-shot documents. Unreachable for the current
    // all-string reply shape, so pinned here against a future regression.
    const fake = new FakeCSVParseWorker("messageerror");
    const file = new File(["a\n1\n"], "d.csv", { type: "text/csv" });
    await expect(
      loadCSVFileOffMainThread(file, { spawnWorker: () => fake }),
    ).rejects.toThrow(/could not be deserialized/);
    expect(fake.terminated).toBe(true);
  });

  test("an abort mid-parse terminates the worker and rejects", async () => {
    // The worker never replies; the caller aborts (a component unmount). The
    // controller must tear the worker down and reject rather than let it run to
    // completion on a discarded parse.
    const fake = new FakeCSVParseWorker("never");
    const controller = new AbortController();
    const file = new File(["a\n1\n"], "d.csv", { type: "text/csv" });
    const pending = loadCSVFileOffMainThread(file, {
      spawnWorker: () => fake,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/);
    expect(fake.terminated).toBe(true);
  });

  test("an already-aborted signal terminates the worker without posting", async () => {
    const fake = new FakeCSVParseWorker("never");
    const controller = new AbortController();
    controller.abort();
    const file = new File(["a\n1\n"], "d.csv", { type: "text/csv" });
    await expect(
      loadCSVFileOffMainThread(file, {
        spawnWorker: () => fake,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/aborted/);
    expect(fake.terminated).toBe(true);
    // Aborted before dispatch, so the parse request is never posted.
    expect(fake.received).toEqual([]);
  });
});

describe("replyBatchRows: the worker's batch sizing", () => {
  test("targets the source-byte budget, so batch size tracks row width not count", () => {
    // For a fixed bytes-per-row, the rows-per-batch is floor(budget / bytesPerRow) and
    // is independent of how many rows the file has -- a bigger file of similar rows
    // yields MORE batches, not bigger ones. This is the property that bounds the
    // per-message clone regardless of the file's total row count.
    const bytesPerRow = 100;
    const expected = Math.floor(CSV_WORKER_REPLY_BATCH_BYTES / bytesPerRow);
    expect(replyBatchRows(1_000, 1_000 * bytesPerRow)).toBe(expected);
    expect(replyBatchRows(500_000, 500_000 * bytesPerRow)).toBe(expected);
  });

  test("gives narrower rows larger batches (monotonic in row width)", () => {
    // Halving bytes-per-row roughly doubles the rows that fit a batch.
    const narrow = replyBatchRows(1_000, 1_000 * 50);
    const wide = replyBatchRows(1_000, 1_000 * 200);
    expect(narrow).toBeGreaterThan(wide);
  });

  test("clamps a row wider than the whole budget to one row per batch", () => {
    // A single row whose own source exceeds the budget would floor to 0 rows/batch and
    // spin the worker's post loop forever; the Math.max(1, ...) floor emits one row per
    // batch instead. (2 rows across 4 MiB => 2 MiB/row, well over the 1 MiB budget.)
    expect(replyBatchRows(2, 4 * 1024 * 1024)).toBe(1);
  });

  test("returns 1 for a zero-row parse (loop never runs, must not be 0)", () => {
    expect(replyBatchRows(0, 0)).toBe(1);
    expect(replyBatchRows(0, 1_000)).toBe(1);
  });

  test("stays finite and positive for a degenerate zero-byte file with rows", () => {
    // A File reporting size 0 yet yielding rows cannot occur, but the Math.max(fileBytes,
    // 1) guard keeps the division defined rather than producing Infinity/NaN.
    const batch = replyBatchRows(5, 0);
    expect(Number.isFinite(batch)).toBe(true);
    expect(batch).toBeGreaterThanOrEqual(1);
  });
});
