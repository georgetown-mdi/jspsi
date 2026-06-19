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

  it("rejects a stateful (g/y) regex matcher at construction", () => {
    // A g/y-flagged regex advances lastIndex across .test() calls, so the same
    // matcher could accept a line on one evaluation and reject it on the next.
    expect(
      () =>
        new ConsoleSentinel([
          {
            id: "stateful",
            levels: ["warn"],
            match: /repeating/g,
            reason: "uses the g flag",
          },
        ]),
    ).toThrowError(/stateful regex flag/);
    expect(
      () =>
        new ConsoleSentinel([
          {
            id: "sticky",
            levels: ["warn"],
            match: /anchored/y,
            reason: "uses the y flag",
          },
        ]),
    ).toThrow();
  });

  it("rejects an id the sink round-trip would alter at construction", () => {
    // The id is the line-delimited, trim-on-read key in the dead-entry sink, so
    // an embedded newline or surrounding whitespace (including a trailing \r,
    // which the readback's trim strips) would corrupt the aggregation.
    const reject = (id: string) =>
      expect(
        () =>
          new ConsoleSentinel([
            { id, levels: ["warn"], match: /whatever/, reason: "bad id" },
          ]),
      ).toThrowError(/single line with no surrounding whitespace/);
    reject("bad\nid");
    reject("trailing-cr\r");
    reject("  leading-space");
    // An internal space is fine: trim does not touch it and there is no newline.
    expect(
      () =>
        new ConsoleSentinel([
          { id: "ok id", levels: ["warn"], match: /whatever/, reason: "fine" },
        ]),
    ).not.toThrow();
  });

  it("records a non-string arg via util.inspect, not [object Object]", () => {
    const fake = fakeConsole();
    const sentinel = new ConsoleSentinel([]);
    sentinel.install(fake);

    fake.warn("context", { code: "ELEAK", count: 2 });

    const [violation] = sentinel.violations();
    expect(violation.message).toBe("context { code: 'ELEAK', count: 2 }");
    expect(violation.message).not.toContain("[object Object]");
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

  it("does not throw out of the wrapped call when inspect throws", () => {
    // A formatting failure inside the wrapper would turn a benign log into a
    // thrown exception that fails an unrelated test and skips pass-through.
    const hostile = {
      [Symbol.for("nodejs.util.inspect.custom")]() {
        throw new Error("inspect boom");
      },
    };
    let passedThrough = false;
    const fake: ConsoleLike = {
      log: () => {},
      warn: () => {
        passedThrough = true;
      },
      error: () => {},
    };
    const sentinel = new ConsoleSentinel([]);
    sentinel.install(fake);

    expect(() => fake.warn("ctx", hostile)).not.toThrow();
    expect(passedThrough).toBe(true);
    expect(sentinel.violations()[0].message).toBe("ctx [uninspectable]");
    sentinel.restore();
  });

  it("treats a throwing matcher as a non-match instead of crashing", () => {
    // A buggy matcher must not crash assertClean and mask every real violation.
    const allowlist: ConsoleAllowEntry[] = [
      {
        id: "throwing",
        levels: ["warn"],
        match: () => {
          throw new Error("matcher boom");
        },
        reason: "buggy matcher",
      },
    ];
    const fake = fakeConsole();
    const sentinel = new ConsoleSentinel(allowlist);
    sentinel.install(fake);

    fake.warn("some line");

    // The line stays un-allowlisted (fail-safe) and the matcher error does not
    // propagate -- assertClean throws the sentinel's own error, not "matcher boom".
    expect(() => sentinel.assertClean()).toThrowError(/un-allowlisted/);
    expect(sentinel.unusedAllowlistIds()).toEqual(["throwing"]);
    sentinel.restore();
  });

  it("starts a fresh observation window on re-install", () => {
    const fake = fakeConsole();
    const sentinel = new ConsoleSentinel([]);
    sentinel.install(fake);
    fake.warn("from the first window");
    expect(sentinel.recordedCount()).toBe(1);
    sentinel.restore();

    sentinel.install(fake);
    expect(sentinel.recordedCount()).toBe(0);
    fake.warn("from the second window");
    expect(sentinel.violations().map((v) => v.message)).toEqual([
      "from the second window",
    ]);
    sentinel.restore();
  });
});
