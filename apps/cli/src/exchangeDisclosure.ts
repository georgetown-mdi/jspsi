// What a run authored from two parties' own configuration files shows the
// operator before it puts anything on the wire. The outbound-payload
// confirmation covers the party that accepted an invitation; this covers the
// party that wrote its own terms, which no consent record and no acceptance
// display stands behind.

import {
  CONSENT_FACTS,
  COUNT_ONLY_DISCLOSURE_STATEMENT,
  DEDUPLICATE_PARTNER_DECLARED_DISCLOSURE_STATEMENT,
  DEDUPLICATE_PARTNER_DECLARED_SIDE_NOTE,
  disclosedColumnNames,
  redactAndSanitizeForDisplay,
  summarizeInvitation,
  withholdsPartnerAssociationTable,
} from "@psilink/core";

import {
  consentSurfaceSink,
  marked,
  type ConsentSurfaceSink,
} from "./invitationDisplay";
import { singlePassDisclosureNotice } from "./onlineBootstrap";

import type {
  ExchangeDataSpec,
  LinkageTerms,
  Metadata,
  getLogger,
} from "@psilink/core";

/**
 * The heading the display leads with. It states what has been sent so far and
 * nothing about connection order: this display runs before an unpinned SFTP
 * configuration establishes first-use host-key trust over a credential-free
 * probe, so a heading promising that nothing has connected would go stale
 * moments later.
 */
const DISCLOSURE_HEADING =
  "What this exchange sends and matches on. Nothing has been sent yet:";

/** The label the outbound column list holds, spelled the way the acceptance
 * display and the outbound-payload confirmation both spell this same fact. */
const OUTBOUND_COLUMNS_LABEL = "columns you will send";

/**
 * What the display states for a count-only exchange whose input still marks a
 * column to send: `prepareForExchange` refuses that run a few lines later, so
 * the line states the outcome and the two ways out of it rather than a column
 * list the run will never transmit.
 */
const COUNT_ONLY_MARKED_COLUMNS_REFUSAL =
  "Your input marks one or more columns to send to your partner, which a " +
  "count-only exchange cannot do, so this run stops before it starts. Clear " +
  'the payload marking on those columns, or set the algorithm to "psi".';

/**
 * What the display states in place of an own-membership disclosure where this
 * party's own output block is the pair the terms exchange refuses:
 * `validateCompatibility` reads the partner's `expectsOutput` off this
 * document's `shareWithPartner`, so a document expecting no result and sharing
 * none is a run in which neither party expects output. That run stops at the
 * terms exchange, so what a partner would learn from it is nothing the
 * operator has to weigh. The remedy names the two configuration fields, since
 * either one settles it and each takes a matching value in the partner's own
 * file.
 */
const NO_PARTY_EXPECTS_OUTPUT_REFUSAL =
  "Neither you nor your partner expects a result from these terms, so this " +
  "run stops at the terms exchange, before any linkage data is sent. Set " +
  "expects_output to true if the result is yours to receive, or " +
  "share_with_partner to true if it is your partner's, and settle the " +
  "matching value with them.";

/**
 * The columns this party transmits for matched records, from the metadata this
 * run resolved -- the set {@link disclosedColumnNames} gathers and the payload
 * step transmits, so the display cannot overstate or understate what leaves the
 * machine.
 *
 * Three shapes send nothing and say why rather than printing a bare "(none)":
 * a partner entitled to no result is sent no payload whatever the input file
 * holds, a count-only exchange sends none in either direction, and a resolved
 * set that is empty discloses only the fact of a match. A count-only run whose
 * metadata WOULD transmit a column is refused a few lines later, in
 * `prepareForExchange`, so it states that refusal beside the count-only fact
 * rather than listing a set no run of these terms transmits.
 *
 * Each name is redacted and escaped here, at the composition site, since these
 * are operator-file strings with no display boundary of their own.
 */
