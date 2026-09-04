import { z } from "zod";

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
import { markPeerWaitTimeout } from "./errors.js";

// Authenticated key exchange that replaces SPAKE2 as the source of the exchange
// session key. It is an ephemeral P-256 Diffie-Hellman pinned to the Noise
// NNpsk0 pattern (no static keys, the pre-shared secret mixed at position 0,
// ephemeral-ephemeral DH) plus an explicit, role-asymmetric mutual key
// confirmation. Every cryptographic operation -- ephemeral key generation, the
// ECDH, the chaining HKDF, the application HKDF, SHA-256, and HMAC -- is a
// crypto.subtle call, so a validated module configured beneath the platform
// performs all of them; only the minimal NNpsk0 glue (the key-schedule mixing
// and the two confirmation tags) is written here. The full Noise framework is
// deliberately NOT implemented. The construction is modeled on NNpsk0 and
// pinned by the checked-in known-answer vector (test/vectors/kex-vectors.json)
// rather than wire-compatible with generic Noise. See docs/SECURITY_DESIGN.md
// ("Key-agreement design"), docs/spec/PROTOCOL.md ("P-256 authenticated key
// exchange"), and docs/notes/key-establishment-fips-boundary.md.

// The pre-shared secret is psk0, which Noise mandates be 32 bytes.
const PSK_LEN = 32;

// Wire encoding of an ephemeral public key: the SEC1 uncompressed point
// `0x04 || X || Y`, 65 bytes over P-256. This encoding is PINNED, not merely
// preferred, and pinning it is this module's job rather than importKey's. SEC1
// gives a point other than the identity exactly two encodings, uncompressed and
// compressed, and IEEE Std 1363-2000 (Annex E.2.3.2) admits a third, the hybrid
// form; crypto.subtle.importKey accepts more than the uncompressed one --
// driven against both platforms, Node admits the 33-byte compressed forms
// (0x02/0x03 || X) AND the 65-byte hybrid form (0x06/0x07 || X || Y) whose
// prefix parity agrees with Y, refusing the hybrid string whose prefix
// contradicts it, while Chromium refuses hybrid under either prefix and admits
// the compressed forms. Each re-exports what it admits as the same
// uncompressed point.
//
// Two consequences, either one sufficient. The wire bytes -- not the decoded
// point -- are what MixHash and MixKey fold into the transcript, so admitting a
// second encoding of one point would let an attacker re-encode a share in
// transit and desynchronize the two sides' transcripts. And the platforms
// disagree about which alternatives decode at all, so delegating the question
// would make a share's acceptance depend on which peer received it.
//
// Both checks are therefore applied to the raw share BEFORE import, and
// importPeerShare is the only path from wire bytes to a CryptoKey. kex.test.ts
// and the browser suite each drive importKey with the alternative encodings on
// their own platform, so the premise above is measured rather than assumed.
const PUBLIC_KEY_LEN = 65;
const UNCOMPRESSED_POINT_PREFIX = 0x04;

// SP 800-56A Rev 3 Z for P-256: the 32-byte X coordinate of the shared point,
// which is what crypto.subtle.deriveBits returns for ECDH over this curve.
const SHARED_SECRET_LEN = 32;

const ECDH_P256 = { name: "ECDH", namedCurve: "P-256" } as const;

// SHA-256 output length: the width of every chaining-key, handshake-hash, and
// confirmation-tag value, and the block size the Noise chaining HKDF counts in.
const HASH_LEN = 32;

