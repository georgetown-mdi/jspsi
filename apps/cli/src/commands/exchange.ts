import type { Argv, Arguments } from "yargs";
import fs from "node:fs";
import path from "node:path";
import logLibrary from "loglevel";
import YAML from "yaml";
import PSI from "@openmined/psi.js";

import { userInfo } from "node:os";

import {
  PSIParticipant,
  SFTPConnection,
  exchangeTerms,
  resolveRole,
  linkViaPSI,
  parseExchangeSpec,
  setLogPrefixer,
  loadCSVFile,
  inferMetadata,
  buildStandardizedDataset,
  StandardizedKeyIterable,
  getDefaultLinkageTerms,
  validateStandardizationAgainstTerms,
} from "@psilink/core";
import type {
  AssociationTable,
  ExchangeSpec,
  SFTPConnectionConfig,
  LinkageTerms,
  StandardizedDataset,
} from "@psilink/core";

import { SSH2SFTPClientAdapter } from "../connection/ssh2SftpAdapter";
import { applyCliOverrides, readAtSignFile } from "../config";
import { loadPakeToken } from "../configDir";

import { resolveAtSignRefs } from "../util/atSignRefs";

// ─── Types ───────────────────────────────────────────────────────────────────

interface ExchangeArgs {
  positionals: Array<string | number>;
  configDir: string;
  identity: string;
  /** Already @-file resolved. */
  pakeToken?: string;
  serverPort?: number;
  serverUsername?: string;
  /** Already @-file resolved. */
  serverPassword?: string;
  /** Already @-file resolved. */
  serverPrivateKey?: string;
  timeout?: number;
  logLevel: logLibrary.LogLevelNumbers;
  verbosity: number;
}

interface SpecResolution {
  spec: ExchangeSpec;
  input: string;
  output?: string;
  isNew: boolean;
}

interface PreparedDataset {
  readySpec: ExchangeSpec;
  rawRows: Array<Record<string, string>>;
  dataset: StandardizedDataset;
  linkageTerms: LinkageTerms;
}

// ─── Builder ─────────────────────────────────────────────────────────────────

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

// ─── Arg extraction ──────────────────────────────────────────────────────────

const LOG_LEVELS: Record<string, logLibrary.LogLevelNumbers> = {
  silent: logLibrary.levels.SILENT,
  error: logLibrary.levels.ERROR,
  warn: logLibrary.levels.WARN,
  info: logLibrary.levels.INFO,
  debug: logLibrary.levels.DEBUG,
  trace: logLibrary.levels.TRACE,
};

function extractArgs(argv: Arguments): ExchangeArgs {
  const configDir = (argv["config-dir"] as string | undefined) ?? ".psilink";
  const identity = (argv["identity"] || userInfo().username) as string;
  const pakeToken = readAtSignFile(argv["pake-token"] as string | undefined) as
    | string
    | undefined;
  const serverPort = argv["server-port"] as number | undefined;
  const serverUsername = argv["server-username"] as string | undefined;
  const serverPassword = readAtSignFile(
    argv["server-password"] as string | undefined,
  ) as string | undefined;
  const serverPrivateKey = readAtSignFile(
    argv["server-private-key"] as string | undefined,
  ) as string | undefined;
  const timeout = argv["timeout"] as number | undefined;

  const rawLogLevel = (
    (argv["logLevel"] as string | undefined) || "info"
  ).toLowerCase();
  const logLevel = LOG_LEVELS[rawLogLevel];
  if (logLevel === undefined)
    throw new Error(`unrecognized log-level: ${argv["log-level"]}`);

  const verbosity = (argv["verbose"] as number | undefined) ?? 0;

  return {
    positionals: argv._,
    configDir,
    identity,
    pakeToken,
    serverPort,
    serverUsername,
    serverPassword,
    serverPrivateKey,
    timeout,
    logLevel,
    verbosity,
  };
}

// ─── Config resolution ────────────────────────────────────────────────────────

