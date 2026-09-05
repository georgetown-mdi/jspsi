import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, test } from "vitest";
import { UsageError, prepareForExchange } from "@psilink/core";
import type { ExchangeDataSpec, LinkageTerms } from "@psilink/core";
import { withCapturedLogs } from "@psilink/core/testing";

import {
  BOTH_SWEPT_GUIDANCE,
  runProtocol,
  type ProtocolConnectionConfig,
} from "../../../src/protocol";
import { loadKeyFile, saveKeyFile } from "../../../src/keyFile";

// What `--sweep-exchange-files` does when both operators reach for it, and
// whether what each of them is then told works.
//
// The entry guard names the flag to whoever hits it, so both operators tend
// to pass it; the second sweep then deletes the first party's live
// rendezvous files. protocol.test.ts pins the CLI gate's emit/withhold
// decision at its unit boundary. What only two real parties over a real
// directory can settle is the runtime claim the shipped guidance makes: one
// side sweeping is enough, both sides sweeping breaks the exchange on both
// sides, and the directory it leaves is one a plain re-run can use.
//
// The CONCURRENT double sweep is not driven here by design. Its outcome is
// racy at the margin -- the sweep's own "may be partially swept" failure is a
// legitimate landing for it -- so pinning a single result would be flaky by
// construction. The SEQUENTIAL collision below is the deterministic arm.
//
// Filedrop only. The collision is transport-independent: the second sweep
// deletes a live hello through the same client interface whichever transport
// sends it, so an SFTP arm would re-measure the same property at several
// times the runtime.

// 32 zero bytes as base64url: the shared secret both parties are provisioned
// with. Each party is started from whatever its key file holds at that moment,
// so a completed attempt's rotated token becomes the next one's starting
// secret -- which is what "run the exchange again, without re-inviting" means.
const INITIAL_SECRET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

// The budget for the arms that must TIME OUT. It is the test's runtime
// floor: the second party learns nothing is coming only when its peer-wait
// budget expires, and the first party's handshake receive is bounded by the
// same value. Sized against what the arm actually needs -- publishing its
// hello and seeing the second party's, both local file operations -- rather
// than a production wait.
const TIMEOUT_PEER_TIMEOUT_MS = 5_000;

// The budget for the arms that must COMPLETE. A real PSI exchange runs between
// the parties here, so this bounds the gaps between its messages rather than a
// wait for a partner that is not coming.
const COMPLETING_PEER_TIMEOUT_MS = 30_000;

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

// Party A holds fewer rows, so it is the PSI receiver -- the side that learns
// the intersection and writes it -- whichever party wins the rendezvous.
const ROWS_A = [{ first_name: "Bob" }, { first_name: "Carol" }];
const ROWS_B = [
  { first_name: "Bob" },
  { first_name: "Carol" },
  { first_name: "Dave" },
];

function preparedFor(identity: string, rows: Array<Record<string, string>>) {
  const spec: ExchangeDataSpec = { linkageTerms: { ...baseTerms, identity } };
  return prepareForExchange(spec, identity, rows, ["first_name"]);
}

interface PartyOutcome {
  /** "a" is the party that enters first, "b" the one that follows it in. */
  party: "a" | "b";
  ok: boolean;
  error?: unknown;
  /** The exit code the exchange handler would use for this party's failure. */
  exitCode?: number;
}

interface PairOutcome {
  /** Both settlements, in entry order. */
  parties: PartyOutcome[];
  /** Every operator-visible line the attempt produced, in emission order. */
  logs: string[];
  outputs: { a: string; b: string };
}

interface PairOptions {
  work: string;
  dropDir: string;
  /** Distinguishes one attempt's loggers and output CSVs from the next's. */
  tag: string;
  keyFiles: { a: string; b: string };
  /** Which parties pass `--sweep-exchange-files`. */
  sweep: { a: boolean; b: boolean };
  peerTimeoutMs: number;
}

/**
 * Blocks until a rendezvous hello is on disk, which is what makes the second
 * party's entry STRICTLY later than the first party's: the collision this file
 * drives is the sequential one, and a race to enter would be the concurrent
 * shape instead. Bounded, so a first party that failed before publishing
 * reports that rather than hanging the file.
 */
