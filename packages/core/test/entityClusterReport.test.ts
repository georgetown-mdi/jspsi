import { describe, expect, test } from "vitest";

import {
  ENTITY_CLUSTER_SHAPES_NAMED,
  describeEntityClusters,
} from "../src/entityClusterReport";
import type {
  EntityClusterShape,
  EntityClusterSummary,
} from "../src/psi/entityClosure";

// The sentence a party reads off its own many-to-many result (docs/spec/PROTOCOL.md,
// Choosing linkage keys under closure). The figures behind it are computed and
// pinned in psi/entityClosure.test.ts; what is under test here is what the
// operator is told about them.

const shape = (
  localRows: number,
  partnerRows: number,
  distinctValues: number,
  clusters = 1,
): EntityClusterShape => ({
  localRows,
  partnerRows,
  distinctValues,
  clusters,
});

const summaryOf = (
  clusterCount: number,
  localRows: number,
  partnerRows: number,
  shapes: Array<EntityClusterShape>,
): EntityClusterSummary => ({
  clusterCount,
  localRows,
  partnerRows,
  shapes,
});

describe("describeEntityClusters", () => {
  test("a run that matched nothing states that and stops", () => {
    expect(describeEntityClusters(summaryOf(0, 0, 0, []))).toBe(
      "Entity clusters in your result: none, since this run matched no pairs.",
    );
  });

  test("an all-one-to-one result states the totals and no reading guide", () => {
    // The near-one-to-one template the diagnostic exists to distinguish: every
    // cluster is one record against one, so there is nothing to break up and the
    // guide sentence would be advice about a case this run does not have.
    expect(
      describeEntityClusters(
        summaryOf(1204, 1204, 1204, [shape(1, 1, 1, 1204)]),
      ),
    ).toBe(
      "Entity clusters in your result: 1,204 clusters over 1,204 records of " +
        "yours and 1,204 of your partner's. Sizes as yours by your partner's, " +
        "largest first, with the distinct matched values each formed on: 1 x 1 " +
        "on 1 value (1,204 clusters).",
    );
  });

  test("a cluster past one record on a side gets the reading guide", () => {
    expect(
      describeEntityClusters(
        summaryOf(3, 43, 39, [
          shape(40, 37, 5),
          shape(2, 1, 1),
          shape(1, 1, 1),
        ]),
      ),
    ).toBe(
      "Entity clusters in your result: 3 clusters over 43 records of yours " +
        "and 39 of your partner's. Sizes as yours by your partner's, largest " +
        "first, with the distinct matched values each formed on: 40 x 37 on 5 " +
        "values; 2 x 1 on 1 value; 1 x 1 on 1 value. A large cluster formed on " +
        "one value is a linkage key that named a group rather than an " +
        "individual; one formed on several is a chain through a record's " +
        "candidate values. Narrow the key or the candidate values to break it up.",
    );
  });

  test("the shapes past the cap are reported as a count of the small end", () => {
    const shapes = Array.from(
      { length: ENTITY_CLUSTER_SHAPES_NAMED + 2 },
      (_, i) => shape(ENTITY_CLUSTER_SHAPES_NAMED + 2 - i, 1, 1),
    );
    const sentence = describeEntityClusters(
      summaryOf(shapes.length, 44, shapes.length, shapes),
    );
    expect(sentence).toContain("8 x 1 on 1 value; 7 x 1 on 1 value");
    expect(sentence).toContain("; and 2 smaller shapes.");
    expect(sentence).not.toContain("2 x 1 on 1 value;");
  });

  test("the sentence is printable ASCII over first-party prose alone", () => {
    // The whole string is composed here from integers this module formats, so a
    // display sink escapes it as it escapes any other message. The console
    // sentinel fails a CLI line holding a byte outside printable ASCII, which a
    // locale-default digit separator would put there.
    const sentence = describeEntityClusters(
      summaryOf(2, 20000, 30000, [shape(19999, 29999, 12345), shape(1, 1, 1)]),
    );
    expect(sentence).toMatch(/^[\x20-\x7e]+$/);
    expect(sentence).toContain("19,999 x 29,999 on 12,345 values");
  });
});
