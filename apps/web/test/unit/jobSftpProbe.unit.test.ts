import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  buildSftpProbeUrl,
  parseProbeStdout,
  probeSftpHostKey,
  reconcileProbeExit,
} from "@jobs/sftpProbe";

import {
  STUB_CLI_PATH,
  TEST_HOST_KEY_FINGERPRINT,
  tempDataRoot,
} from "../utils/jobFixtures";

const dirs: Array<string> = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

function scratchDir(): string {
  const dir = tempDataRoot("probe");
  dirs.push(dir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const okLine = (
  fingerprint = TEST_HOST_KEY_FINGERPRINT,
  keyType = "ssh-ed25519",
) => JSON.stringify({ fingerprint, key_type: keyType }) + "\n";

describe("buildSftpProbeUrl composes a bare sftp URL", () => {
  test("host only", () => {
    expect(buildSftpProbeUrl("sftp.example.org", undefined)).toBe(
      "sftp://sftp.example.org",
    );
  });

  test("host and port", () => {
    expect(buildSftpProbeUrl("sftp.example.org", 2222)).toBe(
      "sftp://sftp.example.org:2222",
    );
  });

  test("brackets a bare IPv6 literal", () => {
    expect(buildSftpProbeUrl("2001:db8::1", 22)).toBe(
      "sftp://[2001:db8::1]:22",
    );
  });
});

describe("reconcileProbeExit maps the child's exit", () => {
  test("exit 69 is unreachable", () => {
    expect(reconcileProbeExit(69, "")).toEqual({ kind: "unreachable" });
  });

  test("a non-zero, non-69 exit is an error", () => {
    expect(reconcileProbeExit(64, okLine())).toEqual({ kind: "error" });
    expect(reconcileProbeExit(1, okLine())).toEqual({ kind: "error" });
    expect(reconcileProbeExit(null, okLine())).toEqual({ kind: "error" });
  });

  test("exit 0 with an overflowed (undefined) stdout is an error", () => {
    expect(reconcileProbeExit(0, undefined)).toEqual({ kind: "error" });
  });

  test("exit 0 with a valid line is ok", () => {
    expect(reconcileProbeExit(0, okLine())).toEqual({
      kind: "ok",
      fingerprint: TEST_HOST_KEY_FINGERPRINT,
      keyType: "ssh-ed25519",
    });
  });
});

describe("parseProbeStdout re-validates every field at the trust boundary", () => {
  test("a valid line yields ok", () => {
    expect(parseProbeStdout(okLine())).toEqual({
      kind: "ok",
      fingerprint: TEST_HOST_KEY_FINGERPRINT,
      keyType: "ssh-ed25519",
    });
  });

  test("a non-JSON line is an error", () => {
    expect(parseProbeStdout("not json")).toEqual({ kind: "error" });
    expect(parseProbeStdout("")).toEqual({ kind: "error" });
  });

  test("a non-canonical fingerprint is an error", () => {
    expect(parseProbeStdout(okLine("not-a-fingerprint"))).toEqual({
      kind: "error",
    });
  });

  test("a key type with a control byte is rejected (charset check)", () => {
    expect(
      parseProbeStdout(okLine(TEST_HOST_KEY_FINGERPRINT, "ssh-[31mevil")),
    ).toEqual({ kind: "error" });
  });

  test("an over-long key type is rejected (length cap)", () => {
    expect(
      parseProbeStdout(okLine(TEST_HOST_KEY_FINGERPRINT, "a".repeat(65))),
    ).toEqual({ kind: "error" });
  });

  test("a certificate host-key type (with @ and .) is accepted", () => {
    expect(
      parseProbeStdout(
        okLine(TEST_HOST_KEY_FINGERPRINT, "ssh-ed25519-cert-v01@openssh.com"),
      ),
    ).toEqual({
      kind: "ok",
      fingerprint: TEST_HOST_KEY_FINGERPRINT,
      keyType: "ssh-ed25519-cert-v01@openssh.com",
    });
  });
});

describe("probeSftpHostKey drives the CLI probe subcommand", () => {
  test("spawns the exact argv template and returns ok on a valid line", async () => {
    const argvFile = path.join(scratchDir(), "argv.json");
    const result = await probeSftpHostKey({
      host: "sftp.example.org",
      port: 2222,
      binaryPath: STUB_CLI_PATH,
      childEnv: { STUB_PROBE_STDOUT: okLine(), STUB_ARGV_FILE: argvFile },
    });
    expect(result).toEqual({
      kind: "ok",
      fingerprint: TEST_HOST_KEY_FINGERPRINT,
      keyType: "ssh-ed25519",
    });
    const argv = JSON.parse(fs.readFileSync(argvFile, "utf8")) as Array<string>;
    // argv[0] is node, argv[1] the CLI binary; the driven arguments follow.
    expect(argv.slice(2)).toEqual([
      "probe-host-key",
      "sftp://sftp.example.org:2222",
      "--json",
      "--connect-timeout",
      "10s",
    ]);
  });

  test("exit 69 (transport failure) is unreachable", async () => {
    const result = await probeSftpHostKey({
      host: "sftp.example.org",
      binaryPath: STUB_CLI_PATH,
      childEnv: { STUB_EXIT_CODE: "69" },
    });
    expect(result).toEqual({ kind: "unreachable" });
  });

  test("a malformed stdout line is an error", async () => {
    const result = await probeSftpHostKey({
      host: "sftp.example.org",
      binaryPath: STUB_CLI_PATH,
      childEnv: { STUB_PROBE_STDOUT: "not json\n" },
    });
    expect(result).toEqual({ kind: "error" });
  });

  test("a bad fingerprint is an error", async () => {
    const result = await probeSftpHostKey({
      host: "sftp.example.org",
      binaryPath: STUB_CLI_PATH,
      childEnv: { STUB_PROBE_STDOUT: okLine("not-a-fingerprint") },
    });
    expect(result).toEqual({ kind: "error" });
  });

  test("an oversized stdout flood is an error, never buffered unbounded", async () => {
    const result = await probeSftpHostKey({
      host: "sftp.example.org",
      binaryPath: STUB_CLI_PATH,
      childEnv: { STUB_PROBE_STDOUT: "x".repeat(8192) },
    });
    expect(result).toEqual({ kind: "error" });
  });

  test("the watchdog kills a hung child and reports a timeout", async () => {
    const result = await probeSftpHostKey({
      host: "sftp.example.org",
      binaryPath: STUB_CLI_PATH,
      // A child that ignores SIGTERM and would otherwise run for 5s; the watchdog
      // SIGTERMs at 50ms and SIGKILLs 50ms later, bounding the wait as a timeout.
      childEnv: { STUB_IGNORE_SIGTERM: "1", STUB_DELAY_MS: "5000" },
      sigtermMs: 50,
      sigkillGraceMs: 50,
    });
    expect(result).toEqual({ kind: "timeout" });
  });
});
