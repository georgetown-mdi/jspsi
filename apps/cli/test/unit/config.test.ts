import { expect, test } from "vitest";
import { applyConnectionOverrides } from "../../src/config";
import type { ConnectionConfig, SFTPConnectionConfig } from "@psilink/core";

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
  expect(() =>
    applyConnectionOverrides(base, { peerId: "agency-a" }),
  ).toThrow("timestamp_in_filename");
});
