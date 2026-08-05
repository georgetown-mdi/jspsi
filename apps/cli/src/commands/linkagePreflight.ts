import {
  assessLinkageSatisfiability,
  disclosedColumnNames,
  getLogger,
  sanitizeForDisplay,
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
 * (throw {@link UsageError}, exit 64) when no linkage key is satisfiable -- the
 * exchange would emit no key strings and produce a result byte-indistinguishable
 * from a legitimately empty intersection -- and warn-and-proceed when only some
 * keys are unsatisfiable. The detection lives in `@psilink/core`'s
 * {@link assessLinkageSatisfiability}; this wrapper owns only the message wording
 * and partner-sourced field sanitization, kept in one copy so the accept and
 * exchange paths cannot drift apart on the threshold or the escaping.
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

  // Warn about keys whose columns are all present but whose declared cleaning can
  // never produce a value (a self-defeating parse_date input format): they pass
  // the column check below yet would contribute nothing, running to a silent empty
  // result. Surfaced separately from the column block/warn -- the remedy is to fix
  // the terms, not the CSV -- and before the all-satisfiable early return, since a
  // dead key still counts as shape-satisfiable. Key names are partner-sourced on
  // the accept path, so sanitize each like the unsatisfied-field names below.
  if (deadKeys.length > 0) {
    const names = deadKeys.map((k) => sanitizeForDisplay(k.name)).join(", ");
    log.warn(
      `${deadKeys.length} of the ${messaging.source}'s linkage keys can never ` +
        `match -- a cleaning step drops every record (${names}); those keys ` +
        "will contribute nothing to this exchange.",
    );
  }

  // Gate on the key count, not on `unsatisfied.length`: a key can be unsatisfiable
  // because it references a field the terms never declare (not just a declared
  // field the CSV lacks), in which case `unsatisfied` is empty yet keys still
  // collapse. satisfiableKeyCount accounts for both.
  if (satisfiableKeyCount === terms.linkageKeys.length) return;

  // The enumeration reaches the operator down two routes with different escape
  // points, so each branch below builds it with the escape its own route needs:
  // raw for the UsageError, whose display boundary escapes the rendered message
  // once, and escaped for the log.warn, whose call site is the sink. f.type is a
  // schema-validated enum literal but takes the same path as f.name, so no future
  // edit leaves a raw token beside an escaped one. The detail is omitted when no
  // DECLARED field is unproducible (the keys are unsatisfiable only by
  // referencing undeclared fields), leaving the block/warn itself as the signal.
  const detail = (shown: (token: string) => string): string =>
    unsatisfied.length > 0
      ? " (unsatisfied fields: " +
        unsatisfied
          .map((f) => `${shown(f.name)} (${shown(f.type)})`)
          .join(", ") +
        ")"
      : "";

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
      detail((token) => sanitizeForDisplay(token)) +
      "; keys that require those fields will be inactive for this exchange.",
  );
}

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
 * disclosure when the exchange runs. `metadata` is the set resolved for the
 * configuration this acceptance writes, read through the same
 * {@link disclosedColumnNames} predicate the terms display and `preparePayload`
 * use, so the columns named here are exactly the ones the operator is shown as
 * `columns you will send`.
 *
 * That pair cannot run: `assertPayloadSendDisclosed` refuses it inside
 * `prepareForExchange`, before connecting, so without this the operator meets the
 * refusal only after consenting, writing files, and coordinating with a partner
 * -- while both facts were on the consent surface. It warns rather than refuses,
 * matching the grading {@link checkLinkageSatisfiability} already applies: the
 * remedy is local to the written configuration, so it does not warrant writing no
 * files.
 *
 * A NON-EMPTY declared `send` that disagrees with the disclosed set is a
 * different comparison with different remedies and is not covered here. The
 * column names are this party's own file's and reach a log sink without ever
 * becoming an `Error`, so they are escaped at that sink.
 */
export function warnColumnsTheInvitationWillNotAccept(
  metadata: Metadata | undefined,
  terms: LinkageTerms,
  log: ReturnType<typeof getLogger>,
): void {
  const send = terms.payload?.send;
  if (send === undefined || send.length > 0 || metadata === undefined) return;
  const disclosed = disclosedColumnNames(metadata);
  if (disclosed.length === 0) return;
  const names = disclosed.map((name) => sanitizeForDisplay(name)).join(", ");
  log.warn(
    "the invitation declares that the inviting party will accept no payload " +
      `columns, but your input file discloses columns to send (${names}); the ` +
      "exchange this acceptance configures refuses to run, before connecting, " +
      "while the two disagree. Set the metadata for those columns not to " +
      "transmit (is_payload: false or role ignored), or ask your partner for " +
      "an invitation that accepts them.",
  );
}
