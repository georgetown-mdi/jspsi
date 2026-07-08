import { hideBin } from "yargs/helpers";

import { sanitizeErrorForDisplay } from "@psilink/core";

import { buildCli } from "./cliParser";

buildCli(hideBin(process.argv))
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
