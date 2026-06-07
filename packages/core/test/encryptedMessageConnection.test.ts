import { expect, test } from "vitest";

import {
  EncryptedMessageConnection,
  IV_SEQ_OFFSET,
  TYPE_JSON,
} from "../src/connection/encryptedMessageConnection";
import {
  createMessagePipe,
  ConnectionError,
  type MessageConnection,
} from "../src/connection/messageConnection";
import { deriveAeadKey } from "../src/auth";
import { toBase64Url } from "../src/utils/crypto";
import type { HandshakeRole } from "../src/types";

// Fixed 32-byte session key for deterministic tests.
const SESSION_KEY = new Uint8Array(32).fill(0x42) as Uint8Array<ArrayBuffer>;

// A connected pair of decorators over one in-memory pipe, one per end.
async function makeEncryptedPair(): Promise<
  [EncryptedMessageConnection, EncryptedMessageConnection]
> {
  const [rawA, rawB] = createMessagePipe();
  return Promise.all([
    EncryptedMessageConnection.create(rawA, SESSION_KEY, "initiator"),
    EncryptedMessageConnection.create(rawB, SESSION_KEY, "responder"),
  ]);
}

// A single decorator on one end of a pipe plus the peer's RAW connection, so a
// test can inject a crafted or garbage frame that bypasses the encrypting send
// path. A decorator with `role` accepts frames sealed by the opposite role.
async function makeInjectable(
  role: HandshakeRole,
): Promise<[EncryptedMessageConnection, MessageConnection]> {
  const [rawPeer, rawLocal] = createMessagePipe();
  const recv = await EncryptedMessageConnection.create(
    rawLocal,
    SESSION_KEY,
    role,
  );
  return [recv, rawPeer];
}

// Build the raw envelope bytes (IV || ciphertext || tag) for `plaintext` at
// `seq`, sealed with the send key for `senderRole`. Mirrors the decorator's own
// IV layout and per-direction keying so a crafted frame is indistinguishable
// from a legitimate one except where the test deliberately corrupts it.
async function sealRawBytes(
  senderRole: HandshakeRole,
  seq: number,
  plaintext: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const context =
    senderRole === "initiator"
      ? "initiator-to-responder"
      : "responder-to-initiator";
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
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext),
  );
  const envelope = new Uint8Array(
    12 + cipher.length,
  ) as Uint8Array<ArrayBuffer>;
  envelope.set(iv);
  envelope.set(cipher, 12);
  return envelope;
}

async function sealRaw(
  senderRole: HandshakeRole,
  seq: number,
  plaintext: Uint8Array<ArrayBuffer>,
): Promise<{ enc: string }> {
  return { enc: toBase64Url(await sealRawBytes(senderRole, seq, plaintext)) };
}

// The decorator's TYPE_JSON-tagged framing for an object payload.
function jsonPlaintext(data: unknown): Uint8Array<ArrayBuffer> {
  const json = new TextEncoder().encode(JSON.stringify(data));
  const plaintext = new Uint8Array(1 + json.length) as Uint8Array<ArrayBuffer>;
  plaintext[0] = TYPE_JSON;
  plaintext.set(json, 1);
  return plaintext;
}

