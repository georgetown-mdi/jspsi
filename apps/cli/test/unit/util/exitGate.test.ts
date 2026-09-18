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
