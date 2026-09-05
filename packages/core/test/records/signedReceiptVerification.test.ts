import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import {
  SIGNED_RECEIPT_VERSION,
  parseDualSignedRecord,
  signReceiptContent,
} from "../../src/records/signedReceipt";
import {
  decideSignedReceiptVerdict,
  verifyDualSignedRecord,
} from "../../src/records/signedReceiptVerification";
import {
  computeCertificateFingerprint,
  generateSigningIdentity,
} from "../../src/records/signingIdentity";

import type {
  DualSignedRecord,
  ReceiptContent,
  SignedReceiptParty,
} from "../../src/records/signedReceipt";
import type {
  CertificateAnchorStatus,
  DualSignedRecordVerificationReport,
  SignedReceiptPartyReport,
  SignedReceiptVerdict,
} from "../../src/records/signedReceiptVerification";
import type {
  P256PrivateJwk,
  SigningIdentity,
} from "../../src/records/signingIdentity";
import type { HandshakeRole } from "../../src/types";

// The verification consumer for the dual-signed record: what a party (or an
// auditor) can establish from the stored artifact alone, and what it cannot. The
// classes covered are a valid record, a tampered field, a bad signature, a
// mismatched pin, a broken identity binding, and the unpinned auditor case; the
// bundle at the end was signed entirely outside this codebase.

// Fixed keys so the fixtures are reproducible: crypto.subtle.generateKey takes no
// seed, so a fixed key -- not a seed -- is what makes an identity reproducible.
const keyA: P256PrivateJwk = {
  kty: "EC",
  crv: "P-256",
  x: "TGM247iz3ncbYTocehc0g0zWnBpPX_7LJAxjvA3bFXQ",
  y: "9olsXRTKROADd5HCMAMzJZpxuQHlJYV10QfluKxItCQ",
  d: "ERITFBUWFxgZGhscHR4fICEiIyQlJicoKSorLC0uLzA",
};
const keyB: P256PrivateJwk = {
  kty: "EC",
  crv: "P-256",
  x: "UUL0inyAyvR1RKQo_FfScqbGeK1ek__Lo2ZmqZY55R0",
  y: "0b22-1mBRFZ6Jlfo_zYZ-6oM0qBAwZqyKvkQxwWnV7o",
  d: "ZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXp7fH1-f4CBgoM",
};
const keyC: P256PrivateJwk = {
  kty: "EC",
  crv: "P-256",
  x: "HxQBRr-xslH4T03b4NTNz9d6_ZhKlSDjV5QCH4MSu54",
  y: "7JlaCLH6dwTfPcwLUKlmUmP7dxH5X5-KRJxQluR8iSs",
  d: "ISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0-P0A",
};

const identityA = await generateSigningIdentity("Party A", {
  privateKey: keyA,
});
const identityB = await generateSigningIdentity("Party B", {
  privateKey: keyB,
});
const outsider = await generateSigningIdentity("Party C", {
  privateKey: keyC,
});

const fingerprintA = await computeCertificateFingerprint(identityA.certificate);
const fingerprintB = await computeCertificateFingerprint(identityB.certificate);
const fingerprintC = await computeCertificateFingerprint(outsider.certificate);

const TERMS_HASH = "dGVybXNIYXNo";
// The run binder both the receipt content and the exchange record for that run
// hold; one constant so the fixture and the pairing input cannot drift apart.
const BINDER = "YmluZGVy";

function content(overrides: Partial<ReceiptContent> = {}): ReceiptContent {
  return {
    termsHash: TERMS_HASH,
    initiatorToResponderPayload: "aTJyUGF5bG9hZA",
    responderToInitiatorPayload: "cjJpUGF5bG9hZA",
    binder: BINDER,
    ...overrides,
  };
}

/** A well-formed dual-signed record: A as initiator, B as responder, each signing
 * the shared content bound to its own fingerprint and role. */
async function signedRecord(
  shared: ReceiptContent = content(),
  parties: { initiator: SigningIdentity; responder: SigningIdentity } = {
    initiator: identityA,
    responder: identityB,
  },
): Promise<DualSignedRecord> {
  const [initiator, responder] = await Promise.all([
    signReceiptContent(parties.initiator, shared, "initiator"),
    signReceiptContent(parties.responder, shared, "responder"),
  ]);
  return {
    version: SIGNED_RECEIPT_VERSION,
    content: shared,
    initiator: {
      certificate: parties.initiator.certificate,
      signature: initiator,
    },
    responder: {
      certificate: parties.responder.certificate,
      signature: responder,
    },
  };
}

/** The same record with a responder certificate whose canonical bytes cannot be
 * produced, so that slot cannot be evaluated at all. */
function withUnevaluableResponder(record: DualSignedRecord): DualSignedRecord {
  return {
    ...record,
    responder: {
      ...record.responder,
      certificate: { ...record.responder.certificate, identity: undefined },
    },
  } as unknown as DualSignedRecord;
}

// What a party holding its own exchange record supplies: the partner's pin, its
// own signing identity (found from the same config rather than restated), and both
// parties' identities, agreed-terms hash, and the run binder that record holds.
// Party A is the initiator here, so its own identity anchors that slot and the pin
// anchors the responder's.
const fullyAnchored = {
  pinnedFingerprints: [fingerprintB],
  localIdentity: { fingerprint: fingerprintA, source: "resolved" } as const,
  expectedIdentities: ["Party A", "Party B"] as readonly [string, string],
  expectedTermsHash: TERMS_HASH,
  recordReceiptBinder: BINDER,
};

