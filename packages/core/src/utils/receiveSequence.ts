import { EventHandlerQueue } from "../connection/eventHandlerQueue";

import type { Connection } from "../types";

// Coarse backstop for each PSI exchange phase: if no message arrives within
// this window the peer is treated as gone. The timer is reset on every received
// message so a long but steadily-progressing exchange is not cut off, and the
// window is generous so per-message crypto on large datasets does not trip it.
const PSI_INACTIVITY_TIMEOUT_MS = 120_000;

/**
 * Runs `handlers` in order, one per received `data` event, resolving once the
 * final handler completes. Rejects if `conn` emits `error`, if a handler throws
 * or rejects (e.g. a send to a peer that has dropped), if a transport error was
 * buffered before the phase began, or if no message arrives for
 * {@link PSI_INACTIVITY_TIMEOUT_MS}. `initialSend`, when provided, runs after
 * the listeners are registered (the starter uses it to send its setup message)
 * and its failure rejects the phase. The data/error listeners and the timer are
 * always torn down on settle, so nothing outlives the phase.
 *
 * @internal
 */
export function runReceiveSequence(
  conn: Connection,
  handlers: Array<(rawData: unknown) => void | Promise<void>>,
  initialSend?: () => void | Promise<void>,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;

    const cleanup = () => {
      clearTimeout(timer);
      conn.removeListener("data", dataListener);
      conn.removeListener("error", onError, undefined, true);
    };
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const fail = (err: unknown) =>
      settle(() => reject(err instanceof Error ? err : new Error(String(err))));
    const succeed = () => settle(resolve);
    const onError = (err: unknown) => fail(err);
    const resetTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () => fail(new Error("PSI exchange timed out")),
        PSI_INACTIVITY_TIMEOUT_MS,
      );
    };

    const queue = new EventHandlerQueue(handlers, fail, succeed);
    const dataListener = (rawData: unknown) => {
      queue.handleEvent(rawData);
      resetTimer();
    };

    resetTimer();
    conn.once("error", onError);
    conn.on("data", dataListener);

    const buffered = conn.takeBufferedError();
    if (buffered !== undefined) {
      fail(buffered);
      return;
    }

    if (initialSend !== undefined) {
      let sendResult: void | Promise<void>;
      try {
        sendResult = initialSend();
      } catch (err) {
        fail(err);
        return;
      }
      Promise.resolve(sendResult).then(
        () => { if (handlers.length === 0) succeed(); },
        fail,
      );
    } else if (handlers.length === 0) {
      succeed();
    }
  });
}
