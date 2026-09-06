import { expect, test } from "vitest";

import {
  exchangeTerms,
  probeProtocolVersion,
  resolveRole,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_MISMATCH_MESSAGE,
  TERMS_ENVELOPE_FIELDS,
} from "../src/protocolSetup";
import { MAX_NAME_LENGTH } from "../src/config/linkageTermsSchema";
import type { LinkageTerms, Output } from "../src/config/linkageTermsSchema";
import type { PresentedHostKey } from "../src/connection/fileSyncConnection";
import type { PsiRole } from "../src/types";

import {
  createMessagePipe,
  ConnectionError,
  type MessageConnection,
} from "../src/connection/messageConnection";
import { sanitizeErrorForDisplay } from "../src/utils/sanitizeErrorForDisplay";
import { recordingConnection } from "./utils/recordingConnection";

// --- Test fixtures -----------------------------------------------------------

const sharedFields: LinkageTerms["linkageFields"] = [
  { name: "ssn", type: "ssn" },
];
const sharedKeys: LinkageTerms["linkageKeys"] = [
  { name: "SSN", elements: [{ field: "ssn" }] },
];

/** Both parties expect output and will share -- compatible pair. */
const termsA: LinkageTerms = {
  version: "1.0.0",
  identity: "Party A",
  date: "2025-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: sharedFields,
  linkageKeys: sharedKeys,
};

const termsB: LinkageTerms = {
  ...termsA,
  identity: "Party B",
};

function makeConnections(): [MessageConnection, MessageConnection] {
  return createMessagePipe();
}

/** Run an exchange between A (initiator) and B (responder). The record counts
 *  are fixed placeholders -- these fixtures exercise terms agreement, not role
 *  selection, which resolveRole covers separately below. */
async function runExchange(tA: LinkageTerms, tB: LinkageTerms) {
  const [connA, connB] = makeConnections();
  return Promise.allSettled([
    exchangeTerms(connA, "initiator", tA, 100),
    exchangeTerms(connB, "responder", tB, 200),
  ]);
}

function resolveBothRoles(
  outA: Output,
  outB: Output,
  sizeA: number,
  sizeB: number,
): { a: PsiRole; b: PsiRole } {
  return {
    a: resolveRole("initiator", outA, outB, sizeA, sizeB),
    b: resolveRole("responder", outB, outA, sizeB, sizeA),
  };
}

// --- Happy path --------------------------------------------------------------

test("compatible terms resolve for both parties, each holding the other's identity and no warnings", async () => {
  const [a, b] = await runExchange(termsA, termsB);
  if (a.status !== "fulfilled" || b.status !== "fulfilled") throw new Error();
  expect(a.value.partnerTerms.identity).toBe("Party B");
  expect(b.value.partnerTerms.identity).toBe("Party A");
  expect(a.value.warnings).toHaveLength(0);
  expect(b.value.warnings).toHaveLength(0);
});

test("date mismatch produces a warning but exchange proceeds", async () => {
  const [a, b] = await runExchange(termsA, { ...termsB, date: "2025-06-01" });
  expect(a.status).toBe("fulfilled");
  expect(b.status).toBe("fulfilled");
  if (a.status !== "fulfilled" || b.status !== "fulfilled") throw new Error();
  expect(a.value.warnings.some((w) => w.includes("date mismatch"))).toBe(true);
  expect(b.value.warnings.some((w) => w.includes("date mismatch"))).toBe(true);
});

// --- Observed host-key advertisement -----------------------------------------

const hostKeyA: PresentedHostKey = {
  fingerprint: "SHA256:" + "a".repeat(43),
  keyType: "ssh-ed25519",
};
const hostKeyB: PresentedHostKey = {
  fingerprint: "SHA256:" + "b".repeat(43),
  keyType: "ssh-ed25519",
};

test("each party reads back the other's advertised observed host key", async () => {
  const [connA, connB] = makeConnections();
  const [a, b] = await Promise.all([
    exchangeTerms(connA, "initiator", termsA, 100, undefined, hostKeyA),
    exchangeTerms(connB, "responder", termsB, 200, undefined, hostKeyB),
  ]);
  expect(a.partnerHostKey).toEqual(hostKeyB);
  expect(b.partnerHostKey).toEqual(hostKeyA);
  expect(a.partnerHostKeyMalformed).toBe(false);
  expect(b.partnerHostKeyMalformed).toBe(false);
});

test("a party that observed no host key advertises none and reads partner's", async () => {
  const [connA, connB] = makeConnections();
  const [a, b] = await Promise.all([
    // Initiator advertises; responder (e.g. a file-drop mount) does not.
    exchangeTerms(connA, "initiator", termsA, 100, undefined, hostKeyA),
    exchangeTerms(connB, "responder", termsB, 200),
  ]);
  expect(a.partnerHostKey).toBeUndefined();
  expect(b.partnerHostKey).toEqual(hostKeyA);
  // A genuine absence is NOT a malformed advertisement: neither party flags it,
  // so the benign no-host-key path stays quiet.
  expect(a.partnerHostKeyMalformed).toBe(false);
  expect(b.partnerHostKeyMalformed).toBe(false);
});

test("no hostKey field is put on the wire when none is observed", async () => {
  // Post-handshake placement: a party that supplies no observed key (the
  // unauthenticated path, where the CLI withholds it) emits no `hostKey` field
  // at all, so there is nothing for an unauthenticated peer to read as injected.
  const [connA, connB] = makeConnections();
  const sent: Array<Record<string, unknown>> = [];
  const capturingA: MessageConnection = {
    send: (m: unknown) => {
      sent.push(m as Record<string, unknown>);
      return connA.send(m);
    },
    receive: (t?: number) => connA.receive(t),
    close: () => connA.close(),
  };
  await Promise.all([
    exchangeTerms(capturingA, "initiator", termsA, 100),
    exchangeTerms(connB, "responder", termsB, 200),
  ]);
  expect(sent.length).toBeGreaterThan(0);
  for (const frame of sent) expect("hostKey" in frame).toBe(false);
});

