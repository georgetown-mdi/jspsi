import {
  CONSENT_BASIS_MARKERS,
  CONSENT_FACTS,
  COUNT_ONLY_DISCLOSURE_STATEMENT,
  DEDUPLICATE_ACCEPTOR_SIDE_NOTE,
  DEDUPLICATE_SHARED_RESULT_DISCLOSURE_STATEMENT,
  DEDUPLICATE_SOLE_RECEIVER_DISCLOSURE_STATEMENT,
  displayText,
  distinctLinkageRuleSetVerdicts,
  LINKAGE_RULE_SET_VERDICT_COPY,
  MAX_DECLARED_NAMES_SHOWN,
  PROPOSED_NOT_APPLIED_NOTES,
  redactAndSanitizeForDisplay,
  ruleSetCitation,
  summarizeInvitation,
  UNRECOGNIZED_TRANSFORM_NOTE,
  unshownDeclaredNamesLine,
} from "@psilink/core";

import { singlePassDisclosureNotice } from "./onlineBootstrap";
import { writePromptLine } from "./util/cli";

import type { DialedBrokerHostAndPort } from "./connection/webrtc/brokerClient";
import type {
  ConsentFactId,
  Displayable,
  InvitationKeySummary,
  InvitationRuleSetSummary,
  InvitationSummary,
  InvitationToken,
  LinkageRuleSetCitationVerdict,
  getLogger,
} from "@psilink/core";

/**
 * Where one rendered line of the consent surface is written. The renderer takes
 * this rather than a logger because where the surface has to appear depends on
 * whether the operator is about to be asked to consent to it --
 * {@link consentSurfaceSink} builds it for the asking and unattended paths alike.
 */
export type ConsentSurfaceSink = (line: string) => void;

/**
 * The level a consent line takes where the log records it. `info` is the surface
 * itself; `warn` is for a line an operator has to read even at a level that has
 * already dropped the surface -- the notice an acceptance raises for an
 * `--identity` its kept configuration overrides.
 */
export type ConsentSurfaceLevel = "info" | "warn";

/**
 * The sink {@link displayInvitation} renders through, resolved from what the
 * operator chose for diagnostics and whether acceptance will stop to ask them.
 *
 * When acceptance will PROMPT, every line goes to the prompt's own sink
 * ({@link writePromptLine}) at every `--log-level`, plain: the terms the y/N
 * question asks about are text the operator reads to answer it rather than a
 * diagnostic record, so they render byte for byte the same whatever the operator
 * set the log to, and the timestamp-level-context prefix -- about 50 of an
 * 80-column console's columns -- stays off them. The log's own copy is written
 * only where it lands somewhere other than the terminal the question is asked on,
 * which is what a `--log-file` makes it: the file keeps the run's record, and
 * nothing prints the multi-screen outline to the terminal twice. The level still
 * governs that recorded copy, so `--log-file` under a level above the line's own
 * records nothing while the prompt is shown the surface regardless.
 *
 * When nothing asks -- `--consent-to-terms` -- there is no question for the terms
 * to be read beside, so they stay ordinary diagnostic output on the routing the
 * operator chose: `--log-file` captures them for the unattended run's record and
 * a level above the line's own drops them.
 *
 * The prompt/log split reads the parsed `--log-file` rather than asking the
 * installed diagnostic sink where it writes, which an opaque function cannot be
 * asked, so a caller must feed that same value to `configureLogging`.
 */
export function consentSurfaceSink(params: {
  log: ReturnType<typeof getLogger>;
  logFile: string | undefined;
  willPrompt: boolean;
  level?: ConsentSurfaceLevel;
}): ConsentSurfaceSink {
  const { log, logFile, willPrompt, level = "info" } = params;
  return (line: string) => {
    if (!willPrompt) {
      log[level](line);
      return;
    }
    if (logFile !== undefined) log[level](line);
    writePromptLine(line);
  };
}

/**
 * The label a classified fact carries: its own wording plus the terse basis marker
 * from the shared classification, so the operator reads whether the exchange holds
 * the fact or the inviting party merely declared it. A terminal has no styling
 * budget for the tiering the web consent screen uses, and the marker sits on the
 * first-party LABEL rather than after the value, so no partner-controlled string
 * precedes it on the line and none can be read as carrying it.
 *
 * An optional note joins the marker inside the same parenthetical, for a label whose
 * value alone leaves a magnitude unstated. It rides the label for the reason the
 * marker does, so it must be first-party text: nothing a partner controls belongs in
 * one.
 */
function marked(label: string, fact: ConsentFactId, note?: string): string {
  const basis = CONSENT_BASIS_MARKERS[CONSENT_FACTS[fact].basis];
  return `${label} (${note === undefined ? basis : `${basis}, ${note}`})`;
}

/**
 * The label one half of a cited rule set carries: its own wording plus this
 * build's verdict on that half, from the shared table. It stands in for the basis
 * marker on these two lines, which the block's own label already carries -- what
 * an operator needs beside a set name is whether psilink could check it and what
 * it found, which the enforced/partner's-word vocabulary cannot say.
 *
 * On the LABEL for the reason {@link marked} is: the set name and version that
 * follow are partner-controlled, so a marker placed after them could be
 * manufactured by a crafted name.
 */
function verdictMarked(
  label: string,
  verdict: LinkageRuleSetCitationVerdict,
): string {
  return `${label} (${LINKAGE_RULE_SET_VERDICT_COPY[verdict].marker})`;
}

