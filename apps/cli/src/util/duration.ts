import { UsageError } from "@psilink/core";

// Milliseconds per supported unit suffix. The set is small by design (no
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
 * millisecond offset. {@link parseDuration} and {@link parseFineDuration} are
 * this parser bound to a different unit table and regex, so the enforcement
 * cannot drift between the two grammars. `unitList` and `examples` fill the
 * "expected ..." message so each grammar reports its own units.
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
 * offset -- the canonical duration parser for psilink CLI flags. Syntax: a
 * positive integer magnitude plus a REQUIRED unit suffix (`s`, `m`, `h`, `d`),
 * e.g. `45s`, `30m`. Sub-second values are rejected; use
 * {@link parseFineDuration} for millisecond resolution. Full syntax and
 * rationale: docs/CLI.md, Configuration.
 *
 * @throws {UsageError} if the input is empty, lacks a recognized unit suffix,
 * has a non-integer or non-positive magnitude, or is large enough to
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
 * Parse a duration into a positive millisecond offset, additionally accepting
 * a millisecond unit (`ms`) so a sub-second value such as `100ms` is
 * expressible. The sole caller is `--polling-frequency`; every other duration
 * flag stays on the coarse {@link parseDuration}, so extending the grammar
 * here does not loosen the others to accept `ms`. Otherwise identical to
 * {@link parseDuration} (docs/CLI.md, Configuration, for the full syntax and
 * rationale).
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
 * Parse a duration-valued CLI flag's value through {@link parseDuration},
 * naming the flag in any error. A bare positive integer is rejected with the
 * exact suffixed value to use (`30` -> use `30s`); every other malformed
 * value yields parseDuration's message prefixed with the flag name.
 *
 * Returns the same positive millisecond offset {@link parseDuration} does;
 * the caller converts to the unit its downstream consumer expects.
 *
 * @param flag the flag name as written on the command line, e.g. `--peer-timeout`.
 * @throws {UsageError} for a bare integer, or any input parseDuration rejects.
 */
export function parseDurationFlag(flag: string, value: string): number {
  return parseDurationFlagWith(flag, value, parseDuration);
}

/**
 * Sub-second sibling of {@link parseDurationFlag}: parses through
 * {@link parseFineDuration} instead, so a millisecond value (`100ms`) is
 * accepted, with the same bare-integer rejection message. The sole caller is
 * `--polling-frequency`; every other duration flag uses
 * {@link parseDurationFlag} and is unaffected.
 *
 * @param flag the flag name as written on the command line, e.g. `--polling-frequency`.
 * @throws {UsageError} for a bare integer, or any input parseFineDuration rejects.
 */
export function parseFineDurationFlag(flag: string, value: string): number {
  return parseDurationFlagWith(flag, value, parseFineDuration);
}

// Shared flag wrapper: reject a bare integer with a suffixed-value hint, then
// delegate a well-formed value to `parse` (the coarse parseDuration or the
// sub-second parseFineDuration), prefixing the flag name onto any UsageError it
// raises. The hint is identical across both grammars -- a bare integer is
// rejected the same way regardless of which units the underlying parser
// accepts.
function parseDurationFlagWith(
  flag: string,
  value: string,
  parse: (input: string) => number,
): number {
  const trimmed = value.trim();
  // A bare positive integer gets a specific hint -- the exact suffixed
  // equivalent -- rather than the parser's generic "needs a unit" message,
  // since it is the malformed form most likely to appear. A bare 0 falls
  // through to the parser instead: "0s" is itself rejected as a zero
  // duration, so suggesting it would be wrong.
  if (/^\d+$/.test(trimmed) && Number(trimmed) > 0) {
    // Canonicalize the suggested value with a string op, never Number(): stripping
    // leading zeros keeps the hint accurate (007 -> use 7s, since parseDuration
    // reads 007s as 7s) while avoiding the rounding (or Infinity) a Number()
    // round-trip would inflict on a digit string past 2^53. The (?=\d) lookahead
    // keeps a final digit, so an all-zeros string would be untouched -- but it
    // never reaches here, having failed the Number(trimmed) > 0 guard above.
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
