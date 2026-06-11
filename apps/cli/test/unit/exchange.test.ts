import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Arguments } from "yargs";
import YAML from "yaml";
import { UsageError } from "@psilink/core";
import { getLogger } from "@psilink/core";
import { saveKeyFile } from "../../src/keyFile";
import {
  handler,
  loadConfig,
  warnAndStripInjectedAuthFields,
} from "../../src/commands/exchange";

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

// 43-char base64url tokens satisfying the sharedSecret format constraint.
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

test("returns connection and injects sharedSecret from key file", () => {
  fs.writeFileSync(configFile, YAML.stringify(minimalSFTPConfig));
  saveKeyFile(keyFile, { sharedSecret: TOKEN_A });
  const result = loadConfig(baseOptions());
  expect(result.connection.channel).toBe("sftp");
  expect(result.authentication.sharedSecret).toBe(TOKEN_A);
  expect(result.authentication.keyFilePath).toBe(keyFile);
});

test("injects expires from key file when present", () => {
  fs.writeFileSync(configFile, YAML.stringify(minimalSFTPConfig));
  saveKeyFile(keyFile, {
    sharedSecret: TOKEN_A,
    expires: "2030-01-01T00:00:00.000Z",
  });
  const result = loadConfig(baseOptions());
  expect(result.authentication.expires).toBe("2030-01-01T00:00:00.000Z");
});

test("injects sharedSecret from key file even when a top-level authentication block is present in config", () => {
  // A top-level authentication block in psilink.yaml carries no injected fields
  // (those come from the key file); an empty one must not break loading.
  const configWithAuth = {
    ...minimalSFTPConfig,
    authentication: {},
  };
  fs.writeFileSync(configFile, YAML.stringify(configWithAuth));
  saveKeyFile(keyFile, { sharedSecret: TOKEN_A });
  const result = loadConfig(baseOptions());
  expect(result.authentication.sharedSecret).toBe(TOKEN_A);
});

// --- config file errors ------------------------------------------------------

test("throws with ENOENT code when config file is absent", () => {
  saveKeyFile(keyFile, { sharedSecret: TOKEN_A });
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
  saveKeyFile(keyFile, { sharedSecret: TOKEN_A });
  // Malformed local config is a usage error (CLI exit 64), not exit 69.
  expect(() => loadConfig(baseOptions())).toThrow(UsageError);
});

test("throws a UsageError when config file fails schema validation", () => {
  fs.writeFileSync(
    configFile,
    YAML.stringify({ connection: { channel: "ftp", server: {} } }),
  );
  saveKeyFile(keyFile, { sharedSecret: TOKEN_A });
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
  fs.writeFileSync(keyFile, JSON.stringify({ sharedSecret: "" }));
  expect(() => loadConfig(baseOptions())).toThrow(UsageError);
  expect(() => loadConfig(baseOptions())).toThrow("malformed");
});

test("throws a UsageError with 'malformed' when key file token is wrong length", () => {
  fs.writeFileSync(configFile, YAML.stringify(minimalSFTPConfig));
  fs.writeFileSync(keyFile, JSON.stringify({ sharedSecret: "tooshort" }));
  expect(() => loadConfig(baseOptions())).toThrow(UsageError);
  expect(() => loadConfig(baseOptions())).toThrow("malformed");
});

// --- CLI overrides -----------------------------------------------------------

test("applies serverPort override to the connection", () => {
  fs.writeFileSync(configFile, YAML.stringify(minimalSFTPConfig));
  saveKeyFile(keyFile, { sharedSecret: TOKEN_A });
  const result = loadConfig({ ...baseOptions(), serverPort: 2222 });
  if (result.connection.channel !== "sftp") return;
  expect(result.connection.server.port).toBe(2222);
});

test("applies peerTimeout override and converts to milliseconds", () => {
  fs.writeFileSync(configFile, YAML.stringify(minimalSFTPConfig));
  saveKeyFile(keyFile, { sharedSecret: TOKEN_A });
  const result = loadConfig({ ...baseOptions(), peerTimeout: 60 });
  expect(result.connection.options?.peerTimeoutMs).toBe(60_000);
});

// --- filedrop channel --------------------------------------------------------

test("filedrop config injects sharedSecret from key file", () => {
  fs.writeFileSync(configFile, YAML.stringify(minimalFiledropConfig));
  saveKeyFile(keyFile, { sharedSecret: TOKEN_A });
  const result = loadConfig(baseOptions());
  expect(result.connection.channel).toBe("filedrop");
  expect(result.authentication.sharedSecret).toBe(TOKEN_A);
  expect(result.authentication.keyFilePath).toBe(keyFile);
});

test("filedrop config throws a UsageError when key file is absent", () => {
  fs.writeFileSync(configFile, YAML.stringify(minimalFiledropConfig));
  expect(() => loadConfig(baseOptions())).toThrow(UsageError);
  expect(() => loadConfig(baseOptions())).toThrow("does not exist");
});

// --- config warnings ---------------------------------------------------------
// These tests exercise the warn-and-strip on the top-level authentication block:
// a warning when an injected field (shared_secret/sharedSecret, expires) appears
// in psilink.yaml, the invariant that the key-file value always wins, and that an
// operator-policy (non-injected) field is admitted through. The check runs before
// schema parsing so any token format (valid or not) triggers the warning rather
// than a ZodError.

test("shared_secret set in the top-level authentication block does not override the key file token", () => {
  const configWithToken = {
    ...minimalSFTPConfig,
    authentication: { shared_secret: TOKEN_A },
  };
  fs.writeFileSync(configFile, YAML.stringify(configWithToken));
  saveKeyFile(keyFile, { sharedSecret: TOKEN_B });
  const result = loadConfig(baseOptions());
  expect(result.authentication.sharedSecret).toBe(TOKEN_B);
  expect(
    mockState.warnings.some((m) =>
      m.includes("authentication.shared_secret is set"),
    ),
  ).toBe(true);
});

