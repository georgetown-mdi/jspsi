import { InternalConsistencyError } from "./errors";
import type { AssociationTable } from "./types";

/**
 * One entity cluster of an association table: a connected component of the
 * bipartite graph whose vertices are the two parties' matched records and whose
 * edges are the table's pairs.
 *
 * Both halves are this cluster's members in their own party's row space, ascending
 * and distinct. A cluster always holds at least one record of each party, every
 * vertex reaching the graph through a pair (docs/spec/PROTOCOL.md, The
 * `many-to-many` entity closure).
 */
interface EntityCluster {
  readonly localRows: ReadonlyArray<number>;
  readonly partnerRows: ReadonlyArray<number>;
}

interface MutableCluster {
  localRows: Array<number>;
  partnerRows: Array<number>;
}

// Disjoint-set forest over the two row spaces at once: a local row and a partner
// row get separate nodes, so a row index shared by the two parties is two vertices
// rather than one. Nodes are allocated on first appearance, so an unmatched record
// occupies nothing.
class RowForest {
  private readonly parent: Array<number> = [];
  private readonly localNode = new Map<number, number>();
  private readonly partnerNode = new Map<number, number>();

  nodeForLocal(row: number): number {
    return this.node(this.localNode, row);
  }

  nodeForPartner(row: number): number {
    return this.node(this.partnerNode, row);
  }

  union(a: number, b: number): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parent[rootA] = rootB;
  }

  find(node: number): number {
    let root = node;
    while (this.parent[root] !== root) root = this.parent[root];
    let walk = node;
    while (this.parent[walk] !== root) {
      const next = this.parent[walk];
      this.parent[walk] = root;
      walk = next;
    }
    return root;
  }

  localRows(): IterableIterator<[number, number]> {
    return this.localNode.entries();
  }

  partnerRows(): IterableIterator<[number, number]> {
    return this.partnerNode.entries();
  }

  private node(index: Map<number, number>, row: number): number {
    let node = index.get(row);
    if (node === undefined) {
      node = this.parent.length;
      this.parent.push(node);
      index.set(row, node);
    }
    return node;
  }
}

/**
 * The entity clusters of an association table: the closure step a party runs
 * LOCALLY, over the table it already holds, with no additional exchange
 * (docs/spec/PROTOCOL.md, The `many-to-many` entity closure).
 *
 * Both output-entitled parties end the cascade holding the same table, so both
 * compute the same clusters from it -- the agreement is a property of that one
 * table rather than of a further reconciliation, and nothing here reads a round, a
 * linkage-key value, or any quantity the partner declares.
 *
 * Clusters are ordered by their lowest local row, and each cluster's two halves
 * ascend, whatever order the table's pairs arrive in, so one table has one
 * arrangement: a party recomputing, or two readers of that same party's table, get
 * the same list. Each party orders by its OWN lowest row over a table transposed
 * from its partner's, so what the two parties hold in common is the cluster SET,
 * each cluster's halves ascending, rather than the order the clusters are listed
 * in.
 *
 * @param table - A matched table read as pairs: entry `i` pairs `table[0][i]` with
 *   `table[1][i]`. A repeated pair would be one edge counted twice, which changes
 *   no component; the seam that consumes a table refuses one
 *   (`assertMatchedPairsWellFormed`, exchange.ts).
 */
export function entityClusters(table: AssociationTable): Array<EntityCluster> {
  const [localRows, partnerRows] = table;
  if (localRows.length !== partnerRows.length)
    throw new Error(
      "the association table's halves have different lengths: " +
        `${localRows.length} vs ${partnerRows.length}. Each entry is one ` +
        "matched pair, so the two halves are read together.",
    );

  const forest = new RowForest();
  for (let i = 0; i < localRows.length; ++i)
    forest.union(
      forest.nodeForLocal(localRows[i]),
      forest.nodeForPartner(partnerRows[i]),
    );

  const byRoot = new Map<number, MutableCluster>();
  const clusterFor = (node: number): MutableCluster => {
    const root = forest.find(node);
    let cluster = byRoot.get(root);
    if (cluster === undefined) {
      cluster = { localRows: [], partnerRows: [] };
      byRoot.set(root, cluster);
    }
    return cluster;
  };
  for (const [row, node] of forest.localRows())
    clusterFor(node).localRows.push(row);
  for (const [row, node] of forest.partnerRows())
    clusterFor(node).partnerRows.push(row);

  const ascending = (a: number, b: number): number => a - b;
  const clusters = Array.from(byRoot.values(), (cluster) => ({
    localRows: cluster.localRows.sort(ascending),
    partnerRows: cluster.partnerRows.sort(ascending),
  }));
  return clusters.sort((a, b) => a.localRows[0] - b.localRows[0]);
}

