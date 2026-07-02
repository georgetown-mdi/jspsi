import {
  getLogger,
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
 * with hyphens). Deriving the stamp from `createdAt` -- rather than a fresh clock
 * read taken before the exchange finished -- makes the filename match the
 * timestamp recorded inside the file, and still gives each exchange a distinct
 * file so repeated exchanges accumulate an audit trail rather than overwriting.
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
 * the default path's timestamp is the record's `createdAt`, so the filename
 * reflects when the record was produced rather than a clock read from before the
 * exchange completed. The keys path is always derived from the record path so
 * the two stay visibly paired.
 */
export function recordPathsFor(
  output: RecordOutput,
  createdAt: string,
): RecordPaths {
  const recordFilePath = output.recordFile ?? defaultRecordPath(createdAt);
  return { recordFilePath, keysFilePath: keysPathFor(recordFilePath) };
}

/**
 * Write the record (shareable) and its verification keys (private) to disk, each
 * atomically and owner-only (temp file + rename, like {@link writeFileOwnerOnly}
 * / `saveKeyFile`), so a mid-write abort leaves each file complete or absent.
 *
 * Both files are owner-only (0600) by design. Neither holds the matched data: the
 * record holds commitments and a non-secret summary, and the verification keys
 * hold only per-commitment salts (the matched data lives solely in the results
 * file). "Shareable" means the record may be handed to an auditor -- not that it
 * is world-readable on disk; it still discloses, in cleartext, that an exchange
 * occurred, with whom, under which agreement, over what categories of data, and
 * its size, so the conservative default keeps it private to the owner. The keys
 * are not shareable at all: a salt plus the record's commitment can open (and
 * brute-force a low-entropy) committed value, so they stay private.
 *
 * Non-fatal by design: the privacy-sensitive exchange and the results file have
 * already succeeded by the time this runs, so a record-write failure is logged
 * as a warning rather than thrown -- the user is never told to re-run a
 * successful exchange because an audit artifact could not be saved.
 *
 * The verification keys are written first (they are the material verification
 * needs; if the process dies between the two writes, the salts are preserved and
 * only the summary record is missing on the next run). On Linux this ordering
 * survives a power loss, not just a process death: {@link writeFileOwnerOnly}
 * fsyncs each file's data and its parent directory entry before returning, so a
 * durable record rename implies a durable keys rename. On macOS Node's
 * `fsync` does not force the drive's write cache to media, so there the ordering
 * holds against process death but not necessarily a power loss (recoverable by
 * re-running); on Windows the directory flush is unreachable from Node's fs. See
 * `writeFileOwnerOnly` and SECURITY_DESIGN.md.
 */
export function writeExchangeRecord(
  output: RecordOutput,
  record: ExchangeRecord,
  keys: VerificationKeys,
  loggerName: string,
): void {
  const log = getLogger(loggerName);
  // Resolve the concrete paths now: the default path's timestamp is the record's
  // own createdAt, so the filename matches the timestamp inside the file.
  const { recordFilePath, keysFilePath } = recordPathsFor(
    output,
    record.createdAt,
  );
  // Track the keys write so a partial failure (keys written, record write
  // throws) can tell the user about the orphaned private file below.
  let keysWritten = false;
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
        `signed or non-repudiable receipt) to ${recordFilePath}`,
    );
  } catch (err) {
    log.warn(
      "the exchange and results succeeded but the audit record could not be " +
        `written (${err instanceof Error ? err.message : String(err)}); ` +
        "the results above are unaffected and the exchange need not be re-run",
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
  }
}
