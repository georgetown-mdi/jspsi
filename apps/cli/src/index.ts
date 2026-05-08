import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import {
  configSchema,
  flattenObject,
  schemaToYargs,
  unflattenObject,
} from "./config";

import fs from "node:fs";
import os from "node:os";
import readline from "node:readline";
import logLibrary from "loglevel";
import YAML from "yaml";

import PSI from "@openmined/psi.js";

import {
  PSIParticipant,
  SFTPConnection,
  firstToPartyLinkageKeyDefinitions,
  getLinkageKeys,
  DEFAULT_FIELD_ALIASES,
  linkViaPSI,
  safeParseLinkageTerms,
  secondToPartyLinkageKeyDefinitions,
  setLogPrefixer,
} from "@psilink/core";

import {
  type LinkageTerms,
  columnsToFieldNames,
  getDefaultLinkageTerms
} from "@psilink/core";

import { SSH2SFTPClientAdapter } from "./connection/ssh2SftpAdapter";

// Reads and parses the first line of a CSV file as column names, normalized
// to lowercase with surrounding whitespace stripped. Returns an empty array if
// the file is empty or the first line cannot be read.

// TODO: modify to also work with a connection so that data can come from stdin
async function readCsvHeader(filePath: string): Promise<string[]> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath),
      crlfDelay: Infinity,
    });
    rl.once("line", (line) => {
      rl.close();
      resolve(line.split(",").map((col) => col.trim().toLowerCase()));
    });
    rl.once("error", () => resolve([]));
    // Fires after "close" if the file was empty.
    rl.once("close", () => resolve([]));
  });
}

