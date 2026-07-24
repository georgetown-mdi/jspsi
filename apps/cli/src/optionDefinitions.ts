import type { Argv, Arguments } from "yargs";
import logLibrary from "loglevel";

import {
  DEFAULT_POLLING_FREQUENCY_MS,
  HOST_KEY_FINGERPRINT_REGEX,
  MAX_RECONNECT_ATTEMPTS,
  UsageError,
} from "@psilink/core";
import type { ConnectionConfig } from "@psilink/core";

import { type ConnectionOverrides, DEFAULT_CONFIG_PATH } from "./config";
import { DEFAULT_KEY_PATH } from "./keyFile";
import {
  durationFlagMs,
  durationFlagSeconds,
  LOG_LEVELS,
  MAX_TIMEOUT_SECONDS,
  nonNegativeIntFlag,
  singleValue,
} from "./util/cli";
import { DURATION_VALUE_HELP, FINE_DURATION_VALUE_HELP } from "./util/duration";
import { resolveHostKeyFingerprintRef } from "./util/atSignRefs";

/**
 * Upper bound for `--server-port`, matching the config schema's own
 * `z.int().min(0).max(65535)` bound on `server.port` (see
 * `packages/core/src/config/connection.ts`) so the CLI parse boundary and the
 * schema reject the same range.
 */
export const MAX_PORT = 65535;

/**
 * Read `--server-host-key-fingerprint` from parsed `Arguments`, resolving an
 * `@file` reference and validating the result against
 * {@link HOST_KEY_FINGERPRINT_REGEX} before it reaches a connection -- a
 * malformed value is rejected here, at parse time, as a {@link UsageError} (CLI
 * exit 64), the same "reject loudly before any connection is attempted"
 * contract {@link nonNegativeIntFlag} and {@link durationFlagSeconds} give
 * their flags, rather than surfacing later as a confusing host-key mismatch at
 * connect time.
 *
 * The `@file` read and re-validation are {@link resolveHostKeyFingerprintRef}
 * -- the same helper the config-load path applies to an `@`-authored
 * `host_key_fingerprint` -- so a pre-pinned CLI value and a pre-pinned config
 * value are checked identically, and its failure names the reference. A
 * literal value passes through that helper unvalidated (no earlier schema saw
 * it), so its format check follows here, flag-named. Rejects a repeat (via
 * {@link singleValue}) before either step.
 */
export function hostKeyFingerprintFlag(argv: Arguments): string | undefined {
  const raw = singleValue(argv, "server-host-key-fingerprint");
  if (raw === undefined) return undefined;
  if (typeof raw !== "string")
    throw new UsageError(
      "--server-host-key-fingerprint must be a string; got " + String(raw),
    );
  const resolved = resolveHostKeyFingerprintRef(raw);
  // Only a literal can still be malformed here: an @-resolved value already
  // passed the same regex inside the shared resolver, with a reference-naming
  // error on failure.
  if (!HOST_KEY_FINGERPRINT_REGEX.test(resolved))
    throw new UsageError(
      "--server-host-key-fingerprint must be in OpenSSH SHA256 format: the " +
        "SHA256: prefix followed by 43 unpadded standard base64 characters " +
        "(the value ssh-keygen -lf prints, or the fingerprint shown by a " +
        "prior interactive psilink run)",
    );
  return resolved;
}

/**
 * Per-command overrides for the descriptions of the common bootstrap options
 * whose accurate wording is command-specific -- chiefly whether the config/key
 * files are written or read, and whether the `server-*` (and `peer-id`)
 * overrides apply to a connection URL or to a loaded config. Keyed by the yargs
 * option name; an absent key keeps the default (`invite`/`accept`) wording. Only
 * the describe text varies -- the option name, type, alias, and default live
 * once in {@link addCommonBootstrapOptions}, so a new common flag is added there
 * alone and appears in every command.
 */
export type CommonBootstrapDescribeOverrides = Partial<
  Record<
    | "config-file"
    | "key-file"
    | "server-port"
    | "server-username"
    | "server-password"
    | "server-private-key"
    | "server-private-key-passphrase"
    | "server-keyboard-interactive"
    | "server-host-key-fingerprint"
    | "peer-id"
    | "timestamp-in-filename"
    | "retain-files"
    | "outbound-path",
    string
  >
>;

/**
 * Add the options common to the bootstrap-style commands (config/key paths,
 * identity, SFTP credential overrides, connection/exchange tuning, logging,
 * recording). Positionals and command-specific options (`accept-timeout` for
 * `invite`, `save`/sweep controls for `zero-setup`/`exchange`) are added by each
 * command's own builder. `describe` lets a command supply accurate wording for
 * the few options whose meaning differs from the `invite`/`accept` default --
 * e.g. `exchange` reads a config and has no URL, so its `server-*` text names
 * the config rather than the URL.
 */
