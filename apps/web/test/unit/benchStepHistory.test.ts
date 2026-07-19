import { describe, expect, test } from "vitest";

import {
  BENCH_STEP_STATE_KEY,
  benchStepState,
  benchStepStateForPush,
  stepFromPopState,
  unloadGuardArmed,
} from "@bench/stepHistory";

describe("bench step history state", () => {
  test("benchStepState tags an entry with the step", () => {
    const state = benchStepState("columns");
    expect(state[BENCH_STEP_STATE_KEY]).toBe("columns");
  });

  test("benchStepState preserves unrelated fields on the existing state", () => {
    const state = benchStepState("review", { scrollY: 120, other: "keep" });
    expect(state).toMatchObject({ scrollY: 120, other: "keep" });
    expect(state[BENCH_STEP_STATE_KEY]).toBe("review");
  });

  test("benchStepState keeps the router's index and key as-is (replace semantics)", () => {
    const state = benchStepState("file", {
      __TSR_index: 4,
      __TSR_key: "abc",
      key: "abc",
    });
    expect(state).toMatchObject({
      __TSR_index: 4,
      __TSR_key: "abc",
      key: "abc",
    });
  });

  test("benchStepState ignores a non-object existing state", () => {
    expect(benchStepState("file", null)).toEqual({
      [BENCH_STEP_STATE_KEY]: "file",
    });
    expect(benchStepState("file", "not-an-object")).toEqual({
      [BENCH_STEP_STATE_KEY]: "file",
    });
  });
});

describe("benchStepStateForPush", () => {
  // A pushed entry sits beside the router's own entries, so it must carry the
  // router's push bookkeeping: index advanced by one, a fresh entry key. The
  // router's patched history classifies a popstate as Back or Forward from the
  // index delta; a frozen index would read every in-bench pop as an in-place GO.
  test("advances the router index and mints a fresh entry key", () => {
    const state = benchStepStateForPush("columns", {
      __TSR_index: 4,
      __TSR_key: "abc",
      key: "abc",
    }) as unknown as Record<string, unknown>;
    expect(state[BENCH_STEP_STATE_KEY]).toBe("columns");
    expect(state.__TSR_index).toBe(5);
    expect(typeof state.__TSR_key).toBe("string");
    expect(state.__TSR_key).not.toBe("abc");
    expect(state.key).toBe(state.__TSR_key);
  });

  test("returns the marker state alone when no router index is present", () => {
    expect(benchStepStateForPush("columns")).toEqual({
      [BENCH_STEP_STATE_KEY]: "columns",
    });
    expect(benchStepStateForPush("columns", { scrollY: 7 })).toEqual({
      scrollY: 7,
      [BENCH_STEP_STATE_KEY]: "columns",
    });
  });

  test("preserves unrelated fields alongside the advanced index", () => {
    const state = benchStepStateForPush("review", {
      __TSR_index: 0,
      other: "keep",
    }) as unknown as Record<string, unknown>;
    expect(state.other).toBe("keep");
    expect(state.__TSR_index).toBe(1);
  });
});

describe("stepFromPopState", () => {
  // A Back-equivalent event carries the previous entry's bench state; the step
  // it names is the one the bench restores. A Forward-equivalent event is the
  // same shape at the next entry -- both round-trip through this reader.
  test("reads the step a bench entry carries", () => {
    const backTarget = benchStepState("file");
    expect(stepFromPopState(backTarget)).toBe("file");
    const forwardTarget = benchStepStateForPush("columns", backTarget);
    expect(stepFromPopState(forwardTarget)).toBe("columns");
  });

  test("returns undefined when the entry is not a bench entry", () => {
    // Back from the first bench step lands here (the pre-bench entry) or on an
    // unrelated route: the caller lets ordinary navigation proceed.
    expect(stepFromPopState(null)).toBeUndefined();
    expect(stepFromPopState(undefined)).toBeUndefined();
    expect(stepFromPopState({})).toBeUndefined();
    expect(stepFromPopState({ someOtherRoute: true })).toBeUndefined();
    expect(stepFromPopState({ [BENCH_STEP_STATE_KEY]: 42 })).toBeUndefined();
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

  test("disarmed while the loaded file is the synthetic sample", () => {
    expect(
      unloadGuardArmed({ hasFile: true, finalized: false, demoActive: true }),
    ).toBe(false);
    // A real file (demoActive false) re-arms it.
    expect(
      unloadGuardArmed({ hasFile: true, finalized: false, demoActive: false }),
    ).toBe(true);
  });

  test("armed while a console server-job exchange runs, though finalized", () => {
    // The invitation is minted (finalized), but the appliance's CLI child is still
    // conducting the exchange, so closing the tab strands it: the guard stays armed.
    expect(
      unloadGuardArmed({
        hasFile: true,
        finalized: true,
        consoleExchangeRunning: true,
      }),
    ).toBe(true);
  });

  test("disarmed once the console server-job exchange settles", () => {
    expect(
      unloadGuardArmed({
        hasFile: true,
        finalized: true,
        consoleExchangeRunning: false,
      }),
    ).toBe(false);
  });

  test("the synthetic sample stays disarmed even mid-run", () => {
    expect(
      unloadGuardArmed({
        hasFile: true,
        finalized: true,
        consoleExchangeRunning: true,
        demoActive: true,
      }),
    ).toBe(false);
  });
});
