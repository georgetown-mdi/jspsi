import { expect, test, vi } from "vitest";

import PSI from "@openmined/psi.js";

// The grouping cases below drive a round a candidate set widened, which the
// strategy allowlist keeps unreachable in the shipped build
// (CANDIDATE_SET_IMPLEMENTED_BY_STRATEGY, linkageTermsPolicy.ts). Flipping the
// entry changes nothing for the fan-out-free runs the rest of this file
// drives: a round holding one value per record takes the same path either way.
// The few cases that pin a refusal on the shipped setting close the gate for
// their own run through withCandidateSetGate below.
const candidateSetGate = vi.hoisted(() => ({ open: true }));

vi.mock("../src/linkageTermsPolicy", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../src/linkageTermsPolicy")>();
  return {
    ...original,
    candidateSetIsImplementedForStrategy: () => candidateSetGate.open,
  };
});

async function withCandidateSetGate<T>(
  open: boolean,
  run: () => Promise<T>,
): Promise<T> {
  candidateSetGate.open = open;
  try {
    return await run();
  } finally {
    candidateSetGate.open = true;
  }
}

import { PSIParticipant } from "../src/psi/participant";
import {
  linkViaPSI,
  linkViaSinglePassPSI,
  type LinkageCardinality,
} from "../src/psi/link";
import { readPartnerRoundGrouping } from "../src/psi/roundGrouping";
import { UNBOUNDED_PSI_ELEMENTS } from "./utils/psiElementBounds";
import {
  MAX_RECORD_COUNT,
  psiElementBounds,
} from "../src/connection/frameSize";
import {
  assertPartnerIndices,
  resolveRunGroupedReturn,
} from "../src/utils/partnerIndices";
import { fanOutFreeBounds } from "./utils/singlePassBounds";
import {
  createMessagePipe,
  ConnectionError,
  type MessageConnection,
} from "../src/connection/messageConnection";
import type { AssociationTable } from "../src/types";

// Every index list a party receives from its partner addresses rows or
// per-round positions the RECEIVING party owns, so each is checked against that
// party's own state before it can drive the match, payload, or record. The
// tests below drive an otherwise honest exchange and alter one inbound frame,
// so the deviating frame is refused as a classified protocol error while an
// untouched run stays green.

const psiLibrary = await PSI();

// Three rows each, two of them matching (Bob, Carol), so a deviating frame has
// both matched and unmatched rows to aim at.
const ROWS = 3;
const starterKeys = [["Alice", "Bob", "Carol"]];
const joinerKeys = [["Zed", "Bob", "Carol"]];

// Real per-message element bounds, as exchange.ts derives them from the agreed key
// count and the two exchanged record counts: the cascade checks a partner-supplied
// value index against the bound on the partner's masked set.
const elementBounds = psiElementBounds(
  { effectiveKeyCount: 1, recordCount: ROWS },
  { effectiveKeyCount: 1, recordCount: ROWS },
);

function makeParticipant(role: "starter" | "joiner"): PSIParticipant {
  return new PSIParticipant(
    role === "starter" ? "server" : "client",
    psiLibrary,
    { role, verbose: -1 },
    elementBounds,
  );
}

type MappedElement = {
  theirIndex: number | Array<number>;
  iteration: number;
};
type Deviation = (frame: unknown) => unknown;

// Interpose on one party's INBOUND frames, leaving both parties' own behavior
// untouched: the deviation stands in for a partner that computes the protocol
// honestly right up to the frame under test.
function deviatingInbound(
  conn: MessageConnection,
  deviate: Deviation,
): MessageConnection {
  return {
    send: (data) => conn.send(data),
    receive: async (timeoutMs?: number) =>
      deviate(await conn.receive(timeoutMs)),
    close: () => conn.close(),
    setInboundFrameCap: conn.setInboundFrameCap?.bind(conn),
  };
}

// The two frame shapes a deviation aims at, identified by shape rather than by
// position, so a test names its target as "the association table" / "the
// mapped-element list" and does not silently follow a renumbered sequence.
const isIndexTable = (frame: unknown): frame is [number[], number[]] =>
  Array.isArray(frame) && frame.length === 2 && Array.isArray(frame[0]);

const isMappedElementList = (frame: unknown): frame is Array<MappedElement> =>
  Array.isArray(frame) &&
  frame.length > 0 &&
  typeof frame[0] === "object" &&
  frame[0] !== null &&
  !Array.isArray(frame[0]);

// Deviate the association table, or the nth mapped-element list of the two the
// cascade exchanges: the first is the partner's list of THIS party's records, the
// second this party's own list come back translated.
function onIndexTable(
  transform: (table: [number[], number[]]) => unknown,
): Deviation {
  return (frame) => (isIndexTable(frame) ? transform(frame) : frame);
}

function onMappedElementList(
  occurrence: 1 | 2,
  transform: (list: Array<MappedElement>) => unknown,
): Deviation {
  let seen = 0;
  return (frame) => {
    if (!isMappedElementList(frame)) return frame;
    seen += 1;
    return seen === occurrence ? transform(frame) : frame;
  };
}

// Run both parties, deviating the starter's inbound frames. Returns the starter's
// rejection (or undefined if it accepted the deviating frame, which fails the
// assertion that follows). The pipe is closed afterwards so the honest joiner --
// which may be parked waiting for a frame the aborted starter never sent --
// settles instead of holding the test open.
async function cascadeWithDeviation(deviate: Deviation): Promise<unknown> {
  const [starterConn, joinerConn] = createMessagePipe();
  const starterRun = linkViaPSI(
    { cardinality: "one-to-one" },
    makeParticipant("starter"),
    deviatingInbound(starterConn, deviate),
    starterKeys,
    fanOutFreeBounds(starterKeys.length, ROWS),
    -1,
  );
  const joinerRun = linkViaPSI(
    { cardinality: "one-to-one" },
    makeParticipant("joiner"),
    joinerConn,
    joinerKeys,
    fanOutFreeBounds(joinerKeys.length, ROWS),
    -1,
  );
  const outcome = await starterRun.then(
    () => undefined,
    (err: unknown) => err,
  );
  await starterConn.close();
  await joinerRun.catch(() => undefined);
  return outcome;
}

// The mirror boundary on the other role: the joiner reads the starter's own
// matched indices as the round's final frame, one per pair the joiner reported.
// It is the only inbound frame of the round that is a plain array of numbers.
async function cascadeWithJoinerDeviation(
  transform: (list: Array<number>) => unknown,
): Promise<unknown> {
  const [starterConn, joinerConn] = createMessagePipe();
  const starterRun = linkViaPSI(
    { cardinality: "one-to-one" },
    makeParticipant("starter"),
    starterConn,
    starterKeys,
    fanOutFreeBounds(starterKeys.length, ROWS),
    -1,
  );
  const joinerRun = linkViaPSI(
    { cardinality: "one-to-one" },
    makeParticipant("joiner"),
    deviatingInbound(joinerConn, (frame) =>
      Array.isArray(frame) && typeof frame[0] === "number"
        ? transform(frame as Array<number>)
        : frame,
    ),
    joinerKeys,
    fanOutFreeBounds(joinerKeys.length, ROWS),
    -1,
  );
  const outcome = await joinerRun.then(
    () => undefined,
    (err: unknown) => err,
  );
  await joinerConn.close();
  await starterRun.catch(() => undefined);
  return outcome;
}

