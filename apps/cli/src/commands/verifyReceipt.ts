import type { Argv, Arguments } from "yargs";
import fs from "node:fs";

import {
  computeCertificateFingerprint,
  computeTermsHash,
  decideSignedReceiptVerdict,
  deriveOurIdColumn,
  EXCHANGE_KEYS_VERSION,
  EXCHANGE_RECORD_VERSION,
  FINGERPRINT_REGEX,
  loadCSVFile,
  parseDualSignedRecord,
  parseExchangeRecord,
  parseVerificationKeys,
  reconstructCommittedData,
  recordAlterationIsTheOnlyExplanation,
  recordedVersionMatches,
  reproductionMismatchCauses,
  sanitizeErrorForDisplay,
  sanitizeForDisplay,
  SIGNED_RECEIPT_VERSION,
  toRetainedResult,
  UsageError,
  verifyDualSignedRecord,
  verifyExchangeRecord,
} from "@psilink/core";
import type {
  AnchoredCertificateSlot,
  AnchoredCertificateStatus,
  AssertedIdentityStatus,
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
  ResultSizeStatus,
  RunBindingStatus,
  SignedReceiptVerdictGuidance,
  SignedReceiptVerdictParty,
  TermsHashStatus,
  UnanchoredCertificateClause,
  VerificationKeys,
} from "@psilink/core";

