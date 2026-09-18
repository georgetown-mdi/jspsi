import { hideBin } from "yargs/helpers";

import { sanitizeErrorForDisplay } from "@psilink/core";

import { buildCli } from "./cliParser";
import { armProcessReturnGate } from "./util/exitGate";

buildCli(hideBin(process.argv))
  .parseAsync()
  .then(() => {
    // The command has finished everything it owes -- every local write, the
    // drain that hands a stdout result to its reader, the terminal event, the
    // log flush -- so from here the process is only waiting for the event loop
    // to empty. Bound that wait (see armProcessReturnGate); a clean loop exits
    // before it and says nothing.
    armProcessReturnGate();
  })
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
