import {
  EXCHANGE_KEYS_VERSION,
  EXCHANGE_RECORD_VERSION,
  parseExchangeRecord,
  parseSensitiveJson,
  parseVerificationKeys,
  recordedVersionMatches,
  sanitizeErrorForDisplay,
  sanitizeForDisplay,
} from "@psilink/core";

import type {
  CommitmentName,
  CommitmentStatus,
  ExchangeRecord,
  RecordVerificationReport,
  TermsHashStatus,
  VerificationKeys,
} from "@psilink/core";

/**
 * The pure model behind the "Verify a receipt" bench: it turns the two supplied
 * JSON documents into either a named parse failure or a parsed artifact, and a
 * {@link RecordVerificationReport} into a plain-language verdict view-model. It is
 * React-free and free of any I/O, so the copy discipline the bench requires -- the
 * honest ambiguity of a failed verdict, the "supply your files" framing of an
 * unopened commitment, the wrong-keys signal distinct from tamper -- is tested
 * here directly rather than through the DOM.
 *
 * Every embedded error string is routed through core's display-boundary
 * sanitizers before it reaches this model's output: a malformed document's parse
 * error through {@link sanitizeErrorForDisplay}, a reconstruction warning (which
 * interpolates a supplied column name) through {@link sanitizeForDisplay}. Nothing
 * here echoes an unsanitized byte of a supplied file.
 */

// --- Input parse -------------------------------------------------------------

/** A parsed JSON document that is either the recognized artifact or a named
 * reason it is not. `kind: "ok"` carries the parsed value; every other kind is a
 * pre-verification outcome the page renders as a designed alert state. */
export type RecordParseResult =
  | { kind: "ok"; record: ExchangeRecord }
  | { kind: "malformed"; message: string }
  | { kind: "unrecognized-version"; message: string };

export type KeysParseResult =
  | { kind: "ok"; keys: VerificationKeys }
  | { kind: "malformed"; message: string }
  | { kind: "unrecognized-version"; message: string };

// The parse label handed to parseSensitiveJson: it reports path-only, so this
// fixed string is all that ever reaches an error message -- never the file's
// bytes. The web app's JSON is non-secret here (a receipt carries no values), but
// the chokepoint is used regardless so a syntax error cannot echo source.
const RECORD_LABEL = "the record file";
const KEYS_LABEL = "the verification-keys file";

const MALFORMED_RECORD_MESSAGE =
  "This is not a valid exchange record. Check that you loaded the " +
  "psilink-record-<stamp>.json file (the shareable record), not the keys file " +
  "or another document.";

const MALFORMED_KEYS_MESSAGE =
  "This is not a valid verification-keys file. Check that you loaded the " +
  "psilink-record-<stamp>.keys.json file (the private keys), not the record " +
  "file or another document.";

function unrecognizedVersionMessage(kind: "record" | "keys"): string {
  const recognized =
    kind === "record" ? EXCHANGE_RECORD_VERSION : EXCHANGE_KEYS_VERSION;
  const what = kind === "record" ? "record" : "verification-keys";
  return (
    `This ${what} file is a version this build does not recognize. It may come ` +
    `from a newer or older psilink, or have been edited. This build recognizes ` +
    `${recognized}.`
  );
}

/**
 * Parse the record document: through the bounded sensitive-JSON chokepoint (an
 * oversized or syntactically broken file is a `malformed` outcome, its error
 * sanitized), then a version pre-check (an unrecognized version is its own named
 * outcome, not a generic shape error), then the record schema (a wrong-shape file
 * is `malformed`). Mirrors the CLI's read-record semantics.
 */
export function parseRecordDocument(text: string): RecordParseResult {
  let raw: unknown;
  try {
    raw = parseSensitiveJson(text, RECORD_LABEL);
  } catch (error) {
    return {
      kind: "malformed",
      message: `${MALFORMED_RECORD_MESSAGE} ${sanitizeErrorForDisplay(error)}`,
    };
  }
  if (!recordedVersionMatches(raw, EXCHANGE_RECORD_VERSION))
    return {
      kind: "unrecognized-version",
      message: unrecognizedVersionMessage("record"),
    };
  try {
    return { kind: "ok", record: parseExchangeRecord(raw) };
  } catch {
    // The Zod error can quote a parsed value; do not forward it. The static
    // message locates the fault (wrong file / edited record) without an echo.
    return { kind: "malformed", message: MALFORMED_RECORD_MESSAGE };
  }
}

/** Parse the verification-keys document, with the same phased outcomes as
 * {@link parseRecordDocument}. */
export function parseKeysDocument(text: string): KeysParseResult {
  let raw: unknown;
  try {
    raw = parseSensitiveJson(text, KEYS_LABEL);
  } catch (error) {
    return {
      kind: "malformed",
      message: `${MALFORMED_KEYS_MESSAGE} ${sanitizeErrorForDisplay(error)}`,
    };
  }
  if (!recordedVersionMatches(raw, EXCHANGE_KEYS_VERSION))
    return {
      kind: "unrecognized-version",
      message: unrecognizedVersionMessage("keys"),
    };
  try {
    return { kind: "ok", keys: parseVerificationKeys(raw) };
  } catch {
    return { kind: "malformed", message: MALFORMED_KEYS_MESSAGE };
  }
}

// --- Verdict view-model ------------------------------------------------------

/** The visual tone of a verdict or a per-check row; maps to an alert color and
 * icon in the view. */
export type VerdictTone = "verified" | "failed" | "incomplete";

