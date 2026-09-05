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

// The authenticated key exchange that produces the exchange session key: an
// ephemeral P-256 Diffie-Hellman pinned to the Noise NNpsk0 pattern plus an
// explicit, role-asymmetric mutual key confirmation. Only the NNpsk0 glue --
// key-schedule mixing and the two confirmation tags -- is written here; every
// cryptographic operation is a crypto.subtle call, and the full Noise
// framework is not implemented. Construction, key schedule, wire format, and
// what the vectors pin: docs/spec/PROTOCOL.md ("P-256 authenticated key
// exchange"). Decision and module boundary: docs/SECURITY_DESIGN.md
// ("Key-agreement design") and
// docs/notes/key-establishment-fips-boundary.md.

// The pre-shared secret is psk0, which Noise mandates be 32 bytes.
const PSK_LEN = 32;

// Wire encoding of an ephemeral public key: the SEC1 uncompressed point
// `0x04 || X || Y`, 65 bytes over P-256. Enforcing it is this module's job,
// not importKey's, which accepts other encodings of the same point and not
// the same ones on every platform; docs/spec/PROTOCOL.md ("Curve and point
// encoding") states the pin and what it rests on. kex.test.ts and the browser
// suite drive importKey with the alternative encodings on their own platform,
// so the divergence is measured rather than assumed.
const PUBLIC_KEY_LEN = 65;
const UNCOMPRESSED_POINT_PREFIX = 0x04;

// SP 800-56A Rev 3 Z for P-256: the 32-byte X coordinate of the shared point,
// which is what crypto.subtle.deriveBits returns for ECDH over this curve.
const SHARED_SECRET_LEN = 32;

const ECDH_P256 = { name: "ECDH", namedCurve: "P-256" } as const;

// SHA-256 output length: the width of every chaining-key, handshake-hash, and
// confirmation-tag value, and the block size the Noise chaining HKDF counts in.
const HASH_LEN = 32;

// The Noise "protocol name", hashed into the initial handshake hash. When it
// is bumped, docs/spec/PROTOCOL.md ("Protocol-version tag") is what governs:
// it states what the tag covers, what a bump is reserved for, and what a
// mismatch does.
const PROTOCOL_NAME = "psilink-kex-v2:NNpsk0_P256_SHA256";

// Domain-separation labels for the derivations below, in the disjoint label
// space docs/spec/PROTOCOL.md ("The domain-separation label space")
// enumerates. Their namespace version does not track the suite tag above; the
// two confirm labels are role-asymmetric.
const SESSION_LABEL = "psilink-kex-v1:session";
const CONFIRM_KEY_LABEL = "psilink-kex-v1:confirm";
const INITIATOR_CONFIRM_LABEL = "psilink-kex-v1:initiator-confirm";
const RESPONDER_CONFIRM_LABEL = "psilink-kex-v1:responder-confirm";

// The one message every authentication failure throws, and it must stay
// non-oracular: no throw site may narrow it to the check that failed, and the
// ConnectionError's "security" kind is what consumers classify on. What that
// property covers and what it does not: docs/spec/PROTOCOL.md ("Failure
// handling").
const GENERIC_FAILURE = "key exchange authentication failed";
const TIMEOUT_FAILURE = "key exchange handshake timed out";

// 30 s is a generous ceiling for a single handshake round-trip on any realistic
// network; exceeding it almost certainly means the peer is gone.
const HANDSHAKE_TIMEOUT_MS = 30_000;

const EMPTY = new Uint8Array(0);

// --- Wire message schemas ----------------------------------------------------
//
// The three handshake messages, whose field encodings are in
// docs/spec/PROTOCOL.md ("Message flow"). Every schema is `.strict()`, so an
// unexpected key fails the parse rather than being silently stripped; keep it
// that way, since the strictness is half of what makes a flag-unaware peer
// fail closed rather than negotiate.

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
// There is no CipherState: NNpsk0's handshake messages hold no encrypted
// payload here, so the symmetric cipher half of Noise is omitted entirely.

interface SymmetricState {
  ck: Uint8Array<ArrayBuffer>;
  h: Uint8Array<ArrayBuffer>;
}

