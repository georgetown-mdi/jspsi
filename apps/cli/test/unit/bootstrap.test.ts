import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test, vi } from "vitest";
import type { Arguments } from "yargs";
import { getLogger, PAKE_TOKEN_REGEX, UsageError } from "@psilink/core";
import type {
  ConnectionConfig,
  ConnectionEndpoint,
  PreparedExchange,
} from "@psilink/core";

import {
  buildDataSpec,
  connectionFromEndpoint,
  connectionFromURL,
  diffConnectionAgainstTarget,
  generatePakeToken,
  logOnlineBootstrapOutcome,
  looksLikeUrl,
  parseCommonBootstrapArgs,
  redactUrlCredentials,
  runOnlineBootstrap,
  runOrExit,
  type RunnableConnectionConfig,
} from "../../src/commands/bootstrap";
import { runProtocol } from "../../src/protocol";

// runOnlineBootstrap's config-persistence tests below drive its wiring without
// opening a connection: runProtocol is mocked so each test chooses whether the
// handshake "succeeds" (the mock invokes onAuthenticated) before it resolves or
// rejects. saveConfig is left real, so the assertions check the actual file.
vi.mock("../../src/protocol", () => ({
  runProtocol: vi.fn(),
}));

// runOrExit creates its error logger by name; silence that name so the
// error-path tests below don't print to the console.
getLogger("bootstrap-test").setLevel("silent");

// --- looksLikeUrl ------------------------------------------------------------

test("looksLikeUrl: supported transport schemes are URLs", () => {
  expect(looksLikeUrl("sftp://host/path")).toBe(true);
  expect(looksLikeUrl("ssh://host/path")).toBe(true);
  expect(looksLikeUrl("ws://host/path")).toBe(true);
  expect(looksLikeUrl("wss://host/path")).toBe(true);
  expect(looksLikeUrl("file:///mnt/share")).toBe(true);
});

test("looksLikeUrl: files, invitations, and other schemes are not URLs", () => {
  expect(looksLikeUrl("input.csv")).toBe(false);
  expect(looksLikeUrl("./data/input.csv")).toBe(false);
  expect(looksLikeUrl("@invitation.txt")).toBe(false);
  // A base64url invitation, including one beginning with '-'.
  expect(looksLikeUrl("-eyJ2ZXJzaW9uIjoiMSJ9abc")).toBe(false);
  // A Windows drive path must not be mistaken for a URL with scheme "c:".
  expect(looksLikeUrl("C:\\data\\input.csv")).toBe(false);
  expect(looksLikeUrl("https://example.org")).toBe(false);
});

// --- connectionFromURL -------------------------------------------------------

test("connectionFromURL: sftp URL maps to an sftp connection", () => {
  const conn = connectionFromURL(new URL("sftp://alice@host:2222/drop"), {});
  expect(conn.channel).toBe("sftp");
  if (conn.channel !== "sftp") return;
  expect(conn.server.host).toBe("host");
  expect(conn.server.port).toBe(2222);
  expect(conn.server.username).toBe("alice");
});

test("connectionFromURL: file URL maps to a filedrop connection", () => {
  const conn = connectionFromURL(new URL("file:///mnt/share/drop"), {});
  expect(conn.channel).toBe("filedrop");
  if (conn.channel !== "filedrop") return;
  expect(conn.path).toBe("/mnt/share/drop");
});

test("connectionFromURL: a webrtc (ws) URL is a usage error", () => {
  expect(() => connectionFromURL(new URL("ws://host/path"), {})).toThrow(
    UsageError,
  );
  expect(() => connectionFromURL(new URL("ws://host/path"), {})).toThrow(
    "not yet supported",
  );
});

test("connectionFromURL: a bare-host sftp URL leaves the path unset", () => {
  for (const raw of ["sftp://host", "sftp://host/"]) {
    const conn = connectionFromURL(new URL(raw), {});
    expect(conn.channel).toBe("sftp");
    if (conn.channel !== "sftp") return;
    // A trailing "/" must not be pinned as the remote path; the server's default
    // working directory is used instead.
    expect(conn.server.path).toBeUndefined();
  }
});

test("connectionFromURL: an sftp URL with no host is a usage error", () => {
  expect(() => connectionFromURL(new URL("sftp:///drop"), {})).toThrow(
    UsageError,
  );
  expect(() => connectionFromURL(new URL("sftp:///drop"), {})).toThrow(
    /must include a host/,
  );
});

// --- redactUrlCredentials ----------------------------------------------------

