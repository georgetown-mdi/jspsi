import { expect, test } from "vitest";

import { EncryptedConnection } from "../../src/connection/encryptedConnection";
import { deriveAeadKey } from "../../src/auth";
import { toBase64Url } from "../../src/utils/crypto";
import { PassthroughConnection } from "../utils/passthroughConnection";
import type { HandshakeRole } from "../../src/types";

// Fixed 32-byte session key for deterministic tests.
const SESSION_KEY = new Uint8Array(32).fill(0x42) as Uint8Array<ArrayBuffer>;

function makePassthroughPair(): [PassthroughConnection, PassthroughConnection] {
  const a = new PassthroughConnection();
  const b = new PassthroughConnection();
  a.setOther(b);
  b.setOther(a);
  return [a, b];
}

async function makeEncryptedPair(): Promise<
  [EncryptedConnection, EncryptedConnection]
> {
  const [connA, connB] = makePassthroughPair();
  return Promise.all([
    EncryptedConnection.create(connA, SESSION_KEY, "initiator"),
    EncryptedConnection.create(connB, SESSION_KEY, "responder"),
  ]);
}

/**
 * Build a valid AES-GCM envelope for `data` at the given sequence number.
 * Derives the send key for `role` from SESSION_KEY, matching EncryptedConnection.
 */
async function buildEnvelope(
  role: HandshakeRole,
  seq: number,
  data: unknown,
): Promise<{ enc: string }> {
  const context =
    role === "initiator" ? "initiator-to-responder" : "responder-to-initiator";
  const keyBytes = await deriveAeadKey(SESSION_KEY, context);
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );

  const iv = new Uint8Array(12) as Uint8Array<ArrayBuffer>;
  new DataView(iv.buffer).setBigUint64(4, BigInt(seq), false);

  const cipher = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(JSON.stringify(data)),
    ),
  );
  const envelope = new Uint8Array(12 + cipher.length) as Uint8Array<ArrayBuffer>;
  envelope.set(iv);
  envelope.set(cipher, 12);
  return { enc: toBase64Url(envelope) };
}

// --- Round-trip ---------------------------------------------------------------

test("initiator to responder: plaintext survives encrypt/decrypt", async () => {
  const [encA, encB] = await makeEncryptedPair();
  const message = { hello: "world", n: 42 };

  const received = new Promise<unknown>((resolve) => encB.once("data", resolve));
  await encA.send(message);

  expect(await received).toEqual(message);
});

test("responder to initiator: plaintext survives encrypt/decrypt", async () => {
  const [encA, encB] = await makeEncryptedPair();
  const message = { foo: [1, 2, 3] };

  const received = new Promise<unknown>((resolve) => encA.once("data", resolve));
  await encB.send(message);

  expect(await received).toEqual(message);
});

test("multiple messages all decrypt correctly", async () => {
  const [encA, encB] = await makeEncryptedPair();

  for (const msg of [{ n: 0 }, { n: 1 }, { n: 2 }]) {
    const received = new Promise<unknown>((resolve) =>
      encB.once("data", resolve),
    );
    await encA.send(msg);
    expect(await received).toEqual(msg);
  }
});

// --- Authentication tag failure -----------------------------------------------

test("corrupted ciphertext: error is emitted", async () => {
  const conn = new PassthroughConnection();
  const enc = await EncryptedConnection.create(conn, SESSION_KEY, "responder");

  const error = new Promise<unknown>((resolve) => enc.once("error", resolve));

  // IV for seq=0, followed by 32 bytes of garbage (wrong ciphertext + tag).
  const iv = new Uint8Array(12) as Uint8Array<ArrayBuffer>;
  const garbage = new Uint8Array(32).fill(0xff) as Uint8Array<ArrayBuffer>;
  const bytes = new Uint8Array(44) as Uint8Array<ArrayBuffer>;
  bytes.set(iv);
  bytes.set(garbage, 12);

  conn.emit("data", { enc: toBase64Url(bytes) });

  const err = await error;
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).toMatch(/authentication tag/i);
});

