import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import yargs from "yargs";

import { prepareForExchange } from "@psilink/core";
import type { ExchangeSpec } from "@psilink/core";

import {
  builder as exchangeBuilder,
  handler as exchangeHandler,
} from "../../../src/commands/exchange";
import { saveConfig } from "../../../src/config";
import { saveKeyFile } from "../../../src/keyFile";
import { captureFd3 } from "../../eventStreamTestSupport";

/**
 * A signal that arrives in the window the teardown opens: after the run's
 * terminal event and before its transport has finished closing. The outcome is
 * already on the machine-interface stream by then, so the stream keeps it and
 * gains nothing after it, while the exit status becomes the signal's -- the
 * status a supervisor reads for a process that did not end on its own.
 *
 * The signal is delivered from inside the teardown, which is what puts it in
 * that window: a signal any earlier would end the run before the terminal
 * event and leave the stream without one. One party runs, so one set of signal
 * handlers is installed and the delivery reaches the run under test alone.
 *
 * `process.exit` is recorded rather than performed, the harder case: the
 * handler returns instead of terminating, so the run carries on past the point
 * a real process would be gone and any event it emitted afterwards would be
 * caught here.
 */

const INITIAL_SECRET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const CSV_HEADER = "ssn,last_name,first_name,date_of_birth";
const PARTY_A_CSV = `${CSV_HEADER}\n` + "123456789,SMITH,JOHN,19900115\n";
const CSV_FIELDS = ["ssn", "last_name", "first_name", "date_of_birth"];
const PROVISION_ROWS = [
  {
    ssn: "123456789",
    last_name: "SMITH",
    first_name: "JOHN",
    date_of_birth: "19900115",
  },
];

/** Long enough to reach the rendezvous, short enough to give up inside a case. */
const PEER_TIMEOUT = "2s";
const CASE_TIMEOUT_MS = 90_000;

// Delivered once, from inside the close the run's cleanup drives, so the run
// has emitted its terminal event and has not finished tearing down.
const signalled = vi.hoisted(() => ({ done: false }));

vi.mock("../../../src/transportTeardown", async (importActual) => {
  const actual =
    await importActual<typeof import("../../../src/transportTeardown")>();
  return {
    ...actual,
    closeWithinCeiling: async (
      ceilingMs: number,
      close: () => Promise<void>,
    ) => {
      if (!signalled.done) {
        signalled.done = true;
        process.emit("SIGINT");
      }
      return actual.closeWithinCeiling(ceilingMs, close);
    },
  };
});

let work: string;
let exitSpy: ReturnType<typeof vi.spyOn>;
let priorExitCode: typeof process.exitCode;

beforeEach(() => {
  signalled.done = false;
  work = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-teardown-signal-"));
  priorExitCode = process.exitCode;
  exitSpy = vi.spyOn(process, "exit").mockReturnValue(undefined as never);
  // The run states its disclosure terms on stderr whatever the log level; this
  // case reads fd 3 and the exit status, so keep that block out of the report.
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

afterEach(() => {
  process.exitCode = priorExitCode;
  vi.restoreAllMocks();
  fs.rmSync(work, { recursive: true, force: true });
});

async function runCli(argv: string[]): Promise<void> {
  await yargs(argv)
    .scriptName("psilink")
    .command("exchange <input> [output]", "", exchangeBuilder, exchangeHandler)
    .exitProcess(false)
    // Raise a failing run to the caller instead of letting yargs print its
    // usage block to the console, which this suite's sentinel reads as a line
    // that reached the console without a display sink.
    .fail((message, err: unknown) => {
      throw err ?? new Error(message);
    })
    .parseAsync();
}

test(
  "a signal during teardown keeps the terminal event and takes the exit status",
  async () => {
    fs.writeFileSync(path.join(work, "a-input.csv"), PARTY_A_CSV);
    const prepared = prepareForExchange(
      {},
      "config",
      PROVISION_ROWS,
      CSV_FIELDS,
    );
    const spec: ExchangeSpec = {
      connection: {
        channel: "filedrop",
        path: path.join(work, "drop"),
        options: { pollIntervalMs: 1 },
      },
      linkageTerms: prepared.linkageTerms,
      metadata: prepared.metadata,
    };
    fs.mkdirSync(path.join(work, "drop"));
    saveConfig(path.join(work, "psilink.yaml"), spec);
    saveKeyFile(path.join(work, "a.key"), { sharedSecret: INITIAL_SECRET });

    const { lines } = await captureFd3(async () => {
      // No partner arrives, so the run fails at the rendezvous and emits its
      // terminal error before the cleanup the signal lands in.
      await runCli([
        "exchange",
        path.join(work, "a-input.csv"),
        path.join(work, "a-out.csv"),
        "--config-file",
        path.join(work, "psilink.yaml"),
        "--key-file",
        path.join(work, "a.key"),
        "--identity",
        "party-a",
        "--no-record",
        "--peer-timeout",
        PEER_TIMEOUT,
        "--log-level",
        "silent",
        "--event-stream",
      ]).catch(() => undefined);
      await vi.waitFor(() => expect(exitSpy).toHaveBeenCalled(), {
        timeout: 5_000,
      });
    });

    expect(signalled.done).toBe(true);
    // The signal owns the exit, ahead of the status the failing run would have
    // taken on its own.
    expect(exitSpy.mock.calls[0]).toEqual([130]);

    const types = lines.map((line) => line["type"]);
    expect(types.filter((t) => t === "result" || t === "error")).toEqual([
      "error",
    ]);
    expect(types[types.length - 1]).toBe("error");
  },
  CASE_TIMEOUT_MS,
);
