import { Readable } from "node:stream";

import { expect, test, vi } from "vitest";

import {
  assertLeadingLineWithinByteCeiling,
  CSV_LINE_BYTE_CEILING,
  guardStreamLineByteCeiling,
  loadCSVColumnSample,
  loadCSVFile,
} from "../src/file";
import { inferDateFormat, columnValues } from "../src/utils/date";

/** A readable emitting `content` then EOF, standing in for a CSV file/stream. */
function streamOf(content: string): Readable {
  const s = new Readable({ read() {} });
  if (content.length > 0) s.push(Buffer.from(content, "utf8"));
  s.push(null);
  return s;
}

/**
 * A readable emitting `content` in fixed-size pieces, so PapaParse sees multiple
 * data events and a header longer than `pieceSize` lands split across chunks --
 * the way `fs.createReadStream` (64 KB reads) delivers a large header, which a
 * single-push {@link streamOf} cannot reproduce.
 */
function chunkedStreamOf(content: string, pieceSize: number): Readable {
  const buf = Buffer.from(content, "utf8");
  let off = 0;
  return new Readable({
    read() {
      if (off >= buf.length) {
        this.push(null);
        return;
      }
      const end = Math.min(off + pieceSize, buf.length);
      this.push(buf.subarray(off, end));
      off = end;
    },
  });
}

/** Pick the `dob` column when present, the selector init uses in spirit. */
const pickDob = (columns: string[]): string | undefined =>
  columns.find((c) => c === "dob");

test("loadCSVColumnSample: returns the header, the sampled column, and its values", async () => {
  const csv =
    "first_name,dob,ssn\n" + "Alice,1990-01-02,111\n" + "Bob,1985-12-31,222\n";
  const { columns, sampledColumn, sample } = await loadCSVColumnSample(
    streamOf(csv),
    pickDob,
    1000,
  );
  expect(columns).toEqual(["first_name", "dob", "ssn"]);
  expect(sampledColumn).toBe("dob");
  expect(sample).toEqual(["1990-01-02", "1985-12-31"]);
});

test("loadCSVColumnSample: a header-only file yields the columns and an empty sample", async () => {
  const { columns, sampledColumn, sample } = await loadCSVColumnSample(
    streamOf("first_name,dob,ssn\n"),
    pickDob,
    1000,
  );
  expect(columns).toEqual(["first_name", "dob", "ssn"]);
  // The column was selected even though there were no rows to sample from it.
  expect(sampledColumn).toBe("dob");
  expect(sample).toEqual([]);
});

test("loadCSVColumnSample: no selected column reads only the header", async () => {
  // The selector returns undefined (no DOB column), so nothing is sampled even
  // though the rows have values -- the header alone is the result.
  const csv = "first_name,ssn\nAlice,111\nBob,222\n";
  const { columns, sampledColumn, sample } = await loadCSVColumnSample(
    streamOf(csv),
    pickDob,
    1000,
  );
  expect(columns).toEqual(["first_name", "ssn"]);
  expect(sampledColumn).toBeUndefined();
  expect(sample).toEqual([]);
});

test("loadCSVColumnSample: destroys the source stream once the read stops early", async () => {
  // The early parser.abort() must release the underlying stream rather than leak
  // its descriptor until GC -- the bounded read's whole point. Both early-stop
  // paths (sample cap reached, and no column to sample) end through completion.
  const capStream = streamOf(
    "name,dob\nA,1990-01-01\nB,1990-01-02\nC,1990-01-03\n",
  );
  const capDestroy = vi.spyOn(capStream, "destroy");
  await loadCSVColumnSample(capStream, pickDob, 1);
  expect(capDestroy).toHaveBeenCalled();

  const noColStream = streamOf("name,ssn\nA,111\nB,222\n");
  const noColDestroy = vi.spyOn(noColStream, "destroy");
  await loadCSVColumnSample(noColStream, pickDob, 1000);
  expect(noColDestroy).toHaveBeenCalled();
});

