import { expect, test, vi } from "vitest";

import {
  EncryptedConnection,
  IV_SEQ_OFFSET,
  TYPE_JSON,
} from "../../src/connection/encryptedConnection";
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
 * Build a valid AES-GCM envelope for the JSON object `data` at the given
 * sequence number. Derives the send key for `role` from SESSION_KEY and applies
 * the same `TYPE_JSON`-tagged plaintext framing as EncryptedConnection.
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
  new DataView(iv.buffer).setBigUint64(IV_SEQ_OFFSET, BigInt(seq), false);

  const json = new TextEncoder().encode(JSON.stringify(data));
  const plaintext = new Uint8Array(1 + json.length) as Uint8Array<ArrayBuffer>;
  plaintext[0] = TYPE_JSON;
  plaintext.set(json, 1);

  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext),
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

// --- Binary payloads ----------------------------------------------------------
// The PSI protocol sends raw Uint8Array protobuf frames (serializeBinary());
// these must round-trip as Uint8Array, not as a JSON-stringified object.

test("Uint8Array payload survives encrypt/decrypt as binary", async () => {
  const [encA, encB] = await makeEncryptedPair();
  const payload = new Uint8Array([0x03, 0xdf, 0x00, 0xff, 0x10, 0x7f]);

  const received = new Promise<unknown>((resolve) => encB.once("data", resolve));
  await encA.send(payload);

  const got = await received;
  expect(got).toBeInstanceOf(Uint8Array);
  expect(Array.from(got as Uint8Array)).toEqual(Array.from(payload));
});

test("empty Uint8Array payload round-trips as a zero-length Uint8Array", async () => {
  const [encA, encB] = await makeEncryptedPair();
  const payload = new Uint8Array(0);

  const received = new Promise<unknown>((resolve) => encB.once("data", resolve));
  await encA.send(payload);

  const got = await received;
  expect(got).toBeInstanceOf(Uint8Array);
  expect((got as Uint8Array).length).toBe(0);
});

