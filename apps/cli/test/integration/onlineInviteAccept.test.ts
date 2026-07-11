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
  vi,
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
import { withCapturedLogs } from "@psilink/core/testing";

import {
  resolveInvitePositionals,
  validateInvite,
} from "../../src/commands/invite";
import {
  resolveAcceptPositionals,
  validateAccept,
} from "../../src/commands/accept";
import { runOnlineBootstrap } from "../../src/onlineBootstrap";
import type { CommonBootstrapOptions } from "../../src/optionDefinitions";
import { loadKeyFile } from "../../src/keyFile";
import { keysPathFor, resolveRecordOutput } from "../../src/recordFile";
import { promptConfirm } from "../../src/util/cli";
import { selectedBackend } from "../sftpServer";
import { localPath, remotePath, sftpServer } from "../sftpServer/testContext";

// Stub only promptConfirm so the first-use host-key prompt can be answered in a
// non-interactive test run; every other util/cli export (the input-source loaders
// the validate path uses, etc.) stays real. promptConfirm is the production
// default behind HostKeyTrustDeps.confirm, so stubbing it supplies the same
// first-use confirmation the hostKeyTrust unit layer injects -- here driven
// through the live runOnlineBootstrap chain rather than a direct call.
//
// The stub DECLINES by default and the first-use test opts into confirming only
// for its own run (restoring the decline default afterward). That default matters
// because the stub is file-scoped: besides the host-key trust prompt (reached only
// when unpinned AND interactive, which the first-use test alone arranges),
// accept.ts also calls promptConfirm for the invitation-acceptance prompt with no
// isTTY guard. No current test exercises that accept.ts handler path (they drive
// validateAccept -> runOnlineBootstrap directly), so none reach it -- but an
// always-true default would silently auto-confirm it for a future test that did.
// Declining by default makes such a forgotten stub abort loudly instead.
vi.mock("../../src/util/cli", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/util/cli")>();
  return { ...actual, promptConfirm: vi.fn(async () => false) };
});

// Why this seam and not the yargs handlers: invite/accept's handlers wrap their
// whole body in runOrExit (which calls process.exit on any thrown error) and
// accept blocks on a stdin confirmation prompt -- both make running the two
// parties concurrently in one process unworkable. validate* -> runOnlineBootstrap
// is the exact sequence each handler runs after parsing, minus only the stdout
// token print, the confirm prompt, and the closing log line -- none of which are
// the online wiring under test.

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
    // Poll fast so the online round-trip completes well within the per-test
    // vitest timeouts: the DoS-safe 5s default (DEFAULT_POLLING_FREQUENCY_MS)
    // paces a multi-file rendezvous+exchange too slowly for a CI clock. This is
    // the --polling-frequency override threaded through connectionOverridesFrom
    // as pollIntervalMs, the CLI counterpart of the raw pollingFrequency the
    // other file-sync integration tests set on the connection directly. The
    // warnLowPollingFrequency this trips inside validate* routes to the silenced
    // `log` below, so it emits no console output.
    pollingFrequencyMs: 10,
    record: true,
    recordFile: path.join(work, `${label}-record.json`),
    eventStream: false,
    logLevel: logLibrary.levels.SILENT,
    verbosity: 0,
  };
}

