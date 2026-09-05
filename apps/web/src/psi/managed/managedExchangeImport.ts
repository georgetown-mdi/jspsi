/**
 * The managed-exchange import: a take-over that installs the artifact as the one
 * owner on this device (see docs/MANAGED_EXCHANGE.md, "Eviction recovery is the
 * import flow" and "Export/import is migration, not sync"). Restoring after eviction
 * and migrating to a new device are the same operation: an import re-establishes the
 * one owner wherever it runs.
 *
 * The file is untrusted structured input, so the whole parse-and-reconstruct is the
 * artifact module's trust boundary ({@link importManagedExchangeArtifact}: bounded
 * sensitive parse, strict reader-rejects-unknown schema, the embedded document
 * re-validated as an exchange file, the reconstructed record re-validated through
 * the record schema). Only a fully-validated record reaches the store, so a
 * malformed or tampered file is rejected before any write and the store is left
 * untouched.
 *
 * Import reconciles against a spent husk before installing fresh. When the artifact
 * matches a record spent by the DEVICE MIGRATION -- same `sharedSecret`, the correct
 * match, since a spent-and-unrun-since record's artifact holds exactly its secret
 * (compared in memory, never persisted) -- the import REVIVES that record in place: it
 * updates the record's fields from the artifact, keeps its `id` and any persisted
 * input handle, clears the spent state, and marks it imported-and-backed-up, so
 * re-importing onto the device that handed the exchange off does not leave a permanent
 * duplicate row. Otherwise the import installs a fresh record with a new `id` and NO
 * input-file handle: the first run re-acquires one by selection.
 *
 * A match spent under a HAND-OFF of its own is refused instead
 * ({@link ManagedImportHandedOffError}). The exchange runs from what that hand-off
 * saved -- the command-line export's two files, which this import does not accept --
 * so the artifact, taken before the hand-off, has no copy to bring back: reviving
 * would run a copy the hand-off gave away, and installing fresh would split one secret
 * across a spent husk and a live row beside it. The refusal names the record the store
 * still holds so the surface can say which exchange it is and what recovery it has.
 *
 * Either way the installed or revived record is marked imported and backed-up as of
 * the import instant: the file just imported from is itself a current backup of the
 * installed secret (so the exchange reads green rather than immediately prompting a
 * re-export), and the import marker is the desync tiering's evidence that a restore
 * happened -- a restored copy can hold a secret the partnership has rotated past, so a
 * later handshake failure shows as the benign import/restore tier, not the attack
 * path (see {@link ./managedFailureTiers.ts}).
 */

import {
  createManagedExchange,
  reviveSpentManagedExchange,
} from "./managedExchangeStore";
import { importManagedExchangeArtifact } from "./managedExchangeArtifact";
import { markManagedExchangeImported } from "./managedLocalState";

import type { ManagedExchangeRecord } from "./managedExchangeRecord";
import type { ManagedReviveOutcome } from "./managedExchangeStore";
import type { ManagedSpentHandoff } from "./managedLocalStateShape";

/**
 * Raised when an import is refused because the artifact's secret matches a record
 * this device handed off under {@link handoff}: the exchange runs from what that
 * hand-off saved, so nothing is revived and nothing is installed. Holds the stored
 * record's operator label (which may be empty) so the surface can name the exchange
 * the operator still has here.
 */
export class ManagedImportHandedOffError extends Error {
  /** Which hand-off spent the record the artifact's secret matches. */
  readonly handoff: ManagedSpentHandoff;
  /** The stored record's operator label; empty when the operator named nothing. */
  readonly label: string;

  constructor(handoff: ManagedSpentHandoff, label: string) {
    super(
      `this artifact's managed exchange was handed off (${handoff}), so importing it back is refused`,
    );
    this.name = "ManagedImportHandedOffError";
    this.handoff = handoff;
    this.label = label;
  }
}

/** The platform boundaries the import drives, injected so the flow is testable. */
export interface ManagedImportDeps {
  /** Reconcile the reconstructed artifact against the spent records: revive a
   * migration-spent secret-match in place (keeping its id and input handle, clearing
   * spent, marking imported and backed-up as of the same instant), report the
   * hand-off that refuses the import, or report no match at all. */
  reviveSpent: (
    reconstructed: ManagedExchangeRecord,
    at: string,
  ) => Promise<ManagedReviveOutcome>;
  /** Install a reconstructed record as a new managed exchange (the one owner). */
  install: (record: ManagedExchangeRecord) => Promise<ManagedExchangeRecord>;
  /** Stamp the installed record's import and backup markers as of `at` -- the
   * restore evidence the desync tiering reads, plus the current-backup marker. */
  markImported: (id: string, at: string) => Promise<void>;
  /** The moment of the import; injected so the marker date is the caller's clock. */
  now: () => Date;
}

/** The default boundaries: revive or install through the store, mark through the sibling
 * store, and read the wall clock. */
const defaultDeps: ManagedImportDeps = {
  reviveSpent: reviveSpentManagedExchange,
  install: async (record) =>
    createManagedExchange({
      label: record.label,
      exchangeFile: record.exchangeFile,
      side: record.side,
      sharedSecret: record.sharedSecret,
      ...(record.expires !== undefined ? { expires: record.expires } : {}),
      ...(record.tokenMaxAgeDays !== undefined
        ? { tokenMaxAgeDays: record.tokenMaxAgeDays }
        : {}),
      ...(record.schedule !== undefined ? { schedule: record.schedule } : {}),
      ...(record.lastRun !== undefined ? { lastRun: record.lastRun } : {}),
    }),
  markImported: markManagedExchangeImported,
  now: () => new Date(),
};

/**
 * Import an artifact's bytes as a managed exchange. Parses and reconstructs through
 * the artifact module's trust boundary (throwing on a malformed or tampered file
 * before any write). If the artifact matches a migration-spent record, revives that
 * record in place (already marked imported and backed-up in the same transaction);
 * if it matches a record handed off by a route of its own, refuses; otherwise
 * installs a fresh record and marks it imported and backed-up as of the import
 * instant. Returns the revived or installed record.
 *
 * The import mark on a fresh install is best-effort after the install succeeds: a
 * valid record is already durable, so a failed marker write must not report the
 * import failed (a retry would then duplicate the record). The exchange simply reads
 * "backup needed" and holds no restore evidence until the next export -- the same
 * bookkeeping-after-durable-write discipline the run path follows.
 *
 * @throws {UsageError} if the bytes are not parseable JSON or the embedded document
 *   is not parseable YAML.
 * @throws {ManagedImportHandedOffError} if the artifact's secret matches a record
 *   handed off from this device; nothing is written.
 * @throws {ZodError} if the artifact or the reconstructed record is invalid, or the
 *   install itself fails.
 */
export async function importManagedExchange(
  source: string,
  deps: ManagedImportDeps = defaultDeps,
): Promise<ManagedExchangeRecord> {
  const reconstructed = importManagedExchangeArtifact(source);
  const at = deps.now().toISOString();
  const reconciled = await deps.reviveSpent(reconstructed, at);
  if (reconciled.kind === "revived") return reconciled.record;
  if (reconciled.kind === "handed-off")
    throw new ManagedImportHandedOffError(reconciled.handoff, reconciled.label);
  const installed = await deps.install(reconstructed);
  try {
    await deps.markImported(installed.id, at);
  } catch {
    // Best-effort: the record is durable; a failed marker only shows "backup
    // needed" and holds no restore evidence, and reporting failure here would
    // duplicate on retry.
  }
  return installed;
}
