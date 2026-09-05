import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { DISPLAY_TRUNCATION_MARKER } from "@psilink/core";

import {
  PROBE_CONNECT_TIMEOUT_MS,
  PROBE_EXCERPT_MAX_DISPLAY_LENGTH,
  PROBE_PEER_READ_BUDGET_MS,
  PROBE_SIGTERM_MS,
  buildSftpProbeUrl,
  parseProbeDiagnosis,
  parseProbeStdout,
  probeSftpHostKey,
  reconcileProbeExit,
} from "@jobs/sftpProbe";

import {
  STUB_CLI_PATH,
  TEST_HOST_KEY_FINGERPRINT,
  tempDataRoot,
} from "../utils/jobFixtures";

import type { SftpProbeResult } from "@jobs/sftpProbe";

/** The repository root, from this file's place at apps/web/test/unit/. */
const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

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

// The diagnosis is the CLI's, held as structured fields. Every field is
// re-checked here because it is a distrusted child's stdout, and the excerpt
// is bytes an untrusted party chose.
describe("parseProbeDiagnosis re-validates the exit-69 diagnosis line", () => {
  test("a closed-unanswered line parses to its kind", () => {
    expect(parseProbeDiagnosis('{"diagnosis":"closed_unanswered"}')).toEqual({
      kind: "closedUnanswered",
    });
  });

  test("a non-SSH line includes the shape and the excerpt", () => {
    expect(
      parseProbeDiagnosis(
        JSON.stringify({
          diagnosis: "non_ssh",
          shape: "http",
          excerpt: "HTTP/1.1 403 Forbidden",
        }),
      ),
    ).toEqual({
      kind: "nonSsh",
      shape: "http",
      excerpt: "HTTP/1.1 403 Forbidden",
    });
  });

  test("the excerpt is escaped, so no control byte the peer chose survives", () => {
    // The peer's bytes are written as escapes so this source stays printable;
    // what the parser is handed is the control characters they denote.
    const diagnosis = parseProbeDiagnosis(
      JSON.stringify({
        diagnosis: "non_ssh",
        shape: "unrecognized",
        excerpt: "\u001b[31mred\u0000\n",
      }),
    );
    expect(diagnosis?.kind).toBe("nonSsh");
    const excerpt =
      diagnosis?.kind === "nonSsh" ? diagnosis.excerpt : undefined;
    expect(excerpt).not.toContain("\u001b");
    expect(excerpt).not.toContain("\u0000");
    expect(excerpt).not.toContain("\n");
    expect(excerpt).toContain("\\x1b");
  });

  test("the excerpt is capped, so a child past its own bound cannot grow the response", () => {
    const diagnosis = parseProbeDiagnosis(
      JSON.stringify({
        diagnosis: "non_ssh",
        shape: "unrecognized",
        excerpt: "A".repeat(4000),
      }),
    );
    const excerpt =
      diagnosis?.kind === "nonSsh" ? diagnosis.excerpt : undefined;
    // The escape's own truncation marker rides on top of the cap it applies to
    // the escaped text, so the bound is the pair -- and either way the excerpt
    // is a fixed length rather than whatever the child sent.
    expect(excerpt?.length).toBeLessThanOrEqual(
      PROBE_EXCERPT_MAX_DISPLAY_LENGTH + DISPLAY_TRUNCATION_MARKER.length,
    );
    expect(excerpt?.endsWith(DISPLAY_TRUNCATION_MARKER)).toBe(true);
  });

  test("a shape outside the closed vocabulary is dropped, not kept", () => {
    expect(
      parseProbeDiagnosis(
        JSON.stringify({
          diagnosis: "non_ssh",
          shape: "gopher",
          excerpt: "x",
        }),
      ),
    ).toBeUndefined();
  });

  test("an unknown discriminant, a non-string excerpt, and a non-JSON line all degrade to no diagnosis", () => {
    expect(parseProbeDiagnosis('{"diagnosis":"whatever"}')).toBeUndefined();
    expect(
      parseProbeDiagnosis(
        JSON.stringify({ diagnosis: "non_ssh", shape: "http", excerpt: 7 }),
      ),
    ).toBeUndefined();
    expect(parseProbeDiagnosis("not json")).toBeUndefined();
    expect(parseProbeDiagnosis("")).toBeUndefined();
  });

  test("a success line has no diagnosis, so the two shapes cannot be read for one another", () => {
    expect(parseProbeDiagnosis(okLine())).toBeUndefined();
  });
});

