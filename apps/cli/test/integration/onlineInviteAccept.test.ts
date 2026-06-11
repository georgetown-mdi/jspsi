import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, beforeEach, expect, test } from "vitest";
import logLibrary from "loglevel";
import YAML from "yaml";
import {
  getLogger,
  parseExchangeSpec,
  SHARED_SECRET_REGEX,
} from "@psilink/core";
import type { FileDropConnectionConfig } from "@psilink/core";

import {
  resolveInvitePositionals,
  validateInvite,
} from "../../src/commands/invite";
import {
  resolveAcceptPositionals,
  validateAccept,
} from "../../src/commands/accept";
import {
  runOnlineBootstrap,
  type CommonBootstrapOptions,
} from "../../src/commands/bootstrap";
import { loadKeyFile } from "../../src/keyFile";
import { openingPathFor, resolveRecordOutput } from "../../src/recordFile";

// Net-new coverage: the ONLINE invite + accept wiring, end to end, with both
// sides on their real online code path (a live authenticated handshake, not the
// offline path). The sibling authenticatedExchange.test.ts drives runProtocol
// directly; this file drives one level up -- validateInvite/validateAccept ->
// runOnlineBootstrap -- so the assertions cover exactly the untested delta the
// task names: building the connection from a URL (connectionFromURL), threading
// the shared secret from the minted invitation through the handshake on both
// sides, and the saveConfig-after-runProtocol persistence (the onAuthenticated
// hook) actually firing for both invite and accept.
//
// Why this seam and not the yargs handlers: invite/accept's handlers wrap their
// whole body in runOrExit (which calls process.exit on any thrown error) and
// accept blocks on a stdin confirmation prompt -- both make running the two
// parties concurrently in one process unworkable. validate* -> runOnlineBootstrap
// is the exact sequence each handler runs after parsing (invite.ts handler;
// accept.ts handler), minus only the stdout token print, the confirm prompt, and
// the closing log line -- none of which are the online wiring under test.
//
// Transport (the task's open question): filedrop, matching the filedrop arm the
// sibling authenticatedExchange integration test already uses. It is materially
// simpler than SFTP for this wiring -- a file:// URL over a local directory, no
// per-phase server subdir or container path to manage -- and still runs under the
// self-managing CLI integration project unchanged.

let work: string;

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-online-integ-"));
});

