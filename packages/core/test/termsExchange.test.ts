import { expect, test } from "vitest";

import { exchangeTerms, resolveRole } from "../src/protocolSetup";
import { MAX_NAME_LENGTH } from "../src/config/linkageTerms";
import type { LinkageTerms, Output } from "../src/config/linkageTerms";
import type { PresentedHostKey } from "../src/connection/fileSyncConnection";

import {
  createMessagePipe,
  ConnectionError,
  type MessageConnection,
} from "../src/connection/messageConnection";

// --- Test fixtures -----------------------------------------------------------

const sharedFields: LinkageTerms["linkageFields"] = [
  { name: "ssn", type: "ssn" },
];
const sharedKeys: LinkageTerms["linkageKeys"] = [
  { name: "SSN", elements: [{ field: "ssn" }] },
];

/** Both parties expect output and will share — compatible pair. */
const termsA: LinkageTerms = {
  version: "1.0.0",
  identity: "Party A",
  date: "2025-01-01",
  algorithm: "psi",
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

/** Run an exchange between A (initiator) and B (responder). */
async function runExchange(tA: LinkageTerms, tB: LinkageTerms) {
  const [connA, connB] = makeConnections();
  return Promise.allSettled([
    exchangeTerms(connA, "initiator", tA),
    exchangeTerms(connB, "responder", tB),
  ]);
}

/** Run role resolution between A (initiator) and B (responder). */
async function runRoleResolution(
  outA: Output,
  outB: Output,
  sizeA: number,
  sizeB: number,
) {
  const [connA, connB] = makeConnections();
  return Promise.allSettled([
    resolveRole(connA, "initiator", outA, outB, sizeA),
    resolveRole(connB, "responder", outB, outA, sizeB),
  ]);
}

// --- Happy path --------------------------------------------------------------

test("compatible terms resolve for both parties", async () => {
  const [a, b] = await runExchange(termsA, termsB);
  expect(a.status).toBe("fulfilled");
  expect(b.status).toBe("fulfilled");
});

test("each party receives the other's identity", async () => {
  const [a, b] = await runExchange(termsA, termsB);
  if (a.status !== "fulfilled" || b.status !== "fulfilled") throw new Error();
  expect(a.value.partnerTerms.identity).toBe("Party B");
  expect(b.value.partnerTerms.identity).toBe("Party A");
});

test("no warnings when terms are identical", async () => {
  const [a, b] = await runExchange(termsA, termsB);
  if (a.status !== "fulfilled" || b.status !== "fulfilled") throw new Error();
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

// --- Observed host-key advertisement (201058119) -----------------------------

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
    exchangeTerms(connA, "initiator", termsA, undefined, hostKeyA),
    exchangeTerms(connB, "responder", termsB, undefined, hostKeyB),
  ]);
  expect(a.partnerHostKey).toEqual(hostKeyB);
  expect(b.partnerHostKey).toEqual(hostKeyA);
  // A well-formed advertisement is not flagged malformed.
  expect(a.partnerHostKeyMalformed).toBe(false);
  expect(b.partnerHostKeyMalformed).toBe(false);
});

test("a party that observed no host key advertises none and reads partner's", async () => {
  const [connA, connB] = makeConnections();
  const [a, b] = await Promise.all([
    // Initiator advertises; responder (e.g. a file-drop mount) does not.
    exchangeTerms(connA, "initiator", termsA, undefined, hostKeyA),
    exchangeTerms(connB, "responder", termsB),
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
    exchangeTerms(capturingA, "initiator", termsA),
    exchangeTerms(connB, "responder", termsB),
  ]);
  expect(sent.length).toBeGreaterThan(0);
  for (const frame of sent) expect("hostKey" in frame).toBe(false);
});

