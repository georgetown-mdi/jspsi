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

function sampleToken(expires?: string): InvitationToken {
  return {
    version: "1",
    linkageTerms: getDefaultLinkageTerms("Inviter Org"),
    sharedSecret: generateSharedSecret(),
    expires,
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

test("validateAccept: `-` as the input is rejected with exit 69 before the prompt, not silently declined", async () => {
  // accept reads its y/N confirmation from stdin, so it cannot also take the CSV
  // there. validateAccept runs before promptConfirm, so the `-` rejection (exit
  // 69, naming a file path) fires up front instead of a stdin CSV starving the
  // prompt into a silent EOF decline.
  const encoded = await encodeInvitation(
    sampleToken(new Date(Date.now() + 3_600_000).toISOString()),
  );
  await expect(
    validateAccept({
      resolved: {
        mode: "online",
        url: new URL("sftp://host/drop"),
        invitation: encoded,
        input: "-",
      },
      options: testOptions(),
      log: silentLog,
    }),
  ).rejects.toMatchObject({ exitCode: 69 });
  await expect(
    validateAccept({
      resolved: {
        mode: "online",
        url: new URL("sftp://host/drop"),
        invitation: encoded,
        input: "-",
      },
      options: testOptions(),
      log: silentLog,
    }),
  ).rejects.toThrow(/file path/);
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

// --- reconciling a pre-existing config ---------------------------------------

const FUTURE = () => new Date(Date.now() + 3_600_000).toISOString();

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