/**
 * The rules' citation: the two set identities the inviting party names, each
 * under this build's verdict on it, and then one caveat per verdict in `notes`.
 *
 * One renderer for the two places the block appears -- with the terms it cites,
 * and repeated in the decision block above the prompt -- so the second is a
 * repetition rather than a second account of the same citation. Only the caveats
 * differ between them, which is what `notes` selects.
 *
 * Keys before fields, since the key set is the specific artifact and the field
 * set the substrate it is built from. Both names and both versions are
 * partner-controlled, sanitized by the summary, and each follows a fixed
 * first-party label on its own line so none can begin a line or be read as
 * carrying the marker before it. Each half renders through core's terms-value
 * seam ({@link ruleSetCitation}), the same grammar core's own rule-set mismatch
 * message and the browser consent screen render this pair with, so whatever a
 * name spells reads as content of one value rather than as structure this line
 * asserted.
 *
 * The seam runs after the summary's escape, not before: the escape truncates and
 * redacts, and either applied to an already-delimited run could take the closing
 * delimiter off it. The two passes compose -- the seam emits only printable
 * ASCII, which the escape leaves alone -- so neither doubles the other's work.
 */
function displayRuleSetCitation(
  emit: ConsentSurfaceSink,
  ruleSet: InvitationRuleSetSummary,
  notes: ReadonlyArray<LinkageRuleSetCitationVerdict>,
): void {
  emit(`  ${marked("linkage rule set", "linkageRuleSet")}:`);
  emit(
    `    ${verdictMarked("keys", ruleSet.keySet.verdict)}: ` +
      ruleSetCitation(ruleSet.keySet.name, ruleSet.keySet.version),
  );
  emit(
    `    ${verdictMarked("fields", ruleSet.fieldSet.verdict)}: ` +
      ruleSetCitation(ruleSet.fieldSet.name, ruleSet.fieldSet.version),
  );
  for (const verdict of notes)
    emit(`    ${LINKAGE_RULE_SET_VERDICT_COPY[verdict].note}`);
}

/**
 * The wording the outbound-send line carries when the acceptor's own disclosed set
 * is not yet determined at prompt time -- an offline acceptance with no input file,
 * which leaves the resolved spec without metadata and leaves this acceptance
 * nothing to prepare from.
 *
 * It states what actually happens next on THIS path: the acceptance records that
 * the set is unconfirmed, and `psilink exchange` resolves it from the input file it
 * is given (from the config's metadata if one was written, else inferred from the
 * CSV header) and shows it for confirmation before any credential, terms, or data
 * are sent. So the line points ahead to a checkpoint that exists, in the register
 * the web's own forward reference uses -- there the acceptor chooses its file on
 * the same screen and confirms the set before consenting; here the same
 * confirmation is simply deferred to the run that can resolve it. The unattended
 * case is named too, because it is the one where the answer is a refusal rather
 * than a question.
 */
const OUTBOUND_SEND_FORWARD_REFERENCE = {
  value: "not yet known",
  note:
    "Determined from your input file when the exchange runs, which shows the " +
    "columns and asks you to confirm them before anything is sent; a run with " +
    "no terminal to ask on refuses instead of sending them.",
};

/**
 * The wording the outbound-send line carries when the invitation gives the inviting
 * party no result: the payload step transmits nothing at all to a partner not
 * entitled to one (an empty message goes on the wire in its place), so no column
 * leaves this machine whatever the input file holds, and listing a set that never
 * moves would overstate the disclosure the `enforced` marker stands behind.
 *
 * The displayed direction and the run's own gate are the same fact with an aborting
 * check between them: acceptance mirrors the invitation's output direction into this
 * party's terms, and the compatibility check refuses a partner presenting terms that
 * disagree with that mirror.
 *
 * It wins over both other cases. Over the not-yet-known forward reference, because
 * the input file that would settle the set cannot change this answer -- pointing at
 * it would send the operator to look for something that does not bear on it. Over
 * the empty-set tail, because when the acceptor also discloses nothing both are
 * true and this is the one that survives the operator changing their input file,
 * where "only matched records" is a property of the metadata resolved for this
 * acceptance alone.
 */
const OUTBOUND_SEND_NO_PAYLOAD =
  "(none) -- the inviting party receives no result, so no payload is sent";

/**
 * Render the coordination server an acceptance dials, for a line the operator
 * reads: the partner-supplied host escaped at this sink, the port appended
 * outside that escape.
 *
 * The port is outside because the escape truncates at a cap the host can reach
 * on its own -- the invitation schema admits a host as long as the whole display
 * budget -- and the port is what such a line exists to carry beyond the plain
 * authority. It is safe there: the broker-location resolver refuses a port
 * outside 1-65535 before a location reaches this, so the unescaped half is an
 * integer of this side's own rather than anything a partner spelled.
 *
 * Shared by the two sinks that name the server, the surface line and the
 * confirmation question, so neither can escape a joined value and lose the port.
 *
 * {@link Displayable} rather than `string`, composed through
 * {@link displayText}: the brand is what makes dropping the escape a compile
 * error instead of a review catch, and the tag is the one composition that keeps
 * it across the port append (plain interpolation yields `string`). The tag adds
 * no bytes, so the rendered line is exactly what the template produced.
 */
export function renderDialedBroker(
  broker: DialedBrokerHostAndPort,
): Displayable {
  return displayText`${redactAndSanitizeForDisplay(broker.host)}:${broker.port}`;
}

/**
 * State that this acceptance conducts the exchange itself, and where: the one
 * command both writes the configuration and dials, so the operator's answer to
 * the question below is the last checkpoint before their data moves, on a
 * locator they never typed.
 *
 * It heads the surface rather than sitting among the terms because it is not one:
 * the terms are the inviting party's proposal, while this is what THIS command
 * does with them. The prompt carries the same locator, so the fact is on screen
 * at the question too without the outline being interrupted to put it there.
 *
 * `brokerAuthority` is the host and port the dial resolves to, partner-supplied
 * (the invitation's endpoint) and reaching no display boundary of its own, so it
 * is escaped here, at its sink, and sits at the end of its line behind a fixed
 * first-party label like every other partner-controlled value on this surface.
 */
