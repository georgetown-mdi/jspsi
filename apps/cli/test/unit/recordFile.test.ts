import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, test, vi } from "vitest";

// Capture writeExchangeRecord's logger so the non-fatal "audit record could not
// be written" WARN is asserted (proving the failure is reported) rather than
// leaked to the suite output, and so the INFO lines the successful writes emit
// can be asserted for what they tell the operator. getLogger is the only
// @psilink/core export replaced; everything else stays real.
const logCapture = vi.hoisted(() => ({
  infos: [] as string[],
  warnings: [] as string[],
}));

vi.mock("@psilink/core", async (importActual) => {
  const actual = await importActual<typeof import("@psilink/core")>();
  return {
    ...actual,
    getLogger: () => ({
      info: (msg: string, ...args: unknown[]) => {
        logCapture.infos.push([msg, ...args.map(String)].join(" "));
      },
      warn: (msg: string, ...args: unknown[]) => {
        logCapture.warnings.push([msg, ...args.map(String)].join(" "));
      },
      debug: () => {},
      error: () => {},
      trace: () => {},
    }),
  };
});

import {
  parseExchangeRecord,
  parseVerificationKeys,
  type ExchangeRecord,
  type VerificationKeys,
} from "@psilink/core";

import {
  keysPathFor,
  recordPathsFor,
  resolveRecordOutput,
  writeExchangeRecord,
} from "../../src/recordFile";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-record-test-"));
  logCapture.infos.length = 0;
  logCapture.warnings.length = 0;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// A minimal but schema-valid record + verification-keys pair to write to disk.
