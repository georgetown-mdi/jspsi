import { describe, expect, it } from "vitest";

import { sanitizeForDisplay } from "@psilink/core";

import {
  ConsoleSentinel,
  deadAllowlistEntries,
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

    expect(sentinel.violations()).toEqual([
      { level: "warn", message: "unexpected diagnostic" },
    ]);
    expect(() => sentinel.assertClean()).toThrowError(
      /un-allowlisted console line/,
    );
    sentinel.restore();
  });

  it("treats a level-mismatched matcher as not accepting the line", () => {
    // The level filter is critical: an entry scoped to one level must not
    // accept a same-text line emitted at another level, or the gate has a hole.
    const allowlist: ConsoleAllowEntry[] = [
      {
        id: "error-only",
        levels: ["error"],
        match: /shared text/,
        reason: "scoped to error",
      },
    ];
    const fake = fakeConsole();
    const sentinel = new ConsoleSentinel(allowlist);
    sentinel.install(fake);

    fake.warn("a line with shared text at warn level");

    // The warn line is NOT accepted by the error-scoped matcher: it is a
    // violation, and the matcher stays unused.
    expect(sentinel.violations()).toEqual([
      { level: "warn", message: "a line with shared text at warn level" },
    ]);
    expect(sentinel.unusedAllowlistIds()).toEqual(["error-only"]);
    sentinel.restore();
  });

  it("credits every matcher that accepts a line, not just the first", () => {
    // evaluate() does not short-circuit by design: a line covered by two
    // matchers credits both, so neither is misreported as a dead entry.
    const allowlist: ConsoleAllowEntry[] = [
      { id: "first", levels: ["warn"], match: /shared/, reason: "matches" },
      { id: "second", levels: ["warn"], match: /line/, reason: "also matches" },
    ];
    const fake = fakeConsole();
    const sentinel = new ConsoleSentinel(allowlist);
    sentinel.install(fake);

    fake.warn("a shared line");

    expect(() => sentinel.assertClean()).not.toThrow();
    expect(sentinel.matchedAllowlistIds().sort()).toEqual(["first", "second"]);
    expect(sentinel.unusedAllowlistIds()).toEqual([]);
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

  it("shows an async-late line at the flush, not at the synchronous boundary", async () => {
    // Models the "Global ... listener" teardown lines, which fire a tick after
    // the triggering test returns. Proves the flush catches such a line --
    // absent at the synchronous boundary, present after flushPendingConsole.
    // Cross-test attribution (the afterAll placement) is exercised by the
    // integration run, not this unit.
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
    ).toThrowError(/stateful regex flag/);
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

  it("escapes control bytes in the failure message but matches on raw text", () => {
    // A recorded line is whatever reached the console -- possibly a server- or
    // partner-controlled string. The thrown error lands in the CI log, so its
    // lines are escaped against ANSI/bidi/newline log injection; the raw message
    // is preserved for matching (sanitize at display only).
    const fake = fakeConsole();
    const sentinel = new ConsoleSentinel([]);
    sentinel.install(fake);

    fake.error("\x1b[31mred\x1b[0m\ninjected line");

    // violations() exposes the raw recorded bytes (used for matching).
    expect(sentinel.violations()[0].message).toBe(
      "\x1b[31mred\x1b[0m\ninjected line",
    );
    // The thrown message escapes the ESC and newline rather than emitting them.
    let thrown = "";
    try {
      sentinel.assertClean();
    } catch (e) {
      thrown = (e as Error).message;
    }
    expect(thrown).toContain("\\x1b[31mred\\x1b[0m\\x0ainjected line");
    expect(thrown).not.toContain("\x1b");
    expect(thrown).not.toContain("\ninjected line");
    sentinel.restore();
  });

  it("fails an ALLOWLISTED line that contains an unescaped byte", () => {
    // The byte gate is what the allowlist cannot express: a matcher accepts a
    // line by its intended text, which says nothing about the bytes an
    // interpolated partner value smuggled into it. An allowlisted line that
    // reached the console unescaped must still fail.
    const allowlist: ConsoleAllowEntry[] = [
      {
        id: "intended",
        levels: ["warn"],
        match: /^host key mismatch: /,
        reason: "intended diagnostic",
      },
    ];
    const fake = fakeConsole();
    const sentinel = new ConsoleSentinel(allowlist);
    sentinel.install(fake);

    fake.warn("host key mismatch: ‮srevres");

    expect(sentinel.violations()).toEqual([]);
    expect(sentinel.unescapedLines().map((v) => v.message)).toEqual([
      "host key mismatch: ‮srevres",
    ]);
    expect(() => sentinel.assertClean()).toThrowError(
      /without passing a display sink/,
    );
    sentinel.restore();
  });

  it("fails a forged log line whose bytes are printable ASCII plus a bare newline", () => {
    // A partner value of printable ASCII and a newline contains no byte the
    // escape rewrites, so only the framing-aware gate catches it: the renderer
    // emits `\ncaused by: ` and nothing else, and a bare newline outside that
    // sequence is the log-line spoofing this safety check exists to catch.
    const allowlist: ConsoleAllowEntry[] = [
      {
        id: "intended",
        levels: ["error"],
        match: /^failed/,
        reason: "intended diagnostic",
      },
    ];
    const fake = fakeConsole();
    const sentinel = new ConsoleSentinel(allowlist);
    sentinel.install(fake);

    fake.error("failed: ok\nFAKE: all clear");

    expect(sentinel.violations()).toEqual([]);
    expect(sentinel.unescapedLines()).toHaveLength(1);
    expect(() => sentinel.assertClean()).toThrowError(
      /without passing a display sink/,
    );
    sentinel.restore();
  });

  it("passes a line escaped the way a display sink escapes it", () => {
    // sanitizeForDisplay's output is printable ASCII, and the one control
    // sequence the display boundary itself emits is the `\ncaused by: ` join
    // sanitizeErrorForDisplay frames a cause chain with; neither may fail the gate.
    const allowlist: ConsoleAllowEntry[] = [
      {
        id: "intended",
        levels: ["error"],
        match: /^failed/,
        reason: "intended diagnostic",
      },
    ];
    const fake = fakeConsole();
    const sentinel = new ConsoleSentinel(allowlist);
    sentinel.install(fake);

    fake.error(
      `failed: ${sanitizeForDisplay("\x1b[31mred‮")}\ncaused by: gone`,
    );

    expect(sentinel.unescapedLines()).toEqual([]);
    expect(() => sentinel.assertClean()).not.toThrow();
    sentinel.restore();
  });

  it("gates the bytes of a non-string argument too", () => {
    // formatArgs inspects a non-string argument, and util.inspect passes a
    // non-ASCII code point through verbatim, so an object argument is as much a
    // way to reach the console unescaped as a string is.
    const fake = fakeConsole();
    const sentinel = new ConsoleSentinel([]);
    sentinel.install(fake);

    fake.log({ name: "café" });

    expect(sentinel.unescapedLines()).toHaveLength(1);
    expect(() => sentinel.assertClean()).toThrowError(
      /without passing a display sink/,
    );
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

describe("deadAllowlistEntries", () => {
  const allowlist: ConsoleAllowEntry[] = [
    { id: "alpha", levels: ["warn"], match: /a/, reason: "a" },
    { id: "beta", levels: ["warn"], match: /b/, reason: "b" },
    { id: "gamma", levels: ["warn"], match: /c/, reason: "c" },
  ];

  it("reports entries whose id is absent from the sink", () => {
    const dead = deadAllowlistEntries("alpha\n", allowlist).map((e) => e.id);
    expect(dead).toEqual(["beta", "gamma"]);
  });

  it("reports nothing when every id is present", () => {
    expect(deadAllowlistEntries("alpha\nbeta\ngamma\n", allowlist)).toEqual([]);
  });

  it("ignores blank lines, surrounding whitespace, and unknown ids", () => {
    // A torn or padded append must not be mistaken for an id, and an id from a
    // since-removed entry must not break the diff.
    const sink = "\n  alpha  \n\n  \nbeta\nstale-removed-id\n";
    const dead = deadAllowlistEntries(sink, allowlist).map((e) => e.id);
    expect(dead).toEqual(["gamma"]);
  });

  it("treats empty sink contents as all entries dead", () => {
    expect(deadAllowlistEntries("", allowlist).map((e) => e.id)).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
  });
});
