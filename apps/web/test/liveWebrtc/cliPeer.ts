import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

import { cliEntry, pairsFromResultCsv } from "../interop/cliParty.ts";
import { LEG_ENVIRONMENT_FAILURE } from "./legTypes.ts";
import { trackChild } from "./childProcess.ts";

import type { LiveLegCliOutcome, MatchedPair } from "./legTypes.ts";

/**
 * The `alcove invite` party of the live WebRTC leg: the real command-line
 * program, spawned the way the console's job driver spawns it, holding the
 * inviter seat while the browser peer accepts.
 *
 * The CLI takes the inviter seat rather than the acceptor because that is what
 * puts the broker on an origin of its own: the invitation the CLI mints from
 * its `ws://` coordination-server URL names that broker's host, port and mount,
 * and the browser peer dials what the invitation names. A browser inviter would
 * name its own page's origin instead (`inviterLocationFromWindow`).
 *
 * Nothing here parses the CLI's output beyond two fixed things -- the
 * invitation on stdout, and the timestamp of the "closing connection" line the
 * close wait is measured from.
 */

/** Longest to wait for the invitation to reach stdout. The mint is local work
 * (reading the CSV, inferring terms, writing the key file), so this bounds a
 * process that failed to start rather than a slow one. */
const INVITATION_TIMEOUT_MS = 60_000;

/**
 * The inviting party's budget for the whole run: the wait for the browser peer
 * to accept, plus the peer waits of the exchange after it. It has to clear a
 * cold Chromium start, the browser's WASM engine load, and an ICE round, so it
 * is sized well above the exchange itself.
 */
export const CLI_ACCEPT_TIMEOUT_MS = 240_000;

/**
 * Hard deadline on the process, past the budget above so a run that hangs is
 * reported as killed rather than absorbed into the budget's own expiry.
 */
const CLI_DEADLINE_MS = 300_000;

/** The message fragment the close wait is measured from: the CLI writes it
 * immediately before the transport close that drains to acknowledgement and
 * tears the channel down (`closeRunLayers` in apps/cli/src/protocol.ts). */
const CLOSING_CONNECTION_LINE = "closing connection";

/** What the CLI party links on. Two rows in common with the browser peer's
 * file, at different offsets on each side, so a party reading its own table
 * back cannot pass by symmetry. */
const CLI_CSV =
  "first_name,last_name,date_of_birth\n" +
  "Bob,Jones,1990-01-02\n" +
  "Carol,Lee,1985-07-16\n" +
  "Dave,Kim,1978-11-30\n";

/** The identity the CLI party declares, which the browser peer reads back off
 * the agreed terms. */
export const CLI_IDENTITY = "Agency A, a@agency-a.example";

/** An `alcove invite` that has printed its invitation and is waiting for the
 * partner. */
export interface CliInviter {
  /** The invitation it printed, for the browser peer to accept. */
  invitation: string;
  /** Wait for the run to end and report what it did. */
  outcome: () => Promise<LiveLegCliOutcome>;
  /** Kill the run if it is still going, and remove its working directory.
   * Idempotent. */
  stop: () => Promise<void>;
}

/** The timestamp of the first log line holding `fragment`, read from the head
 * of the CLI's own log format, or null when no line holds it. */
function loggedAt(output: string, fragment: string): number | null {
  const line = output.split("\n").find((one) => one.includes(fragment));
  const stamp = line?.match(/^\[([^\]]+)\]/)?.[1];
  const parsed = stamp === undefined ? Number.NaN : Date.parse(stamp);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * The matched pairs the CLI party's result file holds, or null when it wrote
 * none.
 *
 * Read only from a run that exited 0 within its deadline: a killed or failing
 * run can leave a truncated file, and the parse error that file raises would be
 * the first thing the leg reported about the run, ahead of the kill or the exit
 * status that explains it. A file that will not parse after a clean exit is
 * raised with the run's own output beside it, which is what diagnoses it.
 */
function readPairs(
  resultPath: string,
  output: string,
): Array<MatchedPair> | null {
  if (!existsSync(resultPath)) return null;
  try {
    return pairsFromResultCsv(resultPath);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `the CLI party exited 0, but its result file at ${resultPath} did not ` +
        `parse: ${reason}\n${output}`,
    );
  }
}

