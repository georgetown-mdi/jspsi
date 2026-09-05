import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Arguments } from "yargs";
import YAML from "yaml";
import {
  CSV_LINE_BYTE_CEILING,
  CsvRowParseError,
  getDefaultLinkageTerms,
  getLogger,
  inferDateInputFormatFromSource,
  INFER_DATE_SCAN_CAP,
  MAX_PAYLOAD_ENTRIES,
  MAX_RECONNECT_ATTEMPTS,
  parseExchangeSpec,
  reconcileReceivedPayload,
  safeParseConnectionConfig,
  SHARED_SECRET_REGEX,
  UsageError,
} from "@psilink/core";
import type {
  ConnectionConfig,
  ConnectionEndpoint,
  PartnerPayload,
  PreparedExchange,
  SFTPConnectionConfig,
  WebRTCConnectionConfig,
} from "@psilink/core";

import { saveConfig } from "../../src/config";
import { brokerLocationFromConnection } from "../../src/connection/webrtc/weriftPeer";
import {
  connectionFromURL,
  inviterConnectionFromURL,
  type RunnableConnectionConfig,
} from "../../src/connectionFromUrl";
import { diffConnectionAgainstTarget } from "../../src/reconcile";
import {
  connectionOverridesFrom,
  MAX_PORT,
  parseCommonBootstrapArgs,
  warnLowPollingFrequency,
  warnOptionsOverridesIgnoredOffline,
  warnServerOverridesIgnoredOffline,
  warnUnsupportedFileSyncFlags,
  warnUnsupportedWebRTCServerFlags,
} from "../../src/optionDefinitions";
import {
  applyEndpointSplitDirectories,
  buildDataSpec,
  connectionFromEndpoint,
  endpointFromConnection,
  generateSharedSecret,
  loadInputRows,
  logOnlineBootstrapOutcome,
  looksLikeUrl,
  observedReceivedColumnsForSave,
  parseLinkageStrategyFlag,
  runOnlineBootstrap,
  singlePassDisclosureNotice,
} from "../../src/onlineBootstrap";
import { redactUrlCredentials } from "../../src/util/connectionUrl";
import { openInputSource } from "../../src/util/dataIo";
import { runOrExit } from "../../src/util/exit";
import { MAX_TIMEOUT_SECONDS } from "../../src/util/flags";
import { openEventStream } from "../../src/eventStream";
import { establishHostKeyTrust } from "../../src/hostKeyTrust";
import { runProtocol } from "../../src/protocol";
import type { RunProtocolOptions } from "../../src/protocol";
import { captureFd3 } from "../eventStreamTestSupport";
import { streamOf, ttyStream, withStdin } from "../stdinStream";

// runOnlineBootstrap's config-persistence tests below drive its wiring without
// opening a connection: runProtocol is mocked so each test chooses whether the
// handshake "succeeds" (the mock invokes onAuthenticated) before it resolves or
// rejects. saveConfig is left real, so the assertions check the actual file.
vi.mock("../../src/protocol", () => ({
  runProtocol: vi.fn(),
}));

// The event-stream module stays REAL -- the preflight and the emitter it builds
// are what the fd-3 tests below exercise -- with openEventStream wrapped in a spy
// so one test can compare the emitter it returned against the object the
// bootstrap then handed runProtocol.
vi.mock("../../src/eventStream", async (importActual) => {
  const actual = await importActual<typeof import("../../src/eventStream")>();
  return { ...actual, openEventStream: vi.fn(actual.openEventStream) };
});

// The first-use host-key step is spy-WRAPPED for the same reason: the ordering
// test below needs to observe whether the bootstrap reached it, while every
// other test keeps running the real one -- a no-op on the pinned connections
// they supply.
vi.mock("../../src/hostKeyTrust", async (importActual) => {
  const actual = await importActual<typeof import("../../src/hostKeyTrust")>();
  return {
    ...actual,
    establishHostKeyTrust: vi.fn(actual.establishHostKeyTrust),
  };
});

// runOrExit creates its error logger by name; silence that name so the
// error-path tests below don't print to the console.
getLogger("bootstrap-test").setLevel("silent");

// A persistence the bootstrap loses without losing the exchange moves the REAL
// process.exitCode (that is the contract an unattended supervisor reads), so
// every test here is fenced: the value is snapshotted before each test and put
// back after, and a test that expects a loss asserts the code in its own body,
// before this fires.
let exitCodeBeforeTest: typeof process.exitCode;

beforeEach(() => {
  exitCodeBeforeTest = process.exitCode;
});

afterEach(() => {
  process.exitCode = exitCodeBeforeTest;
});

// --- looksLikeUrl ------------------------------------------------------------

test("looksLikeUrl: supported transport schemes are URLs", () => {
  expect(looksLikeUrl("sftp://host/path")).toBe(true);
  expect(looksLikeUrl("ssh://host/path")).toBe(true);
  expect(looksLikeUrl("ws://host/path")).toBe(true);
  expect(looksLikeUrl("wss://host/path")).toBe(true);
  expect(looksLikeUrl("file:///mnt/share")).toBe(true);
});

test("looksLikeUrl: files, invitations, and other schemes are not URLs", () => {
  expect(looksLikeUrl("input.csv")).toBe(false);
  expect(looksLikeUrl("./data/input.csv")).toBe(false);
  expect(looksLikeUrl("@invitation.txt")).toBe(false);
  // A base64url invitation, including one beginning with '-'.
  expect(looksLikeUrl("-eyJ2ZXJzaW9uIjoiMSJ9abc")).toBe(false);
  // A Windows drive path must not be mistaken for a URL with scheme "c:".
  expect(looksLikeUrl("C:\\data\\input.csv")).toBe(false);
  expect(looksLikeUrl("https://example.org")).toBe(false);
});

// --- connectionFromURL -------------------------------------------------------

test("connectionFromURL: sftp URL maps to an sftp connection", () => {
  const conn = connectionFromURL(new URL("sftp://alice@host:2222/drop"), {});
  expect(conn.channel).toBe("sftp");
  if (conn.channel !== "sftp") return;
  expect(conn.server.host).toBe("host");
  expect(conn.server.port).toBe(2222);
  expect(conn.server.username).toBe("alice");
});

test("connectionFromURL: file URL maps to a filedrop connection", () => {
  const conn = connectionFromURL(new URL("file:///mnt/share/drop"), {});
  expect(conn.channel).toBe("filedrop");
  if (conn.channel !== "filedrop") return;
  expect(conn.path).toBe("/mnt/share/drop");
});

test("connectionFromURL: a webrtc (ws) URL is a usage error", () => {
  // The CLI runs a webrtc exchange, but only from a saved connection: a URL
  // has neither the role each party registers under nor an endpoint an
  // invitation could hand the partner. The refusal names the command that does
  // run one rather than reporting the channel as unsupported.
  expect(() => connectionFromURL(new URL("ws://host/path"), {})).toThrow(
    UsageError,
  );
  expect(() => connectionFromURL(new URL("ws://host/path"), {})).toThrow(
    "psilink exchange",
  );
});

test("connectionFromURL: a bare-host sftp URL leaves the path unset", () => {
  for (const raw of ["sftp://host", "sftp://host/"]) {
    const conn = connectionFromURL(new URL(raw), {});
    expect(conn.channel).toBe("sftp");
    if (conn.channel !== "sftp") return;
    // A trailing "/" must not be pinned as the remote path; the server's default
    // working directory is used instead.
    expect(conn.server.path).toBeUndefined();
  }
});

test("connectionFromURL: an sftp URL with no host is a usage error", () => {
  expect(() => connectionFromURL(new URL("sftp:///drop"), {})).toThrow(
    UsageError,
  );
  expect(() => connectionFromURL(new URL("sftp:///drop"), {})).toThrow(
    /must include a host/,
  );
});

test("connectionFromURL: decodes a percent-encoded path", () => {
  const conn = connectionFromURL(new URL("sftp://host/my%20drop"), {});
  expect(conn.channel).toBe("sftp");
  if (conn.channel !== "sftp") return;
  // The live SFTP layer opens the path literally, so it must be stored decoded:
  // "/my drop", not the raw "/my%20drop" the URL parser keeps.
  expect(conn.server.path).toBe("/my drop");
});

test("connectionFromURL: decodes percent-encoded credentials", () => {
  const conn = connectionFromURL(new URL("sftp://us%20er:p%20w@host/drop"), {});
  expect(conn.channel).toBe("sftp");
  if (conn.channel !== "sftp") return;
  expect(conn.server.username).toBe("us er");
  expect(conn.server.password).toBe("p w");
});

test("connectionFromURL: decodes a percent-encoded host", () => {
  // sftp:// is a non-special scheme, so the WHATWG parser keeps the host opaque
  // and percent-encoded (an internationalized domain becomes UTF-8 escapes);
  // ssh2 needs the literal host, so it is decoded like the other components.
  const conn = connectionFromURL(new URL("sftp://my%20server/drop"), {});
  expect(conn.channel).toBe("sftp");
  if (conn.channel !== "sftp") return;
  expect(conn.server.host).toBe("my server");
});

test("connectionFromURL: an encoded slash in the path decodes to a separator", () => {
  // decodeURIComponent turns %2F into "/"; for an SFTP remote path that is the
  // intended literal separator (a POSIX filename cannot contain a slash), and it
  // keeps the builder and the live connection seeing the same path.
  const conn = connectionFromURL(new URL("sftp://host/drop%2Fsub"), {});
  expect(conn.channel).toBe("sftp");
  if (conn.channel !== "sftp") return;
  expect(conn.server.path).toBe("/drop/sub");
});

test("connectionFromURL: a traversal-shaped path is decoded literally, not rejected here", () => {
  // Encoded dot-dot segments joined by an encoded slash (%2e%2e%2f) survive the
  // WHATWG parser's double-dot collapsing (only literal "/" triggers it) and
  // decode to a literal "..". The builder decodes faithfully, with no
  // traversal special case, matching a hand-authored psilink.yaml with the same
  // path. Traversal defense belongs at the connection layer instead, which
  // covers every config source, not just URLs; this test pins that scope.
  const conn = connectionFromURL(new URL("sftp://host/%2e%2e%2fetc"), {});
  expect(conn.channel).toBe("sftp");
  if (conn.channel !== "sftp") return;
  expect(conn.server.path).toBe("/../etc");
});

test("connectionFromURL: a malformed percent-escape is a redacted usage error", () => {
  // A lone `%` makes decodeURIComponent throw a URIError; it must show up as a
  // UsageError, not an unhandled error.
  expect(() => connectionFromURL(new URL("sftp://host/bad%"), {})).toThrow(
    UsageError,
  );
  // When the malformed component is the password, the message must route through
  // redactUrlCredentials so the secret is never echoed.
  let message = "";
  try {
    connectionFromURL(new URL("sftp://user:secret%@host/drop"), {});
  } catch (err) {
    message = (err as Error).message;
  }
  expect(message).toMatch(/malformed percent-encoding/);
  expect(message).not.toContain("secret");
});

test("connectionFromURL and diffConnectionAgainstTarget agree on an encoded URL", () => {
  // A pre-existing config holds decoded values (a hand-authored psilink.yaml, or
  // a config the decoded builder saved earlier); the accept URL has the same
  // drop percent-encoded. Because the builder decodes, the reconcile compares
  // decoded-vs-decoded and reports a clean match -- no false conflict, and
  // nothing the one-time live exchange (which uses this same target) contradicts.
  const target = connectionFromURL(
    new URL("sftp://us%20er:p%20w@my%20server/my%20drop"),
    {},
  );
  const existing: SFTPConnectionConfig = {
    channel: "sftp",
    server: {
      host: "my server",
      path: "/my drop",
      username: "us er",
      password: "p w",
    },
  };
  const { conflicts, warnings } = diffConnectionAgainstTarget(existing, target);
  expect(conflicts).toEqual([]);
  expect(warnings).toEqual([]);
});

test("diffConnectionAgainstTarget: a differing private-key passphrase warns name-only", () => {
  // The passphrase is a reconcilable override (via connectionOverridesFrom), so
  // a change against a reused config gets the same name-only advisory as its
  // sibling credentials -- never echoing the secret value.
  const target = connectionFromURL(new URL("sftp://host/drop"), {
    server: { privateKey: "@key.pem", privateKeyPassphrase: "@new-pass.txt" },
  });
  const existing: SFTPConnectionConfig = {
    channel: "sftp",
    server: {
      host: "host",
      path: "/drop",
      privateKey: "@key.pem",
      privateKeyPassphrase: "@old-pass.txt",
    },
  };
  const { conflicts, warnings } = diffConnectionAgainstTarget(existing, target);
  expect(conflicts).toEqual([]);
  expect(warnings).toContain(
    "private key passphrase: differs from the saved value",
  );
  // The advisory names the field only; neither passphrase reference is echoed.
  expect(warnings.join("\n")).not.toContain("new-pass.txt");
  expect(warnings.join("\n")).not.toContain("old-pass.txt");
});

test("diffConnectionAgainstTarget: a differing keyboard-interactive setting warns", () => {
  // keyboard_interactive is a reconcilable override (via connectionOverridesFrom)
  // and a non-secret boolean, so it is compared like the sibling credentials but
  // echoes its values (like port), not name-only. connectionFromURL applies the
  // --server-keyboard-interactive override into the target.
  const target = connectionFromURL(new URL("sftp://host/drop"), {
    server: { password: "@pw.txt", keyboardInteractive: true },
  });
  const existing: SFTPConnectionConfig = {
    channel: "sftp",
    server: { host: "host", path: "/drop", password: "@pw.txt" },
  };
  const { conflicts, warnings } = diffConnectionAgainstTarget(existing, target);
  expect(conflicts).toEqual([]);
  expect(warnings.some((w) => w.startsWith("keyboard-interactive:"))).toBe(
    true,
  );
});

// --- connectionFromURL + --outbound-path (split directories) -----------------

test("connectionFromURL: --outbound-path splits an sftp URL path into inbound/outbound", () => {
  const target = connectionFromURL(new URL("sftp://host/drop-in"), {
    options: { retainFiles: true },
    server: { outboundPath: "/drop-out" },
  });
  expect(target.channel).toBe("sftp");
  if (target.channel !== "sftp") return;
  expect(target.server.inboundPath).toBe("/drop-in");
  expect(target.server.outboundPath).toBe("/drop-out");
  expect(target.server.path).toBeUndefined();
});

test("connectionFromURL: --outbound-path splits a filedrop URL directory", () => {
  const target = connectionFromURL(new URL("file:///mnt/share/in"), {
    options: { retainFiles: true },
    server: { outboundPath: "/mnt/share/out" },
  });
  expect(target.channel).toBe("filedrop");
  if (target.channel !== "filedrop") return;
  expect(target.inboundPath).toBe("/mnt/share/in");
  expect(target.outboundPath).toBe("/mnt/share/out");
  expect(target.path).toBeUndefined();
});

test("diffConnectionAgainstTarget: a matching split pair is no conflict", () => {
  const target: RunnableConnectionConfig = {
    channel: "sftp",
    server: { host: "host", inboundPath: "/in", outboundPath: "/out" },
  };
  const existing: SFTPConnectionConfig = {
    channel: "sftp",
    server: { host: "host", inboundPath: "/in", outboundPath: "/out" },
  };
  const { conflicts, warnings } = diffConnectionAgainstTarget(existing, target);
  expect(conflicts).toEqual([]);
  expect(warnings).toEqual([]);
});

test("diffConnectionAgainstTarget: a differing split half conflicts on that field", () => {
  const target: RunnableConnectionConfig = {
    channel: "sftp",
    server: { host: "host", inboundPath: "/in", outboundPath: "/out" },
  };
  const existing: SFTPConnectionConfig = {
    channel: "sftp",
    server: { host: "host", inboundPath: "/in", outboundPath: "/elsewhere" },
  };
  const { conflicts } = diffConnectionAgainstTarget(existing, target);
  expect(conflicts).toHaveLength(1);
  expect(conflicts[0].field).toBe("connection.server.outbound_path");
  // Delimited where they are composed: an accept URL's paths are the inviting
  // party's, and a saved config's were copied from that party's endpoint.
  expect(conflicts[0].existing).toBe('"/elsewhere"');
  expect(conflicts[0].incoming).toBe('"/out"');
});

test("diffConnectionAgainstTarget: a shared config against a split target conflicts on both halves, naming the shared path", () => {
  // A shared (single-path) config and a split target describe different
  // topologies; both halves conflict, and the unset existing side names the
  // single shared path the config actually holds rather than a bare "(unset)".
  const target: RunnableConnectionConfig = {
    channel: "filedrop",
    inboundPath: "/mnt/in",
    outboundPath: "/mnt/out",
  };
  const existing: ConnectionConfig = {
    channel: "filedrop",
    path: "/mnt/in",
  };
  const { conflicts } = diffConnectionAgainstTarget(existing, target);
  expect(conflicts.map((c) => c.field)).toEqual([
    "connection.inbound_path",
    "connection.outbound_path",
  ]);
  expect(
    conflicts.every((c) => c.existing.includes('single shared path "/mnt/in"')),
  ).toBe(true);
});

test("diffConnectionAgainstTarget: a split config against a shared target names the split locator", () => {
  // The reverse cross-topology case: a saved split config reconciled against a
  // shared target (an accept without --outbound-path). The unset existing path
  // names the split pair the config holds rather than a bare "(unset)".
  const target: RunnableConnectionConfig = {
    channel: "filedrop",
    path: "/mnt/shared",
  };
  const existing: ConnectionConfig = {
    channel: "filedrop",
    inboundPath: "/mnt/in",
    outboundPath: "/mnt/out",
  };
  const { conflicts } = diffConnectionAgainstTarget(existing, target);
  expect(conflicts).toHaveLength(1);
  expect(conflicts[0].field).toBe("connection.path");
  expect(conflicts[0].existing).toContain(
    'split inbound_path "/mnt/in", outbound_path "/mnt/out"',
  );
  expect(conflicts[0].incoming).toBe('"/mnt/shared"');
});

// Each server-block override flag, paired with the option field that holds it,
// so the parametrized test below proves every one is named when set offline.
const OFFLINE_IGNORED_OVERRIDES: ReadonlyArray<{
  flag: string;
  option: Parameters<typeof warnServerOverridesIgnoredOffline>[0];
}> = [
  { flag: "--server-username", option: { serverUsername: "alice" } },
  { flag: "--server-password", option: { serverPassword: "hunter2" } },
  { flag: "--server-private-key", option: { serverPrivateKey: "@key.pem" } },
  {
    flag: "--server-private-key-passphrase",
    option: { serverPrivateKeyPassphrase: "@pass.txt" },
  },
  {
    flag: "--server-keyboard-interactive",
    option: { serverKeyboardInteractive: true },
  },
  { flag: "--server-port", option: { serverPort: 2222 } },
  { flag: "--outbound-path", option: { outboundPath: "/drop/out" } },
];

