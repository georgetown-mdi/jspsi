import { Readable } from "node:stream";

import { expect, test } from "vitest";

import {
  CSV_DELIMITER_DETECT,
  csvDelimiterRefusal,
  DEFAULT_CSV_DELIMITER,
  isCsvDelimiter,
  isCsvDelimiterChoice,
  normalizeCsvDelimiter,
  resultCsvDelimiter,
  singleColumnDelimiterClause,
} from "../src/csvDelimiter";
import {
  CSV_LINE_BYTE_CEILING,
  CsvLineByteCeilingError,
  loadCSVColumnSample,
  loadCSVFile,
  streamCSVRows,
} from "../src/file";
import { buildOutputTable } from "../src/payloadExchange";
import { safeParseExchangeSpec } from "../src/config/exchangeSpec";
import type { CSVRow } from "../src/file";
import type { AssociationTable, Metadata } from "../src/main";

/** A readable emitting `content` then EOF, standing in for a CSV file. */
function streamOf(content: string): Readable {
  const s = new Readable({ read() {} });
  if (content.length > 0) s.push(Buffer.from(content, "utf8"));
  s.push(null);
  return s;
}

// The four an operator's source system exports, plus one outside that set to
// hold the rule to "any single printable ASCII character" rather than a list.
const ACCEPTED = [",", "\t", "|", ";", "^"];

// --- The accepted set --------------------------------------------------------

test("isCsvDelimiter accepts a tab and every printable ASCII character but the quote", () => {
  expect(ACCEPTED.every(isCsvDelimiter)).toBe(true);
  expect(isCsvDelimiter(DEFAULT_CSV_DELIMITER)).toBe(true);
  // A space is printable ASCII and delimits a file some exports produce.
  expect(isCsvDelimiter(" ")).toBe(true);
  for (let code = 0x20; code <= 0x7e; code += 1) {
    const char = String.fromCharCode(code);
    expect(isCsvDelimiter(char)).toBe(char !== '"');
  }
});

test("isCsvDelimiter refuses everything the read and the write could not agree on", () => {
  // Multi-character: PapaParse accepts one (driven against the parser), and no
  // single character could be escaped against it on the write side.
  expect(isCsvDelimiter("::")).toBe(false);
  expect(isCsvDelimiter("")).toBe(false);
  // The quote is RFC 4180's escape character, and PapaParse ignores it as a
  // delimiter and detects one of its own instead.
  expect(isCsvDelimiter('"')).toBe(false);
  expect(isCsvDelimiter("\n")).toBe(false);
  expect(isCsvDelimiter("\r")).toBe(false);
  // Non-ASCII: the byte ceilings count bytes while the write escapes by code
  // unit.
  expect(isCsvDelimiter("\u00a7")).toBe(false);
  expect(isCsvDelimiter("\u0000")).toBe(false);
  expect(isCsvDelimiter(String.fromCharCode(127))).toBe(false);
});

test("normalizeCsvDelimiter resolves the tab and detect spellings and leaves everything else", () => {
  expect(normalizeCsvDelimiter("tab")).toBe("\t");
  expect(normalizeCsvDelimiter("TAB")).toBe("\t");
  expect(normalizeCsvDelimiter(" tab ")).toBe("\t");
  expect(normalizeCsvDelimiter("\\t")).toBe("\t");
  expect(normalizeCsvDelimiter("\t")).toBe("\t");
  expect(normalizeCsvDelimiter("|")).toBe("|");
  for (const spelling of ["detect", "DETECT", " Detect "])
    expect(normalizeCsvDelimiter(spelling)).toBe(CSV_DELIMITER_DETECT);
  // A space is itself a delimiter, so it is not trimmed away.
  expect(normalizeCsvDelimiter(" ")).toBe(" ");
});

test("the detect choice is accepted where a choice is authored, not where a character is needed", () => {
  expect(isCsvDelimiterChoice(CSV_DELIMITER_DETECT)).toBe(true);
  expect(ACCEPTED.every(isCsvDelimiterChoice)).toBe(true);
  // A multi-character value cannot be a delimiter, which is what keeps the
  // reserved word from colliding with a character a party names.
  expect(isCsvDelimiter(CSV_DELIMITER_DETECT)).toBe(false);
  expect(isCsvDelimiterChoice("detected")).toBe(false);
});

