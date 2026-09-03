import { associationTableMessage, type PSIParticipant } from "./participant";
import type { AssociationTable } from "./types";
import {
  receiveParsed,
  parseOrProtocolError,
  type MessageConnection,
} from "./connection/messageConnection";
import {
  MAX_SINGLE_PASS_CELLS,
  partyFansOut,
  singlePassCeilingBreach,
  singlePassReplyByteCap,
  valueSlots,
  type SinglePassCeilingBreach,
  type SinglePassPartySize,
} from "./connection/frameSize";
import { assertBlockDiagonalClosure } from "./entityClosure";
import { FAN_OUT_CANDIDATES_PER_ELEMENT } from "./fanOutFunctions";
import {
  fanOutReachedMatchingRefusal,
  type KeyCandidates,
} from "./standardization";
import { singleIssueArray } from "./utils/singleIssueArray";
import {
  assertPartnerIndexCount,
  assertPartnerIndices,
  assertPartnerIndexTable,
  partnerProtocolError,
  type PartnerIndexGrouping,
  type PartnerIndexRules,
} from "./utils/partnerIndices";
import {
  COUNT_ONLY_SHAPE_REFUSALS,
  manyToManyIsImplementedForStrategy,
} from "./config/linkageTerms";
import { InternalConsistencyError, UsageError } from "./errors";
import { receiveCountReport, sendCountReport } from "./protocolSetup";

import { getLoggerForVerbosity } from "./utils/logger";

interface IndexIterationPair {
  theirIndex: number;
  iteration: number;
}

// Parsed as the whole received message (the root array). With no enclosing
// array/record/tuple frame above the root, a pathological count cannot drive the
// ~130k STACK overflow the nested collections face (see participant.ts
// associationTableMessage and config/linkageTerms.ts) -- but a far larger count
// (~millions of invalid elements, within the frame cap) makes Zod throw a
// DIFFERENT RangeError ("Invalid string length", ~3.5M on Zod 4.4.3) building its
// error string from one issue per element. The single-issue validator caps issue
// accumulation at one regardless of count (utils/singleIssueArray.ts), so a
// pathological frame fails as a clean bounded rejection; a count `.max()` is not
// an option because the legitimate count -- the matched intersection -- is in the
// millions, bounded only by MAX_FRAME_SIZE_BYTES. The predicate mirrors
// `z.object({ theirIndex: z.number(), iteration: z.number() })` for acceptance:
// a non-null, non-array object (z.object rejects an array outright, even one
// carrying theirIndex/iteration own-properties) with a finite value at each field
// (Number.isFinite, like z.number()). Unlike that object schema it does not strip
// unknown keys, which is immaterial -- a legitimate partner sends exactly these
// two keys, and only theirIndex/iteration are ever read. This array is read both
// via receiveParsed (sendFirst, below) and via a direct `.parse()` (the
// !sendFirst send-before-parse path, wrapped in parseOrProtocolError) so either
// way a malformed frame surfaces a clean ConnectionError("protocol").
/** @internal exported for the pathological-count wire-message test. */
export const associationAndIterationArray =
  singleIssueArray<IndexIterationPair>(
    (value) =>
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Number.isFinite((value as Record<string, unknown>).theirIndex) &&
      Number.isFinite((value as Record<string, unknown>).iteration),
    "must be an array of {theirIndex, iteration} finite-number pairs",
  );

type IndexIterationMap = Array<IndexIterationPair | undefined>;
type IterationMap = Array<IndexIterationPair>;

export interface IndexableIterable<T> extends Iterable<T> {
  [index: number]: T | undefined;
}

// The cascade and the count-only round run one value per record, so a record
// carrying several candidates has no round to enter: it is refused where it would
// be consumed rather than narrowed to one candidate or dropped from the round,
// either of which matches on less than the terms declare. Key realization carries
// the whole candidate set (buildKeyStrings), so this is the single point those two
// strategies read a record's value through. Single-pass, the one strategy fan-out
// matching is specified for, consumes the set instead (docs/spec/PROTOCOL.md,
// Fan-out matching).
function requireSingleCandidate(value: KeyCandidates): string | undefined {
  if (value === undefined || typeof value === "string") return value;
  throw fanOutReachedMatchingRefusal();
}

function getUnidentifiedIndices(
  indexIterationMap: IndexIterationMap,
): Array<number> {
  return indexIterationMap.reduce((acc, x, i) => {
    if (!x) acc.push(i);
    return acc;
  }, [] as Array<number>);
}

// Maps each value occurring exactly once in valueAt(0..count-1) to its index.
// The result's insertion order follows the order values appear in valueAt --
// callers rely on this to build identical outputs. Undefined values are ignored.
//
// Keeps one map of first-seen indices plus a set of the values that recur, rather
// than three maps: in the near-unique case no value recurs, so the set stays empty
// and the first-index map IS the answer, returned without a copy. When some values
// recur, the recurring ones are deleted from the map; Map iteration is insertion
// order and delete preserves the order of the survivors, so the first-appearance
// order callers depend on is unchanged. This trims psilink's own per-key
// reconstruction churn; it is a minor slice of the
// single-pass receiver's transient peak, which is dominated by the per-element
// JS<->native boundary marshalling that the GC relief in linkViaSinglePassPSI
// collects.
function reduceToSingletons<T>(
  count: number,
  valueAt: (index: number) => T | undefined,
): Map<T, number> {
  const firstIndex = new Map<T, number>();
  const recurring = new Set<T>();
  for (let i = 0; i < count; ++i) {
    const value = valueAt(i);
    if (value === undefined) continue;
    if (firstIndex.has(value)) recurring.add(value);
    else firstIndex.set(value, i);
  }
  for (const value of recurring) firstIndex.delete(value);
  return firstIndex;
}

// Adapts reduceToSingletons for the cascade: undefined means "no value for this
// key" (but "" is a real value, kept). `permutation` maps a survivor's index back
// to its original row when the input is a carried-forward subset of a later round.
// See docs/spec/PROTOCOL.md (Key input data).
/** @internal */
export function removeDuplicatesAndUndefineds(
  dataWithDuplicatesAndUndefineds: Array<string | undefined>,
  permutation?: Array<number>,
): [Array<string>, Array<number>] {
  const singletons = reduceToSingletons<string>(
    dataWithDuplicatesAndUndefineds.length,
    (i) => dataWithDuplicatesAndUndefineds[i],
  );
  const data: Array<string> = [];
  const originalIndices: Array<number> = [];
  for (const [value, i] of singletons) {
    data.push(value);
    originalIndices.push(permutation ? permutation[i] : i);
  }
  return [data, originalIndices];
}

/**
 * One round's `(record, value)` incidence for this party, as the round's PSI set
 * addresses it: position `k` of the set stands for the local rows listed at
 * `rows[groupStarts[k] .. groupStarts[k + 1])`, ascending.
 *
 * `groupStarts` is absent where every position stands for exactly one row -- the
 * within-round uniqueness rule a non-deduplicating party applies, which drops a
 * value two or more of its rows hold -- so that party keeps the flat
 * row-per-position array and allocates nothing extra. A deduplicating ("many")
 * party keeps such a value, contributing it once and standing it for the group of
 * rows holding it (docs/spec/PROTOCOL.md, Matching multiplicity: the (record,
 * value) incidence).
 *
 * @internal exported for the round-construction tests.
 */
export interface RoundCandidates {
  readonly rows: Array<number>;
  readonly groupStarts?: Array<number>;
}

/** @internal how many positions this round's PSI set carries. */
export function candidatePositionCount(candidates: RoundCandidates): number {
  return candidates.groupStarts
    ? candidates.groupStarts.length - 1
    : candidates.rows.length;
}

// The half-open slice of `rows` that position `position` stands for. Without
// groups a position IS its row, so the slice is the one-element `[k, k + 1)` and
// the two layouts read through one loop.
function positionRowRange(
  candidates: RoundCandidates,
  position: number,
): [number, number] {
  return candidates.groupStarts
    ? [candidates.groupStarts[position], candidates.groupStarts[position + 1]]
    : [position, position + 1];
}

/**
 * The deduplicating counterpart of {@link removeDuplicatesAndUndefineds}: a value
 * several of this party's records hold stays in the round and stands for the GROUP
 * of those records, rather than being dropped as ambiguous.
 *
 * The set carries each DISTINCT value once, so it is bounded by this party's row
 * count exactly as a non-deduplicating party's is and no derived frame or dataset
 * bound moves; the multiplicity is re-expanded locally when a match comes back
 * (docs/spec/PROTOCOL.md, The per-side rules). Values appear in first-occurrence
 * order and each group's rows ascend, which is what makes the expansion ordering
 * both parties reconstruct from reproducible.
 *
 * @internal exported for the round-construction tests.
 */
export function groupDuplicatesAndRemoveUndefineds(
  dataWithDuplicatesAndUndefineds: Array<string | undefined>,
  permutation?: Array<number>,
): [Array<string>, RoundCandidates] {
  const positionOf = new Map<string, number>();
  const data: Array<string> = [];
  const rowsByPosition: Array<Array<number>> = [];
  for (let i = 0; i < dataWithDuplicatesAndUndefineds.length; ++i) {
    const value = dataWithDuplicatesAndUndefineds[i];
    if (value === undefined) continue;
    let position = positionOf.get(value);
    if (position === undefined) {
      position = data.length;
      positionOf.set(value, position);
      data.push(value);
      rowsByPosition.push([]);
    }
    rowsByPosition[position].push(permutation ? permutation[i] : i);
  }
  const rows: Array<number> = [];
  const groupStarts: Array<number> = new Array(rowsByPosition.length + 1);
  groupStarts[0] = 0;
  for (let position = 0; position < rowsByPosition.length; ++position) {
    for (const row of rowsByPosition[position]) rows.push(row);
    groupStarts[position + 1] = rows.length;
  }
  return [data, { rows, groupStarts }];
}

// The (round, partner position) each entry of this party's own outbound
// mapped-element list names, copied out of the list BEFORE it is sent. The
// returned list is checked against this grouping, and it has to be the grouping
// this party sent: a transport that hands the partner the array itself rather than
// a serialization of it leaves the partner's own in-place translation
// (`e.theirIndex = i`, below) writing over these entries.
function sentGrouping(sent: IterationMap): PartnerIndexGrouping {
  return {
    rounds: Float64Array.from(sent, (e) => e.iteration),
    positions: Float64Array.from(sent, (e) => e.theirIndex),
  };
}

// One label per matched record of this party, equal exactly for the records that
// named one (round, position) -- the block of a single matched value. Read off the
// grouping copied out before the send rather than off the list itself, so the
// derivation rests on this party's own record of what it sent rather than on
// objects a transport may hand both sides by reference. That is hygiene keeping the
// derivation self-contained rather than a defence this path needs: the in-place
// translation that overwrites a received list (`e.theirIndex = i`, below) is the
// branch a side keeping no duplicates takes, and a label is derived only where both
// sides keep theirs.
function blockLabels(groups: PartnerIndexGrouping): Int32Array {
  const labels = new Int32Array(groups.rounds.length);
  const positionsByRound = new Map<number, Map<number, number>>();
  let next = 0;
  for (let i = 0; i < labels.length; ++i) {
    let byPosition = positionsByRound.get(groups.rounds[i]);
    if (byPosition === undefined) {
      byPosition = new Map();
      positionsByRound.set(groups.rounds[i], byPosition);
    }
    let label = byPosition.get(groups.positions[i]);
    if (label === undefined) {
      label = next++;
      byPosition.set(groups.positions[i], label);
    }
    labels[i] = label;
  }
  return labels;
}

