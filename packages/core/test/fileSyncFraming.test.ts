import { expect, test } from "vitest";

import {
  MESSAGE_ENVELOPE_VERSION,
  MESSAGE_TYPE_OBJECT,
  MESSAGE_TYPE_BINARY,
  MESSAGE_HEADER_BYTES,
  serializeFileSyncMessageHeader,
  serializeFileSyncMessage,
  deserializeFileSyncMessage,
  IncompatibleEnvelopeVersionError,
} from "../src/connection/fileSyncFraming";

// Per-seam contract coverage for the message-framing codec. The pre-split code
// only exercised this behind FileSyncConnection; these tests pin the wire layout
// and the deserialize validation branches directly.

const textPayload = (s: string): Uint8Array => new TextEncoder().encode(s);

test("header is exactly MESSAGE_HEADER_BYTES with version || type || seq layout", () => {
  const header = serializeFileSyncMessageHeader(MESSAGE_TYPE_BINARY, 258);
  expect(header.length).toBe(MESSAGE_HEADER_BYTES);
  expect(MESSAGE_HEADER_BYTES).toBe(10);
  // byte 0: envelope version marker.
  expect(header[0]).toBe(MESSAGE_ENVELOPE_VERSION);
  // byte 1: outer cleartext payload type.
  expect(header[1]).toBe(MESSAGE_TYPE_BINARY);
  // bytes 2..9: 8-byte big-endian sequence number (258 == 0x0102).
  const seq = new DataView(
    header.buffer,
    header.byteOffset,
    header.byteLength,
  ).getBigUint64(2, false);
  expect(seq).toBe(258n);
  expect(header[8]).toBe(0x01);
  expect(header[9]).toBe(0x02);
});

test("whole-message serialization is header || payload with the declared length", () => {
  const payload = textPayload("hello frame");
  const whole = serializeFileSyncMessage(MESSAGE_TYPE_OBJECT, 7, payload);
  expect(whole.length).toBe(MESSAGE_HEADER_BYTES + payload.length);
  // The header prefix matches the header-only serializer for the same type/seq.
  const header = serializeFileSyncMessageHeader(MESSAGE_TYPE_OBJECT, 7);
  expect(whole.subarray(0, MESSAGE_HEADER_BYTES).equals(header)).toBe(true);
  // The payload rides unchanged after the header.
  expect(
    whole.subarray(MESSAGE_HEADER_BYTES).equals(Buffer.from(payload)),
  ).toBe(true);
});

test("round-trips an OBJECT frame, recovering type, seq, and payload", () => {
  const payload = textPayload('{"kind":"hello"}');
  const whole = serializeFileSyncMessage(MESSAGE_TYPE_OBJECT, 3, payload);
  const decoded = deserializeFileSyncMessage(whole);
  expect(decoded.type).toBe(MESSAGE_TYPE_OBJECT);
  expect(decoded.seq).toBe(3);
  expect(Buffer.from(decoded.payload).equals(Buffer.from(payload))).toBe(true);
});

test("round-trips a BINARY frame, recovering type, seq, and payload", () => {
  const payload = new Uint8Array([0, 1, 2, 253, 254, 255]);
  const whole = serializeFileSyncMessage(MESSAGE_TYPE_BINARY, 42, payload);
  const decoded = deserializeFileSyncMessage(whole);
  expect(decoded.type).toBe(MESSAGE_TYPE_BINARY);
  expect(decoded.seq).toBe(42);
  expect(Buffer.from(decoded.payload).equals(Buffer.from(payload))).toBe(true);
});

test("round-trips a seq that exercises the BigInt path (above 2^32)", () => {
  // A seq beyond 32 bits touches the high word of the 8-byte big-endian field,
  // so the DataView/BigInt encode and decode must agree end to end.
  const seq = 2 ** 40 + 12345;
  const payload = textPayload("wide-seq");
  const whole = serializeFileSyncMessage(MESSAGE_TYPE_BINARY, seq, payload);
  const decoded = deserializeFileSyncMessage(whole);
  expect(decoded.seq).toBe(seq);
  expect(Buffer.from(decoded.payload).equals(Buffer.from(payload))).toBe(true);
});

test("rejects a truncated frame shorter than the header", () => {
  const short = new Uint8Array(MESSAGE_HEADER_BYTES - 1);
  short[0] = MESSAGE_ENVELOPE_VERSION;
  expect(() => deserializeFileSyncMessage(short)).toThrow(
    "message envelope is shorter than its header",
  );
});

test("rejects an unrecognized envelope version with IncompatibleEnvelopeVersionError", () => {
  const whole = serializeFileSyncMessage(
    MESSAGE_TYPE_OBJECT,
    0,
    textPayload("x"),
  );
  whole[0] = MESSAGE_ENVELOPE_VERSION + 1;
  let caught: unknown;
  try {
    deserializeFileSyncMessage(whole);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(IncompatibleEnvelopeVersionError);
  expect((caught as IncompatibleEnvelopeVersionError).foundVersion).toBe(
    MESSAGE_ENVELOPE_VERSION + 1,
  );
});

test("rejects an unknown payload type", () => {
  const whole = serializeFileSyncMessage(
    MESSAGE_TYPE_BINARY,
    0,
    textPayload("x"),
  );
  whole[1] = 9;
  expect(() => deserializeFileSyncMessage(whole)).toThrow(
    "unknown message payload type 9",
  );
});

test("rejects a sequence number above the safe-integer range", () => {
  const whole = serializeFileSyncMessage(
    MESSAGE_TYPE_BINARY,
    0,
    textPayload("x"),
  );
  // Overwrite bytes 2..9 with 2^53 + 1, one past Number.MAX_SAFE_INTEGER.
  new DataView(whole.buffer, whole.byteOffset, whole.byteLength).setBigUint64(
    2,
    BigInt(Number.MAX_SAFE_INTEGER) + 1n,
    false,
  );
  expect(() => deserializeFileSyncMessage(whole)).toThrow(
    "message envelope sequence number exceeds safe range",
  );
});
