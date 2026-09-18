import fs from "node:fs";

import { FileSyncConnection } from "@psilink/core";

import { buildCli } from "../src/cliParser";
import { armProcessReturnGate } from "../src/util/exitGate";

/**
 * A real `psilink` run whose event loop is held after the run is over, so what
 * the process does next can be measured from outside.
 *
 * It is the process exiting that is under test, which the test runner's own
 * process cannot do, so this is a child probe in the shape of
 * `iceStatsExitProbe.ts`. It wires the entry point exactly as `src/index.ts`
 * does -- the same parser, the same gate after the same settlement -- with
 * four differences a test drives it through, each of which must be supplied:
 *
 * - `--probe-gate-budget-ms`: the gate's budget, cut from its shipped value so
 *   a case measures in seconds rather than waiting one out.
 * - `--probe-leak-ms`: arms a plain `setTimeout` nothing releases, the
 *   synthetic stand-in for a dependency's own armed handle. `0` arms none.
 * - `--probe-obligation-ms`: an obligation awaited after the command settles
 *   and before the gate is armed, so a case can check that the budget's clock
 *   starts after the run's obligations rather than during them.
 * - `--probe-cleanup-delay-ms`: slows the run's own transport teardown by that
 *   long, so an interrupt's cleanup outlasts the gate's budget by a fixed
 *   margin rather than by whatever a real close happens to take. `0` slows
 *   none.
 *
 * Everything after those four is the command line the run is given. The probe
 * reports on stderr: `PROBE-SETTLED` when the command promise settles, and
 * `PROBE-EXIT <ms>` from the exit hook, measured from settlement.
 */

function flagValue(name: string): number {
  const at = process.argv.indexOf(name);
  if (at < 0 || at + 1 >= process.argv.length)
    throw new Error(`${name} is required and was not given`);
  return Number(process.argv[at + 1]);
}

const gateBudgetMs = flagValue("--probe-gate-budget-ms");
const leakMs = flagValue("--probe-leak-ms");
const obligationMs = flagValue("--probe-obligation-ms");
const cleanupDelayMs = flagValue("--probe-cleanup-delay-ms");
const cliArgs = process.argv.slice(process.argv.indexOf("--") + 1);

if (leakMs > 0) setTimeout(() => {}, leakMs);

// The transport close every file-based teardown awaits, whichever layer
// reaches it first. Delaying it here is the one thing this probe changes
// inside the run; everything the delay sits under is the shipped path.
if (cleanupDelayMs > 0) {
  const close = FileSyncConnection.prototype.close;
  FileSyncConnection.prototype.close = async function (
    this: FileSyncConnection,
  ): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, cleanupDelayMs));
    await close.call(this);
  };
}

let settledAt: number | undefined;
process.on("exit", () => {
  const since = settledAt === undefined ? -1 : Date.now() - settledAt;
  fs.writeSync(2, `PROBE-EXIT ${since}\n`);
});

void buildCli(cliArgs)
  .parseAsync()
  .then(async () => {
    if (obligationMs > 0)
      await new Promise((resolve) => setTimeout(resolve, obligationMs));
    settledAt = Date.now();
    fs.writeSync(2, "PROBE-SETTLED\n");
    armProcessReturnGate(gateBudgetMs);
  })
  .catch((err: unknown) => {
    fs.writeSync(2, `PROBE-FAILED ${String(err)}\n`);
    process.exit(1);
  });
