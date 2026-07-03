import { computeTermsHash, verifyCommitmentOpening } from "./exchangeRecord.js";

import type {
  CommitmentName,
  ExchangeRecord,
  VerificationKeys,
} from "./exchangeRecord.js";
import type { CanonicalValue } from "./utils/canonical.js";
import type { LinkageTerms } from "./config/linkageTerms.js";

// The verification consumer for the self-attested exchange record: it reads a
// stored record and its verification keys, re-derives the record's canonical
// bytes, and opens each commitment against re-supplied data. It is read-only --
// it never mutates or re-signs the artifact.
//
// This is the UNSIGNED-record path: "verify" here is internal consistency (the
// agreed-terms hash re-derives, and the commitments open against the holder's
// re-supplied data), NOT evidence against the partner. Verifying a SIGNED
// evidence bundle -- checking the partner's receipt signature and certificate --
// is deferred work that layers on top of this (see the Signed Exchange Receipts
// epic); the tri-state report here is shaped so that layer can extend it.
//
// The verification keys hold only salts, never a data snapshot, so the caller
// RE-SUPPLIES the committed data (from the holder's own retained input and
// result) and this module recomputes the commitment; see
// docs/spec/EXCHANGE_RECORD.md ("No data snapshot in the keys"). An unrecognized
// record or keys version is rejected earlier, at parse (parseExchangeRecord /
// parseVerificationKeys reject a version literal they do not recognize), so a
// record reaching this module is already a recognized v1.

/**
 * The outcome of verifying one commitment against its salt and re-supplied data.
 *
 * - `verified`: the salt and the re-supplied data recompute the stored commitment.
 * - `mismatch`: the data was re-supplied but does not reproduce the commitment --
 *   the record was altered, or the re-supplied input/result does not match this
 *   exchange (the two are indistinguishable here; see the diagnosability note in
 *   docs/spec/EXCHANGE_RECORD.md).
 * - `not-supplied`: the commitment is present but its data was not re-supplied, so
 *   it could not be opened (the third-party-auditor case, or a holder that did not
 *   pass the input/result for this data set).
 * - `unopenable`: the commitment is present but has no salt in the keys (a missing
 *   or drifted keys file), or a mandatory commitment is absent from the record.
 */
export type CommitmentStatus =
  | "verified"
  | "mismatch"
  | "not-supplied"
  | "unopenable";

/**
 * The outcome of the agreed-terms-hash check. `not-checked` when either party's
 * terms were not re-supplied (the partner's terms are not retained by default, so
 * this is the common case); `mismatch` when the re-supplied terms do not
 * reproduce the recorded hash.
 */
export type TermsHashStatus = "verified" | "mismatch" | "not-checked";

/**
 * The overall verdict.
 *
 * - `failed`: a definite inconsistency -- a commitment mismatch, a terms-hash
 *   mismatch, or a structurally invalid record. The artifact does not verify.
 * - `verified`: every present commitment opened and the terms hash re-derived --
 *   nothing was left unchecked and nothing failed.
 * - `incomplete`: nothing was contradicted, but something could not be checked (a
 *   commitment whose data was not re-supplied, a missing salt, or terms not
 *   supplied). Distinct from `verified` so "we did not check" is never reported as
 *   "it checked out".
 */
export type RecordVerificationOutcome = "verified" | "incomplete" | "failed";

/** The structured result of {@link verifyExchangeRecord}. */
export interface RecordVerificationReport {
  outcome: RecordVerificationOutcome;
  termsHash: TermsHashStatus;
  /** Per-commitment status, one entry per commitment present in the record (plus a
   * mandatory commitment that was expected but absent). */
  commitments: Partial<Record<CommitmentName, CommitmentStatus>>;
}

/** The data a caller re-supplies to open a record's commitments and re-derive its
 * terms hash. Every field is optional: an omitted data set leaves its commitment
 * unopened (`not-supplied`), and omitting either party's terms leaves the terms
 * hash `not-checked`. */
export interface RecordVerificationInputs {
  /** The committed data sets, keyed by {@link CommitmentName}, re-supplied from the
   * holder's retained input and result and re-canonicalized to the exact bytes the
   * commit used (the {@link CanonicalValue} domain). */
  data?: Partial<Record<CommitmentName, CanonicalValue>>;
  /** This party's linkage terms, for the terms-hash check. */
  localTerms?: LinkageTerms;
  /** The partner's linkage terms, for the terms-hash check (not retained by
   * default, so the check is best-effort). */
  partnerTerms?: LinkageTerms;
}