async function singlePassWithDeviation(deviate: Deviation): Promise<unknown> {
  const [senderConn, receiverConn] = createMessagePipe();
  const senderRun = linkViaSinglePassPSI(
    { cardinality: "one-to-one" },
    makeParticipant("starter"),
    deviatingInbound(senderConn, deviate),
    starterKeys,
    fanOutFreeBounds(1, ROWS),
    false,
    -1,
  );
  const receiverRun = linkViaSinglePassPSI(
    { cardinality: "one-to-one" },
    makeParticipant("joiner"),
    receiverConn,
    joinerKeys,
    fanOutFreeBounds(1, ROWS),
    false,
    -1,
  );
  const outcome = await senderRun.then(
    () => undefined,
    (err: unknown) => err,
  );
  await senderConn.close();
  await receiverRun.catch(() => undefined);
  return outcome;
}

function expectProtocolRefusal(err: unknown, message: RegExp): void {
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("protocol");
  expect((err as ConnectionError).message).toMatch(message);
}

// --- The single-pass sender's resolved table ----------------------------------
// The receiver computes the table, so the sender cannot recompute it -- but every
// index in it addresses a row one of the two parties counted, and both counts are
// authenticated session state.

test("single-pass sender refuses a resolved table naming a row it does not have", async () => {
  const err = await singlePassWithDeviation(
    onIndexTable((table) => [[ROWS], [table[1][0]]]),
  );
  expectProtocolRefusal(err, /local half has an index outside \[0, 3\)/);
});

test("single-pass sender refuses a resolved table naming a partner row beyond the exchanged count", async () => {
  const err = await singlePassWithDeviation(
    onIndexTable((table) => [[table[0][0]], [ROWS]]),
  );
  expectProtocolRefusal(err, /partner half has an index outside \[0, 3\)/);
});

test("single-pass sender refuses a resolved table whose halves disagree in length", async () => {
  const err = await singlePassWithDeviation(
    onIndexTable((table) => [table[0], table[1].slice(1)]),
  );
  expectProtocolRefusal(err, /partner half has 1 entry, expected 2/);
});

test("single-pass sender refuses a resolved table with a fractional index", async () => {
  const err = await singlePassWithDeviation(
    onIndexTable((table) => [table[0].map(() => 1.5), table[1]]),
  );
  expectProtocolRefusal(
    err,
    /local half has an entry that is not a whole number/,
  );
});

test("single-pass sender refuses a resolved table with a negative index", async () => {
  const err = await singlePassWithDeviation(
    onIndexTable((table) => [table[0], [-1, ...table[1].slice(1)]]),
  );
  expectProtocolRefusal(err, /partner half has an index outside \[0, 3\)/);
});

test("single-pass sender refuses a resolved table that claims one of its rows twice", async () => {
  // The disclosure this closes: the sender builds and transmits payload for the
  // rows the table names, so a table naming more rows than the intersection holds
  // would widen what leaves this machine.
  const err = await singlePassWithDeviation(
    onIndexTable((table) => [[0, 0], table[1]]),
  );
  expectProtocolRefusal(err, /local half repeats an index/);
});

test("single-pass sender refuses a resolved table longer than its own row count", async () => {
  const err = await singlePassWithDeviation(
    onIndexTable(() => [
      [0, 1, 2, 0],
      [0, 1, 2, 0],
    ]),
  );
  expectProtocolRefusal(err, /local half has 4 entries, more than the 3/);
});

test("single-pass sender refuses a resolved table whose local half descends", async () => {
  // Reversing both halves keeps every entry whole, in range, distinct, and
  // paired with the same partner row, so the only property left to fail is the
  // ascending order the AssociationTable contract requires and the result rows
  // are read in.
  const err = await singlePassWithDeviation(
    onIndexTable((table) => [[...table[0]].reverse(), [...table[1]].reverse()]),
  );
  expectProtocolRefusal(err, /local half is not in ascending order/);
});

test("single-pass sender accepts a resolved table whose partner half descends", async () => {
  // The order is a property of the LOCAL half alone: the partner half's entries
  // follow their pairing, not their own order, so requiring it there would refuse
  // an honest table. The fixture's own halves happen to ascend together, so this
  // is what keeps the rule from being treated as covering both.
  const err = await singlePassWithDeviation(
    onIndexTable((table) => [table[0], [...table[1]].reverse()]),
  );
  expect(err).toBeUndefined();
});

// --- The same table under a deduplicating cardinality -------------------------
// One of the two halves names the "one" side's rows, which several of the MANY
// side's records link to, so its distinctness -- and with it the strictness of the
// ascending rule and the cap distinctness puts on the table's LENGTH -- is exactly
// what the widening spends. The other half keeps distinctness and is what the
// length is then anchored on. Which half is which is the sender's own resolved
// label, so a repeat on the wrong half is still refused.

// The "many" side holds a value twice, so one of its partner's rows takes two
// links and the resolved table repeats -- a table the strict rule would have
// rejected.
const groupedKeys = [["Bob", "Bob", "Carol"]];
const ungroupedKeys = [["Alice", "Bob", "Carol"]];

async function singlePassDeduplicating(
  senderCardinality: "many-to-one" | "one-to-many",
  deviate: Deviation = (frame) => frame,
): Promise<{ outcome: unknown; table: AssociationTable | undefined }> {
  const senderIsMany = senderCardinality === "many-to-one";
  const senderKeys = senderIsMany ? groupedKeys : ungroupedKeys;
  const receiverKeys = senderIsMany ? ungroupedKeys : groupedKeys;
  const [senderConn, receiverConn] = createMessagePipe();
  const senderRun = linkViaSinglePassPSI(
    { cardinality: senderCardinality },
    makeParticipant("starter"),
    deviatingInbound(senderConn, deviate),
    senderKeys,
    fanOutFreeBounds(1, ROWS),
    false,
    -1,
  );
  const receiverRun = linkViaSinglePassPSI(
    { cardinality: senderIsMany ? "one-to-many" : "many-to-one" },
    makeParticipant("joiner"),
    receiverConn,
    receiverKeys,
    fanOutFreeBounds(1, ROWS),
    false,
    -1,
  );
  const settled = await senderRun.then(
    (table) => ({ outcome: undefined, table }),
    (err: unknown) => ({ outcome: err, table: undefined }),
  );
  await senderConn.close();
  await receiverRun.catch(() => undefined);
  return settled;
}

