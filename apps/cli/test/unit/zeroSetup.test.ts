import {
  expect,
  test,
  vi,
  beforeEach,
  afterEach,
  type MockInstance,
} from "vitest";
import fs from "node:fs";
import type { Arguments } from "yargs";
import { UsageError } from "@psilink/core";
import {
  channelFromURL,
  createConnection,
  handler,
  resolvePositionals,
} from "../../src/commands/zeroSetup";

let existsSyncSpy: MockInstance;

beforeEach(() => {
  existsSyncSpy = vi.spyOn(fs, "existsSync");
});

afterEach(() => {
  existsSyncSpy.mockRestore();
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
