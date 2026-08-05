// The enforced-versus-trust-contingent classification of the facts an acceptance
// surface states, and the fixed caveat copy each surface renders for them.
//
// It lives beside the shared invitation summary rather than in either renderer
// for the reason the summary itself does: a fact both surfaces state must carry
// ONE classification and ONE caveat sentence. A renderer that authored its own
// could classify the same fact differently from the other surface, or attach a
// caveat that contradicts it. The consent-coverage check cannot see that class of
// divergence: it measures whether a field moves a surface's output, never whether
// the two say the same thing.
//
// A table keyed by a fact identifier, not a field on `InvitationSummary`. Two
// properties a per-field flag cannot carry force it: not every classified fact is
// a summary field (the acceptor's own outbound columns come from its own resolved
// metadata, never from the partner's token), and one underlying field carries two
// classifications at once (the viewer's own non-receipt is enforced while the
// partner's non-receipt, off the same `output` pair, rests on the partner's word).
// `linkageTermConsentCoverage.ts` is the repo's precedent for the shape.
//
// Rationale and the decisions taken: docs/notes/shared-consent-summary.md.

/**
 * Whether the exchange holds a consent fact itself, or the fact is the inviting
 * party's declaration -- shown faithfully, neither verified nor enforceable.
 *
 * `enforced` is a claim about the run: either the fact is true of it, or the
 * exchange aborts rather than proceed without it. `trust-contingent` is a claim
 * about the partner: a partner that does not honor it is not stopped by psilink.
 */
export type ConsentFactBasis = "enforced" | "trust-contingent";

/** One classified fact of the acceptance display. */
export interface ConsentFact {
  /** Which of the two registers this fact belongs to. */
  basis: ConsentFactBasis;
  /**
   * Why the fact carries that basis. Read by a person auditing the table, not by
   * a renderer: it is where the judgment behind a row is recorded, so a row
   * cannot be reclassified without the reason being restated alongside it.
   */
  reason: string;
  /**
   * The caveat sentence both surfaces render for this fact, present when the
   * marker alone would understate it. Fixed copy: no partner-controlled value
   * reaches any of these, so a renderer may show one verbatim.
   */
  note?: string;
}

/**
 * Every fact an acceptance surface states, with its basis and shared caveat copy.
 *
 * Keyed by fact rather than by `LinkageTerms` field, because a fact can be a
 * derived value (the acceptor's own outbound columns), or one of two mutually
 * exclusive cases of a single field (the two `output` receipts, whose bases and
 * caveats differ by value). A renderer looks a fact up here for both the basis
 * marker and the caveat; one that spells either out inline has re-created the
 * divergence this removes.
 */
export const CONSENT_FACTS = {
  outboundSend: {
    basis: "enforced",
    reason:
      "The acceptor's own disclosure, derived from its resolved metadata " +
      "through the same predicate the payload step transmits on, so no column " +
      "outside the displayed set leaves the machine under the configuration " +
      "this acceptance writes. A bound with one limit: it does not reach an " +
      "acceptance that keeps a configuration already on disk, whose stored " +
      "metadata the exchange runs on and which nothing compares against the " +
      "input this line is rendered from.",
  },
  invitingParty: {
    basis: "trust-contingent",
    reason:
      "A free-text name the inviter typed, carried in an invitation accepted " +
      "on a transcription checksum. Nothing authenticates it.",
    note: "Your partner entered this name; psilink has not verified it.",
  },
  algorithm: {
    basis: "enforced",
    reason:
      "A mandatory-consistency term both parties adopt, asserted on every run " +
      "path: an algorithm this version does not implement aborts the exchange.",
  },
  linkageStrategy: {
    basis: "enforced",
    reason:
      "A mandatory-consistency term: the parties must end up agreeing on it or " +
      "the exchange aborts.",
  },
  viewerReceivesResult: {
    basis: "enforced",
    reason:
      "The viewer's own receipt is settled by the exchange, not by the " +
      "partner's conduct.",
  },
  viewerReceivesNoResult: {
    basis: "enforced",
    reason:
      "A party set to receive no result is sent none, and its receive check " +
      "fails closed on any result it is sent.",
    note: "Enforced: you are sent no result, and any result sent to you is rejected.",
  },
  partnerReceivesResult: {
    basis: "enforced",
    reason:
      "The receipt is settled by the run rather than by the partner's conduct: " +
      "the two parties' output directions are compared as a mirror before data " +
      "moves, and the run then delivers the result to the party those agreed " +
      "terms entitle to it. What the partner does with the result once it holds " +
      "it is governed by the agreement, not by psilink -- a limit on its use, " +
      "which the note carries, not on whether the disclosure happens.",
    note: "Once received, its use is governed by your agreement, not this tool.",
  },
  partnerReceivesNoResult: {
    basis: "trust-contingent",
    reason:
      "Keeping a result from a partner rests on the agreed terms being " +
      "honored; one-sided PSI gives this side nothing to impose it with.",
    note:
      "By agreement, not enforced: keeping the result from your partner rests " +
      "on the agreed terms being honored, not on anything this tool can enforce.",
  },
  partnerLearnsOwnMembership: {
    basis: "enforced",
    reason:
      "An intrinsic property of the match rather than a matter of conduct: a " +
      "non-receiving partner learns its own records' membership however " +
      "honestly it behaves. Bounded to that -- never which of the viewer's " +
      "records they met, nor anything about the rest of the set beyond its size.",
    note:
      "Even when honored, your partner learns which of its own records are in " +
      "your data (not which of yours). This is inherent to the match, not a breach.",
  },
  duplicateMatches: {
    basis: "enforced",
    reason:
      "Matching multiplicity is fixed by the run, and a deduplicating term this " +
      "version does not apply aborts the exchange rather than matching looser.",
  },
  matchedFields: {
    basis: "enforced",
    reason:
      "The fields the linkage keys are computed over -- what the exchange " +
      "actually hashes and compares.",
  },
  personalDataCategories: {
    basis: "enforced",
    reason:
      "The semantic categories the keys draw on, resolved from the schema-" +
      "validated field types the run binds.",
  },
  declaredDataStandards: {
    basis: "trust-contingent",
    reason:
      "Data standards the inviting party commits its own values to. psilink " +
      "warns where a value falls outside one; it does not filter or reject.",
  },
  allowedCharacterPatterns: {
    basis: "trust-contingent",
    reason:
      "A partner-authored regular expression, never vetted. A crafted class " +
      "reads very differently to a human than the set it admits, and the check " +
      "evaluating it warns rather than enforces.",
    note:
      "Your partner declares an allowed-character pattern for these fields. " +
      "Each is a partner-supplied regular expression that psilink has not " +
      "verified, and it is a data expectation rather than an enforced filter.",
  },
  linkageKeys: {
    basis: "enforced",
    reason:
      "The keys, their elements, and every declared matching rule are what the " +
      "run computes; under `psi` they decide which identifiers are revealed.",
  },
  inboundPayloadColumns: {
    basis: "enforced",
    reason:
      "The set the acceptor locks in as what it will receive. Its own side " +
      "reconciles the received payload against it and aborts on any other set.",
  },
  requestedPayloadColumns: {
    basis: "trust-contingent",
    reason:
      "A request for the acceptor's columns, not a statement of what the " +
      "acceptor sends -- that is settled by the acceptor's own metadata.",
  },
  legalAgreement: {
    basis: "trust-contingent",
    reason:
      "Partner-authored text. The reference and expiry are byte-compared " +
      "against this party's own copy before data moves, but psilink vets " +
      "neither the agreement nor the purpose it states.",
  },
  invitationExpiry: {
    basis: "enforced",
    reason:
      "Re-checked before and after the key exchange; an expired invitation is " +
      "refused.",
  },
} as const satisfies Record<string, ConsentFact>;