test("responder flags a present-but-malformed partner hostKey without aborting", async () => {
  // Fail-soft: the reconciliation only ever warns, so a malformed or over-bound
  // advertisement degrades to "no reconciliation" rather than aborting the
  // linkage or blaming the (valid) terms. Inject an over-bound fingerprint on
  // the initiator's frame and drive the responder by hand: the value is still
  // dropped (treated as no host key), but the present-but-malformed case is
  // exposed separately from a genuine absence so the CLI can log it.
  const [connA, connB] = makeConnections();
  const responder = exchangeTerms(connB, "responder", termsB, 200);
  await connA.send({
    linkageTerms: termsA,
    recordCount: 100,
    effectiveKeyCount: 1,
    protocolVersion: PROTOCOL_VERSION,
    hostKey: { fingerprint: "x".repeat(200), keyType: "ssh-ed25519" },
  });
  await connA.receive(); // drain the responder's terms + proceed (msg 2)
  await connA.send({ decision: "proceed" }); // msg 3
  const result = await responder;
  expect(result.partnerHostKey).toBeUndefined();
  expect(result.partnerHostKeyMalformed).toBe(true);
});

test("a null partner hostKey is treated as absent, not malformed", async () => {
  // A conforming party omits the field when it observed no host key; an explicit
  // `null` is JSON's "no value" form, so it is classified as a genuine absence
  // (the benign no-host-key path) rather than a malformed advertisement -- the
  // malformed flag stays false so no spurious diagnostic fires.
  const [connA, connB] = makeConnections();
  const responder = exchangeTerms(connB, "responder", termsB, 200);
  await connA.send({
    linkageTerms: termsA,
    recordCount: 100,
    effectiveKeyCount: 1,
    protocolVersion: PROTOCOL_VERSION,
    hostKey: null,
  });
  await connA.receive(); // drain the responder's terms + proceed (msg 2)
  await connA.send({ decision: "proceed" }); // msg 3
  const result = await responder;
  expect(result.partnerHostKey).toBeUndefined();
  expect(result.partnerHostKeyMalformed).toBe(false);
});

test("initiator flags a present-but-malformed partner hostKey without aborting", async () => {
  // The mirror of the responder case: a malformed advertisement on the
  // responder's message 2 is detected by the initiator. Drive the responder by
  // hand so the bad value can be injected on its frame.
  const [connA, connB] = makeConnections();
  const initiator = exchangeTerms(connA, "initiator", termsA, 100);
  await connB.receive(); // msg 1: initiator's terms
  await connB.send({
    linkageTerms: termsB,
    decision: "proceed",
    recordCount: 200,
    effectiveKeyCount: 1,
    protocolVersion: PROTOCOL_VERSION,
    hostKey: { fingerprint: "x".repeat(200), keyType: "ssh-ed25519" },
  });
  await connB.receive(); // msg 3: initiator's proceed
  const result = await initiator;
  expect(result.partnerHostKey).toBeUndefined();
  expect(result.partnerHostKeyMalformed).toBe(true);
});

// --- Protocol-version reconcile ----------------------------------------------

test("both parties advertise the protocol version on their terms messages", async () => {
  // The forward-looking clean check: both terms messages hold this build's
  // PROTOCOL_VERSION so a future wire-format boundary fails cleanly the moment
  // the two versions differ. Message 3 (the bare final decision) does not hold
  // it -- each party already read the other's version off message 1 / message 2.
  const [connA, connB] = makeConnections();
  const { conn: recordingA, sent: initiatorSent } = recordingConnection(connA);
  const { conn: recordingB, sent: responderSent } = recordingConnection(connB);
  const [a, b] = await Promise.all([
    exchangeTerms(recordingA, "initiator", termsA, 100),
    exchangeTerms(recordingB, "responder", termsB, 200),
  ]);
  // Same-version parties are unaffected: the exchange completes.
  expect(a.partnerTerms.identity).toBe("Party B");
  expect(b.partnerTerms.identity).toBe("Party A");
  expect(initiatorSent[0]).toMatchObject({ protocolVersion: PROTOCOL_VERSION });
  expect(responderSent[0]).toMatchObject({ protocolVersion: PROTOCOL_VERSION });
  expect("protocolVersion" in initiatorSent[1]).toBe(false);
});

// --- Payload-intent advertisement (single-pass table withholding) ------------

test("both parties advertise disclosesPayload on their terms messages, read back the partner's", async () => {
  // The single-pass association-table withhold gate reads the SENDER's
  // advertised payload intent, so both terms messages (message 1 for the
  // initiator, message 2 for the responder) hold disclosesPayload when the
  // caller supplies it, and each party reads the other's back. Message 3 -- the
  // bare final decision -- does not hold it.
  const [connA, connB] = makeConnections();
  const { conn: recordingA, sent: initiatorSent } = recordingConnection(connA);
  const { conn: recordingB, sent: responderSent } = recordingConnection(connB);
  const [a, b] = await Promise.all([
    exchangeTerms(
      recordingA,
      "initiator",
      termsA,
      100,
      undefined,
      undefined,
      true,
    ),
    exchangeTerms(
      recordingB,
      "responder",
      termsB,
      200,
      undefined,
      undefined,
      false,
    ),
  ]);
  expect(a.partnerDisclosesPayload).toBe(false);
  expect(b.partnerDisclosesPayload).toBe(true);
  expect(initiatorSent[0]).toMatchObject({ disclosesPayload: true });
  expect(responderSent[0]).toMatchObject({ disclosesPayload: false });
  expect("disclosesPayload" in initiatorSent[1]).toBe(false);
});

