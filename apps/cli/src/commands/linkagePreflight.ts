import {
  assessLinkageSatisfiability,
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

  // f.type is a schema-validated enum literal, but sanitize it like f.name so
  // every partner-sourced token in the message crosses the display boundary. The
  // detail is omitted when no DECLARED field is unproducible (the keys are
  // unsatisfiable only by referencing undeclared fields), leaving the block/warn
  // itself as the signal.
  const detail =
    unsatisfied.length > 0
      ? " (unsatisfied fields: " +
        unsatisfied
          .map(
            (f) =>
              `${sanitizeForDisplay(f.name)} (${sanitizeForDisplay(f.type)})`,
          )
          .join(", ") +
        ")"
      : "";

  if (satisfiableKeyCount === 0)
    throw new UsageError(
      `the CSV cannot satisfy any of the ${messaging.source}'s linkage keys` +
        detail +
        "; running would produce a silent empty result. Provide a CSV that " +
        "covers the required field types, " +
        messaging.blockRemedy,
    );

  log.warn(
    `the CSV cannot satisfy all of the ${messaging.source}'s linkage fields` +
      detail +
      "; keys that require those fields will be inactive for this exchange.",
  );
}