test("loadCSVColumnSample: a source error releases the stream and rejects", async () => {
  // A read error settles through PapaParse's error path, which never reaches
  // completion, so the stream must still be released there -- otherwise an
  // fs.createReadStream descriptor would leak past the failure until GC.
  const stream = new Readable({ read() {} });
  const destroySpy = vi.spyOn(stream, "destroy");
  // Emit after PapaParse has attached its listeners (it parses on the microtask
  // queue, so a queued error fires once the error listener is in place).
  queueMicrotask(() => stream.emit("error", new Error("read failed")));
  await expect(loadCSVColumnSample(stream, pickDob, 1000)).rejects.toThrow(
    "read failed",
  );
  expect(destroySpy).toHaveBeenCalled();
});

test("loadCSVColumnSample: empty (after-trim) values are skipped, not sampled", async () => {
  const csv =
    "name,dob\n" +
    "Alice,1990-01-02\n" +
    "Blank,\n" +
    "Spaces,   \n" +
    "Bob,1985-12-31\n";
  const { sample } = await loadCSVColumnSample(streamOf(csv), pickDob, 1000);
  expect(sample).toEqual(["1990-01-02", "1985-12-31"]);
});

test("loadCSVColumnSample: caps the sample at sampleLimit non-empty values", async () => {
  // 50 rows but a cap of 3 -- the read stops once three non-empty DOB values are
  // collected, demonstrating the bounded (non-full-file) read.
  const rows = Array.from(
    { length: 50 },
    (_v, i) => `Person${i},1990-01-0${(i % 9) + 1}`,
  ).join("\n");
  const csv = `name,dob\n${rows}\n`;
  const { sample } = await loadCSVColumnSample(streamOf(csv), pickDob, 3);
  expect(sample).toHaveLength(3);
  expect(sample).toEqual(["1990-01-01", "1990-01-02", "1990-01-03"]);
});

test("loadCSVColumnSample: the bounded sample reproduces a full-scan date format", async () => {
  // The divergence guard: feeding the bounded sample to inferDateFormat must
  // match feeding the whole column. The sample cap equals inferDateFormat's own
  // scan cap, so the two see the same prefix and infer the same format.
  const allRows: Array<Record<string, string>> = Array.from(
    { length: 5000 },
    (_v, i) => ({ dob: `1990-01-${String((i % 28) + 1).padStart(2, "0")}` }),
  );
  const csv = "dob\n" + allRows.map((r) => r.dob).join("\n") + "\n";
  const { sample } = await loadCSVColumnSample(streamOf(csv), pickDob, 1000);
  const fromSample = inferDateFormat(sample);
  const fromFull = inferDateFormat(columnValues(allRows, "dob"));
  expect(fromSample).toBe("YYYY-MM-DD");
  expect(fromSample).toBe(fromFull);
});

test("loadCSVColumnSample: an empty input yields an empty header and sample", async () => {
  const { columns, sample } = await loadCSVColumnSample(
    streamOf(""),
    pickDob,
    1000,
  );
  expect(columns).toEqual([]);
  expect(sample).toEqual([]);
});

