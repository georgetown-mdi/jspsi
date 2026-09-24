import { expect, test } from "vitest";

import { TERMINAL_FRAME_DRAIN_TIMEOUT_MS } from "@alcove/core/testing";
import type { ConnectionConfig } from "@alcove/core";

import { DEFAULT_CLOSE_FLUSH_TIMEOUT_MS } from "../../src/connection/webrtc/webrtcMessageConnection";
import {
  TRANSPORT_TEARDOWN_CEILING_MS,
  closeWithinCeiling,
  teardownCeilingNotice,
  transportTeardownCeilingMs,
  type TeardownOutcome,
} from "../../src/transportTeardown";

/**
 * Every channel's declared ceiling and the budget beneath it that dominates
 * that channel's teardown. A channel added to {@link ConnectionConfig} without
 * a ceiling fails to compile against the `Record` the table is typed as; this
 * row is what holds the value ABOVE the budget it has to clear, which the type
 * cannot see. `webrtc`'s dominant term is the close drain, the file-based
 * channels' the terminal-frame drain; the smaller per-close bounds each
 * channel adds beneath those are covered by the same margin.
 */
const CHANNEL_CEILINGS: Array<{
  channel: ConnectionConfig["channel"];
  dominantBudgetMs: number;
}> = [
  { channel: "webrtc", dominantBudgetMs: DEFAULT_CLOSE_FLUSH_TIMEOUT_MS },
  { channel: "sftp", dominantBudgetMs: TERMINAL_FRAME_DRAIN_TIMEOUT_MS },
  { channel: "filedrop", dominantBudgetMs: TERMINAL_FRAME_DRAIN_TIMEOUT_MS },
];

test("every channel declares a ceiling, and none other does", () => {
  expect(Object.keys(TRANSPORT_TEARDOWN_CEILING_MS).sort()).toEqual(
    CHANNEL_CEILINGS.map(({ channel }) => channel).sort(),
  );
});

test.each(CHANNEL_CEILINGS)(
  "$channel's ceiling stands above its own teardown budget",
  ({ channel, dominantBudgetMs }) => {
    expect(transportTeardownCeilingMs(channel)).toBeGreaterThan(
      dominantBudgetMs,
    );
  },
);

test("a close that finishes inside the ceiling reports as finished", async () => {
  const outcome = await closeWithinCeiling(60_000, () => Promise.resolve());
  expect(outcome.finished).toBe(true);
  expect(outcome.heldBy).toEqual([]);
});

test("a close that throws raises past the ceiling rather than reporting finished", async () => {
  // Each layer close catches its own failure, so a throw reaching the ceiling
  // came from outside all of them -- a close that threw before its own catch
  // was attached -- and the run's cleanup has to see it rather than read the
  // teardown as done. Written without `async`, so what is measured is the
  // throw itself rather than a rejected promise.
  await expect(
    closeWithinCeiling(60_000, (): Promise<void> => {
      throw new Error("the session was already gone");
    }),
  ).rejects.toThrow("the session was already gone");
});

test("a close that never settles expires, naming what still holds the loop", async () => {
  // A ref'd timer is what this run is holding the loop with, so the report has
  // a kind to name; the close itself never resolves.
  const held = setTimeout(() => {}, 60_000);
  try {
    const outcome = await closeWithinCeiling(
      20,
      () => new Promise<void>(() => {}),
    );
    expect(outcome.finished).toBe(false);
    expect(outcome.elapsedMs).toBeGreaterThanOrEqual(20);
    expect(outcome.heldBy).toContain("Timeout");
  } finally {
    clearTimeout(held);
  }
});

test("a close rejecting after the ceiling does not raise an unhandled rejection", async () => {
  let failLate: ((err: Error) => void) | undefined;
  const outcome = await closeWithinCeiling(
    20,
    () =>
      new Promise<void>((_resolve, reject) => {
        failLate = reject;
      }),
  );
  expect(outcome.finished).toBe(false);
  failLate?.(new Error("the transport gave up after the run stopped waiting"));
  // A rejection absorbed inside closeWithinCeiling settles in a microtask; an
  // unabsorbed one would reach the runner's unhandled-rejection trap by the
  // time this turn ends.
  await new Promise((resolve) => setImmediate(resolve));
});

/** One expired teardown, the input every notice case below reads. */
const EXPIRED: TeardownOutcome = {
  finished: false,
  elapsedMs: 180_000,
  heldBy: ["TCPSocketWrap"],
};

test("the expiry notice states the wait, what held it, and that the status stands", () => {
  const notice = teardownCeilingNotice(EXPIRED, {
    channel: "filedrop",
    retainFiles: false,
    outputsWritten: true,
  });
  expect(notice).toContain("within 180s");
  expect(notice).toContain("still held by: TCPSocketWrap");
  expect(notice).toContain("exit status are unchanged");
});

test("a run whose output stage returned is told its files are on disk", () => {
  // The clause answers the question an abandoned close raises for a completed
  // run: whether anything it owed went with the wait it gave up on.
  const notice = teardownCeilingNotice(EXPIRED, {
    channel: "webrtc",
    retainFiles: false,
    outputsWritten: true,
  });
  expect(notice).toContain("everything it writes is already on disk");
});

test("a run whose output stage did not return claims nothing about disk", () => {
  // Cleanup also runs from the interrupt paths, from a failure in the exchange
  // itself, and from a failure inside the output stage -- a result file that
  // could not be written among them. None of those wrote the whole set, so
  // telling the operator it is on disk sends them looking for a file that is
  // not there.
  const notice = teardownCeilingNotice(EXPIRED, {
    channel: "webrtc",
    retainFiles: false,
    outputsWritten: false,
  });
  expect(notice).toContain("exit status are unchanged");
  expect(notice).not.toContain("on disk");
});

test("a delete-mode run is pointed at the files the abandoned close left", () => {
  // The close is what removes this party's own protocol files, so an expiry
  // leaves them in the shared directory for the operator to clear.
  const notice = teardownCeilingNotice(EXPIRED, {
    channel: "sftp",
    retainFiles: false,
    outputsWritten: true,
  });
  expect(notice).toContain("Check the exchange directory");
  expect(notice).toContain("remove any protocol files this run left there");
  expect(notice).toContain("--sweep-exchange-files");
});

test("a retain-mode run is not told to remove its own transcript", () => {
  // In retain mode the close deletes nothing (docs/spec/FILE_SYNC.md), so the
  // files in the directory are the transcript the operator configured the run
  // to keep, and the expiry leaves no deletion undone.
  const notice = teardownCeilingNotice(EXPIRED, {
    channel: "filedrop",
    retainFiles: true,
    outputsWritten: true,
  });
  expect(notice).toContain("exit status are unchanged");
  expect(notice).not.toContain("exchange directory");
  expect(notice).not.toContain("protocol files");
  expect(notice).not.toContain("--sweep-exchange-files");
});

test("a webrtc run, which has no protocol files, is told nothing about them", () => {
  const notice = teardownCeilingNotice(EXPIRED, {
    channel: "webrtc",
    retainFiles: false,
    outputsWritten: true,
  });
  expect(notice).toContain("exit status are unchanged");
  expect(notice).not.toContain("exchange directory");
});