// The rule this party's own returned mapped-element list is held to. There is one
// rule -- injectivity modulo the grouping this party sent -- read at whichever
// granularity the partner returns: entry for entry where the partner takes one row
// per position it was named, and run for run where it keeps its own duplicates and
// returns the whole group behind that position. A party that sent no grouping keeps
// flat distinctness. `matchedRows` runs parallel to the sent list, so the tally it
// reads gives one run length per outbound entry.
function returnedListRules(
  sentGroups: PartnerIndexGrouping | undefined,
  returnedEntriesPerRecord: Int32Array | undefined,
  matchedRows: ReadonlyArray<number>,
): PartnerIndexRules {
  if (sentGroups === undefined) return {};
  if (returnedEntriesPerRecord === undefined)
    return { repeatsGroupedBy: sentGroups };
  return {
    repeatsGroupedByRuns: {
      rounds: sentGroups.rounds,
      positions: sentGroups.positions,
      runLengths: Int32Array.from(
        matchedRows,
        (row) => returnedEntriesPerRecord[row],
      ),
    },
  };
}

/**
 * The matching cardinality ONE party runs, as that party resolves it from the two
 * agreed `deduplicate` settings (`resolveLinkageCardinality`, exchange.ts).
 *
 * The label is read from the resolving party's own side, so the two parties of one
 * deduplicating exchange hold mirror labels for the single mirrored procedure they
 * run: the declaring "many" party resolves `many-to-one` and its partner
 * `one-to-many` (docs/spec/PROTOCOL.md, Deduplicating cardinalities).
 */
export type LinkageCardinality =
  "one-to-one" | "one-to-many" | "many-to-one" | "many-to-many";

// Which side of a round's (record, value) incidence keeps its within-dataset
// duplicate values, read off this party's own resolved label. Both sides' rules
// are derived from that one label, so each party knows what its partner's frames
// carry without a second exchanged term and the lockstep rounds cannot diverge.
interface MultiplicitySides {
  readonly localKeepsDuplicates: boolean;
  readonly partnerKeepsDuplicates: boolean;
}

// Exhaustive over the union with no default, so a cardinality added to the label
// set fails to compile here rather than resolving to a side rule by omission.
function multiplicitySides(cardinality: LinkageCardinality): MultiplicitySides {
  switch (cardinality) {
    case "one-to-one":
      return { localKeepsDuplicates: false, partnerKeepsDuplicates: false };
    case "many-to-one":
      return { localKeepsDuplicates: true, partnerKeepsDuplicates: false };
    case "one-to-many":
      return { localKeepsDuplicates: false, partnerKeepsDuplicates: true };
    case "many-to-many":
      return { localKeepsDuplicates: true, partnerKeepsDuplicates: true };
  }
}

// Which cardinalities the single-pass strategy resolves. Its seam hands the whole
// resolved table to the sender, and the sender holds it to a length taken from the
// half that keeps its distinctness (assertPartnerIndexTable, utils/partnerIndices.ts);
// under a both-sided multiplicity neither half keeps it and the sender holds no
// local bound on the table's size, so the pair is refused rather than paired.
// Exhaustive for the same reason as above.
//
// The both-sided verdict is READ from the strategy table the agreed-terms refusal
// reads (config/linkageTerms.ts) rather than restated here, so this fail-closed
// half and that boundary cannot drift apart: a strategy entry that starts saying
// it pairs the cardinality stops being refused at both points at once.
function singlePassResolves(cardinality: LinkageCardinality): boolean {
  switch (cardinality) {
    case "one-to-one":
    case "many-to-one":
    case "one-to-many":
      return true;
    case "many-to-many":
      return manyToManyIsImplementedForStrategy("single-pass");
  }
}

/**
 * The round matches a "many" party attributes to its rows: its own matched
 * position mapped to the partner position it paired with.
 *
 * A position the intersection names MORE THAN ONCE is a value two or more of the
 * PARTNER's records hold. The "one" side's own within-round uniqueness rule would
 * have dropped that value before the round; where the "one" side does not apply it
 * -- the variant in which one party contributes its whole dataset each round and
 * the other resolves -- the "many" party applies it on the partner's behalf and
 * drops the value from the round, so the exchange cannot silently deliver the
 * `many-to-many` multiplicity neither party's terms declared (docs/spec/PROTOCOL.md,
 * Deriving one table from the exchanged association maps). The dropped group's rows
 * are attributed nothing and stay eligible for later keys, exactly as a value this
 * party dropped itself: this drop is the one carve-out from the rule that a record
 * appearing in a round's candidate pairs leaves candidacy after it
 * (docs/spec/PROTOCOL.md, Multiplicity is within-round).
 *
 * This party's own set carries each value once, so a repeat can only come from the
 * partner's. On the starter role the round's own association-table check refuses
 * such a table upstream (a repeated index in either half, `identifyIntersection`);
 * on the joiner role the local half is this party's own computation and reaches
 * here instead, which is the path a partner that does not deduplicate takes.
 *
 * @internal exported for the single-resolver-obligation test.
 */
export function attributableRoundMatches(
  myIndices: ReadonlyArray<number>,
  theirIndices: ReadonlyArray<number>,
): Map<number, number> {
  const partnerPositionOf = new Map<number, number>();
  const ambiguous = new Set<number>();
  for (let ii = 0; ii < myIndices.length; ++ii) {
    const position = myIndices[ii];
    if (partnerPositionOf.has(position)) ambiguous.add(position);
    else partnerPositionOf.set(position, theirIndices[ii]);
  }
  for (const position of ambiguous) partnerPositionOf.delete(position);
  return partnerPositionOf;
}

/**
 * Runs the PSI linkage protocol over one or more linkage keys and returns the
 * matched row indices.
 *
 * Keys are tried in order. Records matched on key `j` are excluded from all
 * subsequent key rounds, so each record appears in the result at most once.
 * Within a given key round, records whose key value is duplicated across the
 * local dataset are excluded from that round entirely (ambiguous matches cannot
 * be attributed to a single record). They may still match on a later key.
 *
 * Under `"one-to-one"` both parties' locally-duplicated key values are excluded
 * from each round, so no record matches more than one of the partner's. Under a
 * deduplicating cardinality the "many" side instead KEEPS such a value,
 * contributing it once and attributing a match on it to every one of its records
 * holding it, while the "one" side's rule is unchanged; the label is this party's
 * own, so a `"many-to-one"` party's partner runs `"one-to-many"` and the two
 * mirror one procedure (docs/spec/PROTOCOL.md, Deduplicating cardinalities). Under
 * `"many-to-many"` both parties apply the "many" rule, so a matched value stands
 * for a group on each side and the pair set it contributes is the two groups'
 * product. The entity closure that resolves such a table is a local step over the
 * returned table rather than part of the pairing
 * ({@link ./entityClosure.entityClusters}), and the table this returns is held to
 * the block shape that closure rests on before it leaves here
 * ({@link ./entityClosure.assertBlockDiagonalClosure}). exchange.ts resolves the
 * cardinality from the two agreed `deduplicate` settings, so an exchange whose
 * parties both declare it reaches this strategy with that label.
 *
 * @param protocol - Exchange protocol settings; only `cardinality` is used
 *   here, and it is this party's own resolved label (see
 *   {@link LinkageCardinality}).
 * @param participant - Must have a resolved role (`"starter"` or `"joiner"`);
 *   throws if `role` is still `"either"`.
 * @param conn - Open connection to the exchange partner.
 * @param data - One entry per linkage key. Each entry is an iterable over all
 *   local records (indexed by row position) yielding the record's value for
 *   that key, or `undefined` if the record has no value for it. A record
 *   yielding a candidate SET is refused rather than matched on one of them:
 *   fan-out matching runs under single-pass only (docs/spec/PROTOCOL.md, Fan-out
 *   matching).
 * @param partnerRecordCount - The partner's raw row count, exchanged over the
 *   encrypted channel during role resolution. It is the authenticated bound the
 *   partner-returned row indices are checked against before they reach the
 *   returned table (see utils/partnerIndices.ts).
 * @param verbosity - Log verbosity level (default 0).
 * @param setStage - Optional callback invoked with a progress label at each
 *   key round.
 * @returns An {@link AssociationTable} whose first element (`[0]`) contains
 *   the local matched row indices in ascending order, and whose second element
 *   (`[1]`) contains the corresponding partner row indices in the same pairing
 *   order. The local half is STRICTLY ascending except where the PARTNER keeps its
 *   within-dataset duplicates -- `"one-to-many"` and `"many-to-many"` -- several
 *   of its rows then linking to one of this party's, which makes the half
 *   non-decreasing instead (docs/spec/PROTOCOL.md, Deriving one table from the
 *   exchanged association maps).
 */
