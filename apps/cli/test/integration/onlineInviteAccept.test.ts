import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import logLibrary from "loglevel";
import YAML from "yaml";
import {
  getLogger,
  parseExchangeSpec,
  SHARED_SECRET_REGEX,
} from "@psilink/core";
import type {
  ExchangeSpec,
  FileDropConnectionConfig,
  SFTPConnectionConfig,
} from "@psilink/core";

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
import { selectedBackend } from "../sftpServer";
import { localPath, remotePath, sftpServer } from "../sftpServer/testContext";

// Net-new coverage: the ONLINE invite + accept wiring, end to end, with both
// sides on their real online code path (a live authenticated handshake, not the
// offline path). The sibling authenticatedExchange.test.ts drives runProtocol
// directly; this file drives one level up -- validateInvite/validateAccept ->
// runOnlineBootstrap -- so the assertions cover exactly the untested delta:
// building the connection from a URL (connectionFromURL), threading the shared
// secret from the minted invitation through the handshake on both sides, and the
// saveConfig-after-runProtocol persistence (the onAuthenticated hook) actually
// firing for both invite and accept.
//
// Why this seam and not the yargs handlers: invite/accept's handlers wrap their
// whole body in runOrExit (which calls process.exit on any thrown error) and
// accept blocks on a stdin confirmation prompt -- both make running the two
// parties concurrently in one process unworkable. validate* -> runOnlineBootstrap
// is the exact sequence each handler runs after parsing (invite.ts handler;
// accept.ts handler), minus only the stdout token print, the confirm prompt, and
// the closing log line -- none of which are the online wiring under test.
//
// This file covers two concerns over that one seam:
//   1. The happy-path round trip, run over BOTH transports for parity --
//      `filedrop` (a file:// URL over a local directory) and `sftp` (the real
//      SFTP test server). The shared runOnlineRoundTrip helper makes the two
//      genuinely mirror each other: the assertions are identical and only the URL
//      and the persisted connection-block shape differ. The sftp run is the only
//      place credential and server-path threading through connectionFromURL is
//      exercised end to end (the filedrop transport carries neither).
//   2. The end-to-end failure paths -- an EXPIRED invitation, a TAMPERED one, and
//      a shared-secret MISMATCH -- each asserting the security-relevant invariant
//      that a rejected exchange persists NO config file and NO key file on the
//      affected side(s). Unit coverage of decodeAndValidateInvitation /
//      authenticateConnection already exists; these assert the no-write guarantee
//      at the integration level, where the real validate/handshake code decides
//      whether anything reaches disk.
//
// The CLI integration suite is self-managing: a vitest globalSetup starts the
// SFTP test server before the suite and stops it after. Run with `npm run
// test:integration -w apps/cli`.

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
// via options.peerTimeout -- well under the per-test vitest timeouts below, so a
// genuine stall fails fast with a clean peer-timeout error instead of racing the
// framework's kill. This matters because core's default peer timeout is one hour
// (DEFAULT_PEER_TIMEOUT_MS), which would otherwise leave a hung acceptor waiting
// far past the test timeout. Both the happy path and the mismatch handshake
// resolve in a few seconds, so the value is pure safety margin, not a tuning knob.
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

// The de-symmetrized inputs the happy-path round trip uses on both transports.
// Each side carries a non-matching row -- the inviter's Dave (row 2), the
// acceptor's Zoe (row 0) -- so the output proves the PSI filters on both sides
// rather than echoing every record. The two non-matchers sit at deliberately
// different positions so the shared records land at different local indices on
// each side (Bob at invite row 0 / accept row 1; Carol at invite row 1 / accept
// row 2). That makes the association table asymmetric, so the assertions below
// pin the actual local->partner mapping, not merely which rows matched: a bug
// that swapped or mis-keyed the partner index would change the pairs.
// Intersection: Bob, Carol.
const INVITE_CSV =
  "first_name,last_name,date_of_birth\n" +
  "Bob,Jones,1990-01-02\n" +
  "Carol,Lee,1985-07-16\n" +
  "Dave,Kim,1978-11-30\n";
