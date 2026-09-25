import {
  buildOutputTable,
  countIsPartnerReported,
  resultCsvDelimiter,
  serializeExchangeRecord,
  serializeVerificationKeys,
} from "@alcove/core";

import type {
  BuiltExchangeRecord,
  ExchangeResult,
  PreparedExchange,
} from "@alcove/core";
import type { ExchangeOutputs, RecordDownloads } from "./exchangeLifecycle";
import type { JobExchangeRecordOffer } from "./jobClient/jobExchangeRecord";

/** The console run's downloadable artifacts: the lifecycle's outputs widened with
 * the matched-record count the completion header states. It counts the ROWS of a
 * matched result table, so it is meaningful for the `matched` case alone -- a
 * count-only run's intersection size is its own field on its own case, and copying
 * it here would put the same number in two places on one screen. It stays optional
 * because the server-job path holds the result on the console and never counts
 * its rows. */
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
 * hyphens). Matches the CLI's default record path (`keysPathFor` /
 * `defaultRecordPath` in apps/cli) byte-for-byte; a unit test pins the parity.
 * The web app cannot import apps/cli, so the rule is replicated here as the
 * single source both browser drivers share.
 */
export function recordFileStamp(createdAt: string): string {
  return createdAt.replace(/[:.]/g, "-");
}

/**
 * Build the run's downloadable artifacts from the exchange result: the results
 * CSV (unless the terms withheld it) with its matched-row count, plus the
 * record pair when the audit exists.
 *
 * The results CSV holds this party's own
 * input columns beside the partner's where the prepared exchange selects them
 * (`include_own_columns`), which changes only this file: the exchange sent
 * nothing extra, and nothing here reaches the partner.
 *
 * `csvDelimiter` is the field-delimiter choice this party read its own input
 * under; the table is escaped against the character it resolves to and joined
 * with it -- one delimiter for both, or a value holding it would be quoted
 * against one character and split on another -- so the file reads back the way
 * the input did. A party that named none, or chose detection, writes commas
 * ({@link resultCsvDelimiter}).
 *
 * If anything throws after a URL was
 * created, every already-created URL is revoked before the error propagates:
 * the results blob is matched-record PII, and a stranded object URL would keep
 * it alive until page unload.
 */
export function buildRunOutputs(
  result: ExchangeResult,
  prepared: PreparedExchange,
  urls: ObjectUrls,
  csvDelimiter?: string,
): RunOutputs {
  const writeDelimiter = resultCsvDelimiter(csvDelimiter);
  const created: Array<string> = [];
  const trackedUrl = (blob: Blob): string => {
    const url = urls.create(blob);
    created.push(url);
    return url;
  };
  const jsonUrl = (text: string): string =>
    trackedUrl(new Blob([text], { type: "application/json" }));
  try {
    // A count-only (psi-c) run produces no matched pairing, so there is no results
    // file to write and nothing was withheld: its whole result is the count, paired
    // with the provenance its surface states (a sender seat's count is the
    // partner's report). Checked before the withheld case, or a count-only receiver
    // would report as having received nothing.
    //
    // Otherwise the exchange withholds the result table from a party whose agreed
    // terms give it no output (a one-sided exchange where this party is the PSI
    // sender/helper): the completion panel shows it contributed but received no
    // result, while still offering the record downloads below.
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
                prepared.includeOwnColumns,
                writeDelimiter,
              );
              const csv =
                headers.join(writeDelimiter) +
                "\n" +
                rows.map((r) => r.join(writeDelimiter) + "\n").join("");
              return {
                kind: "matched" as const,
                resultsUrl: trackedUrl(new Blob([csv], { type: "text/csv" })),
                matchedRecordCount: rows.length,
                // How the closure grouped those pairs, carried through from
                // the run rather than recomputed from the table: core hands
                // one to a party that ran the closure over a many-to-many
                // table -- both parties under the cascade, the receiver alone
                // under single-pass -- and none otherwise.
                entityClusters: result.entityClusters,
              };
            })();
    // What the agreed deduplicate pair resolved to, taken from the result
    // rather than re-derived from the two terms documents, so the completion
    // panel states what the run itself matched under.
    generated.matching = result.matching;
    // The record downloads are produced only when the audit pair exists;
    // absent if building the record failed after a successful exchange, in
    // which case they are intentionally omitted without a blocking alert.
    // Filenames are timestamped per exchange (the record's own createdAt,
    // made filesystem-safe) so repeated downloads accumulate rather than
    // collide.
    if (result.audit !== undefined)
      generated.record = recordDownloadsFor(result.audit, jsonUrl);
    return generated;
  } catch (error) {
    for (const url of created) urls.revoke(url);
    throw error;
  }
}

/** The record pair's two downloads, each body created through `jsonUrl`. */
function recordDownloadsFor(
  audit: BuiltExchangeRecord,
  jsonUrl: (text: string) => string,
): RecordDownloads {
  const stamp = recordFileStamp(audit.record.createdAt);
  return {
    recordUrl: jsonUrl(serializeExchangeRecord(audit.record)),
    recordFileName: `alcove-record-${stamp}.json`,
    keysUrl: jsonUrl(serializeVerificationKeys(audit.keys)),
    keysFileName: `alcove-record-${stamp}.keys.json`,
  };
}

/** A record offered for download, in the shape the exchange-record panel
 * renders. */
export type AvailableRecordOffer = Extract<
  JobExchangeRecordOffer,
  { kind: "available" }
>;

/**
 * The exchange-record offer for an in-browser run that failed holding a record
 * (`ExchangeFailure.record`): the same two downloads a completed run's
 * outputs hold, with the outcome and certificate marker read off the record
 * itself, as the console reads them off the record file it holds. The panel
 * that renders it is the one a console run's record takes.
 *
 * A throw after the first URL was created revokes it before propagating, as
 * {@link buildRunOutputs} does: the keys are private material.
 */
export function failedRunRecordOffer(
  audit: BuiltExchangeRecord,
  urls: ObjectUrls,
): AvailableRecordOffer {
  const created: Array<string> = [];
  try {
    const downloads = recordDownloadsFor(audit, (text) => {
      const url = urls.create(new Blob([text], { type: "application/json" }));
      created.push(url);
      return url;
    });
    return {
      kind: "available",
      outcome: audit.record.outcome,
      recordCertificateMismatchObserved:
        audit.record.certificateMismatchObserved,
      downloads,
    };
  } catch (error) {
    for (const url of created) urls.revoke(url);
    throw error;
  }
}
