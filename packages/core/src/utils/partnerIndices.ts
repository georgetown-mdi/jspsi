// Every index list a party receives from its exchange partner addresses state the
// RECEIVING party owns -- its own rows, its own per-round candidate positions, or
// the partner's rows as counted on the authenticated terms exchange. The shared
// chokepoint below is where such a list is checked against that state before it
// indexes anything, drives payload preparation, or reaches the self-attested
// record, so the whole class is closed in one place rather than per call site.
//
// Every bound passed in is derived locally (an array this party built) or from
// authenticated session state (a count carried on the terms exchange), never from
// the frame being checked. The wire schemas upstream (participant.ts
// associationTableMessage / numberArrayMessage, link.ts
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

/**
 * Requires a partner-supplied list to carry exactly the number of entries this
 * party's own state implies.
 *
 * @param participantId - This party's participant id.
 * @param what - Names the list, for the error message.
 * @param count - The received entry count.
 * @param expected - The count this party derived locally.
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
      `${what} carries ${count} entries, expected ${expected}`,
    );
}

/**
 * Requires every entry of a partner-supplied index list to be a whole number in
 * `[0, exclusiveBound)`, with no entry repeated.
 *
 * Distinctness is the protocol invariant on all three matching paths -- one-to-one
 * matching pairs each row at most once -- and it is what caps the list's LENGTH at
 * `exclusiveBound`, since a longer list cannot hold distinct in-range entries. The
 * length is therefore not a separate argument. Duplicate detection holds at most
 * that many entries, so its cost is bounded by the same authenticated quantity.
 *
 * @param participantId - This party's participant id.
 * @param what - Names the list, for the error message.
 * @param indices - The partner-supplied entries, in received order.
 * @param exclusiveBound - The count of addressable slots on this side. Derived
 *   locally or from authenticated session state, never from the received frame.
 * @throws A `"protocol"` {@link ConnectionError} on a non-integer, out-of-range,
 *   or repeated entry.
 */
export function assertPartnerIndices(
  participantId: string,
  what: string,
  indices: ReadonlyArray<number>,
  exclusiveBound: number,
): void {
  if (indices.length > exclusiveBound)
    throw partnerProtocolError(
      participantId,
      `${what} carries ${indices.length} entries, more than the ` +
        `${exclusiveBound} this side can address`,
    );
  const seen = new Set<number>();
  for (const index of indices) {
    if (!Number.isInteger(index) || index < 0 || index >= exclusiveBound)
      throw partnerProtocolError(
        participantId,
        `${what} carries an index outside [0, ${exclusiveBound})`,
      );
    if (seen.has(index))
      throw partnerProtocolError(participantId, `${what} repeats an index`);
    seen.add(index);
  }
}
