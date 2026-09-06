import {
  certificateAuthorizesIdentity,
  computeCertificateFingerprint,
  matchesPinnedFingerprint,
  verifyCertificateSelfSignature,
} from "./signingIdentity.js";
import { verifyReceiptSignature } from "./signedReceipt.js";
import { computeTermsHash } from "./exchangeRecord.js";

import type { ExchangeRecord } from "./exchangeRecord.js";
import type {
  RecordVerificationOutcome,
  TermsHashStatus,
} from "./recordVerification.js";
import type { DualSignedRecord, SignedReceiptParty } from "./signedReceipt.js";
import type { LinkageTerms } from "../config/linkageTermsSchema.js";
import type { HandshakeRole } from "../types.js";

// The verification consumer for the DUAL-SIGNED record (the signed evidence
// bundle the signed-receipt step produces): per party it checks the record's
// certificate, the receipt signature made under that certificate's key, what
// anchors the certificate outside the record, and the identity it authorizes.
// Read-only. Every check yields a status rather than throwing for a hostile
// field value; a structurally malformed record (no `content`, a party without
// a certificate) is a programming error and reaches a TypeError.
//
// Counterpart of recordVerification.ts, which checks the unsigned self-attested
// record's internal consistency instead (docs/spec/EXCHANGE_RECORD.md).
//
// The report reaches `verified` only when both certificates are anchored
// outside the record (a pinned fingerprint, or the verifier's own signing
// identity): signature verification alone proves only that whoever holds the
// two certificates' keys signed this content. Trust model:
// docs/spec/PROTOCOL.md, Signing identity and certificate pinning.

/**
 * Whether a certificate's own self-signature verifies. The self-signature covers
 * the certificate body -- version, algorithm, identity, and public key -- so this
 * is the certificate's IDENTITY BINDING: it is what ties the identity string the
 * certificate holds to the key that signed the receipt. `failed` means the
 * certificate does not bind its identity to its key (it was altered, or its key is
 * not a valid P-256 point), so nothing it holds can be attributed to that
 * identity.
 */
export type CertificateBindingStatus = "verified" | "failed";

/** Whether a party's receipt signature verifies against the certificate held
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
 *   identity. Certificates are public, so this only says whose certificate
 *   occupies the slot -- whoever assembled the record could have copied it in.
 *   The receipt signature there, which verifies only under the verifier's own
 *   private key, is what refuses a slot its holder did not sign.
 * - `unanchored`: nothing outside the record vouches for this certificate; a
 *   certificate the assembler minted itself can still satisfy every internal
 *   check (self-signature, content signature, expected identity).
 *
 * Each anchoring value reaches at most one certificate: two values matching the
 * same digest, however spelled or however they arrived, can never anchor both
 * slots.
 */
export type CertificateAnchorStatus =
  "partner-pin" | "local-identity" | "unanchored";

/**
 * What one anchoring value the verifier supplied reached in the record.
 * `unmatched` means it matches neither certificate.
 */
type AnchorMatchStatus = "matched" | "unmatched" | "not-supplied";

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
 * `receiptBinder` the exchange record for that run holds. Every run derives a
 * different binder from its own session key, so it is what separates one run of
 * a recurring partnership from the next -- the agreed-terms hash, identities,
 * and certificates all repeat byte for byte across such runs.
 *
 * - `verified`: the record and the receipt hold the same run's binder.
 * - `mismatch`: they hold different ones, so they are not the same run.
 * - `unpaired`: the record holds no binder at all (no signing identity, or a
 *   path with no session key) -- it records an exchange that produced no
 *   signed receipt, so no receipt belongs to it. A contradiction, not an
 *   unchecked box.
 * - `not-checked`: no record was supplied, so there is nothing to pair the
 *   receipt to. Holds the verdict short of `verified` without failing it.
 */
export type RunBindingStatus =
  "verified" | "mismatch" | "unpaired" | "not-checked";

/** One party's slot (`initiator` or `responder`) in a verified dual-signed
 * record. */
