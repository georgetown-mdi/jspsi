import * as z from "zod";
import { default as EventEmitter } from "eventemitter3";

import { deriveAeadKey } from "../auth.js";
import { toBase64Url, fromBase64Url } from "../utils/crypto.js";
import type { Connection, HandshakeRole } from "../types.js";

type Events = {
  data: (data: unknown) => void;
  error: (err: unknown) => void;
};

const Envelope = z.object({ enc: z.string() });

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
 * sequence number. The sequence number is monotonically increasing per sender.
 * Any inbound message whose sequence number is not strictly greater than the
 * last accepted sequence number, or whose GCM authentication tag fails, is
 * rejected: an `error` event is emitted and the wrapper is permanently dead.
 *
 * Construct via the static {@link EncryptedConnection.create} factory.
 */
export class EncryptedConnection extends EventEmitter<Events, never> {
  private readonly inner: Connection;
  private readonly sendKey: CryptoKey;
  private readonly recvKey: CryptoKey;
  private sendSeq = 0;
  private recvSeq = -1;
  private failed = false;
  private bufferedError: unknown;

  private constructor(
    inner: Connection,
    sendKey: CryptoKey,
    recvKey: CryptoKey,
  ) {
    super();
    this.inner = inner;
    this.sendKey = sendKey;
    this.recvKey = recvKey;

    this.inner.on("data", (data) => {
      void this.handleInbound(data).catch((err) => {
        this.markFailed(err instanceof Error ? err : new Error(String(err)));
      });
    });
    this.inner.on("error", (err) => this.emit("error", err));
  }

  static async create(
    inner: Connection,
    sessionKey: Uint8Array<ArrayBuffer>,
    role: HandshakeRole,
  ): Promise<EncryptedConnection> {
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

    return new EncryptedConnection(inner, sendKey, recvKey);
  }

  private seqToIv(seq: number): Uint8Array<ArrayBuffer> {
    const iv = new Uint8Array(12) as Uint8Array<ArrayBuffer>;
    new DataView(iv.buffer).setBigUint64(4, BigInt(seq), false);
    return iv;
  }

  async send(data: unknown): Promise<void> {
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

    const cipherBuffer = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      this.sendKey,
      new TextEncoder().encode(JSON.stringify(data)),
    );

    const cipher = new Uint8Array(cipherBuffer);
    const envelope = new Uint8Array(12 + cipher.length) as Uint8Array<ArrayBuffer>;
    envelope.set(iv);
    envelope.set(cipher, 12);

    await this.inner.send({ enc: toBase64Url(envelope) });
  }

  private async handleInbound(data: unknown): Promise<void> {
    if (this.failed) return;

    const parsed = Envelope.safeParse(data);
    if (!parsed.success) {
      this.markFailed(new Error("EncryptedConnection: received invalid envelope"));
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

    const seq = Number(
      new DataView(iv.buffer, iv.byteOffset).getBigUint64(4, false),
    );

    if (seq <= this.recvSeq) {
      this.markFailed(
        new Error(
          `EncryptedConnection: replay or out-of-order message rejected ` +
            `(seq=${seq}, last accepted=${this.recvSeq})`,
        ),
      );
      return;
    }

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

    this.recvSeq = seq;

    let message: unknown;
    try {
      message = JSON.parse(new TextDecoder().decode(plainBuffer));
    } catch {
      this.markFailed(
        new Error("EncryptedConnection: decrypted payload is not valid JSON"),
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
    return this.inner.close();
  }

  // Override emit to buffer unhandled errors, mirroring FileSyncConnection.
  emit<E extends keyof Events>(
    event: E,
    ...args: Parameters<Events[E]>
  ): boolean {
    const hadListeners = super.emit(event, ...args);
    if (event === "error" && !hadListeners) this.bufferedError = args[0];
    return hadListeners;
  }

  takeBufferedError(): unknown {
    const e = this.bufferedError;
    this.bufferedError = undefined;
    return e;
  }
}
