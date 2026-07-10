import { expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import { exchangeBootstrapSecret, exchangeTerms } from "../src/protocolSetup";
import { prepareForExchange, runExchange } from "../src/exchange";
import { SHARED_SECRET_REGEX } from "../src/config/connection";
import type { HandshakeRole } from "../src/types";
import type { LinkageTerms } from "../src/config/linkageTerms";
import type { ExchangeResult } from "../src/exchange";

import {
  createMessagePipe,
  type MessageConnection,
} from "../src/connection/messageConnection";
import { recordingConnection } from "./utils/recordingConnection";

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
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: sharedFields,
  linkageKeys: sharedKeys,
};
const termsB: LinkageTerms = { ...termsA, identity: "Party B" };

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
    0,
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
  expect(resA.secret).toMatch(SHARED_SECRET_REGEX);
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
  const { conn: a, sent } = recordingConnection(rawA);
  await Promise.all([
    runSide(a, "initiator", termsA, true),
    runSide(b, "responder", termsB, true),
  ]);
  // Message 1 is the initiator's terms; it carries save: true.
  expect(sent[0]).toMatchObject({ save: true });
});

test("no save field is put on the wire when save intent is omitted", async () => {
  const [rawA, b] = createMessagePipe();
  const { conn: a, sent } = recordingConnection(rawA);
  await Promise.all([
    // undefined -> the recurring/authenticated path: omit the field entirely.
    runSide(a, "initiator", termsA, undefined),
    runSide(b, "responder", termsB, undefined),
  ]);
  for (const frame of sent)
    expect(Object.prototype.hasOwnProperty.call(frame, "save")).toBe(false);
});

// --- runExchange bootstrap contract (end-to-end) -----------------------------
//
// The helpers above mirror runExchange's sequencing; these tests drive the real
// runExchange over a pipe (real PSI) to pin the contract the CLI handler depends
// on: a boolean saveIntent -- including `false` -- yields a DEFINED bootstrap, so
// a non-saving party still carries partnerSaveIntent back to emit its notice;
// `undefined` yields no bootstrap. This is the invariant a "clean up false to
// undefined" change (see RunProtocolResult.bootstrap) would silently break.

const psiLibrary = await PSI();

// firstName-only terms: the default key templates all require SSN/DOB, so an
// explicit firstName key gives both parties valid, matching terms over a tiny
// dataset (same approach as exchangeRecordEndToEnd.test.ts).
const firstNameTerms = {
  version: "1.0.0",
  date: "2026-01-01",
  algorithm: "psi" as const,
  linkageStrategy: "cascade" as const,
  deduplicate: false,
  output: { expectsOutput: true, shareWithPartner: true },
  linkageFields: [{ name: "firstName", type: "first_name" as const }],
  linkageKeys: [{ name: "firstName", elements: [{ field: "firstName" }] }],
};

function preparedFor(identity: string) {
  return prepareForExchange(
    { linkageTerms: { ...firstNameTerms, identity } },
    identity,
    [{ first_name: "Alice" }, { first_name: "Bob" }, { first_name: "Carol" }],
    ["first_name"],
  );
}

/** Drive a full runExchange for both parties over a pipe with the given intents. */
async function runExchangeBoth(
  saveInitiator: boolean | undefined,
  saveResponder: boolean | undefined,
): Promise<[ExchangeResult, ExchangeResult]> {
  const [ci, cr] = createMessagePipe();
  return Promise.all([
    runExchange(ci, "initiator", preparedFor("Init"), {
      psiLibrary,
      saveIntent: saveInitiator,
    }),
    runExchange(cr, "responder", preparedFor("Resp"), {
      psiLibrary,
      saveIntent: saveResponder,
    }),
  ]);
}

test("runExchange: saveIntent=false still returns a defined bootstrap (the notify driver)", async () => {
  const [ri, rr] = await runExchangeBoth(false, false);
  // Defined, not undefined: the handler reserves undefined for the interrupt
  // path, and needs partnerSaveIntent here to choose the right no-save notice.
  expect(ri.bootstrap).toEqual({
    partnerSaveIntent: false,
    sharedSecret: undefined,
  });
  expect(rr.bootstrap).toEqual({
    partnerSaveIntent: false,
    sharedSecret: undefined,
  });
});

test("runExchange: saveIntent=undefined returns no bootstrap (authenticated/recurring contract)", async () => {
  const [ri, rr] = await runExchangeBoth(undefined, undefined);
  expect(ri.bootstrap).toBeUndefined();
  expect(rr.bootstrap).toBeUndefined();
});

test("runExchange: a non-saving party still learns a saving partner's intent", async () => {
  // Initiator did NOT pass --save; responder did. The non-saving initiator must
  // come back with partnerSaveIntent true so the CLI emits the "your partner
  // wanted to save" notice; no secret is established for either side.
  const [ri, rr] = await runExchangeBoth(false, true);
  expect(ri.bootstrap).toEqual({
    partnerSaveIntent: true,
    sharedSecret: undefined,
  });
  expect(rr.bootstrap).toEqual({
    partnerSaveIntent: false,
    sharedSecret: undefined,
  });
});

test("runExchange: both saving establishes the same secret on both bootstrap results", async () => {
  const [ri, rr] = await runExchangeBoth(true, true);
  expect(ri.bootstrap?.partnerSaveIntent).toBe(true);
  expect(rr.bootstrap?.partnerSaveIntent).toBe(true);
  expect(ri.bootstrap?.sharedSecret).toMatch(SHARED_SECRET_REGEX);
  // The initiator minted it; the responder received the identical value, and
  // the subsequent role/PSI exchange still completed -- the secret frame did
  // not desync the lockstep that follows terms.
  expect(rr.bootstrap?.sharedSecret).toBe(ri.bootstrap?.sharedSecret);
});