test("single-pass sender accepts the repeat its resolved cardinality produces", async () => {
  // The "one" side's half is non-decreasing rather than strictly ascending, and
  // the strict rule would have rejected exactly this table. Both arrangements of
  // the deduplicating pair are driven, since which half repeats follows the label.
  const asOneSide = await singlePassDeduplicating("one-to-many");
  expect(asOneSide.outcome).toBeUndefined();
  expect(asOneSide.table).toStrictEqual([
    [1, 1, 2],
    [0, 1, 2],
  ]);
  const asManySide = await singlePassDeduplicating("many-to-one");
  expect(asManySide.outcome).toBeUndefined();
  expect(asManySide.table).toStrictEqual([
    [0, 1, 2],
    [1, 1, 2],
  ]);
});

test("single-pass sender refuses a repeat on the half that keeps distinctness", async () => {
  // The many side's own rows stand in one pair each, so a repeat there is a table
  // no resolution produces -- refused on whichever half the label puts it.
  const asOneSide = await singlePassDeduplicating(
    "one-to-many",
    onIndexTable((table) => [table[0], [0, 0, 2]]),
  );
  expectProtocolRefusal(asOneSide.outcome, /partner half repeats an index/);
  const asManySide = await singlePassDeduplicating(
    "many-to-one",
    onIndexTable((table) => [[0, 0, 2], table[1]]),
  );
  expectProtocolRefusal(asManySide.outcome, /local half repeats an index/);
});

test("single-pass sender still holds the repeating half to ascending order", async () => {
  // Distinctness is what the widening spends; the order the result rows and the
  // record's reconstruction of them read the table in is not.
  const { outcome } = await singlePassDeduplicating(
    "one-to-many",
    onIndexTable((table) => [[...table[0]].reverse(), table[1]]),
  );
  expectProtocolRefusal(outcome, /local half is not in ascending order/);
});

test("single-pass sender bounds the table by the many side's row count", async () => {
  // Where the SENDER is the "one" side, its own row count does not cap the
  // table: the partner half's distinctness does, against the count the partner
  // declared on the terms exchange.
  const asOneSide = await singlePassDeduplicating(
    "one-to-many",
    onIndexTable(() => [
      [1, 1, 1, 2],
      [0, 1, 2, 2],
    ]),
  );
  expectProtocolRefusal(
    asOneSide.outcome,
    /partner half has 4 entries, more than the 3/,
  );
  // Where the SENDER is the "many" side, its own half is the one that keeps
  // distinctness, so its own row count is what caps the table.
  const asManySide = await singlePassDeduplicating(
    "many-to-one",
    onIndexTable(() => [
      [0, 1, 2, 2],
      [0, 0, 1, 1],
    ]),
  );
  expectProtocolRefusal(
    asManySide.outcome,
    /local half has 4 entries, more than the 3/,
  );
});

// --- The cascade round's association table ------------------------------------
// The round's matches as the partner computed them: our half indexes the set this
// party just encrypted, the partner half the set the partner encrypted.

test("cascade starter refuses a round table indexing past the set it encrypted", async () => {
  const err = await cascadeWithDeviation(
    onIndexTable((table) => [table[0], table[1].map(() => 99)]),
  );
  expectProtocolRefusal(
    err,
    /round's association table, local half has an index outside \[0, 3\)/,
  );
});

test("cascade starter refuses a round table naming a partner element beyond its bound", async () => {
  const err = await cascadeWithDeviation(
    onIndexTable((table) => [table[0].map(() => 99), table[1]]),
  );
  expectProtocolRefusal(
    err,
    /round's association table, partner half has an index outside \[0, 3\)/,
  );
});

test("cascade starter refuses a round table whose halves disagree in length", async () => {
  const err = await cascadeWithDeviation(
    onIndexTable((table) => [[...table[0], 0], table[1]]),
  );
  expectProtocolRefusal(
    err,
    /round's association table, partner half has 3 entries, expected 2/,
  );
});

test("cascade starter refuses a round table with a fractional index", async () => {
  // The wire schema admits any finite number; an index that is not a whole number
  // addresses nothing.
  const err = await cascadeWithDeviation(
    onIndexTable((table) => [table[0], table[1].map(() => 1.5)]),
  );
  expectProtocolRefusal(
    err,
    /round's association table, local half has an entry that is not a whole number/,
  );
});

test("cascade starter refuses a round table with a negative index", async () => {
  const err = await cascadeWithDeviation(
    onIndexTable((table) => [[-1, ...table[0].slice(1)], table[1]]),
  );
  expectProtocolRefusal(
    err,
    /round's association table, partner half has an index outside \[0, 3\)/,
  );
});

test("cascade starter refuses a round table claiming one of its indices twice", async () => {
  const err = await cascadeWithDeviation(
    onIndexTable((table) => [table[0], table[1].map(() => table[1][0])]),
  );
  expectProtocolRefusal(
    err,
    /round's association table, local half repeats an index/,
  );
});

test("cascade starter refuses a round table longer than the set it encrypted", async () => {
  const err = await cascadeWithDeviation(
    onIndexTable((table) => [
      [...table[0], 0, 0],
      [...table[1], 0, 0],
    ]),
  );
  expectProtocolRefusal(
    err,
    /round's association table, local half has 4 entries, more than the 3/,
  );
});

test("cascade joiner refuses an original-index list of the wrong length", async () => {
  const err = await cascadeWithJoinerDeviation((list) => [...list, 0]);
  expectProtocolRefusal(err, /original-index list has 3 entries, expected 2/);
});

test("cascade joiner refuses an original-index list naming an element beyond its bound", async () => {
  const err = await cascadeWithJoinerDeviation((list) => list.map(() => 99));
  expectProtocolRefusal(
    err,
    /original-index list has an index outside \[0, 3\)/,
  );
});

test("cascade joiner refuses an original-index list with a fractional entry", async () => {
  const err = await cascadeWithJoinerDeviation((list) => list.map(() => 1.5));
  expectProtocolRefusal(
    err,
    /original-index list has an entry that is not a whole number/,
  );
});

test("cascade joiner refuses an original-index list with a negative entry", async () => {
  const err = await cascadeWithJoinerDeviation((list) => [
    -1,
    ...list.slice(1),
  ]);
  expectProtocolRefusal(
    err,
    /original-index list has an index outside \[0, 3\)/,
  );
});

test("cascade joiner refuses an original-index list naming one element twice", async () => {
  const err = await cascadeWithJoinerDeviation((list) =>
    list.map(() => list[0]),
  );
  expectProtocolRefusal(err, /original-index list repeats an index/);
});

