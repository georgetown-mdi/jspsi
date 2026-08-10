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

// What a party holding its own exchange record supplies: the partner's pin and
// both parties' identities and agreed-terms hash.
const fullyAnchored = {
  pinnedFingerprint: fingerprintB,
  expectedIdentities: ["Party A", "Party B"] as readonly [string, string],
  expectedTermsHash: TERMS_HASH,
};

describe("verifyDualSignedRecord", () => {
  test("a valid record, fully anchored, verifies", async () => {
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
    // The verifier pins its PARTNER only, so its own slot is simply unpinned --
    // which does not hold the record short of verified.
    expect(report.responder.fingerprintPin).toBe("verified");
    expect(report.initiator.fingerprintPin).toBe("not-pinned");
    // The report names each party and its fingerprint so an operator can see
    // whose certificate was checked.
    expect(report.initiator.fingerprint).toBe(fingerprintA);
    expect(report.responder.fingerprint).toBe(fingerprintB);
    expect(report.initiator.identity).toBe("Party A");
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

  test("with no pinned value the signatures still verify, but the outcome is incomplete", async () => {
    const report = await verifyDualSignedRecord(await signedRecord());
    expect(report.outcome).toBe("incomplete");
    expect(report.initiator.signature).toBe("verified");
    expect(report.responder.signature).toBe("verified");
    expect(report.initiator.certificateBinding).toBe("verified");
    expect(report.responder.certificateBinding).toBe("verified");
    expect(report.initiator.fingerprintPin).toBe("not-pinned");
    expect(report.responder.fingerprintPin).toBe("not-pinned");
    expect(report.initiator.assertedIdentity).toBe("not-checked");
    expect(report.termsHash).toBe("not-checked");
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

  test("a fingerprint matching neither certificate is a mismatch on both", async () => {
    const report = await verifyDualSignedRecord(await signedRecord(), {
      ...fullyAnchored,
      pinnedFingerprint: fingerprintC,
    });
    expect(report.outcome).toBe("failed");
    expect(report.initiator.fingerprintPin).toBe("mismatch");
    expect(report.responder.fingerprintPin).toBe("mismatch");
    // The signatures are sound; what failed is that this is not the pinned
    // partner's record.
    expect(report.initiator.signature).toBe("verified");
    expect(report.responder.signature).toBe("verified");
  });

  test("a malformed pinned value is a mismatch, never a match", async () => {
    const report = await verifyDualSignedRecord(await signedRecord(), {
      ...fullyAnchored,
      pinnedFingerprint: "not a fingerprint",
    });
    expect(report.outcome).toBe("failed");
    expect(report.responder.fingerprintPin).toBe("mismatch");
  });

  test("a certificate outside the canonical domain yields a report, not a rejection", async () => {
    // The parse schema refuses a certificate whose fields are not encodable, so
    // this reaches the verifier only from a direct caller handing it a hand-built
    // record. Every check must still yield a status -- including the fingerprint
    // pin, which is computed outside the per-party evaluation.
    const record = await signedRecord();
    const unencodable = {
      ...record,
      responder: {
        ...record.responder,
        certificate: { ...record.responder.certificate, identity: undefined },
      },
    } as unknown as DualSignedRecord;
    const report = await verifyDualSignedRecord(unencodable, fullyAnchored);
    expect(report.outcome).toBe("failed");
    expect(report.initiator.fingerprintPin).toBe("mismatch");
    expect(report.responder.fingerprintPin).toBe("mismatch");
    expect(report.responder.certificateBinding).toBe("failed");
    expect(report.responder.signature).toBe("failed");
    expect(report.responder.fingerprint).toBe("");
    // The evaluable slot is still checked and reported.
    expect(report.initiator.signature).toBe("verified");
    expect(report.initiator.fingerprint).toBe(fingerprintA);
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
      pinnedFingerprint: fingerprintA,
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

  test("a foreign-signed bundle parses and verifies against the pinned fingerprint", async () => {
    const record = parseDualSignedRecord(bundle.record);
    const report = await verifyDualSignedRecord(record, {
      pinnedFingerprint: bundle.expected.responderFingerprint,
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
      { pinnedFingerprint: bundle.expected.responderFingerprint },
    );
    expect(report.outcome).toBe("failed");
    expect(report.initiator.signature).toBe("failed");
    expect(report.responder.signature).toBe("failed");
  });
});
