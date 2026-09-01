import { Buffer } from "node:buffer";
import type { IMessage } from "./message.ts";

/**
 * A signaling frame in the form the relay queue holds it -- every field a
 * string, the payload serialized -- paired with the resident bytes those
 * strings occupy. Pairing the two is what makes `MAX_QUEUE_BYTES` a bound on
 * real memory rather than on a proxy for it: the bytes counted on the way in
 * are the bytes retained, so a queued frame cannot occupy a multiple of what it
 * was charged.
 */
export interface SerializedFrame {
  readonly message: IMessage;
  readonly byteSize: number;
  /**
   * Which form the payload was held in, so delivery returns the one the sender
   * sent: `"json"` for a structure held as its JSON text, `"string"` for a
   * payload that was already a string and is held verbatim. A string payload is
   * deliberately not JSON-quoted -- the two quote characters are residency the
   * frame never carried on the wire, and the largest wire-legal frame between
   * two rendezvous ids accounts to within two bytes of `MAX_QUEUE_BYTES`, so
   * quoting alone would make it unholdable and break the property that any
   * single legal frame can be held.
   */
  readonly payloadKind: "string" | "json";
}

/**
 * Resident byte size of a serialized frame, summed over its string fields.
 * Measured as UTF-16 code units times two (`utf16le`), not UTF-8, because V8
 * stores a JavaScript string as two bytes per code unit the moment it holds any
 * non-Latin1 character (>= U+0100): a UTF-8 measure undercounts such a payload
 * by up to 2x, letting it occupy roughly twice its measured size in the heap.
 * Counting the worst-case two-byte residency bounds a relay reconnect queue's
 * actual memory regardless of payload charset (see `MAX_QUEUE_BYTES`). The
 * payload dominates; `type`/`src`/`dst` are short ids.
 */
function frameByteSize(message: IMessage): number {
  return (
    Buffer.byteLength(message.type, "utf16le") +
    Buffer.byteLength(message.src, "utf16le") +
    Buffer.byteLength(message.dst, "utf16le") +
    (message.payload === undefined
      ? 0
      : Buffer.byteLength(message.payload, "utf16le"))
  );
}

/**
 * Serialize a frame into the form the queue holds it in, accounted at that
 * form's residency. Every real signaling payload -- an SDP offer or answer, an
 * ICE candidate -- reaches the relay as a parsed JSON object, whose heap
 * residency runs a large multiple of the bytes that carried it, so holding the
 * serialization instead is what keeps a queue's accounted bytes equal to its
 * retained ones and leaves the parsed form to the collector. Only the four
 * protocol fields survive, so an extra property hung off a peer's frame is
 * neither retained nor uncounted.
 *
 * A payload that is already a string is held as it arrived rather than quoted,
 * so its accounted residency is the residency it had on the wire; the kind is
 * recorded on the frame and delivery reconstitutes accordingly.
 *
 * `Buffer.byteLength` throws on a non-string `type`, `src`, or `dst`, and a
 * payload with no JSON form is refused rather than sized zero; either way the
 * frame is dropped before it can be queued or key a queue of its own, and the
 * throw surfaces as a `frame-dispatch` diagnostic.
 */
export function serializeFrame(message: IMessage): SerializedFrame {
  const payloadKind = typeof message.payload === "string" ? "string" : "json";
  const payload =
    message.payload === undefined || payloadKind === "string"
      ? message.payload
      : JSON.stringify(message.payload);

  if (payload === undefined && message.payload !== undefined) {
    throw new TypeError("signaling payload has no serialized form");
  }

  const serialized: IMessage = {
    type: message.type,
    src: message.src,
    dst: message.dst,
    payload,
  };

  return {
    message: serialized,
    byteSize: frameByteSize(serialized),
    payloadKind,
  };
}

/**
 * The delivery form of a held frame: a structured payload parsed back out of
 * the string the queue holds, so a peer draining a queue receives what a
 * directly relayed frame would have carried (the transmission handler
 * serializes whatever it is handed). The parse reads this server's own
 * serialization of a value it already parsed off the wire, so it re-admits no
 * structure the receive path did not already accept. A payload held verbatim
 * because it arrived as a string is returned as it is, unparsed. `IMessage`
 * types `payload` as a string, which a structured signaling payload has never
 * been.
 */
function reconstituteFrame({
  message,
  payloadKind,
}: SerializedFrame): IMessage {
  if (message.payload === undefined || payloadKind === "string") return message;

  return {
    ...message,
    payload: JSON.parse(message.payload) as IMessage["payload"],
  };
}

export interface IMessageQueue {
  getLastReadAt(): number;

  size(): number;

  byteSize(): number;

  addMessage(frame: SerializedFrame): void;

  readMessage(): IMessage | undefined;

  getMessages(): SerializedFrame[];
}

export class MessageQueue implements IMessageQueue {
  private lastReadAt: number = new Date().getTime();
  // Each frame carries the byte size it was accounted at, so the running total
  // below is maintained without ever re-measuring a payload: a frame is sized
  // once, where it is serialized. Reads decrement the total, so a queue a
  // reconnecting peer drains can accept fresh frames again rather than staying
  // wedged at the cap.
  private readonly frames: SerializedFrame[] = [];
  private bytes = 0;

  public getLastReadAt(): number {
    return this.lastReadAt;
  }

  public size(): number {
    return this.frames.length;
  }

  public byteSize(): number {
    return this.bytes;
  }

  public addMessage(frame: SerializedFrame): void {
    this.bytes += frame.byteSize;
    this.frames.push(frame);
  }

  public readMessage(): IMessage | undefined {
    const frame = this.frames.shift();

    if (frame === undefined) return undefined;

    this.lastReadAt = new Date().getTime();
    this.bytes -= frame.byteSize;

    return reconstituteFrame(frame);
  }

  public getMessages(): SerializedFrame[] {
    return this.frames;
  }
}