export function addCommonBootstrapOptions(
  cmd: Argv,
  describe: CommonBootstrapDescribeOverrides = {},
): Argv {
  return cmd
    .option("config-file", {
      type: "string",
      describe:
        describe["config-file"] ??
        `where to write psilink.yaml (default: ${DEFAULT_CONFIG_PATH})`,
    })
    .option("key-file", {
      type: "string",
      describe:
        describe["key-file"] ??
        `where to write .psilink.key (default: ${DEFAULT_KEY_PATH})`,
    })
    .option("identity", {
      type: "string",
      describe: "identity string for this party (name, org, contact)",
    })
    .option("server-port", {
      type: "number",
      describe:
        describe["server-port"] ?? "server port; overrides the port in URL",
    })
    .option("server-username", {
      type: "string",
      describe:
        describe["server-username"] ??
        "server username; overrides the username in URL",
    })
    .option("server-password", {
      type: "string",
      describe:
        describe["server-password"] ??
        "server password; use @path to read from file; overrides the " +
          "password in URL",
    })
    .option("server-private-key", {
      type: "string",
      describe:
        describe["server-private-key"] ??
        "SSH private key; use @path to read from file",
    })
    .option("server-private-key-passphrase", {
      type: "string",
      describe:
        describe["server-private-key-passphrase"] ??
        "passphrase for an encrypted SSH private key; use @path to read from " +
          "file; requires --server-private-key",
    })
    .option("server-keyboard-interactive", {
      type: "boolean",
      describe:
        describe["server-keyboard-interactive"] ??
        "answer the server's keyboard-interactive prompts with the password; " +
          "requires a password. Enable for a server that rejects the direct " +
          "password method but accepts the same password over " +
          "keyboard-interactive",
    })
    .option("server-host-key-fingerprint", {
      type: "string",
      describe:
        describe["server-host-key-fingerprint"] ??
        "pre-pin the server's SSH host-key fingerprint (OpenSSH SHA256 " +
          "format, e.g. SHA256:abc...xyz; the value ssh-keygen -lf prints, or " +
          "the fingerprint shown by a prior interactive psilink run); use " +
          "@path to read from file. Lets an unattended (non-interactive) run " +
          "connect without the interactive trust prompt; a server presenting a " +
          "different key still fails closed",
    })
    .option("connection-timeout", {
      type: "string",
      describe:
        "how long to wait when connecting to the primary exchange server " +
        `(maximum: ${MAX_TIMEOUT_SECONDS / 86_400}d). ` +
        DURATION_VALUE_HELP,
    })
    .option("peer-timeout", {
      alias: "t",
      type: "string",
      describe:
        "how long to wait for the peer before giving up " +
        `(maximum: ${MAX_TIMEOUT_SECONDS / 86_400}d). ` +
        DURATION_VALUE_HELP,
    })
    .option("polling-frequency", {
      type: "string",
      describe:
        "how often to poll the shared directory for the partner's files on " +
        "the sftp/filedrop channels (default: 5s); overrides " +
        "connection.options.poll_interval_ms. A conservative default keeps " +
        "within SFTP servers' anti-flood limits; a sub-second value is " +
        "accepted for a demo against a controlled server but warns. " +
        FINE_DURATION_VALUE_HELP,
    })
    .option("max-reconnect-attempts", {
      type: "number",
      describe:
        "how many times to retry dialing the connection within a single " +
        "connect attempt after a fast transient failure; default: 3. The same " +
        "value also caps the cumulative number of mid-exchange reconnections in " +
        "the default held-session mode: once that many session drops have been " +
        "re-dialed, the exchange fails terminally (raise it for a flaky link, or " +
        "use connection-per-poll for a server that caps session lifetime). " +
        "Connection-per-poll mode is not subject to that count, and the teardown " +
        "abort-marker write is not charged against it.",
    })
    .option("log-level", {
      type: "string",
      describe: "silent | error | warn | info | debug | trace; default=info",
    })
    .option("log-file", {
      type: "string",
      describe:
        "append all log output to this file instead of the terminal; the " +
        "parent directory must already exist",
    })
    .option("record", {
      type: "boolean",
      default: true,
      describe:
        "after a successful exchange, write a self-attested audit record (a " +
        "local artifact, not a signed receipt) and its private verification " +
        "keys; use --no-record to skip",
    })
    .option("record-file", {
      type: "string",
      describe:
        "path for the audit record (default: ./psilink-record-<timestamp>." +
        "json); the private verification keys are written alongside it as " +
        "<name>.keys.json",
    })
    .option("event-stream", {
      type: "boolean",
      describe:
        "emit a machine-readable NDJSON event stream on file descriptor 3 for a " +
        "supervising process: stage transitions, warnings, and one terminal " +
        "result/error event carrying a classified category (exchange, output, " +
        "security, config). stdout (the CSV result) and stderr (human logs) are " +
        "unchanged. Fails fast (exit 64) if fd 3 is not wired. No effect on an " +
        "offline invite/accept, which runs no exchange. See docs/spec/CLI_EVENTS.md",
    })
    .option("lockless-rendezvous", {
      type: "boolean",
      describe:
        "use the ack-handshake rendezvous instead of the atomic lock-file " +
        "race; required on sync-mediated transports that lack atomic " +
        "exclusive-create or deletion visibility during rendezvous. Both " +
        "parties must set this flag identically",
    })
    .option("peer-id", {
      type: "string",
      describe:
        describe["peer-id"] ??
        "stable identifier for this party; appears in filenames and logs. " +
          "Requires timestamp_in_filename: true. Both parties must use " +
          "distinct ids",
    })
    .option("timestamp-in-filename", {
      type: "boolean",
      describe:
        describe["timestamp-in-filename"] ??
        "encode a UTC timestamp and per-session counter in each outgoing " +
          "message filename; --retain-files implies it. Both parties must use " +
          "the same value",
    })
    .option("retain-files", {
      type: "boolean",
      describe:
        describe["retain-files"] ??
        "keep all exchange files as a permanent transcript instead of " +
          "deleting them after consumption. Requires --timestamp-in-filename. " +
          "Both parties must set this flag identically",
    })
    .option("connection-per-poll", {
      type: "boolean",
      describe:
        "open a fresh SFTP session for each poll cycle instead of holding one " +
        "session for the whole exchange; the session is released before the loop " +
        "goes idle. Use it when the partner's SFTP server caps session lifetime " +
        "and the exchange spans many idle poll gaps. This is an SFTP-only, purely " +
        "local dialing choice that the peer does not observe, so each party sets " +
        "it independently. Pair it with a long --polling-frequency, since a fresh " +
        "SSH handshake per cycle is wasteful at a seconds-scale interval",
    })
    .option("outbound-path", {
      type: "string",
      describe:
        describe["outbound-path"] ??
        "use a separate outbound directory: the URL/positional path becomes " +
          "the inbound (peer-written) directory and this is the outbound " +
          "(self-written) directory, for managed shares and SFTP servers with " +
          "distinct drop and pickup folders. Requires --retain-files; the two " +
          "directories must differ. Leave unset for a single shared directory. " +
          "Each party sets its own directories",
    })
    .option("verbose", {
      alias: "v",
      type: "count",
      describe:
        "generate additional logging information for sub-libraries at all " +
        "logging levels",
    });
}

