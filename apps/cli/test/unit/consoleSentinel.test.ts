import { describe, expect, it } from "vitest";

import {
  ConsoleSentinel,
  flushPendingConsole,
  type ConsoleAllowEntry,
  type ConsoleLike,
} from "../consoleSentinel";

// A standalone console double so the sentinel's own behavior can be exercised
// without touching the real (vitest-wrapped) console. Methods are no-ops: the
// sentinel records the call regardless of what the original does.
function fakeConsole(): ConsoleLike {
  return { log: () => {}, warn: () => {}, error: () => {} };
}

describe("ConsoleSentinel", () => {
  it("fails the run on an un-allowlisted warn", () => {
    const fake = fakeConsole();
    const sentinel = new ConsoleSentinel([]);
    sentinel.install(fake);

    fake.warn("unexpected diagnostic");

    expect(() => sentinel.assertClean()).toThrowError(
      /un-allowlisted console line/,
    );
    sentinel.restore();
  });

  it("fails the run on an un-allowlisted error", () => {
    const fake = fakeConsole();
    const sentinel = new ConsoleSentinel([]);
    sentinel.install(fake);

    fake.error("surprise error");

    const violations = sentinel.violations();
    expect(violations).toHaveLength(1);
    expect(violations[0]).toEqual({
      level: "error",
      message: "surprise error",
    });
    expect(() => sentinel.assertClean()).toThrow();
    sentinel.restore();
  });

  it("passes an allowlisted message and credits its matcher", () => {
    const allowlist: ConsoleAllowEntry[] = [
      {
        id: "intended-warn",
        levels: ["warn"],
        match: /known intentional warning/,
        reason: "exercised by this test",
      },
    ];
    const fake = fakeConsole();
    const sentinel = new ConsoleSentinel(allowlist);
    sentinel.install(fake);

    fake.warn("a known intentional warning fired");

    expect(() => sentinel.assertClean()).not.toThrow();
    expect(sentinel.matchedAllowlistIds()).toEqual(["intended-warn"]);
    expect(sentinel.unusedAllowlistIds()).toEqual([]);
    sentinel.restore();
  });

  it("reports an allowlist matcher that never fires", () => {
    const allowlist: ConsoleAllowEntry[] = [
      {
        id: "fired",
        levels: ["warn"],
        match: /fires/,
        reason: "this one fires",
      },
      {
        id: "dormant",
        levels: ["error"],
        match: /never seen/,
        reason: "this one is dead",
      },
    ];
    const fake = fakeConsole();
    const sentinel = new ConsoleSentinel(allowlist);
    sentinel.install(fake);

    fake.warn("a matcher that fires");

    expect(() => sentinel.assertClean()).not.toThrow();
    expect(sentinel.unusedAllowlistIds()).toEqual(["dormant"]);
    sentinel.restore();
  });

  it("catches a third-party console.log not routed through loglevel", () => {
    // The ssh2-sftp-client default constructor callbacks `console.log` their
    // "Global ... listener" lines directly -- never through loglevel -- so the
    // loglevel-based `withCapturedLogs` cannot see them. Gating `log` is what
    // lets the sentinel catch this direct-console source.
    const fake = fakeConsole();
    const sentinel = new ConsoleSentinel([]);
    sentinel.install(fake);

    fake.log("Global close listener: close event raised");

    const violations = sentinel.violations();
    expect(violations).toEqual([
      { level: "log", message: "Global close listener: close event raised" },
    ]);
    sentinel.restore();
  });

  it("does not gate a level outside gatedLevels", () => {
    const fake = fakeConsole();
    const sentinel = new ConsoleSentinel([], {
      gatedLevels: ["warn", "error"],
    });
    sentinel.install(fake);

    fake.log("an un-gated log line");
    fake.warn("a gated warn line");

    expect(sentinel.violations().map((v) => v.message)).toEqual([
      "a gated warn line",
    ]);
    sentinel.restore();
  });

  it("attributes an async-late line at the afterAll flush, not before", async () => {
    // Models the "Global ... listener" teardown lines: emitted on an async event
    // a tick after the test that triggered the teardown returns. A per-test
    // assertion run synchronously at that test's end would miss it; only the
    // file-level afterAll flush surfaces it -- attributing it to the file rather
    // than misattributing it to whatever ran next.
    const fake = fakeConsole();
    const sentinel = new ConsoleSentinel([]);
    sentinel.install(fake);

    setTimeout(() => fake.warn("Global error listener: late teardown"), 5);

    // The synchronous boundary of the triggering test: the line has not fired.
    expect(sentinel.violations()).toEqual([]);

    // The afterAll flush lets the pending timer run, so the late line is caught.
    await flushPendingConsole();
    expect(() => sentinel.assertClean()).toThrowError(
      /Global error listener: late teardown/,
    );
    sentinel.restore();
  });

  it("preserves pass-through to the wrapped method", () => {
    const seen: string[] = [];
    const fake: ConsoleLike = {
      log: (...args: unknown[]) => seen.push(`log:${args.join(" ")}`),
      warn: () => {},
      error: () => {},
    };
    const sentinel = new ConsoleSentinel([]);
    sentinel.install(fake);

    fake.log("still", "printed");

    expect(seen).toEqual(["log:still printed"]);
    sentinel.restore();
    // After restore the original method is back and recording stops.
    fake.log("after restore");
    expect(seen).toEqual(["log:still printed", "log:after restore"]);
    expect(sentinel.violations()).toHaveLength(1);
  });
});
