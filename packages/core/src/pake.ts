import { z } from "zod";
import { p256 } from "@noble/curves/nist.js";

import {
  enc,
  hkdfDerive,
  toBase64Url,
  fromBase64Url,
  bytesEqual,
} from "./utils/crypto.js";
import type { HandshakeRole } from "./types.js";
import {
  ConnectionError,
  type MessageConnection,
} from "./connection/messageConnection.js";

// Blinding points M and N for SPAKE2 over P-256. They are derived via
// hash-to-curve (RFC 9380 §8.2, SSWU for P-256 —
// https://www.rfc-editor.org/rfc/rfc9380) with psilink-specific domain
// separation rather than the fixed P-256 values in RFC 9382 §4. Using
// application-specific M and N adds a second layer of domain separation
// alongside the transcript identity strings: a message forwarded from a
// different SPAKE2 deployment uses different blinding points, producing a wrong
// shared key and a MAC failure independent of the identity-string check.
// See PROTOCOL.md §"Key derivation" for details. The DST and input strings are:
//   DST   = "psilink-SPAKE2-P256-SHA256-SSWU-v1"
//   msg_M = "psilink-SPAKE2-M"
//   msg_N = "psilink-SPAKE2-N"
const M = p256.Point.fromHex(
  "03df561bdb8d6bc4d7e4355bac1c376a6e53d5e0c2c3df07e059ed857b811f7693",
);
const N = p256.Point.fromHex(
  "03969a544c8e21a0a99b6816d63c99746a82b72513d9ac2907749ef6b1bc08b0eb",
);

// Fixed identity strings for the SPAKE2 transcript (RFC 9382 §3.3 —
// https://www.rfc-editor.org/rfc/rfc9382).
const A_ID = enc.encode("psilink-initiator");
const B_ID = enc.encode("psilink-responder");

// P-256 group order.
const ORDER =
  0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

// --- Wire message schemas ----------------------------------------------------
//
// All schemas use `.strict()` so extra keys cause a parse failure rather than
// being silently stripped. The SPAKE2 wire format is fixed; a message arriving
// with unexpected fields indicates either a peer bug or a malicious actor
// fuzzing the parser, and either case should fail fast.

interface Spake2Msg1 {
  pakeMsg: "1";
  point: string; // base64url-encoded compressed point (33 bytes)
}

const Spake2Msg1Schema: z.ZodType<Spake2Msg1> = z
  .object({
    pakeMsg: z.literal("1"),
    point: z.string(),
  })
  .strict();

interface Spake2Msg2 {
  pakeMsg: "2";
  point: string;
  mac: string; // base64url-encoded HMAC-SHA-256 (32 bytes)
}

const Spake2Msg2Schema: z.ZodType<Spake2Msg2> = z
  .object({
    pakeMsg: z.literal("2"),
    point: z.string(),
    mac: z.string(),
  })
  .strict();

interface Spake2Msg3 {
  pakeMsg: "3";
  mac: string;
}

const Spake2Msg3Schema: z.ZodType<Spake2Msg3> = z
  .object({
    pakeMsg: z.literal("3"),
    mac: z.string(),
  })
  .strict();

interface Spake2Abort {
  pakeMsg: "abort";
}

const Spake2AbortSchema: z.ZodType<Spake2Abort> = z
  .object({
    pakeMsg: z.literal("abort"),
  })
  .strict();

// --- Helpers -----------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array<ArrayBuffer>): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacSha256(
  key: Uint8Array<ArrayBuffer>,
  data: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, data));
}

// 8-byte little-endian length prefix as required by the RFC 9382 transcript.
function encodeLen(bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(bytes.length), true);
  return new Uint8Array(view.buffer);
}

