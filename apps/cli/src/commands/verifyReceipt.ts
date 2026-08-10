import type { Argv, Arguments } from "yargs";
import fs from "node:fs";

import {
  computeTermsHash,
  deriveOurIdColumn,
  EXCHANGE_KEYS_VERSION,
  EXCHANGE_RECORD_VERSION,
  FINGERPRINT_REGEX,
  loadCSVFile,
  parseDualSignedRecord,
  parseExchangeRecord,
  parseVerificationKeys,
  reconstructCommittedData,
  recordedVersionMatches,
  sanitizeForDisplay,
  SIGNED_RECEIPT_VERSION,
  toRetainedResult,
  UsageError,
  verifyDualSignedRecord,
  verifyExchangeRecord,
} from "@psilink/core";
import type {
  AssertedIdentityStatus,
  CertificateBindingStatus,
  CommitmentStatus,
  DualSignedRecord,
  DualSignedRecordVerificationInputs,
  DualSignedRecordVerificationReport,
  ExchangeRecord,
  FingerprintPinStatus,
  LinkageTerms,
  ReceiptSignatureStatus,
  RecordVerificationReport,
  SignedReceiptPartyReport,
  TermsHashStatus,
  VerificationKeys,
} from "@psilink/core";

import { loadConfigLinkageSource } from "../config";
import { expandTilde } from "../fileUtils";
import { keysPathFor } from "../recordFile";
import { parseSensitiveJson, parseSensitiveYaml } from "../sensitiveFile";
import {
  configureLogging,
  exitWithError,
  logLevelFlag,
  openInputSource,
  parseOrExit,
  singleValue,
} from "../util/cli";

// `psilink verify-receipt` reports whether a stored exchange artifact holds up. It
// is READ-ONLY -- it never mutates or re-signs an artifact -- and it verifies the
// two artifacts an exchange produces, separately or together:
//
//   - The self-attested exchange record (UNSIGNED): internal consistency. Its
//     commitments open against the holder's re-supplied data, and (when both
//     parties' terms are supplied) its agreed-terms hash re-derives. This proves
//     nothing about the partner.
//   - The dual-signed record (SIGNED): evidence against the partner. Each party's
//     receipt signature is checked against the certificate the record carries, each
//     certificate's identity binding is checked, and each fingerprint is checked
//     against a pinned value when the verifier holds one.
//
// The positional accepts either artifact, dispatched on its format `version`; the
// dual-signed record can also be named with --signed-record to verify both
// artifacts of one exchange in a single run, which is what lets the record's terms
// hash and party identities be carried into the signature checks.
//
// The verification keys hold only salts, so the committed data is RE-SUPPLIED from
// the holder's retained input and result and re-canonicalized (see
// reconstructCommittedData). With no input/result the command still runs -- the
// third-party-auditor case: it checks structure and version and reports each
// commitment as not-opened rather than failing. The same case on the signed side is
// a missing fingerprint pin: signatures and identity bindings are still checked and
// the fingerprint trust is reported as not established.

export function builder(cmd: Argv): Argv {
  return cmd
    .usage(
      "Usage: $0 verify-receipt <record> [input-file] [result-file] [options]",
    )
    .positional("record", {
      type: "string",
      describe:
        "the stored artifact to verify: an exchange record " +
        "(psilink-record-*.json) or a dual-signed record " +
        "(psilink-receipt-*.json)",
    })
    .positional("input-file", {
      type: "string",
      describe:
        "the input CSV this party contributed (or - for stdin); needed to open " +
        "the sent-payload and pairing commitments",
    })
    .positional("result-file", {
      type: "string",
      describe:
        "the result file this party retained (a path, not - for stdin); " +
        "needed to open the received-payload and pairing commitments",
    })
    .option("keys", {
      type: "string",
      describe:
        "the verification-keys file (default: the record path with a " +
        ".keys.json suffix)",
    })
    .option("signed-record", {
      type: "string",
      describe:
        "the dual-signed record for this exchange (psilink-receipt-*.json); " +
        "checks both parties' signatures and certificates alongside the record",
    })
    .option("partner-fingerprint", {
      type: "string",
      describe:
        "the partner's pinned certificate fingerprint, for the signed-record " +
        "check; overrides signing.partner_fingerprint in --config-file",
    })
    .option("config-file", {
      type: "string",
      describe:
        "this party's exchange config, for its linkage terms (with " +
        "--partner-terms, checks the agreed-terms hash). Not auto-loaded.",
    })
    .option("partner-terms", {
      type: "string",
      describe:
        "the partner's linkage terms (config or exported terms), for the " +
        "agreed-terms hash check; the partner's terms are not retained by default",
    })
    .option("log-level", {
      type: "string",
      describe: "silent | error | warn | info | debug | trace; default=info",
    })
    .option("log-file", {
      type: "string",
      describe:
        "append all log output to this file instead of the terminal; the " +
        "parent directory must already exist",
    });
}