// Protocol-version tag. It is the Noise "protocol name" hashed into the initial
// handshake hash, and ck0 = h0, so it is part of the transcript covered by every
// derived key and every confirmation tag: a peer on a different tag derives a
// different h and ck from the first step and fails the confirmation round, never
// reaching a usable session key. v2 names the cryptographic suite this file
// implements -- P-256 ECDH in place of X25519 -- and is deliberately
// wire-incompatible with a v1 peer. A future authenticated mode (e.g. a
// certificate-chain variant) is an additive new version selected out-of-band on
// the same mechanism. The version is reserved for a genuine cryptographic-suite
// change and is not bumped for an additive payload such as the
// request-encryption flag below: a flag-aware and a flag-unaware peer already
// fail closed at parse. The flag-aware side rejects a message that omits reqEnc
// by the schema's required-field check; an old flag-unaware side rejects a
// message that carries the (to it unknown) reqEnc key by its strict (.strict())
// schema. Either way the message is rejected before any transcript is computed.
// See docs/SECURITY_DESIGN.md ("Key-agreement design").
const PROTOCOL_NAME = "psilink-kex-v2:NNpsk0_P256_SHA256";

// Domain-separation labels, all namespaced under psilink-kex-v1: and disjoint
// from every other label in the system (psilink-aead-v1:*,
// psilink-shared-secret-rotation-v1, the psilink-signing-* labels). Their
// namespace version is independent of the suite version tag above and does not
// track it: the tag already separates one suite's transcript from another's
// totally (it seeds both h and ck), so re-versioning these labels would change
// derived bytes without separating anything the tag has not separated. The two
// confirm labels are role-asymmetric: each side sends the tag for its own role
// and verifies the tag for the opposite role, so a reflected/echoed confirmation
// does not verify.
const SESSION_LABEL = "psilink-kex-v1:session";
const CONFIRM_KEY_LABEL = "psilink-kex-v1:confirm";
const INITIATOR_CONFIRM_LABEL = "psilink-kex-v1:initiator-confirm";
const RESPONDER_CONFIRM_LABEL = "psilink-kex-v1:responder-confirm";

// Single generic failure message for every authentication failure. Kept
// non-oracular on purpose: it must not hint at which check failed (a malformed
// share, a contributory-check rejection, or a confirmation mismatch all look
// identical to the peer). Every site that throws it uses a ConnectionError of
// kind "security" -- the trust-boundary classification consumers key on (the
// web's exchange classifier, the CLI event stream) -- while the message stays
// this one generic string; the type carries the classification so the message
// never has to.
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
// network; exceeding it almost certainly means the peer is gone.
const HANDSHAKE_TIMEOUT_MS = 30_000;

const EMPTY = new Uint8Array(0);

// --- Wire message schemas ----------------------------------------------------
//
// All schemas use `.strict()` so extra keys cause a parse failure rather than
// being silently stripped. A message arriving with unexpected fields indicates
// either a peer bug or a malicious actor fuzzing the parser, and either case
// should fail fast. `e` is a base64url-encoded 65-byte uncompressed P-256 point;
// `confirm` is a base64url-encoded 32-byte HMAC-SHA-256 tag. `reqEnc` is this
// party's "request additional application-encryption layer" flag: it rides the
// party's own message (initiator's on msg1, responder's on msg2), is a required
// field (a flag-aware peer always sends it), and is bound into the transcript
// hash by computeKexKeys so tampering with it fails the handshake closed.

interface KexMsg1 {
  kexMsg: "1";
  e: string;
  reqEnc: boolean;
}

const KexMsg1Schema: z.ZodType<KexMsg1> = z
  .object({
    kexMsg: z.literal("1"),
    e: z.string(),
    reqEnc: z.boolean(),
  })
  .strict();

interface KexMsg2 {
  kexMsg: "2";
  e: string;
  confirm: string;
  reqEnc: boolean;
}

