import {
  buildOutputTable,
  serializeExchangeRecord,
  serializeVerificationKeys,
} from "@psilink/core";

import type { ExchangeResult, PreparedExchange } from "@psilink/core";
import type { ExchangeOutputs } from "@psi/exchangeLifecycle";

/** The bench run's downloadable artifacts: the lifecycle's outputs widened
 * with the matched-row count the completion header states. Present exactly
 * when the result table is (a withheld result has no count to state). */
export type RunOutputs = ExchangeOutputs & {
  matchedRecordCount?: number;
};

/** The object-URL boundary {@link buildRunOutputs} allocates through --
 * `window.URL` in the app, a recording fake in tests. */
export interface ObjectUrls {
  create: (blob: Blob) => string;
  revoke: (url: string) => void;
}

/**
 * Build the run's downloadable artifacts from the exchange result: the results
 * CSV (unless the terms withheld it) with its matched-row count, plus the
 * record pair when the audit exists. If anything throws after a URL was
 * created, every already-created URL is revoked before the error propagates:
 * the results blob is matched-record PII, and a stranded object URL would keep
 * it alive until page unload.
 */
export function buildRunOutputs(
  result: ExchangeResult,
  prepared: PreparedExchange,
  urls: ObjectUrls,
): RunOutputs {
  const created: Array<string> = [];
  const trackedUrl = (blob: Blob): string => {
    const url = urls.create(blob);
    created.push(url);
    return url;
  };
  const jsonUrl = (text: string): string =>
    trackedUrl(new Blob([text], { type: "application/json" }));
  try {
    // The exchange withholds the result table from a party whose agreed
    // terms give it no output (a one-sided exchange where this party is the
    // PSI sender/helper): produce no results file -- the completion panel
    // shows it contributed but receives no result -- while still offering
    // the record downloads below.
    const generated: RunOutputs =
      result.associationTable === undefined
        ? { resultWithheld: true }
        : (() => {
            const { headers, rows } = buildOutputTable(
              result.associationTable,
              prepared.rawRows,
              prepared.metadata,
              result.partnerPayload,
            );
            const csv =
              headers.join(",") +
              "\n" +
              rows.map((r) => r.join(",") + "\n").join("");
            return {
              resultsUrl: trackedUrl(new Blob([csv], { type: "text/csv" })),
              matchedRecordCount: rows.length,
            };
          })();
    // The record downloads are produced only when the audit pair exists;
    // absent if building the record failed after a successful exchange, in
    // which case they are intentionally omitted without a blocking alert.
    // Filenames are timestamped per exchange (the record's own createdAt,
    // made filesystem-safe) so repeated downloads accumulate rather than
    // collide.
    if (result.audit !== undefined) {
      const stamp = result.audit.record.createdAt.replace(/[:.]/g, "-");
      generated.record = {
        recordUrl: jsonUrl(serializeExchangeRecord(result.audit.record)),
        recordFileName: `psilink-record-${stamp}.json`,
        keysUrl: jsonUrl(serializeVerificationKeys(result.audit.keys)),
        keysFileName: `psilink-record-${stamp}.keys.json`,
      };
    }
    return generated;
  } catch (error) {
    for (const url of created) urls.revoke(url);
    throw error;
  }
}
