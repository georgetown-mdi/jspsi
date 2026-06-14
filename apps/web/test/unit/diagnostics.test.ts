import { afterEach, describe, expect, test, vi } from "vitest";

import {
  DIAGNOSTICS_STORAGE_KEY,
  isDiagnosticMode,
  isDiagnosticsFlagValue,
  whenDiagnostic,
} from "../../src/utils/diagnostics.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** Stub a localStorage whose getItem returns `value` for the diagnostics key. */
function stubStorage(value: string | null): void {
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => (key === DIAGNOSTICS_STORAGE_KEY ? value : null),
  });
}

describe("isDiagnosticsFlagValue", () => {
  test("is off when unset or explicitly off", () => {
    for (const raw of [null, "", "0", "false", "off", " FALSE ", "Off"])
      expect(isDiagnosticsFlagValue(raw)).toBe(false);
  });

  test("is on for any other value a tester might type", () => {
    for (const raw of ["1", "true", "on", "yes", "warn"])
      expect(isDiagnosticsFlagValue(raw)).toBe(true);
  });
});

describe("isDiagnosticMode", () => {
  test("is on in a development build regardless of the stored flag", () => {
    vi.stubEnv("DEV", true);
    stubStorage(null);
    expect(isDiagnosticMode()).toBe(true);
  });

  test("outside a dev build, follows the stored flag", () => {
    vi.stubEnv("DEV", false);
    stubStorage("1");
    expect(isDiagnosticMode()).toBe(true);
  });

  test("outside a dev build, is off when the flag is unset", () => {
    vi.stubEnv("DEV", false);
    stubStorage(null);
    expect(isDiagnosticMode()).toBe(false);
  });

  test("outside a dev build, is off (not throwing) when storage access throws", () => {
    vi.stubEnv("DEV", false);
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("storage blocked");
      },
    });
    expect(isDiagnosticMode()).toBe(false);
  });
});

describe("whenDiagnostic", () => {
  test("runs the sink in a development build", () => {
    vi.stubEnv("DEV", true);
    stubStorage(null);
    const emit = vi.fn();
    whenDiagnostic(emit);
    expect(emit).toHaveBeenCalledOnce();
  });

  test("runs the sink outside a dev build when the toggle is on", () => {
    vi.stubEnv("DEV", false);
    stubStorage("1");
    const emit = vi.fn();
    whenDiagnostic(emit);
    expect(emit).toHaveBeenCalledOnce();
  });

  test("does not run the sink in a production build with the toggle off", () => {
    vi.stubEnv("DEV", false);
    stubStorage(null);
    const emit = vi.fn();
    whenDiagnostic(emit);
    expect(emit).not.toHaveBeenCalled();
  });
});