function concat(
  ...arrays: Array<Uint8Array<ArrayBuffer>>
): Uint8Array<ArrayBuffer> {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

// Best-effort abort signal: if the peer is still waiting for our next message,
// telling them to give up shortens their recovery from the 30 s handshake
// timeout to immediately. A failure to send the abort is non-fatal — the peer
// will time out on their own — so the send error is swallowed.
async function sendAbort(conn: MessageConnection): Promise<void> {
  try {
    await conn.send({ pakeMsg: "abort" } satisfies Spake2Abort);
  } catch {
    // Peer will hit the 30 s handshake timeout if abort delivery fails.
  }
}

// Derives the SPAKE2 password scalar `w` from a base64url-encoded token.
async function derivePasswordScalar(pakeToken: string): Promise<bigint> {
  // HKDF over 48 bytes reduces the bias from the mod-reduction to < 2^-128.
  const expanded = await hkdfDerive(
    fromBase64Url(pakeToken),
    "psilink-spake2-password-v1",
    48,
  );
  const n = expanded.reduce(
    (acc: bigint, b: number) => (acc << 8n) | BigInt(b),
    0n,
  );
  // Map to [1, ORDER-1].
  return (n % (ORDER - 1n)) + 1n;
}

// Serializes a 256-bit scalar (bigint) as a 32-byte big-endian buffer.
function scalarToBytes(s: bigint): Uint8Array<ArrayBuffer> {
  return hexToBytes(s.toString(16).padStart(64, "0"));
}

// Generates a cryptographically random scalar in [1, ORDER-1].
function randomScalar(): bigint {
  // Use 48 bytes to avoid bias from mod-reduction over the 256-bit order.
  const raw = new Uint8Array(48);
  crypto.getRandomValues(raw);
  const n = raw.reduce((acc: bigint, b: number) => (acc << 8n) | BigInt(b), 0n);
  return (n % (ORDER - 1n)) + 1n;
}

/**
 * Derive the two SPAKE2 output keys (`Ka` for confirmation, `Ke` for session
 * use) from the protocol transcript.
 *
 * Transcript format follows RFC 9382 §3.3
 * (https://www.rfc-editor.org/rfc/rfc9382): each element is length-prefixed
 * with an 8-byte little-endian integer.  The final field `w` is the password
 * scalar serialized as a 32-byte big-endian integer, which is the encoding
 * RFC 9382 §3.3 specifies.  See `PROTOCOL.md` §"Key derivation" for the
 * interoperability note on M and N.
 *
 * Deviation from RFC 9382 §3.4: instead of SHA-256-hashing the transcript
 * and splitting as `Ka||Ke`, each key is derived directly from the transcript
 * via HKDF-SHA-256 (info strings `"psilink-spake2-ka-v1"` and
 * `"psilink-spake2-ke-v1"`), expanding to 32 bytes each.
 */
async function deriveKeys(
  T: Uint8Array<ArrayBuffer>,
  S: Uint8Array<ArrayBuffer>,
  K: Uint8Array<ArrayBuffer>,
  w: bigint,
): Promise<{ ka: Uint8Array<ArrayBuffer>; ke: Uint8Array<ArrayBuffer> }> {
  const wBytes = scalarToBytes(w);
  const TT = concat(
    encodeLen(A_ID),
    A_ID,
    encodeLen(B_ID),
    B_ID,
    encodeLen(T),
    T,
    encodeLen(S),
    S,
    encodeLen(K),
    K,
    encodeLen(wBytes),
    wBytes,
  );
  const ka = await hkdfDerive(TT, "psilink-spake2-ka-v1", 32);
  const ke = await hkdfDerive(TT, "psilink-spake2-ke-v1", 32);
  return { ka, ke };
}

// --- Receive helper ----------------------------------------------------------

// 30 s is a generous ceiling for a single handshake round-trip on any
// realistic network; exceeding it almost certainly means the peer is gone.
const HANDSHAKE_TIMEOUT_MS = 30_000;

// Receive one handshake message, bounded by the 30 s handshake timeout. The
// connection's inbound queue buffers any frame that arrives before this call,
// so no listener pre-registration is needed to avoid a race with a fast peer.
//
// A transport-kind ConnectionError (the timeout firing, or the peer dropping
// the connection) is re-thrown as the distinct "PAKE handshake timed out"
// error and never triggers an abort: the peer is already gone, so there is no
// one left to notify.
async function receiveHandshake(conn: MessageConnection): Promise<unknown> {
  try {
    return await conn.receive(HANDSHAKE_TIMEOUT_MS);
  } catch (e) {
    if (e instanceof ConnectionError && e.kind === "transport") {
      throw new Error("PAKE handshake timed out", { cause: e });
    }
    throw e;
  }
}

// --- SPAKE2 result -----------------------------------------------------------

/**
 * Result of a completed SPAKE2 handshake.
 *
 * `sessionKey` is the 32-byte Ke from the SPAKE2 transcript, suitable for
 * passing to `deriveAeadKey` (exported from `./auth.ts`) to derive a channel
 * encryption key. Both parties hold the same value after a successful
 * handshake.
 */
export interface Spake2Result {
  /** 32-byte SPAKE2 session key (Ke). */
  sessionKey: Uint8Array<ArrayBuffer>;
}

// --- Protocol ----------------------------------------------------------------

/**
 * Executes a 3-message SPAKE2 handshake over an established connection.
 *
 * Message flow (initiator sends first throughout):
 *   1. Initiator -> Responder : `{ pakeMsg: "1", point: T }`
 *   2. Responder -> Initiator : `{ pakeMsg: "2", point: S, mac: MAC_B }`
 *   3. Initiator -> Responder : `{ pakeMsg: "3", mac: MAC_A }` or
 *      `{ pakeMsg: "abort" }`
 *
 * `MAC_A` and `MAC_B` are HMAC-SHA-256 under the confirmation key `Ka`
 * derived from the SPAKE2 transcript.  The connection's inbound queue buffers
 * any frame that arrives before this side is ready to read it, so a fast peer
 * cannot race ahead of a receive.  If the initiator finds `MAC_B` invalid it
 * sends an abort so the responder is not left waiting for msg3.
 *
 * For most callers, prefer `authenticateConnection` (from `auth.ts`),
 * which adds token-format validation, expiry checking, and token rotation on
 * top of this primitive.
 *
 * `pakeToken` is assumed to satisfy `PAKE_TOKEN_REGEX` (43 base64url
 * characters encoding 32 bytes). It is decoded directly without normalization,
 * so a malformed token surfaces as the underlying `fromBase64Url` error rather
 * than the generic `"PAKE authentication failed"` — callers using runSpake2
 * directly are responsible for validating the token before passing it in.
 *
 * @throws {Error} with message `"PAKE authentication failed"` on any
 *   authentication failure.  The message is intentionally generic to avoid
 *   hinting at which specific check failed.
 * @throws {Error} with message `"PAKE handshake timed out"` if a peer does not
 *   respond within 30 seconds.
 */
export async function runSpake2(
  conn: MessageConnection,
  handshakeRole: HandshakeRole,
  pakeToken: string,
): Promise<Spake2Result> {
  if (handshakeRole === "initiator") {
    // Initiator uses blinding point M (RFC 9382 §3.2).
    const w = await derivePasswordScalar(pakeToken);
    const x = randomScalar();
    const T = M.multiply(w).add(p256.Point.BASE.multiply(x));
    const T_bytes = hexToBytes(T.toHex(true));

    // Message 1: send blinded ephemeral point.
    await conn.send({
      pakeMsg: "1",
      point: toBase64Url(T_bytes),
    } satisfies Spake2Msg1);

    // Message 2: receive responder's point + MAC_B.
    // Every failure path below sends an abort so the responder stops waiting
    // for msg3 immediately rather than blocking until the 30 s handshake
    // timeout. Aborts are best-effort: see sendAbort() for the rationale.
    const msg2 = Spake2Msg2Schema.safeParse(await receiveHandshake(conn));
    if (!msg2.success) {
      await sendAbort(conn);
      throw new Error("PAKE authentication failed");
    }
    let S_bytes;
    try {
      S_bytes = fromBase64Url(msg2.data.point);
    } catch {
      await sendAbort(conn);
      throw new Error("PAKE authentication failed");
    }
    if (S_bytes.length !== 33) {
      await sendAbort(conn);
      throw new Error("PAKE authentication failed");
    }

    let S;
    try {
      S = p256.Point.fromHex(bytesToHex(S_bytes));
    } catch {
      await sendAbort(conn);
      throw new Error("PAKE authentication failed");
    }
    const K_bytes = hexToBytes(
      S.subtract(N.multiply(w)).multiply(x).toHex(true),
    );

    const { ka, ke } = await deriveKeys(T_bytes, S_bytes, K_bytes, w);

    let receivedMacB;
    try {
      receivedMacB = fromBase64Url(msg2.data.mac);
    } catch {
      await sendAbort(conn);
      throw new Error("PAKE authentication failed");
    }
    const expectedMacB = await hmacSha256(
      ka,
      enc.encode("psilink-spake2-confirm-B"),
    );
    if (!bytesEqual(receivedMacB, expectedMacB)) {
      // Send abort so the responder is not left waiting for msg3.
      await sendAbort(conn);
      throw new Error("PAKE authentication failed");
    }

    // Message 3: send MAC_A.
    const macA = await hmacSha256(ka, enc.encode("psilink-spake2-confirm-A"));
    await conn.send({
      pakeMsg: "3",
      mac: toBase64Url(macA),
    } satisfies Spake2Msg3);

    return { sessionKey: ke };
  } else {
    // Responder uses blinding point N (RFC 9382 §3.2).
    const w = await derivePasswordScalar(pakeToken);
    const x = randomScalar();
    const S = N.multiply(w).add(p256.Point.BASE.multiply(x));
    const S_bytes = hexToBytes(S.toHex(true));

    // Message 1: receive initiator's point.
    // Every failure path below sends an abort so the initiator stops waiting
    // for msg2 immediately rather than blocking until the 30 s handshake
    // timeout. Aborts are best-effort: see sendAbort() for the rationale.
    const msg1 = Spake2Msg1Schema.safeParse(await receiveHandshake(conn));
    if (!msg1.success) {
      await sendAbort(conn);
      throw new Error("PAKE authentication failed");
    }
    let T_bytes;
    try {
      T_bytes = fromBase64Url(msg1.data.point);
    } catch {
      await sendAbort(conn);
      throw new Error("PAKE authentication failed");
    }
    if (T_bytes.length !== 33) {
      await sendAbort(conn);
      throw new Error("PAKE authentication failed");
    }

    let T;
    try {
      T = p256.Point.fromHex(bytesToHex(T_bytes));
    } catch {
      await sendAbort(conn);
      throw new Error("PAKE authentication failed");
    }
    const K_bytes = hexToBytes(
      T.subtract(M.multiply(w)).multiply(x).toHex(true),
    );

    const { ka, ke } = await deriveKeys(T_bytes, S_bytes, K_bytes, w);

    const macB = await hmacSha256(ka, enc.encode("psilink-spake2-confirm-B"));

    // Message 2: send point + MAC_B.
    await conn.send({
      pakeMsg: "2",
      point: toBase64Url(S_bytes),
      mac: toBase64Url(macB),
    } satisfies Spake2Msg2);

    // Message 3: receive and verify MAC_A (or abort from initiator). No
    // abort is sent on failure: msg3 is the last message in the protocol,
    // so the initiator has already moved on regardless of the outcome here.
    const msg3 = z
      .union([Spake2Msg3Schema, Spake2AbortSchema])
      .safeParse(await receiveHandshake(conn));
    if (!msg3.success || msg3.data.pakeMsg !== "3") {
      throw new Error("PAKE authentication failed");
    }
    let receivedMacA;
    try {
      receivedMacA = fromBase64Url(msg3.data.mac);
    } catch {
      throw new Error("PAKE authentication failed");
    }
    const expectedMacA = await hmacSha256(
      ka,
      enc.encode("psilink-spake2-confirm-A"),
    );
    if (!bytesEqual(receivedMacA, expectedMacA)) {
      throw new Error("PAKE authentication failed");
    }

    return { sessionKey: ke };
  }
}
