import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import {
  PROTOCOL_VERSION,
  TERMS_ENVELOPE_FIELDS,
  exchangeTerms,
  sendAbort,
} from "../src/protocolSetup";
import { createMessagePipe } from "../src/connection/messageConnection";
import { recordingConnection } from "./utils/recordingConnection";

import type { LinkageTerms } from "../src/config/linkageTerms";
import type { MessageConnection } from "../src/connection/messageConnection";
import type { PresentedHostKey } from "../src/connection/fileSyncConnection";
import type { TermsExchangeResult } from "../src/protocolSetup";

/**
 * Conformance replay of test/vectors/terms-envelope-vectors.json: the field set,
 * field order, and values the terms-exchange envelope puts on the wire.
 *
 * Every piece of per-party, per-run role and bounds metadata rides that envelope
 * beside `linkageTerms` -- the record count, the declared effective key count,
 * the protocol version, the save intent, the payload-intent flag, and the
 * observed host key (docs/spec/PROTOCOL.md, The counts ride the terms exchange).
 * A partner reads each by name, so adding, renaming, dropping, or re-ordering one
 * is a wire-format delta. The suites around this one assert what a field MEANS;
 * this one holds the whole set each frame slot carries.
 *
 * The scenarios are replayed through the real `exchangeTerms` and `sendAbort`
 * rather than compared against a second model of the envelope, and each frame is
 * rebuilt from the file's `fields`, `envelope`, and `carriesLinkageTerms` before
 * the comparison -- so a field the file drops, renames, or re-orders fails here.
 * Regenerate with vectors/generate-terms-envelope-vectors.mjs.
 */

interface CapturedFrame {
  sender: "initiator" | "responder";
  slot: string;
  fields: Array<string>;
  envelope: Record<string, unknown>;
  carriesLinkageTerms: LinkageTermsFixture | null;
}

/** The names the file's `linkageTerms` section keys its fixtures by. */
type LinkageTermsFixture = "partyA" | "partyB" | "unnamedParty";

interface PartyInputs {
  terms: LinkageTermsFixture;
  recordCount: number;
  saveIntent?: boolean;
  hostKey?: PresentedHostKey;
  disclosesPayload?: boolean;
}

interface ReadBack {
  partnerIdentity: string | null;
  partnerRecordCount: number;
  partnerSaveIntent: boolean;
  partnerDisclosesPayload: boolean | null;
  partnerHostKey: PresentedHostKey | null;
  partnerHostKeyMalformed: boolean;
}

interface EnvelopeVectors {
  protocolVersion: number;
  /** Every field each slot's schema admits, whether or not a frame sends it. */
  envelopeFields: Record<string, Array<string>>;
  linkageTerms: Record<LinkageTermsFixture, LinkageTerms>;
  scenarios: Array<{
    name: string;
    description: string;
    initiator: PartyInputs;
    responder: PartyInputs;
    frames: Array<CapturedFrame>;
    reads: { initiator: ReadBack; responder: ReadBack };
  }>;
  abortFrames: Array<CapturedFrame & { name: string; description: string }>;
}

const vectors: EnvelopeVectors = JSON.parse(
  readFileSync(
    new URL("./vectors/terms-envelope-vectors.json", import.meta.url),
    "utf-8",
  ),
);

/** Every frame the file pins, on any slot: the exchange's and the aborts'. */
const allFrames: Array<CapturedFrame> = [
  ...vectors.scenarios.flatMap((scenario) => scenario.frames),
  ...vectors.abortFrames,
];

/** The whole frame the file pins, reassembled in its pinned field order. */
function expectedFrame(frame: CapturedFrame): Record<string, unknown> {
  const rebuilt: Record<string, unknown> = {};
  for (const field of frame.fields) {
    rebuilt[field] =
      field === "linkageTerms"
        ? vectors.linkageTerms[frame.carriesLinkageTerms as LinkageTermsFixture]
        : frame.envelope[field];
  }
  return rebuilt;
}

/**
 * A frame comparison that fails on field ORDER as well as content: a partner
 * decoder reads by name, but the order is what a byte-level pin over the frame
 * would carry, and it is free to hold here.
 */
function expectFrame(sent: unknown, frame: CapturedFrame): void {
  const actual = sent as Record<string, unknown>;
  expect(Object.keys(actual)).toEqual(frame.fields);
  expect(actual).toEqual(expectedFrame(frame));
}

