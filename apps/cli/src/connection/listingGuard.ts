import {
  DirectoryListingBoundsError,
  DISPLAY_TRUNCATION_MARKER,
  redactPrivateKeyMaterial,
  type TransportOperationStalledError,
} from "@psilink/core";

import { fittedCauseLink } from "./causeLink";
import { transportOperationStalledError } from "./sftpLivenessGuard";

/**
 * Directory-listing enforcement shared by the file-transport adapters
 * ({@link ../connection/localFSClient.LocalFSClient | LocalFSClient} and
 * {@link ../connection/ssh2SftpAdapter.SSH2SFTPClientAdapter}): a directory
 * over {@link MAX_DIRECTORY_ENTRIES} entries, or an entry name over
 * {@link MAX_FILENAME_LENGTH}, is refused with a
 * {@link DirectoryListingBoundsError} before the listing is materialized.
 * Rationale: docs/spec/CHANNEL_SECURITY.md, "Directory-listing bound".
 */

/**
 * Maximum number of entries a transport directory listing enumerates
 * before it is refused, counting every entry regardless of type. Fixed,
 * not operator-configurable. Derivation (roughly 5 MiB worst-case
 * allocation) and enforcement point: docs/spec/CHANNEL_SECURITY.md,
 * "Directory-listing bound".
 */
export const MAX_DIRECTORY_ENTRIES = 8192;

/**
 * Maximum length, in characters, of a single directory entry's filename;
 * enforced per entry at the transport `list()` layer in both adapters.
 * Fixed, for the same reason as {@link MAX_DIRECTORY_ENTRIES}. Value is
 * the POSIX `NAME_MAX`; derivation: docs/spec/CHANNEL_SECURITY.md,
 * "Directory-listing bound".
 */
export const MAX_FILENAME_LENGTH = 255;

const DIRECTORY_LINK_LABEL = "directory: ";

/**
 * Compose the labelled `directory:` cause link both refusals below hold,
 * fitted at this composition site by {@link ./causeLink.fittedCauseLink}:
 * `dirPath` is bounded nowhere upstream -- on an offline-accept config it
 * can be seeded from a partner invitation endpoint field that is
 * charset-unconstrained and 4096 characters wide. Why fitting happens
 * here rather than at the display boundary: docs/spec/CHANNEL_SECURITY.md,
 * "Display sanitization escape format".
 */
function directoryLink(dirPath: string): string {
  return fittedCauseLink(DIRECTORY_LINK_LABEL, dirPath);
}

/**
 * Construct the typed, terminal error for a directory whose entry count exceeds
 * {@link MAX_DIRECTORY_ENTRIES}. `dirPath` takes a labelled cause link of its
 * own ({@link directoryLink}) rather than leading the summary, where it would
 * spend the budget the bound, the refusal and the next step
 * {@link DirectoryListingBoundsError} holds need.
 */
export function directoryTooLargeError(
  dirPath: string,
  max: number,
): DirectoryListingBoundsError {
  return new DirectoryListingBoundsError(
    `the rendezvous directory contains more than ${max} entries; refusing to ` +
      `enumerate it to avoid an unbounded memory allocation`,
    { details: [directoryLink(dirPath)] },
  );
}

/**
 * Construct the typed, terminal error for a directory entry whose filename
 * exceeds {@link MAX_FILENAME_LENGTH}. Only a leading 64-character slice
 * of the offending name is interpolated -- a memory bound, not the display
 * budget {@link directoryLink} fits to -- raw and unescaped (escaping is
 * the display boundary's job; a split surrogate pair still renders as a
 * visible escape, not mojibake). The true length is reported separately,
 * as a number, never partner text.
 *
 * `dirPath` and `name` are chosen by different parties (operator/partner
 * endpoint vs. server), so each takes a labelled cause link of its own: a
 * shared link would let either chooser's bytes delete the other's
 * disclosure, or delete the refusal and the next step.
 */
export function filenameTooLongError(
  dirPath: string,
  name: string,
  max: number,
): DirectoryListingBoundsError {
  // A name reaching here is longer than MAX_FILENAME_LENGTH and so longer than
  // this preview, which is why the marker is unconditional. Redaction runs after
  // slicing, so the slice still bounds what an attacker-sized name can relay
  // into memory, and before the marker is appended, so a planted BEGIN marker in
  // the slice cannot consume it under the fail-closed dangling rule.
  const shown = `${redactPrivateKeyMaterial(
    name.slice(0, 64),
  )}${DISPLAY_TRUNCATION_MARKER}`;
  return new DirectoryListingBoundsError(
    `the rendezvous directory contains an entry whose filename is ` +
      `${name.length} characters, exceeding the maximum of ${max}; refusing ` +
      `to process it`,
    {
      details: [directoryLink(dirPath), `entry name: ${shown}`],
    },
  );
}

/**
 * Maximum number of `readdir` round-trips (server batches) a single
 * transport `list()` will issue before it is refused, enforced in the
 * SFTP adapter's streamed read loop. The liveness sibling of the
 * memory-size bounds above: a server returning empty, non-EOF readdir
 * batches advances neither bound, so without this cap the read loop
 * recurses forever. Fixed, not operator-configurable. Value and
 * derivation: docs/spec/CHANNEL_SECURITY.md, "Per-operation liveness
 * bounds".
 */
export const MAX_LISTING_READDIR_BATCHES = 2 * MAX_DIRECTORY_ENTRIES;

/**
 * Construct the typed, terminal liveness error for a listing that exceeded the
 * round-trip cap ({@link MAX_LISTING_READDIR_BATCHES}) without completing -- the
 * empty-batch / no-progress flood. Builds the shared
 * {@link ./sftpLivenessGuard.transportOperationStalledError} so this listing-
 * specific stall and the `get()` / `createExclusive()` stalls are one error type.
 */
export function listingStalledByBatchCountError(
  dirPath: string,
  max: number,
): TransportOperationStalledError {
  return transportOperationStalledError(
    "directory listing",
    dirPath,
    `made no progress over ${max} readdir round-trips without reaching ` +
      `end-of-directory`,
  );
}

/**
 * Construct the typed, terminal liveness error for a listing that exceeded the
 * wall-clock deadline ({@link ./sftpLivenessGuard.SFTP_STALL_DEADLINE_MS})
 * without completing -- the server withheld a readdir/close callback.
 */
export function listingStalledByTimeoutError(
  dirPath: string,
  deadlineMs: number,
): TransportOperationStalledError {
  return transportOperationStalledError(
    "directory listing",
    dirPath,
    `did not complete within ${deadlineMs} ms (the server withheld a ` +
      `directory-read response)`,
  );
}
