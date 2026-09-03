import { expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import { PSIParticipant } from "../src/participant";
import {
  prepareForExchange,
  runExchange,
  type ExchangeResult,
} from "../src/exchange";
import {
  decodeRaggedIndexTable,
  linkViaSinglePassPSI,
  type LinkageCardinality,
  type SinglePassSessionBounds,
} from "../src/link";
import {
  declaredEffectiveKeyCount,
  FAN_OUT_CANDIDATES_PER_ELEMENT,
} from "../src/fanOutFunctions";
import {
  MAX_SINGLE_PASS_CELLS,
  singlePassReplyByteCap,
} from "../src/connection/frameSize";
import { MAX_LINKAGE_ENTRIES } from "../src/config/linkageTerms";
import {
  createMessagePipe,
  ConnectionError,
} from "../src/connection/messageConnection";
import { UsageError } from "../src/errors";
import type { LinkageTerms } from "../src/config/linkageTerms";
import type { AssociationTable } from "../src/types";
import { UNBOUNDED_PSI_ELEMENTS } from "./utils/psiElementBounds";

const psiLibrary = await PSI();

// Fan-out matching is specified for single-pass and for it alone
// (docs/spec/PROTOCOL.md, Fan-out matching). Most of these drive
// linkViaSinglePassPSI directly, over candidate sets handed to it, so a rule can
// be exercised on the exact shape it governs; the end-to-end section at the
// bottom runs the whole path instead -- authored terms, key realization, the
// terms exchange, and the resolved association table.

// --- the declared effective key count ----------------------------------------
// The agreed terms' per-key widths, summed: the number the slot arithmetic, the
// message-2 layout, and the derived caps all read, on both parties.

const fanOutStep = { function: "split_on", params: { delimiter: "/" } };

function termsWith(
  keys: LinkageTerms["linkageKeys"],
): Pick<LinkageTerms, "linkageKeys"> {
  return { linkageKeys: keys };
}

test("a party declaring no fan-out has its plain key count", () => {
  const terms = termsWith([
    { name: "one", elements: [{ field: "ssn" }] },
    { name: "two", elements: [{ field: "lastName" }, { field: "dob" }] },
  ]) as LinkageTerms;
  expect(declaredEffectiveKeyCount(terms)).toBe(2);
});

test("an element transform's fan-out raises only its own key's factor", () => {
  const terms = termsWith([
    { name: "one", elements: [{ field: "ssn", transform: [fanOutStep] }] },
    { name: "two", elements: [{ field: "lastName" }] },
  ]) as LinkageTerms;
  expect(declaredEffectiveKeyCount(terms)).toBe(
    FAN_OUT_CANDIDATES_PER_ELEMENT + 1,
  );
});

test("two elements declaring a fan-out compound across their key", () => {
  // buildKeyStrings crosses each element's candidates into the key, so a key
  // whose elements both expand realizes their product; declaring the larger of
  // the two would refuse honest rows at the width seam.
  const terms = termsWith([
    {
      name: "one",
      elements: [
        { field: "ssn", transform: [fanOutStep] },
        { field: "lastName", transform: [fanOutStep] },
      ],
    },
  ]) as LinkageTerms;
  expect(declaredEffectiveKeyCount(terms)).toBe(
    FAN_OUT_CANDIDATES_PER_ELEMENT * FAN_OUT_CANDIDATES_PER_ELEMENT,
  );
});

// --- message 2 part (d): the ragged layout's decode guards --------------------
// Every bound comes from authenticated session state -- the agreed key count, the
// record count the sender carried on the terms exchange, the normative width
// bound, and the sender's declared slot bound -- never from the frame itself. A
// frame failing any of them is a clean protocol error, not a wrong
// reconstruction.

// Two keys over two records, both keys declaring a fan-out (slot bound 2 * 20).
const RAGGED_KEY_WIDTHS = [
  FAN_OUT_CANDIDATES_PER_ELEMENT,
  FAN_OUT_CANDIDATES_PER_ELEMENT,
];
const RAGGED_ROWS = 2;
const RAGGED_SLOT_BOUND = FAN_OUT_CANDIDATES_PER_ELEMENT * RAGGED_ROWS;

function decodeRagged(words: Array<number>) {
  return decodeRaggedIndexTable(
    "client",
    Int32Array.from(words),
    RAGGED_KEY_WIDTHS,
    RAGGED_ROWS,
    RAGGED_SLOT_BOUND,
  );
}

// Every ragged-table guard refuses PARTNER content, so the class is part of each
// refusal's contract and not only its wording: a caller distinguishes a partner
// fault from a local one by the ConnectionError kind alone.
function expectProtocolRefusal(decode: () => unknown, message: RegExp): void {
  const err = (() => {
    try {
      decode();
      return undefined;
    } catch (e: unknown) {
      return e;
    }
  })();
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("protocol");
  expect((err as ConnectionError).message).toMatch(message);
}

test("a well-formed ragged table decodes to the cells it declares", () => {
  // key 0: row 0 -> {3, 7}, row 1 -> {}; key 1: row 0 -> {0}, row 1 -> {1, 2, 5}.
  const cells = decodeRagged([2, 3, 7, 0, 1, 0, 3, 1, 2, 5]);
  expect(cells).toHaveLength(RAGGED_KEY_WIDTHS.length);
  expect(cells[0].count(0)).toBe(2);
  expect([cells[0].valueAt(0, 0), cells[0].valueAt(0, 1)]).toEqual([3, 7]);
  expect(cells[0].count(1)).toBe(0);
  expect(cells[1].count(0)).toBe(1);
  expect(cells[1].valueAt(0, 0)).toBe(0);
  expect(cells[1].count(1)).toBe(3);
  expect([
    cells[1].valueAt(1, 0),
    cells[1].valueAt(1, 1),
    cells[1].valueAt(1, 2),
  ]).toEqual([1, 2, 5]);
});

test.each([
  [
    "carrying fewer words than the agreed key and record counts declare cells",
    [0, 0, 0],
    /fewer cells than the agreed key and record counts/,
  ],
  [
    "declaring a cell wider than the width its key declares",
    [FAN_OUT_CANDIDATES_PER_ELEMENT + 1, 0, 0, 0, 0],
    /wider than the agreed terms declare for a key/,
  ],
  [
    "declaring a negative candidate count",
    [-1, 0, 0, 0],
    /wider than the agreed terms declare for a key/,
  ],
  [
    "repeating a value index inside one cell",
    [2, 4, 4, 0, 0, 0],
    /not strictly ascending/,
  ],
  [
    "listing a cell's value indices out of order",
    [2, 7, 3, 0, 0, 0],
    /not strictly ascending/,
  ],
  [
    "naming a value index outside the sender's declared value set",
    [1, RAGGED_SLOT_BOUND, 0, 0, 0],
    /outside the sender's declared value set/,
  ],
  [
    "running out of words inside a cell it declared",
    [0, 0, 0, 3, 1, 2],
    /truncated inside a cell it declared/,
  ],
  [
    "carrying trailing words past its last cell",
    [1, 0, 0, 0, 0, 9],
    /trailing words past its last cell/,
  ],
])("the ragged table is refused for %s", (_label, words, message) => {
  expectProtocolRefusal(() => decodeRagged(words), message);
});

// The same guards under a width vector whose keys DIFFER. Every fixture above is
// uniform, so a decode reading the first key's width for every cell reads them
// all correctly; agreed terms produce a mixed vector as soon as one key declares
// a fan-out and another a narrower expansion, and it is the mixed case that
// separates `keyWidths[j]` from `keyWidths[0]`.
const MIXED_KEY_WIDTHS = [FAN_OUT_CANDIDATES_PER_ELEMENT, 3];
const MIXED_SLOT_BOUND =
  MIXED_KEY_WIDTHS.reduce((sum, width) => sum + width, 0) * RAGGED_ROWS;

function decodeMixed(words: Array<number>) {
  return decodeRaggedIndexTable(
    "client",
    Int32Array.from(words),
    MIXED_KEY_WIDTHS,
    RAGGED_ROWS,
    MIXED_SLOT_BOUND,
  );
}

test("a mixed-width table decodes each key's cells at that key's own width", () => {
  // Key 0 carries a cell of 4, above the 3 key 1 declares; key 1 carries one of
  // exactly its own 3. A decode holding every cell to the narrower width refuses
  // this honest table, and one holding them all to the wider passes the refusal
  // below.
  const cells = decodeMixed([4, 0, 1, 2, 3, 0, 3, 0, 1, 2, 1, 5]);
  expect(cells).toHaveLength(MIXED_KEY_WIDTHS.length);
  expect(cells[0].count(0)).toBe(4);
  expect(cells[0].count(1)).toBe(0);
  expect(cells[1].count(0)).toBe(3);
  expect(cells[1].count(1)).toBe(1);
  expect(cells[1].valueAt(1, 0)).toBe(5);
});

test("a mixed-width table is refused for a cell inside the FIRST key's width and outside its own", () => {
  // The width the refusal reads is key 1's, not the table's widest: this cell of
  // 4 would be conforming under key 0 and is not under key 1.
  expectProtocolRefusal(
    () => decodeMixed([4, 0, 1, 2, 3, 0, 4, 0, 1, 2, 3, 0]),
    /wider than the agreed terms declare for a key/,
  );
});

test("the ragged table is refused for carrying more candidates than the declared width admits", () => {
  // The running total is bounded by the sender's OWN advertised slot count, so a
  // frame within the width bound cell by cell is still refused when its cells sum
  // past what the sender said it would ship. It is the guard bounding the one
  // allocation the frame's own word count sizes, so its class carries as much as
  // its wording: a caller reads a partner fault off the class.
  const words = [2, 0, 1, 2, 2, 3, 2, 4, 5, 2, 6, 7];
  expectProtocolRefusal(
    () =>
      decodeRaggedIndexTable(
        "client",
        Int32Array.from(words),
        RAGGED_KEY_WIDTHS,
        2,
        7,
      ),
    /more candidate values than the sender's declared width/,
  );
});

// --- the sender's own fan-out factor, recovered from the two counts ----------
// A sender whose OWN cleaning fans out declares the records that cleaning stands
// for while its table still carries the rows it holds, so the receiver recovers
// the factor as the quotient of the count the sender exchanged and the count its
// frame declares. Nothing about the fan-out is on the wire, so the quotient is
// the whole of what the receiver has: it is held to the two an honest local
// fan-out can produce, and every other reading is a protocol refusal.

// The sender and receiver of one recovery fixture, run to settlement. The sender
// fans out nowhere and ships the rows it holds, so what the recovery reads is
// the count the receiver was handed for it. The sender's table is WITHHELD so it
// returns the moment its reply is sent: a receiver that refuses the reply sends
// no message 3, and an in-memory pipe carries no inactivity deadline for the
// sender to give up on.
function factorRecoveryPair(
  senderData: Array<Column>,
  receiverData: Array<Column>,
  senderRecordCountTheReceiverHolds: number,
): Promise<Array<PromiseSettledResult<AssociationTable>>> {
  const [senderConn, receiverConn] = createMessagePipe();
  return Promise.allSettled([
    linkViaSinglePassPSI(
      { cardinality: "one-to-one" },
      new PSIParticipant(
        "server",
        psiLibrary,
        { role: "starter", verbose: -1 },
        UNBOUNDED_PSI_ELEMENTS,
      ),
      senderConn,
      senderData,
      boundsFor(receiverData[0].length, [1]),
      true,
      -1,
    ),
    linkViaSinglePassPSI(
      { cardinality: "one-to-one" },
      new PSIParticipant(
        "client",
        psiLibrary,
        { role: "joiner", verbose: -1 },
        UNBOUNDED_PSI_ELEMENTS,
      ),
      receiverConn,
      receiverData,
      boundsFor(senderRecordCountTheReceiverHolds, [1]),
      true,
      -1,
    ),
  ]);
}

function expectRecoveryRefusal(
  settled: Array<PromiseSettledResult<AssociationTable>>,
  message: RegExp,
): void {
  const [sender, receiver] = settled;
  // The sender is honest: it built and sent its reply, and only the receiver's
  // reading of the two counts refuses.
  expect(sender.status).toBe("fulfilled");
  expect(receiver.status).toBe("rejected");
  const err = (receiver as PromiseRejectedResult).reason as unknown;
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("protocol");
  expect((err as ConnectionError).message).toMatch(message);
}

test("an honest fanning sender's ragged table decodes to the pairs its rows hold", async () => {
  // The sender's cleaning splits one of its two rows, so it declares 40 records
  // for the 2 it ships and its cells carry up to a whole declared step's
  // candidates. The receiver recovers the factor from those two counts alone and
  // reads the ragged table at the widths the agreed terms declare times it.
  const [senderConn, receiverConn] = createMessagePipe();
  const [senderTable, receiverTable] = await Promise.all([
    linkViaSinglePassPSI(
      { cardinality: "one-to-one" },
      new PSIParticipant(
        "server",
        psiLibrary,
        { role: "starter", verbose: -1 },
        UNBOUNDED_PSI_ELEMENTS,
      ),
      senderConn,
      [[new Set(["SMITH", "JONES"]), "BROWN"]],
      boundsFor(2, [1], FAN_OUT_CANDIDATES_PER_ELEMENT),
      false,
      -1,
    ),
    linkViaSinglePassPSI(
      { cardinality: "one-to-one" },
      new PSIParticipant(
        "client",
        psiLibrary,
        { role: "joiner", verbose: -1 },
        UNBOUNDED_PSI_ELEMENTS,
      ),
      receiverConn,
      [["JONES", "BROWN"]],
      boundsFor(2 * FAN_OUT_CANDIDATES_PER_ELEMENT, [1]),
      false,
      -1,
    ),
  ]);
  // The sender's row 0 matches through the candidate its cleaning split off, and
  // its row 1 on its single value.
  expect(receiverTable).toStrictEqual([
    [0, 1],
    [0, 1],
  ]);
  expect(senderTable).toStrictEqual([
    [0, 1],
    [0, 1],
  ]);
});

test("a reply whose rows do not divide the exchanged count is refused", async () => {
  const settled = await factorRecoveryPair([["A", "B", "C"]], [["A", "B"]], 7);
  expectRecoveryRefusal(
    settled,
    /declares 3 sender record\(s\) against the 7 the sender exchanged/,
  );
});

test("a reply implying a factor above one declared step's is refused", async () => {
  const settled = await factorRecoveryPair(
    [["A"]],
    [["A", "B"]],
    FAN_OUT_CANDIDATES_PER_ELEMENT + 1,
  );
  expectRecoveryRefusal(
    settled,
    /not a fan-out factor a declared step can produce/,
  );
});

test("a reply implying a factor between the two an honest sender produces is refused", async () => {
  // A local fan-out declares one whole step's factor or none at all, so a
  // quotient inside that range is a shape no honest sender emits.
  const settled = await factorRecoveryPair([["A"]], [["A", "B"]], 2);
  expectRecoveryRefusal(
    settled,
    /declares 1 sender record\(s\) against the 2 the sender exchanged/,
  );
});

test("a reply declaring no rows against a positive exchanged count is refused", async () => {
  // No factor multiplies zero rows into records, so the pair is a partner fault
  // rather than a sender that legitimately holds nothing.
  const settled = await factorRecoveryPair([[]], [["A", "B"]], 5);
  expectRecoveryRefusal(
    settled,
    /declares 0 sender record\(s\) against the 5 the sender exchanged/,
  );
});

test("a sender that holds no rows at all is the one legitimate zero", async () => {
  // Zero rows against zero exchanged records is what an empty dataset declares,
  // and it takes the unfanned factor rather than the refusal above.
  const [senderConn, receiverConn] = createMessagePipe();
  const [senderTable, receiverTable] = await Promise.all([
    linkViaSinglePassPSI(
      { cardinality: "one-to-one" },
      new PSIParticipant(
        "server",
        psiLibrary,
        { role: "starter", verbose: -1 },
        UNBOUNDED_PSI_ELEMENTS,
      ),
      senderConn,
      [[]],
      boundsFor(2, [1]),
      false,
      -1,
    ),
    linkViaSinglePassPSI(
      { cardinality: "one-to-one" },
      new PSIParticipant(
        "client",
        psiLibrary,
        { role: "joiner", verbose: -1 },
        UNBOUNDED_PSI_ELEMENTS,
      ),
      receiverConn,
      [["A", "B"]],
      boundsFor(0, [1]),
      false,
      -1,
    ),
  ]);
  expect(receiverTable).toStrictEqual([[], []]);
  expect(senderTable).toStrictEqual([[], []]);
});

// --- the record-level resolution, over a real two-party exchange -------------

function boundsFor(
  partnerRecordCount: number,
  keyWidths: Array<number>,
  localFanOutFactor = 1,
): SinglePassSessionBounds {
  return { partnerRecordCount, keyWidths, localFanOutFactor };
}

type Column = Array<string | Set<string> | undefined>;

/**
 * Run a real single-pass exchange between a PSI sender (starter) and receiver
 * (joiner) over an in-memory pipe, with each party's declared effective key count
 * derived from whether its own fixture fans out. Returns both parties' tables --
 * the sender's is the receiver's, transposed, so asserting on both is what pins
 * that the one resolver's verdict reaches both sides intact.
 */
async function runFanOutExchange(
  senderData: Array<Column>,
  receiverData: Array<Column>,
  withhold = false,
  senderCardinality: LinkageCardinality = "one-to-one",
  declaredKeyWidths?: Array<number>,
): Promise<{ senderTable: AssociationTable; receiverTable: AssociationTable }> {
  const receiverCardinality: LinkageCardinality =
    senderCardinality === "many-to-one"
      ? "one-to-many"
      : senderCardinality === "one-to-many"
        ? "many-to-one"
        : senderCardinality;
  const keyCount = senderData.length;
  // The width rides the AGREED terms, so both parties hold the same vector: a
  // fixture where either side realizes a candidate set is one whose terms declare
  // the fan-out for both.
  const anyFanOut = [...senderData, ...receiverData].some((column) =>
    column.some((cell) => cell instanceof Set),
  );
  const keyWidths =
    declaredKeyWidths ??
    new Array<number>(keyCount).fill(
      anyFanOut ? FAN_OUT_CANDIDATES_PER_ELEMENT : 1,
    );
  const [senderConn, receiverConn] = createMessagePipe();
  const [senderTable, receiverTable] = await Promise.all([
    linkViaSinglePassPSI(
      { cardinality: senderCardinality },
      new PSIParticipant(
        "server",
        psiLibrary,
        { role: "starter", verbose: -1 },
        UNBOUNDED_PSI_ELEMENTS,
      ),
      senderConn,
      senderData,
      boundsFor(receiverData[0].length, keyWidths),
      withhold,
      -1,
    ),
    linkViaSinglePassPSI(
      { cardinality: receiverCardinality },
      new PSIParticipant(
        "client",
        psiLibrary,
        { role: "joiner", verbose: -1 },
        UNBOUNDED_PSI_ELEMENTS,
      ),
      receiverConn,
      receiverData,
      boundsFor(senderData[0].length, keyWidths),
      withhold,
      -1,
    ),
  ]);
  return { senderTable, receiverTable };
}

test("every candidate enters the round on its own, so a fan-out matches where a single value would not", async () => {
  const { senderTable, receiverTable } = await runFanOutExchange(
    [[new Set(["Mary Shaye", "Mary Smith"])]],
    [["Mary Smith"]],
  );
  expect(receiverTable).toStrictEqual([[0], [0]]);
  expect(senderTable).toStrictEqual([[0], [0]]);
});

test("a fanning record that matches two of the partner's takes the lower receiver row and neither matches again", async () => {
  // The spec's own example, lifted to two keys: one fanning sender record is a
  // record-level candidate for two receiver records, the sweep accepts exactly one
  // under a one-to-one cardinality, and the one it discarded leaves candidacy all
  // the same -- so the second key, where a FRESH sender record would have paired
  // with it, cannot rescue it.
  const { receiverTable } = await runFanOutExchange(
    [
      [new Set(["A", "B"]), undefined],
      [undefined, "shared"],
    ],
    [
      ["A", "B"],
      [undefined, "shared"],
    ],
  );
  expect(receiverTable).toStrictEqual([[0], [0]]);
});

test("two of the sender's records matching one fanning receiver record resolve to the lower SENDER row", async () => {
  // The tiebreak is by (sender row, receiver row), not by the order a cell lists
  // its candidates: the receiver's cell lists "A" first, which belongs to sender
  // row 1, yet sender row 0 -- holding "B" -- is what the sweep accepts.
  const { receiverTable } = await runFanOutExchange(
    [["B", "A"]],
    [[new Set(["A", "B"])]],
  );
  expect(receiverTable).toStrictEqual([[0], [0]]);
});

test("a record whose candidates matched but which resolution left unpaired ends unmatched", async () => {
  // Removal is on a POTENTIAL match: sender row 1's only chance was the round it
  // was discarded in, and the later key it would have matched on cannot rescue it.
  const { receiverTable } = await runFanOutExchange(
    [
      ["A", "B"],
      [undefined, "late"],
    ],
    [
      [new Set(["A", "B"]), undefined],
      [undefined, "late"],
    ],
  );
  expect(receiverTable).toStrictEqual([[0], [0]]);
});

test("within-round uniqueness applies per value, not per record", async () => {
  // "P" is held by both sender records, so it is ambiguous and leaves the round --
  // while each record's OTHER candidate stays in it and matches. Under a
  // per-record rule both sender records would have sat the round out entirely.
  const { receiverTable } = await runFanOutExchange(
    [[new Set(["P", "Q"]), new Set(["P", "R"])]],
    [["Q", "R"]],
  );
  expect(receiverTable).toStrictEqual([
    [0, 1],
    [0, 1],
  ]);
});

test("a record with no candidates for a key sits that round out and stays eligible", async () => {
  const { receiverTable } = await runFanOutExchange(
    [
      [undefined, new Set(["A", "B"])],
      ["later", undefined],
    ],
    [
      [new Set(["A", "C"]), undefined],
      [undefined, "later"],
    ],
  );
  // Round 0 pairs sender row 1's "A" with receiver row 0; round 1 pairs the two
  // records that sat it out.
  expect(receiverTable).toStrictEqual([
    [0, 1],
    [1, 0],
  ]);
});

test("terms that declare a fan-out no row realizes produce the fan-out-free table", async () => {
  // The ragged layout carries the same information as the fixed-width one, so the
  // declaration changes the bytes and nothing else.
  const senderData: Array<Column> = [["Alice", "Bob", "Carol"]];
  const receiverData: Array<Column> = [["Carol", "Alice", "Dave"]];
  const fixedWidth = await runFanOutExchange(senderData, receiverData);
  const [senderConn, receiverConn] = createMessagePipe();
  const [, raggedReceiverTable] = await Promise.all([
    linkViaSinglePassPSI(
      { cardinality: "one-to-one" },
      new PSIParticipant(
        "server",
        psiLibrary,
        { role: "starter", verbose: -1 },
        UNBOUNDED_PSI_ELEMENTS,
      ),
      senderConn,
      senderData,
      boundsFor(3, [FAN_OUT_CANDIDATES_PER_ELEMENT]),
      false,
      -1,
    ),
    linkViaSinglePassPSI(
      { cardinality: "one-to-one" },
      new PSIParticipant(
        "client",
        psiLibrary,
        { role: "joiner", verbose: -1 },
        UNBOUNDED_PSI_ELEMENTS,
      ),
      receiverConn,
      receiverData,
      boundsFor(3, [FAN_OUT_CANDIDATES_PER_ELEMENT]),
      false,
      -1,
    ),
  ]);
  expect(raggedReceiverTable).toStrictEqual(fixedWidth.receiverTable);
});

// --- the two axes composed: a fan-out under a deduplicating cardinality -------
// The axes are independent and compose (docs/spec/PROTOCOL.md, Matching
// multiplicity): fan-out gives one record several values for a key, a
// deduplicating cardinality gives one value several records on the many side, and
// the round's attribution rule lifts a value-level match through both incidences
// at once. Nothing new resolves them -- the sweep's own acceptance clause,
// relaxed on the "one" side, is what the composition comes down to -- so these are
// the worked cases for the combination an operator can configure.

test("a fanned-out record on the one side links every group its candidates reach", async () => {
  // The sender fans out and is the "one" side; the receiver deduplicates. Its
  // rows 0 and 1 hold the sender's first candidate and row 2 holds its second, so
  // the one sender record takes all three -- the acceptance clause binding the
  // many side alone, over candidate pairs two different values produced.
  const { senderTable, receiverTable } = await runFanOutExchange(
    [[new Set(["P", "Q"])]],
    [["P", "P", "Q"]],
    false,
    "one-to-many",
  );
  expect(receiverTable).toStrictEqual([
    [0, 1, 2],
    [0, 0, 0],
  ]);
  expect(senderTable).toStrictEqual([
    [0, 0, 0],
    [0, 1, 2],
  ]);
});

test("a fanned-out record on the many side still takes one link, and its group forms around it", async () => {
  // The mirror: the sender deduplicates and fans out. Its rows 0, 1 and 2 all
  // hold "P" and row 2 also holds "Q", so the group forming on "P" is what the
  // receiver's row 0 takes. Row 2's second candidate reaches the receiver's row 1
  // in the same round, and the clause the many side keeps discards that pair --
  // leaving the receiver's row 1 having appeared in a candidate pair, so out of
  // candidacy and unmatched, which is what contradicted evidence costs.
  const { senderTable, receiverTable } = await runFanOutExchange(
    [[new Set(["P"]), new Set(["P"]), new Set(["Q", "P"])]],
    [["P", "Q"]],
    false,
    "many-to-one",
  );
  expect(senderTable).toStrictEqual([
    [0, 1, 2],
    [0, 0, 0],
  ]);
  expect(receiverTable).toStrictEqual([
    [0, 0, 0],
    [0, 1, 2],
  ]);
});

test("a ragged round groups the deduplicating sender's survivors and no others", async () => {
  // The ragged layout carried across two rounds by a sender that both fans out and
  // deduplicates, which is the widest cell shape the replay resolves a sender's
  // side of. Worked through:
  //
  //   round 0: the sender's rows 0 and 1 are one entity on "S1" and both pair with
  //     the receiver's row 0, which leaves all three out of candidacy;
  //   round 1: the receiver's surviving rows hold "N1" (row 1) and "P" (row 2). All
  //     four sender rows hold "N1", so a round reading past candidacy would group
  //     all four onto the receiver's row 1; rows 2 and 3 are the survivors and form
  //     that group alone. Row 3's second candidate "P" reaches the receiver's row 2
  //     in the same round, and the clause the many side keeps discards that pair --
  //     leaving the receiver's row 2 out of candidacy and unmatched.
  const senderData: Array<Column> = [
    [new Set(["S1"]), new Set(["S1"]), undefined, undefined],
    [new Set(["N1"]), new Set(["N1"]), new Set(["N1"]), new Set(["N1", "P"])],
  ];
  const receiverData: Array<Column> = [
    ["S1", "X", "Y"],
    [undefined, "N1", "P"],
  ];
  const { senderTable, receiverTable } = await runFanOutExchange(
    senderData,
    receiverData,
    false,
    "many-to-one",
  );
  expect(receiverTable).toStrictEqual([
    [0, 0, 1, 1],
    [0, 1, 2, 3],
  ]);
  expect(senderTable).toStrictEqual([
    [0, 1, 2, 3],
    [0, 0, 1, 1],
  ]);

  // The multiplicity is what decides this table: matched one-to-one, both groups
  // are within-dataset duplicates that leave their round, and only row 3's
  // unshared "P" survives to match.
  const oneToOne = await runFanOutExchange(senderData, receiverData);
  expect(oneToOne.receiverTable).toStrictEqual([[2], [3]]);
});

// --- withholding is unaffected by fan-out ------------------------------------

test("a blind helper sending a fan-out table still receives no message 3", async () => {
  // Withholding is decided by the sender's output entitlement and payload intent
  // alone; the layout of the frame it sent has no bearing on it. The sender ends
  // with the empty table it is supposed to, and the receiver's own result is the
  // one the fan-out produced.
  const { senderTable, receiverTable } = await runFanOutExchange(
    [[new Set(["Mary Shaye", "Mary Smith"])]],
    [["Mary Smith"]],
    true,
  );
  expect(senderTable).toStrictEqual([[], []]);
  expect(receiverTable).toStrictEqual([[0], [0]]);
});

// --- the derived caps account for the fan-out width --------------------------

test("the receiver's read gate carries the ragged table's count-prefix term", async () => {
  const setCalls: Array<number | undefined> = [];
  let resolveReceive: ((v: unknown) => void) | undefined;
  const effectiveKeyCount = FAN_OUT_CANDIDATES_PER_ELEMENT;
  const run = linkViaSinglePassPSI(
    { cardinality: "one-to-one" },
    new PSIParticipant(
      "client",
      psiLibrary,
      { role: "joiner", verbose: -1 },
      UNBOUNDED_PSI_ELEMENTS,
    ),
    {
      send: async () => {},
      receive: () =>
        new Promise((resolve) => {
          resolveReceive = resolve;
        }),
      close: async () => {},
      setInboundFrameCap: (maxBytes) => setCalls.push(maxBytes),
    },
    [["a", "b", "c"]],
    boundsFor(2, [effectiveKeyCount]),
    false,
    -1,
  );
  await new Promise((r) => setTimeout(r, 0));
  expect(setCalls[0]).toBe(
    singlePassReplyByteCap(
      1,
      { effectiveKeyCount, recordCount: 2 },
      { effectiveKeyCount, recordCount: 3 },
    ),
  );
  resolveReceive?.(new Uint8Array(4));
  await expect(run).rejects.toThrow();
});

test("an over-ceiling fan-out exchange aborts on both sides before any frame moves", async () => {
  // The fan-out is the whole reason this exchange is over the budget: the same row
  // count against the plain key count is comfortably inside it. Both parties reach
  // the verdict from the advertisements alone, so neither sends and neither waits.
  const rowsWithinPlainBudget = MAX_SINGLE_PASS_CELLS;
  const overWithFanOut = Math.floor(MAX_SINGLE_PASS_CELLS / 20) + 1;
  const [conn, peer] = createMessagePipe();
  const roles = ["starter", "joiner"] as const;
  for (const role of roles) {
    const run = linkViaSinglePassPSI(
      { cardinality: "one-to-one" },
      new PSIParticipant(
        role === "starter" ? "server" : "client",
        psiLibrary,
        { role, verbose: -1 },
        UNBOUNDED_PSI_ELEMENTS,
      ),
      conn,
      [["a", "b"]],
      boundsFor(overWithFanOut, [FAN_OUT_CANDIDATES_PER_ELEMENT]),
      false,
      -1,
    );
    await expect(run).rejects.toThrow(UsageError);
    await expect(run).rejects.toThrow(/single-pass cannot carry this exchange/);
    // The fan-out that overflows the budget is the PARTNER's declaration in this
    // fixture, so both the cause and the fan-out remedy are attributed there, and
    // the value slot product the gate weighed is the one stated.
    await expect(run).rejects.toThrow(
      new RegExp(
        `the partner declared ${FAN_OUT_CANDIDATES_PER_ELEMENT} effective ` +
          `linkage key\\(s\\) across ${overWithFanOut} record\\(s\\), which is ` +
          `${FAN_OUT_CANDIDATES_PER_ELEMENT * overWithFanOut} value slot\\(s\\)`,
      ),
    );
    await expect(run).rejects.toThrow(
      /counts its whole declared width toward that ceiling, so removing the partner's fan-out/,
    );
    await expect(run).rejects.not.toThrow(/cascade/);
  }
  expect(overWithFanOut).toBeLessThan(rowsWithinPlainBudget);
  // Neither role put anything on the wire before aborting: the peer end of the
  // pipe has no frame waiting. A parked receive() cannot show that on its own (an
  // in-memory pipe carries no inactivity deadline, so it would never settle), so
  // race it against a macrotask -- the pipe delivers through queueMicrotask, and
  // both runs above are already settled, so a frame either role sent has landed by
  // the time the timer fires.
  const nothingDelivered = Symbol("nothing delivered");
  await expect(
    Promise.race([
      peer.receive(),
      new Promise((resolve) => setTimeout(() => resolve(nothingDelivered), 0)),
    ]),
  ).resolves.toBe(nothingDelivered);
});

test("a party over the ceiling on its own cleaning alone is offered the fan-out remedy", async () => {
  // The agreed terms declare no width at all, so the layout discriminant every
  // other guidance decision reads sees no fan-out here: what put this party over
  // the budget is the factor its OWN cleaning multiplies its record count by,
  // which the partner cannot see and the agreed width cannot show.
  const keyCount = MAX_LINKAGE_ENTRIES;
  const rows =
    Math.floor(
      MAX_SINGLE_PASS_CELLS / (keyCount * FAN_OUT_CANDIDATES_PER_ELEMENT),
    ) + 1;
  // The same rows without the cleaning fan-out are comfortably inside the
  // budget, so the fan-out is the whole reason this breaches.
  expect(keyCount * rows).toBeLessThan(MAX_SINGLE_PASS_CELLS);
  const column: Column = Array.from({ length: rows }, (_u, i) => `V${i}`);
  const [conn] = createMessagePipe();
  const run = linkViaSinglePassPSI(
    { cardinality: "one-to-one" },
    new PSIParticipant(
      "server",
      psiLibrary,
      { role: "starter", verbose: -1 },
      UNBOUNDED_PSI_ELEMENTS,
    ),
    conn,
    new Array<Column>(keyCount).fill(column),
    boundsFor(
      2,
      new Array<number>(keyCount).fill(1),
      FAN_OUT_CANDIDATES_PER_ELEMENT,
    ),
    false,
    -1,
  );
  await expect(run).rejects.toThrow(UsageError);
  await expect(run).rejects.toThrow(
    /cleaning that fans out declares the records it stands for, so removing a fan-out/,
  );
  // The breach is this party's alone, so the partner is offered nothing.
  await expect(run).rejects.not.toThrow(/the partner's fan-out/);
});

test("a row realizing more candidates than the party declared is refused, not shipped", async () => {
  // The advertisement is what the partner's element bounds, read gate, and decode
  // are all derived from, so a candidate producer the declared factors do not
  // account for must land here rather than on the wire. One key declared
  // fan-out-free, one row carrying a set.
  const [conn] = createMessagePipe();
  const run = linkViaSinglePassPSI(
    { cardinality: "one-to-one" },
    new PSIParticipant(
      "server",
      psiLibrary,
      { role: "starter", verbose: -1 },
      UNBOUNDED_PSI_ELEMENTS,
    ),
    conn,
    [[new Set(["A", "B"])]],
    boundsFor(1, [1]),
    false,
    -1,
  );
  await expect(run).rejects.toThrow(/fan-out/);
  // The class is the contract, not only the wording: this fault is the operator's
  // to fix, and the exit code it earns follows from the class alone (the mapping
  // itself is pinned in apps/cli's cli.test.ts).
  await expect(run).rejects.toThrow(UsageError);
});

test("a cell wider than the normative width bound is refused as the table is built", async () => {
  // Realization drops an over-width row for the DECLARED fan-out producers alone
  // and refuses a fuzzy-widened one outright, so what lands here is an expansion
  // neither rule binds -- an unlisted function, or a caller that assembled one
  // anyway -- and it is what keeps the sender from building a frame its own
  // decoder would reject.
  const tooWide = new Set(
    Array.from(
      { length: FAN_OUT_CANDIDATES_PER_ELEMENT + 1 },
      (_u, i) => `V${i}`,
    ),
  );
  const [conn] = createMessagePipe();
  const run = linkViaSinglePassPSI(
    { cardinality: "one-to-one" },
    new PSIParticipant(
      "server",
      psiLibrary,
      { role: "starter", verbose: -1 },
      UNBOUNDED_PSI_ELEMENTS,
    ),
    conn,
    [[tooWide]],
    boundsFor(1, [FAN_OUT_CANDIDATES_PER_ELEMENT]),
    false,
    -1,
  );
  await expect(run).rejects.toThrow(
    /contributes 21 candidate value\(s\) to linkage key 0/,
  );
  await expect(run).rejects.toThrow(UsageError);
});

test("a cell the key beside it would refuse is admitted at its own key's width", async () => {
  // The mirror of the refusal below, and the direction a uniform vector cannot
  // show: the NARROW key is the first one, so a build reading `cellWidths[0]` for
  // every cell would refuse this honest row rather than let it match. Key 0
  // carries one value per record and matches nothing; the pair meets on key 1,
  // whose own width admits the wide cell.
  const wide = new Set(
    Array.from({ length: FAN_OUT_CANDIDATES_PER_ELEMENT }, (_u, i) => `V${i}`),
  );
  const { senderTable, receiverTable } = await runFanOutExchange(
    [["A"], [wide]],
    [["B"], ["V7"]],
    false,
    "one-to-one",
    [1, FAN_OUT_CANDIDATES_PER_ELEMENT],
  );
  expect(receiverTable).toStrictEqual([[0], [0]]);
  expect(senderTable).toStrictEqual([[0], [0]]);
});

test("a row over the width its own key declares is refused, not the key beside it", async () => {
  // The per-cell bound is per KEY, not one number across the table: this row is
  // inside the width the first key declares and outside the width the second
  // does, and it is the second the refusal names.
  const insideBound = new Set(
    Array.from({ length: FAN_OUT_CANDIDATES_PER_ELEMENT }, (_u, i) => `V${i}`),
  );
  const [conn] = createMessagePipe();
  const run = linkViaSinglePassPSI(
    { cardinality: "one-to-one" },
    new PSIParticipant(
      "server",
      psiLibrary,
      { role: "starter", verbose: -1 },
      UNBOUNDED_PSI_ELEMENTS,
    ),
    conn,
    [[insideBound], [insideBound]],
    boundsFor(1, [FAN_OUT_CANDIDATES_PER_ELEMENT, 1]),
    false,
    -1,
  );
  await expect(run).rejects.toThrow(
    /contributes 20 candidate value\(s\) to linkage key 1, more than the 1/,
  );
  await expect(run).rejects.toThrow(UsageError);
});

// --- end to end: authored terms through to the association table -------------
// The rules above are exercised on candidate sets handed straight to the
// strategy. These run the same rules from the other end: linkage terms declaring
// a `split_on` element transform, prepared over raw rows by prepareForExchange,
// exchanged by runExchange over a message pipe, and resolved into the table each
// party is handed. Single-pass only -- every other strategy refuses a declared
// fan-out at terms validation (assertFanOutImplemented).

// Two keys, most precise first. The last-name element splits on the space the
// default name pipeline leaves where a hyphen was ("Smith-Jones" standardizes to
// "SMITH JONES"), so a hyphenated surname enters its round as both parts; the
// first-name key is the less precise round the removal rule protects.
const fanOutExchangeTerms: LinkageTerms = {
  version: "1.0.0",
  identity: "Fan-out Test",
  date: "2026-01-01",
  algorithm: "psi",
  linkageStrategy: "single-pass",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [
    { name: "last_name", type: "last_name" },
    { name: "first_name", type: "first_name" },
  ],
  linkageKeys: [
    {
      name: "last name",
      elements: [
        {
          field: "last_name",
          transform: [{ function: "split_on", params: { delimiter: " " } }],
        },
      ],
    },
    { name: "first name", elements: [{ field: "first_name" }] },
  ],
};

const initiatorRows = [
  // Matches through one of its two candidates: no partner record holds the whole
  // "SMITH JONES". Its first name matches a DIFFERENT partner record in the
  // later round, which is the removal rule's fixture.
  { last_name: "Smith-Jones", first_name: "Alice" },
  { last_name: "Brown", first_name: "Carol" },
  // Reaches the second round with its candidacy intact, so the round the
  // removal keeps the first record out of is one that demonstrably runs.
  { last_name: "Taylor", first_name: "Frank" },
];

const responderRows = [
  { last_name: "Jones", first_name: "Zoe" },
  // The record the first initiator row would meet on first name, had matching
  // on a last-name candidate not taken it out of that round.
  { last_name: "Green", first_name: "Alice" },
  { last_name: "Brown", first_name: "Dan" },
  { last_name: "Wilson", first_name: "Frank" },
];

async function runFanOutExchangeEndToEnd(): Promise<
  [ExchangeResult, ExchangeResult]
> {
  const [initiatorConn, responderConn] = createMessagePipe();
  const prepare = (identity: string, rows: Array<Record<string, string>>) =>
    prepareForExchange(
      { linkageTerms: { ...fanOutExchangeTerms, identity } },
      identity,
      rows,
      ["last_name", "first_name"],
    );
  return Promise.all([
    runExchange(
      initiatorConn,
      "initiator",
      prepare("Initiator Co", initiatorRows),
      { psiLibrary },
    ),
    runExchange(
      responderConn,
      "responder",
      prepare("Responder Co", responderRows),
      { psiLibrary },
    ),
  ]);
}

test("a split_on configuration matches on each candidate, from authored terms to the table", async () => {
  const [initiator, responder] = await runFanOutExchangeEndToEnd();

  // Initiator row 0 matches responder row 0 on the "JONES" candidate its surname
  // split off -- a pairing no single-valued realization of that surname
  // produces. Rows 1 and 2 are the ordinary single-valued matches beside it, one
  // per key round.
  expect(initiator.associationTable).toEqual([
    [0, 1, 2],
    [0, 2, 3],
  ]);
  // The same three pairs from the other side, each party naming its own rows
  // first.
  expect(responder.associationTable).toEqual([
    [0, 2, 3],
    [0, 1, 2],
  ]);
});

test("a record that matched on a candidate leaves candidacy for the later key", async () => {
  const [initiator] = await runFanOutExchangeEndToEnd();

  // Initiator row 0 and responder row 1 share a first name, which is the second
  // key's whole content, so the only thing keeping them apart is the removal
  // rule: row 0 appeared in the first round's candidate pairs and left candidacy
  // for every round after it.
  const table = initiator.associationTable;
  expect(table).toBeDefined();
  const [localRows, partnerRows] = table!;
  expect(partnerRows[localRows.indexOf(0)]).toBe(0);
  expect(partnerRows).not.toContain(1);
  // The removed record's first-name value really is the one the other party
  // holds, so this is the rule biting rather than a fixture that never met.
  expect(initiatorRows[0].first_name).toBe(responderRows[1].first_name);
  // And the later round did run: row 2 is matched there, on first name alone.
  expect(localRows).toContain(2);
});

// --- a fan-out the agreed terms do not show ---------------------------------
// The fan-out above rides the AGREED terms, so both parties saw it before either
// ran. A fan-out authored in a party's own standardization rides nothing the
// partner can see, and no width is declared for it: the party declares the
// RECORDS its cleaning stands for instead, which is what its ragged table and
// every bound derived for it are sized from.

// The same two keys with no transform of their own: the width these declare is 1
// per key, whichever party's standardization fans out.
const plainExchangeTerms: LinkageTerms = {
  ...fanOutExchangeTerms,
  linkageKeys: [
    { name: "last name", elements: [{ field: "last_name" }] },
    { name: "first name", elements: [{ field: "first_name" }] },
  ],
};

test("a standardization fan-out matches on each candidate against a plain partner", async () => {
  // The splitting party declares its rows times the fan-out factor and ships the
  // ragged layout; the partner derives both from the record count it was handed
  // and the widths the agreed terms declare, with nothing about the fan-out on
  // the wire. Initiator row 0's surname splits into SMITH and JONES, and JONES is
  // what responder row 0 holds.
  const [initiatorConn, responderConn] = createMessagePipe();
  const [initiator, responder] = await Promise.all([
    runExchange(
      initiatorConn,
      "initiator",
      prepareForExchange(
        {
          linkageTerms: { ...plainExchangeTerms, identity: "Splitting Co" },
          // An explicit transformation replaces the default pipeline for the
          // field it names, so each one restates the upper-casing both sides
          // must agree on; only the surname's carries the fan-out step.
          standardization: [
            {
              output: "last_name",
              input: "last_name",
              steps: [
                { function: "to_upper_case" },
                { function: "replace_separators_with_spaces" },
                { function: "split_on", params: { delimiter: " " } },
              ],
            },
            {
              output: "first_name",
              input: "first_name",
              steps: [{ function: "to_upper_case" }],
            },
          ],
        },
        "Splitting Co",
        initiatorRows,
        ["last_name", "first_name"],
      ),
      { psiLibrary },
    ),
    runExchange(
      responderConn,
      "responder",
      prepareForExchange(
        { linkageTerms: { ...plainExchangeTerms, identity: "Plain Co" } },
        "Plain Co",
        responderRows,
        ["last_name", "first_name"],
      ),
      { psiLibrary },
    ),
  ]);

  expect(initiator.associationTable).toEqual([
    [0, 1, 2],
    [0, 2, 3],
  ]);
  expect(responder.associationTable).toEqual([
    [0, 2, 3],
    [0, 1, 2],
  ]);
});