/** The headline for each overall outcome, honest about the ambiguity of a
 * mismatch (a failed verdict never asserts tamper alone) and never reporting a
 * not-checked artifact as verified. */
export interface VerdictHeadline {
  tone: VerdictTone;
  title: string;
  detail: string;
}

/** One plain-language row: a commitment or the terms hash, with a status label
 * and the tone that colors it. `explanation` carries the "supply your files"
 * framing for a not-opened commitment. */
export interface VerdictRow {
  label: string;
  status: string;
  tone: VerdictTone;
  explanation?: string;
}

/** The full verdict view-model the page renders. */
export interface VerdictViewModel {
  headline: VerdictHeadline;
  commitments: Array<VerdictRow>;
  termsHash: VerdictRow;
  /** Reconstruction caveats, each already sanitized for display. */
  warnings: Array<string>;
  /** The standing caveat: the unsigned-record path does not check partner
   * receipt signatures. Fixed copy, mirrored from the CLI. */
  signatureNote: string;
}

// The verbatim headline copy per outcome. The failed headline states the honest
// ambiguity core's own type docs require (recordVerification.ts): a mismatch means
// the record was altered OR the keys/input/result do not belong to this exchange
// -- cryptographically indistinguishable -- so it never asserts "tampered" alone.
const HEADLINES: Record<RecordVerificationReport["outcome"], VerdictHeadline> =
  {
    verified: {
      tone: "verified",
      title: "Verified",
      detail:
        "The record is internally consistent: every commitment opened against " +
        "the files you supplied, and the agreed-terms hash re-derives.",
    },
    incomplete: {
      tone: "incomplete",
      title: "Incomplete",
      detail:
        "Nothing contradicted the record, but not everything could be checked. " +
        "See the rows below for what is still open.",
    },
    failed: {
      tone: "failed",
      title: "Verification failed",
      detail:
        "A check did not match. This means one of two things, and they cannot be " +
        "told apart here: the record was altered, or a file you re-supplied (an " +
        "input, a result, or the linkage terms) does not belong to this exchange.",
    },
  };

// The per-commitment status label and tone. `unopenable` here is the missing-salt
// signal -- a wrong or drifted keys file -- stated distinctly from a mismatch and
// from a not-supplied commitment. Not a failure: it leaves the outcome incomplete.
const COMMITMENT_ROWS: Record<
  CommitmentStatus,
  { status: string; tone: VerdictTone; explanation?: string }
> = {
  verified: { status: "Opened and matches", tone: "verified" },
  mismatch: { status: "Does not match", tone: "failed" },
  "not-supplied": {
    status: "Not opened",
    tone: "incomplete",
    explanation:
      "Supply your retained files to open this commitment. Without them it " +
      "cannot be checked -- this is not a failure.",
  },
  unopenable: {
    status: "Cannot be opened",
    tone: "incomplete",
    explanation:
      "The keys file has no salt for this commitment, so it cannot be opened. " +
      "This is likely a wrong or drifted keys file, not a problem with the " +
      "record.",
  },
};

const TERMS_ROWS: Record<
  TermsHashStatus,
  { status: string; tone: VerdictTone; explanation?: string }
> = {
  verified: { status: "Re-derives and matches", tone: "verified" },
  mismatch: { status: "Does not match", tone: "failed" },
  "not-checked": {
    status: "Not checked",
    tone: "incomplete",
    explanation:
      "Supply both parties' linkage terms to check the agreed-terms hash. The " +
      "partner's terms are not retained by default, so this is the common case.",
  },
};

// The readable name of each commitment, in the record's committed order. Fixed
// strings owned by this page, never a value from a supplied file.
const COMMITMENT_LABELS: Record<CommitmentName, string> = {
  localPayloadSent: "The payload you sent",
  partnerPayloadReceived: "The payload you received",
  associationTable: "The matched-pairs table",
};

const COMMITMENT_ORDER: ReadonlyArray<CommitmentName> = [
  "localPayloadSent",
  "partnerPayloadReceived",
  "associationTable",
];

const SIGNATURE_NOTE =
  "Partner receipt signatures are not checked here. This confirms the record is " +
  "internally consistent, not that your partner signed it (signed evidence " +
  "bundles are separate, later work).";

/**
 * Build the verdict view-model from a {@link RecordVerificationReport} and any
 * reconstruction warnings. Each warning is sanitized here (it interpolates a
 * supplied column name), so the caller passes the raw warnings straight from
 * {@link reconstructCommittedData}. Only the commitments the report carries are
 * shown; the mandatory pair is always present in a parsed record, and the
 * association table appears only when the record holds it.
 */
export function verdictViewModel(
  report: RecordVerificationReport,
  warnings: ReadonlyArray<string>,
): VerdictViewModel {
  const commitments: Array<VerdictRow> = [];
  for (const name of COMMITMENT_ORDER) {
    const status = report.commitments[name];
    if (status === undefined) continue;
    const row = COMMITMENT_ROWS[status];
    commitments.push({
      label: COMMITMENT_LABELS[name],
      status: row.status,
      tone: row.tone,
      explanation: row.explanation,
    });
  }
  const termsRow = TERMS_ROWS[report.termsHash];
  return {
    headline: HEADLINES[report.outcome],
    commitments,
    termsHash: {
      label: "The agreed-terms hash",
      status: termsRow.status,
      tone: termsRow.tone,
      explanation: termsRow.explanation,
    },
    warnings: warnings.map((warning) => sanitizeForDisplay(warning)),
    signatureNote: SIGNATURE_NOTE,
  };
}