/** The options common to `invite` and `accept`, parsed from yargs `Arguments`. */
export interface CommonBootstrapOptions {
  configFile: string;
  keyFile: string;
  identity?: string;
  serverPort?: number;
  serverUsername?: string;
  serverPassword?: string;
  serverPrivateKey?: string;
  serverPrivateKeyPassphrase?: string;
  serverKeyboardInteractive?: boolean;
  /**
   * Pre-pinned host-key fingerprint from `--server-host-key-fingerprint`,
   * already resolved (`@file`) and format-validated by
   * {@link hostKeyFingerprintFlag}. Feeds `connection.server.hostKeyFingerprint`
   * so {@link establishHostKeyTrust} finds a pin already set and skips the
   * interactive prompt; the real connection then verifies it exactly as a
   * stored pin, so a wrong value still fails closed. See hostKeyTrust.ts.
   */
  serverHostKeyFingerprint?: string;
  connectionTimeout?: number;
  peerTimeout?: number;
  // The --polling-frequency override, in MILLISECONDS (not seconds like the two
  // timeout fields above): the poll interval is millisecond-scaled and accepts a
  // sub-second value, so it carries its native unit through to the connection's
  // pollIntervalMs without a lossy seconds round-trip.
  pollingFrequencyMs?: number;
  maxReconnectAttempts?: number;
  locklessRendezvous?: boolean;
  peerId?: string;
  timestampInFilename?: boolean;
  retainFiles?: boolean;
  connectionPerPoll?: boolean;
  outboundPath?: string;
  record: boolean;
  recordFile?: string;
  // Opt-in NDJSON machine-interface stream on fd 3 (see eventStream.ts). A
  // boolean toggle; when absent nothing is ever written to fd 3.
  eventStream: boolean;
  logLevel: logLibrary.LogLevelNumbers;
  logFile?: string;
  verbosity: number;
}