function logAcceptanceRunsExchange(
  emit: ConsentSurfaceSink,
  brokerAuthority: DialedBrokerHostAndPort,
  promptFollows: boolean,
): void {
  emit(
    "This acceptance runs the exchange itself, through the coordination " +
      `server this invitation names: ${renderDialedBroker(brokerAuthority)}`,
  );
  emit(
    promptFollows
      ? "  Confirming connects to that server immediately and runs the " +
          "exchange from your input file, transmitting your linkage data on " +
          "the terms below; declining writes nothing and connects to nothing."
      : "  This run connects to that server immediately and runs the exchange " +
          "from your input file, transmitting your linkage data on the terms " +
          "below; --consent-to-terms recorded that consent in advance.",
  );
}

/**
 * The heading above the repeated decision block on the prompting path, where the
 * question this block is answered against comes next.
 */
const REPEATED_FACTS_HEADING_BEFORE_PROMPT =
  "Before you accept, repeated from above:";

/**
 * The heading above the repeated decision block under `--consent-to-terms`, where
 * consent is already recorded and nothing follows to answer. The block beneath is
 * byte-identical to the prompting path's, which is what keeps both printings one
 * wording rather than two.
 */
const REPEATED_FACTS_HEADING_UNATTENDED = "Repeated from above:";

/**
 * Emits one indented line per entry, so a name containing the list separator
 * cannot be misread as two entries: `sanitizeForDisplay` neutralizes control,
 * bidi, and non-ASCII code points but leaves a printable ASCII comma intact, and
 * every list this renders holds partner- or operator-controlled names.
 */
function logList(
  emit: ConsentSurfaceSink,
  indent: string,
  entries: ReadonlyArray<string>,
): void {
  for (const entry of entries) emit(`${indent}- ${entry}`);
}

/**
 * One declared payload direction's column names, painted at most
 * {@link MAX_DECLARED_NAMES_SHOWN} deep and closed by the shared line counting the
 * names it left out. Only the declared payload directions take the count bound:
 * every other list {@link logList} renders is already bounded at its source or is
 * this party's own, and a declared direction is the one that reaches
 * `MAX_PAYLOAD_ENTRIES` names of partner text.
 *
 * The bound is on what is PAINTED. The direction's label, its "(none)" case, and
 * everything else the prompt derives from the declaration read the whole set, so a
 * cut list never understates what the operator is consenting to.
 *
 * The closing line is first-party text and carries no bullet, while a painted name
 * always does and cannot break its own line (`sanitizeForDisplay` neutralizes every
 * control code point). Among the lines this EMITS, that prefix is what keeps a
 * declared name reading exactly as this sentence from passing for it -- the terminal
 * analogue of the list container the web surfaces distinguish it by.
 *
 * The distinction is at the emitted line, not at the terminal ROW: soft wrap starts
 * a continuation row at column 0, and the escape passes an ASCII space verbatim, so
 * a name padded to the wrap boundary reproduces the bare count row byte for byte at
 * a matching width. That residual is stated rather than closed -- any printable
 * prefix is equally fakeable, the renderer cannot know the terminal's width, and the
 * genuine line still prints exactly once per bounded direction, which is the signal
 * left to recover the true remainder from. The direction's own heading states the
 * same magnitude from above the first painted name, where no partner text precedes
 * it at all ({@link declaredPayloadTotalNote}).
 */
function logDeclaredPayloadList(
  emit: ConsentSurfaceSink,
  indent: string,
  names: ReadonlyArray<string>,
): void {
  logList(emit, indent, names.slice(0, MAX_DECLARED_NAMES_SHOWN));
  const unshownCount = names.length - MAX_DECLARED_NAMES_SHOWN;
  if (unshownCount > 0)
    emit(`${indent}${unshownDeclaredNamesLine(unshownCount)}`);
}

/**
 * The magnitude note one declared payload direction's label carries: how many names
 * that direction's declaration holds, counted over the whole declared set rather
 * than the subset {@link logDeclaredPayloadList} paints. The web consent screen
 * states the same magnitude beside its lists; this is the terminal's form of it.
 *
 * A count and a fixed word, like the closing line it corroborates: the length of a
 * partner-controlled list carries none of that list's free text, so the label stays
 * text the partner cannot reach.
 */
function declaredPayloadTotalNote(declaredCount: number): string {
  return `${declaredCount} declared`;
}

/**
 * The declared matching rules of one linkage key: its ordered elements with the
 * field each derives from, the transforms it applies (each with the plain-language
 * consequence, its parameters, and any runtime coercion), the fuzzy-comparison
 * expansion it declares, and the swap the key declares over two of them.
 *
 * Every value here arrives already escaped from {@link summarizeInvitation}, the
 * single display boundary; nothing is escaped again (a second pass would double a
 * backslash in a partner name). The key's `id` -- the raw, unsanitized key name --
 * is deliberately untouched: `name` is the displayable form.
 */
