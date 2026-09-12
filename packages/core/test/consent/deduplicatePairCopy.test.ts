import { describe, expect, test } from "vitest";

import {
  CONSENT_FACTS,
  DEDUPLICATE_ACCEPTOR_SETTABLE_SIDE_NOTE,
  DEDUPLICATE_ACCEPTOR_SIDE_NOTE,
  DEDUPLICATE_ACCEPTOR_WIDENING_NOTE,
  DEDUPLICATE_PARTNER_DECLARED_DISCLOSURE_STATEMENT,
  DEDUPLICATE_PARTNER_DECLARED_SIDE_NOTE,
  DEDUPLICATE_PARTNER_DECLARED_WIDENING_NOTE,
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

  // The output shape the sentences above are read under, where the inviting
  // party is entitled to the result. The shape where it is not is measured on
  // its own below, since only there does the pair change what the sentence owes.
  const describePair = (inviter: boolean, acceptor: boolean): string =>
    describeDeduplicatePair({
      inviterDeduplicate: inviter,
      acceptorDeduplicate: acceptor,
      inviterReceivesResult: true,
    });

  test.each(pairs)(
    "names both values for the ($inviter, $acceptor) pair",
    ({ inviter, acceptor }) => {
      // A reader is entitled to BOTH values wherever one of them is theirs to
      // set: a sentence naming only the invitation's would leave the operator
      // unable to tell what its own selection changed.
      const sentence = describePair(inviter, acceptor);
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
      describePair(inviter, acceptor),
    );
    expect(new Set(sentences).size).toBe(pairs.length);
  });

  test("names the grouped party in each one-sided pair", () => {
    expect(describePair(true, false)).toContain(
      "Several of the inviting party's records may match a single one of the accepting party's",
    );
    expect(describePair(false, true)).toContain(
      "Several of the accepting party's records may match a single one of the inviting party's",
    );
  });

  test("states the pair-wise result for the both-sided pair", () => {
    expect(describePair(true, true)).toContain("one row per matched pair");
  });

  test("states the grouping a record matching on several values makes", () => {
    // The both-sided pair groups records no linkage key links, through a record
    // that matched on several values of one key (docs/spec/PROTOCOL.md, The
    // many-to-many entity closure). It is a disclosure of the pairing, so the
    // sentence an acceptor consents on states it.
    expect(describePair(true, true)).toContain(
      "records sharing no matched value are disclosed to both parties as one " +
        "group",
    );
  });

  test("states that neither file is grouped where neither party declares it", () => {
    expect(describePair(false, false)).toContain(
      "neither party's file is grouped",
    );
  });
});

describe("the fan-out note's account of pairing", () => {
  // The note renders wherever the terms declare a candidate set the exchange
  // matches, under either party's `deduplicate`, so it states the pairing
  // count against the pair rather than for one combination.
  test("scopes the at-most-once pairing to the pair that pairs once", () => {
    const note = CONSENT_FACTS.fanOutCandidates.note!;
    expect(note).toContain("with neither set it is paired at most once");
    expect(note).toContain(
      "with both set it is paired with every one of the other party's " +
        "records any of its candidates reached",
    );
  });

  test("answers the one-sided pairs the note's question also reaches", () => {
    // The note poses the count for the two duplicate-matching settings, and
    // the surfaces render it under all four pairs. Under a one-sided setting
    // the "one" side's record is the one that pairs with several: the relaxed
    // acceptance clause stops the declaring party's records from repeating
    // and nothing stops the other party's (docs/spec/PROTOCOL.md, The per-side
    // rules, and the two cases a deduplicating cardinality adds).
    const note = CONSENT_FACTS.fanOutCandidates.note!;
    expect(note).toContain(
      "with one party's set, a record of the party that set it is paired at " +
        "most once while a record of the other party may be paired with " +
        "several",
    );
    // Not the both-set count: that pairing is total, and stating it for a
    // one-sided run would promise pairs the sweep discards.
    expect(note).not.toContain(
      "with one party's set it is paired with every one",
    );
  });
});