// The byte-ceiling guard lives in guardStreamLineByteCeiling, which both
// loadCSVColumnSample and loadCSVFile wrap, so every "fails fast" shape below
// must reject identically through either entry point. Each scenario builds the
// tripping stream once; the wrapper table drives it through both loaders.
const ceilingTripScenarios: Array<{
  label: string;
  makeStream: (ceiling: number) => Readable;
}> = [
  {
    // One logical line with no terminator anywhere: PapaParse can never yield a
    // row or settle the header, so the read would buffer the whole span. The
    // guard destroys the stream with an operator-readable error once the run
    // since the last terminator crosses the limit. Delivered in small chunks, as
    // fs.createReadStream / stdin would deliver a large file.
    label: "a no-newline span over the byte ceiling fails fast",
    makeStream: (ceiling) => chunkedStreamOf("x".repeat(ceiling * 4), 64),
  },
  {
    // The header terminates normally, then one data field grows without a row
    // terminator. The guard's run resets at the header's newline, then the
    // unbounded field drives the run past the ceiling, so the read fails fast
    // rather than buffering the whole field.
    label: "a single field over the byte ceiling fails fast",
    makeStream: (ceiling) =>
      chunkedStreamOf(`name,dob\nAlice,${"y".repeat(ceiling * 4)}`, 64),
  },
  {
    // A header of very many columns with its terminator beyond the ceiling: the
    // run grows from the first byte with no terminator to reset it, so it crosses
    // the limit before the header settles -- the giant-header shape.
    label: "a header over the byte ceiling fails fast",
    makeStream: (ceiling) => {
      const cols = Array.from({ length: 400 }, (_v, i) => `col_${i}`);
      const header = cols.join(",");
      expect(Buffer.byteLength(header)).toBeGreaterThan(ceiling);
      const row = cols.map(() => "v").join(",");
      return chunkedStreamOf(`${header}\n${row}\n`, 64);
    },
  },
  {
    // Delivery-shape independence: the header and an unterminated giant field
    // arrive in a SINGLE data event (a lone push, or any source with a read
    // buffer larger than the span). The guard scans within that one chunk --
    // resetting the run at the header's newline, then accumulating the field past
    // the ceiling -- so a chunk carrying both a terminator and an over-ceiling
    // tail still trips. streamOf pushes the entire content as one event.
    label: "a giant field arriving in one data event fails fast",
    makeStream: (ceiling) =>
      streamOf(`name,dob\nAlice,${"y".repeat(ceiling * 4)}`),
  },
];

const ceilingGuardWrappers: Array<{
  label: string;
  run: (stream: Readable, ceiling: number) => Promise<unknown>;
}> = [
  {
    label: "loadCSVColumnSample",
    run: (stream, ceiling) =>
      loadCSVColumnSample(stream, pickDob, 1000, ceiling),
  },
  {
    label: "loadCSVFile",
    run: (stream, ceiling) => loadCSVFile(stream, ceiling),
  },
];

for (const wrapper of ceilingGuardWrappers) {
  test.each(ceilingTripScenarios)(
    `${wrapper.label}: $label`,
    async ({ makeStream }) => {
      const ceiling = 512;
      await expect(wrapper.run(makeStream(ceiling), ceiling)).rejects.toThrow(
        /single-line limit/,
      );
    },
  );
}

test("loadCSVColumnSample: many short rows whose total exceeds the ceiling do not trip", async () => {
  // The ceiling bounds a single line, not the total bytes pulled: a file of many
  // short, terminated rows whose cumulative size far exceeds the ceiling reads
  // normally, because the span resets at every row terminator. This is the
  // distinction that keeps a legitimate large input -- which the bounded sample
  // walks up to the scan cap -- from tripping the limit.
  const ceiling = 256;
  const rows = Array.from(
    { length: 400 },
    (_v, i) => `Person${i},1990-01-0${(i % 9) + 1}`,
  ).join("\n");
  const csv = `name,dob\n${rows}\n`;
  expect(Buffer.byteLength(csv)).toBeGreaterThan(ceiling * 4);
  const { columns, sampledColumn, sample } = await loadCSVColumnSample(
    chunkedStreamOf(csv, 64),
    pickDob,
    1000,
    ceiling,
  );
  expect(columns).toEqual(["name", "dob"]);
  expect(sampledColumn).toBe("dob");
  expect(sample).toHaveLength(400);
});

test("loadCSVColumnSample: a well-formed input under the ceiling reads unchanged", async () => {
  // The ceiling leaves a normal input untouched: the same header, sampled column,
  // and bounded sample as without it, even delivered in tiny chunks (lines split
  // mid-field across reads) so the per-line span reset is exercised.
  const csv =
    "first_name,dob,ssn\n" + "Alice,1990-01-02,111\n" + "Bob,1985-12-31,222\n";
  const { columns, sampledColumn, sample } = await loadCSVColumnSample(
    chunkedStreamOf(csv, 8),
    pickDob,
    1000,
    256,
  );
  expect(columns).toEqual(["first_name", "dob", "ssn"]);
  expect(sampledColumn).toBe("dob");
  expect(sample).toEqual(["1990-01-02", "1985-12-31"]);
});

