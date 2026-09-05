import {
  assessOutboundPayloadConsent,
  outboundPayloadConsentRefusal,
  redactAndSanitizeForDisplay,
  UsageError,
} from "@psilink/core";
import type {
  ExchangeDataSpec,
  Metadata,
  Output,
  OutboundPayloadConsentConfirmationRequired,
  getLogger,
} from "@psilink/core";

import { persistOutboundPayloadConsent } from "./config";
import {
  consentSurfaceSink,
  type ConsentSurfaceSink,
} from "./invitationDisplay";
import { promptConfirm } from "./util/cli";

/**
 * The heading the outbound-consent surface leads with. States only that no
 * credential, terms, or data precede the answer -- not where in the run the
 * question sits, which is the calling command's to place.
 */
const OUTBOUND_CONSENT_HEADING =
  "Nothing is sent until you confirm what this exchange will send:";

/**
 * The label the column list holds, spelled to match the acceptance display's
 * `columns you will send (enforced)` line: an operator confirming here is
 * answering for the same fact that display named, so it is named the same way.
 */
const OUTBOUND_CONSENT_COLUMNS_LABEL = "columns you will send (enforced)";

/**
 * The lead-in for each of the two ways a confirmation comes to be asked for. The
 * unconfirmed one names no particular cause: an acceptance leaves the set
 * unconfirmed both when it was given no input file and when the file it was given
 * could not satisfy the linkage keys.
 */
const OUTBOUND_CONSENT_REASONS = {
  unconfirmed:
    "Accepting the invitation settled what you receive; what you send comes " +
    "from your own input file, and was not settled then.",
  changed:
    "Your input file decides this set, and it is not the set you confirmed for " +
    "this exchange.",
} as const;

/** The label above the columns a changed set adds, and the one above what it drops. */
const OUTBOUND_CONSENT_ADDED_LABEL = "not confirmed before";
const OUTBOUND_CONSENT_REMOVED_LABEL = "confirmed before, no longer sent";

/** The question asked once the set has been shown. */
const OUTBOUND_CONSENT_QUESTION =
  "Send these columns to your partner for matched records?";

/**
 * Render the set this run would transmit, and what changed about it, through
 * `emit`. Every column name is redacted and escaped here, at the composition
 * site, not left to the two sinks {@link consentSurfaceSink} fans out to
 * (`writePromptLine`, which runs no pass, and `log.info`, whose prefixer
 * redacts independently) -- so both destinations render the same bytes.
 * Rationale: docs/spec/CHANNEL_SECURITY.md, "Display sanitization escape
 * format".
 */
function displayOutboundColumns(
  emit: ConsentSurfaceSink,
  verdict: OutboundPayloadConsentConfirmationRequired,
): void {
  emit(OUTBOUND_CONSENT_HEADING);
  emit(`  ${OUTBOUND_CONSENT_REASONS[verdict.reason]}`);
  if (verdict.columns.length === 0)
    emit(`  ${OUTBOUND_CONSENT_COLUMNS_LABEL}: (none) -- only matched records`);
  else {
    emit(`  ${OUTBOUND_CONSENT_COLUMNS_LABEL}:`);
    for (const column of verdict.columns)
      emit(`    - ${redactAndSanitizeForDisplay(column)}`);
  }
  // The two differences are listed separately rather than folded into the set
  // above: an operator re-confirming needs to see what moved, and a column that
  // disappeared cannot be shown in a list of what is sent.
  if (verdict.added.length > 0) {
    emit(`  ${OUTBOUND_CONSENT_ADDED_LABEL}:`);
    for (const column of verdict.added)
      emit(`    - ${redactAndSanitizeForDisplay(column)}`);
  }
  if (verdict.removed.length > 0) {
    emit(`  ${OUTBOUND_CONSENT_REMOVED_LABEL}:`);
    for (const column of verdict.removed)
      emit(`    - ${redactAndSanitizeForDisplay(column)}`);
  }
}

