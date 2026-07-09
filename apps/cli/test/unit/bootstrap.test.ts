import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test, vi } from "vitest";
import type { Arguments } from "yargs";
import YAML from "yaml";
import {
  CSV_LINE_BYTE_CEILING,
  getDefaultLinkageTerms,
  getLogger,
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
} from "@psilink/core";

import {
  applyEndpointSplitDirectories,
  buildDataSpec,
  connectionFromEndpoint,
  connectionFromURL,
  connectionOverridesFrom,
  diffConnectionAgainstTarget,
  endpointFromConnection,
  generateSharedSecret,
  loadInputRows,
  loadInputRowsForInference,
  logOnlineBootstrapOutcome,
  looksLikeUrl,
  observedReceivedColumnsForSave,
  parseCommonBootstrapArgs,
  parseLinkageStrategyFlag,
  runOnlineBootstrap,
  runOrExit,
  singlePassDisclosureNotice,
  warnLowPollingFrequency,
  warnOptionsOverridesIgnoredOffline,
  warnServerOverridesIgnoredOffline,
  warnUnsupportedFileSyncFlags,
  type RunnableConnectionConfig,
} from "../../src/commands/bootstrap";
import { redactUrlCredentials } from "../../src/util/connectionUrl";
import { MAX_TIMEOUT_SECONDS } from "../../src/util/cli";
import { runProtocol } from "../../src/protocol";
import { streamOf, ttyStream, withStdin } from "../stdinStream";

// runOnlineBootstrap's config-persistence tests below drive its wiring without
// opening a connection: runProtocol is mocked so each test chooses whether the
// handshake "succeeds" (the mock invokes onAuthenticated) before it resolves or
// rejects. saveConfig is left real, so the assertions check the actual file.
vi.mock("../../src/protocol", () => ({
  runProtocol: vi.fn(),
}));

// runOrExit creates its error logger by name; silence that name so the
// error-path tests below don't print to the console.
getLogger("bootstrap-test").setLevel("silent");

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
  expect(() => connectionFromURL(new URL("ws://host/path"), {})).toThrow(
    UsageError,
  );
  expect(() => connectionFromURL(new URL("ws://host/path"), {})).toThrow(
    "not yet supported",
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
  // WHATWG parser's double-dot collapsing (which only fires on literal "/") and
  // decode to a literal "..". The builder decodes faithfully and does NOT
  // special-case traversal: the path reaches the live SFTP connection exactly as
  // a hand-authored psilink.yaml with the same path would, keeping the builder,
  // the on-disk config, and the connection in agreement. Any traversal defense
  // belongs at the connection layer so it covers every config source, not just
  // URLs -- deliberately out of scope here. This test pins that decision.
  const conn = connectionFromURL(new URL("sftp://host/%2e%2e%2fetc"), {});
  expect(conn.channel).toBe("sftp");
  if (conn.channel !== "sftp") return;
  expect(conn.server.path).toBe("/../etc");
});

test("connectionFromURL: a malformed percent-escape is a redacted usage error", () => {
  // A lone `%` makes decodeURIComponent throw a URIError; it must surface as a
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
  // a config the decoded builder saved earlier); the accept URL carries the same
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
  expect(conflicts[0].existing).toBe("/elsewhere");
  expect(conflicts[0].incoming).toBe("/out");
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
    conflicts.every((c) => c.existing.includes("single shared path /mnt/in")),
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
    "split inbound_path /mnt/in, outbound_path /mnt/out",
  );
  expect(conflicts[0].incoming).toBe("/mnt/shared");
});

// Each server-block override flag, paired with the option field that carries it,
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
// carries it, so the parametrized test below proves every one is named when set
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
  // a fresh placeholder already carries, so it is not an override that could have
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
  // avoids the raw TypeError that would otherwise surface as a confusing exit 69.
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
    // Assert the throw first, so a regression that fails to reject surfaces as a
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

