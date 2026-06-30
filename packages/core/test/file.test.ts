import { Readable } from "node:stream";

import { expect, test, vi } from "vitest";

import { loadCSVColumnSample } from "../src/file";
import { inferDateFormat, columnValues } from "../src/utils/date";

/** A readable emitting `content` then EOF, standing in for a CSV file/stream. */
function streamOf(content: string): Readable {
  const s = new Readable({ read() {} });
  if (content.length > 0) s.push(Buffer.from(content, "utf8"));
  s.push(null);
  return s;
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
