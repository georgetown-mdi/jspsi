import { formatCount } from "./utils/formatCount.js";

import type {
  EntityClusterShape,
  EntityClusterSummary,
} from "./psi/entityClosure.js";

/**
 * How many cluster shapes {@link describeEntityClusters} names before it
 * reports the rest as a count.
 *
 * A run can produce as many shapes as it has clusters, and the sentence is read
 * on one terminal line and in one paragraph of a completion panel, so the tail
 * is stated as a number rather than listed. The shapes are ordered largest
 * first, so what the cut drops is the small end.
 */
export const ENTITY_CLUSTER_SHAPES_NAMED = 6;

/**
 * The share of a party's matched records the largest cluster spans before
 * {@link describeEntityClusters} closes with the reading guide.
 *
 * A cluster spanning a large share of either party's matched records is the
 * signature of a key that named a group rather than a person, while a result
 * whose clusters are mostly `1 x 1` matched close to one-to-one and has nothing
 * to break up (docs/spec/PROTOCOL.md, Choosing linkage keys under closure).
 * Under `many-to-many` a largest cluster of two records against one is an
 * ordinary outcome, so the guide is held to a share that is not.
 */
export const ENTITY_CLUSTER_GUIDE_SHARE = 0.1;

function plural(count: number, noun: string): string {
  return `${formatCount(count)} ${noun}${count === 1 ? "" : "s"}`;
}

function guideApplies(
  summary: EntityClusterSummary,
  largest: EntityClusterShape,
): boolean {
  if (largest.localRows === 1 && largest.partnerRows === 1) return false;
  return (
    largest.localRows > ENTITY_CLUSTER_GUIDE_SHARE * summary.localRows ||
    largest.partnerRows > ENTITY_CLUSTER_GUIDE_SHARE * summary.partnerRows
  );
}

function describeShape(shape: EntityClusterShape): string {
  return (
    `${formatCount(shape.localRows)} x ${formatCount(shape.partnerRows)} on ` +
    plural(shape.distinctValues, "value") +
    (shape.clusters === 1 ? "" : ` (${plural(shape.clusters, "cluster")})`)
  );
}

/**
 * State what the entity closure grouped this party's result into: how many
 * clusters, over how many records of each party, and the distribution of their
 * shapes with the distinct matched values each formed on
 * (docs/spec/PROTOCOL.md, Choosing linkage keys under closure).
 *
 * Composed for a `many-to-many` run alone, the one cardinality whose closure
 * produces clusters a party cannot read off the table's shape. It states a
 * result and refuses nothing: the spec makes the diagnostic a front end's
 * discretion on the footing the pair-table advisory takes, so this composes the
 * sentence and each seat decides where to render it.
 *
 * The whole sentence is first-party prose over integers this module formats
 * itself. No linkage-key value, record, or row index reaches it, so a display
 * sink escapes it exactly as it escapes any other message it is handed.
 *
 * Total over every summary: one whose shape list is empty states the counts it
 * has and nothing about the sizes, so a seat handed a distribution it could not
 * read still states what it was told.
 */
export function describeEntityClusters(summary: EntityClusterSummary): string {
  if (summary.clusterCount === 0)
    return "Entity clusters in your result: none, since this run matched no pairs.";
  const counts =
    `Entity clusters in your result: ${plural(summary.clusterCount, "cluster")} ` +
    `over ${plural(summary.localRows, "record")} of yours and ` +
    `${formatCount(summary.partnerRows)} of your partner's.`;
  if (summary.shapes.length === 0)
    return `${counts} Their sizes are not available.`;
  const named = summary.shapes.slice(0, ENTITY_CLUSTER_SHAPES_NAMED);
  const dropped = summary.shapes.length - named.length;
  const largest = summary.shapes[0];
  return (
    `${counts} Sizes as yours by your partner's, largest first, with the ` +
    "distinct matched values each formed on: " +
    `${named.map(describeShape).join("; ")}` +
    (dropped === 0 ? "" : `; and ${plural(dropped, "smaller shape")}`) +
    "." +
    (guideApplies(summary, largest)
      ? " A large cluster formed on one value is a linkage key that named a " +
        "group rather than an individual; one formed on several is a chain " +
        "through a record's candidate values. Narrow the key or the candidate " +
        "values to break it up."
      : "")
  );
}
