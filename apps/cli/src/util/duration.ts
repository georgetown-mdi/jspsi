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
