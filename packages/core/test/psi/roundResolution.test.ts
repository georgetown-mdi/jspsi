import { expect, test } from "vitest";

import { resolveRoundCandidatePairs } from "../../src/psi/roundResolution";
import { InternalConsistencyError } from "../../src/errors";

// The record-level resolution both strategies call, exercised on the exact
// input it governs: a round's candidate pairs as each party's own record
// ranks. Everything above it -- the cascade's two groupings, single-pass's
// index tables -- reduces to this, which is why writing it once is what makes
// the two strategies' tables identical by construction
// (docs/spec/PROTOCOL.md, One sweep, called by both strategies).

const ONE_TO_ONE = { senderAcceptsOnce: true, receiverAcceptsOnce: true };

function pairs(
  sender: Array<number>,
  receiver: Array<number>,
  acceptance = ONE_TO_ONE,
) {
  return resolveRoundCandidatePairs(sender, receiver, acceptance);
}

test("the sweep accepts in ascending (sender rank, receiver rank)", () => {
  // The normative double-match case in rank terms: sender 0 is a candidate for
  // receivers 0 and 1, sender 1 for receiver 1. The sweep accepts (0, 0),
  // discards (0, 1) because sender 0 is accepted already, and accepts (1, 1).
  const resolved = pairs([0, 0, 1], [0, 1, 1]);
  expect(resolved.acceptedSenderRanks).toStrictEqual([0, 1]);
  expect(resolved.acceptedReceiverRanks).toStrictEqual([0, 1]);
});

test("the order is the ranks', not the order the pairs arrive in", () => {
  // The same round with its pairs shuffled reaches the same table: nothing in
  // the rule reads the order a candidate entered the round.
  const canonical = pairs([0, 0, 1], [0, 1, 1]);
  const shuffled = pairs([1, 0, 0], [1, 1, 0]);
  expect(shuffled.acceptedSenderRanks).toStrictEqual(
    canonical.acceptedSenderRanks,
  );
  expect(shuffled.acceptedReceiverRanks).toStrictEqual(
    canonical.acceptedReceiverRanks,
  );
});

test("several equal value pairs between two records are one candidate pair", () => {
  const resolved = pairs([0, 0, 0], [3, 3, 3]);
  expect(resolved.acceptedSenderRanks).toStrictEqual([0]);
  expect(resolved.acceptedReceiverRanks).toStrictEqual([3]);
  expect(resolved.touchedReceiverRanks).toStrictEqual([3]);
});

test("every rank in any candidate pair leaves candidacy, accepted or not", () => {
  // Removal on a potential match: the discarded (0, 1) still takes receiver 1
  // out, and it is taken out again as an accepted pair's own record.
  const resolved = pairs([0, 0, 1], [0, 1, 1]);
  expect(resolved.touchedSenderRanks).toStrictEqual([0, 1]);
  expect(resolved.touchedReceiverRanks).toStrictEqual([0, 1]);
});

test("a sender left unpaired by the sweep still leaves candidacy", () => {
  // Sender 1's only candidate is receiver 0, which sender 0 took first. It
  // ends the round unmatched and out of candidacy: contradicted evidence does
  // not continue.
  const resolved = pairs([0, 1], [0, 0]);
  expect(resolved.acceptedSenderRanks).toStrictEqual([0]);
  expect(resolved.touchedSenderRanks).toStrictEqual([0, 1]);
});

test("the many side's clause relaxes the other side alone", () => {
  // Under a deduplicating cardinality a pair is accepted when the record on
  // the MANY side has not been accepted this round, whatever the "one" side
  // has done. With the receiver the many side, sender 0 pairs with both of
  // its receivers.
  const resolved = pairs([0, 0], [0, 1], {
    senderAcceptsOnce: false,
    receiverAcceptsOnce: true,
  });
  expect(resolved.acceptedSenderRanks).toStrictEqual([0, 0]);
  expect(resolved.acceptedReceiverRanks).toStrictEqual([0, 1]);
});

test("the one side keeps its own clause under the same cardinality", () => {
  // Receiver 0 is the many side's record and takes one pair; sender 1's
  // candidate is spent, so it leaves the round unpaired.
  const resolved = pairs([0, 1], [0, 0], {
    senderAcceptsOnce: false,
    receiverAcceptsOnce: true,
  });
  expect(resolved.acceptedSenderRanks).toStrictEqual([0]);
  expect(resolved.acceptedReceiverRanks).toStrictEqual([0]);
  expect(resolved.touchedSenderRanks).toStrictEqual([0, 1]);
});

test("a both-sided multiplicity accepts every candidate pair", () => {
  const resolved = pairs([0, 0, 1, 1], [0, 1, 0, 1], {
    senderAcceptsOnce: false,
    receiverAcceptsOnce: false,
  });
  expect(resolved.acceptedSenderRanks).toStrictEqual([0, 0, 1, 1]);
  expect(resolved.acceptedReceiverRanks).toStrictEqual([0, 1, 0, 1]);
});

test("misaligned halves are a caller fault, not a silent truncation", () => {
  expect(() => pairs([0, 1], [0])).toThrow(InternalConsistencyError);
});

test("an empty round resolves to nothing", () => {
  const resolved = pairs([], []);
  expect(resolved.acceptedSenderRanks).toStrictEqual([]);
  expect(resolved.touchedSenderRanks).toStrictEqual([]);
  expect(resolved.touchedReceiverRanks).toStrictEqual([]);
});