const ACCEPT_CSV =
  "first_name,last_name,date_of_birth\n" +
  "Zoe,Adams,2001-03-03\n" +
  "Bob,Jones,1990-01-02\n" +
  "Carol,Lee,1985-07-16\n";

/**
 * The full happy-path online invite + accept round trip over one transport,
 * with all the assertions that prove the exchange authenticated, found the
 * intersection, rotated the token, and persisted both configs and audit
 * records. Everything here is transport-agnostic; the two transport-specific
 * inputs are passed in:
 *
 * - `url`: the server URL each party would put on the command line (the
 *   filedrop `file://` directory or the sftp `sftp://...` server path).
 * - `assertPersistedConnection`: checks the connection block each side persisted,
 *   which differs per transport (filedrop persists a `path`; sftp persists a
 *   `server` block, including the credentials and path threaded from the URL).
 *
 * The shared-secret-stripped check (`spec.authentication` undefined) is asserted
 * here because it must hold identically on every transport.
 */
async function runOnlineRoundTrip(params: {
  url: string;
  assertPersistedConnection: (spec: ExchangeSpec) => void;
}): Promise<void> {
  const { url, assertPersistedConnection } = params;

  const inviteInput = path.join(work, "invite-input.csv");
  fs.writeFileSync(inviteInput, INVITE_CSV);
  const acceptInput = path.join(work, "accept-input.csv");
  fs.writeFileSync(acceptInput, ACCEPT_CSV);

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
  // the shared rendezvous, then the PSI exchange, then the saveConfig hook. This
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
    // The connection block is the one transport-specific persisted shape.
    assertPersistedConnection(spec);
    // The shared secret lives only in the key file. saveConfig persists no
    // authentication block (it strips the injected fields and prunes the empty
    // container), so assert the whole top-level block is absent -- a check on
    // `authentication?.sharedSecret` alone would pass vacuously whether the block
    // was stripped or merely missing that one field.
    expect(spec.authentication).toBeUndefined();
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
  // cannot read them. Assert that end to end here so a regression that widened any
  // of their modes is caught, not just one that changed their contents. POSIX-only:
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
}

// Assert that a failed online run left NO artifact at any path the run was
// configured to write. This is the security-relevant invariant the failure-path
// tests turn on: a rejected invitation or handshake must not leave a
// half-provisioned recurring-exchange setup on disk. The config and key are the
// artifacts a failure could most plausibly orphan; the audit record and its
// private opening are written only after a successful exchange, so asserting them
// absent pins that a failure writes no audit either -- vacuously true on the
// accept-side rejections (validateAccept writes nothing), but a real check on the
// mismatch test, where a live handshake aborts with recording enabled.
function expectNoPersistedFiles(options: CommonBootstrapOptions): void {
  expect(fs.existsSync(options.configFile)).toBe(false);
  expect(fs.existsSync(options.keyFile)).toBe(false);
  expect(fs.existsSync(options.recordFile!)).toBe(false);
  expect(fs.existsSync(openingPathFor(options.recordFile!))).toBe(false);
}

// --- Happy path: filedrop -----------------------------------------------------

test("filedrop: online invite + accept round-trip authenticates, finds the intersection, rotates the token, and persists both configs and audit records", async () => {
  // Both parties meet at the same file-drop directory; the URL is what each would
  // pass on the command line (psilink invite/accept <URL> ...).
  const dropDir = fs.mkdtempSync(path.join(work, "drop-"));
  const url = pathToFileURL(dropDir).href;

  await runOnlineRoundTrip({
    url,
    assertPersistedConnection: (spec) => {
      expect(spec.connection.channel).toBe("filedrop");
      expect((spec.connection as FileDropConnectionConfig).path).toBe(
        fileURLToPath(url),
      );
    },
  });
}, 60_000);

// --- Failure paths: filedrop --------------------------------------------------
//
// The security-relevant invariant across all three is expectNoPersistedFiles: a
// rejected invitation or handshake writes neither a config nor a key file. These
// drive the real online code path (validateInvite/validateAccept ->
// runOnlineBootstrap) and assert the observable no-write outcome rather than
// reaching into internals. filedrop is enough for the no-write guarantee: it is
// decided by validate-time rejection and by the handshake, neither of which is
// transport-specific, so the real SFTP server buys nothing here.