export async function linkViaPSI(
  protocol: {
    cardinality: LinkageCardinality;
  },
  participant: PSIParticipant,
  conn: MessageConnection,
  data: Array<IndexableIterable<KeyCandidates>>,
  partnerRecordCount: number,
  verbosity: number = 0,
  setStage?: (id: string) => void,
) {
  if (participant.config.role === "either")
    throw new Error("participants role is unresolved");
  const sendFirst = participant.config.role === "starter";

  const log = getLoggerForVerbosity("psiLink", verbosity);
  setStage = setStage ?? (() => {});

  log.debug(`${participant.id}: linking using ${data.length} key(s) via PSI`);

  const sides = multiplicitySides(protocol.cardinality);
  let indexIterationMap: IndexIterationMap = [];
  const candidatesByIter: Array<RoundCandidates> = [];
  // The count of POSITIONS this party matched, which the count of matched
  // RECORDS below exceeds only on the "many" side, where one position stands for
  // a group. It is what a list arriving from the "one" side is held to, that side
  // naming each matched position exactly once.
  let numMatchedPositions = 0;

  for (let j = 0; j < data.length; ++j) {
    setStage(`stage ${j + 1} / ${data.length}`);
    let dataWithDuplicatesAndUndefineds: Array<string | undefined>;
    let unidentifiedIndices: Array<number> | undefined;
    if (j === 0) {
      dataWithDuplicatesAndUndefineds = Array.from(
        data[j],
        requireSingleCandidate,
      );
      indexIterationMap = Array(dataWithDuplicatesAndUndefineds.length).fill(
        undefined,
      );
      log.debug(`${participant.id}: ${indexIterationMap.length} total records`);
    } else {
      unidentifiedIndices = getUnidentifiedIndices(indexIterationMap);
      dataWithDuplicatesAndUndefineds = unidentifiedIndices.map((i) => {
        return requireSingleCandidate(data[j][i]);
      });
    }
    // The within-round rule this party applies to its own values, which is the
    // whole of the per-side difference a deduplicating cardinality makes to the
    // round: the "many" side keeps a value several of its records hold and
    // stands the round position for that group, every other party drops it.
    let data_j: Array<string>;
    let candidates: RoundCandidates;
    if (sides.localKeepsDuplicates) {
      [data_j, candidates] = groupDuplicatesAndRemoveUndefineds(
        dataWithDuplicatesAndUndefineds,
        unidentifiedIndices,
      );
    } else {
      const [values, rows] = removeDuplicatesAndUndefineds(
        dataWithDuplicatesAndUndefineds,
        unidentifiedIndices,
      );
      data_j = values;
      candidates = { rows };
    }
    candidatesByIter.push(candidates);

    log.debug(
      `${participant.id}: key ${j + 1}/${data.length}: ${data_j.length} ` +
        "unique value(s) " +
        `${j > 0 ? ` (${unidentifiedIndices!.length} unmatched)` : ""}`,
    );

    // Run a PSI round for every agreed key, even when data_j is empty. The
    // key set is fixed by the linkage terms so both parties loop the same
    // keys, but data_j is derived from local data and can be empty on only
    // one side; skipping that round drops a send/receive the partner still
    // performs and desyncs the lockstep exchange. The PSI library returns an
    // empty intersection for empty input, so the round is a correct no-op.
    log.debug(
      `${participant.id}: running psi on key ${j + 1} / ${data.length}:`,
    );
    const [myIndices, theirIndices] = await participant.identifyIntersection(
      conn,
      data_j,
    );

    log.debug(
      `${participant.id}: key ${j + 1}/${data.length}: ${myIndices.length} ` +
        "match(es) found",
    );

    if (sides.localKeepsDuplicates) {
      // A match on a position is attributed to EVERY record in the group behind
      // it, which is the whole of the widening; the group leaves candidacy with
      // it, so multiplicity stays within-round and a later, weaker key cannot add
      // a link onto a group an earlier key formed.
      const attributable = attributableRoundMatches(myIndices, theirIndices);
      numMatchedPositions += attributable.size;
      for (const [position, partnerPosition] of attributable) {
        const [from, to] = positionRowRange(candidates, position);
        for (let r = from; r < to; ++r) {
          indexIterationMap[candidates.rows[r]] = {
            theirIndex: partnerPosition,
            iteration: j,
          };
        }
      }
    } else {
      numMatchedPositions += myIndices.length;
      for (let ii = 0; ii < myIndices.length; ++ii) {
        const i = candidates.rows[myIndices[ii]];

        indexIterationMap[i] = {
          theirIndex: theirIndices[ii],
          iteration: j,
        };
      }
    }
  }

  const [identifiedIndexIterationMap, originalIndices] =
    indexIterationMap.reduce(
      (acc, x, i) => {
        if (x) {
          acc[0].push(x);
          acc[1].push(i);
        }
        return acc;
      },
      [[], []] as [IterationMap, Array<number>],
    );

  const numMappedElements = identifiedIndexIterationMap.length;
  log.debug(
    `${participant.id}: ${numMappedElements}/${indexIterationMap.length} ` +
      "record(s) matched",
  );

  // Held for the returned list's check below, where this party is the "many"
  // side: the pairing its own list named is what that list has to come back
  // carrying, entry for entry or run for run as the partner's own side rules.
  const sentGroups = sides.localKeepsDuplicates
    ? sentGrouping(identifiedIndexIterationMap)
    : undefined;

  log.debug(
    `${participant.id}: sending match map indexed by round, receiving ` +
      "partner's",
  );
  const theirIdentifiedIndexIterationMap = await exchangeMappedElements(
    participant.id,
    conn,
    log,
    sendFirst,
    identifiedIndexIterationMap,
  );

  // Translate the partner's list of our records through the per-round candidate
  // sets, checking each entry against what THIS side matched before it reads a
  // candidate set. A round pairs the same VALUES on both parties, and it pairs
  // our position p only if the partner's corresponding record names p in that
  // same round, which is what makes every entry checkable against local state
  // rather than merely bounded. What the pairing is NOT, once a side
  // deduplicates, is one entry per record on both sides: a list from the "many"
  // side names each of our matched positions once per record in the group behind
  // it, so the count equality is replaced by a coverage rule and a bound taken
  // from the partner's authenticated row count (docs/spec/PROTOCOL.md, Deriving
  // one table from the exchanged association maps).
  if (sides.partnerKeepsDuplicates) {
    if (theirIdentifiedIndexIterationMap.length > partnerRecordCount)
      throw partnerProtocolError(
        participant.id,
        "the partner's mapped-element list carries " +
          `${theirIdentifiedIndexIterationMap.length} entries, more than the ` +
          `${partnerRecordCount} record(s) the partner counted`,
      );
  } else {
    assertPartnerIndexCount(
      participant.id,
      "the partner's mapped-element list",
      theirIdentifiedIndexIterationMap.length,
      numMatchedPositions,
    );
  }
  // Where a position of ours stands for a group, translating an entry EXPANDS it
  // into one entry per record in that group, in ascending record order, with the
  // groups left in the order of the list being translated -- the ordering the
  // originating party reconstructs its own table from. Where it stands for one
  // record the entry is translated in place.
  const expands = sides.localKeepsDuplicates;
  const expanded: IterationMap = [];
  // How many entries of our own returned list belong to each of our matched
  // records: the count of the partner's entries naming the position that record
  // matched, which is the size of the partner group behind it. Only a "many"
  // partner returns more than one, and only then is the tally read. Where a
  // position of ours stands for a group, every record of that group takes the
  // count, since the partner expanded each of their entries alike.
  const returnedEntriesPerRecord = sides.partnerKeepsDuplicates
    ? new Int32Array(indexIterationMap.length)
    : undefined;
  // The total, which is the length our own returned list is held to below: a
  // quantity we accumulate from the list already checked above and our own group
  // sizes, never one read off the frame under check.
  let returnedEntries = 0;
  const named = new Uint8Array(indexIterationMap.length);
  let namedRecords = 0;
  for (const e of theirIdentifiedIndexIterationMap) {
    if (
      !Number.isInteger(e.iteration) ||
      e.iteration < 0 ||
      e.iteration >= candidatesByIter.length
    )
      throw partnerProtocolError(
        participant.id,
        "the partner's mapped-element list names a key round this exchange " +
          "did not run",
      );
    const candidates = candidatesByIter[e.iteration];
    if (
      !Number.isInteger(e.theirIndex) ||
      e.theirIndex < 0 ||
      e.theirIndex >= candidatePositionCount(candidates)
    )
      throw partnerProtocolError(
        participant.id,
        "the partner's mapped-element list names a position outside that " +
          "round's candidate set",
      );
    const [from, to] = positionRowRange(candidates, e.theirIndex);
    const i = candidates.rows[from];
    if (indexIterationMap[i]?.iteration !== e.iteration)
      throw partnerProtocolError(
        participant.id,
        "the partner's mapped-element list names a record this side did not " +
          "match on that round",
      );
    if (named[i] === 1) {
      if (!sides.partnerKeepsDuplicates)
        throw partnerProtocolError(
          participant.id,
          "the partner's mapped-element list names one record twice",
        );
    } else {
      for (let r = from; r < to; ++r) {
        named[candidates.rows[r]] = 1;
        ++namedRecords;
      }
    }
    if (returnedEntriesPerRecord) {
      for (let r = from; r < to; ++r)
        ++returnedEntriesPerRecord[candidates.rows[r]];
      returnedEntries += to - from;
    }
    if (expands) {
      for (let r = from; r < to; ++r)
        expanded.push({
          theirIndex: candidates.rows[r],
          iteration: e.iteration,
        });
    } else {
      e.theirIndex = i;
    }
  }
  // Coverage: the list must name every record this side matched. With the
  // per-entry rules above that also pins its length -- to this side's matched
  // position count from a "one" partner, and to the partner's own matched record
  // count from a "many" one.
  if (namedRecords !== numMappedElements)
    throw partnerProtocolError(
      participant.id,
      "the partner's mapped-element list does not name every record this " +
        "side matched",
    );

  log.debug(
    `${participant.id}: returning partner's map with original indices, ` +
      "receiving ours",
  );
  const identifiedIndexMap = await exchangeMappedElements(
    participant.id,
    conn,
    log,
    sendFirst,
    expands ? expanded : theirIdentifiedIndexIterationMap,
  );

  // Our own list, come back with each entry's index translated into the
  // partner's row space. Its length is ours to know -- one entry per record we
  // matched, or, where the partner expanded it, the tally we accumulated over its
  // own list above -- and every row index it carries lands in the returned table
  // (the partner half of the result, the payload alignment, and the attested
  // record), so it is bounded by the row count the partner carried on the terms
  // exchange. A repeated row is admitted only where THIS party is the "many"
  // side, several of its records legitimately naming one partner row; the count
  // check above it is then what caps the list's length, which distinctness
  // otherwise does.
  //
  // What survives the relaxation is injectivity MODULO the grouping this party
  // sent, and both halves of it are checkable here: two of our entries that named
  // the same (round, position) must come back carrying the same partner row, and
  // two that named different positions must come back carrying different rows --
  // distinct positions in a round are distinct partner values held by distinct
  // partner rows, and a partner row matched in round j has left candidacy for
  // every later round. Without it the "one" partner, not this party's own data,
  // would decide which of our records group together (docs/spec/PROTOCOL.md,
  // Deriving one table from the exchanged association maps).
  //
  // Where the partner keeps its duplicates too, each of our entries comes back as
  // the whole partner GROUP behind the position it named rather than as one row,
  // so the same rule reads over runs: our grouped entries must come back with
  // identical runs and our differently grouped ones with disjoint runs. The run
  // lengths are the per-record tally, so the grouping stays a quantity we hold.
  assertPartnerIndexCount(
    participant.id,
    "the returned mapped-element list",
    identifiedIndexMap.length,
    sides.partnerKeepsDuplicates ? returnedEntries : numMappedElements,
  );
  assertPartnerIndices(
    participant.id,
    "the returned mapped-element list",
    identifiedIndexMap.map((x) => x.theirIndex),
    partnerRecordCount,
    returnedListRules(sentGroups, returnedEntriesPerRecord, originalIndices),
  );

  if (!sides.partnerKeepsDuplicates)
    return identifiedIndexMap.reduce(
      (acc, x, i) => {
        acc[0].push(originalIndices[i]);
        acc[1].push(x.theirIndex);
        return acc;
      },
      [[], []] as [Array<number>, Array<number>],
    );

  // Our own list came back EXPANDED: our matched records in the order we sent
  // them, each followed by the partner rows of the group it matched. Walking our
  // records in that same order with the per-record tally is what reconstructs the
  // pairing, and it is why the expansion order is normative.
  //
  // Under a BOTH-sided multiplicity the pairs are labelled with the block each one
  // belongs to as they are built, so the entity closure the table resolves into can
  // be held to those blocks below. Only that cardinality carries the labels: where
  // one side keeps its distinctness a cluster is one record of that side with the
  // group facing it, which the table's own shape already gives.
  const labels = sentGroups && blockLabels(sentGroups);
  const blockOfPair: Array<number> | undefined = labels && [];
  const table: [Array<number>, Array<number>] = [[], []];
  let cursor = 0;
  for (let i = 0; i < originalIndices.length; ++i) {
    const row = originalIndices[i];
    for (let t = returnedEntriesPerRecord![row]; t > 0; --t) {
      table[0].push(row);
      table[1].push(identifiedIndexMap[cursor++].theirIndex);
      blockOfPair?.push(labels![i]);
    }
  }
  if (blockOfPair)
    assertBlockDiagonalClosure(participant.id, table, blockOfPair);
  return table;
}

/**
 * The count-only (`psi-c`) counterpart to {@link linkViaPSI}: ONE PSI round over ONE
 * linkage key, resolving to the size of the intersection and to nothing that names a
 * match (docs/spec/PROTOCOL.md, PSI-C).
 *
 * Returns the count this party holds at the end of the round, or `undefined` when it
 * holds none -- the sender of a run whose agreed terms entitle only the receiver.
 * The receiver computes the count locally from the setup and the response; the
 * sender computes nothing and learns nothing about it from the round itself, so the
 * only route to the sender is the count-report frame this function runs when
 * `reportCountToSender` is set. Both parties derive that flag from the same agreed
 * terms ({@link ./protocolSetup.reportsCountToSender}), so the frame is sent
 * exactly when it is awaited.
 *
 * The within-dataset filter is the cascade's own: a record with no value for the key
 * sits the round out, and a value duplicated within this party's dataset is dropped
 * entirely, so each party contributes exactly the values it holds once. That is what
 * makes the count equal the size of the table a single-key `psi` run over the same
 * data would produce -- the library's cardinality operation reports the MULTISET
 * intersection and would otherwise over-count a repeated value.
 *
 * @param participant - Must have a resolved role and a count-only engine; the
 *   identifier-revealing engine refuses the cardinality operation rather than
 *   returning one.
 * @param data - The agreed linkage keys' local values, which for a count-only run is
 *   exactly one entry. A longer list is refused rather than narrowed to its first
 *   key: a narrowed run would deliver a count the operator did not agree to.
 * @param reportCountToSender - Whether this round's count-report frame is exchanged
 *   (see {@link ./protocolSetup.reportsCountToSender}); both parties pass the same
 *   value.
 * @param maxCount - The largest legitimate count, for bounding the reported figure
 *   on the sender: the smaller of the two exchanged record counts.
 */
