import {
  getLogger,
  sanitizeForDisplay,
  summarizeDatasetConstraintViolations,
} from "@psilink/core";
import type { PreparedExchange } from "@psilink/core";

/**
 * Surface the value-level constraint violations a prepared dataset's cleaned
 * values trip, as warn-not-enforce log lines on the CLI's exchange/prepare path.
 *
 * The detection lives in `@psilink/core`'s
 * {@link summarizeDatasetConstraintViolations} -- the SAME per-value check the web
 * workbench renders as badges -- so the two surfaces cannot drift on what counts as
 * a violation; this wrapper owns only the CLI message wording and the field-name
 * sanitization. It reports a COUNT per (field, kind), never the offending values:
 * those are the operator's own data and are never echoed into a log. The field name
 * is sanitized because on the accept path it is adopted verbatim from the partner's
 * invitation (`deriveAcceptedLinkageTerms`), so it is partner-controlled free text.
 *
 * Warn only -- the exchange still proceeds -- matching the LinkageField constraint
 * contract ("the application warns if violated but does not enforce them"). Both the
 * `exchange` and zero-setup prepare paths call this during data preparation.
 */
export function warnOnValueConstraints(
  prepared: PreparedExchange,
  log: ReturnType<typeof getLogger>,
): void {
  for (const summary of summarizeDatasetConstraintViolations(
    prepared.linkageTerms,
    prepared.dataset,
    prepared.rowCount,
  ))
    log.warn(
      `value constraint warning: ${summary.count} cleaned ` +
        `value${summary.count === 1 ? "" : "s"} of linkage field ` +
        `"${sanitizeForDisplay(summary.field)}" flagged "${summary.label}" ` +
        "(warn-not-enforce; the exchange still proceeds).",
    );
}
