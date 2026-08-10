import {
  certificateAuthorizesIdentity,
  computeCertificateFingerprint,
  matchesPinnedFingerprint,
  verifyCertificateSelfSignature,
} from "./signingIdentity.js";
import { verifyReceiptSignature } from "./signedReceipt.js";

import type {
  RecordVerificationOutcome,
  TermsHashStatus,
} from "./recordVerification.js";
import type { DualSignedRecord, SignedReceiptParty } from "./signedReceipt.js";
import type { HandshakeRole } from "./types.js";

// The verification consumer for the DUAL-SIGNED record (the signed evidence
// bundle the signed-receipt step produces): it reads a stored record and checks,
// per party, the certificate the record carries, the receipt signature made under
// that certificate's key, the fingerprint pin when the verifier holds one, and the
// identity the certificate authorizes. Read-only -- it never mutates or re-signs
// the artifact -- and every check yields a status rather than throwing for any
// record of the shape parseDualSignedRecord produces: the FIELD VALUES inside it
// may be hostile (an identity the canonical encoder refuses, a malformed
// signature, a public key that is not a P-256 point) and each still resolves to a
// status. That contract covers the values, not the shape: a hand-built record
// missing a structural member (no `content`, a party without a certificate) is a
// programming error and reaches a TypeError.
//
// This is the SIGNED path, evidence against the partner, and is the counterpart of
// recordVerification.ts, which checks the unsigned self-attested record's internal
// consistency. The two artifacts are separate files (see
// docs/spec/EXCHANGE_RECORD.md) and a caller may hold either or both.
//
// What "verified" costs here: a dual-signed record is self-consistent by
// construction, so signature verification alone proves only that whoever holds the
// two certificates' private keys signed this content -- an attacker who mints two
// certificates of its own produces a bundle whose signatures verify. The PIN is
// what makes it evidence: only a fingerprint pinned out-of-band ties a certificate
// to the real partner. The report therefore never reaches `verified` without a pin
// -- an unpinned run is `incomplete`, which is the third-party-auditor case the
// acceptance wording calls "certificate fingerprint trust not established". The
// trust model is specified in docs/spec/PROTOCOL.md (Signing identity and
// certificate pinning).
//
// An unrecognized bundle version is rejected earlier, at parse
// (parseDualSignedRecord pins the version literal), so a record reaching this
// module is already a recognized one.

/**
 * Whether a certificate's own self-signature verifies. The self-signature covers
 * the certificate body -- version, algorithm, identity, and public key -- so this
 * is the certificate's IDENTITY BINDING: it is what ties the identity string the
 * certificate carries to the key that signed the receipt. `failed` means the
 * certificate does not bind its identity to its key (it was altered, or its key is
 * not a valid P-256 point), so nothing it carries can be attributed to that
 * identity.
 */
export type CertificateBindingStatus = "verified" | "failed";

/** Whether a party's receipt signature verifies against the certificate carried
 * beside it in the record, over the canonical signed bytes re-derived for that
 * party's role. */
export type ReceiptSignatureStatus = "verified" | "failed";

/**
 * The outcome of checking a certificate against a pinned fingerprint.
 *
 * - `verified`: this certificate's fingerprint matches the pinned value, so it is
 *   the party the verifier pinned out-of-band.
 * - `mismatch`: a pinned value was supplied and NEITHER certificate matches it --
 *   the record is not from the pinned partner.
 * - `not-pinned`: no pinned value was supplied for this certificate. A verifier
 *   holds a pin for its PARTNER only, so the other slot is `not-pinned` even on a
 *   fully pinned run; with no pin at all (the third-party auditor) both are.
 */
export type FingerprintPinStatus = "verified" | "mismatch" | "not-pinned";

/**
 * Whether a certificate authorizes the identity the verifier expected for that
 * party. `not-checked` when the caller supplied no expected identities -- the
 * record names the two parties only through the certificates themselves, so
 * without an outside statement of who they should be there is nothing to compare.
 */
export type AssertedIdentityStatus = "verified" | "mismatch" | "not-checked";

/** One party's slot (`initiator` or `responder`) in a verified dual-signed
 * record. */
export interface SignedReceiptPartyReport {
  /** The handshake role whose slot this is; the record keys parties by role. */
  role: HandshakeRole;
  /** The identity the certificate in this slot carries. Free text supplied by
   * that party -- a consumer that renders it must escape it at its display
   * sink. */
  identity: string;
  /** This certificate's fingerprint, recomputed from the record, in the same
   * unpadded base64url form a partner pins. */
  fingerprint: string;
  /** The certificate's self-signature: its identity-to-key binding. */
  certificateBinding: CertificateBindingStatus;
  /** The receipt signature in this slot. */
  signature: ReceiptSignatureStatus;
  /** The fingerprint pin. */
  fingerprintPin: FingerprintPinStatus;
  /** Whether the certificate authorizes the expected identity for this party. */
  assertedIdentity: AssertedIdentityStatus;
}

