import {
  expect,
  test,
  vi,
  beforeEach,
  afterEach,
  type MockInstance,
} from "vitest";
import fs from "node:fs";
import {
  channelFromURL,
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

test("unsupported URL scheme throws", () => {
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
