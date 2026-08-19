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
// that certificate's key, what anchors that certificate outside the record, and
// the identity it authorizes. Read-only -- it never mutates or re-signs
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
// Beside the per-party checks it makes two whole-record ones: the agreed-terms
// hash against the value the caller holds, and the receipt's per-exchange binder
// against the `receiptBinder` of the exchange record for the run it is being read
// beside. That pairing is what ties a receipt to ONE run rather than to a
// partnership: across recurring runs under one set of terms every signed value a
// verifier can otherwise check repeats byte for byte (the terms hash and both
// certificates), and the directional payload MACs, which do vary per run, are
// reported rather than recomputed -- no verifier holds the session key they are
// keyed under.
//
// What "verified" costs here: a dual-signed record is self-consistent by
// construction, so signature verification alone proves only that whoever holds the
// two certificates' private keys signed this content -- an attacker who mints two
// certificates of its own produces a bundle whose signatures verify. ANCHORING is
// what makes it evidence: a certificate counts only when something outside the
// record ties it to a party the verifier knows -- a fingerprint pinned out-of-band,
// or the verifier's own signing identity. The record carries two certificates, so
// the report reaches `verified` only when BOTH are anchored; one anchored
// certificate leaves the other slot mintable by whoever assembled the record, and
// is `incomplete` -- the same tier as the third-party auditor's unanchored run,
// which the acceptance wording calls "certificate fingerprint trust not
// established". The trust model is specified in docs/spec/PROTOCOL.md (Signing
// identity and certificate pinning).
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
 * What ties one certificate in the record to a party the verifier knows from
 * outside it.
 *
 * - `partner-pin`: its fingerprint matches a value the verifier pinned
 *   out-of-band.
 * - `local-identity`: it is the certificate of the verifier's own signing
 *   identity. Certificates are public, so this says whose certificate occupies
 *   the slot and nothing more -- whoever assembled the record could have copied
 *   it in. What refuses a slot its certificate's holder did not sign is the
 *   receipt signature there, which verifies only under the private key the
 *   verifier holds.
 * - `unanchored`: nothing outside the record vouches for this certificate. It is
 *   still checked against itself (its self-signature, its signature over the
 *   content, and the expected identities), all of which whoever assembled the
 *   record can satisfy with a certificate it minted.
 *
 * Each anchoring value reaches at most one certificate, so a single value -- or
 * several carrying the same digest, whatever their spelling and whether they
 * arrived as pins or as the verifier's own identity -- can never anchor both
 * slots.
 */
export type CertificateAnchorStatus =
  "partner-pin" | "local-identity" | "unanchored";

/**
 * What one anchoring value the verifier supplied reached in the record.
 * `unmatched` means it matches neither certificate.
 */
export type AnchorMatchStatus = "matched" | "unmatched" | "not-supplied";

/** How the verifier's own certificate fingerprint reached the verification,
 * which fixes what a non-match costs. */
export type LocalIdentitySource = "named" | "resolved";

/** The verifier's own signing identity, as an anchor for the slot holding its
 * own certificate. */
export interface LocalIdentityAnchor {
  /** The fingerprint of the verifier's own certificate, computed from the
   * identity it holds rather than copied off the record being verified. */
  fingerprint: string;
  /**
   * `named` when the verifier pointed this run at that identity, which asserts
   * the record is one it signed: a value matching neither certificate is then a
   * failure. `resolved` when it was found without being asked, where a non-match
   * says only that this is not the verifier's own exchange, and leaves the slot
   * unanchored rather than failing the run.
   */
  source: LocalIdentitySource;
}

/**
 * Whether a certificate authorizes the identity the verifier expected for that
 * party. `not-checked` when the caller supplied no expected identities -- the
 * record names the two parties only through the certificates themselves, so
 * without an outside statement of who they should be there is nothing to compare.
 */
export type AssertedIdentityStatus = "verified" | "mismatch" | "not-checked";

