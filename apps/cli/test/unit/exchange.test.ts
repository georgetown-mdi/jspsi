import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import yargs, { type Arguments } from "yargs";
import YAML from "yaml";
import { UsageError } from "@psilink/core";
import {
  encodeInvitation,
  generateSigningIdentity,
  getDefaultLinkageTerms,
  getLogger,
  prepareForExchange,
  sanitizeErrorForDisplay,
} from "@psilink/core";
import type {
  InvitationToken,
  LinkageTerms,
  PreparedExchange,
} from "@psilink/core";
import {
  loadKeyFile,
  provisionKeyFileFromInvitation,
  saveKeyFile,
} from "../../src/keyFile";
import {
  loadSigningIdentity,
  saveSigningIdentity,
} from "../../src/signingIdentityFile";
import { runProtocol } from "../../src/protocol";
import { PERSISTENCE_LOSS_EXIT_CODE } from "../../src/eventStream";
import { establishHostKeyTrust } from "../../src/hostKeyTrust";
import { confirmOutboundPayloadConsent } from "../../src/outboundPayloadConsent";
import {
  builder,
  handler,
  loadConfig,
  parseArgs,
  prepareDataset,
  warnAndStripInjectedAuthFields,
  shouldWarnTokenExpiring,
  tokenExpiringAdvisory,
  warnThresholdDaysForPolicy,
  EXPIRY_WARN_THRESHOLD_DIVISOR,
} from "../../src/commands/exchange";
import { PLACEHOLDER_IDENTITY } from "../../src/partyIdentity";
import { ttyStream, withStdin } from "../stdinStream";
import { captureProcessExit } from "../exitCapture";
import { ERROR_CLASS_EXIT_CODES } from "../exitCodeCases";

const mockState = vi.hoisted(() => ({
  warnings: [] as string[],
  errors: [] as string[],
}));

vi.mock("@psilink/core", async (importActual) => {
  const actual = await importActual<typeof import("@psilink/core")>();
  return {
    ...actual,
    getLogger: (_name: string) => ({
      info: () => {},
      debug: () => {},
      trace: () => {},
      error: (msg: string, ...args: unknown[]) =>
        mockState.errors.push([msg, ...args.map(String)].join(" ")),
      warn: (msg: string, ...args: unknown[]) =>
        mockState.warnings.push([msg, ...args.map(String)].join(" ")),
    }),
    // Stub prepareForExchange so the handler tests below reach the post-exchange
    // advisory without the PSI stack or data-shape fragility. loadCSVFile stays
    // real so it consumes the input stream (a mock would leave a dangling
    // createReadStream whose async open races the afterEach cleanup). Only the
    // handler tests exercise this path; loadConfig never calls it. The shape
    // carries the empty linkageFields and linkageKeys the value-constraint sweep
    // (warnOnValueConstraints) reads -- it scopes to key-referenced fields, so it
    // walks both -- so the sweep is a no-op here.
    // A FRESH object per call (not a shared mockReturnValue ref), matching the real
    // prepareForExchange: prepareDataset mutates the returned object (it sets
    // expectedPayloadColumns from a committed payload.receive), so a shared ref
    // would leak that field between tests.
    prepareForExchange: vi.fn(
      () =>
        ({
          metadata: [],
          linkageTerms: {
            version: "1.0.0",
            date: "2025-01-01",
            algorithm: "psi",
            linkageStrategy: "cascade",
            output: { expectsOutput: true, shareWithPartner: false },
            deduplicate: false,
            linkageFields: [],
            linkageKeys: [],
          },
          dataset: new actual.StandardizedDataset([], []),
          rawRows: [],
          rowCount: 0,
        }) satisfies PreparedExchange,
    ),
  };
});

// Mock runProtocol so the handler tests drive the exchange outcome (resolve =
// success, reject = failed exchange) deterministically, without opening a real
// connection. protocol.test.ts covers the real runProtocol.
vi.mock("../../src/protocol", () => ({ runProtocol: vi.fn() }));

// First-use host-key trust is a no-op for the filedrop configs the other handler
// tests use, but live for the sftp one the prepare-before-connect ordering test
// drives; stub it so that test reaches the runProtocol hand-off without probing
// sftp.example.org (hostKeyTrust.test.ts covers the real flow).
vi.mock("../../src/hostKeyTrust", () => ({ establishHostKeyTrust: vi.fn() }));

// The invitation provisioning step is spy-WRAPPED so the exit-boundary tests can
// plant an error at it; every other key-file export, and provisioning itself
// wherever nothing is planted, stays real.
vi.mock("../../src/keyFile", async (importActual) => {
  const actual = await importActual<typeof import("../../src/keyFile")>();
  return {
    ...actual,
    provisionKeyFileFromInvitation: vi.fn(
      actual.provisionKeyFileFromInvitation,
    ),
  };
});

// The signing-identity load is spy-WRAPPED for the same reason: the ordering
// test below needs to observe when the handler reaches it, while every test that
// seeds an identity file keeps loading the real one.
vi.mock("../../src/signingIdentityFile", async (importActual) => {
  const actual =
    await importActual<typeof import("../../src/signingIdentityFile")>();
  return { ...actual, loadSigningIdentity: vi.fn(actual.loadSigningIdentity) };
});