test("a result is written with the chosen character, and with a comma for none or detection", () => {
  for (const delimiter of ACCEPTED)
    expect(resultCsvDelimiter(delimiter)).toBe(delimiter);
  expect(resultCsvDelimiter(undefined)).toBe(DEFAULT_CSV_DELIMITER);
  expect(resultCsvDelimiter(CSV_DELIMITER_DETECT)).toBe(DEFAULT_CSV_DELIMITER);
});

test("the refusal names the rule and the shape, never the value", () => {
  for (const value of ["::", "", '"', "\n", "\u00a7"]) {
    const message = csvDelimiterRefusal(value);
    expect(message).toContain("single character");
    expect(message).toContain("printable ASCII");
    // The remedy is spelled the way the operator must type it, and holds no
    // backslash: every sink escapes one more time, so a backslash-t spelling
    // here would reach them doubled and be refused when typed back.
    expect(message).toContain("write it `tab`");
    expect(message).not.toContain("\\");
  }
  expect(csvDelimiterRefusal("::")).toContain("2-character value");
  expect(csvDelimiterRefusal("")).toContain("an empty value");
  expect(csvDelimiterRefusal('"')).toContain("the double quote");
  expect(csvDelimiterRefusal("\n")).toContain("a line terminator");
  expect(csvDelimiterRefusal("\u00a7")).toContain("a non-ASCII character");
  // DEL sits above the printable range and inside ASCII, so it is named as the
  // control character it is rather than as a character outside ASCII.
  expect(csvDelimiterRefusal(String.fromCharCode(127))).toContain(
    "a control character (code point 127)",
  );
  // The offending bytes stay out of the message the operator is shown.
  expect(csvDelimiterRefusal("\u0007")).not.toContain("\u0007");
});

// --- Reading -----------------------------------------------------------------

test("loadCSVFile reads every accepted delimiter", async () => {
  for (const delimiter of ACCEPTED) {
    const result = await loadCSVFile(
      streamOf(`id${delimiter}name\n1${delimiter}alice\n2${delimiter}bob\n`),
      undefined,
      delimiter,
    );
    expect(result.meta.fields).toEqual(["id", "name"]);
    expect(result.data).toEqual([
      { id: "1", name: "alice" },
      { id: "2", name: "bob" },
    ]);
  }
});

test("streamCSVRows and loadCSVColumnSample read the same non-comma file", async () => {
  const pipe = "id|dob\n1|1990-01-02\n2|1991-03-04\n";
  const rows: Array<CSVRow> = [];
  const streamed = await streamCSVRows(
    streamOf(pipe),
    (chunk) => rows.push(...chunk),
    undefined,
    "|",
  );
  expect(streamed.columns).toEqual(["id", "dob"]);
  expect(rows).toEqual([
    { id: "1", dob: "1990-01-02" },
    { id: "2", dob: "1991-03-04" },
  ]);

  const sampled = await loadCSVColumnSample(
    streamOf(pipe),
    (columns) => columns[1],
    10,
    undefined,
    "|",
  );
  expect(sampled.columns).toEqual(["id", "dob"]);
  expect(sampled.sample).toEqual(["1990-01-02", "1991-03-04"]);
});

test("a chosen delimiter is the only one honoured, whatever the file suggests", async () => {
  // Read with a comma, a pipe-delimited file is one column -- no detection
  // silently reads it another way. The mismatch is visible as a single column,
  // which is what the terms-satisfiability refusal reports to the operator.
  const result = await loadCSVFile(
    streamOf("id|name\n1|alice\n"),
    undefined,
    ",",
  );
  expect(result.meta.fields).toEqual(["id|name"]);
});

test("a read given no delimiter takes a comma, whatever the file separates on", async () => {
  const comma = await loadCSVFile(streamOf("id,name\n1,alice\n"));
  expect(comma.meta.fields).toEqual(["id", "name"]);
  // A pipe-separated file is one column under the default: the mismatch reaches
  // the caller's column check, which is what the operator can act on, rather
  // than being read by a character nobody named.
  const pipe = await loadCSVFile(streamOf("id|name\n1|alice\n"));
  expect(pipe.meta.fields).toEqual(["id|name"]);
  // A tab-separated file comes out as one column too, its name minus the tab:
  // the header transform strips the control characters a column name may not
  // hold, and reports the position it changed.
  const tab = await loadCSVFile(streamOf("id\tname\n1\talice\n"));
  expect(tab.meta.fields).toEqual(["idname"]);
  expect(tab.meta.sanitizedColumnPositions).toEqual([1]);
});

