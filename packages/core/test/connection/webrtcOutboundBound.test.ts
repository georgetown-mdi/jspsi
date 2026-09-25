import { expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import {
  MAX_WEBRTC_FRAME_BYTES,
  MIN_CHUNK_RESIDENT_BYTES,
} from "../../src/connection/binaryPackBounds";
import { encodeBinaryPackValue } from "../../src/connection/binaryPackEncode";
import {
  PEERJS_CHUNK_MTU,
  PSI_ENCODED_ELEMENT_BYTES,
  binaryPackByteStringLength,
  builtSetTooLargeMessage,
  minimumPsiSetFrameBytes,
  roundOneSetTooLargeMessage,
  webrtcFrameExceedsBound,
  webrtcFrameReceiveCharge,
} from "../../src/connection/webrtcOutboundBound";
import { InProcessPsiEngine } from "../../src/psi/psiEngine";

const psiLibrary = await PSI();

// The largest frame, and the largest set, the bound admits. Derived by walking
// the charge rather than restated from the spec, and pinned so a change to the
// charge or the bound is a deliberate edit here and in docs/spec/PROTOCOL.md.
function largestAdmitted(fits: (n: number) => boolean, upper: number): number {
  let lo = 0;
  let hi = upper;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

test("a byte array packs to the length the encoder writes", () => {
  for (const length of [0, 1, 15, 16, 0xffff, 0x10000, 70_000]) {
    expect(binaryPackByteStringLength(length)).toBe(
      encodeBinaryPackValue(new Uint8Array(length)).byteLength,
    );
  }
});

test("the charge covers the widest chunk envelope PeerJS can write", () => {
  // The envelope PeerJS wraps each slice in, with every integer at the widest
  // marker BinaryPack has: the most any chunk of a frame can cost a receiver
  // that counts whole datagrams.
  const widest = 2 ** 52;
  const envelope = (slice: number): number =>
    encodeBinaryPackValue({
      __peerData: widest,
      n: widest,
      data: new Uint8Array(slice),
      total: widest,
    }).byteLength;
  const charged = (slice: number): number =>
    Math.max(envelope(slice), MIN_CHUNK_RESIDENT_BYTES);
  for (const lastSlice of [1, 15, 16, 200, 250, PEERJS_CHUNK_MTU]) {
    for (const chunks of [2, 3, 17]) {
      const frame = (chunks - 1) * PEERJS_CHUNK_MTU + lastSlice;
      expect(webrtcFrameReceiveCharge(frame)).toBeGreaterThanOrEqual(
        (chunks - 1) * charged(PEERJS_CHUNK_MTU) + charged(lastSlice),
      );
    }
  }
  // Exact for a full slice: the charge is the widest envelope, no more.
  expect(webrtcFrameReceiveCharge(2 * PEERJS_CHUNK_MTU)).toBe(
    2 * charged(PEERJS_CHUNK_MTU),
  );
});

test("a frame sent whole is charged its own length", () => {
  expect(webrtcFrameReceiveCharge(PEERJS_CHUNK_MTU)).toBe(PEERJS_CHUNK_MTU);
  expect(webrtcFrameReceiveCharge(PEERJS_CHUNK_MTU + 1)).toBeGreaterThan(
    PEERJS_CHUNK_MTU + 1,
  );
});

test("the frame bound refuses one byte over the largest frame it admits", () => {
  const largest = largestAdmitted(
    (bytes) => !webrtcFrameExceedsBound(bytes),
    MAX_WEBRTC_FRAME_BYTES,
  );
  expect(largest).toBe(267_532_686);
  expect(webrtcFrameExceedsBound(largest - 1)).toBe(false);
  expect(webrtcFrameExceedsBound(largest)).toBe(false);
  expect(webrtcFrameExceedsBound(largest + 1)).toBe(true);
  // Below the bound, by the chunk envelopes a receiver may charge.
  expect(largest).toBeLessThan(MAX_WEBRTC_FRAME_BYTES);
});

test("the count check refuses one element over the largest set it admits", () => {
  const largest = largestAdmitted(
    (n) => !webrtcFrameExceedsBound(minimumPsiSetFrameBytes(n)),
    MAX_WEBRTC_FRAME_BYTES,
  );
  expect(largest).toBe(7_643_790);
  expect(webrtcFrameExceedsBound(minimumPsiSetFrameBytes(largest - 1))).toBe(
    false,
  );
  expect(webrtcFrameExceedsBound(minimumPsiSetFrameBytes(largest))).toBe(false);
  expect(webrtcFrameExceedsBound(minimumPsiSetFrameBytes(largest + 1))).toBe(
    true,
  );
});

test("no set frame the PSI library builds is shorter than the count check assumes", async () => {
  // The count check refuses on the fewest bytes a set of its count can take, so
  // it holds only while every frame the library builds is at least that long.
  // Driven against the real serializer, every message a round sends a set in.
  for (const n of [0, 1, 4, 100, 1000]) {
    const values = Array.from({ length: n }, (_unused, i) => `value-${i}`);
    const sender = new InProcessPsiEngine(
      psiLibrary,
      "starter",
      "server",
      "identifier-revealing",
    );
    const receiver = new InProcessPsiEngine(
      psiLibrary,
      "joiner",
      "client",
      "identifier-revealing",
    );
    const { setup } = await sender.createServerSetup(values);
    const request = await receiver.createClientRequest(values);
    const response = await sender.processClientRequest(request);
    for (const frame of [setup, request, response])
      expect(
        binaryPackByteStringLength(frame.byteLength),
      ).toBeGreaterThanOrEqual(minimumPsiSetFrameBytes(n));
    // The response is exactly the per-element bytes: the bound is tight.
    expect(response.byteLength).toBe(n * PSI_ENCODED_ELEMENT_BYTES);
    sender.dispose();
    receiver.dispose();
  }
});

test("a refusal states a size over the bound it names", () => {
  // Rounded up, so a frame one byte over never displays as equal to the bound.
  const oneOver = largestAdmittedFrame() + 1;
  const message = builtSetTooLargeMessage("local", oneOver);
  expect(message).toContain("256.1 MiB");
  expect(message).toContain("256 MiB one WebRTC message can hold");
  expect(message).toMatch(/Split the input/);
  expect(builtSetTooLargeMessage("partner", oneOver)).toMatch(
    /Ask your partner to split their input/,
  );
  expect(roundOneSetTooLargeMessage(7_643_791)).toMatch(
    /at least 7643791 values to send, a set of at least 256.1 MiB, over the 256 MiB/,
  );
  // Under a mebibyte the figures are exact.
  expect(builtSetTooLargeMessage("local", 1001, 1000)).toContain(
    "is 1001 bytes, over the 1000 bytes",
  );
});

function largestAdmittedFrame(): number {
  return largestAdmitted(
    (bytes) => !webrtcFrameExceedsBound(bytes),
    MAX_WEBRTC_FRAME_BYTES,
  );
}
