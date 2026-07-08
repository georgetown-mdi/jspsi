import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { sanitizeErrorForDisplay } from "@psilink/core";

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

yargs(hideBin(process.argv))
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
  // offline commands read straight from argv._ (URL/input/output, invitation
  // strings) untouched -- full strict rejects those as "unknown arguments".
  .strictOptions()
  .fail((msg, err) => {
    // yargs invokes this for a parse/validation failure (msg set, err null) and
    // for an error thrown while parsing or in a command handler (err set). Let a
    // thrown error propagate to the top-level catch below, which sanitizes any
    // partner-/server-controlled bytes before display; only yargs' own validation
    // messages are handled here. An unrecognized option (or other argument-shape
    // failure) is a usage error, so exit 64 (EX_USAGE) to match the repeated-
    // single-value-option and other usage-error exits, rather than yargs' default
    // exit 1. The message is yargs' own fixed text (e.g. "Unknown arguments: ..."),
    // never partner-controlled, so it is safe to print directly.
    if (err) throw err;
    console.error(`${msg}\nRun with --help to see the available options.`);
    process.exit(64);
  })
  .help("h")
  .alias("h", "help")
  .alias("V", "version")
  .parseAsync()
  .catch((err: unknown) => {
    // Last-resort printer for an error that escaped every command handler. Route
    // it through the display-boundary sanitizer rather than console.error(err): a
    // raw transport error instance can carry partner- or server-controlled bytes
    // (e.g. a hostile message-file path) in its message or cause chain, and
    // console.error would spray them -- and Node's printed cause chain -- to the
    // terminal unescaped. Sanitizing here renders the message and sanitized cause
    // chain only; the stack frames are dropped, which is the intended trade at
    // this catch-all boundary.
    console.error(sanitizeErrorForDisplay(err));
    process.exit(1);
  });