function parsePositionals(
  positionals: Array<string | number>,
  configExists: boolean,
): { server?: URL; input: string; output?: string } {
  if (configExists) {
    const arg0 = String(positionals[0]);
    if (fs.existsSync(arg0)) {
      return {
        input: arg0,
        output:
          positionals[1] !== undefined ? String(positionals[1]) : undefined,
      };
    }
    let server: URL;
    try {
      server = new URL(arg0);
    } catch {
      // TODO: if is an invite string, do accept instead of exchange
      throw new Error(
        `the first argument must be a file, url, or invitation string; invalid value was: ${arg0}`,
      );
    }
    if (positionals[1] === undefined)
      throw new Error("input file not specified");
    return {
      server,
      input: String(positionals[1]),
      output: positionals[2] !== undefined ? String(positionals[2]) : undefined,
    };
  }

  let server: URL;
  try {
    server = new URL(String(positionals[0]));
  } catch {
    // TODO: if is an invite string, do accept instead of exchange
    throw new Error(
      `unable to parse URL or invitation string: ${positionals[0]}`,
    );
  }
  return {
    server,
    input: String(positionals[1]),
    output: positionals[2] !== undefined ? String(positionals[2]) : undefined,
  };
}

function loadOrBuildSpec(
  configDir: string,
  server: URL | undefined,
  identity: string,
): { spec: ExchangeSpec; isNew: boolean } {
  const configPath = path.join(configDir, "config.yaml");
  if (fs.existsSync(configPath)) {
    const content = fs.readFileSync(configPath, "utf8");
    const raw = YAML.parse(content) as unknown;
    const spec = parseExchangeSpec(resolveAtSignRefs(raw));
    if (server) {
      spec.connection.server.host ??= server.hostname;
      spec.connection.server.port ??= server.port
        ? Number(server.port)
        : undefined;
      spec.connection.server.username ??= server.username || undefined;
      if (spec.connection.channel === "sftp") {
        spec.connection.server.password ??= server.password || undefined;
      }
    }
    return { spec, isNew: false };
  }

  return {
    spec: {
      identity,
      connection: {
        channel: "sftp",
        server: {
          host: server!.hostname,
          port: server!.port ? Number(server!.port) : undefined,
          username: server!.username || undefined,
          password: server!.password || undefined,
        },
      },
    },
    isNew: true,
  };
}

function resolveArgumentsAndConfig(args: ExchangeArgs): SpecResolution {
  const log = logLibrary.getLogger("exchange");
  const configPath = path.join(args.configDir, "config.yaml");
  const configExists = fs.existsSync(configPath);

  const { server, input, output } = parsePositionals(
    args.positionals,
    configExists,
  );
  const { spec: baseSpec, isNew } = loadOrBuildSpec(
    args.configDir,
    server,
    args.identity,
  );

  if (isNew) log.info("creating default configuration");
  else log.info("loaded exchange spec from", args.configDir);

  const pakeToken = args.pakeToken ?? loadPakeToken(args.configDir);
  const spec = applyCliOverrides(baseSpec, {
    identity: args.identity,
    pakeToken,
    timeout: args.timeout,
    serverUsername: args.serverUsername,
    serverPassword: args.serverPassword,
    serverPrivateKey: args.serverPrivateKey,
    serverPort: args.serverPort,
  });

  if (spec.connection.channel !== "sftp")
    throw new Error("only the sftp channel is currently supported");

  return { spec, input, output, isNew };
}

// ─── Data preparation ────────────────────────────────────────────────────────

