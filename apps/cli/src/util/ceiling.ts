// The one shape a bounded wait takes in this command: race work the run does
// not control against a deadline, and report which way it ended. Two waits use
// it -- the transport's close (../transportTeardown) and the result CSV's
// drain to stdout (./dataIo) -- and each decides for itself what an expiry
// means, which is the part a shared race must not settle for them.

/** How a bounded wait ended. */
export interface CeilingOutcome {
  /** Whether the work settled inside the ceiling. */
  finished: boolean;
  /** Wall-clock the work was waited on, in whole milliseconds. */
  elapsedMs: number;
}

/**
 * Wait for `work` for at most `ceilingMs`, reporting which way it ended.
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
  work: () => Promise<unknown>,
): Promise<CeilingOutcome> {
  const startedAt = Date.now();
  let deadline: NodeJS.Timeout | undefined;
  const expired = new Promise<"expired">((resolve) => {
    deadline = setTimeout(() => resolve("expired"), ceilingMs);
  });
  // Held rather than rethrown from the rejection handler: the handler is what
  // keeps a rejection arriving after the expiry from going unhandled, so it
  // settles the race either way and the failure is raised below only when the
  // race was still waiting on it.
  let failure: { error: unknown } | undefined;
  try {
    const outcome = await Promise.race([
      work().then(
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
