import { partnerProtocolError } from "../utils/partnerIndices";

/**
 * One round's `(record, value)` incidence for this party: position `k` of the
 * round's PSI set stands for the local rows at
 * `rows[groupStarts[k] .. groupStarts[k + 1])`, ascending.
 *
 * `groupStarts` is absent where every position stands for exactly one row (a
 * non-deduplicating party, which drops a value two or more of its rows
 * hold). A deduplicating ("many") party keeps such a value once, standing it
 * for the group of rows holding it (docs/spec/PROTOCOL.md, Matching
 * multiplicity: the (record, value) incidence).
 *
 * Either way the list is row-major: one record's candidates are contiguous
 * and records ascend, which is what makes ascending position order ascending
 * own-row order (docs/spec/PROTOCOL.md, The round's candidate list is
 * row-major).
 */
export interface RoundCandidates {
  readonly rows: Array<number>;
  readonly groupStarts?: Array<number>;
}

/** @internal how many positions this round's PSI set holds. */
export function candidatePositionCount(candidates: RoundCandidates): number {
  return candidates.groupStarts
    ? candidates.groupStarts.length - 1
    : candidates.rows.length;
}

/**
 * The half-open slice of `rows` that `position` stands for. Without groups a
 * position IS its row, so the slice is the one-element `[k, k + 1)` and the
 * two layouts read through one loop.
 *
 * @internal
 */
export function positionRowRange(
  candidates: RoundCandidates,
  position: number,
): [number, number] {
  return candidates.groupStarts
    ? [candidates.groupStarts[position], candidates.groupStarts[position + 1]]
    : [position, position + 1];
}

/**
 * The grouping element a round's position-naming frame holds, in whichever
 * of its two forms the sending party's side of the resolved cardinality
 * entails: run lengths (one positive whole number per record owning at least
 * one matched position, in ascending own-row order) where that side does not
 * deduplicate, and an owner list per matched position where it does
 * (docs/spec/PROTOCOL.md, The per-round grouping the two frames hold).
 *
 * The schema that reads it off the wire bounds the structure alone
 * (`roundGroupingElement`, participant.ts); which form a party is required
 * to have sent follows the resolved cardinality both parties hold, so it is
 * decided here.
 */
export type RoundGroupingField = ReadonlyArray<number | ReadonlyArray<number>>;

/**
 * One party's partition of a round's matched positions into the records
 * owning them, in the form the sweep reads.
 *
 * An **ordinal** is a record's rank, from zero, among that party's records
 * owning at least one of the round's matched positions, taken in ascending
 * own-row order. The run-length form states the same partition as the
 * degenerate case of the owner-list one, so both read through this shape.
 */
export interface RoundOwnership {
  /** How many records the grouping names. */
  readonly recordCount: number;
  /** The round's matched positions, ascending; slot `t` holds `positions[t]`. */
  readonly positions: Int32Array;
  /** The ordinals owning slot `t`: `ordinals[starts[t] .. starts[t + 1])`. */
  readonly ordinals: Int32Array;
  /** Slot boundaries into `ordinals`, one more entry than there are slots. */
  readonly starts: Int32Array;
  /** The slot each matched position occupies. */
  readonly slotOfPosition: Map<number, number>;
  /**
   * The lowest matched position each ordinal owns, which is the canonical
   * position the round's mapped-element entry for that record names
   * (docs/spec/PROTOCOL.md, The final mapped-element entry names a canonical
   * position).
   */
  readonly canonicalPosition: Int32Array;
}

/** This party's own grouping for a round, ready to send and to sweep with. */
export interface LocalRoundGrouping {
  /** The field the round's frame holds, or `undefined` where it is omitted. */
  readonly field: RoundGroupingField | undefined;
  readonly ownership: RoundOwnership;
  /** The local row each ordinal stands for. */
  readonly rowOfOrdinal: Int32Array;
}

/** What a received grouping is checked against, all of it locally held. */
export interface RoundGroupingBounds {
  /** This party's participant id, prefixed on a refusal. */
  readonly participantId: string;
  /**
   * The most of a round's matched positions one record of the sending party
   * may own: `w[j]`, the width the agreed terms declare for the key, times
   * 20, the factor that party's own standardization may declare. The factor
   * is admitted unconditionally, the cascade holding no quotient to recover
   * it with as single-pass does (docs/spec/PROTOCOL.md, The checks stay
   * local).
   */
  readonly maxPositionsPerRecord: number;
  /** The sending party's record count, declared on the terms exchange. */
  readonly partnerRecordCount: number;
  /**
   * Whether the sending party's side of the resolved cardinality
   * deduplicates, which is what fixes the form its grouping takes. Both
   * parties hold the resolved pair, so neither reads the form off the frame.
   */
  readonly ownerLists: boolean;
}