function displayLinkageKey(
  emit: ConsentSurfaceSink,
  key: InvitationKeySummary,
): void {
  emit(`    - ${key.name}`);
  // The derived field one-liner, above the declared rules: the key's `name` is
  // partner free text and is the only other line at this key's own level, so
  // without this the operator scanning key headings reads nothing but strings the
  // inviter chose. Every entry here is a fixed compact label for the element's
  // schema-validated field type plus a fixed breadth marker, so the joined line
  // carries no partner text and cannot be misread across the separator.
  emit(
    `      matches on: ${key.headerFields.join(" - ")}` +
      (key.hasSwap ? " (matched in either order)" : ""),
  );
  emit("      elements:");
  for (const element of key.elements) {
    emit(`        - ${element.fieldLabel}`);
    if (element.fuzzyComparison !== undefined)
      emit(
        `          also matches approximate variants (${element.fuzzyComparison})` +
          (element.fuzzyComparisonApplied
            ? ""
            : ` ${PROPOSED_NOT_APPLIED_NOTES.fuzzyComparisons}`),
      );
    for (const transform of element.transforms) {
      emit(`          transform: ${transform.function}`);
      // Lead with the plain matching consequence where there is one: the literal
      // slice phrase when it is faithful, else the glossary description. A function
      // the standardization layer does not recognize has neither, and would
      // otherwise print in the same shape as a recognized rule minus one line --
      // indistinguishable from a rule psilink understands. Mark it instead, so a
      // rule this version cannot explain is as explicit as one it cannot apply.
      if (transform.effect !== undefined)
        emit(`            matches on ${transform.effect}`);
      else if (transform.description !== undefined)
        emit(`            ${transform.description}`);
      else emit(`            ${UNRECOGNIZED_TRANSFORM_NOTE}`);
      logList(emit, "            ", transform.params);
      // The coercion note is core-derived on both halves (the function's own
      // parameter name and the value core's coercion contract runs it as), and sits
      // on its own line rather than folded into a parameter line, so partner text
      // placed inside a parameter value cannot impersonate it.
      for (const coercion of transform.coercions ?? [])
        emit(`            ${coercion.param} runs as ${coercion.runsAs}`);
    }
  }
  if (key.hasSwap)
    emit(
      key.swap !== undefined
        ? `      swap: ${key.swap[0]} and ${key.swap[1]} may be matched in either order`
        : "      swap: two of these elements may be matched in either order",
    );
  // On the receiving side a swap moves each element's field reference to the other
  // element while its transforms stay put, so each element's rules run against the
  // OTHER element's value. The generic swap note above does not convey that, so the
  // interchange (both sides carry transforms) or the one-directional donor (exactly
  // one does) is stated outright.
  if (key.swapTransformInterchange && key.swap !== undefined)
    emit(
      `      note: when matched in that order, the transforms shown for ` +
        `${key.swap[0]} are applied to ${key.swap[1]}'s value, and those for ` +
        `${key.swap[1]} to ${key.swap[0]}'s value`,
    );
  if (key.swapTransformDonor !== undefined)
    emit(
      `      note: when matched in that order, the transforms shown for ` +
        `${key.swapTransformDonor[0]} are applied to ` +
        `${key.swapTransformDonor[1]}'s value`,
    );
}

/**
 * The PII the linkage keys are computed over, each field with the data standards
 * the inviter commits it to.
 *
 * The categories the keys draw on are what the run computes, so they carry the
 * enforced marker; the standards under them are the inviter's own undertaking that
 * psilink warns about rather than filters on, so they sit under their own
 * trust-contingent heading rather than reading as rules the exchange applies. The
 * constraint phrases are fixed copy derived from the schema; the allowed-character
 * class is a partner-authored regular expression bound in the value position after
 * a fixed first-party label, never paraphrased as a vetted allow-list -- a crafted
 * class (a leading `^` negation, a shorthand or bracket breakout) admits a very
 * different set than it reads as. Its shared caveat is emitted once, for the whole
 * list, the way the web consent screen captions its constraints group.
 */
function displayLinkageFields(
  emit: ConsentSurfaceSink,
  summary: InvitationSummary,
): void {
  emit(`  ${marked("personal data used", "personalDataCategories")}:`);
  for (const field of summary.linkageFields) {
    emit(`    - ${field.label}`);
    const standards = [...field.constraints];
    if (field.allowedCharacters !== undefined)
      standards.push(`allowed characters: ${field.allowedCharacters}`);
    if (standards.length === 0) continue;
    emit(
      `      ${marked("declared data standards", "declaredDataStandards")}:`,
    );
    logList(emit, "        ", standards);
  }
  if (summary.linkageFields.some((f) => f.allowedCharacters !== undefined)) {
    emit(
      `  ${marked("allowed-character patterns", "allowedCharacterPatterns")}:`,
    );
    emit(`    ${CONSENT_FACTS.allowedCharacterPatterns.note}`);
  }
}

/**
 * @internal exported for testing
 *
 * The facts the acceptance decision turns on, printed by this one function at both
 * of the two points the operator needs them: heading the terms, and again
 * immediately above the confirmation prompt.
 *
 * The terms run to well over a screen -- far past what a terminal shows at the
 * prompt -- so an operator answering it is looking at the tail, and these facts
 * have scrolled away. Printing them twice from one renderer is what
 * makes the second printing a repetition rather than a second account: there is
 * one wording, so the two cannot drift and no check is needed to keep them
 * agreeing. Composing a separate summary here instead would reintroduce exactly
 * that gap.
 *
 * A count-only exchange puts its whole disclosure tier in this block rather than in
 * the body below, and that is the selection rather than an overflow: under `psi-c`
 * what the run discloses IS the decision, so the facts an operator answering the
 * prompt must have in front of them are the tier's, not the terms they qualify.
 *
 * Every partner-controlled value keeps the treatment it has above -- preceded on
 * its own line by a fixed first-party label -- so none of them can begin a line or
 * manufacture one.
 */
