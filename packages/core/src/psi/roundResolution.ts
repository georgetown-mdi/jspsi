import { InternalConsistencyError } from "../errors";

/**
 * Which of a round's two sides may stand in more than one accepted pair.
 *
 * Both flags are `true` under `one-to-one`. A deduplicating cardinality
 * relaxes the clause on the "one" side alone -- a pair is accepted when the
 * record on the MANY side has not already been accepted in this round,
 * whether or not the record on the "one" side has -- and `many-to-many`
 * relaxes both, accepting every candidate pair (docs/spec/PROTOCOL.md, The
 * per-side rules).
 */
export interface RoundAcceptance {
  readonly senderAcceptsOnce: boolean;
  readonly receiverAcceptsOnce: boolean;
}

/** What one round's sweep produces. */
export interface ResolvedRound {
  /** The accepted pairs' sender ranks, in the sweep's own order. */
  readonly acceptedSenderRanks: Array<number>;
  /** The accepted pairs' receiver ranks, positionally paired with the above. */
  readonly acceptedReceiverRanks: Array<number>;
  /**
   * Every sender rank standing in ANY of the round's candidate pairs,
   * accepted or discarded, ascending and without repeats: the round's
   * removal set for that party (docs/spec/PROTOCOL.md, Removal on a
   * potential match).
   */
  readonly touchedSenderRanks: Array<number>;
  /** The receiver's half of the same removal set. */
  readonly touchedReceiverRanks: Array<number>;
}

/**
 * The record-level resolution both linkage strategies run, over the same
 * candidate-pair input: the deterministic greedy sweep of
 * docs/spec/PROTOCOL.md, Record-level resolution: canonical order and
 * tiebreak.
 *
 * The two parties reach a cascade round's association table by different
 * routes -- each resolving its own round from the two groupings the round's
 * frames hold -- where single-pass has one resolver. Writing the sweep once
 * and calling it from both is what makes the strategies' identical table a
 * property of the structure rather than of the tests
 * (docs/spec/PROTOCOL.md, One sweep, called by both strategies).
 *
 * A **rank** is a record's place, from zero, among the records its own party
 * stands in the round with, taken in ascending own-row order. Sweeping in
 * ascending (sender rank, receiver rank) is therefore the canonical (sender
 * row, receiver row) order the resolution fixes, and neither party has to
 * learn a row of the other to reproduce it. Single-pass passes row indices
 * directly, which are their own ranks: it holds both parties' rows.
 *
 * Pairs may arrive in any order and may repeat -- several equal value pairs
 * between the same two records are one candidate pair, and the sort is
 * adaptive, so a caller that already emits them in canonical order pays one
 * linear pass.
 *
 * @param senderRanks - One entry per candidate pair.
 * @param receiverRanks - The other half of each pair, positionally aligned.
 * @param acceptance - Which side is held to one accepted pair per round.
 */
export function resolveRoundCandidatePairs(
  senderRanks: ReadonlyArray<number>,
  receiverRanks: ReadonlyArray<number>,
  acceptance: RoundAcceptance,
): ResolvedRound {
  if (senderRanks.length !== receiverRanks.length)
    throw new InternalConsistencyError(
      "a round's candidate pairs need one receiver rank per sender rank, " +
        `given ${senderRanks.length} and ${receiverRanks.length}`,
    );
  const order = new Array<number>(senderRanks.length);
  for (let i = 0; i < order.length; ++i) order[i] = i;
  order.sort(
    (a, b) =>
      senderRanks[a] - senderRanks[b] || receiverRanks[a] - receiverRanks[b],
  );

  const acceptedSenderRanks: Array<number> = [];
  const acceptedReceiverRanks: Array<number> = [];
  const touchedSenderRanks: Array<number> = [];
  const touchedReceiver = new Set<number>();
  const acceptedReceiver = acceptance.receiverAcceptsOnce
    ? new Set<number>()
    : undefined;
  // Sentinels below every rank, so the first pair opens a sender run rather
  // than continuing one.
  let previousSender = -1;
  let previousReceiver = -1;
  let senderAccepted = false;

  for (const i of order) {
    const sender = senderRanks[i];
    const receiver = receiverRanks[i];
    if (sender === previousSender && receiver === previousReceiver) continue;
    if (sender !== previousSender) {
      touchedSenderRanks.push(sender);
      senderAccepted = false;
    }
    previousSender = sender;
    previousReceiver = receiver;
    touchedReceiver.add(receiver);
    if (acceptance.senderAcceptsOnce && senderAccepted) continue;
    if (acceptedReceiver !== undefined) {
      if (acceptedReceiver.has(receiver)) continue;
      acceptedReceiver.add(receiver);
    }
    acceptedSenderRanks.push(sender);
    acceptedReceiverRanks.push(receiver);
    senderAccepted = true;
  }

  return {
    acceptedSenderRanks,
    acceptedReceiverRanks,
    touchedSenderRanks,
    touchedReceiverRanks: [...touchedReceiver].sort((a, b) => a - b),
  };
}
