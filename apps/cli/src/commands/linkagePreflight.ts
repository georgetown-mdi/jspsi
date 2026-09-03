import {
  chainDetailCauses,
  decideLinkageTermsVerdict,
  disclosedColumnNames,
  getLogger,
  inferMetadata,
  LinkageTermsUnsatisfiableError,
  MAX_ERROR_CAUSE_DEPTH,
  redactAndSanitizeForDisplay,
  summarizeLinkageShortfall,
} from "@psilink/core";
import type { LinkageTerms, Metadata, Standardization } from "@psilink/core";

/**
 * Source-specific wording for {@link checkLinkageSatisfiability}. The accept,
 * exchange, and invite entry points share the refusal and the field sanitization
 * but differ in where the terms came from, what proceeding would cost, and how an
 * operator settles terms their input cannot satisfy.
 */
export interface LinkagePreflightMessaging {
  /** Possessive noun naming the terms' origin in the messages: `"invitation"` on
   * the accept path (the partner's adopted terms), `"configuration"` on the
   * exchange and invite paths (the committed config). */
  source: string;
  /** Sentence closing the block error's own message, stating what proceeding
   * past this shortfall would cost. The accept and exchange paths are about to
   * run, so both take {@link RUN_BLOCK_CONSEQUENCE}; the invite path mints
   * instead, where what a block prevents is disclosing an invitation rather than
   * running a short exchange. */
  blockConsequence: string;
  /** Clause closing the block error's remedy link after the remedy lead the
   * verdict selects ("...covers the required field types, "). Accept points at
   * requesting a fresh invitation and exchange at re-establishing the committed
   * exchange -- the out-of-band renegotiation that is the real remedy for terms
   * an adopted set leaves this input unable to satisfy. Invite points at the
   * operator's own authoring instead: the inviter wrote these terms, and no
   * partner has seen them yet, so there is nothing to renegotiate. */
  blockRemedy: string;
}

/**
 * The consequence a block states on the paths whose next step is the exchange
 * itself. Shared rather than written out at each of them, so the accept and
 * exchange refusals cannot drift into describing the same cost differently.
 */
export const RUN_BLOCK_CONSEQUENCE =
  "Running would exchange fewer keys than the agreed terms declare, while " +
  "the exchange record would still name every field those terms reference.";

/**
 * How many cause links a block's name enumeration may occupy. The display
 * boundary walks at most {@link MAX_ERROR_CAUSE_DEPTH} links of a rendered
 * chain, and each block {@link checkLinkageSatisfiability} raises spends two of
 * them before any name: the summary on the error's own message, and the remedy
 * chained ahead of the names. A name beyond this budget would be walked past and
 * never rendered, so the last of these links reports the overflow instead of
 * naming one more.
 */
const REFUSAL_DETAIL_LINK_BUDGET = MAX_ERROR_CAUSE_DEPTH - 2;

/**
 * Fit an ordered enumeration of labelled detail fragments to
 * {@link REFUSAL_DETAIL_LINK_BUDGET}, replacing the tail the renderer would walk
 * past with one link reporting how many entries stand behind it.
 *
 * The enumerations are terms content and are bounded only at
 * `MAX_LINKAGE_ENTRIES`, so one can ask for more links than the renderer walks.
 * What overflows is counted here rather than left to the renderer's generic
 * elision marker: this is where the count is known, and the count is what tells
 * the operator how much of the mismatch they are not reading. `overflowNoun`
 * names what those unread entries are.
 */
function fitDetailLinks(details: string[], overflowNoun: string): string[] {
  if (details.length <= REFUSAL_DETAIL_LINK_BUDGET) return details;
  const shown = REFUSAL_DETAIL_LINK_BUDGET - 1;
  return [
    ...details.slice(0, shown),
    `and ${details.length - shown} more ${overflowNoun} ` +
      `(${details.length} in total)`,
  ];
}

