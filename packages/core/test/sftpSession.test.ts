import { expect, test } from "vitest";

import { SftpSession } from "../src/connection/sftpSession";
import type { FileTransportClient } from "../src/connection/fileSyncConnection";
import type { SFTPConnectionConfig } from "../src/config/connection";
import { DEFAULT_SERVER_CONNECT_TIMEOUT_MS } from "../src/config/connection";
import type { getLoggerForVerbosity } from "../src/utils/logger";
import { computeHostKeyFingerprint } from "../src/utils/sshHostKey";
import { sanitizeErrorForDisplay } from "../src/utils/sanitizeErrorForDisplay";
import { DISPLAY_TRUNCATION_MARKER } from "../src/utils/sanitizeForDisplay";

// The connect-option tests never dial, and construction only needs a
// FileTransportClient reference, so an inert stub suffices. The whole-class
// verifier and probe behavior (which does drive a transport) is covered in
// fileSyncConnection.test.ts; these tests exercise only the subsystem's own
// connect-option contract, which the class-level tests reach indirectly.
const inertClient: FileTransportClient = {
  connect: async () => {},
  end: async () => {},
  list: async () => [],
  get: async () => Buffer.alloc(0) as Buffer<ArrayBufferLike>,
  put: async () => undefined,
  delete: async () => {},
  safeDelete: async () => {},
  rename: async () => {},
  createExclusive: async () => {},
  exists: async () => false,
};

// Build an SftpSession over a stub deps object, collecting the warnings its
// option-building emits (warn is the only log level the moved code uses).
function makeSession(): { session: SftpSession; warnings: string[] } {
  const warnings: string[] = [];
  const log = {
    warn: (msg: string) => warnings.push(msg),
    debug: () => {},
    info: () => {},
    trace: () => {},
    error: () => {},
  } as unknown as ReturnType<typeof getLoggerForVerbosity>;
  const session = new SftpSession({
    log: () => log,
    role: () => "tester",
    rawClient: inertClient,
  });
  return { session, warnings };
}

test("buildConnectOptions keeps an allowlisted providerOptions key and drops a non-allowlisted one with a warning", () => {
  const { session, warnings } = makeSession();
  const config: SFTPConnectionConfig = {
    channel: "sftp",
    server: { host: "sftp.example.org" },
    // keepaliveInterval is on the transport-tuning allowlist; sock is a
    // connection-redirect vector the default-deny allowlist must drop.
    providerOptions: { keepaliveInterval: 5000, sock: "redirect" },
  };
  const opts = session.buildConnectOptions(config, {
    includeCredentials: true,
  });
  expect(opts["keepaliveInterval"]).toBe(5000);
  expect(opts["sock"]).toBeUndefined();
  expect(warnings.some((w) => w.includes("providerOptions.sock"))).toBe(true);
});

test("buildConnectOptions filters algorithms to the tunable sub-keys and drops serverHostKey", () => {
  const { session, warnings } = makeSession();
  const config: SFTPConnectionConfig = {
    channel: "sftp",
    server: { host: "sftp.example.org" },
    providerOptions: {
      algorithms: {
        cipher: ["aes256-gcm@openssh.com"],
        hmac: ["hmac-sha2-256"],
        kex: ["curve25519-sha256"],
        compress: ["none"],
        // serverHostKey constrains host-key-type negotiation, so it must be
        // dropped even though the `algorithms` object itself is allowlisted.
        serverHostKey: ["ssh-rsa"],
      },
    },
  };
  const opts = session.buildConnectOptions(config, {
    includeCredentials: true,
  });
  const algorithms = opts["algorithms"] as Record<string, unknown>;
  expect(algorithms).toBeDefined();
  expect(Object.keys(algorithms).sort()).toEqual([
    "cipher",
    "compress",
    "hmac",
    "kex",
  ]);
  expect(algorithms["serverHostKey"]).toBeUndefined();
  expect(warnings.some((w) => w.includes("algorithms.serverHostKey"))).toBe(
    true,
  );
});

