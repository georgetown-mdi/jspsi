import { expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import { PSIParticipant } from "../src/participant";
import { linkViaPSI, linkViaSinglePassPSI } from "../src/link";
import {
  MAX_RECORD_COUNT,
  psiElementBounds,
} from "../src/connection/frameSize";
import { assertPartnerIndices } from "../src/utils/partnerIndices";
import { fanOutFreeBounds } from "./utils/singlePassBounds";
import {
  createMessagePipe,
  ConnectionError,
  type MessageConnection,
} from "../src/connection/messageConnection";
import type { AssociationTable } from "../src/types";

// Every index list a party receives from its partner addresses rows or per-round
// candidate positions the RECEIVING party owns, so each is checked against that
// party's own authenticated state before it drives the match set, the payload it
// discloses, or the attested record. The deviation tests here drive an otherwise
// honest two-party exchange and alter exactly one inbound frame, so what is
// asserted is the check under test rather than a crypto or framing failure: the
// deviating frame is refused as a classified protocol error, and an untouched run
// stays green.

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

type MappedElement = { theirIndex: number; iteration: number };
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
// position so a test reads as "the association table" / "the mapped-element list"
// and does not silently follow a renumbered sequence.
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
    ROWS,
    -1,
  );
  const joinerRun = linkViaPSI(
    { cardinality: "one-to-one" },
    makeParticipant("joiner"),
    joinerConn,
    joinerKeys,
    ROWS,
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

// The mirror seam on the other role: the joiner reads the starter's own matched
// indices as the round's final frame, one per pair the joiner reported. It is the
// only inbound frame of the round that is a plain array of numbers.
async function cascadeWithJoinerDeviation(
  transform: (list: Array<number>) => unknown,
): Promise<unknown> {
  const [starterConn, joinerConn] = createMessagePipe();
  const starterRun = linkViaPSI(
    { cardinality: "one-to-one" },
    makeParticipant("starter"),
    starterConn,
    starterKeys,
    ROWS,
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
    ROWS,
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
  // Reversing both halves keeps every entry whole, in range, distinct, and paired
  // with the same partner row, so the only property left to fail is the ascending
  // order the AssociationTable contract carries and the result rows are read in.
  const err = await singlePassWithDeviation(
    onIndexTable((table) => [[...table[0]].reverse(), [...table[1]].reverse()]),
  );
  expectProtocolRefusal(err, /local half is not in ascending order/);
});

test("single-pass sender accepts a resolved table whose partner half descends", async () => {
  // The order is a property of the LOCAL half alone: the partner half's entries
  // follow their pairing, not their own order, so requiring it there would refuse
  // an honest table. The fixture's own halves happen to ascend together, so this
  // is what keeps the rule from being read as covering both.
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
// links and the resolved table genuinely repeats -- a table the strict rule would
// have rejected.
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
  // carried on the terms exchange.
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
  // matched nothing. An honest partner names only the records this side matched,
  // so a probe at an unmatched one is refused rather than answered.
  const err = await cascadeWithDeviation(
    onMappedElementList(1, (list) => [
      { theirIndex: 0, iteration: 0 },
      ...list.slice(1),
    ]),
  );
  expectProtocolRefusal(err, /names a record this side did not match/);
});

test("cascade refuses a mapped-element list naming one record twice", async () => {
  const err = await cascadeWithDeviation(
    onMappedElementList(1, (list) => [list[0], { ...list[0] }]),
  );
  expectProtocolRefusal(err, /names one record twice/);
});

test("cascade refuses a mapped-element list longer than this side's match count", async () => {
  const err = await cascadeWithDeviation(
    onMappedElementList(1, (list) => [...list, { ...list[0] }]),
  );
  expectProtocolRefusal(
    err,
    /partner's mapped-element list has 3 entries, expected 2/,
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
// The detector picks its backing by the ratio of the bound to the list length, and
// every seam above runs at fixture scale, where the bitmap is always the smaller
// allocation. The widest bound a partner may declare is exercised here instead:
// the refusal must be the same classified protocol error, which it cannot be if
// the allocation is ever sized by that bound. A bitmap of MAX_RECORD_COUNT bytes
// does not fail cleanly -- V8 aborts the process rather than throwing -- so this
// test's failure, should the ratio guard ever go away, is unmissable.

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
    repeatsGroupedBy: { rounds: [0, 0, 0], positions: [0, 0, 1] },
  };
  expect(() =>
    assertPartnerIndices("me", "the list", [2, 2, 1], ROWS, rules),
  ).not.toThrow();
  expectProtocolRefusal(
    refusalFrom(() =>
      assertPartnerIndices("me", "the list", [2, 2, 2], ROWS, rules),
    ),
    /the list names one partner row for two positions this side matched/,
  );
  expectProtocolRefusal(
    refusalFrom(() =>
      assertPartnerIndices("me", "the list", [2, 1, 0], ROWS, rules),
    ),
    /the list names two partner rows for one position this side matched/,
  );
});

test("one position of each round is a group of its own", () => {
  // A position number means nothing across rounds: each round has its own
  // candidate set, so the same number in two rounds is two groups.
  const rules = { repeatsGroupedBy: { rounds: [0, 1], positions: [0, 0] } };
  expectProtocolRefusal(
    refusalFrom(() =>
      assertPartnerIndices("me", "the list", [1, 1], ROWS, rules),
    ),
    /names one partner row for two positions this side matched/,
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
      repeatsGroupedBy: { rounds: [0], positions: [0] },
    }),
  );
  expect(err).toBeInstanceOf(Error);
  expect(err).not.toBeInstanceOf(ConnectionError);
  expect((err as Error).message).toMatch(/one group per entry/);
});

