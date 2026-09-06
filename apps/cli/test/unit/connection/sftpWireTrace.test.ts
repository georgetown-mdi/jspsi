import logLibrary from "loglevel";
import { afterEach, describe, expect, test } from "vitest";

import {
  DISPLAY_TRUNCATION_MARKER,
  getLogger,
  getLoggerForVerbosity,
  setLogLevel,
} from "@psilink/core";

import {
  SSH_WIRE_TRACE_LOGGER_NAME,
  SSH_WIRE_TRACE_MAX_DISPLAY_LENGTH,
  sshWireTrace,
  sshWireTraceLine,
} from "../../../src/connection/sftpWireTrace";
import type { WireTraceLogger } from "../../../src/connection/sftpWireTrace";

// The escaping and the level gate on the SSH stack's diagnostic lines, and the
// level the logger the trace rides comes up at -- driven against the real
// loglevel registry rather than modeled from its resolution order. What the
// installed stack actually emits into those lines -- and that a real server's
// bytes arrive needing this escape -- is DRIVEN, off a real dial, in
// test/integration/sftpWireTrace.test.ts.

/** Records what a logger at `level` was asked to trace. */
function recordingLogger(level: number): WireTraceLogger & {
  traced: string[];
} {
  const traced: string[] = [];
  return {
    traced,
    getLevel: () => level,
    trace: (message: string) => traced.push(message),
  };
}

describe("sshWireTraceLine", () => {
  test("passes a line the stack composed through unchanged", () => {
    expect(sshWireTraceLine("Handshake completed")).toBe("Handshake completed");
  });

  test("escapes the bytes a server chooses", () => {
    const line = sshWireTraceLine(
      "Remote ident: 'SSH-2.0-\x1b[31mred\rback\\slash'",
    );
    expect(line).not.toContain("\x1b");
    expect(line).not.toContain("\r");
    expect(line).toContain("\\x1b");
    expect(line).toContain("\\x0d");
    expect(line).toContain("back\\\\slash");
  });

  test("keeps a multi-line emission on one log line", () => {
    expect(sshWireTraceLine("Version: 1\n node: 2")).not.toContain("\n");
  });

  test("admits a whole algorithm name-list", () => {
    const nameList = Array.from(
      { length: 12 },
      (_, index) => `diffie-hellman-group${index}-sha512`,
    ).join(",");
    const line = sshWireTraceLine(
      `Handshake: (remote) KEX method: ${nameList}`,
    );
    expect(line).toContain(nameList);
    expect(line).not.toContain(DISPLAY_TRUNCATION_MARKER);
  });

  test("bounds a peer that pads its name-list", () => {
    const line = sshWireTraceLine("x".repeat(4096));
    expect(line).toContain(DISPLAY_TRUNCATION_MARKER);
    expect(line.length).toBeLessThanOrEqual(
      SSH_WIRE_TRACE_MAX_DISPLAY_LENGTH + DISPLAY_TRUNCATION_MARKER.length,
    );
  });

  test("strips a private-key block", () => {
    const line = sshWireTraceLine(
      "-----BEGIN OPENSSH PRIVATE KEY-----\nc2VjcmV0\n-----END OPENSSH PRIVATE KEY-----",
    );
    expect(line).not.toContain("c2VjcmV0");
  });
});

describe("sshWireTrace", () => {
  test("installs nothing below the trace level", () => {
    for (const level of [
      logLibrary.levels.DEBUG,
      logLibrary.levels.INFO,
      logLibrary.levels.WARN,
      logLibrary.levels.ERROR,
      logLibrary.levels.SILENT,
    ])
      expect(sshWireTrace(recordingLogger(level))).toBeUndefined();
  });

  test("traces every line escaped at the trace level", () => {
    const log = recordingLogger(logLibrary.levels.TRACE);
    const trace = sshWireTrace(log);
    expect(trace).toBeDefined();
    trace!.emit("Remote ident: 'SSH-2.0-\x1b[31mred'");
    trace!.emit("Handshake completed");
    expect(log.traced).toEqual([
      "Remote ident: 'SSH-2.0-\\x1b[31mred'",
      "Handshake completed",
    ]);
  });

  test("traces nothing once detached, however often it is called", () => {
    const log = recordingLogger(logLibrary.levels.TRACE);
    const trace = sshWireTrace(log)!;
    trace.emit("Handshake completed");
    trace.detach();
    trace.emit("Socket ended");
    trace.detach();
    trace.emit("Socket closed");
    expect(log.traced).toEqual(["Handshake completed"]);
  });
});

describe("the logger the trace rides", () => {
  const rootLevelAtLoad = logLibrary.getLevel();
  afterEach(() => {
    setLogLevel(rootLevelAtLoad);
  });

  test.for([
    { name: "trace", level: logLibrary.levels.TRACE },
    { name: "debug", level: logLibrary.levels.DEBUG },
    { name: "info", level: logLibrary.levels.INFO },
    { name: "warn", level: logLibrary.levels.WARN },
    { name: "error", level: logLibrary.levels.ERROR },
    { name: "silent", level: logLibrary.levels.SILENT },
  ])("comes up at the root level $name", ({ level }) => {
    setLogLevel(level);
    const log = getLogger(SSH_WIRE_TRACE_LOGGER_NAME);
    expect(log.getLevel()).toBe(level);
    expect(sshWireTrace(log) !== undefined).toBe(
      level === logLibrary.levels.TRACE,
    );
  });

  test("is at trace with a root level of trace and no -v count", () => {
    setLogLevel(logLibrary.levels.TRACE);
    for (const verbosity of [0, 1]) {
      const adapterLog = getLoggerForVerbosity("sftp-adapter", verbosity);
      const log = getLogger(SSH_WIRE_TRACE_LOGGER_NAME);
      expect(adapterLog.getLevel()).toBeGreaterThan(logLibrary.levels.TRACE);
      expect(log.getLevel()).toBe(logLibrary.levels.TRACE);
      expect(sshWireTrace(log)).toBeDefined();
    }
  });

  test("is not brought to trace by the -v count alone", () => {
    setLogLevel(logLibrary.levels.DEBUG);
    getLoggerForVerbosity("sftp-adapter", 2);
    const log = getLogger(SSH_WIRE_TRACE_LOGGER_NAME);
    expect(log.getLevel()).toBe(logLibrary.levels.DEBUG);
    expect(sshWireTrace(log)).toBeUndefined();
  });
});
