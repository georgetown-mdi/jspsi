// The ceiling on closing a run's transport: how long a finished run waits for
// it and what it reports when it stops. Every local artifact the exchange owes
// a path is awaited with no budget -- a wedged write to disk is the
// supervisor's kill budget to bound, not this one's -- so what a finished run
// bounds is the close here and, where the result goes to stdout instead of a
// path, the drain that hands it to the reader (util/dataIo).

import type { ConnectionConfig } from "@psilink/core";

import { settleWithinCeiling, type CeilingOutcome } from "./util/ceiling";
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
export interface TeardownOutcome extends CeilingOutcome {
  /**
   * The resource kinds still holding the event loop when the ceiling was
   * reached; empty when the close finished.
   */
  heldBy: string[];
}

/**
 * Wait for `close` for at most `ceilingMs`, reporting which way it ended and,
 * where it did not finish, what was still holding the event loop.
 *
 * The race itself, and what it does with a close that outlives the ceiling, is
 * {@link settleWithinCeiling}. An expiry here is housekeeping the run reports
 * and carries on from ({@link teardownCeilingNotice}), not a failure: the
 * exchange and everything it owed are already finished when this is called.
 *
 * A close that rejects inside the ceiling is raised to the caller rather than
 * reported. Each layer's close catches its own failure, so a rejection that
 * reaches here came from outside any of them and belongs on the run's own
 * failure channel.
 */
export async function closeWithinCeiling(
  ceilingMs: number,
  close: () => Promise<void>,
): Promise<TeardownOutcome> {
  const outcome = await settleWithinCeiling(ceilingMs, close);
  return { ...outcome, heldBy: outcome.finished ? [] : heldResourceKinds() };
}

/** What a run had done, and was set to do, with the files a close touches. */
export interface ExchangeFileDisposition {
  /** The run's channel; only the file-based ones have protocol files at all. */
  channel: ConnectionConfig["channel"];
  /** Whether the run keeps those files as a transcript instead of deleting them. */
  retainFiles: boolean;
  /**
   * Whether the output stage returned with the result, the exchange record,
   * the receipt and the caller's own post-exchange writes all on disk. A run
   * that never reached that stage -- an interrupt, or a failure in the
   * exchange itself -- a run that failed inside it, and a run that lost one of
   * those artifacts non-fatally all leave this false, since none of them wrote
   * the whole set the notice would otherwise account for.
   */
  outputsWritten: boolean;
}

/**
 * The notice a run states on the operator log when its transport did not
 * finish closing inside the ceiling: how long it waited and which resource
 * kinds were still armed. The exit status is the exchange's own outcome either
 * way, which the second sentence says so an unattended supervisor does not
 * read the notice as a failure to retry. The teardown runs after the run's
 * terminal event, so this text reaches the operator alone and never the
 * machine-interface stream.
 *
 * The on-disk half of that second sentence is stated only by a run whose
 * output stage returned with every artifact it owed written. `doCleanup` also
 * runs from the interrupt paths, from a failure ahead of that stage, from a
 * failure inside it -- a result file that could not be written among them --
 * and from a run that lost the exchange record or the receipt non-fatally, and
 * telling the operator everything the run writes is on disk would name
 * artifacts they will not find.
 *
 * A run deleting its protocol files gets one more sentence, naming the one
 * thing the abandoned close leaves for the operator: on the file channels that
 * close is what removes this party's own files from the shared directory
 * (docs/spec/FILE_SYNC.md, `responsibleFiles`), so an expired teardown can
 * leave them there. A retain-mode run's close removes nothing, and those files
 * are the transcript it was set to keep, so it is told nothing about them.
 */
export function teardownCeilingNotice(
  outcome: TeardownOutcome,
  files: ExchangeFileDisposition,
): string {
  const held =
    outcome.heldBy.length === 0
      ? "something Node does not name"
      : outcome.heldBy.join(", ");
  const leftBehind =
    files.channel === "webrtc" || files.retainFiles
      ? ""
      : ` Check the exchange directory and remove any protocol files this run ` +
        `left there; deleting them is the part of the close that did not ` +
        `finish, and passing --sweep-exchange-files to the next run removes ` +
        `them before it meets the partner.`;
  const onDisk = files.outputsWritten
    ? `, and everything it writes is already on disk`
    : "";
  return (
    `the transport did not finish closing within ` +
    `${Math.round(outcome.elapsedMs / 1000)}s, so this run stopped waiting ` +
    `on it; still held by: ${held}. The exchange's own outcome and exit ` +
    `status are unchanged${onDisk}.` +
    leftBehind
  );
}
