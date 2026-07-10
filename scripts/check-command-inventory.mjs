#!/usr/bin/env node
// CLI command inventory check, run by static_checks.yaml on every PR.
//
// docs/DESIGN.md and docs/CLI.md enumerate the CLI's subcommands; the registry
// lives in apps/cli/src/cliParser.ts. The enumerations drift when a command
// ships without the overview docs being revisited (verify-receipt shipped and
// DESIGN.md said "five subcommands" until a later sweep caught it). Prose
// cannot assert a code fact reliably, so the claim is encoded as a check:
// every registered command name must appear in both docs.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PARSER = "apps/cli/src/cliParser.ts";
const DOCS = ["docs/DESIGN.md", "docs/CLI.md"];

/** Extract registered subcommand names from cliParser source (skips `$0`). */
export function registeredCommands(parserSource) {
  return [...parserSource.matchAll(/\.command\(\s*"([^"$][^"\s]*)/g)].map(
    (m) => m[1],
  );
}

/** Return `{doc, command}` pairs where a registered command is never mentioned. */
export function missingMentions(commands, docTexts) {
  const missing = [];
  for (const [doc, text] of Object.entries(docTexts)) {
    for (const command of commands) {
      if (!text.includes(command)) missing.push({ doc, command });
    }
  }
  return missing;
}

// CLI entry: only runs when invoked directly, so the test can import the pure
// functions without the process.exit.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const commands = registeredCommands(
    readFileSync(resolve(root, PARSER), "utf8"),
  );
  if (commands.length === 0) {
    console.error(
      `${PARSER}: no .command("...") registrations matched -- the extraction pattern rotted; fix scripts/check-command-inventory.mjs`,
    );
    process.exit(1);
  }
  const docTexts = Object.fromEntries(
    DOCS.map((d) => [d, readFileSync(resolve(root, d), "utf8")]),
  );
  const missing = missingMentions(commands, docTexts);
  if (missing.length > 0) {
    for (const { doc, command } of missing) {
      console.error(
        `${doc}: registered command "${command}" is never mentioned -- update the command enumeration.`,
      );
    }
    process.exit(1);
  }
  console.log(
    `Command inventory check passed: ${commands.length} commands (${commands.join(", ")}) mentioned in ${DOCS.join(", ")}.`,
  );
}