export interface SignedReceiptPartyReport {
  /** The handshake role whose slot this is; the record keys parties by role. */
  role: HandshakeRole;
  /** The identity the certificate in this slot holds. Free text supplied by
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
   * checked -- for example a certificate left unanchored. */
  outcome: RecordVerificationOutcome;
  initiator: SignedReceiptPartyReport;
  responder: SignedReceiptPartyReport;
  /**
   * What the fingerprints the verifier pinned reached: `matched` when every one
   * of them matches a certificate the record holds, `unmatched` when one
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
  /**
   * How that identity reached the verification, when one was supplied. The
   * outcome already turns on it -- what a non-match costs is the whole
   * difference between a contradiction and a note -- so the report states it
   * rather than leaving a consumer to infer it. Absent when no local identity
   * was supplied.
   */
  localIdentitySource?: LocalIdentitySource;
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
   * The per-exchange binder both signatures cover, verbatim from the record.
   * Derived from the exchange's session key, which neither party retains after
   * the run, so an offline verifier confirms only that the signers signed a
   * receipt holding THIS value against the run's own record ({@link
   * runBinding}), not that it derives from that session key. A binder
   * substituted into both artifacts is detectable only during the live
   * exchange, where each party derives it independently.
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
   * can vouch for: the partner's alone on a party's own run, or both parties'
   * for a verifier that was party to no exchange. Together with
   * {@link localIdentity}, these are what turn a self-consistent record into
   * evidence -- without an anchor on each certificate the report cannot reach
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
   * The `receiptBinder` of the exchange record this receipt is being read
   * beside, which pairs the receipt to one run: the value when that record
   * holds one, `null` when the record is in hand and holds NONE (an exchange
   * that produced no signed receipt, so no receipt belongs to it), or absent
   * when no record is in hand at all, leaving the pairing unchecked rather
   * than contradicted. The distinction is critical: passing `undefined` for a
   * record holding no binder would report a contradiction as an unchecked box.
   *
   * A verifier holding both parties' terms but no record still pairs nothing:
   * terms belong to a partnership, not to one run of it.
   */
  recordReceiptBinder?: string | null;
}

/**
 * Where the two identities the certificates must authorize, the agreed-terms hash
 * the receipt content must contain, and the run binder that pairs the receipt to
 * one exchange come from. The exchange record holds all three already, so a party
 * checking its own exchange supplies them by loading it; a verifier without the
 * record restates the first two from both parties' linkage terms, and pairs
 * nothing -- terms belong to a partnership, not to one run of it. With neither,
 * every check is reported as not performed rather than assumed -- which also holds
 * the verdict short of verified. A record is taken as the caller's own copy: every
 * anchor drawn from it makes the checks it feeds self-confirming when the record
 * arrived with the receipt, and the verdict then states only that the two
 * artifacts describe one run, the model docs/spec/EXCHANGE_RECORD.md sets out.
 */
export interface SignedRecordExpectationSources {
  record?: ExchangeRecord;
  localTerms?: LinkageTerms;
  partnerTerms?: LinkageTerms;
}

/**
 * The {@link DualSignedRecordVerificationInputs} fields a verifier draws from the
 * artifacts it already holds, so every surface anchors the signature checks to
 * the same values for one record rather than deriving them apiece.
 */
export async function signedRecordExpectations(
  sources: SignedRecordExpectationSources,
): Promise<
  Pick<
    DualSignedRecordVerificationInputs,
    "expectedIdentities" | "expectedTermsHash" | "recordReceiptBinder"
  >
> {
  const { record, localTerms, partnerTerms } = sources;
  if (record !== undefined)
    return {
      ...namedPair(record.localIdentity, record.partnerIdentity),
      expectedTermsHash: record.termsHash,
      // An explicit null for a record that holds no run binder, so a record of
      // an exchange that produced no receipt is reported as contradicting the
      // receipt loaded beside it rather than as a pairing nobody could check.
      recordReceiptBinder: record.receiptBinder ?? null,
    };
  if (localTerms === undefined || partnerTerms === undefined) return {};
  return {
    ...namedPair(localTerms.identity, partnerTerms.identity),
    expectedTermsHash: await computeTermsHash(localTerms, partnerTerms),
  };
}

