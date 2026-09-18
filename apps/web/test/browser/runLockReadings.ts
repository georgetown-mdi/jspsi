/**
 * Driving the gap between the run+rotate lock's readings, for the browser suites
 * that hold a surface's click-time re-read to its job.
 *
 * A managed surface reads the lock on a 400 ms poll, so the lock can be taken
 * between two readings and leave a control enabled over a run already under way.
 * Every handler behind such a control re-reads the lock at the click; these
 * helpers put a click on the far side of that gap deterministically, instead of
 * racing the real interval.
 */

import { managedExchangeLockName } from "@psi/managed/managedExchangeLock";

/**
 * Filter this record's lock out of every `navigator.locks.query()` reading, so a
 * surface reads the record free while a run actually holds it -- the poll and a
 * handler's re-read both go through this reading.
 *
 * `reveal` stops the filtering, once the reading should catch up mid-click;
 * leaving it unrevealed keeps the surface from ever seeing the run.
 */
export function filterLockFromReadings(id: string): {
  reveal: () => void;
  restore: () => void;
} {
  const name = managedExchangeLockName(id);
  const realQuery = navigator.locks.query.bind(navigator.locks);
  let hidden = true;
  (navigator.locks as unknown as { query: unknown }).query = async () => {
    const snapshot = await realQuery();
    if (!hidden) return snapshot;
    return {
      ...snapshot,
      held: snapshot.held?.filter((lock) => lock.name !== name),
    };
  };
  return {
    reveal: () => {
      hidden = false;
    },
    restore: () => {
      (navigator.locks as unknown as { query: typeof realQuery }).query =
        realQuery;
    },
  };
}

/**
 * Hold this record's lock reading STALE for the surfaces' poll -- their only
 * reading of a run in another context -- until a click is dispatched, from which
 * moment the reading is true again.
 *
 * This is the gap a handler's click-time re-read exists for: the lock can be taken
 * between two poll readings, leaving a button enabled over a run already under way.
 */
export function stalePollUntilClick(id: string): () => void {
  const readings = filterLockFromReadings(id);
  // Capture phase, so it runs while the click is being dispatched and before the
  // handler React invokes on it: the button cannot be disabled out from under the
  // click, and everything the handler itself reads is the truth. Only a real
  // pointer's click counts -- the download dispatches reach the page as
  // `anchor.click()`, whose untrusted event is not the operator pressing a control.
  const revealOnClick = (event: Event) => {
    if (event.isTrusted) readings.reveal();
  };
  document.addEventListener("click", revealOnClick, { capture: true });
  return () => {
    document.removeEventListener("click", revealOnClick, { capture: true });
    readings.restore();
  };
}

/** Hold this record's run+rotate lock the way a second tab's run or the scheduled
 * runtime does, until the returned release is called. */
export async function holdRunLockElsewhere(id: string): Promise<() => void> {
  let release: () => void = () => undefined;
  const untilReleased = new Promise<void>((resolve) => {
    release = resolve;
  });
  await new Promise<void>((granted) => {
    void navigator.locks.request(managedExchangeLockName(id), () => {
      granted();
      return untilReleased;
    });
  });
  return release;
}
