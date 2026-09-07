import { describe, expect, test } from "vitest";

import {
  WEBRTC_INBOUND_FRAME_FIXTURES,
  packValue as packWithTheLibrary,
  unpackFrame,
} from "@psilink/testkit/webrtcInboundFrames";

import { packValue } from "../../../src/connection/webrtc/peerjsWire";

// The outbound counterpart of webrtcInboundParity.test.ts: the shared frame set
// is decoded and re-encoded, once by the pinned `peerjs-js-binarypack` packer a
// partner decodes with and once by the CLI's own send path, and the two byte
// strings must agree. The set is `@psilink/testkit/webrtcInboundFrames`, shared
// with the web app's inbound suite, so one corpus covers both directions and
// every marker it holds.
//
// A fixture the library cannot re-encode -- its own recursion ceiling is why the
// CLI no longer calls it -- is held by a round trip through the real unpacker
// instead, and that fixture is named in a test of its own so one silently
// changing class shows up.

function libraryBytesOrUndefined(value: unknown): Uint8Array | undefined {
  try {
    return packWithTheLibrary(value);
  } catch {
    return undefined;
  }
}

describe("the CLI send path re-encodes the shared frame set as the library does", () => {
  for (const fixture of WEBRTC_INBOUND_FRAME_FIXTURES) {
    test(fixture.label, () => {
      const decoded = unpackFrame(fixture.frame);
      const ours = packValue(decoded);
      const theirs = libraryBytesOrUndefined(decoded);

      if (theirs === undefined) {
        expect(unpackFrame(ours)).toEqual(decoded);
        return;
      }
      expect(Buffer.from(ours).toString("hex")).toBe(
        Buffer.from(theirs).toString("hex"),
      );
    });
  }

  test("names the fixtures the pinned packer itself cannot re-encode", () => {
    const beyondReach = WEBRTC_INBOUND_FRAME_FIXTURES.filter(
      (fixture) =>
        libraryBytesOrUndefined(unpackFrame(fixture.frame)) === undefined,
    ).map((fixture) => fixture.label);
    expect(beyondReach).toEqual([
      "an array32 declaring a million elements over one packed value",
    ]);
  });
});