// The range the slot index below addresses. A position names an element of
// the round's own set, which is memory-bound orders of magnitude short of
// this, so no legitimate exchange reaches it; the bound the position list
// passes upstream is the partner's declared element count, which does reach
// past it, so the ceiling is stated here rather than assumed.
const POSITION_RANGE = 2 ** 31;

// The matched positions the grouping partitions, ascending. Distinctness is
// enforced upstream on both frames -- an association table's local half may
// not repeat an entry and the original-index list is held to the same rule
// (utils/partnerIndices.ts) -- and is re-checked here so this module's
// slotting cannot silently mis-attribute a position a caller admitted twice.
// A position the index cannot hold exactly is refused before it is stored.
function sortedPositions(
  participantId: string,
  matchedPositions: ReadonlyArray<number>,
): Int32Array {
  for (const position of matchedPositions)
    if (
      !Number.isInteger(position) ||
      position < 0 ||
      position >= POSITION_RANGE
    )
      throw partnerProtocolError(
        participantId,
        "the round's grouping partitions a position list naming a position " +
          "outside that round's candidate set",
      );
  const positions = Int32Array.from(matchedPositions).sort();
  for (let t = 1; t < positions.length; ++t)
    if (positions[t] === positions[t - 1])
      throw partnerProtocolError(
        participantId,
        "the round's grouping partitions a position list that repeats an entry",
      );
  return positions;
}

function slotIndex(positions: Int32Array): Map<number, number> {
  const slotOfPosition = new Map<number, number>();
  for (let t = 0; t < positions.length; ++t)
    slotOfPosition.set(positions[t], t);
  return slotOfPosition;
}

// The canonical position of every ordinal: the lowest matched position it
// owns. Slots ascend with the positions, so the first slot an ordinal appears
// in holds it.
function canonicalPositions(
  positions: Int32Array,
  ordinals: Int32Array,
  starts: Int32Array,
  recordCount: number,
): Int32Array {
  const canonical = new Int32Array(recordCount).fill(-1);
  for (let t = 0; t < positions.length; ++t)
    for (let o = starts[t]; o < starts[t + 1]; ++o)
      if (canonical[ordinals[o]] < 0) canonical[ordinals[o]] = positions[t];
  return canonical;
}

// One owner per position, ordinals ascending with the positions: what an
// absent grouping states, and the shape a run-length form of all ones takes.
function oneOwnerPerPosition(positions: Int32Array): RoundOwnership {
  const count = positions.length;
  const ordinals = new Int32Array(count);
  const starts = new Int32Array(count + 1);
  for (let t = 0; t < count; ++t) {
    ordinals[t] = t;
    starts[t + 1] = t + 1;
  }
  return {
    recordCount: count,
    positions,
    ordinals,
    starts,
    slotOfPosition: slotIndex(positions),
    canonicalPosition: Int32Array.from(positions),
  };
}

function readRunLengths(
  positions: Int32Array,
  field: RoundGroupingField,
  bounds: RoundGroupingBounds,
): RoundOwnership {
  const { participantId } = bounds;
  const ordinals = new Int32Array(positions.length);
  const starts = new Int32Array(positions.length + 1);
  let filled = 0;
  for (let run = 0; run < field.length; ++run) {
    const length = field[run];
    if (typeof length !== "number")
      throw partnerProtocolError(
        participantId,
        "the round's grouping states an owner list where its side of the " +
          "resolved cardinality takes run lengths",
      );
    if (!Number.isInteger(length) || length < 1)
      throw partnerProtocolError(
        participantId,
        "the round's grouping holds a run length that is not a positive " +
          "whole number",
      );
    if (length > bounds.maxPositionsPerRecord)
      throw partnerProtocolError(
        participantId,
        "the round's grouping holds a run longer than the candidate count " +
          `one record may contribute to the key (${bounds.maxPositionsPerRecord})`,
      );
    if (filled + length > positions.length)
      throw partnerProtocolError(
        participantId,
        "the round's grouping holds run lengths summing past the matched " +
          "positions the frame names",
      );
    for (let k = 0; k < length; ++k) ordinals[filled + k] = run;
    filled += length;
  }
  if (filled !== positions.length)
    throw partnerProtocolError(
      participantId,
      "the round's grouping holds run lengths summing to " +
        `${filled}, not the ${positions.length} matched position(s) the frame ` +
        "names",
    );
  for (let t = 0; t <= positions.length; ++t) starts[t] = t;
  return {
    recordCount: field.length,
    positions,
    ordinals,
    starts,
    slotOfPosition: slotIndex(positions),
    canonicalPosition: canonicalPositions(
      positions,
      ordinals,
      starts,
      field.length,
    ),
  };
}