/** Parse the {@link CommonBootstrapOptions} from yargs `Arguments`. */
export function parseCommonBootstrapArgs(
  argv: Arguments,
): CommonBootstrapOptions {
  const rawLogLevel = (
    (singleValue(argv, "log-level") as string | undefined) || "info"
  ).toLowerCase();
  const logLevel = LOG_LEVELS[rawLogLevel];
  if (logLevel === undefined)
    throw new UsageError(`unrecognized log-level: ${argv["log-level"]}`);

  // Each single-value (string/number) option is read through singleValue so a
  // repeated flag is rejected with a clean usage error before its array value
  // reaches a cast that lies about the type. The boolean and count options
  // (lockless-rendezvous, timestamp-in-filename, retain-files, record, verbose)
  // keep their plain casts: a repeat is valid for them.
  return {
    configFile:
      (singleValue(argv, "config-file") as string | undefined) ??
      DEFAULT_CONFIG_PATH,
    keyFile:
      (singleValue(argv, "key-file") as string | undefined) ?? DEFAULT_KEY_PATH,
    identity: singleValue(argv, "identity") as string | undefined,
    serverPort: nonNegativeIntFlag(argv, "server-port", MAX_PORT),
    serverUsername: singleValue(argv, "server-username") as string | undefined,
    // Credential values are carried through verbatim; an `@path` ref is read only
    // at the live-use boundary (resolveConnectionCredentials in
    // runOnlineBootstrap), so a persisted config keeps the `@path`, not the
    // resolved secret.
    serverPassword: singleValue(argv, "server-password") as string | undefined,
    serverPrivateKey: singleValue(argv, "server-private-key") as
      string | undefined,
    serverPrivateKeyPassphrase: singleValue(
      argv,
      "server-private-key-passphrase",
    ) as string | undefined,
    // Boolean toggle, so it keeps a plain cast (a repeat is valid, like the other
    // boolean flags); yargs yields true only when the enabling form is passed.
    serverKeyboardInteractive: argv["server-keyboard-interactive"] as
      boolean | undefined,
    // Unlike the credential flags above, a host-key fingerprint is non-secret and
    // carries no "keep the @path out of the saved config" concern -- resolved (and
    // format-validated) here at parse time, same as the config-load path already
    // does for an @-authored host_key_fingerprint (resolveHostKeyFingerprintRef).
    serverHostKeyFingerprint: hostKeyFingerprintFlag(argv),
    connectionTimeout: durationFlagSeconds(
      argv,
      "connection-timeout",
      MAX_TIMEOUT_SECONDS,
    ),
    peerTimeout: durationFlagSeconds(argv, "peer-timeout", MAX_TIMEOUT_SECONDS),
    // Read in milliseconds (durationFlagMs, not durationFlagSeconds) so a
    // sub-second demo value survives; no product ceiling -- a large poll interval
    // is only slow, and the schema field imposes no maximum (see durationFlagMs).
    pollingFrequencyMs: durationFlagMs(argv, "polling-frequency"),
    maxReconnectAttempts: nonNegativeIntFlag(
      argv,
      "max-reconnect-attempts",
      MAX_RECONNECT_ATTEMPTS,
    ),
    locklessRendezvous: argv["lockless-rendezvous"] as boolean | undefined,
    peerId: singleValue(argv, "peer-id") as string | undefined,
    timestampInFilename: argv["timestamp-in-filename"] as boolean | undefined,
    retainFiles: argv["retain-files"] as boolean | undefined,
    // Boolean toggle, so it keeps a plain cast (a repeat is valid, last-one-wins);
    // yargs yields true only when the enabling form is passed.
    connectionPerPoll: argv["connection-per-poll"] as boolean | undefined,
    outboundPath: singleValue(argv, "outbound-path") as string | undefined,
    // yargs sets `record` to false on --no-record and true by the option's
    // default otherwise, so it is always a boolean here.
    record: argv["record"] as boolean,
    recordFile: singleValue(argv, "record-file") as string | undefined,
    // Boolean toggle: a repeat is valid (last-one-wins), so read it directly.
    // yargs yields true only when --event-stream is passed; default off.
    eventStream: argv["event-stream"] === true,
    logLevel,
    logFile: singleValue(argv, "log-file") as string | undefined,
    verbosity: (argv["verbose"] as number | undefined) ?? 0,
  };
}

/**
 * The subset of parsed common options {@link connectionOverridesFrom} reads. A
 * `Pick` rather than the full {@link CommonBootstrapOptions} so the command
 * `Options` shapes that carry only the override fields (exchange's, zero-setup's)
 * also satisfy it; the full options object is assignable to it too.
 */
export type ConnectionOverrideOptions = Pick<
  CommonBootstrapOptions,
  | "connectionTimeout"
  | "peerTimeout"
  | "pollingFrequencyMs"
  | "maxReconnectAttempts"
  | "serverUsername"
  | "serverPassword"
  | "serverPrivateKey"
  | "serverPrivateKeyPassphrase"
  | "serverKeyboardInteractive"
  | "serverHostKeyFingerprint"
  | "serverPort"
  | "locklessRendezvous"
  | "peerId"
  | "timestampInFilename"
  | "retainFiles"
  | "connectionPerPoll"
  | "outboundPath"
>;

/**
 * Map the parsed (flat) common options to the structured connection-override
 * shape, fanning the `server-*`/`--outbound-path` flags into the server
 * sub-group and the timeout/toggle flags into the options sub-group. The
 * synthesized `extra.peerTimeout` (from `--accept-timeout` on the online invite
 * path) belongs to the options sub-group and takes precedence over the parsed
 * `--peer-timeout`.
 */
export function connectionOverridesFrom(
  options: ConnectionOverrideOptions,
  extra: { peerTimeout?: number } = {},
): ConnectionOverrides {
  return {
    server: {
      username: options.serverUsername,
      password: options.serverPassword,
      privateKey: options.serverPrivateKey,
      privateKeyPassphrase: options.serverPrivateKeyPassphrase,
      keyboardInteractive: options.serverKeyboardInteractive,
      hostKeyFingerprint: options.serverHostKeyFingerprint,
      port: options.serverPort,
      outboundPath: options.outboundPath,
    },
    options: {
      connectionTimeout: options.connectionTimeout,
      peerTimeout: extra.peerTimeout ?? options.peerTimeout,
      // Already in milliseconds -- fed straight into the connection's
      // pollIntervalMs by applyConnectionOverrides, with no seconds scaling.
      pollIntervalMs: options.pollingFrequencyMs,
      maxReconnectAttempts: options.maxReconnectAttempts,
      locklessRendezvous: options.locklessRendezvous,
      peerId: options.peerId,
      timestampInFilename: options.timestampInFilename,
      retainFiles: options.retainFiles,
      connectionPerPoll: options.connectionPerPoll,
    },
  };
}

