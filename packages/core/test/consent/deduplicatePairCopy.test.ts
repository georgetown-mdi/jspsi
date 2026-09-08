import { describe, expect, test } from "vitest";

import {
  DEDUPLICATE_ACCEPTOR_SETTABLE_SIDE_NOTE,
  DEDUPLICATE_ACCEPTOR_SIDE_NOTE,
  DEDUPLICATE_ACCEPTOR_WIDENING_NOTE,
  describeDeduplicatePair,
} from "../../src/consent/consentFacts";

// The consent copy a seat where the accepting party sets its own `deduplicate`
// renders: both parties' values and what that pair discloses, plus the direction
// note in the variant that seat owes.

describe("describeDeduplicatePair", () => {
  const pairs = [
    { inviter: false, acceptor: false },
    { inviter: true, acceptor: false },
    { inviter: false, acceptor: true },
    { inviter: true, acceptor: true },
  ] as const;

  test.each(pairs)(
    "names both values for the ($inviter, $acceptor) pair",
    ({ inviter, acceptor }) => {
      // A reader is entitled to BOTH values wherever one of them is theirs to
      // set: a sentence naming only the invitation's would leave the operator
      // unable to tell what its own selection changed.
      const sentence = describeDeduplicatePair(inviter, acceptor);
      const inviterClause = inviter
        ? "inviting party declares deduplicate true"
        : "inviting party declares deduplicate false";
      const acceptorClause = acceptor
        ? "accepting party declares deduplicate true"
        : "accepting party declares deduplicate false";
      if (inviter === acceptor) {
        // The two matching pairs state the shared value once, in the form the
        // sentence actually uses.
        expect(sentence).toContain(
          inviter
            ? "Both parties declare deduplicate true"
            : "Both parties declare deduplicate false",
        );
      } else {
        expect(sentence).toContain(inviterClause);
        expect(sentence).toContain(acceptorClause);
      }
    },
  );

  test("gives each pair its own account of what is disclosed", () => {
    // Four distinct sentences, so no pair is described by another's disclosure.
    const sentences = pairs.map(({ inviter, acceptor }) =>
      describeDeduplicatePair(inviter, acceptor),
    );
    expect(new Set(sentences).size).toBe(pairs.length);
  });

  test("names the grouped party in each one-sided pair", () => {
    expect(describeDeduplicatePair(true, false)).toContain(
      "Several of the inviting party's records may match a single one of the accepting party's",
    );
    expect(describeDeduplicatePair(false, true)).toContain(
      "Several of the accepting party's records may match a single one of the inviting party's",
    );
  });

  test("states the pair-wise result for the both-sided pair", () => {
    expect(describeDeduplicatePair(true, true)).toContain(
      "one row per matched pair",
    );
  });

  test("states that neither file is grouped where neither party declares it", () => {
    expect(describeDeduplicatePair(false, false)).toContain(
      "neither party's file is grouped",
    );
  });
});

describe("the acceptor-side direction notes", () => {
  test("both hold the widening the inviting party's value costs the accepting party", () => {
    // The disclosure is the same on either seat, so it is stated once and pinned
    // across every surface by the consent-coverage check; only the remedy each
    // note closes on is the seat's own.
    expect(DEDUPLICATE_ACCEPTOR_SIDE_NOTE).toContain(
      DEDUPLICATE_ACCEPTOR_WIDENING_NOTE,
    );
    expect(DEDUPLICATE_ACCEPTOR_SETTABLE_SIDE_NOTE).toContain(
      DEDUPLICATE_ACCEPTOR_WIDENING_NOTE,
    );
  });

  test("the settable note sends the operator to the control, not to a configuration file", () => {
    // The sentence the note without a control ends on is a dead end for an
    // operator accepting from a browser, which has no configuration file.
    expect(DEDUPLICATE_ACCEPTOR_SIDE_NOTE).toContain(
      "each party's own configuration file",
    );
    expect(DEDUPLICATE_ACCEPTOR_SETTABLE_SIDE_NOTE).not.toContain(
      "configuration file",
    );
    expect(DEDUPLICATE_ACCEPTOR_SETTABLE_SIDE_NOTE).toContain(
      "that party's own setting",
    );
  });

  test("the settable note drops the claim the accepting party's records are never grouped", () => {
    // On a seat that offers the control that claim can be false, and the pair
    // statement beside it holds the two values actually selected.
    expect(DEDUPLICATE_ACCEPTOR_SIDE_NOTE).toContain("never grouped");
    expect(DEDUPLICATE_ACCEPTOR_SETTABLE_SIDE_NOTE).not.toContain(
      "never grouped",
    );
  });
});
