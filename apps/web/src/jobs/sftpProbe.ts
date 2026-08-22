import { spawn } from "node:child_process";

import { HOST_KEY_FINGERPRINT_REGEX, sanitizeForDisplay } from "@psilink/core";

import { sanitizedChildEnv } from "./cliDriver";

import type { ChildProcess } from "node:child_process";

/**
 * The appliance's SFTP host-key probe driver. It spawns the CLI's
 * `probe-host-key` subcommand -- the same binary the exchange runs -- to read the
 * server's presented host-key fingerprint over the same untrusted network the
 * exchange will use, so the console can offer it beside the paste field for a
 * COMPARISON against the value the server operator published. It never trusts the
 * value, never authors a connection, and never sends a credential: the CLI's
 * probe verifier refuses before authenticating.
 *
 * A dial that reached the port and read no host key carries the child's own
 * diagnosis of what answered instead, so the console's guided audience -- the
 * likeliest to sit behind an intercepting middlebox -- is told the peer answered
 * with non-SSH bytes rather than only that the host was unreachable. The
 * diagnosis crosses STRUCTURALLY (a closed vocabulary plus a bounded, escaped
 * excerpt), never as forwarded stderr.
 *
 * Every server-controlled byte is re-validated at this trust boundary
 * (fingerprint regex, key-type charset and length, the diagnosis vocabulary and
 * its escaped excerpt), stderr is discarded entirely (it can carry
 * server-controlled bytes), and the child is watchdog-bounded so the endpoint's
 * latency stays bounded regardless of the child's own timeout.
 */

/**
 * The connect timeout handed to the CLI child (its ssh2 `readyTimeout`), as a
 * number so the watchdog headroom below is arithmetic rather than a claim, and
 * as the duration token the flag's grammar takes.
 */
export const PROBE_CONNECT_TIMEOUT_MS = 10_000;
const PROBE_CONNECT_TIMEOUT = `${PROBE_CONNECT_TIMEOUT_MS / 1000}s`;

/**
 * The child's own bounded read of the peer's first bytes on a dial that died
 * before the peer identified itself (`PEER_ANSWER_READ_BUDGET_MS` in
 * apps/cli/src/connection/sftpPeerIdentification.ts). Mirrored rather than
 * imported -- the CLI is a separate workspace this server drives as a subprocess
 * -- so that the watchdog headroom this file depends on is stated where the
 * watchdog is.
 *
 * Two unit tests hold the mirror: one reads the CLI's own declaration and fails
 * when the two values part, the other holds this value and the watchdog to the
 * ordering the diagnosis needs.
 */
export const PROBE_PEER_READ_BUDGET_MS = 2_000;

/**
 * The server-side watchdog: SIGTERM the child at this point so the endpoint's
 * latency is bounded ABOVE the child's 10 s `readyTimeout` (a child that stops on
 * its own timeout exits first and is classified organically), then SIGKILL after
 * a grace if it ignores the term. A watchdog kill is reported as a `timeout`.
 */
export const PROBE_SIGTERM_MS = 15_000;
/** The grace before the watchdog escalates SIGTERM to SIGKILL. */
export const PROBE_SIGKILL_GRACE_MS = 5_000;

/**
 * The cap on retained child stdout, in UTF-16 code units. The probe emits ONE
 * short JSON line; anything past a few KiB is a malformed or hostile child, so
 * the read is bounded and an overflow is a probe error rather than unbounded
 * memory growth.
 */
const PROBE_STDOUT_CAP = 4096;

// The two `key_type` bounds below mirror core's `MAX_KEY_TYPE_BYTES` (64) and
// `isAcceptedKeyTypeByte` (`[A-Za-z0-9._@-]`), whose record is
// docs/spec/CHANNEL_SECURITY.md (SFTP host-key verification: the presented key
// type, and the cross-party reconciliation that reads it). Duplicating those
// values rather than importing them is deliberate and must stay that way: this
// is a re-validation of a distrusted child process's stdout at a trust
// boundary, so what it checks has to be what this side is willing to accept,
// independent of the producer that emitted the value.
/** The maximum accepted `key_type` length. Server-controlled bytes, so it is
 * length- and charset-checked at this trust boundary. */
