import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import YAML from "yaml";
import { UsageError } from "@psilink/core";
import { saveKeyFile } from "../../src/keyFile";
import { loadConfig } from "../../src/commands/exchange";

const mockState = vi.hoisted(() => ({ warnings: [] as string[] }));

vi.mock("@psilink/core", async (importActual) => {
  const actual = await importActual<typeof import("@psilink/core")>();
  return {
    ...actual,
    getLogger: (_name: string) => ({
      info: () => {},
      debug: () => {},
      trace: () => {},
      error: () => {},
      warn: (msg: string, ...args: unknown[]) =>
        mockState.warnings.push([msg, ...args.map(String)].join(" ")),
    }),
  };
});

// 43-char base64url tokens satisfying the pakeToken format constraint.
const TOKEN_A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TOKEN_B = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM";

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
  linkageFields: [{ name: "ssn", type: "ssn" }],
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
  mockState.warnings.length = 0;
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
  saveKeyFile(keyFile, { pakeToken: TOKEN_A });
  const result = loadConfig(baseOptions());
  expect(result.connection.channel).toBe("sftp");
  expect(result.connection.authentication.pakeToken).toBe(TOKEN_A);
  expect(result.connection.authentication.keyFilePath).toBe(keyFile);
});

test("injects expires from key file when present", () => {
  fs.writeFileSync(configFile, YAML.stringify(minimalSFTPConfig));
  saveKeyFile(keyFile, {
    pakeToken: TOKEN_A,
    expires: "2030-01-01T00:00:00.000Z",
  });
  const result = loadConfig(baseOptions());
  expect(result.connection.authentication.expires).toBe(
    "2030-01-01T00:00:00.000Z",
  );
});

test("injects pakeToken from key file even when an authentication block is present in config", () => {
  // An authentication block in psilink.yaml for sftp/filedrop has no
  // user-settable fields; the key file always provides the token.
  const configWithAuth = {
    ...minimalSFTPConfig,
    connection: {
      ...minimalSFTPConfig.connection,
      authentication: {},
    },
  };
  fs.writeFileSync(configFile, YAML.stringify(configWithAuth));
  saveKeyFile(keyFile, { pakeToken: TOKEN_A });
  const result = loadConfig(baseOptions());
  expect(result.connection.authentication.pakeToken).toBe(TOKEN_A);
});

// --- config file errors ------------------------------------------------------

