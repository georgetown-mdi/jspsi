// The send-side half of the WebRTC data-channel BinaryPack wire
// (docs/spec/WEBRTC_TRANSPORT.md): an encoder that walks a frame with an
// explicit stack instead of the call stack, so the number of elements a frame
// holds is bounded by memory rather than by the JavaScript stack depth.
//
// It exists because `peerjs-js-binarypack`'s own `pack` descends one call frame
// per element, which overflows the stack a few thousand records into a matched
// set -- on the sender, after both parties have paid for the PSI compute. The
// receive side (connection/binaryPackBounds.ts and the reassembly wrapper it
// parameterizes) already admits frames orders of magnitude larger.
//
// The wire is unchanged: this emits the bytes the pinned packer emits, marker
// for marker, so a party running the library alone still reads every frame this
// produces. The library is the ORACLE for that claim and not a runtime
// dependency, the same arrangement as the inbound structural scan beside it:
// test/connection/binaryPackEncodeDifferential.test.ts encodes each shape both
// ways and compares bytes, so a pinned-version bump that moves the encoding
// fails there rather than at a partner's browser
// (docs/spec/DEPENDENCY_PINS.md).
//
// A value kind the library encodes but psilink never sends -- a Date, a class
// instance, a Blob -- is refused rather than guessed at, since a guess that
// misses is a silently corrupt frame.

import { ConnectionError } from "./messageConnection";

/**
 * Longest array, map, string or byte string BinaryPack can declare: its widest
 * container header is a 32-bit count.
 */
const MAX_BINARY_PACK_LENGTH = 0xffffffff;

/** Reused across frames, as the library reuses one per packed value. */
const utf8Encoder = new TextEncoder();

/** An outbound value this encoder will not guess at. */
function unsupportedValueError(description: string): ConnectionError {
  return new ConnectionError(
    `cannot BinaryPack an outbound frame holding ${description}; the WebRTC ` +
      "wire carries only null, booleans, numbers, strings, byte arrays, " +
      "arrays and plain objects",
    "usage",
  );
}

/** Names an unsupported value for {@link unsupportedValueError}, by type rather
 * than by content: the frame is this side's own, but its message reaches a
 * console, and a value's own text has no place there. */
function describeValue(value: unknown): string {
  if (typeof value !== "object" || value === null) return `a ${typeof value}`;
  const constructorName = (value as { constructor?: { name?: unknown } })
    .constructor?.name;
  return typeof constructorName === "string" && constructorName.length > 0
    ? `an instance of ${constructorName}`
    : "an object with no prototype";
}

/** A growable byte buffer. Doubling rather than a list of pieces joined at the
 * end: a record-scaling frame has one piece per element, and the piece list
 * costs more than the copies the doubling makes. */
class ByteSink {
  private buffer = new Uint8Array(1024);
  private length = 0;

  private reserve(additional: number): void {
    if (this.length + additional <= this.buffer.length) return;
    let capacity = this.buffer.length;
    while (capacity < this.length + additional) capacity *= 2;
    const grown = new Uint8Array(capacity);
    grown.set(this.buffer.subarray(0, this.length));
    this.buffer = grown;
  }

  /** Appends one byte, truncated to eight bits exactly as the library's own
   * buffer builder does when it converts its number list to bytes. */
  byte(value: number): void {
    this.reserve(1);
    this.buffer[this.length] = value;
    this.length += 1;
  }

  bytes(view: Uint8Array): void {
    this.reserve(view.length);
    this.buffer.set(view, this.length);
    this.length += view.length;
  }

  uint16BigEndian(value: number): void {
    this.byte(value >> 8);
    this.byte(value & 0xff);
  }

  uint32BigEndian(value: number): void {
    this.byte((value >>> 24) & 0xff);
    this.byte((value & 0x00ff0000) >>> 16);
    this.byte((value & 0x0000ff00) >>> 8);
    this.byte(value & 0x000000ff);
  }

  toArrayBuffer(): ArrayBuffer {
    return this.length === this.buffer.byteLength
      ? this.buffer.buffer
      : this.buffer.buffer.slice(0, this.length);
  }
}

/** Is `value` one of the byte-array shapes BinaryPack writes as a byte string? */
function isByteArray(value: object): value is ArrayBufferView {
  return "BYTES_PER_ELEMENT" in value;
}

