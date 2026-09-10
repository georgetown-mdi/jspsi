import { InternalConsistencyError } from "../errors";
import type { AssociationTable } from "../types";

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
 * @param table - A matched table read as pairs: entry `i` pairs `table[0][i]`
 *   with `table[1][i]`. A repeated pair would be one edge counted twice, which
 *   changes no component; `assertMatchedPairsWellFormed` (exchange.ts) refuses
 *   one.
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
 * One block of a both-sided round: the records of each party that contributed
 * one matched value, in their own party's row space. Every pair between them is
 * accepted, `many-to-many` acceptance being total, so a block is the whole
 * `m x n` product (docs/spec/PROTOCOL.md, The `many-to-many` entity closure).
 *
 * A record contributing several of a round's matched values stands in several
 * of that round's blocks, which is what joins them into one cluster.
 */
export interface ClosureBlock {
  readonly localRows: ReadonlyArray<number>;
  readonly partnerRows: ReadonlyArray<number>;
}

/**
 * Requires a matched table's entity clusters to be round-diagonal: a cluster may
 * span several blocks of one round and never two rounds
 * (docs/spec/PROTOCOL.md, The `many-to-many` entity closure).
 *
 * Three conditions hold the shape, and this refuses each -- a cluster whose
 * pairs were matched in two different rounds, a block split across two clusters,
 * and a block the table does not hold every pair of. What they secure is that
 * every grouping the closure hands the operator rests on the round's own matched
 * values: a cluster's records are joined by the values its blocks were built
 * from, and by nothing the partner's returned list decided on its own.
 *
 * The blocks are the round's own, read per matched VALUE rather than per record,
 * so a record standing in two of a round's blocks -- which is what a candidate
 * set produces -- is held to both rather than having them flattened into one
 * grouping this could not see past.
 *
 * The returned-list check (`resolveRunGroupedReturn`, utils/partnerIndices.ts)
 * already implies this on the built path: it holds the partner's runs to the
 * pairing this party resolved, row for row, so the table it builds is that
 * pairing's own image. That is why a violation here is an internal
 * inconsistency rather than a partner fault, and why the claim is pinned on the
 * artifact every consumer reads rather than left to rest on that argument alone.
 *
 * @param id - The participant id the message is attributed to.
 * @param table - The matched table, read as pairs.
 * @param roundOfPair - The key round each pair of `table` was matched in.
 * @param blocks - Every block the rounds produced, in the two parties' row
 *   spaces.
 */
export function assertRoundDiagonalClosure(
  id: string,
  table: AssociationTable,
  roundOfPair: ReadonlyArray<number>,
  blocks: ReadonlyArray<ClosureBlock>,
): void {
  if (roundOfPair.length !== table[0].length)
    throw new Error(
      `${id}: the closure check was given ${roundOfPair.length} round ` +
        `label(s) for ${table[0].length} matched pair(s)`,
    );

  const clusters = entityClusters(table);
  const clusterOfLocalRow = new Map<number, number>();
  const clusterOfPartnerRow = new Map<number, number>();
  clusters.forEach((cluster, index) => {
    for (const row of cluster.localRows) clusterOfLocalRow.set(row, index);
    for (const row of cluster.partnerRows) clusterOfPartnerRow.set(row, index);
  });

  const roundOfCluster = new Array<number | undefined>(clusters.length).fill(
    undefined,
  );
  for (let i = 0; i < roundOfPair.length; ++i) {
    const cluster = clusterOfLocalRow.get(table[0][i])!;
    const round = roundOfCluster[cluster];
    if (round === undefined) roundOfCluster[cluster] = roundOfPair[i];
    else if (round !== roundOfPair[i])
      throw notRoundDiagonal(
        id,
        `the cluster holding this party's record ${clusters[cluster].localRows[0]} ` +
          "joins pairs matched on two different linkage keys, where a record " +
          "standing in any of a key's candidate pairs leaves candidacy for " +
          "every later key",
      );
  }

  const partnerRowsOf = new Map<number, Set<number>>();
  for (let i = 0; i < table[0].length; ++i) {
    let rows = partnerRowsOf.get(table[0][i]);
    if (rows === undefined) {
      rows = new Set<number>();
      partnerRowsOf.set(table[0][i], rows);
    }
    rows.add(table[1][i]);
  }

  for (const block of blocks) {
    if (block.localRows.length === 0 || block.partnerRows.length === 0)
      throw new Error(
        `${id}: the closure check was given a block with no record on one ` +
          "side, where a block is the records that contributed one matched value",
      );
    const cluster = clusterOfLocalRow.get(block.localRows[0]);
    for (const row of block.localRows)
      if (clusterOfLocalRow.get(row) !== cluster)
        throw notRoundDiagonal(
          id,
          "one matched value's pairs are split across the clusters holding " +
            `this party's records ${block.localRows[0]} and ${row}`,
        );
    for (const row of block.partnerRows)
      if (clusterOfPartnerRow.get(row) !== cluster)
        throw notRoundDiagonal(
          id,
          "one matched value's pairs are split across the cluster holding " +
            `this party's record ${block.localRows[0]} and the one holding ` +
            `the partner's record ${row}`,
        );
    for (const local of block.localRows) {
      const held = partnerRowsOf.get(local);
      for (const partner of block.partnerRows)
        if (held?.has(partner) !== true)
          throw notRoundDiagonal(
            id,
            `the block of one matched value covers ${block.localRows.length} ` +
              `record(s) of this party and ${block.partnerRows.length} of the ` +
              `partner's, and the table holds no pair between this party's ` +
              `record ${local} and the partner's ${partner}, where a block ` +
              "holds every pair between the records that contributed its value",
          );
    }
  }
}

function notRoundDiagonal(
  id: string,
  detail: string,
): InternalConsistencyError {
  return new InternalConsistencyError(
    `${id}: the matched table's entity clusters are not the shape a ` +
      `both-sided deduplicating cascade produces: ${detail}. The exchange ` +
      "cannot proceed; report it with this message.",
  );
}
