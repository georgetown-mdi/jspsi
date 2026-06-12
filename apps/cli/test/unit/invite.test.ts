import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, test, vi } from "vitest";
import type { Arguments } from "yargs";
import logLibrary from "loglevel";
import {
  decodeInvitation,
  getDefaultLinkageTerms,
  getLogger,
  inferMetadata,
  UsageError,
} from "@psilink/core";
import type { LinkageTerms, Standardization } from "@psilink/core";

import {
  handler as inviteHandler,
  offlineAbandonNotice,
  onlineWaitInvalidationNotice,
  resolveInvitePositionals,
  validateInvite,
} from "../../src/commands/invite";
import { saveConfig } from "../../src/config";
import type { CommonBootstrapOptions } from "../../src/commands/bootstrap";

const silentLog = getLogger("invite-test");
silentLog.setLevel("silent");

let optionsCounter = 0;
// Minimal options pointing config/key at fresh, non-existent temp paths so the
// conflict gate passes and validateInvite reaches the step under test.
function testOptions(
  overrides: Partial<CommonBootstrapOptions> = {},
): CommonBootstrapOptions {
  const id = `${process.pid}-${optionsCounter++}`;
  return {
    configFile: path.join(tmpdir(), `psilink-invite-test-${id}.yaml`),
    keyFile: path.join(tmpdir(), `psilink-invite-test-${id}.key`),
    record: false,
    logLevel: logLibrary.levels.SILENT,
    verbosity: 0,
    ...overrides,
  };
}

// --- offline vs online dispatch ----------------------------------------------

test("no positionals dispatches offline with no input file", () => {
  const r = resolveInvitePositionals([]);
  expect(r.mode).toBe("offline");
  if (r.mode !== "offline") return;
  expect(r.input).toBeUndefined();
});

test("a lone input file dispatches offline", () => {
  const r = resolveInvitePositionals(["input.csv"]);
  expect(r.mode).toBe("offline");
  if (r.mode !== "offline") return;
  expect(r.input).toBe("input.csv");
});

test("a leading URL dispatches online with input and output", () => {
  const r = resolveInvitePositionals([
    "sftp://host/drop",
    "input.csv",
    "out.csv",
  ]);
  expect(r.mode).toBe("online");
  if (r.mode !== "online") return;
  expect(r.url.hostname).toBe("host");
  expect(r.input).toBe("input.csv");
  expect(r.output).toBe("out.csv");
});

test("an online invitation without an input file is a usage error", () => {
  expect(() => resolveInvitePositionals(["sftp://host/drop"])).toThrow(
    UsageError,
  );
  expect(() => resolveInvitePositionals(["sftp://host/drop"])).toThrow(
    "requires an input file",
  );
});

// --- validateInvite (the no-commit phase) ------------------------------------

test("validateInvite: an unsupported (webrtc) URL is rejected with no side effect", async () => {
  // Online dispatch validates the URL before reading input or minting a token,
  // so an unrunnable scheme aborts before the caller can disclose anything.
  await expect(
    validateInvite({
      resolved: {
        mode: "online",
        url: new URL("ws://host/path"),
        input: "input.csv",
      },
      options: testOptions(),
      acceptTimeout: 900,
      log: silentLog,
    }),
  ).rejects.toBeInstanceOf(UsageError);
});

test("validateInvite: offline rejects a missing input file, preserving its exit code", async () => {
  await expect(
    validateInvite({
      resolved: { mode: "offline", input: "/nonexistent/psilink-input.csv" },
      options: testOptions(),
      acceptTimeout: 900,
      log: silentLog,
    }),
  ).rejects.toMatchObject({ exitCode: 69 });
});

test("validateInvite: offline requires an input file", async () => {
  await expect(
    validateInvite({
      resolved: { mode: "offline" },
      options: testOptions(),
      acceptTimeout: 900,
      log: silentLog,
    }),
  ).rejects.toBeInstanceOf(UsageError);
});

test("validateInvite: a non-positive accept-timeout is rejected", async () => {
  await expect(
    validateInvite({
      resolved: {
        mode: "online",
        url: new URL("sftp://host/drop"),
        input: "input.csv",
      },
      options: testOptions(),
      acceptTimeout: 0,
      log: silentLog,
    }),
  ).rejects.toBeInstanceOf(UsageError);
});

