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

function plural(count: number, noun: string): string {
  return `${formatCount(count)} ${noun}${count === 1 ? "" : "s"}`;
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
 */
export function describeEntityClusters(summary: EntityClusterSummary): string {
  if (summary.clusterCount === 0)
    return "Entity clusters in your result: none, since this run matched no pairs.";
  const named = summary.shapes.slice(0, ENTITY_CLUSTER_SHAPES_NAMED);
  const dropped = summary.shapes.length - named.length;
  const largest = summary.shapes[0];
  return (
    `Entity clusters in your result: ${plural(summary.clusterCount, "cluster")} ` +
    `over ${plural(summary.localRows, "record")} of yours and ` +
    `${formatCount(summary.partnerRows)} of your partner's. Sizes as yours by ` +
    "your partner's, largest first, with the distinct matched values each " +
    `formed on: ${named.map(describeShape).join("; ")}` +
    (dropped === 0 ? "" : `; and ${plural(dropped, "smaller shape")}`) +
    "." +
    (largest.localRows === 1 && largest.partnerRows === 1
      ? ""
      : " A large cluster formed on one value is a linkage key that named a " +
        "group rather than an individual; one formed on several is a chain " +
        "through a record's candidate values. Narrow the key or the candidate " +
        "values to break it up.")
  );
}