// --- The explicit detect choice ----------------------------------------------

// The candidate set is the parser's own, driven here rather than transcribed
// from its documentation: a file separated by one of these is read as its
// columns under the detect choice, and a file separated by anything else falls
// back to the comma (PapaParse's `UndetectableDelimiter`, the one fault code the
// read treats as benign) and comes out as a single column.
const DETECTED = [",", "\t", "|", ";", "\u001e", "\u001f"];
const NOT_DETECTED = [":", "^", " "];

test("the detect choice reads every delimiter the parser detects", async () => {
  for (const delimiter of DETECTED) {
    const result = await loadCSVFile(
      streamOf(`id${delimiter}name\n1${delimiter}alice\n`),
      undefined,
      CSV_DELIMITER_DETECT,
    );
    expect(result.meta.fields).toEqual(["id", "name"]);
  }
});

test("the detect choice does not reach a delimiter the parser leaves out", async () => {
  for (const delimiter of NOT_DETECTED) {
    const result = await loadCSVFile(
      streamOf(`id${delimiter}name\n1${delimiter}alice\n`),
      undefined,
      CSV_DELIMITER_DETECT,
    );
    expect(result.meta.fields).toEqual([`id${delimiter}name`]);
  }
});

test("the streaming and sampling reads take the detect choice too", async () => {
  const pipe = "id|dob\n1|1990-01-02\n";
  const rows: Array<CSVRow> = [];
  const streamed = await streamCSVRows(
    streamOf(pipe),
    (chunk) => rows.push(...chunk),
    undefined,
    CSV_DELIMITER_DETECT,
  );
  expect(streamed.columns).toEqual(["id", "dob"]);
  expect(rows).toEqual([{ id: "1", dob: "1990-01-02" }]);

  const sampled = await loadCSVColumnSample(
    streamOf(pipe),
    (columns) => columns[1],
    10,
    undefined,
    CSV_DELIMITER_DETECT,
  );
  expect(sampled.columns).toEqual(["id", "dob"]);
  expect(sampled.sample).toEqual(["1990-01-02"]);
});

test("the one-column clause states the remedy, and only for a one-column header", () => {
  const clause = singleColumnDelimiterClause(1);
  expect(clause).toContain("single column");
  expect(clause).toContain("CSV delimiter");
  expect(clause).toContain(CSV_DELIMITER_DETECT);
  // The same clause is emitted whether or not the party named a delimiter, so
  // it states what the read produced and never how the delimiter was chosen.
  expect(clause).not.toContain("no delimiter");
  for (const count of [0, 2, 7])
    expect(singleColumnDelimiterClause(count)).toBe("");
});

// --- The header defenses, under a non-comma delimiter ------------------------

const RLO = "\u202e";

test("the header transform strips text-direction characters under any delimiter", async () => {
  for (const delimiter of ACCEPTED) {
    const result = await loadCSVFile(
      streamOf(`id${delimiter}na${RLO}me\n1${delimiter}alice\n`),
      undefined,
      delimiter,
    );
    expect(result.meta.fields).toEqual(["id", "name"]);
    expect(result.meta.sanitizedColumnPositions).toEqual([2]);
  }
});

test("an empty column name survives the read under a non-comma delimiter, for the intake refusal", async () => {
  // The read does not refuse it; the empty name reaches the header list, where
  // every intake's own unnamed-column refusal meets it -- the same as under a
  // comma.
  const result = await loadCSVFile(streamOf("id|\n1|alice\n"), undefined, "|");
  expect(result.meta.fields).toEqual(["id", ""]);
});

test("the single-line byte ceiling holds under a non-comma delimiter", async () => {
  const ceiling = 64;
  for (const delimiter of ACCEPTED) {
    const oversized = `id${delimiter}name\n1${delimiter}${"x".repeat(ceiling * 2)}\n`;
    await expect(
      loadCSVFile(streamOf(oversized), ceiling, delimiter),
    ).rejects.toBeInstanceOf(CsvLineByteCeilingError);
    // The bound counts bytes between line terminators, so a file of many short
    // lines passes however many delimiters each holds.
    const withinCeiling = `id${delimiter}name\n${Array.from(
      { length: 20 },
      (_, i) => `${i}${delimiter}alice`,
    ).join("\n")}\n`;
    const read = await loadCSVFile(streamOf(withinCeiling), ceiling, delimiter);
    expect(read.data.length).toBe(20);
  }
  expect(CSV_LINE_BYTE_CEILING).toBeGreaterThan(0);
});