describe("verifyDualSignedRecord", () => {
  test("a valid record, both certificates anchored, verifies", async () => {
    const report = await verifyDualSignedRecord(
      await signedRecord(),
      fullyAnchored,
    );
    expect(report.outcome).toBe("verified");
    expect(report.initiator.signature).toBe("verified");
    expect(report.responder.signature).toBe("verified");
    expect(report.initiator.certificateBinding).toBe("verified");
    expect(report.responder.certificateBinding).toBe("verified");
    expect(report.initiator.assertedIdentity).toBe("verified");
    expect(report.responder.assertedIdentity).toBe("verified");
    expect(report.termsHash).toBe("verified");
    // Each slot names what anchored it: the verifier pins its PARTNER, and its
    // own certificate is anchored by the signing identity it holds.
    expect(report.responder.certificateAnchor).toBe("partner-pin");
    expect(report.initiator.certificateAnchor).toBe("local-identity");
    expect(report.pinnedFingerprints).toBe("matched");
    expect(report.localIdentity).toBe("matched");
    // The outcome turns on how that identity reached the verification, so the
    // report states it rather than leaving a consumer to hold it alongside.
    expect(report.localIdentitySource).toBe("resolved");
    // The report names each party and its fingerprint so an operator can see
    // whose certificate was checked.
    expect(report.initiator.fingerprint).toBe(fingerprintA);
    expect(report.responder.fingerprint).toBe(fingerprintB);
    expect(report.initiator.identity).toBe("Party A");
  });

  test("two pinned values anchor both slots for a verifier that was party to neither", async () => {
    // The general mechanism, and the only one open to a verifier with no signing
    // identity of its own: a fingerprint held out-of-band for each signer.
    const report = await verifyDualSignedRecord(await signedRecord(), {
      pinnedFingerprints: [fingerprintB, fingerprintA],
      expectedIdentities: ["Party A", "Party B"],
      expectedTermsHash: TERMS_HASH,
      recordReceiptBinder: BINDER,
    });
    expect(report.outcome).toBe("verified");
    expect(report.initiator.certificateAnchor).toBe("partner-pin");
    expect(report.responder.certificateAnchor).toBe("partner-pin");
    expect(report.localIdentity).toBe("not-supplied");
    expect(report.localIdentitySource).toBeUndefined();
  });

  test("one anchored certificate is incomplete, never verified", async () => {
    // Everything the record can say about itself checks out; what is missing is
    // anything outside it vouching for the initiator's certificate, which whoever
    // assembled the record could have minted.
    const report = await verifyDualSignedRecord(await signedRecord(), {
      pinnedFingerprints: [fingerprintB],
      expectedIdentities: ["Party A", "Party B"],
      expectedTermsHash: TERMS_HASH,
    });
    expect(report.outcome).toBe("incomplete");
    expect(report.responder.certificateAnchor).toBe("partner-pin");
    expect(report.initiator.certificateAnchor).toBe("unanchored");
    expect(report.initiator.signature).toBe("verified");
    expect(report.initiator.assertedIdentity).toBe("verified");
    expect(report.termsHash).toBe("verified");
  });

  test("one pinned value cannot anchor both certificates", async () => {
    // A record whose two slots hold the same certificate would otherwise let a
    // single pin claim both and reach verified; each anchoring value claims at
    // most one slot, so the second is left for something else to anchor.
    const record = await signedRecord(content(), {
      initiator: identityA,
      responder: identityA,
    });
    const report = await verifyDualSignedRecord(record, {
      pinnedFingerprints: [fingerprintA],
      expectedIdentities: ["Party A", "Party A"],
      expectedTermsHash: TERMS_HASH,
    });
    expect(report.initiator.certificateAnchor).toBe("partner-pin");
    expect(report.responder.certificateAnchor).toBe("unanchored");
    expect(report.outcome).toBe("incomplete");
  });

  test("the same fingerprint pinned twice cannot anchor both slots of a repeated certificate", async () => {
    // The record anyone can assemble from a single certificate, against the pin
    // supplied twice: without the pinned values counting once, the two of them
    // would claim a slot each and a record with one signer behind both slots
    // would reach verified.
    const record = await signedRecord(content(), {
      initiator: identityA,
      responder: identityA,
    });
    const report = await verifyDualSignedRecord(record, {
      pinnedFingerprints: [fingerprintA, fingerprintA],
      expectedIdentities: ["Party A", "Party A"],
      expectedTermsHash: TERMS_HASH,
    });
    expect(report.outcome).toBe("incomplete");
    expect(report.initiator.certificateAnchor).toBe("partner-pin");
    expect(report.responder.certificateAnchor).toBe("unanchored");
  });

  test("a pin equal to the verifier's own identity cannot anchor both slots of a repeated certificate", async () => {
    // The same record against a verifier that pinned its OWN fingerprint: the
    // pin and the identity hold one digest, so they are one anchoring value
    // and claim one slot between them, not a slot each.
    const record = await signedRecord(content(), {
      initiator: identityA,
      responder: identityA,
    });
    const report = await verifyDualSignedRecord(record, {
      pinnedFingerprints: [fingerprintA],
      localIdentity: { fingerprint: fingerprintA, source: "resolved" },
      expectedIdentities: ["Party A", "Party A"],
      expectedTermsHash: TERMS_HASH,
    });
    expect(report.outcome).toBe("incomplete");
    expect(report.initiator.certificateAnchor).toBe("partner-pin");
    expect(report.responder.certificateAnchor).toBe("unanchored");
    // Both values did reach a certificate, so neither is reported as matching
    // nothing: the run is short an anchor, not contradicted.
    expect(report.pinnedFingerprints).toBe("matched");
    expect(report.localIdentity).toBe("matched");
  });

  test("a named self-pin equal to the local identity still leaves the repeated slot unanchored", async () => {
    // The `named` source asserts the record is one the verifier signed, which is
    // true here, so nothing fails; what the dedup withholds is the second
    // anchor.
    const record = await signedRecord(content(), {
      initiator: identityA,
      responder: identityA,
    });
    const report = await verifyDualSignedRecord(record, {
      pinnedFingerprints: [fingerprintA],
      localIdentity: { fingerprint: fingerprintA, source: "named" },
      expectedIdentities: ["Party A", "Party A"],
      expectedTermsHash: TERMS_HASH,
    });
    expect(report.outcome).toBe("incomplete");
    expect(report.responder.certificateAnchor).toBe("unanchored");
  });

  test("one fingerprint spelled two ways is still one pinned value", async () => {
    // The pinned values are compared as digests rather than strings, so an
    // unpadded fingerprint and its padded spelling are the same value; counting
    // them separately would anchor both slots of a repeated certificate.
    const record = await signedRecord(content(), {
      initiator: identityA,
      responder: identityA,
    });
    const report = await verifyDualSignedRecord(record, {
      pinnedFingerprints: [fingerprintA, `${fingerprintA}=`],
      expectedIdentities: ["Party A", "Party A"],
      expectedTermsHash: TERMS_HASH,
    });
    expect(report.outcome).toBe("incomplete");
    expect(report.responder.certificateAnchor).toBe("unanchored");
  });

  test("the same fingerprint pinned twice anchors one certificate, and is no mismatch", async () => {
    const report = await verifyDualSignedRecord(await signedRecord(), {
      ...fullyAnchored,
      pinnedFingerprints: [fingerprintB, fingerprintB],
      localIdentity: undefined,
    });
    expect(report.responder.certificateAnchor).toBe("partner-pin");
    expect(report.initiator.certificateAnchor).toBe("unanchored");
    // Both values did match a certificate, so neither says this is the wrong
    // record: the run is short an anchor, not contradicted.
    expect(report.pinnedFingerprints).toBe("matched");
    expect(report.outcome).toBe("incomplete");
  });

  test("the binder is reported verbatim, not recomputed", async () => {
    // Recomputing it would need the exchange's session key, which the record
    // never holds and neither party retains: the verifier can only confirm that
    // the signers signed a receipt holding this value, and that the record for the
    // run holds the same one.
    const report = await verifyDualSignedRecord(
      await signedRecord(content({ binder: "b3RoZXJCaW5kZXI" })),
      { ...fullyAnchored, recordReceiptBinder: "b3RoZXJCaW5kZXI" },
    );
    expect(report.binder).toBe("b3RoZXJCaW5kZXI");
    expect(report.runBinding).toBe("verified");
    expect(report.outcome).toBe("verified");
  });

  test("a run binder from another run of this partnership is a mismatch", async () => {
    // The failure class this pairing exists for: a genuine receipt of one run read
    // beside the record of another. Nothing else separates them -- same terms hash,
    // same certificates, same identities.
    const report = await verifyDualSignedRecord(await signedRecord(), {
      ...fullyAnchored,
      recordReceiptBinder: "b3RoZXJCaW5kZXI",
    });
    expect(report.outcome).toBe("failed");
    expect(report.runBinding).toBe("mismatch");
    expect(report.termsHash).toBe("verified");
    expect(report.initiator.signature).toBe("verified");
    expect(report.responder.signature).toBe("verified");
  });

  test("a record holding no run binder reports the receipt as unpaired", async () => {
    // An explicit null: the record is in hand and records an exchange that produced
    // no signed receipt, so the receipt beside it is contradicted rather than
    // unchecked.
    const report = await verifyDualSignedRecord(await signedRecord(), {
      ...fullyAnchored,
      recordReceiptBinder: null,
    });
    expect(report.outcome).toBe("failed");
    expect(report.runBinding).toBe("unpaired");
    expect(report.initiator.signature).toBe("verified");
  });

  test("no record at all leaves the pairing unchecked and the verdict incomplete", async () => {
    // The holder of the receipt alone: nothing to pair it to, so which run of this
    // partnership it attests is open. Reported, never failed.
    const report = await verifyDualSignedRecord(await signedRecord(), {
      ...fullyAnchored,
      recordReceiptBinder: undefined,
    });
    expect(report.outcome).toBe("incomplete");
    expect(report.runBinding).toBe("not-checked");
    expect(report.termsHash).toBe("verified");
    expect(report.initiator.certificateAnchor).toBe("local-identity");
    expect(report.responder.certificateAnchor).toBe("partner-pin");
  });

  test("verification does not mutate the record (read-only)", async () => {
    const record = await signedRecord();
    const before = JSON.stringify(record);
    await verifyDualSignedRecord(record, fullyAnchored);
    expect(JSON.stringify(record)).toBe(before);
  });

  // --- The third-party auditor -----------------------------------------------

  test("with nothing anchoring either certificate the signatures still verify, but the outcome is incomplete", async () => {
    const report = await verifyDualSignedRecord(await signedRecord());
    expect(report.outcome).toBe("incomplete");
    expect(report.initiator.signature).toBe("verified");
    expect(report.responder.signature).toBe("verified");
    expect(report.initiator.certificateBinding).toBe("verified");
    expect(report.responder.certificateBinding).toBe("verified");
    expect(report.initiator.certificateAnchor).toBe("unanchored");
    expect(report.responder.certificateAnchor).toBe("unanchored");
    expect(report.pinnedFingerprints).toBe("not-supplied");
    expect(report.localIdentity).toBe("not-supplied");
    expect(report.initiator.assertedIdentity).toBe("not-checked");
    expect(report.termsHash).toBe("not-checked");
  });

  test("a signing identity found rather than named is reported when it anchors nothing", async () => {
    // The verifier did not claim this record is one it signed -- psilink found
    // the identity on its behalf -- so a non-match says only that this is not its
    // exchange, and leaves the slot unanchored rather than contradicting the run.
    const report = await verifyDualSignedRecord(await signedRecord(), {
      ...fullyAnchored,
      localIdentity: { fingerprint: fingerprintC, source: "resolved" },
    });
    expect(report.outcome).toBe("incomplete");
    expect(report.localIdentity).toBe("unmatched");
    expect(report.initiator.certificateAnchor).toBe("unanchored");
    // A rotated local identity does not paint the partner's anchored slot: the
    // pin reached it, and that stands on its own.
    expect(report.responder.certificateAnchor).toBe("partner-pin");
  });

  test("a signing identity the verifier named must be one of the certificates", async () => {
    // Naming it asserts this is a receipt the verifier signed, so a value
    // matching neither certificate contradicts the run rather than falling short.
    const report = await verifyDualSignedRecord(await signedRecord(), {
      ...fullyAnchored,
      localIdentity: { fingerprint: fingerprintC, source: "named" },
    });
    expect(report.outcome).toBe("failed");
    expect(report.localIdentity).toBe("unmatched");
    expect(report.responder.certificateAnchor).toBe("partner-pin");
    expect(report.initiator.signature).toBe("verified");
  });

  test("a self-consistent record minted by an outsider never reaches verified without a pin", async () => {
    // Signature verification alone proves only that the holders of the embedded
    // certificates' keys signed this content, which anyone can arrange. The pin
    // is what makes it evidence.
    const forged = await signedRecord(content(), {
      initiator: outsider,
      responder: outsider,
    });
    const report = await verifyDualSignedRecord(forged, {
      expectedTermsHash: TERMS_HASH,
    });
    expect(report.initiator.signature).toBe("verified");
    expect(report.responder.signature).toBe("verified");
    expect(report.outcome).toBe("incomplete");
  });

  // --- Failure classes -------------------------------------------------------

  test("a tampered content field fails both signatures", async () => {
    const record = await signedRecord();
    const tampered: DualSignedRecord = {
      ...record,
      content: { ...record.content, termsHash: "dGFtcGVyZWQ" },
    };
    const report = await verifyDualSignedRecord(tampered, fullyAnchored);
    expect(report.outcome).toBe("failed");
    expect(report.initiator.signature).toBe("failed");
    expect(report.responder.signature).toBe("failed");
    // The altered field is also caught directly by the terms-hash check.
    expect(report.termsHash).toBe("mismatch");
  });

  test("a bad signature fails that party alone", async () => {
    const record = await signedRecord();
    const other = await signReceiptContent(
      identityA,
      content({ binder: "ZGlmZmVyZW50" }),
      "initiator",
    );
    const report = await verifyDualSignedRecord(
      { ...record, initiator: { ...record.initiator, signature: other } },
      fullyAnchored,
    );
    expect(report.outcome).toBe("failed");
    expect(report.initiator.signature).toBe("failed");
    expect(report.responder.signature).toBe("verified");
    expect(report.initiator.certificateBinding).toBe("verified");
  });

  test("a malformed signature is a failure, not a throw", async () => {
    const record = await signedRecord();
    const report = await verifyDualSignedRecord(
      { ...record, responder: { ...record.responder, signature: "AAAA" } },
      fullyAnchored,
    );
    expect(report.outcome).toBe("failed");
    expect(report.responder.signature).toBe("failed");
  });

  test("swapped signature blocks do not verify", async () => {
    // Each party signs bytes naming its own fingerprint and role, so the two
    // blocks are not interchangeable.
    const record = await signedRecord();
    const swapped: DualSignedRecord = {
      ...record,
      initiator: record.responder,
      responder: record.initiator,
    };
    const report = await verifyDualSignedRecord(swapped, fullyAnchored);
    expect(report.outcome).toBe("failed");
    expect(report.initiator.signature).toBe("failed");
    expect(report.responder.signature).toBe("failed");
  });

  test("a fingerprint matching neither certificate fails the run", async () => {
    const report = await verifyDualSignedRecord(await signedRecord(), {
      ...fullyAnchored,
      pinnedFingerprints: [fingerprintC],
    });
    expect(report.outcome).toBe("failed");
    expect(report.pinnedFingerprints).toBe("unmatched");
    // The failure is attributed to the pin, not to the slot the verifier's own
    // identity anchored: that anchor holds regardless.
    expect(report.initiator.certificateAnchor).toBe("local-identity");
    expect(report.responder.certificateAnchor).toBe("unanchored");
    // The signatures are sound; what failed is that this is not the pinned
    // partner's record.
    expect(report.initiator.signature).toBe("verified");
    expect(report.responder.signature).toBe("verified");
  });

  test("a malformed pinned value is a mismatch, never a match", async () => {
    const report = await verifyDualSignedRecord(await signedRecord(), {
      ...fullyAnchored,
      pinnedFingerprints: ["not a fingerprint"],
    });
    expect(report.outcome).toBe("failed");
    expect(report.pinnedFingerprints).toBe("unmatched");
    expect(report.responder.certificateAnchor).toBe("unanchored");
  });

  test("a certificate outside the canonical domain yields a report, not a rejection", async () => {
    // The parse schema refuses a certificate whose fields are not encodable, so
    // this reaches the verifier only from a direct caller handing it a hand-built
    // record. Every check must still yield a status -- including the fingerprint
    // pin, which is computed outside the per-party evaluation.
    const report = await verifyDualSignedRecord(
      withUnevaluableResponder(await signedRecord()),
      fullyAnchored,
    );
    expect(report.outcome).toBe("failed");
    // The pinned value is the responder's, and that certificate cannot be
    // evaluated at all, so it matches nothing here.
    expect(report.pinnedFingerprints).toBe("unmatched");
    expect(report.responder.certificateAnchor).toBe("unanchored");
    expect(report.responder.certificateBinding).toBe("failed");
    expect(report.responder.signature).toBe("failed");
    expect(report.responder.fingerprint).toBe("");
    // The evaluable slot is still checked and reported.
    expect(report.initiator.signature).toBe("verified");
    expect(report.initiator.fingerprint).toBe(fingerprintA);
  });

  test("an unevaluable certificate does not sink the pin on the other slot", async () => {
    // The same record as above, with the pin on the slot that CAN be evaluated:
    // that slot's match stands and the unevaluable one is simply unanchored. The
    // pin is therefore evaluated per certificate -- collapsing the pair to a
    // single mismatch whenever either certificate cannot be encoded would still
    // satisfy the out-of-domain pin above.
    const report = await verifyDualSignedRecord(
      withUnevaluableResponder(await signedRecord()),
      { ...fullyAnchored, pinnedFingerprints: [fingerprintA] },
    );
    expect(report.initiator.certificateAnchor).toBe("partner-pin");
    expect(report.responder.certificateAnchor).toBe("unanchored");
    expect(report.pinnedFingerprints).toBe("matched");
  });

  test("a certificate whose self-signature does not verify fails the identity binding", async () => {
    // Replacing only the self-signature leaves the body -- and so the fingerprint
    // and the receipt signature -- intact, which isolates the identity binding:
    // this certificate no longer ties "Party B" to the key that signed.
    const record = await signedRecord();
    const broken = {
      ...record.responder,
      certificate: {
        ...record.responder.certificate,
        signature: outsider.certificate.signature,
      },
    } satisfies SignedReceiptParty;
    const report = await verifyDualSignedRecord(
      { ...record, responder: broken },
      fullyAnchored,
    );
    expect(report.outcome).toBe("failed");
    expect(report.responder.certificateBinding).toBe("failed");
    expect(report.responder.signature).toBe("verified");
    expect(report.initiator.certificateBinding).toBe("verified");
  });

  test("a certificate bound to an identity this exchange did not agree is a distinct failure", async () => {
    const report = await verifyDualSignedRecord(await signedRecord(), {
      ...fullyAnchored,
      expectedIdentities: ["Party A", "Party Z"],
    });
    expect(report.outcome).toBe("failed");
    expect(report.responder.assertedIdentity).toBe("mismatch");
    // Everything else holds: the failure is the identity, and says so.
    expect(report.initiator.assertedIdentity).toBe("verified");
    expect(report.responder.signature).toBe("verified");
    expect(report.responder.certificateBinding).toBe("verified");
    expect(report.termsHash).toBe("verified");
  });

  test("two certificates cannot both claim one expected identity", async () => {
    const record = await signedRecord(content(), {
      initiator: identityA,
      responder: identityA,
    });
    const report = await verifyDualSignedRecord(record, {
      ...fullyAnchored,
      pinnedFingerprints: [fingerprintA],
    });
    expect(report.initiator.assertedIdentity).toBe("verified");
    expect(report.responder.assertedIdentity).toBe("mismatch");
    expect(report.outcome).toBe("failed");
  });

  test("the expected identities are matched in either order (roles are not recorded elsewhere)", async () => {
    const report = await verifyDualSignedRecord(await signedRecord(), {
      ...fullyAnchored,
      expectedIdentities: ["Party B", "Party A"],
    });
    expect(report.initiator.assertedIdentity).toBe("verified");
    expect(report.responder.assertedIdentity).toBe("verified");
    expect(report.outcome).toBe("verified");
  });

  test("an agreed-terms hash from another exchange is a mismatch", async () => {
    const report = await verifyDualSignedRecord(await signedRecord(), {
      ...fullyAnchored,
      expectedTermsHash: "b3RoZXJUZXJtcw",
    });
    expect(report.outcome).toBe("failed");
    expect(report.termsHash).toBe("mismatch");
    expect(report.initiator.signature).toBe("verified");
  });
});

