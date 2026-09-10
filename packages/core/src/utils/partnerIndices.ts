// Every index list a party receives from its exchange partner addresses
// state the RECEIVING party owns: its own rows or per-round positions, or
// the partner's rows as counted on the authenticated terms exchange. The
// chokepoint below checks such a list against that state before it indexes
// anything or reaches the self-attested record. Every bound passed in is
// derived locally or from authenticated session state, never from the frame
// under check; a two-half table range-checks the anchoring half first, so
// the paired half's count is pinned to a locally held quantity rather than
// chosen by the partner. The wire schemas upstream accept any FINITE
// number, so integrality is checked here too: a fractional index addresses
// nothing and is `undefined`.
import { ConnectionError } from "../connection/messageConnection";

/**
 * A partner-frame violation, tagged `"protocol"` so it is classified exactly like
 * a schema rejection from `receiveParsed` / `parseOrProtocolError` rather than
 * escaping as a bare runtime error.
 *
 * @param participantId - This party's participant id, prefixed on the message.
 * @param detail - What was wrong, naming the list rather than its contents: an
 *   index value is partner-supplied data and does not belong in a log line.
 */
export function partnerProtocolError(
  participantId: string,
  detail: string,
): ConnectionError {
  return new ConnectionError(
    `${participantId} protocol error: ${detail}`,
    "protocol",
  );
}

function entryCount(count: number): string {
  return `${count} ${count === 1 ? "entry" : "entries"}`;
}

/**
 * Requires a partner-supplied list to have exactly the number of entries
 * this party's own state implies.
 *
 * @param participantId - This party's participant id.
 * @param what - Names the list, for the error message.
 * @param count - The received entry count.
 * @param expected - The count this party derived locally. The length of a list
 *   read out of the frame under check is not one of those, since the partner
 *   chooses it; the two-half form is {@link assertPartnerIndexTable}, which
 *   pins the anchoring half to a local bound before its length is used here.
 * @throws A `"protocol"` {@link ConnectionError} on any other count.
 */
export function assertPartnerIndexCount(
  participantId: string,
  what: string,
  count: number,
  expected: number,
): void {
  if (count !== expected)
    throw partnerProtocolError(
      participantId,
      `${what} has ${entryCount(count)}, expected ${expected}`,
    );
}

// A V8 Set entry costs about 21 bytes retained and about 40 bytes at the
// transient rehash peak -- 2M integer entries on the pinned runtime (node
// v26.7.0) measure ~42 MB retained after a forced gc and ~80 MB at the peak
// -- where a Uint8Array bitmap costs one byte per addressable slot however
// short the list is. Below this ratio the bitmap allocates less; the
// constant sits between the retained and peak cost, so the comparison stays
// conservative whichever binds, moving the allocation by a constant factor
// rather than by the partner's bound if it errs.
const SET_ENTRY_BYTES = 32;

// Duplicate detection over `[0, exclusiveBound)`, backed by whichever of the
// two forms allocates less for the list at hand: the bitmap wins at the
// call sites whose bound is one of this party's own counts, where honest
// lists run to millions of entries. The ratio is critical rather than a
// tuning choice: a bound may be the partner's row count or a per-message
// element bound, authenticated but as large as MAX_RECORD_COUNT, and a
// bitmap sized by that unconditionally would let a three-entry frame demand
// a terabyte -- which V8 answers by aborting the process, not by throwing.
// Choosing by ratio caps the allocation at
// min(exclusiveBound, SET_ENTRY_BYTES * length) bytes.
function createRepeatDetector(
  length: number,
  exclusiveBound: number,
): (index: number) => boolean {
  if (exclusiveBound <= length * SET_ENTRY_BYTES) {
    const seen = new Uint8Array(exclusiveBound);
    return (index) => {
      const repeated = seen[index] === 1;
      seen[index] = 1;
      return repeated;
    };
  }
  const seen = new Set<number>();
  return (index) => {
    const repeated = seen.has(index);
    seen.add(index);
    return repeated;
  };
}

/**
 * The grouping a list is required to be injective MODULO, entry for entry: what
 * this party's own outbound entry at that place was accepted against -- a key
 * round, and one of the partner's records within it.
 *
 * Both arrays run parallel to the list under check and hold state this party
 * computed and sent, never anything read from the frame under check. A caller
 * whose transport may hand the partner the sent objects themselves rather than a
 * serialization of them copies the two out before sending.
 */
