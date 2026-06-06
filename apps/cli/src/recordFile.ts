import path from "node:path";

import {
  getLogger,
  serializeExchangeRecord,
  serializeOpeningData,
} from "@psilink/core";
import type { ExchangeRecord, OpeningData } from "@psilink/core";

import { writeFileOwnerOnly } from "./keyFile";

/** Basename stem for the default record file. */
export const DEFAULT_RECORD_BASENAME = "psilink-record";

/**
 * Default path for the self-attested record: `./psilink-record-<UTC>.json` in
 * the working directory. The timestamp is filesystem-safe (colons and the
 * fractional-second dot replaced with hyphens) and makes each exchange write a
 * distinct file, so repeated exchanges accumulate an audit trail rather than
 * overwriting the previous record.
 */
export function defaultRecordPath(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return `./${DEFAULT_RECORD_BASENAME}-${stamp}.json`;
}

/**
 * Derive the private opening-data path from a record path: the record path with
 * a `.opening.json` suffix in place of a trailing `.json` (or appended when the
 * record path does not end in `.json`). Keeps the two files visibly paired.
 */
export function openingPathFor(recordPath: string): string {
  const dir = path.dirname(recordPath);
  const base = path.basename(recordPath);
  const stem = base.endsWith(".json") ? base.slice(0, -".json".length) : base;
  return path.join(dir, `${stem}.opening.json`);
}

/** Resolved destinations for the record artifacts. */
export interface RecordOutput {
  /** Shareable record (commitments + non-secret summary). */
  recordFilePath: string;
  /** Private opening data (per-commitment salts and committed data). */
  openingFilePath: string;
}

/**
 * Resolve where the record artifacts go from the CLI flags. Returns `undefined`
 * when records are disabled (`--no-record`); otherwise the (possibly default,
 * timestamped) record path and its derived opening path. `--no-record` wins over
 * an explicit `--record-file`.
 */
export function resolveRecordOutput(opts: {
  enabled: boolean;
  recordFile?: string;
  now?: Date;
}): RecordOutput | undefined {
  if (!opts.enabled) return undefined;
  const trimmed = opts.recordFile?.trim();
  const recordFilePath =
    trimmed !== undefined && trimmed.length > 0
      ? trimmed
      : defaultRecordPath(opts.now);
  return { recordFilePath, openingFilePath: openingPathFor(recordFilePath) };
}

/**
 * Write the record (shareable) and its opening data (private) to disk, each
 * atomically and owner-only (temp file + rename, like {@link writeFileOwnerOnly}
 * / `saveKeyFile`), so a mid-write abort leaves each file complete or absent.
 *
 * Non-fatal by design: the privacy-sensitive exchange and the results file have
 * already succeeded by the time this runs, so a record-write failure is logged
 * as a warning rather than thrown -- the user is never told to re-run a
 * successful exchange because an audit artifact could not be saved.
 *
 * The opening data is written first (it is the proof material; if the process
 * dies between the two writes, the salts and committed data are preserved and
 * only the summary record is missing on the next run).
 */
export function writeExchangeRecord(
  output: RecordOutput,
  record: ExchangeRecord,
  opening: OpeningData,
  loggerName: string,
): void {
  const log = getLogger(loggerName);
  try {
    writeFileOwnerOnly(output.openingFilePath, serializeOpeningData(opening));
    writeFileOwnerOnly(output.recordFilePath, serializeExchangeRecord(record));
    log.info(
      "wrote self-attested exchange record (a local audit artifact, NOT a " +
        `signed or non-repudiable receipt) to ${output.recordFilePath}`,
    );
    log.info(
      `wrote private commitment opening data to ${output.openingFilePath}; ` +
        "keep it private -- combined with the record it can reveal the " +
        "matched data",
    );
  } catch (err) {
    log.warn(
      "the exchange and results succeeded but the audit record could not be " +
        `written (${err instanceof Error ? err.message : String(err)}); ` +
        "the results above are unaffected and the exchange need not be re-run",
    );
  }
}
