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
  shouldWarnTokenExpiring,
  tokenExpiringAdvisory,
  warnThresholdDaysForPolicy,
  EXPIRY_WARN_THRESHOLD_DIVISOR,
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
  // An operator-policy field (token_max_age_days) is NOT an injected field, so the
  // loader must leave it untouched -- no strip, no warning -- and let schema
  // validation decide its fate. This is a focused check on the loader's strip
  // step; the end-to-end path (token_max_age_days reaching result.authentication,
  // and a typo being rejected by the strict schema) is covered by the loadConfig
  // tests below.
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

// --- token_max_age_days and load-time expiry ---------------------------------

test("loadConfig surfaces token_max_age_days from the authentication block", () => {
  // End-to-end: a policy field in psilink.yaml reaches result.authentication
  // (camelized), where protocol.ts reads it to stamp the rotated token's expiry.
  const config = {
    ...minimalSFTPConfig,
    authentication: { token_max_age_days: 30 },
  };
  fs.writeFileSync(configFile, YAML.stringify(config));
  saveKeyFile(keyFile, { sharedSecret: TOKEN_A });
  const result = loadConfig(baseOptions());
  expect(result.authentication.tokenMaxAgeDays).toBe(30);
});

test("loadConfig rejects an unrecognized key in the authentication block", () => {
  // The strict schema fails a misspelled policy key as invalid config (UsageError,
  // exit 64) rather than silently dropping it and disabling the control.
  const config = {
    ...minimalSFTPConfig,
    authentication: { token_max_age_dayss: 30 },
  };
  fs.writeFileSync(configFile, YAML.stringify(config));
  saveKeyFile(keyFile, { sharedSecret: TOKEN_A });
  expect(() => loadConfig(baseOptions())).toThrow(UsageError);
  expect(() => loadConfig(baseOptions())).toThrow("not a valid exchange spec");
});

test("loadConfig hard-stops an expired token before any exchange", () => {
  // (c) An `expires` in the past aborts at load time with a re-invite message,
  // before any connection or key exchange. UsageError -> exit 64.
  fs.writeFileSync(configFile, YAML.stringify(minimalSFTPConfig));
  saveKeyFile(keyFile, {
    sharedSecret: TOKEN_A,
    expires: "2020-01-01T00:00:00.000Z",
  });
  expect(() => loadConfig(baseOptions())).toThrow(UsageError);
  expect(() => loadConfig(baseOptions())).toThrow(
    "expired at 2020-01-01T00:00:00.000Z",
  );
});

test("loadConfig accepts a not-yet-expired token", () => {
  // A future expiry is not a load-time error; the expiring-soon advisory (if any)
  // is decided later, in the handler.
  fs.writeFileSync(configFile, YAML.stringify(minimalSFTPConfig));
  saveKeyFile(keyFile, {
    sharedSecret: TOKEN_A,
    expires: "2099-01-01T00:00:00.000Z",
  });
  const result = loadConfig(baseOptions());
  expect(result.authentication.expires).toBe("2099-01-01T00:00:00.000Z");
});

test("warnThresholdDaysForPolicy is token_max_age_days / 3, undefined without a policy", () => {
  expect(EXPIRY_WARN_THRESHOLD_DIVISOR).toBe(3);
  expect(warnThresholdDaysForPolicy(30)).toBe(10);
  expect(warnThresholdDaysForPolicy(90)).toBe(30);
  // A non-multiple of 3 yields a fractional threshold; the downstream millisecond
  // comparison handles it, so no rounding is applied.
  expect(warnThresholdDaysForPolicy(10)).toBeCloseTo(10 / 3);
  // No policy in force -> no threshold, so checkKeyFileExpiry never reports
  // "expiring-soon" and the advisory is suppressed.
  expect(warnThresholdDaysForPolicy(undefined)).toBeUndefined();
});

test("shouldWarnTokenExpiring suppresses the advisory when rotation refreshed the token", () => {
  // (d) Expiring soon at load, refreshed to "ok" by a successful rotation: the
  // new token has a fresh, farther-out expiry, so the advisory would mislead.
  expect(shouldWarnTokenExpiring("expiring-soon", "ok")).toBe(false);
});

