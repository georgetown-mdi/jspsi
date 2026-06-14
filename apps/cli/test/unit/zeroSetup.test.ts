import {
  expect,
  test,
  vi,
  beforeEach,
  afterEach,
  type MockInstance,
} from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yargs, { type Arguments } from "yargs";
import { UsageError } from "@psilink/core";
import type { SFTPConnectionConfig } from "@psilink/core";
import {
  builder,
  channelFromURL,
  createConnection,
  handler,
  resolvePositionals,
} from "../../src/commands/zeroSetup";
import { resolveConnectionCredentials } from "../../src/util/atSignRefs";
import { redactUrlCredentials } from "../../src/util/connectionUrl";
import { runProtocol } from "../../src/protocol";

// The handler hands the resolved connection to runProtocol; mock it so the happy
// path can be driven to that hand-off without opening a transport. Hoisted above
// the imports by vitest; only the @path-resolution handler test below invokes the
// mock -- the other handler tests exit on an argument error before reaching it.
vi.mock("../../src/protocol", () => ({ runProtocol: vi.fn() }));

let existsSyncSpy: MockInstance;

beforeEach(() => {
  existsSyncSpy = vi.spyOn(fs, "existsSync");
});

afterEach(() => {
  existsSyncSpy.mockRestore();
});

// --- builder help overrides --------------------------------------------------

test("builder: zero-setup's --save-scoped config/key help reaches the rendered help", async () => {
  // zero-setup overrides only the config/key file describes (they are written
  // only under --save); a dropped override would fall back to the unqualified
  // shared default. Whitespace is normalized so a wrapped help line still
  // matches.
  const help = (await builder(yargs([])).getHelp()).replace(/\s+/g, " ");
  expect(help).toContain("where to write psilink.yaml when --save is given");
  expect(help).toContain("where to write .psilink.key when --save is given");
  // zero-setup intentionally keeps the shared URL wording for server-*, so the
  // default text remains (it did not override those).
  expect(help).toContain("overrides the port in URL");
});

// --- channelFromURL ----------------------------------------------------------

test("sftp: maps to sftp channel", () => {
  expect(channelFromURL(new URL("sftp://example.org/path"))).toBe("sftp");
});

test("ssh: maps to sftp channel", () => {
  expect(channelFromURL(new URL("ssh://example.org/path"))).toBe("sftp");
});

test("ws: maps to webrtc channel", () => {
  expect(channelFromURL(new URL("ws://example.org/path"))).toBe("webrtc");
});

test("wss: maps to webrtc channel", () => {
  expect(channelFromURL(new URL("wss://example.org/path"))).toBe("webrtc");
});

test("file: maps to filedrop channel", () => {
  expect(channelFromURL(new URL("file:///mnt/share/drop"))).toBe("filedrop");
});

test("unsupported URL scheme throws a UsageError", () => {
  expect(() => channelFromURL(new URL("https://example.org/path"))).toThrow(
    UsageError,
  );
  expect(() => channelFromURL(new URL("https://example.org/path"))).toThrow(
    "unsupported URL scheme",
  );
});

// --- resolvePositionals ------------------------------------------------------

test("two positionals return server URL and input path", () => {
  const result = resolvePositionals(["sftp://host/data", "input.csv"]);
  expect(result.server.hostname).toBe("host");
  expect(result.input).toBe("input.csv");
  expect(result.output).toBeUndefined();
});

test("three positionals return server URL, input, and output", () => {
  const result = resolvePositionals([
    "sftp://host/data",
    "input.csv",
    "out.csv",
  ]);
  expect(result.input).toBe("input.csv");
  expect(result.output).toBe("out.csv");
});

test("server URL credentials are preserved in the returned URL", () => {
  const result = resolvePositionals([
    "sftp://alice:secret@host:2222/path",
    "input.csv",
  ]);
  expect(result.server.username).toBe("alice");
  expect(result.server.port).toBe("2222");
});

test("single positional that is a file throws hint to use exchange subcommand", () => {
  existsSyncSpy.mockReturnValue(true);
  expect(() => resolvePositionals(["input.csv"])).toThrow("psilink exchange");
});

test("single positional that is not a file throws input-not-specified error", () => {
  existsSyncSpy.mockReturnValue(false);
  expect(() => resolvePositionals(["not-a-url"])).toThrow(
    "input file not specified",
  );
});

test("invalid server URL with two positionals throws a parse error", () => {
  expect(() => resolvePositionals(["not-a-url", "input.csv"])).toThrow(
    "unable to parse server URL",
  );
});

// --- createConnection --------------------------------------------------------

const baseOptions = {
  save: false,
  configFile: "./psilink.yaml",
  keyFile: "./.psilink.key",
};

test("createConnection filedrop: channel and path are set", () => {
  const result = createConnection(
    new URL("file:///mnt/share/drop"),
    baseOptions,
  );
  expect(result.channel).toBe("filedrop");
  if (result.channel !== "filedrop") return;
  expect(result.path).toBe("/mnt/share/drop");
});

