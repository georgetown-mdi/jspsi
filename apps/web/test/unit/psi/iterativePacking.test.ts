import { describe, expect, test } from "vitest";

import { pack, unpack } from "peerjs-js-binarypack";

import {
  assertIterativePackingSupported,
  packOutboundFramesIteratively,
} from "../../../src/psi/transport/iterativePacking.js";

import type { Packable, Unpackable } from "peerjs-js-binarypack";
import type { DataConnection } from "peerjs";

// The send-side override, driven through a stand-in that reproduces the PeerJS
// binary DataConnection's send path: `send` calls `_send`, which either buffers
// the packed frame or hands it to `_sendChunks`, whose envelopes come back
// through `send` already chunked. The bytes the stand-in collects are what would
// reach the data channel, so they are compared against the real
// `peerjs-js-binarypack` packer -- the decoder on a partner's side.

const CHUNKED_MTU = 16_300;

/** The real packer's bytes for `value`. `pack` returns a promise only for a
 * `Blob`, which no frame here is, so the synchronous branch is the only
 * reachable one -- asserted rather than assumed, since an awaited-by-accident
 * promise would compare `[object Promise]` against real bytes. */
function libraryBytes(value: unknown): Uint8Array {
  const packed = pack(value as Packable);
  if (packed instanceof Promise) {
    throw new Error("BinaryPack packed a probe value asynchronously");
  }
  return new Uint8Array(packed);
}

/** The PeerJS binary DataConnection's send path, with the same internal names
 * and the same chunk envelope. Pinned from `peerjs` 1.5.5; the override asserts
 * these members exist on the real connection before replacing `_send`. */
class SendPathStandIn {
  readonly datagrams: Array<Uint8Array> = [];
  chunker = { chunkedMTU: CHUNKED_MTU, dataCount: 1 };

  send(data: unknown, chunked = false): void {
    this._send(data, chunked);
  }

  _send(data: unknown, chunked: boolean): void {
    const packed = pack(data as Packable) as ArrayBuffer;
    if (!chunked && packed.byteLength > this.chunker.chunkedMTU) {
      this._sendChunks(packed);
      return;
    }
    this._bufferedSend(packed);
  }

  _sendChunks(packed: ArrayBuffer): void {
    const total = Math.ceil(packed.byteLength / this.chunker.chunkedMTU);
    const messageId = this.chunker.dataCount;
    this.chunker.dataCount += 1;
    let index = 0;
    for (
      let start = 0;
      start < packed.byteLength;
      start += this.chunker.chunkedMTU
    ) {
      this.send(
        {
          __peerData: messageId,
          n: index,
          data: packed.slice(
            start,
            Math.min(packed.byteLength, start + this.chunker.chunkedMTU),
          ),
          total,
        },
        true,
      );
      index += 1;
    }
  }

  _bufferedSend(packed: ArrayBuffer): void {
    this.datagrams.push(new Uint8Array(packed));
  }
}

function standIn(): { fake: SendPathStandIn; conn: DataConnection } {
  const fake = new SendPathStandIn();
  return { fake, conn: fake as unknown as DataConnection };
}

function concatBytes(parts: Array<Uint8Array>): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

/** The frame bytes the collected datagrams carry: either the single datagram, or
 * the chunk envelopes' payloads in ordinal order, as a receiving PeerJS peer
 * reassembles them. */
function reassemble(datagrams: Array<Uint8Array>): Uint8Array {
  if (datagrams.length === 1) return datagrams[0];
  const slices = datagrams.map((datagram) => {
    const envelope = unpack<Unpackable>(datagram as unknown as ArrayBuffer) as {
      __peerData: number;
      n: number;
      total: number;
      data: ArrayBuffer;
    };
    expect(envelope.total).toBe(datagrams.length);
    return { index: envelope.n, bytes: new Uint8Array(envelope.data) };
  });
  slices.sort((a, b) => a.index - b.index);
  return concatBytes(slices.map((slice) => slice.bytes));
}

const iterationMap = (n: number) =>
  Array.from({ length: n }, (_, index) => ({
    theirIndex: index,
    iteration: index % 3,
  }));

