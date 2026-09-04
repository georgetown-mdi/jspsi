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
import {
  CONSENT_FACTS,
  getLogger,
  prepareForExchange,
  sanitizeErrorForDisplay,
  UsageError,
} from "@psilink/core";
import type {
  ExchangeBootstrapResult,
  FileDropConnectionConfig,
  LinkageTerms,
  PreparedExchange,
  SFTPConnectionConfig,
} from "@psilink/core";
import {
  builder,
  channelFromURL,
  createConnection,
  handler,
  resolvePositionals,
} from "../../src/commands/zeroSetup";
import type { ConnectionOverrideOptions } from "../../src/optionDefinitions";
import { resolveConnectionCredentials } from "../../src/util/atSignRefs";
import { redactUrlCredentials } from "../../src/util/connectionUrl";
import { PLACEHOLDER_IDENTITY } from "../../src/partyIdentity";
import { runProtocol } from "../../src/protocol";
import type { RunProtocolOptions } from "../../src/protocol";
import { PERSISTENCE_LOSS_EXIT_CODE } from "../../src/eventStream";
import { captureFd3 } from "../eventStreamTestSupport";
import { establishHostKeyTrust } from "../../src/hostKeyTrust";

// The handler hands the resolved connection to runProtocol; mock it so the happy
// path can be driven to that hand-off without opening a transport. Hoisted above
// the imports by vitest; only the @path-resolution handler test below invokes the
// mock -- the other handler tests exit on an argument error before reaching it.
// Only runProtocol is stubbed: the refusal messages the handler raises are real
// constants from the same module, and asserting a copy of one would pass while
// the operator saw something else.
vi.mock("../../src/protocol", async (importActual) => ({
  ...(await importActual<typeof import("../../src/protocol")>()),
  runProtocol: vi.fn(),
}));

// First-use host-key trust runs in the connect path before runProtocol; stub it
// out (its own behavior is covered in hostKeyTrust.test.ts) so the handler tests
// reach the runProtocol hand-off without a real probe over the fake URL, and
// assert the handler wires it with the right persistence mode.
vi.mock("../../src/hostKeyTrust", () => ({ establishHostKeyTrust: vi.fn() }));

// The dataset preparation is spy-WRAPPED rather than replaced: the ordering test
// below needs to observe when the handler reaches it, while every test in the
// file -- the refusal the ordering pair's second half drives included -- keeps
// running the real prepare behind it.
vi.mock("@psilink/core", async (importActual) => {
  const actual = await importActual<typeof import("@psilink/core")>();
  return { ...actual, prepareForExchange: vi.fn(actual.prepareForExchange) };
});

let existsSyncSpy: MockInstance;

beforeEach(() => {
  existsSyncSpy = vi.spyOn(fs, "existsSync");
});

afterEach(() => {
  existsSyncSpy.mockRestore();
});

/** The options object a mocked runProtocol call received. */
function optionsArg(callArgs: unknown[]): RunProtocolOptions {
  return callArgs[0] as RunProtocolOptions;
}

/** runProtocol's FileSyncRuntimeOptions, which zero-setup always supplies. */
function runtimeOptionsArg(callArgs: unknown[]): {
  eventStream?: unknown;
  onOutputComplete?: (context: {
    observedReceivedPayloadColumns: string[];
    bootstrap?: ExchangeBootstrapResult;
  }) => void | Promise<void>;
} {
  const runtime = optionsArg(callArgs).fileSyncRuntime;
  expect(runtime).toBeDefined();
  return runtime as {
    eventStream?: unknown;
    onOutputComplete?: (context: {
      observedReceivedPayloadColumns: string[];
      bootstrap?: ExchangeBootstrapResult;
    }) => void | Promise<void>;
  };
}

/** Drive the completed-exchange half of runProtocol's contract from the mock:
 *  invoke the caller's pre-terminal onOutputComplete hook, then resolve the way
 *  the real function does. The zero-setup `--save` persistence rides that hook,
 *  so a mock that resolves without calling it drives a run that saves nothing --
 *  which is what the placement test below turns on. */
async function driveCompletedExchange(
  callArgs: unknown[],
  bootstrap: ExchangeBootstrapResult | undefined,
  observedReceivedPayloadColumns: string[] = [],
): Promise<unknown> {
  await runtimeOptionsArg(callArgs).onOutputComplete?.({
    observedReceivedPayloadColumns,
    bootstrap,
  });
  // The bootstrap outcome reaches the caller through the hook alone, so the
  // resolved result carries only what RunProtocolResult declares.
  return { observedReceivedPayloadColumns };
}

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

test("a malformed credential-bearing server URL does not echo the credential", () => {
  // A typo the WHATWG parser rejects (here, a bad port) on a credentialed URL
  // reaches the parse-error site. The operator-facing render must carry neither
  // the password nor the username -- not via the message, and not via the parse
  // error's enumerable `input` property on the attached cause. Assert at the
  // render boundary (sanitizeErrorForDisplay, the sole path exitWithError uses)
  // so both are covered end to end.
  let err: unknown;
  try {
    resolvePositionals(["sftp://alice:s3cr3t@host:99999999/drop", "input.csv"]);
  } catch (caught) {
    err = caught;
  }
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).toContain("unable to parse server URL");
  const rendered = sanitizeErrorForDisplay(err);
  expect(rendered).not.toContain("s3cr3t");
  expect(rendered).not.toContain("alice");
});

