import { readFileSync } from "node:fs";
import * as path from "node:path";

import yargs from "yargs";
import type { Argv } from "yargs";

import { sanitizeForDisplay } from "@psilink/core";

import {
  builder as zeroSetupBuilder,
  handler as zeroSetupHandler,
} from "./commands/zeroSetup";
import {
  builder as exchangeBuilder,
  handler as exchangeHandler,
} from "./commands/exchange";
import {
  builder as fingerprintBuilder,
  handler as fingerprintHandler,
} from "./commands/fingerprint";
import {
  builder as inviteBuilder,
  handler as inviteHandler,
} from "./commands/invite";
import {
  builder as acceptBuilder,
  handler as acceptHandler,
} from "./commands/accept";
import {
  builder as initBuilder,
  handler as initHandler,
} from "./commands/init";
import {
  builder as probeHostKeyBuilder,
  handler as probeHostKeyHandler,
} from "./commands/probeHostKey";
import {
  builder as verifyReceiptBuilder,
  handler as verifyReceiptHandler,
} from "./commands/verifyReceipt";
import { builder as doctorBuilder } from "./commands/doctor";

/**
 * Read this package's own version from its co-located package.json, resolved
 * from `__dirname` rather than left to yargs' `.version()` default: yargs
 * walks up from its own install directory, which in this npm-workspaces
 * monorepo lands on the repo root and reports the root manifest's version
 * instead. `__dirname` resolves correctly both from the built dist
 * (dist/index.js) and this source file under a test runner (src/cliParser.ts)
 * -- both one level below apps/cli, so `../package.json` is the same relative
 * path in either.
 */
function readCliVersion(): string {
  const pkgPath = path.join(__dirname, "..", "package.json");
  // Non-sensitive: this package's own manifest, not a credential file, so there
  // is no secret for a parse error to leak.
  // eslint-disable-next-line no-restricted-properties -- non-credential parse, see above
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
  return pkg.version;
}

/**
 * Build the configured psilink yargs parser for `argv`, up to but NOT including
 * `.parseAsync()`. Kept separate from the entry point (`index.ts`) so importing
 * it has no side effect: the entry point drives it against the real process argv,
 * and tests drive it against a synthetic one to assert the strict-option / fail
 * behavior without spawning the binary. Each call constructs a fresh instance, so
 * a test may parse repeatedly.
 */
export function buildCli(argv: string[]): Argv {
  return (
    yargs(argv)
      .scriptName("psilink")
      .version(readCliVersion())
      .command(
        "$0",
        "Quick exchange (no shared secret; trusts the server): psilink " +
          "[--save] URL INPUT_FILE [OUTPUT_FILE]",
        zeroSetupBuilder,
        zeroSetupHandler,
      )
      .command(
        "init [args..]",
        "Write a commented configuration template (no exchange, no key file)",
        initBuilder,
        initHandler,
      )
      .command(
        "invite [args..]",
        "Generate an invitation (offline), or invite and run an exchange (online)",
        inviteBuilder,
        inviteHandler,
      )
      .command(
        "accept [args..]",
        "Accept a partner invitation (offline), or accept and run (online)",
        acceptBuilder,
        acceptHandler,
      )
      .command(
        "exchange <input> [output]",
        "Execute a recurring exchange",
        exchangeBuilder,
        exchangeHandler,
      )
      .command(
        "fingerprint",
        "Show (and lazily create) this party's signing certificate fingerprint",
        fingerprintBuilder,
        fingerprintHandler,
      )
      .command(
        "probe-host-key <sftp-url>",
        "Read and print an SFTP server's host-key fingerprint (no credential sent)",
        probeHostKeyBuilder,
        probeHostKeyHandler,
      )
      .command(
        "verify-receipt <record> [input-file] [result-file]",
        "Verify a stored exchange record and open its commitments (read-only)",
        verifyReceiptBuilder,
        verifyReceiptHandler,
      )
      // Registered with a builder and no handler: the builder demands one of the
      // `probe` / `mount` subcommands, so there is no bare `psilink doctor` for a
      // handler to serve.
      .command(
        "doctor",
        "Check a network file drop before an exchange (probe | mount)",
        doctorBuilder,
      )
      .usage("$0 [command] [options]")
      // Fail fast on a misspelled option (e.g. --server-user for
      // --server-username): otherwise yargs drops it unread into argv,
      // silently ignoring a typo'd credential or path override. strictOptions
      // (not strict) validates flags only, leaving the zero-setup/exchange
      // commands' argv._ positionals (URL/input/output) untouched; full
      // strict would reject those as unknown arguments. invite/accept/init
      // instead set unknown-options-as-args (to admit a `-`-leading
      // invitation string as a positional), so a mistyped option there is
      // absorbed as a positional and caught by the command's own validation
      // instead.
      .strictOptions()
      .fail((msg, err) => {
        // yargs invokes this for a parse/validation failure (msg set, err
        // null) and for an error thrown while parsing or in a handler (err
        // set); a thrown error propagates to the caller's catch, which
        // sanitizes partner-/server-controlled bytes before display. An
        // unrecognized option is a usage error: exit 64 (EX_USAGE), matching
        // the CLI's other usage-error exits. `msg` comes from this operator's
        // own command line but still routes through the display-boundary
        // sanitizer. The trailing hint is fixed text, kept outside the
        // sanitize call to preserve its literal newline.
        if (err) throw err;
        console.error(
          `${sanitizeForDisplay(msg)}\nRun with --help to see the available options.`,
        );
        process.exit(64);
      })
      .help("h")
      .alias("h", "help")
      .alias("V", "version")
  );
}
