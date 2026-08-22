import {
  JobApiRequestError,
  createServerJobReattachDriver,
} from "@psi/serverJobExchangeDriver";
import { readAttachment, writeAttachment } from "@psi/consoleJobAttachment";

import type { JobApiClient, JobRunStatus } from "@psi/serverJobExchangeDriver";
import type { ConsoleJobSeat } from "@psi/consoleJobAttachment";
import type { ExchangeDriverEvents } from "@psi/exchangeDriver";
import type { RunOutputs } from "./runOutputs";

/** Whether an error is a busy (409) job-create rejection -- the appliance's
 * single exchange slot is already occupied. Only this drives a re-attach; every
 * other failure raises the run's alert. */
export function isExchangeBusyError(error: unknown): boolean {
  return error instanceof JobApiRequestError && error.status === 409;
}

/**
 * Handle a busy (409) job-create rejection at exchange start by RE-ATTACHING to
 * the exchange already occupying the appliance's single slot, instead of raising
 * the "already running an exchange" alert. Shared by both bench hooks so the 409
 * path is not duplicated.
 *
 * This heals the two-tabs / navigate-away-and-back dead-end and recovers an
 * ORPHANED job (created server-side but whose recovery record the client never
 * persisted -- e.g. a create the tab aborted between the server creating the job
 * and `onJobCreated` running). The id is resolved from the 409 body first (which
 * names the orphan), falling back to the client-persisted attachment id only when
 * the body carries none. The resolved id is confirmed to be a LIVE job before
 * re-attaching, and recorded in the persisted attachment so the orphan becomes
 * recoverable from the strand-recovery surface too. It then folds the existing
 * run's SSE stream onto the passed run callbacks
 * ({@link createServerJobReattachDriver}), so the surface resumes exactly as a
 * fresh run's would, under recovery-style copy the caller flips via
 * {@link onReattaching}.
 *
 * Returns true when it re-attached (the caller must NOT raise the alert), false
 * when no live job could be discovered (the caller falls back to today's alert).
 * An abort mid-handling returns true (silent, matching the drivers' own abort
 * treatment): the run is being torn down, so neither a re-attach nor an alert is
 * wanted.
 */
export async function reattachOnBusy({
  error,
  client,
  seat,
  channel,
  events,
  onReattaching,
}: {
  error: unknown;
  client: JobApiClient;
  seat: ConsoleJobSeat;
  channel: string;
  events: ExchangeDriverEvents<RunOutputs>;
  /** Flip the run surface into recovery-style copy, carrying the resolved id and
   * its live status so the surface heads correctly before the replay lands and
   * the deliberate-leave paths discard the re-attached job. */
  onReattaching: (jobId: string, status: JobRunStatus) => void;
}): Promise<boolean> {
  if (!isExchangeBusyError(error)) return false;
  const jobId = resolveBusyJobId(error);
  if (jobId === undefined) return false;
  // Read the live abort state through a call so the re-check after the await is
  // not narrowed to a constant by the first guard (the drivers' idiom).
  const aborted = () => events.signal.aborted;
  if (aborted()) return true;
  // Confirm the resolved id is a LIVE job before re-attaching: a stale id (a
  // since-gone body id, or an outdated persisted record) must not drive a
  // re-attach into a dead run -- fall back to the alert instead.
  const probe = await client.fetchJobStatus(jobId, events.signal);
  if (aborted()) return true;
  if (probe.kind !== "live") return false;
  // Record the resolved id so a server-created job whose recovery record was
  // never written becomes recoverable.
  writeAttachment({ jobId, seat, channel });
  onReattaching(jobId, probe.status);
  await createServerJobReattachDriver(jobId, client).run(events);
  return true;
}

/** Resolve the job id to re-attach to: the id the busy body carries (the current
 * slot occupant, which recovers an orphan), falling back to the client-persisted
 * attachment id when the body carries none. */
function resolveBusyJobId(error: unknown): string | undefined {
  if (error instanceof JobApiRequestError && error.activeJobId !== undefined)
    return error.activeJobId;
  return readAttachment()?.jobId;
}
