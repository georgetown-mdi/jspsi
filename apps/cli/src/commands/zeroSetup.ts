import type { Argv, Arguments } from "yargs";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import logLibrary from "loglevel";
import { userInfo } from "node:os";

import {
  getLogger,
  loadCSVFile,
  prepareForExchange,
  sanitizeErrorForDisplay,
  UsageError,
} from "@psilink/core";
import type {
  ConnectionConfig,
  ExchangeBootstrapResult,
  ExchangeSpec,
  FileDropConnectionConfig,
  SFTPConnectionConfig,
  PreparedExchange,
} from "@psilink/core";

import {
  applyConnectionOverrides,
  announceRetainMode,
  assertRetainSweepGuard,
  saveConfig,
  DEFAULT_CONFIG_PATH,
} from "../config";
import { detectFileConflicts, expandTilde } from "../fileUtils";
import { DEFAULT_KEY_PATH } from "../keyFile";
import { resolveRecordOutput } from "../recordFile";
import { resolveConnectionCredentials } from "../util/atSignRefs";
import { LOG_LEVELS, singleValue, validateInputFile } from "../util/cli";
import { runProtocol, type ProtocolConnectionConfig } from "../protocol";
import { assertNoProvisionConflicts, provisionConfigAndKey } from "./provision";

export function builder(cmd: Argv): Argv {
  return cmd
    .usage(
      "Usage:\n" +
        "  $0 [--save] [options] URL INPUT_FILE [OUTPUT_FILE]\n\n" +
        "Arguments:\n" +
        "  URL          server URL (sftp:// or ws://)\n" +
        "  INPUT_FILE   CSV to link; use `-` to read from stdin\n" +
        "  OUTPUT_FILE  where to write results; defaults to stdout\n\n" +
        "Both parties run this command against the same server URL. Linkage\n" +
        "terms are inferred from each party's input file. No configuration\n" +
        "files are required or written by default.",
    )
    .option("save", {
      type: "boolean",
      default: false,
      describe:
        "save exchange config and establish a shared secret for future " +
        "recurring exchanges",
    })
    .option("config-file", {
      type: "string",
      describe:
        "where to write psilink.yaml when --save is given (default: " +
        DEFAULT_CONFIG_PATH +
        ")",
    })
    .option("key-file", {
      type: "string",
      describe:
        "where to write .psilink.key when --save is given (default: " +
        DEFAULT_KEY_PATH +
        ")",
    })
    .option("identity", {
      type: "string",
      describe: "identity string for this party (name, org, contact)",
    })
    .option("server-port", {
      type: "number",
      describe: "server port; overrides the port in URL",
    })
    .option("server-username", {
      type: "string",
      describe: "server username; overrides the username in URL",
    })
    .option("server-password", {
      type: "string",
      describe:
        "server password; use @path to read from file; overrides the " +
        "password in URL",
    })
    .option("server-private-key", {
      type: "string",
      describe: "SSH private key; use @path to read from file",
    })
    .option("connection-timeout", {
      type: "number",
      describe: "seconds to wait when connecting to primary exchange server",
    })
    .option("peer-timeout", {
      alias: "t",
      type: "number",
      describe: "seconds to wait for peer before giving up",
    })
    .option("max-reconnect-attempts", {
      type: "number",
      describe: "maximum reconnection attempts before giving up; default: 3",
    })
    .option("log-level", {
      type: "string",
      describe: "silent | error | warn | info | debug | trace; default=info",
    })
    .option("record", {
      type: "boolean",
      default: true,
      describe:
        "after a successful exchange, write a self-attested audit record (a " +
        "local artifact, not a signed receipt) and its private opening file; " +
        "use --no-record to skip",
    })
    .option("record-file", {
      type: "string",
      describe:
        "path for the audit record (default: ./psilink-record-<timestamp>." +
        "json); the private opening data is written alongside it as " +
        "<name>.opening.json",
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
        "stable identifier for this party; appears in filenames and logs. " +
        "Requires timestamp_in_filename: true. Both parties must use " +
        "distinct ids",
    })
    .option("timestamp-in-filename", {
      type: "boolean",
      describe:
        "encode a UTC timestamp and per-session counter in each outgoing " +
        "message filename; --retain-files implies it, so it need not be passed " +
        "explicitly. Both parties must use the same value",
    })
    .option("retain-files", {
      type: "boolean",
      describe:
        "keep all exchange files as a permanent transcript instead of " +
        "deleting them after consumption; intended for sync-mediated " +
        "transports that do not propagate deletions and for audit use cases. " +
        "Requires --timestamp-in-filename. Both parties must set this flag " +
        "identically -- a mismatch is detected at rendezvous and fails fast on " +
        "both sides with a clear error naming each side's setting, rather than " +
        "stalling until the peer timeout. A fresh " +
        "directory is required for each exchange and is enforced: reusing a " +
        "directory with retained files from a prior session is rejected with " +
        "an error at startup",
    })
    .option("sweep-exchange-files", {
      type: "boolean",
      describe:
        "before rendezvous, delete every protocol file left in the directory " +
        "(this party's and the peer's: hellos, acks, locks, joining sentinels, " +
        "messages) and start a fresh exchange. Foreign (non-protocol) files are " +
        "never deleted. Use to recover a directory after a crashed or " +
        "mismatched prior run, once you have confirmed no other session is " +
        "using it. CLI-only and invocation-scoped: it is never persisted to " +
        "psilink.yaml. Refuses on a retain-mode signal unless " +
        "--force-retain-sweep is also set",
    })
    .option("force-retain-sweep", {
      type: "boolean",
      describe:
        "DANGEROUS. Permit --sweep-exchange-files to delete a retain-mode audit " +
        "transcript (a directory that is, or whose peer is, in retain mode); the " +
        "prior transcript is permanently lost. Requires --sweep-exchange-files " +
        "-- on its own it is rejected. Only use when you intend to discard the " +
        "transcript",
    })
    .option("verbose", {
      alias: "v",
      type: "count",
      describe:
        "generate additional logging information for sub-libraries at all " +
        "logging levels",
    })
    .demand(1);
}

