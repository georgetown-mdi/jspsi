import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  buildExchangeRecord,
  serializeExchangeRecord,
  serializeVerificationKeys,
  UsageError,
} from "@psilink/core";
import type {
  CommittedPayload,
  ExchangeRecordInputs,
  RecordVerificationReport,
} from "@psilink/core";

import {
  deriveOurIdColumn,
  formatVerificationReport,
  readExchangeRecordFile,
  readVerificationKeysFile,
  toRetainedResult,
} from "../../src/commands/verifyReceipt";

const tmp = () => mkdtempSync(join(tmpdir(), "verify-receipt-"));

const localPayloadSent: CommittedPayload = {
  columns: ["dose"],
  rows: [["10mg"]],
};
const baseInputs: ExchangeRecordInputs = {
  localTerms: {
    version: "1.0.0",
    identity: "Party A",
    date: "2025-01-01",
    algorithm: "psi",
    linkageStrategy: "cascade",
    output: { expectsOutput: true, shareWithPartner: true },
    deduplicate: false,
    linkageFields: [{ name: "ssn", type: "ssn" }],
    linkageKeys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
  },
  partnerTerms: {
    version: "1.0.0",
    identity: "Party B",
    date: "2025-01-01",
    algorithm: "psi",
    linkageStrategy: "cascade",
    output: { expectsOutput: true, shareWithPartner: true },
    deduplicate: false,
    linkageFields: [{ name: "ssn", type: "ssn" }],
    linkageKeys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
  },
  recordsExposed: 1,
  localPayloadSent,
  partnerPayloadReceived: { columns: [], rows: [] },
  createdAt: "2026-01-02T03:04:05.000Z",
};

describe("formatVerificationReport", () => {
  const report = (
    outcome: RecordVerificationReport["outcome"],
  ): RecordVerificationReport => ({
    outcome,
    termsHash: outcome === "verified" ? "verified" : "not-checked",
    commitments: {
      localPayloadSent: outcome === "failed" ? "mismatch" : "verified",
      partnerPayloadReceived: "verified",
    },
  });

  test("verified reports a clean pass and exit 0", () => {
    const { lines, exitCode } = formatVerificationReport(
      report("verified"),
      [],
    );
    expect(lines[0]).toMatch(/^VERIFIED/);
    expect(lines.join("\n")).toContain(
      "agreed-terms hash: re-derives and matches",
    );
    expect(lines.join("\n")).toContain(
      "partner receipt signatures are not verified",
    );
    expect(exitCode).toBe(0);
  });

  test("incomplete is not a failure (exit 0) but is labelled distinctly", () => {
    const { lines, exitCode } = formatVerificationReport(
      report("incomplete"),
      [],
    );
    expect(lines[0]).toMatch(/^INCOMPLETE/);
    expect(exitCode).toBe(0);
  });

  test("failed exits 1 and does not assert tamper", () => {
    const { lines, exitCode } = formatVerificationReport(report("failed"), []);
    expect(lines[0]).toMatch(/^VERIFICATION FAILED/);
    // The message allows for a re-supply mismatch, not only tampering.
    expect(lines[0]).toContain("does not match this exchange");
    expect(lines.join("\n")).toContain(
      "commitment localPayloadSent: DOES NOT MATCH",
    );
    expect(exitCode).toBe(1);
  });

  test("warnings are surfaced as notes", () => {
    const { lines } = formatVerificationReport(report("incomplete"), [
      "a duplicate identifier value",
    ]);
    expect(lines.join("\n")).toContain("note: a duplicate identifier value");
  });

  test("a warning with control bytes is sanitized before display", () => {
    // A reconstruction warning interpolates a column name drawn from the
    // supplied files; a crafted name carrying an ANSI/control sequence must be
    // neutralized at the display boundary, not echoed to the terminal raw.
    const esc = String.fromCharCode(0x1b);
    const bel = String.fromCharCode(0x07);
    const { lines } = formatVerificationReport(report("incomplete"), [
      'the identifier column "a' +
        esc +
        "[31m" +
        bel +
        '" has duplicate values',
    ]);
    const out = lines.join("\n");
    // The raw ESC and BEL bytes are replaced with visible escapes, never emitted.
    expect(out).not.toContain(esc);
    expect(out).not.toContain(bel);
    expect(out).toContain("note:");
  });
});

describe("deriveOurIdColumn", () => {
  test("returns the first header when the input has that column (identifier)", () => {
    expect(
      deriveOurIdColumn(["pid", "row_id", "note"], new Set(["pid", "dose"])),
    ).toBe("pid");
  });

  test("returns undefined when the first header is not an input column (row index)", () => {
    expect(
      deriveOurIdColumn(["row_id", "their_row_id"], new Set(["dose"])),
    ).toBeUndefined();
  });
});

describe("toRetainedResult", () => {
  test("converts header-keyed rows into positional headers and rows", () => {
    const result = toRetainedResult({
      meta: { fields: ["pid", "row_id", "note"] },
      data: [
        { pid: "P0", row_id: "2", note: "x" },
        { pid: "P2", row_id: "0", note: "" },
      ],
    });
    expect(result.headers).toEqual(["pid", "row_id", "note"]);
    expect(result.rows).toEqual([
      ["P0", "2", "x"],
      ["P2", "0", ""],
    ]);
  });
});

describe("readExchangeRecordFile / readVerificationKeysFile", () => {
  test("read a valid record and keys back", async () => {
    const dir = tmp();
    const { record, keys } = await buildExchangeRecord(baseInputs);
    const recPath = join(dir, "rec.json");
    const keysPath = join(dir, "rec.keys.json");
    writeFileSync(recPath, serializeExchangeRecord(record));
    writeFileSync(keysPath, serializeVerificationKeys(keys));
    expect(readExchangeRecordFile(recPath).version).toBe(record.version);
    expect(readVerificationKeysFile(keysPath).version).toBe(keys.version);
  });

  test("reject an unrecognized record version with a clear error", async () => {
    const dir = tmp();
    const { record } = await buildExchangeRecord(baseInputs);
    const bumped = { ...record, version: "psilink-exchange-record/v2" };
    const recPath = join(dir, "rec.json");
    writeFileSync(recPath, JSON.stringify(bumped, null, 2));
    expect(() => readExchangeRecordFile(recPath)).toThrow(UsageError);
    expect(() => readExchangeRecordFile(recPath)).toThrow(
      /unrecognized version/,
    );
  });

  test("reject an unrecognized keys version with a clear error", async () => {
    const dir = tmp();
    const { keys } = await buildExchangeRecord(baseInputs);
    const bumped = { ...keys, version: "psilink-exchange-keys/v2" };
    const keysPath = join(dir, "rec.keys.json");
    writeFileSync(keysPath, JSON.stringify(bumped, null, 2));
    expect(() => readVerificationKeysFile(keysPath)).toThrow(
      /unrecognized version/,
    );
  });
});
