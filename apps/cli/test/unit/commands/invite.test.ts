import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, test, vi } from "vitest";
import type { Arguments } from "yargs";
import logLibrary from "loglevel";
import YAML from "yaml";
import {
  decodeInvitation,
  DEFAULT_PEER_TIMEOUT_MS,
  DEFAULT_POLLING_FREQUENCY_MS,
  disclosedColumnNames,
  getDefaultLinkageTerms,
  getLogger,
  inferMetadata,
  LinkageTermsUnsatisfiableError,
  MAX_NAME_LENGTH,
  OperatorConfigError,
  sanitizeErrorForDisplay,
  StandardizationTermsError,
  UsageError,
} from "@psilink/core";
import type {
  Algorithm,
  ConnectionConfig,
  LinkageTerms,
  Metadata,
  Standardization,
} from "@psilink/core";

// Mock only runOnlineBootstrap, so the online-handler wiring can be asserted
// without opening a connection or running a real exchange; every other
// onlineBootstrap export (connectionFromEndpoint, logOnlineBootstrapOutcome, and
// the buildDataSpec/prepareForOnlineExchange chain validateInvite drives) is the
// genuine implementation.
vi.mock("../../../src/onlineBootstrap", async () => {
  const actual = await vi.importActual<
    typeof import("../../../src/onlineBootstrap")
  >("../../../src/onlineBootstrap");
  return { ...actual, runOnlineBootstrap: vi.fn() };
});

// Wrap loadConfigLinkageSource as a PASSTHROUGH spy, leaving every other config
// export (saveConfig included) genuine: each test below reads its real config
// file, and only the algorithm-gate case replaces the read for one call --
// AlgorithmSchema admits exactly the implemented pair today, so only this
// substitution reaches the gate at all, for the member added to the enum ahead
// of its run path.
vi.mock("../../../src/config", async () => {
  const actual = await vi.importActual<typeof import("../../../src/config")>(
    "../../../src/config",
  );
  return {
    ...actual,
    loadConfigLinkageSource: vi.fn(actual.loadConfigLinkageSource),
  };
});

import {
  handler as inviteHandler,
  offlineAbandonNotice,
  onlineWaitInvalidationNotice,
  persistedPeerBudgetNotice,
  resolveInvitePositionals,
  validateInvite,
} from "../../../src/commands/invite";
import { loadConfigLinkageSource, saveConfig } from "../../../src/config";
import {
  CONNECTION_BLOCK_DOC_URL,
  CONNECTION_BLOCK_NOTICE,
} from "../../../src/connectionGuidance";
import { DEFAULT_WEBRTC_INACTIVITY_TIMEOUT_MS } from "../../../src/connection/webrtc/webrtcMessageConnection";
import {
  DEFAULT_CHANNEL_OPEN_TIMEOUT_MS,
  DEFAULT_RENDEZVOUS_TIMEOUT_MS,
} from "../../../src/connection/webrtc/weriftPeer";
import { MAX_TIMEOUT_SECONDS } from "../../../src/util/flags";
import {
  connectionFromEndpoint,
  runOnlineBootstrap,
} from "../../../src/onlineBootstrap";
import { captureStdio } from "../../loggingTestSupport";
import {
  configuredIdentityRequired,
  configuredIdentityStillPlaceholder,
  IDENTITY_REQUIRED,
  PLACEHOLDER_IDENTITY,
} from "../../../src/partyIdentity";
import type { CommonBootstrapOptions } from "../../../src/optionDefinitions";

const silentLog = getLogger("invite-test");
silentLog.setLevel("silent");

let optionsCounter = 0;
// Minimal options pointing config/key at fresh, non-existent temp paths so the
// conflict gate passes and validateInvite reaches the step under test. The
// identity is part of that minimum: every run mints terms holding one, and a
// run without it stops at the identity gate before the step under test.
function testOptions(
  overrides: Partial<CommonBootstrapOptions> = {},
): CommonBootstrapOptions {
  const id = `${process.pid}-${optionsCounter++}`;
  return {
    configFile: path.join(tmpdir(), `psilink-invite-test-${id}.yaml`),
    keyFile: path.join(tmpdir(), `psilink-invite-test-${id}.key`),
    identity: "Agency A",
    record: false,
    eventStream: false,
    logLevel: logLibrary.levels.SILENT,
    verbosity: 0,
    ...overrides,
  };
}

// --- offline vs online dispatch ----------------------------------------------

test("no positionals dispatches offline with no input file", () => {
  const r = resolveInvitePositionals([]);
  expect(r.mode).toBe("offline");
  if (r.mode !== "offline") return;
  expect(r.input).toBeUndefined();
});

test("a lone input file dispatches offline", () => {
  const r = resolveInvitePositionals(["input.csv"]);
  expect(r.mode).toBe("offline");
  if (r.mode !== "offline") return;
  expect(r.input).toBe("input.csv");
});

test("a leading URL dispatches online with input and output", () => {
  const r = resolveInvitePositionals([
    "sftp://host/drop",
    "input.csv",
    "out.csv",
  ]);
  expect(r.mode).toBe("online");
  if (r.mode !== "online") return;
  expect(r.url.hostname).toBe("host");
  expect(r.input).toBe("input.csv");
  expect(r.output).toBe("out.csv");
});

test("an online invitation without an input file is a usage error", () => {
  expect(() => resolveInvitePositionals(["sftp://host/drop"])).toThrow(
    UsageError,
  );
  expect(() => resolveInvitePositionals(["sftp://host/drop"])).toThrow(
    "requires an input file",
  );
});

test("a `-`-leading positional is kept as the offline input file", () => {
  // The unknown-option check rejects only `--`-prefixed tokens, so a single-`-`
  // positional (an unusual input path, or `-` for stdin) reaches the resolver
  // unchanged.
  const r = resolveInvitePositionals(["-not-a-flag.csv"]);
  expect(r.mode).toBe("offline");
  if (r.mode !== "offline") return;
  expect(r.input).toBe("-not-a-flag.csv");
});

// --- validateInvite (the no-commit phase) ------------------------------------

test("validateInvite: an unusable URL is rejected with no side effect", async () => {
  // A ws:/wss: URL names where the coordination server is and nothing else;
  // an API key or user on it would otherwise be dropped silently and show up
  // only as the broker's own rejection mid-run, so it is refused where it was
  // typed. Online dispatch validates the URL before reading input or minting a
  // token, so this aborts before the caller can disclose anything: checked
  // second, the (nonexistent) input file's exit-69 read error would show instead.
  for (const raw of [
    "wss://someone@peers.example.org/psi",
    "wss://peers.example.org/psi?key=private",
  ])
    await expect(
      validateInvite({
        resolved: { mode: "online", url: new URL(raw), input: "input.csv" },
        options: testOptions(),
        acceptTimeout: 900,
        log: silentLog,
      }),
    ).rejects.toBeInstanceOf(UsageError);
});

test("validateInvite: offline rejects a missing input file, preserving its exit code", async () => {
  await expect(
    validateInvite({
      resolved: { mode: "offline", input: "/nonexistent/psilink-input.csv" },
      options: testOptions(),
      acceptTimeout: 900,
      log: silentLog,
    }),
  ).rejects.toMatchObject({ exitCode: 69 });
});

test("validateInvite: offline requires an input file", async () => {
  await expect(
    validateInvite({
      resolved: { mode: "offline" },
      options: testOptions(),
      acceptTimeout: 900,
      log: silentLog,
    }),
  ).rejects.toBeInstanceOf(UsageError);
});

test("validateInvite: a missing or blank --identity is refused", async () => {
  // testOptions points the config at a path that does not exist, so this is the
  // authoring path: the terms come from the input and nothing but the flag can
  // name this party. The refusal lands ahead of that (nonexistent) input file
  // and ahead of the token whose terms would hold the label. The blank cases
  // are the scripted `--identity "$ORG"` with ORG unset -- nothing for psilink
  // to stand in, so they refuse exactly as the absent flag does.
  for (const identity of [undefined, "", "   "])
    await expect(
      validateInvite({
        resolved: { mode: "offline", input: "/nonexistent/psilink-input.csv" },
        options: testOptions({ identity }),
        acceptTimeout: 900,
        log: silentLog,
      }),
    ).rejects.toThrow(IDENTITY_REQUIRED);
});

test("validateInvite: a non-positive accept-timeout is rejected", async () => {
  await expect(
    validateInvite({
      resolved: {
        mode: "online",
        url: new URL("sftp://host/drop"),
        input: "input.csv",
      },
      options: testOptions(),
      acceptTimeout: 0,
      log: silentLog,
    }),
  ).rejects.toBeInstanceOf(UsageError);
});

// --- onlineWaitInvalidationNotice --------------------------------------------

test("onlineWaitInvalidationNotice: states the invitation is void on cancel/timeout and points at re-invite", () => {
  const notice = onlineWaitInvalidationNotice(900);
  // The accept-timeout bound is shown so the user knows how long the wait lasts.
  expect(notice).toContain("900s");
  // Each pre-acceptance exit that voids the invitation is named.
  expect(notice).toContain("Ctrl-C");
  expect(notice).toContain("connection times out");
  expect(notice).toContain("accept-timeout");
  // The consequence and the recovery: the invitation is unusable; re-invite.
  expect(notice).toContain("can no longer be accepted");
  expect(notice).toContain("psilink invite");
});

// --- offlineAbandonNotice ----------------------------------------------------

test("offlineAbandonNotice: names the key file as the early-abandonment path and spares the config", () => {
  const keyPath = "/tmp/agency-a/.psilink.key";
  const notice = offlineAbandonNotice(keyPath);
  // The actionable path -- delete this specific key file -- is named verbatim.
  expect(notice).toContain(keyPath);
  expect(notice).toContain("delete the key file");
  // The consequence: the abandoned invitation cannot complete a handshake.
  expect(notice).toContain("can no longer complete a handshake");
  // The config-safety promise (acceptance criterion: abandonment leaves an
  // existing recurring exchange's configuration intact) is stated.
  expect(notice).toContain("only the key file");
  expect(notice).toContain("configuration");
});

// --- pre-existing config/key on the online path ------------------------------

// 43-char base64url token satisfying the key-file format constraint.
const KEY_TOKEN = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

/** A scratch directory with a small valid CSV; config/key default to fresh
 *  (non-existent) paths inside it so each test can occupy just what it needs. */
function onlineFixture(): { input: string; options: CommonBootstrapOptions } {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-invite-online-"));
  tmpDirs.push(dir);
  const input = path.join(dir, "input.csv");
  fs.writeFileSync(
    input,
    "first_name,last_name,dob,ssn\nAlice,Smith,1990-01-02,123456789\n",
  );
  return {
    input,
    options: testOptions({
      configFile: path.join(dir, "psilink.yaml"),
      keyFile: path.join(dir, ".psilink.key"),
    }),
  };
}

test("validateInvite: online warns (does not error) on a pre-existing key file", async () => {
  const { input, options } = onlineFixture();
  fs.writeFileSync(
    options.keyFile,
    JSON.stringify({ sharedSecret: KEY_TOKEN }),
  );
  const log = getLogger("invite-key-warn-test");
  log.setLevel("silent");
  const warnSpy = vi.spyOn(log, "warn");
  // Completes without throwing: the pre-existing key is a warning on this path.
  await validateInvite({
    resolved: { mode: "online", url: new URL("sftp://host/drop"), input },
    options,
    acceptTimeout: 900,
    log,
  });
  expect(
    warnSpy.mock.calls.some(
      (c) =>
        typeof c[0] === "string" && c[0].includes("key file already exists"),
    ),
  ).toBe(true);
  warnSpy.mockRestore();
});

test("validateInvite: online still aborts on a pre-existing config file", async () => {
  const { input, options } = onlineFixture();
  fs.writeFileSync(options.configFile, "channel: filedrop\npath: /mnt/share\n");
  // A pre-existing config remains a hard conflict for invite (reusing it as the
  // terms source is a separate task); the config gate runs before the input read.
  await expect(
    validateInvite({
      resolved: { mode: "online", url: new URL("sftp://host/drop"), input },
      options,
      acceptTimeout: 900,
      log: silentLog,
    }),
  ).rejects.toThrow(options.configFile);
});

// --- connection_per_poll ignored on a non-sftp online URL --------------------
// A file:// URL resolves to filedrop, which holds no session, so an online invite
// with --connection-per-poll must warn it is ignored rather than silently
// drop it. connectionFromURL applies the override only on sftp, so on filedrop
// the raw flag is the sole carrier of the operator's intent; validateInvite reads
// it and warns. On sftp the mode is valid, so the ignored-warning stays silent.

test("validateInvite: online file:// URL with --connection-per-poll warns it is ignored", async () => {
  const { input, options } = onlineFixture();
  const dir = path.dirname(input);
  const log = getLogger("invite-cpp-filedrop-test");
  log.setLevel("silent");
  const warnSpy = vi.spyOn(log, "warn");
  await validateInvite({
    resolved: { mode: "online", url: new URL(`file://${dir}`), input },
    options: { ...options, connectionPerPoll: true },
    acceptTimeout: 900,
    log,
  });
  expect(
    warnSpy.mock.calls.some(
      (c) =>
        typeof c[0] === "string" &&
        c[0].includes("--connection-per-poll") &&
        c[0].includes("will be ignored") &&
        c[0].includes("only supported on sftp"),
    ),
  ).toBe(true);
  warnSpy.mockRestore();
});

test("validateInvite: online sftp URL with --connection-per-poll does not warn it is ignored", async () => {
  const { input, options } = onlineFixture();
  const log = getLogger("invite-cpp-sftp-test");
  log.setLevel("silent");
  const warnSpy = vi.spyOn(log, "warn");
  await validateInvite({
    resolved: { mode: "online", url: new URL("sftp://host/drop"), input },
    // A long poll interval keeps the wasteful-short-interval advisory silent too,
    // so no connection_per_poll warning of any kind should appear on its channel.
    options: {
      ...options,
      connectionPerPoll: true,
      pollingFrequencyMs: 3_600_000,
    },
    acceptTimeout: 900,
    log,
  });
  expect(
    warnSpy.mock.calls.some(
      (c) => typeof c[0] === "string" && c[0].includes("--connection-per-poll"),
    ),
  ).toBe(false);
  warnSpy.mockRestore();
});

// --- online invite emits a connection endpoint -------------------------------

test("validateInvite: online sftp emits a credential-free endpoint the acceptor seeds from", async () => {
  const { input, options } = onlineFixture();
  const ready = await validateInvite({
    resolved: {
      mode: "online",
      url: new URL("sftp://sftp.example.org:2222/exchanges/drop"),
      input,
    },
    // Credentials supplied via overrides: they reach the live connection but must
    // never reach the emitted endpoint.
    options: { ...options, serverUsername: "alice", serverPassword: "hunter2" },
    acceptTimeout: 900,
    log: silentLog,
  });
  const token = await decodeInvitation(ready.invitation);
  expect(token.connectionEndpoint).toEqual({
    channel: "sftp",
    host: "sftp.example.org",
    port: 2222,
    path: "/exchanges/drop",
  });
  // No credential material rode along (the strongest form of the invariant).
  expect(JSON.stringify(token.connectionEndpoint)).not.toContain("hunter2");
  expect(JSON.stringify(token.connectionEndpoint)).not.toContain("alice");
  // The acceptor seeds its connection block from the embedded endpoint, marking
  // the credential field for replacement (the same path web invitations exercise).
  const { connection, seeded } = connectionFromEndpoint(
    token.connectionEndpoint,
  );
  expect(seeded).toBe(true);
  if (connection.channel !== "sftp") throw new Error("expected sftp");
  expect(connection.server.host).toBe("sftp.example.org");
  expect(connection.server.path).toBe("/exchanges/drop");
  expect(connection.server.username).toMatch(/REPLACE_WITH/);
  expect(connection.server.password).toBeUndefined();
});

test("validateInvite: online webrtc emits the coordination server as a credential-free endpoint", async () => {
  const { input, options } = onlineFixture();
  const ready = await validateInvite({
    resolved: {
      mode: "online",
      // A self-hosted coordination server on its own port and mount point: the
      // locator no printed hint could convey, and the reason this endpoint is
      // emitted at all.
      url: new URL("wss://peers.example.org:8443/psi"),
      input,
    },
    // Credential-shaped overrides: they are file-sync flags this channel has no
    // use for, and must not appear on the endpoint under any name.
    options: { ...options, serverUsername: "alice", serverPassword: "hunter2" },
    acceptTimeout: 900,
    log: silentLog,
  });
  const token = await decodeInvitation(ready.invitation);
  expect(token.connectionEndpoint).toEqual({
    channel: "webrtc",
    host: "peers.example.org",
    port: 8443,
    path: "/psi",
  });
  // Nothing but the locator rode along -- no credential, and no ICE or scheme
  // field the endpoint has no place for.
  const encodedEndpoint = JSON.stringify(token.connectionEndpoint);
  for (const leak of ["hunter2", "alice", "key", "secure", "turn", "stun"])
    expect(encodedEndpoint).not.toContain(leak);
  // The acceptor seeds its connection block from the embedded endpoint and
  // stamps the complementary role, which no invitation can hold.
  const { connection, seeded } = connectionFromEndpoint(
    token.connectionEndpoint,
  );
  expect(seeded).toBe(true);
  if (connection.channel !== "webrtc") throw new Error("expected webrtc");
  expect(connection.server).toEqual({
    host: "peers.example.org",
    port: 8443,
    path: "/psi",
  });
  expect(connection.role).toBeUndefined();
});