// --- Argument parsing --------------------------------------------------------

interface ZeroSetupArgs {
  positionals: Array<string | number>;
  save: boolean;
  configFile: string;
  keyFile: string;
  identity?: string;
  serverPort?: number;
  serverUsername?: string;
  serverPassword?: string;
  serverPrivateKey?: string;
  connectionTimeout?: number;
  peerTimeout?: number;
  maxReconnectAttempts?: number;
  locklessRendezvous?: boolean;
  peerId?: string;
  timestampInFilename?: boolean;
  retainFiles?: boolean;
  // CLI-only sweep controls (see protocol.FileSyncRuntimeOptions). Excluded from
  // ZeroSetupOptions below so they never reach createConnection / the config
  // schema.
  sweepExchangeFiles: boolean;
  forceRetainSweep: boolean;
  // CLI-only audit-record controls, consumed by the handler (resolveRecordOutput)
  // and likewise excluded from ZeroSetupOptions: createConnection never reads them.
  record: boolean;
  recordFile?: string;
  logLevel: logLibrary.LogLevelNumbers;
  verbosity: number;
}

type ZeroSetupOptions = Omit<
  ZeroSetupArgs,
  | "positionals"
  | "logLevel"
  | "verbosity"
  | "sweepExchangeFiles"
  | "forceRetainSweep"
  | "record"
  | "recordFile"
>;