describe("an unreachable probe has the child's diagnosis when it emitted one", () => {
  test("exit 69 with a diagnosis line attaches it to the unreachable result", () => {
    expect(reconcileProbeExit(69, '{"diagnosis":"closed_unanswered"}')).toEqual(
      {
        kind: "unreachable",
        diagnosis: { kind: "closedUnanswered" },
      },
    );
  });

  test("exit 69 with no diagnosis is the bare unreachable it has always been", () => {
    expect(reconcileProbeExit(69, "")).toEqual({ kind: "unreachable" });
    expect(reconcileProbeExit(69, undefined)).toEqual({ kind: "unreachable" });
  });

  test("the driven child's diagnosis line reaches the caller", async () => {
    const result = await probeSftpHostKey({
      host: "sftp.example.org",
      binaryPath: STUB_CLI_PATH,
      childEnv: {
        STUB_EXIT_CODE: "69",
        STUB_PROBE_STDOUT:
          JSON.stringify({
            diagnosis: "non_ssh",
            shape: "tls-alert",
            excerpt: "\u0015\u0003\u0003",
          }) + "\n",
      },
    });
    expect(result).toEqual({
      kind: "unreachable",
      diagnosis: {
        kind: "nonSsh",
        shape: "tls-alert",
        excerpt: "\\x15\\x03\\x03",
      },
    });
  });

  // The CLI escapes the bytes it cannot let onto a terminal as JSON's OWN
  // `\uHHHH`, which is an encoding of the line rather than a sanitization of the
  // value. So this boundary must see exactly what it saw when the same bytes
  // crossed raw, and escape them once. Driven end to end through a spawned child
  // -- the same path a real probe takes -- with the two encodings of one answer,
  // rather than reasoned about from the encoder's shape.
  test("a JSON-escaped excerpt and the same bytes raw reach this boundary alike", async () => {
    const del = String.fromCharCode(0x7f);
    const c1 = String.fromCharCode(0x9b);
    const drive = async (line: string): Promise<SftpProbeResult> =>
      probeSftpHostKey({
        host: "sftp.example.org",
        binaryPath: STUB_CLI_PATH,
        childEnv: { STUB_EXIT_CODE: "69", STUB_PROBE_STDOUT: line + "\n" },
      });

    const escaped = await drive(
      '{"diagnosis":"non_ssh","shape":"http","excerpt":"a\\u007fb\\u009bc"}',
    );
    const raw = await drive(
      JSON.stringify({
        diagnosis: "non_ssh",
        shape: "http",
        excerpt: `a${del}b${c1}c`,
      }),
    );
    expect(escaped).toEqual(raw);
    // Escaped once: a `\xHH` per byte, not a doubled backslash or a surviving
    // `\u` form.
    expect(escaped).toEqual({
      kind: "unreachable",
      diagnosis: { kind: "nonSsh", shape: "http", excerpt: "a\\x7fb\\x9bc" },
    });
  });
});

describe("the diagnosis fits inside the probe's own watchdog", () => {
  // The child spends its connect budget and then, on a dial that died before the
  // peer identified itself, a bounded read of the peer's first bytes. Both run
  // under this server's watchdog, and crossing it would flip the typed result
  // from `unreachable` to `timeout` -- losing the diagnosis entirely. The
  // headroom is arithmetic here rather than a claim in a comment.
  test("the connect budget plus the peer read leaves headroom before the SIGTERM", () => {
    expect(PROBE_CONNECT_TIMEOUT_MS + PROBE_PEER_READ_BUDGET_MS).toBeLessThan(
      PROBE_SIGTERM_MS,
    );
  });

  // The read budget belongs to the CLI child; apps/web must not import apps/cli
  // (apps consume packages, not each other), so this mirror reads the CLI's own
  // declaration instead. It checks the declared value, not what the child
  // spends at runtime, so a source that no longer declares the constant fails
  // here rather than passing vacuously.
  test("the mirrored peer-read budget is the value the CLI declares", () => {
    const source = fs.readFileSync(
      path.join(
        REPO_ROOT,
        "apps",
        "cli",
        "src",
        "connection",
        "sftpPeerIdentification.ts",
      ),
      "utf8",
    );
    const declared = /PEER_ANSWER_READ_BUDGET_MS\s*=\s*([0-9_]+)\s*;/.exec(
      source,
    );
    expect(declared).not.toBeNull();
    expect(Number((declared?.[1] ?? "").replaceAll("_", ""))).toBe(
      PROBE_PEER_READ_BUDGET_MS,
    );
  });
});