/**
 * Warn that the file-sync-only flags (`--lockless-rendezvous`, `--retain-files`,
 * `--polling-frequency`) have no effect on a channel that is not `sftp` or
 * `filedrop`, naming whichever flags the caller actually set. The channel is
 * taken as input so the one helper serves both call sites: `exchange` derives it
 * from the loaded connection (post-override), `zero-setup` from the server URL
 * (pre-connection). A file-sync channel warns for none of them. Shared so the
 * wording cannot drift between the two commands.
 *
 * `--connection-per-poll` is the exception to "file-sync": it is SFTP-only (the
 * ephemeral-session mode dials a real SFTP socket, which filedrop's
 * connectionless client has none of), so it warns on any non-`sftp` channel --
 * INCLUDING `filedrop`, where the other three are silent -- and is therefore
 * checked before the file-sync early return below. Warn-not-block, per the
 * trusted-operator posture.
 *
 * `--polling-frequency` belongs here because `pollIntervalMs` is a FileSyncOptions
 * field {@link applyConnectionOverrides} applies only on `sftp`/`filedrop`, so on
 * a non-file-sync channel the override is dropped exactly as the two toggles are;
 * this is where its ignored-flag warning lives, and {@link warnLowPollingFrequency}
 * (the aggressively-low advisory) is correspondingly a no-op off those channels so
 * the two never both fire.
 *
 * `--outbound-path` is deliberately NOT one of these flags: unlike the silently-
 * ignored options above, it is a hard error on a non-file-sync channel (the
 * URL-driven commands reject a webrtc URL before overrides apply, and
 * applyConnectionOverrides throws on a webrtc config), so it needs no
 * "ignored" warning -- a warning here would falsely promise it was tolerated.
 */
export function warnUnsupportedFileSyncFlags(
  channel: ConnectionConfig["channel"],
  flags: {
    locklessRendezvous?: boolean;
    retainFiles?: boolean;
    pollingFrequencyMs?: number;
    connectionPerPoll?: boolean;
  },
  log: { warn: (message: string) => void },
): void {
  // SFTP-only, so it warns on filedrop too (unlike the three below) -- checked
  // before the file-sync early return.
  if (channel !== "sftp" && flags.connectionPerPoll === true)
    log.warn(
      `--connection-per-poll has no effect on the ${channel} channel and will ` +
        "be ignored; it is only supported on sftp",
    );
  if (channel === "sftp" || channel === "filedrop") return;
  if (flags.locklessRendezvous === true)
    log.warn(
      `--lockless-rendezvous has no effect on the ${channel} channel and will ` +
        "be ignored; it is only supported on sftp and filedrop",
    );
  if (flags.retainFiles === true)
    log.warn(
      `--retain-files has no effect on the ${channel} channel and will be ` +
        "ignored; it is only supported on sftp and filedrop",
    );
  // A number gate (not `=== true`): pollingFrequencyMs is set or unset, with no
  // negated CLI form to fold to a default the way the boolean toggles have.
  if (flags.pollingFrequencyMs !== undefined)
    log.warn(
      `--polling-frequency has no effect on the ${channel} channel and will be ` +
        "ignored; it is only supported on sftp and filedrop",
    );
}

/**
 * Millisecond threshold below which a `--polling-frequency` override draws the
 * anti-flood warning ({@link warnLowPollingFrequency}). One second: at or above
 * it a poll cadence stays within the anti-flood budgets commercial SFTP servers
 * enforce, so it is silent; below it the operator is warned but not blocked (a
 * demo against a controlled server legitimately wants a sub-second poll).
 */
export const LOW_POLLING_FREQUENCY_WARN_MS = 1000;

/**
 * Warn -- but do not block -- when a `--polling-frequency` override is set
 * aggressively low (below {@link LOW_POLLING_FREQUENCY_WARN_MS}), because a
 * sub-second poll hammers the shared directory with listings and can trip a
 * commercial SFTP server's anti-flood/DoS protection and drop the connection (the
 * partner-deployment failure that motivated the conservative default). There is
 * deliberately no hard floor: a demo against a controlled server may want ~100ms.
 * A no-op when the flag is absent or at/above the threshold, so a conservative
 * value emits nothing.
 *
 * A no-op on a non-file-sync `channel`: `pollIntervalMs` is applied only on
 * `sftp`/`filedrop` (see {@link applyConnectionOverrides}), so on any other
 * channel the override is dropped and its ignored-flag warning is emitted by
 * {@link warnUnsupportedFileSyncFlags} instead -- the aggressively-low advisory
 * here would be misleading, since no poll ever runs at that rate. `channel` is
 * `undefined` when the command could not resolve one (an unknown URL scheme in
 * zero-setup), which is likewise not a file-sync channel, so it no-ops too.
 *
 * Scoped to the CLI override value (the parsed `pollingFrequencyMs`), not the
 * effective merged interval: a low value already sitting in a loaded config's
 * `pollIntervalMs` is the operator's committed choice and is not re-litigated on
 * every run. The interpolated value is the operator's own numeric flag argument
 * (non-secret), so echoing it is safe. Called on the paths where the override
 * actually takes effect (zero-setup, `exchange`, and the ONLINE invite/accept);
 * the offline paths route `--polling-frequency` through
 * {@link warnOptionsOverridesIgnoredOffline} instead, since it is dropped there.
 */
