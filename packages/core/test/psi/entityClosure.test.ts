import { describe, expect, test } from "vitest";

import {
  assertRoundDiagonalClosure,
  entityClusters,
} from "../../src/psi/entityClosure";
import type {
  ClosureBlock,
  EntityClusterSummary,
} from "../../src/psi/entityClosure";
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

  test("a pair no block names is refused", () => {
    // Two complete 1x1 blocks, declared apart, plus the pair (0, 1) no matched
    // value produced: it merges them into one three-pair cluster on an edge
    // nothing backs. Each block on its own is whole and lands in one cluster,
    // so only the converse -- that the blocks name every pair the table holds
    // -- catches it.
    const thrown = refusal(
      [
        [0, 0, 1],
        [0, 1, 1],
      ],
      [0, 0, 0],
      [
        { localRows: [0], partnerRows: [0] },
        { localRows: [1], partnerRows: [1] },
      ],
    );
    expect(thrown.message).toMatch(
      /the table pairs this party's record 0 with the partner's 1, and no matched value's block holds that pair/,
    );
  });

  test("a stray pair inside an otherwise valid multi-block cluster is refused", () => {
    // The smallest chained cluster with one pair added: our row 1 and the
    // partner's row 1 are already in the cluster through row 0's two
    // candidates, so the stray pair (1, 1) moves no record between clusters
    // and splits no block. It is a pair the round never matched all the same.
    const thrown = refusal(
      [
        [0, 0, 1, 1],
        [0, 1, 0, 1],
      ],
      [0, 0, 0, 0],
      [
        { localRows: [0, 1], partnerRows: [0] },
        { localRows: [0], partnerRows: [1] },
      ],
    );
    expect(thrown.message).toMatch(
      /the table pairs this party's record 1 with the partner's 1, and no matched value's block holds that pair/,
    );
  });

  test("a pair two overlapping blocks of one round both name passes", () => {
    // Our row 0 and the partner's row 0 contributed both of the round's matched
    // values, so the pair (0, 0) sits in both blocks. The blocks are compared
    // as sets of pairs, not summed counts, so naming it twice is not a
    // shortfall anywhere.
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
          { localRows: [0], partnerRows: [0, 1] },
        ],
      ),
    ).not.toThrow();
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

  test("a block naming a record the table pairs with none is refused", () => {
    const thrown = refusal(blockTable, oneRound, [
      ...blocks,
      { localRows: [9], partnerRows: [2] },
    ]);
    expect(thrown.message).toMatch(
      /names this party's record 9, which the table pairs with none of the partner's/,
    );
  });
});

describe("the entity-cluster summary the closure check returns", () => {
  const summaryOf = (
    table: AssociationTable,
    roundOfPair: Array<number>,
    given: Array<ClosureBlock>,
  ): EntityClusterSummary =>
    assertRoundDiagonalClosure("client", table, roundOfPair, given);

  test("a table with no pairs summarizes to nothing", () => {
    expect(summaryOf([[], []], [], [])).toStrictEqual({
      clusterCount: 0,
      localRows: 0,
      partnerRows: 0,
      shapes: [],
    });
  });

  test("a table of single blocks counts one value per cluster", () => {
    expect(
      summaryOf(
        [
          [0, 0, 1, 1, 2],
          [0, 1, 0, 1, 2],
        ],
        [0, 0, 0, 0, 0],
        [
          { localRows: [0, 1], partnerRows: [0, 1] },
          { localRows: [2], partnerRows: [2] },
        ],
      ),
    ).toStrictEqual({
      clusterCount: 2,
      localRows: 3,
      partnerRows: 3,
      shapes: [
        { localRows: 2, partnerRows: 2, distinctValues: 1, clusters: 1 },
        { localRows: 1, partnerRows: 1, distinctValues: 1, clusters: 1 },
      ],
    });
  });

  test("a chained cluster counts the values its blocks were built from", () => {
    // The smallest chained cluster: three pairs where the 2 x 2 product would
    // hold four, joined by our row 0 contributing both of the round's values.
    // Its size alone would not tell it from a shared value's block; the value
    // count does.
    expect(
      summaryOf(
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
    ).toStrictEqual({
      clusterCount: 1,
      localRows: 2,
      partnerRows: 2,
      shapes: [
        { localRows: 2, partnerRows: 2, distinctValues: 2, clusters: 1 },
      ],
    });
  });

  test("clusters merge into one shape only where all three figures agree", () => {
    // Two 1 x 1 clusters on one value each, and a third of the same size formed
    // on two values -- the pair of blocks {2} x {2} twice over, which is two
    // records each holding both of the round's values. Merging on size alone
    // would report a value count no cluster has.
    const summary = summaryOf(
      [
        [0, 1, 2],
        [0, 1, 2],
      ],
      [0, 0, 0],
      [
        { localRows: [0], partnerRows: [0] },
        { localRows: [1], partnerRows: [1] },
        { localRows: [2], partnerRows: [2] },
        { localRows: [2], partnerRows: [2] },
      ],
    );
    expect(summary.shapes).toStrictEqual([
      { localRows: 1, partnerRows: 1, distinctValues: 2, clusters: 1 },
      { localRows: 1, partnerRows: 1, distinctValues: 1, clusters: 2 },
    ]);
  });

  test("shapes are ordered by the records a cluster holds, largest first", () => {
    const summary = summaryOf(
      [
        [0, 1, 1, 2, 2, 2],
        [0, 1, 2, 3, 4, 5],
      ],
      [0, 0, 0, 0, 0, 0],
      [
        { localRows: [0], partnerRows: [0] },
        { localRows: [1], partnerRows: [1, 2] },
        { localRows: [2], partnerRows: [3, 4, 5] },
      ],
    );
    expect(summary.shapes.map((shape) => shape.partnerRows)).toStrictEqual([
      3, 2, 1,
    ]);
    expect(summary.clusterCount).toBe(3);
    expect(summary.localRows).toBe(3);
    expect(summary.partnerRows).toBe(6);
  });
});
