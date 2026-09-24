/**
 * What the import affordance says when it will not take a backup file (see
 * docs/MANAGED_EXCHANGE.md, "Eviction recovery is the import flow"). The refusal
 * an already-handed-off exchange meets is not one of these -- that file is fine
 * and the exchange is still here, so it says so itself
 * ({@link ./managedHandoffGate.ts}).
 *
 * A command-line configuration this app will not take is the one refusal that
 * states its own reason: the file is in front of the operator, who wrote it by
 * hand, and what stops it is a line in it -- a field off the exchange-file
 * schema, a channel this app does not run, a credential it will not store, a
 * missing role -- so the refusal names the lines and what to do about them
 * ({@link ManagedConfigurationRefusedError}).
 *
 * Three things stop a file that says nothing of its own, and they call for
 * different actions. Bytes that are not
 * a parseable document at all -- along with a file over the import cap, which is
 * refused before it is read -- leave only the file itself to check. A document
 * that parses and then fails the artifact's strict
 * reader-rejects-unknown schema has a cause the operator cannot see from the file:
 * an export written by a newer build holds keys, or an artifact version, that this
 * build's schema refuses whole (see docs/spec/MANAGED_EXCHANGE_RECORD.md, "Export
 * artifact"). That case names the version difference and both ways out of it --
 * bring this page up to date, or write the file from a build that matches -- before
 * the wrong-file and modified-file checks, which are what is left when the two
 * builds already agree. A file written in the previous artifact format is the
 * opposite direction and has neither remedy: no build reads it again, so it is
 * named as what it is and the operator is pointed at a fresh exchange.
 *
 * The refusals that name an exchange this browser already runs -- the same
 * secret, or the same agreed terms and side -- are here too, since they say what
 * to do with the listed exchange rather than with the file.
 */

import { ZodError } from "zod";

import { sanitizeErrorForDisplay } from "@alcove/core";

import {
  ManagedConfigurationRefusedError,
  ManagedKeyFileRefusedError,
} from "@psi/managed/managedCommandLineImport";
import { ManagedArtifactOutdatedError } from "@psi/managed/managedExchangeArtifact";
import { ManagedImportBackupNotConfigurationError } from "@psi/managed/managedExchangeImport";

/** The heading every import refusal here is shown under. */
export const IMPORT_FAILURE_TITLE = "That file could not be imported";

/** The file's bytes are not a document this app can parse, or it is over the
 * import cap and was refused before any parse. Nothing was placed, so what is left
 * to check is which file was chosen and whether it still holds what was exported. */
export const UNREADABLE_IMPORT_REASON =
  "The backup file could not be read. Check that you chose the backup file you " +
  "exported and that it was not modified.";

/** The file parsed and then failed the artifact schema. A newer build's export is
 * the cause the operator has no way to see, so it is named first, with the two
 * remedies that close a version gap; the file's own possible faults follow. */
export const UNRECOGNIZED_IMPORT_REASON =
  "This app does not recognize what the backup file holds. It may have been " +
  "exported by a newer version of this app than this page is running: reload " +
  "this page to use the current version, or export the backup again from the " +
  "device that wrote this file. Otherwise check that you chose the backup file " +
  "you exported and that it was not modified.";

/** The file was written in the previous artifact format, which this build does not
 * read. The remedies a newer file has are void here -- there is no version to move
 * to and no build left that writes this one -- so the wrong-file check leads, and a
 * new exchange with the partner is the way on. */
export const OUTDATED_IMPORT_REASON =
  "This backup was written by an earlier version of this app and cannot be " +
  "restored. Check that you chose the backup file you exported and that it " +
  "was not modified. Set up a new exchange with your partner instead. " +
  "Delete the old exchange if this browser still holds it.";

/**
 * Which refusal an import error is shown as. A command-line configuration this
 * app cannot hold carries its own reason and is checked first; it is escaped for
 * display here, at the one altitude, since it names fields read out of the file.
 * A file holding the previous artifact format raises {@link ManagedArtifactOutdatedError}, which is checked first: it
 * would otherwise read as the newer-build case below, whose remedies an older file
 * does not have. A schema rejection anywhere else in the
 * parse-and-reconstruct -- the artifact's own strict schema, the embedded exchange
 * document, or the reconstructed record -- raises a {@link ZodError}, and that is
 * the version-difference case. Everything else, a failed parse and a store that
 * would not take the record alike, leaves the operator with the file to check.
 */
export function importFailureReason(error: unknown): string {
  if (error instanceof ManagedConfigurationRefusedError)
    return sanitizeErrorForDisplay(error);
  if (error instanceof ManagedArtifactOutdatedError)
    return OUTDATED_IMPORT_REASON;
  return error instanceof ZodError
    ? UNRECOGNIZED_IMPORT_REASON
    : UNREADABLE_IMPORT_REASON;
}

/** The configuration-only import's file is not a document this app can parse,
 * or it is over the import cap and was refused before any parse. */
export const UNREADABLE_CONFIGURATION_REASON =
  "The configuration file could not be read. Check that you chose the " +
  "alcove.yaml the command line runs and that it is a valid YAML file.";

/** The pair import was given the app's backup file as its configuration. */
export const BACKUP_NOT_PAIR_REASON =
  "This is a backup file exported from this app, not a command-line " +
  "alcove.yaml. A backup file is imported on its own, without a key file.";