test("an omitted disclosesPayload reads back as undefined", async () => {
  // A caller that does not exercise the withhold path passes nothing, so the field
  // is omitted from the wire and the partner reads `undefined` -- which the withhold
  // gate treats as "discloses payload" (never blinds a helper that needs its table).
  const [connA, connB] = makeConnections();
  const [a, b] = await Promise.all([
    exchangeTerms(connA, "initiator", termsA, 100),
    exchangeTerms(connB, "responder", termsB, 200),
  ]);
  expect(a.partnerDisclosesPayload).toBeUndefined();
  expect(b.partnerDisclosesPayload).toBeUndefined();
});

test("responder fails fast when message 1 advertises a different protocol version", async () => {
  // Fail-closed reconcile: a partner on a different PROTOCOL_VERSION is an
  // incompatible build, so the responder aborts with the actionable "run the
  // same version" diagnosis before it ever weighs the (here identical) terms --
  // turning a later cryptic frame-parse failure into one obvious line. Drive the
  // initiator by hand to inject a foreign version on message 1.
  const [connA, connB] = makeConnections();
  const responder = exchangeTerms(connB, "responder", termsB, 200);
  await connA.send({
    linkageTerms: termsA,
    recordCount: 100,
    protocolVersion: PROTOCOL_VERSION + 1,
  });
  // The responder relays the mismatch as its abort reason (message 2) so the
  // initiator learns the real cause too; drain it and confirm.
  const abort = await connA.receive();
  expect(abort).toMatchObject({
    decision: "abort",
    abortReasons: [PROTOCOL_VERSION_MISMATCH_MESSAGE],
  });
  await expect(responder).rejects.toThrow(PROTOCOL_VERSION_MISMATCH_MESSAGE);
});

test("initiator fails fast when message 2 advertises a different protocol version", async () => {
  // The mirror of the responder case: a foreign version on the responder's
  // message 2 is caught by the initiator, which aborts (message 3, decision-only)
  // with the same diagnosis. Drive the responder by hand to inject it.
  const [connA, connB] = makeConnections();
  const initiator = exchangeTerms(connA, "initiator", termsA, 100);
  await connB.receive(); // msg 1: initiator's terms
  await connB.send({
    linkageTerms: termsB,
    decision: "proceed",
    recordCount: 200,
    protocolVersion: PROTOCOL_VERSION + 1,
  });
  const abort = await connB.receive(); // msg 3: initiator's abort
  expect(abort).toMatchObject({
    decision: "abort",
    abortReasons: [PROTOCOL_VERSION_MISMATCH_MESSAGE],
  });
  await expect(initiator).rejects.toThrow(PROTOCOL_VERSION_MISMATCH_MESSAGE);
});

test("responder fails fast when message 1 advertises no protocol version", async () => {
  // No deployed build predates the field, so a partner advertising none is a
  // non-conforming peer and draws the same refusal a foreign value does --
  // relayed as the abort reason so it fails with the named cause too. Drive the
  // initiator by hand to omit it.
  const [connA, connB] = makeConnections();
  const responder = exchangeTerms(connB, "responder", termsB, 200);
  await connA.send({ linkageTerms: termsA, recordCount: 100 }); // no version
  const abort = await connA.receive();
  expect(abort).toMatchObject({
    decision: "abort",
    abortReasons: [PROTOCOL_VERSION_MISMATCH_MESSAGE],
  });
  await expect(responder).rejects.toThrow(PROTOCOL_VERSION_MISMATCH_MESSAGE);
});

test("initiator fails fast when message 2 advertises no protocol version", async () => {
  // The mirror, so the refusal is symmetric across the two message paths: a
  // proceed frame holding no version is refused by the initiator, which still
  // SENDS its abort (message 3) rather than stranding the responder on its
  // receive timeout. Drive the responder by hand to omit the version.
  const [connA, connB] = makeConnections();
  const initiator = exchangeTerms(connA, "initiator", termsA, 100);
  await connB.receive(); // msg 1: initiator's terms
  await connB.send({
    linkageTerms: termsB,
    decision: "proceed",
    recordCount: 200,
    effectiveKeyCount: 1,
  }); // no version
  const abort = await connB.receive(); // msg 3: initiator's abort
  expect(abort).toMatchObject({
    decision: "abort",
    abortReasons: [PROTOCOL_VERSION_MISMATCH_MESSAGE],
  });
  // The decision-only frame closes an exchange already reconciled from both
  // sides, and no reconcile reads it, so it advertises nothing.
  expect("protocolVersion" in (abort as Record<string, unknown>)).toBe(false);
  await expect(initiator).rejects.toThrow(PROTOCOL_VERSION_MISMATCH_MESSAGE);
});

