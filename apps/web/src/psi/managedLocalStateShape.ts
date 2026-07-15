/**
 * The shape and validation of a managed exchange's local sibling state -- the pure,
 * IndexedDB-free half of {@link ./managedLocalState.ts}. It is a separate module so
 * both the sibling-state IDB layer and the record store's rotation write (which
 * clears the backup marker in the same cross-store transaction) can validate the
 * sibling entry without an import cycle: the record store cannot import the sibling
 * IDB layer, which already imports the store for its database handle.
 *
 * The sibling state is validated on every read and write through
 * {@link managedLocalStateSchema} with the same reader-rejects-unknown discipline
 * the record store follows, so a corrupted or app-upgrade-invalidated entry rejects
 * loudly rather than loading.
 */

import { z } from "zod";

import type { ManagedBackupMarker } from "./managedBackupState";
import type { ZodType } from "zod";

/** This device's spent state for a record: set by a migration export, which hands
 * the copy off and transitions the source to a visible spent state (no Run
 * affordance, no scheduled runs). A plain handoff timestamp -- no secret material,
 * no rotation epoch. Cleared by importing the artifact back (a revive). */
export interface ManagedSpentState {
  /** ISO 8601 UTC instant the copy was handed off by a migration export. */
  spentAt: string;
}

/** The local sibling state for a record: the optional backup marker and the
 * optional spent state, either present independently. An entry with neither is
 * meaningless and never written (a cleared state deletes the entry). */
export interface ManagedLocalState {
  /** When a backup was last taken (see {@link ManagedBackupMarker}); absent until
   * the first export. */
  backup?: ManagedBackupMarker;
  /** This device's spent state (see {@link ManagedSpentState}); absent unless a
   * migration export handed the copy off. */
  spent?: ManagedSpentState;
}

/** The sibling-state validator: reader-rejects-unknown at every level, so a
 * corrupted or app-upgrade-invalidated entry rejects rather than loading. */
export const managedLocalStateSchema: ZodType<ManagedLocalState> = z
  .object({
    backup: z.object({ backedUpAt: z.iso.datetime() }).strict().optional(),
    spent: z.object({ spentAt: z.iso.datetime() }).strict().optional(),
  })
  .strict();

/**
 * Parse and validate a value read from the sibling store as a
 * {@link ManagedLocalState}. Throws on an unknown key or a malformed instant rather
 * than silently accepting -- the reader-rejects-unknown rule.
 *
 * @throws {ZodError} if the value is not valid local state.
 */
export function parseManagedLocalState(raw: unknown): ManagedLocalState {
  return managedLocalStateSchema.parse(raw);
}