const KexMsg2Schema: z.ZodType<KexMsg2> = z
  .object({
    kexMsg: z.literal("2"),
    e: z.string(),
    confirm: z.string(),
    reqEnc: z.boolean(),
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

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> | undefined {
  try {
    return fromBase64Url(value);
  } catch {
    return undefined;
  }
}

// Canonical single-byte encoding of a party's request-encryption flag for the
// transcript hash: 0x01 when the party requests the additional
// application-encryption layer, 0x00 otherwise. Both implementations (this one
// and the independent vector generator) must agree on these bytes.
function flagByte(requested: boolean): Uint8Array<ArrayBuffer> {
  return Uint8Array.of(requested ? 1 : 0);
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
 * chaining HKDF keyed by the running chaining key, returning `numOutputs`
 * 32-byte blocks. Noise's definition -- `temp_key = HMAC(ck, ikm)` then
 * `output_i = HMAC(temp_key, output_{i-1} || byte(i))` -- is exactly RFC 5869
 * HKDF-Extract(salt = ck, ikm) followed by HKDF-Expand with an empty info
 * string, so it is issued as one `crypto.subtle` HKDF `deriveBits` call: the
 * extract-then-expand is a single operation the platform -- and any validated
 * module beneath it -- serves as a unit rather than a chain of HMAC calls
 * assembled here. This differs from the application-level {@link hkdfDerive}
 * (zero salt, named info) on purpose: the Noise key schedule chains the salt.
 * Cross-checked against RFC 5869 test case 3 in kex.test.ts.
 *
 * @internal exported only for the RFC 5869 cross-check test.
 */
export async function noiseHkdf(
  ck: Uint8Array<ArrayBuffer>,
  ikm: Uint8Array<ArrayBuffer>,
  numOutputs: 2 | 3,
): Promise<Array<Uint8Array<ArrayBuffer>>> {
  const key = await crypto.subtle.importKey(
    "raw",
    ikm,
    { name: "HKDF" },
    false,
    ["deriveBits"],
  );
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: ck, info: EMPTY },
      key,
      numOutputs * HASH_LEN * 8,
    ),
  );
  const blocks: Array<Uint8Array<ArrayBuffer>> = [];
  for (let i = 0; i < numOutputs; i++)
    blocks.push(bits.slice(i * HASH_LEN, (i + 1) * HASH_LEN));
  return blocks;
}

async function initializeSymmetric(): Promise<SymmetricState> {
  // Noise InitializeSymmetric: for a protocol name longer than the hash length
  // (PROTOCOL_NAME is 33 bytes > 32) h = HASH(name); ck = h. The name-padding
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
  // matches the Noise MixKeyAndHash definition verbatim; the extra block is
  // negligible next to the elliptic-curve scalar multiplication.
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
 * order), and the ephemeral-ephemeral DH output (MixKey). Each party's
 * request-encryption flag is MixHash'd as that message's handshake payload, right
 * after the party's `e` token (initiator's after e_initiator, responder's after
 * e_responder) -- MixHash only, since the flag need not be confidential. The
 * session key and a distinct confirmation key are then derived over BOTH the
 * resulting chaining key `ck` (which carries the psk and the ECDH shared
 * secret) AND the handshake hash `h` (which carries the protocol-version tag,
 * both ephemeral public keys in role order, and both request-encryption flags).
 * Deriving from ck||h is the load-bearing invariant: the session key depends on
 * the ECDH output, so it is neither the pre-shared secret alone (which would
 * have no forward secrecy) nor the raw DH output alone (which would not be
 * transcript-bound). SP 800-56A Rev. 3 section 5.8.1 (KDF over the shared secret
 * plus FixedInfo) and section 5.9 (key confirmation).
 *
 * The ephemeral public keys enter the schedule as their 65-byte wire encodings;
 * every length downstream is unchanged, since MixHash and MixKey both absorb
 * arbitrary-length input and the shared secret stays 32 bytes.
 *
 * The two flags enter `h` only (MixHash, not MixKey), so `ck` -- and therefore
 * the confirmation key derived from `ck` -- is independent of them; `h`, the
 * session key, and both confirmation tags depend on both flags. A flag tampered
 * with on the wire yields a different `h` on the two sides, so the role-asymmetric
 * confirmation tags mismatch and the handshake aborts rather than proceeding with
 * a disagreed-upon encryption decision.
 *
 * @internal exported only for the known-answer-vector and RFC cross-check tests.
 */