/**
 * The `expectedIdentities` pair, present only where both parties named
 * themselves. `linkage_terms.identity` is optional, and an unnamed party has
 * nothing a certificate could be authorized against -- which is why an exchange
 * with one produces no receipt at all (`runExchange`). A half-pair would anchor
 * one signer while the other's identity check would still be reported as
 * performed, so the check is reported as not performed instead.
 */
function namedPair(
  local: string | undefined,
  partner: string | undefined,
): Pick<DualSignedRecordVerificationInputs, "expectedIdentities"> {
  return local === undefined || partner === undefined
    ? {}
    : { expectedIdentities: [local, partner] };
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
 * Assign the anchoring values the verifier holds to the record's two
 * certificate slots, as an assignment rather than a per-value test: equal
 * values count once, and each value claims at most one slot, leaving the
 * other to be anchored by something else or not at all. Whether a value
 * matched at all is reported separately from what it anchored, so a value
 * that matched an already-claimed slot is not reported as matching nothing.
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
  // Two anchoring values that reach the same slots are the same fingerprint,
  // however spelled or however they arrived -- each matched the digest of the
  // certificate in that slot -- so match patterns deduplicate the values
  // without depending on how they were written. Without that, a fingerprint
  // supplied twice, or a pin equal to the verifier's own identity, would count
  // as two independent anchors on a record whose two slots hold one identical
  // certificate.
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
 * canonical signed bytes and check the receipt signature, the certificate's
 * self-signature, what anchors the certificate outside the record, and (when
 * the caller supplies the expected pair) the identity it authorizes. Also
 * checks the agreed-terms hash and, against the exchange record for the run
 * when the caller holds it, that this receipt is that run's. Read-only.
 *
 * Returns a {@link DualSignedRecordVerificationReport} on the same tri-state
 * as the unsigned record's report, so "not checked" is never reported as
 * "verified". A run that anchors one certificate, and the third-party
 * auditor's run that anchors neither, are both `incomplete`; so is a run that
 * pairs the receipt to no exchange record, since which run of a recurring
 * partnership it attests is open until that run's record sits beside it.
 *
 * Fail-safe over field values: every check yields a status rather than an
 * exception however hostile the certificate and signature values are, so a
 * hostile record always produces a verdict. A structurally malformed record
 * is a programming error and reaches a TypeError instead. An unrecognized
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
  // The record holds two certificates and a verdict speaks for both, so an
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
    localIdentitySource: inputs.localIdentity?.source,
    termsHash,
    runBinding,
    binder: record.content.binder,
  };
}

// --- The verdict decision ----------------------------------------------------
//
// What a verification report MEANS to whoever reads it, decided once for every
// surface: the tier the whole verdict holds and the tier each row holds, which
// sentences an unanchored slot supports, and what a run has earned as
// remediation. A surface renders that decision in its own vocabulary -- console
// lines, or a page's alert rows -- and decides none of it, so no two surfaces
// can drift apart on which conditions grade a receipt incomplete rather than
// failed.
//
// Presentation is the surface's: nothing here holds display text, an exit code,
// or a colour. Free text the record supplies (a certificate identity, the
// binder) travels verbatim and is escaped by the surface at its display sink,
// the one altitude this project escapes at (CONTRIBUTING.md, Operator-facing
// escaping).

/**
 * The tier a verdict or one of its rows holds, which a surface renders in its
 * own emphasis. It is the display tier of ONE line rather than the outcome of the
 * verification: a row is `incomplete` when its own check could not be made,
 * whatever the whole record's outcome.
 */
type SignedReceiptVerdictTone = "verified" | "incomplete" | "failed";

/** A certificate anchor that reached a slot: what a verdict may name as having
 * anchored one, which excludes the case there is nothing to name. */
export type AnchoredCertificateStatus = Exclude<
  CertificateAnchorStatus,
  "unanchored"
>;

/**
 * A clause an unanchored slot's explanation may state, and no others: a check
 * that did not run, or one that ran and matched this very certificate, must not
 * be narrated as a check this certificate failed.
 *
 * - `no-pinned-value-matches`: a pinned value was supplied and this slot's
 *   certificate is not one it reached. Withheld while both slots hold ONE
 *   certificate, where the value anchoring the other slot matches this one too
 *   and what left this slot unanchored is that each value claims a single slot.
 * - `not-your-own-certificate`: the verifier's own certificate was compared
 *   against the record and reached neither slot.
 */
