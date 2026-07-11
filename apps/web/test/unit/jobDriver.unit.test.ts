import { describe, expect, test } from "vitest";

import {
  JOB_CLI_BINARY_ENV,
  classifyExit,
  resolveCliBinaryPath,
  validateAndSanitizeEvent,
} from "@jobs/cliDriver";

import { STUB_CLI_PATH } from "../utils/jobFixtures";

describe("classifyExit maps CLI exit codes to terminal states", () => {
  test("0 -> succeeded", () => {
    expect(classifyExit(0, null)).toEqual({
      outcome: "succeeded",
      exitCode: 0,
      signal: null,
    });
  });

  test("130 -> cancelled (SIGINT), reported distinctly", () => {
    expect(classifyExit(130, null)).toEqual({
      outcome: "cancelled",
      exitCode: 130,
      signal: null,
    });
  });

  test("143 -> cancelled (SIGTERM), reported distinctly", () => {
    expect(classifyExit(143, null)).toEqual({
      outcome: "cancelled",
      exitCode: 143,
      signal: null,
    });
  });

  test("64 / 69 / 1 -> failed with the code recorded", () => {
    for (const code of [64, 69, 1]) {
      expect(classifyExit(code, null)).toEqual({
        outcome: "failed",
        exitCode: code,
        signal: null,
      });
    }
  });

  test("a death to SIGINT/SIGTERM signal is cancelled", () => {
    expect(classifyExit(null, "SIGINT").outcome).toBe("cancelled");
    expect(classifyExit(null, "SIGTERM").outcome).toBe("cancelled");
  });

  test("a death to SIGKILL is failed", () => {
    expect(classifyExit(null, "SIGKILL")).toEqual({
      outcome: "failed",
      exitCode: null,
      signal: "SIGKILL",
    });
  });
});

describe("validateAndSanitizeEvent enforces the v1 vocabulary and sanitizes", () => {
  test("accepts a well-formed result event", () => {
    const event = validateAndSanitizeEvent({
      v: 1,
      type: "result",
      resultWritten: true,
    });
    expect(event).not.toBeNull();
    expect(event?.type).toBe("result");
  });

  test("rejects a wrong schema version", () => {
    expect(
      validateAndSanitizeEvent({ v: 2, type: "result", resultWritten: true }),
    ).toBeNull();
  });

  test("rejects an unknown event type", () => {
    expect(validateAndSanitizeEvent({ v: 1, type: "boom" })).toBeNull();
  });

  test("rejects non-object inputs", () => {
    expect(validateAndSanitizeEvent(null)).toBeNull();
    expect(validateAndSanitizeEvent([1, 2, 3])).toBeNull();
    expect(validateAndSanitizeEvent("string")).toBeNull();
  });

  test("sanitizes string fields at the trust boundary (defense in depth)", () => {
    const event = validateAndSanitizeEvent({
      v: 1,
      type: "warning",
      message: "danger[31mred[0m\nsecond line",
    });
    expect(event).not.toBeNull();
    const message = event?.message as string;
    expect(message).not.toContain("");
    expect(message).not.toContain("\n");
  });

  test("sanitizes nested string fields (stages array)", () => {
    const event = validateAndSanitizeEvent({
      v: 1,
      type: "stages",
      stages: [{ id: "s1", label: "hithere" }],
    });
    const stages = event?.stages as Array<{ label: string }>;
    expect(stages[0].label).not.toContain("");
  });
});

describe("validateAndSanitizeEvent sanitizes object keys", () => {
  test("an event key carrying a control byte is escaped", () => {
    const esc = String.fromCharCode(0x1b);
    const controlKey = `danger${esc}[31mkey`;
    const event = validateAndSanitizeEvent({
      v: 1,
      type: "warning",
      message: "ok",
      [controlKey]: "value",
    });
    expect(event).not.toBeNull();
    for (const key of Object.keys(event as object))
      expect(key).not.toContain(esc);
  });
});
describe("resolveCliBinaryPath", () => {
  test("uses the JOB_CLI_BINARY override when set", () => {
    expect(resolveCliBinaryPath({ [JOB_CLI_BINARY_ENV]: STUB_CLI_PATH })).toBe(
      STUB_CLI_PATH,
    );
  });

  test("falls back to the workspace-relative built entry when unset", () => {
    const resolved = resolveCliBinaryPath({});
    expect(resolved.endsWith("apps/cli/dist/index.js")).toBe(true);
  });
});
