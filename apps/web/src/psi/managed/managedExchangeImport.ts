/**
 * The managed-exchange import: one control over two files (see
 * {@link importManagedExchangeFile}), routed by what the file holds rather than
 * by which control the operator used.
 *
 * - The app's own BACKUP artifact is a take-over that installs it as the one
 *   owner on this device (the rest of this header).
 * - A command-line `alcove.yaml` installs a CONFIGURATION-ONLY record: settings
 *   to edit and export again, with no secret and no run here (see
 *   {@link ./managedCommandLineImport.ts}). It reconciles against nothing -- it
 *   brings no secret to match a stored record on -- and stamps no marker: the
 *   import marker is evidence of a restored secret, and the backup marker
 *   attests a file this browser restores a secret from. A file holding neither
 *   is that record's own backup, on the machine that runs it.
 * - A command-line `alcove.yaml` WITH the `.alcove.key` beside it installs a
 *   runnable record ({@link importManagedCommandLinePair}), reconciled against
 *   the store on the backup leg's own rule: the same secret is the same
 *   exchange.
 *
 * What follows is the backup leg: a take-over that installs the artifact as the
 * one owner on this device (see docs/MANAGED_EXCHANGE.md, "Eviction recovery is the
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
 * Import reconciles per exchange before installing fresh, whatever else the store
 * holds (docs/spec/MANAGED_EXCHANGE_RECORD.md, "Reconciling a backup import"). A
 * backup holds one exchange, so the guard is a lookup: a live record holding the
 * artifact's secret refuses ({@link ManagedImportAlreadyHeldError}), and a live
 * record with the artifact's agreed terms and side is named and installed beside
 * only on the operator's word ({@link ManagedImportLiveCopyError}); a restore
 * scoped to one record does not ask, and names such a record after reviving.
 * When the artifact matches a record spent by the DEVICE MIGRATION -- same
 * `sharedSecret`, the correct
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
 * saved -- the command-line export's two files, which the re-take on that
 * record's own surface reads back behind the operator's word that the command
 * line has stopped -- so the artifact, taken before the hand-off, has no copy to
 * bring back: reviving would run a copy the hand-off gave away, and installing
 * fresh would split one secret across a spent husk and a live row beside it. The
 * refusal names the record the store still holds so the surface can say which
 * exchange it is and what recovery it has.
 *
 * A match whose sibling local-state entry this build cannot parse is refused on the
 * same reasoning ({@link ManagedImportCustodyUnreadableError}). The hand-off is recorded
 * in that sibling, so an unreadable one leaves no way to tell a handed-off record
 * from a migration-spent or a live one, and the refusal is the one answer that gives
 * nothing away. It names the exchange but no hand-off route, none having been read.
 *
 * Every import reports which of the source's device-local grants this browser does
 * not hold. The artifact has no field for a File System Access handle, only a marker
 * saying the source had one, so a fresh install holds neither the input file nor the
 * output folder and a scheduled run would otherwise be the first to say so -- a whole
 * window later. A revive keeps the grants the record it revives already had, so
 * what it reports is whatever that record does not hold: nothing when the record
 * still holds both, and the one grant it lost when it lost one.
 *
 * Either way the installed or revived record is marked imported and backed-up as of
 * the import instant: the file just imported from is itself a current backup of the
 * installed secret (so the exchange reads green rather than immediately prompting a
 * re-export), and the import marker is the desync tiering's evidence that a restore
 * happened -- a restored copy can hold a secret the partnership has rotated past, so a
 * later handshake failure shows as the benign import/restore tier, not the attack
 * path (see {@link ./managedFailureTiers.ts}).
 */

import { parseSensitiveYaml } from "@alcove/core";

import {
  MAX_ARTIFACT_IMPORT_BYTES,
  importManagedExchangeArtifact,
} from "./managedExchangeArtifact";
import {
  MAX_CONFIGURATION_IMPORT_BYTES,
  readManagedCommandLineConfiguration,
  readManagedCommandLinePair,
} from "./managedCommandLineImport";
import {
  createManagedExchange,
  reconcileManagedCommandLinePair,
  reviveSpentManagedExchange,
} from "./managedExchangeStore";
import {
  markManagedExchangeImported,
  markManagedExchangeKeyImported,
} from "./managedLocalState";

