import { describe, expect, test } from "vitest";
import logLibrary from "loglevel";
import { getLogger, keyTypeFromBlob, UsageError } from "@psilink/core";
import type { PresentedHostKey, SFTPConnectionConfig } from "@psilink/core";

import {
  buildProbeConfig,
  probeHostKeyLines,
  type ProbeHostKeyDeps,
} from "../../src/commands/probeHostKey";
import { configureStderrLogging } from "../../src/util/cli";
import {
  captureStdio,
  snapshotDiagnosticSinkAndLevel,
} from "../loggingTestSupport";

snapshotDiagnosticSinkAndLevel();

const FP = "SHA256:" + "A".repeat(43);

// An injectable probe recording the config it was handed, so a test can assert
// both the emitted line and that the minimal config carried no credential.
function makeDeps(presented: PresentedHostKey): ProbeHostKeyDeps & {
  calls: number;
  lastConfig?: SFTPConnectionConfig;
} {
  const state: { calls: number; lastConfig?: SFTPConnectionConfig } = {
    calls: 0,
  };
  return {
    probe: (config): Promise<PresentedHostKey> => {
      state.calls += 1;
      state.lastConfig = config;
      return Promise.resolve(presented);
    },
    get calls() {
      return state.calls;
    },
    get lastConfig() {
      return state.lastConfig;
    },
  };
}

function rejectingDeps(error: unknown): ProbeHostKeyDeps {
  return { probe: () => Promise.reject(error) };
}

// A raw OpenSSH host-key blob naming `keyType`: a uint32 length prefix, the type
// bytes, then key bytes. Nothing bounds what a server puts in the type field, so
// the bytes are written here exactly as a hostile server would send them.
function hostKeyBlobNaming(keyType: string): Uint8Array {
  const type = new TextEncoder().encode(keyType);
  const blob = new Uint8Array(4 + type.length + 32);
  new DataView(blob.buffer).setUint32(0, type.length);
  blob.set(type, 4);
  return blob;
}

describe("buildProbeConfig parses the URL into a minimal connection", () => {
  test("keeps host and port, and never a credential or the URL's userinfo", () => {
    // Even a URL carrying userinfo and a path yields host+port plus a fixed
    // placeholder username: no password/path is composed, and the username is a
    // placeholder ssh2 requires -- never the URL's "user", and never sent.
    const config = buildProbeConfig(
      "sftp://user:pass@sftp.example.org:2222/exchange",
      10,
    );
    expect(config.channel).toBe("sftp");
    expect(config.server.host).toBe("sftp.example.org");
    expect(config.server.port).toBe(2222);
    expect(config.server.password).toBeUndefined();
    expect(config.server.path).toBeUndefined();
    // The username is a non-empty placeholder, never the URL's userinfo.
    expect(config.server.username).toBeTypeOf("string");
    expect(config.server.username).not.toBe("user");
    expect(config.server.username?.length).toBeGreaterThan(0);
    expect(config.options?.serverConnectTimeoutMs).toBe(10_000);
  });

  test("omits the options block when no connect timeout is given", () => {
    const config = buildProbeConfig("sftp://sftp.example.org", undefined);
    expect(config.server.host).toBe("sftp.example.org");
    expect(config.server.port).toBeUndefined();
    expect(config.options).toBeUndefined();
  });

  test("a non-sftp scheme is a UsageError (exit 64)", () => {
    expect(() => buildProbeConfig("ws://sftp.example.org", 10)).toThrow(
      UsageError,
    );
    expect(() => buildProbeConfig("file:///drop", 10)).toThrow(UsageError);
  });

  test("an unparseable URL is a UsageError", () => {
    expect(() => buildProbeConfig("not a url", 10)).toThrow(UsageError);
  });

  test("a host-less sftp URL is a UsageError", () => {
    expect(() => buildProbeConfig("sftp:///exchange", 10)).toThrow(UsageError);
  });
});

