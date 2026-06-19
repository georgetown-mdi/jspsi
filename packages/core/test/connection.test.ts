import { ZodError } from "zod";
import { expect, test } from "vitest";

import {
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