// --- onlineWaitInvalidationNotice --------------------------------------------

test("onlineWaitInvalidationNotice: states the invitation is void on cancel/timeout and points at re-invite", () => {
  const notice = onlineWaitInvalidationNotice(900);
  // The accept-timeout bound is surfaced so the user knows how long the wait lasts.
  expect(notice).toContain("900s");
  // Each pre-acceptance exit that voids the invitation is named.
  expect(notice).toContain("Ctrl-C");
  expect(notice).toContain("connection times out");
  expect(notice).toContain("accept-timeout");
  // The consequence and the recovery: the invitation is unusable; re-invite.
  expect(notice).toContain("can no longer be accepted");
  expect(notice).toContain("psilink invite");
});

// --- offlineAbandonNotice ----------------------------------------------------

test("offlineAbandonNotice: names the key file as the early-abandonment path and spares the config", () => {
  const keyPath = "/tmp/agency-a/.psilink.key";
  const notice = offlineAbandonNotice(keyPath);
  // The actionable path -- delete this specific key file -- is named verbatim.
  expect(notice).toContain(keyPath);
  expect(notice).toContain("delete the key file");
  // The consequence: the abandoned invitation cannot complete a handshake.
  expect(notice).toContain("can no longer complete a handshake");
  // The config-safety promise (acceptance criterion: abandonment leaves an
  // existing recurring exchange's configuration intact) is stated.
  expect(notice).toContain("only the key file");
  expect(notice).toContain("configuration");
});

// --- pre-existing config/key on the online path ------------------------------

// 43-char base64url token satisfying the key-file format constraint.
const KEY_TOKEN = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

/** A scratch directory with a small valid CSV; config/key default to fresh
 *  (non-existent) paths inside it so each test can occupy just what it needs. */
function onlineFixture(): { input: string; options: CommonBootstrapOptions } {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-invite-online-"));
  tmpDirs.push(dir);
  const input = path.join(dir, "input.csv");
  fs.writeFileSync(
    input,
    "first_name,last_name,dob,ssn\nAlice,Smith,1990-01-02,123456789\n",
  );
  return {
    input,
    options: testOptions({
      configFile: path.join(dir, "psilink.yaml"),
      keyFile: path.join(dir, ".psilink.key"),
    }),
  };
}

test("validateInvite: online warns (does not error) on a pre-existing key file", async () => {
  const { input, options } = onlineFixture();
  fs.writeFileSync(
    options.keyFile,
    JSON.stringify({ sharedSecret: KEY_TOKEN }),
  );
  const log = getLogger("invite-key-warn-test");
  log.setLevel("silent");
  const warnSpy = vi.spyOn(log, "warn");
  // Completes without throwing: the pre-existing key is a warning on this path.
  await validateInvite({
    resolved: { mode: "online", url: new URL("sftp://host/drop"), input },
    options,
    acceptTimeout: 900,
    log,
  });
  expect(
    warnSpy.mock.calls.some(
      (c) =>
        typeof c[0] === "string" && c[0].includes("key file already exists"),
    ),
  ).toBe(true);
  warnSpy.mockRestore();
});

test("validateInvite: online still aborts on a pre-existing config file", async () => {
  const { input, options } = onlineFixture();
  fs.writeFileSync(options.configFile, "channel: filedrop\npath: /mnt/share\n");
  // A pre-existing config remains a hard conflict for invite (reusing it as the
  // terms source is a separate task); the config gate runs before the input read.
  await expect(
    validateInvite({
      resolved: { mode: "online", url: new URL("sftp://host/drop"), input },
      options,
      acceptTimeout: 900,
      log: silentLog,
    }),
  ).rejects.toThrow(options.configFile);
});

// --- validateInvite: offline, config as the linkage-terms source -------------

// Terms an inviter's config would carry after being generated from an input
// with first/last name, dob, and ssn columns: passing that metadata drops the
// default keys (and the ssn4 field) the input cannot satisfy, so the terms
// reference exactly firstName, lastName, dateOfBirth, and ssn.
function defaultTerms(): LinkageTerms {
  return getDefaultLinkageTerms(
    "Agency A",
    inferMetadata(["first_name", "last_name", "dob", "ssn"]),
  );
}

