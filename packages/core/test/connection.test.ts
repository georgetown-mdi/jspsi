import { ZodError } from "zod";
import { expect, test } from "vitest";

import {
  parseConnectionConfig,
  safeParseConnectionConfig,
} from "../src/config/connection";

// Minimal valid configs used as bases for individual tests.
const webrtcBase = {
  channel: "webrtc",
  server: { host: "api.peerjs.com" },
};

const sftpBase = {
  channel: "sftp",
  server: { host: "sftp.example.org" },
};

// --- Happy path --------------------------------------------------------------

test("parses a minimal WebRTC connection", () => {
  const result = parseConnectionConfig(webrtcBase);
  expect(result.channel).toBe("webrtc");
  if (result.channel !== "webrtc") return;
  expect(result.server.host).toBe("api.peerjs.com");
});

test("parses a minimal file-drop connection", () => {
  const result = parseConnectionConfig({
    channel: "filedrop",
    path: "/mnt/share/drop",
  });
  expect(result.channel).toBe("filedrop");
  if (result.channel !== "filedrop") return;
  expect(result.path).toBe("/mnt/share/drop");
});

test("file-drop connection with empty path is rejected", () => {
  const result = safeParseConnectionConfig({ channel: "filedrop", path: "" });
  expect(result.success).toBe(false);
});

test("file-drop connection with relative path is rejected", () => {
  const result = safeParseConnectionConfig({
    channel: "filedrop",
    path: "relative/path",
  });
  expect(result.success).toBe(false);
});

test("file-drop connection with Windows drive path is accepted", () => {
  const result = parseConnectionConfig({
    channel: "filedrop",
    path: "C:/Users/shared/drop",
  });
  expect(result.channel).toBe("filedrop");
  if (result.channel !== "filedrop") return;
  expect(result.path).toBe("C:/Users/shared/drop");
});

test("file-drop connection with Windows backslash drive path is accepted", () => {
  const result = parseConnectionConfig({
    channel: "filedrop",
    path: "C:\\Users\\shared\\drop",
  });
  expect(result.channel).toBe("filedrop");
});

test("file-drop connection with Windows UNC path is accepted", () => {
  const result = parseConnectionConfig({
    channel: "filedrop",
    path: "\\\\server\\share\\drop",
  });
  expect(result.channel).toBe("filedrop");
});

test("parses a minimal SFTP connection", () => {
  const result = parseConnectionConfig(sftpBase);
  expect(result.channel).toBe("sftp");
  if (result.channel !== "sftp") return;
  expect(result.server.host).toBe("sftp.example.org");
});

test("parses a full WebRTC connection with stun, turn, and role", () => {
  const result = parseConnectionConfig({
    channel: "webrtc",
    server: { host: "peerjs.example.org", port: 443, key: "mykey" },
    role: "inviter",
    stun: ["stun:stun.example.org:3478", "stuns:stun2.example.org:5349"],
    turn: [
      {
        url: "turns:turn.example.org:443",
        username: "alice",
        credential: "secret",
        credentialType: "hmac-sha1",
      },
    ],
    options: { peerTimeoutMs: 120000, serverConnectTimeoutMs: 10000 },
  });
  expect(result.channel).toBe("webrtc");
  if (result.channel !== "webrtc") return;
  expect(result.stun).toHaveLength(2);
  expect(result.turn).toHaveLength(1);
  expect(result.role).toBe("inviter");
});

test("parses a full SFTP connection with private key auth", () => {
  const result = parseConnectionConfig({
    channel: "sftp",
    server: {
      host: "sftp.example.org",
      port: 22,
      path: "/exchanges/",
      username: "psilink",
      privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----",
      privateKeyPassphrase: "hunter2",
      hostKeyFingerprint: "SHA256:abc",
    },
    options: { pollIntervalMs: 5000 },
  });
  expect(result.channel).toBe("sftp");
  if (result.channel !== "sftp") return;
  expect(result.server.privateKey).toBeDefined();
  expect(result.server.privateKeyPassphrase).toBeDefined();
});

