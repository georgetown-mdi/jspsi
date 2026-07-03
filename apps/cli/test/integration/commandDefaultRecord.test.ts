import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import yargs from "yargs";
import { prepareForExchange } from "@psilink/core";
import type { ExchangeSpec } from "@psilink/core";

import {
  builder as exchangeBuilder,
  handler as exchangeHandler,
} from "../../src/commands/exchange";
import {
  builder as zeroSetupBuilder,
  handler as zeroSetupHandler,
} from "../../src/commands/zeroSetup";
import { saveConfig } from "../../src/config";
import { saveKeyFile } from "../../src/keyFile";
import { DEFAULT_RECORD_BASENAME, keysPathFor } from "../../src/recordFile";

// Net-new coverage: the per-command-handler wiring that turns the default-on
// audit record into files on disk. `psilink exchange` and the zero-setup command
// each default `--record` to true, read that default in their handler, and pass
// resolveRecordOutput(...) into the shared runProtocol write path. The write
// mechanism itself is unit-tested (recordFile.test.ts, protocol.test.ts), core's
// record building is tested (exchangeRecord*.test.ts), and the sibling
// onlineInviteAccept.test.ts covers the same default-on assertion for the
// invite/accept (runOnlineBootstrap) handlers. The remaining gap this file closes
// is the exchange and zero-setup HANDLERS: that, run with no record-related flags
// at all, each writes the default record and its private verification-keys file.
//
// Why drive the real yargs builder + handler (not a post-parse seam like
// onlineInviteAccept's validate* -> runOnlineBootstrap): the thing under test IS
// the `--record` default and the handler body that reads it. Reconstructing that
// call in the test would re-test runProtocol (already covered) rather than the
// wiring. So each asserted party is run exactly as the CLI runs it -- through the
// command's builder so yargs applies `record: true`, then its handler -- with NO
// --record / --no-record / --record-file on the command line. This exercises both
// the default firing AND the default record path (defaultRecordPath), which is
// what "default-on" means here. process.exit is trapped (the handlers exit rather
// than throw on failure), so any handler error surfaces as a clean test rejection
// instead of killing the worker.
//
// Each exchange needs two parties to complete, but only the ASSERTED party is run
// with the default record on; its peer is the same command with --no-record, so
// exactly one default record lands and there is no path collision. The default
// record path is `./psilink-record-<stamp>.json` relative to the process cwd, so
// each test runs from its per-test work dir (chdir in beforeEach, restored in
// afterEach) -- this keeps the artifact inside the work dir that afterEach
// removes, rather than littering the process cwd, while still passing no
// --record-file.
//
// filedrop only: the record-write wiring is transport-agnostic (the handler reads
// the same `--record` default and calls the same runProtocol regardless of
// channel), so a real SFTP container buys nothing here -- the same rationale the
// sibling file gives for its transport-agnostic (failure-path) assertions. This
// file therefore needs no Docker even though it lives in the integration project.
//
// CLI integration tests are Docker-backed and self-managing via a vitest
// globalSetup (see CLAUDE.local.md); run with `npm run test:integration -w
// apps/cli`.

// 32 zero bytes as base64url (43 chars): a valid shared secret. Both exchange
// parties' key files start from it so the authenticated handshake succeeds; each
// rotates to the same fresh value on success (the rotation itself is asserted by
// authenticatedExchange.test.ts, not re-checked here).
const INITIAL_SECRET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

// Bound each party's transport wait well under the per-test timeout so a genuine
// stall fails fast with a clean peer-timeout rather than racing the framework's
// kill (core's default peer timeout is one hour). Both sides complete in a couple
// of seconds on the local filedrop transport, so this is pure safety margin.
const PEER_TIMEOUT_SECONDS = 30;

// The columns the default linkage-term inference recognizes; ssn + last_name +
// date_of_birth satisfy the first (most precise) default key template, so an
// empty ExchangeDataSpec infers a usable key with no preparation warnings. DOB is
// YYYYMMDD and SSN is plain 9-digit, matching the standardization defaults.
const CSV_HEADER = "ssn,last_name,first_name,date_of_birth";
// Two shared records (SMITH, JONES) plus one non-matcher per side (BROWN / WHITE),
// so each exchange finds a real intersection and produces output -- the precondition
// for the audit record to be built and written.
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

// One representative row, used only to infer the default linkage terms and
// metadata baked into the exchange config below. The terms depend on the column
// types, not the row values, so a single row is enough; it is never exchanged.
const PROVISION_ROWS = [
  {
    ssn: "123456789",
    last_name: "SMITH",
    first_name: "JOHN",
    date_of_birth: "19900115",
  },
];

const RECORD_VERSION = "psilink-exchange-record/v1";

