import fs from "node:fs";

import { runProbe } from "../src/doctor/probe";
import type { CommandResult } from "../src/doctor/runner";

/**
 * A doctor probe run that receives a real SIGINT while its put is in flight and
 * a real SIGTERM while the interrupt's sweep is deleting the probe file, with
 * that delete held open for a minute. The put lands only once the probe's own
 * SIGINT listener has run. Prints the credentials path and the time the second
 * signal was sent, then is expected to die of the SIGTERM. Run as a child
 * process because the process exiting is what is under test. Written with
 * `fs.writeSync` so the lines reach a pipe before the signal lands.
 */

const DELETE_HELD_MS = 60_000;
const PROBE_FILE = "alcove-probe-abc123.tmp";

const report = (line: string): void => {
  fs.writeSync(1, `${line}\n`);
};

const reply = (output = ""): Promise<CommandResult> =>
  Promise.resolve({ code: 0, output, timedOut: false });

let credentialsReported = false;

void runProbe(
  {
    server: "files.example.org",
    share: "exchange",
    subdirectory: "",
    username: "svc-alcove",
    domain: "",
    password: "correct horse battery",
    dialect: "",
    marker: "",
    token: "abc123",
  },
  {
    lookupHost: () => Promise.resolve("10.10.0.5"),
    connectTcp: () => Promise.resolve(true),
    runner: {
      run(_file, args): Promise<CommandResult> {
        const authIndex = args.indexOf("-A");
        if (authIndex !== -1 && !credentialsReported) {
          credentialsReported = true;
          report(`credentials ${args[authIndex + 1]}`);
        }
        if (args.includes("--version")) return reply("Version 4.19.5");
        if (args.includes("-L")) return reply("\tSharename  Type\n");
        const command = args[args.indexOf("-c") + 1] ?? "";
        if (command === `put ${PROBE_FILE} ${PROBE_FILE}`) {
          const landed = new Promise<CommandResult>((resolve) =>
            process.once("SIGINT", () =>
              resolve({ code: 0, output: "", timedOut: false }),
            ),
          );
          process.kill(process.pid, "SIGINT");
          return landed;
        }
        if (command === `del ${PROBE_FILE}`) {
          report(`second-signal ${Date.now()}`);
          process.kill(process.pid, "SIGTERM");
          return new Promise((resolve) =>
            setTimeout(
              () => resolve({ code: 0, output: "", timedOut: false }),
              DELETE_HELD_MS,
            ),
          );
        }
        return reply(
          "  .  D  0  Mon Jan  1 00:00:00 2024\n" +
            "\t\t10485760 blocks of size 1024. 5242880 blocks available\n",
        );
      },
    },
  },
).catch(() => undefined);