for (const { flag, option } of OFFLINE_IGNORED_OVERRIDES)
  test(`warnServerOverridesIgnoredOffline: warns naming ${flag} when set`, () => {
    const warnings: string[] = [];
    warnServerOverridesIgnoredOffline(option, {
      warn: (m) => warnings.push(m),
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(flag);
    expect(warnings[0]).toContain("no effect on an offline invite/accept");
  });

test("warnServerOverridesIgnoredOffline: one warning names every set flag", () => {
  const warnings: string[] = [];
  warnServerOverridesIgnoredOffline(
    { serverUsername: "alice", serverPort: 2222, outboundPath: "/drop/out" },
    { warn: (m) => warnings.push(m) },
  );
  // A single warning rather than one per flag, so the operator sees the whole
  // ignored set at once.
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("--server-username");
  expect(warnings[0]).toContain("--server-port");
  expect(warnings[0]).toContain("--outbound-path");
  // An unset flag is not named.
  expect(warnings[0]).not.toContain("--server-password");
});

test("warnServerOverridesIgnoredOffline: stays silent when no override is set", () => {
  const warnings: string[] = [];
  warnServerOverridesIgnoredOffline({}, { warn: (m) => warnings.push(m) });
  expect(warnings).toEqual([]);
});

test("warnServerOverridesIgnoredOffline: --no-server-keyboard-interactive (false) is not reported as ignored", () => {
  // The gate is `=== true`, not `!== undefined`: the negated form arrives as
  // `false`, which equals the default (a no-op), so it must NOT be listed as an
  // ignored override. This pins that gate as an executable check rather than
  // only a code comment (a `!== undefined` regression would list it and fail).
  const warnings: string[] = [];
  warnServerOverridesIgnoredOffline(
    { serverKeyboardInteractive: false },
    { warn: (m) => warnings.push(m) },
  );
  expect(warnings).toEqual([]);
});

// Each connection-OPTIONS override flag, paired with the option field that
// holds it, so the parametrized test below proves every one is named when set
// offline. Covers both the SharedOptions timeouts/reconnect bound and the
// FileSyncOptions toggles -- the offline placeholder has no `options` block on
// any channel, so the warning is not gated by channel.
const OFFLINE_IGNORED_OPTIONS_OVERRIDES: ReadonlyArray<{
  flag: string;
  option: Parameters<typeof warnOptionsOverridesIgnoredOffline>[0];
}> = [
  { flag: "--connection-timeout", option: { connectionTimeout: 30 } },
  { flag: "--peer-timeout", option: { peerTimeout: 60 } },
  { flag: "--polling-frequency", option: { pollingFrequencyMs: 100 } },
  { flag: "--max-reconnect-attempts", option: { maxReconnectAttempts: 5 } },
  { flag: "--lockless-rendezvous", option: { locklessRendezvous: true } },
  { flag: "--peer-id", option: { peerId: "party-a" } },
  { flag: "--timestamp-in-filename", option: { timestampInFilename: true } },
  { flag: "--retain-files", option: { retainFiles: true } },
];

for (const { flag, option } of OFFLINE_IGNORED_OPTIONS_OVERRIDES)
  test(`warnOptionsOverridesIgnoredOffline: warns naming ${flag} when set`, () => {
    const warnings: string[] = [];
    warnOptionsOverridesIgnoredOffline(option, {
      warn: (m) => warnings.push(m),
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(flag);
    expect(warnings[0]).toContain("no effect on an offline invite/accept");
    // The remedy points at connection.options, distinct from the server-override
    // warning's "set the connection details in that block" remedy.
    expect(warnings[0]).toContain("connection.options");
  });

test("warnOptionsOverridesIgnoredOffline: one warning names every set flag", () => {
  const warnings: string[] = [];
  warnOptionsOverridesIgnoredOffline(
    { connectionTimeout: 30, retainFiles: true, peerId: "party-a" },
    { warn: (m) => warnings.push(m) },
  );
  // A single warning rather than one per flag, so the operator sees the whole
  // ignored set at once.
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("--connection-timeout");
  expect(warnings[0]).toContain("--retain-files");
  expect(warnings[0]).toContain("--peer-id");
  // An unset flag is not named.
  expect(warnings[0]).not.toContain("--peer-timeout");
});

test("warnOptionsOverridesIgnoredOffline: stays silent when no override is set", () => {
  const warnings: string[] = [];
  warnOptionsOverridesIgnoredOffline({}, { warn: (m) => warnings.push(m) });
  expect(warnings).toEqual([]);
});

test("warnOptionsOverridesIgnoredOffline: a negated boolean toggle (--no-*) does not warn", () => {
  // yargs sets the negated form (--no-retain-files etc.) to `false`, the default
  // a fresh placeholder already holds, so it is not an override that could have
  // done something: the toggles gate on `=== true`, not presence. Mirrors
  // warnUnsupportedFileSyncFlags's `=== true` gate on the same toggles.
  const warnings: string[] = [];
  warnOptionsOverridesIgnoredOffline(
    {
      locklessRendezvous: false,
      retainFiles: false,
      timestampInFilename: false,
    },
    { warn: (m) => warnings.push(m) },
  );
  expect(warnings).toEqual([]);
});

// --- connectionOverridesFrom (--polling-frequency) ---------------------------

test("connectionOverridesFrom: maps pollingFrequencyMs to the pollIntervalMs override verbatim", () => {
  // The parsed field is already in milliseconds, so it feeds the connection's
  // pollIntervalMs with no scaling (unlike peerTimeout, which is seconds * 1000).
  const overrides = connectionOverridesFrom({ pollingFrequencyMs: 100 });
  expect(overrides.options?.pollIntervalMs).toBe(100);
});

test("connectionOverridesFrom: an absent --polling-frequency leaves pollIntervalMs unset", () => {
  const overrides = connectionOverridesFrom({});
  expect(overrides.options?.pollIntervalMs).toBeUndefined();
});

test("connectionOverridesFrom: maps serverKeyboardInteractive into the server sub-group", () => {
  const overrides = connectionOverridesFrom({
    serverKeyboardInteractive: true,
  });
  expect(overrides.server?.keyboardInteractive).toBe(true);
});

// --- warnLowPollingFrequency -------------------------------------------------

test("warnLowPollingFrequency: warns below the 1s threshold on a file-sync channel", () => {
  const warnings: string[] = [];
  warnLowPollingFrequency("sftp", 100, { warn: (m) => warnings.push(m) });
  expect(warnings).toHaveLength(1);
  // Names the flag, echoes the operator's own value, and states the anti-flood risk.
  expect(warnings[0]).toContain("--polling-frequency");
  expect(warnings[0]).toContain("100ms");
  expect(warnings[0]).toContain("anti-flood");
  // Applies on filedrop too, not just sftp.
  const filedropWarnings: string[] = [];
  warnLowPollingFrequency("filedrop", 100, {
    warn: (m) => filedropWarnings.push(m),
  });
  expect(filedropWarnings).toHaveLength(1);
});

test("warnLowPollingFrequency: silent at exactly the 1s threshold", () => {
  // The threshold is inclusive of "safe": exactly 1000ms does not warn, so a
  // conservative value emits nothing.
  const warnings: string[] = [];
  warnLowPollingFrequency("sftp", 1000, { warn: (m) => warnings.push(m) });
  expect(warnings).toEqual([]);
});

test("warnLowPollingFrequency: silent above the threshold and when the flag is absent", () => {
  const warnings: string[] = [];
  warnLowPollingFrequency("sftp", 5000, { warn: (m) => warnings.push(m) });
  warnLowPollingFrequency("sftp", undefined, { warn: (m) => warnings.push(m) });
  expect(warnings).toEqual([]);
});

test("warnLowPollingFrequency: silent on a non-file-sync (or unresolved) channel even with a low value", () => {
  // The poll override is dropped off the file-sync channels, so the anti-flood
  // advisory would be misleading; warnUnsupportedFileSyncFlags reports it ignored
  // there instead. An undefined channel (unresolved URL scheme) no-ops the same way.
  const warnings: string[] = [];
  warnLowPollingFrequency("webrtc", 100, { warn: (m) => warnings.push(m) });
  warnLowPollingFrequency(undefined, 100, { warn: (m) => warnings.push(m) });
  expect(warnings).toEqual([]);
});

// --- redactUrlCredentials ----------------------------------------------------

test("redactUrlCredentials: strips an embedded password and username", () => {
  const redacted = redactUrlCredentials(
    new URL("sftp://alice:s3cr3t@host:2222/drop"),
  );
  expect(redacted).not.toContain("s3cr3t");
  expect(redacted).not.toContain("alice");
  expect(redacted).toContain("host");
  expect(redacted).toContain("2222");
  expect(redacted).toContain("/drop");
});

test("redactUrlCredentials: a credential-free URL is unchanged", () => {
  const redacted = redactUrlCredentials(new URL("sftp://host:2222/drop"));
  expect(redacted).toBe("sftp://host:2222/drop");
});

// --- runOrExit ---------------------------------------------------------------

test("runOrExit: a UsageError exits 64", async () => {
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  await runOrExit("bootstrap-test", async () => {
    throw new UsageError("bad usage");
  });
  expect(exit).toHaveBeenCalledWith(64);
  exit.mockRestore();
});

test("runOrExit: a non-UsageError preserves its own exitCode (not collapsed to 69)", async () => {
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  await runOrExit("bootstrap-test", async () => {
    // A distinctive code (not 69) proves the `?? exitCode` rung is preserved,
    // so a missing input file keeps its own exit code instead of becoming 69.
    throw Object.assign(new Error("input file not found"), { exitCode: 66 });
  });
  expect(exit).toHaveBeenCalledWith(66);
  exit.mockRestore();
});

test("runOrExit: an error without an exitCode defaults to 69", async () => {
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  await runOrExit("bootstrap-test", async () => {
    throw new Error("transport failure");
  });
  expect(exit).toHaveBeenCalledWith(69);
  exit.mockRestore();
});

test("runOrExit: a rejected body (e.g. a stdin/prompt error) exits cleanly, never throwing", async () => {
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  // A readline rejection mid-prompt is just a rejected promise inside the body;
  // runOrExit maps it to an exit rather than letting it crash unhandled.
  await expect(
    runOrExit("bootstrap-test", async () => {
      await Promise.reject(new Error("stdin closed"));
    }),
  ).resolves.toBeUndefined();
  expect(exit).toHaveBeenCalledWith(69);
  exit.mockRestore();
});

test("parseCommonBootstrapArgs: an unrecognized log-level is a usage error", () => {
  // Routed through runOrExit by the handlers, so a UsageError exits 64 via the
  // consistent error path rather than yargs's noisier top-level catch.
  expect(() =>
    parseCommonBootstrapArgs({
      _: [],
      $0: "psilink",
      "log-level": "bogus",
    } as unknown as Arguments),
  ).toThrow(UsageError);
});

test("parseCommonBootstrapArgs: a repeated number flag is a usage error naming the flag", () => {
  // yargs collects `--server-port 2222 --server-port 2223` into an array; the
  // shared singleValue accessor rejects it before the array reaches the
  // connection overrides as if it were a scalar port.
  expect(() =>
    parseCommonBootstrapArgs({
      _: [],
      $0: "psilink",
      "server-port": [2222, 2223],
    } as unknown as Arguments),
  ).toThrow(UsageError);
  expect(() =>
    parseCommonBootstrapArgs({
      _: [],
      $0: "psilink",
      "server-port": [2222, 2223],
    } as unknown as Arguments),
  ).toThrow("--server-port may be given only once");
});

test("parseCommonBootstrapArgs: a repeated string flag is a usage error naming the flag", () => {
  // A repeated --log-level reaches .toLowerCase(); rejecting the array first
  // avoids the raw TypeError that would otherwise show up as a confusing exit 69.
  expect(() =>
    parseCommonBootstrapArgs({
      _: [],
      $0: "psilink",
      "log-level": ["info", "debug"],
    } as unknown as Arguments),
  ).toThrow("--log-level may be given only once");
});

test("parseCommonBootstrapArgs: --outbound-path is read as a string", () => {
  const parsed = parseCommonBootstrapArgs({
    _: [],
    $0: "psilink",
    "outbound-path": "/mnt/share/to-partner",
  } as unknown as Arguments);
  expect(parsed.outboundPath).toBe("/mnt/share/to-partner");
});

test("parseCommonBootstrapArgs: a repeated --outbound-path is a usage error", () => {
  expect(() =>
    parseCommonBootstrapArgs({
      _: [],
      $0: "psilink",
      "outbound-path": ["/a", "/b"],
    } as unknown as Arguments),
  ).toThrow("--outbound-path may be given only once");
});

test("parseCommonBootstrapArgs: human-readable timeouts parse to whole seconds", () => {
  // The flags accept the shared duration syntax; the parsed value stays in the
  // seconds the connection overrides (and core, after applyConnectionOverrides
  // scales to ms) expect, so only the input form changed.
  const parsed = parseCommonBootstrapArgs({
    _: [],
    $0: "psilink",
    "connection-timeout": "2m",
    "peer-timeout": "30s",
  } as unknown as Arguments);
  expect(parsed.connectionTimeout).toBe(120);
  expect(parsed.peerTimeout).toBe(30);
});

test("parseCommonBootstrapArgs: a bare-integer timeout is rejected with the suffixed equivalent", () => {
  expect(() =>
    parseCommonBootstrapArgs({
      _: [],
      $0: "psilink",
      "peer-timeout": "30",
    } as unknown as Arguments),
  ).toThrow(UsageError);
  expect(() =>
    parseCommonBootstrapArgs({
      _: [],
      $0: "psilink",
      "peer-timeout": "30",
    } as unknown as Arguments),
  ).toThrow("30s");
});

test("parseCommonBootstrapArgs: a malformed timeout is a flag-named usage error", () => {
  expect(() =>
    parseCommonBootstrapArgs({
      _: [],
      $0: "psilink",
      "connection-timeout": "soon",
    } as unknown as Arguments),
  ).toThrow("--connection-timeout");
});

test("parseCommonBootstrapArgs: a connection-/peer-timeout above the 7d ceiling is rejected before any side effect", () => {
  // parseCommonBootstrapArgs is the pure parse step every bootstrap command runs
  // before it opens a connection or writes anything, so a rejection here is a
  // rejection before any side effect. Both flags share MAX_TIMEOUT_SECONDS; a
  // value one minute past it (7d is a whole number of minutes) is rejected with a
  // flag-named, max-stating usage error.
  const justOver = `${MAX_TIMEOUT_SECONDS / 60 + 1}m`;
  for (const flag of ["connection-timeout", "peer-timeout"] as const) {
    const parse = () =>
      parseCommonBootstrapArgs({
        _: [],
        $0: "psilink",
        [flag]: justOver,
      } as unknown as Arguments);
    // Assert the throw first, so a regression that fails to reject shows up as a
    // clear "did not throw" rather than the message assertions failing on "".
    expect(parse).toThrow(UsageError);
    expect(parse).toThrow(`--${flag}`);
    expect(parse).toThrow("must not exceed");
    expect(parse).toThrow("7d");
  }
});

test("parseCommonBootstrapArgs: a negative max-reconnect-attempts is a flag-named usage error", () => {
  // Wiring coverage for the single parse site: the value flows through
  // nonNegativeIntFlag here, so an invalid count is rejected at parse (exit 64),
  // before any setup, rather than deferred to the later merged-options
  // re-validation. A revert of this site to a bare `singleValue(...) as number`
  // turns this red, which the helper's isolation tests would not catch.
  const parse = () =>
    parseCommonBootstrapArgs({
      _: [],
      $0: "psilink",
      "max-reconnect-attempts": -1,
    } as unknown as Arguments);
  expect(parse).toThrow(UsageError);
  expect(parse).toThrow("--max-reconnect-attempts");
});

test("parseCommonBootstrapArgs: a max-reconnect-attempts above the ceiling is rejected before any side effect", () => {
  // Wiring coverage that the parse site passes MAX_RECONNECT_ATTEMPTS as the
  // ceiling: a value one past it is rejected at parse (exit 64), before any setup,
  // with a flag-named, max-stating usage error -- the count-flag counterpart of
  // the connection-/peer-timeout 7d ceiling test above. A revert of this site to
  // an uncapped nonNegativeIntFlag(...) turns this red.
  const parse = () =>
    parseCommonBootstrapArgs({
      _: [],
      $0: "psilink",
      "max-reconnect-attempts": MAX_RECONNECT_ATTEMPTS + 1,
    } as unknown as Arguments);
  expect(parse).toThrow(UsageError);
  expect(parse).toThrow("--max-reconnect-attempts");
  expect(parse).toThrow("must not exceed");
  expect(parse).toThrow(String(MAX_RECONNECT_ATTEMPTS));
});

test("parseCommonBootstrapArgs: a max-reconnect-attempts at the ceiling is accepted", () => {
  // The boundary is inclusive at the parse-site layer too (the counterpart of the
  // timeout 7d-ceiling acceptance test below): exactly MAX_RECONNECT_ATTEMPTS, the
  // largest in-range value, passes through unchanged rather than being rejected by
  // an off-by-one in the ceiling the parse site hands nonNegativeIntFlag.
  const parsed = parseCommonBootstrapArgs({
    _: [],
    $0: "psilink",
    "max-reconnect-attempts": MAX_RECONNECT_ATTEMPTS,
  } as unknown as Arguments);
  expect(parsed.maxReconnectAttempts).toBe(MAX_RECONNECT_ATTEMPTS);
});

test("parseCommonBootstrapArgs: a non-numeric server-port is a flag-named usage error", () => {
  // yargs type:"number" coerces a non-numeric token (e.g. "abc") to NaN with no
  // validation of its own; nonNegativeIntFlag catches it here, at parse (exit 64),
  // before any connection attempt, rather than letting it reach server.port as an
  // opaque NaN.
  const parse = () =>
    parseCommonBootstrapArgs({
      _: [],
      $0: "psilink",
      "server-port": Number.NaN,
    } as unknown as Arguments);
  expect(parse).toThrow(UsageError);
  expect(parse).toThrow("--server-port");
});

test("parseCommonBootstrapArgs: an out-of-range server-port is a flag-named usage error", () => {
  // The schema bound on server.port is z.int().min(0).max(65535); a negative or
  // above-65535 value is rejected at parse rather than reaching the connection
  // config unchecked.
  for (const bad of [-5, MAX_PORT + 1]) {
    const parse = () =>
      parseCommonBootstrapArgs({
        _: [],
        $0: "psilink",
        "server-port": bad,
      } as unknown as Arguments);
    expect(parse).toThrow(UsageError);
    expect(parse).toThrow("--server-port");
  }
});

test("parseCommonBootstrapArgs: server-port at 0 and at the 65535 ceiling are accepted", () => {
  // The bound is inclusive on both ends: port 0 (a valid, if unusual, port
  // number) and the largest valid port both pass through unchanged.
  expect(
    parseCommonBootstrapArgs({
      _: [],
      $0: "psilink",
      "server-port": 0,
    } as unknown as Arguments).serverPort,
  ).toBe(0);
  expect(
    parseCommonBootstrapArgs({
      _: [],
      $0: "psilink",
      "server-port": MAX_PORT,
    } as unknown as Arguments).serverPort,
  ).toBe(MAX_PORT);
});

test("parseCommonBootstrapArgs: a connection-/peer-timeout at the 7d ceiling is accepted", () => {
  // The boundary is inclusive: exactly 7d parses to its seconds value, so the
  // largest in-range value behaves exactly as it does today.
  const parsed = parseCommonBootstrapArgs({
    _: [],
    $0: "psilink",
    "connection-timeout": `${MAX_TIMEOUT_SECONDS / 86_400}d`,
    "peer-timeout": `${MAX_TIMEOUT_SECONDS / 86_400}d`,
  } as unknown as Arguments);
  expect(parsed.connectionTimeout).toBe(MAX_TIMEOUT_SECONDS);
  expect(parsed.peerTimeout).toBe(MAX_TIMEOUT_SECONDS);
});

// --- warnUnsupportedFileSyncFlags --------------------------------------------

function collectWarnings(): { warn: (m: string) => void; messages: string[] } {
  const messages: string[] = [];
  return { warn: (m: string) => messages.push(m), messages };
}

test("warnUnsupportedFileSyncFlags: file-sync channels never warn", () => {
  // sftp and filedrop support every flag, so none warns even when all are set --
  // the predicate is the channel.
  for (const channel of ["sftp", "filedrop"] as const) {
    const log = collectWarnings();
    warnUnsupportedFileSyncFlags(
      channel,
      { locklessRendezvous: true, retainFiles: true, pollingFrequencyMs: 100 },
      log,
    );
    expect(log.messages).toHaveLength(0);
  }
});

test("warnUnsupportedFileSyncFlags: a non-file-sync channel warns only for the flags set", () => {
  const onlyLockless = collectWarnings();
  warnUnsupportedFileSyncFlags(
    "webrtc",
    { locklessRendezvous: true },
    onlyLockless,
  );
  expect(onlyLockless.messages).toEqual([
    "--lockless-rendezvous has no effect on the webrtc channel and will be " +
      "ignored; it is only supported on sftp and filedrop",
  ]);

  const onlyRetain = collectWarnings();
  warnUnsupportedFileSyncFlags("webrtc", { retainFiles: true }, onlyRetain);
  expect(onlyRetain.messages).toEqual([
    "--retain-files has no effect on the webrtc channel and will be ignored; " +
      "it is only supported on sftp and filedrop",
  ]);

  // --polling-frequency is a number override (gated on presence, not `=== true`),
  // reported ignored on a non-file-sync channel like its sibling toggles.
  const onlyPolling = collectWarnings();
  warnUnsupportedFileSyncFlags(
    "webrtc",
    { pollingFrequencyMs: 100 },
    onlyPolling,
  );
  expect(onlyPolling.messages).toEqual([
    "--polling-frequency has no effect on the webrtc channel and will be " +
      "ignored; it is only supported on sftp and filedrop",
  ]);

  const all = collectWarnings();
  warnUnsupportedFileSyncFlags(
    "webrtc",
    { locklessRendezvous: true, retainFiles: true, pollingFrequencyMs: 100 },
    all,
  );
  expect(all.messages).toHaveLength(3);

  const neither = collectWarnings();
  warnUnsupportedFileSyncFlags("webrtc", {}, neither);
  expect(neither.messages).toHaveLength(0);
});

test("warnUnsupportedFileSyncFlags: the filename toggles are reported too, by name only", () => {
  // peer_id and timestamp_in_filename are FileSyncOptions fields, applied on
  // sftp and filedrop alone, so both are dropped on a webrtc connection exactly
  // as the three above are.
  const both = collectWarnings();
  warnUnsupportedFileSyncFlags(
    "webrtc",
    { peerId: "party-a", timestampInFilename: true },
    both,
  );
  expect(both.messages).toHaveLength(2);
  expect(both.messages[0]).toContain("--peer-id");
  expect(both.messages[1]).toContain("--timestamp-in-filename");
  // --peer-id's value is operator-supplied free text reaching the terminal and
  // any --log-file, so the message names the flag alone.
  expect(both.messages.join("")).not.toContain("party-a");

  // The negated boolean form asks for the default, not for a dropped setting.
  const negated = collectWarnings();
  warnUnsupportedFileSyncFlags(
    "webrtc",
    { timestampInFilename: false },
    negated,
  );
  expect(negated.messages).toHaveLength(0);

  for (const channel of ["sftp", "filedrop"] as const) {
    const log = collectWarnings();
    warnUnsupportedFileSyncFlags(
      channel,
      { peerId: "party-a", timestampInFilename: true },
      log,
    );
    expect(log.messages).toHaveLength(0);
  }
});

// --- warnUnsupportedWebRTCServerFlags ----------------------------------------

test("warnUnsupportedWebRTCServerFlags: webrtc warns once per flag set", () => {
  const both = collectWarnings();
  warnUnsupportedWebRTCServerFlags(
    "webrtc",
    { serverPort: 9000, serverUsername: "alice" },
    both,
    "url",
  );
  expect(both.messages).toHaveLength(2);
  expect(both.messages[0]).toContain("--server-port");
  expect(both.messages[1]).toContain("--server-username");
  // Flag names only -- the message is static apart from them, so an override
  // value never reaches the terminal or a --log-file.
  expect(both.messages.join("")).not.toContain("alice");
  expect(both.messages.join("")).not.toContain("9000");

  const onlyPort = collectWarnings();
  warnUnsupportedWebRTCServerFlags(
    "webrtc",
    { serverPort: 9000 },
    onlyPort,
    "url",
  );
  expect(onlyPort.messages).toHaveLength(1);

  const neither = collectWarnings();
  warnUnsupportedWebRTCServerFlags("webrtc", {}, neither, "url");
  expect(neither.messages).toHaveLength(0);
});

test("warnUnsupportedWebRTCServerFlags: each remedy points at the connection the caller has", () => {
  // The two flags holding a remedy of their own are the two that can point at
  // the wrong thing: a caller running a configuration has no URL to be told its
  // port comes from, and telling it to author a config and run 'psilink
  // exchange' is the command it already is.
  const fromUrl = collectWarnings();
  warnUnsupportedWebRTCServerFlags(
    "webrtc",
    { serverPort: 9000, serverUsername: "alice" },
    fromUrl,
    "url",
  );
  expect(fromUrl.messages[0]).toContain("ws:// or wss:// URL");
  expect(fromUrl.messages[1]).toContain("psilink exchange");

  const fromConfiguration = collectWarnings();
  warnUnsupportedWebRTCServerFlags(
    "webrtc",
    { serverPort: 9000, serverUsername: "alice" },
    fromConfiguration,
    "configuration",
  );
  expect(fromConfiguration.messages[0]).toContain("`connection.server`");
  expect(fromConfiguration.messages[1]).toContain("`connection.server.key`");
  // Neither remedy sends a caller already running a configuration to a URL it
  // was not given, or back to the command it is.
  const rendered = fromConfiguration.messages.join("");
  expect(rendered).not.toContain("ws://");
  expect(rendered).not.toContain("psilink exchange'");
});

test("warnUnsupportedWebRTCServerFlags: every dropped credential flag is reported, by name only", () => {
  // A credential typed at a channel that discards it is the drop most worth
  // reporting: from the terminal it looks exactly like one that was used. The
  // values below are the secrets themselves, so the same pass that checks each
  // flag is named checks that no value rode along with it.
  const secrets = {
    serverPassword: "hunter2",
    serverPrivateKey: "/keys/id_ed25519",
    serverPrivateKeyPassphrase: "open-sesame",
    serverKeyboardInteractive: true,
    serverHostKeyFingerprint: `SHA256:${"A".repeat(43)}`,
  } as const;
  const log = collectWarnings();
  warnUnsupportedWebRTCServerFlags("webrtc", secrets, log, "url");
  expect(log.messages).toHaveLength(5);
  for (const flag of [
    "--server-password",
    "--server-private-key",
    "--server-private-key-passphrase",
    "--server-keyboard-interactive",
    "--server-host-key-fingerprint",
  ])
    expect(log.messages.some((m) => m.startsWith(`${flag} `))).toBe(true);
  const rendered = log.messages.join("");
  for (const value of Object.values(secrets))
    if (typeof value === "string") expect(rendered).not.toContain(value);

  // The negated boolean form asks for the default, not for a dropped setting.
  const negated = collectWarnings();
  warnUnsupportedWebRTCServerFlags(
    "webrtc",
    { serverKeyboardInteractive: false },
    negated,
    "url",
  );
  expect(negated.messages).toHaveLength(0);
});

test("warnUnsupportedWebRTCServerFlags: the credential line claims silence for the flags, not for the channel", () => {
  // What the dropped flag values do is the claim this line can make: they are
  // neither used nor echoed. What the channel does is not -- a connection
  // holding a `server.key` sends it to the coordination server as part of the
  // request it authorizes -- so the line states that rather than a blanket
  // "no credential of any kind is sent", which is false on a keyed connection
  // and is read by a caller running exactly one.
  for (const source of ["url", "configuration"] as const) {
    const log = collectWarnings();
    warnUnsupportedWebRTCServerFlags(
      "webrtc",
      { serverPassword: "hunter2" },
      log,
      source,
    );
    expect(log.messages).toHaveLength(1);
    const message = log.messages[0];
    expect(message).toContain("neither used nor echoed");
    expect(message).toContain("`server.key`");
    expect(message).toContain("sent to that server");
    expect(message).not.toContain("no credential of any kind");
  }
});

test("warnUnsupportedWebRTCServerFlags: the file-sync channels never warn", () => {
  // Every one of these is applied on sftp, and the messages' wording (a
  // coordination server and its API key) fits no other channel.
  for (const channel of ["sftp", "filedrop"] as const) {
    const log = collectWarnings();
    warnUnsupportedWebRTCServerFlags(
      channel,
      {
        serverPort: 9000,
        serverUsername: "alice",
        serverPassword: "hunter2",
        serverPrivateKey: "/keys/id_ed25519",
        serverPrivateKeyPassphrase: "open-sesame",
        serverKeyboardInteractive: true,
        serverHostKeyFingerprint: `SHA256:${"A".repeat(43)}`,
      },
      log,
      "url",
    );
    expect(log.messages).toHaveLength(0);
  }
});

test("runOrExit: a successful body does not exit", async () => {
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  let ran = false;
  await runOrExit("bootstrap-test", async () => {
    ran = true;
  });
  expect(ran).toBe(true);
  expect(exit).not.toHaveBeenCalled();
  exit.mockRestore();
});

test("runOrExit shows a sanitized cause chain in the CLI failure output", async () => {
  // A transport failure wraps the raw fs/ssh2 error as its cause, and the
  // partner-chosen path in that cause can hold control/ANSI/newline bytes. The
  // failure output must show the cause (observability) with those bytes
  // neutralized, never reaching the terminal raw.
  // Spy before setLevel: loglevel binds console.error by reference when the
  // logger's methods are (re)built, so the spy must be in place first.
  const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  getLogger("cause-chain-render-test").setLevel("error");
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  try {
    const hostileCause = new Error(
      "ENOENT: no such file or directory, open '/drop/\x1b[31mEVIL\nFAKE.json'",
    );
    await runOrExit("cause-chain-render-test", async () => {
      throw new Error("transport failed", { cause: hostileCause });
    });
    const output = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("transport failed");
    expect(output).toContain("caused by:");
    expect(output).toContain("\\x1b[31mEVIL\\x0aFAKE.json");
    expect(output).not.toContain("\x1b");
    expect(exit).toHaveBeenCalledWith(69);
  } finally {
    errSpy.mockRestore();
    exit.mockRestore();
  }
});

// --- connectionFromEndpoint --------------------------------------------------

test("connectionFromEndpoint: no endpoint yields a marked sftp placeholder", () => {
  const { connection, seeded } = connectionFromEndpoint(undefined);
  expect(seeded).toBe(false);
  expect(connection.channel).toBe("sftp");
  if (connection.channel !== "sftp") return;
  expect(connection.server.host).toMatch(/REPLACE_WITH/);
  expect(connection.server.username).toMatch(/REPLACE_WITH/);
});

test("connectionFromEndpoint: an sftp endpoint seeds the locator, marks credentials", () => {
  const endpoint: ConnectionEndpoint = {
    channel: "sftp",
    host: "sftp.example.org",
    port: 2222,
    path: "/exchanges/drop",
  };
  const { connection, seeded } = connectionFromEndpoint(endpoint);
  expect(seeded).toBe(true);
  expect(connection.channel).toBe("sftp");
  if (connection.channel !== "sftp") return;
  expect(connection.server.host).toBe("sftp.example.org");
  expect(connection.server.port).toBe(2222);
  expect(connection.server.path).toBe("/exchanges/drop");
  // The endpoint never holds credentials; the username is a fill-in marker.
  expect(connection.server.username).toMatch(/REPLACE_WITH/);
  expect(connection.server.password).toBeUndefined();
});

test("connectionFromEndpoint: a filedrop endpoint seeds the shared path", () => {
  const endpoint: ConnectionEndpoint = {
    channel: "filedrop",
    path: "/mnt/share/drop",
  };
  const { connection, seeded } = connectionFromEndpoint(endpoint);
  expect(seeded).toBe(true);
  expect(connection.channel).toBe("filedrop");
  if (connection.channel !== "filedrop") return;
  expect(connection.path).toBe("/mnt/share/drop");
});

test("connectionFromEndpoint: a webrtc endpoint seeds the signaling locator", () => {
  const endpoint: ConnectionEndpoint = {
    channel: "webrtc",
    host: "peer.example.org",
    path: "/psi",
  };
  const { connection, seeded } = connectionFromEndpoint(endpoint);
  expect(seeded).toBe(true);
  expect(connection.channel).toBe("webrtc");
  if (connection.channel !== "webrtc") return;
  expect(connection.server.host).toBe("peer.example.org");
  expect(connection.server.path).toBe("/psi");
});

test("connectionFromEndpoint: a split sftp endpoint mirror-swaps the inbound/outbound pair", () => {
  // The endpoint holds the INVITER's own pair; the acceptor reads where the
  // inviter writes (inviter outbound -> acceptor inbound) and vice versa, so the
  // partners start as mirror images.
  const endpoint: ConnectionEndpoint = {
    channel: "sftp",
    host: "sftp.example.org",
    port: 2222,
    inboundPath: "/exchange/inviter-in",
    outboundPath: "/exchange/inviter-out",
  };
  const { connection, seeded } = connectionFromEndpoint(endpoint);
  expect(seeded).toBe(true);
  expect(connection.channel).toBe("sftp");
  if (connection.channel !== "sftp") return;
  expect(connection.server.host).toBe("sftp.example.org");
  expect(connection.server.port).toBe(2222);
  expect(connection.server.inboundPath).toBe("/exchange/inviter-out");
  expect(connection.server.outboundPath).toBe("/exchange/inviter-in");
  // The single shared `path` form is not used in split mode.
  expect(connection.server.path).toBeUndefined();
  expect(connection.server.username).toMatch(/REPLACE_WITH/);
  // Split mode requires retain mode (which implies lockless + timestamped names),
  // seeded so the written config is a runnable starting point.
  expect(connection.options?.retainFiles).toBe(true);
  expect(connection.options?.locklessRendezvous).toBe(true);
  expect(connection.options?.timestampInFilename).toBe(true);
});

test("connectionFromEndpoint: a split filedrop endpoint mirror-swaps the inbound/outbound pair", () => {
  const endpoint: ConnectionEndpoint = {
    channel: "filedrop",
    inboundPath: "/mnt/share/from-inviter",
    outboundPath: "/mnt/share/to-inviter",
  };
  const { connection, seeded } = connectionFromEndpoint(endpoint);
  expect(seeded).toBe(true);
  expect(connection.channel).toBe("filedrop");
  if (connection.channel !== "filedrop") return;
  expect(connection.inboundPath).toBe("/mnt/share/to-inviter");
  expect(connection.outboundPath).toBe("/mnt/share/from-inviter");
  expect(connection.path).toBeUndefined();
  expect(connection.options?.retainFiles).toBe(true);
  expect(connection.options?.locklessRendezvous).toBe(true);
  expect(connection.options?.timestampInFilename).toBe(true);
});

test.each(["sftp", "filedrop"] as const)(
  "connectionFromEndpoint: the swapped %s split config validates against the connection schema",
  (channel) => {
    // The seeded split config must be a coherent ConnectionConfig the operator
    // can run after filling credentials -- in particular the retain-mode trio
    // makes the split-directory requirement pass. Filling the sftp credential
    // placeholder is the only edit a runnable config still needs.
    const endpoint: ConnectionEndpoint =
      channel === "sftp"
        ? {
            channel: "sftp",
            host: "sftp.example.org",
            inboundPath: "/exchange/in",
            outboundPath: "/exchange/out",
          }
        : {
            channel: "filedrop",
            inboundPath: "/mnt/share/in",
            outboundPath: "/mnt/share/out",
          };
    const { connection } = connectionFromEndpoint(endpoint);
    const parsed = safeParseConnectionConfig(connection);
    expect(parsed.success).toBe(true);
  },
);

test("connectionFromEndpoint: throws on a filedrop endpoint naming no directory", () => {
  // The endpoint schema forbids a filedrop endpoint with neither a path nor a
  // split pair, but `path` is optional in the type, so a caller that bypasses
  // decode can construct one. The guard fails clearly at the swap site rather
  // than letting an undefined path show up as an opaque downstream schema error.
  expect(() => connectionFromEndpoint({ channel: "filedrop" })).toThrow(
    /neither a path nor a split/,
  );
});

// --- applyEndpointSplitDirectories (online accept merge) ---------------------

test("applyEndpointSplitDirectories: grafts a split sftp endpoint onto the URL connection, keeping host/credentials", () => {
  // The acceptor's URL holds the reachable host + credentials; the endpoint
  // holds the inviter's split pair. The merged connection reaches the host the
  // URL names with the URL's credentials, but reads/writes the mirror-swapped
  // directories (inviter outbound -> acceptor inbound) the endpoint conveys.
  const urlConnection = connectionFromURL(
    new URL("sftp://alice:secret@reach-host:2200/ignored-url-path"),
    {},
  );
  const endpoint: ConnectionEndpoint = {
    channel: "sftp",
    host: "inviter-host",
    port: 22,
    inboundPath: "/exchange/inviter-in",
    outboundPath: "/exchange/inviter-out",
  };
  const { connection, appliedSplitDirectories } = applyEndpointSplitDirectories(
    urlConnection,
    endpoint,
  );
  expect(appliedSplitDirectories).toBe(true);
  if (connection.channel !== "sftp") throw new Error("expected sftp");
  // Host/port/credentials are the URL's, never the endpoint's.
  expect(connection.server.host).toBe("reach-host");
  expect(connection.server.port).toBe(2200);
  expect(connection.server.username).toBe("alice");
  expect(connection.server.password).toBe("secret");
  // Mirror-swapped pair from the endpoint; the URL's single path is dropped.
  expect(connection.server.inboundPath).toBe("/exchange/inviter-out");
  expect(connection.server.outboundPath).toBe("/exchange/inviter-in");
  expect(connection.server.path).toBeUndefined();
  // The retain trio a split exchange requires is seeded.
  expect(connection.options?.retainFiles).toBe(true);
  expect(connection.options?.locklessRendezvous).toBe(true);
  expect(connection.options?.timestampInFilename).toBe(true);
});

test("applyEndpointSplitDirectories: grafts a split filedrop endpoint onto a filedrop URL", () => {
  const urlConnection = connectionFromURL(new URL("file:///mnt/ignored"), {});
  const endpoint: ConnectionEndpoint = {
    channel: "filedrop",
    inboundPath: "/mnt/share/from-inviter",
    outboundPath: "/mnt/share/to-inviter",
  };
  const { connection, appliedSplitDirectories } = applyEndpointSplitDirectories(
    urlConnection,
    endpoint,
  );
  expect(appliedSplitDirectories).toBe(true);
  if (connection.channel !== "filedrop") throw new Error("expected filedrop");
  expect(connection.inboundPath).toBe("/mnt/share/to-inviter");
  expect(connection.outboundPath).toBe("/mnt/share/from-inviter");
  expect(connection.path).toBeUndefined();
  expect(connection.options?.retainFiles).toBe(true);
});

test("applyEndpointSplitDirectories: preserves URL-derived options under the retain trio", () => {
  // A --connection-timeout set on the URL connection must survive the merge:
  // the retain trio is layered over the existing options, not substituted for it.
  const urlConnection = connectionFromURL(new URL("sftp://host/in"), {
    options: { connectionTimeout: 45 },
  });
  const endpoint: ConnectionEndpoint = {
    channel: "sftp",
    host: "host",
    inboundPath: "/a",
    outboundPath: "/b",
  };
  const { connection } = applyEndpointSplitDirectories(urlConnection, endpoint);
  expect(connection.options?.serverConnectTimeoutMs).toBe(45_000);
  expect(connection.options?.retainFiles).toBe(true);
});

test("applyEndpointSplitDirectories: a non-split endpoint is a no-op", () => {
  const urlConnection = connectionFromURL(new URL("sftp://host/drop"), {});
  const endpoint: ConnectionEndpoint = {
    channel: "sftp",
    host: "inviter-host",
    path: "/inviter/drop",
  };
  const { connection, appliedSplitDirectories } = applyEndpointSplitDirectories(
    urlConnection,
    endpoint,
  );
  expect(appliedSplitDirectories).toBe(false);
  expect(connection).toBe(urlConnection);
});

test.each([
  ["no endpoint", undefined],
  [
    "a webrtc endpoint",
    { channel: "webrtc", host: "peer.example.org", path: "/psi" },
  ],
] as const)(
  "applyEndpointSplitDirectories: %s leaves the URL connection unchanged",
  (_label, endpoint) => {
    const urlConnection = connectionFromURL(new URL("sftp://host/drop"), {});
    const { connection, appliedSplitDirectories } =
      applyEndpointSplitDirectories(urlConnection, endpoint);
    expect(appliedSplitDirectories).toBe(false);
    expect(connection).toBe(urlConnection);
  },
);

test("applyEndpointSplitDirectories: a channel-mismatched endpoint places the roles per the URL's channel", () => {
  // A bridged acceptor may reach the rendezvous over a different channel than the
  // inviter advertises (see FILE_SYNC.md). The resulting connection's channel is
  // the URL's, and the swapped path strings land where that channel keeps them --
  // here a filedrop endpoint's roles graft onto an sftp URL's `server.*`, with
  // the host/credentials still the URL's.
  const urlConnection = connectionFromURL(
    new URL("sftp://alice@reach-host/ignored"),
    {},
  );
  const endpoint: ConnectionEndpoint = {
    channel: "filedrop",
    inboundPath: "/mnt/inviter-in",
    outboundPath: "/mnt/inviter-out",
  };
  const { connection, appliedSplitDirectories } = applyEndpointSplitDirectories(
    urlConnection,
    endpoint,
  );
  expect(appliedSplitDirectories).toBe(true);
  expect(connection.channel).toBe("sftp");
  if (connection.channel !== "sftp") return;
  expect(connection.server.host).toBe("reach-host");
  expect(connection.server.username).toBe("alice");
  // Mirror-swapped from the filedrop endpoint, placed under the sftp `server`.
  expect(connection.server.inboundPath).toBe("/mnt/inviter-out");
  expect(connection.server.outboundPath).toBe("/mnt/inviter-in");
});

test("applyEndpointSplitDirectories: rejects a degenerate (relative-path) filedrop endpoint", () => {
  // The endpoint schema permits relative filedrop paths (it defers the
  // absolute-path rule to the acceptor's own config), so the grafted connection
  // can violate it. Validation fails it here, before any network activity, with
  // the schema's own message rather than an opaque connect-time error.
  const urlConnection = connectionFromURL(new URL("file:///mnt/ignored"), {});
  const endpoint: ConnectionEndpoint = {
    channel: "filedrop",
    inboundPath: "relative/in",
    outboundPath: "relative/out",
  };
  expect(() => applyEndpointSplitDirectories(urlConnection, endpoint)).toThrow(
    UsageError,
  );
});

// --- inviterConnectionFromURL ------------------------------------------------

test("inviterConnectionFromURL: a file-sync URL is built exactly as connectionFromURL builds it", () => {
  for (const raw of ["sftp://alice@host:2222/drop", "file:///mnt/share/drop"])
    expect(inviterConnectionFromURL(new URL(raw), {})).toEqual(
      connectionFromURL(new URL(raw), {}),
    );
});

test("inviterConnectionFromURL: a wss URL maps to the coordination server's location", () => {
  const conn = inviterConnectionFromURL(
    new URL("wss://peers.example.org:8443/psi"),
    {},
  );
  expect(conn).toEqual({
    channel: "webrtc",
    server: { host: "peers.example.org", port: 8443, path: "/psi" },
  });
});

test("inviterConnectionFromURL: a ws URL records the plaintext choice", () => {
  // `secure` is the one thing a wss: URL leaves unset -- the config default is
  // already TLS -- while ws: has to say so, since the socket is otherwise built
  // over TLS and reaches nothing.
  const conn = inviterConnectionFromURL(new URL("ws://127.0.0.1:9000/psi"), {});
  if (conn.channel !== "webrtc") throw new Error("expected webrtc");
  expect(conn.server.secure).toBe(false);
  expect(
    inviterConnectionFromURL(new URL("wss://peers.example.org/psi"), {})
      .channel,
  ).toBe("webrtc");
});

test("inviterConnectionFromURL: a bare-host webrtc URL leaves the port unset but names the mount point", () => {
  // The port default lives in the broker-location resolution (443/80), so
  // pinning it here would restate one place's answer in another; the scheme's
  // own default port is normalized away by the URL parser before it is read.
  // The PATH is different: this connection's locator is minted onto an
  // invitation a partner's own client resolves, and an absent path is resolved
  // to that client's default rather than to this one's, so the resolved mount
  // point is recorded here instead of being left to be re-derived.
  for (const raw of [
    "wss://peers.example.org",
    "wss://peers.example.org/",
    "wss://peers.example.org:443/",
  ]) {
    const conn = inviterConnectionFromURL(new URL(raw), {});
    if (conn.channel !== "webrtc") throw new Error("expected webrtc");
    expect(conn.server.port).toBeUndefined();
    expect(conn.server.path).toBe("/");
  }
});

test("inviterConnectionFromURL: refuses pre-mint every shape the dial would refuse", () => {
  // The invitation is minted from this connection and printed before anything
  // is dialed, so a shape the dial rejects must fail HERE -- otherwise the run
  // discloses a live token and only then reports the URL unusable. Percent
  // encoding is what moves these past the userinfo/query/fragment checks: the
  // parser leaves `%3F` in the path, and decoding it yields a delimiter that
  // could move the signaling socket.
  for (const raw of [
    "wss://peers.example.org/psi%3Fkey=private",
    "wss://peers.example.org/psi%23fragment",
    "wss://peers.example.org/psi%40elsewhere.example.org",
    "wss://peers.example.org/psi%5Celsewhere",
    "wss://peers.example.org/psi%20space",
  ]) {
    expect(() => inviterConnectionFromURL(new URL(raw), {})).toThrow(
      UsageError,
    );
    expect(() => inviterConnectionFromURL(new URL(raw), {})).toThrow(
      /could move the signaling socket/,
    );
  }
  // Port 0 is a legal port number the connection schema admits and nothing
  // listens on; the same refusal, from the same resolution.
  expect(() =>
    inviterConnectionFromURL(new URL("wss://peers.example.org:0/psi"), {}),
  ).toThrow(/not a dialable port/);
});

test("inviterConnectionFromURL: a plaintext webrtc URL raises no dial-time advisory at mint", () => {
  // The connection resolves through the broker-location guard here, which warns
  // on a plaintext socket through the transport's own logger. That advisory
  // belongs to the run that dials; the inviting command names the endpoint's own
  // plaintext limitation itself, so a copy at mint would double-report it. The
  // spy is on the transport logger the guard's default callback writes to, which
  // is what makes this a silence that was measured rather than assumed.
  const transportLog = getLogger("webrtc");
  const warnSpy = vi.spyOn(transportLog, "warn");
  try {
    const conn = inviterConnectionFromURL(
      new URL("ws://127.0.0.1:9000/psi"),
      {},
    );
    if (conn.channel !== "webrtc") throw new Error("expected webrtc");
    expect(conn.server.secure).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
    // The same guard, called the way the dial calls it, does warn -- so the
    // silence above is the callback this builder passes, not a guard that never
    // speaks.
    brokerLocationFromConnection(conn.server);
    expect(warnSpy).toHaveBeenCalled();
  } finally {
    warnSpy.mockRestore();
  }
});

test("inviterConnectionFromURL: a webrtc URL holding anything past the location is refused", () => {
  // Each of these has no field in the connection this builds, so accepting the
  // URL would drop the operator's own input silently.
  for (const raw of [
    "wss://someone@peers.example.org/psi",
    "wss://someone:secret@peers.example.org/psi",
    "wss://peers.example.org/psi?key=private",
    "wss://peers.example.org/psi#fragment",
  ]) {
    expect(() => inviterConnectionFromURL(new URL(raw), {})).toThrow(
      UsageError,
    );
    expect(() => inviterConnectionFromURL(new URL(raw), {})).toThrow(
      /host, port, and path/,
    );
  }
});

test("inviterConnectionFromURL: the parser itself makes a host-less webrtc URL unreachable", () => {
  // Why the builder has no empty-host guard where the sftp branch does:
  // ws:/wss: are SPECIAL schemes, so the parse either fails outright or takes
  // the first path segment as the host. Asserted against the parser rather than
  // read off its documentation.
  expect(() => new URL("wss://")).toThrow();
  expect(new URL("wss:///psi").hostname).toBe("psi");
  const conn = inviterConnectionFromURL(new URL("wss:///psi"), {});
  if (conn.channel !== "webrtc") throw new Error("expected webrtc");
  expect(conn.server.host).toBe("psi");
});

test("inviterConnectionFromURL: the parser never hands the builder an empty webrtc pathname", () => {
  // The mint reads `pathname` unconditionally, on the assumption that a special
  // scheme always yields at least "/". Measured against the parser, not read off
  // it: an empty value would be recorded as a mount point no broker resolves,
  // and would then be refused by the broker-location guard.
  for (const raw of [
    "wss://peers.example.org",
    "wss://peers.example.org:8443",
    "wss:///psi",
    "ws://127.0.0.1:9000",
  ])
    expect(new URL(raw).pathname).not.toBe("");
});

test("inviterConnectionFromURL: the shared timeouts apply on webrtc, the file-sync options do not", () => {
  // peer_timeout maps the invite's --accept-timeout onto the rendezvous wait;
  // the poll interval belongs to a channel that polls, and webrtc does not.
  const conn = inviterConnectionFromURL(
    new URL("wss://peers.example.org/psi"),
    {
      options: { peerTimeout: 900, pollIntervalMs: 5_000 },
    },
  );
  expect(conn.options).toEqual({ peerTimeoutMs: 900_000 });
});

test("inviterConnectionFromURL: --outbound-path on a webrtc URL is refused, not dropped", () => {
  // A split directory has no meaning on a channel with no directory at all.
  expect(() =>
    inviterConnectionFromURL(new URL("wss://peers.example.org/psi"), {
      options: { retainFiles: true },
      server: { outboundPath: "/out" },
    }),
  ).toThrow(/only supported on the sftp and filedrop channels/);
});

// --- endpointFromConnection --------------------------------------------------

test("endpointFromConnection: an sftp connection emits the host/port/path locator", () => {
  const connection = connectionFromURL(
    new URL("sftp://sftp.example.org:2222/exchanges/drop"),
    {},
  );
  const endpoint = endpointFromConnection(connection);
  expect(endpoint).toEqual({
    channel: "sftp",
    host: "sftp.example.org",
    port: 2222,
    path: "/exchanges/drop",
  });
});

test("endpointFromConnection: a bare-host sftp connection emits no path", () => {
  // A bare host (no remote path) leaves `path` unset rather than encoding "" or
  // "/"; the endpoint schema requires a non-empty path when present.
  const endpoint = endpointFromConnection(
    connectionFromURL(new URL("sftp://sftp.example.org"), {}),
  );
  expect(endpoint).toEqual({ channel: "sftp", host: "sftp.example.org" });
});

test("endpointFromConnection: no credential rides along on the emitted endpoint", () => {
  // The inviter's connection holds credentials (username/private key/
  // passphrase); the endpoint must hold only the public locator. This is the
  // producer side of the invitation's no-credentials invariant. password is
  // omitted here since it is mutually exclusive with privateKey.
  const connection = connectionFromURL(new URL("sftp://host:2200/drop"), {
    server: {
      username: "alice",
      privateKey: "@/home/alice/.ssh/id_ed25519",
      privateKeyPassphrase: "hunter2",
    },
  });
  const endpoint = endpointFromConnection(connection);
  expect(Object.keys(endpoint).sort()).toEqual([
    "channel",
    "host",
    "path",
    "port",
  ]);
  // Strongest leak check: none of the secret values appear anywhere in the
  // serialized endpoint (the path the invitation actually encodes).
  const serialized = JSON.stringify(endpoint);
  expect(serialized).not.toContain("alice");
  expect(serialized).not.toContain("hunter2");
  expect(serialized).not.toContain("id_ed25519");
});

test("endpointFromConnection: a filedrop connection emits the shared path locator", () => {
  const endpoint = endpointFromConnection(
    connectionFromURL(new URL("file:///mnt/share/drop"), {}),
  );
  expect(endpoint).toEqual({ channel: "filedrop", path: "/mnt/share/drop" });
});

test("endpointFromConnection: a port the endpoint schema rejects (0) is dropped", () => {
  // The connection schema permits port 0 (OS-assigned ephemeral); the endpoint
  // schema rejects it as an unreachable connect target, so it is omitted rather
  // than emitted as a locator the partner could not dial.
  const connection = connectionFromURL(new URL("sftp://host:0/drop"), {});
  if (connection.channel !== "sftp") throw new Error("expected sftp");
  expect(connection.server.port).toBe(0);
  const endpoint = endpointFromConnection(connection);
  if (endpoint.channel !== "sftp") throw new Error("expected sftp endpoint");
  expect(endpoint.port).toBeUndefined();
});

test.each(["sftp", "filedrop"] as const)(
  "endpointFromConnection: a split %s connection emits the inbound/outbound pair VERBATIM",
  (channel) => {
    // --outbound-path splits the URL/positional path (inbound) from a separate
    // outbound directory; the endpoint holds the inviter's own pair unswapped,
    // since the mirror swap is the acceptor's job (connectionFromEndpoint).
    const url =
      channel === "sftp"
        ? new URL("sftp://host/inviter-in")
        : new URL("file:///inviter-in");
    const connection = connectionFromURL(url, {
      options: { retainFiles: true },
      server: { outboundPath: "/inviter-out" },
    });
    const endpoint = endpointFromConnection(connection);
    if (endpoint.channel !== channel) throw new Error(`expected ${channel}`);
    expect(endpoint.inboundPath).toBe("/inviter-in");
    expect(endpoint.outboundPath).toBe("/inviter-out");
    expect(endpoint.path).toBeUndefined();
  },
);

test("endpointFromConnection -> connectionFromEndpoint round-trips a split pair mirror-swapped", () => {
  // End-to-end producer -> consumer: the inviter emits its pair verbatim, and the
  // acceptor's single swap site lands the inviter's outbound on the acceptor's
  // inbound.
  const connection = connectionFromURL(new URL("file:///inviter-in"), {
    options: { retainFiles: true },
    server: { outboundPath: "/inviter-out" },
  });
  const endpoint = endpointFromConnection(connection);
  const { connection: seeded } = connectionFromEndpoint(endpoint);
  if (seeded.channel !== "filedrop") throw new Error("expected filedrop");
  expect(seeded.inboundPath).toBe("/inviter-out");
  expect(seeded.outboundPath).toBe("/inviter-in");
});

test("endpointFromConnection: a webrtc connection emits the signaling locator", () => {
  const endpoint = endpointFromConnection(
    inviterConnectionFromURL(new URL("wss://peers.example.org:8443/psi"), {}),
  );
  expect(endpoint).toEqual({
    channel: "webrtc",
    host: "peers.example.org",
    port: 8443,
    path: "/psi",
  });
});

test("endpointFromConnection: nothing but the webrtc locator survives the emit", () => {
  // The producer side of the no-credentials invariant on this channel: a
  // hand-authored connection holding the broker API key, a TURN relay's
  // credential, an ICE provisioning secret, and the plaintext scheme emits the
  // locator alone. `secure` is dropped with them -- the endpoint schema has no
  // field for it -- which is why an acceptor seeded from one resolves TLS.
  const endpoint = endpointFromConnection({
    channel: "webrtc",
    server: {
      host: "peers.example.org",
      port: 8443,
      path: "/psi",
      username: "alice",
      key: "broker-api-key",
      secure: false,
      provision: {
        host: "provision.example.org",
        auth: { bearer: "topsecret" },
      },
    },
    role: "inviter",
    turn: [
      {
        url: "turns:relay.example.org:443",
        username: "psilink",
        credential: "relaysecret",
      },
    ],
  });
  expect(Object.keys(endpoint).sort()).toEqual([
    "channel",
    "host",
    "path",
    "port",
  ]);
  const serialized = JSON.stringify(endpoint);
  for (const leak of [
    "alice",
    "broker-api-key",
    "topsecret",
    "relaysecret",
    "relay.example.org",
    "secure",
    "role",
  ])
    expect(serialized).not.toContain(leak);
});

test("endpointFromConnection: webrtc values the endpoint schema rejects are dropped", () => {
  // Port 0 and an empty path are both connection-permits / endpoint-rejects
  // shapes: emitting either would fail the whole invite at encode with an opaque
  // schema error, and neither is a locator a partner could dial.
  const endpoint = endpointFromConnection({
    channel: "webrtc",
    server: { host: "peers.example.org", port: 0, path: "" },
  });
  expect(endpoint).toEqual({ channel: "webrtc", host: "peers.example.org" });
});

test("endpointFromConnection -> connectionFromEndpoint round-trips a webrtc locator", () => {
  // End-to-end producer -> consumer: the acceptor's seeded connection names the
  // inviter's own coordination server rather than any hard-coded default, and
  // has no credential field to fill in (this channel authenticates from the
  // shared secret).
  const endpoint = endpointFromConnection(
    inviterConnectionFromURL(new URL("wss://peers.example.org:8443/psi"), {}),
  );
  const { connection: seeded, seeded: wasSeeded } =
    connectionFromEndpoint(endpoint);
  expect(wasSeeded).toBe(true);
  expect(seeded).toEqual({
    channel: "webrtc",
    server: { host: "peers.example.org", port: 8443, path: "/psi" },
  });
});

test("endpointFromConnection: an over-long webrtc host is a clean usage error", () => {
  expect(() =>
    endpointFromConnection({
      channel: "webrtc",
      server: { host: "a".repeat(257) },
    }),
  ).toThrow(/host is too long/);
  expect(() =>
    endpointFromConnection({
      channel: "webrtc",
      server: { host: "peers.example.org", path: `/${"p".repeat(4097)}` },
    }),
  ).toThrow(/path is too long/);
});

test("endpointFromConnection: an over-long host is a clean usage error, not an opaque encode failure", () => {
  // The connection schema bounds host only by non-emptiness; the endpoint caps it
  // at MAX_ENDPOINT_HOST_LENGTH. A degenerate over-long host is rejected here with
  // a field-named UsageError rather than left to throw a ZodError at encode.
  const connection = connectionFromURL(
    new URL(`sftp://${"a".repeat(257)}/drop`),
    {},
  );
  expect(() => endpointFromConnection(connection)).toThrow(UsageError);
  expect(() => endpointFromConnection(connection)).toThrow(/host is too long/);
});

test("endpointFromConnection: an over-long path is a clean usage error", () => {
  const connection = connectionFromURL(
    new URL(`sftp://host/${"p".repeat(4097)}`),
    {},
  );
  expect(() => endpointFromConnection(connection)).toThrow(UsageError);
  expect(() => endpointFromConnection(connection)).toThrow(/path is too long/);
});

test("endpointFromConnection: an over-long split outbound_path is a clean usage error", () => {
  // The split pair is bounded too; --outbound-path supplies the outbound half.
  const connection = connectionFromURL(new URL("file:///inviter-in"), {
    options: { retainFiles: true },
    server: { outboundPath: `/${"o".repeat(4097)}` },
  });
  expect(() => endpointFromConnection(connection)).toThrow(/outbound_path/);
});

test("endpointFromConnection: a host at the length limit is accepted", () => {
  // Boundary: exactly MAX_ENDPOINT_HOST_LENGTH characters is within bounds, so the
  // guard rejects only what the endpoint schema would, never a hair short of it.
  const host = "a".repeat(256);
  const endpoint = endpointFromConnection(
    connectionFromURL(new URL(`sftp://${host}/drop`), {}),
  );
  if (endpoint.channel !== "sftp") throw new Error("expected sftp");
  expect(endpoint.host).toBe(host);
});

// --- generateSharedSecret -------------------------------------------------------

test("generateSharedSecret: matches the shared secret format and is non-deterministic", () => {
  const a = generateSharedSecret();
  const b = generateSharedSecret();
  expect(a).toMatch(SHARED_SECRET_REGEX);
  expect(b).toMatch(SHARED_SECRET_REGEX);
  expect(a).not.toBe(b);
});

// --- buildDataSpec -----------------------------------------------------------

const COLUMNS = ["first_name", "last_name", "dob", "ssn"];
const ROWS = {
  rawRows: [
    {
      first_name: "Alice",
      last_name: "Smith",
      dob: "1990-01-02",
      ssn: "123456789",
    },
  ],
  columns: COLUMNS,
};

test("buildDataSpec: infers linkage terms, metadata, and standardization from input (invite)", () => {
  const dataSpec = buildDataSpec({
    identity: "Agency A",
    rows: ROWS,
  });
  expect(dataSpec.linkageTerms.identity).toBe("Agency A");
  expect(dataSpec.linkageTerms.linkageKeys.length).toBeGreaterThan(0);
  expect(dataSpec.metadata).toBeDefined();
  expect(dataSpec.standardization).toBeDefined();
});

test("buildDataSpec: without input rows, the spec is just the supplied terms (accept)", () => {
  const dataSpec = buildDataSpec({
    identity: "Agency B",
    rows: ROWS,
  });
  // Reuse the inferred terms as a stand-in for an invitation's terms.
  const termsOnly = buildDataSpec({
    terms: dataSpec.linkageTerms,
    identity: "Agency B",
  });
  expect(termsOnly.linkageTerms).toEqual(dataSpec.linkageTerms);
  expect(termsOnly.metadata).toBeUndefined();
  expect(termsOnly.standardization).toBeUndefined();
});

test("buildDataSpec: neither terms nor input rows is refused rather than yielding an empty spec", () => {
  // Neither CLI path can reach this (offline invite always has input, accept
  // always has the invitation's terms), so the guard exists for a direct
  // caller: a spec with no linkage terms would otherwise reach the exchange as
  // terms nobody authored.
  expect(() => buildDataSpec({ identity: "Agency A" })).toThrow(
    /requires either terms or input rows/,
  );
});

test("buildDataSpec: supplied terms plus input infer metadata and standardization (accept)", () => {
  const inferred = buildDataSpec({
    identity: "Agency C",
    rows: ROWS,
  });
  const dataSpec = buildDataSpec({
    terms: inferred.linkageTerms,
    identity: "Agency C",
    rows: ROWS,
  });
  expect(dataSpec.linkageTerms).toEqual(inferred.linkageTerms);
  expect(dataSpec.metadata).toBeDefined();
  expect(dataSpec.standardization).toBeDefined();
});

// --- runOnlineBootstrap: config persisted at handshake success ---------------

/** Minimal valid params for runOnlineBootstrap; runProtocol is mocked, so the
 *  connection/prepared/key fields are never exercised against a real transport.
 */
function onlineBootstrapParams(
  configPath: string,
): Parameters<typeof runOnlineBootstrap>[0] {
  const dataSpec = buildDataSpec({ identity: "Agency A", rows: ROWS });
  const connection: RunnableConnectionConfig = {
    channel: "filedrop",
    path: "/tmp/psilink-drop",
  };
  return {
    connection,
    dataSpec,
    prepared: {} as unknown as PreparedExchange,
    sharedSecret: generateSharedSecret(),
    expires: undefined,
    keyPath: path.join(path.dirname(configPath), ".psilink.key"),
    configPath,
    output: undefined,
    verbosity: -1,
    loggerName: "bootstrap-test",
    recordOutput: undefined,
  };
}

/** The options object a mocked runProtocol call received. */
function optionsArg(callArgs: unknown[]): RunProtocolOptions {
  return callArgs[0] as RunProtocolOptions;
}

/** runProtocol's onAuthenticated hook, which every caller here supplies. */
function onAuthenticatedArg(callArgs: unknown[]): () => void | Promise<void> {
  const hook = optionsArg(callArgs).onAuthenticated;
  expect(hook).toBeTypeOf("function");
  return hook as () => void | Promise<void>;
}

/** runProtocol's FileSyncRuntimeOptions, which every caller here supplies. */
function runtimeOptionsArg(callArgs: unknown[]): {
  eventStream?: unknown;
  onOutputComplete?: (context: {
    observedReceivedPayloadColumns: string[];
  }) => void | Promise<void>;
} {
  const runtime = optionsArg(callArgs).fileSyncRuntime;
  expect(runtime).toBeDefined();
  return runtime as {
    eventStream?: unknown;
    onOutputComplete?: (context: {
      observedReceivedPayloadColumns: string[];
    }) => void | Promise<void>;
  };
}

test("runOnlineBootstrap writes the config from the hook even when the exchange then fails", async () => {
  // Handshake succeeds (runProtocol invokes onAuthenticated -> saveConfig), then
  // the data exchange fails. The config must already be on disk so the
  // recurring-exchange setup is recoverable without re-inviting.
  vi.mocked(runProtocol).mockImplementation((async (...callArgs: unknown[]) => {
    const onAuthenticated = onAuthenticatedArg(callArgs);
    await onAuthenticated();
    throw new Error("data exchange failed");
  }) as never);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bootstrap-"));
  const configPath = path.join(dir, "psilink.yaml");
  try {
    await expect(
      runOnlineBootstrap(onlineBootstrapParams(configPath)),
    ).rejects.toThrow("data exchange failed");
    expect(fs.existsSync(configPath)).toBe(true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runOnlineBootstrap does not write the config when the handshake fails", async () => {
  // The handshake fails before acceptance, so runProtocol never invokes the
  // hook. No config must be written -- preserving the "declined or unreachable
  // partner leaves no config behind" guarantee.
  vi.mocked(runProtocol).mockImplementation((async () => {
    throw new Error("partner declined the invitation");
  }) as never);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bootstrap-"));
  const configPath = path.join(dir, "psilink.yaml");
  try {
    await expect(
      runOnlineBootstrap(onlineBootstrapParams(configPath)),
    ).rejects.toThrow("partner declined");
    expect(fs.existsSync(configPath)).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runOnlineBootstrap passes a webrtc connection through to the exchange and the saved config", async () => {
  // The inviter's own webrtc connection reaches runProtocol unchanged (role
  // included -- without it the dial refuses) and is what the hook persists, so
  // the recurring `psilink exchange` this bootstrap sets up meets the same
  // coordination server the invitation named.
  const connection: WebRTCConnectionConfig = {
    channel: "webrtc",
    server: { host: "peers.example.org", port: 8443, path: "/psi" },
    role: "inviter",
    options: { peerTimeoutMs: 900_000 },
  };
  vi.mocked(runProtocol).mockImplementation((async (...callArgs: unknown[]) => {
    await onAuthenticatedArg(callArgs)();
    return {};
  }) as never);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bootstrap-"));
  const configPath = path.join(dir, "psilink.yaml");
  try {
    await runOnlineBootstrap({
      ...onlineBootstrapParams(configPath),
      connection,
    });
    expect(vi.mocked(runProtocol).mock.lastCall?.[0].connection).toEqual(
      connection,
    );
    // Reloaded through the schema, which materializes its own option defaults,
    // so the assertion is on what this bootstrap wrote rather than on those.
    const saved = parseExchangeSpec(
      YAML.parse(fs.readFileSync(configPath, "utf8")),
    );
    expect(saved.connection).toMatchObject({
      channel: "webrtc",
      server: connection.server,
      role: "inviter",
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runOnlineBootstrap spends a run-only peer budget on the run and writes none of it", async () => {
  // The online inviter's --accept-timeout: a window for one operator waiting at
  // a rendezvous, which must bound the run it was typed for and nothing after
  // it. The config this same call writes is what every later unattended
  // `psilink exchange` reads, so putting the budget into it would hand those
  // runs a peer timeout nobody chose for them.
  vi.mocked(runProtocol).mockImplementation((async (...callArgs: unknown[]) => {
    await onAuthenticatedArg(callArgs)();
    return {};
  }) as never);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bootstrap-"));
  const configPath = path.join(dir, "psilink.yaml");
  try {
    await runOnlineBootstrap({
      ...onlineBootstrapParams(configPath),
      runOnlyPeerTimeoutSeconds: 900,
    });
    const ran = vi.mocked(runProtocol).mock.lastCall?.[0]
      .connection as ConnectionConfig;
    expect(ran.options?.peerTimeoutMs).toBe(900_000);
    // Read raw rather than through parseExchangeSpec, which materializes the
    // schema's own defaults and so cannot tell an absent field from a written
    // one.
    const saved = YAML.parse(fs.readFileSync(configPath, "utf8")) as {
      connection: { options?: Record<string, unknown> };
    };
    expect(saved.connection.options?.["peer_timeout_ms"]).toBeUndefined();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runOnlineBootstrap leaves a connection's own peer budget on both the run and the config", async () => {
  // The budget the operator put on the connection is not the run-only one: it is
  // theirs to keep, so it reaches the exchange and the saved config alike, and
  // the run-only value layered over it changes only what this run waits on.
  vi.mocked(runProtocol).mockImplementation((async (...callArgs: unknown[]) => {
    await onAuthenticatedArg(callArgs)();
    return {};
  }) as never);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bootstrap-"));
  const configPath = path.join(dir, "psilink.yaml");
  const params = onlineBootstrapParams(configPath);
  try {
    await runOnlineBootstrap({
      ...params,
      connection: { ...params.connection, options: { peerTimeoutMs: 60_000 } },
      runOnlyPeerTimeoutSeconds: 900,
    });
    const ran = vi.mocked(runProtocol).mock.lastCall?.[0]
      .connection as ConnectionConfig;
    expect(ran.options?.peerTimeoutMs).toBe(900_000);
    const saved = YAML.parse(fs.readFileSync(configPath, "utf8")) as {
      connection: { options?: Record<string, unknown> };
    };
    expect(saved.connection.options?.["peer_timeout_ms"]).toBe(60_000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runOnlineBootstrap returns the config-write error when the hook fails but the exchange succeeds", async () => {
  // The hook (saveConfig) failed at acceptance, but the exchange still
  // succeeded, so runProtocol resolves with onAuthenticatedError set.
  // runOnlineBootstrap must forward it as configWriteError so the caller can
  // avoid claiming the config was saved.
  const writeError = new Error("disk full while writing config");
  vi.mocked(runProtocol).mockImplementation((async () => ({
    onAuthenticatedError: writeError,
  })) as never);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bootstrap-"));
  const configPath = path.join(dir, "psilink.yaml");
  try {
    const { configWriteError } = await runOnlineBootstrap(
      onlineBootstrapParams(configPath),
    );
    expect(configWriteError).toBe(writeError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runOnlineBootstrap reports no config-write error on a clean run", async () => {
  // runProtocol resolves with no onAuthenticatedError (the hook succeeded), so
  // runOnlineBootstrap reports a clean outcome.
  vi.mocked(runProtocol).mockImplementation((async () => ({})) as never);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bootstrap-"));
  const configPath = path.join(dir, "psilink.yaml");
  try {
    const { configWriteError } = await runOnlineBootstrap(
      onlineBootstrapParams(configPath),
    );
    expect(configWriteError).toBeUndefined();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- observedReceivedColumnsForSave ------------------------------------------

test("observedReceivedColumnsForSave keeps a non-empty observation", () => {
  expect(observedReceivedColumnsForSave(["dob", "zip"])).toEqual([
    "dob",
    "zip",
  ]);
});

test("observedReceivedColumnsForSave drops an empty or absent observation", () => {
  // An empty observed set is the ambiguous zero-match / discloses-nothing case, so
  // it is left absent (lazy) rather than persisted as a strict "receive nothing".
  expect(observedReceivedColumnsForSave([])).toBeUndefined();
  expect(observedReceivedColumnsForSave(undefined)).toBeUndefined();
});

test("observedReceivedColumnsForSave drops an over-cap observation (stays loadable)", () => {
  // The wire caps each column NAME's length but not the column COUNT, while the
  // persisted expected_payload_columns is bounded to MAX_PAYLOAD_ENTRIES on reload.
  // Persisting an over-cap observed set would write a config this party can no
  // longer load, so it is dropped (stays lazy) rather than crystallized.
  const atCap = Array.from({ length: MAX_PAYLOAD_ENTRIES }, (_, i) => `c${i}`);
  const overCap = Array.from(
    { length: MAX_PAYLOAD_ENTRIES + 1 },
    (_, i) => `c${i}`,
  );
  expect(observedReceivedColumnsForSave(atCap)).toEqual(atCap);
  expect(observedReceivedColumnsForSave(overCap)).toBeUndefined();
});

// --- runOnlineBootstrap: observe-then-persist received-payload commitment ----

/** Mock runProtocol as a successful exchange, in its real order: invoke the
 *  onAuthenticated hook, run `betweenStages`, then invoke the pre-terminal
 *  onOutputComplete hook with the observed received-payload columns, and
 *  resolve with the same observation, as the real runProtocol does. An absent
 *  `observed` means the caller learns nothing, though the hook still receives
 *  an empty array, as the real one always does. */
function mockSuccessfulExchange(
  observed: string[] | undefined,
  betweenStages?: () => void,
): void {
  vi.mocked(runProtocol).mockImplementation((async (...callArgs: unknown[]) => {
    const onAuthenticated = optionsArg(callArgs).onAuthenticated as
      (() => void | Promise<void>) | undefined;
    await onAuthenticated?.();
    betweenStages?.();
    await runtimeOptionsArg(callArgs).onOutputComplete?.({
      observedReceivedPayloadColumns: observed ?? [],
    });
    return { observedReceivedPayloadColumns: observed };
  }) as never);
}

test("runOnlineBootstrap crystallizes the observed received set when the inviter opts in", async () => {
  // The online inviter passes persistObservedReceivedPayload: after the exchange
  // it re-writes the freshly-saved config with the columns it observed, so a later
  // `psilink exchange` fails closed on a divergent payload.
  mockSuccessfulExchange(["dob", "zip"]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bootstrap-"));
  const configPath = path.join(dir, "psilink.yaml");
  try {
    await runOnlineBootstrap({
      ...onlineBootstrapParams(configPath),
      persistObservedReceivedPayload: true,
    });
    const written = YAML.parse(fs.readFileSync(configPath, "utf8"));
    expect(written.expected_payload_columns).toEqual(["dob", "zip"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runOnlineBootstrap crystallizes from the pre-terminal hook, not after runProtocol returns", async () => {
  // WHERE the write happens is the contract, not just that it happens. A write
  // after runProtocol returns would land behind the run's terminal event --
  // forbidden by the stream spec and discarded outright by the job supervisor
  // -- so the write must ride runProtocol's pre-terminal hook. A runProtocol
  // that resolves with the observation without ever invoking that hook must
  // leave the config exactly as the acceptance write left it.
  vi.mocked(runProtocol).mockImplementation((async (...callArgs: unknown[]) => {
    const onAuthenticated = optionsArg(callArgs).onAuthenticated as
      (() => void | Promise<void>) | undefined;
    await onAuthenticated?.();
    return { observedReceivedPayloadColumns: ["dob", "zip"] };
  }) as never);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bootstrap-"));
  const configPath = path.join(dir, "psilink.yaml");
  try {
    await runOnlineBootstrap({
      ...onlineBootstrapParams(configPath),
      persistObservedReceivedPayload: true,
    });
    const written = YAML.parse(fs.readFileSync(configPath, "utf8"));
    expect(written.expected_payload_columns).toBeUndefined();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runOnlineBootstrap leaves an empty observation lazy even when the inviter opts in", async () => {
  // An observed-empty payload is an ambiguous zero-match run; persisting [] would
  // false-abort a later matching exchange, so no commitment is written.
  mockSuccessfulExchange([]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bootstrap-"));
  const configPath = path.join(dir, "psilink.yaml");
  try {
    await runOnlineBootstrap({
      ...onlineBootstrapParams(configPath),
      persistObservedReceivedPayload: true,
    });
    const written = YAML.parse(fs.readFileSync(configPath, "utf8"));
    expect(written.expected_payload_columns).toBeUndefined();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runOnlineBootstrap does not crystallize the observed set without the inviter opt-in", async () => {
  // The online acceptor learns its received set up front from the token and does
  // not pass persistObservedReceivedPayload, so its saved config records no
  // observed commitment.
  mockSuccessfulExchange(["dob", "zip"]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bootstrap-"));
  const configPath = path.join(dir, "psilink.yaml");
  try {
    await runOnlineBootstrap(onlineBootstrapParams(configPath));
    const written = YAML.parse(fs.readFileSync(configPath, "utf8"));
    expect(written.expected_payload_columns).toBeUndefined();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runOnlineBootstrap does not crystallize onto a reused pre-existing config", async () => {
  // With reuseExistingConfig the hook keeps the operator's config untouched
  // (configWritten stays false), so the observe-then-persist second write must not
  // fire and rewrite it -- even with the inviter opt-in set.
  mockSuccessfulExchange(["dob", "zip"]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bootstrap-"));
  const configPath = path.join(dir, "psilink.yaml");
  fs.writeFileSync(configPath, "preexisting: true\n");
  try {
    await runOnlineBootstrap({
      ...onlineBootstrapParams(configPath),
      reuseExistingConfig: true,
      persistObservedReceivedPayload: true,
    });
    // The operator's config is left exactly as it was.
    expect(fs.readFileSync(configPath, "utf8")).toBe("preexisting: true\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runOnlineBootstrap keeps a failed observed-payload write non-fatal", async () => {
  // The hook writes the config at acceptance; the observe-then-persist second write
  // then fails -- here the path is swapped for a directory after the hook runs, so
  // saveConfig's rename throws. That failure must be non-fatal: the completed
  // exchange is not undone, nothing rethrows, and the clean hook write is still
  // reported (configWriteError undefined). getLogger("bootstrap-test") is silenced
  // above, so the catch's warn does not print.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bootstrap-"));
  const configPath = path.join(dir, "psilink.yaml");
  mockSuccessfulExchange(["dob", "zip"], () => {
    fs.rmSync(configPath); // swap the acceptance hook's file for a directory
    fs.mkdirSync(configPath); // so the second saveConfig's rename throws (EISDIR)
  });
  try {
    const { configWriteError } = await runOnlineBootstrap({
      ...onlineBootstrapParams(configPath),
      persistObservedReceivedPayload: true,
    });
    expect(configWriteError).toBeUndefined();
    // The second write failed (the swapped-in directory is intact),
    // proving the non-fatal catch fired rather than the write silently succeeding.
    expect(fs.statSync(configPath).isDirectory()).toBe(true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runOnlineBootstrap reports a lost observed-payload write on fd 3 and in the exit code", async () => {
  // The same loss as the test above, seen by an unattended supervisor: the
  // configuration the run left behind is missing the commitment a later recurring
  // exchange would have been held to. Nothing about the completed exchange
  // changes -- it is not to be re-run -- so the report is a `warning` on the
  // machine-interface stream plus the persistence-loss exit code (73), never a
  // rejection. 69 would tell a supervisor to retry an exchange that already
  // happened.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bootstrap-"));
  const configPath = path.join(dir, "psilink.yaml");
  mockSuccessfulExchange(["dob", "zip"], () => {
    fs.rmSync(configPath); // swap the acceptance hook's file for a directory
    fs.mkdirSync(configPath); // so the second saveConfig's rename throws (EISDIR)
  });
  try {
    const { value, lines } = await captureFd3(() =>
      runOnlineBootstrap({
        ...onlineBootstrapParams(configPath),
        eventStream: true,
        persistObservedReceivedPayload: true,
      }),
    );
    expect(value.configWriteError).toBeUndefined();
    expect(process.exitCode).toBe(73);
    expect(lines.map((l) => l.type)).toEqual(["warning"]);
    expect(String(lines[0].message)).toContain(
      "recording the observed received-payload columns",
    );
    // The cause stays on the human log beside this: the emitter escapes its
    // message exactly once, so pre-rendered error text would reach a supervisor
    // double-escaped.
    expect(String(lines[0].message)).not.toContain("EISDIR");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runOnlineBootstrap hands runProtocol the emitter it opened itself, not the flag", async () => {
  // The other side of the fusion the warning above depends on: this bootstrap
  // opens the stream because it reports persistence it loses from outside
  // runProtocol's frame, and runProtocol must then reuse that emitter so both
  // sources ride one channel. Forwarding params.eventStream instead would still
  // produce a working stream -- a second one, from a second preflight -- so
  // object IDENTITY is what pins it, not the presence of a stream.
  mockSuccessfulExchange(undefined);
  vi.mocked(openEventStream).mockClear();
  vi.mocked(runProtocol).mockClear();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bootstrap-"));
  const configPath = path.join(dir, "psilink.yaml");
  try {
    const { lines } = await captureFd3(() =>
      runOnlineBootstrap({
        ...onlineBootstrapParams(configPath),
        eventStream: true,
      }),
    );
    // The bootstrap opened exactly one stream, from the flag it was given.
    expect(vi.mocked(openEventStream).mock.calls).toEqual([[true]]);
    const emitter = vi.mocked(openEventStream).mock.results[0];
    expect(emitter.type).toBe("return");
    expect(emitter.value).toBeDefined();
    // ...and that very object is what runProtocol received.
    const runtime = runtimeOptionsArg(vi.mocked(runProtocol).mock.calls[0]);
    expect(runtime.eventStream).toBe(emitter.value);
    // A clean run loses no persistence, so the stream holds nothing of the
    // bootstrap's own here (runProtocol, which owns the run's events, is mocked).
    expect(lines).toEqual([]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- runOnlineBootstrap: up-front token received-payload commitment (accept) -

test("runOnlineBootstrap persists the acceptor's up-front token received set into the fresh config", async () => {
  // The online ACCEPTOR knows the columns it consented to receive up front from the
  // token, so the set rides the acceptance hook's FIRST write (no observation
  // needed, unlike the inviter's observe-then-persist second write above). A later
  // `psilink exchange` then locks it in and fails closed on a divergent payload.
  mockSuccessfulExchange(undefined); // acceptor learns nothing by observation
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bootstrap-"));
  const configPath = path.join(dir, "psilink.yaml");
  try {
    await runOnlineBootstrap({
      ...onlineBootstrapParams(configPath),
      receivedPayloadLockIn: { consentedColumns: ["diagnosis", "notes"] },
    });
    const written = YAML.parse(fs.readFileSync(configPath, "utf8"));
    expect(written.expected_payload_columns).toEqual(["diagnosis", "notes"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runOnlineBootstrap persists the acceptance's declared deduplicate into the fresh config", async () => {
  // The terms-side twin of the commitment above, known at the same moment (the
  // consent surface stated it) and included in the same first write. Without it a
  // config born of an ONLINE acceptance runs its later recurring exchanges with
  // nothing to hold the partner's presented cardinality to.
  for (const declared of [false, true]) {
    mockSuccessfulExchange(undefined);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bootstrap-"));
    const configPath = path.join(dir, "psilink.yaml");
    try {
      await runOnlineBootstrap({
        ...onlineBootstrapParams(configPath),
        expectedPartnerDeduplicate: declared,
      });
      const reloaded = parseExchangeSpec(
        YAML.parse(fs.readFileSync(configPath, "utf8")),
      );
      expect(reloaded.expectedPartnerDeduplicate).toBe(declared);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("runOnlineBootstrap writes no declaration for a party that accepted none", async () => {
  // The online INVITER accepted no invitation, so its fresh config has no
  // binding at all -- an absent field, not a `false` that would refuse a partner
  // legitimately running as the "many" side.
  mockSuccessfulExchange(undefined);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bootstrap-"));
  const configPath = path.join(dir, "psilink.yaml");
  try {
    await runOnlineBootstrap(onlineBootstrapParams(configPath));
    const raw = fs.readFileSync(configPath, "utf8");
    expect(raw).not.toContain("expected_partner_deduplicate");
    expect(
      parseExchangeSpec(YAML.parse(raw)).expectedPartnerDeduplicate,
    ).toBeUndefined();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runOnlineBootstrap persists the acceptor's own outbound consent into the fresh config", async () => {
  // The send-side sibling of the commitment above, known at the same moment (it is the
  // set the acceptance displayed), so it rides the same first write. Without it the
  // fresh config would leave the acceptor's own disclosure unrecorded and a later
  // `psilink exchange` would transmit whatever its CSV happened to disclose.
  mockSuccessfulExchange(undefined);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bootstrap-"));
  const configPath = path.join(dir, "psilink.yaml");
  try {
    await runOnlineBootstrap({
      ...onlineBootstrapParams(configPath),
      outboundPayloadConsent: { status: "confirmed", columns: ["diagnosis"] },
    });
    const written = YAML.parse(fs.readFileSync(configPath, "utf8"));
    expect(written.outbound_payload_consent).toEqual({
      status: "confirmed",
      columns: ["diagnosis"],
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runOnlineBootstrap persists a pending outbound consent into the fresh config", async () => {
  // The unresolvable shape through the online first write: the acceptance could
  // not resolve the set, so `pending` rides the write and the first resolving run
  // shows and asks before anything is sent.
  mockSuccessfulExchange(undefined);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bootstrap-"));
  const configPath = path.join(dir, "psilink.yaml");
  try {
    await runOnlineBootstrap({
      ...onlineBootstrapParams(configPath),
      outboundPayloadConsent: { status: "pending" },
    });
    const written = YAML.parse(fs.readFileSync(configPath, "utf8"));
    expect(written.outbound_payload_consent).toEqual({ status: "pending" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runOnlineBootstrap refreshes a reused config's record to pending", async () => {
  // The unresolvable shape through the reuse refresh: a prior acceptance's
  // confirmed columns must not stand as if confirmed by THIS acceptance, which
  // displayed no set -- pending overwrites them and the next run asks.
  mockSuccessfulExchange(undefined);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bootstrap-"));
  const configPath = path.join(dir, "psilink.yaml");
  fs.writeFileSync(
    configPath,
    "preexisting: true\noutbound_payload_consent:\n  status: confirmed\n" +
      "  columns:\n    - stale_col\n",
  );
  try {
    await runOnlineBootstrap({
      ...onlineBootstrapParams(configPath),
      reuseExistingConfig: true,
      outboundPayloadConsent: { status: "pending" },
    });
    const written = YAML.parse(fs.readFileSync(configPath, "utf8"));
    expect(written.preexisting).toBe(true);
    expect(written.outbound_payload_consent).toEqual({ status: "pending" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runOnlineBootstrap refreshes the outbound consent surgically on a reused config", async () => {
  // The reuse path writes no fresh config, but the operator has just consented to
  // THIS acceptance's outbound set; leaving a prior record stale would make the
  // next recurring run stop for a set the operator never declined. The write is
  // surgical: the operator's own keys and comments survive it.
  mockSuccessfulExchange(undefined);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bootstrap-"));
  const configPath = path.join(dir, "psilink.yaml");
  fs.writeFileSync(
    configPath,
    "# operator note\npreexisting: true\noutbound_payload_consent:\n  status: pending\n",
  );
  try {
    await runOnlineBootstrap({
      ...onlineBootstrapParams(configPath),
      reuseExistingConfig: true,
      outboundPayloadConsent: { status: "confirmed", columns: ["diagnosis"] },
    });
    const raw = fs.readFileSync(configPath, "utf8");
    expect(raw).toContain("# operator note");
    const written = YAML.parse(raw);
    expect(written.preexisting).toBe(true);
    expect(written.outbound_payload_consent).toEqual({
      status: "confirmed",
      columns: ["diagnosis"],
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runOnlineBootstrap keeps a failed reuse-path consent refresh non-fatal", async () => {
  // The kept config stands whatever happens to the surgical refresh: here the
  // config path is a directory, so the refresh's read throws, and the completed
  // exchange must not be undone -- nothing rethrows and no configWriteError is
  // reported (that channel's recovery text is for the fresh-config write; the
  // catch's warn covers this one). getLogger("bootstrap-test") is silenced above,
  // so the warn does not print. A stale record only makes the next run ask again.
  mockSuccessfulExchange(undefined);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bootstrap-"));
  const configPath = path.join(dir, "psilink.yaml");
  fs.mkdirSync(configPath);
  try {
    const { configWriteError } = await runOnlineBootstrap({
      ...onlineBootstrapParams(configPath),
      reuseExistingConfig: true,
      outboundPayloadConsent: { status: "confirmed", columns: ["diagnosis"] },
    });
    expect(configWriteError).toBeUndefined();
    expect(fs.statSync(configPath).isDirectory()).toBe(true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runOnlineBootstrap omits the outbound consent when the caller passes none", async () => {
  // The online INVITER, which authored its own set at mint and pins it as
  // disclosedPayloadColumns instead: no consent record, so its runs stay lazy.
  mockSuccessfulExchange(undefined);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bootstrap-"));
  const configPath = path.join(dir, "psilink.yaml");
  try {
    await runOnlineBootstrap(onlineBootstrapParams(configPath));
    const written = YAML.parse(fs.readFileSync(configPath, "utf8"));
    expect(written.outbound_payload_consent).toBeUndefined();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runOnlineBootstrap persists an empty token set as a strict receive-nothing commitment", async () => {
  // Unlike the observe path (which drops an ambiguous empty observation), an empty
  // DISCLOSED subset held by the token is a real "receive nothing" commitment the
  // operator consented to: a later non-empty payload must abort, so the empty set is
  // written rather than left lazy.
  mockSuccessfulExchange(undefined);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bootstrap-"));
  const configPath = path.join(dir, "psilink.yaml");
  try {
    await runOnlineBootstrap({
      ...onlineBootstrapParams(configPath),
      receivedPayloadLockIn: { consentedColumns: [] },
    });
    const written = YAML.parse(fs.readFileSync(configPath, "utf8"));
    expect(written.expected_payload_columns).toEqual([]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runOnlineBootstrap omits the received commitment when the acceptor passes no token set", async () => {
  // A subset-less invitation (an older or metadata-unknown mint) has no disclosed
  // set, so the acceptor passes undefined and the fresh config records no
  // commitment -- the recurring exchange reconciles lazily.
  mockSuccessfulExchange(undefined);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bootstrap-"));
  const configPath = path.join(dir, "psilink.yaml");
  try {
    await runOnlineBootstrap(onlineBootstrapParams(configPath));
    const written = YAML.parse(fs.readFileSync(configPath, "utf8"));
    expect(written.expected_payload_columns).toBeUndefined();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- runOnlineBootstrap: reuse-path received-payload commitment refresh -------

/** Write the pre-existing config every reuse-refresh test below starts from: a
 *  loadable exchange config (so a recurring run's parseExchangeSpec reload is what
 *  the assertions read), plus a hand-authored comment and the stale commitment a
 *  prior acceptance recorded. The surgical write must overwrite or remove that
 *  commitment and leave the operator's comment and every other key alone. */
function writeReusedConfigWithStaleLockIn(configPath: string): void {
  saveConfig(configPath, {
    connection: { channel: "filedrop", path: "/tmp/psilink-drop" },
    linkageTerms: getDefaultLinkageTerms("Acceptor Org"),
  });
  // The note trails the commitment rather than heading it: a comment written
  // immediately above a key is that key's own, and the document model removes it
  // along with the key when a subset-less acceptance removes the field.
  fs.appendFileSync(
    configPath,
    "expected_payload_columns:\n  - old_col\n# operator note\n",
  );
}

test("runOnlineBootstrap refreshes a stale received commitment surgically on a reused config", async () => {
  // The reuse path writes no fresh config, but the operator has just consented to
  // THIS acceptance's disclosed set; leaving the prior acceptance's set standing
  // would false-abort the next recurring exchange. The write is surgical: the
  // operator's comment and other keys survive it.
  mockSuccessfulExchange(undefined);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bootstrap-"));
  const configPath = path.join(dir, "psilink.yaml");
  writeReusedConfigWithStaleLockIn(configPath);
  try {
    await runOnlineBootstrap({
      ...onlineBootstrapParams(configPath),
      reuseExistingConfig: true,
      receivedPayloadLockIn: { consentedColumns: ["diagnosis", "notes"] },
    });
    const raw = fs.readFileSync(configPath, "utf8");
    // The operator's comment and the rest of their config survive the write.
    expect(raw).toContain("# operator note");
    expect(raw).not.toContain("old_col");
    const reloaded = parseExchangeSpec(YAML.parse(raw));
    expect(reloaded.connection).toEqual({
      channel: "filedrop",
      path: "/tmp/psilink-drop",
    });
    expect(reloaded.linkageTerms).toEqual(
      getDefaultLinkageTerms("Acceptor Org"),
    );
    expect(reloaded.expectedPayloadColumns).toEqual(["diagnosis", "notes"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runOnlineBootstrap refreshes a stale declaration surgically on a reused config", async () => {
  // The reuse path writes no fresh config, so the declaration this acceptance
  // consented to reaches the kept config only through the surgical write. A prior
  // acceptance's `true` left standing would refuse the honest partner now
  // presenting `false`; the operator's comment and other keys survive the write.
  mockSuccessfulExchange(undefined);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bootstrap-"));
  const configPath = path.join(dir, "psilink.yaml");
  writeReusedConfigWithStaleLockIn(configPath);
  fs.appendFileSync(configPath, "expected_partner_deduplicate: true\n");
  try {
    await runOnlineBootstrap({
      ...onlineBootstrapParams(configPath),
      reuseExistingConfig: true,
      expectedPartnerDeduplicate: false,
    });
    const raw = fs.readFileSync(configPath, "utf8");
    expect(raw).toContain("# operator note");
    const reloaded = parseExchangeSpec(YAML.parse(raw));
    expect(reloaded.expectedPartnerDeduplicate).toBe(false);
    expect(reloaded.connection).toEqual({
      channel: "filedrop",
      path: "/tmp/psilink-drop",
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the refreshed reuse-path commitment fixes the false-abort a stale one would have caused", async () => {
  // The end-to-end failure this closes. The kept config holds the partner's OLD
  // disclosed set; the partner now discloses a new set, so a recurring exchange's
  // reconcileReceivedPayload would abort an honest exchange. After the online
  // re-accept the config holds the NEW set and the same reconcile passes --
  // asserting the stale set would have thrown proves the refresh changed the
  // outcome rather than the payload simply matching either way.
  mockSuccessfulExchange(undefined);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bootstrap-"));
  const configPath = path.join(dir, "psilink.yaml");
  writeReusedConfigWithStaleLockIn(configPath);
  try {
    const staleLockIn = parseExchangeSpec(
      YAML.parse(fs.readFileSync(configPath, "utf8")),
    ).expectedPayloadColumns;
    expect(staleLockIn).toEqual(["old_col"]);
    await runOnlineBootstrap({
      ...onlineBootstrapParams(configPath),
      reuseExistingConfig: true,
      receivedPayloadLockIn: { consentedColumns: ["diagnosis", "notes"] },
    });
    // Reload exactly as a recurring `psilink exchange` would, from the on-disk file.
    const refreshedLockIn = parseExchangeSpec(
      YAML.parse(fs.readFileSync(configPath, "utf8")),
    ).expectedPayloadColumns;
    // What the partner now transmits: its new disclosed set.
    const partnerPayload: PartnerPayload = {
      columns: ["diagnosis", "notes"],
      rowIndices: [],
      rows: [],
    };
    expect(() =>
      reconcileReceivedPayload(partnerPayload, refreshedLockIn),
    ).not.toThrow();
    expect(() => reconcileReceivedPayload(partnerPayload, staleLockIn)).toThrow(
      /payload disclosure mismatch/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runOnlineBootstrap removes a reused config's commitment for a subset-less invitation", async () => {
  // An acceptance whose invitation held no disclosed subset (an older or
  // metadata-unknown mint) consented to no set: the prior commitment is cleared so the
  // recurring exchange reconciles lazily, rather than enforcing a set this
  // acceptance never showed.
  mockSuccessfulExchange(undefined);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bootstrap-"));
  const configPath = path.join(dir, "psilink.yaml");
  writeReusedConfigWithStaleLockIn(configPath);
  try {
    await runOnlineBootstrap({
      ...onlineBootstrapParams(configPath),
      reuseExistingConfig: true,
      receivedPayloadLockIn: { consentedColumns: undefined },
    });
    const raw = fs.readFileSync(configPath, "utf8");
    expect(raw).toContain("# operator note");
    expect(raw).not.toContain("expected_payload_columns");
    expect(raw).not.toContain("old_col");
    const reloaded = parseExchangeSpec(YAML.parse(raw));
    expect(reloaded.linkageTerms).toEqual(
      getDefaultLinkageTerms("Acceptor Org"),
    );
    expect(reloaded.expectedPayloadColumns).toBeUndefined();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runOnlineBootstrap writes an empty reuse-path consented set verbatim", async () => {
  // An empty disclosed subset is a real consent ("receive nothing"), distinct from
  // absent: it replaces the stale set as an empty list, so a later non-empty payload
  // aborts while an empty one still passes.
  mockSuccessfulExchange(undefined);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bootstrap-"));
  const configPath = path.join(dir, "psilink.yaml");
  writeReusedConfigWithStaleLockIn(configPath);
  try {
    await runOnlineBootstrap({
      ...onlineBootstrapParams(configPath),
      reuseExistingConfig: true,
      receivedPayloadLockIn: { consentedColumns: [] },
    });
    const raw = fs.readFileSync(configPath, "utf8");
    expect(raw).not.toContain("old_col");
    const lockIn = parseExchangeSpec(YAML.parse(raw)).expectedPayloadColumns;
    expect(lockIn).toEqual([]);
    const received = (columns: string[]): PartnerPayload => ({
      columns,
      rowIndices: [],
      rows: [],
    });
    expect(() =>
      reconcileReceivedPayload(received(["diagnosis"]), lockIn),
    ).toThrow(/payload disclosure mismatch/);
    expect(() => reconcileReceivedPayload(received([]), lockIn)).not.toThrow();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runOnlineBootstrap leaves a reused config's commitment alone for a caller that owns none", async () => {
  // The wrapper's PRESENCE is what marks the caller that owns this field. A caller
  // with no commitment of its own -- the online inviter, whose received set is learned
  // by observation -- must not have its recorded set removed by the reuse refresh,
  // which would silently reopen the fail-closed enforcement its own config holds.
  mockSuccessfulExchange(["dob", "zip"]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bootstrap-"));
  const configPath = path.join(dir, "psilink.yaml");
  writeReusedConfigWithStaleLockIn(configPath);
  const before = fs.readFileSync(configPath, "utf8");
  try {
    await runOnlineBootstrap({
      ...onlineBootstrapParams(configPath),
      reuseExistingConfig: true,
      persistObservedReceivedPayload: true,
    });
    expect(fs.readFileSync(configPath, "utf8")).toBe(before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runOnlineBootstrap keeps a failed reuse-path commitment refresh non-fatal and reported", async () => {
  // The kept config stands whatever happens to the surgical refresh: here the
  // config path is a directory, so both refreshes' reads throw. The completed
  // exchange is not undone -- nothing rethrows and no configWriteError is
  // reported (that channel is for the fresh-config write) -- and each failure
  // is reported separately, proving the writes are caught independently.
  // getLogger("bootstrap-test") is silenced above, so the warns do not print.
  mockSuccessfulExchange(undefined);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bootstrap-"));
  const configPath = path.join(dir, "psilink.yaml");
  fs.mkdirSync(configPath);
  const warn = vi.spyOn(getLogger("bootstrap-test"), "warn");
  try {
    const { configWriteError } = await runOnlineBootstrap({
      ...onlineBootstrapParams(configPath),
      reuseExistingConfig: true,
      receivedPayloadLockIn: { consentedColumns: ["diagnosis"] },
      outboundPayloadConsent: { status: "confirmed", columns: ["dob"] },
    });
    expect(configWriteError).toBeUndefined();
    expect(fs.statSync(configPath).isDirectory()).toBe(true);
    const warned = warn.mock.calls.map((call) => String(call[0]));
    expect(
      warned.filter((m) => m.includes("consented to receive")),
    ).toHaveLength(1);
    expect(
      warned.filter((m) => m.includes("outbound-column confirmation")),
    ).toHaveLength(1);
  } finally {
    warn.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runOnlineBootstrap reports both lost reuse-path refreshes on fd 3 and in the exit code", async () => {
  // The unattended half of the two surgical refreshes: the kept configuration
  // stands, the exchange completed and must not be re-run, but the consent
  // records the operator just consented to are not in it. Each failure puts its
  // own `warning` on the machine-interface stream -- two lines, which is also
  // what proves the two writes stay independently caught once they report -- and
  // the run has the persistence-loss exit code rather than a clean 0.
  mockSuccessfulExchange(undefined);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bootstrap-"));
  const configPath = path.join(dir, "psilink.yaml");
  fs.mkdirSync(configPath); // a directory: both refreshes' reads throw
  try {
    const { value, lines } = await captureFd3(() =>
      runOnlineBootstrap({
        ...onlineBootstrapParams(configPath),
        eventStream: true,
        reuseExistingConfig: true,
        receivedPayloadLockIn: { consentedColumns: ["diagnosis"] },
        outboundPayloadConsent: { status: "confirmed", columns: ["dob"] },
      }),
    );
    expect(value.configWriteError).toBeUndefined();
    expect(process.exitCode).toBe(73);
    const messages = lines.map((l) => String(l.message));
    expect(lines.map((l) => l.type)).toEqual(["warning", "warning"]);
    expect(
      messages.filter((m) => m.includes("consented to receive")),
    ).toHaveLength(1);
    expect(
      messages.filter((m) => m.includes("outbound-column confirmation")),
    ).toHaveLength(1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the persisted empty online-accept commitment aborts a later non-empty payload", async () => {
  // The write-side test above proves an empty token set survives to disk as []; this
  // closes the loop at ENFORCEMENT time: a recurring exchange reloads that strict
  // "receive nothing" commitment and reconcileReceivedPayload aborts if the partner
  // then transmits any column, while an empty received payload still passes.
  mockSuccessfulExchange(undefined);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bootstrap-"));
  const configPath = path.join(dir, "psilink.yaml");
  try {
    await runOnlineBootstrap({
      ...onlineBootstrapParams(configPath),
      receivedPayloadLockIn: { consentedColumns: [] },
    });
    const reloaded = parseExchangeSpec(
      YAML.parse(fs.readFileSync(configPath, "utf8")),
    );
    const lockIn = reloaded.expectedPayloadColumns;
    expect(lockIn).toEqual([]);
    const received = (columns: string[]): PartnerPayload => ({
      columns,
      rowIndices: [],
      rows: [],
    });
    // Any transmitted column diverges from the strict empty commitment and aborts.
    expect(() =>
      reconcileReceivedPayload(received(["diagnosis"]), lockIn),
    ).toThrow(/payload disclosure mismatch/);
    // An empty received payload matches the empty commitment and passes.
    expect(() => reconcileReceivedPayload(received([]), lockIn)).not.toThrow();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runOnlineBootstrap rejects both received-payload persistence inputs at once", async () => {
  // The acceptor's up-front token set and the inviter's observe-on-save flag are
  // mutually exclusive; setting both is a caller error caught fail-fast, before any
  // connection, rather than silently letting the observe write clobber the token
  // commitment. runProtocol must never be reached.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bootstrap-"));
  const configPath = path.join(dir, "psilink.yaml");
  // Call counts accumulate across this file's tests (no shared reset hook), so clear
  // before asserting the guard short-circuits before runProtocol.
  vi.mocked(runProtocol).mockClear();
  try {
    await expect(
      runOnlineBootstrap({
        ...onlineBootstrapParams(configPath),
        receivedPayloadLockIn: { consentedColumns: ["diagnosis"] },
        persistObservedReceivedPayload: true,
      }),
    ).rejects.toThrow(/mutually exclusive/);
    expect(vi.mocked(runProtocol)).not.toHaveBeenCalled();
    expect(fs.existsSync(configPath)).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the persisted online-accept commitment drives fail-closed recurring enforcement", async () => {
  // End to end: the online accept writes expected_payload_columns from the token; a
  // later `psilink exchange` reloads that config (parseExchangeSpec) and locks the
  // set into reconcileReceivedPayload, which PASSES on a matching received payload
  // and ABORTS on a divergent one -- the same guarantee the offline-accept and
  // up-front-locked cases give.
  mockSuccessfulExchange(undefined);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bootstrap-"));
  const configPath = path.join(dir, "psilink.yaml");
  try {
    await runOnlineBootstrap({
      ...onlineBootstrapParams(configPath),
      receivedPayloadLockIn: { consentedColumns: ["diagnosis", "notes"] },
    });
    // Reload exactly as a recurring `psilink exchange` would, from the on-disk file.
    const reloaded = parseExchangeSpec(
      YAML.parse(fs.readFileSync(configPath, "utf8")),
    );
    const lockIn = reloaded.expectedPayloadColumns;
    expect(lockIn).toEqual(["diagnosis", "notes"]);
    const received = (columns: string[]): PartnerPayload => ({
      columns,
      rowIndices: [],
      rows: [],
    });
    // Matching payload (order-insensitive) reconciles cleanly.
    expect(() =>
      reconcileReceivedPayload(received(["notes", "diagnosis"]), lockIn),
    ).not.toThrow();
    // A divergent payload aborts the exchange, fail-closed.
    expect(() =>
      reconcileReceivedPayload(received(["diagnosis", "ssn"]), lockIn),
    ).toThrow(/payload disclosure mismatch/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runOnlineBootstrap persists an @path credential as the reference while connecting with the resolved value", async () => {
  // The invite/accept persistence path: the connection has an @path
  // server-password. saveConfig (in the hook) must write the @path, never the
  // secret, while runProtocol receives the resolved value to actually connect.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bootstrap-"));
  const pwFile = path.join(dir, "pw");
  fs.writeFileSync(pwFile, "s3cret\n");
  const configPath = path.join(dir, "psilink.yaml");

  let connectionPassedToRunProtocol: SFTPConnectionConfig | undefined;
  vi.mocked(runProtocol).mockImplementation((async (...callArgs: unknown[]) => {
    connectionPassedToRunProtocol = optionsArg(callArgs)
      .connection as SFTPConnectionConfig;
    const onAuthenticated = optionsArg(callArgs).onAuthenticated as
      (() => void | Promise<void>) | undefined;
    await onAuthenticated?.();
    return {};
  }) as never);

  try {
    const params = onlineBootstrapParams(configPath);
    const connection: SFTPConnectionConfig = {
      channel: "sftp",
      server: {
        host: "sftp.example.org",
        password: `@${pwFile}`,
        // Pinned (as if established out-of-band or on a prior first-use run), so
        // runOnlineBootstrap's first-use host-key step is a no-op and this test
        // exercises only credential resolution.
        hostKeyFingerprint: "SHA256:" + "A".repeat(43),
      },
    };
    await runOnlineBootstrap({ ...params, connection });

    // runProtocol connected with the resolved secret.
    expect(connectionPassedToRunProtocol?.server.password).toBe("s3cret");

    // The persisted config records the @path reference, not the secret. (Read
    // the value back through the YAML parser rather than as a raw substring: the
    // serializer may line-wrap a long quoted scalar, so a substring check on the
    // file text is brittle across temp-path lengths.)
    const written = fs.readFileSync(configPath, "utf8");
    expect(written).not.toContain("s3cret");
    const parsed = YAML.parse(written) as {
      connection: SFTPConnectionConfig;
    };
    expect(parsed.connection.server.password).toBe(`@${pwFile}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runOnlineBootstrap persists an @path private-key passphrase as the reference while connecting with the resolved value", async () => {
  // The encrypted-key end-to-end path: the connection has an @path private
  // key and its @path passphrase. saveConfig (in the hook) must write both @path
  // references, never the resolved secrets, while runProtocol receives the
  // resolved passphrase to actually unlock the key.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bootstrap-"));
  const keyFile = path.join(dir, "id_ed25519");
  const passFile = path.join(dir, "passphrase");
  fs.writeFileSync(keyFile, "KEYDATA\n");
  fs.writeFileSync(passFile, "unlock-me\n");
  const configPath = path.join(dir, "psilink.yaml");

  let connectionPassedToRunProtocol: SFTPConnectionConfig | undefined;
  vi.mocked(runProtocol).mockImplementation((async (...callArgs: unknown[]) => {
    connectionPassedToRunProtocol = optionsArg(callArgs)
      .connection as SFTPConnectionConfig;
    const onAuthenticated = optionsArg(callArgs).onAuthenticated as
      (() => void | Promise<void>) | undefined;
    await onAuthenticated?.();
    return {};
  }) as never);

  try {
    const params = onlineBootstrapParams(configPath);
    const connection: SFTPConnectionConfig = {
      channel: "sftp",
      server: {
        host: "sftp.example.org",
        privateKey: `@${keyFile}`,
        privateKeyPassphrase: `@${passFile}`,
        // Pinned so runOnlineBootstrap's first-use host-key step is a no-op and
        // this test exercises only credential resolution.
        hostKeyFingerprint: "SHA256:" + "A".repeat(43),
      },
    };
    await runOnlineBootstrap({ ...params, connection });

    // runProtocol connected with the resolved secrets.
    expect(connectionPassedToRunProtocol?.server.privateKey).toBe("KEYDATA");
    expect(connectionPassedToRunProtocol?.server.privateKeyPassphrase).toBe(
      "unlock-me",
    );

    // The persisted config records the @path references, not the secrets. On
    // disk the key is snake_case (private_key_passphrase), so read it as a raw
    // record rather than the camelCase SFTPConnectionConfig shape.
    const written = fs.readFileSync(configPath, "utf8");
    expect(written).not.toContain("unlock-me");
    expect(written).not.toContain("KEYDATA");
    const parsed = YAML.parse(written) as {
      connection: { server: Record<string, unknown> };
    };
    expect(parsed.connection.server.private_key).toBe(`@${keyFile}`);
    expect(parsed.connection.server.private_key_passphrase).toBe(
      `@${passFile}`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runOnlineBootstrap refuses a credential @path naming a missing file before the host-key step", async () => {
  // An invite or accept refused from purely local input must not have contacted
  // the server first -- the first-use host-key step is what would, since its
  // probe opens a real transport. A `--server-password @path` naming a missing
  // file is decided from this party's own filesystem, so the credential is read
  // (though applied later) before that step, and the run ends at the refusal --
  // a UsageError, mapped to exit 64 -- with the host-key step never entered.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bootstrap-"));
  const configPath = path.join(dir, "psilink.yaml");
  const connection: SFTPConnectionConfig = {
    channel: "sftp",
    server: {
      host: "sftp.example.org",
      password: `@${path.join(dir, "absent-password")}`,
    },
  };
  vi.mocked(establishHostKeyTrust).mockClear();
  vi.mocked(runProtocol).mockReset();
  try {
    await expect(
      runOnlineBootstrap({ ...onlineBootstrapParams(configPath), connection }),
    ).rejects.toThrow(UsageError);
    expect(vi.mocked(establishHostKeyTrust)).not.toHaveBeenCalled();
    expect(vi.mocked(runProtocol)).not.toHaveBeenCalled();
    expect(fs.existsSync(configPath)).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runOnlineBootstrap dials the connection the host-key step pinned", async () => {
  // The other half of reading the credential files early: the connection handed
  // to runProtocol is still cloned AFTER the host-key step, so the pin that step
  // writes onto the original is what the real open() enforces. A clone taken at
  // the read instead would hold the resolved credential and no pin, and dial an
  // unverified server -- so the run driven here supplies both.
  const FP = "SHA256:" + "D".repeat(43);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bootstrap-"));
  const configPath = path.join(dir, "psilink.yaml");
  const pwFile = path.join(dir, "pw");
  fs.writeFileSync(pwFile, "s3cret\n");
  const connection: SFTPConnectionConfig = {
    channel: "sftp",
    server: { host: "sftp.example.org", password: `@${pwFile}` },
  };

  vi.mocked(establishHostKeyTrust).mockImplementationOnce((async (
    conn: SFTPConnectionConfig,
  ) => {
    conn.server.hostKeyFingerprint = FP;
  }) as never);
  let connectionPassedToRunProtocol: SFTPConnectionConfig | undefined;
  vi.mocked(runProtocol).mockImplementation((async (...callArgs: unknown[]) => {
    connectionPassedToRunProtocol = optionsArg(callArgs)
      .connection as SFTPConnectionConfig;
    await onAuthenticatedArg(callArgs)();
    return {};
  }) as never);

  try {
    await runOnlineBootstrap({
      ...onlineBootstrapParams(configPath),
      connection,
    });
    expect(connectionPassedToRunProtocol?.server.hostKeyFingerprint).toBe(FP);
    // And the credential read before that step still reached the same object.
    expect(connectionPassedToRunProtocol?.server.password).toBe("s3cret");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A recovery note must point the user at `psilink exchange` only when the config
// is actually on disk. These tests spy on the (silenced) named logger that
// runOnlineBootstrap resolves internally via getLogger(loggerName).
const RECOVERY_NOTE = "retry with 'psilink exchange'";

test("runOnlineBootstrap notes the config is on disk when the exchange fails after the config was written", async () => {
  // Hook writes the config (real saveConfig), then the exchange fails. The user
  // must be told the config + key are on disk so they retry with
  // `psilink exchange` rather than re-inviting.
  vi.mocked(runProtocol).mockImplementation((async (...callArgs: unknown[]) => {
    const onAuthenticated = onAuthenticatedArg(callArgs);
    await onAuthenticated();
    throw new Error("data exchange failed");
  }) as never);

  const log = getLogger("bootstrap-recovery-test");
  log.setLevel("silent");
  const errorSpy = vi.spyOn(log, "error");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bootstrap-"));
  const configPath = path.join(dir, "psilink.yaml");
  try {
    await expect(
      runOnlineBootstrap({
        ...onlineBootstrapParams(configPath),
        loggerName: "bootstrap-recovery-test",
      }),
    ).rejects.toThrow("data exchange failed");
    expect(fs.existsSync(configPath)).toBe(true);
    expect(
      errorSpy.mock.calls.some(
        (c) => typeof c[0] === "string" && c[0].includes(RECOVERY_NOTE),
      ),
    ).toBe(true);
  } finally {
    errorSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runOnlineBootstrap does not log a config-on-disk note when the handshake fails", async () => {
  // The handshake fails before the hook runs, so the config is not on disk; no
  // recovery note must claim otherwise.
  vi.mocked(runProtocol).mockImplementation((async () => {
    throw new Error("partner declined the invitation");
  }) as never);

  const log = getLogger("bootstrap-recovery-test");
  log.setLevel("silent");
  const errorSpy = vi.spyOn(log, "error");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bootstrap-"));
  const configPath = path.join(dir, "psilink.yaml");
  try {
    await expect(
      runOnlineBootstrap({
        ...onlineBootstrapParams(configPath),
        loggerName: "bootstrap-recovery-test",
      }),
    ).rejects.toThrow("partner declined");
    expect(fs.existsSync(configPath)).toBe(false);
    expect(
      errorSpy.mock.calls.some(
        (c) => typeof c[0] === "string" && c[0].includes(RECOVERY_NOTE),
      ),
    ).toBe(false);
  } finally {
    errorSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runOnlineBootstrap with reuseExistingConfig does not log a recovery note when the handshake fails before the key is saved", async () => {
  // Reuse keeps a pre-existing config (on disk), but a pre-handshake failure
  // (declined, expired, unreachable) never reaches the hook, so runProtocol never
  // saves the rotated key. The recovery note must not fire: `psilink exchange`
  // would fail on the missing key. This guards the keyPersisted gate -- before
  // it, `reuseExistingConfig` alone fired the note regardless of the key.
  vi.mocked(runProtocol).mockImplementation((async () => {
    throw new Error("partner declined the invitation");
  }) as never);

  const log = getLogger("bootstrap-recovery-test");
  log.setLevel("silent");
  const errorSpy = vi.spyOn(log, "error");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bootstrap-"));
  const configPath = path.join(dir, "psilink.yaml");
  try {
    fs.writeFileSync(configPath, "channel: filedrop\npath: /mnt/share\n");
    await expect(
      runOnlineBootstrap({
        ...onlineBootstrapParams(configPath),
        loggerName: "bootstrap-recovery-test",
        reuseExistingConfig: true,
      }),
    ).rejects.toThrow("partner declined");
    expect(
      errorSpy.mock.calls.some(
        (c) => typeof c[0] === "string" && c[0].includes(RECOVERY_NOTE),
      ),
    ).toBe(false);
  } finally {
    errorSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runOnlineBootstrap with reuseExistingConfig logs the recovery note when the exchange fails after the handshake", async () => {
  // The complement of the test above: the handshake succeeds (hook reached, so
  // the rotated key is saved) and the reused config is on disk, then the exchange
  // fails. Both files are present, so the note must point at `psilink exchange`.
  vi.mocked(runProtocol).mockImplementation((async (...callArgs: unknown[]) => {
    const onAuthenticated = onAuthenticatedArg(callArgs);
    await onAuthenticated();
    throw new Error("data exchange failed");
  }) as never);

  const log = getLogger("bootstrap-recovery-test");
  log.setLevel("silent");
  const errorSpy = vi.spyOn(log, "error");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bootstrap-"));
  const configPath = path.join(dir, "psilink.yaml");
  try {
    fs.writeFileSync(configPath, "channel: filedrop\npath: /mnt/share\n");
    await expect(
      runOnlineBootstrap({
        ...onlineBootstrapParams(configPath),
        loggerName: "bootstrap-recovery-test",
        reuseExistingConfig: true,
      }),
    ).rejects.toThrow("data exchange failed");
    expect(
      errorSpy.mock.calls.some(
        (c) => typeof c[0] === "string" && c[0].includes(RECOVERY_NOTE),
      ),
    ).toBe(true);
  } finally {
    errorSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- logOnlineBootstrapOutcome ----------------------------------------------

test("logOnlineBootstrapOutcome: a clean run reports both files saved", () => {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as ReturnType<typeof getLogger>;
  logOnlineBootstrapOutcome(log, {
    configFile: "psilink.yaml",
    keyFile: ".psilink.key",
  });
  expect(log.warn).not.toHaveBeenCalled();
  expect(log.error).not.toHaveBeenCalled();
  expect(log.info).toHaveBeenCalledTimes(1);
  expect(vi.mocked(log.info).mock.calls[0][0]).toContain(
    "saved config to psilink.yaml",
  );
});

test("logOnlineBootstrapOutcome: a config-write failure logs at error level and does not claim the config was saved", () => {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as ReturnType<typeof getLogger>;
  const exitCodeBefore = process.exitCode;
  logOnlineBootstrapOutcome(log, {
    configFile: "psilink.yaml",
    keyFile: ".psilink.key",
    configWriteError: new Error("permission denied"),
  });
  // The summary moves no process state: the exit code that keeps a wrapper
  // gating on exit status from reading a rotated key with no configuration as a
  // completed setup is set where the write failed, not here.
  expect(process.exitCode).toBe(exitCodeBefore);
  expect(log.info).not.toHaveBeenCalled();
  // Logged at error level (not warn) so it stays visible at --log-level=error,
  // where the underlying hook error it references is also shown.
  expect(log.warn).not.toHaveBeenCalled();
  expect(log.error).toHaveBeenCalledTimes(1);
  const msg = vi.mocked(log.error).mock.calls[0][0] as string;
  // The rotated key is still reported saved; the config is reported NOT written.
  expect(msg).toContain("rotated key was saved to .psilink.key");
  expect(msg).toContain("could not be written to psilink.yaml");
  expect(msg).not.toContain("saved config to");
});

test("logOnlineBootstrapOutcome: a reused config reports the existing config and the rotated key", () => {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as ReturnType<typeof getLogger>;
  logOnlineBootstrapOutcome(log, {
    configFile: "psilink.yaml",
    keyFile: ".psilink.key",
    reuseExistingConfig: true,
  });
  expect(log.warn).not.toHaveBeenCalled();
  expect(log.error).not.toHaveBeenCalled();
  expect(log.info).toHaveBeenCalledTimes(1);
  const msg = vi.mocked(log.info).mock.calls[0][0] as string;
  expect(msg).toContain("reused the existing configuration");
  expect(msg).toContain("rotated key");
});

// --- runOnlineBootstrap: reuse + write-time re-gate --------------------------

test("runOnlineBootstrap with reuseExistingConfig keeps the existing config and reports no write error", async () => {
  // The hook is a no-op when reusing: the pre-existing config is left as-is and
  // only the rotated key (saved by runProtocol) lands.
  vi.mocked(runProtocol).mockImplementation((async (...callArgs: unknown[]) => {
    const onAuthenticated = onAuthenticatedArg(callArgs);
    await onAuthenticated();
    return {};
  }) as never);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bootstrap-"));
  const configPath = path.join(dir, "psilink.yaml");
  try {
    const existing = "channel: filedrop\npath: /mnt/share\n# user-authored\n";
    fs.writeFileSync(configPath, existing);
    const { configWriteError } = await runOnlineBootstrap({
      ...onlineBootstrapParams(configPath),
      reuseExistingConfig: true,
    });
    expect(configWriteError).toBeUndefined();
    // The user's config is untouched: reuse never rewrites it.
    expect(fs.readFileSync(configPath, "utf8")).toBe(existing);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runOnlineBootstrap re-gates the config write: a config appearing after the check is not silently overwritten", async () => {
  // Emulate runProtocol's hook handling: a hook failure is captured as
  // onAuthenticatedError (non-fatal), not propagated -- the same contract the
  // real runProtocol upholds.
  vi.mocked(runProtocol).mockImplementation((async (...callArgs: unknown[]) => {
    const onAuthenticated = onAuthenticatedArg(callArgs);
    try {
      await onAuthenticated();
      return {};
    } catch (err) {
      return { onAuthenticatedError: err };
    }
  }) as never);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bootstrap-"));
  const configPath = path.join(dir, "psilink.yaml");
  try {
    // A config "appears" between the pre-network conflict check and the write.
    const existing = "channel: filedrop\npath: /mnt/share\n# pre-existing\n";
    fs.writeFileSync(configPath, existing);
    // reuseExistingConfig is NOT set: this is the write-fresh path, so the hook
    // must detect the appeared file and refuse rather than overwrite it.
    const { configWriteError } = await runOnlineBootstrap(
      onlineBootstrapParams(configPath),
    );
    expect(configWriteError).toBeInstanceOf(UsageError);
    // The pre-existing file is left untouched -- not silently overwritten.
    expect(fs.readFileSync(configPath, "utf8")).toBe(existing);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- diffConnectionAgainstTarget ---------------------------------------------
// These compare a saved config against the connection the live exchange will
// actually use (a built RunnableConnectionConfig, as connectionFromURL would
// produce), so the diff's verdict matches the live connection field for field.
// URL-specific parsing (port truthiness, path "/", percent-encoding) lives in
// connectionFromURL and is tested above.

test("diffConnectionAgainstTarget: an agreeing sftp config has no conflicts or warnings", () => {
  const existing: ConnectionConfig = {
    channel: "sftp",
    server: {
      host: "host",
      port: 2222,
      path: "/drop",
      username: "alice",
      password: "s3cr3t",
    },
  };
  const target: RunnableConnectionConfig = {
    channel: "sftp",
    server: {
      host: "host",
      port: 2222,
      path: "/drop",
      username: "alice",
      password: "s3cr3t",
    },
  };
  const r = diffConnectionAgainstTarget(existing, target);
  expect(r.conflicts).toEqual([]);
  expect(r.warnings).toEqual([]);
});

test("diffConnectionAgainstTarget: a host mismatch is a conflict (which drop)", () => {
  const existing: ConnectionConfig = {
    channel: "sftp",
    server: { host: "other-host" },
  };
  const target: RunnableConnectionConfig = {
    channel: "sftp",
    server: { host: "host", path: "/drop" },
  };
  const r = diffConnectionAgainstTarget(existing, target);
  expect(r.conflicts.map((d) => d.field)).toContain("connection.server.host");
});

test("diffConnectionAgainstTarget: host comparison is case-insensitive (same endpoint)", () => {
  // DNS is case-insensitive, and the live connection uses the host as-is, so a
  // case-only difference must not abort.
  const existing: ConnectionConfig = {
    channel: "sftp",
    server: { host: "host.example.com" },
  };
  const target: RunnableConnectionConfig = {
    channel: "sftp",
    server: { host: "Host.Example.COM" },
  };
  const r = diffConnectionAgainstTarget(existing, target);
  expect(r.conflicts).toEqual([]);
  expect(r.warnings).toEqual([]);
});

test("diffConnectionAgainstTarget: an sftp path mismatch is a conflict (which drop)", () => {
  const existing: ConnectionConfig = {
    channel: "sftp",
    server: { host: "host", path: "/old" },
  };
  const target: RunnableConnectionConfig = {
    channel: "sftp",
    server: { host: "host", path: "/new" },
  };
  const r = diffConnectionAgainstTarget(existing, target);
  expect(r.conflicts.map((d) => d.field)).toContain("connection.server.path");
});

test("diffConnectionAgainstTarget: a trailing-slash-only path difference is not a conflict", () => {
  // FileSyncConnection strips a single trailing slash, so /drop and /drop/ are
  // the same directory at runtime.
  const existing: ConnectionConfig = {
    channel: "sftp",
    server: { host: "host", path: "/drop" },
  };
  const target: RunnableConnectionConfig = {
    channel: "sftp",
    server: { host: "host", path: "/drop/" },
  };
  const r = diffConnectionAgainstTarget(existing, target);
  expect(r.conflicts).toEqual([]);
});

test("diffConnectionAgainstTarget: a path the target omits is not flagged", () => {
  const existing: ConnectionConfig = {
    channel: "sftp",
    server: { host: "host", path: "/drop" },
  };
  const target: RunnableConnectionConfig = {
    channel: "sftp",
    server: { host: "host" },
  };
  const r = diffConnectionAgainstTarget(existing, target);
  expect(r.conflicts).toEqual([]);
  expect(r.warnings).toEqual([]);
});

test("diffConnectionAgainstTarget: a differing port warns (how you reach), not conflicts", () => {
  const existing: ConnectionConfig = {
    channel: "sftp",
    server: { host: "host", port: 22 },
  };
  const target: RunnableConnectionConfig = {
    channel: "sftp",
    server: { host: "host", port: 2222 },
  };
  const r = diffConnectionAgainstTarget(existing, target);
  expect(r.conflicts).toEqual([]);
  expect(r.warnings.some((w) => w.includes("2222"))).toBe(true);
});

test("diffConnectionAgainstTarget: a target port equal to the config is silent", () => {
  const existing: ConnectionConfig = {
    channel: "sftp",
    server: { host: "host", port: 2222 },
  };
  const target: RunnableConnectionConfig = {
    channel: "sftp",
    server: { host: "host", port: 2222 },
  };
  const r = diffConnectionAgainstTarget(existing, target);
  expect(r.warnings).toEqual([]);
});

test("diffConnectionAgainstTarget: the default port 22 against an unset config is silent", () => {
  // An unset config port means the SFTP default (22), so a target restating 22
  // is not a divergence and must not warn.
  const existing: ConnectionConfig = {
    channel: "sftp",
    server: { host: "host" },
  };
  const target: RunnableConnectionConfig = {
    channel: "sftp",
    server: { host: "host", port: 22 },
  };
  const r = diffConnectionAgainstTarget(existing, target);
  expect(r.conflicts).toEqual([]);
  expect(r.warnings).toEqual([]);
});

test("diffConnectionAgainstTarget: a non-default port against an unset config warns", () => {
  const existing: ConnectionConfig = {
    channel: "sftp",
    server: { host: "host" },
  };
  const target: RunnableConnectionConfig = {
    channel: "sftp",
    server: { host: "host", port: 2222 },
  };
  const r = diffConnectionAgainstTarget(existing, target);
  expect(r.warnings.some((w) => w.includes("2222"))).toBe(true);
});

test("diffConnectionAgainstTarget: credentials the target omits are not flagged", () => {
  const existing: ConnectionConfig = {
    channel: "sftp",
    server: { host: "host", username: "alice", password: "s3cr3t" },
  };
  const target: RunnableConnectionConfig = {
    channel: "sftp",
    server: { host: "host" },
  };
  const r = diffConnectionAgainstTarget(existing, target);
  expect(r.conflicts).toEqual([]);
  expect(r.warnings).toEqual([]);
});

test("diffConnectionAgainstTarget: differing credentials warn without echoing the value", () => {
  const existing: ConnectionConfig = {
    channel: "sftp",
    server: { host: "host", username: "bob", password: "saved-secret" },
  };
  const target: RunnableConnectionConfig = {
    channel: "sftp",
    server: { host: "host", username: "alice", password: "new-secret" },
  };
  const r = diffConnectionAgainstTarget(existing, target);
  expect(r.conflicts).toEqual([]);
  const joined = r.warnings.join(" | ");
  expect(joined).toContain("username");
  expect(joined).toContain("password");
  // No credential value -- saved or specified -- is ever echoed in a warning.
  expect(joined).not.toContain("saved-secret");
  expect(joined).not.toContain("new-secret");
  expect(joined).not.toContain("alice");
});

test("diffConnectionAgainstTarget: a differing private key warns without echoing it", () => {
  const existing: ConnectionConfig = {
    channel: "sftp",
    server: { host: "host", privateKey: "saved-key" },
  };
  const target: RunnableConnectionConfig = {
    channel: "sftp",
    server: { host: "host", privateKey: "new-key" },
  };
  const joined = diffConnectionAgainstTarget(existing, target).warnings.join(
    " | ",
  );
  expect(joined).toContain("private key");
  expect(joined).not.toContain("saved-key");
  expect(joined).not.toContain("new-key");
});

test("diffConnectionAgainstTarget: a channel mismatch warns and compares nothing else (file-sync)", () => {
  // file:// vs sftp:// is a legitimate different way of reaching the same drop;
  // it warns and short-circuits the per-channel fields rather than aborting.
  const existing: ConnectionConfig = {
    channel: "filedrop",
    path: "/mnt/share",
  };
  const target: RunnableConnectionConfig = {
    channel: "sftp",
    server: { host: "host", path: "/drop" },
  };
  const r = diffConnectionAgainstTarget(existing, target);
  expect(r.conflicts).toEqual([]);
  expect(r.warnings).toHaveLength(1);
  expect(r.warnings[0]).toContain("channel");
});

test("diffConnectionAgainstTarget: a filedrop path mismatch is a conflict", () => {
  const existing: ConnectionConfig = {
    channel: "filedrop",
    path: "/mnt/other",
  };
  const target: RunnableConnectionConfig = {
    channel: "filedrop",
    path: "/mnt/share/drop",
  };
  const r = diffConnectionAgainstTarget(existing, target);
  expect(r.conflicts.map((d) => d.field)).toContain("connection.path");
});

test("diffConnectionAgainstTarget: a filedrop trailing-slash-only difference is not a conflict", () => {
  const existing: ConnectionConfig = {
    channel: "filedrop",
    path: "/mnt/share",
  };
  const target: RunnableConnectionConfig = {
    channel: "filedrop",
    path: "/mnt/share/",
  };
  const r = diffConnectionAgainstTarget(existing, target);
  expect(r.conflicts).toEqual([]);
});

test("diffConnectionAgainstTarget: a filedrop path differing only by multiple trailing slashes is not a conflict", () => {
  // FileSyncConnection.open strips ALL trailing slashes from a filedrop path, so
  // "/drop//" and "/drop" are the same drop -- the diff must not over-abort.
  const existing: ConnectionConfig = {
    channel: "filedrop",
    path: "/mnt/share",
  };
  const target: RunnableConnectionConfig = {
    channel: "filedrop",
    path: "/mnt/share//",
  };
  const r = diffConnectionAgainstTarget(existing, target);
  expect(r.conflicts).toEqual([]);
});

test("diffConnectionAgainstTarget: a filedrop path differing only by backslashes is not a conflict", () => {
  // FileSyncConnection.open folds backslashes to forward slashes on a filedrop
  // path, so "C:\\drop" and "C:/drop" are the same drop to the live connection.
  const existing: ConnectionConfig = {
    channel: "filedrop",
    path: "C:\\share\\drop",
  };
  const target: RunnableConnectionConfig = {
    channel: "filedrop",
    path: "C:/share/drop",
  };
  const r = diffConnectionAgainstTarget(existing, target);
  expect(r.conflicts).toEqual([]);
});

// --- loadInputRows -----------------------------------------------------------

test("loadInputRows: a CSV piped via `-` yields the same rows as the equivalent file (invite path)", async () => {
  // invite reads its input through loadInputRows with allowStdin enabled; a CSV
  // piped through stdin must parse to the same rows and columns as the file.
  const csv = "first_name,last_name,dob\nAlice,Smith,1990-01-02\n";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-loadrows-"));
  try {
    const file = path.join(dir, "in.csv");
    fs.writeFileSync(file, csv);
    const fromFile = await loadInputRows(file, { allowStdin: true });
    const fromStdin = await withStdin(streamOf(csv), () =>
      loadInputRows("-", { allowStdin: true }),
    );
    expect(fromStdin).toEqual(fromFile);
    expect(fromStdin.columns).toEqual(["first_name", "last_name", "dob"]);
    expect(fromStdin.rawRows).toEqual([
      { first_name: "Alice", last_name: "Smith", dob: "1990-01-02" },
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadInputRows: a dataset with no data rows refuses, from a file or stdin", async () => {
  // An empty file and a header-only one are both well-formed CSV: the parser
  // reports nothing and every stage downstream accepts the empty set, so the run
  // would exchange nothing, write a result indistinguishable from a real
  // non-match, and exit 0. The loader refuses instead, as a usage error (exit 64)
  // naming the input, and identically whether the bytes came from a file or a
  // pipe.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-loadrows-empty-"));
  try {
    const empty = path.join(dir, "empty.csv");
    fs.writeFileSync(empty, "");
    const headerOnly = path.join(dir, "header-only.csv");
    fs.writeFileSync(headerOnly, "first_name,last_name,dob\n");

    await expect(
      loadInputRows(empty, { allowStdin: true }),
    ).rejects.toBeInstanceOf(UsageError);
    await expect(
      loadInputRows(headerOnly, { allowStdin: true }),
    ).rejects.toThrow(
      new RegExp(`${headerOnly.replace(/\\/g, "\\\\")} has no data rows`),
    );
    await expect(
      withStdin(streamOf("first_name,last_name,dob\n"), () =>
        loadInputRows("-", { allowStdin: true }),
      ),
    ).rejects.toThrow(/stdin has no data rows/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadInputRows: a row-level parse fault refuses before any exchange work", async () => {
  // The unattended shape: one unterminated quote in an upstream export collapses
  // the file to a handful of rows, which every stage downstream would accept. The
  // core loader refuses it, and the refusal is a usage error here too, so the
  // invite / accept / exchange / zero-setup paths that share this loader all exit
  // 64 rather than exchanging a truncated dataset.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-loadrows-fault-"));
  try {
    const file = path.join(dir, "in.csv");
    fs.writeFileSync(
      file,
      'first_name,dob\n"Alice,1990-01-02\nBob,1985-12-31\nCarol,1979-05-06\n',
    );
    await expect(
      loadInputRows(file, { allowStdin: true }),
    ).rejects.toBeInstanceOf(CsvRowParseError);
    await expect(
      loadInputRows(file, { allowStdin: true }),
    ).rejects.toBeInstanceOf(UsageError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadInputRows: `-` is rejected as a usage error when stdin is disallowed (accept path)", async () => {
  // accept passes allowStdin: false because it reads its y/N confirmation from
  // stdin; `-` must be a clear usage error naming a file path, never a silent
  // decline. The default is also stdin-disabled.
  await expect(
    loadInputRows("-", { allowStdin: false }),
  ).rejects.toBeInstanceOf(UsageError);
  await expect(loadInputRows("-", { allowStdin: false })).rejects.toThrow(
    /file path/,
  );
  await expect(loadInputRows("-")).rejects.toThrow(/stdin/);
});

test("loadInputRows: `-` at an interactive terminal is rejected (invite path inherits the TTY guard)", async () => {
  // invite allows stdin, but a `-` typed at a prompt with nothing piped would
  // hang on an EOF that never arrives; the shared guard rejects it up front.
  await withStdin(ttyStream(), async () => {
    await expect(
      loadInputRows("-", { allowStdin: true }),
    ).rejects.toBeInstanceOf(UsageError);
    await expect(loadInputRows("-", { allowStdin: true })).rejects.toThrow(
      /pipe/,
    );
  });
});

// --- init's bounded inference read (inferDateInputFormatFromSource) -----------

// A column set where date_of_birth joins a satisfiable default linkage key (a
// name + DOB combination), so the inferred terms include a date_of_birth field
// and its parse_date pipeline -- the path whose date format the bounded sample
// must reproduce. The dob column is a fixed YYYY-MM-DD date.
const INFER_COLUMNS = ["first_name", "last_name", "dob", "member_id"];

/** Build a CSV with `rows` data rows over {@link INFER_COLUMNS}. */
function csvWithRows(rows: number): string {
  const body = Array.from(
    { length: rows },
    (_v, i) =>
      `First${i},Last${i},1990-01-${String((i % 28) + 1).padStart(2, "0")},${i}`,
  ).join("\n");
  return `${INFER_COLUMNS.join(",")}\n${body}\n`;
}

/** The parse_date input format a standardization inferred for the dob column. */
function dobInputFormat(dataSpec: ReturnType<typeof buildDataSpec>): unknown {
  const step = (dataSpec.standardization ?? [])
    .flatMap((s) => s.steps ?? [])
    .find((s) => s.function === "parse_date");
  return (step?.params as { inputFormat?: unknown } | undefined)?.inputFormat;
}

/** Reproduce init's inference: read only the header + a bounded DOB sample via
 * the shared core helper, then author the data spec from the header with the
 * pre-inferred format -- exactly what `buildTemplateData` does. */
async function inferInitDataSpec(
  input: string,
  opts: { allowStdin?: boolean } = {},
) {
  const inferred = await inferDateInputFormatFromSource(
    openInputSource(input, opts),
  );
  const dataSpec = buildDataSpec({
    identity: "Org",
    rows: { rawRows: [], columns: inferred.columns },
    ...(inferred.dateInputFormat !== undefined
      ? { dateInputFormat: inferred.dateInputFormat }
      : {}),
  });
  return { inferred, dataSpec };
}

test("inferDateInputFormatFromSource: the init path infers the same metadata, fields, standardization, and dob format as a full read", async () => {
  // The divergence guard the issue makes critical: init's lighter read must
  // author terms byte-identical to what invite/accept derive from a full read of
  // the same file. Pin all four inferred outputs by comparing the two dataSpecs.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-infer-"));
  try {
    const file = path.join(dir, "in.csv");
    fs.writeFileSync(file, csvWithRows(40));
    const full = buildDataSpec({
      identity: "Org",
      rows: await loadInputRows(file),
    });
    const { dataSpec: light } = await inferInitDataSpec(file);
    expect(light.metadata).toEqual(full.metadata);
    expect(light.linkageTerms).toEqual(full.linkageTerms);
    expect(light.standardization).toEqual(full.standardization);
    expect(dobInputFormat(light)).toBe("YYYY-MM-DD");
    expect(dobInputFormat(light)).toBe(dobInputFormat(full));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("inferDateInputFormatFromSource: reads a bounded DOB sample, so a file far larger than the scan cap still yields the header and format", async () => {
  // A file with more dob rows than the inference cap: the full read returns every
  // row, while the helper reads only the header plus a sample bounded at
  // INFER_DATE_SCAN_CAP, so init's memory does not scale with the file yet the
  // inferred format is unchanged.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bounded-"));
  try {
    const file = path.join(dir, "in.csv");
    const rowCount = INFER_DATE_SCAN_CAP + 500;
    fs.writeFileSync(file, csvWithRows(rowCount));
    const full = await loadInputRows(file);
    expect(full.rawRows).toHaveLength(rowCount);

    const { inferred } = await inferInitDataSpec(file);
    expect(inferred.columns).toEqual(INFER_COLUMNS);
    expect(inferred.dobColumn).toBe("dob");
    expect(inferred.dateInputFormat).toBe("YYYY-MM-DD");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("inferDateInputFormatFromSource: a file with no dob column yields no format and infers the same terms as a full read", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-nodob-"));
  try {
    const file = path.join(dir, "in.csv");
    fs.writeFileSync(file, "first_name,last_name,member_id\nAlice,Smith,1\n");
    const { inferred, dataSpec: light } = await inferInitDataSpec(file);
    expect(inferred.columns).toEqual(["first_name", "last_name", "member_id"]);
    // No DOB column to sample, so no format is inferred.
    expect(inferred.dobColumn).toBeUndefined();
    expect(inferred.dateInputFormat).toBeUndefined();
    // Inference over it still matches a full read (no date format to infer).
    const full = buildDataSpec({
      identity: "Org",
      rows: await loadInputRows(file),
    });
    expect(light).toEqual(full);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("inferDateInputFormatFromSource: a header larger than the read buffer is read whole, matching the full read", async () => {
  // A header longer than fs.createReadStream's 64 KiB read buffer spans multiple
  // stream reads, so the bounded read must not commit to the first (empty-field)
  // chunk -- otherwise init reads an empty header and silently infers nothing
  // while the full read infers correctly. Compare the header both paths recover.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bighdr-"));
  try {
    const cols = Array.from({ length: 8000 }, (_v, i) =>
      i === 4000 ? "dob" : `column_${i}`,
    );
    expect(Buffer.byteLength(cols.join(","))).toBeGreaterThan(64 * 1024);
    const row = cols.map((c) => (c === "dob" ? "1990-01-02" : "x")).join(",");
    const file = path.join(dir, "in.csv");
    fs.writeFileSync(file, `${cols.join(",")}\n${row}\n`);

    const full = await loadInputRows(file);
    const { inferred } = await inferInitDataSpec(file);
    expect(inferred.columns).toEqual(full.columns);
    expect(inferred.columns).toHaveLength(8000);
    // The DOB sample was still taken from the (now correctly read) header.
    expect(inferred.dobColumn).toBe("dob");
    expect(inferred.dateInputFormat).toBe("YYYY-MM-DD");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("inferDateInputFormatFromSource: a `-` CSV from stdin infers the same as the file", async () => {
  // init reads its input with allowStdin enabled; the bounded read must work over
  // a non-rewindable stdin stream in a single pass, matching the file path.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-infer-stdin-"));
  try {
    const file = path.join(dir, "in.csv");
    fs.writeFileSync(file, csvWithRows(10));
    const fromFile = await inferDateInputFormatFromSource(
      openInputSource(file, { allowStdin: true }),
    );
    const fromStdin = await withStdin(streamOf(csvWithRows(10)), () =>
      inferDateInputFormatFromSource(
        openInputSource("-", { allowStdin: true }),
      ),
    );
    expect(fromStdin).toEqual(fromFile);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("inferDateInputFormatFromSource: a no-newline input fails fast rather than buffering the span", async () => {
  // init's bounded read applies the byte ceiling end to end: a pathological local
  // CSV with no row terminator (one giant line) aborts with an operator-readable
  // error instead of consuming memory proportional to the span. Exercised over
  // stdin to match init's allowStdin path, with a span just over the default
  // ceiling so init -- which passes no explicit ceiling -- still trips it.
  const giant = "x".repeat(CSV_LINE_BYTE_CEILING + 1024);
  await withStdin(streamOf(giant), async () => {
    await expect(
      inferDateInputFormatFromSource(
        openInputSource("-", { allowStdin: true }),
      ),
    ).rejects.toThrow(/single-line limit/);
  });
});

// --- linkage strategy selection ----------------------------------------------

test("parseLinkageStrategyFlag: absent selection is undefined (terms keep the cascade default)", () => {
  expect(
    parseLinkageStrategyFlag({ _: [], $0: "psilink" } as unknown as Arguments),
  ).toBeUndefined();
});

test("parseLinkageStrategyFlag: each valid value parses to itself", () => {
  for (const value of ["cascade", "single-pass"] as const)
    expect(
      parseLinkageStrategyFlag({
        _: [],
        $0: "psilink",
        "linkage-strategy": value,
      } as unknown as Arguments),
    ).toBe(value);
});

test("parseLinkageStrategyFlag: an unknown value is a usage error (exit 64 via runOrExit)", () => {
  // Routed through runOrExit by the invite handler, so a UsageError exits 64 on
  // the consistent error path, like the other bad enum flags (--log-level).
  const parse = () =>
    parseLinkageStrategyFlag({
      _: [],
      $0: "psilink",
      "linkage-strategy": "complete",
    } as unknown as Arguments);
  expect(parse).toThrow(UsageError);
  expect(parse).toThrow("unrecognized linkage-strategy: complete");
  expect(parse).toThrow("cascade or single-pass");
});

test("parseLinkageStrategyFlag: a repeated flag is rejected before the enum check", () => {
  // yargs collects a repeated --linkage-strategy into an array; singleValue
  // rejects it with a flag-named usage error rather than letting the array reach
  // the enum parse.
  expect(() =>
    parseLinkageStrategyFlag({
      _: [],
      $0: "psilink",
      "linkage-strategy": ["cascade", "single-pass"],
    } as unknown as Arguments),
  ).toThrow("--linkage-strategy may be given only once");
});

// A one-row input whose columns infer to default linkage fields, so buildDataSpec
// authors a full default terms set to apply the strategy onto.
const STRATEGY_ROWS = {
  rawRows: [
    {
      first_name: "Alice",
      last_name: "Smith",
      dob: "1990-01-02",
      ssn: "123456789",
    },
  ],
  columns: ["first_name", "last_name", "dob", "ssn"],
};

test("buildDataSpec: --linkage-strategy single-pass authors single-pass terms", () => {
  const dataSpec = buildDataSpec({
    identity: "tester",
    rows: STRATEGY_ROWS,
    linkageStrategy: "single-pass",
  });
  expect(dataSpec.linkageTerms.linkageStrategy).toBe("single-pass");
});

test("buildDataSpec: omitting the selection authors cascade (unchanged from today)", () => {
  const dataSpec = buildDataSpec({
    identity: "tester",
    rows: STRATEGY_ROWS,
  });
  expect(dataSpec.linkageTerms.linkageStrategy).toBe("cascade");
});

test("buildDataSpec: a supplied terms object (accept's path) ignores the selection", () => {
  // accept derives its terms from the invitation, which already has the
  // agreed strategy; the selection must not override the partner's choice.
  const terms = {
    ...getDefaultLinkageTerms("inviter"),
    linkageStrategy: "single-pass" as const,
  };
  const dataSpec = buildDataSpec({
    terms,
    identity: "acceptor",
    rows: STRATEGY_ROWS,
    linkageStrategy: "cascade",
  });
  expect(dataSpec.linkageTerms.linkageStrategy).toBe("single-pass");
});

test("singlePassDisclosureNotice: names the disclosure tradeoff and the operator-facing doc", () => {
  const note = singlePassDisclosureNotice();
  // The same plain words the web acceptance surface states the disclosure in.
  expect(note).toContain(
    "sends the other everything it prepared for every linkage key at once",
  );
  expect(note).toContain("how much your partner can observe while it runs");
  expect(note).toContain("consented disclosure tradeoff");
  // Links the operator-facing reference, not the internal design note.
  expect(note).toContain("docs/EXCHANGE_REFERENCE.md");
  expect(note).not.toContain("one-sided-disclosure");
});