export async function linkViaCountOnlyPSI(
  participant: PSIParticipant,
  conn: MessageConnection,
  data: Array<IndexableIterable<KeyCandidates>>,
  reportCountToSender: boolean,
  maxCount: number,
  verbosity: number = 0,
  setStage?: (id: string) => void,
): Promise<number | undefined> {
  if (participant.config.role === "either")
    throw new Error("participants role is unresolved");
  if (data.length !== 1)
    throw new UsageError(COUNT_ONLY_SHAPE_REFUSALS.linkageKeys);

  const log = getLoggerForVerbosity("psiLink", verbosity);
  setStage = setStage ?? (() => {});
  setStage("stage 1 / 1");

  const [values] = removeDuplicatesAndUndefineds(
    Array.from(data[0], requireSingleCandidate),
  );
  log.debug(
    `${participant.id}: counting the intersection over 1 key: ` +
      `${values.length} unique value(s)`,
  );

  const count = await participant.countIntersection(conn, values);

  if (!reportCountToSender) return count;
  // The receiver holds the count and reports it; the sender awaits exactly the frame
  // the receiver sends. Which side we are is the participant's resolved role, and the
  // flag is derived from the agreed terms, so the two never diverge.
  if (participant.config.role === "joiner") {
    if (count === undefined)
      throw new Error(
        `${participant.id}: the count-only round produced no count to report`,
      );
    await sendCountReport(conn, count);
    return count;
  }
  return receiveCountReport(conn, maxCount);
}

// Actionable guidance for an exchange that exceeds the single-pass ceiling.
// Deliberately does NOT recommend cascade: linkage_strategy is a
// mandatory-consistency agreed term that cannot change unilaterally mid-exchange
// (re-agreeing on cascade is an out-of-band step), so pointing at it here would be
// misleading. See docs/spec/PROTOCOL.md (the single-pass dataset ceiling).
//
// The ceiling is a PER-PARTY budget on the value slot count effectiveKeyCount *
// recordCount, so the guidance is oriented to the party it is shown to: it states
// the products the gate actually weighed, names which side's declared size reached
// the budget, and offers each side's remedies to the side that can apply them --
// the two parties reach mirrored verdicts (singlePassCeilingBreach), so the abort
// stays symmetric while neither operator is sent to a configuration that cannot
// move it. Reducing either factor, or splitting the dataset, is the actionable
// remedy on a breaching side, and removing a fan-out is another when that side
// declares one. This party's own declaration covers both places one can be
// authored -- the agreed width, and the local cleaning that rides its record
// count instead -- while the partner's cleaning is invisible here, so the
// partner's hint rests on the agreed width alone.
//
// Every remedy it names is a configuration one of the two operators can change, so
// its raise site is a UsageError (CLI exit 64) rather than a transport or internal
// fault -- the same class as the width refusals below. It interpolates the two
// parties' declared effective key counts, their record counts, and the value slot
// products of those, all of them authenticated session state, and no
// partner-authored text.
function singlePassOverCapMessage(
  id: string,
  numLinkageKeys: number,
  breach: SinglePassCeilingBreach,
  local: SinglePassPartySize,
  localFansOut: boolean,
  partner: SinglePassPartySize,
): string {
  const declared = (who: string, party: SinglePassPartySize): string =>
    `${who} declared ${party.effectiveKeyCount} effective linkage key(s) ` +
    `across ${party.recordCount} record(s), which is ${valueSlots(party)} ` +
    "value slot(s)";
  const fanOutRemedy = (whose: string, cleaningToo: boolean): string =>
    " A linkage key whose elements expand counts its whole declared width " +
    "toward that ceiling" +
    (cleaningToo
      ? ", and cleaning that fans out declares the records it stands for,"
      : ",") +
    ` so removing ${whose} fan-out is another remedy.`;

  const cause =
    breach === "local"
      ? declared("this party", local)
      : breach === "partner"
        ? declared("the partner", partner)
        : `${declared("this party", local)}, and ${declared("the partner", partner)}`;

  const remedies: string[] = [];
  if (breach !== "partner")
    remedies.push(
      "Reduce the number of linkage keys or the record count, or split the " +
        "dataset into smaller batches." +
        (localFansOut ? fanOutRemedy("a", true) : ""),
    );
  if (breach !== "local")
    remedies.push(
      (breach === "both"
        ? "The partner reduces its record count or splits its dataset on its " +
          "side too."
        : `This party's own ${valueSlots(local)} value slot(s) are within the ` +
          "ceiling, so within the agreed terms neither its linkage keys nor " +
          "its record count can lift this: the partner reduces its record " +
          "count or splits its dataset.") +
        (partyFansOut(numLinkageKeys, partner)
          ? fanOutRemedy("the partner's", false)
          : ""),
    );

  return (
    `${id}: single-pass cannot carry this ` +
    `${breach === "local" ? "dataset" : "exchange"}: ${cause}, above the ` +
    `single-pass ceiling of ${MAX_SINGLE_PASS_CELLS} value slot(s) per party. ` +
    remedies.join(" ")
  );
}

// The diagnosis for the send-time reply-cap backstop below, which is NOT an
// over-ceiling condition: the ceiling gate has already passed there, so both
// parties' declared sizes are within the budget and no dataset either operator
// controls is what stopped the send. Reaching it means the built reply outgrew the
// cap both parties derive from those same declared sizes -- an inconsistency
// between this party's reply builder and that derivation -- so it names the two
// byte counts and withholds the dataset remedies, which cannot move it. It is
// raised as an InternalConsistencyError, the class whose classification carries
// that remedy: report it, rather than fix an input or retry a transport.
function singlePassReplyOverCapMessage(
  id: string,
  replyBytes: number,
  replyCap: number,
): string {
  return (
    `${id}: single-pass built a reply of ${replyBytes} byte(s), above the ` +
    `${replyCap} byte(s) both parties derive from their declared sizes. Both ` +
    "parties' declared widths and record counts are within the single-pass " +
    "ceiling, so this is an inconsistency between this party's reply builder " +
    "and the shared cap derivation rather than a dataset that is too large. " +
    "The exchange cannot proceed; report it with this message."
  );
}

// Force a major collection to release a phase's transient allocations before the
// next phase allocates, lowering the lifetime peak RSS that bounds the single-pass
// dataset ceiling. The single-pass receiver's peak is dominated by GC-collectable
// V8 garbage from the per-element JS<->native boundary marshalling -- the library
// binding layer reached through createClientRequest/computeValueMatches/
// createServerSetup -- not by the WebAssembly linear heap (a flat ~16 MB at
// D = 14,000) or by retained JS (a ~20 MB live floor); collecting at the phase
// boundaries recovers it (the measured sizes, methodology, and breakdown are in
// docs/spec/PROTOCOL.md). A no-op
// unless the runtime exposes a global gc: the CLI launches Node with --expose-gc
// (the Dockerfile entrypoint and the apps/cli dev script), so it gets the relief;
// a browser never exposes gc, so the web receiver does not, and its ceiling rests
// on the same conservative cap.
// Called only at the handful of coarse phase boundaries, never per element or per
// key, so its pause is negligible beside the curve operations it follows.
function relieveTransientMemory(): void {
  (globalThis as typeof globalThis & { gc?: () => void }).gc?.();
}

/**
 * Whether the single-pass receiver withholds the sender's association-table half
 * ({@link linkViaSinglePassPSI}'s message 3) entirely, so a genuinely blind
 * helper's process never receives -- and so never learns -- its own membership
 * (which of its records matched).
 *
 * Withhold exactly when the SENDER is a non-receiving helper (`expectsOutput:
 * false`, so it gets no result table of its own) that ALSO discloses no payload
 * (its metadata transmits no column, so it has no matched rows to enrich). That is
 * the one closeable case in a one-sided single-pass exchange: the helper needs its
 * association-table half only to build its own result (it has none) or to enrich
 * the payload it discloses (it discloses none), so withholding leaves it needing
 * nothing back. A helper that discloses payload still receives the full table (it
 * reads `associationTable[0]` to build enrichment for the overlap -- an intrinsic,
 * threat-model-accepted membership disclosure), and a party entitled to output
 * always receives it.
 *
 * Both parties compute this from the SAME authenticated session state -- the
 * resolved sender's output entitlement and its advertised `disclosesPayload` flag,
 * carried on the terms exchange -- so the receiver's decision to suppress the frame
 * and the sender's decision to skip awaiting it are always the same, keeping the
 * two in lockstep. The frame is suppressed ENTIRELY, never sent empty: an
 * empty-versus-populated association table would leak the match count by the
 * frame's presence and size, so only omitting it closes the channel. See
 * docs/notes/one-sided-disclosure.md and docs/spec/PROTOCOL.md.
 *
 * A deduplicating cardinality does not move the rule, and it cannot reach the
 * withheld path from the "many" side: a party declaring `deduplicate: true` must
 * declare `output.expectsOutput` (the linkage-terms schema refines it), so a "many"
 * sender is entitled to output and is never a non-receiving helper. What the
 * withheld path does cover under multiplicity is the design-intent shape -- the
 * "one" party a no-output helper, which role resolution then makes the SENDER,
 * since the party entitled to output becomes the receiver -- so the "many" party
 * resolves the whole pairing and applies the one-side uniqueness rule to the
 * helper's index table on its behalf. The helper needs nothing back there for the
 * same two reasons as under `one-to-one`. Pinned in psiLink.test.ts.
 */
export function withholdsSenderAssociationTable(
  senderExpectsOutput: boolean,
  senderDisclosesPayload: boolean,
): boolean {
  return !senderExpectsOutput && !senderDisclosesPayload;
}

/**
 * The session state {@link linkViaSinglePassPSI} derives every one of its bounds
 * from: the per-key widths the AGREED terms declare, which both parties derive
 * identically with no advertisement, and the two parties' declared record counts,
 * exchanged over the encrypted channel. Nothing here is read from an inbound
 * linkage frame, so both parties compute the same numbers and reach the same
 * verdicts.
 */
export interface SinglePassSessionBounds {
  /**
   * The partner's declared record count, exchanged over the encrypted channel
   * during role resolution. It is the partner's row count times its own local
   * fan-out factor, which is why the reply's own record count is held to it as an
   * upper bound rather than an equality.
   */
  readonly partnerRecordCount: number;
  /**
   * The candidate values one record may contribute to each agreed linkage key,
   * positionally aligned with `data` and derived from the agreed terms alone
   * ({@link declaredKeyWidth}), so both parties hold the identical vector.
   */
  readonly keyWidths: ReadonlyArray<number>;
  /**
   * The factor this party's own standardization multiplies its record count by
   * (`localFanOutFactor`, fanOutFunctions.ts). This party's DECLARED record count
   * -- what it carried on the terms exchange, and what the partner holds it to --
   * is its row count times this factor, so the two are derived here from the data
   * rather than passed in and left to diverge from it. It widens the per-cell
   * bound this party's own table build is held to by exactly the multiple that
   * declared count carries, and it is what makes this party ship the ragged layout
   * when its local cleaning fans out but the agreed terms declare no width.
   */
  readonly localFanOutFactor: number;
}

