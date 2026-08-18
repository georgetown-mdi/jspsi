import { expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import { PSIParticipant } from "../src/participant";
import { linkViaPSI, linkViaSinglePassPSI } from "../src/link";
import {
  MAX_RECORD_COUNT,
  psiElementBounds,
} from "../src/connection/frameSize";
import { assertPartnerIndices } from "../src/utils/partnerIndices";
import {
  createMessagePipe,
  ConnectionError,
  type MessageConnection,
} from "../src/connection/messageConnection";

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
const elementBounds = psiElementBounds(1, ROWS, ROWS);

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
    ROWS,
    false,
    -1,
  );
  const receiverRun = linkViaSinglePassPSI(
    { cardinality: "one-to-one" },
    makeParticipant("joiner"),
    receiverConn,
    joinerKeys,
    ROWS,
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
  expectProtocolRefusal(err, /local half carries an index outside \[0, 3\)/);
});

test("single-pass sender refuses a resolved table naming a partner row beyond the exchanged count", async () => {
  const err = await singlePassWithDeviation(
    onIndexTable((table) => [[table[0][0]], [ROWS]]),
  );
  expectProtocolRefusal(err, /partner half carries an index outside \[0, 3\)/);
});

test("single-pass sender refuses a resolved table whose halves disagree in length", async () => {
  const err = await singlePassWithDeviation(
    onIndexTable((table) => [table[0], table[1].slice(1)]),
  );
  expectProtocolRefusal(err, /partner half carries 1 entry, expected 2/);
});

test("single-pass sender refuses a resolved table with a fractional index", async () => {
  const err = await singlePassWithDeviation(
    onIndexTable((table) => [table[0].map(() => 1.5), table[1]]),
  );
  expectProtocolRefusal(
    err,
    /local half carries an entry that is not a whole number/,
  );
});

test("single-pass sender refuses a resolved table with a negative index", async () => {
  const err = await singlePassWithDeviation(
    onIndexTable((table) => [table[0], [-1, ...table[1].slice(1)]]),
  );
  expectProtocolRefusal(err, /partner half carries an index outside \[0, 3\)/);
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
  expectProtocolRefusal(err, /local half carries 4 entries, more than the 3/);
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
    /round's association table, local half carries an index outside \[0, 3\)/,
  );
});

test("cascade starter refuses a round table naming a partner element beyond its bound", async () => {
  const err = await cascadeWithDeviation(
    onIndexTable((table) => [table[0].map(() => 99), table[1]]),
  );
  expectProtocolRefusal(
    err,
    /round's association table, partner half carries an index outside \[0, 3\)/,
  );
});

test("cascade starter refuses a round table whose halves disagree in length", async () => {
  const err = await cascadeWithDeviation(
    onIndexTable((table) => [[...table[0], 0], table[1]]),
  );
  expectProtocolRefusal(
    err,
    /round's association table, partner half carries 3 entries, expected 2/,
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
    /round's association table, local half carries an entry that is not a whole number/,
  );
});

test("cascade starter refuses a round table with a negative index", async () => {
  const err = await cascadeWithDeviation(
    onIndexTable((table) => [[-1, ...table[0].slice(1)], table[1]]),
  );
  expectProtocolRefusal(
    err,
    /round's association table, partner half carries an index outside \[0, 3\)/,
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
    /round's association table, local half carries 4 entries, more than the 3/,
  );
});

test("cascade joiner refuses an original-index list of the wrong length", async () => {
  const err = await cascadeWithJoinerDeviation((list) => [...list, 0]);
  expectProtocolRefusal(
    err,
    /original-index list carries 3 entries, expected 2/,
  );
});

test("cascade joiner refuses an original-index list naming an element beyond its bound", async () => {
  const err = await cascadeWithJoinerDeviation((list) => list.map(() => 99));
  expectProtocolRefusal(
    err,
    /original-index list carries an index outside \[0, 3\)/,
  );
});

test("cascade joiner refuses an original-index list with a fractional entry", async () => {
  const err = await cascadeWithJoinerDeviation((list) => list.map(() => 1.5));
  expectProtocolRefusal(
    err,
    /original-index list carries an entry that is not a whole number/,
  );
});

test("cascade joiner refuses an original-index list with a negative entry", async () => {
  const err = await cascadeWithJoinerDeviation((list) => [
    -1,
    ...list.slice(1),
  ]);
  expectProtocolRefusal(
    err,
    /original-index list carries an index outside \[0, 3\)/,
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
    /partner's mapped-element list carries 3 entries, expected 2/,
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
    /returned mapped-element list carries an index outside \[0, 3\)/,
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
    /returned mapped-element list carries 1 entry, expected 2/,
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
    /returned mapped-element list carries an entry that is not a whole number/,
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
    /returned mapped-element list carries an index outside \[0, 3\)/,
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