function displayOutboundColumns(
  emit: ConsentSurfaceSink,
  linkageTerms: LinkageTerms,
  columns: ReadonlyArray<string>,
): void {
  const label = `  ${marked(OUTBOUND_COLUMNS_LABEL, "outboundSendSelfAuthored")}`;
  // The count-only case comes first, ahead of the output direction: it holds
  // both directions at once, and it is the shape a marked column is refused
  // over.
  if (linkageTerms.algorithm === "psi-c") {
    emit(`${label}: (none)`);
    emit(`    ${CONSENT_FACTS.countOnlyNoPayload.note}`);
    if (columns.length > 0) emit(`    ${COUNT_ONLY_MARKED_COLUMNS_REFUSAL}`);
    return;
  }
  if (!linkageTerms.output.shareWithPartner) {
    emit(
      `${label}: (none) -- your partner receives no result, so no payload is sent`,
    );
    return;
  }
  if (columns.length === 0) {
    emit(`${label}: (none) -- only matched records`);
    return;
  }
  emit(`${label}:`);
  for (const column of columns)
    emit(`    - ${redactAndSanitizeForDisplay(column)}`);
}

/**
 * @internal exported for testing
 *
 * Print what this run discloses and what it matches on, through `emit`.
 *
 * The matching facts are derived through {@link summarizeInvitation}, which
 * reads `linkageTerms` alone: the fields the keys match on, each key's
 * one-liner, and whether the strategy applies the grouping and candidate-set
 * terms the document declares. Deriving them here instead would be a second
 * reading of the same terms, free to disagree with the one the acceptance
 * surfaces render. The COPY is this seat's own -- the terms are the operator's
 * own file rather than a partner's proposal, so no line names an inviting or
 * accepting party.
 */
export function renderExchangeDisclosure(
  emit: ConsentSurfaceSink,
  linkageTerms: LinkageTerms,
  metadata: Metadata,
): void {
  const summary = summarizeInvitation({ linkageTerms });
  emit(DISCLOSURE_HEADING);
  displayOutboundColumns(emit, linkageTerms, disclosedColumnNames(metadata));

  const receivesResult = linkageTerms.output.expectsOutput;
  emit(
    `  ${marked(
      "you will receive the result",
      receivesResult ? "viewerReceivesResult" : "viewerReceivesNoResult",
    )}: ${receivesResult ? "yes" : "no"}`,
  );
  if (!receivesResult) emit(`    ${CONSENT_FACTS.viewerReceivesNoResult.note}`);
  // The partner's receipt takes its own basis, which the value decides: a
  // partner that receives is one the run delivers to, while a partner that does
  // not rests on the agreed terms being honored.
  const partnerFact = linkageTerms.output.shareWithPartner
    ? "partnerReceivesResult"
    : "partnerReceivesNoResult";
  emit(
    `  ${marked("your partner will receive the result", partnerFact)}: ` +
      (linkageTerms.output.shareWithPartner ? "yes" : "no"),
  );
  emit(`    ${CONSENT_FACTS[partnerFact].note}`);
  // What a partner entitled to no result still learns, which its receipt line
  // does not state: under `psi` an identifier-revealing match tells it which of
  // its own records are in this party's data, unless the run withholds its half
  // of the matched-pair table. No such line under `psi-c`, whose non-receiving
  // party is the sender -- it computes nothing from the round and is sent no
  // count report -- so the algorithm's disclosures stand there instead.
  //
  // The withheld variant here rests on the partner's own declaration rather
  // than on anything this run enforces: `withholdsPartnerAssociationTable`
  // reads this party's declared `payload.receive` against the partner's
  // declared `payload.send`, not the partner's resolved metadata, so it takes
  // the trust-contingent fact rather than the one the invitation seats read
  // off their own authored document.
  //
  // Ahead of both sentences: `validateCompatibility` holds the partner's
  // `expectsOutput` equal to this document's `shareWithPartner`, so a document
  // with neither is the "neither party expects output" pair it refuses
  // (linkageTermsNegotiation.ts) -- a run that stops at the terms exchange,
  // whose membership sentence would describe an exchange that does not happen.
  const neitherPartyExpectsOutput =
    !linkageTerms.output.expectsOutput && !linkageTerms.output.shareWithPartner;
  if (neitherPartyExpectsOutput) emit(`  ${NO_PARTY_EXPECTS_OUTPUT_REFUSAL}`);
  else if (
    !linkageTerms.output.shareWithPartner &&
    linkageTerms.algorithm === "psi"
  ) {
    const membershipFact = withholdsPartnerAssociationTable(linkageTerms)
      ? "partnerOwnMembershipWithheldSelfAuthored"
      : "partnerLearnsOwnMembership";
    emit(
      `  ${marked(
        "what your partner learns about its own records",
        membershipFact,
      )}:`,
    );
    emit(`    ${CONSENT_FACTS[membershipFact].note}`);
  }

  emit(`  ${marked("PSI algorithm", "algorithm")}: ${linkageTerms.algorithm}`);
  if (linkageTerms.algorithm === "psi-c")
    emit(`    ${COUNT_ONLY_DISCLOSURE_STATEMENT}`);
  emit(
    `  ${marked("linkage strategy", "linkageStrategy")}: ` +
      linkageTerms.linkageStrategy,
  );
  if (linkageTerms.linkageStrategy === "single-pass")
    emit(`    ${singlePassDisclosureNotice()}`);

  emit(
    `  ${marked("duplicate matches", "duplicateMatches")}: ` +
      (linkageTerms.deduplicate
        ? "several of your records may match a single one of your partner's"
        : "each of your records matches at most one of your partner's"),
  );
  // What the grouping this party declared discloses, and which party pays it,
  // in the wording written for a seat where each party declares its own value
  // against its own file. Withheld where the strategy applies no grouping: the
  // run is refused rather than matched loosely, so the statement would describe
  // an exchange that does not happen.
  if (linkageTerms.deduplicate && summary.deduplicateApplied) {
    emit(`    ${DEDUPLICATE_PARTNER_DECLARED_DISCLOSURE_STATEMENT}`);
    emit(`    ${DEDUPLICATE_PARTNER_DECLARED_SIDE_NOTE}`);
  }
  // Value-level matching multiplicity, beside the record-level line above.
  // Printed only where the strategy matches on the candidates: terms declaring
  // a split under one that does not are refused before the exchange runs.
  if (summary.fansOut && summary.fanOutApplied) {
    emit(`  ${marked("several values per record", "fanOutCandidates")}:`);
    emit(`    ${CONSENT_FACTS.fanOutCandidates.note}`);
  }

  if (summary.matchedFields.length > 0)
    emit(
      `  ${marked("matched on", "matchedFields")}: ` +
        summary.matchedFields.join(", "),
    );
  emit(`  ${marked("linkage keys", "linkageKeys")}:`);
  // One line per key: its name and the fields it combines, both already escaped
  // by the summary. The full element and transform detail stays in the
  // acceptance display, where a party is reading terms it did not write.
  for (const key of summary.linkageKeys)
    emit(
      `    - ${key.name}: ${key.headerFields.join(" - ")}` +
        (key.hasSwap ? " (matched in either order)" : ""),
    );
}

