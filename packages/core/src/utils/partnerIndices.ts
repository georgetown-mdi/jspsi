// Every index list a party receives from its exchange partner addresses state the
// RECEIVING party owns -- its own rows, its own per-round candidate positions, or
// the partner's rows as counted on the authenticated terms exchange. The shared
// chokepoint below is where such a list is checked against that state before it
// indexes anything, drives payload preparation, or reaches the self-attested
// record, so the whole class is closed in one place rather than per call site.
//
// Every bound passed in is derived locally (an array this party built) or from
// authenticated session state (a count carried on the terms exchange), never from
// the frame being checked. Where one half of a received table must instead match
// the length of the other, the two-half form below range-checks the anchoring
// half first, so the count the second half is held to is pinned to one of those
// quantities rather than chosen by the partner. The wire schemas upstream
// (participant.ts associationTableMessage / numberArrayMessage, link.ts
// associationAndIterationArray) accept any FINITE number, so integrality is
// checked here too: a fractional index addresses nothing and would read as
// `undefined`.
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
 * Requires a partner-supplied list to carry exactly the number of entries this
 * party's own state implies.
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
      `${what} carries ${entryCount(count)}, expected ${expected}`,
    );
}

// A V8 Set entry costs about 21 bytes retained and about 40 bytes at the
// transient rehash peak -- 2M integer entries on the pinned runtime (node
// v26.7.0) measure ~42 MB retained after a forced gc and ~80 MB at the peak
// before one -- where a Uint8Array bitmap costs one byte per addressable slot
// however short the list is. Below this ratio the bitmap allocates less. The
// constant sits between the retained and the peak cost, so the comparison stays
// conservative whichever of the two binds, and an error in either direction
// moves the allocation by a constant factor rather than by the partner's bound.
const SET_ENTRY_BYTES = 32;

// Duplicate detection over `[0, exclusiveBound)`, backed by whichever of the two
// forms allocates less for the list at hand: the bitmap wins at the seams whose
// bound is one of this party's own counts, which are the seams whose honest lists
// run to millions of entries. The ratio is load-bearing rather than a tuning
// choice: a bound may be the partner's row count or a per-message element bound,
// authenticated but as large as MAX_RECORD_COUNT, and a bitmap sized by that
// unconditionally would let a three-entry frame demand a terabyte -- which V8
// answers by aborting the process, not by throwing. Choosing by ratio caps the
// allocation at min(exclusiveBound, SET_ENTRY_BYTES * length) bytes, never more
// than the frame's own already-materialized entries imply.
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

/** Optional per-list rules beyond whole, in-range, and non-repeating. */
export interface PartnerIndexRules {
  /**
   * Require the entries to arrive in ascending order. Set only where the order
   * is a property of the list rather than an incidental one: an association
   * table's local half is read in that order downstream (the result rows, and
   * the exchange record's reconstruction of them), so a partner-resolved table
   * that does not carry it is refused here rather than silently reordering what
   * those readers reproduce.
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
   * The grouping is what keeps that relaxation from handing the partner the
   * pairing: flat distinctness is replaced by injectivity modulo the grouping,
   * so the partner can neither merge two of this party's groups onto one row nor
   * split one across two. Distinctness is also what otherwise caps a list's
   * LENGTH at `exclusiveBound`, so a caller setting this must pin the length
   * against a locally computed count first ({@link assertPartnerIndexCount});
   * this function then bounds the entries alone.
   */
  repeatsGroupedBy?: PartnerIndexGrouping;
}