function readBack(result: TermsExchangeResult): ReadBack {
  return {
    partnerIdentity: result.partnerTerms.identity ?? null,
    partnerRecordCount: result.partnerRecordCount,
    partnerSaveIntent: result.partnerSaveIntent,
    partnerDisclosesPayload: result.partnerDisclosesPayload ?? null,
    partnerHostKey: result.partnerHostKey ?? null,
    partnerHostKeyMalformed: result.partnerHostKeyMalformed,
  };
}

function drive(
  conn: MessageConnection,
  role: "initiator" | "responder",
  side: PartyInputs,
): Promise<TermsExchangeResult> {
  return exchangeTerms(
    conn,
    role,
    vectors.linkageTerms[side.terms],
    side.recordCount,
    side.saveIntent,
    side.hostKey,
    side.disclosesPayload,
  );
}

describe("terms-exchange envelope vectors", () => {
  test("the file pins this build's protocol version", () => {
    // The version rides every terms frame, and the reconcile admits only this
    // build's exact value, so a file pinned to another version pins frames no
    // conforming party would accept.
    expect(vectors.protocolVersion).toBe(PROTOCOL_VERSION);
  });

  test.each(vectors.scenarios.map((scenario) => [scenario.name, scenario]))(
    "%s: every frame is the pinned field set, in the pinned order",
    async (_name, scenario) => {
      const [rawInitiator, rawResponder] = createMessagePipe();
      const initiator = recordingConnection(rawInitiator);
      const responder = recordingConnection(rawResponder);

      const [initiatorResult, responderResult] = await Promise.all([
        drive(initiator.conn, "initiator", scenario.initiator),
        drive(responder.conn, "responder", scenario.responder),
      ]);

      const sentBy = { initiator: initiator.sent, responder: responder.sent };
      const consumed = { initiator: 0, responder: 0 };
      for (const frame of scenario.frames) {
        const sent = sentBy[frame.sender][consumed[frame.sender]++];
        expect(
          sent,
          `${frame.sender} sent no frame for ${frame.slot}`,
        ).toBeDefined();
        expectFrame(sent, frame);
      }
      // A frame the file does not pin is a slot that went unchecked, which is the
      // hole this file exists to close.
      expect(initiator.sent).toHaveLength(consumed.initiator);
      expect(responder.sent).toHaveLength(consumed.responder);

      expect(readBack(initiatorResult)).toEqual(scenario.reads.initiator);
      expect(readBack(responderResult)).toEqual(scenario.reads.responder);
    },
  );

  test.each(vectors.abortFrames.map((frame) => [frame.name, frame]))(
    "%s: the abort slot carries the pinned field set",
    async (_name, frame) => {
      const sent: Array<unknown> = [];
      const conn: MessageConnection = {
        send: async (data: unknown) => {
          sent.push(data);
        },
        receive: async () => ({}),
        close: async () => {},
      };

      await sendAbort(
        conn,
        frame.envelope.abortReasons as Array<string>,
        frame.carriesLinkageTerms === null
          ? undefined
          : vectors.linkageTerms[frame.carriesLinkageTerms],
      );

      expect(sent).toHaveLength(1);
      expectFrame(sent[0], frame);
    },
  );

  test("the file's admitted field set is the one the schemas declare", () => {
    expect(vectors.envelopeFields).toEqual(TERMS_ENVELOPE_FIELDS);
  });

  test("every field a slot admits rides some pinned frame on that slot", () => {
    // The coverage claim as a check rather than a reader's inference: these
    // vectors pin what exchangeTerms EMITS on the scenarios they drive, so a
    // field added to a schema and advertised by no pinned frame would ride the
    // wire with nothing holding it. Adding one fails here until a scenario
    // carries it -- which is also what moves the bump guard's digest.
    for (const [slot, admitted] of Object.entries(vectors.envelopeFields)) {
      const emitted = new Set(
        allFrames
          .filter((frame) => frame.slot === slot)
          .flatMap((frame) => frame.fields),
      );
      expect(
        [...emitted].sort(),
        `${slot} pins no frame carrying them all`,
      ).toEqual([...admitted].sort());
    }
  });

  test("some pinned frame advertises no optional field at all", () => {
    // A party with nothing to advertise omits `save`, `disclosesPayload`, and
    // `hostKey` rather than sending them as false or null, which a partner's
    // schema would also accept. The frame comparison above is exact on the key
    // list, so a build that started sending them fails there -- but only while
    // the file still holds a frame that carries none of them.
    const optional = ["save", "disclosesPayload", "hostKey"];
    const narrow = allFrames.filter(
      (frame) => !frame.fields.some((field) => optional.includes(field)),
    );
    expect(
      narrow.length,
      "no pinned frame omits every optional advertisement",
    ).toBeGreaterThan(0);
  });
});