// --- The cascade's mapped-element translation ---------------------------------
// The partner returns a list of THIS party's records, named by their position in
// the round's candidate set. The exchange is symmetric, so the honest list names
// exactly this party's own matched records, one entry each, on the round it
// matched them -- every entry is checkable against local state, not merely
// bounded.

test("cascade refuses a mapped-element entry naming a key round the exchange did not run", async () => {
  const err = await cascadeWithDeviation(
    onMappedElementList(1, (list) => list.map((e) => ({ ...e, iteration: 7 }))),
  );
  expectProtocolRefusal(err, /names a key round this exchange did not run/);
});

test("cascade refuses a mapped-element entry naming a position outside the round's candidate set", async () => {
  const err = await cascadeWithDeviation(
    onMappedElementList(1, (list) =>
      list.map((e) => ({ ...e, theirIndex: 99 })),
    ),
  );
  expectProtocolRefusal(
    err,
    /names a position outside that round's candidate set/,
  );
});

test("cascade refuses a mapped-element entry naming a fractional key round", async () => {
  const err = await cascadeWithDeviation(
    onMappedElementList(1, (list) =>
      list.map((e) => ({ ...e, iteration: 0.5 })),
    ),
  );
  expectProtocolRefusal(err, /names a key round this exchange did not run/);
});

test("cascade refuses a mapped-element entry naming a negative candidate position", async () => {
  const err = await cascadeWithDeviation(
    onMappedElementList(1, (list) =>
      list.map((e) => ({ ...e, theirIndex: -1 })),
    ),
  );
  expectProtocolRefusal(
    err,
    /names a position outside that round's candidate set/,
  );
});

test("cascade refuses a mapped-element entry naming a record this side did not match", async () => {
  // Candidate position 0 is row 0 (Alice), which took part in the round but
  // matched nothing. An honest partner states the positions its accepted pairs
  // rest on, so a probe at an unmatched one is refused rather than answered.
  const err = await cascadeWithDeviation(
    onMappedElementList(1, (list) => [
      { theirIndex: 0, iteration: 0 },
      ...list.slice(1),
    ]),
  );
  expectProtocolRefusal(
    err,
    /names positions other than the ones that round's accepted pairs rest on/,
  );
});

test("cascade refuses a mapped-element list naming one record twice", async () => {
  const err = await cascadeWithDeviation(
    onMappedElementList(1, (list) => [list[0], { ...list[0] }]),
  );
  expectProtocolRefusal(
    err,
    /names positions other than the ones that round's accepted pairs rest on/,
  );
});

test("cascade refuses a mapped-element list longer than this side's match count", async () => {
  const err = await cascadeWithDeviation(
    onMappedElementList(1, (list) => [...list, { ...list[0] }]),
  );
  expectProtocolRefusal(
    err,
    /states more entries for a key round than the records it accepted there/,
  );
});

test("cascade refuses a returned mapped-element list naming a partner row beyond the exchanged count", async () => {
  // The last frame of the cascade: this party's own list, come back with each
  // entry translated into the partner's row space. Those indices land in the
  // returned table -- the partner half of the result and of the attested record.
  const err = await cascadeWithDeviation(
    onMappedElementList(2, (list) =>
      list.map((e) => ({ ...e, theirIndex: ROWS })),
    ),
  );
  expectProtocolRefusal(
    err,
    /returned mapped-element list has an index outside \[0, 3\)/,
  );
});

test("cascade refuses a returned mapped-element list naming one partner row twice", async () => {
  const err = await cascadeWithDeviation(
    onMappedElementList(2, (list) =>
      list.map((e) => ({ ...e, theirIndex: 0 })),
    ),
  );
  expectProtocolRefusal(err, /returned mapped-element list repeats an index/);
});

test("cascade refuses a returned mapped-element list of the wrong length", async () => {
  const err = await cascadeWithDeviation(
    onMappedElementList(2, (list) => list.slice(1)),
  );
  expectProtocolRefusal(
    err,
    /returned mapped-element list has 1 entry, expected 2/,
  );
});

test("cascade refuses a returned mapped-element list with a fractional partner row", async () => {
  const err = await cascadeWithDeviation(
    onMappedElementList(2, (list) =>
      list.map((e) => ({ ...e, theirIndex: 1.5 })),
    ),
  );
  expectProtocolRefusal(
    err,
    /returned mapped-element list has an entry that is not a whole number/,
  );
});

test("cascade refuses a returned mapped-element list with a negative partner row", async () => {
  const err = await cascadeWithDeviation(
    onMappedElementList(2, (list) => [
      { ...list[0], theirIndex: -1 },
      ...list.slice(1),
    ]),
  );
  expectProtocolRefusal(
    err,
    /returned mapped-element list has an index outside \[0, 3\)/,
  );
});

// --- Duplicate detection at either bound scale --------------------------------
// The detector's backing depends on the ratio of the bound to the list length;
// every case above runs at fixture scale, where the bitmap is always the
// smaller allocation. This test exercises the widest bound a partner may
// declare instead, so the same classified refusal must still result -- a
// MAX_RECORD_COUNT-byte bitmap aborts the V8 process rather than failing
// cleanly, so a regression here would be unmissable but not gracefully caught.

test("a repeated index is refused at either bound scale", () => {
  const refusalFor = (exclusiveBound: number): unknown => {
    try {
      assertPartnerIndices("me", "the list", [1, 1], exclusiveBound);
    } catch (err) {
      return err;
    }
    return undefined;
  };
  expectProtocolRefusal(refusalFor(ROWS), /the list repeats an index/);
  expectProtocolRefusal(
    refusalFor(MAX_RECORD_COUNT),
    /the list repeats an index/,
  );
});

test("a distinct in-range list is accepted at either bound scale", () => {
  expect(() =>
    assertPartnerIndices("me", "the list", [0, 2], ROWS),
  ).not.toThrow();
  expect(() =>
    assertPartnerIndices("me", "the list", [0, 2], MAX_RECORD_COUNT),
  ).not.toThrow();
});

// --- The ascending rule -------------------------------------------------------
// Opt-in per list, so an out-of-order list is refused only where the order is the
// list's own property. A list that both repeats and descends is reported as the
// repeat, the narrower of the two faults.

test("a descending list is refused only under the ascending rule", () => {
  expect(() =>
    assertPartnerIndices("me", "the list", [2, 0], ROWS),
  ).not.toThrow();
  expect(() =>
    assertPartnerIndices("me", "the list", [2, 0], ROWS, { ascending: true }),
  ).toThrow(/the list is not in ascending order/);
  expect(() =>
    assertPartnerIndices("me", "the list", [0, 2], ROWS, { ascending: true }),
  ).not.toThrow();
});

test("a repeat under the ascending rule is reported as the repeat", () => {
  expect(() =>
    assertPartnerIndices("me", "the list", [1, 1], ROWS, { ascending: true }),
  ).toThrow(/the list repeats an index/);
});

