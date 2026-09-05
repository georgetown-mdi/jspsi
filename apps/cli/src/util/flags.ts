// Reading a single option off a parsed yargs argv: each helper rejects a repeat
// and a malformed value as a flag-named UsageError, so a bad value is refused at
// the command line rather than reaching the code that would misuse it.

import type { Arguments } from "yargs";

import {
  MAX_TIMEOUT_SECONDS,
  sanitizeErrorForDisplay,
  UsageError,
} from "@psilink/core";

import { parseDurationFlag, parseFineDurationFlag } from "./duration";

/**
 * Read a single-value CLI option from parsed yargs `Arguments`, rejecting a flag
 * given more than once. yargs collects a repeated option into an array (e.g.
 * `--accept-timeout 60 --accept-timeout 120` -> `[60, 120]`), which would reach
 * arithmetic, a comparison, or a string method as if it were a scalar; this
 * throws a {@link UsageError} naming the flag instead.
 *
 * Returns the value unchanged for the caller to cast to the option's declared
 * type (`undefined` when the flag was absent). `type: "count"` and
 * `type: "boolean"` options are not read through here, since a repeat is valid
 * for them.
 */
export function singleValue(argv: Arguments, name: string): unknown {
  const value = argv[name];
  if (Array.isArray(value))
    throw new UsageError(`--${name} may be given only once`);
  return value;
}

/**
 * Reject any `--`-prefixed token captured among a command's positionals as an
 * unrecognized option, with a {@link UsageError} (exit 64) naming it, in the
 * same "Unknown argument(s): ..." wording yargs' own `strictOptions` uses.
 * `invite`, `accept`, and `init` set `unknown-options-as-args` so a `-`-leading
 * invitation string survives as a positional -- which also lets a mistyped
 * `--flag` reach the positional array -- so those commands reject a typo
 * through this scan instead of `strictOptions`.
 *
 * A legitimate positional is single-`-`-leading at most (an invitation,
 * `@path` reference, input/output file, or server URL), so a double-dash token
 * is always a mistype; a single-`-` token is left untouched, since it cannot be
 * told from a `-`-leading invitation without decoding it. yargs consumes a lone
 * `--` separator before positionals are captured, so it never reaches this scan.
 */
export function assertNoUnknownOptions(positionals: Array<unknown>): void {
  const unknown = positionals
    .map(String)
    .filter((token) => token.startsWith("--"));
  if (unknown.length === 0) return;
  throw new UsageError(
    `Unknown argument${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`,
  );
}

/**
 * The sanity ceiling the duration-valued timeout flags (`--connection-timeout`,
 * `--peer-timeout`, `--accept-timeout`) are capped at, re-exported from core --
 * the console's zero-setup authoring surface holds its timeout fields to the same
 * value, and core is the only module both apps can import. Its rationale lives
 * with the option fields it qualifies, in
 * `packages/core/src/config/connection.ts`.
 */
export { MAX_TIMEOUT_SECONDS };

/**
 * Read a duration-valued CLI option from parsed `Arguments` and return it as a
 * whole number of seconds (or `undefined` when the flag is absent). Rejects a
 * repeat (via {@link singleValue}) and a malformed or bare-integer value (via
 * {@link parseDurationFlag}), naming the flag in either error. When `maxSeconds`
 * is given, a value above it is rejected with a flag-named usage error stating
 * the maximum, checked after parsing so it layers on top of the malformed,
 * zero, and overflow rejections rather than replacing them.
 *
 * {@link parseDurationFlag} yields a positive millisecond offset whose smallest
 * unit is seconds, so the divide-by-1000 to seconds is always exact.
 */
export function durationFlagSeconds(
  argv: Arguments,
  name: string,
  maxSeconds?: number,
): number | undefined {
  const raw = singleValue(argv, name);
  if (raw === undefined) return undefined;
  // Coerce the unknown from singleValue to a string so a type:"string" contract
  // violation is reported as parseDurationFlag's flag-named UsageError rather
  // than a raw TypeError from .trim() on a non-string.
  const seconds = parseDurationFlag(`--${name}`, String(raw)) / 1000;
  // The sanity cap is the last check: parseDurationFlag has already rejected a
  // zero, malformed, bare-integer, or overflowing value, so only a well-formed
  // value past the product ceiling remains to reject here. The ceiling is
  // stated in whole days; callers pass a whole-day cap (MAX_TIMEOUT_SECONDS).
  if (maxSeconds !== undefined && seconds > maxSeconds)
    throw new UsageError(
      `--${name} must not exceed ${maxSeconds / 86_400}d; got ${String(raw)}`,
    );
  return seconds;
}