const MAX_KEY_TYPE_LENGTH = 64;
/** The charset a host-key algorithm name may use: the SSH algorithm names
 * (`ssh-ed25519`, `ecdsa-sha2-nistp256`, `rsa-sha2-512`) plus the `@`/`.` a
 * certificate host-key type carries (`ssh-ed25519-cert-v01@openssh.com`). Any
 * other byte -- a control sequence a hostile server smuggled -- fails the check. */
const KEY_TYPE_CHARSET = /^[A-Za-z0-9._@-]+$/;

// The three bounds below mirror the CLI's own diagnosis vocabulary
// (`PeerAnswerShape`) and excerpt bound (`PEER_EXCERPT_MAX_BYTES`, 128 bytes) in
// apps/cli/src/connection/sftpPeerIdentification.ts. Duplicating them rather
// than importing is deliberate, for the same reason the key-type bounds above
// are duplicated: this is a re-validation of a distrusted child process's stdout
// at a trust boundary, so what it accepts has to be what this side is willing to
// accept, independent of the producer that emitted it.
/** The shapes a non-SSH answer may be reported as. Any other value is a
 * malformed diagnosis and is dropped, leaving the bare `unreachable`. */
const PEER_ANSWER_SHAPES = new Set(["http", "tls-alert", "unrecognized"]);
/**
 * The cap on the ESCAPED excerpt, in UTF-16 code units. Four times the CLI's
 * 128-byte excerpt bound, since the display escape expands a non-printable byte
 * to a four-character `\xHH`, so an excerpt made entirely of them still crosses
 * whole; a child that emitted more than its own bound is truncated here rather
 * than trusted.
 */
export const PROBE_EXCERPT_MAX_DISPLAY_LENGTH = 512;

/** What the peer's first bytes were, for a shape the CLI recognizes. */
export type SftpPeerAnswerShape = "http" | "tls-alert" | "unrecognized";

/**
 * Why a dial reached the port and still read no host key, as the CLI's own
 * bounded, credential-free read of the peer's first bytes established it:
 * - `nonSsh`: the peer answered with something that is not an SSH
 *   identification string, carrying the shape and the ESCAPED excerpt of what
 *   it sent (bytes an untrusted party chose).
 * - `closedUnanswered`: the peer accepted the connection and closed it having
 *   sent nothing.
 *
 * Absent on an `unreachable` the child could not diagnose -- a refused
 * connection, an unresolvable name, a peer that stalled -- where the categorical
 * answer is all there is to say.
 */
export type SftpProbeDiagnosis =
  | { kind: "nonSsh"; shape: SftpPeerAnswerShape; excerpt: string }
  | { kind: "closedUnanswered" };

/**
 * The reconciled outcome of a probe attempt:
 * - `ok`: the child read a host key; carries the re-validated fingerprint and
 *   key type.
 * - `unreachable`: the child could not reach or connect to the server (CLI exit
 *   69), optionally carrying the child's own {@link SftpProbeDiagnosis} of what
 *   answered the port.
 * - `timeout`: the watchdog killed the child (it exceeded the server budget).
 * - `error`: the child exited non-zero for another reason, produced no valid
 *   line, or could not be spawned.
 */
export type SftpProbeResult =
  | { kind: "ok"; fingerprint: string; keyType: string }
  | { kind: "unreachable"; diagnosis?: SftpProbeDiagnosis }
  | { kind: "timeout" }
  | { kind: "error" };

// The placeholder host the URL is seeded with, distinguished from a real host so
// a setter no-op (which leaves this value in place) is detectable. `.invalid` is
// a reserved TLD (RFC 6761), so it is never a legitimately authored server.
const PROBE_URL_SENTINEL_HOST = "host.invalid";

