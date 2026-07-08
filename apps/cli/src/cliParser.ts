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
  builder as verifyReceiptBuilder,
  handler as verifyReceiptHandler,
} from "./commands/verifyReceipt";

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
      .command(
        "$0",
        "Quick exchange: psilink [--save] URL INPUT_FILE [OUTPUT_FILE]",
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
        "verify-receipt <record> [input-file] [result-file]",
        "Verify a stored exchange record and open its commitments (read-only)",
        verifyReceiptBuilder,
        verifyReceiptHandler,
      )
      .usage("$0 [command] [options]")
      // Fail fast on a misspelled option (e.g. --server-user for --server-username):
      // without this, yargs silently drops an unrecognized flag into argv where no
      // command reads it, so a typo'd credential or path override is quietly ignored
      // and the run proceeds with the wrong (or default) value. strictOptions, not
      // strict: it validates flags only, leaving the positionals the zero-setup and
      // exchange commands read straight from argv._ (URL/input/output) untouched --
      // full strict rejects those as "unknown arguments". The invite/accept/init
      // commands set unknown-options-as-args (to admit a `-`-leading invitation
      // string as a positional), so on those a mistyped option is absorbed as a
      // positional and caught by the command's own argument validation instead.
      .strictOptions()
      .fail((msg, err) => {
        // yargs invokes this for a parse/validation failure (msg set, err null) and
        // for an error thrown while parsing or in a command handler (err set). Let a
        // thrown error propagate to the caller's catch, which sanitizes any partner-/
        // server-controlled bytes before display; only yargs' own validation
        // messages are handled here. An unrecognized option (or other argument-shape
        // failure) is a usage error, so exit 64 (EX_USAGE) to match the repeated-
        // single-value-option and other usage-error exits, rather than yargs' default
        // exit 1. yargs builds `msg` from the option tokens on this operator's own
        // command line, so it should hold no wire-controlled bytes -- but it is
        // routed through the same display-boundary sanitizer as every other operator-
        // facing sink rather than trusting that: the sanitizer makes the safety a
        // property of the code, not a comment that could rot. The trailing hint is
        // fixed text, so it stays outside the sanitize call to keep its newline
        // literal.
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