/**
 * The single-pass linkage strategy: an alternative to {@link linkViaPSI} that
 * produces the same matched row pairs but uses one network round-trip instead of
 * one per linkage key. exchange.ts chooses between the two on `linkageStrategy`.
 *
 * Keys are applied in order, most precise first; a record matched on an earlier
 * key is set aside before later keys are tried (this is the "cascade"). Here the
 * sender sends, in one shot, which of its records share a value under each key --
 * all records and all keys -- and the receiver replays that whole cascade itself.
 * It needs the full picture because whether a value is unique depends on which
 * records earlier keys already set aside: a value shared by two records becomes
 * usable on a later key once an earlier key has matched one of them. Along the
 * way the receiver sees some matches a less precise key would make that the
 * step-by-step cascade would have discarded, but only the cascade-equivalent
 * result is returned. Wire format and the extra disclosure this costs:
 * docs/spec/PROTOCOL.md; the PSI building blocks it calls are on
 * {@link PSIParticipant}.
 *
 * This is the one strategy fan-out matching is specified for, so `data` may yield
 * a record a candidate SET for a key: every candidate enters the round as its own
 * PSI entry, the within-round uniqueness rule applies per VALUE, and the
 * record-level pairing is resolved by the deterministic sweep in
 * {@link replaySinglePassCascade}. A fan-out-free exchange ships and replays
 * exactly what it did before fan-out existed.
 *
 * It matches the one-sided deduplicating cardinalities as well as `one-to-one`,
 * over the same frames: the index table already carries one value per (key,
 * record) for every party, so which side keeps a value several of its records hold
 * is a rule of the receiver's replay rather than anything on the wire
 * (docs/spec/PROTOCOL.md, The per-side rules). `many-to-many` throws, where the
 * cascade pairs it: this strategy's seam hands the sender a table it holds to a
 * length taken from the half that keeps its distinctness, and a both-sided
 * multiplicity leaves neither half distinct (see {@link singlePassResolves}).
 * exchange.ts refuses an agreed both-sided pair on this strategy before the run
 * (`assertBothSidedDeduplicateImplemented`, reached from
 * `resolveLinkageCardinality`), naming the strategy that stands in the way; this
 * is the strategy's own fail-closed half, which holds for a direct caller too.
 *
 * @param bounds - The authenticated session state every derived bound reads; see
 *   {@link SinglePassSessionBounds}. Together they fix the per-exchange frame cap,
 *   the abort-if-over-ceiling gate, and which of the two message-2 index-table
 *   layouts the sender ships -- identically on both parties.
 * @param withholdSenderTable - When `true`, the receiver suppresses message 3
 *   (the sender's association-table half) ENTIRELY and the sender skips awaiting
 *   it, so a non-receiving, no-payload helper's process never receives -- and so
 *   never learns -- its own membership. Both parties pass the same value, derived
 *   from symmetric authenticated session state (see
 *   {@link withholdsSenderAssociationTable} and its caller in exchange.ts), so the
 *   suppress and the skip stay in lockstep and neither side blocks on a frame the
 *   other will not send. Defaults to `false` (the frame is exchanged as before).
 *   When it withholds, the sender returns an empty table `[[], []]` -- it genuinely
 *   does not learn its matches, which is the blindness this realizes.
 */
export async function linkViaSinglePassPSI(
  protocol: {
    cardinality: LinkageCardinality;
  },
  participant: PSIParticipant,
  conn: MessageConnection,
  data: Array<IndexableIterable<KeyCandidates>>,
  bounds: SinglePassSessionBounds,
  withholdSenderTable: boolean = false,
  verbosity: number = 0,
  setStage?: (id: string) => void,
): Promise<AssociationTable> {
  if (participant.config.role === "either")
    throw new Error("participants role is unresolved");
  if (!singlePassResolves(protocol.cardinality)) {
    throw new Error(
      `psi for cardinality '${protocol.cardinality}' not yet implemented`,
    );
  }
  // Which side of a round's incidence keeps its within-dataset duplicate values,
  // read off this party's own resolved label exactly as the cascade reads it. The
  // sender's copy is what its returned table is checked against, and the
  // receiver's is what its replay resolves under.
  const sides = multiplicitySides(protocol.cardinality);

  const log = getLoggerForVerbosity("psiLink", verbosity);
  const stage = setStage ?? (() => {});
  const numLinkageKeys = data.length;
  // Guaranteed by the schema (linkageKeys is .min(1)); checked so a direct caller
  // with empty data cannot make the receiver's frame-length guard below vacuous.
  if (numLinkageKeys < 1)
    throw new Error(
      `${participant.id}: single-pass requires at least one linkage key`,
    );

  log.debug(
    `${participant.id}: linking using ${numLinkageKeys} key(s) via ` +
      `single-pass PSI`,
  );

  const { partnerRecordCount, keyWidths, localFanOutFactor } = bounds;

  if (keyWidths.length !== numLinkageKeys)
    throw new Error(
      `${participant.id}: single-pass was given ${keyWidths.length} declared ` +
        `key width(s) for ${numLinkageKeys} linkage key(s)`,
    );

  // The effective key count both parties derive from the agreed terms: the sum of
  // the per-key widths, with no advertisement to reconcile, so one value serves
  // both sides of every derived bound.
  const effectiveKeyCount = keyWidths.reduce((sum, width) => sum + width, 0);

  // The per-cell bound this party's own table build is held to. The local factor
  // rides this party's DECLARED RECORD COUNT rather than the agreed width, so the
  // two multiply back to exactly the slot bound the partner derives.
  const localCellWidths = keyWidths.map((width) => width * localFanOutFactor);

  // The layout this party's own index table takes: ragged when a record may hold
  // several candidates for a key -- because the agreed terms declare width, or
  // because this party's own cleaning fans out -- fixed-width otherwise. The
  // discriminant is the declaration rather than the data, so the build refuses a
  // cell wider than what was declared instead of silently outgrowing the slot
  // bound derived from it.
  const localFansOut =
    partyFansOut(numLinkageKeys, { effectiveKeyCount }) ||
    localFanOutFactor > 1;

  const { distinctValues, columns, numRecords, slotCount } =
    getDistinctValuesAndIndices(data, localFansOut, localCellWidths);

  // Map (own count, partner count, role) -> (sender size, receiver size). Both
  // parties derive the SAME pair: the starter is the PSI sender, the joiner the
  // receiver. This is the authenticated session state the frame cap and the
  // over-ceiling gate read -- never the inbound frame.
  const isSender = participant.config.role === "starter";
  // What this party declared on the terms exchange: its rows times its own
  // fan-out factor, the same product the partner was handed.
  const localRecordCount = numRecords * localFanOutFactor;
  const localSize: SinglePassPartySize = {
    effectiveKeyCount,
    recordCount: localRecordCount,
  };
  const partnerSize: SinglePassPartySize = {
    effectiveKeyCount,
    recordCount: partnerRecordCount,
  };
  const senderSize = isSender ? localSize : partnerSize;
  const receiverSize = isSender ? partnerSize : localSize;

  // The value slots this party's own data actually occupies must fit the bound its
  // declaration claims: the partner's decode, its element bounds, and its read
  // gate are all derived from that claim, so exceeding it would have the partner
  // reject a frame this party built. A candidate producer whose width the declared
  // factors do not account for lands here rather than on the wire: a row within the
  // per-record bound still overruns the slots when the key it widens is one the
  // declared factors count as single-valued, which is what a producer outside
  // FAN_OUT_FUNCTION_NAMES realizes -- `declaredKeyWidth` (fanOutFunctions.ts)
  // declares a factor for each producer it knows. That producer is a configuration
  // its operator can change, so the refusal is usage-typed rather than internal.
  const localSlotBound = effectiveKeyCount * localRecordCount;
  if (slotCount > localSlotBound) {
    throw new UsageError(
      `${participant.id}: single-pass built ${slotCount} candidate value slot(s) ` +
        `across ${numLinkageKeys} linkage key(s) and ${numRecords} record(s), ` +
        `more than the ${localSlotBound} this party's agreed linkage terms and ` +
        "declared record count account for. Drop the step that expands a " +
        "record's value for a key the declared factors count as single-valued " +
        "-- a transform that expands one value without being a declared fan-out " +
        "function -- so this party's rows fit the width its terms declare.",
    );
  }

  // Authoritative, symmetric over-ceiling gate. Both parties compute it
  // identically from the exchanged counts and effective key counts, BEFORE
  // exchanging any single-pass frame, so an over-cap exchange aborts on both
  // sides in lockstep -- neither sends nor waits, so neither hangs to the
  // inactivity timeout. The verdict is on the per-party budget, so the two
  // parties' breach labels mirror each other (a "partner" breach here is a
  // "local" one over there) while the abort decision itself is the same on both;
  // the guidance that carries it is oriented to this party and does not recommend
  // cascade. The prepareForExchange pre-flight is the coarse one-party shadow of
  // this; this is the precise two-party check.
  const ceilingBreach = singlePassCeilingBreach(localSize, partnerSize);
  if (ceilingBreach !== undefined) {
    throw new UsageError(
      singlePassOverCapMessage(
        participant.id,
        numLinkageKeys,
        ceilingBreach,
        localSize,
        localFansOut,
        partnerSize,
      ),
    );
  }

  if (participant.config.role === "starter") {
    // Need to send:
    // - this party's values, encrypted with own key ("setup" message)
    // - partner's data re-encrypted ("response")
    // - distinctValueIndexTable so partner knows how to reconstruct data
    stage("encrypting my data");
    const { setup, permutation } =
      await participant.createServerSetup(distinctValues);

    const request = (await conn.receive()) as Uint8Array;
    // Collect the setup-masking transients before the re-encryption masking.
    relieveTransientMemory();
    stage("doubly-encrypting partner's data");
    const response = await participant.processClientRequest(request);
    // createServerSetup sorted distinctValues; remap the index table into that
    // sorted order so its indices match the sorted setup message.
    const sortedDistinctValueIndices = getSortedDistinctValueIndices(
      columns,
      permutation,
      numRecords,
    );

    const reply = encodeSinglePassReply(
      setup,
      response,
      numRecords,
      sortedDistinctValueIndices,
    );
    // Send-time check against the SAME derived cap the receiver's read gate
    // enforces (singlePassReplyByteCap), so the two are one computation. The
    // over-ceiling gate above already aborted the common case from the counts
    // alone; this is the defensive backstop, since the derived cap upper-bounds
    // any legitimate reply, it fires only on a pathological build (an
    // unexpectedly large serialized element). Its diagnosis is the
    // builder-versus-derivation one rather than the over-ceiling guidance, which
    // the gate above has already ruled out.
    const replyCap = singlePassReplyByteCap(
      numLinkageKeys,
      senderSize,
      receiverSize,
    );
    if (reply.byteLength > replyCap) {
      throw new InternalConsistencyError(
        singlePassReplyOverCapMessage(
          participant.id,
          reply.byteLength,
          replyCap,
        ),
      );
    }

    log.debug(`${participant.id}: sending combined single-pass reply`);
    await conn.send(reply);
    // Collect the response-masking and reply-build transients before idling on
    // the partner's table.
    relieveTransientMemory();

    if (withholdSenderTable) {
      // We are a non-receiving helper disclosing no payload: the receiver
      // suppresses message 3, so do NOT await a frame it will not send (that would
      // hang to the inactivity timeout). Return an empty table -- we genuinely do
      // not learn which of our records matched, which is the blindness this path
      // realizes. Both sides derived this from the same authenticated state, so the
      // skip and the receiver's suppression agree.
      log.debug(
        `${participant.id}: association table withheld; staying blind to my ` +
          `own matches`,
      );
      stage("done");
      return [[], []];
    }

    // The resolved table is computed by the receiver, so this side cannot
    // recompute it -- but every index in it addresses a row one of the two
    // parties counted, and both counts are authenticated session state. Check the
    // two halves against them before the table becomes this party's match set,
    // its payload row selection, and its attested record. The ascending order of
    // the local half is checked with them: it is part of the AssociationTable
    // contract (types.ts) that the cascade produces structurally and the receiver
    // sorts this table into, and the result rows and the record's reconstruction
    // of them read the table in it.
    //
    // Under a deduplicating cardinality one half repeats -- the "one" side's rows,
    // several of the MANY side's linking to each -- so the distinctness that
    // otherwise makes the local half STRICTLY ascending and caps the table's length
    // is relaxed on exactly that half, leaving it non-decreasing and the length
    // pinned by the many side's row count instead (docs/spec/PROTOCOL.md, Deriving
    // one table from the exchanged association maps). Which half that is comes from
    // this party's own resolved label rather than from the table, and the other
    // half -- the many side's, one entry per record it matched -- is the anchor.
    const table = await receiveParsed(conn, associationTableMessage);
    const localHalf = {
      what: "the resolved association table's local half",
      indices: table[0],
      exclusiveBound: numRecords,
      ascending: true,
    };
    const partnerHalf = {
      what: "the resolved association table's partner half",
      indices: table[1],
      exclusiveBound: partnerRecordCount,
    };
    if (sides.partnerKeepsDuplicates)
      assertPartnerIndexTable(participant.id, partnerHalf, {
        ...localHalf,
        repeats: true,
      });
    else
      assertPartnerIndexTable(participant.id, localHalf, {
        ...partnerHalf,
        repeats: sides.localKeepsDuplicates,
      });
    stage("done");
    return [table[0], table[1]];
  }

  stage("encrypting my data");
  await conn.send(await participant.createClientRequest(distinctValues));

  // Tighten the read gate to the per-exchange derived cap before reading the
  // reply, then clear it so the later payload read uses the default. Set after
  // our request and before the reply (one peer round trip away), so the file-sync
  // poll loop reads no frame between the set and the read it governs. A transport
  // that bounds its inbound path another way (the WebRTC data channel, fixed at
  // MAX_WEBRTC_FRAME_BYTES) no-ops setInboundFrameCap and relies on that envelope
  // plus the coherence checks below.
  const replyCap = singlePassReplyByteCap(
    numLinkageKeys,
    senderSize,
    receiverSize,
  );
  conn.setInboundFrameCap?.(replyCap);
  let replyFrame: Uint8Array;
  try {
    replyFrame = (await conn.receive()) as Uint8Array;
  } finally {
    conn.setInboundFrameCap?.(undefined);
  }

  const {
    setup: setupBytes,
    response: responseBytes,
    numRecords: numSenderRecords,
    distinctValueIndices: stackedDistinctValueIndices,
  } = decodeSinglePassReply(replyFrame);

  // Validate every count the reply declares against authenticated state, before
  // it drives any allocation. The sender packs the number of rows its table
  // carries into the reply (part (c) of the wire format); it may declare no MORE
  // than the record count the sender exchanged over the encrypted channel during
  // role resolution (partnerRecordCount), which the over-ceiling gate above
  // already bounded. The two are equal for a sender whose own cleaning does not
  // fan out, and a fanning sender declares the multiple of its rows its factor
  // stands for, so the tie is an upper bound rather than an equality. This ties
  // the decoded count to authenticated state rather than trusting the frame, and
  // the index-table check then confirms the frame's own shape against the agreed
  // key count, that record count, and the sender's slot bound -- all before the
  // allocations below, preserving the pre-allocation ordering.
  if (numSenderRecords > partnerRecordCount) {
    throw partnerProtocolError(
      participant.id,
      `the single-pass reply declares ${numSenderRecords} sender record(s), ` +
        `more than the ${partnerRecordCount} the sender exchanged`,
    );
  }
  // The sender's own fan-out factor, recovered from the two counts rather than
  // advertised: its declared record count is its row count times the factor, so
  // the quotient is that factor exactly. A local fan-out declares either no
  // factor at all or one whole declared step's (localFanOutFactor,
  // fanOutFunctions.ts), so those two quotients are the only ones an honest
  // sender can produce and every other is refused -- a non-integer, a factor
  // between them, one above the declared step's, and a frame declaring no rows
  // against a positive exchanged count, which no factor multiplies up to. A
  // sender holding no rows at all exchanged no records either, and that one
  // legitimate zero case takes the unfanned factor. The sender's slot bound
  // below stays derived from authenticated state whatever the frame says.
  const senderFanOutFactor =
    partnerRecordCount === 0 ? 1 : partnerRecordCount / numSenderRecords;
  if (
    senderFanOutFactor !== 1 &&
    senderFanOutFactor !== FAN_OUT_CANDIDATES_PER_ELEMENT
  ) {
    throw partnerProtocolError(
      participant.id,
      `the single-pass reply declares ${numSenderRecords} sender record(s) ` +
        `against the ${partnerRecordCount} the sender exchanged, which is not ` +
        "a fan-out factor a declared step can produce",
    );
  }
  // Bounded by the authenticated pair alone: the sender's row count times the
  // factor is exactly its declared record count, so this is the same product the
  // element bounds and the read gate were derived from.
  const senderSlotBound = senderSize.effectiveKeyCount * partnerRecordCount;
  // The sender ships the ragged layout for the same two reasons this party would:
  // the agreed terms declare width, or the sender's own cleaning fans out -- which
  // is what the recovered factor names.
  const senderCells =
    partyFansOut(numLinkageKeys, senderSize) || senderFanOutFactor > 1
      ? decodeRaggedIndexTable(
          participant.id,
          stackedDistinctValueIndices,
          keyWidths.map((width) => width * senderFanOutFactor),
          numSenderRecords,
          senderSlotBound,
        )
      : decodeFixedWidthIndexTable(
          participant.id,
          stackedDistinctValueIndices,
          numLinkageKeys,
          numSenderRecords,
        );

  // Collect the request-masking transients before the match masking.
  relieveTransientMemory();
  stage("identifying shared elements");
  const [receiverDistinctValueIds, senderDistinctValueIds] =
    await participant.computeValueMatches(setupBytes, responseBytes);
  // Keyed by the SENDER's value id, because the resolution sweep walks the
  // sender's rows in ascending order (see replaySinglePassCascade). The pairing is
  // a bijection over the matched values -- each party's values are distinct, and
  // two of them pair only when their plaintexts are equal -- so either direction
  // carries the same information.
  const senderToReceiverDistinctValue = new Map<number, number>();
  for (let k = 0; k < senderDistinctValueIds.length; ++k) {
    senderToReceiverDistinctValue.set(
      senderDistinctValueIds[k],
      receiverDistinctValueIds[k],
    );
  }

  // Collect the match-masking transients (the library's boundary marshalling and
  // the consumed id arrays) before replaying the cascade.
  relieveTransientMemory();

  // Replay the cascade. This is purely local, in-memory work with no on-wire
  // round trip per key -- the whole single-pass exchange already happened in the
  // one setup/response above -- so it completes near-instantly and emits NO
  // per-key stage. A "linking key N / M" line here would flash by uselessly while
  // the operator's real wait was the up-front encryption stages; describeExchange-
  // Stages omits the per-key stages for single-pass to match (cascade keeps them,
  // where each key is a genuine round trip).
  const result = replaySinglePassCascade(
    columns.map(localKeyCells),
    senderCells,
    senderToReceiverDistinctValue,
    numRecords,
    numSenderRecords,
    sides,
  );

  // Collect the cascade's per-key reconstruction maps before returning.
  relieveTransientMemory();

  if (withholdSenderTable) {
    // The sender is a non-receiving helper disclosing no payload: suppress its
    // association-table half ENTIRELY -- not sent empty. An empty-versus-populated
    // table would leak the match count by the frame's presence and size, so only
    // omitting the frame closes the channel and keeps the helper blind. The sender
    // derived the same decision and skips awaiting this frame, so the two stay in
    // lockstep. We still return our own resolved table below.
    log.debug(
      `${participant.id}: ${result[0].length} match(es); withholding the ` +
        `sender's association-table half`,
    );
    stage("done");
    return result;
  }

  // The same pairs read from the sender's side, in that side's own row order. The
  // tiebreak is explicit because a deduplicating cardinality can put several pairs
  // on one sender row, and the order within such a run is part of what the
  // sender's half carries.
  const pairs = result[0].map((i, k): [number, number] => [result[1][k], i]);
  pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const theirResult: AssociationTable = [
    pairs.map((p) => p[0]),
    pairs.map((p) => p[1]),
  ];

  log.debug(
    `${participant.id}: ${result[0].length} match(es); returning sender's ` +
      `view`,
  );
  await conn.send(theirResult);
  stage("done");
  return result;
}

