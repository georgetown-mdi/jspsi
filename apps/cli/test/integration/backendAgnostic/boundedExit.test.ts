import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, expect, test } from "vitest";

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
 * What a finished run does with the process: it returns within the gate's
 * budget whatever is still holding the event loop, and everything it owed is
 * complete when it does.
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

/** Run one party to completion, through `tsx` as the test suite runs the CLI. */
function runParty(entry: string, args: string[]): Promise<FinishedParty> {
  const child = spawn(
    process.execPath,
    [require.resolve("tsx/cli"), entry, ...args],
    { cwd: work, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const deadline = setTimeout(() => child.kill("SIGKILL"), PARTY_DEADLINE_MS);
  return new Promise<FinishedParty>((resolve) => {
    child.once("exit", (exitCode, signal) => {
      clearTimeout(deadline);
      // Let the last chunk of either pipe land: `exit` can arrive before they
      // have drained, and the probe's own markers are on stderr.
      setImmediate(() => resolve({ exitCode, signal, stdout, stderr }));
    });
  });
}

/** Run the probe party and its plain peer together, and report both. */
async function runBoth(params: {
  probeArgs: string[];
  probeOutput: string[];
}): Promise<{ probe: FinishedParty; peer: FinishedParty }> {
  const [probe, peer] = await Promise.all([
    runParty(probeEntry, [
      ...params.probeArgs,
      "--",
      ...partyArgs("a", params.probeOutput),
    ]),
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
