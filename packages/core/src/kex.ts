import { z } from "zod";
import { x25519 } from "@noble/curves/ed25519.js";

import {
  enc,
  toBase64Url,
  fromBase64Url,
  bytesEqual,
  hmacSha256,
  sha256,
  hkdfDerive,
} from "./utils/crypto.js";
import type { HandshakeRole } from "./types.js";
import {
  ConnectionError,
  type MessageConnection,
} from "./connection/messageConnection.js";

// Authenticated key exchange that replaces SPAKE2 as the source of the exchange
// session key. It is an ephemeral X25519 Diffie-Hellman pinned to the Noise
// NNpsk0 pattern (no static keys, the pre-shared secret mixed at position 0,
// ephemeral-ephemeral DH) plus an explicit, role-asymmetric mutual key
// confirmation. The X25519 primitive and the ephemeral keygen come from the
// audited @noble/curves library (already a dependency); only the minimal NNpsk0
// glue -- the key-schedule mixing and the two confirmation tags -- is written
// here. The full Noise framework is deliberately NOT implemented. The
// construction is modeled on NNpsk0 and pinned by the checked-in known-answer
// vector (test/vectors/kex-vectors.json) rather than wire-compatible with
// generic Noise. See docs/SECURITY_DESIGN.md ("Key-agreement design") and
// docs/PROTOCOL.md ("X25519 authenticated key exchange").

// X25519 public keys and the pre-shared secret are fixed 32-byte values
// (RFC 7748; the psk is psk0, which Noise mandates be 32 bytes).
const X25519_KEY_LEN = 32;
const PSK_LEN = 32;

// Protocol-version tag. It is the Noise "protocol name" hashed into the initial
// handshake hash, so it is part of the transcript covered by every derived key
// and every confirmation tag. A future authenticated mode (e.g. a
// certificate-chain variant) is an additive new version selected out-of-band:
// bumping this string makes a mismatched peer derive a different transcript and
// fail closed. See docs/SECURITY_DESIGN.md ("Key-agreement design").
const PROTOCOL_NAME = "psilink-kex-v1:NNpsk0_25519_SHA256";

// Domain-separation labels, all namespaced under psilink-kex-v1: and disjoint
// from every other label in the system (psilink-spake2-*, psilink-aead-v1:*,
// psilink-token-rotation-v1, the psilink-signing-* labels). The two confirm
// labels are role-asymmetric: each side sends the tag for its own role and
// verifies the tag for the opposite role, so a reflected/echoed confirmation
// does not verify.
const SESSION_LABEL = "psilink-kex-v1:session";
const CONFIRM_KEY_LABEL = "psilink-kex-v1:confirm";
const INITIATOR_CONFIRM_LABEL = "psilink-kex-v1:initiator-confirm";
const RESPONDER_CONFIRM_LABEL = "psilink-kex-v1:responder-confirm";

// Single generic failure message for every authentication failure. Kept
// non-oracular on purpose: it must not hint at which check failed (a malformed
// share, a contributory-check rejection, or a confirmation mismatch all look
// identical to the peer). Mirrors SPAKE2's "PAKE authentication failed".
//
// "Non-oracular" refers to the error and to the absence of any secret-dependent
// branch: the only comparison against secret-derived material is the
// constant-time bytesEqual on the confirmation tag, and the key schedule runs
// identically regardless of the psk's value. A peer can still distinguish, by
// wall-clock timing, a failure before computeKexKeys (bad parse/share) from one
// after it (tag mismatch), but that split is a function of the peer's own
// (attacker-authored) input, not of any secret, so it leaks nothing.
const GENERIC_FAILURE = "key exchange authentication failed";
const TIMEOUT_FAILURE = "key exchange handshake timed out";

// 30 s is a generous ceiling for a single handshake round-trip on any realistic
// network; exceeding it almost certainly means the peer is gone. Matches the
// SPAKE2 handshake timeout.
const HANDSHAKE_TIMEOUT_MS = 30_000;

const EMPTY = new Uint8Array(0);