const record: ExchangeRecord = {
  version: "psilink-exchange-record/v6",
  outcome: "completed",
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

const keys: VerificationKeys = {
  version: "psilink-exchange-keys/v1",
  salts: {
    localPayloadSent: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
    partnerPayloadReceived: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI",
  },
};

test("keysPathFor swaps a .json suffix for .keys.json", () => {
  expect(keysPathFor("/tmp/rec.json")).toBe("/tmp/rec.keys.json");
  // A leading ./ is preserved so the paired record and keys paths match.
  expect(keysPathFor("./psilink-record-X.json")).toBe(
    "./psilink-record-X.keys.json",
  );
  // No .json suffix: append rather than mangle.
  expect(keysPathFor("/tmp/rec")).toBe("/tmp/rec.keys.json");
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

test("recordPathsFor uses an explicit path verbatim and derives the keys path", () => {
  expect(
    recordPathsFor({ recordFile: "/tmp/a.json" }, "2026-01-02T03:04:05.000Z"),
  ).toEqual({
    recordFilePath: "/tmp/a.json",
    keysFilePath: "/tmp/a.keys.json",
  });
});

test("recordPathsFor stamps the default path with the record's createdAt", () => {
  // The default filename timestamp is the record's createdAt, not a separate
  // clock read, so the filename matches the timestamp recorded inside the file.
  expect(recordPathsFor({}, "2026-06-06T01:02:03.456Z")).toEqual({
    recordFilePath: "./psilink-record-2026-06-06T01-02-03-456Z.json",
    keysFilePath: "./psilink-record-2026-06-06T01-02-03-456Z.keys.json",
  });
});

test("writeExchangeRecord writes both files, parseable and owner-only", () => {
  const recordFilePath = path.join(dir, "rec.json");
  const keysFilePath = keysPathFor(recordFilePath);
  expect(
    writeExchangeRecord({ recordFile: recordFilePath }, record, keys, "test"),
  ).toBeUndefined();

  // Both files exist and round-trip through the schema parsers.
  expect(
    parseExchangeRecord(JSON.parse(fs.readFileSync(recordFilePath, "utf8"))),
  ).toEqual(record);
  expect(
    parseVerificationKeys(JSON.parse(fs.readFileSync(keysFilePath, "utf8"))),
  ).toEqual(keys);

  // A completed run's line contains none of the terminated tail: it has no
  // disclosure-before-a-failure to report.
  expect(
    logCapture.infos.find((m) =>
      m.includes("wrote self-attested exchange record"),
    ),
  ).not.toContain("terminated");

  // Owner-only permissions on POSIX (mirrors saveKeyFile).
  if (process.platform !== "win32") {
    expect(fs.statSync(recordFilePath).mode & 0o077).toBe(0);
    expect(fs.statSync(keysFilePath).mode & 0o077).toBe(0);
  }
});

test("writeExchangeRecord is non-fatal when the destination is unwritable", () => {
  // A record path whose parent is a regular file cannot be created; the helper warns
  // rather than throws, so a successful exchange is never failed by an audit-write
  // problem. The return value still reports the loss to the caller -- what an
  // unattended run's machine-interface stream and exit code show when nobody reads
  // stderr. It names the destination, not the cause: the caller's sink already
  // escapes the log line's cause once.
  const blocker = path.join(dir, "blocker");
  fs.writeFileSync(blocker, "x");
  const recordFilePath = path.join(blocker, "rec.json"); // parent is a file
  let failure: string | undefined;
  expect(() => {
    failure = writeExchangeRecord(
      { recordFile: recordFilePath },
      record,
      keys,
      "test",
    );
  }).not.toThrow();
  expect(failure).toContain("the audit record could not be written to");
  expect(failure).toContain(recordFilePath);
  expect(failure).toContain("need not be re-run");
  expect(fs.existsSync(recordFilePath)).toBe(false);
  // The non-fatal failure is reported as a WARN (asserting it both proves the
  // diagnostic fired and keeps it off the suite output).
  expect(
    logCapture.warnings.some((m) =>
      m.includes("the audit record could not be written"),
    ),
  ).toBe(true);
});

// --- A terminated run's record -----------------------------------------------

/** The record a run that disclosed and then terminated without a receipt leaves
 * behind: the same shape and the same destination, saying so itself. */
const terminatedRecord: ExchangeRecord = {
  ...record,
  outcome: "receipt-swap-terminated",
};

test("a terminated run's record is written to the same destination", () => {
  const recordFilePath = path.join(dir, "rec.json");
  expect(
    writeExchangeRecord(
      { recordFile: recordFilePath },
      terminatedRecord,
      keys,
      "test",
    ),
  ).toBeUndefined();
  expect(
    parseExchangeRecord(JSON.parse(fs.readFileSync(recordFilePath, "utf8"))),
  ).toEqual(terminatedRecord);
  expect(fs.existsSync(keysPathFor(recordFilePath))).toBe(true);

  // The line naming the file says what the record covers and names no failing
  // step: one outcome covers every way the post-disclosure region can end, so a
  // line naming the receipt swap would report a step to an operator whose run
  // was refused at the received-payload check before it -- or who configured no
  // signing identity, and had no swap to fail.
  const wrote = logCapture.infos.find((m) =>
    m.includes("wrote self-attested exchange record"),
  );
  expect(wrote).toBeDefined();
  expect(wrote).toContain("before the run terminated");
  expect(wrote).toContain("no receipt accompanies it");
  expect(wrote).not.toContain("swap");
});

test("a terminated run's lost record is not reported as a completed exchange", () => {
  // "The exchange and its results succeeded and need not be re-run" is the
  // completed run's remedy, and it is the wrong thing to tell an operator whose
  // run failed. The prose turns on the record's own outcome, so the file and the
  // words about it cannot disagree.
  const blocker = path.join(dir, "blocker");
  fs.writeFileSync(blocker, "x");
  const recordFilePath = path.join(blocker, "rec.json");
  const failure = writeExchangeRecord(
    { recordFile: recordFilePath },
    terminatedRecord,
    keys,
    "test",
  );
  expect(failure).toContain("the audit record could not be written to");
  expect(failure).toContain("disclosed before it failed");
  expect(failure).not.toContain("need not be re-run");
  expect(
    logCapture.warnings.some((m) => m.includes("disclosed before it failed")),
  ).toBe(true);
});
