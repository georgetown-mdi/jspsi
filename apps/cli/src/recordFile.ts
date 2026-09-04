import {
  getLogger,
  sanitizeErrorForDisplay,
  serializeExchangeRecord,
  serializeVerificationKeys,
} from "@psilink/core";
import type { ExchangeRecord, VerificationKeys } from "@psilink/core";

import { writeFileOwnerOnly } from "./fileUtils";

/** Basename stem for the default record file. */
export const DEFAULT_RECORD_BASENAME = "psilink-record";

/**
 * Default path for the self-attested record: `./psilink-record-<stamp>.json` in
 * the working directory, where `<stamp>` is the record's own `createdAt`
 * timestamp made filesystem-safe (colons and the fractional-second dot replaced
 * with hyphens).
 */
export function defaultRecordPath(createdAt: string): string {
  const stamp = createdAt.replace(/[:.]/g, "-");
  return `./${DEFAULT_RECORD_BASENAME}-${stamp}.json`;
}

/**
 * Derive the private verification-keys path from a record path: the record path
 * with a `.keys.json` suffix in place of a trailing `.json` (or appended when the
 * record path does not end in `.json`). Keeps the two files visibly paired.
 *
 * Operates on the suffix directly rather than via `path.join`, which would
 * normalize away a leading `./` and leave the paired record and keys paths
 * with inconsistent prefixes in log messages.
 */
export function keysPathFor(recordPath: string): string {
  return recordPath.endsWith(".json")
    ? `${recordPath.slice(0, -".json".length)}.keys.json`
    : `${recordPath}.keys.json`;
}

/**
 * Where the record artifacts should go, resolved from the CLI flags before the
 * exchange runs. Holds only the user's choice -- an explicit `--record-file`
 * path, or `undefined` for the default timestamped path -- because the default's
 * timestamp is the record's `createdAt`, which is not known until the exchange
 * completes. {@link recordPathsFor} turns this into concrete paths at write time.
 */
export interface RecordOutput {
  /** Explicit `--record-file` path; `undefined` selects the default path. */
  recordFile?: string;
}

/**
 * Resolve the record-output choice from the CLI flags. Returns `undefined` when
 * records are disabled (`--no-record`, which wins over an explicit
 * `--record-file`); otherwise the trimmed explicit path, or a choice with
 * `recordFile` undefined to mean "use the default timestamped path".
 */
export function resolveRecordOutput(opts: {
  enabled: boolean;
  recordFile?: string;
}): RecordOutput | undefined {
  if (!opts.enabled) return undefined;
  const trimmed = opts.recordFile?.trim();
  return {
    recordFile:
      trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined,
  };
}

/** Concrete file destinations for the record and its verification keys. */
export interface RecordPaths {
  /** Shareable record (commitments + non-secret summary). */
  recordFilePath: string;
  /** Private verification keys (per-commitment salts only, no matched data). */
  keysFilePath: string;
}

/**
 * Resolve the concrete record and keys paths from the output choice and the
 * record being written. An explicit `--record-file` is used verbatim; otherwise
 * the default path is derived from the record's `createdAt`. The keys path is
 * always derived from the record path so the two stay visibly paired.
 */
export function recordPathsFor(
  output: RecordOutput,
  createdAt: string,
): RecordPaths {
  const recordFilePath = output.recordFile ?? defaultRecordPath(createdAt);
  return { recordFilePath, keysFilePath: keysPathFor(recordFilePath) };
}

/**
 * Write the record (shareable) and its verification keys (private) to disk,
 * each atomically and owner-only via {@link writeFileOwnerOnly} -- keys
 * first, so a mid-write death leaves the salts recoverable even when the
 * record is not (crash-ordering scope: docs/spec/CREDENTIAL_STORAGE.md).
 * Non-fatal by design: a write failure is logged as a warning and returned
 * as a message, composed RAW for the caller's own event-stream escaping
 * (docs/spec/CLI_EVENTS.md, `warning`), and handles a completed run's
 * record and a terminated one identically (docs/spec/EXCHANGE_RECORD.md,
 * When a record is owed).
 */
export function writeExchangeRecord(
  output: RecordOutput,
  record: ExchangeRecord,
  keys: VerificationKeys,
  loggerName: string,
): string | undefined {
  const log = getLogger(loggerName);
  const { recordFilePath, keysFilePath } = recordPathsFor(
    output,
    record.createdAt,
  );
  // Track the keys write so a partial failure (keys written, record write
  // throws) can tell the user about the orphaned private file below.
  let keysWritten = false;
  // Read off the record's own outcome rather than passed in beside it, so the
  // file and the prose about it can never disagree (docs/spec/EXCHANGE_RECORD.md,
  // When a record is owed).
  const terminated = record.outcome === "receipt-swap-terminated";
  try {
    writeFileOwnerOnly(keysFilePath, serializeVerificationKeys(keys));
    keysWritten = true;
    writeFileOwnerOnly(recordFilePath, serializeExchangeRecord(record));
    // Both writes have now succeeded; log them in write order (keys first,
    // then record). The two messages are emitted together here, not interleaved
    // between the writes -- a failed record write goes to the catch below, which
    // names the orphaned keys file instead.
    log.info(
      `wrote private verification keys to ${keysFilePath}; keep them private -- ` +
        "with the record they can open the commitments, but they hold only " +
        "per-commitment salts (no matched data)",
    );
    log.info(
      "wrote self-attested exchange record (a local audit artifact, NOT a " +
        `signed or non-repudiable receipt) to ${recordFilePath}` +
        (terminated
          ? "; it records a disclosure this run made before the run " +
            "terminated, and states that no receipt accompanies it"
          : ""),
    );
    return undefined;
  } catch (err) {
    log.warn(
      (terminated
        ? "the exchange disclosed before it failed, but the audit record of " +
          "that disclosure could not be written"
        : "the exchange and results succeeded but the audit record could not " +
          "be written") +
        ` (${sanitizeErrorForDisplay(err)}); ` +
        (terminated
          ? "the disclosure still occurred and now has no local record"
          : "the results above are unaffected and the exchange need not be " +
            "re-run"),
    );
    // The keys are written before the record, so a record-write failure leaves
    // the keys file on disk. Name it: though it holds no matched data, it is
    // still private material, so the user should delete it or protect it rather
    // than silently orphan it.
    if (keysWritten) {
      log.warn(
        `the private verification keys were already written to ${keysFilePath} ` +
          "before this failure; they hold only salts (no matched data) but are " +
          "still private -- delete them or keep them private",
      );
    }
    return terminated
      ? `the audit record could not be written to ${recordFilePath}; the ` +
          "exchange disclosed before it failed, so that disclosure has no " +
          "record"
      : `the audit record could not be written to ${recordFilePath}; the ` +
          "exchange and its results succeeded and need not be re-run, so this " +
          "exchange has no record";
  }
}
