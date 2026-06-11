import type { Argv, Arguments } from "yargs";
import fs from "node:fs";
import logLibrary from "loglevel";
import YAML from "yaml";
import { userInfo } from "node:os";

import {
  parseExchangeSpec,
  getLogger,
  loadCSVFile,
  prepareForExchange,
  UsageError,
} from "@psilink/core";
import type { ExchangeDataSpec, PreparedExchange } from "@psilink/core";

import {
  applyConnectionOverrides,
  announceRetainMode,
  assertRetainSweepGuard,
  DEFAULT_CONFIG_PATH,
} from "../config";
import { expandTilde } from "../fileUtils";
import { loadKeyFile, DEFAULT_KEY_PATH, type KeyFile } from "../keyFile";
import { resolveRecordOutput } from "../recordFile";
import { resolveAtSignRefs } from "../util/atSignRefs";
import { LOG_LEVELS, singleValue, validateInputFile } from "../util/cli";
import {
  runProtocol,
  type AuthPersist,
  type ProtocolConnectionConfig,
} from "../protocol";

export function builder(cmd: Argv): Argv {
  return cmd
    .usage("Usage: $0 exchange [options] INPUT_FILE [OUTPUT_FILE]")
    .positional("input", {
      type: "string",
      describe: "CSV to link; use `-` to read from stdin",
      demandOption: true,
    })
    .positional("output", {
      type: "string",
      describe: "where to write results; defaults to stdout",
    })
    .option("config-file", {
      type: "string",
      describe: `exchange configuration file (default: ${DEFAULT_CONFIG_PATH})`,
    })
    .option("key-file", {
      type: "string",
      describe: `shared key file (default: ${DEFAULT_KEY_PATH})`,
    })
    .option("identity", {
      type: "string",
      describe: "identity string for this party (name, org, contact)",
    })
    .option("server-port", {
      type: "number",
      describe: "server port; overrides connection.server.port in config",
    })
    .option("server-username", {
      type: "string",
      describe:
        "server username; overrides connection.server.username in config",
    })
    .option("server-password", {
      type: "string",
      describe:
        "server password; use @path to read from file; overrides " +
        "connection.server.password in config",
    })
    .option("server-private-key", {
      type: "string",
      describe:
        "SSH private key; use @path to read from file; overrides " +
        "connection.server.privateKey in config",
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
        "Overrides connection.options.peer_id in config. Requires " +
        "timestamp_in_filename: true. Both parties must use distinct ids",
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
    });
}

// --- Argument parsing --------------------------------------------------------

interface ExchangeArgs {
  input: string;
  output?: string;
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
  // ExchangeOptions below so they never reach loadConfig / the config schema.
  sweepExchangeFiles: boolean;
  forceRetainSweep: boolean;
  record: boolean;
  recordFile?: string;
  logLevel: logLibrary.LogLevelNumbers;
  verbosity: number;
}

type ExchangeOptions = Omit<
  ExchangeArgs,
  | "input"
  | "output"
  | "logLevel"
  | "verbosity"
  | "sweepExchangeFiles"
  | "forceRetainSweep"
>;

