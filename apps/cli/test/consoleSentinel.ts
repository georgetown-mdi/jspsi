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
 * Known limitations (accepted): it gates the three `console` methods, not raw
 * `process.stdout`/`process.stderr.write`, so a library that writes a file
 * descriptor directly is not seen; and output that lands after the file-level
 * afterAll flush settles is not caught (see {@link flushPendingConsole}). Both
 * are out of scope unless a real offender appears.
 *
 * @internal -- test infrastructure, used by the integration setup file and the
 * sentinel's own unit tests.
 */

import { inspect } from "node:util";

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
  /** Accepts the joined message text. A regex must be flagless-or-non-stateful:
   * the constructor rejects the `g`/`y` flags, whose `lastIndex` would make
   * matching depend on evaluation order. A function matcher must be a pure
   * predicate -- no side effects, no internal state -- because the sentinel does
   * not short-circuit: to credit every matcher that accepts a line, it evaluates
   * each entry's `match` once per recorded line regardless of earlier matches. */
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

// Join console arguments into one matchable line. Strings pass through verbatim
// (so a matcher reads the literal logged text); a non-string is inspected rather
// than `String()`-coerced, so an object records as `{ key: 'value' }` instead of
// the useless `[object Object]` a matcher could never usefully match.
// `breakLength: Infinity` keeps each argument on one line. `inspect` can throw on
// a hostile arg (e.g. a custom `util.inspect.custom` hook that throws), so it is
// guarded: this runs inside the wrapped console call, and a throw here would turn
// a benign log into a thrown exception that fails an unrelated test and skips the
// pass-through. A formatting failure must never do that, so fall back.
function formatArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === "string") return arg;
      try {
        return inspect(arg, { breakLength: Infinity });
      } catch {
        return "[uninspectable]";
      }
    })
    .join(" ");
}

// Apply one matcher to a message. A throwing matcher (a buggy function predicate;
// the regex form cannot throw) is treated as a non-match rather than allowed to
// propagate: a throw out of here would crash the file-level assertClean and mask
// every real violation, whereas counting it as non-matching keeps the gate
// fail-safe -- the line stays un-allowlisted and the run fails loudly.
function matchEntry(entry: ConsoleAllowEntry, message: string): boolean {
  try {
    return entry.match instanceof RegExp
      ? entry.match.test(message)
      : entry.match(message);
  } catch {
    return false;
  }
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
      // The id is the line-delimited key in the cross-file dead-entry sink,
      // written as `id\n` and read back by splitting on `\n` and trimming each
      // line. Any id the round-trip would alter -- an embedded newline (splits
      // into phantom ids) or surrounding whitespace including a trailing `\r`
      // (the trim strips it, so the entry always reads as dead) -- would corrupt
      // the aggregation silently, so reject it at the source.
      if (entry.id.includes("\n") || entry.id.trim() !== entry.id) {
        throw new Error(
          `ConsoleAllowEntry id must be a single line with no surrounding ` +
            `whitespace (it keys the line-delimited sink): ` +
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
    // A fresh install is a fresh observation window: drop any lines recorded in a
    // prior install/restore cycle so they cannot be attributed to this one. (The
    // integration setup installs exactly once per worker; this only matters for a
    // reused instance, e.g. a shared fixture or unit test.)
    this.recorded.length = 0;
    for (const level of this.gatedLevels) {
      const original = target[level].bind(target) as (
        ...args: unknown[]
      ) => void;
      this.originals.set(level, original);
      target[level] = (...args: unknown[]): void => {
        this.recorded.push({ level, message: formatArgs(args) });
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

  /** How many console lines have been recorded so far. Lets a caller settle
   * trailing async output by flushing until this count stops growing. */
  recordedCount(): number {
    return this.recorded.length;
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
 * file-level `afterAll` that waits a timer macrotask and then a check-phase
 * callback (`setImmediate`) -- with the microtask queue draining automatically
 * between them -- attributes such a late line to this file rather than
 * misattributing it to the following test (or leaking it into the next file).
 *
 * This is one drain step, not a guarantee: output that lands more than `timerMs`
 * after the last drain still escapes -- a finite afterAll cannot wait
 * unboundedly. The setup file calls this in a settle loop (drain until the
 * recorded count stops growing, up to a cap) so a teardown that emits in waves
 * is caught; a lone line arriving past the budget is the residual gap. The
 * sentinel's firm guarantee is for synchronous output and output within the
 * settle budget.
 *
 * Node-only: relies on `setImmediate`, which is not in the DOM lib.
 */
export async function flushPendingConsole(timerMs = 25): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, timerMs));
  await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Given the raw contents of the cross-file matched-id sink (one matched id per
 * line, appended by each worker) and the allowlist, returns the entries no
 * worker matched -- the dead-entry candidates the suite teardown reports. Parses
 * defensively: blank lines are dropped and each line is trimmed, so a torn or
 * empty append cannot be mistaken for an id (it also matches the constructor's
 * id guard, which forbids the newline/whitespace that parsing would mangle).
 * Pure, so it is unit-tested directly; the teardown supplies the file contents.
 */
export function deadAllowlistEntries(
  sinkContents: string,
  allowlist: readonly ConsoleAllowEntry[],
): ConsoleAllowEntry[] {
  const matched = new Set(
    sinkContents
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
  return allowlist.filter((entry) => !matched.has(entry.id));
}
