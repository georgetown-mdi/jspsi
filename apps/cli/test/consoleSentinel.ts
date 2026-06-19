/**
 * A standing console-output sentinel for the CLI integration suite.
 *
 * It wraps the three `console` sinks (`log`/`warn`/`error`) directly and, at a
 * file-level `afterAll` flush, FAILS the run on any line that no allowlist
 * matcher accepts -- the inverse of blanket silencing. It hides nothing and
 * makes unexpected output loud; an allowlist of intended-message matchers is
 * the single reviewable source of truth for "intended noise", so adding an
 * intended log forces a visible allowlist edit in review.
 *
 * Why wrap `console` directly rather than route through loglevel: the per-test
 * `withCapturedLogs` (`packages/core/src/testing.ts`) intercepts loglevel's
 * `methodFactory`, so any third-party `console.*` that does NOT go through
 * loglevel (e.g. ssh2-sftp-client's default constructor callbacks, which
 * `console.log`/`console.error` "Global ... listener" lines) is structurally
 * invisible to it. Wrapping `console` is what closes that gap. This sentinel
 * complements -- it does not replace -- the per-test `withCapturedLogs`
 * capture-and-assert.
 *
 * @internal -- test infrastructure, used by the integration setup file and the
 * sentinel's own unit tests.
 */

/** A console sink the sentinel gates. */
export type ConsoleLevel = "log" | "warn" | "error";

/** Minimal shape the sentinel wraps; the global `console` satisfies it. */
export interface ConsoleLike {
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** One accepted line of intended console output. */
export interface ConsoleAllowEntry {
  /** Stable identifier; the dead-entry report and cross-file aggregation key. */
  id: string;
  /** Console levels this entry may accept. */
  levels: readonly ConsoleLevel[];
  /** Accepts the joined message text. Must be a flagless-or-non-stateful regex:
   * the constructor rejects the `g`/`y` flags, whose `lastIndex` would make
   * matching depend on evaluation order. */
  match: RegExp | ((message: string) => boolean);
  /** Why this output is intended; shown in review and in the dead-entry report. */
  reason: string;
}

/** A single recorded console call: its level and joined message text. */
export interface RecordedConsoleLine {
  level: ConsoleLevel;
  message: string;
}

const ALL_LEVELS: readonly ConsoleLevel[] = ["log", "warn", "error"];

// Cap how many offending lines the assertion error enumerates, so a test that
// spams output produces a readable failure rather than a wall of text.
const MAX_REPORTED_VIOLATIONS = 20;

function matchEntry(entry: ConsoleAllowEntry, message: string): boolean {
  return entry.match instanceof RegExp
    ? entry.match.test(message)
    : entry.match(message);
}

/**
 * Wraps a {@link ConsoleLike} and records every gated call. Call
 * {@link ConsoleSentinel.assertClean} once per file at `afterAll` (after a
 * {@link flushPendingConsole}) to fail on any un-allowlisted line.
 */
export class ConsoleSentinel {
  private readonly allowlist: readonly ConsoleAllowEntry[];
  private readonly gatedLevels: readonly ConsoleLevel[];
  private readonly recorded: RecordedConsoleLine[] = [];
  private target: ConsoleLike | null = null;
  private readonly originals = new Map<
    ConsoleLevel,
    (...args: unknown[]) => void
  >();

  constructor(
    allowlist: readonly ConsoleAllowEntry[],
    options: { gatedLevels?: readonly ConsoleLevel[] } = {},
  ) {
    for (const entry of allowlist) {
      // The id is the line-delimited key in the cross-file dead-entry sink, so a
      // newline in it would split into phantom ids on read; reject it at the
      // source rather than corrupt the aggregation silently.
      if (entry.id.includes("\n")) {
        throw new Error(
          `ConsoleAllowEntry id must not contain a newline: ` +
            JSON.stringify(entry.id),
        );
      }
      // A stateful regex (g/y) advances lastIndex across .test() calls, so the
      // same matcher could accept a line on one evaluation and reject it on the
      // next. Make the documented footgun a hard guarantee.
      if (
        entry.match instanceof RegExp &&
        (entry.match.global || entry.match.sticky)
      ) {
        throw new Error(
          `ConsoleAllowEntry "${entry.id}" matcher uses a stateful regex flag ` +
            `(g/y); use a flagless regex so matching is order-independent`,
        );
      }
    }
    this.allowlist = allowlist;
    this.gatedLevels = options.gatedLevels ?? ALL_LEVELS;
  }