/**
 * Whether this receipt belongs to the one exchange run the verifier is reading it
 * beside, decided by comparing the receipt's per-exchange binder against the
 * `receiptBinder` the exchange record for that run carries. Both parties derive
 * that value from the run's session key, and every run derives a different one, so
 * it is what separates one run of a recurring partnership from the next -- the
 * agreed-terms hash, the identities, and the certificates all repeat byte for byte
 * across such runs.
 *
 * - `verified`: the record and the receipt carry the same run's binder.
 * - `mismatch`: they carry different ones, so they are not the same run.
 * - `unpaired`: the record carries no binder at all. It records an exchange that
 *   produced no signed receipt (no signing identity, or a path with no session
 *   key), so no receipt belongs to it -- a contradiction, not an unchecked box.
 * - `not-checked`: no record was supplied. A holder of the receipt alone has
 *   nothing to pair it to, which holds the verdict short of `verified` without
 *   failing it.
 */
export type RunBindingStatus =
  "verified" | "mismatch" | "unpaired" | "not-checked";

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
  /** What anchors this certificate outside the record. */
  certificateAnchor: CertificateAnchorStatus;
  /** Whether the certificate authorizes the expected identity for this party. */
  assertedIdentity: AssertedIdentityStatus;
}

/** The structured result of {@link verifyDualSignedRecord}. */
export interface DualSignedRecordVerificationReport {
  /** The overall verdict, on the same tri-state as the unsigned record's report:
   * `failed` if any check was contradicted, `verified` only if every check ran and
   * passed, `incomplete` when nothing was contradicted but something could not be
   * checked -- notably a certificate left unanchored. */
  outcome: RecordVerificationOutcome;
  initiator: SignedReceiptPartyReport;
  responder: SignedReceiptPartyReport;
  /**
   * What the fingerprints the verifier pinned reached: `matched` when every one
   * of them matches a certificate the record carries, `unmatched` when one
   * matches neither -- the record is not the pinned party's, which fails the
   * verification.
   */
  pinnedFingerprints: AnchorMatchStatus;
  /**
   * What the verifier's own certificate fingerprint reached. A `named` identity
   * that matches neither certificate fails the verification; a `resolved` one
   * that matches neither is reported and leaves its slot unanchored.
   */
  localIdentity: AnchorMatchStatus;
  /** Whether the record's agreed-terms hash matches the one the caller supplied. */
  termsHash: TermsHashStatus;
  /**
   * Whether this receipt belongs to the exchange run whose record the caller
   * supplied. This is what a receipt's signatures alone cannot establish: every
   * other value they cover that a verifier can check repeats across recurring runs
   * of one partnership under one set of terms.
   */
  runBinding: RunBindingStatus;
  /**
   * The per-exchange binder both signatures cover, verbatim from the record. It is
   * derived from the exchange's session key, which only the two parties ever held
   * and neither retains, so a verifier confirms that the signers signed a receipt
   * carrying THIS binder and does not recompute it: what an offline verifier can
   * check is that it is the value the run's own record carries ({@link
   * runBinding}), not that it derives from that run's session key. A binder
   * substituted into BOTH artifacts is detectable only during the live exchange,
   * where each party derives it independently.
   */
  binder: string;
}

/** What a caller supplies to check a dual-signed record against the world outside
 * it. Every field is optional: with none, the record is checked for internal
 * consistency only (each signature against the certificate beside it) and the
 * report is `incomplete`. */