test("loadCSVColumnSample: the default ceiling is well above a realistic header", () => {
  // A guard on the constant itself: 8 MiB must clear any realistic operator CSV
  // (a wide header here is tens of KiB) so a well-formed input never trips.
  const header = Array.from({ length: 2000 }, (_v, i) => `column_${i}`).join(
    ",",
  );
  expect(Buffer.byteLength(header)).toBeLessThan(CSV_LINE_BYTE_CEILING);
});

test("loadCSVColumnSample: a header split across stream chunks is read whole", async () => {
  // A header longer than one stream read arrives split across chunks, so the
  // first chunk carries no fields yet. The loader must wait for the complete
  // header rather than committing to the first chunk's empty field list -- else
  // it returns an empty header and init's inference silently diverges from the
  // full read. The header here (~8000 columns) far exceeds the 16 KiB piece size.
  const cols = Array.from({ length: 8000 }, (_v, i) =>
    i === 4000 ? "dob" : `column_${i}`,
  );
  const header = cols.join(",");
  expect(Buffer.byteLength(header)).toBeGreaterThan(16384);
  const row = cols.map((c) => (c === "dob" ? "1990-01-02" : "x")).join(",");
  const csv = `${header}\n${row}\n${row}\n`;

  const { columns, sampledColumn, sample } = await loadCSVColumnSample(
    chunkedStreamOf(csv, 16384),
    pickDob,
    1000,
  );
  expect(columns).toHaveLength(8000);
  expect(columns).toContain("dob");
  expect(sampledColumn).toBe("dob");
  expect(sample).toEqual(["1990-01-02", "1990-01-02"]);
});

test("loadCSVFile: destroys the source stream once the ceiling aborts the read", async () => {
  // On a ceiling trip the guard destroys the source itself (surfacing the error
  // through PapaParse), and the error path releases it again; either way the stream
  // is destroyed rather than leaked until GC. The spy fires on the guard's destroy.
  const ceiling = 512;
  const stream = chunkedStreamOf("x".repeat(ceiling * 4), 64);
  const destroySpy = vi.spyOn(stream, "destroy");
  await expect(loadCSVFile(stream, ceiling)).rejects.toThrow(
    /single-line limit/,
  );
  expect(destroySpy).toHaveBeenCalled();
});

test("loadCSVFile: many short rows whose total exceeds the ceiling do not trip", async () => {
  // The ceiling bounds a single line, not the total bytes pulled: a file of many
  // short, terminated rows whose cumulative size far exceeds the ceiling reads
  // whole, because the span resets at every row terminator. This is the distinction
  // that keeps a legitimate large operator file -- which loadCSVFile reads in full --
  // from tripping the limit, delivered in tiny chunks to exercise the reset.
  const ceiling = 256;
  const rows = Array.from(
    { length: 400 },
    (_v, i) => `Person${i},1990-01-0${(i % 9) + 1}`,
  ).join("\n");
  const csv = `name,dob\n${rows}\n`;
  expect(Buffer.byteLength(csv)).toBeGreaterThan(ceiling * 4);
  const result = await loadCSVFile(chunkedStreamOf(csv, 64), ceiling);
  expect(result.meta.fields).toEqual(["name", "dob"]);
  expect(result.data).toHaveLength(400);
});

test("loadCSVFile: a well-formed input under the ceiling reads unchanged", async () => {
  // The ceiling leaves a normal input untouched: the same header and every parsed
  // row as without it, even delivered in tiny chunks (lines split mid-field across
  // reads) so the per-line span reset is exercised. Pins both data and meta.fields
  // against the pre-ceiling behavior.
  const csv =
    "first_name,dob,ssn\n" + "Alice,1990-01-02,111\n" + "Bob,1985-12-31,222\n";
  const result = await loadCSVFile(chunkedStreamOf(csv, 8), 256);
  expect(result.meta.fields).toEqual(["first_name", "dob", "ssn"]);
  expect(result.data).toEqual([
    { first_name: "Alice", dob: "1990-01-02", ssn: "111" },
    { first_name: "Bob", dob: "1985-12-31", ssn: "222" },
  ]);
});