/**
 * Pre-flight a CSV's `columns` against the linkage `terms` it will be exchanged
 * under: refuse (throw {@link LinkageTermsUnsatisfiableError}, exit 64) unless the
 * terms declare at least one linkage key and this CSV can satisfy every one of
 * them.
 *
 * It holds no policy of its own. The grading is core's
 * {@link decideLinkageTermsVerdict}, the same verdict `prepareForExchange`
 * enforces at the run boundary, so this is advance notice of a refusal that would
 * fire anyway -- earlier, before any connection or credential, and in wording that
 * names where the terms came from. The offline accept path calls no prepare at
 * all, so there this is the only place the refusal lands; the offline mint path
 * calls none either, and there the refusal is what keeps an invitation whose own
 * exchange is refused from reaching a partner at all.
 *
 * This wrapper owns the source-specific wording and the partner-sourced name
 * handling, kept in one copy so the accept, exchange, and invite paths cannot
 * drift apart on the escaping. The shortfall itself is phrased by core's
 * {@link summarizeLinkageShortfall}, the same fragment the run-boundary refusal
 * states.
 *
 * @param standardization The committed config's explicit standardization, when
 *   any: an explicit column remap satisfies a field whose semantic type is
 *   otherwise absent, so passing it keeps a remapped field from being mis-flagged.
 *   Omit (accept) to use the type-based approximation, which matches the default
 *   type-based pipelines a party infers from its own CSV.
 * @param metadata The committed config's explicit metadata, when any: it retypes
 *   columns for the type fallback exactly as the exchange does, so a non-standard
 *   column name the config types explicitly is not mis-flagged, and a config whose
 *   metadata describes a since-swapped CSV is still caught. Omit (accept) to use
 *   name inference.
 */
export function checkLinkageSatisfiability(
  columns: string[],
  terms: LinkageTerms,
  messaging: LinkagePreflightMessaging,
  standardization?: Standardization,
  metadata?: Metadata,
): void {
  const verdict = decideLinkageTermsVerdict(
    columns,
    terms,
    standardization,
    metadata,
  );
  if (verdict.fullySatisfied) return;

  if (verdict.keys.length === 0)
    throw new LinkageTermsUnsatisfiableError(
      `the ${messaging.source}'s linkage terms declare no linkage key, so this ` +
        "exchange has nothing to match on and would produce a result " +
        "indistinguishable from a legitimately empty intersection.",
      {
        cause: chainDetailCauses([
          "Agree linkage terms declaring at least one linkage key, " +
            messaging.blockRemedy,
        ]),
      },
    );

  // The refusal partitions by WHO CHOSE THE BYTES rather than composing one
  // sentence: the names are terms content -- partner-authored on the accept path
  // -- and the display boundary caps each cause link independently, so names
  // sharing the operative sentence's link can spend its budget and delete the step
  // the operator has to act on. Each name gets a labelled link of its own, raw,
  // since the boundary that renders the chain is the one altitude that escapes it.
  // The remedy is chained ahead of the names for the reason the transport refusals
  // chain theirs first: the renderer's depth bound reaches it before any detail.
  //
  // Ordered by what the verdict blocks on: the failing keys are the refusal, so
  // they lead and survive the truncation `fitDetailLinks` applies -- a terms
  // document declaring more entries than the renderer walks would otherwise spend
  // the whole budget on fields and name not one of the keys they cost. The dead
  // keys precede the unsatisfiable ones because only a corrected terms document
  // settles them, and the fields follow as the account of WHY the unsatisfiable
  // keys failed.
  //
  // Only the fields an unsatisfiable key REFERENCES are named. `unsatisfiedFields`
  // grades every declared field, and a terms document may declare one no key
  // draws on: that field costs no agreed key, so the run boundary does not block
  // on it and naming it here would put a gap the operator need not close ahead of
  // the ones they must. A dead key contributes none of these -- the dead grade is
  // scoped to keys whose every element field resolves.
  const blockingFieldNames = new Set(
    verdict.unsatisfiableKeys.flatMap((key) =>
      key.elements.map((element) => element.field),
    ),
  );
  const details = [
    ...verdict.deadKeys.map(
      (key) => `linkage key that drops every record: ${key.name}`,
    ),
    ...verdict.unsatisfiableKeys.map(
      (key) => `linkage key the CSV cannot produce: ${key.name}`,
    ),
    ...verdict.unsatisfiedFields
      .filter((field) => blockingFieldNames.has(field.name))
      .map((field) => `unsatisfied field: ${field.name} (${field.type})`),
  ];

  // The remedy lead names the step each shortfall actually takes: a missing column
  // is fixed in the CSV, a dead key only in the terms, so a refusal carrying both
  // names both. `blockRemedy` then closes with what settles terms this input
  // cannot satisfy at all, which differs by where the terms came from.
  const remedyLeads: string[] = [];
  if (verdict.unsatisfiableKeys.length > 0)
    remedyLeads.push("provide a CSV that covers the required field types");
  if (verdict.deadKeys.length > 0)
    remedyLeads.push("correct the cleaning steps those keys declare");
  const remedy = remedyLeads.join(" and ");

  throw new LinkageTermsUnsatisfiableError(
    `this CSV cannot satisfy every linkage key the ${messaging.source} ` +
      `declares: ${summarizeLinkageShortfall(verdict)}. ` +
      messaging.blockConsequence,
    {
      cause: chainDetailCauses([
        `${remedy.charAt(0).toUpperCase()}${remedy.slice(1)}, ${messaging.blockRemedy}`,
        ...fitDetailLinks(
          details,
          "details of the terms this CSV cannot satisfy",
        ),
      ]),
    },
  );
}

