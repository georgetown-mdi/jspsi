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
} from "@psilink/core";
import type {
  ConnectionConfig,
  ExchangeDataSpec,
  PreparedExchange,
} from "@psilink/core";

import { applyConnectionOverrides } from "../config";
import { loadKeyFile, type KeyFile } from "../keyFile";
import { resolveAtSignRefs } from "../util/atSignRefs";
import { LOG_LEVELS, validateInputFile } from "../util/cli";
import { runProtocol } from "../protocol";

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
      describe: "exchange configuration file (default: ./psilink.yaml)",
    })
    .option("key-file", {
      type: "string",
      describe: "shared key file (default: ./.psilink.key)",
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
  logLevel: logLibrary.LogLevelNumbers;
  verbosity: number;
}

type ExchangeOptions = Omit<
  ExchangeArgs,
  "input" | "output" | "logLevel" | "verbosity"
>;

function parseArgs(argv: Arguments): ExchangeArgs {
  const rawLogLevel = (
    (argv["log-level"] as string | undefined) || "info"
  ).toLowerCase();
  const logLevel = LOG_LEVELS[rawLogLevel];
  if (logLevel === undefined)
    throw new Error(`unrecognized log-level: ${argv["log-level"]}`);

  return {
    input: argv["input"] as string,
    output: argv["output"] as string | undefined,
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
    logLevel,
    verbosity: (argv["verbose"] as number | undefined) ?? 0,
  };
}

// --- Config loading ----------------------------------------------------------

/** @internal exported for testing */
export function loadConfig(
  options: ExchangeOptions,
): { connection: ConnectionConfig } & ExchangeDataSpec {
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
    throw err;
  }
  const { connection: baseConn, ...exchangeDataSpec } = parseExchangeSpec(
    resolveAtSignRefs(rawConfig),
  );
  log.info("loaded exchange spec from", options.configFile);

  const connection = applyConnectionOverrides(baseConn, {
    connectionTimeout: options.connectionTimeout,
    peerTimeout: options.peerTimeout,
    maxReconnectAttempts: options.maxReconnectAttempts,
    serverUsername: options.serverUsername,
    serverPassword: options.serverPassword,
    serverPrivateKey: options.serverPrivateKey,
    serverPort: options.serverPort,
  });

  if (connection.channel !== "sftp" && connection.channel !== "filedrop")
    throw new Error(
      `the ${connection.channel} channel is not yet supported in the CLI`,
    );

  let keyData: KeyFile | undefined;
  try {
    keyData = loadKeyFile(options.keyFile);
  } catch (err) {
    throw new Error(
      `key file at ${options.keyFile} is malformed: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  if (keyData === undefined)
    throw new Error(
      `key file ${options.keyFile} does not exist; ` +
        "to create one, run 'psilink URL INPUT_FILE --save' first",
    );
  if (connection.authentication === undefined) {
    connection.authentication = {
      pakeToken: keyData.pakeToken,
      expires: keyData.expires,
    };
  } else {
    connection.authentication.pakeToken = keyData.pakeToken;
    connection.authentication.expires = keyData.expires;
  }

  return { connection, ...exchangeDataSpec };
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
  const { input, output, logLevel, verbosity, ...options } = parseArgs(argv);

  logLibrary.setDefaultLevel(logLevel);
  const log = getLogger("exchange");

  let configResult: ReturnType<typeof loadConfig>;
  try {
    configResult = loadConfig(options);
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit((err as NodeJS.ErrnoException).code === "ENOENT" ? 64 : 69);
  }
  const { connection, ...exchangeDataSpec } = configResult;

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

  try {
    await runProtocol(connection, prepared, output, verbosity, "exchange");
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(69);
  }
}