export interface PartnerIndexGrouping {
  /** The key round each entry's outbound counterpart named. */
  readonly rounds: ArrayLike<number>;
  /**
   * The partner record it was accepted against within that round, as that
   * record's rank there. Where several of the partner's records were accepted
   * with one of this party's, the lowest of their ranks stands for the group.
   */
  readonly groups: ArrayLike<number>;
}

/** Optional per-list rules beyond whole, in-range, and non-repeating. */
export interface PartnerIndexRules {
  /**
   * Require the entries to arrive in ascending order. Set only where the
   * order is a property of the list rather than an incidental one: an
   * association table's local half is read in that order downstream (the
   * result rows, and the exchange record's reconstruction of them), so a
   * partner-resolved table that does not have it is refused here rather
   * than silently reordering what those readers reproduce.
   */
  ascending?: boolean;
  /**
   * Admit a repeated entry BETWEEN entries this party itself grouped together,
   * and require entries of different groups to differ. Set only where a repeat
   * is the protocol's own widening rather than a fault: the cascade's returned
   * mapped-element list on the "many" side of a deduplicating exchange, where
   * several of this party's records legitimately name one partner row
   * (docs/spec/PROTOCOL.md, Deriving one table from the exchanged association
   * maps).
   *
   * The grouping keeps that relaxation from handing the partner the pairing:
   * flat distinctness is replaced by injectivity modulo the grouping, so
   * the partner can neither merge two of this party's groups onto one row
   * nor split one across two. Distinctness is also what otherwise caps a
   * list's LENGTH at `exclusiveBound`, so a caller setting this must pin
   * the length against a locally computed count first
   * ({@link assertPartnerIndexCount}); this function then bounds the
   * entries alone.
   */
  repeatsGroupedBy?: PartnerIndexGrouping;
  /**
   * Admit a repeated entry with NO grouping to hold it to: the half of a
   * resolved association table naming the "one" side's rows under a
   * deduplicating cardinality, where several of the MANY side's records
   * link to one of them and the resolver -- not this party -- computed the
   * pairing (docs/spec/PROTOCOL.md, Deriving one table from the exchanged
   * association maps). There is no counterpart grouping to check against at
   * that call site, which is what separates this from
   * {@link repeatsGroupedBy}; the two relaxations here are alternatives
   * and setting both is a caller fault.
   *
   * Alongside `ascending` it leaves the half NON-DECREASING, the strictness
   * being exactly what distinctness held. Distinctness is also what
   * otherwise caps a list's LENGTH at `exclusiveBound`, so a caller setting
   * this must pin the length against a count it computed or holds from
   * authenticated session state first; {@link assertPartnerIndexTable} does
   * that by taking the half that keeps its distinctness as the anchor.
   */
  repeats?: boolean;
}

/**
 * Requires every entry of a partner-supplied index list to be a whole number in
 * `[0, exclusiveBound)`, with no entry repeated.
 *
 * Distinctness is the protocol invariant on all three matching paths --
 * one-to-one matching pairs each row at most once -- and it is what caps
 * the list's LENGTH at `exclusiveBound`, since a longer list cannot hold
 * distinct in-range entries. The length is therefore not a separate
 * argument, except under the two rules that relax distinctness --
 * `rules.repeatsGroupedBy`, which replaces it with injectivity modulo the
 * grouping it holds, and `rules.repeats`, which drops it for a half whose
 * multiplicity the partner's own side holds -- each leaving the length to the
 * caller's own count check. A list whose entries answer that grouping in RUNS
 * is read by {@link resolveRunGroupedReturn} instead, which holds it to the
 * pairing this party resolved rather than to a distinctness rule.
 *
 * @param participantId - This party's participant id.
 * @param what - Names the list, for the error message.
 * @param indices - The partner-supplied entries, in received order.
 * @param exclusiveBound - The count of addressable slots on this side. Derived
 *   locally or from authenticated session state, never from the received frame.
 * @param rules - Optional additional properties the list must have; see
 *   {@link PartnerIndexRules}.
 * @throws A `"protocol"` {@link ConnectionError} on a non-integer, out-of-range,
 *   or repeated entry, on a descending pair under `rules.ascending`, or on a pair
 *   breaking the grouping under `rules.repeatsGroupedBy`.
 */