// writeOutput now resolves on the stream's 'finish' and runProtocol awaits it, so
// the output file is fully flushed by the time runProtocol resolves; this poll is
// retained as cheap insurance against filesystem visibility lag. It waits until the
// file holds exactly the expected line count (header + dataRows) AND is byte-stable
// across two reads. On timeout, report the last content seen, so a genuine stall
// (or an unexpected row count) is diagnosable rather than blamed on an empty file.
// Stricter than the sibling authenticatedExchange test's stability-only poll
// because here the exact output shape is known up front.
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
  // The server's host-key fingerprint, supplied for the sftp transport so the
  // built connection is pinned -- the no-pin default is fail-closed, and an
  // sftp:// URL cannot carry the pin. Omitted for filedrop (no host key).
  hostKeyFingerprint?: string;
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
  // Pre-pin the host key on the built sftp connection, standing in for an
  // operator who pinned it out-of-band (the sftp:// URL cannot carry it). With a
  // pin present, runOnlineBootstrap's first-use establishHostKeyTrust is a no-op
  // and the connection proceeds; the pin lands in the persisted config too, since
  // runOnlineBootstrap saves this same connection. The unpinned first-use path is
  // covered separately (the fail-closed test below and the hostKeyTrust unit
  // tests).
  if (
    params.hostKeyFingerprint !== undefined &&
    inviteReady.connection.channel === "sftp"
  )
    inviteReady.connection.server.hostKeyFingerprint =
      params.hostKeyFingerprint;

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
  // Same pre-pin (out-of-band) on the acceptor side; see the inviter note above.
  if (
    params.hostKeyFingerprint !== undefined &&
    acceptReady.connection.channel === "sftp"
  )
    acceptReady.connection.server.hostKeyFingerprint =
      params.hostKeyFingerprint;

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
  // writes a self-attested record plus its private verification-keys file. This is the only
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
    expect(fs.existsSync(keysPathFor(party.recordFile))).toBe(true);
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
  // credentials, and the verification-keys file holds private commitment salts --
  // all are written via writeFileOwnerOnly / saveKeyFile precisely so group/other
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
      keysPathFor(inviteOptions.recordFile!),
      keysPathFor(acceptOptions.recordFile!),
    ];
    for (const f of ownerOnly) expect(fs.statSync(f).mode & 0o077).toBe(0);
  }
}

