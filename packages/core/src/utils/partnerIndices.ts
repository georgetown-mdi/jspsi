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
 * this party's own outbound entry at that position named -- a key round, and a
 * position within the partner's candidate set for that round.
 *
 * Both arrays run parallel to the list under check and hold state this party
 * computed and sent, never anything read from the frame under check. A caller
 * whose transport may hand the partner the sent objects themselves rather than a
 * serialization of them copies the two out before sending.
 */
export interface PartnerIndexGrouping {
  /** The key round each entry's outbound counterpart named. */
  readonly rounds: ArrayLike<number>;
  /** The partner candidate-set position it named within that round. */
  readonly positions: ArrayLike<number>;
}

/**
 * The grouping a list of RUNS is required to be injective modulo: what each of
 * this party's own outbound entries named, plus how many consecutive entries of
 * the list under check answer it.
 *
 * The three arrays run parallel to ONE ANOTHER, one element per outbound entry
 * this party sent, and the list under check is the concatenation of those runs in
 * that order. Every one of them holds state this party computed -- the (round,
 * position) it sent, and a count it accumulated from a frame already checked --
 * never anything read from the frame under check.
 */
interface PartnerIndexRunGrouping extends PartnerIndexGrouping {
  /**
   * How many consecutive entries of the list answer each outbound entry. Two
   * outbound entries this party grouped together have the same length, both
   * being the size of the one partner group behind the position they named.
   */
  readonly runLengths: ArrayLike<number>;
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
   * Admit a repeated entry between RUNS this party itself grouped together:
   * the cascade's returned mapped-element list where BOTH parties keep
   * their within-dataset duplicates, so one outbound entry of this party's
   * comes back as the whole partner group behind the position it named
   * rather than as one row (docs/spec/PROTOCOL.md, Deriving one table from
   * the exchanged association maps).
   *
   * What {@link repeatsGroupedBy} becomes once the partner has multiplicity
   * too, buying the same guarantee: two outbound entries that named ONE
   * (round, position) must come back with identical runs, element for
   * element and in order, and entries that named DIFFERENT positions must
   * come back with disjoint runs, so the partner can neither merge two of
   * this party's groups nor split one. Distinctness survives within a run:
   * a row named twice for one of this party's records is a repeated pair no
   * consumer can read.
   *
   * Distinctness is also what otherwise caps a list's LENGTH at
   * `exclusiveBound`, so a caller setting this must pin the length against
   * a locally computed count first ({@link assertPartnerIndexCount}) -- the
   * same count the run lengths sum to. The three rules here are
   * alternatives; setting more than one is a caller fault.
   */
  repeatsGroupedByRuns?: PartnerIndexRunGrouping;
  /**
   * Admit a repeated entry with NO grouping to hold it to: the half of a
   * resolved association table naming the "one" side's rows under a
   * deduplicating cardinality, where several of the MANY side's records
   * link to one of them and the resolver -- not this party -- computed the
   * pairing (docs/spec/PROTOCOL.md, Deriving one table from the exchanged
   * association maps). There is no counterpart grouping to check against at
   * that call site, which is what separates this from
   * {@link repeatsGroupedBy}; the three relaxations here are alternatives
   * and setting more than one is a caller fault.
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

// Where the group of each run first appears in the list, or -1 for the run
// that IS that first appearance -- resolved before any entry is read so a
// later run is compared against its group's first element for element
// without ever reading past it. Two runs of one group have the same length
// by construction, both being the size of the partner group behind the one
// position they named; a caller breaking that, or handing over runs that do
// not cover the list it pinned, is stopped here rather than left comparing
// misaligned entries.
function resolveRunGroups(
  what: string,
  runs: PartnerIndexRunGrouping,
  listLength: number,
): { runLengths: ArrayLike<number>; firstStarts: Int32Array } {
  const runCount = runs.runLengths.length;
  const firstStarts = new Int32Array(runCount);
  const firstRunByGroup = new Map<number, Map<number, [number, number]>>();
  let covered = 0;
  for (let run = 0; run < runCount; ++run) {
    const length = runs.runLengths[run];
    if (!Number.isInteger(length) || length < 0)
      throw new Error(
        `${what}: a run-grouped index check needs a whole, non-negative length ` +
          "for every run",
      );
    const round = runs.rounds[run];
    let byPosition = firstRunByGroup.get(round);
    if (byPosition === undefined) {
      byPosition = new Map<number, [number, number]>();
      firstRunByGroup.set(round, byPosition);
    }
    const position = runs.positions[run];
    const first = byPosition.get(position);
    if (first === undefined) {
      firstStarts[run] = -1;
      byPosition.set(position, [covered, length]);
    } else {
      if (first[1] !== length)
        throw new Error(
          `${what}: a run-grouped index check needs one run length per position ` +
            `this side matched, given ${first[1]} and ${length} for one position`,
        );
      firstStarts[run] = first[0];
    }
    covered += length;
  }
  if (covered !== listLength)
    throw new Error(
      `${what}: a run-grouped index check needs its runs to cover the list, ` +
        `given runs totalling ${covered} for ${entryCount(listLength)}`,
    );
  return { runLengths: runs.runLengths, firstStarts };
}

/**
 * Requires every entry of a partner-supplied index list to be a whole number in
 * `[0, exclusiveBound)`, with no entry repeated.
 *
 * Distinctness is the protocol invariant on all three matching paths --
 * one-to-one matching pairs each row at most once -- and it is what caps
 * the list's LENGTH at `exclusiveBound`, since a longer list cannot hold
 * distinct in-range entries. The length is therefore not a separate
 * argument, except under the three rules that relax distinctness --
 * `rules.repeatsGroupedBy`, which replaces it with injectivity modulo the
 * grouping it holds, `rules.repeatsGroupedByRuns`, which does the same for
 * a list whose entries answer that grouping in runs, and `rules.repeats`,
 * which drops it for a half whose multiplicity the partner's own side
 * holds -- each leaving the length to the caller's own count check.
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
 *   breaking the grouping under `rules.repeatsGroupedBy` or a run breaking it
 *   under `rules.repeatsGroupedByRuns`.
 */
export function assertPartnerIndices(
  participantId: string,
  what: string,
  indices: ReadonlyArray<number>,
  exclusiveBound: number,
  rules: PartnerIndexRules = {},
): void {
  const grouping = rules.repeatsGroupedBy;
  const runs = rules.repeatsGroupedByRuns;
  if (
    grouping !== undefined &&
    (grouping.rounds.length !== indices.length ||
      grouping.positions.length !== indices.length)
  )
    throw new Error(
      `${what}: a grouped index check needs one group per entry, given ` +
        `${grouping.rounds.length} round(s) and ${grouping.positions.length} ` +
        `position(s) for ${entryCount(indices.length)}`,
    );
  if (
    runs !== undefined &&
    (runs.rounds.length !== runs.runLengths.length ||
      runs.positions.length !== runs.runLengths.length)
  )
    throw new Error(
      `${what}: a run-grouped index check needs one group per run, given ` +
        `${runs.rounds.length} round(s) and ${runs.positions.length} ` +
        `position(s) for ${runs.runLengths.length} run(s)`,
    );
  const relaxations =
    (grouping !== undefined ? 1 : 0) +
    (runs !== undefined ? 1 : 0) +
    (rules.repeats === true ? 1 : 0);
  if (relaxations > 1)
    throw new Error(
      `${what}: each rule that relaxes distinctness holds every repeat to a ` +
        "different thing, so at most one of them applies to a list",
    );
  const runGroups =
    runs === undefined
      ? undefined
      : resolveRunGroups(what, runs, indices.length);
  // Distinctness is what caps the length; the three rules that relax it leave the
  // cap to the caller's own count check (see PartnerIndexRules).
  const distinct =
    grouping === undefined && runs === undefined && rules.repeats !== true;
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
  // Which index each group has taken so far, by round and then by
  // position. Only the first entry of a group consults the repeat
  // detector, so a legitimate repeat within one group is never treated as
  // one across groups.
  const indexByGroup = new Map<number, Map<number, number>>();
  let previous = -1;
  // The run form walks the list run by run, at the lengths the caller
  // pinned it to: `run` is the run the entry at hand falls in and
  // `runStart` where that run begins. A zero-length run has no entry and
  // is stepped over.
  let run = -1;
  let runStart = 0;
  let runEnd = 0;
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
    if (runGroups) {
      while (entry === runEnd) {
        ++run;
        runStart = entry;
        runEnd = entry + runGroups.runLengths[run];
      }
      const firstStart = runGroups.firstStarts[run];
      if (firstStart < 0) {
        // The first run of its group holds the whole of the distinctness
        // the rule keeps: its own entries differ from each other, this
        // side's records taking one partner row once each, and from every
        // other group's.
        if (repeats(index))
          throw partnerProtocolError(
            participantId,
            entry > runStart &&
              indices.lastIndexOf(index, entry - 1) >= runStart
              ? `${what} names one partner row twice for one record this side ` +
                  "matched"
              : `${what} names one partner row for two positions this side ` +
                  "matched",
          );
      } else if (indices[firstStart + (entry - runStart)] !== index)
        throw partnerProtocolError(
          participantId,
          `${what} names two partner rows for one position this side matched`,
        );
    } else if (grouping) {
      const round = grouping.rounds[entry];
      let indexByPosition = indexByGroup.get(round);
      if (indexByPosition === undefined) {
        indexByPosition = new Map<number, number>();
        indexByGroup.set(round, indexByPosition);
      }
      const position = grouping.positions[entry];
      const taken = indexByPosition.get(position);
      if (taken === undefined) {
        if (repeats(index))
          throw partnerProtocolError(
            participantId,
            `${what} names one partner row for two positions this side matched`,
          );
        indexByPosition.set(position, index);
      } else if (taken !== index)
        throw partnerProtocolError(
          participantId,
          `${what} names two partner rows for one position this side matched`,
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

// Neither grouped rule is offered here: each replaces distinctness with a
// rule read against a grouping, which says nothing about a list's length,
// where this form needs one half's length pinned before it holds the other
// to it. A call site whose table admits a GROUPED repeat therefore checks
// its halves itself, against a count it computed, rather than through this
// form.
/** One half of a partner-supplied association table, with what bounds it. */
interface PartnerIndexTableHalf extends Omit<
  PartnerIndexRules,
  "repeatsGroupedBy" | "repeatsGroupedByRuns"
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
