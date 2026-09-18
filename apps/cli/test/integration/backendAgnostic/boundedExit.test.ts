import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, expect, test, vi } from "vitest";

import {
  computeCertificateFingerprint,
  generateSigningIdentity,
  prepareForExchange,
} from "@psilink/core";
import type { ExchangeSpec, SigningIdentity } from "@psilink/core";

import { saveConfig } from "../../../src/config";
import { saveKeyFile } from "../../../src/keyFile";
import { keysPathFor } from "../../../src/recordFile";
import { saveSigningIdentity } from "../../../src/signingIdentityFile";

/**
 * How a run's process ends and what is on disk when it does: it returns within
 * the gate's budget whatever is still holding the event loop, it ends on the
 * signal's own status when one arrives, and everything it owed is complete
 * either way -- down to the run whose result a reader refused, which still
 * leaves the record of the disclosure it made.
 *
 * Every party here is a real child process, because it is the process exiting
 * that is under test and the runner's own process cannot exit. One party runs
 * through `test/exitGateProbe.ts`, which wires the entry point as
 * `src/index.ts` does and adds the injected budget and the synthetic held
 * handle; the other is the plain CLI, its peer and nothing more.
 *
 * The leak is synthetic on purpose -- a plain `setTimeout` nothing releases --
 * so no case here depends on a dependency continuing to hold a handle.
 */

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.join(here, "../../../src/index.ts");
const probeEntry = path.join(here, "../../exitGateProbe.ts");

/** 32 zero bytes as base64url: a valid shared secret both parties start from. */
const INITIAL_SECRET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const CSV_HEADER = "ssn,last_name,first_name,date_of_birth";
const PARTY_A_CSV =
  `${CSV_HEADER}\n` +
  "123456789,SMITH,JOHN,19900115\n" +
  "234567890,JONES,MARY,19850623\n" +
  "345678901,BROWN,ROBERT,19920815\n";
const PARTY_B_CSV =
  `${CSV_HEADER}\n` +
  "123456789,SMITH,JOHN,19900115\n" +
  "234567890,JONES,MARY,19850623\n" +
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
/** The two records both inputs hold, which every result file below states. */
const MATCHED_ROWS = 2;

/**
 * The gate budget each probe run is given, well under the shipped one so a
 * case measures the return rather than waiting it out, and well above the
 * millisecond a clean loop takes to drain so it is the leak that reaches it.
 */
const PROBE_GATE_BUDGET_MS = 1_000;

/** The synthetic leak: an hour, so nothing but the gate ends the process. */
const LEAK_MS = 60 * 60 * 1000;

/**
 * How long a case allows between the probe reporting settlement and the
 * process exiting. Above the budget by enough that a loaded machine's
 * scheduling does not decide the assertion, and far below the leak.
 */
const RETURN_ALLOWANCE_MS = 15_000;

/** Each party's own transport wait, bounded well inside the case deadline. */
const PEER_TIMEOUT = "45s";

/** A killed-on-deadline party reports as killed rather than as a stall. */
const PARTY_DEADLINE_MS = 120_000;

const CASE_TIMEOUT_MS = 180_000;

interface FinishedParty {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

let work: string;
let dropDir: string;
let identityA: SigningIdentity;
let identityB: SigningIdentity;

beforeEach(async () => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bounded-exit-"));
  dropDir = path.join(work, "drop");
  fs.mkdirSync(dropDir);
  fs.writeFileSync(path.join(work, "a-input.csv"), PARTY_A_CSV);
  fs.writeFileSync(path.join(work, "b-input.csv"), PARTY_B_CSV);

  identityA = await generateSigningIdentity("party-a");
  identityB = await generateSigningIdentity("party-b");
  saveSigningIdentity(path.join(work, "a-identity.json"), identityA);
  saveSigningIdentity(path.join(work, "b-identity.json"), identityB);

  const prepared = prepareForExchange({}, "config", PROVISION_ROWS, CSV_FIELDS);
  // A config per party: they share the rendezvous and the terms and differ
  // only in the signing block, each pinning the other's fingerprint so no run
  // here adopts one and writes it back into the file it is reading.
  for (const [self, partnerIdentity] of [
    ["a", identityB],
    ["b", identityA],
  ] as const) {
    const spec: ExchangeSpec = {
      connection: {
        channel: "filedrop",
        path: dropDir,
        options: { pollIntervalMs: 1 },
      },
      linkageTerms: prepared.linkageTerms,
      metadata: prepared.metadata,
      signing: {
        mode: "certificate",
        identityFile: path.join(work, `${self}-identity.json`),
        partnerFingerprint: await computeCertificateFingerprint(
          partnerIdentity.certificate,
        ),
        receiptOutput: path.join(work, `${self}-receipt.json`),
      },
    };
    saveConfig(path.join(work, `${self}.yaml`), spec);
    saveKeyFile(path.join(work, `${self}.key`), {
      sharedSecret: INITIAL_SECRET,
    });
  }
});

