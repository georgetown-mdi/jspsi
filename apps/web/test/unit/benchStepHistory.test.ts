import { describe, expect, test } from "vitest";

import {
  BENCH_STEP_STATE_KEY,
  benchStepState,
  depthFromState,
  stepFromPopState,
  unloadGuardArmed,
} from "@bench/stepHistory";

describe("bench step history state", () => {
  test("benchStepState tags an entry with the step and depth", () => {
    const state = benchStepState("columns", 2);
    expect(state[BENCH_STEP_STATE_KEY]).toEqual({ step: "columns", depth: 2 });
  });

  test("benchStepState preserves unrelated fields on the existing state", () => {
    const state = benchStepState("review", 3, { scrollY: 120, other: "keep" });
    expect(state).toMatchObject({ scrollY: 120, other: "keep" });
    expect(state[BENCH_STEP_STATE_KEY]).toEqual({ step: "review", depth: 3 });
  });

  test("benchStepState ignores a non-object existing state", () => {
    expect(benchStepState("file", 1, null)).toEqual({
      [BENCH_STEP_STATE_KEY]: { step: "file", depth: 1 },
    });
    expect(benchStepState("file", 1, "not-an-object")).toEqual({
      [BENCH_STEP_STATE_KEY]: { step: "file", depth: 1 },
    });
  });
});

describe("stepFromPopState", () => {
  // A Back-equivalent event carries the previous entry's bench state; the step
  // it names is the one the bench restores. A Forward-equivalent event is the
  // same shape at the next entry -- both round-trip through this reader.
  test("reads the step a bench entry carries", () => {
    const backTarget = benchStepState("file", 1);
    expect(stepFromPopState(backTarget)).toBe("file");
    const forwardTarget = benchStepState("columns", 2);
    expect(stepFromPopState(forwardTarget)).toBe("columns");
  });

  test("returns undefined when the entry is not a bench entry", () => {
    // Back from the first bench step lands here (the pre-bench entry) or on an
    // unrelated route: the caller lets ordinary navigation proceed.
    expect(stepFromPopState(null)).toBeUndefined();
    expect(stepFromPopState(undefined)).toBeUndefined();
    expect(stepFromPopState({})).toBeUndefined();
    expect(stepFromPopState({ someOtherRoute: true })).toBeUndefined();
    expect(
      stepFromPopState({ [BENCH_STEP_STATE_KEY]: { depth: 2 } }),
    ).toBeUndefined();
  });
});

describe("depthFromState", () => {
  // A smaller depth than the bench's cursor is a Back, a larger one a Forward;
  // the reader lets the caller tell them apart without its own counter.
  test("reads the depth a bench entry carries", () => {
    expect(depthFromState(benchStepState("columns", 2))).toBe(2);
    expect(depthFromState(benchStepState("file", 1))).toBe(1);
  });

  test("returns undefined for a non-bench entry", () => {
    expect(depthFromState(null)).toBeUndefined();
    expect(depthFromState({ other: 1 })).toBeUndefined();
    expect(
      depthFromState({ [BENCH_STEP_STATE_KEY]: { step: "columns" } }),
    ).toBeUndefined();
  });
});

describe("unloadGuardArmed", () => {
  test("armed only while a file is loaded and the exchange is not finalized", () => {
    expect(unloadGuardArmed({ hasFile: true, finalized: false })).toBe(true);
  });

  test("disarmed before a file is loaded", () => {
    expect(unloadGuardArmed({ hasFile: false, finalized: false })).toBe(false);
  });

  test("disarmed once the exchange is created or sent", () => {
    expect(unloadGuardArmed({ hasFile: true, finalized: true })).toBe(false);
    expect(unloadGuardArmed({ hasFile: false, finalized: true })).toBe(false);
  });
});