/** Is `value` a plain object, the only shape BinaryPack writes as a map here?
 * A class instance is one to the library and is refused here instead: psilink
 * sends none, and admitting one would encode whatever own keys it happened to
 * have. */
function isPlainObject(value: object): value is Record<string, unknown> {
  return value.constructor === Object;
}

/** One container whose elements are still to be written, held on the encoder's
 * own stack in place of a call frame. */
type PendingContainer =
  | { readonly elements: Array<unknown>; index: number }
  | {
      readonly source: Record<string, unknown>;
      readonly keys: Array<string>;
      index: number;
    };

function isPendingArray(
  container: PendingContainer,
): container is { readonly elements: Array<unknown>; index: number } {
  return "elements" in container;
}

/**
 * BinaryPack-encode `value` into the bytes the pinned `peerjs-js-binarypack`
 * `pack` produces for it, walking arrays and objects with an explicit stack so
 * a frame's element count cannot overflow the JavaScript stack.
 *
 * The return type matches the library's: an `ArrayBuffer` holding exactly the
 * encoded bytes, ready to hand to a data channel or to a chunker.
 *
 * @param value  The frame to encode: null, a boolean, a number, a string, a
 *               `Uint8Array`/`ArrayBuffer`, or an array or plain object of
 *               those, nested to any depth.
 * @throws {ConnectionError} of kind `usage` on any other value kind (a Date, a
 *         Map, a class instance, a function), and on a container, string or
 *         byte string longer than a 32-bit count can declare.
 */