export function assertPartnerIndices(
  participantId: string,
  what: string,
  indices: ReadonlyArray<number>,
  exclusiveBound: number,
  rules: PartnerIndexRules = {},
): void {
  const grouping = rules.repeatsGroupedBy;
  if (
    grouping !== undefined &&
    (grouping.rounds.length !== indices.length ||
      grouping.groups.length !== indices.length)
  )
    throw new Error(
      `${what}: a grouped index check needs one group per entry, given ` +
        `${grouping.rounds.length} round(s) and ${grouping.groups.length} ` +
        `group(s) for ${entryCount(indices.length)}`,
    );
  if (grouping !== undefined && rules.repeats === true)
    throw new Error(
      `${what}: each rule that relaxes distinctness holds every repeat to a ` +
        "different thing, so at most one of them applies to a list",
    );
  // Distinctness is what caps the length; the two rules that relax it leave the
  // cap to the caller's own count check (see PartnerIndexRules).
  const distinct = grouping === undefined && rules.repeats !== true;
  if (distinct && indices.length > exclusiveBound)
    throw partnerProtocolError(
      participantId,
      `${what} has ${entryCount(indices.length)}, more than the ` +
        `${exclusiveBound} this side can address`,
    );
  // A half admitting ungrouped repeats reports none, and allocates no detector for
  // the entries it would have tracked; a grouped or run-grouped one still needs the
  // detector, for the across-group half of its rule.
  const repeats =
    rules.repeats === true
      ? () => false
      : createRepeatDetector(indices.length, exclusiveBound);
  // Which index each group has taken so far, by round and then by partner
  // record. Only the first entry of a group consults the repeat
  // detector, so a legitimate repeat within one group is never treated as
  // one across groups.
  const indexByGroup = new Map<number, Map<number, number>>();
  let previous = -1;
  // Each entry is checked in one pass, the repeat before the order, so a
  // list that both repeats and descends is reported as the repeat -- the
  // narrower of the two faults, and the one every call site checks.
  for (let entry = 0; entry < indices.length; ++entry) {
    const index = indices[entry];
    if (!Number.isInteger(index))
      throw partnerProtocolError(
        participantId,
        `${what} has an entry that is not a whole number`,
      );
    if (index < 0 || index >= exclusiveBound)
      throw partnerProtocolError(
        participantId,
        `${what} has an index outside [0, ${exclusiveBound})`,
      );
    if (grouping) {
      const round = grouping.rounds[entry];
      let indexByRecord = indexByGroup.get(round);
      if (indexByRecord === undefined) {
        indexByRecord = new Map<number, number>();
        indexByGroup.set(round, indexByRecord);
      }
      const group = grouping.groups[entry];
      const taken = indexByRecord.get(group);
      if (taken === undefined) {
        if (repeats(index))
          throw partnerProtocolError(
            participantId,
            `${what} names one partner row for two of the partner's records ` +
              "this side matched",
          );
        indexByRecord.set(group, index);
      } else if (taken !== index)
        throw partnerProtocolError(
          participantId,
          `${what} names two partner rows for one of the partner's records ` +
            "this side matched",
        );
    } else if (repeats(index))
      throw partnerProtocolError(participantId, `${what} repeats an index`);
    if (rules.ascending === true && index < previous)
      throw partnerProtocolError(
        participantId,
        `${what} is not in ascending order`,
      );
    previous = index;
  }
}

/**
 * The pairing a RUN-grouped returned list has to reproduce: for each of this
 * party's own outbound entries, in the order it sent them, the key round it
 * named, how many entries of the list answer it, and the partner GROUPS its own
 * record was accepted with, as their ranks within that round.
 *
 * A rank stands for whichever of the two the round's frames left this party
 * holding: one of the partner's records where its grouping named the owners of
 * each matched position, and the whole group behind one matched position where
 * that grouping was absent (docs/spec/PROTOCOL.md, An absent grouping is all
 * ones). Either way it is a set of the partner's records this party's own
 * resolution accepted with one of its own, which is what the check reads.
 *
 * Every array holds state this party resolved for itself, never anything read
 * from the frame under check. `ownerStarts` runs one longer than `rounds`:
 * outbound entry `i` was accepted with the ranks at
 * `owners[ownerStarts[i] .. ownerStarts[i + 1])`.
 */
export interface PartnerIndexOwnerRuns {
  readonly rounds: ArrayLike<number>;
  readonly runLengths: ArrayLike<number>;
  readonly ownerStarts: ArrayLike<number>;
  readonly owners: ArrayLike<number>;
}

// The records of this party that claim one partner row, or that one rank was
// accepted with, as a comparable key. Both lists are built in ascending
// outbound-entry order, so no sort is needed to compare them.
function claimantKey(entries: ReadonlyArray<number>): string {
  return entries.join(",");
}

