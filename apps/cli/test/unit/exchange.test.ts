import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import yargs, { type Arguments } from "yargs";
import YAML from "yaml";
import { UsageError } from "@psilink/core";
import { getLogger } from "@psilink/core";
import type { LinkageTerms } from "@psilink/core";
import { saveKeyFile } from "../../src/keyFile";
import { runProtocol } from "../../src/protocol";
import {
  builder,
  handler,
  loadConfig,
  prepareDataset,
  warnAndStripInjectedAuthFields,
  shouldWarnTokenExpiring,
  tokenExpiringAdvisory,
  warnThresholdDaysForPolicy,
  EXPIRY_WARN_THRESHOLD_DIVISOR,
} from "../../src/commands/exchange";
import { ttyStream, withStdin } from "../stdinStream";

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
    // Stub prepareForExchange so the handler tests below reach the post-exchange
    // advisory without the PSI stack or data-shape fragility. loadCSVFile stays
    // real so it consumes the input stream (a mock would leave a dangling
    // createReadStream whose async open races the afterEach cleanup). Only the
    // handler tests exercise this path; loadConfig never calls it.
    prepareForExchange: vi.fn().mockReturnValue({ warnings: [] }),
  };
});

// Mock runProtocol so the handler tests drive the exchange outcome (resolve =
// success, reject = failed exchange) deterministically, without opening a real
// connection. protocol.test.ts covers the real runProtocol.
vi.mock("../../src/protocol", () => ({ runProtocol: vi.fn() }));

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

// --- builder help overrides --------------------------------------------------

test("builder: exchange's command-specific option help reaches the rendered help", async () => {
  // The describe-override map exchange passes to addCommonBootstrapOptions must
  // actually reach the rendered help. A stale/typo'd key -- or a shared option
  // that stops reading its override -- would silently fall back to the
  // invite/accept URL/write-oriented default, with no other test catching it.
  // Whitespace is normalized so a help line wrapped by yargs still matches.
  const help = (await builder(yargs([])).getHelp()).replace(/\s+/g, " ");
  expect(help).toContain("exchange configuration file");
  expect(help).toContain("overrides connection.server.port in config");
  // The URL/write-oriented defaults must NOT appear: exchange reads a config and
  // has no URL, so their presence would mean an override was dropped.
  expect(help).not.toContain("overrides the port in URL");
  expect(help).not.toContain("where to write psilink.yaml");
});

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

// A YAML parse failure embeds a snippet of the offending source in its message,
// which can carry an inline credential; loadConfig must report only the path.
// Mirrors the accept-side guard in accept.test.ts ("validateAccept: a
// malformed-YAML config does not echo an inline credential"). Two distinct parse
// failures reach the catch by different routes: a syntax error throws a
// YAMLParseError that reproduces the malformed line, while an unresolved alias
// throws a plain ReferenceError (not a YAMLError) that echoes the alias name --
// the path-only guard must close both.
test.each([
  [
    "syntax error (tab indentation on a password line)",
    (secret: string) =>
      `connection:\n  channel: sftp\n  server:\n\t  password: ${secret}\n`,
  ],
  [
    "unresolved alias naming the credential",
    (secret: string) =>
      `connection:\n  channel: sftp\n  server:\n    password: *${secret}\n`,
  ],
])(
  "a malformed-YAML config does not echo an inline credential: %s",
  (_, mk) => {
    const SECRET = "S3cr3tSFTPPassw0rd";
    fs.writeFileSync(configFile, mk(SECRET));
    saveKeyFile(keyFile, { sharedSecret: TOKEN_A });
    let caught: unknown;
    try {
      loadConfig(baseOptions());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UsageError);
    // Still a usage error pointing the operator at the config path to fix.
    expect((caught as Error).message).toContain(configFile);
    expect((caught as Error).message).toContain("could not be parsed as YAML");
    // The credential must not appear anywhere in the surfaced message.
    expect((caught as Error).message).not.toContain(SECRET);
  },
);

test("throws a UsageError when config file fails schema validation", () => {
  fs.writeFileSync(
    configFile,
    YAML.stringify({ connection: { channel: "ftp", server: {} } }),
  );
  saveKeyFile(keyFile, { sharedSecret: TOKEN_A });
  expect(() => loadConfig(baseOptions())).toThrow(UsageError);
});

