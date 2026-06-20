import type { ConsoleAllowEntry, ConsoleLevel } from "../consoleSentinel";

/**
 * Console levels the integration sentinel gates. We gate all three -- including
 * `log` -- because the value the sentinel adds over loglevel-based capture is
 * catching third-party `console.log` that does not go through loglevel (the
 * ssh2-sftp-client "Global ... listener" lines are emitted on `console.log` /
 * `console.error`). `log` is the noisiest tier in principle, but the suite
 * currently emits none, so gating it costs nothing today and closes the gap the
 * sentinel exists to close.
 */
export const SENTINEL_GATED_LEVELS: readonly ConsoleLevel[] = [
  "log",
  "warn",
  "error",
];

/**
 * The single reviewable source of truth for "intended" console output in the
 * CLI integration suite. Adding an entry is a visible, reviewable edit; an
 * entry that never fires across a whole run is reported at teardown (see
 * globalSetup) so the list cannot silently accumulate dead matchers.
 *
 * EMPTY by design. The integration suite currently reaches `console` with
 * nothing un-allowlisted, because the messages one might expect here are kept
 * off the console upstream:
 *
 *   - The intended WARN/ERROR diagnostics (e.g. the abort-recovery advisory
 *     "The shared secret was already rotated and saved before this error.")
 *     are emitted through loglevel and asserted under `withCapturedLogs`, which
 *     suppresses them from the console while the capture is active. They reach
 *     the console only if a regression emits one OUTSIDE a capture -- which is
 *     exactly what the sentinel should catch, not pre-accept.
 *   - The ssh2-sftp-client "Global ... listener" lines (`Global error listener:
 *     <msg>` on `console.error`; `Global end listener: end event raised` /
 *     `Global close listener: close event raised` on `console.log`) are routed
 *     to the project logger by constructor callbacks rather than reaching the
 *     console: `SSH2SFTPClientAdapter`'s callbacks for an adapter-driven
 *     connection, and `createRawSftpClient`'s (`test/rawSftpClient.ts`) for the
 *     few integration tests that must drive a bare client -- so neither path
 *     leaks the teardown ECONNRESET the sentinel could otherwise only catch
 *     best-effort.
 *   - The former unpinned-host-key WARN is gone: the no-pin host-key path now
 *     fails closed rather than warn-and-proceed.
 *
 * So seeding those as live matchers would only create dead entries. If one
 * regresses and starts leaking, the fix is to re-suppress/route it at the
 * source; accept it here ONLY when the output is genuinely intended on the
 * console, with the matcher's `reason` explaining why.
 */
export const INTEGRATION_CONSOLE_ALLOWLIST: readonly ConsoleAllowEntry[] = [];
