// The one shape a bounded wait takes in this command: race work the run does
// not control against an idle deadline, and report which way it ended. Two
// waits use it -- the transport's close (../transportTeardown) and the result
// CSV's drain to stdout (./dataIo) -- and each decides for itself what an
// expiry means, which is the part a shared race must not settle for them.

/** How a bounded wait ended. */
export interface CeilingOutcome {
  /** Whether the work settled inside the ceiling. */
  finished: boolean;
  /** Wall-clock the work was waited on, in whole milliseconds. */
  elapsedMs: number;
}

/**
 * Wait for `work` until it settles or goes `ceilingMs` without progress,
 * reporting which way it ended.
 *
 * The ceiling is an IDLE deadline, not a budget for the whole wait: `work` is
 * handed a `noteProgress` callback and every call restarts it, so what expires
 * is work that stopped moving rather than work that took a long time. Work
 * that reports no progress at all is bounded by its total duration, the same
 * rule with a single idle interval in it -- which is how the transport's close
 * takes it, having nothing to report between starting and finishing, where the
 * result drain reports each time the reader takes what was buffered and so
 * fails only a reader that stopped taking it.
 *
 * On expiry `work` is left running: the caller cannot cancel what it handed
 * in, and a later rejection is absorbed rather than raising an unhandled
 * rejection once the caller has moved on. A rejection INSIDE the ceiling is
 * raised to the caller instead of reported: the wait ending and the work
 * failing are different outcomes, and a race that returned the second as the
 * first would report a close that threw, or a write that was refused, as
 * finished.
 *
 * The deadline timer is ref'd on purpose. Work that neither settles nor holds
 * the event loop would otherwise let the process exit before the ceiling is
 * reached, and the run would report nothing about a wait it abandoned.
 */
export async function settleWithinCeiling(
  ceilingMs: number,
  work: (noteProgress: () => void) => Promise<unknown>,
): Promise<CeilingOutcome> {
  const startedAt = Date.now();
  let lastProgressAt = startedAt;
  let deadline: NodeJS.Timeout | undefined;
  // One timer re-armed for what the last report left of the ceiling, rather
  // than a timer cleared and replaced on every report: a report is then a bare
  // timestamp, and work that reports often pays nothing for reporting.
  const expired = new Promise<"expired">((resolve) => {
    const check = (): void => {
      const idleMs = Date.now() - lastProgressAt;
      if (idleMs >= ceilingMs) resolve("expired");
      else deadline = setTimeout(check, ceilingMs - idleMs);
    };
    deadline = setTimeout(check, ceilingMs);
  });
  const noteProgress = (): void => {
    lastProgressAt = Date.now();
  };
  // Held rather than rethrown from the rejection handler: the handler is what
  // keeps a rejection arriving after the expiry from going unhandled, so it
  // settles the race either way and the failure is raised below only when the
  // race was still waiting on it.
  let failure: { error: unknown } | undefined;
  try {
    const outcome = await Promise.race([
      work(noteProgress).then(
        () => "settled" as const,
        (err: unknown) => {
          failure = { error: err };
          return "settled" as const;
        },
      ),
      expired,
    ]);
    if (outcome === "settled" && failure !== undefined) throw failure.error;
    return {
      finished: outcome === "settled",
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
  }
}