test("responder flags a present-but-malformed partner hostKey without aborting", async () => {
  // Fail-soft contract: the reconciliation only ever warns, so a malformed or
  // over-bound advertisement (a non-conforming or future-versioned peer) must
  // degrade to "no reconciliation" rather than abort the linkage and blame the
  // (valid) terms. Inject an over-bound fingerprint on the initiator's frame and
  // drive the responder to completion by hand. The value is still dropped (read
  // as no host key), but the present-but-malformed case is surfaced separately
  // from a genuine absence so the CLI can log it.
  const [connA, connB] = makeConnections();
  const responder = exchangeTerms(connB, "responder", termsB);
  await connA.send({
    linkageTerms: termsA,
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
  const responder = exchangeTerms(connB, "responder", termsB);
  await connA.send({ linkageTerms: termsA, hostKey: null });
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
  const initiator = exchangeTerms(connA, "initiator", termsA);
  await connB.receive(); // msg 1: initiator's terms
  await connB.send({
    linkageTerms: termsB,
    decision: "proceed",
    hostKey: { fingerprint: "x".repeat(200), keyType: "ssh-ed25519" },
  });
  await connB.receive(); // msg 3: initiator's proceed
  const result = await initiator;
  expect(result.partnerHostKey).toBeUndefined();
  expect(result.partnerHostKeyMalformed).toBe(true);
});

// --- Role determination ------------------------------------------------------

test("only initiator expects output -> initiator is receiver", async () => {
  const outA = { expectsOutput: true, shareWithPartner: false };
  const outB = { expectsOutput: false, shareWithPartner: true };
  const [a, b] = await runRoleResolution(outA, outB, 100, 200);
  if (a.status !== "fulfilled" || b.status !== "fulfilled") throw new Error();
  expect(a.value).toBe("receiver");
  expect(b.value).toBe("sender");
});

test("only responder expects output -> responder is receiver", async () => {
  const outA = { expectsOutput: false, shareWithPartner: true };
  const outB = { expectsOutput: true, shareWithPartner: false };
  const [a, b] = await runRoleResolution(outA, outB, 100, 200);
  if (a.status !== "fulfilled" || b.status !== "fulfilled") throw new Error();
  expect(a.value).toBe("sender");
  expect(b.value).toBe("receiver");
});

test("both expect output, initiator has fewer records -> initiator is receiver", async () => {
  const out = { expectsOutput: true, shareWithPartner: true };
  const [a, b] = await runRoleResolution(out, out, 50, 200);
  if (a.status !== "fulfilled" || b.status !== "fulfilled") throw new Error();
  expect(a.value).toBe("receiver");
  expect(b.value).toBe("sender");
});

test("both expect output, responder has fewer records -> responder is receiver", async () => {
  const out = { expectsOutput: true, shareWithPartner: true };
  const [a, b] = await runRoleResolution(out, out, 200, 50);
  if (a.status !== "fulfilled" || b.status !== "fulfilled") throw new Error();
  expect(a.value).toBe("sender");
  expect(b.value).toBe("receiver");
});

test("both expect output, equal record counts -> initiator is receiver", async () => {
  const out = { expectsOutput: true, shareWithPartner: true };
  const [a, b] = await runRoleResolution(out, out, 100, 100);
  if (a.status !== "fulfilled" || b.status !== "fulfilled") throw new Error();
  expect(a.value).toBe("receiver");
  expect(b.value).toBe("sender");
});

test("both parties compute the same role independently", async () => {
  const out = { expectsOutput: true, shareWithPartner: true };
  const [a, b] = await runRoleResolution(out, out, 100, 200);
  if (a.status !== "fulfilled" || b.status !== "fulfilled") throw new Error();
  expect(a.value).not.toBe(b.value);
});

// --- Incompatible terms ------------------------------------------------------

test("algorithm mismatch -> both parties reject", async () => {
  const results = await runExchange(termsA, { ...termsB, algorithm: "psi-c" });
  expect(results[0].status).toBe("rejected");
  expect(results[1].status).toBe("rejected");
});

test("algorithm mismatch error message identifies the cause", async () => {
  const results = await runExchange(termsA, { ...termsB, algorithm: "psi-c" });
  const messages = results
    .filter((r) => r.status === "rejected")
    .map((r) => (r as PromiseRejectedResult).reason.message as string);
  expect(
    messages.some(
      (m) => m.includes("algorithm mismatch") || m.includes("abort"),
    ),
  ).toBe(true);
});

test("linkage keys mismatch -> both parties reject", async () => {
  const results = await runExchange(termsA, {
    ...termsB,
    linkageKeys: [{ name: "Different", elements: [{ field: "ssn" }] }],
  });
  expect(results[0].status).toBe("rejected");
  expect(results[1].status).toBe("rejected");
});

test("neither party expects output -> both parties reject", async () => {
  const noOutput = { expectsOutput: false, shareWithPartner: false };
  const results = await runExchange(
    { ...termsA, output: noOutput },
    { ...termsB, output: noOutput },
  );
  expect(results[0].status).toBe("rejected");
  expect(results[1].status).toBe("rejected");
});

test("responder neutralizes partner bytes in a linkage-terms parse error", async () => {
  // End-to-end wiring guard for the source sanitization. The per-call-site unit
  // pin lives in linkageTerms.test.ts (it exercises describeDecodeError on the
  // ZodError directly); this proves protocolSetup actually ROUTES the relayed
  // parse error through it. A partner whose terms fail to parse with bytes in
  // the issue PATH -- an over-long transform.params key (the invalid_key code)
  // leading with a bidi override and an ANSI escape -- must have those bytes
  // neutralized in the rejection the responder relays, never surfaced raw.
  // Reverting the call site to a raw ZodError.message regresses this (the JSON
  // dump leaks U+202E verbatim).
  const evilKey = "\x1b[31m‮" + "x".repeat(MAX_NAME_LENGTH);
  const [connA, connB] = makeConnections();
  const responder = exchangeTerms(connB, "responder", termsB);
  await connA.send({
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
  expect(reason.message).not.toContain("‮");
  expect(reason.message).not.toContain("\x1b");
  expect(reason.message).toContain("\\u202e");
});

test("initiator: a pathological-count abortReasons fails cleanly, not with a RangeError", async () => {
  // The partner's decision frame (termsWithDecisionMessage, message 2) carries an
  // optional abortReasons list. A pathological count there made Zod throw
  // `Invalid string length` building its error from one issue per entry; the
  // boundedArray gate turns it into one clean count issue, so receiveParsed
  // surfaces a ConnectionError("protocol") with a non-RangeError cause.
  const [connA, connB] = makeConnections();
  const initiator = exchangeTerms(connA, "initiator", termsA);
  await connB.receive(); // consume the initiator's terms (message 1)
  await connB.send({
    linkageTerms: termsB,
    decision: "abort",
    abortReasons: Array.from({ length: 4_000_000 }, () => 123),
  });
  const err = await initiator.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("protocol");
  expect((err as ConnectionError).cause).not.toBeInstanceOf(RangeError);
});

// --- Abort-send failure on the responder -------------------------------------

test("exchangeTerms responder: rejects (does not hang) when abort send fails on incompatible terms", async () => {
  // Regression guard: previously, the responder's incompatible-terms branch
  // awaited `conn.send({...abort})` without a try/catch. If the send rejected
  // (transport error coinciding with terms incompatibility), the abort failure
  // masked the local "linkage terms are incompatible" rejection and left
  // exchangeTerms pending. The fix wraps the abort send in a try/catch so the
  // local rejection is always observed.
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

  const responder = exchangeTerms(failingB, "responder", {
    ...termsB,
    algorithm: "psi-c",
  });
  // Inject msg1 (the initiator's terms) directly. Running the initiator's
  // exchangeTerms is not possible here because the responder's reply (the
  // failed abort send) never reaches connA, and the initiator would hang.
  await connA.send({ linkageTerms: termsA });
  await expect(responder).rejects.toThrow("linkage terms are incompatible");
});