export interface DualSignedRecordVerificationInputs {
  /**
   * Certificate fingerprints the verifier pinned out-of-band, one per party it
   * can vouch for: the partner's alone on a party's own run (the verifier's
   * `signing.partner_fingerprint`, or a value supplied at the command line), or
   * both parties' for a verifier that was party to no exchange. Together with
   * {@link localIdentity} these are what turn a self-consistent record into
   * evidence: without an anchor on each certificate the report cannot reach
   * `verified`.
   */
  pinnedFingerprints?: readonly string[];
  /**
   * The verifier's own signing identity, which anchors the slot holding its own
   * certificate without the verifier restating a fingerprint it could only copy
   * off the record it is checking.
   */
  localIdentity?: LocalIdentityAnchor;
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
  /**
   * The `receiptBinder` of the exchange record this receipt is being read beside,
   * which is what pairs the receipt to one run: the value when that record carries
   * one, or `null` when the record is in hand and carries NONE (an exchange that
   * produced no signed receipt, which no receipt belongs to). Absent when no
   * record is in hand at all, which leaves the pairing unchecked rather than
   * contradicted. The distinction is load-bearing: passing `undefined` for a
   * record that carries no binder would report a contradiction as an unchecked
   * box.
   *
   * A verifier holding both parties' terms but no record supplies the agreed-terms
   * hash by re-deriving it and still pairs nothing: terms belong to a partnership,
   * not to one run of it.
   */
  recordReceiptBinder?: string | null;
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
// compare, so it matches no anchoring value. Reported as a non-match rather than
// thrown, keeping the fail-safe contract as verifyParty's binding downgrade does.
async function certificateMatches(
  party: SignedReceiptParty,
  fingerprint: string,
): Promise<boolean> {
  try {
    return await matchesPinnedFingerprint(party.certificate, fingerprint);
  } catch {
    return false;
  }
}

/** Which of the record's two slots one anchoring value matches, in slot order. */
type SlotMatches = readonly [boolean, boolean];

async function slotMatches(
  record: DualSignedRecord,
  fingerprint: string,
): Promise<SlotMatches> {
  return await Promise.all([
    certificateMatches(record.initiator, fingerprint),
    certificateMatches(record.responder, fingerprint),
  ]);
}

interface AnchorAssignment {
  anchors: [CertificateAnchorStatus, CertificateAnchorStatus];
  pinnedFingerprints: AnchorMatchStatus;
  localIdentity: AnchorMatchStatus;
}

/**
 * Assign the anchoring values the verifier holds to the record's two certificate
 * slots, as an assignment rather than a per-value test: equal values count once
 * and each value claims at most one slot, so one anchoring value -- or several
 * equal ones, pinned or derived from the verifier's own identity -- anchors a
 * single slot and leaves the other to be anchored by something else or not at
 * all. Whether a value matched at all is reported separately from what it
 * anchored, so a value that matched a slot another value already claimed is not
 * reported as matching nothing.
 */
async function assignAnchors(
  record: DualSignedRecord,
  inputs: DualSignedRecordVerificationInputs,
): Promise<AnchorAssignment> {
  const pins = (inputs.pinnedFingerprints ?? []).filter(
    (fingerprint) => fingerprint.length > 0,
  );
  const [pinMatches, localMatches] = await Promise.all([
    Promise.all(pins.map((pin) => slotMatches(record, pin))),
    inputs.localIdentity === undefined
      ? undefined
      : slotMatches(record, inputs.localIdentity.fingerprint),
  ]);

  const anchors: [CertificateAnchorStatus, CertificateAnchorStatus] = [
    "unanchored",
    "unanchored",
  ];
  const claim = (
    matches: SlotMatches,
    anchor: CertificateAnchorStatus,
  ): void => {
    const at = matches.findIndex(
      (matched, slot) => matched && anchors[slot] === "unanchored",
    );
    if (at >= 0) anchors[at] = anchor;
  };
  // The pinned values go first: a pin is evidence about a party the verifier
  // cannot otherwise reach, while the local identity's slot is the one the
  // verifier could name either way.
  //
  // Two anchoring values that reach the same slots are the same fingerprint
  // whatever their spelling and wherever they came from -- each matched the
  // digest of the certificate in that slot -- so their match patterns
  // deduplicate the values without depending on how they were written. Without
  // that, one fingerprint supplied twice, or a pin equal to the verifier's own
  // identity, would claim both slots of a record whose two slots carry a single
  // certificate, and a record only that certificate's key holder can assemble --
  // both receipt signatures must verify under it -- would read as two
  // independent anchors. Values that reach NO slot share a pattern without being
  // one value; nothing turns on that, since none of them claims a slot anyway.
  const claimedPatterns = new Set<string>();
  const claimOnce = (
    matches: SlotMatches,
    anchor: CertificateAnchorStatus,
  ): void => {
    const pattern = matches.join(",");
    if (claimedPatterns.has(pattern)) return;
    claimedPatterns.add(pattern);
    claim(matches, anchor);
  };
  for (const matches of pinMatches) claimOnce(matches, "partner-pin");
  if (localMatches !== undefined) claimOnce(localMatches, "local-identity");

  const reached = (matches: SlotMatches): boolean => matches[0] || matches[1];
  return {
    anchors,
    pinnedFingerprints:
      pins.length === 0
        ? "not-supplied"
        : pinMatches.every(reached)
          ? "matched"
          : "unmatched",
    localIdentity:
      localMatches === undefined
        ? "not-supplied"
        : reached(localMatches)
          ? "matched"
          : "unmatched",
  };
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
 * self-signature), check what anchors its certificate outside the record (a
 * pinned fingerprint, or the caller's own signing identity), and check the
 * identity it authorizes when the caller supplies the expected pair. Beside those,
 * check the agreed-terms hash and -- against the exchange record for the run, when
 * the caller holds it -- that this receipt is that run's. Read-only; it never
 * mutates or re-signs the record.
 *
 * Returns a {@link DualSignedRecordVerificationReport} on the same tri-state as
 * the unsigned record's report, so "not checked" is never reported as "verified".
 * The report reaches `verified` only when BOTH certificates are anchored outside
 * the record -- each by a pinned fingerprint or by the verifier's own signing
 * identity: signature verification alone proves only that the holders of the two
 * embedded certificates' keys signed this content, which anyone can arrange with
 * two certificates of their own. A run that anchors one certificate, and the
 * third-party auditor's run that anchors neither, are both `incomplete`. A run
 * that pairs the receipt to no exchange record is `incomplete` for the same
 * reason: which of a recurring partnership's runs the receipt attests is open
 * until the record for one of them is beside it.
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
  const [initiatorChecks, responderChecks, anchoring] = await Promise.all([
    verifyParty(record.initiator, "initiator", record),
    verifyParty(record.responder, "responder", record),
    assignAnchors(record, inputs),
  ]);
  const identities = identityStatuses(record, inputs.expectedIdentities);

  const initiator: SignedReceiptPartyReport = {
    ...initiatorChecks,
    certificateAnchor: anchoring.anchors[0],
    assertedIdentity: identities[0],
  };
  const responder: SignedReceiptPartyReport = {
    ...responderChecks,
    certificateAnchor: anchoring.anchors[1],
    assertedIdentity: identities[1],
  };

  const termsHash: TermsHashStatus =
    inputs.expectedTermsHash === undefined
      ? "not-checked"
      : inputs.expectedTermsHash === record.content.termsHash
        ? "verified"
        : "mismatch";

  // Both values are public (the record publishes its binder, and the receipt is
  // signed over it), so this is an equality check like the terms hash above and
  // not a secret comparison.
  const runBinding: RunBindingStatus =
    inputs.recordReceiptBinder === undefined
      ? "not-checked"
      : inputs.recordReceiptBinder === null
        ? "unpaired"
        : inputs.recordReceiptBinder === record.content.binder
          ? "verified"
          : "mismatch";

  const parties = [initiator, responder];
  const anyMismatch =
    termsHash === "mismatch" ||
    // A receipt that does not pair with the record beside it is contradicted, not
    // merely unverified: whatever it attests, it does not attest that run. An
    // `unpaired` record states there is no receipt for it at all, which the
    // receipt in hand contradicts just as flatly.
    runBinding === "mismatch" ||
    runBinding === "unpaired" ||
    // A pinned value matching neither certificate says this record is not the
    // pinned party's. A resolved local identity matching neither says only that
    // the verifier was not a party to this exchange, so it is reported rather
    // than failed; one the verifier named asserts the opposite and fails.
    anchoring.pinnedFingerprints === "unmatched" ||
    (anchoring.localIdentity === "unmatched" &&
      inputs.localIdentity?.source === "named") ||
    parties.some(
      (party) =>
        party.certificateBinding === "failed" ||
        party.signature === "failed" ||
        party.assertedIdentity === "mismatch",
    );
  // The record carries two certificates and a verdict speaks for both, so an
  // unanchored slot holds the report short of `verified`: its certificate is one
  // whoever assembled the record could have minted.
  const anyUnverified =
    termsHash === "not-checked" ||
    // Without the run's record there is nothing to pair the receipt to, so which
    // run it attests is open -- every value its signatures cover that a verifier
    // can check repeats across runs of one partnership under one set of terms.
    runBinding === "not-checked" ||
    parties.some(
      (party) =>
        party.certificateAnchor === "unanchored" ||
        party.assertedIdentity === "not-checked",
    );

  const outcome: RecordVerificationOutcome = anyMismatch
    ? "failed"
    : anyUnverified
      ? "incomplete"
      : "verified";
  return {
    outcome,
    initiator,
    responder,
    pinnedFingerprints: anchoring.pinnedFingerprints,
    localIdentity: anchoring.localIdentity,
    termsHash,
    runBinding,
    binder: record.content.binder,
  };
}