export type UnanchoredCertificateClause =
  "no-pinned-value-matches" | "not-your-own-certificate";

/** One decided row: the status the report states, and the tier it holds. */
export interface SignedReceiptVerdictCheck<Status> {
  status: Status;
  tone: SignedReceiptVerdictTone;
}

/** The certificate-anchor row. An `unanchored` status also holds the clauses
 * the report supports for it, in the order a surface states them; an anchored
 * slot holds none. */
export interface SignedReceiptVerdictAnchor extends SignedReceiptVerdictCheck<CertificateAnchorStatus> {
  unanchoredClauses: readonly UnanchoredCertificateClause[];
}

/** One party's decided slot in the verdict. */
export interface SignedReceiptVerdictParty {
  /** The handshake role whose slot this is. */
  role: HandshakeRole;
  /** The identity the certificate holds. Free text supplied by that party -- a
   * surface that renders it escapes it at its display sink. */
  identity: string;
  /** The fingerprint recomputed from the record, or `null` for a certificate
   * whose canonical bytes cannot be produced: a surface states that rather than
   * rendering an empty value where a fingerprint belongs. */
  fingerprint: string | null;
  certificateAnchor: SignedReceiptVerdictAnchor;
  certificateBinding: SignedReceiptVerdictCheck<CertificateBindingStatus>;
  signature: SignedReceiptVerdictCheck<ReceiptSignatureStatus>;
  assertedIdentity: SignedReceiptVerdictCheck<AssertedIdentityStatus>;
}

/** One slot the verdict names as anchored, and what anchored it. */
export interface AnchoredCertificateSlot {
  role: HandshakeRole;
  anchor: AnchoredCertificateStatus;
}

/**
 * The verdict's headline, by tier.
 *
 * The `verified` arm holds the two anchored slots typed so `unanchored` cannot
 * appear: a verified verdict speaks for both certificates, so a surface naming
 * what anchored each cannot claim an anchor that does not exist. The
 * `incomplete` arm names the slots nothing outside the record reaches, so the
 * reader need not find them among the rows.
 */
export type SignedReceiptVerdictHeadline =
  | { tone: "verified"; anchoredSlots: readonly AnchoredCertificateSlot[] }
  | { tone: "incomplete"; unanchoredRoles: readonly HandshakeRole[] }
  | { tone: "failed" };

/** The receipt-record pairing row. */
export interface SignedReceiptVerdictRunBinding extends SignedReceiptVerdictCheck<RunBindingStatus> {
  /**
   * Whether the run earned the advice to pair the two artifacts by the
   * timestamp stamp an exchange writes them under: earned by a pairing the
   * record in hand contradicts (another run, or an exchange with no receipt
   * at all), and not by one that held or one nothing was supplied to make.
   */
  pairByStamp: boolean;
}

/**
 * What a run has earned as remediation, in the order a surface states it. Each
 * case stands on its own: a run may be short an anchor, or hold one that belongs
 * to another exchange entirely.
 *
 * - `pinned-fingerprint-unmatched`: a pinned value matches neither certificate,
 *   so this is not the record of the party the verifier pinned.
 * - `named-local-identity-unmatched`: the signing identity the verifier NAMED for
 *   this run is neither certificate, so this is not a receipt they signed.
 * - `resolved-local-identity-unmatched`: an identity found without being asked is
 *   neither certificate. It anchors nothing and contradicts nothing -- the
 *   verifier was not a party to this exchange, or has re-keyed since.
 * - `no-certificate-anchored`: nothing ties either certificate to a party the
 *   verifier knows, and no pinned value reached the run -- a pinned value that
 *   matched anchors the slot it matched, and one that matched nothing is the
 *   contradiction above rather than a run short of anchors.
 * - `certificate-unanchored`: one slot is anchored and the other is not, which is
 *   what holds the verdict short of verified.
 */
export type SignedReceiptVerdictGuidance =
  | { kind: "pinned-fingerprint-unmatched" }
  | { kind: "named-local-identity-unmatched" }
  | { kind: "resolved-local-identity-unmatched" }
  | { kind: "no-certificate-anchored" }
  | { kind: "certificate-unanchored"; role: HandshakeRole };

