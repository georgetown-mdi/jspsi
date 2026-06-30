import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, test, vi } from "vitest";
import type { Arguments } from "yargs";
import logLibrary from "loglevel";
import {
  encodeInvitation,
  getDefaultLinkageTerms,
  getLogger,
  UsageError,
} from "@psilink/core";
import type {
  ConnectionConfig,
  ConnectionEndpoint,
  InvitationToken,
  LinkageTerms,
} from "@psilink/core";

import {
  decodeAndValidateInvitation,
  displayInvitation,
  handler as acceptHandler,
  resolveAcceptPositionals,
  validateAccept,
} from "../../src/commands/accept";
import { generateSharedSecret } from "../../src/commands/bootstrap";
import type { CommonBootstrapOptions } from "../../src/commands/bootstrap";
import { saveConfig } from "../../src/config";

const silentLog = getLogger("accept-test");
silentLog.setLevel("silent");

let optionsCounter = 0;
// Minimal options pointing config/key at fresh, non-existent temp paths so the
// conflict gate passes and validateAccept reaches the step under test.
function testOptions(
  overrides: Partial<CommonBootstrapOptions> = {},
): CommonBootstrapOptions {
  const id = `${process.pid}-${optionsCounter++}`;
  return {
    configFile: path.join(tmpdir(), `psilink-accept-test-${id}.yaml`),
    keyFile: path.join(tmpdir(), `psilink-accept-test-${id}.key`),
    record: false,
    logLevel: logLibrary.levels.SILENT,
    verbosity: 0,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

function sampleToken(
  expires?: string,
  connectionEndpoint?: ConnectionEndpoint,
): InvitationToken {
  return {
    version: "1",
    linkageTerms: getDefaultLinkageTerms("Inviter Org"),
    sharedSecret: generateSharedSecret(),
    expires,
    connectionEndpoint,
  };
}

// --- offline vs online dispatch ----------------------------------------------

test("a leading invitation dispatches offline", () => {
  const r = resolveAcceptPositionals(["abc123def456ghi", "input.csv"]);
  expect(r.mode).toBe("offline");
  if (r.mode !== "offline") return;
  expect(r.invitation).toBe("abc123def456ghi");
  expect(r.input).toBe("input.csv");
});

test("a leading URL dispatches online", () => {
  const r = resolveAcceptPositionals([
    "sftp://host/drop",
    "INVITE",
    "input.csv",
    "out.csv",
  ]);
  expect(r.mode).toBe("online");
  if (r.mode !== "online") return;
  expect(r.url.hostname).toBe("host");
  expect(r.invitation).toBe("INVITE");
  expect(r.input).toBe("input.csv");
  expect(r.output).toBe("out.csv");
});

test("no positionals is a usage error", () => {
  expect(() => resolveAcceptPositionals([])).toThrow(UsageError);
  expect(() => resolveAcceptPositionals([])).toThrow("invitation is required");
});

test("online acceptance without an input file is a usage error", () => {
  expect(() =>
    resolveAcceptPositionals(["sftp://host/drop", "INVITE"]),
  ).toThrow("requires an invitation and an input file");
});

// --- a '-'-leading invitation is taken as the positional, not a flag ---------

test("an invitation beginning with '-' is parsed as the positional invitation", () => {
  const r = resolveAcceptPositionals([
    "-eyJ2ZXJzaW9uIjoiMSJ9abcDEF",
    "input.csv",
  ]);
  expect(r.mode).toBe("offline");
  if (r.mode !== "offline") return;
  expect(r.invitation).toBe("-eyJ2ZXJzaW9uIjoiMSJ9abcDEF");
  expect(r.input).toBe("input.csv");
});

// --- decode + validate (the gate before the prompt) --------------------------

test("encode/decode round-trips an invitation at the command level", async () => {
  const token = sampleToken(new Date(Date.now() + 3_600_000).toISOString());
  const encoded = await encodeInvitation(token);
  const decoded = await decodeAndValidateInvitation(encoded);
  expect(decoded.sharedSecret).toBe(token.sharedSecret);
  expect(decoded.linkageTerms.identity).toBe("Inviter Org");
  expect(decoded.linkageTerms.linkageKeys.map((k) => k.name)).toEqual(
    token.linkageTerms.linkageKeys.map((k) => k.name),
  );
});

test("a checksum mismatch is rejected (before any prompt) with a usage error", async () => {
  const encoded = await encodeInvitation(
    sampleToken(new Date(Date.now() + 3_600_000).toISOString()),
  );
  // Corrupt the final checksum character; the 4-byte checksum no longer matches.
  const last = encoded.slice(-1);
  const tampered = encoded.slice(0, -1) + (last === "A" ? "B" : "A");
  await expect(decodeAndValidateInvitation(tampered)).rejects.toBeInstanceOf(
    UsageError,
  );
  await expect(decodeAndValidateInvitation(tampered)).rejects.toThrow(
    /checksum mismatch/,
  );
});

test("a schema-invalid invitation is rejected with a usage error", async () => {
  await expect(
    decodeAndValidateInvitation("not-a-valid-invitation"),
  ).rejects.toBeInstanceOf(UsageError);
});

test("an expired invitation is rejected, naming the expiry time", async () => {
  const realNow = Date.now();
  const expires = new Date(realNow + 60_000).toISOString();
  // Encode while the token is still in the future (encodeInvitation requires it).
  const encoded = await encodeInvitation(sampleToken(expires));
  // Advance past the expiry; decode + validate must now reject by name.
  vi.useFakeTimers();
  vi.setSystemTime(new Date(realNow + 120_000));
  await expect(decodeAndValidateInvitation(encoded)).rejects.toThrow(expires);
});

// --- validateAccept (the no-commit phase, before the prompt) -----------------

test("validateAccept: an invalid invitation is rejected before the prompt", async () => {
  await expect(
    validateAccept({
      resolved: { mode: "offline", invitation: "not-a-valid-invitation" },
      options: testOptions(),
      log: silentLog,
    }),
  ).rejects.toBeInstanceOf(UsageError);
});

test("validateAccept: online rejects a missing input file before the prompt, preserving its exit code", async () => {
  const encoded = await encodeInvitation(
    sampleToken(new Date(Date.now() + 3_600_000).toISOString()),
  );
  await expect(
    validateAccept({
      resolved: {
        mode: "online",
        url: new URL("sftp://host/drop"),
        invitation: encoded,
        input: "/nonexistent/psilink-input.csv",
      },
      options: testOptions(),
      log: silentLog,
    }),
  ).rejects.toMatchObject({ exitCode: 69 });
});

// accept reads its y/N confirmation from stdin, so it cannot also take the CSV
// there. validateAccept runs before promptConfirm, so a `-` input is rejected up
// front (a UsageError naming a file path) instead of a stdin CSV starving the
// prompt into a silent EOF decline. Both positional modes pass allowStdin: false.
async function expectStdinRejection(
  resolved: Parameters<typeof validateAccept>[0]["resolved"],
): Promise<void> {
  let caught: unknown;
  try {
    await validateAccept({ resolved, options: testOptions(), log: silentLog });
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(UsageError);
  // Match the stdin-specific phrasing, not just "file path": several unrelated
  // UsageErrors on this path (e.g. config reconciliation) also mention a file
  // path, so require the stdin rejection's own wording to avoid a pass for the
  // wrong reason.
  expect((caught as Error).message).toMatch(/stdin/);
  expect((caught as Error).message).toMatch(/file path/);
}

test("validateAccept: online `-` input is rejected as a usage error before the prompt, not silently declined", async () => {
  const encoded = await encodeInvitation(
    sampleToken(new Date(Date.now() + 3_600_000).toISOString()),
  );
  await expectStdinRejection({
    mode: "online",
    url: new URL("sftp://host/drop"),
    invitation: encoded,
    input: "-",
  });
});

test("validateAccept: offline `-` input is rejected as a usage error before the prompt, not silently declined", async () => {
  const encoded = await encodeInvitation(
    sampleToken(new Date(Date.now() + 3_600_000).toISOString()),
  );
  await expectStdinRejection({
    mode: "offline",
    invitation: encoded,
    input: "-",
  });
});

test("validateAccept: an unsupported URL is rejected before the input file is read", async () => {
  const encoded = await encodeInvitation(
    sampleToken(new Date(Date.now() + 3_600_000).toISOString()),
  );
  // Both the URL is unsupported and the input file is missing; the URL is now
  // checked first (mirroring validateInvite), so the UsageError wins over the
  // file's exitCode-69 error -- proving the URL is validated before the read.
  await expect(
    validateAccept({
      resolved: {
        mode: "online",
        url: new URL("ws://host/path"),
        invitation: encoded,
        input: "/nonexistent/psilink-input.csv",
      },
      options: testOptions(),
      log: silentLog,
    }),
  ).rejects.toBeInstanceOf(UsageError);
});

// --- linkage pre-flight (block vs warn) --------------------------------------

const FUTURE = () => new Date(Date.now() + 3_600_000).toISOString();

// Write a temp CSV with the given header columns (one filler data row; the
// pre-flight reasons about column names, not values). Returns the path.
function writeInputCSV(columns: string[]): string {
  const id = `${process.pid}-${optionsCounter++}`;
  const file = path.join(tmpdir(), `psilink-accept-input-${id}.csv`);
  fs.writeFileSync(
    file,
    `${columns.join(",")}\n${columns.map(() => "x").join(",")}\n`,
  );
  return file;
}

test("validateAccept: offline blocks (UsageError) when the CSV satisfies no linkage key", async () => {
  // The default terms (from sampleToken) need ssn/last name/dob/etc.; a CSV with
  // only first_name can complete no key, so the pre-flight aborts before the
  // prompt rather than running a silent empty exchange.
  const options = testOptions();
  const input = writeInputCSV(["first_name"]);
  try {
    const encoded = await encodeInvitation(sampleToken(FUTURE()));
    await expect(
      validateAccept({
        resolved: { mode: "offline", invitation: encoded, input },
        options,
        log: silentLog,
      }),
    ).rejects.toThrow(/cannot satisfy any of the invitation's linkage keys/);
  } finally {
    fs.rmSync(input, { force: true });
  }
});

test("validateAccept: offline warns but proceeds when the CSV satisfies only some keys", async () => {
  // last/first name + dob satisfy the name+dob keys but not the ssn keys, so the
  // pre-flight warns (naming the unsatisfied fields) and the acceptance proceeds.
  const options = testOptions();
  const input = writeInputCSV(["last_name", "first_name", "dob"]);
  const log = getLogger("accept-partial-test");
  log.setLevel("silent");
  const warnSpy = vi.spyOn(log, "warn");
  try {
    const encoded = await encodeInvitation(sampleToken(FUTURE()));
    const ready = await validateAccept({
      resolved: { mode: "offline", invitation: encoded, input },
      options,
      log,
    });
    expect(ready.mode).toBe("offline");
    expect(
      warnSpy.mock.calls.some(
        (c) =>
          typeof c[0] === "string" &&
          c[0].includes(
            "cannot satisfy all of the invitation's linkage fields",
          ),
      ),
    ).toBe(true);
  } finally {
    warnSpy.mockRestore();
    fs.rmSync(input, { force: true });
  }
});

test("validateAccept: offline warns that a --server-* override is ignored", async () => {
  // The offline path builds the connection block from connectionFromEndpoint (a
  // placeholder here, since sampleToken carries no endpoint; or an endpoint seed
  // when one is present -- the warning reads only `options`, so it fires the same
  // way either way), so a --server-* override cannot take effect; it must be
  // surfaced rather than silently dropped.
  const input = writeInputCSV(["first_name", "last_name", "dob", "ssn"]);
  const log = getLogger("accept-offline-override-warn");
  log.setLevel("silent");
  const warnSpy = vi.spyOn(log, "warn");
  try {
    const encoded = await encodeInvitation(sampleToken(FUTURE()));
    const ready = await validateAccept({
      resolved: { mode: "offline", invitation: encoded, input },
      options: testOptions({ serverUsername: "alice" }),
      log,
    });
    expect(ready.mode).toBe("offline");
    expect(
      warnSpy.mock.calls.some(
        (c) =>
          typeof c[0] === "string" &&
          c[0].includes("--server-username") &&
          c[0].includes("no effect on an offline invite/accept"),
      ),
    ).toBe(true);
  } finally {
    warnSpy.mockRestore();
    fs.rmSync(input, { force: true });
  }
});

test("validateAccept: online does not warn about a --server-* override (it is applied)", async () => {
  // The online path builds the connection from the URL through
  // applyConnectionOverrides, so the override takes effect and no
  // ignored-override warning is emitted.
  const dir = fs.mkdtempSync(
    path.join(tmpdir(), "psilink-accept-online-override-"),
  );
  const input = path.join(dir, "input.csv");
  fs.writeFileSync(
    input,
    "first_name,last_name,dob,ssn\nAlice,Smith,1990-01-02,123456789\n",
  );
  const log = getLogger("accept-online-override-nowarn");
  log.setLevel("silent");
  const warnSpy = vi.spyOn(log, "warn");
  try {
    const encoded = await encodeInvitation(sampleToken(FUTURE()));
    const ready = await validateAccept({
      resolved: {
        mode: "online",
        url: new URL("sftp://host/drop"),
        invitation: encoded,
        input,
      },
      options: testOptions({
        configFile: path.join(dir, "psilink.yaml"),
        keyFile: path.join(dir, ".psilink.key"),
        serverUsername: "alice",
      }),
      log,
    });
    expect(ready.mode).toBe("online");
    if (ready.mode !== "online") return;
    if (ready.connection.channel !== "sftp") throw new Error("expected sftp");
    expect(ready.connection.server.username).toBe("alice");
    expect(
      warnSpy.mock.calls.some(
        (c) =>
          typeof c[0] === "string" &&
          c[0].includes("no effect on an offline invite/accept"),
      ),
    ).toBe(false);
  } finally {
    warnSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateAccept: offline warns that a connection-options override is ignored", async () => {
  // The offline path builds the connection block from connectionFromEndpoint
  // (placeholder or endpoint seed), which has no `options` block, so a
  // connection-options override cannot take effect; it must be surfaced with a
  // remedy pointing at connection.options, distinct from the server warning.
  const input = writeInputCSV(["first_name", "last_name", "dob", "ssn"]);
  const log = getLogger("accept-offline-opt-override-warn");
  log.setLevel("silent");
  const warnSpy = vi.spyOn(log, "warn");
  try {
    const encoded = await encodeInvitation(sampleToken(FUTURE()));
    const ready = await validateAccept({
      resolved: { mode: "offline", invitation: encoded, input },
      options: testOptions({ retainFiles: true }),
      log,
    });
    expect(ready.mode).toBe("offline");
    expect(
      warnSpy.mock.calls.some(
        (c) =>
          typeof c[0] === "string" &&
          c[0].includes("--retain-files") &&
          c[0].includes("connection.options"),
      ),
    ).toBe(true);
  } finally {
    warnSpy.mockRestore();
    fs.rmSync(input, { force: true });
  }
});

test("validateAccept: offline does not warn about connection.options when no options flag is set", async () => {
  // No connection-options flag is set, so the connection.options warning must
  // stay silent on the offline accept path.
  const input = writeInputCSV(["first_name", "last_name", "dob", "ssn"]);
  const log = getLogger("accept-offline-no-opt-warn");
  log.setLevel("silent");
  const warnSpy = vi.spyOn(log, "warn");
  try {
    const encoded = await encodeInvitation(sampleToken(FUTURE()));
    const ready = await validateAccept({
      resolved: { mode: "offline", invitation: encoded, input },
      options: testOptions(),
      log,
    });
    expect(ready.mode).toBe("offline");
    expect(
      warnSpy.mock.calls.some(
        (c) => typeof c[0] === "string" && c[0].includes("connection.options"),
      ),
    ).toBe(false);
  } finally {
    warnSpy.mockRestore();
    fs.rmSync(input, { force: true });
  }
});

test("validateAccept: online does not warn about a connection-options override (it is applied)", async () => {
  // The online path builds the connection from the URL through
  // applyConnectionOverrides, so a connection-options override takes effect and
  // no ignored-override warning is emitted.
  const dir = fs.mkdtempSync(
    path.join(tmpdir(), "psilink-accept-online-opt-override-"),
  );
  const input = path.join(dir, "input.csv");
  fs.writeFileSync(
    input,
    "first_name,last_name,dob,ssn\nAlice,Smith,1990-01-02,123456789\n",
  );
  const log = getLogger("accept-online-opt-override-nowarn");
  log.setLevel("silent");
  const warnSpy = vi.spyOn(log, "warn");
  try {
    const encoded = await encodeInvitation(sampleToken(FUTURE()));
    const ready = await validateAccept({
      resolved: {
        mode: "online",
        url: new URL("sftp://host/drop"),
        invitation: encoded,
        input,
      },
      options: testOptions({
        configFile: path.join(dir, "psilink.yaml"),
        keyFile: path.join(dir, ".psilink.key"),
        maxReconnectAttempts: 5,
      }),
      log,
    });
    expect(ready.mode).toBe("online");
    if (ready.mode !== "online") return;
    expect(ready.connection.options?.maxReconnectAttempts).toBe(5);
    expect(
      warnSpy.mock.calls.some(
        (c) => typeof c[0] === "string" && c[0].includes("connection.options"),
      ),
    ).toBe(false);
  } finally {
    warnSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateAccept: offline split-seed accept does not warn on --no-retain-files (seed forces retain on)", async () => {
  // A split-directory endpoint seeds the connection with SPLIT_SEED_OPTIONS (the
  // retain trio = true) and applies no override, so an explicit --no-retain-files
  // (retainFiles === false) is dropped and the seed's retain_files: true stands.
  // The `=== true` gate declines to warn on the negated form -- it is not an
  // enabling override, and warning would name --retain-files for a flag the
  // operator typed as --no-retain-files. This mirrors the online split path,
  // which also forces retain on and warns nothing. Pins the SPLIT_SEED_OPTIONS x
  // gate interaction the helper-level tests do not reach.
  const input = writeInputCSV(["first_name", "last_name", "dob", "ssn"]);
  const endpoint: ConnectionEndpoint = {
    channel: "sftp",
    host: "inviter-host",
    inboundPath: "/exchange/inviter-in",
    outboundPath: "/exchange/inviter-out",
  };
  const log = getLogger("accept-offline-split-seed-no-retain");
  log.setLevel("silent");
  const warnSpy = vi.spyOn(log, "warn");
  try {
    const encoded = await encodeInvitation(sampleToken(FUTURE(), endpoint));
    const ready = await validateAccept({
      resolved: { mode: "offline", invitation: encoded, input },
      options: testOptions({ retainFiles: false }),
      log,
    });
    expect(ready.mode).toBe("offline");
    if (ready.mode !== "offline") return;
    if (ready.connection.channel !== "sftp") throw new Error("expected sftp");
    // The seed forces retain on despite --no-retain-files.
    expect(ready.connection.options?.retainFiles).toBe(true);
    // No --retain-files warning: the gate declines on the negated form.
    expect(
      warnSpy.mock.calls.some(
        (c) =>
          typeof c[0] === "string" &&
          c[0].includes("--retain-files") &&
          c[0].includes("connection.options"),
      ),
    ).toBe(false);
  } finally {
    warnSpy.mockRestore();
    fs.rmSync(input, { force: true });
  }
});

// --- reconciling a pre-existing config ---------------------------------------

/** Write a config whose linkage terms agree with the invitation's by default
 *  (same default terms, identity aside), so a test perturbs only what it means
 *  to test. */
function writeExistingConfig(
  configPath: string,
  overrides: {
    terms?: LinkageTerms;
    connection?: ConnectionConfig;
  } = {},
): void {
  saveConfig(configPath, {
    connection: overrides.connection ?? {
      channel: "filedrop",
      path: "/mnt/share",
    },
    linkageTerms: overrides.terms ?? getDefaultLinkageTerms("Acceptor Org"),
  });
}

test("validateAccept: offline reuses a config whose linkage terms match the invitation", async () => {
  const options = testOptions();
  writeExistingConfig(options.configFile);
  try {
    const encoded = await encodeInvitation(sampleToken(FUTURE()));
    const ready = await validateAccept({
      resolved: { mode: "offline", invitation: encoded },
      options,
      log: silentLog,
    });
    expect(ready.reuseExistingConfig).toBe(true);
    expect(ready.mode).toBe("offline");
  } finally {
    fs.rmSync(options.configFile, { force: true });
  }
});

test("validateAccept: a matching config is reconciled but a pre-existing key file still hard-aborts", async () => {
  // The reconcile path (#61) makes a pre-existing CONFIG reusable, but a
  // pre-existing KEY file must still abort -- a stale authentication token must
  // never be silently reused. The config here matches the invitation (so on its
  // own it would be reused), proving the key gate fires independently of, and
  // ahead of, config reconciliation.
  const options = testOptions();
  writeExistingConfig(options.configFile);
  fs.writeFileSync(options.keyFile, "stale-key-file");
  try {
    const encoded = await encodeInvitation(sampleToken(FUTURE()));
    const run = () =>
      validateAccept({
        resolved: { mode: "offline", invitation: encoded },
        options,
        log: silentLog,
      });
    await expect(run()).rejects.toBeInstanceOf(UsageError);
    // The abort is the key-file overwrite refusal naming the key path, not a
    // terms diff (which would name a linkage field and the config path).
    await expect(run()).rejects.toThrow(/refusing to overwrite/);
    await expect(run()).rejects.toThrow(options.keyFile);
  } finally {
    fs.rmSync(options.configFile, { force: true });
    fs.rmSync(options.keyFile, { force: true });
  }
});

test("validateAccept: offline fails with a diff when the config's terms disagree", async () => {
  const options = testOptions();
  const terms = getDefaultLinkageTerms("Acceptor Org");
  // The invitation's algorithm is the default "psi"; make the config disagree.
  terms.algorithm = "psi-c";
  writeExistingConfig(options.configFile, { terms });
  try {
    const encoded = await encodeInvitation(sampleToken(FUTURE()));
    const run = () =>
      validateAccept({
        resolved: { mode: "offline", invitation: encoded },
        options,
        log: silentLog,
      });
    await expect(run()).rejects.toBeInstanceOf(UsageError);
    // The error names the differing field and points at the config file.
    await expect(run()).rejects.toThrow(/algorithm/);
    await expect(run()).rejects.toThrow(options.configFile);
  } finally {
    fs.rmSync(options.configFile, { force: true });
  }
});

test("validateAccept: a pre-existing config that cannot be parsed aborts with guidance", async () => {
  const options = testOptions();
  // Well-formed YAML that is not a valid exchange spec: parseExchangeSpec throws.
  fs.writeFileSync(options.configFile, "connection: 123\n");
  try {
    const encoded = await encodeInvitation(sampleToken(FUTURE()));
    await expect(
      validateAccept({
        resolved: { mode: "offline", invitation: encoded },
        options,
        log: silentLog,
      }),
    ).rejects.toThrow(/could not be parsed/);
  } finally {
    fs.rmSync(options.configFile, { force: true });
  }
});

test("validateAccept: a schema-invalid pre-existing config renders readably, not as a raw ZodError blob", async () => {
  const options = testOptions();
  // Well-formed YAML that fails schema validation: the embedded detail must be
  // the describeDecodeError one-liner (`<path>: <message>` with an `(and N
  // more)` suffix), not Zod's multi-line JSON dump of every issue.
  fs.writeFileSync(options.configFile, "connection: 123\n");
  try {
    const encoded = await encodeInvitation(sampleToken(FUTURE()));
    let message = "";
    try {
      await validateAccept({
        resolved: { mode: "offline", invitation: encoded },
        options,
        log: silentLog,
      });
    } catch (err) {
      message = (err as Error).message;
    }
    // The surrounding UsageError wrapper text is preserved.
    expect(message).toContain("could not be parsed to compare against");
    // The readable `<path>: <message>` form appears, with the multi-issue suffix.
    expect(message).toMatch(/connection: /);
    expect(message).toContain("(and 1 more)");
    // The raw multi-line ZodError JSON blob does not: no newlines, no JSON keys.
    expect(message).not.toContain("\n");
    expect(message).not.toContain('"code"');
  } finally {
    fs.rmSync(options.configFile, { force: true });
  }
});

test("validateAccept: a malformed-YAML config does not echo an inline credential", async () => {
  const options = testOptions();
  const SECRET = "S3cr3tSFTPPassw0rd";
  // Syntactically invalid YAML (an unclosed flow map) with an inline credential
  // on the offending line. YAML.parse's error embeds a snippet of the source
  // lines; the reconcile must report only the path, never that snippet, or the
  // credential leaks into the (logged) error message.
  fs.writeFileSync(
    options.configFile,
    `connection:\n  channel: sftp\n  server:\n    password: {${SECRET}\n    host: h\n`,
  );
  try {
    const encoded = await encodeInvitation(sampleToken(FUTURE()));
    let caught: unknown;
    try {
      await validateAccept({
        resolved: { mode: "offline", invitation: encoded },
        options,
        log: silentLog,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UsageError);
    expect((caught as Error).message).toMatch(/not valid YAML/);
    // The credential must not appear anywhere in the surfaced message.
    expect((caught as Error).message).not.toContain(SECRET);
  } finally {
    fs.rmSync(options.configFile, { force: true });
  }
});

test("validateAccept: online aborts (no acceptance sent) when the connection block disagrees with the URL", async () => {
  const options = testOptions();
  // Linkage terms agree; only the connection host disagrees with the URL.
  writeExistingConfig(options.configFile, {
    connection: {
      channel: "sftp",
      server: { host: "other-host", username: "alice" },
    },
  });
  try {
    const encoded = await encodeInvitation(sampleToken(FUTURE()));
    const run = () =>
      validateAccept({
        resolved: {
          mode: "online",
          url: new URL("sftp://expected-host/drop"),
          invitation: encoded,
          // Never read: the reconcile check throws before the input is loaded,
          // which is also before any network activity (so no acceptance is sent).
          input: "/nonexistent/psilink-input.csv",
        },
        options,
        log: silentLog,
      });
    await expect(run()).rejects.toBeInstanceOf(UsageError);
    await expect(run()).rejects.toThrow(/connection\.server\.host/);
  } finally {
    fs.rmSync(options.configFile, { force: true });
  }
});

test("validateAccept: online reuse warns (does not abort) on a differing --server-port override", async () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-accept-online-"));
  const input = path.join(dir, "input.csv");
  fs.writeFileSync(
    input,
    "first_name,last_name,dob,ssn\nAlice,Smith,1990-01-02,123456789\n",
  );
  const configFile = path.join(dir, "psilink.yaml");
  const keyFile = path.join(dir, ".psilink.key");
  // Terms and host (the abort fields) agree, so reconcile proceeds; only the
  // overridden port differs from the saved 22 -- a "how you reach it" detail
  // that must warn and apply, not abort.
  saveConfig(configFile, {
    connection: { channel: "sftp", server: { host: "host", port: 22 } },
    linkageTerms: getDefaultLinkageTerms("Acceptor Org"),
  });
  const log = getLogger("accept-port-warn-test");
  log.setLevel("silent");
  const warnSpy = vi.spyOn(log, "warn");
  const infoSpy = vi.spyOn(log, "info");
  try {
    const encoded = await encodeInvitation(sampleToken(FUTURE()));
    const ready = await validateAccept({
      resolved: {
        mode: "online",
        url: new URL("sftp://host"),
        invitation: encoded,
        input,
      },
      options: testOptions({ configFile, keyFile, serverPort: 2222 }),
      log,
    });
    expect(ready.reuseExistingConfig).toBe(true);
    expect(
      warnSpy.mock.calls.some(
        (c) => typeof c[0] === "string" && c[0].includes("2222"),
      ),
    ).toBe(true);
    // With connection warnings emitted, the summary must not claim the config
    // "matches" -- that would contradict the just-emitted divergence.
    expect(
      infoSpy.mock.calls.some(
        (c) => typeof c[0] === "string" && c[0].includes("matches"),
      ),
    ).toBe(false);
  } finally {
    warnSpy.mockRestore();
    infoSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- online accept: invitation-endpoint split directories --------------------

// A CSV the default linkage terms can fully satisfy, so the online path reaches
// prepareForOnlineExchange without a satisfiability abort. Returns a temp dir
// holding the input, config, and key paths (the caller removes the dir).
function onlineSplitFixture(): {
  dir: string;
  input: string;
  configFile: string;
  keyFile: string;
} {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-accept-split-"));
  const input = path.join(dir, "input.csv");
  fs.writeFileSync(
    input,
    "first_name,last_name,dob,ssn\nAlice,Smith,1990-01-02,123456789\n",
  );
  return {
    dir,
    input,
    configFile: path.join(dir, "psilink.yaml"),
    keyFile: path.join(dir, ".psilink.key"),
  };
}

test("validateAccept: online auto-applies a split endpoint's mirror-swapped directories", async () => {
  const { dir, input, configFile, keyFile } = onlineSplitFixture();
  const endpoint: ConnectionEndpoint = {
    channel: "sftp",
    host: "inviter-host",
    inboundPath: "/exchange/inviter-in",
    outboundPath: "/exchange/inviter-out",
  };
  try {
    const encoded = await encodeInvitation(sampleToken(FUTURE(), endpoint));
    const ready = await validateAccept({
      resolved: {
        mode: "online",
        // Credentials + reachable host come from the acceptor's own URL.
        url: new URL("sftp://acceptor:pw@reach-host/ignored-url-path"),
        invitation: encoded,
        input,
      },
      options: testOptions({ configFile, keyFile }),
      log: silentLog,
    });
    expect(ready.mode).toBe("online");
    if (ready.mode !== "online") return;
    const { connection } = ready;
    if (connection.channel !== "sftp") throw new Error("expected sftp");
    expect(connection.server.host).toBe("reach-host");
    expect(connection.server.username).toBe("acceptor");
    // Mirror-swapped from the endpoint (inviter outbound -> acceptor inbound);
    // the URL's single path is dropped in favor of the split pair.
    expect(connection.server.inboundPath).toBe("/exchange/inviter-out");
    expect(connection.server.outboundPath).toBe("/exchange/inviter-in");
    expect(connection.server.path).toBeUndefined();
    expect(connection.options?.retainFiles).toBe(true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateAccept: online --outbound-path overrides the endpoint's split pair", async () => {
  const { dir, input, configFile, keyFile } = onlineSplitFixture();
  const endpoint: ConnectionEndpoint = {
    channel: "sftp",
    host: "inviter-host",
    inboundPath: "/exchange/inviter-in",
    outboundPath: "/exchange/inviter-out",
  };
  try {
    const encoded = await encodeInvitation(sampleToken(FUTURE(), endpoint));
    const ready = await validateAccept({
      resolved: {
        mode: "online",
        url: new URL("sftp://reach-host/my-inbound"),
        invitation: encoded,
        input,
      },
      // Explicit --outbound-path (with the retain mode a split requires) wins:
      // the URL path is the inbound and the flag is the outbound, never the
      // endpoint's swapped pair.
      options: testOptions({
        configFile,
        keyFile,
        outboundPath: "/my-outbound",
        retainFiles: true,
      }),
      log: silentLog,
    });
    expect(ready.mode).toBe("online");
    if (ready.mode !== "online") return;
    const { connection } = ready;
    if (connection.channel !== "sftp") throw new Error("expected sftp");
    expect(connection.server.inboundPath).toBe("/my-inbound");
    expect(connection.server.outboundPath).toBe("/my-outbound");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateAccept: online is unchanged by a non-split invitation endpoint", async () => {
  const { dir, input, configFile, keyFile } = onlineSplitFixture();
  const endpoint: ConnectionEndpoint = {
    channel: "sftp",
    host: "inviter-host",
    path: "/inviter/drop",
  };
  try {
    const encoded = await encodeInvitation(sampleToken(FUTURE(), endpoint));
    const ready = await validateAccept({
      resolved: {
        mode: "online",
        url: new URL("sftp://reach-host/url-drop"),
        invitation: encoded,
        input,
      },
      options: testOptions({ configFile, keyFile }),
      log: silentLog,
    });
    expect(ready.mode).toBe("online");
    if (ready.mode !== "online") return;
    const { connection } = ready;
    if (connection.channel !== "sftp") throw new Error("expected sftp");
    // The connection is exactly what the URL builds: a single shared path, no
    // split pair, no seeded retain mode.
    expect(connection.server.path).toBe("/url-drop");
    expect(connection.server.inboundPath).toBeUndefined();
    expect(connection.server.outboundPath).toBeUndefined();
    expect(connection.options?.retainFiles).toBeUndefined();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- partner-string sanitization on the accept path --------------------------
// The invitation is crafted by the mutually-distrusting inviter; the fields it
// renders to the operator before acceptance must be escaped. These mirror the
// sanitizeForDisplay categories: control/ANSI and deceptive Unicode neutralized,
// ordinary values unchanged.

// Encodes a token WITHOUT schema validation (encodeInvitation would reject a
// malicious token), reproducing decodeInvitation's checksum + base64url framing
// so the decode path runs on attacker-shaped input.
async function encodeRaw(obj: unknown): Promise<string> {
  const toBase64Url = (b: Uint8Array): string =>
    btoa(Array.from(b, (byte) => String.fromCharCode(byte)).join(""))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  const hashBuf = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return toBase64Url(bytes) + toBase64Url(new Uint8Array(hashBuf).slice(0, 4));
}

test("decode error escapes a hostile unrecognized endpoint key name end to end", async () => {
  // A malicious inviter adds an endpoint key whose NAME carries control/ANSI
  // bytes; strictObject rejects it, echoing the name into the message that
  // decodeAndValidateInvitation surfaces to the operator as a UsageError.
  const encoded = await encodeRaw({
    ...sampleToken(FUTURE()),
    connectionEndpoint: {
      channel: "sftp",
      host: "h",
      "\x1b[2J\x1b[31mFAKE": 1,
    },
  });
  const err = await decodeAndValidateInvitation(encoded).catch(
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(UsageError);
  const msg = (err as Error).message;
  expect(msg).not.toContain("\x1b");
  expect(msg).toContain("\\x1b");
});

test("displayInvitation escapes a hostile inviter identity and key names", () => {
  const token: InvitationToken = {
    ...sampleToken(FUTURE()),
    linkageTerms: {
      ...getDefaultLinkageTerms("Inviter Org"),
      identity: "\x1b[31mEVIL‮",
      linkageKeys: [{ name: "k\x1b[0m", elements: [{ field: "ssn" }] }],
      // A hostile requested-from-you column name reaches the new "requests from
      // you" line; it must be escaped there too.
      payload: { receive: [{ name: "req\x1b[0m‮" }] },
    },
  };
  const log = getLogger("accept-display-test");
  log.setLevel("silent");
  const infoSpy = vi.spyOn(log, "info");
  try {
    displayInvitation(token, log);
    const joined = infoSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(joined).not.toContain("\x1b");
    expect(joined).not.toContain("‮");
    expect(joined).toContain("\\x1b");
    expect(joined).toContain("\\u202e");
  } finally {
    infoSpy.mockRestore();
  }
});

test("displayInvitation: the carried disclosed subset shows names, '(none)' when empty, and nothing when absent", () => {
  // The acceptor's "columns you will receive" line. A present subset is shown
  // (an empty one as "(none)", since the empty set is a real "receive nothing"
  // lock-in); an absent subset (an older or metadata-unknown mint, reconciled
  // lazily) shows no line at all.
  const log = getLogger("accept-display-receive-test");
  log.setLevel("silent");
  const lines = (token: InvitationToken): string => {
    const infoSpy = vi.spyOn(log, "info");
    try {
      displayInvitation(token, log);
      return infoSpy.mock.calls.map((c) => String(c[0])).join("\n");
    } finally {
      infoSpy.mockRestore();
    }
  };
  const base = sampleToken(FUTURE());
  expect(
    lines({ ...base, disclosedPayloadColumns: ["diagnosis", "notes"] }),
  ).toContain("columns you will receive: diagnosis, notes");
  expect(lines({ ...base, disclosedPayloadColumns: [] })).toContain(
    "columns you will receive: (none) -- any payload column would abort the exchange",
  );
  expect(lines({ ...base, disclosedPayloadColumns: undefined })).not.toContain(
    "columns you will receive",
  );
});

test("displayInvitation: the inviter's request-from-acceptor receive shows names, '(none)' when empty, and nothing when absent", () => {
  // The opposite direction from "columns you will receive": the inviter's
  // payload.receive is what it requests FROM this party. A declared receive
  // (present, even if empty) is shown -- an empty one as "(none)", since it
  // strictly asserts this party sends nothing -- while an absent receive (lazy)
  // shows no line at all. CLI counterpart of the web "requests from you" line.
  const log = getLogger("accept-display-request-test");
  log.setLevel("silent");
  const lines = (token: InvitationToken): string => {
    const infoSpy = vi.spyOn(log, "info");
    try {
      displayInvitation(token, log);
      return infoSpy.mock.calls.map((c) => String(c[0])).join("\n");
    } finally {
      infoSpy.mockRestore();
    }
  };
  const base = sampleToken(FUTURE());
  const withReceive = (
    receive: { name: string }[] | undefined,
  ): InvitationToken => ({
    ...base,
    linkageTerms: { ...base.linkageTerms, payload: { receive } },
  });
  expect(lines(withReceive([{ name: "dose" }, { name: "outcome" }]))).toContain(
    "columns the inviting party requests from you: dose, outcome",
  );
  expect(lines(withReceive([]))).toContain(
    "columns the inviting party requests from you: (none) -- any payload column would abort the exchange",
  );
  expect(lines(withReceive(undefined))).not.toContain(
    "the inviting party requests from you",
  );
});

test("displayInvitation: shows the linkage strategy and, for single-pass, the disclosure note", () => {
  const log = getLogger("accept-display-strategy-test");
  log.setLevel("silent");
  const lines = (token: InvitationToken): string => {
    const infoSpy = vi.spyOn(log, "info");
    try {
      displayInvitation(token, log);
      return infoSpy.mock.calls.map((c) => String(c[0])).join("\n");
    } finally {
      infoSpy.mockRestore();
    }
  };
  const base = sampleToken(FUTURE());
  // The default (cascade) is shown plainly, with no disclosure note.
  const cascade = lines(base);
  expect(cascade).toContain("linkage strategy: cascade");
  expect(cascade).not.toContain("consented disclosure tradeoff");
  // single-pass is the disclosure-affecting choice the acceptor consents to, so
  // it carries the shared tradeoff note (with the operator-facing doc pointer).
  const singlePass = lines({
    ...base,
    linkageTerms: { ...base.linkageTerms, linkageStrategy: "single-pass" },
  });
  expect(singlePass).toContain("linkage strategy: single-pass");
  expect(singlePass).toContain("consented disclosure tradeoff");
  expect(singlePass).toContain("docs/EXCHANGE_REFERENCE.md");
});

// --- handler: repeated single-value flag -------------------------------------

test("handler: a repeated single-value flag is rejected (exit 64) via runOrExit", async () => {
  // accept has no command-specific single-value flags; it reads them all through
  // parseCommonBootstrapArgs inside runOrExit. A repeated common flag (here
  // --server-port) is therefore rejected with a clean usage error before
  // resolveAcceptPositionals/validateAccept run. runOrExit logs the message via
  // getLogger("accept").error; spying that method is robust because the guard
  // throws inside parseCommonBootstrapArgs, before setDefaultLevel could rebind
  // the logger's methods.
  const logErr = vi
    .spyOn(getLogger("accept"), "error")
    .mockImplementation(() => {});
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  try {
    await acceptHandler({
      _: [],
      $0: "psilink",
      args: ["sftp://host/drop", "INVITATION", "input.csv"],
      "server-port": [2222, 2223],
    } as unknown as Arguments);
    // Assert before restoring the spies: mockRestore clears the recorded calls.
    expect(exit).toHaveBeenCalledWith(64);
    expect(logErr).toHaveBeenCalledWith("--server-port may be given only once");
  } finally {
    logErr.mockRestore();
    exit.mockRestore();
  }
});