test("runOrExit surfaces a sanitized cause chain in the CLI failure output", async () => {
  // A transport failure wraps the raw fs/ssh2 error as its cause, and the
  // partner-chosen path in that cause can carry control/ANSI/newline bytes. The
  // failure output must surface the cause (observability) with those bytes
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
  // The endpoint never carries credentials; the username is a fill-in marker.
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
  // The endpoint carries the INVITER's own pair; the acceptor reads where the
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
  // than letting an undefined path surface as an opaque downstream schema error.
  expect(() => connectionFromEndpoint({ channel: "filedrop" })).toThrow(
    /neither a path nor a split/,
  );
});

test("connectionFromEndpoint: the split swap is applied exactly once (no double-swap)", () => {
  // A double application would land the inviter's inbound back on the acceptor's
  // inbound. Asserting the acceptor's inbound is the inviter's OUTBOUND proves a
  // single swap; the offline invite path passes `undefined` to this same
  // function, so there is no second swap site.
  const endpoint: ConnectionEndpoint = {
    channel: "filedrop",
    inboundPath: "/inviter-in",
    outboundPath: "/inviter-out",
  };
  const { connection } = connectionFromEndpoint(endpoint);
  if (connection.channel !== "filedrop") throw new Error("expected filedrop");
  expect(connection.inboundPath).toBe(endpoint.outboundPath);
  expect(connection.inboundPath).not.toBe(endpoint.inboundPath);
});

// --- applyEndpointSplitDirectories (online accept merge) ---------------------

