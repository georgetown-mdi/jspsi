import fs from "node:fs";

import { vi } from "vitest";

import {
  EVENT_STREAM_FD,
  openEventStream,
  type EventStreamEmitter,
} from "../src/eventStream";

/**
 * Acquire the machine-interface emitter the way every caller does, through
 * {@link openEventStream}, with fd 3 mocked as wired so its fail-closed
 * preflight passes in a test process that does not own the descriptor. The
 * emitter factory and its writer are module-private, so this is the only
 * route to one.
 *
 * Only fd 3 is answered from the mock; every other descriptor passes through
 * to the real `fstatSync`. The caller restores the spy (`vi.restoreAllMocks`
 * in an `afterEach`, or the mock's own `mockRestore`).
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

/**
 * Run `body` with fd 3 captured, returning what it resolved with alongside the
 * events written there, parsed one per line. `fstatSync` answers for fd 3 so the
 * fail-closed preflight passes, and `writeSync` diverts fd 3 into the buffer --
 * the descriptor is never written for real, since the test process does not own
 * it -- while every other descriptor passes through to the real implementation.
 * @internal test-only
 */
export async function captureFd3<T>(
  body: () => Promise<T>,
): Promise<{ value: T; lines: Array<Record<string, unknown>> }> {
  const chunks: Buffer[] = [];
  const realWriteSync = fs.writeSync;
  const realFstatSync = fs.fstatSync;
  vi.spyOn(fs, "fstatSync").mockImplementation(((
    fd: number,
    ...rest: unknown[]
  ) => {
    if (fd === EVENT_STREAM_FD) return {} as fs.Stats;
    return (realFstatSync as (...a: unknown[]) => fs.Stats)(fd, ...rest);
  }) as typeof fs.fstatSync);
  vi.spyOn(fs, "writeSync").mockImplementation(((
    fd: number,
    ...args: unknown[]
  ) => {
    if (fd === EVENT_STREAM_FD) {
      const [buffer, offset, length] = args as [Buffer, number, number];
      chunks.push(Buffer.from(buffer.subarray(offset, offset + length)));
      return length;
    }
    return (realWriteSync as (...a: unknown[]) => number)(fd, ...args);
  }) as typeof fs.writeSync);
  try {
    const value = await body();
    return {
      value,
      lines: Buffer.concat(chunks)
        .toString("utf8")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    };
  } finally {
    vi.mocked(fs.writeSync).mockRestore();
    vi.mocked(fs.fstatSync).mockRestore();
  }
}