// --- File readers ------------------------------------------------------------

function readTextFile(pathValue: string, kind: string): string {
  try {
    return fs.readFileSync(expandTilde(pathValue), "utf8");
  } catch (err: unknown) {
    throw new UsageError(
      `${kind} file ${pathValue} could not be read: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

// Reject an unrecognized version with a clear, specific message BEFORE the schema
// parse -- so a future-format or hand-edited file is not mis-reported as a generic
// shape error. The version literal is also enforced by the schema; this only makes
// the failure legible.
function assertRecognizedVersion(
  raw: unknown,
  expected: string,
  pathValue: string,
  kind: string,
): void {
  if (!recordedVersionMatches(raw, expected)) {
    const version =
      raw !== null && typeof raw === "object"
        ? (raw as Record<string, unknown>)["version"]
        : undefined;
    throw new UsageError(
      `${kind} file ${pathValue} has an unrecognized version ` +
        `(${typeof version === "string" ? version : "missing"}); this build ` +
        `recognizes ${expected}`,
    );
  }
}

// parseSensitiveJson routes through the bounded-JSON chokepoint (so an oversized
// hostile artifact is refused before parse) and reports path-only on a syntax
// error (so no source bytes leak).
function readJsonFile(pathValue: string, kind: string): unknown {
  return parseSensitiveJson(
    readTextFile(pathValue, kind),
    `${kind} file ${pathValue}`,
  );
}

function parseRecord(raw: unknown, pathValue: string): ExchangeRecord {
  try {
    return parseExchangeRecord(raw);
  } catch (err) {
    throw new UsageError(
      `record file ${pathValue} is not a valid exchange record: ` +
        firstIssue(err),
    );
  }
}

function parseSignedRecord(raw: unknown, pathValue: string): DualSignedRecord {
  try {
    // The schema bounds every partner-controlled field (identity text, and each
    // base64url certificate/signature value), so an oversized hostile bundle is
    // refused here rather than at the first signature check.
    return parseDualSignedRecord(raw);
  } catch (err) {
    throw new UsageError(
      `signed-record file ${pathValue} is not a valid dual-signed record: ` +
        firstIssue(err),
    );
  }
}

/** @internal exported for testing */
export function readExchangeRecordFile(pathValue: string): ExchangeRecord {
  const raw = readJsonFile(pathValue, "record");
  assertRecognizedVersion(raw, EXCHANGE_RECORD_VERSION, pathValue, "record");
  return parseRecord(raw, pathValue);
}

/** @internal exported for testing */
export function readSignedRecordFile(pathValue: string): DualSignedRecord {
  const raw = readJsonFile(pathValue, "signed-record");
  assertRecognizedVersion(
    raw,
    SIGNED_RECEIPT_VERSION,
    pathValue,
    "signed-record",
  );
  return parseSignedRecord(raw, pathValue);
}

/** The artifact named by the positional, which accepts either of the two files an
 * exchange produces. @internal exported for testing */
export type VerifiableArtifact =
  | { kind: "record"; record: ExchangeRecord }
  | { kind: "signed"; signed: DualSignedRecord };

/**
 * Read the positional artifact, dispatching on its format `version`: the
 * self-attested exchange record, or the dual-signed record an auditor may hold on
 * its own. Any other version is refused with both recognized values named, rather
 * than parsed as whichever shape it happens to fit. @internal exported for testing
 */
export function readVerifiableArtifact(pathValue: string): VerifiableArtifact {
  const raw = readJsonFile(pathValue, "record");
  if (recordedVersionMatches(raw, EXCHANGE_RECORD_VERSION))
    return { kind: "record", record: parseRecord(raw, pathValue) };
  if (recordedVersionMatches(raw, SIGNED_RECEIPT_VERSION))
    return { kind: "signed", signed: parseSignedRecord(raw, pathValue) };
  const version =
    raw !== null && typeof raw === "object"
      ? (raw as Record<string, unknown>)["version"]
      : undefined;
  throw new UsageError(
    `record file ${pathValue} has an unrecognized version ` +
      `(${typeof version === "string" ? version : "missing"}); this build ` +
      `recognizes ${EXCHANGE_RECORD_VERSION} (an exchange record) and ` +
      `${SIGNED_RECEIPT_VERSION} (a dual-signed record)`,
  );
}

/** @internal exported for testing */
export function readVerificationKeysFile(pathValue: string): VerificationKeys {
  const raw = readJsonFile(pathValue, "verification-keys");
  assertRecognizedVersion(
    raw,
    EXCHANGE_KEYS_VERSION,
    pathValue,
    "verification-keys",
  );
  try {
    return parseVerificationKeys(raw);
  } catch (err) {
    throw new UsageError(
      `verification-keys file ${pathValue} is not valid: ` + firstIssue(err),
    );
  }
}

function firstIssue(err: unknown): string {
  const issues = (
    err as { issues?: Array<{ path?: unknown[]; message: string }> }
  ).issues;
  if (Array.isArray(issues) && issues.length > 0) {
    const issue = issues[0];
    const at =
      Array.isArray(issue.path) && issue.path.length > 0
        ? `${issue.path.join(".")}: `
        : "";
    return `${at}${issue.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

// toRetainedResult and deriveOurIdColumn are browser-safe shaping helpers that
// live in @psilink/core; re-exported here so this command and its tests keep a
// single import site.
export { deriveOurIdColumn, toRetainedResult };

// --- Report formatting -------------------------------------------------------

const COMMITMENT_WORD: Record<CommitmentStatus, string> = {
  verified: "opened and matches",
  mismatch: "DOES NOT MATCH",
  "not-supplied": "not opened (no data re-supplied)",
  unopenable:
    "cannot be opened (no salt in the keys file; likely a wrong or drifted " +
    "keys file, not a problem with the record)",
};
const TERMS_WORD: Record<TermsHashStatus, string> = {
  verified: "re-derives and matches",
  mismatch: "DOES NOT MATCH",
  "not-checked": "not checked (pass --config-file and --partner-terms)",
};

/** Render the unsigned record's verification report to output lines and an exit
 * code (0 unless a check definitively failed). @internal exported for testing */
export function formatVerificationReport(
  report: RecordVerificationReport,
  warnings: string[],
  signedRecordSupplied = false,
): { lines: string[]; exitCode: number } {
  const lines: string[] = [];
  if (report.outcome === "failed")
    lines.push(
      "VERIFICATION FAILED: a check did not match -- the record may have been " +
        "altered, or a re-supplied input/result/terms does not match this exchange.",
    );
  else if (report.outcome === "incomplete")
    lines.push(
      "INCOMPLETE: nothing contradicted the record, but not everything could " +
        "be checked (see below).",
    );
  else lines.push("VERIFIED: the record is internally consistent.");

  for (const [name, status] of Object.entries(report.commitments) as Array<
    [string, CommitmentStatus]
  >)
    lines.push(`  commitment ${name}: ${COMMITMENT_WORD[status]}`);
  lines.push(`  agreed-terms hash: ${TERMS_WORD[report.termsHash]}`);
  // A reconstruction warning interpolates a column name drawn from the supplied
  // files, so route it through the display-boundary sanitizer (as every sibling
  // command does for partner- or file-controlled text) before it reaches the
  // terminal -- the commitment/terms lines above are fixed strings and need none.
  for (const warning of warnings)
    lines.push(`  note: ${sanitizeForDisplay(warning)}`);
  // The record is self-attested, so this section says nothing about the partner.
  // Name where the evidence against the partner is, or was not supplied.
  lines.push(
    signedRecordSupplied
      ? "  partner receipt signatures: checked separately below, against the " +
          "dual-signed record."
      : "  partner receipt signatures are not checked here; this record is " +
          "self-attested. Pass --signed-record with the exchange's dual-signed " +
          "record (psilink-receipt-*.json) to check them.",
  );
  return { lines, exitCode: report.outcome === "failed" ? 1 : 0 };
}

const CERTIFICATE_BINDING_WORD: Record<CertificateBindingStatus, string> = {
  verified: "self-signature verifies (this identity is bound to this key)",
  failed:
    "SELF-SIGNATURE DOES NOT VERIFY (the certificate does not bind this " +
    "identity to this key)",
};
const RECEIPT_SIGNATURE_WORD: Record<ReceiptSignatureStatus, string> = {
  verified: "verifies over this receipt's content, bound to this party",
  failed: "DOES NOT VERIFY",
};
const FINGERPRINT_PIN_WORD: Record<FingerprintPinStatus, string> = {
  verified: "matches the pinned value",
  mismatch: "DOES NOT MATCH the pinned value",
  "not-pinned": "no pinned value supplied for this certificate",
};
const ASSERTED_IDENTITY_WORD: Record<AssertedIdentityStatus, string> = {
  verified: "matches an identity expected for this exchange",
  mismatch: "DOES NOT MATCH an identity expected for this exchange",
  "not-checked":
    "not checked (no expected identities; pass the exchange record, or " +
    "--config-file with --partner-terms)",
};
const SIGNED_TERMS_WORD: Record<TermsHashStatus, string> = {
  verified: "matches the terms this exchange agreed",
  mismatch: "DOES NOT MATCH the terms this exchange agreed",
  "not-checked":
    "not checked (pass the exchange record, or --config-file with " +
    "--partner-terms)",
};

function signedPartyLines(party: SignedReceiptPartyReport): string[] {
  return [
    // The identity is free text the certificate's holder chose, so it is escaped
    // at this display sink; the fingerprint is base64url by schema.
    `  ${party.role}: ${sanitizeForDisplay(party.identity)}`,
    `    certificate fingerprint ${party.fingerprint}: ` +
      FINGERPRINT_PIN_WORD[party.fingerprintPin],
    `    certificate identity binding: ` +
      CERTIFICATE_BINDING_WORD[party.certificateBinding],
    `    receipt signature: ${RECEIPT_SIGNATURE_WORD[party.signature]}`,
    `    asserted identity: ${ASSERTED_IDENTITY_WORD[party.assertedIdentity]}`,
  ];
}

/** Render the dual-signed record's verification report to output lines and an exit
 * code (0 unless a check definitively failed). @internal exported for testing */
export function formatSignedRecordReport(
  report: DualSignedRecordVerificationReport,
): { lines: string[]; exitCode: number } {
  const lines: string[] = [];
  if (report.outcome === "failed")
    lines.push(
      "SIGNED RECEIPT VERIFICATION FAILED: a check did not match -- the " +
        "dual-signed record may have been altered, or it is not the exchange " +
        "or the partner it is being checked against.",
    );
  else if (report.outcome === "incomplete")
    lines.push(
      "SIGNED RECEIPT INCOMPLETE: nothing contradicted the dual-signed record, " +
        "but not everything could be checked (see below).",
    );
  else
    lines.push(
      "SIGNED RECEIPT VERIFIED: both parties signed this exchange, and the " +
        "pinned certificate is the partner's.",
    );

  lines.push(...signedPartyLines(report.initiator));
  lines.push(...signedPartyLines(report.responder));
  lines.push(`  agreed-terms hash: ${SIGNED_TERMS_WORD[report.termsHash]}`);
  // The binder is derived from the exchange's session key, which only the two
  // parties ever held and neither retains, so it is reported rather than checked:
  // a verifier confirms the signers signed a receipt carrying this value, and only
  // the two parties -- during the live exchange, where each derives it
  // independently -- can tell that a different exchange's binder was substituted.
  lines.push(
    `  per-exchange binder ${report.binder}: covered by both signatures, not ` +
      "recomputed (deriving it needs the exchange session key, which only the " +
      "two parties held).",
  );
  if (
    report.initiator.fingerprintPin === "not-pinned" &&
    report.responder.fingerprintPin === "not-pinned"
  )
    lines.push(
      "  certificate fingerprint trust not established (no pinned value " +
        "supplied): the signatures verify against the certificates carried in " +
        "the record, but nothing ties those certificates to the partner you " +
        "know. Pass --partner-fingerprint, or --config-file with " +
        "signing.partner_fingerprint set.",
    );
  return { lines, exitCode: report.outcome === "failed" ? 1 : 0 };
}

// --- Handler -----------------------------------------------------------------

function localTermsFrom(
  configFile: string | undefined,
): LinkageTerms | undefined {
  if (configFile === undefined) return undefined;
  return loadConfigLinkageSource(expandTilde(configFile))?.linkageTerms;
}

/**
 * Read `signing.partner_fingerprint` out of an exchange config, so a party
 * re-verifying its own exchange gets the pin it already configured without
 * restating it on the command line. Only that one field is read (as
 * `psilink fingerprint` reads `signing.identity_file`), so an unrelated block that
 * this command never uses cannot fail a verification run. A malformed value is a
 * usage error naming the config: a pin that cannot be a fingerprint would
 * otherwise be indistinguishable from a partner whose certificate does not match.
 * @internal exported for testing
 */
export function pinnedFingerprintFromConfig(
  configFile: string | undefined,
): string | undefined {
  if (configFile === undefined) return undefined;
  const target = expandTilde(configFile);
  let text: string;
  try {
    text = fs.readFileSync(target, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new UsageError(
      `config file ${configFile} could not be read: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  // A YAML parse can echo source bytes (an inline connection credential), so it
  // routes through the sensitive-file chokepoint, which reports path-only.
  const raw = parseSensitiveYaml(text, `config file ${configFile}`);
  const root = (raw ?? {}) as Record<string, unknown>;
  const signing = (root["signing"] ?? {}) as Record<string, unknown>;
  const pinned =
    signing["partner_fingerprint"] ?? signing["partnerFingerprint"];
  if (pinned === undefined) return undefined;
  if (typeof pinned !== "string" || !FINGERPRINT_REGEX.test(pinned))
    throw new UsageError(
      `config file ${configFile} has a signing.partner_fingerprint that is ` +
        "not a certificate fingerprint (an unpadded base64url SHA-256 digest, " +
        "43 characters); obtain it from your partner via 'psilink fingerprint'",
    );
  return pinned;
}

/**
 * What the signature checks are anchored to besides the fingerprint pin: the two
 * parties' identities (which each certificate must authorize) and the agreed-terms
 * hash the receipt content carries. The exchange record holds both already, so a
 * party verifying its own exchange supplies them by naming the record; an auditor
 * without the record restates them from both parties' terms instead. With neither,
 * both checks are reported as not performed rather than assumed.
 *
 * The identities are unordered: no artifact outside the dual-signed record records
 * which party held which handshake role, and the per-signer signature binding is
 * what fixes a certificate to its role.
 */
async function signedRecordExpectations(
  record: ExchangeRecord | undefined,
  localTerms: LinkageTerms | undefined,
  partnerTerms: LinkageTerms | undefined,
): Promise<
  Pick<
    DualSignedRecordVerificationInputs,
    "expectedIdentities" | "expectedTermsHash"
  >
> {
  if (record !== undefined)
    return {
      expectedIdentities: [record.localIdentity, record.partnerIdentity],
      expectedTermsHash: record.termsHash,
    };
  if (localTerms === undefined || partnerTerms === undefined) return {};
  return {
    expectedIdentities: [localTerms.identity, partnerTerms.identity],
    expectedTermsHash: await computeTermsHash(localTerms, partnerTerms),
  };
}

/** The pinned partner fingerprint for the signed-record check: the explicit flag
 * wins over the config, so a third party given a fingerprint out-of-band can
 * verify against a config it does not have (or one written for another partner). */
function resolvePinnedFingerprint(
  flagValue: string | undefined,
  configFile: string | undefined,
): string | undefined {
  if (flagValue === undefined) return pinnedFingerprintFromConfig(configFile);
  if (!FINGERPRINT_REGEX.test(flagValue))
    throw new UsageError(
      "--partner-fingerprint must be a certificate fingerprint (an unpadded " +
        "base64url SHA-256 digest, 43 characters); obtain it from your partner " +
        "via 'psilink fingerprint' and a trusted out-of-band channel",
    );
  return flagValue;
}

export async function handler(argv: Arguments): Promise<void> {
  const logLevel = parseOrExit(() => logLevelFlag(argv));
  const { log, close: closeLogging } = parseOrExit(() =>
    configureLogging({
      logLevel,
      logFile: singleValue(argv, "log-file") as string | undefined,
      name: "verify-receipt",
    }),
  );

  try {
    const recordPath = singleValue(argv, "record") as string | undefined;
    if (recordPath === undefined || recordPath.length === 0)
      throw new UsageError("a record file to verify is required");
    const inputFile = singleValue(argv, "input-file") as string | undefined;
    const resultFile = singleValue(argv, "result-file") as string | undefined;
    const keysArg = singleValue(argv, "keys") as string | undefined;
    const configFile = singleValue(argv, "config-file") as string | undefined;
    const partnerTermsFile = singleValue(argv, "partner-terms") as
      string | undefined;
    const signedRecordArg = singleValue(argv, "signed-record") as
      string | undefined;
    const partnerFingerprintArg = singleValue(argv, "partner-fingerprint") as
      string | undefined;

    if ((inputFile === undefined) !== (resultFile === undefined))
      throw new UsageError(
        "supply both an input file and a result file to open the commitments, " +
          "or neither (a structure-only check)",
      );

    const artifact = readVerifiableArtifact(recordPath);
    // A dual-signed record carries no commitments and no terms, so the options
    // that only apply to an exchange record are refused rather than ignored.
    if (artifact.kind === "signed") {
      if (signedRecordArg !== undefined)
        throw new UsageError(
          `${recordPath} is already a dual-signed record, so --signed-record ` +
            "has nothing to add; name the exchange record instead to verify both",
        );
      if (inputFile !== undefined || keysArg !== undefined)
        throw new UsageError(
          `${recordPath} is a dual-signed record, which commits to no data: ` +
            "an input file, a result file, and --keys apply to the exchange " +
            "record, which must be named as the positional to be verified",
        );
    }

    const localTerms = localTermsFrom(configFile);
    const partnerTerms = localTermsFrom(partnerTermsFile);
    const signedRecord =
      artifact.kind === "signed"
        ? artifact.signed
        : signedRecordArg !== undefined
          ? readSignedRecordFile(signedRecordArg)
          : undefined;

    if (signedRecord === undefined && partnerFingerprintArg !== undefined)
      throw new UsageError(
        "--partner-fingerprint pins the certificate in a dual-signed record, " +
          "and no dual-signed record was named; pass --signed-record, or name " +
          "the dual-signed record as the artifact to verify",
      );

    const lines: string[] = [];
    let exitCode = 0;

    if (artifact.kind === "record") {
      const record = artifact.record;
      const keysPath = keysArg ?? keysPathFor(recordPath);
      const keys = readVerificationKeysFile(keysPath);

      const warnings: string[] = [];
      let data: Awaited<ReturnType<typeof reconstructCommittedData>>["data"] =
        {};
      if (inputFile !== undefined && resultFile !== undefined) {
        const inputParse = await loadCSVFile(
          openInputSource(inputFile, { allowStdin: true }),
        );
        const resultParse = await loadCSVFile(openInputSource(resultFile));
        const result = toRetainedResult(resultParse);
        const ourIdColumn = deriveOurIdColumn(
          result.headers,
          new Set(inputParse.meta.fields ?? []),
        );
        const reconstructed = reconstructCommittedData({
          record,
          inputRows: inputParse.data,
          result,
          ourIdColumn,
        });
        data = reconstructed.data;
        warnings.push(...reconstructed.warnings);
      }

      const report = await verifyExchangeRecord(record, keys, {
        data,
        localTerms,
        partnerTerms,
      });
      const rendered = formatVerificationReport(
        report,
        warnings,
        signedRecord !== undefined,
      );
      lines.push(...rendered.lines);
      exitCode = Math.max(exitCode, rendered.exitCode);
    }

    if (signedRecord !== undefined) {
      const rendered = formatSignedRecordReport(
        await verifyDualSignedRecord(signedRecord, {
          pinnedFingerprint: resolvePinnedFingerprint(
            partnerFingerprintArg,
            configFile,
          ),
          ...(await signedRecordExpectations(
            artifact.kind === "record" ? artifact.record : undefined,
            localTerms,
            partnerTerms,
          )),
        }),
      );
      lines.push(...rendered.lines);
      exitCode = Math.max(exitCode, rendered.exitCode);
    }

    // The verdict is the command's result, so it goes to stdout; the log level
    // still governs any diagnostics the readers above emit.
    for (const line of lines) console.log(line);
    process.exitCode = exitCode;
  } catch (err) {
    exitWithError(
      log,
      err,
      err instanceof UsageError
        ? 64
        : ((err as { exitCode?: number }).exitCode ?? 69),
    );
  } finally {
    closeLogging();
  }
}