const ALL_COMMITMENTS: readonly CommitmentName[] = [
  "localPayloadSent",
  "partnerPayloadReceived",
  "associationTable",
];

// localPayloadSent and partnerPayloadReceived are mandatory in a well-formed
// record (the schema requires them; the association table is optional). A parsed
// record always carries the mandatory pair, so a missing one here means a
// hand-built (unparsed) record -- treated as a structural failure rather than
// silently skipped.
const MANDATORY: ReadonlySet<CommitmentName> = new Set([
  "localPayloadSent",
  "partnerPayloadReceived",
]);

/**
 * Verify a stored {@link ExchangeRecord} against its {@link VerificationKeys} and
 * re-supplied data: re-derive the agreed-terms hash (when both parties' terms are
 * supplied) and open every present commitment against its salt and re-supplied
 * data. Read-only; it never mutates or re-signs the record.
 *
 * Returns a tri-state {@link RecordVerificationReport} that distinguishes a
 * commitment that opened, one whose data was not re-supplied (so could not be
 * opened), and one that failed to open -- so "not checked" is never conflated with
 * "verified". This is the unsigned-record internal-consistency check; a signed
 * evidence bundle's signature and certificate checks are deferred work that layers
 * on top.
 *
 * Fail-safe: every check yields a status, never an exception. A malformed salt or
 * commitment, re-supplied data outside the canonical domain, or terms that do not
 * canonically encode are reported as a `mismatch` (or leave the check unperformed),
 * not thrown -- so hostile or malformed input always produces a verdict. An
 * unrecognized record/keys version is rejected earlier, at parse.
 */
export async function verifyExchangeRecord(
  record: ExchangeRecord,
  keys: VerificationKeys,
  inputs: RecordVerificationInputs = {},
): Promise<RecordVerificationReport> {
  const commitments: Partial<Record<CommitmentName, CommitmentStatus>> = {};
  let anyMismatch = false;
  let anyUnverified = false;

  for (const name of ALL_COMMITMENTS) {
    const commitment = record.commitments[name];
    const salt = keys.salts[name];
    const supplied = inputs.data?.[name];

    if (commitment === undefined) {
      if (salt !== undefined) {
        // Orphaned salt: the keys carry material the record does not -- a
        // keys/record mismatch (or a hand-built pair). Nothing to open.
        commitments[name] = "unopenable";
        anyUnverified = true;
      } else if (MANDATORY.has(name)) {
        // A parsed record always carries the mandatory commitments; a hand-built
        // one missing one is structurally invalid.
        commitments[name] = "unopenable";
        anyMismatch = true;
      }
      // An optional commitment legitimately absent (this party held no
      // association table) is not reported.
      continue;
    }

    if (salt === undefined) {
      // The commitment is present but the keys carry no salt to open it: the wrong
      // or a drifted keys file. Indistinguishable from tamper, so reported as
      // unverifiable (incomplete) rather than a definite failure.
      commitments[name] = "unopenable";
      anyUnverified = true;
      continue;
    }

    if (supplied === undefined) {
      commitments[name] = "not-supplied";
      anyUnverified = true;
      continue;
    }

    const opened = await verifyCommitmentOpening(
      name,
      salt,
      supplied,
      commitment,
    );
    commitments[name] = opened ? "verified" : "mismatch";
    if (!opened) anyMismatch = true;
  }

  let termsHash: TermsHashStatus;
  if (inputs.localTerms === undefined || inputs.partnerTerms === undefined) {
    termsHash = "not-checked";
    anyUnverified = true;
  } else {
    let recomputed: string | undefined;
    try {
      recomputed = await computeTermsHash(
        inputs.localTerms,
        inputs.partnerTerms,
      );
    } catch {
      // Terms outside the canonical encoding domain cannot reproduce the hash: a
      // mismatch, not a throw, keeping the contract fail-safe.
      recomputed = undefined;
    }
    termsHash = recomputed === record.termsHash ? "verified" : "mismatch";
    if (termsHash === "mismatch") anyMismatch = true;
  }

  const outcome: RecordVerificationOutcome = anyMismatch
    ? "failed"
    : anyUnverified
      ? "incomplete"
      : "verified";
  return { outcome, termsHash, commitments };
}
