import { expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import { PSIParticipant } from "../../src/psi/participant";
import {
  ConnectionError,
  createMessagePipe,
} from "../../src/connection/messageConnection";
import { markNamedDiagnosis, PeerAbortError } from "../../src/errors";
import { decodePsiBinaryFrame } from "../../src/psi/psiBinaryFrame";
import { InProcessPsiEngine } from "../../src/psi/psiEngine";
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

test("a decode that fails unnamed is classified and keeps its cause", async () => {
  // A failure raised inside the PSI library names no condition of its own, so
  // the boundary names itself and holds what failed as the cause.
  const failure = new Error("Tried to read past the end of the data 5 > 4");
  const ended = await decodePsiBinaryFrame("joiner", "serverSetup", () =>
    Promise.reject(failure),
  ).then(
    () => undefined,
    (err: unknown) => err as Error,
  );

  expect(ended).toBeInstanceOf(ConnectionError);
  expect((ended as ConnectionError).kind).toBe("protocol");
  expect(ended?.message).toBe(
    "joiner protocol error: inbound PSI serverSetup failed to decode",
  );
  expect(ended?.cause).toBe(failure);
});

test("a decode that fails with its own diagnosis is raised unchanged", async () => {
  const failure = markNamedDiagnosis(new Error("the engine's own diagnosis"));
  const ended = await decodePsiBinaryFrame("joiner", "serverSetup", () =>
    Promise.reject(failure),
  ).then(
    () => undefined,
    (err: unknown) => err as Error,
  );

  expect(ended).toBe(failure);
});

test("a frame the engine diagnoses keeps its diagnosis as the top line", async () => {
  // A server setup that deserializes cleanly and holds no Raw data structure:
  // the engine states that condition, so re-labeling it "failed to decode"
  // would report the wrong fault to the operator.
  const ended = await endOfRoundAfter(new Uint8Array(0));

  expect(ended).not.toBeInstanceOf(PeerAbortError);
  expect(ended?.message).toBe(
    "joiner protocol error: PSI server setup is not a Raw data structure",
  );
});

// A count-only sender parked on the request frame, which is where the two
// parties' reveal flags are compared, and a joiner engine built for the other
// mode to produce the diverging request.
function countOnlySender(): PSIParticipant {
  return new PSIParticipant(
    "sender",
    psiLibrary,
    { role: "starter", verbose: 0 },
    UNBOUNDED_PSI_ELEMENTS,
    new InProcessPsiEngine(psiLibrary, "starter", "sender", "count-only"),
  );
}

function revealingClientRequest(): Promise<Uint8Array> {
  return new InProcessPsiEngine(
    psiLibrary,
    "joiner",
    "joiner",
    "identifier-revealing",
  ).createClientRequest(["Carol"]);
}

test("a diverging reveal flag ends the round on the divergence, not a decode", async () => {
  // The request deserializes and is well formed; what disagrees is the mode
  // the two parties ran. Naming that is the whole point of the check, so it
  // must stand as the top line rather than sit under "failed to decode".
  const ended = await countOnlySender()
    .processClientRequest(await revealingClientRequest())
    .then(
      () => undefined,
      (err: unknown) => err as Error,
    );

  expect(ended?.message).toBe(
    "sender protocol error: the partner's PSI request ran the " +
      "identifier-revealing mode, where this exchange runs count-only",
  );
  expect(ended?.message).not.toMatch(/failed to decode/);
});

test("a role precondition this party broke is not reported as a bad frame", async () => {
  // The engine holds no server, so the call never reaches a decode at all. A
  // local invariant break must not be presented to the operator as the
  // partner having sent something the round could not read.
  const joinerSide = new PSIParticipant(
    "joiner",
    psiLibrary,
    { role: "joiner", verbose: 0 },
    UNBOUNDED_PSI_ELEMENTS,
  );

  const ended = await joinerSide
    .processClientRequest(await revealingClientRequest())
    .then(
      () => undefined,
      (err: unknown) => err as Error,
    );

  expect(ended?.message).toBe(
    "joiner: processClientRequest requires the server role",
  );
  expect(ended).not.toBeInstanceOf(ConnectionError);
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