test("binary and JSON payloads interleave over one connection", async () => {
  const [encA, encB] = await makeEncryptedPair();

  const r1 = new Promise<unknown>((resolve) => encB.once("data", resolve));
  await encA.send(new Uint8Array([1, 2, 3]));
  const got1 = await r1;
  expect(got1).toBeInstanceOf(Uint8Array);
  expect(Array.from(got1 as Uint8Array)).toEqual([1, 2, 3]);

  const r2 = new Promise<unknown>((resolve) => encB.once("data", resolve));
  await encA.send({ status: "completed" });
  expect(await r2).toEqual({ status: "completed" });
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

test("encrypt failure: wrapper is permanently dead", async () => {
  const [encA] = await makeEncryptedPair();

  const spy = vi
    .spyOn(crypto.subtle, "encrypt")
    .mockRejectedValueOnce(new Error("forced encrypt failure"));

  try {
    await expect(encA.send({ test: true })).rejects.toThrow(
      "forced encrypt failure",
    );

    await expect(encA.send({ test: true })).rejects.toThrow(/permanently dead/i);
  } finally {
    spy.mockRestore();
  }
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

test("send succeeds at the boundary sendSeq === MAX_SAFE_INTEGER", async () => {
  const [encA, encB] = await makeEncryptedPair();

  // MAX_SAFE_INTEGER is the last sequence number that can be used without
  // ambiguity, so the send at exactly this value must succeed (guards against
  // an off-by-one regression turning the `>` guard into `>=`).
  (encA as unknown as { sendSeq: number }).sendSeq = Number.MAX_SAFE_INTEGER;

  const message = { boundary: true };
  const received = new Promise<unknown>((resolve) => encB.once("data", resolve));
  await expect(encA.send(message)).resolves.toBeUndefined();
  expect(await received).toEqual(message);
});

test("send throws before sequence number exceeds MAX_SAFE_INTEGER", async () => {
  const conn = new PassthroughConnection();
  const enc = await EncryptedConnection.create(conn, SESSION_KEY, "initiator");

  // Advance the send counter past MAX_SAFE_INTEGER without encrypting.
  (enc as unknown as { sendSeq: number }).sendSeq = Number.MAX_SAFE_INTEGER + 1;

  await expect(enc.send({ overflow: true })).rejects.toThrow(/overflow/i);
});

// --- buffered error draining --------------------------------------------------

test("takeBufferedError drains the inner connection's buffered error", async () => {
  const conn = new PassthroughConnection();
  // A transport error buffered on the inner connection before the wrapper
  // attaches its inner.on("error") listener must still be observable via the
  // wrapper, or fail-fast behavior regresses to a stall against a dead
  // transport until the peer timeout fires.
  const innerErr = new Error("pre-wrapper transport failure");
  conn.emit("error", innerErr);

  const enc = await EncryptedConnection.create(conn, SESSION_KEY, "responder");

  expect(enc.takeBufferedError()).toBe(innerErr);
  // Draining clears it on the inner connection too.
  expect(enc.takeBufferedError()).toBeUndefined();
});

// --- close --------------------------------------------------------------------

test("close() detaches inner listeners so late inner events are inert", async () => {
  const conn = new PassthroughConnection();
  const enc = await EncryptedConnection.create(conn, SESSION_KEY, "responder");

  let dataFired = false;
  let errorFired = false;
  enc.on("data", () => {
    dataFired = true;
  });
  enc.on("error", () => {
    errorFired = true;
  });

  await enc.close();

  // After close, neither a valid inbound frame nor a transport error on the
  // inner connection should reach the wrapper.
  conn.emit("data", await buildEnvelope("initiator", 0, { x: 1 }));
  conn.emit("error", new Error("late transport error"));

  // Allow any (incorrectly) scheduled async handleInbound to run.
  await new Promise((resolve) => setImmediate(resolve));

  expect(dataFired).toBe(false);
  expect(errorFired).toBe(false);
});

test("send() after close() throws permanently-dead", async () => {
  const [encA] = await makeEncryptedPair();
  await encA.close();
  await expect(encA.send({ test: true })).rejects.toThrow(/permanently dead/i);
});

// --- detachListeners ----------------------------------------------------------

test("detachListeners() removes inner listeners without closing the inner connection", async () => {
  const conn = new PassthroughConnection();
  const enc = await EncryptedConnection.create(conn, SESSION_KEY, "responder");

  let dataFired = false;
  let errorFired = false;
  enc.on("data", () => {
    dataFired = true;
  });
  enc.on("error", () => {
    errorFired = true;
  });

  enc.detachListeners();

  // Late events on the inner connection must not reach the wrapper.
  conn.emit("data", await buildEnvelope("initiator", 0, { x: 1 }));
  conn.emit("error", new Error("late transport error"));
  await new Promise((resolve) => setImmediate(resolve));

  expect(dataFired).toBe(false);
  expect(errorFired).toBe(false);
  // Inner connection is still open (not closed by detachListeners).
  expect(conn.listenerCount("data")).toBe(0);
});

test("send() after detachListeners() throws permanently-dead", async () => {
  const conn = new PassthroughConnection();
  const enc = await EncryptedConnection.create(conn, SESSION_KEY, "initiator");
  enc.detachListeners();
  await expect(enc.send({ test: true })).rejects.toThrow(/permanently dead/i);
});

// --- Sequence number bounds ---------------------------------------------------

test("inbound seq > MAX_SAFE_INTEGER is rejected before AES-GCM", async () => {
  const conn = new PassthroughConnection();
  const enc = await EncryptedConnection.create(conn, SESSION_KEY, "responder");

  const error = new Promise<unknown>((resolve) => enc.once("error", resolve));

  // Craft an envelope whose IV encodes seq = 2^53 (one above MAX_SAFE_INTEGER).
  const iv = new Uint8Array(12) as Uint8Array<ArrayBuffer>;
  new DataView(iv.buffer).setBigUint64(IV_SEQ_OFFSET, 2n ** 53n, false);
  const garbage = new Uint8Array(32).fill(0xff) as Uint8Array<ArrayBuffer>;
  const bytes = new Uint8Array(44) as Uint8Array<ArrayBuffer>;
  bytes.set(iv);
  bytes.set(garbage, 12);

  conn.emit("data", { enc: toBase64Url(bytes) });

  const err = await error;
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).toMatch(/safe integer range/i);
});

// --- create() error cleanup ---------------------------------------------------

test("create() removes the buffer listener when key derivation fails", async () => {
  const conn = new PassthroughConnection();
  const spy = vi
    .spyOn(crypto.subtle, "importKey")
    .mockRejectedValueOnce(new Error("forced failure"));

  try {
    await expect(
      EncryptedConnection.create(conn, SESSION_KEY, "initiator"),
    ).rejects.toThrow("forced failure");

    // bufferData must have been removed; no 'data' listener remains on conn.
    expect(conn.listenerCount("data")).toBe(0);
  } finally {
    spy.mockRestore();
  }
});