// --- the distinct-value index table ------------------------------------------

// One linkage key's cells for one party: the distinct-value indices each record
// contributes to that key's round. Read through this interface so the resolution
// sweep below is ONE implementation over both of message 2's layouts and over the
// receiver's own locally built table -- the spec fixes one resolution rule, and a
// per-layout copy of it could drift from that rule silently.
/** @internal the shape both of message 2's index-table decoders return. */
export interface KeyCells {
  /** How many candidate values record `row` contributes to this key's round. */
  count(row: number): number;
  /** Record `row`'s `k`-th value index, `0 <= k < count(row)`. */
  valueAt(row: number, k: number): number;
}

// A party that declares no fan-out: one index per record, -1 where the record has
// no value for the key. Zero-copy over the decoded frame's own Int32Array.
class FixedWidthKeyCells implements KeyCells {
  constructor(private readonly indices: ArrayLike<number>) {}
  count(row: number): number {
    return this.indices[row] < 0 ? 0 : 1;
  }
  valueAt(row: number): number {
    return this.indices[row];
  }
}

// A party that declares a fan-out: `starts[row]..starts[row + 1]` delimits record
// `row`'s slice of `values`, so a record with no value for the key is an empty
// slice rather than a marker value.
class RaggedKeyCells implements KeyCells {
  constructor(
    private readonly starts: Int32Array,
    private readonly values: Int32Array,
  ) {}
  count(row: number): number {
    return this.starts[row + 1] - this.starts[row];
  }
  valueAt(row: number, k: number): number {
    return this.values[this.starts[row] + k];
  }
}

// One key's column of this party's own value indices, in whichever layout its
// declared width calls for. The two carry the same information; they differ only
// in what they cost to build and to ship (see getSortedDistinctValueIndices).
/** @internal the input getSortedDistinctValueIndices remaps onto the wire. */
export type LocalKeyColumn =
  | { readonly ragged: false; readonly indices: Array<number> }
  | {
      readonly ragged: true;
      readonly starts: Int32Array;
      readonly values: Int32Array;
    };

function localKeyCells(column: LocalKeyColumn): KeyCells {
  return column.ragged
    ? new RaggedKeyCells(column.starts, column.values)
    : new FixedWidthKeyCells(column.indices);
}

// For this party, the distinct values (pooled across all keys) plus, for every
// record and key, the indices of the values in that cell. Equal indices mean equal
// values, so the receiver can recover which records share a value without seeing
// the values themselves. "" is a real value with its own index, distinct from the
// fixed-width layout's -1 absent marker (docs/spec/PROTOCOL.md, Key input data).
//
// `fansOut` and `cellWidths` are the party's DECLARATION, not an observation of
// its data: a record's candidate set is refused here when it is wider than the
// per-key width declared for it, so the slot bound derived from that declaration
// -- which the partner's element bounds, read gate, and decode all rest on --
// cannot be outgrown by the data. Values stay pooled across keys with no per-key
// tag, exactly as they are without fan-out, and the replay compares them only
// within one key's round.
function getDistinctValuesAndIndices(
  data: Array<IndexableIterable<KeyCandidates>>,
  fansOut: boolean,
  cellWidths: ReadonlyArray<number>,
): {
  distinctValues: Array<string>;
  columns: Array<LocalKeyColumn>;
  numRecords: number;
  slotCount: number;
} {
  const valueId = new Map<string, number>();
  const distinctValues: Array<string> = [];
  const columns: Array<LocalKeyColumn> = [];
  let numRecords = 0;
  let slotCount = 0;
  const idOf = (value: string): number => {
    let id = valueId.get(value);
    if (id === undefined) {
      id = distinctValues.length;
      valueId.set(value, id);
      distinctValues.push(value);
    }
    return id;
  };
  for (let j = 0; j < data.length; ++j) {
    const column = fansOut
      ? Array.from(data[j])
      : Array.from(data[j], requireSingleCandidate);
    if (j === 0) {
      numRecords = column.length;
    } else if (column.length !== numRecords) {
      throw new Error(
        `single-pass: linkage key ${j} has ${column.length} records, ` +
          `expected ${numRecords}; all columns must have the same length`,
      );
    }
    if (!fansOut) {
      const indices: Array<number> = new Array(column.length);
      for (let i = 0; i < column.length; ++i) {
        const value = column[i] as string | undefined;
        if (value === undefined) {
          indices[i] = -1;
          continue;
        }
        indices[i] = idOf(value);
        slotCount += 1;
      }
      columns.push({ ragged: false, indices });
      continue;
    }
    const starts = new Int32Array(column.length + 1);
    const values: Array<number> = [];
    for (let i = 0; i < column.length; ++i) {
      const candidates = column[i];
      if (candidates !== undefined) {
        // A record's candidate set is a SET, so each distinct value it realizes
        // enters the round once; a singleton arrives unwrapped from realization
        // and costs no iteration.
        if (typeof candidates === "string") values.push(idOf(candidates));
        else for (const value of candidates) values.push(idOf(value));
      }
      const width = values.length - starts[i];
      // Usage-typed rather than internal: realization drops an over-width row for
      // the DECLARED fan-out producers alone (docs/spec/PROTOCOL.md, The width
      // bound), so what reaches this bound at full width is a producer that rule
      // does not bind -- a fuzzy comparison, or an expansion from a function
      // outside FAN_OUT_FUNCTION_NAMES -- and each is a configuration its operator
      // can change.
      if (width > cellWidths[j])
        throw new UsageError(
          `single-pass: record ${i} contributes ${width} candidate value(s) to ` +
            `linkage key ${j}, more than the ${cellWidths[j]} this party's ` +
            "agreed terms and standardization declare for it. Drop the step " +
            "that expands this record's value for that key -- a fuzzy " +
            "comparison, or a transform that expands one value without being a " +
            "declared fan-out function -- so no record realizes more candidates " +
            "than the declared width admits.",
        );
      starts[i + 1] = values.length;
    }
    slotCount += values.length;
    columns.push({ ragged: true, starts, values: Int32Array.from(values) });
  }
  return { distinctValues, columns, numRecords, slotCount };
}