/** A key of {@link CONSENT_FACTS}. */
export type ConsentFactId = keyof typeof CONSENT_FACTS;

/**
 * The terse marker a surface with no styling budget puts on a fact's own label to
 * carry its {@link ConsentFactBasis}. It lives here rather than in the renderer
 * that needs it so a further surface inherits the vocabulary instead of coining a
 * third one; the web carries the same distinction through its tiering and the
 * caveat copy, so it renders no marker.
 */
export const CONSENT_BASIS_MARKERS: Record<ConsentFactBasis, string> = {
  enforced: "enforced",
  "trust-contingent": "your partner's word",
};

/**
 * The sentence a surface renders in the outbound-send slot, in place of any
 * column set, when the viewer's partner receives no result from the exchange.
 *
 * The payload step transmits nothing at all to a partner not entitled to the
 * result -- an empty message goes on the wire where a payload would -- so no
 * column leaves the machine whatever the operator's file holds, and listing a set
 * that never moves would overstate the disclosure. The reason is stated with the
 * fact, because the reason is what an operator would otherwise go looking for in
 * their own file.
 *
 * It is viewer-relative in both directions, which is what lets ONE sentence serve
 * a surface on either side: the acceptor's partner is the inviting party, which
 * receives when `output.expectsOutput` is set, and the inviter's partner is the
 * acceptor, which receives when `output.shareWithPartner` is set (acceptance
 * mirrors the pair). Each surface resolves that fact for its own viewer and
 * renders this; a surface that composes its own sentence is a second account of
 * the fact, which is the drift carrying the copy here removes.
 *
 * Fixed first-party copy, naming no column: no partner-controlled value reaches
 * it, so a surface may render it verbatim.
 */
export const OUTBOUND_SEND_NO_PAYLOAD_SENTENCE =
  "Your partner receives no result from this exchange, so no columns are sent " +
  "to them -- whatever your file contains.";

/**
 * The caveat copy for a term an inviter may declare that today's exchange does
 * not apply, keyed by the {@link APPLIED_SETTINGS} flag that gates it.
 *
 * The three are not alike in what not-applying them does, and the copy follows
 * that rather than a house style. `psiC` and `deduplicate` are refused at the
 * exchange boundary (`assertAlgorithmImplemented` / `assertDeduplicateImplemented`
 * in `exchange.ts`), so an invitation carrying either aborts before any identifier
 * is revealed: their copy names the refusal and what to ask the inviter for. A
 * caveat claiming the run proceeds and discloses more than the headline would be
 * describing a run that does not happen.
 * `fuzzyComparisons` has no such refusal; it is a silent no-op that narrows the
 * match, so its marker says only that the expansion is proposed, and claiming a
 * refusal there would be the same error in the other direction.
 *
 * Shared for the same reason the classification is. The count-only entry is a
 * moving target -- when the count-only run path lands, both surfaces flip to the
 * count-only disclosure statement together, which the render tests pinning it
 * make a deliberate edit.
 */
export const PROPOSED_NOT_APPLIED_NOTES = {
  psiC:
    "Your partner proposes a count-only exchange, but this version of the " +
    "exchange does not yet apply it and will refuse to run; ask your partner " +
    'for an invitation using the "psi" algorithm.',
  deduplicate:
    "Your partner proposes this, but this version of the exchange does not " +
    "yet apply it and will refuse to run; ask your partner for an invitation " +
    "without deduplication.",
  fuzzyComparisons: "(proposed; not yet applied)",
} as const;
