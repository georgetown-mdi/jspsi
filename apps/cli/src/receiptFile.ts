import {
  getLogger,
  sanitizeErrorForDisplay,
  serializeDualSignedRecord,
} from "@psilink/core";
import type { DualSignedRecord } from "@psilink/core";

import { writeFileOwnerOnly } from "./fileUtils";

// File custody for the dual-signed exchange record (the signed-receipt step's
// output). Mirrors recordFile.ts: a timestamped default path, atomic owner-only
// writes. See docs/spec/EXCHANGE_RECORD.md, Dual-signed record file.

/** Basename stem for the default dual-signed record file. */
export const DEFAULT_RECEIPT_BASENAME = "psilink-receipt";

/**
 * Default path for the dual-signed record: `./psilink-receipt-<stamp>.json` in the
 * working directory, where `<stamp>` is the exchange's `createdAt` timestamp made
 * filesystem-safe (colons and the fractional-second dot replaced with hyphens).
 * The stamp is supplied by the caller (the same value the self-attested record
 * uses) so the receipt and record files for one exchange share a timestamp.
 */
export function defaultReceiptPath(createdAt: string): string {
  const stamp = createdAt.replace(/[:.]/g, "-");
  return `./${DEFAULT_RECEIPT_BASENAME}-${stamp}.json`;
}

/**
 * Where the dual-signed record should go, resolved from the `signing` config
 * before the exchange runs. Holds only the operator's choice -- an explicit
 * `signing.receipt_output` path, or `undefined` for the default timestamped path
 * -- because the default's timestamp is not known until the exchange completes.
 */
export interface ReceiptOutput {
  /** Explicit `signing.receipt_output` path; `undefined` selects the default. */
  receiptFile?: string;
}

/**
 * Resolve the receipt-output choice from the signing config's `receiptOutput`.
 * A trimmed non-empty path is used verbatim; an absent or whitespace-only value
 * selects the default timestamped path.
 */
export function resolveReceiptOutput(receiptOutput?: string): ReceiptOutput {
  const trimmed = receiptOutput?.trim();
  return {
    receiptFile:
      trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined,
  };
}

/**
 * Resolve the concrete receipt path from the output choice and the exchange
 * timestamp. An explicit path is used verbatim; otherwise the default path's
 * timestamp is the exchange's `createdAt`.
 */
export function receiptPathFor(
  output: ReceiptOutput,
  createdAt: string,
): string {
  return output.receiptFile ?? defaultReceiptPath(createdAt);
}

/**
 * Write the dual-signed record to disk atomically and owner-only via
 * {@link writeFileOwnerOnly}, so a mid-write abort leaves it complete or
 * absent. Non-fatal by design, like the self-attested record
 * (`recordFile.ts`): a write failure is logged as a warning and returned as
 * a message, composed RAW for the caller's own event-stream escaping
 * (docs/spec/CLI_EVENTS.md, `warning`).
 */
export function writeDualSignedRecord(
  output: ReceiptOutput,
  record: DualSignedRecord,
  createdAt: string,
  loggerName: string,
): string | undefined {
  const log = getLogger(loggerName);
  const receiptFilePath = receiptPathFor(output, createdAt);
  try {
    writeFileOwnerOnly(receiptFilePath, serializeDualSignedRecord(record));
    log.info(
      "wrote dual-signed exchange record (both parties' signatures and " +
        `certificates over the agreed terms and data commitments) to ` +
        `${receiptFilePath}`,
    );
    return undefined;
  } catch (err) {
    log.warn(
      "the exchange and signature swap succeeded but the dual-signed record " +
        `could not be written (${sanitizeErrorForDisplay(err)}); ` +
        "the results above are unaffected and the exchange need not be re-run",
    );
    return (
      `the dual-signed record could not be written to ${receiptFilePath}; the ` +
      "exchange and its signature swap succeeded and need not be re-run, so " +
      "this exchange has no receipt file"
    );
  }
}
