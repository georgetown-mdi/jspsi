import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import yargs from "yargs";

import { prepareForExchange } from "@psilink/core";
import type { ExchangeSpec } from "@psilink/core";

import {
  builder as exchangeBuilder,
  handler as exchangeHandler,
} from "../../../src/commands/exchange";
import {
  builder as zeroSetupBuilder,
  handler as zeroSetupHandler,
} from "../../../src/commands/zeroSetup";
import { saveConfig } from "../../../src/config";
import { PERSISTENCE_LOSS_EXIT_CODE } from "../../../src/eventStream";
import { saveKeyFile } from "../../../src/keyFile";
import {
  denyDirectoryWrites,
  restoreDirectoryWrites,
} from "../../directoryWriteAccess";
import { captureFd3 } from "../../eventStreamTestSupport";

/**
 * Where a run reports a transport that did not finish closing inside the
 * ceiling, and where it does not. The teardown runs after the terminal event,
 * so the notice goes to the operator log at error level -- the level an
 * unattended `--log-level error` run keeps -- and nothing reaches fd 3 after
 * the outcome, which a consumer may stop reading at. The exchange's own exit
 * status is untouched either way.
 *
 * Both file dispositions are driven, because the sentence that separates them
 * is the one thing in the notice a run derives rather than states: a delete-
 * mode run is asked to clear the protocol files its abandoned close left, and
 * a retain-mode run, whose close deletes nothing, is not. A flag read the
 * wrong way round tells one of them the opposite of what it needs. The lone
 * party below reads the other sink an operator may have, `--log-file`, which
 * replaces stderr rather than standing beside it.
 *
 * The clause about what is on disk is driven at both settings, since a run
 * that lost an artifact non-fatally reaches the notice as any other completed
 * run does, and in both shapes that loss takes: an artifact the output stage
 * writes itself, and the caller's own post-exchange save, which catches its
 * failure and reports it back rather than raising it.
 *
 * The expiry is injected rather than provoked. `closeWithinCeiling` is
 * replaced with one that still drives the real close -- so the poller stops
 * and the directory is swept as any other run leaves them -- and then reports
 * the outcome an expiry produces. What that function does with a real ceiling
 * and a close that never returns is `test/unit/transportTeardown.test.ts`;
 * what a run does with the outcome is here, and provoking a genuine overrun
 * would mean holding a file-sync close open for minutes.
 */

/** The elapsed wait and held resource the injected expiry reports. */
const EXPIRED_ELAPSED_MS = 180_000;
const EXPIRED_HELD_KIND = "TCPSocketWrap";

vi.mock("../../../src/transportTeardown", async (importActual) => {
  const actual =
    await importActual<typeof import("../../../src/transportTeardown")>();
  return {
    ...actual,
    closeWithinCeiling: async (
      _ceilingMs: number,
      close: () => Promise<void>,
    ) => {
      await close();
      return {
        finished: false,
        elapsedMs: EXPIRED_ELAPSED_MS,
        heldBy: [EXPIRED_HELD_KIND],
      };
    },
  };
});

const INITIAL_SECRET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const CSV_HEADER = "ssn,last_name,first_name,date_of_birth";
const PARTY_A_CSV =
  `${CSV_HEADER}\n` +
  "123456789,SMITH,JOHN,19900115\n" +
  "234567890,JONES,MARY,19850623\n";
const PARTY_B_CSV =
  `${CSV_HEADER}\n` +
  "123456789,SMITH,JOHN,19900115\n" +
  "456789012,WHITE,JAMES,19880520\n";
const CSV_FIELDS = ["ssn", "last_name", "first_name", "date_of_birth"];
const PROVISION_ROWS = [
  {
    ssn: "123456789",
    last_name: "SMITH",
    first_name: "JOHN",
    date_of_birth: "19900115",
  },
];

const PEER_TIMEOUT = "30s";
const CASE_TIMEOUT_MS = 90_000;

