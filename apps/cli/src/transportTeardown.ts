// The ceiling on closing a run's transport. Everything the exchange owes
// locally is awaited with no budget -- a wedged local write is the
// supervisor's kill budget to bound, not this one's -- so the transport's
// teardown is the single obligation a finished run stops waiting on, and this
// module holds how long it waits and what it reports when it stops.

import type { ConnectionConfig } from "@psilink/core";

import { heldResourceKinds } from "./util/exitGate";

/**
 * How long a run waits for its transport to finish closing, per channel.
 *
 * Each value sits above the sum of that channel's own documented teardown
 * budgets, so reaching it means a close overran every bound beneath it rather
 * than that this ceiling cut a legitimate wait short. A channel added to
 * {@link ConnectionConfig} declares its own value here or fails to compile.
 *
 * - `webrtc`: the close drain (5 min), the sentinel hand-off (2 s), the data
 *   channel's own close (2 s) and the ICE statistics read (2 s) sum to 306 s
 *   (docs/spec/WEBRTC_TRANSPORT.md, Budgets).
 * - `sftp` and `filedrop`: the terminal-frame drain (60 s,
 *   docs/spec/FILE_SYNC.md) and the connection close (30 s) sum to 90 s, with
 *   the SFTP adapter's own client-close, forced-close and deferred-cleanup
 *   drains (5 s, 1 s, 5 s) beneath them. Both file-based channels take one
 *   value: they close through the same `FileSyncConnection`, and the adapter's
 *   bounds are the smaller term.
 */
export const TRANSPORT_TEARDOWN_CEILING_MS: Record<
  ConnectionConfig["channel"],
  number
> = {
  webrtc: 6 * 60_000,
  sftp: 3 * 60_000,
  filedrop: 3 * 60_000,
};

/** The teardown ceiling for `channel`; see {@link TRANSPORT_TEARDOWN_CEILING_MS}. */
export function transportTeardownCeilingMs(
  channel: ConnectionConfig["channel"],
): number {
  return TRANSPORT_TEARDOWN_CEILING_MS[channel];
}

/** How a run's transport teardown ended. */
export interface TeardownOutcome {
  /** Whether the close finished inside its ceiling. */
  finished: boolean;
  /** Wall-clock the close was waited on, in whole milliseconds. */
  elapsedMs: number;
  /**
   * The resource kinds still holding the event loop when the ceiling was
   * reached; empty when the close finished.
   */
  heldBy: string[];
}

/**
 * Wait for `close` for at most `ceilingMs`, reporting which way it ended.
 *
 * On expiry the close is left running: it is the transport's own idempotent
 * teardown and may still complete, and nothing here can safely cancel it. Its
 * eventual rejection is absorbed rather than left to surface as an unhandled
 * rejection after the caller has moved on.
 *
 * The deadline timer is ref'd on purpose. A close that neither settles nor
 * holds the loop would otherwise let the process exit before the ceiling is
 * reached, and the run would report nothing about a teardown it abandoned.
 */
export async function closeWithinCeiling(
  ceilingMs: number,
  close: () => Promise<void>,
): Promise<TeardownOutcome> {
  const startedAt = Date.now();
  let deadline: NodeJS.Timeout | undefined;
  const expired = new Promise<"expired">((resolve) => {
    deadline = setTimeout(() => resolve("expired"), ceilingMs);
  });
  try {
    const outcome = await Promise.race([
      close().then(
        () => "closed" as const,
        () => "closed" as const,
      ),
      expired,
    ]);
    if (outcome === "closed")
      return { finished: true, elapsedMs: Date.now() - startedAt, heldBy: [] };
    return {
      finished: false,
      elapsedMs: Date.now() - startedAt,
      heldBy: heldResourceKinds(),
    };
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
  }
}

/**
 * The notice a run states -- on the operator log and on the machine-interface
 * stream -- when its transport did not finish closing inside the ceiling: how
 * long it waited and which resource kinds were still armed. The exit status is
 * the exchange's own outcome either way, which the second sentence says so an
 * unattended supervisor does not read the notice as a failure to retry.
 */
export function teardownCeilingNotice(outcome: TeardownOutcome): string {
  const held =
    outcome.heldBy.length === 0
      ? "something Node does not name"
      : outcome.heldBy.join(", ");
  return (
    `the transport did not finish closing within ` +
    `${Math.round(outcome.elapsedMs / 1000)}s, so this run stopped waiting ` +
    `on it; still held by: ${held}. The exchange's own outcome and exit ` +
    `status are unchanged, and everything it writes is already on disk.`
  );
}
