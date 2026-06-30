import { Readable } from "node:stream";

import { expect, test, vi } from "vitest";

import { CSV_LINE_BYTE_CEILING, loadCSVColumnSample } from "../src/file";
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

test("loadCSVColumnSample: a no-newline span over the byte ceiling fails fast", async () => {
  // One logical line with no terminator anywhere: PapaParse can never yield a row
  // or settle the header, so the read would buffer the whole span. The byte
  // ceiling aborts it with an operator-readable error once the bytes pulled since
  // the (never-advancing) cursor cross the limit. Delivered in small chunks, as
  // fs.createReadStream / stdin would deliver a large file.
  const ceiling = 512;
  const giant = "x".repeat(ceiling * 4);
  await expect(
    loadCSVColumnSample(chunkedStreamOf(giant, 64), pickDob, 1000, ceiling),
  ).rejects.toThrow(/single-line limit/);
});

test("loadCSVColumnSample: a single field over the byte ceiling fails fast", async () => {
  // The header terminates normally, then one data field grows without a row
  // terminator. The cursor advances past the header and then stalls, so the span
  // measured since that last terminator -- the unbounded field -- crosses the
  // ceiling and the read fails fast rather than buffering the whole field.
  const ceiling = 512;
  const giantField = "y".repeat(ceiling * 4);
  const csv = `name,dob\nAlice,${giantField}`;
  await expect(
    loadCSVColumnSample(chunkedStreamOf(csv, 64), pickDob, 1000, ceiling),
  ).rejects.toThrow(/single-line limit/);
});

test("loadCSVColumnSample: a header over the byte ceiling fails fast", async () => {
  // A header of very many columns with its terminator beyond the ceiling: the
  // cursor stays at zero until that newline, so the header span crosses the limit
  // first and the read aborts before settling -- the giant-header shape.
  const ceiling = 512;
  const cols = Array.from({ length: 400 }, (_v, i) => `col_${i}`);
  const header = cols.join(",");
  expect(Buffer.byteLength(header)).toBeGreaterThan(ceiling);
  const row = cols.map(() => "v").join(",");
  await expect(
    loadCSVColumnSample(
      chunkedStreamOf(`${header}\n${row}\n`, 64),
      pickDob,
      1000,
      ceiling,
    ),
  ).rejects.toThrow(/single-line limit/);
});

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
