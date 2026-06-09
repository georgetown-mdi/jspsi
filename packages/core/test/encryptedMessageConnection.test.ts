import { readFileSync } from "node:fs";

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
import { deriveAeadKey, AEAD_CONTEXTS, type AeadContext } from "../src/auth";
import { fromBase64Url, toBase64Url } from "../src/utils/crypto";
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

// --- Sequence: replay / reorder / gap -----------------------------------------

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

test("a forward-gap frame (seq skips ahead) is rejected as a security failure", async () => {
  const [recv, peer] = await makeInjectable("responder");
  // The acceptance-criteria example: 0 then 5. Frame 0 is accepted, then a frame
  // whose seq jumps past the expected next value (1) is proof that frames 1..4
  // were dropped or withheld in transit.
  await peer.send(await sealRaw("initiator", 0, jsonPlaintext({ n: 0 })));
  await peer.send(await sealRaw("initiator", 5, jsonPlaintext({ n: 5 })));
  expect(await recv.receive()).toEqual({ n: 0 });
  await expectSecurity(recv.receive(), /skipped ahead|dropped or withheld/i);
});

test("a withheld first frame (stream starts past seq 0) is rejected as a gap", async () => {
  const [recv, peer] = await makeInjectable("responder");
  // recvSeq starts at -1, so the expected first seq is 0. A stream that opens at
  // seq 1 means the very first frame was withheld; this is the gap case at the
  // head of the stream, not a replay (seq 1 is not <= -1).
  await peer.send(await sealRaw("initiator", 1, jsonPlaintext({ n: 1 })));
  await expectSecurity(recv.receive(), /skipped ahead|dropped or withheld/i);
});

test("a strictly incrementing stream is accepted", async () => {
  const [encA, encB] = await makeEncryptedPair();
  // The real send path advances the counter by one per send; a contiguous
  // 0,1,2,3 sequence must pass the strict gap check unchanged and deliver in
  // order.
  for (let i = 0; i < 4; ++i) await encA.send({ i });
  for (let i = 0; i < 4; ++i) expect(await encB.receive()).toEqual({ i });
});