test("a schema-invalid config renders readably, not as a raw ZodError blob", () => {
  // Well-formed YAML that fails schema validation (bad channel, missing
  // linkageTerms): the embedded detail must be the describeDecodeError one-liner
  // (`<path>: <message>` with an `(and N more)` suffix), not Zod's multi-line
  // JSON dump of every issue.
  fs.writeFileSync(
    configFile,
    YAML.stringify({ connection: { channel: "ftp", server: {} } }),
  );
  saveKeyFile(keyFile, { sharedSecret: TOKEN_A });
  let message = "";
  try {
    loadConfig(baseOptions());
  } catch (err) {
    message = (err as Error).message;
  }
  // The surrounding UsageError wrapper text is preserved.
  expect(message).toContain("is not a valid exchange spec");
  // The readable `<path>: <message>` form appears, with the multi-issue suffix.
  expect(message).toMatch(/connection\.channel: /);
  expect(message).toContain("(and 1 more)");
  // The raw multi-line ZodError JSON blob does not: no newlines, no JSON keys.
  expect(message).not.toContain("\n");
  expect(message).not.toContain('"code"');
});

test("throws a UsageError at config load when a preserved @path credential file is missing", () => {
  // A saved config keeps the @path reference, not the secret; the reference is
  // resolved when the config loads, before any network activity. A moved or
  // deleted file therefore fails the next exchange here, with a usage error
  // (exit 64) naming the reference -- the documented failure for a stale @path.
  const missing = path.join(dir, "no-such-secret");
  fs.writeFileSync(
    configFile,
    YAML.stringify({
      connection: {
        channel: "sftp",
        server: { host: "sftp.example.org", password: `@${missing}` },
      },
      linkage_terms: minimalLinkageTerms,
    }),
  );
  saveKeyFile(keyFile, { sharedSecret: TOKEN_A });
  expect(() => loadConfig(baseOptions())).toThrow(UsageError);
  expect(() => loadConfig(baseOptions())).toThrow("@-file reference");
  // The missing credential file is surfaced as a credential-access failure, not
  // re-wrapped as an "invalid exchange spec" (a schema error it is not).
  let message = "";
  try {
    loadConfig(baseOptions());
  } catch (err) {
    message = (err as Error).message;
  }
  expect(message).not.toContain("is not a valid exchange spec");
});

// --- key file errors ---------------------------------------------------------

test("throws a UsageError with 'does not exist' when key file is absent", () => {
  fs.writeFileSync(configFile, YAML.stringify(minimalSFTPConfig));
  // A missing key file is a usage error (exit 64), like a missing config.
  expect(() => loadConfig(baseOptions())).toThrow(UsageError);
  expect(() => loadConfig(baseOptions())).toThrow("does not exist");
});

test("throws a UsageError when key file contains invalid JSON", () => {
  fs.writeFileSync(configFile, YAML.stringify(minimalSFTPConfig));
  fs.writeFileSync(keyFile, "not-json");
  expect(() => loadConfig(baseOptions())).toThrow(UsageError);
  expect(() => loadConfig(baseOptions())).toThrow(
    "could not be parsed as JSON",
  );
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
  expect(
    tokenExpiringAdvisory("ok", keyFile, ADVISORY_NOW, 10),
  ).toBeUndefined();
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

test("handler: `-` input at an interactive terminal exits 64 (usage), not 69", async () => {
  // openInputSource raises a UsageError for `-` at a TTY with nothing piped; the
  // prepareDataset catch must map that to exit 64 (usage), not collapse it to the
  // default 69 (transport). A valid config and key let the handler reach
  // prepareDataset, where the `-` is resolved.
  fs.writeFileSync(configFile, YAML.stringify(minimalFiledropConfig));
  saveKeyFile(keyFile, { sharedSecret: TOKEN_A });
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
    code?: number,
  ) => {
    throw new Error(`exit:${code ?? 0}`);
  }) as never);
  try {
    await withStdin(ttyStream(), () =>
      expect(
        handler({
          _: [],
          $0: "psilink",
          input: "-",
          "config-file": configFile,
          "key-file": keyFile,
          "log-level": "silent",
        } as unknown as Arguments),
      ).rejects.toThrow("exit:64"),
    );
  } finally {
    exitSpy.mockRestore();
  }
});

// --- handler: token-expiry advisory emission (wiring) ------------------------
// These drive the handler through to the post-exchange advisory block, with
// runProtocol mocked to control the exchange outcome. They cover the wiring the
// pure-helper unit tests cannot: that the handler captures the exchange error
// rather than exiting immediately, calls the advisory builder, and routes its
// result to log.warn -- on both the failure and success paths.

