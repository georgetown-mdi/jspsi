import type { Argv, Arguments } from "yargs";
import fs from "node:fs";
import path from "node:path";
import logLibrary from "loglevel";
import YAML from "yaml";
import PSI from "@openmined/psi.js";

import { userInfo } from "node:os";

import {
  SFTPConnection,
  parseExchangeSpec,
  getLogger,
  loadCSVFile,
  prepareForExchange,
  describeExchangeStages,
  runExchange,
} from "@psilink/core";
import type {
  AssociationTable,
  ConnectionConfig,
  ExchangeDataSpec,
  SFTPConnectionConfig,
  PreparedExchange,
} from "@psilink/core";

import { SSH2SFTPClientAdapter } from "../connection/ssh2SftpAdapter";
import { applyConnectionOverrides } from "../config";
import { loadPakeToken } from "../configDir";

import { resolveAtSignRefs } from "../util/atSignRefs";

export function builder(cmd: Argv): Argv {
  return cmd
    .usage(
      "Usage:\n" +
        "  $0 exchange [options] URL INPUT_FILE [OUTPUT_FILE]\n" +
        "  $0 exchange [options] INPUT_FILE [OUTPUT_FILE]\n\n" +
        "Arguments:\n" +
        "  URL          server URL; required when no config directory exists\n" +
        "  INPUT_FILE   CSV to link; use `-` to read from stdin\n" +
        "  OUTPUT_FILE  where to write results; defaults to stdout",
    )
    .option("config-dir", {
      type: "string",
      describe: "config directory (default: .psilink)",
    })
    .option("identity", {
      type: "string",
      describe: "identity string for this party (name, org, contact)",
    })
    .option("pake-token", {
      type: "string",
      describe: "shared authentication token; use @path to read from file",
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
      alias: "t",
      type: "number",
      describe: "seconds to wait for peer before giving up",
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
    })
    .demand(1);
}

// --- Argument parsing --------------------------------------------------------

/** @-file references will have already been resolved. */
interface ExchangeArgs {
  positionals: Array<string | number>;
  configDir: string;
  identity?: string;
  pakeToken?: string;
  serverPort?: number;
  serverUsername?: string;
  serverPassword?: string;
  serverPrivateKey?: string;
  timeout?: number;
  logLevel: logLibrary.LogLevelNumbers;
  verbosity: number;
}

type ExchangeOptions = Omit<
  ExchangeArgs,
  "positionals" | "logLevel" | "verbosity"
>;

const LOG_LEVELS: Record<string, logLibrary.LogLevelNumbers> = {
  silent: logLibrary.levels.SILENT,
  error: logLibrary.levels.ERROR,
  warn: logLibrary.levels.WARN,
  info: logLibrary.levels.INFO,
  debug: logLibrary.levels.DEBUG,
  trace: logLibrary.levels.TRACE,
};

function parseArgs(argv: Arguments): ExchangeArgs {
  const rawLogLevel = (
    (argv["logLevel"] as string | undefined) || "info"
  ).toLowerCase();
  const logLevel = LOG_LEVELS[rawLogLevel];
  if (logLevel === undefined)
    throw new Error(`unrecognized log-level: ${argv["log-level"]}`);

  return {
    positionals: argv._,
    configDir: (argv["config-dir"] as string | undefined) ?? ".psilink",
    identity: argv["identity"] as string | undefined,
    pakeToken: resolveAtSignRefs(argv["pake-token"] as string | undefined) as
      | string
      | undefined,
    serverPort: argv["server-port"] as number | undefined,
    serverUsername: argv["server-username"] as string | undefined,
    serverPassword: resolveAtSignRefs(
      argv["server-password"] as string | undefined,
    ) as string | undefined,
    serverPrivateKey: resolveAtSignRefs(
      argv["server-private-key"] as string | undefined,
    ) as string | undefined,
    timeout: argv["connectionTimeout"] as number | undefined,
    logLevel,
    verbosity: (argv["verbose"] as number | undefined) ?? 0,
  };
}