test("createConnection filedrop: non-localhost authority throws a UsageError", () => {
  expect(() =>
    createConnection(new URL("file://host/mnt/share"), baseOptions),
  ).toThrow(UsageError);
  expect(() =>
    createConnection(new URL("file://host/mnt/share"), baseOptions),
  ).toThrow("three slashes");
});

test("createConnection filedrop: the non-localhost error echoes the redacted URL", () => {
  // The rejection echoes the URL through redactUrlCredentials, mirroring
  // connectionFromURL's twin branch, so the message stays credential-free if the
  // parse/validation order is ever reworked. A file:// URL cannot carry userinfo
  // today -- the WHATWG parser rejects `file://user:pass@host` with
  // ERR_INVALID_URL and the username/password setters are no-ops on a file URL --
  // so redactUrlCredentials(server) equals server.href for every constructible
  // file:// URL and no assertion here can distinguish the two. This pins the
  // message to the redacted form, which is credential-free by construction, and
  // documents the convention the twin builders share. The string `.toThrow`
  // arg requires an actual throw whose message contains the substring, so the
  // assertion cannot pass vacuously.
  const server = new URL("file://host/mnt/share");
  expect(() => createConnection(server, baseOptions)).toThrow(
    `got: ${redactUrlCredentials(server)}`,
  );
});

test("createConnection webrtc throws a UsageError 'not yet supported'", () => {
  // ws:// resolves to the webrtc channel, which the CLI does not yet support;
  // that is invalid caller input (exit 64), not a transport failure.
  expect(() =>
    createConnection(new URL("ws://example.org/path"), baseOptions),
  ).toThrow(UsageError);
  expect(() =>
    createConnection(new URL("ws://example.org/path"), baseOptions),
  ).toThrow("not yet supported");
});

test("createConnection filedrop: file://localhost/path is accepted", () => {
  const result = createConnection(
    new URL("file://localhost/mnt/share/drop"),
    baseOptions,
  );
  expect(result.channel).toBe("filedrop");
  if (result.channel !== "filedrop") return;
  expect(result.path).toBe("/mnt/share/drop");
});

test("createConnection filedrop: peerTimeout is converted to ms", () => {
  const result = createConnection(new URL("file:///mnt/share/drop"), {
    ...baseOptions,
    peerTimeout: 60,
  });
  expect(result.options?.peerTimeoutMs).toBe(60_000);
});

test("createConnection filedrop: connectionTimeout is converted to ms", () => {
  const result = createConnection(new URL("file:///mnt/share/drop"), {
    ...baseOptions,
    connectionTimeout: 10,
  });
  expect(result.options?.serverConnectTimeoutMs).toBe(10_000);
});

// --- authentication invariant ------------------------------------------------
// The handler passes authentication: null to runProtocol to explicitly opt out
// of authentication. These tests guard against createConnection inadvertently setting
// authentication, which would require the handler to override it.

test("createConnection filedrop never produces a config with authentication set", () => {
  const result = createConnection(
    new URL("file:///mnt/share/drop"),
    baseOptions,
  );
  expect(
    (result as unknown as Record<string, unknown>).authentication,
  ).toBeUndefined();
});

test("createConnection sftp never produces a config with authentication set", () => {
  const result = createConnection(new URL("sftp://host/path"), baseOptions);
  expect(
    (result as unknown as Record<string, unknown>).authentication,
  ).toBeUndefined();
});

// --- createConnection sftp: percent-decoding ---------------------------------
// The WHATWG URL parser keeps pathname/username/password percent-encoded, but
// ssh2 consumes them literally. createConnection must decode before storing, and
// must match connectionFromURL (the invite/accept twin) on the same input.

test("createConnection sftp: decodes a percent-encoded path", () => {
  const result = createConnection(
    new URL("sftp://host/my%20drop"),
    baseOptions,
  ) as SFTPConnectionConfig;
  expect(result.server.path).toBe("/my drop");
});

test("createConnection sftp: decodes percent-encoded credentials", () => {
  const result = createConnection(
    new URL("sftp://us%20er:p%20w@host/drop"),
    baseOptions,
  ) as SFTPConnectionConfig;
  expect(result.server.username).toBe("us er");
  expect(result.server.password).toBe("p w");
});

test("createConnection sftp: decodes a percent-encoded host", () => {
  const result = createConnection(
    new URL("sftp://my%20server/drop"),
    baseOptions,
  ) as SFTPConnectionConfig;
  expect(result.server.host).toBe("my server");
});

test("createConnection sftp: a bare-host URL leaves the path unset", () => {
  // Matches connectionFromURL: a trailing "/" must not be pinned as the remote
  // path; the server's default working directory is used instead.
  for (const raw of ["sftp://host", "sftp://host/"]) {
    const result = createConnection(
      new URL(raw),
      baseOptions,
    ) as SFTPConnectionConfig;
    expect(result.server.path).toBeUndefined();
  }
});