async function waitForHelloPublished(dropDir: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (fs.readdirSync(dropDir).some((name) => name.endsWith("-hello.json")))
      return;
    if (Date.now() > deadline)
      throw new Error(
        "the first party never published a rendezvous hello, so the second " +
          "party's entry could not be sequenced after it",
      );
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Runs two real runProtocol parties against one shared directory, the second
 * entering only once the first has published its hello. Both settlements are
 * attached before either is awaited, so a party that fails while the other is
 * still running is never an unhandled rejection.
 */
async function runSequentialPair(options: PairOptions): Promise<PairOutcome> {
  const { work, dropDir, tag, keyFiles, sweep, peerTimeoutMs } = options;
  const outputs = {
    a: path.join(work, `${tag}-a-out.csv`),
    b: path.join(work, `${tag}-b-out.csv`),
  };
  const connection = (): ProtocolConnectionConfig => ({
    channel: "filedrop",
    path: dropDir,
    options: { pollIntervalMs: 5, peerTimeoutMs },
  });

  const start = (party: "a" | "b"): Promise<unknown> =>
    runProtocol({
      connection: connection(),
      auth: {
        sharedSecret: loadKeyFile(keyFiles[party])!.sharedSecret,
        keyFilePath: keyFiles[party],
      },
      prepared: preparedFor(
        party === "a" ? "Party A" : "Party B",
        party === "a" ? ROWS_A : ROWS_B,
      ),
      output: outputs[party],
      verbosity: -1,
      loggerName: `${tag}-${party}`,
      fileSyncRuntime: { sweepExchangeFiles: sweep[party] },
    });

  const settle = async (
    party: "a" | "b",
    run: Promise<unknown>,
  ): Promise<PartyOutcome> => {
    try {
      await run;
      return { party, ok: true };
    } catch (error: unknown) {
      return {
        party,
        ok: false,
        error,
        exitCode: error instanceof UsageError ? 64 : 69,
      };
    }
  };

  const [parties, logs] = await withCapturedLogs(
    async () => {
      const a = settle("a", start("a"));
      await waitForHelloPublished(dropDir);
      const b = settle("b", start("b"));
      return [await a, await b];
    },
    (level) => level === "WARN" || level === "ERROR",
  );

  return { parties, logs: logs.map((entry) => entry.message), outputs };
}

/** The guidance lines a given party's logger emitted. */
function guidanceFor(outcome: PairOutcome, loggerName: string): string[] {
  return outcome.logs.filter(
    (line) =>
      line.includes(`[${loggerName}]`) && line.includes(BOTH_SWEPT_GUIDANCE),
  );
}

/** The intersection the receiving party wrote: a header plus every shared row. */
async function expectReceiverIntersection(outputPath: string): Promise<void> {
  const rows = (await fsp.readFile(outputPath, "utf8")).trim().split("\n");
  expect(rows).toHaveLength(1 + ROWS_A.length);
}

let work: string;
let dropDir: string;
let keyFiles: { a: string; b: string };

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-sweep-collide-"));
  dropDir = fs.mkdtempSync(path.join(work, "drop-"));
  keyFiles = { a: path.join(work, "a.key"), b: path.join(work, "b.key") };
  saveKeyFile(keyFiles.a, { sharedSecret: INITIAL_SECRET });
  saveKeyFile(keyFiles.b, { sharedSecret: INITIAL_SECRET });
});

afterEach(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

test("a sequential both-sides sweep fails both parties, and a plain re-run then completes", async () => {
  const collision = await runSequentialPair({
    work,
    dropDir,
    tag: "collide",
    keyFiles,
    sweep: { a: true, b: true },
    peerTimeoutMs: TIMEOUT_PEER_TIMEOUT_MS,
  });

  // Both sides fail, and both fail as transport unavailability rather than as
  // a local usage error: neither operator did anything the CLI can refuse.
  expect(collision.parties.map((party) => party.exitCode)).toEqual([69, 69]);
  // The party that entered first got past the rendezvous -- the second party's
  // sweep had taken its live hello, so nothing was left to answer its
  // handshake -- while the second never found a peer at all.
  expect((collision.parties[0].error as Error).message).toBe(
    "key exchange handshake timed out",
  );
  expect((collision.parties[1].error as Error).message).toContain(
    "synchronization has timed out",
  );
  // The guidance reaches BOTH operators, asserted where runProtocol produces
  // it rather than at the gate's unit boundary: recovering needs no contact
  // between the two and no agreement on who goes first, which only holds if
  // each is told the same thing.
  expect(guidanceFor(collision, "collide-a")).toHaveLength(1);
  expect(guidanceFor(collision, "collide-b")).toHaveLength(1);

  // What the guidance prescribes, measured: both parties again, same
  // directory, neither flag. The directory it left is asserted first, so the
  // re-run is measured against a known state rather than whatever the
  // collision happened to leave.
  expect(await fsp.readdir(dropDir)).toEqual([]);
  const rerun = await runSequentialPair({
    work,
    dropDir,
    tag: "rerun",
    keyFiles,
    sweep: { a: false, b: false },
    peerTimeoutMs: COMPLETING_PEER_TIMEOUT_MS,
  });

  expect(rerun.parties.filter((party) => !party.ok)).toEqual([]);
  await expectReceiverIntersection(rerun.outputs.a);
}, 120_000);

test("a sequential one-sided sweep clears the residue and completes the exchange", async () => {
  // The arm the one-party recovery rests on. The residue is what makes the
  // sweep critical rather than a no-op over an empty directory: a leftover
  // lock is a protocol file the unflagged entry guard refuses (core's
  // fileSyncRendezvous.test.ts pins that refusal), so this exchange completes
  // only because the first party cleared it -- and the second party, entering
  // afterwards with no flag, is not broken by having had its slate cleaned.
  const stale =
    "5f2a71c8-0b3e-4d19-8a44-6c9e2f10b7d3-" +
    "e1d4c7a6-8f52-4b30-9c17-3a05e6b28d94-lock.json";
  await fsp.writeFile(path.join(dropDir, stale), "{}");

  const outcome = await runSequentialPair({
    work,
    dropDir,
    tag: "onesided",
    keyFiles,
    sweep: { a: true, b: false },
    peerTimeoutMs: COMPLETING_PEER_TIMEOUT_MS,
  });

  expect(outcome.parties.filter((party) => !party.ok)).toEqual([]);
  expect(await fsp.readdir(dropDir)).not.toContain(stale);
  await expectReceiverIntersection(outcome.outputs.a);
  // Nothing suggested a collision: the guidance is gated on a peer-wait
  // timeout, and neither party had one.
  expect(guidanceFor(outcome, "onesided-a")).toEqual([]);
  expect(guidanceFor(outcome, "onesided-b")).toEqual([]);
}, 120_000);
