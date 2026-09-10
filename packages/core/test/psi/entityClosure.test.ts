import { describe, expect, test } from "vitest";

import {
  assertRoundDiagonalClosure,
  entityClusters,
} from "../../src/psi/entityClosure";
import type { ClosureBlock } from "../../src/psi/entityClosure";
import { InternalConsistencyError } from "../../src/errors";
import type { AssociationTable } from "../../src/types";

// The closure step a party runs locally over the table the cascade left
// it, and the check that holds its result to the round-diagonal shape the
// both-sided cardinality actually produces (docs/spec/PROTOCOL.md, The
// many-to-many entity closure). The runs that drive it through linkViaPSI are
// in psiLinkManyToMany.test.ts; here the tables are hand-built so the check
// can be shown to REFUSE shapes no real run produces.

describe("entityClusters", () => {
  test("a table with no pairs has no clusters", () => {
    expect(entityClusters([[], []])).toStrictEqual([]);
  });

  test("a complete block is one cluster and two blocks stay apart", () => {
    // Rows 0 and 1 against partner rows 0 and 1 on one value; row 2 against
    // partner row 2 on another.
    const table: AssociationTable = [
      [0, 0, 1, 1, 2],
      [0, 1, 0, 1, 2],
    ];
    expect(entityClusters(table)).toStrictEqual([
      { localRows: [0, 1], partnerRows: [0, 1] },
      { localRows: [2], partnerRows: [2] },
    ]);
  });

  test("the two parties' row spaces are separate vertices", () => {
    // Our row 0 pairs with the partner's row 1 and our row 1 with its row 0. The
    // two clusters share no record; reading one row index across both spaces
    // would join them into one.
    expect(
      entityClusters([
        [0, 1],
        [1, 0],
      ]),
    ).toStrictEqual([
      { localRows: [0], partnerRows: [1] },
      { localRows: [1], partnerRows: [0] },
    ]);
  });

  test("a chain through a shared record is one cluster", () => {
    // A chain: our rows 0 and 1 reach each other through the partner's row 0.
    // entityClusters computes the closure of whatever table it is given, so it
    // groups them whether one record's candidate set chained the two blocks or
    // nothing did; the check below is what tells those apart.
    expect(
      entityClusters([
        [0, 1],
        [0, 0],
      ]),
    ).toStrictEqual([{ localRows: [0, 1], partnerRows: [0] }]);
  });

  test("clusters are ordered by their lowest local row, each half ascending", () => {
    const table: AssociationTable = [
      [0, 2, 2, 3],
      [5, 1, 4, 1],
    ];
    expect(entityClusters(table)).toStrictEqual([
      { localRows: [0], partnerRows: [5] },
      { localRows: [2, 3], partnerRows: [1, 4] },
    ]);
  });

  test("the ordering holds over a table whose local half does not ascend", () => {
    // The same pairs as the case above, shuffled: the cascade hands over an
    // ascending local half, but a reader recomputing clusters from a stored result
    // file supplies whatever order it finds there, and gets the one arrangement.
    const table: AssociationTable = [
      [3, 0, 2, 2],
      [1, 5, 1, 4],
    ];
    expect(entityClusters(table)).toStrictEqual([
      { localRows: [0], partnerRows: [5] },
      { localRows: [2, 3], partnerRows: [1, 4] },
    ]);
  });

  test("halves of different lengths are refused", () => {
    expect(() => entityClusters([[0, 1], [0]])).toThrow(
      /halves have different lengths/,
    );
  });
});