test("throws with ENOENT code when config file is absent", () => {
  saveKeyFile(keyFile, { pakeToken: TOKEN_A });
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

test("throws a UsageError on malformed YAML in config file", () => {
  fs.writeFileSync(configFile, ": {invalid yaml{{");
  saveKeyFile(keyFile, { pakeToken: TOKEN_A });
  // Malformed local config is a usage error (CLI exit 64), not exit 69.
  expect(() => loadConfig(baseOptions())).toThrow(UsageError);
});

test("throws a UsageError when config file fails schema validation", () => {
  fs.writeFileSync(
    configFile,
    YAML.stringify({ connection: { channel: "ftp", server: {} } }),
  );
  saveKeyFile(keyFile, { pakeToken: TOKEN_A });
  expect(() => loadConfig(baseOptions())).toThrow(UsageError);
});

// --- key file errors ---------------------------------------------------------

test("throws a UsageError with 'does not exist' when key file is absent", () => {
  fs.writeFileSync(configFile, YAML.stringify(minimalSFTPConfig));
  // A missing key file is a usage error (exit 64), like a missing config.
  expect(() => loadConfig(baseOptions())).toThrow(UsageError);
  expect(() => loadConfig(baseOptions())).toThrow("does not exist");
});

test("throws a UsageError with 'malformed' when key file contains invalid JSON", () => {
  fs.writeFileSync(configFile, YAML.stringify(minimalSFTPConfig));
  fs.writeFileSync(keyFile, "not-json");
  expect(() => loadConfig(baseOptions())).toThrow(UsageError);
  expect(() => loadConfig(baseOptions())).toThrow("malformed");
});

test("throws a UsageError with 'malformed' when key file fails schema validation", () => {
  fs.writeFileSync(configFile, YAML.stringify(minimalSFTPConfig));
  fs.writeFileSync(keyFile, JSON.stringify({ pakeToken: "" }));
  expect(() => loadConfig(baseOptions())).toThrow(UsageError);
  expect(() => loadConfig(baseOptions())).toThrow("malformed");
});

test("throws a UsageError with 'malformed' when key file token is wrong length", () => {
  fs.writeFileSync(configFile, YAML.stringify(minimalSFTPConfig));
  fs.writeFileSync(keyFile, JSON.stringify({ pakeToken: "tooshort" }));
  expect(() => loadConfig(baseOptions())).toThrow(UsageError);
  expect(() => loadConfig(baseOptions())).toThrow("malformed");
});

// --- CLI overrides -----------------------------------------------------------

test("applies serverPort override to the connection", () => {
  fs.writeFileSync(configFile, YAML.stringify(minimalSFTPConfig));
  saveKeyFile(keyFile, { pakeToken: TOKEN_A });
  const result = loadConfig({ ...baseOptions(), serverPort: 2222 });
  if (result.connection.channel !== "sftp") return;
  expect(result.connection.server.port).toBe(2222);
});

test("applies peerTimeout override and converts to milliseconds", () => {
  fs.writeFileSync(configFile, YAML.stringify(minimalSFTPConfig));
  saveKeyFile(keyFile, { pakeToken: TOKEN_A });
  const result = loadConfig({ ...baseOptions(), peerTimeout: 60 });
  expect(result.connection.options?.peerTimeoutMs).toBe(60_000);
});

// --- filedrop channel --------------------------------------------------------

test("filedrop config injects pakeToken from key file", () => {
  fs.writeFileSync(configFile, YAML.stringify(minimalFiledropConfig));
  saveKeyFile(keyFile, { pakeToken: TOKEN_A });
  const result = loadConfig(baseOptions());
  expect(result.connection.channel).toBe("filedrop");
  expect(result.connection.authentication.pakeToken).toBe(TOKEN_A);
  expect(result.connection.authentication.keyFilePath).toBe(keyFile);
});

test("filedrop config throws a UsageError when key file is absent", () => {
  fs.writeFileSync(configFile, YAML.stringify(minimalFiledropConfig));
  expect(() => loadConfig(baseOptions())).toThrow(UsageError);
  expect(() => loadConfig(baseOptions())).toThrow("does not exist");
});

// --- config warnings ---------------------------------------------------------
// These tests exercise the branches that emit a warning when pake_token,
// pakeToken, expires, or role appear in psilink.yaml. The tests verify both
// the warning text (via the mocked logger) and the observable invariant that
// key-file values always win. The check runs before schema parsing so any
// token format (valid or not) triggers the warning rather than a ZodError.

test("pakeToken set in YAML config does not override the key file token", () => {
  const configWithToken = {
    ...minimalSFTPConfig,
    connection: {
      ...minimalSFTPConfig.connection,
      authentication: {
        pake_token: TOKEN_A,
      },
    },
  };
  fs.writeFileSync(configFile, YAML.stringify(configWithToken));
  saveKeyFile(keyFile, { pakeToken: TOKEN_B });
  const result = loadConfig(baseOptions());
  expect(result.connection.authentication.pakeToken).toBe(TOKEN_B);
  expect(
    mockState.warnings.some((m) =>
      m.includes("connection.authentication.pake_token is set"),
    ),
  ).toBe(true);
});

test("camelCase pakeToken in YAML config does not override the key file token", () => {
  // Exercises the a["pakeToken"] branch (camelCase, as opposed to a["pake_token"]).
  // A user who writes `pakeToken: foo` directly in psilink.yaml hits this path.
  const configWithCamelToken = {
    ...minimalSFTPConfig,
    connection: {
      ...minimalSFTPConfig.connection,
      authentication: {
        pakeToken: TOKEN_A,
      },
    },
  };
  fs.writeFileSync(configFile, YAML.stringify(configWithCamelToken));
  saveKeyFile(keyFile, { pakeToken: TOKEN_B });
  const result = loadConfig(baseOptions());
  expect(result.connection.authentication.pakeToken).toBe(TOKEN_B);
  expect(
    mockState.warnings.some((m) =>
      m.includes("connection.authentication.pakeToken is set"),
    ),
  ).toBe(true);
});

test("expires set in YAML config does not override the key file expiry", () => {
  const configWithExpires = {
    ...minimalSFTPConfig,
    connection: {
      ...minimalSFTPConfig.connection,
      authentication: { expires: "2099-01-01T00:00:00.000Z" },
    },
  };
  fs.writeFileSync(configFile, YAML.stringify(configWithExpires));
  saveKeyFile(keyFile, {
    pakeToken: TOKEN_A,
    expires: "2030-01-01T00:00:00.000Z",
  });
  const result = loadConfig(baseOptions());
  expect(result.connection.authentication.expires).toBe(
    "2030-01-01T00:00:00.000Z",
  );
  expect(
    mockState.warnings.some((m) =>
      m.includes("connection.authentication.expires is set"),
    ),
  ).toBe(true);
});

test("an unknown authentication field in YAML config is dropped with a generic warning", () => {
  // Covers the strip-and-warn branch for fields not in the specific-hint list
  // (typos like `expires_at`, unknown keys like `pakeTok`). The user must see
  // a warning rather than the field being silently dropped by Zod.
  const configWithUnknown = {
    ...minimalSFTPConfig,
    connection: {
      ...minimalSFTPConfig.connection,
      authentication: { expires_at: "2099-01-01T00:00:00.000Z" },
    },
  };
  fs.writeFileSync(configFile, YAML.stringify(configWithUnknown));
  saveKeyFile(keyFile, { pakeToken: TOKEN_A });
  const result = loadConfig(baseOptions());
  expect(result.connection.authentication.pakeToken).toBe(TOKEN_A);
  expect(
    mockState.warnings.some((m) =>
      m.includes("connection.authentication.expires_at is not"),
    ),
  ).toBe(true);
});

test("authentication.role in YAML config is ignored and does not cause a ZodError", () => {
  // `role` is only valid for WebRTC; for sftp/filedrop it is silently
  // stripped by Zod but the user receives no warning without the explicit
  // check in loadConfig. This test verifies the strip succeeds and the key
  // file token still wins.
  const configWithRole = {
    ...minimalSFTPConfig,
    connection: {
      ...minimalSFTPConfig.connection,
      authentication: { role: "inviter" },
    },
  };
  fs.writeFileSync(configFile, YAML.stringify(configWithRole));
  saveKeyFile(keyFile, { pakeToken: TOKEN_A });
  const result = loadConfig(baseOptions());
  expect(result.connection.authentication.pakeToken).toBe(TOKEN_A);
  expect(
    (result.connection.authentication as unknown as Record<string, unknown>)[
      "role"
    ],
  ).toBeUndefined();
  expect(
    mockState.warnings.some((m) =>
      m.includes("connection.authentication.role is set"),
    ),
  ).toBe(true);
});

// --- webrtc channel ----------------------------------------------------------

test("webrtc config throws a UsageError 'not yet supported'", () => {
  fs.writeFileSync(
    configFile,
    YAML.stringify({
      connection: { channel: "webrtc", server: { host: "api.peerjs.com" } },
      linkageTerms: minimalLinkageTerms,
    }),
  );
  // An unsupported channel is invalid caller config (exit 64), not exit 69.
  expect(() => loadConfig(baseOptions())).toThrow(UsageError);
  expect(() => loadConfig(baseOptions())).toThrow("not yet supported");
});