test("after tag failure: subsequent send throws", async () => {
  const conn = new PassthroughConnection();
  const enc = await EncryptedConnection.create(conn, SESSION_KEY, "responder");

  // Register error listener BEFORE injecting bad data so we can await it.
  const errorEmitted = new Promise<void>((resolve) =>
    enc.once("error", () => resolve()),
  );
  const iv = new Uint8Array(12) as Uint8Array<ArrayBuffer>;
  const garbage = new Uint8Array(32).fill(0xff) as Uint8Array<ArrayBuffer>;
  const bytes = new Uint8Array(44) as Uint8Array<ArrayBuffer>;
  bytes.set(iv);
  bytes.set(garbage, 12);
  conn.emit("data", { enc: toBase64Url(bytes) });

  // Wait until handleInbound's async decrypt has failed and the error fired.
  await errorEmitted;

  await expect(enc.send({ test: true })).rejects.toThrow(/permanently dead/i);
});

test("after tag failure: further data events are suppressed", async () => {
  const conn = new PassthroughConnection();
  const enc = await EncryptedConnection.create(conn, SESSION_KEY, "responder");

  const errorEmitted = new Promise<void>((resolve) =>
    enc.once("error", () => resolve()),
  );
  const iv = new Uint8Array(12) as Uint8Array<ArrayBuffer>;
  const garbage = new Uint8Array(32).fill(0xff) as Uint8Array<ArrayBuffer>;
  const bytes = new Uint8Array(44) as Uint8Array<ArrayBuffer>;
  bytes.set(iv);
  bytes.set(garbage, 12);
  conn.emit("data", { enc: toBase64Url(bytes) });
  await errorEmitted; // wait until failed=true is set

  let dataFired = false;
  enc.on("data", () => {
    dataFired = true;
  });

  // Inject a valid envelope; handleInbound exits immediately because failed=true.
  conn.emit("data", await buildEnvelope("initiator", 0, { x: 1 }));

  expect(dataFired).toBe(false);
});

// --- Replay -------------------------------------------------------------------

test("replay: duplicate sequence number is rejected and error is emitted", async () => {
  const conn = new PassthroughConnection();
  const enc = await EncryptedConnection.create(conn, SESSION_KEY, "responder");

  const envelope = await buildEnvelope("initiator", 0, { n: 1 });

  // First delivery: accepted.
  const first = new Promise<void>((resolve) => enc.once("data", () => resolve()));
  conn.emit("data", envelope);
  await first;

  // Second delivery (same seq): replay, must emit error.
  const error = new Promise<unknown>((resolve) => enc.once("error", resolve));
  conn.emit("data", envelope);

  const err = await error;
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).toMatch(/replay|out-of-order/i);
});

// --- Out-of-order -------------------------------------------------------------

test("out-of-order: seq <= last accepted is rejected", async () => {
  const conn = new PassthroughConnection();
  const enc = await EncryptedConnection.create(conn, SESSION_KEY, "responder");

  // Accept seq=0 and seq=1.
  const recv0 = new Promise<void>((resolve) => enc.once("data", () => resolve()));
  conn.emit("data", await buildEnvelope("initiator", 0, {}));
  await recv0;

  const recv1 = new Promise<void>((resolve) => enc.once("data", () => resolve()));
  conn.emit("data", await buildEnvelope("initiator", 1, {}));
  await recv1;

  // seq=1 again: out-of-order (1 <= 1).
  const error = new Promise<unknown>((resolve) => enc.once("error", resolve));
  conn.emit("data", await buildEnvelope("initiator", 1, {}));

  const err = await error;
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).toMatch(/replay|out-of-order/i);
});

// --- Counter overflow ---------------------------------------------------------

test("send throws before sequence number exceeds MAX_SAFE_INTEGER", async () => {
  const conn = new PassthroughConnection();
  const enc = await EncryptedConnection.create(conn, SESSION_KEY, "initiator");

  // Advance the send counter past MAX_SAFE_INTEGER without encrypting.
  (enc as unknown as { sendSeq: number }).sendSeq = Number.MAX_SAFE_INTEGER + 1;

  await expect(enc.send({ overflow: true })).rejects.toThrow(/overflow/i);
});