export function logDecisionFacts(
  emit: ConsentSurfaceSink,
  summary: InvitationSummary,
  ownOutboundSend: ReadonlyArray<string> | undefined,
): void {
  // Lead with the acceptor's OWN outbound disclosure -- the columns it will send to
  // the partner for matched records, its hardest-to-undo consent -- before the
  // inviter's proposed terms, matching the web acceptor flow. An invitation that
  // gives the inviting party no result transmits no payload at all, so the line
  // states that instead of any column set (see {@link OUTBOUND_SEND_NO_PAYLOAD}).
  // Otherwise undefined is the not-yet-known case (no metadata resolved): say so and
  // name what settles it, rather than assert a count. An empty set is a truthful
  // "(none)", not a presupposed non-empty disclosure.
  const outboundLabel = marked("columns you will send", "outboundSend");
  const countOnly = summary.algorithm === "psi-c";
  // The count-only "(none)" below states a precondition of the algorithm rather than
  // a set this renderer read: psi-c admits no payload in either direction, and a
  // terms document or input metadata declaring one is refused where the terms are
  // authored, at the local prepare step, and at the agreed-terms run boundary
  // (docs/spec/PROTOCOL.md, PSI-C). This set is not the terms -- it is this party's
  // OWN resolved metadata -- and the accept path refuses that arrangement ahead of
  // this prompt, naming what to clear (assertCountOnlyTransmitsNoColumn, applied in
  // validateAccept); this throw is the render-side backstop behind it. Printing
  // "(none)" over a column would take the operator's consent to a disclosure that
  // happens. The message states the fact and names no column.
  if (countOnly && (ownOutboundSend?.length ?? 0) > 0)
    throw new Error(
      "count-only exchange resolved a non-empty outbound column set: a psi-c " +
        "run carries no payload in either direction",
    );
  // The mirror of that check on what the INVITATION declares, which this prompt
  // prints below as the received and requested column blocks: a psi-c document
  // declaring a send or a receive asks for exactly the column movement the algorithm
  // refuses, and the tier's no-payload sentence printed above a block listing the
  // columns the inviting party requests from this one would state a guarantee the
  // same prompt contradicts. The invitation is partner-controlled, so this side
  // cannot assume the authoring refusal ran -- what it can assume is its own
  // decode, which applies the same rule (LinkageTermsSchema). Both directions,
  // since the sentence covers both.
  if (
    countOnly &&
    ((summary.payload?.send.length ?? 0) > 0 ||
      (summary.payload?.receive.length ?? 0) > 0)
  )
    throw new Error(
      "count-only terms declare a payload column: a psi-c run moves no " +
        "payload in either direction",
    );
  if (countOnly) {
    // The algorithm answers this slot ahead of the entitlement the other cases read:
    // a count-only exchange carries no payload in either direction whoever receives
    // the count, so the reason no column leaves is one the shared sentence states
    // and OUTBOUND_SEND_NO_PAYLOAD cannot. The value stays the bare "(none)" the
    // empty cases use, with the reason on its own line, so the sentence is read
    // rather than restated in this outline's value shape.
    emit(`  ${outboundLabel}: (none)`);
    emit(`    ${CONSENT_FACTS.countOnlyNoPayload.note}`);
  } else if (!summary.inviterReceivesOutput)
    emit(`  ${outboundLabel}: ${OUTBOUND_SEND_NO_PAYLOAD}`);
  else if (ownOutboundSend === undefined) {
    emit(`  ${outboundLabel}: ${OUTBOUND_SEND_FORWARD_REFERENCE.value}`);
    emit(`    ${OUTBOUND_SEND_FORWARD_REFERENCE.note}`);
  } else if (ownOutboundSend.length === 0)
    emit(`  ${outboundLabel}: (none) -- only matched records`);
  else {
    emit(`  ${outboundLabel}:`);
    logList(
      emit,
      "    ",
      ownOutboundSend.map((column) => redactAndSanitizeForDisplay(column)),
    );
  }

  emit(
    `  ${marked("inviting party", "invitingParty")}: ${summary.invitingParty}`,
  );
  emit(`    ${CONSENT_FACTS.invitingParty.note}`);
  emit(`  ${marked("PSI algorithm", "algorithm")}: ${summary.algorithm}`);
  // A count-only algorithm states a DISCLOSURE guarantee, so the tier that qualifies
  // it sits with the headline it bears on rather than further down. Every sentence is
  // read from the shared table, so the two surfaces cannot state different outcomes
  // for one invitation. COUNT_ONLY_DISCLOSURE_STATEMENT is shared wording rather than
  // a shared placement -- the web screen carries it as its matching-method headline,
  // where this prompt names the algorithm and prints the statement beneath it.
  if (countOnly) {
    emit(`    ${COUNT_ONLY_DISCLOSURE_STATEMENT}`);
    emit(`    ${CONSENT_FACTS.countOnlyResult.note}`);
    emit(
      `  ${marked("what a count-only exchange still discloses", "countOnlyRoundDisclosures")}:`,
    );
    emit(`    ${CONSENT_FACTS.countOnlyRoundDisclosures.note}`);
    // Only where both parties are entitled to the count does one of them hold a
    // number it did not compute: where exactly one is entitled, that party is the
    // receiver by the role rule and computes its own, so the line would name a
    // report no run makes.
    if (summary.inviterReceivesOutput && summary.inviterSharesResult) {
      emit(
        `  ${marked("how the count reaches each of you", "countOnlyReportedCount")}:`,
      );
      emit(`    ${CONSENT_FACTS.countOnlyReportedCount.note}`);
    }
    // Last of the tier and never omitted: it is the bound on the guarantee the
    // headline states, and a reader who takes "only a number" for the safe option
    // is the reader this line is for.
    emit(
      `  ${marked("what a count-only exchange does not bound", "countOnlyInputChoice")}:`,
    );
    emit(`    ${CONSENT_FACTS.countOnlyInputChoice.note}`);
  }

  // A citation this build resolved and DISPROVED, repeated here for the reason
  // the whole block is repeated: the terms run well past a screen, and this fact
  // has scrolled away by the time the prompt is answered. Accepting writes the
  // citation into this party's own disclosure record, so the operator answering
  // the prompt is the one who decides what a name their build can prove wrong is
  // worth. Only the contradicted CAVEAT is lifted -- the other two verdicts say
  // what has and has not been checked, which is context for the citation rather
  // than a fact the decision turns on -- while the citation itself renders whole,
  // both halves under their own markers, so the operator reads which name is
  // disproved rather than only that one is.
  const citation = summary.linkageRuleSet;
  if (
    citation !== undefined &&
    (citation.keySet.verdict === "contradicted" ||
      citation.fieldSet.verdict === "contradicted")
  )
    displayRuleSetCitation(emit, citation, ["contradicted"]);

  // What outlives the run, which is why it sits in the decision block rather than
  // among the terms: an acceptor is agreeing to a permanent transcript at the
  // rendezvous location, and the run is over by the time anything else would tell
  // them. Printed wherever the invitation discloses retain mode -- declared, or
  // entailed by a split-directory endpoint this accept would seed the mode from.
  // An invitation that declares delete mode, or declares nothing, and names no
  // such endpoint prints nothing here, since neither absence is a cleanup this
  // transport promises (see the shared table's entry).
  //
  // The fact is repeated; its caveat is not. That note runs to ten wrapped lines
  // on an eighty-column terminal, which at two printings is what pushes the
  // outbound-send list -- the acceptor's hardest-to-undo consent, and the reason
  // this block leads with it -- off a short screen at the prompt: it drops the
  // point past which the repetition scrolls an eighty-by-twenty-four terminal
  // from roughly seventeen disclosed columns to seven. So the block carries the
  // line the acceptor decides on, and displayInvitation prints the caveat once
  // beneath this block's first printing. Nothing shortened stands in for it here:
  // an abridgement is a second account of the fact, which is what the two
  // printings being one wording exists to rule out.
  //
  // Last of the block so that caveat lands directly under the line it explains,
  // whatever else the block reached above it -- an adjacency the accept unit
  // suite checks rather than this comment asserting it.
  if (summary.disclosesRetainedFiles)
    emit(
      `  ${marked("exchange files", "retainedFiles")}: kept as a permanent ` +
        "transcript, not deleted after the run",
    );
}

