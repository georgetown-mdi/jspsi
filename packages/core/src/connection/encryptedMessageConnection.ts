import * as z from "zod";

import { deriveAeadKey } from "../auth";
import { toBase64Url, fromBase64Url, enc, dec } from "../utils/crypto";
import {
  ConnectionError,
  asConnectionError,
  type MessageConnection,
} from "./messageConnection";
import type { HandshakeRole } from "../types";

const Envelope = z.object({ enc: z.string() });

// First byte of the pre-encryption plaintext, preserving the original payload's
// type across the wire. The transport underneath only ever sees the JSON
// envelope `{ enc }`, so without this tag a Uint8Array would round-trip as a
// plain object and the protobuf deserialize step in the PSI protocol would
// fail. `TYPE_JSON` payloads are UTF-8 JSON; `TYPE_BINARY` payloads are the raw
// bytes of a Uint8Array.
/** @internal */
export const TYPE_JSON = 0;
/** @internal */
export const TYPE_BINARY = 1;

// Byte offset within the 12-byte IV where the 8-byte big-endian sequence
// number is written (preceded by 4 reserved zero bytes). Both the encode path
// (seqToIv) and the decode path (handleInbound) must agree on this offset.
/** @internal */
export const IV_SEQ_OFFSET = 4;

/**
 * Wraps any {@link MessageConnection} and transparently encrypts all outbound
 * messages and decrypts all inbound messages using AES-256-GCM. This is a
 * decorator: it implements {@link MessageConnection} itself and delegates the
 * actual transport to the inner connection, so the SFTP/filedrop admin sees
 * only opaque ciphertext envelopes.
 *
 * Two direction-specific keys are derived from the SPAKE2 session key via
 * {@link deriveAeadKey}:
 * - initiator -> responder: `deriveAeadKey(sessionKey, "initiator-to-responder")`
 * - responder -> initiator: `deriveAeadKey(sessionKey, "responder-to-initiator")`
 *
 * The two keys are kept distinct (never collapsed to one shared key): both
 * directions start their counter at 0 and the nonce carries no direction
 * partition, so a single shared key would encrypt the initiator's seq=0 and the
 * responder's seq=0 under the same key/IV pair, and AES-GCM nonce reuse under
 * one key is catastrophic. One key per direction makes that reuse impossible
 * because each key is used by exactly one sender.
 *
 * Wire format: `{ enc: base64url(IV || ciphertext || 16-byte GCM tag) }` where
 * IV is 12 bytes: 4 zero bytes (reserved) followed by an 8-byte big-endian
 * sequence number. The encrypted plaintext is a 1-byte type tag (`0` = JSON
 * object, `1` = Uint8Array) followed by the payload (UTF-8 JSON or raw bytes
 * respectively); the tag preserves the distinction between protobuf binary
 * frames and JSON control messages that the underlying transport's own
 * serialization would otherwise collapse. The sequence number is monotonically
 * increasing per sender. Any inbound message whose sequence number is not
 * strictly greater than the last accepted sequence number, or whose GCM
 * authentication tag fails, is rejected: {@link receive} rejects with a
 * {@link ConnectionError} of kind `"security"` and the wrapper is permanently
 * dead. A `"security"` failure is deliberately distinguishable from a plain
 * transport drop so a forged or replayed frame is never mistaken for an
 * ordinary disconnect.
 *
 * This layer detects replay, reordering, and tampering (a non-increasing
 * sequence number, or a failed GCM tag), but it does NOT detect dropped or
 * withheld frames: an inbound sequence number that skips ahead (a gap) is
 * accepted, and a truncated tail is indistinguishable from a clean end.
 * Completeness is delegated to the inner transport and the lockstep protocol
 * above, where a missing frame surfaces as a stalled or schema-invalid
 * exchange. End-to-end gap and truncation detection is a deferred follow-up; it
 * is blocked on the send path advancing its counter only on a fully successful
 * send, so that a legitimate sender-side gap can never be mistaken for an
 * attack (see docs/SECURITY_DESIGN.md, "Channel security").
 *
 * Construct via the static {@link EncryptedMessageConnection.create} factory.
 */
export class EncryptedMessageConnection implements MessageConnection {
  private readonly inner: MessageConnection;
  private readonly sendKey: CryptoKey;
  private readonly recvKey: CryptoKey;
  private sendSeq = 0;
  private recvSeq = -1;
  // Sticky terminal error: undefined while live, set to the first failure's
  // ConnectionError once dead. Every subsequent send/receive rejects with this
  // same latched error, mirroring QueuedMessageConnection's terminal state.
  private failed: ConnectionError | undefined = undefined;

  private constructor(
    inner: MessageConnection,
    sendKey: CryptoKey,
    recvKey: CryptoKey,
  ) {
    this.inner = inner;
    this.sendKey = sendKey;
    this.recvKey = recvKey;
  }