// The outbound-consent surface is spy-WRAPPED rather than replaced: the ordering
// test below needs to observe when the handler reaches it, while the
// prepareDataset tests further down keep running the real gate behind it.
vi.mock("../../src/outboundPayloadConsent", async (importActual) => {
  const actual =
    await importActual<typeof import("../../src/outboundPayloadConsent")>();
  return {
    ...actual,
    confirmOutboundPayloadConsent: vi.fn(actual.confirmOutboundPayloadConsent),
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

// A canonical partner pin: 43 unpadded base64url characters, the shape
// SigningConfigSchema admits, so a certificate-mode config carrying it is held up
// by whatever else the run refuses rather than by the pin gate.
const PARTNER_FINGERPRINT = "iWD-ZB69Oz6gOpaX_OoC7sD8ohIZj2lETC9qbl-IbPg";

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
  mockState.errors.length = 0;
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

// --- parseArgs: CLI credential overrides resolved at parse time --------------
// exchange resolves an @path credential flag eagerly in parseArgs: it never
// persists a config, so there is no reference to preserve, and the override is
// layered on AFTER the config-load resolution (resolveExchangeSpecRefs). Without
// this, an @path credential from the flag would reach the live SFTP connection
// unresolved. This pins that seam for each of the three credential siblings the
// eager resolution covers -- the server password, the SSH private key, and its
// passphrase -- so a future edit that broke the @path resolution for any one
// of them is caught.

test("parseArgs resolves an @path server-password to the file contents", () => {
  const passwordRef = path.join(dir, "sftp-password");
  fs.writeFileSync(passwordRef, "S3cr3tSFTPPassw0rd\n");
  const argv = {
    _: [],
    $0: "psilink",
    input: "data.csv",
    "server-password": `@${passwordRef}`,
  } as unknown as Arguments;
  const args = parseArgs(argv);
  expect(args.serverPassword).toBe("S3cr3tSFTPPassw0rd");
});

test("parseArgs carries a literal server-password through unchanged", () => {
  const argv = {
    _: [],
    $0: "psilink",
    input: "data.csv",
    "server-password": "inline-password",
  } as unknown as Arguments;
  const args = parseArgs(argv);
  expect(args.serverPassword).toBe("inline-password");
});

test("parseArgs resolves an @path server-private-key-passphrase and private key to the file contents", () => {
  const keyRef = path.join(dir, "id_ed25519");
  const passRef = path.join(dir, "passphrase");
  fs.writeFileSync(keyRef, "KEYDATA\n");
  fs.writeFileSync(passRef, "unlock-me\n");
  const argv = {
    _: [],
    $0: "psilink",
    input: "data.csv",
    "server-private-key": `@${keyRef}`,
    "server-private-key-passphrase": `@${passRef}`,
  } as unknown as Arguments;
  const args = parseArgs(argv);
  expect(args.serverPrivateKey).toBe("KEYDATA");
  expect(args.serverPrivateKeyPassphrase).toBe("unlock-me");
});

test("parseArgs carries a literal passphrase through unchanged", () => {
  const argv = {
    _: [],
    $0: "psilink",
    input: "data.csv",
    "server-private-key": "inline-key",
    "server-private-key-passphrase": "inline-pass",
  } as unknown as Arguments;
  const args = parseArgs(argv);
  expect(args.serverPrivateKeyPassphrase).toBe("inline-pass");
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

// --- rule-set citation drift -------------------------------------------------

/** A filedrop config carrying `terms`, plus the key file the load needs. */
function writeConfigWithTerms(terms: LinkageTerms): void {
  fs.writeFileSync(
    configFile,
    YAML.stringify({
      connection: { channel: "filedrop", path: "/mnt/share/drop" },
      linkageTerms: terms,
    }),
  );
  saveKeyFile(keyFile, { sharedSecret: TOKEN_A });
}

/** The warnings the load emitted about the rule-set citation. */
function citationWarnings(): string[] {
  return mockState.warnings.filter((w) => w.includes("linkage_rule_set"));
}

test("loadConfig warns on a citation the config's own rules no longer support, and loads anyway", () => {
  // A hand edit to the cascade order leaves the citation the config was written
  // with claiming rules it no longer declares. The warning is the whole remedy:
  // the spec loads and the command proceeds.
  const terms = getDefaultLinkageTerms("Test Party");
  const [first, second, ...rest] = terms.linkageKeys;
  writeConfigWithTerms({ ...terms, linkageKeys: [second!, first!, ...rest] });
  const result = loadConfig(baseOptions());
  expect(result.connection.channel).toBe("filedrop");
  expect(result.authentication.sharedSecret).toBe(TOKEN_A);
  expect(citationWarnings()).toHaveLength(1);
  expect(citationWarnings()[0]).toContain(configFile);
});

test("loadConfig stays silent on a config whose rules still fit its citation", () => {
  writeConfigWithTerms(getDefaultLinkageTerms("Test Party"));
  loadConfig(baseOptions());
  expect(citationWarnings()).toEqual([]);
});

test("loadConfig stays silent on a config carrying no citation", () => {
  const terms = getDefaultLinkageTerms("Test Party");
  const [first, second, ...rest] = terms.linkageKeys;
  delete terms.linkageRuleSet;
  writeConfigWithTerms({ ...terms, linkageKeys: [second!, first!, ...rest] });
  loadConfig(baseOptions());
  expect(citationWarnings()).toEqual([]);
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

// divergesFromAgreedTerms (signingIdentityDivergence.ts) reports no divergence
// when termsIdentity is absent or empty, so assertIdentityMatchesAgreedTerms --
// the exchange path's disposition of it -- lets such a run through. Absent is a
// shape this path reaches: terms may omit the identity, and the silence is right
// there -- no configured name exists for a certificate to diverge from, and a
// run that would sign under one is refused outright before it starts (see the
// certificate-mode gate below). Empty is not, and neither is terms missing
// altogether: the schema refuses both. Pin all three directly, so a schema
// change admitting a blank label -- which divergesFromAgreedTerms reads as
// absence and passes over -- fails here.

test("a config with no linkage_terms is refused, not silently accepted", () => {
  fs.writeFileSync(
    configFile,
    YAML.stringify({ connection: minimalFiledropConfig.connection }),
  );
  saveKeyFile(keyFile, { sharedSecret: TOKEN_A });
  expect(() => loadConfig(baseOptions())).toThrow(UsageError);
  expect(() => loadConfig(baseOptions())).toThrow(
    "is not a valid exchange spec",
  );
});

test("a config with an empty linkage_terms.identity is refused, not silently accepted", () => {
  fs.writeFileSync(
    configFile,
    YAML.stringify({
      ...minimalFiledropConfig,
      linkageTerms: { ...minimalLinkageTerms, identity: "" },
    }),
  );
  saveKeyFile(keyFile, { sharedSecret: TOKEN_A });
  expect(() => loadConfig(baseOptions())).toThrow(UsageError);
  expect(() => loadConfig(baseOptions())).toThrow(
    "is not a valid exchange spec",
  );
});

test("a config whose linkage_terms omit the identity loads, carrying none", () => {
  // The third shape, and the admissible one: the field is optional, so this
  // config is accepted and its terms carry no identity at all -- which is what
  // makes divergesFromAgreedTerms's absent branch reachable rather than dead.
  // Nothing stands a label in it.
  const { identity: _named, ...unnamedTerms } = minimalLinkageTerms;
  fs.writeFileSync(
    configFile,
    YAML.stringify({ ...minimalFiledropConfig, linkageTerms: unnamedTerms }),
  );
  saveKeyFile(keyFile, { sharedSecret: TOKEN_A });
  const loaded = loadConfig(baseOptions());
  expect(loaded.linkageTerms?.identity).toBeUndefined();
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

// --- connection_per_poll ignored-warning -------------------------------------
// connection_per_poll is SFTP-only, so a non-sftp config that carries it (or a
// CLI --connection-per-poll against one) must draw the ignored-warning rather
// than silently no-op. The persisted case is the mode's documented primary home
// and only the merged connection.options carries it; the CLI case is dropped off
// sftp by applyConnectionOverrides, so only the raw flag carries it -- loadConfig
// reads both. The signature `will be ignored ... only supported on sftp`
// distinguishes this warning from the wasteful-short-interval advisory, which
// also names --connection-per-poll but fires only on sftp.

/** Whether any collected warning is the connection_per_poll ignored-warning. */
function warnedConnectionPerPollIgnored(): boolean {
  return mockState.warnings.some(
    (m) =>
      m.includes("--connection-per-poll") &&
      m.includes("will be ignored") &&
      m.includes("only supported on sftp"),
  );
}

test("a persisted connection_per_poll: true in a filedrop config warns it is ignored", () => {
  const filedropWithConnPerPoll = {
    connection: {
      channel: "filedrop",
      path: "/mnt/share/drop",
      options: { connection_per_poll: true },
    },
    linkageTerms: minimalLinkageTerms,
  };
  fs.writeFileSync(configFile, YAML.stringify(filedropWithConnPerPoll));
  saveKeyFile(keyFile, { sharedSecret: TOKEN_A });
  loadConfig(baseOptions());
  expect(warnedConnectionPerPollIgnored()).toBe(true);
});

test("a CLI --connection-per-poll against a filedrop config warns it is ignored", () => {
  // applyConnectionOverrides drops the flag off sftp, so the merged config never
  // carries it here; the raw CLI intent is the only carrier and must still warn.
  fs.writeFileSync(configFile, YAML.stringify(minimalFiledropConfig));
  saveKeyFile(keyFile, { sharedSecret: TOKEN_A });
  loadConfig({ ...baseOptions(), connectionPerPoll: true });
  expect(warnedConnectionPerPollIgnored()).toBe(true);
});

test("a persisted connection_per_poll: true in an sftp config does not warn it is ignored", () => {
  const sftpWithConnPerPoll = {
    connection: {
      channel: "sftp",
      server: { host: "sftp.example.org" },
      options: { connection_per_poll: true, poll_interval_ms: 3_600_000 },
    },
    linkageTerms: minimalLinkageTerms,
  };
  fs.writeFileSync(configFile, YAML.stringify(sftpWithConnPerPoll));
  saveKeyFile(keyFile, { sharedSecret: TOKEN_A });
  loadConfig(baseOptions());
  // A long poll interval keeps the short-interval advisory silent too, so no
  // connection_per_poll warning of any kind should appear on its own channel.
  expect(
    mockState.warnings.some((m) => m.includes("--connection-per-poll")),
  ).toBe(false);
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

test("a webrtc config loads, carrying its role and server through", () => {
  fs.writeFileSync(
    configFile,
    YAML.stringify({
      connection: {
        channel: "webrtc",
        server: { host: "peers.example.org", port: 9000, secure: false },
        role: "inviter",
      },
      linkageTerms: minimalLinkageTerms,
    }),
  );
  saveKeyFile(keyFile, { sharedSecret: TOKEN_A });
  const result = loadConfig(baseOptions());
  // The channel allowlist admits webrtc, and the loader hands the connection on
  // whole: the transport reads `role` and the server block to resolve the
  // rendezvous, so a loader that dropped either would strand the exchange.
  expect(result.connection.channel).toBe("webrtc");
  expect(result.connection).toMatchObject({
    role: "inviter",
    server: { host: "peers.example.org", port: 9000, secure: false },
  });
});

test("a webrtc config with no role still loads; the transport refuses it", () => {
  // The role is read at dispatch, not at load: keeping the loader out of it means
  // one refusal, in one place, for a hand-authored config and for a saved one
  // alike (see webRtcDialFrom in protocol.ts).
  fs.writeFileSync(
    configFile,
    YAML.stringify({
      connection: { channel: "webrtc", server: { host: "peers.example.org" } },
      linkageTerms: minimalLinkageTerms,
    }),
  );
  saveKeyFile(keyFile, { sharedSecret: TOKEN_A });
  expect(loadConfig(baseOptions()).connection.channel).toBe("webrtc");
});

// --- webrtc ignored-flag reports ---------------------------------------------
// exchange registers the file-sync flags and the whole --server-* set, and
// applyConnectionOverrides drops every one of them on a webrtc config: the
// file-sync options because they are FileSyncOptions fields, the server block
// because it is merged on sftp alone. Each drop is reported by name, so a
// credential typed at a channel that discards it does not look, from the
// terminal, exactly like one that was used.

const minimalWebRTCConfig = {
  connection: {
    channel: "webrtc",
    server: { host: "peers.example.org" },
    role: "acceptor",
  },
  linkageTerms: minimalLinkageTerms,
};

/** The flags reported ignored, read out of the collected warnings by name. */
function reportedIgnoredFlags(): string[] {
  return mockState.warnings
    .filter((m) => m.includes("has no effect on the webrtc channel"))
    .map((m) => m.slice(0, m.indexOf(" has no effect")));
}

test("a webrtc config reports every file-sync flag the operator set", () => {
  fs.writeFileSync(configFile, YAML.stringify(minimalWebRTCConfig));
  saveKeyFile(keyFile, { sharedSecret: TOKEN_A });
  loadConfig({
    ...baseOptions(),
    locklessRendezvous: true,
    retainFiles: true,
    pollingFrequencyMs: 5_000,
    connectionPerPoll: true,
    peerId: "acceptor-1",
    timestampInFilename: true,
  });
  expect(reportedIgnoredFlags().sort()).toEqual(
    [
      "--connection-per-poll",
      "--lockless-rendezvous",
      "--peer-id",
      "--polling-frequency",
      "--retain-files",
      "--timestamp-in-filename",
    ].sort(),
  );
});

test("a webrtc config reports every --server-* flag the operator set", () => {
  fs.writeFileSync(configFile, YAML.stringify(minimalWebRTCConfig));
  saveKeyFile(keyFile, { sharedSecret: TOKEN_A });
  loadConfig({
    ...baseOptions(),
    serverPort: 9000,
    serverUsername: "someone",
    serverPassword: "s3cret",
    serverPrivateKey: "KEYDATA",
    serverPrivateKeyPassphrase: "unlock-me",
    serverKeyboardInteractive: true,
    serverHostKeyFingerprint: "SHA256:" + "A".repeat(42) + "A",
  });
  expect(reportedIgnoredFlags().sort()).toEqual(
    [
      "--server-host-key-fingerprint",
      "--server-keyboard-interactive",
      "--server-password",
      "--server-port",
      "--server-private-key",
      "--server-private-key-passphrase",
      "--server-username",
    ].sort(),
  );
  // Security invariant: the messages name the flag and nothing else, so a
  // credential typed at a channel that discards it is not echoed to the terminal
  // or a --log-file on its way out.
  for (const secret of ["s3cret", "KEYDATA", "unlock-me", "someone"])
    expect(mockState.warnings.some((m) => m.includes(secret))).toBe(false);
});

test("the webrtc drops are reported in wording that fits a configured exchange", () => {
  // This caller has no URL and is already the command an invite-flavored remedy
  // would send it to, so each report points at the connection block it loaded.
  // The credential line is measured here too, because this is the caller that
  // can hold a `server.key`: claiming the channel sends no credential of any
  // kind would be false on exactly the configuration being run.
  fs.writeFileSync(
    configFile,
    YAML.stringify({
      ...minimalWebRTCConfig,
      connection: {
        ...minimalWebRTCConfig.connection,
        server: { host: "peers.example.org", key: "deployment-key" },
      },
    }),
  );
  saveKeyFile(keyFile, { sharedSecret: TOKEN_A });
  loadConfig({
    ...baseOptions(),
    serverPort: 9000,
    serverUsername: "someone",
    serverPassword: "s3cret",
  });
  const reports = mockState.warnings.filter((m) =>
    m.includes("has no effect on the webrtc channel"),
  );
  const port = reports.find((m) => m.startsWith("--server-port "));
  const username = reports.find((m) => m.startsWith("--server-username "));
  const password = reports.find((m) => m.startsWith("--server-password "));
  expect(port).toContain("`connection.server`");
  expect(username).toContain("`connection.server.key`");
  expect(password).toContain("neither used nor echoed");
  expect(password).toContain("a configured `server.key` is sent");
  const rendered = reports.join("");
  // No remedy sends this operator to a URL they were never given, back to the
  // command they are running, or away with a promise the channel does not keep.
  expect(rendered).not.toContain("ws://");
  expect(rendered).not.toContain("run 'psilink exchange'");
  expect(rendered).not.toContain("no credential of any kind");
  // The configured key is named as a field, never echoed as a value.
  expect(rendered).not.toContain("deployment-key");
});

test("a webrtc config setting none of them reports nothing", () => {
  fs.writeFileSync(configFile, YAML.stringify(minimalWebRTCConfig));
  saveKeyFile(keyFile, { sharedSecret: TOKEN_A });
  loadConfig(baseOptions());
  expect(reportedIgnoredFlags()).toEqual([]);
});

test("a file-sync config reports none of the webrtc drops", () => {
  // The same flags against an sftp config: every one of them is applied there,
  // so the ignored-flag reports stay silent and the operator sees no warning
  // about a flag that took effect.
  fs.writeFileSync(configFile, YAML.stringify(minimalSFTPConfig));
  saveKeyFile(keyFile, { sharedSecret: TOKEN_A });
  loadConfig({
    ...baseOptions(),
    serverPort: 2222,
    serverUsername: "someone",
    serverPassword: "s3cret",
    peerId: "acceptor-1",
    timestampInFilename: true,
  });
  expect(mockState.warnings.filter((m) => m.includes("has no effect"))).toEqual(
    [],
  );
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
  let message = "";
  try {
    loadConfig(baseOptions());
  } catch (err) {
    message = (err as Error).message;
  }
  expect(message).toContain("expired at 2020-01-01T00:00:00.000Z");
  expect(message).toContain("no exchange was attempted");
  // The recovery named is the one that runs from the state this failure leaves:
  // the key file goes first (both offline commands refuse to overwrite one), and
  // the offline invite/accept pair keeps each side's configuration. The online
  // forms are not a recovery route -- they abort on a pre-existing configuration
  // file, which is exactly what this recovery reuses.
  expect(message).toContain("remove the expired key file on both sides");
  expect(message).toContain("'psilink invite'");
  expect(message).toContain("'psilink accept INVITATION [INPUT_FILE]'");
  expect(message).not.toContain("psilink invite URL");
  expect(message).not.toContain("psilink accept URL");
  expect(message).toContain("Each side's configuration is reused");
  expect(message).toContain("only the key file is recreated");
  // The remedy is stated in full above, so the message needs no reference to a
  // repository path the shipped image does not contain.
  expect(message).not.toContain("docs/CLI.md");
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
  const exitSpy = captureProcessExit();
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

test("handler: `-` input at an interactive terminal exits 64 (usage), not 69", async () => {
  // openInputSource raises a UsageError for `-` at a TTY with nothing piped; the
  // prepareDataset catch must map that to exit 64 (usage), not collapse it to the
  // default 69 (transport). A valid config and key let the handler reach
  // prepareDataset, where the `-` is resolved.
  fs.writeFileSync(configFile, YAML.stringify(minimalFiledropConfig));
  saveKeyFile(keyFile, { sharedSecret: TOKEN_A });
  const exitSpy = captureProcessExit();
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
  const exitSpy = captureProcessExit();
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

test("handler: a result file the exchange could not write exits 73, not 69", async () => {
  // The costly case docs/CLI.md publishes: the exchange completed, the result did
  // not reach disk, and a supervisor that retries conducts a SECOND exchange with
  // this party's data. runProtocol stamps that error with the persistence-loss
  // code (protocol.test.ts drives the real stamp against a real write failure);
  // what is measured here is the code the COMMAND reports, which is where the
  // published contract is either delivered or discarded. A boundary that maps
  // every non-usage error to 69 passes every other test in this file and fails
  // this one.
  fs.writeFileSync(configFile, YAML.stringify(minimalFiledropConfig));
  saveKeyFile(keyFile, { sharedSecret: TOKEN_A });
  const input = path.join(dir, "in.csv");
  fs.writeFileSync(input, "ssn\n123456789\n");

  vi.mocked(runProtocol).mockReset();
  vi.mocked(runProtocol).mockRejectedValueOnce(
    Object.assign(new Error("EACCES: permission denied, open 'results.csv'"), {
      exitCode: PERSISTENCE_LOSS_EXIT_CODE,
    }),
  );
  const exitSpy = captureProcessExit();
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
    ).rejects.toThrow("exit:73");
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
  const exitSpy = captureProcessExit();
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

// --- handler: signing-identity divergence (wiring) ---------------------------
// The comparison itself is unit-tested in exchangeSigning.test.ts; these cover
// the wiring -- that the handler hands the run's terms identity to the signing
// resolver, and that a divergence stops the run ahead of the exchange that would
// carry credentials, terms, and data.

// Seed a certificate-mode config whose identity file is bound to `bound`, and
// return the argv a run of it takes. The config's terms identity is "Test Party".
async function signedExchangeRun(bound: string): Promise<Arguments> {
  const identityFile = path.join(dir, "signing-identity.json");
  saveSigningIdentity(identityFile, await generateSigningIdentity(bound));
  fs.writeFileSync(
    configFile,
    YAML.stringify({
      ...minimalFiledropConfig,
      signing: { mode: "certificate", identity_file: identityFile },
    }),
  );
  saveKeyFile(keyFile, {
    sharedSecret: TOKEN_A,
    expires: new Date(Date.now() + 365 * 86_400_000).toISOString(),
  });
  const input = path.join(dir, "in.csv");
  fs.writeFileSync(input, "ssn\n123456789\n");
  return {
    _: [],
    $0: "psilink",
    input,
    "config-file": configFile,
    "key-file": keyFile,
    "log-level": "silent",
  } as unknown as Arguments;
}

test("handler exits 64 on a divergent signing identity, before runProtocol", async () => {
  // The seam is the CLI's own (assertIdentityMatchesAgreedTerms, inside
  // resolveSigningPersist), and what is pinned here is that it is reached on the
  // exchange path ahead of the run that carries credentials, terms, and data,
  // and that its remedy reaches the operator through the command's own error
  // sink as a usage error (exit 64) rather than a transport failure.
  const argv = await signedExchangeRun("Someone Else");
  vi.mocked(runProtocol).mockReset();
  const exitSpy = captureProcessExit();
  try {
    await expect(handler(argv)).rejects.toThrow("exit:64");
    expect(vi.mocked(runProtocol)).not.toHaveBeenCalled();
    const reported = mockState.errors.join("\n");
    expect(reported).toContain('"Someone Else"');
    expect(reported).toContain('"Test Party"');
    expect(reported).toContain("cannot finish");
  } finally {
    exitSpy.mockRestore();
  }
});

test("handler runs the exchange when the signing identity matches the terms identity", async () => {
  const argv = await signedExchangeRun("Test Party");
  vi.mocked(runProtocol).mockReset();
  vi.mocked(runProtocol).mockResolvedValueOnce({});
  await handler(argv);
  expect(
    mockState.errors.some((m) => m.includes("linkage_terms.identity")),
  ).toBe(false);
  expect(runProtocol).toHaveBeenCalledOnce();
});

test("handler compares the signing identity against --identity when it is given", async () => {
  // --identity replaces the config's terms identity for the run, so it is the
  // value the partner will verify the certificate against -- and therefore the
  // one a certificate matching the CONFIG's label now diverges from.
  const argv = await signedExchangeRun("Test Party");
  vi.mocked(runProtocol).mockReset();
  const exitSpy = captureProcessExit();
  try {
    await expect(
      handler({ ...argv, identity: "Overridden Party" } as Arguments),
    ).rejects.toThrow("exit:64");
    const reported = mockState.errors.join("\n");
    expect(reported).toContain('"Test Party"');
    expect(reported).toContain('"Overridden Party"');
    expect(vi.mocked(runProtocol)).not.toHaveBeenCalled();
  } finally {
    exitSpy.mockRestore();
  }
});

test("handler takes the run's identity from the configuration", async () => {
  // The label is the config's when it carries one; an empty string is refused by
  // the schema (see the empty-identity config case above) rather than reaching
  // here, and no lookup stands behind either -- partyIdentity.test.ts pins that
  // across the whole CLI source.
  fs.writeFileSync(configFile, YAML.stringify(minimalFiledropConfig));
  saveKeyFile(keyFile, {
    sharedSecret: TOKEN_A,
    expires: new Date(Date.now() + 365 * 86_400_000).toISOString(),
  });
  const input = path.join(dir, "in.csv");
  fs.writeFileSync(input, "ssn\n123456789\n");
  vi.mocked(prepareForExchange).mockClear();
  vi.mocked(runProtocol).mockReset();
  vi.mocked(runProtocol).mockResolvedValueOnce({});
  await handler({
    _: [],
    $0: "psilink",
    input,
    "config-file": configFile,
    "key-file": keyFile,
    "log-level": "silent",
  } as unknown as Arguments);
  expect(vi.mocked(prepareForExchange).mock.calls[0][1]).toBe("Test Party");
});

test("handler treats a blank --identity as absent, falling back to the config", async () => {
  fs.writeFileSync(configFile, YAML.stringify(minimalFiledropConfig));
  saveKeyFile(keyFile, {
    sharedSecret: TOKEN_A,
    expires: new Date(Date.now() + 365 * 86_400_000).toISOString(),
  });
  const input = path.join(dir, "in.csv");
  fs.writeFileSync(input, "ssn\n123456789\n");
  vi.mocked(prepareForExchange).mockClear();
  vi.mocked(runProtocol).mockReset();
  vi.mocked(runProtocol).mockResolvedValueOnce({});
  await handler({
    _: [],
    $0: "psilink",
    input,
    "config-file": configFile,
    "key-file": keyFile,
    "log-level": "silent",
    identity: "   ",
  } as unknown as Arguments);
  expect(vi.mocked(prepareForExchange).mock.calls[0][1]).toBe("Test Party");
});

test("handler exits 64 on an --identity still carrying the init placeholder", async () => {
  // The optional-identity path refuses this one value rather than reading it as
  // a label or dropping it to absence, and the refusal is a local usage fault:
  // exit 64, decided before the protocol runs, not the top-level printer's 1.
  fs.writeFileSync(configFile, YAML.stringify(minimalFiledropConfig));
  saveKeyFile(keyFile, {
    sharedSecret: TOKEN_A,
    expires: new Date(Date.now() + 365 * 86_400_000).toISOString(),
  });
  const input = path.join(dir, "in.csv");
  fs.writeFileSync(input, "ssn\n123456789\n");
  vi.mocked(runProtocol).mockReset();
  const exitSpy = captureProcessExit();
  try {
    await expect(
      handler({
        _: [],
        $0: "psilink",
        input,
        "config-file": configFile,
        "key-file": keyFile,
        "log-level": "silent",
        identity: PLACEHOLDER_IDENTITY,
      } as unknown as Arguments),
    ).rejects.toThrow("exit:64");
    expect(runProtocol).not.toHaveBeenCalled();
  } finally {
    exitSpy.mockRestore();
  }
});

test("handler runs a configuration carrying no identity, sending none", async () => {
  // `linkage_terms.identity` is optional, so a configuration that names this
  // party nothing runs -- the terms carry no identity rather than a label the
  // operator never chose, and nothing is read off the account psilink runs as.
  const { identity: _dropped, ...unnamedTerms } = minimalLinkageTerms;
  fs.writeFileSync(
    configFile,
    YAML.stringify({ ...minimalFiledropConfig, linkageTerms: unnamedTerms }),
  );
  saveKeyFile(keyFile, {
    sharedSecret: TOKEN_A,
    expires: new Date(Date.now() + 365 * 86_400_000).toISOString(),
  });
  const input = path.join(dir, "in.csv");
  fs.writeFileSync(input, "ssn\n123456789\n");
  vi.mocked(prepareForExchange).mockClear();
  vi.mocked(runProtocol).mockReset();
  vi.mocked(runProtocol).mockResolvedValueOnce({});
  await handler({
    _: [],
    $0: "psilink",
    input,
    "config-file": configFile,
    "key-file": keyFile,
    "log-level": "silent",
  } as unknown as Arguments);
  expect(vi.mocked(prepareForExchange).mock.calls[0][1]).toBeUndefined();
});

test("handler trims a supplied --identity before using it", async () => {
  fs.writeFileSync(configFile, YAML.stringify(minimalFiledropConfig));
  saveKeyFile(keyFile, {
    sharedSecret: TOKEN_A,
    expires: new Date(Date.now() + 365 * 86_400_000).toISOString(),
  });
  const input = path.join(dir, "in.csv");
  fs.writeFileSync(input, "ssn\n123456789\n");
  vi.mocked(prepareForExchange).mockClear();
  vi.mocked(runProtocol).mockReset();
  vi.mocked(runProtocol).mockResolvedValueOnce({});
  await handler({
    _: [],
    $0: "psilink",
    input,
    "config-file": configFile,
    "key-file": keyFile,
    "log-level": "silent",
    identity: " Agency A ",
  } as unknown as Arguments);
  expect(vi.mocked(prepareForExchange).mock.calls[0][1]).toBe("Agency A");
});

// --- handler: --invitation provisioning --------------------------------------
// These drive the handler's provisioning step, which runs before the key file is
// read: --invitation decodes an invitation code and writes the composing party's
// key-file copy (secret AND expiry), then the exchange proceeds as usual. The
// full decode/write path is unit-tested in keyFile.test.ts; these cover the
// handler wiring -- that provisioning happens ahead of loadConfig, that the run
// then proceeds, and the pre-existing-key and fail-closed exit paths.

// A 43-char base64url secret distinct from TOKEN_A/TOKEN_B, to prove the
// provisioned key carries the invitation's secret.
const INVITE_SECRET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAg";

function inviteToken(expires?: string): InvitationToken {
  return {
    version: "1",
    linkageTerms: getDefaultLinkageTerms("Inviter Org"),
    sharedSecret: INVITE_SECRET,
    expires,
  };
}

test("handler: --invitation provisions the key file when none exists and the exchange proceeds", async () => {
  // No key file at the key path: provisioning writes the composing party's copy
  // (secret and expiry) and the exchange reaches runProtocol, which is mocked to
  // resolve. The written key must carry the invitation's secret and expiry.
  const expires = new Date(Date.now() + 3_600_000).toISOString();
  const encoded = await encodeInvitation(inviteToken(expires));
  fs.writeFileSync(configFile, YAML.stringify(minimalFiledropConfig));
  const input = path.join(dir, "in.csv");
  fs.writeFileSync(input, "ssn\n123456789\n");
  expect(fs.existsSync(keyFile)).toBe(false);

  vi.mocked(runProtocol).mockReset();
  vi.mocked(runProtocol).mockResolvedValueOnce({});
  const exitSpy = captureProcessExit();
  try {
    await handler({
      _: [],
      $0: "psilink",
      input,
      "config-file": configFile,
      "key-file": keyFile,
      invitation: encoded,
      "log-level": "silent",
    } as unknown as Arguments);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(vi.mocked(runProtocol)).toHaveBeenCalledTimes(1);
    const key = loadKeyFile(keyFile);
    expect(key?.sharedSecret).toBe(INVITE_SECRET);
    expect(key?.expires).toBe(expires);
  } finally {
    exitSpy.mockRestore();
  }
});

test("handler: --invitation errors (exit 64) when a key file already exists and leaves it untouched", async () => {
  // A pre-existing key file is a clean usage error, never an overwrite: the
  // secret rotates after the first exchange, so re-supplying the original code
  // must not resurrect a stale secret. runProtocol must not run.
  const encoded = await encodeInvitation(inviteToken());
  fs.writeFileSync(configFile, YAML.stringify(minimalFiledropConfig));
  const existing = JSON.stringify({ sharedSecret: TOKEN_A }) + "\n";
  fs.writeFileSync(keyFile, existing);
  const input = path.join(dir, "in.csv");
  fs.writeFileSync(input, "ssn\n123456789\n");

  vi.mocked(runProtocol).mockReset();
  const exitSpy = captureProcessExit();
  try {
    await expect(
      handler({
        _: [],
        $0: "psilink",
        input,
        "config-file": configFile,
        "key-file": keyFile,
        invitation: encoded,
        "log-level": "silent",
      } as unknown as Arguments),
    ).rejects.toThrow("exit:64");
    expect(vi.mocked(runProtocol)).not.toHaveBeenCalled();
    // The pre-existing key file is byte-for-byte unchanged.
    expect(fs.readFileSync(keyFile, "utf8")).toBe(existing);
  } finally {
    exitSpy.mockRestore();
  }
});

test("handler: --invitation with a malformed code fails closed (exit 64), writing no key file", async () => {
  fs.writeFileSync(configFile, YAML.stringify(minimalFiledropConfig));
  const input = path.join(dir, "in.csv");
  fs.writeFileSync(input, "ssn\n123456789\n");

  vi.mocked(runProtocol).mockReset();
  const exitSpy = captureProcessExit();
  try {
    await expect(
      handler({
        _: [],
        $0: "psilink",
        input,
        "config-file": configFile,
        "key-file": keyFile,
        invitation: "not-a-valid-invitation",
        "log-level": "silent",
      } as unknown as Arguments),
    ).rejects.toThrow("exit:64");
    expect(vi.mocked(runProtocol)).not.toHaveBeenCalled();
    expect(fs.existsSync(keyFile)).toBe(false);
  } finally {
    exitSpy.mockRestore();
  }
});

// --- handler: the exit code each error boundary reports ----------------------
// Each boundary below routes its caught error through the one exitCodeForError
// (src/util/exit.ts): one error per class it distinguishes, planted at the
// module call the boundary wraps, against the code docs/CLI.md's exit-code table
// states. The other commands' boundaries: exitBoundaryMapping.test.ts. These say
// what a boundary reports for an error that reaches it, and nothing about which
// classes can reach it.

/** Run the handler, asserting it exits with `code` and never reaches the
 * exchange. */
async function expectExchangeExit(
  argv: Arguments,
  code: number,
): Promise<void> {
  vi.mocked(runProtocol).mockReset();
  const exitSpy = captureProcessExit();
  try {
    await expect(handler(argv)).rejects.toThrow(`exit:${code}`);
    expect(exitSpy).toHaveBeenCalledExactlyOnceWith(code);
    expect(vi.mocked(runProtocol)).not.toHaveBeenCalled();
  } finally {
    exitSpy.mockRestore();
  }
}

/** Seed a filedrop config, a live key file, and an input file, and return the
 * argv a run of them takes. */
function filedropRun(): Arguments {
  fs.writeFileSync(configFile, YAML.stringify(minimalFiledropConfig));
  saveKeyFile(keyFile, {
    sharedSecret: TOKEN_A,
    expires: new Date(Date.now() + 365 * 86_400_000).toISOString(),
  });
  const input = path.join(dir, "in.csv");
  fs.writeFileSync(input, "ssn\n123456789\n");
  return {
    _: [],
    $0: "psilink",
    input,
    "config-file": configFile,
    "key-file": keyFile,
    "log-level": "silent",
  } as unknown as Arguments;
}

test.each(ERROR_CLASS_EXIT_CODES)(
  "handler: --invitation provisioning exits $code on $planted",
  async ({ plant, code }) => {
    fs.writeFileSync(configFile, YAML.stringify(minimalFiledropConfig));
    const input = path.join(dir, "in.csv");
    fs.writeFileSync(input, "ssn\n123456789\n");
    vi.mocked(provisionKeyFileFromInvitation).mockRejectedValueOnce(plant());
    await expectExchangeExit(
      {
        _: [],
        $0: "psilink",
        input,
        "config-file": configFile,
        "key-file": keyFile,
        invitation: await encodeInvitation(inviteToken()),
        "log-level": "silent",
      } as unknown as Arguments,
      code,
    );
  },
);

test.each(ERROR_CLASS_EXIT_CODES)(
  "handler: the signing-identity load exits $code on $planted",
  async ({ plant, code }) => {
    const argv = await signedExchangeRun("Test Party");
    vi.mocked(loadSigningIdentity).mockRejectedValueOnce(plant());
    await expectExchangeExit(argv, code);
  },
);

test.each(ERROR_CLASS_EXIT_CODES)(
  "handler: the host-key trust step exits $code on $planted",
  async ({ plant, code }) => {
    const argv = filedropRun();
    vi.mocked(establishHostKeyTrust).mockRejectedValueOnce(plant());
    await expectExchangeExit(argv, code);
  },
);

// --- handler: prepare-time guards precede the credential-bearing connect -----

test("handler: the prepare-time guard completes before runProtocol on an sftp config", async () => {
  // The disclosure property the docs state is that every prepare-time guard
  // settles before the run that carries credentials, terms, and data -- that is
  // runProtocol, not the first connection. An sftp config keeps the unpinned
  // first-use host-key path live (stubbed above), which is exactly the shape
  // where a probe can open a socket ahead of the guard, so pin the ordering
  // here rather than over a filedrop config where nothing connects early.
  fs.writeFileSync(configFile, YAML.stringify(minimalSFTPConfig));
  saveKeyFile(keyFile, { sharedSecret: TOKEN_A });
  const input = path.join(dir, "in.csv");
  fs.writeFileSync(input, "ssn\n123456789\n");

  vi.mocked(prepareForExchange).mockClear();
  vi.mocked(establishHostKeyTrust).mockClear();
  vi.mocked(runProtocol).mockReset();
  vi.mocked(runProtocol).mockResolvedValueOnce({});
  const exitSpy = captureProcessExit();
  try {
    await handler({
      _: [],
      $0: "psilink",
      input,
      "config-file": configFile,
      "key-file": keyFile,
      "log-level": "silent",
    } as unknown as Arguments);
    expect(exitSpy).not.toHaveBeenCalled();
    // Not an ordering assertion: it establishes that this config took the
    // host-key path at all, so the test is not silently a filedrop equivalent.
    expect(vi.mocked(establishHostKeyTrust)).toHaveBeenCalled();
    // Vitest stamps every mock call with a run-wide sequence number, which is
    // what orders calls on two separate mocks against each other.
    const [guarded] = vi.mocked(prepareForExchange).mock.invocationCallOrder;
    const [ran] = vi.mocked(runProtocol).mock.invocationCallOrder;
    expect(guarded).toBeLessThan(ran);
  } finally {
    exitSpy.mockRestore();
  }
});

/** A signing identity on disk bound to `bound`, for a certificate-mode config
 * whose subject is some other gate: the handler refuses a block naming no
 * identity file from the parsed config alone, ahead of everything in
 * prepareForExchange, so a run meant to reach a gate inside it has to name one. */
async function seedSigningIdentity(bound: string): Promise<string> {
  const identityFile = path.join(dir, "signing-identity.json");
  saveSigningIdentity(identityFile, await generateSigningIdentity(bound));
  return identityFile;
}

test("handler: certificate mode with no partner pin exits 64 before runProtocol", async () => {
  // The gate is core's alone (assertCertificateModePinsPartner, raised inside
  // prepareForExchange), so this drives the REAL prepare rather than the
  // top-of-file stub: what is pinned here is that the one seam is reached on the
  // CLI's exchange path, ahead of the run that carries credentials, terms, and
  // data, and that its remedy reaches the operator through the command's own
  // error sink as a usage error (exit 64) rather than a transport failure.
  const core =
    await vi.importActual<typeof import("@psilink/core")>("@psilink/core");
  fs.writeFileSync(
    configFile,
    YAML.stringify({
      ...minimalSFTPConfig,
      signing: {
        mode: "certificate",
        identityFile: await seedSigningIdentity("Test Party"),
      },
    }),
  );
  saveKeyFile(keyFile, { sharedSecret: TOKEN_A });
  const input = path.join(dir, "in.csv");
  fs.writeFileSync(input, "ssn\n123456789\n");

  vi.mocked(prepareForExchange).mockImplementationOnce(core.prepareForExchange);
  vi.mocked(runProtocol).mockReset();
  const exitSpy = captureProcessExit();
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
    ).rejects.toThrow("exit:64");
    expect(vi.mocked(runProtocol)).not.toHaveBeenCalled();
    const reported = mockState.errors.join("\n");
    expect(reported).toContain("signing.partner_fingerprint");
    expect(reported).toContain("psilink fingerprint");
  } finally {
    exitSpy.mockRestore();
  }
});

test("handler: certificate mode with an unnamed party exits 64 before runProtocol", async () => {
  // The sibling of the pin gate above, and pinned the same way: the refusal is
  // core's alone (assertCertificateModeNamesLocalParty, inside
  // prepareForExchange), so this drives the REAL prepare rather than the
  // top-of-file stub. `linkage_terms.identity` is optional, so the terms below
  // are a shape the schema admits and only the signing configuration makes
  // unrunnable -- the seam has to be reached on the exchange leg ahead of the run
  // that carries credentials, terms, and data, and its remedy has to reach the
  // operator as a usage error (exit 64).
  const core =
    await vi.importActual<typeof import("@psilink/core")>("@psilink/core");
  const { identity: _named, ...unnamedTerms } = minimalLinkageTerms;
  fs.writeFileSync(
    configFile,
    YAML.stringify({
      ...minimalSFTPConfig,
      linkageTerms: unnamedTerms,
      signing: {
        mode: "certificate",
        identityFile: await seedSigningIdentity("Test Party"),
        partnerFingerprint: PARTNER_FINGERPRINT,
      },
    }),
  );
  saveKeyFile(keyFile, { sharedSecret: TOKEN_A });
  const input = path.join(dir, "in.csv");
  fs.writeFileSync(input, "ssn\n123456789\n");

  vi.mocked(prepareForExchange).mockImplementationOnce(core.prepareForExchange);
  vi.mocked(runProtocol).mockReset();
  const exitSpy = captureProcessExit();
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
    ).rejects.toThrow("exit:64");
    expect(vi.mocked(runProtocol)).not.toHaveBeenCalled();
    const reported = mockState.errors.join("\n");
    expect(reported).toContain("linkage_terms.identity");
    expect(reported).toContain("--identity");
  } finally {
    exitSpy.mockRestore();
  }
});

test("handler: an unnamed party that signs nothing runs unchanged", async () => {
  // The other half of the gate, and the property the optional identity exists
  // for: nothing is asked of an unnamed run that configures no receipt. Drives
  // the same real prepare, so the pass is core's own and not the stub's.
  const core =
    await vi.importActual<typeof import("@psilink/core")>("@psilink/core");
  const { identity: _named, ...unnamedTerms } = minimalLinkageTerms;
  fs.writeFileSync(
    configFile,
    YAML.stringify({ ...minimalSFTPConfig, linkageTerms: unnamedTerms }),
  );
  saveKeyFile(keyFile, { sharedSecret: TOKEN_A });
  const input = path.join(dir, "in.csv");
  fs.writeFileSync(input, "ssn\n123456789\n");

  vi.mocked(prepareForExchange).mockImplementationOnce(core.prepareForExchange);
  vi.mocked(runProtocol).mockReset();
  vi.mocked(runProtocol).mockResolvedValueOnce({});
  const exitSpy = captureProcessExit();
  try {
    await handler({
      _: [],
      $0: "psilink",
      input,
      "config-file": configFile,
      "key-file": keyFile,
      "log-level": "silent",
    } as unknown as Arguments);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(vi.mocked(runProtocol)).toHaveBeenCalled();
  } finally {
    exitSpy.mockRestore();
  }
});

// --- handler: the local preparation precedes host-key trust -----------------
// An exchange refused from local inputs alone must not have connected to the
// server first, and on an unpinned sftp config the first-use host-key step is
// what would connect: its probe opens a real transport. So both steps that
// carry those refusals -- the preparation, with its linkage-satisfiability gate
// and outbound-consent surface, and the signing resolution, whose identity file
// can be missing or bound to another party -- run ahead of that step, and the
// checks below hold that order rather than the comments beside any of them. A
// refusal the parsed configuration alone decides, a certificate-mode run naming
// no signing identity, runs ahead of both in turn. All of them stub
// establishHostKeyTrust (as the whole file does), so what they pin is the order
// of the STEPS; that the probe is what the host-key one opens is
// hostKeyTrust.test.ts's.

/** Write the sftp config, key file, and CSV the two ordering checks drive the
 * handler over; the default CSV satisfies the config's lone ssn key. */
function writeSftpExchangeInputs(csv = "ssn\n123456789\n"): string {
  fs.writeFileSync(configFile, YAML.stringify(minimalSFTPConfig));
  saveKeyFile(keyFile, { sharedSecret: TOKEN_A });
  const input = path.join(dir, "in.csv");
  fs.writeFileSync(input, csv);
  return input;
}

test("handler: the outbound-consent surface runs before host-key trust", async () => {
  const input = writeSftpExchangeInputs();

  const steps: string[] = [];
  vi.mocked(establishHostKeyTrust).mockClear();
  vi.mocked(establishHostKeyTrust).mockImplementationOnce(() => {
    steps.push("host-key trust");
    return Promise.resolve();
  });
  vi.mocked(confirmOutboundPayloadConsent).mockImplementationOnce(() => {
    steps.push("outbound consent");
    return Promise.resolve();
  });
  vi.mocked(runProtocol).mockReset();
  vi.mocked(runProtocol).mockResolvedValueOnce({});
  const exitSpy = captureProcessExit();
  try {
    await handler({
      _: [],
      $0: "psilink",
      input,
      "config-file": configFile,
      "key-file": keyFile,
      "log-level": "silent",
    } as unknown as Arguments);
    expect(exitSpy).not.toHaveBeenCalled();
    // Both steps ran, and in this order: an assertion over one call alone would
    // read a silently skipped step as satisfied.
    expect(steps).toEqual(["outbound consent", "host-key trust"]);
  } finally {
    exitSpy.mockRestore();
  }
});

test("handler: an input that cannot satisfy the agreed terms exits 64 with no host-key probe", async () => {
  // The ordering above is a call order, which a handler that STARTED host-key
  // trust without awaiting it would satisfy just as well -- and then the probe
  // would have connected anyway. So the refusing case is driven too, over the
  // same unpinned sftp config: a CSV that can produce none of the terms' fields
  // must end the run at the refusal, exit 64, with the host-key step -- and so
  // the probe inside it -- never entered.
  const input = writeSftpExchangeInputs("first_name\nAda\n");

  vi.mocked(establishHostKeyTrust).mockClear();
  vi.mocked(runProtocol).mockReset();
  const exitSpy = captureProcessExit();
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
    ).rejects.toThrow("exit:64");
    expect(mockState.errors.join("\n")).toContain(
      "cannot satisfy every linkage key the configuration declares",
    );
    expect(vi.mocked(establishHostKeyTrust)).not.toHaveBeenCalled();
    expect(vi.mocked(runProtocol)).not.toHaveBeenCalled();
  } finally {
    exitSpy.mockRestore();
  }
});

test("handler: certificate mode naming no identity file is refused before either", async () => {
  // A run the parsed configuration alone shows cannot finish, so it is refused
  // ahead of BOTH steps: the preparation whose consent surface can stop for an
  // answer, and the first-use host-key step whose probe connects and whose
  // accepted pin is written into psilink.yaml. The config below is unpinned sftp
  // and pins the partner's certificate, so the missing identity file is the only
  // thing that makes it unrunnable. The host-key step is stubbed file-wide, so
  // what the config-file assertion adds is that nothing else on the handler's
  // path wrote it either.
  fs.writeFileSync(
    configFile,
    YAML.stringify({
      ...minimalSFTPConfig,
      signing: { mode: "certificate", partnerFingerprint: PARTNER_FINGERPRINT },
    }),
  );
  saveKeyFile(keyFile, { sharedSecret: TOKEN_A });
  const input = path.join(dir, "in.csv");
  fs.writeFileSync(input, "ssn\n123456789\n");
  const configBytes = fs.readFileSync(configFile, "utf8");
  const configMtimeMs = fs.statSync(configFile).mtimeMs;

  vi.mocked(prepareForExchange).mockClear();
  vi.mocked(confirmOutboundPayloadConsent).mockClear();
  vi.mocked(establishHostKeyTrust).mockClear();
  vi.mocked(runProtocol).mockReset();
  const exitSpy = captureProcessExit();
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
    ).rejects.toThrow("exit:64");
    expect(mockState.errors.join("\n")).toContain("names no signing identity");
    expect(vi.mocked(prepareForExchange)).not.toHaveBeenCalled();
    expect(vi.mocked(confirmOutboundPayloadConsent)).not.toHaveBeenCalled();
    expect(vi.mocked(establishHostKeyTrust)).not.toHaveBeenCalled();
    expect(vi.mocked(runProtocol)).not.toHaveBeenCalled();
    expect(fs.readFileSync(configFile, "utf8")).toBe(configBytes);
    expect(fs.statSync(configFile).mtimeMs).toBe(configMtimeMs);
  } finally {
    exitSpy.mockRestore();
  }
});

/** Write the unpinned sftp config, key file, and CSV the two signing-ordering
 * checks drive the handler over: a certificate-mode block naming `identityFile`
 * and pinning a partner, so the identity file is the only thing either check
 * varies. */
function writeSigningExchangeInputs(identityFile: string): string {
  fs.writeFileSync(
    configFile,
    YAML.stringify({
      ...minimalSFTPConfig,
      signing: {
        mode: "certificate",
        identityFile,
        partnerFingerprint: PARTNER_FINGERPRINT,
      },
    }),
  );
  saveKeyFile(keyFile, { sharedSecret: TOKEN_A });
  const input = path.join(dir, "in.csv");
  fs.writeFileSync(input, "ssn\n123456789\n");
  return input;
}

test("handler: the signing identity resolves before host-key trust", async () => {
  // Both refusals the resolution carries -- an identity file that is not there
  // or will not parse, and one bound to a party other than this run's terms
  // identity -- read this party's own configuration and its own file, so they
  // are settled before the step that connects. The identity seeded here loads
  // and is bound to the terms identity, so both steps run and what is measured
  // is their order.
  const input = writeSigningExchangeInputs(
    await seedSigningIdentity("Test Party"),
  );

  vi.mocked(loadSigningIdentity).mockClear();
  vi.mocked(establishHostKeyTrust).mockClear();
  vi.mocked(runProtocol).mockReset();
  vi.mocked(runProtocol).mockResolvedValueOnce({});
  const exitSpy = captureProcessExit();
  try {
    await handler({
      _: [],
      $0: "psilink",
      input,
      "config-file": configFile,
      "key-file": keyFile,
      "log-level": "silent",
    } as unknown as Arguments);
    expect(exitSpy).not.toHaveBeenCalled();
    // Both steps ran: an order read off one call alone would take a silently
    // skipped step for a satisfied one.
    expect(vi.mocked(loadSigningIdentity)).toHaveBeenCalled();
    expect(vi.mocked(establishHostKeyTrust)).toHaveBeenCalled();
    // Vitest stamps every mock call with a run-wide sequence number, which is
    // what orders calls on two separate mocks against each other.
    const [loaded] = vi.mocked(loadSigningIdentity).mock.invocationCallOrder;
    const [trusted] = vi.mocked(establishHostKeyTrust).mock.invocationCallOrder;
    expect(loaded).toBeLessThan(trusted);
  } finally {
    exitSpy.mockRestore();
  }
});

test("handler: a signing identity missing from its configured path exits 64 with no host-key probe", async () => {
  // The ordering above is a call order, which a handler that STARTED host-key
  // trust without awaiting it would satisfy just as well -- and then the probe
  // would have connected anyway. So the refusing case is driven too, over the
  // same unpinned sftp config: a certificate-mode block whose identity_file
  // names a path holding no identity must end the run at the refusal, exit 64,
  // with the host-key step -- and so the probe inside it -- never entered.
  const input = writeSigningExchangeInputs(
    path.join(dir, "absent-signing-identity.json"),
  );

  vi.mocked(establishHostKeyTrust).mockClear();
  vi.mocked(runProtocol).mockReset();
  const exitSpy = captureProcessExit();
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
    ).rejects.toThrow("exit:64");
    expect(mockState.errors.join("\n")).toContain(
      "no signing identity was found at",
    );
    expect(vi.mocked(establishHostKeyTrust)).not.toHaveBeenCalled();
    expect(vi.mocked(runProtocol)).not.toHaveBeenCalled();
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
  linkageStrategy: "cascade",
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
    { name: "last_name", type: "last_name" },
    { name: "dob", type: "date_of_birth" },
  ],
  linkageKeys: [
    { name: "SSN", elements: [{ field: "ssn" }] },
    { name: "NAME_DOB", elements: [{ field: "last_name" }, { field: "dob" }] },
  ],
};

// The last-name+dob key alone: the terms a last_name+dob CSV satisfies in full,
// for the tests whose subject is the lock-in rather than coverage.
const nameDobTerms: LinkageTerms = {
  ...ssnAndNameDobTerms,
  linkageFields: [
    { name: "last_name", type: "last_name" },
    { name: "dob", type: "date_of_birth" },
  ],
  linkageKeys: [
    { name: "NAME_DOB", elements: [{ field: "last_name" }, { field: "dob" }] },
  ],
};

function writeInput(contents: string): string {
  const input = path.join(dir, "in.csv");
  fs.writeFileSync(input, contents);
  return input;
}

// prepareDataset takes where an outbound-payload confirmation would be recorded
// and how the surface asking for it is routed. None of the specs below carries a
// consent record, so the confirmation is a no-op and the context is inert; the
// gate itself is covered in outboundPayloadConsent.test.ts.
function consentContext(): { configPath: string; logFile: string | undefined } {
  return { configPath: configFile, logFile: undefined };
}

test("prepareDataset: refuses (UsageError) naming the field when the CSV satisfies no linkage key", async () => {
  // A first_name-only CSV cannot produce the ssn field the lone key needs, so the
  // run must stop with a usage error rather than reach a silent empty exchange.
  const input = writeInput("first_name\nAda\n");
  const err = await prepareDataset(
    { linkageTerms: ssnOnlyTerms },
    "Test Party",
    input,
    consentContext(),
  ).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(UsageError);
  expect((err as Error).message).toMatch(
    /cannot satisfy every linkage key the configuration declares/,
  );
  // The field is named on a labelled link of its own -- terms content is
  // partner-chosen on the sibling accept path -- so it is the rendered chain the
  // operator reads that has to carry it, not the summary.
  expect(sanitizeErrorForDisplay(err)).toContain(
    "unsatisfied field: ssn (ssn)",
  );
});

test("prepareDataset: refuses when only some of the committed keys are satisfiable", async () => {
  // last_name+dob satisfy the NAME_DOB key but not the SSN key. The run would
  // match on fewer keys than the committed terms declare, so it stops before any
  // exchange work rather than proceeding on what is left.
  const input = writeInput("last_name,dob\nLovelace,1815-12-10\n");
  const err = await prepareDataset(
    { linkageTerms: ssnAndNameDobTerms },
    "Test Party",
    input,
    consentContext(),
  ).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(UsageError);
  const rendered = sanitizeErrorForDisplay(err);
  expect(rendered).toContain(
    "1 of the 2 agreed linkage keys cannot be produced from this input's " +
      "columns",
  );
  expect(rendered).toContain("unsatisfied field: ssn (ssn)");
  expect(rendered).toContain("linkage key the CSV cannot produce: SSN");
  expect(mockState.warnings).toHaveLength(0);
});

test("prepareDataset: an explicit standardization remap satisfies a field the column type alone would not", async () => {
  // ssn_source does not infer to the ssn type, so without standardization the ssn
  // key is unsatisfiable and the run blocks...
  const input = writeInput("ssn_source\n123456789\n");
  await expect(
    prepareDataset(
      { linkageTerms: ssnOnlyTerms },
      "Test Party",
      input,
      consentContext(),
    ),
  ).rejects.toThrow(
    /cannot satisfy every linkage key the configuration declares/,
  );

  // ...but a remap binding ssn <- ssn_source makes the field producible, so the
  // same CSV proceeds with no block and no warning. This is the exchange-path
  // wrinkle accept does not have: a committed config can carry a column remap.
  // The remap binds only a `role: linkage` column (matching participation is the
  // explicit linkage role), so the config roles ssn_source linkage while leaving
  // its type non-ssn -- the remap, not the type fallback, is what binds it.
  const prepared = await prepareDataset(
    {
      linkageTerms: ssnOnlyTerms,
      standardization: [{ output: "ssn", input: "ssn_source" }],
      metadata: [
        {
          name: "ssn_source",
          type: "other",
          role: "linkage",
          isPayload: false,
        },
      ],
    },
    "Test Party",
    input,
    consentContext(),
  );
  expect(prepared).toBeDefined();
  expect(mockState.warnings).toHaveLength(0);
});

test("prepareDataset: an explicit metadata type satisfies a column whose name does not infer to that type", async () => {
  // patient_number does not infer to the ssn type, so without metadata the ssn key
  // is unsatisfiable and the run blocks...
  const input = writeInput("patient_number\n123456789\n");
  await expect(
    prepareDataset(
      { linkageTerms: ssnOnlyTerms },
      "Test Party",
      input,
      consentContext(),
    ),
  ).rejects.toThrow(
    /cannot satisfy every linkage key the configuration declares/,
  );

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
    consentContext(),
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
      consentContext(),
    ),
  ).rejects.toThrow(
    /cannot satisfy every linkage key the configuration declares/,
  );
});

// --- prepareDataset: recurring payload lock-in -------------------------------

test("prepareDataset: a committed payload.receive locks in the expected received columns", async () => {
  // A recurring config that declares what it expects to receive locks that set in
  // as prepared.expectedPayloadColumns; runExchange then verifies the partner's
  // transmitted payload matches it exactly (the recurring half of the lock-in).
  const input = writeInput("last_name,dob\nLovelace,1815-12-10\n");
  const terms: LinkageTerms = {
    ...nameDobTerms,
    payload: { receive: [{ name: "diagnosis" }, { name: "notes" }] },
  };
  const prepared = await prepareDataset(
    { linkageTerms: terms },
    "Test Party",
    input,
    consentContext(),
  );
  expect(prepared.expectedPayloadColumns).toEqual(["diagnosis", "notes"]);
});

test("prepareDataset: a config without payload.receive locks in nothing (lazy)", async () => {
  const input = writeInput("last_name,dob\nLovelace,1815-12-10\n");
  const prepared = await prepareDataset(
    { linkageTerms: nameDobTerms },
    "Test Party",
    input,
    consentContext(),
  );
  expect(prepared.expectedPayloadColumns).toBeUndefined();
});

test("prepareDataset: the top-level expectedPayloadColumns is the canonical lock-in source", async () => {
  // The local expectedPayloadColumns field (written by an offline accept from the
  // invitation's disclosedPayloadColumns) is the canonical lock-in and takes
  // precedence over the negotiated payload.receive. Distinct from payload.receive
  // so it does not trip the validateCompatibility mirror against an inviter that
  // advertised no payload.send.
  const input = writeInput("last_name,dob\nLovelace,1815-12-10\n");
  const terms: LinkageTerms = {
    ...nameDobTerms,
    payload: { receive: [{ name: "ignored_by_precedence" }] },
  };
  const prepared = await prepareDataset(
    { linkageTerms: terms, expectedPayloadColumns: ["diagnosis", "notes"] },
    "Test Party",
    input,
    consentContext(),
  );
  expect(prepared.expectedPayloadColumns).toEqual(["diagnosis", "notes"]);
});

test("prepareDataset: an empty expectedPayloadColumns locks in the strict empty set", async () => {
  // An offline accept of an invitation that disclosed nothing persists the empty
  // set; it is a strict "receive nothing" lock-in, not the absent/lazy case.
  const input = writeInput("last_name,dob\nLovelace,1815-12-10\n");
  const prepared = await prepareDataset(
    { linkageTerms: nameDobTerms, expectedPayloadColumns: [] },
    "Test Party",
    input,
    consentContext(),
  );
  expect(prepared.expectedPayloadColumns).toEqual([]);
});

// --- prepareDataset: recurring terms lock-in ---------------------------------

test("prepareDataset: the config's expectedPartnerDeduplicate is restored onto the run", async () => {
  // The terms-side half of an acceptance's lock-in, written into the config by
  // every accept path and restored here so a RECURRING run holds the partner to
  // what the invitation declared. Both booleans, because `false` is the
  // declaration a hostile inviter widens away from by presenting `true`.
  const input = writeInput("last_name,dob\nLovelace,1815-12-10\n");
  for (const declared of [false, true]) {
    const prepared = await prepareDataset(
      {
        linkageTerms: nameDobTerms,
        expectedPartnerDeduplicate: declared,
      },
      "Test Party",
      input,
      consentContext(),
    );
    expect(prepared.expectedPartnerDeduplicate).toBe(declared);
  }
});

test("prepareDataset: a config with no declaration binds nothing (the two-config case)", async () => {
  // An exchange both parties authored from their own documents carries no
  // declaration between them, so the partner's presented value is unconstrained
  // and the differing pair that makes one of them the "many" side still runs.
  // This party's own linkage_terms.deduplicate is NOT read as a binding.
  const input = writeInput("last_name,dob\nLovelace,1815-12-10\n");
  const prepared = await prepareDataset(
    { linkageTerms: { ...nameDobTerms, deduplicate: true } },
    "Test Party",
    input,
    consentContext(),
  );
  expect(prepared.expectedPartnerDeduplicate).toBeUndefined();
});