/**
 * The Noise chaining HKDF, keyed by the running chaining key and returning
 * `numOutputs` 32-byte blocks. It is issued as one `crypto.subtle`
 * `deriveBits` call rather than a chain of HMAC calls assembled here, so the
 * platform -- and any validated module beneath it -- serves the
 * extract-and-expand as a unit; docs/spec/PROTOCOL.md ("Key schedule") states
 * the equality that makes the two forms interchangeable. It differs from the
 * application-level {@link hkdfDerive} (zero salt, named info) because the
 * Noise schedule chains the salt.
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
 * The pure NNpsk0 key schedule and key-confirmation derivation. Both peers
 * call this with identical arguments after the ephemeral exchange and get
 * identical outputs. The mixing order, what each derivation is taken over,
 * and why that is the critical invariant: docs/spec/PROTOCOL.md ("Key
 * schedule"), which the steps below implement in the order it states.
 *
 * @internal exported only for the known-answer-vector and RFC cross-check
 *   tests.
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
  // NNpsk0 token sequence: -> psk, e ; <- e, ee (empty prologue). Each
  // message's request-encryption flag is mixed in as that message's
  // handshake payload, right after its `e` token. In PSK mode Noise (rev 34
  // section 9.2) processes every `e` token with MixKey(e.public) in addition
  // to MixHash(e.public), folding the ephemeral publics into the chaining
  // key as well as the hash -- both are done below, so this is faithful
  // NNpsk0. MixHash and MixKey touch disjoint state (h and ck), so order
  // within one `e` token is immaterial; what is fixed is the ck-chain order
  // psk -> e_i -> e_r -> ee and the h-chain order e_i -> flag_i -> e_r ->
  // flag_r.
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
  // independent of the session key. It does not fold in h the way the session
  // key (ck||h) does: the confirmation tags below bind the transcript hash h
  // explicitly in the HMAC message, so the tags are fully transcript-bound
  // without h also entering the key.
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
// abort-and-fail handling. The two validation layers and the split between
// them are docs/spec/PROTOCOL.md ("Peer-share validation"); kex.test.ts and
// the browser suite assert each rejection against the real crypto.subtle.
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

// Computes the ECDH shared secret, returning undefined on any failure. The
// all-zero result check is a stated safety check rather than the validation,
// and docs/spec/PROTOCOL.md ("Peer-share validation") says what it rests on
// and why it stays. The compare is constant-time, against a freshly allocated
// zero buffer rather than a module-level sentinel, so no in-place mutation
// could weaken it.
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
 * handshake.
 */
interface KexResult {
  /** 32-byte session key. */
  sessionKey: Uint8Array<ArrayBuffer>;
  /**
   * The negotiated decision to wrap the post-handshake connection in an
   * additional application-encryption layer, identical on both ends. The
   * caller applies the extra AEAD layer when this is `true` and a session key
   * is in hand. How it is negotiated and what binds it: docs/spec/PROTOCOL.md
   * ("Request-encryption flag").
   */
  applyEncryption: boolean;
}

// --- Protocol ----------------------------------------------------------------

/**
 * Executes a 3-message authenticated P-256 key exchange over an established
 * connection. Message flow, wire encoding, and construction:
 * docs/spec/PROTOCOL.md ("P-256 authenticated key exchange").
 *
 * The connection's inbound queue buffers any frame that arrives early, so a
 * fast peer cannot race ahead of a receive.
 *
 * `psk` is the raw 32-byte pre-shared secret; a caller holding a base64url
 * token decodes it to bytes first (a wrong length is a caller error, thrown
 * before any network activity).
 *
 * `handshakeRole` is assigned out of band by the caller, not negotiated
 * in-band: two peers both passing `"initiator"` reject each other and two
 * `"responder"`s deadlock on receive -- neither yields a false session.
 *
 * @throws {ConnectionError} of kind `"security"`, message `"key exchange
 *   authentication failed"`, on any authentication failure.
 * @throws {Error} `"key exchange handshake timed out"` if a peer does not
 *   respond within 30 seconds -- a transport fault, not a security
 *   classification.
 * @throws {Error} if `psk` is not 32 bytes. Because `runKex` is async this
 *   is a rejected promise, not a synchronous throw.
 * @throws {ConnectionError} unchanged if the connection terminates for a
 *   non-transport reason (e.g. a local {@link MessageConnection.close}
 *   during the handshake) -- such a close is not masked as an
 *   authentication failure.
 *
 * @param requestEncryption  This party's request for the additional
 *   application-encryption layer. Sent on this party's handshake message and
 *   bound into the transcript; the negotiated decision is returned as
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
    // We are the initiator, so our flag is the initiator flag and the
    // responder's (msg2.reqEnc) is the responder flag. Binding both into the
    // transcript means a tampered responder flag yields a responder tag we
    // will reject below.
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
    // mismatch) folds into the same generic failure as a malformed or wrong
    // msg3: from the responder's side it is an authentication failure either
    // way, and the initiator has already moved on. This trades operator
    // diagnosability for a single non-oracular outcome.
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