test("filedrop: an expired invitation aborts the accept and the inviter's handshake, persisting no config or key on either side", async () => {
  const dropDir = fs.mkdtempSync(path.join(work, "drop-"));
  const url = pathToFileURL(dropDir).href;
  const inviteInput = path.join(work, "invite-input.csv");
  fs.writeFileSync(inviteInput, INVITE_CSV);
  const acceptInput = path.join(work, "accept-input.csv");
  fs.writeFileSync(acceptInput, ACCEPT_CSV);

  const inviteOptions = testOptions("invite");
  const acceptOptions = testOptions("accept");

  // Mint a real invitation with a 1-second lifetime, then let it lapse. encodeInvitation
  // refuses to mint an already-past expiry (an inviter never issues a dead token),
  // so a real elapse -- not a hand-forged past timestamp -- is how an expired
  // invitation actually arises: it was valid when issued and went stale before the
  // partner accepted. The wait is wall-clock relative to the mint, so it is
  // deterministic regardless of machine speed.
  const inviteReady = await validateInvite({
    resolved: resolveInvitePositionals([url, inviteInput]),
    options: inviteOptions,
    // A short accept timeout, not PEER_TIMEOUT_SECONDS: the inviter is rejected by
    // the pre-handshake guard before any connection opens, so this never elapses
    // on the happy path -- but if that guard ever regressed and the inviter reached
    // the peerless rendezvous, this bounds the stall to a fast, clean failure (a
    // non-/expired/ rejection well within the test timeout) rather than racing it.
    acceptTimeout: 5,
    expiresIn: "1s",
    log,
  });
  expect(inviteReady.mode).toBe("online");
  if (inviteReady.mode !== "online") return;
  const expiresMs = new Date(inviteReady.expires).getTime();
  await new Promise<void>((r) =>
    setTimeout(r, Math.max(0, expiresMs - Date.now()) + 200),
  );

  // Accept side: decodeAndValidateInvitation rejects the expired token before any
  // connection, prompt, or write -- the accept aborts at validation.
  await expect(
    validateAccept({
      resolved: resolveAcceptPositionals([
        url,
        inviteReady.invitation,
        acceptInput,
      ]),
      options: acceptOptions,
      log,
    }),
  ).rejects.toThrow(/expired/i);
  expectNoPersistedFiles(acceptOptions);

  // Invite side observes the same early invalidation: runOnlineBootstrap's
  // pre-handshake guard (assertSharedSecretReadyForHandshake) rejects the past
  // `expires` before opening any connection, so the inviter never reaches the key
  // save or the config-writing hook.
  await expect(
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
    }),
  ).rejects.toThrow(/expired/i);
  expectNoPersistedFiles(inviteOptions);
}, 30_000);

test("filedrop: a tampered invitation is rejected at accept validation, persisting no config or key", async () => {
  const dropDir = fs.mkdtempSync(path.join(work, "drop-"));
  const url = pathToFileURL(dropDir).href;
  const inviteInput = path.join(work, "invite-input.csv");
  fs.writeFileSync(inviteInput, INVITE_CSV);
  const acceptInput = path.join(work, "accept-input.csv");
  fs.writeFileSync(acceptInput, ACCEPT_CSV);

  const inviteOptions = testOptions("invite");
  const acceptOptions = testOptions("accept");

  // Mint a genuine invitation, then corrupt one character in its body (before the
  // trailing 6-char checksum). Both characters are valid base64url, so the string
  // still decodes -- but the recomputed checksum no longer matches the stored one,
  // so decodeInvitation rejects it. This models in-transit corruption of an
  // otherwise valid invitation, the case the checksum exists to catch.
  const inviteReady = await validateInvite({
    resolved: resolveInvitePositionals([url, inviteInput]),
    options: inviteOptions,
    acceptTimeout: PEER_TIMEOUT_SECONDS,
    log,
  });
  expect(inviteReady.mode).toBe("online");
  if (inviteReady.mode !== "online") return;
  const valid = inviteReady.invitation;
  const i = Math.floor(valid.length / 2);
  const tampered =
    valid.slice(0, i) + (valid[i] === "A" ? "B" : "A") + valid.slice(i + 1);
  expect(tampered).not.toBe(valid);

  await expect(
    validateAccept({
      resolved: resolveAcceptPositionals([url, tampered, acceptInput]),
      options: acceptOptions,
      log,
    }),
  ).rejects.toThrow(/invalid invitation/i);
  expectNoPersistedFiles(acceptOptions);
  // Tampering is an in-transit corruption only the acceptor sees, so this is an
  // accept-side rejection -- but the inviter still ran validateInvite to mint the
  // (valid) invitation, which is the no-commit phase. Assert it persisted nothing
  // either, so a future change that made minting write a file would not slip past
  // this scenario.
  expectNoPersistedFiles(inviteOptions);
}, 30_000);

