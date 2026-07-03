import { UsageError } from "@psilink/core";

// Milliseconds per supported unit suffix. The set is deliberately small (no
// weeks/months/years): a CLI duration is a coordination window, and ambiguous
// or calendar-dependent units (a "month" has no fixed length) would invite the
// very confusion the required-suffix rule exists to prevent.
const UNIT_MS: Record<"s" | "m" | "h" | "d", number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

// The sub-second-capable unit set: the coarse units plus a millisecond unit.
// Used ONLY by {@link parseFineDuration}, so the coarse duration flags keep
// rejecting sub-second input; only --polling-frequency, whose poll interval is
// millisecond-scaled, needs it. The `ms` alternative must precede `m` in the
// regex so `100ms` matches the millisecond unit rather than `100m` + a stray `s`.
const FINE_UNIT_MS: Record<"ms" | "s" | "m" | "h" | "d", number> = {
  ms: 1,
  ...UNIT_MS,
};
const COARSE_DURATION_RE = /^(\d+)(s|m|h|d)$/;
const FINE_DURATION_RE = /^(\d+)(ms|s|m|h|d)$/;

/**
 * Shared grammar core for both duration parsers: a positive integer magnitude
 * followed by a REQUIRED unit suffix drawn from `units`, returned as a positive
 * millisecond offset. {@link parseDuration} (coarse) and {@link parseFineDuration}
 * (sub-second) are this parser bound to a different unit table and regex, so the
 * required-suffix, positive-magnitude, and safe-integer invariants are enforced
 * one way and cannot drift between the two grammars; only the accepted units --
 * and the units/examples named in the error -- differ. `unitList` and `examples`
 * fill the "expected ..." message so each grammar reports exactly its own units.
 */
function parseUnitDuration(
  input: string,
  units: Record<string, number>,
  re: RegExp,
  unitList: string,
  examples: string,
): number {
  const trimmed = input.trim();
  const match = re.exec(trimmed);
  if (match === null)
    throw new UsageError(
      `invalid duration ${JSON.stringify(trimmed)}: expected a positive ` +
        `integer followed by a unit (${unitList}), e.g. ${examples}`,
    );
  // The regex matches only a run of digits, so the magnitude is never negative;
  // zero is the only non-positive value that can reach here.
  const magnitude = Number(match[1]);
  if (magnitude === 0)
    throw new UsageError(
      `duration must be greater than zero; got ${JSON.stringify(trimmed)}`,
    );
  const ms = magnitude * units[match[2]];
  if (!Number.isSafeInteger(ms))
    throw new UsageError(`duration ${JSON.stringify(trimmed)} is too large`);
  return ms;
}

/**
 * Parse a human-readable command-line duration into a positive millisecond
 * offset. This is the canonical duration parser for psilink CLI flags: every
 * flag whose value is a duration should accept this syntax.
 *
 * The syntax is a positive integer magnitude followed by a REQUIRED
 * single-character unit suffix -- `s` (seconds), `m` (minutes), `h` (hours), or
 * `d` (days). Examples: `45s`, `30m`, `2h`, `1d`. The suffix is mandatory by
 * design: a bare integer is never silently assigned a unit. (Some older flags
 * read a bare integer as seconds; forcing the suffix here keeps a value written
 * for one convention from being misread under the other.) Sub-second values are
 * rejected -- a flag that needs millisecond resolution uses {@link parseFineDuration}.
 *
 * @throws {UsageError} if the input is empty, lacks a recognized unit suffix,
 * carries a non-integer or non-positive magnitude, or is large enough to
 * overflow a safe integer.
 */
export function parseDuration(input: string): number {
  return parseUnitDuration(
    input,
    UNIT_MS,
    COARSE_DURATION_RE,
    "s, m, h, or d",
    "45s, 30m, 2h, or 1d",
  );
}

/**
 * Parse a duration into a positive millisecond offset, additionally accepting a
 * millisecond unit (`ms`) so a sub-second value such as `100ms` is expressible.
 * The sole caller is `--polling-frequency`, whose poll interval is
 * millisecond-scaled and whose demo use legitimately wants a fast (sub-second)
 * poll against a controlled server; every other duration flag stays on the
 * coarse {@link parseDuration}, so extending the grammar here does NOT loosen
 * `--peer-timeout` / `--expires-in` / the timeout flags to accept `ms`.
 *
 * Otherwise identical to {@link parseDuration}: the coarser `s`/`m`/`h`/`d`
 * suffixes are still accepted, a unit suffix is still REQUIRED (a bare integer is
 * rejected), and the magnitude must be a positive, safe-integer-bounded value.
 *
 * @throws {UsageError} on the same conditions as {@link parseDuration}.
 */
