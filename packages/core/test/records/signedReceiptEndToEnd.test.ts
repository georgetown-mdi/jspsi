import { describe, expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import {
  assertLocalCertificateAuthorizesAgreedIdentity,
  assertReceiptBindingsOrAbort,
  exchangeDisclosedWithoutPartnerPayload,
  exchangeRecordFromFailure,
  exchangeRecordOwedButUnbuilt,
  prepareForExchange,
  runExchange,
} from "../../src/exchange";
import {
  ConnectionError,
  createMessagePipe,
} from "../../src/connection/messageConnection";
import { OperatorConfigError } from "../../src/errors";
import {
  ReceiptVerificationError,
  SIGNED_RECEIPT_VERSION,
  verifyReceiptSignature,
} from "../../src/records/signedReceipt";
import { verifyDualSignedRecord } from "../../src/records/signedReceiptVerification";
import {
  certificateAuthorizesIdentity,
  computeCertificateFingerprint,
  generateSigningIdentity,
} from "../../src/records/signingIdentity";
import { COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH } from "../../src/utils/sanitizeForDisplay";
import { canonicalString } from "../../src/utils/canonical";
import { safeParseLinkageTerms } from "../../src/config/linkageTermsSchema";
import { toCommittedPayload } from "../../src/payloadExchange";

import type { Output } from "../../src/config/linkageTermsSchema";
import type { MessageConnection } from "../../src/connection/messageConnection";
import type { ExchangeRecord } from "../../src/records/exchangeRecord";
import type { ExchangeResult } from "../../src/exchange";
import type { RunExchangeOptions } from "../../src/exchange";
import type { DualSignedRecordVerificationInputs } from "../../src/records/signedReceiptVerification";

// End-to-end coverage of the signed-receipt step in runExchange: two parties
// run a full exchange over an in-memory pipe (real PSI) with signing identities
// and a session key, and we assert the dual-signed record each side produces.
// This complements the isolated wire/sign/verify unit tests in
// signedReceipt.test.ts by exercising the gate and the content-from-record
// wiring in runExchange itself.

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

function prepared(identity: string, output: Output, rows: typeof serverRows) {
  return prepareForExchange(
    { linkageTerms: { ...firstNameTerms, identity, output } },
    identity,
    rows,
    ["first_name"],
  );
}

const both: Output = { expectsOutput: true, shareWithPartner: true };

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

/** Run a full exchange, threading each party's signing options. */
async function runBoth(
  initiatorSigning: Partial<RunExchangeOptions>,
  responderSigning: Partial<RunExchangeOptions>,
): Promise<[ExchangeResult, ExchangeResult]> {
  const [connInitiator, connResponder] = createMessagePipe();
  return Promise.all([
    runExchange(
      connInitiator,
      "initiator",
      prepared("Initiator Co", both, clientRows),
      {
        psiLibrary,
        ...initiatorSigning,
      },
    ),
    runExchange(
      connResponder,
      "responder",
      prepared("Responder Co", both, serverRows),
      {
        psiLibrary,
        ...responderSigning,
      },
    ),
  ]);
}

test("both parties produce one dual-signed record with mutual verification", async () => {
  const [resInit, resResp] = await runBoth(
    {
      signingIdentity: identityA,
      partnerFingerprint: fingerprintB,
      sessionKey,
    },
    {
      signingIdentity: identityB,
      partnerFingerprint: fingerprintA,
      sessionKey,
    },
  );

  // Both sides return the same dual-signed record (roles fixed by the handshake).
  expect(resInit.signedReceipt).toBeDefined();
  expect(resResp.signedReceipt).toBeDefined();
  expect(resInit.signedReceipt).toEqual(resResp.signedReceipt);

  const receipt = resInit.signedReceipt!;
  expect(receipt.version).toBe(SIGNED_RECEIPT_VERSION);
  // The receipt content commits to the SAME agreed-terms hash the self-attested
  // record holds.
  expect(receipt.content.termsHash).toBe(resInit.audit!.record.termsHash);
  // It holds the two directional payload MACs (session-keyed), not the salted
  // record commitments.
  expect(receipt.content.initiatorToResponderPayload).toEqual(
    expect.any(String),
  );
  expect(receipt.content.responderToInitiatorPayload).toEqual(
    expect.any(String),
  );
  // Both signatures verify against the shared content bound to their roles.
  expect(
    await verifyReceiptSignature(
      receipt.initiator.certificate,
      receipt.content,
      receipt.initiator.signature,
      "initiator",
    ),
  ).toBe(true);
  expect(
    await verifyReceiptSignature(
      receipt.responder.certificate,
      receipt.content,
      receipt.responder.signature,
      "responder",
    ),
  ).toBe(true);
  expect(receipt.initiator.certificate).toEqual(identityA.certificate);
  expect(receipt.responder.certificate).toEqual(identityB.certificate);
});

test("the negative path: no signing config leaves the record path unchanged", async () => {
  // Neither party supplies a signing identity, so the signing step is skipped
  // entirely and the self-attested record path runs unchanged.
  const [resInit, resResp] = await runBoth({}, {});
  expect(resInit.signedReceipt).toBeUndefined();
  expect(resResp.signedReceipt).toBeUndefined();
  // The unsigned record is still produced.
  expect(resInit.audit).toBeDefined();
  expect(resResp.audit).toBeDefined();
});

test("a partner that signs nothing is refused at the terms exchange", async () => {
  // The responder has no signing identity, so it presents no certificate on
  // the terms envelope and can produce no receipt. The initiator, which will
  // sign, refuses there -- before the bootstrap frame, any linkage key, and any
  // payload row -- rather than running to a swap that could never complete.
  const [rawInitiator, connResponder] = createMessagePipe();
  const initiatorSide = recording(rawInitiator);
  const responder = runExchange(
    connResponder,
    "responder",
    prepared("Responder Co", both, serverRows),
    { psiLibrary },
  ).catch((reason: unknown) => reason);
  const raised = await runExchange(
    initiatorSide.conn,
    "initiator",
    prepared("Initiator Co", both, clientRows),
    {
      psiLibrary,
      signingIdentity: identityA,
      partnerFingerprint: fingerprintB,
      sessionKey,
    },
  ).then(
    () => {
      throw new Error("expected the signing party to refuse the terms");
    },
    (reason: unknown) => reason,
  );

  expect(raised).toBeInstanceOf(ReceiptVerificationError);
  expect((raised as Error).message).toMatch(/partner is not signing receipts/);
  // Nothing of this party's data moved: the frames it sent are its own terms,
  // the decision closing the terms exchange, and the abort that releases the
  // partner.
  expect(initiatorSide.sent.map(frameKind)).toEqual([
    "terms",
    "decision",
    "abort",
  ]);
  expect(exchangeRecordFromFailure(raised)).toBeUndefined();
  expect(exchangeRecordOwedButUnbuilt(raised)).toBe(false);

  await rawInitiator.close();
  await connResponder.close();
  await responder;
});

test("an unnamed party refuses at terms agreement rather than signing", async () => {
  // A certificate is trusted by the identity its holder used in the AGREED TERMS,
  // and `linkage_terms.identity` is optional -- so a party that named itself none
  // has nothing for the pin to authorize. Both sides refuse the moment the terms
  // are agreed, and each refusal names the side that is unnamed rather than
  // reaching for a substitute.
  const [connInitiator, connResponder] = createMessagePipe();
  const unnamed = prepareForExchange(
    { linkageTerms: { ...firstNameTerms, output: both } },
    undefined,
    serverRows,
    ["first_name"],
  );
  expect(unnamed.linkageTerms.identity).toBeUndefined();

  const initiator = runExchange(
    connInitiator,
    "initiator",
    prepared("Initiator Co", both, clientRows),
    {
      psiLibrary,
      signingIdentity: identityA,
      partnerFingerprint: fingerprintB,
      sessionKey,
    },
  );
  const responder = runExchange(connResponder, "responder", unnamed, {
    psiLibrary,
    signingIdentity: identityB,
    partnerFingerprint: fingerprintA,
    sessionKey,
  });

  // Settled together: both sides reject, and awaiting them one after the other
  // would leave the second rejection unhandled while the first is asserted.
  const [initiatorOutcome, responderOutcome] = await Promise.allSettled([
    initiator,
    responder,
  ]);
  expect(initiatorOutcome.status).toBe("rejected");
  expect(responderOutcome.status).toBe("rejected");
  expect(
    String(
      (initiatorOutcome as PromiseRejectedResult).reason instanceof Error
        ? ((initiatorOutcome as PromiseRejectedResult).reason as Error).message
        : "",
    ),
  ).toContain("the partner's agreed terms name none");
  expect(
    String(
      (responderOutcome as PromiseRejectedResult).reason instanceof Error
        ? ((responderOutcome as PromiseRejectedResult).reason as Error).message
        : "",
    ),
  ).toContain("this party's agreed terms name none");
  await connInitiator.close();
  await connResponder.close();
});

// --- The refusal's timing, read off the wire ---------------------------------

/**
 * What a frame a party put on the wire is, by the field that identifies it: the
 * terms frames and the bare decision frame the terms exchange sends, the abort
 * that ends a refused run, the payload frame, the signature swap's receipt frame,
 * and `opaque` for everything else -- which is what a PSI round's binary message
 * classifies as. Asserting the whole sequence therefore pins what did NOT go out
 * as much as what did.
 */
function frameKind(frame: unknown): string {
  if (typeof frame !== "object" || frame === null) return "opaque";
  if ("hasData" in frame) return "payload";
  if ("linkageTerms" in frame) return "terms";
  if ("certificate" in frame) return "receipt";
  if ("decision" in frame)
    return (frame as { decision: unknown }).decision === "abort"
      ? "abort"
      : "decision";
  return "opaque";
}

/** A connection that records, in order, every frame the party sends through it. */
function recording(conn: MessageConnection): {
  conn: MessageConnection;
  sent: Array<unknown>;
} {
  const sent: Array<unknown> = [];
  return {
    sent,
    conn: {
      send: (data: unknown) => {
        sent.push(data);
        return conn.send(data);
      },
      receive: (timeoutMs?: number) => conn.receive(timeoutMs),
      close: () => conn.close(),
      setInboundFrameCap: (maxBytes: number | undefined) =>
        conn.setInboundFrameCap?.(maxBytes),
    },
  };
}

describe("a signing party refuses an unnamed partner before its own data moves", () => {
  // The partner here signs nothing: an unnamed party that DID configure
  // certificate signing is refused by prepareForExchange before it connects, so
  // the pair that can actually reach a terms exchange is a signing party against
  // an unsigned one. It is that signing party's timing under test, on both
  // handshake roles, since the two send different frames before the partner's
  // terms are in hand.
  for (const signerRole of ["initiator", "responder"] as const) {
    test(`the ${signerRole} refuses, sending nothing past terms, decision, and abort`, async () => {
      const [rawSigner, rawPartner] = createMessagePipe();
      const signerSide = recording(rawSigner);
      const partnerSide = recording(rawPartner);
      const unnamed = prepareForExchange(
        { linkageTerms: { ...firstNameTerms, output: both } },
        undefined,
        serverRows,
        ["first_name"],
      );
      expect(unnamed.linkageTerms.identity).toBeUndefined();

      const partnerRole =
        signerRole === "initiator" ? "responder" : "initiator";
      const refusal = runExchange(
        signerSide.conn,
        signerRole,
        prepared("Signing Co", both, clientRows),
        {
          psiLibrary,
          signingIdentity: identityA,
          partnerFingerprint: fingerprintB,
          sessionKey,
        },
      ).then(
        () => {
          throw new Error("expected the signing party to refuse");
        },
        (reason: unknown) => reason,
      );
      // The unsigned partner derives no refusal of its own: it runs on into the
      // PSI rounds until the abort frame reaches it (or the close below does).
      const partner = runExchange(partnerSide.conn, partnerRole, unnamed, {
        psiLibrary,
      }).catch(() => undefined);

      const raised = await refusal;
      expect(raised).toBeInstanceOf(ReceiptVerificationError);
      expect((raised as Error).message).toContain(
        "the partner's agreed terms name none",
      );

      // The whole point of the timing, read off the wire: the terms exchange's
      // own frames went out and then the abort, and nothing else did -- no
      // linkage key, no payload row. The initiator sends its terms and the bare
      // proceed decision before the partner's terms are in hand; the responder's
      // single frame holds both.
      expect(signerSide.sent.map(frameKind)).toEqual(
        signerRole === "initiator"
          ? ["terms", "decision", "abort"]
          : ["terms", "abort"],
      );
      // And in the other direction, the partner disclosed no payload either.
      expect(partnerSide.sent.map(frameKind)).not.toContain("payload");

      await rawSigner.close();
      await rawPartner.close();
      await partner;
    });
  }

  test("the same pair completes when neither party signs", async () => {
    // The refusal is the signing configuration's, not the unnamed partner's: an
    // unsigned exchange against a party that named nobody runs to a result.
    const [connInitiator, connResponder] = createMessagePipe();
    const unnamed = prepareForExchange(
      { linkageTerms: { ...firstNameTerms, output: both } },
      undefined,
      serverRows,
      ["first_name"],
    );
    const [named, unnamedResult] = await Promise.all([
      runExchange(
        connInitiator,
        "initiator",
        prepared("Signing Co", both, clientRows),
        { psiLibrary },
      ),
      runExchange(connResponder, "responder", unnamed, { psiLibrary }),
    ]);
    expect(named.signedReceipt).toBeUndefined();
    expect(named.partnerTerms.identity).toBeUndefined();
    expect(unnamedResult.partnerTerms.identity).toBe("Signing Co");
    expect(named.audit!.record.termsHash).toBe(
      unnamedResult.audit!.record.termsHash,
    );
    await connInitiator.close();
    await connResponder.close();
  });
});

describe("a fingerprint-pin mismatch ends the run at the terms exchange", () => {
  // The certificate rides the terms envelope, so a partner certificate that is
  // not the pinned one is refused the moment the terms are agreed -- before the
  // bootstrap frame, any linkage key, and any payload row. Driven from both
  // handshake seats: the value compared is fixed the moment the partner's terms
  // arrive, so neither role reaches the rounds.
  for (const refusingRole of ["initiator", "responder"] as const) {
    test(`the refusing ${refusingRole} discloses nothing`, async () => {
      const [rawRefusing, rawPartner] = createMessagePipe();
      const refusingSide = recording(rawRefusing);
      const partnerRole =
        refusingRole === "initiator" ? "responder" : "initiator";
      const partner = runExchange(
        rawPartner,
        partnerRole,
        prepared(
          partnerRole === "initiator" ? "Initiator Co" : "Responder Co",
          both,
          partnerRole === "initiator" ? clientRows : serverRows,
        ),
        {
          psiLibrary,
          signingIdentity: partnerRole === "initiator" ? identityA : identityB,
          partnerFingerprint:
            partnerRole === "initiator" ? fingerprintB : fingerprintA,
          sessionKey,
        },
      ).catch((reason: unknown) => reason);
      const raised = await runExchange(
        refusingSide.conn,
        refusingRole,
        prepared(
          refusingRole === "initiator" ? "Initiator Co" : "Responder Co",
          both,
          refusingRole === "initiator" ? clientRows : serverRows,
        ),
        {
          psiLibrary,
          signingIdentity: refusingRole === "initiator" ? identityA : identityB,
          // WRONG pin: this party's own fingerprint, never its partner's.
          partnerFingerprint:
            refusingRole === "initiator" ? fingerprintA : fingerprintB,
          sessionKey,
        },
      ).then(
        () => {
          throw new Error("expected the mismatched pin to end the run");
        },
        (reason: unknown) => reason,
      );

      expect(raised).toBeInstanceOf(ReceiptVerificationError);
      expect((raised as Error).message).toMatch(
        /not the one pinned in signing\.partner_fingerprint/,
      );
      // The terms exchange's own frames went out and then the abort, and
      // nothing else did -- no linkage key, no payload row, no receipt -- so
      // there is no disclosure for a record to attest and none is reported
      // lost. The initiator sends its terms and the bare proceed decision
      // before the partner's terms are in hand; the responder's single frame
      // holds both.
      expect(refusingSide.sent.map(frameKind)).toEqual(
        refusingRole === "initiator"
          ? ["terms", "decision", "abort"]
          : ["terms", "abort"],
      );
      expect(exchangeRecordFromFailure(raised)).toBeUndefined();
      expect(exchangeRecordOwedButUnbuilt(raised)).toBe(false);

      await rawRefusing.close();
      await rawPartner.close();
      await partner;
    });
  }
});

// --- A certificate bound away from its own agreed-terms identity -------------

describe("a party whose certificate is bound away from its agreed terms", () => {
  // A certificate is authorized against the AGREED-TERMS identity, so signing
  // under one bound to anything else leaves the pair no verifiable receipt.
  // What it is left with depends on its handshake role: signing first, its
  // frame is refused; signing last, it is handed an unverifiable receipt
  // instead. Both roles are driven here; the values compared are fixed the
  // moment the partner's terms arrive, so neither reaches the rounds.
  //
  // The certificate is identityA/identityB throughout, bound to "Initiator Co" /
  // "Responder Co"; only the terms identity the diverging party runs under moves.
  const RENAMED = "Renamed In The Config";

  for (const divergingRole of ["initiator", "responder"] as const) {
    test(`as the ${divergingRole}, it refuses at terms agreement, before any key or payload row moves`, async () => {
      const divergesFirst = divergingRole === "initiator";
      const [rawInitiator, rawResponder] = createMessagePipe();
      const initiatorSide = recording(rawInitiator);
      const responderSide = recording(rawResponder);

      const initiator = runExchange(
        initiatorSide.conn,
        "initiator",
        prepared(divergesFirst ? RENAMED : "Initiator Co", both, clientRows),
        {
          psiLibrary,
          signingIdentity: identityA,
          partnerFingerprint: fingerprintB,
          sessionKey,
        },
      ).then(
        () => {
          throw new Error("expected the initiator's leg to reject, not return");
        },
        (reason: unknown) => reason,
      );
      const responder = runExchange(
        responderSide.conn,
        "responder",
        prepared(divergesFirst ? "Responder Co" : RENAMED, both, serverRows),
        {
          psiLibrary,
          signingIdentity: identityB,
          partnerFingerprint: fingerprintA,
          sessionKey,
        },
      ).then(
        () => {
          throw new Error("expected the responder's leg to reject, not return");
        },
        (reason: unknown) => reason,
      );

      const diverging = divergesFirst ? initiatorSide : responderSide;
      const raised = await (divergesFirst ? initiator : responder);
      // Its own configuration is what failed, and the refusal names both values
      // that disagree: an operator is told which name to change, and a caller
      // branching on the type is not told the peer failed a trust boundary.
      expect(raised).toBeInstanceOf(OperatorConfigError);
      expect(raised).not.toBeInstanceOf(ReceiptVerificationError);
      expect((raised as Error).message).toContain(RENAMED);
      expect((raised as Error).message).toContain(
        divergesFirst ? "Initiator Co" : "Responder Co",
      );
      // The timing, read off the wire: the terms exchange's own frames went out
      // and then the abort, and nothing else did -- no linkage key, no payload
      // row, and no certificate. The initiator sends its terms and the bare
      // proceed decision before the partner's terms are in hand; the responder's
      // single frame holds both.
      expect(diverging.sent.map(frameKind)).toEqual(
        divergesFirst ? ["terms", "decision", "abort"] : ["terms", "abort"],
      );
      // Nothing was disclosed, so there is no disclosure to attest: the refusal
      // holds no exchange record, where the same refusal met at the swap
      // holds the terminated run's.
      expect(exchangeRecordFromFailure(raised)).toBeUndefined();

      // The partner derives no refusal of its own, so what ends its run is the
      // abort's arrival rather than an inactivity budget: it settles without the
      // pipe being closed under it. Its own leg never reached the swap either,
      // so it holds no receipt.
      const partnerOutcome = await (divergesFirst ? responder : initiator);
      expect(partnerOutcome).toBeInstanceOf(Error);
      const partnerSide = divergesFirst ? responderSide : initiatorSide;
      expect(partnerSide.sent.map(frameKind)).not.toContain("receipt");
      await rawInitiator.close();
      await rawResponder.close();
    });
  }

  test("a certificate that does authorize the agreed identity still signs", async () => {
    // The refusal is the divergence's, not the check's: on the same pair, each
    // party's terms naming the identity its certificate holds, both receipt
    // frames go out and both sides return the dual-signed record. A
    // legitimately-configured exchange traverses the terms-exchange binding
    // untouched: it neither refuses nor aborts anywhere along the way.
    const [rawInitiator, rawResponder] = createMessagePipe();
    const initiatorSide = recording(rawInitiator);
    const responderSide = recording(rawResponder);
    const [resInitiator, resResponder] = await Promise.all([
      runExchange(
        initiatorSide.conn,
        "initiator",
        prepared("Initiator Co", both, clientRows),
        {
          psiLibrary,
          signingIdentity: identityA,
          partnerFingerprint: fingerprintB,
          sessionKey,
        },
      ),
      runExchange(
        responderSide.conn,
        "responder",
        prepared("Responder Co", both, serverRows),
        {
          psiLibrary,
          signingIdentity: identityB,
          partnerFingerprint: fingerprintA,
          sessionKey,
        },
      ),
    ]);
    expect(resInitiator.signedReceipt).toBeDefined();
    expect(resInitiator.signedReceipt).toEqual(resResponder.signedReceipt);
    expect(
      certificateAuthorizesIdentity(
        resInitiator.signedReceipt!.initiator.certificate,
        "Initiator Co",
      ),
    ).toBe(true);
    // Both frames went out, so the negative assertions above are not vacuous.
    expect(initiatorSide.sent.map(frameKind)).toContain("receipt");
    expect(responderSide.sent.map(frameKind)).toContain("receipt");
    // And neither leg aborted anywhere along the way.
    expect(initiatorSide.sent.map(frameKind)).not.toContain("abort");
    expect(responderSide.sent.map(frameKind)).not.toContain("abort");
    await rawInitiator.close();
    await rawResponder.close();
  });
});

// --- The same bindings at the swap, the point of use -------------------------

describe("the receipt bindings held at the signature swap", () => {
  // runExchange holds this pair at the terms exchange too, over the same three
  // values, so nothing reaches the swap copy through it -- these drive the copy
  // directly, which is what a caller arriving by another route meets.

  /** A connection that records what was sent and never delivers anything. */
  function collecting(): { conn: MessageConnection; sent: Array<unknown> } {
    const sent: Array<unknown> = [];
    return {
      sent,
      conn: {
        send: (data: unknown) => {
          sent.push(data);
          return Promise.resolve();
        },
        receive: () => new Promise<unknown>(() => {}),
        close: () => Promise.resolve(),
      },
    };
  }

  const anonymousTerms = { ...firstNameTerms, output: both };
  const namedTerms = (identity: string) => ({ ...anonymousTerms, identity });

  test("a certificate bound away from the agreed terms aborts, then refuses", async () => {
    const { conn, sent } = collecting();
    const raised = await assertReceiptBindingsOrAbort(
      conn,
      namedTerms("Renamed In The Config"),
      namedTerms("Responder Co"),
      identityA.certificate,
    ).then(
      () => {
        throw new Error("expected the local binding to refuse");
      },
      (reason: unknown) => reason,
    );
    expect(raised).toBeInstanceOf(OperatorConfigError);
    // The abort goes out BEFORE the refusal propagates, so the partner parked on
    // the receipt frame is released by the frame rather than by its inactivity
    // budget. Its reason is a fixed literal naming neither identity.
    expect(sent).toEqual([
      {
        decision: "abort",
        abortReasons: [
          "a signing certificate does not authorize the identity its holder " +
            "agreed terms under",
        ],
      },
    ]);
  });

  test("an unnamed party aborts under its own reason", async () => {
    const { conn, sent } = collecting();
    const raised = await assertReceiptBindingsOrAbort(
      conn,
      namedTerms("Initiator Co"),
      anonymousTerms,
      identityA.certificate,
    ).then(
      () => {
        throw new Error("expected the naming binding to refuse");
      },
      (reason: unknown) => reason,
    );
    expect(raised).toBeInstanceOf(ReceiptVerificationError);
    expect(sent).toEqual([
      {
        decision: "abort",
        abortReasons: [
          "a signed receipt names both parties and one side's agreed terms " +
            "name no identity",
        ],
      },
    ]);
  });

  test("a matching pair returns both names and sends nothing", async () => {
    const { conn, sent } = collecting();
    await expect(
      assertReceiptBindingsOrAbort(
        conn,
        namedTerms("Initiator Co"),
        namedTerms("Responder Co"),
        identityA.certificate,
      ),
    ).resolves.toEqual({ local: "Initiator Co", partner: "Responder Co" });
    expect(sent).toEqual([]);
  });
});

// The two identities land LAST in this refusal
// (assertLocalCertificateAuthorizesAgreedIdentity's own JSDoc), so whatever the
// fixed prose spends of the display budget comes out of them -- the values an
// operator must compare to act on it. Copy, not code, erodes that room, so the
// budget is a check, not a comment; the CLI's identical pattern
// (assertIdentityMatchesAgreedTerms) is pinned in exchangeSigning.test.ts.

/** Room the refusal must leave for the two identities together, in characters. */
const IDENTITY_PAIR_DISPLAY_BUDGET = 350;

test("the local-certificate refusal's fixed prose leaves the identity pair room inside the display cap", () => {
  const agreedIdentity = "Party A, Agency A, a@agency-a.gov";
  let thrown: unknown;
  try {
    assertLocalCertificateAuthorizesAgreedIdentity(
      identityA.certificate,
      agreedIdentity,
    );
  } catch (err) {
    thrown = err;
  }
  // The composed message less the two values it names; identityA's certificate
  // is bound to "Initiator Co".
  const message = (thrown as Error).message;
  const fixedProse =
    message.length -
    identityA.certificate.identity.length -
    agreedIdentity.length;
  expect(fixedProse).toBeLessThanOrEqual(
    COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH - IDENTITY_PAIR_DISPLAY_BUDGET,
  );
});

test("a certificate bound to a label the terms refuse names the re-key exit and no part of the label", () => {
  // The identity file admits any non-empty label (records/signingIdentity.ts),
  // so a certificate can hold one the terms refuse -- and its holder meets this
  // refusal with no linkage_terms.identity edit that reconciles the pair.
  const boundLabel = "Initiator\u202eCo";
  const agreedIdentity = "Initiator Co";
  expect(
    safeParseLinkageTerms({ ...firstNameTerms, identity: boundLabel }).success,
  ).toBe(false);

  let thrown: unknown;
  try {
    assertLocalCertificateAuthorizesAgreedIdentity(
      { ...identityA.certificate, identity: boundLabel },
      agreedIdentity,
    );
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(OperatorConfigError);
  const message = (thrown as Error).message;
  expect(message).toContain("psilink fingerprint --force --identity");
  expect(message).toContain("re-pin the new fingerprint");
  expect(message).not.toContain("linkage_terms.identity to the name on the");
  expect(message).not.toContain(boundLabel);
  expect(message).not.toContain("\u202e");
});

// --- Pairing a receipt to one run --------------------------------------------

/** A signed run of the one partnership, under the session key `key`. */
function runSigned(
  key: Uint8Array<ArrayBuffer>,
): Promise<[ExchangeResult, ExchangeResult]> {
  return runBoth(
    {
      signingIdentity: identityA,
      partnerFingerprint: fingerprintB,
      sessionKey: key,
    },
    {
      signingIdentity: identityB,
      partnerFingerprint: fingerprintA,
      sessionKey: key,
    },
  );
}

// Two runs of ONE partnership over identical terms, identities, and data, differing
// only in the session key their key exchanges produced -- the recurring-exchange
// shape a receipt's signed content cannot tell apart on its own: the terms hash and
// both certificates repeat byte for byte, and the payload MACs that do differ are
// not recomputable by any verifier.
const firstRun = await runSigned(sessionKey);
const secondRun = await runSigned(
  new Uint8Array(32).fill(22) as Uint8Array<ArrayBuffer>,
);
const firstRecord = firstRun[0].audit!.record;
const secondRecord = secondRun[0].audit!.record;
const firstReceipt = firstRun[0].signedReceipt!;

/**
 * What the initiator holds when it re-verifies its own receipt offline: the partner
 * pinned out-of-band, its own certificate as the other anchor, and the identities,
 * terms hash, and run binder its exchange record holds. Everything but the
 * pairing is identical for either run's record, which is the point -- the pairing is
 * the only check that can separate them.
 */
function heldByInitiator(
  record: ExchangeRecord,
): DualSignedRecordVerificationInputs {
  return {
    pinnedFingerprints: [fingerprintB],
    localIdentity: { fingerprint: fingerprintA, source: "named" },
    // Both parties named themselves in this suite's terms, which is what a run
    // producing a receipt requires -- runExchange refuses the receipt step when
    // either side's agreed terms name no identity.
    expectedIdentities: [
      record.localIdentity ?? "",
      record.partnerIdentity ?? "",
    ],
    expectedTermsHash: record.termsHash,
    recordReceiptBinder: record.receiptBinder ?? null,
  };
}

describe("the run binder pairs a receipt to one exchange run", () => {
  test("both parties' records hold the run's receipt binder", async () => {
    expect(firstRecord.receiptBinder).toBe(firstReceipt.content.binder);
    expect(firstRun[1].audit!.record.receiptBinder).toBe(
      firstRecord.receiptBinder,
    );
  });

  test("two runs of one partnership under identical terms hold distinct binders", async () => {
    // Every signed value an offline verifier can CHECK is equal across the two
    // runs: the terms hash (recomputable from both parties' terms) and the two
    // certificates. The directional payload MACs do vary with the session key, but
    // a verifier cannot recompute them either, so they separate nothing. The binder
    // is the one per-run value the record also holds.
    expect(secondRecord.termsHash).toBe(firstRecord.termsHash);
    expect(secondRun[0].signedReceipt!.content.termsHash).toBe(
      firstReceipt.content.termsHash,
    );
    expect(secondRun[0].signedReceipt!.initiator.certificate).toEqual(
      firstReceipt.initiator.certificate,
    );
    expect(secondRecord.receiptBinder).not.toBe(firstRecord.receiptBinder);
  });

  test("a matched receipt/record pair verifies", async () => {
    const report = await verifyDualSignedRecord(
      firstReceipt,
      heldByInitiator(firstRecord),
    );
    expect(report.runBinding).toBe("verified");
    expect(report.outcome).toBe("verified");
  });

  test("one run's receipt beside another run's record is a mismatch", async () => {
    const report = await verifyDualSignedRecord(
      firstReceipt,
      heldByInitiator(secondRecord),
    );
    expect(report.runBinding).toBe("mismatch");
    expect(report.outcome).toBe("failed");
    // Every other check still passes: the two runs share the partnership and the
    // terms, so the pairing is the only thing that separates them.
    expect(report.termsHash).toBe("verified");
    expect(report.initiator.signature).toBe("verified");
    expect(report.responder.signature).toBe("verified");
    expect(report.initiator.assertedIdentity).toBe("verified");
    expect(report.initiator.certificateAnchor).toBe("local-identity");
    expect(report.responder.certificateAnchor).toBe("partner-pin");
  });

  test("a record of a run that produced no receipt reports the receipt as unpaired", async () => {
    const [unsigned] = await runBoth({}, {});
    const unsignedRecord = unsigned.audit!.record;
    expect(unsignedRecord.receiptBinder).toBeUndefined();
    const report = await verifyDualSignedRecord(
      firstReceipt,
      heldByInitiator(unsignedRecord),
    );
    expect(report.runBinding).toBe("unpaired");
    expect(report.outcome).toBe("failed");
    expect(report.termsHash).toBe("verified");
  });

  test("a receipt held without any record leaves the pairing unchecked, short of verified", async () => {
    // The holder of one artifact is not accused of anything: with no record beside
    // it there is nothing to pair, and the verdict says so rather than failing.
    const report = await verifyDualSignedRecord(firstReceipt, {
      ...heldByInitiator(firstRecord),
      recordReceiptBinder: undefined,
    });
    expect(report.runBinding).toBe("not-checked");
    expect(report.outcome).toBe("incomplete");
    expect(report.initiator.signature).toBe("verified");
  });
});

// --- The record a terminated swap leaves behind ------------------------------

// A second pair of datasets holding a payload column, for the routes that need
// one to have crossed. The suite's main fixtures link on first_name alone, and a
// party that transmits nothing gives the received-payload check nothing to refuse.
const payloadServer = [
  { first_name: "Carol", note: "s-c" },
  { first_name: "Elizabeth", note: "s-e" },
  { first_name: "Henry", note: "s-h" },
];
const payloadClient = [
  { first_name: "Carol", note: "c-c" },
  { first_name: "Elizabeth", note: "c-e" },
];

/** The suite's `prepared`, with `note` inferred as a transmitted payload column. */
function preparedWithPayload(identity: string, rows: typeof payloadServer) {
  return prepareForExchange(
    { linkageTerms: { ...firstNameTerms, identity, output: both } },
    identity,
    rows,
    ["first_name", "note"],
  );
}

/** Fail this party's connection at the `nth` frame it sends or receives after
 * its own payload frame has gone out, placing a cut at a chosen position inside
 * the record-owed region. */
function cutAfterPayloadSend(
  conn: MessageConnection,
  nth: number,
): MessageConnection {
  let payloadSent = false;
  let framesSinceSend = 0;
  const cutHere = () => {
    if (!payloadSent) return;
    framesSinceSend += 1;
    if (framesSinceSend === nth)
      throw new ConnectionError("the connection dropped", "transport");
  };
  const isPayload = (data: unknown) =>
    typeof data === "object" && data !== null && "hasData" in data;
  return {
    send: async (data) => {
      cutHere();
      await conn.send(data);
      if (isPayload(data)) payloadSent = true;
    },
    receive: (timeoutMs?: number) => {
      cutHere();
      return conn.receive(timeoutMs);
    },
    close: () => conn.close(),
  };
}

/** Reject this party's own payload send at the transport, leaving every earlier
 * message of the exchange to go out normally. */
function rejectPayloadSend(conn: MessageConnection): MessageConnection {
  return {
    send: async (data) => {
      if (typeof data === "object" && data !== null && "hasData" in data)
        throw new ConnectionError("the connection dropped", "transport");
      await conn.send(data);
    },
    receive: (timeoutMs?: number) => conn.receive(timeoutMs),
    close: () => conn.close(),
  };
}

/** Swap this party's outbound payload frame for `forged`, leaving every other
 * message of the exchange untouched. */
function withForgedPayload(
  conn: MessageConnection,
  forged: unknown,
): MessageConnection {
  return {
    send: (data) =>
      conn.send(
        typeof data === "object" && data !== null && "hasData" in data
          ? forged
          : data,
      ),
    receive: (timeoutMs?: number) => conn.receive(timeoutMs),
    close: () => conn.close(),
  };
}

/** Swap the certificate on this party's outbound receipt frame for `forged`,
 * leaving every other message of the exchange untouched. The terms frame also
 * carries a certificate, so the receipt frame is told apart by the signature
 * beside it. */
function withForgedReceiptCertificate(
  conn: MessageConnection,
  forged: unknown,
): MessageConnection {
  return {
    send: (data) =>
      conn.send(
        typeof data === "object" &&
          data !== null &&
          "certificate" in data &&
          "signature" in data
          ? { ...data, certificate: forged }
          : data,
      ),
    receive: (timeoutMs?: number) => conn.receive(timeoutMs),
    close: () => conn.close(),
  };
}

/** Drop this party's outbound receipt frame, leaving every other message of the
 * exchange untouched: the partner waits on a terminal frame that never comes. */
function withoutReceiptFrame(conn: MessageConnection): MessageConnection {
  return {
    send: async (data) => {
      if (
        typeof data === "object" &&
        data !== null &&
        "certificate" in data &&
        "signature" in data
      )
        return;
      await conn.send(data);
    },
    receive: (timeoutMs?: number) => conn.receive(timeoutMs),
    close: () => conn.close(),
  };
}

describe("a run terminated after its disclosure keeps the record of it", () => {
  // The durability point: the record is owed from the moment this party's own
  // payload crosses, because the disclosure it attests has happened from there
  // on. Everything after that send -- the rest of the payload exchange, the
  // received-payload check and the whole signed-receipt swap -- can fail without
  // taking the record with it (docs/spec/PROTOCOL.md, Self-attested record).

  test("a swapped certificate at the swap leaves both sides a terminated record", async () => {
    // The certificate the initiator presented at the terms exchange matched the
    // responder's pin, and the one on its receipt frame is another party's --
    // the divergence the swap is still the enforcement point for. The responder
    // refuses it before checking any signature; the initiator, having sent its
    // frame first, is left parked on a terminal frame that never arrives. Both
    // parties had already exchanged payloads, so both are owed a record.
    const [rawInitiator, connResponder] = createMessagePipe();
    const initiator = runExchange(
      withForgedReceiptCertificate(rawInitiator, identityB.certificate),
      "initiator",
      prepared("Initiator Co", both, clientRows),
      {
        psiLibrary,
        signingIdentity: identityA,
        partnerFingerprint: fingerprintB,
        sessionKey,
      },
    ).then(
      () => {
        throw new Error("expected the initiator's run to terminate");
      },
      (reason: unknown) => reason,
    );
    const responderFailure = await runExchange(
      connResponder,
      "responder",
      prepared("Responder Co", both, serverRows),
      {
        psiLibrary,
        signingIdentity: identityB,
        partnerFingerprint: fingerprintA,
        sessionKey,
      },
    ).then(
      () => {
        throw new Error("expected the responder to reject the swapped frame");
      },
      (reason: unknown) => reason,
    );

    expect(responderFailure).toBeInstanceOf(ReceiptVerificationError);
    expect((responderFailure as Error).message).toMatch(/not trusted/);
    const responderKept = exchangeRecordFromFailure(responderFailure);
    expect(responderKept?.record.outcome).toBe("receipt-swap-terminated");
    // The disclosure is attested as fully as a completed run's is: the record
    // commits to both payload directions and to the pairing this party received,
    // and states its own exposure.
    expect(responderKept?.record.recordsExposed).toBe(serverRows.length);
    expect(responderKept?.record.commitments.associationTable).toBeDefined();
    expect(responderKept?.keys.salts.associationTable).toBeDefined();
    // The run derived a binder and the record keeps it: the partner may hold a
    // receipt bearing it, and a record that dropped it would leave that receipt
    // unpairable.
    expect(responderKept?.record.receiptBinder).toBeDefined();
    // The record is in hand, so nothing was lost to a failed build.
    expect(exchangeRecordOwedButUnbuilt(responderFailure)).toBe(false);

    await rawInitiator.close();
    await connResponder.close();
    const initiatorFailure = await initiator;
    const initiatorKept = exchangeRecordFromFailure(initiatorFailure);
    expect(initiatorKept?.record.outcome).toBe("receipt-swap-terminated");
    expect(initiatorKept?.record.recordsExposed).toBe(clientRows.length);
    // Both parties' records are of the one run: the agreed-terms hash and the
    // derived binder are values both sides compute identically.
    expect(initiatorKept?.record.termsHash).toBe(
      responderKept?.record.termsHash,
    );
    expect(initiatorKept?.record.receiptBinder).toBe(
      responderKept?.record.receiptBinder,
    );
  });

  test("a transport drop mid-swap leaves the signing party a terminated record", async () => {
    // The partner's terminal receipt frame never reaches the wire, so it
    // completes while the initiator waits for one; the connection then drops
    // under the initiator. The failure is a transport fault rather than a
    // security event, and the record survives it just the same.
    const [connInitiator, rawResponder] = createMessagePipe();
    const initiator = runExchange(
      connInitiator,
      "initiator",
      prepared("Initiator Co", both, clientRows),
      {
        psiLibrary,
        signingIdentity: identityA,
        partnerFingerprint: fingerprintB,
        sessionKey,
      },
    ).then(
      () => {
        throw new Error("expected the initiator's run to terminate");
      },
      (reason: unknown) => reason,
    );
    const partner = await runExchange(
      withoutReceiptFrame(rawResponder),
      "responder",
      prepared("Responder Co", both, serverRows),
      {
        psiLibrary,
        signingIdentity: identityB,
        partnerFingerprint: fingerprintA,
        sessionKey,
      },
    );
    // The partner completed: it verified the initiator's frame and its own
    // record says so.
    expect(partner.audit!.record.outcome).toBe("completed");
    expect(partner.signedReceipt).toBeDefined();

    await rawResponder.close();
    await connInitiator.close();
    const failure = await initiator;
    expect(failure).not.toBeInstanceOf(ReceiptVerificationError);
    expect(failure).toBeInstanceOf(ConnectionError);
    const kept = exchangeRecordFromFailure(failure);
    expect(kept?.record.outcome).toBe("receipt-swap-terminated");
    expect(kept?.record.receiptBinder).toBeDefined();
  });

  test("a completed run's record says so, and a failure before the disclosure has none", async () => {
    // The two ends of the rule. A run that finished records `completed`; a run
    // that never disclosed has no record to hand back, because there was no
    // disclosure to attest -- here the terms-time refusal of a signing run whose
    // partner named nobody, which stops before any linkage key moves.
    const [completed] = await runSigned(sessionKey);
    expect(completed.audit!.record.outcome).toBe("completed");
    expect(completed.signedReceipt).toBeDefined();

    const [connInitiator, connResponder] = createMessagePipe();
    const unnamed = runExchange(
      connInitiator,
      "initiator",
      prepared("Initiator Co", both, clientRows),
      { psiLibrary },
    ).catch(() => undefined);
    const refused = await runExchange(
      connResponder,
      "responder",
      prepareForExchange(
        { linkageTerms: { ...firstNameTerms, output: both } },
        "unnamed",
        serverRows,
        ["first_name"],
      ),
      {
        psiLibrary,
        signingIdentity: identityB,
        partnerFingerprint: fingerprintA,
        sessionKey,
      },
    ).then(
      () => {
        throw new Error("expected the signing party to refuse at terms");
      },
      (reason: unknown) => reason,
    );
    expect(exchangeRecordFromFailure(refused)).toBeUndefined();
    // Nothing was owed, so nothing is reported lost: this is the answer the
    // owed-but-unbuilt case below has to be distinguishable from.
    expect(exchangeRecordOwedButUnbuilt(refused)).toBe(false);
    await connInitiator.close();
    await connResponder.close();
    await unnamed;
  });

  test("a received payload outside the consented set terminates with a record too", async () => {
    // The route past the payload exchange that is not the swap. The initiator
    // has locked in a column set the responder does not transmit, so
    // reconcileReceivedPayload refuses AFTER both payloads have crossed: this
    // party's own data has been handed to the transport whatever came back, so the
    // disclosure is owed a record exactly as a terminated swap's is. Both sides
    // run unsigned, so the receipt step plays no part in producing it.
    const initiatorPrepared = preparedWithPayload(
      "Initiator Co",
      payloadClient,
    );
    initiatorPrepared.expectedPayloadColumns = ["a_column_never_sent"];
    const [connInitiator, connResponder] = createMessagePipe();
    const [initiatorSettled, responderSettled] = await Promise.allSettled([
      runExchange(connInitiator, "initiator", initiatorPrepared, {
        psiLibrary,
      }),
      runExchange(
        connResponder,
        "responder",
        preparedWithPayload("Responder Co", payloadServer),
        { psiLibrary },
      ),
    ]);

    expect(initiatorSettled.status).toBe("rejected");
    const failure = (initiatorSettled as PromiseRejectedResult).reason;
    expect(failure).toBeInstanceOf(ConnectionError);
    expect((failure as ConnectionError).kind).toBe("protocol");

    const kept = exchangeRecordFromFailure(failure);
    expect(kept?.record.outcome).toBe("receipt-swap-terminated");
    expect(kept?.record.recordsExposed).toBe(payloadClient.length);
    // The record attests both directions of the disclosure, the refused inbound
    // payload included: what arrived is part of what happened.
    expect(kept?.record.governance.payloadSent).toEqual([{ name: "note" }]);
    expect(kept?.record.governance.payloadReceived).toEqual([{ name: "note" }]);
    expect(kept?.record.commitments.associationTable).toBeDefined();
    // This run derived no binder, so it holds none -- the presence rule is "the
    // run derived one", and the outcome beside it is what says no receipt exists.
    expect(kept?.record.receiptBinder).toBeUndefined();
    expect(exchangeRecordOwedButUnbuilt(failure)).toBe(false);

    // The refusal is local to the party that locked in: the responder, which
    // locked in nothing, completes its own half and records that.
    expect(responderSettled.status).toBe("fulfilled");
    const responder = (
      responderSettled as PromiseFulfilledResult<ExchangeResult>
    ).value;
    expect(responder.audit!.record.outcome).toBe("completed");

    await connInitiator.close();
    await connResponder.close();
  });

  test("a cut between this party's send and the partner's reply keeps the record", async () => {
    // The window the durability point opens at the send: the initiator's payload
    // has been handed to the transport and the partner's never arrives. The record
    // commits to what crossed, and to an empty received payload beside it.
    const [connInitiatorRaw, connResponder] = createMessagePipe();
    const [initiatorSettled, responderSettled] = await Promise.allSettled([
      runExchange(
        cutAfterPayloadSend(connInitiatorRaw, 1),
        "initiator",
        preparedWithPayload("Initiator Co", payloadClient),
        { psiLibrary },
      ),
      runExchange(
        connResponder,
        "responder",
        preparedWithPayload("Responder Co", payloadServer),
        { psiLibrary },
      ),
    ]);

    expect(initiatorSettled.status).toBe("rejected");
    const failure = (initiatorSettled as PromiseRejectedResult).reason;
    expect(failure).toBeInstanceOf(ConnectionError);
    const kept = exchangeRecordFromFailure(failure);
    expect(kept?.record.outcome).toBe("receipt-swap-terminated");
    expect(kept?.record.recordsExposed).toBe(payloadClient.length);
    // What this party disclosed is attested in full; what it received is
    // committed as nothing, which is what it received.
    expect(kept?.record.governance.payloadSent).toEqual([{ name: "note" }]);
    expect(kept?.record.governance.payloadReceived).toEqual([]);
    expect(kept?.record.commitments.partnerPayloadReceived).toBeDefined();
    expect(kept?.record.commitments.associationTable).toBeDefined();
    expect(kept?.record.receiptBinder).toBeUndefined();
    expect(exchangeRecordOwedButUnbuilt(failure)).toBe(false);
    // The one-directional disclosure the record itself does not distinguish, for
    // the caller accounting for what left this machine.
    expect(exchangeDisclosedWithoutPartnerPayload(failure)).toBe(true);

    // The partner, which received a payload before its own send, completed.
    expect(responderSettled.status).toBe("fulfilled");
    await connInitiatorRaw.close();
    await connResponder.close();
  });

  test("a malformed reply after the send is owed a record all the same", async () => {
    // The wire-schema refusal inside the payload exchange: the responder answers
    // with a frame the schema refuses, and the initiator -- which sent first --
    // terminates on the parse holding the record of what it had disclosed.
    const [connInitiator, connResponderRaw] = createMessagePipe();
    const connResponder = withForgedPayload(connResponderRaw, {
      hasData: true,
      columns: ["note"],
      rowIndices: [0, 0],
      rows: [["s-c"], ["s-e"]],
    });
    const [initiatorSettled, responderSettled] = await Promise.allSettled([
      runExchange(
        connInitiator,
        "initiator",
        preparedWithPayload("Initiator Co", payloadClient),
        { psiLibrary },
      ),
      runExchange(
        connResponder,
        "responder",
        preparedWithPayload("Responder Co", payloadServer),
        { psiLibrary },
      ),
    ]);

    expect(initiatorSettled.status).toBe("rejected");
    const failure = (initiatorSettled as PromiseRejectedResult).reason;
    expect((failure as ConnectionError).kind).toBe("protocol");
    const kept = exchangeRecordFromFailure(failure);
    expect(kept?.record.outcome).toBe("receipt-swap-terminated");
    expect(kept?.record.governance.payloadSent).toEqual([{ name: "note" }]);
    expect(kept?.record.governance.payloadReceived).toEqual([]);
    expect(exchangeDisclosedWithoutPartnerPayload(failure)).toBe(true);

    // The forgery is at the responder's transport, so its own run sent a payload
    // and finished: the terminated half is one party's.
    expect(responderSettled.status).toBe("fulfilled");
    await connInitiator.close();
    await connResponderRaw.close();
  });

  test("a malformed payload arriving before this party's send owes no record", async () => {
    // The other side of the asymmetry. The responder receives first, so a frame
    // the schema refuses ends its run with nothing of its own across the wire
    // and nothing to attest.
    const [connInitiatorRaw, connResponder] = createMessagePipe();
    const connInitiator = withForgedPayload(connInitiatorRaw, {
      hasData: true,
      columns: ["note"],
      rowIndices: [0, 0],
      rows: [["c-c"], ["c-e"]],
    });
    const initiator = runExchange(
      connInitiator,
      "initiator",
      preparedWithPayload("Initiator Co", payloadClient),
      { psiLibrary },
    ).catch((reason: unknown) => reason);
    const responderFailure = await runExchange(
      connResponder,
      "responder",
      preparedWithPayload("Responder Co", payloadServer),
      { psiLibrary },
    ).then(
      () => {
        throw new Error("expected the responder to refuse the forged frame");
      },
      (reason: unknown) => reason,
    );

    expect((responderFailure as ConnectionError).kind).toBe("protocol");
    expect(exchangeRecordFromFailure(responderFailure)).toBeUndefined();
    expect(exchangeRecordOwedButUnbuilt(responderFailure)).toBe(false);
    expect(exchangeDisclosedWithoutPartnerPayload(responderFailure)).toBe(
      false,
    );

    await connInitiatorRaw.close();
    await connResponder.close();
    // The initiator's own frame did cross, forged or not, so its half is owed a
    // record where the responder's is not.
    expect(exchangeRecordFromFailure(await initiator)?.record.outcome).toBe(
      "receipt-swap-terminated",
    );
  });

  test("a payload send the transport rejects owes no record either", async () => {
    // The region's lower edge on the leg that sends first, where the guard on
    // the send itself is the only thing holding it: the initiator's frame never
    // reaches the transport, so the run rethrows the transport's own error with
    // no record and no mark on it.
    const [connInitiatorRaw, connResponder] = createMessagePipe();
    const responder = runExchange(
      connResponder,
      "responder",
      preparedWithPayload("Responder Co", payloadServer),
      { psiLibrary },
    ).catch((reason: unknown) => reason);
    const failure = await runExchange(
      rejectPayloadSend(connInitiatorRaw),
      "initiator",
      preparedWithPayload("Initiator Co", payloadClient),
      { psiLibrary },
    ).then(
      () => {
        throw new Error(
          "expected the rejected send to end the initiator's run",
        );
      },
      (reason: unknown) => reason,
    );

    expect(failure).toBeInstanceOf(ConnectionError);
    expect((failure as ConnectionError).kind).toBe("transport");
    expect(exchangeRecordFromFailure(failure)).toBeUndefined();
    expect(exchangeRecordOwedButUnbuilt(failure)).toBe(false);
    expect(exchangeDisclosedWithoutPartnerPayload(failure)).toBe(false);

    // The partner, parked on a payload frame that never comes, ends on the close.
    await connInitiatorRaw.close();
    await connResponder.close();
    await responder;
  });

  test.each([1, 2, 3])(
    "a cut at frame %i of the region fails into this party's owed record",
    async (nth) => {
      // The region is closed by construction rather than by each step joining a
      // guard of its own: the positions here are the partner's payload, this
      // party's receipt frame and the partner's, and a cut at any of them ends
      // the run holding the same record.
      const [connInitiatorRaw, connResponder] = createMessagePipe();
      const responder = runExchange(
        connResponder,
        "responder",
        preparedWithPayload("Responder Co", payloadServer),
        {
          psiLibrary,
          signingIdentity: identityB,
          partnerFingerprint: fingerprintA,
          sessionKey,
        },
      ).catch((reason: unknown) => reason);
      const failure = await runExchange(
        cutAfterPayloadSend(connInitiatorRaw, nth),
        "initiator",
        preparedWithPayload("Initiator Co", payloadClient),
        {
          psiLibrary,
          signingIdentity: identityA,
          partnerFingerprint: fingerprintB,
          sessionKey,
        },
      ).then(
        () => {
          throw new Error("expected the cut to terminate the initiator's run");
        },
        (reason: unknown) => reason,
      );

      const kept = exchangeRecordFromFailure(failure);
      expect(kept?.record.outcome).toBe("receipt-swap-terminated");
      expect(kept?.record.recordsExposed).toBe(payloadClient.length);
      expect(kept?.record.governance.payloadSent).toEqual([{ name: "note" }]);
      // Only the first position cuts before the partner's payload arrives; the
      // later ones commit what did arrive.
      expect(exchangeDisclosedWithoutPartnerPayload(failure)).toBe(nth === 1);
      expect(kept?.record.governance.payloadReceived).toEqual(
        nth === 1 ? [] : [{ name: "note" }],
      );

      await connInitiatorRaw.close();
      await connResponder.close();
      await responder;
    },
  );

  test("a record that was owed and could not be built is reported on the failure", async () => {
    // The build is non-fatal and warns on the operator log alone, so a caller
    // handed a bare `undefined` cannot tell "no disclosure to attest" from "the
    // disclosure happened and its record did not build" -- only the second is a
    // lost accounting entry. The responder's prepared exchange holds an empty
    // retention disposition, past what the schema allows, so
    // buildExchangeRecord rejects it and throws on this already-disclosed run.
    const [rawInitiator, connResponder] = createMessagePipe();
    const initiator = runExchange(
      withForgedReceiptCertificate(rawInitiator, identityB.certificate),
      "initiator",
      prepared("Initiator Co", both, clientRows),
      {
        psiLibrary,
        signingIdentity: identityA,
        partnerFingerprint: fingerprintB,
        sessionKey,
      },
    ).then(
      () => {
        throw new Error("expected the initiator's run to terminate");
      },
      (reason: unknown) => reason,
    );
    const responderFailure = await runExchange(
      connResponder,
      "responder",
      {
        ...prepared("Responder Co", both, serverRows),
        retentionDisposition: "",
      },
      {
        psiLibrary,
        signingIdentity: identityB,
        partnerFingerprint: fingerprintA,
        sessionKey,
      },
    ).then(
      () => {
        throw new Error("expected the responder to reject the swapped frame");
      },
      (reason: unknown) => reason,
    );

    expect(responderFailure).toBeInstanceOf(ReceiptVerificationError);
    expect(exchangeRecordFromFailure(responderFailure)).toBeUndefined();
    expect(exchangeRecordOwedButUnbuilt(responderFailure)).toBe(true);

    await rawInitiator.close();
    await connResponder.close();
    // The initiator's own build was unaffected: the loss is one party's.
    const initiatorFailure = await initiator;
    expect(exchangeRecordFromFailure(initiatorFailure)?.record.outcome).toBe(
      "receipt-swap-terminated",
    );
    expect(exchangeRecordOwedButUnbuilt(initiatorFailure)).toBe(false);
  });
});

describe("partner terms holding a lone surrogate end the run before disclosure", () => {
  // A lone surrogate is not a Unicode scalar value and has no UTF-8 encoding,
  // so RFC 8785 requires the canonical encoder to terminate on a string holding
  // one (docs/spec/CANONICAL_ENCODING.md). The whole terms document is
  // canonically encoded to compute the agreed-terms hash both the receipt and
  // the self-attested record commit to, and the hash is computed after the
  // exchange has disclosed -- so the linkage-terms schema refuses such a
  // document where the partner's terms are parsed, which is before
  // compatibility is weighed and before either party's data moves.
  const LONE_SURROGATE = "\ud800";

  test("the honest party refuses at the terms parse, sending only terms and an abort", async () => {
    const [rawHonest, rawHostile] = createMessagePipe();
    const honestSide = recording(rawHonest);
    const hostileSide = recording(rawHostile);

    const honest = runExchange(
      honestSide.conn,
      "initiator",
      prepared("Initiator Co", both, clientRows),
      {
        psiLibrary,
        signingIdentity: identityA,
        partnerFingerprint: fingerprintB,
        sessionKey,
      },
    ).then(
      () => {
        throw new Error("expected the honest party to refuse");
      },
      (reason: unknown) => reason,
    );
    // The hostile party signs nothing: its own leg never reaches the swap, and
    // the identity it authored would not be one its certificate authorizes.
    const hostile = runExchange(
      hostileSide.conn,
      "responder",
      prepared(`Responder Co${LONE_SURROGATE}`, both, serverRows),
      { psiLibrary },
    ).catch((reason: unknown) => reason);

    const raised = await honest;
    expect((raised as Error).message).toContain(
      "partner linkage terms failed to parse",
    );
    // The refusal reports no receipt and owes no record: nothing was disclosed,
    // so there is no disclosure for a record to attest and none is lost.
    expect(exchangeRecordFromFailure(raised)).toBeUndefined();
    expect(exchangeRecordOwedButUnbuilt(raised)).toBe(false);

    // The timing, read off the wire: the terms frame and then the abort, and
    // nothing else -- no linkage key, no payload row, no receipt frame. The
    // hostile side sent its terms and got the abort back.
    expect(honestSide.sent.map(frameKind)).toEqual(["terms", "abort"]);
    expect(hostileSide.sent.map(frameKind)).toEqual(["terms"]);

    await rawHonest.close();
    await rawHostile.close();
    await hostile;
  });

  test("the same pair produces a receipt and a record on well-formed terms", async () => {
    // The control for the refusal above: with the responder's identity
    // well-formed, the run reaches the swap and both parties hold the three
    // things the refused run has none of.
    const [resInit, resResp] = await runBoth(
      {
        signingIdentity: identityA,
        partnerFingerprint: fingerprintB,
        sessionKey,
      },
      {
        signingIdentity: identityB,
        partnerFingerprint: fingerprintA,
        sessionKey,
      },
    );
    expect(resInit.signedReceipt).toBeDefined();
    expect(resResp.signedReceipt).toBeDefined();
    expect(resInit.audit?.record.outcome).toBe("completed");
    expect(resResp.audit?.record.outcome).toBe("completed");
    expect(resInit.audit?.record.termsHash).toBe(
      resResp.audit?.record.termsHash,
    );
  });
});

describe("a partner payload holding a lone surrogate is refused at the wire schema", () => {
  // The received column names and cells go verbatim into the committed payload
  // the receipt MACs and the record's payload commitments are computed over, and
  // the canonical encoder terminates on an unpaired UTF-16 surrogate. JSON
  // escapes one on the way out and restores it on the way in, so it crosses the
  // wire intact -- the payload wire schema therefore refuses it where the frame
  // is parsed, ahead of an encode that only runs once the exchange has
  // disclosed. See docs/spec/CANONICAL_ENCODING.md, "Strings".
  const LONE_SURROGATE = "\ud800";

  /** Append a lone surrogate to the first cell of this party's outbound payload
   * frame, leaving every other message of the exchange -- and every other field
   * of that frame -- exactly as the honest run sends it. */
  function withTaintedPayload(conn: MessageConnection): MessageConnection {
    const taint = (data: unknown): unknown => {
      if (typeof data !== "object" || data === null || !("hasData" in data))
        return data;
      const frame = data as {
        hasData: boolean;
        rows?: Array<Array<string | null>>;
      };
      if (!frame.hasData || frame.rows === undefined) return data;
      const rows = frame.rows.map((row) => [...row]);
      rows[0][0] = `${String(rows[0][0])}${LONE_SURROGATE}`;
      return { ...frame, rows };
    };
    return {
      send: (data: unknown) => conn.send(taint(data)),
      receive: (timeoutMs?: number) => conn.receive(timeoutMs),
      close: () => conn.close(),
    };
  }

  test("the honest responder refuses it before its own payload goes on the wire", async () => {
    // The responder receives the payload frame before it sends its own, so the
    // refusal lands ahead of its disclosure: nothing of its data has moved, and
    // the run ends with no receipt and no record owed.
    const [rawHostile, rawHonest] = createMessagePipe();
    const honestSide = recording(rawHonest);
    const hostile = runExchange(
      withTaintedPayload(rawHostile),
      "initiator",
      preparedWithPayload("Initiator Co", payloadClient),
      {
        psiLibrary,
        signingIdentity: identityA,
        partnerFingerprint: fingerprintB,
        sessionKey,
      },
    ).catch((reason: unknown) => reason);
    const raised = await runExchange(
      honestSide.conn,
      "responder",
      preparedWithPayload("Responder Co", payloadServer),
      {
        psiLibrary,
        signingIdentity: identityB,
        partnerFingerprint: fingerprintA,
        sessionKey,
      },
    ).then(
      () => {
        throw new Error("expected the honest party to refuse the payload");
      },
      (reason: unknown) => reason,
    );

    expect(raised).toBeInstanceOf(ConnectionError);
    expect((raised as ConnectionError).kind).toBe("protocol");
    expect(String((raised as ConnectionError).cause)).toMatch(
      /unpaired UTF-16 surrogate/,
    );
    // No payload frame and no receipt frame went out, so there is no disclosure
    // for a record to attest and none is reported lost.
    expect(honestSide.sent.map(frameKind)).not.toContain("payload");
    expect(honestSide.sent.map(frameKind)).not.toContain("receipt");
    expect(exchangeRecordFromFailure(raised)).toBeUndefined();
    expect(exchangeRecordOwedButUnbuilt(raised)).toBe(false);

    await rawHonest.close();
    await rawHostile.close();
    await hostile;
  });

  test("the honest initiator, which sends first, refuses it at the same parse", async () => {
    // The initiator's own payload has already crossed when the tainted frame
    // arrives, so this leg shows the refusal itself rather than the timing: the
    // frame never becomes a committed payload, and the run ends as a protocol
    // failure instead of terminating later inside the receipt build.
    const [rawHonest, rawHostile] = createMessagePipe();
    const hostile = runExchange(
      withTaintedPayload(rawHostile),
      "responder",
      preparedWithPayload("Responder Co", payloadServer),
      {
        psiLibrary,
        signingIdentity: identityB,
        partnerFingerprint: fingerprintA,
        sessionKey,
      },
    ).catch((reason: unknown) => reason);
    const raised = await runExchange(
      rawHonest,
      "initiator",
      preparedWithPayload("Initiator Co", payloadClient),
      {
        psiLibrary,
        signingIdentity: identityA,
        partnerFingerprint: fingerprintB,
        sessionKey,
      },
    ).then(
      () => {
        throw new Error("expected the honest party to refuse the payload");
      },
      (reason: unknown) => reason,
    );

    expect(raised).toBeInstanceOf(ConnectionError);
    expect((raised as ConnectionError).kind).toBe("protocol");
    expect(String((raised as ConnectionError).cause)).toMatch(
      /unpaired UTF-16 surrogate/,
    );
    // The refused frame never becomes a committed payload: this party keeps the
    // record its own crossed payload owes it, committing to nothing received.
    const kept = exchangeRecordFromFailure(raised);
    expect(kept?.record.outcome).toBe("receipt-swap-terminated");
    expect(kept?.record.governance.payloadReceived).toEqual([]);
    expect(exchangeDisclosedWithoutPartnerPayload(raised)).toBe(true);
    expect(exchangeRecordOwedButUnbuilt(raised)).toBe(false);

    await rawHonest.close();
    await rawHostile.close();
    await hostile;
  });

  test("the same exchange left well-formed holds the receipt MACs and the committed bytes it always had", async () => {
    // The control for the refusals above, pinning what the rule must NOT have
    // moved: the bytes the encoder is handed for each direction, and the two
    // session-keyed MACs over them. The values are fixed literals rather than a
    // cross-party comparison, so a change to either the committed shape or the
    // encoding fails here rather than agreeing with itself on both sides.
    const [connInitiator, connResponder] = createMessagePipe();
    const [resInit, resResp] = await Promise.all([
      runExchange(
        connInitiator,
        "initiator",
        preparedWithPayload("Initiator Co", payloadClient),
        {
          psiLibrary,
          signingIdentity: identityA,
          partnerFingerprint: fingerprintB,
          sessionKey,
        },
      ),
      runExchange(
        connResponder,
        "responder",
        preparedWithPayload("Responder Co", payloadServer),
        {
          psiLibrary,
          signingIdentity: identityB,
          partnerFingerprint: fingerprintA,
          sessionKey,
        },
      ),
    ]);

    expect(canonicalString(toCommittedPayload(resInit.partnerPayload))).toBe(
      '{"columns":["note"],"rows":[["s-c"],["s-e"]]}',
    );
    expect(canonicalString(toCommittedPayload(resResp.partnerPayload))).toBe(
      '{"columns":["note"],"rows":[["c-c"],["c-e"]]}',
    );
    const receipt = resInit.signedReceipt!;
    expect(resResp.signedReceipt).toEqual(receipt);
    expect(receipt.content.initiatorToResponderPayload).toBe(
      "q5b2XIyMH1ps6ViDniNujF6o_hYFS5VArRScrdMwxeg",
    );
    expect(receipt.content.responderToInitiatorPayload).toBe(
      "FtC6GHClWSbJeQowI_k_ncnqjJEYlcD7lbRIEfE5MvA",
    );
    expect(resInit.audit?.record.outcome).toBe("completed");
    expect(resResp.audit?.record.outcome).toBe("completed");
  });
});