test("the responder's abort frame holds the protocol version", async () => {
  // The abort frame in the responder's message-2 slot advertises the version like
  // its proceed frame does. Without it the initiator -- which reconciles that
  // frame's version before it reads the decision -- would meet a same-version
  // partner's abort as a version skew and bury the reason the partner stated.
  // Driven through an incompatible-terms abort, the ordinary way that frame is
  // produced.
  const [connA, connB] = makeConnections();
  const { conn: recordingB, sent: responderSent } = recordingConnection(connB);
  const [a, b] = await Promise.allSettled([
    exchangeTerms(connA, "initiator", termsA, 100),
    exchangeTerms(
      recordingB,
      "responder",
      { ...termsB, algorithm: "psi-c" },
      200,
    ),
  ]);
  expect(responderSent[0]).toMatchObject({
    decision: "abort",
    protocolVersion: PROTOCOL_VERSION,
  });
  if (a.status !== "rejected" || b.status !== "rejected") throw new Error();
  // The initiator hears the terms cause the responder stated, not a version skew.
  const initiatorMessage = (a.reason as Error).message;
  expect(initiatorMessage).toContain("algorithm mismatch");
  expect(initiatorMessage).not.toContain(PROTOCOL_VERSION_MISMATCH_MESSAGE);
});

test("responder fails fast when message 1 advertises a malformed protocol version", async () => {
  // A PRESENT-but-garbled version value (wrong type, non-integer) is not the same
  // as an absent one: it is read as `unknown` and reconciled to a mismatch, so the
  // operator still gets the actionable version diagnosis rather than a generic
  // "failed to parse" that buries the real cause (or a silent legacy pass-through).
  // Each of these is schema-invalid as a version yet must still fail closed.
  for (const bad of ["1", 1.5, null, true] as const) {
    const [connA, connB] = makeConnections();
    const responder = exchangeTerms(connB, "responder", termsB, 200);
    await connA.send({
      linkageTerms: termsA,
      recordCount: 100,
      protocolVersion: bad,
    });
    const abort = await connA.receive();
    expect(abort).toMatchObject({
      decision: "abort",
      abortReasons: [PROTOCOL_VERSION_MISMATCH_MESSAGE],
    });
    await expect(responder).rejects.toThrow(PROTOCOL_VERSION_MISMATCH_MESSAGE);
  }
});

test("initiator fails fast (and sends an abort) on a malformed message-2 version", async () => {
  // The mirror of the responder case AND a no-hang guard: a garbled version on
  // message 2 must reconcile to a mismatch and the initiator must still SEND
  // an abort (message 3) so the responder fails with the named cause
  // rather than stranding on its receive timeout. Drive the responder by hand.
  const [connA, connB] = makeConnections();
  const initiator = exchangeTerms(connA, "initiator", termsA, 100);
  await connB.receive(); // msg 1: initiator's terms
  await connB.send({
    linkageTerms: termsB,
    decision: "proceed",
    recordCount: 200,
    protocolVersion: "2", // present but garbled
  });
  const abort = await connB.receive(); // msg 3: initiator's abort -- must arrive
  expect(abort).toMatchObject({
    decision: "abort",
    abortReasons: [PROTOCOL_VERSION_MISMATCH_MESSAGE],
  });
  await expect(initiator).rejects.toThrow(PROTOCOL_VERSION_MISMATCH_MESSAGE);
});

test("a malformed sibling field does not bury the version skew (responder path)", async () => {
  const [connA, connB] = makeConnections();
  const responder = exchangeTerms(connB, "responder", termsB, 200);
  await connA.send({
    linkageTerms: termsA,
    recordCount: 100,
    protocolVersion: PROTOCOL_VERSION + 1,
    save: "yes", // non-boolean: throws the strict envelope parse
  });
  const abort = await connA.receive();
  expect(abort).toMatchObject({
    decision: "abort",
    abortReasons: [PROTOCOL_VERSION_MISMATCH_MESSAGE],
  });
  await expect(responder).rejects.toThrow(PROTOCOL_VERSION_MISMATCH_MESSAGE);
});

test("a malformed sibling field does not bury the version skew, and still aborts (initiator path)", async () => {
  // The initiator mirror AND a no-hang guard: on message 2 the version is probed and
  // reconciled BEFORE the strict parse, so a malformed sibling field co-occurring
  // with a version skew still yields the named diagnosis, and the initiator
  // still SENDS an abort (message 3) rather than throwing a bare parse
  // error that would strand the responder on its receive timeout. Drive the
  // responder by hand to inject the frame.
  const [connA, connB] = makeConnections();
  const initiator = exchangeTerms(connA, "initiator", termsA, 100);
  await connB.receive(); // msg 1: initiator's terms
  await connB.send({
    linkageTerms: termsB,
    decision: "proceed",
    recordCount: 200,
    protocolVersion: PROTOCOL_VERSION + 1,
    save: "yes", // non-boolean: throws the strict envelope parse
  });
  const abort = await connB.receive(); // msg 3: initiator's abort -- must arrive
  expect(abort).toMatchObject({
    decision: "abort",
    abortReasons: [PROTOCOL_VERSION_MISMATCH_MESSAGE],
  });
  await expect(initiator).rejects.toThrow(PROTOCOL_VERSION_MISMATCH_MESSAGE);
});

test("a same-version malformed sibling field still fails as a parse error, not a silent proceed", async () => {
  // The other half of the probe's contract: reading the version early must NOT let
  // a malformed frame through. With a MATCHING version, the reconcile is a no-op, so
  // the strict parse must still run and reject a non-boolean `save` -- the probe
  // defers to the full parse rather than reconstructing agreement from its partial
  // view. Guards against a future short-circuit that trusted the probe. Responder
  // path: the abort names the parse failure, never the (matching) version.
  const [connA, connB] = makeConnections();
  const responder = exchangeTerms(connB, "responder", termsB, 200);
  await connA.send({
    linkageTerms: termsA,
    recordCount: 100,
    protocolVersion: PROTOCOL_VERSION, // MATCHES -- reconcile is a no-op
    save: "yes", // non-boolean: the strict parse must still reject this
  });
  const abort = await connA.receive();
  expect(abort).toMatchObject({ decision: "abort" });
  expect((abort as { abortReasons?: string[] }).abortReasons?.[0]).toMatch(
    /failed to parse/,
  );
  expect((abort as { abortReasons?: string[] }).abortReasons?.[0]).not.toBe(
    PROTOCOL_VERSION_MISMATCH_MESSAGE,
  );
  await expect(responder).rejects.toThrow(/failed to parse/);
});