test("buildConnectOptions omits credentials when includeCredentials is false and includes them when true", () => {
  const { session } = makeSession();
  const config: SFTPConnectionConfig = {
    channel: "sftp",
    server: {
      host: "sftp.example.org",
      username: "roberts",
      password: "secret",
      privateKey: "PRIVATE",
      privateKeyPassphrase: "PASS",
      keyboardInteractive: true,
    },
  };

  const withoutCreds = session.buildConnectOptions(config, {
    includeCredentials: false,
  });
  // The non-secret fields the probe still needs stay present.
  expect(withoutCreds["host"]).toBe("sftp.example.org");
  expect(withoutCreds["username"]).toBe("roberts");
  // No credential -- and no keyboard-interactive opt-in -- rides the probe.
  expect(withoutCreds["password"]).toBeUndefined();
  expect(withoutCreds["privateKey"]).toBeUndefined();
  expect(withoutCreds["passphrase"]).toBeUndefined();
  expect(withoutCreds["tryKeyboard"]).toBeUndefined();

  const withCreds = session.buildConnectOptions(config, {
    includeCredentials: true,
  });
  expect(withCreds["password"]).toBe("secret");
  expect(withCreds["privateKey"]).toBe("PRIVATE");
  expect(withCreds["passphrase"]).toBe("PASS");
  expect(withCreds["tryKeyboard"]).toBe(true);
});

