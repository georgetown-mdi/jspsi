import { ZodError } from "zod";
import { expect, test } from "vitest";

import {
  MAX_RECONNECT_ATTEMPTS,
  SHARED_SECRET_REGEX,
  generateSharedSecret,
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

// --- split inbound/outbound directories --------------------------------------

// A split directory requires retain mode, which transitively requires lockless
// rendezvous and timestamped filenames; supply all three so the only thing a
// rejection test exercises is the path-mode rule under test.
const splitOptions = {
  retain_files: true,
  lockless_rendezvous: true,
  timestamp_in_filename: true,
};

test("parses a split-directory file-drop connection", () => {
  const result = parseConnectionConfig({
    channel: "filedrop",
    inbound_path: "/mnt/in",
    outbound_path: "/mnt/out",
    options: splitOptions,
  });
  expect(result.channel).toBe("filedrop");
  if (result.channel !== "filedrop") return;
  expect(result.inboundPath).toBe("/mnt/in");
  expect(result.outboundPath).toBe("/mnt/out");
  expect(result.path).toBeUndefined();
});

test("parses a split-directory SFTP connection", () => {
  const result = parseConnectionConfig({
    channel: "sftp",
    server: {
      host: "sftp.example.org",
      inbound_path: "exchanges/in",
      outbound_path: "exchanges/out",
    },
    options: splitOptions,
  });
  expect(result.channel).toBe("sftp");
  if (result.channel !== "sftp") return;
  expect(result.server.inboundPath).toBe("exchanges/in");
  expect(result.server.outboundPath).toBe("exchanges/out");
  expect(result.server.path).toBeUndefined();
});

test("a separate outbound directory without retain_files is rejected (filedrop)", () => {
  const result = safeParseConnectionConfig({
    channel: "filedrop",
    inbound_path: "/mnt/in",
    outbound_path: "/mnt/out",
    options: { lockless_rendezvous: true, timestamp_in_filename: true },
  });
  expect(result.success).toBe(false);
});

test("a separate outbound directory without retain_files is rejected (sftp)", () => {
  const result = safeParseConnectionConfig({
    channel: "sftp",
    server: { host: "h", inbound_path: "in", outbound_path: "out" },
  });
  expect(result.success).toBe(false);
});

test("split connection with equal inbound and outbound paths is rejected", () => {
  const result = safeParseConnectionConfig({
    channel: "filedrop",
    inbound_path: "/mnt/same",
    outbound_path: "/mnt/same",
    options: splitOptions,
  });
  expect(result.success).toBe(false);
});

test("mixing a single path with the inbound/outbound pair is rejected", () => {
  const result = safeParseConnectionConfig({
    channel: "filedrop",
    path: "/mnt/shared",
    inbound_path: "/mnt/in",
    outbound_path: "/mnt/out",
    options: splitOptions,
  });
  expect(result.success).toBe(false);
});

test("setting only the inbound half of the pair is rejected", () => {
  const result = safeParseConnectionConfig({
    channel: "filedrop",
    inbound_path: "/mnt/in",
    options: splitOptions,
  });
  expect(result.success).toBe(false);
});

test("setting only the outbound half of the pair is rejected", () => {
  const result = safeParseConnectionConfig({
    channel: "filedrop",
    outbound_path: "/mnt/out",
    options: splitOptions,
  });
  expect(result.success).toBe(false);
});

test("setting only one half of the pair is rejected for sftp, naming the constraint", () => {
  // sftp has no "filedrop requires a directory" backstop (login-home is a valid
  // shared mode), so the half-pair refine is the ONLY rule that can fire here --
  // this isolates it (the filedrop half-pair tests above also satisfy the
  // requires-a-directory rule, so they do not, on their own, prove the half-pair
  // refine fires). Assert the message so the right refine is pinned.
  const result = safeParseConnectionConfig({
    channel: "sftp",
    server: { host: "h", inbound_path: "in" },
    options: splitOptions,
  });
  expect(result.success).toBe(false);
  if (result.success) return;
  expect(
    result.error.issues.some((i) => i.message.includes("set together")),
  ).toBe(true);
});

// The schema rejects not only byte-identical paths but any split pair that
// resolves to one directory, using the same rule open() applies -- so a config
// that would collapse to a single directory fails to parse rather than parsing
// "valid" and only failing later at connect time. Each case asserts the "must
// differ" refine is the one that fires (not, say, a half-pair backstop).
test.each([
  ["a trailing slash (filedrop)", "filedrop", "/x", "/x/"],
  ["a redundant interior slash (filedrop)", "filedrop", "/a//in", "/a/in"],
  ['a "." segment (filedrop)', "filedrop", "/a/./in", "/a/in"],
  ['a "." segment (sftp)', "sftp", "in/./x", "in/x"],
])(
  "split pair resolving to one directory via %s is rejected",
  (_label, channel, inbound_path, outbound_path) => {
    const result = safeParseConnectionConfig(
      channel === "sftp"
        ? {
            channel,
            server: { host: "h", inbound_path, outbound_path },
            options: splitOptions,
          }
        : { channel, inbound_path, outbound_path, options: splitOptions },
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(
      result.error.issues.some((i) => i.message.includes("must differ")),
    ).toBe(true);
  },
);

test("file-drop connection with neither path nor the pair is rejected", () => {
  const result = safeParseConnectionConfig({ channel: "filedrop" });
  expect(result.success).toBe(false);
});

test("split file-drop connection with a relative inbound_path is rejected", () => {
  const result = safeParseConnectionConfig({
    channel: "filedrop",
    inbound_path: "relative/in",
    outbound_path: "/mnt/out",
    options: splitOptions,
  });
  expect(result.success).toBe(false);
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
  // SHA256: followed by 43 unpadded standard base64 chars; all-A is valid
  // (A is in both [A-Za-z0-9+/] for positions 1-42 and [AEIMQUYcgkosw048] for 43).
  const validPin = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const result = parseConnectionConfig({
    channel: "sftp",
    server: {
      host: "sftp.example.org",
      port: 22,
      path: "/exchanges/",
      username: "psilink",
      privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----",
      privateKeyPassphrase: "hunter2",
      hostKeyFingerprint: validPin,
    },
    options: { pollIntervalMs: 5000 },
  });
  expect(result.channel).toBe("sftp");
  if (result.channel !== "sftp") return;
  expect(result.server.privateKey).toBeDefined();
  expect(result.server.privateKeyPassphrase).toBeDefined();
  expect(result.server.hostKeyFingerprint).toBe(validPin);
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

test("an unset server_connect_timeout_ms defaults to 30000 at the schema boundary", () => {
  // The documented 30000 ms per-attempt connect default is applied by the schema,
  // so a config whose options omit the field still carries it -- the contract the
  // JSDoc and EXCHANGE_REFERENCE.md advertise. The default fires whenever the
  // options object is present (here alongside another field).
  const result = safeParseConnectionConfig({
    ...sftpBase,
    options: { pollIntervalMs: 100 },
  });
  expect(result.success).toBe(true);
  if (!result.success) return;
  expect(result.data.options?.serverConnectTimeoutMs).toBe(30000);
});

test("an unset server_connect_timeout_ms defaults to 30000 on a filedrop config", () => {
  // Same default on the other file-sync channel, applied uniformly.
  const result = safeParseConnectionConfig({
    channel: "filedrop",
    path: "/mnt/share/drop",
    options: { pollIntervalMs: 100 },
  });
  expect(result.success).toBe(true);
  if (!result.success) return;
  expect(result.data.options?.serverConnectTimeoutMs).toBe(30000);
});

test("an explicit server_connect_timeout_ms passes through unchanged", () => {
  // Teeth for the default tests: an explicit value (distinct from 30000) is not
  // overridden by the default.
  const result = safeParseConnectionConfig({
    ...sftpBase,
    options: { server_connect_timeout_ms: 5000 },
  });
  expect(result.success).toBe(true);
  if (!result.success) return;
  expect(result.data.options?.serverConnectTimeoutMs).toBe(5000);
});

test("peer_timeout_ms of zero is rejected", () => {
  // peerTimeoutMs is the per-await peer-inactivity liveness budget; a zero would
  // fire every transport await immediately and disable the liveness control. The
  // CLI's --peer-timeout already rejects zero, so the schema must close the same
  // hole on the config/programmatic path (snake_case, as read from disk).
  const result = safeParseConnectionConfig({
    ...sftpBase,
    options: { peer_timeout_ms: 0 },
  });
  expect(result.success).toBe(false);
});

test("poll_interval_ms of zero is rejected", () => {
  // pollIntervalMs is positive, not nonnegative: a zero is not "as fast as
  // possible" but a setTimeout(0) hot poll that busy-loops directory listings
  // against the server (a self-inflicted flood), so the schema rejects it. The
  // CLI's --polling-frequency already rejects zero; this closes the same hole on
  // the config/programmatic path (snake_case, as read from disk).
  const result = safeParseConnectionConfig({
    ...sftpBase,
    options: { poll_interval_ms: 0 },
  });
  expect(result.success).toBe(false);
});

test("a positive poll_interval_ms is still accepted", () => {
  // Teeth for the zero-rejection above: the positivity floor rejects only zero (and
  // negatives), so the smallest valid interval, 1 ms, still passes.
  const result = safeParseConnectionConfig({
    ...sftpBase,
    options: { poll_interval_ms: 1 },
  });
  expect(result.success).toBe(true);
  if (!result.success) return;
  // pollIntervalMs is a FileSyncOptions field; narrow off the union by channel.
  if (result.data.channel !== "sftp") return;
  expect(result.data.options?.pollIntervalMs).toBe(1);
});

test("server_connect_timeout_ms of zero is rejected", () => {
  // A zero serverConnectTimeoutMs is not a meaningful "no timeout": it times out
  // the filedrop local-FS connect probe immediately and disables ssh2's connect
  // readyTimeout (armed only when > 0). The CLI's --connection-timeout already
  // rejects zero; the schema closes the same hole on the config path.
  const result = safeParseConnectionConfig({
    ...sftpBase,
    options: { server_connect_timeout_ms: 0 },
  });
  expect(result.success).toBe(false);
});

test("max_reconnect_attempts of zero is still accepted", () => {
  // Contrast with the two budgets above: zero is meaningful here ("connect once,
  // do not reconnect"), so it must remain valid.
  const result = safeParseConnectionConfig({
    ...sftpBase,
    options: { max_reconnect_attempts: 0 },
  });
  expect(result.success).toBe(true);
  if (!result.success) return;
  expect(result.data.options?.maxReconnectAttempts).toBe(0);
});

test("max_reconnect_attempts at the ceiling is accepted", () => {
  // The ceiling is inclusive: exactly MAX_RECONNECT_ATTEMPTS, the largest in-range
  // value, parses unchanged -- the schema floor and ceiling agree with the CLI
  // parse guard at both ends of the range.
  const result = safeParseConnectionConfig({
    ...sftpBase,
    options: { max_reconnect_attempts: MAX_RECONNECT_ATTEMPTS },
  });
  expect(result.success).toBe(true);
  if (!result.success) return;
  expect(result.data.options?.maxReconnectAttempts).toBe(
    MAX_RECONNECT_ATTEMPTS,
  );
});

test("max_reconnect_attempts above the ceiling is rejected", () => {
  // The footgun this closes: the field was z.int().nonnegative() with no upper
  // bound, so a value near Number.MAX_SAFE_INTEGER was accepted and became a
  // linear self-inflicted connect hang (~N seconds at the 1s inter-attempt floor).
  // One past the ceiling is now rejected on the config/programmatic path, so an
  // over-ceiling --max-reconnect-attempts override caught at the CLI boundary is
  // also caught here by the merged-options re-validation.
  const result = safeParseConnectionConfig({
    ...sftpBase,
    options: { max_reconnect_attempts: MAX_RECONNECT_ATTEMPTS + 1 },
  });
  expect(result.success).toBe(false);
});

test("a positive peer_timeout_ms is still accepted", () => {
  // Teeth for the test above: the rejection is the zero, not the field.
  const result = safeParseConnectionConfig({
    ...sftpBase,
    options: { peer_timeout_ms: 1 },
  });
  expect(result.success).toBe(true);
  if (!result.success) return;
  expect(result.data.options?.peerTimeoutMs).toBe(1);
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

test("SFTP server with certificate and privateKey together is rejected (not yet supported)", () => {
  // certificate is not yet supported regardless of whether privateKey is present.
  const result = safeParseConnectionConfig({
    channel: "sftp",
    server: {
      host: "sftp.example.org",
      privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----",
      certificate: "/run/secrets/id_cert",
    },
  });
  expect(result.success).toBe(false);
  if (result.success) return;
  const messages = result.error.issues.map((i) => i.message);
  expect(messages.some((m) => m.includes("certificate"))).toBe(true);
});

// --- SFTPServer: keyboard_interactive requires password ----------------------

test("SFTP server with keyboard_interactive and password is accepted", () => {
  const result = safeParseConnectionConfig({
    channel: "sftp",
    server: {
      host: "sftp.example.org",
      password: "hunter2",
      keyboard_interactive: true,
    },
  });
  expect(result.success).toBe(true);
  if (!result.success) return;
  if (result.data.channel !== "sftp") return;
  expect(result.data.server.keyboardInteractive).toBe(true);
});

test("SFTP server with keyboard_interactive but no password is rejected", () => {
  const result = safeParseConnectionConfig({
    channel: "sftp",
    server: {
      host: "sftp.example.org",
      keyboard_interactive: true,
    },
  });
  expect(result.success).toBe(false);
  if (result.success) return;
  const issue = result.error.issues.find((i) =>
    i.message.includes("keyboard_interactive requires password"),
  );
  expect(issue).toBeDefined();
  expect(issue?.path).toContain("keyboardInteractive");
});

test("SFTP server with keyboard_interactive and privateKey (no password) is rejected", () => {
  // keyboard_interactive answers prompts with the password, so it is invalid
  // alongside key-only auth -- the requires-password refine fires.
  const result = safeParseConnectionConfig({
    channel: "sftp",
    server: {
      host: "sftp.example.org",
      privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----",
      keyboard_interactive: true,
    },
  });
  expect(result.success).toBe(false);
  if (result.success) return;
  const messages = result.error.issues.map((i) => i.message);
  expect(
    messages.some((m) => m.includes("keyboard_interactive requires")),
  ).toBe(true);
});

test("SFTP server with keyboard_interactive: false and no password is accepted", () => {
  // The refine only fires for an explicit `true`; the default-off value is a
  // no-op that must not demand a password.
  const result = safeParseConnectionConfig({
    channel: "sftp",
    server: {
      host: "sftp.example.org",
      keyboard_interactive: false,
    },
  });
  expect(result.success).toBe(true);
});

// --- SFTPServer: host_key_fingerprint format ---------------------------------

test("SFTP server with valid host_key_fingerprint is accepted", () => {
  // Standard base64, SHA256: prefix, 43 characters (42 wide + 1 constrained).
  const result = safeParseConnectionConfig({
    ...sftpBase,
    server: {
      host: "sftp.example.org",
      host_key_fingerprint:
        "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    },
  });
  expect(result.success).toBe(true);
});

test("SFTP host_key_fingerprint missing SHA256: prefix is rejected", () => {
  const result = safeParseConnectionConfig({
    ...sftpBase,
    server: {
      host: "sftp.example.org",
      host_key_fingerprint: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    },
  });
  expect(result.success).toBe(false);
  if (result.success) return;
  const messages = result.error.issues.map((i) => i.message);
  expect(messages.some((m) => m.includes("SHA256:"))).toBe(true);
});

test("SFTP host_key_fingerprint that looks like a signing partner_fingerprint is rejected with a named-confusion message", () => {
  // A signing partner_fingerprint is 43 base64url chars (no prefix). The error
  // message should name the confusion so the operator knows which type to use.
  const signingShape = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"; // 43 base64url chars (all-A)
  const result = safeParseConnectionConfig({
    ...sftpBase,
    server: { host: "sftp.example.org", host_key_fingerprint: signingShape },
  });
  expect(result.success).toBe(false);
  if (result.success) return;
  const messages = result.error.issues.map((i) => i.message);
  expect(messages.some((m) => m.includes("partner_fingerprint"))).toBe(true);
});

test("SFTP host_key_fingerprint with base64url chars (- or _) is rejected", () => {
  // Standard base64 uses + and /; base64url uses - and _. A value with - or _
  // does not have the signing-fingerprint shape (no prefix + 43 chars) but is
  // still a bad format.
  const result = safeParseConnectionConfig({
    ...sftpBase,
    server: {
      host: "sftp.example.org",
      host_key_fingerprint:
        "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA_",
    },
  });
  expect(result.success).toBe(false);
});

test("SFTP host_key_fingerprint as an @-file reference passes parse (format-checked after resolution)", () => {
  // The @path cannot match the SHA256: format; the format check is deferred to
  // @-file resolution, so the literal @path must survive parse like password
  // and private_key do. Rejecting it here would make @-file support unusable.
  const result = safeParseConnectionConfig({
    ...sftpBase,
    server: {
      host: "sftp.example.org",
      host_key_fingerprint: "@/run/secrets/host-fingerprint",
    },
  });
  expect(result.success).toBe(true);
});

test("SFTP server with a list of valid host_key_fingerprints is accepted (rotation staging)", () => {
  // A non-empty list of canonical fingerprints: the single-value form's
  // extension for staging a rotated key alongside the current one.
  const result = safeParseConnectionConfig({
    ...sftpBase,
    server: {
      host: "sftp.example.org",
      host_key_fingerprint: [
        "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s",
      ],
    },
  });
  expect(result.success).toBe(true);
  if (!result.success) return;
  if (result.data.channel !== "sftp") return;
  expect(result.data.server.hostKeyFingerprint).toEqual([
    "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s",
  ]);
});

test("SFTP host_key_fingerprint list with one malformed entry is rejected at its index", () => {
  // The list's second entry is missing the SHA256: prefix; the issue path must
  // point at the offending index so the operator can locate it.
  const result = safeParseConnectionConfig({
    ...sftpBase,
    server: {
      host: "sftp.example.org",
      host_key_fingerprint: [
        "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      ],
    },
  });
  expect(result.success).toBe(false);
  if (result.success) return;
  const offending = result.error.issues.find((i) =>
    i.message.includes("SHA256:"),
  );
  expect(offending).toBeDefined();
  expect(offending?.path).toContain("hostKeyFingerprint");
  expect(offending?.path).toContain(1);
});

test("SFTP host_key_fingerprint empty list is rejected (pins no key)", () => {
  const result = safeParseConnectionConfig({
    ...sftpBase,
    server: { host: "sftp.example.org", host_key_fingerprint: [] },
  });
  expect(result.success).toBe(false);
  if (result.success) return;
  const messages = result.error.issues.map((i) => i.message);
  expect(messages.some((m) => m.includes("at least one fingerprint"))).toBe(
    true,
  );
});

test("SFTP host_key_fingerprint list mixing a literal and an @-file reference passes parse", () => {
  // Each entry is independently @-eligible: a literal is format-checked at
  // parse, an @path is deferred to resolution, exactly as the scalar form is.
  const result = safeParseConnectionConfig({
    ...sftpBase,
    server: {
      host: "sftp.example.org",
      host_key_fingerprint: [
        "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "@/run/secrets/host-fingerprint",
      ],
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
  const validPin = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const result = parseConnectionConfig({
    channel: "sftp",
    server: {
      host: "sftp.example.org",
      private_key: "-----BEGIN OPENSSH PRIVATE KEY-----",
      private_key_passphrase: "hunter2",
      host_key_fingerprint: validPin,
    },
  });
  if (result.channel !== "sftp") return;
  expect(result.server.privateKey).toBeDefined();
  expect(result.server.privateKeyPassphrase).toBeDefined();
  expect(result.server.hostKeyFingerprint).toBe(validPin);
});

test("known_hosts is rejected at parse time (use host_key_fingerprint instead)", () => {
  const result = safeParseConnectionConfig({
    channel: "sftp",
    server: { host: "sftp.example.org", known_hosts: "/etc/ssh/known_hosts" },
  });
  expect(result.success).toBe(false);
  if (result.success) return;
  const messages = result.error.issues.map((i) => i.message);
  expect(messages.some((m) => m.includes("known_hosts"))).toBe(true);
  expect(messages.some((m) => m.includes("host_key_fingerprint"))).toBe(true);
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

// --- FileSyncOptions: connection_per_poll ------------------------------------

test("connection_per_poll is accepted on sftp", () => {
  const result = parseConnectionConfig({
    ...sftpBase,
    options: { connectionPerPoll: true },
  });
  if (result.channel !== "sftp") return;
  expect(result.options?.connectionPerPoll).toBe(true);
});

test("connection_per_poll defaults to undefined when unset", () => {
  const result = parseConnectionConfig({
    ...sftpBase,
    options: { pollIntervalMs: 60_000 },
  });
  if (result.channel !== "sftp") return;
  expect(result.options?.connectionPerPoll).toBeUndefined();
});

test("parses snake_case connection_per_poll from disk", () => {
  const result = parseConnectionConfig({
    ...sftpBase,
    options: { connection_per_poll: true },
  });
  if (result.channel !== "sftp") return;
  expect(result.options?.connectionPerPoll).toBe(true);
});

test("connection_per_poll rejects a non-boolean", () => {
  const result = safeParseConnectionConfig({
    ...sftpBase,
    options: { connectionPerPoll: "yes" },
  });
  expect(result.success).toBe(false);
});

test("connection_per_poll is schema-accepted on filedrop (inert; the CLI warns)", () => {
  // The field lives on FileSyncOptions for schema uniformity, so a filedrop
  // config carrying it parses; it is inert there (filedrop holds no session), and
  // the CLI surfaces the warning rather than the schema hard-blocking it.
  const result = safeParseConnectionConfig({
    channel: "filedrop",
    path: "/mnt/share",
    options: { connectionPerPoll: true },
  });
  expect(result.success).toBe(true);
});

// --- generateSharedSecret ----------------------------------------------------

test("generateSharedSecret always matches SHARED_SECRET_REGEX", () => {
  // Many draws: the final-character constraint (43 base64url chars, last in
  // [AEIMQUYcgkosw048]) holds only because 32 bytes leave 2 zero padding bits, so
  // a regression to a different byte length would fail this for some random draw.
  for (let i = 0; i < 100; i++) {
    expect(generateSharedSecret()).toMatch(SHARED_SECRET_REGEX);
  }
});

test("generateSharedSecret is non-deterministic across calls", () => {
  expect(generateSharedSecret()).not.toBe(generateSharedSecret());
});
