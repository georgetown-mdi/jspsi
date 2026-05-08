import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import {
  builder as exchangeBuilder,
  handler as exchangeHandler,
} from "./commands/exchange";

yargs(
  hideBin(process.argv).map((arg) =>
    arg === "--verbose" ? "--verbose=info" : arg,
  ),
)
  .scriptName("psi-link")
  .command("invite", "Generate an invitation and wait to execute exchange")
  .command("accept", "View details and choose to execute exchange")
  .command(
    ["exchange", "$0"],
    "Link data using private set intersection",
    exchangeBuilder,
    exchangeHandler,
  )
  .usage("$0 <command> [options] input [output]")
  .help("h")
  .alias("h", "help")
  .alias("v", "version")
  .parseAsync()
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
