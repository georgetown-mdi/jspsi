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
  MAX_KEY_CANDIDATES_PER_ROW,
} from "../src/fanOutFunctions";
import {
  MAX_SINGLE_PASS_CELLS,
  singlePassReplyByteCap,
} from "../src/connection/frameSize";
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
// A party's per-key candidate factors, summed: the authenticated number the slot
// arithmetic, the message-2 layout, and the derived caps all read.

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
  expect(declaredEffectiveKeyCount(terms)).toBe(MAX_KEY_CANDIDATES_PER_ROW + 1);
});

test("a fan-out anywhere in a key counts that key once, however many elements declare one", () => {
  const terms = termsWith([
    {
      name: "one",
      elements: [
        { field: "ssn", transform: [fanOutStep] },
        { field: "lastName", transform: [fanOutStep] },
      ],
    },
  ]) as LinkageTerms;
  expect(declaredEffectiveKeyCount(terms)).toBe(MAX_KEY_CANDIDATES_PER_ROW);
});

test("a standardization fan-out raises the factor of every key reading that field", () => {
  // The partner cannot see this surface -- a standardization is per-party and
  // local -- which is why the agreed terms fix a floor rather than the value.
  const terms = termsWith([
    { name: "one", elements: [{ field: "lastName" }] },
    { name: "two", elements: [{ field: "ssn" }] },
  ]) as LinkageTerms;
  const standardization = [
    { output: "lastName", input: "last_name", steps: [fanOutStep] },
  ];
  expect(declaredEffectiveKeyCount(terms)).toBe(2);
  expect(declaredEffectiveKeyCount(terms, standardization)).toBe(
    MAX_KEY_CANDIDATES_PER_ROW + 1,
  );
});

test("a standardization fan-out on a field no key reads changes nothing", () => {
  const terms = termsWith([
    { name: "one", elements: [{ field: "ssn" }] },
  ]) as LinkageTerms;
  const standardization = [
    { output: "lastName", input: "last_name", steps: [fanOutStep] },
  ];
  expect(declaredEffectiveKeyCount(terms, standardization)).toBe(1);
});

// --- message 2 part (d): the ragged layout's decode guards --------------------
// Every bound comes from authenticated session state -- the agreed key count, the
// record count the sender carried on the terms exchange, the normative width
// bound, and the sender's declared slot bound -- never from the frame itself. A
// frame failing any of them is a clean protocol error, not a wrong
// reconstruction.

// Two keys over two records, the sender declaring a fan-out (slot bound 2 * 20).
const RAGGED_KEYS = 2;
const RAGGED_ROWS = 2;
const RAGGED_SLOT_BOUND = MAX_KEY_CANDIDATES_PER_ROW * RAGGED_ROWS;