/**
 * Read a duration-valued CLI option and return it as a whole number of
 * MILLISECONDS (or `undefined` when the flag is absent), preserving sub-second
 * precision. The millisecond counterpart of {@link durationFlagSeconds}: it reads
 * through {@link parseFineDurationFlag} rather than the coarse
 * {@link parseDurationFlag}, so the flag also accepts a `100ms`-style value, and
 * returns the parser's millisecond offset directly instead of dividing to
 * seconds, which would floor a sub-second value to zero.
 *
 * The sole caller, `--polling-frequency`, takes no product ceiling: a large
 * poll interval is merely slow, unlike a timeout flag's coordination window.
 * {@link parseFineDurationFlag} still rejects a value large enough to overflow
 * a safe integer.
 *
 * A repeat (via {@link singleValue}) and a malformed or bare-integer value (via
 * {@link parseFineDurationFlag}) are rejected with a flag-named {@link UsageError}
 * (exit 64).
 */
export function durationFlagMs(
  argv: Arguments,
  name: string,
): number | undefined {
  const raw = singleValue(argv, name);
  if (raw === undefined) return undefined;
  // Coerce to a string defensively, as durationFlagSeconds does.
  return parseFineDurationFlag(`--${name}`, String(raw));
}

/**
 * Read a count-valued CLI option (a nonnegative whole number) from parsed
 * `Arguments` and return it as a number (or `undefined` when the flag is
 * absent). Rejects a repeat (via {@link singleValue}) and any value that is not
 * a nonnegative safe integer -- a negative, a fraction, a non-numeric token, or
 * a magnitude past `Number.MAX_SAFE_INTEGER` -- with a flag-named
 * {@link UsageError} (exit 64). `Number.isSafeInteger` mirrors the schema's
 * `z.int().nonnegative()` on the same field, so the CLI boundary and the
 * merged-options re-validation agree.
 *
 * `maxValue`, when given, is an inclusive upper sanity ceiling checked after
 * the type/sign/range rejection, rejected with the same flag-named
 * {@link UsageError}; the message states a bare count with no time unit. Omit
 * `maxValue` for a flag with no product ceiling.
 *
 * Route only non-secret count flags through this helper: a rejected value is
 * echoed verbatim in the usage error, and {@link sanitizeErrorForDisplay}
 * redacts PEM key blocks, not a bare token, so a secret-valued flag would leak
 * into stderr and any log.
 */
export function nonNegativeIntFlag(
  argv: Arguments,
  name: string,
  maxValue?: number,
): number | undefined {
  const raw = singleValue(argv, name);
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0)
    throw new UsageError(
      `--${name} must be a non-negative whole number; got ${String(raw)}`,
    );
  // The sanity ceiling is the last check, layered on top of the type/sign/range
  // rejection above (a value reaching here is a non-negative safe integer), the
  // same way durationFlagSeconds applies MAX_TIMEOUT_SECONDS after parseDurationFlag.
  if (maxValue !== undefined && raw > maxValue)
    throw new UsageError(
      `--${name} must not exceed ${maxValue}; got ${String(raw)}`,
    );
  return raw;
}

/**
 * Run a pre-logger parse step, mapping a {@link UsageError} it throws to a
 * clean stderr message and exit 64. A bootstrap-style command resolves its log
 * level and reads every option before the logger exists, so a usage error
 * there cannot be routed through the logger; this is the one place that
 * boundary lives. Any other error propagates unchanged to the top-level
 * handler. `process.exit` is typed `never`, so this returns the parsed value
 * on the success path.
 */
export function parseOrExit<T>(parse: () => T): T {
  try {
    return parse();
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(sanitizeErrorForDisplay(err));
    process.exit(64);
  }
}
