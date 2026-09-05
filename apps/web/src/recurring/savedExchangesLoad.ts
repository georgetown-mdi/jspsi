/**
 * Loads the home list for the managed-exchange surfaces: opens the store,
 * reads the records and their local sibling state, and derives the display rows,
 * resolving to one of three outcomes the home and list routes each render on. No
 * React: the ordering and the failure classification are unit-testable in Node
 * with the store reads injected.
 *
 * A store whose open does not succeed -- private mode with storage blocked,
 * an engine without IndexedDB, or a version-change open transiently blocked by
 * another tab's older connection -- is `"unavailable"`: the home route renders
 * the quick path and the list route shows an explicit degrade. A store that
 * opens but whose read fails (a corrupted or app-upgrade-invalidated record)
 * is `"failed"`: the records exist but cannot be shown, distinct from no store
 * at all -- both routes report the read failure rather than the quick path. The
 * open probe alone decides the classification.
 */

import { savedExchangeRows } from "./savedExchangesModel";

import type { ManagedExchangeRecord } from "@psi/managed/managedExchangeRecord";
import type { ManagedLocalState } from "@psi/managed/managedLocalState";
import type { SavedExchangeRow } from "./savedExchangesModel";

/** The outcome of loading the home list. `"unavailable"` means the store could not
 * be opened at all (degrade to the quick path); `"failed"` means it opened but the
 * read failed; `"ready"` holds the derived rows (possibly empty). */
export type SavedExchangesLoad =
  | { kind: "unavailable" }
  | { kind: "failed" }
  | { kind: "ready"; rows: Array<SavedExchangeRow> };

/** The store reads the load depends on, injected so the ordering and the two
 * failure classes are testable without a real IndexedDB. */
export interface SavedExchangesLoadDeps {
  /** Probe the store's openability. Rejects when the store cannot be opened at all;
   * on success the load closes the returned connection at once (the reads reopen as
   * needed), so the probe never leaks it. */
  openStore: () => Promise<{ close: () => void }>;
  /** Read every stored record. Rejects on a corrupted or invalidated store. */
  listExchanges: () => Promise<Array<ManagedExchangeRecord>>;
  /** Read the local sibling state, keyed by record id. */
  listLocalState: () => Promise<Map<string, ManagedLocalState>>;
  /** The instant the rows are derived as of (the expiry note is `now`-relative). */
  now: () => number;
}

/**
 * Load the home list. Probes the store's open first so a store that cannot be
 * opened at all classifies as `"unavailable"` (degrade to the quick path) rather
 * than as a read failure; only once the open succeeds are the records and local
 * state read and joined into rows. A read failure after a successful open is
 * `"failed"` -- the store exists but its contents cannot be shown.
 */
export async function loadSavedExchanges(
  deps: SavedExchangesLoadDeps,
): Promise<SavedExchangesLoad> {
  try {
    // Close the probe connection at once: holding it open would leak a live
    // connection for the page lifetime and could block a later version-change
    // transaction. The reads below reopen as needed.
    (await deps.openStore()).close();
  } catch {
    return { kind: "unavailable" };
  }
  try {
    const [records, localState] = await Promise.all([
      deps.listExchanges(),
      deps.listLocalState(),
    ]);
    return {
      kind: "ready",
      rows: savedExchangeRows(records, localState, deps.now()),
    };
  } catch {
    return { kind: "failed" };
  }
}
