import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import YAML from "yaml";
import { saveKeyFile } from "../../src/keyFile";
import { loadConfig } from "../../src/commands/exchange";

let dir: string;
let configFile: string;
let keyFile: string;

const minimalLinkageTerms = {
  version: "1.0.0",
  identity: "Test Party",
  date: "2025-01-01",
  algorithm: "psi",
  output: { expectsOutput: true, shareWithPartner: false },
  deduplicate: false,
  linkageFields: [{ name: "ssn", semanticType: "ssn" }],
  linkageKeys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
};

const minimalSFTPConfig = {
  connection: { channel: "sftp", server: { host: "sftp.example.org" } },
  linkageTerms: minimalLinkageTerms,
};

const minimalFiledropConfig = {
  connection: { channel: "filedrop", path: "/mnt/share/drop" },
  linkageTerms: minimalLinkageTerms,
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-exchange-test-"));
  configFile = path.join(dir, "psilink.yaml");
  keyFile = path.join(dir, ".psilink.key");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function baseOptions() {
  return { configFile, keyFile };
}

// --- happy path --------------------------------------------------------------

test("returns connection and injects pakeToken from key file", () => {
  fs.writeFileSync(configFile, YAML.stringify(minimalSFTPConfig));
  saveKeyFile(keyFile, { pakeToken: "tok" });
  const result = loadConfig(baseOptions());
  expect(result.connection.channel).toBe("sftp");
  expect(result.connection.authentication?.pakeToken).toBe("tok");
});

test("injects expires from key file when present", () => {
  fs.writeFileSync(configFile, YAML.stringify(minimalSFTPConfig));
  saveKeyFile(keyFile, {
    pakeToken: "tok",
    expires: "2030-01-01T00:00:00.000Z",
  });
  const result = loadConfig(baseOptions());
  expect(result.connection.authentication?.expires).toBe(
    "2030-01-01T00:00:00.000Z",
  );
});

test("preserves existing authentication fields when injecting pakeToken", () => {
  const configWithRole = {
    ...minimalSFTPConfig,
    connection: {
      ...minimalSFTPConfig.connection,
      authentication: { role: "inviter" },
    },
  };
  fs.writeFileSync(configFile, YAML.stringify(configWithRole));
  saveKeyFile(keyFile, { pakeToken: "injected" });
  const result = loadConfig(baseOptions());
  expect(result.connection.authentication?.pakeToken).toBe("injected");
  expect(result.connection.authentication?.role).toBe("inviter");
});

// --- config file errors ------------------------------------------------------

test("throws with ENOENT code when config file is absent", () => {
  saveKeyFile(keyFile, { pakeToken: "tok" });
  let caught: unknown;
  try {
    loadConfig(baseOptions());
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toMatch("does not exist");
  expect((caught as NodeJS.ErrnoException).code).toBe("ENOENT");
});

test("throws on malformed YAML in config file", () => {
  fs.writeFileSync(configFile, ": {invalid yaml{{");
  saveKeyFile(keyFile, { pakeToken: "tok" });
  expect(() => loadConfig(baseOptions())).toThrow();
});

test("throws when config file fails schema validation", () => {
  fs.writeFileSync(
    configFile,
    YAML.stringify({ connection: { channel: "ftp", server: {} } }),
  );
  saveKeyFile(keyFile, { pakeToken: "tok" });
  expect(() => loadConfig(baseOptions())).toThrow();
});

// --- key file errors ---------------------------------------------------------

test("throws with 'does not exist' message when key file is absent", () => {
  fs.writeFileSync(configFile, YAML.stringify(minimalSFTPConfig));
  expect(() => loadConfig(baseOptions())).toThrow("does not exist");
});

test("throws with 'malformed' message when key file contains invalid JSON", () => {
  fs.writeFileSync(configFile, YAML.stringify(minimalSFTPConfig));
  fs.writeFileSync(keyFile, "not-json");
  expect(() => loadConfig(baseOptions())).toThrow("malformed");
});

test("throws with 'malformed' message when key file fails schema validation", () => {
  fs.writeFileSync(configFile, YAML.stringify(minimalSFTPConfig));
  fs.writeFileSync(keyFile, JSON.stringify({ pakeToken: "" }));
  expect(() => loadConfig(baseOptions())).toThrow("malformed");
});

// --- CLI overrides -----------------------------------------------------------

test("applies serverPort override to the connection", () => {
  fs.writeFileSync(configFile, YAML.stringify(minimalSFTPConfig));
  saveKeyFile(keyFile, { pakeToken: "tok" });
  const result = loadConfig({ ...baseOptions(), serverPort: 2222 });
  if (result.connection.channel !== "sftp") return;
  expect(result.connection.server.port).toBe(2222);
});

test("applies peerTimeout override and converts to milliseconds", () => {
  fs.writeFileSync(configFile, YAML.stringify(minimalSFTPConfig));
  saveKeyFile(keyFile, { pakeToken: "tok" });
  const result = loadConfig({ ...baseOptions(), peerTimeout: 60 });
  expect(result.connection.options?.peerTimeoutMs).toBe(60_000);
});

// --- filedrop channel --------------------------------------------------------

test("filedrop config injects pakeToken from key file", () => {
  fs.writeFileSync(configFile, YAML.stringify(minimalFiledropConfig));
  saveKeyFile(keyFile, { pakeToken: "tok" });
  const result = loadConfig(baseOptions());
  expect(result.connection.channel).toBe("filedrop");
  expect(result.connection.authentication?.pakeToken).toBe("tok");
});

test("filedrop config throws when key file is absent", () => {
  fs.writeFileSync(configFile, YAML.stringify(minimalFiledropConfig));
  expect(() => loadConfig(baseOptions())).toThrow("does not exist");
});

// --- webrtc channel ----------------------------------------------------------

test("webrtc config throws 'not yet supported' error", () => {
  fs.writeFileSync(
    configFile,
    YAML.stringify({
      connection: { channel: "webrtc", server: { host: "api.peerjs.com" } },
      linkageTerms: minimalLinkageTerms,
    }),
  );
  expect(() => loadConfig(baseOptions())).toThrow("not yet supported");
});