test("validateInvite: the online webrtc connection takes the inviter end of the rendezvous", async () => {
  // The URL has no role, so the invitation's own side is stamped by the
  // command that mints it; without one `psilink exchange` refuses to dial.
  const { input, options } = onlineFixture();
  const ready = await validateInvite({
    resolved: {
      mode: "online",
      url: new URL("wss://peers.example.org/psi"),
      input,
    },
    options,
    acceptTimeout: 900,
    log: silentLog,
  });
  if (ready.mode !== "online") throw new Error("expected online mode");
  if (ready.connection.channel !== "webrtc") throw new Error("expected webrtc");
  expect(ready.connection.role).toBe("inviter");
  // --accept-timeout bounds this run's rendezvous wait, but not through the
  // connection the bootstrap persists: that budget is applied to the live
  // connection alone, so nothing here writes it into the saved config.
  expect(ready.connection.options?.peerTimeoutMs).toBeUndefined();
  // A default-scheme port is normalized away by the URL parser, and `secure`
  // stays unset so the connection's TLS default stands.
  expect(ready.connection.server.port).toBeUndefined();
  expect(ready.connection.server.secure).toBeUndefined();
});

test("validateInvite: a plaintext webrtc invite warns that the endpoint cannot hold the scheme", async () => {
  // An endpoint has no `secure` field, so an acceptor seeded from this one
  // dials TLS and meets nobody; the operator is told while they can still act.
  const { input, options } = onlineFixture();
  const log = getLogger("invite-ws-plaintext-test");
  log.setLevel("silent");
  const warnSpy = vi.spyOn(log, "warn");
  const ready = await validateInvite({
    resolved: {
      mode: "online",
      url: new URL("ws://127.0.0.1:9000/psi"),
      input,
    },
    options,
    acceptTimeout: 900,
    log,
  });
  expect(
    warnSpy.mock.calls.some(
      (c) => typeof c[0] === "string" && c[0].includes("secure: false"),
    ),
  ).toBe(true);
  // The plaintext choice is kept on this party's own connection (where the dial
  // warns about it in turn); only the invitation cannot express it.
  if (ready.mode !== "online") throw new Error("expected online mode");
  if (ready.connection.channel !== "webrtc") throw new Error("expected webrtc");
  expect(ready.connection.server.secure).toBe(false);
  const token = await decodeInvitation(ready.invitation);
  expect(token.connectionEndpoint).toEqual({
    channel: "webrtc",
    host: "127.0.0.1",
    port: 9000,
    path: "/psi",
  });
  warnSpy.mockRestore();
});

test("validateInvite: a webrtc invite declares no retain mode and reports the flag ignored", async () => {
  // retain_files is a file-sync setting the webrtc channel does not have, and
  // the invitation schema refuses the declaration beside a webrtc endpoint, so
  // the flag must neither reach the token nor be dropped silently.
  const { input, options } = onlineFixture();
  const log = getLogger("invite-ws-retain-test");
  log.setLevel("silent");
  const warnSpy = vi.spyOn(log, "warn");
  const ready = await validateInvite({
    resolved: {
      mode: "online",
      url: new URL("wss://peers.example.org/psi"),
      input,
    },
    options: { ...options, retainFiles: true },
    acceptTimeout: 900,
    log,
  });
  const token = await decodeInvitation(ready.invitation);
  expect(token.inviterRetainsFiles).toBeUndefined();
  expect(
    warnSpy.mock.calls.some(
      (c) => typeof c[0] === "string" && c[0].includes("--retain-files"),
    ),
  ).toBe(true);
  warnSpy.mockRestore();
});

test("validateInvite: a bare-host webrtc URL still emits a mount point on the endpoint", async () => {
  // The partner's client resolves an endpoint that names no path to its own
  // default, which is not this one's -- the browser app mounts its broker at
  // /api/ while the CLI dials /. Emitting the resolved value is what keeps a
  // bare-host invitation meeting the partner instead of silently waiting out
  // the accept-timeout at a different socket.
  const { input, options } = onlineFixture();
  const ready = await validateInvite({
    resolved: {
      mode: "online",
      url: new URL("wss://peers.example.org"),
      input,
    },
    options,
    acceptTimeout: 900,
    log: silentLog,
  });
  const token = await decodeInvitation(ready.invitation);
  expect(token.connectionEndpoint).toEqual({
    channel: "webrtc",
    host: "peers.example.org",
    path: "/",
  });
});

test("validateInvite: a webrtc URL the dial would refuse fails before the token exists", async () => {
  // The branch's own ordering invariant: everything fallible runs before the
  // token reaches stdout. A percent-encoded delimiter survives the
  // userinfo/query/fragment refusal and lands in the path, and port 0 is a legal
  // port nothing listens on; both are refused when the broker location is
  // resolved, so both must be resolved HERE rather than inside the exchange.
  const { input, options } = onlineFixture();
  for (const raw of [
    "wss://peers.example.org/psi%3Fkey=private",
    "wss://peers.example.org/psi%40elsewhere.example.org",
    "wss://peers.example.org:0/psi",
  ])
    await expect(
      validateInvite({
        resolved: { mode: "online", url: new URL(raw), input },
        options,
        acceptTimeout: 900,
        log: silentLog,
      }),
    ).rejects.toBeInstanceOf(UsageError);
});

test("handler: a webrtc URL the dial would refuse prints no invitation", async () => {
  // The end-to-end half of the ordering invariant above: the refusal is an
  // exit-64 usage error, and stdout -- which holds the invitation and nothing
  // else -- stays empty. A check on validateInvite alone could not see a token
  // printed by the handler around it.
  const { input, options } = onlineFixture();
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  const stdio = captureStdio();
  try {
    await inviteHandler({
      _: [],
      $0: "psilink",
      identity: "Agency A",
      args: ["wss://peers.example.org/psi%3Fkey=private", input],
      "config-file": options.configFile,
      "key-file": options.keyFile,
      "log-level": "silent",
      record: false,
    } as unknown as Arguments);
    expect(exit).toHaveBeenCalledWith(64);
    expect(stdio.stdoutWrites.join("")).toBe("");
    expect(fs.existsSync(options.keyFile)).toBe(false);
  } finally {
    stdio.restore();
    exit.mockRestore();
  }
});

test("validateInvite: a webrtc invite reports every dropped --server-* flag", async () => {
  // The credential flags matter most here: the server block is merged on sftp
  // alone, so each is parsed and discarded, and from the terminal that looks
  // exactly like one that was used.
  const { input, options } = onlineFixture();
  const log = getLogger("invite-ws-credential-flags-test");
  log.setLevel("silent");
  const warnSpy = vi.spyOn(log, "warn");
  const secrets = {
    serverPassword: "hunter2",
    serverPrivateKey: "/keys/id_ed25519",
    serverPrivateKeyPassphrase: "open-sesame",
    serverKeyboardInteractive: true,
    serverHostKeyFingerprint: `SHA256:${"A".repeat(43)}`,
  };
  const ready = await validateInvite({
    resolved: {
      mode: "online",
      url: new URL("wss://peers.example.org:8443/psi"),
      input,
    },
    options: { ...options, ...secrets },
    acceptTimeout: 900,
    log,
  });
  const warnings = warnSpy.mock.calls.map((c) => String(c[0]));
  for (const flag of [
    "--server-password",
    "--server-private-key",
    "--server-private-key-passphrase",
    "--server-keyboard-interactive",
    "--server-host-key-fingerprint",
  ])
    expect(warnings.some((m) => m.startsWith(`${flag} `))).toBe(true);
  // Reported by name: none of the values reaches the terminal or a --log-file.
  const rendered = warnings.join("");
  for (const value of Object.values(secrets))
    if (typeof value === "string") expect(rendered).not.toContain(value);
  // Nor does any of them reach the connection this party runs, the endpoint the
  // partner seeds from, or the encoded token around it.
  if (ready.mode !== "online") throw new Error("expected online mode");
  if (ready.connection.channel !== "webrtc") throw new Error("expected webrtc");
  expect(ready.connection.server).toEqual({
    host: "peers.example.org",
    port: 8443,
    path: "/psi",
  });
  const token = await decodeInvitation(ready.invitation);
  const decodedToken = JSON.stringify(token);
  for (const value of Object.values(secrets))
    if (typeof value === "string") expect(decodedToken).not.toContain(value);
  warnSpy.mockRestore();
});

test("validateInvite: a webrtc invite reports the dropped filename toggles", async () => {
  // peer_id and timestamp_in_filename name outgoing exchange FILES; a channel
  // with no directory writes none, so applyConnectionOverrides drops both.
  const { input, options } = onlineFixture();
  const log = getLogger("invite-ws-filename-flags-test");
  log.setLevel("silent");
  const warnSpy = vi.spyOn(log, "warn");
  const ready = await validateInvite({
    resolved: {
      mode: "online",
      url: new URL("wss://peers.example.org/psi"),
      input,
    },
    options: { ...options, peerId: "party-a", timestampInFilename: true },
    acceptTimeout: 900,
    log,
  });
  const warnings = warnSpy.mock.calls.map((c) => String(c[0]));
  expect(warnings.some((m) => m.startsWith("--peer-id "))).toBe(true);
  expect(warnings.some((m) => m.startsWith("--timestamp-in-filename "))).toBe(
    true,
  );
  expect(warnings.join("")).not.toContain("party-a");
  if (ready.mode !== "online") throw new Error("expected online mode");
  // Both toggles dropped and no accept-only budget merged in, so this webrtc
  // connection reaches the saved config with no options block at all.
  expect(ready.connection.options).toBeUndefined();
});

test("validateInvite: a webrtc invite reports --server-port/--server-username ignored", async () => {
  // The server block is merged on sftp alone, so both are dropped on this
  // channel: the port the partner is handed comes from the URL, and the
  // username never lands anywhere at all.
  const { input, options } = onlineFixture();
  const log = getLogger("invite-ws-server-flags-test");
  log.setLevel("silent");
  const warnSpy = vi.spyOn(log, "warn");
  const ready = await validateInvite({
    resolved: {
      mode: "online",
      url: new URL("wss://peers.example.org:8443/psi"),
      input,
    },
    options: { ...options, serverPort: 9999, serverUsername: "alice" },
    acceptTimeout: 900,
    log,
  });
  const warnings = warnSpy.mock.calls.map((c) => String(c[0]));
  expect(warnings.some((m) => m.includes("--server-port"))).toBe(true);
  expect(warnings.some((m) => m.includes("--server-username"))).toBe(true);
  // Flag names only: these lines reach the terminal and any --log-file, so no
  // override value rides along on one.
  expect(warnings.some((m) => m.includes("alice"))).toBe(false);
  if (ready.mode !== "online") throw new Error("expected online mode");
  if (ready.connection.channel !== "webrtc") throw new Error("expected webrtc");
  expect(ready.connection.server.port).toBe(8443);
  expect(ready.connection.server.username).toBeUndefined();
  // Nor does either reach the endpoint the acceptor seeds its own block from.
  const token = await decodeInvitation(ready.invitation);
  expect(token.connectionEndpoint).toEqual({
    channel: "webrtc",
    host: "peers.example.org",
    port: 8443,
    path: "/psi",
  });
  warnSpy.mockRestore();
});

// --- --peer-timeout on the online path ---------------------------------------

// --accept-timeout is this run's peer budget on this path unconditionally, so a
// --peer-timeout typed alongside it does not bound this invitation's wait. It is
// not discarded: it is what the saved configuration keeps for the runs that
// follow. Reported rather than silent, since the two timeouts bound different
// lifetimes and neither is guessable from the other's silence.

test("validateInvite: online reports which lifetime each timeout bounds", async () => {
  const { input, options } = onlineFixture();
  const log = getLogger("invite-peer-timeout-superseded-test");
  log.setLevel("silent");
  const warnSpy = vi.spyOn(log, "warn");
  const ready = await validateInvite({
    resolved: { mode: "online", url: new URL("sftp://host/drop"), input },
    options: { ...options, peerTimeout: 60 },
    acceptTimeout: 900,
    log,
  });
  const warnings = warnSpy.mock.calls.map((c) => String(c[0]));
  const superseded = warnings.filter((m) => m.startsWith("--peer-timeout "));
  expect(superseded).toHaveLength(1);
  // The flag that does not bound this wait, the one that does, and where the
  // typed value lands instead.
  expect(superseded[0]).toContain("does not bound this online invitation");
  expect(superseded[0]).toContain("--accept-timeout (900s)");
  expect(superseded[0]).toContain("connection.options.peer_timeout_ms");
  // The claim the warning makes, asserted against the connection this invite
  // persists: the operator's own 60s, never the 900s accept window.
  if (ready.mode !== "online") throw new Error("expected online mode");
  expect(ready.connection.options?.peerTimeoutMs).toBe(60_000);
  warnSpy.mockRestore();
});

test("validateInvite: online without --peer-timeout says nothing about it", async () => {
  const { input, options } = onlineFixture();
  const log = getLogger("invite-peer-timeout-quiet-test");
  log.setLevel("silent");
  const warnSpy = vi.spyOn(log, "warn");
  await validateInvite({
    resolved: { mode: "online", url: new URL("sftp://host/drop"), input },
    options,
    acceptTimeout: 900,
    log,
  });
  const warnings = warnSpy.mock.calls.map((c) => String(c[0]));
  expect(warnings.some((m) => m.includes("--peer-timeout"))).toBe(false);
  warnSpy.mockRestore();
});

test("validateInvite: offline --peer-timeout keeps its own ignored-offline warning", async () => {
  // Offline the flag is dropped for a different reason and has a different
  // remedy (the written placeholder's connection.options block), so the online
  // supersession must not displace or duplicate that diagnostic.
  const { input, options } = onlineFixture();
  const log = getLogger("invite-peer-timeout-offline-test");
  log.setLevel("silent");
  const warnSpy = vi.spyOn(log, "warn");
  await validateInvite({
    resolved: { mode: "offline", input },
    options: { ...options, peerTimeout: 60 },
    acceptTimeout: 900,
    log,
  });
  const warnings = warnSpy.mock.calls.map((c) => String(c[0]));
  expect(
    warnings.some((m) => m.startsWith("--peer-timeout has no effect")),
  ).toBe(true);
  expect(warnings.some((m) => m.includes("online invitation"))).toBe(false);
  warnSpy.mockRestore();
});

/** A millisecond constant as the whole-seconds figure a notice prints it as,
 *  anchored at its leading digit so one figure cannot be matched inside a
 *  longer one. */
function secondsFigure(milliseconds: number): RegExp {
  return new RegExp(`\\b${milliseconds / 1000}s`);
}

test("persistedPeerBudgetNotice: names the file-sync default when no budget was written", () => {
  // The absent-field case is the one an operator cannot read off the saved file,
  // so the notice names both what bounded this run and what bounds the next one.
  for (const channel of ["sftp", "filedrop"] as const) {
    const notice = persistedPeerBudgetNotice(undefined, 900, channel);
    expect(notice).toContain("no connection.options.peer_timeout_ms");
    expect(notice).toContain("--accept-timeout (900s)");
    expect(notice).toContain(`(${DEFAULT_PEER_TIMEOUT_MS / 1000}s)`);
    expect(notice).toContain("--peer-timeout");
  }
});

test("persistedPeerBudgetNotice: names the webrtc transport's own three defaults", () => {
  // The webrtc channel does not fall to the file-sync hour: an unset
  // peer_timeout_ms leaves the transport's rendezvous, channel-open, and
  // parked-receive budgets in place, and the rendezvous figure is a different
  // number. Naming the file-sync figure here would tell the operator to expect
  // an hour at a rendezvous that gives up after ten minutes.
  const notice = persistedPeerBudgetNotice(undefined, 900, "webrtc");
  expect(notice).toContain("no connection.options.peer_timeout_ms");
  // Matched on a leading word boundary so the rendezvous figure cannot be read
  // out of the tail of the inactivity one (600 sits inside 3600).
  expect(notice).toMatch(secondsFigure(DEFAULT_RENDEZVOUS_TIMEOUT_MS));
  expect(notice).toMatch(secondsFigure(DEFAULT_CHANNEL_OPEN_TIMEOUT_MS));
  expect(notice).toMatch(secondsFigure(DEFAULT_WEBRTC_INACTIVITY_TIMEOUT_MS));
  expect(notice).not.toContain("file-sync");
});

