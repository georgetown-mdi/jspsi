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

import { applyConnectionOverrides } from "../config";
import { loadKeyFile, type KeyFile } from "../keyFile";
import { resolveAtSignRefs } from "../util/atSignRefs";
import { LOG_LEVELS, validateInputFile } from "../util/cli";
import {
  runProtocol,
  type AuthPersist,
  type ProtocolConnectionConfig,
} from "../protocol";

// Defined here rather than in protocol.ts: it is only needed as the return
// type of loadConfig and does not belong to the protocol layer's public API.
type AuthenticatedConnectionConfig = ProtocolConnectionConfig & {
  authentication: AuthPersist;
};

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
        "Overrides connection.options.peer_id in config. Requires " +
        "timestamp_in_filename: true. Both parties must use distinct ids",
    })
    .option("retain-files", {
      type: "boolean",
      describe:
        "keep all exchange files as a permanent transcript instead of " +
        "deleting them after consumption; intended for sync-mediated " +
        "transports that do not propagate deletions and for audit use cases. " +
        "Requires timestamp_in_filename: true in config. Both parties must " +
        "set this flag identically -- a mismatch causes the exchange to stall " +
        "until the peer timeout fires (fast-fail detection not yet available). " +
        "A fresh directory is required for each exchange and is enforced: " +
        "reusing a directory with retained files from a prior session is " +
        "rejected with an error at startup",
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
  retainFiles?: boolean;
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
    locklessRendezvous: argv["lockless-rendezvous"] as boolean | undefined,
    peerId: argv["peer-id"] as string | undefined,
    retainFiles: argv["retain-files"] as boolean | undefined,
    logLevel,
    verbosity: (argv["verbose"] as number | undefined) ?? 0,
  };
}

// --- Config loading ----------------------------------------------------------

/** @internal exported for testing */
export function loadConfig(
  options: ExchangeOptions,
): { connection: AuthenticatedConnectionConfig } & ExchangeDataSpec {
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

  // Warn about and strip auth fields the CLI always ignores. This runs before
  // parseExchangeSpec (which applies Zod validation and `camelizeKeys`), so
  // we see raw user-input keys: a single canonical name may appear as either
  // its snake_case form (the YAML convention) or its camelCase form (if the
  // user wrote camelCase directly). Both forms must be listed for each
  // canonical name or one would slip through silently.
  //
  // The named keys get specific guidance; any other field under
  // `authentication` (e.g. typos like `expires_at` or `pakeTok`) gets a
  // generic warning so the user sees the silent drop rather than wondering
  // why their setting did nothing.
  //
  // CANONICAL_TO_USER_FORMS centralizes the dual-form mapping so a future
  // field cannot be added to only one of the two lookups.
  const CANONICAL_TO_USER_FORMS: Record<string, string[]> = {
    pakeToken: ["pake_token", "pakeToken"],
    expires: ["expires"],
    role: ["role"],
  };
  const CANONICAL_TO_HINT: Record<string, string> = {
    pakeToken:
      "the token is always loaded from the key file (any @-file reference " +
      "in this field was also not resolved)",
    expires:
      "expiration is always loaded from the key file (any @-file reference " +
      "in this field was also not resolved)",
    role: "this field is only valid for the WebRTC channel",
  };
  const KEY_SPECIFIC_HINT: Record<string, string> = Object.fromEntries(
    Object.entries(CANONICAL_TO_USER_FORMS).flatMap(([canonical, forms]) =>
      forms.map((form) => [form, CANONICAL_TO_HINT[canonical]]),
    ),
  );
  const rawConn = (rawConfig as Record<string, unknown>)?.["connection"];
  if (typeof rawConn === "object" && rawConn !== null) {
    // `role` is a valid WebRTC field; only the sftp/filedrop channels treat
    // it as ignored. Detect the channel from the raw config before Zod parses
    // and normalizes it so we do not strip a field WebRTC will need.
    const isWebRTC =
      (rawConn as Record<string, unknown>)["channel"] === "webrtc";
    const canonicalIgnored = isWebRTC
      ? ["pakeToken", "expires"]
      : ["pakeToken", "expires", "role"];
    const ignoredKeys = canonicalIgnored.flatMap(
      (canonical) => CANONICAL_TO_USER_FORMS[canonical],
    );
    const rawAuth = (rawConn as Record<string, unknown>)?.["authentication"];
    if (typeof rawAuth === "object" && rawAuth !== null) {
      const a = rawAuth as Record<string, unknown>;
      for (const key of Object.keys(a)) {
        // On the webrtc channel, `role` is a valid field: leave it intact so
        // Zod parses it normally and the strip-and-warn message does not
        // contradict the actual channel.
        if (isWebRTC && key === "role") continue;
        if (ignoredKeys.includes(key)) {
          log.warn(
            `${options.configFile}: connection.authentication.${key} is set ` +
              `and will be ignored; ${KEY_SPECIFIC_HINT[key]}`,
          );
        } else {
          log.warn(
            `${options.configFile}: connection.authentication.${key} is not ` +
              "a recognized field and will be silently dropped; valid keys " +
              "are loaded from the key file or apply only to the WebRTC " +
              "channel (see EXCHANGE_SPEC.md#connectionauthentication)",
          );
        }
        delete a[key];
      }
    }
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
    locklessRendezvous: options.locklessRendezvous,
    peerId: options.peerId,
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
      `key file ${options.keyFile} does not exist. ` +
        "The CLI commands that create a key file (psilink invite, psilink " +
        "accept, and psilink --save) are not yet implemented; until they " +
        "land, the key file must be created out-of-band - a base64url-" +
        'encoded 32-byte token under "pakeToken" - and copied to both ' +
        "parties via a trusted channel. See " +
        "docs/SECURITY_DESIGN.md#recurring-exchange-authentication.",
    );
  const authPersist: AuthPersist = {
    pakeToken: keyData.pakeToken,
    expires: keyData.expires,
    keyFilePath: options.keyFile,
  };
  // Spread + cast: `connection` is `ConnectionConfig` (which includes the
  // webrtc channel), so TypeScript cannot verify that the spread result fits
  // `AuthenticatedConnectionConfig` (constrained to sftp and filedrop). The
  // double cast through `unknown` is intentional; the channel guard above
  // ensures only sftp/filedrop configs reach this point.
  return {
    connection: {
      ...connection,
      authentication: authPersist,
    } as unknown as AuthenticatedConnectionConfig,
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
    process.exit(err instanceof UsageError ? 64 : 69);
  }
}
