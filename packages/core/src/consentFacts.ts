// The enforced-versus-trust-contingent classification of the facts an acceptance
// surface states, and the fixed caveat copy each surface renders for them.
//
// It lives beside the shared invitation summary rather than in either renderer
// for the reason the summary itself does: a fact both surfaces state must hold
// ONE classification and ONE caveat sentence. A renderer that authored its own
// could classify the same fact differently from the other surface, or attach a
// caveat that contradicts it. The consent-coverage check cannot see that class of
// divergence: it measures whether a field moves a surface's output, never whether
// the two say the same thing.
//
// A table keyed by a fact identifier, not a field on `InvitationSummary`. Two
// properties a per-field flag cannot hold force it: not every classified fact
// is a summary field (the acceptor's own outbound columns come from its own
// resolved metadata, never from the partner's token), and one underlying
// field holds two classifications at once (the viewer's own non-receipt is
// enforced while the partner's non-receipt, off the same `output` pair,
// rests on the partner's word).
// `linkageTermConsentCoverage.ts` is the repo's precedent for the shape.
//
// One tier here states facts about the count-only (`psi-c`) run alone, which both
// surfaces render for a `psi-c` invitation and withhold otherwise. Their bases are
// the per-party learn-basis rows of docs/spec/PROTOCOL.md's PSI-C section rather
// than a judgment made here, so a row reclassified there and not here is a
// divergence between a specification and the sentence an acceptor consents on.
//
// Rationale and the decisions taken: docs/notes/shared-consent-summary.md.

import type { LinkageRuleSetCitationVerdict } from "./defaults/linkageTerms.js";

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
   * Why the fact holds that basis. Read by a person auditing the table, not by
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
 * exclusive cases of a single line: the two `output` receipts, whose bases and
 * caveats differ by value, and the acceptor's received columns, whose basis
 * differs by where the displayed set came from -- the disclosed subset the
 * invitation held, or the inviter's authored declaration. A renderer looks a
 * fact up here for both the basis marker and the caveat; one that spells either
 * out inline has re-created the divergence this removes.
 */