test("parses shared options including maxReconnectAttempts on an SFTP config", () => {
  const result = safeParseConnectionConfig({
    ...sftpBase,
    options: {
      peerTimeoutMs: 7200000,
      serverConnectTimeoutMs: 15000,
      maxReconnectAttempts: 5,
    },
  });
  expect(result.success).toBe(true);
  if (!result.success) return;
  expect(result.data.options?.peerTimeoutMs).toBe(7200000);
  expect(result.data.options?.serverConnectTimeoutMs).toBe(15000);
  expect(result.data.options?.maxReconnectAttempts).toBe(5);
});

// --- provider_options (opaque, verbatim) -------------------------------------

test("provider_options keys pass through verbatim (snake_case preserved)", () => {
  const result = parseConnectionConfig({
    ...sftpBase,
    // An opaque map is forwarded verbatim to the transport library, which
    // defines its own key names; its keys must NOT be camelized.
    provider_options: { ready_timeout: 5000, debug_mode: true },
    // A sibling schema field in the same parse is still normalized.
    options: { peer_timeout_ms: 120000 },
  });
  expect(result.channel).toBe("sftp");
  if (result.channel !== "sftp") return;
  expect(result.providerOptions).toEqual({
    ready_timeout: 5000,
    debug_mode: true,
  });
  // The known schema field was camelized as usual.
  expect(result.options?.peerTimeoutMs).toBe(120000);
});

test("provider_options preserves a literal camelCase key unchanged", () => {
  const result = parseConnectionConfig({
    ...sftpBase,
    // ssh2's option keys are camelCase; a user writing them literally must have
    // them survive byte-for-byte rather than being normalized to snake_case.
    provider_options: { readyTimeout: 5000, algorithms: { kex: ["a"] } },
  });
  expect(result.channel).toBe("sftp");
  if (result.channel !== "sftp") return;
  expect(result.providerOptions).toEqual({
    readyTimeout: 5000,
    algorithms: { kex: ["a"] },
  });
});

test("provider_options is opaque all the way down (nested keys not camelized)", () => {
  const result = parseConnectionConfig({
    ...sftpBase,
    provider_options: { nested_outer: { nested_inner: 1 } },
  });
  expect(result.channel).toBe("sftp");
  if (result.channel !== "sftp") return;
  expect(result.providerOptions).toEqual({ nested_outer: { nested_inner: 1 } });
});

test("provider_options is opaque on the webrtc channel too", () => {
  // The opaque skip is channel-agnostic (a key-name match in camelizeKeys), and
  // WebRTCConnectionConfig also declares providerOptions. Guard the webrtc path
  // so a future schema change cannot silently start normalizing its keys.
  const result = parseConnectionConfig({
    ...webrtcBase,
    provider_options: { readyTimeout: 5000, nested_outer: { nested_inner: 1 } },
  });
  expect(result.channel).toBe("webrtc");
  if (result.channel !== "webrtc") return;
  expect(result.providerOptions).toEqual({
    readyTimeout: 5000,
    nested_outer: { nested_inner: 1 },
  });
});

// --- Discriminated union -----------------------------------------------------

test("unknown channel is rejected", () => {
  const result = safeParseConnectionConfig({
    channel: "smoke-signal",
    server: { host: "x" },
  });
  expect(result.success).toBe(false);
});

// --- parse vs safeParse ------------------------------------------------------

test("parseConnectionConfig throws ZodError on invalid input", () => {
  expect(() => parseConnectionConfig({ channel: "webrtc" })).toThrow(ZodError);
});

test("safeParseConnectionConfig returns success: false on invalid input", () => {
  const result = safeParseConnectionConfig({ channel: "sftp" });
  expect(result.success).toBe(false);
});

// --- HttpAuth: username / password must appear together ----------------------

test("HttpAuth with username but no password is rejected", () => {
  const result = safeParseConnectionConfig({
    ...sftpBase,
    proxy: { host: "proxy.example.org", auth: { username: "user" } },
  });
  expect(result.success).toBe(false);
  if (result.success) return;
  const messages = result.error.issues.map((i) => i.message);
  expect(messages.some((m) => m.includes("username and password"))).toBe(true);
});

test("HttpAuth with password but no username is rejected", () => {
  const result = safeParseConnectionConfig({
    ...sftpBase,
    proxy: { host: "proxy.example.org", auth: { password: "secret" } },
  });
  expect(result.success).toBe(false);
  if (result.success) return;
  const messages = result.error.issues.map((i) => i.message);
  expect(messages.some((m) => m.includes("username and password"))).toBe(true);
});

