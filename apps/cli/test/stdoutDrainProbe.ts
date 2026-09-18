import fs from "node:fs";

import { writeOutput } from "../src/util/dataIo";

/**
 * A result CSV written to a real pipe under an injected idle ceiling, so what
 * the drain does with an actual reader on the other end can be measured from
 * outside.
 *
 * The drain is bounded by how long it goes with nothing leaving the process,
 * and nothing in this process decides that: the reader's pace does, through
 * the write callbacks the kernel's pipe buffer releases. A stub for either
 * side would be measuring the stub, so this is a child process writing to a
 * pipe the test holds, in the shape of `exitGateProbe.ts`. Both flags must be
 * supplied:
 *
 * - `--idle-ceiling-ms`: the drain's ceiling, cut from its shipped minute so a
 *   case measures the expiry rather than waiting one out.
 * - `--rows`: how many result rows to write, which a case sizes well past the
 *   pipe buffer so the reader's pace is what the drain waits on.
 *
 * It reports on stderr and ends on a status: `PROBE-DELIVERED <ms>` and 0 when
 * the last line left the process, `PROBE-UNDELIVERED <ms> <error>` and 1 when
 * the drain gave up. The exit code an undelivered result gives the OPERATOR is
 * 73 and is the run's to assign (`src/protocol.ts`), covered by the full-run
 * cases in `test/integration/backendAgnostic/stdoutResultDrain.test.ts`.
 */

function flagValue(name: string): number {
  const at = process.argv.indexOf(name);
  if (at < 0 || at + 1 >= process.argv.length)
    throw new Error(`${name} is required and was not given`);
  return Number(process.argv[at + 1]);
}

const idleCeilingMs = flagValue("--idle-ceiling-ms");
const rowCount = flagValue("--rows");

/** Padding, so a case reaches a multi-megabyte result in few enough rows. */
const FILLER = "x".repeat(96);

const headers = ["row_id", "filler"];
const rows = Array.from({ length: rowCount }, (_, index) => [
  String(index),
  FILLER,
]);

const startedAt = Date.now();
void writeOutput(
  undefined,
  headers,
  rows,
  { error: (message: string) => fs.writeSync(2, `${message}\n`) },
  idleCeilingMs,
).then(
  () => {
    fs.writeSync(2, `PROBE-DELIVERED ${Date.now() - startedAt}\n`);
    process.exit(0);
  },
  (err: unknown) => {
    fs.writeSync(
      2,
      `PROBE-UNDELIVERED ${Date.now() - startedAt} ${String(err)}\n`,
    );
    process.exit(1);
  },
);