afterEach(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

/** The command line a party runs, with its output argument left to the caller. */
function partyArgs(party: "a" | "b", output: string[]): string[] {
  return [
    "exchange",
    path.join(work, `${party}-input.csv`),
    ...output,
    "--config-file",
    path.join(work, `${party}.yaml`),
    "--key-file",
    path.join(work, `${party}.key`),
    "--identity",
    `party-${party}`,
    "--record-file",
    path.join(work, `${party}-record.json`),
    "--peer-timeout",
    PEER_TIMEOUT,
    "--log-level",
    "silent",
  ];
}

/**
 * Start one party through `tsx`, as the test suite runs the CLI, reporting the
 * child beside what it finishes with, so a case can signal it mid-run.
 *
 * `firstReadDelayMs` makes the parent a slow reader of the party's stdout: it
 * stops reading for that long once the first chunk arrives, then takes the
 * rest at speed. A result larger than the pipe's own buffer therefore cannot
 * finish leaving the party before that wait is over. Left at 0 the parent
 * reads as fast as the party writes.
 */
function startParty(
  entry: string,
  args: string[],
  { firstReadDelayMs = 0 }: { firstReadDelayMs?: number } = {},
): { child: ChildProcess; finished: Promise<FinishedParty> } {
  const child = spawn(
    process.execPath,
    [require.resolve("tsx/cli"), entry, ...args],
    { cwd: work, stdio: ["ignore", "pipe", "pipe"] },
  );
  return { child, finished: collectParty(child, firstReadDelayMs) };
}

/** Everything `child` writes, and the status it ends on; see {@link startParty}. */
function collectParty(
  child: ChildProcess,
  firstReadDelayMs: number,
): Promise<FinishedParty> {
  let stdout = "";
  let stderr = "";
  let delayed = firstReadDelayMs === 0;
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    if (delayed) return;
    delayed = true;
    child.stdout?.pause();
    setTimeout(() => child.stdout?.resume(), firstReadDelayMs).unref();
  });
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const deadline = setTimeout(() => child.kill("SIGKILL"), PARTY_DEADLINE_MS);
  return new Promise<FinishedParty>((resolve) => {
    // `close` rather than `exit`: the party can exit with its last chunk still
    // in a pipe this side has not read, and what it wrote -- the result on
    // stdout, the probe's own markers on stderr -- is what each case reads.
    child.once("close", (exitCode, signal) => {
      clearTimeout(deadline);
      resolve({ exitCode, signal, stdout, stderr });
    });
  });
}

/** Run one party to completion; see {@link startParty}. */
function runParty(
  entry: string,
  args: string[],
  options: { firstReadDelayMs?: number } = {},
): Promise<FinishedParty> {
  return startParty(entry, args, options).finished;
}

/** Run the probe party and its plain peer together, and report both. */
async function runBoth(params: {
  probeArgs: string[];
  probeOutput: string[];
  firstReadDelayMs?: number;
}): Promise<{ probe: FinishedParty; peer: FinishedParty }> {
  const [probe, peer] = await Promise.all([
    runParty(
      probeEntry,
      [...params.probeArgs, "--", ...partyArgs("a", params.probeOutput)],
      { firstReadDelayMs: params.firstReadDelayMs },
    ),
    runParty(cliEntry, partyArgs("b", [path.join(work, "b-out.csv")])),
  ]);
  return { probe, peer };
}

/** The probe's own markers, read off the stderr it shares with the run. */
function probeReturnMs(run: FinishedParty): number {
  const marker = /PROBE-EXIT (-?\d+)/.exec(run.stderr);
  if (marker === null)
    throw new Error(
      `the probe reported no exit marker; it wrote ${JSON.stringify(run.stderr)}`,
    );
  return Number(marker[1]);
}

