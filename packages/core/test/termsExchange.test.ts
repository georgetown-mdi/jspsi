import { expect, test } from "vitest";

import { exchangeTerms, resolveRole } from "../src/protocolSetup";
import type { LinkageTerms, Output } from "../src/config/linkageTerms";
import type { PresentedHostKey } from "../src/connection/fileSyncConnection";

import {
  createMessagePipe,
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

test("a malformed partner hostKey is read as absent, not an abort", async () => {
  // Fail-soft contract: the reconciliation only ever warns, so a malformed or
  // over-bound advertisement (a non-conforming or future-versioned peer) must
  // degrade to "no reconciliation" rather than abort the linkage and blame the
  // (valid) terms. Inject an over-bound fingerprint on the initiator's frame and
  // drive the responder to completion by hand.
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
