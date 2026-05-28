import * as z from "zod";

import { deriveAeadKey } from "../auth.js";
import { toBase64Url, fromBase64Url, enc, dec } from "../utils/crypto.js";
import { BufferedErrorEmitter } from "./bufferedErrorEmitter.js";
import type { Connection, HandshakeRole } from "../types.js";

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
 * Wraps any {@link Connection} and transparently encrypts all outbound messages
 * and decrypts all inbound messages using AES-256-GCM.
 *
 * Two direction-specific keys are derived from the SPAKE2 session key via
 * {@link deriveAeadKey}:
 * - initiator → responder: `deriveAeadKey(sessionKey, "initiator-to-responder")`
 * - responder → initiator: `deriveAeadKey(sessionKey, "responder-to-initiator")`
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
 * authentication tag fails, is rejected: an `error` event is emitted and the
 * wrapper is permanently dead.
 *
 * Construct via the static {@link EncryptedConnection.create} factory.
 */
export class EncryptedConnection extends BufferedErrorEmitter {
  private readonly inner: Connection;
  private readonly sendKey: CryptoKey;
  private readonly recvKey: CryptoKey;
  private sendSeq = 0;
  private recvSeq = -1;
  private failed = false;

  // Stored so close() can detach them; the constructor registers them on the
  // inner connection and without removal they would keep decrypting/emitting
  // into a logically-closed wrapper.
  private readonly onInnerData = (data: unknown): void => {
    void this.handleInbound(data).catch((err) => {
      this.markFailed(err instanceof Error ? err : new Error(String(err)));
    });
  };
  private readonly onInnerError = (err: unknown): void => {
    this.markFailed(err instanceof Error ? err : new Error(String(err)));
  };

  private constructor(
    inner: Connection,
    sendKey: CryptoKey,
    recvKey: CryptoKey,
  ) {
    super();
    this.inner = inner;
    this.sendKey = sendKey;
    this.recvKey = recvKey;

    this.inner.on("data", this.onInnerData);
    this.inner.on("error", this.onInnerError);
  }

  static async create(
    inner: Connection,
    sessionKey: Uint8Array<ArrayBuffer>,
    role: HandshakeRole,
  ): Promise<EncryptedConnection> {
    // Register a data listener before the async key derivation so any
    // encrypted message that arrives during key derivation is buffered rather
    // than dropped. The constructor registers onInnerData on inner; after
    // construction we remove this listener and replay held messages through
    // onInnerData synchronously.
    const pendingMessages: unknown[] = [];
    const bufferData = (data: unknown): void => {
      pendingMessages.push(data);
    };
    inner.on("data", bufferData);

    let sendKey: CryptoKey;
    let recvKey: CryptoKey;
    try {
      const [initiatorBytes, responderBytes] = await Promise.all([
        deriveAeadKey(sessionKey, "initiator-to-responder"),
        deriveAeadKey(sessionKey, "responder-to-initiator"),
      ]);

      const [sendBytes, recvBytes] =
        role === "initiator"
          ? [initiatorBytes, responderBytes]
          : [responderBytes, initiatorBytes];

      [sendKey, recvKey] = await Promise.all([
        crypto.subtle.importKey("raw", sendBytes, { name: "AES-GCM" }, false, [
          "encrypt",
        ]),
        crypto.subtle.importKey("raw", recvBytes, { name: "AES-GCM" }, false, [
          "decrypt",
        ]),
      ]);
    } catch (err) {
      inner.removeListener("data", bufferData);
      throw err;
    }

    // Construct before removeListener: the constructor's inner.on("data",
    // onInnerData) runs synchronously, so there is never a window where inner
    // has zero 'data' listeners. A Connection that drains queued events on
    // removeListener would otherwise drop a message that arrived during key
    // derivation.
    const conn = new EncryptedConnection(inner, sendKey, recvKey);
    inner.removeListener("data", bufferData);
    for (const msg of pendingMessages) conn.onInnerData(msg);
    return conn;
  }

  private seqToIv(seq: number): Uint8Array<ArrayBuffer> {
    const iv = new Uint8Array(12) as Uint8Array<ArrayBuffer>;
    new DataView(iv.buffer).setBigUint64(IV_SEQ_OFFSET, BigInt(seq), false);
    return iv;
  }