/**
 * @internal exported for testing
 *
 * Print, before the acceptance prompt, everything the operator is consenting to:
 * their own outbound disclosure first, then every term of the inviter's proposal
 * that decides what is matched or what is disclosed -- under `psi` what is matched
 * decides which identifiers are revealed, so a matching rule this omitted would be
 * consented to unseen.
 *
 * Where `emit` puts the surface decides what the operator SEES, which is why it is
 * a parameter rather than a logger: on the prompting path it has to reach the
 * terminal the y/N question is asked on whatever the operator's diagnostic routing
 * is, and on the unattended path it is diagnostic output like any other. Build it
 * with {@link consentSurfaceSink}, which resolves both cases; the behavior is
 * documented for the operator in docs/CLI.md, under acceptance.
 *
 * The inviter's terms are read through `summarizeInvitation`, the display model the
 * web consent screen renders from, so the two surfaces cannot drift on what an
 * acceptor is shown or on the escaping of the partner-controlled strings in it. Its
 * companion classification (`CONSENT_FACTS`) supplies both the basis marker each
 * fact's label carries and the caveat sentence beneath it, so neither surface
 * decides for itself whether a fact is enforced or what to say about it. A term
 * today's exchange does not apply (the per-element fuzzy expansion) is marked as
 * proposed, in the shared wording, so the prompt never states a matching behavior
 * the run does not perform. A term the run does apply that widens what is
 * disclosed carries the shared statement of what it costs instead: the count-only
 * tier for `psi-c`, and the grouping disclosure for `deduplicate`, which carries
 * with it the note of whose records are grouped to pay it -- the inviting party's
 * alone, acceptance deriving this party's own side as false.
 *
 * `ownOutboundSend` is the columns THIS party will disclose to the partner for
 * matched records -- its own outbound disclosure, the hardest-to-undo fact it
 * consents to here. It is `disclosedColumnNames` over the acceptor's own resolved
 * metadata (exactly the set `preparePayload` transmits), so the prompt cannot
 * overstate what leaves this machine; `undefined` when that set is not yet
 * determined at prompt time (see {@link OUTBOUND_SEND_FORWARD_REFERENCE}), an empty
 * array when the acceptor discloses nothing. Neither value is rendered when the
 * invitation gives the inviting party no result, since the payload step then sends
 * nothing at all (see {@link OUTBOUND_SEND_NO_PAYLOAD}). Unlike the inviter's terms
 * these names are operator-file strings that reach no display boundary of their own,
 * so they are escaped here, at their sink.
 *
 * `promptFollows` says whether a confirmation prompt runs after this returns. It
 * selects the heading above the repeated decision block, and the tense of the
 * run statement below, and nothing else: the decision block itself is
 * byte-identical either way, so the two printings stay one wording.
 *
 * `runsExchangeThrough` is the coordination server an acceptance that conducts
 * the exchange itself will dial, present on that path alone; an acceptance that
 * writes a configuration and stops passes nothing and its surface is unchanged
 * (see {@link logAcceptanceRunsExchange}).
 */
