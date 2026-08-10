import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test, vi } from "vitest";

import {
  buildExchangeRecord,
  computeCertificateFingerprint,
  generateSigningIdentity,
  serializeDualSignedRecord,
  serializeExchangeRecord,
  serializeVerificationKeys,
  signReceiptContent,
  SIGNED_RECEIPT_VERSION,
  UsageError,
} from "@psilink/core";
import type {
  CommittedPayload,
  DualSignedRecord,
  DualSignedRecordVerificationReport,
  ExchangeRecordInputs,
  ReceiptContent,
  RecordVerificationReport,
  SignedReceiptPartyReport,
} from "@psilink/core";

import {
  deriveOurIdColumn,
  formatSignedRecordReport,
  formatVerificationReport,
  handler,
  pinnedFingerprintFromConfig,
  readExchangeRecordFile,
  readSignedRecordFile,
  readVerifiableArtifact,
  readVerificationKeysFile,
  toRetainedResult,
} from "../../src/commands/verifyReceipt";
import {
  argv,
  captureStdio,
  snapshotDiagnosticSinkAndLevel,
} from "../loggingTestSupport";

const tmp = () => mkdtempSync(join(tmpdir(), "verify-receipt-"));

// The handler installs a diagnostic sink and applies --log-level across every
// logger; both are restored between tests.
snapshotDiagnosticSinkAndLevel();

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

const receiptContent: ReceiptContent = {
  termsHash: "dGVybXNIYXNo",
  initiatorToResponderPayload: "aTJyUGF5bG9hZA",
  responderToInitiatorPayload: "cjJpUGF5bG9hZA",
  binder: "YmluZGVy",
};

/** A dual-signed record between Party A (initiator) and Party B (responder),
 * written to `receipt.json` in `dir`. Fixed keys keep the fixture reproducible. */