// Assert that a failed online run left NO artifact at any path the run was
// configured to write. This is the security-relevant invariant the failure-path
// tests turn on: a rejected invitation or handshake must not leave a
// half-provisioned recurring-exchange setup on disk. The config and key are the
// artifacts a failure could most plausibly orphan; the audit record and its
// private verification keys are written only after a successful exchange, so asserting them
// absent pins that a failure writes no audit either -- vacuously true on the
// accept-side rejections (validateAccept writes nothing), but a real check on the
// mismatch test, where a live handshake aborts with recording enabled.
function expectNoPersistedFiles(options: CommonBootstrapOptions): void {
  expect(fs.existsSync(options.configFile)).toBe(false);
  expect(fs.existsSync(options.keyFile)).toBe(false);
  expect(fs.existsSync(options.recordFile!)).toBe(false);
  expect(fs.existsSync(keysPathFor(options.recordFile!))).toBe(false);
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
  // Both sides abort mid-handshake with their token un-rotated, so each emits a
  // "key exchange was in progress" recovery advisory at ERROR. Run them under
  // withCapturedLogs so those intended lines are captured for assertion below
  // rather than leaked to the suite console. The natural "invite"/"accept" names
  // are safe to reuse even though the happy-path test above already created those
  // loggers: the integration setup installs the withCapturedLogs interceptor
  // eagerly (capturedLogs.setup.ts), so a logger binds to capture regardless of
  // when it was first materialized.
  const [[inviteOutcome, acceptOutcome], capturedLogs] = await withCapturedLogs(
    () =>
      Promise.allSettled([
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
      ]),
    (level) => level === "WARN" || level === "ERROR",
  );

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

  // Both sides' aborted handshakes emit the "key exchange was in progress"
  // recovery advisory at ERROR -- the only intended WARN/ERROR of this run.
  // Asserting the captured set proves intent (each is the known advisory) and
  // guards against a genuine, unexpected error being suppressed unseen.
  const advisories = capturedLogs.map((l) => l.message);
  expect(advisories).toHaveLength(2);
  for (const message of advisories) {
    expect(message).toContain(
      "The key exchange was in progress when this error occurred.",
    );
  }
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
        hostKeyFingerprint: srv.hostKeyFingerprint,
        assertPersistedConnection: (spec) => {
          expect(spec.connection.channel).toBe("sftp");
          const server = (spec.connection as SFTPConnectionConfig).server;
          // The first-use pin is persisted into the saved config.
          expect(server.hostKeyFingerprint).toBe(srv.hostKeyFingerprint);
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

  inProcessOnly(
    "sftp: a first-use online invite + accept over an unpinned server prompts, confirms, and persists the live host key into both saved configs",
    async () => {
      // The seam this guards. With no pin on the built connection (an sftp:// URL
      // cannot carry a host_key_fingerprint), runOnlineBootstrap's first-use
      // establishHostKeyTrust fires: it probes the live server for its real host
      // key, the operator confirms, and the captured fingerprint -- mutated into
      // the ORIGINAL connection, which runOnlineBootstrap then clones for the live
      // connect -- must flow through the post-handshake saveConfig and land on
      // disk as connection.server.host_key_fingerprint. The sibling round-trip
      // pre-pins out-of-band so establishHostKeyTrust no-ops there; this drives the
      // composed prompt-to-saved-config chain that one deliberately skips, so a
      // regression breaking the pin-reaches-saveConfig wiring (but not the
      // credential, which the round-trip already threads) cannot pass CI green.
      const tag = "firstuse";
      // Create the served host directory before either party connects (the
      // connection does not create remote dirs), mirroring the round-trip above.
      await fsp.mkdir(path.join(SFTP_LOCAL_ROOT, tag), { recursive: true });
      const serverPath = `${SFTP_PATH_ROOT}/${tag}`;
      // The sftp:// URL carries the inline credentials and the server path but no
      // host key -- exactly the realistic first-use input.
      const url = `sftp://${srv.usera.username}:${srv.usera.password}@${srv.host}:${srv.port}${serverPath}`;

      const inviteInput = path.join(work, "fu-invite.csv");
      fs.writeFileSync(inviteInput, INVITE_CSV);
      const acceptInput = path.join(work, "fu-accept.csv");
      fs.writeFileSync(acceptInput, ACCEPT_CSV);
      const inviteOptions = testOptions("fu-invite");
      const acceptOptions = testOptions("fu-accept");
      const inviteOut = path.join(work, "fu-invite-out.csv");
      const acceptOut = path.join(work, "fu-accept-out.csv");

      // Validate builds each side's connection from the URL (the no-network half);
      // neither carries a pin.
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
      // A fresh config will be written, so the pin lands via save-with-config (the
      // post-handshake saveConfig), not an in-place write-now.
      expect(acceptReady.reuseExistingConfig).toBe(false);

      // Both connections enter the bootstrap UNPINNED, so a fingerprint in the
      // saved config below can only have been captured by the live first-use
      // probe, never a pre-seeded value -- the invariant this whole test turns on.
      expect(inviteReady.connection.channel).toBe("sftp");
      if (inviteReady.connection.channel === "sftp")
        expect(
          inviteReady.connection.server.hostKeyFingerprint,
        ).toBeUndefined();
      expect(acceptReady.connection.channel).toBe("sftp");
      if (acceptReady.connection.channel === "sftp")
        expect(
          acceptReady.connection.server.hostKeyFingerprint,
        ).toBeUndefined();

      // Make the run interactive and answer the first-use prompt yes: isTTY gates
      // establishHostKeyTrust's prompt (it fails closed otherwise, per the
      // fail-closed test below), and the file-scoped promptConfirm stub (declines
      // by default) is set to confirm for this run only -- both restored in the
      // finally. Everything else -- the probe that reads the server's real key, the
      // in-place mutation, the clone for the live connect, the handshake, and the
      // post-handshake saveConfig -- runs live. Each side emits one "authenticity
      // of host ... cannot be established" WARN carrying the presented fingerprint;
      // capture WARNs so they are asserted rather than leaked to the suite console
      // (capture binds regardless of when these loggers were first materialized,
      // because the integration setup installs the interceptor eagerly). The isTTY
      // and stub mutations are set inside the try so the finally rolls both back
      // even if a setup step throws.
      const originalIsTTY = process.stdin.isTTY;
      try {
        process.stdin.isTTY = true;
        vi.mocked(promptConfirm).mockClear();
        vi.mocked(promptConfirm).mockResolvedValue(true);
        const [[inviteResult, acceptResult], capturedLogs] =
          await withCapturedLogs(
            () =>
              Promise.all([
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
                  loggerName: "fu-invite",
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
                  loggerName: "fu-accept",
                  reuseExistingConfig: acceptReady.reuseExistingConfig,
                }),
              ]),
            (level) => level === "WARN",
          );

        // saveConfig fired on both sides (a write failure surfaces here as
        // configWriteError rather than aborting the completed exchange).
        expect(inviteResult.configWriteError).toBeUndefined();
        expect(acceptResult.configWriteError).toBeUndefined();

        // First-use actually fired on both sides: the prompt is reached only past
        // the unpinned + interactive gate and the live probe, so two confirms
        // prove the composed chain ran rather than no-opping on a present pin.
        expect(vi.mocked(promptConfirm)).toHaveBeenCalledTimes(2);

        // Two first-use authenticity notices, one per side, each carrying the live
        // server's real fingerprint -- the captured pin observed before it reaches
        // disk. Filter to the notices rather than asserting the total captured
        // count: withCapturedLogs intercepts every WARN process-wide for the
        // window, so an unrelated WARN from elsewhere would inflate a bare length
        // check and fail this spuriously.
        const firstUseWarnings = capturedLogs.filter((l) =>
          l.message.includes("authenticity of host"),
        );
        expect(firstUseWarnings).toHaveLength(2);
        for (const { message } of firstUseWarnings)
          expect(message).toContain(srv.hostKeyFingerprint);

        // The captured pin reached the saved config on BOTH sides and is the live
        // server's real fingerprint: the mutation flowed original -> clone ->
        // post-handshake saveConfig. The assertion is on the persisted config
        // produced by the live run, not a pre-seeded value, so it fails if the
        // captured pin does not reach saveConfig -- the wiring this test pins.
        for (const cfg of [
          inviteOptions.configFile,
          acceptOptions.configFile,
        ]) {
          expect(fs.existsSync(cfg)).toBe(true);
          const spec = parseExchangeSpec(
            YAML.parse(fs.readFileSync(cfg, "utf8")),
          );
          expect(spec.connection.channel).toBe("sftp");
          expect(
            (spec.connection as SFTPConnectionConfig).server.hostKeyFingerprint,
          ).toBe(srv.hostKeyFingerprint);
        }

        // Every secret-bearing artifact this first-use run wrote is owner-only
        // (0600): the saved configs carry the inline SFTP password threaded
        // through the URL (alongside the just-pinned fingerprint), and the key
        // files hold the rotated shared secret. They are written via
        // writeFileOwnerOnly / saveKeyFile precisely so group/other cannot read
        // them; pin that here too, so the first-use persist path is not merely
        // assumed to inherit the sibling round-trip's permission guarantee.
        // POSIX-only: writeFileOwnerOnly uses ACLs on Windows, where the mode bits
        // do not reflect it.
        if (process.platform !== "win32")
          for (const f of [
            inviteOptions.configFile,
            acceptOptions.configFile,
            inviteOptions.keyFile,
            acceptOptions.keyFile,
          ])
            expect(fs.statSync(f).mode & 0o077).toBe(0);
      } finally {
        process.stdin.isTTY = originalIsTTY;
        // Restore the decline default so no later test inherits an auto-confirm.
        vi.mocked(promptConfirm).mockResolvedValue(false);
      }
    },
    90_000,
  );

  inProcessOnly(
    "sftp: a non-interactive online accept over an unpinned server fails closed before any handshake",
    async () => {
      const serverPath = `${SFTP_PATH_ROOT}/failclosed`;
      const url = `sftp://${srv.usera.username}:${srv.usera.password}@${srv.host}:${srv.port}${serverPath}`;

      const inviteInput = path.join(work, "fc-invite.csv");
      fs.writeFileSync(inviteInput, INVITE_CSV);
      const acceptInput = path.join(work, "fc-accept.csv");
      fs.writeFileSync(acceptInput, ACCEPT_CSV);
      const acceptOptions = testOptions("fc-accept");

      // Mint an invitation and build the acceptor's connection (the no-network
      // validate half); the acceptor's connection carries NO host_key_fingerprint.
      const inviteReady = await validateInvite({
        resolved: resolveInvitePositionals([
          url,
          inviteInput,
          path.join(work, "fc-invite-out.csv"),
        ]),
        options: testOptions("fc-invite"),
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
          path.join(work, "fc-accept-out.csv"),
        ]),
        options: acceptOptions,
        log,
      });
      expect(acceptReady.mode).toBe("online");
      if (acceptReady.mode !== "online") return;

      // No pin and a non-interactive run: runOnlineBootstrap fails closed at
      // first-use trust, BEFORE the probe or any handshake (so no inviter peer is
      // needed). This proves the online path is wired to establishHostKeyTrust;
      // the prompt/persist behavior itself is covered by the hostKeyTrust unit
      // tests.
      await expect(
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
          reuseExistingConfig: acceptReady.reuseExistingConfig,
        }),
      ).rejects.toThrow(/host_key_fingerprint|interactive/i);

      // Failing closed before the handshake persists nothing on the acceptor.
      expect(fs.existsSync(acceptOptions.configFile)).toBe(false);
      expect(fs.existsSync(acceptOptions.keyFile)).toBe(false);
    },
    30_000,
  );
});