/**
 * Build the `sftp://host[:port]` URL the probe child dials, from a host that has
 * already passed {@link isBareSftpHost}. Mirrors the WHATWG-URL / IPv6-bracket
 * discipline of `buildZeroSetupSftpUrl`: a bare IPv6 literal is bracketed first
 * (the hostname setter silently rejects an unbracketed one), the host is assigned
 * through the {@link URL} object (never string concatenation), and a total drop --
 * an empty hostname or the untouched sentinel -- is a hard error. The host having
 * passed the bare-host predicate rules out the truncating characters, so the
 * composed host can differ from the input only by safe canonicalization.
 *
 * @internal exported for testing
 */
export function buildSftpProbeUrl(
  host: string,
  port: number | undefined,
): string {
  const hostForUrl =
    host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const url = new URL(`sftp://${PROBE_URL_SENTINEL_HOST}`);
  url.hostname = hostForUrl;
  if (url.hostname === "" || url.hostname === PROBE_URL_SENTINEL_HOST)
    throw new Error(
      "could not encode the sftp host into a URL for a host-key probe",
    );
  if (port !== undefined) url.port = String(port);
  return url.href;
}

/**
 * Reconcile the probe child's exit into an {@link SftpProbeResult}. Exit 69 (the
 * CLI's transport-failure code) is `unreachable`; exit 0 parses the captured
 * stdout; any other exit (a usage error, another code, or a death to a
 * non-watchdog signal) is `error`. A watchdog kill is handled by the caller
 * before this runs, so a signal death reaching here is an anomaly classified as
 * an error. `stdout` is undefined when the read overflowed the cap.
 *
 * @internal exported for testing
 */
export function reconcileProbeExit(
  code: number | null,
  stdout: string | undefined,
): SftpProbeResult {
  if (code === 69) {
    const diagnosis =
      stdout === undefined ? undefined : parseProbeDiagnosis(stdout);
    return diagnosis === undefined
      ? { kind: "unreachable" }
      : { kind: "unreachable", diagnosis };
  }
  if (code !== 0) return { kind: "error" };
  if (stdout === undefined) return { kind: "error" };
  return parseProbeStdout(stdout);
}

/**
 * Parse and re-validate the diagnosis line the `--json` form emits on the
 * exit-69 path, or undefined when the child emitted none or emitted one this
 * boundary does not accept. Every field is checked here: the discriminant
 * against a closed two-value vocabulary, the shape against the closed shape set,
 * and the excerpt -- bytes an untrusted party chose -- ESCAPED and capped before
 * it is retained, so nothing past this point holds a raw control byte.
 *
 * A malformed or unrecognized line degrades to undefined rather than to an
 * `error` result: the exit code already established what happened, and the
 * diagnosis is an enrichment of it. That keeps a CLI that has not grown the line
 * yet -- or one whose vocabulary moved on -- reporting exactly the `unreachable`
 * it reports today.
 *
 * @internal exported for testing
 */