test("handler warns when an expiring-soon token is not refreshed by a failed exchange", async () => {
  // ~1 day of remaining lifetime; with token_max_age_days 30 the warn threshold is
  // 10 days, so the token is expiring-soon at load. runProtocol rejects, so no
  // rotation refreshes the key file and the advisory must fire before the exit.
  const soon = new Date(Date.now() + 86_400_000).toISOString();
  fs.writeFileSync(
    configFile,
    YAML.stringify({
      ...minimalFiledropConfig,
      authentication: { token_max_age_days: 30 },
    }),
  );
  saveKeyFile(keyFile, { sharedSecret: TOKEN_A, expires: soon });
  const input = path.join(dir, "in.csv");
  fs.writeFileSync(input, "ssn\n123456789\n");

  vi.mocked(runProtocol).mockReset();
  vi.mocked(runProtocol).mockRejectedValueOnce(new Error("exchange failed"));
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
        input,
        "config-file": configFile,
        "key-file": keyFile,
        "log-level": "silent",
      } as unknown as Arguments),
    ).rejects.toThrow("exit:69");
    expect(mockState.warnings.some((m) => m.includes("is expiring soon"))).toBe(
      true,
    );
  } finally {
    exitSpy.mockRestore();
  }
});

test("handler suppresses the advisory when a successful exchange refreshes the token", async () => {
  // Same expiring-soon token, but runProtocol resolves AND rotates -- the mock
  // rewrites the key file with a fresh, farther-out expiry, as a real rotation
  // would -- so the post-exchange re-read is no longer expiring soon and no
  // advisory fires (and the handler returns without exiting).
  const soon = new Date(Date.now() + 86_400_000).toISOString();
  fs.writeFileSync(
    configFile,
    YAML.stringify({
      ...minimalFiledropConfig,
      authentication: { token_max_age_days: 30 },
    }),
  );
  saveKeyFile(keyFile, { sharedSecret: TOKEN_A, expires: soon });
  const input = path.join(dir, "in.csv");
  fs.writeFileSync(input, "ssn\n123456789\n");

  vi.mocked(runProtocol).mockReset();
  vi.mocked(runProtocol).mockImplementationOnce(async () => {
    saveKeyFile(keyFile, {
      sharedSecret: TOKEN_B,
      expires: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });
    return {};
  });
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
    code?: number,
  ) => {
    throw new Error(`exit:${code ?? 0}`);
  }) as never);
  try {
    await handler({
      _: [],
      $0: "psilink",
      input,
      "config-file": configFile,
      "key-file": keyFile,
      "log-level": "silent",
    } as unknown as Arguments);
    expect(mockState.warnings.some((m) => m.includes("is expiring soon"))).toBe(
      false,
    );
    expect(exitSpy).not.toHaveBeenCalled();
  } finally {
    exitSpy.mockRestore();
  }
});

// --- prepareDataset: linkage satisfiability pre-flight -----------------------
// The recurring `exchange` path runs a committed config whose CSV is decoupled
// from any CSV seen at accept time, so prepareDataset gates the run against the
// config's linkage terms before preparing the dataset: block when the CSV can
// satisfy no key, warn-and-proceed when it satisfies only some. prepareForExchange
// stays mocked (see the top-of-file mock), so these assert the gate, not the prep.

// ssn key only: a CSV with no ssn-typed column satisfies nothing.
const ssnOnlyTerms: LinkageTerms = {
  version: "1.0.0",
  identity: "Test Party",
  date: "2025-01-01",
  algorithm: "psi",
  output: { expectsOutput: true, shareWithPartner: false },
  deduplicate: false,
  linkageFields: [{ name: "ssn", type: "ssn" }],
  linkageKeys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
};

// An ssn key plus a last-name+dob key: a CSV with only last_name+dob satisfies
// the latter but not the former.
const ssnAndNameDobTerms: LinkageTerms = {
  ...ssnOnlyTerms,
  linkageFields: [
    { name: "ssn", type: "ssn" },
    { name: "last_name", type: "lastName" },
    { name: "dob", type: "dateOfBirth" },
  ],
  linkageKeys: [
    { name: "SSN", elements: [{ field: "ssn" }] },
    { name: "NAME_DOB", elements: [{ field: "last_name" }, { field: "dob" }] },
  ],
};