// --- Wire message schemas ----------------------------------------------------
//
// All schemas use `.strict()` so extra keys cause a parse failure rather than
// being silently stripped. A message arriving with unexpected fields indicates
// either a peer bug or a malicious actor fuzzing the parser, and either case
// should fail fast. `e` is a base64url-encoded 32-byte X25519 public key;
// `confirm` is a base64url-encoded 32-byte HMAC-SHA-256 tag.

interface KexMsg1 {
  kexMsg: "1";
  e: string;
}

const KexMsg1Schema: z.ZodType<KexMsg1> = z
  .object({
    kexMsg: z.literal("1"),
    e: z.string(),
  })
  .strict();

interface KexMsg2 {
  kexMsg: "2";
  e: string;
  confirm: string;
}

const KexMsg2Schema: z.ZodType<KexMsg2> = z
  .object({
    kexMsg: z.literal("2"),
    e: z.string(),
    confirm: z.string(),
  })
  .strict();

interface KexMsg3 {
  kexMsg: "3";
  confirm: string;
}

const KexMsg3Schema: z.ZodType<KexMsg3> = z
  .object({
    kexMsg: z.literal("3"),
    confirm: z.string(),
  })
  .strict();

interface KexAbort {
  kexMsg: "abort";
}

const KexAbortSchema: z.ZodType<KexAbort> = z
  .object({
    kexMsg: z.literal("abort"),
  })
  .strict();

// --- Byte helpers ------------------------------------------------------------