// A raw OpenSSH host-key blob: a uint32 length prefix, the key-type string, and
// the key bytes. The type is decoded verbatim out of the blob the server sent,
// so it is server-controlled text sitting ahead of everything the mismatch
// message tells the operator.
function hostKeyBlob(keyType: string): Buffer<ArrayBuffer> {
  const type = Buffer.from(keyType, "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(type.length, 0);
  return Buffer.concat([header, type, Buffer.alloc(32, 7)]);
}

// Drive the installed verifier against a presented key and render the failure
// the connect path composes from it, exactly as fileSyncConnection does.
async function renderMismatch(keyType: string): Promise<string> {
  const { session } = makeSession();
  const config: SFTPConnectionConfig = {
    channel: "sftp",
    server: {
      host: "sftp.example.org",
      hostKeyFingerprint: `SHA256:${"A".repeat(43)}`,
    },
  };
  const connectOptions: Record<string, unknown> = {};
  const verifier = session.installEnforcingVerifier(connectOptions, config);
  const hostVerifier = connectOptions["hostVerifier"] as (
    blob: Buffer,
    verify: (permitted: boolean) => void,
  ) => void;
  await new Promise<void>((resolve) => {
    hostVerifier(hostKeyBlob(keyType), () => resolve());
  });
  return sanitizeErrorForDisplay(
    new Error(
      `SFTP host-key verification failed: ${verifier.mismatchDetails()}`,
    ),
  );
}

// The key type is quoted into the message ahead of the presented fingerprint
// and the pinned set, and a server chooses it: keyTypeFromBlob decodes it
// verbatim out of the blob under no allowlist. The display boundary's
// private-key redaction is fail-closed past a truncated key, so without
// redaction where the type is composed, a server naming its key type with a PEM
// header deletes the comparison the operator makes by hand.
//
// This message also runs past the per-link display cap, which is a separate
// bound. How much it cuts depends on the key type's LENGTH, which the server
// also chooses without bound, so the benign rendering is measured alongside the
// planted one at each length: the assertions pin what redaction restores rather
// than what the cap removes, and the cap's own reach is pinned separately below.
test("a private-key-shaped host key type does not suppress the mismatch detail", async () => {
  const marker = "-----BEGIN RSA PRIVATE KEY-----";
  const presented = await computeHostKeyFingerprint(hostKeyBlob(marker));
  const rendered = await renderMismatch(marker);
  const benign = await renderMismatch("ssh-ed25519");

  expect(rendered).toContain("[redacted private key]");
  // What a benign key type shows, and what the operator compares by hand.
  expect(rendered).toContain(`with fingerprint ${presented}`);
  expect(rendered).toContain("which does not match the pinned fingerprint");
  // The cap, not the planted marker, is what ends this link: the benign
  // rendering ends the same way, so the tail beyond it is not this item's loss.
  expect(benign).toContain(DISPLAY_TRUNCATION_MARKER);
  expect(rendered).toContain(DISPLAY_TRUNCATION_MARKER);
  expect(benign).not.toContain("or an active attack");
});

// The key type leads the message and the server chooses its LENGTH as freely as
// its bytes -- keyTypeFromBlob bounds neither -- so a long enough type pushes the
// fingerprint and the pinned-set comparison past the per-link cap on its own.
// Pinned here rather than stated above it, because it is the bound that decides
// how much of this message an operator ever sees: redaction restores the
// comparison only while the type is short enough for it to fit at all. A benign
// type of the same length is measured alongside, so a regression that made
// redaction the suppressor would separate the two.
test("a long host key type pushes the comparison past the cap, redacted or not", async () => {
  const long = "X".repeat(200);
  const planted = await renderMismatch(
    `${long}-----BEGIN RSA PRIVATE KEY-----`,
  );
  const benign = await renderMismatch(long);

  for (const rendered of [planted, benign]) {
    expect(rendered).not.toContain(
      "which does not match the pinned fingerprint",
    );
    expect(rendered).toContain(DISPLAY_TRUNCATION_MARKER);
  }
});

test("a host key type carrying a sliced key does not suppress the mismatch detail", async () => {
  // A key type is length-prefixed bytes, not a token: it can carry line breaks,
  // and a whole key sliced into it is the shape the redaction exists for. Both
  // the marker and every line of armor behind it go, and the comparison stays.
  const rendered = await renderMismatch(
    "-----BEGIN RSA PRIVATE KEY-----\nc2gtcnNhAAAAAwEAAQ==\nQ1n3QqzB2rN0m8oL7v",
  );
  expect(rendered).toContain("[redacted private key]");
  expect(rendered).not.toContain("c2gtcnNhAAAAAwEAAQ");
  expect(rendered).not.toContain("Q1n3QqzB2rN0m8oL7v");
  expect(rendered).toContain("which does not match the pinned fingerprint");
});

// The separator forms a sliced key can arrive in. A key that reached an error
// through a folded YAML scalar carries spaces where its line breaks were, and
// one carried in a single-line JSON scalar may carry no separator at all -- so
// the redaction cannot key on line structure and stay closed.
test("a sliced key in the host key type is redacted whatever joins its armor", async () => {
  const body = [
    "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtz",
    "Wq1n3QqzB2rN0m8oL7vC5xY6aJ4kD1gH2sF3dP9uT8iR6eW0yA==",
  ];
  for (const separator of ["\n", "\r\n", " ", "\t", ""]) {
    const rendered = await renderMismatch(
      `-----BEGIN OPENSSH PRIVATE KEY-----${separator}${body.join(separator)}`,
    );
    expect(rendered).toContain("[redacted private key]");
    for (const line of body) {
      expect(rendered).not.toContain(line.slice(0, 24));
      expect(rendered).not.toContain(line.slice(-24));
    }
  }
});

test("buildConnectOptions always sets readyTimeout: the default when unset, the configured value otherwise", () => {
  const { session } = makeSession();

  const defaulted = session.buildConnectOptions(
    { channel: "sftp", server: { host: "sftp.example.org" } },
    { includeCredentials: true },
  );
  expect(defaulted["readyTimeout"]).toBe(DEFAULT_SERVER_CONNECT_TIMEOUT_MS);

  const configured = session.buildConnectOptions(
    {
      channel: "sftp",
      server: { host: "sftp.example.org" },
      options: { serverConnectTimeoutMs: 12345 },
    },
    { includeCredentials: true },
  );
  expect(configured["readyTimeout"]).toBe(12345);
});