/**
 * Show and confirm the columns this run would send to the partner, before any
 * credential, terms, or data are sent, when the exchange has an
 * outbound-payload consent record its current set does not satisfy. A no-op
 * otherwise -- every non-acceptor, and an acceptor whose resolved set already
 * matches what was confirmed. Record shapes and the safety check this
 * confirmation runs ahead of: docs/spec/EXCHANGE_FILE.md, "Payload-disclosure
 * consent".
 *
 * INTERACTIVE (`stdin` is a terminal): shows the set, asks, and on yes
 * persists the confirmation to `configPath` and updates `spec` in place so
 * `prepareForExchange`'s safety check sees the same answer. A no refuses;
 * nothing is written or sent.
 *
 * NON-INTERACTIVE: refuses with the shared refusal rather than reading
 * end-of-file as a decline nobody made. The interactivity test is strict
 * (`isTTY === true`, matching `openInputSource`): a pipe, redirect, or
 * `/dev/null` reports `isTTY` as `undefined`, never `false`, so the test
 * cannot mistake one for an answerable terminal.
 *
 * The set renders through {@link consentSurfaceSink}; see
 * {@link displayOutboundColumns} for that sink's own constraint.
 *
 * @throws {UsageError} when the confirmation is owed and cannot be given, or
 *   is declined (exit 64).
 */
export async function confirmOutboundPayloadConsent(params: {
  /**
   * The spec this run prepares from. Read for its consent record and UPDATED IN
   * PLACE on a confirmation, so the prepare-time safety check sees the answer.
   */
  spec: ExchangeDataSpec;
  /** The metadata this run resolved -- the source of what it would transmit. */
  metadata: Metadata;
  /** This party's own output declaration, from the terms this run resolved. */
  output: Output;
  /** Where a confirmation is recorded; the config this run loaded. */
  configPath: string;
  /** The operator's `--log-file`, for the surface's routing. */
  logFile: string | undefined;
  log: ReturnType<typeof getLogger>;
}): Promise<void> {
  const { spec, metadata, output, configPath, logFile, log } = params;
  const verdict = assessOutboundPayloadConsent(
    spec.outboundPayloadConsent,
    metadata,
    output,
  );
  if (verdict.status !== "confirmation-required") return;

  const interactive = process.stdin.isTTY === true;
  displayOutboundColumns(
    consentSurfaceSink({ log, logFile, willPrompt: interactive }),
    verdict,
  );
  if (!interactive) throw outboundPayloadConsentRefusal(verdict);

  if (!(await promptConfirm(OUTBOUND_CONSENT_QUESTION)))
    throw new UsageError(
      "the columns this exchange would send were not confirmed, so it did not " +
        "run and nothing was sent. Narrow what your input file discloses -- " +
        "leave the column out of it, or mark it not transmitted in the " +
        "configuration's metadata (is_payload: false, or the ignored role) -- " +
        "and run again.",
    );

  const confirmed = { status: "confirmed" as const, columns: verdict.columns };
  try {
    persistOutboundPayloadConsent(configPath, confirmed);
  } catch (err) {
    // A failed record write is a local configuration fault, not a transport
    // failure: classify it as usage (exit 64) like the sibling config writes,
    // name the path, and keep the cause on the chain. Nothing was sent -- no
    // credential, terms, or data precede this refusal -- and the confirmation is
    // re-asked on the next run rather than assumed.
    throw new UsageError(
      `you confirmed the columns, but the confirmation could not be recorded ` +
        `in ${configPath}, so the exchange did not run and nothing was sent. ` +
        `Fix the file or its permissions and run again; you will be asked to ` +
        `confirm again.`,
      { cause: err },
    );
  }
  spec.outboundPayloadConsent = confirmed;
  log.info(
    `recorded your confirmation in ${configPath}; later runs of this exchange ` +
      "send exactly these columns and ask again if that set changes.",
  );
}
