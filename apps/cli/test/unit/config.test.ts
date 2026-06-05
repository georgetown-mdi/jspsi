import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import YAML from "yaml";
import {
  getDefaultLinkageTerms,
  parseExchangeSpec,
  UsageError,
} from "@psilink/core";
import { applyConnectionOverrides, saveConfig } from "../../src/config";
import type {
  ConnectionConfig,
  ExchangeSpec,
  SFTPConnectionConfig,
} from "@psilink/core";

const baseSFTP: ConnectionConfig = {
  channel: "sftp",
  server: { host: "sftp.example.org" },
};

// --- timeout / reconnect overrides -------------------------------------------

test("peerTimeout is converted to peerTimeoutMs in milliseconds", () => {
  const result = applyConnectionOverrides(baseSFTP, { peerTimeout: 30 });
  expect(result.options?.peerTimeoutMs).toBe(30_000);
});

test("connectionTimeout is converted to serverConnectTimeoutMs in milliseconds", () => {
  const result = applyConnectionOverrides(baseSFTP, { connectionTimeout: 10 });
  expect(result.options?.serverConnectTimeoutMs).toBe(10_000);
});

test("maxReconnectAttempts is passed through unchanged", () => {
  const result = applyConnectionOverrides(baseSFTP, {
    maxReconnectAttempts: 5,
  });
  expect(result.options?.maxReconnectAttempts).toBe(5);
});

test("multiple timeout overrides are merged into options", () => {
  const result = applyConnectionOverrides(baseSFTP, {
    peerTimeout: 60,
    connectionTimeout: 15,
    maxReconnectAttempts: 2,
  });
  expect(result.options?.peerTimeoutMs).toBe(60_000);
  expect(result.options?.serverConnectTimeoutMs).toBe(15_000);
  expect(result.options?.maxReconnectAttempts).toBe(2);
});

test("existing options are preserved when adding timeout overrides", () => {
  const base: ConnectionConfig = {
    channel: "sftp",
    server: { host: "sftp.example.org" },
    options: { pollIntervalMs: 5000 },
  };
  const result = applyConnectionOverrides(base, {
    peerTimeout: 20,
  }) as SFTPConnectionConfig;
  expect(result.options?.pollIntervalMs).toBe(5000);
  expect(result.options?.peerTimeoutMs).toBe(20_000);
});

// --- server credential overrides ---------------------------------------------

test("serverUsername overrides the connection username", () => {
  const result = applyConnectionOverrides(baseSFTP, {
    serverUsername: "alice",
  });
  if (result.channel !== "sftp") return;
  expect(result.server.username).toBe("alice");
});

test("serverPort overrides the connection port", () => {
  const result = applyConnectionOverrides(baseSFTP, { serverPort: 2222 });
  if (result.channel !== "sftp") return;
  expect(result.server.port).toBe(2222);
});

// --- immutability ------------------------------------------------------------

test("empty overrides object does not change the connection", () => {
  const result = applyConnectionOverrides(baseSFTP, {});
  expect(result).toEqual(baseSFTP);
});

test("the input connection object is not mutated", () => {
  const input: ConnectionConfig = {
    channel: "sftp",
    server: { host: "sftp.example.org" },
  };
  applyConnectionOverrides(input, { peerTimeout: 10, serverUsername: "bob" });
  expect(input.options).toBeUndefined();
  if (input.channel !== "sftp") return;
  expect(input.server.username).toBeUndefined();
});

// --- peerId validation -------------------------------------------------------

test("peerId override accepted when timestampInFilename is already set in config", () => {
  const base: ConnectionConfig = {
    channel: "sftp",
    server: { host: "sftp.example.org" },
    options: { timestampInFilename: true },
  };
  const result = applyConnectionOverrides(base, { peerId: "agency-a" });
  if (result.channel !== "sftp") return;
  expect(result.options?.peerId).toBe("agency-a");
});

test("peerId 'temp' is rejected by applyConnectionOverrides", () => {
  const base: ConnectionConfig = {
    channel: "sftp",
    server: { host: "sftp.example.org" },
    options: { timestampInFilename: true },
  };
  // Invalid option combinations are usage errors (CLI exit 64), not exit 69.
  expect(() => applyConnectionOverrides(base, { peerId: "temp" })).toThrow(
    UsageError,
  );
  expect(() => applyConnectionOverrides(base, { peerId: "temp" })).toThrow(
    "reserved",
  );
});