/** The decided verdict over a {@link DualSignedRecordVerificationReport}. */
export interface SignedReceiptVerdict {
  headline: SignedReceiptVerdictHeadline;
  /** Both slots, in the record's own order (initiator, then responder). */
  parties: readonly [SignedReceiptVerdictParty, SignedReceiptVerdictParty];
  termsHash: SignedReceiptVerdictCheck<TermsHashStatus>;
  runBinding: SignedReceiptVerdictRunBinding;
  /** Empty when the run has earned no remediation: every certificate is anchored
   * and every anchoring value the verifier supplied reached one. */
  guidance: readonly SignedReceiptVerdictGuidance[];
  /** The per-exchange binder, verbatim from the report. Reported, never
   * recomputed -- deriving it needs the exchange session key. A surface escapes
   * it at its display sink. */
  binder: string;
}

// Every status across the report's rows, each mapping to one tier: a single table
// rather than one per row keeps two rows reporting the same word from grading it
// differently.
const STATUS_TONE: Record<
  | CertificateAnchorStatus
  | CertificateBindingStatus
  | ReceiptSignatureStatus
  | AssertedIdentityStatus
  | TermsHashStatus
  | RunBindingStatus,
  SignedReceiptVerdictTone
> = {
  verified: "verified",
  failed: "failed",
  mismatch: "failed",
  unpaired: "failed",
  "partner-pin": "verified",
  "local-identity": "verified",
  unanchored: "incomplete",
  "not-checked": "incomplete",
};

function decideCheck<Status extends keyof typeof STATUS_TONE>(
  status: Status,
): SignedReceiptVerdictCheck<Status> {
  return { status, tone: STATUS_TONE[status] };
}

function unanchoredClauses(
  party: SignedReceiptPartyReport,
  other: SignedReceiptPartyReport,
  report: DualSignedRecordVerificationReport,
): UnanchoredCertificateClause[] {
  const clauses: UnanchoredCertificateClause[] = [];
  if (
    report.pinnedFingerprints !== "not-supplied" &&
    other.fingerprint !== party.fingerprint
  )
    clauses.push("no-pinned-value-matches");
  if (report.localIdentity === "unmatched")
    clauses.push("not-your-own-certificate");
  return clauses;
}

function decideParty(
  party: SignedReceiptPartyReport,
  other: SignedReceiptPartyReport,
  report: DualSignedRecordVerificationReport,
): SignedReceiptVerdictParty {
  return {
    role: party.role,
    identity: party.identity,
    fingerprint:
      party.fingerprint === UNEVALUABLE_FINGERPRINT ? null : party.fingerprint,
    certificateAnchor: {
      ...decideCheck(party.certificateAnchor),
      unanchoredClauses:
        party.certificateAnchor === "unanchored"
          ? unanchoredClauses(party, other, report)
          : [],
    },
    certificateBinding: decideCheck(party.certificateBinding),
    signature: decideCheck(party.signature),
    assertedIdentity: decideCheck(party.assertedIdentity),
  };
}

// The anchoring assignment produces the three CertificateAnchorStatus values and
// nothing else, so a status from outside them reaches the decision only from a
// caller that stepped past the type. Every tier of the verdict words the slot
// from that status -- the verified headline names what anchored each
// certificate, and the degraded ones still hold the row -- so an unnamed status
// is a sentence naming an anchor that exists nowhere. Refused for the whole
// decision rather than the verified arm alone.
function refuseAnchorOutsideTheUnion(party: SignedReceiptPartyReport): void {
  if (
    party.certificateAnchor !== "partner-pin" &&
    party.certificateAnchor !== "local-identity" &&
    party.certificateAnchor !== "unanchored"
  )
    throw new Error(
      `a dual-signed record reports the ${party.role}'s certificate anchor ` +
        `as ${party.certificateAnchor}: the verdict would have a status no ` +
        "surface has words for",
    );
}