let work: string;
let originalCwd: string;
let exitSpy: ReturnType<typeof vi.spyOn> | undefined;

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-cmd-record-"));
  originalCwd = process.cwd();
  // Run from the work dir so the asserted party's default record
  // (`./psilink-record-*.json`, resolved against cwd) lands here and is cleaned
  // up with it, while still passing no --record-file. Done here, not inline in
  // each test, so the chdir is paired one-to-one with its afterEach restore and
  // not interleaved with the test body. (cwd is process-global, so these tests
  // are not safe to run concurrently within the file -- which the project's
  // file-isolated, sequential-within-file runner does not do.)
  process.chdir(work);
  // The handlers call process.exit on any failure (bad config, a stalled or
  // mismatched exchange); trap it so such a failure rejects the awaiting
  // parseAsync -- and thus fails the test with the exit code -- instead of
  // terminating the vitest worker. Mirrors the unit tests' exit trap.
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code ?? 0})`);
  }) as never);
});

afterEach(() => {
  process.chdir(originalCwd);
  // Guarded: if beforeEach threw before assigning the spy, afterEach still runs,
  // and an unconditional restore would throw a TypeError that masks the original
  // failure.
  exitSpy?.mockRestore();
  exitSpy = undefined;
  try {
    if (work) fs.rmSync(work, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

// Run a single CLI invocation exactly as index.ts wires it: the zero-setup
// command as the `$0` default and `exchange` as a subcommand, so the same
// builders apply the same option defaults (notably `record: true`). exitProcess
// is disabled so a yargs-level parse error rejects rather than exiting; a handler
// error already rejects via the trapped process.exit above.
async function runCli(argv: string[]): Promise<void> {
  await yargs(argv)
    .scriptName("psilink")
    .command("$0", "zero-setup exchange", zeroSetupBuilder, zeroSetupHandler)
    .command("exchange <input> [output]", "", exchangeBuilder, exchangeHandler)
    .exitProcess(false)
    .parseAsync();
}

// Run both parties concurrently and wait for BOTH to settle (allSettled, not
// Promise.all). On a failure this matters: Promise.all would reject the instant
// one party threw and let the test body unwind -- and afterEach delete the work
// dir and restore the exit spy -- while the other handler kept running in the
// background, racing those teardown steps and turning its eventual process.exit
// into an unhandled rejection (or, post-restore, a real worker-killing exit).
// allSettled holds the test until neither handler is still running (each side is
// bounded by --peer-timeout), then any rejection is rethrown so the test fails
// with the handler's own error rather than an opaque background warning. When
// both sides fail the two errors are surfaced together (an AggregateError),
// since a two-sided breakdown is exactly where the second cause matters.
async function runBoth(argvA: string[], argvB: string[]): Promise<void> {
  const results = await Promise.allSettled([runCli(argvA), runCli(argvB)]);
  const reasons = results
    .filter((r) => r.status === "rejected")
    .map((r) => (r as PromiseRejectedResult).reason);
  if (reasons.length === 1) throw reasons[0];
  if (reasons.length > 1)
    throw new AggregateError(reasons, "both parties failed");
}

// Locate the single default-path record the asserted party wrote in `dir`. The
// default basename is shared by the record (`<base>-<stamp>.json`) and its
// verification keys (`<base>-<stamp>.keys.json`), so exclude the keys to find the
// record itself. Exactly one is expected, since only the asserted party records.
function findDefaultRecord(dir: string): string {
  const matches = fs
    .readdirSync(dir)
    .filter(
      (name) =>
        name.startsWith(`${DEFAULT_RECORD_BASENAME}-`) &&
        name.endsWith(".json") &&
        !name.endsWith(".keys.json"),
    );
  // Explicit guard rather than `expect(...).toHaveLength(1)` then `matches[0]`:
  // the throw is what makes the subsequent index access safe, so state it
  // outright (and name what was actually found) instead of leaning on the
  // assertion library's throw-on-failure as the implicit guard.
  if (matches.length !== 1)
    throw new Error(
      `expected exactly one default record in ${dir}, found ${matches.length}` +
        (matches.length > 0 ? `: ${matches.join(", ")}` : ""),
    );
  return path.join(dir, matches[0]);
}

// Assert the asserted party's default-on artifacts: the record and its private
// verification keys exist, are written owner-only, and the record round-trips as
// JSON naming this exchange's participants. Contents beyond that are covered by
// the record unit tests; this confirms only that the handler wired a record for
// the right exchange.
function expectDefaultRecord(
  dir: string,
  local: string,
  partner: string,
): void {
  const recordFile = findDefaultRecord(dir);
  const keysFile = keysPathFor(recordFile);
  expect(fs.existsSync(keysFile)).toBe(true);
  // Both files are written through the command handler's default record path and
  // must be owner-only (0600): the verification keys are private commitment salts
  // and the record discloses the exchange's participants and terms in cleartext.
  // Pin it end to end here so a mode-widening regression in that write path is
  // caught at the command layer, not just in the recordFile unit tests. POSIX
  // only: writeFileOwnerOnly uses ACLs on Windows, where mode bits do not
  // reflect it -- the same guard the sibling onlineInviteAccept test uses.
  if (process.platform !== "win32") {
    expect(fs.statSync(recordFile).mode & 0o077).toBe(0);
    expect(fs.statSync(keysFile).mode & 0o077).toBe(0);
  }
  const record = JSON.parse(fs.readFileSync(recordFile, "utf8")) as {
    version?: unknown;
    localIdentity?: unknown;
    partnerIdentity?: unknown;
  };
  expect(record.version).toBe(RECORD_VERSION);
  expect(record.localIdentity).toBe(local);
  expect(record.partnerIdentity).toBe(partner);
}

// --- exchange -----------------------------------------------------------------

test("exchange: a default-flag run writes the default audit record and keys file", async () => {
  const dropDir = fs.mkdtempSync(path.join(work, "drop-"));
  const inputA = path.join(work, "a-input.csv");
  fs.writeFileSync(inputA, PARTY_A_CSV);
  const inputB = path.join(work, "b-input.csv");
  fs.writeFileSync(inputB, PARTY_B_CSV);
  const outA = path.join(work, "a-out.csv");
  const outB = path.join(work, "b-out.csv");

  // One config, shared read-only by both parties (exchange only reads it): the
  // filedrop rendezvous plus the default linkage terms inferred from the input
  // columns. pollIntervalMs:1 keeps the local filedrop round trip fast. Each
  // party overrides the identity on the command line, so the baked identity is
  // irrelevant. Key files are per-party (each rotates its own) and start from the
  // same secret so the handshake succeeds.
  const prepared = prepareForExchange({}, "config", PROVISION_ROWS, CSV_FIELDS);
  const spec: ExchangeSpec = {
    connection: {
      channel: "filedrop",
      path: dropDir,
      options: { pollIntervalMs: 1 },
    },
    linkageTerms: prepared.linkageTerms,
    metadata: prepared.metadata,
  };
  const configFile = path.join(work, "psilink.yaml");
  saveConfig(configFile, spec);
  const keyA = path.join(work, "a.key");
  const keyB = path.join(work, "b.key");
  saveKeyFile(keyA, { sharedSecret: INITIAL_SECRET });
  saveKeyFile(keyB, { sharedSecret: INITIAL_SECRET });

  // Asserted party runs with NO record-related flags, so `--record` defaults to
  // true and the record goes to the default path; the peer runs the same command
  // with --no-record so only the asserted party records.
  await runBoth(
    [
      "exchange",
      inputA,
      outA,
      "--config-file",
      configFile,
      "--key-file",
      keyA,
      "--identity",
      "party-a",
      "--peer-timeout",
      `${PEER_TIMEOUT_SECONDS}s`,
      "--log-level",
      "silent",
    ],
    [
      "exchange",
      inputB,
      outB,
      "--config-file",
      configFile,
      "--key-file",
      keyB,
      "--identity",
      "party-b",
      "--no-record",
      "--peer-timeout",
      `${PEER_TIMEOUT_SECONDS}s`,
      "--log-level",
      "silent",
    ],
  );

  expectDefaultRecord(work, "party-a", "party-b");
}, 90_000);

// --- zero-setup ---------------------------------------------------------------

describe("zero-setup", () => {
  test("a default-flag run writes the default audit record and keys file", async () => {
    const dropDir = fs.mkdtempSync(path.join(work, "drop-"));
    const url = pathToFileURL(dropDir).href;
    const inputA = path.join(work, "a-input.csv");
    fs.writeFileSync(inputA, PARTY_A_CSV);
    const inputB = path.join(work, "b-input.csv");
    fs.writeFileSync(inputB, PARTY_B_CSV);
    const outA = path.join(work, "a-out.csv");
    const outB = path.join(work, "b-out.csv");

    // Zero-setup needs no config or key: both parties meet at the same file://
    // URL with terms inferred from their inputs. No --save, so nothing is
    // provisioned -- the only artifact is the asserted party's default audit
    // record. The peer runs --no-record so only the asserted party records.
    // --polling-frequency 100ms keeps the local filedrop round trip fast: unlike
    // the exchange: sibling above (which sets config pollIntervalMs:1), zero-setup
    // has no config, so this flag is its only way to override the conservative
    // 5s default that would otherwise blow the 90s timeout.
    await runBoth(
      [
        url,
        inputA,
        outA,
        "--identity",
        "party-a",
        "--polling-frequency",
        "100ms",
        "--peer-timeout",
        `${PEER_TIMEOUT_SECONDS}s`,
        "--log-level",
        "silent",
      ],
      [
        url,
        inputB,
        outB,
        "--identity",
        "party-b",
        "--no-record",
        "--polling-frequency",
        "100ms",
        "--peer-timeout",
        `${PEER_TIMEOUT_SECONDS}s`,
        "--log-level",
        "silent",
      ],
    );

    expectDefaultRecord(work, "party-a", "party-b");
  }, 90_000);
});
