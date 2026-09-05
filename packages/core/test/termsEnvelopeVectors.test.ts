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

import type { LinkageTerms } from "../src/config/linkageTermsSchema";
import type { MessageConnection } from "../src/connection/messageConnection";
import type { PresentedHostKey } from "../src/connection/fileSyncConnection";
import type { TermsExchangeResult } from "../src/protocolSetup";

/**
 * Conformance replay of test/vectors/terms-envelope-vectors.json: the field
 * set, order, and values the terms-exchange envelope puts on the wire
 * (docs/spec/PROTOCOL.md, The counts ride the terms exchange). Field name
 * and order are part of the wire format; adding, renaming, dropping, or
 * reordering one is a breaking change. Regenerate with
 * vectors/generate-terms-envelope-vectors.mjs.
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
 * Checks field order in addition to content: the partner decoder reads by
 * name, but this pins what a byte-level snapshot of the frame would show.
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
    // The vectors must pin this build's exact protocol version: the
    // reconcile rejects any other value.
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
      // Catches a frame the file does not pin: an extra frame would
      // otherwise go unchecked.
      expect(initiator.sent).toHaveLength(consumed.initiator);
      expect(responder.sent).toHaveLength(consumed.responder);

      expect(readBack(initiatorResult)).toEqual(scenario.reads.initiator);
      expect(readBack(responderResult)).toEqual(scenario.reads.responder);
    },
  );

  test.each(vectors.abortFrames.map((frame) => [frame.name, frame]))(
    "%s: the abort slot holds the pinned field set",
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
    // Every admitted field must appear on some pinned frame: a schema field
    // added with no covering frame fails here until a scenario includes it,
    // which also moves the bump guard's digest.
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
    // A party with nothing to advertise omits `save`, `disclosesPayload`,
    // and `hostKey` rather than sending false or null (which a partner's
    // schema would also accept). The frame comparison above is exact on
    // keys, so a build that starts sending them fails there, but only
    // while some pinned frame omits all three.
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