test("redactUrlCredentials: strips an embedded password and username", () => {
  const redacted = redactUrlCredentials(
    new URL("sftp://alice:s3cr3t@host:2222/drop"),
  );
  expect(redacted).not.toContain("s3cr3t");
  expect(redacted).not.toContain("alice");
  expect(redacted).toContain("host");
  expect(redacted).toContain("2222");
  expect(redacted).toContain("/drop");
});

test("redactUrlCredentials: a credential-free URL is unchanged", () => {
  const redacted = redactUrlCredentials(new URL("sftp://host:2222/drop"));
  expect(redacted).toBe("sftp://host:2222/drop");
});

// --- runOrExit ---------------------------------------------------------------

test("runOrExit: a UsageError exits 64", async () => {
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  await runOrExit("bootstrap-test", async () => {
    throw new UsageError("bad usage");
  });
  expect(exit).toHaveBeenCalledWith(64);
  exit.mockRestore();
});

test("runOrExit: a non-UsageError preserves its own exitCode (not collapsed to 69)", async () => {
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  await runOrExit("bootstrap-test", async () => {
    // A distinctive code (not 69) proves the `?? exitCode` rung is preserved,
    // so a missing input file keeps its own exit code instead of becoming 69.
    throw Object.assign(new Error("input file not found"), { exitCode: 66 });
  });
  expect(exit).toHaveBeenCalledWith(66);
  exit.mockRestore();
});

test("runOrExit: an error without an exitCode defaults to 69", async () => {
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  await runOrExit("bootstrap-test", async () => {
    throw new Error("transport failure");
  });
  expect(exit).toHaveBeenCalledWith(69);
  exit.mockRestore();
});

test("runOrExit: a rejected body (e.g. a stdin/prompt error) exits cleanly, never throwing", async () => {
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  // A readline rejection mid-prompt is just a rejected promise inside the body;
  // runOrExit maps it to an exit rather than letting it crash unhandled.
  await expect(
    runOrExit("bootstrap-test", async () => {
      await Promise.reject(new Error("stdin closed"));
    }),
  ).resolves.toBeUndefined();
  expect(exit).toHaveBeenCalledWith(69);
  exit.mockRestore();
});

test("parseCommonBootstrapArgs: an unrecognized log-level is a usage error", () => {
  // Routed through runOrExit by the handlers, so a UsageError exits 64 via the
  // consistent error path rather than yargs's noisier top-level catch.
  expect(() =>
    parseCommonBootstrapArgs({
      _: [],
      $0: "psilink",
      "log-level": "bogus",
    } as unknown as Arguments),
  ).toThrow(UsageError);
});

test("runOrExit: a successful body does not exit", async () => {
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  let ran = false;
  await runOrExit("bootstrap-test", async () => {
    ran = true;
  });
  expect(ran).toBe(true);
  expect(exit).not.toHaveBeenCalled();
  exit.mockRestore();
});

// --- connectionFromEndpoint --------------------------------------------------

test("connectionFromEndpoint: no endpoint yields a marked sftp placeholder", () => {
  const { connection, seeded } = connectionFromEndpoint(undefined);
  expect(seeded).toBe(false);
  expect(connection.channel).toBe("sftp");
  if (connection.channel !== "sftp") return;
  expect(connection.server.host).toMatch(/REPLACE_WITH/);
  expect(connection.server.username).toMatch(/REPLACE_WITH/);
});

test("connectionFromEndpoint: an sftp endpoint seeds the locator, marks credentials", () => {
  const endpoint: ConnectionEndpoint = {
    channel: "sftp",
    host: "sftp.example.org",
    port: 2222,
    path: "/exchanges/drop",
  };
  const { connection, seeded } = connectionFromEndpoint(endpoint);
  expect(seeded).toBe(true);
  expect(connection.channel).toBe("sftp");
  if (connection.channel !== "sftp") return;
  expect(connection.server.host).toBe("sftp.example.org");
  expect(connection.server.port).toBe(2222);
  expect(connection.server.path).toBe("/exchanges/drop");
  // The endpoint never carries credentials; the username is a fill-in marker.
  expect(connection.server.username).toMatch(/REPLACE_WITH/);
  expect(connection.server.password).toBeUndefined();
});

test("connectionFromEndpoint: a filedrop endpoint seeds the shared path", () => {
  const endpoint: ConnectionEndpoint = {
    channel: "filedrop",
    path: "/mnt/share/drop",
  };
  const { connection, seeded } = connectionFromEndpoint(endpoint);
  expect(seeded).toBe(true);
  expect(connection.channel).toBe("filedrop");
  if (connection.channel !== "filedrop") return;
  expect(connection.path).toBe("/mnt/share/drop");
});