test("peerId without timestampInFilename is rejected by applyConnectionOverrides", () => {
  expect(() =>
    applyConnectionOverrides(baseSFTP, { peerId: "agency-a" }),
  ).toThrow("timestamp_in_filename");
});

test("peerId without timestampInFilename is rejected on filedrop too", () => {
  const base: ConnectionConfig = {
    channel: "filedrop",
    path: "/mnt/share",
  };
  expect(() => applyConnectionOverrides(base, { peerId: "agency-a" })).toThrow(
    "timestamp_in_filename",
  );
});

test("empty peerId is rejected by applyConnectionOverrides", () => {
  const base: ConnectionConfig = {
    channel: "sftp",
    server: { host: "sftp.example.org" },
    options: { timestampInFilename: true },
  };
  expect(() => applyConnectionOverrides(base, { peerId: "" })).toThrow();
});

// --- retainFiles implication --------------------------------------------------

test("retainFiles: true with unset lockless and timestamp implies both true", () => {
  const result = applyConnectionOverrides(baseSFTP, { retainFiles: true });
  if (result.channel !== "sftp") return;
  expect(result.options?.retainFiles).toBe(true);
  expect(result.options?.locklessRendezvous).toBe(true);
  expect(result.options?.timestampInFilename).toBe(true);
});

test("retainFiles: true preserves an already-set locklessRendezvous: true", () => {
  const base: ConnectionConfig = {
    channel: "sftp",
    server: { host: "sftp.example.org" },
    options: { locklessRendezvous: true, timestampInFilename: true },
  };
  const result = applyConnectionOverrides(base, { retainFiles: true });
  if (result.channel !== "sftp") return;
  expect(result.options?.locklessRendezvous).toBe(true);
});

test("retainFiles: true with explicit locklessRendezvous: false throws", () => {
  expect(() =>
    applyConnectionOverrides(baseSFTP, {
      retainFiles: true,
      locklessRendezvous: false,
    }),
  ).toThrow(UsageError);
  expect(() =>
    applyConnectionOverrides(baseSFTP, {
      retainFiles: true,
      locklessRendezvous: false,
    }),
  ).toThrow("lockless_rendezvous");
});

// --- saveConfig --------------------------------------------------------------