/**
 * Assert every artifact the asserted party owed is on disk and whole: the
 * result CSV with both matched rows, the exchange record with its private
 * verification keys, and the dual-signed receipt. This is what the forced exit
 * must never cut short, since the gate runs after all of them.
 */
function expectArtifactsComplete(resultPath: string): void {
  const result = fs.readFileSync(resultPath, "utf8");
  const rows = result.trimEnd().split("\n");
  expect(rows).toHaveLength(MATCHED_ROWS + 1);
  expect(rows[0]).toContain("row_id");

  const recordPath = path.join(work, "a-record.json");
  const record = JSON.parse(fs.readFileSync(recordPath, "utf8")) as {
    localIdentity?: unknown;
    partnerIdentity?: unknown;
  };
  expect(record.localIdentity).toBe("party-a");
  expect(record.partnerIdentity).toBe("party-b");
  const keys = JSON.parse(
    fs.readFileSync(keysPathFor(recordPath), "utf8"),
  ) as Record<string, unknown>;
  expect(Object.keys(keys).length).toBeGreaterThan(0);

  const receipt = JSON.parse(
    fs.readFileSync(path.join(work, "a-receipt.json"), "utf8"),
  ) as Record<string, unknown>;
  expect(Object.keys(receipt).length).toBeGreaterThan(0);
}

test(
  "a held event loop returns at the budget with the run's own status, and its files are whole",
  async () => {
    const resultPath = path.join(work, "a-out.csv");
    const { probe, peer } = await runBoth({
      probeArgs: [
        "--probe-gate-budget-ms",
        String(PROBE_GATE_BUDGET_MS),
        "--probe-leak-ms",
        String(LEAK_MS),
        "--probe-obligation-ms",
        "0",
        "--probe-cleanup-delay-ms",
        "0",
      ],
      probeOutput: [resultPath],
    });

    expect(peer.exitCode).toBe(0);
    // The exchange succeeded, so the exit status is the exchange's: a handle
    // nobody released is not an outcome and must not become one.
    expect(probe.exitCode).toBe(0);
    expect(probe.signal).toBeNull();
    expect(probeReturnMs(probe)).toBeLessThan(RETURN_ALLOWANCE_MS);
    // The line names the kind of handle that held it, which is the whole
    // point of reporting rather than silently exiting.
    expect(probe.stderr).toContain("still held open");
    expect(probe.stderr).toContain("Timeout");
    expectArtifactsComplete(resultPath);
  },
  CASE_TIMEOUT_MS,
);

test(
  "the budget's clock starts after the run's obligations, not during them",
  async () => {
    const resultPath = path.join(work, "a-out.csv");
    const obligationMs = PROBE_GATE_BUDGET_MS * 4;
    const startedAt = Date.now();
    const { probe } = await runBoth({
      probeArgs: [
        "--probe-gate-budget-ms",
        String(PROBE_GATE_BUDGET_MS),
        "--probe-leak-ms",
        String(LEAK_MS),
        "--probe-obligation-ms",
        String(obligationMs),
        "--probe-cleanup-delay-ms",
        "0",
      ],
      probeOutput: [resultPath],
    });

    expect(probe.exitCode).toBe(0);
    // An obligation four times the budget is waited out in full: the exit
    // follows it rather than cutting it off at the budget.
    expect(Date.now() - startedAt).toBeGreaterThan(obligationMs);
    expect(probeReturnMs(probe)).toBeLessThan(RETURN_ALLOWANCE_MS);
    expectArtifactsComplete(resultPath);
  },
  CASE_TIMEOUT_MS,
);

test(
  "a result streamed to a pipe is not truncated by the forced exit",
  async () => {
    const { probe } = await runBoth({
      probeArgs: [
        "--probe-gate-budget-ms",
        String(PROBE_GATE_BUDGET_MS),
        "--probe-leak-ms",
        String(LEAK_MS),
        "--probe-obligation-ms",
        "0",
        "--probe-cleanup-delay-ms",
        "0",
      ],
      // No OUTPUT_FILE: the result goes to stdout, which is a pipe here.
      probeOutput: [],
    });

    expect(probe.exitCode).toBe(0);
    expect(probe.stderr).toContain("still held open");
    const rows = probe.stdout.trimEnd().split("\n");
    expect(rows).toHaveLength(MATCHED_ROWS + 1);
    expect(rows[0]).toContain("row_id");
  },
  CASE_TIMEOUT_MS,
);