export async function computeKexKeys(
  psk: Uint8Array<ArrayBuffer>,
  initiatorEphemeralPublic: Uint8Array<ArrayBuffer>,
  responderEphemeralPublic: Uint8Array<ArrayBuffer>,
  dhSharedSecret: Uint8Array<ArrayBuffer>,
  initiatorRequestsEncryption: boolean,
  responderRequestsEncryption: boolean,
): Promise<{
  sessionKey: Uint8Array<ArrayBuffer>;
  confirmKey: Uint8Array<ArrayBuffer>;
  initiatorConfirm: Uint8Array<ArrayBuffer>;
  responderConfirm: Uint8Array<ArrayBuffer>;
  handshakeHash: Uint8Array<ArrayBuffer>;
  chainingKey: Uint8Array<ArrayBuffer>;
}> {
  const s = await initializeSymmetric();
  // NNpsk0 token sequence: -> psk, e ; <- e, ee. Empty prologue. Each message's
  // request-encryption flag is mixed in as that message's handshake payload,
  // right after its `e` token.
  //
  // In a PSK handshake Noise (rev 34 section 9.2) processes every `e` token with
  // MixKey(e.public) IN ADDITION to MixHash(e.public): the ephemeral publics are
  // folded into the chaining key, not only the hash. We do both, so this is
  // faithful NNpsk0. (MixHash touches only h and MixKey only ck -- disjoint
  // state -- so their order within an `e` token is immaterial; the ck-chain
  // order psk -> e_i -> e_r -> ee is what matters and is preserved here. The flag
  // MixHash'es likewise only touch h, so they commute with the surrounding MixKey
  // calls; the h-chain order e_i -> flag_i -> e_r -> flag_r is what is fixed.)
  await mixHash(s, EMPTY);
  await mixKeyAndHash(s, psk); // psk token at position 0
  await mixHash(s, initiatorEphemeralPublic); // initiator e: MixHash
  await mixKey(s, initiatorEphemeralPublic); //              and MixKey (PSK mode)
  await mixHash(s, flagByte(initiatorRequestsEncryption)); // msg1 payload: initiator flag
  await mixHash(s, responderEphemeralPublic); // responder e: MixHash
  await mixKey(s, responderEphemeralPublic); //              and MixKey (PSK mode)
  await mixHash(s, flagByte(responderRequestsEncryption)); // msg2 payload: responder flag
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

// --- P-256 ECDH --------------------------------------------------------------

// A fresh ephemeral P-256 key pair. `extractable: false` applies to the private
// key only (WebCrypto always marks a generated public key extractable), so the
// ephemeral secret never becomes JavaScript-visible bytes at all -- it stays a
// platform key handle, inside a validated module where one is configured, and
// the residual-memory question the raw-bytes form raised does not arise for it.
// The public key is exported raw, which for P-256 is the 65-byte uncompressed
// point that goes on the wire.
async function generateEphemeral(): Promise<{
  privateKey: CryptoKey;
  publicKey: Uint8Array<ArrayBuffer>;
}> {
  const pair = await crypto.subtle.generateKey(ECDH_P256, false, [
    "deriveBits",
  ]);
  const publicKey = new Uint8Array(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  );
  return { privateKey: pair.privateKey, publicKey };
}

// The single path from peer-supplied wire bytes to a usable public key,
// returning undefined on every rejection so the caller applies its uniform
// abort-and-fail handling. Two layers, in this order:
//
//  1. The pinned canonical encoding: exactly 65 bytes with the uncompressed
//     0x04 prefix. This is ours to enforce, because importKey also decodes
//     other encodings of the same point, and not the same set of them on every
//     platform (see the PUBLIC_KEY_LEN comment), while the transcript folds in
//     the wire bytes.
//  2. Point validity: importKey itself. Driven against both platforms, it
//     rejects a point not on the curve, a coordinate at or above the field
//     prime, and both byte strings a peer might send for the identity: SEC1's
//     single 0x00 octet, which is the only encoding it gives the point at
//     infinity, and the all-zero uncompressed string, which SEC1 reads as the
//     off-curve point (0, 0) rather than as the identity. P-256 has
//     cofactor 1, so there is no small-order subgroup for a low-order share to
//     land in and the identity is the whole of the degenerate case. kex.test.ts
//     and the browser suite assert each of these rejections against the real
//     crypto.subtle rather than an assumed one.
async function importPeerShare(
  share: Uint8Array<ArrayBuffer>,
): Promise<CryptoKey | undefined> {
  if (share.length !== PUBLIC_KEY_LEN || share[0] !== UNCOMPRESSED_POINT_PREFIX)
    return undefined;
  try {
    return await crypto.subtle.importKey("raw", share, ECDH_P256, false, []);
  } catch {
    return undefined;
  }
}

// Computes the ECDH shared secret (SP 800-56A Rev 3 Z, the shared point's X
// coordinate), returning undefined on any failure.
//
// The all-zero result guard is a backstop, not the validation: on a cofactor-1
// curve an all-zero Z means the shared point was the identity, which requires a
// peer share importPeerShare has already rejected. It is retained because that
// rejection is a measured platform behavior rather than one this project
// controls -- a platform that admitted the identity point would otherwise hand
// back a shared secret both parties' attacker knows, silently costing the
// handshake its forward secrecy. The compare is constant-time, and is against a
// freshly allocated zero buffer rather than a module-level sentinel so no
// in-place mutation could weaken it.
async function deriveSharedSecret(
  myPrivate: CryptoKey,
  peerPublic: CryptoKey,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  let bits: ArrayBuffer;
  try {
    bits = await crypto.subtle.deriveBits(
      { name: "ECDH", public: peerPublic },
      myPrivate,
      SHARED_SECRET_LEN * 8,
    );
  } catch {
    return undefined;
  }
  const out = new Uint8Array(bits);
  if (bytesEqual(out, new Uint8Array(SHARED_SECRET_LEN))) return undefined;
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
      throw markPeerWaitTimeout(new Error(TIMEOUT_FAILURE, { cause: e }));
    }
    throw e;
  }
}

