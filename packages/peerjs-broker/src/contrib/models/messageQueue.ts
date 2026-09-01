import { Buffer } from "node:buffer";
import type { IMessage } from "./message.ts";

/**
 * Resident bytes of the optional payload, in the same UTF-16 worst-case units
 * `messageByteSize` uses. Every real signaling payload -- an SDP offer or
 * answer, an ICE candidate -- reaches the relay as a parsed JSON object rather
 * than a string, so a structured payload is sized by its serialized form, the
 * bytes that crossed the wire. A value `JSON.stringify` leaves unserialized has
 * no wire form to account for and is sized zero.
 */
function payloadByteSize(payload: unknown): number {
  if (payload === undefined || payload === null) return 0;
  if (typeof payload === "string") return Buffer.byteLength(payload, "utf16le");
  const serialized: string | undefined = JSON.stringify(payload);
  return serialized === undefined
    ? 0
    : Buffer.byteLength(serialized, "utf16le");
}

/**
 * Resident byte size of a queued signaling message, summed over its fields.
 * Measured as UTF-16 code units times two (`utf16le`), not UTF-8, because V8
 * stores a JavaScript string as two bytes per code unit the moment it holds any
 * non-Latin1 character (>= U+0100): a UTF-8 measure undercounts such a payload
 * by up to 2x, letting it occupy roughly twice its measured size in the heap.
 * Counting the worst-case two-byte residency bounds a relay reconnect queue's
 * actual memory regardless of payload charset (see `MAX_QUEUE_BYTES`). The
 * optional `payload` dominates; `type`/`src`/`dst` are short ids. A structured
 * payload is accounted by its serialization, which does not model the
 * per-property overhead V8 adds to a parsed object; the residual that leaves on
 * the queue's ceiling is quantified in docs/spec/CHANNEL_SECURITY.md.
 * `Buffer.byteLength` throws on a non-string `type`, `src`, or `dst`, so a
 * frame whose ids are malformed is rejected before it can be queued or key a
 * queue of its own.
 */
export function messageByteSize(message: IMessage): number {
  return (
    Buffer.byteLength(message.type, "utf16le") +
    Buffer.byteLength(message.src, "utf16le") +
    Buffer.byteLength(message.dst, "utf16le") +
    payloadByteSize(message.payload)
  );
}

export interface IMessageQueue {
  getLastReadAt(): number;

  size(): number;

  byteSize(): number;

  addMessage(message: IMessage, byteSize?: number): void;

  readMessage(): IMessage | undefined;

  getMessages(): IMessage[];
}

export class MessageQueue implements IMessageQueue {
  private lastReadAt: number = new Date().getTime();
  private readonly messages: IMessage[] = [];
  // Byte size of each entry in `messages`, pushed and shifted in lockstep, plus
  // their running total. This lets the relay bound a queue's resident bytes
  // without rescanning a payload: each message's size is measured exactly once
  // (on enqueue) and reused on read, so `messageByteSize` is never recomputed.
  // Reads decrement the total, so a queue a reconnecting peer drains can accept
  // fresh frames again rather than staying wedged at the cap.
  private readonly messageSizes: number[] = [];
  private bytes = 0;

  public getLastReadAt(): number {
    return this.lastReadAt;
  }

  public size(): number {
    return this.messages.length;
  }

  public byteSize(): number {
    return this.bytes;
  }

  public addMessage(
    message: IMessage,
    byteSize: number = messageByteSize(message),
  ): void {
    this.bytes += byteSize;
    this.messages.push(message);
    this.messageSizes.push(byteSize);
  }

  public readMessage(): IMessage | undefined {
    if (this.messages.length > 0) {
      this.lastReadAt = new Date().getTime();
      this.bytes -= this.messageSizes.shift() ?? 0;
      return this.messages.shift();
    }

    return undefined;
  }

  public getMessages(): IMessage[] {
    return this.messages;
  }
}
