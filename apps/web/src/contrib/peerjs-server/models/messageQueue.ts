import { Buffer } from "node:buffer";
import type { IMessage } from "./message.ts";

/**
 * UTF-8 byte size of a queued signaling message, summed over its string fields.
 * The optional `payload` dominates; `type`/`src`/`dst` are short ids. Used to
 * bound a relay reconnect queue's resident bytes (see `MAX_QUEUE_BYTES`),
 * measured in the same UTF-8 bytes as the inbound frame cap so the two bounds
 * speak the same units.
 */
export function messageByteSize(message: IMessage): number {
  return (
    Buffer.byteLength(message.type, "utf8") +
    Buffer.byteLength(message.src, "utf8") +
    Buffer.byteLength(message.dst, "utf8") +
    (message.payload ? Buffer.byteLength(message.payload, "utf8") : 0)
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
