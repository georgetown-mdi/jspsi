import { expect, test, vi } from "vitest";

import { settleWithinCeiling } from "../../../src/util/ceiling";

/**
 * The bounded wait both of a finished run's ceilings are built on: the
 * transport's close and the result's drain to stdout. What each caller does
 * with an expiry is its own -- the close reports it and carries on, the drain
 * raises it -- and what is checked here is that the three outcomes it can have
 * are never handed back as one another: settled, expired, and failed.
 */

test("work that settles inside the ceiling reports finished", async () => {
  const outcome = await settleWithinCeiling(
    5_000,
    () => new Promise<void>((resolve) => setTimeout(resolve, 5)),
  );
  expect(outcome.finished).toBe(true);
  expect(outcome.elapsedMs).toBeLessThan(5_000);
});

test("work that outlives the ceiling reports expired rather than finished", async () => {
  let release: (() => void) | undefined;
  const outcome = await settleWithinCeiling(
    20,
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  expect(outcome.finished).toBe(false);
  expect(outcome.elapsedMs).toBeGreaterThanOrEqual(20);
  release?.();
});

test("work that rejects inside the ceiling raises rather than reporting finished", async () => {
  // A failure and an expiry are different outcomes, and mapping the first onto
  // the second reports work that threw as work that finished.
  await expect(
    settleWithinCeiling(5_000, () =>
      Promise.reject(new Error("the work failed")),
    ),
  ).rejects.toThrow("the work failed");
});

test("work that throws before it returns a promise raises the same way", async () => {
  // The shape a teardown takes: a close that throws on the way in, outside any
  // catch of its own, so the race is handed a throw rather than a rejected
  // promise. Written without `async`, which would turn the throw into one.
  await expect(
    settleWithinCeiling(5_000, (): Promise<void> => {
      throw new Error("close() threw before it awaited anything");
    }),
  ).rejects.toThrow("close() threw before it awaited anything");
});

test("a rejection after the ceiling is absorbed rather than left unhandled", async () => {
  // The caller has moved on by then, so an expiry must not turn into an
  // unhandled rejection that takes the process down behind it.
  const unhandled = vi.fn();
  process.on("unhandledRejection", unhandled);
  try {
    let fail: ((err: Error) => void) | undefined;
    const outcome = await settleWithinCeiling(
      20,
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        }),
    );
    expect(outcome.finished).toBe(false);
    fail?.(new Error("the close failed after the ceiling"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(unhandled).not.toHaveBeenCalled();
  } finally {
    process.off("unhandledRejection", unhandled);
  }
});

test("the deadline is cleared once the work settles", async () => {
  // A ref'd timer left armed would hold the event loop for its whole ceiling
  // after the wait it was guarding is over -- the opposite of what the run
  // arms it for.
  const cleared = vi.spyOn(globalThis, "clearTimeout");
  try {
    await settleWithinCeiling(60_000, () => Promise.resolve());
    expect(cleared).toHaveBeenCalled();
  } finally {
    cleared.mockRestore();
  }
});
