import { describe, expect, test } from "vitest";

import {
  ENTITY_CLUSTER_GUIDE_SHARE,
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

  test("a summary with no shapes states the counts it holds", () => {
    // A seat can be handed a summary whose distribution it could not read --
    // the console relay drops a malformed one -- and the sentence states what
    // it was told rather than reading a shape that is not there.
    expect(describeEntityClusters(summaryOf(3, 1, 1, []))).toBe(
      "Entity clusters in your result: 3 clusters over 1 record of yours and " +
        "1 of your partner's. Their sizes are not available.",
    );
  });

  test("a largest cluster within the guide share gets no reading guide", () => {
    // Two records against two, and the boundary case of exactly a tenth of the
    // 200 matched records: under many-to-many a small largest cluster is the
    // ordinary outcome, and the guide would then be advice on every run.
    for (const largest of [shape(2, 2, 1), shape(20, 20, 2)]) {
      const rest = 200 - largest.localRows;
      const sentence = describeEntityClusters(
        summaryOf(1 + rest, 200, 200, [largest, shape(1, 1, 1, rest)]),
      );
      expect(sentence).toContain(
        `${largest.localRows} x ${largest.partnerRows} on`,
      );
      expect(sentence).not.toContain("Narrow the key");
    }
  });

  test("a largest cluster past the guide share gets the reading guide", () => {
    // 21 of 200 is past ENTITY_CLUSTER_GUIDE_SHARE, the share a cluster spans
    // before it is the signature of a key that named a group.
    expect(ENTITY_CLUSTER_GUIDE_SHARE * 200).toBe(20);
    expect(
      describeEntityClusters(
        summaryOf(180, 200, 200, [shape(21, 21, 3), shape(1, 1, 1, 179)]),
      ),
    ).toContain("Narrow the key or the candidate values to break it up.");
  });

  test("a cluster holding most of the result gets the reading guide", () => {
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