/**
 * Requires every entry of a partner-supplied index list to be a whole number in
 * `[0, exclusiveBound)`, with no entry repeated.
 *
 * Distinctness is the protocol invariant on all three matching paths -- one-to-one
 * matching pairs each row at most once -- and it is what caps the list's LENGTH at
 * `exclusiveBound`, since a longer list cannot hold distinct in-range entries. The
 * length is therefore not a separate argument, except under
 * `rules.repeatsGroupedBy`, which relaxes distinctness to injectivity modulo the
 * grouping it carries and leaves the length to the caller's own count check.
 *
 * @param participantId - This party's participant id.
 * @param what - Names the list, for the error message.
 * @param indices - The partner-supplied entries, in received order.
 * @param exclusiveBound - The count of addressable slots on this side. Derived
 *   locally or from authenticated session state, never from the received frame.
 * @param rules - Optional additional properties the list must carry; see
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
      grouping.positions.length !== indices.length)
  )
    throw new Error(
      `${what}: a grouped index check needs one group per entry, given ` +
        `${grouping.rounds.length} round(s) and ${grouping.positions.length} ` +
        `position(s) for ${entryCount(indices.length)}`,
    );
  if (grouping === undefined && indices.length > exclusiveBound)
    throw partnerProtocolError(
      participantId,
      `${what} carries ${entryCount(indices.length)}, more than the ` +
        `${exclusiveBound} this side can address`,
    );
  const repeats = createRepeatDetector(indices.length, exclusiveBound);
  // Which index each group has taken so far, by round and then by position. Only
  // the first entry of a group consults the repeat detector, so a legitimate
  // repeat within one group never reads as one across groups.
  const indexByGroup = new Map<number, Map<number, number>>();
  let previous = -1;
  // Each entry is checked in one pass, the repeat before the order, so a list that
  // both repeats and descends is reported as the repeat -- the narrower of the two
  // faults, and the one every seam checks.
  for (let entry = 0; entry < indices.length; ++entry) {
    const index = indices[entry];
    if (!Number.isInteger(index))
      throw partnerProtocolError(
        participantId,
        `${what} carries an entry that is not a whole number`,
      );
    if (index < 0 || index >= exclusiveBound)
      throw partnerProtocolError(
        participantId,
        `${what} carries an index outside [0, ${exclusiveBound})`,
      );
    if (grouping) {
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

// `repeatsGroupedBy` is deliberately not offered here: the two-half form holds the
// partner half to the LENGTH of the range-checked local half, and that length is a
// local quantity only while distinctness caps it at the local half's own bound. A
// seam whose table admits a repeat therefore checks its halves itself, against a
// count it computed, rather than through this form.
/** One half of a partner-supplied association table, with what bounds it. */
export interface PartnerIndexTableHalf extends Omit<
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
 * Requires both halves of a partner-supplied association table to hold whole,
 * in-range, non-repeating indices, and to pair up: one entry of each half per
 * matched record.
 *
 * The halves are checked in this order for a reason the callers cannot enforce
 * themselves: the pairing is expressed as the partner half carrying as many
 * entries as the local half, and that expected count is only a local quantity
 * once the local half has been range-checked -- which caps its length at
 * `localHalf.exclusiveBound`. Running the halves through this one entry point
 * keeps the order out of the callers' hands.
 *
 * Either half may additionally carry the {@link PartnerIndexRules} a seam's own
 * table has to satisfy, applied to that half alone.
 *
 * @param participantId - This party's participant id.
 * @param localHalf - The half addressing state this party owns, whose bound is
 *   therefore one of its own counts.
 * @param partnerHalf - The half addressing the partner's rows or masked-set
 *   elements, bounded by a count carried on the authenticated terms exchange.
 * @throws A `"protocol"` {@link ConnectionError} on a bad entry in either half,
 *   on halves of unequal length, or on a half breaking a rule it declared.
 */
export function assertPartnerIndexTable(
  participantId: string,
  localHalf: PartnerIndexTableHalf,
  partnerHalf: PartnerIndexTableHalf,
): void {
  assertPartnerIndices(
    participantId,
    localHalf.what,
    localHalf.indices,
    localHalf.exclusiveBound,
    { ascending: localHalf.ascending },
  );
  assertPartnerIndexCount(
    participantId,
    partnerHalf.what,
    partnerHalf.indices.length,
    localHalf.indices.length,
  );
  assertPartnerIndices(
    participantId,
    partnerHalf.what,
    partnerHalf.indices,
    partnerHalf.exclusiveBound,
    { ascending: partnerHalf.ascending },
  );
}