// --- The verdict decision ----------------------------------------------------

// What a report MEANS, decided once for every surface. Each case here runs the
// real verification first and decides the verdict over the report it produced, so
// a tier or a remediation is asserted against a pairing that can actually occur;
// the hand-built reports at the end are for the two contradictions a signable
// record cannot be made to produce on demand.

describe("decideSignedReceiptVerdict", () => {
  const verdictFor = async (
    inputs: Parameters<typeof verifyDualSignedRecord>[1],
  ): Promise<SignedReceiptVerdict> =>
    decideSignedReceiptVerdict(
      await verifyDualSignedRecord(await signedRecord(), inputs),
    );

  test("a fully verified record names what anchored each certificate", async () => {
    const verdict = await verdictFor(fullyAnchored);
    expect(verdict.headline.tone).toBe("verified");
    // The verified headline holds both slots and what anchored each, which is
    // what lets a surface state it without re-deriving the assignment.
    if (verdict.headline.tone !== "verified") throw new Error("unreachable");
    expect(verdict.headline.anchoredSlots).toEqual([
      { role: "initiator", anchor: "local-identity" },
      { role: "responder", anchor: "partner-pin" },
    ]);
    for (const party of verdict.parties) {
      expect(party.certificateAnchor.tone).toBe("verified");
      expect(party.certificateAnchor.unanchoredClauses).toEqual([]);
      expect(party.certificateBinding.tone).toBe("verified");
      expect(party.signature.tone).toBe("verified");
      expect(party.assertedIdentity.tone).toBe("verified");
    }
    expect(verdict.termsHash.tone).toBe("verified");
    expect(verdict.runBinding.tone).toBe("verified");
    expect(verdict.runBinding.pairByStamp).toBe(false);
    // Nothing to remediate: every certificate is anchored and every value the
    // verifier supplied reached one.
    expect(verdict.guidance).toEqual([]);
    expect(verdict.binder).toBe(BINDER);
    expect(verdict.parties[0].identity).toBe("Party A");
    expect(verdict.parties[0].fingerprint).toBe(fingerprintA);
  });

  test("no anchoring value at all is incomplete and states that none was supplied", async () => {
    // The third-party auditor holding the receipt alone: every check the record
    // can make on itself passes, and nothing ties either certificate to a party
    // known outside it.
    const verdict = await verdictFor({
      expectedIdentities: ["Party A", "Party B"],
      expectedTermsHash: TERMS_HASH,
      recordReceiptBinder: BINDER,
    });
    expect(verdict.headline).toEqual({
      tone: "incomplete",
      unanchoredRoles: ["initiator", "responder"],
    });
    for (const party of verdict.parties) {
      expect(party.certificateAnchor.status).toBe("unanchored");
      expect(party.certificateAnchor.tone).toBe("incomplete");
      // Nothing was compared against either certificate, so neither clause is
      // supported: an unanchored slot must not be treated as a check it was put
      // to and failed.
      expect(party.certificateAnchor.unanchoredClauses).toEqual([]);
      expect(party.signature.tone).toBe("verified");
    }
    expect(verdict.guidance).toEqual([{ kind: "no-certificate-anchored" }]);
  });

  test("one unanchored slot is incomplete, named in the headline and in the guidance", async () => {
    const verdict = await verdictFor({
      pinnedFingerprints: [fingerprintB],
      expectedIdentities: ["Party A", "Party B"],
      expectedTermsHash: TERMS_HASH,
      recordReceiptBinder: BINDER,
    });
    expect(verdict.headline).toEqual({
      tone: "incomplete",
      unanchoredRoles: ["initiator"],
    });
    // A pin was supplied and reached the other certificate, so the report does
    // support saying no pinned value matches this one -- and says nothing about an
    // own-certificate comparison that never ran.
    expect(verdict.parties[0].certificateAnchor.unanchoredClauses).toEqual([
      "no-pinned-value-matches",
    ]);
    expect(verdict.parties[1].certificateAnchor.status).toBe("partner-pin");
    expect(verdict.guidance).toEqual([
      { kind: "certificate-unanchored", role: "initiator" },
    ]);
  });

  test("an unanchored slot a pinned value does match is not narrated as one it missed", async () => {
    // Both slots hold one certificate, so the pin that anchored the responder's
    // slot matches the initiator's too: what leaves that slot unanchored is each
    // value claiming a single slot, not a pin that missed.
    const oneCertificate = await signedRecord(content(), {
      initiator: identityA,
      responder: identityA,
    });
    const verdict = decideSignedReceiptVerdict(
      await verifyDualSignedRecord(oneCertificate, {
        pinnedFingerprints: [fingerprintA],
        expectedTermsHash: TERMS_HASH,
        recordReceiptBinder: BINDER,
      }),
    );
    const unanchored = verdict.parties.filter(
      (party) => party.certificateAnchor.status === "unanchored",
    );
    expect(unanchored).toHaveLength(1);
    expect(unanchored[0]?.certificateAnchor.unanchoredClauses).toEqual([]);
  });

  test("a signature failure grades every row it did not touch as it found them", async () => {
    const tampered = await signedRecord();
    const verdict = decideSignedReceiptVerdict(
      await verifyDualSignedRecord(
        { ...tampered, content: content({ binder: "b3RoZXJCaW5kZXI" }) },
        { ...fullyAnchored, recordReceiptBinder: "b3RoZXJCaW5kZXI" },
      ),
    );
    expect(verdict.headline).toEqual({ tone: "failed" });
    for (const party of verdict.parties) {
      expect(party.signature.status).toBe("failed");
      expect(party.signature.tone).toBe("failed");
      // The checks that did pass are still reported as passing: a failed verdict
      // states which check failed rather than condemning the whole artifact.
      expect(party.certificateBinding.tone).toBe("verified");
      expect(party.certificateAnchor.tone).toBe("verified");
    }
    expect(verdict.termsHash.tone).toBe("verified");
    expect(verdict.guidance).toEqual([]);
  });

  test("a pinned value reaching neither certificate ends the guidance at that line", async () => {
    // The run is not short an anchor; it holds one that belongs to another
    // exchange, and telling the verifier to supply more would talk past it.
    const verdict = await verdictFor({
      pinnedFingerprints: [fingerprintC],
      expectedIdentities: ["Party A", "Party B"],
      expectedTermsHash: TERMS_HASH,
      recordReceiptBinder: BINDER,
    });
    expect(verdict.headline).toEqual({ tone: "failed" });
    expect(verdict.guidance).toEqual([
      { kind: "pinned-fingerprint-unmatched" },
    ]);
  });

  test("a named signing identity reaching neither certificate contradicts the record", async () => {
    const verdict = await verdictFor({
      pinnedFingerprints: [fingerprintB],
      localIdentity: { fingerprint: fingerprintC, source: "named" },
      expectedIdentities: ["Party A", "Party B"],
      expectedTermsHash: TERMS_HASH,
      recordReceiptBinder: BINDER,
    });
    expect(verdict.headline).toEqual({ tone: "failed" });
    expect(verdict.guidance).toEqual([
      { kind: "named-local-identity-unmatched" },
    ]);
    // The slot the pin did anchor is not recast by the failure beside it.
    expect(verdict.parties[1].certificateAnchor.status).toBe("partner-pin");
  });

  test("an identity resolved without being asked anchors nothing and contradicts nothing", async () => {
    const verdict = await verdictFor({
      localIdentity: { fingerprint: fingerprintC, source: "resolved" },
      expectedIdentities: ["Party A", "Party B"],
      expectedTermsHash: TERMS_HASH,
      recordReceiptBinder: BINDER,
    });
    expect(verdict.headline.tone).toBe("incomplete");
    // Stated, and still followed by how to reach a verified verdict: nothing the
    // verifier asserted was contradicted.
    expect(verdict.guidance).toEqual([
      { kind: "resolved-local-identity-unmatched" },
      { kind: "no-certificate-anchored" },
    ]);
    for (const party of verdict.parties)
      expect(party.certificateAnchor.unanchoredClauses).toEqual([
        "not-your-own-certificate",
      ]);
  });

  test("an unmatched identity with no stated source is refused rather than graded", async () => {
    // Named or resolved is the difference between a contradiction and a note, so
    // the verification states which reached it and a report that compared an
    // identity without saying how is refused rather than graded either way. A
    // produced report cannot say that, which is why this one is built by hand.
    const produced = await verifyDualSignedRecord(await signedRecord(), {
      localIdentity: { fingerprint: fingerprintC, source: "resolved" },
    });
    expect(produced.localIdentitySource).toBe("resolved");
    expect(() =>
      decideSignedReceiptVerdict(
        handBuiltReport({ outcome: "failed", localIdentity: "unmatched" }),
      ),
    ).toThrow(/how it reached the verification was not stated/);
  });

  test("a record and a receipt from one run are paired, with nothing to advise", async () => {
    const verdict = await verdictFor(fullyAnchored);
    expect(verdict.runBinding.status).toBe("verified");
    expect(verdict.runBinding.tone).toBe("verified");
    expect(verdict.runBinding.pairByStamp).toBe(false);
  });

  test("a record from another run of this partnership fails, and earns the stamp advice", async () => {
    const verdict = await verdictFor({
      ...fullyAnchored,
      recordReceiptBinder: "b3RoZXJSdW5CaW5kZXI",
    });
    expect(verdict.headline).toEqual({ tone: "failed" });
    expect(verdict.runBinding.status).toBe("mismatch");
    expect(verdict.runBinding.tone).toBe("failed");
    expect(verdict.runBinding.pairByStamp).toBe(true);
    // Distinguishable from every other failure class: each signature, identity,
    // and anchor row still displays as verified.
    for (const party of verdict.parties) {
      expect(party.signature.tone).toBe("verified");
      expect(party.certificateAnchor.tone).toBe("verified");
      expect(party.assertedIdentity.tone).toBe("verified");
    }
  });

  test("a record of an exchange that produced no receipt fails, and earns it too", async () => {
    // The record in hand states there is no receipt for it at all, which the
    // receipt beside it contradicts -- answered by the same advice as a cross-run
    // pairing, since both are resolved by finding the record written beside this
    // receipt.
    const verdict = await verdictFor({
      ...fullyAnchored,
      recordReceiptBinder: null,
    });
    expect(verdict.headline).toEqual({ tone: "failed" });
    expect(verdict.runBinding.status).toBe("unpaired");
    expect(verdict.runBinding.tone).toBe("failed");
    expect(verdict.runBinding.pairByStamp).toBe(true);
  });

  test("a receipt held with no record at all is incomplete, with nothing to pair by", async () => {
    const { recordReceiptBinder: _unpaired, ...withoutRecord } = fullyAnchored;
    const verdict = await verdictFor(withoutRecord);
    expect(verdict.headline.tone).toBe("incomplete");
    expect(verdict.runBinding.status).toBe("not-checked");
    expect(verdict.runBinding.tone).toBe("incomplete");
    // Short of verified is not a contradiction: the holder of one artifact is
    // accused of nothing, and there is no pairing to advise on.
    expect(verdict.runBinding.pairByStamp).toBe(false);
  });

  test("a certificate with no computable fingerprint is stated as having none", async () => {
    const verdict = decideSignedReceiptVerdict(
      await verifyDualSignedRecord(
        withUnevaluableResponder(await signedRecord()),
        { pinnedFingerprints: [fingerprintA] },
      ),
    );
    // Null rather than an empty string: a surface states that the fingerprint
    // could not be computed instead of rendering a blank where one belongs.
    expect(verdict.parties[1].fingerprint).toBeNull();
    expect(verdict.parties[1].certificateBinding.status).toBe("failed");
    expect(verdict.parties[0].fingerprint).toBe(fingerprintA);
  });

  test("a verified verdict over an unanchored slot is refused, not phrased", () => {
    // The verifier reaches `verified` only once both certificates are anchored, so
    // the headline always has a source to name for each slot. Were that to stop
    // holding, every surface's sentence would claim an anchor that does not exist:
    // the decision fails loudly here instead, once for all of them.
    expect(() =>
      decideSignedReceiptVerdict(
        handBuiltReport({
          responder: {
            ...handBuiltParty("responder"),
            certificateAnchor: "unanchored",
          },
        }),
      ),
    ).toThrow(/leaves the responder's certificate unanchored/);
  });

  test.each(["verified", "incomplete", "failed"] as const)(
    "an anchor outside the union is refused under a %s outcome, not named",
    (outcome) => {
      // The anchoring assignment produces the three statuses the union holds
      // and nothing else, so a status from outside it reaches the decision only
      // from a caller that stepped past the type. Every surface words the slot
      // from that status, on the degraded headlines as much as the verified one,
      // so an unnamed status is a sentence naming an anchor that exists nowhere.
      const outsideTheUnion: string = "bogus-anchor";
      expect(() =>
        decideSignedReceiptVerdict(
          handBuiltReport({
            outcome,
            responder: {
              ...handBuiltParty("responder"),
              certificateAnchor: outsideTheUnion as CertificateAnchorStatus,
            },
          }),
        ),
      ).toThrow(/certificate anchor as bogus-anchor/);
    },
  );

  test("a matched pinned value beside two unanchored slots is refused, not advised on", () => {
    // A pinned value that matched anchors the slot it matched, so a report saying
    // both would send the verifier to pin a fingerprint they had already pinned.
    expect(() =>
      decideSignedReceiptVerdict(
        handBuiltReport({
          outcome: "incomplete",
          initiator: {
            ...handBuiltParty("initiator"),
            certificateAnchor: "unanchored",
          },
          responder: {
            ...handBuiltParty("responder"),
            certificateAnchor: "unanchored",
          },
        }),
      ),
    ).toThrow(/already supplied/);
  });

  test("a verified verdict over a row reported as failed is refused, not rendered", () => {
    // The counterpart of the unanchored-slot refusal: the verification withholds
    // `verified` while any check it made was contradicted, so a headline reading
    // verified over a failed row would overstate the evidence on every surface at
    // once.
    expect(() =>
      decideSignedReceiptVerdict(
        handBuiltReport({
          responder: { ...handBuiltParty("responder"), signature: "failed" },
        }),
      ),
    ).toThrow(/verified over a row that failed/);
    expect(() =>
      decideSignedReceiptVerdict(handBuiltReport({ runBinding: "mismatch" })),
    ).toThrow(/the receipt-record pairing as mismatch/);
  });
});

// A report assembled by hand, for the states a signable record cannot be made to
// produce: a verdict inconsistent with the slots under it.
function handBuiltParty(role: HandshakeRole): SignedReceiptPartyReport {
  return {
    role,
    identity: role === "initiator" ? "Party A" : "Party B",
    fingerprint: role === "initiator" ? fingerprintA : fingerprintB,
    certificateBinding: "verified",
    signature: "verified",
    certificateAnchor: role === "initiator" ? "local-identity" : "partner-pin",
    assertedIdentity: "verified",
  };
}

function handBuiltReport(
  overrides: Partial<DualSignedRecordVerificationReport> = {},
): DualSignedRecordVerificationReport {
  return {
    outcome: "verified",
    initiator: handBuiltParty("initiator"),
    responder: handBuiltParty("responder"),
    pinnedFingerprints: "matched",
    localIdentity: "matched",
    termsHash: "verified",
    runBinding: "verified",
    binder: BINDER,
    ...overrides,
  };
}

// --- Cross-implementation bundle ---------------------------------------------

// The checked-in bundle is a complete dual-signed record: every signature
// -- both certificate and receipt -- was produced by openssl from bytes
// the generator assembles from docs/spec/EXCHANGE_RECORD.md, not this
// codebase. Verifying it accepts a bundle from another implementation and
// pins the signed-byte layout: a divergence here fails a signature. The
// browser suite runs this file against the web build in Chromium.
describe("cross-implementation bundle", () => {
  const { bundle } = JSON.parse(
    readFileSync(
      new URL("../vectors/signed-receipt-vectors.json", import.meta.url),
      "utf8",
    ),
  ) as {
    bundle: {
      expected: {
        initiatorFingerprint: string;
        responderFingerprint: string;
        initiatorIdentity: string;
        responderIdentity: string;
      };
      record: unknown;
    };
  };

  test("a foreign-signed bundle parses and verifies against the pinned fingerprints", async () => {
    const record = parseDualSignedRecord(bundle.record);
    const report = await verifyDualSignedRecord(record, {
      // The bundle is nobody's own exchange, so both signers are anchored the
      // way a verifier that was party to neither anchors them: by fingerprint.
      pinnedFingerprints: [
        bundle.expected.responderFingerprint,
        bundle.expected.initiatorFingerprint,
      ],
      expectedIdentities: [
        bundle.expected.initiatorIdentity,
        bundle.expected.responderIdentity,
      ],
      expectedTermsHash: record.content.termsHash,
      // The bundle is a receipt with no exchange record beside it, so the run
      // binder stands in for the record's: what this test pins is the signed-byte
      // layout, not the pairing (covered in signedReceiptEndToEnd.test.ts).
      recordReceiptBinder: record.content.binder,
    });
    expect(report.outcome).toBe("verified");
    expect(report.initiator.fingerprint).toBe(
      bundle.expected.initiatorFingerprint,
    );
    expect(report.responder.fingerprint).toBe(
      bundle.expected.responderFingerprint,
    );
  });

  test("a foreign-signed bundle with one byte changed does not verify", async () => {
    const record = parseDualSignedRecord(bundle.record);
    const report = await verifyDualSignedRecord(
      {
        ...record,
        content: {
          ...record.content,
          binder: "DqMqfqQWT3ezinyelof-x2r-aBMbuAnCpIFjI7cVvOA",
        },
      },
      { pinnedFingerprints: [bundle.expected.responderFingerprint] },
    );
    expect(report.outcome).toBe("failed");
    expect(report.initiator.signature).toBe("failed");
    expect(report.responder.signature).toBe("failed");
  });
});
