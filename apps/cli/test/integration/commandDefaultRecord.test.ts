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
import { DEFAULT_RECORD_BASENAME, openingPathFor } from "../../src/recordFile";

// Net-new coverage: the per-command-handler wiring that turns the default-on
// audit record into files on disk. `psilink exchange` and the zero-setup command
// each default `--record` to true, read that default in their handler, and pass
// resolveRecordOutput(...) into the shared runProtocol write path. The write
// mechanism itself is unit-tested (recordFile.test.ts, protocol.test.ts), core's
// record building is tested (exchangeRecord*.test.ts), and the sibling
// onlineInviteAccept.test.ts covers the same default-on assertion for the
// invite/accept (runOnlineBootstrap) handlers. The remaining gap this file closes
// is the exchange and zero-setup HANDLERS: that, run with no record-related flags
// at all, each writes the default record and its private opening file.
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
// the test chdir's into its per-test work dir for the duration (restored in a
// finally) -- this keeps the artifact inside the work dir that afterEach removes,
// rather than littering the process cwd, while still passing no --record-file.
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
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-cmd-record-"));
  originalCwd = process.cwd();
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
  exitSpy.mockRestore();
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

// Locate the single default-path record the asserted party wrote in `dir`. The
// default basename is shared by the record (`<base>-<stamp>.json`) and its
// opening (`<base>-<stamp>.opening.json`), so exclude the opening to find the
// record itself. Exactly one is expected, since only the asserted party records.
function findDefaultRecord(dir: string): string {
  const matches = fs
    .readdirSync(dir)
    .filter(
      (name) =>
        name.startsWith(`${DEFAULT_RECORD_BASENAME}-`) &&
        name.endsWith(".json") &&
        !name.endsWith(".opening.json"),
    );
  expect(matches).toHaveLength(1);
  return path.join(dir, matches[0]);
}

// Assert the asserted party's default-on artifacts: the record and its private
// opening exist, and the record round-trips as JSON naming this exchange's
// participants. Contents beyond that are covered by the record unit tests; this
// confirms only that the handler wired a record for the right exchange.
function expectDefaultRecord(
  dir: string,
  local: string,
  partner: string,
): void {
  const recordFile = findDefaultRecord(dir);
  expect(fs.existsSync(openingPathFor(recordFile))).toBe(true);
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

test("exchange: a default-flag run writes the default audit record and opening file", async () => {
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

  // Run from the work dir so party A's default record (`./psilink-record-*.json`)
  // lands here and is cleaned up with it, while still passing no --record-file.
  process.chdir(work);
  await Promise.all([
    // Asserted party: NO record-related flags, so `--record` defaults to true and
    // the record goes to the default path.
    runCli([
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
      String(PEER_TIMEOUT_SECONDS),
      "--log-level",
      "silent",
    ]),
    // Peer: same command, but --no-record so only the asserted party records.
    runCli([
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
      String(PEER_TIMEOUT_SECONDS),
      "--log-level",
      "silent",
    ]),
  ]);

  expectDefaultRecord(work, "party-a", "party-b");
}, 60_000);

// --- zero-setup ---------------------------------------------------------------

describe("zero-setup", () => {
  test("a default-flag run writes the default audit record and opening file", async () => {
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
    // provisioned -- the only artifact is party A's default audit record.
    process.chdir(work);
    await Promise.all([
      // Asserted party: NO record-related flags (and no --save).
      runCli([
        url,
        inputA,
        outA,
        "--identity",
        "party-a",
        "--peer-timeout",
        String(PEER_TIMEOUT_SECONDS),
        "--log-level",
        "silent",
      ]),
      // Peer: --no-record so only the asserted party records.
      runCli([
        url,
        inputB,
        outB,
        "--identity",
        "party-b",
        "--no-record",
        "--peer-timeout",
        String(PEER_TIMEOUT_SECONDS),
        "--log-level",
        "silent",
      ]),
    ]);

    expectDefaultRecord(work, "party-a", "party-b");
  }, 60_000);
});