test("initiator: a same-version malformed message 2 still rejects as a protocol error", async () => {
  // The initiator mirror: a MATCHING version means the reconcile no-ops and the
  // strict parse (parseOrProtocolError) must still reject a non-boolean `save` as a
  // clean protocol ConnectionError -- not the version message, and not a silent
  // proceed. Drive the responder by hand to inject the frame.
  const [connA, connB] = makeConnections();
  const initiator = exchangeTerms(connA, "initiator", termsA, 100);
  await connB.receive(); // msg 1: initiator's terms
  await connB.send({
    linkageTerms: termsB,
    decision: "proceed",
    recordCount: 200,
    protocolVersion: PROTOCOL_VERSION, // MATCHES -- reconcile is a no-op
    save: "yes", // non-boolean: the strict parse must still reject this
  });
  const err = await initiator.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("protocol");
  expect((err as Error).message).not.toBe(PROTOCOL_VERSION_MISMATCH_MESSAGE);
});

test("a non-object terms frame degrades cleanly (probe returns no version, reconcile refuses)", async () => {
  // The probe's `.catch` branch, exercised on a wire-reachable input: a bare
  // non-object frame (a hostile or corrupt peer). The probe returns `undefined`
  // rather than throwing, which the reconcile refuses as no readable version -- a
  // clean abort with the named diagnosis, never an uncaught exception or a hang.
  // Encodes the probe's "no readable version, no throw" contract as a check.
  const [connA, connB] = makeConnections();
  const responder = exchangeTerms(connB, "responder", termsB, 200);
  await connA.send("not an object");
  const abort = await connA.receive();
  expect(abort).toMatchObject({
    decision: "abort",
    abortReasons: [PROTOCOL_VERSION_MISMATCH_MESSAGE],
  });
  await expect(responder).rejects.toThrow(PROTOCOL_VERSION_MISMATCH_MESSAGE);
});

test("a throwing protocolVersion getter degrades to no readable version", () => {
  // The hardened edge of the probe's "no readable version" contract, fed to it
  // directly because a real transport's deserialized wire data can never take
  // this shape: a frame whose `protocolVersion` read THROWS (a throwing getter)
  // must degrade to `undefined`, the same outcome as a garbled, absent, or
  // non-object version, rather than escaping the schema's `.catch`. Removing
  // the hardening makes this check fail loudly, not silently drift.
  const frame = {
    linkageTerms: termsA,
    recordCount: 100,
    get protocolVersion(): unknown {
      throw new Error("boom");
    },
  };
  expect(probeProtocolVersion(frame)).toBeUndefined();
});

test("initiator fails fast (and sends an abort) on message 2 versions it cannot read or reconcile", async () => {
  // The initiator-side mirror of message 1's refusal symmetry: a non-object
  // frame, a throwing `protocolVersion` getter, and an explicit null are all
  // refused on message 2 by the same reconcile and fixed reason. The initiator
  // still SENDS its abort (message 3) rather than stranding the responder. The
  // throwing getter survives only because the in-process pipe passes frames by
  // reference; a real transport never produces that shape.
  const refusedVersionFrames: Array<[string, unknown]> = [
    ["non-object frame", "not an object"],
    [
      "explicit null version",
      {
        linkageTerms: termsB,
        decision: "proceed",
        recordCount: 200,
        effectiveKeyCount: 1,
        protocolVersion: null,
      },
    ],
    [
      "throwing version getter",
      {
        linkageTerms: termsB,
        decision: "proceed",
        recordCount: 200,
        effectiveKeyCount: 1,
        get protocolVersion(): unknown {
          throw new Error("boom");
        },
      },
    ],
  ];
  for (const [shape, frame] of refusedVersionFrames) {
    const [connA, connB] = makeConnections();
    const initiator = exchangeTerms(connA, "initiator", termsA, 100);
    await connB.receive(); // msg 1: initiator's terms
    await connB.send(frame);
    const abort = await connB.receive(); // msg 3: initiator's abort -- must arrive
    expect(abort, shape).toMatchObject({
      decision: "abort",
      abortReasons: [PROTOCOL_VERSION_MISMATCH_MESSAGE],
    });
    await expect(initiator, shape).rejects.toThrow(
      PROTOCOL_VERSION_MISMATCH_MESSAGE,
    );
  }
});

test("a version mismatch is diagnosed ahead of a simultaneous terms mismatch", async () => {
  // When the partner differs on BOTH the protocol version AND the linkage terms,
  // the version skew is the root cause, so its diagnosis wins: the abort names the
  // version, not the terms. Pins the "reconcile before validateCompatibility"
  // ordering the branch comments assert (a check, not just prose). The injected
  // terms still parse (psi-c is a valid algorithm), so the responder would reach
  // the algorithm-incompatibility abort if the version check did not run first.
  const [connA, connB] = makeConnections();
  const responder = exchangeTerms(connB, "responder", termsB, 200);
  await connA.send({
    linkageTerms: { ...termsA, algorithm: "psi-c" },
    recordCount: 100,
    protocolVersion: PROTOCOL_VERSION + 1,
  });
  const abort = await connA.receive();
  expect(abort).toMatchObject({
    decision: "abort",
    abortReasons: [PROTOCOL_VERSION_MISMATCH_MESSAGE],
  });
  await expect(responder).rejects.toThrow(PROTOCOL_VERSION_MISMATCH_MESSAGE);
});

