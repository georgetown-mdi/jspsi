import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, test, vi } from "vitest";

// Capture writeDualSignedRecord's logger so the non-fatal "could not be written"
// WARN is asserted rather than leaked to the suite output. getLogger is the only
// @psilink/core export replaced; everything else stays real.
const logCapture = vi.hoisted(() => ({
  warnings: [] as string[],
  infos: [] as string[],
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

import { parseDualSignedRecord, type DualSignedRecord } from "@psilink/core";

import {
  defaultReceiptPath,
  receiptPathFor,
  resolveReceiptOutput,
  writeDualSignedRecord,
} from "../../src/receiptFile";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-receipt-test-"));
  logCapture.warnings.length = 0;
  logCapture.infos.length = 0;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// A minimal schema-valid dual-signed record (the certificates self-verify; these
// are the checked-in signing-cert vectors' identities, reused for a valid shape).
const certA = {
  version: "psilink-signing-cert/v1" as const,
  algorithm: "ed25519" as const,
  identity: "Party A",
  publicKey: {
    kty: "OKP" as const,
    crv: "Ed25519" as const,
    x: "A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg",
  },
  signature:
    "8WKs03xb2bO9IsxziElnQeQ4v6--9DKTCRl5RyasydYD5THhQBBQwUD0nDHK7Lqm8NqgxczxhKX7JjJWlJiyAQ",
};
const record: DualSignedRecord = {
  version: "psilink-signed-receipt/v1",
  content: {
    termsHash: "dGVybXNIYXNo",
    initiatorToResponderPayload: "aTJyUGF5bG9hZA",
    responderToInitiatorPayload: "cjJpUGF5bG9hZA",
    binder: "YmluZGVy",
  },
  initiator: { certificate: certA, signature: "AAAA" },
  responder: {
    certificate: { ...certA, identity: "Party B" },
    signature: "AAAA",
  },
};

test("defaultReceiptPath is a filesystem-safe timestamped path in the cwd", () => {
  const p = defaultReceiptPath("2026-06-06T01:02:03.456Z");
  expect(p).toBe("./psilink-receipt-2026-06-06T01-02-03-456Z.json");
  expect(path.basename(p)).not.toContain(":");
});

test("resolveReceiptOutput keeps an explicit path, else selects the default", () => {
  expect(resolveReceiptOutput("/tmp/r.json")).toEqual({
    receiptFile: "/tmp/r.json",
  });
  // Whitespace-only and absent both fall back to the default.
  expect(resolveReceiptOutput("   ")).toEqual({ receiptFile: undefined });
  expect(resolveReceiptOutput()).toEqual({ receiptFile: undefined });
});

test("receiptPathFor uses an explicit path verbatim, else the timestamped default", () => {
  expect(
    receiptPathFor({ receiptFile: "/tmp/x.json" }, "2026-01-01T00:00:00Z"),
  ).toBe("/tmp/x.json");
  expect(
    receiptPathFor({ receiptFile: undefined }, "2026-01-01T00:00:00Z"),
  ).toBe("./psilink-receipt-2026-01-01T00-00-00Z.json");
});

test("writeDualSignedRecord writes a parseable owner-only file", () => {
  const target = path.join(dir, "receipt.json");
  writeDualSignedRecord(
    { receiptFile: target },
    record,
    "2026-01-01T00:00:00Z",
    "test",
  );
  expect(fs.existsSync(target)).toBe(true);
  // The written file round-trips through the parser.
  const parsed = parseDualSignedRecord(
    JSON.parse(fs.readFileSync(target, "utf8")),
  );
  expect(parsed).toEqual(record);
  expect(logCapture.warnings).toHaveLength(0);
  // On POSIX the file is owner-only (0600).
  if (process.platform !== "win32") {
    const mode = fs.statSync(target).mode & 0o777;
    expect(mode).toBe(0o600);
  }
});

test("writeDualSignedRecord warns rather than throws on a write failure", () => {
  // A path whose parent is a file, not a directory, makes the write fail; the
  // helper is non-fatal, so it warns and does not throw.
  const fileAsParent = path.join(dir, "afile");
  fs.writeFileSync(fileAsParent, "x");
  const target = path.join(fileAsParent, "receipt.json");
  expect(() =>
    writeDualSignedRecord(
      { receiptFile: target },
      record,
      "2026-01-01T00:00:00Z",
      "test",
    ),
  ).not.toThrow();
  expect(logCapture.warnings.length).toBeGreaterThan(0);
  expect(logCapture.warnings[0]).toMatch(/could not be written/);
});
