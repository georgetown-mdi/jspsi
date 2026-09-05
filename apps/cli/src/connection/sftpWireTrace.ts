// Routes the SSH stack's own diagnostic lines into psilink's logger, so an
// operator diagnosing a failed dial reads the peer's identification string, both
// sides' algorithm offers, the negotiated algorithms and the packet flow from
// psilink itself instead of from a separate `ssh -vvv`. ssh2 and
// ssh2-sftp-client both emit through the one `debug` connect option, at a
// per-packet volume, which is why the callback is withheld entirely below the
// trace level rather than installed and filtered at the logger.
//
// Every line holds text the remote server chose, so this module is a display
// sink and escapes what it emits (CONTRIBUTING.md, Operator-facing escaping).
// What each side of the stack escapes first is measured, not assumed:
// docs/spec/DEPENDENCY_PINS.md, "Upgrading the SFTP Stack".

import logLibrary from "loglevel";

import { redactAndSanitizeForDisplay } from "@psilink/core";

/**
 * Name of the logger the SSH stack's lines reach the operator under. One of its
 * own rather than the adapter's, for the level: this trace answers for the
 * connection, so it follows the level the operator set with `--log-level` and
 * not the `-v`-floored one the adapter's logger holds. It is also what tells
 * the two apart in the rendered `[LEVEL] [CONTEXT]` prefix, so a line needs no
 * marker of its own.
 */
export const SSH_WIRE_TRACE_LOGGER_NAME = "ssh";

/**
 * Cap on the escaped characters one traced line emits, above the 256-character
 * per-value default `sanitizeForDisplay` would apply. A traced line is not a
 * value interpolated into a sentence but a whole rendering the stack composed,
 * and the algorithm name-lists that make the trace worth reading are its
 * longest emissions: measured against the pinned stack, one dial's longest line
 * is the 669-character version banner and its longest name-list line 361, so
 * the default would cut the negotiated offer out of the answer the operator
 * dialed for.
 *
 * The cap still binds a server that pads its name-lists: the lists arrive
 * verbatim (see the module header), so without one a peer could spend an
 * operator's log on a single KEXINIT.
 */
export const SSH_WIRE_TRACE_MAX_DISPLAY_LENGTH = 1024;

/**
 * What {@link sshWireTraceCallback} needs of a logger: its level, and the trace
 * sink it emits on. Structural rather than loglevel's `Logger`, so a caller can
 * hold it to what this module uses.
 */
export interface WireTraceLogger {
  getLevel: () => number;
  trace: (message: string) => void;
}

/**
 * Render one line the SSH stack emitted as operator-safe display text. The
 * escape is what keeps the bytes a server chose -- an ANSI sequence in an
 * algorithm name it offered, a CR/LF pair that would forge a second log line --
 * from reaching a terminal or a `--log-file` as written; the private-key strip
 * is the same last-resort safety check the connect log applies.
 */
export const sshWireTraceLine = (line: string): string =>
  redactAndSanitizeForDisplay(line, {
    maxLength: SSH_WIRE_TRACE_MAX_DISPLAY_LENGTH,
  });

/**
 * The `debug` callback to hand the SSH stack, or `undefined` when `log` is not
 * at the trace level -- which is what installs nothing at all, leaving a dial
 * below that level byte-identical to one made without this module. It is
 * withheld rather than installed and dropped at the logger because the stack
 * renders every line before calling back, so a no-op sink would still pay the
 * per-packet formatting on every run.
 *
 * `log`'s level decides once, where the caller resolves this: the trace rides
 * the level the caller's logger held then, not one applied later.
 */
export const sshWireTraceCallback = (
  log: WireTraceLogger,
): ((line: string) => void) | undefined =>
  log.getLevel() <= logLibrary.levels.TRACE
    ? (line: string) => log.trace(sshWireTraceLine(line))
    : undefined;