test("filedrop: a shared-secret mismatch aborts the handshake, persisting no config or key on either side", async () => {
  const dropDir = fs.mkdtempSync(path.join(work, "drop-"));
  const url = pathToFileURL(dropDir).href;
  const inviteInput = path.join(work, "invite-input.csv");
  fs.writeFileSync(inviteInput, INVITE_CSV);
  const acceptInput = path.join(work, "accept-input.csv");
  fs.writeFileSync(acceptInput, ACCEPT_CSV);

  const inviteOptions = testOptions("invite");
  const acceptOptions = testOptions("accept");
  const inviteOut = path.join(work, "invite-out.csv");
  const acceptOut = path.join(work, "accept-out.csv");

  const inviteReady = await validateInvite({
    resolved: resolveInvitePositionals([url, inviteInput, inviteOut]),
    options: inviteOptions,
    acceptTimeout: PEER_TIMEOUT_SECONDS,
    log,
  });
  expect(inviteReady.mode).toBe("online");
  if (inviteReady.mode !== "online") return;
  const acceptReady = await validateAccept({
    resolved: resolveAcceptPositionals([
      url,
      inviteReady.invitation,
      acceptInput,
      acceptOut,
    ]),
    options: acceptOptions,
    log,
  });
  expect(acceptReady.mode).toBe("online");
  if (acceptReady.mode !== "online") return;

  // The acceptor runs with a different (but well-formed) secret than the inviter
  // minted, so both pass the pre-handshake format/expiry guard and actually meet
  // at the rendezvous, but the NNpsk0 key confirmation fails: the initiator
  // rejects the responder's tag and sends an abort, the responder receives it, and
  // both throw the generic authentication failure. Derive the wrong secret by
  // flipping the inviter's first character -- a free base64url position, since
  // SHARED_SECRET_REGEX constrains only the final one -- so the mismatch is
  // structural (a guaranteed-different yet still well-formed 32-byte secret) rather
  // than the probabilistic "two random secrets happened to differ", and it is
  // well-formed enough to reach the handshake instead of tripping the format guard.
  const minted = inviteReady.sharedSecret;
  const wrongSecret = (minted[0] === "A" ? "B" : "A") + minted.slice(1);
  expect(wrongSecret).not.toBe(minted);
  expect(wrongSecret).toMatch(SHARED_SECRET_REGEX);

  // Both sides enable recording (recordOutput) and pass an output path, exactly as
  // the happy path does, so the no-write assertions below are exercised against a
  // run that WOULD write an audit record and an output table on success: a failed
  // handshake must still produce neither. Both artifacts are written only after the
  // exchange completes (writeOutput / writeExchangeRecord), which an aborted
  // handshake never reaches, so this pins that nothing partial leaks on failure.
  const [inviteOutcome, acceptOutcome] = await Promise.allSettled([
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
      sharedSecret: wrongSecret,
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

  // The handshake aborts on both sides: neither saves the rotated key, so neither
  // fires the config-writing hook. No key, no config, on either side. Pin each
  // rejection to a key-exchange-layer failure rather than accepting any rejection,
  // so a spurious transport/connection error or a pre-handshake-guard rejection
  // cannot pass for the mismatch under test. The initiator throws the generic "key
  // exchange authentication failed" on the bad confirm tag; the responder throws
  // the same after receiving the abort, or "key exchange handshake timed out" if
  // the best-effort abort write is lost -- both share the "key exchange" prefix.
  for (const outcome of [inviteOutcome, acceptOutcome]) {
    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") continue;
    const message =
      outcome.reason instanceof Error
        ? outcome.reason.message
        : String(outcome.reason);
    expect(message).toMatch(/key exchange/i);
  }
  expectNoPersistedFiles(inviteOptions);
  expectNoPersistedFiles(acceptOptions);
  // The output table is written only after the exchange runs, so an aborted
  // handshake leaves neither side's output file behind (the output path is not in
  // CommonBootstrapOptions, so it is checked here rather than in the helper).
  expect(fs.existsSync(inviteOut)).toBe(false);
  expect(fs.existsSync(acceptOut)).toBe(false);
}, 60_000);

// --- Happy path: sftp ---------------------------------------------------------

// Grouped so the rendezvous-root lifecycle hooks below scope to the SFTP test
// alone; file-scoped beforeAll/afterAll would otherwise also bracket the filedrop
// tests above, which have no business with the SFTP root.
describe("sftp", () => {
  const srv = sftpServer();
  // This leg threads inline user:password credentials through an sftp:// URL,
  // which the password-authenticating in-process backend supports; the native
  // sshd backend authenticates by public key (a URL cannot carry a key), so it
  // runs in-process only.
  const inProcessOnly = test.skipIf(selectedBackend() !== "in-process");

  // Both parties are SFTP clients of the same served path -- the realistic
  // recurring-exchange topology. The `onlineinvite` namespace keeps this root
  // distinct from the sibling integration files' namespaces (authexchange, sftp,
  // mixed).
  const SFTP_LOCAL_ROOT = localPath(srv, "onlineinvite");
  const SFTP_PATH_ROOT = remotePath(srv, "onlineinvite");

  // Start from a clean root so stale files from a previously crashed run cannot
  // leak in; afterAll leaves the served dir tidy.
  beforeAll(async () => {
    await fsp.rm(SFTP_LOCAL_ROOT, { recursive: true, force: true });
    await fsp.mkdir(SFTP_LOCAL_ROOT, { recursive: true });
  });

  afterAll(async () => {
    await fsp.rm(SFTP_LOCAL_ROOT, { recursive: true, force: true });
  });

  inProcessOnly(
    "sftp: online invite + accept round-trip over the real server mirrors the filedrop result and threads credentials and the server path through the URL",
    async () => {
      const tag = "roundtrip";
      // Create the host directory the server serves so the SFTP path exists
      // before either party connects (the connection does not create remote dirs).
      await fsp.mkdir(path.join(SFTP_LOCAL_ROOT, tag), { recursive: true });
      const serverPath = `${SFTP_PATH_ROOT}/${tag}`;
      // The inline credentials and the server path are exactly what
      // connectionFromURL must parse and thread into the live SFTP connection and
      // the persisted config -- the net-new wiring the filedrop transport never
      // touches.
      const url = `sftp://${srv.usera.username}:${srv.usera.password}@${srv.host}:${srv.port}${serverPath}`;

      await runOnlineRoundTrip({
        url,
        assertPersistedConnection: (spec) => {
          expect(spec.connection.channel).toBe("sftp");
          const server = (spec.connection as SFTPConnectionConfig).server;
          // host/port/path/credentials were all carried from the URL through
          // connectionFromURL into the persisted config (saveConfig keeps inline
          // connection credentials, protected at 0600, and strips only the shared
          // secret).
          expect(server.host).toBe(srv.host);
          expect(server.port).toBe(srv.port);
          expect(server.path).toBe(serverPath);
          expect(server.username).toBe(srv.usera.username);
          expect(server.password).toBe(srv.usera.password);
        },
      });
    },
    90_000,
  );
});
