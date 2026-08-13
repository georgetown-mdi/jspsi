import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import {
  SIGNED_RECEIPT_VERSION,
  parseDualSignedRecord,
  signReceiptContent,
} from "../src/signedReceipt";
import { verifyDualSignedRecord } from "../src/signedReceiptVerification";
import {
  computeCertificateFingerprint,
  generateSigningIdentity,
} from "../src/signingIdentity";

import type {
  DualSignedRecord,
  ReceiptContent,
  SignedReceiptParty,
} from "../src/signedReceipt";
import type { P256PrivateJwk, SigningIdentity } from "../src/signingIdentity";

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

function content(overrides: Partial<ReceiptContent> = {}): ReceiptContent {
  return {
    termsHash: TERMS_HASH,
    initiatorToResponderPayload: "aTJyUGF5bG9hZA",
    responderToInitiatorPayload: "cjJpUGF5bG9hZA",
    binder: "YmluZGVy",
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
// own signing identity (found from the same config rather than restated), and
// both parties' identities and agreed-terms hash. Party A is the initiator here,
// so its own identity anchors that slot and the pin anchors the responder's.
const fullyAnchored = {
  pinnedFingerprints: [fingerprintB],
  localIdentity: { fingerprint: fingerprintA, source: "resolved" } as const,
  expectedIdentities: ["Party A", "Party B"] as readonly [string, string],
  expectedTermsHash: TERMS_HASH,
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
    });
    expect(report.outcome).toBe("verified");
    expect(report.initiator.certificateAnchor).toBe("partner-pin");
    expect(report.responder.certificateAnchor).toBe("partner-pin");
    expect(report.localIdentity).toBe("not-supplied");
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
    // A record whose two slots carry the same certificate would otherwise let a
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
    // never carries and neither party retains: the verifier can only confirm that
    // the signers signed a receipt carrying this value.
    const report = await verifyDualSignedRecord(
      await signedRecord(content({ binder: "b3RoZXJCaW5kZXI" })),
      fullyAnchored,
    );
    expect(report.binder).toBe("b3RoZXJCaW5kZXI");
    expect(report.outcome).toBe("verified");
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

// --- Cross-implementation bundle ---------------------------------------------

// The checked-in bundle is a complete dual-signed record whose every signature --
// both certificate self-signatures and both receipt signatures -- was produced by
// openssl over bytes the generator assembles from docs/spec/EXCHANGE_RECORD.md,
// not from this codebase. Verifying it is therefore accepting a bundle produced by
// an independent implementation, and pins the signed-byte layout: a divergence in
// either shows up here as a signature that stops verifying. The browser suite runs
// the same file against the web build in real Chromium.
describe("cross-implementation bundle", () => {
  const { bundle } = JSON.parse(
    readFileSync(
      new URL("./vectors/signed-receipt-vectors.json", import.meta.url),
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
