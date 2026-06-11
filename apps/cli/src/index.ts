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

yargs(hideBin(process.argv))
  .scriptName("psilink")
  .command(
    "$0",
    "Quick exchange: psilink [--save] URL INPUT_FILE [OUTPUT_FILE]",
    zeroSetupBuilder,
    zeroSetupHandler,
  )
  .command(
    "init [input]",
    "Generate a configuration template",
    () => {},
    () => {
      console.error("psilink init: not yet implemented");
      process.exit(1);
    },
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
  .usage("$0 [command] [options]")
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
