import fs from "node:fs";
import logLibrary from "loglevel";
import type { AssociationTable } from "@psilink/core";

/** Mapping from log-level name to loglevel numeric constant. */
export const LOG_LEVELS: Record<string, logLibrary.LogLevelNumbers> = {
  silent: logLibrary.levels.SILENT,
  error: logLibrary.levels.ERROR,
  warn: logLibrary.levels.WARN,
  info: logLibrary.levels.INFO,
  debug: logLibrary.levels.DEBUG,
  trace: logLibrary.levels.TRACE,
};

/**
 * Validate that `input` is a readable file path; throws on failure.
 * Thrown errors carry an `exitCode` property for the caller to forward to
 * `process.exit`. Stdin (`-`) throws with `exitCode: 1`; a missing file
 * throws with `exitCode: 69`.
 */
export function validateInputFile(input: string): void {
  if (input === "-")
    throw Object.assign(
      new Error("reading from stdin is not yet implemented"),
      { exitCode: 69 },
    );
  if (!fs.existsSync(input))
    throw Object.assign(new Error(`${input} does not exist`), { exitCode: 69 });
}

/** Write the PSI association table to a file or stdout. */
export function writeOutput(
  output: string | undefined,
  table: AssociationTable,
): void {
  const out = output
    ? fs.createWriteStream(output, { encoding: "utf8" })
    : process.stdout;
  out.write("our_row_id,their_row_id\n");
  table[0].forEach((ours, i) => {
    out.write(`${ours},${table[1][i]}\n`);
  });
  if (output) (out as fs.WriteStream).close();
}