test("connectionFromEndpoint: a webrtc endpoint seeds the signaling locator", () => {
  const endpoint: ConnectionEndpoint = {
    channel: "webrtc",
    host: "peer.example.org",
    path: "/psi",
  };
  const { connection, seeded } = connectionFromEndpoint(endpoint);
  expect(seeded).toBe(true);
  expect(connection.channel).toBe("webrtc");
  if (connection.channel !== "webrtc") return;
  expect(connection.server.host).toBe("peer.example.org");
  expect(connection.server.path).toBe("/psi");
});

// --- generatePakeToken -------------------------------------------------------

test("generatePakeToken: matches the PAKE token format and is non-deterministic", () => {
  const a = generatePakeToken();
  const b = generatePakeToken();
  expect(a).toMatch(PAKE_TOKEN_REGEX);
  expect(b).toMatch(PAKE_TOKEN_REGEX);
  expect(a).not.toBe(b);
});

// --- buildDataSpec -----------------------------------------------------------

const COLUMNS = ["first_name", "last_name", "dob", "ssn"];
const ROWS = {
  rawRows: [
    {
      first_name: "Alice",
      last_name: "Smith",
      dob: "1990-01-02",
      ssn: "123456789",
    },
  ],
  columns: COLUMNS,
};

test("buildDataSpec: infers linkage terms, metadata, and standardization from input (invite)", () => {
  const { dataSpec, warnings } = buildDataSpec({
    identity: "Agency A",
    rows: ROWS,
  });
  expect(warnings).toEqual([]);
  expect(dataSpec.linkageTerms.identity).toBe("Agency A");
  expect(dataSpec.linkageTerms.linkageKeys.length).toBeGreaterThan(0);
  expect(dataSpec.metadata).toBeDefined();
  expect(dataSpec.standardization).toBeDefined();
});

test("buildDataSpec: without input rows, the spec is just the supplied terms (accept)", () => {
  const { dataSpec } = buildDataSpec({
    identity: "Agency B",
    rows: ROWS,
  });
  // Reuse the inferred terms as a stand-in for an invitation's terms.
  const { dataSpec: termsOnly } = buildDataSpec({
    terms: dataSpec.linkageTerms,
    identity: "Agency B",
  });
  expect(termsOnly.linkageTerms).toEqual(dataSpec.linkageTerms);
  expect(termsOnly.metadata).toBeUndefined();
  expect(termsOnly.standardization).toBeUndefined();
});

test("buildDataSpec: supplied terms plus input infer metadata and standardization (accept)", () => {
  const { dataSpec: inferred } = buildDataSpec({
    identity: "Agency C",
    rows: ROWS,
  });
  const { dataSpec, warnings } = buildDataSpec({
    terms: inferred.linkageTerms,
    identity: "Agency C",
    rows: ROWS,
  });
  expect(warnings).toEqual([]);
  expect(dataSpec.linkageTerms).toEqual(inferred.linkageTerms);
  expect(dataSpec.metadata).toBeDefined();
  expect(dataSpec.standardization).toBeDefined();
});

// --- runOnlineBootstrap: config persisted at handshake success ---------------

/** Minimal valid params for runOnlineBootstrap; runProtocol is mocked, so the
 *  connection/prepared/key fields are never exercised against a real transport.
 */
function onlineBootstrapParams(
  configPath: string,
): Parameters<typeof runOnlineBootstrap>[0] {
  const { dataSpec } = buildDataSpec({ identity: "Agency A", rows: ROWS });
  const connection: RunnableConnectionConfig = {
    channel: "filedrop",
    path: "/tmp/psilink-drop",
  };
  return {
    connection,
    dataSpec,
    prepared: {} as unknown as PreparedExchange,
    pakeToken: generatePakeToken(),
    expires: undefined,
    keyPath: path.join(path.dirname(configPath), ".psilink.key"),
    configPath,
    output: undefined,
    verbosity: -1,
    loggerName: "bootstrap-test",
    recordOutput: undefined,
  };
}

