import fs from "node:fs";

import { vi } from "vitest";

import {
  EVENT_STREAM_FD,
  openEventStream,
  type EventStreamEmitter,
} from "../src/eventStream";

/**
 * Acquire the machine-interface emitter the way every caller does -- through
 * {@link openEventStream}, which fuses the fail-closed fd-3 preflight to the
 * construction -- with fd 3 mocked as wired so the preflight passes in a test
 * process that does not own the descriptor. The emitter factory and its writer
 * are module-private, so this is the only route to one; a test that wants the
 * writer's behavior drives it through the emitter's methods.
 *
 * Only fd 3 is answered from the mock: every other descriptor passes through to
 * the real `fstatSync`, so a test that stats a real file alongside this still
 * gets the truth. The caller restores the spy (`vi.restoreAllMocks` in an
 * `afterEach`, or the mock's own `mockRestore`).
 * @internal test-only
 */
export function openEventStreamWithFdWired(): EventStreamEmitter {
  const realFstatSync = fs.fstatSync;
  vi.spyOn(fs, "fstatSync").mockImplementation(((
    fd: number,
    ...rest: unknown[]
  ) => {
    if (fd === EVENT_STREAM_FD) return {} as fs.Stats;
    return (realFstatSync as (...a: unknown[]) => fs.Stats)(fd, ...rest);
  }) as typeof fs.fstatSync);
  const emitter = openEventStream(true);
  if (emitter === undefined)
    throw new Error(
      "openEventStream returned no emitter for an enabled stream",
    );
  return emitter;
}