test("applyEndpointSplitDirectories: grafts a split sftp endpoint onto the URL connection, keeping host/credentials", () => {
  // The acceptor's URL carries the reachable host + credentials; the endpoint
  // carries the inviter's split pair. The merged connection reaches the host the
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
  // A --connection-timeout carried on the URL connection must survive the merge:
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
  // The inviter's connection carries credentials (username/password/private key);
  // the endpoint must carry only the public locator. This is the producer side of
  // the invitation's no-credentials invariant.
  const connection = connectionFromURL(new URL("sftp://host:2200/drop"), {
    server: {
      username: "alice",
      password: "hunter2",
      privateKey: "@/home/alice/.ssh/id_ed25519",
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
    // outbound directory; the endpoint carries the inviter's own pair unswapped,
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
  // inbound (item 202418344's dormant consumer, now exercised by the producer).
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
  const { dataSpec, warnings } = buildDataSpec({
    identity: "Agency A",
    rows: ROWS,
  });
  expect(warnings).toEqual([]);
  expect(dataSpec.linkageTerms.identity).toBe("Agency A");
  expect(dataSpec.linkageTerms.linkageKeys.length).toBeGreaterThan(0);
  expect(dataSpec.metadata).toBeDefined();
  expect(dataSpec.standardization).toBeDefined();
});

test("buildDataSpec: without input rows, the spec is just the supplied terms (accept)", () => {
  const { dataSpec } = buildDataSpec({
    identity: "Agency B",
    rows: ROWS,
  });
  // Reuse the inferred terms as a stand-in for an invitation's terms.
  const { dataSpec: termsOnly } = buildDataSpec({
    terms: dataSpec.linkageTerms,
    identity: "Agency B",
  });
  expect(termsOnly.linkageTerms).toEqual(dataSpec.linkageTerms);
  expect(termsOnly.metadata).toBeUndefined();
  expect(termsOnly.standardization).toBeUndefined();
});

test("buildDataSpec: supplied terms plus input infer metadata and standardization (accept)", () => {
  const { dataSpec: inferred } = buildDataSpec({
    identity: "Agency C",
    rows: ROWS,
  });
  const { dataSpec, warnings } = buildDataSpec({
    terms: inferred.linkageTerms,
    identity: "Agency C",
    rows: ROWS,
  });
  expect(warnings).toEqual([]);
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
  const { dataSpec } = buildDataSpec({ identity: "Agency A", rows: ROWS });
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

/** Locate the onAuthenticated hook among runProtocol's call arguments by type,
 *  not position. Asserting exactly one function argument makes the mock fail
 *  loudly if a second function-typed parameter is ever added to runProtocol (in
 *  any position) rather than silently selecting the wrong one.
 */
function soleFunctionArg(callArgs: unknown[]): () => void | Promise<void> {
  const fnArgs = callArgs.filter((a) => typeof a === "function");
  expect(fnArgs).toHaveLength(1);
  return fnArgs[0] as () => void | Promise<void>;
}

test("runOnlineBootstrap writes the config from the hook even when the exchange then fails", async () => {
  // Handshake succeeds (runProtocol invokes onAuthenticated -> saveConfig), then
  // the data exchange fails. The config must already be on disk so the
  // recurring-exchange setup is recoverable without re-inviting.
  vi.mocked(runProtocol).mockImplementation((async (...callArgs: unknown[]) => {
    const onAuthenticated = soleFunctionArg(callArgs);
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

// --- runOnlineBootstrap: observe-then-persist received-payload lock-in --------

/** Mock runProtocol as a successful exchange: invoke the onAuthenticated hook
 *  (so the config is written at acceptance) and resolve with the given observed
 *  received-payload columns. */
function mockSuccessfulExchange(observed: string[] | undefined): void {
  vi.mocked(runProtocol).mockImplementation((async (...callArgs: unknown[]) => {
    const onAuthenticated = callArgs.find((a) => typeof a === "function") as
      | (() => void | Promise<void>)
      | undefined;
    await onAuthenticated?.();
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

test("runOnlineBootstrap leaves an empty observation lazy even when the inviter opts in", async () => {
  // An observed-empty payload is an ambiguous zero-match run; persisting [] would
  // false-abort a later matching exchange, so no lock-in is written.
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
  // observed lock-in (203798031's in-memory-for-its-single-run design stands).
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
  vi.mocked(runProtocol).mockImplementation((async (...callArgs: unknown[]) => {
    const onAuthenticated = callArgs.find((a) => typeof a === "function") as
      | (() => void | Promise<void>)
      | undefined;
    await onAuthenticated?.(); // hook writes configPath as a file
    fs.rmSync(configPath); // swap it for a directory so the second
    fs.mkdirSync(configPath); // saveConfig's rename throws (EISDIR)
    return { observedReceivedPayloadColumns: ["dob", "zip"] };
  }) as never);
  try {
    const { configWriteError } = await runOnlineBootstrap({
      ...onlineBootstrapParams(configPath),
      persistObservedReceivedPayload: true,
    });
    expect(configWriteError).toBeUndefined();
    // The second write genuinely failed (the swapped-in directory is intact),
    // proving the non-fatal catch fired rather than the write silently succeeding.
    expect(fs.statSync(configPath).isDirectory()).toBe(true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- runOnlineBootstrap: up-front token received-payload lock-in (accept) -----

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
      expectedReceivedPayloadColumns: ["diagnosis", "notes"],
    });
    const written = YAML.parse(fs.readFileSync(configPath, "utf8"));
    expect(written.expected_payload_columns).toEqual(["diagnosis", "notes"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runOnlineBootstrap persists an empty token set as a strict receive-nothing lock-in", async () => {
  // Unlike the observe path (which drops an ambiguous empty observation), an empty
  // DISCLOSED subset carried by the token is a real "receive nothing" lock-in the
  // operator consented to: a later non-empty payload must abort, so the empty set is
  // written rather than left lazy.
  mockSuccessfulExchange(undefined);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bootstrap-"));
  const configPath = path.join(dir, "psilink.yaml");
  try {
    await runOnlineBootstrap({
      ...onlineBootstrapParams(configPath),
      expectedReceivedPayloadColumns: [],
    });
    const written = YAML.parse(fs.readFileSync(configPath, "utf8"));
    expect(written.expected_payload_columns).toEqual([]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runOnlineBootstrap omits the received lock-in when the acceptor passes no token set", async () => {
  // A subset-less invitation (an older or metadata-unknown mint) carries no disclosed
  // set, so the acceptor passes undefined and the fresh config records no lock-in --
  // the recurring exchange reconciles lazily, unchanged from before this task.
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

test("runOnlineBootstrap does not inject the token lock-in onto a reused pre-existing config", async () => {
  // With reuseExistingConfig the hook keeps the operator's config untouched, so even
  // with the acceptor's token set present no lock-in is written into their config --
  // the reconcile step already confirmed the pre-existing config agrees.
  mockSuccessfulExchange(undefined);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bootstrap-"));
  const configPath = path.join(dir, "psilink.yaml");
  fs.writeFileSync(configPath, "preexisting: true\n");
  try {
    await runOnlineBootstrap({
      ...onlineBootstrapParams(configPath),
      reuseExistingConfig: true,
      expectedReceivedPayloadColumns: ["diagnosis", "notes"],
    });
    // The operator's config is left exactly as it was.
    expect(fs.readFileSync(configPath, "utf8")).toBe("preexisting: true\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the persisted empty online-accept lock-in aborts a later non-empty payload", async () => {
  // The write-side test above proves an empty token set survives to disk as []; this
  // closes the loop at ENFORCEMENT time: a recurring exchange reloads that strict
  // "receive nothing" lock-in and reconcileReceivedPayload aborts if the partner
  // then transmits any column, while an empty received payload still passes.
  mockSuccessfulExchange(undefined);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bootstrap-"));
  const configPath = path.join(dir, "psilink.yaml");
  try {
    await runOnlineBootstrap({
      ...onlineBootstrapParams(configPath),
      expectedReceivedPayloadColumns: [],
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
    // Any transmitted column diverges from the strict empty lock-in and aborts.
    expect(() =>
      reconcileReceivedPayload(received(["diagnosis"]), lockIn),
    ).toThrow(/payload disclosure mismatch/);
    // An empty received payload matches the empty lock-in and passes.
    expect(() => reconcileReceivedPayload(received([]), lockIn)).not.toThrow();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runOnlineBootstrap rejects both received-payload persistence inputs at once", async () => {
  // The acceptor's up-front token set and the inviter's observe-on-save flag are
  // mutually exclusive; setting both is a caller error caught fail-fast, before any
  // connection, rather than silently letting the observe write clobber the token
  // lock-in. runProtocol must never be reached.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bootstrap-"));
  const configPath = path.join(dir, "psilink.yaml");
  // Call counts accumulate across this file's tests (no shared reset hook), so clear
  // before asserting the guard short-circuits before runProtocol.
  vi.mocked(runProtocol).mockClear();
  try {
    await expect(
      runOnlineBootstrap({
        ...onlineBootstrapParams(configPath),
        expectedReceivedPayloadColumns: ["diagnosis"],
        persistObservedReceivedPayload: true,
      }),
    ).rejects.toThrow(/mutually exclusive/);
    expect(vi.mocked(runProtocol)).not.toHaveBeenCalled();
    expect(fs.existsSync(configPath)).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the persisted online-accept lock-in drives fail-closed recurring enforcement", async () => {
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
      expectedReceivedPayloadColumns: ["diagnosis", "notes"],
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
  // The invite/accept persistence path: the connection carries an @path
  // server-password. saveConfig (in the hook) must write the @path, never the
  // secret, while runProtocol receives the resolved value to actually connect.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bootstrap-"));
  const pwFile = path.join(dir, "pw");
  fs.writeFileSync(pwFile, "s3cret\n");
  const configPath = path.join(dir, "psilink.yaml");

  let connectionPassedToRunProtocol: SFTPConnectionConfig | undefined;
  vi.mocked(runProtocol).mockImplementation((async (...callArgs: unknown[]) => {
    connectionPassedToRunProtocol = callArgs[0] as SFTPConnectionConfig;
    const onAuthenticated = callArgs.find((a) => typeof a === "function") as
      | (() => void | Promise<void>)
      | undefined;
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
        // exercises only the credential-resolution seam.
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
  // The encrypted-key end-to-end path: the connection carries an @path private
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
    connectionPassedToRunProtocol = callArgs[0] as SFTPConnectionConfig;
    const onAuthenticated = callArgs.find((a) => typeof a === "function") as
      | (() => void | Promise<void>)
      | undefined;
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
        // this test exercises only the credential-resolution seam.
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

// A recovery note must point the user at `psilink exchange` only when the config
// is actually on disk. These tests spy on the (silenced) named logger that
// runOnlineBootstrap resolves internally via getLogger(loggerName).
const RECOVERY_NOTE = "retry with 'psilink exchange'";

test("runOnlineBootstrap notes the config is on disk when the exchange fails after the config was written", async () => {
  // Hook writes the config (real saveConfig), then the exchange fails. The user
  // must be told the config + key are on disk so they retry with
  // `psilink exchange` rather than re-inviting.
  vi.mocked(runProtocol).mockImplementation((async (...callArgs: unknown[]) => {
    const onAuthenticated = soleFunctionArg(callArgs);
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
    const onAuthenticated = soleFunctionArg(callArgs);
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
  logOnlineBootstrapOutcome(log, {
    configFile: "psilink.yaml",
    keyFile: ".psilink.key",
    configWriteError: new Error("permission denied"),
  });
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
    const onAuthenticated = soleFunctionArg(callArgs);
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
    const onAuthenticated = soleFunctionArg(callArgs);
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

test("loadInputRows: empty stdin is handled like an empty file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-loadrows-empty-"));
  try {
    const empty = path.join(dir, "empty.csv");
    fs.writeFileSync(empty, "");
    const fromFile = await loadInputRows(empty, { allowStdin: true });
    const fromStdin = await withStdin(streamOf(""), () =>
      loadInputRows("-", { allowStdin: true }),
    );
    expect(fromStdin).toEqual(fromFile);
    expect(fromStdin.rawRows).toEqual([]);
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

// --- loadInputRowsForInference (init's bounded read) -------------------------

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
function dobInputFormat(
  dataSpec: ReturnType<typeof buildDataSpec>["dataSpec"],
): unknown {
  const step = (dataSpec.standardization ?? [])
    .flatMap((s) => s.steps ?? [])
    .find((s) => s.function === "parse_date");
  return (step?.params as { inputFormat?: unknown } | undefined)?.inputFormat;
}

test("loadInputRowsForInference: infers the same metadata, fields, standardization, and dob format as a full read", async () => {
  // The divergence guard the issue makes load-bearing: init's lighter read must
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
    const light = buildDataSpec({
      identity: "Org",
      rows: await loadInputRowsForInference(file),
    });
    expect(light.dataSpec.metadata).toEqual(full.dataSpec.metadata);
    expect(light.dataSpec.linkageTerms).toEqual(full.dataSpec.linkageTerms);
    expect(light.dataSpec.standardization).toEqual(
      full.dataSpec.standardization,
    );
    expect(dobInputFormat(light.dataSpec)).toBe("YYYY-MM-DD");
    expect(dobInputFormat(light.dataSpec)).toBe(dobInputFormat(full.dataSpec));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadInputRowsForInference: does not read the full row set -- the dob sample is bounded to the scan cap", async () => {
  // A file with more dob rows than the inference cap: the full read returns every
  // row, the inference read returns the header plus a sample capped at
  // INFER_DATE_SCAN_CAP, so init's memory does not scale with the file.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bounded-"));
  try {
    const file = path.join(dir, "in.csv");
    const rowCount = INFER_DATE_SCAN_CAP + 500;
    fs.writeFileSync(file, csvWithRows(rowCount));
    const full = await loadInputRows(file);
    expect(full.rawRows).toHaveLength(rowCount);

    const light = await loadInputRowsForInference(file);
    // The header is read whole...
    expect(light.columns).toEqual(INFER_COLUMNS);
    // ...but the rows handed to inference are capped at the scan limit, and hold
    // only the projected dob column rather than the full record.
    expect(light.rawRows).toHaveLength(INFER_DATE_SCAN_CAP);
    expect(Object.keys(light.rawRows[0])).toEqual(["dob"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadInputRowsForInference: a file with no dob column reads only the header", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-nodob-"));
  try {
    const file = path.join(dir, "in.csv");
    fs.writeFileSync(file, "first_name,last_name,member_id\nAlice,Smith,1\n");
    const { columns, rawRows } = await loadInputRowsForInference(file);
    expect(columns).toEqual(["first_name", "last_name", "member_id"]);
    // No DOB column to sample, so no row data is retained at all.
    expect(rawRows).toEqual([]);
    // Inference over it still matches a full read (no date format to infer).
    const full = buildDataSpec({
      identity: "Org",
      rows: await loadInputRows(file),
    });
    const light = buildDataSpec({
      identity: "Org",
      rows: { columns, rawRows },
    });
    expect(light.dataSpec).toEqual(full.dataSpec);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadInputRowsForInference: a header larger than the read buffer is read whole, matching the full read", async () => {
  // A header longer than fs.createReadStream's 64 KiB read buffer spans multiple
  // stream reads, so the bounded loader must not commit to the first (empty-field)
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
    const light = await loadInputRowsForInference(file);
    expect(light.columns).toEqual(full.columns);
    expect(light.columns).toHaveLength(8000);
    // The DOB sample was still taken from the (now correctly read) header.
    expect(light.rawRows).toEqual([{ dob: "1990-01-02" }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadInputRowsForInference: a `-` CSV from stdin infers the same terms as the file", async () => {
  // init reads its input with allowStdin enabled; the bounded read must work over
  // a non-rewindable stdin stream in a single pass, matching the file path.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-infer-stdin-"));
  try {
    const file = path.join(dir, "in.csv");
    fs.writeFileSync(file, csvWithRows(10));
    const fromFile = await loadInputRowsForInference(file, {
      allowStdin: true,
    });
    const fromStdin = await withStdin(streamOf(csvWithRows(10)), () =>
      loadInputRowsForInference("-", { allowStdin: true }),
    );
    expect(fromStdin).toEqual(fromFile);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadInputRowsForInference: a no-newline input fails fast rather than buffering the span", async () => {
  // init's bounded read carries the byte ceiling end to end: a pathological local
  // CSV with no row terminator (one giant line) aborts with an operator-readable
  // error instead of consuming memory proportional to the span. Exercised over
  // stdin to match init's allowStdin path, with a span just over the default
  // ceiling so init -- which passes no explicit ceiling -- still trips it.
  const giant = "x".repeat(CSV_LINE_BYTE_CEILING + 1024);
  await withStdin(streamOf(giant), async () => {
    await expect(
      loadInputRowsForInference("-", { allowStdin: true }),
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
  const { dataSpec } = buildDataSpec({
    identity: "tester",
    rows: STRATEGY_ROWS,
    linkageStrategy: "single-pass",
  });
  expect(dataSpec.linkageTerms.linkageStrategy).toBe("single-pass");
});

test("buildDataSpec: omitting the selection authors cascade (unchanged from today)", () => {
  const { dataSpec } = buildDataSpec({
    identity: "tester",
    rows: STRATEGY_ROWS,
  });
  expect(dataSpec.linkageTerms.linkageStrategy).toBe("cascade");
});

test("buildDataSpec: a supplied terms object (accept's path) ignores the selection", () => {
  // accept derives its terms from the invitation, which already carries the
  // agreed strategy; the selection must not override the partner's choice.
  const terms = {
    ...getDefaultLinkageTerms("inviter"),
    linkageStrategy: "single-pass" as const,
  };
  const { dataSpec } = buildDataSpec({
    terms,
    identity: "acceptor",
    rows: STRATEGY_ROWS,
    linkageStrategy: "cascade",
  });
  expect(dataSpec.linkageTerms.linkageStrategy).toBe("single-pass");
});

test("singlePassDisclosureNotice: names the disclosure tradeoff and the operator-facing doc", () => {
  const note = singlePassDisclosureNotice();
  expect(note).toContain("discloses");
  expect(note).toContain("consented disclosure tradeoff");
  // Links the operator-facing reference, not the internal design note.
  expect(note).toContain("docs/EXCHANGE_REFERENCE.md");
  expect(note).not.toContain("one-sided-disclosure");
});
