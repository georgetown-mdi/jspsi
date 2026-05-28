import { describe, expect, test, vi } from "vitest";

import { EventHandlerQueue } from "../src/connection/eventHandlerQueue";

describe("EventHandlerQueue", () => {
  test("runs handlers in order, one per event, then no-ops", () => {
    const calls: Array<number> = [];
    const queue = new EventHandlerQueue([
      () => {
        calls.push(1);
      },
      () => {
        calls.push(2);
      },
    ]);

    queue.handleEvent();
    queue.handleEvent();
    queue.handleEvent();

    expect(calls).toEqual([1, 2]);
  });

  test("routes a synchronous handler throw to onError", () => {
    const onError = vi.fn();
    const queue = new EventHandlerQueue(
      [
        () => {
          throw new Error("sync boom");
        },
      ],
      onError,
    );

    queue.handleEvent();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
    expect((onError.mock.calls[0][0] as Error).message).toBe("sync boom");
  });

  test("routes an asynchronous handler rejection to onError", async () => {
    const onError = vi.fn();
    const queue = new EventHandlerQueue(
      [
        async () => {
          throw new Error("async boom");
        },
      ],
      onError,
    );

    queue.handleEvent();
    await Promise.resolve();
    await Promise.resolve();

    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0][0] as Error).message).toBe("async boom");
  });

  test("does not call onError when a handler resolves normally", async () => {
    const onError = vi.fn();
    const queue = new EventHandlerQueue(
      [
        async () => {
          /* resolves */
        },
      ],
      onError,
    );

    queue.handleEvent();
    await Promise.resolve();
    await Promise.resolve();

    expect(onError).not.toHaveBeenCalled();
  });
});