// --- Config object -----------------------------------------------------------

function tryParseURL(raw: string, errorMsg: string): URL {
  try {
    return new URL(raw);
  } catch {
    throw new Error(errorMsg);
  }
}

function resolvePositionals(
  positionals: Array<unknown>,
  configFileExists: boolean,
): {
  server: URL | undefined;
  input: string;
  output: string | undefined;
} {
  const arg0 = String(positionals[0]);
  const arg1 =
    positionals[1] !== undefined ? String(positionals[1]) : undefined;
  const arg2 =
    positionals[2] !== undefined ? String(positionals[2]) : undefined;

  if (configFileExists) {
    // arg0 may be a file or a URL
    if (fs.existsSync(arg0)) {
      return { server: undefined, input: arg0, output: arg1 };
    } else {
      const server = tryParseURL(
        arg0,
        "the first argument must be a file, url, or invitation string; " +
          `invalid value was: ${arg0}`,
      );
      if (arg1 === undefined) throw new Error("input file not specified");
      return { server, input: arg1, output: arg2 };
    }
  } else {
    // arg0 must be a URL
    const server = tryParseURL(
      arg0,
      `unable to parse URL or invitation string: ${positionals[0]}`,
    );
    if (arg1 === undefined) throw new Error("input file not specified");
    return { server, input: arg1, output: arg2 };
  }
}

function loadOrCreateConfigAndApplyOverrides(
  server: URL | undefined,
  options: ExchangeOptions,
): { connection: ConnectionConfig } & ExchangeDataSpec {
  const log = logLibrary.getLogger("exchange");

  const configPath = path.join(options.configDir, "config.yaml");

  let connection: ConnectionConfig;
  let exchangeDetails: ExchangeDataSpec;

  if (fs.existsSync(configPath)) {
    const rawConfig = YAML.parse(
      fs.readFileSync(configPath, "utf8"),
    ) as unknown;
    const { connection: baseConn, ...rest } = parseExchangeSpec(
      resolveAtSignRefs(rawConfig),
    );
    if (server) {
      baseConn.server.host ??= server.hostname;
      baseConn.server.port ??= server.port ? Number(server.port) : undefined;
      baseConn.server.username ??= server.username || undefined;
      if (baseConn.channel === "sftp")
        baseConn.server.password ??= server.password || undefined;
      baseConn.server.path ??= server.pathname;
    }
    connection = baseConn;
    exchangeDetails = { ...rest };
    log.info("loaded exchange spec from", options.configDir);
  } else {
    // If a config file doesn't exist, resolvePositionals will throw an error if
    // server can't be parsed into a URL.

    connection = {
      channel: "sftp",
      server: {
        host: server!.hostname,
        port: server!.port ? Number(server!.port) : undefined,
        username: server!.username || undefined,
        password: server!.password || undefined,
        path: server!.pathname || undefined,
      },
    };
    exchangeDetails = {};
    log.info("creating default configuration");
  }

  const pakeToken = options.pakeToken ?? loadPakeToken(options.configDir);
  connection = applyConnectionOverrides(connection, {
    pakeToken,
    timeout: options.timeout,
    serverUsername: options.serverUsername,
    serverPassword: options.serverPassword,
    serverPrivateKey: options.serverPrivateKey,
    serverPort: options.serverPort,
  });

  if (connection.channel !== "sftp")
    throw new Error("only the sftp channel is currently supported");

  return { connection, ...exchangeDetails };
}

// --- Data preparation --------------------------------------------------------

