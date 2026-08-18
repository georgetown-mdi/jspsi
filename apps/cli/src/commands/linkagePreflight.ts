import {
  assessLinkageSatisfiability,
  chainDetailCauses,
  disclosedColumnNames,
  getLogger,
  inferMetadata,
  MAX_ERROR_CAUSE_DEPTH,
  redactAndSanitizeForDisplay,
  UsageError,
} from "@psilink/core";
import type { LinkageTerms, Metadata, Standardization } from "@psilink/core";

/**
 * Source-specific wording for {@link checkLinkageSatisfiability}. The accept and
 * exchange entry points share the block/warn policy and the field sanitization
 * but differ in where the terms came from and how an operator fixes a run that
 * can satisfy nothing.
 */
export interface LinkagePreflightMessaging {
  /** Possessive noun naming the terms' origin in the messages: `"invitation"` on
   * the accept path (the partner's adopted terms), `"configuration"` on the
   * exchange path (the committed config). */
  source: string;
  /** Clause closing the block error after "...covers the required field types, ".
   * Accept points at requesting a fresh invitation; exchange at re-establishing
   * the committed exchange. */
  blockRemedy: string;
}

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
 * under, enforcing the policy both real-exchange entry points share: block
 * (throw {@link UsageError}, exit 64) when no linkage key can produce a key
 * string -- whether because no key is satisfiable from the columns or because
 * every satisfiable one declares cleaning that drops all records -- since the
 * exchange would then produce a result byte-indistinguishable from a legitimately
 * empty intersection, and warn-and-proceed when only some keys are lost that way.
 * The detection lives in `@psilink/core`'s {@link assessLinkageSatisfiability};
 * this wrapper owns only the message wording and partner-sourced field
 * sanitization, kept in one copy so the accept and exchange paths cannot drift
 * apart on the threshold or the escaping.
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
  log: ReturnType<typeof getLogger>,
  messaging: LinkagePreflightMessaging,
  standardization?: Standardization,
  metadata?: Metadata,
): void {
  const { unsatisfied, satisfiableKeyCount, deadKeys } =
    assessLinkageSatisfiability(columns, terms, standardization, metadata);

  // Both refusals below partition by WHO CHOSE THE BYTES rather than composing
  // one sentence: the names are terms content -- partner-authored on the accept
  // path -- and the display boundary caps each cause link independently, so names
  // sharing the operative sentence's link can spend its budget and delete the step
  // the operator has to act on. Each name gets a labelled link of its own, raw,
  // since the boundary that renders the chain is the one altitude that escapes it.
  // The remedy is chained ahead of the names for the reason the transport refusals
  // chain theirs first: the renderer's depth bound reaches it before any detail.
  // With no DECLARED field unproducible -- the keys are unsatisfiable only by
  // referencing undeclared fields -- there is no field link at all, leaving the
  // summary and its remedy to stand alone.
  const fieldDetails = unsatisfied.map(
    (field) => `unsatisfied field: ${field.name} (${field.type})`,
  );

  // Keys whose columns are all present but whose declared cleaning can never
  // produce a value (a self-defeating parse_date input format): they pass the
  // column check below yet would contribute nothing. Surfaced separately from the
  // column block/warn -- their remedy is to fix the terms, not the CSV -- and
  // before the all-satisfiable early return, since a dead key still counts as
  // shape-satisfiable.
  if (deadKeys.length > 0) {
    // deadKeys is a subset of the shape-satisfiable keys, so an equal count means
    // every key that passed the column check is dead: the run can emit no key
    // string at all, which is the guaranteed-empty result the column block below
    // exists to prevent, reached by a different route. Refused rather than warned
    // for that reason. Any remaining key is out for the column reason, so the
    // chain carries that half of the cause too.
    if (satisfiableKeyCount === deadKeys.length) {
      const noOtherKeySatisfied = deadKeys.length < terms.linkageKeys.length;
      throw new UsageError(
        `none of the ${messaging.source}'s linkage keys can ever match: a ` +
          "cleaning step drops every record for every key the CSV satisfies" +
          (noOtherKeySatisfied ? ", and the CSV satisfies no other key" : "") +
          "; running would produce a guaranteed empty result.",
        {
          cause: chainDetailCauses([
            `Correct the cleaning steps those keys declare, ${messaging.blockRemedy}`,
            ...fitDetailLinks(
              [
                ...deadKeys.map(
                  (key) => `linkage key that drops every record: ${key.name}`,
                ),
                ...(noOtherKeySatisfied ? fieldDetails : []),
              ],
              "details of the keys that cannot match",
            ),
          ]),
        },
      );
    }
    // The warn route escapes at its own call site, because a log.warn IS the
    // sink: nothing downstream of it escapes again.
    const deadNames = deadKeys
      .map((key) => redactAndSanitizeForDisplay(key.name))
      .join(", ");
    log.warn(
      `${deadKeys.length} of the ${messaging.source}'s linkage keys can never ` +
        `match -- a cleaning step drops every record (${deadNames}); those keys ` +
        "will contribute nothing to this exchange.",
    );
  }

  // Gate on the key count, not on `unsatisfied.length`: a key can be unsatisfiable
  // because it references a field the terms never declare (not just a declared
  // field the CSV lacks), in which case `unsatisfied` is empty yet keys still
  // collapse. satisfiableKeyCount accounts for both.
  if (satisfiableKeyCount === terms.linkageKeys.length) return;

  if (satisfiableKeyCount === 0)
    throw new UsageError(
      `the CSV cannot satisfy any of the ${messaging.source}'s linkage keys; ` +
        "running would produce a silent empty result.",
      {
        cause: chainDetailCauses([
          `Provide a CSV that covers the required field types, ${messaging.blockRemedy}`,
          ...fitDetailLinks(fieldDetails, "unsatisfied fields"),
        ]),
      },
    );

  // This warn route escapes at its own call site for the same reason as the
  // dead-key one above. `type` is a schema-validated enum literal but takes the
  // same path as `name`, so no later edit leaves a raw token beside an escaped
  // one. The enumeration is omitted on the same no-declared-field condition as
  // the blocks above, leaving the warning itself as the signal.
  const detail =
    unsatisfied.length > 0
      ? " (unsatisfied fields: " +
        unsatisfied
          .map(
            (field) =>
              `${redactAndSanitizeForDisplay(field.name)} ` +
              `(${redactAndSanitizeForDisplay(field.type)})`,
          )
          .join(", ") +
        ")"
      : "";
  log.warn(
    `the CSV cannot satisfy all of the ${messaging.source}'s linkage fields` +
      detail +
      "; keys that require those fields will be inactive for this exchange.",
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
 * refuses on both paths, matching the grading {@link checkLinkageSatisfiability}
 * already applies; what the acceptance then does differs by path, so the warning
 * states it (see {@link ACCEPTANCE_OUTCOME}).
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
