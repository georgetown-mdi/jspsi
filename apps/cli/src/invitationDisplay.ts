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
 * The sink {@link displayInvitation} renders through, resolved from the
 * operator's diagnostic routing and whether acceptance will prompt.
 *
 * When `willPrompt`, every line goes to {@link writePromptLine} unformatted,
 * regardless of `--log-level`, plus the log at `level` when `logFile` is
 * set (so the run's record gets a copy without a second print to the
 * terminal). Otherwise lines are ordinary diagnostic output at `level`,
 * filtered by `--log-level` as usual.
 *
 * Pass the resolved `--log-file` value: the installed log sink cannot be
 * asked where it writes, so a caller must feed the same value to
 * `configureLogging`.
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
 * The label a classified fact takes: its own wording plus the terse basis
 * marker from the shared classification, standing in for the web consent
 * screen's styled tiering that a terminal has no budget for. The marker
 * sits on the first-party LABEL, before the value, so no partner-controlled
 * string can precede it or be read as holding it.
 *
 * An optional note joins the marker in the same parenthetical, for a label
 * whose value alone leaves a magnitude unstated; it must be first-party
 * text for the same reason.
 */
function marked(label: string, fact: ConsentFactId, note?: string): string {
  const basis = CONSENT_BASIS_MARKERS[CONSENT_FACTS[fact].basis];
  return `${label} (${note === undefined ? basis : `${basis}, ${note}`})`;
}

/**
 * The label one half of a cited rule set takes: its own wording plus this
 * build's verdict on that half, from the shared table. It replaces the
 * basis marker on these two lines -- what an operator needs beside a set
 * name is whether psilink could check it and what it found, not the
 * enforced/partner's-word vocabulary {@link marked} uses elsewhere.
 *
 * The verdict sits on the LABEL, like {@link marked}: the set name and
 * version that follow are partner-controlled, so a marker placed after
 * them could be manufactured by a crafted name.
 */
function verdictMarked(
  label: string,
  verdict: LinkageRuleSetCitationVerdict,
): string {
  return `${label} (${LINKAGE_RULE_SET_VERDICT_COPY[verdict].marker})`;
}

/**
 * The rules' citation: the two set identities the inviting party names, each
 * under this build's verdict on it, and then one caveat per verdict in
 * `notes`.
 *
 * One renderer for both call sites -- beside the terms, and repeated in the
 * decision block above the prompt -- so the second printing is a repetition
 * rather than a second account; `notes` selects which caveats appear.
 *
 * Keys before fields: the key set is the artifact, the field set its
 * substrate. Both names and versions are partner-controlled but already
 * sanitized by the summary, and each renders through core's citation
 * grammar ({@link ruleSetCitation}) behind its own fixed first-party label,
 * so a crafted name displays as content of one value rather than as
 * structure. The citation grammar must run on already-escaped text, never
 * before: the escape truncates and redacts, and running it after the
 * grammar's delimiters could strip the closing one.
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
 * The wording the outbound-send line takes when the acceptor's own
 * disclosed set is not yet determined at prompt time -- an offline
 * acceptance with no input file, so the resolved spec has no metadata to
 * prepare from.
 *
 * It names the checkpoint that resolves this later: `psilink exchange`
 * derives the set from the input file it is given (the config's metadata
 * if one was written, else the CSV header) and shows it for confirmation
 * before anything is sent. It also names the unattended case, where that
 * checkpoint is a refusal rather than a question.
 */
const OUTBOUND_SEND_FORWARD_REFERENCE = {
  value: "not yet known",
  note:
    "Determined from your input file when the exchange runs, which shows the " +
    "columns and asks you to confirm them before anything is sent; a run with " +
    "no terminal to ask on refuses instead of sending them.",
};