// --- The grouping a repeat is admitted within ---------------------------------
// Where a repeat is the protocol's own widening -- the "many" side's returned
// mapped-element list -- distinctness is replaced rather than lifted: the list
// stays injective MODULO the grouping this party sent, so a repeat is admitted
// between two entries that named ONE (round, position) and refused between two
// that named different ones. The rule is driven end to end over a live exchange in
// psiLinkManyToOne.test.ts; these are its two halves at the check itself.

const refusalFrom = (run: () => void): unknown => {
  try {
    run();
  } catch (err) {
    return err;
  }
  return undefined;
};

test("a repeat is admitted within one group and refused across two", () => {
  // Entries 0 and 1 named one position, entry 2 another.
  const rules = {
    repeatsGroupedBy: { rounds: [0, 0, 0], groups: [0, 0, 1] },
  };
  expect(() =>
    assertPartnerIndices("me", "the list", [2, 2, 1], ROWS, rules),
  ).not.toThrow();
  expectProtocolRefusal(
    refusalFrom(() =>
      assertPartnerIndices("me", "the list", [2, 2, 2], ROWS, rules),
    ),
    /the list names one partner row for two of the partner's records this side matched/,
  );
  expectProtocolRefusal(
    refusalFrom(() =>
      assertPartnerIndices("me", "the list", [2, 1, 0], ROWS, rules),
    ),
    /the list names two partner rows for one of the partner's records this side matched/,
  );
});

test("one position of each round is a group of its own", () => {
  // A position number means nothing across rounds: each round has its own
  // candidate set, so the same number in two rounds is two groups.
  const rules = { repeatsGroupedBy: { rounds: [0, 1], groups: [0, 0] } };
  expectProtocolRefusal(
    refusalFrom(() =>
      assertPartnerIndices("me", "the list", [1, 1], ROWS, rules),
    ),
    /names one partner row for two of the partner's records this side matched/,
  );
  expect(() =>
    assertPartnerIndices("me", "the list", [1, 2], ROWS, rules),
  ).not.toThrow();
});

test("a grouping that does not run parallel to the list is a caller fault", () => {
  // The grouping is this party's own record of what it sent, never a partner
  // quantity, so a mismatched one is a local misuse -- and must not be reported as
  // the partner's protocol violation.
  const err = refusalFrom(() =>
    assertPartnerIndices("me", "the list", [0, 1], ROWS, {
      repeatsGroupedBy: { rounds: [0], groups: [0] },
    }),
  );
  expect(err).toBeInstanceOf(Error);
  expect(err).not.toBeInstanceOf(ConnectionError);
  expect((err as Error).message).toMatch(/one group per entry/);
});

// --- the same rule where the return answers in runs ---------------------------
// Where the partner keeps its own duplicates too, one entry this party sent
// comes back as a RUN holding every one of the partner's records accepted with
// it, so the list is a concatenation of runs rather than one entry per outbound
// entry. What each run is held to is the partner GROUPS this party resolved its
// entry was accepted with, which a candidate set leaves overlapping between two
// entries rather than equal or disjoint -- so the rule reads which of this
// party's own records the return claims each row for, and holds that partition
// to the one its pairing states.

const expectCallerFault = (run: () => void, detail: RegExp): void => {
  const err = refusalFrom(run);
  expect(err).toBeInstanceOf(Error);
  expect(err).not.toBeInstanceOf(ConnectionError);
  expect((err as Error).message).toMatch(detail);
};

test("a run holds the rows of the groups its own entry was accepted with", () => {
  // Entries 0 and 1 were accepted with rank 0, a group of two of the partner's
  // records, and entry 1 with rank 1 as well. Rows 1 and 2 are claimed for both
  // entries and row 4 for entry 1 alone, which is the partition the two ranks
  // state.
  const runs = {
    rounds: [0, 0],
    runLengths: [2, 3],
    ownerStarts: [0, 1, 3],
    owners: [0, 0, 1],
  };
  expect(
    resolveRunGroupedReturn("me", "the list", [1, 2, 2, 1, 4], 5, runs),
  ).toStrictEqual(
    new Map([
      [
        0,
        new Map([
          [0, [1, 2]],
          [1, [4]],
        ]),
      ],
    ]),
  );
});

test("a run naming a row the round did not pair with its entry is refused", () => {
  // The merge a rule keyed to one rank per entry would admit: the entry accepted
  // with rank 1 alone comes back holding rank 0's row as well, which would join
  // two of this party's records into one cluster its own resolution kept apart.
  const runs = {
    rounds: [0, 0],
    runLengths: [1, 1],
    ownerStarts: [0, 1, 2],
    owners: [0, 1],
  };
  expectProtocolRefusal(
    refusalFrom(() =>
      resolveRunGroupedReturn("me", "the list", [1, 1], 5, runs),
    ),
    /the list names one partner row for a set of this side's records the round did not accept together/,
  );
});

test("overlapping owner sets keep the rows they share", () => {
  // What a candidate set produces and a rank-keyed rule cannot state: entry 0
  // was accepted with ranks 0 and 1, entry 1 with rank 1 alone. Their runs
  // neither coincide nor are disjoint, and rank 1's row stands in both.
  const runs = {
    rounds: [0, 0],
    runLengths: [2, 1],
    ownerStarts: [0, 2, 3],
    owners: [0, 1, 1],
  };
  expect(() =>
    resolveRunGroupedReturn("me", "the list", [0, 3, 3], 5, runs),
  ).not.toThrow();
  // Which of its rows the partner puts behind which of its groups is its own
  // word throughout, so exchanging the two rows is admitted: what the rule
  // holds is which of THIS party's records share a row, and that is unmoved.
  expect(() =>
    resolveRunGroupedReturn("me", "the list", [3, 0, 0], 5, runs),
  ).not.toThrow();
});

test("a group the return leaves without a row is refused", () => {
  // This party resolved entry 0 was accepted with two of the partner's groups
  // and entry 1 with one of them, and the return hands entry 0 the row it hands
  // entry 1 -- so the group entry 0 alone was accepted with has no row, and the
  // pairs resting on it are dropped by the partner rather than by this party's
  // own resolution.
  expectProtocolRefusal(
    refusalFrom(() =>
      resolveRunGroupedReturn("me", "the list", [2, 2], 5, {
        rounds: [0, 0],
        runLengths: [1, 1],
        ownerStarts: [0, 2, 3],
        owners: [0, 1, 1],
      }),
    ),
    /the list leaves a group of the partner's records this side matched without a row/,
  );
});

