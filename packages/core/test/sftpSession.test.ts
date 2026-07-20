import { expect, test } from "vitest";

import { SftpSession } from "../src/connection/sftpSession";
import type { FileTransportClient } from "../src/connection/fileSyncConnection";
import type { SFTPConnectionConfig } from "../src/config/connection";
import { DEFAULT_SERVER_CONNECT_TIMEOUT_MS } from "../src/config/connection";
import type { getLoggerForVerbosity } from "../src/utils/logger";

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