import type {
  ManagedExchangeRecord,
  RunnableManagedExchangeRecord,
} from "./managedExchangeRecord";
import type {
  ManagedPairReconcileOutcome,
  ManagedReviveOptions,
  ManagedReviveOutcome,
} from "./managedExchangeStore";
import type { ManagedPlatformGrant } from "./managedExchangeArtifact";
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

/**
 * Raised when an import is refused because the artifact's secret matches a record
 * whose sibling local-state entry this build cannot parse: the sibling is where a
 * hand-off is recorded, so whether this device gave the copy away cannot be read,
 * and the import refuses rather than reviving a copy a hand-off may hold or
 * installing a second live one beside it. Nothing is written, and no hand-off route
 * is named, none having been read. Holds the stored record's operator label (empty
 * where that record does not parse either) so the surface can name the exchange.
 */
export class ManagedImportCustodyUnreadableError extends Error {
  /** The stored record's operator label; empty where it could not be read. */
  readonly label: string;

  constructor(label: string) {
    super(
      "this browser's stored state for the artifact's managed exchange could not be read, so importing it back is refused",
    );
    this.name = "ManagedImportCustodyUnreadableError";
    this.label = label;
  }
}

/**
 * Raised when an import is refused because a record this browser runs already
 * holds the file's secret: the same exchange, live here, so nothing is revived
 * and nothing is installed beside it. Holds that record's operator label (which
 * may be empty) so the surface can name it.
 */
export class ManagedImportAlreadyHeldError extends Error {
  /** The stored record's operator label; empty when the operator named nothing. */
  readonly label: string;

  constructor(label: string) {
    super(
      "this file's managed exchange already runs in this browser, so importing it is refused",
    );
    this.name = "ManagedImportAlreadyHeldError";
    this.label = label;
  }
}

/**
 * Raised when a backup import stops to ask: no record holds the artifact's
 * secret, but one or more live ones have its agreed terms and side, so one may
 * be the same exchange run past the backup. Nothing is written. Holds every
 * such record's `id`, which an import the operator confirms passes back in
 * `besideIds`, and its label (which may be empty) so the surface can name it.
 */
export class ManagedImportLiveCopyError extends Error {
  /** The live records the backup may be an older copy of, each with its
   * operator label (empty when the operator named nothing). */
  readonly copies: ReadonlyArray<{ id: string; label: string }>;

  constructor(copies: ReadonlyArray<{ id: string; label: string }>) {
    super(
      "a managed exchange with this backup's terms and side already runs in this browser, so the import waits for confirmation",
    );
    this.name = "ManagedImportLiveCopyError";
    this.copies = copies;
  }
}

/**
 * Raised when a restore scoped to one migration-spent record is given any file
 * but that record's backup: another exchange's backup, one that no longer
 * holds its secret, or a file that is no backup at all. Nothing is written.
 */
export class ManagedImportOtherExchangeError extends Error {
  constructor() {
    super(
      "this file is not the backup of the managed exchange being restored, so nothing is restored",
    );
    this.name = "ManagedImportOtherExchangeError";
  }
}

