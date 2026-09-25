/**
 * Taking back a managed exchange this browser handed to the command line: the
 * reverse of the command-line export ({@link ./managedCronExport.ts}), and the one
 * route from a spent record to a running one.
 *
 * The hand-off wrote the exchange's own secret into the CLI's `.alcove.key`, so
 * bringing it back needs no fresh invitation -- it needs whichever secret the
 * partnership is on now. Each command-line run rotates that secret and writes the
 * rotated one back to the key file, so:
 *
 * - where scheduled runs have happened since the hand-off, the key file holds the
 *   current secret and this browser's stored one is behind it. The operator chooses
 *   that file with the `alcove.yaml` beside it, and the take-back reads the key
 *   file's secret into the record.
 * - where none has, the stored secret is still the partnership's and no file is
 *   needed.
 *
 * The key file names no exchange, so the `alcove.yaml` beside it is what the
 * take-back checks: its agreed terms and side must be the handed-off record's,
 * or nothing is written ({@link decideRetake}). Both files are untrusted
 * structured input -- they come off a disk this page cannot inspect -- so they are
 * read through the command-line pair import's own reader
 * ({@link readManagedCommandLinePair}), and only a validated pair reaches the
 * store. Nothing here writes: the store's re-take
 * ({@link retakeHandedOffManagedExchange}) is the single cross-store step that
 * checks the pair, installs the secret and clears the spent state, under the
 * run+rotate lock. Either route leaves the record marked imported: no check here
 * tells a current key file from a stale one, and none can check the attestation
 * that nothing has run on the other machine, so an authentication failure at the
 * next run has that benign reading available until a run succeeds
 * ({@link ./managedFailureTiers.ts}).
 *
 * Where the key file cannot be produced at all, the recovery is the one a stale
 * secret always has: take the exchange back without it and mint a fresh invitation
 * from its own surface ({@link ./managedReinvite.ts}).
 */

import { readManagedCommandLinePair } from "./managedCommandLineImport";
import { retakeHandedOffManagedExchange } from "./managedExchangeStore";

import type { ManagedRetakeOutcome } from "./managedExchangeStore";
import type { RunnableManagedExchangeRecord } from "./managedExchangeRecord";

/** The two files a command-line run holds, as text: its `alcove.yaml` and the
 * `.alcove.key` beside it. */
export interface ManagedRetakeFiles {
  configuration: string;
  key: string;
}

/** The platform boundaries the take-back drives, injected so the flow is testable
 * without a database. */
export interface ManagedRetakeDeps {
  /** Check `taken` against the handed-off record and clear the record's spent
   * state, installing `taken`'s secret where it has moved past the stored one
   * and marking the record imported -- as of `at` where that install happened --
   * in one store step under the run+rotate lock. */
  retake: (
    id: string,
    at: string,
    taken?: RunnableManagedExchangeRecord,
  ) => Promise<ManagedRetakeOutcome>;
  /** The moment of the take-back; injected so the marker date is the caller's
   * clock. */
  now: () => Date;
}

const defaultDeps: ManagedRetakeDeps = {
  retake: retakeHandedOffManagedExchange,
  now: () => new Date(),
};

/**
 * How a take-back ended: the store's own outcomes, plus the files' own refusal.
 * `"unreadable-files"` is reported rather than raised because it is the files the
 * operator chose, not a fault of this browser -- the same standing an import gives a
 * file it will not take -- and the store was never reached.
 */
export type ManagedRetakeResult =
  ManagedRetakeOutcome | { kind: "unreadable-files" };

/**
 * Take a handed-off exchange back, optionally reading the command-line run's
 * files into the record. `files` is the two files' text, or `undefined` where no
 * scheduled run has happened since the hand-off and the stored secret still
 * stands.
 *
 * The files are read before the store is touched, so a pair the reader refuses
 * leaves the record spent and the store untouched.
 *
 * @throws {ZodError} if the store write produces an invalid record; nothing is
 *   written.
 */
export async function retakeManagedExchange(
  id: string,
  files?: ManagedRetakeFiles,
  deps: ManagedRetakeDeps = defaultDeps,
): Promise<ManagedRetakeResult> {
  let taken: RunnableManagedExchangeRecord | undefined;
  if (files !== undefined) {
    try {
      taken = readManagedCommandLinePair(files.configuration, files.key);
    } catch {
      return { kind: "unreadable-files" };
    }
  }
  return deps.retake(id, deps.now().toISOString(), taken);
}
