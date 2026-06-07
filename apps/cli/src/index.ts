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
    "invite",
    "Generate an invitation",
    () => {},
    () => {
      console.error("psilink invite: not yet implemented");
      process.exit(1);
    },
  )
  .command(
    "accept",
    "Accept a partner invitation",
    () => {},
    () => {
      console.error("psilink accept: not yet implemented");
      process.exit(1);
    },
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