/** Which `psilink accept` path is running, selecting the outcome stated. */
export type AcceptMode = "online" | "offline";

/**
 * What happens to the acceptance itself after the warning, which the two accept
 * paths answer differently.
 *
 * Online, `prepareForOnlineExchange` runs inside `validateAccept` -- the same
 * `prepareForExchange` that carries the refusal -- so the `UsageError` aborts the
 * command before the terms display, the prompt, and every write. Offline there is
 * no prepare call, so the acceptance runs to its prompt and the refusal waits for
 * `psilink exchange`.
 */
const ACCEPTANCE_OUTCOME: Record<AcceptMode, string> = {
  online:
    "This acceptance cannot finish: it stops next as a configuration error " +
    "(exit 64), before the terms are displayed and without writing a " +
    "configuration or key file.",
  offline:
    "This acceptance is not stopped by it: confirming writes the configuration " +
    "and key file, and the refusal arrives when you run 'psilink exchange'.",
};

/**
 * Warn, on the ACCEPT path, when this party's input discloses payload columns the
 * invitation declares the inviting party will accept none of. Accept-only: its
 * copy names the invitation, so an exchange-path caller would have to
 * parameterize the source the way {@link LinkagePreflightMessaging} does.
 *
 * `terms` are the acceptor's own derived terms, whose `payload.send` is the
 * MIRROR of the inviter's `payload.receive` (`deriveAcceptedLinkageTerms`): a
 * present-but-empty `send` is the inviter declaring it accepts no payload column,
 * while an ABSENT one is the lazy direction, reconciled against this party's own
 * disclosure when the exchange runs.
 *
 * Gated on the acceptor's own `output.shareWithPartner` -- mirrored from the
 * invitation's `expectsOutput`, the same fact the consent display's `columns you
 * will send` line reads. An inviting party entitled to no result receives no
 * payload at all, so `assertPayloadSendDisclosed` does not refuse that pair and
 * the display states that nothing is sent; warning there would contradict the
 * line beneath it.
 *
 * The disclosed set is read the way the RUN resolves it (`prepareForExchange`
 * takes the spec's metadata, else infers from the column names), so a caller that
 * holds an input's columns but no metadata for them still gets the warning the
 * run's own refusal will match. `columnNames` absent (an offline acceptance given
 * no input file) leaves nothing to compare: the disclosed set is settled by
 * whatever CSV `psilink exchange` is later given, which is what the display's
 * not-yet-known line already says.
 *
 * That pair cannot run: `assertPayloadSendDisclosed` refuses it inside
 * `prepareForExchange`, before any data is sent, so without this the operator
 * meets the refusal only after consenting, writing files, and coordinating with
 * a partner -- while both facts were on the consent surface. It warns rather than
 * refuses on both paths, because the disagreement is settled by editing the
 * configuration this acceptance is about to write; what the acceptance then does
 * differs by path, so the warning states it (see {@link ACCEPTANCE_OUTCOME}).
 *
 * A NON-EMPTY declared `send` that disagrees with the disclosed set is a
 * different comparison with different remedies and is not covered here. The
 * column names are this party's own file's and reach a log sink without ever
 * becoming an `Error`, so they are escaped at that sink, and are rendered one per
 * line so a name carrying the list separator cannot read as two.
 */
export function warnColumnsTheInvitationWillNotAccept(params: {
  metadata: Metadata | undefined;
  columnNames: string[] | undefined;
  terms: LinkageTerms;
  mode: AcceptMode;
  log: ReturnType<typeof getLogger>;
}): void {
  const { metadata, columnNames, terms, mode, log } = params;
  const send = terms.payload?.send;
  if (send === undefined || send.length > 0) return;
  if (!terms.output.shareWithPartner) return;
  const resolved =
    metadata ??
    (columnNames !== undefined ? inferMetadata(columnNames) : undefined);
  if (resolved === undefined) return;
  const disclosed = disclosedColumnNames(resolved);
  if (disclosed.length === 0) return;
  log.warn(
    "the invitation declares that the inviting party will accept no payload " +
      "columns, but your input file discloses columns to send:\n" +
      disclosed
        .map((name) => `  - ${redactAndSanitizeForDisplay(name)}`)
        .join("\n") +
      "\nThe exchange this acceptance configures refuses to run, before any " +
      `data is sent, while the two disagree. ${ACCEPTANCE_OUTCOME[mode]} Set the ` +
      "metadata for those columns not to transmit (is_payload: false or role " +
      "ignored), or ask your partner for an invitation that accepts them.",
  );
}