test("loadCSVFile: normalizes rows to an honest CSVRow shape", async () => {
  // PapaParse (header:true) gives no per-cell string guarantee: a row longer than
  // the header attaches a non-string `__parsed_extra` array, and a shorter row omits
  // its trailing columns. loadCSVFile normalizes both away so every returned cell is
  // a genuine string (a CSVRow), which the row type states honestly -- the laundering
  // the by-name-access cleanup targets.
  const csv =
    "a,b,c\n" +
    "1,2,3\n" + // well-formed
    "4,5\n" + // short: c is absent, not undefined-typed-as-string
    "6,7,8,9,10\n"; // over-long: 9,10 land in a non-string __parsed_extra
  const result = await loadCSVFile(streamOf(csv), 256);

  expect(result.data).toEqual([
    { a: "1", b: "2", c: "3" },
    { a: "4", b: "5" },
    { a: "6", b: "7", c: "8" },
  ]);

  // The over-long row's non-string __parsed_extra is dropped, so a generic value
  // iteration sees only strings -- never the array the raw cast would have typed as a
  // string.
  const overLong = result.data[2];
  expect("__parsed_extra" in overLong).toBe(false);
  expect(Object.values(overLong).every((v) => typeof v === "string")).toBe(
    true,
  );

  // The short row's missing column reads as undefined, not a mis-typed string.
  expect(result.data[1].c).toBeUndefined();
  expect("c" in result.data[1]).toBe(false);
});

// The non-stream (browser File) bound. loadCSVFile's data-event counter is inert
// for a File -- PapaParse reads it whole through FileReader, which Node lacks -- so
// the leading-line pre-read enforces the ceiling there instead. These exercise the
// pre-read directly (no FileReader needed); the end-to-end parse of a real File is
// pinned in apps/web's browser suite, where FileReader exists.

test("assertLeadingLineWithinByteCeiling: a File whose leading line exceeds the ceiling rejects", async () => {
  // No terminator anywhere and a body past the ceiling: the header (here, the whole
  // file) is one over-ceiling line, so the pre-read rejects before any parse.
  const ceiling = 512;
  const file = new File(["x".repeat(ceiling * 2)], "huge.csv");
  await expect(
    assertLeadingLineWithinByteCeiling(file, ceiling),
  ).rejects.toThrow(/single-line limit/);
});

test("assertLeadingLineWithinByteCeiling: an oversized header preceding a terminator rejects", async () => {
  // The first terminator exists but sits past the ceiling: the leading line (the
  // header) alone exceeds it, so the pre-read still rejects.
  const ceiling = 512;
  const file = new File([`${"h".repeat(ceiling * 2)}\nrow\n`], "wide.csv");
  await expect(
    assertLeadingLineWithinByteCeiling(file, ceiling),
  ).rejects.toThrow(/single-line limit/);
});

test("assertLeadingLineWithinByteCeiling: a terminator within the ceiling resolves despite a huge body", async () => {
  // Only the LEADING line is gated: a short header terminates early, so a body far
  // past the ceiling (a later-row span, left to the intake cap) reads through.
  const ceiling = 512;
  const file = new File([`name,dob\n${"y".repeat(ceiling * 8)}`], "ok.csv");
  await expect(
    assertLeadingLineWithinByteCeiling(file, ceiling),
  ).resolves.toBeUndefined();
});

test("assertLeadingLineWithinByteCeiling: a File no larger than the ceiling is not read", async () => {
  // A file that cannot hold an over-ceiling line is passed through without a read,
  // so the common case pays nothing -- pinned by spying on slice().
  const ceiling = 512;
  const file = new File(["x".repeat(ceiling)], "small.csv");
  const sliceSpy = vi.spyOn(file, "slice");
  await expect(
    assertLeadingLineWithinByteCeiling(file, ceiling),
  ).resolves.toBeUndefined();
  expect(sliceSpy).not.toHaveBeenCalled();
});

