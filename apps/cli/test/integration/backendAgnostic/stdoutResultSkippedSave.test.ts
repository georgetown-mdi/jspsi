import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { prepareForExchange } from "@psilink/core";
import type { ExchangeDataSpec, LinkageTerms } from "@psilink/core";
import { withCapturedLogs } from "@psilink/core/testing";

import {
  runProtocol,
  type ProtocolConnectionConfig,
} from "../../../src/protocol";
import { captureFd3 } from "../../eventStreamTestSupport";

/**
 * What a `--save` run reports when the reader of its stdout result stops
 * taking it: the run fails on the undelivered result, so the save that comes
 * after it never runs, and the notice beside that failure names the skipped
 * save rather than leaving the operator to infer it from the exit code. The
 * partner of this run saved too, so what the notice warns about -- a recurring
 * exchange one side holds and this one does not -- is the case being driven.
 *
 * The reader stalls the same way `stdoutResultDrain.test.ts` stalls it, at
 * `writeOutput`'s own boundary and under a cut ceiling, so everything below
 * that boundary is the shipped code path; that case covers what the undelivered
 * result itself reports.
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
  work = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-skipped-save-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(work, { recursive: true, force: true });
});

test("an undelivered stdout result names the save it skipped", async () => {
  const dropDir = fs.mkdtempSync(path.join(work, "drop-"));
  const makeConfig = (): ProtocolConnectionConfig => ({
    channel: "filedrop",
    path: dropDir,
    options: { pollIntervalMs: 1, peerTimeoutMs: 20_000 },
  });

  // The save this run was asked for, which the zero-setup command performs
  // from this hook: it writes the configuration and key file a later
  // recurring exchange reads.
  let saved = false;

  const { value: run, lines } = await captureFd3(async () => {
    const [results, logs] = await withCapturedLogs(
      () =>
        Promise.allSettled([
          runProtocol({
            connection: makeConfig(),
            auth: null,
            prepared: preparedFor("Party A"),
            output: undefined,
            verbosity: -1,
            loggerName: "skipped-save-a",
            saveIntent: true,
            fileSyncRuntime: {
              eventStream: true,
              onOutputComplete: () => {
                saved = true;
                return { persisted: true };
              },
            },
          }),
          runProtocol({
            connection: makeConfig(),
            auth: null,
            prepared: preparedFor("Party B"),
            output: path.join(work, "b-out.csv"),
            verbosity: -1,
            loggerName: "skipped-save-b",
            saveIntent: true,
          }),
        ]),
      (level) => level === "WARN" || level === "ERROR",
    );
    return { results, logs };
  });
  const [resA, resB] = run.results;

  expect(resB.status).toBe("fulfilled");
  expect(resA.status).toBe("rejected");
  expect((resA as PromiseRejectedResult).reason).toMatchObject({
    exitCode: 73,
  });

  // The save did not run, which is the state the notice below has to report:
  // the partner completed a bootstrap this party kept nothing from.
  expect(saved).toBe(false);

  const warnings = lines.filter(
    (line) =>
      line["type"] === "warning" && line["source"] === "persistenceLoss",
  );
  expect(warnings).toHaveLength(1);
  expect(warnings[0]["message"]).toContain(
    "the post-exchange persistence step did not run",
  );
  expect(warnings[0]["message"]).toContain("your partner may have saved");

  // And on the channel an operator without --event-stream has, at the level a
  // run set to --log-level error keeps.
  expect(
    run.logs.filter(
      (entry) =>
        entry.level === "ERROR" &&
        entry.message.includes(
          "the post-exchange persistence step did not run",
        ),
    ),
  ).toHaveLength(1);

  // It reaches a supervisor that stops reading at the outcome: the warning is
  // behind the terminal event, which still reports the undelivered result.
  const terminal = lines[lines.length - 1];
  expect(terminal["type"]).toBe("error");
  expect(terminal["category"]).toBe("output");
  expect(lines.indexOf(warnings[0])).toBeLessThan(lines.length - 1);
}, 30_000);