/**
 * Both parties' inputs, rewritten as `count` records they share, so the result
 * is that many matched rows. The records differ from one another in every
 * field, which keeps the match one-to-one and the result's size a function of
 * the count alone.
 */
function writeMatchedInputs(count: number): void {
  const letters = (index: number): string => {
    let suffix = "";
    let left = index;
    do {
      suffix = String.fromCharCode(65 + (left % 26)) + suffix;
      left = Math.floor(left / 26);
    } while (left > 0);
    return suffix;
  };
  const rows: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const month = String((i % 12) + 1).padStart(2, "0");
    const day = String((i % 28) + 1).padStart(2, "0");
    rows.push(
      `${100000000 + i},SMITH${letters(i)},JOHN${letters(i)},1990${month}${day}`,
    );
  }
  const csv = `${CSV_HEADER}\n${rows.join("\n")}\n`;
  fs.writeFileSync(path.join(work, "a-input.csv"), csv);
  fs.writeFileSync(path.join(work, "b-input.csv"), csv);
}

/** Records enough for a result past any pipe buffer the platform gives it. */
const LARGE_RESULT_RECORDS = 8_000;

/**
 * How long the reading side stops once the result starts arriving. Above the
 * gate budget, so a gate armed while the result was still draining would
 * return the process before the last line had left it.
 */
const FIRST_READ_DELAY_MS = 2_000;

test(
  "a result still draining to a slow reader is delivered whole",
  async () => {
    // The result is larger than the pipe holds and the reader stops taking it
    // for longer than the gate's budget, so the drain is still running well
    // past that budget. The gate is armed after the command settles, which is
    // after the drain, and this is what says so: a gate armed beside it would
    // return the process at the budget and cut the result off.
    writeMatchedInputs(LARGE_RESULT_RECORDS);
    const { probe } = await runBoth({
      probeArgs: [
        "--probe-gate-budget-ms",
        String(PROBE_GATE_BUDGET_MS),
        "--probe-leak-ms",
        String(LEAK_MS),
        "--probe-obligation-ms",
        "0",
        "--probe-cleanup-delay-ms",
        "0",
      ],
      probeOutput: [],
      firstReadDelayMs: FIRST_READ_DELAY_MS,
    });

    expect(probe.exitCode).toBe(0);
    expect(probe.stderr).toContain("still held open");
    // Past the smallest pipe buffer a platform here gives: the last line
    // could not have been flushed before the reader took what came first.
    expect(probe.stdout.length).toBeGreaterThan(64 * 1024);
    const rows = probe.stdout.trimEnd().split("\n");
    expect(rows).toHaveLength(LARGE_RESULT_RECORDS + 1);
    expect(rows[0]).toContain("row_id");
  },
  CASE_TIMEOUT_MS,
);

test(
  "a clean run exits on its own, with nothing said about the process",
  async () => {
    // The gate's shipped budget and no leak: the real end-to-end shape. A
    // future dependency that leaves a handle armed reddens this case rather
    // than being absorbed into a run that merely takes longer.
    const resultPath = path.join(work, "a-out.csv");
    const [a, b] = await Promise.all([
      runParty(cliEntry, partyArgs("a", [resultPath])),
      runParty(cliEntry, partyArgs("b", [path.join(work, "b-out.csv")])),
    ]);

    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    expect(a.stderr).not.toContain("still held open");
    expect(b.stderr).not.toContain("still held open");
    expectArtifactsComplete(resultPath);
  },
  CASE_TIMEOUT_MS,
);

/**
 * The teardown an interrupted party is given, several times the gate's budget,
 * so the gap between the command promise settling and the signal handler's own
 * exit is fixed rather than whatever a real close happens to take.
 */
const SIGNAL_CLEANUP_DELAY_MS = 2_000;

/**
 * Start a lone party under the probe and interrupt it with `signal` once it is
 * waiting at the rendezvous -- past the prepare block, so the run's own signal
 * handlers are installed and the entry file it wrote is what says so.
 *
 * The party has no peer: what is under test is the interrupt, and a partner
 * would race it to completion.
 */
