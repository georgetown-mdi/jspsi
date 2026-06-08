import { expect, test } from "vitest";

import { exchangeBootstrapSecret, exchangeTerms } from "../src/protocolSetup";
import { PAKE_TOKEN_REGEX } from "../src/config/connection";
import type { HandshakeRole } from "../src/types";
import type { LinkageTerms } from "../src/config/linkageTerms";

import {
  createMessagePipe,
  type MessageConnection,
} from "../src/connection/messageConnection";

// --- Fixtures ----------------------------------------------------------------

const sharedFields: LinkageTerms["linkageFields"] = [
  { name: "ssn", type: "ssn" },
];
const sharedKeys: LinkageTerms["linkageKeys"] = [
  { name: "SSN", elements: [{ field: "ssn" }] },
];

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
const termsB: LinkageTerms = { ...termsA, identity: "Party B" };

/** A connection that records every frame passed to send(), for wire assertions. */
function recording(conn: MessageConnection): {
  conn: MessageConnection;
  sent: unknown[];
} {
  const sent: unknown[] = [];
  return {
    sent,
    conn: {
      send: (data) => {
        sent.push(data);
        return conn.send(data);
      },
      receive: (timeoutMs?: number) => conn.receive(timeoutMs),
      close: () => conn.close(),
    },
  };
}

/**
 * Run one side of a zero-setup `--save` exchange: advertise the save intent on
 * the terms round-trip, then -- only when both sides advertised it -- run the
 * dedicated secret transmission, mirroring runExchange's sequencing.
 */
async function runSide(
  conn: MessageConnection,
  role: HandshakeRole,
  terms: LinkageTerms,
  saveIntent: boolean | undefined,
): Promise<{ partnerSaveIntent: boolean; secret?: string }> {
  const { partnerSaveIntent } = await exchangeTerms(
    conn,
    role,
    terms,
    saveIntent,
  );
  const secret =
    saveIntent === true && partnerSaveIntent
      ? await exchangeBootstrapSecret(conn, role)
      : undefined;
  return { partnerSaveIntent, secret };
}

// --- Intent advertisement ----------------------------------------------------

test("both parties --save: each learns the other advertised save intent", async () => {
  const [a, b] = createMessagePipe();
  const [resA, resB] = await Promise.all([
    runSide(a, "initiator", termsA, true),
    runSide(b, "responder", termsB, true),
  ]);
  expect(resA.partnerSaveIntent).toBe(true);
  expect(resB.partnerSaveIntent).toBe(true);
});

test("one party --save: each side correctly learns whether the other saved", async () => {
  const [a, b] = createMessagePipe();
  // A saves, B does not.
  const [resA, resB] = await Promise.all([
    runSide(a, "initiator", termsA, true),
    runSide(b, "responder", termsB, false),
  ]);
  expect(resA.partnerSaveIntent).toBe(false);
  expect(resB.partnerSaveIntent).toBe(true);
});

test("one party --save (responder saves): intent flows in both directions", async () => {
  const [a, b] = createMessagePipe();
  // Initiator does not save; responder does.
  const [resA, resB] = await Promise.all([
    runSide(a, "initiator", termsA, false),
    runSide(b, "responder", termsB, true),
  ]);
  expect(resA.partnerSaveIntent).toBe(true);
  expect(resB.partnerSaveIntent).toBe(false);
});

test("neither party --save: partnerSaveIntent is false on both sides", async () => {
  const [a, b] = createMessagePipe();
  const [resA, resB] = await Promise.all([
    runSide(a, "initiator", termsA, false),
    runSide(b, "responder", termsB, false),
  ]);
  expect(resA.partnerSaveIntent).toBe(false);
  expect(resB.partnerSaveIntent).toBe(false);
});

// --- Secret transmission -----------------------------------------------------

test("both parties --save: the initiator's secret reaches the responder intact", async () => {
  const [a, b] = createMessagePipe();
  const [resA, resB] = await Promise.all([
    runSide(a, "initiator", termsA, true),
    runSide(b, "responder", termsB, true),
  ]);
  expect(resA.secret).toBeDefined();
  expect(resB.secret).toBe(resA.secret);
});

test("the bootstrapped secret is a base64url 32-byte token (key-file format)", async () => {
  const [a, b] = createMessagePipe();
  const [resA] = await Promise.all([
    runSide(a, "initiator", termsA, true),
    runSide(b, "responder", termsB, true),
  ]);
  expect(resA.secret).toMatch(PAKE_TOKEN_REGEX);
});

test("each call mints a fresh secret", async () => {
  const run = async () => {
    const [a, b] = createMessagePipe();
    const [resA] = await Promise.all([
      runSide(a, "initiator", termsA, true),
      runSide(b, "responder", termsB, true),
    ]);
    return resA.secret;
  };
  const [first, second] = await Promise.all([run(), run()]);
  expect(first).not.toBe(second);
});

test("no secret is transmitted when only one party saves", async () => {
  const [a, b] = createMessagePipe();
  const [resA, resB] = await Promise.all([
    runSide(a, "initiator", termsA, true),
    runSide(b, "responder", termsB, false),
  ]);
  expect(resA.secret).toBeUndefined();
  expect(resB.secret).toBeUndefined();
});

// --- Wire format -------------------------------------------------------------

test("the save flag rides the terms message when set", async () => {
  const [rawA, b] = createMessagePipe();
  const { conn: a, sent } = recording(rawA);
  await Promise.all([
    runSide(a, "initiator", termsA, true),
    runSide(b, "responder", termsB, true),
  ]);
  // Message 1 is the initiator's terms; it carries save: true.
  expect(sent[0]).toMatchObject({ save: true });
});

test("no save field is put on the wire when save intent is omitted", async () => {
  const [rawA, b] = createMessagePipe();
  const { conn: a, sent } = recording(rawA);
  await Promise.all([
    // undefined -> the recurring/authenticated path: omit the field entirely.
    runSide(a, "initiator", termsA, undefined),
    runSide(b, "responder", termsB, undefined),
  ]);
  for (const frame of sent)
    expect(Object.prototype.hasOwnProperty.call(frame, "save")).toBe(false);
});