async function prepareDataset(
  spec: ExchangeSpec,
  input: string,
): Promise<PreparedDataset> {
  const log = logLibrary.getLogger("exchange");

  if (!fs.existsSync(input)) {
    log.error(`${input} does not exist`);
    process.exit(69);
  }

  const csvResult = await loadCSVFile(fs.createReadStream(input));
  const rawRows = csvResult.data as Array<Record<string, string>>;
  const metadata = spec.metadata ?? inferMetadata(csvResult.meta.fields ?? []);
  const linkageTerms =
    spec.linkageTerms ?? getDefaultLinkageTerms(spec.identity!, metadata);
  // TODO: implement default data standardization pipelines and install them
  // here

  log.info(
    "will link using keys:",
    linkageTerms.linkageKeys.map((k) => k.name).join(", "),
  );

  const dataset = buildStandardizedDataset(
    spec.standardization,
    rawRows,
    metadata,
    linkageTerms,
  );

  if (spec.standardization !== undefined) {
    for (const err of validateStandardizationAgainstTerms(
      spec.standardization,
      linkageTerms,
    ))
      log.warn("cleaning configuration issue:", err);
  }

  return {
    readySpec: { ...spec, metadata, linkageTerms },
    rawRows,
    dataset,
    linkageTerms,
  };
}

// ─── Protocol ────────────────────────────────────────────────────────────────

async function runProtocol(
  prepared: PreparedDataset,
  output: string | undefined,
  verbosity: number,
): Promise<void> {
  const { readySpec, rawRows, dataset, linkageTerms } = prepared;
  const sftpConfig = readySpec.connection as SFTPConnectionConfig;
  const log = logLibrary.getLogger("exchange");

  // ── Connection ─────────────────────────────────────────────────────────────

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
    log.info("arrived second - will send first message message");
  }

  log.info("starting polling");
  conn.start();

  // ── Protocol ──────────────────────────────────────────────────────────────

  log.info("exchanging linkage terms");
  const { partnerTerms, warnings } = await exchangeTerms(
    conn,
    conn.handshakeRole!,
    linkageTerms,
  );
  for (const warning of warnings) log.warn(warning);
  log.info("terms agreed, partner identity:", partnerTerms.identity);

  log.info("resolving role");
  const role = await resolveRole(
    conn,
    conn.handshakeRole!,
    linkageTerms.output,
    partnerTerms.output,
    rawRows.length,
  );
  log.info("role will be:", role);

  // Build key iterables now that the PSI role (and therefore swap direction)
  // is known. isReceiver determines whether swap-keyed rounds are applied.
  const isReceiver = role === "receiver";
  const linkageKeyIterables = linkageTerms.linkageKeys.map(
    (key) =>
      new StandardizedKeyIterable(key, dataset, rawRows.length, isReceiver),
  );

  // PLACEHOLDER: linkageTerms.algorithm ("psi" vs "psi-c") will eventually
  // determine whether the full intersection or only its cardinality is
  // revealed. Currently PSI is always used regardless of the algorithm field.
  const participant = new PSIParticipant(
    role === "receiver" ? "client" : "server",
    await PSI(),
    {
      role: role === "receiver" ? "joiner" : "starter",
      verbose: verbosity,
    },
  );

  log.info("identifying intersection");
  // PLACEHOLDER: cardinality is hard-coded to "one-to-one" (deduplicate: false
  // for both parties). Many-to-X linkages are not yet in scope.
  const associationTable = await linkViaPSI(
    { cardinality: "one-to-one" },
    participant,
    conn,
    linkageKeyIterables,
    verbosity,
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

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handler(argv: Arguments): Promise<void> {
  const args = extractArgs(argv);

  logLibrary.setDefaultLevel(args.logLevel);

  const log = logLibrary.getLogger("exchange");
  setLogPrefixer(log);

  let resolution: SpecResolution;
  try {
    resolution = resolveArgumentsAndConfig(args);
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(64);
  }

  const { spec, input, output, isNew } = resolution;
  const prepared = await prepareDataset(spec, input);

  if (isNew) {
    fs.mkdirSync(args.configDir, { recursive: true });
    fs.writeFileSync(
      path.join(args.configDir, "config.yaml"),
      YAML.stringify(prepared.readySpec),
    );
    log.info(
      `configuration saved to ${args.configDir};`,
      "omit the URL in future exchanges",
    );
  }

  await runProtocol(prepared, output, args.verbosity);
}
