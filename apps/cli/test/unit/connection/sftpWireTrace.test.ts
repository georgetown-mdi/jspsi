import logLibrary from "loglevel";
import { describe, expect, test } from "vitest";

import { DISPLAY_TRUNCATION_MARKER } from "@psilink/core";

import {
  SSH_WIRE_TRACE_MAX_DISPLAY_LENGTH,
  SSH_WIRE_TRACE_PREFIX,
  sshWireTraceCallback,
  sshWireTraceLine,
} from "../../../src/connection/sftpWireTrace";
import type { WireTraceLogger } from "../../../src/connection/sftpWireTrace";

// The escaping and the level gate on the SSH stack's diagnostic lines. What the
// installed stack actually emits into them -- and that a real server's bytes
// arrive needing this escape -- is DRIVEN, off a real dial, in
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
  test("marks the line as the stack's own", () => {
    expect(sshWireTraceLine("Handshake completed")).toBe(
      `${SSH_WIRE_TRACE_PREFIX}Handshake completed`,
    );
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
      SSH_WIRE_TRACE_PREFIX.length +
        SSH_WIRE_TRACE_MAX_DISPLAY_LENGTH +
        DISPLAY_TRUNCATION_MARKER.length,
    );
  });

  test("strips a private-key block", () => {
    const line = sshWireTraceLine(
      "-----BEGIN OPENSSH PRIVATE KEY-----\nc2VjcmV0\n-----END OPENSSH PRIVATE KEY-----",
    );
    expect(line).not.toContain("c2VjcmV0");
  });
});

describe("sshWireTraceCallback", () => {
  test("installs nothing below the trace level", () => {
    for (const level of [
      logLibrary.levels.DEBUG,
      logLibrary.levels.INFO,
      logLibrary.levels.WARN,
      logLibrary.levels.ERROR,
      logLibrary.levels.SILENT,
    ])
      expect(sshWireTraceCallback(recordingLogger(level))).toBeUndefined();
  });

  test("traces every line escaped at the trace level", () => {
    const log = recordingLogger(logLibrary.levels.TRACE);
    const debug = sshWireTraceCallback(log);
    expect(debug).toBeDefined();
    debug!("Remote ident: 'SSH-2.0-\x1b[31mred'");
    debug!("Handshake completed");
    expect(log.traced).toEqual([
      `${SSH_WIRE_TRACE_PREFIX}Remote ident: 'SSH-2.0-\\x1b[31mred'`,
      `${SSH_WIRE_TRACE_PREFIX}Handshake completed`,
    ]);
  });
});