describe("the chained-grouping fact", () => {
  const fact = CONSENT_FACTS.candidateSetChainsGrouping;

  test("states the grouping as a fact the run holds", () => {
    // The pairs a chained group rests on stand in the association table both
    // parties hold, so the grouping is the run's rather than the partner's
    // word (docs/spec/PROTOCOL.md, The `many-to-many` entity closure).
    expect(fact.basis).toBe("enforced");
  });

  test("states what a group can hold that no linkage key links", () => {
    expect(fact.note).toContain(
      "records sharing no matched value are disclosed to both parties as one " +
        "group",
    );
    // The condition it holds under, so a reader of a one-sided run does not
    // take the grouping for one their own terms make.
    expect(fact.note).toContain(
      "Where both parties set duplicate matching for their own records",
    );
  });

  test("names no invitation role, so every seat states it in one wording", () => {
    // The sentence renders at seats holding an invitation and at seats reading
    // terms their own party wrote: a role name would read inverted at one of
    // them, and two wordings would be two disclosures free to drift apart.
    expect(fact.note).not.toContain("inviting party");
    expect(fact.note).not.toContain("accepting party");
  });

  test("states the grouping the both-sided pair sentence states", () => {
    // One disclosure, so the pair sentence a seat with the control renders and
    // this fact cannot come to differ about what a chained group holds.
    const chainClause =
      "records sharing no matched value are disclosed to both parties as one " +
      "group";
    expect(
      describeDeduplicatePair({
        inviterDeduplicate: true,
        acceptorDeduplicate: true,
        inviterReceivesResult: true,
      }),
    ).toContain(chainClause);
    expect(fact.note).toContain(chainClause);
  });
});