  /** Wraps `target` (the global `console` by default). Pass-through is preserved
   * so output still surfaces -- the sentinel adds a failure, it never silences. */
  install(target: ConsoleLike = console): void {
    if (this.target) throw new Error("ConsoleSentinel is already installed");
    this.target = target;
    for (const level of this.gatedLevels) {
      const original = target[level].bind(target) as (
        ...args: unknown[]
      ) => void;
      this.originals.set(level, original);
      target[level] = (...args: unknown[]): void => {
        this.recorded.push({ level, message: args.map(String).join(" ") });
        original(...args);
      };
    }
  }

  /** Restores the wrapped methods. Safe to call when not installed. */
  restore(): void {
    if (!this.target) return;
    for (const [level, original] of this.originals) {
      this.target[level] = original;
    }
    this.originals.clear();
    this.target = null;
  }

  // A pure evaluation of the recorded lines against the allowlist: which lines
  // no entry accepts (violations) and which entries accepted at least one line
  // (matched). Every entry that accepts a line is credited (so a line shared by
  // two matchers leaves neither looking dead); a line accepted by none is a
  // violation. Returns fresh values rather than mutating shared state, so
  // sequencing two public methods cannot leak stale results between them.
  private evaluate(): {
    violations: RecordedConsoleLine[];
    matchedIds: Set<string>;
  } {
    const matchedIds = new Set<string>();
    const violations: RecordedConsoleLine[] = [];
    for (const line of this.recorded) {
      let accepted = false;
      for (const entry of this.allowlist) {
        if (!entry.levels.includes(line.level)) continue;
        if (matchEntry(entry, line.message)) {
          matchedIds.add(entry.id);
          accepted = true;
        }
      }
      if (!accepted) violations.push(line);
    }
    return { violations, matchedIds };
  }

  /** Recorded lines that no allowlist matcher accepts. */
  violations(): RecordedConsoleLine[] {
    return this.evaluate().violations;
  }

  /** Allowlist ids matched by at least one recorded line (for aggregation). */
  matchedAllowlistIds(): string[] {
    return [...this.evaluate().matchedIds];
  }

  /** Allowlist ids no recorded line matched (dead-entry candidates). */
  unusedAllowlistIds(): string[] {
    const { matchedIds } = this.evaluate();
    return this.allowlist
      .filter((entry) => !matchedIds.has(entry.id))
      .map((entry) => entry.id);
  }

  /** Throws if any recorded line is un-allowlisted; no-op otherwise. */
  assertClean(): void {
    const { violations } = this.evaluate();
    if (violations.length === 0) return;
    const shown = violations.slice(0, MAX_REPORTED_VIOLATIONS);
    const lines = shown.map((v) => `  [${v.level}] ${v.message}`);
    if (violations.length > shown.length) {
      lines.push(`  ... and ${violations.length - shown.length} more`);
    }
    throw new Error(
      `Console sentinel: ${violations.length} un-allowlisted console line(s) ` +
        `emitted during this test file. Eliminate each at the source, or -- if ` +
        `genuinely intended -- accept it with a matcher in the integration ` +
        `console allowlist (a visible, reviewable edit):\n${lines.join("\n")}`,
    );
  }
}

/**
 * Lets pending async console output settle before an assertion. The
 * ssh2-sftp-client "Global ... listener" lines fire on connection-teardown
 * events emitted asynchronously, so a teardown triggered by one test lands a
 * tick or two later -- in the NEXT test's window, or after the last test. A
 * file-level `afterAll` that flushes a macrotask and the microtask queue
 * attributes such a late line to this file rather than misattributing it to the
 * following test (or leaking it into the next file).
 *
 * Node-only: relies on `setImmediate`, which is not in the DOM lib.
 */
export async function flushPendingConsole(timerMs = 25): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, timerMs));
  await new Promise((resolve) => setImmediate(resolve));
}