test("saveConfig emits snake_case keys and round-trips through parseExchangeSpec", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-config-"));
  try {
    const configPath = path.join(dir, "psilink.yaml");
    const spec: ExchangeSpec = {
      connection: { channel: "filedrop", path: "/mnt/share" },
      linkageTerms: getDefaultLinkageTerms("Agency A"),
    };
    saveConfig(configPath, spec);
    const raw = fs.readFileSync(configPath, "utf8");
    // camelCase TS keys are written in their snake_case YAML form ...
    expect(raw).toContain("linkage_fields:");
    expect(raw).toContain("linkage_keys:");
    expect(raw).toContain("expects_output:");
    expect(raw).toContain("share_with_partner:");
    // ... never camelCase.
    expect(raw).not.toContain("linkageFields");
    expect(raw).not.toContain("expectsOutput");
    // The writer is the inverse of the reader's camelizeKeys: parsing the
    // written file reproduces the original spec exactly.
    expect(parseExchangeSpec(YAML.parse(raw))).toEqual(spec);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("saveConfig writes the config owner-read-only (0600)", () => {
  // Windows uses a restricted ACL, not POSIX mode bits; fs.statSync reports a
  // synthetic mode there, so this assertion is Unix-only.
  if (process.platform === "win32") return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-config-"));
  try {
    const configPath = path.join(dir, "psilink.yaml");
    // A spec carrying an inline SFTP credential is exactly why the config must
    // be owner-only: the 0600 mode is what keeps the password from other users.
    const spec: ExchangeSpec = {
      connection: {
        channel: "sftp",
        server: { host: "h", username: "u", password: "s3cret-inline" },
      },
      linkageTerms: getDefaultLinkageTerms("Agency A"),
    };
    saveConfig(configPath, spec);
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(configPath, "utf8")).toContain("s3cret-inline");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("saveConfig strips pakeToken/expires and does not mutate the caller's spec", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-config-"));
  try {
    const configPath = path.join(dir, "psilink.yaml");
    const token = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const spec = {
      connection: {
        channel: "sftp",
        server: { host: "h" },
        authentication: {
          pakeToken: token,
          expires: "2028-01-01T00:00:00.000Z",
        },
      },
      linkageTerms: getDefaultLinkageTerms("Agency A"),
    } as unknown as ExchangeSpec;
    saveConfig(configPath, spec);
    const raw = fs.readFileSync(configPath, "utf8");
    // Key material never lands in the config, even when the caller leaves it set.
    expect(raw).not.toContain("pake_token");
    expect(raw).not.toContain(token);
    expect(raw).not.toContain("expires");
    // The now-empty authentication container is pruned, not left as `{}`.
    expect(raw).not.toContain("authentication");
    // The strip runs on a clone; the caller's spec is untouched.
    expect(spec.connection.authentication?.pakeToken).toBe(token);
    expect(spec.connection.authentication?.expires).toBe(
      "2028-01-01T00:00:00.000Z",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("saveConfig round-trips provider_options verbatim in both directions", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-config-"));
  try {
    const configPath = path.join(dir, "psilink.yaml");
    // provider_options is opaque: a literal camelCase key (ssh2's readyTimeout)
    // and a snake_case key must both survive the writer + reader unchanged. The
    // writer must not snakeize readyTimeout, and the reader must not camelize
    // keepalive_interval.
    const spec: ExchangeSpec = {
      connection: {
        channel: "sftp",
        server: { host: "h" },
        providerOptions: { readyTimeout: 5000, keepalive_interval: 1000 },
      },
      linkageTerms: getDefaultLinkageTerms("Agency A"),
    };

    // write: keys land on disk byte-for-byte (camelCase stays camelCase, snake
    // stays snake) -- not transformed by snakeizeKeys.
    saveConfig(configPath, spec);
    const raw1 = fs.readFileSync(configPath, "utf8");
    expect(raw1).toContain("readyTimeout:");
    expect(raw1).toContain("keepalive_interval:");
    expect(raw1).not.toContain("ready_timeout:");
    expect(raw1).not.toContain("keepaliveInterval:");

    // read: parsing reproduces the spec exactly, opaque map included.
    const parsed = parseExchangeSpec(YAML.parse(raw1));
    expect(parsed).toEqual(spec);
    if (parsed.connection.channel !== "sftp")
      throw new Error("expected sftp channel");
    expect(parsed.connection.providerOptions).toEqual({
      readyTimeout: 5000,
      keepalive_interval: 1000,
    });

    // read -> write: writing the re-read spec produces an identical opaque map,
    // confirming the round-trip is stable in both directions.
    saveConfig(configPath, parsed);
    const raw2 = fs.readFileSync(configPath, "utf8");
    expect(YAML.parse(raw2).connection.provider_options).toEqual(
      YAML.parse(raw1).connection.provider_options,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("saveConfig keeps authentication when role remains after stripping (WebRTC)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-config-"));
  try {
    const configPath = path.join(dir, "psilink.yaml");
    const token = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    // WebRTC is the only channel where authentication survives the strip: role
    // is a valid field, so the container is kept rather than pruned to `{}`.
    const spec = {
      connection: {
        channel: "webrtc",
        server: { host: "api.peerjs.com" },
        authentication: {
          role: "inviter",
          pakeToken: token,
          expires: "2028-01-01T00:00:00.000Z",
        },
      },
      linkageTerms: getDefaultLinkageTerms("Agency A"),
    } as unknown as ExchangeSpec;
    saveConfig(configPath, spec);
    const raw = fs.readFileSync(configPath, "utf8");
    // role survives and keeps the authentication container alive ...
    expect(raw).toContain("authentication:");
    expect(raw).toContain("role: inviter");
    // ... while the key material is still stripped.
    expect(raw).not.toContain("pake_token");
    expect(raw).not.toContain(token);
    expect(raw).not.toContain("expires");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