test("initiator: a version skew on an abort frame wins over the peer's abort reason", async () => {
  // Precedence pin: reconcileProtocolVersion runs before the abort-decision
  // check, so a message 2 that both aborts AND holds a SKEWED version is
  // diagnosed as the skew, not the peer's stated reason. A conforming abort
  // holds this build's own version, so the reconcile no-ops and the peer's
  // reason shows instead -- a skewed version here is reachable only from a
  // non-conforming or malicious peer.
  const [connA, connB] = makeConnections();
  const initiator = exchangeTerms(connA, "initiator", termsA, 100);
  await connB.receive(); // msg 1: initiator's terms
  await connB.send({
    linkageTerms: termsB,
    decision: "abort",
    abortReasons: ["responder rejected for its own stated reason"],
    protocolVersion: PROTOCOL_VERSION + 1, // non-conforming: an abort holding a version
  });
  // The initiator diagnoses the skew first and best-effort sends its own abort
  // (msg 3) holding the version message -- not a relay of the peer's reason -- so the
  // hand-driven responder is not stranded on its receive timeout. Drain and confirm.
  const abort = await connB.receive();
  expect(abort).toMatchObject({
    decision: "abort",
    abortReasons: [PROTOCOL_VERSION_MISMATCH_MESSAGE],
  });
  const err = await initiator.catch((e: unknown) => e);
  expect((err as Error).message).toBe(PROTOCOL_VERSION_MISMATCH_MESSAGE);
  expect((err as Error).message).not.toContain("responder rejected");
});

// --- Role determination ------------------------------------------------------

test("only initiator expects output -> initiator is receiver", () => {
  const outA = { expectsOutput: true, shareWithPartner: false };
  const outB = { expectsOutput: false, shareWithPartner: true };
  const { a, b } = resolveBothRoles(outA, outB, 100, 200);
  expect(a).toBe("receiver");
  expect(b).toBe("sender");
});

test("only responder expects output -> responder is receiver", () => {
  const outA = { expectsOutput: false, shareWithPartner: true };
  const outB = { expectsOutput: true, shareWithPartner: false };
  const { a, b } = resolveBothRoles(outA, outB, 100, 200);
  expect(a).toBe("sender");
  expect(b).toBe("receiver");
});

test("both expect output, initiator has fewer records -> initiator is receiver", () => {
  const out = { expectsOutput: true, shareWithPartner: true };
  const { a, b } = resolveBothRoles(out, out, 50, 200);
  expect(a).toBe("receiver");
  expect(b).toBe("sender");
});

test("both expect output, responder has fewer records -> responder is receiver", () => {
  const out = { expectsOutput: true, shareWithPartner: true };
  const { a, b } = resolveBothRoles(out, out, 200, 50);
  expect(a).toBe("sender");
  expect(b).toBe("receiver");
});

test("both expect output, equal record counts -> initiator is receiver", () => {
  const out = { expectsOutput: true, shareWithPartner: true };
  const { a, b } = resolveBothRoles(out, out, 100, 100);
  expect(a).toBe("receiver");
  expect(b).toBe("sender");
});

test("record counts ride the terms messages, not a separate frame", async () => {
  const [connA, connB] = makeConnections();
  const { conn: recordingA, sent: initiatorSent } = recordingConnection(connA);
  const { conn: recordingB, sent: responderSent } = recordingConnection(connB);
  const [a, b] = await Promise.all([
    exchangeTerms(recordingA, "initiator", termsA, 100),
    exchangeTerms(recordingB, "responder", termsB, 200),
  ]);

  expect(a.partnerRecordCount).toBe(200);
  expect(b.partnerRecordCount).toBe(100);

  expect(initiatorSent[0]).toMatchObject({
    linkageTerms: termsA,
    recordCount: 100,
  });
  expect(responderSent[0]).toMatchObject({
    linkageTerms: termsB,
    decision: "proceed",
    recordCount: 200,
  });

  for (const frame of [...initiatorSent, ...responderSent]) {
    if ("recordCount" in frame) expect("linkageTerms" in frame).toBe(true);
  }
});

// --- No width rides the envelope ---------------------------------------------
// The per-key candidate widths every derived single-pass bound reads are a
// function of the AGREED terms, which both parties hold once this exchange
// returns, so neither declares a width to the other and neither reads one.

test("neither terms message holds a width field", async () => {
  const [connA, connB] = makeConnections();
  const { conn: recordingA, sent: initiatorSent } = recordingConnection(connA);
  const { conn: recordingB, sent: responderSent } = recordingConnection(connB);
  await Promise.all([
    exchangeTerms(recordingA, "initiator", termsA, 100),
    exchangeTerms(recordingB, "responder", termsB, 200),
  ]);

  for (const frame of [...initiatorSent, ...responderSent])
    expect(frame).not.toHaveProperty("effectiveKeyCount");
  for (const fields of Object.values(TERMS_ENVELOPE_FIELDS))
    expect(fields).not.toContain("effectiveKeyCount");
});

test("a terms frame still holding the retired width field is ignored", async () => {
  // The envelope schemas are non-strict, so a peer that still declares a width
  // has it stripped at the parse and the exchange proceeds on the widths both
  // parties derive. By design, not incidental: the field held nothing
  // the agreed terms do not, so there is nothing for a refusal to protect.
  const [connA, connB] = makeConnections();
  const responder = exchangeTerms(connB, "responder", termsB, 200);
  await connA.send({
    linkageTerms: termsA,
    recordCount: 100,
    effectiveKeyCount: 20,
    protocolVersion: PROTOCOL_VERSION,
  });
  const msg2 = (await connA.receive()) as Record<string, unknown>;
  expect(msg2).toMatchObject({ decision: "proceed" });
  await connA.send({ decision: "proceed" });

  const result = await responder;
  expect(result.partnerRecordCount).toBe(100);
  expect(result.warnings).toEqual([]);
});