function parseArgs(argv: Arguments): ZeroSetupArgs {
  const rawLogLevel = (
    (singleValue(argv, "log-level") as string | undefined) || "info"
  ).toLowerCase();
  const logLevel = LOG_LEVELS[rawLogLevel];
  if (logLevel === undefined)
    // Invalid caller input (exit 64), the same classification the shared
    // parseCommonBootstrapArgs gives an unrecognized log-level, so the handler's
    // wrapper maps it to a clean usage error rather than a raw top-level dump.
    throw new UsageError(`unrecognized log-level: ${argv["log-level"]}`);

  // Each single-value (string/number) option is read through singleValue so a
  // repeated flag is rejected with a clean usage error (mapped to exit 64 in the
  // handler) before its array value reaches a cast that lies about the type. The
  // boolean/count options (save, lockless-rendezvous, timestamp-in-filename,
  // retain-files, sweep-exchange-files, force-retain-sweep, record, verbose)
  // keep their plain casts: a repeat is valid for them.
  return {
    positionals: argv._,
    save: (argv["save"] as boolean | undefined) ?? false,
    // Local filesystem paths accept a leading `~`; server-password /
    // -private-key are credential values, not paths to tilde-expand here. An
    // `@path` credential ref is carried through verbatim (not resolved at parse
    // time) and read only at the live-use boundary (resolveConnectionCredentials
    // in the handler), so a persisted config keeps the `@path` rather than the
    // resolved secret.
    configFile: expandTilde(
      (singleValue(argv, "config-file") as string | undefined) ??
        DEFAULT_CONFIG_PATH,
    ),
    keyFile: expandTilde(
      (singleValue(argv, "key-file") as string | undefined) ?? DEFAULT_KEY_PATH,
    ),
    identity: singleValue(argv, "identity") as string | undefined,
    serverPort: singleValue(argv, "server-port") as number | undefined,
    serverUsername: singleValue(argv, "server-username") as string | undefined,
    serverPassword: singleValue(argv, "server-password") as string | undefined,
    serverPrivateKey: singleValue(argv, "server-private-key") as
      | string
      | undefined,
    connectionTimeout: singleValue(argv, "connection-timeout") as
      | number
      | undefined,
    peerTimeout: singleValue(argv, "peer-timeout") as number | undefined,
    maxReconnectAttempts: singleValue(argv, "max-reconnect-attempts") as
      | number
      | undefined,
    locklessRendezvous: argv["lockless-rendezvous"] as boolean | undefined,
    peerId: singleValue(argv, "peer-id") as string | undefined,
    timestampInFilename: argv["timestamp-in-filename"] as boolean | undefined,
    retainFiles: argv["retain-files"] as boolean | undefined,
    // CLI-only, never persisted: resolve to a definite boolean here since there
    // is no config layer to merge with (unlike the flags above).
    sweepExchangeFiles:
      (argv["sweep-exchange-files"] as boolean | undefined) ?? false,
    forceRetainSweep:
      (argv["force-retain-sweep"] as boolean | undefined) ?? false,
    // yargs sets `record` to false on --no-record and true by the option's
    // default otherwise, so it is always a boolean here.
    record: argv["record"] as boolean,
    recordFile: expandTilde(
      singleValue(argv, "record-file") as string | undefined,
    ),
    logLevel,
    verbosity: (argv["verbose"] as number | undefined) ?? 0,
  };
}

// --- Positional parsing ------------------------------------------------------

function tryParseURL(raw: string, errorMsg: string): URL {
  try {
    return new URL(raw);
  } catch (cause) {
    // Object.assign rather than `new Error(msg, { cause })`: the second-arg
    // ErrorOptions form requires lib ES2022, but the runtime preserves the
    // assigned property either way.
    throw Object.assign(new Error(errorMsg), { cause });
  }
}

/**
 * Resolves the positional CLI arguments to a server URL, input path, and
 * optional output path. Throws with a user-facing message on bad input.
 * @internal exported for testing
 */
export function resolvePositionals(positionals: Array<unknown>): {
  server: URL;
  input: string;
  output: string | undefined;
} {
  const arg0 = String(positionals[0]);
  const arg1 =
    positionals[1] !== undefined ? String(positionals[1]) : undefined;
  const arg2 =
    positionals[2] !== undefined ? String(positionals[2]) : undefined;

  if (arg1 === undefined) {
    // Single positional: might be a file (user forgot the subcommand) or a URL
    // with no input file.
    if (fs.existsSync(arg0)) {
      throw new Error(
        "input file provided without a server URL; " +
          "did you mean 'psilink exchange INPUT_FILE'?",
      );
    }
    throw new Error(
      "input file not specified; usage: psilink URL INPUT_FILE [OUTPUT_FILE]",
    );
  }

  const server = tryParseURL(
    arg0,
    `unable to parse server URL: ${arg0}; ` +
      "usage: psilink URL INPUT_FILE [OUTPUT_FILE]",
  );
  return { server, input: arg1, output: arg2 };
}