describe("the pair where the inviting party receives no result", () => {
  // output.expects_output false with share_with_partner true: the accepting
  // party is the only party these terms hand a result, and it is a shape the
  // seat offers the control on, so its sentence cannot be the both-receive one.
  const soleAcceptorReceiver = describeDeduplicatePair({
    inviterDeduplicate: false,
    acceptorDeduplicate: true,
    inviterReceivesResult: false,
  });
  const bothReceive = describeDeduplicatePair({
    inviterDeduplicate: false,
    acceptorDeduplicate: true,
    inviterReceivesResult: true,
  });

  test("takes a sentence of its own rather than the both-receive one", () => {
    expect(soleAcceptorReceiver).not.toBe(bothReceive);
    expect(bothReceive).toContain("both parties receive a result");
  });

  test("names the accepting party as the only party the result reaches", () => {
    // The sentence it replaces said "whichever party receives the result",
    // which in this shape names the reader alone and so reads as nobody else
    // learning the grouping.
    expect(soleAcceptorReceiver).toContain(
      "These terms hand that result to the accepting party alone",
    );
    expect(soleAcceptorReceiver).not.toContain("whichever party receives");
  });

  test("still names both declared values and the grouped party", () => {
    expect(soleAcceptorReceiver).toContain(
      "inviting party declares deduplicate false",
    );
    expect(soleAcceptorReceiver).toContain(
      "accepting party declares deduplicate true",
    );
    expect(soleAcceptorReceiver).toContain(
      "Several of the accepting party's records may match a single one of the inviting party's",
    );
  });

  test("leaves the partner's process to the classified facts beside it", () => {
    // The register split the surfaces hold: what the exchange does with the
    // grouping is an enforced or trust-contingent fact of its own, so the
    // sentence states neither.
    expect(soleAcceptorReceiver).not.toContain("process");
    expect(CONSENT_FACTS.partnerReadsDuplicateGrouping.basis).toBe(
      "trust-contingent",
    );
    expect(CONSENT_FACTS.partnerDuplicateGroupingWithheld.basis).toBe(
      "enforced",
    );
    expect(CONSENT_FACTS.partnerReadsDuplicateGrouping.note).toContain(
      "Your partner's process is sent the group sizes and row positions",
    );
    expect(CONSENT_FACTS.partnerDuplicateGroupingWithheld.note).toContain(
      "withholds your partner's half of the matched-pair table",
    );
  });

  test("leaves the pairs the schema cannot reach at the both-receive reading", () => {
    // A party declaring deduplicate must be entitled to output, so an inviting
    // party that receives no result declares false: the other two branches are
    // the same sentence under either output shape.
    for (const acceptor of [true, false])
      expect(
        describeDeduplicatePair({
          inviterDeduplicate: true,
          acceptorDeduplicate: acceptor,
          inviterReceivesResult: false,
        }),
      ).toBe(
        describeDeduplicatePair({
          inviterDeduplicate: true,
          acceptorDeduplicate: acceptor,
          inviterReceivesResult: true,
        }),
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

describe("the partner-declared seat's copy", () => {
  test("names no invitation role, since no invitation tells the reader which is theirs", () => {
    // The seat's reader holds neither declared role: a sentence naming them
    // reads the disclosure direction inverted for a reader who maps them the
    // other way round.
    for (const copy of [
      DEDUPLICATE_PARTNER_DECLARED_DISCLOSURE_STATEMENT,
      DEDUPLICATE_PARTNER_DECLARED_SIDE_NOTE,
      DEDUPLICATE_PARTNER_DECLARED_WIDENING_NOTE,
    ]) {
      expect(copy).not.toContain("inviting party");
      expect(copy).not.toContain("accepting party");
    }
  });

  test("states the same disclosure as the statement it stands in for", () => {
    // The bound and the integrity limit the party-named statement fixes: the
    // count and row positions never reach the value behind them, only matched
    // groups are counted, and the count is the declaring party's own word.
    expect(DEDUPLICATE_PARTNER_DECLARED_DISCLOSURE_STATEMENT).toContain(
      "a count and row positions, never the value behind them, and only for " +
        "groups that matched",
    );
    expect(DEDUPLICATE_PARTNER_DECLARED_DISCLOSURE_STATEMENT).toContain(
      "That count is your own declaration, which psilink does not check " +
        "against your data",
    );
  });

  test("holds the same widening as the acceptor-side notes, in the second person", () => {
    expect(DEDUPLICATE_PARTNER_DECLARED_SIDE_NOTE).toContain(
      DEDUPLICATE_PARTNER_DECLARED_WIDENING_NOTE,
    );
    // One sentence, one role swapped: the widening the seats state cannot
    // drift apart into two different disclosures.
    expect(
      DEDUPLICATE_PARTNER_DECLARED_WIDENING_NOTE.replace(
        "your partner",
        "the accepting party",
      ),
    ).toBe(DEDUPLICATE_ACCEPTOR_WIDENING_NOTE);
  });

  test("drops the claim the partner's records are never grouped, because this seat cannot know the other side", () => {
    // Unlike the settable note, this seat drops the clause not because it
    // states the pair itself, but because the partner declares its own value
    // on its own run: asserting "never grouped" here would state a fact
    // nothing on this seat decides.
    expect(DEDUPLICATE_PARTNER_DECLARED_SIDE_NOTE).not.toContain(
      "never grouped",
    );
  });

  test("closes on the partner's own run rather than on a configuration file or these terms", () => {
    // This seat offers no control and holds no invitation, so the note
    // neither points to a configuration file (the route with no control at
    // all) nor claims the partner's value is read from these terms (the route
    // that offers the control).
    expect(DEDUPLICATE_PARTNER_DECLARED_SIDE_NOTE).not.toContain(
      "configuration file",
    );
    expect(DEDUPLICATE_PARTNER_DECLARED_SIDE_NOTE).toContain(
      "declares on its own run rather than reading from these terms",
    );
  });
});
