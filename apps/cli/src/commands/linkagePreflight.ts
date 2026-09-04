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
import type {
  LinkageTerms,
  LinkageTermsStanding,
  Metadata,
  Standardization,
} from "@psilink/core";

/**
 * Source-specific wording for {@link checkLinkageSatisfiability}. The accept,
 * exchange, and invite entry points share the refusal and the field sanitization
 * but differ in where the terms came from, what proceeding would cost, and how an
 * operator fixes terms their input cannot satisfy.
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
   * verdict selects. Accept and exchange point at renegotiating the terms out
   * of band; invite points at the operator's own authoring, since no partner
   * has seen the terms yet. */
  blockRemedy: string;
  /** Where these terms stand between the two parties: selects the standing
   * core's shortfall fragment states, and whether the keyless refusal's remedy
   * is treated as an agreement or as this operator's own declaration. Accept
   * and exchange hold terms a partner is held to as well; the mint holds none
   * until the invitation it is about to generate is sent. */
  termsStanding: LinkageTermsStanding;
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
 * boundary walks at most {@link MAX_ERROR_CAUSE_DEPTH} links; each block
 * {@link checkLinkageSatisfiability} raises spends two of them before any name
 * (the summary and the chained remedy). A name beyond this budget is not
 * rendered, so the last link reports the overflow instead of naming one more.
 */
const REFUSAL_DETAIL_LINK_BUDGET = MAX_ERROR_CAUSE_DEPTH - 2;

/**
 * Fit an ordered enumeration of labelled detail fragments to
 * {@link REFUSAL_DETAIL_LINK_BUDGET}, replacing the tail the renderer would
 * walk past with one link stating how many entries stand behind it --
 * `MAX_LINKAGE_ENTRIES` bounds the enumeration higher than the renderer walks.
 * `overflowNoun` names what those unread entries are.
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
 * Grading is core's {@link decideLinkageTermsVerdict}, the same verdict
 * `prepareForExchange` enforces at the run boundary -- this is advance notice of
 * a refusal that would fire anyway, before any connection or credential. The
 * offline accept and mint paths call no prepare, so here is the only place the
 * refusal lands for them. `messaging` supplies the accept, exchange, and invite
 * paths' source-specific wording so they cannot drift apart; the shortfall
 * itself is phrased by {@link summarizeLinkageShortfall}.
 *
 * @param standardization The committed config's explicit standardization, when
 *   any: an explicit column remap satisfies a field whose semantic type is
 *   otherwise absent. Omit (accept) to use the type-based approximation a party
 *   infers from its own CSV.
 * @param metadata The committed config's explicit metadata, when any: retypes
 *   columns for the type fallback exactly as the exchange does. Omit (accept) to
 *   use name inference.
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
          // Declaring a key is an agreement on the seats a partner is already
          // held to, and this operator's own edit on the seat that has none.
          (messaging.termsStanding === "agreed"
            ? "Agree linkage terms declaring at least one linkage key, "
            : "Declare at least one linkage key in these terms, ") +
            messaging.blockRemedy,
        ]),
      },
    );

  // Each name gets its own raw cause link: the renderer escapes each link
  // independently, so batching names into one sentence risks one long name
  // spending the whole link's budget. The remedy leads, ahead of the names,
  // since the renderer's depth bound reaches it first. Dead keys precede
  // unsatisfiable keys (only a corrected terms document fixes either), and
  // fields follow, naming only the fields an unsatisfiable key references.
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

  // The remedy lead names the step each shortfall takes: a missing column is
  // fixed in the CSV, a dead key only in the terms, so a refusal covering both
  // names both. `blockRemedy` then closes with what fixes terms this input
  // cannot satisfy at all, which differs by where the terms came from.
  const remedyLeads: string[] = [];
  if (verdict.unsatisfiableKeys.length > 0)
    remedyLeads.push("provide a CSV that covers the required field types");
  if (verdict.deadKeys.length > 0)
    remedyLeads.push("correct the cleaning steps those keys declare");
  const remedy = remedyLeads.join(" and ");

  throw new LinkageTermsUnsatisfiableError(
    `this CSV cannot satisfy every linkage key the ${messaging.source} ` +
      `declares: ${summarizeLinkageShortfall(verdict, messaging.termsStanding)}. ` +
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
 * What happens to the acceptance after the warning, which the two accept paths
 * answer differently: online, `prepareForOnlineExchange` inside `validateAccept`
 * enforces the refusal before the terms display, the prompt, or any write;
 * offline there is no prepare call, so the acceptance runs to its prompt and the
 * refusal waits for `psilink exchange`.
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
 * Warn, on the ACCEPT path, when this party's input discloses payload columns
 * the invitation declares the inviting party will accept none of. Accept-only:
 * its copy names the invitation.
 *
 * `terms` are the acceptor's own derived terms (`deriveAcceptedLinkageTerms`);
 * a present-but-empty `payload.send` mirrors the inviter declaring it accepts
 * no payload column, while an absent one is reconciled against this party's
 * own disclosure when the exchange runs.
 *
 * Gated on `output.shareWithPartner` (mirrored from the invitation's
 * `expectsOutput`): an inviting party entitled to no result receives no
 * payload, so `assertPayloadSendDisclosed` does not refuse that pair and no
 * warning is due. Metadata resolution mirrors `prepareForExchange`'s own
 * (explicit metadata, else inferred from column names), so this warns exactly
 * where the run's own refusal would; `columnNames` absent (an offline
 * acceptance given no input file) leaves nothing to compare, so no warning
 * fires either.
 *
 * The pair this warns on cannot run: `assertPayloadSendDisclosed` refuses it
 * inside `prepareForExchange` before any data is sent. This warns rather than
 * refuses on both paths, since the disagreement is fixed by editing the
 * configuration this acceptance is about to write; {@link ACCEPTANCE_OUTCOME}
 * states what the acceptance then does.
 *
 * Does not cover a NON-EMPTY declared `send` that disagrees with the disclosed
 * set -- a different comparison with different remedies. Column names are
 * escaped per docs/spec/CHANNEL_SECURITY.md#display-sanitization-escape-format,
 * one per line so a name holding the list separator is not treated as two.
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