// --- Connection config from URL ----------------------------------------------

/**
 * Maps a server URL protocol to a connection channel identifier.
 * @internal exported for testing
 */
export function channelFromURL(url: URL): ConnectionConfig["channel"] {
  switch (url.protocol) {
    case "sftp:":
    case "ssh:":
      return "sftp";
    case "ws:":
    case "wss:":
      return "webrtc";
    case "file:":
      return "filedrop";
    default:
      // Invalid caller input (exit 64), not a transport failure.
      throw new UsageError(
        `unsupported URL scheme: ${url.protocol}; expected sftp://, ` +
          "ssh://, ws://, wss://, or file://",
      );
  }
}

/** @internal */
export function createConnection(
  server: URL,
  options: ZeroSetupOptions,
): ConnectionConfig {
  const channel = channelFromURL(server);

  if (channel === "filedrop") {
    if (server.hostname && server.hostname !== "localhost") {
      throw new UsageError(
        `file:// URLs must use three slashes (e.g. file:///mnt/share/drop) ` +
          `or file://localhost/path; got: ${server.href}`,
      );
    }
    const base: FileDropConnectionConfig = {
      channel: "filedrop",
      path: fileURLToPath(server),
    };
    return applyConnectionOverrides(base, {
      connectionTimeout: options.connectionTimeout,
      peerTimeout: options.peerTimeout,
      maxReconnectAttempts: options.maxReconnectAttempts,
      locklessRendezvous: options.locklessRendezvous,
      peerId: options.peerId,
      timestampInFilename: options.timestampInFilename,
      retainFiles: options.retainFiles,
    });
  }

  if (channel !== "sftp")
    throw new UsageError(`${channel} channel not yet supported in the CLI`);

  const base: SFTPConnectionConfig = {
    channel: "sftp",
    server: {
      host: server.hostname,
      port: server.port ? Number(server.port) : undefined,
      username: server.username || undefined,
      password: server.password || undefined,
      path: server.pathname || undefined,
    },
  };

  return applyConnectionOverrides(base, {
    connectionTimeout: options.connectionTimeout,
    peerTimeout: options.peerTimeout,
    maxReconnectAttempts: options.maxReconnectAttempts,
    serverUsername: options.serverUsername,
    serverPassword: options.serverPassword,
    serverPrivateKey: options.serverPrivateKey,
    serverPort: options.serverPort,
    locklessRendezvous: options.locklessRendezvous,
    peerId: options.peerId,
    timestampInFilename: options.timestampInFilename,
    retainFiles: options.retainFiles,
  });
}

// --- Data preparation --------------------------------------------------------

async function prepareDataset(
  identity: string,
  input: string,
): Promise<PreparedExchange> {
  const log = getLogger("psilink");

  validateInputFile(input);

  const csvResult = await loadCSVFile(fs.createReadStream(input));
  const rawRows = csvResult.data as Array<Record<string, string>>;
  const prepared = prepareForExchange(
    {},
    identity,
    rawRows,
    csvResult.meta.fields ?? [],
  );
  for (const warning of prepared.warnings)
    log.warn("cleaning configuration issue:", warning);
  return prepared;
}

// --- Save bootstrap ----------------------------------------------------------

/**
 * Build the {@link ExchangeSpec} a `--save` zero-setup exchange persists: the
 * connection actually used plus the inferred linkage terms and metadata.
 * Standardization is omitted -- `psilink exchange` re-infers it from the input
 * file on load (the same inference that already succeeded here), so the saved
 * config stays minimal. The connection carries whatever credentials the URL or
 * --server-* flags supplied; `saveConfig` writes it owner-read-only.
 *
 * @internal exported for testing
 */
