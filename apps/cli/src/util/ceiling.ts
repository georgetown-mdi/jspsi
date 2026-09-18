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
 * in, and a later rejection is absorbed rather than surfacing as an unhandled
 * rejection once the caller has moved on. A rejection INSIDE the ceiling also
 * reports `finished`: the wait is over, and what the work's own failure means
 * is the caller's to read from the work itself.
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
  try {
    const outcome = await Promise.race([
      work().then(
        () => "settled" as const,
        () => "settled" as const,
      ),
      expired,
    ]);
    return {
      finished: outcome === "settled",
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
  }
}
