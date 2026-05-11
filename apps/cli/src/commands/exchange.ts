import type { Argv, Arguments } from "yargs";
import fs from "node:fs";
import logLibrary from "loglevel";
import YAML from "yaml";
import PSI from "@openmined/psi.js";

import {
  PSIParticipant,
  SFTPConnection,
  exchangeTerms,
  resolveRole,
  firstToPartyLinkageKeyDefinitions,
  getMetadataAndLinkageKeys,
  linkViaPSI,
  safeParseLinkageTerms,
  secondToPartyLinkageKeyDefinitions,
  setLogPrefixer,
} from "@psilink/core";
import type {
  AssociationTable,
  ExchangeSpec,
  SFTPConnectionConfig,
} from "@psilink/core";

import { SSH2SFTPClientAdapter } from "../connection/ssh2SftpAdapter";
import { applyCliOverrides, readAtSignFile } from "../config";
import { loadExchangeSpec, loadPakeToken } from "../configDir";

// ─── Types ───────────────────────────────────────────────────────────────────

interface ExchangeArgs {
  input: string;
  output?: string;
  configDir: string;
  linkageTermsFile?: string;
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

// ─── Builder ─────────────────────────────────────────────────────────────────

export function builder(cmd: Argv): Argv {
  return cmd
    .positional("input", {
      type: "string",
      describe: "input file path; if `-` reads from stdin",
      demandOption: true,
    })
    .positional("output", {
      type: "string",
      describe: "output file path; if absent, writes to stdout",
    })
    .option("config-dir", {
      type: "string",
      describe: "config directory (default: .psilink)",
    })
    .option("linkage-terms", {
      type: "string",
      describe:
        "path to a linkage terms file (YAML or JSON); overrides " +
        "linkageTerms in the config",
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

function extractArgs(argv: Arguments): ExchangeArgs {
  const input = String(argv._[0]);
  const output = argv._[1] !== undefined ? String(argv._[1]) : undefined;
  const configDir = (argv["config-dir"] as string | undefined) ?? ".psilink";
  const linkageTermsFile = argv["linkage-terms"] as string | undefined;
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

  let logLevel: logLibrary.LogLevelNumbers;
  if (rawLogLevel === "silent") logLevel = logLibrary.levels.SILENT;
  else if (rawLogLevel === "error") logLevel = logLibrary.levels.ERROR;
  else if (rawLogLevel === "warn") logLevel = logLibrary.levels.WARN;
  else if (rawLogLevel === "info") logLevel = logLibrary.levels.INFO;
  else if (rawLogLevel === "debug") logLevel = logLibrary.levels.DEBUG;
  else if (rawLogLevel === "trace") logLevel = logLibrary.levels.TRACE;
  else {
    throw new Error(`unrecognized log-level: ${argv["log-level"]}`);
  }

  const verbosity = (argv["verbose"] as number | undefined) ?? 0;

  return {
    input,
    output,
    configDir,
    linkageTermsFile,
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

function resolveConfig(args: ExchangeArgs): ExchangeSpec {
  let spec = loadExchangeSpec(args.configDir);

  if (args.linkageTermsFile !== undefined) {
    const content = fs.readFileSync(args.linkageTermsFile, "utf8");
    const raw: unknown = args.linkageTermsFile.toLowerCase().endsWith("json")
      ? JSON.parse(content)
      : YAML.parse(content);
    const result = safeParseLinkageTerms(raw);
    if (!result.success)
      throw new Error(
        `invalid linkage terms in ${args.linkageTermsFile}: ` +
          `${result.error.message}`,
      );
    spec = applyCliOverrides(spec, { linkageTerms: result.data });
  }

  const pakeToken = args.pakeToken ?? loadPakeToken(args.configDir);
  spec = applyCliOverrides(spec, {
    pakeToken,
    timeout: args.timeout,
    serverUsername: args.serverUsername,
    serverPassword: args.serverPassword,
    serverPrivateKey: args.serverPrivateKey,
    serverPort: args.serverPort,
  });

  if (spec.connection.channel !== "sftp")
    throw new Error("only the sftp channel is currently supported");

  return spec;
}

// ─── Protocol ────────────────────────────────────────────────────────────────

async function runProtocol(
  spec: ExchangeSpec,
  args: ExchangeArgs,
): Promise<void> {
  const sftpConfig = spec.connection as SFTPConnectionConfig;
  const log = logLibrary.getLogger("root");

  if (!fs.existsSync(args.input)) {
    log.error(`${args.input} does not exist`);
    process.exit(69);
  }

  log.info(
    "loaded exchange spec from",
    args.configDir + "; identity:",
    spec.linkageTerms.identity,
  );
  log.info(
    "linkage keys:",
    spec.linkageTerms.linkageKeys.map((k) => k.name).join(", "),
  );

  const conn = new SFTPConnection(new SSH2SFTPClientAdapter(), {
    verbose: args.verbosity,
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

  // PLACEHOLDER: getLinkageKeys currently uses hard-coded field definitions
  // from fixedLinkageKeys.ts. Once data pipelines are implemented, the
  // definitions will be derived from spec.linkageTerms.linkageKeys, and the
  // role-based split ("responder" / "initiator") will be replaced by
  // pipeline-driven key construction that is symmetric between parties.
  const { metadata: _metadata, linkageKeys } = await getMetadataAndLinkageKeys(
    fs.createReadStream(args.input),
    conn.handshakeRole === "responder"
      ? firstToPartyLinkageKeyDefinitions
      : secondToPartyLinkageKeyDefinitions
  );

  log.info("starting polling");
  conn.start();

  log.info("exchanging linkage terms");
  const { partnerTerms, warnings } = await exchangeTerms(
    conn,
    conn.handshakeRole!,
    spec.linkageTerms,
  );
  for (const warning of warnings) log.warn(warning);
  log.info("terms agreed, partner identity:", partnerTerms.identity);

  log.info("resolving role");
  const role = await resolveRole(
    conn,
    conn.handshakeRole!,
    spec.linkageTerms.output,
    partnerTerms.output,
    linkageKeys[0].length,
  );
  log.info("role will be:", role);

  // PLACEHOLDER: spec.linkageTerms.algorithm ("psi" vs "psi-c") will eventually
  // determine whether the full intersection or only its cardinality is
  // revealed. Currently PSI is always used regardless of the algorithm field.
  const participant = new PSIParticipant(
    role === "receiver" ? "client" : "server",
    await PSI(),
    {
      role: role === "receiver" ? "joiner" : "starter",
      verbose: args.verbosity,
    },
  );

  log.info("identifying intersection");
  // PLACEHOLDER: cardinality is hard-coded to "one-to-one", which corresponds
  // to spec.linkageTerms.deduplicate: true for both parties. When terms
  // cross-checking is added to the protocol, the combined cardinality will be
  // derived from both parties' deduplicate fields.
  const associationTable = await linkViaPSI(
    { cardinality: "one-to-one" },
    participant,
    conn,
    linkageKeys,
    args.verbosity,
  );

  log.info("stopping polling");
  conn.stop();

  log.info("closing connection");
  await conn.close();

  writeOutput(args.output, associationTable);
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

  const log = logLibrary.getLogger("root");
  setLogPrefixer(log);

  let spec: ExchangeSpec;
  try {
    spec = resolveConfig(args);
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(64);
  }

  await runProtocol(spec, args);
}