  static async create(
    inner: MessageConnection,
    sessionKey: Uint8Array<ArrayBuffer>,
    role: HandshakeRole,
  ): Promise<EncryptedMessageConnection> {
    // No buffering dance is needed here: an encrypted frame that arrives during
    // this async key derivation sits in the inner connection's FIFO until the
    // first receive() pulls it, so nothing is dropped.
    const [initiatorBytes, responderBytes] = await Promise.all([
      deriveAeadKey(sessionKey, "initiator-to-responder"),
      deriveAeadKey(sessionKey, "responder-to-initiator"),
    ]);

    const [sendBytes, recvBytes] =
      role === "initiator"
        ? [initiatorBytes, responderBytes]
        : [responderBytes, initiatorBytes];

    const [sendKey, recvKey] = await Promise.all([
      crypto.subtle.importKey("raw", sendBytes, { name: "AES-GCM" }, false, [
        "encrypt",
      ]),
      crypto.subtle.importKey("raw", recvBytes, { name: "AES-GCM" }, false, [
        "decrypt",
      ]),
    ]);

    return new EncryptedMessageConnection(inner, sendKey, recvKey);
  }

  // Latch the first terminal error and return it for the caller to throw. The
  // latch is sticky: a later failure keeps the original error, so every
  // subsequent send/receive rejects with the same value.
  private fail(error: ConnectionError): ConnectionError {
    this.failed ??= error;
    return this.failed;
  }

  private seqToIv(seq: number): Uint8Array<ArrayBuffer> {
    const iv = new Uint8Array(12) as Uint8Array<ArrayBuffer>;
    new DataView(iv.buffer).setBigUint64(IV_SEQ_OFFSET, BigInt(seq), false);
    return iv;
  }

  async send(data: unknown): Promise<void> {
    if (this.failed !== undefined) throw this.failed;

    if (this.sendSeq > Number.MAX_SAFE_INTEGER) {
      // Route through fail() so overflow latches the wrapper like every other
      // terminal failure: every later send/receive then rejects with this same
      // error object. Kept kind "security" - refusing to reuse a nonce is a
      // deliberate cryptographic safety guard that must never be silently
      // retried, which is exactly the "security" contract.
      throw this.fail(
        new ConnectionError(
          "EncryptedConnection: sequence number overflow; refusing to reuse nonce",
          "security",
        ),
      );
    }

    // Build the plaintext before consuming a sequence number, so a serialization
    // failure (e.g. a circular-reference payload throwing in JSON.stringify)
    // does not burn a counter value on a frame that is never sent.
    let plaintext: Uint8Array<ArrayBuffer>;
    if (data instanceof Uint8Array) {
      plaintext = new Uint8Array(1 + data.length) as Uint8Array<ArrayBuffer>;
      plaintext[0] = TYPE_BINARY;
      plaintext.set(data, 1);
    } else {
      const json = enc.encode(JSON.stringify(data));
      plaintext = new Uint8Array(1 + json.length) as Uint8Array<ArrayBuffer>;
      plaintext[0] = TYPE_JSON;
      plaintext.set(json, 1);
    }

    const seq = this.sendSeq++;
    const iv = this.seqToIv(seq);

    let cipherBuffer: ArrayBuffer;
    try {
      cipherBuffer = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        this.sendKey,
        plaintext,
      );
    } catch (err) {
      // A failure to encrypt our OWN outbound data is not tampering: the
      // realistic causes are local runtime faults (resource exhaustion, a
      // crypto-subsystem error), out of anyone's control. Classify as
      // "transport" - not the caller's fault, a retry is reasonable, and never
      // "security" - keeping the underlying error as the cause. A dedicated
      // "system" kind for non-attributable runtime faults was considered and
      // deferred (see docs/COMMUNICATION.md, "Error handling").
      throw this.fail(
        new ConnectionError(
          "EncryptedConnection: failed to encrypt outbound message " +
            "(local crypto/runtime fault)",
          "transport",
          { cause: err },
        ),
      );
    }

    // Re-check after the await. Dead code in the pull model (no concurrent
    // caller can latch a failure between the encrypt above and here), kept so a
    // future concurrent caller still observes the latch.
    if (this.failed !== undefined) throw this.failed;

    const cipher = new Uint8Array(cipherBuffer);
    const envelope = new Uint8Array(
      12 + cipher.length,
    ) as Uint8Array<ArrayBuffer>;
    envelope.set(iv);
    envelope.set(cipher, 12);