async function prepareDataset(
  exchangeDataSpec: ExchangeDataSpec,
  identity: string,
  input: string,
): Promise<PreparedExchange> {
  const log = logLibrary.getLogger("exchange");

  if (!fs.existsSync(input)) {
    log.error(`${input} does not exist`);
    process.exit(69);
  }

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

// --- Protocol ----------------------------------------------------------------

async function runProtocol(
  connection: ConnectionConfig,
  prepared: PreparedExchange,
  output: string | undefined,
  verbosity: number,
): Promise<void> {
  const sftpConfig = connection as SFTPConnectionConfig;
  const log = logLibrary.getLogger("exchange");

  const conn = new SFTPConnection(new SSH2SFTPClientAdapter(), {
    verbose: verbosity,
  });
  conn.on("error", (err: unknown) => {
    log.error("sftp error:", err);
    process.exit(69);
  });
  process.on("SIGINT", async function () {
    log.info("caught SIGINT, exiting");
    if (conn.connected) {
      await conn.cleanup();
      await conn.close();
    }
    process.exit(0);
  });

  log.info(
    "opening connection to",
    sftpConfig.server.host,
    "with options",
    sftpConfig.options,
  );
  await conn.openWithConfig(sftpConfig);

  log.info("synchronizing");
  await conn.synchronize();

  if (conn.handshakeRole === "responder") {
    log.info("arrived first - will wait for message");
  } else {
    log.info("arrived second - will send first message");
  }

  log.info("starting polling");
  conn.start();

  const stageLabels = Object.fromEntries(
    describeExchangeStages(prepared).map(({ id, label }) => [id, label]),
  );
  const { associationTable } = await runExchange(
    conn,
    conn.handshakeRole!,
    prepared,
    {
      psiLibrary: await PSI(),
      verbosity,
      onStage: (id: string) => {
        const label = stageLabels[id] ?? id;
        log.info(label.charAt(0).toLowerCase() + label.slice(1));
      },
      onWarning: (msg: string) => log.warn("terms exchange:", msg),
      onProtocolConfirmed: (partnerTerms, resolvedRole) => {
        log.info("terms agreed, partner identity:", partnerTerms.identity);
        log.info("role:", resolvedRole);
      },
    },
  );

  log.info("stopping polling");
  conn.stop();

  log.info("closing connection");
  await conn.close();

  writeOutput(output, associationTable);
}

function writeOutput(
  output: string | undefined,
  table: AssociationTable,
): void {
  const out = output
    ? fs.createWriteStream(output, { encoding: "utf8" })
    : process.stdout;
  out.write("our_row_id,their_row_id\n");
  table[0].forEach((ours, i) => {
    out.write(`${ours},${table[1][i]}\n`);
  });
  if (output) (out as fs.WriteStream).close();
}

// --- Handler -----------------------------------------------------------------

export async function handler(argv: Arguments): Promise<void> {
  const { positionals, logLevel, verbosity, ...options } = parseArgs(argv);

  logLibrary.setDefaultLevel(logLevel);
  const log = getLogger("exchange");

  const configPath = path.join(options.configDir, "config.yaml");
  const configFileExists = fs.existsSync(configPath);

  let resolvedPositionals: ReturnType<typeof resolvePositionals>;
  try {
    resolvedPositionals = resolvePositionals(positionals, configFileExists);
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(64);
  }

  const { server, input, output } = resolvedPositionals;

  let configResult: ReturnType<typeof loadOrCreateConfigAndApplyOverrides>;
  try {
    configResult = loadOrCreateConfigAndApplyOverrides(server, options);
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(69);
  }
  const { connection, ...exchangeDataSpec } = configResult!;

  // Identity has a complicated resolution, and it has to be done here because
  // prepareDataset might need it to create default linkage terms. There might
  // an opportunity to refactor this in the future.
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

  const prepared = await prepareDataset(exchangeDataSpec, identity, input);

  if (!configFileExists) {
    fs.mkdirSync(options.configDir, { recursive: true });
    fs.writeFileSync(
      path.join(options.configDir, "config.yaml"),
      YAML.stringify({
        connection,
        metadata: prepared.metadata,
        linkageTerms: prepared.linkageTerms,
      }),
    );
    log.info(
      `configuration saved to ${options.configDir};`,
      "omit the URL in future exchanges",
    );
  }

  try {
    await runProtocol(connection, prepared, output, verbosity);
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(69);
  }
}
