import {
  assessLinkageSatisfiability,
  disclosedColumnNames,
  getLogger,
  inferMetadata,
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

  // Both enumerations below reach the operator down two routes with different
  // escape points, so each is built with the escape its own route needs: raw for a
  // UsageError, whose display boundary escapes the rendered message once, and
  // escaped for a log.warn, whose call site is the sink. Key names are
  // partner-sourced on the accept path, and f.type is a schema-validated enum
  // literal that takes the same path as f.name, so no future edit leaves a raw
  // token beside an escaped one. The detail is omitted when no DECLARED field is
  // unproducible (the keys are unsatisfiable only by referencing undeclared
  // fields), leaving the block/warn itself as the signal.
  const detail = (shown: (token: string) => string): string =>
    unsatisfied.length > 0
      ? " (unsatisfied fields: " +
        unsatisfied
          .map((f) => `${shown(f.name)} (${shown(f.type)})`)
          .join(", ") +
        ")"
      : "";
  const deadNames = (shown: (token: string) => string): string =>
    deadKeys.map((k) => shown(k.name)).join(", ");

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
    // message carries that half of the cause too.
    if (satisfiableKeyCount === deadKeys.length)
      throw new UsageError(
        `none of the ${messaging.source}'s linkage keys can ever match: a ` +
          "cleaning step drops every record for " +
          deadNames((token) => token) +
          (deadKeys.length < terms.linkageKeys.length
            ? ", and the CSV satisfies no other key" + detail((token) => token)
            : "") +
          "; running would produce a guaranteed empty result. Correct the " +
          "cleaning steps those keys declare, " +
          messaging.blockRemedy,
      );
    log.warn(
      `${deadKeys.length} of the ${messaging.source}'s linkage keys can never ` +
        "match -- a cleaning step drops every record " +
        `(${deadNames((token) => redactAndSanitizeForDisplay(token))}); those ` +
        "keys will contribute nothing to this exchange.",
    );
  }

  // Gate on the key count, not on `unsatisfied.length`: a key can be unsatisfiable
  // because it references a field the terms never declare (not just a declared
  // field the CSV lacks), in which case `unsatisfied` is empty yet keys still
  // collapse. satisfiableKeyCount accounts for both.
  if (satisfiableKeyCount === terms.linkageKeys.length) return;

  if (satisfiableKeyCount === 0)
    throw new UsageError(
      `the CSV cannot satisfy any of the ${messaging.source}'s linkage keys` +
        detail((token) => token) +
        "; running would produce a silent empty result. Provide a CSV that " +
        "covers the required field types, " +
        messaging.blockRemedy,
    );

  log.warn(
    `the CSV cannot satisfy all of the ${messaging.source}'s linkage fields` +
      detail((token) => redactAndSanitizeForDisplay(token)) +
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