function writeInput(contents: string): string {
  const input = path.join(dir, "in.csv");
  fs.writeFileSync(input, contents);
  return input;
}

test("prepareDataset: blocks (UsageError) naming the field when the CSV satisfies no linkage key", async () => {
  // A first_name-only CSV cannot produce the ssn field the lone key needs, so the
  // run must stop with a usage error rather than reach a silent empty exchange.
  const input = writeInput("first_name\nAda\n");
  const err = await prepareDataset(
    { linkageTerms: ssnOnlyTerms },
    "Test Party",
    input,
  ).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(UsageError);
  expect((err as Error).message).toMatch(
    /cannot satisfy any of the configuration's linkage keys/,
  );
  expect((err as Error).message).toContain("ssn (ssn)");
});

test("prepareDataset: warns naming the unsatisfied field and proceeds when only some keys are satisfiable", async () => {
  // last_name+dob satisfy the NAME_DOB key but not the SSN key, so prepareDataset
  // warns (naming ssn) and proceeds to prepareForExchange rather than blocking.
  const input = writeInput("last_name,dob\nLovelace,1815-12-10\n");
  const prepared = await prepareDataset(
    { linkageTerms: ssnAndNameDobTerms },
    "Test Party",
    input,
  );
  expect(prepared).toBeDefined();
  expect(
    mockState.warnings.some(
      (m) =>
        m.includes(
          "cannot satisfy all of the configuration's linkage fields",
        ) && m.includes("ssn (ssn)"),
    ),
  ).toBe(true);
});

test("prepareDataset: an explicit standardization remap satisfies a field the column type alone would not", async () => {
  // ssn_source does not infer to the ssn type, so without standardization the ssn
  // key is unsatisfiable and the run blocks...
  const input = writeInput("ssn_source\n123456789\n");
  await expect(
    prepareDataset({ linkageTerms: ssnOnlyTerms }, "Test Party", input),
  ).rejects.toThrow(/cannot satisfy any of the configuration's linkage keys/);

  // ...but a remap binding ssn <- ssn_source makes the field producible, so the
  // same CSV proceeds with no block and no warning. This is the exchange-path
  // wrinkle accept does not have: a committed config can carry a column remap.
  const prepared = await prepareDataset(
    {
      linkageTerms: ssnOnlyTerms,
      standardization: [{ output: "ssn", input: "ssn_source" }],
    },
    "Test Party",
    input,
  );
  expect(prepared).toBeDefined();
  expect(mockState.warnings).toHaveLength(0);
});

test("prepareDataset: an explicit metadata type satisfies a column whose name does not infer to that type", async () => {
  // patient_number does not infer to the ssn type, so without metadata the ssn key
  // is unsatisfiable and the run blocks...
  const input = writeInput("patient_number\n123456789\n");
  await expect(
    prepareDataset({ linkageTerms: ssnOnlyTerms }, "Test Party", input),
  ).rejects.toThrow(/cannot satisfy any of the configuration's linkage keys/);

  // ...but the config's explicit metadata types patient_number as ssn, exactly as
  // the exchange will, so the same CSV proceeds with no block and no warning. The
  // check must honor the config's metadata, not name inference alone.
  const prepared = await prepareDataset(
    {
      linkageTerms: ssnOnlyTerms,
      metadata: [
        {
          name: "patient_number",
          type: "ssn",
          role: "linkage",
          isPayload: false,
        },
      ],
    },
    "Test Party",
    input,
  );
  expect(prepared).toBeDefined();
  expect(mockState.warnings).toHaveLength(0);
});

test("prepareDataset: an explicit metadata type that retypes the column away blocks the silent-empty run", async () => {
  // The column name `ssn` would infer to the ssn type, but the config's metadata
  // retypes it to a non-ssn type, so at exchange time the ssn field produces no
  // values and the key silently collapses to an empty result. Honoring the config's
  // metadata, the guard sees no ssn-typed column and blocks rather than letting that
  // silent-empty run through -- the exact gap name inference alone would miss.
  const input = writeInput("ssn\n123456789\n");
  await expect(
    prepareDataset(
      {
        linkageTerms: ssnOnlyTerms,
        metadata: [
          { name: "ssn", type: "other", role: "payload", isPayload: true },
        ],
      },
      "Test Party",
      input,
    ),
  ).rejects.toThrow(/cannot satisfy any of the configuration's linkage keys/);
});