export function displayInvitation(params: {
  token: InvitationToken;
  ownOutboundSend: ReadonlyArray<string> | undefined;
  emit: ConsentSurfaceSink;
  promptFollows: boolean;
  runsExchangeThrough?: DialedBrokerHostAndPort;
}): void {
  const { token, ownOutboundSend, emit, promptFollows, runsExchangeThrough } =
    params;
  const summary = summarizeInvitation(token);
  if (runsExchangeThrough !== undefined)
    logAcceptanceRunsExchange(emit, runsExchangeThrough, promptFollows);
  emit("Invitation details:");
  logDecisionFacts(emit, summary, ownOutboundSend);
  // The retain fact's shared caveat, once, under the block's own last line, which
  // is the fact it explains. It is the half of that fact the run does not hold --
  // what becomes of the transcript afterwards, and what the location shows anyone
  // who can read it -- so it belongs in the outline an acceptor reads through
  // rather than in the block, which carries the fact itself at one line. What its
  // length costs there is stated with the emit above.
  if (summary.disclosesRetainedFiles)
    emit(`    ${CONSENT_FACTS.retainedFiles.note}`);
  // The linkage strategy is a mandatory-consistency term (like the algorithm),
  // and single-pass is disclosure-affecting -- it is the load-bearing thing the
  // acceptor consents to here -- so show it plainly and, for single-pass, the
  // disclosure-tradeoff note. The value is a schema enum, not partner free text;
  // the note is shared with the inviter's selection surface so both parties read
  // identical framing.
  emit(
    `  ${marked("linkage strategy", "linkageStrategy")}: ` +
      summary.linkageStrategy,
  );
  if (summary.linkageStrategy === "single-pass")
    emit(`    ${singlePassDisclosureNotice()}`);
  // Stated from the accepting party's perspective (this summary is shown only to
  // the acceptor, before it confirms): YOU receive iff the inviter shares, and the
  // inviter receives iff its terms expect output. For a one-sided invitation this
  // tells the acceptor plainly whether it gets a result, rather than leaving it to
  // invert the inviter's "shares with partner" bit.
  //
  // The two lines are NOT equally enforced, which is the whole reason each carries
  // its basis: this party's own non-receipt is a hard fact the run holds, while
  // withholding a result from the partner rests on the agreed terms being honored.
  // Presenting them alike would let a cooperative undertaking read as a guarantee.
  //
  // The partner's line is not one register either, so its marker follows the VALUE
  // rather than the line: a partner that does receive is one the run itself delivers
  // to, and only its use of the result rests on the agreement, while a partner that
  // does not rests on the agreement for the whole fact. Marking a disclosure that
  // certainly happens as merely the partner's word is the same error facing the
  // other way.
  emit(
    `  ${marked("you will receive the result", "viewerReceivesResult")}: ` +
      (summary.inviterSharesResult ? "yes" : "no"),
  );
  if (!summary.inviterSharesResult)
    emit(`    ${CONSENT_FACTS.viewerReceivesNoResult.note}`);
  emit(
    `  ${marked(
      "the inviting party will receive the result",
      summary.inviterReceivesOutput
        ? "partnerReceivesResult"
        : "partnerReceivesNoResult",
    )}: ` + (summary.inviterReceivesOutput ? "yes" : "no"),
  );
  emit(
    `    ${
      summary.inviterReceivesOutput
        ? CONSENT_FACTS.partnerReceivesResult.note
        : CONSENT_FACTS.partnerReceivesNoResult.note
    }`,
  );
  // The honest-helper membership disclosure, kept apart from the cooperative caveat
  // above rather than folded under it: that caveat is about a partner that does not
  // honor the terms, while this holds however honestly the partner behaves -- so it
  // is a fact of its own, and carries the opposite basis.
  //
  // Gated on the algorithm, because that is what decides whether the disclosure
  // happens at all: by the role rule the non-receiving party of a count-only run is
  // the SENDER, which computes nothing from the round and is sent no count-report
  // frame (docs/spec/PROTOCOL.md, PSI-C), so it learns no membership of its own
  // records. What a count-only run does disclose is the tier logDecisionFacts prints
  // above.
  if (!summary.inviterReceivesOutput && summary.algorithm !== "psi-c") {
    emit(
      `  ${marked("what your partner learns either way", "partnerLearnsOwnMembership")}:`,
    );
    emit(`    ${CONSENT_FACTS.partnerLearnsOwnMembership.note}`);
  }
  emit(
    `  ${marked("duplicate matches", "duplicateMatches")}: ` +
      (summary.deduplicate
        ? "more than one of the inviting party's records may match a single one of the accepting party's records"
        : "each of the inviting party's records matches at most one of the accepting party's records"),
  );
  // What a deduplicating match reveals that a one-to-one one does not, beneath
  // the headline it qualifies -- the same shared wording the web consent screen
  // renders with its own copy of that headline. Printed for exactly a
  // deduplicating invitation: a one-to-one exchange discloses no grouping at all,
  // so the sentence would name a disclosure that does not happen. WHICH sentence
  // follows the output shape, since that is what decides who reads the grouping:
  // this party reads it where the inviter shares the result, and where the
  // inviter is the sole receiver it is presented none. The direction note follows
  // either of them at the same level and for the same invitation: the setting is
  // the inviting party's own, since acceptance derives this party's side as false
  // (deriveAcceptedLinkageTerms) rather than adopting the invitation's, and the
  // note also carries what a deduplicating run still widens on this side. The
  // derivation is what scopes these sentences to a ONE-SIDED run: an exchange
  // grouping both parties' records takes each of them declaring its own side in
  // its own configuration file, which is the route the direction note names, and
  // is nothing an acceptance of this invitation produces on its own.
  //
  // Gated on the applied flag as well as the setting: an invitation whose
  // strategy matches no deduplicating cardinality is refused at acceptance
  // (assertDeduplicateImplemented), so stating what its grouping discloses would
  // describe a run that does not happen.
  if (summary.deduplicate && summary.deduplicateApplied) {
    emit(
      `    ${
        summary.inviterSharesResult
          ? DEDUPLICATE_SHARED_RESULT_DISCLOSURE_STATEMENT
          : DEDUPLICATE_SOLE_RECEIVER_DISCLOSURE_STATEMENT
      }`,
    );
    // The sole-receiver statement states the withholding this client makes; what
    // the rounds still carry to this party's own process is the fact beside it,
    // read from the shared table with its own basis rather than folded into the
    // sentence. It follows only that shape: where the inviter shares the result,
    // this party is presented the grouping and there is no display limit to
    // qualify.
    if (!summary.inviterSharesResult)
      emit(`    ${CONSENT_FACTS.duplicateGroupingDisplayLimit.note}`);
    emit(`    ${DEDUPLICATE_ACCEPTOR_SIDE_NOTE}`);
  }

  // Value-level matching multiplicity, stated beside the record-level line above
  // because the two are easily read as one: a key element that splits its value
  // matches on each candidate, and the removal rule then decides how many
  // pairings that can produce. Rendered only when the terms declare a fan-out --
  // the element transforms are all an invitation carries, the inviter's own
  // standardization being invisible to it -- and which of the two facts is
  // stated follows the strategy, like the partner-receipt pair above.
  if (summary.fansOut) {
    const fact = summary.fanOutApplied ? "fanOutCandidates" : "fanOutRefused";
    emit(`  ${marked("several values per record", fact)}:`);
    emit(`    ${CONSENT_FACTS[fact].note}`);
  }

  // The fields the keys actually match on, one short line ahead of the two long
  // matching blocks, so the single fact consent most depends on is legible without
  // scrolling back through the keys and their combinations. Each entry is a fixed
  // compact label for a schema-validated field type, so the joined line carries no
  // partner text.
  if (summary.matchedFields.length > 0)
    emit(
      `  ${marked("matched on", "matchedFields")}: ` +
        summary.matchedFields.join(", "),
    );

  // The rules' citation, ahead of the fields and keys it cites so a reader meets
  // the name before the enumeration it stands for -- and meets, in the same
  // place, that the name is the inviting party's word, that this build's own
  // verdict on it is beside it, and that the enumeration beneath is what the
  // exchange holds both parties to. Here the block carries one caveat per DISTINCT
  // verdict the two halves reached, in descending severity, rather than one per
  // half: where both halves reached the same verdict the sentence covers both, and
  // where they differ each half's marker is what ties it to its caveat.
  if (summary.linkageRuleSet !== undefined)
    displayRuleSetCitation(
      emit,
      summary.linkageRuleSet,
      distinctLinkageRuleSetVerdicts(
        summary.linkageRuleSet.keySet.verdict,
        summary.linkageRuleSet.fieldSet.verdict,
      ),
    );

  // The short, high-level field list precedes the long key list: the keys enumerate
  // the combinations OF these fields, and on a terminal the block printed second is
  // the one that scrolls the first off the screen.
  displayLinkageFields(emit, summary);
  emit(`  ${marked("linkage keys", "linkageKeys")}:`);
  for (const key of summary.linkageKeys) displayLinkageKey(emit, key);

  // The columns the inviter declares it will transmit for matched records, in the
  // inviter's namespace -- what this party will RECEIVE. Derived from the wire's own
  // disclosure predicate (the token's carried disclosedPayloadColumns) when the
  // invitation carries one, falling back to the authored payload.send otherwise. A
  // lazy send -- no carried subset and nothing authored -- is omitted, since it
  // reconciles at exchange time; that omission is what leaves a bare "(none)"
  // unambiguous, since only a declared direction reaches the line at all. What the
  // declaration commits its party to, and what a violation of it costs, is
  // docs/CLI.md's to state.
  //
  // The two sources carry different bases, so the marker is selected from which one
  // the summary used: only the carried subset is locked in and reconciled against.
  if (summary.payload?.sendDeclared === true) {
    const label = marked(
      "columns you will receive",
      summary.payload.sendFromCarriedSubset
        ? "inboundPayloadColumnsCarried"
        : "inboundPayloadColumnsAuthored",
      declaredPayloadTotalNote(summary.payload.send.length),
    );
    if (summary.payload.send.length === 0) emit(`  ${label}: (none)`);
    else {
      emit(`  ${label}:`);
      logDeclaredPayloadList(emit, "    ", summary.payload.send);
    }
  }
  // The opposite direction: the columns the inviter requests FROM this party for
  // matched records -- what YOU may send. Same declaration gate as above: an absent
  // receive reconciles lazily (the inviter takes whatever your metadata discloses)
  // and prints nothing, so the "(none)" a declared empty set prints is the inviter
  // asking for no column rather than asking for none in particular.
  if (summary.payload?.receiveDeclared === true) {
    const label = marked(
      "columns the inviting party requests from you",
      "requestedPayloadColumns",
      declaredPayloadTotalNote(summary.payload.receive.length),
    );
    if (summary.payload.receive.length === 0) emit(`  ${label}: (none)`);
    else {
      emit(`  ${label}:`);
      logDeclaredPayloadList(emit, "    ", summary.payload.receive);
    }
  }

  if (summary.legalAgreement !== undefined) {
    emit(`  ${marked("legal agreement", "legalAgreement")}:`);
    emit(`    reference: ${summary.legalAgreement.reference}`);
    // "stated purpose", not "purpose": the value is partner-authored free text,
    // sanitized but never vetted -- only byte-compared against this party's own copy
    // at exchange time -- so the label marks it as partner-attested.
    emit(`    stated purpose: ${summary.legalAgreement.purpose}`);
    emit(
      `    agreement valid through: ${summary.legalAgreement.expirationDate}`,
    );
  }

  if (summary.expires !== undefined)
    emit(`  ${marked("expires", "invitationExpiry")}: ${summary.expires}`);

  // Nothing is printed after this, so what the prompt is answered against is these
  // facts rather than the tail of the key list. Both headings say "repeated"
  // because that is the whole claim being made: this block introduces nothing, and
  // the operator who read the terms from the top has already seen every line of it.
  // Only the framing differs -- with no prompt following, nothing is being asked,
  // and a heading that said otherwise would invite a decision already recorded.
  emit(
    promptFollows
      ? REPEATED_FACTS_HEADING_BEFORE_PROMPT
      : REPEATED_FACTS_HEADING_UNATTENDED,
  );
  logDecisionFacts(emit, summary, ownOutboundSend);
}