export function buildSaveSpec(
  connection: ConnectionConfig,
  prepared: PreparedExchange,
): ExchangeSpec {
  return {
    connection,
    linkageTerms: prepared.linkageTerms,
    metadata: prepared.metadata,
  };
}

/**
 * Apply the `--save` bootstrap outcome after a successful zero-setup exchange:
 * persist config/key as appropriate and emit the matching notice. It performs no
 * network I/O -- only provisioning-layer writes and logging -- so it is unit
 * tested directly. Conflict detection already ran up front in the handler (via
 * {@link assertNoProvisionConflicts}); the both-saved path re-checks through
 * {@link provisionConfigAndKey}, and the config-only path writes through
 * {@link saveConfig}, the same writer that helper uses.
 *
 * The four cases mirror docs/SECURITY_DESIGN.md "Bootstrapping a shared secret":
 * we-saved + both-saved (write config + key), we-saved + partner-did-not (write
 * config only, instruct to invite), we-did-not-save + partner-did (save nothing,
 * explain), and neither-saved (the standard recurring-exchange hint).
 *
 * @internal exported for testing
 */
export function finalizeBootstrap(params: {
  save: boolean;
  bootstrap: ExchangeBootstrapResult;
  spec: ExchangeSpec;
  configFile: string;
  keyFile: string;
  log: { info: (message: string) => void };
}): void {
  const { save, bootstrap, spec, configFile, keyFile, log } = params;

  // Invariant guard: a shared secret is established only when both parties pass
  // --save, so a secret reaching here with save === false is an internal
  // contradiction (the secret frame is gated on this party's own intent in
  // runExchange). Fail loudly rather than silently discard a negotiated secret.
  if (!save && bootstrap.sharedSecret !== undefined)
    throw new Error(
      "internal error: a shared secret was established but this party did not " +
        "opt to save; refusing to silently discard it",
    );

  if (save) {
    if (bootstrap.sharedSecret !== undefined) {
      // Both parties saved: the initiator generated the secret and the responder
      // received it, so both persist the same config and key.
      const { configPath, keyPath } = provisionConfigAndKey(
        spec,
        { sharedSecret: bootstrap.sharedSecret },
        { configPath: configFile, keyPath: keyFile },
      );
      log.info(
        `established a shared secret with your partner; wrote config to ` +
          `${configPath} and key file to ${keyPath}. Keep the key file ` +
          `private. Run 'psilink exchange' for future exchanges with this ` +
          `partner.`,
      );
      return;
    }
    // We saved but the partner did not: there is no secret, so persist the
    // config alone (no key file) and steer the user to the invitation flow.
    // Re-check for a config conflict before writing: the both-saved branch gets
    // this from provisionConfigAndKey, but this branch writes through saveConfig
    // directly. The up-front gate ran before the network round-trip, so a file
    // that appeared at the path in that window must abort here rather than
    // clobber the user's configuration -- the same "never clobber a half-finished
    // bootstrap" intent as the pre-flight check. Only configFile is re-checked,
    // not keyFile: this branch writes no key file, so gating on a path it will
    // not touch would reject a write that is safe. The asymmetry with the
    // pre-flight (which reserves both) is deliberate -- the pre-flight cannot yet
    // know the partner declined to save, whereas here that is settled.
    const conflicts = detectFileConflicts([configFile]);
    if (conflicts.length > 0)
      throw new UsageError(
        `refusing to overwrite ${conflicts.join(", ")}, which appeared after ` +
          "the pre-flight check; move or remove it and re-run with --save",
      );
    saveConfig(configFile, spec);
    log.info(
      `your partner did not also choose to save, so no shared secret was ` +
        `established. Wrote config to ${configFile} (no key file). To set up ` +
        `a recurring exchange, run 'psilink invite' and share the invitation ` +
        `with your partner.`,
    );
    return;
  }

  if (bootstrap.partnerSaveIntent) {
    // The partner wants a recurring exchange but we did not pass --save, so
    // nothing was saved on our end.
    log.info(
      "your partner is trying to establish a recurring exchange, but you did " +
        "not pass --save, so nothing was saved on your end. Wait for an " +
        "invitation from your partner ('psilink accept'), or coordinate to " +
        "re-run this exchange with --save on both sides.",
    );
    return;
  }

  log.info(
    "To establish a recurring exchange with this partner, run 'psilink " +
      "invite URL INPUT_FILE' and share the invitation string, or coordinate " +
      "with your partner to re-run with --save.",
  );
}