// --- the same rule where the grouping answers in runs -------------------------
// Where the partner keeps its own duplicates too, one entry this party sent comes
// back as the whole partner group behind the position it named, so the list is a
// concatenation of runs rather than one entry per outbound entry. The rule is the
// same one read at that granularity: runs of one group identical, runs of
// different groups disjoint, and distinctness surviving inside a run.

const expectCallerFault = (run: () => void, detail: RegExp): void => {
  const err = refusalFrom(run);
  expect(err).toBeInstanceOf(Error);
  expect(err).not.toBeInstanceOf(ConnectionError);
  expect((err as Error).message).toMatch(detail);
};

test("runs of one group must be identical and runs of two must be disjoint", () => {
  // Outbound entries 0 and 1 named one position and came back with two rows each;
  // entry 2 named another and came back with one.
  const rules = {
    repeatsGroupedByRuns: {
      rounds: [0, 0, 0],
      positions: [0, 0, 1],
      runLengths: [2, 2, 1],
    },
  };
  expect(() =>
    assertPartnerIndices("me", "the list", [2, 1, 2, 1, 0], ROWS, rules),
  ).not.toThrow();
  expectProtocolRefusal(
    refusalFrom(() =>
      assertPartnerIndices("me", "the list", [2, 1, 2, 1, 2], ROWS, rules),
    ),
    /the list names one partner row for two positions this side matched/,
  );
  expectProtocolRefusal(
    refusalFrom(() =>
      assertPartnerIndices("me", "the list", [2, 1, 2, 0, 1], ROWS, rules),
    ),
    /the list names two partner rows for one position this side matched/,
  );
});

test("a run naming one partner row twice is refused within the run", () => {
  // The run is the partner's own group, whose rows are distinct: a row named twice
  // for one of this party's records is a repeated pair, reported as such rather
  // than as a merge of two groups.
  expectProtocolRefusal(
    refusalFrom(() =>
      assertPartnerIndices("me", "the list", [2, 2], ROWS, {
        repeatsGroupedByRuns: {
          rounds: [0],
          positions: [0],
          runLengths: [2],
        },
      }),
    ),
    /the list names one partner row twice for one record this side matched/,
  );
});

test("one position of each round is a group of its own under the run rule", () => {
  // A position number means nothing across rounds here either, so runs answering
  // the same position in two rounds must be disjoint.
  const rules = {
    repeatsGroupedByRuns: {
      rounds: [0, 1],
      positions: [0, 0],
      runLengths: [1, 1],
    },
  };
  expectProtocolRefusal(
    refusalFrom(() =>
      assertPartnerIndices("me", "the list", [1, 1], ROWS, rules),
    ),
    /names one partner row for two positions this side matched/,
  );
  expect(() =>
    assertPartnerIndices("me", "the list", [1, 2], ROWS, rules),
  ).not.toThrow();
});

test("run lengths that do not cover the list are a caller fault", () => {
  // The run lengths are the count this party pinned the list's length to before
  // getting here, so runs that do not add up to it are a local misuse rather than
  // the partner's violation -- and the comparison of a later run against its
  // group's first never reads past the run it was given.
  expectCallerFault(
    () =>
      assertPartnerIndices("me", "the list", [0, 1, 2], ROWS, {
        repeatsGroupedByRuns: {
          rounds: [0, 0],
          positions: [0, 1],
          runLengths: [1, 1],
        },
      }),
    /runs to cover the list, given runs totalling 2 for 3 entries/,
  );
  expectCallerFault(
    () =>
      assertPartnerIndices("me", "the list", [0, 1], ROWS, {
        repeatsGroupedByRuns: {
          rounds: [0, 0],
          positions: [0],
          runLengths: [1, 1],
        },
      }),
    /one group per run/,
  );
  expectCallerFault(
    () =>
      assertPartnerIndices("me", "the list", [0, 1, 2], ROWS, {
        repeatsGroupedByRuns: {
          rounds: [0, 0],
          positions: [0, 0],
          runLengths: [1, 2],
        },
      }),
    /one run length per position this side matched, given 1 and 2/,
  );
});

test("the run rule cannot be combined with either other relaxation", () => {
  // Each rule holds a repeat to a different thing, so no list can be under two of
  // them at once -- the check that keeps a caller from relaxing distinctness twice
  // and getting neither rule's guarantee.
  for (const other of [
    { repeats: true },
    { repeatsGroupedBy: { rounds: [0], positions: [0] } },
  ])
    expectCallerFault(
      () =>
        assertPartnerIndices("me", "the list", [0], ROWS, {
          repeatsGroupedByRuns: {
            rounds: [0],
            positions: [0],
            runLengths: [1],
          },
          ...other,
        }),
      /at most one of them applies to a list/,
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
      ROWS,
      -1,
    ),
    linkViaPSI(
      { cardinality: "one-to-one" },
      makeParticipant("joiner"),
      joinerConn,
      joinerKeys,
      ROWS,
      -1,
    ),
  ]);
  expect(starterResult[0]).toStrictEqual([1, 2]);
  expect(starterResult[1]).toStrictEqual(joinerResult[0]);
  expect(joinerResult[1]).toStrictEqual(starterResult[0]);
});