export function parseProbeDiagnosis(
  stdout: string,
): SftpProbeDiagnosis | undefined {
  const line = stdout.trim();
  if (line.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    return undefined;
  const record = parsed as Record<string, unknown>;
  if (record["diagnosis"] === "closed_unanswered")
    return { kind: "closedUnanswered" };
  if (record["diagnosis"] !== "non_ssh") return undefined;
  const shape = record["shape"];
  const excerpt = record["excerpt"];
  if (typeof shape !== "string" || !PEER_ANSWER_SHAPES.has(shape))
    return undefined;
  if (typeof excerpt !== "string") return undefined;
  return {
    kind: "nonSsh",
    shape: shape as SftpPeerAnswerShape,
    excerpt: sanitizeForDisplay(excerpt, {
      maxLength: PROBE_EXCERPT_MAX_DISPLAY_LENGTH,
    }),
  };
}

/**
 * Parse and re-validate the probe child's single stdout line. Every field is
 * checked at this trust boundary: the fingerprint against core's canonical regex,
 * the key type against a length and charset bound (it is server-controlled bytes
 * the CLI carried as a JSON string). Anything malformed is a probe `error`, never
 * a partial result.
 *
 * @internal exported for testing
 */
export function parseProbeStdout(stdout: string): SftpProbeResult {
  const line = stdout.trim();
  if (line.length === 0) return { kind: "error" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { kind: "error" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    return { kind: "error" };
  const record = parsed as Record<string, unknown>;
  const fingerprint = record["fingerprint"];
  const keyType = record["key_type"];
  if (
    typeof fingerprint !== "string" ||
    !HOST_KEY_FINGERPRINT_REGEX.test(fingerprint)
  )
    return { kind: "error" };
  if (
    typeof keyType !== "string" ||
    keyType.length === 0 ||
    keyType.length > MAX_KEY_TYPE_LENGTH ||
    !KEY_TYPE_CHARSET.test(keyType)
  )
    return { kind: "error" };
  return { kind: "ok", fingerprint, keyType };
}

/**
 * Spawn the CLI's `probe-host-key` subcommand and reconcile its outcome. The argv
 * is a fixed template plus the server-built `sftp://` URL, passed as an array with
 * no shell -- exactly the no-shell / allowlisted-argv discipline `runCliChild`
 * uses -- so no value is ever an interpretable token. stdout is capped and parsed;
 * stderr is DISCARDED (drained so the pipe never blocks the child, but never read
 * or forwarded, since it can carry server-controlled bytes). The watchdog bounds
 * the child's lifetime independently of its own connect timeout.
 *
 * The URL build can throw only on a host that never passed the bare-host predicate
 * (a caller bug); it surfaces as a rejected promise the caller maps to a 500.
 */
export function probeSftpHostKey(args: {
  host: string;
  port?: number;
  binaryPath: string;
  childEnv?: NodeJS.ProcessEnv;
  sigtermMs?: number;
  sigkillGraceMs?: number;
}): Promise<SftpProbeResult> {
  const url = buildSftpProbeUrl(args.host, args.port);
  const argv: Array<string> = [
    args.binaryPath,
    "probe-host-key",
    url,
    "--json",
    "--connect-timeout",
    PROBE_CONNECT_TIMEOUT,
  ];

  return new Promise<SftpProbeResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, argv, {
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        env: { ...sanitizedChildEnv(), ...args.childEnv },
      });
    } catch {
      resolve({ kind: "error" });
      return;
    }

    let stdout = "";
    let stdoutOverflow = false;
    const out = child.stdout;
    if (out !== null) {
      out.setEncoding("utf8");
      out.on("data", (chunk: string) => {
        if (stdoutOverflow) return;
        stdout += chunk;
        if (stdout.length > PROBE_STDOUT_CAP) {
          stdoutOverflow = true;
          stdout = "";
        }
      });
    }
    // Discard stderr entirely: it can carry server-controlled bytes and must
    // never reach the client. Drain it so a chatty child's pipe never fills and
    // blocks, but never read or forward it.
    child.stderr?.resume();

    let timedOut = false;
    let settled = false;
    const timers: Array<NodeJS.Timeout> = [];
    const clearTimers = (): void => {
      for (const timer of timers) clearTimeout(timer);
    };
    const settle = (result: SftpProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve(result);
    };

    // Watchdog: SIGTERM at the budget so latency stays bounded above the child's
    // own readyTimeout, then SIGKILL if it ignores the term. Mirrors the
    // cancel-escalation chain in jobManager.ts.
    const toSigterm = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      const toSigkill = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
      }, args.sigkillGraceMs ?? PROBE_SIGKILL_GRACE_MS);
      toSigkill.unref();
      timers.push(toSigkill);
    }, args.sigtermMs ?? PROBE_SIGTERM_MS);
    toSigterm.unref();
    timers.push(toSigterm);

    child.on("error", () => settle({ kind: "error" }));
    child.on("close", (code) => {
      if (timedOut) {
        settle({ kind: "timeout" });
        return;
      }
      settle(reconcileProbeExit(code, stdoutOverflow ? undefined : stdout));
    });
  });
}