test("persistedPeerBudgetNotice: cites the reference for a channel with no named default", () => {
  // A channel added to the union without a default named here must not inherit
  // another transport's figure: the fallback states where the answer is written
  // down rather than quoting a number that would be wrong.
  const notice = persistedPeerBudgetNotice(
    undefined,
    900,
    "quic" as ConnectionConfig["channel"],
  );
  expect(notice).toContain("docs/EXCHANGE_REFERENCE.md");
  expect(notice).not.toMatch(secondsFigure(DEFAULT_PEER_TIMEOUT_MS));
  expect(notice).not.toMatch(secondsFigure(DEFAULT_RENDEZVOUS_TIMEOUT_MS));
});

test("persistedPeerBudgetNotice: names the recorded budget when one was written", () => {
  const notice = persistedPeerBudgetNotice(60, 900, "sftp");
  expect(notice).toContain("connection.options.peer_timeout_ms as 60s");
  expect(notice).toContain("--accept-timeout (900s) bounded this run alone");
  // The value that was written, not the accept window, is what a later run gets.
  expect(notice).not.toContain(`${DEFAULT_PEER_TIMEOUT_MS / 1000}s`);
});

test("validateInvite: online includes the disclosed-columns subset from the inferred metadata", async () => {
  // An input with non-linkage columns: `notes` infers as an `other` payload column
  // and `member_id` as an `_id` row-identifier, both transmitted; the name/dob/ssn
  // linkage columns are not. The token must hold exactly that disclosed subset so
  // the acceptor's consent and commitment derive from the wire's own predicate.
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-invite-disc-"));
  const input = path.join(dir, "input.csv");
  fs.writeFileSync(
    input,
    "first_name,last_name,dob,ssn,notes,member_id\n" +
      "Alice,Smith,1990-01-02,123456789,vip,M001\n",
  );
  const ready = await validateInvite({
    resolved: { mode: "online", url: new URL("sftp://host/drop"), input },
    options: testOptions(),
    acceptTimeout: 900,
    log: silentLog,
  });
  const token = await decodeInvitation(ready.invitation);
  expect(token.disclosedPayloadColumns).toEqual(
    disclosedColumnNames(
      inferMetadata([
        "first_name",
        "last_name",
        "dob",
        "ssn",
        "notes",
        "member_id",
      ]),
    ),
  );
  expect(token.disclosedPayloadColumns).toEqual(["notes", "member_id"]);
  // The same disclosed set is persisted into the saved config's
  // disclosedPayloadColumns (the send-side commitment), so a later recurring
  // `psilink exchange` can verify its metadata still discloses it before any
  // credential, terms, or data are sent -- byte-identical to the token copy.
  if (ready.mode !== "online") throw new Error("expected online mode");
  expect(ready.dataSpec.disclosedPayloadColumns).toEqual(
    token.disclosedPayloadColumns,
  );
});

test("validateInvite: offline infer-from-input persists the disclosed subset as the send commitment", async () => {
  // The offline infer path writes a config, so it persists the disclosed set it
  // published on the token into disclosedPayloadColumns too -- the send-side
  // commitment the later recurring `psilink exchange` checks.
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-invite-disc-off-"));
  const input = path.join(dir, "input.csv");
  fs.writeFileSync(
    input,
    "first_name,last_name,dob,ssn,notes,member_id\n" +
      "Alice,Smith,1990-01-02,123456789,vip,M001\n",
  );
  const ready = await validateInvite({
    resolved: { mode: "offline", input },
    options: testOptions({ configFile: path.join(dir, "psilink.yaml") }),
    acceptTimeout: 900,
    log: silentLog,
  });
  const token = await decodeInvitation(ready.invitation);
  expect(token.disclosedPayloadColumns).toEqual(["notes", "member_id"]);
  if (ready.mode !== "offline") throw new Error("expected offline mode");
  expect(ready.dataSpec.disclosedPayloadColumns).toEqual(
    token.disclosedPayloadColumns,
  );
});

test("validateInvite: an all-linkage input has an empty disclosed subset", async () => {
  // onlineFixture's CSV is first_name,last_name,dob,ssn -- all linkage columns, so
  // nothing is disclosed. The metadata is known (inferred from the input), so the
  // field is written as the EMPTY set, locking the acceptor in to "receive nothing"
  // (a later non-empty payload aborts) rather than reconciling lazily.
  const { input, options } = onlineFixture();
  const ready = await validateInvite({
    resolved: { mode: "online", url: new URL("sftp://host/drop"), input },
    options,
    acceptTimeout: 900,
    log: silentLog,
  });
  const token = await decodeInvitation(ready.invitation);
  expect(token.disclosedPayloadColumns).toEqual([]);
});

// --- an over-long disclosed column name is refused pre-mint ------------------

/** A scratch directory holding an input whose last column is the given name, plus
 *  fresh (non-existent) config/key paths inside it, so a refusal can be checked to
 *  have written neither. */
function fixtureWithTrailingColumn(name: string): {
  input: string;
  options: CommonBootstrapOptions;
} {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-invite-name-"));
  tmpDirs.push(dir);
  const input = path.join(dir, "input.csv");
  fs.writeFileSync(
    input,
    `first_name,last_name,dob,ssn,${name}\n` +
      "Alice,Smith,1990-01-02,123456789,vip\n",
  );
  return {
    input,
    options: testOptions({
      configFile: path.join(dir, "psilink.yaml"),
      keyFile: path.join(dir, ".psilink.key"),
    }),
  };
}

/** A disclosed column name one character past the length ceiling: inferred as
 *  an `other` payload column, so it is transmitted and its name is included. */
const OVERLONG_COLUMN = "n".repeat(MAX_NAME_LENGTH + 1);

test("validateInvite: online refuses an over-long disclosed column name before minting", async () => {
  // The header is unbounded by any schema, so without the mint-boundary guard the
  // name reaches the token's own name bound inside encodeInvitation as a raw
  // ZodError. The operator gets the typed refusal naming the position instead.
  const { input, options } = fixtureWithTrailingColumn(OVERLONG_COLUMN);
  let thrown: unknown;
  try {
    await validateInvite({
      resolved: { mode: "online", url: new URL("sftp://host/drop"), input },
      options,
      acceptTimeout: 900,
      log: silentLog,
    });
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(UsageError);
  const message = String(thrown);
  expect(message).toMatch(/metadata column 5 /);
  expect(message).toContain(`${MAX_NAME_LENGTH}-character limit`);
  // The offending name is located, not echoed: it is longer than any message that
  // would hold it.
  expect(message).not.toContain(OVERLONG_COLUMN);
  expect(fs.existsSync(options.configFile)).toBe(false);
  expect(fs.existsSync(options.keyFile)).toBe(false);
});

test("handler: the offline infer path refuses an over-long disclosed name, writing nothing", async () => {
  // Driven through the handler, so the refusal is asserted where the invitation
  // is printed and the config and key file are written -- the offline mint's
  // commit step, which a failure in the no-commit phase never reaches.
  const { input, options } = fixtureWithTrailingColumn(OVERLONG_COLUMN);
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  const stdio = captureStdio();
  try {
    await inviteHandler({
      _: [],
      $0: "psilink",
      identity: "Agency A",
      args: [input],
      "config-file": options.configFile,
      "key-file": options.keyFile,
      "log-level": "error",
    } as unknown as Arguments);
    // Read before the finally block restores the spies.
    const stdout = stdio.stdoutWrites.join("");
    const stderr = stdio.stderrWrites.join("");
    // Exit 64: the shared usage-error classification, not a transport or
    // internal failure.
    expect(exit).toHaveBeenCalledWith(64);
    expect(fs.existsSync(options.configFile)).toBe(false);
    expect(fs.existsSync(options.keyFile)).toBe(false);
    // The invitation is the only thing stdout ever holds, and it was never
    // minted.
    expect(stdout).toBe("");
    expect(stderr).toMatch(/metadata column 5 /);
    expect(stderr).toContain(`${MAX_NAME_LENGTH}-character limit`);
  } finally {
    stdio.restore();
    exit.mockRestore();
  }
});

test("validateInvite: a disclosed column name at the ceiling still mints", async () => {
  // The boundary in the other direction, so the refusal cannot be an off-by-one
  // that costs a legitimate header its invitation.
  const atCeiling = "n".repeat(MAX_NAME_LENGTH);
  const { input, options } = fixtureWithTrailingColumn(atCeiling);
  const ready = await validateInvite({
    resolved: { mode: "offline", input },
    options,
    acceptTimeout: 900,
    log: silentLog,
  });
  const token = await decodeInvitation(ready.invitation);
  expect(token.disclosedPayloadColumns).toEqual([atCeiling]);
});

// --- linkage strategy selection ----------------------------------------------

test("validateInvite: --linkage-strategy single-pass authors single-pass terms and notes the disclosure", async () => {
  const { input, options } = onlineFixture();
  const log = getLogger("invite-strategy-test");
  log.setLevel("silent");
  const infoSpy = vi.spyOn(log, "info");
  try {
    const ready = await validateInvite({
      resolved: { mode: "online", url: new URL("sftp://host/drop"), input },
      options,
      acceptTimeout: 900,
      linkageStrategy: "single-pass",
      log,
    });
    // The selection flows into the authored terms the invitation holds, so the
    // mandatory-consistency check sees single-pass on both sides.
    const token = await decodeInvitation(ready.invitation);
    expect(token.linkageTerms.linkageStrategy).toBe("single-pass");
    // The disclosure tradeoff is shown at the point of selection.
    const info = infoSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(info).toContain("consented disclosure tradeoff");
    expect(info).toContain("docs/EXCHANGE_REFERENCE.md");
  } finally {
    infoSpy.mockRestore();
  }
});

test("validateInvite: omitting --linkage-strategy authors cascade with no disclosure note", async () => {
  // The default is unchanged from before the flag existed: cascade, and no note.
  const { input, options } = onlineFixture();
  const log = getLogger("invite-strategy-default-test");
  log.setLevel("silent");
  const infoSpy = vi.spyOn(log, "info");
  try {
    const ready = await validateInvite({
      resolved: { mode: "online", url: new URL("sftp://host/drop"), input },
      options,
      acceptTimeout: 900,
      log,
    });
    const token = await decodeInvitation(ready.invitation);
    expect(token.linkageTerms.linkageStrategy).toBe("cascade");
    const info = infoSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(info).not.toContain("consented disclosure tradeoff");
  } finally {
    infoSpy.mockRestore();
  }
});

test("validateInvite: offline infer-from-input also applies the selected single-pass strategy and notes the disclosure", async () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-invite-sp-offline-"));
  tmpDirs.push(dir);
  const input = writeCsv(dir, "first_name,last_name,dob,ssn");
  const log = getLogger("invite-strategy-offline-test");
  log.setLevel("silent");
  const infoSpy = vi.spyOn(log, "info");
  try {
    const ready = await validateInvite({
      resolved: { mode: "offline", input },
      options: testOptions({
        configFile: path.join(dir, "psilink.yaml"),
        keyFile: path.join(dir, ".psilink.key"),
      }),
      acceptTimeout: 900,
      linkageStrategy: "single-pass",
      log,
    });
    expect(ready.mode).toBe("offline");
    const token = await decodeInvitation(ready.invitation);
    expect(token.linkageTerms.linkageStrategy).toBe("single-pass");
    // The offline-infer path emits the same disclosure note as the online path;
    // assert it fired so deleting the note from this branch is caught here, not
    // only by the online test.
    const info = infoSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(info).toContain("consented disclosure tradeoff");
  } finally {
    infoSpy.mockRestore();
  }
});