/**
 * Read a returned mapped-element list that comes back as RUNS -- one run per
 * outbound entry, holding the partner rows of every one of its records accepted
 * with that entry's -- and resolve which of the partner's rows each of its ranks
 * stands for (docs/spec/PROTOCOL.md, Deriving one table from the exchanged
 * association maps).
 *
 * What the list is held to is the pairing this party resolved for itself, read
 * through the only thing a row's identity can be checked by: WHICH of this
 * party's records the return claims it for. A rank was accepted with a definite
 * set of this party's records, so every row the return attributes to that same
 * set is one of that rank's, and a round's rows must fall into exactly the sets
 * its accepted ranks were pairs of -- no set the round did not accept together,
 * and none of them left without a row. So the partner can neither merge two of
 * this party's records onto one of its own nor split one across two, however its
 * entries' rank sets overlap.
 *
 * That overlap is what a candidate set produces and what a rule keyed to one
 * rank per entry cannot state: two entries' rank sets then meet without
 * coinciding, so neither "identical runs" nor "disjoint runs" is the rule, and a
 * fabricated row would join clusters this party's own resolution kept apart. The
 * order of the rows WITHIN a run is the partner's own and is not read here.
 *
 * The list's length is not checked: the run lengths are the count the caller
 * pinned it to first ({@link assertPartnerIndexCount}), and a list they do not
 * cover is a caller fault rather than the partner's.
 *
 * @param participantId - This party's participant id.
 * @param what - Names the list, for the error message.
 * @param indices - The partner-supplied entries, in received order.
 * @param exclusiveBound - The partner's row count, declared on the terms
 *   exchange.
 * @param runs - What this party sent and what it resolved each entry against.
 * @returns The partner rows each accepted rank stands for, by round, ascending.
 * @throws A `"protocol"` {@link ConnectionError} on a non-integer or
 *   out-of-range entry, on a run naming one row twice, or on a round whose rows
 *   fall into other sets of this party's records than the ones it accepted.
 */
export function resolveRunGroupedReturn(
  participantId: string,
  what: string,
  indices: ReadonlyArray<number>,
  exclusiveBound: number,
  runs: PartnerIndexOwnerRuns,
): Map<number, Map<number, Array<number>>> {
  const runCount = runs.rounds.length;
  if (
    runs.runLengths.length !== runCount ||
    runs.ownerStarts.length !== runCount + 1
  )
    throw new Error(
      `${what}: a run-grouped return needs one length and one owner list per ` +
        `run, given ${runs.runLengths.length} and ` +
        `${runs.ownerStarts.length - 1} for ${runCount} run(s)`,
    );

  for (const index of indices) {
    if (!Number.isInteger(index))
      throw partnerProtocolError(
        participantId,
        `${what} has an entry that is not a whole number`,
      );
    if (index < 0 || index >= exclusiveBound)
      throw partnerProtocolError(
        participantId,
        `${what} has an index outside [0, ${exclusiveBound})`,
      );
  }

  // The two partitions of this party's own matched records that have to agree:
  // the one its resolution states, a set per accepted rank, and the one the
  // return states, a set per partner row it names.
  const ranksByRound = new Map<number, Map<number, Array<number>>>();
  const claimantsByRound = new Map<number, Map<number, Array<number>>>();
  const claimed = (
    of: Map<number, Map<number, Array<number>>>,
    round: number,
    key: number,
  ): Array<number> => {
    let byKey = of.get(round);
    if (byKey === undefined) {
      byKey = new Map<number, Array<number>>();
      of.set(round, byKey);
    }
    let entries = byKey.get(key);
    if (entries === undefined) {
      entries = [];
      byKey.set(key, entries);
    }
    return entries;
  };

  let entry = 0;
  for (let run = 0; run < runCount; ++run) {
    const round = runs.rounds[run];
    for (let k = runs.ownerStarts[run]; k < runs.ownerStarts[run + 1]; ++k)
      claimed(ranksByRound, round, runs.owners[k]).push(run);
    const seen = new Set<number>();
    for (let k = 0; k < runs.runLengths[run]; ++k, ++entry) {
      if (entry >= indices.length)
        throw new Error(
          `${what}: a run-grouped return needs its runs to cover the list, ` +
            `given runs running past ${entryCount(indices.length)}`,
        );
      const index = indices[entry];
      if (seen.has(index))
        throw partnerProtocolError(
          participantId,
          `${what} names one partner row twice for one record this side ` +
            "matched",
        );
      seen.add(index);
      claimed(claimantsByRound, round, index).push(run);
    }
  }
  if (entry !== indices.length)
    throw new Error(
      `${what}: a run-grouped return needs its runs to cover the list, given ` +
        `runs totalling ${entry} for ${entryCount(indices.length)}`,
    );

  const rowsOfRank = new Map<number, Map<number, Array<number>>>();
  for (const [round, byRank] of ranksByRound) {
    const rowsByClaimants = new Map<string, Array<number>>();
    for (const [row, claimants] of claimantsByRound.get(round) ?? []) {
      const key = claimantKey(claimants);
      const rows = rowsByClaimants.get(key);
      if (rows === undefined) rowsByClaimants.set(key, [row]);
      else rows.push(row);
    }
    const accepted = new Set<string>();
    for (const claimants of byRank.values())
      accepted.add(claimantKey(claimants));
    for (const key of rowsByClaimants.keys())
      if (!accepted.has(key))
        throw partnerProtocolError(
          participantId,
          `${what} names one partner row for a set of this side's records ` +
            "the round did not accept together",
        );
    const byRankRows = new Map<number, Array<number>>();
    for (const [rank, claimants] of byRank) {
      const rows = rowsByClaimants.get(claimantKey(claimants));
      if (rows === undefined)
        throw partnerProtocolError(
          participantId,
          `${what} leaves a group of the partner's records this side matched ` +
            "without a row",
        );
      byRankRows.set(
        rank,
        [...rows].sort((a, b) => a - b),
      );
    }
    rowsOfRank.set(round, byRankRows);
  }

  return rowsOfRank;
}