// A pre-existing config carrying `terms` (and optionally an explicit
// `standardization`) is written to a temp dir; the helper returns the paths so a
// test can point its options at them. The connection is a placeholder -- invite
// does not use it.
function withConfig(
  terms: LinkageTerms,
  standardization?: Standardization,
): { dir: string; configPath: string; keyPath: string } {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-invite-cfg-"));
  const configPath = path.join(dir, "psilink.yaml");
  saveConfig(configPath, {
    connection: { channel: "filedrop", path: "/mnt/share" },
    linkageTerms: terms,
    ...(standardization !== undefined && { standardization }),
  });
  return { dir, configPath, keyPath: path.join(dir, ".psilink.key") };
}

function writeCsv(dir: string, header: string): string {
  const p = path.join(dir, "input.csv");
  fs.writeFileSync(p, `${header}\nAlice,Smith,1990-01-02,123456789\n`);
  return p;
}

test("validateInvite: derives terms from a config when no input file is given", async () => {
  const terms = defaultTerms();
  const { dir, configPath, keyPath } = withConfig(terms);
  try {
    const ready = await validateInvite({
      resolved: { mode: "offline" },
      options: testOptions({ configFile: configPath, keyFile: keyPath }),
      acceptTimeout: 900,
      log: silentLog,
    });
    expect(ready.mode).toBe("offlineFromConfig");
    if (ready.mode !== "offlineFromConfig") return;
    expect(ready.configPath).toBe(configPath);
    expect(ready.linkageTerms).toEqual(terms);
    // The minted invitation carries the config's terms, not inferred ones.
    const token = await decodeInvitation(ready.invitation);
    expect(token.linkageTerms).toEqual(terms);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateInvite: a config plus an agreeing input file succeeds from the config", async () => {
  const terms = defaultTerms();
  const { dir, configPath, keyPath } = withConfig(terms);
  try {
    const input = writeCsv(dir, "first_name,last_name,dob,ssn");
    const ready = await validateInvite({
      resolved: { mode: "offline", input },
      options: testOptions({ configFile: configPath, keyFile: keyPath }),
      acceptTimeout: 900,
      log: silentLog,
    });
    expect(ready.mode).toBe("offlineFromConfig");
    if (ready.mode !== "offlineFromConfig") return;
    expect(ready.linkageTerms).toEqual(terms);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateInvite: a config plus a disagreeing input fails naming the unsatisfiable fields", async () => {
  const terms = defaultTerms();
  const { dir, configPath, keyPath } = withConfig(terms);
  try {
    // Only a first-name column: last name, dob, and ssn cannot be produced.
    const input = writeCsv(dir, "first_name,notes,memo,comment");
    const promise = validateInvite({
      resolved: { mode: "offline", input },
      options: testOptions({ configFile: configPath, keyFile: keyPath }),
      acceptTimeout: 900,
      log: silentLog,
    });
    await expect(promise).rejects.toBeInstanceOf(UsageError);
    await expect(promise).rejects.toThrow(/lastName/);
    await expect(promise).rejects.toThrow(/cannot satisfy/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateInvite: a config's explicit standardization lets an otherwise-unsatisfying input pass", async () => {
  const terms = defaultTerms();
  // The config maps tax_id -> ssn explicitly; the input carries tax_id (inferred
  // as an identifier, not ssn) rather than an ssn column, so without the
  // standardization the ssn field would be unsatisfiable.
  const { dir, configPath, keyPath } = withConfig(terms, [
    {
      output: "ssn",
      input: "tax_id",
      steps: [{ function: "trim_whitespace" }],
    },
  ]);
  try {
    const input = writeCsv(dir, "first_name,last_name,dob,tax_id");
    const ready = await validateInvite({
      resolved: { mode: "offline", input },
      options: testOptions({ configFile: configPath, keyFile: keyPath }),
      acceptTimeout: 900,
      log: silentLog,
    });
    expect(ready.mode).toBe("offlineFromConfig");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateInvite: config-sourced invite still refuses a pre-existing key file", async () => {
  const terms = defaultTerms();
  const { dir, configPath, keyPath } = withConfig(terms);
  try {
    fs.writeFileSync(
      keyPath,
      JSON.stringify({
        sharedSecret: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      }),
    );
    await expect(
      validateInvite({
        resolved: { mode: "offline" },
        options: testOptions({ configFile: configPath, keyFile: keyPath }),
        acceptTimeout: 900,
        log: silentLog,
      }),
    ).rejects.toBeInstanceOf(UsageError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateInvite: with no config and an input file, terms are inferred and written", async () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-invite-infer-"));
  try {
    const input = writeCsv(dir, "first_name,last_name,dob,ssn");
    const ready = await validateInvite({
      resolved: { mode: "offline", input },
      // Fresh, non-existent config/key paths: the input-only inference path.
      options: testOptions(),
      acceptTimeout: 900,
      log: silentLog,
    });
    expect(ready.mode).toBe("offline");
    if (ready.mode !== "offline") return;
    expect(ready.dataSpec.linkageTerms.identity).toBeTypeOf("string");
    expect(ready.dataSpec.metadata).toBeDefined();
    expect(ready.dataSpec.standardization).toBeDefined();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- validateInvite: --expires-in override -----------------------------------

test("validateInvite: --expires-in sets the token's expiry to the override", async () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-invite-expires-"));
  tmpDirs.push(dir);
  const input = writeCsv(dir, "first_name,last_name,dob,ssn");
  const before = Date.now();
  const ready = await validateInvite({
    resolved: { mode: "offline", input },
    options: testOptions({
      configFile: path.join(dir, "psilink.yaml"),
      keyFile: path.join(dir, ".psilink.key"),
    }),
    acceptTimeout: 900,
    expiresIn: "2h",
    log: silentLog,
  });
  const after = Date.now();
  const token = await decodeInvitation(ready.invitation);
  expect(token.expires).toBeDefined();
  if (token.expires === undefined) return;
  // The expiry is two hours past the moment the token was minted, which lies in
  // [before, after]; bound it on both sides rather than assert an exact value.
  const twoHours = 2 * 60 * 60 * 1000;
  const expiresMs = new Date(token.expires).getTime();
  expect(expiresMs).toBeGreaterThanOrEqual(before + twoHours);
  expect(expiresMs).toBeLessThanOrEqual(after + twoHours);
});

test("validateInvite: omitting --expires-in keeps the one-hour default", async () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-invite-default-"));
  tmpDirs.push(dir);
  const input = writeCsv(dir, "first_name,last_name,dob,ssn");
  const before = Date.now();
  const ready = await validateInvite({
    resolved: { mode: "offline", input },
    options: testOptions({
      configFile: path.join(dir, "psilink.yaml"),
      keyFile: path.join(dir, ".psilink.key"),
    }),
    acceptTimeout: 900,
    log: silentLog,
  });
  const after = Date.now();
  const token = await decodeInvitation(ready.invitation);
  expect(token.expires).toBeDefined();
  if (token.expires === undefined) return;
  const oneHour = 60 * 60 * 1000;
  const expiresMs = new Date(token.expires).getTime();
  expect(expiresMs).toBeGreaterThanOrEqual(before + oneHour);
  expect(expiresMs).toBeLessThanOrEqual(after + oneHour);
});

test("validateInvite: a zero --expires-in is rejected before any token is minted", async () => {
  // A non-existent input would itself error once read; the duration is parsed at
  // the very top of validateInvite, so the duration rejection -- not the missing
  // input -- is what surfaces, proving no token is minted on a bad override.
  const promise = validateInvite({
    resolved: { mode: "offline", input: "/nonexistent/psilink-input.csv" },
    options: testOptions(),
    acceptTimeout: 900,
    expiresIn: "0m",
    log: silentLog,
  });
  await expect(promise).rejects.toBeInstanceOf(UsageError);
  await expect(promise).rejects.toThrow(/duration/);
});

test("validateInvite: an --expires-in beyond the one-year maximum is rejected before any token is minted", async () => {
  // Nonexistent input, as in the zero case: the override is bounded at the top
  // of validateInvite, so the ceiling rejection -- not the missing input -- is
  // what surfaces, proving no token is minted.
  const promise = validateInvite({
    resolved: { mode: "offline", input: "/nonexistent/psilink-input.csv" },
    options: testOptions(),
    acceptTimeout: 900,
    expiresIn: "366d",
    log: silentLog,
  });
  await expect(promise).rejects.toBeInstanceOf(UsageError);
  await expect(promise).rejects.toThrow(/expires-in must not exceed/);
});

test("validateInvite: an --expires-in at the one-year maximum is accepted", async () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-invite-max-"));
  tmpDirs.push(dir);
  const input = writeCsv(dir, "first_name,last_name,dob,ssn");
  const before = Date.now();
  const ready = await validateInvite({
    resolved: { mode: "offline", input },
    options: testOptions({
      configFile: path.join(dir, "psilink.yaml"),
      keyFile: path.join(dir, ".psilink.key"),
    }),
    acceptTimeout: 900,
    expiresIn: "365d",
    log: silentLog,
  });
  const after = Date.now();
  const token = await decodeInvitation(ready.invitation);
  expect(token.expires).toBeDefined();
  if (token.expires === undefined) return;
  const oneYear = 365 * 24 * 60 * 60 * 1000;
  const expiresMs = new Date(token.expires).getTime();
  expect(expiresMs).toBeGreaterThanOrEqual(before + oneYear);
  expect(expiresMs).toBeLessThanOrEqual(after + oneYear);
});

test("validateInvite: --expires-in applies on the offlineFromConfig path", async () => {
  const terms = defaultTerms();
  const { dir, configPath, keyPath } = withConfig(terms);
  try {
    const before = Date.now();
    const ready = await validateInvite({
      resolved: { mode: "offline" },
      options: testOptions({ configFile: configPath, keyFile: keyPath }),
      acceptTimeout: 900,
      expiresIn: "2h",
      log: silentLog,
    });
    const after = Date.now();
    expect(ready.mode).toBe("offlineFromConfig");
    const token = await decodeInvitation(ready.invitation);
    expect(token.expires).toBeDefined();
    if (token.expires === undefined) return;
    const twoHours = 2 * 60 * 60 * 1000;
    const expiresMs = new Date(token.expires).getTime();
    expect(expiresMs).toBeGreaterThanOrEqual(before + twoHours);
    expect(expiresMs).toBeLessThanOrEqual(after + twoHours);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateInvite: online warns when --expires-in is shorter than --accept-timeout", async () => {
  const { input, options } = onlineFixture();
  const log = getLogger("invite-lifetime-warn-test");
  log.setLevel("silent");
  const warnSpy = vi.spyOn(log, "warn");
  // 5m lifetime under a 15m accept-timeout: the inviter would wait past the
  // point the token can be honored, so the warning fires and names the resolved
  // override lifetime (300s), not the default hour.
  await validateInvite({
    resolved: { mode: "online", url: new URL("sftp://host/drop"), input },
    options,
    acceptTimeout: 900,
    expiresIn: "5m",
    log,
  });
  expect(
    warnSpy.mock.calls.some(
      (c) =>
        typeof c[0] === "string" &&
        c[0].includes("exceeds the invitation") &&
        c[0].includes("(300s)"),
    ),
  ).toBe(true);
  warnSpy.mockRestore();
});

// --- handler: repeated single-value flag -------------------------------------

test("handler: a repeated --accept-timeout is rejected (exit 64) before validation runs", async () => {
  // The concrete instance `psilink invite --accept-timeout 60 --accept-timeout
  // 120`: the handler reads accept-timeout via singleValue before
  // resolveInvitePositionals/validateInvite, so the repeat fails with a clean
  // usage error (exit 64) instead of reaching the `acceptTimeout <= 0` /
  // `acceptTimeout > lifetimeSeconds` comparisons in validateInvite with an array
  // operand. A valid input file is present, so without the guard validateInvite
  // would mint and print the token and write both files; the guard means none of
  // that happens -- which is exactly what the assertions below check.
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-invite-dup-"));
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  try {
    const input = writeCsv(dir, "first_name,last_name,dob,ssn");
    const configFile = path.join(dir, "psilink.yaml");
    const keyFile = path.join(dir, ".psilink.key");
    await inviteHandler({
      _: [],
      $0: "psilink",
      args: [input],
      "accept-timeout": [60, 120],
      "config-file": configFile,
      "key-file": keyFile,
      "log-level": "silent",
      record: false,
    } as unknown as Arguments);
    // Assert before restoring the spies: mockRestore clears the recorded calls.
    expect(exit).toHaveBeenCalledWith(64);
    // No invitation token reached stdout and neither file was written, so
    // validateInvite (and the commit that follows it) never ran.
    expect(logSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(configFile)).toBe(false);
    expect(fs.existsSync(keyFile)).toBe(false);
  } finally {
    logSpy.mockRestore();
    exit.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
