import { describe, expect, test } from "vitest";

import {
  assertBlockDiagonalClosure,
  entityClusters,
} from "../src/psi/entityClosure";
import { InternalConsistencyError } from "../src/errors";
import type { AssociationTable } from "../src/types";

// The closure step a party runs locally over the table the cascade left
// it, and the check that holds its result to the shape the both-sided
// cardinality actually produces (docs/spec/PROTOCOL.md, The many-to-many
// entity closure). The runs that drive it through linkViaPSI are in
// psiLinkManyToMany.test.ts; here the tables are hand-built so the check
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
    // The shape the block claim says a cascade run cannot produce: our
    // rows 0 and 1 reach each other through the partner's row 0.
    // entityClusters computes the closure of whatever table it is given,
    // so it groups them; assertBlockDiagonalClosure's refusal below is
    // what catches this shape, since the closure will not.
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

describe("assertBlockDiagonalClosure", () => {
  // Two blocks: a 2x2 on one matched value and a 1x1 on another.
  const blockTable: AssociationTable = [
    [0, 0, 1, 1, 2],
    [0, 1, 0, 1, 2],
  ];
  const blockLabels = [0, 0, 0, 0, 1];

  const refusal = (
    table: AssociationTable,
    labels: Array<number>,
  ): InternalConsistencyError => {
    let thrown: unknown;
    try {
      assertBlockDiagonalClosure("client", table, labels);
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
      assertBlockDiagonalClosure("client", blockTable, blockLabels),
    ).not.toThrow();
  });

  test("a cluster spanning two blocks is refused", () => {
    // Our rows 0 and 1 matched different values -- two labels -- and both came
    // back against the partner's row 0, so the closure would group them through a
    // partner record no linkage key links them through. The cluster is a complete
    // 2x1 product, so completeness alone would pass it: the labels are what
    // catches it.
    const thrown = refusal(
      [
        [0, 1],
        [0, 0],
      ],
      [0, 1],
    );
    expect(thrown.message).toMatch(
      /grouped through a partner record no linkage key links them through/,
    );
  });

  test("a cluster that is not the whole product is refused", () => {
    // One label throughout, so the pairs claim one matched value, but the
    // pair (1, 1) the block would hold is missing.
    const thrown = refusal(
      [
        [0, 0, 1],
        [0, 1, 0],
      ],
      [0, 0, 0],
    );
    expect(thrown.message).toMatch(
      /holds 3 pair\(s\) over 2 record\(s\) of this party and 2 of the partner's/,
    );
  });

  test("one block split across two clusters is refused", () => {
    // Both pairs hold one label, so they claim one matched value, yet they
    // share no record -- the value's block would have to hold every pair
    // between the two sides.
    const thrown = refusal(
      [
        [0, 1],
        [0, 1],
      ],
      [0, 0],
    );
    expect(thrown.message).toMatch(
      /split across the clusters holding this party's records 0 and 1/,
    );
  });

  test("a label per record rather than per pair is refused as a miscount", () => {
    // Labels are per PAIR, not per record: a caller passing one per
    // record is stopped rather than read against the wrong pairs.
    expect(() =>
      assertBlockDiagonalClosure("client", blockTable, [0, 0, 1]),
    ).toThrow(/3 block label\(s\) for 5 matched pair\(s\)/);
  });
});
