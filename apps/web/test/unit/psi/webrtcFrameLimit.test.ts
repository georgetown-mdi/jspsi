import { expect, test, vi } from "vitest";

import { default as EventEmitter } from "eventemitter3";
import PSI from "@openmined/psi.js";

import { util } from "peerjs";

import {
  InProcessPsiEngine,
  MAX_WEBRTC_FRAME_BYTES,
  PEERJS_CHUNK_MTU,
  PSIParticipant,
  WebRtcFrameLimitError,
} from "@alcove/core";
import {
  binaryPackByteStringLength,
  webrtcFrameReceiveCharge,
} from "@alcove/core/testing";

import { failureFor } from "@exchange/useInviterExchange";
import { openPeerMessageConnection } from "@psi/transport/peerMessageConnection";

import type { DataConnection } from "peerjs";

// The browser's half of the sender-side WebRTC frame bound: its data channel
// states the bound its own receive path applies, a PSI round over it refuses a
// set frame past that bound before handing it to PeerJS, and the refusal
// reaches the operator as its own alert rather than as a connection problem.

const psiLibrary = await PSI();

/** The PeerJS connection surface openPeerMessageConnection installs on. */
class FakeDataConnection extends EventEmitter {
  open = true;
  peer = "";
  send = vi.fn();
  close = vi.fn();
  _chunkedData: Record<number, unknown> = {};
  _handleChunk = (_chunk: unknown) => {};
  _handleDataMessage = (_message: unknown) => {};
  chunker = { chunkedMTU: 16_300 };
  _send = (_data: unknown, _chunked: boolean) => {};
  _sendChunks = (_packed: ArrayBuffer) => {};
  _bufferedSend = (_packed: ArrayBuffer) => {};
}

function open(maxFrameBytes?: number) {
  const fake = new FakeDataConnection();
  return {
    fake,
    connection: openPeerMessageConnection(fake as unknown as DataConnection, {
      maxFrameBytes,
      closeDrainTimeoutMs: 0,
    }),
  };
}

const SET = Array.from({ length: 150 }, (_unused, i) => `value-${i}`);

/** What the first frame of a starter's round over the browser channel was. */
async function starterFirstFrame(
  bound: number,
): Promise<{ ended: unknown; sent: Array<unknown> }> {
  const { fake, connection } = open(bound);
  const mc = await connection;
  const starter = new PSIParticipant(
    "server",
    psiLibrary,
    { role: "starter", verbose: -1 },
    {
      setup: Number.POSITIVE_INFINITY,
      request: Number.POSITIVE_INFINITY,
      response: Number.POSITIVE_INFINITY,
    },
  );
  const round = starter.identifyIntersection(mc, SET).then(
    () => undefined,
    (err: unknown) => err,
  );
  // A round that sent its setup waits for the partner, which never answers.
  const ended = await Promise.race([
    round,
    new Promise((resolve) => setTimeout(() => resolve("waiting"), 500)),
  ]);
  await mc.close();
  starter.dispose();
  return { ended, sent: fake.send.mock.calls.map(([data]) => data) };
}

test("the check charges chunks at the size the pinned PeerJS splits at", () => {
  expect(util.chunkedMTU).toBe(PEERJS_CHUNK_MTU);
});

test("the browser channel states the receive bound it applies", async () => {
  expect((await open().connection).outboundWebRtcFrameBound?.()).toBe(
    MAX_WEBRTC_FRAME_BYTES,
  );
  expect((await open(4096).connection).outboundWebRtcFrameBound?.()).toBe(4096);
});

test("a set frame one over the bound is refused before PeerJS sees it, and one under and at it is sent", async () => {
  const engine = new InProcessPsiEngine(
    psiLibrary,
    "starter",
    "server",
    "identifier-revealing",
  );
  const { setup } = await engine.createServerSetup(SET);
  engine.dispose();
  const charge = webrtcFrameReceiveCharge(
    binaryPackByteStringLength(setup.byteLength),
  );

  for (const bound of [charge + 1, charge]) {
    const { ended, sent } = await starterFirstFrame(bound);
    expect(ended).toBe("waiting");
    expect(sent).toHaveLength(1);
    expect((sent[0] as Uint8Array).byteLength).toBe(setup.byteLength);
  }

  const { ended, sent } = await starterFirstFrame(charge - 1);
  expect(ended).toBeInstanceOf(WebRtcFrameLimitError);
  // What PeerJS was handed in its place is the abort, not the set.
  expect(sent).toEqual([
    { decision: "abort", abortReasons: [expect.any(String)] },
  ]);
});

test("the refusal is shown as its own alert, with no retry", () => {
  const own = failureFor(
    "exchange",
    new WebRtcFrameLimitError("the set is too large; split the input", "local"),
  );
  expect(own.category).toBe("config");
  expect(own.title).toBe("Your file is too large for a browser exchange");
  expect(own.message).toBe("the set is too large; split the input");
  expect(own.reportedCause).toBeUndefined();

  const partner = failureFor(
    "config",
    new WebRtcFrameLimitError("the reply is too large", "partner"),
  );
  expect(partner.category).toBe("config");
  expect(partner.title).toBe(
    "Your partner's file is too large for a browser exchange",
  );
});