export function warnLowPollingFrequency(
  channel: ConnectionConfig["channel"] | undefined,
  pollingFrequencyMs: number | undefined,
  log: { warn: (message: string) => void },
): void {
  if (channel !== "sftp" && channel !== "filedrop") return;
  if (
    pollingFrequencyMs === undefined ||
    pollingFrequencyMs >= LOW_POLLING_FREQUENCY_WARN_MS
  )
    return;
  log.warn(
    `--polling-frequency ${pollingFrequencyMs}ms is below ` +
      `${LOW_POLLING_FREQUENCY_WARN_MS}ms; polling this aggressively may trip ` +
      "an SFTP server's anti-flood/DoS protection and drop the connection. Use " +
      "a sub-second interval only against a controlled server (for example a demo).",
  );
}

/**
 * Millisecond threshold below which pairing `--connection-per-poll` with the
 * poll interval draws the wasteful-dialing warning
 * ({@link warnConnectionPerPollShortInterval}). One minute: connection-per-poll
 * pays a full SSH handshake every cycle, which is negligible at the minutes-scale
 * interval the mode is meant for but wasteful at a seconds-scale one (the 5s
 * default included) -- the mode exists to survive a server session-lifetime cap
 * across long idle gaps, so it is only sane paired with a long interval (see
 * docs/notes/connection-per-poll-sftp.md). Higher than
 * {@link LOW_POLLING_FREQUENCY_WARN_MS}, which flags an aggressively-low poll for
 * anti-flood reasons; this flags a poll merely too short to justify per-cycle
 * dialing.
 */
export const CONNECTION_PER_POLL_SHORT_INTERVAL_WARN_MS = 60_000;

/**
 * Warn -- but do not block -- when `--connection-per-poll` is set with a poll
 * interval short enough that a fresh SSH handshake every cycle is wasteful
 * (below {@link CONNECTION_PER_POLL_SHORT_INTERVAL_WARN_MS}). The mode dials a new
 * session each cycle to survive a server's session-lifetime cap across long idle
 * gaps; that only pays off at a long interval, so a sub-minute effective interval
 * -- including the {@link DEFAULT_POLLING_FREQUENCY_MS} default when none is set --
 * draws this advisory pointing at a longer `--polling-frequency`. Warn-not-block,
 * per the trusted-operator posture: a controlled test may legitimately want it.
 *
 * A no-op unless the mode is effectively on and the channel is `sftp` (it is
 * SFTP-only; on any other channel {@link warnUnsupportedFileSyncFlags} reports it
 * ignored instead, and `undefined` -- an unresolved zero-setup URL scheme -- is
 * likewise not `sftp`). Reads the EFFECTIVE merged values, not just the CLI flag,
 * so a wasteful pairing sitting in a loaded `psilink.yaml` still warns on every
 * `exchange` run -- the mode's natural home is the persisted config for a
 * recurring slow-peer exchange, so a CLI-only scope would miss its main case. The
 * interpolated interval is the operator's own numeric value (non-secret), so
 * echoing it is safe.
 */
export function warnConnectionPerPollShortInterval(
  channel: ConnectionConfig["channel"] | undefined,
  connectionPerPoll: boolean | undefined,
  pollIntervalMs: number | undefined,
  log: { warn: (message: string) => void },
): void {
  if (channel !== "sftp" || connectionPerPoll !== true) return;
  const effectiveIntervalMs = pollIntervalMs ?? DEFAULT_POLLING_FREQUENCY_MS;
  if (effectiveIntervalMs >= CONNECTION_PER_POLL_SHORT_INTERVAL_WARN_MS) return;
  log.warn(
    `--connection-per-poll with a ${effectiveIntervalMs}ms poll interval opens ` +
      "a fresh SFTP session every cycle, paying a full SSH handshake each time; " +
      `that is wasteful below ${CONNECTION_PER_POLL_SHORT_INTERVAL_WARN_MS}ms. ` +
      "The mode exists to survive a server's session-lifetime cap across long " +
      "idle gaps, so pair it with a long --polling-frequency (minutes-scale); a " +
      "short interval is better served by the default held session.",
  );
}