// --- HttpAuth: at most one authentication method -----------------------------

test("HttpAuth with bearer token is valid", () => {
  const result = safeParseConnectionConfig({
    ...webrtcBase,
    server: {
      host: "api.peerjs.com",
      provision: { host: "api.example.org", auth: { bearer: "tok" } },
    },
  });
  expect(result.success).toBe(true);
});

test("HttpAuth with username and password is valid", () => {
  const result = safeParseConnectionConfig({
    ...webrtcBase,
    iceProvision: {
      host: "nts.twilio.com",
      auth: { username: "sid", password: "key" },
    },
  });
  expect(result.success).toBe(true);
});

test("HttpAuth with bearer and username together is rejected", () => {
  const result = safeParseConnectionConfig({
    ...webrtcBase,
    iceProvision: {
      host: "nts.twilio.com",
      auth: { bearer: "tok", username: "sid", password: "key" },
    },
  });
  expect(result.success).toBe(false);
  if (result.success) return;
  const messages = result.error.issues.map((i) => i.message);
  expect(messages.some((m) => m.includes("at most one"))).toBe(true);
});

// --- SFTPServer: at most one primary auth method -----------------------------

test("SFTP server with password and privateKey together is rejected", () => {
  const result = safeParseConnectionConfig({
    channel: "sftp",
    server: {
      host: "sftp.example.org",
      password: "hunter2",
      privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----",
    },
  });
  expect(result.success).toBe(false);
  if (result.success) return;
  const messages = result.error.issues.map((i) => i.message);
  expect(messages.some((m) => m.includes("at most one"))).toBe(true);
});

// --- SFTPServer: companion fields require privateKey -------------------------

test("SFTP server with privateKeyPassphrase but no privateKey is rejected", () => {
  const result = safeParseConnectionConfig({
    channel: "sftp",
    server: {
      host: "sftp.example.org",
      privateKeyPassphrase: "hunter2",
    },
  });
  expect(result.success).toBe(false);
  if (result.success) return;
  const messages = result.error.issues.map((i) => i.message);
  expect(messages.some((m) => m.includes("privateKeyPassphrase"))).toBe(true);
});

test("SFTP server with certificate but no privateKey is rejected", () => {
  const result = safeParseConnectionConfig({
    channel: "sftp",
    server: {
      host: "sftp.example.org",
      certificate: "/run/secrets/id_cert",
    },
  });
  expect(result.success).toBe(false);
  if (result.success) return;
  const messages = result.error.issues.map((i) => i.message);
  expect(messages.some((m) => m.includes("certificate"))).toBe(true);
});

test("SFTP server with certificate and privateKey together is valid", () => {
  const result = safeParseConnectionConfig({
    channel: "sftp",
    server: {
      host: "sftp.example.org",
      privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----",
      certificate: "/run/secrets/id_cert",
    },
  });
  expect(result.success).toBe(true);
});

test("SFTP server with privateKeyPassphrase and privateKey together is valid", () => {
  const result = safeParseConnectionConfig({
    channel: "sftp",
    server: {
      host: "sftp.example.org",
      privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----",
      privateKeyPassphrase: "hunter2",
    },
  });
  expect(result.success).toBe(true);
});

// --- WebRTC: iceProvision mutually exclusive with stun / turn -----------------

test("iceProvision alone is valid", () => {
  const result = safeParseConnectionConfig({
    ...webrtcBase,
    iceProvision: { host: "nts.twilio.com" },
  });
  expect(result.success).toBe(true);
});

test("stun and turn without iceProvision is valid", () => {
  const result = safeParseConnectionConfig({
    ...webrtcBase,
    stun: ["stun:stun.example.org"],
    turn: [{ url: "turn:turn.example.org", username: "u", credential: "c" }],
  });
  expect(result.success).toBe(true);
});

test("iceProvision with stun is rejected", () => {
  const result = safeParseConnectionConfig({
    ...webrtcBase,
    stun: ["stun:stun.example.org"],
    iceProvision: { host: "nts.twilio.com" },
  });
  expect(result.success).toBe(false);
  if (result.success) return;
  const messages = result.error.issues.map((i) => i.message);
  expect(messages.some((m) => m.includes("iceProvision"))).toBe(true);
});