afterEach(() => {
  try {
    if (work) fs.rmSync(work, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

// Validation-phase logger: the warnings validateInvite/validateAccept emit are
// not under test here, so keep them quiet. runOnlineBootstrap creates its own
// loggers by name (as in production), so protocol diagnostics still surface.
const log = getLogger("online-integ-test");
log.setLevel("silent");

// Bound each side's transport wait -- the inviter via acceptTimeout, the acceptor
// via options.peerTimeout -- well under the 60s vitest test timeout below, so a
// genuine stall fails fast with a clean peer-timeout error instead of racing the
// framework's kill. This matters because core's default peer timeout is one hour
// (DEFAULT_PEER_TIMEOUT_MS), which would otherwise leave a hung acceptor waiting
// far past the test timeout. The happy path completes in a few seconds, so the
// value is pure safety margin, not a tuning knob.
const PEER_TIMEOUT_SECONDS = 30;

// Minimal options with config/key/record at fresh paths under the work dir, so
// the invite/accept conflict gates pass and each run writes its own files.
// `record` is left at the shipped CLI default (true) -- matching what the real
// handlers do -- so the default-on audit-record path is exercised; recordFile is
// pinned under the work dir (rather than the default `./psilink-record-<stamp>`,
// which would litter the process cwd) so the artifacts are cleaned up with it.
function testOptions(label: string): CommonBootstrapOptions {
  return {
    configFile: path.join(work, `${label}.yaml`),
    keyFile: path.join(work, `${label}.key`),
    identity: label,
    peerTimeout: PEER_TIMEOUT_SECONDS,
    record: true,
    recordFile: path.join(work, `${label}-record.json`),
    logLevel: logLibrary.levels.SILENT,
    verbosity: 0,
  };
}

// writeOutput emits the header and each row as separate write() calls and closes
// the stream without awaiting 'finish', so a reader can briefly observe a partial
// file (header only, or header plus some rows). Poll until the file holds exactly
// the expected line count (header + dataRows) AND is byte-stable across two reads,
// so a partial flush that happens to repeat within one 20 ms window is never
// mistaken for the complete output. On timeout, report the last content seen, so a
// genuine stall (or an unexpected row count) is diagnosable rather than blamed on
// an empty file. Stricter than the sibling authenticatedExchange test's
// stability-only poll because here the exact output shape is known up front.
async function readStableOutput(
  file: string,
  dataRows: number,
): Promise<string> {
  const expectedLines = 1 + dataRows;
  const deadline = Date.now() + 5_000;
  let last = "";
  for (;;) {
    let cur = "";
    try {
      cur = await fsp.readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (
      cur.length > 0 &&
      cur === last &&
      cur.trim().split("\n").length === expectedLines
    )
      return cur;
    if (Date.now() > deadline)
      throw new Error(
        `output file ${file} did not reach ${expectedLines} stable lines ` +
          `within 5s; last saw ${cur.length} bytes: ${JSON.stringify(cur)}`,
      );
    last = cur;
    await new Promise<void>((r) => setTimeout(r, 20));
  }
}

test("filedrop: online invite + accept round-trip authenticates, finds the intersection, rotates the token, and persists both configs and audit records", async () => {
  // Both parties meet at the same file-drop directory; the URL is what each would
  // pass on the command line (psilink invite/accept <URL> ...).
  const dropDir = fs.mkdtempSync(path.join(work, "drop-"));
  const url = pathToFileURL(dropDir).href;

  // Each side carries a non-matching row -- the inviter's Dave (row 2), the
  // acceptor's Zoe (row 0) -- so the output proves the PSI filters on both sides
  // rather than echoing every record. The two non-matchers sit at deliberately
  // different positions so the shared records land at different local indices on
  // each side (Bob at invite row 0 / accept row 1; Carol at invite row 1 / accept
  // row 2). That makes the association table asymmetric, so the assertions below
  // pin the actual local->partner mapping, not merely which rows matched: a bug
  // that swapped or mis-keyed the partner index would change the pairs.
  // Intersection: Bob, Carol.
  const inviteInput = path.join(work, "invite-input.csv");
  fs.writeFileSync(
    inviteInput,
    "first_name,last_name,date_of_birth\n" +
      "Bob,Jones,1990-01-02\n" +
      "Carol,Lee,1985-07-16\n" +
      "Dave,Kim,1978-11-30\n",
  );
  const acceptInput = path.join(work, "accept-input.csv");
  fs.writeFileSync(
    acceptInput,
    "first_name,last_name,date_of_birth\n" +
      "Zoe,Adams,2001-03-03\n" +
      "Bob,Jones,1990-01-02\n" +
      "Carol,Lee,1985-07-16\n",
  );

  const inviteOptions = testOptions("invite");
  const acceptOptions = testOptions("accept");
  const inviteOut = path.join(work, "invite-out.csv");
  const acceptOut = path.join(work, "accept-out.csv");

  // Invite validation mints the invitation and builds the inviter's connection
  // from the URL (the online wiring's no-network half).
  const inviteResolved = resolveInvitePositionals([
    url,
    inviteInput,
    inviteOut,
  ]);
  const inviteReady = await validateInvite({
    resolved: inviteResolved,
    options: inviteOptions,
    acceptTimeout: PEER_TIMEOUT_SECONDS,
    log,
  });
  expect(inviteReady.mode).toBe("online");
  if (inviteReady.mode !== "online") return;

  // Accept validation decodes that same invitation (so token.sharedSecret is the
  // one the inviter minted) and builds the acceptor's connection from the URL. No
  // pre-existing config, so a fresh one will be written (reuseExistingConfig false).
  const acceptResolved = resolveAcceptPositionals([
    url,
    inviteReady.invitation,
    acceptInput,
    acceptOut,
  ]);
  const acceptReady = await validateAccept({
    resolved: acceptResolved,
    options: acceptOptions,
    log,
  });
  expect(acceptReady.mode).toBe("online");
  if (acceptReady.mode !== "online") return;
  expect(acceptReady.reuseExistingConfig).toBe(false);

  // Run both online wirings concurrently: the live authenticated handshake over
  // the shared file drop, then the PSI exchange, then the saveConfig hook. This
  // is the invite.ts / accept.ts handler tail verbatim.
  const [inviteResult, acceptResult] = await Promise.all([
    runOnlineBootstrap({
      connection: inviteReady.connection,
      dataSpec: inviteReady.dataSpec,
      prepared: inviteReady.prepared,
      sharedSecret: inviteReady.sharedSecret,
      expires: inviteReady.expires,
      keyPath: inviteOptions.keyFile,
      configPath: inviteOptions.configFile,
      output: inviteReady.output,
      verbosity: 0,
      loggerName: "invite",
      recordOutput: resolveRecordOutput({
        enabled: inviteOptions.record,
        recordFile: inviteOptions.recordFile,
      }),
    }),
    runOnlineBootstrap({
      connection: acceptReady.connection,
      dataSpec: acceptReady.dataSpec,
      prepared: acceptReady.prepared,
      sharedSecret: acceptReady.token.sharedSecret,
      expires: acceptReady.token.expires,
      keyPath: acceptOptions.keyFile,
      configPath: acceptOptions.configFile,
      output: acceptReady.output,
      verbosity: 0,
      loggerName: "accept",
      recordOutput: resolveRecordOutput({
        enabled: acceptOptions.record,
        recordFile: acceptOptions.recordFile,
      }),
      reuseExistingConfig: acceptReady.reuseExistingConfig,
    }),
  ]);

  // The post-handshake config write succeeded on both sides (a failure surfaces
  // here as configWriteError without aborting the exchange).
  expect(inviteResult.configWriteError).toBeUndefined();
  expect(acceptResult.configWriteError).toBeUndefined();

  // -- Both sides derive the same rotated token, with no expiry. --
  const inviteKey = loadKeyFile(inviteOptions.keyFile);
  const acceptKey = loadKeyFile(acceptOptions.keyFile);
  expect(inviteKey?.sharedSecret).toBeDefined();
  expect(inviteKey!.sharedSecret).toMatch(SHARED_SECRET_REGEX);
  // The handshake succeeding at all proves the setup secret threaded through both
  // sides; the rotated value matching proves both derived it from the same key.
  expect(inviteKey!.sharedSecret).toBe(acceptKey?.sharedSecret);
  expect(inviteKey!.expires).toBeUndefined();
  expect(acceptKey!.expires).toBeUndefined();
  // The persisted token is the rotation, not the one-time setup secret.
  expect(inviteKey!.sharedSecret).not.toBe(inviteReady.sharedSecret);

  // -- The PSI intersection is found; both sides learn it (expectsOutput). --
  // The inputs carry only linkage fields (no payload/identifier column), so each
  // side's output is the association table -- "row_id,their_row_id" -- pairing the
  // local matched row index to the partner's. The two matched records (Bob row 0,
  // Carol row 1) appear on both sides; the inviter's extra Dave (row 2) does not.
  // Both files are written concurrently by the two runOnlineBootstrap calls, so
  // poll them concurrently; readStableOutput already pins each to exactly two data
  // rows, so a wrong count fails there with a diagnostic rather than here.
  const [inviteCsv, acceptCsv] = await Promise.all([
    readStableOutput(inviteOut, 2),
    readStableOutput(acceptOut, 2),
  ]);
  const matched = (csv: string): { header: string; pairs: Set<string> } => {
    const lines = csv.trim().split("\n");
    return { header: lines[0], pairs: new Set(lines.slice(1)) };
  };
  const inviteMatched = matched(inviteCsv);
  const acceptMatched = matched(acceptCsv);
  expect(inviteMatched.header).toBe("row_id,their_row_id");
  expect(acceptMatched.header).toBe("row_id,their_row_id");
  // Assert the full association, both columns (local row_id -> partner their_row_id).
  // With the de-symmetrized inputs above the mapping is non-trivial: from the
  // inviter, Bob (row 0) -> accept row 1 and Carol (row 1) -> accept row 2; from
  // the acceptor, Bob (row 1) -> invite row 0 and Carol (row 2) -> invite row 1.
  // The pair sets are transpose-asymmetric, so a swapped or mis-keyed partner
  // index fails here, not just a dropped row. Neither non-matcher (Dave at invite
  // row 2, Zoe at accept row 0) appears, so the intersection filtered both out.
  expect(inviteMatched.pairs).toEqual(new Set(["0,1", "1,2"]));
  expect(acceptMatched.pairs).toEqual(new Set(["1,0", "2,1"]));

  // -- Both config files are written after the exchange (saveConfig-after-
  //    runProtocol), carrying the connection but never the shared secret. --
  for (const cfg of [inviteOptions.configFile, acceptOptions.configFile]) {
    expect(fs.existsSync(cfg)).toBe(true);
    const spec = parseExchangeSpec(YAML.parse(fs.readFileSync(cfg, "utf8")));
    expect(spec.connection.channel).toBe("filedrop");
    expect((spec.connection as FileDropConnectionConfig).path).toBe(
      fileURLToPath(url),
    );
    // The shared secret lives only in the key file. saveConfig persists the bare
    // connection (no authentication), so assert the whole block is absent -- a
    // check on `authentication?.sharedSecret` alone would pass vacuously whether
    // the block was stripped or merely missing that one field.
    expect(spec.connection.authentication).toBeUndefined();
  }

  // -- The default-on audit record lands on disk for both sides. --
  // record defaults to true in the shipped CLI, so a successful online exchange
  // writes a self-attested record plus its private opening file. This is the only
  // layer of the record path nothing else covers end to end: the helpers and the
  // runProtocol write-wiring are unit-tested, and core tests the record building,
  // but only here does a real two-party PSI exchange produce a real audit that is
  // then serialized to disk through the CLI's default. Assert both files exist and
  // the record round-trips as JSON naming this exchange's participants.
  for (const party of [
    {
      recordFile: inviteOptions.recordFile!,
      local: "invite",
      partner: "accept",
    },
    {
      recordFile: acceptOptions.recordFile!,
      local: "accept",
      partner: "invite",
    },
  ]) {
    expect(fs.existsSync(party.recordFile)).toBe(true);
    expect(fs.existsSync(openingPathFor(party.recordFile))).toBe(true);
    const record = JSON.parse(fs.readFileSync(party.recordFile, "utf8")) as {
      version?: unknown;
      localIdentity?: unknown;
      partnerIdentity?: unknown;
    };
    expect(record.version).toBe("psilink-exchange-record/v1");
    expect(record.localIdentity).toBe(party.local);
    expect(record.partnerIdentity).toBe(party.partner);
  }

  // -- Every secret-bearing artifact is written owner-only (0600). --
  // The key files hold the rotated shared secret, a config may hold inline SFTP
  // credentials, and the opening file holds the matched data in plaintext -- all
  // are written via writeFileOwnerOnly / saveKeyFile precisely so group/other
  // cannot read them. Assert that end to end here (this is the only test that
  // produces all four real artifacts at once) so a regression that widened any of
  // their modes is caught, not just one that changed their contents. POSIX-only:
  // writeFileOwnerOnly uses ACLs on Windows, where the mode bits do not reflect it.
  if (process.platform !== "win32") {
    const ownerOnly = [
      inviteOptions.keyFile,
      acceptOptions.keyFile,
      inviteOptions.configFile,
      acceptOptions.configFile,
      inviteOptions.recordFile!,
      acceptOptions.recordFile!,
      openingPathFor(inviteOptions.recordFile!),
      openingPathFor(acceptOptions.recordFile!),
    ];
    for (const f of ownerOnly) expect(fs.statSync(f).mode & 0o077).toBe(0);
  }
}, 60_000);