/** The structured result of {@link verifyDualSignedRecord}. */
export interface DualSignedRecordVerificationReport {
  /** The overall verdict, on the same tri-state as the unsigned record's report:
   * `failed` if any check was contradicted, `verified` only if every check ran and
   * passed, `incomplete` when nothing was contradicted but something could not be
   * checked -- notably an absent fingerprint pin. */
  outcome: RecordVerificationOutcome;
  initiator: SignedReceiptPartyReport;
  responder: SignedReceiptPartyReport;
  /** Whether the record's agreed-terms hash matches the one the caller supplied. */
  termsHash: TermsHashStatus;
  /**
   * The per-exchange binder both signatures cover, verbatim from the record. It is
   * derived from the exchange's session key, which only the two parties ever held
   * and neither retains, so a verifier confirms that the signers signed a receipt
   * carrying THIS binder and does not recompute it: a swapped binder is detectable
   * only during the live exchange, where both parties derive it independently. It
   * is reported rather than checked for exactly that reason.
   */
  binder: string;
}

/** What a caller supplies to check a dual-signed record against the world outside
 * it. Every field is optional: with none, the record is checked for internal
 * consistency only (each signature against the certificate beside it) and the
 * report is `incomplete`. */
export interface DualSignedRecordVerificationInputs {
  /**
   * The partner's certificate fingerprint, pinned out-of-band (the verifier's
   * `signing.partner_fingerprint`, or a value supplied at the command line). This
   * is the only input that turns a self-consistent record into evidence: without
   * it the report cannot reach `verified`.
   */
  pinnedFingerprint?: string;
  /**
   * The two parties' expected identities, unordered. The record keys its parties
   * by handshake role, and no other artifact records which party held which role,
   * so the pair is matched to the two certificates in either order; the per-signer
   * signature binding is what fixes a certificate to its role.
   */
  expectedIdentities?: readonly [string, string];
  /** The agreed-terms hash the caller holds (from its own exchange record, or
   * re-derived from both parties' terms), compared against the record's. */
  expectedTermsHash?: string;
}

// A per-party evaluation that could not be completed at all -- a certificate whose
// canonical bytes cannot be produced, which the parse schema should already have
// refused. Reported as a failed binding rather than thrown, keeping the fail-safe
// contract: hostile input always yields a verdict.
const UNEVALUABLE_FINGERPRINT = "";

async function verifyParty(
  party: SignedReceiptParty,
  role: HandshakeRole,
  record: DualSignedRecord,
): Promise<
  Pick<
    SignedReceiptPartyReport,
    "role" | "identity" | "fingerprint" | "certificateBinding" | "signature"
  >
> {
  const identity = party.certificate.identity;
  let fingerprint: string;
  try {
    fingerprint = await computeCertificateFingerprint(party.certificate);
  } catch {
    return {
      role,
      identity,
      fingerprint: UNEVALUABLE_FINGERPRINT,
      certificateBinding: "failed",
      signature: "failed",
    };
  }
  // Both checks always run, whatever the other returns: the report states every
  // finding rather than the first one, and the work done does not vary with which
  // check fails.
  const [selfSigned, signed] = await Promise.all([
    verifyCertificateSelfSignature(party.certificate),
    verifyReceiptSignature(
      party.certificate,
      record.content,
      party.signature,
      role,
    ),
  ]);
  return {
    role,
    identity,
    fingerprint,
    certificateBinding: selfSigned ? "verified" : "failed",
    signature: signed ? "verified" : "failed",
  };
}

// A certificate whose canonical bytes cannot be produced has no fingerprint to
// compare, so it matches no pin. Reported as a non-match rather than thrown,
// keeping the fail-safe contract as verifyParty's binding downgrade does.
async function matchesPin(
  party: SignedReceiptParty,
  pinnedFingerprint: string,
): Promise<boolean> {
  try {
    return await matchesPinnedFingerprint(party.certificate, pinnedFingerprint);
  } catch {
    return false;
  }
}

async function pinStatuses(
  record: DualSignedRecord,
  pinnedFingerprint: string | undefined,
): Promise<[FingerprintPinStatus, FingerprintPinStatus]> {
  if (pinnedFingerprint === undefined || pinnedFingerprint.length === 0)
    return ["not-pinned", "not-pinned"];
  const [initiator, responder] = await Promise.all([
    matchesPin(record.initiator, pinnedFingerprint),
    matchesPin(record.responder, pinnedFingerprint),
  ]);
  // A verifier pins its PARTNER's certificate, so exactly one slot is expected to
  // match and the other is simply unpinned -- not a failure. Neither matching is
  // the failure: the record is not the pinned partner's.
  if (!initiator && !responder) return ["mismatch", "mismatch"];
  return [
    initiator ? "verified" : "not-pinned",
    responder ? "verified" : "not-pinned",
  ];
}

