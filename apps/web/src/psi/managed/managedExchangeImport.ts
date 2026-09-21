/**
 * The managed-exchange import: one control over two files (see
 * {@link importManagedExchangeFile}), routed by what the file holds rather than
 * by which control the operator used.
 *
 * - The app's own BACKUP artifact is a take-over that installs it as the one
 *   owner on this device (the rest of this header).
 * - A command-line `psilink.yaml` installs a CONFIGURATION-ONLY record: settings
 *   to edit and export again, with no secret and no run here (see
 *   {@link ./managedCommandLineImport.ts}). It reconciles against nothing -- it
 *   brings no secret to match a stored record on -- and stamps no marker: the
 *   import marker is evidence of a restored secret, and the backup marker
 *   attests a file this browser restores a secret from. A file holding neither
 *   is that record's own backup, on the machine that runs it.
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
 * saved -- the command-line export's two files, whose `psilink.yaml` this import
 * reads back as a configuration only and whose key file it does not read at all --
 * so the artifact, taken before the hand-off, has no copy to bring back: reviving
 * would run a copy the hand-off gave away, and installing fresh would split one secret
 * across a spent husk and a live row beside it. The refusal names the record the store
 * still holds so the surface can say which exchange it is and what recovery it has.
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

import { parseSensitiveYaml } from "@psilink/core";

import {
  MAX_ARTIFACT_IMPORT_BYTES,
  importManagedExchangeArtifact,
} from "./managedExchangeArtifact";
import {
  MAX_CONFIGURATION_IMPORT_BYTES,
  readManagedCommandLineConfiguration,
} from "./managedCommandLineImport";
import {
  createManagedExchange,
  reviveSpentManagedExchange,
} from "./managedExchangeStore";
import { markManagedExchangeImported } from "./managedLocalState";

import type { ManagedExchangeRecord } from "./managedExchangeRecord";
import type { ManagedPlatformGrant } from "./managedExchangeArtifact";
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

/** The platform boundaries the import drives, injected so the flow is testable. */
export interface ManagedImportDeps {
  /** Reconcile the reconstructed artifact against the spent records: revive a
   * migration-spent secret-match in place (keeping its id and input handle, clearing
   * spent, marking imported and backed-up as of the same instant), report the
   * hand-off that refuses the import, report a sibling state it could not read
   * (which refuses on its own terms), or report no match at all. */
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

/** What an import leaves the operator with: the record, and the grants they have to
 * take again on this browser before an unattended run can use them. */
export interface ManagedImportResult {
  /** The revived or installed record. */
  record: ManagedExchangeRecord;
  /** The grants the source record held that {@link record} does not, in the order
   * they are presented. Empty when there is nothing to take again. */
  missingGrants: Array<ManagedPlatformGrant>;
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
 * before any write). If the artifact matches a migration-spent record, revives that
 * record in place (already marked imported and backed-up in the same transaction);
 * if it matches a record handed off by a route of its own, refuses; otherwise
 * installs a fresh record and marks it imported and backed-up as of the import
 * instant. Returns the revived or installed record, with the grants it does not
 * hold that its source did.
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
 * @throws {ZodError} if the artifact or the reconstructed record is invalid, or the
 *   install itself fails.
 */
export async function importManagedExchange(
  source: string,
  deps: ManagedImportDeps = defaultDeps,
): Promise<ManagedImportResult> {
  const { record: reconstructed, heldGrants } =
    importManagedExchangeArtifact(source);
  const at = deps.now().toISOString();
  const reconciled = await deps.reviveSpent(reconstructed, at);
  if (reconciled.kind === "revived")
    return {
      record: reconciled.record,
      missingGrants: grantsMissingHere(heldGrants, reconciled.record),
    };
  if (reconciled.kind === "handed-off")
    throw new ManagedImportHandedOffError(reconciled.handoff, reconciled.label);
  if (reconciled.kind === "custody-unreadable")
    throw new ManagedImportCustodyUnreadableError(reconciled.label);
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

/** Upper bound, in bytes, on a file this import will read, applied before either
 * leg's bounded parse. One control reads either file, so it caps at the larger
 * of the two legs' own caps and each leg keeps its own bound behind it. */
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
  let probed: unknown;
  try {
    probed = parseSensitiveYaml(source, "managed exchange import");
  } catch {
    return "backup";
  }
  const tagged =
    typeof probed === "object" &&
    probed !== null &&
    "artifactVersion" in probed;
  return tagged ? "backup" : "command-line-configuration";
}

/**
 * Import a file the operator chose, whichever of the two it is: the app's own
 * backup artifact ({@link importManagedExchange}), or a command-line
 * `psilink.yaml` installed as a configuration-only record
 * ({@link readManagedCommandLineConfiguration}). Nothing is written on a
 * refusal by either leg.
 *
 * A configuration import always installs a fresh record. It holds no secret to
 * reconcile against a stored one, and it installs nothing runnable, so it
 * neither revives a spent record nor stands beside one as a second live copy.
 *
 * @throws {UsageError} if the bytes parse as neither file.
 * @throws {ManagedConfigurationRefusedError} if a configuration is one this app
 *   cannot hold.
 * @throws {ManagedImportHandedOffError} or
 *   {@link ManagedImportCustodyUnreadableError} on the backup leg's refusals.
 * @throws {ZodError} if either file fails its schema, or the install does.
 */
export async function importManagedExchangeFile(
  source: string,
  deps: ManagedImportDeps = defaultDeps,
): Promise<ManagedImportResult> {
  if (managedImportFileKind(source) === "backup")
    return importManagedExchange(source, deps);
  const record = await deps.install(
    readManagedCommandLineConfiguration(source),
  );
  return { record, missingGrants: [] };
}