test("a detected gap latches the wrapper", async () => {
  const [recv, peer] = await makeInjectable("responder");
  await peer.send(await sealRaw("initiator", 0, jsonPlaintext({ n: 0 })));
  await peer.send(await sealRaw("initiator", 2, jsonPlaintext({ n: 2 })));
  expect(await recv.receive()).toEqual({ n: 0 });
  const first = await expectSecurity(
    recv.receive(),
    /skipped ahead|dropped or withheld/i,
  );

  // The gap is terminal like every other security failure: a later receive
  // rejects with the very same latched error object, never a fresh one.
  const onReceive = await recv.receive().then(
    () => {
      throw new Error("expected rejection but receive resolved");
    },
    (e: unknown) => e,
  );
  expect(onReceive).toBe(first);
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
  // Align the receiver's expected-next counter so the boundary frame stays
  // contiguous: strict gap detection rejects any seq that is not exactly
  // recvSeq + 1, so a fresh receiver (expecting 0) would otherwise reject a lone
  // frame sealed at MAX_SAFE_INTEGER as a forward gap rather than round-trip it.
  (encB as unknown as { recvSeq: number }).recvSeq =
    Number.MAX_SAFE_INTEGER - 1;
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

test("an inbound frame after recvSeq reaches MAX_SAFE_INTEGER is rejected", async () => {
  const [recv, peer] = await makeInjectable("responder");
  // At a saturated counter the gap guard is degenerate: recvSeq + 1 loses IEEE
  // 754 precision and equals recvSeq, so `seq > recvSeq + 1` can never fire and
  // no representable seq is a forward gap. The neighboring guards must hold the
  // line instead -- the replay guard for any seq <= MAX_SAFE_INTEGER (asserted
  // here), and the BigInt range guard for any seq above it (rejected before the
  // counter comparison, independent of recvSeq; see the test above). The stream
  // is terminal at the top of the counter; saturation opens no hole.
  (recv as unknown as { recvSeq: number }).recvSeq = Number.MAX_SAFE_INTEGER;
  await peer.send(
    await sealRaw(
      "initiator",
      Number.MAX_SAFE_INTEGER,
      jsonPlaintext({ n: 1 }),
    ),
  );
  await expectSecurity(recv.receive(), /replay|out-of-order/i);
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

// --- deriveAeadKey / AEAD_CONTEXTS guards -------------------------------------
// deriveAeadKey and the frozen AEAD_CONTEXTS tuple are exported from auth.ts and
// lost their unit coverage when pake.test.ts was deleted in the X25519 cutover.
// The KAT above pins the exact bytes (and the per-label difference); these
// restore the runtime guards and the remaining derivation properties. (Ported
// from the deleted pake.test.ts.)

test("deriveAeadKey derives a stable 32-byte key for each allowed label", async () => {
  const sessionKey = new Uint8Array(32).fill(0x42);
  for (const context of AEAD_CONTEXTS) {
    const k1 = await deriveAeadKey(sessionKey, context);
    const k2 = await deriveAeadKey(sessionKey, context);
    expect(k1).toHaveLength(32);
    expect(k1).toEqual(k2);
  }
});

test("deriveAeadKey differs for different session keys", async () => {
  const k1 = await deriveAeadKey(
    new Uint8Array(32).fill(0x01),
    "initiator-to-responder",
  );
  const k2 = await deriveAeadKey(
    new Uint8Array(32).fill(0x02),
    "initiator-to-responder",
  );
  expect(k1).not.toEqual(k2);
});

test("every AEAD_CONTEXTS label is printable ASCII", () => {
  // The runtime guard's soundness against a non-NFC context rests on every
  // allowed label being ASCII (ASCII has a single NFC form). Enforce it
  // mechanically so a future non-ASCII label fails here at the point of
  // addition. The class is printable, non-space ASCII (U+0021..U+007E) --
  // stricter than "ASCII": it also rejects a stray leading/trailing space or
  // control char that would survive NFC unchanged.
  for (const context of AEAD_CONTEXTS) {
    expect(context).toMatch(/^[\x21-\x7e]+$/);
  }
});

test("AEAD_CONTEXTS is frozen against runtime mutation", () => {
  expect(Object.isFrozen(AEAD_CONTEXTS)).toBe(true);
  // The readonly tuple type has no `push`; cast past it to model an untyped
  // plain-JS caller trying to widen the guard's allowlist at runtime. A frozen
  // array throws on mutation under the strict mode ES modules always run in.
  expect(() =>
    (AEAD_CONTEXTS as unknown as string[]).push("evil-aead"),
  ).toThrow(TypeError);
});

test("deriveAeadKey rejects a context outside the fixed set", async () => {
  const sessionKey = new Uint8Array(32).fill(0x01);
  // An untyped (plain-JS or `as`-cast) caller can bypass the compile-time
  // AeadContext constraint with a free-form, empty, or non-ASCII label; the
  // runtime guard must fail fast rather than silently derive a key the two
  // parties may not agree on.
  for (const bad of [
    "initiator",
    "",
    "responder-to-initiatoŕ",
    "é-to-responder",
  ]) {
    await expect(
      deriveAeadKey(sessionKey, bad as unknown as AeadContext),
    ).rejects.toThrow(/unknown AEAD context/);
  }
});

// --- AEAD encrypt-path wire vector (end-to-end known-answer) -------------------
// Distinct from the deriveAeadKey KAT above, which pins only the HKDF key
// derivation: this pins the full serialized `{ enc }` envelope the encrypt path
// emits - the 12-byte IV layout, the GCM ciphertext, and the 16-byte tag - for
// both a JSON and a Uint8Array payload. The expected bytes were produced by an
// independent oracle (Node's crypto.hkdfSync + createCipheriv, a different code
// path than the decorator's WebCrypto crypto.subtle) and are checked in at
// test/vectors/aead-envelope-vectors.json for cross-implementation reuse; the
// wire format is specified in docs/SECURITY_DESIGN.md ("Channel security"). The
// assertion compares against that recorded literal, never a decrypt/round-trip,
// so a symmetric encode/decode bug a round-trip would mask is still caught.

interface AeadEnvelopeVector {
  name: string;
  role: HandshakeRole;
  sequence: number;
  payloadType: "json" | "binary";
  payloadJson?: unknown;
  payloadHex?: string;
  ivHex: string;
  ciphertextHex: string;
  tagHex: string;
  envelopeHex: string;
  enc: string;
}

const aeadVectors = JSON.parse(
  readFileSync(
    new URL("./vectors/aead-envelope-vectors.json", import.meta.url),
    {
      encoding: "utf8",
    },
  ),
) as { sessionKeyHex: string; vectors: AeadEnvelopeVector[] };

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  // Guard an odd-length string: new Uint8Array(hex.length / 2) truncates a
  // fractional length rather than throwing, so without this a malformed
  // payloadHex would silently drop its last nibble instead of failing loudly.
  if (hex.length % 2 !== 0)
    throw new Error(`fromHex: odd-length hex string (length ${hex.length})`);
  const out = new Uint8Array(hex.length / 2) as Uint8Array<ArrayBuffer>;
  for (let i = 0; i < out.length; i++)
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// Capture the `{ enc }` the decorator hands to its inner connection. The inner
// connection only records the outbound envelope - nothing decrypts it back - so
// the test asserts against the checked-in literal rather than a round-trip.
async function captureEnc(
  role: HandshakeRole,
  sequence: number,
  payload: unknown,
): Promise<string> {
  let captured: unknown;
  const inner: MessageConnection = {
    send: (d) => {
      captured = d;
      return Promise.resolve();
    },
    receive: () => new Promise<unknown>(() => {}),
    close: () => Promise.resolve(),
  };
  const conn = await EncryptedMessageConnection.create(
    inner,
    SESSION_KEY,
    role,
  );
  // Drive the encrypt path at the vector's fixed sequence (the same private-
  // field cast the overflow tests use) so the IV - and therefore the ciphertext
  // and tag - is deterministic.
  (conn as unknown as { sendSeq: number }).sendSeq = sequence;
  await conn.send(payload);
  // A successful send always calls inner.send, so `captured` is set here; guard
  // it anyway so a future regression fails with a clear message rather than an
  // opaque "cannot read enc of undefined" TypeError.
  if (captured === undefined)
    throw new Error(
      "captureEnc: conn.send resolved without calling inner.send",
    );
  return (captured as { enc: string }).enc;
}

test("the AEAD envelope vector file is present and keyed by SESSION_KEY", () => {
  expect(aeadVectors.vectors.length).toBeGreaterThan(0);
  // The checked-in vectors are derived from this session key; if the two drift
  // apart the recorded bytes no longer describe what the test drives.
  expect(toHex(SESSION_KEY)).toBe(aeadVectors.sessionKeyHex);
});

test.each(aeadVectors.vectors)(
  "$name: the encrypt path emits the pinned { enc } envelope",
  async (vector) => {
    let payload: unknown;
    if (vector.payloadType === "binary") {
      if (vector.payloadHex === undefined)
        throw new Error(
          `vector ${vector.name}: binary vector lacks payloadHex`,
        );
      payload = fromHex(vector.payloadHex);
    } else {
      // Symmetric with the binary guard above: a json vector missing payloadJson
      // would otherwise pass undefined to conn.send and fail as an opaque
      // "usage" error rather than naming the malformed vector. `=== undefined`
      // (not a truthiness check) so a legitimate falsy payload still passes.
      if (vector.payloadJson === undefined)
        throw new Error(`vector ${vector.name}: json vector lacks payloadJson`);
      payload = vector.payloadJson;
    }

    const encStr = await captureEnc(vector.role, vector.sequence, payload);

    // Primary assertion: the exact serialized envelope, as a fixed literal.
    expect(encStr).toBe(vector.enc);

    // Structural breakdown, so a failure names the field that diverged (IV,
    // ciphertext, or tag) rather than only reporting that the blob differs.
    const bytes = fromBase64Url(encStr);
    const iv = bytes.slice(0, 12);
    const tag = bytes.slice(bytes.length - 16);
    const ciphertext = bytes.slice(12, bytes.length - 16);
    expect(toHex(iv)).toBe(vector.ivHex);
    expect(toHex(ciphertext)).toBe(vector.ciphertextHex);
    expect(toHex(tag)).toBe(vector.tagHex);

    // envelopeHex records the full IV || ciphertext || tag for an external
    // reader; pin it to the actual decorator output AND to the concatenation of
    // the component fields, so it cannot silently drift when a vector is edited.
    expect(toHex(bytes)).toBe(vector.envelopeHex);
    expect(vector.envelopeHex).toBe(
      vector.ivHex + vector.ciphertextHex + vector.tagHex,
    );

    // IV layout: 4 reserved zero bytes, then the 8-byte big-endian sequence.
    expect(toHex(iv.slice(0, IV_SEQ_OFFSET))).toBe("00000000");
    expect(
      new DataView(iv.buffer, iv.byteOffset).getBigUint64(IV_SEQ_OFFSET, false),
    ).toBe(BigInt(vector.sequence));
  },
);