function readOwnerLists(
  positions: Int32Array,
  field: RoundGroupingField,
  bounds: RoundGroupingBounds,
): RoundOwnership {
  const { participantId } = bounds;
  if (field.length !== positions.length)
    throw partnerProtocolError(
      participantId,
      `the round's grouping holds ${field.length} owner list(s), not the ` +
        `${positions.length} matched position(s) the frame names`,
    );
  const starts = new Int32Array(positions.length + 1);
  const flattened: Array<number> = [];
  let highest = -1;
  for (let t = 0; t < field.length; ++t) {
    const owners = field[t];
    if (typeof owners === "number")
      throw partnerProtocolError(
        participantId,
        "the round's grouping states run lengths where its side of the " +
          "resolved cardinality takes an owner list per position",
      );
    if (owners.length === 0)
      throw partnerProtocolError(
        participantId,
        "the round's grouping leaves a matched position with no owner",
      );
    let previous = -1;
    for (const ordinal of owners) {
      if (!Number.isInteger(ordinal) || ordinal <= previous)
        throw partnerProtocolError(
          participantId,
          "the round's grouping holds an owner list that is not a strictly " +
            "ascending list of whole numbers",
        );
      previous = ordinal;
      if (ordinal > highest) highest = ordinal;
      flattened.push(ordinal);
    }
    starts[t + 1] = flattened.length;
  }
  // The ordinals run 0 through k - 1 with each appearing at least once, so k
  // can never exceed the entry count the frame holds. Applied here it is the
  // completeness check below read as a frame-local ceiling, and it runs BEFORE
  // anything is sized by an ordinal: the partner's declared record count is
  // authenticated but reaches MAX_RECORD_COUNT, so one entry naming a high
  // ordinal would otherwise size an allocation the frame never paid for.
  const recordCount = highest + 1;
  if (recordCount > flattened.length)
    throw partnerProtocolError(
      participantId,
      "the round's grouping skips an ordinal, so it names a rank no record " +
        "holds",
    );
  if (recordCount > bounds.partnerRecordCount)
    throw partnerProtocolError(
      participantId,
      `the round's grouping names ${recordCount} record(s), more than the ` +
        `${bounds.partnerRecordCount} record(s) the partner counted`,
    );
  const occurrences = new Int32Array(recordCount);
  for (const ordinal of flattened) ++occurrences[ordinal];
  for (let ordinal = 0; ordinal < recordCount; ++ordinal) {
    if (occurrences[ordinal] === 0)
      throw partnerProtocolError(
        participantId,
        "the round's grouping skips an ordinal, so it names a rank no record " +
          "holds",
      );
    if (occurrences[ordinal] > bounds.maxPositionsPerRecord)
      throw partnerProtocolError(
        participantId,
        "the round's grouping gives one record more positions than the " +
          "candidate count it may contribute to the key " +
          `(${bounds.maxPositionsPerRecord})`,
      );
  }
  const ordinals = Int32Array.from(flattened);
  return {
    recordCount,
    positions,
    ordinals,
    starts,
    slotOfPosition: slotIndex(positions),
    canonicalPosition: canonicalPositions(
      positions,
      ordinals,
      starts,
      recordCount,
    ),
  };
}

/**
 * Check a partner's grouping for one round against state this party already
 * holds, and read it into the partition the sweep runs over.
 *
 * Every failure is a classified `protocol` error raised at the round rather
 * than after the last one (docs/spec/PROTOCOL.md, The checks stay local).
 * No check here takes its ceiling from the frame under check: the
 * matched-position count is the index list the round's own checks already
 * bounded, the per-record ceiling is derived from the agreed terms, and the
 * record count is the one the partner declared on the terms exchange. No
 * allocation is sized by a partner value either: the ragged form's record
 * count is held to the frame's own entry count before it sizes anything, so
 * the memory a round spends stays proportional to the bytes it received.
 *
 * @param field - The grouping as it arrived, or `undefined` where the frame
 *   omitted it, which states one run of 1 per matched position.
 * @param matchedPositions - The positions the frame names for the sending
 *   party, in the frame's own order.
 */