function anchoredSlot(
  party: SignedReceiptPartyReport,
): AnchoredCertificateSlot {
  // The verifier reaches `verified` only once both certificates are anchored, so
  // a verified headline always has a source to name for each slot. Were that to
  // stop holding, every surface's sentence would claim an anchor that does not
  // exist -- evidence overstated -- so the verdict fails loudly here instead, once
  // for all of them.
  if (party.certificateAnchor === "unanchored")
    throw new Error(
      `a verified dual-signed record leaves the ${party.role}'s certificate ` +
        "unanchored: the verdict would claim both certificates were anchored " +
        "when one was not",
    );
  return { role: party.role, anchor: party.certificateAnchor };
}

function decideHeadline(
  report: DualSignedRecordVerificationReport,
  parties: readonly SignedReceiptPartyReport[],
  unanchored: readonly SignedReceiptPartyReport[],
): SignedReceiptVerdictHeadline {
  if (report.outcome === "failed") return { tone: "failed" };
  if (report.outcome === "incomplete")
    return {
      tone: "incomplete",
      unanchoredRoles: unanchored.map((party) => party.role),
    };
  return { tone: "verified", anchoredSlots: parties.map(anchoredSlot) };
}

function decideGuidance(
  report: DualSignedRecordVerificationReport,
  parties: readonly SignedReceiptPartyReport[],
  unanchored: readonly SignedReceiptPartyReport[],
): SignedReceiptVerdictGuidance[] {
  const guidance: SignedReceiptVerdictGuidance[] = [];
  if (report.pinnedFingerprints === "unmatched")
    guidance.push({ kind: "pinned-fingerprint-unmatched" });
  const localUnmatched = report.localIdentity === "unmatched";
  if (localUnmatched && report.localIdentitySource === "named")
    guidance.push({ kind: "named-local-identity-unmatched" });
  // Reported only while a slot is still waiting to be anchored; beside a fully
  // anchored record it adds nothing.
  else if (
    localUnmatched &&
    report.localIdentitySource === "resolved" &&
    unanchored.length > 0
  )
    guidance.push({ kind: "resolved-local-identity-unmatched" });

  // How to reach a verified verdict, but only while the anchors the run does hold
  // are sound: a value that reached neither certificate is answered by the case
  // above, and telling the verifier to supply more would talk past it.
  const anchorContradicted =
    report.pinnedFingerprints === "unmatched" ||
    (localUnmatched && report.localIdentitySource === "named");
  if (anchorContradicted) return guidance;

  if (unanchored.length === parties.length) {
    // A pinned value that matched a certificate anchored the slot it matched, and
    // one that matched none is the contradiction handled above, so a run with
    // nothing anchored supplied no pinned value. Were that to stop holding, the
    // line below would tell the verifier to pin a fingerprint they had already
    // pinned, so the verdict refuses the report instead.
    if (report.pinnedFingerprints !== "not-supplied")
      throw new Error(
        "a dual-signed record anchors neither certificate while a pinned " +
          `fingerprint is reported as ${report.pinnedFingerprints}: the ` +
          "guidance would ask for a pinned value that was already supplied",
      );
    guidance.push({ kind: "no-certificate-anchored" });
  } else
    for (const slot of unanchored)
      guidance.push({ kind: "certificate-unanchored", role: slot.role });
  return guidance;
}

/** What a verdict states beside the headline, the guidance, and the binder
 * decided over it: the rows themselves. */
type DecidedVerdictRows = Omit<
  SignedReceiptVerdict,
  "headline" | "guidance" | "binder"
>;

function partyRows(
  party: SignedReceiptVerdictParty,
): Array<[string, SignedReceiptVerdictCheck<string>]> {
  const rows: Record<
    Exclude<
      keyof SignedReceiptVerdictParty,
      "role" | "identity" | "fingerprint"
    >,
    [string, SignedReceiptVerdictCheck<string>]
  > = {
    certificateAnchor: [
      `the ${party.role}'s certificate anchor`,
      party.certificateAnchor,
    ],
    certificateBinding: [
      `the ${party.role}'s certificate binding`,
      party.certificateBinding,
    ],
    signature: [`the ${party.role}'s receipt signature`, party.signature],
    assertedIdentity: [
      `the ${party.role}'s asserted identity`,
      party.assertedIdentity,
    ],
  };
  return Object.values(rows);
}