/**
 * The wording the outbound-send line takes when the invitation gives the
 * inviting party no result: the payload step sends an empty message in
 * place of any payload, so no column leaves this machine whatever the
 * input file holds, and listing one would overstate the disclosure the
 * `enforced` marker stands behind. The compatibility check enforces the
 * same direction acceptance mirrors into this party's own terms, so the
 * two cannot disagree.
 *
 * This case takes precedence over the not-yet-known and empty-set wordings
 * below: neither the input file nor an empty disclosure changes an answer
 * that depends only on whether the inviting party receives a result. Full
 * precedence argument: docs/notes/shared-consent-summary.md, "The
 * outbound-send line, and what it stands behind".
 */
const OUTBOUND_SEND_NO_PAYLOAD =
  "(none) -- the inviting party receives no result, so no payload is sent";

/**
 * Render the coordination server an acceptance dials, for a line the
 * operator reads: the partner-supplied host escaped at this sink, the port
 * appended outside that escape.
 *
 * The port is safe unescaped: the broker-location resolver refuses one
 * outside 1-65535 before a location reaches here, so it is always this
 * side's own integer, never partner text. It sits outside the escape
 * because the escape truncates at a cap the host alone can already reach.
 *
 * Shared by the two sinks that name the server (the surface line and the
 * confirmation question), so neither can lose the port by re-escaping the
 * joined value.
 *
 * Returns {@link Displayable}, composed through {@link displayText}, so
 * dropping the escape is a compile error rather than a review catch; the
 * tag adds no bytes, so the rendered line is exactly what the template
 * produced.
 */
export function renderDialedBroker(
  broker: DialedBrokerHostAndPort,
): Displayable {
  return displayText`${redactAndSanitizeForDisplay(broker.host)}:${broker.port}`;
}

/**
 * States that this acceptance conducts the exchange itself, and where: the
 * one command both writes the configuration and dials, so the operator's
 * answer to the prompt below is the last checkpoint before their data
 * moves, on a locator they never typed.
 *
 * It heads the surface rather than sitting among the terms: the terms are
 * the inviting party's proposal, this is what THIS command does with them.
 * The prompt repeats the same locator, so it stays on screen at the
 * question.
 *
 * `brokerAuthority` is partner-supplied (the invitation's endpoint) and
 * reaches no display boundary of its own, so it is escaped here, at its
 * sink, behind a fixed first-party label like every other partner-
 * controlled value on this surface.
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
 * {@link MAX_DECLARED_NAMES_SHOWN} deep and closed by the shared line
 * counting the names left out. Only the declared payload directions take
 * this bound; every other list {@link logList} renders is already bounded
 * at its source or is this party's own.
 *
 * The bound is on what is PAINTED: the direction's label, its "(none)"
 * case, and everything else the prompt derives from the declaration read
 * the whole set, so a cut list never understates what the operator is
 * consenting to ({@link declaredPayloadTotalNote}).
 *
 * The closing line has no bullet; a painted name always does
 * (`sanitizeForDisplay` neutralizes every control code point, so a name
 * cannot break its own line) -- that is what stops a declared name from
 * passing for the closing line.
 *
 * Known limit: a name padded to the terminal's wrap width can reproduce
 * the closing line's soft-wrapped shape at a matching width, since the
 * escape passes an ASCII space through untouched. The direction's own
 * heading states the true total above the first painted name regardless
 * ({@link declaredPayloadTotalNote}).
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
 * The magnitude note one declared payload direction's label takes: how many
 * names that direction's declaration holds, counted over the whole
 * declared set rather than the subset {@link logDeclaredPayloadList}
 * paints. The web consent screen states the same magnitude beside its
 * lists; this is the terminal's form of it.
 *
 * A count and a fixed word, like the closing line it corroborates: the
 * length of a partner-controlled list holds none of that list's free text,
 * so the label stays text the partner cannot reach.
 */
function declaredPayloadTotalNote(declaredCount: number): string {
  return `${declaredCount} declared`;
}