/**
 * The server-block overrides that have no effect on an OFFLINE invite/accept,
 * read by {@link warnServerOverridesIgnoredOffline}. A structural subset of
 * {@link CommonBootstrapOptions} (which is assignable to it) holding the
 * `--server-*` flags and `--outbound-path`: the overrides {@link
 * applyConnectionOverrides} writes into `connection.server` (host/port/
 * credentials) and the channel's directory paths -- the connection's address and
 * credentials -- as opposed to the tuning/behavior fields it writes into
 * `connection.options`. This server block is what the offline placeholder stands
 * in for: {@link connectionFromEndpoint} writes a `REPLACE_WITH_...` host/username
 * stub, or a seeded host/port/path, so these are the overrides that would have
 * populated a field the operator edits. (The set carries the
 * username/password/private-key the placeholder marks for replacement, so it is
 * NOT the credential-free public {@link ConnectionEndpoint}, which omits them by
 * construction.)
 *
 * The tuning overrides (timeouts, `--max-reconnect-attempts`) and the file-sync
 * toggles (`--retain-files`, `--peer-id`, etc.) are ALSO dropped offline, but they
 * target the `connection.options` tuning/behavior fields, which the offline flow
 * never populates from an override -- a split seed pre-seeds only the fixed
 * retain-mode trio there ({@link SPLIT_SEED_OPTIONS}), never operator tuning. So
 * the right diagnostic for them is a differently-worded one ("set it under
 * connection.options"), tracked as a follow-up, not folded in here where it would
 * blur this message's "set the connection details in that block" remedy.
 */
export type OfflineIgnoredServerOverrides = Pick<
  CommonBootstrapOptions,
  | "serverUsername"
  | "serverPassword"
  | "serverPrivateKey"
  | "serverPrivateKeyPassphrase"
  | "serverKeyboardInteractive"
  | "serverHostKeyFingerprint"
  | "serverPort"
  | "outboundPath"
>;

/**
 * Warn that the server-block overrides (`--server-username`, `--server-password`,
 * `--server-private-key`, `--server-private-key-passphrase`,
 * `--server-keyboard-interactive`, `--server-host-key-fingerprint`,
 * `--server-port`, and `--outbound-path`) have no effect
 * on an OFFLINE invite/accept. Those paths write a placeholder (invite) or
 * invitation-endpoint-seeded (accept) connection block for the operator to edit
 * before `psilink exchange`, rather than building a connection from a URL the way
 * the online and zero-setup paths do -- so they go through {@link
 * connectionFromEndpoint}, which applies no connection overrides, and these flags
 * would otherwise be parsed and silently dropped. The warning names exactly the
 * flags the operator set; it is a no-op when none are set. Scoped to the server
 * block these overrides populate (see {@link OfflineIgnoredServerOverrides});
 * shared between invite and accept so the wording cannot drift, and so the whole
 * `--server-*`/`--outbound-path` set is treated uniformly rather than only the one
 * flag (`--outbound-path`) whose silent loss is the most surprising.
 */
export function warnServerOverridesIgnoredOffline(
  options: OfflineIgnoredServerOverrides,
  log: { warn: (message: string) => void },
): void {
  // Security invariant: push only the flag NAME, never the override value. A
  // --server-password / --server-private-key / --server-private-key-passphrase
  // value may be an inline secret (or an unresolved @path), and this warning
  // reaches the terminal and any --log-file; interpolating a value here would
  // leak it. Keep the emitted message static apart from this flag-name list.
  const ignored: string[] = [];
  if (options.serverUsername !== undefined) ignored.push("--server-username");
  if (options.serverPassword !== undefined) ignored.push("--server-password");
  if (options.serverPrivateKey !== undefined)
    ignored.push("--server-private-key");
  if (options.serverPrivateKeyPassphrase !== undefined)
    ignored.push("--server-private-key-passphrase");
  // Gate on `=== true`, not presence: yargs sets the negated form
  // (--no-server-keyboard-interactive) to false, which is also the default, so
  // only the enabling form was an override that could have done anything.
  if (options.serverKeyboardInteractive === true)
    ignored.push("--server-keyboard-interactive");
  if (options.serverHostKeyFingerprint !== undefined)
    ignored.push("--server-host-key-fingerprint");
  if (options.serverPort !== undefined) ignored.push("--server-port");
  if (options.outboundPath !== undefined) ignored.push("--outbound-path");
  if (ignored.length === 0) return;
  log.warn(
    `${ignored.join(", ")} ${ignored.length === 1 ? "has" : "have"} no effect ` +
      "on an offline invite/accept: the connection block is written for you to " +
      "edit (a placeholder, or seeded from the invitation endpoint), not built " +
      "from a URL. Set the connection details directly in that block -- the " +
      "server host/port/credentials, or the inbound_path/outbound_path split " +
      "directory -- before running 'psilink exchange', or pass these flags on " +
      "an online invite/accept, the zero-setup exchange, or 'psilink exchange'.",
  );
}