// --- Missing record count ----------------------------------------------------

test("initiator aborts when a proceed frame omits the record count", async () => {
  // recordCount is optional on the message-2 schema because that frame doubles as
  // the responder's abort frame, so a proceed that omits it is not a schema
  // rejection: the initiator enforces presence explicitly (the count feeds role
  // resolution and the single-pass element bounds) and aborts rather than
  // proceeding without it. Drive the responder by hand to inject a countless
  // proceed frame.
  const [connA, connB] = makeConnections();
  const initiator = exchangeTerms(connA, "initiator", termsA, 100);
  await connB.receive(); // msg 1: initiator's terms
  await connB.send({
    linkageTerms: termsB,
    decision: "proceed",
    protocolVersion: PROTOCOL_VERSION,
  }); // no recordCount
  // The initiator sends an abort (msg 3) and then throws; drain the abort so
  // connB does not dangle, and confirm it holds the reason.
  const abort = await connB.receive();
  expect(abort).toMatchObject({
    decision: "abort",
    abortReasons: ["partner omitted record count"],
  });
  await expect(initiator).rejects.toThrow(
    "partner omitted record count on terms exchange",
  );
});

test("responder rejects a message 1 that omits the record count", async () => {
  // recordCount is required on message 1 (the initiator's opening terms are never
  // an abort), so an omitted count is a schema rejection: the responder relays it
  // as a failed-to-parse abort rather than proceeding without a count.
  const [connA, connB] = makeConnections();
  const responder = exchangeTerms(connB, "responder", termsB, 200);
  await connA.send({
    linkageTerms: termsA,
    effectiveKeyCount: 1,
    protocolVersion: PROTOCOL_VERSION,
  }); // msg 1 without recordCount
  // The responder aborts (msg 2) with a parse-failure reason; drain it.
  const abort = await connA.receive();
  expect(abort).toMatchObject({ decision: "abort" });
  await expect(responder).rejects.toThrow("linkage terms are incompatible");
});

// --- Incompatible terms ------------------------------------------------------

test("an incompatibility rejects both parties with a message identifying the cause", async () => {
  const results = await runExchange(termsA, { ...termsB, algorithm: "psi-c" });
  expect(results[0].status).toBe("rejected");
  expect(results[1].status).toBe("rejected");
  const messages = results
    .filter((r) => r.status === "rejected")
    .map((r) => (r as PromiseRejectedResult).reason.message as string);
  expect(
    messages.some(
      (m) => m.includes("algorithm mismatch") || m.includes("abort"),
    ),
  ).toBe(true);
});

test("responder neutralizes partner bytes in a linkage-terms parse error", async () => {
  // End-to-end guard for the source sanitization: the per-call-site pin lives
  // in linkageTermsSchema.test.ts; this proves protocolSetup ROUTES the parse
  // error through it. A partner whose terms fail to parse with a bidi override
  // and an ANSI escape in the issue PATH must have those bytes neutralized in
  // the rejection the responder relays, never exposed raw: reverting to a raw
  // ZodError.message regresses this, leaking U+202E verbatim in the JSON dump.
  const evilKey = "\x1b[31m\u202e" + "x".repeat(MAX_NAME_LENGTH);
  const [connA, connB] = makeConnections();
  const responder = exchangeTerms(connB, "responder", termsB, 200);
  await connA.send({
    recordCount: 100,
    effectiveKeyCount: 1,
    protocolVersion: PROTOCOL_VERSION,
    linkageTerms: {
      ...termsA,
      linkageKeys: [
        {
          name: "SSN",
          elements: [
            {
              field: "ssn",
              transform: [{ function: "trim", params: { [evilKey]: 1 } }],
            },
          ],
        },
      ],
    },
  });
  const reason = await responder.then(
    () => {
      throw new Error("expected the responder to reject");
    },
    (e: unknown) => e as Error,
  );
  expect(reason.message).toContain("failed to parse");
  expect(reason.message).not.toContain("\u202e");
  expect(reason.message).not.toContain("\x1b");
  expect(reason.message).toContain("\\u202e");
});

test("initiator: a pathological-count abortReasons fails cleanly, not with a RangeError", async () => {
  // The partner's decision frame (termsWithDecisionMessage, message 2) holds an
  // optional abortReasons list. A pathological count there made Zod throw
  // `Invalid string length` building its error from one issue per entry; the
  // boundedArray gate turns it into one clean count issue, so receiveParsed
  // raises a ConnectionError("protocol") with a non-RangeError cause.
  const [connA, connB] = makeConnections();
  const initiator = exchangeTerms(connA, "initiator", termsA, 100);
  await connB.receive(); // consume the initiator's terms (message 1)
  // An abort frame holds no recordCount (like save, role metadata is not spread
  // onto an abort) but does hold the protocol version, as a conforming
  // responder's does; the initiator throws on the abort before it would read a
  // count.
  await connB.send({
    linkageTerms: termsB,
    decision: "abort",
    protocolVersion: PROTOCOL_VERSION,
    abortReasons: Array.from({ length: 4_000_000 }, () => 123),
  });
  const err = await initiator.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("protocol");
  expect((err as ConnectionError).cause).not.toBeInstanceOf(RangeError);
});