export function parseFineDuration(input: string): number {
  return parseUnitDuration(
    input,
    FINE_UNIT_MS,
    FINE_DURATION_RE,
    "ms, s, m, h, or d",
    "100ms, 5s, 30m, or 1d",
  );
}

/**
 * Help-text fragment describing the duration value syntax, so every
 * duration-valued flag's `--help` states the same format (documented once as a
 * cross-cutting convention in docs/CLI.md "Configuration"). Kept beside
 * {@link parseDuration} -- the parser this prose describes -- so the two cannot
 * drift.
 */
export const DURATION_VALUE_HELP =
  "A duration with a required unit suffix: s, m, h, or d, e.g. 45s, 30m, 2h, or 1d";

/**
 * Help-text fragment for the sub-second duration syntax {@link parseFineDuration}
 * accepts, for `--polling-frequency`'s `--help`. Adds `ms` to the coarse
 * {@link DURATION_VALUE_HELP} set so the flag's own help states its true grammar
 * rather than the coarse one, which would omit the millisecond unit the flag
 * exists to allow.
 */
export const FINE_DURATION_VALUE_HELP =
  "A duration with a required unit suffix: ms, s, m, h, or d, e.g. 100ms, 5s, or 2m";

/**
 * Parse a duration-valued CLI flag's value through {@link parseDuration}, naming
 * the flag in any error. A bare positive integer -- the pre-migration
 * seconds-only form of the flags this replaces -- is rejected with the exact
 * suffixed value to use (`30` -> use `30s`), so migrating an old invocation is
 * mechanical; every other malformed value yields parseDuration's message
 * prefixed with the flag name.
 *
 * Returns the same positive millisecond offset {@link parseDuration} does; the
 * caller converts to the unit its downstream consumer expects.
 *
 * @param flag the flag name as written on the command line, e.g. `--peer-timeout`.
 * @throws {UsageError} for a bare integer, or any input parseDuration rejects.
 */
export function parseDurationFlag(flag: string, value: string): number {
  return parseDurationFlagWith(flag, value, parseDuration);
}

/**
 * Sub-second sibling of {@link parseDurationFlag}: parse a duration-valued CLI
 * flag through {@link parseFineDuration}, so a millisecond value (`100ms`) is
 * accepted, while keeping the identical bare-integer migration hint (a bare
 * positive integer is rejected with the exact suffixed value to use). The sole
 * caller is `--polling-frequency`; every other duration flag uses
 * {@link parseDurationFlag}, so their grammar is unchanged.
 *
 * @param flag the flag name as written on the command line, e.g. `--polling-frequency`.
 * @throws {UsageError} for a bare integer, or any input parseFineDuration rejects.
 */
export function parseFineDurationFlag(flag: string, value: string): number {
  return parseDurationFlagWith(flag, value, parseFineDuration);
}

// Shared flag wrapper: apply the bare-integer migration hint, then delegate the
// well-formed value to `parse` (the coarse parseDuration or the sub-second
// parseFineDuration), prefixing the flag name onto any UsageError it raises. The
// hint is identical across both grammars -- a bare integer is rejected the same
// way regardless of which units the underlying parser accepts.
function parseDurationFlagWith(
  flag: string,
  value: string,
  parse: (input: string) => number,
): number {
  const trimmed = value.trim();
  // A bare positive integer used to mean "that many seconds"; point straight at
  // the suffixed equivalent rather than the generic "needs a unit" message, since
  // that is the one malformed form a user migrating from the old syntax will hit.
  // A bare 0 falls through to the parser: "0s" is itself rejected as a zero
  // duration, so suggesting it would be wrong.
  if (/^\d+$/.test(trimmed) && Number(trimmed) > 0) {
    // Canonicalize the suggested value with a string op, never Number(): stripping
    // leading zeros keeps the hint honest (007 -> use 7s, since parseDuration reads
    // 007s as 7s) while avoiding the rounding (or Infinity) a Number() round-trip
    // would inflict on a digit string past 2^53. The (?=\d) lookahead keeps a
    // final digit, so an all-zeros string would be untouched -- but it never
    // reaches here, having failed the Number(trimmed) > 0 guard above.
    const canonical = trimmed.replace(/^0+(?=\d)/, "");
    throw new UsageError(
      `${flag} no longer accepts a bare number of seconds; durations need a ` +
        `unit suffix (s, m, h, or d) -- use ${canonical}s for ${canonical} ` +
        `seconds.`,
    );
  }
  try {
    return parse(trimmed);
  } catch (err) {
    if (err instanceof UsageError)
      throw new UsageError(`${flag}: ${err.message}`);
    throw err;
  }
}