// --- Handler -----------------------------------------------------------------

export async function handler(argv: Arguments): Promise<void> {
  let parsed: ZeroSetupArgs;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    // parseArgs resolves the log level and reads every option, so it runs before
    // the logger exists. Its usage errors -- a repeated single-value flag
    // (singleValue) or an unrecognized log-level -- are UsageErrors, reported on
    // stderr and exited 64 here. Any other (unexpected) failure propagates to the
    // top-level handler unchanged rather than being reclassified.
    if (err instanceof UsageError) {
      console.error(sanitizeErrorForDisplay(err));
      process.exit(64);
    }
    throw err;
  }
  const {
    positionals,
    logLevel,
    verbosity,
    sweepExchangeFiles,
    forceRetainSweep,
    ...options
  } = parsed;

  logLibrary.setDefaultLevel(logLevel);
  const log = getLogger("psilink");

  try {
    assertRetainSweepGuard(sweepExchangeFiles, forceRetainSweep);
  } catch (err) {
    log.error(sanitizeErrorForDisplay(err));
    process.exit(64);
  }

  log.warn(
    "WARNING: this exchange relies on transport-layer authentication only. " +
      "You must trust the server administrator. " +
      "Run 'psilink invite' / 'psilink accept' to establish a recurring " +
      "exchange with application-layer encryption.",
  );

  let resolved: ReturnType<typeof resolvePositionals>;
  try {
    resolved = resolvePositionals(positionals);
  } catch (err) {
    log.error(sanitizeErrorForDisplay(err));
    process.exit(64);
  }

  const { server, input, output } = resolved;

  // Warn before createConnection can throw so the user sees the flag issue
  // even if the channel is not yet supported.
  if (options.locklessRendezvous === true) {
    try {
      const ch = channelFromURL(server);
      if (ch !== "sftp" && ch !== "filedrop") {
        log.warn(
          `--lockless-rendezvous has no effect on the ${ch} channel and ` +
            "will be ignored; it is only supported on sftp and filedrop",
        );
      }
    } catch {
      // Unknown URL scheme; createConnection handles this.
    }
  }

  if (options.retainFiles === true) {
    try {
      const ch = channelFromURL(server);
      if (ch !== "sftp" && ch !== "filedrop") {
        log.warn(
          `--retain-files is not supported on the ${ch} channel; ` +
            "it is only valid for sftp and filedrop",
        );
      }
    } catch {
      // Unknown URL scheme; createConnection handles this.
    }
  }

  // Detect a pre-existing config/key before any network activity. With --save,
  // a target that already exists is an error -- a half-finished bootstrap must
  // never clobber a user's configuration -- and the check runs up front so it
  // aborts before a connection is opened. Without --save, no files are written,
  // so an existing config/key is merely ignored; warn and point at the command
  // that would use it (docs/CLI.md "Zero-setup exchange").
  //
  // Both paths are reserved here even though the partner-did-not-save branch
  // ends up writing only the config: whether a key file is written depends on
  // the partner's intent, which is not known until after the terms round-trip.
  // Reserving both up front fails fast on an existing key file rather than
  // discovering the conflict post-exchange, where the secret has already crossed
  // the wire and the only recovery is a re-invite. The conservative gate trades a
  // rare false block (a stale key file plus a partner who declines to save) for
  // never stranding a half-saved bootstrap, and matches docs/CLI.md (an existing
  // config OR key with --save is an error).
  if (options.save) {
    try {
      assertNoProvisionConflicts({
        configPath: options.configFile,
        keyPath: options.keyFile,
      });
    } catch (err) {
      log.error(sanitizeErrorForDisplay(err));
      process.exit(64);
    }
  } else {
    const existing = detectFileConflicts([options.configFile, options.keyFile]);
    if (existing.length > 0) {
      const noun = existing.length === 1 ? "file" : "files";
      log.warn(
        `existing ${noun} ${existing.join(", ")} will be ignored by this ` +
          "zero-setup exchange; to use saved configuration and key material, " +
          "run 'psilink exchange' instead",
      );
    }
  }

  let connection: ConnectionConfig;
  let liveConnection: ConnectionConfig;
  let prepared: PreparedExchange;
  try {
    connection = createConnection(server, options);
    // `connection` keeps any `@path` credential ref so finalizeBootstrap's save
    // persists the reference, not the secret; `liveConnection` resolves it for
    // the exchange itself. A missing or unreadable `@path` file is a UsageError
    // here (exit 64), before any network activity.
    liveConnection = resolveConnectionCredentials(connection);
    const identity = options.identity ?? userInfo().username;
    prepared = await prepareDataset(identity, input);
  } catch (err) {
    log.error(sanitizeErrorForDisplay(err));
    // A bad URL scheme or unsupported channel is a usage error (exit 64);
    // prepareDataset failures carry their own exitCode; otherwise exit 69.
    process.exit(
      err instanceof UsageError
        ? 64
        : ((err as { exitCode?: number }).exitCode ?? 69),
    );
  }

  announceRetainMode(connection, log);

  let runResult: Awaited<ReturnType<typeof runProtocol>>;
  try {
    // Cast: `liveConnection` is `ConnectionConfig` (which includes the webrtc
    // channel), so TypeScript cannot verify it fits `ProtocolConnectionConfig`
    // (constrained to sftp and filedrop). The double cast through `unknown` is
    // intentional; the channel guard inside `runProtocol` rejects unsupported
    // channels at runtime.
    // auth: null is the explicit opt-out that tells runProtocol to proceed
    // without authentication and without a warning.
    runResult = await runProtocol(
      liveConnection as unknown as ProtocolConnectionConfig,
      null,
      prepared,
      output,
      verbosity,
      "psilink",
      resolveRecordOutput({
        enabled: options.record,
        recordFile: options.recordFile,
      }),
      // Carry this party's --save intent into the in-band bootstrap. The
      // exchange advertises it to the partner and, when both saved, returns the
      // established secret on runResult.bootstrap. Pass the raw boolean, never
      // `options.save || undefined`: a non-saving party (options.save === false)
      // must still receive a defined bootstrap so finalizeBootstrap can emit the
      // "your partner wanted to save" notice. Collapsing false to undefined
      // would route it through the interrupt guard below and silently swallow
      // that notice. The wire is unaffected either way -- the save field only
      // rides the terms frame when intent is true (see exchangeTerms).
      options.save,
      // onAuthenticated is undefined on the unauthenticated zero-setup path; the
      // trailing object carries the CLI-only sweep controls.
      undefined,
      { sweepExchangeFiles, forceRetainSweep },
    );
  } catch (err) {
    log.error(sanitizeErrorForDisplay(err));
    process.exit(err instanceof UsageError ? 64 : 69);
  }

  const { bootstrap } = runResult;
  // bootstrap is undefined only when a signal cut the run short and the process
  // is already exiting; there is nothing to save or announce in that case.
  if (bootstrap === undefined) return;

  // The exchange has already succeeded and written its output by this point, so
  // a provisioning failure here (a config/key conflict that appeared in the
  // post-exchange window, or a disk error) cannot undo the linkage -- but it
  // must still exit cleanly with a diagnostic rather than crash as an unhandled
  // rejection. A conflict is a UsageError (exit 64); anything else exits 69.
  try {
    finalizeBootstrap({
      save: options.save,
      bootstrap,
      spec: buildSaveSpec(connection, prepared),
      configFile: options.configFile,
      keyFile: options.keyFile,
      log,
    });
  } catch (err) {
    log.error(sanitizeErrorForDisplay(err));
    process.exit(err instanceof UsageError ? 64 : 69);
  }
}