// Assert that `p` rejects with a ConnectionError of `kind` whose message
// matches `messagePattern`, and return the error so a caller can compare its
// identity across later sticky-state assertions.
async function expectRejection(
  p: Promise<unknown>,
  kind: ConnectionError["kind"],
  messagePattern: RegExp,
): Promise<ConnectionError> {
  const err = await p.then(
    () => {
      throw new Error("expected a rejection but the promise resolved");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe(kind);
  expect((err as ConnectionError).message).toMatch(messagePattern);
  return err as ConnectionError;
}

// Convenience wrapper for the common "security"-kind case.
async function expectSecurity(
  p: Promise<unknown>,
  messagePattern: RegExp,
): Promise<ConnectionError> {
  return expectRejection(p, "security", messagePattern);
}

// --- Round-trip ---------------------------------------------------------------

test("JSON object round-trips initiator -> responder", async () => {
  const [encA, encB] = await makeEncryptedPair();
  const message = { hello: "world", n: 42 };
  await encA.send(message);
  expect(await encB.receive()).toEqual(message);
});

test("JSON object round-trips responder -> initiator", async () => {
  const [encA, encB] = await makeEncryptedPair();
  const message = { foo: [1, 2, 3] };
  await encB.send(message);
  expect(await encA.receive()).toEqual(message);
});

test("multiple messages all decrypt in order", async () => {
  const [encA, encB] = await makeEncryptedPair();
  for (const msg of [{ n: 0 }, { n: 1 }, { n: 2 }]) {
    await encA.send(msg);
    expect(await encB.receive()).toEqual(msg);
  }
});

// --- Binary payloads ----------------------------------------------------------
// The PSI protocol sends raw Uint8Array protobuf frames; these must round-trip
// as Uint8Array, not as a JSON-stringified object.

test("Uint8Array payload round-trips as binary", async () => {
  const [encA, encB] = await makeEncryptedPair();
  const payload = new Uint8Array([0x03, 0xdf, 0x00, 0xff, 0x10, 0x7f]);
  await encA.send(payload);
  const got = await encB.receive();
  expect(got).toBeInstanceOf(Uint8Array);
  expect(Array.from(got as Uint8Array)).toEqual(Array.from(payload));
});

test("empty Uint8Array round-trips as a zero-length Uint8Array", async () => {
  const [encA, encB] = await makeEncryptedPair();
  await encA.send(new Uint8Array(0));
  const got = await encB.receive();
  expect(got).toBeInstanceOf(Uint8Array);
  expect((got as Uint8Array).length).toBe(0);
});

test("binary and JSON payloads interleave over one connection", async () => {
  const [encA, encB] = await makeEncryptedPair();
  await encA.send(new Uint8Array([1, 2, 3]));
  const got1 = await encB.receive();
  expect(got1).toBeInstanceOf(Uint8Array);
  expect(Array.from(got1 as Uint8Array)).toEqual([1, 2, 3]);

  await encA.send({ status: "completed" });
  expect(await encB.receive()).toEqual({ status: "completed" });
});

test("a payload larger than the base64 chunk size round-trips", async () => {
  const [encA, encB] = await makeEncryptedPair();
  // Exceeds the 0x8000-byte chunk boundary in toBase64Url; PSI protobuf frames
  // are legitimately this large. Guards the chunk-stitching in the encoder.
  const payload = new Uint8Array(100_000) as Uint8Array<ArrayBuffer>;
  for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
  await encA.send(payload);
  const got = await encB.receive();
  expect(got).toBeInstanceOf(Uint8Array);
  expect(Array.from(got as Uint8Array)).toEqual(Array.from(payload));
});

// --- Replay / out-of-order ----------------------------------------------------

test("a replayed frame is rejected as a security failure", async () => {
  const [recv, peer] = await makeInjectable("responder");
  const envelope = await sealRaw("initiator", 0, jsonPlaintext({ n: 1 }));
  await peer.send(envelope);
  await peer.send(envelope); // same seq again
  expect(await recv.receive()).toEqual({ n: 1 });
  await expectSecurity(recv.receive(), /replay|out-of-order/i);
});

test("an out-of-order frame (seq <= last accepted) is rejected as a security failure", async () => {
  const [recv, peer] = await makeInjectable("responder");
  await peer.send(await sealRaw("initiator", 0, jsonPlaintext({})));
  await peer.send(await sealRaw("initiator", 1, jsonPlaintext({})));
  await peer.send(await sealRaw("initiator", 1, jsonPlaintext({}))); // 1 <= 1
  await recv.receive();
  await recv.receive();
  await expectSecurity(recv.receive(), /replay|out-of-order/i);
});

// --- Integrity / format failures (all rejected as "security") -----------------

test("a flipped ciphertext/tag byte is rejected as a security failure", async () => {
  const [recv, peer] = await makeInjectable("responder");
  const bytes = await sealRawBytes("initiator", 0, jsonPlaintext({ ok: true }));
  bytes[bytes.length - 1] ^= 0xff; // corrupt the GCM tag
  await peer.send({ enc: toBase64Url(bytes) });
  await expectSecurity(recv.receive(), /authentication tag/i);
});

test("an envelope shorter than IV + tag is rejected as a security failure", async () => {
  const [recv, peer] = await makeInjectable("responder");
  await peer.send({
    enc: toBase64Url(new Uint8Array(20) as Uint8Array<ArrayBuffer>),
  }); // < 28 bytes
  await expectSecurity(recv.receive(), /too short/i);
});

test("an envelope with invalid base64url is rejected as a security failure", async () => {
  const [recv, peer] = await makeInjectable("responder");
  await peer.send({ enc: "not valid base64url!!!" });
  await expectSecurity(recv.receive(), /invalid base64url/i);
});

test("a malformed envelope shape is rejected as a security failure", async () => {
  const [recv, peer] = await makeInjectable("responder");
  await peer.send({ notEnc: "x" });
  await expectSecurity(recv.receive(), /invalid envelope/i);
});

test("an empty decrypted payload is rejected as a security failure", async () => {
  const [recv, peer] = await makeInjectable("responder");
  await peer.send(
    await sealRaw("initiator", 0, new Uint8Array(0) as Uint8Array<ArrayBuffer>),
  );
  await expectSecurity(recv.receive(), /payload is empty/i);
});

test("an unknown type tag is rejected as a security failure", async () => {
  const [recv, peer] = await makeInjectable("responder");
  await peer.send(
    await sealRaw(
      "initiator",
      0,
      new Uint8Array([99]) as Uint8Array<ArrayBuffer>,
    ),
  );
  await expectSecurity(recv.receive(), /unknown payload type tag 99/i);
});

test("invalid UTF-8 under a JSON tag is rejected as a security failure", async () => {
  const [recv, peer] = await makeInjectable("responder");
  // TYPE_JSON tag, then bytes for a JSON string literal whose content is an
  // invalid UTF-8 byte. A non-fatal decoder would silently replace it with
  // U+FFFD and resolve with a mangled string; the fatal decoder rejects.
  await peer.send(
    await sealRaw(
      "initiator",
      0,
      new Uint8Array([TYPE_JSON, 0x22, 0xff, 0x22]) as Uint8Array<ArrayBuffer>,
    ),
  );
  await expectSecurity(recv.receive(), /not valid JSON/i);
});

test("a non-JSON JSON-tagged payload is rejected as a security failure", async () => {
  const [recv, peer] = await makeInjectable("responder");
  // TYPE_JSON tag followed by '{', which is not valid JSON.
  await peer.send(
    await sealRaw(
      "initiator",
      0,
      new Uint8Array([TYPE_JSON, 0x7b]) as Uint8Array<ArrayBuffer>,
    ),
  );
  await expectSecurity(recv.receive(), /not valid JSON/i);
});

test("an inbound seq above MAX_SAFE_INTEGER is rejected before decryption", async () => {
  const [recv, peer] = await makeInjectable("responder");
  const iv = new Uint8Array(12) as Uint8Array<ArrayBuffer>;
  new DataView(iv.buffer).setBigUint64(IV_SEQ_OFFSET, 2n ** 53n, false); // one above MAX_SAFE_INTEGER
  const garbage = new Uint8Array(32).fill(0xff);
  const bytes = new Uint8Array(44) as Uint8Array<ArrayBuffer>;
  bytes.set(iv);
  bytes.set(garbage, 12);
  await peer.send({ enc: toBase64Url(bytes) });
  await expectSecurity(recv.receive(), /safe integer range/i);
});

// --- Counter overflow ---------------------------------------------------------

test("send succeeds at exactly sendSeq === MAX_SAFE_INTEGER", async () => {
  const [encA, encB] = await makeEncryptedPair();
  // The last sequence number usable without ambiguity; sending here must
  // succeed, guarding against a `>` -> `>=` off-by-one regression.
  (encA as unknown as { sendSeq: number }).sendSeq = Number.MAX_SAFE_INTEGER;
  await expect(encA.send({ boundary: true })).resolves.toBeUndefined();
  expect(await encB.receive()).toEqual({ boundary: true });
});

test("send refuses to advance past MAX_SAFE_INTEGER and latches the wrapper", async () => {
  const [encA] = await makeEncryptedPair();
  (encA as unknown as { sendSeq: number }).sendSeq =
    Number.MAX_SAFE_INTEGER + 1;
  const first = await expectSecurity(
    encA.send({ overflow: true }),
    /overflow/i,
  );

  // Overflow latches the wrapper dead like any other terminal failure: every
  // later send and receive rejects with the very same error object.
  const onSend = await encA.send({ again: true }).then(
    () => {
      throw new Error("expected rejection but send resolved");
    },
    (e: unknown) => e,
  );
  expect(onSend).toBe(first);

  const onReceive = await encA.receive().then(
    () => {
      throw new Error("expected rejection but receive resolved");
    },
    (e: unknown) => e,
  );
  expect(onReceive).toBe(first);
});

// --- Send-side input validation -----------------------------------------------

test("send(undefined) is rejected at the sender as usage, without latching", async () => {
  const [encA, encB] = await makeEncryptedPair();
  // A value with no JSON representation is caller misuse; it must be caught at
  // the sender with kind "usage", not silently encoded and surfaced at the
  // receiver as a misleading "not valid JSON" security failure.
  await expectRejection(
    encA.send(undefined),
    "usage",
    /no JSON representation/i,
  );

  // Not latched: the connection stays usable for a subsequent valid send.
  await encA.send({ ok: true });
  expect(await encB.receive()).toEqual({ ok: true });
});

test("send rejects an un-serializable value (BigInt, circular) as usage", async () => {
  const [encA, encB] = await makeEncryptedPair();
  // JSON.stringify throws (not returns undefined) for these, so this also pins
  // that the thrown TypeError is wrapped as a ConnectionError, not leaked raw.
  await expectRejection(encA.send(10n), "usage", /not JSON-serializable/i);

  const circular: Record<string, unknown> = {};
  circular.self = circular;
  await expectRejection(encA.send(circular), "usage", /not JSON-serializable/i);

  // Not latched: a valid send still works afterward, on sequence number 0
  // (the rejected sends consumed none).
  await encA.send({ ok: true });
  expect(await encB.receive()).toEqual({ ok: true });
});

test("create rejects a session key that is not 32 bytes", async () => {
  const [raw] = createMessagePipe();
  await expectRejection(
    EncryptedMessageConnection.create(
      raw,
      new Uint8Array(16) as Uint8Array<ArrayBuffer>,
      "initiator",
    ),
    "usage",
    /32 bytes/i,
  );
});

// --- Sticky terminal state ----------------------------------------------------

test("after any failure, subsequent send and receive reject with the same sticky error", async () => {
  const [recv, peer] = await makeInjectable("responder");
  const bytes = await sealRawBytes("initiator", 0, jsonPlaintext({ ok: true }));
  bytes[bytes.length - 1] ^= 0xff; // corrupt the GCM tag
  await peer.send({ enc: toBase64Url(bytes) });

  const first = await expectSecurity(recv.receive(), /authentication tag/i);

  // Every later receive and send rejects with the very same latched error.
  const onReceive = await recv.receive().then(
    () => {
      throw new Error("expected rejection but receive resolved");
    },
    (e: unknown) => e,
  );
  expect(onReceive).toBe(first);

  const onSend = await recv.send({ x: 1 }).then(
    () => {
      throw new Error("expected rejection but send resolved");
    },
    (e: unknown) => e,
  );
  expect(onSend).toBe(first);
});

test("a receive-path transport failure latches the wrapper", async () => {
  const [recv, peer] = await makeInjectable("responder");
  // Close the peer's raw end: the pipe fails recv's inner connection with a
  // transport error. receive() must latch it (symmetric with how send() latches
  // an inner failure), so later calls fast-fail with the same error object.
  await peer.close();

  const first = await expectRejection(
    recv.receive(),
    "transport",
    /peer closed/i,
  );

  const onReceive = await recv.receive().then(
    () => {
      throw new Error("expected rejection but receive resolved");
    },
    (e: unknown) => e,
  );
  expect(onReceive).toBe(first);

  const onSend = await recv.send({ x: 1 }).then(
    () => {
      throw new Error("expected rejection but send resolved");
    },
    (e: unknown) => e,
  );
  expect(onSend).toBe(first);
});

// --- close --------------------------------------------------------------------

test("close latches the wrapper dead and delegates to the inner connection", async () => {
  const [encA, encB] = await makeEncryptedPair();
  await encA.close();

  // The wrapper is dead: a fresh send/receive after a deliberate close is
  // caller misuse ("usage"), never "security" (which is reserved for tampering
  // and must stay distinguishable from a clean shutdown).
  await expectRejection(encA.send({ x: 1 }), "usage", /closed/i);
  await expectRejection(encA.receive(), "usage", /closed/i);

  // Delegation reached the inner transport: the pipe propagated the close, so
  // the peer observes a transport drop rather than hanging.
  await expect(encB.receive()).rejects.toThrow(/peer closed/i);
});

test("close() is idempotent", async () => {
  const [encA] = await makeEncryptedPair();
  await encA.close();
  // A second close() must resolve, not throw or double-tear-down the inner.
  await expect(encA.close()).resolves.toBeUndefined();
});

test("a receive parked when close() runs is cancelled with kind closed", async () => {
  const [encA] = await makeEncryptedPair();
  const parked = encA.receive(); // nothing sent -> parks on inner.receive()
  await encA.close();
  // The inner connection cancels the parked receive with "closed"; the
  // decorator surfaces it unchanged rather than overwriting it with the
  // "usage" close latch.
  await expectRejection(parked, "closed", /closed/i);
});

test("a security failure tears down the inner transport", async () => {
  const [recv, peer] = await makeInjectable("responder");
  const bytes = await sealRawBytes("initiator", 0, jsonPlaintext({ ok: true }));
  bytes[bytes.length - 1] ^= 0xff; // corrupt the GCM tag
  await peer.send({ enc: toBase64Url(bytes) });
  await expectSecurity(recv.receive(), /authentication tag/i);

  // The decorator latched terminal AND closed its inner connection, so the
  // peer's raw end observes the close rather than a still-open channel.
  await expect(peer.receive()).rejects.toThrow(/peer closed/i);
});

test("close() resolves even when the inner connection's close rejects", async () => {
  let closeCalls = 0;
  const inner: MessageConnection = {
    send: () => Promise.resolve(),
    receive: () => new Promise<unknown>(() => {}), // never resolves
    close: () => {
      closeCalls++;
      return Promise.reject(new Error("inner close boom"));
    },
  };
  const enc = await EncryptedMessageConnection.create(
    inner,
    SESSION_KEY,
    "initiator",
  );
  // close() must resolve (the MessageConnection contract), and be idempotent: a
  // second close() also resolves without tearing the inner down twice.
  await expect(enc.close()).resolves.toBeUndefined();
  await expect(enc.close()).resolves.toBeUndefined();
  expect(closeCalls).toBe(1);
});

// --- deriveAeadKey known-answer vector ----------------------------------------

test("deriveAeadKey known-answer vector pins the HKDF info string", async () => {
  // Expected bytes were computed independently with Node's
  // crypto.hkdfSync("sha256", ikm, salt, info, 32) where ikm is the session
  // key, salt is 32 zero bytes, and info is "psilink-aead-v1:<context>". Any
  // accidental change to the prefix, the ":" delimiter, or a context label
  // changes these bytes and trips this test.
  const i2r = await deriveAeadKey(SESSION_KEY, "initiator-to-responder");
  expect(Array.from(i2r)).toEqual([
    137, 48, 164, 66, 67, 154, 111, 145, 124, 252, 206, 143, 77, 18, 169, 80,
    169, 54, 49, 126, 46, 92, 206, 175, 88, 60, 241, 55, 8, 118, 79, 166,
  ]);

  const r2i = await deriveAeadKey(SESSION_KEY, "responder-to-initiator");
  expect(Array.from(r2i)).toEqual([
    42, 33, 161, 192, 230, 99, 145, 224, 60, 157, 36, 214, 24, 218, 4, 130, 114,
    120, 214, 241, 174, 15, 75, 247, 125, 248, 205, 61, 11, 13, 123, 173,
  ]);

  // The two directions must derive distinct keys: identical keys would reuse a
  // nonce across directions (both counters start at 0), which is catastrophic
  // for AES-GCM.
  expect(Array.from(i2r)).not.toEqual(Array.from(r2i));
});
