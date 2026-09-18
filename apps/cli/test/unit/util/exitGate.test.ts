import fs from "node:fs";

import { afterEach, expect, test, vi } from "vitest";

import {
  PROCESS_RETURN_BUDGET_MS,
  heldResourceKinds,
  processHeldNotice,
} from "../../../src/util/exitGate";

afterEach(() => {
  vi.restoreAllMocks();
});

test("the notice states the wait in seconds and the kinds that held the loop", () => {
  const notice = processHeldNotice(3_000, ["TCPSocketWrap", "Timeout"]);
  expect(notice).toContain("3s later by: TCPSocketWrap, Timeout");
  // The exit status is the exchange's own, so the line says as much rather
  // than leaving a supervisor's operator to read it as a failed run.
  expect(notice).toContain("Exiting with the run's own status");
});

test("a loop held by something Node does not name still reads as a sentence", () => {
  const notice = processHeldNotice(PROCESS_RETURN_BUDGET_MS, []);
  expect(notice).toContain("by: something Node does not name.");
});

test("the resource kinds are deduplicated and ordered", () => {
  vi.spyOn(process, "getActiveResourcesInfo").mockReturnValue([
    "Timeout",
    "PipeWrap",
    "Timeout",
    "FSReqCallback",
  ]);
  expect(heldResourceKinds()).toEqual(["FSReqCallback", "PipeWrap", "Timeout"]);
});

/**
 * A fresh copy of the gate module. Whether a signal handler owns the exit is
 * module state that is never given back -- the process it describes is ending
 * -- so a case that sets it runs against its own copy.
 */
async function freshGate(): Promise<
  typeof import("../../../src/util/exitGate")
> {
  vi.resetModules();
  return import("../../../src/util/exitGate");
}

/** Hold the gate's own writes off the suite's stderr, and report them. */
function captureStderr(): { lines: () => string[] } {
  const written: string[] = [];
  const real = fs.writeSync;
  vi.spyOn(fs, "writeSync").mockImplementation(((
    fd: number,
    ...args: unknown[]
  ) => {
    if (fd !== 2) return (real as (...a: unknown[]) => number)(fd, ...args);
    const buf = args[0] as Buffer;
    written.push(buf.toString("utf8"));
    return buf.length;
  }) as typeof fs.writeSync);
  return { lines: () => written };
}

test("the gate exits with the status the run resolved, passed explicitly", async () => {
  // A bare process.exit() reports process.exitCode, which is undefined on a
  // run whose handler is still on its way to an exit of its own: the status
  // the gate ends on has to be the one it read.
  const gate = await freshGate();
  const stderr = captureStderr();
  const exit = vi.spyOn(process, "exit").mockReturnValue(undefined as never);
  const before = process.exitCode;
  process.exitCode = 73;
  try {
    gate.armProcessReturnGate(5);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(73));
  } finally {
    process.exitCode = before;
  }
  expect(stderr.lines().join("")).toContain("still held open");
});

test("a run with no status of its own returns 0 rather than undefined", async () => {
  const gate = await freshGate();
  captureStderr();
  const exit = vi.spyOn(process, "exit").mockReturnValue(undefined as never);
  const before = process.exitCode;
  process.exitCode = undefined;
  try {
    gate.armProcessReturnGate(5);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  } finally {
    process.exitCode = before;
  }
});

test("a signal handler that owns the exit keeps the gate from arming", async () => {
  // The interrupt's teardown outlasts the budget, and the command promise has
  // already settled: a gate armed over it would end the run at the gate's
  // status and say the run finished and wrote its files.
  const gate = await freshGate();
  const stderr = captureStderr();
  const exit = vi.spyOn(process, "exit").mockReturnValue(undefined as never);
  gate.noteSignalOwnsExit();
  gate.armProcessReturnGate(5);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(exit).not.toHaveBeenCalled();
  expect(stderr.lines()).toEqual([]);
});

test("a signal taken after the gate is armed still stops it", async () => {
  const gate = await freshGate();
  const stderr = captureStderr();
  const exit = vi.spyOn(process, "exit").mockReturnValue(undefined as never);
  gate.armProcessReturnGate(20);
  gate.noteSignalOwnsExit();
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(exit).not.toHaveBeenCalled();
  expect(stderr.lines()).toEqual([]);
});