/** Every decided row under the headline, named as a reader meets it. */
function decidedRows(
  verdict: DecidedVerdictRows,
): Array<[string, SignedReceiptVerdictCheck<string>]> {
  // Keyed by the members the rows are drawn from rather than listed loose, so a
  // row added to the verdict later cannot fall outside the refusals that read
  // this list: the mapping stops compiling until it names the new member.
  const rows: Record<
    keyof DecidedVerdictRows,
    Array<[string, SignedReceiptVerdictCheck<string>]>
  > = {
    termsHash: [["the agreed-terms hash", verdict.termsHash]],
    runBinding: [["the receipt-record pairing", verdict.runBinding]],
    parties: verdict.parties.flatMap(partyRows),
  };
  return Object.values(rows).flat();
}

/**
 * Decide what a {@link DualSignedRecordVerificationReport} means to a reader:
 * the tier of the verdict and of every row it holds, which sentences an
 * unanchored slot supports, whether the two artifacts should be paired by
 * their stamp, and what remediation the run has earned. Pure over the report
 * -- it re-derives no check and claims no anchor and no comparison the
 * verification did not make.
 *
 * Every surface renders this one decision, so a receipt's verdict does not
 * depend on which of them a reader is holding.
 *
 * Total over a report {@link verifyDualSignedRecord} produces. Its refusals
 * are a report contradicting itself, which only a hand-built one can state: a
 * verdict speaking for a slot nothing anchors, a verified verdict over a row
 * reported as failed, a run anchoring neither certificate beside a pinned
 * value that reached one, a local identity reported as matching neither
 * certificate without stating how it reached the verification, or a
 * certificate anchor from outside the {@link CertificateAnchorStatus} union.
 */
export function decideSignedReceiptVerdict(
  report: DualSignedRecordVerificationReport,
): SignedReceiptVerdict {
  if (
    report.localIdentity === "unmatched" &&
    report.localIdentitySource === undefined
  )
    throw new Error(
      "a signing identity matched neither certificate in this record, and how " +
        "it reached the verification was not stated: a named identity " +
        "contradicts the record, one resolved without being asked does not",
    );
  const parties = [report.initiator, report.responder];
  for (const party of parties) refuseAnchorOutsideTheUnion(party);
  const unanchored = parties.filter(
    (party) => party.certificateAnchor === "unanchored",
  );
  const decided: DecidedVerdictRows = {
    parties: [
      decideParty(report.initiator, report.responder, report),
      decideParty(report.responder, report.initiator, report),
    ],
    termsHash: decideCheck(report.termsHash),
    runBinding: {
      ...decideCheck(report.runBinding),
      pairByStamp:
        report.runBinding === "mismatch" || report.runBinding === "unpaired",
    },
  };
  const headline = decideHeadline(report, parties, unanchored);
  // The verification withholds `verified` while any check it made was
  // contradicted, so a verified headline always sits over rows that all passed.
  // Were that to stop holding, every surface would render a verified verdict over
  // a row that failed -- evidence overstated -- so the verdict fails loudly
  // here instead, once for all of them, as the unanchored slot above does.
  if (headline.tone === "verified") {
    const failed = decidedRows(decided).find(
      ([, row]) => row.tone === "failed",
    );
    if (failed !== undefined)
      throw new Error(
        `a verified dual-signed record reports ${failed[0]} as ` +
          `${failed[1].status}: the verdict would read verified over a row ` +
          "that failed",
      );
  }
  return {
    headline,
    ...decided,
    guidance: decideGuidance(report, parties, unanchored),
    binder: report.binder,
  };
}

/**
 * The verified verdict's clause naming what anchored each certificate --
 * "the initiator's by X, and the responder's by Y". A surface supplies the words
 * for each anchoring source, which name that surface's own way of supplying one;
 * the sentence they are assembled into is the same on all of them.
 *
 * The verified verdict holds only slots something anchored, so there is no
 * unanchored case to leave unnamed.
 */
export function anchorsPhrase(
  slots: readonly AnchoredCertificateSlot[],
  sourcePhrases: Record<AnchoredCertificateStatus, string>,
): string {
  return slots
    .map((slot) => `the ${slot.role}'s by ${sourcePhrases[slot.anchor]}`)
    .join(", and ");
}