/**
 * The declared matching rules of one linkage key: its ordered elements
 * with the field each derives from, the transforms it applies (each with
 * the plain-language consequence, its parameters, and any runtime
 * coercion), the fuzzy-comparison expansion it declares, and the swap the
 * key declares over two of them.
 *
 * Every value here arrives already escaped from {@link summarizeInvitation},
 * the single display boundary; nothing is escaped again (a second pass
 * would double a backslash in a partner name). The key's `id` -- the raw,
 * unsanitized key name -- stays untouched by design: `name` is the
 * displayable form.
 */
function displayLinkageKey(
  emit: ConsentSurfaceSink,
  key: InvitationKeySummary,
): void {
  emit(`    - ${key.name}`);
  // The derived field one-liner, above the declared rules: the only other
  // line at this key's own level besides the key's own (partner-authored)
  // name, so a heading scan does not read only inviter-chosen strings.
  // Each entry is a fixed compact label plus a fixed breadth marker, so the
  // joined line holds no partner text and cannot be misread across the
  // separator.
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
      // Lead with the plain matching consequence where there is one: the
      // literal slice phrase when faithful, else the glossary description.
      // An unrecognized function has neither and would otherwise print
      // like a recognized rule minus one line -- indistinguishable from
      // one psilink understands. Mark it instead, so an unexplained rule
      // is as explicit as an inapplicable one.
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
  // On the receiving side a swap moves each element's field reference to
  // the other element while its transforms stay put, so each element's
  // rules run against the OTHER element's value. The generic swap note
  // above does not say that, so the interchange (both sides have
  // transforms) or the one-directional donor (exactly one does) is stated
  // outright.
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
 * The PII the linkage keys are computed over, each field with the data
 * standards the inviter commits it to.
 *
 * The categories the keys draw on are what the run computes, so they take
 * the enforced marker; the standards under them are the inviter's own
 * undertaking that psilink warns about rather than filters on, so they sit
 * under their own trust-contingent heading rather than displaying as rules
 * the exchange applies. The allowed-character class is a partner-authored
 * regular expression, never paraphrased as a vetted allow-list -- a
 * crafted class (a leading `^` negation, a shorthand or bracket breakout)
 * admits a different set than it displays as. Its caveat is emitted once,
 * for the whole list.
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
 * The facts the acceptance decision turns on, printed by this one function
 * at both points the operator needs them: heading the terms, and again
 * immediately above the confirmation prompt. One function for both call
 * sites keeps the two printings byte-identical, so they cannot drift and
 * no check is needed to hold them in agreement.
 *
 * A count-only exchange puts its whole disclosure tier in this block
 * rather than the body below: under `psi-c` what the run discloses IS the
 * decision, so that is what the prompt must show.
 *
 * Every partner-controlled value keeps the treatment it has above:
 * preceded on its own line by a fixed first-party label, so none can begin
 * a line or manufacture one.
 */
export function logDecisionFacts(
  emit: ConsentSurfaceSink,
  summary: InvitationSummary,
  ownOutboundSend: ReadonlyArray<string> | undefined,
): void {
  // Lead with the acceptor's OWN outbound disclosure -- the columns it
  // will send the partner for matched records, its hardest-to-undo
  // consent -- before the inviter's proposed terms. `undefined` is the
  // not-yet-known case (no metadata resolved yet): name what resolves it
  // rather than assert a count. An empty array is a truthful "(none)", not
  // an assumed non-empty disclosure.
  const outboundLabel = marked("columns you will send", "outboundSend");
  const countOnly = summary.algorithm === "psi-c";
  // psi-c admits no payload in either direction (docs/spec/PROTOCOL.md,
  // PSI-C); the accept path already refuses a resolved metadata set that
  // disagrees (`assertCountOnlyTransmitsNoColumn`, applied in
  // validateAccept). This throw is the render-side safety check behind
  // that refusal, so printing "(none)" here can never mask a disclosure
  // that actually happens.
  if (countOnly && (ownOutboundSend?.length ?? 0) > 0)
    throw new Error(
      "count-only exchange resolved a non-empty outbound column set: a psi-c " +
        "run sends no payload in either direction",
    );
  // The mirror check on what the INVITATION declares (printed below as
  // the received/requested column blocks): a psi-c document declaring a
  // send or receive asks for the payload movement the algorithm refuses.
  // The invitation is partner-controlled, so this side cannot assume the
  // authoring refusal ran; it can only assume its own decode applies the
  // same rule (`LinkageTermsSchema`). Checked in both directions.
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
    // A count-only exchange moves no payload in either direction whoever
    // receives the count, so the reason is the shared tier sentence below,
    // not `OUTBOUND_SEND_NO_PAYLOAD` (which covers a different case: an
    // entitled inviter who still receives nothing).
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
  // A count-only algorithm states a disclosure guarantee, so its
  // qualifying tier sits with the headline it bears on, not further down.
  // `COUNT_ONLY_DISCLOSURE_STATEMENT` is shared wording, not shared
  // placement: the web screen uses it as the matching-method headline,
  // this prompt prints it beneath the algorithm name.
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

  // A citation this build resolved and DISPROVED, repeated here since
  // accepting writes it into this party's own disclosure record: the
  // operator answering the prompt is the one who decides what a name their
  // build can prove wrong is worth. Only the contradicted CAVEAT is
  // lifted -- the other two verdicts are context for the citation, not a
  // fact this decision turns on -- while the citation itself always
  // renders whole, both halves under their own markers.
  const citation = summary.linkageRuleSet;
  if (
    citation !== undefined &&
    (citation.keySet.verdict === "contradicted" ||
      citation.fieldSet.verdict === "contradicted")
  )
    displayRuleSetCitation(emit, citation, ["contradicted"]);

  // What outlives the run: an acceptor is agreeing to a permanent
  // transcript at the rendezvous location, so this belongs in the decision
  // block, not the terms. Printed wherever the invitation discloses retain
  // mode -- declared, or entailed by a split-directory endpoint this
  // accept would seed the mode from. Prints nothing for delete mode or an
  // undeclared strategy naming no such endpoint.
  //
  // The fact is repeated here; its caveat is not -- displayInvitation
  // prints the caveat once, beneath this block's first printing, never an
  // abridged stand-in. Full accounting of the printed-twice budget:
  // docs/notes/shared-consent-summary.md, "A fact repeated, a caveat
  // stated once".
  //
  // Last of the block so the caveat lands directly under the line it
  // explains; the accept unit suite checks that adjacency, not this
  // comment.
  if (summary.disclosesRetainedFiles)
    emit(
      `  ${marked("exchange files", "retainedFiles")}: kept as a permanent ` +
        "transcript, not deleted after the run",
    );
}

/**
 * @internal exported for testing
 *
 * Prints, before the acceptance prompt, everything the operator is
 * consenting to: their own outbound disclosure first, then every term of
 * the inviter's proposal that decides what is matched or disclosed.
 *
 * `emit` is a parameter rather than a logger because where the surface has
 * to land differs by path: the terminal the y/N question is asked on
 * during prompting, ordinary diagnostic output otherwise. Build it with
 * {@link consentSurfaceSink}; operator-facing behavior is documented in
 * docs/CLI.md, under acceptance.
 *
 * The inviter's terms are read through `summarizeInvitation`, the same
 * display model the web consent screen renders from, and classified
 * through `CONSENT_FACTS`, which supplies each label's basis marker and
 * caveat -- so neither surface decides for itself what is enforced or what
 * to say about it. A term this build does not apply is marked proposed,
 * in the shared wording; a term that widens disclosure includes the
 * shared statement of what it costs.
 *
 * `ownOutboundSend` is the columns THIS party will disclose to the partner
 * for matched records: `disclosedColumnNames` over the acceptor's own
 * resolved metadata, the same set `preparePayload` transmits, so the
 * prompt cannot overstate what leaves this machine. `undefined` means that
 * set is not yet determined ({@link OUTBOUND_SEND_FORWARD_REFERENCE}); an
 * empty array means the acceptor discloses nothing. Neither is rendered
 * when the invitation gives the inviting party no result
 * ({@link OUTBOUND_SEND_NO_PAYLOAD}). Escaped here, at its sink, since
 * these are operator-file strings with no display boundary of their own.
 *
 * `promptFollows` selects only the heading above the repeated decision
 * block and the tense of the run statement; the block itself renders
 * byte-identical either way.
 *
 * `runsExchangeThrough` is the coordination server a self-conducting
 * acceptance will dial, present on that path alone
 * ({@link logAcceptanceRunsExchange}).
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
  // The retain fact's shared caveat, once, directly under the block's own
  // last line, which is the fact it explains: the half of that fact the
  // run does not hold -- what becomes of the transcript afterwards, and
  // what the location shows anyone who can read it -- so it belongs in the
  // outline an acceptor reads through, not the block, which states the
  // fact itself at one line.
  if (summary.disclosesRetainedFiles)
    emit(`    ${CONSENT_FACTS.retainedFiles.note}`);
  // The linkage strategy is a mandatory-consistency term like the
  // algorithm, and single-pass is disclosure-affecting -- the critical
  // thing the acceptor consents to here -- so show it plainly plus, for
  // single-pass, the disclosure-tradeoff note. The value is a schema enum,
  // not partner free text; the note is shared with the inviter's selection
  // surface so both parties read identical framing.
  emit(
    `  ${marked("linkage strategy", "linkageStrategy")}: ` +
      summary.linkageStrategy,
  );
  if (summary.linkageStrategy === "single-pass")
    emit(`    ${singlePassDisclosureNotice()}`);
  // Stated from the accepting party's perspective: YOU receive iff the
  // inviter shares, and the inviter receives iff its terms expect output --
  // so a one-sided invitation tells the acceptor plainly whether it gets a
  // result, rather than leaving it to invert the "shares with partner" bit.
  //
  // The two lines are not equally enforced, which is why each takes its
  // own basis: this party's own non-receipt is a hard fact the run holds,
  // while withholding a result from the partner rests on the agreed terms
  // being honored. Presenting them alike would let a cooperative
  // undertaking read as a guarantee.
  //
  // The partner's marker follows the VALUE, not the line, because the
  // basis itself depends on the value: a partner that does receive is one
  // the run itself delivers to (only its USE of the result rests on the
  // agreement), while a partner that does not rests on the agreement for
  // the whole fact.
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
  // The honest-helper membership disclosure, kept apart from the
  // cooperative caveat above: that caveat is about a partner that does not
  // honor the terms, while this holds however honestly the partner
  // behaves -- a fact of its own, taking the opposite basis.
  //
  // Gated on the algorithm: by the role rule the non-receiving party of a
  // count-only run is the SENDER, which computes nothing from the round
  // and is sent no count-report frame (docs/spec/PROTOCOL.md, PSI-C), so
  // it learns no membership of its own records. What a count-only run
  // does disclose is the tier `logDecisionFacts` prints above.
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
  // What a deduplicating match reveals that a one-to-one match does not,
  // beneath the headline it qualifies -- shared wording with the web
  // consent screen. Printed only for a deduplicating invitation, since a
  // one-to-one exchange discloses no grouping. WHICH sentence prints
  // follows the output shape: this party reads it where the inviter
  // shares the result, and reads nothing where the inviter is the sole
  // receiver. The direction note follows at the same level: the setting is
  // the inviting party's own (`deriveAcceptedLinkageTerms` derives this
  // party's side as false), so it scopes to a ONE-SIDED run -- a
  // two-sided grouping takes each party declaring its own side in its own
  // configuration, outside what accepting this invitation produces.
  //
  // Gated on the applied flag too: an invitation whose strategy matches no
  // deduplicating cardinality is refused at acceptance
  // (`assertDeduplicateImplemented`), so a grouping statement here would
  // describe a run that does not happen.
  if (summary.deduplicate && summary.deduplicateApplied) {
    emit(
      `    ${
        summary.inviterSharesResult
          ? DEDUPLICATE_SHARED_RESULT_DISCLOSURE_STATEMENT
          : DEDUPLICATE_SOLE_RECEIVER_DISCLOSURE_STATEMENT
      }`,
    );
    // The sole-receiver statement covers the withholding this client
    // makes; what the rounds still disclose to this party's own process is
    // the separate fact beside it, read from the shared table with its own
    // basis. Printed only in that shape: where the inviter shares the
    // result, this party already sees the grouping directly.
    if (!summary.inviterSharesResult)
      emit(`    ${CONSENT_FACTS.duplicateGroupingDisplayLimit.note}`);
    emit(`    ${DEDUPLICATE_ACCEPTOR_SIDE_NOTE}`);
  }

  // Value-level matching multiplicity, stated beside the record-level line
  // above since the two are easily read as one: a key element that splits
  // its value matches on each candidate, and the removal rule then decides
  // how many pairings result. Rendered only when the terms declare a
  // fan-out -- an invitation holds only the element transforms, never the
  // inviter's own standardization -- and which of the two facts prints
  // follows the strategy, like the partner-receipt pair above.
  if (summary.fansOut) {
    const fact = summary.fanOutApplied ? "fanOutCandidates" : "fanOutRefused";
    emit(`  ${marked("several values per record", fact)}:`);
    emit(`    ${CONSENT_FACTS[fact].note}`);
  }

  // The fields the keys actually match on, one short line ahead of the two
  // long matching blocks, so the single fact consent most depends on stays
  // clear without scrolling back through the keys and their combinations.
  // Each entry is a fixed compact label, so the joined line holds no
  // partner text.
  if (summary.matchedFields.length > 0)
    emit(
      `  ${marked("matched on", "matchedFields")}: ` +
        summary.matchedFields.join(", "),
    );

  // The rules' citation, ahead of the fields and keys it cites, so a
  // reader meets the name -- the inviting party's word, with this build's
  // own verdict beside it -- before the enumeration it stands for. This
  // block takes one caveat per DISTINCT verdict the two halves reached, in
  // descending severity, not one per half: where both halves agree the
  // sentence covers both, and where they differ each half's own marker
  // ties it to its caveat.
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

  // The columns the inviter declares it will transmit for matched records,
  // in the inviter's namespace -- what this party will RECEIVE. Derived
  // from the wire's own disclosure predicate (the token's held
  // `disclosedPayloadColumns`) when the invitation has one, falling back
  // to the authored `payload.send` otherwise. A lazy send -- no held
  // subset and nothing authored -- is omitted, since it reconciles at
  // exchange time; that omission is what leaves a bare "(none)"
  // unambiguous, since only a declared direction reaches the line at all.
  // What the declaration commits its party to is docs/CLI.md's to state.
  //
  // The two sources take different bases, so the marker is selected from
  // which one the summary used: only the held subset is enforced and
  // reconciled against; the authored one is the inviter's own word.
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

  // Nothing prints after this, so the prompt is answered against these
  // facts, not the tail of the key list. Both headings say "repeated"
  // since the block introduces nothing new; only the framing differs --
  // with no prompt following, a heading suggesting a decision follows
  // would be wrong.
  emit(
    promptFollows
      ? REPEATED_FACTS_HEADING_BEFORE_PROMPT
      : REPEATED_FACTS_HEADING_UNATTENDED,
  );
  logDecisionFacts(emit, summary, ownOutboundSend);
}