// Remap this party's index table from build order into the setup message's sorted
// order, so it points at the distinct values as the setup message carries them,
// and flatten it into the wire words of message 2 part (d). createServerSetup
// yields permutation[sortedPos] = buildId, so the permutation is inverted first.
// Uses fresh storage, leaving the caller's columns untouched.
//
// Two layouts, chosen by the sender's declared width and read the same way on the
// receiver (docs/spec/PROTOCOL.md, Wire-format deltas):
//   - fixed-width: one word per (key, record), -1 where the record has no value;
//   - ragged: per (key, record) a count word then that many value-index words,
//     strictly ascending within the cell. The remap permutes the indices, so each
//     cell is re-sorted after it -- the ordering is a property of the SORTED
//     indices the receiver validates, not of the build order they came from.
/** @internal exported for the index-table layout conformance vectors. */
export function getSortedDistinctValueIndices(
  columns: Array<LocalKeyColumn>,
  permutation: Array<number>,
  numRecords: number,
): Array<number> {
  const sortedPosOf = new Array<number>(permutation.length);
  for (let sortedPos = 0; sortedPos < permutation.length; ++sortedPos) {
    sortedPosOf[permutation[sortedPos]] = sortedPos;
  }
  const result: Array<number> = [];
  const cell: Array<number> = [];
  for (const column of columns) {
    if (!column.ragged) {
      for (const index of column.indices)
        result.push(index >= 0 ? sortedPosOf[index] : -1);
      continue;
    }
    for (let row = 0; row < numRecords; ++row) {
      const from = column.starts[row];
      const to = column.starts[row + 1];
      result.push(to - from);
      cell.length = 0;
      for (let k = from; k < to; ++k) cell.push(sortedPosOf[column.values[k]]);
      cell.sort((a, b) => a - b);
      for (const index of cell) result.push(index);
    }
  }
  return result;
}

// --- decoding the partner's index table --------------------------------------

// The fixed-width layout a sender that declares no fan-out ships: exactly one word
// per (key, record). A frame carrying any other number of words is a clean
// protocol error rather than a wrong reconstruction. subarray returns a view over
// the decoded frame rather than a copy, so nothing is duplicated here.
/** @internal exported for the index-table layout conformance vectors. */
export function decodeFixedWidthIndexTable(
  participantId: string,
  words: Int32Array,
  keyCount: number,
  numRecords: number,
): Array<KeyCells> {
  if (words.length !== keyCount * numRecords)
    throw partnerProtocolError(
      participantId,
      "the single-pass distinct-value index table length does not match the " +
        "agreed key count",
    );
  const cells: Array<KeyCells> = [];
  for (let j = 0; j < keyCount; ++j)
    cells.push(
      new FixedWidthKeyCells(
        words.subarray(j * numRecords, (j + 1) * numRecords),
      ),
    );
  return cells;
}

/**
 * Decode the ragged layout a sender that declares a fan-out ships, validating it
 * against authenticated session state before it drives any allocation
 * (docs/spec/PROTOCOL.md, Wire-format deltas). In key-major then row order each
 * (key, record) cell is a count word `c` followed by `c` value-index words; there
 * is no absent marker, a record with no value for the key being `c = 0`.
 *
 * Every bound comes from state the partner cannot choose: `keyWidths`, the
 * per-key widths the AGREED terms declare (scaled by the fan-out factor the two
 * exchanged record counts fix), whose length is the agreed key count; the number
 * of rows the reply declares, itself held to the sender's exchanged record count;
 * and `slotBound` -- the sender's effective key count times that exchanged record
 * count, which is also what bounds the setup frame's element count, so an index at
 * or above it can address no value the sender could legitimately have sent. The
 * checks, in the order the fixed-width layout's own length check ran: exactly
 * `keyWidths.length * numRecords` cells, each count within that key's declared
 * width, the counts totalling no more than the slot bound, each cell's indices
 * strictly ascending (which is also what rejects a repeat) and inside the value
 * bound, and the words ending exactly at the last index word.
 *
 * @internal exported for the malformed-frame wire-message tests.
 */
export function decodeRaggedIndexTable(
  participantId: string,
  words: Int32Array,
  keyWidths: ReadonlyArray<number>,
  numRecords: number,
  slotBound: number,
): Array<KeyCells> {
  const refuse = (detail: string): never => {
    throw partnerProtocolError(
      participantId,
      `the single-pass distinct-value index table ${detail}`,
    );
  };
  const keyCount = keyWidths.length;
  const cellCount = keyCount * numRecords;
  if (words.length < cellCount)
    refuse("declares fewer cells than the agreed key and record counts");
  // Every word is either one of the cellCount count words or one of the index
  // words they account for, so the total is known before a single cell is read --
  // which is what lets the slot bound be enforced ahead of the allocation.
  const totalIndexWords = words.length - cellCount;
  if (totalIndexWords > slotBound)
    refuse("carries more candidate values than the sender's declared width");

  const values = new Int32Array(totalIndexWords);
  const starts: Array<Int32Array> = [];
  let read = 0;
  let written = 0;
  for (let j = 0; j < keyCount; ++j) {
    const keyStarts = new Int32Array(numRecords + 1);
    keyStarts[0] = written;
    for (let row = 0; row < numRecords; ++row) {
      const width = words[read++];
      if (width < 0 || width > keyWidths[j])
        refuse("declares a cell wider than the agreed terms declare for a key");
      if (read + width > words.length)
        refuse("is truncated inside a cell it declared");
      let previous = -1;
      for (let k = 0; k < width; ++k) {
        const index = words[read++];
        if (index <= previous)
          refuse(
            "declares a cell whose value indices are not strictly ascending",
          );
        if (index >= slotBound)
          refuse("names a value index outside the sender's declared value set");
        previous = index;
        values[written++] = index;
      }
      keyStarts[row + 1] = written;
    }
    starts.push(keyStarts);
  }
  if (read !== words.length)
    refuse("carries trailing words past its last cell");
  return starts.map((keyStarts) => new RaggedKeyCells(keyStarts, values));
}

// --- the record-level resolution ---------------------------------------------

// The candidate records each of one round's values stands for, on one party.
// Uniqueness is per VALUE, not per record: a value two candidate records share is
// ambiguous and leaves the round on a party that does not deduplicate, while those
// records' other candidates stay in it (docs/spec/PROTOCOL.md, Value-level round
// participation). A "many" party keeps such a value instead and stands it for the
// whole GROUP of its records holding it (The per-side rules), which is the whole of
// the per-side difference a deduplicating cardinality makes here. A record out of
// candidacy contributes nothing either way, which is how a value ambiguous in one
// round becomes usable in a later one.
//
// The sweep asks the two sides different questions, so each is built into the form
// that answers its own. The sender's side is asked whether the row the loop has
// reached takes part with a value (RoundValueParticipation); the receiver's is
// asked which rows a value stands for (RoundValueOwners). A "many" sender's group
// is the rows its own ascending loop reaches, so only the receiver's form ever
// needs the groups materialized. A "many" sender needs no form at all: dropping
// nothing leaves it asking a question fixed at yes for every value the sweep reads
// off its own candidate rows, which singlePassRoundValueParticipation.test.ts pins.

// The first pass both forms share: the first candidate row holding each of the
// round's values, and the values more than one candidate row holds.
/** @internal exported for the round-value participation differential test. */
export function roundValueFirstRows(
  cells: KeyCells,
  numRecords: number,
  outOfCandidacy: Uint8Array,
): { firstRow: Map<number, number>; recurring: Set<number> } {
  const firstRow = new Map<number, number>();
  const recurring = new Set<number>();
  for (let row = 0; row < numRecords; ++row) {
    if (outOfCandidacy[row]) continue;
    const width = cells.count(row);
    for (let k = 0; k < width; ++k) {
      const value = cells.valueAt(row, k);
      if (firstRow.has(value)) recurring.add(value);
      else firstRow.set(value, row);
    }
  }
  return { firstRow, recurring };
}

// The sender's form on a party that DROPS its duplicates: the values the round
// keeps, each against the one candidate row holding it.
/** @internal exported for the round-value participation differential test. */
export class RoundValueParticipation {
  private constructor(private readonly firstRow: Map<number, number>) {}

  static forRound(
    cells: KeyCells,
    numRecords: number,
    outOfCandidacy: Uint8Array,
  ): RoundValueParticipation {
    const { firstRow, recurring } = roundValueFirstRows(
      cells,
      numRecords,
      outOfCandidacy,
    );
    for (const value of recurring) firstRow.delete(value);
    return new RoundValueParticipation(firstRow);
  }

  /** Whether `row` takes part in this round with `value`. */
  holds(value: number, row: number): boolean {
    return this.firstRow.get(value) === row;
  }
}

class RoundValueOwners {
  // `groups` is absent on a party that drops its duplicates, where a value the
  // round keeps has exactly one owner and `firstRow` is the whole answer. On a
  // "many" party it holds the ascending group behind every value more than one of
  // its candidate rows contributed, which is the only case that allocates past the
  // single-owner map.
  private constructor(
    private readonly firstRow: Map<number, number>,
    private readonly groups: Map<number, Array<number>> | undefined,
  ) {}

  static forRound(
    cells: KeyCells,
    numRecords: number,
    outOfCandidacy: Uint8Array,
    keepsDuplicates: boolean,
  ): RoundValueOwners {
    const { firstRow, recurring } = roundValueFirstRows(
      cells,
      numRecords,
      outOfCandidacy,
    );
    if (!keepsDuplicates) {
      for (const value of recurring) firstRow.delete(value);
      return new RoundValueOwners(firstRow, undefined);
    }
    const groups = new Map<number, Array<number>>();
    for (const value of recurring) groups.set(value, []);
    // A second pass over the recurring values alone, in row order, so each group
    // ascends -- which is what makes the sweep's candidate order reproducible. A
    // row holding one value twice (a candidate producer whose set did not collapse
    // its repeats) stands in the group once.
    for (let row = 0; row < numRecords; ++row) {
      if (outOfCandidacy[row]) continue;
      const width = cells.count(row);
      for (let k = 0; k < width; ++k) {
        const group = groups.get(cells.valueAt(row, k));
        if (group !== undefined && group[group.length - 1] !== row)
          group.push(row);
      }
    }
    return new RoundValueOwners(firstRow, groups);
  }

  /** Appends every candidate row `value` stands for, ascending, to `into`. */
  appendOwners(value: number, into: Array<number>): void {
    const first = this.firstRow.get(value);
    if (first === undefined) return;
    const group = this.groups?.get(value);
    if (group === undefined) into.push(first);
    else for (const row of group) into.push(row);
  }
}