test("createConnection sftp: a malformed percent-escape is a redacted usage error", () => {
  expect(() =>
    createConnection(new URL("sftp://host/bad%"), baseOptions),
  ).toThrow(UsageError);
  let message = "";
  try {
    createConnection(new URL("sftp://user:secret%@host/drop"), baseOptions);
  } catch (err) {
    message = (err as Error).message;
  }
  expect(message).toMatch(/malformed percent-encoding/);
  expect(message).not.toContain("secret");
});

// --- createConnection: @path credentials are preserved for persistence -------
// createConnection builds the connection that --save persists, so it must keep
// an @path credential ref as-is (the secret is read only at the live-use
// boundary, resolveConnectionCredentials). A literal credential is kept literal.

test("createConnection sftp keeps an @path server-password as the reference, not the file contents", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-zerocred-"));
  try {
    const pwFile = path.join(dir, "pw");
    fs.writeFileSync(pwFile, "s3cret\n");
    const result = createConnection(new URL("sftp://host/path"), {
      ...baseOptions,
      serverPassword: `@${pwFile}`,
    }) as SFTPConnectionConfig;
    // Persisted form: the @path survives verbatim.
    expect(result.server.password).toBe(`@${pwFile}`);
    // Live form: resolveConnectionCredentials reads the file.
    expect(
      (resolveConnectionCredentials(result) as SFTPConnectionConfig).server
        .password,
    ).toBe("s3cret");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("createConnection sftp keeps an @path server-private-key as the reference", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-zerocred-"));
  try {
    const keyFile = path.join(dir, "id_rsa");
    fs.writeFileSync(keyFile, "KEYDATA\n");
    const result = createConnection(new URL("sftp://host/path"), {
      ...baseOptions,
      serverPrivateKey: `@${keyFile}`,
    }) as SFTPConnectionConfig;
    expect(result.server.privateKey).toBe(`@${keyFile}`);
    expect(
      (resolveConnectionCredentials(result) as SFTPConnectionConfig).server
        .privateKey,
    ).toBe("KEYDATA");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("createConnection sftp persists a literal server-password unchanged", () => {
  const result = createConnection(new URL("sftp://host/path"), {
    ...baseOptions,
    serverPassword: "literal-pw",
  }) as SFTPConnectionConfig;
  expect(result.server.password).toBe("literal-pw");
  expect(
    (resolveConnectionCredentials(result) as SFTPConnectionConfig).server
      .password,
  ).toBe("literal-pw");
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
        "log-level": "bogus",
      } as unknown as Arguments),
    ).rejects.toThrow("exit:64");
    expect(errSpy).toHaveBeenCalledWith("unrecognized log-level: bogus");
  } finally {
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
});

// --- handler: @path credential is resolved for the live exchange -------------

test("handler hands the resolved credential to the exchange while persisting nothing here", async () => {
  // The seam the persistence change turns on: the handler must connect with the
  // resolved secret (liveConnection) even though createConnection -- the form
  // --save would persist -- still carries the @path. runProtocol is mocked to
  // capture the connection it receives; process.exit is trapped so an unexpected
  // failure surfaces as a thrown test error rather than killing the run.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-zerohandler-"));
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
    code?: number,
  ) => {
    throw new Error(`exit:${code ?? 0}`);
  }) as never);
  try {
    const pwFile = path.join(dir, "pw");
    fs.writeFileSync(pwFile, "s3cret\n");
    const input = path.join(dir, "input.csv");
    fs.writeFileSync(
      input,
      "first_name,last_name,date_of_birth\nBob,Jones,1990-01-02\n",
    );

    let connToRunProtocol: SFTPConnectionConfig | undefined;
    vi.mocked(runProtocol).mockImplementation((async (
      ...callArgs: unknown[]
    ) => {
      connToRunProtocol = callArgs[0] as SFTPConnectionConfig;
      // bootstrap present but no secret and no partner intent: finalizeBootstrap
      // (save === false) only logs the recurring-exchange hint, writing nothing.
      return { bootstrap: { partnerSaveIntent: false } };
    }) as never);

    await handler({
      _: ["sftp://userb@localhost:2222/drop", input],
      $0: "psilink",
      "server-password": `@${pwFile}`,
      "config-file": path.join(dir, "psilink.yaml"),
      "key-file": path.join(dir, ".psilink.key"),
      identity: "Tester",
      record: false,
      "log-level": "silent",
    } as unknown as Arguments);

    expect(connToRunProtocol?.channel).toBe("sftp");
    expect(connToRunProtocol?.server.password).toBe("s3cret");
    // No --save, so nothing is written here.
    expect(fs.existsSync(path.join(dir, "psilink.yaml"))).toBe(false);
  } finally {
    exitSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