test("a run naming one partner row twice is refused within the run", () => {
  // The rows of a run are the partner's own records, which are distinct: a row
  // named twice for one of this party's records is a repeated pair.
  expectProtocolRefusal(
    refusalFrom(() =>
      resolveRunGroupedReturn("me", "the list", [3, 3, 5], 6, {
        rounds: [0, 0],
        runLengths: [2, 1],
        ownerStarts: [0, 2, 3],
        owners: [0, 1, 1],
      }),
    ),
    /the list names one partner row twice for one record this side matched/,
  );
});

test("each round resolves its own ranks", () => {
  // A rank means nothing across rounds: each round's runs are read against the
  // groups that round accepted, so one round's rank 0 and another's are
  // resolved separately and may stand for different rows.
  expect(
    resolveRunGroupedReturn("me", "the list", [1, 2], 5, {
      rounds: [0, 1],
      runLengths: [1, 1],
      ownerStarts: [0, 1, 2],
      owners: [0, 0],
    }),
  ).toStrictEqual(
    new Map([
      [0, new Map([[0, [1]]])],
      [1, new Map([[0, [2]]])],
    ]),
  );
});

test("a row named in two key rounds is refused", () => {
  // A record accepted in one round leaves candidacy for every later one, so no
  // partner row stands in two rounds' runs. Each round's partition is read on
  // its own and admits this one -- round 0's rank 0 and round 1's rank 0 each
  // hold the row for the single entry of their own round -- so the rule reads
  // over the whole list.
  expectProtocolRefusal(
    refusalFrom(() =>
      resolveRunGroupedReturn("me", "the list", [1, 1], 5, {
        rounds: [0, 1],
        runLengths: [1, 1],
        ownerStarts: [0, 1, 2],
        owners: [0, 0],
      }),
    ),
    /the list names one partner row in two key rounds/,
  );
});

test("an out-of-range or fractional entry is refused before the pairing", () => {
  const runs = {
    rounds: [0],
    runLengths: [1],
    ownerStarts: [0, 1],
    owners: [0],
  };
  expectProtocolRefusal(
    refusalFrom(() => resolveRunGroupedReturn("me", "the list", [5], 5, runs)),
    /the list has an index outside \[0, 5\)/,
  );
  expectProtocolRefusal(
    refusalFrom(() =>
      resolveRunGroupedReturn("me", "the list", [0.5], 5, runs),
    ),
    /the list has an entry that is not a whole number/,
  );
});

test("runs that do not cover the list are a caller fault", () => {
  // The run lengths are the count this party pinned the list's length to before
  // getting here, so runs that do not add up to it are a local misuse rather
  // than the partner's violation.
  expectCallerFault(
    () =>
      resolveRunGroupedReturn("me", "the list", [0, 1, 2], ROWS, {
        rounds: [0, 0],
        runLengths: [1, 1],
        ownerStarts: [0, 1, 2],
        owners: [0, 1],
      }),
    /runs to cover the list, given runs totalling 2 for 3 entries/,
  );
  expectCallerFault(
    () =>
      resolveRunGroupedReturn("me", "the list", [0, 1], ROWS, {
        rounds: [0, 0],
        runLengths: [1, 2],
        ownerStarts: [0, 1, 2],
        owners: [0, 1],
      }),
    /runs running past 2 entries/,
  );
  expectCallerFault(
    () =>
      resolveRunGroupedReturn("me", "the list", [0, 1], ROWS, {
        rounds: [0, 0],
        runLengths: [1, 1],
        ownerStarts: [0, 1],
        owners: [0],
      }),
    /one length and one owner list per run, given 2 and 1 for 2 run\(s\)/,
  );
});

// --- The untouched run --------------------------------------------------------

test("an untouched exchange is unaffected by the checks", async () => {
  const [starterConn, joinerConn] = createMessagePipe();
  const [starterResult, joinerResult] = await Promise.all([
    linkViaPSI(
      { cardinality: "one-to-one" },
      makeParticipant("starter"),
      starterConn,
      starterKeys,
      fanOutFreeBounds(starterKeys.length, ROWS),
      -1,
    ),
    linkViaPSI(
      { cardinality: "one-to-one" },
      makeParticipant("joiner"),
      joinerConn,
      joinerKeys,
      fanOutFreeBounds(joinerKeys.length, ROWS),
      -1,
    ),
  ]);
  expect(starterResult[0]).toStrictEqual([1, 2]);
  expect(starterResult[1]).toStrictEqual(joinerResult[0]);
  expect(joinerResult[1]).toStrictEqual(starterResult[0]);
});

// --- The round's per-round grouping -------------------------------------------
// A cascade round a candidate set widened holds each party's own grouping on
// the frame it sends: the receiver's association table as a third element, the
// sender's original-index list as a second beside it. The grouping is the
// partner's own word, bounded but not verifiable, so every bound below is a
// quantity the checking party already holds -- the frame's own already-checked
// index list, the width the agreed terms declare, and the record count the
// partner declared on the terms exchange (docs/spec/PROTOCOL.md, The checks
// stay local).

type Cells = Array<Array<string | Set<string> | undefined>>;

// Each party's row 0 realizes two candidates and row 1 one, so both send the
// run-length grouping [2, 1] over three matched positions.
const WIDENED_STARTER_KEYS: Cells = [[new Set(["A", "B"]), "C"]];
const WIDENED_JOINER_KEYS: Cells = [[new Set(["A", "B"]), "C"]];

type Grouping = Array<number | Array<number>>;

// Frame 4 as a widened round sends it: the association table's two index halves
// with the sending party's grouping beside them.
function onRoundTable(
  transform: (table: [number[], number[], Grouping | undefined]) => unknown,
): Deviation {
  return (frame) =>
    Array.isArray(frame) && Array.isArray(frame[0]) && Array.isArray(frame[1])
      ? transform(frame as [number[], number[], Grouping | undefined])
      : frame;
}

// Frame 5 as a widened round sends it, and as an unwidened one does: the
// original-index list alone, or that list with the grouping beside it.
function onRoundIndexList(
  transform: (list: Array<number>, grouping: Grouping | undefined) => unknown,
): Deviation {
  return (frame) => {
    if (!Array.isArray(frame)) return frame;
    if (frame.length > 0 && frame.every((entry) => typeof entry === "number"))
      return transform(frame as Array<number>, undefined);
    if (
      frame.length === 2 &&
      Array.isArray(frame[0]) &&
      Array.isArray(frame[1])
    )
      return transform(frame[0] as Array<number>, frame[1] as Grouping);
    return frame;
  };
}