async function writeSignedRecord(
  dir: string,
  content: ReceiptContent = receiptContent,
): Promise<string> {
  const a = await generateSigningIdentity("Party A", {
    privateKey: {
      kty: "EC",
      crv: "P-256",
      x: "TGM247iz3ncbYTocehc0g0zWnBpPX_7LJAxjvA3bFXQ",
      y: "9olsXRTKROADd5HCMAMzJZpxuQHlJYV10QfluKxItCQ",
      d: "ERITFBUWFxgZGhscHR4fICEiIyQlJicoKSorLC0uLzA",
    },
  });
  const b = await generateSigningIdentity("Party B", {
    privateKey: {
      kty: "EC",
      crv: "P-256",
      x: "UUL0inyAyvR1RKQo_FfScqbGeK1ek__Lo2ZmqZY55R0",
      y: "0b22-1mBRFZ6Jlfo_zYZ-6oM0qBAwZqyKvkQxwWnV7o",
      d: "ZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXp7fH1-f4CBgoM",
    },
  });
  const record: DualSignedRecord = {
    version: SIGNED_RECEIPT_VERSION,
    content,
    initiator: {
      certificate: a.certificate,
      signature: await signReceiptContent(a, content, "initiator"),
    },
    responder: {
      certificate: b.certificate,
      signature: await signReceiptContent(b, content, "responder"),
    },
  };
  const path = join(dir, "receipt.json");
  writeFileSync(path, serializeDualSignedRecord(record));
  return path;
}

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
      "partner receipt signatures are not checked here",
    );
    expect(exitCode).toBe(0);
  });

  test("a supplied signed record points at the section that checks signatures", () => {
    const { lines } = formatVerificationReport(report("verified"), [], true);
    expect(lines.join("\n")).toContain(
      "partner receipt signatures: checked separately below",
    );
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

describe("formatSignedRecordReport", () => {
  const party = (
    role: SignedReceiptPartyReport["role"],
    overrides: Partial<SignedReceiptPartyReport> = {},
  ): SignedReceiptPartyReport => ({
    role,
    identity: `Party ${role === "initiator" ? "A" : "B"}`,
    fingerprint: "Zm9vZmluZ2VycHJpbnQ",
    certificateBinding: "verified",
    signature: "verified",
    fingerprintPin: role === "responder" ? "verified" : "not-pinned",
    assertedIdentity: "verified",
    ...overrides,
  });
  const report = (
    overrides: Partial<DualSignedRecordVerificationReport> = {},
  ): DualSignedRecordVerificationReport => ({
    outcome: "verified",
    initiator: party("initiator"),
    responder: party("responder"),
    termsHash: "verified",
    binder: "YmluZGVy",
    ...overrides,
  });

  test("a verified record names both parties and exits 0", () => {
    const { lines, exitCode } = formatSignedRecordReport(report());
    const out = lines.join("\n");
    expect(lines[0]).toMatch(/^SIGNED RECEIPT VERIFIED/);
    expect(out).toContain("initiator: Party A");
    expect(out).toContain("responder: Party B");
    expect(out).toContain("matches the pinned value");
    expect(exitCode).toBe(0);
  });

  test("a verified record claims only the slot the one pin anchored", () => {
    // What one pin produces: it matches the responder's certificate, and no
    // pinned value reaches the initiator's -- which whoever assembled the record
    // could have minted. The headline must say which slot it anchored and leave
    // the other one unclaimed, rather than contradict the per-slot line below it.
    const { lines } = formatSignedRecordReport(report());
    expect(lines[0]).toBe(
      "SIGNED RECEIPT VERIFIED: both signatures verify, and the pinned value " +
        "matches the responder's certificate. No pinned value authenticates " +
        "the initiator's certificate.",
    );
    const out = lines.join("\n");
    expect(out).toContain(
      "the initiator's certificate is not authenticated by any pinned value: " +
        "one pinned value reaches one certificate, so this record shows that " +
        "the pinned party signed it, not who the other signer is.",
    );
    expect(out).toContain("no pinned value supplied for this certificate");
  });

  test("the binder is reported as covered but not recomputed", () => {
    const { lines } = formatSignedRecordReport(report());
    expect(lines.join("\n")).toContain(
      "per-exchange binder YmluZGVy: covered by both signatures, not recomputed",
    );
  });

  test("an unpinned run is incomplete and says trust is not established", () => {
    const { lines, exitCode } = formatSignedRecordReport(
      report({
        outcome: "incomplete",
        initiator: party("initiator", { fingerprintPin: "not-pinned" }),
        responder: party("responder", { fingerprintPin: "not-pinned" }),
        termsHash: "not-checked",
      }),
    );
    expect(lines[0]).toMatch(/^SIGNED RECEIPT INCOMPLETE/);
    expect(lines.join("\n")).toContain(
      "certificate fingerprint trust not established (no pinned value supplied)",
    );
    expect(exitCode).toBe(0);
  });

  test("each failure class is named distinctly and exits 1", () => {
    const { lines, exitCode } = formatSignedRecordReport(
      report({
        outcome: "failed",
        initiator: party("initiator", {
          signature: "failed",
          certificateBinding: "failed",
        }),
        responder: party("responder", {
          fingerprintPin: "mismatch",
          assertedIdentity: "mismatch",
        }),
        termsHash: "mismatch",
      }),
    );
    const out = lines.join("\n");
    expect(lines[0]).toMatch(/^SIGNED RECEIPT VERIFICATION FAILED/);
    expect(out).toContain("receipt signature: DOES NOT VERIFY");
    expect(out).toContain("SELF-SIGNATURE DOES NOT VERIFY");
    expect(out).toContain("DOES NOT MATCH the pinned value");
    expect(out).toContain(
      "asserted identity: DOES NOT MATCH an identity expected",
    );
    expect(out).toContain("agreed-terms hash: DOES NOT MATCH");
    expect(exitCode).toBe(1);
  });

  test("record-carried text with control bytes is sanitized before display", () => {
    // The identity and the binder both come out of the record verbatim -- the
    // identity free text chosen by whoever minted the certificate, the binder a
    // value only the two parties could derive -- and an auditor may be handed
    // that record by anyone: both are neutralized at this display boundary
    // rather than echoed to the terminal raw.
    const esc = String.fromCharCode(0x1b);
    const { lines } = formatSignedRecordReport(
      report({
        initiator: party("initiator", { identity: `A${esc}[31m` }),
        binder: `YmluZGVy${esc}[2J`,
      }),
    );
    const out = lines.join("\n");
    expect(out).not.toContain(esc);
    expect(out).toContain("initiator: A");
    expect(out).toContain("per-exchange binder YmluZGVy");
  });
});

describe("reading a dual-signed record", () => {
  test("reads a dual-signed record back", async () => {
    const path = await writeSignedRecord(tmp());
    expect(readSignedRecordFile(path).version).toBe(SIGNED_RECEIPT_VERSION);
  });

  test("rejects an unrecognized signed-record version with a clear error", async () => {
    const dir = tmp();
    const path = await writeSignedRecord(dir);
    const bumped = {
      ...JSON.parse(readFileSync(path, "utf8")),
      version: "psilink-signed-receipt/v9",
    };
    const bumpedPath = join(dir, "bumped.json");
    writeFileSync(bumpedPath, JSON.stringify(bumped, null, 2));
    expect(() => readSignedRecordFile(bumpedPath)).toThrow(UsageError);
    expect(() => readSignedRecordFile(bumpedPath)).toThrow(
      /unrecognized version/,
    );
  });

  test("the positional dispatches on the artifact's version", async () => {
    const dir = tmp();
    const { record } = await buildExchangeRecord(baseInputs);
    const recordPath = join(dir, "rec.json");
    writeFileSync(recordPath, serializeExchangeRecord(record));
    expect(readVerifiableArtifact(recordPath).kind).toBe("record");
    expect(readVerifiableArtifact(await writeSignedRecord(dir)).kind).toBe(
      "signed",
    );
  });

  test("a version that is neither artifact is rejected naming both", async () => {
    const dir = tmp();
    const path = join(dir, "other.json");
    writeFileSync(path, JSON.stringify({ version: "something-else/v1" }));
    expect(() => readVerifiableArtifact(path)).toThrow(UsageError);
    expect(() => readVerifiableArtifact(path)).toThrow(
      /recognizes psilink-exchange-record\/v1 .* and psilink-signed-receipt\/v2/,
    );
  });
});

describe("pinnedFingerprintFromConfig", () => {
  const writeConfig = (dir: string, body: string): string => {
    const path = join(dir, "psilink.yaml");
    writeFileSync(path, body);
    return path;
  };

  test("reads signing.partner_fingerprint", async () => {
    const identity = await generateSigningIdentity("Party B");
    const fingerprint = await computeCertificateFingerprint(
      identity.certificate,
    );
    const path = writeConfig(
      tmp(),
      `signing:\n  mode: certificate\n  partner_fingerprint: ${fingerprint}\n`,
    );
    expect(pinnedFingerprintFromConfig(path, true)).toBe(fingerprint);
  });

  test("no signing block and no config named each yield no pin", () => {
    const dir = tmp();
    expect(
      pinnedFingerprintFromConfig(writeConfig(dir, "linkage_terms:\n"), true),
    ).toBeUndefined();
    expect(pinnedFingerprintFromConfig(undefined, false)).toBeUndefined();
  });

  test("a config path named on the command line must exist", () => {
    // Mapping the missing file to "no pin" would verify a typo'd path unpinned
    // and report the fingerprint trust as merely not established.
    const path = join(tmp(), "absent.yaml");
    expect(() => pinnedFingerprintFromConfig(path, true)).toThrow(UsageError);
    expect(() => pinnedFingerprintFromConfig(path, true)).toThrow(
      /absent\.yaml does not exist/,
    );
  });

  test("a defaulted config path that does not exist yields no pin", () => {
    expect(
      pinnedFingerprintFromConfig(join(tmp(), "absent.yaml"), false),
    ).toBeUndefined();
  });

  test("a malformed pin is a usage error, not a silent mismatch later", () => {
    // A pin that cannot be a fingerprint would otherwise be indistinguishable
    // from a partner whose certificate does not match.
    const path = writeConfig(
      tmp(),
      "signing:\n  mode: certificate\n  partner_fingerprint: too-short\n",
    );
    expect(() => pinnedFingerprintFromConfig(path, true)).toThrow(UsageError);
    expect(() => pinnedFingerprintFromConfig(path, true)).toThrow(
      /not a certificate fingerprint/,
    );
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

describe("handler", () => {
  // Drive the command as yargs would: process.exit is stubbed so a usage error
  // does not end the worker, the verdict is read off console.log, and the error
  // line off the stderr sink the handler's logging installs.
  async function runVerify(options: Record<string, unknown>): Promise<{
    stdout: string;
    stderr: string;
    exits: unknown[];
    exitCode: typeof process.exitCode;
  }> {
    const { stderrWrites, restore } = captureStdio();
    const stdoutLines: string[] = [];
    const logSpy = vi
      .spyOn(console, "log")
      .mockImplementation((...args: unknown[]) => {
        stdoutLines.push(args.map((arg) => String(arg)).join(" "));
      });
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await handler(argv({ "log-level": "error", ...options }));
      // Collected before the finally block restores the spies, which clears the
      // calls they recorded.
      return {
        stdout: stdoutLines.join("\n"),
        stderr: stderrWrites.join(""),
        exits: exit.mock.calls.map((call) => call[0]),
        exitCode: process.exitCode,
      };
    } finally {
      process.exitCode = previousExitCode;
      exit.mockRestore();
      logSpy.mockRestore();
      restore();
    }
  }

  /** Both artifacts of one exchange -- the record with its keys file beside it,
   * and the dual-signed record carrying that exchange's agreed-terms hash -- plus
   * the responder's fingerprint, the pin a verifier holds for its partner. */
  async function exchangeArtifacts(): Promise<{
    recordPath: string;
    signedPath: string;
    pin: string;
  }> {
    const dir = tmp();
    const { record, keys } = await buildExchangeRecord(baseInputs);
    const recordPath = join(dir, "rec.json");
    writeFileSync(recordPath, serializeExchangeRecord(record));
    writeFileSync(join(dir, "rec.keys.json"), serializeVerificationKeys(keys));
    const signedPath = await writeSignedRecord(dir, {
      ...receiptContent,
      termsHash: record.termsHash,
    });
    const pin = await computeCertificateFingerprint(
      readSignedRecordFile(signedPath).responder.certificate,
    );
    return { recordPath, signedPath, pin };
  }

  test("a dual-signed record positional refuses --signed-record", async () => {
    const { signedPath } = await exchangeArtifacts();
    const { stdout, stderr, exits } = await runVerify({
      record: signedPath,
      "signed-record": signedPath,
    });
    expect(exits).toEqual([64]);
    expect(stderr).toContain("already a dual-signed record");
    expect(stdout).toBe("");
  });

  const exchangeRecordOnlyOptions: Array<[string, Record<string, unknown>]> = [
    [
      "an input and result file",
      { "input-file": "input.csv", "result-file": "result.csv" },
    ],
    ["--keys", { keys: "rec.keys.json" }],
  ];
  test.each(exchangeRecordOnlyOptions)(
    "a dual-signed record positional refuses %s, which apply to the exchange record",
    async (_label, extra) => {
      const { signedPath } = await exchangeArtifacts();
      const { stdout, stderr, exits } = await runVerify({
        record: signedPath,
        ...extra,
      });
      expect(exits).toEqual([64]);
      expect(stderr).toContain("which commits to no data");
      expect(stdout).toBe("");
    },
  );

  test("--partner-fingerprint with no dual-signed record named is refused", async () => {
    const { recordPath, pin } = await exchangeArtifacts();
    const { stdout, stderr, exits } = await runVerify({
      record: recordPath,
      "partner-fingerprint": pin,
    });
    expect(exits).toEqual([64]);
    expect(stderr).toContain("no dual-signed record was named");
    // The record on its own would have verified and printed a verdict, so an
    // empty stdout is what shows the pin was refused rather than ignored.
    expect(stdout).toBe("");
  });

  test("a --config-file that does not exist is refused, not verified unpinned", async () => {
    const { signedPath } = await exchangeArtifacts();
    const { stdout, stderr, exits } = await runVerify({
      record: signedPath,
      "config-file": join(tmp(), "typo.yaml"),
    });
    expect(exits).toEqual([64]);
    expect(stderr).toContain("does not exist");
    // The run would otherwise have printed an INCOMPLETE verdict reporting the
    // fingerprint trust as not established, which reads as an auditor's run
    // rather than as a mistyped path.
    expect(stdout).toBe("");
  });

  test("an exchange-record positional verifies the record alone", async () => {
    const { recordPath } = await exchangeArtifacts();
    const { stdout, exits, exitCode } = await runVerify({ record: recordPath });
    expect(exits).toEqual([]);
    expect(stdout).toMatch(/^INCOMPLETE/);
    expect(stdout).toContain("commitment localPayloadSent:");
    expect(stdout).toContain("partner receipt signatures are not checked here");
    expect(stdout).not.toContain("SIGNED RECEIPT");
    expect(exitCode).toBe(0);
  });

  test("a dual-signed record positional verifies the signatures alone", async () => {
    const { signedPath, pin } = await exchangeArtifacts();
    const { stdout, exits, exitCode } = await runVerify({
      record: signedPath,
      "partner-fingerprint": pin,
    });
    expect(exits).toEqual([]);
    expect(stdout).toMatch(/^SIGNED RECEIPT/);
    expect(stdout).toContain("matches the pinned value");
    // No exchange record was named, so no commitment is opened or reported.
    expect(stdout).not.toContain("commitment");
    expect(exitCode).toBe(0);
  });

  test("an exchange record with --signed-record verifies both artifacts", async () => {
    const { recordPath, signedPath, pin } = await exchangeArtifacts();
    const { stdout, exits, exitCode } = await runVerify({
      record: recordPath,
      "signed-record": signedPath,
      "partner-fingerprint": pin,
    });
    expect(exits).toEqual([]);
    expect(stdout).toContain(
      "partner receipt signatures: checked separately below",
    );
    // Naming the exchange record is what supplies the identities and the
    // agreed-terms hash the signature checks are anchored to, so the signed half
    // reaches verified rather than incomplete.
    expect(stdout).toContain("SIGNED RECEIPT VERIFIED");
    expect(exitCode).toBe(0);
  });
});
