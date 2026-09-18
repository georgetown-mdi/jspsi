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
 * What a run puts on fd 3 when its transport does not finish closing inside
 * the ceiling: the `transportTeardown` warning before the terminal event, the
 * terminal event still last, and the exchange's own exit status untouched.
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

function partyArgs(party: "a" | "b", extra: string[]): string[] {
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
    "--no-record",
    "--peer-timeout",
    PEER_TIMEOUT,
    "--log-level",
    "silent",
    ...extra,
  ];
}

async function runCli(argv: string[]): Promise<void> {
  await yargs(argv)
    .scriptName("psilink")
    .command("exchange <input> [output]", "", exchangeBuilder, exchangeHandler)
    .exitProcess(false)
    .parseAsync();
}

test(
  "an expired teardown warns before the terminal event and leaves the status alone",
  async () => {
    fs.writeFileSync(path.join(work, "a-input.csv"), PARTY_A_CSV);
    fs.writeFileSync(path.join(work, "b-input.csv"), PARTY_B_CSV);
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
    saveKeyFile(path.join(work, "b.key"), { sharedSecret: INITIAL_SECRET });

    // Only the asserted party opens the stream, so fd 3 holds one run's events.
    const { lines } = await captureFd3(async () => {
      const results = await Promise.allSettled([
        runCli(partyArgs("a", ["--event-stream"])),
        runCli(partyArgs("b", [])),
      ]);
      const failures = results.filter((r) => r.status === "rejected");
      if (failures.length > 0)
        throw new AggregateError(
          failures.map((r) => (r as PromiseRejectedResult).reason),
          "a party failed",
        );
    });

    const types = lines.map((line) => line["type"]);
    expect(types.filter((t) => t === "result" || t === "error")).toEqual([
      "result",
    ]);
    expect(types[types.length - 1]).toBe("result");
    expect(types[types.length - 2]).toBe("metrics");

    const warningIndex = lines.findIndex(
      (line) =>
        line["type"] === "warning" && line["source"] === "transportTeardown",
    );
    expect(warningIndex).toBeGreaterThanOrEqual(0);
    expect(warningIndex).toBeLessThan(types.length - 2);
    expect(String(lines[warningIndex]["message"])).toContain(EXPIRED_HELD_KIND);
    expect(String(lines[warningIndex]["message"])).toContain(
      `within ${EXPIRED_ELAPSED_MS / 1000}s`,
    );

    // The exchange succeeded, so its status stands: the teardown is
    // housekeeping and never pushes a supervisor toward a retry.
    expect(process.exitCode).toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
  },
  CASE_TIMEOUT_MS,
);
