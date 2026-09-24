import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { prepareForExchange } from "@alcove/core";
import type { ExchangeDataSpec, LinkageTerms } from "@alcove/core";
import { withCapturedLogs } from "@alcove/core/testing";

import { saveKeyFile } from "../../../src/keyFile";
import {
  runProtocol,
  type ProtocolConnectionConfig,
} from "../../../src/protocol";
import { captureFd3 } from "../../eventStreamTestSupport";

/**
 * What a completed run does when the reader of its stdout result stops taking
 * it: the drain reaches its ceiling, the result is undelivered, and the run
 * reports that as the loss it is -- exit code 73 on the error, the terminal
 * `error` event under the `output` category, and no `result` event claiming a
 * result was written.
 *
 * The reader stops part-way through and the ceiling is cut rather than waited
 * out: the shipped one is a minute, and `process.stdout` in a test worker
 * drains as fast as it is written. Both are applied at `writeOutput`'s own
 * boundary -- the ceiling through the parameter it takes for this, the stall
 * by reporting the first line as taken and then holding the last one's write
 * callback forever -- so everything under it, drain included, is the shipped
 * code path. The stall follows a delivered line on purpose: the ceiling is an
 * idle one, so a run that had made progress and stopped is the case that has
 * to fail, where one that never moved would fail under a total budget too.
 * What that boundary does with a real pipe and a reader that keeps taking the
 * result is `stdoutDrainIdleCeiling.test.ts`.
 */

/** The injected ceiling: long enough not to fire on scheduling, short to wait. */
const DRAIN_CEILING_MS = 50;

vi.mock("../../../src/util/dataIo", async (importActual) => {
  const actual =
    await importActual<typeof import("../../../src/util/dataIo")>();
  return {
    ...actual,
    writeOutput: (
      output: string | undefined,
      headers: string[],
      rows: Array<Array<string>>,
      log: { error: (message: string) => void },
    ) => {
      if (output !== undefined)
        return actual.writeOutput(output, headers, rows, log);
      const stalled = vi.spyOn(process.stdout, "write").mockImplementation(((
        _chunk: string | Uint8Array,
        flushed?: (err?: Error | null) => void,
      ): boolean => {
        // The first line is refused and then reported as taken, which is the
        // drain the write loop reads progress from; the line after it is held
        // forever. A reader that took the first of the result and then stopped.
        if (flushed === undefined) {
          setTimeout(() => process.stdout.emit("drain"), 5);
          return false;
        }
        return true;
      }) as typeof process.stdout.write);
      return actual
        .writeOutput(output, headers, rows, log, DRAIN_CEILING_MS)
        .finally(() => stalled.mockRestore());
    },
  };
});

/** 32 zero bytes as base64url: the shared secret both key files start from. */
const INITIAL_SECRET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const baseTerms: Omit<LinkageTerms, "identity"> = {
  version: "1.0.0",
  date: "2026-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  deduplicate: false,
  output: { expectsOutput: true, shareWithPartner: true },
  linkageFields: [{ name: "firstName", type: "first_name" }],
  linkageKeys: [{ name: "firstName", elements: [{ field: "firstName" }] }],
};

function preparedFor(identity: string) {
  const spec: ExchangeDataSpec = { linkageTerms: { ...baseTerms, identity } };
  return prepareForExchange(
    spec,
    identity,
    [{ first_name: "Bob" }],
    ["first_name"],
  );
}

let work: string;

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "alcove-stdout-drain-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(work, { recursive: true, force: true });
});

test("a reader that stops mid-result fails the run at 73 rather than reporting one", async () => {
  const dropDir = fs.mkdtempSync(path.join(work, "drop-"));
  const keyA = path.join(work, "a.key");
  const keyB = path.join(work, "b.key");
  saveKeyFile(keyA, { sharedSecret: INITIAL_SECRET });
  saveKeyFile(keyB, { sharedSecret: INITIAL_SECRET });

  const makeConfig = (): ProtocolConnectionConfig => ({
    channel: "filedrop",
    path: dropDir,
    options: { pollIntervalMs: 1, peerTimeoutMs: 20_000 },
  });

  // Only party A opens the stream, so fd 3 holds one run's events. Its token
  // rotated before the local failure, so runProtocol logs the recovery
  // advisory at ERROR; both parties run under withCapturedLogs so that
  // intended line is captured rather than left on the suite console.
  const { value: settled, lines } = await captureFd3(async () => {
    const [results] = await withCapturedLogs(
      () =>
        Promise.allSettled([
          runProtocol({
            connection: makeConfig(),
            auth: { sharedSecret: INITIAL_SECRET, keyFilePath: keyA },
            prepared: preparedFor("Party A"),
            output: undefined,
            verbosity: -1,
            loggerName: "drain-a",
            fileSyncRuntime: { eventStream: true },
          }),
          runProtocol({
            connection: makeConfig(),
            auth: { sharedSecret: INITIAL_SECRET, keyFilePath: keyB },
            prepared: preparedFor("Party B"),
            output: path.join(work, "b-out.csv"),
            verbosity: -1,
            loggerName: "drain-b",
          }),
        ]),
      (level) => level === "WARN" || level === "ERROR",
    );
    return results;
  });
  const [resA, resB] = settled;

  // The exchange itself completed on both sides: what failed is the delivery
  // of A's own result, which is the loss 73 names.
  expect(resB.status).toBe("fulfilled");
  expect(resA.status).toBe("rejected");
  const reason = (resA as PromiseRejectedResult).reason as {
    exitCode?: number;
    message?: string;
  };
  expect(reason.exitCode).toBe(73);
  expect(reason.message).toContain(
    "nothing more of the result left the process",
  );

  // On fd 3 the run reports a failed output stage, not a written result: a
  // supervisor reading only this stream must not record a delivery that did
  // not happen.
  const terminal = lines[lines.length - 1];
  expect(terminal["type"]).toBe("error");
  expect(terminal["category"]).toBe("output");
  expect(lines.filter((line) => line["type"] === "result")).toEqual([]);
  expect(lines.some((line) => line["resultWritten"] === true)).toBe(false);
}, 30_000);
