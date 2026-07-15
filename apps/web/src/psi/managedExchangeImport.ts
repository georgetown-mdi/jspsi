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
 * untouched. The installed record carries a fresh `id` and NO input-file handle: the
 * first run re-acquires one by selection.
 *
 * The import marks the fresh record backed-up as of the import instant: the file
 * just imported from is itself a current backup of the installed secret, so the
 * exchange reads green rather than immediately prompting a re-export.
 */

import { createManagedExchange } from "./managedExchangeStore";
import { importManagedExchangeArtifact } from "./managedExchangeArtifact";
import { markManagedExchangeBackedUp } from "./managedLocalState";

import type { ManagedExchangeRecord } from "./managedExchangeRecord";

/** The platform seams the import drives, injected so the flow is testable. */
export interface ManagedImportDeps {
  /** Install a reconstructed record as a new managed exchange (the one owner). */
  install: (record: ManagedExchangeRecord) => Promise<ManagedExchangeRecord>;
  /** Record a backup marker for the installed record as of `backedUpAt`. */
  markBackedUp: (id: string, backedUpAt: string) => Promise<void>;
  /** The moment of the import; injected so the marker date is the caller's clock. */
  now: () => Date;
}

/** The default seams: install through the store's create, mark through the sibling
 * store, and read the wall clock. */
const defaultDeps: ManagedImportDeps = {
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
  markBackedUp: markManagedExchangeBackedUp,
  now: () => new Date(),
};

/**
 * Import an artifact's bytes as a new managed exchange, installing the one owner.
 * Parses and reconstructs through the artifact module's trust boundary (throwing on a
 * malformed or tampered file before any write), installs the record, and marks it
 * backed-up as of the import instant. Returns the installed record.
 *
 * @throws {UsageError} if the bytes are not parseable JSON or the embedded document
 *   is not parseable YAML.
 * @throws {ZodError} if the artifact or the reconstructed record is invalid.
 */
export async function importManagedExchange(
  source: string,
  deps: ManagedImportDeps = defaultDeps,
): Promise<ManagedExchangeRecord> {
  const reconstructed = importManagedExchangeArtifact(source);
  const installed = await deps.install(reconstructed);
  await deps.markBackedUp(installed.id, deps.now().toISOString());
  return installed;
}