/**
 * Replay the cascade locally over both parties' index tables, applying the
 * record-level resolution rule (docs/spec/PROTOCOL.md, Record-level resolution).
 * For each linkage key in the agreed order:
 *
 * 1. lift the round's value-level matches to record-level candidate pairs, several
 *    equal value pairs between the same two records collapsing to one;
 * 2. sweep those pairs in ascending (sender row, receiver row) order, accepting a
 *    pair when NEITHER of its records has already been accepted in this round;
 * 3. remove every record appearing in ANY of the round's candidate pairs --
 *    accepted or not -- from candidacy for every later key.
 *
 * The order is fixed normatively because it decides which of two ambiguous matches
 * wins, and both of its components are role-derived, so both parties and any other
 * implementation reproduce the same table from the same frames. Nothing here reads
 * a map's iteration order, a value's bytes, or an encrypted element's position:
 * the sweep walks sender rows in ascending order and sorts each row's receiver
 * candidates, so the pairs are emitted already in the normative order.
 *
 * `sides` carries the receiver's own resolved cardinality into both steps that a
 * deduplicating one relaxes, and nothing else moves: the "many" side keeps a value
 * several of its candidate records hold and stands the round's position for that
 * group -- {@link RoundValueOwners} materializes the receiver's, while a "many"
 * sender's is the rows its own ascending loop reaches, so it builds no
 * {@link RoundValueParticipation} -- and step 2's acceptance clause binds the MANY
 * side's record alone, whether or not the "one" side's record has already been
 * accepted (docs/spec/PROTOCOL.md, The per-side rules). Which side is which is read
 * from the receiver's label, so this reproduces what the cascade computes from the
 * two parties' mirror labels for the same exchange.
 *
 * On inputs where every cell holds at most one value and neither side deduplicates
 * this reduces to the single-valued cascade: each round's candidate pairs are then
 * a partial one-to-one correspondence, so the sweep accepts every pair and removal
 * on a potential match coincides with removal on a match.
 *
 * @internal exported for the round-value participation differential test, which
 *   drives the sweep over instrumented cells.
 */
export function replaySinglePassCascade(
  receiverCells: Array<KeyCells>,
  senderCells: Array<KeyCells>,
  senderToReceiverDistinctValue: ReadonlyMap<number, number>,
  numReceiverRecords: number,
  numSenderRecords: number,
  sides: MultiplicitySides,
): AssociationTable {
  const receiverKeepsDuplicates = sides.localKeepsDuplicates;
  const senderKeepsDuplicates = sides.partnerKeepsDuplicates;
  // A side is held to one accepted pair per round exactly when it is NOT the "one"
  // side of a deduplicating cardinality -- which is to say, when the other side
  // does not carry the multiplicity.
  const senderAcceptsOnce = !receiverKeepsDuplicates;
  const receiverAcceptsOnce = !senderKeepsDuplicates;

  const receiverOut = new Uint8Array(numReceiverRecords);
  const senderOut = new Uint8Array(numSenderRecords);
  const pairedWith = new Int32Array(numReceiverRecords).fill(-1);
  // Only a "many" SENDER pairs several of its records with one receiver record.
  // The first of them stays in `pairedWith`, so every other cardinality allocates
  // nothing here and records a pairing by assignment alone -- which is also what
  // leaves the second-pair path unreachable from those cardinalities rather than
  // guarded within one.
  const furtherSenderRows = senderKeepsDuplicates
    ? new Map<number, Array<number>>()
    : undefined;
  const acceptPair =
    furtherSenderRows === undefined
      ? (receiverRow: number, senderRow: number): void => {
          pairedWith[receiverRow] = senderRow;
        }
      : (receiverRow: number, senderRow: number): void => {
          if (pairedWith[receiverRow] < 0) {
            pairedWith[receiverRow] = senderRow;
            return;
          }
          const further = furtherSenderRows.get(receiverRow);
          if (further === undefined)
            furtherSenderRows.set(receiverRow, [senderRow]);
          else further.push(senderRow);
        };
  const receiverCandidates: Array<number> = [];

  for (let j = 0; j < receiverCells.length; ++j) {
    const receiverOwners = RoundValueOwners.forRound(
      receiverCells[j],
      numReceiverRecords,
      receiverOut,
      receiverKeepsDuplicates,
    );
    // Absent on a sender that keeps its duplicates: the loop below reads each
    // value off the candidate row it has reached, and such a sender keeps every
    // value one of its candidate rows holds, so there is nothing left to ask. Only
    // a sender that drops them has a round its own rows can fall out of.
    const senderParticipation = senderKeepsDuplicates
      ? undefined
      : RoundValueParticipation.forRound(
          senderCells[j],
          numSenderRecords,
          senderOut,
        );
    const touchedReceiverRows: Array<number> = [];
    const touchedSenderRows: Array<number> = [];
    const acceptedReceiverRows = new Set<number>();

    for (let senderRow = 0; senderRow < numSenderRecords; ++senderRow) {
      if (senderOut[senderRow]) continue;
      receiverCandidates.length = 0;
      const width = senderCells[j].count(senderRow);
      for (let k = 0; k < width; ++k) {
        const senderValue = senderCells[j].valueAt(senderRow, k);
        // Not held here means the value left the round: ambiguous within the
        // sender's own round, which only a side that drops its duplicates does.
        if (
          senderParticipation !== undefined &&
          !senderParticipation.holds(senderValue, senderRow)
        )
          continue;
        const receiverValue = senderToReceiverDistinctValue.get(senderValue);
        if (receiverValue === undefined) continue;
        receiverOwners.appendOwners(receiverValue, receiverCandidates);
      }
      if (receiverCandidates.length === 0) continue;
      // Ascending here plus the ascending sender-row loop is exactly the normative
      // lexicographic order. Each of the sender row's values, at most the width
      // its key declares, contributes one receiver row, or the group behind it
      // where the receiver deduplicates.
      receiverCandidates.sort((a, b) => a - b);
      touchedSenderRows.push(senderRow);
      let previous = -1;
      let senderAccepted = false;
      for (const receiverRow of receiverCandidates) {
        // Several equal value pairs between the same two records are one
        // candidate pair.
        if (receiverRow === previous) continue;
        previous = receiverRow;
        touchedReceiverRows.push(receiverRow);
        if (senderAcceptsOnce && senderAccepted) continue;
        if (receiverAcceptsOnce) {
          if (acceptedReceiverRows.has(receiverRow)) continue;
          acceptedReceiverRows.add(receiverRow);
        }
        acceptPair(receiverRow, senderRow);
        senderAccepted = true;
      }
    }

    for (const row of touchedReceiverRows) receiverOut[row] = 1;
    for (const row of touchedSenderRows) senderOut[row] = 1;
  }

  // Walking the receiver's rows ascending, and each row's further sender rows in
  // the order the ascending sweep accepted them, leaves the table ordered by
  // (receiver row, sender row) -- the local half ascending, strictly so wherever a
  // receiver record stands in one pair.
  const result: AssociationTable = [[], []];
  for (let row = 0; row < numReceiverRecords; ++row) {
    if (pairedWith[row] < 0) continue;
    result[0].push(row);
    result[1].push(pairedWith[row]);
    const further = furtherSenderRows?.get(row);
    if (further === undefined) continue;
    for (const senderRow of further) {
      result[0].push(row);
      result[1].push(senderRow);
    }
  }
  return result;
}

// Pack a flat array of value indices as a little-endian Int32 frame (the
// distinct-value index table). Endianness is fixed explicitly so the frame is
// byte-for-byte identical across machines; Int32 covers the -1 marker and every
// value index.
/** @internal exported for the wire-message test. */
export function encodeInt32LE(values: ReadonlyArray<number>): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < values.length; ++i) view.setInt32(i * 4, values[i], true);
  return bytes;
}

// Decode a little-endian Int32 frame (see encodeInt32LE). A length that is not a
// whole number of int32s is a protocol error, not a silent truncation; reads
// through a DataView so a non-aligned buffer cannot fault.
/** @internal exported for the wire-message test. */
export function decodeInt32LE(bytes: Uint8Array): Int32Array {
  if (bytes.byteLength % 4 !== 0)
    throw new Error(
      "protocol error: single-pass distinct-value index table is not a whole " +
        "number of int32s",
    );
  const count = bytes.byteLength / 4;
  const values = new Int32Array(count);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < count; ++i) values[i] = view.getInt32(i * 4, true);
  return values;
}

// Pack the sender's whole single-pass reply -- setup, response, the record count,
// and the distinct-value index table -- as one binary frame, so a high-latency
// channel pays a single round-trip rather than one per piece. Layout (all
// little-endian):
//   uint32 setupLen | setup bytes
//   uint32 responseLen | response bytes
//   uint32 numRecords
//   the rest: the distinct-value index table, as Int32 (encodeInt32LE)
// setup and response carry explicit lengths; the index table is the remainder, so
// its length is implied by the frame size. The table's words are the fixed-width
// or the ragged layout, chosen by the sender's declared width and read the same
// way on both sides with no wire flag (getSortedDistinctValueIndices, and
// decodeFixedWidthIndexTable / decodeRaggedIndexTable). See docs/spec/PROTOCOL.md.
/** @internal exported for the wire-message test. */
export function encodeSinglePassReply(
  setup: Uint8Array,
  response: Uint8Array,
  numRecords: number,
  distinctValueIndices: ReadonlyArray<number>,
): Uint8Array {
  const indexBytes = encodeInt32LE(distinctValueIndices);
  const out = new Uint8Array(
    4 + setup.byteLength + 4 + response.byteLength + 4 + indexBytes.byteLength,
  );
  const view = new DataView(out.buffer);
  let offset = 0;
  view.setUint32(offset, setup.byteLength, true);
  offset += 4;
  out.set(setup, offset);
  offset += setup.byteLength;
  view.setUint32(offset, response.byteLength, true);
  offset += 4;
  out.set(response, offset);
  offset += response.byteLength;
  view.setUint32(offset, numRecords, true);
  offset += 4;
  out.set(indexBytes, offset);
  return out;
}

// Split a combined single-pass reply frame (see encodeSinglePassReply) back into
// its parts. A frame too short for a length it declares is a protocol error, not a
// silent under-read; reads through a DataView so a non-aligned buffer cannot fault.
/** @internal exported for the wire-message test. */
export function decodeSinglePassReply(bytes: Uint8Array): {
  setup: Uint8Array;
  response: Uint8Array;
  numRecords: number;
  distinctValueIndices: Int32Array;
} {
  if (!(bytes instanceof Uint8Array))
    throw new Error("protocol error: single-pass reply is not a binary frame");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  const readSlice = (what: string): Uint8Array => {
    if (offset + 4 > bytes.byteLength)
      throw new Error(
        `protocol error: single-pass reply truncated reading ${what} length`,
      );
    const len = view.getUint32(offset, true);
    offset += 4;
    if (offset + len > bytes.byteLength)
      throw new Error(
        `protocol error: single-pass reply truncated reading ${what}`,
      );
    const slice = bytes.subarray(offset, offset + len);
    offset += len;
    return slice;
  };
  const setup = readSlice("setup");
  const response = readSlice("response");
  if (offset + 4 > bytes.byteLength)
    throw new Error(
      "protocol error: single-pass reply truncated reading record count",
    );
  const numRecords = view.getUint32(offset, true);
  offset += 4;
  // The distinct-value index table is the remainder; decodeInt32LE rejects a
  // non-int32 length.
  const distinctValueIndices = decodeInt32LE(bytes.subarray(offset));
  return { setup, response, numRecords, distinctValueIndices };
}

async function exchangeMappedElements(
  id: string,
  conn: MessageConnection,
  log: {
    info: (...msg: Array<unknown>) => void;
    debug: (...msg: Array<unknown>) => void;
  },
  sendFirst: boolean,
  values: IterationMap,
): Promise<IterationMap> {
  if (sendFirst) {
    log.debug(`${id}: sending own mapped elements`);
    await conn.send(values);
    log.debug(`${id}: waiting for response`);
    const result = await receiveParsed(conn, associationAndIterationArray);
    log.debug(`${id}: received other mapped elements`);
    return result;
  } else {
    // Send-before-parse: receive the partner's elements, send ours, then
    // validate. Sending before parsing ensures a malformed final frame does
    // not strand the partner waiting for our response.
    const rawData = await conn.receive();
    log.debug(`${id}: received other mapped elements`);
    log.debug(`${id}: sending own mapped elements`);
    await conn.send(values);
    return parseOrProtocolError(associationAndIterationArray, rawData);
  }
}
