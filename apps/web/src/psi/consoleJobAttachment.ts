import { getLogger } from "@psilink/core";

import { whenDiagnostic } from "@utils/diagnostics";

import type { JobApiClient } from "@psi/serverJobExchangeDriver";

/**
 * The console's strand-recovery persistence: a single localStorage record naming
 * the last exchange this browser started on the appliance, plus the discard
 * sequence every deliberate-abandonment path runs.
 *
 * The record survives a hard tab close (localStorage, not sessionStorage -- the
 * strand case this exists for is exactly a close that sessionStorage would not
 * survive) and holds no secret: a v4 UUID plus two enum labels. Access to the job
 * rides the loopback-only origin the console appliance binds, never knowledge of
 * the id, so persisting the id discloses nothing an attacker could not already
 * reach.
 */

const log = getLogger("consoleJobAttachment");

/** The localStorage key the console's last-created job id is written under. */
const STORAGE_KEY = "psilink-console-last-job";

/** The stored record's schema version; a value under any other version reads as
 * absent (a forward/backward-incompatible record is discarded, not migrated). */
const ATTACHMENT_VERSION = 1;

/** How long a discard waits for a graceful cancel to run to completion before
 * deleting: the CLI's SIGINT -> SIGTERM -> SIGKILL escalation is ~10s, so this
 * budget lets the child clean its rendezvous remnants before DELETE's own
 * SIGKILL, rather than jumping straight to it. */
const DISCARD_POLL_BUDGET_MS = 15_000;

/** The gap between discard status polls. */
const DISCARD_POLL_INTERVAL_MS = 500;

/** Which bench seat started the exchange -- carried for the recovery surface's
 * initial run-state fold; the recovery re-attaches through the same per-id routes
 * regardless. */
export type ConsoleJobSeat = "inviter" | "acceptor";

/** The persisted strand-recovery record: the last job this browser created on the
 * appliance, its seat, and the transport it rode. */
export interface ConsoleJobAttachment {
  jobId: string;
  seat: ConsoleJobSeat;
  channel: string;
}

/** Validate a parsed localStorage value into an attachment, or null when it is
 * not a current-version record with the three well-formed fields. */
function attachmentOf(value: unknown): ConsoleJobAttachment | null {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return null;
  const { v, jobId, seat, channel } = value as Record<string, unknown>;
  if (v !== ATTACHMENT_VERSION) return null;
  if (typeof jobId !== "string" || jobId.length === 0) return null;
  if (seat !== "inviter" && seat !== "acceptor") return null;
  if (typeof channel !== "string" || channel.length === 0) return null;
  return { jobId, seat, channel };
}

/**
 * Read the persisted attachment, or null when none is stored or the stored value
 * is malformed. A malformed value (a hand-edited record, or one from an
 * incompatible version) is cleared as it is read, so a bad record cannot linger
 * and re-fail the probe on every mount. Storage being unavailable (SSR, blocked
 * quota) reads as absent.
 */
export function readAttachment(): ConsoleJobAttachment | null {
  let raw: string | null;
  try {
    raw = globalThis.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    clearAttachment();
    return null;
  }
  const attachment = attachmentOf(parsed);
  if (attachment === null) {
    clearAttachment();
    return null;
  }
  return attachment;
}

/** Persist the attachment, best-effort: a storage failure (blocked quota) is
 * dev-logged and swallowed so a create still proceeds -- recovery degrades to
 * unavailable rather than failing the run. */
export function writeAttachment(attachment: ConsoleJobAttachment): void {
  try {
    globalThis.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ v: ATTACHMENT_VERSION, ...attachment }),
    );
  } catch (error) {
    whenDiagnostic(() =>
      log.warn("console job attachment write failed:", error),
    );
  }
}

/** Remove the persisted attachment, best-effort. */
export function clearAttachment(): void {
  try {
    globalThis.localStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    whenDiagnostic(() =>
      log.warn("console job attachment clear failed:", error),
    );
  }
}

/** A never-aborting signal for the discard's own status calls: the discard is a
 * deliberate action that runs to completion independent of any run surface's
 * teardown. */
const NEVER_ABORT = new AbortController().signal;

/** Resolve after `ms`, the default poll delay (injected in tests). */
function realDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Cancel-if-running, then delete, then clear: the deliberate-discard sequence
 * every abandonment path runs (try again, start over, run another, the recovery
 * panel's Discard). If the job is still running it is cancelled and polled to
 * terminal within a bounded budget -- so the CLI's graceful escalation finishes
 * and cleans its rendezvous before the DELETE's SIGKILL -- and only then deleted.
 * The explicit DELETE is the one disk-remover; clearing the attachment last means
 * a completed discard always leaves no dangling recovery record.
 *
 * Best-effort throughout: a failed status/cancel/delete is dev-logged and the
 * sequence proceeds, and the attachment is cleared even if a step failed. A
 * dangling record that can no longer reach its job is worse than a workdir left
 * on disk: nothing reclaims a workdir automatically -- the explicit DELETE is its
 * only remover -- so the record is dropped rather than left re-failing recovery
 * on every mount.
 */
export async function discardServerJob(
  client: JobApiClient,
  jobId: string,
  delay: (ms: number) => Promise<void> = realDelay,
): Promise<void> {
  try {
    const status = await client.fetchJobStatus(jobId, NEVER_ABORT);
    if (status.kind === "live" && status.status === "running") {
      await client.cancelJob(jobId).catch((error) => {
        whenDiagnostic(() => log.warn("server job cancel failed:", error));
      });
      const deadline = Date.now() + DISCARD_POLL_BUDGET_MS;
      while (Date.now() < deadline) {
        await delay(DISCARD_POLL_INTERVAL_MS);
        const polled = await client.fetchJobStatus(jobId, NEVER_ABORT);
        // Stop waiting once the job is no longer a live running child -- a
        // terminal status, a confirmed removal, or an unreachable blip -- then
        // fall through to the DELETE.
        if (polled.kind !== "live" || polled.status !== "running") break;
      }
    }
    await client.deleteJob(jobId).catch((error) => {
      whenDiagnostic(() => log.warn("server job delete failed:", error));
    });
  } catch (error) {
    whenDiagnostic(() => log.warn("server job discard failed:", error));
  } finally {
    clearAttachment();
  }
}