/** The platform boundaries the import drives, injected so the flow is testable. */
export interface ManagedImportDeps {
  /** Reconcile the reconstructed artifact against the store
   * ({@link reviveSpentManagedExchange}): revive a migration-spent secret-match
   * in place (keeping its id and input handle, clearing spent, marking imported
   * and backed-up as of the same instant), or report the outcome that refuses,
   * asks, or installs fresh. */
  reviveSpent: (
    reconstructed: ManagedExchangeRecord,
    at: string,
    options?: ManagedReviveOptions,
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

/** What an import leaves the operator with: the record, and the grants they have to
 * take again on this browser before an unattended run can use them. */
export interface ManagedImportResult {
  /** The revived or installed record. */
  record: ManagedExchangeRecord;
  /** The grants the source record held that {@link record} does not, in the order
   * they are presented. Empty when there is nothing to take again. */
  missingGrants: Array<ManagedPlatformGrant>;
  /** A listed exchange with the restored record's agreed terms and side, which
   * a scoped restore reports rather than asks about. */
  sameTermsAs?: { id: string; label: string };
}

/** The grants the artifact's source held that the imported record does not, which is
 * what the operator has to take again here. Subtracting what the record holds is what
 * keeps a revive in place quiet: it keeps the handles it already had. */
function grantsMissingHere(
  heldGrants: Array<ManagedPlatformGrant>,
  record: ManagedExchangeRecord,
): Array<ManagedPlatformGrant> {
  const held: Record<ManagedPlatformGrant, boolean> = {
    "input-file": record.inputFileHandle !== undefined,
    "output-folder": record.outputDirectoryHandle !== undefined,
  };
  return heldGrants.filter((grant) => !held[grant]);
}

/**
 * Import an artifact's bytes as a managed exchange. Parses and reconstructs through
 * the artifact module's trust boundary (throwing on a malformed or tampered file
 * before any write), then reconciles it per exchange: revives a migration-spent
 * match in place (already marked imported and backed-up in the same transaction);
 * refuses a match handed off by a route of its own, one whose saved state cannot
 * be read, and a live match; stops to ask where live records have the artifact's
 * agreed terms and side, unless `options.besideIds` names them all; otherwise
 * installs a fresh record and marks it imported and backed-up as of the import
 * instant.
 * Returns the revived or installed record, with the grants it does not hold that
 * its source did.
 *
 * `options.restoreInto` scopes the import to one migration-spent record: any
 * artifact not holding its secret is refused, and no live record is asked
 * about; one with the restored record's agreed terms and side is returned in
 * `sameTermsAs`.
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
 * @throws {ManagedImportCustodyUnreadableError} if the artifact's secret matches a
 *   record whose sibling state could not be read, leaving a hand-off unreadable;
 *   nothing is written.
 * @throws {ManagedImportAlreadyHeldError} if a live record holds the artifact's
 *   secret; nothing is written.
 * @throws {ManagedImportLiveCopyError} if the import is not scoped and a live
 *   record not in `besideIds` has the artifact's agreed terms and side;
 *   nothing is written.
 * @throws {ManagedImportOtherExchangeError} if `restoreInto` is set and the
 *   artifact is not that record's backup; nothing is written.
 * @throws {ZodError} if the artifact or the reconstructed record is invalid, or the
 *   install itself fails.
 */
export async function importManagedExchange(
  source: string,
  deps: ManagedImportDeps = defaultDeps,
  options: ManagedReviveOptions = {},
): Promise<ManagedImportResult> {
  const { record: reconstructed, heldGrants } =
    importManagedExchangeArtifact(source);
  const at = deps.now().toISOString();
  const reconciled = await deps.reviveSpent(reconstructed, at, options);
  if (reconciled.kind === "revived")
    return {
      record: reconciled.record,
      missingGrants: grantsMissingHere(heldGrants, reconciled.record),
      ...(reconciled.sameTermsAs !== undefined
        ? { sameTermsAs: reconciled.sameTermsAs }
        : {}),
    };
  if (reconciled.kind === "handed-off")
    throw new ManagedImportHandedOffError(reconciled.handoff, reconciled.label);
  if (reconciled.kind === "custody-unreadable")
    throw new ManagedImportCustodyUnreadableError(reconciled.label);
  if (reconciled.kind === "held")
    throw new ManagedImportAlreadyHeldError(reconciled.label);
  if (reconciled.kind === "live-copy")
    throw new ManagedImportLiveCopyError(reconciled.copies);
  if (reconciled.kind === "other-exchange")
    throw new ManagedImportOtherExchangeError();
  const installed = await deps.install(reconstructed);
  try {
    await deps.markImported(installed.id, at);
  } catch {
    // Best-effort: the record is durable; a failed marker only shows "backup
    // needed" and holds no restore evidence, and reporting failure here would
    // duplicate on retry.
  }
  return {
    record: installed,
    missingGrants: grantsMissingHere(heldGrants, installed),
  };
}

/** Upper bound, in bytes, on a file this import will read: the picker in
 * `SavedExchanges.tsx` refuses a file above this cap before reading it. The two
 * per-leg constants below name each leg's intended bound; both equal this value
 * today. */
export const MAX_IMPORT_FILE_BYTES = Math.max(
  MAX_ARTIFACT_IMPORT_BYTES,
  MAX_CONFIGURATION_IMPORT_BYTES,
);

/**
 * Which of the two files an import was given, decided on what the bytes hold.
 * The backup artifact is a JSON document tagged with an `artifactVersion`; a
 * command-line configuration is the YAML the CLI loads, which has no such
 * field. The probe reads the bytes through the sensitive-YAML chokepoint (YAML
 * being a superset of the artifact's JSON), and each leg then parses the file
 * again through its own trust boundary, so no leg validates what another
 * decoded.
 *
 * Bytes that parse as neither are the backup leg's: its refusal is the one that
 * tells an operator to check the file they chose, and a file this app never
 * wrote has no version story to tell them.
 */
export function managedImportFileKind(
  source: string,
): "backup" | "command-line-configuration" {
  const probed = probeImportFile(source);
  return probed === "unparseable" ? "backup" : probed;
}

/** What the bytes hold, keeping apart the bytes that parse as neither file:
 * the import control hands those to the backup leg, and the pair import to the
 * configuration's own refusal. */
function probeImportFile(
  source: string,
): "backup" | "command-line-configuration" | "unparseable" {
  let probed: unknown;
  try {
    probed = parseSensitiveYaml(source, "managed exchange import");
  } catch {
    return "unparseable";
  }
  const tagged =
    typeof probed === "object" &&
    probed !== null &&
    "artifactVersion" in probed;
  return tagged ? "backup" : "command-line-configuration";
}

/**
 * Raised when the pair import is given the app's own backup file as its
 * configuration. A backup is imported on its own, so a file tagged as one is
 * refused on that tag and nothing is written.
 */
export class ManagedImportBackupNotConfigurationError extends Error {
  constructor() {
    super(
      "this file is a managed-exchange backup, which the pair import does not take as its configuration",
    );
    this.name = "ManagedImportBackupNotConfigurationError";
  }
}

/**
 * Import a file the operator chose, whichever of the two it is: the app's own
 * backup artifact ({@link importManagedExchange}), or a command-line
 * `alcove.yaml` installed as a configuration-only record
 * ({@link readManagedCommandLineConfiguration}). Nothing is written on a
 * refusal by either leg.
 *
 * A configuration import always installs a fresh record. It holds no secret to
 * reconcile against a stored one, and it installs nothing runnable, so it
 * neither revives a spent record nor stands beside one as a second live copy.
 *
 * @throws {UsageError} if the bytes parse as neither file.
 * @throws {ManagedConfigurationRefusedError} if a configuration fails the
 *   exchange-file schema, or is one this app cannot hold.
 * @throws Every refusal {@link importManagedExchange} raises, on the backup leg;
 *   `options.besideIds` reaches that leg alone.
 * @throws {ZodError} if the backup file fails its schema, or the install does.
 */
export async function importManagedExchangeFile(
  source: string,
  deps: ManagedImportDeps = defaultDeps,
  options: Pick<ManagedReviveOptions, "besideIds"> = {},
): Promise<ManagedImportResult> {
  if (managedImportFileKind(source) === "backup")
    return importManagedExchange(source, deps, options);
  return installConfiguration(source, deps);
}

/**
 * Restore the migration-spent record `id` from its backup: the import
 * {@link importManagedExchange} runs, scoped so that only an artifact holding
 * that record's secret revives it. A configuration file, another exchange's
 * backup, and a backup of this exchange taken after it rotated elsewhere are
 * all refused alike. A listed exchange with the same agreed terms and side is
 * not asked about, the operator having chosen the record; it is returned in
 * `sameTermsAs`.
 *
 * @throws {ManagedImportOtherExchangeError} if the file is not that record's
 *   backup; nothing is written.
 * @throws Every other refusal {@link importManagedExchange} raises, less
 *   {@link ManagedImportLiveCopyError}.
 */
export async function restoreManagedExchangeFromBackup(
  id: string,
  source: string,
  deps: ManagedImportDeps = defaultDeps,
): Promise<ManagedImportResult> {
  if (probeImportFile(source) === "command-line-configuration")
    throw new ManagedImportOtherExchangeError();
  return importManagedExchange(source, deps, { restoreInto: id });
}

/** Read a configuration and install it as a fresh configuration-only record. */
async function installConfiguration(
  source: string,
  deps: Pick<ManagedImportDeps, "install">,
): Promise<ManagedImportResult> {
  const record = await deps.install(
    readManagedCommandLineConfiguration(source),
  );
  return { record, missingGrants: [] };
}

/** The platform boundaries a command-line pair import drives, injected so the
 * flow is testable. */
export interface ManagedPairImportDeps {
  /** Reconcile the pair's record against the store on the backup import's
   * rule ({@link reconcileManagedCommandLinePair}). */
  reconcile: (
    imported: RunnableManagedExchangeRecord,
    at: string,
  ) => Promise<ManagedPairReconcileOutcome>;
  /** Install the pair's record as a new managed exchange. */
  install: (record: ManagedExchangeRecord) => Promise<ManagedExchangeRecord>;
  /** Stamp the installed record's import marker as of `at`, and no backup
   * marker. */
  markImported: (id: string, at: string) => Promise<void>;
  /** The moment of the import. */
  now: () => Date;
}

/** The default boundaries: reconcile and install through the store, mark
 * through the sibling store, and read the wall clock. */
const defaultPairDeps: ManagedPairImportDeps = {
  reconcile: reconcileManagedCommandLinePair,
  install: defaultDeps.install,
  markImported: markManagedExchangeKeyImported,
  now: () => new Date(),
};

/**
 * Import a command-line `alcove.yaml` and the `.alcove.key` beside it as a
 * runnable managed exchange. Both files are read in full before the store is
 * reached ({@link readManagedCommandLinePair}), so a refusal of either writes
 * nothing. The record is then reconciled on the backup import's rule -- a
 * stored record holding the same secret is the same exchange -- and:
 *
 * - a migration-spent match is revived in place, the pair's fields laid over
 *   it and its import marker stamped, in the reconciliation's transaction;
 * - a match handed off from this browser, or whose sibling state cannot be
 *   read, refuses with the backup import's own errors;
 * - a live match refuses ({@link ManagedImportAlreadyHeldError});
 * - otherwise the record installs fresh and its import marker is stamped,
 *   best-effort after the durable install as on the backup leg. No backup
 *   marker is stamped: the pair is not the app's backup file.
 *
 * The secret lands in the record's `sharedSecret` alone, the field every
 * runnable record keeps it in; no refusal here states any byte of the key
 * file.
 *
 * @throws {ManagedImportBackupNotConfigurationError} if the configuration file
 *   is the app's backup; nothing is written.
 * @throws {UsageError} if the configuration is not parseable YAML.
 * @throws {ManagedConfigurationRefusedError} if the configuration is refused.
 * @throws {ManagedKeyFileRefusedError} if the key file is refused.
 * @throws {ManagedImportHandedOffError},
 *   {@link ManagedImportCustodyUnreadableError}, or
 *   {@link ManagedImportAlreadyHeldError} on a refusing match.
 * @throws {ZodError} if the record, the revive, or the install is invalid.
 */
export async function importManagedCommandLinePair(
  configurationSource: string,
  keySource: string,
  deps: ManagedPairImportDeps = defaultPairDeps,
): Promise<ManagedImportResult> {
  if (probeImportFile(configurationSource) === "backup")
    throw new ManagedImportBackupNotConfigurationError();
  const imported = readManagedCommandLinePair(configurationSource, keySource);
  const at = deps.now().toISOString();
  const reconciled = await deps.reconcile(imported, at);
  if (reconciled.kind === "revived")
    return { record: reconciled.record, missingGrants: [] };
  if (reconciled.kind === "handed-off")
    throw new ManagedImportHandedOffError(reconciled.handoff, reconciled.label);
  if (reconciled.kind === "custody-unreadable")
    throw new ManagedImportCustodyUnreadableError(reconciled.label);
  if (reconciled.kind === "held")
    throw new ManagedImportAlreadyHeldError(reconciled.label);
  const installed = await deps.install(imported);
  try {
    await deps.markImported(installed.id, at);
  } catch {
    // Best-effort, as on the backup leg: the record is durable, and reporting
    // failure here would install a duplicate on retry.
  }
  return { record: installed, missingGrants: [] };
}