// --- Result ------------------------------------------------------------------

/**
 * Result of a completed P-256 key exchange.
 *
 * `sessionKey` is a 32-byte key suitable for passing to `deriveAeadKey`
 * (exported from `./auth.ts`) to derive channel encryption keys, and to the
 * token-rotation HKDF. Both parties hold the same value after a successful
 * handshake. It has forward secrecy (it mixes a fresh ephemeral P-256 ECDH) and
 * is mutually authenticated by the pre-shared secret.
 */
interface KexResult {
  /** 32-byte session key. */
  sessionKey: Uint8Array<ArrayBuffer>;
  /**
   * The negotiated decision to wrap the post-handshake connection in an
   * additional application-encryption layer: `own request OR peer request`.
   * Both parties compute the same value (each holds both flags before
   * `computeKexKeys`), and it is transcript-bound, so a tampered flag aborts the
   * handshake rather than yielding a split decision. The caller applies the
   * extra AEAD layer when this is `true` and a session key is in hand. It is
   * `false` only when neither party requested the layer.
   */
  applyEncryption: boolean;
}

// --- Protocol ----------------------------------------------------------------

/**
 * Executes a 3-message authenticated P-256 key exchange over an established
 * connection.
 *
 * Message flow (initiator sends first throughout):
 *   1. Initiator -> Responder : `{ kexMsg: "1", e: e_I, reqEnc: req_I }`
 *   2. Responder -> Initiator : `{ kexMsg: "2", e: e_R, confirm: MAC_R,
 *      reqEnc: req_R }`
 *   3. Initiator -> Responder : `{ kexMsg: "3", confirm: MAC_I }` or
 *      `{ kexMsg: "abort" }`
 *
 * `e_I` and `e_R` are base64url-encoded 65-byte ephemeral P-256 public keys in
 * the SEC1 uncompressed encoding (`0x04 || X || Y`), generated by
 * `crypto.subtle.generateKey`; a share in any other encoding of the same point
 * is rejected, not decoded. `MAC_R` and `MAC_I` are the role-asymmetric
 * confirmation tags (HMAC-SHA-256 under the confirmation key, binding the
 * handshake transcript). The responder confirms first (in msg2); the initiator
 * verifies it before sending its own confirmation in msg3, so a mismatched
 * pre-shared secret fails closed before any non-handshake frame is sent. The
 * connection's inbound queue buffers any frame that arrives before this side is
 * ready to read it, so a fast peer cannot race ahead of a receive.
 *
 * `req_I` and `req_R` are each party's `requestEncryption` flag, riding the
 * party's own message. Both sides therefore hold both flags before
 * `computeKexKeys`, which binds them into the transcript hash; the returned
 * {@link KexResult.applyEncryption} is `req_I OR req_R`, identical on both ends.
 * Because the flags are transcript-bound, an attacker flipping either flag on the
 * wire produces a different transcript hash on the two sides, so the confirmation
 * tags mismatch and the handshake aborts -- it cannot be downgraded to a
 * different encryption decision than the parties agreed.
 *
 * The construction is Noise NNpsk0 over P-256 plus an explicit key
 * confirmation, following NIST SP 800-56A; the ephemeral keygen and the DH are
 * `crypto.subtle` calls, not hand-rolled curve math. See the module header and
 * docs/spec/PROTOCOL.md.
 *
 * `psk` is the raw 32-byte pre-shared secret. Callers holding a base64url token
 * decode it to bytes first (a wrong length is a caller error, thrown
 * synchronously before any network activity).
 *
 * `handshakeRole` is assigned out of band by the caller; it
 * is not negotiated in-band. Two peers that both pass `"initiator"` reject each
 * other (the second message fails the opposite schema) and two `"responder"`s
 * deadlock on receive -- neither yields a false session.
 *
 * @throws {ConnectionError} of kind `"security"` with the message `"key
 *   exchange authentication failed"` on any authentication failure. The message
 *   is intentionally generic to avoid hinting at which specific check failed;
 *   the kind is the trust-boundary marker consumers classify on.
 * @throws {Error} `"key exchange handshake timed out"` if a peer does not
 *   respond within 30 seconds -- a transport fault (the peer is gone), so it
 *   deliberately stays a plain Error rather than a security classification.
 * @throws {Error} if `psk` is not 32 bytes. Because `runKex` is async this
 *   surfaces as a rejected promise (before any network activity), not a
 *   synchronous throw, so callers must `await` or `.catch` it.
 * @throws {ConnectionError} unchanged if the connection terminates for a
 *   non-transport reason (e.g. a deliberate local {@link MessageConnection.close}
 *   during the handshake). Such a close is deliberately not masked as an
 *   authentication failure.
 *
 * @param requestEncryption  This party's request for an additional
 *   application-encryption layer over the post-handshake connection. It is sent
 *   on this party's handshake message and bound into the transcript. The
 *   negotiated decision (this OR the peer's flag) is returned as
 *   {@link KexResult.applyEncryption}.
 */
