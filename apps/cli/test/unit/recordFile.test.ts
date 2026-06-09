import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, test } from "vitest";

import {
  parseExchangeRecord,
  parseOpeningData,
  type ExchangeRecord,
  type OpeningData,
} from "@psilink/core";

import {
  defaultRecordPath,
  openingPathFor,
  recordPathsFor,
  resolveRecordOutput,
  writeExchangeRecord,
} from "../../src/recordFile";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-record-test-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// A minimal but schema-valid record + opening pair to write to disk.
const record: ExchangeRecord = {
  version: "psilink-exchange-record/v1",
  createdAt: "2026-01-02T03:04:05.000Z",
  termsHash: "hQi6gjL9Z0RFtfz2TZVqXmUF1Cu8PaBFbClOJ9R8l_Q",
  localIdentity: "Party A",
  partnerIdentity: "Party B",
  governance: {
    algorithm: "psi",
    matchingBasis: [{ name: "ssn", type: "ssn" }],
    payloadSent: [],
    payloadReceived: [],
  },
  recordsExposed: 5,
  resultSize: 2,
  bindingNonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  commitments: {
    localPayloadSent: "We5eIlrtkWBUe1uSGrla5rvLs0YhGFPPVDjk4EPX2k8",
    partnerPayloadReceived: "IFfNSyYoX8tKe2k-o6TjmrS1sW1ndtpZjexzR-fZa5g",
  },
};

const opening: OpeningData = {
  version: "psilink-exchange-opening/v1",
  commitments: {
    localPayloadSent: {
      salt: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
      data: { columns: [], rowIndices: [], rows: [] },
    },
    partnerPayloadReceived: {
      salt: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI",
      data: { columns: [], rowIndices: [], rows: [] },
    },
  },
};

test("defaultRecordPath is a filesystem-safe timestamped path in the cwd", () => {
  const p = defaultRecordPath("2026-06-06T01:02:03.456Z");
  expect(p).toBe("./psilink-record-2026-06-06T01-02-03-456Z.json");
  // No colon (invalid on Windows) and no fractional-second dot in the stamp.
  expect(path.basename(p)).not.toContain(":");
});

test("openingPathFor swaps a .json suffix for .opening.json", () => {
  expect(openingPathFor("/tmp/rec.json")).toBe("/tmp/rec.opening.json");
  // A leading ./ is preserved so the paired record and opening paths match.
  expect(openingPathFor("./psilink-record-X.json")).toBe(
    "./psilink-record-X.opening.json",
  );
  // No .json suffix: append rather than mangle.
  expect(openingPathFor("/tmp/rec")).toBe("/tmp/rec.opening.json");
});

test("resolveRecordOutput returns undefined when disabled", () => {
  expect(resolveRecordOutput({ enabled: false })).toBeUndefined();
  // --no-record wins over an explicit --record-file.
  expect(
    resolveRecordOutput({ enabled: false, recordFile: "x.json" }),
  ).toBeUndefined();
});

test("resolveRecordOutput keeps an explicit record file, else selects the default", () => {
  expect(
    resolveRecordOutput({ enabled: true, recordFile: "/tmp/a.json" }),
  ).toEqual({ recordFile: "/tmp/a.json" });
  // Whitespace-only is treated as no explicit file: fall back to the default.
  expect(resolveRecordOutput({ enabled: true, recordFile: "   " })).toEqual({
    recordFile: undefined,
  });
  expect(resolveRecordOutput({ enabled: true })).toEqual({
    recordFile: undefined,
  });
});

test("recordPathsFor uses an explicit path verbatim and derives the opening", () => {
  expect(
    recordPathsFor({ recordFile: "/tmp/a.json" }, "2026-01-02T03:04:05.000Z"),
  ).toEqual({
    recordFilePath: "/tmp/a.json",
    openingFilePath: "/tmp/a.opening.json",
  });
});

test("recordPathsFor stamps the default path with the record's createdAt", () => {
  // The default filename timestamp is the record's createdAt, not a separate
  // clock read, so the filename matches the timestamp recorded inside the file.
  expect(recordPathsFor({}, "2026-06-06T01:02:03.456Z")).toEqual({
    recordFilePath: "./psilink-record-2026-06-06T01-02-03-456Z.json",
    openingFilePath: "./psilink-record-2026-06-06T01-02-03-456Z.opening.json",
  });
});

test("writeExchangeRecord writes both files, parseable and owner-only", () => {
  const recordFilePath = path.join(dir, "rec.json");
  const openingFilePath = openingPathFor(recordFilePath);
  writeExchangeRecord({ recordFile: recordFilePath }, record, opening, "test");

  // Both files exist and round-trip through the schema parsers.
  expect(
    parseExchangeRecord(JSON.parse(fs.readFileSync(recordFilePath, "utf8"))),
  ).toEqual(record);
  expect(
    parseOpeningData(JSON.parse(fs.readFileSync(openingFilePath, "utf8"))),
  ).toEqual(opening);

  // Owner-only permissions on POSIX (mirrors saveKeyFile).
  if (process.platform !== "win32") {
    expect(fs.statSync(recordFilePath).mode & 0o077).toBe(0);
    expect(fs.statSync(openingFilePath).mode & 0o077).toBe(0);
  }
});

test("writeExchangeRecord is non-fatal when the destination is unwritable", () => {
  // A record path whose parent is a regular file cannot be created; the helper
  // must warn rather than throw, so a successful exchange is never failed by an
  // audit-write problem.
  const blocker = path.join(dir, "blocker");
  fs.writeFileSync(blocker, "x");
  const recordFilePath = path.join(blocker, "rec.json"); // parent is a file
  expect(() =>
    writeExchangeRecord(
      { recordFile: recordFilePath },
      record,
      opening,
      "test",
    ),
  ).not.toThrow();
  expect(fs.existsSync(recordFilePath)).toBe(false);
});