test("shouldWarnTokenExpiring warns when rotation did not refresh the token", () => {
  // (e) Expiring soon at load and still not refreshed after the exchange: warn.
  expect(shouldWarnTokenExpiring("expiring-soon", "expiring-soon")).toBe(true);
  // If time elapsed pushed an un-refreshed token to expired, still warn.
  expect(shouldWarnTokenExpiring("expiring-soon", "expired")).toBe(true);
});

test("shouldWarnTokenExpiring never warns when the token was not expiring soon at load", () => {
  expect(shouldWarnTokenExpiring("ok", "ok")).toBe(false);
  expect(shouldWarnTokenExpiring("ok", "expiring-soon")).toBe(false);
  expect(shouldWarnTokenExpiring("ok", "expired")).toBe(false);
});

// --- tokenExpiringAdvisory (handler re-read path) ----------------------------

// A fixed clock so the expiry windows below are deterministic.
const ADVISORY_NOW = Date.parse("2026-01-01T00:00:00.000Z");

test("tokenExpiringAdvisory is silent when the token was not expiring soon at load", () => {
  saveKeyFile(keyFile, { sharedSecret: TOKEN_A });
  expect(tokenExpiringAdvisory("ok", keyFile, ADVISORY_NOW, 10)).toBeUndefined();
});

test("tokenExpiringAdvisory warns with the on-disk expiry when rotation did not refresh the token", () => {
  // (e) Failed exchange: the on-disk token is unchanged and still expiring soon.
  saveKeyFile(keyFile, {
    sharedSecret: TOKEN_A,
    expires: "2026-01-05T00:00:00.000Z",
  });
  const msg = tokenExpiringAdvisory("expiring-soon", keyFile, ADVISORY_NOW, 10);
  expect(msg).toContain("expiring soon");
  expect(msg).toContain("2026-01-05T00:00:00.000Z");
  // The reworded message no longer over-claims a failed-rotation cause.
  expect(msg).not.toContain("did not complete a successful key rotation");
});

test("tokenExpiringAdvisory is silent when rotation refreshed the token", () => {
  // (d) Successful rotation: the re-read token is now past the threshold (30 days
  // out, threshold 10), so the advisory would mislead and is suppressed.
  saveKeyFile(keyFile, {
    sharedSecret: TOKEN_A,
    expires: "2026-01-31T00:00:00.000Z",
  });
  expect(
    tokenExpiringAdvisory("expiring-soon", keyFile, ADVISORY_NOW, 10),
  ).toBeUndefined();
});

test("tokenExpiringAdvisory reports a lapsed token as expired, directing to re-invite", () => {
  // The token expired during the exchange (on-disk expires now in the past) and
  // was not refreshed. The message must not say "run before it expires" -- it
  // already has -- but direct to re-invitation.
  saveKeyFile(keyFile, {
    sharedSecret: TOKEN_A,
    expires: "2025-12-31T00:00:00.000Z",
  });
  const msg = tokenExpiringAdvisory("expiring-soon", keyFile, ADVISORY_NOW, 10);
  expect(msg).toContain("expired at 2025-12-31T00:00:00.000Z");
  expect(msg).toContain("re-invite");
  expect(msg).not.toContain("Run a successful");
});

test("tokenExpiringAdvisory is silent when the key file is absent after the exchange", () => {
  // The file was deleted between rotation and the re-read (ENOENT): the
  // post-exchange state cannot be confirmed, so no advisory is emitted (and no
  // false cause asserted). keyFile is never written here.
  expect(
    tokenExpiringAdvisory("expiring-soon", keyFile, ADVISORY_NOW, 10),
  ).toBeUndefined();
});

test("tokenExpiringAdvisory propagates a read/parse failure rather than swallowing it", () => {
  // A corrupt key file on the re-read is not silently dropped: it throws so the
  // caller can record it (the handler logs it at debug, non-fatally).
  fs.writeFileSync(keyFile, "not-json");
  expect(() =>
    tokenExpiringAdvisory("expiring-soon", keyFile, ADVISORY_NOW, 10),
  ).toThrow();
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
