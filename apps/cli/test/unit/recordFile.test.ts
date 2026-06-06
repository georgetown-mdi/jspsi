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
      data: { hasData: false },
    },
    partnerPayloadReceived: {
      salt: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI",
      data: { columns: [], rowIndices: [], rows: [] },
    },
  },
};

test("defaultRecordPath is a filesystem-safe timestamped path in the cwd", () => {
  const p = defaultRecordPath(new Date("2026-06-06T01:02:03.456Z"));
  expect(p).toBe("./psilink-record-2026-06-06T01-02-03-456Z.json");
  // No colon (invalid on Windows) and no fractional-second dot in the stamp.
  expect(path.basename(p)).not.toContain(":");
});

test("openingPathFor swaps a .json suffix for .opening.json", () => {
  expect(openingPathFor("/tmp/rec.json")).toBe("/tmp/rec.opening.json");
  expect(openingPathFor("./psilink-record-X.json")).toBe(
    "psilink-record-X.opening.json",
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

test("resolveRecordOutput uses an explicit record file and derives the opening", () => {
  const out = resolveRecordOutput({ enabled: true, recordFile: "/tmp/a.json" });
  expect(out).toEqual({
    recordFilePath: "/tmp/a.json",
    openingFilePath: "/tmp/a.opening.json",
  });
});

test("resolveRecordOutput falls back to a timestamped default", () => {
  const out = resolveRecordOutput({
    enabled: true,
    now: new Date("2026-06-06T01:02:03.456Z"),
  });
  expect(out?.recordFilePath).toBe(
    "./psilink-record-2026-06-06T01-02-03-456Z.json",
  );
  expect(out?.openingFilePath).toBe(
    "psilink-record-2026-06-06T01-02-03-456Z.opening.json",
  );
});

test("writeExchangeRecord writes both files, parseable and owner-only", () => {
  const recordFilePath = path.join(dir, "rec.json");
  const openingFilePath = openingPathFor(recordFilePath);
  writeExchangeRecord(
    { recordFilePath, openingFilePath },
    record,
    opening,
    "test",
  );

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
      { recordFilePath, openingFilePath: openingPathFor(recordFilePath) },
      record,
      opening,
      "test",
    ),
  ).not.toThrow();
  expect(fs.existsSync(recordFilePath)).toBe(false);
});
