import yargs from "yargs";
import { hideBin } from "yargs/helpers";

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
    console.error(err);
    process.exit(1);
  });