/** The pair import's key file is over the cap, refused before it is read. */
export const OVERSIZE_KEY_FILE_REASON =
  "The key file is larger than a .alcove.key can be. Choose the " +
  ".alcove.key Alcove wrote beside this alcove.yaml and import the two " +
  "again. Nothing was imported.";

/**
 * Which refusal an alcove.yaml imported with its `.alcove.key` is shown as,
 * where the refusal is about the files. A configuration or key file this app
 * will not take states its own reason, escaped for display at this one
 * altitude; neither reason holds a byte of the key file. A backup file is named
 * as one; everything else leaves the configuration file to check.
 */
export function pairImportFailureReason(error: unknown): string {
  if (
    error instanceof ManagedConfigurationRefusedError ||
    error instanceof ManagedKeyFileRefusedError
  )
    return sanitizeErrorForDisplay(error);
  if (error instanceof ManagedImportBackupNotConfigurationError)
    return BACKUP_NOT_PAIR_REASON;
  return UNREADABLE_CONFIGURATION_REASON;
}

/** The heading an import is refused under when this browser already runs the
 * exchange its file belongs to. */
export const ALREADY_HELD_IMPORT_TITLE = "That exchange is already here";

/** The refusal a pair import meets when a record this browser runs already
 * holds the key file's secret: it is the same exchange, so nothing is added. */
export function alreadyHeldImportReason(label: string): string {
  const named = label === "" ? "That exchange" : `"${label}"`;
  return (
    `${named} already runs in this browser with the secret this .alcove.key ` +
    "holds, so nothing was imported. Open it from the list. If the command " +
    "line runs it on a schedule too, stop one of the two: each run changes " +
    "the shared secret, and the copy that falls behind can no longer connect " +
    "to your partner."
  );
}

/** The refusal a backup import meets when a record this browser runs already
 * holds the backup's secret: it is the same exchange, and nothing is added. */
export function alreadyHeldBackupImportReason(label: string): string {
  const named = label === "" ? "That exchange" : `"${label}"`;
  return (
    `${named} already runs in this browser with the secret this backup file ` +
    "holds, so nothing was imported. Open it from the list to run it."
  );
}

/** The heading a backup import stops under when a listed exchange has the
 * backup's agreed terms and side. */
export const LIVE_COPY_IMPORT_TITLE =
  "This may be an exchange you already have";

/**
 * What a backup import says when it stops to ask: one or more listed exchanges
 * have the same agreed terms and side, and a different secret, which is what
 * an older backup of one of them looks like once it has run since. Two
 * exchanges can share both, so the operator decides; nothing is imported until
 * they do. `labels` holds each listed exchange's label, empty where unnamed.
 */
export function liveCopyImportReason(labels: ReadonlyArray<string>): string {
  if (labels.length === 1) {
    const [label] = labels;
    const named = label === "" ? "An exchange in the list" : `"${label}"`;
    return (
      `${named} has the same terms and the same side as this backup, with a ` +
      "different secret -- an older backup of it would look like this. " +
      "Nothing was imported. If it is the same exchange, open it from the " +
      "list instead: a second copy falls behind the first time either one " +
      "runs, and then cannot connect to your partner. If it is a separate " +
      "exchange with the same terms, add this backup beside it."
    );
  }
  const names = labels.filter((label) => label !== "").map((l) => `"${l}"`);
  const unnamed = labels.length - names.length;
  const listed =
    names.length === 0
      ? ""
      : ` (${names.join(", ")}${unnamed === 0 ? "" : `, and ${unnamed} with no name`})`;
  return (
    `${labels.length} exchanges in the list${listed} have the same terms and ` +
    "the same side as this backup, with different secrets -- an older backup " +
    "of one of them would look like this. Nothing was imported. If it is one " +
    "of these exchanges, open that one from the list instead: a second copy " +
    "falls behind the first time either one runs, and then cannot connect to " +
    "your partner. If it is a separate exchange with the same terms, add this " +
    "backup beside them."
  );
}

/** The button opening the listed exchange at `index` of `labels` from
 * {@link liveCopyImportReason}'s alert: one button when one exchange is
 * listed, else one per exchange, named by its label or its place in the list. */
export function liveCopyOpenLabel(
  labels: ReadonlyArray<string>,
  index: number,
): string {
  if (labels.length === 1) return "Open the listed exchange";
  const label = labels[index];
  return label === "" ? `Open listed exchange ${index + 1}` : `Open "${label}"`;
}

/** The confirm on {@link liveCopyImportReason}'s alert. */
export const LIVE_COPY_IMPORT_CONFIRM = "Add it as a separate exchange";

/** The heading a scoped restore is refused under when the file is not the
 * backup of the exchange it restores. */
export const OTHER_EXCHANGE_RESTORE_TITLE =
  "That is not this exchange's backup";

/**
 * What "Restore from backup" on a moved exchange says when the file is not the
 * backup downloaded when it moved: another exchange's backup, a command-line
 * file, or a backup exported after the exchange ran on the other device, whose
 * secret has changed. Names the list's import for any other file.
 */
export function otherExchangeRestoreReason(label: string): string {
  const named = label === "" ? "this exchange" : `"${label}"`;
  return (
    `This file is not the backup you downloaded when you moved ${named} to ` +
    "another device, so nothing was restored. Choose that backup file. To " +
    'import a different file, use "Import a file" below the list.'
  );
}