function identityStatuses(
  record: DualSignedRecord,
  expected: readonly [string, string] | undefined,
): [AssertedIdentityStatus, AssertedIdentityStatus] {
  if (expected === undefined) return ["not-checked", "not-checked"];
  // Match the two certificates onto the two expected identities as a bijection:
  // each certificate must authorize an expected identity, and the two must not
  // claim the same one. Assigning greedily is exact for a pair -- a certificate
  // that matches both entries leaves the other entry for its partner either way.
  const remaining = [...expected];
  const consume = (party: SignedReceiptParty): AssertedIdentityStatus => {
    const at = remaining.findIndex((candidate) => {
      try {
        return certificateAuthorizesIdentity(party.certificate, candidate);
      } catch {
        // An identity the canonical encoder refuses cannot authorize anything:
        // a mismatch, not a throw, keeping the contract fail-safe as the
        // sibling terms-hash check in recordVerification.ts does.
        return false;
      }
    });
    if (at < 0) return "mismatch";
    remaining.splice(at, 1);
    return "verified";
  };
  return [consume(record.initiator), consume(record.responder)];
}

/**
 * Verify a stored {@link DualSignedRecord}: for each party, re-derive the
 * canonical signed bytes and check that party's receipt signature against the
 * certificate the record carries, check that certificate's identity binding (its
 * self-signature), check its fingerprint against a pinned value when the caller
 * holds one, and check the identity it authorizes when the caller supplies the
 * expected pair. Read-only; it never mutates or re-signs the record.
 *
 * Returns a {@link DualSignedRecordVerificationReport} on the same tri-state as
 * the unsigned record's report, so "not checked" is never reported as "verified".
 * The report reaches `verified` only when a fingerprint pin was supplied AND
 * matched: signature verification alone proves only that the holders of the two
 * embedded certificates' keys signed this content, which anyone can arrange with
 * two certificates of their own. A run with no pinned value is the third-party
 * auditor's, and is `incomplete`.
 *
 * Fail-safe over field values: given a record of the shape
 * `parseDualSignedRecord` produces, every check yields a status rather than an
 * exception however hostile the certificate and signature values it carries, so
 * a hostile record always produces a verdict. The shape itself is the caller's:
 * a hand-built record missing a structural member (no `content`, a party without a
 * certificate) is a programming error and reaches a TypeError. An unrecognized
 * record version is rejected earlier, at parse.
 */
export async function verifyDualSignedRecord(
  record: DualSignedRecord,
  inputs: DualSignedRecordVerificationInputs = {},
): Promise<DualSignedRecordVerificationReport> {
  const [initiatorChecks, responderChecks, pins] = await Promise.all([
    verifyParty(record.initiator, "initiator", record),
    verifyParty(record.responder, "responder", record),
    pinStatuses(record, inputs.pinnedFingerprint),
  ]);
  const identities = identityStatuses(record, inputs.expectedIdentities);

  const initiator: SignedReceiptPartyReport = {
    ...initiatorChecks,
    fingerprintPin: pins[0],
    assertedIdentity: identities[0],
  };
  const responder: SignedReceiptPartyReport = {
    ...responderChecks,
    fingerprintPin: pins[1],
    assertedIdentity: identities[1],
  };

  const termsHash: TermsHashStatus =
    inputs.expectedTermsHash === undefined
      ? "not-checked"
      : inputs.expectedTermsHash === record.content.termsHash
        ? "verified"
        : "mismatch";

  const parties = [initiator, responder];
  const anyMismatch =
    termsHash === "mismatch" ||
    parties.some(
      (party) =>
        party.certificateBinding === "failed" ||
        party.signature === "failed" ||
        party.fingerprintPin === "mismatch" ||
        party.assertedIdentity === "mismatch",
    );
  // A verifier pins its partner's certificate and not its own, so one unpinned
  // slot is the expected shape of a fully anchored run: what leaves the record
  // unanchored is NO slot matching a pin, which is the third-party-auditor case.
  const anyUnverified =
    termsHash === "not-checked" ||
    !parties.some((party) => party.fingerprintPin === "verified") ||
    parties.some((party) => party.assertedIdentity === "not-checked");

  const outcome: RecordVerificationOutcome = anyMismatch
    ? "failed"
    : anyUnverified
      ? "incomplete"
      : "verified";
  return {
    outcome,
    initiator,
    responder,
    termsHash,
    binder: record.content.binder,
  };
}