test("validateInvite: --linkage-strategy is warned-ignored when terms come from a config", async () => {
  // Config-as-source: the config is authoritative, so the flag must not silently
  // override its linkage_strategy. The flag is named as ignored and the minted
  // terms keep the config's strategy.
  const terms = defaultTerms();
  const { dir, configPath, keyPath } = withConfig(terms);
  const log = getLogger("invite-strategy-config-test");
  log.setLevel("silent");
  const warnSpy = vi.spyOn(log, "warn");
  try {
    const ready = await validateInvite({
      resolved: { mode: "offline" },
      options: testOptions({ configFile: configPath, keyFile: keyPath }),
      acceptTimeout: 900,
      linkageStrategy: "single-pass",
      log,
    });
    expect(ready.mode).toBe("offlineFromConfig");
    const token = await decodeInvitation(ready.invitation);
    // cascade: the config's strategy, not the ignored flag's single-pass.
    expect(token.linkageTerms.linkageStrategy).toBe("cascade");
    const warn = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
    // The warning names what was requested and what the config uses instead, so
    // an operator who wanted single-pass sees they did not get it.
    expect(warn).toContain("--linkage-strategy single-pass has no effect");
    expect(warn).toContain("linkage_strategy (cascade) is used instead");
  } finally {
    warnSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateInvite: a config's single-pass strategy is preserved when no flag is passed, with no warning", async () => {
  // The reverse of the warn case: a config that selects single-pass is honored
  // verbatim when the operator passes no flag, and the ignore-warning stays quiet.
  const terms: LinkageTerms = {
    ...defaultTerms(),
    linkageStrategy: "single-pass",
  };
  const { dir, configPath, keyPath } = withConfig(terms);
  const log = getLogger("invite-strategy-config-keep-test");
  log.setLevel("silent");
  const warnSpy = vi.spyOn(log, "warn");
  try {
    const ready = await validateInvite({
      resolved: { mode: "offline" },
      options: testOptions({ configFile: configPath, keyFile: keyPath }),
      acceptTimeout: 900,
      log,
    });
    expect(ready.mode).toBe("offlineFromConfig");
    const token = await decodeInvitation(ready.invitation);
    expect(token.linkageTerms.linkageStrategy).toBe("single-pass");
    // Keyed to this flag: the same path reports every other flag the config is
    // authoritative for, and one of those firing is not this one staying quiet.
    const warn = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warn).not.toContain("--linkage-strategy");
  } finally {
    warnSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- the invitation's retain-mode declaration --------------------------------

test("validateInvite: an online retain-mode invite declares it on the token", async () => {
  // The consent gap this closes: without the declaration a partner accepts, and
  // consents, with nothing telling them the exchange leaves a permanent
  // transcript. Read from the post-override connection, so --retain-files is
  // reflected the way --server-port already is on the endpoint beside it.
  const { input, options } = onlineFixture();
  const ready = await validateInvite({
    resolved: {
      mode: "online",
      url: new URL("sftp://sftp.example.org/exchanges/drop"),
      input,
    },
    options: { ...options, retainFiles: true },
    acceptTimeout: 900,
    log: silentLog,
  });
  const token = await decodeInvitation(ready.invitation);
  expect(token.inviterRetainsFiles).toBe(true);
});

test("validateInvite: an online delete-mode invite declares nothing", async () => {
  // The negative is not the mirror declaration: a run killed outright, or one
  // that fails after the handshake, leaves files behind in either mode, so the
  // ordinary invite states nothing rather than a cleanup it cannot promise.
  const { input, options } = onlineFixture();
  const ready = await validateInvite({
    resolved: {
      mode: "online",
      url: new URL("sftp://sftp.example.org/exchanges/drop"),
      input,
    },
    options,
    acceptTimeout: 900,
    log: silentLog,
  });
  const token = await decodeInvitation(ready.invitation);
  expect(token.inviterRetainsFiles).toBeUndefined();
});

test("validateInvite: a retain-mode config declares it on the token", async () => {
  // The path a real retain exchange takes: retain mode needs a hand-authored
  // config (it implies the lockless rendezvous and timestamped filenames), so an
  // invite minted from one is where the disclosure has to land.
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-invite-retain-"));
  tmpDirs.push(dir);
  const configPath = path.join(dir, "psilink.yaml");
  saveConfig(configPath, {
    connection: {
      channel: "filedrop",
      path: "/mnt/share",
      options: {
        retainFiles: true,
        locklessRendezvous: true,
        timestampInFilename: true,
      },
    },
    linkageTerms: defaultTerms(),
  });
  const ready = await validateInvite({
    resolved: { mode: "offline" },
    options: testOptions({
      configFile: configPath,
      keyFile: path.join(dir, ".psilink.key"),
    }),
    acceptTimeout: 900,
    log: silentLog,
  });
  expect(ready.mode).toBe("offlineFromConfig");
  const token = await decodeInvitation(ready.invitation);
  expect(token.inviterRetainsFiles).toBe(true);
});

test("validateInvite: a config-as-source invite emits no connection endpoint", async () => {
  // This mint declares the retention from the config's options block alone and
  // puts no locator on the token, so it needs no declaration derived from the
  // endpoint's shape and no endpoint can contradict the one it states -- a
  // split inbound/outbound connection, the shape that settles the mode by
  // itself, included.
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-invite-split-"));
  tmpDirs.push(dir);
  const configPath = path.join(dir, "psilink.yaml");
  saveConfig(configPath, {
    connection: {
      channel: "filedrop",
      inboundPath: "/mnt/share/in",
      outboundPath: "/mnt/share/out",
      options: {
        retainFiles: true,
        locklessRendezvous: true,
        timestampInFilename: true,
      },
    },
    linkageTerms: defaultTerms(),
  });
  const ready = await validateInvite({
    resolved: { mode: "offline" },
    options: testOptions({
      configFile: configPath,
      keyFile: path.join(dir, ".psilink.key"),
    }),
    acceptTimeout: 900,
    log: silentLog,
  });
  expect(ready.mode).toBe("offlineFromConfig");
  const token = await decodeInvitation(ready.invitation);
  expect(token.connectionEndpoint).toBeUndefined();
  expect(token.inviterRetainsFiles).toBe(true);
});

test("validateInvite: a webrtc config declares nothing, whatever its options say", async () => {
  // Config-as-source mint reads the connection block without validating it, so
  // this pairing mints without ever reaching the endpoint-paired refusal (which
  // only fires for a webrtc endpoint already on the token) or any other check --
  // ConnectionConfigSchema does not forbid retain_files under webrtc; only the
  // WebRTCConnectionConfig.options type does, at psilink's own authoring sites.
  // The file is hand-written raw (not through saveConfig) to reach this case.
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-invite-webrtc-"));
  tmpDirs.push(dir);
  const configPath = path.join(dir, "psilink.yaml");
  fs.writeFileSync(
    configPath,
    YAML.stringify({
      connection: {
        channel: "webrtc",
        server: { host: "peer.example" },
        options: { retain_files: true },
      },
      linkage_terms: defaultTerms(),
    }),
  );
  const ready = await validateInvite({
    resolved: { mode: "offline" },
    options: testOptions({
      configFile: configPath,
      keyFile: path.join(dir, ".psilink.key"),
    }),
    acceptTimeout: 900,
    log: silentLog,
  });
  expect(ready.mode).toBe("offlineFromConfig");
  const token = await decodeInvitation(ready.invitation);
  expect(token.inviterRetainsFiles).toBeUndefined();
});

test("validateInvite: a config without retain mode declares nothing", async () => {
  const { dir, configPath, keyPath } = withConfig(defaultTerms());
  try {
    const ready = await validateInvite({
      resolved: { mode: "offline" },
      options: testOptions({ configFile: configPath, keyFile: keyPath }),
      acceptTimeout: 900,
      log: silentLog,
    });
    const token = await decodeInvitation(ready.invitation);
    expect(token.inviterRetainsFiles).toBeUndefined();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateInvite: the offline-infer path declares nothing, even under --retain-files", async () => {
  // This path writes a placeholder connection block the operator still has to
  // fill in, and the connection-options overrides are warned-ignored on it, so
  // there is no settled mode to declare. Declaring the flag's value here would
  // state a mode the eventual exchange need not run in.
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-invite-infer-"));
  tmpDirs.push(dir);
  const input = writeCsv(dir, "first_name,last_name,dob,ssn");
  const ready = await validateInvite({
    resolved: { mode: "offline", input },
    options: testOptions({
      configFile: path.join(dir, "psilink.yaml"),
      keyFile: path.join(dir, ".psilink.key"),
      retainFiles: true,
    }),
    acceptTimeout: 900,
    log: silentLog,
  });
  expect(ready.mode).toBe("offline");
  const token = await decodeInvitation(ready.invitation);
  expect(token.inviterRetainsFiles).toBeUndefined();
});

test("validateInvite: online filedrop emits the shared-path endpoint", async () => {
  const { input, options } = onlineFixture();
  const ready = await validateInvite({
    resolved: { mode: "online", url: new URL("file:///mnt/share/drop"), input },
    options,
    acceptTimeout: 900,
    log: silentLog,
  });
  const token = await decodeInvitation(ready.invitation);
  expect(token.connectionEndpoint).toEqual({
    channel: "filedrop",
    path: "/mnt/share/drop",
  });
});

test("validateInvite: a split online invite emits the pair verbatim, acceptor mirror-swaps", async () => {
  // --outbound-path makes the connection split (URL path = inbound, override =
  // outbound). The endpoint holds the inviter's pair unswapped; the acceptor's
  // connectionFromEndpoint lands the inviter's outbound on the acceptor's inbound,
  // making the two parties mirror images.
  const { input, options } = onlineFixture();
  const ready = await validateInvite({
    resolved: { mode: "online", url: new URL("sftp://host/inviter-in"), input },
    options: { ...options, outboundPath: "/inviter-out", retainFiles: true },
    acceptTimeout: 900,
    log: silentLog,
  });
  const token = await decodeInvitation(ready.invitation);
  if (token.connectionEndpoint?.channel !== "sftp")
    throw new Error("expected sftp endpoint");
  // Verbatim at emit: no pre-swap.
  expect(token.connectionEndpoint.inboundPath).toBe("/inviter-in");
  expect(token.connectionEndpoint.outboundPath).toBe("/inviter-out");
  // Swapped at the acceptor.
  const { connection } = connectionFromEndpoint(token.connectionEndpoint);
  if (connection.channel !== "sftp") throw new Error("expected sftp");
  expect(connection.server.inboundPath).toBe("/inviter-out");
  expect(connection.server.outboundPath).toBe("/inviter-in");
});

test("validateInvite: an offline invitation has no endpoint (field stays optional)", async () => {
  // Only the online producer emits an endpoint; an offline invitation omits it
  // and still encodes/decodes cleanly, so no regression for tokens minted
  // elsewhere (the field is optional).
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-invite-noendpoint-"));
  tmpDirs.push(dir);
  const input = writeCsv(dir, "first_name,last_name,dob,ssn");
  const ready = await validateInvite({
    resolved: { mode: "offline", input },
    options: testOptions({
      configFile: path.join(dir, "psilink.yaml"),
      keyFile: path.join(dir, ".psilink.key"),
    }),
    acceptTimeout: 900,
    log: silentLog,
  });
  const token = await decodeInvitation(ready.invitation);
  expect(token.connectionEndpoint).toBeUndefined();
});

// --- validateInvite: offline, config as the linkage-terms source -------------

// Terms an inviter's config would hold after being generated from an input
// with first/last name, dob, and ssn columns: passing that metadata drops the
// default keys (and the ssn4 field) the input cannot satisfy, so the terms
// reference exactly firstName, lastName, dateOfBirth, and ssn.
function defaultTerms(): LinkageTerms {
  return getDefaultLinkageTerms(
    "Agency A",
    inferMetadata(["first_name", "last_name", "dob", "ssn"]),
  );
}

// A pre-existing config holding `terms` (and optionally an explicit
// `standardization` and/or `metadata`) is written to a temp dir; the helper
// returns the paths so a test can point its options at them. The connection is a
// placeholder -- invite does not use it.
function withConfig(
  terms: LinkageTerms,
  standardization?: Standardization,
  metadata?: Metadata,
  expectedPartnerDeduplicate?: boolean,
): { dir: string; configPath: string; keyPath: string } {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-invite-cfg-"));
  const configPath = path.join(dir, "psilink.yaml");
  saveConfig(configPath, {
    connection: { channel: "filedrop", path: "/mnt/share" },
    linkageTerms: terms,
    ...(standardization !== undefined && { standardization }),
    ...(metadata !== undefined && { metadata }),
    ...(expectedPartnerDeduplicate !== undefined && {
      expectedPartnerDeduplicate,
    }),
  });
  return { dir, configPath, keyPath: path.join(dir, ".psilink.key") };
}

// A count-only config in exactly the shape the specification admits: the default
// terms narrowed to one linkage key, which is the only one of the five count-only
// rules the defaults break (they are already cascade, non-deduplicating, and have
// no payload). The declared linkage fields are left alone -- a declared field no
// key references is admitted.
function countOnlyTerms(): LinkageTerms {
  const terms = defaultTerms();
  return {
    ...terms,
    algorithm: "psi-c",
    linkageKeys: terms.linkageKeys.slice(0, 1),
  };
}

function writeCsv(dir: string, header: string): string {
  const p = path.join(dir, "input.csv");
  fs.writeFileSync(p, `${header}\nAlice,Smith,1990-01-02,123456789\n`);
  return p;
}

test("validateInvite: derives terms from a config when no input file is given", async () => {
  const terms = defaultTerms();
  const { dir, configPath, keyPath } = withConfig(terms);
  try {
    const ready = await validateInvite({
      resolved: { mode: "offline" },
      options: testOptions({ configFile: configPath, keyFile: keyPath }),
      acceptTimeout: 900,
      log: silentLog,
    });
    expect(ready.mode).toBe("offlineFromConfig");
    if (ready.mode !== "offlineFromConfig") return;
    expect(ready.configPath).toBe(configPath);
    expect(ready.linkageTerms).toEqual(terms);
    // The minted invitation holds the config's terms, not inferred ones.
    const token = await decodeInvitation(ready.invitation);
    expect(token.linkageTerms).toEqual(terms);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateInvite: a reused config supplies the identity, so no flag is needed", async () => {
  // The label this invitation holds is the config's, chosen when that file was
  // authored, so there is nothing here for the operator to name -- and demanding
  // it would refuse a re-invite over terms they already settled. A blank value
  // is the same case as no flag (the scripted `--identity "$ORG"` with ORG
  // unset): nothing was named, and nothing is reported.
  const terms = getDefaultLinkageTerms(
    "Agency Config",
    inferMetadata(["first_name", "last_name", "dob", "ssn"]),
  );
  const log = getLogger("invite-identity-from-config-test");
  log.setLevel("silent");
  const warnSpy = vi.spyOn(log, "warn");
  for (const identity of [undefined, "   "]) {
    const { dir, configPath, keyPath } = withConfig(terms);
    try {
      const ready = await validateInvite({
        resolved: { mode: "offline" },
        options: testOptions({
          configFile: configPath,
          keyFile: keyPath,
          identity,
        }),
        acceptTimeout: 900,
        log,
      });
      expect(ready.mode).toBe("offlineFromConfig");
      if (ready.mode !== "offlineFromConfig") return;
      expect(ready.linkageTerms.identity).toBe("Agency Config");
      const token = await decodeInvitation(ready.invitation);
      expect(token.linkageTerms.identity).toBe("Agency Config");
      expect(
        warnSpy.mock.calls
          .map((call) => String(call[0]))
          .filter((message) => message.includes("--identity")),
      ).toEqual([]);
    } finally {
      warnSpy.mockClear();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  warnSpy.mockRestore();
});

test("validateInvite: --identity over a reused config is reported, not applied", async () => {
  // The flag cannot silently re-label terms the config is authoritative for, and
  // dropping it silently would leave the operator reading their own value in the
  // invitation. Named as ignored, like --linkage-strategy on the same path.
  const terms = getDefaultLinkageTerms(
    "Agency Config",
    inferMetadata(["first_name", "last_name", "dob", "ssn"]),
  );
  const { dir, configPath, keyPath } = withConfig(terms);
  const log = getLogger("invite-identity-ignored-test");
  log.setLevel("silent");
  const warnSpy = vi.spyOn(log, "warn");
  try {
    const ready = await validateInvite({
      resolved: { mode: "offline" },
      options: testOptions({
        configFile: configPath,
        keyFile: keyPath,
        identity: "Agency Flag",
      }),
      acceptTimeout: 900,
      log,
    });
    expect(ready.mode).toBe("offlineFromConfig");
    if (ready.mode !== "offlineFromConfig") return;
    // The token the partner reads holds the config's label, not the flag's.
    expect(ready.linkageTerms.identity).toBe("Agency Config");
    const token = await decodeInvitation(ready.invitation);
    expect(token.linkageTerms.identity).toBe("Agency Config");
    const ignored = warnSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((message) => message.includes("--identity"));
    expect(ignored).toHaveLength(1);
    expect(ignored[0]).toContain(
      "has no effect when the linkage terms come from an existing " +
        "configuration file",
    );
    expect(ignored[0]).toContain('"Agency Flag"');
    expect(ignored[0]).toContain('"Agency Config"');
    expect(ignored[0]).toContain(configPath);
  } finally {
    warnSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateInvite: a config still holding the init placeholder is refused, minting nothing", async () => {
  // The template's identity is a well-formed label every schema accepts, so an
  // operator who fills in the connection block and passes over this field would
  // otherwise mint an invitation -- and a partnership every later run sends --
  // naming their party the words asking for the name.
  const { dir, configPath, keyPath } = withConfig(
    getDefaultLinkageTerms(
      PLACEHOLDER_IDENTITY,
      inferMetadata(["first_name", "last_name", "dob", "ssn"]),
    ),
  );
  const log = getLogger("invite-identity-placeholder-test");
  log.setLevel("silent");
  try {
    for (const identity of [undefined, "Agency Flag"]) {
      await expect(
        validateInvite({
          resolved: { mode: "offline" },
          options: testOptions({
            configFile: configPath,
            keyFile: keyPath,
            ...(identity !== undefined && { identity }),
          }),
          acceptTimeout: 900,
          log,
        }),
      ).rejects.toThrow(configuredIdentityStillPlaceholder(configPath));
    }
    expect(fs.existsSync(keyPath)).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateInvite: a config holding no identity is refused, flag or not", async () => {
  // Inviting authors a partnership the partner reads a name off, and this path
  // persists the configuration unchanged -- so a label given for this one
  // invocation would name the partnership in the invitation and nowhere after
  // it. Refuse, naming the field to set, whether or not --identity was typed.
  const named = getDefaultLinkageTerms(
    "Agency Config",
    inferMetadata(["first_name", "last_name", "dob", "ssn"]),
  );
  const { identity: _dropped, ...unnamed } = named;
  const { dir, configPath, keyPath } = withConfig(unnamed as LinkageTerms);
  const log = getLogger("invite-identity-absent-test");
  log.setLevel("silent");
  try {
    for (const identity of [undefined, "Agency Flag"]) {
      await expect(
        validateInvite({
          resolved: { mode: "offline" },
          options: testOptions({
            configFile: configPath,
            keyFile: keyPath,
            ...(identity !== undefined && { identity }),
          }),
          acceptTimeout: 900,
          log,
        }),
      ).rejects.toThrow(configuredIdentityRequired(configPath));
    }
    // The refusal lands before anything is written: no key file, and the config
    // is the one the fixture wrote.
    expect(fs.existsSync(keyPath)).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateInvite: --identity over a reused config redacts a planted key marker", async () => {
  // A label containing a private-key BEGIN marker must not survive to the log
  // sink, whose dangling-marker redaction would otherwise swallow the rest of
  // the line -- the config label, path, and remedy -- behind it.
  const terms = getDefaultLinkageTerms(
    "Agency Config",
    inferMetadata(["first_name", "last_name", "dob", "ssn"]),
  );
  const { dir, configPath, keyPath } = withConfig(terms);
  const log = getLogger("invite-identity-key-marker-test");
  log.setLevel("silent");
  const warnSpy = vi.spyOn(log, "warn");
  try {
    const ready = await validateInvite({
      resolved: { mode: "offline" },
      options: testOptions({
        configFile: configPath,
        keyFile: keyPath,
        identity: "-----BEGIN OPENSSH PRIVATE KEY-----",
      }),
      acceptTimeout: 900,
      log,
    });
    expect(ready.mode).toBe("offlineFromConfig");
    const ignored = warnSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((message) => message.includes("--identity"));
    expect(ignored).toHaveLength(1);
    expect(ignored[0]).toContain("[redacted private key]");
    expect(ignored[0]).not.toContain("BEGIN OPENSSH PRIVATE KEY");
    expect(ignored[0]).toContain(configPath);
    expect(ignored[0]).toMatch(/to change it\.$/);
  } finally {
    warnSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateInvite: a config citing a rule set its own keys left is reported at the mint", async () => {
  // The citation the config holds rides the token to the partner, so a hand
  // edit that took the keys out of the cited set is named here rather than after
  // the invitation has left. The mint is not blocked by it.
  const terms = defaultTerms();
  const [first, second, ...rest] = terms.linkageKeys;
  const { dir, configPath, keyPath } = withConfig({
    ...terms,
    linkageKeys: [second!, first!, ...rest],
  });
  const log = getLogger("invite-citation-drift-test");
  log.setLevel("silent");
  const warnSpy = vi.spyOn(log, "warn");
  try {
    const ready = await validateInvite({
      resolved: { mode: "offline" },
      options: testOptions({ configFile: configPath, keyFile: keyPath }),
      acceptTimeout: 900,
      log,
    });
    expect(ready.mode).toBe("offlineFromConfig");
    const drifted = warnSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((message) => message.includes("linkage_rule_set"));
    expect(drifted).toHaveLength(1);
    expect(drifted[0]).toContain(configPath);
  } finally {
    warnSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateInvite: a drifted citation on accepted terms offers the mint's own remedy", async () => {
  // The config holds an acceptance's record, so these terms are agreed with
  // the party that invited this operator: restoring the cited set's rules would
  // edit that agreement single-handedly. What this operator is doing is minting
  // an invitation of their own, where declining to reuse the terms and accepting
  // again are not choices they have -- authoring fresh terms for the invitation
  // is.
  const terms = defaultTerms();
  const [first, second, ...rest] = terms.linkageKeys;
  const { dir, configPath, keyPath } = withConfig(
    { ...terms, linkageKeys: [second!, first!, ...rest] },
    undefined,
    undefined,
    false,
  );
  const log = getLogger("invite-accepted-citation-drift-test");
  log.setLevel("silent");
  const warnSpy = vi.spyOn(log, "warn");
  try {
    await validateInvite({
      resolved: { mode: "offline" },
      options: testOptions({ configFile: configPath, keyFile: keyPath }),
      acceptTimeout: 900,
      log,
    });
    const drifted = warnSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((message) => message.includes("linkage_rule_set"));
    expect(drifted).toHaveLength(1);
    expect(drifted[0]).toContain("not yours alone to correct");
    expect(drifted[0]).toContain("author fresh terms for this invitation");
    expect(drifted[0]).not.toContain("decline to reuse these terms");
    expect(drifted[0]).not.toContain("accept again");
  } finally {
    warnSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateInvite: config-as-source threads the disclosed subset for the send commitment", async () => {
  // A config with an explicit metadata block: the disclosed set is derived from
  // it, held on the token, AND threaded to the handler so it is persisted into
  // the reused config's disclosed_payload_columns (closing the init-config gap and
  // refreshing a stale prior commitment on re-invite).
  const terms = defaultTerms();
  const metadata = inferMetadata([
    "first_name",
    "last_name",
    "dob",
    "ssn",
    "notes",
  ]);
  const { dir, configPath, keyPath } = withConfig(terms, undefined, metadata);
  try {
    const ready = await validateInvite({
      resolved: { mode: "offline" },
      options: testOptions({ configFile: configPath, keyFile: keyPath }),
      acceptTimeout: 900,
      log: silentLog,
    });
    expect(ready.mode).toBe("offlineFromConfig");
    if (ready.mode !== "offlineFromConfig") return;
    const token = await decodeInvitation(ready.invitation);
    expect(ready.disclosedPayloadColumns).toEqual(
      disclosedColumnNames(metadata),
    );
    expect(ready.disclosedPayloadColumns).toEqual(
      token.disclosedPayloadColumns,
    );
    expect(ready.disclosedPayloadColumns).toEqual(["notes"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateInvite: config-as-source with no metadata block has no commitment (lazy)", async () => {
  // Without a metadata block the transmitted set is unknown at mint, so nothing is
  // committed and the handler removes any stale field rather than freezing one.
  const terms = defaultTerms();
  const { dir, configPath, keyPath } = withConfig(terms);
  try {
    const ready = await validateInvite({
      resolved: { mode: "offline" },
      options: testOptions({ configFile: configPath, keyFile: keyPath }),
      acceptTimeout: 900,
      log: silentLog,
    });
    expect(ready.mode).toBe("offlineFromConfig");
    if (ready.mode !== "offlineFromConfig") return;
    expect(ready.disclosedPayloadColumns).toBeUndefined();
    const token = await decodeInvitation(ready.invitation);
    expect(token.disclosedPayloadColumns).toBeUndefined();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateInvite: a config plus an agreeing input file succeeds from the config", async () => {
  const terms = defaultTerms();
  const { dir, configPath, keyPath } = withConfig(terms);
  try {
    const input = writeCsv(dir, "first_name,last_name,dob,ssn");
    const ready = await validateInvite({
      resolved: { mode: "offline", input },
      options: testOptions({ configFile: configPath, keyFile: keyPath }),
      acceptTimeout: 900,
      log: silentLog,
    });
    expect(ready.mode).toBe("offlineFromConfig");
    if (ready.mode !== "offlineFromConfig") return;
    expect(ready.linkageTerms).toEqual(terms);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- The mint-boundary linkage gate ------------------------------------------

// Two keys over two fields, so a CSV missing one column leaves an enumeration
// small enough to read whole (the default terms declare more keys than the cause
// chain renders).
function twoKeyTerms(): LinkageTerms {
  return {
    ...defaultTerms(),
    linkageFields: [
      { name: "dob", type: "date_of_birth" },
      { name: "ssn", type: "ssn" },
    ],
    linkageKeys: [
      { name: "DOB", elements: [{ field: "dob" }] },
      { name: "SSN", elements: [{ field: "ssn" }] },
    ],
  };
}

// One key whose own cleaning is self-defeating: its field resolves to a present
// column, so the field-coverage verdict passes, and the key still produces
// nothing for any record.
function deadKeyTerms(): LinkageTerms {
  return {
    ...defaultTerms(),
    linkageFields: [{ name: "dob", type: "date_of_birth" }],
    linkageKeys: [
      {
        name: "DOB",
        elements: [
          {
            field: "dob",
            transform: [
              { function: "parse_date", params: { inputFormat: "MM/DD" } },
            ],
          },
        ],
      },
    ],
  };
}

// The mint refusal rendered the way the CLI's error boundary renders it
// (`sanitizeErrorForDisplay` in `runOrExit`): the names sit on cause links, which
// the error's own `.message` does not hold.
async function mintRefusal(params: {
  terms: LinkageTerms;
  header: string;
}): Promise<{ rendered: string; configPath: string; dir: string }> {
  const { dir, configPath, keyPath } = withConfig(params.terms);
  const input = writeCsv(dir, params.header);
  let thrown: unknown;
  try {
    await validateInvite({
      resolved: { mode: "offline", input },
      options: testOptions({ configFile: configPath, keyFile: keyPath }),
      acceptTimeout: 900,
      log: silentLog,
    });
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(LinkageTermsUnsatisfiableError);
  // A UsageError subclass, so the CLI's error->exit boundary reports exit 64.
  expect(thrown).toBeInstanceOf(UsageError);
  return { rendered: sanitizeErrorForDisplay(thrown), configPath, dir };
}

test("validateInvite: a config plus a disagreeing input is refused before minting", async () => {
  const { rendered, configPath, dir } = await mintRefusal({
    terms: twoKeyTerms(),
    header: "dob,notes,memo,comment",
  });
  try {
    expect(rendered).toContain(
      "this CSV cannot satisfy every linkage key the configuration declares",
    );
    expect(rendered).toContain(
      "1 of the 2 linkage keys cannot be produced from this input's columns",
    );
    // The mint holds nobody to these terms yet, so the shared fragment counts the
    // keys without calling them agreed.
    expect(rendered).not.toContain("agreed linkage key");
    expect(rendered).toContain("linkage key the CSV cannot produce: SSN");
    expect(rendered).toContain("unsatisfied field: ssn (ssn)");
    // The mint states what generating would cost and points at the operator's
    // own authoring, naming the file the terms came from: there is no partner to
    // renegotiate with until this invitation is sent.
    expect(rendered).toContain(
      "Generating an invitation would hand your partner terms that this " +
        "configuration's own exchange refuses to run",
    );
    expect(rendered).toContain(
      "Provide a CSV that covers the required field types, then generate the " +
        `invitation again; these terms come from ${configPath}.`,
    );
    expect(rendered).not.toContain("ask your partner");
    expect(rendered).not.toContain("re-establish the exchange");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateInvite: a config whose key cleaning drops every record is refused before minting", async () => {
  // The column the key needs is present, so the field-coverage verdict passes;
  // the key is still self-defeating, and an invitation holding it would mint,
  // reach a partner, and then be refused by this party's own `psilink exchange`.
  const { rendered, configPath, dir } = await mintRefusal({
    terms: deadKeyTerms(),
    header: "first_name,last_name,dob,ssn",
  });
  try {
    expect(rendered).toContain(
      "the cleaning declared for the one linkage key drops every record",
    );
    expect(rendered).toContain("linkage key that drops every record: DOB");
    // The remedy is terms-side only: no column is missing, so nothing asks for a
    // different CSV.
    expect(rendered).toContain(
      "Correct the cleaning steps those keys declare, then generate the " +
        `invitation again; these terms come from ${configPath}.`,
    );
    expect(rendered).not.toContain("Provide a CSV");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateInvite: a config declaring no linkage key never reaches the mint gate", async () => {
  // The third blocking shape the mint gate grades. A configuration cannot hold
  // it: the terms schema floors linkageKeys at one entry, so the config parse
  // refuses the document before the gate sees it. The gate still grades the shape
  // (it consumes core's whole verdict), which is what keeps a terms document
  // reaching it by some other route from minting vacuously.
  const { dir, configPath, keyPath } = withConfig({
    ...twoKeyTerms(),
    linkageKeys: [],
  });
  try {
    const input = writeCsv(dir, "first_name,last_name,dob,ssn");
    const promise = validateInvite({
      resolved: { mode: "offline", input },
      options: testOptions({ configFile: configPath, keyFile: keyPath }),
      acceptTimeout: 900,
      log: silentLog,
    });
    await expect(promise).rejects.toThrow(/linkage_keys/);
    await expect(promise).rejects.not.toBeInstanceOf(
      LinkageTermsUnsatisfiableError,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateInvite: a config whose payload.send over-declares is rejected before minting", async () => {
  // An explicit metadata block gates `secret` off (role: ignored), but the
  // hand-authored payload.send still lists it. The over-declaration must be
  // caught at the mint boundary, before the token or the partner's consent
  // screen can show a column whose values never flow.
  const terms: LinkageTerms = {
    ...defaultTerms(),
    payload: { send: [{ name: "secret" }] },
  };
  const metadata: Metadata = [
    {
      name: "first_name",
      type: "first_name",
      role: "linkage",
      isPayload: false,
    },
    { name: "secret", type: "other", role: "ignored", isPayload: true },
  ];
  const { dir, configPath, keyPath } = withConfig(terms, undefined, metadata);
  try {
    const promise = validateInvite({
      resolved: { mode: "offline" },
      options: testOptions({ configFile: configPath, keyFile: keyPath }),
      acceptTimeout: 900,
      log: silentLog,
    });
    await expect(promise).rejects.toBeInstanceOf(UsageError);
    await expect(promise).rejects.toThrow(/secret/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateInvite: a config's explicit standardization lets an otherwise-unsatisfying input pass", async () => {
  const terms = defaultTerms();
  // The config maps tax_id -> ssn explicitly; the input has tax_id (inferred
  // as an identifier, not ssn) rather than an ssn column, so without the
  // standardization the ssn field would be unsatisfiable. The remap binds only a
  // `role: linkage` column (matching participation is the explicit linkage role),
  // so the config roles tax_id linkage while leaving its type non-ssn -- the
  // remap, not the type fallback, is what binds it.
  const metadata: Metadata = [
    {
      name: "first_name",
      type: "first_name",
      role: "linkage",
      isPayload: false,
    },
    { name: "last_name", type: "last_name", role: "linkage", isPayload: false },
    { name: "dob", type: "date_of_birth", role: "linkage", isPayload: false },
    { name: "tax_id", type: "identifier", role: "linkage", isPayload: false },
  ];
  const { dir, configPath, keyPath } = withConfig(
    terms,
    [
      {
        output: "ssn",
        input: "tax_id",
        steps: [{ function: "trim_whitespace" }],
      },
    ],
    metadata,
  );
  try {
    const input = writeCsv(dir, "first_name,last_name,dob,tax_id");
    const ready = await validateInvite({
      resolved: { mode: "offline", input },
      options: testOptions({ configFile: configPath, keyFile: keyPath }),
      acceptTimeout: 900,
      log: silentLog,
    });
    expect(ready.mode).toBe("offlineFromConfig");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateInvite: offline config-source refuses a standardization that contradicts its terms, before minting", async () => {
  // The mint-boundary counterpart of the exchange-time fail-closed check: a config
  // whose authored standardization names an output that is no declared linkage
  // field must be refused BEFORE the token is disclosed, so `invite` never mints a
  // token the config's own `psilink exchange` would then reject (exit 64). No input
  // is passed, so this exercises the check in isolation from the input-satisfiability
  // gate.
  const terms = defaultTerms();
  const { dir, configPath, keyPath } = withConfig(terms, [
    { output: "definitely_not_a_field_xyz", input: "first_name" },
  ]);
  try {
    const invite = () =>
      validateInvite({
        resolved: { mode: "offline" },
        options: testOptions({ configFile: configPath, keyFile: keyPath }),
        acceptTimeout: 900,
        log: silentLog,
      });
    await expect(invite()).rejects.toThrow(StandardizationTermsError);
    // The refusal names the offending output, so the operator can fix the config.
    await expect(invite()).rejects.toThrow(/definitely_not_a_field_xyz/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateInvite: offline config-source mints a conforming psi-c config", async () => {
  // The mint boundary mirrors the run: the exchange conducts a count-only run, so a
  // config in the count-only SHAPE (one key, cascade, no deduplication, no payload)
  // reaches a token rather than the algorithm gate. What the shape rules refuse
  // instead is covered by the cases below. No input is passed, so this exercises the
  // mint-boundary checks in isolation.
  const terms: LinkageTerms = countOnlyTerms();
  const { dir, configPath, keyPath } = withConfig(terms);
  try {
    const minted = await validateInvite({
      resolved: { mode: "offline" },
      options: testOptions({ configFile: configPath, keyFile: keyPath }),
      acceptTimeout: 900,
      log: silentLog,
    });
    if (minted.mode !== "offlineFromConfig")
      throw new Error(`expected an offline config mint, got ${minted.mode}`);
    expect(minted.linkageTerms.algorithm).toBe("psi-c");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateInvite: offline config-source refuses an algorithm with no run path before minting", async () => {
  // The mint-boundary counterpart of the exchange-time gate: an algorithm no run
  // path honors is refused BEFORE the token is disclosed, so `invite` never mints
  // an invitation the config's own `psilink exchange` would then refuse (exit 64).
  // The terms reach the mint past the config parse (see the module mock at the top
  // of this file), which is the shape a member added to AlgorithmSchema ahead of
  // its run path takes at this boundary.
  const { dir, configPath, keyPath } = withConfig(defaultTerms());
  vi.mocked(loadConfigLinkageSource).mockReturnValueOnce({
    linkageTerms: { ...defaultTerms(), algorithm: "psi-x" as Algorithm },
    retainsFiles: false,
    linkageTermsStanding: "held-alone",
  });
  try {
    let thrown: unknown;
    try {
      await validateInvite({
        resolved: { mode: "offline" },
        options: testOptions({ configFile: configPath, keyFile: keyPath }),
        acceptTimeout: 900,
        log: silentLog,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(UsageError);
    // Named by what this build runs, not by the value handed to it: the algorithm
    // can be adopted from a partner's document, so the message states only the
    // fixed enum literals.
    expect(String(thrown)).toMatch(/not yet implemented/);
    expect(String(thrown)).not.toMatch(/psi-x/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The count-only shape refusals at the CLI's authoring boundary. The four
// rules the terms alone state are refused as the config's linkage terms are
// read (the shared schema), which is before the token is minted and is where
// the operator meets them; the fifth reads this party's own metadata, which no
// linkage-terms document states, so it is refused at the mint boundary itself.
test.each([
  {
    rule: "more than one linkage key",
    edit: (terms: LinkageTerms): LinkageTerms => ({
      ...terms,
      linkageKeys: defaultTerms().linkageKeys.slice(0, 2),
    }),
    expected: /exactly one linkage key/,
  },
  {
    rule: "linkage_strategy: single-pass",
    edit: (terms: LinkageTerms): LinkageTerms => ({
      ...terms,
      linkageStrategy: "single-pass",
    }),
    expected: /linkage strategy to "cascade"/,
  },
  {
    rule: "deduplicate: true",
    edit: (terms: LinkageTerms): LinkageTerms => ({
      ...terms,
      deduplicate: true,
    }),
    expected: /set deduplicate to false/,
  },
  {
    rule: "a payload column",
    edit: (terms: LinkageTerms): LinkageTerms => ({
      ...terms,
      payload: { send: [{ name: "notes" }] },
    }),
    expected: /no payload columns in either direction/,
  },
])(
  "validateInvite: offline config-source refuses a count-only config declaring $rule",
  async ({ edit, expected }) => {
    const { dir, configPath, keyPath } = withConfig(edit(countOnlyTerms()));
    try {
      const invite = () =>
        validateInvite({
          resolved: { mode: "offline" },
          options: testOptions({ configFile: configPath, keyFile: keyPath }),
          acceptTimeout: 900,
          log: silentLog,
        });
      await expect(invite()).rejects.toBeInstanceOf(UsageError);
      // The rule broken, not the generic "psi-c is not implemented yet": the
      // operator is told what to change about the document in front of them.
      await expect(invite()).rejects.toThrow(expected);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("validateInvite: offline config-source refuses a count-only config whose metadata sends a column", async () => {
  // The one count-only rule the terms cannot state: this party's own metadata
  // marks `notes` for transmission, which a count-only exchange makes no room
  // for. Refused before the token is minted, and ahead of the algorithm gate, so
  // the operator is told which marking to clear rather than only that the
  // algorithm is not runnable yet.
  const metadata = inferMetadata([
    "first_name",
    "last_name",
    "dob",
    "ssn",
    "notes",
  ]);
  expect(disclosedColumnNames(metadata)).toEqual(["notes"]);
  const { dir, configPath, keyPath } = withConfig(
    countOnlyTerms(),
    undefined,
    metadata,
  );
  try {
    const invite = () =>
      validateInvite({
        resolved: { mode: "offline" },
        options: testOptions({ configFile: configPath, keyFile: keyPath }),
        acceptTimeout: 900,
        log: silentLog,
      });
    await expect(invite()).rejects.toBeInstanceOf(UsageError);
    await expect(invite()).rejects.toThrow(/transmits no data columns/);
    // Named by the rule, not by the column: the same refusal is composed on the
    // accept side beside a partner's document.
    await expect(invite()).rejects.not.toThrow(/notes/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateInvite: an explicit empty payload pair still names the count-only rule, not the generic disclosure one", async () => {
  // The shape rules permit an explicit `payload: {send: [], receive: []}`, so
  // this document passes the terms-shape refine. But
  // assertPayloadSendDisclosed's own empty-send fast path requires
  // output.shareWithPartner: false, and these terms have shareWithPartner:
  // true (the default), so metadata marking a column disclosed falls through
  // to the generic disclosure message unless the count-only check runs first.
  const metadata = inferMetadata([
    "first_name",
    "last_name",
    "dob",
    "ssn",
    "notes",
  ]);
  expect(disclosedColumnNames(metadata)).toEqual(["notes"]);
  const terms: LinkageTerms = {
    ...countOnlyTerms(),
    payload: { send: [], receive: [] },
  };
  const { dir, configPath, keyPath } = withConfig(terms, undefined, metadata);
  try {
    const invite = () =>
      validateInvite({
        resolved: { mode: "offline" },
        options: testOptions({ configFile: configPath, keyFile: keyPath }),
        acceptTimeout: 900,
        log: silentLog,
      });
    await expect(invite()).rejects.toBeInstanceOf(UsageError);
    await expect(invite()).rejects.toThrow(/transmits no data columns/);
    await expect(invite()).rejects.not.toThrow(
      /payload\.send must name exactly/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateInvite: a psi config with the same metadata and shape still mints", async () => {
  // The narrowing claim at this boundary: every refusal above reads the
  // algorithm first, so the identical document under `psi` is untouched.
  const metadata = inferMetadata([
    "first_name",
    "last_name",
    "dob",
    "ssn",
    "notes",
  ]);
  const { dir, configPath, keyPath } = withConfig(
    { ...defaultTerms(), deduplicate: false },
    undefined,
    metadata,
  );
  try {
    const ready = await validateInvite({
      resolved: { mode: "offline" },
      options: testOptions({ configFile: configPath, keyFile: keyPath }),
      acceptTimeout: 900,
      log: silentLog,
    });
    expect(ready.mode).toBe("offlineFromConfig");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test.each(["cascade", "single-pass"] as const)(
  "validateInvite: offline config-source mints a deduplicating %s term",
  async (linkageStrategy) => {
    // Both strategies match a deduplicating cardinality, so both mint; a
    // strategy that stopped matching would be refused here BEFORE the token is
    // disclosed, never minting an invitation the config's own `psilink
    // exchange` would then reject (exit 64). Acceptance derives its own
    // deduplicate as false, so the accepted pair is the one-sided one both
    // strategies run (linkageCardinality.test.ts covers it end to end).
    const terms: LinkageTerms = {
      ...defaultTerms(),
      deduplicate: true,
      linkageStrategy,
    };
    const { dir, configPath, keyPath } = withConfig(terms);
    try {
      const ready = await validateInvite({
        resolved: { mode: "offline" },
        options: testOptions({ configFile: configPath, keyFile: keyPath }),
        acceptTimeout: 900,
        log: silentLog,
      });
      expect(ready.mode).toBe("offlineFromConfig");
      if (ready.mode !== "offlineFromConfig") throw new Error("unreachable");
      expect(ready.linkageTerms.deduplicate).toBe(true);
      expect(ready.linkageTerms.linkageStrategy).toBe(linkageStrategy);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("validateInvite: offline config-source refuses a fan-out standardization before minting", async () => {
  // The mint-boundary counterpart of the run-side fan-out refusal (cascade
  // terms match one value per record, so a splitting record's candidate set
  // has no round to enter): a config whose hand-authored standardization
  // declares `split_on` must be refused BEFORE the token is disclosed, not
  // left for the config's own `psilink exchange` to reject later (exit 64).
  // An OperatorConfigError, since a standardization is only this party's own authoring.
  const terms = defaultTerms();
  const { dir, configPath, keyPath } = withConfig(terms, [
    {
      output: "last_name",
      input: "last_name",
      steps: [{ function: "split_on", params: { delimiter: "-" } }],
    },
  ]);
  try {
    const invite = () =>
      validateInvite({
        resolved: { mode: "offline" },
        options: testOptions({ configFile: configPath, keyFile: keyPath }),
        acceptTimeout: 900,
        log: silentLog,
      });
    await expect(invite()).rejects.toBeInstanceOf(OperatorConfigError);
    await expect(invite()).rejects.toThrow(/split_on/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateInvite: offline config-source refuses a fan-out element transform before minting", async () => {
  // The second authoring surface only this config-as-source path can hold: a
  // linkage key whose element transform declares `split_on`, refused at the same
  // mint boundary. A plain UsageError, not an OperatorConfigError -- an acceptor
  // adopts element transforms verbatim from the partner's invitation, so the
  // fault is not provably the local operator's own content.
  const base = defaultTerms();
  const [firstKey, ...restKeys] = base.linkageKeys;
  const terms: LinkageTerms = {
    ...base,
    linkageKeys: [
      {
        ...firstKey,
        elements: firstKey.elements.map((element, i) =>
          i === 0
            ? {
                ...element,
                transform: [
                  { function: "split_on", params: { delimiter: "-" } },
                ],
              }
            : element,
        ),
      },
      ...restKeys,
    ],
  };
  const { dir, configPath, keyPath } = withConfig(terms);
  try {
    const invite = () =>
      validateInvite({
        resolved: { mode: "offline" },
        options: testOptions({ configFile: configPath, keyFile: keyPath }),
        acceptTimeout: 900,
        log: silentLog,
      });
    await expect(invite()).rejects.toBeInstanceOf(UsageError);
    await expect(invite()).rejects.not.toBeInstanceOf(OperatorConfigError);
    await expect(invite()).rejects.toThrow(/split_on/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateInvite: offline config-source mints a fan-out under single-pass", async () => {
  // The admitted half of the same gate, and the path an operator is sent to: the
  // web editor authors no fan-out, so a config naming single-pass is where one is
  // written, and the mint must accept it rather than refuse it. Both authoring
  // surfaces at once -- the config's own standardization and a key's element
  // transform.
  const base = defaultTerms();
  const [firstKey, ...restKeys] = base.linkageKeys;
  const terms: LinkageTerms = {
    ...base,
    linkageStrategy: "single-pass",
    linkageKeys: [
      {
        ...firstKey,
        elements: firstKey.elements.map((element, i) =>
          i === 0
            ? {
                ...element,
                transform: [
                  { function: "split_on", params: { delimiter: " " } },
                ],
              }
            : element,
        ),
      },
      ...restKeys,
    ],
  };
  const { dir, configPath, keyPath } = withConfig(terms, [
    {
      output: "last_name",
      input: "last_name",
      steps: [{ function: "split_on", params: { delimiter: " " } }],
    },
  ]);
  try {
    await expect(
      validateInvite({
        resolved: { mode: "offline" },
        options: testOptions({ configFile: configPath, keyFile: keyPath }),
        acceptTimeout: 900,
        log: silentLog,
      }),
    ).resolves.toBeDefined();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateInvite: a config's explicit metadata lets an otherwise-unsatisfying input pass", async () => {
  const terms = defaultTerms();
  // The config's metadata types tax_id as ssn; the input has tax_id, which
  // name inference would type as an identifier (not ssn). Without honoring the
  // config metadata the ssn field would look unsatisfiable and invite would
  // refuse, even though the exchange (which uses the metadata) can produce it.
  const metadata: Metadata = [
    {
      name: "first_name",
      type: "first_name",
      role: "linkage",
      isPayload: false,
    },
    { name: "last_name", type: "last_name", role: "linkage", isPayload: false },
    { name: "dob", type: "date_of_birth", role: "linkage", isPayload: false },
    { name: "tax_id", type: "ssn", role: "linkage", isPayload: false },
  ];
  const { dir, configPath, keyPath } = withConfig(terms, undefined, metadata);
  try {
    const input = writeCsv(dir, "first_name,last_name,dob,tax_id");
    const ready = await validateInvite({
      resolved: { mode: "offline", input },
      options: testOptions({ configFile: configPath, keyFile: keyPath }),
      acceptTimeout: 900,
      log: silentLog,
    });
    expect(ready.mode).toBe("offlineFromConfig");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateInvite: config-sourced invite still refuses a pre-existing key file", async () => {
  const terms = defaultTerms();
  const { dir, configPath, keyPath } = withConfig(terms);
  try {
    fs.writeFileSync(
      keyPath,
      JSON.stringify({
        sharedSecret: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      }),
    );
    await expect(
      validateInvite({
        resolved: { mode: "offline" },
        options: testOptions({ configFile: configPath, keyFile: keyPath }),
        acceptTimeout: 900,
        log: silentLog,
      }),
    ).rejects.toBeInstanceOf(UsageError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateInvite: with no config and an input file, terms are inferred and written", async () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-invite-infer-"));
  try {
    const input = writeCsv(dir, "first_name,last_name,dob,ssn");
    const ready = await validateInvite({
      resolved: { mode: "offline", input },
      // Fresh, non-existent config/key paths: the input-only inference path.
      options: testOptions(),
      acceptTimeout: 900,
      log: silentLog,
    });
    expect(ready.mode).toBe("offline");
    if (ready.mode !== "offline") return;
    expect(ready.dataSpec.linkageTerms.identity).toBeTypeOf("string");
    expect(ready.dataSpec.metadata).toBeDefined();
    expect(ready.dataSpec.standardization).toBeDefined();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- validateInvite: offline connection-override warning ---------------------

test("validateInvite: offline warns that a --server-* override is ignored", async () => {
  // The offline path writes a placeholder connection block, so a --server-*
  // override cannot take effect; it must be shown rather than silently dropped.
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-invite-override-"));
  tmpDirs.push(dir);
  const input = writeCsv(dir, "first_name,last_name,dob,ssn");
  const log = getLogger("invite-offline-override-warn");
  log.setLevel("warn");
  const warnSpy = vi.spyOn(log, "warn");
  await validateInvite({
    resolved: { mode: "offline", input },
    options: testOptions({
      configFile: path.join(dir, "psilink.yaml"),
      keyFile: path.join(dir, ".psilink.key"),
      serverUsername: "alice",
    }),
    acceptTimeout: 900,
    log,
  });
  expect(
    warnSpy.mock.calls.some(
      (c) =>
        typeof c[0] === "string" &&
        c[0].includes("--server-username") &&
        c[0].includes("no effect on an offline invite/accept"),
    ),
  ).toBe(true);
  warnSpy.mockRestore();
});

test("validateInvite: online does not warn about a --server-* override (it is applied)", async () => {
  // The online path builds the connection from the URL through
  // applyConnectionOverrides, so the override takes effect and no ignored-override
  // warning is emitted.
  const { input, options } = onlineFixture();
  const log = getLogger("invite-online-override-nowarn");
  log.setLevel("warn");
  const warnSpy = vi.spyOn(log, "warn");
  const ready = await validateInvite({
    resolved: { mode: "online", url: new URL("sftp://host/drop"), input },
    options: { ...options, serverUsername: "alice" },
    acceptTimeout: 900,
    log,
  });
  expect(ready.mode).toBe("online");
  if (ready.mode !== "online") return;
  if (ready.connection.channel !== "sftp") throw new Error("expected sftp");
  expect(ready.connection.server.username).toBe("alice");
  expect(
    warnSpy.mock.calls.some(
      (c) =>
        typeof c[0] === "string" &&
        c[0].includes("no effect on an offline invite/accept"),
    ),
  ).toBe(false);
  warnSpy.mockRestore();
});

test("validateInvite: offline warns that a connection-options override is ignored", async () => {
  // The offline path writes a placeholder connection block with no `options`
  // block, so a --peer-timeout (or any connection-options) override cannot take
  // effect; it must be shown, with a remedy distinct from the server warning's
  // -- pointing at connection.options.
  const dir = fs.mkdtempSync(
    path.join(tmpdir(), "psilink-invite-opt-override-"),
  );
  tmpDirs.push(dir);
  const input = writeCsv(dir, "first_name,last_name,dob,ssn");
  const log = getLogger("invite-offline-opt-override-warn");
  log.setLevel("warn");
  const warnSpy = vi.spyOn(log, "warn");
  await validateInvite({
    resolved: { mode: "offline", input },
    options: testOptions({
      configFile: path.join(dir, "psilink.yaml"),
      keyFile: path.join(dir, ".psilink.key"),
      peerTimeout: 60,
    }),
    acceptTimeout: 900,
    log,
  });
  expect(
    warnSpy.mock.calls.some(
      (c) =>
        typeof c[0] === "string" &&
        c[0].includes("--peer-timeout") &&
        c[0].includes("connection.options"),
    ),
  ).toBe(true);
  warnSpy.mockRestore();
});

test("validateInvite: offline does not warn about connection.options when no options flag is set", async () => {
  // No connection-options flag is set, so the connection.options warning must
  // stay silent. acceptTimeout is a separate param, NOT a --peer-timeout
  // override: it feeds peerTimeout only on the online path (via the override
  // bag's `extra`), so an offline invite that sets it must not warn spuriously
  // about a dropped --peer-timeout.
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-invite-no-opt-"));
  tmpDirs.push(dir);
  const input = writeCsv(dir, "first_name,last_name,dob,ssn");
  const log = getLogger("invite-offline-no-opt-warn");
  log.setLevel("warn");
  const warnSpy = vi.spyOn(log, "warn");
  await validateInvite({
    resolved: { mode: "offline", input },
    options: testOptions({
      configFile: path.join(dir, "psilink.yaml"),
      keyFile: path.join(dir, ".psilink.key"),
    }),
    acceptTimeout: 900,
    log,
  });
  expect(
    warnSpy.mock.calls.some(
      (c) => typeof c[0] === "string" && c[0].includes("connection.options"),
    ),
  ).toBe(false);
  warnSpy.mockRestore();
});

test("validateInvite: online does not warn about a connection-options override (it is applied)", async () => {
  // The online path builds the connection from the URL through
  // applyConnectionOverrides, so a connection-options override takes effect and
  // no ignored-override warning is emitted.
  const { input, options } = onlineFixture();
  const log = getLogger("invite-online-opt-override-nowarn");
  log.setLevel("warn");
  const warnSpy = vi.spyOn(log, "warn");
  const ready = await validateInvite({
    resolved: { mode: "online", url: new URL("sftp://host/drop"), input },
    options: { ...options, maxReconnectAttempts: 5 },
    acceptTimeout: 900,
    log,
  });
  expect(ready.mode).toBe("online");
  if (ready.mode !== "online") return;
  expect(ready.connection.options?.maxReconnectAttempts).toBe(5);
  expect(
    warnSpy.mock.calls.some(
      (c) => typeof c[0] === "string" && c[0].includes("connection.options"),
    ),
  ).toBe(false);
  warnSpy.mockRestore();
});

// --- validateInvite: --expires-in override -----------------------------------

test("validateInvite: --expires-in sets the token's expiry to the override", async () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-invite-expires-"));
  tmpDirs.push(dir);
  const input = writeCsv(dir, "first_name,last_name,dob,ssn");
  const before = Date.now();
  const ready = await validateInvite({
    resolved: { mode: "offline", input },
    options: testOptions({
      configFile: path.join(dir, "psilink.yaml"),
      keyFile: path.join(dir, ".psilink.key"),
    }),
    acceptTimeout: 900,
    expiresIn: "2h",
    log: silentLog,
  });
  const after = Date.now();
  const token = await decodeInvitation(ready.invitation);
  expect(token.expires).toBeDefined();
  if (token.expires === undefined) return;
  // The expiry is two hours past the moment the token was minted, which lies in
  // [before, after]; bound it on both sides rather than assert an exact value.
  const twoHours = 2 * 60 * 60 * 1000;
  const expiresMs = new Date(token.expires).getTime();
  expect(expiresMs).toBeGreaterThanOrEqual(before + twoHours);
  expect(expiresMs).toBeLessThanOrEqual(after + twoHours);
});

test("validateInvite: omitting --expires-in keeps the one-hour default", async () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-invite-default-"));
  tmpDirs.push(dir);
  const input = writeCsv(dir, "first_name,last_name,dob,ssn");
  const before = Date.now();
  const ready = await validateInvite({
    resolved: { mode: "offline", input },
    options: testOptions({
      configFile: path.join(dir, "psilink.yaml"),
      keyFile: path.join(dir, ".psilink.key"),
    }),
    acceptTimeout: 900,
    log: silentLog,
  });
  const after = Date.now();
  const token = await decodeInvitation(ready.invitation);
  expect(token.expires).toBeDefined();
  if (token.expires === undefined) return;
  const oneHour = 60 * 60 * 1000;
  const expiresMs = new Date(token.expires).getTime();
  expect(expiresMs).toBeGreaterThanOrEqual(before + oneHour);
  expect(expiresMs).toBeLessThanOrEqual(after + oneHour);
});

test("validateInvite: a zero --expires-in is rejected before any token is minted", async () => {
  // A non-existent input would itself error once read; the duration is parsed at
  // the very top of validateInvite, so the duration rejection -- not the missing
  // input -- is what shows, proving no token is minted on a bad override.
  const promise = validateInvite({
    resolved: { mode: "offline", input: "/nonexistent/psilink-input.csv" },
    options: testOptions(),
    acceptTimeout: 900,
    expiresIn: "0m",
    log: silentLog,
  });
  await expect(promise).rejects.toBeInstanceOf(UsageError);
  await expect(promise).rejects.toThrow(/duration/);
});

test("validateInvite: an --expires-in beyond the one-year maximum is rejected before any token is minted", async () => {
  // Nonexistent input, as in the zero case: the override is bounded at the top
  // of validateInvite, so the ceiling rejection -- not the missing input -- is
  // what shows, proving no token is minted.
  const promise = validateInvite({
    resolved: { mode: "offline", input: "/nonexistent/psilink-input.csv" },
    options: testOptions(),
    acceptTimeout: 900,
    expiresIn: "366d",
    log: silentLog,
  });
  await expect(promise).rejects.toBeInstanceOf(UsageError);
  await expect(promise).rejects.toThrow(/expires-in must not exceed/);
});

test("validateInvite: an --expires-in at the one-year maximum is accepted", async () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-invite-max-"));
  tmpDirs.push(dir);
  const input = writeCsv(dir, "first_name,last_name,dob,ssn");
  const before = Date.now();
  const ready = await validateInvite({
    resolved: { mode: "offline", input },
    options: testOptions({
      configFile: path.join(dir, "psilink.yaml"),
      keyFile: path.join(dir, ".psilink.key"),
    }),
    acceptTimeout: 900,
    expiresIn: "365d",
    log: silentLog,
  });
  const after = Date.now();
  const token = await decodeInvitation(ready.invitation);
  expect(token.expires).toBeDefined();
  if (token.expires === undefined) return;
  const oneYear = 365 * 24 * 60 * 60 * 1000;
  const expiresMs = new Date(token.expires).getTime();
  expect(expiresMs).toBeGreaterThanOrEqual(before + oneYear);
  expect(expiresMs).toBeLessThanOrEqual(after + oneYear);
});

test("validateInvite: --expires-in applies on the offlineFromConfig path", async () => {
  const terms = defaultTerms();
  const { dir, configPath, keyPath } = withConfig(terms);
  try {
    const before = Date.now();
    const ready = await validateInvite({
      resolved: { mode: "offline" },
      options: testOptions({ configFile: configPath, keyFile: keyPath }),
      acceptTimeout: 900,
      expiresIn: "2h",
      log: silentLog,
    });
    const after = Date.now();
    expect(ready.mode).toBe("offlineFromConfig");
    const token = await decodeInvitation(ready.invitation);
    expect(token.expires).toBeDefined();
    if (token.expires === undefined) return;
    const twoHours = 2 * 60 * 60 * 1000;
    const expiresMs = new Date(token.expires).getTime();
    expect(expiresMs).toBeGreaterThanOrEqual(before + twoHours);
    expect(expiresMs).toBeLessThanOrEqual(after + twoHours);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateInvite: online warns when --expires-in is shorter than --accept-timeout", async () => {
  const { input, options } = onlineFixture();
  const log = getLogger("invite-lifetime-warn-test");
  log.setLevel("silent");
  const warnSpy = vi.spyOn(log, "warn");
  // 5m lifetime under a 15m accept-timeout: the inviter would wait past the
  // point the token can be honored, so the warning fires and names the resolved
  // override lifetime (300s), not the default hour.
  await validateInvite({
    resolved: { mode: "online", url: new URL("sftp://host/drop"), input },
    options,
    acceptTimeout: 900,
    expiresIn: "5m",
    log,
  });
  expect(
    warnSpy.mock.calls.some(
      (c) =>
        typeof c[0] === "string" &&
        c[0].includes("exceeds the invitation") &&
        c[0].includes("(300s)"),
    ),
  ).toBe(true);
  warnSpy.mockRestore();
});

// --- handler: repeated single-value flag -------------------------------------

test("handler: a repeated --accept-timeout is rejected (exit 64) before validation runs", async () => {
  // `psilink invite --accept-timeout 60 --accept-timeout 120`: the handler
  // reads accept-timeout via singleValue before
  // resolveInvitePositionals/validateInvite, so the repeat fails with a clean
  // usage error (exit 64) instead of reaching the `acceptTimeout <= 0` /
  // `acceptTimeout > lifetimeSeconds` comparisons with an array operand. A
  // valid input file is present, so the guard alone stops the mint, print, and write.
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-invite-dup-"));
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  try {
    const input = writeCsv(dir, "first_name,last_name,dob,ssn");
    const configFile = path.join(dir, "psilink.yaml");
    const keyFile = path.join(dir, ".psilink.key");
    await inviteHandler({
      _: [],
      $0: "psilink",
      identity: "Agency A",
      args: [input],
      "accept-timeout": [60, 120],
      "config-file": configFile,
      "key-file": keyFile,
      "log-level": "silent",
      record: false,
    } as unknown as Arguments);
    // Assert before restoring the spies: mockRestore clears the recorded calls.
    expect(exit).toHaveBeenCalledWith(64);
    // No invitation token reached stdout and neither file was written, so
    // validateInvite (and the commit that follows it) never ran.
    expect(logSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(configFile)).toBe(false);
    expect(fs.existsSync(keyFile)).toBe(false);
  } finally {
    logSpy.mockRestore();
    exit.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("handler: a bare-integer --accept-timeout is rejected (exit 64) before any side effect", async () => {
  // `psilink invite --accept-timeout 60`: the value migrated to the duration
  // syntax, so a bare number is no longer accepted. The handler parses it (via
  // durationFlagSeconds) before resolveInvitePositionals/validateInvite, so the
  // rejection fires before the offline commit would mint and print the token and
  // write both files -- exactly the no-side-effect guarantee asserted below.
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-invite-bare-"));
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  try {
    const input = writeCsv(dir, "first_name,last_name,dob,ssn");
    const configFile = path.join(dir, "psilink.yaml");
    const keyFile = path.join(dir, ".psilink.key");
    await inviteHandler({
      _: [],
      $0: "psilink",
      identity: "Agency A",
      args: [input],
      "accept-timeout": "60",
      "config-file": configFile,
      "key-file": keyFile,
      "log-level": "silent",
      record: false,
    } as unknown as Arguments);
    expect(exit).toHaveBeenCalledWith(64);
    expect(logSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(configFile)).toBe(false);
    expect(fs.existsSync(keyFile)).toBe(false);
  } finally {
    logSpy.mockRestore();
    exit.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("handler: an --accept-timeout above the 7d ceiling is rejected (exit 64) before any side effect", async () => {
  // `psilink invite --accept-timeout 8d`: the value is well-formed but past the
  // sanity ceiling, so durationFlagSeconds (with MAX_TIMEOUT_SECONDS) rejects it
  // (exit 64) before resolveInvitePositionals/validateInvite -- so the offline
  // commit never mints or prints the token or writes either file, exactly as the
  // bare-integer case above. The flag-named, max-stating message content is
  // asserted at the shared boundary (cli.test.ts). One day past the 7d cap.
  const overCeiling = `${MAX_TIMEOUT_SECONDS / 86_400 + 1}d`;
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-invite-cap-"));
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  try {
    const input = writeCsv(dir, "first_name,last_name,dob,ssn");
    const configFile = path.join(dir, "psilink.yaml");
    const keyFile = path.join(dir, ".psilink.key");
    await inviteHandler({
      _: [],
      $0: "psilink",
      identity: "Agency A",
      args: [input],
      "accept-timeout": overCeiling,
      "config-file": configFile,
      "key-file": keyFile,
      "log-level": "silent",
      record: false,
    } as unknown as Arguments);
    expect(exit).toHaveBeenCalledWith(64);
    expect(logSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(configFile)).toBe(false);
    expect(fs.existsSync(keyFile)).toBe(false);
  } finally {
    logSpy.mockRestore();
    exit.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("handler: an unrecognized --linkage-strategy is rejected (exit 64) before any side effect", async () => {
  // The handler validates the enum (parseLinkageStrategyFlag) inside runOrExit
  // before resolveInvitePositionals/validateInvite, so a bad value is a clean
  // usage error (exit 64) and no token reaches stdout and no files are written --
  // pinning the wiring symmetrically with the --accept-timeout guards above (the
  // parser itself is unit-tested in bootstrap.test.ts).
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-invite-strat-"));
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  try {
    const input = writeCsv(dir, "first_name,last_name,dob,ssn");
    const configFile = path.join(dir, "psilink.yaml");
    const keyFile = path.join(dir, ".psilink.key");
    await inviteHandler({
      _: [],
      $0: "psilink",
      identity: "Agency A",
      args: [input],
      "linkage-strategy": "complete",
      "config-file": configFile,
      "key-file": keyFile,
      "log-level": "silent",
      record: false,
    } as unknown as Arguments);
    expect(exit).toHaveBeenCalledWith(64);
    expect(logSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(configFile)).toBe(false);
    expect(fs.existsSync(keyFile)).toBe(false);
  } finally {
    logSpy.mockRestore();
    exit.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("handler: a mistyped --flag exits 64 naming it, before any side effect", async () => {
  // invite sets unknown-options-as-args, so a mistyped --server-usernam lands in
  // the positionals; it must be rejected before any conflict gate, input read, or
  // token mint, not absorbed as an input path.
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-invite-unknown-"));
  const input = writeCsv(dir, "first_name,last_name,dob,ssn");
  const configFile = path.join(dir, "psilink.yaml");
  const keyFile = path.join(dir, ".psilink.key");
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  // The run is read at the level an operator would see the rejection at: the
  // handler applies --log-level to every logger, so `silent` drops this message
  // like any other, and a logger method spied before the run is replaced by the
  // one the level installs.
  const { stderrWrites, restore } = captureStdio();
  try {
    await inviteHandler({
      _: [],
      $0: "psilink",
      identity: "Agency A",
      args: ["--server-usernam", "u", input],
      "config-file": configFile,
      "key-file": keyFile,
      "log-level": "error",
      record: false,
    } as unknown as Arguments);
    expect(exit).toHaveBeenCalledWith(64);
    expect(stderrWrites.join("")).toContain("--server-usernam");
    expect(logSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(configFile)).toBe(false);
    expect(fs.existsSync(keyFile)).toBe(false);
  } finally {
    restore();
    logSpy.mockRestore();
    exit.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- handler: the send commitment is persisted end-to-end --------------------

test("handler: offline-from-config persists the disclosed subset into the reused config", async () => {
  // The end-to-end wiring this whole change exists for. `psilink invite` from a
  // pre-existing config with a metadata block reuses that config (writing only the
  // key) and refreshes disclosed_payload_columns in place, so the later recurring
  // exchange has the commitment to check. validateInvite is tested above; this
  // proves the handler actually calls persistDisclosedPayloadColumns on the reused
  // config (the offlineFromConfig branch), not merely that the value is threaded.
  const metadata = inferMetadata([
    "first_name",
    "last_name",
    "dob",
    "ssn",
    "notes",
  ]);
  const { dir, configPath, keyPath } = withConfig(
    defaultTerms(),
    undefined,
    metadata,
  );
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  try {
    await inviteHandler({
      _: [],
      $0: "psilink",
      identity: "Agency A",
      args: [],
      "config-file": configPath,
      "key-file": keyPath,
      "log-level": "silent",
      record: false,
    } as unknown as Arguments);
    // The branch ran to completion: the key was written and no usage-error exit.
    expect(exit).not.toHaveBeenCalledWith(64);
    expect(fs.existsSync(keyPath)).toBe(true);
    // The reused config now holds the send commitment, equal to the disclosed set.
    const parsed = YAML.parse(fs.readFileSync(configPath, "utf8")) as {
      disclosed_payload_columns?: string[];
    };
    expect(parsed.disclosed_payload_columns).toEqual(
      disclosedColumnNames(metadata),
    );
    expect(parsed.disclosed_payload_columns).toEqual(["notes"]);
  } finally {
    logSpy.mockRestore();
    exit.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("handler: offline-from-config removes an acceptor-era outbound consent record", async () => {
  // A mint re-establishes the config as the inviting side, whose outbound set is
  // the disclosed-columns commitment itself: an acceptor-era record left behind
  // would go stale against re-edited metadata and refuse a later unattended run
  // with remedy text about re-accepting. Same no-field-lags-this-mint rule as the
  // commitment refresh proven above.
  const metadata = inferMetadata(["first_name", "last_name", "dob", "ssn"]);
  const { dir, configPath, keyPath } = withConfig(
    defaultTerms(),
    undefined,
    metadata,
  );
  fs.appendFileSync(
    configPath,
    "outbound_payload_consent:\n  status: confirmed\n  columns:\n" +
      "    - acceptor_era_col\n",
  );
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  try {
    await inviteHandler({
      _: [],
      $0: "psilink",
      identity: "Agency A",
      args: [],
      "config-file": configPath,
      "key-file": keyPath,
      "log-level": "silent",
      record: false,
    } as unknown as Arguments);
    expect(exit).not.toHaveBeenCalledWith(64);
    const raw = fs.readFileSync(configPath, "utf8");
    expect(raw).not.toContain("outbound_payload_consent");
    expect(raw).not.toContain("acceptor_era_col");
  } finally {
    logSpy.mockRestore();
    exit.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("handler: an offline invitation's placeholder connection has no role", async () => {
  // `role` is a WebRTC-only field: the placeholder block an offline invite writes
  // is sftp, so the stamp `psilink invite` applies must leave it alone rather
  // than write a field that channel's schema does not define.
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-invite-role-"));
  const configFile = path.join(dir, "psilink.yaml");
  const keyFile = path.join(dir, ".psilink.key");
  const input = path.join(dir, "input.csv");
  fs.writeFileSync(
    input,
    "first_name,last_name,dob,ssn\nAlice,Smith,1990-01-02,123456789\n",
  );
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  try {
    await inviteHandler({
      _: [],
      $0: "psilink",
      identity: "Agency A",
      args: [input],
      "config-file": configFile,
      "key-file": keyFile,
      "log-level": "silent",
      record: false,
    } as unknown as Arguments);
    expect(exit).not.toHaveBeenCalledWith(64);
    // Read the connection block itself: `metadata` has a `role` of its own
    // (the column's linkage/payload role), so a whole-file search would confuse
    // the two.
    const written = YAML.parse(fs.readFileSync(configFile, "utf8")) as {
      connection: Record<string, unknown>;
    };
    expect(written.connection["channel"]).toBe("sftp");
    expect(Object.keys(written.connection)).not.toContain("role");
  } finally {
    logSpy.mockRestore();
    exit.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("handler: the offline notice and the written config point at the block", async () => {
  // The durable path's only guidance: an offline invite writes an SFTP
  // placeholder, so both the notice and the file itself have to say where the
  // block for each channel is and that the tuning exists, or the operator never
  // learns filedrop, webrtc, or poll_interval_ms are available.
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-invite-guidance-"));
  tmpDirs.push(dir);
  const configFile = path.join(dir, "psilink.yaml");
  const keyFile = path.join(dir, ".psilink.key");
  const input = writeCsv(dir, "first_name,last_name,dob,ssn");
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  const stdio = captureStdio();
  try {
    await inviteHandler({
      _: [],
      $0: "psilink",
      identity: "Agency A",
      args: [input],
      "config-file": configFile,
      "key-file": keyFile,
      "log-level": "info",
      record: false,
    } as unknown as Arguments);
    const stderr = stdio.stderrWrites.join("");
    expect(exit).not.toHaveBeenCalledWith(64);
    expect(stderr).toContain("fill in the connection block");
    expect(stderr).toContain(CONNECTION_BLOCK_NOTICE);
    const raw = fs.readFileSync(configFile, "utf8");
    expect(raw).toContain(CONNECTION_BLOCK_DOC_URL);
    expect(raw).toContain(
      `#   poll_interval_ms: ${DEFAULT_POLLING_FREQUENCY_MS}`,
    );
  } finally {
    stdio.restore();
    exit.mockRestore();
  }
});

test("handler: offline infer-from-input writes the disclosed subset into the fresh config", async () => {
  // The fresh-config counterpart: `psilink invite input.csv` infers metadata,
  // mints, and writes a new config via saveConfig; disclosed_payload_columns must
  // land in that written file (not just on the token) so the recurring exchange can
  // enforce it -- proven here on the written file, not only at the validateInvite
  // return value.
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-invite-infer-"));
  const configFile = path.join(dir, "psilink.yaml");
  const keyFile = path.join(dir, ".psilink.key");
  const input = path.join(dir, "input.csv");
  fs.writeFileSync(
    input,
    "first_name,last_name,dob,ssn,notes\nAlice,Smith,1990-01-02,123456789,hi\n",
  );
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  try {
    await inviteHandler({
      _: [],
      $0: "psilink",
      identity: "Agency A",
      args: [input],
      "config-file": configFile,
      "key-file": keyFile,
      "log-level": "silent",
      record: false,
    } as unknown as Arguments);
    expect(exit).not.toHaveBeenCalledWith(64);
    expect(fs.existsSync(configFile)).toBe(true);
    const parsed = YAML.parse(fs.readFileSync(configFile, "utf8")) as {
      disclosed_payload_columns?: string[];
    };
    expect(parsed.disclosed_payload_columns).toEqual(["notes"]);
  } finally {
    logSpy.mockRestore();
    exit.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- handler: the invitation stays off the diagnostic routing ----------------

test("handler: the invitation reaches stdout and never a diagnostic line", async () => {
  // The invitation encodes the setup shared secret, and every diagnostic line
  // goes through the process-wide sink an operator can point at a file with
  // --log-file, while the accept template names the invitation by placeholder
  // -- so a template interpolating it would put the secret wherever that
  // routing leads. Driven through the real handler at the noisiest level, so
  // this covers every line the run emits, not just today's printInvitation.
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-invite-secret-"));
  const input = writeCsv(dir, "first_name,last_name,dob,ssn");
  const configFile = path.join(dir, "psilink.yaml");
  const keyFile = path.join(dir, ".psilink.key");
  const { stderrWrites, restore } = captureStdio();
  const printed: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
    printed.push(args.map(String).join(" "));
  });
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  try {
    await inviteHandler({
      _: [],
      $0: "psilink",
      identity: "Agency A",
      args: [input],
      "config-file": configFile,
      "key-file": keyFile,
      "log-level": "debug",
      record: false,
    } as unknown as Arguments);
    expect(exit).not.toHaveBeenCalledWith(64);

    // The stdout emission holds the invitation and nothing else, so it is what
    // the operator copies and what a redirect captures.
    expect(printed).toHaveLength(1);
    const invitation = printed[0];
    const token = await decodeInvitation(invitation);
    expect(token.sharedSecret).toMatch(/^[A-Za-z0-9_-]+$/);

    const diagnostics = stderrWrites.join("");
    expect(diagnostics).not.toContain(invitation);
    // The secret itself, not only the whole encoding: a later line holding the
    // token's fields rather than its string form would pass the check above.
    expect(diagnostics).not.toContain(token.sharedSecret);
    // The partner still learns what to run -- with the invitation named rather
    // than included, and with the identity accepting requires named where they
    // meet the command.
    expect(diagnostics).toContain(
      "psilink accept --identity <YOUR NAME, YOUR ORGANIZATION> " +
        "<INVITATION> <INPUT_FILE>",
    );
  } finally {
    restore();
    logSpy.mockRestore();
    exit.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- handler: the exit status a failed config write leaves behind -----------

test("handler: online invite whose config write failed keeps exit 73 and says so", async () => {
  // A wrapper gating on exit status must not read a rotated key with no
  // configuration as a completed setup. The persistence-loss code (73) is set
  // where the write failed (runProtocol's hook), mocked here via
  // runOnlineBootstrap; the handler must pass it through untouched rather than
  // have its own summary overwrite it. --log-level error is the level both the
  // summary and the underlying error it points back to are shown at.
  const { input, options } = onlineFixture();
  const runOnlineBootstrapMock = vi.mocked(runOnlineBootstrap);
  runOnlineBootstrapMock.mockImplementation(async () => {
    process.exitCode = 73;
    return { configWriteError: new Error("permission denied") };
  });
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  const stdio = captureStdio();
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await inviteHandler({
      _: [],
      $0: "psilink",
      identity: "Agency A",
      args: ["sftp://host/drop", input],
      "config-file": options.configFile,
      "key-file": options.keyFile,
      "log-level": "error",
      record: false,
    } as unknown as Arguments);
    // Read before the finally block restores the exit code and the stdio spies.
    const exitCode = process.exitCode;
    const stderr = stdio.stderrWrites.join("");
    expect(exit).not.toHaveBeenCalled();
    expect(runOnlineBootstrapMock).toHaveBeenCalledTimes(1);
    expect(exitCode).toBe(73);
    // The operator is told which half landed, at error level: the key is saved,
    // the config is not.
    expect(stderr).toContain("[ERROR] [invite] ");
    expect(stderr).toContain(`could not be written to ${options.configFile}`);
    expect(stderr).toContain(`rotated key was saved to ${options.keyFile}`);
  } finally {
    process.exitCode = previousExitCode;
    stdio.restore();
    exit.mockRestore();
    runOnlineBootstrapMock.mockReset();
  }
});

test("handler: a clean config write leaves the exchange's own exit 73 in place", async () => {
  // The exchange completed but could not write an audit artifact, so runProtocol
  // left the persistence-loss code behind; the config write that followed then
  // succeeded. The outcome summary moves no process state, so the run an
  // unattended supervisor sees still reports the lost record rather than a clean
  // 0. runOnlineBootstrap stands in for that exchange, setting the exit code the
  // way runProtocol does and reporting a written config.
  const { input, options } = onlineFixture();
  const runOnlineBootstrapMock = vi.mocked(runOnlineBootstrap);
  runOnlineBootstrapMock.mockImplementation(async () => {
    process.exitCode = 73;
    return { configWriteError: undefined };
  });
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  const stdio = captureStdio();
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await inviteHandler({
      _: [],
      $0: "psilink",
      identity: "Agency A",
      args: ["sftp://host/drop", input],
      "config-file": options.configFile,
      "key-file": options.keyFile,
      "log-level": "info",
      record: true,
    } as unknown as Arguments);
    // Read before the finally block restores the exit code and the stdio spies.
    const exitCode = process.exitCode;
    const stderr = stdio.stderrWrites.join("");
    expect(exit).not.toHaveBeenCalled();
    expect(runOnlineBootstrapMock).toHaveBeenCalledTimes(1);
    expect(exitCode).toBe(73);
    // The setup summary is still reported; only the clean exit code is withheld.
    expect(stderr).toContain(`saved config to ${options.configFile}`);
  } finally {
    process.exitCode = previousExitCode;
    stdio.restore();
    exit.mockRestore();
    runOnlineBootstrapMock.mockReset();
  }
});

test("handler: online hands the accept budget to the run and reports what was saved", async () => {
  // The two ends of the split, at the boundary where they part: the accept
  // timeout reaches the bootstrap as this run's budget alone, and the summary
  // states the budget the configuration on disk holds so the operator learns
  // it without opening the file.
  const { input, options } = onlineFixture();
  const runOnlineBootstrapMock = vi.mocked(runOnlineBootstrap);
  runOnlineBootstrapMock.mockImplementation(async () => ({}));
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  const stdio = captureStdio();
  try {
    await inviteHandler({
      _: [],
      $0: "psilink",
      identity: "Agency A",
      args: ["sftp://host/drop", input],
      "config-file": options.configFile,
      "key-file": options.keyFile,
      "accept-timeout": "300s",
      "log-level": "info",
      record: false,
    } as unknown as Arguments);
    const stderr = stdio.stderrWrites.join("");
    expect(exit).not.toHaveBeenCalled();
    const params = runOnlineBootstrapMock.mock.lastCall?.[0];
    expect(params?.runOnlyPeerTimeoutSeconds).toBe(300);
    // Nothing wrote the same budget into the connection that bootstrap
    // persists.
    expect(params?.connection.options?.peerTimeoutMs).toBeUndefined();
    expect(stderr).toContain(persistedPeerBudgetNotice(undefined, 300, "sftp"));
  } finally {
    stdio.restore();
    exit.mockRestore();
    runOnlineBootstrapMock.mockReset();
  }
});

test("handler: a webrtc online invite reports the webrtc peer-budget defaults, not the file-sync ones", async () => {
  // The call site that picks the notice's channel reads
  // ready.connection.channel; the sibling test above exercises it only over
  // sftp://, so a regression hard-coding that channel there would still pass
  // the suite while telling a webrtc operator to expect the file-sync hour at
  // a rendezvous that gives up after ten minutes.
  const { input, options } = onlineFixture();
  const runOnlineBootstrapMock = vi.mocked(runOnlineBootstrap);
  runOnlineBootstrapMock.mockImplementation(async () => ({}));
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  const stdio = captureStdio();
  try {
    await inviteHandler({
      _: [],
      $0: "psilink",
      identity: "Agency A",
      args: ["wss://peers.example.org/psi", input],
      "config-file": options.configFile,
      "key-file": options.keyFile,
      "log-level": "info",
      record: false,
    } as unknown as Arguments);
    const stderr = stdio.stderrWrites.join("");
    expect(exit).not.toHaveBeenCalled();
    expect(stderr).toMatch(secondsFigure(DEFAULT_RENDEZVOUS_TIMEOUT_MS));
    expect(stderr).toMatch(secondsFigure(DEFAULT_CHANNEL_OPEN_TIMEOUT_MS));
    expect(stderr).toMatch(secondsFigure(DEFAULT_WEBRTC_INACTIVITY_TIMEOUT_MS));
    expect(stderr).not.toContain("file-sync");
  } finally {
    stdio.restore();
    exit.mockRestore();
    runOnlineBootstrapMock.mockReset();
  }
});

test("handler: a failed config write reports no saved peer budget", async () => {
  // Nothing was written, so the summary that names what the file holds must
  // not run at all: the honest report is the write failure the outcome line
  // already states.
  const { input, options } = onlineFixture();
  const runOnlineBootstrapMock = vi.mocked(runOnlineBootstrap);
  runOnlineBootstrapMock.mockImplementation(async () => ({
    configWriteError: new Error("permission denied"),
  }));
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  const stdio = captureStdio();
  try {
    await inviteHandler({
      _: [],
      $0: "psilink",
      identity: "Agency A",
      args: ["sftp://host/drop", input],
      "config-file": options.configFile,
      "key-file": options.keyFile,
      "log-level": "info",
      record: false,
    } as unknown as Arguments);
    const stderr = stdio.stderrWrites.join("");
    expect(exit).not.toHaveBeenCalled();
    expect(stderr).not.toContain("connection.options.peer_timeout_ms");
  } finally {
    stdio.restore();
    exit.mockRestore();
    runOnlineBootstrapMock.mockReset();
  }
});

test("handler: a failed config write leaves --peer-timeout's warning unfalsified", async () => {
  // The one combination where the flag's warning could become a lie: it is
  // raised while the invitation is printed, long before the write it names can
  // fail. Non-promissory, it survives the failure -- and the summary that would
  // assert the file holds the value does not run, so nothing claims a write
  // that never happened.
  const { input, options } = onlineFixture();
  const runOnlineBootstrapMock = vi.mocked(runOnlineBootstrap);
  runOnlineBootstrapMock.mockImplementation(async () => ({
    configWriteError: new Error("permission denied"),
  }));
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  const stdio = captureStdio();
  try {
    await inviteHandler({
      _: [],
      $0: "psilink",
      identity: "Agency A",
      args: ["sftp://host/drop", input],
      "config-file": options.configFile,
      "key-file": options.keyFile,
      "peer-timeout": "60s",
      "log-level": "info",
      record: false,
    } as unknown as Arguments);
    const stderr = stdio.stderrWrites.join("");
    expect(exit).not.toHaveBeenCalled();
    // The warning names the field conditionally on the save, so the run's own
    // mention of peer_timeout_ms is that warning and nothing else.
    expect(stderr).toContain("When the configuration is saved");
    expect(stderr).not.toContain("the saved configuration records");
    expect(fs.existsSync(options.configFile)).toBe(false);
  } finally {
    stdio.restore();
    exit.mockRestore();
    runOnlineBootstrapMock.mockReset();
  }
});

test("handler: a webrtc online invite tells the partner to accept, with no URL and no second command", async () => {
  // The partner types no coordination server: the invitation's endpoint holds
  // it, so their accept writes the connection block and dials it in that one
  // command, while this one waits. Echoing the inviter's URL here would invite
  // the partner to retype a locator they already hold, on a command that
  // refuses it.
  const { input, options } = onlineFixture();
  const runOnlineBootstrapMock = vi.mocked(runOnlineBootstrap);
  runOnlineBootstrapMock.mockImplementation(async () => ({}));
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  const stdio = captureStdio();
  try {
    await inviteHandler({
      _: [],
      $0: "psilink",
      identity: "Agency A",
      args: ["wss://peers.example.org/psi", input],
      "config-file": options.configFile,
      "key-file": options.keyFile,
      "log-level": "info",
      record: false,
    } as unknown as Arguments);
    const stderr = stdio.stderrWrites.join("");
    expect(exit).not.toHaveBeenCalled();
    expect(stderr).toContain("accepts and runs the exchange with:");
    expect(stderr).toContain(
      "psilink accept --identity <YOUR NAME, YOUR ORGANIZATION> " +
        "<INVITATION> <INPUT_FILE>",
    );
    // Matched on the template's own indented command line, so the peer-budget
    // notice's prose mention of the command does not stand in for it.
    expect(stderr).not.toContain("\n  psilink exchange");
    expect(stderr).not.toContain("wss://peers.example.org");
  } finally {
    stdio.restore();
    exit.mockRestore();
    runOnlineBootstrapMock.mockReset();
  }
});

test("handler: the server-URL accept template names the identity too", async () => {
  // The third of the three templates, and the one a file-sync partner reads.
  // Accepting requires a label psilink invents for nobody, so a template that
  // named the server and the invitation but not the identity would hand the
  // partner a command that stops -- the same refusal the other two templates
  // are pinned against.
  const { input, options } = onlineFixture();
  const runOnlineBootstrapMock = vi.mocked(runOnlineBootstrap);
  runOnlineBootstrapMock.mockImplementation(async () => ({}));
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  const stdio = captureStdio();
  try {
    await inviteHandler({
      _: [],
      $0: "psilink",
      identity: "Agency A",
      args: ["sftp://host/drop", input],
      "config-file": options.configFile,
      "key-file": options.keyFile,
      "log-level": "info",
      record: false,
    } as unknown as Arguments);
    const stderr = stdio.stderrWrites.join("");
    expect(exit).not.toHaveBeenCalled();
    expect(stderr).toContain(
      "psilink accept --identity <YOUR NAME, YOUR ORGANIZATION> " +
        "sftp://host/drop <INVITATION> <INPUT_FILE>",
    );
  } finally {
    stdio.restore();
    exit.mockRestore();
    runOnlineBootstrapMock.mockReset();
  }
});
