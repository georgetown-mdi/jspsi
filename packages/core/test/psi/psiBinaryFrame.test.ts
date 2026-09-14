import { expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import { PSIParticipant } from "../../src/psi/participant";
import {
  ConnectionError,
  createMessagePipe,
} from "../../src/connection/messageConnection";
import { PeerAbortError } from "../../src/errors";
import { sendAbort } from "../../src/protocolSetup";
import { UNBOUNDED_PSI_ELEMENTS } from "../utils/psiElementBounds";

import type { MessageConnection } from "../../src/connection/messageConnection";

// The PSI rounds are where a refusal taken past the terms exchange reaches the
// partner: that refusal is one-sided, so the refusing party sends its abort to
// a partner already parked on the next round's binary frame. These drive one
// frame at that boundary and read what the parked party ends with -- an abort
// classified as the peer termination it is, and every other arrival keeping
// the cause it failed with.

const psiLibrary = await PSI();

// One round, driven to the point where the joiner is parked on the server
// setup, with `frame` delivered in the setup's place.
async function endOfRoundAfter(frame: unknown): Promise<Error | undefined> {
  const [senderConn, joinerConn] = createMessagePipe();
  const joiner = new PSIParticipant(
    "joiner",
    psiLibrary,
    { role: "joiner", verbose: 0 },
    UNBOUNDED_PSI_ELEMENTS,
  );
  const round = joiner.identifyIntersection(joinerConn, ["Carol"]).then(
    () => undefined,
    (err: unknown) => err as Error,
  );
  await senderConn.send(frame);
  const ended = await round;
  await senderConn.close();
  return ended;
}

// The reason the invitation-term binding puts on its abort, verbatim: a test
// reading what the partner shows must be driven by the frame the refusal
// actually sends.
const REFUSAL_REASON =
  "partner presented a deduplicate its invitation did not declare";

test("a partner's abort ends the parked round as a peer termination", async () => {
  // The frame comes from sendAbort rather than a literal, so what the parked
  // party is driven with is what a refusal puts on the wire.
  const sent: Array<unknown> = [];
  const sink: MessageConnection = {
    send: async (data: unknown) => {
      sent.push(data);
    },
    receive: async () => ({}),
    close: async () => {},
  };
  await sendAbort(sink, [REFUSAL_REASON]);

  const ended = await endOfRoundAfter(sent[0]);

  expect(ended).toBeInstanceOf(PeerAbortError);
  // What the operator is told: the partner ended the exchange and holds the
  // reason, rather than a decode message naming nothing they can act on.
  expect(ended?.message).toMatch(/aborted the exchange/);
  expect(ended?.message).toMatch(/Contact your partner/);
  // The abort's reasons are partner-written text and are not read here, so
  // nothing the partner authored reaches this party's display.
  expect(ended?.message).not.toContain(REFUSAL_REASON);
  expect(ended?.cause).toBeUndefined();
});

test("a non-binary frame that is no abort is not reported as a refusal", async () => {
  // The acknowledgement frame of a later round arriving early: a non-conforming
  // peer sending the wrong frame has refused nothing, so the boundary names the
  // frame it awaited instead.
  const ended = await endOfRoundAfter({ status: "completed" });

  expect(ended).not.toBeInstanceOf(PeerAbortError);
  expect(ended).toBeInstanceOf(ConnectionError);
  expect((ended as ConnectionError).kind).toBe("protocol");
  expect(ended?.message).toBe(
    "joiner protocol error: inbound PSI serverSetup is not a binary frame",
  );
});

test("a malformed binary frame keeps its own decode cause", async () => {
  // Bytes that pass the pre-deserialize element scan and fail the library's
  // own decode. The boundary names itself and holds what failed as the cause,
  // rather than replacing it with a refusal.
  const ended = await endOfRoundAfter(new Uint8Array(0));

  expect(ended).not.toBeInstanceOf(PeerAbortError);
  expect(ended).toBeInstanceOf(ConnectionError);
  expect((ended as ConnectionError).kind).toBe("protocol");
  expect(ended?.message).toBe(
    "joiner protocol error: inbound PSI serverSetup failed to decode",
  );
  expect((ended?.cause as Error).message).toBe(
    "joiner protocol error: PSI server setup is not a Raw data structure",
  );
});

test("a frame the element scan rejects is unchanged by the classification", async () => {
  // The amplification guard runs on the raw bytes above the library, so a
  // frame it rejects never reaches the decode and keeps the guard's own
  // diagnosis.
  const ended = await endOfRoundAfter(new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9]));

  expect(ended).not.toBeInstanceOf(PeerAbortError);
  expect(ended?.message).toBe(
    "joiner protocol error: malformed inbound PSI serverSetup frame",
  );
});
