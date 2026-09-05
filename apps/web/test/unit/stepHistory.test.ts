import { describe, expect, test } from "vitest";

import {
  STEP_STATE_KEY,
  stepFromPopState,
  stepHistoryState,
  stepHistoryStateForPush,
  unloadGuardArmed,
} from "@exchange/stepHistory";

describe("exchange step history state", () => {
  test("stepHistoryState tags an entry with the step", () => {
    const state = stepHistoryState("columns");
    expect(state[STEP_STATE_KEY]).toBe("columns");
  });

  test("stepHistoryState preserves unrelated fields on the existing state", () => {
    const state = stepHistoryState("review", { scrollY: 120, other: "keep" });
    expect(state).toMatchObject({ scrollY: 120, other: "keep" });
    expect(state[STEP_STATE_KEY]).toBe("review");
  });

  test("stepHistoryState keeps the router's index and key as-is (replace semantics)", () => {
    const state = stepHistoryState("file", {
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

  test("stepHistoryState ignores a non-object existing state", () => {
    expect(stepHistoryState("file", null)).toEqual({
      [STEP_STATE_KEY]: "file",
    });
    expect(stepHistoryState("file", "not-an-object")).toEqual({
      [STEP_STATE_KEY]: "file",
    });
  });
});

describe("stepHistoryStateForPush", () => {
  // A pushed entry sits beside the router's own entries, so it must hold the
  // router's push bookkeeping: index advanced by one, a fresh entry key. The
  // router's patched history classifies a popstate as Back or Forward from the
  // index delta; a frozen index would read every in-screen pop as an in-place GO.
  test("advances the router index and mints a fresh entry key", () => {
    const state = stepHistoryStateForPush("columns", {
      __TSR_index: 4,
      __TSR_key: "abc",
      key: "abc",
    }) as unknown as Record<string, unknown>;
    expect(state[STEP_STATE_KEY]).toBe("columns");
    expect(state.__TSR_index).toBe(5);
    expect(typeof state.__TSR_key).toBe("string");
    expect(state.__TSR_key).not.toBe("abc");
    expect(state.key).toBe(state.__TSR_key);
  });

  test("returns the marker state alone when no router index is present", () => {
    expect(stepHistoryStateForPush("columns")).toEqual({
      [STEP_STATE_KEY]: "columns",
    });
    expect(stepHistoryStateForPush("columns", { scrollY: 7 })).toEqual({
      scrollY: 7,
      [STEP_STATE_KEY]: "columns",
    });
  });

  test("preserves unrelated fields alongside the advanced index", () => {
    const state = stepHistoryStateForPush("review", {
      __TSR_index: 0,
      other: "keep",
    }) as unknown as Record<string, unknown>;
    expect(state.other).toBe("keep");
    expect(state.__TSR_index).toBe(1);
  });
});

describe("stepFromPopState", () => {
  // A Back-equivalent event holds the previous entry's step state; the step
  // it names is the one the screen restores. A Forward-equivalent event is the
  // same shape at the next entry -- both round-trip through this reader.
  test("reads the step a step entry holds", () => {
    const backTarget = stepHistoryState("file");
    expect(stepFromPopState(backTarget)).toBe("file");
    const forwardTarget = stepHistoryStateForPush("columns", backTarget);
    expect(stepFromPopState(forwardTarget)).toBe("columns");
  });

  test("returns undefined when the entry is not a step entry", () => {
    // Back from the first step lands here (the pre-step entry) or on an
    // unrelated route: the caller lets ordinary navigation proceed.
    expect(stepFromPopState(null)).toBeUndefined();
    expect(stepFromPopState(undefined)).toBeUndefined();
    expect(stepFromPopState({})).toBeUndefined();
    expect(stepFromPopState({ someOtherRoute: true })).toBeUndefined();
    expect(stepFromPopState({ [STEP_STATE_KEY]: 42 })).toBeUndefined();
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

  test("stays disarmed once finalized even for a console server-job run", () => {
    // A finalized console exchange runs on the console; leaving no longer
    // abandons it (the recovery panel re-attaches), so the guard does not re-arm.
    expect(unloadGuardArmed({ hasFile: true, finalized: true })).toBe(false);
  });
});
