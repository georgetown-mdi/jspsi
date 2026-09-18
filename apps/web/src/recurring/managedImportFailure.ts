/**
 * What the import affordance says when it will not take a backup file (see
 * docs/MANAGED_EXCHANGE.md, "Eviction recovery is the import flow"). The refusal
 * an already-handed-off exchange meets is not one of these -- that file is fine
 * and the exchange is still here, so it says so itself
 * ({@link ./managedHandoffGate.ts}).
 *
 * Three things stop a file, and they call for different actions. Bytes that are not
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
 */

import { ZodError } from "zod";

import { ManagedArtifactOutdatedError } from "@psi/managed/managedExchangeArtifact";

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
 * Which refusal an import error is shown as. A file holding the previous artifact
 * format raises {@link ManagedArtifactOutdatedError}, which is checked first: it
 * would otherwise read as the newer-build case below, whose remedies an older file
 * does not have. A schema rejection anywhere else in the
 * parse-and-reconstruct -- the artifact's own strict schema, the embedded exchange
 * document, or the reconstructed record -- raises a {@link ZodError}, and that is
 * the version-difference case. Everything else, a failed parse and a store that
 * would not take the record alike, leaves the operator with the file to check.
 */
export function importFailureReason(error: unknown): string {
  if (error instanceof ManagedArtifactOutdatedError)
    return OUTDATED_IMPORT_REASON;
  return error instanceof ZodError
    ? UNRECOGNIZED_IMPORT_REASON
    : UNREADABLE_IMPORT_REASON;
}