// --- createConnection --------------------------------------------------------

const baseOptions: ConnectionOverrideOptions = {};

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

test("createConnection refuses a webrtc URL, naming what does run one", () => {
  // ws:// resolves to the webrtc channel, which the CLI runs -- but only from a
  // saved connection, not from a URL (see connectionFromUrl.ts). That is invalid
  // caller input (exit 64), not a transport failure, and the message says which
  // command does run one rather than reporting the channel as unsupported.
  expect(() =>
    createConnection(new URL("ws://example.org/path"), baseOptions),
  ).toThrow(UsageError);
  expect(() =>
    createConnection(new URL("ws://example.org/path"), baseOptions),
  ).toThrow("psilink exchange");
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

test("createConnection sftp keeps an @path server-private-key-passphrase as the reference", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-zerocred-"));
  try {
    const keyFile = path.join(dir, "id_rsa");
    const passFile = path.join(dir, "passphrase");
    fs.writeFileSync(keyFile, "KEYDATA\n");
    fs.writeFileSync(passFile, "unlock-me\n");
    // The passphrase requires a private key, so both are supplied; the @path of
    // each survives verbatim for persistence and is read only at live use.
    const result = createConnection(new URL("sftp://host/path"), {
      ...baseOptions,
      serverPrivateKey: `@${keyFile}`,
      serverPrivateKeyPassphrase: `@${passFile}`,
    }) as SFTPConnectionConfig;
    expect(result.server.privateKey).toBe(`@${keyFile}`);
    expect(result.server.privateKeyPassphrase).toBe(`@${passFile}`);
    const live = resolveConnectionCredentials(result) as SFTPConnectionConfig;
    expect(live.server.privateKey).toBe("KEYDATA");
    expect(live.server.privateKeyPassphrase).toBe("unlock-me");
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

// --- handler: the identity this party puts in the terms ----------------------

/** The linkage terms the handler handed runProtocol for this run. */
async function termsFromZeroSetupRun(
  dir: string,
  identity: string | undefined,
): Promise<LinkageTerms> {
  const input = path.join(dir, "input.csv");
  fs.writeFileSync(
    input,
    "first_name,last_name,date_of_birth\nBob,Jones,1990-01-02\n",
  );
  let prepared: PreparedExchange | undefined;
  vi.mocked(runProtocol).mockImplementation((async (...callArgs: unknown[]) => {
    prepared = optionsArg(callArgs).prepared;
    return driveCompletedExchange(callArgs, { partnerSaveIntent: false });
  }) as never);

  await handler({
    _: ["sftp://userb@localhost:2222/drop", input],
    $0: "psilink",
    "config-file": path.join(dir, "psilink.yaml"),
    "key-file": path.join(dir, ".psilink.key"),
    ...(identity !== undefined ? { identity } : {}),
    record: false,
    "log-level": "silent",
  } as unknown as Arguments);

  if (prepared === undefined)
    throw new Error("the run never reached runProtocol");
  return prepared.linkageTerms;
}

test("handler: no --identity asks nothing and sends no identity", async () => {
  // The quick path's whole property: a run given no label completes without a
  // question and without a stand-in. The terms carry no `identity` key at all --
  // not the account psilink runs as, not an empty string -- so a partner reads
  // this party as one that named itself none.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-zeroidentity-"));
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
    code?: number,
  ) => {
    throw new Error(`exit:${code ?? 0}`);
  }) as never);
  try {
    for (const blank of [undefined, "", "   "]) {
      const terms = await termsFromZeroSetupRun(dir, blank);
      expect(terms.identity).toBeUndefined();
      expect("identity" in terms).toBe(false);
    }
  } finally {
    exitSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("handler: an --identity still carrying the init placeholder exits 64", async () => {
  // This path may run unnamed, but not under the template's placeholder: read as
  // a label it would send the words asking for a name, and read as absence it
  // would silently unname a run whose operator typed a value believing it named
  // them. It stops before the connection is opened.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-zeroidentity-"));
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
    code?: number,
  ) => {
    throw new Error(`exit:${code ?? 0}`);
  }) as never);
  vi.mocked(runProtocol).mockClear();
  try {
    await expect(
      termsFromZeroSetupRun(dir, `  ${PLACEHOLDER_IDENTITY}  `),
    ).rejects.toThrow("exit:64");
    expect(runProtocol).not.toHaveBeenCalled();
  } finally {
    exitSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("handler: a supplied --identity rides into the terms, trimmed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-zeroidentity-"));
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
    code?: number,
  ) => {
    throw new Error(`exit:${code ?? 0}`);
  }) as never);
  try {
    const terms = await termsFromZeroSetupRun(dir, "  Jane Smith, Agency A  ");
    expect(terms.identity).toBe("Jane Smith, Agency A");
  } finally {
    exitSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
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
      connToRunProtocol = optionsArg(callArgs)
        .connection as SFTPConnectionConfig;
      // bootstrap present but no secret and no partner intent: finalizeBootstrap
      // (save === false) only logs the recurring-exchange hint, writing nothing.
      return driveCompletedExchange(callArgs, { partnerSaveIntent: false });
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
    // The handler wires first-use host-key trust on the unsaved (ephemeral) path:
    // it prompts on a TTY and fails closed otherwise (covered in hostKeyTrust.test.ts).
    expect(vi.mocked(establishHostKeyTrust)).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "sftp" }),
      expect.objectContaining({ persistence: { mode: "ephemeral" } }),
    );
  } finally {
    exitSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("handler: a result file the exchange could not write exits 73, not 69", async () => {
  // The zero-setup half of the published contract (docs/CLI.md, Exit codes): a
  // retried zero-setup run conducts a second exchange, re-sending this party's
  // data, so the code that says "do not re-run" has to survive this boundary.
  // runProtocol stamps the error at the failed result write (protocol.test.ts
  // drives the real stamp); measured here is what the COMMAND reports. A boundary
  // mapping every non-usage error to 69 fails only this.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-zeroexit-"));
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
    code?: number,
  ) => {
    throw new Error(`exit:${code ?? 0}`);
  }) as never);
  try {
    const input = path.join(dir, "input.csv");
    fs.writeFileSync(
      input,
      "first_name,last_name,date_of_birth\nBob,Jones,1990-01-02\n",
    );
    vi.mocked(runProtocol).mockRejectedValueOnce(
      Object.assign(
        new Error("EACCES: permission denied, open 'results.csv'"),
        {
          exitCode: PERSISTENCE_LOSS_EXIT_CODE,
        },
      ),
    );

    await expect(
      handler({
        _: ["sftp://userb@localhost:2222/drop", input],
        $0: "psilink",
        "config-file": path.join(dir, "psilink.yaml"),
        "key-file": path.join(dir, ".psilink.key"),
        identity: "Tester",
        record: false,
        "log-level": "silent",
      } as unknown as Arguments),
    ).rejects.toThrow("exit:73");
  } finally {
    exitSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("handler with --save carries the first-use pin into the written config", async () => {
  // The save-with-config path: establishHostKeyTrust mutates the ORIGINAL
  // connection in memory (emulated by the mock here), and the handler must carry
  // that mutated object into buildSaveSpec -> saveConfig so the confirmed pin
  // lands on disk. Guards the buildSaveSpec(connection) object choice against a
  // refactor that would persist the unmutated clone and silently re-prompt every
  // run.
  const FP = "SHA256:" + "C".repeat(43);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-zerosave-"));
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
    code?: number,
  ) => {
    throw new Error(`exit:${code ?? 0}`);
  }) as never);
  try {
    const input = path.join(dir, "input.csv");
    fs.writeFileSync(
      input,
      "first_name,last_name,date_of_birth\nBob,Jones,1990-01-02\n",
    );
    const configFile = path.join(dir, "psilink.yaml");

    // Emulate just the real establishHostKeyTrust mutation (its own behavior is
    // covered in hostKeyTrust.test.ts); the persistence wiring is what's tested.
    vi.mocked(establishHostKeyTrust).mockImplementationOnce((async (
      conn: SFTPConnectionConfig,
    ) => {
      conn.server.hostKeyFingerprint = FP;
    }) as never);
    // --save with no partner save-intent: finalizeBootstrap writes the config
    // alone (no shared secret, no key file).
    vi.mocked(runProtocol).mockImplementationOnce((async (
      ...callArgs: unknown[]
    ) =>
      driveCompletedExchange(callArgs, { partnerSaveIntent: false })) as never);

    await handler({
      _: ["sftp://userb@localhost:2222/drop", input],
      $0: "psilink",
      save: true,
      "config-file": configFile,
      "key-file": path.join(dir, ".psilink.key"),
      identity: "Tester",
      record: false,
      "log-level": "silent",
    } as unknown as Arguments);

    expect(vi.mocked(establishHostKeyTrust)).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "sftp" }),
      expect.objectContaining({
        persistence: { mode: "save-with-config", configPath: configFile },
      }),
    );
    // The mutated connection flowed through buildSaveSpec -> saveConfig.
    expect(fs.readFileSync(configFile, "utf8")).toContain(FP);
  } finally {
    exitSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- handler: the dataset preparation precedes host-key trust ----------------
// A zero-setup run refused from its own input alone must not have connected to
// the server first, and on an sftp URL the first-use host-key step is what would
// connect: its probe opens a real transport. So the preparation that carries
// those refusals runs ahead of that step, and the two checks below hold that
// order rather than the comment beside it. Both stub establishHostKeyTrust (as
// the whole file does), so what they pin is the order of the two STEPS; that the
// probe is what the second one opens is hostKeyTrust.test.ts's.

test("handler: the dataset is prepared before host-key trust", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-zeroprepare-"));
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
    code?: number,
  ) => {
    throw new Error(`exit:${code ?? 0}`);
  }) as never);
  try {
    const input = path.join(dir, "input.csv");
    fs.writeFileSync(
      input,
      "first_name,last_name,date_of_birth\nBob,Jones,1990-01-02\n",
    );
    vi.mocked(prepareForExchange).mockClear();
    vi.mocked(establishHostKeyTrust).mockClear();
    vi.mocked(runProtocol).mockImplementationOnce((async (
      ...callArgs: unknown[]
    ) =>
      driveCompletedExchange(callArgs, { partnerSaveIntent: false })) as never);

    await handler({
      _: ["sftp://userb@localhost:2222/drop", input],
      $0: "psilink",
      "config-file": path.join(dir, "psilink.yaml"),
      "key-file": path.join(dir, ".psilink.key"),
      identity: "Tester",
      record: false,
      "log-level": "silent",
    } as unknown as Arguments);

    // Both steps ran: an order read off one call alone would take a silently
    // skipped step for a satisfied one. The host-key assertion doubles as the
    // check that this URL took the sftp path at all.
    expect(vi.mocked(prepareForExchange)).toHaveBeenCalled();
    expect(vi.mocked(establishHostKeyTrust)).toHaveBeenCalled();
    // Vitest stamps every mock call with a run-wide sequence number, which is
    // what orders calls on two separate mocks against each other.
    const [prepared] = vi.mocked(prepareForExchange).mock.invocationCallOrder;
    const [trusted] = vi.mocked(establishHostKeyTrust).mock.invocationCallOrder;
    expect(prepared).toBeLessThan(trusted);
  } finally {
    exitSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("handler: an input the prepare refuses exits 64 with no host-key probe", async () => {
  // The ordering above is a call order, which a handler that STARTED host-key
  // trust without awaiting it would satisfy just as well -- and then the probe
  // would have connected anyway. So the refusing case is driven too, over the
  // same sftp URL: a header naming a transmitted column too long to carry is
  // refused from this party's own file, and must end the run there, exit 64,
  // with the host-key step -- and so the probe inside it -- never entered.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-zerorefusal-"));
  const stderrChunks: string[] = [];
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((
    chunk: string | Uint8Array,
  ) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as never);
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
    code?: number,
  ) => {
    throw new Error(`exit:${code ?? 0}`);
  }) as never);
  try {
    const overlong = "z".repeat(300);
    const input = path.join(dir, "input.csv");
    fs.writeFileSync(
      input,
      `first_name,last_name,date_of_birth,${overlong}\n` +
        "Bob,Jones,1990-01-02,x\n",
    );
    vi.mocked(establishHostKeyTrust).mockClear();
    vi.mocked(runProtocol).mockClear();

    await expect(
      handler({
        _: ["sftp://userb@localhost:2222/drop", input],
        $0: "psilink",
        "config-file": path.join(dir, "psilink.yaml"),
        "key-file": path.join(dir, ".psilink.key"),
        identity: "Tester",
        record: false,
        "log-level": "error",
      } as unknown as Arguments),
    ).rejects.toThrow("exit:64");
    expect(stderrChunks.join("")).toContain("limit on a column name");
    expect(vi.mocked(establishHostKeyTrust)).not.toHaveBeenCalled();
    expect(vi.mocked(runProtocol)).not.toHaveBeenCalled();
  } finally {
    getLogger("psilink").setLevel("silent");
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("handler: a credential @path naming a missing file exits 64 with no host-key probe", async () => {
  // The same invariant over the other local refusal the connect path carries: a
  // `--server-password @path` whose file is not there is decided from this
  // party's own filesystem, so it must end the run before the host-key step --
  // whose probe opens a real transport -- is entered. The credential values are
  // therefore read ahead of that step even though they are applied after it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-zerocred-"));
  const stderrChunks: string[] = [];
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((
    chunk: string | Uint8Array,
  ) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as never);
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
    code?: number,
  ) => {
    throw new Error(`exit:${code ?? 0}`);
  }) as never);
  try {
    const input = path.join(dir, "input.csv");
    fs.writeFileSync(
      input,
      "first_name,last_name,date_of_birth\nBob,Jones,1990-01-02\n",
    );
    vi.mocked(establishHostKeyTrust).mockClear();
    vi.mocked(runProtocol).mockClear();

    await expect(
      handler({
        _: ["sftp://userb@localhost:2222/drop", input],
        $0: "psilink",
        "server-password": `@${path.join(dir, "absent-password")}`,
        "config-file": path.join(dir, "psilink.yaml"),
        "key-file": path.join(dir, ".psilink.key"),
        identity: "Tester",
        record: false,
        "log-level": "error",
      } as unknown as Arguments),
    ).rejects.toThrow("exit:64");
    expect(stderrChunks.join("")).toContain("cannot read the @-file reference");
    expect(vi.mocked(establishHostKeyTrust)).not.toHaveBeenCalled();
    expect(vi.mocked(runProtocol)).not.toHaveBeenCalled();
  } finally {
    getLogger("psilink").setLevel("silent");
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("handler: the first-use pin reaches the connection the exchange dials", async () => {
  // The other half of reading the credential files early: the connection handed
  // to runProtocol is still cloned AFTER the host-key step, so the pin that step
  // writes onto the original is what the real open() enforces. A clone taken at
  // the read instead would carry the resolved credential and no pin, and dial an
  // unverified server -- so the run driven here supplies both.
  const FP = "SHA256:" + "D".repeat(43);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-zeropin-"));
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

    vi.mocked(establishHostKeyTrust).mockImplementationOnce((async (
      conn: SFTPConnectionConfig,
    ) => {
      conn.server.hostKeyFingerprint = FP;
    }) as never);
    let connToRunProtocol: SFTPConnectionConfig | undefined;
    vi.mocked(runProtocol).mockImplementationOnce((async (
      ...callArgs: unknown[]
    ) => {
      connToRunProtocol = optionsArg(callArgs)
        .connection as SFTPConnectionConfig;
      return driveCompletedExchange(callArgs, { partnerSaveIntent: false });
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

    expect(connToRunProtocol?.server.hostKeyFingerprint).toBe(FP);
    // And the credential read before that step still reached the same object.
    expect(connToRunProtocol?.server.password).toBe("s3cret");
  } finally {
    exitSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- linkage strategy selection ----------------------------------------------

test("handler: an unrecognized --linkage-strategy exits 64, naming the valid values", async () => {
  // parseArgs validates the enum (parseLinkageStrategyFlag) before the logger
  // exists, so an unknown value is a clean usage error (exit 64) reported on
  // stderr, the same classification invite gives it.
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
        "linkage-strategy": "complete",
        "log-level": "silent",
      } as unknown as Arguments),
    ).rejects.toThrow("exit:64");
    expect(errSpy).toHaveBeenCalledWith(
      "unrecognized linkage-strategy: complete; expected cascade or single-pass",
    );
  } finally {
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
});

test("handler --save: the selected strategy flows into the saved config (single-pass, vs cascade by default)", async () => {
  // The selection rides into the terms zero-setup authors from its input and so
  // into the --save spec; omitting it leaves the cascade default. Drive the
  // handler to completion with runProtocol mocked and read the written config.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-zerostrategy-"));
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
    code?: number,
  ) => {
    throw new Error(`exit:${code ?? 0}`);
  }) as never);
  vi.mocked(runProtocol).mockImplementation((async (...callArgs: unknown[]) =>
    driveCompletedExchange(callArgs, { partnerSaveIntent: false })) as never);
  try {
    const input = path.join(dir, "input.csv");
    fs.writeFileSync(
      input,
      "first_name,last_name,date_of_birth\nBob,Jones,1990-01-02\n",
    );
    const runSave = async (
      configFile: string,
      strategy?: string,
    ): Promise<string> => {
      await handler({
        _: ["sftp://userb@localhost:2222/drop", input],
        $0: "psilink",
        save: true,
        ...(strategy !== undefined && { "linkage-strategy": strategy }),
        "config-file": configFile,
        "key-file": path.join(dir, path.basename(configFile) + ".key"),
        identity: "Tester",
        record: false,
        "log-level": "silent",
      } as unknown as Arguments);
      return fs.readFileSync(configFile, "utf8");
    };

    expect(await runSave(path.join(dir, "sp.yaml"), "single-pass")).toContain(
      "linkage_strategy: single-pass",
    );
    // Omitting the flag is unchanged from before it existed: cascade.
    expect(await runSave(path.join(dir, "def.yaml"))).toContain(
      "linkage_strategy: cascade",
    );
  } finally {
    exitSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("handler: zero-setup surfaces the single-pass disclosure note at selection", async () => {
  // The selection note is the ONLY single-pass disclosure surface for a
  // zero-setup party (there is no accept-side consent prompt), so pin that it
  // actually fires -- the config-content test above would still pass if the note
  // emission were deleted. It is a diagnostic, so getLogger("psilink").info now
  // routes to stderr (configureStderrLogging keeps stdout for result data); spy
  // on process.stderr.write to capture it, and setLevel to info so the note is
  // emitted regardless of the level a prior test left behind.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-zeronote-"));
  const stderrChunks: string[] = [];
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((
    chunk: string | Uint8Array,
  ) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
    code?: number,
  ) => {
    throw new Error(`exit:${code ?? 0}`);
  }) as never);
  getLogger("psilink").setLevel("info");
  vi.mocked(runProtocol).mockImplementation((async (...callArgs: unknown[]) =>
    driveCompletedExchange(callArgs, { partnerSaveIntent: false })) as never);
  try {
    const input = path.join(dir, "input.csv");
    fs.writeFileSync(
      input,
      "first_name,last_name,date_of_birth\nBob,Jones,1990-01-02\n",
    );
    await handler({
      _: ["sftp://userb@localhost:2222/drop", input],
      $0: "psilink",
      "linkage-strategy": "single-pass",
      "config-file": path.join(dir, "psilink.yaml"),
      "key-file": path.join(dir, ".psilink.key"),
      identity: "Tester",
      record: false,
      "log-level": "info",
    } as unknown as Arguments);
    expect(stderrChunks.join("")).toContain("consented disclosure tradeoff");
  } finally {
    getLogger("psilink").setLevel("silent");
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("handler: a zero-setup retain run states no consent fact about the retained files", async () => {
  // The coupling the retainedFiles consent copy rests on, pinned rather than
  // asserted in prose. That note tells a reader "what you send stays encrypted
  // there", which holds only on the authenticated accept paths that render it:
  // this one takes --retain-files too and runs its PSI frames over the bare
  // transport, with no application-layer encryption to promise, and it renders no
  // consent fact at all. Wiring consent facts into this path trips this test,
  // which is the point -- the note's claim has to be re-examined first.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-zeroretain-"));
  const stderrChunks: string[] = [];
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((
    chunk: string | Uint8Array,
  ) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
    code?: number,
  ) => {
    throw new Error(`exit:${code ?? 0}`);
  }) as never);
  getLogger("psilink").setLevel("info");
  let ran: FileDropConnectionConfig | undefined;
  vi.mocked(runProtocol).mockImplementation((async (...callArgs: unknown[]) => {
    ran = optionsArg(callArgs).connection as FileDropConnectionConfig;
    return driveCompletedExchange(callArgs, { partnerSaveIntent: false });
  }) as never);
  try {
    const input = path.join(dir, "input.csv");
    fs.writeFileSync(
      input,
      "first_name,last_name,date_of_birth\nBob,Jones,1990-01-02\n",
    );
    const drop = path.join(dir, "drop");
    fs.mkdirSync(drop);
    await handler({
      _: [`file://${drop}`, input],
      $0: "psilink",
      "retain-files": true,
      "config-file": path.join(dir, "psilink.yaml"),
      "key-file": path.join(dir, ".psilink.key"),
      identity: "Tester",
      record: false,
      "log-level": "info",
    } as unknown as Arguments);
    // The run is the retain one the note would be about: the flag reached the
    // connection (with the trio it implies), so the silence below is the
    // rendering's rather than a run that never entered retain mode.
    expect(ran?.options?.retainFiles).toBe(true);
    const emitted = stderrChunks.join("");
    expect(emitted).not.toContain(CONSENT_FACTS.retainedFiles.note);
    // A fragment as well as the whole sentence: a surface that wrapped or
    // re-flowed the copy would still carry this clause, and the whole-string
    // assertion alone would pass over it.
    expect(emitted).not.toContain("stays where the two of you meet");
    expect(emitted).not.toContain("exchange files (enforced)");
  } finally {
    getLogger("psilink").setLevel("silent");
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- handler: webrtc is refused for the reason it cannot work ----------------

test("handler refuses a webrtc URL by naming the missing rendezvous secret", async () => {
  // Deferred deliberately rather than unimplemented: the two parties find each
  // other at signaling ids derived from a shared secret, and a zero-setup
  // exchange is defined by not having one. The refusal has to say that, and it
  // has to come before any file is read or written.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-zerowebrtc-"));
  vi.mocked(runProtocol).mockClear();
  const stderrChunks: string[] = [];
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((
    chunk: string | Uint8Array,
  ) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as never);
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
    code?: number,
  ) => {
    throw new Error(`exit:${code ?? 0}`);
  }) as never);
  try {
    const input = path.join(dir, "input.csv");
    fs.writeFileSync(
      input,
      "first_name,last_name,date_of_birth\nBob,Jones,1990-01-02\n",
    );
    await expect(
      handler({
        _: ["wss://peers.example.org/", input],
        $0: "psilink",
        "config-file": path.join(dir, "psilink.yaml"),
        "key-file": path.join(dir, ".psilink.key"),
        identity: "Tester",
        record: false,
        "log-level": "error",
      } as unknown as Arguments),
    ).rejects.toThrow("exit:64");
    const reported = stderrChunks.join("");
    expect(reported).toContain("shared secret");
    expect(reported).toContain("psilink invite");
    // Nothing was attempted: no exchange, and no config or key reserved.
    expect(vi.mocked(runProtocol)).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(dir, "psilink.yaml"))).toBe(false);
  } finally {
    getLogger("psilink").setLevel("silent");
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- handler --save: a lost save is a persistence loss, not a failed run -----

/** A 43-character base64url token satisfying the sharedSecret format, standing
 *  in for the secret the initiator generates in-band when both parties save. */
const SECRET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/** The fixture the save-failure tests share: a temp directory holding an input
 *  CSV, plus the process spies each of them reads. `configFile` and `keyFile`
 *  are ordinary paths the run is told to write; the `unwritable*` pair sits
 *  under a dangling symlink, which reads as absent to the conflict gate (`lstat`
 *  resolves through it and reports ENOENT) yet fails the write that follows -- a
 *  real fault, not a stubbed writer, and one no file mode or process uid can
 *  mask. Pairing an ordinary config path with the unwritable key path drives the
 *  provisioner past its config write into the key failure. */
function saveFailureFixture(): {
  dir: string;
  input: string;
  configFile: string;
  unwritableConfigFile: string;
  keyFile: string;
  unwritableKeyFile: string;
  stderr: () => string;
  exitSpy: MockInstance;
  restore: () => void;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-zeroloss-"));
  const input = path.join(dir, "input.csv");
  fs.writeFileSync(
    input,
    "first_name,last_name,date_of_birth\nBob,Jones,1990-01-02\n",
  );
  const unreachable = path.join(dir, "unreachable");
  fs.symlinkSync(path.join(dir, "gone"), unreachable);
  const stderrChunks: string[] = [];
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((
    chunk: string | Uint8Array,
  ) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
    code?: number,
  ) => {
    throw new Error(`exit:${code ?? 0}`);
  }) as never);
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  vi.mocked(runProtocol).mockClear();
  return {
    dir,
    input,
    configFile: path.join(dir, "psilink.yaml"),
    unwritableConfigFile: path.join(unreachable, "psilink.yaml"),
    keyFile: path.join(dir, ".psilink.key"),
    unwritableKeyFile: path.join(unreachable, ".psilink.key"),
    stderr: () => stderrChunks.join(""),
    exitSpy,
    restore: () => {
      process.exitCode = previousExitCode;
      getLogger("psilink").setLevel("silent");
      stderrSpy.mockRestore();
      exitSpy.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("handler --save: a save that cannot reach disk warns on fd 3 and exits 73, not 69", async () => {
  // The exchange completed and its results are written; only the local
  // config/key write failed. That is the persistence-loss class, and a
  // supervisor reading the transport-failure code would retry -- which for a
  // zero-setup run means conducting a SECOND exchange and re-sending this
  // party's records. Both machine channels carry it: the warning names what is
  // missing, the exit code says do not re-run.
  const f = saveFailureFixture();
  getLogger("psilink").setLevel("error");
  vi.mocked(runProtocol).mockImplementation((async (...callArgs: unknown[]) =>
    driveCompletedExchange(callArgs, {
      partnerSaveIntent: true,
      sharedSecret: SECRET,
    })) as never);
  try {
    const { lines } = await captureFd3(() =>
      handler({
        _: ["sftp://userb@localhost:2222/drop", f.input],
        $0: "psilink",
        save: true,
        "event-stream": true,
        "config-file": f.unwritableConfigFile,
        "key-file": f.keyFile,
        identity: "Tester",
        record: false,
        "log-level": "error",
      } as unknown as Arguments),
    );
    // Read before restore() puts the process exit code back.
    const exitCode = process.exitCode;
    const stderr = f.stderr();
    expect(exitCode).toBe(PERSISTENCE_LOSS_EXIT_CODE);
    // The run itself did not fail, so no error boundary exited it: 69 and 64
    // both reach the process through exitWithError.
    expect(f.exitSpy).not.toHaveBeenCalled();
    expect(lines.map((l) => l.type)).toEqual(["warning"]);
    // Both artifacts this branch was asked to write are named, and the operator
    // is steered to invite rather than to a re-run.
    expect(String(lines[0].message)).toContain(f.unwritableConfigFile);
    expect(String(lines[0].message)).toContain(f.keyFile);
    expect(String(lines[0].message)).toContain("do not re-run");
    // The cause stays on the human log: the emitter escapes its message exactly
    // once, so pre-rendered error text would reach a supervisor double-escaped.
    expect(String(lines[0].message)).not.toContain("ENOENT");
    expect(stderr).toContain("ENOENT");
    // Nothing was half-written at the key path either.
    expect(fs.existsSync(f.keyFile)).toBe(false);
    // The run's own events and this loss ride one stream: runProtocol received
    // the emitter this command opened, not the raw flag.
    expect(
      typeof runtimeOptionsArg(vi.mocked(runProtocol).mock.calls[0])
        .eventStream,
    ).toBe("object");
  } finally {
    f.restore();
  }
});

test("handler --save: a failed key save whose rollback also fails names the config as written, not lost", async () => {
  // The both-saved corner where the two files end in DIFFERENT states: the
  // config was written, the key file then failed, and the rollback of that
  // config failed too, so the config is on disk. A notice that reported it as
  // unsaved would misstate what persisted and send the operator into the
  // conflict its own 'psilink invite' advice would hit.
  //
  // The key-write failure is real (the dangling-symlink path). Its rollback is
  // stubbed: no portable filesystem state makes a removal fail while the write
  // that placed the file, in the same directory moments earlier, succeeds.
  const f = saveFailureFixture();
  getLogger("psilink").setLevel("error");
  const realRmSync = fs.rmSync;
  const rmSpy = vi.spyOn(fs, "rmSync").mockImplementation(((
    target: fs.PathLike,
    options?: fs.RmOptions,
  ) => {
    if (target === f.configFile)
      throw Object.assign(new Error("EACCES: permission denied, unlink"), {
        code: "EACCES",
      });
    return realRmSync(target, options);
  }) as typeof fs.rmSync);
  vi.mocked(runProtocol).mockImplementation((async (...callArgs: unknown[]) =>
    driveCompletedExchange(callArgs, {
      partnerSaveIntent: true,
      sharedSecret: SECRET,
    })) as never);
  try {
    const { lines } = await captureFd3(() =>
      handler({
        _: ["sftp://userb@localhost:2222/drop", f.input],
        $0: "psilink",
        save: true,
        "event-stream": true,
        "config-file": f.configFile,
        "key-file": f.unwritableKeyFile,
        identity: "Tester",
        record: false,
        "log-level": "error",
      } as unknown as Arguments),
    );
    const exitCode = process.exitCode;
    const stderr = f.stderr();
    expect(exitCode).toBe(PERSISTENCE_LOSS_EXIT_CODE);
    expect(f.exitSpy).not.toHaveBeenCalled();
    expect(lines.map((l) => l.type)).toEqual(["warning"]);
    // The claim made about each file, against what is actually on disk.
    const notice = String(lines[0].message);
    expect(notice).toContain(
      `the key file at ${f.unwritableKeyFile} did not reach disk`,
    );
    expect(notice).toContain(
      `the configuration at ${f.configFile} was written and could not be ` +
        "removed",
    );
    expect(fs.existsSync(f.configFile)).toBe(true);
    expect(fs.existsSync(f.unwritableKeyFile)).toBe(false);
    // Still the same class of loss: no re-run, and the cause stays on the human
    // log rather than reaching the supervisor double-escaped.
    expect(notice).toContain("do not re-run");
    expect(notice).not.toContain("ENOENT");
    expect(stderr).toContain("ENOENT");
  } finally {
    rmSpy.mockRestore();
    f.restore();
  }
});

test("handler --save: a config that appeared after the pre-flight is the same loss, not a usage error", async () => {
  // The other way the save fails: the up-front conflict gate passed, and a file
  // materialized at the config path in the window before the post-exchange
  // write. It stays a refusal to clobber -- but the exchange behind it
  // completed, so there is nothing about the invocation for the operator to
  // correct and exit 64 would invite the re-run 73 exists to prevent.
  const f = saveFailureFixture();
  getLogger("psilink").setLevel("error");
  vi.mocked(runProtocol).mockImplementation((async (...callArgs: unknown[]) => {
    fs.writeFileSync(f.configFile, "preexisting: true\n");
    return driveCompletedExchange(callArgs, { partnerSaveIntent: false });
  }) as never);
  try {
    const { lines } = await captureFd3(() =>
      handler({
        _: ["sftp://userb@localhost:2222/drop", f.input],
        $0: "psilink",
        save: true,
        "event-stream": true,
        "config-file": f.configFile,
        "key-file": f.keyFile,
        identity: "Tester",
        record: false,
        "log-level": "error",
      } as unknown as Arguments),
    );
    const exitCode = process.exitCode;
    const stderr = f.stderr();
    expect(exitCode).toBe(PERSISTENCE_LOSS_EXIT_CODE);
    expect(f.exitSpy).not.toHaveBeenCalled();
    expect(lines.map((l) => l.type)).toEqual(["warning"]);
    // The partner declined to save, so only the config was due; the notice must
    // not claim a key file that was never going to be written.
    expect(String(lines[0].message)).toContain(f.configFile);
    expect(String(lines[0].message)).not.toContain(f.keyFile);
    // The conflicting file is named on the human log and left exactly as it was.
    expect(stderr).toContain("refusing to overwrite");
    expect(fs.readFileSync(f.configFile, "utf8")).toBe("preexisting: true\n");
  } finally {
    f.restore();
  }
});

test("handler --save: a completed exchange carrying no bootstrap result reports the loss rather than saving in silence", async () => {
  // The hook's internal-contradiction branch. runProtocol drove the
  // completed-exchange hook -- so the exchange finished and its results are
  // written -- yet handed it no bootstrap result, though this command always
  // passes a boolean --save intent. There is nothing to provision from, and the
  // config path here is an ordinary writable one, so a run that skipped the save
  // in silence would exit clean with nothing on disk and no way for a supervisor
  // to tell. It takes the same persistence-loss report as a failed write.
  const f = saveFailureFixture();
  getLogger("psilink").setLevel("error");
  vi.mocked(runProtocol).mockImplementation((async (...callArgs: unknown[]) =>
    driveCompletedExchange(callArgs, undefined)) as never);
  try {
    const { lines } = await captureFd3(() =>
      handler({
        _: ["sftp://userb@localhost:2222/drop", f.input],
        $0: "psilink",
        save: true,
        "event-stream": true,
        "config-file": f.configFile,
        "key-file": f.keyFile,
        identity: "Tester",
        record: false,
        "log-level": "error",
      } as unknown as Arguments),
    );
    const exitCode = process.exitCode;
    const stderr = f.stderr();
    expect(exitCode).toBe(PERSISTENCE_LOSS_EXIT_CODE);
    expect(f.exitSpy).not.toHaveBeenCalled();
    expect(lines.map((l) => l.type)).toEqual(["warning"]);
    const notice = String(lines[0].message);
    expect(notice).toContain(f.configFile);
    expect(notice).toContain("do not re-run");
    // Operator-facing and well-formed: the absent result reaches the notice as
    // neither an interpolated hole nor the internal wording, both of which stay
    // on the human log with the rest of the cause.
    expect(notice).not.toContain("undefined");
    expect(notice).not.toContain("internal error");
    expect(stderr).toContain("internal error");
    // Nothing was provisioned from the contradiction.
    expect(fs.existsSync(f.configFile)).toBe(false);
    expect(fs.existsSync(f.keyFile)).toBe(false);
  } finally {
    f.restore();
  }
});

test("handler --save: the save rides the pre-terminal hook, not the return from runProtocol", async () => {
  // WHERE the save happens is the contract, not just that it happens: run after
  // runProtocol returns, the warning above lands BEHIND the run's terminal
  // event, which the stream spec forbids and a supervisor that stops reading
  // there discards outright. So a runProtocol that completes its exchange but
  // never invokes the hook must leave nothing on disk -- and its resolved result
  // holds no bootstrap material a post-return save could provision from. This is
  // the one test the hook's invocation is visible to -- every other --save test
  // drives it and would pass just as well with the save back on the
  // post-return path.
  const f = saveFailureFixture();
  vi.mocked(runProtocol).mockImplementation((async () => ({
    observedReceivedPayloadColumns: [],
  })) as never);
  try {
    await handler({
      _: ["sftp://userb@localhost:2222/drop", f.input],
      $0: "psilink",
      save: true,
      "config-file": f.configFile,
      "key-file": f.keyFile,
      identity: "Tester",
      record: false,
      "log-level": "silent",
    } as unknown as Arguments);
    expect(fs.existsSync(f.configFile)).toBe(false);
    // The hook was offered to runProtocol; it simply was not called.
    expect(
      runtimeOptionsArg(vi.mocked(runProtocol).mock.calls[0]).onOutputComplete,
    ).toBeTypeOf("function");
  } finally {
    f.restore();
  }
});
