import {
  buildOutputTable,
  countIsPartnerReported,
  serializeExchangeRecord,
  serializeVerificationKeys,
} from "@psilink/core";

import type { ExchangeResult, PreparedExchange } from "@psilink/core";
import type { ExchangeOutputs } from "@psi/exchangeLifecycle";

/** The bench run's downloadable artifacts: the lifecycle's outputs widened with
 * the matched-record count the completion header states. It counts the ROWS of a
 * matched result table, so it is meaningful for the `matched` case alone -- a
 * count-only run's intersection size is its own field on its own case, and copying
 * it here would put the same number in two places on one screen. It stays optional
 * because the console's server-job path holds the result on the appliance and never
 * counts its rows. */
export type RunOutputs = ExchangeOutputs & {
  matchedRecordCount?: number;
};

/** The two outcomes that leave a run with no result file to download: the terms
 * withheld the result table, or the run was count-only and produced no table for
 * anyone. Narrowed from {@link RunOutputs} so the inset standing in for the download
 * cannot be handed a `matched` run, which has a file to offer. */
export type NoResultFileOutputs = Extract<
  RunOutputs,
  { kind: "withheld" | "counted" }
>;

/** The object-URL boundary {@link buildRunOutputs} allocates through --
 * `window.URL` in the app, a recording fake in tests. */
export interface ObjectUrls {
  create: (blob: Blob) => string;
  revoke: (url: string) => void;
}

/**
 * The filesystem-safe stamp for a record's download filenames, derived from the
 * record's own `createdAt` (colons and the fractional-second dot replaced with
 * hyphens). This matches the CLI's default record path (`keysPathFor` /
 * `defaultRecordPath` in apps/cli), so the console and in-browser paths produce
 * byte-identical download names for the same `createdAt`; a unit test pins that
 * parity. The web app cannot import apps/cli, so the rule is replicated here as
 * the single source both browser drivers share.
 */
export function recordFileStamp(createdAt: string): string {
  return createdAt.replace(/[:.]/g, "-");
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
    // A count-only (psi-c) run produces no matched pairing at all, so there is no
    // results file to write and nothing was withheld from this party: its whole
    // result is the count, carried through with the provenance its surface needs to
    // state (a sender seat's count is the partner's report). Checked before the
    // withheld case, which a count-only receiver would otherwise fall into and be
    // reported as having received nothing.
    //
    // Otherwise the exchange withholds the result table from a party whose agreed
    // terms give it no output (a one-sided exchange where this party is the
    // PSI sender/helper): produce no results file -- the completion panel
    // shows it contributed but receives no result -- while still offering
    // the record downloads below.
    const generated: RunOutputs =
      result.intersectionCount !== undefined
        ? {
            kind: "counted",
            intersectionCount: result.intersectionCount,
            countReportedByPartner: countIsPartnerReported(result),
          }
        : result.associationTable === undefined
          ? { kind: "withheld" }
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
                kind: "matched" as const,
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
      const stamp = recordFileStamp(result.audit.record.createdAt);
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