export const CONSENT_FACTS = {
  outboundSend: {
    basis: "enforced",
    reason:
      "The acceptor's own disclosure, derived from its resolved metadata " +
      "through the same predicate the payload step transmits on, so no column " +
      "outside the displayed set leaves the machine. The acceptance records the " +
      "displayed set as this party's consent to it, and a run whose own resolved " +
      "set differs -- including one on a configuration already on disk, whose " +
      "stored metadata this line is not rendered from -- stops and asks rather " +
      "than transmit a set that was never shown. Where the set is not resolvable " +
      "at acceptance the line says so, and the same confirmation is taken at the " +
      "first run that can resolve it.",
  },
  invitingParty: {
    basis: "trust-contingent",
    reason:
      "A free-text name the inviter typed, carried in an invitation accepted " +
      "on a transcription checksum. Nothing authenticates it, and psilink " +
      "substitutes nothing for an inviter that typed none -- but the absence " +
      "marker shown in its place is itself free text an inviter could type, so " +
      "display does not separate the two cases.",
    note:
      "Your partner chose what you see here; psilink has not verified it and " +
      "adds no name of its own.",
  },
  algorithm: {
    basis: "enforced",
    reason:
      "A mandatory-consistency term both parties adopt, asserted on every run " +
      "path: an algorithm this version does not implement aborts the exchange.",
  },
  countOnlyResult: {
    basis: "enforced",
    reason:
      "The two halves docs/spec/PROTOCOL.md assigns to the run rather than to " +
      "the partner. A party's own count-only outcome: its base function is " +
      "constructed with the library's reveal-intersection flag cleared, and the " +
      "operations returning the matched positions or the association table throw " +
      "with it cleared, so its own software cannot produce a pairing. And its " +
      "view of what the PARTNER receives: a request whose flag disagrees with " +
      "the sender's is refused rather than served, in both orientations, so a " +
      "round that completes at all is one both parties ran count-only. Neither " +
      "half asks for the partner's cooperation or its honesty. What this basis " +
      "does not reach is the partner's choice of contributed values, which is a " +
      "fact of its own below.",
    note:
      "Enforced: neither party is handed a matched identifier or a " +
      "record-by-record pairing -- a partner asking for a revealing round is " +
      "refused rather than served, whatever software it runs.",
  },
  countOnlyRoundDisclosures: {
    basis: "enforced",
    reason:
      "What a count-only run discloses beside the count, and it discloses both " +
      "however either party behaves. Each party's raw record count rides the " +
      "terms exchange that opens every exchange, and each party's round frame " +
      "carries one encrypted element per value it contributes, which is its " +
      "number of distinct, non-repeating values for the key being matched on. " +
      "Neither figure is the intersection and the count-only mode hides " +
      "neither, so this sits in the run's register rather than the partner's -- " +
      "the same one as the own-membership disclosure a one-sided `psi` " +
      "exchange carries.",
    note:
      "Your partner also learns how many records you hold, and how many values " +
      "you contribute for the key being matched on -- the values that appear " +
      "exactly once in your file. Neither number is your overlap, and a " +
      "count-only exchange hides neither.",
  },
  countOnlyReportedCount: {
    basis: "trust-contingent",
    reason:
      "Only the receiver computes the count. Where both parties are entitled to " +
      "it the other party's copy arrives as the receiver's report, and psilink " +
      "does not stop a receiver that reports a different number -- the same " +
      "posture as the `psi` association-table return leg, where the sender's " +
      "half of the pairing likewise arrives as the receiver's word. Which party " +
      "computes follows from the record counts the run exchanges, so acceptance " +
      "cannot tell either side which of the two it will be, and the fact is " +
      "stated for both.",
    note:
      "Only one of you computes the count and sends it to the other; which one " +
      "follows from the record counts you exchange when the run starts. psilink " +
      "does not check a count it is sent against a run of its own.",
  },
  countOnlyInputChoice: {
    basis: "trust-contingent",
    reason:
      "The count-only claim holds against a partner that contributes a genuine " +
      "dataset, and psilink checks no such thing. A partner that chooses its " +
      "contributed values -- one live candidate padded with values it knows this " +
      "party cannot hold, or two runs differing in a single value -- reads that " +
      "value's membership off the count, and nothing on the wire distinguishes a " +
      "crafted set from a genuine one. Both routes are accepted rather than " +
      "prevented, so the protection they bound rests on the partner's conduct " +
      "even though the round itself is enforced. It bites hardest here: a " +
      "count-only exchange is the one run before the agreement the " +
      "honest-but-curious model leans on exists.",
    note:
      "Not enforced against your partner's choice of input: a count-only " +
      "exchange bounds what psilink hands your partner, not what they can learn " +
      "by choosing which records to ask about. A crafted list, or a second run " +
      "differing by one record, turns a count into an answer about one person.",
  },
  countOnlyNoPayload: {
    basis: "enforced",
    reason:
      "A count-only exchange carries no payload in either direction: a psi-c " +
      "terms document declaring a non-empty payload send or receive, or input " +
      "metadata that would transmit a column, is refused when the terms are " +
      "authored, again at the local prepare step, and again at the agreed-terms " +
      "run boundary, fail-closed at all three. The reason no column leaves the " +
      "machine is therefore the algorithm rather than this exchange's output " +
      "entitlements, which is what OUTBOUND_SEND_NO_PAYLOAD_SENTENCE reasons " +
      "from and so cannot state here.",
    note:
      "A count-only exchange sends no data columns in either direction, so no " +
      "columns are sent to your partner -- whatever your file contains.",
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
      "An intrinsic property of an identifier-revealing match rather than a " +
      "matter of conduct: under `psi` a non-receiving partner learns its own " +
      "records' membership however honestly it behaves. Bounded to that -- " +
      "never which of the viewer's records they met, nor anything about the " +
      "rest of the set beyond its size. Scoped by the ALGORITHM and not by the " +
      "linkage strategy: it holds for a one-sided `psi` exchange under both " +
      "strategies, and for no `psi-c` exchange at all, since the role rule " +
      "makes the non-receiving party of a count-only run the sender -- which " +
      "computes nothing from the round and is sent no count-report frame " +
      "(docs/spec/PROTOCOL.md, PSI-C), so it learns no membership to state. " +
      "Both surfaces therefore render this for `psi` alone, and what a " +
      "count-only run does disclose is the `countOnly*` tier's to state.",
    note:
      "Even when honored, your partner learns which of its own records are in " +
      "your data (not which of yours). This is inherent to a match that " +
      "reveals identifiers, not a breach.",
  },
  duplicateMatches: {
    basis: "enforced",
    reason:
      "Matching multiplicity is fixed by the run: the cardinality both parties " +
      "resolve from the agreed pair decides which side's within-dataset " +
      "duplicates take part, and a pair no strategy matches aborts the " +
      "exchange rather than matching looser. The marker carries that fact and " +
      "no more. Where the invitation makes the inviting party the sole " +
      "receiver, what the accepting party is presented of the grouping is this " +
      "client's doing rather than the run's, and that limit is " +
      "`duplicateGroupingDisplayLimit` below -- a fact of its own in the other " +
      "register, so this marker is never read as covering it.",
  },
  duplicateGroupingDisplayLimit: {
    basis: "trust-contingent",
    reason:
      "What a sole-receiver acceptance is not handed is the RESULT, and the " +
      "entitlement gate on the table `runExchange` returns holds that. The " +
      "grouping itself still reaches the accepting party's process on the paths " +
      "this basis is measured over. Under cascade its rounds carry each matched " +
      "position once per group member. Under single-pass the one wire-level " +
      "withholding (`withholdsSenderAssociationTable`) can close that -- the " +
      "sole receiver being the party entitled to output, role resolution makes " +
      "the acceptor the sender the withholding covers -- but only where that " +
      "party also transmits no payload column, and an invitation requesting one " +
      "of it leaves the table exchanged. So presenting none of the grouping is " +
      "the client's doing rather than the exchange's wherever the exchange has " +
      "not closed it, and what an operator on that side is shown rests on the " +
      "software that side runs -- the partner's register, not the run's. The " +
      "note states that general case and so never claims a protection a " +
      "particular run withholds beyond it. Carried as a fact of its own rather " +
      "than inside DEDUPLICATE_SOLE_RECEIVER_DISCLOSURE_STATEMENT: it renders " +
      "beside that statement, under the same enforced headline, but as a " +
      "classified fact of its own rather than as a clause of a sentence whose " +
      "basis is the headline's.",
    note:
      "psilink receives the group sizes and row positions and does not show " +
      "them to you. Withholding them is this software's choice rather than a " +
      "limit of the exchange, so other software on this side could show them.",
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
  fanOutCandidates: {
    basis: "enforced",
    reason:
      "What the run does with a record that has several candidate values for " +
      "one key, not what the partner does with it. Every candidate enters that " +
      "key's round as its own entry; a record appearing in any of the round's " +
      "candidate pairs leaves candidacy for every later key, paired or not; and " +
      "the index table the single-pass receiver holds carries each sender " +
      "record's candidate grouping for every key, matched or not. All three are " +
      "properties of the round rather than of anyone's conduct. The normative " +
      "rows are docs/spec/PROTOCOL.md's (Fan-out matching, and the disclosure " +
      "delta fan-out pays), so a row reclassified there and not here is a " +
      "divergence between a specification and the sentence an acceptor consents " +
      "on.",
    note:
      "A linkage key here splits a value into several candidates and matches " +
      "each on its own, so a record matches when any single candidate does. " +
      "That match can rest on one candidate out of a name rather than on the " +
      "whole value, which is weaker evidence. A record matched this way is " +
      "paired at most once and is then left out of the later, less precise " +
      "keys, whether or not that pairing stands. Splitting runs under " +
      "single-pass linkage, so the party that receives the other's key " +
      "structure also learns how many candidates each of the other's records " +
      "produced for each key and which of its values came from the same " +
      "record.",
  },
  fanOutRefused: {
    basis: "enforced",
    reason:
      "The other case of the same line, and enforced for the same reason the " +
      "`deduplicate` refusal is: matching on several candidates per record is " +
      "specified for the single-pass strategy alone, so terms declaring one " +
      "under any other strategy are refused when they are authored or minted, " +
      "at the local prepare step, and again at the agreed-terms run boundary. " +
      "The exchange this invitation proposes does not run at all, which is a " +
      "fact of the run rather than of the partner's conduct.",
    note:
      "Your partner proposes splitting a value into several candidates to match " +
      "on, which runs under single-pass linkage only, and this invitation names " +
      "a different linkage strategy -- so the exchange will refuse to run. Ask " +
      "your partner for an invitation that either drops the split or uses " +
      "single-pass linkage.",
  },
  inboundPayloadColumnsCarried: {
    basis: "enforced",
    reason:
      "The disclosed subset the invitation carried, which the acceptance locks " +
      "in as what it will receive: its own side reconciles the received payload " +
      "against that set and aborts on any other.",
  },
  inboundPayloadColumnsAuthored: {
    basis: "trust-contingent",
    reason:
      "The inviting party's authored payload send list, displayed where the " +
      "invitation carried no disclosed subset. There is no set for the " +
      "acceptance to lock in, and an absent expectation is the lazy " +
      "reconciliation path, so an inviter that declares one set and transmits " +
      "another is not stopped on the online run -- which is what separates this " +
      "from the carried case above, off the same displayed list. Deliberately " +
      "understated for the offline path, where the acceptance's mirrored " +
      "payload receive list does become the lock-in a later exchange reconciles " +
      "against: one display serves both paths and is rendered before either is " +
      "settled, and of the two possible errors only overstating enforcement " +
      "misleads an operator about what will be stopped.",
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
  linkageRuleSet: {
    basis: "trust-contingent",
    reason:
      "The inviting party's citation of its own rules -- two names and two " +
      "content versions it wrote into the invitation, carried on a " +
      "transcription checksum. Nothing authenticates them, and where BOTH " +
      "parties cite a set the two citations must match before data moves, " +
      "which binds an acceptor to the inviter's own string rather than " +
      "vouching for it. What consent actually turns on is the declared keys " +
      "and fields shown beside this, which ARE byte-compared between the " +
      "parties. The caveat this row would otherwise carry is per half and " +
      "per verdict, so it lives in LINKAGE_RULE_SET_VERDICT_COPY below: a " +
      "single sentence cannot serve a name this build resolved and one it " +
      "could not.",
  },
  invitationExpiry: {
    basis: "enforced",
    reason:
      "Re-checked before and after the key exchange; an expired invitation is " +
      "refused.",
  },
  // The note's "what you send stays encrypted there" is true of every path
  // that renders this fact, and only because they are all authenticated
  // accepts: the zero-setup exchange takes --retain-files too and runs its
  // PSI frames over the bare transport, with no application-layer encryption
  // to promise. It renders no consent fact at all, which is what keeps the
  // sentence accurate -- pinned by a test rather than by this comment
  // (apps/cli/test/unit/zeroSetup.test.ts), so wiring consent facts into that
  // path fails until the claim is re-examined.
  retainedFiles: {
    basis: "enforced",
    reason:
      "That the exchange runs in retain mode, and the mode AGREEMENT is the " +
      "half the run holds: both parties advertise their retain_files setting in " +
      "the hello and a disagreement aborts both sides before any data moves " +
      "(BilateralModeMismatchError), so an exchange that runs at all is one both " +
      "parties ran in the stated mode. What the run does not hold is what " +
      "becomes of the transcript once it ends -- retain mode deletes nothing, " +
      "and the rendezvous location is the inviting party's to keep or clear -- " +
      "so that half is carried by the note rather than by the marker. Nothing " +
      "applies the inviter's declaration: the accepting party still sets its own " +
      "half, which is what leaves the mismatch to fast-fail (see " +
      "InvitationToken.inviterRetainsFiles). " +
      "Stated on either ground that puts an acceptor's run in retain mode -- the " +
      "inviter declaring it, or an invitation endpoint whose split-directory " +
      "shape requires it of the connection the acceptor is seeded with, where a " +
      "display gated on the declaration alone would say nothing to a party " +
      "consenting to a permanent transcript. One wording covers both: a split " +
      "rendezvous cannot be configured without retain mode on either side, so " +
      "the inviter offering one is running the mode this states. Delete mode is " +
      "not the mirror claim: a run killed outright, or one that fails after the " +
      "handshake, leaves files behind in either mode, so a stated negative would " +
      "promise a cleanup the transport does not make -- and an invitation " +
      "carrying no declaration has made no claim to state at all.",
    note:
      "Your partner runs this exchange in retain mode, so every file it writes " +
      "stays where the two of you meet instead of being deleted once it has " +
      "been read. What you send stays encrypted there, and nothing left behind " +
      "is your file or the matched result. The small files the two sides meet " +
      "through are not encrypted. Anyone who can read that location afterwards " +
      "sees that an exchange happened, when it ran, how many messages each " +
      "side sent and how large they were, the name each side ran under, and " +
      "the settings each side announced. Your side must run retain mode too, " +
      "or the two of you stop with an error when you meet. What becomes of " +
      "that transcript afterwards is your partner's decision, not something " +
      "this tool controls.",
  },
} as const satisfies Record<string, ConsentFact>;

/** A key of {@link CONSENT_FACTS}. */
export type ConsentFactId = keyof typeof CONSENT_FACTS;

/**
 * The terse marker a surface with no styling budget puts on a fact's own label to
 * hold its {@link ConsentFactBasis}. It lives here rather than in the renderer
 * that needs it so a further surface inherits the vocabulary instead of coining a
 * third one; the web holds the same distinction through its tiering and the
 * caveat copy, so it renders no marker.
 */
export const CONSENT_BASIS_MARKERS: Record<ConsentFactBasis, string> = {
  enforced: "enforced",
  "trust-contingent": "your partner's word",
};

/** The finding a `contradicted` half states, and the clause naming what governs
 * the run whatever the citation says. Both readers' caveats below are composed
 * from these two, so the sentences differ only in the remedy each reader can act
 * on -- never in what this build found. */
const CONTRADICTED_FINDING =
  "A half marked as not matching names a rule set psilink ships, and the " +
  "rules declared for it are NOT drawn from that set -- so the citation does " +
  "not describe what the exchange would match on.";

const CONTRADICTED_RULES_GOVERN =
  "the declared keys and fields are what the exchange holds both parties to, " +
  "and what would run.";

/**
 * The marker and the caveat a surface renders for ONE half of a cited linkage
 * rule set, keyed by this build's verdict on that half
 * ({@link LinkageRuleSetCitationVerdict}).
 *
 * Keyed by verdict rather than held on the `linkageRuleSet` fact, because the
 * caveat is exactly what the verdict changes: a single fixed sentence there
 * would be false of a half whose name this build resolves and compares, and
 * the two halves are decided independently, so one document can need two
 * different sentences at once.
 *
 * The marker goes on the half's own first-party LABEL, in place of the basis
 * marker, for two reasons. The basis vocabulary answers a different question
 * (does the exchange hold this, or does the partner's word) and has no way to say
 * that a citation has been disproved. And a marker placed after the value would
 * sit behind partner-controlled text on the line, where a crafted set name could
 * manufacture one.
 *
 * A `contradicted` half is a warning, never a refusal: the exchange still runs on
 * the declared keys and fields, which are what both parties are held to, and an
 * operator reading both the citation and the declared rules on one screen is the
 * party who decides what the mismatch means.
 *
 * Each `note` addresses the party the citation is shown TO. A surface whose
 * reader wrote the citation reads {@link linkageRuleSetVerdictNote} instead,
 * which swaps in the remedy that reader can act on and withholds the sentences
 * that have none rather than attributing the citation to the wrong party.
 *
 * Fixed first-party copy throughout -- no set name, version, or other
 * partner-controlled value reaches any of it -- so a surface renders it verbatim.
 */
export const LINKAGE_RULE_SET_VERDICT_COPY: Record<
  LinkageRuleSetCitationVerdict,
  { marker: string; note: string }
> = {
  consistent: {
    marker: "checked: matches",
    note:
      "A half marked as matching names a rule set psilink ships, and the rules " +
      "declared for it are drawn from that set. The declared keys and fields " +
      "are still what the exchange holds both parties to.",
  },
  contradicted: {
    marker: "checked: does not match",
    note:
      `${CONTRADICTED_FINDING} Treat the name as unreliable and settle it with ` +
      `the other party; ${CONTRADICTED_RULES_GOVERN}`,
  },
  unchecked: {
    marker: "not checked",
    note:
      "A half marked as not checked names a rule set psilink does not ship, so " +
      "nothing was compared against it. Your partner's declared keys and " +
      "fields are what the exchange holds both parties to.",
  },
};

/**
 * How severe each verdict is, lowest rank first: a reader who stops after one
 * line has read the one that changes their decision.
 *
 * A rank per verdict rather than an ordered list of them, so the union's
 * completeness is the type's to enforce: a verdict added to
 * {@link LinkageRuleSetCitationVerdict} and not ranked here fails to compile,
 * where a list would have silently sorted it out of every surface's caveats.
 */
const LINKAGE_RULE_SET_VERDICT_SEVERITY: Record<
  LinkageRuleSetCitationVerdict,
  number
> = {
  contradicted: 0,
  unchecked: 1,
  consistent: 2,
};

/**
 * The verdicts a citation's halves reached, deduplicated and ordered most severe
 * first: the caveats a surface renders beneath the two half lines, one per
 * distinct verdict rather than one per half.
 *
 * Shared for the reason the copy above is. The two halves usually agree, so a
 * per-half caveat would print one sentence twice; which sentences are printed,
 * and in what order, is then a judgment both surfaces must make identically, and
 * a renderer deciding it inline could state a `contradicted` half second or drop
 * it against a `consistent` one.
 */
export function distinctLinkageRuleSetVerdicts(
  ...verdicts: ReadonlyArray<LinkageRuleSetCitationVerdict>
): Array<LinkageRuleSetCitationVerdict> {
  return [...new Set(verdicts)].sort(
    (one, other) =>
      LINKAGE_RULE_SET_VERDICT_SEVERITY[one] -
      LINKAGE_RULE_SET_VERDICT_SEVERITY[other],
  );
}

/**
 * Who a surface is showing a citation's verdict to: the party the citation was
 * made to, or the party that wrote it.
 *
 * The distinction is the remedy, not the finding. A recipient cannot edit the
 * document, so the only move it has is to take the name up with the other party;
 * the citing party is looking at its own terms, which it can correct before it
 * proposes them.
 */
type LinkageRuleSetVerdictReader = "recipient" | "citing-party";

/** The caveats {@link linkageRuleSetVerdictNote} substitutes for a citing-party
 * reader. Only `contradicted` has one: the other two caveats attribute the
 * citation to a partner, so a surface showing the viewer its OWN citation
 * withholds them rather than rewording them. */
const LINKAGE_RULE_SET_CITING_PARTY_NOTES: Partial<
  Record<LinkageRuleSetCitationVerdict, string>
> = {
  contradicted:
    `${CONTRADICTED_FINDING} The terms are yours to correct: restore the rules ` +
    `the cited set declares, or drop the citation. Either way, ` +
    `${CONTRADICTED_RULES_GOVERN}`,
};

/**
 * The caveat `verdict` holds for a reader the citation was made TO:
 * {@link LINKAGE_RULE_SET_VERDICT_COPY}'s own sentence, which every verdict has.
 *
 * The selection lives here rather than in a renderer for the reason the copy
 * does. A surface picking between two sentences inline is a second place the
 * judgment is made, and the two readings of one finding are exactly where a
 * divergence would be hardest to see: both sentences are true, and only one is
 * actionable by the reader in front of it.
 */
export function linkageRuleSetVerdictNote(
  verdict: LinkageRuleSetCitationVerdict,
  reader: "recipient",
): string;
/**
 * The caveat `verdict` holds for a reader that may have WRITTEN the citation:
 * {@link LINKAGE_RULE_SET_CITING_PARTY_NOTES}'s substitute where the verdict has
 * one, the recipient's sentence for a reader that is not the citing party, and
 * `undefined` where a citing party has none.
 *
 * The `undefined` is a withholding rather than a gap: the caveats with no
 * substitute attribute the citation to a partner, so read back to the party that
 * wrote it they name the wrong author of its own terms. A surface renders nothing
 * there instead -- rewording is not this function's to do, since each reader's
 * sentence is copy, written once beside the one it stands in for.
 */
export function linkageRuleSetVerdictNote(
  verdict: LinkageRuleSetCitationVerdict,
  reader: LinkageRuleSetVerdictReader,
): string | undefined;
export function linkageRuleSetVerdictNote(
  verdict: LinkageRuleSetCitationVerdict,
  reader: LinkageRuleSetVerdictReader,
): string | undefined {
  return reader === "citing-party"
    ? LINKAGE_RULE_SET_CITING_PARTY_NOTES[verdict]
    : LINKAGE_RULE_SET_VERDICT_COPY[verdict].note;
}

/**
 * The caveat a surface reading a FILED exchange record renders beside the
 * rule-set citation it holds: the disclosure accounting's screen and the CSV it
 * exports.
 *
 * The same classification {@link LINKAGE_RULE_SET_VERDICT_COPY} holds, stated
 * for a reader who is holding the verdict rather than being shown it. A record's
 * citation is always paired with the writing party's verdict on it
 * (docs/spec/EXCHANGE_RECORD.md, "The writing party's verdict"), so a caveat
 * asserting that nothing checked the citation would be false of every record --
 * including one whose citation this build resolved and disproved. It points at
 * the verdict instead of restating its value: the accounting presents the
 * citation, and the record beside it is where the finding is read.
 *
 * States what a check could and could not establish rather than summarizing an
 * outcome, because one sentence serves all three verdicts here: silence must
 * not be treated as verification, and a name this build cannot resolve must
 * not be treated as one it checked.
 *
 * Fixed first-party copy naming no set, version, or party, so a surface renders
 * it verbatim beside the escaped names it qualifies.
 */
export const RECORDED_LINKAGE_RULE_SET_CAVEAT =
  "This citation is the authoring party's own declaration, recorded as " +
  "written. What psilink could check about it -- whether these names resolve " +
  "to a rule set it ships, and whether the declared rules are drawn from that " +
  "set -- is the writing party's verdict, recorded beside the citation in the " +
  "exchange record itself. What the exchange held both parties to is the " +
  "matching basis recorded beside it.";

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
 * the fact -- the divergence risk that keeping the copy here removes.
 *
 * Fixed first-party copy, naming no column: no partner-controlled value reaches
 * it, so a surface may render it verbatim.
 */
export const OUTBOUND_SEND_NO_PAYLOAD_SENTENCE =
  "Your partner receives no result from this exchange, so no columns are sent " +
  "to them -- whatever your file contains.";

/**
 * The disclosure statement a surface renders beside the algorithm for a
 * count-only (`psi-c`) exchange: what such a run reveals, in one line.
 *
 * The headline of the count-only tier, whose remaining facts are the
 * `countOnly*` entries of {@link CONSENT_FACTS}: what the rounds disclose
 * beside the count, who takes whose word for the number, and the bound a
 * partner's input choice puts on all of it. Read from here by both surfaces
 * so neither states the guarantee in its own words -- the count-only tier is
 * where a second account would cost most, since a reader takes "only a
 * number" for the safe option.
 *
 * Shared wording, not a shared placement: the web consent screen renders it as
 * its matching-method headline, where the CLI accept prompt names the algorithm
 * there and prints this line beneath it. Both surfaces render it, and the
 * `countOnly*` facts with it, for exactly a `psi-c` invitation.
 *
 * Fixed first-party copy naming no value, so a surface may render it verbatim.
 */
export const COUNT_ONLY_DISCLOSURE_STATEMENT =
  "Only the number of records you have in common is revealed, not which " +
  "records match.";

/**
 * The disclosure statement a surface renders beside the duplicate-matches
 * headline of a deduplicating invitation whose result reaches the ACCEPTING
 * party: what a deduplicating match reveals to that party that a one-to-one match
 * does not.
 *
 * One of the two statements the same headline takes, selected by the
 * invitation's output shape, since which party reads the grouping is what
 * the shape decides. The axis is `output.shareWithPartner` alone: a
 * deduplicating document must declare `output.expectsOutput`, so the two
 * shapes it can have are exactly this one (both parties receive) and the
 * inviting party as sole receiver, whose statement is
 * {@link DEDUPLICATE_SOLE_RECEIVER_DISCLOSURE_STATEMENT}. Rendering this one
 * for a sole-receiver invitation would state a disclosure this client does
 * not make: the accepting party is handed no result, so no grouping reaches
 * its operator.
 *
 * Drafted from the disclosure rows of docs/spec/PROTOCOL.md (The disclosure
 * delta a deduplicating match pays), and states three things those rows fix:
 * the party learning it is the ACCEPTING party (the "one" side, since the
 * declaring inviter is the "many" one), and per matched record of its own it
 * learns a count and a set of the inviting party's row indices -- the same
 * opaque row-index layer a one-to-one association table already holds, never
 * the linkage-key value behind them. The disclosure is bounded to MATCHED
 * groups: a group whose value the partner does not hold matches nothing and
 * is never counted.
 *
 * The last clause is the integrity limit and must not be dropped or softened:
 * the spec binds the aggregate and the positions but not the size of the group
 * standing behind any one of them (the many side's per-value multiplicity is
 * not independently bound), so a surface stating the count as a fact about the
 * inviting party's file would state a guarantee no check makes.
 *
 * Written in party names rather than "you", like the headline it sits with, so
 * the one sentence reads correctly from either party's side and no surface needs
 * a viewer-relative variant of it. Fixed first-party copy naming no value, so a
 * surface may render it verbatim.
 */
export const DEDUPLICATE_SHARED_RESULT_DISCLOSURE_STATEMENT =
  "Grouping is what a deduplicating match discloses: for each of the accepting " +
  "party's matched records, that party learns how many of the inviting party's " +
  "records share the matched linkage-key value and which of the inviting " +
  "party's rows they are -- a count and row positions, never the value behind " +
  "them, and only for groups that matched. That count is the inviting party's " +
  "own declaration, which psilink does not check against its data.";

/**
 * The disclosure statement for the other output shape a deduplicating invitation
 * can have: the inviting party receives the result and the accepting party
 * receives none, so psilink presents the grouping to the declaring party alone.
 *
 * The shape is representable and derives cleanly -- an invitation declaring
 * `output.expectsOutput` with `shareWithPartner` cleared, which acceptance
 * mirrors to an accepting party that expects nothing -- and it discloses
 * something real, so it takes a statement rather than silence: the result the
 * inviting party takes away links several of its own records to one of the
 * accepting party's, which is the grouping evidence a deduplicating run exists to
 * produce. What it must not hold is either half of
 * {@link DEDUPLICATE_SHARED_RESULT_DISCLOSURE_STATEMENT}'s account. The accepting
 * party is presented no count and no row positions, so stating them would name a
 * disclosure this client does not make; and the unverified-count limit that
 * statement ends on has nothing to bound here, since the party reading the count
 * is the one that declared it.
 *
 * The non-receipt half this statement holds is the DISPLAY half:
 * {@link runExchange} gates the association table it returns on this
 * party's own output entitlement, so a sole-receiver acceptance is handed
 * none (pinned in packages/core/test/linkageCardinality.test.ts). The
 * statement therefore says what this client presents and stops there. What
 * the wire does NOT withhold is a fact of its own, held by the
 * `duplicateGroupingDisplayLimit` entry of {@link CONSENT_FACTS} and
 * rendered beside this statement: it belongs to the partner's register
 * rather than the run's, so folding it in here would leave a
 * trust-contingent fact unclassified inside a sentence under an enforced
 * headline.
 *
 * That split is what keeps the `duplicateMatches` marker at `enforced` while the
 * limit is marked for what it is. The marker states its headline's own fact --
 * matching multiplicity, which the run does hold -- and the limit sitting past
 * what that marker holds is a classified fact beside it rather than an unmarked
 * clause within it. Reclassifying the headline instead would understate
 * a multiplicity the exchange enforces in order to qualify a display fact
 * standing beside it.
 *
 * What the accepting party does pay under either shape is the widening
 * {@link DEDUPLICATE_ACCEPTOR_SIDE_NOTE} holds, which is why that note renders
 * beside both statements rather than beside one.
 *
 * Written in party names rather than "you", and fixed first-party copy naming no
 * value, for the same reasons as its sibling.
 */
export const DEDUPLICATE_SOLE_RECEIVER_DISCLOSURE_STATEMENT =
  "Grouping is what a deduplicating match discloses, and under this invitation " +
  "the inviting party alone reads it: the result it receives links several of " +
  "its own records to a single one of the accepting party's records, which is " +
  "the evidence that those of its own rows name one individual. The accepting " +
  "party receives no result from this exchange, so psilink presents it no " +
  "group sizes and no row positions.";

/**
 * The direction note a surface renders beside whichever of the two disclosure
 * statements above the invitation's output shape selects, for the same
 * deduplicating invitation: whose records the setting groups, and what it still
 * costs the party whose records it does not group.
 *
 * The two are separate facts and a reader is entitled to both: the statement
 * says what a deduplicating match discloses, this says whose records are
 * grouped to disclose it. Accepting does NOT turn the setting on for the
 * accepting party -- `deriveAcceptedLinkageTerms` derives that party's own
 * `deduplicate` as false rather than adopting the invitation's, so the
 * accepting party's rows are never grouped -- and without this note a reader
 * would have no way to tell whether their own file is the one being grouped.
 *
 * What the derivation closes is the grouping direction, not the accepting
 * party's outbound disclosure, which the setting does move: more of that
 * party's records can match than in a one-to-one run of the same two files,
 * each one disclosing its membership and any payload columns it sends, on
 * the inviting party's declaration alone. A reader told only that their
 * records are not grouped would take that as no consequence at all.
 *
 * The note states that OUTCOME, not the mechanism behind it (recorded
 * instead in docs/notes/deduplicate-matching-semantics.md). It is a
 * widening rather than a new capability: an inviting party that collapsed
 * its own duplicate rows before the exchange would match exactly the same
 * records one-to-one, so the setting buys a hostile inviter nothing it
 * could not do locally.
 *
 * It names the way to the other direction rather than leaving it unsaid, because
 * the invitation path offers no control for it: each party's own `deduplicate`
 * comes from its own configuration file, and the two run `psilink exchange`.
 *
 * Rendered at the same visibility level as the statement it follows, by the
 * placement rule both surfaces hold: a reader who meets what a deduplicating
 * match discloses meets, in the same place, which side pays it.
 *
 * Fixed first-party copy naming no value, so a surface may render it verbatim.
 */
export const DEDUPLICATE_ACCEPTOR_SIDE_NOTE =
  "This setting is the inviting party's own: the accepting party's records are " +
  "never grouped. It still widens what the accepting party discloses -- more " +
  "of its records can match than in a plain one-to-one run of the same two " +
  "files, each one disclosing its membership and any payload columns it sends. " +
  "Grouping the accepting party's records instead is set up from each party's " +
  "own configuration file, where each party declares its own side.";

/**
 * The caveat copy for a term an inviter may declare that today's exchange does
 * not apply, keyed by the {@link APPLIED_SETTINGS} flag that gates it.
 *
 * `fuzzyComparisons` is the one such term. It has no refusal: it is a silent
 * no-op that narrows the match, so its marker says only that the expansion is
 * proposed, where claiming a refusal would describe a run that does not happen.
 * A term whose not-applying IS a refusal takes the opposite copy -- naming the
 * refusal and what to ask the inviter for -- which is what makes this a table
 * rather than a house style.
 *
 * Shared for the same reason the classification is.
 */
export const PROPOSED_NOT_APPLIED_NOTES = {
  fuzzyComparisons: "(proposed; not yet applied)",
} as const;

/**
 * The line a consent surface renders in place of a transform's matching
 * consequence when this version recognizes neither the function's literal slice
 * phrase nor a glossary description for it -- the two sources
 * {@link summarizeInvitation} fills `effect` and `description` from.
 *
 * The function name is partner free text: an invitation may declare any name the
 * schema admits, so a surface that renders the name inside a sentence of its own
 * ("applies <name>") states an effect on matching that this version cannot know
 * and does not perform, and a name chosen to look like an effect is then
 * indistinguishable from one. The name still belongs on the surface as
 * technical identity; what it must not do is stand where the consequence goes.
 *
 * Shared so the two consent surfaces state the same thing about the same
 * invitation: a rule this version cannot explain is stated as explicitly
 * unexplained on the CLI accept prompt and on the web consent screen alike.
 * Fixed first-party copy naming no value, so a surface may render it verbatim.
 */
export const UNRECOGNIZED_TRANSFORM_NOTE =
  "Not recognized by this version; its effect on matching is not shown.";