async function runInterruptedParty(
  signal: "SIGINT" | "SIGTERM",
): Promise<FinishedParty> {
  const { child, finished } = startParty(probeEntry, [
    "--probe-gate-budget-ms",
    String(PROBE_GATE_BUDGET_MS),
    "--probe-leak-ms",
    "0",
    "--probe-obligation-ms",
    "0",
    "--probe-cleanup-delay-ms",
    String(SIGNAL_CLEANUP_DELAY_MS),
    "--",
    ...partyArgs("a", [path.join(work, "a-out.csv")]),
  ]);
  await vi.waitFor(
    () => expect(fs.readdirSync(dropDir).length).toBeGreaterThan(0),
    { timeout: 30_000, interval: 25 },
  );
  child.kill(signal);
  return finished;
}

test.each([
  { signal: "SIGINT", status: 130 },
  { signal: "SIGTERM", status: 143 },
] as const)(
  "$signal ends the run on its own status, whatever the gate's budget",
  async ({ signal, status }) => {
    // The interrupt's teardown outlasts the budget, and the command promise
    // settles before that teardown is over -- PROBE-SETTLED says so, and the
    // gate is armed on exactly that settlement. An armed gate would end this
    // run at the status the run never reached and print a line saying it
    // finished and wrote its files.
    const party = await runInterruptedParty(signal);

    expect(party.stderr).toContain("PROBE-SETTLED");
    expect(party.exitCode).toBe(status);
    expect(party.signal).toBeNull();
    expect(party.stderr).not.toContain("still held open");
    // The run was cut short, so it produced none of what a completed one owes.
    expect(fs.existsSync(path.join(work, "a-out.csv"))).toBe(false);
  },
  CASE_TIMEOUT_MS,
);

/** One argument, quoted for the shell that runs the pipeline below. */
function shellArg(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Party A with its result piped to `head -1`: a reader that takes one line and
 * closes the pipe under a result far larger than the pipe holds.
 *
 * A real shell runs it, since that is how an operator writes it, and
 * `pipefail` makes the pipeline report psilink's own status rather than
 * `head`'s. The run's event stream goes to `eventsPath` on fd 3, which bash
 * passes through to the party it starts.
 */
function runPipedToHead(eventsPath: string): Promise<FinishedParty> {
  const party = [
    process.execPath,
    // `--import tsx` rather than tsx's own CLI, which re-launches node with an
    // IPC channel on fd 3: the run would find that descriptor open, pass the
    // event stream's fail-closed preflight, and have every write refused with
    // EINVAL. Loading tsx in-process leaves fd 3 the one this test wired.
    "--import",
    require.resolve("tsx"),
    cliEntry,
    // No OUTPUT_FILE: the result goes to stdout, which is the pipe.
    ...partyArgs("a", []),
    "--event-stream",
  ]
    .map(shellArg)
    .join(" ");
  const events = fs.openSync(eventsPath, "w");
  try {
    const child = spawn("bash", ["-c", `set -o pipefail; ${party} | head -1`], {
      cwd: work,
      stdio: ["ignore", "pipe", "pipe", events],
    });
    return collectParty(child, 0);
  } finally {
    fs.closeSync(events);
  }
}

test(
  "a reader that closes the pipe costs the result, not the record",
  async () => {
    // The result is far past the pipe's buffer, so the write fails under the
    // run rather than completing before `head` goes. What the run owes the
    // accounting -- the record of the disclosure it already made, and the
    // receipt for it -- is written all the same, and the run reports the
    // undelivered result as the loss it is.
    writeMatchedInputs(LARGE_RESULT_RECORDS);
    const eventsPath = path.join(work, "a-events.jsonl");
    const [a, b] = await Promise.all([
      runPipedToHead(eventsPath),
      runParty(cliEntry, partyArgs("b", [path.join(work, "b-out.csv")])),
    ]);

    expect(b.exitCode).toBe(0);
    expect(a.exitCode).toBe(73);
    expect(a.stdout.trimEnd().split("\n")).toHaveLength(1);

    const events = fs
      .readFileSync(eventsPath, "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const terminal = events[events.length - 1];
    expect(terminal["type"]).toBe("error");
    expect(terminal["category"]).toBe("output");
    expect(events.filter((line) => line["type"] === "result")).toEqual([]);

    const recordPath = path.join(work, "a-record.json");
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8")) as {
      localIdentity?: unknown;
    };
    expect(record.localIdentity).toBe("party-a");
    expect(fs.existsSync(keysPathFor(recordPath))).toBe(true);
    const receipt = JSON.parse(
      fs.readFileSync(path.join(work, "a-receipt.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(Object.keys(receipt).length).toBeGreaterThan(0);
  },
  CASE_TIMEOUT_MS,
);
