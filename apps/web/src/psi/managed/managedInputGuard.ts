/**
 * The pure, platform-free half of the managed (recurring) exchange's run-start
 * input guard: deciding whether a read input's columns can back the standing
 * terms, and classifying a rejection into the benign bookkeeping kind that names
 * its remedy -- so both decisions are unit-testable in Node without a file handle,
 * a permission prompt, or a database. The platform half (reading the file through
 * the persisted `FileSystemFileHandle`, the read/query permission layer, and the
 * handle persistence) is in {@link ./managedInputHandle.ts}.
 *
 * Both decisions run BEFORE any connection on every run path -- unattended,
 * one-action, and re-selection -- and each produces a benign pre-run failure,
 * never the desync/attack framing (see docs/MANAGED_EXCHANGE.md, "The
 * input file each run", and docs/spec/MANAGED_EXCHANGE_RECORD.md, the
 * `inputFileHandle` and `lastRun` rows). The column check reuses core's
 * {@link decideLinkageTermsVerdict} rather than re-deriving the verdict, and holds
 * it to core's own rule rather than a threshold of this guard's (see
 * {@link assessManagedInputColumns}).
 */

import { decideLinkageTermsVerdict } from "@psilink/core";

import type { ExchangeSpec, LinkageField } from "@psilink/core";

/**
 * Why the run-start input could not back the standing terms. Both variants are a
 * benign pre-run problem, recorded as their own failure kind
 * ({@link managedInputFailureKind}) and never routed through desync/attack framing:
 *
 * - `"acquire"` -- the file could not be read at run start: the entry is missing
 *   (deleted, moved, or renamed away), the read permission is gone, no handle is
 *   held where one is required, or the file is unreadable or malformed (the CSV
 *   parse fails). The underlying error is included for the caller to display
 *   (sanitized) and log.
 * - `"columns"` -- the file was read, but it cannot satisfy every linkage key the
 *   standing terms declare, so an exchange would match on fewer keys than both
 *   parties agreed to while its record still named every field the terms declare.
 *   The linkage fields the columns cannot produce are included so the caller can
 *   name the missing field types.
 */
export type ManagedInputRejection =
  | {
      /** The input could not be read at run start (missing file, gone permission,
       * an absent required handle, or an unreadable/malformed file the CSV parse
       * rejects). */
      reason: "acquire";
      /** The underlying acquisition error, for the caller to display and log. */
      cause: unknown;
    }
  | {
      /** The input was read but cannot satisfy every linkage key the standing
       * terms declare. */
      reason: "columns";
      /** The standing terms' linkage fields the read columns cannot produce, so
       * the caller can name the missing field types. */
      unsatisfied: Array<LinkageField>;
    };

/**
 * Raised when the run-start input cannot back the standing terms, holding the
 * {@link ManagedInputRejection} that discriminates the benign cause. Distinct from
 * a handshake or data-exchange failure so the runner records the kind
 * {@link managedInputFailureKind} derives from the rejection and knows no
 * connection was ever attempted. Its base `message` is a
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
        : "managed exchange input cannot satisfy the standing linkage terms",
      rejection.reason === "acquire" ? { cause: rejection.cause } : undefined,
    );
    this.name = "ManagedInputError";
    this.rejection = rejection;
  }
}

/**
 * The `lastRun` failure kind a rejection records, and the single place the two
 * benign pre-run input states are told apart. An `"acquire"` rejection is the
 * retryable `"input"` state -- putting the file back clears it -- while a
 * `"columns"` rejection is the `"terms-shortfall"` state: the same file falls the
 * same way short of the same agreed keys however many times it runs, so its remedy
 * is a conforming file or terms re-agreed with the partner, never another attempt.
 *
 * Both the bookkeeping stamp the critical section writes and the live launch's
 * benign-outcome classification read this one function, so a record's tier at the
 * next visit cannot diverge from what the operator saw at the moment of failure.
 */
export function managedInputFailureKind(
  rejection: ManagedInputRejection,
): "input" | "terms-shortfall" {
  return rejection.reason === "columns" ? "terms-shortfall" : "input";
}

/**
 * Grade a read input's `columns` against a record's standing terms, the guard every
 * run path applies before any connection. Reuses core's
 * {@link decideLinkageTermsVerdict} over the persisted document's linkage terms,
 * standardization, and metadata, so the verdict matches an exchange that would run
 * from exactly those terms, never a re-derivation.
 *
 * This guard holds core's own rule rather than a threshold of its own: a run is
 * refused unless the terms declare at least one linkage key and the input can
 * satisfy every one of them. That is the rule `assertLinkageTermsSatisfiable`
 * enforces at the run boundary inside `prepareForExchange`, whose refusal
 * `managedRun.ts` routes to this same benign `"terms-shortfall"` failure tier -- so
 * this is advance notice of the same decision, before any connection, rather than a
 * looser pre-check the boundary can still overturn.
 *
 * Returns `undefined` when the input may run; returns a `"columns"`
 * {@link ManagedInputRejection} holding the unproducible linkage fields otherwise.
 * The grade is over column SHAPE, not row values, with the one value-independent
 * exception core's dead-key detection covers (see
 * {@link decideLinkageTermsVerdict}): it can only over-accept a same-shaped wrong
 * file, never wrongly block a conforming one.
 */
export function assessManagedInputColumns(
  exchangeFile: ExchangeSpec,
  columns: ReadonlyArray<string>,
): ManagedInputRejection | undefined {
  const verdict = decideLinkageTermsVerdict(
    [...columns],
    exchangeFile.linkageTerms,
    exchangeFile.standardization,
    exchangeFile.metadata,
  );
  if (verdict.fullySatisfied) return undefined;
  return { reason: "columns", unsatisfied: verdict.unsatisfiedFields };
}