test("runOnlineBootstrap writes the config from the hook even when the exchange then fails", async () => {
  // Handshake succeeds (runProtocol invokes onAuthenticated -> saveConfig), then
  // the data exchange fails. The config must already be on disk so the
  // recurring-exchange setup is recoverable without re-inviting.
  vi.mocked(runProtocol).mockImplementation((async (...callArgs: unknown[]) => {
    // Locate the onAuthenticated hook among the call arguments by type, not
    // position. Asserting exactly one function argument makes the mock fail
    // loudly if a second function-typed parameter is ever added to runProtocol
    // (in any position) rather than silently selecting the wrong one.
    const fnArgs = callArgs.filter((a) => typeof a === "function");
    expect(fnArgs).toHaveLength(1);
    const onAuthenticated = fnArgs[0] as () => void | Promise<void>;
    await onAuthenticated();
    throw new Error("data exchange failed");
  }) as never);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bootstrap-"));
  const configPath = path.join(dir, "psilink.yaml");
  try {
    await expect(
      runOnlineBootstrap(onlineBootstrapParams(configPath)),
    ).rejects.toThrow("data exchange failed");
    expect(fs.existsSync(configPath)).toBe(true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runOnlineBootstrap does not write the config when the handshake fails", async () => {
  // The handshake fails before acceptance, so runProtocol never invokes the
  // hook. No config must be written -- preserving the "declined or unreachable
  // partner leaves no config behind" guarantee.
  vi.mocked(runProtocol).mockImplementation((async () => {
    throw new Error("partner declined the invitation");
  }) as never);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bootstrap-"));
  const configPath = path.join(dir, "psilink.yaml");
  try {
    await expect(
      runOnlineBootstrap(onlineBootstrapParams(configPath)),
    ).rejects.toThrow("partner declined");
    expect(fs.existsSync(configPath)).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runOnlineBootstrap returns the config-write error when the hook fails but the exchange succeeds", async () => {
  // The hook (saveConfig) failed at acceptance, but the exchange still
  // succeeded, so runProtocol resolves with onAuthenticatedError set.
  // runOnlineBootstrap must forward it as configWriteError so the caller can
  // avoid claiming the config was saved.
  const writeError = new Error("disk full while writing config");
  vi.mocked(runProtocol).mockImplementation((async () => ({
    onAuthenticatedError: writeError,
  })) as never);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bootstrap-"));
  const configPath = path.join(dir, "psilink.yaml");
  try {
    const { configWriteError } = await runOnlineBootstrap(
      onlineBootstrapParams(configPath),
    );
    expect(configWriteError).toBe(writeError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runOnlineBootstrap reports no config-write error on a clean run", async () => {
  // runProtocol resolves with no onAuthenticatedError (the hook succeeded), so
  // runOnlineBootstrap reports a clean outcome.
  vi.mocked(runProtocol).mockImplementation((async () => ({})) as never);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bootstrap-"));
  const configPath = path.join(dir, "psilink.yaml");
  try {
    const { configWriteError } = await runOnlineBootstrap(
      onlineBootstrapParams(configPath),
    );
    expect(configWriteError).toBeUndefined();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A recovery note must point the user at `psilink exchange` only when the config
// is actually on disk. These tests spy on the (silenced) named logger that
// runOnlineBootstrap resolves internally via getLogger(loggerName).
const RECOVERY_NOTE = "retry with 'psilink exchange'";

test("runOnlineBootstrap notes the config is on disk when the exchange fails after the config was written", async () => {
  // Hook writes the config (real saveConfig), then the exchange fails. The user
  // must be told the config + key are on disk so they retry with
  // `psilink exchange` rather than re-inviting.
  vi.mocked(runProtocol).mockImplementation((async (...callArgs: unknown[]) => {
    // See the matching note above: select the hook by type and assert it is the
    // sole function argument so a future function-typed parameter cannot be
    // picked up silently.
    const fnArgs = callArgs.filter((a) => typeof a === "function");
    expect(fnArgs).toHaveLength(1);
    const onAuthenticated = fnArgs[0] as () => void | Promise<void>;
    await onAuthenticated();
    throw new Error("data exchange failed");
  }) as never);

  const log = getLogger("bootstrap-recovery-test");
  log.setLevel("silent");
  const errorSpy = vi.spyOn(log, "error");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bootstrap-"));
  const configPath = path.join(dir, "psilink.yaml");
  try {
    await expect(
      runOnlineBootstrap({
        ...onlineBootstrapParams(configPath),
        loggerName: "bootstrap-recovery-test",
      }),
    ).rejects.toThrow("data exchange failed");
    expect(fs.existsSync(configPath)).toBe(true);
    expect(
      errorSpy.mock.calls.some(
        (c) => typeof c[0] === "string" && c[0].includes(RECOVERY_NOTE),
      ),
    ).toBe(true);
  } finally {
    errorSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runOnlineBootstrap does not log a config-on-disk note when the handshake fails", async () => {
  // The handshake fails before the hook runs, so the config is not on disk; no
  // recovery note must claim otherwise.
  vi.mocked(runProtocol).mockImplementation((async () => {
    throw new Error("partner declined the invitation");
  }) as never);

  const log = getLogger("bootstrap-recovery-test");
  log.setLevel("silent");
  const errorSpy = vi.spyOn(log, "error");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bootstrap-"));
  const configPath = path.join(dir, "psilink.yaml");
  try {
    await expect(
      runOnlineBootstrap({
        ...onlineBootstrapParams(configPath),
        loggerName: "bootstrap-recovery-test",
      }),
    ).rejects.toThrow("partner declined");
    expect(fs.existsSync(configPath)).toBe(false);
    expect(
      errorSpy.mock.calls.some(
        (c) => typeof c[0] === "string" && c[0].includes(RECOVERY_NOTE),
      ),
    ).toBe(false);
  } finally {
    errorSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runOnlineBootstrap with reuseExistingConfig does not log a recovery note when the handshake fails before the key is saved", async () => {
  // Reuse keeps a pre-existing config (on disk), but a pre-handshake failure
  // (declined, expired, unreachable) never reaches the hook, so runProtocol never
  // saves the rotated key. The recovery note must not fire: `psilink exchange`
  // would fail on the missing key. This guards the keyPersisted gate -- before
  // it, `reuseExistingConfig` alone fired the note regardless of the key.
  vi.mocked(runProtocol).mockImplementation((async () => {
    throw new Error("partner declined the invitation");
  }) as never);

  const log = getLogger("bootstrap-recovery-test");
  log.setLevel("silent");
  const errorSpy = vi.spyOn(log, "error");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bootstrap-"));
  const configPath = path.join(dir, "psilink.yaml");
  try {
    fs.writeFileSync(configPath, "channel: filedrop\npath: /mnt/share\n");
    await expect(
      runOnlineBootstrap({
        ...onlineBootstrapParams(configPath),
        loggerName: "bootstrap-recovery-test",
        reuseExistingConfig: true,
      }),
    ).rejects.toThrow("partner declined");
    expect(
      errorSpy.mock.calls.some(
        (c) => typeof c[0] === "string" && c[0].includes(RECOVERY_NOTE),
      ),
    ).toBe(false);
  } finally {
    errorSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runOnlineBootstrap with reuseExistingConfig logs the recovery note when the exchange fails after the handshake", async () => {
  // The complement of the test above: the handshake succeeds (hook reached, so
  // the rotated key is saved) and the reused config is on disk, then the exchange
  // fails. Both files are present, so the note must point at `psilink exchange`.
  vi.mocked(runProtocol).mockImplementation((async (...callArgs: unknown[]) => {
    const fnArgs = callArgs.filter((a) => typeof a === "function");
    expect(fnArgs).toHaveLength(1);
    const onAuthenticated = fnArgs[0] as () => void | Promise<void>;
    await onAuthenticated();
    throw new Error("data exchange failed");
  }) as never);

  const log = getLogger("bootstrap-recovery-test");
  log.setLevel("silent");
  const errorSpy = vi.spyOn(log, "error");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bootstrap-"));
  const configPath = path.join(dir, "psilink.yaml");
  try {
    fs.writeFileSync(configPath, "channel: filedrop\npath: /mnt/share\n");
    await expect(
      runOnlineBootstrap({
        ...onlineBootstrapParams(configPath),
        loggerName: "bootstrap-recovery-test",
        reuseExistingConfig: true,
      }),
    ).rejects.toThrow("data exchange failed");
    expect(
      errorSpy.mock.calls.some(
        (c) => typeof c[0] === "string" && c[0].includes(RECOVERY_NOTE),
      ),
    ).toBe(true);
  } finally {
    errorSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- logOnlineBootstrapOutcome ----------------------------------------------

test("logOnlineBootstrapOutcome: a clean run reports both files saved", () => {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as ReturnType<typeof getLogger>;
  logOnlineBootstrapOutcome(log, {
    configFile: "psilink.yaml",
    keyFile: ".psilink.key",
  });
  expect(log.warn).not.toHaveBeenCalled();
  expect(log.error).not.toHaveBeenCalled();
  expect(log.info).toHaveBeenCalledTimes(1);
  expect(vi.mocked(log.info).mock.calls[0][0]).toContain(
    "saved config to psilink.yaml",
  );
});

test("logOnlineBootstrapOutcome: a config-write failure logs at error level and does not claim the config was saved", () => {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as ReturnType<typeof getLogger>;
  logOnlineBootstrapOutcome(log, {
    configFile: "psilink.yaml",
    keyFile: ".psilink.key",
    configWriteError: new Error("permission denied"),
  });
  expect(log.info).not.toHaveBeenCalled();
  // Logged at error level (not warn) so it stays visible at --log-level=error,
  // where the underlying hook error it references is also shown.
  expect(log.warn).not.toHaveBeenCalled();
  expect(log.error).toHaveBeenCalledTimes(1);
  const msg = vi.mocked(log.error).mock.calls[0][0] as string;
  // The rotated key is still reported saved; the config is reported NOT written.
  expect(msg).toContain("rotated key was saved to .psilink.key");
  expect(msg).toContain("could not be written to psilink.yaml");
  expect(msg).not.toContain("saved config to");
});

test("logOnlineBootstrapOutcome: a reused config reports the existing config and the rotated key", () => {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as ReturnType<typeof getLogger>;
  logOnlineBootstrapOutcome(log, {
    configFile: "psilink.yaml",
    keyFile: ".psilink.key",
    reuseExistingConfig: true,
  });
  expect(log.warn).not.toHaveBeenCalled();
  expect(log.error).not.toHaveBeenCalled();
  expect(log.info).toHaveBeenCalledTimes(1);
  const msg = vi.mocked(log.info).mock.calls[0][0] as string;
  expect(msg).toContain("reused the existing configuration");
  expect(msg).toContain("rotated key");
});

// --- runOnlineBootstrap: reuse + write-time re-gate --------------------------

test("runOnlineBootstrap with reuseExistingConfig keeps the existing config and reports no write error", async () => {
  // The hook is a no-op when reusing: the pre-existing config is left as-is and
  // only the rotated key (saved by runProtocol) lands.
  vi.mocked(runProtocol).mockImplementation((async (...callArgs: unknown[]) => {
    const fnArgs = callArgs.filter((a) => typeof a === "function");
    expect(fnArgs).toHaveLength(1);
    const onAuthenticated = fnArgs[0] as () => void | Promise<void>;
    await onAuthenticated();
    return {};
  }) as never);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bootstrap-"));
  const configPath = path.join(dir, "psilink.yaml");
  try {
    const existing = "channel: filedrop\npath: /mnt/share\n# user-authored\n";
    fs.writeFileSync(configPath, existing);
    const { configWriteError } = await runOnlineBootstrap({
      ...onlineBootstrapParams(configPath),
      reuseExistingConfig: true,
    });
    expect(configWriteError).toBeUndefined();
    // The user's config is untouched: reuse never rewrites it.
    expect(fs.readFileSync(configPath, "utf8")).toBe(existing);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runOnlineBootstrap re-gates the config write: a config appearing after the check is not silently overwritten", async () => {
  // Emulate runProtocol's hook handling: a hook failure is captured as
  // onAuthenticatedError (non-fatal), not propagated -- the same contract the
  // real runProtocol upholds.
  vi.mocked(runProtocol).mockImplementation((async (...callArgs: unknown[]) => {
    const fnArgs = callArgs.filter((a) => typeof a === "function");
    expect(fnArgs).toHaveLength(1);
    const onAuthenticated = fnArgs[0] as () => void | Promise<void>;
    try {
      await onAuthenticated();
      return {};
    } catch (err) {
      return { onAuthenticatedError: err };
    }
  }) as never);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-bootstrap-"));
  const configPath = path.join(dir, "psilink.yaml");
  try {
    // A config "appears" between the pre-network conflict check and the write.
    const existing = "channel: filedrop\npath: /mnt/share\n# pre-existing\n";
    fs.writeFileSync(configPath, existing);
    // reuseExistingConfig is NOT set: this is the write-fresh path, so the hook
    // must detect the appeared file and refuse rather than overwrite it.
    const { configWriteError } = await runOnlineBootstrap(
      onlineBootstrapParams(configPath),
    );
    expect(configWriteError).toBeInstanceOf(UsageError);
    // The pre-existing file is left untouched -- not silently overwritten.
    expect(fs.readFileSync(configPath, "utf8")).toBe(existing);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- diffConnectionAgainstTarget ---------------------------------------------
// These compare a saved config against the connection the live exchange will
// actually use (a built RunnableConnectionConfig, as connectionFromURL would
// produce), so the diff's verdict matches the live connection field for field.
// URL-specific parsing (port truthiness, path "/", percent-encoding) lives in
// connectionFromURL and is tested above.

test("diffConnectionAgainstTarget: an agreeing sftp config has no conflicts or warnings", () => {
  const existing: ConnectionConfig = {
    channel: "sftp",
    server: {
      host: "host",
      port: 2222,
      path: "/drop",
      username: "alice",
      password: "s3cr3t",
    },
  };
  const target: RunnableConnectionConfig = {
    channel: "sftp",
    server: {
      host: "host",
      port: 2222,
      path: "/drop",
      username: "alice",
      password: "s3cr3t",
    },
  };
  const r = diffConnectionAgainstTarget(existing, target);
  expect(r.conflicts).toEqual([]);
  expect(r.warnings).toEqual([]);
});

test("diffConnectionAgainstTarget: a host mismatch is a conflict (which drop)", () => {
  const existing: ConnectionConfig = {
    channel: "sftp",
    server: { host: "other-host" },
  };
  const target: RunnableConnectionConfig = {
    channel: "sftp",
    server: { host: "host", path: "/drop" },
  };
  const r = diffConnectionAgainstTarget(existing, target);
  expect(r.conflicts.map((d) => d.field)).toContain("connection.server.host");
});

test("diffConnectionAgainstTarget: host comparison is case-insensitive (same endpoint)", () => {
  // DNS is case-insensitive, and the live connection uses the host as-is, so a
  // case-only difference must not abort.
  const existing: ConnectionConfig = {
    channel: "sftp",
    server: { host: "host.example.com" },
  };
  const target: RunnableConnectionConfig = {
    channel: "sftp",
    server: { host: "Host.Example.COM" },
  };
  const r = diffConnectionAgainstTarget(existing, target);
  expect(r.conflicts).toEqual([]);
  expect(r.warnings).toEqual([]);
});

test("diffConnectionAgainstTarget: an sftp path mismatch is a conflict (which drop)", () => {
  const existing: ConnectionConfig = {
    channel: "sftp",
    server: { host: "host", path: "/old" },
  };
  const target: RunnableConnectionConfig = {
    channel: "sftp",
    server: { host: "host", path: "/new" },
  };
  const r = diffConnectionAgainstTarget(existing, target);
  expect(r.conflicts.map((d) => d.field)).toContain("connection.server.path");
});

test("diffConnectionAgainstTarget: a trailing-slash-only path difference is not a conflict", () => {
  // FileSyncConnection strips a single trailing slash, so /drop and /drop/ are
  // the same directory at runtime.
  const existing: ConnectionConfig = {
    channel: "sftp",
    server: { host: "host", path: "/drop" },
  };
  const target: RunnableConnectionConfig = {
    channel: "sftp",
    server: { host: "host", path: "/drop/" },
  };
  const r = diffConnectionAgainstTarget(existing, target);
  expect(r.conflicts).toEqual([]);
});

test("diffConnectionAgainstTarget: a path the target omits is not flagged", () => {
  const existing: ConnectionConfig = {
    channel: "sftp",
    server: { host: "host", path: "/drop" },
  };
  const target: RunnableConnectionConfig = {
    channel: "sftp",
    server: { host: "host" },
  };
  const r = diffConnectionAgainstTarget(existing, target);
  expect(r.conflicts).toEqual([]);
  expect(r.warnings).toEqual([]);
});

test("diffConnectionAgainstTarget: a differing port warns (how you reach), not conflicts", () => {
  const existing: ConnectionConfig = {
    channel: "sftp",
    server: { host: "host", port: 22 },
  };
  const target: RunnableConnectionConfig = {
    channel: "sftp",
    server: { host: "host", port: 2222 },
  };
  const r = diffConnectionAgainstTarget(existing, target);
  expect(r.conflicts).toEqual([]);
  expect(r.warnings.some((w) => w.includes("2222"))).toBe(true);
});

test("diffConnectionAgainstTarget: a target port equal to the config is silent", () => {
  const existing: ConnectionConfig = {
    channel: "sftp",
    server: { host: "host", port: 2222 },
  };
  const target: RunnableConnectionConfig = {
    channel: "sftp",
    server: { host: "host", port: 2222 },
  };
  const r = diffConnectionAgainstTarget(existing, target);
  expect(r.warnings).toEqual([]);
});

test("diffConnectionAgainstTarget: the default port 22 against an unset config is silent", () => {
  // An unset config port means the SFTP default (22), so a target restating 22
  // is not a divergence and must not warn.
  const existing: ConnectionConfig = {
    channel: "sftp",
    server: { host: "host" },
  };
  const target: RunnableConnectionConfig = {
    channel: "sftp",
    server: { host: "host", port: 22 },
  };
  const r = diffConnectionAgainstTarget(existing, target);
  expect(r.conflicts).toEqual([]);
  expect(r.warnings).toEqual([]);
});

test("diffConnectionAgainstTarget: a non-default port against an unset config warns", () => {
  const existing: ConnectionConfig = {
    channel: "sftp",
    server: { host: "host" },
  };
  const target: RunnableConnectionConfig = {
    channel: "sftp",
    server: { host: "host", port: 2222 },
  };
  const r = diffConnectionAgainstTarget(existing, target);
  expect(r.warnings.some((w) => w.includes("2222"))).toBe(true);
});

test("diffConnectionAgainstTarget: credentials the target omits are not flagged", () => {
  const existing: ConnectionConfig = {
    channel: "sftp",
    server: { host: "host", username: "alice", password: "s3cr3t" },
  };
  const target: RunnableConnectionConfig = {
    channel: "sftp",
    server: { host: "host" },
  };
  const r = diffConnectionAgainstTarget(existing, target);
  expect(r.conflicts).toEqual([]);
  expect(r.warnings).toEqual([]);
});

test("diffConnectionAgainstTarget: differing credentials warn without echoing the value", () => {
  const existing: ConnectionConfig = {
    channel: "sftp",
    server: { host: "host", username: "bob", password: "saved-secret" },
  };
  const target: RunnableConnectionConfig = {
    channel: "sftp",
    server: { host: "host", username: "alice", password: "new-secret" },
  };
  const r = diffConnectionAgainstTarget(existing, target);
  expect(r.conflicts).toEqual([]);
  const joined = r.warnings.join(" | ");
  expect(joined).toContain("username");
  expect(joined).toContain("password");
  // No credential value -- saved or specified -- is ever echoed in a warning.
  expect(joined).not.toContain("saved-secret");
  expect(joined).not.toContain("new-secret");
  expect(joined).not.toContain("alice");
});

test("diffConnectionAgainstTarget: a differing private key warns without echoing it", () => {
  const existing: ConnectionConfig = {
    channel: "sftp",
    server: { host: "host", privateKey: "saved-key" },
  };
  const target: RunnableConnectionConfig = {
    channel: "sftp",
    server: { host: "host", privateKey: "new-key" },
  };
  const joined = diffConnectionAgainstTarget(existing, target).warnings.join(
    " | ",
  );
  expect(joined).toContain("private key");
  expect(joined).not.toContain("saved-key");
  expect(joined).not.toContain("new-key");
});

test("diffConnectionAgainstTarget: a channel mismatch warns and compares nothing else (file-sync)", () => {
  // file:// vs sftp:// is a legitimate different way of reaching the same drop;
  // it warns and short-circuits the per-channel fields rather than aborting.
  const existing: ConnectionConfig = {
    channel: "filedrop",
    path: "/mnt/share",
  };
  const target: RunnableConnectionConfig = {
    channel: "sftp",
    server: { host: "host", path: "/drop" },
  };
  const r = diffConnectionAgainstTarget(existing, target);
  expect(r.conflicts).toEqual([]);
  expect(r.warnings).toHaveLength(1);
  expect(r.warnings[0]).toContain("channel");
});

test("diffConnectionAgainstTarget: a filedrop path mismatch is a conflict", () => {
  const existing: ConnectionConfig = {
    channel: "filedrop",
    path: "/mnt/other",
  };
  const target: RunnableConnectionConfig = {
    channel: "filedrop",
    path: "/mnt/share/drop",
  };
  const r = diffConnectionAgainstTarget(existing, target);
  expect(r.conflicts.map((d) => d.field)).toContain("connection.path");
});

test("diffConnectionAgainstTarget: a filedrop trailing-slash-only difference is not a conflict", () => {
  const existing: ConnectionConfig = {
    channel: "filedrop",
    path: "/mnt/share",
  };
  const target: RunnableConnectionConfig = {
    channel: "filedrop",
    path: "/mnt/share/",
  };
  const r = diffConnectionAgainstTarget(existing, target);
  expect(r.conflicts).toEqual([]);
});
