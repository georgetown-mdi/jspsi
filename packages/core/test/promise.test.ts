import { describe, expect, test, vi } from "vitest";

import { TimeoutError, withTimeout, retryPromise } from "../src/utils/promise";

describe("TimeoutError", () => {
  test("is an Error subclass carrying the message and a stable name", () => {
    const err = new TimeoutError("boom");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(TimeoutError);
    // The name is the brand the LocalFSClient.connect retry predicate falls
    // back to when a dual-package split would defeat instanceof; pin it.
    expect(err.name).toBe("TimeoutError");
    expect(err.message).toBe("boom");
  });
});

describe("withTimeout", () => {
  test("resolves with the operation's value when it settles first", async () => {
    await expect(
      withTimeout(Promise.resolve(42), 1_000, "deadline"),
    ).resolves.toBe(42);
  });

  test("propagates the operation's own rejection unchanged when the deadline does not fire", async () => {
    const original = new Error("real failure");
    // The loser of the race is the deadline; the rejection that surfaces is the
    // operation's own error, NOT a TimeoutError -- this is what lets a caller's
    // shouldRetry predicate distinguish a transient failure from a deadline.
    await expect(
      withTimeout(Promise.reject(original), 1_000, "deadline"),
    ).rejects.toBe(original);
  });

  test("rejects with a TimeoutError carrying the message when the deadline fires first", async () => {
    vi.useFakeTimers();
    try {
      // Never settles, so only the deadline can resolve the race.
      const caught = withTimeout(
        new Promise(() => {}),
        5_000,
        "timed out waiting",
      ).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(5_000);
      const err = await caught;
      expect(err).toBeInstanceOf(TimeoutError);
      expect((err as TimeoutError).message).toBe("timed out waiting");
    } finally {
      vi.useRealTimers();
    }
  });

  test("clears its deadline timer once the operation settles", async () => {
    vi.useFakeTimers();
    try {
      await withTimeout(Promise.resolve("ok"), 10_000, "deadline");
      // The .finally(clearTimeout) must have run; a lingering timer would keep
      // the process alive past a resolved operation.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("retryPromise", () => {
  test("resolves on the first success without retrying", async () => {
    let calls = 0;
    const result = await retryPromise(
      () => {
        calls++;
        return Promise.resolve("done");
      },
      3,
      1_000,
    );
    expect(result).toBe("done");
    expect(calls).toBe(1);
  });

  test("retries up to the budget and resolves on eventual success", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const p = retryPromise(
        () => {
          calls++;
          return calls < 3
            ? Promise.reject(new Error("transient"))
            : Promise.resolve("ok");
        },
        3,
        1_000,
      );
      const assertion = expect(p).resolves.toBe("ok");
      // Two 1s retry delays; the third attempt succeeds.
      await vi.advanceTimersByTimeAsync(2_000);
      await assertion;
      expect(calls).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test("rejects with the last error after exhausting the retry budget", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const p = retryPromise(
        () => {
          calls++;
          return Promise.reject(new Error(`fail ${calls}`));
        },
        2,
        1_000,
      );
      const assertion = expect(p).rejects.toThrow("fail 3");
      // Initial attempt plus two retries, 1s apart.
      await vi.advanceTimersByTimeAsync(2_000);
      await assertion;
      expect(calls).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not retry an error its shouldRetry predicate rejects", async () => {
    let calls = 0;
    const terminal = new Error("terminal");
    await expect(
      retryPromise(
        () => {
          calls++;
          return Promise.reject(terminal);
        },
        3,
        1_000,
        (err) => err !== terminal,
      ),
    ).rejects.toBe(terminal);
    // A non-retryable error rejects at once, consuming no retry.
    expect(calls).toBe(1);
  });
});

describe("withTimeout + retryPromise composition", () => {
  test("a timeout is terminal when shouldRetry excludes TimeoutError", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      // The pattern LocalFSClient.connect uses: a per-attempt deadline whose
      // expiry must NOT be retried (retrying a hung probe only strands another
      // worker), while non-timeout errors would still retry.
      const p = retryPromise(
        () => {
          calls++;
          return withTimeout(new Promise(() => {}), 5_000, "timed out");
        },
        3,
        1_000,
        (err) => !(err instanceof TimeoutError),
      );
      const assertion = expect(p).rejects.toBeInstanceOf(TimeoutError);
      // Past the first deadline and well past several retry-delay windows: a
      // terminal timeout must schedule no further attempt.
      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;
      expect(calls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
