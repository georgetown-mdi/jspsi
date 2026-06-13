import { describe, expect, test } from "vitest";

import { isDiagnosticsFlagValue } from "../../src/utils/diagnostics.js";

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