test("assertLeadingLineWithinByteCeiling: a non-sliceable input (a stream) is inert", async () => {
  // A Node stream has no Blob read surface; it is bounded by the data-event counter
  // instead, so the pre-read returns at once rather than mis-handling it.
  await expect(
    assertLeadingLineWithinByteCeiling(streamOf("a,b\n1,2\n"), 512),
  ).resolves.toBeUndefined();
});

// The cases above use a tiny ceiling, so `limit` stays under the helper's 256 KiB
// head window and only the head read runs. These two reach the tail read (the
// `limit > window` branch) with a ceiling above that window, which the small-ceiling
// cases never exercise -- the path where a head/tail seam off-by-one could wrongly
// reject a valid file, the one false-positive direction this backstop must avoid.
const HEAD_WINDOW = 256 * 1024;

test("assertLeadingLineWithinByteCeiling: a terminator past the first read window is still found", async () => {
  // A header that terminates only after the head window but within the ceiling must
  // resolve: the head/tail split must drop no bytes at the seam, so a legitimate
  // large header is never wrongly rejected.
  const ceiling = 2 * HEAD_WINDOW;
  const headerLen = HEAD_WINDOW + 4096; // past the head window, well under the ceiling
  const file = new File(
    [`${"h".repeat(headerLen)}\n${"v".repeat(HEAD_WINDOW)}`],
    "wide-header.csv",
  );
  expect(file.size).toBeGreaterThan(ceiling);
  await expect(
    assertLeadingLineWithinByteCeiling(file, ceiling),
  ).resolves.toBeUndefined();
});

test("assertLeadingLineWithinByteCeiling: a no-terminator file over a ceiling above the window rejects via the tail read", async () => {
  // The reject path through the tail read: with the ceiling above the head window
  // and no terminator anywhere, head and tail are both scanned and then it rejects.
  const ceiling = 2 * HEAD_WINDOW;
  const file = new File(["x".repeat(ceiling * 2)], "huge.csv");
  await expect(
    assertLeadingLineWithinByteCeiling(file, ceiling),
  ).rejects.toThrow(/single-line limit/);
});

test("loadCSVFile: a browser File with a no-newline leading line over the ceiling fails fast", async () => {
  // Wires the pre-read into loadCSVFile end to end: the File the web caller passes
  // rejects before parsing, so PapaParse's FileReader path is never reached. This
  // bounds the web path, which exposes no `data` events for the stream guard.
  const ceiling = 512;
  const file = new File(["x".repeat(ceiling * 2)], "data.csv", {
    type: "text/csv",
  });
  await expect(loadCSVFile(file, ceiling)).rejects.toThrow(/single-line limit/);
});

// The stream guard's run accounting, exercised directly against a fake stream
// source so the cases PapaParse's row splitting cannot reach -- CR-only endings,
// and an over-ceiling run terminated LATER in the same chunk (the inner-overflow
// path, which must trip rather than be forgiven by that later terminator) -- are
// pinned. A false positive (tripping a valid stream) is the dangerous direction;
// these confirm well-formed input never trips.

/**
 * A stand-in for the Node stream the guard attaches to: it captures the guard's
 * `data` listener so the test can feed chunks, and records destroy() calls (the
 * trip). Mirrors only the public surface the guard touches (on/removeListener/
 * destroy), no real stream.
 */
function fakeGuardSource() {
  let listener: ((chunk: Buffer | string) => void) | undefined;
  const destroyedWith: Array<Error | undefined> = [];
  const source = {
    on(_event: "data", l: (chunk: Buffer | string) => void) {
      listener = l;
    },
    removeListener() {
      listener = undefined;
    },
    destroy(error?: Error) {
      destroyedWith.push(error);
    },
  };
  return {
    source,
    push: (chunk: Buffer | string) => listener?.(chunk),
    tripped: () => destroyedWith.length > 0,
    trippedMessage: () => destroyedWith[0]?.message,
  };
}

