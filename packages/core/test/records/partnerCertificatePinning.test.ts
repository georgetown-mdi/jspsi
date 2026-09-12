import { describe, expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import { prepareForExchange, runExchange } from "../../src/exchange";
import { createMessagePipe } from "../../src/connection/messageConnection";
import { ReceiptVerificationError } from "../../src/records/signedReceipt";
import {
  computeCertificateFingerprint,
  generateSigningIdentity,
} from "../../src/records/signingIdentity";
import { MAX_TEXT_LENGTH } from "../../src/config/linkageTermsSchema";

import type { HandshakeRole } from "../../src/types";
import type { MessageConnection } from "../../src/connection/messageConnection";
import type { Output } from "../../src/config/linkageTermsSchema";
import type { RunExchangeOptions } from "../../src/exchange";

// The partner-certificate pin resolved at the terms exchange: both parties
// present their self-signed certificate on the terms envelope, each holds the
// presented value to the pin it has on file, and a party with none adopts the
// presented fingerprint as its first authenticated contact
// (docs/spec/PROTOCOL.md, "Signing identity and certificate pinning"). Every
// refusal here fires before the bootstrap frame and before any linkage key or
// payload row moves, which is what these tests hold.

const psiLibrary = await PSI();

const firstNameTerms = {
  version: "1.0.0",
  date: "2026-01-01",
  algorithm: "psi" as const,
  linkageStrategy: "cascade" as const,
  deduplicate: false,
  linkageFields: [{ name: "firstName", type: "first_name" as const }],
  linkageKeys: [{ name: "firstName", elements: [{ field: "firstName" }] }],
};

const serverRows = [
  { first_name: "Carol" },
  { first_name: "Elizabeth" },
  { first_name: "Henry" },
];
const clientRows = [{ first_name: "Carol" }, { first_name: "Elizabeth" }];

const both: Output = { expectsOutput: true, shareWithPartner: true };

function prepared(identity: string, rows: typeof serverRows) {
  return prepareForExchange(
    { linkageTerms: { ...firstNameTerms, identity, output: both } },
    identity,
    rows,
    ["first_name"],
  );
}

// Fixed keys and a fixed session key so both parties derive the same binder.
const identityA = await generateSigningIdentity("Initiator Co", {
  privateKey: {
    kty: "EC",
    crv: "P-256",
    x: "GVQtflhIdfyWtA4RGHj1T0I9SSp06yAE1StWzYqyOgc",
    y: "9aIOTbxzjvOD_-qU-bR7fvyonZyFmNRUYARsDEronE4",
    d: "Cw4RFBcaHSAjJiksLzI1ODs-QURHSk1QU1ZZXF9iZWg",
  },
});
const identityB = await generateSigningIdentity("Responder Co", {
  privateKey: {
    kty: "EC",
    crv: "P-256",
    x: "BTjKXg73U-P7scjs7x2b4PTBObeQCmUWxRZUphXgOco",
    y: "vrypj5auTCXlpWtQ7dzQVRiLOO5FYAFEK2N6hkO_fnQ",
    d: "yM3S19zh5uvw9fr_BAkOExgdIicsMTY7QEVKT1RZXmM",
  },
});
// A valid signing identity bound to a party neither seat agrees terms under.
const identityElsewhere = await generateSigningIdentity("Elsewhere Co");
const fingerprintA = await computeCertificateFingerprint(identityA.certificate);
const fingerprintB = await computeCertificateFingerprint(identityB.certificate);
const sessionKey = new Uint8Array(32).fill(11) as Uint8Array<ArrayBuffer>;

/** Which fixtures each handshake seat runs with. */
function seat(role: HandshakeRole) {
  return role === "initiator"
    ? {
        name: "Initiator Co",
        rows: clientRows,
        identity: identityA,
        partnerFingerprint: fingerprintB,
      }
    : {
        name: "Responder Co",
        rows: serverRows,
        identity: identityB,
        partnerFingerprint: fingerprintA,
      };
}

/** A connection that records, in order, every frame the party sends. */
function recording(conn: MessageConnection): {
  conn: MessageConnection;
  sent: Array<unknown>;
} {
  const sent: Array<unknown> = [];
  return {
    sent,
    conn: {
      send: async (data: unknown) => {
        sent.push(data);
        await conn.send(data);
      },
      receive: (timeoutMs?: number) => conn.receive(timeoutMs),
      close: () => conn.close(),
    },
  };
}

/** Whether a frame is a terms envelope: message 1 and message 2 both hold
 * terms. */
function isTermsFrame(frame: unknown): frame is Record<string, unknown> {
  return typeof frame === "object" && frame !== null && "linkageTerms" in frame;
}

/** Whether a frame is a decision frame, the bare proceed or the abort. */
function isDecisionFrame(frame: unknown): frame is { decision: unknown } {
  return typeof frame === "object" && frame !== null && "decision" in frame;
}

/** The terms frames a party sends. */
function termsFrames(sent: Array<unknown>): Array<Record<string, unknown>> {
  return sent.filter(isTermsFrame);
}

/** Rewrite the `certificate` on this party's outbound terms frame. */
function withTermsCertificate(
  conn: MessageConnection,
  replacement: unknown,
): MessageConnection {
  return {
    send: (data: unknown) =>
      conn.send(
        typeof data === "object" && data !== null && "linkageTerms" in data
          ? { ...data, certificate: replacement }
          : data,
      ),
    receive: (timeoutMs?: number) => conn.receive(timeoutMs),
    close: () => conn.close(),
  };
}

/** The reasons on the single abort frame a refusing party sent the peer. The
 * refusal is one-sided, so without that frame the peer waits out its
 * inactivity budget. */
function abortReasons(sent: Array<unknown>): unknown {
  const frames = sent.filter(
    (frame) => isDecisionFrame(frame) && frame.decision === "abort",
  );
  expect(frames).toHaveLength(1);
  return (frames[0] as { abortReasons?: unknown }).abortReasons;
}

/** Every frame outside the three a refusing party legitimately sends: its terms
 * envelope, the bare proceed decision, and the abort. Classified by exclusion
 * because a linkage-round frame is a raw `Uint8Array` (psi/participant.ts,
 * psi/link.ts), which a list of disclosing object shapes matches none of --
 * and that leak is what these assertions exist to catch. */
function disclosingFrames(sent: Array<unknown>): Array<unknown> {
  return sent.filter(
    (frame) => !isTermsFrame(frame) && !isDecisionFrame(frame),
  );
}

test("the disclosure helper counts every frame past a refusal's own", () => {
  // What the assertions below rest on. A linkage-round frame is a raw
  // Uint8Array, so a helper that recognized disclosing shapes by their object
  // fields would return an empty list for a leaked linkage key.
  const linkageKey = new Uint8Array([1, 2, 3]);
  expect(
    disclosingFrames([
      { linkageTerms: firstNameTerms, certificate: identityA.certificate },
      { decision: "proceed" },
      { decision: "abort", abortReasons: ["a party presented no certificate"] },
      linkageKey,
    ]),
  ).toEqual([linkageKey]);
});

describe("a first authenticated contact adopts the partner's certificate", () => {
  test("both sides pin, report the value, and sign against it", async () => {
    // Neither party holds a pin, so each adopts the fingerprint of the
    // certificate its partner presented at the terms exchange -- and the swap
    // that follows verifies against that same adopted value, which is what
    // lets the run produce a receipt at all.
    const adopted: Record<string, Array<string>> = {
      initiator: [],
      responder: [],
    };
    const [connInitiator, connResponder] = createMessagePipe();
    const [resInit, resResp] = await Promise.all([
      runExchange(
        connInitiator,
        "initiator",
        prepared("Initiator Co", clientRows),
        {
          psiLibrary,
          signingIdentity: identityA,
          sessionKey,
          onPartnerCertificatePinned: (fingerprint) =>
            adopted.initiator.push(fingerprint),
        },
      ),
      runExchange(
        connResponder,
        "responder",
        prepared("Responder Co", serverRows),
        {
          psiLibrary,
          signingIdentity: identityB,
          sessionKey,
          onPartnerCertificatePinned: (fingerprint) =>
            adopted.responder.push(fingerprint),
        },
      ),
    ]);

    expect(adopted.initiator).toEqual([fingerprintB]);
    expect(adopted.responder).toEqual([fingerprintA]);
    expect(resInit.signedReceipt).toEqual(resResp.signedReceipt);
    expect(resInit.signedReceipt!.initiator.certificate).toEqual(
      identityA.certificate,
    );
    expect(resInit.signedReceipt!.responder.certificate).toEqual(
      identityB.certificate,
    );
  });

  test("a pin already on file is reported to no one and is what governs", async () => {
    // The adoption callback is the first-contact path alone: a run holding a
    // matching pin resolves to that value and reports nothing, so a recurring
    // exchange stays silent about a fingerprint the operator already has.
    const adopted: Array<string> = [];
    const [connInitiator, connResponder] = createMessagePipe();
    const [resInit] = await Promise.all([
      runExchange(
        connInitiator,
        "initiator",
        prepared("Initiator Co", clientRows),
        {
          psiLibrary,
          signingIdentity: identityA,
          partnerFingerprint: fingerprintB,
          sessionKey,
          onPartnerCertificatePinned: (fingerprint) =>
            adopted.push(fingerprint),
        },
      ),
      runExchange(
        connResponder,
        "responder",
        prepared("Responder Co", serverRows),
        {
          psiLibrary,
          signingIdentity: identityB,
          partnerFingerprint: fingerprintA,
          sessionKey,
        },
      ),
    ]);
    expect(adopted).toEqual([]);
    expect(resInit.signedReceipt).toBeDefined();
  });
});

describe("a certificate that does not verify under its own key is not adopted", () => {
  // Adopting it would write a pin no later run could satisfy, so the first
  // contact refuses instead: the signature is tampered with in flight while
  // the body -- and so the fingerprint -- stays what the partner sent. Neither
  // seat holds a pin, so both reach the self-signature check.
  for (const refusingRole of ["initiator", "responder"] as const) {
    test(`the refusing ${refusingRole} discloses nothing and aborts`, async () => {
      const partnerRole: HandshakeRole =
        refusingRole === "initiator" ? "responder" : "initiator";
      const refusing = seat(refusingRole);
      const partnerSeat = seat(partnerRole);
      const tampered = {
        ...partnerSeat.identity.certificate,
        signature: refusing.identity.certificate.signature,
      };
      const adopted: Array<string> = [];
      const [rawRefusing, rawPartner] = createMessagePipe();
      const refusingSide = recording(rawRefusing);
      const partner = runExchange(
        withTermsCertificate(rawPartner, tampered),
        partnerRole,
        prepared(partnerSeat.name, partnerSeat.rows),
        {
          psiLibrary,
          signingIdentity: partnerSeat.identity,
          sessionKey,
        },
      ).catch((reason: unknown) => reason);
      const raised = await runExchange(
        refusingSide.conn,
        refusingRole,
        prepared(refusing.name, refusing.rows),
        {
          psiLibrary,
          signingIdentity: refusing.identity,
          sessionKey,
          onPartnerCertificatePinned: (fingerprint) =>
            adopted.push(fingerprint),
        },
      ).then(
        () => {
          throw new Error("expected the first contact to refuse");
        },
        (reason: unknown) => reason,
      );

      expect(raised).toBeInstanceOf(ReceiptVerificationError);
      expect((raised as Error).message).toMatch(
        /does not verify under its own key/,
      );
      expect(adopted).toEqual([]);
      expect(disclosingFrames(refusingSide.sent)).toEqual([]);
      expect(abortReasons(refusingSide.sent)).toEqual([
        expect.stringMatching(/does not verify under its own key/),
      ]);

      await rawRefusing.close();
      await rawPartner.close();
      await partner;
    });
  }
});

describe("a certificate bound away from the partner's agreed terms is not adopted", () => {
  // The swap authorizes the presented certificate against the identity the
  // partner agreed terms under, so a fingerprint adopted from a certificate
  // bound to any other name is a pin every later run refuses. The partner here
  // presents a valid self-signed certificate for a party it is not: the
  // self-signature check passes and the binding check is what refuses.
  for (const refusingRole of ["initiator", "responder"] as const) {
    test(`the refusing ${refusingRole} discloses nothing and aborts`, async () => {
      const partnerRole: HandshakeRole =
        refusingRole === "initiator" ? "responder" : "initiator";
      const refusing = seat(refusingRole);
      const partnerSeat = seat(partnerRole);
      const adopted: Array<string> = [];
      const [rawRefusing, rawPartner] = createMessagePipe();
      const refusingSide = recording(rawRefusing);
      const partner = runExchange(
        withTermsCertificate(rawPartner, identityElsewhere.certificate),
        partnerRole,
        prepared(partnerSeat.name, partnerSeat.rows),
        {
          psiLibrary,
          signingIdentity: partnerSeat.identity,
          sessionKey,
        },
      ).catch((reason: unknown) => reason);
      const raised = await runExchange(
        refusingSide.conn,
        refusingRole,
        prepared(refusing.name, refusing.rows),
        {
          psiLibrary,
          signingIdentity: refusing.identity,
          sessionKey,
          onPartnerCertificatePinned: (fingerprint) =>
            adopted.push(fingerprint),
        },
      ).then(
        () => {
          throw new Error("expected the first contact to refuse");
        },
        (reason: unknown) => reason,
      );

      expect(raised).toBeInstanceOf(ReceiptVerificationError);
      expect((raised as Error).message).toMatch(
        /does not authorize the identity its holder agreed terms under/,
      );
      expect(adopted).toEqual([]);
      expect(disclosingFrames(refusingSide.sent)).toEqual([]);
      expect(abortReasons(refusingSide.sent)).toEqual([
        expect.stringMatching(
          /does not authorize the identity its holder agreed terms under/,
        ),
      ]);

      await rawRefusing.close();
      await rawPartner.close();
      await partner;
    });
  }
});

describe("a certificate the wire format does not admit is refused at parse", () => {
  // The field is parsed through the bounded wire certificate schema before any
  // fingerprint or signature work touches it, so an over-bound value is
  // rejected at the parse rather than driving allocation proportional to it.
  const overBound = {
    version: "psilink-signing-cert/v2",
    algorithm: "ecdsa-p256-sha256",
    identity: "x".repeat(MAX_TEXT_LENGTH + 1),
    publicKey: identityB.certificate.publicKey,
    signature: identityB.certificate.signature,
  };

  for (const refusingRole of ["initiator", "responder"] as const) {
    test(`the refusing ${refusingRole} discloses nothing and aborts`, async () => {
      const partnerRole: HandshakeRole =
        refusingRole === "initiator" ? "responder" : "initiator";
      const [rawRefusing, rawPartner] = createMessagePipe();
      const refusing = seat(refusingRole);
      const partnerSeat = seat(partnerRole);
      const refusingSide = recording(rawRefusing);
      const partner = runExchange(
        withTermsCertificate(rawPartner, overBound),
        partnerRole,
        prepared(partnerSeat.name, partnerSeat.rows),
        {
          psiLibrary,
          signingIdentity: partnerSeat.identity,
          partnerFingerprint: partnerSeat.partnerFingerprint,
          sessionKey,
        },
      ).catch((reason: unknown) => reason);
      const raised = await runExchange(
        refusingSide.conn,
        refusingRole,
        prepared(refusing.name, refusing.rows),
        {
          psiLibrary,
          signingIdentity: refusing.identity,
          partnerFingerprint: refusing.partnerFingerprint,
          sessionKey,
        },
      ).then(
        () => {
          throw new Error("expected the over-bound certificate to be refused");
        },
        (reason: unknown) => reason,
      );

      expect(raised).toBeInstanceOf(ReceiptVerificationError);
      expect((raised as Error).message).toMatch(/this build cannot read/);
      expect(disclosingFrames(refusingSide.sent)).toEqual([]);
      expect(abortReasons(refusingSide.sent)).toEqual([
        expect.stringMatching(/the wire format does not admit/),
      ]);

      await rawRefusing.close();
      await rawPartner.close();
      await partner;
    });
  }
});

describe("a partner presenting no certificate is refused on either seat", () => {
  for (const refusingRole of ["initiator", "responder"] as const) {
    test(`the refusing ${refusingRole} discloses nothing and aborts`, async () => {
      const partnerRole: HandshakeRole =
        refusingRole === "initiator" ? "responder" : "initiator";
      const refusing = seat(refusingRole);
      const partnerSeat = seat(partnerRole);
      const [rawRefusing, rawPartner] = createMessagePipe();
      const refusingSide = recording(rawRefusing);
      const partner = runExchange(
        rawPartner,
        partnerRole,
        prepared(partnerSeat.name, partnerSeat.rows),
        { psiLibrary },
      ).catch((reason: unknown) => reason);
      const raised = await runExchange(
        refusingSide.conn,
        refusingRole,
        prepared(refusing.name, refusing.rows),
        {
          psiLibrary,
          signingIdentity: refusing.identity,
          partnerFingerprint: refusing.partnerFingerprint,
          sessionKey,
        },
      ).then(
        () => {
          throw new Error("expected the unsigned partner to be refused");
        },
        (reason: unknown) => reason,
      );

      expect(raised).toBeInstanceOf(ReceiptVerificationError);
      expect((raised as Error).message).toMatch(
        /partner is not signing receipts/,
      );
      expect(disclosingFrames(refusingSide.sent)).toEqual([]);
      expect(abortReasons(refusingSide.sent)).toEqual([
        expect.stringMatching(/presented no signing certificate/),
      ]);

      await rawRefusing.close();
      await rawPartner.close();
      await partner;
    });
  }
});

describe("a configured pin that is not a fingerprint is refused, never matched", () => {
  // The schema keeps a malformed pin out of a config read from disk, but a
  // SigningConfig assembled in code can still hold one, and the comparison
  // fails closed on it rather than throwing (matchesPinnedFingerprint). What
  // this holds is that the run then takes the DIVERGENCE arm: a pin nobody can
  // match is never read as no pin at all, so a valid partner certificate is
  // refused instead of being adopted over the operator's configured value.
  const malformed = [
    { label: "a value the base64url decode rejects", pin: "not a fingerprint" },
    { label: "a value of the wrong length", pin: fingerprintB.slice(0, 20) },
  ];

  for (const { label, pin } of malformed) {
    for (const refusingRole of ["initiator", "responder"] as const) {
      test(`the refusing ${refusingRole} refuses ${label}`, async () => {
        const partnerRole: HandshakeRole =
          refusingRole === "initiator" ? "responder" : "initiator";
        const refusing = seat(refusingRole);
        const partnerSeat = seat(partnerRole);
        const adopted: Array<string> = [];
        const [rawRefusing, rawPartner] = createMessagePipe();
        const refusingSide = recording(rawRefusing);
        const partner = runExchange(
          rawPartner,
          partnerRole,
          prepared(partnerSeat.name, partnerSeat.rows),
          {
            psiLibrary,
            signingIdentity: partnerSeat.identity,
            partnerFingerprint: partnerSeat.partnerFingerprint,
            sessionKey,
          },
        ).catch((reason: unknown) => reason);
        const raised = await runExchange(
          refusingSide.conn,
          refusingRole,
          prepared(refusing.name, refusing.rows),
          {
            psiLibrary,
            signingIdentity: refusing.identity,
            partnerFingerprint: pin,
            sessionKey,
            onPartnerCertificatePinned: (fingerprint) =>
              adopted.push(fingerprint),
          },
        ).then(
          () => {
            throw new Error("expected the malformed pin to refuse");
          },
          (reason: unknown) => reason,
        );

        expect(raised).toBeInstanceOf(ReceiptVerificationError);
        expect((raised as Error).message).toMatch(
          /is not the one pinned in signing\.partner_fingerprint/,
        );
        expect(adopted).toEqual([]);
        expect(disclosingFrames(refusingSide.sent)).toEqual([]);
        expect(abortReasons(refusingSide.sent)).toEqual([
          expect.stringMatching(/is not the one its partner pinned/),
        ]);

        await rawRefusing.close();
        await rawPartner.close();
        await partner;
      });
    }
  }
});

describe("a run that does not sign in band presents no certificate", () => {
  const noCertificate = async (
    options: Partial<RunExchangeOptions>,
  ): Promise<void> => {
    const [rawLocal, rawPartner] = createMessagePipe();
    const localSide = recording(rawLocal);
    const partner = runExchange(
      rawPartner,
      "responder",
      prepared("Responder Co", serverRows),
      { psiLibrary },
    ).catch((reason: unknown) => reason);
    await runExchange(
      localSide.conn,
      "initiator",
      prepared("Initiator Co", clientRows),
      { psiLibrary, ...options },
    ).catch(() => undefined);
    const frames = termsFrames(localSide.sent);
    expect(frames).toHaveLength(1);
    expect(Object.keys(frames[0])).not.toContain("certificate");
    await rawLocal.close();
    await rawPartner.close();
    await partner;
  };

  test("a signing identity with no session key sends none", async () => {
    // The certificate is spread on the same predicate the signing step gates
    // on, so a party holding no session key puts nothing on the wire and pins
    // nothing.
    await noCertificate({ signingIdentity: identityA });
  });

  test("a session key with no signing identity sends none", async () => {
    await noCertificate({ sessionKey });
  });

  test("a run with neither sends none", async () => {
    await noCertificate({});
  });
});