// Neither grouped rule is offered here: each replaces distinctness with a
// rule read against a grouping, which says nothing about a list's length,
// where this form needs one half's length pinned before it holds the other
// to it. A call site whose table admits a GROUPED repeat therefore checks
// its halves itself, against a count it computed, rather than through this
// form.
/** One half of a partner-supplied association table, with what bounds it. */
interface PartnerIndexTableHalf extends Omit<
  PartnerIndexRules,
  "repeatsGroupedBy"
> {
  /** Names the half, for the error message. */
  what: string;
  /** The partner-supplied entries, in received order. */
  indices: ReadonlyArray<number>;
  /** The count of slots this half addresses. See {@link assertPartnerIndices}. */
  exclusiveBound: number;
}

/**
 * The half a two-half check anchors on: the one that keeps its distinctness, and
 * so cannot admit repeats. See {@link assertPartnerIndexTable}.
 */
type PartnerIndexTableAnchorHalf = Omit<PartnerIndexTableHalf, "repeats">;

/**
 * Requires both halves of a partner-supplied association table to hold whole,
 * in-range indices and to pair up, one entry of each half per matched pair.
 *
 * The halves are checked in this order for a reason the callers cannot
 * enforce themselves: the pairing is expressed as the second half having as
 * many entries as the first, and that expected count is only a quantity
 * this party holds once the first half has been range-checked -- which
 * caps its length at `anchorHalf.exclusiveBound`, distinctness being what
 * makes a longer list impossible. Running the halves through this one
 * entry point keeps the order out of the callers' hands.
 *
 * Which half anchors is therefore whichever one keeps its distinctness.
 * That is the half addressing this party's own rows for a table with one
 * entry per matched record; under a deduplicating cardinality it is the
 * half naming the MANY side's rows, whichever party those belong to, since
 * the "one" side's rows are what a group of them repeats
 * (docs/spec/PROTOCOL.md, Deriving one table from the exchanged
 * association maps). Either bound is a quantity this party holds
 * independently of the frame -- one of its own counts, or a record count
 * held on the authenticated terms exchange.
 *
 * Either half may additionally have the {@link PartnerIndexRules} a call
 * site's own table has to satisfy, applied to that half alone.
 *
 * @param participantId - This party's participant id.
 * @param anchorHalf - The distinct half, whose range-checked length pins the
 *   other's.
 * @param pairedHalf - The half held to that length, which may admit repeats.
 * @throws A `"protocol"` {@link ConnectionError} on a bad entry in either half,
 *   on halves of unequal length, or on a half breaking a rule it declared.
 */
export function assertPartnerIndexTable(
  participantId: string,
  anchorHalf: PartnerIndexTableAnchorHalf,
  pairedHalf: PartnerIndexTableHalf,
): void {
  assertPartnerIndices(
    participantId,
    anchorHalf.what,
    anchorHalf.indices,
    anchorHalf.exclusiveBound,
    { ascending: anchorHalf.ascending },
  );
  assertPartnerIndexCount(
    participantId,
    pairedHalf.what,
    pairedHalf.indices.length,
    anchorHalf.indices.length,
  );
  assertPartnerIndices(
    participantId,
    pairedHalf.what,
    pairedHalf.indices,
    pairedHalf.exclusiveBound,
    { ascending: pairedHalf.ascending, repeats: pairedHalf.repeats },
  );
}
