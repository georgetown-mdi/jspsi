import type { Argv, Arguments } from "yargs";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import logLibrary from "loglevel";
import { userInfo } from "node:os";

import {
  getLogger,
  loadCSVFile,
  prepareForExchange,
  UsageError,
} from "@psilink/core";
import type {
  ConnectionConfig,
  FileDropConnectionConfig,
  FileSyncOptions,
  SFTPConnectionConfig,
  PreparedExchange,
} from "@psilink/core";

import { applyConnectionOverrides } from "../config";
import { resolveAtSignRefs } from "../util/atSignRefs";
import { LOG_LEVELS, validateInputFile } from "../util/cli";
import { runProtocol, type ProtocolConnectionConfig } from "../protocol";

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
        "./psilink.yaml)",
    })
    .option("key-file", {
      type: "string",
      describe:
        "where to write .psilink.key when --save is given (default: " +
        "./.psilink.key)",
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
    .option("lockless-rendezvous", {
      type: "boolean",
      describe:
        "use the ack-handshake rendezvous instead of the atomic wave-file " +
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
        "message filename; required when --retain-files is set. Both parties " +
        "must use the same value",
    })
    .option("retain-files", {
      type: "boolean",
      describe:
        "keep all exchange files as a permanent transcript instead of " +
        "deleting them after consumption; intended for sync-mediated " +
        "transports that do not propagate deletions and for audit use cases. " +
        "Requires --timestamp-in-filename. Both parties must set this flag " +
        "identically -- a mismatch causes the exchange to stall until the " +
        "peer timeout fires (fast-fail detection not yet available). A fresh " +
        "directory is required for each exchange and is enforced: reusing a " +
        "directory with retained files from a prior session is rejected with " +
        "an error at startup",
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
  logLevel: logLibrary.LogLevelNumbers;
  verbosity: number;
}

type ZeroSetupOptions = Omit<
  ZeroSetupArgs,
  "positionals" | "logLevel" | "verbosity"
>;

function parseArgs(argv: Arguments): ZeroSetupArgs {
  const rawLogLevel = (
    (argv["log-level"] as string | undefined) || "info"
  ).toLowerCase();
  const logLevel = LOG_LEVELS[rawLogLevel];
  if (logLevel === undefined)
    throw new Error(`unrecognized log-level: ${argv["log-level"]}`);

  return {
    positionals: argv._,
    save: (argv["save"] as boolean | undefined) ?? false,
    configFile: (argv["config-file"] as string | undefined) ?? "./psilink.yaml",
    keyFile: (argv["key-file"] as string | undefined) ?? "./.psilink.key",
    identity: argv["identity"] as string | undefined,
    serverPort: argv["server-port"] as number | undefined,
    serverUsername: argv["server-username"] as string | undefined,
    serverPassword: resolveAtSignRefs(
      argv["server-password"] as string | undefined,
    ) as string | undefined,
    serverPrivateKey: resolveAtSignRefs(
      argv["server-private-key"] as string | undefined,
    ) as string | undefined,
    connectionTimeout: argv["connection-timeout"] as number | undefined,
    peerTimeout: argv["peer-timeout"] as number | undefined,
    maxReconnectAttempts: argv["max-reconnect-attempts"] as number | undefined,
    locklessRendezvous: argv["lockless-rendezvous"] as boolean | undefined,
    peerId: argv["peer-id"] as string | undefined,
    timestampInFilename: argv["timestamp-in-filename"] as boolean | undefined,
    retainFiles: argv["retain-files"] as boolean | undefined,
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
      throw new Error(
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
      throw new Error(
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
    throw new Error(`${channel} channel not yet supported in the CLI`);

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

// --- Handler -----------------------------------------------------------------

export async function handler(argv: Arguments): Promise<void> {
  const { positionals, logLevel, verbosity, ...options } = parseArgs(argv);

  logLibrary.setDefaultLevel(logLevel);
  const log = getLogger("psilink");

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
    log.error(err instanceof Error ? err.message : String(err));
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

  if (options.save) {
    log.warn(
      "--save: bootstrapping a shared secret is not yet implemented; " +
        "proceeding with a standard zero-setup exchange",
    );
  }

  let connection: ConnectionConfig;
  let prepared: PreparedExchange;
  try {
    connection = createConnection(server, options);
    const identity = options.identity ?? userInfo().username;
    prepared = await prepareDataset(identity, input);
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit((err as { exitCode?: number }).exitCode ?? 69);
  }

  if (
    (connection.channel === "sftp" || connection.channel === "filedrop") &&
    (connection.options as FileSyncOptions | undefined)?.retainFiles === true
  ) {
    log.info(
      "retain mode requires lockless_rendezvous and timestamp_in_filename; both parties must set all three identically.",
    );
  }

  try {
    // Spread + cast: `connection` is `ConnectionConfig` (which includes the
    // webrtc channel), so TypeScript cannot verify that the spread result fits
    // `ProtocolConnectionConfig` (constrained to sftp and filedrop). The double
    // cast through `unknown` is intentional; the channel guard inside
    // `runProtocol` rejects unsupported channels at runtime. The satisfies
    // check verifies that the authentication override is structurally valid for
    // ProtocolConnectionConfig.
    // authentication: null is the explicit opt-out that tells runProtocol to
    // proceed without PAKE and without a warning.
    const authOverride = { authentication: null } satisfies Pick<
      ProtocolConnectionConfig,
      "authentication"
    >;
    await runProtocol(
      { ...connection, ...authOverride } as unknown as ProtocolConnectionConfig,
      prepared,
      output,
      verbosity,
      "psilink",
    );
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(err instanceof UsageError ? 64 : 69);
  }

  if (!options.save) {
    log.info(
      "To establish a recurring exchange with this partner, run 'psilink " +
        "invite URL INPUT_FILE' and share the invitation string, or " +
        "coordinate with your partner to re-run with --save.",
    );
  }
}
