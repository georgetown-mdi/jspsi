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
 * for one convention from being misread under the other.)
 *
 * @throws {UsageError} if the input is empty, lacks a recognized unit suffix,
 * carries a non-integer or non-positive magnitude, or is large enough to
 * overflow a safe integer.
 */
export function parseDuration(input: string): number {
  const trimmed = input.trim();
  const match = /^(\d+)(s|m|h|d)$/.exec(trimmed);
  if (match === null)
    throw new UsageError(
      `invalid duration ${JSON.stringify(trimmed)}: expected a positive ` +
        "integer followed by a unit (s, m, h, or d), e.g. 45s, 30m, 2h, or 1d",
    );
  // The regex matches only a run of digits, so the magnitude is never negative;
  // zero is the only non-positive value that can reach here.
  const magnitude = Number(match[1]);
  if (magnitude === 0)
    throw new UsageError(
      `duration must be greater than zero; got ${JSON.stringify(trimmed)}`,
    );
  const ms = magnitude * UNIT_MS[match[2] as keyof typeof UNIT_MS];
  if (!Number.isSafeInteger(ms))
    throw new UsageError(`duration ${JSON.stringify(trimmed)} is too large`);
  return ms;
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
  const trimmed = value.trim();
  // A bare positive integer used to mean "that many seconds"; point straight at
  // the suffixed equivalent rather than the generic "needs a unit" message, since
  // that is the one malformed form a user migrating from the old syntax will hit.
  // A bare 0 falls through to parseDuration: "0s" is itself rejected as a zero
  // duration, so suggesting it would be wrong. Echo `trimmed` verbatim, not
  // Number(trimmed): a digit string past 2^53 would round (or become Infinity)
  // and suggest a value the user never typed and parseDuration would itself reject.
  if (/^\d+$/.test(trimmed) && Number(trimmed) > 0)
    throw new UsageError(
      `${flag} no longer accepts a bare number of seconds; durations need a ` +
        `unit suffix (s, m, h, or d) -- use ${trimmed}s for ${trimmed} seconds.`,
    );
  try {
    return parseDuration(trimmed);
  } catch (err) {
    if (err instanceof UsageError)
      throw new UsageError(`${flag}: ${err.message}`);
    throw err;
  }
}