export function readPartnerRoundGrouping(
  field: RoundGroupingField | undefined,
  matchedPositions: ReadonlyArray<number>,
  bounds: RoundGroupingBounds,
): RoundOwnership {
  const positions = sortedPositions(bounds.participantId, matchedPositions);
  if (field === undefined) return oneOwnerPerPosition(positions);
  return bounds.ownerLists
    ? readOwnerLists(positions, field, bounds)
    : readRunLengths(positions, field, bounds);
}

/**
 * This party's own grouping for one round, derived from the candidate list
 * it built and the positions the round matched.
 *
 * The field is omitted for a round in which each matched position is the
 * only one its record owns -- the case a party no producer widened is always
 * in, whatever the resolved cardinality -- so such a round puts on both frames
 * what the single-valued cascade puts there, entry for entry once each frame's
 * own order is canonicalized (docs/spec/PROTOCOL.md, An absent grouping is all
 * ones).
 *
 * @param ownerLists - Whether this party's own side of the resolved
 *   cardinality deduplicates, which fixes the form it sends.
 */
export function describeLocalRoundGrouping(
  candidates: RoundCandidates,
  matchedPositions: ReadonlyArray<number>,
  ownerLists: boolean,
): LocalRoundGrouping {
  const positions = Int32Array.from(new Set(matchedPositions)).sort();
  const ordinalOfRow = new Map<number, number>();
  const rows: Array<number> = [];
  for (const position of positions) {
    const [from, to] = positionRowRange(candidates, position);
    for (let r = from; r < to; ++r) rows.push(candidates.rows[r]);
  }
  rows.sort((a, b) => a - b);
  for (const row of rows)
    if (!ordinalOfRow.has(row)) ordinalOfRow.set(row, ordinalOfRow.size);

  const starts = new Int32Array(positions.length + 1);
  const flattened: Array<number> = [];
  for (let t = 0; t < positions.length; ++t) {
    const [from, to] = positionRowRange(candidates, positions[t]);
    for (let r = from; r < to; ++r)
      flattened.push(ordinalOfRow.get(candidates.rows[r])!);
    starts[t + 1] = flattened.length;
  }
  const ordinals = Int32Array.from(flattened);
  const recordCount = ordinalOfRow.size;
  const ownership: RoundOwnership = {
    recordCount,
    positions,
    ordinals,
    starts,
    slotOfPosition: slotIndex(positions),
    canonicalPosition: canonicalPositions(
      positions,
      ordinals,
      starts,
      recordCount,
    ),
  };
  const rowOfOrdinal = new Int32Array(recordCount);
  for (const [row, ordinal] of ordinalOfRow) rowOfOrdinal[ordinal] = row;
  return {
    field: groupingField(ownership, ownerLists),
    ownership,
    rowOfOrdinal,
  };
}

/**
 * Whether any of this party's records owns more than one of the round's
 * matched positions -- the widening a candidate set produces, and the whole of
 * what makes a grouping worth stating: where no record does, every matched
 * position is the only one its record owns and the default reading is the
 * partition (docs/spec/PROTOCOL.md, An absent grouping is all ones).
 *
 * @internal
 */
export function ownsSeveralPositions(ownership: RoundOwnership): boolean {
  return ownership.ordinals.length !== ownership.recordCount;
}

function groupingField(
  ownership: RoundOwnership,
  ownerLists: boolean,
): RoundGroupingField | undefined {
  if (!ownsSeveralPositions(ownership)) return undefined;
  if (ownerLists) {
    const owners: Array<Array<number>> = [];
    for (let t = 0; t < ownership.positions.length; ++t)
      owners.push([
        ...ownership.ordinals.subarray(
          ownership.starts[t],
          ownership.starts[t + 1],
        ),
      ]);
    return owners;
  }
  const runs: Array<number> = new Array<number>(ownership.recordCount).fill(0);
  for (const ordinal of ownership.ordinals) ++runs[ordinal];
  return runs;
}