describe("assertRoundDiagonalClosure", () => {
  // Two blocks of one round: a 2x2 on one matched value and a 1x1 on another.
  const blockTable: AssociationTable = [
    [0, 0, 1, 1, 2],
    [0, 1, 0, 1, 2],
  ];
  const oneRound = [0, 0, 0, 0, 0];
  const blocks: Array<ClosureBlock> = [
    { localRows: [0, 1], partnerRows: [0, 1] },
    { localRows: [2], partnerRows: [2] },
  ];

  const refusal = (
    table: AssociationTable,
    roundOfPair: Array<number>,
    given: Array<ClosureBlock>,
  ): InternalConsistencyError => {
    let thrown: unknown;
    try {
      assertRoundDiagonalClosure("client", table, roundOfPair, given);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(InternalConsistencyError);
    // Every internal fault states its own next step; the class's hint tag
    // suppresses the front end's generic retry advisory beneath it.
    expect((thrown as Error).message).toMatch(/report it with this message/);
    return thrown as InternalConsistencyError;
  };

  test("a table of complete blocks passes", () => {
    expect(() =>
      assertRoundDiagonalClosure("client", blockTable, oneRound, blocks),
    ).not.toThrow();
  });

  test("a cluster chaining two blocks of one round passes", () => {
    // The smallest chained cluster (docs/spec/PROTOCOL.md, The smallest chained
    // cluster): our row 0 contributed both matched values, so the blocks {0,1}
    // x {0} and {0} x {1} join into one cluster of three pairs where the 2x2
    // product would hold four. Block-diagonal excluded it; round-diagonal
    // admits it.
    expect(() =>
      assertRoundDiagonalClosure(
        "client",
        [
          [0, 0, 1],
          [0, 1, 0],
        ],
        [0, 0, 0],
        [
          { localRows: [0, 1], partnerRows: [0] },
          { localRows: [0], partnerRows: [1] },
        ],
      ),
    ).not.toThrow();
  });

  test("a cluster spanning two rounds is refused", () => {
    // The same three pairs, with the chaining pair matched on a later key: a
    // record standing in any of a key's candidate pairs leaves candidacy for
    // every later key, so no cluster can reach a second round.
    const thrown = refusal(
      [
        [0, 0, 1],
        [0, 1, 0],
      ],
      [0, 1, 0],
      [
        { localRows: [0, 1], partnerRows: [0] },
        { localRows: [0], partnerRows: [1] },
      ],
    );
    expect(thrown.message).toMatch(
      /joins pairs matched on two different linkage keys/,
    );
  });

  test("a block the table holds only part of is refused", () => {
    // One block of two records a side, so the value's pairs are the whole 2x2
    // product, and the table is missing (1, 1).
    const thrown = refusal(
      [
        [0, 0, 1],
        [0, 1, 0],
      ],
      [0, 0, 0],
      [{ localRows: [0, 1], partnerRows: [0, 1] }],
    );
    expect(thrown.message).toMatch(
      /the table holds no pair between this party's record 1 and the partner's 1/,
    );
  });

  test("one block split across two clusters is refused", () => {
    // Both pairs claim one matched value, yet they share no record -- the
    // value's block would have to hold every pair between the two sides.
    const thrown = refusal(
      [
        [0, 1],
        [0, 1],
      ],
      [0, 0],
      [{ localRows: [0, 1], partnerRows: [0, 1] }],
    );
    expect(thrown.message).toMatch(
      /split across the clusters holding this party's records 0 and 1/,
    );
  });

  test("a block whose partner half falls in another cluster is refused", () => {
    const thrown = refusal(
      [
        [0, 1],
        [0, 1],
      ],
      [0, 0],
      [{ localRows: [0], partnerRows: [0, 1] }],
    );
    expect(thrown.message).toMatch(
      /the cluster holding this party's record 0 and the one holding the partner's record 1/,
    );
  });

  test("a round label per record rather than per pair is refused as a miscount", () => {
    expect(() =>
      assertRoundDiagonalClosure("client", blockTable, [0, 0, 0], blocks),
    ).toThrow(/3 round label\(s\) for 5 matched pair\(s\)/);
  });

  test("a block with no record on one side is refused as a caller fault", () => {
    expect(() =>
      assertRoundDiagonalClosure("client", blockTable, oneRound, [
        { localRows: [], partnerRows: [0] },
      ]),
    ).toThrow(/a block with no record on one side/);
  });
});