import {
  readConfigLinkageSource,
  warnOnLinkageRuleSetCitationDrift,
} from "../config";
import { expandTilde } from "../fileUtils";
import { keysPathFor } from "../recordFile";
import { parseSensitiveJson, parseSensitiveYaml } from "../sensitiveFile";
import { loadSigningCertificate } from "../signingIdentityFile";
import {
  configureLogging,
  exitWithError,
  logLevelFlag,
  openInputSource,
  parseOrExit,
  RECEIPT_VERIFICATION_FAILED_EXIT_CODE,
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
//     receipt signature is checked against the certificate the record holds, each
//     certificate's identity binding is checked, and each certificate is checked
//     against what anchors it outside the record -- a fingerprint the verifier
//     pinned, or the verifier's own signing identity.
//
// The positional accepts either artifact, dispatched on its format `version`; the
// dual-signed record can also be named with --signed-record to verify both
// artifacts of one exchange in a single run, which is what lets the record's terms
// hash, party identities, and run binder be included in the signature checks. The
// run binder is the pairing: without the exchange record beside it a receipt
// verifies against a partnership under a set of terms, not against one run of it.
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
        "checks both parties' signatures and certificates alongside the record, " +
        "and that the two artifacts are from the same run",
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
        "--config-file. With neither, your own slot is left unanchored",
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

// Reject an unrecognized version with a specific message BEFORE the schema
// parse -- so a future-format or hand-edited file is not mis-reported as a generic
// shape error. The version literal is also enforced by the schema; this only makes
// the failure clear.
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

/** @internal exported for testing */
export function firstIssue(err: unknown): string {
  const issues = (
    err as { issues?: Array<{ path?: unknown[]; message: string }> }
  ).issues;
  if (Array.isArray(issues) && issues.length > 0) {
    const issue = issues[0];
    const at =
      Array.isArray(issue.path) && issue.path.length > 0
        ? `${issue.path.map((segment) => String(segment)).join(".")}: `
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

// The recorded result size is the matched-pairs table's entry count and no
// commitment covers it, so the verdict recounts the opened table rather than
// opening anything. A mismatch is stated without the altered-or-wrong-file
// hedge the commitment lines include: a result that did not belong to this
// exchange fails the table's own line above and never reaches this one.
const RESULT_SIZE_WORD: Record<ResultSizeStatus, string> = {
  verified: "matches the matched-pairs table it counts",
  mismatch:
    "DOES NOT MATCH the matched-pairs table it counts, which opened and " +
    "holds a different number of pairs -- the recorded figure is what " +
    "disagrees, not the data",
  "not-supplied":
    "not checked (re-supply the result file so its matched pairs can be " +
    "recounted)",
  unopenable:
    "not checked (no matched pairs to recount: where the record commits to a " +
    "table that did not open, the matched-pairs line above names the cause; a " +
    "table that opened but is not shaped as a pairing has no count to " +
    "recount; a count-only exchange records no such table at all)",
};

/**
 * What this run supplied, so a "not checked" line names an input that is still
 * missing rather than one already on the command line, and the note explaining a
 * config that defines no terms sits next to the line it explains.
 * @internal exported for testing
 */
export interface SuppliedVerificationInputs {
  /** The `--config-file` path, when one was named. */
  configFile?: string;
  /** Whether that config defined `linkage_terms`. */
  localTerms: boolean;
  /** Whether `--partner-terms` was supplied. */
  partnerTerms: boolean;
  /** Whether this section includes the note explaining a config that defines no
   * `linkage_terms`. A run reporting both artifacts prints it once, under the
   * first agreed-terms line it explains. Defaults to including it. */
  noteConfigTerms?: boolean;
  /**
   * Whether the sources this run supplied name fewer than two parties -- the
   * second reason the identity check goes unperformed, since
   * `linkage_terms.identity` is optional.
   */
  unnamedParty?: boolean;
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
// would display as "pass" and send the operator nowhere, so it is refused rather
// than rendered.
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

// The note a config defining no linkage_terms earns: it names a path the operator
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
      recordAlterationIsTheOnlyExplanation(report)
        ? "VERIFICATION FAILED: the recorded result size disagrees with the " +
            "matched pairs the record itself commits to -- the record was " +
            "altered; the files you re-supplied check out."
        : "VERIFICATION FAILED: a check did not match -- the record may have been " +
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
  // Omitted when the record has no result size: only a both-output exchange
  // records one, and a line reporting the absence would be treated as a gap.
  if (report.resultSize !== undefined)
    lines.push(`  result size: ${RESULT_SIZE_WORD[report.resultSize]}`);
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
  return {
    lines,
    exitCode:
      report.outcome === "failed" ? RECEIPT_VERIFICATION_FAILED_EXIT_CODE : 0,
  };
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
const ANCHORED_CERTIFICATE_WORD: Record<AnchoredCertificateStatus, string> = {
  "partner-pin": "matches a fingerprint you pinned out-of-band",
  "local-identity": "is your own signing identity's certificate",
};

// What an unanchored slot says, one clause per finding the verdict states. Which
// of them a run supports is core's decision: a check that did not run, or one
// that ran and matched this very certificate, is not narrated here as a check
// this certificate failed.
const UNANCHORED_CLAUSE_WORD: Record<UnanchoredCertificateClause, string> = {
  "no-pinned-value-matches": "no pinned value matches it",
  "not-your-own-certificate": "it is not your own certificate",
};

function unanchoredCertificateWord(
  clauses: readonly UnanchoredCertificateClause[],
): string {
  const supported =
    clauses.length === 0
      ? ""
      : ` -- ${clauses
          .map((clause) => UNANCHORED_CLAUSE_WORD[clause])
          .join(", and ")}`;
  return `not anchored (nothing you supplied anchors it${supported})`;
}

// How the verdict's own sentence names each anchor. The verdict's verified
// headline includes only slots something anchored, so there is no unanchored case
// to leave unnamed.
const ANCHOR_SOURCE_PHRASE: Record<AnchoredCertificateStatus, string> = {
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
  // The exchange record holds the hash outright, so it is the shorter route to
  // this check than restating both parties' terms.
  return `not checked (pass the exchange record, or ${termsRemediation(supplied)})`;
}

// What pairing this receipt to one run says. The `not-checked` remediation names
// the one invocation that supplies the pairing: the exchange record has to be the
// positional, since --signed-record is refused beside a dual-signed positional.
const RUN_BINDING_WORD: Record<RunBindingStatus, string> = {
  verified: "this receipt and this exchange record are the same run",
  mismatch:
    "DOES NOT MATCH the exchange record's run binder: the receipt and the " +
    "record are from different runs, not from one exchange",
  unpaired:
    "the exchange record holds no run binder, so it records an exchange " +
    "that produced no signed receipt -- this receipt is not that run's",
  "not-checked":
    "not checked (name this exchange's record as the positional and pass this " +
    "file with --signed-record); the signed values that can be checked here " +
    "repeat across every run of this partnership under these terms",
};

// Why the identity check went unperformed where the sources ARE in hand: the pair
// it needs is two names, and `linkage_terms.identity` is optional. Stated as the
// state of this exchange rather than as an input to pass, because there is none --
// a party that ran unnamed cannot be named after the fact, and the certificate
// beside it is checked by everything else in this section regardless.
const UNNAMED_PARTY_IDENTITIES =
  "not checked (this exchange names fewer than two parties: a certificate is " +
  "checked against the name its holder used in the agreed terms, and an " +
  "unnamed party gives it none)";

function assertedIdentityWord(
  status: AssertedIdentityStatus,
  supplied: SuppliedVerificationInputs,
): string {
  if (status !== "not-checked") return ASSERTED_IDENTITY_WORD[status];
  if (supplied.unnamedParty === true) return UNNAMED_PARTY_IDENTITIES;
  return (
    "not checked (no expected identities; pass the exchange record, or " +
    `${termsRemediation(supplied)})`
  );
}

function signedPartyLines(
  party: SignedReceiptVerdictParty,
  supplied: SuppliedVerificationInputs,
): string[] {
  const anchor = party.certificateAnchor;
  const anchorWord =
    anchor.status === "unanchored"
      ? unanchoredCertificateWord(anchor.unanchoredClauses)
      : ANCHORED_CERTIFICATE_WORD[anchor.status];
  // A certificate whose canonical bytes cannot be produced has no fingerprint to
  // print, so the line says so rather than leaving a blank where one belongs.
  const fingerprintWord =
    party.fingerprint === null
      ? "certificate fingerprint could not be computed"
      : `certificate fingerprint ${party.fingerprint}`;
  return [
    // The identity is free text the certificate's holder chose, so it is escaped
    // at this display sink; the fingerprint beside it is recomputed by the
    // verifier rather than held by the record.
    `  ${party.role}: ${sanitizeForDisplay(party.identity)}`,
    `    ${fingerprintWord}: ${anchorWord}`,
    `    certificate identity binding: ` +
      CERTIFICATE_BINDING_WORD[party.certificateBinding.status],
    `    receipt signature: ${RECEIPT_SIGNATURE_WORD[party.signature.status]}`,
    `    asserted identity: ` +
      assertedIdentityWord(party.assertedIdentity.status, supplied),
  ];
}

/** Name what anchored each certificate, for the verified verdict's sentence. */
function anchorsPhrase(slots: readonly AnchoredCertificateSlot[]): string {
  return slots
    .map((slot) => `the ${slot.role}'s by ${ANCHOR_SOURCE_PHRASE[slot.anchor]}`)
    .join(", and ");
}

// What to do about a certificate nothing outside the record vouches for, and what
// a supplied anchor that reached neither certificate means, in this command's
// vocabulary. Which of them a run has earned, and in what order, is the verdict's
// decision.
function guidanceLine(guidance: SignedReceiptVerdictGuidance): string {
  switch (guidance.kind) {
    case "pinned-fingerprint-unmatched":
      return (
        "  a pinned fingerprint matches NEITHER certificate in this record: " +
        "this is not the record of the party you pinned."
      );
    case "named-local-identity-unmatched":
      return (
        "  the signing identity you named is neither certificate in this " +
        "record: this is not a receipt you signed."
      );
    case "resolved-local-identity-unmatched":
      return (
        "  note: your own signing identity is neither certificate here, so it " +
        "anchors nothing -- you were not a party to this exchange, or you have " +
        "regenerated your identity since."
      );
    case "no-certificate-anchored":
      return (
        "  certificate fingerprint trust not established (no pinned value " +
        "supplied): nothing ties the record's certificates to the partner you " +
        "know. Pass --partner-fingerprint, or --config-file with " +
        "signing.partner_fingerprint set."
      );
    case "certificate-unanchored":
      return (
        `  the ${guidance.role}'s certificate is anchored by nothing ` +
        "outside this record, which is what holds the verdict short of " +
        "VERIFIED: pin that party's fingerprint (--partner-fingerprint, " +
        "repeatable), or name your own signing identity with --identity-file " +
        "when that slot is yours."
      );
  }
}

/** Render the dual-signed record's verification report to output lines and an exit
 * code (0 unless a check definitively failed). @internal exported for testing */
export function formatSignedRecordReport(
  report: DualSignedRecordVerificationReport,
  supplied: SuppliedVerificationInputs = NOTHING_SUPPLIED,
): { lines: string[]; exitCode: number } {
  const verdict = decideSignedReceiptVerdict(report);
  const headline = verdict.headline;
  const lines: string[] = [];
  if (headline.tone === "failed")
    lines.push(
      "SIGNED RECEIPT VERIFICATION FAILED: a check did not match -- the " +
        "dual-signed record may have been altered, or it is not the exchange " +
        "or the partner it is being checked against.",
    );
  else if (headline.tone === "incomplete")
    // The record holds two certificates and a verdict speaks for both, so the
    // headline names the slot nothing outside the record reaches rather than
    // speaking past it.
    lines.push(
      "SIGNED RECEIPT INCOMPLETE: nothing contradicted the dual-signed record, " +
        "but not everything could be checked (see below)." +
        headline.unanchoredRoles
          .map(
            (role) =>
              ` Nothing outside the record anchors the ${role}'s certificate.`,
          )
          .join(""),
    );
  else
    lines.push(
      "SIGNED RECEIPT VERIFIED: both signatures verify, and both certificates " +
        "are anchored outside the record -- " +
        `${anchorsPhrase(headline.anchoredSlots)}.`,
    );

  for (const party of verdict.parties)
    lines.push(...signedPartyLines(party, supplied));
  lines.push(
    `  agreed-terms hash: ${signedTermsWord(verdict.termsHash.status, supplied)}`,
  );
  const configNote = configTermsNote(supplied);
  if (configNote !== undefined) lines.push(configNote);
  lines.push(
    `  receipt-record pairing: ${RUN_BINDING_WORD[verdict.runBinding.status]}.`,
  );
  // Where to look when the record in hand contradicts the pairing: the two
  // artifacts of one exchange are written together, so the likely cause is two
  // files from different runs rather than an altered artifact.
  if (verdict.runBinding.pairByStamp)
    lines.push(
      "  note: an exchange writes its record and its receipt together, under one " +
        "timestamp stamp by default (psilink-record-<stamp>.json and " +
        "psilink-receipt-<stamp>.json), so pair them by that stamp.",
    );
  // The binder is never RECOMPUTED: deriving it needs the exchange's session key,
  // which only the two parties ever held and neither retains. What an offline
  // verifier can check is the pairing line above -- that the binder is the value
  // the run's own record holds. A binder substituted into both artifacts is
  // detectable only during the live exchange, where each party derives it
  // independently.
  lines.push(
    `  per-exchange binder ${sanitizeForDisplay(verdict.binder)}: covered by ` +
      "both signatures, never recomputed (deriving it needs the exchange " +
      "session key, which only the two parties held).",
  );
  lines.push(...verdict.guidance.map(guidanceLine));
  return {
    lines,
    exitCode:
      headline.tone === "failed" ? RECEIPT_VERIFICATION_FAILED_EXIT_CODE : 0,
  };
}

// --- Handler -----------------------------------------------------------------

/**
 * This party's linkage terms, from the config named by `--config-file`,
 * which also supplies `signing.partner_fingerprint` and
 * `signing.identity_file` -- so a config that defines no `linkage_terms` is
 * accepted rather than refused. A path that does not exist is a usage error
 * (this command never auto-loads a config). The rule-set citation is
 * checked here, not in the reader shared with `--partner-terms`: this
 * party's config load has no standing to report on the PARTNER's own
 * citation of its rules.
 */
function configFileTerms(
  configFile: string | undefined,
  log: { warn: (message: string) => void },
): LinkageTerms | undefined {
  if (configFile === undefined) return undefined;
  const source = readConfigLinkageSource(expandTilde(configFile));
  if (source.status === "no-config-file")
    throw new UsageError(`config file ${configFile} does not exist`);
  if (source.status === "no-linkage-terms") return undefined;
  warnOnLinkageRuleSetCitationDrift(
    source.source.linkageTerms,
    configFile,
    log,
    source.source.linkageTermsStanding,
    "decline-to-reuse",
  );
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
 * The `signing` block of an exchange config, read once per invocation and shared
 * by the two fields this command takes from it: the config is a secret-bearing
 * document, so it is read and parsed once rather than once per field. It holds
 * the config path as the operator wrote it, for the messages that name it.
 * @internal exported for testing
 */
export interface ConfigSigningBlock {
  configFile: string;
  fields: Record<string, unknown>;
}

/**
 * Read the `signing` block out of an exchange config, so a party
 * re-verifying its own exchange gets the pin and the identity it already
 * configured. Only the two fields this command uses are read from it.
 *
 * `explicit` marks a path named on the command line: a missing explicit
 * path is a usage error, not an empty block (the same distinction `psilink
 * fingerprint` draws for its own config hint) -- so a typo'd `--config-file`
 * does not silently verify unanchored.
 * @internal exported for testing
 */
export function readConfigSigningBlock(
  configFile: string | undefined,
  explicit: boolean,
): ConfigSigningBlock | undefined {
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
  return {
    configFile,
    fields: (root["signing"] ?? {}) as Record<string, unknown>,
  };
}

/**
 * `signing.partner_fingerprint` from the config's signing block. A malformed
 * value is a usage error naming the config: a pin that cannot be a fingerprint
 * would otherwise be indistinguishable from a partner whose certificate does not
 * match.
 * @internal exported for testing
 */
export function pinnedFingerprintFrom(
  signing: ConfigSigningBlock | undefined,
): string | undefined {
  if (signing === undefined) return undefined;
  const pinned =
    signing.fields["partner_fingerprint"] ??
    signing.fields["partnerFingerprint"];
  if (pinned === undefined) return undefined;
  if (typeof pinned !== "string" || !FINGERPRINT_REGEX.test(pinned))
    throw new UsageError(
      `config file ${signing.configFile} has a signing.partner_fingerprint ` +
        "that is not a certificate fingerprint (an unpadded base64url SHA-256 " +
        "digest, 43 characters); obtain it from your partner via " +
        "'psilink fingerprint'",
    );
  return pinned;
}

/**
 * `signing.identity_file` from the config's signing block, so the party that ran
 * the exchange anchors its own slot from the same config the exchange used. A
 * non-string value leaves the slot unanchored rather than being refused: unlike
 * the pin, nothing about this run turns on it, and the identity that is found is
 * reported by what it anchors.
 */
function signingIdentityPathFrom(
  signing: ConfigSigningBlock | undefined,
): string | undefined {
  if (signing === undefined) return undefined;
  const identityFile =
    signing.fields["identity_file"] ?? signing.fields["identityFile"];
  return typeof identityFile === "string" ? identityFile : undefined;
}

/**
 * What the signature checks are anchored to besides the certificates: both
 * parties' identities, the agreed-terms hash, and the run binder. Supplied
 * from the exchange record when named; without it, an auditor restates
 * identities and the hash from both parties' terms and supplies no run
 * binder. A record with no run binder is passed as explicit `null`, not
 * omitted. Identities are unordered (the per-signer signature binding fixes
 * a certificate to its role) and are supplied only when both parties are
 * named -- a half-pair would leave one identity check appearing performed.
 */
async function signedRecordExpectations(
  record: ExchangeRecord | undefined,
  localTerms: LinkageTerms | undefined,
  partnerTerms: LinkageTerms | undefined,
): Promise<
  Pick<
    DualSignedRecordVerificationInputs,
    "expectedIdentities" | "expectedTermsHash" | "recordReceiptBinder"
  >
> {
  if (record !== undefined)
    return {
      ...namedPair(record.localIdentity, record.partnerIdentity),
      expectedTermsHash: record.termsHash,
      recordReceiptBinder: record.receiptBinder ?? null,
    };
  if (localTerms === undefined || partnerTerms === undefined) return {};
  return {
    ...namedPair(localTerms.identity, partnerTerms.identity),
    expectedTermsHash: await computeTermsHash(localTerms, partnerTerms),
  };
}

/** The `expectedIdentities` pair, present only where both parties named
 * themselves; see {@link signedRecordExpectations}. */
function namedPair(
  local: string | undefined,
  partner: string | undefined,
): Pick<DualSignedRecordVerificationInputs, "expectedIdentities"> {
  return local === undefined || partner === undefined
    ? {}
    : { expectedIdentities: [local, partner] };
}

/**
 * The fingerprints pinned out-of-band for the signed-record check: every
 * `--partner-fingerprint` value, or (when none are given) the config's
 * `signing.partner_fingerprint`. The flag takes precedence, so a
 * third-party verifier without the config can still supply it directly;
 * repeat it to pin both signers. A third value cannot anchor anything (the
 * record holds two certificates) and is refused rather than dropped.
 */
function resolvePinnedFingerprints(
  flagValues: string[],
  signing: ConfigSigningBlock | undefined,
): string[] {
  if (flagValues.length === 0) {
    const configured = pinnedFingerprintFrom(signing);
    return configured === undefined ? [] : [configured];
  }
  if (flagValues.length > 2)
    throw new UsageError(
      "--partner-fingerprint may be given at most twice: a dual-signed record " +
        "has two certificates, so a third pinned value can anchor none of " +
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
 * The certificate fingerprint of the signing identity stored at `identityPath`,
 * as an anchor for the slot holding that certificate. Only the CERTIFICATE half
 * of the file is used: the anchor says whose certificate occupies a slot, which
 * the public half states on its own, and what refuses a slot its holder did not
 * sign is the receipt signature there. This command is read-only and signs
 * nothing, so the private key stored beside the certificate is neither imported
 * nor compared against it.
 */
async function identityAnchorAt(
  identityPath: string,
  source: LocalIdentitySource,
): Promise<LocalIdentityAnchor | undefined> {
  const certificate = await loadSigningCertificate(identityPath);
  if (certificate === undefined) return undefined;
  return {
    fingerprint: await computeCertificateFingerprint(certificate),
    source,
  };
}

/**
 * This party's own anchor from the identity file `--identity-file` names. The
 * operator pointed this run at that file, so an absent or unreadable one is a
 * usage error, and the anchor it yields asserts the record is one this party
 * signed.
 */
async function namedLocalIdentity(
  identityFileArg: string,
): Promise<LocalIdentityAnchor> {
  const named = await identityAnchorAt(expandTilde(identityFileArg), "named");
  if (named === undefined)
    throw new UsageError(
      `signing identity file ${identityFileArg} does not exist`,
    );
  return named;
}

/**
 * This party's own anchor from the config's `signing.identity_file` -- a file
 * the operator did not name on THIS command line. Such a file belongs to another
 * exchange or another partner as easily as to this one, so an unreadable or
 * absent one degrades to a logged warning and leaves the slot unanchored, where
 * the same file named with `--identity-file` would be a usage error.
 */
async function foundLocalIdentity(
  identityPath: string,
  log: { warn: (message: string) => void },
): Promise<LocalIdentityAnchor | undefined> {
  const target = expandTilde(identityPath);
  let resolved: LocalIdentityAnchor | undefined;
  try {
    resolved = await identityAnchorAt(target, "resolved");
  } catch (err) {
    log.warn(
      `the signing identity at ${target} could not be read, so it anchors ` +
        `no certificate in this record: ${sanitizeErrorForDisplay(err)}`,
    );
    return undefined;
  }
  if (resolved === undefined)
    log.warn(
      `the signing identity at ${target}, named by the configuration's ` +
        `signing.identity_file, does not exist, so it anchors no ` +
        `certificate in this record`,
    );
  return resolved;
}

/**
 * This party's own anchor from the identity file the operator chose:
 * `--identity-file` first, then the config's `signing.identity_file`. With
 * neither, the slot is simply left unanchored -- psilink resolves no identity
 * path of its own, so there is nowhere else to look, and a verification run
 * needs no identity to reach a verdict.
 */
async function chosenLocalIdentity(
  identityFileArg: string | undefined,
  signing: ConfigSigningBlock | undefined,
  log: { warn: (message: string) => void },
): Promise<LocalIdentityAnchor | undefined> {
  if (identityFileArg !== undefined)
    return await namedLocalIdentity(identityFileArg);
  const configured = signingIdentityPathFrom(signing);
  if (configured === undefined) return undefined;
  return await foundLocalIdentity(configured, log);
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
    // A dual-signed record holds no commitments and no terms, so the options
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

    const localTerms = configFileTerms(configFile, log);
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
      // A reproduction limitation is named only once the verdict shows it could
      // be the cause, so it joins the notes after the report, not before it.
      warnings.push(...reproductionMismatchCauses(report, data));
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
      // This command never auto-loads a config, so a path that reaches here was
      // named on the command line.
      const signing = readConfigSigningBlock(
        configFile,
        configFile !== undefined,
      );
      const expectations = await signedRecordExpectations(
        artifact.kind === "record" ? artifact.record : undefined,
        localTerms,
        partnerTerms,
      );
      const report = await verifyDualSignedRecord(signedRecord, {
        pinnedFingerprints: resolvePinnedFingerprints(
          partnerFingerprintArgs,
          signing,
        ),
        ...expectations,
        localIdentity: await chosenLocalIdentity(identityFileArg, signing, log),
      });
      const rendered = formatSignedRecordReport(report, {
        ...supplied,
        // The note explaining a config that defines no terms belongs beside
        // the first agreed-terms line it explains, and a combined run has
        // already printed that line above.
        noteConfigTerms: artifact.kind !== "record",
        // A source WAS in hand -- both branches of signedRecordExpectations
        // supply the hash -- and still yielded no identity pair, which is a
        // party that named itself none rather than an input the operator has
        // yet to pass.
        unnamedParty:
          expectations.expectedTermsHash !== undefined &&
          expectations.expectedIdentities === undefined,
      });
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
