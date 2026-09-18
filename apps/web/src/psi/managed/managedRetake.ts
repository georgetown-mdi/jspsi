/**
 * Taking back a managed exchange this browser handed to the command line: the
 * reverse of the command-line export ({@link ./managedCronExport.ts}), and the one
 * route from a spent record to a running one.
 *
 * The hand-off wrote the exchange's own secret into the CLI's `.psilink.key`, so
 * bringing it back needs no fresh invitation -- it needs whichever secret the
 * partnership is on now. Each command-line run rotates that secret and writes the
 * rotated one back to the key file, so:
 *
 * - where scheduled runs have happened since the hand-off, the key file holds the
 *   current secret and this browser's stored one is behind it. The operator chooses
 *   that file and the take-back reads it into the record.
 * - where none has, the stored secret is still the partnership's and no file is
 *   needed.
 *
 * The file is untrusted structured input -- it comes off a disk this page cannot
 * inspect -- so it is capped before it is read and parsed through the sensitive-JSON
 * chokepoint and the strict key-pair schema ({@link keyFileFieldsSchema}), and only
 * a validated pair reaches the store. Nothing here writes: the store's re-take
 * ({@link retakeHandedOffManagedExchange}) is the single cross-store step that
 * installs the secret and clears the spent state, under the run+rotate lock. Either
 * route leaves the record marked imported: no check here tells a current key file
 * from a stale one, and none can check the attestation that nothing has run on the
 * other machine, so an authentication failure at the next run has that benign
 * reading available until a run succeeds ({@link ./managedFailureTiers.ts}).
 *
 * Where the key file cannot be produced at all, the recovery is the one a stale
 * secret always has: take the exchange back without it and mint a fresh invitation
 * from its own surface ({@link ./managedReinvite.ts}).
 */

import { parseSensitiveJson } from "@psilink/core";

import { keyFileFieldsSchema } from "./managedExchangeRecord";
import { retakeHandedOffManagedExchange } from "./managedExchangeStore";

import type { ManagedExchangeKeyFields } from "./managedExchangeRecord";
import type { ManagedRetakeOutcome } from "./managedExchangeStore";

/** Upper bound, in bytes, on a key file the take-back will read, applied before the
 * sensitive parse's own structural bound. The file holds one secret and one instant,
 * so anything larger is not the file the operator meant to choose. */
export const MAX_KEY_FILE_IMPORT_BYTES = 10_000;

/** The label a failed parse of the key file names, and nothing else: the file's own
 * bytes are the secret, so no parser message and no span of the source may reach the
 * operator (see `parseSensitiveJson`). */
const KEY_FILE_LABEL = "command-line key file";

/**
 * Parse a `.psilink.key` file's text into the validated key pair the take-back
 * installs. Bounded sensitive parse, then the strict reader-rejects-unknown key
 * schema, so a file holding anything but the pair is rejected before any store write.
 *
 * @throws {UsageError} if the bytes are not parseable JSON.
 * @throws {ZodError} if the parsed value is not a valid key pair.
 */
export function parseManagedKeyFile(source: string): ManagedExchangeKeyFields {
  return keyFileFieldsSchema.parse(parseSensitiveJson(source, KEY_FILE_LABEL));
}

/** The platform boundaries the take-back drives, injected so the flow is testable
 * without a database. */
export interface ManagedRetakeDeps {
  /** Clear the record's spent state, installing `key`'s secret where it has moved
   * past the stored one and marking the record imported -- as of `at` where that
   * install happened -- in one store step under the run+rotate lock. */
  retake: (
    id: string,
    at: string,
    key?: ManagedExchangeKeyFields,
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
 * How a take-back ended: the store's own outcomes, plus the file's own refusal.
 * `"unreadable-key-file"` is reported rather than raised because it is the file the
 * operator chose, not a fault of this browser -- the same standing an import gives a
 * file it will not take -- and the store was never reached.
 */
export type ManagedRetakeResult =
  ManagedRetakeOutcome | { kind: "unreadable-key-file" };

/**
 * Take a handed-off exchange back, optionally reading the command-line run's key
 * file into the record. `keyFile` is the file's text, or `undefined` where no
 * scheduled run has happened since the hand-off and the stored secret still stands.
 *
 * The key file is parsed before the store is touched, so a file the parse rejects
 * leaves the record spent and the store untouched.
 *
 * @throws {ZodError} if the store write produces an invalid record; nothing is
 *   written.
 */
export async function retakeManagedExchange(
  id: string,
  keyFile?: string,
  deps: ManagedRetakeDeps = defaultDeps,
): Promise<ManagedRetakeResult> {
  let key: ManagedExchangeKeyFields | undefined;
  if (keyFile !== undefined) {
    try {
      key = parseManagedKeyFile(keyFile);
    } catch {
      return { kind: "unreadable-key-file" };
    }
  }
  return deps.retake(id, deps.now().toISOString(), key);
}