// Width one, so the per-record ceiling is the bare fan-out factor and a
// deviation can cross it inside a three-position round.
async function widenedRound(
  party: "starter" | "joiner",
  deviate: Deviation,
  starterKeys: Cells = WIDENED_STARTER_KEYS,
  joinerKeys: Cells = WIDENED_JOINER_KEYS,
  starterCardinality: LinkageCardinality = "one-to-one",
): Promise<unknown> {
  const [starterConn, joinerConn] = createMessagePipe();
  const bounds = (partnerRows: number) => ({
    partnerRecordCount: partnerRows,
    keyWidths: [1],
  });
  // The element bound is the round's own, derived per message; a widened round
  // legitimately encrypts more elements than its row count, so these fixtures
  // are not the place to pin it.
  const wideParticipant = (role: "starter" | "joiner") =>
    new PSIParticipant(
      role === "starter" ? "server" : "client",
      psiLibrary,
      { role, verbose: -1 },
      UNBOUNDED_PSI_ELEMENTS,
    );
  const starterRun = linkViaPSI(
    { cardinality: starterCardinality },
    wideParticipant("starter"),
    party === "starter" ? deviatingInbound(starterConn, deviate) : starterConn,
    starterKeys,
    bounds(joinerKeys[0].length),
    -1,
  );
  const joinerRun = linkViaPSI(
    {
      cardinality:
        starterCardinality === "many-to-one"
          ? "one-to-many"
          : starterCardinality === "one-to-many"
            ? "many-to-one"
            : starterCardinality,
    },
    wideParticipant("joiner"),
    party === "joiner" ? deviatingInbound(joinerConn, deviate) : joinerConn,
    joinerKeys,
    bounds(starterKeys[0].length),
    -1,
  );
  const under = party === "starter" ? starterRun : joinerRun;
  const outcome = await under.then(
    () => undefined,
    (err: unknown) => err,
  );
  await starterConn.close();
  await joinerRun.catch(() => undefined);
  await starterRun.catch(() => undefined);
  return outcome;
}

test("a widened round runs untouched", async () => {
  expect(await widenedRound("starter", (frame) => frame)).toBeUndefined();
});

test("the round refuses a grouping with a zero-length run", async () => {
  const err = await widenedRound(
    "starter",
    onRoundTable((table) => [table[0], table[1], [0, 3]]),
  );
  expectProtocolRefusal(err, /not a positive whole number/);
});

test("the round refuses a grouping whose runs sum short", async () => {
  const err = await widenedRound(
    "starter",
    onRoundTable((table) => [table[0], table[1], [2]]),
  );
  expectProtocolRefusal(err, /summing to 2, not the 3 matched position/);
});

test("the round refuses a grouping whose runs sum long", async () => {
  const err = await widenedRound(
    "starter",
    onRoundTable((table) => [table[0], table[1], [2, 2]]),
  );
  expectProtocolRefusal(err, /summing past the matched positions/);
});

test("the round refuses a run longer than the key's candidate count", async () => {
  const err = await widenedRound(
    "starter",
    onRoundTable((table) => [table[0], table[1], [21]]),
  );
  expectProtocolRefusal(err, /longer than the candidate count one record may/);
});

test("the round refuses a fractional run length", async () => {
  const err = await widenedRound(
    "starter",
    onRoundTable((table) => [table[0], table[1], [1.5, 1.5]]),
  );
  expectProtocolRefusal(err, /not a positive whole number/);
});

test("the round refuses runs naming more records than the partner counted", async () => {
  const err = await widenedRound(
    "starter",
    onRoundTable((table) => [table[0], table[1], [1, 1, 1]]),
  );
  expectProtocolRefusal(err, /more runs than the 2 record\(s\) the partner/);
});

test("the round refuses an owner list where run lengths are due", async () => {
  const err = await widenedRound(
    "starter",
    onRoundTable((table) => [table[0], table[1], [[0], [0], [1]]]),
  );
  expectProtocolRefusal(err, /states an owner list where its side/);
});

test("the mirror role refuses the same grouping on the original-index list", async () => {
  const err = await widenedRound(
    "joiner",
    onRoundIndexList((list) => [list, [0, 3]]),
  );
  expectProtocolRefusal(err, /not a positive whole number/);
});

test("the mirror role refuses a grouping the frame's own length contradicts", async () => {
  const err = await widenedRound(
    "joiner",
    onRoundIndexList((list) => [list, [1, 1]]),
  );
  expectProtocolRefusal(err, /summing to 2, not the 3 matched position/);
});

// The ragged form: the starter deduplicates and fans out, so one of its matched
// positions is owned by several records while one of its records owns several
// positions. The joiner reads that form, its side of the resolved cardinality
// fixing which one is due.
const RAGGED_STARTER_KEYS: Cells = [[new Set(["A", "B"]), "A", "C"]];
const RAGGED_JOINER_KEYS: Cells = [["A", "B", "C"]];

function raggedRound(deviate: Deviation): Promise<unknown> {
  return widenedRound(
    "joiner",
    deviate,
    RAGGED_STARTER_KEYS,
    RAGGED_JOINER_KEYS,
    "many-to-one",
  );
}

test("a ragged round runs untouched", async () => {
  expect(await raggedRound((frame) => frame)).toBeUndefined();
});

test("the round refuses an owner list per position that misses a position", async () => {
  const err = await raggedRound(onRoundIndexList((list) => [list, [[0, 1]]]));
  expectProtocolRefusal(err, /1 owner list\(s\), not the 3 matched position/);
});

test("the round refuses a matched position with no owner", async () => {
  const err = await raggedRound(
    onRoundIndexList((list) => [list, [[0, 1], [], [2]]]),
  );
  expectProtocolRefusal(err, /leaves a matched position with no owner/);
});

test("the round refuses an owner list that is not strictly ascending", async () => {
  const err = await raggedRound(
    onRoundIndexList((list) => [list, [[1, 0], [0], [2]]]),
  );
  expectProtocolRefusal(err, /not a strictly ascending list of whole numbers/);
});

test("the round refuses an owner list repeating one ordinal", async () => {
  const err = await raggedRound(
    onRoundIndexList((list) => [list, [[0, 0], [0], [2]]]),
  );
  expectProtocolRefusal(err, /not a strictly ascending list of whole numbers/);
});

test("the round refuses a grouping that skips an ordinal", async () => {
  const err = await raggedRound(
    onRoundIndexList((list) => [list, [[0, 2], [0], [2]]]),
  );
  expectProtocolRefusal(err, /skips an ordinal/);
});

test("the round refuses a grouping naming more records than the partner counted", async () => {
  const err = await raggedRound(
    onRoundIndexList((list) => [list, [[0, 1], [0], [3]]]),
  );
  expectProtocolRefusal(err, /names 4 record\(s\), more than the 3 record/);
});

test("the round refuses run lengths where an owner list is due", async () => {
  const err = await raggedRound(onRoundIndexList((list) => [list, [2, 1, 1]]));
  expectProtocolRefusal(err, /states run lengths where its side/);
});

test("the round refuses an ordinal above the entries the grouping holds", async () => {
  const err = await raggedRound(
    onRoundIndexList((list) => [list, [[0, 1], [0], [5_000_000]]]),
  );
  expectProtocolRefusal(err, /skips an ordinal/);
});