/**
 * The connection-OPTIONS overrides that have no effect on an OFFLINE
 * invite/accept, read by {@link warnOptionsOverridesIgnoredOffline}. A structural
 * subset of {@link CommonBootstrapOptions} (assignable to it) holding the
 * tuning/toggle flags {@link applyConnectionOverrides} writes into
 * `connection.options`: the SharedOptions timeouts/reconnect bound
 * (`--connection-timeout`, `--peer-timeout`, `--max-reconnect-attempts`), the
 * file-sync poll interval (`--polling-frequency`), and the file-sync toggles
 * (`--lockless-rendezvous`, `--peer-id`, `--retain-files`,
 * `--timestamp-in-filename`) -- HOW the exchange behaves, as opposed to the
 * server block's WHERE/credentials that {@link OfflineIgnoredServerOverrides}
 * covers.
 *
 * The offline placeholder has no `options` block on any channel (a split seed
 * pre-seeds only the fixed retain-mode trio there, {@link SPLIT_SEED_OPTIONS},
 * never operator tuning), so these overrides are parsed and silently dropped on
 * the offline paths. They are the `connection.options` half deliberately scoped
 * out of {@link OfflineIgnoredServerOverrides}: warning for them belongs
 * in a separate, differently-worded diagnostic ("set them under
 * connection.options") rather than folded into the server warning's "set the
 * connection details in that block" remedy.
 *
 * Note the synthesized `--accept-timeout` is NOT here: it feeds the override
 * bag's `peerTimeout` only through {@link connectionOverridesFrom}'s `extra` arg
 * on the ONLINE invite path. This read is of the parsed `peerTimeout` field
 * (`--peer-timeout`) directly, so an offline invite with `--accept-timeout` but
 * no `--peer-timeout` does not warn spuriously.
 */
export type OfflineIgnoredOptionsOverrides = Pick<
  CommonBootstrapOptions,
  | "connectionTimeout"
  | "peerTimeout"
  | "pollingFrequencyMs"
  | "maxReconnectAttempts"
  | "locklessRendezvous"
  | "peerId"
  | "timestampInFilename"
  | "retainFiles"
  | "connectionPerPoll"
>;

/**
 * Warn that the connection-OPTIONS overrides (`--connection-timeout`,
 * `--peer-timeout`, `--polling-frequency`, `--max-reconnect-attempts`,
 * `--lockless-rendezvous`, `--peer-id`, `--timestamp-in-filename`,
 * `--retain-files`, `--connection-per-poll`) have no effect on an
 * OFFLINE invite/accept. Like the server-block overrides those paths go through
 * {@link connectionFromEndpoint}, which applies no connection overrides, but
 * these target `connection.options` -- a block the offline placeholder does not
 * contain on any channel -- so they would otherwise be parsed and silently
 * dropped. The warning names exactly the flags the operator set; it is a no-op
 * when none are set.
 *
 * Kept distinct from {@link warnServerOverridesIgnoredOffline}: that one's remedy
 * is "set the connection details in that block" (host/port/credentials/paths),
 * whereas these land under `connection.options`, so the remedy wording points
 * there instead. Shared between invite and accept so the wording cannot drift.
 */
export function warnOptionsOverridesIgnoredOffline(
  options: OfflineIgnoredOptionsOverrides,
  log: { warn: (message: string) => void },
): void {
  // Security invariant: push only the flag NAME, never the override value. This
  // warning reaches the terminal and any --log-file, so interpolating a value
  // here would leak it. None of these flags is a secret today, but --peer-id is
  // an operator-supplied free string and the set may grow, so keep the emitted
  // message static apart from this flag-name list -- the same discipline
  // warnServerOverridesIgnoredOffline holds for its --server-password/-key.
  const ignored: string[] = [];
  if (options.connectionTimeout !== undefined)
    ignored.push("--connection-timeout");
  if (options.peerTimeout !== undefined) ignored.push("--peer-timeout");
  if (options.pollingFrequencyMs !== undefined)
    ignored.push("--polling-frequency");
  if (options.maxReconnectAttempts !== undefined)
    ignored.push("--max-reconnect-attempts");
  // The three toggles gate on `=== true`, not presence: yargs sets the negated
  // form (--no-retain-files etc.) to `false`, and `false` is the default a fresh
  // placeholder already carries, so only the enabling form was an override that
  // could have done something. This matches warnUnsupportedFileSyncFlags's
  // `=== true` gate on the same toggles and avoids a warning that names
  // --retain-files when the operator actually typed --no-retain-files.
  if (options.locklessRendezvous === true)
    ignored.push("--lockless-rendezvous");
  if (options.peerId !== undefined) ignored.push("--peer-id");
  if (options.timestampInFilename === true)
    ignored.push("--timestamp-in-filename");
  if (options.retainFiles === true) ignored.push("--retain-files");
  if (options.connectionPerPoll === true) ignored.push("--connection-per-poll");
  if (ignored.length === 0) return;
  log.warn(
    `${ignored.join(", ")} ${ignored.length === 1 ? "has" : "have"} no effect ` +
      "on an offline invite/accept: the connection block is written for you to " +
      "edit (a placeholder, or seeded from the invitation endpoint), and these " +
      "tuning options are not applied to it. Set them under connection.options " +
      "in the written config before running 'psilink exchange', or pass these " +
      "flags on an online invite/accept, the zero-setup exchange, or 'psilink " +
      "exchange'.",
  );
}