let work: string;
let exitSpy: ReturnType<typeof vi.spyOn> | undefined;
let priorExitCode: typeof process.exitCode;

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-teardown-events-"));
  priorExitCode = process.exitCode;
  // A handler exits the process on failure; trap it so a failure rejects the
  // awaited parse instead of killing the worker, as the sibling command tests
  // in this project do.
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code ?? 0})`);
  }) as never);
});

afterEach(() => {
  exitSpy?.mockRestore();
  exitSpy = undefined;
  process.exitCode = priorExitCode;
  vi.restoreAllMocks();
  fs.rmSync(work, { recursive: true, force: true });
});

/** The two inputs, the shared configuration, and a key file for each party. */
function writeExchangeFixture(): void {
  fs.writeFileSync(path.join(work, "a-input.csv"), PARTY_A_CSV);
  fs.writeFileSync(path.join(work, "b-input.csv"), PARTY_B_CSV);
  const prepared = prepareForExchange({}, "config", PROVISION_ROWS, CSV_FIELDS);
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
  saveKeyFile(path.join(work, "b.key"), { sharedSecret: INITIAL_SECRET });
}

function partyArgs(
  party: "a" | "b",
  extra: string[],
  peerTimeout = PEER_TIMEOUT,
  recordFlags: string[] = ["--no-record"],
): string[] {
  return [
    "exchange",
    path.join(work, `${party}-input.csv`),
    path.join(work, `${party}-out.csv`),
    "--config-file",
    path.join(work, "psilink.yaml"),
    "--key-file",
    path.join(work, `${party}.key`),
    "--identity",
    `party-${party}`,
    ...recordFlags,
    "--peer-timeout",
    peerTimeout,
    ...extra,
  ];
}

/** The zero-setup pair's rendezvous, from the drop directory the fixture makes. */
function dropUrl(): string {
  return pathToFileURL(path.join(work, "drop")).href;
}

/** A zero-setup party's whole command line: meet at the drop URL and save the
 *  recurring setup the exchange establishes. The poll interval goes on the
 *  command line, zero-setup having no config to set one in. */
function savingPartyArgs(
  party: "a" | "b",
  configFile: string,
  extra: string[],
): string[] {
  return [
    dropUrl(),
    path.join(work, `${party}-input.csv`),
    path.join(work, `${party}-out.csv`),
    "--save",
    "--config-file",
    configFile,
    "--key-file",
    path.join(work, `${party}-saved.key`),
    "--identity",
    `party-${party}`,
    "--no-record",
    "--polling-frequency",
    "10ms",
    "--peer-timeout",
    PEER_TIMEOUT,
    "--log-level",
    "error",
    ...extra,
  ];
}

/** Everything written to stderr while `body` runs, and what it resolved with. */
async function captureStderr<T>(
  body: () => Promise<T>,
): Promise<{ value: T; text: string }> {
  let text = "";
  const spy = vi.spyOn(process.stderr, "write").mockImplementation(((
    chunk: string | Uint8Array,
  ) => {
    text += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stderr.write);
  try {
    return { value: await body(), text };
  } finally {
    spy.mockRestore();
  }
}

async function runCli(argv: string[]): Promise<void> {
  await yargs(argv)
    .scriptName("psilink")
    .command("$0", "zero-setup exchange", zeroSetupBuilder, zeroSetupHandler)
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

test.each([
  { mode: "delete", flags: [] as string[], sweptByTheClose: true },
  { mode: "retain", flags: ["--retain-files"], sweptByTheClose: false },
])(
  "an expired teardown is stated on stderr after the terminal event, $mode mode",
  async ({ flags, sweptByTheClose }) => {
    writeExchangeFixture();

    // Both parties run at the level an unattended run is left at, so the notice
    // has to clear `error` to be seen at all. Both take it because the level is
    // process-wide and these two runs share a process: one party set to `silent`
    // would silence the other.
    const logArgs = ["--log-level", "error"];

    // Only the asserted party opens the stream, so fd 3 holds one run's events.
    const { value: stderrText, lines } = await captureFd3(async () => {
      // Both parties take the retain flag too: retain mode is a property of the
      // exchange, and a mismatch is refused at the rendezvous rather than run.
      const { text } = await captureStderr(async () => {
        const results = await Promise.allSettled([
          runCli(partyArgs("a", ["--event-stream", ...logArgs, ...flags])),
          runCli(partyArgs("b", [...logArgs, ...flags])),
        ]);
        const failures = results.filter((r) => r.status === "rejected");
        if (failures.length > 0)
          throw new AggregateError(
            failures.map((r) => (r as PromiseRejectedResult).reason),
            "a party failed",
          );
      });
      return text;
    });

    const types = lines.map((line) => line["type"]);
    expect(types.filter((t) => t === "result" || t === "error")).toEqual([
      "result",
    ]);
    // The outcome is the last thing on the stream: the teardown that follows it
    // reports where a consumer is not obliged to still be reading.
    expect(types[types.length - 1]).toBe("result");
    expect(types[types.length - 2]).toBe("metrics");
    expect(types).not.toContain("warning");

    // One notice per party, each the whole of its own line: the two runs share
    // this process and both overran, and every assertion below reads the first.
    const notices = stderrText
      .split("\n")
      .filter((line) => line.includes("the transport did not finish closing"));
    expect(notices).toHaveLength(2);
    const notice = notices[0];
    expect(notice).toContain("[ERROR]");
    expect(notice).toContain(EXPIRED_HELD_KIND);
    expect(notice).toContain(`within ${EXPIRED_ELAPSED_MS / 1000}s`);
    // The output stage returned, so the close it gave up on took nothing with
    // it.
    expect(notice).toContain("everything it writes is already on disk");
    // The sweep sentence, which the run derives from its own file disposition.
    if (sweptByTheClose) {
      expect(notice).toContain("Check the exchange directory");
      expect(notice).toContain("--sweep-exchange-files");
    } else {
      expect(notice).not.toContain("exchange directory");
      expect(notice).not.toContain("--sweep-exchange-files");
    }

    // The exchange succeeded, so its status stands: the teardown is
    // housekeeping and never pushes a supervisor toward a retry.
    expect(process.exitCode).toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
  },
  CASE_TIMEOUT_MS,
);

/** Long enough to reach the rendezvous, short enough to give up inside a case. */
const LONE_PARTY_PEER_TIMEOUT = "2s";

test(
  "a run that wrote no files claims none, and reaches a --log-file at error level",
  async () => {
    // The party waits alone and fails at the rendezvous, so its output stage
    // never ran: a notice claiming everything it writes is on disk would send
    // the operator looking for a result file no run produced. One party, so the
    // log file is the only sink installed -- both the level and the sink are
    // process-wide, and a second in-process run would replace them.
    writeExchangeFixture();
    const logFile = path.join(work, "lone.log");

    const { lines } = await captureFd3(async () => {
      await captureStderr(async () => {
        await expect(
          runCli(
            partyArgs(
              "a",
              ["--event-stream", "--log-level", "error", "--log-file", logFile],
              LONE_PARTY_PEER_TIMEOUT,
            ),
          ),
        ).rejects.toThrow();
      });
    });

    const types = lines.map((line) => line["type"]);
    expect(types[types.length - 1]).toBe("error");
    expect(types).not.toContain("warning");

    const notices = fs
      .readFileSync(logFile, "utf8")
      .split("\n")
      .filter((line) => line.includes("the transport did not finish closing"));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("[ERROR]");
    expect(notices[0]).toContain("exit status are unchanged");
    expect(notices[0]).not.toContain("on disk");
  },
  CASE_TIMEOUT_MS,
);

test(
  "a run that lost an artifact claims nothing about what is on disk",
  async () => {
    // The record path's parent is a regular file, so the record cannot be
    // written and the run loses it non-fatally: the exchange and the result
    // stand, the loss is reported, and the notice must not then tell the
    // operator every file the run writes is there. The partner keeps no
    // record, so its own notice still states the clause; that is what tells
    // the two apart, since both parties run in this process.
    writeExchangeFixture();
    const recordInsideAFile = path.join(work, "a-input.csv", "record.json");
    const logArgs = ["--log-level", "error"];

    const { value: stderrText, lines } = await captureFd3(async () => {
      const { text } = await captureStderr(async () => {
        const results = await Promise.allSettled([
          runCli(
            partyArgs("a", ["--event-stream", ...logArgs], PEER_TIMEOUT, [
              "--record-file",
              recordInsideAFile,
            ]),
          ),
          runCli(partyArgs("b", logArgs)),
        ]);
        const failures = results.filter((r) => r.status === "rejected");
        if (failures.length > 0)
          throw new AggregateError(
            failures.map((r) => (r as PromiseRejectedResult).reason),
            "a party failed",
          );
      });
      return text;
    });

    const types = lines.map((line) => line["type"]);
    expect(types[types.length - 1]).toBe("result");
    expect(
      lines
        .filter((line) => line["type"] === "warning")
        .map((line) => line["source"]),
    ).toEqual(["persistenceLoss"]);
    expect(process.exitCode).toBe(PERSISTENCE_LOSS_EXIT_CODE);
    expect(exitSpy).not.toHaveBeenCalled();

    const notices = stderrText
      .split("\n")
      .filter((line) => line.includes("the transport did not finish closing"));
    expect(notices).toHaveLength(2);
    expect(
      notices.filter((line) =>
        line.includes("everything it writes is already on disk"),
      ),
    ).toHaveLength(1);
  },
  CASE_TIMEOUT_MS,
);

test(
  "a save the hook itself could not write claims nothing about what is on disk",
  async () => {
    // The other shape of a non-fatal loss, and the one the flag exists for: the
    // --save provisioning runs from the pre-terminal hook and catches its own
    // failure, so the run hears of it from what the hook reports back rather
    // than from a throw. Party A saves into a directory it cannot write:
    // nothing is at the path, so the pre-flight conflict check passes, and the
    // write itself is what fails, while the exchange and its result stand.
    // Party B saves for real and its notice still states the clause, which is
    // what tells the two apart in a process running both.
    writeExchangeFixture();
    const unwritable = path.join(work, "unwritable");
    fs.mkdirSync(unwritable);
    denyDirectoryWrites(unwritable);

    let stderrText: string;
    let lines: Array<Record<string, unknown>>;
    try {
      ({ value: stderrText, lines } = await captureFd3(async () => {
        const { text } = await captureStderr(async () => {
          const results = await Promise.allSettled([
            runCli(
              savingPartyArgs("a", path.join(unwritable, "psilink.yaml"), [
                "--event-stream",
              ]),
            ),
            runCli(savingPartyArgs("b", path.join(work, "b-saved.yaml"), [])),
          ]);
          const failures = results.filter((r) => r.status === "rejected");
          if (failures.length > 0)
            throw new AggregateError(
              failures.map((r) => (r as PromiseRejectedResult).reason),
              "a party failed",
            );
        });
        return text;
      }));
    } finally {
      restoreDirectoryWrites(unwritable);
    }

    const types = lines.map((line) => line["type"]);
    expect(types[types.length - 1]).toBe("result");
    expect(
      lines
        .filter((line) => line["type"] === "warning")
        .map((line) => line["source"]),
    ).toEqual(["persistenceLoss"]);
    expect(process.exitCode).toBe(PERSISTENCE_LOSS_EXIT_CODE);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(work, "b-saved.yaml"))).toBe(true);

    const notices = stderrText
      .split("\n")
      .filter((line) => line.includes("the transport did not finish closing"));
    expect(notices).toHaveLength(2);
    expect(
      notices.filter((line) =>
        line.includes("everything it writes is already on disk"),
      ),
    ).toHaveLength(1);
  },
  CASE_TIMEOUT_MS,
);