// --- What a grouping may size ------------------------------------------------
// An ordinal is the partner's own word and the record count it is held to
// reaches MAX_RECORD_COUNT, so a read that sized a structure by an ordinal
// before checking it would let one entry reserve gigabytes. The probe counts
// every Int32Array the read constructs and holds each to the frame's own size.

function int32ArrayLengths(run: () => unknown): {
  outcome: unknown;
  lengths: Array<number>;
} {
  const lengths: Array<number> = [];
  const real = globalThis.Int32Array;
  globalThis.Int32Array = new Proxy(real, {
    construct(target, args: Array<unknown>) {
      if (typeof args[0] === "number") lengths.push(args[0]);
      return Reflect.construct(target, args) as object;
    },
  }) as Int32ArrayConstructor;
  try {
    return { outcome: run(), lengths };
  } catch (err: unknown) {
    return { outcome: err, lengths };
  } finally {
    globalThis.Int32Array = real;
  }
}

const HIGH_ORDINAL_POSITIONS = [0, 1, 2];

function readHighOrdinalGrouping(): unknown {
  return readPartnerRoundGrouping(
    [[0], [1], [5_000_000]],
    HIGH_ORDINAL_POSITIONS,
    {
      participantId: "party",
      maxPositionsPerRecord: 20,
      partnerRecordCount: MAX_RECORD_COUNT,
      ownerLists: true,
    },
  );
}

test("an ordinal far above the frame's own size allocates nothing on its scale", () => {
  const { outcome, lengths } = int32ArrayLengths(readHighOrdinalGrouping);
  expectProtocolRefusal(outcome, /skips an ordinal/);
  // The slot boundaries are the widest thing a grouping of three positions
  // legitimately needs; nothing is sized by the ordinal itself.
  expect(Math.max(...lengths)).toBeLessThanOrEqual(
    HIGH_ORDINAL_POSITIONS.length + 1,
  );
});

// One ordinal in more positions than the key's candidate count, which needs a
// round wider than that count to state at all: 21 matched positions against a
// per-record ceiling of 20.
const WIDE_VALUES = Array.from({ length: 21 }, (_unused, i) => `V${i}`);

test("the round refuses a grouping giving one record more positions than the key admits", async () => {
  const err = await widenedRound(
    "joiner",
    onRoundIndexList((list) => [list, WIDE_VALUES.map(() => [0])]),
    [WIDE_VALUES],
    [WIDE_VALUES],
    "many-to-one",
  );
  expectProtocolRefusal(err, /more positions than the candidate count/);
});

// --- The mapped-element pass's widened entry ----------------------------------
// A round's entries must be exactly the ones its accepted pairs state, entry
// for entry in the order sent, and each entry's positions distinct and
// ascending (docs/spec/PROTOCOL.md, The reading pass's preconditions, at the
// widened entry). Row 0 of each party matches both "A" and "B", so its entry
// names two positions and the deviations below reach shapes a single position
// could not.

test("the round refuses a mapped-element entry naming fewer positions than its pairs rest on", async () => {
  const err = await widenedRound(
    "starter",
    onMappedElementList(1, (list) =>
      list.map((entry) =>
        Array.isArray(entry.theirIndex)
          ? { ...entry, theirIndex: entry.theirIndex[0] }
          : entry,
      ),
    ),
  );
  expectProtocolRefusal(
    err,
    /names positions other than the ones that round's accepted pairs rest on/,
  );
});

test("the round refuses a mapped-element entry whose positions descend", async () => {
  const err = await widenedRound(
    "starter",
    onMappedElementList(1, (list) =>
      list.map((entry) =>
        Array.isArray(entry.theirIndex)
          ? { ...entry, theirIndex: [...entry.theirIndex].reverse() }
          : entry,
      ),
    ),
  );
  expectProtocolRefusal(
    err,
    /holds an entry whose positions are not in strictly ascending order/,
  );
});

test("the round refuses a mapped-element entry naming no position", async () => {
  const err = await widenedRound(
    "starter",
    onMappedElementList(1, (list) =>
      list.map((entry) => ({ ...entry, theirIndex: [] })),
    ),
  );
  expectProtocolRefusal(err, /holds an entry naming no position/);
});

// --- A position beyond what a round's slot index addresses --------------------
// Every bound a round position passes upstream is the partner's own declared
// element count, which reaches far past the range an index holds, so the round
// itself refuses a position at or above 2^31 rather than letting one wrap into
// its slot index. Both roles read a position list -- the starter the
// association table's partner half, the joiner the original-index list -- and
// both take the refusal whether or not the strategy allowlist admits a
// candidate set.

const BEYOND_INDEX_RANGE = 2 ** 31;

// One entry of the list moved past the range, the rest left as the honest
// partner computed them, so the frame breaks nothing else.
function nameBeyondIndexRange(list: Array<number>): Array<number> {
  return list.map((position, entry) =>
    entry === 0 ? BEYOND_INDEX_RANGE : position,
  );
}

const beyondRangeOnRoundTable = onRoundTable((table) => [
  nameBeyondIndexRange(table[0]),
  ...table.slice(1),
]);

const beyondRangeOnRoundIndexList = onRoundIndexList((list, grouping) =>
  grouping === undefined
    ? nameBeyondIndexRange(list)
    : [nameBeyondIndexRange(list), grouping],
);

// One value per record, so the round runs on the gate's shipped setting too.
const FLAT_STARTER_KEYS: Cells = [["A", "B", "C"]];
const FLAT_JOINER_KEYS: Cells = [["A", "B", "C"]];

test("the round refuses a position beyond what its slot index addresses", async () => {
  const err = await widenedRound("starter", beyondRangeOnRoundTable);
  expectProtocolRefusal(err, /outside that round's candidate set/);
});

test("the mirror role refuses the same position on the original-index list", async () => {
  const err = await widenedRound("joiner", beyondRangeOnRoundIndexList);
  expectProtocolRefusal(err, /outside that round's candidate set/);
});

test("the round refuses that position with the candidate-set gate closed", async () => {
  const err = await withCandidateSetGate(false, () =>
    widenedRound(
      "starter",
      beyondRangeOnRoundTable,
      FLAT_STARTER_KEYS,
      FLAT_JOINER_KEYS,
    ),
  );
  expectProtocolRefusal(err, /outside that round's candidate set/);
});

test("the mirror role refuses it with the candidate-set gate closed", async () => {
  const err = await withCandidateSetGate(false, () =>
    widenedRound(
      "joiner",
      beyondRangeOnRoundIndexList,
      FLAT_STARTER_KEYS,
      FLAT_JOINER_KEYS,
    ),
  );
  expectProtocolRefusal(err, /outside that round's candidate set/);
});