// --- Abort-send failure on the responder -------------------------------------

test("exchangeTerms responder: rejects (does not hang) when abort send fails on incompatible terms", async () => {
  const [connA, connB] = makeConnections();
  // Wrap connB so its send always rejects (simulating a transport-layer
  // failure on the responder side) while receive still delivers msg1 from the
  // initiator. The responder reads the terms, detects the incompatible
  // algorithm, and attempts to send the abort, which fails.
  const failingB: MessageConnection = {
    send: () => Promise.reject(new Error("simulated transport failure")),
    receive: (timeoutMs?: number) => connB.receive(timeoutMs),
    close: () => connB.close(),
  };

  const responder = exchangeTerms(
    failingB,
    "responder",
    { ...termsB, algorithm: "psi-c" },
    200,
  );
  // Inject msg1 (the initiator's terms) directly. Running the initiator's
  // exchangeTerms is not possible here because the responder's reply (the
  // failed abort send) never reaches connA, and the initiator would hang. The
  // recordCount keeps msg1 well-formed so the responder reaches the algorithm
  // incompatibility (not a parse error) before its abort send fails.
  await connA.send({
    linkageTerms: termsA,
    recordCount: 100,
    effectiveKeyCount: 1,
    protocolVersion: PROTOCOL_VERSION,
  });
  await expect(responder).rejects.toThrow("linkage terms are incompatible");
});

// --- Partner fragments composed around first-party copy -----------------------
// Abort reasons and compatibility errors are partner-written text standing
// beside this exchange's own copy. The display sink redacts each rendered
// link forward from a dangling BEGIN to the end of that link, so an
// unredacted marker planted in one fragment deletes everything composed
// behind it -- the next reason, or the sentence naming the mismatch. Each is
// redacted where it is composed, which bounds that rule to the fragment.

const BEGIN_MARKER = "-----BEGIN OPENSSH PRIVATE KEY-----";
const END_MARKER = "-----END OPENSSH PRIVATE KEY-----";
const REDACTION = "[redacted private key]";

/** The initiator's abort slot: the partner's message 2 carries the reasons. */
async function initiatorAbortRender(reasons: string[]): Promise<string> {
  const [connA, connB] = makeConnections();
  const initiator = exchangeTerms(connA, "initiator", termsA, 100);
  await connB.receive();
  await connB.send({
    linkageTerms: termsB,
    decision: "abort",
    protocolVersion: PROTOCOL_VERSION,
    abortReasons: reasons,
  });
  return sanitizeErrorForDisplay(await initiator.catch((err: unknown) => err));
}

/** The responder's abort slot: the partner's message 3 carries the reasons. */
async function responderAbortRender(reasons: string[]): Promise<string> {
  const [connA, connB] = makeConnections();
  const responder = exchangeTerms(connB, "responder", termsB, 200);
  await connA.send({
    linkageTerms: termsA,
    recordCount: 100,
    protocolVersion: PROTOCOL_VERSION,
  });
  await connA.receive();
  await connA.send({ decision: "abort", abortReasons: reasons });
  return sanitizeErrorForDisplay(await responder.catch((err: unknown) => err));
}

const abortRenders = [initiatorAbortRender, responderAbortRender];

test("a marker in an abort reason leaves the reason behind it", async () => {
  for (const render of abortRenders) {
    const rendered = await render([BEGIN_MARKER, "the second reason"]);
    expect(rendered).toContain("partner aborted linkage terms exchange");
    expect(rendered).toContain(REDACTION);
    expect(rendered).toContain("the second reason");
  }
});

test("a lone END marker in an abort reason deletes nothing", async () => {
  for (const render of abortRenders)
    expect(await render([END_MARKER, "the second reason"])).toBe(
      `partner aborted linkage terms exchange: ${END_MARKER}; the second reason`,
    );
});

test("a plain abort reason reads as its own text", async () => {
  for (const render of abortRenders)
    expect(await render(["the operator declined the terms"])).toBe(
      "partner aborted linkage terms exchange: the operator declined the terms",
    );
});

/**
 * Both parties' renders of a payload-column mismatch: the responder weighs the
 * terms and throws the incompatibility, and the initiator meets the same
 * errors as the reasons on the responder's abort.
 */
async function columnMismatchRenders(
  name: string,
): Promise<{ initiator: string; responder: string }> {
  const [a, b] = await runExchange(termsA, {
    ...termsB,
    payload: { receive: [{ name }] },
  });
  const rendered = (settled: PromiseSettledResult<unknown>): string =>
    sanitizeErrorForDisplay((settled as PromiseRejectedResult).reason);
  return { initiator: rendered(a), responder: rendered(b) };
}

test("a marker in a partner column name leaves the diagnostic it names", async () => {
  const { initiator, responder } = await columnMismatchRenders(BEGIN_MARKER);
  for (const rendered of [initiator, responder]) {
    expect(rendered).toContain(REDACTION);
    expect(rendered).toContain("do not match partner send columns");
  }
  expect(responder).toContain(
    'linkage terms are incompatible: payload mismatch: local receive columns ["[redacted private key]"]',
  );
  expect(initiator).toContain(
    "partner aborted linkage terms exchange: payload mismatch:",
  );
});

test("a plain partner column name reads as its own text", async () => {
  const { initiator, responder } = await columnMismatchRenders("email");
  expect(responder).toBe(
    'linkage terms are incompatible: payload mismatch: local receive columns ["email"] do not match partner send columns []',
  );
  expect(initiator).toBe(
    'partner aborted linkage terms exchange: payload mismatch: local receive columns ["email"] do not match partner send columns []',
  );
});
