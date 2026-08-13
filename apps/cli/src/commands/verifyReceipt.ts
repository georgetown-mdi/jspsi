import type { Argv, Arguments } from "yargs";
import fs from "node:fs";

import {
  computeCertificateFingerprint,
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
  sanitizeErrorForDisplay,
  sanitizeForDisplay,
  SIGNED_RECEIPT_VERSION,
  toRetainedResult,
  UsageError,
  verifyDualSignedRecord,
  verifyExchangeRecord,
} from "@psilink/core";
import type {
  AssertedIdentityStatus,
  CertificateAnchorStatus,
  CertificateBindingStatus,
  CommitmentStatus,
  DualSignedRecord,
  DualSignedRecordVerificationInputs,
  DualSignedRecordVerificationReport,
  ExchangeRecord,
  LinkageTerms,
  LocalIdentityAnchor,
  LocalIdentitySource,
  ReceiptSignatureStatus,
  RecordVerificationReport,
  SignedReceiptPartyReport,
  SigningIdentity,
  TermsHashStatus,
  VerificationKeys,
} from "@psilink/core";

import { readConfigLinkageSource } from "../config";
import { expandTilde } from "../fileUtils";
import { keysPathFor } from "../recordFile";
import { parseSensitiveJson, parseSensitiveYaml } from "../sensitiveFile";
import {
  defaultSigningIdentityPath,
  loadSigningIdentity,
} from "../signingIdentityFile";
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
//     certificate's identity binding is checked, and each certificate is checked
//     against what anchors it outside the record -- a fingerprint the verifier
//     pinned, or the verifier's own signing identity.
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
// an unanchored certificate: signatures and identity bindings are still checked,
// the verdict names the slot nothing outside the record reaches, and it is graded
// short of verified rather than failed.

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
        "check; overrides signing.partner_fingerprint in --config-file. Repeat " +
        "it to pin both signers when you were not a party to the exchange -- a " +
        "verified verdict needs both certificates anchored",
    })
    .option("identity-file", {
      type: "string",
      describe:
        "path to your signing identity file, whose certificate anchors your " +
        "own slot in the signed record; overrides signing.identity_file in " +
        "--config-file (default: ~/.psilink/signing-identity.json)",
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
/**
 * What this run supplied, so a "not checked" line names an input that is still
 * missing rather than one already on the command line, and the note explaining a
 * config that carries no terms sits next to the line it explains.
 * @internal exported for testing
 */
export interface SuppliedVerificationInputs {
  /** The `--config-file` path, when one was named. */
  configFile?: string;
  /** Whether that config defined `linkage_terms`. */
  localTerms: boolean;
  /** Whether `--partner-terms` was supplied. */
  partnerTerms: boolean;
  /** How this party's signing identity was found, when one was. */
  localIdentity?: LocalIdentitySource;
  /** Whether this section carries the note explaining a config that defines no
   * `linkage_terms`. A run reporting both artifacts prints it once, under the
   * first agreed-terms line it explains. Defaults to carrying it. */
  noteConfigTerms?: boolean;
}

const NOTHING_SUPPLIED: SuppliedVerificationInputs = {
  localTerms: false,
  partnerTerms: false,
};

// The inputs the agreed-terms hash is still waiting on. A config that was named
// but defines no linkage_terms is not re-named as `--config-file` -- the operator
// passed one; what is missing is terms in it.
function missingTermsInputs(supplied: SuppliedVerificationInputs): string[] {
  const missing: string[] = [];
  if (!supplied.localTerms)
    missing.push(
      supplied.configFile === undefined
        ? "--config-file"
        : "a --config-file that defines linkage_terms",
    );
  if (!supplied.partnerTerms) missing.push("--partner-terms");
  return missing;
}

// The agreed-terms hash is reported as not checked only when one of the two terms
// documents is missing, so there is always an input to name. An empty remediation
// would read as "pass" and send the operator nowhere, so it is refused rather than
// rendered.
function termsRemediation(supplied: SuppliedVerificationInputs): string {
  const missing = missingTermsInputs(supplied);
  if (missing.length === 0)
    throw new Error(
      "the agreed-terms hash is reported as not checked while both parties' " +
        "terms were supplied",
    );
  return missing.join(" and ");
}

function termsWord(
  status: TermsHashStatus,
  supplied: SuppliedVerificationInputs,
): string {
  if (status === "verified") return "re-derives and matches";
  if (status === "mismatch") return "DOES NOT MATCH";
  return `not checked (pass ${termsRemediation(supplied)})`;
}

// The note a config carrying no linkage_terms earns: it names a path the operator
// supplied, so it is escaped at this display sink.
function configTermsNote(
  supplied: SuppliedVerificationInputs,
): string | undefined {
  if (supplied.configFile === undefined || supplied.localTerms)
    return undefined;
  if (supplied.noteConfigTerms === false) return undefined;
  return (
    `  note: ${sanitizeForDisplay(`config file ${supplied.configFile}`)} ` +
    "defines no linkage_terms, so it supplied no terms for this check"
  );
}

/** Render the unsigned record's verification report to output lines and an exit
 * code (0 unless a check definitively failed). @internal exported for testing */
export function formatVerificationReport(
  report: RecordVerificationReport,
  warnings: string[],
  signedRecordSupplied = false,
  supplied: SuppliedVerificationInputs = NOTHING_SUPPLIED,
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
  lines.push(`  agreed-terms hash: ${termsWord(report.termsHash, supplied)}`);
  // Directly under the line it explains: a config supplying no terms is why that
  // line reads "not checked", and the two are unreadable apart.
  const configNote = configTermsNote(supplied);
  if (configNote !== undefined) lines.push(configNote);
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
const CERTIFICATE_ANCHOR_WORD: Record<CertificateAnchorStatus, string> = {
  "partner-pin": "matches a fingerprint you pinned out-of-band",
  "local-identity": "is your own signing identity's certificate",
  unanchored:
    "not anchored (no pinned value matches it, and it is not your own " +
    "certificate)",
};
// How the verdict's own sentence names each anchor. An unanchored slot has no
// entry: it is the case the sentence must not claim.
const ANCHOR_SOURCE_PHRASE: Partial<Record<CertificateAnchorStatus, string>> = {
  "partner-pin": "a fingerprint you pinned out-of-band",
  "local-identity": "your own signing identity",
};
const ASSERTED_IDENTITY_WORD: Record<AssertedIdentityStatus, string> = {
  verified: "matches an identity expected for this exchange",
  mismatch: "DOES NOT MATCH an identity expected for this exchange",
  "not-checked": "not checked (no expected identities)",
};

function signedTermsWord(
  status: TermsHashStatus,
  supplied: SuppliedVerificationInputs,
): string {
  if (status === "verified") return "matches the terms this exchange agreed";
  if (status === "mismatch")
    return "DOES NOT MATCH the terms this exchange agreed";
  // The exchange record carries the hash outright, so it is the shorter route to
  // this check than restating both parties' terms.
  return `not checked (pass the exchange record, or ${termsRemediation(supplied)})`;
}

function assertedIdentityWord(
  status: AssertedIdentityStatus,
  supplied: SuppliedVerificationInputs,
): string {
  if (status !== "not-checked") return ASSERTED_IDENTITY_WORD[status];
  return (
    "not checked (no expected identities; pass the exchange record, or " +
    `${termsRemediation(supplied)})`
  );
}

function signedPartyLines(
  party: SignedReceiptPartyReport,
  supplied: SuppliedVerificationInputs,
): string[] {
  return [
    // The identity is free text the certificate's holder chose, so it is escaped
    // at this display sink; the fingerprint beside it is recomputed by the
    // verifier rather than carried by the record.
    `  ${party.role}: ${sanitizeForDisplay(party.identity)}`,
    `    certificate fingerprint ${party.fingerprint}: ` +
      CERTIFICATE_ANCHOR_WORD[party.certificateAnchor],
    `    certificate identity binding: ` +
      CERTIFICATE_BINDING_WORD[party.certificateBinding],
    `    receipt signature: ${RECEIPT_SIGNATURE_WORD[party.signature]}`,
    `    asserted identity: ` +
      assertedIdentityWord(party.assertedIdentity, supplied),
  ];
}

/** Name what anchored each certificate, for the verified verdict's sentence. */
function anchorsPhrase(parties: SignedReceiptPartyReport[]): string {
  return parties
    .map((party) => {
      const source = ANCHOR_SOURCE_PHRASE[party.certificateAnchor];
      // A verified verdict means every certificate was anchored, and the verifier
      // withholds that verdict while either slot is unanchored. An unanchored slot
      // here would leave the sentence claiming an anchor that does not exist --
      // evidence overstated -- so it is refused rather than phrased.
      if (source === undefined)
        throw new Error(
          `a verified dual-signed record leaves the ${party.role}'s certificate ` +
            "unanchored: the verdict would claim both certificates were " +
            "anchored when one was not",
        );
      return `the ${party.role}'s by ${source}`;
    })
    .join(", and ");
}

// What to do about a certificate nothing outside the record vouches for, and what
// a supplied anchor that reached neither certificate means. Each line stands on
// its own: the run may be short one anchor, or hold one that belongs to another
// exchange entirely.
function anchoringLines(
  report: DualSignedRecordVerificationReport,
  supplied: SuppliedVerificationInputs,
  unanchored: SignedReceiptPartyReport[],
): string[] {
  const lines: string[] = [];
  if (report.pinnedFingerprints === "unmatched")
    lines.push(
      "  a pinned fingerprint matches NEITHER certificate in this record: " +
        "this is not the record of the party you pinned.",
    );
  if (
    report.localIdentity === "unmatched" &&
    supplied.localIdentity === "named"
  )
    lines.push(
      "  the signing identity you named is neither certificate in this record: " +
        "this is not a receipt you signed.",
    );
  else if (
    report.localIdentity === "unmatched" &&
    supplied.localIdentity === "resolved" &&
    unanchored.length > 0
  )
    lines.push(
      "  note: your own signing identity is neither certificate here, so it " +
        "anchors nothing -- you were not a party to this exchange, or you have " +
        "regenerated your identity since.",
    );
  // How to reach a verified verdict, but only while the anchors the run does
  // hold are sound: a value that reached neither certificate is answered by the
  // line above it, and telling the operator to supply more would talk past it.
  const anchorContradicted =
    report.pinnedFingerprints === "unmatched" ||
    (report.localIdentity === "unmatched" &&
      supplied.localIdentity === "named");
  if (anchorContradicted) return lines;
  if (unanchored.length === parties(report).length)
    lines.push(
      "  certificate fingerprint trust not established (no pinned value " +
        "supplied): nothing ties the record's certificates to the partner you " +
        "know. Pass --partner-fingerprint, or --config-file with " +
        "signing.partner_fingerprint set.",
    );
  else if (unanchored.length > 0)
    lines.push(
      `  the ${unanchored[0]?.role}'s certificate is anchored by nothing ` +
        "outside this record, which is what holds the verdict short of " +
        "VERIFIED: pin that party's fingerprint (--partner-fingerprint, " +
        "repeatable), or name your own signing identity with --identity-file " +
        "when that slot is yours.",
    );
  return lines;
}

function parties(
  report: DualSignedRecordVerificationReport,
): SignedReceiptPartyReport[] {
  return [report.initiator, report.responder];
}

/** Render the dual-signed record's verification report to output lines and an exit
 * code (0 unless a check definitively failed). @internal exported for testing */
export function formatSignedRecordReport(
  report: DualSignedRecordVerificationReport,
  supplied: SuppliedVerificationInputs = NOTHING_SUPPLIED,
): { lines: string[]; exitCode: number } {
  const lines: string[] = [];
  // The record carries two certificates and a verdict speaks for both, so the
  // verdict states what anchored each of them -- and names the slot nothing
  // outside the record reaches, rather than speaking past it.
  const unanchored = parties(report).filter(
    (party) => party.certificateAnchor === "unanchored",
  );
  const unanchoredSentences = unanchored
    .map(
      (party) =>
        ` Nothing outside the record anchors the ${party.role}'s certificate.`,
    )
    .join("");
  if (report.outcome === "failed")
    lines.push(
      "SIGNED RECEIPT VERIFICATION FAILED: a check did not match -- the " +
        "dual-signed record may have been altered, or it is not the exchange " +
        "or the partner it is being checked against.",
    );
  else if (report.outcome === "incomplete")
    lines.push(
      "SIGNED RECEIPT INCOMPLETE: nothing contradicted the dual-signed record, " +
        "but not everything could be checked (see below)." +
        unanchoredSentences,
    );
  else
    lines.push(
      "SIGNED RECEIPT VERIFIED: both signatures verify, and both certificates " +
        `are anchored outside the record -- ${anchorsPhrase(parties(report))}.`,
    );

  lines.push(...signedPartyLines(report.initiator, supplied));
  lines.push(...signedPartyLines(report.responder, supplied));
  lines.push(
    `  agreed-terms hash: ${signedTermsWord(report.termsHash, supplied)}`,
  );
  const configNote = configTermsNote(supplied);
  if (configNote !== undefined) lines.push(configNote);
  // The binder is derived from the exchange's session key, which only the two
  // parties ever held and neither retains, so it is reported rather than checked:
  // a verifier confirms the signers signed a receipt carrying this value, and only
  // the two parties -- during the live exchange, where each derives it
  // independently -- can tell that a different exchange's binder was substituted.
  lines.push(
    `  per-exchange binder ${sanitizeForDisplay(report.binder)}: covered by ` +
      "both signatures, not recomputed (deriving it needs the exchange session " +
      "key, which only the two parties held).",
  );
  lines.push(...anchoringLines(report, supplied, unanchored));
  return { lines, exitCode: report.outcome === "failed" ? 1 : 0 };
}

// --- Handler -----------------------------------------------------------------

/**
 * This party's linkage terms, from the config named by `--config-file`.
 *
 * That config is also where `signing.partner_fingerprint` and
 * `signing.identity_file` are read from -- the signed-record verdict directs the
 * operator to a config carrying exactly those fields -- so one defining no
 * `linkage_terms` is accepted for them, and its absent terms are reported beside
 * the agreed-terms line rather than refused.
 *
 * A path that does not exist is a usage error: this command never auto-loads a
 * config, so a path that reaches here was named on the command line, and mapping
 * a typo to "no terms supplied" would leave the agreed-terms hash reported as
 * merely not checked (the distinction {@link pinnedFingerprintFromConfig} draws
 * for the same file's pin).
 */
function configFileTerms(
  configFile: string | undefined,
): LinkageTerms | undefined {
  if (configFile === undefined) return undefined;
  const source = readConfigLinkageSource(expandTilde(configFile));
  if (source.status === "no-config-file")
    throw new UsageError(`config file ${configFile} does not exist`);
  if (source.status === "no-linkage-terms") return undefined;
  return source.source.linkageTerms;
}

/**
 * The partner's linkage terms, from the file named by `--partner-terms`. That
 * file has the one purpose, so unlike `--config-file` a file defining no
 * `linkage_terms` is refused rather than noted, and a path that does not exist is
 * refused as well: either would otherwise leave the agreed-terms hash reported as
 * not checked, which is what a run with no partner terms at all looks like.
 */
function partnerTermsFrom(
  partnerTermsFile: string | undefined,
): LinkageTerms | undefined {
  if (partnerTermsFile === undefined) return undefined;
  const source = readConfigLinkageSource(expandTilde(partnerTermsFile));
  if (source.status === "no-config-file")
    throw new UsageError(
      `partner-terms file ${partnerTermsFile} does not exist`,
    );
  if (source.status === "no-linkage-terms")
    throw new UsageError(
      `partner-terms file ${partnerTermsFile} defines no linkage_terms; pass ` +
        "the partner's exported linkage terms, or a configuration file that " +
        "defines them",
    );
  return source.source.linkageTerms;
}

/**
 * Read the `signing` block out of an exchange config, so a party re-verifying its
 * own exchange gets the pin and the identity it already configured without
 * restating either on the command line. Only the two fields this command uses are
 * read from it, so an unrelated block a verification run never touches cannot
 * fail one.
 *
 * `explicit` marks a path the operator named on the command line rather than a
 * default, and a named path that does not exist is a usage error rather than an
 * empty block (the distinction `psilink fingerprint` draws for its own config
 * hints): a typo'd `--config-file` would otherwise verify unanchored and report
 * trust as merely not established.
 */
function signingBlockFromConfig(
  configFile: string | undefined,
  explicit: boolean,
): Record<string, unknown> | undefined {
  if (configFile === undefined) return undefined;
  const target = expandTilde(configFile);
  let text: string;
  try {
    text = fs.readFileSync(target, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      if (explicit)
        throw new UsageError(`config file ${configFile} does not exist`);
      return undefined;
    }
    throw new UsageError(
      `config file ${configFile} could not be read: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  // A YAML parse can echo source bytes (an inline connection credential), so it
  // routes through the sensitive-file chokepoint, which reports path-only.
  const raw = parseSensitiveYaml(text, `config file ${configFile}`);
  const root = (raw ?? {}) as Record<string, unknown>;
  return (root["signing"] ?? {}) as Record<string, unknown>;
}

/**
 * Read `signing.partner_fingerprint` out of an exchange config. A malformed value
 * is a usage error naming the config: a pin that cannot be a fingerprint would
 * otherwise be indistinguishable from a partner whose certificate does not match.
 * @internal exported for testing
 */
export function pinnedFingerprintFromConfig(
  configFile: string | undefined,
  explicit: boolean,
): string | undefined {
  const signing = signingBlockFromConfig(configFile, explicit);
  if (signing === undefined) return undefined;
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
 * Read `signing.identity_file` out of an exchange config, so the party that ran
 * the exchange anchors its own slot from the same config the exchange used. A
 * non-string value is left to the default path rather than refused: unlike the
 * pin, nothing about this run turns on it, and the identity that is found is
 * reported by what it anchors.
 */
function signingIdentityPathFromConfig(
  configFile: string | undefined,
  explicit: boolean,
): string | undefined {
  const signing = signingBlockFromConfig(configFile, explicit);
  if (signing === undefined) return undefined;
  const identityFile = signing["identity_file"] ?? signing["identityFile"];
  return typeof identityFile === "string" ? identityFile : undefined;
}

/**
 * What the signature checks are anchored to besides the certificates: the two
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

/**
 * The fingerprints pinned out-of-band for the signed-record check: every
 * `--partner-fingerprint` value, or the config's `signing.partner_fingerprint`
 * when the flag is absent. The flag wins over the config, so a third party given a
 * fingerprint out-of-band can verify against a config it does not have (or one
 * written for another partner), and a verifier that was party to no exchange
 * repeats the flag to pin both signers. The record carries two certificates, so a
 * third value could anchor nothing and is refused rather than quietly dropped.
 */
function resolvePinnedFingerprints(
  flagValues: string[],
  configFile: string | undefined,
): string[] {
  if (flagValues.length === 0) {
    // This command never auto-loads a config, so a path that reaches here was
    // named on the command line.
    const configured = pinnedFingerprintFromConfig(
      configFile,
      configFile !== undefined,
    );
    return configured === undefined ? [] : [configured];
  }
  if (flagValues.length > 2)
    throw new UsageError(
      "--partner-fingerprint may be given at most twice: a dual-signed record " +
        "carries two certificates, so a third pinned value can anchor none of " +
        "them",
    );
  for (const value of flagValues)
    if (!FINGERPRINT_REGEX.test(value))
      throw new UsageError(
        "--partner-fingerprint must be a certificate fingerprint (an unpadded " +
          "base64url SHA-256 digest, 43 characters); obtain it from your " +
          "partner via 'psilink fingerprint' and a trusted out-of-band channel",
      );
  return flagValues;
}

/**
 * This party's own certificate fingerprint, which anchors the slot holding its
 * certificate. It is computed from the signing identity rather than restated by
 * the operator, who could otherwise only copy the value off the very record being
 * checked. `--identity-file` names the file; failing that, `signing.identity_file`
 * from `--config-file` and then the default per-user path are tried in turn.
 *
 * A named file that is absent or unreadable is a usage error -- the operator
 * pointed this run at it. A file found without being asked is not: it belongs to
 * another exchange or another partner as easily as to this one, so it degrades to
 * a logged warning and leaves the slot unanchored.
 */
async function resolveLocalIdentity(
  identityFileArg: string | undefined,
  configFile: string | undefined,
  log: { warn: (message: string) => void },
): Promise<LocalIdentityAnchor | undefined> {
  const fingerprintOf = async (
    identity: SigningIdentity,
    source: LocalIdentitySource,
  ): Promise<LocalIdentityAnchor> => ({
    fingerprint: await computeCertificateFingerprint(identity.certificate),
    source,
  });
  if (identityFileArg !== undefined) {
    const named = await loadSigningIdentity(expandTilde(identityFileArg));
    if (named === undefined)
      throw new UsageError(
        `signing identity file ${identityFileArg} does not exist`,
      );
    return await fingerprintOf(named, "named");
  }
  const configured = signingIdentityPathFromConfig(
    configFile,
    configFile !== undefined,
  );
  const target = expandTilde(configured ?? defaultSigningIdentityPath());
  let resolved: SigningIdentity | undefined;
  try {
    resolved = await loadSigningIdentity(target);
  } catch (err) {
    log.warn(
      `the signing identity at ${target} could not be read, so it anchors ` +
        `no certificate in this record: ${sanitizeErrorForDisplay(err)}`,
    );
    return undefined;
  }
  if (resolved === undefined) {
    if (configured !== undefined)
      log.warn(
        `the signing identity at ${target}, named by the configuration's ` +
          `signing.identity_file, does not exist, so it anchors no ` +
          `certificate in this record`,
      );
    return undefined;
  }
  return await fingerprintOf(resolved, "resolved");
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
    const identityFileArg = singleValue(argv, "identity-file") as
      string | undefined;
    // Repeatable, one pinned value per signer, so it is read as a list rather
    // than through singleValue, which refuses a repeat.
    const partnerFingerprintArgs = ((): string[] => {
      const value = argv["partner-fingerprint"];
      if (value === undefined) return [];
      return (Array.isArray(value) ? value : [value]).map(String);
    })();

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

    const localTerms = configFileTerms(configFile);
    const partnerTerms = partnerTermsFrom(partnerTermsFile);
    const signedRecord =
      artifact.kind === "signed"
        ? artifact.signed
        : signedRecordArg !== undefined
          ? readSignedRecordFile(signedRecordArg)
          : undefined;

    if (signedRecord === undefined && partnerFingerprintArgs.length > 0)
      throw new UsageError(
        "--partner-fingerprint pins a certificate in a dual-signed record, " +
          "and no dual-signed record was named; pass --signed-record, or name " +
          "the dual-signed record as the artifact to verify",
      );
    if (signedRecord === undefined && identityFileArg !== undefined)
      throw new UsageError(
        "--identity-file anchors your own certificate in a dual-signed record, " +
          "and no dual-signed record was named; pass --signed-record, or name " +
          "the dual-signed record as the artifact to verify",
      );

    const supplied: SuppliedVerificationInputs = {
      configFile,
      localTerms: localTerms !== undefined,
      partnerTerms: partnerTerms !== undefined,
    };
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
        supplied,
      );
      lines.push(...rendered.lines);
      exitCode = Math.max(exitCode, rendered.exitCode);
    }

    if (signedRecord !== undefined) {
      const localIdentity = await resolveLocalIdentity(
        identityFileArg,
        configFile,
        log,
      );
      const rendered = formatSignedRecordReport(
        await verifyDualSignedRecord(signedRecord, {
          pinnedFingerprints: resolvePinnedFingerprints(
            partnerFingerprintArgs,
            configFile,
          ),
          localIdentity,
          ...(await signedRecordExpectations(
            artifact.kind === "record" ? artifact.record : undefined,
            localTerms,
            partnerTerms,
          )),
        }),
        {
          ...supplied,
          localIdentity: localIdentity?.source,
          // The note explaining a config that carries no terms belongs beside
          // the first agreed-terms line it explains, and a combined run has
          // already printed that line above.
          noteConfigTerms: artifact.kind !== "record",
        },
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
