/**
 * The pure, platform-free half of the managed (recurring) exchange's run-start
 * input guard: deciding whether a read input's columns can back the standing
 * terms, and classifying an input-acquisition failure into the benign `"input"`
 * bookkeeping -- so both decisions are unit-testable in Node without a file handle,
 * a permission prompt, or a database. The platform half (reading the file through
 * the persisted `FileSystemFileHandle`, the read/query permission layer, and the
 * handle persistence) is in {@link ./managedInputHandle.ts}.
 *
 * Both decisions run BEFORE any connection on every run path -- unattended,
 * one-action, and re-selection -- and each produces a benign `"input"`-kind
 * failure, never the desync/attack framing (see docs/MANAGED_EXCHANGE.md, "The
 * input file each run", and docs/spec/MANAGED_EXCHANGE_RECORD.md, the
 * `inputFileHandle` and `lastRun` rows). The column check reuses core's
 * {@link assessLinkageSatisfiability}, the same column-shape verdict the CLI
 * pre-flight and the web intake surfaces block on, rather than re-deriving it.
 */

import { assessLinkageSatisfiability } from "@psilink/core";

import type { ExchangeSpec, LinkageField } from "@psilink/core";

/**
 * Why the run-start input could not back the standing terms. Both variants are a
 * benign pre-run problem the runner records as an `"input"`-kind failure and never
 * routes through desync/attack framing:
 *
 * - `"acquire"` -- the file could not be read at run start: the entry is missing
 *   (deleted, moved, or renamed away), the read permission is gone, no handle is
 *   held where one is required, or the file is unreadable or malformed (the CSV
 *   parse fails). The underlying error is carried for the caller to surface
 *   (sanitized) and log.
 * - `"columns"` -- the file was read, but its columns cannot satisfy any of the
 *   standing terms' linkage keys, so an exchange would match nothing and yield a
 *   result byte-indistinguishable from a legitimately empty intersection. The
 *   linkage fields the columns cannot produce are carried so the caller can name
 *   the missing field types.
 */
export type ManagedInputRejection =
  | {
      /** The input could not be read at run start (missing file, gone permission,
       * an absent required handle, or an unreadable/malformed file the CSV parse
       * rejects). */
      reason: "acquire";
      /** The underlying acquisition error, for the caller to surface and log. */
      cause: unknown;
    }
  | {
      /** The input was read but its columns satisfy none of the standing terms'
       * linkage keys (`satisfiableKeyCount === 0`). */
      reason: "columns";
      /** The standing terms' linkage fields the read columns cannot produce, so
       * the caller can name the missing field types. */
      unsatisfied: Array<LinkageField>;
    };

/**
 * Raised when the run-start input cannot back the standing terms, carrying the
 * {@link ManagedInputRejection} that discriminates the benign cause. Distinct from
 * a handshake or data-exchange failure so the runner routes it to the `"input"`
 * failure tier and knows no connection was ever attempted. Its base `message` is a
 * fixed, non-sensitive summary suitable for a log line; the partner-influenced
 * detail (the unsatisfied field names) rides {@link rejection} for the caller to
 * sanitize before display.
 */
export class ManagedInputError extends Error {
  /** The discriminated benign cause. */
  readonly rejection: ManagedInputRejection;
  constructor(rejection: ManagedInputRejection) {
    super(
      rejection.reason === "acquire"
        ? "managed exchange input could not be read at run start"
        : "managed exchange input satisfies no standing linkage keys",
      rejection.reason === "acquire" ? { cause: rejection.cause } : undefined,
    );
    this.name = "ManagedInputError";
    this.rejection = rejection;
  }
}

/**
 * Validate a read input's `columns` against a record's standing terms' column
 * shape, the guard every run path applies before any connection. Reuses core's
 * {@link assessLinkageSatisfiability} over the persisted document's linkage terms,
 * standardization, and metadata, so the verdict matches an exchange that would run
 * from exactly those terms -- the same block signal (`satisfiableKeyCount === 0`)
 * the CLI pre-flight and the web intake surfaces use, never a re-derivation.
 *
 * Returns `undefined` when the columns satisfy at least one key (the input is
 * accepted); returns a `"columns"` {@link ManagedInputRejection} carrying the
 * unproducible linkage fields when none can, so the run is rejected as a benign
 * pre-run problem rather than run to a silent empty intersection. The check is over
 * column SHAPE, not row values (see {@link assessLinkageSatisfiability}): it can
 * only over-accept a same-shaped wrong file, never wrongly block a conforming one.
 */
export function assessManagedInputColumns(
  exchangeFile: ExchangeSpec,
  columns: ReadonlyArray<string>,
): ManagedInputRejection | undefined {
  const { satisfiableKeyCount, unsatisfied } = assessLinkageSatisfiability(
    [...columns],
    exchangeFile.linkageTerms,
    exchangeFile.standardization,
    exchangeFile.metadata,
  );
  if (satisfiableKeyCount > 0) return undefined;
  return { reason: "columns", unsatisfied };
}