export async function runKex(
  conn: MessageConnection,
  handshakeRole: HandshakeRole,
  psk: Uint8Array<ArrayBuffer>,
  requestEncryption: boolean,
): Promise<KexResult> {
  if (psk.length !== PSK_LEN) {
    throw new Error(`runKex: psk must be ${PSK_LEN} bytes, got ${psk.length}`);
  }

  const { privateKey: mySecret, publicKey: myPublic } =
    await generateEphemeral();

  if (handshakeRole === "initiator") {
    await conn.send({
      kexMsg: "1",
      e: toBase64Url(myPublic),
      reqEnc: requestEncryption,
    } satisfies KexMsg1);

    // Message 2: receive responder's ephemeral + confirmation.
    // Every failure path below sends an abort so the responder stops waiting
    // immediately rather than blocking until the 30 s handshake timeout.
    const msg2 = KexMsg2Schema.safeParse(await receiveHandshake(conn));
    if (!msg2.success) {
      await sendAbort(conn);
      throw new ConnectionError(GENERIC_FAILURE, "security");
    }
    const peerPublic = decodeBase64Url(msg2.data.e);
    const peerKey =
      peerPublic === undefined ? undefined : await importPeerShare(peerPublic);
    if (peerPublic === undefined || peerKey === undefined) {
      await sendAbort(conn);
      throw new ConnectionError(GENERIC_FAILURE, "security");
    }
    const dh = await deriveSharedSecret(mySecret, peerKey);
    if (dh === undefined) {
      await sendAbort(conn);
      throw new ConnectionError(GENERIC_FAILURE, "security");
    }
    // We are the initiator, so our flag is the initiator flag and the responder's
    // (msg2.reqEnc) is the responder flag. Binding both into the transcript means
    // a tampered responder flag yields a responder tag we will reject below.
    const { sessionKey, initiatorConfirm, responderConfirm } =
      await computeKexKeys(
        psk,
        myPublic,
        peerPublic,
        dh,
        requestEncryption,
        msg2.data.reqEnc,
      );

    // No explicit length check on the decoded tag: bytesEqual is total and
    // returns false on any length mismatch (unlike the public key above, whose
    // encoding must be the pinned 65-byte uncompressed point before it feeds
    // the DH).
    const receivedConfirm = decodeBase64Url(msg2.data.confirm);
    if (
      receivedConfirm === undefined ||
      !bytesEqual(receivedConfirm, responderConfirm)
    ) {
      await sendAbort(conn);
      throw new ConnectionError(GENERIC_FAILURE, "security");
    }

    await conn.send({
      kexMsg: "3",
      confirm: toBase64Url(initiatorConfirm),
    } satisfies KexMsg3);

    return {
      sessionKey,
      applyEncryption: requestEncryption || msg2.data.reqEnc,
    };
  } else {
    // Message 1: receive initiator's ephemeral public key.
    // Every failure path below sends an abort so the initiator stops waiting.
    const msg1 = KexMsg1Schema.safeParse(await receiveHandshake(conn));
    if (!msg1.success) {
      await sendAbort(conn);
      throw new ConnectionError(GENERIC_FAILURE, "security");
    }
    const peerPublic = decodeBase64Url(msg1.data.e);
    const peerKey =
      peerPublic === undefined ? undefined : await importPeerShare(peerPublic);
    if (peerPublic === undefined || peerKey === undefined) {
      await sendAbort(conn);
      throw new ConnectionError(GENERIC_FAILURE, "security");
    }
    const dh = await deriveSharedSecret(mySecret, peerKey);
    if (dh === undefined) {
      await sendAbort(conn);
      throw new ConnectionError(GENERIC_FAILURE, "security");
    }
    // peerPublic is the initiator's e; myPublic is the responder's e. The
    // initiator's flag (msg1.reqEnc) is the initiator flag and ours is the
    // responder flag; both are bound into the transcript before the tags are
    // computed, so the confirm we send below already commits to both flags.
    const { sessionKey, initiatorConfirm, responderConfirm } =
      await computeKexKeys(
        psk,
        peerPublic,
        myPublic,
        dh,
        msg1.data.reqEnc,
        requestEncryption,
      );

    await conn.send({
      kexMsg: "2",
      e: toBase64Url(myPublic),
      confirm: toBase64Url(responderConfirm),
      reqEnc: requestEncryption,
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
    // non-oracular outcome.
    if (!msg3.success || msg3.data.kexMsg !== "3") {
      throw new ConnectionError(GENERIC_FAILURE, "security");
    }
    // No explicit tag length check: bytesEqual is total (see msg2 above).
    const receivedConfirm = decodeBase64Url(msg3.data.confirm);
    if (
      receivedConfirm === undefined ||
      !bytesEqual(receivedConfirm, initiatorConfirm)
    ) {
      throw new ConnectionError(GENERIC_FAILURE, "security");
    }

    return {
      sessionKey,
      applyEncryption: msg1.data.reqEnc || requestEncryption,
    };
  }
}
