/**
 * The pure model behind a managed re-run's completion surface: what the surface
 * offers the operator the moment a run completes. The headline is that a
 * successful run just rotated the secret, which flips the derived backup state to
 * "backup needed" -- the previous backup went stale at that moment -- so the
 * completion surface offers "download updated backup" as the natural final step,
 * and with a fresh backup taken the exchange shows green and quiet, no standing
 * warnings (see docs/MANAGED_EXCHANGE.md, "The second run, end to end" and
 * "Moment-anchored backup surfaces").
 *
 * The backup export artifact -- its format and custody model -- is a later item's
 * scope, so the export itself is not built here: the surface takes an INJECTABLE
 * backup hook. When an exporter is wired, the surface offers the refreshed backup;
 * until one exists, the affordance is deferred (named as such, not silently
 * absent), so the completion surface stays accurate without inventing an export
 * format. This is the boundary the exporter item plugs into.
 *
 * Pure and platform-free: no IndexedDB, no download machinery. The host component
 * renders what {@link managedRerunCompletion} decides and calls the hook when the
 * operator acts.
 */

/** The refreshed-backup export the completion surface offers, injected by the host
 * when an exporter is wired. Absent until the export artifact item lands, in which
 * case the surface shows the deferred affordance rather than an active one. */
export interface ManagedBackupExportHook {
  /** Produce and hand the operator the refreshed backup for this record (the
   * export snapshots the just-rotated secret). Rejects if the export fails; the
   * host reports that without claiming the backup was taken. */
  downloadUpdatedBackup: () => Promise<void>;
}

/** The completion surface's backup affordance, derived from whether an exporter
 * is wired: `"offer-refresh"` once one exists, so the surface offers "download
 * updated backup"; `"deferred"` while none does, so the surface names the
 * refresh as not-yet-available rather than implying it can be taken. */
type ManagedBackupAffordance = "offer-refresh" | "deferred";

/** What the completion surface renders after a successful re-run: the backup
 * affordance to show, and -- when it is `"offer-refresh"` -- the hook the action
 * button calls. */
interface ManagedRerunCompletion {
  /** Which backup affordance the surface shows. */
  backupAffordance: ManagedBackupAffordance;
  /** The hook the "download updated backup" action calls; present only when
   * {@link backupAffordance} is `"offer-refresh"`. */
  backupHook?: ManagedBackupExportHook;
}

/**
 * Decide the completion surface for a successful re-run: `"offer-refresh"` when
 * a backup export hook is supplied, else `"deferred"`. The hook's presence is
 * the only input -- a completed run always just rotated the secret, so the
 * backup is always stale at completion; there is no "already backed up" case
 * to distinguish here.
 */
export function managedRerunCompletion(
  backupHook?: ManagedBackupExportHook,
): ManagedRerunCompletion {
  if (backupHook === undefined) return { backupAffordance: "deferred" };
  return { backupAffordance: "offer-refresh", backupHook };
}