/**
 * Requires a matched table's entity clusters to be exactly its per-(round, value)
 * blocks: the shape the closure takes in the scope `many-to-many` runs in, where
 * the cascade is the only strategy that pairs it and no fan-out reaches the
 * cascade (docs/spec/PROTOCOL.md, The `many-to-many` entity closure).
 *
 * The claim is that the table is a disjoint union of complete `m x n` blocks, one
 * per matched value of one round, so a cluster's members all share one linkage-key
 * value under one key. It is what makes the closure safe to run without a
 * disclosure of its own: no two of a party's records are grouped through a partner
 * record that no rule links them through. Three conditions carry it, and this
 * refuses each -- a cluster spanning two blocks, a cluster that is not the whole
 * `m x n` product, and one block split across two clusters.
 *
 * The labels are read per PAIR rather than per record so that a producer labelling
 * one record's pairs apart -- one record in two of a round's blocks, as a cascade
 * fan-out would put it, refused today where a record's value is read -- is held to
 * the same block shape here, instead of its two blocks arriving flattened into one
 * label per record that this could not see past. The sole producer today
 * (`blockLabels`, link.ts) derives one label per matched record and replicates it
 * across that record's pairs, over a map holding at most one (round, position) per
 * record, so it excludes that shape structurally; the per-pair signature is what
 * keeps this a backstop for a changed derivation rather than a restatement of the
 * current one.
 *
 * The returned-list checks (`assertPartnerIndices`, utils/partnerIndices.ts) imply
 * this on the built path: they hold the runs answering one position identical and
 * the runs answering different positions disjoint, which is these conditions read
 * on the frame rather than on the table. That is why a violation is an internal
 * inconsistency rather than a partner fault, and why the claim is pinned here on
 * the artifact every consumer reads instead of resting on that argument.
 *
 * @param id - The participant id the message is attributed to.
 * @param table - The matched table, read as pairs.
 * @param blockOfPair - One opaque block label per pair of `table`, equal exactly
 *   for two pairs of one (round, value) block.
 */
export function assertBlockDiagonalClosure(
  id: string,
  table: AssociationTable,
  blockOfPair: ReadonlyArray<number>,
): void {
  if (blockOfPair.length !== table[0].length)
    throw new Error(
      `${id}: the closure check was given ${blockOfPair.length} block ` +
        `label(s) for ${table[0].length} matched pair(s)`,
    );

  const clusters = entityClusters(table);
  const clusterOfLocalRow = new Map<number, number>();
  clusters.forEach((cluster, index) => {
    for (const row of cluster.localRows) clusterOfLocalRow.set(row, index);
  });

  const pairsInCluster = new Array<number>(clusters.length).fill(0);
  const blockOfCluster = new Array<number | undefined>(clusters.length).fill(
    undefined,
  );
  for (let i = 0; i < blockOfPair.length; ++i) {
    const cluster = clusterOfLocalRow.get(table[0][i])!;
    ++pairsInCluster[cluster];
    const block = blockOfCluster[cluster];
    if (block === undefined) blockOfCluster[cluster] = blockOfPair[i];
    else if (block !== blockOfPair[i])
      throw notBlockDiagonal(
        id,
        `the cluster holding this party's record ${clusters[cluster].localRows[0]} ` +
          "joins pairs matched on two different key values, so two of a " +
          "party's records would be grouped through a partner record no " +
          "linkage key links them through",
      );
  }

  const clusterOfBlock = new Map<number, number>();
  for (let index = 0; index < clusters.length; ++index) {
    const { localRows, partnerRows } = clusters[index];
    if (pairsInCluster[index] !== localRows.length * partnerRows.length)
      throw notBlockDiagonal(
        id,
        `the cluster holding this party's record ${localRows[0]} holds ` +
          `${pairsInCluster[index]} pair(s) over ${localRows.length} record(s) ` +
          `of this party and ${partnerRows.length} of the partner's, where a ` +
          "block of one matched value holds every pair between them",
      );
    const block = blockOfCluster[index]!;
    const first = clusterOfBlock.get(block);
    if (first !== undefined)
      throw notBlockDiagonal(
        id,
        "one matched value's pairs are split across the clusters holding " +
          `this party's records ${clusters[first].localRows[0]} and ` +
          `${localRows[0]}`,
      );
    clusterOfBlock.set(block, index);
  }
}

function notBlockDiagonal(
  id: string,
  detail: string,
): InternalConsistencyError {
  return new InternalConsistencyError(
    `${id}: the matched table's entity clusters are not the blocks a ` +
      `both-sided deduplicating cascade produces: ${detail}. The exchange ` +
      "cannot proceed; report it with this message.",
  );
}
