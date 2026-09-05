import { hideBin } from "yargs/helpers";

import { sanitizeErrorForDisplay } from "@psilink/core";

import { buildCli } from "./cliParser";

buildCli(hideBin(process.argv))
  .parseAsync()
  .catch((err: unknown) => {
    // Last-resort printer for an error that escaped every command handler.
    // Routes through the display-boundary sanitizer rather than
    // console.error(err): a raw transport error can hold partner- or
    // server-controlled bytes (e.g. a hostile message-file path) in its
    // message or cause chain, which console.error would print unescaped.
    // Sanitizing renders the message and cause chain only; the stack frames
    // are dropped as the trade at this catch-all boundary.
    console.error(sanitizeErrorForDisplay(err));
    process.exit(1);
  });