test("iceProvision with turn is rejected", () => {
  const result = safeParseConnectionConfig({
    ...webrtcBase,
    turn: [{ url: "turn:turn.example.org", username: "u", credential: "c" }],
    iceProvision: { host: "nts.twilio.com" },
  });
  expect(result.success).toBe(false);
  if (result.success) return;
  const messages = result.error.issues.map((i) => i.message);
  expect(messages.some((m) => m.includes("iceProvision"))).toBe(true);
});

// --- STUN URI format ---------------------------------------------------------

test.each([
  ["stun:stun.example.org:3478", true],
  ["stuns:stun.example.org:5349", true],
  ["https://stun.example.org", false],
  ["turn:stun.example.org", false],
  ["", false],
])('STUN URI "%s" is %s', (uri, valid) => {
  const result = safeParseConnectionConfig({ ...webrtcBase, stun: [uri] });
  expect(result.success).toBe(valid);
});

// --- TURN URL format ---------------------------------------------------------

test.each([
  ["turn:turn.example.org:3478", true],
  ["turns:turn.example.org:443", true],
  ["https://turn.example.org", false],
  ["stun:turn.example.org", false],
])('TURN URL "%s" is %s', (url, valid) => {
  const result = safeParseConnectionConfig({
    ...webrtcBase,
    turn: [{ url, username: "u", credential: "c" }],
  });
  expect(result.success).toBe(valid);
});

// --- camelizeKeys integration ------------------------------------------------

test("parses snake_case keys from disk", () => {
  const result = parseConnectionConfig({
    channel: "webrtc",
    server: { host: "peerjs.example.org" },
    role: "acceptor",
    ice_provision: {
      host: "nts.twilio.com",
      auth: { username: "sid", password: "key" },
    },
  });
  expect(result.channel).toBe("webrtc");
  if (result.channel !== "webrtc") return;
  expect(result.role).toBe("acceptor");
  expect(result.iceProvision?.host).toBe("nts.twilio.com");
});

test("parses snake_case SFTP server keys from disk", () => {
  const result = parseConnectionConfig({
    channel: "sftp",
    server: {
      host: "sftp.example.org",
      private_key: "-----BEGIN OPENSSH PRIVATE KEY-----",
      private_key_passphrase: "hunter2",
      host_key_fingerprint: "SHA256:abc",
      known_hosts: "/etc/ssh/known_hosts",
    },
  });
  if (result.channel !== "sftp") return;
  expect(result.server.privateKey).toBeDefined();
  expect(result.server.privateKeyPassphrase).toBeDefined();
  expect(result.server.hostKeyFingerprint).toBe("SHA256:abc");
  expect(result.server.knownHosts).toBe("/etc/ssh/known_hosts");
});

// --- FileSyncOptions: peerId refines -----------------------------------------

test("peerId is accepted on sftp when timestampInFilename is true", () => {
  const result = safeParseConnectionConfig({
    ...sftpBase,
    options: { timestampInFilename: true, peerId: "agency-a" },
  });
  expect(result.success).toBe(true);
  if (!result.success) return;
  if (result.data.channel !== "sftp") return;
  expect(result.data.options?.peerId).toBe("agency-a");
});

test("peerId is accepted on filedrop when timestampInFilename is true", () => {
  const result = safeParseConnectionConfig({
    channel: "filedrop",
    path: "/mnt/share",
    options: { timestampInFilename: true, peerId: "agency-a" },
  });
  expect(result.success).toBe(true);
});

test("peerId with hyphens is accepted", () => {
  const result = safeParseConnectionConfig({
    ...sftpBase,
    options: { timestampInFilename: true, peerId: "agency-a-outbound" },
  });
  expect(result.success).toBe(true);
});

test("empty string peerId is rejected", () => {
  const result = safeParseConnectionConfig({
    ...sftpBase,
    options: { timestampInFilename: true, peerId: "" },
  });
  expect(result.success).toBe(false);
});