async function run() {
  const { positionals, options, groups } = schemaToYargs(configSchema);

  const positionalsForUsage = positionals
    .map((p) => {
      return !p.meta.demandOption ? "[" + p.key + "]" : p.key;
    })
    .join(" ");

  const cli = yargs()
    .scriptName("psi-link")
    .command("invite", "Generate an invitation and wait to execute exchange")
    .command("accept", "View details and choose to execute exchange")
    .command(
      [`exchange`, "$0"],
      "Link data using private set intersection",
      (cmd) => {
        let numRequiredPositionals = 0;
        for (const { key, meta } of positionals) {
          cmd = cmd.positional(key, meta);
          if (meta.demandOption) numRequiredPositionals++;
        }
        for (const { key, meta } of options) {
          cmd = cmd.option(key, meta);
        }
        for (const [key, groupName] of groups) {
          cmd = cmd.group(key, groupName);
        }
        cmd = cmd.option("config", {
          type: "string",
          describe: "optional config file (YAML or JSON)",
        });
        cmd = cmd.option("linkageTerms", {
          type: "string",
          describe:
            "path to an exchange linkageTerms file (YAML or JSON); overrides " +
            "any linkageTerms specified in the config file",
        });

        return cmd.demand(numRequiredPositionals);
      },
    )
    .usage(`$0 <command> [options] ${positionalsForUsage}`)
    .help("h")
    .alias("h", "help")
    .alias("v", "version")
    .alias("p", "passkey")
    .alias("t", "timeout");

  const argv = cli.parseSync(
    hideBin(process.argv).map((arg) => {
      // capture --verbose and prevent it from consuming an argument
      if (arg === "--verbose") {
        return "--verbose=info";
      }
      return arg;
    }),
  );
  // @ts-expect-error it does exists
  const newAliases = cli.parsed.newAliases as { [key: string]: boolean };
  Object.entries(newAliases).forEach(([key]) => {
    delete argv[key];
  });
  ["h", "v", "p", "t"].forEach((key) => {
    delete argv[key];
  });

  // Extract special options that are handled outside configSchema.
  const configFile = argv["config"] as string | undefined;
  const linkageTermsFile = argv["linkageTerms"] as string | undefined;

  const positionalArgs = Object.fromEntries(
    argv._.map((x, i) => {
      return [positionals[i].key, x];
    }),
  );
  const optionPathMap = Object.fromEntries(
    options.map((x) => [x.key, x.meta.optionPath]),
  );

  // Build explicit CLI overrides, excluding special options and undefined
  // values. Filtering undefined ensures that options not set on the command
  // line don't shadow values from the config file.
  const cliArgs: Record<string, unknown> = Object.fromEntries(
    Object.entries({
      ...positionalArgs,
      ...Object.fromEntries(
        Object.entries(argv)
          .filter(
            ([key]) =>
              key !== "_" &&
              key !== "$0" &&
              key !== "config" &&
              key !== "linkageTerms",
          )
          .map(([key, value]) => [optionPathMap[key] || key, value]),
      ),
    }).filter(([, v]) => v !== undefined),
  );

  // If a config file is provided, it forms the base; CLI args take precedence.
  let rawlinkageTerms: unknown = undefined;
  let mergedArgs: Record<string, unknown> = cliArgs;

  if (configFile && typeof configFile === "string") {
    const configContent = fs.readFileSync(configFile, "utf8");
    const parsed: unknown = configFile.toLowerCase().endsWith("json")
      ? JSON.parse(configContent)
      : YAML.parse(configContent);

    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      const parsedRecord = parsed as Record<string, unknown>;

      // Extract the linkageTerms block before flattening so its nested structure
      // is preserved for safeParseExchangelinkageTerms below. The config file's
      // linkageTerms key must be an inline object (YAML block); use --linkageTerms
      // to reference a standalone file.
      if ("linkageTerms" in parsedRecord) {
        rawlinkageTerms = parsedRecord["linkageTerms"];
        delete parsedRecord["linkageTerms"];
      }

      const configOptions = Object.fromEntries(
        Object.entries(flattenObject(parsedRecord, "", "-")).map(
          ([key, value]) => [optionPathMap[key] || key, value],
        ),
      );

      // Config file is the base; explicit CLI args override it.
      mergedArgs = { ...configOptions, ...cliArgs };
    }
  }

  const cliOptions = configSchema.safeParse(unflattenObject(mergedArgs));
  if (!cliOptions.success) {
    console.error("unable to parse input:", cliOptions.error);
    cli.showHelp();
    process.exit(64);
  }

  // server and input are optional in configSchema so they can come from a
  // config file, but both are required to run an exchange.
  if (!cliOptions.data.server) {
    console.error(
      "server URL is required: provide it as the first positional argument " +
        "or set `server` in a config file",
    );
    cli.showHelp();
    process.exit(64);
  }
  if (!cliOptions.data.input) {
    console.error(
      "input path is required: provide it as the second positional argument " +
        "or set `input` in a config file",
    );
    cli.showHelp();
    process.exit(64);
  }

  // TypeScript narrowing: both are confirmed present above.
  const server = cliOptions.data.server;
  const input = cliOptions.data.input;

  const verbosity = cliOptions.data.verbose;
  if (verbosity >= 4) {
    logLibrary.setDefaultLevel(logLibrary.levels.TRACE);
  } else if (verbosity === 3) {
    logLibrary.setDefaultLevel(logLibrary.levels.DEBUG);
  } else if (verbosity === 2) {
    logLibrary.setDefaultLevel(logLibrary.levels.INFO);
  } else if (verbosity === 1) {
    logLibrary.setDefaultLevel(logLibrary.levels.WARN);
  } else if (verbosity === 0) {
    logLibrary.setDefaultLevel(logLibrary.levels.ERROR);
  } else {
    logLibrary.setDefaultLevel(logLibrary.levels.SILENT);
  }

  const log = logLibrary.getLogger("root");
  setLogPrefixer(log);

  if (!fs.existsSync(input)) {
    log.error(`${input} does not exist`);
    process.exit(69);
  }

  // Load exchange linkageTerms: --linkageTerms flag > config file inline > default.
  //
  // The linkageTerms is validated here but does not yet drive runtime behavior;
  // see the PLACEHOLDER comments below and in defaultlinkageTerms.ts. Once data
  // pipelines are implemented, linkageKeys and algorithm will control key
  // construction and PSI setup respectively.
  let linkageTerms: LinkageTerms;
  if (linkageTermsFile) {
    const content = fs.readFileSync(linkageTermsFile, "utf8");
    const raw: unknown = linkageTermsFile.toLowerCase().endsWith("json")
      ? JSON.parse(content)
      : YAML.parse(content);
    const result = safeParseLinkageTerms(raw);
    if (!result.success) {
      log.error("invalid exchange linkageTerms in", linkageTermsFile);
      log.error(result.error);
      process.exit(64);
    }
    linkageTerms = result.data;
    log.info("loaded exchange linkageTerms from", linkageTermsFile);
  } else if (rawlinkageTerms !== undefined) {
    const result = safeParseLinkageTerms(rawlinkageTerms);
    if (!result.success) {
      log.error("invalid exchange linkageTerms in config file");
      log.error(result.error);
      process.exit(64);
    }
    linkageTerms = result.data;
    log.info("loaded exchange linkageTerms from config file");
  } else {
    // Read the CSV header to detect which semantic types are present and
    // tailor the default linkage keys accordingly. Skipped for stdin ("-")
    // since the stream cannot be rewound after header consumption.
    let columns: string[] | undefined;
    if (input !== "-") {
      columns = await readCsvHeader(input);
      if (columns.length === 0) {
        log.warn(
          "could not read CSV header; default linkageTerms will include all" +
            " linkage key templates",
        );
      } else {
        const available = columnsToFieldNames(columns);
        log.info(
          "detected CSV columns:",
          columns.join(", "),
          "→ linkage fields:",
          [...available].join(", "),
        );
      }
    }
    linkageTerms = getDefaultLinkageTerms(os.userInfo()["username"], columns);
    log.info(
      "no exchange linkageTerms specified; using default (identity:",
      linkageTerms.identity + ")",
    );
    log.info(
      "default linkageTerms linkage keys:",
      linkageTerms.linkageKeys.map((k) => k.name).join(", "),
    );
  }

  const conn = new SFTPConnection(new SSH2SFTPClientAdapter(), {
    verbose: verbosity >= 2 ? 2 : verbosity === 1 ? 1 : 0,
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
    server,
    "with options",
    cliOptions.data.serverOptions,
  );
  await conn.open(server, cliOptions.data.serverOptions);

  log.info("synchronizing");
  await conn.synchronize();

  log.info("synchronized to firstToParty", conn.firstToParty);

  // PLACEHOLDER: getLinkageKeys currently uses hard-coded field definitions
  // from fixedLinkageKeys.ts. Once data pipelines are implemented, the
  // definitions will be derived from linkageTerms.linkageKeys, and the role-based
  // split (firstToParty vs secondToParty) will be replaced by pipeline-driven
  // key construction that is symmetric between parties.
  //
  // The current definitions also include truncation variants (e.g. first 3
  // characters of lastName) that are pipeline transformations and cannot yet
  // be expressed in the LinkageKey schema.
  const data = await getLinkageKeys(
    fs.createReadStream(input),
    conn.firstToParty
      ? firstToPartyLinkageKeyDefinitions
      : secondToPartyLinkageKeyDefinitions,
    DEFAULT_FIELD_ALIASES,
  );

  log.info("starting polling");
  conn.start();

  // PLACEHOLDER: linkageTerms.algorithm ("psi" vs "psi-c") will eventually
  // determine whether the full intersection or only its cardinality is
  // revealed. Currently PSI is always used regardless of the algorithm field.
  const participant = new PSIParticipant(
    conn.firstToParty ? "server" : "client",
    await PSI(),
    {
      role: conn.firstToParty ? "starter" : "joiner",
      verbose: verbosity >= 2 ? 2 : verbosity === 1 ? 1 : 0,
    },
  );

  log.info("exchanging roles");
  await participant.exchangeRoles(conn, conn.firstToParty!);

  log.info("identifying intersection");
  // PLACEHOLDER: cardinality is hard-coded to "one-to-one", which corresponds
  // to linkageTerms.deduplicate: true for both parties. When linkageTerms
  // cross-checking is added to the protocol, the combined cardinality will be
  // derived from both parties' deduplicate fields.
  const associationTable = await linkViaPSI(
    { cardinality: "one-to-one" },
    participant,
    conn,
    data,
  );

  log.info("stopping polling");
  conn.stop();

  log.info("closing connection");
  conn.close();

  const out = cliOptions.data.output
    ? fs.createWriteStream(cliOptions.data.output, { encoding: "utf8" })
    : process.stdout;

  out.write("our_row_id,their_row_id\n");
  associationTable[0].forEach((ours, i) => {
    out.write(`${ours},${associationTable[1][i]}\n`);
  });
  // @ts-expect-error it will be a write stream if data.output
  if (cliOptions.data.output) out.close();
}

run();