/**
 * Spawn `alcove invite` against `brokerUrl` and resolve once it has printed
 * its invitation.
 *
 * Rejects with a {@link LEG_ENVIRONMENT_FAILURE} message when the CLI is not
 * built, cannot be spawned, exits before printing, or prints nothing that looks
 * like an invitation -- none of which is an interop divergence.
 *
 * `program` is what is spawned -- this process's own `node` running the built
 * CLI entry -- which a test overrides to drive a spawn that does not happen.
 */
export async function startCliInviter(
  brokerUrl: string,
  program: { executable: string; entry: string } = {
    executable: process.execPath,
    entry: cliEntry,
  },
): Promise<CliInviter> {
  if (!existsSync(program.entry))
    throw new Error(
      `${LEG_ENVIRONMENT_FAILURE} the CLI party is the built program at ` +
        `${program.entry}, which is absent. Run 'npm run build -w apps/cli'.`,
    );

  const work = mkdtempSync(path.join(tmpdir(), "alcove-live-webrtc-"));
  const inputPath = path.join(work, "input.csv");
  const outputPath = path.join(work, "result.csv");
  writeFileSync(inputPath, CLI_CSV);

  const child = spawn(
    program.executable,
    [
      program.entry,
      "invite",
      brokerUrl,
      inputPath,
      outputPath,
      "--config-file",
      path.join(work, "alcove.yaml"),
      "--key-file",
      path.join(work, "alcove.key"),
      "--identity",
      CLI_IDENTITY,
      "--accept-timeout",
      `${CLI_ACCEPT_TIMEOUT_MS / 1000}s`,
      "--no-record",
      // The close wait is read off this party's own timestamped log, so the
      // level has to be one that writes the line it is measured from.
      "--log-level",
      "info",
    ],
    { cwd: work, stdio: ["ignore", "pipe", "pipe"] },
  );
  const stopTracked = trackChild(child);

  let output = "";
  let stdout = "";
  let killedOnDeadline = false;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    output += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    output += chunk;
  });
  const deadline = setTimeout(() => {
    killedOnDeadline = true;
    child.kill("SIGKILL");
  }, CLI_DEADLINE_MS);

  const ended = new Promise<{ exitCode: number | null; endedAt: number }>(
    (resolve) => {
      child.once("close", (exitCode) => {
        clearTimeout(deadline);
        resolve({ exitCode, endedAt: Date.now() });
      });
    },
  );

  const stop = async (): Promise<void> => {
    clearTimeout(deadline);
    await stopTracked();
    rmSync(work, { recursive: true, force: true });
  };

  const invitation = await new Promise<string>((resolve, reject) => {
    let settled = false;
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.off("data", onData);
      action();
    };
    const fail = (reason: string): void =>
      settle(() =>
        reject(new Error(`${LEG_ENVIRONMENT_FAILURE} ${reason}\n${output}`)),
      );
    const timer = setTimeout(
      () =>
        fail(
          `the CLI party printed no invitation within ` +
            `${INVITATION_TIMEOUT_MS}ms`,
        ),
      INVITATION_TIMEOUT_MS,
    );
    const onData = (): void => {
      const newline = stdout.indexOf("\n");
      if (newline === -1) return;
      const line = stdout.slice(0, newline).trim();
      // Matched by shape rather than by the sentence beside it: the invitation
      // is the whole of what this command writes to stdout.
      if (/^[A-Za-z0-9_-]{200,}$/.test(line)) settle(() => resolve(line));
      else fail("the CLI party's first stdout line is not an invitation");
    };
    child.stdout.on("data", onData);
    // A failure raised on the child rather than by its exit -- a spawn that
    // never happened, a signal that could not be delivered. Unlistened, Node
    // throws it as an uncaught exception that takes the vitest worker with it.
    // Registered for the whole run: its text stays in the output the outcome
    // reports, and settling once makes a later one a no-op for the wait below.
    child.on("error", (error: Error) => {
      output += `${error.message}\n`;
      fail("the CLI party could not be spawned");
    });
    void ended.then(({ exitCode }) =>
      fail(`the CLI party exited with code ${exitCode} before inviting`),
    );
  }).catch(async (error: unknown) => {
    await stop();
    throw error;
  });

  return {
    invitation,
    outcome: async () => {
      const { exitCode, endedAt } = await ended;
      const closingAt = loggedAt(output, CLOSING_CONNECTION_LINE);
      const ranToCompletion = !killedOnDeadline && exitCode === 0;
      return {
        exitCode,
        killedOnDeadline,
        pairs: ranToCompletion ? readPairs(outputPath, output) : null,
        closeWaitMs: closingAt === null ? null : endedAt - closingAt,
        output,
      };
    },
    stop,
  };
}