export function encodeBinaryPackValue(value: unknown): ArrayBuffer {
  const sink = new ByteSink();
  const stack: Array<PendingContainer> = [];

  const writeString = (text: string): void => {
    const encoded = utf8Encoder.encode(text);
    const length = encoded.length;
    if (length <= 0x0f) {
      sink.byte(0xb0 + length);
    } else if (length <= 0xffff) {
      sink.byte(0xd8);
      sink.uint16BigEndian(length);
    } else if (length <= MAX_BINARY_PACK_LENGTH) {
      sink.byte(0xd9);
      sink.uint32BigEndian(length);
    } else {
      throw unsupportedValueError("a string too long to declare");
    }
    sink.bytes(encoded);
  };

  const writeByteString = (view: Uint8Array): void => {
    const length = view.length;
    if (length <= 0x0f) {
      sink.byte(0xa0 + length);
    } else if (length <= 0xffff) {
      sink.byte(0xda);
      sink.uint16BigEndian(length);
    } else if (length <= MAX_BINARY_PACK_LENGTH) {
      sink.byte(0xdb);
      sink.uint32BigEndian(length);
    } else {
      throw unsupportedValueError("a byte array too long to declare");
    }
    sink.bytes(view);
  };

  // The library's integer ladder, in its order: each branch is the first whose
  // range holds the value, so a small positive number takes an unsigned marker
  // and a small negative one a signed marker of the same width.
  const writeInteger = (num: number): void => {
    if (num >= -0x20 && num <= 0x7f) {
      sink.byte(num & 0xff);
    } else if (num >= 0x00 && num <= 0xff) {
      sink.byte(0xcc);
      sink.byte(num);
    } else if (num >= -0x80 && num <= 0x7f) {
      sink.byte(0xd0);
      sink.byte(num & 0xff);
    } else if (num >= 0x0000 && num <= 0xffff) {
      sink.byte(0xcd);
      sink.uint16BigEndian(num);
    } else if (num >= -0x8000 && num <= 0x7fff) {
      sink.byte(0xd1);
      sink.byte((num & 0xff00) >> 8);
      sink.byte(num & 0xff);
    } else if (num >= 0x00000000 && num <= 0xffffffff) {
      sink.byte(0xce);
      sink.uint32BigEndian(num & 0xffffffff);
    } else if (num >= -0x80000000 && num <= 0x7fffffff) {
      sink.byte(0xd2);
      sink.uint32BigEndian(num);
    } else if (num >= -0x8000000000000000 && num <= 0x7fffffffffffffff) {
      sink.byte(0xd3);
      sink.uint32BigEndian(Math.floor(num / 2 ** 32));
      sink.uint32BigEndian(num % 2 ** 32);
    } else if (num >= 0x0000000000000000 && num <= 0xffffffffffffffff) {
      sink.byte(0xcf);
      sink.uint32BigEndian(num / 2 ** 32);
      sink.uint32BigEndian(num % 2 ** 32);
    } else {
      throw unsupportedValueError("a number outside the integer range");
    }
  };

  // The library's own double layout, arithmetic included: it takes the exponent
  // from a logarithm and the fraction from a truncating multiply rather than
  // reading the IEEE-754 bits, so reading the bits here would diverge on the
  // values where those two disagree.
  const writeDouble = (value: number): void => {
    let magnitude = value;
    let sign = 0;
    if (magnitude < 0) {
      sign = 1;
      magnitude = -magnitude;
    }
    const exponent = Math.floor(Math.log(magnitude) / Math.LN2);
    const fraction = Math.floor((magnitude / 2 ** exponent - 1) * 2 ** 52);
    const high =
      (sign << 31) |
      ((exponent + 1023) << 20) |
      ((fraction / 2 ** 32) & 0x0fffff);
    sink.byte(0xcb);
    sink.uint32BigEndian(high);
    sink.uint32BigEndian(fraction % 2 ** 32);
  };

  // Writes `next` whole when it is a leaf, or writes its header and pushes it
  // when it is a container. The stack below then drains the container, so
  // nesting costs a stack entry rather than a call frame.
  const writeValueOrDescend = (next: unknown): void => {
    if (typeof next === "string") {
      writeString(next);
      return;
    }
    if (typeof next === "number") {
      if (Math.floor(next) === next) writeInteger(next);
      else writeDouble(next);
      return;
    }
    if (typeof next === "boolean") {
      sink.byte(next ? 0xc3 : 0xc2);
      return;
    }
    if (next === undefined || next === null) {
      sink.byte(0xc0);
      return;
    }
    if (typeof next !== "object") {
      throw unsupportedValueError(describeValue(next));
    }
    // `instanceof Array`, not `Array.isArray`: the library dispatches on the
    // former, and an array from another realm -- true for one, false for the
    // other -- must be refused here rather than written as an array the library
    // would have refused.
    if (next instanceof Array) {
      const length = next.length;
      if (length <= 0x0f) {
        sink.byte(0x90 + length);
      } else if (length <= 0xffff) {
        sink.byte(0xdc);
        sink.uint16BigEndian(length);
      } else if (length <= MAX_BINARY_PACK_LENGTH) {
        sink.byte(0xdd);
        sink.uint32BigEndian(length);
      } else {
        throw unsupportedValueError("an array too long to declare");
      }
      stack.push({ elements: next, index: 0 });
      return;
    }
    if (next instanceof ArrayBuffer) {
      writeByteString(new Uint8Array(next));
      return;
    }
    if (isByteArray(next)) {
      writeByteString(
        new Uint8Array(next.buffer, next.byteOffset, next.byteLength),
      );
      return;
    }
    if (!isPlainObject(next)) {
      throw unsupportedValueError(describeValue(next));
    }
    const keys = Object.keys(next);
    const length = keys.length;
    if (length <= 0x0f) {
      sink.byte(0x80 + length);
    } else if (length <= 0xffff) {
      sink.byte(0xde);
      sink.uint16BigEndian(length);
    } else if (length <= MAX_BINARY_PACK_LENGTH) {
      sink.byte(0xdf);
      sink.uint32BigEndian(length);
    } else {
      throw unsupportedValueError("an object with too many keys to declare");
    }
    stack.push({ source: next, keys, index: 0 });
  };

  writeValueOrDescend(value);
  while (stack.length > 0) {
    const container = stack[stack.length - 1];
    if (isPendingArray(container)) {
      if (container.index >= container.elements.length) {
        stack.pop();
        continue;
      }
      writeValueOrDescend(container.elements[container.index]);
      container.index += 1;
    } else {
      if (container.index >= container.keys.length) {
        stack.pop();
        continue;
      }
      const key = container.keys[container.index];
      container.index += 1;
      writeString(key);
      writeValueOrDescend(container.source[key]);
    }
  }
  return sink.toArrayBuffer();
}
