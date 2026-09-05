import { useCallback, useEffect, useState } from "react";

import { managedExchangeRunLockHeld } from "@psi/managed/managedExchangeLock";

/** How often the mounted surface re-reads the record's run lock. Web Locks raises no
 * change event, so the only reading available is a poll; this is short enough that a
 * hand-off the operator is looking at goes gray, and comes back, within a beat of the
 * run starting or ending. */
const RUN_LOCK_POLL_MS = 400;

/** What a surface gating on a run in flight gets: the current reading, and the
 * immediate re-read a click takes before acting on it. */
export interface ManagedRunInFlight {
  /** Whether a run of this record is in flight anywhere this browser profile can
   * see. */
  inFlight: boolean;
  /** Re-read the record's run lock right now, updating {@link inFlight} and resolving
   * what it read. A click handler takes this rather than trusting the poll, whose
   * last reading can be a beat old. */
  recheckLock: () => Promise<boolean>;
}

/**
 * Whether a run of managed exchange `id` is in flight, in ANY context this browser
 * profile can see: this surface's own run, a second tab's, or the scheduled runtime's.
 *
 * Two signals, because neither covers the other. The record's run+rotate lock
 * ({@link managedExchangeRunLockHeld}) is origin-wide, so it is what sees a run this
 * surface did not start -- but it is held only across the window in which a run can
 * still rotate the secret, and it is a poll rather than an event. `runningHere` is
 * this surface's own run state: instant, and standing for the run's whole life
 * including the data exchange the lock is not held across.
 *
 * What this gates is presentation. The lock can be taken or released between the poll
 * and the click that follows it, so a hand-off that spends the secret decides its own
 * precondition where it writes: the spend takes this same lock (`ifAvailable`) and
 * re-reads the record inside it, so a click that slips past this reading is refused
 * there rather than accepted. This reading only pre-empts that refusal, in the words
 * the refusal itself is shown in.
 */
export function useManagedRunInFlight(
  id: string,
  runningHere: boolean,
): ManagedRunInFlight {
  const [lockHeld, setLockHeld] = useState(false);

  const recheckLock = useCallback(async (): Promise<boolean> => {
    // A query this browser will not answer leaves the gate open rather than shut:
    // the reading is advisory either way, since the spend behind the gate takes
    // the lock itself and refuses what this could not see.
    const held = await managedExchangeRunLockHeld(id).catch(() => false);
    setLockHeld(held);
    return held;
  }, [id]);

  useEffect(() => {
    let live = true;
    const read = () =>
      void managedExchangeRunLockHeld(id)
        .catch(() => false)
        .then((held) => {
          if (live) setLockHeld(held);
        });
    read();
    const poll = window.setInterval(read, RUN_LOCK_POLL_MS);
    return () => {
      live = false;
      window.clearInterval(poll);
    };
  }, [id]);

  return { inFlight: runningHere || lockHeld, recheckLock };
}
