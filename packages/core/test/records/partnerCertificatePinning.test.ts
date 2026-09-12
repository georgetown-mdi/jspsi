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

/** The terms frames a party sends: message 1 and message 2 both hold terms. */
function termsFrames(sent: Array<unknown>): Array<Record<string, unknown>> {
  return sent.filter(
    (frame): frame is Record<string, unknown> =>
      typeof frame === "object" && frame !== null && "linkageTerms" in frame,
  );
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

/** Frames that carry this party's own data, in either direction. */
function disclosingFrames(sent: Array<unknown>): Array<unknown> {
  return sent.filter(
    (frame) =>
      typeof frame === "object" &&
      frame !== null &&
      ("hasData" in frame ||
        "sharedSecret" in frame ||
        "setup" in frame ||
        "reply" in frame ||
        "signature" in frame),
  );
}

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

  test("a certificate that does not verify under its own key is not adopted", async () => {
    // Adopting it would write a pin no later run could satisfy, so the first
    // contact refuses instead: the signature is tampered with in flight while
    // the body -- and so the fingerprint -- stays what the partner sent.
    const tampered = {
      ...identityB.certificate,
      signature: identityA.certificate.signature,
    };
    const [connInitiator, rawResponder] = createMessagePipe();
    const responder = runExchange(
      withTermsCertificate(rawResponder, tampered),
      "responder",
      prepared("Responder Co", serverRows),
      { psiLibrary, signingIdentity: identityB, sessionKey },
    ).catch((reason: unknown) => reason);
    const raised = await runExchange(
      connInitiator,
      "initiator",
      prepared("Initiator Co", clientRows),
      { psiLibrary, signingIdentity: identityA, sessionKey },
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
    await connInitiator.close();
    await rawResponder.close();
    await responder;
  });
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
    test(`the refusing ${refusingRole} discloses nothing`, async () => {
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

      await rawRefusing.close();
      await rawPartner.close();
      await partner;
    });
  }
});

describe("a partner presenting no certificate is refused on either seat", () => {
  for (const refusingRole of ["initiator", "responder"] as const) {
    test(`the refusing ${refusingRole} discloses nothing`, async () => {
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

      await rawRefusing.close();
      await rawPartner.close();
      await partner;
    });
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
