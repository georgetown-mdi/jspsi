import { describe, expect, test } from "vitest";
import logLibrary from "loglevel";
import {
  getLogger,
  keyTypeFromBlob,
  sanitizeErrorForDisplay,
  sanitizeForDisplay,
  UsageError,
} from "@psilink/core";
import type { PresentedHostKey, SFTPConnectionConfig } from "@psilink/core";

import {
  buildProbeConfig,
  probeDiagnosisJsonLine,
  probeHostKeyLines,
  type ProbeHostKeyDeps,
} from "../../../src/commands/probeHostKey";
import { explainPeerIdentificationFailure } from "../../../src/connection/sftpPeerIdentification";
import { configureStderrLogging } from "../../../src/util/logging";
import {
  captureStdio,
  snapshotDiagnosticSinkAndLevel,
} from "../../loggingTestSupport";

snapshotDiagnosticSinkAndLevel();

const FP = "SHA256:" + "A".repeat(43);

// An injectable probe recording the config it was handed, so a test can assert
// both the emitted line and that the minimal config held no credential.
function makeDeps(presented: PresentedHostKey): ProbeHostKeyDeps & {
  lastConfig?: SFTPConnectionConfig;
} {
  const state: { lastConfig?: SFTPConnectionConfig } = {};
  return {
    probe: (config): Promise<PresentedHostKey> => {
      state.lastConfig = config;
      return Promise.resolve(presented);
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
    // Even a URL holding userinfo and a path yields host+port plus a fixed
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
    // The probe connection held no credential -- the verifier refuses before
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

  test("neither output form holds a rejected key type's bytes", async () => {
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

  test("both output forms hold a conforming key type verbatim", async () => {
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
    // The host is the one fragment here that can still hold a real marker: a
    // percent-encoded --sftp-url decodes back to literal spaces, so URL parsing
    // does not strip it (the charset bound covers the other fields). The log sink
    // redacts the whole rendered line ahead of the out-of-band verification step,
    // so the marker is redacted where it is interpolated. Asserted on the bytes
    // stderr wrote, not the returned string.
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

  // The exit-69 path's machine form. A caller that discards this command's stderr
  // -- the console's probe driver does, since stderr can hold server-controlled
  // bytes -- would otherwise see an unreachable host where the dial in fact
  // reached a peer that answered wrongly.
  test("the diagnosis line names a non-SSH answer, its shape, and the peer's own bytes", () => {
    expect(
      JSON.parse(
        probeDiagnosisJsonLine({
          kind: "non-ssh",
          shape: "tls-alert",
          excerpt: "\u0015\u0003\u0003",
        }),
      ),
    ).toEqual({
      diagnosis: "non_ssh",
      shape: "tls-alert",
      excerpt: "\u0015\u0003\u0003",
    });
  });

  test("the diagnosis line is one line: the peer's control bytes are JSON-escaped", () => {
    const line = probeDiagnosisJsonLine({
      kind: "non-ssh",
      shape: "http",
      excerpt: "HTTP/1.1 403\r\nX: y\n",
    });
    expect(line.includes("\n")).toBe(false);
    expect(line.includes("\r")).toBe(false);
  });

  test("a peer that closed having sent nothing has no excerpt at all", () => {
    expect(
      JSON.parse(probeDiagnosisJsonLine({ kind: "closed-unanswered" })),
    ).toEqual({ diagnosis: "closed_unanswered" });
  });

  test("the success line has no diagnosis key, so the two shapes cannot collide", async () => {
    const result = await probeHostKeyLines(
      {
        sftpUrl: "sftp://sftp.example.org",
        connectTimeoutSeconds: 10,
        json: true,
        verbosity: 0,
      },
      makeDeps({ fingerprint: FP, keyType: "ssh-ed25519" }),
    );
    expect(
      Object.keys(JSON.parse(result.stdout!) as Record<string, unknown>),
    ).toEqual(["fingerprint", "key_type"]);
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

// What the machine route puts ON A TERMINAL. A `--json` consumer's commonest
// reflex with a line it did not expect is to print it, so what these assert is
// the emitted LINE's own bytes rather than only that it parses back. The bytes
// are built by code point so this file stays readable ASCII.
describe("the --json lines are safe to print as they stand", () => {
  const byte = (code: number): string => String.fromCharCode(code);
  /** DEL and a C1 control: the ranges a JSON encoding leaves raw, both
   * reachable, since the peer's answer is decoded latin1 byte for byte. */
  const DEL = byte(0x7f);
  const C1_CSI = byte(0x9b);
  const PRINTABLE_ASCII_ONLY = /^[\x20-\x7e]*$/;

  const nonSshLine = (excerpt: string): string =>
    probeDiagnosisJsonLine({ kind: "non-ssh", shape: "unrecognized", excerpt });

  test("a peer answering with DEL and a C1 byte has both escaped", () => {
    const line = nonSshLine(`a${DEL}b${C1_CSI}c`);
    expect(line).toContain("\\u007f");
    expect(line).toContain("\\u009b");
    expect(line.includes(DEL)).toBe(false);
    expect(line.includes(C1_CSI)).toBe(false);
  });

  test("every byte a latin1-decoded answer can hold leaves the line printable ASCII", () => {
    const everyByte = Array.from({ length: 256 }, (_, code) => byte(code)).join(
      "",
    );
    expect(PRINTABLE_ASCII_ONLY.test(nonSshLine(everyByte))).toBe(true);
  });

  test("the success line escapes the server's key type the same way", async () => {
    const result = await probeHostKeyLines(
      {
        sftpUrl: "sftp://sftp.example.org",
        connectTimeoutSeconds: 10,
        json: true,
        verbosity: 0,
      },
      makeDeps({ fingerprint: FP, keyType: `ssh-ed25519${DEL}${C1_CSI}` }),
    );
    expect(PRINTABLE_ASCII_ONLY.test(result.stdout ?? "")).toBe(true);
    expect(result.stdout).toContain("\\u007f");
  });

  test("the line keeps its keys and its value types", () => {
    const parsed = JSON.parse(nonSshLine(`a${DEL}`)) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["diagnosis", "shape", "excerpt"]);
    expect(typeof parsed["excerpt"]).toBe("string");
    expect(
      Object.keys(
        JSON.parse(
          probeDiagnosisJsonLine({ kind: "closed-unanswered" }),
        ) as Record<string, unknown>,
      ),
    ).toEqual(["diagnosis"]);
  });

  // The escapes are the JSON encoding's own, so a consumer parses back the
  // peer's bytes unchanged and escapes them ONCE at its own display sink. Held
  // as a check because the console's re-validation sits downstream: escaping
  // rather than encoding here would arrive there as text its own pass escapes a
  // second time.
  test("the parsed excerpt is the peer's own bytes, so a consumer escapes once", () => {
    const excerpt = `a${DEL}b${C1_CSI}c`;
    const parsed = JSON.parse(nonSshLine(excerpt)) as { excerpt: string };
    expect(parsed.excerpt).toBe(excerpt);
    expect(sanitizeForDisplay(parsed.excerpt)).toBe("a\\x7fb\\x9bc");
  });
});

// A peer that answers the port with PEM-shaped bytes reaches both routes with
// its private-key material already stripped: the strip runs where the excerpt
// is produced, ahead of the bound that clips it (driven in
// test/unit/connection/sftpPeerIdentification.test.ts, and from the wire through to this
// line in test/integration/backendAgnostic/hostKeyProbePeerIdentification.test.ts).
// This checks that neither route treats those bytes a second time.
describe("both routes hold the producer's excerpt as it stands", () => {
  const PRODUCED_EXCERPT = "HTTP/1.0 200 OK\r\n\r\n[redacted private key]";

  test("the machine route emits it byte for byte", () => {
    const parsed = JSON.parse(
      probeDiagnosisJsonLine({
        kind: "non-ssh",
        shape: "http",
        excerpt: PRODUCED_EXCERPT,
      }),
    ) as { excerpt: string };
    expect(parsed.excerpt).toBe(PRODUCED_EXCERPT);
  });

  test("the human route holds the same bytes, escaped once at its sink", () => {
    const rendered = sanitizeErrorForDisplay(
      explainPeerIdentificationFailure(
        new Error("Connection lost before handshake"),
        { kind: "non-ssh", shape: "http", excerpt: PRODUCED_EXCERPT },
        { host: "sftp.example.org", port: 22 },
      ),
    );
    expect(rendered).toContain(
      `first bytes the peer sent; PEM private-key blocks replaced: ${sanitizeForDisplay(PRODUCED_EXCERPT)}`,
    );
  });
});