function concatBytes(
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

// noble returns a plain Uint8Array; normalize to the ArrayBuffer-backed type the
// crypto helpers are typed against (and defensively copy off any pooled buffer).
function toBytes(u: Uint8Array): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(u);
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> | undefined {
  try {
    return fromBase64Url(value);
  } catch {
    return undefined;
  }
}

// --- Noise NNpsk0 symmetric state --------------------------------------------
//
// The minimal subset of Noise's SymmetricState needed for NNpsk0: a chaining
// key `ck` and a handshake hash `h`, with MixHash / MixKey / MixKeyAndHash.
// There is no CipherState: NNpsk0's handshake messages carry no encrypted
// payload here, so the symmetric cipher half of Noise is omitted entirely.

interface SymmetricState {
  ck: Uint8Array<ArrayBuffer>;
  h: Uint8Array<ArrayBuffer>;
}

/**
 * HKDF as defined by the Noise Protocol Framework (rev 34, section 4.3): a
 * chaining HKDF keyed by the running chaining key. Equivalent to RFC 5869
 * HKDF-Extract(salt = ck, ikm) followed by HKDF-Expand with an empty info
 * string, returning `numOutputs` 32-byte blocks. This differs from the
 * application-level {@link hkdfDerive} (zero salt, named info) on purpose: the
 * Noise key schedule chains the salt. Cross-checked against RFC 5869 test
 * case 3 in kex.test.ts.
 *
 * @internal exported only for the RFC 5869 cross-check test.
 */
export async function noiseHkdf(
  ck: Uint8Array<ArrayBuffer>,
  ikm: Uint8Array<ArrayBuffer>,
  numOutputs: 2 | 3,
): Promise<Array<Uint8Array<ArrayBuffer>>> {
  const tempKey = await hmacSha256(ck, ikm);
  const o1 = await hmacSha256(tempKey, Uint8Array.of(1));
  const o2 = await hmacSha256(tempKey, concatBytes(o1, Uint8Array.of(2)));
  if (numOutputs === 2) return [o1, o2];
  const o3 = await hmacSha256(tempKey, concatBytes(o2, Uint8Array.of(3)));
  return [o1, o2, o3];
}

async function initializeSymmetric(): Promise<SymmetricState> {
  // Noise InitializeSymmetric: for a protocol name longer than the hash length
  // (PROTOCOL_NAME is 34 bytes > 32) h = HASH(name); ck = h. The name-padding
  // branch for <=32-byte names is unused here.
  const h = await sha256(enc.encode(PROTOCOL_NAME));
  // Noise sets ck = h here. Keep them as distinct buffers (not one shared
  // reference) so a future in-place mutation of one could never corrupt the
  // other; their values are identical at init regardless.
  return { ck: Uint8Array.from(h), h };
}

async function mixHash(
  s: SymmetricState,
  data: Uint8Array<ArrayBuffer>,
): Promise<void> {
  s.h = await sha256(concatBytes(s.h, data));
}

async function mixKey(
  s: SymmetricState,
  ikm: Uint8Array<ArrayBuffer>,
): Promise<void> {
  // ck, temp_k = HKDF(ck, ikm, 2); temp_k (the cipher key) is unused.
  const [ck] = await noiseHkdf(s.ck, ikm, 2);
  s.ck = ck;
}

async function mixKeyAndHash(
  s: SymmetricState,
  ikm: Uint8Array<ArrayBuffer>,
): Promise<void> {
  // ck, temp_h, temp_k = HKDF(ck, ikm, 3); MixHash(temp_h). The third output
  // (temp_k, the CipherState key) is unused here but still requested so this
  // matches the Noise MixKeyAndHash definition verbatim; the extra HMAC is
  // negligible next to the X25519 scalar multiplication.
  const [ck, tempH] = await noiseHkdf(s.ck, ikm, 3);
  s.ck = ck;
  await mixHash(s, tempH);
}

// --- Key schedule + confirmation ---------------------------------------------

/**
 * The pure NNpsk0 key schedule and key-confirmation derivation. Both peers call
 * this with identical arguments after the ephemeral exchange and obtain
 * identical outputs.
 *
 * The NNpsk0 token sequence (`-> psk, e` / `<- e, ee`, empty prologue) folds the
 * pre-shared secret in at position 0 (MixKeyAndHash), both ephemeral public keys
 * (in PSK mode each `e` token is MixHash + MixKey, in initiator-then-responder
 * order), and the ephemeral-ephemeral DH output (MixKey). The session key and a
 * distinct confirmation key are then
 * derived over BOTH the resulting chaining key `ck` (which carries the psk and
 * the X25519 DH output) AND the handshake hash `h` (which carries the
 * protocol-version tag and both ephemeral public keys in role order). Deriving
 * from ck||h is the load-bearing invariant: the session key depends on the
 * X25519 output, so it is neither the pre-shared secret alone (which would have
 * no forward secrecy) nor the raw DH output alone (which would not be
 * transcript-bound). SP 800-56A Rev. 3 section 5.8.1 (KDF over the shared secret
 * plus FixedInfo) and section 5.9 / 6.2.1.5 (key confirmation).
 *
 * @internal exported only for the known-answer-vector and RFC cross-check tests.
 */
export async function computeKexKeys(
  psk: Uint8Array<ArrayBuffer>,
  initiatorEphemeralPublic: Uint8Array<ArrayBuffer>,
  responderEphemeralPublic: Uint8Array<ArrayBuffer>,
  dhSharedSecret: Uint8Array<ArrayBuffer>,
): Promise<{
  sessionKey: Uint8Array<ArrayBuffer>;
  confirmKey: Uint8Array<ArrayBuffer>;
  initiatorConfirm: Uint8Array<ArrayBuffer>;
  responderConfirm: Uint8Array<ArrayBuffer>;
  handshakeHash: Uint8Array<ArrayBuffer>;
  chainingKey: Uint8Array<ArrayBuffer>;
}> {
  const s = await initializeSymmetric();
  // NNpsk0 token sequence: -> psk, e ; <- e, ee. Empty prologue.
  //
  // In a PSK handshake Noise (rev 34 section 9.2) processes every `e` token with
  // MixKey(e.public) IN ADDITION to MixHash(e.public): the ephemeral publics are
  // folded into the chaining key, not only the hash. We do both, so this is
  // faithful NNpsk0. (MixHash touches only h and MixKey only ck -- disjoint
  // state -- so their order within an `e` token is immaterial; the ck-chain
  // order psk -> e_i -> e_r -> ee is what matters and is preserved here.)
  await mixHash(s, EMPTY);
  await mixKeyAndHash(s, psk); // psk token at position 0
  await mixHash(s, initiatorEphemeralPublic); // initiator e: MixHash
  await mixKey(s, initiatorEphemeralPublic); //              and MixKey (PSK mode)
  await mixHash(s, responderEphemeralPublic); // responder e: MixHash
  await mixKey(s, responderEphemeralPublic); //              and MixKey (PSK mode)
  await mixKey(s, dhSharedSecret); // ee

  const master = concatBytes(s.ck, s.h);
  const sessionKey = await hkdfDerive(master, SESSION_LABEL, 32);
  // Confirmation key is derived from ck alone under a distinct label, so it is
  // independent of the session key. It deliberately does NOT fold in h the way
  // the session key (ck||h) does: the confirmation tags below bind the
  // transcript hash h explicitly in the HMAC message, so the tags are fully
  // transcript-bound without h also entering the key.
  const confirmKey = await hkdfDerive(s.ck, CONFIRM_KEY_LABEL, 32);
  const initiatorConfirm = await hmacSha256(
    confirmKey,
    concatBytes(enc.encode(INITIATOR_CONFIRM_LABEL), s.h),
  );
  const responderConfirm = await hmacSha256(
    confirmKey,
    concatBytes(enc.encode(RESPONDER_CONFIRM_LABEL), s.h),
  );
  return {
    sessionKey,
    confirmKey,
    initiatorConfirm,
    responderConfirm,
    handshakeHash: s.h,
    chainingKey: s.ck,
  };
}

// Computes the X25519 shared secret, returning undefined on any failure so the
// caller can apply its uniform abort-and-fail handling. noble's getSharedSecret
// already rejects low-order / non-canonical peer shares by throwing (RFC 7748,
// the contributory check), so that check is enforced by the audited library
// rather than hand-rolled. The explicit all-zero guard is defense in depth: it
// would catch a future primitive swap that returned a raw zero instead of
// throwing. The compare is constant-time to avoid leaking via timing.
//
// `mySecret` is typed as a plain Uint8Array (not Uint8Array<ArrayBuffer>)
// because it receives noble's x25519.keygen().secretKey directly, avoiding a
// defensive copy of secret key material; it only feeds getSharedSecret. The
// ephemeral secret is not zeroized after use: JS offers no reliable
// zeroization (GC, copies), and the key is single-use per handshake, so the
// residual-memory exposure is an accepted limitation (as in pake.ts).
function deriveSharedSecret(
  mySecret: Uint8Array,
  peerPublic: Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> | undefined {
  let ss: Uint8Array;
  try {
    ss = x25519.getSharedSecret(mySecret, peerPublic);
  } catch {
    return undefined;
  }
  const out = toBytes(ss);
  // Compare against a freshly allocated zero buffer rather than a shared
  // module-level sentinel, so no in-place mutation could ever weaken the check.
  if (bytesEqual(out, new Uint8Array(X25519_KEY_LEN))) return undefined;
  return out;
}

// --- Receive / abort helpers -------------------------------------------------

// Best-effort abort signal: if the peer is still waiting for our next message,
// telling them to give up shortens their recovery from the 30 s handshake
// timeout to immediately. A failure to send the abort is non-fatal -- the peer
// will time out on its own -- so the send error is swallowed.
async function sendAbort(conn: MessageConnection): Promise<void> {
  try {
    await conn.send({ kexMsg: "abort" } satisfies KexAbort);
  } catch {
    // Peer will hit the 30 s handshake timeout if abort delivery fails.
  }
}

// Receive one handshake message, bounded by the 30 s handshake timeout. A
// transport-kind ConnectionError (the timeout firing, or the peer dropping the
// connection) is re-thrown as the distinct timeout error and never triggers an
// abort: the peer is already gone, so there is no one left to notify.
async function receiveHandshake(conn: MessageConnection): Promise<unknown> {
  try {
    return await conn.receive(HANDSHAKE_TIMEOUT_MS);
  } catch (e) {
    if (e instanceof ConnectionError && e.kind === "transport") {
      throw new Error(TIMEOUT_FAILURE, { cause: e });
    }
    throw e;
  }
}

// --- Result ------------------------------------------------------------------

/**
 * Result of a completed X25519 key exchange.
 *
 * `sessionKey` is a 32-byte key suitable for passing to `deriveAeadKey`
 * (exported from `./auth.ts`) to derive channel encryption keys, and to the
 * token-rotation HKDF. Both parties hold the same value after a successful
 * handshake. It has forward secrecy (it mixes a fresh ephemeral X25519 DH) and
 * is mutually authenticated by the pre-shared secret.
 */
export interface KexResult {
  /** 32-byte session key. */
  sessionKey: Uint8Array<ArrayBuffer>;
}

// --- Protocol ----------------------------------------------------------------

/**
 * Executes a 3-message authenticated X25519 key exchange over an established
 * connection.
 *
 * Message flow (initiator sends first throughout):
 *   1. Initiator -> Responder : `{ kexMsg: "1", e: e_I }`
 *   2. Responder -> Initiator : `{ kexMsg: "2", e: e_R, confirm: MAC_R }`
 *   3. Initiator -> Responder : `{ kexMsg: "3", confirm: MAC_I }` or
 *      `{ kexMsg: "abort" }`
 *
 * `e_I` and `e_R` are base64url-encoded 32-byte ephemeral X25519 public keys,
 * generated via the library keygen. `MAC_R` and `MAC_I` are the role-asymmetric
 * confirmation tags (HMAC-SHA-256 under the confirmation key, binding the
 * handshake transcript). The responder confirms first (in msg2); the initiator
 * verifies it before sending its own confirmation in msg3, so a mismatched
 * pre-shared secret fails closed before any non-handshake frame is sent. The
 * connection's inbound queue buffers any frame that arrives before this side is
 * ready to read it, so a fast peer cannot race ahead of a receive.
 *
 * The construction is Noise NNpsk0 over X25519 plus an explicit key
 * confirmation, following NIST SP 800-56A; the DH is a @noble/curves call, not
 * hand-rolled curve math. See the module header and docs/PROTOCOL.md.
 *
 * `psk` is the raw 32-byte pre-shared secret. Callers holding a base64url token
 * decode it to bytes first (a wrong length is a caller error, thrown
 * synchronously before any network activity).
 *
 * `handshakeRole` is assigned out of band by the caller (as in `runSpake2`); it
 * is not negotiated in-band. Two peers that both pass `"initiator"` reject each
 * other (the second message fails the opposite schema) and two `"responder"`s
 * deadlock on receive -- neither yields a false session.
 *
 * @throws {Error} `"key exchange authentication failed"` on any authentication
 *   failure. The message is intentionally generic to avoid hinting at which
 *   specific check failed.
 * @throws {Error} `"key exchange handshake timed out"` if a peer does not
 *   respond within 30 seconds.
 * @throws {Error} if `psk` is not 32 bytes. Because `runKex` is async this
 *   surfaces as a rejected promise (before any network activity), not a
 *   synchronous throw, so callers must `await` or `.catch` it.
 * @throws {ConnectionError} unchanged if the connection terminates for a
 *   non-transport reason (e.g. a deliberate local {@link MessageConnection.close}
 *   during the handshake). Such a close is deliberately not masked as an
 *   authentication failure, matching `runSpake2`.
 */
export async function runKex(
  conn: MessageConnection,
  handshakeRole: HandshakeRole,
  psk: Uint8Array<ArrayBuffer>,
): Promise<KexResult> {
  if (psk.length !== PSK_LEN) {
    throw new Error(`runKex: psk must be ${PSK_LEN} bytes, got ${psk.length}`);
  }

  const ephemeral = x25519.keygen();
  const myPublic = toBytes(ephemeral.publicKey);
  const mySecret = ephemeral.secretKey;

  if (handshakeRole === "initiator") {
    // Message 1: send our ephemeral public key.
    await conn.send({
      kexMsg: "1",
      e: toBase64Url(myPublic),
    } satisfies KexMsg1);

    // Message 2: receive responder's ephemeral + confirmation.
    // Every failure path below sends an abort so the responder stops waiting
    // immediately rather than blocking until the 30 s handshake timeout.
    const msg2 = KexMsg2Schema.safeParse(await receiveHandshake(conn));
    if (!msg2.success) {
      await sendAbort(conn);
      throw new Error(GENERIC_FAILURE);
    }
    const peerPublic = decodeBase64Url(msg2.data.e);
    if (peerPublic === undefined || peerPublic.length !== X25519_KEY_LEN) {
      await sendAbort(conn);
      throw new Error(GENERIC_FAILURE);
    }
    const dh = deriveSharedSecret(mySecret, peerPublic);
    if (dh === undefined) {
      await sendAbort(conn);
      throw new Error(GENERIC_FAILURE);
    }
    const { sessionKey, initiatorConfirm, responderConfirm } =
      await computeKexKeys(psk, myPublic, peerPublic, dh);

    // No explicit length check on the decoded tag: bytesEqual is total and
    // returns false on any length mismatch (unlike the public key above, whose
    // length must be 32 before it feeds the DH).
    const receivedConfirm = decodeBase64Url(msg2.data.confirm);
    if (
      receivedConfirm === undefined ||
      !bytesEqual(receivedConfirm, responderConfirm)
    ) {
      await sendAbort(conn);
      throw new Error(GENERIC_FAILURE);
    }

    // Message 3: send our confirmation.
    await conn.send({
      kexMsg: "3",
      confirm: toBase64Url(initiatorConfirm),
    } satisfies KexMsg3);

    return { sessionKey };
  } else {
    // Message 1: receive initiator's ephemeral public key.
    // Every failure path below sends an abort so the initiator stops waiting.
    const msg1 = KexMsg1Schema.safeParse(await receiveHandshake(conn));
    if (!msg1.success) {
      await sendAbort(conn);
      throw new Error(GENERIC_FAILURE);
    }
    const peerPublic = decodeBase64Url(msg1.data.e);
    if (peerPublic === undefined || peerPublic.length !== X25519_KEY_LEN) {
      await sendAbort(conn);
      throw new Error(GENERIC_FAILURE);
    }
    const dh = deriveSharedSecret(mySecret, peerPublic);
    if (dh === undefined) {
      await sendAbort(conn);
      throw new Error(GENERIC_FAILURE);
    }
    // peerPublic is the initiator's e; myPublic is the responder's e.
    const { sessionKey, initiatorConfirm, responderConfirm } =
      await computeKexKeys(psk, peerPublic, myPublic, dh);

    // Message 2: send our ephemeral + confirmation.
    await conn.send({
      kexMsg: "2",
      e: toBase64Url(myPublic),
      confirm: toBase64Url(responderConfirm),
    } satisfies KexMsg2);

    // Message 3: receive and verify the initiator's confirmation (or abort). No
    // abort is sent on failure: msg3 is the last message, so the initiator has
    // already moved on regardless of the outcome here.
    const msg3 = z
      .union([KexMsg3Schema, KexAbortSchema])
      .safeParse(await receiveHandshake(conn));
    // A legitimate abort (the initiator rejected our tag, e.g. on a psk
    // mismatch) is deliberately folded into the same generic failure as a
    // malformed or wrong msg3: from the responder's side it is an
    // authentication failure either way, and the initiator has already moved
    // on. This intentionally trades operator diagnosability for a single
    // non-oracular outcome, matching runSpake2.
    if (!msg3.success || msg3.data.kexMsg !== "3") {
      throw new Error(GENERIC_FAILURE);
    }
    // No explicit tag length check: bytesEqual is total (see msg2 above).
    const receivedConfirm = decodeBase64Url(msg3.data.confirm);
    if (
      receivedConfirm === undefined ||
      !bytesEqual(receivedConfirm, initiatorConfirm)
    ) {
      throw new Error(GENERIC_FAILURE);
    }

    return { sessionKey };
  }
}