describe("packOutboundFramesIteratively", () => {
  test("puts the pinned packer's bytes on the wire for an unchunked frame", () => {
    const { fake, conn } = standIn();
    packOutboundFramesIteratively(conn);

    const frame = { kexMsg: "1", e: "BASE64", reqEnc: false };
    fake.send(frame);

    expect(fake.datagrams).toHaveLength(1);
    expect(fake.datagrams[0]).toEqual(libraryBytes(frame));
  });

  test("chunks through the connection's own chunker above the MTU", () => {
    const { fake, conn } = standIn();
    packOutboundFramesIteratively(conn);

    const frame = iterationMap(5_000);
    fake.send(frame);

    expect(fake.datagrams.length).toBeGreaterThan(1);
    for (const datagram of fake.datagrams) {
      expect(datagram.byteLength).toBeLessThanOrEqual(CHUNKED_MTU + 64);
    }
    expect(reassemble(fake.datagrams)).toEqual(libraryBytes(frame));
  });

  test("sends a frame the pinned packer overflows the stack on", () => {
    const { fake, conn } = standIn();
    const frame = iterationMap(200_000);
    expect(() => pack(frame as Packable)).toThrow(RangeError);

    packOutboundFramesIteratively(conn);
    fake.send(frame);

    const reassembled = reassemble(fake.datagrams);
    expect(unpack<Unpackable>(reassembled as unknown as ArrayBuffer)).toEqual(
      frame,
    );
  });

  test("leaves the in-band close sentinel byte-identical", () => {
    const { fake, conn } = standIn();
    packOutboundFramesIteratively(conn);

    const sentinel = { __peerData: { type: "close" } };
    fake.send(sentinel);

    expect(fake.datagrams[0]).toEqual(libraryBytes(sentinel));
  });

  // PeerJS's own `_send` hands a Blob to `_send_blob`, packing it
  // asynchronously; the replacement has no such path, so the Blob is refused
  // before a datagram exists (docs/spec/DEPENDENCY_PINS.md).
  test("refuses a Blob rather than taking the dropped async send path", () => {
    const { fake, conn } = standIn();
    packOutboundFramesIteratively(conn);

    expect(() => fake.send(new Blob(["frame"]))).toThrowError(
      /an outbound frame holding an instance of Blob/,
    );
    expect(fake.datagrams).toHaveLength(0);
  });

  test("refuses a value kind the wire does not carry", () => {
    const { fake, conn } = standIn();
    packOutboundFramesIteratively(conn);

    expect(() => fake.send({ when: new Date(0) })).toThrowError(
      /cannot BinaryPack an outbound frame/,
    );
    expect(fake.datagrams).toHaveLength(0);
  });

  test("refuses an object that holds itself, emitting nothing", () => {
    const { fake, conn } = standIn();
    packOutboundFramesIteratively(conn);

    const frame: Record<string, unknown> = { theirIndex: 0 };
    frame.parent = frame;
    expect(() => fake.send(frame)).toThrowError(
      /an outbound frame that holds itself/,
    );
    expect(fake.datagrams).toHaveLength(0);
  });

  test("refuses an array that holds itself, emitting nothing", () => {
    const { fake, conn } = standIn();
    packOutboundFramesIteratively(conn);

    const frame: Array<unknown> = [1];
    frame.push(frame);
    expect(() => fake.send(frame)).toThrowError(
      /an outbound frame that holds itself/,
    );
    expect(fake.datagrams).toHaveLength(0);
  });
});

describe("assertIterativePackingSupported", () => {
  /** The four members the override replaces or calls, as a fresh object each
   * test can drop one member from. */
  function sendInternals(): Record<string, unknown> {
    return {
      _send: () => {},
      _sendChunks: () => {},
      _bufferedSend: () => {},
      chunker: { chunkedMTU: CHUNKED_MTU },
    };
  }

  for (const missing of Object.keys(sendInternals())) {
    test(`fails loud when peerjs no longer exposes ${missing}`, () => {
      const probe = sendInternals();
      delete probe[missing];
      expect(() =>
        assertIterativePackingSupported(probe as unknown as DataConnection),
      ).toThrow(/send internals/);
    });
  }

  test("fails loud when the chunker no longer states its MTU", () => {
    const probe = sendInternals();
    probe.chunker = {};
    expect(() =>
      assertIterativePackingSupported(probe as unknown as DataConnection),
    ).toThrow(/send internals/);
  });

  /** A member kept under its own name but holding something the override cannot
   * call or compare, as a `peerjs` restructuring that reuses a name would leave
   * it: the assert reads the type, not just the presence. */
  const wrongTypes: Array<{
    label: string;
    replace: (probe: Record<string, unknown>) => void;
  }> = [
    {
      label: "_send is not a function",
      replace: (probe) => {
        probe._send = 1;
      },
    },
    {
      label: "_sendChunks is not a function",
      replace: (probe) => {
        probe._sendChunks = "sendChunks";
      },
    },
    {
      label: "_bufferedSend is not a function",
      replace: (probe) => {
        probe._bufferedSend = { send: () => {} };
      },
    },
    {
      label: "chunker.chunkedMTU is not a number",
      replace: (probe) => {
        probe.chunker = { chunkedMTU: String(CHUNKED_MTU) };
      },
    },
  ];

  for (const { label, replace } of wrongTypes) {
    test(`fails loud when ${label}`, () => {
      const probe = sendInternals();
      replace(probe);
      expect(() =>
        assertIterativePackingSupported(probe as unknown as DataConnection),
      ).toThrow(/send internals/);
    });
  }

  test("passes on a connection exposing all four", () => {
    const { conn } = standIn();
    expect(() => assertIterativePackingSupported(conn)).not.toThrow();
  });
});