describe("probeHostKeyLines formats and validates the presented key", () => {
  test("--json emits exactly the snake_case machine line", async () => {
    const deps = makeDeps({ fingerprint: FP, keyType: "ssh-ed25519" });
    const result = await probeHostKeyLines(
      {
        sftpUrl: "sftp://sftp.example.org",
        connectTimeoutSeconds: 10,
        json: true,
        verbosity: 0,
      },
      deps,
    );
    expect(result.summary).toBeUndefined();
    expect(result.stdout).toBeDefined();
    expect(JSON.parse(result.stdout!)).toEqual({
      fingerprint: FP,
      key_type: "ssh-ed25519",
    });
    // The probe connection carried no credential -- the verifier refuses before
    // auth -- and no URL-derived username.
    expect(deps.lastConfig?.server.password).toBeUndefined();
    expect(deps.lastConfig?.server.username).not.toBe("user");
  });

  test("the human summary names the fingerprint and key type", async () => {
    const deps = makeDeps({ fingerprint: FP, keyType: "ssh-ed25519" });
    const result = await probeHostKeyLines(
      {
        sftpUrl: "sftp://sftp.example.org",
        connectTimeoutSeconds: 10,
        json: false,
        verbosity: 0,
      },
      deps,
    );
    expect(result.stdout).toBeUndefined();
    expect(result.summary).toContain(FP);
    expect(result.summary).toContain("ssh-ed25519");
  });

  test("neither output form carries a rejected key type's bytes", async () => {
    // Both forms print whatever the probe observed, and what it observes is
    // keyTypeFromBlob's output -- so the type is taken from the real primitive
    // over a hostile blob rather than from a string chosen here. The console
    // ingests the --json line, so the placeholder is what has to reach it.
    const keyType = keyTypeFromBlob(
      hostKeyBlobNaming("ssh-\x1b[31mevil\r\nINJECTED"),
    );
    const args = {
      sftpUrl: "sftp://sftp.example.org",
      connectTimeoutSeconds: 10,
      verbosity: 0,
    };

    const json = await probeHostKeyLines(
      { ...args, json: true },
      makeDeps({ fingerprint: FP, keyType }),
    );
    const emitted = JSON.parse(json.stdout!) as { key_type: string };
    expect(emitted.key_type).toMatch(/^\(unknown:[0-9a-f]+\)$/);
    expect(json.stdout).not.toContain("INJECTED");

    const human = await probeHostKeyLines(
      { ...args, json: false },
      makeDeps({ fingerprint: FP, keyType }),
    );
    expect(human.summary).toMatch(/presented a \(unknown:[0-9a-f]+\) host key/);
    expect(human.summary).not.toContain("INJECTED");
    // The comparison step the operator acts on is untouched.
    expect(human.summary).toContain(FP);
  });

  test("both output forms carry a conforming key type verbatim", async () => {
    const keyType = keyTypeFromBlob(
      hostKeyBlobNaming("ecdsa-sha2-nistp521-cert-v01@openssh.com"),
    );
    const args = {
      sftpUrl: "sftp://sftp.example.org",
      connectTimeoutSeconds: 10,
      verbosity: 0,
    };

    const json = await probeHostKeyLines(
      { ...args, json: true },
      makeDeps({ fingerprint: FP, keyType }),
    );
    expect(JSON.parse(json.stdout!)).toEqual({
      fingerprint: FP,
      key_type: "ecdsa-sha2-nistp521-cert-v01@openssh.com",
    });

    const human = await probeHostKeyLines(
      { ...args, json: false },
      makeDeps({ fingerprint: FP, keyType }),
    );
    expect(human.summary).toContain(
      "presented a ecdsa-sha2-nistp521-cert-v01@openssh.com host key",
    );
  });

  test("a private-key marker in the probed host cannot delete the verify step", async () => {
    // The host is the one fragment of this summary that can still carry a real
    // marker: a percent-encoded --sftp-url decodes back to literal spaces, so
    // the URL parse is no bound here (the key type's charset bound already rules
    // out the other). It sits ahead of the out-of-band verification step, and
    // the log sink redacts the whole line it is given, so the fragment is
    // redacted where it is interpolated instead. Asserted on the bytes stderr
    // wrote, not on the returned string.
    const marker = "-----BEGIN OPENSSH PRIVATE KEY-----";
    const human = await probeHostKeyLines(
      {
        sftpUrl: `sftp://${encodeURIComponent(marker)}`,
        connectTimeoutSeconds: 10,
        json: false,
        verbosity: 0,
      },
      makeDeps({ fingerprint: FP, keyType: "ssh-ed25519" }),
    );

    const captured = captureStdio();
    const sink = configureStderrLogging();
    logLibrary.setDefaultLevel(logLibrary.levels.INFO);
    try {
      getLogger("probe-host-key-redaction").info(human.summary!);
    } finally {
      sink.close();
      captured.restore();
    }

    const rendered = captured.stderrWrites.join("");
    expect(rendered).toContain("[redacted private key]");
    expect(rendered).toContain(
      "Verify it matches the server's published fingerprint out-of-band " +
        "before pinning it.",
    );
    expect(rendered).toContain(FP);
  });

  test("a non-canonical fingerprint is rejected before any line is produced", async () => {
    const deps = makeDeps({ fingerprint: "not-a-fingerprint", keyType: "x" });
    await expect(
      probeHostKeyLines(
        {
          sftpUrl: "sftp://sftp.example.org",
          connectTimeoutSeconds: 10,
          json: true,
          verbosity: 0,
        },
        deps,
      ),
    ).rejects.toThrow(/canonical/i);
  });

  test("exit mapping: a non-sftp URL rejects UsageError (64)", async () => {
    await expect(
      probeHostKeyLines(
        {
          sftpUrl: "ws://sftp.example.org",
          connectTimeoutSeconds: 10,
          json: true,
          verbosity: 0,
        },
        makeDeps({ fingerprint: FP, keyType: "ssh-ed25519" }),
      ),
    ).rejects.toBeInstanceOf(UsageError);
  });

  test("exit mapping: a transport failure rejects a plain Error (69)", async () => {
    const run = probeHostKeyLines(
      {
        sftpUrl: "sftp://sftp.example.org",
        connectTimeoutSeconds: 10,
        json: true,
        verbosity: 0,
      },
      rejectingDeps(new Error("ECONNREFUSED")),
    );
    await expect(run).rejects.toThrow(/ECONNREFUSED/);
    await expect(run).rejects.not.toBeInstanceOf(UsageError);
  });
});