  async send(data: unknown, chunked?: boolean): Promise<void> {
    if (this.failed) {
      throw new Error(
        "EncryptedConnection: wrapper is permanently dead after a security failure",
      );
    }

    if (this.sendSeq > Number.MAX_SAFE_INTEGER) {
      throw new Error(
        "EncryptedConnection: sequence number overflow; refusing to reuse nonce",
      );
    }

    const seq = this.sendSeq++;
    const iv = this.seqToIv(seq);

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

    let cipherBuffer: ArrayBuffer;
    try {
      cipherBuffer = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        this.sendKey,
        plaintext,
      );
    } catch (err) {
      this.markFailed(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }

    if (this.failed) {
      throw new Error(
        "EncryptedConnection: wrapper is permanently dead after a security failure",
      );
    }

    const cipher = new Uint8Array(cipherBuffer);
    const envelope = new Uint8Array(
      12 + cipher.length,
    ) as Uint8Array<ArrayBuffer>;
    envelope.set(iv);
    envelope.set(cipher, 12);

    await this.inner.send({ enc: toBase64Url(envelope) }, chunked);
  }

  private async handleInbound(data: unknown): Promise<void> {
    if (this.failed) return;

    const parsed = Envelope.safeParse(data);
    if (!parsed.success) {
      this.markFailed(
        new Error("EncryptedConnection: received invalid envelope"),
      );
      return;
    }

    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = fromBase64Url(parsed.data.enc);
    } catch {
      this.markFailed(
        new Error("EncryptedConnection: envelope contains invalid base64url"),
      );
      return;
    }

    // Minimum: 12-byte IV + 16-byte GCM tag (zero-length plaintext)
    if (bytes.length < 28) {
      this.markFailed(new Error("EncryptedConnection: envelope is too short"));
      return;
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
      this.markFailed(
        new Error(
          "EncryptedConnection: inbound sequence number exceeds safe integer range",
        ),
      );
      return;
    }
    const seq = Number(seqBig);

    if (seq <= this.recvSeq) {
      this.markFailed(
        new Error(
          `EncryptedConnection: replay or out-of-order message rejected ` +
            `(seq=${seq}, last accepted=${this.recvSeq})`,
        ),
      );
      return;
    }

    // Reserve the sequence number synchronously, before the await below: two
    // inbound frames delivered before the first decrypt resolves would
    // otherwise both read the same stale recvSeq and both pass the guard
    // above. A frame that subsequently fails decryption still advances
    // recvSeq, but markFailed makes the wrapper permanently dead, so no later
    // frame is observed and the advance has no effect.
    this.recvSeq = seq;

    let plainBuffer: ArrayBuffer;
    try {
      plainBuffer = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv },
        this.recvKey,
        cipherWithTag,
      );
    } catch {
      this.markFailed(
        new Error(
          "EncryptedConnection: AES-GCM authentication tag verification failed",
        ),
      );
      return;
    }

    // Re-check after the await: a concurrent handleInbound that failed auth
    // may have called markFailed while this one was in decrypt.
    if (this.failed) return;

    const plain = new Uint8Array(plainBuffer);
    if (plain.length < 1) {
      this.markFailed(
        new Error("EncryptedConnection: decrypted payload is empty"),
      );
      return;
    }

    const tag = plain[0];
    let message: unknown;
    if (tag === TYPE_BINARY) {
      message = plain.slice(1);
    } else if (tag === TYPE_JSON) {
      try {
        message = JSON.parse(dec.decode(plain.subarray(1)));
      } catch {
        this.markFailed(
          new Error("EncryptedConnection: decrypted payload is not valid JSON"),
        );
        return;
      }
    } else {
      this.markFailed(
        new Error(`EncryptedConnection: unknown payload type tag ${tag}`),
      );
      return;
    }

    this.emit("data", message);
  }

  private markFailed(err: Error): void {
    this.failed = true;
    this.emit("error", err);
  }

  close(): void | Promise<void> {
    this.failed = true;
    this.inner.removeListener("data", this.onInnerData);
    this.inner.removeListener("error", this.onInnerError);
    return this.inner.close();
  }

  // Drain the wrapper's own buffered error first; if it has none, fall through
  // to the inner connection so a transport failure buffered before this
  // wrapper attached its inner.on("error") listener (e.g. a poll error in the
  // window between authentication and wrapper construction) is not stranded.
  takeBufferedError(): unknown {
    const own = super.takeBufferedError();
    if (own !== undefined) return own;
    return this.inner.takeBufferedError();
  }
}