/**
 * Show what this run will disclose and match on, before any credential, terms,
 * or data are sent, for an exchange whose configuration the operator wrote
 * themselves.
 *
 * It asks nothing and refuses nothing: a run that is valid without it stays
 * valid, and every invocation renders the same lines whether or not a terminal
 * is attached. Rendered through {@link consentSurfaceSink} on the prompt
 * stream, like the outbound-payload confirmation beside it: this is the only
 * account this party gets of what its run discloses, so a raised
 * `--log-level` must not drop it. The `--log-file` copy takes `warn` for the
 * same reason -- at `info` a run quieted to `warn` would print the surface and
 * keep no record of it -- leaving `error` and `silent` the levels that record
 * none of it, as they record no other line either.
 *
 * A no-op for a configuration written by accepting an invitation, which holds
 * an outbound-payload consent record: that party read these facts when it
 * accepted, and the confirmation surface shows the columns again on any run
 * whose set is not the one it confirmed. Printing here as well would state them
 * twice.
 *
 * An acceptance records nothing where the partner is entitled to no result,
 * since no column is sent to it whatever the input file holds. Those runs reach
 * the display, which states that same absence and the terms beside it.
 */
export function displayExchangeDisclosure(params: {
  /** The spec this run prepares from; its consent record decides whether the
   * confirmation surface covers this party already. */
  spec: ExchangeDataSpec;
  /** The metadata this run resolved -- the source of what it would transmit. */
  metadata: Metadata;
  /** The terms this run resolved, which decide what it matches on. */
  linkageTerms: LinkageTerms;
  /** The operator's `--log-file`, so the log keeps a copy of the surface. */
  logFile: string | undefined;
  log: ReturnType<typeof getLogger>;
}): void {
  const { spec, metadata, linkageTerms, logFile, log } = params;
  if (spec.outboundPayloadConsent !== undefined) return;
  renderExchangeDisclosure(
    consentSurfaceSink({ log, logFile, toPromptStream: true, level: "warn" }),
    linkageTerms,
    metadata,
  );
}
