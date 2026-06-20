import { describe, expect, test } from "vitest";
import { getLogger } from "@psilink/core";
import { withCapturedLogs } from "@psilink/core/testing";

// Materialize a named logger at module load -- before this file's first
// withCapturedLogs call. loglevel binds a logger's methods from the methodFactory
// live at getLogger time, so this logger routes through capture only because the
// integration setup (capturedLogs.setup.ts) installs the withCapturedLogs
// interceptor eagerly, ahead of any logger. Remove that eager install and this
// logger binds to the bare factory at creation and its output bypasses capture --
// the ordering footgun this test pins, which would re-fail the assertion below
// (and leak the WARN past the console sentinel). The name is unique so it cannot
// collide with a logger another integration file constructs.
const preCreatedLog = getLogger("eager-install-precreated");

describe("withCapturedLogs eager install", () => {
  test("captures a named logger created before the first withCapturedLogs call", () => {
    // Pin the level so the WARN is delivered to methodFactory regardless of the
    // ambient default; setLevel rebinds methods through the logger's existing
    // methodFactory, so it does not change which factory (capture vs bare) the
    // logger bound to at creation -- the property actually under test.
    preCreatedLog.setLevel("warn");

    const sentinel = "eager-install capture sentinel";
    const [, logs] = withCapturedLogs(
      () => {
        preCreatedLog.warn(sentinel);
      },
      (level) => level === "WARN",
    );

    // The logger bound to capture despite being created before this call, so its
    // WARN landed in the capture (and was suppressed from the console) rather than
    // leaking past the interceptor.
    expect(logs.some((entry) => entry.message.includes(sentinel))).toBe(true);
  });
});