function decodeRagged(words: Array<number>) {
  return decodeRaggedIndexTable(
    "client",
    Int32Array.from(words),
    RAGGED_KEYS,
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
  expect(cells).toHaveLength(RAGGED_KEYS);
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
    "declaring a cell wider than the normative width bound",
    [MAX_KEY_CANDIDATES_PER_ROW + 1, 0, 0, 0, 0],
    /wider than one record may contribute/,
  ],
  [
    "declaring a negative candidate count",
    [-1, 0, 0, 0],
    /wider than one record may contribute/,
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

test("the ragged table is refused for carrying more candidates than the declared width admits", () => {
  // The running total is bounded by the sender's OWN advertised slot count, so a
  // frame within the width bound cell by cell is still refused when its cells sum
  // past what the sender said it would ship. It is the guard bounding the one
  // allocation the frame's own word count sizes, so its class carries as much as
  // its wording: a caller reads a partner fault off the class.
  const words = [2, 0, 1, 2, 2, 3, 2, 4, 5, 2, 6, 7];
  expectProtocolRefusal(
    () => decodeRaggedIndexTable("client", Int32Array.from(words), 2, 2, 7),
    /more candidate values than the sender's declared width/,
  );
});

// --- the record-level resolution, over a real two-party exchange -------------

function boundsFor(
  partnerRecordCount: number,
  localEffectiveKeyCount: number,
  partnerEffectiveKeyCount: number,
): SinglePassSessionBounds {
  return {
    partnerRecordCount,
    localEffectiveKeyCount,
    partnerEffectiveKeyCount,
  };
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
): Promise<{ senderTable: AssociationTable; receiverTable: AssociationTable }> {
  const receiverCardinality: LinkageCardinality =
    senderCardinality === "many-to-one"
      ? "one-to-many"
      : senderCardinality === "one-to-many"
        ? "many-to-one"
        : senderCardinality;
  const keyCount = senderData.length;
  const declaredFor = (data: Array<Column>): number =>
    data.some((column) => column.some((cell) => cell instanceof Set))
      ? keyCount * MAX_KEY_CANDIDATES_PER_ROW
      : keyCount;
  const senderEffectiveKeyCount = declaredFor(senderData);
  const receiverEffectiveKeyCount = declaredFor(receiverData);
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
      boundsFor(
        receiverData[0].length,
        senderEffectiveKeyCount,
        receiverEffectiveKeyCount,
      ),
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
      boundsFor(
        senderData[0].length,
        receiverEffectiveKeyCount,
        senderEffectiveKeyCount,
      ),
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

test("a party that declares a fan-out but never splits a row produces the fan-out-free table", async () => {
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
      boundsFor(3, MAX_KEY_CANDIDATES_PER_ROW, 1),
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
      boundsFor(3, 1, MAX_KEY_CANDIDATES_PER_ROW),
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
  const senderEffectiveKeyCount = MAX_KEY_CANDIDATES_PER_ROW;
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
    boundsFor(2, 1, senderEffectiveKeyCount),
    false,
    -1,
  );
  await new Promise((r) => setTimeout(r, 0));
  expect(setCalls[0]).toBe(
    singlePassReplyByteCap(
      1,
      { effectiveKeyCount: senderEffectiveKeyCount, recordCount: 2 },
      { effectiveKeyCount: 1, recordCount: 3 },
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
      boundsFor(overWithFanOut, 1, MAX_KEY_CANDIDATES_PER_ROW),
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
        `the partner declared ${MAX_KEY_CANDIDATES_PER_ROW} effective linkage ` +
          `key\\(s\\) across ${overWithFanOut} record\\(s\\), which is ` +
          `${MAX_KEY_CANDIDATES_PER_ROW * overWithFanOut} value slot\\(s\\)`,
      ),
    );
    await expect(run).rejects.toThrow(
      /fans out counts as 20 toward that ceiling, so removing the partner's fan-out/,
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
    boundsFor(1, 1, 1),
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
  // Realization drops an over-width row for the DECLARED fan-out producers alone,
  // so what lands here is an expansion that rule does not bind -- a fuzzy
  // comparison, an unlisted function, or a caller that assembled one anyway -- and
  // it is what keeps the sender from building a frame its own decoder would reject.
  const tooWide = new Set(
    Array.from({ length: MAX_KEY_CANDIDATES_PER_ROW + 1 }, (_u, i) => `V${i}`),
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
    boundsFor(1, MAX_KEY_CANDIDATES_PER_ROW, 1),
    false,
    -1,
  );
  await expect(run).rejects.toThrow(
    /contributes 21 candidate value\(s\) to linkage key 0/,
  );
  await expect(run).rejects.toThrow(UsageError);
});

test("rows inside the per-record bound that overrun the declared slots are refused", async () => {
  // Where the two width checks differ: every row here is inside the per-record
  // cap, and it is their sum across the keys that exceeds what this party
  // advertised -- one key declared a fan-out, the other is one the declared
  // factors count as single-valued while its rows realize a full-width set.
  const insideBound = new Set(
    Array.from({ length: MAX_KEY_CANDIDATES_PER_ROW }, (_u, i) => `V${i}`),
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
    boundsFor(1, MAX_KEY_CANDIDATES_PER_ROW + 1, 2),
    false,
    -1,
  );
  await expect(run).rejects.toThrow(
    /built 40 candidate value slot\(s\) across 2 linkage key\(s\) and 1 record\(s\), more than the 21/,
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

// --- a width the agreed terms do not show reaches the run boundary -----------
// The fan-out above rides the AGREED terms, so both parties saw it before either
// ran. A fan-out authored in a party's own standardization rides nothing the
// partner can see: the terms a consent surface displayed imply one width, and the
// partner may legitimately run at up to MAX_KEY_CANDIDATES_PER_ROW times it. That
// advertisement is admissible, so the run proceeds -- what must not happen is it
// proceeding silently.

// The same two keys with no transform of their own: the width these imply is 2,
// and any advertisement above it comes from a standardization the partner holds.
const plainExchangeTerms: LinkageTerms = {
  ...fanOutExchangeTerms,
  linkageKeys: [
    { name: "last name", elements: [{ field: "last_name" }] },
    { name: "first name", elements: [{ field: "first_name" }] },
  ],
};

test("a partner running wider than the agreed terms warns the other party's run", async () => {
  // The notice rides runExchange's onWarning -- the slot the CLI puts on stderr
  // AND on the machine-readable warning event (apps/cli/src/protocol.ts), and the
  // web app folds into a run's accumulated warnings -- so an unattended run's
  // supervisor sees it rather than only an interactive terminal.
  const [initiatorConn, responderConn] = createMessagePipe();
  const initiatorWarnings: string[] = [];
  const responderWarnings: string[] = [];
  const isWidthNotice = (warning: string): boolean =>
    warning.includes("effective key count above the agreed terms");

  await Promise.all([
    runExchange(
      initiatorConn,
      "initiator",
      prepareForExchange(
        {
          linkageTerms: { ...plainExchangeTerms, identity: "Splitting Co" },
          // The fan-out the agreed terms do not show: this party's own
          // standardization splits the surname, so it declares 21 where the terms
          // imply 2.
          standardization: [
            {
              output: "last_name",
              input: "last_name",
              steps: [{ function: "split_on", params: { delimiter: " " } }],
            },
          ],
        },
        "Splitting Co",
        initiatorRows,
        ["last_name", "first_name"],
      ),
      { psiLibrary, onWarning: (w) => initiatorWarnings.push(w) },
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
      { psiLibrary, onWarning: (w) => responderWarnings.push(w) },
    ),
  ]);

  const notice = responderWarnings.find(isWidthNotice);
  expect(notice).toBeDefined();
  expect(notice).toContain(
    `partner advertised ${MAX_KEY_CANDIDATES_PER_ROW + 1} value slot(s) per record`,
  );
  expect(notice).toContain("against the 2 the agreed linkage keys imply");
  // The party that fanned out is not warned about its own configuration: it
  // authored the standardization and can see it.
  expect(initiatorWarnings.filter(isWidthNotice)).toEqual([]);
});