    try {
      await this.inner.send({ enc: toBase64Url(envelope) });
    } catch (err) {
      // A transport-layer send failure makes this wrapper terminal too (the
      // MessageConnection.send contract), so latch it rather than letting it
      // escape with this.failed still undefined. asConnectionError passes an
      // inner ConnectionError through unchanged, preserving its kind.
      throw this.fail(asConnectionError(err, "transport"));
    }
  }

  async receive(timeoutMs?: number): Promise<unknown> {
    if (this.failed !== undefined) throw this.failed;
    // Pull one envelope from the inner FIFO; timeoutMs passes straight through.
    const data = await this.inner.receive(timeoutMs);
    // Re-check after the await, for symmetry with send()/handleInbound. Dead
    // code in the pull model (no concurrent caller can latch a failure between
    // the receive above and here), kept so a future concurrent caller observes
    // the latch before any inbound processing begins.
    if (this.failed !== undefined) throw this.failed;
    return this.handleInbound(data);
  }

  // Validates, decrypts, and unwraps one inbound envelope, returning the
  // original message. Any integrity/replay/ordering/format failure latches a
  // `"security"` ConnectionError and throws it; a transport drop surfaced by
  // inner.receive propagates unchanged.
  private async handleInbound(data: unknown): Promise<unknown> {
    const parsed = Envelope.safeParse(data);
    if (!parsed.success) {
      throw this.fail(
        new ConnectionError(
          "EncryptedConnection: received invalid envelope",
          "security",
        ),
      );
    }

    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = fromBase64Url(parsed.data.enc);
    } catch {
      throw this.fail(
        new ConnectionError(
          "EncryptedConnection: envelope contains invalid base64url",
          "security",
        ),
      );
    }

    // Minimum: 12-byte IV + 16-byte GCM tag (zero-length plaintext)
    if (bytes.length < 28) {
      throw this.fail(
        new ConnectionError(
          "EncryptedConnection: envelope is too short",
          "security",
        ),
      );
    }

    const iv = bytes.slice(0, 12) as Uint8Array<ArrayBuffer>;
    const cipherWithTag = bytes.slice(12) as Uint8Array<ArrayBuffer>;

    const seqBig = new DataView(iv.buffer, iv.byteOffset).getBigUint64(
      IV_SEQ_OFFSET,
      false,
    );
    // A legitimate sender caps its counter at Number.MAX_SAFE_INTEGER, so any
    // higher value is proof of injection. Comparing as BigInt avoids Number()
    // precision loss above 2^53 that would let a crafted IV slip past the
    // replay guard below.
    if (seqBig > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw this.fail(
        new ConnectionError(
          "EncryptedConnection: inbound sequence number exceeds safe integer range",
          "security",
        ),
      );
    }
    const seq = Number(seqBig);

    if (seq <= this.recvSeq) {
      throw this.fail(
        new ConnectionError(
          `EncryptedConnection: replay or out-of-order message rejected ` +
            `(seq=${seq}, last accepted=${this.recvSeq})`,
          "security",
        ),
      );
    }

    // Reserve the sequence number synchronously, before the await below: two
    // inbound frames delivered before the first decrypt resolves would
    // otherwise both read the same stale recvSeq and both pass the guard
    // above. A frame that subsequently fails decryption still advances
    // recvSeq, but the failure latch makes the wrapper permanently dead, so no
    // later frame is observed and the advance has no effect. In the pull model
    // only one decrypt is ever in flight so the race cannot occur structurally,
    // but the guard costs nothing and a future concurrent caller would need it.
    this.recvSeq = seq;

    let plainBuffer: ArrayBuffer;
    try {
      plainBuffer = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv },
        this.recvKey,
        cipherWithTag,
      );
    } catch {
      throw this.fail(
        new ConnectionError(
          "EncryptedConnection: AES-GCM authentication tag verification failed",
          "security",
        ),
      );
    }

    // Re-check after the await: dead code in the pull model (only one decrypt
    // is in flight), kept so a future concurrent caller still observes a
    // failure latched by another frame while this one was in decrypt.
    if (this.failed !== undefined) throw this.failed;

    const plain = new Uint8Array(plainBuffer);
    if (plain.length < 1) {
      throw this.fail(
        new ConnectionError(
          "EncryptedConnection: decrypted payload is empty",
          "security",
        ),
      );
    }

    const tag = plain[0];
    if (tag === TYPE_BINARY) {
      return plain.slice(1);
    } else if (tag === TYPE_JSON) {
      try {
        return JSON.parse(dec.decode(plain.subarray(1)));
      } catch {
        throw this.fail(
          new ConnectionError(
            "EncryptedConnection: decrypted payload is not valid JSON",
            "security",
          ),
        );
      }
    } else {
      throw this.fail(
        new ConnectionError(
          `EncryptedConnection: unknown payload type tag ${tag}`,
          "security",
        ),
      );
    }
  }

  async close(): Promise<void> {
    // Latch the wrapper as deliberately closed, then tear down the inner
    // transport. A fresh send/receive after close is caller misuse, so the
    // latch is kind "usage" (mirroring QueuedMessageConnection's post-close
    // throws); the kind is deliberately not "security", which is reserved for
    // tamper/replay/ordering failures and must stay distinguishable from a
    // clean shutdown. A receive that was already parked when close ran is
    // cancelled by the inner connection with kind "closed", not by this latch.
    this.fail(
      new ConnectionError(
        "EncryptedConnection: cannot use a closed connection",
        "usage",
      ),
    );
    await this.inner.close();
  }
}