// --- Writing and the round trip ----------------------------------------------

const metadata: Metadata = [
  { name: "pid", type: "ssn", role: "identifier", isPayload: false },
];
const associationTable: AssociationTable = [[0], [0]];

test("a value holding the chosen delimiter survives a write-then-read round trip", async () => {
  for (const delimiter of ACCEPTED) {
    // Each cell holds the delimiter itself, a double quote, and a line break --
    // everything the write must quote for the file to read back.
    const held = `a${delimiter}b "q" c\nd`;
    const { headers, rows } = buildOutputTable(
      associationTable,
      [{ pid: held }],
      metadata,
      { columns: ["note"], rowIndices: [0], rows: [[held]] },
      undefined,
      delimiter,
    );
    const file =
      headers.join(delimiter) + "\n" + rows[0].join(delimiter) + "\n";
    const readBack = await loadCSVFile(streamOf(file), undefined, delimiter);
    expect(readBack.meta.fields).toEqual(["pid", "row_id", "note"]);
    expect(readBack.data).toEqual([{ pid: held, row_id: "0", note: held }]);
  }
});

test("buildOutputTable quotes against the chosen delimiter, not against the comma", () => {
  const { rows } = buildOutputTable(
    associationTable,
    [{ pid: "a|b" }],
    metadata,
    { columns: ["note"], rowIndices: [0], rows: [["x,y"]] },
    undefined,
    "|",
  );
  // The pipe is the delimiter, so the cell holding it is quoted; the comma is
  // an ordinary character under this delimiter and is left bare.
  expect(rows[0][0]).toBe('"a|b"');
  expect(rows[0][2]).toBe("x,y");
});

test("buildOutputTable refuses a delimiter that is not a single character", () => {
  // The escaping holds against one character only, so a caller that handed the
  // party's choice over unresolved -- the reserved word above all -- is stopped
  // rather than quoting every cell against a string no join splits back on.
  for (const unresolved of [CSV_DELIMITER_DETECT, "::"])
    expect(() =>
      buildOutputTable(
        associationTable,
        [{ pid: "a" }],
        metadata,
        { columns: ["note"], rowIndices: [0], rows: [["x"]] },
        undefined,
        unresolved,
      ),
    ).toThrow(/^result delimiter is not a single accepted character/);
});

// --- The configuration field --------------------------------------------------

const baseSpec = {
  connection: {
    channel: "filedrop",
    path: "/tmp/psilink",
  },
  linkage_terms: {
    version: "1.0.0",
    date: "2025-01-01",
    algorithm: "psi",
    output: { expects_output: true, share_with_partner: true },
    deduplicate: false,
    linkage_fields: [{ name: "ssn", type: "ssn" }],
    linkage_keys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
  },
};

test("csv_delimiter takes an accepted character and the tab spellings", () => {
  for (const delimiter of ACCEPTED) {
    const parsed = safeParseExchangeSpec({
      ...baseSpec,
      csv_delimiter: delimiter,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.csvDelimiter).toBe(delimiter);
  }
  for (const spelling of ["tab", "\\t"]) {
    const parsed = safeParseExchangeSpec({
      ...baseSpec,
      csv_delimiter: spelling,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.csvDelimiter).toBe("\t");
  }
});

test("csv_delimiter refuses a value outside the accepted set, in the shared words", () => {
  for (const value of ["::", "", '"', "\n", "\u00a7"]) {
    const parsed = safeParseExchangeSpec({
      ...baseSpec,
      csv_delimiter: value,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success)
      expect(parsed.error.issues[0].message).toBe(csvDelimiterRefusal(value));
  }
});

test("csv_delimiter takes the detect choice as a value of its own", () => {
  for (const spelling of ["detect", "DETECT"]) {
    const parsed = safeParseExchangeSpec({
      ...baseSpec,
      csv_delimiter: spelling,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success)
      expect(parsed.data.csvDelimiter).toBe(CSV_DELIMITER_DETECT);
  }
});

test("an absent csv_delimiter leaves the spec with none, which reads and writes a comma", () => {
  const parsed = safeParseExchangeSpec(baseSpec);
  expect(parsed.success).toBe(true);
  if (parsed.success) expect(parsed.data.csvDelimiter).toBeUndefined();
  expect(resultCsvDelimiter(undefined)).toBe(DEFAULT_CSV_DELIMITER);
});