function parseArgs(argv: Arguments): ExchangeArgs {
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
  // boolean/count options keep their plain casts: a repeat is valid for them.
  // `input`/`output` are positionals, not repeatable flags, so they stay plain.
  return {
    // Local filesystem paths accept a leading `~`; server-private-key /
    // -password are NOT paths here (resolveAtSignRefs already turned any @file
    // ref into its contents), so they must not be tilde-expanded.
    input: expandTilde(argv["input"] as string),
    output: expandTilde(argv["output"] as string | undefined),
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
    serverPassword: resolveAtSignRefs(
      singleValue(argv, "server-password") as string | undefined,
    ) as string | undefined,
    serverPrivateKey: resolveAtSignRefs(
      singleValue(argv, "server-private-key") as string | undefined,
    ) as string | undefined,
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

// --- Config loading ----------------------------------------------------------

// The runtime-injected authentication fields: their values come only from
// `.psilink.key`, so an operator who sets them in the top-level `authentication`
// block of psilink.yaml is warned and the value is stripped. Each canonical name
// carries the user-input spellings it can appear as before `camelizeKeys` runs
// (snake_case is the YAML convention; camelCase is accepted too), so neither
// form slips through silently, alongside the hint shown when it is stripped.
// Keeping forms and hint in one entry keeps them from drifting out of sync.
const INJECTED_AUTH_FIELDS: Record<string, { forms: string[]; hint: string }> =
  {
    sharedSecret: {
      forms: ["shared_secret", "sharedSecret"],
      hint:
        "the shared secret is always loaded from the key file (any @-file " +
        "reference in this field was also not resolved)",
    },
    expires: {
      forms: ["expires"],
      hint:
        "expiration is always loaded from the key file (any @-file reference " +
        "in this field was also not resolved)",
    },
  };

/**
 * Warn about and strip the runtime-injected authentication fields
 * (`shared_secret`/`expires`) from a raw top-level `authentication` block, in
 * place. Their values come only from `.psilink.key`, so a value set in YAML is
 * ignored; warning rather than silently dropping lets the operator see why their
 * setting did nothing. Operator-policy fields (e.g. a future `token_max_age_days`)
 * are NOT touched -- they pass through to schema validation, which is the
 * authority on which policy fields are valid. Runs on the raw config before
 * `parseExchangeSpec` (which applies `camelizeKeys` then Zod), so it matches both
 * the snake_case and camelCase spelling of each injected field.
 *
 * @internal exported for testing
 */
export function warnAndStripInjectedAuthFields(
  rawAuth: Record<string, unknown>,
  configFile: string,
  log: ReturnType<typeof getLogger>,
): void {
  // Map every accepted spelling straight to its hint, so matching a key both
  // identifies it as injected and yields the message in one lookup (no second
  // indexed access that could interpolate `undefined` if the tables drifted).
  const formToHint = new Map<string, string>();
  for (const { forms, hint } of Object.values(INJECTED_AUTH_FIELDS))
    for (const form of forms) formToHint.set(form, hint);

  for (const key of Object.keys(rawAuth)) {
    const hint = formToHint.get(key);
    // An operator-policy field (or an unrecognized one): leave it for the schema
    // to accept or strip, the same treatment any other config key gets.
    if (hint === undefined) continue;
    log.warn(
      `${configFile}: authentication.${key} is set and will be ignored; ` +
        hint,
    );
    delete rawAuth[key];
  }
}

/** @internal exported for testing */
export function loadConfig(options: ExchangeOptions): {
  connection: ProtocolConnectionConfig;
  authentication: AuthPersist;
} & ExchangeDataSpec {
  const log = getLogger("exchange");

  let rawConfig: unknown;
  try {
    rawConfig = YAML.parse(fs.readFileSync(options.configFile, "utf8"));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT")
      throw Object.assign(
        new Error(
          `config file ${options.configFile} does not exist; ` +
            "to create one, run 'psilink invite URL ...' first",
        ),
        { code: "ENOENT" },
      );
    // A non-ENOENT failure here is a malformed or unreadable local config
    // (invalid YAML, EACCES, EISDIR): invalid caller configuration the operator
    // must fix, so a UsageError (CLI exit 64), not a transport failure (69).
    throw new UsageError(
      `config file ${options.configFile} could not be read or parsed: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }

  // Warn about and strip the runtime-injected fields from the top-level
  // `authentication` block (their values come only from the key file). Operator-
  // policy fields under the same block are left for schema validation. Runs on
  // the raw config before parseExchangeSpec applies camelizeKeys + Zod.
  const rawAuth = (rawConfig as Record<string, unknown>)?.["authentication"];
  if (typeof rawAuth === "object" && rawAuth !== null)
    warnAndStripInjectedAuthFields(
      rawAuth as Record<string, unknown>,
      options.configFile,
      log,
    );

  let parsedSpec: ReturnType<typeof parseExchangeSpec>;
  try {
    parsedSpec = parseExchangeSpec(resolveAtSignRefs(rawConfig));
  } catch (err) {
    // Well-formed YAML that fails schema validation is still invalid caller
    // configuration (exit 64), not a transport failure.
    throw new UsageError(
      `config file ${options.configFile} is not a valid exchange spec: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  const {
    connection: baseConn,
    authentication: specAuth,
    ...exchangeDataSpec
  } = parsedSpec;
  log.info("loaded exchange spec from", options.configFile);

  const connection = applyConnectionOverrides(baseConn, {
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

  if (
    options.locklessRendezvous === true &&
    connection.channel !== "sftp" &&
    connection.channel !== "filedrop"
  ) {
    log.warn(
      `--lockless-rendezvous has no effect on the ${connection.channel} ` +
        "channel and will be ignored; it is only supported on sftp and filedrop",
    );
  }

  if (
    options.retainFiles === true &&
    connection.channel !== "sftp" &&
    connection.channel !== "filedrop"
  ) {
    log.warn(
      `--retain-files has no effect on the ${connection.channel} channel ` +
        "and will be ignored; it is only supported on sftp and filedrop",
    );
  }

  if (connection.channel !== "sftp" && connection.channel !== "filedrop")
    // An unsupported channel in the config is invalid caller configuration
    // (exit 64), not a transport failure.
    throw new UsageError(
      `the ${connection.channel} channel is not yet supported in the CLI`,
    );

  let keyData: KeyFile | undefined;
  try {
    keyData = loadKeyFile(options.keyFile);
  } catch (err) {
    // A malformed existing key file is bad input the operator must fix or
    // re-provision (exit 64), the same classification saveKeyFile gives a
    // malformed token on write -- not a transport failure (69).
    throw new UsageError(
      `key file at ${options.keyFile} is malformed: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  if (keyData === undefined)
    // A missing key file is a configuration problem (exit 64), consistent with
    // the missing-config case above.
    throw new UsageError(
      `key file ${options.keyFile} does not exist. ` +
        "Create one with 'psilink invite' (generate an invitation) or " +
        "'psilink accept' (accept a partner's invitation); both write a " +
        ".psilink.key. See docs/CLI.md#offline-invitation and " +
        "docs/SECURITY_DESIGN.md#recurring-exchange-authentication.",
    );
  const authPersist: AuthPersist = {
    // Operator-policy fields parsed from the YAML `authentication` block (none
    // are defined yet; this admits a future field such as token_max_age_days
    // end to end). The injected fields below come only from the key file and
    // override any YAML value -- already stripped above, so this ordering is
    // belt-and-suspenders.
    ...specAuth,
    sharedSecret: keyData.sharedSecret,
    expires: keyData.expires,
    keyFilePath: options.keyFile,
  };
  // The channel guard above throws on any non-sftp/filedrop channel, so the
  // discriminated union narrows `connection` to ProtocolConnectionConfig here.
  return {
    connection,
    authentication: authPersist,
    ...exchangeDataSpec,
  };
}

// --- Data preparation --------------------------------------------------------

async function prepareDataset(
  exchangeDataSpec: ExchangeDataSpec,
  identity: string,
  input: string,
): Promise<PreparedExchange> {
  const log = getLogger("exchange");

  validateInputFile(input);

  const csvResult = await loadCSVFile(fs.createReadStream(input));
  const rawRows = csvResult.data as Array<Record<string, string>>;
  const prepared = prepareForExchange(
    exchangeDataSpec,
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
  let parsed: ExchangeArgs;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    // parseArgs resolves the log level and reads every option, so it runs before
    // the logger exists. Its usage errors -- a repeated single-value flag
    // (singleValue) or an unrecognized log-level -- are UsageErrors, reported on
    // stderr and exited 64 here. Any other (unexpected) failure propagates to the
    // top-level handler unchanged rather than being reclassified.
    if (err instanceof UsageError) {
      console.error(err.message);
      process.exit(64);
    }
    throw err;
  }
  const {
    input,
    output,
    logLevel,
    verbosity,
    sweepExchangeFiles,
    forceRetainSweep,
    ...options
  } = parsed;

  logLibrary.setDefaultLevel(logLevel);
  const log = getLogger("exchange");

  try {
    assertRetainSweepGuard(sweepExchangeFiles, forceRetainSweep);
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(64);
  }

  let configResult: ReturnType<typeof loadConfig>;
  try {
    configResult = loadConfig(options);
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    // A malformed or missing config/key file is a usage error (exit 64); the
    // ENOENT arm keeps the missing-config case, which is tagged rather than a
    // UsageError. Anything else (e.g. an unsupported channel) stays exit 69.
    process.exit(
      err instanceof UsageError ||
        (err as NodeJS.ErrnoException).code === "ENOENT"
        ? 64
        : 69,
    );
  }
  const { connection, authentication, ...exchangeDataSpec } = configResult;

  announceRetainMode(connection, log);

  let identity: string;
  if (options.identity) {
    identity = options.identity;
    if (exchangeDataSpec.linkageTerms)
      exchangeDataSpec.linkageTerms = {
        ...exchangeDataSpec.linkageTerms,
        identity,
      };
  } else {
    identity = exchangeDataSpec.linkageTerms?.identity ?? userInfo().username;
  }

  let prepared: PreparedExchange;
  try {
    prepared = await prepareDataset(exchangeDataSpec, identity, input);
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit((err as { exitCode?: number }).exitCode ?? 69);
  }

  const recordOutput = resolveRecordOutput({
    enabled: options.record,
    recordFile: options.recordFile,
  });

  try {
    await runProtocol(
      connection,
      authentication,
      prepared,
      output,
      verbosity,
      "exchange",
      recordOutput,
      // saveIntent and onAuthenticated are both undefined on the authenticated
      // exchange path; the trailing object carries the CLI-only sweep controls.
      undefined,
      undefined,
      { sweepExchangeFiles, forceRetainSweep },
    );
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(err instanceof UsageError ? 64 : 69);
  }
}
