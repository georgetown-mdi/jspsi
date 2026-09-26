import { expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import { PSIParticipant } from "../../src/psi/participant";
import { InProcessPsiEngine } from "../../src/psi/psiEngine";
import { createMessagePipe } from "../../src/connection/messageConnection";
import {
  AEAD_ENVELOPE_OVERHEAD_BYTES,
  EncryptedMessageConnection,
} from "../../src/connection/encryptedMessageConnection";
import { MESSAGE_HEADER_BYTES } from "../../src/connection/fileSyncFraming";
import {
  PSI_ENCODED_ELEMENT_BYTES,
  PSI_SET_MAX_FRAMING_BYTES,
} from "../../src/connection/webrtcOutboundBound";
import { PeerAbortError, RoundSetLimitError } from "../../src/errors";
import { fileSyncMaxRoundSetValues } from "../../src/exchange";
import { UNBOUNDED_PSI_ELEMENTS } from "../utils/psiElementBounds";

import type { MessageConnection } from "../../src/connection/messageConnection";

// The sender-side half of the file-sync message-file bound: a party refuses a
// set frame whose message file the partner's read gate would refuse, before
// the file is written. The bound is lowered so the boundary is reached with
// sets of a few hundred values; the real bound's ceiling is pinned in
// fileSyncFrameRefusal.test.ts.

const psiLibrary = await PSI();

const SESSION_KEY = new Uint8Array(32).fill(0x42) as Uint8Array<ArrayBuffer>;

/** `conn` stating `bound` as its partner's message-file bound. */
function withFileBound(
  conn: MessageConnection,
  bound: number | undefined,
): MessageConnection {
  return {
    send: (data) => conn.send(data),
    receive: (timeoutMs) => conn.receive(timeoutMs),
    close: () => conn.close(),
    outboundFileSyncFrameBound: () => bound,
  };
}

function values(count: number, prefix: string): Array<string> {
  return Array.from({ length: count }, (_unused, i) => `${prefix}-${i}`);
}

/** The frame bound whose value ceiling is exactly `maxValues`. */
function boundForCeiling(maxValues: number): number {
  const bound =
    MESSAGE_HEADER_BYTES +
    AEAD_ENVELOPE_OVERHEAD_BYTES +
    PSI_SET_MAX_FRAMING_BYTES +
    maxValues * PSI_ENCODED_ELEMENT_BYTES;
  expect(fileSyncMaxRoundSetValues(bound)).toBe(maxValues);
  expect(fileSyncMaxRoundSetValues(bound - 1)).toBe(maxValues - 1);
  return bound;
}

/** The size of the encrypted message file holding the starter's setup. */
async function setupFileBytes(set: Array<string>): Promise<number> {
  const engine = new InProcessPsiEngine(
    psiLibrary,
    "starter",
    "server",
    "identifier-revealing",
  );
  try {
    const { setup } = await engine.createServerSetup(set);
    return (
      MESSAGE_HEADER_BYTES + AEAD_ENVELOPE_OVERHEAD_BYTES + setup.byteLength
    );
  } finally {
    engine.dispose();
  }
}

/**
 * One cascade round between a starter holding `starterSet` and a joiner
 * holding `joinerSet`, over encrypted connections each stating its own bound.
 * Resolves to how each side ended.
 */
async function round(
  starterSet: Array<string>,
  joinerSet: Array<string>,
  bounds: { starter?: number; joiner?: number },
): Promise<{ starter: unknown; joiner: unknown }> {
  const [rawA, rawB] = createMessagePipe();
  const [a, b] = await Promise.all([
    EncryptedMessageConnection.create(
      withFileBound(rawA, bounds.starter),
      SESSION_KEY,
      "initiator",
    ),
    EncryptedMessageConnection.create(
      withFileBound(rawB, bounds.joiner),
      SESSION_KEY,
      "responder",
    ),
  ]);
  const starter = new PSIParticipant(
    "server",
    psiLibrary,
    { role: "starter", verbose: -1 },
    UNBOUNDED_PSI_ELEMENTS,
  );
  const joiner = new PSIParticipant(
    "client",
    psiLibrary,
    { role: "joiner", verbose: -1 },
    UNBOUNDED_PSI_ELEMENTS,
  );
  const settle = (promise: Promise<unknown>) =>
    promise.then(
      () => "completed",
      (err: unknown) => err,
    );
  const [starterEnd, joinerEnd] = await Promise.all([
    settle(starter.identifyIntersection(a, starterSet)),
    settle(joiner.identifyIntersection(b, joinerSet)),
  ]);
  await a.close();
  await b.close();
  starter.dispose();
  joiner.dispose();
  return { starter: starterEnd, joiner: joinerEnd };
}

test("a starter's setup file is sent at the bound and refused one byte over", async () => {
  const set = values(100, "b");
  const fileBytes = await setupFileBytes(set);

  const at = await round(set, values(3, "b"), { starter: fileBytes });
  expect(at).toEqual({ starter: "completed", joiner: "completed" });

  const over = await round(set, values(3, "b"), { starter: fileBytes - 1 });
  expect(over.starter).toBeInstanceOf(RoundSetLimitError);
  expect((over.starter as RoundSetLimitError).setOwner).toBe("local");
  // The partner, parked on the setup, reads the abort sent in its place.
  expect(over.joiner).toBeInstanceOf(PeerAbortError);
});

test("a starter's setup is sent at the value ceiling and refused one value over it", async () => {
  const bound = boundForCeiling(200);

  const at = await round(values(200, "s"), values(3, "s"), { starter: bound });
  expect(at).toEqual({ starter: "completed", joiner: "completed" });

  const over = await round(values(201, "s"), values(3, "s"), {
    starter: bound,
  });
  expect(over.starter).toBeInstanceOf(RoundSetLimitError);
  expect((over.starter as RoundSetLimitError).setOwner).toBe("local");
  expect((over.starter as Error).message).toBe(
    "Too large for SFTP or a synced folder: the set this party sends for " +
      "this linkage key holds 201 values, over the 200 one message file " +
      "holds, so the exchange stopped before sending it and told your " +
      "partner. Split the input into smaller files and run one exchange " +
      "for each.",
  );
  expect(over.joiner).toBeInstanceOf(PeerAbortError);
});

test("a joiner's request is sent at the value ceiling and refused one value over it", async () => {
  const bound = boundForCeiling(150);

  const at = await round(values(3, "j"), values(150, "j"), { joiner: bound });
  expect(at).toEqual({ starter: "completed", joiner: "completed" });

  const over = await round(values(3, "j"), values(151, "j"), {
    joiner: bound,
  });
  expect(over.joiner).toBeInstanceOf(RoundSetLimitError);
  expect((over.joiner as RoundSetLimitError).setOwner).toBe("local");
  expect((over.joiner as Error).message).toMatch(
    /holds 151 values, over the 150 one message file holds/,
  );
  expect(over.starter).toBeInstanceOf(PeerAbortError);
});

test("the reply returning a partner's set over the bound is refused as the partner's", async () => {
  // A partner that checks nothing sends a request the starter's reply to
  // would cross the bound; the starter's own setup is small enough to send.
  const bound = boundForCeiling(150);

  const at = await round(values(3, "r"), values(150, "r"), { starter: bound });
  expect(at).toEqual({ starter: "completed", joiner: "completed" });

  const over = await round(values(3, "r"), values(151, "r"), {
    starter: bound,
  });
  expect(over.starter).toBeInstanceOf(RoundSetLimitError);
  expect((over.starter as RoundSetLimitError).setOwner).toBe("partner");
  expect((over.starter as Error).message).toMatch(
    /reply to your partner's set .* holds 151 values.*Ask your partner/,
  );
  expect(over.joiner).toBeInstanceOf(PeerAbortError);
});

test("a transport stating no message-file bound sends any set", async () => {
  const ended = await round(values(50, "n"), values(50, "n"), {});
  expect(ended).toEqual({ starter: "completed", joiner: "completed" });
});