test("camelCase sharedSecret in the top-level authentication block does not override the key file token", () => {
  // Exercises the camelCase spelling (sharedSecret, as opposed to shared_secret).
  // A user who writes `sharedSecret: foo` directly in psilink.yaml hits this path.
  const configWithCamelToken = {
    ...minimalSFTPConfig,
    authentication: { sharedSecret: TOKEN_A },
  };
  fs.writeFileSync(configFile, YAML.stringify(configWithCamelToken));
  saveKeyFile(keyFile, { sharedSecret: TOKEN_B });
  const result = loadConfig(baseOptions());
  expect(result.authentication.sharedSecret).toBe(TOKEN_B);
  expect(
    mockState.warnings.some((m) =>
      m.includes("authentication.sharedSecret is set"),
    ),
  ).toBe(true);
});

test("expires set in the top-level authentication block does not override the key file expiry", () => {
  const configWithExpires = {
    ...minimalSFTPConfig,
    authentication: { expires: "2099-01-01T00:00:00.000Z" },
  };
  fs.writeFileSync(configFile, YAML.stringify(configWithExpires));
  saveKeyFile(keyFile, {
    sharedSecret: TOKEN_A,
    expires: "2030-01-01T00:00:00.000Z",
  });
  const result = loadConfig(baseOptions());
  expect(result.authentication.expires).toBe("2030-01-01T00:00:00.000Z");
  expect(
    mockState.warnings.some((m) => m.includes("authentication.expires is set")),
  ).toBe(true);
});

test("warnAndStripInjectedAuthFields admits an operator-policy field and warns on nothing", () => {
  // An operator-policy field (a future token_max_age_days lands here) is NOT an
  // injected field, so the loader must leave it untouched -- no strip, no warning
  // -- and let schema validation decide its fate. Tested at the strip helper
  // because no policy field exists in the schema yet for an end-to-end check:
  // AuthenticationSchema is a plain z.object today, so it would strip this field
  // at parse time, and this assertion covers only the loader's strip step, not
  // the full loadConfig path. When the first policy field is added to
  // AuthenticationSchema, add an end-to-end loadConfig test asserting it reaches
  // result.authentication, rather than relying on this helper-level check.
  const log = getLogger("test");
  const rawAuth: Record<string, unknown> = { token_max_age_days: 30 };
  warnAndStripInjectedAuthFields(rawAuth, configFile, log);
  expect(rawAuth.token_max_age_days).toBe(30);
  expect(mockState.warnings).toHaveLength(0);
});

test("warnAndStripInjectedAuthFields strips injected fields but keeps a policy field beside them", () => {
  const log = getLogger("test");
  const rawAuth: Record<string, unknown> = {
    shared_secret: TOKEN_A,
    expires: "2099-01-01T00:00:00.000Z",
    token_max_age_days: 30,
  };
  warnAndStripInjectedAuthFields(rawAuth, configFile, log);
  expect(rawAuth.shared_secret).toBeUndefined();
  expect(rawAuth.expires).toBeUndefined();
  expect(rawAuth.token_max_age_days).toBe(30);
  expect(mockState.warnings).toHaveLength(2);
});

test("an authentication block placed under connection is ignored", () => {
  // The old (pre-refactor) location: authentication nested under connection is no
  // longer part of the connection schema, so Zod strips it silently and the key
  // file token still provides the secret. No warning is emitted (the loader only
  // inspects the top-level block).
  const configWithMisplacedAuth = {
    ...minimalSFTPConfig,
    connection: {
      ...minimalSFTPConfig.connection,
      authentication: { shared_secret: TOKEN_A },
    },
  };
  fs.writeFileSync(configFile, YAML.stringify(configWithMisplacedAuth));
  saveKeyFile(keyFile, { sharedSecret: TOKEN_B });
  const result = loadConfig(baseOptions());
  expect(result.authentication.sharedSecret).toBe(TOKEN_B);
  expect(
    mockState.warnings.some((m) => m.includes("shared_secret is set")),
  ).toBe(false);
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

// --- handler: repeated single-value flag -------------------------------------

test("handler: a repeated single-value flag exits 64 naming the flag", async () => {
  // parseArgs reads every option before the logger exists; a repeated flag
  // (here --server-port, a number) raises a UsageError that the handler reports
  // on stderr and maps to exit 64, rather than letting the array reach the
  // connection overrides as if it were a scalar port.
  const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
    code?: number,
  ) => {
    throw new Error(`exit:${code ?? 0}`);
  }) as never);
  try {
    await expect(
      handler({
        _: [],
        $0: "psilink",
        input: "x.csv",
        "server-port": [2222, 2223],
        "log-level": "silent",
      } as unknown as Arguments),
    ).rejects.toThrow("exit:64");
    expect(errSpy).toHaveBeenCalledWith("--server-port may be given only once");
  } finally {
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
});

test("handler: an unrecognized log-level exits 64, not the top-level dump", async () => {
  // An unrecognized log-level is invalid caller input (exit 64), the same
  // classification the shared parseCommonBootstrapArgs gives invite/accept, so
  // the typo gets a clean usage error rather than escaping to the noisy
  // top-level handler.
  const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
    code?: number,
  ) => {
    throw new Error(`exit:${code ?? 0}`);
  }) as never);
  try {
    await expect(
      handler({
        _: [],
        $0: "psilink",
        input: "x.csv",
        "log-level": "bogus",
      } as unknown as Arguments),
    ).rejects.toThrow("exit:64");
    expect(errSpy).toHaveBeenCalledWith("unrecognized log-level: bogus");
  } finally {
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
});