test("peerId is rejected without timestampInFilename", () => {
  const result = safeParseConnectionConfig({
    ...sftpBase,
    options: { peerId: "agency-a" },
  });
  expect(result.success).toBe(false);
  if (result.success) return;
  const messages = result.error.issues.map((i) => i.message);
  expect(messages.some((m) => m.includes("timestamp_in_filename"))).toBe(true);
});

test("peerId is rejected when timestampInFilename is false", () => {
  const result = safeParseConnectionConfig({
    ...sftpBase,
    options: { peerId: "agency-a", timestampInFilename: false },
  });
  expect(result.success).toBe(false);
});

test("peerId 'temp' is rejected", () => {
  const result = safeParseConnectionConfig({
    ...sftpBase,
    options: { timestampInFilename: true, peerId: "temp" },
  });
  expect(result.success).toBe(false);
  if (result.success) return;
  const messages = result.error.issues.map((i) => i.message);
  expect(messages.some((m) => m.includes("reserved"))).toBe(true);
});

test("retainFiles is accepted on sftp when timestampInFilename and locklessRendezvous are true", () => {
  const result = safeParseConnectionConfig({
    ...sftpBase,
    options: {
      timestampInFilename: true,
      locklessRendezvous: true,
      retainFiles: true,
    },
  });
  expect(result.success).toBe(true);
});

test("retainFiles is rejected without timestampInFilename", () => {
  const result = safeParseConnectionConfig({
    ...sftpBase,
    options: { retainFiles: true },
  });
  expect(result.success).toBe(false);
  if (result.success) return;
  const messages = result.error.issues.map((i) => i.message);
  expect(messages.some((m) => m.includes("timestamp_in_filename"))).toBe(true);
});

test("retainFiles is rejected when timestampInFilename is false", () => {
  const result = safeParseConnectionConfig({
    ...sftpBase,
    options: { retainFiles: true, timestampInFilename: false },
  });
  expect(result.success).toBe(false);
});

test("retainFiles is rejected without locklessRendezvous", () => {
  const result = safeParseConnectionConfig({
    ...sftpBase,
    options: { retainFiles: true, timestampInFilename: true },
  });
  expect(result.success).toBe(false);
  if (result.success) return;
  const messages = result.error.issues.map((i) => i.message);
  expect(messages.some((m) => m.includes("lockless_rendezvous"))).toBe(true);
});

test("retainFiles is rejected when locklessRendezvous is false", () => {
  const result = safeParseConnectionConfig({
    ...sftpBase,
    options: {
      retainFiles: true,
      timestampInFilename: true,
      locklessRendezvous: false,
    },
  });
  expect(result.success).toBe(false);
  if (result.success) return;
  const messages = result.error.issues.map((i) => i.message);
  expect(messages.some((m) => m.includes("lockless_rendezvous"))).toBe(true);
});

test("parses snake_case peer_id from disk", () => {
  const result = parseConnectionConfig({
    ...sftpBase,
    options: { timestamp_in_filename: true, peer_id: "agency-a" },
  });
  if (result.channel !== "sftp") return;
  expect(result.options?.peerId).toBe("agency-a");
});

// --- FileSyncOptions: unexpected_files ---------------------------------------

test.each(["error", "warn", "ignore"] as const)(
  "unexpected_files accepts the enum value %s",
  (value) => {
    const result = safeParseConnectionConfig({
      ...sftpBase,
      options: { unexpectedFiles: value },
    });
    expect(result.success).toBe(true);
    if (!result.success || result.data.channel !== "sftp") return;
    expect(result.data.options?.unexpectedFiles).toBe(value);
  },
);

test("unexpected_files rejects a value outside the enum", () => {
  const result = safeParseConnectionConfig({
    ...sftpBase,
    options: { unexpectedFiles: "abort" },
  });
  expect(result.success).toBe(false);
});

test("parses snake_case unexpected_files from disk", () => {
  const result = parseConnectionConfig({
    ...sftpBase,
    options: { unexpected_files: "warn" },
  });
  if (result.channel !== "sftp") return;
  expect(result.options?.unexpectedFiles).toBe("warn");
});

test("unexpected_files is accepted on filedrop", () => {
  const result = safeParseConnectionConfig({
    channel: "filedrop",
    path: "/mnt/share",
    options: { unexpectedFiles: "ignore" },
  });
  expect(result.success).toBe(true);
});