test("guardStreamLineByteCeiling: well-formed CRLF lines under the ceiling do not trip", () => {
  const g = fakeGuardSource();
  guardStreamLineByteCeiling(g.source, 16);
  g.push(Buffer.from("a,b\r\n"));
  g.push(Buffer.from("c,d\r\n"));
  g.push(Buffer.from("ee,ff\r\n"));
  expect(g.tripped()).toBe(false);
});

test("guardStreamLineByteCeiling: CR-only line endings reset the run like LF/CRLF", () => {
  // Lines separated only by CR (0x0d), each well under the ceiling, total far over.
  // PapaParse's row splitting never exercises a lone CR, so the guard owns this.
  const g = fakeGuardSource();
  guardStreamLineByteCeiling(g.source, 8);
  g.push(Buffer.from("ab\rcd\ref\rgh\r"));
  expect(g.tripped()).toBe(false);
});

test("guardStreamLineByteCeiling: an over-ceiling run terminated later in the same chunk still trips", () => {
  // The inner-overflow path: the over-ceiling segment must trip BEFORE the
  // terminator that follows it in the same chunk resets the run -- otherwise an
  // oversized-but-terminated leading line would be silently forgiven.
  const g = fakeGuardSource();
  const ceiling = 10;
  guardStreamLineByteCeiling(g.source, ceiling);
  g.push(Buffer.from(`${"x".repeat(ceiling + 2)}\nshort\n`));
  expect(g.tripped()).toBe(true);
  expect(g.trippedMessage()).toMatch(/single-line limit/);
});

test("guardStreamLineByteCeiling: an over-ceiling run accumulated across chunks trips before a later terminator", () => {
  // The same inner overflow, but the run is carried across `data` events: the bytes
  // that cross the ceiling arrive in a later chunk, ahead of that chunk's terminator.
  const g = fakeGuardSource();
  guardStreamLineByteCeiling(g.source, 10);
  g.push(Buffer.from("xxxxxxx")); // run = 7, no terminator
  expect(g.tripped()).toBe(false);
  g.push(Buffer.from("xxxx\ny")); // 4 more before the \n -> run = 11 > 10
  expect(g.tripped()).toBe(true);
  expect(g.trippedMessage()).toMatch(/single-line limit/);
});

test("guardStreamLineByteCeiling: a line of exactly the ceiling passes, one byte over trips", () => {
  // The terminator byte is not counted, so content == ceiling is accepted and
  // content == ceiling + 1 trips -- the same boundary the pre-read uses.
  const atCeiling = fakeGuardSource();
  guardStreamLineByteCeiling(atCeiling.source, 10);
  atCeiling.push(Buffer.from(`${"x".repeat(10)}\n`));
  expect(atCeiling.tripped()).toBe(false);

  const overCeiling = fakeGuardSource();
  guardStreamLineByteCeiling(overCeiling.source, 10);
  overCeiling.push(Buffer.from(`${"x".repeat(11)}\n`));
  expect(overCeiling.tripped()).toBe(true);
});

test("guardStreamLineByteCeiling: many short lines whose total exceeds the ceiling do not trip", () => {
  // The run resets at every terminator, so cumulative bytes far over the ceiling are
  // fine. Pushes strings to exercise the Buffer.from(chunk) path.
  const g = fakeGuardSource();
  guardStreamLineByteCeiling(g.source, 8);
  for (let i = 0; i < 100; i++) g.push("ab,cd\n");
  expect(g.tripped()).toBe(false);
});

test("guardStreamLineByteCeiling: the detach function stops further scanning", () => {
  const g = fakeGuardSource();
  const detach = guardStreamLineByteCeiling(g.source, 8);
  detach();
  g.push(Buffer.from("x".repeat(100))); // would trip if still attached
  expect(g.tripped()).toBe(false);
});

test("guardStreamLineByteCeiling: a non-stream source (no `on`) is inert", () => {
  // A browser File has no `on`; the guard returns a no-op detach and never touches
  // it (that path is bounded by assertLeadingLineWithinByteCeiling instead).
  let destroyed = false;
  const detach = guardStreamLineByteCeiling(
    {
      destroy: () => {
        destroyed = true;
      },
    },
    8,
  );
  detach();
  expect(destroyed).toBe(false);
});
