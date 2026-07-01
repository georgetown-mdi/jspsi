import { expect, test, vi } from "vitest";

import {
  FileSyncConnection,
  normalizeFiledropPath,
  serializeFileSyncMessage,
  MESSAGE_TYPE_OBJECT,
  MESSAGE_TYPE_BINARY,
  MESSAGE_HEADER_BYTES,
  TERMINAL_FRAME_DRAIN_TIMEOUT_MS,
} from "../src/connection/fileSyncConnection";
import {
  ADVERTISE_HELLO_RETRY_ATTEMPTS,
  cancellableDelay,
} from "../src/connection/fileSyncConstants";
import type {
  FileTransportClient,
  FileInfo,
} from "../src/connection/fileSyncConnection";
import type {
  SFTPConnectionConfig,
  FileDropConnectionConfig,
} from "../src/config/connection";
import {
  UsageError,
  BilateralModeMismatchError,
  ConnectionClosedError,
  FrameSizeExceededError,
  TransportOperationStalledError,
} from "../src/errors";
import { MAX_FRAME_SIZE_BYTES } from "../src/connection/frameSize";
import { computeHostKeyFingerprint } from "../src/utils/sshHostKey";
import {
  fromEventConnection,
  ConnectionError,
} from "../src/connection/messageConnection";
import { withCapturedLogs } from "../src/testing";
import logLibrary from "loglevel";

// Reduce a put() src to the on-disk bytes a real transport writes, so every mock
// transport in this file agrees on the framing. send() now hands put() a
// [header, payload] chunk list instead of one pre-concatenated Buffer (the
// peak-shaving change), so a mock store must JOIN the chunks; a lone Buffer and a
// drained stream are unchanged. A string src is a local file PATH to a real
// transport (ssh2-sftp-client copies from it; LocalFSClient rejects it), never an
// in-memory body, so it throws here too -- every mock then rejects a string as the
// real transports do, rather than silently dropping it and masking a regression
// that passed one.
async function putSrcBytes(
  src: string | Buffer | Uint8Array[] | NodeJS.ReadableStream,
): Promise<Buffer> {
  if (typeof src === "string")
    throw new Error("put expects a Buffer or chunk-list body, not a string");
  if (Buffer.isBuffer(src)) return src;
  if (Array.isArray(src)) return Buffer.concat(src);
  const chunks: Buffer[] = [];
  for await (const chunk of src)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

// Minimal in-memory FileTransportClient mock.  Only the methods called by
// send() need real implementations; everything else is a no-op.
function makeMockClient(): {
  client: FileTransportClient;
  files: Map<string, Buffer>;
} {
  const files = new Map<string, Buffer>();

  const client: FileTransportClient = {
    connect: async () => {},
    end: async () => {},
    // Reflect the in-memory store so send()/poll(), which now detect files via
    // list() pattern scans, see the same state exists()/get() do. Returns
    // direct children of `dir`, with `size` taken from the buffer length.
    list: async (dir: string): Promise<FileInfo[]> => {
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      return [...files.entries()]
        .filter(
          ([p]) =>
            p.startsWith(prefix) && !p.slice(prefix.length).includes("/"),
        )
        .map(([p, buf]) => ({
          name: p.slice(prefix.length),
          modifyTime: 0,
          size: buf.length,
        }));
    },
    get: async (path: string) => {
      const data = files.get(path);
      if (!data) throw new Error(`${path}: not found`);
      return data as Buffer<ArrayBufferLike>;
    },
    put: async (src, dest) => {
      files.set(dest, await putSrcBytes(src));
    },
    delete: async (path: string) => {
      files.delete(path);
    },
    safeDelete: async (path: string) => {
      files.delete(path);
    },
    rename: async (from: string, to: string) => {
      const data = files.get(from);
      if (data === undefined) throw new Error(`${from}: no such file`);
      files.delete(from);
      files.set(to, data);
    },
    createExclusive: async (path: string) => {
      if (files.has(path))
        throw Object.assign(new Error(`${path}: file already exists`), {
          code: "EEXIST",
        });
      files.set(path, Buffer.alloc(0));
    },
    exists: async (path: string) => files.has(path),
  };

  return { client, files };
}

// Put a connection into the post-open state without running the handshake.
// Calls open() with a fake filedrop config so this.config is populated and
// the drain deadline in close() reads peerTimeoutMs from the config rather
// than falling back to DEFAULT_PEER_TIMEOUT_MS (1 hour).
async function makeConnectedConn(
  client: FileTransportClient,
  opts?: Partial<{
    pollingFrequency: number;
    timeToLiveMs: number;
    peerTimeoutMs: number;
    joinerRecoveryMs: number;
  }>,
): Promise<FileSyncConnection> {
  const conn = new FileSyncConnection(client, {
    pollingFrequency: opts?.pollingFrequency ?? 10,
    timeToLive: new Date(Date.now() + (opts?.timeToLiveMs ?? 5_000)),
    verbose: -1,
    ...(opts?.joinerRecoveryMs !== undefined
      ? { joinerRecoveryMs: opts.joinerRecoveryMs }
      : {}),
  });
  // Pass peerTimeoutMs via a fake filedrop config so close()'s drain deadline
  // reads from this.config rather than falling back to DEFAULT_PEER_TIMEOUT_MS.
  const fakeConfig: FileDropConnectionConfig = {
    channel: "filedrop",
    path: "/test",
    options: { peerTimeoutMs: opts?.peerTimeoutMs ?? 50 },
  };
  await conn.open(fakeConfig);
  return conn;
}

// Build a peer message file's on-disk bytes in the binary envelope the transport
// now reads (version || type || seq || payload). `objectMessage` carries a JSON
// control payload (the common case in these tests); `binaryMessage` carries a
// raw binary frame. `seq` is the per-session counter the filename NNN and the
// retain-mode body/filename cross-check key on.
function objectMessage(payload: unknown, seq = 0): Buffer {
  return serializeFileSyncMessage(
    MESSAGE_TYPE_OBJECT,
    seq,
    Buffer.from(JSON.stringify(payload)),
  );
}
function binaryMessage(payload: Uint8Array, seq = 0): Buffer {
  return serializeFileSyncMessage(MESSAGE_TYPE_BINARY, seq, payload);
}

// A valid hello body advertising the default lock/non-retain flags. Tests whose
// rendezvous reader runs in the default (lock) mode hand-plant this as the peer
// hello so it passes the HelloEnvelope read gate without a spurious bilateral
// mismatch. 193901017 made the hello body carry these two required flags, so a
// bare `{}` no longer satisfies the hello schema.
const LOCK_HELLO_BODY = Buffer.from(
  JSON.stringify({ locklessRendezvous: false, retainFiles: false }),
);

// --- connection lifecycle (unconnected) --------------------------------------

test("stop and cleanup are safe on a connection that was never opened", async () => {
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, { verbose: -1 });
  expect(() => conn.stop()).not.toThrow();
  await expect(conn.cleanup()).resolves.not.toThrow();
});

test("close is idempotent and safe on a connection that was never opened", async () => {
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, { verbose: -1 });
  await expect(conn.close()).resolves.toBeUndefined();
  await expect(conn.close()).resolves.toBeUndefined();
});

test("close() sweeps responsible files and ends the client, idempotently", async () => {
  const { client, files } = makeMockClient();
  let ended = false;
  client.end = async () => {
    ended = true;
  };
  const deleted: string[] = [];
  const origSafeDelete = client.safeDelete;
  client.safeDelete = async (p: string) => {
    deleted.push(p);
    return origSafeDelete(p);
  };
  const conn = await makeConnectedConn(client);
  conn.peerId = "stub-peer";
  // send() records the outbound file as one this side is responsible for.
  await conn.send({ hello: 1 });
  const messagePath = [...files.keys()].find((p) =>
    new RegExp(`^/test/${conn.id}-\\d+\\.json$`).test(p),
  );
  expect(messagePath).toBeDefined();

  await conn.close();

  expect(ended).toBe(true);
  expect(deleted).toContain(messagePath);
  expect(files.has(messagePath!)).toBe(false);

  // A second close neither throws nor re-ends the client.
  ended = false;
  await expect(conn.close()).resolves.toBeUndefined();
  expect(ended).toBe(false);
});

test("close() stops a running poller", async () => {
  const { client } = makeMockClient();
  let listCalls = 0;
  const origList = client.list;
  client.list = async (p: string) => {
    listCalls++;
    return origList(p);
  };
  const conn = await makeConnectedConn(client, { pollingFrequency: 5 });
  conn.peerId = "peer-test";
  conn.start();
  await new Promise((r) => setTimeout(r, 25));
  await conn.close();

  const callsAfterClose = listCalls;
  await new Promise((r) => setTimeout(r, 25));
  expect(listCalls).toBe(callsAfterClose);
});

// --- buffered error ----------------------------------------------------------

test("emit('error', ...) with no listener is buffered and returned by takeBufferedError", () => {
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, { verbose: -1 });
  const err = new Error("transport failure");
  conn.emit("error", err);
  expect(conn.takeBufferedError()).toBe(err);
  // Second read clears the buffer.
  expect(conn.takeBufferedError()).toBeUndefined();
});

test("emit('error', ...) with an attached listener is delivered and not buffered", () => {
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, { verbose: -1 });
  const observed: unknown[] = [];
  conn.on("error", (err) => observed.push(err));
  const err = new Error("transport failure");
  conn.emit("error", err);
  expect(observed).toEqual([err]);
  expect(conn.takeBufferedError()).toBeUndefined();
});

test("only the most recent buffered error is retained", async () => {
  const { client } = makeMockClient();
  // The second unhandled error supersedes the buffered first and emits a WARN
  // naming the superseded one; capture it (proving the supersede path fired) so
  // it does not leak to the suite output, mirroring the sibling escaping test.
  const [, logs] = await withCapturedLogs(async () => {
    const conn = new FileSyncConnection(client, { verbose: -1 });
    conn.emit("error", new Error("first"));
    conn.emit("error", new Error("second"));
    expect((conn.takeBufferedError() as Error).message).toBe("second");
  });
  expect(
    logs.some((l) => l.message.includes("superseding earlier buffered error")),
  ).toBe(true);
});

test("the superseding-buffered-error warn escapes control/ANSI bytes in the prior error", async () => {
  // The buffered error can be a raw transport error whose message embeds a
  // partner-controlled path (both adapters concatenate the operation path into
  // their error text), so the "superseding earlier buffered error" warn that
  // re-logs it must escape those bytes rather than echo them to the operator.
  const { client } = makeMockClient();
  const [, logs] = await withCapturedLogs(async () => {
    const conn = new FileSyncConnection(client, { verbose: -1 });
    // First unhandled error is buffered; the second triggers the warn naming it.
    conn.emit("error", new Error("transport failed on \x1b[31mEVIL"));
    conn.emit("error", new Error("a later, superseding failure"));
  });
  const warn = logs.find((l) =>
    l.message.includes("superseding earlier buffered error"),
  );
  expect(warn).toBeDefined();
  expect(warn!.message).not.toContain("\x1b");
  expect(warn!.message).toContain("\\x1b");
});

test("re-emitting the same buffered error does not create a self-referential cause cycle", async () => {
  // Regression guard: when an unhandled error is buffered and then the same
  // Error reference is emitted again, the cause-chain branch must NOT assign
  // `err.cause = err`. A self-cycle would loop any downstream walker.
  const { client } = makeMockClient();
  const err = new Error("repeated");
  // The re-emit still supersedes the buffered error and emits the WARN naming
  // it -- the cause-cycle guard only suppresses the cause mutation, not the log
  // -- so capture the WARN here too rather than let it leak.
  const [, logs] = await withCapturedLogs(async () => {
    const conn = new FileSyncConnection(client, { verbose: -1 });
    conn.emit("error", err);
    conn.emit("error", err);
    expect(conn.takeBufferedError()).toBe(err);
    expect(err.cause).toBeUndefined();
  });
  expect(
    logs.some((l) => l.message.includes("superseding earlier buffered error")),
  ).toBe(true);
});

// --- open (sftp) -------------------------------------------------------------

test("open connects and sets path from sftp config", async () => {
  // The mock client's connect() is a no-op, so the no-pin fail-closed
  // hostVerifier open() installs is never invoked and no host-key log is
  // emitted on this path; the fail-closed refusal itself is covered by the
  // host-key verification tests below (which drive the verifier).
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, { verbose: -1 });
  await conn.open({
    channel: "sftp",
    server: { host: "sftp.example.org", path: "/exchanges" },
  });
  expect(conn.connected).toBe(true);
  expect(conn.path).toBe("/exchanges");
});

test("open maps peerTimeoutMs to timeToLive for sftp config", async () => {
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, { verbose: -1 });
  const before = Date.now();
  await conn.open({
    channel: "sftp",
    server: { host: "sftp.example.org" },
    options: { peerTimeoutMs: 60_000 },
  });
  const after = Date.now();
  const ttl = conn.options.timeToLive!.getTime();
  expect(ttl).toBeGreaterThanOrEqual(before + 60_000);
  expect(ttl).toBeLessThanOrEqual(after + 60_000);
});

test("open maps pollIntervalMs to pollingFrequency for sftp config", async () => {
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, { verbose: -1 });
  await conn.open({
    channel: "sftp",
    server: { host: "sftp.example.org" },
    options: { pollIntervalMs: 15_000 },
  });
  expect(conn.options.pollingFrequency).toBe(15_000);
});

test("open preserves constructor timeToLive and stores config peerTimeoutMs when both are supplied", async () => {
  // Constructor timeToLive wins; open() must not recompute it from
  // config.options.peerTimeoutMs. The config is stored as a private field so
  // close() can read peerTimeoutMs from it for a fresh drain deadline.
  const { client } = makeMockClient();
  const constructorTtl = new Date(Date.now() + 9_999_999);
  const conn = new FileSyncConnection(client, {
    verbose: -1,
    timeToLive: constructorTtl,
  });
  await conn.open({
    channel: "sftp",
    server: { host: "sftp.example.org" },
    options: { peerTimeoutMs: 30_000 },
  });
  expect(conn.options.timeToLive).toBe(constructorTtl);
  expect(
    (
      conn as unknown as {
        config: SFTPConnectionConfig | FileDropConnectionConfig | undefined;
      }
    ).config?.options?.peerTimeoutMs,
  ).toBe(30_000);
});

test("open preserves constructor timeToLive and leaves peerTimeoutMs undefined when config has none", async () => {
  // Constructor timeToLive wins; when no config peerTimeoutMs is provided
  // the config's options.peerTimeoutMs stays undefined, so close() falls back
  // to DEFAULT_PEER_TIMEOUT_MS for the drain deadline.
  const { client } = makeMockClient();
  const constructorTtl = new Date(Date.now() + 9_999_999);
  const conn = new FileSyncConnection(client, {
    verbose: -1,
    timeToLive: constructorTtl,
  });
  await conn.open({
    channel: "sftp",
    server: { host: "sftp.example.org" },
  });
  expect(conn.options.timeToLive).toBe(constructorTtl);
  expect(
    (
      conn as unknown as {
        config: SFTPConnectionConfig | FileDropConnectionConfig | undefined;
      }
    ).config?.options?.peerTimeoutMs,
  ).toBeUndefined();
});

test("open derives timeToLive from config peerTimeoutMs when no constructor timeToLive is set", async () => {
  // Existing behavior: no constructor timeToLive, config peerTimeoutMs present
  // -> timeToLive is computed as Date.now() + peerTimeoutMs. The config is
  // stored as a private field so close() can read peerTimeoutMs from it.
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, { verbose: -1 });
  const before = Date.now();
  await conn.open({
    channel: "sftp",
    server: { host: "sftp.example.org" },
    options: { peerTimeoutMs: 45_000 },
  });
  const after = Date.now();
  const ttl = conn.options.timeToLive!.getTime();
  expect(ttl).toBeGreaterThanOrEqual(before + 45_000);
  expect(ttl).toBeLessThanOrEqual(after + 45_000);
  expect(
    (
      conn as unknown as {
        config: SFTPConnectionConfig | FileDropConnectionConfig | undefined;
      }
    ).config?.options?.peerTimeoutMs,
  ).toBe(45_000);
});

test("open (sftp): the connect debug log records only that a username is set, not its value", async () => {
  // The configured SFTP username is a credential component; the connect debug log
  // must record only that one is set, never the value. The line is this.log.debug,
  // so two things are needed to observe it: (1) raise the root level to "trace"
  // (getLoggerForVerbosity never makes a named logger more verbose than the root,
  // so the logger must be built while the root permits DEBUG), restored in
  // finally; and (2) construct the connection inside the withCapturedLogs callback
  // so its logger binds to the capture's method factory -- mirroring the
  // providerOptions warning tests below. Teeth: reverting to `as ${username}`
  // would surface "alice" on this line.
  const { client } = makeMockClient();
  const config: SFTPConnectionConfig = {
    channel: "sftp",
    server: { host: "sftp.example.org", username: "alice" },
  };
  const prevLevel = logLibrary.getLevel();
  logLibrary.setLevel("trace");
  try {
    const [, logs] = await withCapturedLogs(
      async () => {
        const conn = new FileSyncConnection(client, { verbose: 1 });
        await conn.open(config);
      },
      (level) => level === "DEBUG",
    );
    const debugLines = logs.map((l) => l.message).join("\n");
    // The connect line was captured (guards against a level-setup mistake that
    // would make the credential assertion vacuous), carries the presence marker,
    // and never the username value.
    expect(debugLines).toContain("connecting to sftp.example.org");
    expect(debugLines).toContain("as a configured user");
    expect(debugLines).not.toContain("alice");
  } finally {
    logLibrary.setLevel(prevLevel);
  }
});

test("open (sftp): the connect debug log escapes control bytes in the host and path", async () => {
  // The host and remote path are server-controlled and -- now that the CLI
  // decodes percent-encoded URL components -- can carry CR/LF or other control
  // bytes. At debug level an unescaped newline would let a hostile host or path
  // forge an extra log line on the operator's terminal or --log-file, so this
  // site routes both through sanitizeForDisplay. Same logger-capture setup as the
  // username test above: raise the root level to "trace" so the named logger is
  // built permitting DEBUG, and construct the connection inside the callback so it
  // binds to the capture's method factory. Teeth: dropping sanitizeForDisplay from
  // either value would surface the raw newline and split this into a forged line.
  const { client } = makeMockClient();
  const config: SFTPConnectionConfig = {
    channel: "sftp",
    server: {
      host: "evil.example.org\nFORGED: injected via host",
      path: "/exchanges\r\nFORGED: injected via path",
    },
  };
  const prevLevel = logLibrary.getLevel();
  logLibrary.setLevel("trace");
  try {
    const [, logs] = await withCapturedLogs(
      async () => {
        const conn = new FileSyncConnection(client, { verbose: 1 });
        await conn.open(config);
      },
      (level) => level === "DEBUG",
    );
    const connectLine = logs
      .map((l) => l.message)
      .find((m) => m.includes("connecting to"));
    // The connect line was captured (guards against a level-setup mistake that
    // would make the escaping assertions vacuous).
    expect(connectLine).toBeDefined();
    // Control bytes are shown as visible escapes, never emitted raw, so the single
    // debug line cannot be split into a forged second line.
    expect(connectLine).not.toContain("\n");
    expect(connectLine).not.toContain("\r");
    expect(connectLine).toContain("evil.example.org\\x0a");
    expect(connectLine).toContain("/exchanges\\x0d\\x0a");
  } finally {
    logLibrary.setLevel(prevLevel);
  }
});

test("open (filedrop): the connect debug log escapes control bytes in the path", async () => {
  // The filedrop directory is partner-reachable -- an offline-accept config seeds
  // it verbatim from the partner's charset-unconstrained invitation endpoint -- so
  // open()'s "opening local path" debug log must escape it. Same trace/capture
  // setup as the sftp connect-log test above. Teeth: dropping sanitizeForDisplay
  // from the dirPath interpolation would surface the raw CR/LF on this line.
  const { client } = makeMockClient();
  const config: FileDropConnectionConfig = {
    channel: "filedrop",
    path: "/drop\r\nFORGED: injected via filedrop path",
  };
  const prevLevel = logLibrary.getLevel();
  logLibrary.setLevel("trace");
  try {
    const [, logs] = await withCapturedLogs(
      async () => {
        const conn = new FileSyncConnection(client, { verbose: 1 });
        await conn.open(config);
      },
      (level) => level === "DEBUG",
    );
    const openLine = logs
      .map((l) => l.message)
      .find((m) => m.includes("opening local path"));
    expect(openLine).toBeDefined();
    expect(openLine).not.toContain("\n");
    expect(openLine).not.toContain("\r");
    expect(openLine).toContain("/drop\\x0d\\x0a");
  } finally {
    logLibrary.setLevel(prevLevel);
  }
});

test("synchronize: the 'synchronizing at path' info log escapes control bytes in the path", async () => {
  // synchronize() logs the rendezvous path at INFO (default verbosity) before any
  // transport I/O, so an unescaped control byte forges an operator log line at
  // normal verbosity, not just under -v -- a higher-exposure sink than the debug
  // connect log. The line is emitted synchronously at the top of synchronize();
  // the short peerTimeoutMs then bounds the rendezvous wait so the call rejects
  // (no peer ever appears) rather than hanging the test. Teeth: dropping the
  // escaping would surface the raw CR/LF in this line.
  const { client } = makeMockClient();
  const config: SFTPConnectionConfig = {
    channel: "sftp",
    server: {
      host: "sftp.example.org",
      path: "/drop\r\nFORGED: injected via path",
    },
    options: { peerTimeoutMs: 100, pollIntervalMs: 10 },
  };
  const prevLevel = logLibrary.getLevel();
  logLibrary.setLevel("trace");
  try {
    const [, logs] = await withCapturedLogs(
      async () => {
        const conn = new FileSyncConnection(client, { verbose: 1 });
        await conn.open(config);
        await conn.synchronize().catch(() => {});
      },
      (level) => level === "INFO",
    );
    const syncLine = logs
      .map((l) => l.message)
      .find((m) => m.includes("synchronizing at path"));
    expect(syncLine).toBeDefined();
    expect(syncLine).not.toContain("\n");
    expect(syncLine).not.toContain("\r");
    expect(syncLine).toContain("/drop\\x0d\\x0a");
  } finally {
    logLibrary.setLevel(prevLevel);
  }
});

// --- open (sftp providerOptions hardening) -----------------------------------

// Capture the options object an sftp open() passes to client.connect, so the
// allowlist tests can assert exactly what reaches ssh2-sftp-client. The mock's
// connect is a no-op; here it records its single argument instead.
//
// The connection is constructed inside withCapturedLogs so its logger binds to
// the interceptor: open() emits a WARN for each dropped providerOptions key, and
// capturing them here keeps the allowlist option-assertion tests below from
// leaking that noise to the suite output. The "a dropped providerOptions key /
// algorithms sub-key is logged" tests wrap this helper in their own capture to
// assert those WARNs -- the shared interceptor delivers each WARN to that outer
// capture too, so suppressing here does not hide them from the tests that prove
// they fire.
async function captureSftpConnectOptions(
  config: SFTPConnectionConfig,
): Promise<Record<string, unknown>> {
  const { client } = makeMockClient();
  let captured: Record<string, unknown> | undefined;
  client.connect = async (options: Record<string, unknown>) => {
    captured = options;
  };
  await withCapturedLogs(async () => {
    const conn = new FileSyncConnection(client, { verbose: -1 });
    await conn.open(config);
  });
  if (captured === undefined) throw new Error("client.connect was not called");
  return captured;
}

test("providerOptions cannot override the host", async () => {
  const opts = await captureSftpConnectOptions({
    channel: "sftp",
    server: { host: "sftp.example.org" },
    providerOptions: { host: "attacker.example.org" },
  });
  expect(opts["host"]).toBe("sftp.example.org");
});

test("providerOptions cannot override a password credential", async () => {
  const opts = await captureSftpConnectOptions({
    channel: "sftp",
    server: { host: "sftp.example.org", password: "real-password" },
    providerOptions: { password: "attacker-password" },
  });
  expect(opts["password"]).toBe("real-password");
});

test("providerOptions cannot inject a credential the config did not set", async () => {
  // Config authenticates by private key; a providerOptions password must not be
  // smuggled in as a second credential.
  const opts = await captureSftpConnectOptions({
    channel: "sftp",
    server: { host: "sftp.example.org", privateKey: "real-key" },
    providerOptions: {
      password: "attacker-password",
      privateKey: "attacker-key",
    },
  });
  expect(opts["privateKey"]).toBe("real-key");
  expect(opts["password"]).toBeUndefined();
});

test("providerOptions cannot override the private key passphrase", async () => {
  const opts = await captureSftpConnectOptions({
    channel: "sftp",
    server: {
      host: "sftp.example.org",
      privateKey: "real-key",
      privateKeyPassphrase: "real-passphrase",
    },
    providerOptions: { passphrase: "attacker-passphrase" },
  });
  expect(opts["passphrase"]).toBe("real-passphrase");
});

test("providerOptions cannot disable host-key verification", async () => {
  // hostVerifier/hostHash are the ssh2 host-key-verification settings; a map that
  // tries to install an always-accept verifier must be dropped. With no pin, core
  // installs its OWN fail-closed verifier (the no-pin default is fail-closed), so
  // the captured hostVerifier is core's, not the injected one -- invoking it
  // refuses (verify(false)), proving the injected `() => true` was dropped rather
  // than honored. hostHash is dropped outright.
  const opts = await captureSftpConnectOptions({
    channel: "sftp",
    server: { host: "sftp.example.org" }, // no pin -> fail-closed verifier
    providerOptions: { hostVerifier: () => true, hostHash: "md5" },
  });
  expect(opts["hostHash"]).toBeUndefined();
  expect(typeof opts["hostVerifier"]).toBe("function");
  const verifier = opts["hostVerifier"] as (
    keyBlob: Buffer,
    verify: (permitted: boolean) => void,
  ) => void;
  const permitted = await new Promise<boolean>((resolve) => {
    // A minimal well-formed blob (length-prefixed "test" key type); the
    // fail-closed verifier refuses it regardless of content.
    verifier(Buffer.from([0, 0, 0, 4, 116, 101, 115, 116]), resolve);
  });
  expect(permitted).toBe(false);
});

// --- host-key verification (enforce / fail-closed / probe) -------------------

// A raw OpenSSH ssh-ed25519 host-key blob: uint32 len + "ssh-ed25519" + uint32
// len + 32 key bytes. keyTypeFromBlob reads "ssh-ed25519"; computeHostKeyFingerprint
// hashes the whole blob.
function ed25519Blob(fill = 7): Buffer {
  const type = Buffer.from("ssh-ed25519");
  const key = Buffer.alloc(32, fill);
  const buf = Buffer.alloc(4 + type.length + 4 + key.length);
  buf.writeUInt32BE(type.length, 0);
  type.copy(buf, 4);
  buf.writeUInt32BE(key.length, 4 + type.length);
  key.copy(buf, 4 + type.length + 4);
  return buf;
}

// A mock client whose connect() drives the configured hostVerifier with
// `keyBlob` (as ssh2 would), then resolves if the verifier permitted the key or
// rejects with ssh2's host-denied message if it refused -- so open()/probe see a
// realistic connect outcome.
function makeHostKeyMockClient(keyBlob: Buffer): FileTransportClient {
  const { client } = makeMockClient();
  client.connect = (options: Record<string, unknown>) => {
    const verifier = options["hostVerifier"] as
      | ((blob: Buffer, verify: (permitted: boolean) => void) => void)
      | undefined;
    return new Promise<void>((resolve, reject) => {
      if (verifier === undefined) {
        resolve();
        return;
      }
      verifier(keyBlob, (permitted: boolean) => {
        if (permitted) resolve();
        else reject(new Error("Host denied (verification failed)"));
      });
    });
  };
  return client;
}

test("open (sftp) with a matching pin verifies and connects", async () => {
  const blob = ed25519Blob();
  const pin = await computeHostKeyFingerprint(new Uint8Array(blob));
  const conn = new FileSyncConnection(makeHostKeyMockClient(blob), {
    verbose: -1,
  });
  await conn.open({
    channel: "sftp",
    server: { host: "sftp.example.org", hostKeyFingerprint: pin },
  });
  expect(conn.connected).toBe(true);
});

test("open (sftp) with a matching pin records the observed host key", async () => {
  // The observed key is captured on the only success path (pin matched) so the
  // orchestrator can advertise it for cross-party reconciliation (201058119).
  const blob = ed25519Blob();
  const pin = await computeHostKeyFingerprint(new Uint8Array(blob));
  const conn = new FileSyncConnection(makeHostKeyMockClient(blob), {
    verbose: -1,
  });
  await conn.open({
    channel: "sftp",
    server: { host: "sftp.example.org", hostKeyFingerprint: pin },
  });
  expect(conn.observedHostKey).toEqual({
    fingerprint: pin,
    keyType: "ssh-ed25519",
  });
});

test("open (sftp) with no pin records no observed host key", async () => {
  // A refused connection (no-pin fail-closed) never establishes a session, so
  // there is nothing to advertise -- the field stays undefined.
  const conn = new FileSyncConnection(makeHostKeyMockClient(ed25519Blob()), {
    verbose: -1,
  });
  await expect(
    conn.open({ channel: "sftp", server: { host: "sftp.example.org" } }),
  ).rejects.toThrow(/no host_key_fingerprint is pinned/);
  expect(conn.observedHostKey).toBeUndefined();
});

test("open (filedrop) records no observed host key", async () => {
  // A file-drop makes no SSH connection, so it observes no host key.
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, { verbose: -1 });
  await conn.open({ channel: "filedrop", path: "/mnt/share/drop" });
  expect(conn.observedHostKey).toBeUndefined();
});

test("open (sftp) with a mismatched pin fails closed and names the re-pin recovery", async () => {
  // Pin the fingerprint of a DIFFERENT key, so the presented blob mismatches.
  const other = ed25519Blob(1);
  const pin = await computeHostKeyFingerprint(new Uint8Array(other));
  const conn = new FileSyncConnection(makeHostKeyMockClient(ed25519Blob(2)), {
    verbose: -1,
  });
  await expect(
    conn.open({
      channel: "sftp",
      server: { host: "sftp.example.org", hostKeyFingerprint: pin },
    }),
  ).rejects.toThrow(/SFTP host-key verification failed/);
  await expect(
    conn.open({
      channel: "sftp",
      server: { host: "sftp.example.org", hostKeyFingerprint: pin },
    }),
    // The re-pin recovery: verify out-of-band, then set the new value or clear
    // the field and re-establish trust; a changed key is never auto-accepted.
  ).rejects.toThrow(/A changed key is never auto-accepted/);
  expect(conn.connected).toBe(false);
});

test("open (sftp) with a list of pins connects when the key matches the FIRST pin", async () => {
  const blob = ed25519Blob(7);
  const matching = await computeHostKeyFingerprint(new Uint8Array(blob));
  const other = await computeHostKeyFingerprint(new Uint8Array(ed25519Blob(1)));
  const conn = new FileSyncConnection(makeHostKeyMockClient(blob), {
    verbose: -1,
  });
  await conn.open({
    channel: "sftp",
    server: {
      host: "sftp.example.org",
      hostKeyFingerprint: [matching, other],
    },
  });
  expect(conn.connected).toBe(true);
  // The observed key records exactly the pin the server's key satisfied.
  expect(conn.observedHostKey).toEqual({
    fingerprint: matching,
    keyType: "ssh-ed25519",
  });
});

test("open (sftp) with a list of pins connects when the key matches a LATER pin (rotation staging)", async () => {
  // The presented key is staged as the second pin during a rekey window; the
  // connection accepts it and records that pin as the observed key.
  const blob = ed25519Blob(2);
  const matching = await computeHostKeyFingerprint(new Uint8Array(blob));
  const other = await computeHostKeyFingerprint(new Uint8Array(ed25519Blob(1)));
  const conn = new FileSyncConnection(makeHostKeyMockClient(blob), {
    verbose: -1,
  });
  await conn.open({
    channel: "sftp",
    server: {
      host: "sftp.example.org",
      hostKeyFingerprint: [other, matching],
    },
  });
  expect(conn.connected).toBe(true);
  expect(conn.observedHostKey).toEqual({
    fingerprint: matching,
    keyType: "ssh-ed25519",
  });
});

test("open (sftp) with a list of pins fails closed when the key matches NONE and names the set", async () => {
  const a = await computeHostKeyFingerprint(new Uint8Array(ed25519Blob(1)));
  const b = await computeHostKeyFingerprint(new Uint8Array(ed25519Blob(3)));
  const conn = new FileSyncConnection(makeHostKeyMockClient(ed25519Blob(2)), {
    verbose: -1,
  });
  await expect(
    conn.open({
      channel: "sftp",
      server: { host: "sftp.example.org", hostKeyFingerprint: [a, b] },
    }),
    // The mismatch names the presented fingerprint and the whole pinned set.
  ).rejects.toThrow(/does not match any of the 2 pinned fingerprints/);
  expect(conn.connected).toBe(false);
  expect(conn.observedHostKey).toBeUndefined();
});

test("open (sftp) with no pin fails closed (the no-pin default)", async () => {
  // The no-pin default is now fail-closed (was warn-and-proceed): core refuses
  // the connection and the error surfaces the presented fingerprint to pin.
  const conn = new FileSyncConnection(makeHostKeyMockClient(ed25519Blob()), {
    verbose: -1,
  });
  await expect(
    conn.open({ channel: "sftp", server: { host: "sftp.example.org" } }),
  ).rejects.toThrow(/no host_key_fingerprint is pinned/);
  expect(conn.connected).toBe(false);
});

test("probeHostKeyFingerprint returns the presented key without authenticating", async () => {
  const blob = ed25519Blob();
  const expected = await computeHostKeyFingerprint(new Uint8Array(blob));
  // The probe's verifier always refuses, so the mock connect rejects; the probe
  // swallows that and returns what it captured. A password is set to prove the
  // probe never reaches auth (the refusal precedes it).
  const conn = new FileSyncConnection(makeHostKeyMockClient(blob), {
    verbose: -1,
  });
  const presented = await conn.probeHostKeyFingerprint({
    channel: "sftp",
    server: { host: "sftp.example.org", password: "secret" },
  });
  expect(presented.fingerprint).toBe(expected);
  expect(presented.keyType).toBe("ssh-ed25519");
  expect(conn.connected).toBe(false);
});

test("probeHostKeyFingerprint throws when the host presents no key", async () => {
  // A connect that fails before presenting a key (here, a no-verifier resolve)
  // leaves nothing captured, so the probe throws rather than returning a bogus
  // fingerprint.
  const { client } = makeMockClient();
  client.connect = async () => {}; // resolves without invoking the verifier
  const conn = new FileSyncConnection(client, { verbose: -1 });
  await expect(
    conn.probeHostKeyFingerprint({
      channel: "sftp",
      server: { host: "sftp.example.org" },
    }),
  ).rejects.toThrow(/could not determine the server's host key/);
});

test("probeHostKeyFingerprint surfaces the connect failure cause when no key is presented", async () => {
  // A connect that REJECTS before the verifier fires (e.g. an unreachable host)
  // must propagate the original cause rather than collapse to the generic
  // "presented no key" message, so the operator can tell an unreachable host
  // from any other SSH failure.
  const { client } = makeMockClient();
  const cause = new Error("connect ECONNREFUSED 10.0.0.1:22");
  client.connect = () => Promise.reject(cause);
  const conn = new FileSyncConnection(client, { verbose: -1 });
  const run = conn.probeHostKeyFingerprint({
    channel: "sftp",
    server: { host: "sftp.example.org" },
  });
  await expect(run).rejects.toThrow(/could not read the server's host key/);
  await expect(run).rejects.toThrow(/ECONNREFUSED/);
  await expect(run).rejects.toHaveProperty("cause", cause);
});

test("probeHostKeyFingerprint reports a fingerprint-computation failure distinctly", async () => {
  // The capture branch fires when computeHostKeyFingerprint rejects (e.g. crypto
  // .subtle unavailable in a hardened runtime) -- distinct from a server that
  // presented no key. It must surface as "failed to read", carrying the cause,
  // not collapse to the generic "did not present one" message.
  const blob = ed25519Blob();
  const origDigest = crypto.subtle.digest;
  crypto.subtle.digest = (() =>
    Promise.reject(
      new Error("subtle digest unavailable"),
    )) as typeof crypto.subtle.digest;
  try {
    const conn = new FileSyncConnection(makeHostKeyMockClient(blob), {
      verbose: -1,
    });
    await expect(
      conn.probeHostKeyFingerprint({
        channel: "sftp",
        server: { host: "sftp.example.org" },
      }),
    ).rejects.toThrow(/failed to read the server's host key/);
  } finally {
    crypto.subtle.digest = origDigest;
  }
});

test("probeHostKeyFingerprint swallows a late verify() throw on a torn-down handshake", async () => {
  // The competing-rejection race: connect() rejects on its own (as readyTimeout
  // would) while the verifier's async fingerprint hash is still pending, and the
  // eventual verify() throws because ssh2 already destructed its protocol.
  // settleVerify must swallow that so the void-ed verifier IIFE never rejects --
  // otherwise it surfaces as a stray unhandled rejection (a flaky failure).
  const blob = ed25519Blob();
  const { client } = makeMockClient();
  client.connect = (options: Record<string, unknown>) => {
    const verifier = options["hostVerifier"] as (
      b: Buffer,
      v: (permitted: boolean) => void,
    ) => void;
    return new Promise<void>((_resolve, reject) => {
      // Kick off the async verifier (its hash is now pending), then reject the
      // connect independently and make the eventual verify() throw, as a
      // destructed ssh2 protocol would.
      verifier(blob, () => {
        throw new Error("protocol._destruct is not a function");
      });
      reject(new Error("Timed out while waiting for handshake"));
    });
  };
  const conn = new FileSyncConnection(client, { verbose: -1 });

  const rejections: unknown[] = [];
  const onUnhandled = (err: unknown): void => {
    rejections.push(err);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    await expect(
      conn.probeHostKeyFingerprint({
        channel: "sftp",
        server: { host: "sftp.example.org" },
      }),
    ).rejects.toThrow(/could not read the server's host key/);
    // Let the late verifier IIFE run its (now guarded) verify(false).
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  expect(rejections).toEqual([]);
});

test("providerOptions cannot redirect the connection via sock or authHandler", async () => {
  // sock replaces the TCP connection without touching `host`; authHandler can
  // re-supply every credential. Both are dropped by the default-deny allowlist.
  const opts = await captureSftpConnectOptions({
    channel: "sftp",
    server: { host: "sftp.example.org" },
    providerOptions: { sock: {}, authHandler: () => ({}) },
  });
  expect(opts["sock"]).toBeUndefined();
  expect(opts["authHandler"]).toBeUndefined();
});

test("providerOptions cannot override the psilink-managed readyTimeout", async () => {
  // readyTimeout is derived from serverConnectTimeoutMs and is intentionally not
  // on the allowlist, so a providerOptions value cannot shorten or lengthen it.
  const opts = await captureSftpConnectOptions({
    channel: "sftp",
    server: { host: "sftp.example.org" },
    options: { serverConnectTimeoutMs: 30_000 },
    providerOptions: { readyTimeout: 1 },
  });
  expect(opts["readyTimeout"]).toBe(30_000);
});

test("providerOptions cannot supply readyTimeout when the config omits a connect timeout", async () => {
  // Symmetric to the case above: the allowlist drops a providerOptions
  // readyTimeout rather than letting it populate the connect option. With no
  // serverConnectTimeoutMs the connection then falls back to psilink's documented
  // 30000 ms default (supplied at the connect site even for a config carrying no
  // options block), NOT to the dropped providerOptions value or ssh2's default.
  const opts = await captureSftpConnectOptions({
    channel: "sftp",
    server: { host: "sftp.example.org" },
    providerOptions: { readyTimeout: 1 },
  });
  expect(opts["readyTimeout"]).toBe(30_000);
});

test("an unset connect timeout applies the documented default readyTimeout", async () => {
  // The schema default fires only when an options block is present; this config
  // omits options entirely, so the connect-site fallback is what supplies the
  // documented 30000 ms per-attempt deadline rather than dropping to ssh2's
  // shorter internal default.
  const opts = await captureSftpConnectOptions({
    channel: "sftp",
    server: { host: "sftp.example.org" },
  });
  expect(opts["readyTimeout"]).toBe(30_000);
});

test("an explicit connect timeout is used verbatim for readyTimeout", async () => {
  const opts = await captureSftpConnectOptions({
    channel: "sftp",
    server: { host: "sftp.example.org" },
    options: { serverConnectTimeoutMs: 12_345 },
  });
  expect(opts["readyTimeout"]).toBe(12_345);
});

test("a benign providerOptions transport option still applies", async () => {
  const opts = await captureSftpConnectOptions({
    channel: "sftp",
    server: { host: "sftp.example.org" },
    providerOptions: {
      keepaliveInterval: 5_000,
      keepaliveCountMax: 4,
      strictVendor: false,
    },
  });
  expect(opts["keepaliveInterval"]).toBe(5_000);
  expect(opts["keepaliveCountMax"]).toBe(4);
  expect(opts["strictVendor"]).toBe(false);
});

test("providerOptions algorithms passes through but serverHostKey is stripped", async () => {
  const opts = await captureSftpConnectOptions({
    channel: "sftp",
    server: { host: "sftp.example.org" },
    providerOptions: {
      algorithms: {
        cipher: ["aes256-gcm@openssh.com"],
        serverHostKey: ["ssh-dss"],
      },
    },
  });
  expect(opts["algorithms"]).toEqual({ cipher: ["aes256-gcm@openssh.com"] });
});

test("providerOptions algorithms with no allowed sub-keys is dropped entirely", async () => {
  const opts = await captureSftpConnectOptions({
    channel: "sftp",
    server: { host: "sftp.example.org" },
    providerOptions: { algorithms: { serverHostKey: ["ssh-dss"] } },
  });
  expect(opts["algorithms"]).toBeUndefined();
});

test("providerOptions algorithms that is not an object of categories is dropped", async () => {
  // A malformed algorithms value (here a bare string) is not an object of
  // algorithm categories, so it is dropped rather than forwarded to ssh2. This
  // branch's warn is distinct from the per-key drop loop (which the dropped-key
  // tests pin), so capture and assert it here -- the helper's inner capture tees
  // each WARN to this outer one too.
  const [, logs] = await withCapturedLogs(async () => {
    const opts = await captureSftpConnectOptions({
      channel: "sftp",
      server: { host: "sftp.example.org" },
      providerOptions: { algorithms: "aes256-gcm@openssh.com" },
    });
    expect(opts["algorithms"]).toBeUndefined();
  });
  expect(
    logs.some((l) =>
      l.message.includes("expected an object of algorithm categories"),
    ),
  ).toBe(true);
});

test("providerOptions algorithms accepts ssh2's append/prepend/remove object form", async () => {
  // ssh2 allows each algorithms category to be either an array of names or an
  // object with append/prepend/remove. An allowed sub-category is copied through
  // verbatim, so the object form must survive intact (not be coerced or dropped).
  const opts = await captureSftpConnectOptions({
    channel: "sftp",
    server: { host: "sftp.example.org" },
    providerOptions: {
      algorithms: { cipher: { append: ["aes256-gcm@openssh.com"] } },
    },
  });
  expect(opts["algorithms"]).toEqual({
    cipher: { append: ["aes256-gcm@openssh.com"] },
  });
});

test("a dropped algorithms sub-key is logged with a warning", async () => {
  const [, logs] = await withCapturedLogs(async () => {
    await captureSftpConnectOptions({
      channel: "sftp",
      server: { host: "sftp.example.org" },
      providerOptions: {
        algorithms: {
          cipher: ["aes256-gcm@openssh.com"],
          serverHostKey: ["ssh-dss"],
        },
      },
    });
  });
  expect(
    logs.some(
      (l) =>
        l.level === "WARN" &&
        l.message.includes("providerOptions.algorithms.serverHostKey"),
    ),
  ).toBe(true);
});

test("a dropped providerOptions key is logged with a warning", async () => {
  const [, logs] = await withCapturedLogs(async () => {
    await captureSftpConnectOptions({
      channel: "sftp",
      server: { host: "sftp.example.org" },
      providerOptions: { host: "attacker.example.org" },
    });
  });
  expect(
    logs.some(
      (l) =>
        l.level === "WARN" &&
        l.message.includes("providerOptions.host") &&
        l.message.includes("not in the allowed set of SFTP"),
    ),
  ).toBe(true);
});

// --- open (filedrop) ---------------------------------------------------------

test("open sets path and marks connected for filedrop config", async () => {
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, { verbose: -1 });
  await conn.open({ channel: "filedrop", path: "/mnt/share/drop" });
  expect(conn.connected).toBe(true);
  expect(conn.path).toBe("/mnt/share/drop");
});

test("filedrop connect uses the documented default connectTimeoutMs when unset", async () => {
  // No options block, so the connect-site fallback supplies the documented
  // 30000 ms per-attempt deadline rather than passing undefined down to
  // LocalFSClient's own fallback.
  const { client } = makeMockClient();
  let captured: Record<string, unknown> | undefined;
  client.connect = async (options: Record<string, unknown>) => {
    captured = options;
  };
  const conn = new FileSyncConnection(client, { verbose: -1 });
  await conn.open({ channel: "filedrop", path: "/mnt/share/drop" });
  expect(captured?.["connectTimeoutMs"]).toBe(30_000);
});

test("filedrop connect passes an explicit connectTimeoutMs verbatim", async () => {
  const { client } = makeMockClient();
  let captured: Record<string, unknown> | undefined;
  client.connect = async (options: Record<string, unknown>) => {
    captured = options;
  };
  const conn = new FileSyncConnection(client, { verbose: -1 });
  await conn.open({
    channel: "filedrop",
    path: "/mnt/share/drop",
    options: { serverConnectTimeoutMs: 7_000 },
  });
  expect(captured?.["connectTimeoutMs"]).toBe(7_000);
});

test("open strips trailing slash from filedrop path", async () => {
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, { verbose: -1 });
  await conn.open({ channel: "filedrop", path: "/mnt/share/drop/" });
  expect(conn.path).toBe("/mnt/share/drop");
});

test("open strips multiple trailing slashes from filedrop path", async () => {
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, { verbose: -1 });
  await conn.open({ channel: "filedrop", path: "/mnt/share/drop//" });
  expect(conn.path).toBe("/mnt/share/drop");
});

test("open preserves root filedrop path", async () => {
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, { verbose: -1 });
  await conn.open({ channel: "filedrop", path: "/" });
  expect(conn.path).toBe("/");
});

test("open maps peerTimeoutMs to timeToLive for filedrop config", async () => {
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, { verbose: -1 });
  const before = Date.now();
  await conn.open({
    channel: "filedrop",
    path: "/mnt/share/drop",
    options: { peerTimeoutMs: 60_000 },
  });
  const after = Date.now();
  const ttl = conn.options.timeToLive!.getTime();
  expect(ttl).toBeGreaterThanOrEqual(before + 60_000);
  expect(ttl).toBeLessThanOrEqual(after + 60_000);
});

test("open maps pollIntervalMs to pollingFrequency for filedrop config", async () => {
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, { verbose: -1 });
  await conn.open({
    channel: "filedrop",
    path: "/mnt/share/drop",
    options: { pollIntervalMs: 15_000 },
  });
  expect(conn.options.pollingFrequency).toBe(15_000);
});

test("open defers default timeToLive computation until connect resolves", async () => {
  // Regression guard: previously the default 1-hour TTL was computed in the
  // constructor, so retry latency between construction and open() ate into
  // the budget. The TTL must now be set during open() so the full default
  // window is available for peer-waiting.
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, { verbose: -1 });
  expect(conn.options.timeToLive).toBeUndefined();
  const before = Date.now();
  await conn.open({ channel: "filedrop", path: "/mnt/share/drop" });
  const after = Date.now();
  const ttl = conn.options.timeToLive!.getTime();
  // Default is 1 hour. Allow a generous lower bound to keep this stable on
  // slow CI: the budget should be near full, not consumed by construction.
  expect(ttl).toBeGreaterThanOrEqual(before + 60 * 60 * 1000 - 100);
  expect(ttl).toBeLessThanOrEqual(after + 60 * 60 * 1000);
});

test("open normalizes Windows backslashes in filedrop path", async () => {
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, { verbose: -1 });
  await conn.open({ channel: "filedrop", path: "C:\\Users\\shared\\drop" });
  expect(conn.path).toBe("C:/Users/shared/drop");
});

test("open preserves Windows drive root filedrop path", async () => {
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, { verbose: -1 });
  await conn.open({ channel: "filedrop", path: "C:/" });
  expect(conn.path).toBe("C:/");
});

test("open normalizes Windows drive root with trailing backslash", async () => {
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, { verbose: -1 });
  await conn.open({ channel: "filedrop", path: "C:\\" });
  expect(conn.path).toBe("C:/");
});

test("open normalizes Windows UNC filedrop path", async () => {
  // \\server\share is the canonical UNC form on Windows. After backslash-to-
  // forward conversion it becomes //server/share, which Node's win32 path
  // resolution still recognizes as a UNC path. Verify the leading double
  // slash is preserved (it would be ambiguous with a non-UNC path otherwise)
  // and that trailing-slash stripping does not collapse the prefix.
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, { verbose: -1 });
  await conn.open({ channel: "filedrop", path: "\\\\server\\share" });
  expect(conn.path).toBe("//server/share");
});

test("open normalizes Windows UNC filedrop path with trailing backslash", async () => {
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, { verbose: -1 });
  await conn.open({ channel: "filedrop", path: "\\\\server\\share\\" });
  expect(conn.path).toBe("//server/share");
});

test("open normalizes Windows UNC filedrop path with subdirectory", async () => {
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, { verbose: -1 });
  await conn.open({
    channel: "filedrop",
    path: "\\\\server\\share\\exchanges\\drop",
  });
  expect(conn.path).toBe("//server/share/exchanges/drop");
});

// --- Happy path --------------------------------------------------------------

test("send writes the message file to the store", async () => {
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client);
  conn.peerId = "stub-peer";

  await conn.send({ hello: "world" });

  // Default (timestampInFilename unset): `<id>-<byteCount>.json`.
  const written = [...files.keys()].filter((p) =>
    new RegExp(`^/test/${conn.id}-\\d+\\.json$`).test(p),
  );
  expect(written).toHaveLength(1);
});

test("send encodes the exact serialized byte count in the filename", async () => {
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client);
  conn.peerId = "stub-peer";

  await conn.send({ hello: "world" });

  const [written] = [...files.entries()].filter(([p]) =>
    new RegExp(`^/test/${conn.id}-\\d+\\.json$`).test(p),
  );
  expect(written).toBeDefined();
  const [path, buf] = written;
  const declared = Number(path.slice(0, -".json".length).split("-").at(-1));
  expect(declared).toBe(buf.length);
});

test("send writes the in-flight file with a .tmp extension and renames to .json", async () => {
  // A sync tool watching `*.json` must never match the partial write, so the
  // temp file carries a `.tmp` extension; only the atomic rename target ends
  // in `.json`.
  const { client } = makeMockClient();
  const conn = await makeConnectedConn(client);
  conn.peerId = "stub-peer";

  const putDests: string[] = [];
  const origPut = client.put.bind(client);
  client.put = async (src, dest, opts) => {
    putDests.push(dest);
    return origPut(src, dest, opts);
  };
  const renameTargets: string[] = [];
  const origRename = client.rename.bind(client);
  client.rename = async (from, to) => {
    renameTargets.push(to);
    return origRename(from, to);
  };

  await conn.send({ hello: "world" });

  expect(putDests).toHaveLength(1);
  expect(putDests[0].endsWith(".tmp")).toBe(true);
  expect(putDests[0].endsWith(".json")).toBe(false);

  expect(renameTargets).toHaveLength(1);
  expect(renameTargets[0]).toMatch(
    new RegExp(`^/test/${conn.id}-\\d+\\.json$`),
  );
});

test("send streams the header and payload as two chunks, without a concat copy", async () => {
  // The peak-shaving change: send() hands put() a [header, payload] chunk list
  // rather than one pre-concatenated buffer, so prepending the 10-byte header no
  // longer copies the whole payload -- a binary frame holds ~1x its size live, not
  // ~2x. Pin (a) put() receives a two-element array, (b) the payload part is the
  // SAME reference the caller passed (never copied), and (c) the bytes the
  // transport writes are byte-identical to the single-buffer serialization, with
  // the on-disk byte count the filename encodes matching.
  const { client } = makeMockClient();
  const conn = await makeConnectedConn(client);
  conn.peerId = "stub-peer";

  let putSrc:
    | string
    | Buffer
    | Uint8Array[]
    | NodeJS.ReadableStream
    | undefined;
  const origPut = client.put.bind(client);
  client.put = async (src, dest, opts) => {
    putSrc = src;
    return origPut(src, dest, opts);
  };
  let renamedTo: string | undefined;
  const origRename = client.rename.bind(client);
  client.rename = async (from, to) => {
    renamedTo = to;
    return origRename(from, to);
  };

  const frame = new Uint8Array([0x10, 0x20, 0x30, 0x40, 0x50]);
  await conn.send(frame);

  // (a) A two-chunk list: the header then the payload.
  expect(Array.isArray(putSrc)).toBe(true);
  const parts = putSrc as Uint8Array[];
  expect(parts).toHaveLength(2);
  expect(parts[0].length).toBe(MESSAGE_HEADER_BYTES);
  // (b) The payload chunk IS the caller's array, not a copy -- the ~1x proof.
  expect(parts[1]).toBe(frame);
  // (c) On-disk bytes equal the single-buffer serialization (header || payload)
  // for the same seq, and the filename encodes that exact length.
  const expected = serializeFileSyncMessage(MESSAGE_TYPE_BINARY, 0, frame);
  expect(Buffer.concat(parts).equals(expected)).toBe(true);
  expect(renamedTo).toBe(`/test/${conn.id}-${expected.length}.json`);
  expect(expected.length).toBe(MESSAGE_HEADER_BYTES + frame.length);
});

test("send removes the .tmp file in-process when the rename fails", async () => {
  // If the rename throws (e.g. transport failure) the catch block must delete
  // the orphaned .tmp file so it is not left behind for the failed exchange.
  // This is a best-effort in-process sweep through the still-live client; it
  // is the only cleanup path for an in-flight write, so the .tmp name is
  // deliberately not tracked in responsibleFiles (see send()).
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client);
  conn.peerId = "stub-peer";

  // Capture the temp path the write actually produced so the cleanup
  // assertion cannot pass vacuously: if a refactor stopped writing the temp
  // file, tempPath stays undefined and the "was written" check below fails.
  let tempPath: string | undefined;
  const origPut = client.put.bind(client);
  client.put = async (src, dest, opts) => {
    await origPut(src, dest, opts);
    tempPath = dest;
  };
  const safeDeleted: string[] = [];
  const origSafeDelete = client.safeDelete.bind(client);
  client.safeDelete = async (p) => {
    safeDeleted.push(p);
    return origSafeDelete(p);
  };

  client.rename = async () => {
    throw new Error("synthetic rename failure");
  };

  await expect(conn.send({ hello: "world" })).rejects.toThrow(
    "synthetic rename failure",
  );

  // The temp file was actually written (a .tmp, not a .json) ...
  expect(tempPath).toBeDefined();
  expect(tempPath!.endsWith(".tmp")).toBe(true);
  // ... the catch swept exactly that file via safeDelete ...
  expect(safeDeleted).toContain(tempPath!);
  // ... and no .tmp residue remains on disk.
  expect(files.has(tempPath!)).toBe(false);
  const tmpFiles = [...files.keys()].filter((p) => p.endsWith(".tmp"));
  expect(tmpFiles).toEqual([]);
});

// --- Race condition: consecutive sends ---------------------------------------

test("send waits for a previous unconsumed message before writing the next", async () => {
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client);
  conn.peerId = "stub-peer";

  // Simulate a message this connection sent that is still on disk (the peer's
  // poller hasn't consumed it yet). send() waits for the EXACT lastSentFile, so
  // point that at the planted name as a real prior send() would have.
  const outName = `${conn.id}-99.json`;
  const outPath = `/test/${outName}`;
  files.set(outPath, Buffer.from(JSON.stringify({ stale: true })));
  (conn as unknown as { lastSentFile?: string }).lastSentFile = outName;

  // After 50 ms, simulate the peer consuming (deleting) the stale message.
  const consumed = new Promise<void>((resolve) => {
    setTimeout(() => {
      files.delete(outPath);
      resolve();
    }, 50);
  });

  // send() must not throw; it should wait until the stale file is gone.
  await expect(conn.send({ next: true })).resolves.toBeUndefined();
  await consumed;
});

test("send times out when the previous message is never consumed", async () => {
  const { client, files } = makeMockClient();
  // Short TTL so the test doesn't take long.
  const conn = await makeConnectedConn(client, {
    timeToLiveMs: 150,
    pollingFrequency: 10,
  });
  conn.peerId = "stub-peer";

  // Plant a message this party sent that nobody will ever delete, and point
  // lastSentFile at it (the drain waits for that exact name to disappear).
  const outName = `${conn.id}-99.json`;
  files.set(`/test/${outName}`, Buffer.from(JSON.stringify({ stale: true })));
  (conn as unknown as { lastSentFile?: string }).lastSentFile = outName;

  await expect(conn.send({ next: true })).rejects.toThrow("timed out");
});

// --- TOCTOU race: ENOENT from get() ------------------------------------------

test("poll does not emit error when get() throws ENOENT after list() surfaced the file", async () => {
  // Simulate the TOCTOU window: list() surfaces the peer's message file, but by
  // the time get() runs the peer has already deleted it (their cleanup() raced
  // with our poll()). The poller must swallow ENOENT and reschedule rather than
  // emitting "error" and killing the connection.
  let getCount = 0;
  const peerId = "peer-test";
  let listCount = 0;
  const errors: unknown[] = [];

  // Resolved on list()'s 3rd call, confirming the poller rescheduled at least
  // twice after the ENOENT — without relying on a fixed wall-clock wait.
  let notifyThirdList!: () => void;
  const thirdList = new Promise<void>((r) => {
    notifyThirdList = r;
  });

  const [, logs] = await withCapturedLogs(async () => {
    const { client } = makeMockClient();
    // Surface a matching message file once (size matches the declared count so
    // poll() proceeds to get()); empty afterwards.
    client.list = async () => {
      listCount++;
      return listCount === 1
        ? [{ name: `${peerId}-5.json`, modifyTime: 0, size: 5 }]
        : [];
    };
    client.get = async (p) => {
      if (++getCount === 1) {
        throw Object.assign(
          new Error(`ENOENT: no such file or directory, open '${p}'`),
          { code: "ENOENT" },
        );
      }
      throw new Error("unexpected second get()");
    };
    const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
    conn.peerId = peerId;
    conn.on("error", (err) => errors.push(err));
    const origList = client.list.bind(client);
    client.list = async (p: string) => {
      const result = await origList(p);
      if (listCount === 3) notifyThirdList();
      return result;
    };
    conn.start();
    await Promise.race([
      thirdList,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("timed out waiting for 3rd list() call")),
          2_000,
        ),
      ),
    ]);
    conn.stop();
  });
  expect(logs).toHaveLength(1);
  expect(logs[0].message).toContain("disappeared between list and get");

  expect(errors).toHaveLength(0);
  // get() was called exactly once (on the ENOENT-throwing poll cycle).
  expect(getCount).toBe(1);
  // The poller rescheduled and ran additional cycles after the ENOENT.
  expect(listCount).toBeGreaterThan(1);
});

test("poll delivers a subsequent valid message after swallowing an ENOENT", async () => {
  let getCount = 0;
  const peerId = "peer-test";
  const validMessage = objectMessage({ hello: "world" });
  const peerName = `${peerId}-${validMessage.length}.json`;
  const peerPath = `/test/${peerName}`;

  let listCount = 0;
  const received: unknown[] = [];
  // Resolved when the first message arrives — no fixed wall-clock wait.
  let notifyReceived!: () => void;
  const firstMessage = new Promise<void>((r) => {
    notifyReceived = r;
  });

  const [, logs] = await withCapturedLogs(async () => {
    const { client, files } = makeMockClient();
    const originalGet = client.get.bind(client);
    client.list = async () => {
      listCount++;
      // First cycle surfaces a phantom file (get() throws ENOENT); second cycle
      // is empty (resets the consecutive-ENOENT counter); third cycle surfaces a
      // real message whose on-disk size matches its declared byte count.
      if (listCount === 1)
        return [{ name: `${peerId}-1.json`, modifyTime: 0, size: 1 }];
      if (listCount >= 3) {
        if (!files.has(peerPath)) files.set(peerPath, validMessage);
        return [{ name: peerName, modifyTime: 0, size: validMessage.length }];
      }
      return [];
    };
    client.get = async (p: string, opts?: unknown) => {
      if (++getCount === 1)
        throw Object.assign(
          new Error(`ENOENT: no such file or directory, open '${p}'`),
          { code: "ENOENT" },
        );
      return originalGet(p, opts as Parameters<typeof originalGet>[1]);
    };
    const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
    conn.peerId = peerId;
    conn.on("data", (msg) => {
      received.push(msg);
      notifyReceived();
    });
    conn.start();
    await Promise.race([
      firstMessage,
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(new Error("timed out waiting for first message delivery")),
          2_000,
        ),
      ),
    ]);
    conn.stop();
  });
  expect(logs).toHaveLength(1);
  expect(logs[0].message).toContain("disappeared between list and get");

  expect(received).toHaveLength(1);
  expect((received[0] as Record<string, unknown>)["hello"]).toBe("world");
});

// --- per-exchange inbound frame cap (single-pass read gate) -------------------

test("setInboundFrameCap tightens the poll-loop read gate; an over-cap frame is refused", async () => {
  // The single-pass receiver sets a per-exchange inbound cap (the derived reply
  // cap) before reading the reply. The poll loop must enforce THAT cap at the
  // read gate, not the static MAX_FRAME_SIZE_BYTES: a frame within the static cap
  // but over the per-exchange cap is refused with a terminal
  // FrameSizeExceededError, before get() loads it into memory.
  const peerId = "peer-test";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    pollingFrequency: 10,
    peerTimeoutMs: 2_000,
  });
  conn.peerId = peerId;

  const frame = binaryMessage(new Uint8Array(400).fill(7));
  files.set(`/test/${peerId}-${frame.length}.json`, frame);
  conn.setInboundFrameCap(200); // below the 400+ byte frame

  const errored = new Promise<unknown>((resolve) => conn.on("error", resolve));
  conn.start();
  const err = await Promise.race([
    errored,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("no error within budget")), 2_000),
    ),
  ]).catch((e: unknown) => e);
  conn.stop();

  expect(err).toBeInstanceOf(FrameSizeExceededError);
  expect((err as Error).message).toMatch(
    /exceeding the maximum inbound frame size of 200 bytes/,
  );
});

test("setInboundFrameCap clamps to MAX_FRAME_SIZE_BYTES and delivers an in-cap frame", async () => {
  // The cap can only tighten, never widen, the static backstop: a value above
  // MAX_FRAME_SIZE_BYTES is clamped down, and a frame within the (clamped)
  // per-exchange cap is delivered normally.
  const peerId = "peer-test";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    pollingFrequency: 10,
    peerTimeoutMs: 2_000,
  });
  conn.peerId = peerId;

  const payload = new Uint8Array(300).fill(9);
  const frame = binaryMessage(payload);
  files.set(`/test/${peerId}-${frame.length}.json`, frame);
  conn.setInboundFrameCap(MAX_FRAME_SIZE_BYTES * 4); // clamped to the static cap

  const delivered = new Promise<unknown>((resolve) => conn.on("data", resolve));
  conn.start();
  const msg = await Promise.race([
    delivered,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("no frame within budget")), 2_000),
    ),
  ]);
  conn.stop();

  expect(msg).toBeInstanceOf(Uint8Array);
  expect((msg as Uint8Array).length).toBe(payload.length);
});

test("poll emits error when ENOENT threshold is reached on consecutive poll cycles", async () => {
  // list() always surfaces a matching file (size matches declared count);
  // get() always throws ENOENT. After 3 consecutive ENOENT cycles the poller
  // must emit an error instead of warning indefinitely.
  const peerId = "peer-test";
  const errors: unknown[] = [];
  // Resolved by the error handler so the test waits only as long as necessary
  // rather than sleeping a fixed amount of wall time.
  let notifyError!: () => void;
  const errorArrived = new Promise<void>((resolve) => (notifyError = resolve));

  const [, logs] = await withCapturedLogs(async () => {
    const { client } = makeMockClient();
    client.list = async () => [
      { name: `${peerId}-5.json`, modifyTime: 0, size: 5 },
    ];
    client.get = async (p) => {
      throw Object.assign(
        new Error(`ENOENT: no such file or directory, open '${p}'`),
        { code: "ENOENT" },
      );
    };
    const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
    conn.peerId = peerId;
    // Stop the poller on the first error, mirroring real protocol behavior where
    // the error handler calls doCleanup()/conn.stop().
    conn.on("error", (err) => {
      errors.push(err);
      conn.stop();
      notifyError();
    });
    conn.start();
    await Promise.race([
      errorArrived,
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(new Error("timed out waiting for ENOENT threshold error")),
          2_000,
        ),
      ),
    ]);
  });
  expect(logs).toHaveLength(2);
  expect(logs[0].message).toContain("disappeared between list and get");

  expect(errors).toHaveLength(1);
});

test("poll emits error immediately when list() throws ENOENT (not a TOCTOU race)", async () => {
  // reachedGet is false when list() throws, so ENOENT from the detection scan
  // is a hard error that must be emitted immediately — not tolerated as a
  // TOCTOU race.
  const { client } = makeMockClient();
  client.list = async (p) => {
    throw Object.assign(
      new Error(`ENOENT: no such file or directory, scandir '${p}'`),
      { code: "ENOENT" },
    );
  };

  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.peerId = "peer-test";

  const errors: unknown[] = [];
  let notifyError!: () => void;
  const errorArrived = new Promise<void>((resolve) => (notifyError = resolve));

  conn.on("error", (err) => {
    errors.push(err);
    conn.stop();
    notifyError();
  });

  conn.start();
  await Promise.race([
    errorArrived,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("timed out waiting for exists() ENOENT error")),
        2_000,
      ),
    ),
  ]);

  expect(errors).toHaveLength(1);
});

// --- createExclusive() mock semantics ----------------------------------------

test("createExclusive throws EEXIST when destination already exists", async () => {
  const { client, files } = makeMockClient();
  files.set("/existing", Buffer.from("y"));
  await expect(client.createExclusive("/existing")).rejects.toMatchObject({
    code: "EEXIST",
  });
  // destination is unchanged
  expect(files.get("/existing")).toEqual(Buffer.from("y"));
});

test("createExclusive creates an empty entry and does not affect other files", async () => {
  const { client, files } = makeMockClient();
  files.set("/other", Buffer.from("data"));
  await client.createExclusive("/new");
  expect(files.has("/new")).toBe(true);
  expect(files.get("/new")).toEqual(Buffer.alloc(0));
  // unrelated file is untouched
  expect(files.get("/other")).toEqual(Buffer.from("data"));
});

// --- synchronize(): lock-file race cleanup ------------------------------------

test("synchronize() cleans up hello and lock files when createExclusive() throws EEXIST", async () => {
  // Simulates the losing party in the lock-file race: createExclusive() throws
  // because the peer already claimed the lock slot, and all three residue files
  // (-hello.json x2, -lock.json) must be deleted before synchronize() returns.
  const peerId = "00000000-0000-4000-8000-000000000001";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  // Pin conn.id to the lexicographic maximum so peerId always sorts below it,
  // guaranteeing the lock-file name and role assignment are deterministic.
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const myId = conn.id;

  const myHelloName = `${myId}-hello.json`;
  const peerHelloName = `${peerId}-hello.json`;
  // peerId < myId (pinned to max), so peer "arrived first" by name tiebreak.
  // Lock name: peer-mine.
  const lockName = `${peerId}-${myId}-lock.json`;
  const lockPath = `${conn.path}/${lockName}`;

  // Provide a consistent modifyTime: same for both so the name tiebreak decides.
  const mtime = Date.now();
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    if (listCallCount === 1) return []; // initial check: directory is clean
    return [
      { name: myHelloName, modifyTime: mtime, size: 0 },
      { name: peerHelloName, modifyTime: mtime, size: 0 },
    ];
  };

  // Plant the peer hello body so the two-hellos branch's HelloEnvelope read
  // gate (added by 193901017) passes before reaching createExclusive.
  files.set(`${conn.path}/${peerHelloName}`, LOCK_HELLO_BODY);

  // createExclusive() throws EEXIST; also plant the lock file so
  // exists(lockPath) → true, simulating the peer having already claimed it.
  client.createExclusive = async (path) => {
    files.set(lockPath, Buffer.alloc(0));
    throw Object.assign(new Error(`${path}: file already exists`), {
      code: "EEXIST",
    });
  };

  await conn.synchronize();

  // All residue files must be gone.
  expect(files.has(lockPath)).toBe(false);
  expect(files.has(`${conn.path}/${peerHelloName}`)).toBe(false);
  expect(files.has(`${conn.path}/${myHelloName}`)).toBe(false);
  // Roles are set correctly for the losing party.
  expect(conn.peerId).toBe(peerId);
  // peerId arrived first → this connection is initiator (second to arrive).
  expect(conn.handshakeRole).toBe("initiator");
});

test("synchronize() recognize-and-sweeps leftover abort markers (own and peer) at entry in delete mode", async () => {
  // Every authenticated terminal failure leaves a `<writerId>-abort.json`, so a
  // directory reused for a later exchange would otherwise reject "directory not
  // clean". The entry guard sweeps this party's own leftover marker and any
  // peer marker whose id is evidenced by a peer hello present at entry.
  const peerId = "00000000-0000-4000-8000-000000000001";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const myId = conn.id;

  const myHelloName = `${myId}-hello.json`;
  const peerHelloName = `${peerId}-hello.json`;
  const lockName = `${peerId}-${myId}-lock.json`;
  const lockPath = `${conn.path}/${lockName}`;
  const ownAbortPath = `${conn.path}/${myId}-abort.json`;
  const peerAbortPath = `${conn.path}/${peerId}-abort.json`;

  // Plant the leftover markers (their bodies are irrelevant -- the sweep deletes
  // by name) and the peer hello body for the rendezvous read gate.
  files.set(ownAbortPath, Buffer.from("{}"));
  files.set(peerAbortPath, Buffer.from("{}"));
  files.set(`${conn.path}/${peerHelloName}`, LOCK_HELLO_BODY);

  const mtime = Date.now();
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    if (listCallCount === 1)
      // Entry snapshot: a peer hello (recovers peerId) plus both leftover
      // markers. After the sweep, no unexpected protocol file remains.
      return [
        {
          name: peerHelloName,
          modifyTime: mtime,
          size: LOCK_HELLO_BODY.length,
        },
        { name: `${myId}-abort.json`, modifyTime: mtime, size: 2 },
        { name: `${peerId}-abort.json`, modifyTime: mtime, size: 2 },
      ];
    return [
      { name: myHelloName, modifyTime: mtime, size: 0 },
      { name: peerHelloName, modifyTime: mtime, size: LOCK_HELLO_BODY.length },
    ];
  };
  // Lose the lock race so rendezvous completes (mirrors the EEXIST test above).
  client.createExclusive = async (path) => {
    files.set(lockPath, Buffer.alloc(0));
    throw Object.assign(new Error(`${path}: file already exists`), {
      code: "EEXIST",
    });
  };

  await conn.synchronize();

  // Both leftover markers were swept; rendezvous still completed.
  expect(files.has(ownAbortPath)).toBe(false);
  expect(files.has(peerAbortPath)).toBe(false);
  expect(conn.peerId).toBe(peerId);
});

test("synchronize() does NOT sweep a leftover abort marker in retain mode; it surfaces as exit-64", async () => {
  // In retain mode the directory is a durable audit transcript, so a leftover
  // marker beside it must not be auto-swept (that would reintroduce the
  // destruction the retain guard prevents). It falls through to the unexpected-
  // protocol guard (a UsageError -> exit 64), which --force-retain-sweep clears.
  const { client, files } = makeMockClient();
  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
  });
  await conn.open({
    channel: "filedrop",
    path: "/test",
    options: {
      peerTimeoutMs: 50,
      retainFiles: true,
      locklessRendezvous: true,
    },
  });
  const ownAbortPath = `/test/${conn.id}-abort.json`;
  files.set(ownAbortPath, Buffer.from("{}"));
  client.list = async () => [
    { name: `${conn.id}-abort.json`, modifyTime: 0, size: 2 },
  ];

  await expect(conn.synchronize()).rejects.toBeInstanceOf(UsageError);
  // The transcript-adjacent marker survives the refusal.
  expect(files.has(ownAbortPath)).toBe(true);
});

test("synchronize() surfaces an over-cap peer hello as a terminal FrameSizeExceededError", async () => {
  // The rendezvous gate (readControlFileWithGate) must treat an over-cap hello
  // control file as terminal rather than retrying it until the deadline: a
  // hostile server could otherwise hold the gate open by serving an oversized
  // hello every cycle, re-incurring on each pass the allocation the cap exists
  // to prevent. Covers the FrameSizeExceededError rethrow in the gate's catch.
  const peerId = "00000000-0000-4000-8000-000000000001";
  const { client } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    pollingFrequency: 10,
    timeToLiveMs: 5_000,
  });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const myId = conn.id;
  const myHelloName = `${myId}-hello.json`;
  const peerHelloName = `${peerId}-hello.json`;
  const peerHelloPath = `${conn.path}/${peerHelloName}`;

  const mtime = Date.now();
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    if (listCallCount === 1) return []; // initial check: directory is clean
    return [
      { name: myHelloName, modifyTime: mtime, size: 0 },
      { name: peerHelloName, modifyTime: mtime, size: 0 },
    ];
  };

  // The peer hello is present in the listing, but the adapter refuses to read it
  // because it exceeds the cap (a server under-reporting its size in the listing
  // and then serving an oversized body). Count reads to prove the gate does not
  // retry at the polling cadence.
  let peerHelloReads = 0;
  const originalGet = client.get;
  client.get = async (path: string) => {
    if (path === peerHelloPath) {
      peerHelloReads++;
      throw new FrameSizeExceededError(
        `inbound file ${path} exceeds the maximum inbound frame size`,
      );
    }
    return originalGet(path);
  };

  await expect(conn.synchronize()).rejects.toBeInstanceOf(
    FrameSizeExceededError,
  );
  // Terminal: read once and propagated, not retried until the TTL.
  expect(peerHelloReads).toBe(1);
});

test("synchronize() surfaces a stalled peer-hello read as a terminal TransportOperationStalledError", async () => {
  // Liveness sibling of the over-cap case above. The rendezvous gate
  // (readControlFileWithGate) must treat a stalled hello read as terminal
  // rather than retrying it: a hostile server that withholds the transfer makes
  // each get() reject with the typed liveness error, and retrying at the polling
  // cadence would loop back into the stall every pass until the hour-long peer
  // TTL instead of failing fast in seconds. TransportOperationStalledError is a
  // UsageError, so the gate's catch rethrows it exactly as it does the over-cap
  // FrameSizeExceededError.
  const peerId = "00000000-0000-4000-8000-000000000001";
  const { client } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    pollingFrequency: 10,
    timeToLiveMs: 5_000,
  });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const myId = conn.id;
  const myHelloName = `${myId}-hello.json`;
  const peerHelloName = `${peerId}-hello.json`;
  const peerHelloPath = `${conn.path}/${peerHelloName}`;

  const mtime = Date.now();
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    if (listCallCount === 1) return []; // initial check: directory is clean
    return [
      { name: myHelloName, modifyTime: mtime, size: 0 },
      { name: peerHelloName, modifyTime: mtime, size: 0 },
    ];
  };

  // The peer hello is present in the listing, but the server withholds the
  // transfer so the adapter's liveness bound rejects the read. Count reads to
  // prove the gate does not retry at the polling cadence.
  let peerHelloReads = 0;
  const originalGet = client.get;
  client.get = async (path: string) => {
    if (path === peerHelloPath) {
      peerHelloReads++;
      throw new TransportOperationStalledError(
        `SFTP file read of ${path} stalled: received no data for 60000 ms ` +
          `(the server withheld the transfer); refusing to wait on the server ` +
          `further`,
      );
    }
    return originalGet(path);
  };

  await expect(conn.synchronize()).rejects.toBeInstanceOf(
    TransportOperationStalledError,
  );
  // Terminal: read once and propagated, not retried until the TTL.
  expect(peerHelloReads).toBe(1);
});

test("synchronize() propagates a base UsageError from a transport read as the terminal exit-64 failure, not retried", async () => {
  // The two cases above cover the concrete FrameSizeExceededError and
  // TransportOperationStalledError subclasses; this pins the contract at the
  // UsageError BASE class the gate's catch (and the poll loop) actually key off
  // ("if (err instanceof UsageError) throw err"), so the terminal behavior is the
  // class-level invariant rather than a per-subclass coincidence -- a future
  // UsageError subclass thrown from a transport read is terminal for free. The
  // rejection being an instanceof UsageError is exactly the exit-64 (EX_USAGE)
  // classification the CLI maps from this base class.
  const peerId = "00000000-0000-4000-8000-000000000001";
  const { client } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    pollingFrequency: 10,
    timeToLiveMs: 5_000,
  });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const myId = conn.id;
  const myHelloName = `${myId}-hello.json`;
  const peerHelloName = `${peerId}-hello.json`;
  const peerHelloPath = `${conn.path}/${peerHelloName}`;

  const mtime = Date.now();
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    if (listCallCount === 1) return []; // initial check: directory is clean
    return [
      { name: myHelloName, modifyTime: mtime, size: 0 },
      { name: peerHelloName, modifyTime: mtime, size: 0 },
    ];
  };

  // The peer-hello read rejects with a bare UsageError (the base class, not one of
  // the typed transport bounds). Count reads to prove the gate propagates it on
  // the first pass instead of retrying at the polling cadence until the TTL.
  let peerHelloReads = 0;
  const originalGet = client.get;
  client.get = async (path: string) => {
    if (path === peerHelloPath) {
      peerHelloReads++;
      throw new UsageError(`usage fault reading ${path}`);
    }
    return originalGet(path);
  };

  const rejection = await conn.synchronize().then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(rejection).toBeInstanceOf(UsageError);
  // Terminal: read once and propagated, not retried until the TTL.
  expect(peerHelloReads).toBe(1);
});

test("poll() stops the poller on a UsageError from a transport read, not retried", async () => {
  // Companion to the synchronize() propagation tests above, for the OTHER
  // transport-read retry consumer: the background poll loop. A UsageError from a
  // message read -- here a stalled get() -- is terminal: poll() stops the poller
  // and emits the error rather than rescheduling into the same stall. (A transient
  // non-UsageError read failure reschedules instead; the ENOENT poll tests above
  // cover that half.) With readControlFileWithGate's gate tests, this pins
  // terminal-on-UsageError behaviorally at both real consumers of a transport read.
  const peerId = "peer-test";
  const errors: unknown[] = [];
  let getCount = 0;
  let notifyError!: () => void;
  const errorArrived = new Promise<void>((resolve) => (notifyError = resolve));

  const { client } = makeMockClient();
  // A peer message whose on-disk size matches its declared byte count, so poll()
  // clears the frame-size and sync gates and reaches get().
  client.list = async () => [
    { name: `${peerId}-5.json`, modifyTime: 0, size: 5 },
  ];
  client.get = async () => {
    getCount++;
    throw new TransportOperationStalledError(
      "SFTP file read stalled: received no data for 60000 ms",
    );
  };
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.peerId = peerId;
  // Deliberately do NOT stop the poller in the handler: the poller must stop
  // itself on a UsageError. Were it to reschedule instead, get() would be
  // re-called every pollingFrequency and getCount would climb past 1.
  conn.on("error", (err) => {
    errors.push(err);
    notifyError();
  });
  conn.start();
  await Promise.race([
    errorArrived,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("timed out waiting for poll error")),
        2000,
      ),
    ),
  ]);
  // A terminal poller schedules no next cycle, so getCount is already final at 1
  // the moment the error fires -- this wait cannot make a stopped poller fail. It
  // only gives a WRONG reschedule (which fires every pollingFrequency = 10 ms)
  // several intervals to surface and bump getCount past 1, mirroring the margin
  // the "close() stops a running poller" test above uses for the same assertion.
  await new Promise((r) => setTimeout(r, 60));
  conn.stop();

  expect(errors).toHaveLength(1);
  expect(errors[0]).toBeInstanceOf(UsageError);
  expect(errors[0]).toBeInstanceOf(TransportOperationStalledError);
  // Terminal: read once and the poller stopped, not retried at the poll cadence.
  expect(getCount).toBe(1);
});

test("poll() stops the poller on a stalled consume-delete, not swallowed-and-re-emitted", async () => {
  // The delete-mode consume path deletes a validated message (the go-ahead signal
  // to the sender) before emitting it. A TRANSIENT delete failure is swallowed and
  // the file re-read next cycle -- but a terminal UsageError (the per-op stall
  // deadline a withheld delete callback now trips) must NOT be swallowed: doing so
  // would emit the message while its consume-delete never landed, leaving the file
  // on disk to be re-emitted as a duplicate every cycle (a ~120 s/cycle stall loop).
  // The poller must instead stop and surface the terminal error, like every other
  // transport-call site. Companion to the read-stall poll test above, for the
  // consume-delete consumer.
  const peerId = "peer-test";
  const validMessage = objectMessage({ hello: "world" });
  const peerName = `${peerId}-${validMessage.length}.json`;
  const peerPath = `/test/${peerName}`;

  const errors: unknown[] = [];
  const received: unknown[] = [];
  let deleteCount = 0;
  let notifyError!: () => void;
  const errorArrived = new Promise<void>((resolve) => (notifyError = resolve));

  const { client, files } = makeMockClient();
  // Pre-seed the message so the default get() reads it; it parses and validates,
  // reaching the consume-delete.
  files.set(peerPath, validMessage);
  client.list = async () => [
    { name: peerName, modifyTime: 0, size: validMessage.length },
  ];
  // The consume-delete stalls terminally (a withheld callback the adapter's per-op
  // deadline surfaces as this typed UsageError).
  client.delete = async () => {
    deleteCount++;
    throw new TransportOperationStalledError(
      "SFTP file delete stalled: did not complete within 60000 ms",
    );
  };
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.peerId = peerId;
  // Do NOT stop the poller in the handler: it must stop itself on the UsageError.
  conn.on("error", (err) => {
    errors.push(err);
    notifyError();
  });
  conn.on("data", (msg) => received.push(msg));
  conn.start();
  await Promise.race([
    errorArrived,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("timed out waiting for poll error")),
        2000,
      ),
    ),
  ]);
  // Give a wrong reschedule several poll intervals to surface (bump deleteCount or
  // deliver a duplicate); a terminal poller does neither.
  await new Promise((r) => setTimeout(r, 60));
  conn.stop();

  expect(errors).toHaveLength(1);
  expect(errors[0]).toBeInstanceOf(UsageError);
  expect(errors[0]).toBeInstanceOf(TransportOperationStalledError);
  // Terminal: the consume-delete ran once and the poller stopped -- not retried at
  // the poll cadence -- and the un-consumed message was NOT delivered.
  expect(deleteCount).toBe(1);
  expect(received).toHaveLength(0);
});

test("poll() stops the poller on a stalled retain-mode ack-write, not advanced-and-re-emitted", async () => {
  // Retain mode never deletes the message; the consumption signal the sender
  // waits for is instead a zero-length ack marker writeAck() publishes (a put
  // then a rename) BEFORE poll() emits the payload and advances
  // recvSeq/lastAckedNNN. A TRANSIENT ack-write failure reschedules and the
  // never-deleted message is reprocessed next cycle -- but a terminal UsageError
  // (the per-op stall deadline a withheld put callback now trips) must NOT be
  // swallowed: re-attempting just re-hits the stall, and advancing past it would
  // emit a message whose ack never landed, leaving the sender blocked forever on
  // an ack it will never see. The poller must instead stop and surface the
  // terminal error, like every other transport-call site. This is the retain
  // sibling of the read-stall and consume-delete poll tests above -- the
  // ack-write consumer in that terminal-on-UsageError family. It mirrors the
  // consume-delete test's structure; its retain consume harness (an inline
  // retain-mode connection reading a timestamped, recvSeq-matched message) is
  // adapted from the retain-mode tests below.
  const peerId = "peer-sender";
  const id = "receiver-me";
  const validMessage = objectMessage({ hello: "world" });
  // Retain filename grammar: <peerId>-<timestamp>-<NNN>-<byteCount>.json, with
  // NNN === recvSeq (0) so poll() selects it as this cycle's message.
  const peerName = `${peerId}-20260101T000000-000-${validMessage.length}.json`;
  const peerPath = `/test/${peerName}`;

  const errors: unknown[] = [];
  const received: unknown[] = [];
  let putCount = 0;
  let notifyError!: () => void;
  const errorArrived = new Promise<void>((resolve) => (notifyError = resolve));

  const { client, files } = makeMockClient();
  // Pre-seed the message so the default get() reads it; it parses and validates
  // (body seq matches the filename NNN), reaching the ack-write before emit.
  files.set(peerPath, validMessage);
  // The ack-write stalls terminally. put is writeAck()'s first transport op, so
  // a stall there is the ack-write itself failing (a withheld callback the
  // adapter's per-op deadline surfaces as this typed UsageError). poll() does no
  // other put on this path, so putCount counts ack-write attempts exactly.
  client.put = async () => {
    putCount++;
    throw new TransportOperationStalledError(
      "SFTP file write stalled: did not complete within 60000 ms",
    );
  };

  // Inline retain-mode connection (locklessRendezvous + timestampInFilename +
  // retainFiles): this cluster's makeConnectedConn does not set them, and the
  // equivalent makeRetainConn lives far below in the retain section, away from
  // these poll-terminal siblings.
  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    locklessRendezvous: true,
    timestampInFilename: true,
    retainFiles: true,
  });
  conn.id = id;
  conn.connected = true;
  conn.path = "/test";
  conn.peerId = peerId;
  // Do NOT stop the poller in the handler: it must stop itself on the UsageError.
  conn.on("error", (err) => {
    errors.push(err);
    notifyError();
  });
  conn.on("data", (msg) => received.push(msg));
  conn.start();
  await Promise.race([
    errorArrived,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("timed out waiting for poll error")),
        2000,
      ),
    ),
  ]);
  // Give a wrong reschedule several poll intervals to surface (bump putCount or
  // deliver the message); a terminal poller does neither.
  await new Promise((r) => setTimeout(r, 60));
  conn.stop();

  expect(errors).toHaveLength(1);
  expect(errors[0]).toBeInstanceOf(UsageError);
  expect(errors[0]).toBeInstanceOf(TransportOperationStalledError);
  // Terminal: the ack-write ran once and the poller stopped -- not retried at the
  // poll cadence. recvSeq/lastAckedNNN advance only after writeAck() resolves (it
  // never did), and emit() sits after the ack-write, so the message was neither
  // acked-and-advanced nor delivered: received stays empty, with no duplicate.
  // (recvSeq/lastAckedNNN are private; their non-advance is pinned behaviorally
  // here, as in the consume-delete sibling, not by reading the fields.)
  expect(putCount).toBe(1);
  expect(received).toHaveLength(0);
});

// --- whole-exchange liveness backstop (write/stat/delete + slow-drip read) ---
//
// The write-path analogue of the read-path liveness test above. The CLI adapter's
// per-operation bounds fast-fail a stalled READ (list/get/createExclusive) in 60s,
// but the always-executed write/stat/delete ops (put/rename/delete/exists) have no
// per-op bound, so a server that withholds the callback on one of them used to
// hang the exchange forever (the blocking S1 finding). FileSyncConnection now backstops
// EVERY transport await with the peer-inactivity budget, so a withheld callback
// fails the exchange with a terminal TransportOperationStalledError within the
// budget instead of hanging. The mock here withholds the callback (a never-settling
// promise) -- it does NOT throw -- so the failure can only come from the
// consumer-layer budget, not from any per-op adapter wrapper (none of these tests
// name one), which is what makes the backstop op-agnostic. A short peerTimeoutMs
// keeps the wall-clock wait small; timeToLiveMs is left large so the rendezvous /
// send-wait loops never fire first and the budget race is the sole cause.

test("send() fails within the peer budget when the server withholds the put callback", async () => {
  const { client } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    peerTimeoutMs: 100,
    timeToLiveMs: 60_000,
  });
  conn.peerId = "stub-peer";
  // The server accepts the request but never invokes the put callback.
  client.put = () => new Promise<void>(() => {});
  await expect(conn.send({ hello: "world" })).rejects.toBeInstanceOf(
    TransportOperationStalledError,
  );
});

test("send() fails within the peer budget when the server withholds the rename callback", async () => {
  const { client } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    peerTimeoutMs: 100,
    timeToLiveMs: 60_000,
  });
  conn.peerId = "stub-peer";
  // The put lands but the durable rename never gets its callback. rename sits on
  // the always-executed send path right after put, so it is bounded too.
  client.rename = () => new Promise<void>(() => {});
  await expect(conn.send({ hello: "world" })).rejects.toBeInstanceOf(
    TransportOperationStalledError,
  );
});

test("synchronize() fails within the peer budget when the server withholds the delete callback", async () => {
  // The lock-mode joiner fast-path publishes a joining sentinel, then deletes the
  // discovered peer hello, then renames the sentinel to its own hello. A server
  // that withholds the delete callback used to hang the rendezvous forever; the
  // budget now fails it terminally. delete is never individually wrapped, so this
  // failure is the consumer-layer backstop alone.
  const peerId = "00000000-0000-4000-8000-000000000001";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    peerTimeoutMs: 100,
    timeToLiveMs: 60_000,
  });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  // A valid peer hello so the bilateral-flag gate passes and the joiner proceeds
  // to the delete; the put(sentinel) before it succeeds against the mock store.
  files.set(`${conn.path}/${peerId}-hello.json`, LOCK_HELLO_BODY);
  client.delete = () => new Promise<void>(() => {});
  await expect(conn.synchronize()).rejects.toBeInstanceOf(
    TransportOperationStalledError,
  );
});

test("poll() fails within the peer budget when the server withholds (slow-drips) the get callback", async () => {
  // The S2 slow-drip read: a server that trickles under-cap bytes forever (or
  // withholds the transfer entirely) never trips the adapter's per-chunk idle
  // window -- each chunk resets it -- so the capped get() never settles. At the
  // consumer seam that is simply a get() promise that never resolves; total
  // elapsed crosses the budget and the poll loop fails terminally instead of
  // draining forever. (A mock has no adapter idle window at all, which is exactly
  // the LocalFSClient / filedrop case the same backstop also covers -- S3.)
  const peerId = "peer-test";
  const { client } = makeMockClient();
  client.list = async () => [
    { name: `${peerId}-5.json`, modifyTime: 0, size: 5 },
  ];
  client.get = () => new Promise<Buffer<ArrayBufferLike>>(() => {});
  const conn = await makeConnectedConn(client, {
    peerTimeoutMs: 100,
    pollingFrequency: 10,
    timeToLiveMs: 60_000,
  });
  conn.peerId = peerId;
  const emittedError = new Promise<unknown>((resolve) =>
    conn.once("error", resolve),
  );
  conn.start();
  const err = await emittedError;
  await conn.close();
  expect(err).toBeInstanceOf(TransportOperationStalledError);
});

test("poll() budget error escapes a hostile peer filename in the stalled-operation path", async () => {
  // The whole-exchange budget builds its TransportOperationStalledError from the
  // operation target; on a stalled get() that target is `${path}/${name}`, so a
  // peer message filename carrying control/ANSI bytes would otherwise reach the
  // operator raw. (The core-side budget twin of the CLI adapter's per-operation
  // transportOperationStalledError, which escapes its path the same way.)
  const peerId = "peer-test";
  // A valid peer-message name (peer prefix, numeric byte-count terminal) so it is
  // selected and get() is attempted, with an embedded ANSI sequence in its body.
  const hostileName = `${peerId}-\x1b[2J\x1b[31mEVIL-5.json`;
  const { client } = makeMockClient();
  client.list = async () => [{ name: hostileName, modifyTime: 0, size: 5 }];
  client.get = () => new Promise<Buffer<ArrayBufferLike>>(() => {});
  const conn = await makeConnectedConn(client, {
    peerTimeoutMs: 100,
    pollingFrequency: 10,
    timeToLiveMs: 60_000,
  });
  conn.peerId = peerId;
  const emittedError = new Promise<unknown>((resolve) =>
    conn.once("error", resolve),
  );
  conn.start();
  const err = await emittedError;
  await conn.close();
  expect(err).toBeInstanceOf(TransportOperationStalledError);
  const message = (err as Error).message;
  // The raw ESC from the peer filename never reaches the operator's terminal.
  expect(message).not.toContain("\x1b");
  expect(message).toContain("\\x1b");
});

test("close() does not hang when the server withholds a cleanup safeDelete callback", async () => {
  // safeDelete must never reject (callers use it in catch blocks), so its budget
  // wrapper RESOLVES at the deadline rather than throwing: a hung cleanup delete
  // stops waiting at the budget instead of hanging teardown. close() sweeps a
  // responsible file via safeDelete, so a withheld callback there must not wedge
  // close().
  const { client } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    peerTimeoutMs: 100,
    timeToLiveMs: 60_000,
  });
  conn.peerId = "stub-peer";
  await conn.send({ hello: "world" }); // makes this side responsible for a file
  client.safeDelete = () => new Promise<void>(() => {});
  // Resolves (does not reject, does not hang) once the cleanup delete hits the
  // budget.
  await expect(conn.close()).resolves.toBeUndefined();
});

test("close() does not hang or throw when the server withholds the end() callback", async () => {
  // end() is budget-wrapped (the rejecting variant), so a server that withholds
  // the SSH session-close callback makes it reject at the budget. close() is a
  // best-effort, non-throwing, idempotent teardown: it must swallow that bounded
  // rejection, clear `connected`, and not re-end the abandoned client on a second
  // call.
  const { client } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    peerTimeoutMs: 100,
    timeToLiveMs: 60_000,
  });
  conn.peerId = "stub-peer";
  let endCalls = 0;
  client.end = () => {
    endCalls++;
    return new Promise<void>(() => {});
  };
  // First close() resolves (does not reject) once the withheld end() hits the
  // budget, and it called end() exactly once.
  await expect(conn.close()).resolves.toBeUndefined();
  expect(endCalls).toBe(1);
  // Second close() neither throws nor re-enters the end() branch: `connected` was
  // cleared despite the rejection.
  await expect(conn.close()).resolves.toBeUndefined();
  expect(endCalls).toBe(1);
});

test("synchronize() throws when createExclusive throws EEXIST but lock file is already gone (peer abandoned)", async () => {
  // The lock file is only gone after EEXIST if the winner crashed during the
  // narrow window between createExclusive succeeding and responsibleFiles
  // being cleared. Polling for a peer that is not coming would stall until
  // peerTimeoutMs; synchronize() must fail fast and leave the directory clean.
  const peerId = "00000000-0000-4000-8000-000000000001";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  // Pin conn.id to the lexicographic maximum so peerId always sorts below it.
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const myId = conn.id;

  const myHelloName = `${myId}-hello.json`;
  const peerHelloName = `${peerId}-hello.json`;
  // peerId < myId (pinned to max), so peer "arrived first" by name tiebreak.
  // Lock name would be peer-mine.

  // Plant both hello files so the defensive safeDelete calls have something
  // to remove; the directory must be clean after the throw so a retry can
  // run from scratch.
  const basePath = conn.path;
  files.set(`${basePath}/${myHelloName}`, Buffer.alloc(0));
  // Peer hello carries a valid HelloEnvelope so the two-hellos read gate passes
  // before createExclusive (193901017); the own hello is never gate-read.
  files.set(`${basePath}/${peerHelloName}`, LOCK_HELLO_BODY);

  const mtime = Date.now();
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    if (listCallCount === 1) return []; // initial check: directory is clean
    return [
      { name: myHelloName, modifyTime: mtime, size: 0 },
      { name: peerHelloName, modifyTime: mtime, size: 0 },
    ];
  };

  // createExclusive() throws EEXIST but does NOT plant the lock file,
  // simulating the peer having already cleaned it up before exists() runs.
  client.createExclusive = async (path) => {
    throw Object.assign(new Error(`${path}: file already exists`), {
      code: "EEXIST",
    });
  };

  await expect(conn.synchronize()).rejects.toThrow(
    "peer appears to have abandoned",
  );

  // The directory must be clean after the throw so a retry can run from
  // scratch. Both hellos were deleted by the inner branch before the throw;
  // the outer catch safeDeletes lockPath and helloPath (no-ops here).
  expect(files.has(`${basePath}/${myHelloName}`)).toBe(false);
  expect(files.has(`${basePath}/${peerHelloName}`)).toBe(false);
});

test("synchronize() rejects and cleans up hello and lock files when createExclusive throws a non-EEXIST error", async () => {
  // Simulates an SFTP close-after-open failure: createExclusive atomically
  // creates the lock file on the server (open succeeds) but then fails to
  // close the handle, rejecting with a non-EEXIST error. The outer catch in
  // synchronize() must safeDelete the lock file and reject.
  const peerId = "00000000-0000-4000-8000-000000000001";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  // Pin conn.id to the lexicographic maximum so peerId always sorts below it.
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const myId = conn.id;

  const myHelloName = `${myId}-hello.json`;
  const peerHelloName = `${peerId}-hello.json`;
  // peerId < myId (pinned to max), so peer arrived first.
  const lockName = `${peerId}-${myId}-lock.json`;
  const lockPath = `${conn.path}/${lockName}`;

  const mtime = Date.now();
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    if (listCallCount === 1) return [];
    return [
      { name: myHelloName, modifyTime: mtime, size: 0 },
      { name: peerHelloName, modifyTime: mtime, size: 0 },
    ];
  };

  // Plant the peer's hello in the mock filesystem so the assertion below is
  // not vacuously true (and so the two-hellos read gate passes). The outer catch
  // is responsible only for this party's files (lockPath and helloPath); it does
  // not touch the peer's hello.
  files.set(`${conn.path}/${peerHelloName}`, LOCK_HELLO_BODY);

  // Simulate a partial createExclusive: create the file on the mock filesystem
  // (mimicking a successful open) but then reject (mimicking a close failure).
  client.createExclusive = async (path) => {
    files.set(path, Buffer.alloc(0));
    throw Object.assign(new Error("SFTP handle close failed"), { code: "EIO" });
  };

  await expect(conn.synchronize()).rejects.toThrow();

  // The lock file must be cleaned up (outer catch calls safeDelete(lockPath)).
  expect(files.has(lockPath)).toBe(false);
  // The outer catch cleans up only this party's hello (helloPath).
  expect(files.has(`${conn.path}/${myHelloName}`)).toBe(false);
  // The peer's hello is left intact — it is the peer's responsibility and will
  // be swept on the next synchronize() call by whichever party reconnects first.
  expect(files.has(`${conn.path}/${peerHelloName}`)).toBe(true);
});

test("synchronize() outer catch clears responsibleFiles so cleanup() makes no redundant safeDeletes", async () => {
  // Verifies that responsibleFiles is cleared in the outer catch block, so a
  // subsequent cleanup() call does not re-attempt safeDelete on files that the
  // outer catch already deleted.
  const peerId = "00000000-0000-4000-8000-000000000001";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const myId = conn.id;

  const myHelloName = `${myId}-hello.json`;
  const peerHelloName = `${peerId}-hello.json`;
  const lockName = `${peerId}-${myId}-lock.json`;
  const lockPath = `${conn.path}/${lockName}`;

  const mtime = Date.now();
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    if (listCallCount === 1) return [];
    return [
      { name: myHelloName, modifyTime: mtime, size: 0 },
      { name: peerHelloName, modifyTime: mtime, size: 0 },
    ];
  };

  // Plant the peer's hello so the safeDelete count is not skewed by a missing
  // file: if peerHelloName were absent, a safeDelete call for it would still
  // succeed (no-op on missing), so the count would be the same either way, but
  // the test is clearer when files match what list() claims exists. A valid
  // HelloEnvelope body also lets the two-hellos read gate pass.
  files.set(`${conn.path}/${peerHelloName}`, LOCK_HELLO_BODY);

  client.createExclusive = async (path) => {
    files.set(path, Buffer.alloc(0));
    throw Object.assign(new Error("SFTP handle close failed"), { code: "EIO" });
  };

  let safeDeleteCount = 0;
  const originalSafeDelete = client.safeDelete.bind(client);
  client.safeDelete = async (path) => {
    safeDeleteCount++;
    return originalSafeDelete(path);
  };

  await expect(conn.synchronize()).rejects.toThrow();

  // The outer catch deletes lockPath and helloPath (my hello): 2 safeDeletes.
  // The peer's hello is left intact — it is the peer's responsibility, not this
  // party's — so no safeDelete is issued for it.
  const countAfterSync = safeDeleteCount;
  expect(countAfterSync).toBe(2);

  // responsibleFiles was cleared by the outer catch: cleanup() must not call
  // safeDelete again. Without the clear, cleanup() would re-attempt safeDelete
  // on lockName and myHelloName (both already deleted), adding 2 more calls.
  await conn.cleanup();
  expect(safeDeleteCount).toBe(countAfterSync);

  expect(files.has(lockPath)).toBe(false);
  expect(files.has(`${conn.path}/${myHelloName}`)).toBe(false);
});

test("synchronize() resolves cleanly when it observes a lock file already created by the peer", async () => {
  // Regression guard: the lock-detection branch
  // (waitForPeer's "lockFiles.length > 0" arm) used to compare bare UUIDs
  // from the lock filename against -hello.json entries, which never matched,
  // so any party that observed a peer-created lock file threw
  // "lock file does not reference this connection" instead of completing
  // the rendezvous.
  //
  // Scenario reproduced here: peer arrived first, both wrote -hello.json,
  // peer won the lock race and created `${peerId}-${myId}-lock.json`. This party
  // observes peer-hello.json + my-hello.json + lock file on its next list().
  const peerId = "00000000-0000-4000-8000-000000000001";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const myId = conn.id;

  const myHelloName = `${myId}-hello.json`;
  const peerHelloName = `${peerId}-hello.json`;
  // Peer arrived first (sorted lower) so the lock name is `${peer}-${my}`.
  const lockName = `${peerId}-${myId}-lock.json`;
  const lockPath = `${conn.path}/${lockName}`;

  // Plant the three files so safeDelete calls have something to remove.
  // Peer hello must be valid JSON so the I5 read gate does not retry to timeout.
  files.set(`${conn.path}/${myHelloName}`, Buffer.alloc(0));
  files.set(`${conn.path}/${peerHelloName}`, LOCK_HELLO_BODY);
  files.set(lockPath, Buffer.alloc(0));

  const mtime = Date.now();
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    // Initial check (sees only our own newly-written hello mid-flow).
    // Subsequent listings expose the peer hello and the peer-created lock.
    if (listCallCount === 1) return [];
    return [
      { name: myHelloName, modifyTime: mtime, size: 0 },
      { name: peerHelloName, modifyTime: mtime, size: 0 },
      { name: lockName, modifyTime: mtime, size: 0 },
    ];
  };

  await conn.synchronize();

  // Peer arrived first so this party is the initiator (second to arrive).
  expect(conn.handshakeRole).toBe("initiator");
  // The lock-detection branch must label roles with the same convention as
  // the other rendezvous branches: responder=starter, initiator=joiner.
  expect(conn.role).toBe("joiner");
  expect(conn.peerId).toBe(peerId);
  // All three files cleaned up by the lock-detection branch.
  expect(files.has(lockPath)).toBe(false);
  expect(files.has(`${conn.path}/${peerHelloName}`)).toBe(false);
  expect(files.has(`${conn.path}/${myHelloName}`)).toBe(false);
});

// --- synchronize(): lock-detection with arbitrary-string ids -----------------

test("synchronize() lock-detection branch completes rendezvous with arbitrary string ids", async () => {
  // Acceptance criterion: a two-party unit test with arbitrary string ids
  // (not UUIDs) completes the lock handshake and assigns roles deterministically.
  //
  // "Agency A-hello.json" < "Agency B-hello.json" lexicographically, so
  // "Agency A" arrived first. The lock producer (the winner of the lock race,
  // which is unmodelled here -- we plant the lock directly) creates
  // "Agency A-Agency B-lock.json". This connection is "Agency B" and observes both
  // hellos plus the peer-created lock, triggering the lock-detection branch.
  const myId = "Agency B";
  const peerId = "Agency A";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = myId;

  const myHelloName = `${myId}-hello.json`;
  const peerHelloName = `${peerId}-hello.json`;
  // Peer arrived first (sorts lower) so the lock name is `${peerId}-${myId}`.
  const lockName = `${peerId}-${myId}-lock.json`;
  const lockPath = `${conn.path}/${lockName}`;

  files.set(`${conn.path}/${myHelloName}`, Buffer.alloc(0));
  files.set(`${conn.path}/${peerHelloName}`, LOCK_HELLO_BODY);
  files.set(lockPath, Buffer.alloc(0));

  const mtime = Date.now();
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    if (listCallCount === 1) return [];
    return [
      { name: myHelloName, modifyTime: mtime, size: 0 },
      { name: peerHelloName, modifyTime: mtime, size: 0 },
      { name: lockName, modifyTime: mtime, size: 0 },
    ];
  };

  await conn.synchronize();

  // Peer arrived first => this connection is initiator/joiner.
  expect(conn.handshakeRole).toBe("initiator");
  expect(conn.role).toBe("joiner");
  expect(conn.peerId).toBe(peerId);
  expect(files.has(lockPath)).toBe(false);
  expect(files.has(`${conn.path}/${peerHelloName}`)).toBe(false);
  expect(files.has(`${conn.path}/${myHelloName}`)).toBe(false);
});

test("synchronize() lock-detection branch uses filename order (I7), not id order, for prefix-related ids", async () => {
  // Acceptance criterion: with prefix-related ids where filename order and raw
  // id-compare diverge, roles are derived from filename order (I7) and the
  // lock-detection branch does NOT throw.
  //
  // "Agency A-hello.json" < "Agency-hello.json" because space (U+0020) sorts
  // before "-" (U+002D). So "Agency A" arrived first by filename order.
  // A raw `"Agency" < "Agency A"` id-compare would say "Agency" arrived first,
  // producing the wrong expected lock name and a false rejection. Filename order
  // is the source of truth (I7) and must win.
  const myId = "Agency";
  const peerId = "Agency A";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = myId;

  const myHelloName = `${myId}-hello.json`;
  const peerHelloName = `${peerId}-hello.json`;
  // "Agency A-hello.json" < "Agency-hello.json" => peer arrived first.
  // Lock name is `${peerId}-${myId}-lock.json`, matching what the producer wrote.
  const lockName = `${peerId}-${myId}-lock.json`;
  const lockPath = `${conn.path}/${lockName}`;

  files.set(`${conn.path}/${myHelloName}`, Buffer.alloc(0));
  files.set(`${conn.path}/${peerHelloName}`, LOCK_HELLO_BODY);
  files.set(lockPath, Buffer.alloc(0));

  const mtime = Date.now();
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    if (listCallCount === 1) return [];
    return [
      { name: myHelloName, modifyTime: mtime, size: 0 },
      { name: peerHelloName, modifyTime: mtime, size: 0 },
      { name: lockName, modifyTime: mtime, size: 0 },
    ];
  };

  // Must not throw "lock does not reference this connection".
  await conn.synchronize();

  expect(conn.handshakeRole).toBe("initiator");
  expect(conn.role).toBe("joiner");
  expect(conn.peerId).toBe(peerId);
  expect(files.has(lockPath)).toBe(false);
});

test("synchronize() lock-detection branch rejects a stale lock from a different id-pair", async () => {
  // Acceptance criterion: a stale -lock.json from a different id-pair, present
  // alongside the current pair's hellos, fails the pair-validation check.
  //
  // The current pair is "Agency B" + "Agency A". A stale lock file
  // "StaleX-StaleY-lock.json" from a prior session of a different pair is present.
  // Reconstruct-and-compare produces "Agency A-Agency B-lock.json" (peer arrived
  // first by filename order), which does not match the stale name.
  const myId = "Agency B";
  const peerId = "Agency A";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = myId;

  const myHelloName = `${myId}-hello.json`;
  const peerHelloName = `${peerId}-hello.json`;
  const staleLockName = "StaleX-StaleY-lock.json";
  const staleLockPath = `${conn.path}/${staleLockName}`;

  files.set(`${conn.path}/${myHelloName}`, Buffer.alloc(0));
  files.set(`${conn.path}/${peerHelloName}`, Buffer.alloc(0));
  files.set(staleLockPath, Buffer.alloc(0));

  const mtime = Date.now();
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    if (listCallCount === 1) return [];
    return [
      { name: myHelloName, modifyTime: mtime, size: 0 },
      { name: peerHelloName, modifyTime: mtime, size: 0 },
      { name: staleLockName, modifyTime: mtime, size: 0 },
    ];
  };

  await expect(conn.synchronize()).rejects.toThrow(
    "lock file does not reference this connection",
  );
});

// --- synchronize(): createExclusive winner retains responsibleFiles --------

test("synchronize() createExclusive winner: leaves own hello and lock name in responsibleFiles so cleanup() can sweep them if peer never arrives", async () => {
  // Regression guard: previously, the outer try block in synchronize() cleared
  // responsibleFiles on every successful waitForPeer() return — including the
  // createExclusive-winner path, which is the one path that legitimately needs
  // to retain its files. The loser (whose createExclusive throws EEXIST) is
  // normally responsible for cleaning the lock and both hellos, but if the
  // loser never arrives (crash, partition), the winner's eventual cleanup()
  // must sweep them. With the clear, the winner's responsibleFiles was empty
  // and the files were stranded.
  const peerId = "00000000-0000-4000-8000-000000000001";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const myId = conn.id;
  const myHelloName = `${myId}-hello.json`;
  const peerHelloName = `${peerId}-hello.json`;
  // peerId < myId so the peer "arrived first" by name tiebreak; lock name
  // is `${peerId}-${myId}-lock.json` and is created by THIS connection.
  const lockName = `${peerId}-${myId}-lock.json`;

  const mtime = Date.now();
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    if (listCallCount === 1) return []; // initial check
    return [
      { name: myHelloName, modifyTime: mtime, size: 0 },
      { name: peerHelloName, modifyTime: mtime, size: 0 },
    ];
  };
  // Peer hello body so the two-hellos read gate passes before createExclusive.
  files.set(`${conn.path}/${peerHelloName}`, LOCK_HELLO_BODY);
  // Default mock createExclusive succeeds (no EEXIST) — this conn is the
  // lock-race winner.

  await conn.synchronize();

  expect(conn.handshakeRole).toBe("initiator");
  expect(conn.peerId).toBe(peerId);
  // Winner retains its own hello AND the lock name; cleanup() can sweep
  // them later if the loser never arrives.
  const responsible = (conn as unknown as { responsibleFiles: Set<string> })
    .responsibleFiles;
  expect(responsible.has(myHelloName)).toBe(true);
  expect(responsible.has(lockName)).toBe(true);
});

test("synchronize() two-hellos branch: tiebreaker uses UUID order only, ignoring divergent modifyTimes", async () => {
  // Across heterogeneous transports the two parties can observe different --
  // even contradictory -- modifyTimes for the same hello files, because sync
  // tools stamp the transfer time rather than the original creation time. Here
  // each side sees ITS OWN hello as the earlier file, the worst case for a
  // modifyTime tiebreaker: it would make both parties believe they arrived
  // first, both claim the starter role, and derive two different lock names --
  // a deadlock. The UUID-only tiebreaker must instead assign the starter role
  // to the lexicographically-smaller UUID on both sides regardless of
  // modifyTime, so the parties agree on roles and on a single lock name.
  const idLow = "00000000-0000-4000-8000-000000000001";
  const idHigh = "ffffffff-ffff-4fff-bfff-ffffffffffff";

  // Run one side's synchronize() against a listing in which this side's own
  // hello is the earlier (smaller modifyTime) file. Returns the assigned roles
  // plus the lock name the side derived (captured from createExclusive).
  const runSide = async (
    myId: string,
    peerId: string,
  ): Promise<{
    role: string;
    handshakeRole: string | undefined;
    lockName: string;
  }> => {
    const { client, files } = makeMockClient();
    const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
    conn.id = myId;
    const base = conn.path ?? "";
    const myHelloName = `${myId}-hello.json`;
    const peerHelloName = `${peerId}-hello.json`;

    let listCallCount = 0;
    client.list = async () => {
      listCallCount++;
      if (listCallCount === 1) return []; // initial check: directory is clean
      // This side's own hello carries the EARLIER timestamp; under a
      // modifyTime tiebreaker that would mark this side as "arrived first".
      return [
        { name: myHelloName, modifyTime: 1000, size: 0 },
        { name: peerHelloName, modifyTime: 5000, size: 0 },
      ];
    };
    // Peer hello body so the two-hellos read gate passes before createExclusive.
    files.set(`${base}/${peerHelloName}`, LOCK_HELLO_BODY);

    let lockName = "";
    const realCreateExclusive = client.createExclusive.bind(client);
    client.createExclusive = async (path: string) => {
      lockName = path.slice(base.length + 1);
      return realCreateExclusive(path);
    };

    await conn.synchronize();
    return { role: conn.role, handshakeRole: conn.handshakeRole, lockName };
  };

  const low = await runSide(idLow, idHigh);
  const high = await runSide(idHigh, idLow);

  // The smaller UUID is the starter on both sides; modifyTime is ignored even
  // though it pointed the other way for the high-UUID side.
  expect(low.handshakeRole).toBe("responder");
  expect(low.role).toBe("starter");
  expect(high.handshakeRole).toBe("initiator");
  expect(high.role).toBe("joiner");

  // Both sides independently derive the SAME lock name, `${low}-${high}-lock.json`,
  // which is what lets the loser locate and clean up the winner's lock file.
  expect(low.lockName).toBe(`${idLow}-${idHigh}-lock.json`);
  expect(high.lockName).toBe(`${idLow}-${idHigh}-lock.json`);
});

// --- synchronize(): joiner branch (initial list shows one peer hello) -------

test("synchronize() joiner branch: assigns initiator role and writes own hello after deleting peer's", async () => {
  // Initial list returns one peer .hello, triggering the joiner branch
  // (this party arrived second on a previously-empty directory).
  const peerId = "00000000-0000-4000-8000-000000000001";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const peerHelloName = `${peerId}-hello.json`;
  files.set(`${conn.path}/${peerHelloName}`, LOCK_HELLO_BODY);
  client.list = async () => [
    { name: peerHelloName, modifyTime: Date.now(), size: 0 },
  ];

  await conn.synchronize();

  expect(conn.handshakeRole).toBe("initiator");
  expect(conn.peerId).toBe(peerId);
  // Peer's hello was deleted; our own hello was written via the sentinel
  // rename, and no `<id>-joining.json` sentinel is left behind (it became the
  // hello).
  expect(files.has(`${conn.path}/${peerHelloName}`)).toBe(false);
  expect(files.has(`${conn.path}/${conn.id}-hello.json`)).toBe(true);
  expect(files.has(`${conn.path}/${conn.id}-joining.json`)).toBe(false);
});

// --- synchronize(): joiner partial-failure (sentinel) ------------------------

// Helper: stand up a joiner whose initial list shows exactly one peer hello,
// so synchronize() takes the lock-path joiner branch (this party arrived
// second). Returns the live store and the planted peer-hello name.
async function makeJoiner(joinerRecoveryMs?: number): Promise<{
  conn: FileSyncConnection;
  client: FileTransportClient;
  files: Map<string, Buffer>;
  peerId: string;
  peerHelloName: string;
}> {
  const peerId = "00000000-0000-4000-8000-000000000001";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    pollingFrequency: 10,
    joinerRecoveryMs,
  });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const peerHelloName = `${peerId}-hello.json`;
  files.set(`${conn.path}/${peerHelloName}`, LOCK_HELLO_BODY);
  client.list = async () => [
    { name: peerHelloName, modifyTime: Date.now(), size: 0 },
  ];
  return { conn, client, files, peerId, peerHelloName };
}

// Reads the private responsibleFiles set for assertions.
function responsibleFilesOf(conn: FileSyncConnection): Set<string> {
  return (conn as unknown as { responsibleFiles: Set<string> })
    .responsibleFiles;
}

test("synchronize() joiner branch: a sentinel put failure leaves the peer hello intact and the connection unsynchronized", async () => {
  // First failure point: the joiner cannot even write its `<id>-joining.json`
  // sentinel. Because the sentinel is written BEFORE the peer hello is deleted,
  // a failure here cannot strand the peer -- its hello is untouched and no
  // sentinel is committed, so the directory is exactly as the joiner found it.
  const { conn, client, files, peerHelloName } = await makeJoiner();
  client.put = async () => {
    throw new Error("synthetic sentinel put failure");
  };

  await expect(conn.synchronize()).rejects.toThrow(
    "synthetic sentinel put failure",
  );

  // Peer hello untouched; nothing the joiner owns is left behind.
  expect(files.has(`${conn.path}/${peerHelloName}`)).toBe(true);
  expect(files.has(`${conn.path}/${conn.id}-joining.json`)).toBe(false);
  expect(files.has(`${conn.path}/${conn.id}-hello.json`)).toBe(false);
  // Pre-synchronize state, so a retry on this instance is not blocked by the
  // "already synchronized" guard.
  expect(conn.peerId).toBeUndefined();
  expect(conn.handshakeRole).toBeUndefined();
});

test("synchronize() joiner branch: a failure before the peer hello is deleted tracks the sentinel for cleanup()", async () => {
  // Second failure point, still BEFORE the peer hello is deleted: the sentinel
  // was written but delete(peer hello) throws. The peer hello is intact, so the
  // sentinel is the joiner's own residue -- it stays in responsibleFiles and
  // cleanup() sweeps it (taxonomy: joining is in responsibleFiles, swept by
  // cleanup(), until the peer hello is deleted).
  const { conn, client, files, peerHelloName } = await makeJoiner();
  const joiningName = `${conn.id}-joining.json`;
  client.delete = async () => {
    throw new Error("synthetic peer-hello delete failure");
  };

  await expect(conn.synchronize()).rejects.toThrow(
    "synthetic peer-hello delete failure",
  );

  // Sentinel was committed and the peer hello is intact (delete never ran).
  expect(files.has(`${conn.path}/${joiningName}`)).toBe(true);
  expect(files.has(`${conn.path}/${peerHelloName}`)).toBe(true);
  // The joiner still owns the sentinel: it is tracked and cleanup() removes it.
  expect(responsibleFilesOf(conn).has(joiningName)).toBe(true);
  await conn.cleanup();
  expect(files.has(`${conn.path}/${joiningName}`)).toBe(false);
});

test("synchronize() joiner branch: a failure after the peer hello is deleted leaves the sentinel as the peer's recovery signal", async () => {
  // Critical failure point: the joiner deleted the peer hello, then the rename
  // of the sentinel to its hello throws. The peer hello is gone, so the sentinel
  // MUST persist as the peer's recovery signal -- it is released from
  // responsibleFiles so a failure-path cleanup() does not sweep it. This is the
  // exact partial-failure window the fix closes: the peer sees the sentinel and
  // recovers within a bounded window instead of polling to the peer timeout.
  const { conn, client, files, peerHelloName } = await makeJoiner();
  const joiningName = `${conn.id}-joining.json`;
  client.rename = async () => {
    throw new Error("synthetic sentinel rename failure");
  };

  await expect(conn.synchronize()).rejects.toThrow(
    "synthetic sentinel rename failure",
  );

  // Peer hello deleted, sentinel still on disk and NOT renamed to a hello.
  expect(files.has(`${conn.path}/${peerHelloName}`)).toBe(false);
  expect(files.has(`${conn.path}/${joiningName}`)).toBe(true);
  expect(files.has(`${conn.path}/${conn.id}-hello.json`)).toBe(false);
  // Released from responsibleFiles, so the failure-path cleanup() leaves the
  // sentinel in place for the peer to recover from (and for the next run's
  // Phase 0 guard to reject if this process dies).
  expect(responsibleFilesOf(conn).has(joiningName)).toBe(false);
  await conn.cleanup();
  expect(files.has(`${conn.path}/${joiningName}`)).toBe(true);
  // Pre-synchronize state regardless of where the joiner failed.
  expect(conn.peerId).toBeUndefined();
  expect(conn.handshakeRole).toBeUndefined();
});

// --- synchronize(): lock starter peer-side joiner recovery -------------------

test("synchronize() lock starter: completes rendezvous when a mid-arrival joiner recovers", async () => {
  // The peer (arrived first, lock starter) sees the joiner's sentinel for a few
  // polls -- the joiner is mid-arrival, having deleted our hello but not yet
  // renamed its sentinel to its hello -- then the rename lands and the joiner
  // appears as a normal peer hello. The starter must wait through the sentinel
  // and complete, not abort or stall.
  const idB = "00000000-0000-4000-8000-000000000001";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const joiningName = `${idB}-joining.json`;
  const peerHelloName = `${idB}-hello.json`;
  // The joiner's hello body must be readable through the gate once the rename
  // makes it appear under its final name.
  files.set(`${conn.path}/${peerHelloName}`, LOCK_HELLO_BODY);
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    // First list (preexisting guard) sees an empty directory, so this party
    // becomes the lock starter and writes its hello.
    if (listCallCount === 1) return [];
    // Joiner mid-arrival: only the sentinel is visible (our hello is gone).
    if (listCallCount <= 3)
      return [{ name: joiningName, modifyTime: Date.now(), size: 0 }];
    // Joiner recovered: the rename landed, so the sentinel is now its hello.
    return [{ name: peerHelloName, modifyTime: Date.now(), size: 0 }];
  };

  await conn.synchronize();

  // Arrived first => starter/responder; peer id recovered from the hello name.
  expect(conn.role).toBe("starter");
  expect(conn.handshakeRole).toBe("responder");
  expect(conn.peerId).toBe(idB);
  // The starter branch consumed (deleted) the joiner's hello.
  expect(files.has(`${conn.path}/${peerHelloName}`)).toBe(false);
});

test("synchronize() lock starter: aborts with a distinct transport error within a bounded window when a joiner never completes", async () => {
  // The critical case the fix closes. A joiner deleted our hello and then died
  // before renaming its sentinel to its hello, so the sentinel persists. The
  // peer must surface a distinct, terminal error and abort on the bounded
  // recovery window -- NOT poll silently to the full peerTimeoutMs, and NOT a
  // usage error (this is a transport failure, CLI exit 69).
  const idB = "00000000-0000-4000-8000-000000000001";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    pollingFrequency: 10,
    joinerRecoveryMs: 30,
    timeToLiveMs: 5_000,
  });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const joiningName = `${idB}-joining.json`;
  files.set(`${conn.path}/${joiningName}`, LOCK_HELLO_BODY);
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    // Empty at entry (this party becomes the starter and writes its hello),
    // then the stuck sentinel forever: our hello gone, the rename never lands.
    if (listCallCount === 1) return [];
    return [{ name: joiningName, modifyTime: Date.now(), size: 0 }];
  };

  const start = Date.now();
  const err = await conn.synchronize().catch((e: unknown) => e);
  const elapsed = Date.now() - start;

  expect(err).toBeInstanceOf(Error);
  // Distinct, actionable message -- not the generic "synchronization has timed
  // out" the full peerTimeoutMs path produces.
  expect((err as Error).message).toMatch(
    /did not complete within the recovery window/,
  );
  // Describes the mid-arrival failure without pinning it to a single step (the
  // crash can be on either side of the joiner's delete).
  expect((err as Error).message).toMatch(
    /failed after announcing its arrival but before publishing its hello/,
  );
  // Tagged with the waiting party's actual role rather than the uninitialized
  // "unknown role" sentinel value.
  expect((err as Error).message).toMatch(/^\[starter\]/);
  // Transport failure (CLI exit 69), not a usage error (exit 64).
  expect(err).not.toBeInstanceOf(UsageError);
  // Bounded by the recovery window, far below the 5 s TTL.
  expect(elapsed).toBeLessThan(2_000);
  // The peer never owned the sentinel, so its outer-catch sweep leaves it on
  // disk for the next run's Phase 0 guard rather than masking the crash.
  expect(files.has(`${conn.path}/${joiningName}`)).toBe(true);
  // Instance is reset, not wedged: a retry is not blocked.
  expect(conn.peerId).toBeUndefined();
  expect(conn.handshakeRole).toBeUndefined();
});

test("synchronize() lock starter: aborts on a stuck sentinel even while its own hello is still present (state a)", async () => {
  // State (a) of the joiner's sequence: it has written its sentinel (put) but
  // not yet deleted this party's hello, so the starter's own hello and the
  // sentinel are visible together (otherFiles === 0, theseFiles === 1,
  // joiningFiles === 1). The recovery branch is gated only on the sentinel, not
  // on whether our hello is gone, so the bounded-window abort must still fire
  // here -- and the message must NOT claim the joiner already deleted our hello,
  // because it may have crashed before that step. This pins finding 1's premise
  // (the recovery branch is reachable before the delete) and its reworded text.
  const idB = "00000000-0000-4000-8000-000000000001";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    pollingFrequency: 10,
    joinerRecoveryMs: 30,
    timeToLiveMs: 5_000,
  });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const myHello = `${conn.id}-hello.json`;
  const joiningName = `${idB}-joining.json`;
  files.set(`${conn.path}/${joiningName}`, LOCK_HELLO_BODY);
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    if (listCallCount === 1) return []; // preexisting guard: empty
    // Our own hello is still present (the joiner has not deleted it yet) and the
    // joiner's sentinel sits beside it, never resolving to a hello.
    return [
      { name: myHello, modifyTime: Date.now(), size: 0 },
      { name: joiningName, modifyTime: Date.now(), size: 0 },
    ];
  };

  const start = Date.now();
  const err = await conn.synchronize().catch((e: unknown) => e);
  const elapsed = Date.now() - start;

  expect(err).toBeInstanceOf(Error);
  // Transport failure (exit 69), not a usage error.
  expect(err).not.toBeInstanceOf(UsageError);
  expect((err as Error).message).toMatch(
    /did not complete within the recovery window/,
  );
  // Crucially: does NOT assert the delete already happened, since in state (a)
  // it has not. The reworded message brackets both sub-windows.
  expect((err as Error).message).toMatch(
    /failed after announcing its arrival but before publishing its hello/,
  );
  expect((err as Error).message).toMatch(/^\[starter\]/);
  // Bounded by the recovery window, far below the 5 s TTL.
  expect(elapsed).toBeLessThan(2_000);
});

test("synchronize() lock starter: a sentinel visible when the TTL expires yields the stuck-joiner error, not a bare timeout", async () => {
  // The recovery window (joinerRecoveryMs) is independent of the outer TTL
  // (peerTimeoutMs). If a sentinel first appears with less than joinerRecoveryMs
  // left on the TTL, the poll loop exits before the recovery check can fire.
  // Here joinerRecoveryMs (10 s) far exceeds the TTL (150 ms), so the recovery
  // check never fires and the loop exits via the TTL while the sentinel is still
  // tracked. The fallback must still surface the actionable stuck-joiner cause,
  // not the generic "synchronization has timed out".
  const idB = "00000000-0000-4000-8000-000000000001";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    pollingFrequency: 10,
    joinerRecoveryMs: 10_000,
    timeToLiveMs: 150,
  });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const joiningName = `${idB}-joining.json`;
  files.set(`${conn.path}/${joiningName}`, LOCK_HELLO_BODY);
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    if (listCallCount === 1) return []; // preexisting guard: empty
    return [{ name: joiningName, modifyTime: Date.now(), size: 0 }];
  };

  const err = await conn.synchronize().catch((e: unknown) => e);

  expect(err).toBeInstanceOf(Error);
  expect(err).not.toBeInstanceOf(UsageError);
  // Names the stuck sentinel and the mid-arrival failure like the bounded-window
  // abort, but via the TTL fallback ("the exchange timed out before it
  // completed" rather than "within the recovery window").
  expect((err as Error).message).toMatch(/^\[starter\] peer began arriving/);
  expect((err as Error).message).toContain(joiningName);
  expect((err as Error).message).toMatch(
    /the exchange timed out before it completed/,
  );
  // NOT the generic bare timeout the pre-fix path produced.
  expect((err as Error).message).not.toMatch(/synchronization has timed out/);
});

test("synchronize() lock starter: a sentinel that vanishes and reappears gets a fresh recovery window", async () => {
  // The empty-poll reset of joiningSeenAt/joiningSeenName times a reappearing
  // sentinel from its REappearance, not its first sighting. Without the reset,
  // the reappearing sentinel would inherit the now-elapsed timestamp and abort
  // immediately. The gap of empty polls advances real time past the 50 ms
  // window, so the regression is observable: with the reset the rendezvous
  // completes; without it, it would reject on reappearance.
  const idB = "00000000-0000-4000-8000-000000000001";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    pollingFrequency: 10,
    joinerRecoveryMs: 50,
    timeToLiveMs: 5_000,
  });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const joiningName = `${idB}-joining.json`;
  const peerHelloName = `${idB}-hello.json`;
  files.set(`${conn.path}/${peerHelloName}`, LOCK_HELLO_BODY);
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    if (listCallCount === 1) return []; // preexisting guard: empty
    // Sentinel appears once (poll 2), vanishes for several polls (long enough
    // that a stale timestamp would be past the 50 ms window), then returns.
    if (listCallCount === 2)
      return [{ name: joiningName, modifyTime: Date.now(), size: 0 }];
    if (listCallCount <= 9) return []; // vanished -> joiningSeenAt reset
    if (listCallCount === 10)
      return [{ name: joiningName, modifyTime: Date.now(), size: 0 }];
    // The fresh-windowed joiner then completes its rename.
    return [{ name: peerHelloName, modifyTime: Date.now(), size: 0 }];
  };

  // With the reset this completes; without it, it would reject on reappearance.
  await conn.synchronize();
  expect(conn.role).toBe("starter");
  expect(conn.peerId).toBe(idB);
});

test("synchronize() lock starter: a different-id sentinel replacing an earlier one completes with the second joiner", async () => {
  // The joiningSeenName !== joiningName arm restarts the recovery window when a
  // sentinel from a different id replaces an earlier one (a second joiner taking
  // over). This pins the functional outcome: the starter completes against
  // whichever joiner ultimately publishes its hello, even after seeing a
  // different sentinel first. (The sub-poll timing of the restart is covered by
  // reasoning, not asserted: A directly replaced by B has no empty poll between,
  // so the restart's effect is a single poll interval, below real-timer
  // resolution.) joinerRecoveryMs is large so no abort fires during the swap.
  const idB = "00000000-0000-4000-8000-000000000001";
  const idC = "00000000-0000-4000-8000-000000000002";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    pollingFrequency: 10,
    joinerRecoveryMs: 10_000,
    timeToLiveMs: 5_000,
  });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const sentinelB = `${idB}-joining.json`;
  const sentinelC = `${idC}-joining.json`;
  const helloC = `${idC}-hello.json`;
  files.set(`${conn.path}/${helloC}`, LOCK_HELLO_BODY);
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    if (listCallCount === 1) return []; // preexisting guard: empty
    if (listCallCount === 2)
      return [{ name: sentinelB, modifyTime: Date.now(), size: 0 }];
    if (listCallCount <= 4)
      return [{ name: sentinelC, modifyTime: Date.now(), size: 0 }];
    // The second joiner (idC) completes its rename.
    return [{ name: helloC, modifyTime: Date.now(), size: 0 }];
  };

  await conn.synchronize();
  expect(conn.role).toBe("starter");
  expect(conn.peerId).toBe(idC);
});

test("synchronize() lock starter: TTL expiry with no joiner produces the bare [starter] timeout", async () => {
  // The lock-path TTL fallback when no peer hello and no sentinel were ever
  // seen: the lone starter polled until the TTL. Pins the exact "[starter]
  // synchronization has timed out" text (a regression swapping or stripping the
  // tag would be caught) and that this is a transport failure, not a usage
  // error. With Issue-1's fix the bare timeout is reached only when no sentinel
  // was tracked at exit, so this complements the stuck-joiner-at-TTL test above.
  const { client } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    pollingFrequency: 10,
    timeToLiveMs: 80,
  });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  client.list = async () => []; // empty forever: no peer, no sentinel

  const err = await conn.synchronize().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(Error);
  expect(err).not.toBeInstanceOf(UsageError);
  expect((err as Error).message).toBe(
    "[starter] synchronization has timed out",
  );
});

// --- synchronize(): empty-id hello/joining sentinels are rejected in the
// in-flight rendezvous scans (defense in depth; the entry guard already
// rejected them at entry, these cover a mid-rendezvous injection) -------------

test("synchronize() lock starter: a bare -joining.json injected mid-rendezvous does not trigger the joiner-recovery stall", async () => {
  // A `-joining.json` (empty recovered id) appearing after entry must NOT be
  // treated as a real joiner mid-arrival: the lock starter must keep polling and
  // hit the bare TTL timeout, never the bounded joiner-recovery (joinerRecoveryMs)
  // abort. Were the empty-id sentinel adopted, an injected file would force the
  // ~30 s starter stall its joinerRecoveryMs path induces. joinerRecoveryMs (30)
  // is far below the TTL (150) so a regression that adopted it would abort early
  // with the distinct stuck-joiner message instead of the bare timeout asserted
  // here.
  const { client } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    pollingFrequency: 10,
    joinerRecoveryMs: 30,
    timeToLiveMs: 150,
  });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const bareJoining = "-joining.json";
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    if (listCallCount === 1) return []; // entry: clean, this party is the starter
    // After entry, only the empty-id sentinel beside our own hello. A real
    // joiner never appears.
    return [
      { name: `${conn.id}-hello.json`, modifyTime: Date.now(), size: 0 },
      { name: bareJoining, modifyTime: Date.now(), size: 0 },
    ];
  };

  const err = await conn.synchronize().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(Error);
  expect(err).not.toBeInstanceOf(UsageError);
  // The bare timeout, proving the empty-id sentinel never started the recovery
  // window: the stuck-joiner path produces a different, distinct message.
  expect((err as Error).message).toBe(
    "[starter] synchronization has timed out",
  );
  expect((err as Error).message).not.toMatch(/recovery window/);
  expect((err as Error).message).not.toMatch(/began arriving/);
});

test("synchronize() lock starter: a bare -hello.json injected mid-rendezvous is ignored and rendezvous completes with the real joiner", async () => {
  // A `-hello.json` (empty recovered id) appearing after entry, alongside the
  // real joiner's hello, must not be counted as a peer hello: the lock starter's
  // otherFiles scan must see exactly the one real hello and complete the
  // rendezvous, recovering the real (non-empty) peer id. Were the empty-id hello
  // counted, otherFiles would hold two hellos and the >1 guard would abort with
  // "more than one peer hello" -- a planted file derailing a legitimate exchange.
  const joinerId = "00000000-0000-4000-8000-000000000001";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    pollingFrequency: 10,
    timeToLiveMs: 2_000,
  });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const joinerHello = `${joinerId}-hello.json`;
  // The joiner's hello body must read through the gate before the lock race.
  files.set(`${conn.path}/${joinerHello}`, LOCK_HELLO_BODY);
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    if (listCallCount === 1) return []; // entry: clean, this party is the starter
    // After entry: our own hello, the real joiner's hello, and an injected bare
    // `-hello.json`. Only the real joiner is a peer hello.
    return [
      { name: `${conn.id}-hello.json`, modifyTime: Date.now(), size: 0 },
      { name: joinerHello, modifyTime: Date.now(), size: 0 },
      { name: "-hello.json", modifyTime: Date.now(), size: 0 },
    ];
  };

  await conn.synchronize();

  // Completed against the real joiner; the empty-id hello was never adopted.
  expect(conn.peerId).toBe(joinerId);
});

test("synchronize() lockless mode: a bare -hello.json injected mid-rendezvous is ignored and the barrier completes with the real peer", async () => {
  // The lockless counterpart: a `-hello.json` (empty recovered id) appearing in
  // the ack-handshake barrier alongside the real peer's hello must not be counted
  // as a peer hello. The barrier must ack and complete against the real peer,
  // never committing peerId="". Were the empty-id hello counted, the barrier's
  // own >1 guard would abort with "more than one peer hello".
  const peerId = "00000000-0000-4000-8000-000000000001";
  const myId = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const { client, files } = makeMockClient();
  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 2_000),
    verbose: -1,
    locklessRendezvous: true,
  });
  conn.id = myId;
  conn.connected = true;
  conn.path = "/shared";

  const peerHello = `${peerId}-hello.json`;
  const locklessHelloBody = Buffer.from(
    JSON.stringify({ locklessRendezvous: true, retainFiles: false }),
  );
  files.set(`/shared/${peerHello}`, locklessHelloBody);
  // The peer's ack of THIS party's hello: `${peerId}-${myId}-hello-ack.json`.
  const peerAck = `${peerId}-${myId}-hello-ack.json`;

  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    if (listCallCount === 1) return []; // entry: clean, write own hello and enter the barrier
    // Barrier: our hello, the real peer hello, and an injected bare `-hello.json`.
    const base = [
      { name: `${myId}-hello.json`, modifyTime: Date.now(), size: 0 },
      { name: peerHello, modifyTime: Date.now(), size: 0 },
      { name: "-hello.json", modifyTime: Date.now(), size: 0 },
    ];
    // From the second barrier listing on, the peer's ack of our hello is visible,
    // so the barrier completes (the first barrier pass writes our ack and loops).
    if (listCallCount >= 3)
      base.push({ name: peerAck, modifyTime: Date.now(), size: 0 });
    return base;
  };

  await conn.synchronize();

  // Completed against the real peer; the empty-id hello was never adopted.
  expect(conn.peerId).toBe(peerId);
});

test("synchronize() lock starter: a peer hello alongside a foreign-id joining sentinel is a UsageError", async () => {
  // Three-party contamination: a legitimate peer hello (idB) and a joining
  // sentinel from a different id (idC) are visible together. A sentinel whose
  // id matches no peer hello cannot be the peer we are completing against, so
  // it is rejected as a usage error (exit 64) -- like a second peer hello or
  // lock -- rather than silently ignored.
  const idB = "00000000-0000-4000-8000-000000000001";
  const idC = "00000000-0000-4000-8000-000000000002";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const peerHelloName = `${idB}-hello.json`;
  const foreignSentinel = `${idC}-joining.json`;
  files.set(`${conn.path}/${peerHelloName}`, LOCK_HELLO_BODY);
  files.set(`${conn.path}/${foreignSentinel}`, LOCK_HELLO_BODY);
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    if (listCallCount === 1) return []; // preexisting guard: empty
    return [
      { name: peerHelloName, modifyTime: Date.now(), size: 0 },
      { name: foreignSentinel, modifyTime: Date.now(), size: 0 },
    ];
  };

  const err = await conn.synchronize().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(UsageError);
  expect((err as Error).message).toContain(foreignSentinel);
  expect((err as Error).message).toMatch(/matches no peer hello/);
});

test("synchronize() lock starter: a peer hello alongside the peer's own same-id sentinel completes (transient rename tolerated)", async () => {
  // On a sync-mediated transport the joiner's rename can momentarily expose
  // both `<idB>-joining.json` and `<idB>-hello.json`. That same-id sentinel is
  // the peer we are completing against, not contamination, so the starter must
  // tolerate it and finish the rendezvous rather than throw a foreign-sentinel
  // usage error.
  const idB = "00000000-0000-4000-8000-000000000001";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const peerHelloName = `${idB}-hello.json`;
  const sameSentinel = `${idB}-joining.json`;
  files.set(`${conn.path}/${peerHelloName}`, LOCK_HELLO_BODY);
  files.set(`${conn.path}/${sameSentinel}`, LOCK_HELLO_BODY);
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    if (listCallCount === 1) return []; // preexisting guard: empty
    // Both names visible together: the joiner's rename is mid-propagation.
    return [
      { name: peerHelloName, modifyTime: Date.now(), size: 0 },
      { name: sameSentinel, modifyTime: Date.now(), size: 0 },
    ];
  };

  await conn.synchronize();

  // Rendezvous completes against the peer despite the lingering same-id
  // sentinel; the starter consumed the peer hello.
  expect(conn.role).toBe("starter");
  expect(conn.peerId).toBe(idB);
  expect(files.has(`${conn.path}/${peerHelloName}`)).toBe(false);
});

test("synchronize() preexisting-file guard rejects a leftover joining sentinel at startup", async () => {
  // A `<id>-joining.json` left by a crashed prior session is rejected by the
  // strict-empty entry rule (I0) exactly like any other non-peer-hello file --
  // the sentinel needs no per-type screening (it is "anything else"). This is a
  // usage error (CLI exit 64), and the guard does not delete the stale file.
  const staleId = "00000000-0000-4000-8000-000000000001";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const staleName = `${staleId}-joining.json`;
  files.set(`${conn.path}/${staleName}`, LOCK_HELLO_BODY);
  client.list = async () => [
    { name: staleName, modifyTime: Date.now(), size: 0 },
  ];

  const err = await conn.synchronize().catch((e: unknown) => e);

  expect(err).toBeInstanceOf(UsageError);
  expect((err as Error).message).toContain(staleName);
  expect((err as Error).message).toContain("joining sentinel");
  // Not swept by the guard: the operator clears the directory after confirming
  // no live session is using it.
  expect(files.has(`${conn.path}/${staleName}`)).toBe(true);
});

test("ENOENT counter resets after a clean poll cycle, allowing a fresh set of retries", async () => {
  // Two ENOENTs (below threshold of 3), then exists() returns false (counter
  // resets), then two more ENOENTs. Four total ENOENTs — but split across two
  // groups — must never reach the threshold and must not emit an error.
  const peerId = "peer-test";
  let listCallCount = 0;
  let getCount = 0;
  const errors: unknown[] = [];

  let resolveDone!: () => void;
  // Resolves once list() is called a 6th time, confirming all 5 expected poll
  // cycles (including both ENOENT groups and the reset cycle) are done.
  const cyclesDone = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const [, logs] = await withCapturedLogs(async () => {
    const { client } = makeMockClient();
    const match = [{ name: `${peerId}-5.json`, modifyTime: 0, size: 5 }];
    client.list = async () => {
      listCallCount++;
      // Cycles 1-2: match -> ENOENT on get (count reaches 2, below threshold 3)
      // Cycle 3: empty -> clean poll, counter resets to 0
      // Cycles 4-5: match -> ENOENT on get (count reaches 2 again, still below 3)
      if (listCallCount === 6) resolveDone();
      return listCallCount === 1 ||
        listCallCount === 2 ||
        listCallCount === 4 ||
        listCallCount === 5
        ? match
        : [];
    };
    client.get = async (p) => {
      getCount++;
      throw Object.assign(
        new Error(`ENOENT: no such file or directory, open '${p}'`),
        { code: "ENOENT" },
      );
    };
    const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
    conn.peerId = peerId;
    conn.on("error", (err) => errors.push(err));
    conn.start();
    // Wait until the 6th exists() call confirms all 5 cycles completed;
    // fall back to a 2 s safety timeout so the test never hangs.
    await Promise.race([
      cyclesDone,
      new Promise<void>((r) => setTimeout(r, 2_000)),
    ]);
    conn.stop();
  });
  expect(logs).toHaveLength(4);
  expect(logs[0].message).toContain("disappeared between list and get");

  // 4 ENOENTs were thrown (get() called 4 times), but no single run of 3
  // consecutive ENOENTs occurred, so no error should be emitted.
  expect(getCount).toBe(4);
  expect(errors).toHaveLength(0);
});

// --- message filename format -------------------------------------------------

// Drives a poller until `signal` resolves or a safety timeout fires, then
// stops it. Keeps the message-format tests free of repeated race scaffolding.
async function runPoller(
  conn: FileSyncConnection,
  signal: Promise<void>,
): Promise<void> {
  conn.start();
  await Promise.race([signal, new Promise<void>((r) => setTimeout(r, 2_000))]);
  conn.stop();
}

test("send filename is <id>-<byteCount>.json when timestampInFilename is unset", async () => {
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client);
  conn.peerId = "stub-peer";

  await conn.send({ hello: "world" });

  const names = [...files.keys()].map((p) => p.slice("/test/".length));
  expect(names).toHaveLength(1);
  // Exactly two segments around the id: `<uuid>-<digits>.json`, no timestamp
  // or counter inserted.
  expect(names[0]).toMatch(new RegExp(`^${conn.id}-\\d+\\.json$`));
});

test("send filename encodes timestamp and zero-padded counter when timestampInFilename is true", async () => {
  const { client, files } = makeMockClient();
  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    timestampInFilename: true,
  });
  conn.connected = true;
  conn.path = "/test";
  conn.peerId = "stub-peer";

  await conn.send({ first: true });
  const firstName = [...files.keys()][0].slice("/test/".length);
  // <id>-<YYYYMMDDTHHMMSS>-<NNN>-<byteCount>.json; counter starts at 000.
  expect(firstName).toMatch(
    new RegExp(`^${conn.id}-\\d{8}T\\d{6}-000-\\d+\\.json$`),
  );
  // The last segment is the exact serialized byte count.
  const firstBuf = files.get(`/test/${firstName}`)!;
  expect(Number(firstName.slice(0, -".json".length).split("-").at(-1))).toBe(
    firstBuf.length,
  );

  // Simulate the peer consuming the first message, then send again: the
  // per-session counter advances to 001.
  files.clear();
  await conn.send({ second: true });
  const secondName = [...files.keys()][0].slice("/test/".length);
  expect(secondName).toMatch(
    new RegExp(`^${conn.id}-\\d{8}T\\d{6}-001-\\d+\\.json$`),
  );
});

test("poll waits while the file is partially synced and reads it once the size matches", async () => {
  const { client, files } = makeMockClient();
  const peerId = "peer-partial";
  const message = objectMessage({ value: 42 });
  const name = `${peerId}-${message.length}.json`;
  const fullPath = `/test/${name}`;

  let listCount = 0;
  client.list = async () => {
    listCount++;
    // First two cycles: the file is present but not fully synced. It reports a
    // smaller size and is deliberately absent from the store, so any premature
    // get() would throw "not found" and surface as an error below.
    if (listCount <= 2)
      return [{ name, modifyTime: 0, size: message.length - 5 }];
    files.set(fullPath, message);
    return [{ name, modifyTime: 0, size: message.length }];
  };

  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.peerId = peerId;

  const received: unknown[] = [];
  const errors: unknown[] = [];
  let notifyReceived!: () => void;
  const delivered = new Promise<void>((r) => (notifyReceived = r));
  conn.on("data", (msg) => {
    received.push(msg);
    notifyReceived();
  });
  conn.on("error", (err) => errors.push(err));

  await runPoller(conn, delivered);

  expect(errors).toHaveLength(0);
  expect(received).toHaveLength(1);
  expect((received[0] as Record<string, unknown>)["value"]).toBe(42);
  // The reader did not act on either partial-sync cycle.
  expect(listCount).toBeGreaterThanOrEqual(3);
});

test("poll ignores message files belonging to a different peer", async () => {
  const { client } = makeMockClient();
  const peerId = "peer-a";

  let listCount = 0;
  let notifyEnough!: () => void;
  const enoughCycles = new Promise<void>((r) => (notifyEnough = r));
  // Only a different peer's message file is present; it pattern-matches
  // `*-<count>.json` but not our peer-scoped `<peerId>-` prefix.
  client.list = async () => {
    listCount++;
    if (listCount >= 4) notifyEnough();
    return [{ name: "peer-b-7.json", modifyTime: 0, size: 7 }];
  };
  let getCalled = false;
  client.get = async () => {
    getCalled = true;
    return Buffer.alloc(0) as Buffer<ArrayBufferLike>;
  };

  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.peerId = peerId;
  // This test isolates message-routing: a different peer's message file
  // (`peer-b-*`) must never be consumed as ours. Under the default policy that
  // file is now also flagged as a foreign file (another session sharing the
  // path); pin `ignore` so this test exercises the routing exclusion alone --
  // the foreign-file detection is covered by its own tests below.
  conn.options.unexpectedFiles = "ignore";

  const received: unknown[] = [];
  const errors: unknown[] = [];
  conn.on("data", (msg) => received.push(msg));
  conn.on("error", (err) => errors.push(err));

  await runPoller(conn, enoughCycles);

  expect(getCalled).toBe(false);
  expect(received).toHaveLength(0);
  expect(errors).toHaveLength(0);
});

test("poll extracts the byte count from the last segment when the filename has many segments", async () => {
  const { client, files } = makeMockClient();
  // A peer id containing hyphens plus an inserted timestamp and counter: the
  // right-anchored parse must still read the byte count from the final segment.
  const peerId = "00000000-0000-4000-8000-000000000abc";
  const message = objectMessage({ ok: true }, 7);
  const name = `${peerId}-20260529T142301-007-${message.length}.json`;
  files.set(`/test/${name}`, message);

  client.list = async () => [{ name, modifyTime: 0, size: message.length }];

  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.peerId = peerId;

  const received: unknown[] = [];
  const errors: unknown[] = [];
  let notifyReceived!: () => void;
  const delivered = new Promise<void>((r) => (notifyReceived = r));
  conn.on("data", (msg) => {
    received.push(msg);
    notifyReceived();
  });
  conn.on("error", (err) => errors.push(err));

  await runPoller(conn, delivered);

  expect(errors).toHaveLength(0);
  expect(received).toHaveLength(1);
  expect((received[0] as Record<string, unknown>)["ok"]).toBe(true);
});

test("poll under the ignore policy skips a prefix-matching file whose final segment is not a byte count", async () => {
  // A leftover or foreign file sharing the peer's id prefix but not encoding a
  // byte count (e.g. `<peerId>-backup.json`) is not routed as a message. Under
  // the post-entry policy it is now a foreign file (terminal under the default
  // `error`); the `ignore` policy preserves the previous silent-skip behavior,
  // which this test pins. The real message alongside it is still delivered.
  const { client, files } = makeMockClient();
  const peerId = "peer-leftover";
  const message = objectMessage({ ok: true });
  files.set(`/test/${peerId}-${message.length}.json`, message);
  files.set(`/test/${peerId}-backup.json`, Buffer.from("not a message"));

  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.peerId = peerId;
  conn.options.unexpectedFiles = "ignore";

  const received: unknown[] = [];
  const errors: unknown[] = [];
  let notifyReceived!: () => void;
  const delivered = new Promise<void>((r) => (notifyReceived = r));
  conn.on("data", (msg) => {
    received.push(msg);
    notifyReceived();
  });
  conn.on("error", (err) => errors.push(err));

  await runPoller(conn, delivered);

  expect(errors).toHaveLength(0);
  expect(received).toHaveLength(1);
  expect((received[0] as Record<string, unknown>)["ok"]).toBe(true);
  // The non-message file is left untouched, not deleted or read.
  expect(files.has(`/test/${peerId}-backup.json`)).toBe(true);
});

// --- drain-before-cleanup (terminal-frame race regression) -------------------

test("close() drains the last sent file before cleanup, preventing premature deletion of the terminal frame", async () => {
  // Regression guard for the file-sync terminal-frame race: the sender's
  // close() must not call safeDelete on the last sent file until the peer has
  // consumed it (i.e. the file has disappeared from the directory listing).
  // Without the drain, cleanup() runs immediately after stop(), deleting the
  // file before a slow receiver's next poll.

  const { client, files } = makeMockClient();

  let receiverConsumed = false;
  let deletedBeforeConsumed = false;

  const sender = await makeConnectedConn(client, {
    pollingFrequency: 5,
    peerTimeoutMs: 500,
  });
  sender.peerId = "stub-peer";

  // Intercept safeDelete to record whether cleanup races the receiver.
  const origSafeDelete = client.safeDelete.bind(client);
  client.safeDelete = async (path: string) => {
    if (!receiverConsumed && /\/[^/]+-\d+\.json$/.test(path)) {
      deletedBeforeConsumed = true;
    }
    return origSafeDelete(path);
  };

  await sender.send({ terminal: true });

  // Identify the written message file.
  const msgPath = [...files.keys()].find((p) =>
    new RegExp(`^/test/${sender.id}-\\d+\\.json$`).test(p),
  );
  expect(msgPath).toBeDefined();

  // Kick off close() - the drain holds cleanup until the file disappears.
  const closePromise = sender.close();

  // Let the drain poll at least once (pollingFrequency = 5 ms) before the
  // "receiver" consumes the file.
  await new Promise((r) => setTimeout(r, 20));

  // Simulate receiver consuming the terminal frame.
  receiverConsumed = true;
  files.delete(msgPath!);

  await closePromise;

  expect(deletedBeforeConsumed).toBe(false);
});

test("close() emits an info log at drain entry when the last sent file is still present", async () => {
  // Verifies the info-level breadcrumb added so an operator running at default
  // verbosity (verbose:0 = INFO) can tell close() is in a non-trivial drain
  // rather than hanging. The file is consumed before the deadline so only the
  // entry log appears, not the deadline-fired log.
  const prevLevel = logLibrary.getLevel();
  logLibrary.setLevel("info");
  let capturedOutName = "";
  try {
    const { client, files } = makeMockClient();
    const [, logs] = await withCapturedLogs(
      async () => {
        const conn = new FileSyncConnection(client, {
          pollingFrequency: 5,
          verbose: 0,
        });
        await conn.open({
          channel: "filedrop",
          path: "/test",
          options: { peerTimeoutMs: 500 },
        });
        conn.peerId = "stub-peer";

        const outName = `${conn.id}-99.json`;
        capturedOutName = outName;
        files.set(`/test/${outName}`, Buffer.from("{}"));
        (conn as unknown as { lastSentFile?: string }).lastSentFile = outName;

        // Remove the file after 30 ms so close() finishes well before the deadline.
        setTimeout(() => files.delete(`/test/${outName}`), 30);

        await conn.close();
      },
      (level) => level === "INFO",
    );

    const entryLog = logs.find(
      (l) => l.level === "INFO" && l.message.includes("close: waiting up to"),
    );
    expect(entryLog).toBeDefined();
    expect(entryLog!.message).toContain("500 ms");
    expect(entryLog!.message).toContain(capturedOutName);
    // File was consumed before the deadline; no deadline-fired log.
    expect(logs.some((l) => l.message.includes("drain deadline reached"))).toBe(
      false,
    );
  } finally {
    logLibrary.setLevel(prevLevel);
  }
});

test("close() emits an info log when the drain deadline fires", async () => {
  // Verifies the info-level breadcrumb added so an operator can distinguish a
  // completed (peer consumed the terminal frame) close from a timed-out one that
  // deleted the frame as a fallback. The file is never consumed here, so close()
  // runs to the deadline and both the entry and deadline logs appear.
  const prevLevel = logLibrary.getLevel();
  logLibrary.setLevel("info");
  let capturedOutName = "";
  try {
    const { client, files } = makeMockClient();
    const [, logs] = await withCapturedLogs(
      async () => {
        const conn = new FileSyncConnection(client, {
          pollingFrequency: 5,
          verbose: 0,
        });
        await conn.open({
          channel: "filedrop",
          path: "/test",
          options: { peerTimeoutMs: 50 },
        });
        conn.peerId = "stub-peer";

        const outName = `${conn.id}-99.json`;
        capturedOutName = outName;
        files.set(`/test/${outName}`, Buffer.from("{}"));
        (conn as unknown as { lastSentFile?: string }).lastSentFile = outName;

        // Never delete the file; close() will time out and delete as fallback.
        await conn.close();
      },
      (level) => level === "INFO",
    );

    const entryLog = logs.find(
      (l) => l.level === "INFO" && l.message.includes("close: waiting up to"),
    );
    expect(entryLog).toBeDefined();
    expect(entryLog!.message).toContain("50 ms");
    expect(entryLog!.message).toContain(capturedOutName);

    const deadlineLog = logs.find(
      (l) => l.level === "INFO" && l.message.includes("drain deadline reached"),
    );
    expect(deadlineLog).toBeDefined();
    expect(deadlineLog!.message).toContain("50 ms");
    expect(deadlineLog!.message).toContain(capturedOutName);
  } finally {
    logLibrary.setLevel(prevLevel);
  }
});

test("close() does not emit the deadline log when the final poll observes the file consumed at/after the deadline", async () => {
  // Teeth for the deadline-log gate: it must key on the LAST OBSERVED presence,
  // not the clock. A clock-only check (`Date.now() >= deadline`) mislabels a
  // clean drain whose final filePresent() returned "absent" at/after the
  // deadline as a fallback-delete timeout. That straddle is a sub-millisecond
  // boundary with real timers (each list() is budgeted to exactly the time left
  // to the deadline, so a late return is pre-empted into the catch), so this
  // forces it with fake timers: setSystemTime() advances Date.now() past the
  // deadline WITHOUT firing the unref'd budget setTimeout (which advanceTimers
  // would), leaving the mocked list() to resolve "consumed" on a microtask that
  // still wins the budget race. The drain then exits via filePresent()===false
  // with Date.now() past the deadline -- the exact case a clock-only gate gets
  // wrong.
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const prevLevel = logLibrary.getLevel();
  logLibrary.setLevel("info");
  try {
    const { client, files } = makeMockClient();
    const [, logs] = await withCapturedLogs(
      async () => {
        const conn = new FileSyncConnection(client, {
          pollingFrequency: 5,
          verbose: 0,
        });
        await conn.open({
          channel: "filedrop",
          path: "/test",
          options: { peerTimeoutMs: 1000 },
        });
        conn.peerId = "stub-peer";

        const outName = `${conn.id}-99.json`;
        files.set(`/test/${outName}`, Buffer.from("{}"));
        (conn as unknown as { lastSentFile?: string }).lastSentFile = outName;

        // First list() (the entry filePresent at deadline-time 0) surfaces the
        // file; the second (first loop poll) jumps the clock past the 1000 ms
        // deadline, then reports the file consumed. setSystemTime moves Date.now()
        // only -- it does not fire the budget timer -- so the list resolves
        // "absent" rather than the budget rejecting.
        let listCalls = 0;
        client.list = async () => {
          listCalls++;
          if (listCalls === 1)
            return [{ name: outName, modifyTime: 0, size: 2 }];
          vi.setSystemTime(1001);
          return [];
        };

        await conn.close();
      },
      (level) => level === "INFO",
    );

    // The entry log still fires (file present at entry), but the deadline log
    // must NOT: the peer's consumption was observed, so this was a clean drain.
    expect(logs.some((l) => l.message.includes("close: waiting up to"))).toBe(
      true,
    );
    expect(logs.some((l) => l.message.includes("drain deadline reached"))).toBe(
      false,
    );
  } finally {
    logLibrary.setLevel(prevLevel);
    vi.useRealTimers();
  }
});

test("close() drain is bounded by the fixed terminal-frame budget, not the full peer timeout", async () => {
  // The teardown drain must NOT inherit the (default one-hour) peer-inactivity
  // budget: at close() the result is already persisted and cleanup() deletes the
  // frame as a fallback, so the drain is bounded by TERMINAL_FRAME_DRAIN_TIMEOUT_MS
  // (min'd with the configured peer budget). With a peer budget far larger than
  // that constant, the bound named at drain entry is the constant -- proving the
  // cap. Teeth: the prior code interpolated the full peerTimeoutMs here, so this
  // would read the one-hour value and fail.
  const hugePeerTimeoutMs = 60 * 60 * 1000; // one hour, > the fixed drain budget
  expect(hugePeerTimeoutMs).toBeGreaterThan(TERMINAL_FRAME_DRAIN_TIMEOUT_MS);
  const prevLevel = logLibrary.getLevel();
  logLibrary.setLevel("info");
  try {
    const { client, files } = makeMockClient();
    const [, logs] = await withCapturedLogs(
      async () => {
        const conn = new FileSyncConnection(client, {
          pollingFrequency: 5,
          verbose: 0,
        });
        await conn.open({
          channel: "filedrop",
          path: "/test",
          options: { peerTimeoutMs: hugePeerTimeoutMs },
        });
        conn.peerId = "stub-peer";

        const outName = `${conn.id}-99.json`;
        files.set(`/test/${outName}`, Buffer.from("{}"));
        (conn as unknown as { lastSentFile?: string }).lastSentFile = outName;

        // Consume shortly after entry so the test never actually waits the bound.
        setTimeout(() => files.delete(`/test/${outName}`), 20);

        await conn.close();
      },
      (level) => level === "INFO",
    );

    const entryLog = logs.find((l) =>
      l.message.includes("close: waiting up to"),
    );
    expect(entryLog).toBeDefined();
    expect(entryLog!.message).toContain(
      `${TERMINAL_FRAME_DRAIN_TIMEOUT_MS} ms`,
    );
    expect(entryLog!.message).not.toContain(`${hugePeerTimeoutMs} ms`);
  } finally {
    logLibrary.setLevel(prevLevel);
  }
});

// --- synchronize(): unconditional hello rename --------------------------------

test("synchronize() lock path writes hello as <id>-hello.json and self-hello detection still works", async () => {
  // Regression guard: the unconditional hello rename must not break the
  // self-hello filter inside waitForPeer (the pair of checks that prevents a
  // party from treating its own hello as the peer's).
  const peerId = "00000000-0000-4000-8000-000000000001";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const myId = conn.id;
  const myHelloName = `${myId}-hello.json`;
  const peerHelloName = `${peerId}-hello.json`;

  const mtime = Date.now();
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    if (listCallCount === 1) return [];
    return [
      { name: myHelloName, modifyTime: mtime, size: 0 },
      { name: peerHelloName, modifyTime: mtime, size: 0 },
    ];
  };
  // Peer hello body so the two-hellos read gate passes before createExclusive.
  files.set(`${conn.path}/${peerHelloName}`, LOCK_HELLO_BODY);

  await conn.synchronize();

  // The lock-race winner (this conn: lock created by createExclusive)
  // committed peerId correctly from the -hello.json filename.
  expect(conn.peerId).toBe(peerId);
  expect(conn.handshakeRole).toBe("initiator");
  // Our hello is named with the new convention and was written to the store.
  const helloInStore = [...files.keys()].find((p) =>
    p.endsWith(`/${myHelloName}`),
  );
  expect(helloInStore).toBeDefined();
});

// --- synchronize(): lockless mode ---------------------------------------------

test("synchronize() lockless mode completes rendezvous when createExclusive and delete both throw", async () => {
  // Robustness proof: the ack-handshake barrier must complete rendezvous even
  // when createExclusive and delete both throw. This is the most extreme
  // constraint possible and is here to prove the protocol is sound under it.
  // Real lockless deployments target sync-mediated transports where
  // createExclusive lacks atomicity or deletion has high propagation latency
  // -- delete itself works, just asynchronously. Cleanup therefore succeeds
  // eventually on real transports; the pure no-op safeDelete here is not
  // representative of a real storage backend.
  const idA = "00000000-0000-4000-8000-000000000001"; // sorts lower
  const idB = "ffffffff-ffff-4fff-bfff-ffffffffffff"; // sorts higher

  const sharedFiles = new Map<string, Buffer>();

  const makeThrowingClient = (): FileTransportClient => ({
    connect: async () => {},
    end: async () => {},
    list: async (dir: string): Promise<FileInfo[]> => {
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      return [...sharedFiles.entries()]
        .filter(
          ([p]) =>
            p.startsWith(prefix) && !p.slice(prefix.length).includes("/"),
        )
        .map(([p, buf]) => ({
          name: p.slice(prefix.length),
          modifyTime: 0,
          size: buf.length,
        }));
    },
    get: async (path: string) => {
      const data = sharedFiles.get(path);
      if (!data) throw new Error(`${path}: not found`);
      return data as Buffer<ArrayBufferLike>;
    },
    put: async (
      src: string | Buffer | Uint8Array[] | NodeJS.ReadableStream,
      dest: string,
    ) => {
      sharedFiles.set(dest, await putSrcBytes(src));
    },
    delete: async () => {
      throw new Error("delete not supported on this transport");
    },
    safeDelete: async () => {
      // Swallow silently: transport cannot delete.
    },
    rename: async (from: string, to: string) => {
      const data = sharedFiles.get(from);
      if (data === undefined) throw new Error(`${from}: no such file`);
      sharedFiles.delete(from);
      sharedFiles.set(to, data);
    },
    createExclusive: async () => {
      throw new Error("createExclusive not supported on this transport");
    },
    exists: async (path: string) => sharedFiles.has(path),
  });

  const connA = new FileSyncConnection(makeThrowingClient(), {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    locklessRendezvous: true,
  });
  connA.id = idA;
  connA.connected = true;
  connA.path = "/shared";

  const connB = new FileSyncConnection(makeThrowingClient(), {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    locklessRendezvous: true,
  });
  connB.id = idB;
  connB.connected = true;
  connB.path = "/shared";

  await Promise.all([connA.synchronize(), connB.synchronize()]);

  // Both parties must be synchronized.
  expect(connA.peerId).toBe(idB);
  expect(connB.peerId).toBe(idA);
});

test("synchronize() lockless mode role assignment matches the lexicographic rule for the same id pair as the lock path", async () => {
  // Role must be determined by lexicographic id order regardless of arrival
  // timing. The throwing delete/createExclusive is robustness scaffolding
  // (see the previous test); real lockless transports support delete.
  const idA = "00000000-0000-4000-8000-000000000001";
  const idB = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const sharedFiles = new Map<string, Buffer>();

  const makeClient = (): FileTransportClient => ({
    connect: async () => {},
    end: async () => {},
    list: async (dir: string): Promise<FileInfo[]> => {
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      return [...sharedFiles.entries()]
        .filter(
          ([p]) =>
            p.startsWith(prefix) && !p.slice(prefix.length).includes("/"),
        )
        .map(([p, buf]) => ({
          name: p.slice(prefix.length),
          modifyTime: 0,
          size: buf.length,
        }));
    },
    get: async (path: string) => {
      const data = sharedFiles.get(path);
      if (!data) throw new Error(`${path}: not found`);
      return data as Buffer<ArrayBufferLike>;
    },
    put: async (
      src: string | Buffer | Uint8Array[] | NodeJS.ReadableStream,
      dest: string,
    ) => {
      sharedFiles.set(dest, await putSrcBytes(src));
    },
    delete: async () => {
      throw new Error("delete not supported");
    },
    safeDelete: async () => {},
    rename: async (from: string, to: string) => {
      const data = sharedFiles.get(from);
      if (!data) throw new Error(`${from}: no such file`);
      sharedFiles.delete(from);
      sharedFiles.set(to, data);
    },
    createExclusive: async () => {
      throw new Error("not supported");
    },
    exists: async (path: string) => sharedFiles.has(path),
  });

  const connA = new FileSyncConnection(makeClient(), {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    locklessRendezvous: true,
  });
  connA.id = idA;
  connA.connected = true;
  connA.path = "/shared";

  const connB = new FileSyncConnection(makeClient(), {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    locklessRendezvous: true,
  });
  connB.id = idB;
  connB.connected = true;
  connB.path = "/shared";

  await Promise.all([connA.synchronize(), connB.synchronize()]);

  // idA < idB: A arrived "first" by lexicographic order.
  expect(connA.handshakeRole).toBe("responder");
  expect(connA.role).toBe("starter");
  expect(connB.handshakeRole).toBe("initiator");
  expect(connB.role).toBe("joiner");
});

test("synchronize() lockless mode joiner fast-path is skipped; lockless barrier is entered even with peer hello already present", async () => {
  // The throwing delete proves the joiner fast-path (which calls delete) is
  // not taken in lockless mode. The no-op safeDelete is robustness scaffolding
  // only; real lockless transports support delete (see the first lockless test).
  //
  // When locklessRendezvous is set and a party's entry list() (or barrier loop)
  // finds the peer's hello, it must NOT take the joiner shortcut (which would
  // call delete(peer hello), unsupported on a lockless transport). It must
  // write its own hello and enter the lockless ack-handshake barrier instead.
  //
  // Both parties start against an empty directory and run concurrently: each
  // writes its own hello during its own synchronize() and the slower-to-list
  // party sees the peer hello already present, exercising the "peer hello
  // already present" path. A's hello is deliberately NOT pre-planted -- a
  // party's own hello never predates its own synchronize() (it would be a
  // self-hello and rejected by the entry precondition).
  const idA = "00000000-0000-4000-8000-000000000001";
  const idB = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const sharedFiles = new Map<string, Buffer>();

  let deleteCalled = false;
  const makeClient = (): FileTransportClient => ({
    connect: async () => {},
    end: async () => {},
    list: async (dir: string): Promise<FileInfo[]> => {
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      return [...sharedFiles.entries()]
        .filter(
          ([p]) =>
            p.startsWith(prefix) && !p.slice(prefix.length).includes("/"),
        )
        .map(([p, buf]) => ({
          name: p.slice(prefix.length),
          modifyTime: 0,
          size: buf.length,
        }));
    },
    get: async (path: string) => {
      const data = sharedFiles.get(path);
      if (!data) throw new Error(`${path}: not found`);
      return data as Buffer<ArrayBufferLike>;
    },
    put: async (
      src: string | Buffer | Uint8Array[] | NodeJS.ReadableStream,
      dest: string,
    ) => {
      sharedFiles.set(dest, await putSrcBytes(src));
    },
    delete: async () => {
      deleteCalled = true;
      throw new Error("delete not supported");
    },
    safeDelete: async () => {},
    rename: async (from: string, to: string) => {
      const data = sharedFiles.get(from);
      if (!data) throw new Error(`${from}: no such file`);
      sharedFiles.delete(from);
      sharedFiles.set(to, data);
    },
    createExclusive: async () => {
      throw new Error("createExclusive not supported");
    },
    exists: async (path: string) => sharedFiles.has(path),
  });

  const connA = new FileSyncConnection(makeClient(), {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    locklessRendezvous: true,
  });
  connA.id = idA;
  connA.connected = true;
  connA.path = "/shared";

  const connB = new FileSyncConnection(makeClient(), {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    locklessRendezvous: true,
  });
  connB.id = idB;
  connB.connected = true;
  connB.path = "/shared";

  // Run A and B concurrently against the empty directory: each writes its own
  // hello and enters the lockless barrier, and the slower-to-list party sees
  // the peer hello already present.
  await Promise.all([connA.synchronize(), connB.synchronize()]);

  // Neither party should have called delete (unsupported on lockless transport).
  expect(deleteCalled).toBe(false);
  // Both are synchronized.
  expect(connA.peerId).toBe(idB);
  expect(connB.peerId).toBe(idA);
  // Lockless never deletes a hello: both remain in the directory.
  expect(sharedFiles.has(`/shared/${idA}-hello.json`)).toBe(true);
  expect(sharedFiles.has(`/shared/${idB}-hello.json`)).toBe(true);
});

// --- send(): hasOutstandingMessage excludes typed protocol files ---------------

test("send() completes without spinning when a <id>-hello.json file is present in the store", async () => {
  // Regression guard: the drain waits only for the exact lastSentFile, which is
  // undefined on this first send, so a pre-existing own <id>-hello.json must not
  // block send(). (Under the old grammar-glob drain this required a
  // parseMessageByteCount carve-out; exact-name matching ignores it for free.)
  // Verify send() completes immediately instead of spinning.
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client);
  conn.peerId = "stub-peer";

  // Plant the hello file as it would appear after synchronize().
  const helloPath = `/test/${conn.id}-hello.json`;
  files.set(helloPath, Buffer.alloc(0));

  // send() must complete without looping on the hello file.
  await expect(conn.send({ check: true })).resolves.toBeUndefined();

  // The hello file must still be present (send() is not responsible for it).
  expect(files.has(helloPath)).toBe(true);
});

test("send() completes without spinning on a foreign <thisId>-<digits>.json (site-4 residual)", async () => {
  // A foreign/stray file carrying this party's own id and a numeric terminal
  // (a sync-tool artifact, or a leftover the peer never sent) matches the
  // message grammar. The old hasOutstandingMessage glob counted it as an
  // unconsumed own-message and span send() to the peer timeout. The drain now
  // waits for the EXACT lastSentFile -- undefined on the first send -- so send()
  // completes and leaves the foreign file untouched.
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    pollingFrequency: 10,
    timeToLiveMs: 200, // a regression fails fast here instead of hanging the run
  });
  conn.peerId = "stub-peer";

  const foreignPath = `/test/${conn.id}-99.json`;
  files.set(foreignPath, Buffer.from("not ours"));

  await expect(conn.send({ check: true })).resolves.toBeUndefined();

  // send() does not own the foreign file and must leave it in place.
  expect(files.has(foreignPath)).toBe(true);
});

test("send() is not blocked by a <id>-joining.json sentinel", async () => {
  // The joining sentinel shares the `<id>-` prefix and `.json` extension, so a
  // broad own-prefix scan could mistake it for an outstanding message. The drain
  // waits only for the exact lastSentFile (undefined here), so the sentinel is
  // ignored. Were it counted, send() would spin until the peer timeout.
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client);
  conn.peerId = "stub-peer";

  // Plant a sentinel under this party's own id, as a crashed prior arrival
  // would leave it.
  const joiningPath = `/test/${conn.id}-joining.json`;
  files.set(joiningPath, LOCK_HELLO_BODY);

  await expect(conn.send({ check: true })).resolves.toBeUndefined();

  // send() does not own the sentinel and must not have consumed it.
  expect(files.has(joiningPath)).toBe(true);
});

test("a <a>-<b>-lock.json tiebreaker is not mistaken for a message by poll() or send()", async () => {
  // The lock tiebreaker is a `.json` control file (`<peer1>-<peer2>-lock.json`),
  // so unlike a by-extension control name it reaches the `.json`-gated scans in
  // send()'s hasOutstandingMessage and in poll(). It must not be treated as a
  // message in either: poll() excludes it by its non-numeric terminal token
  // `lock` (grammar), and the send drain ignores it by waiting only for the
  // exact lastSentFile. A by-extension control name never reached these scans,
  // so this path had no prior coverage.
  const { client, files } = makeMockClient();
  const peerId = "peer-a";
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = "self-b";
  conn.peerId = peerId;

  // (1) hasOutstandingMessage (in send()) must not count a lock file we own.
  // `<myId>-<peerId>-lock.json` shares our `<id>-` prefix and `.json` extension,
  // so a bare prefix glob would mistake it for an unconsumed message and spin
  // send() until the peer timeout; the drain waits only for the exact
  // lastSentFile (undefined here), so it is ignored.
  const ourLockPath = `/test/${conn.id}-${peerId}-lock.json`;
  files.set(ourLockPath, Buffer.alloc(0));
  await expect(conn.send({ check: true })).resolves.toBeUndefined();
  // send() does not own the lock file and must leave it in place.
  expect(files.has(ourLockPath)).toBe(true);

  // (2) poll() must ignore a peer-prefixed lock file, delivering only the real
  // message. `<peerId>-<myId>-lock.json` matches the peer scan's prefix and
  // `.json` extension but its terminal `lock` token is non-numeric.
  const peerLockPath = `/test/${peerId}-${conn.id}-lock.json`;
  files.set(peerLockPath, Buffer.alloc(0));
  const message = objectMessage({ ok: true });
  files.set(`/test/${peerId}-${message.length}.json`, message);

  const received: unknown[] = [];
  const errors: unknown[] = [];
  let notifyReceived!: () => void;
  const delivered = new Promise<void>((r) => (notifyReceived = r));
  conn.on("data", (msg) => {
    received.push(msg);
    notifyReceived();
  });
  conn.on("error", (err) => errors.push(err));

  await runPoller(conn, delivered);

  expect(errors).toHaveLength(0);
  expect(received).toHaveLength(1);
  expect((received[0] as Record<string, unknown>)["ok"]).toBe(true);
  // The lock file is a control file: poll() neither reads nor deletes it.
  expect(files.has(peerLockPath)).toBe(true);
});

test("synchronize() lockless timeout message carries no role prefix", async () => {
  // The lockless-barrier timeout fires while the role is genuinely indeterminate
  // (it can occur after the peer hello was seen and acked, where filename order
  // may make this party the joiner), so the message has no [role] prefix --
  // unlike the lock TTL fallback, which is reachable only as the lone starter.
  // Pins the exact bare "synchronization has timed out" text.
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 80),
    verbose: -1,
    locklessRendezvous: true,
  });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  conn.connected = true;
  conn.path = "/test";
  client.list = async () => []; // never a peer hello: barrier loops to the TTL

  const err = await conn.synchronize().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(Error);
  expect(err).not.toBeInstanceOf(UsageError);
  expect((err as Error).message).toBe("synchronization has timed out");
});

test("synchronize() lockless mode throws when more than one peer hello is detected during the poll loop", async () => {
  // Regression guard for the multi-peer-hello guard added to the lockless
  // loop: mirrors the lock path's otherFiles.length > 1 check and catches a
  // third party that slipped in after the initial synchronize() guard.
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    locklessRendezvous: true,
  });
  conn.id = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  conn.connected = true;
  conn.path = "/test";

  const peerId1 = "00000000-0000-4000-8000-000000000001";
  const peerId2 = "00000000-0000-4000-8000-000000000002";
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    if (listCallCount === 1) return []; // initial synchronize() guard: clean
    // Second call (inside waitForPeer): two peer hellos are present.
    return [
      { name: `${conn.id}-hello.json`, modifyTime: 0, size: 0 },
      { name: `${peerId1}-hello.json`, modifyTime: 0, size: 0 },
      { name: `${peerId2}-hello.json`, modifyTime: 0, size: 0 },
    ];
  };

  await expect(conn.synchronize()).rejects.toThrow(/more than one peer hello/);
});

// --- peerId: construction and open() ----------------------------------------

test("unconfigured id falls back to UUID v4 format", () => {
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, { verbose: -1 });
  expect(conn.id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});

test("peerId from constructor option sets this.id and appears in message filenames", async () => {
  const { client, files } = makeMockClient();
  const conn = new FileSyncConnection(client, {
    verbose: -1,
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    peerId: "agency-a",
  });
  await conn.open({
    channel: "filedrop",
    path: "/test",
    options: { peerTimeoutMs: 50 },
  });
  expect(conn.id).toBe("agency-a");
  conn.peerId = "stub-peer";
  await conn.send({ hello: 1 });
  const messageFile = [...files.keys()].find((p) =>
    /\/test\/agency-a-\d+\.json$/.test(p),
  );
  expect(messageFile).toBeDefined();
});

test("peerId from open() config sets this.id and appears in message filenames", async () => {
  const { client, files } = makeMockClient();
  const conn = new FileSyncConnection(client, {
    verbose: -1,
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
  });
  await conn.open({
    channel: "filedrop",
    path: "/test",
    options: { peerTimeoutMs: 50, peerId: "agency-b" },
  });
  expect(conn.id).toBe("agency-b");
  conn.peerId = "stub-peer";
  await conn.send({ hello: 1 });
  const messageFile = [...files.keys()].find((p) =>
    /\/test\/agency-b-\d+\.json$/.test(p),
  );
  expect(messageFile).toBeDefined();
});

// --- peerId: prefix-at-dash guard --------------------------------------------

test("synchronize() joiner branch rejects a prefix-at-dash id pair", async () => {
  // "site-2".startsWith("site-") is true, so the pair is rejected.
  const myId = "site-2";
  const peerId = "site";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = myId;

  const peerHelloName = `${peerId}-hello.json`;
  files.set(`${conn.path}/${peerHelloName}`, LOCK_HELLO_BODY);
  client.list = async () => [
    { name: peerHelloName, modifyTime: Date.now(), size: 0 },
  ];

  const err = await conn.synchronize().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).toContain("'-' boundary");
  // Connection must stay unsynchronized so a retry is not blocked.
  expect(conn.peerId).toBeUndefined();
  // Our hello must have been deleted so a retry does not find a stale file.
  expect(files.has(`${conn.path}/${myId}-hello.json`)).toBe(false);
});

test("synchronize() lock-detection branch rejects a prefix-at-dash id pair", async () => {
  // "site-2-hello.json" < "site-hello.json" (because '2' < 'h'), so myId
  // ("site-2") arrived first; lock name is "site-2-site-lock.json".
  const myId = "site-2";
  const peerId = "site";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = myId;

  const myHelloName = `${myId}-hello.json`;
  const peerHelloName = `${peerId}-hello.json`;
  const lockName = `${myId}-${peerId}-lock.json`;
  const lockPath = `${conn.path}/${lockName}`;

  files.set(`${conn.path}/${myHelloName}`, Buffer.alloc(0));
  files.set(`${conn.path}/${peerHelloName}`, LOCK_HELLO_BODY);
  files.set(lockPath, Buffer.alloc(0));

  const mtime = Date.now();
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    if (listCallCount === 1) return [];
    return [
      { name: myHelloName, modifyTime: mtime, size: 0 },
      { name: peerHelloName, modifyTime: mtime, size: 0 },
      { name: lockName, modifyTime: mtime, size: 0 },
    ];
  };

  await expect(conn.synchronize()).rejects.toThrow("'-' boundary");
  // peerId must be reset so a retry is not blocked by "already synchronized".
  expect(conn.peerId).toBeUndefined();
});

test("synchronize() joiner branch accepts shared-prefix ids that are not prefix-at-dash", async () => {
  // "agency-a" and "agency-b" share the "agency" prefix but neither is the
  // other extended by "-", so the pair is valid.
  const myId = "agency-b";
  const peerId = "agency-a";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = myId;

  const peerHelloName = `${peerId}-hello.json`;
  files.set(`${conn.path}/${peerHelloName}`, LOCK_HELLO_BODY);
  client.list = async () => [
    { name: peerHelloName, modifyTime: Date.now(), size: 0 },
  ];

  await conn.synchronize();
  expect(conn.peerId).toBe(peerId);
});

test("synchronize() joiner branch accepts space-containing ids", async () => {
  const myId = "Agency B";
  const peerId = "Agency A";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = myId;

  const peerHelloName = `${peerId}-hello.json`;
  files.set(`${conn.path}/${peerHelloName}`, LOCK_HELLO_BODY);
  client.list = async () => [
    { name: peerHelloName, modifyTime: Date.now(), size: 0 },
  ];

  await conn.synchronize();
  expect(conn.peerId).toBe(peerId);
});

// --- UsageError taxonomy -------------------------------------------------------

test("synchronize() throws UsageError for multiple concurrent sessions detected in lock-race path", async () => {
  // Trigger the "more than one peer hello" guard inside waitForPeer(). The
  // initial list() returns empty (passes the preexisting check); subsequent
  // calls return our own hello plus two peer hellos, simulating a third party
  // joining the same directory mid-rendezvous.
  const { client } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  const myHello = `${conn.id}-hello.json`;
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    if (listCallCount === 1) return []; // preexisting check: empty
    return [
      { name: myHello, modifyTime: 0, size: 0 },
      { name: "peer-aaa-hello.json", modifyTime: 0, size: 0 },
      { name: "peer-bbb-hello.json", modifyTime: 0, size: 0 },
    ];
  };
  // put() must succeed (writing our hello); delete/safeDelete are no-ops.
  client.put = async () => {};
  client.safeDelete = async () => {};
  await expect(conn.synchronize()).rejects.toBeInstanceOf(UsageError);
});

test("synchronize() throws UsageError for more than one joining sentinel in the lock-race path", async () => {
  // Parity with the multi-peer-hello guard for the new control file. Exactly
  // one sentinel is the only valid mid-arrival state (one joiner, one starter,
  // and the starter writes no sentinel), so two simultaneous sentinels are
  // directory contamination from a third party and must be rejected the same
  // way -- not silently timed against joiningFiles[0]. The initial list() is
  // empty (passes the preexisting check); subsequent calls return our own hello
  // plus two distinct sentinels, so otherFiles is empty and the joiningFiles
  // guard fires.
  const { client } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  const myHello = `${conn.id}-hello.json`;
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    if (listCallCount === 1) return []; // preexisting check: empty
    return [
      { name: myHello, modifyTime: 0, size: 0 },
      { name: "peer-aaa-joining.json", modifyTime: 0, size: 0 },
      { name: "peer-bbb-joining.json", modifyTime: 0, size: 0 },
    ];
  };
  client.put = async () => {};
  client.safeDelete = async () => {};
  const err = await conn.synchronize().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(UsageError);
  expect((err as Error).message).toMatch(/more than one joining sentinel/);
});

test("synchronize() transport failure is not a UsageError", async () => {
  // A rejected list() (e.g. SFTP connection lost) is a transport failure and
  // must NOT be identified as a UsageError.
  const { client } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  client.list = async () => {
    throw new Error("SFTP connection lost");
  };
  const err = await conn.synchronize().catch((e: unknown) => e);
  expect(err).not.toBeInstanceOf(UsageError);
  expect(err).toBeInstanceOf(Error);
});

test("send() message timeout throws UsageError", async () => {
  // A stale unconsumed message that outlasts the TTL is a send-timeout usage
  // error: the caller is responsible for ensuring the peer is polling.
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    timeToLiveMs: 150,
    pollingFrequency: 10,
  });
  conn.peerId = "stub-peer";
  // Plant a stale outbound message that nobody will consume, and point
  // lastSentFile at it (the drain waits for that exact name).
  const outName = `${conn.id}-99.json`;
  files.set(`${conn.path}/${outName}`, Buffer.from("stale"));
  (conn as unknown as { lastSentFile?: string }).lastSentFile = outName;
  await expect(conn.send({ next: true })).rejects.toBeInstanceOf(UsageError);
});

// --- control file envelope: round-trip, partial-sync gate, malformed body -----

test("synchronize() lock mode: round-trip hello write and read with JSON envelope body", async () => {
  // Both the joiner fast-path (writes and reads the peer hello) and the starter
  // (reads the joiner hello before deleting) must write and read the JSON envelope.
  // Run joiner path: initial list shows one peer hello; joiner reads it, deletes
  // it, writes its own with an envelope body.
  const peerId = "00000000-0000-4000-8000-000000000001";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const peerHelloName = `${peerId}-hello.json`;
  files.set(`${conn.path}/${peerHelloName}`, LOCK_HELLO_BODY);
  client.list = async () => [
    { name: peerHelloName, modifyTime: Date.now(), size: 0 },
  ];

  await conn.synchronize();

  // Joiner wrote its own hello with a JSON envelope body.
  const myHelloPath = `${conn.path}/${conn.id}-hello.json`;
  expect(files.has(myHelloPath)).toBe(true);
  const body = JSON.parse(files.get(myHelloPath)!.toString());
  expect(body).toMatchObject({});
  expect(conn.handshakeRole).toBe("initiator");
  expect(conn.peerId).toBe(peerId);
});

test("synchronize() lockless mode: round-trip hello body and zero-length ack markers", async () => {
  // Both parties write a hello carrying the bilateral-flag envelope and a
  // zero-length ack marker named after the peer hello they acknowledge. The
  // hello is read through the gate; the ack is matched by name existence only.
  const idA = "00000000-0000-4000-8000-000000000001";
  const idB = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const sharedFiles = new Map<string, Buffer>();

  const makeClient = (): FileTransportClient => ({
    connect: async () => {},
    end: async () => {},
    list: async (dir: string): Promise<FileInfo[]> => {
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      return [...sharedFiles.entries()]
        .filter(
          ([p]) =>
            p.startsWith(prefix) && !p.slice(prefix.length).includes("/"),
        )
        .map(([p, buf]) => ({
          name: p.slice(prefix.length),
          modifyTime: 0,
          size: buf.length,
        }));
    },
    get: async (path: string) => {
      const data = sharedFiles.get(path);
      if (!data) throw new Error(`${path}: not found`);
      return data as Buffer<ArrayBufferLike>;
    },
    put: async (
      src: string | Buffer | Uint8Array[] | NodeJS.ReadableStream,
      dest: string,
    ) => {
      sharedFiles.set(dest, await putSrcBytes(src));
    },
    delete: async (path: string) => {
      sharedFiles.delete(path);
    },
    safeDelete: async (path: string) => {
      sharedFiles.delete(path);
    },
    rename: async (from: string, to: string) => {
      const data = sharedFiles.get(from);
      if (!data) throw new Error(`${from}: no such file`);
      sharedFiles.delete(from);
      sharedFiles.set(to, data);
    },
    createExclusive: async () => {
      throw new Error("not supported");
    },
    exists: async (path: string) => sharedFiles.has(path),
  });

  const connA = new FileSyncConnection(makeClient(), {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    locklessRendezvous: true,
  });
  connA.id = idA;
  connA.connected = true;
  connA.path = "/shared";

  const connB = new FileSyncConnection(makeClient(), {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    locklessRendezvous: true,
  });
  connB.id = idB;
  connB.connected = true;
  connB.path = "/shared";

  await Promise.all([connA.synchronize(), connB.synchronize()]);

  // Both hellos carry the bilateral-flag envelope body.
  for (const id of [idA, idB]) {
    const helloBody = JSON.parse(
      sharedFiles.get(`/shared/${id}-hello.json`)!.toString(),
    );
    expect(helloBody).toMatchObject({
      locklessRendezvous: true,
      retainFiles: false,
    });
  }
  // A acked B's hello; B acked A's hello. Each marker is named after the
  // acknowledged hello and is zero bytes (no envelope body).
  const ackAofB = sharedFiles.get(`/shared/${idA}-${idB}-hello-ack.json`);
  expect(ackAofB).toBeDefined();
  expect(ackAofB!.length).toBe(0);
  const ackBofA = sharedFiles.get(`/shared/${idB}-${idA}-hello-ack.json`);
  expect(ackBofA).toBeDefined();
  expect(ackBofA!.length).toBe(0);
  expect(connA.peerId).toBe(idB);
  expect(connB.peerId).toBe(idA);
});

test("synchronize() joiner: mid-sync hello body retried, not reported malformed", async () => {
  // A hello body that fails JSON.parse on the first get() (simulating a partial
  // write by a sync tool) must be retried rather than causing a terminal failure.
  // Only once the body becomes valid JSON should synchronize() proceed.
  const peerId = "00000000-0000-4000-8000-000000000001";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    pollingFrequency: 10,
    timeToLiveMs: 2_000,
  });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const peerHelloName = `${peerId}-hello.json`;

  // First two get() calls return truncated JSON (partial sync); the third
  // returns a fully valid envelope. The gate must retry silently for the
  // first two and succeed on the third.
  let getCalls = 0;
  const origGet = client.get;
  client.get = async (path: string) => {
    if (path === `${conn.path}/${peerHelloName}`) {
      getCalls++;
      if (getCalls <= 2) return Buffer.from("{") as Buffer<ArrayBufferLike>;
    }
    return origGet(path);
  };

  files.set(`${conn.path}/${peerHelloName}`, LOCK_HELLO_BODY);
  client.list = async () => [
    { name: peerHelloName, modifyTime: Date.now(), size: 0 },
  ];

  await conn.synchronize();

  // Gate retried at least twice before succeeding.
  expect(getCalls).toBeGreaterThanOrEqual(3);
  expect(conn.peerId).toBe(peerId);
});

test("synchronize() joiner: fully-synced but malformed hello body is a UsageError", async () => {
  // A hello body that parses as JSON but fails the envelope schema is a
  // terminal UsageError (protocol mismatch), not a retry.
  const peerId = "00000000-0000-4000-8000-000000000001";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const peerHelloName = `${peerId}-hello.json`;

  // A JSON array is syntactically valid but fails the envelope schema (expects
  // an object), so it is a terminal malformed-payload error, not a retry.
  files.set(`${conn.path}/${peerHelloName}`, Buffer.from("[]"));
  client.list = async () => [
    { name: peerHelloName, modifyTime: Date.now(), size: 0 },
  ];

  await expect(conn.synchronize()).rejects.toBeInstanceOf(UsageError);
});

test("synchronize() lockless: rendezvous completes on ack existence; ack body is never read", async () => {
  // The ack is a zero-length marker matched by name existence: the barrier must
  // complete without ever get()-ing an `-ack.json` file. There is no body and no
  // read gate on the ack (only the hello body is read through the gate). This
  // replaces the former mid-sync-ack-body-retry test, which guarded a read gate
  // the unified zero-byte marker no longer has.
  const idA = "00000000-0000-4000-8000-000000000001";
  const idB = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const sharedFiles = new Map<string, Buffer>();
  const ackGets: string[] = [];

  const makeClient = (): FileTransportClient => ({
    connect: async () => {},
    end: async () => {},
    list: async (dir: string): Promise<FileInfo[]> => {
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      return [...sharedFiles.entries()]
        .filter(
          ([p]) =>
            p.startsWith(prefix) && !p.slice(prefix.length).includes("/"),
        )
        .map(([p, buf]) => ({
          name: p.slice(prefix.length),
          modifyTime: 0,
          size: buf.length,
        }));
    },
    get: async (path: string) => {
      if (path.endsWith("-ack.json")) ackGets.push(path);
      const data = sharedFiles.get(path);
      if (data === undefined) throw new Error(`${path}: not found`);
      return data as Buffer<ArrayBufferLike>;
    },
    put: async (
      src: string | Buffer | Uint8Array[] | NodeJS.ReadableStream,
      dest: string,
    ) => {
      sharedFiles.set(dest, await putSrcBytes(src));
    },
    delete: async (path: string) => {
      sharedFiles.delete(path);
    },
    safeDelete: async (path: string) => {
      sharedFiles.delete(path);
    },
    rename: async (from: string, to: string) => {
      const data = sharedFiles.get(from);
      if (data === undefined) throw new Error(`${from}: no such file`);
      sharedFiles.delete(from);
      sharedFiles.set(to, data);
    },
    createExclusive: async () => {
      throw new Error("not supported");
    },
    exists: async (path: string) => sharedFiles.has(path),
  });

  const connA = new FileSyncConnection(makeClient(), {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    locklessRendezvous: true,
  });
  connA.id = idA;
  connA.connected = true;
  connA.path = "/shared";

  const connB = new FileSyncConnection(makeClient(), {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    locklessRendezvous: true,
  });
  connB.id = idB;
  connB.connected = true;
  connB.path = "/shared";

  await Promise.all([connA.synchronize(), connB.synchronize()]);

  expect(connA.peerId).toBe(idB);
  expect(connB.peerId).toBe(idA);
  // No `-ack.json` file was ever read through get(): the barrier matched on
  // existence alone.
  expect(ackGets).toEqual([]);
});

test("synchronize() lock-detection: mid-sync peer hello body retried, not malformed", async () => {
  // The lock-detection branch (lockFiles.length > 0) calls readControlFileWithGate
  // on the peer hello before committing roles. A partially-synced body (invalid
  // JSON on first get()) must cause a retry, not a terminal failure.
  const peerId = "00000000-0000-4000-8000-000000000001";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    pollingFrequency: 10,
    timeToLiveMs: 2_000,
  });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const myId = conn.id;
  const myHelloName = `${myId}-hello.json`;
  const peerHelloName = `${peerId}-hello.json`;
  const lockName = `${peerId}-${myId}-lock.json`;
  const lockPath = `${conn.path}/${lockName}`;

  files.set(`${conn.path}/${myHelloName}`, Buffer.alloc(0));
  files.set(`${conn.path}/${peerHelloName}`, LOCK_HELLO_BODY);
  files.set(lockPath, Buffer.alloc(0));

  let getCalls = 0;
  const origGet = client.get;
  client.get = async (path: string) => {
    if (path === `${conn.path}/${peerHelloName}`) {
      getCalls++;
      if (getCalls <= 2) return Buffer.from("{") as Buffer<ArrayBufferLike>;
    }
    return origGet(path);
  };

  const mtime = Date.now();
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    if (listCallCount === 1) return [];
    return [
      { name: myHelloName, modifyTime: mtime, size: 0 },
      { name: peerHelloName, modifyTime: mtime, size: 0 },
      { name: lockName, modifyTime: mtime, size: 0 },
    ];
  };

  await conn.synchronize();

  expect(getCalls).toBeGreaterThanOrEqual(3);
  expect(conn.peerId).toBe(peerId);
});

test("synchronize() lock-detection: malformed peer hello body is a UsageError", async () => {
  // A fully-synced hello body in the lock-detection branch that parses as JSON
  // but fails the envelope schema must throw a terminal UsageError, not retry.
  const peerId = "00000000-0000-4000-8000-000000000001";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const myId = conn.id;
  const myHelloName = `${myId}-hello.json`;
  const peerHelloName = `${peerId}-hello.json`;
  const lockName = `${peerId}-${myId}-lock.json`;
  const lockPath = `${conn.path}/${lockName}`;

  files.set(`${conn.path}/${myHelloName}`, Buffer.alloc(0));
  files.set(`${conn.path}/${peerHelloName}`, Buffer.from("[]"));
  files.set(lockPath, Buffer.alloc(0));

  const mtime = Date.now();
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    if (listCallCount === 1) return [];
    return [
      { name: myHelloName, modifyTime: mtime, size: 0 },
      { name: peerHelloName, modifyTime: mtime, size: 0 },
      { name: lockName, modifyTime: mtime, size: 0 },
    ];
  };

  await expect(conn.synchronize()).rejects.toBeInstanceOf(UsageError);
});

test("synchronize() lock starter: mid-sync joiner hello body retried, not malformed", async () => {
  // The starter fast-path (theseFiles.length === 0 in waitForPeer) calls
  // readControlFileWithGate on the joiner's hello before deleting it. A
  // partially-synced body must be retried, not treated as a terminal failure.
  const peerId = "00000000-0000-4000-8000-000000000001";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    pollingFrequency: 10,
    timeToLiveMs: 2_000,
  });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const peerHelloName = `${peerId}-hello.json`;

  files.set(`${conn.path}/${peerHelloName}`, LOCK_HELLO_BODY);

  let getCalls = 0;
  const origGet = client.get;
  client.get = async (path: string) => {
    if (path === `${conn.path}/${peerHelloName}`) {
      getCalls++;
      if (getCalls <= 2) return Buffer.from("{") as Buffer<ArrayBufferLike>;
    }
    return origGet(path);
  };

  // First list(): empty (initial preexisting check passes). Second+: only the
  // peer hello is visible — no self hello — triggering the theseFiles===0 branch.
  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    if (listCallCount === 1) return [];
    return [{ name: peerHelloName, modifyTime: Date.now(), size: 0 }];
  };

  await conn.synchronize();

  expect(getCalls).toBeGreaterThanOrEqual(3);
  expect(conn.peerId).toBe(peerId);
  expect(conn.handshakeRole).toBe("responder");
});

test("synchronize() lock starter: malformed joiner hello body is a UsageError", async () => {
  // A fully-synced but schema-invalid joiner hello body in the starter
  // theseFiles===0 branch must throw a terminal UsageError, not retry.
  const peerId = "00000000-0000-4000-8000-000000000001";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const peerHelloName = `${peerId}-hello.json`;

  files.set(`${conn.path}/${peerHelloName}`, Buffer.from("[]"));

  let listCallCount = 0;
  client.list = async () => {
    listCallCount++;
    if (listCallCount === 1) return [];
    return [{ name: peerHelloName, modifyTime: Date.now(), size: 0 }];
  };

  await expect(conn.synchronize()).rejects.toBeInstanceOf(UsageError);
});

// --- bilateral mode flags: advertise + symmetric fast-fail (193901017) -------

// Two sortable UUIDs reused across the bilateral-flag tests. idLow < idHigh
// lexicographically, so the lower one is the "arrived first" party.
const ID_LOW = "00000000-0000-4000-8000-000000000001";
const ID_HIGH = "ffffffff-ffff-4fff-bfff-ffffffffffff";

// Builds two FileSyncConnections sharing one in-memory directory, each already
// in the post-open connected state, for concurrent-rendezvous tests. The
// generous timeToLive means a stall (instead of a fast-fail) would exceed the
// vitest timeout and fail the test, so a passing concurrent mismatch test is
// itself proof the failure is at rendezvous and not at the peer timeout.
//
// Determinism note: the concurrent tests rely on the mock client's synchronous
// in-memory Map (no await/delay in list/put), so the two parties' list()/put()
// interleave predictably under the microtask scheduler and each sees the
// other's hello on its first poll. If the mock ever gains artificial latency, a
// party could miss the peer hello on its first list() and poll to the (generous)
// TTL, surfacing as a vitest timeout -- a test artifact to fix in the mock, not
// a production regression.
function makeRendezvousPair(
  idA: string,
  optsA: Partial<ConstructorParameters<typeof FileSyncConnection>[1]>,
  idB: string,
  optsB: Partial<ConstructorParameters<typeof FileSyncConnection>[1]>,
): {
  connA: FileSyncConnection;
  connB: FileSyncConnection;
  files: Map<string, Buffer>;
} {
  const { client, files } = makeMockClient();
  const make = (
    id: string,
    opts: Partial<ConstructorParameters<typeof FileSyncConnection>[1]>,
  ): FileSyncConnection => {
    const conn = new FileSyncConnection(client, {
      pollingFrequency: 5,
      timeToLive: new Date(Date.now() + 30_000),
      verbose: -1,
      ...opts,
    });
    conn.id = id;
    conn.connected = true;
    conn.path = "/test";
    return conn;
  };
  return { connA: make(idA, optsA), connB: make(idB, optsB), files };
}

// (a) Each rendezvous branch writes the hello with the advertised flags. Drive
// the lock joiner fast-path against a matched peer so the hello it writes
// survives (the joiner keeps its own hello) and can be inspected.
test("(a) hello payload carries both bilateral flags", async () => {
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = ID_HIGH;
  const peerHelloName = `${ID_LOW}-hello.json`;
  files.set(`${conn.path}/${peerHelloName}`, LOCK_HELLO_BODY);

  await conn.synchronize();

  const body = JSON.parse(
    files.get(`${conn.path}/${conn.id}-hello.json`)!.toString(),
  );
  expect(body).toEqual({ locklessRendezvous: false, retainFiles: false });
  expect(conn.peerId).toBe(ID_LOW);
});

// (b) Matched pairings succeed without spurious mismatch errors.

test("(b) lockless/lockless pairing succeeds and advertises both flags", async () => {
  const { connA, connB, files } = makeRendezvousPair(
    ID_LOW,
    { locklessRendezvous: true },
    ID_HIGH,
    { locklessRendezvous: true },
  );

  await Promise.all([connA.synchronize(), connB.synchronize()]);

  expect(connA.peerId).toBe(ID_HIGH);
  expect(connB.peerId).toBe(ID_LOW);
  for (const id of [ID_LOW, ID_HIGH]) {
    const body = JSON.parse(files.get(`/test/${id}-hello.json`)!.toString());
    expect(body).toEqual({ locklessRendezvous: true, retainFiles: false });
  }
});

test("(b) delete/delete (lock) pairing succeeds", async () => {
  const { connA, connB } = makeRendezvousPair(ID_LOW, {}, ID_HIGH, {});

  await Promise.all([connA.synchronize(), connB.synchronize()]);

  expect(connA.peerId).toBe(ID_HIGH);
  expect(connB.peerId).toBe(ID_LOW);
});

test("(b) retain/retain pairing succeeds and advertises the retain flag", async () => {
  const retainOpts = {
    locklessRendezvous: true,
    retainFiles: true,
    timestampInFilename: true,
  };
  const { connA, connB, files } = makeRendezvousPair(
    ID_LOW,
    retainOpts,
    ID_HIGH,
    retainOpts,
  );

  await Promise.all([connA.synchronize(), connB.synchronize()]);

  expect(connA.peerId).toBe(ID_HIGH);
  expect(connB.peerId).toBe(ID_LOW);
  for (const id of [ID_LOW, ID_HIGH]) {
    const body = JSON.parse(files.get(`/test/${id}-hello.json`)!.toString());
    expect(body).toEqual({ locklessRendezvous: true, retainFiles: true });
  }
});

// (c) Mismatched pairings fail fast at rendezvous on BOTH parties, in both
// arrival orders, with the both-sides-named error, identified as usage errors.

test("(c) lockless vs lock mismatch fails fast on BOTH parties, concurrently", async () => {
  const { connA, connB, files } = makeRendezvousPair(
    ID_LOW,
    { locklessRendezvous: true },
    ID_HIGH,
    { locklessRendezvous: false },
  );

  const results = await Promise.allSettled([
    connA.synchronize(),
    connB.synchronize(),
  ]);

  for (const r of results) {
    expect(r.status).toBe("rejected");
    const reason = (r as PromiseRejectedResult).reason;
    expect(reason).toBeInstanceOf(BilateralModeMismatchError);
    expect(reason).toBeInstanceOf(UsageError);
    expect(reason.message).toMatch(/lockless_rendezvous mismatch/);
    // Distinct from the generic peer-timeout backstop.
    expect(reason.message).not.toMatch(/timed out|synchronization has timed/);
  }
  // Both advertised hellos remain as the directory's terminal state.
  expect(files.has(`/test/${ID_LOW}-hello.json`)).toBe(true);
  expect(files.has(`/test/${ID_HIGH}-hello.json`)).toBe(true);
});

test("(c) retain vs non-retain mismatch (both lockless) fails fast on BOTH parties", async () => {
  const { connA, connB, files } = makeRendezvousPair(
    ID_LOW,
    { locklessRendezvous: true, retainFiles: true, timestampInFilename: true },
    ID_HIGH,
    { locklessRendezvous: true, retainFiles: false },
  );

  const results = await Promise.allSettled([
    connA.synchronize(),
    connB.synchronize(),
  ]);

  for (const r of results) {
    expect(r.status).toBe("rejected");
    const reason = (r as PromiseRejectedResult).reason;
    expect(reason).toBeInstanceOf(BilateralModeMismatchError);
    expect(reason.message).toMatch(/retain_files mismatch/);
  }
  expect(files.has(`/test/${ID_LOW}-hello.json`)).toBe(true);
  expect(files.has(`/test/${ID_HIGH}-hello.json`)).toBe(true);
});

test("(c) lock joiner reading a lockless peer hello fails fast and leaves both hellos", async () => {
  // Arrival order 1: the lock party reads a peer hello already present (joiner
  // fast-path) and detects the mismatch. It must write its own advertisement
  // before throwing and must not delete the peer hello.
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    pollingFrequency: 10,
    timeToLiveMs: 30_000,
  });
  conn.id = ID_HIGH; // lock (default)
  const peerHelloName = `${ID_LOW}-hello.json`;
  files.set(
    `${conn.path}/${peerHelloName}`,
    Buffer.from(
      JSON.stringify({ locklessRendezvous: true, retainFiles: false }),
    ),
  );

  let err: unknown;
  await conn.synchronize().catch((e: unknown) => {
    err = e;
  });

  expect(err).toBeInstanceOf(BilateralModeMismatchError);
  expect((err as Error).message).toContain(
    "this party has lockless_rendezvous=false",
  );
  expect((err as Error).message).toContain(
    "the peer has lockless_rendezvous=true",
  );
  // Own advertisement written, peer hello not deleted: both remain.
  expect(files.has(`${conn.path}/${conn.id}-hello.json`)).toBe(true);
  expect(files.has(`${conn.path}/${peerHelloName}`)).toBe(true);
});

test("(c) lock joiner fast-path retries a transient advertise-hello write, then leaves the durable hello", async () => {
  // 193901017's symmetric-detection floor is best-effort and contingent on this
  // one advertising write landing: the lock joiner fast-path is the single
  // mismatch site that needs a NEW write at detection time. A transient put
  // failure here would otherwise leave no durable hello for the lockless peer to
  // read, degrading it to the legacy peer-timeout instead of a symmetric
  // fast-fail. The bounded retry re-attempts the write at the polling cadence;
  // failing the first N-1 attempts and succeeding on the last (Nth) proves the
  // budget is fully usable and the advertisement still lands.
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    pollingFrequency: 1,
    timeToLiveMs: 30_000,
  });
  conn.id = ID_HIGH; // lock (default)
  const peerHelloName = `${ID_LOW}-hello.json`;
  files.set(
    `${conn.path}/${peerHelloName}`,
    Buffer.from(
      JSON.stringify({ locklessRendezvous: true, retainFiles: false }),
    ),
  );

  // Fail the advertise-hello put on every attempt but the last in the budget,
  // then delegate to the in-memory store so the final attempt lands. Scoped to
  // the hello path: on a mismatch this branch issues no other put.
  const helloPath = `${conn.path}/${conn.id}-hello.json`;
  const originalPut = client.put;
  let helloPutAttempts = 0;
  client.put = async (src, dest, options) => {
    if (dest === helloPath) {
      helloPutAttempts++;
      if (helloPutAttempts < ADVERTISE_HELLO_RETRY_ATTEMPTS)
        throw new Error(`synthetic transient put failure #${helloPutAttempts}`);
    }
    return originalPut(src, dest, options);
  };

  let err: unknown;
  await conn.synchronize().catch((e: unknown) => {
    err = e;
  });

  // The typed mismatch is still thrown (UsageError, exit 64): the retry must not
  // let a transport rejection mask or replace the actionable mismatch.
  expect(err).toBeInstanceOf(BilateralModeMismatchError);
  expect(err).toBeInstanceOf(UsageError);
  // The write was retried across the budget and the final attempt landed.
  expect(helloPutAttempts).toBe(ADVERTISE_HELLO_RETRY_ATTEMPTS);
  // Durable advertised hello is left on disk for the peer to read, alongside the
  // (undeleted) peer hello -- both are the directory's terminal state.
  expect(files.has(helloPath)).toBe(true);
  expect(files.has(`${conn.path}/${peerHelloName}`)).toBe(true);
});

test("(c) lock joiner fast-path degrades to log-and-throw once the advertise-hello budget is exhausted", async () => {
  // The documented best-effort floor: once the bounded retry budget is spent,
  // the party gives up the advertisement -- no durable hello, so the peer
  // degrades to the legacy peer-timeout -- but STILL throws the typed mismatch.
  // A transport rejection must never escape this catch-less fast-path and mask
  // the BilateralModeMismatchError (exit 64) as a generic Error (exit 69).
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    pollingFrequency: 1,
    timeToLiveMs: 30_000,
  });
  conn.id = ID_HIGH; // lock (default)
  const peerHelloName = `${ID_LOW}-hello.json`;
  files.set(
    `${conn.path}/${peerHelloName}`,
    Buffer.from(
      JSON.stringify({ locklessRendezvous: true, retainFiles: false }),
    ),
  );

  const helloPath = `${conn.path}/${conn.id}-hello.json`;
  const originalPut = client.put;
  let helloPutAttempts = 0;
  client.put = async (src, dest, options) => {
    if (dest === helloPath) {
      helloPutAttempts++;
      throw new Error("synthetic persistent put failure");
    }
    return originalPut(src, dest, options);
  };

  let err: unknown;
  await conn.synchronize().catch((e: unknown) => {
    err = e;
  });

  expect(err).toBeInstanceOf(BilateralModeMismatchError);
  expect(err).toBeInstanceOf(UsageError);
  // The full budget was exhausted before giving up.
  expect(helloPutAttempts).toBe(ADVERTISE_HELLO_RETRY_ATTEMPTS);
  // No durable advertisement left (every write failed); the peer hello is
  // untouched. The peer degrades to the legacy peer-timeout, exactly as the
  // best-effort floor describes.
  expect(files.has(helloPath)).toBe(false);
  expect(files.has(`${conn.path}/${peerHelloName}`)).toBe(true);
});

test("(c) lockless party reading a lock peer hello fails fast and leaves both hellos", async () => {
  // Arrival order 2: the lockless party reads the lock peer's left-behind hello
  // in its ack barrier and detects the mismatch, after having written its own
  // hello before the loop. The same pairing's other side (above) detects via
  // the joiner fast-path, so both parties surface it.
  const { client, files } = makeMockClient();
  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 30_000),
    verbose: -1,
    locklessRendezvous: true,
  });
  conn.id = ID_LOW;
  conn.connected = true;
  conn.path = "/test";
  const peerHelloName = `${ID_HIGH}-hello.json`;
  files.set(`${conn.path}/${peerHelloName}`, LOCK_HELLO_BODY);

  let err: unknown;
  await conn.synchronize().catch((e: unknown) => {
    err = e;
  });

  expect(err).toBeInstanceOf(BilateralModeMismatchError);
  expect((err as Error).message).toContain(
    "this party has lockless_rendezvous=true",
  );
  expect((err as Error).message).toContain(
    "the peer has lockless_rendezvous=false",
  );
  expect(files.has(`${conn.path}/${conn.id}-hello.json`)).toBe(true);
  expect(files.has(`${conn.path}/${peerHelloName}`)).toBe(true);

  // The durable-hello guarantee is load-bearing: the outer catch must clear
  // responsibleFiles so a later cleanup()/close() does not sweep the hello this
  // party advertised. If it were swept, the peer's read would miss it and the
  // peer would fall through to the timeout instead of fast-failing. Assert the
  // clear directly, then prove its consequence -- cleanup() (non-retain here,
  // so not a no-op) removes nothing and both hellos persist as the terminal
  // state.
  const responsible = (conn as unknown as { responsibleFiles: Set<string> })
    .responsibleFiles;
  expect(responsible.size).toBe(0);
  await conn.cleanup();
  expect(files.has(`${conn.path}/${conn.id}-hello.json`)).toBe(true);
  expect(files.has(`${conn.path}/${peerHelloName}`)).toBe(true);
});

test("(c) lock two-hellos branch detects the mismatch before createExclusive (EEXIST-loser sub-path pre-empted)", async () => {
  // The check precedes createExclusive, so neither the createExclusive-winner
  // nor the EEXIST-loser sub-path runs on a mismatch. createExclusive is stubbed
  // to throw EEXIST (and exists() to report a live lock) so that, were the check
  // NOT pre-empting it, the loser sub-path would run; assert it never does.
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    pollingFrequency: 10,
    timeToLiveMs: 30_000,
  });
  conn.id = ID_HIGH; // lock
  const peerHelloName = `${ID_LOW}-hello.json`;
  files.set(
    `${conn.path}/${peerHelloName}`,
    Buffer.from(
      JSON.stringify({ locklessRendezvous: true, retainFiles: false }),
    ),
  );

  let createExclusiveCalls = 0;
  client.createExclusive = async () => {
    createExclusiveCalls++;
    throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
  };
  client.exists = async () => true;

  // First list (entry guard) is empty so conn writes its own hello and enters
  // the lock loop; subsequent lists show both hellos and no lock, routing into
  // the two-hellos branch.
  let listCalls = 0;
  client.list = async () => {
    listCalls++;
    if (listCalls === 1) return [];
    return [
      { name: `${conn.id}-hello.json`, modifyTime: 0, size: 0 },
      { name: peerHelloName, modifyTime: 0, size: 0 },
    ];
  };

  let err: unknown;
  await conn.synchronize().catch((e: unknown) => {
    err = e;
  });

  expect(err).toBeInstanceOf(BilateralModeMismatchError);
  expect((err as Error).message).toMatch(/lockless_rendezvous mismatch/);
  expect(createExclusiveCalls).toBe(0);
  // The conn's own hello (written before the loop) is left behind, not swept.
  expect(files.has(`${conn.path}/${conn.id}-hello.json`)).toBe(true);
});

test("(c) lock-detection branch sweeps the lock and leaves both hellos on a mismatch", async () => {
  // Defense-in-depth path (waitForPeer's "lockFiles.length > 0" arm). A lock on
  // disk implies both parties are lock (lockless never creates one) and a lock
  // party always has retain_files=false, so no flag can differ and this branch
  // cannot reach a mismatch for any valid pairing. Drive it with a synthetic
  // directory -- a peer-created lock plus a lockless-advertising peer hello --
  // to cover the safeDelete(lock)-then-throw code added for the prior review.
  // The lock is a transient, not an advertisement, so it is swept; both hellos
  // remain as the directory's terminal state.
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    pollingFrequency: 10,
    timeToLiveMs: 30_000,
  });
  conn.id = ID_HIGH; // lock, non-retain
  const peerHelloName = `${ID_LOW}-hello.json`;
  // ID_LOW sorts first, so the producer's lock name is `${ID_LOW}-${ID_HIGH}`;
  // this matches the branch's reconstruct-and-compare (I7) so the read gate and
  // mismatch check are reached rather than a "lock does not reference" throw.
  const lockName = `${ID_LOW}-${conn.id}-lock.json`;
  const lockPath = `${conn.path}/${lockName}`;
  files.set(
    `${conn.path}/${peerHelloName}`,
    Buffer.from(
      JSON.stringify({ locklessRendezvous: true, retainFiles: false }),
    ),
  );
  files.set(lockPath, Buffer.alloc(0));

  // First list (entry guard) empty so conn writes its own hello and enters the
  // lock loop; subsequent lists expose both hellos plus the peer-created lock,
  // routing into the lock-detection branch.
  let listCalls = 0;
  client.list = async () => {
    listCalls++;
    if (listCalls === 1) return [];
    return [
      { name: `${conn.id}-hello.json`, modifyTime: 0, size: 0 },
      { name: peerHelloName, modifyTime: 0, size: 0 },
      { name: lockName, modifyTime: 0, size: 0 },
    ];
  };

  let err: unknown;
  await conn.synchronize().catch((e: unknown) => {
    err = e;
  });

  expect(err).toBeInstanceOf(BilateralModeMismatchError);
  expect((err as Error).message).toMatch(/lockless_rendezvous mismatch/);
  expect(files.has(lockPath)).toBe(false);
  expect(files.has(`${conn.path}/${conn.id}-hello.json`)).toBe(true);
  expect(files.has(`${conn.path}/${peerHelloName}`)).toBe(true);
});

test("(c) a both-flags-differ mismatch names retain_files (the implying flag)", async () => {
  // retain=true/lockless=true vs retain=false/lockless=false: both flags differ,
  // and the error names retain_files so a single rerun realigns both.
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    pollingFrequency: 10,
    timeToLiveMs: 30_000,
  });
  conn.id = ID_HIGH; // lock, non-retain
  const peerHelloName = `${ID_LOW}-hello.json`;
  files.set(
    `${conn.path}/${peerHelloName}`,
    Buffer.from(
      JSON.stringify({ locklessRendezvous: true, retainFiles: true }),
    ),
  );

  let err: unknown;
  await conn.synchronize().catch((e: unknown) => {
    err = e;
  });

  expect(err).toBeInstanceOf(BilateralModeMismatchError);
  expect((err as Error).message).toMatch(/retain_files mismatch/);
  expect((err as Error).message).not.toMatch(/lockless_rendezvous mismatch/);
});

// (d) A fully-synced hello that parses as JSON but is missing a flag or carries
// an out-of-type value fails the required-field schema as a terminal usage
// error on the reading party -- no crash, no silent default.

test("(d) a fully-synced hello missing a flag is a terminal usage error", async () => {
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = ID_HIGH;
  const peerHelloName = `${ID_LOW}-hello.json`;
  files.set(
    `${conn.path}/${peerHelloName}`,
    Buffer.from(JSON.stringify({ locklessRendezvous: true })), // retainFiles absent
  );

  let err: unknown;
  await conn.synchronize().catch((e: unknown) => {
    err = e;
  });

  expect(err).toBeInstanceOf(UsageError);
  expect((err as Error).message).toMatch(/malformed payload/);
});

test("(d) a fully-synced hello with an out-of-type flag is a terminal usage error", async () => {
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = ID_HIGH;
  const peerHelloName = `${ID_LOW}-hello.json`;
  files.set(
    `${conn.path}/${peerHelloName}`,
    Buffer.from(
      JSON.stringify({ locklessRendezvous: "yes", retainFiles: false }),
    ),
  );

  let err: unknown;
  await conn.synchronize().catch((e: unknown) => {
    err = e;
  });

  expect(err).toBeInstanceOf(UsageError);
  expect((err as Error).message).toMatch(/malformed payload/);
});

// (e) After a mismatch the directory retains both hellos, so a rerun against it
// is rejected by the entry guard (I0) -- the terminal mismatch is not auto-
// retried and the operator must clear the directory first.

test("(e) leftover hellos after a mismatch make a rerun rejected by the entry guard", async () => {
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    pollingFrequency: 10,
    timeToLiveMs: 30_000,
  });
  conn.id = ID_HIGH; // lock
  const peerHelloName = `${ID_LOW}-hello.json`;
  files.set(
    `${conn.path}/${peerHelloName}`,
    Buffer.from(
      JSON.stringify({ locklessRendezvous: true, retainFiles: false }),
    ),
  );

  await expect(conn.synchronize()).rejects.toBeInstanceOf(
    BilateralModeMismatchError,
  );
  expect(files.has(`${conn.path}/${conn.id}-hello.json`)).toBe(true);
  expect(files.has(`${conn.path}/${peerHelloName}`)).toBe(true);

  // A rerun against the non-clean directory (fresh party id) is rejected by the
  // entry guard: two peer hellos are now present.
  const rerun = await makeConnectedConn(client, { pollingFrequency: 10 });
  rerun.id = "11111111-1111-4111-8111-111111111111";

  let rerunErr: unknown;
  await rerun.synchronize().catch((e: unknown) => {
    rerunErr = e;
  });
  expect(rerunErr).toBeInstanceOf(UsageError);
  expect((rerunErr as Error).message).toMatch(/peer hello|must be empty/);
});

// --- retain mode (retainFiles: true) -----------------------------------------

// Creates a retain-mode connection that is already open, connected, and paired.
function makeRetainConn(
  client: FileTransportClient,
  id: string,
  peerId: string,
  timeToLiveMs = 5_000,
): FileSyncConnection {
  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + timeToLiveMs),
    verbose: -1,
    locklessRendezvous: true,
    timestampInFilename: true,
    retainFiles: true,
  });
  conn.id = id;
  conn.connected = true;
  conn.path = "/shared";
  conn.peerId = peerId;
  return conn;
}

test("retain mode: synchronize() throws UsageError when locklessRendezvous is false", async () => {
  // Class-boundary guard: constructing FileSyncConnection with retainFiles:
  // true but locklessRendezvous: false (or unset) bypasses the schema refine
  // and CLI imply, so synchronize() must catch the combination and throw before
  // entering any rendezvous path.
  const { client } = makeMockClient();
  client.list = async () => [];
  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    retainFiles: true,
    // locklessRendezvous intentionally omitted (defaults to false)
  });
  conn.connected = true;
  conn.path = "/test";

  await expect(conn.synchronize()).rejects.toBeInstanceOf(UsageError);
});

test("retain mode: synchronize() throws UsageError when locklessRendezvous is explicitly false", async () => {
  // Explicit false must also be rejected, not just the default (unset) case.
  const { client } = makeMockClient();
  client.list = async () => [];
  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    retainFiles: true,
    locklessRendezvous: false,
  });
  conn.connected = true;
  conn.path = "/test";

  await expect(conn.synchronize()).rejects.toBeInstanceOf(UsageError);
});

test("retain mode: multi-message exchange completes when delete() always fails", async () => {
  // Acceptance: two-party unit test demonstrating a full multi-message cycle
  // when the mock's delete() is stubbed to always throw.
  const sharedFiles = new Map<string, Buffer>();

  const makeClient = (): FileTransportClient => ({
    connect: async () => {},
    end: async () => {},
    list: async (dir: string): Promise<FileInfo[]> => {
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      return [...sharedFiles.entries()]
        .filter(
          ([p]) =>
            p.startsWith(prefix) && !p.slice(prefix.length).includes("/"),
        )
        .map(([p, buf]) => ({
          name: p.slice(prefix.length),
          modifyTime: 0,
          size: buf.length,
        }));
    },
    get: async (path: string) => {
      const data = sharedFiles.get(path);
      if (!data) throw new Error(`${path}: not found`);
      return data as Buffer<ArrayBufferLike>;
    },
    put: async (
      src: string | Buffer | Uint8Array[] | NodeJS.ReadableStream,
      dest: string,
    ) => {
      sharedFiles.set(dest, await putSrcBytes(src));
    },
    delete: async () => {
      throw new Error("delete not supported on this transport");
    },
    safeDelete: async () => {},
    rename: async (from: string, to: string) => {
      const data = sharedFiles.get(from);
      if (data === undefined) throw new Error(`${from}: no such file`);
      sharedFiles.delete(from);
      sharedFiles.set(to, data);
    },
    createExclusive: async () => {},
    exists: async (path: string) => sharedFiles.has(path),
  });

  const idA = "sender-a";
  const idB = "receiver-b";
  const connA = makeRetainConn(makeClient(), idA, idB);
  const connB = makeRetainConn(makeClient(), idB, idA);

  const received: unknown[] = [];
  let resolveAll!: () => void;
  const allReceived = new Promise<void>((r) => (resolveAll = r));
  connB.on("data", (msg) => {
    received.push(msg);
    if (received.length === 3) resolveAll();
  });

  // Send 3 messages concurrently with B's poller; the ack gate serializes
  // them even though delete() always fails.
  const sending = (async () => {
    await connA.send({ n: 1 });
    await connA.send({ n: 2 });
    await connA.send({ n: 3 });
  })();

  await runPoller(connB, allReceived);
  await sending;

  expect(received).toHaveLength(3);
  expect((received[0] as { n: number }).n).toBe(1);
  expect((received[1] as { n: number }).n).toBe(2);
  expect((received[2] as { n: number }).n).toBe(3);
});

test("retain mode: ack marker is written before the data event fires", async () => {
  const { client, files } = makeMockClient();
  const peerId = "peer-sender";
  const id = "receiver-me";

  const message = objectMessage({ v: 1 });
  const msgName = `${peerId}-20260101T000000-000-${message.length}.json`;
  files.set(`/test/${msgName}`, message);

  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    locklessRendezvous: true,
    timestampInFilename: true,
    retainFiles: true,
  });
  conn.id = id;
  conn.connected = true;
  conn.path = "/test";
  conn.peerId = peerId;

  let ackPresentAtEmit = false;
  let notifyReceived!: () => void;
  const delivered = new Promise<void>((r) => (notifyReceived = r));
  conn.on("data", () => {
    ackPresentAtEmit = [...files.keys()].some(
      (p) => p.includes(`${id}-`) && p.endsWith("-ack.json"),
    );
    notifyReceived();
  });

  await runPoller(conn, delivered);

  expect(ackPresentAtEmit).toBe(true);
});

// Returns the stem (name minus .json) of the single message file this party
// wrote, so a test can construct the ack the sender's gate waits for.
const lastSentStem = (files: Map<string, Buffer>, dir: string, id: string) => {
  const sent = [...files.keys()].find(
    (p) =>
      p.startsWith(`${dir}/${id}-`) &&
      p.endsWith(".json") &&
      !p.endsWith("-ack.json") &&
      !p.endsWith("-hello.json"),
  );
  if (sent === undefined) throw new Error("no sent message found");
  return sent.slice(`${dir}/`.length, -".json".length);
};

test("retain mode: sender blocks until the ack of its last message appears, then proceeds", async () => {
  const { client, files } = makeMockClient();
  const id = "sender-me";
  const peerId = "peer-receiver";

  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    locklessRendezvous: true,
    timestampInFilename: true,
    retainFiles: true,
  });
  conn.connected = true;
  conn.path = "/test";
  conn.id = id;
  conn.peerId = peerId;

  // First send proceeds without waiting (seq=0).
  await conn.send({ first: true });
  const stem = lastSentStem(files, "/test", id);

  // Second send blocks waiting for the ack of the first message.
  let secondDone = false;
  const secondSend = conn.send({ second: true }).then(() => {
    secondDone = true;
  });

  await new Promise((r) => setTimeout(r, 50));
  expect(secondDone).toBe(false);

  // Plant the zero-length ack named after the sent message; the gate matches it
  // by name existence (constructed from the stem, not parsed).
  files.set(`/test/${peerId}-${stem}-ack.json`, Buffer.alloc(0));

  await secondSend;
  expect(secondDone).toBe(true);
});

test("retain mode: an ack for a different message does not release the sender", async () => {
  const { client, files } = makeMockClient();
  const id = "sender-me";
  const peerId = "peer-receiver";

  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    locklessRendezvous: true,
    timestampInFilename: true,
    retainFiles: true,
  });
  conn.connected = true;
  conn.path = "/test";
  conn.id = id;
  conn.peerId = peerId;

  await conn.send({ first: true });
  const stem = lastSentStem(files, "/test", id);

  let secondDone = false;
  const secondSend = conn.send({ second: true }).then(() => {
    secondDone = true;
  });

  await new Promise((r) => setTimeout(r, 30));
  expect(secondDone).toBe(false);

  // An ack for a different message (a wrong stem) does not match the expected
  // name, so the gate stays closed.
  files.set(
    `/test/${peerId}-${id}-20260101T000000-999-5-ack.json`,
    Buffer.alloc(0),
  );

  await new Promise((r) => setTimeout(r, 30));
  expect(secondDone).toBe(false);

  // The ack of the actual last-sent message releases the gate.
  files.set(`/test/${peerId}-${stem}-ack.json`, Buffer.alloc(0));

  await secondSend;
  expect(secondDone).toBe(true);
});

test("retain mode: first send proceeds immediately without any ack", async () => {
  const { client, files } = makeMockClient();
  const id = "sender-me";
  const peerId = "peer-receiver";

  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    locklessRendezvous: true,
    timestampInFilename: true,
    retainFiles: true,
  });
  conn.connected = true;
  conn.path = "/test";
  conn.id = id;
  conn.peerId = peerId;

  // No acks present; first send must resolve without waiting.
  await conn.send({ first: true });

  const messageFiles = [...files.keys()].filter(
    (p) =>
      p.includes(`${id}-`) && p.endsWith(".json") && !p.endsWith("-ack.json"),
  );
  expect(messageFiles).toHaveLength(1);
});

test("retain mode: cleanup() does not delete exchange files", async () => {
  const { client, files } = makeMockClient();
  const peerId = "peer-sender";
  const id = "receiver-me";

  const message = objectMessage({ v: 1 });
  const msgName = `${peerId}-20260101T000000-000-${message.length}.json`;
  files.set(`/test/${msgName}`, message);

  const safeDeleted: string[] = [];
  const origSafeDelete = client.safeDelete.bind(client);
  client.safeDelete = async (p: string) => {
    safeDeleted.push(p);
    return origSafeDelete(p);
  };

  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    locklessRendezvous: true,
    timestampInFilename: true,
    retainFiles: true,
  });
  conn.id = id;
  conn.connected = true;
  conn.path = "/test";
  conn.peerId = peerId;

  let notifyReceived!: () => void;
  const delivered = new Promise<void>((r) => (notifyReceived = r));
  conn.on("data", () => notifyReceived());

  await runPoller(conn, delivered);

  // cleanup() must not delete any files in retain mode.
  await conn.cleanup();
  expect(safeDeleted).toHaveLength(0);
  // The ack marker is still on disk (cleanup did not remove it).
  const ackOnDisk = [...files.keys()].find(
    (p) => p.includes(`${id}-`) && p.endsWith("-ack.json"),
  );
  expect(ackOnDisk).toBeDefined();
});

test("retain mode: a consumed message file is retained on a delete-capable transport", async () => {
  // Regression: retain mode must never delete the message payload, even when the
  // transport's delete() succeeds (e.g. real SFTP). The directory is the durable
  // transcript and the ack is the consumption signal that replaces deletion.
  // Previously the receiver issued a best-effort delete that silently removed the
  // message on capable transports, so the "permanent transcript" guarantee held
  // only on no-delete transports. makeMockClient's delete() actually removes the
  // file, so this exercises the capable-transport path.
  const { client, files } = makeMockClient();
  const peerId = "peer-sender";
  const id = "receiver-me";

  const message = objectMessage({ v: 1 });
  const msgName = `${peerId}-20260101T000000-000-${message.length}.json`;
  const msgPath = `/test/${msgName}`;
  files.set(msgPath, message);

  // Spy on delete() so the test fails if any deletion is attempted at all.
  const deleted: string[] = [];
  const origDelete = client.delete.bind(client);
  client.delete = async (p: string) => {
    deleted.push(p);
    return origDelete(p);
  };

  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    locklessRendezvous: true,
    timestampInFilename: true,
    retainFiles: true,
  });
  conn.id = id;
  conn.connected = true;
  conn.path = "/test";
  conn.peerId = peerId;

  let notifyReceived!: () => void;
  const delivered = new Promise<void>((r) => (notifyReceived = r));
  conn.on("data", () => notifyReceived());

  await runPoller(conn, delivered);

  // The message payload is still on disk after consumption...
  expect(files.has(msgPath)).toBe(true);
  // ...because no deletion was ever attempted in retain mode.
  expect(deleted).toHaveLength(0);
  // The ack -- the consumption signal that replaces deletion -- was written.
  const ackOnDisk = [...files.keys()].some(
    (p) => p.includes(`${id}-`) && p.endsWith("-ack.json"),
  );
  expect(ackOnDisk).toBe(true);
});

test("retain mode: a message reprocessed after an emit failure is not acked twice", async () => {
  // The ack is written before emit, and on an emit failure recvSeq stays so the
  // (never-deleted) message is reprocessed on the next poll. The ack write must
  // produce exactly one marker across that retry, even though the message is
  // processed twice.
  const { client, files } = makeMockClient();
  const peerId = "peer-sender";
  const id = "receiver-me";

  const message = objectMessage({ v: 1 });
  const msgName = `${peerId}-20260101T000000-000-${message.length}.json`;
  files.set(`/test/${msgName}`, message);

  // Count ack writes via rename rather than the on-disk file set: the ack name
  // is a pure function of the consumed message's fixed name, so a duplicate
  // write would overwrite the first under an identical name and be invisible to
  // a file-count check.
  const ackRenames: string[] = [];
  const origRename = client.rename.bind(client);
  client.rename = async (from: string, to: string) => {
    if (to.endsWith("-ack.json")) ackRenames.push(to);
    return origRename(from, to);
  };

  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    locklessRendezvous: true,
    timestampInFilename: true,
    retainFiles: true,
  });
  conn.id = id;
  conn.connected = true;
  conn.path = "/test";
  conn.peerId = peerId;

  // Fail the first emit so the message is reprocessed; deliver on the second.
  let emitCount = 0;
  const received: unknown[] = [];
  let notifyReceived!: () => void;
  const delivered = new Promise<void>((r) => (notifyReceived = r));
  conn.on("data", (msg) => {
    emitCount += 1;
    if (emitCount === 1) throw new Error("data handler failed on first emit");
    received.push(msg);
    notifyReceived();
  });
  // Swallow the error the failed emit raises through poll() so the poller keeps
  // running and reprocesses the retained message.
  conn.on("error", () => {});

  await runPoller(conn, delivered);

  // Processed twice (first emit threw, second delivered)...
  expect(emitCount).toBeGreaterThanOrEqual(2);
  expect(received).toHaveLength(1);
  // ...but the ack was written exactly once (idempotent across the retry).
  expect(ackRenames).toHaveLength(1);
});

test("retain mode: ack-wait timeout throws a UsageError on the timeToLive budget", async () => {
  const { client } = makeMockClient();
  const id = "sender-me";
  const peerId = "peer-receiver";

  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 100),
    verbose: -1,
    locklessRendezvous: true,
    timestampInFilename: true,
    retainFiles: true,
  });
  conn.connected = true;
  conn.path = "/test";
  conn.id = id;
  conn.peerId = peerId;

  // First send uses the budget without blocking; no ack will arrive.
  await conn.send({ first: true });

  // Second send must time out and throw UsageError.
  await expect(conn.send({ second: true })).rejects.toBeInstanceOf(UsageError);
});

test("retain mode + lockless rendezvous: multi-message exchange completes end-to-end", async () => {
  // Primary production configuration: sync-mediated transports that lack both
  // atomic exclusive-create and deletion visibility need lockless_rendezvous
  // for rendezvous AND retain_files for message-loop signaling. This test
  // covers the one combination that had zero prior coverage.
  const idA = "00000000-0000-4000-8000-000000000001"; // sorts lower
  const idB = "ffffffff-ffff-4fff-bfff-ffffffffffff"; // sorts higher

  const sharedFiles = new Map<string, Buffer>();
  const deleteCalls: string[] = [];

  const makeClient = (): FileTransportClient => ({
    connect: async () => {},
    end: async () => {},
    list: async (dir: string): Promise<FileInfo[]> => {
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      return [...sharedFiles.entries()]
        .filter(
          ([p]) =>
            p.startsWith(prefix) && !p.slice(prefix.length).includes("/"),
        )
        .map(([p, buf]) => ({
          name: p.slice(prefix.length),
          modifyTime: 0,
          size: buf.length,
        }));
    },
    get: async (path: string) => {
      const data = sharedFiles.get(path);
      if (!data) throw new Error(`${path}: not found`);
      return data as Buffer<ArrayBufferLike>;
    },
    put: async (
      src: string | Buffer | Uint8Array[] | NodeJS.ReadableStream,
      dest: string,
    ) => {
      sharedFiles.set(dest, await putSrcBytes(src));
    },
    delete: async (path: string) => {
      deleteCalls.push(path);
      throw new Error("delete not supported on this transport");
    },
    safeDelete: async () => {},
    rename: async (from: string, to: string) => {
      const data = sharedFiles.get(from);
      if (data === undefined) throw new Error(`${from}: no such file`);
      sharedFiles.delete(from);
      sharedFiles.set(to, data);
    },
    createExclusive: async () => {
      throw new Error("createExclusive not supported on this transport");
    },
    exists: async (path: string) => sharedFiles.has(path),
  });

  const connA = new FileSyncConnection(makeClient(), {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    locklessRendezvous: true,
    timestampInFilename: true,
    retainFiles: true,
  });
  connA.id = idA;
  connA.connected = true;
  connA.path = "/shared";

  const connB = new FileSyncConnection(makeClient(), {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    locklessRendezvous: true,
    timestampInFilename: true,
    retainFiles: true,
  });
  connB.id = idB;
  connB.connected = true;
  connB.path = "/shared";

  await Promise.all([connA.synchronize(), connB.synchronize()]);
  expect(connA.peerId).toBe(idB);
  expect(connB.peerId).toBe(idA);

  const received: unknown[] = [];
  let resolveAll!: () => void;
  const allReceived = new Promise<void>((r) => (resolveAll = r));
  connB.on("data", (msg) => {
    received.push(msg);
    if (received.length === 3) resolveAll();
  });

  const sending = (async () => {
    await connA.send({ n: 1 });
    await connA.send({ n: 2 });
    await connA.send({ n: 3 });
  })();

  await runPoller(connB, allReceived);
  await sending;

  expect(received).toHaveLength(3);
  expect((received[0] as { n: number }).n).toBe(1);
  expect((received[1] as { n: number }).n).toBe(2);
  expect((received[2] as { n: number }).n).toBe(3);
  // delete() was never called: retain mode on a no-delete transport must not
  // attempt deletion anywhere in the rendezvous-to-message-loop path.
  expect(deleteCalls).toHaveLength(0);
});

// --- finding #1: seq advances only after durable rename ----------------------

test("retain mode: send() does not advance seq when rename throws", async () => {
  // Regression guard: a write failure must not leave this.seq past the slot of
  // the unwritten message, which would cause the retain-mode ack gate to wait
  // forever for the ack of a message that was never written.
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    locklessRendezvous: true,
    timestampInFilename: true,
    retainFiles: true,
  });
  conn.connected = true;
  conn.path = "/test";
  conn.id = "sender-me";
  conn.peerId = "peer-receiver";

  const seqBefore = conn.seq;

  // Stub rename to throw so the durable write never completes.
  client.rename = async () => {
    throw new Error("rename failed");
  };

  await expect(conn.send({ n: 1 })).rejects.toThrow("rename failed");

  // seq must be unchanged: the message was never committed to disk.
  expect(conn.seq).toBe(seqBefore);
});

test("delete mode: send() does not advance seq when rename throws", async () => {
  // Same invariant must hold in non-retain mode.
  const { client } = makeMockClient();
  const conn = await makeConnectedConn(client);
  conn.peerId = "stub-peer";

  const seqBefore = conn.seq;
  client.rename = async () => {
    throw new Error("rename failed");
  };

  await expect(conn.send({ n: 1 })).rejects.toThrow("rename failed");
  expect(conn.seq).toBe(seqBefore);
});

// --- finding #4: retain => timestampInFilename guard in synchronize() --------

test("retain mode: synchronize() throws UsageError when timestampInFilename is false", async () => {
  // Guard fires when retainFiles=true and timestampInFilename=false (even when
  // locklessRendezvous=true, so it is the timestamp guard that triggers).
  const { client } = makeMockClient();
  client.list = async () => [];
  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    retainFiles: true,
    locklessRendezvous: true,
    timestampInFilename: false,
  });
  conn.connected = true;
  conn.path = "/test";

  await expect(conn.synchronize()).rejects.toBeInstanceOf(UsageError);
});

// --- finding #5: close() resets session counters -----------------------------

test("close() resets seq, recvSeq, and lastAckedNNN to their initial values", async () => {
  // A closed connection must not carry stale counters into a hypothetical
  // re-open. Set each to a non-zero value, close(), then assert they reset.
  const { client } = makeMockClient();
  const conn = await makeConnectedConn(client);
  conn.peerId = "stub-peer";

  // Drive counters to non-initial values by sending a message and manipulating
  // internal state directly (the fields are internal but accessible in tests).
  await conn.send({ n: 1 });
  // seq is now 1 after a successful send.
  expect(conn.seq).toBe(1);
  // Manually set recvSeq and lastAckedNNN to non-zero/non-(-1) values.
  (conn as unknown as { recvSeq: number }).recvSeq = 3;
  (conn as unknown as { lastAckedNNN: number }).lastAckedNNN = 2;

  await conn.close();

  expect(conn.seq).toBe(0);
  expect((conn as unknown as { recvSeq: number }).recvSeq).toBe(0);
  expect((conn as unknown as { lastAckedNNN: number }).lastAckedNNN).toBe(-1);
});

// --- finding #1/#6: terminal poll errors stop the poller ---------------------

test("retain mode: poll() duplicate-NNN error is a UsageError and stops the poller", async () => {
  // Finding #6: the duplicate-NNN throw is now UsageError (terminal protocol
  // violation). Finding #1: a UsageError in the non-TOCTOU catch branch sets
  // pollerActive=false before emitting, so the finally block does not reschedule
  // and the error fires exactly once without the handler calling stop().
  const { client, files } = makeMockClient();
  const peerId = "peer-sender";
  const id = "receiver-me";

  // Plant two message files with the same NNN (0): the poller scan for
  // recvSeq=0 will find both and throw the duplicate-NNN UsageError.
  const msg = objectMessage({ v: 1 });
  files.set(`/test/${peerId}-20260101T000000-000-${msg.length}.json`, msg);
  files.set(`/test/${peerId}-20260101T120000-000-${msg.length}.json`, msg);

  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    locklessRendezvous: true,
    timestampInFilename: true,
    retainFiles: true,
  });
  conn.id = id;
  conn.connected = true;
  conn.path = "/test";
  conn.peerId = peerId;

  const errors: unknown[] = [];
  let notifyError!: () => void;
  const errorArrived = new Promise<void>((r) => (notifyError = r));
  conn.on("error", (err) => {
    errors.push(err);
    notifyError();
    // Intentionally do NOT call conn.stop() -- the poller must have already
    // stopped itself before the emit so the finally block does not reschedule.
  });

  conn.start();
  await Promise.race([
    errorArrived,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("timed out waiting for poll error")),
        2_000,
      ),
    ),
  ]);

  // Error fired exactly once.
  expect(errors).toHaveLength(1);
  // The error is classified as a UsageError (terminal protocol violation).
  expect(errors[0]).toBeInstanceOf(UsageError);
  expect((errors[0] as Error).message).toContain("more than one message file");

  // pollerActive must be false: the poller stopped itself before emitting.
  expect((conn as unknown as { pollerActive: boolean }).pollerActive).toBe(
    false,
  );

  // Wait two poll intervals and confirm no second error arrives (poller did not
  // reschedule). If the finally block had rescheduled, a second error would
  // arrive almost immediately.
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(errors).toHaveLength(1);
});

test("delete mode: poll() more-than-one-message error is a UsageError and stops the poller", async () => {
  // Delete mode keeps at most one outstanding message per direction (I9), so two
  // peer messages at once is a terminal protocol violation (a concurrent session
  // or a bug), not a retryable transport failure -- a UsageError that stops the
  // poller, matching the retain-mode duplicate-NNN case. Re-reading the same two
  // files cannot reconcile them.
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client);
  const peerId = "peer-sender";
  conn.peerId = peerId;

  // Two distinct, fully-synced delete-mode message files from the peer.
  files.set(`/test/${peerId}-10.json`, Buffer.from("a".repeat(10)));
  files.set(`/test/${peerId}-20.json`, Buffer.from("b".repeat(20)));

  const errors: unknown[] = [];
  let notifyError!: () => void;
  const errorArrived = new Promise<void>((r) => (notifyError = r));
  // Do NOT call stop() -- a terminal error must stop the poller on its own.
  conn.on("error", (err) => {
    errors.push(err);
    notifyError();
  });

  conn.start();
  await Promise.race([
    errorArrived,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("timed out waiting for poll error")),
        2_000,
      ),
    ),
  ]);

  expect(errors).toHaveLength(1);
  expect(errors[0]).toBeInstanceOf(UsageError);
  expect((errors[0] as Error).message).toContain("more than one message file");
  expect((conn as unknown as { pollerActive: boolean }).pollerActive).toBe(
    false,
  );
  // No second error: the poller did not reschedule.
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(errors).toHaveLength(1);
});

test("retain mode: poll() seq-mismatch (UsageError) stops the poller", async () => {
  // The seq-mismatch UsageError was already a UsageError before this change;
  // confirm it also stops the poller (finding #1), consistent with the
  // duplicate-NNN path above.
  const { client, files } = makeMockClient();
  const peerId = "peer-sender";
  const id = "receiver-me";

  // Plant a message whose body seq disagrees with the filename NNN (NNN=0,
  // body seq=99). The validator throws UsageError on the mismatch.
  const msg = objectMessage({ v: 1 }, 99);
  files.set(`/test/${peerId}-20260101T000000-000-${msg.length}.json`, msg);

  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    locklessRendezvous: true,
    timestampInFilename: true,
    retainFiles: true,
  });
  conn.id = id;
  conn.connected = true;
  conn.path = "/test";
  conn.peerId = peerId;

  const errors: unknown[] = [];
  let notifyError!: () => void;
  const errorArrived = new Promise<void>((r) => (notifyError = r));
  conn.on("error", (err) => {
    errors.push(err);
    notifyError();
    // Do NOT call stop() -- the poller must stop itself.
  });

  conn.start();
  await Promise.race([
    errorArrived,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("timed out waiting for poll error")),
        2_000,
      ),
    ),
  ]);

  expect(errors).toHaveLength(1);
  expect(errors[0]).toBeInstanceOf(UsageError);
  expect((errors[0] as Error).message).toContain("seq=");

  expect((conn as unknown as { pollerActive: boolean }).pollerActive).toBe(
    false,
  );

  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(errors).toHaveLength(1);
});

// --- finding #4: send() not-synchronized guard applies to non-retain mode ----

test("non-retain send() before synchronize() (peerId unset) throws 'not synchronized'", async () => {
  // Finding #4: the not-synchronized guard is hoisted to the top of send() and
  // now fires for both retain and non-retain modes.
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    // Explicitly NOT retain mode.
    retainFiles: false,
  });
  conn.connected = true;
  conn.path = "/test";
  // peerId is NOT set (synchronize() was not called).

  await expect(conn.send({ n: 1 })).rejects.toThrow("not synchronized");
});

// --- I8 counter seam: error-injection tests -----------------------------------
// Each test targets one of the three I8 rules: (a) seq advances only after a
// durable rename in send(), (b) recvSeq advances only after a successful emit
// in poll() and the ack is written before emit, (c) all counters reset via
// resetSessionState() at every session-boundary path.

test("I8: send() whose put throws -- seq unchanged, temp file cleaned up", async () => {
  // Rule (a): a write failure before the rename must not advance seq and must
  // leave no temp-*.tmp residue in the store.
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client);
  conn.peerId = "stub-peer";

  const seqBefore = conn.seq;

  // Track every safeDelete call so we can confirm the temp path was swept.
  const safeDeleted: string[] = [];
  const origSafeDelete = client.safeDelete.bind(client);
  client.safeDelete = async (p: string) => {
    safeDeleted.push(p);
    return origSafeDelete(p);
  };

  // Stub put to throw, making the temp write itself fail.
  client.put = async () => {
    throw new Error("synthetic put failure");
  };

  await expect(conn.send({ n: 1 })).rejects.toThrow("synthetic put failure");

  // seq must be unchanged -- the message slot was never durably written.
  expect(conn.seq).toBe(seqBefore);

  // The catch block in send() calls safeDelete(tempPath) even when put threw,
  // so the temp path was passed to safeDelete.
  expect(safeDeleted.length).toBeGreaterThanOrEqual(1);
  const tempSweep = safeDeleted.find((p) => p.endsWith(".tmp"));
  expect(tempSweep).toBeDefined();

  // No temp-*.tmp file must remain in the store.
  const tmpFiles = [...files.keys()].filter((p) => p.endsWith(".tmp"));
  expect(tmpFiles).toEqual([]);
});

test("I8: send() whose rename throws -- seq unchanged, temp file cleaned up", async () => {
  // Rule (a): rename failure (put succeeded, rename threw) must not advance seq
  // and must leave no orphaned temp-*.tmp. This test extends the existing
  // rename-failure coverage to confirm temp cleanup explicitly on the send path.
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client);
  conn.peerId = "stub-peer";

  const seqBefore = conn.seq;

  // Capture the temp path that put() actually wrote so the cleanup assertion
  // cannot pass vacuously (a refactor that skipped the temp write would leave
  // tempPath undefined and the check below would fail).
  let tempPath: string | undefined;
  const origPut = client.put.bind(client);
  client.put = async (src, dest, opts) => {
    await origPut(src, dest, opts);
    tempPath = dest;
  };

  const safeDeleted: string[] = [];
  const origSafeDelete = client.safeDelete.bind(client);
  client.safeDelete = async (p: string) => {
    safeDeleted.push(p);
    return origSafeDelete(p);
  };

  client.rename = async () => {
    throw new Error("synthetic rename failure");
  };

  await expect(conn.send({ n: 1 })).rejects.toThrow("synthetic rename failure");

  // seq must not have advanced.
  expect(conn.seq).toBe(seqBefore);

  // The temp file was written (a .tmp path)...
  expect(tempPath).toBeDefined();
  expect(tempPath!.endsWith(".tmp")).toBe(true);
  // ...and swept via safeDelete.
  expect(safeDeleted).toContain(tempPath!);
  // No temp-*.tmp residue on disk.
  const tmpFiles = [...files.keys()].filter((p) => p.endsWith(".tmp"));
  expect(tmpFiles).toEqual([]);
});

test("I8: retain send() ack-gate list throws -- send rejects rather than spinning", async () => {
  // Rule (a) + gateway liveness: when list() throws inside the ack-gate loop
  // (waiting for the peer's ack after the first send), send() must surface the
  // error rather than looping silently. Without this, a broken list() path would
  // spin until the TTL expires, which takes too long for a unit test.
  const { client } = makeMockClient();
  const id = "sender-me";
  const peerId = "peer-receiver";

  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    // Short TTL so a spin would be caught by the test runner.
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    locklessRendezvous: true,
    timestampInFilename: true,
    retainFiles: true,
  });
  conn.connected = true;
  conn.path = "/test";
  conn.id = id;
  conn.peerId = peerId;

  // First send: proceeds immediately (seq=0, no ack wait).
  await conn.send({ first: true });

  // Now stub list() to throw so the second send's ack-gate list fails.
  // The gate loop exits when list() rejects and the caught error is rethrown.
  client.list = async () => {
    throw new Error("synthetic list failure");
  };

  // Second send must reject (not spin to TTL expiry).
  await expect(conn.send({ second: true })).rejects.toThrow(
    "synthetic list failure",
  );
});

test("I8: poll() list throws -- error reaches the error event, recvSeq unchanged", async () => {
  // Rule (b): when list() throws inside poll(), the error must be emitted on
  // the "error" channel. recvSeq must not advance (no message was consumed).
  const { client } = makeMockClient();
  const peerId = "peer-sender";

  // Stub list to throw on every call so poll() fails immediately.
  client.list = async () => {
    throw new Error("synthetic list failure from poll");
  };

  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    locklessRendezvous: true,
    timestampInFilename: true,
    retainFiles: true,
  });
  conn.connected = true;
  conn.path = "/test";
  conn.id = "receiver-me";
  conn.peerId = peerId;

  const errors: unknown[] = [];
  let notifyError!: () => void;
  const errorArrived = new Promise<void>((r) => (notifyError = r));
  conn.on("error", (err) => {
    errors.push(err);
    conn.stop();
    notifyError();
  });

  const recvSeqBefore = (conn as unknown as { recvSeq: number }).recvSeq;

  conn.start();
  await Promise.race([
    errorArrived,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("timed out waiting for poll error")),
        2_000,
      ),
    ),
  ]);

  // Error must have been emitted.
  expect(errors).toHaveLength(1);
  expect((errors[0] as Error).message).toContain("synthetic list failure");

  // recvSeq must not have advanced -- no message was processed.
  const recvSeqAfter = (conn as unknown as { recvSeq: number }).recvSeq;
  expect(recvSeqAfter).toBe(recvSeqBefore);
});

test("I8: retain poll() ack-write failure -- recvSeq held, message reprocessed and acked once", async () => {
  // Rule (b), ack-write-failure variant (distinct from the emit-failure path
  // covered above): if writeAck() throws before lastAckedNNN is set, recvSeq
  // must NOT advance, so the never-deleted message is reprocessed on the next
  // poll. The retry writes the ack successfully -- exactly one ack and one
  // delivery, no double-ack and no skipped message.
  const { client, files } = makeMockClient();
  const peerId = "peer-sender";
  const id = "receiver-me";

  const message = objectMessage({ v: 1 });
  const msgName = `${peerId}-20260101T000000-000-${message.length}.json`;
  files.set(`/test/${msgName}`, message);

  // Fail the first ack rename, then allow subsequent ones. During poll() the ack
  // is the only file renamed to a -ack.json target (the message is read via
  // get()), so this isolates the ack write from the message read.
  let ackRenameAttempts = 0;
  const ackRenames: string[] = [];
  const origRename = client.rename.bind(client);
  client.rename = async (from: string, to: string) => {
    if (to.endsWith("-ack.json")) {
      ackRenameAttempts += 1;
      if (ackRenameAttempts === 1)
        throw new Error("synthetic ack rename failure");
      ackRenames.push(to);
    }
    return origRename(from, to);
  };

  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    locklessRendezvous: true,
    timestampInFilename: true,
    retainFiles: true,
  });
  conn.id = id;
  conn.connected = true;
  conn.path = "/test";
  conn.peerId = peerId;

  const received: unknown[] = [];
  const errors: unknown[] = [];
  let notifyReceived!: () => void;
  const delivered = new Promise<void>((r) => (notifyReceived = r));
  conn.on("data", (msg) => {
    received.push(msg);
    notifyReceived();
  });
  // Swallow the ack-write error so the poller keeps running and reprocesses
  // the retained message rather than tearing down.
  conn.on("error", (err) => {
    errors.push(err);
  });

  await runPoller(conn, delivered);

  // The ack write was attempted twice: it threw once, then succeeded.
  expect(ackRenameAttempts).toBe(2);
  // The failure surfaced on the error channel.
  expect(errors.length).toBeGreaterThanOrEqual(1);
  // The message was delivered exactly once...
  expect(received).toHaveLength(1);
  // ...recvSeq advanced exactly once, only after the successful ack + emit
  // (so it was held across the failed attempt)...
  expect((conn as unknown as { recvSeq: number }).recvSeq).toBe(1);
  // ...and exactly one ack persists on disk.
  expect(ackRenames).toHaveLength(1);
  const onDiskAcks = [...files.keys()].filter((p) => p.endsWith("-ack.json"));
  expect(onDiskAcks).toHaveLength(1);
});

// --- synchronize() entry precondition matrix ---------------------------------
// One mode-agnostic rule replaces the former generic + retain-specific guards:
// at synchronize() entry the directory must be empty except for at most one peer
// hello. The matrix is the full (file-kind x mode) cross-product of that rule,
// generated rather than hand-listed so a missing combination is structurally
// impossible. The only legal pre-entry states are an empty directory and a
// single peer hello (the case the old retain guard wrongly rejected); every
// other file kind can appear only AFTER entry and is rejected, in both modes.
// If a kind below is not a direct consequence of the rule, the rule -- not the
// matrix -- is wrong.

const ENTRY_SELF_ID = "00000000-0000-4000-8000-000000000001";
const ENTRY_PEER_ID = "ffffffff-ffff-4fff-bfff-ffffffffffff";
const ENTRY_PEER_ID_2 = "11111111-1111-4111-8111-111111111111";

// One row per file kind. `present` is what sits in the directory at entry. A
// peer hello on a proceed row is read through the HelloEnvelope gate, so the
// test body (below) gives it a full mode-matched envelope; every other kind is
// rejected on filename before any body read, so those bodies stay "{}". Outcome
// does not vary by mode (the rule is mode-agnostic), so each kind carries a
// single expected outcome and is run in both modes below.
const entryPreconditionKinds: Array<{
  kind: string;
  present: string[];
  outcome: "proceed" | "reject";
}> = [
  { kind: "empty directory", present: [], outcome: "proceed" },
  {
    kind: "one peer hello",
    present: [`${ENTRY_PEER_ID}-hello.json`],
    outcome: "proceed",
  },
  // A self-hello is a same-id leftover from a crashed session, not the peer's.
  {
    kind: "self-hello",
    present: [`${ENTRY_SELF_ID}-hello.json`],
    outcome: "reject",
  },
  // A bare "-hello.json" has an empty id: it is NOT a usable peer hello (it would
  // commit rendezvous to peerId="") and must be rejected as an unexpected
  // protocol file, never tolerated as a phantom peer.
  {
    kind: "empty-id hello",
    present: ["-hello.json"],
    outcome: "reject",
  },
  {
    kind: "two peer hellos",
    present: [`${ENTRY_PEER_ID}-hello.json`, `${ENTRY_PEER_ID_2}-hello.json`],
    outcome: "reject",
  },
  {
    kind: "lock file",
    present: [`${ENTRY_SELF_ID}-${ENTRY_PEER_ID}-lock.json`],
    outcome: "reject",
  },
  // A rendezvous ack marker (a crashed lockless session): a peer acking this
  // party's hello. Its terminal segment is `ack`, so it is not a peer hello.
  {
    kind: "rendezvous ack",
    present: [`${ENTRY_PEER_ID}-${ENTRY_SELF_ID}-hello-ack.json`],
    outcome: "reject",
  },
  // A joining sentinel left by a lock joiner that crashed mid-arrival. Its
  // terminal segment is the type word `joining`, so it is neither a peer hello
  // nor a message -- but the directory must be clean at entry, so the strict-
  // empty guard rejects it (and a fresh joiner must not adopt a stale one).
  {
    kind: "joining sentinel",
    present: [`${ENTRY_PEER_ID}-joining.json`],
    outcome: "reject",
  },
  // A stale non-timestamped message closes the pre-existing gap where the old
  // generic (delete-mode) guard let leftover messages through.
  {
    kind: "non-timestamped message",
    present: [`${ENTRY_PEER_ID}-42.json`],
    outcome: "reject",
  },
  {
    kind: "timestamped message",
    present: [`${ENTRY_PEER_ID}-20260101T000000-000-42.json`],
    outcome: "reject",
  },
  // A retain-mode message ack: the peer acking a message this party sent. The
  // embedded byte-count (2) is all digits but the terminal segment is `ack`.
  {
    kind: "message ack",
    present: [
      `${ENTRY_PEER_ID}-${ENTRY_SELF_ID}-20260101T000000-000-2-ack.json`,
    ],
    outcome: "reject",
  },
  // An orphaned in-flight temp file (a crashed send()/writeAck() artifact),
  // named with the protocol's own temp-<uuidv4()>.tmp shape, is swept at the
  // entry guard (193792285): deleted via safeDelete and added to the guard's
  // `ignored` set, so it proceeds past the guard rather than being rejected as a
  // strict-empty violation.
  {
    kind: "temp file",
    present: ["temp-00000000-0000-4000-8000-00000000abcd.tmp"],
    outcome: "proceed",
  },
  // A foreign temp-*.tmp whose stem is NOT a v4 UUID is not the protocol's temp
  // shape (198451188): it fails the grammar, so it is snapshotted and tolerated
  // like any other foreign file rather than swept. It proceeds past the guard
  // (then times out waiting for a peer), exactly as notes.txt does below.
  {
    kind: "foreign temp file",
    present: ["temp-export.tmp"],
    outcome: "proceed",
  },
  // A foreign (non-protocol) file is snapshotted and tolerated at entry
  // (195255994): names that FAIL the protocol grammar are not rejected, so it
  // proceeds past the guard (then times out waiting for a peer in this setup).
  // A message-shaped <id>-<digits>.json is NOT foreign -- it matches the grammar
  // and stays in the "reject" rows above.
  { kind: "foreign file", present: ["notes.txt"], outcome: "proceed" },
];

const entryPreconditionModes: Array<{ label: string; retain: boolean }> = [
  { label: "delete mode", retain: false },
  { label: "retain mode", retain: true },
];

const entryPreconditionCells = entryPreconditionModes.flatMap((mode) =>
  entryPreconditionKinds.map((k) => ({
    name: `${k.kind} (${mode.label})`,
    present: k.present,
    retain: mode.retain,
    outcome: k.outcome,
  })),
);

test.each(entryPreconditionCells)(
  "synchronize() entry precondition: $name -> $outcome",
  async ({ present, retain, outcome }) => {
    const { client, files } = makeMockClient();
    // A peer hello in the "proceed" row is read through the HelloEnvelope gate,
    // so it must advertise flags matching this conn's mode (193901017); other
    // present-file kinds are rejected on filename before any body read, so an
    // empty body is fine for them.
    const helloBody = Buffer.from(
      JSON.stringify({ locklessRendezvous: retain, retainFiles: retain }),
    );
    for (const name of present)
      files.set(
        `/test/${name}`,
        name.endsWith("-hello.json") ? helloBody : Buffer.from("{}"),
      );

    const conn = new FileSyncConnection(client, {
      pollingFrequency: 5,
      // A short TTL so the proceed rows with no live peer enter the rendezvous
      // wait and time out quickly with a transport Error (never a UsageError).
      timeToLive: new Date(Date.now() + 60),
      verbose: -1,
      locklessRendezvous: retain,
      timestampInFilename: retain,
      retainFiles: retain,
    });
    conn.id = ENTRY_SELF_ID;
    conn.connected = true;
    conn.path = "/test";

    const err = await conn.synchronize().catch((e: unknown) => e);
    if (outcome === "reject") {
      // The precondition guard rejects before any rendezvous I/O.
      expect(err).toBeInstanceOf(UsageError);
    } else {
      // Proceeds past the guard: it either completes rendezvous (the delete-mode
      // joiner fast-path with one peer hello) or enters the rendezvous wait and
      // times out with a transport Error -- never the precondition UsageError.
      expect(err).not.toBeInstanceOf(UsageError);
    }
  },
);

// --- entry guard: orphaned temp-*.tmp sweep (193792285) ----------------------
// At the I0 strict-empty entry guard the message loop has not started, so any
// temp-<uuid>.tmp (a send()/writeAck() in-flight write whose process was
// hard-killed before the rename to <id>.json) is necessarily orphaned. The
// guard sweeps it -- safeDelete then add to `ignored` -- rather than rejecting
// the directory as non-empty, so a prior crash's temp artifact is removed and
// entry is not aborted on its account.

test("synchronize() sweeps an orphaned temp file at the entry guard and does not abort", async () => {
  const { client, files } = makeMockClient();
  const conn = new FileSyncConnection(client, {
    pollingFrequency: 5,
    // Short TTL: with no peer hello the conn writes its own hello, enters the
    // rendezvous wait, and times out with a transport Error -- never the
    // strict-empty UsageError, which the guard would have thrown synchronously
    // had the temp not been swept.
    timeToLive: new Date(Date.now() + 60),
    verbose: -1,
  });
  conn.id = "00000000-0000-4000-8000-000000000001";
  conn.connected = true;
  conn.path = "/test";

  const tempPath = `/test/temp-11111111-1111-4111-8111-111111111111.tmp`;
  files.set(tempPath, Buffer.alloc(0));

  const safeDeleted: string[] = [];
  const origSafeDelete = client.safeDelete.bind(client);
  client.safeDelete = async (p) => {
    safeDeleted.push(p);
    return origSafeDelete(p);
  };

  const err = await conn.synchronize().catch((e: unknown) => e);

  // The guard did not abort on the temp's account: the error is the rendezvous
  // timeout (a transport Error), not the strict-empty UsageError.
  expect(err).not.toBeInstanceOf(UsageError);
  // The orphan was swept via safeDelete and is gone from the store.
  expect(safeDeleted).toContain(tempPath);
  expect(files.has(tempPath)).toBe(false);
});

test("synchronize() leaves a temp-free directory unaffected by the sweep", async () => {
  // No temp-*.tmp present: the sweep is a transparent no-op. The conn proceeds
  // exactly as before -- past the guard, into the rendezvous wait, timing out
  // with a transport Error rather than a UsageError -- and the sweep deletes no
  // .tmp file. (The lone safeDelete on this path is the outer catch sweeping
  // this party's own .json hello on the timeout, which the sweep never touches.)
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, {
    pollingFrequency: 5,
    timeToLive: new Date(Date.now() + 60),
    verbose: -1,
  });
  conn.id = "00000000-0000-4000-8000-000000000001";
  conn.connected = true;
  conn.path = "/test";

  const safeDeleted: string[] = [];
  const origSafeDelete = client.safeDelete.bind(client);
  client.safeDelete = async (p) => {
    safeDeleted.push(p);
    return origSafeDelete(p);
  };

  const err = await conn.synchronize().catch((e: unknown) => e);

  // Proceeded past the guard into the rendezvous wait (a timeout Error), rather
  // than being rejected there with the strict-empty UsageError.
  expect(err).not.toBeInstanceOf(UsageError);
  expect(String(err)).toContain("timed out");
  // The sweep matched nothing: no .tmp file was deleted.
  expect(safeDeleted.filter((p) => p.endsWith(".tmp"))).toHaveLength(0);
});

test("synchronize() sweeps a temp file alongside a single peer hello and completes rendezvous", async () => {
  // A temp-<uuid>.tmp orphan coexists with a lone peer hello. The sweep removes
  // the temp and excludes it from the I0 guard; the peer hello remains the one
  // tolerated entry file (per I0), so the joiner fast-path completes rendezvous
  // instead of the guard rejecting the directory as non-empty.
  const myId = "00000000-0000-4000-8000-000000000001";
  const peerId = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = myId;

  const tempPath = `${conn.path}/temp-22222222-2222-4222-9222-222222222222.tmp`;
  const peerHelloPath = `${conn.path}/${peerId}-hello.json`;
  files.set(tempPath, Buffer.alloc(0));
  files.set(peerHelloPath, LOCK_HELLO_BODY);

  await conn.synchronize();

  // Rendezvous completed via the joiner fast-path.
  expect(conn.peerId).toBe(peerId);
  expect(conn.handshakeRole).toBe("initiator");
  expect(conn.role).toBe("joiner");
  // The orphaned temp was swept ...
  expect(files.has(tempPath)).toBe(false);
  // ... the peer hello was consumed (the joiner deletes it) ...
  expect(files.has(peerHelloPath)).toBe(false);
  // ... and the joiner's own hello is now present (renamed from the sentinel).
  expect(files.has(`${conn.path}/${myId}-hello.json`)).toBe(true);
});

test("synchronize() sweeps multiple orphaned temp files at the entry guard", async () => {
  // The spec's motivating case: temp artifacts accumulate across several crashed
  // exchanges (distinct uuids). All are swept in one entry and none aborts the
  // guard -- exercising the N>1 path (Promise.all over many, the plural log
  // branch, multiple `ignored` entries) the single-temp tests above do not.
  const { client, files } = makeMockClient();
  const conn = new FileSyncConnection(client, {
    pollingFrequency: 5,
    timeToLive: new Date(Date.now() + 60),
    verbose: -1,
  });
  conn.id = "00000000-0000-4000-8000-000000000001";
  conn.connected = true;
  conn.path = "/test";

  const tempPaths = [
    `/test/temp-33333333-3333-4333-a333-333333333333.tmp`,
    `/test/temp-44444444-4444-4444-b444-444444444444.tmp`,
    `/test/temp-55555555-5555-4555-8555-555555555555.tmp`,
  ];
  for (const p of tempPaths) files.set(p, Buffer.alloc(0));

  const safeDeleted: string[] = [];
  const origSafeDelete = client.safeDelete.bind(client);
  client.safeDelete = async (p) => {
    safeDeleted.push(p);
    return origSafeDelete(p);
  };

  const err = await conn.synchronize().catch((e: unknown) => e);

  // Entry proceeded past the guard (a timeout Error), not rejected as non-empty.
  expect(err).not.toBeInstanceOf(UsageError);
  // Every orphan was swept via safeDelete and is gone from the store.
  for (const p of tempPaths) {
    expect(safeDeleted).toContain(p);
    expect(files.has(p)).toBe(false);
  }
});

test("synchronize() does NOT sweep a foreign temp-*.tmp whose stem is not a UUID; it is tolerated as foreign", async () => {
  // 198451188: the entry sweep matches only the protocol's own
  // temp-<uuidv4()>.tmp shape, so a foreign `temp-export.tmp` (a user or
  // sync-tool file in a namespace collision) is NOT deleted. It fails the
  // protocol grammar, so it is snapshotted and tolerated exactly as notes.txt
  // is -- the data-loss the broad `temp-`/`.tmp` match could cause is gone.
  const { client, files } = makeMockClient();
  const conn = new FileSyncConnection(client, {
    pollingFrequency: 5,
    timeToLive: new Date(Date.now() + 60),
    verbose: -1,
  });
  conn.id = "00000000-0000-4000-8000-000000000001";
  conn.connected = true;
  conn.path = "/test";

  const foreignTempPath = "/test/temp-export.tmp";
  files.set(foreignTempPath, Buffer.from("unrelated"));

  const safeDeleted: string[] = [];
  const origSafeDelete = client.safeDelete.bind(client);
  client.safeDelete = async (p) => {
    safeDeleted.push(p);
    return origSafeDelete(p);
  };

  const err = await conn.synchronize().catch((e: unknown) => e);

  // Proceeded past the guard (a timeout Error), tolerating the foreign temp.
  expect(err).not.toBeInstanceOf(UsageError);
  // The foreign temp survived: never swept, still on disk...
  expect(safeDeleted).not.toContain(foreignTempPath);
  expect(files.has(foreignTempPath)).toBe(true);
  // ...and recorded in the entry snapshot so the loop tolerates it.
  const snapshot = (conn as unknown as { foreignFileSnapshot: Set<string> })
    .foreignFileSnapshot;
  expect(snapshot.has("temp-export.tmp")).toBe(true);
});

test("synchronize() does NOT sweep a foreign temp whose stem is an UPPERCASE v4 UUID", async () => {
  // 198451188: the uuid package's validate() carries the /i flag, so an
  // uppercase-but-syntactically-valid v4 stem would pass a bare validate(); but
  // uuidv4() only ever emits lowercase, so the protocol's own temp is always
  // lowercase. A foreign temp-<UPPERCASE-v4>.tmp must therefore be treated as
  // foreign (not swept), closing the residual case-collision data-loss window.
  const { client, files } = makeMockClient();
  const conn = new FileSyncConnection(client, {
    pollingFrequency: 5,
    timeToLive: new Date(Date.now() + 60),
    verbose: -1,
  });
  conn.id = "00000000-0000-4000-8000-000000000001";
  conn.connected = true;
  conn.path = "/test";

  // A valid v4 UUID in uppercase -- accepted by a case-insensitive validate(),
  // rejected by the lowercase-only protocol-temp match.
  const foreignTempPath = "/test/temp-953D0248-D2F0-46F2-94DC-5082EED218F9.tmp";
  files.set(foreignTempPath, Buffer.from("unrelated"));

  const safeDeleted: string[] = [];
  const origSafeDelete = client.safeDelete.bind(client);
  client.safeDelete = async (p) => {
    safeDeleted.push(p);
    return origSafeDelete(p);
  };

  const err = await conn.synchronize().catch((e: unknown) => e);

  // Proceeded past the guard, tolerating the uppercase-stem foreign temp.
  expect(err).not.toBeInstanceOf(UsageError);
  // The foreign temp survived: never swept, still on disk...
  expect(safeDeleted).not.toContain(foreignTempPath);
  expect(files.has(foreignTempPath)).toBe(true);
  // ...and recorded in the entry snapshot so the loop tolerates it.
  const snapshot = (conn as unknown as { foreignFileSnapshot: Set<string> })
    .foreignFileSnapshot;
  expect(snapshot.has("temp-953D0248-D2F0-46F2-94DC-5082EED218F9.tmp")).toBe(
    true,
  );
});

test("poll(): the loop recognizes a real temp-<uuid>.tmp but treats a non-UUID temp-*.tmp as foreign", async () => {
  // 198451188: isRecognizedLoopFile narrows its temp branch to the protocol's
  // own temp-<uuidv4()>.tmp shape. A real protocol temp appearing mid-loop is
  // recognized (no warning); a foreign `temp-export.tmp` that is not in the
  // entry snapshot is not recognized and falls to the unexpected-file policy
  // (warned once under "warn"), proving the two shapes are handled differently.
  const errors: unknown[] = [];
  let listCount = 0;
  const [, logs] = await withCapturedLogs(async () => {
    const { client, files } = makeMockClient();
    const conn = await makeConnectedConn(client, { pollingFrequency: 5 });
    conn.peerId = "peer-test";
    conn.options.unexpectedFiles = "warn";
    // Both appear during the loop (neither is in the entry snapshot).
    files.set(
      "/test/temp-77777777-7777-4777-8777-777777777777.tmp",
      Buffer.alloc(0),
    );
    files.set("/test/temp-export.tmp", Buffer.from("unrelated"));
    conn.on("error", (err) => errors.push(err));

    let notifyEnough!: () => void;
    const enough = new Promise<void>((r) => (notifyEnough = r));
    const origList = client.list.bind(client);
    client.list = async (p: string) => {
      if (++listCount === 5) notifyEnough();
      return origList(p);
    };
    conn.start();
    try {
      await Promise.race([
        enough,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timed out")), 2_000),
        ),
      ]);
    } finally {
      conn.stop();
    }
  });
  expect(errors).toHaveLength(0);
  // The protocol temp is recognized -- never warned.
  expect(logs.filter((l) => l.message.includes("temp-77777777"))).toHaveLength(
    0,
  );
  // The foreign temp is warned exactly once.
  expect(
    logs.filter((l) => l.message.includes("temp-export.tmp")),
  ).toHaveLength(1);
});

// --- poll() error classification: terminal vs retryable ----------------------
// poll() stops the poller on a terminal error (re-reading the same bytes cannot
// help) and reschedules on a retryable one (a later attempt may succeed). The
// terminal class includes a fully-synced message that fails to parse or
// validate -- the missing case that let a corrupt, never-deleted retain-mode
// message re-read until the peer timeout. The retryable class includes a
// transient transport hiccup. (Seq/NNN-mismatch and duplicate-NNN terminal
// cases are covered by their own tests above.)

test("poll() terminal: a fully-synced message with an unparseable body stops the poller", async () => {
  const { client, files } = makeMockClient();
  const peerId = "peer-sender";
  // A valid binary envelope (MESSAGE_TYPE_OBJECT) wrapping a non-JSON payload, so
  // the size gate and envelope parse pass and poll() reaches the JSON parse step.
  // The filename declares the envelope's exact byte length so the size gate passes.
  const body = serializeFileSyncMessage(
    MESSAGE_TYPE_OBJECT,
    0,
    Buffer.from("this is not json"),
  );
  files.set(`/shared/${peerId}-20260101T000000-000-${body.length}.json`, body);
  const conn = makeRetainConn(client, "receiver-me", peerId);

  const errors: unknown[] = [];
  const received: unknown[] = [];
  let notifyError!: () => void;
  const errorArrived = new Promise<void>((r) => (notifyError = r));
  conn.on("data", (msg) => received.push(msg));
  // Do NOT call stop() -- a terminal error must stop the poller on its own.
  conn.on("error", (err) => {
    errors.push(err);
    notifyError();
  });

  conn.start();
  await Promise.race([
    errorArrived,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("timed out waiting for poll error")),
        2_000,
      ),
    ),
  ]);

  expect(errors).toHaveLength(1);
  expect(errors[0]).toBeInstanceOf(UsageError);
  expect((errors[0] as Error).message).toContain("not valid JSON");
  // The poller stopped itself; no payload delivered and no ack written.
  expect((conn as unknown as { pollerActive: boolean }).pollerActive).toBe(
    false,
  );
  expect(received).toHaveLength(0);
  expect([...files.keys()].some((p) => p.endsWith("-ack.json"))).toBe(false);
  // No second error arrives (the finally block did not reschedule).
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(errors).toHaveLength(1);
});

// The JSON.parse error itself carries peer bytes: V8 quotes a span of the
// offending input in its message (`Unexpected token 'x', "...." is not valid
// JSON`). The message body is fully peer-controlled (`payload: z.json()`), so
// that quoted span is a control/ANSI/Unicode injection vector one interpolation
// over from the filename -- it must be escaped like the filename and peerId.
async function pollUnparseableBodyError(payload: Buffer): Promise<Error> {
  const { client, files } = makeMockClient();
  const peerId = "peer-sender";
  // Wrap the malformed JSON payload in a valid envelope so the envelope parse
  // passes and the failure surfaces at the bounded JSON parse, where the peer's
  // payload bytes can be echoed back by V8's error and must be escaped.
  const body = serializeFileSyncMessage(MESSAGE_TYPE_OBJECT, 0, payload);
  files.set(`/shared/${peerId}-20260101T000000-000-${body.length}.json`, body);
  const conn = makeRetainConn(client, "receiver-me", peerId);

  const errors: unknown[] = [];
  let notifyError!: () => void;
  const errorArrived = new Promise<void>((r) => (notifyError = r));
  conn.on("error", (err) => {
    errors.push(err);
    notifyError();
  });
  conn.start();
  await Promise.race([
    errorArrived,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("timed out waiting for poll error")),
        2_000,
      ),
    ),
  ]);
  conn.stop();
  expect(errors).toHaveLength(1);
  expect(errors[0]).toBeInstanceOf(UsageError);
  return errors[0] as Error;
}

test("poll() terminal: the unparseable-body error escapes control/ANSI bytes echoed by the JSON parser", async () => {
  const err = await pollUnparseableBodyError(
    Buffer.from("\x1b[2J\x1b[31mEVIL not json"),
  );
  expect(err.message).toContain("not valid JSON");
  // The peer's raw ESC, quoted back by the parser, never reaches the terminal.
  expect(err.message).not.toContain("\x1b");
  expect(err.message).toContain("\\x1b");
});

test("poll() terminal: the unparseable-body error neutralizes deceptive Unicode echoed by the JSON parser", async () => {
  // Leading bidi-override (RLO), zero-width, and Cyrillic homoglyph -- all
  // invalid JSON starts, all quoted raw in V8's parse error, all escaped here.
  const err = await pollUnparseableBodyError(Buffer.from("‮​а not json"));
  expect(err.message).toContain("not valid JSON");
  expect(err.message).not.toContain("‮");
  expect(err.message).not.toContain("​");
  expect(err.message).not.toContain("а");
  expect(err.message).toContain("\\u202e");
});

test("poll() terminal: a fully-synced message with an unrecognized envelope stops the poller", async () => {
  const { client, files } = makeMockClient();
  const peerId = "peer-sender";
  // An old-format JSON message body: its first byte is `{` (0x7b), not the binary
  // envelope's version marker, so the envelope parse rejects it -- the clean
  // break with the pre-binary format surfaces as a terminal malformed-envelope
  // failure rather than a silent misparse.
  const body = Buffer.from(JSON.stringify({ not: "a message" }));
  files.set(`/shared/${peerId}-20260101T000000-000-${body.length}.json`, body);
  const conn = makeRetainConn(client, "receiver-me", peerId);

  const errors: unknown[] = [];
  const received: unknown[] = [];
  let notifyError!: () => void;
  const errorArrived = new Promise<void>((r) => (notifyError = r));
  conn.on("data", (msg) => received.push(msg));
  conn.on("error", (err) => {
    errors.push(err);
    notifyError();
  });

  conn.start();
  await Promise.race([
    errorArrived,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("timed out waiting for poll error")),
        2_000,
      ),
    ),
  ]);

  expect(errors).toHaveLength(1);
  expect(errors[0]).toBeInstanceOf(UsageError);
  expect((errors[0] as Error).message).toContain("malformed envelope");
  expect((conn as unknown as { pollerActive: boolean }).pollerActive).toBe(
    false,
  );
  expect(received).toHaveLength(0);
  expect([...files.keys()].some((p) => p.endsWith("-ack.json"))).toBe(false);
});

test("poll() retryable: a transient list() failure reschedules and the message is delivered on a later cycle", async () => {
  const { client, files } = makeMockClient();
  const peerId = "peer-sender";
  const body = objectMessage({ v: 1 });
  files.set(`/shared/${peerId}-20260101T000000-000-${body.length}.json`, body);
  const conn = makeRetainConn(client, "receiver-me", peerId);

  // Throw on the first list() only, then defer to the real listing. A transient
  // transport failure is retryable: the poller must reschedule and deliver.
  let listCalls = 0;
  const realList = client.list.bind(client);
  client.list = async (dir: string) => {
    listCalls += 1;
    if (listCalls === 1) throw new Error("transient list failure");
    return realList(dir);
  };

  const errors: unknown[] = [];
  const received: unknown[] = [];
  let notifyReceived!: () => void;
  const delivered = new Promise<void>((r) => (notifyReceived = r));
  conn.on("data", (msg) => {
    received.push(msg);
    notifyReceived();
  });
  // Record the transient error but keep the poller running.
  conn.on("error", (err) => errors.push(err));

  await runPoller(conn, delivered);

  // The transient error surfaced but was not terminal...
  expect(errors.length).toBeGreaterThanOrEqual(1);
  expect(errors[0]).not.toBeInstanceOf(UsageError);
  // ...and the poller rescheduled and delivered the message exactly once.
  expect(received).toHaveLength(1);
  expect((conn as unknown as { recvSeq: number }).recvSeq).toBe(1);
});

test("composed via fromEventConnection: the first transient poll() error is terminal -- receive() fails once naming the cause, and the poller does not reschedule", async () => {
  // The isolation test directly above proves a transient list() failure is
  // retryable: poll() reschedules and delivers on a later cycle. That is a
  // property of poll() STANDALONE. In the CLI a FileSyncConnection is never
  // consumed directly -- apps/cli/src/protocol.ts always bridges it through
  // fromEventConnection (fromEventConnection -> conn.start() -> mc.receive()),
  // whose error listener routes every emitted poll() error into
  // QueuedMessageConnection.fail(). fail() synchronously calls hooks.close() ->
  // conn.close(), whose first statement -- before any await -- is conn.stop(),
  // so pollerActive is cleared within that synchronous prefix, before poll()'s
  // finally runs; the first emitted error is therefore terminal and the
  // reschedule never happens. This pins that composed contract alongside the
  // isolation tests; see the "Production composition note" under I8 in
  // docs/spec/FILE_SYNC.md.
  const { client, files } = makeMockClient();
  const peerId = "peer-sender";
  const body = objectMessage({ v: 1 });
  files.set(`/shared/${peerId}-20260101T000000-000-${body.length}.json`, body);
  const conn = makeRetainConn(client, "receiver-me", peerId);

  // The SAME injection the isolation test uses: a transient list() failure that
  // throws only on the first call. In isolation the poller reschedules and the
  // second list() delivers the message; under composition the first emit is
  // terminal, so the second list() never runs.
  let listCalls = 0;
  const realList = client.list.bind(client);
  client.list = async (dir: string) => {
    listCalls += 1;
    if (listCalls === 1) throw new Error("transient list failure");
    return realList(dir);
  };

  // Compose through the production bridge and drive the protocol layer's
  // awaited receive(), exactly as protocol.ts does (conn.start() then
  // mc.receive()). No conn.on("data") proxy is attached: delivery is the
  // bridge's job, and "no message was delivered" is proven below by recvSeq
  // staying 0 (poll() advances it only after a successful emit), not by a
  // parallel raw-connection listener that would shadow the bridge's own.
  const mc = fromEventConnection(conn);
  conn.start();

  // Bound the receive so a future async-scheduling regression that never
  // delivers the poll error fails fast (with the bridge's "gone silent"
  // inactivity error, which the assertions below reject) instead of hanging for
  // the full default inactivity window. The real poll error fires on the first
  // cycle, far inside this bound, so it always wins the race.
  const err = await mc.receive(1_000).then(
    () => {
      throw new Error(
        "receive() resolved; expected the poll error to reject it",
      );
    },
    (e: unknown) => e,
  );

  // The surfaced error names the underlying cause (the injected transport
  // failure), carried as a transport ConnectionError with that cause attached
  // -- NOT the bridge's generic peer-silence inactivity message.
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("transport");
  expect((err as Error).message).toContain("transient list failure");
  expect((err as Error).message).not.toContain("gone silent");
  expect((err as ConnectionError).cause).toBeInstanceOf(Error);
  expect(((err as ConnectionError).cause as Error).message).toBe(
    "transient list failure",
  );

  // The connection stopped: stop() (close()'s synchronous first statement,
  // reached via fail() -> close()) cleared pollerActive inside the emit, before
  // poll()'s finally could reschedule.
  expect((conn as unknown as { pollerActive: boolean }).pollerActive).toBe(
    false,
  );

  // The poller did not reschedule: across several polling intervals the message
  // is never reprocessed -- list() ran exactly once (the failed call) and
  // recvSeq never advanced, so the message was neither read nor delivered. (In
  // isolation this same setup advances recvSeq to 1 and delivers the message.)
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(listCalls).toBe(1);
  expect((conn as unknown as { recvSeq: number }).recvSeq).toBe(0);
});

test("poll() terminal: delete mode also stops the poller on a fully-synced corrupt message", async () => {
  // The terminal-parse rule is mode-agnostic. In delete mode poll() parses
  // before deleting, so a corrupt fully-synced file stops the poller AND is left
  // on disk for inspection -- it no longer silently drops-and-continues as it
  // did before this change (the deliberate "both modes" behavior change).
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client);
  const peerId = "peer-sender";
  conn.peerId = peerId;

  // Non-timestamped delete-mode message name; a valid envelope wrapping a
  // non-JSON payload, so poll() reaches (and fails at) the JSON parse.
  const body = serializeFileSyncMessage(
    MESSAGE_TYPE_OBJECT,
    0,
    Buffer.from("not json"),
  );
  const msgName = `${peerId}-${body.length}.json`;
  files.set(`/test/${msgName}`, body);

  const errors: unknown[] = [];
  const received: unknown[] = [];
  let notifyError!: () => void;
  const errorArrived = new Promise<void>((r) => (notifyError = r));
  conn.on("data", (msg) => received.push(msg));
  conn.on("error", (err) => {
    errors.push(err);
    notifyError();
  });

  conn.start();
  await Promise.race([
    errorArrived,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("timed out waiting for poll error")),
        2_000,
      ),
    ),
  ]);

  expect(errors).toHaveLength(1);
  expect(errors[0]).toBeInstanceOf(UsageError);
  expect((errors[0] as Error).message).toContain("not valid JSON");
  expect((conn as unknown as { pollerActive: boolean }).pollerActive).toBe(
    false,
  );
  expect(received).toHaveLength(0);
  // parse-before-delete: the corrupt file is left on disk for inspection.
  expect(files.has(`/test/${msgName}`)).toBe(true);
  // No second error: the finally block did not reschedule.
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(errors).toHaveLength(1);
});

test("poll() delivers a binary frame as raw bytes (no base64, no JSON wrapper)", async () => {
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client);
  const peerId = "peer-sender";
  conn.peerId = peerId;

  // A raw binary frame -- the shape an encrypted AEAD envelope takes on the wire
  // -- carried verbatim in the binary message envelope. The 0x7b (`{`) byte
  // proves a binary frame is not confused with a JSON control body.
  const frame = Uint8Array.from([0x01, 0x00, 0xff, 0x7b, 0xde, 0xad]);
  const body = binaryMessage(frame);
  files.set(`/test/${peerId}-${body.length}.json`, body);

  const received: unknown[] = [];
  let notify!: () => void;
  const delivered = new Promise<void>((r) => (notify = r));
  conn.on("data", (m) => {
    received.push(m);
    notify();
  });
  conn.on("error", () => {});
  conn.start();
  await Promise.race([
    delivered,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timed out waiting for frame")), 2_000),
    ),
  ]);
  conn.stop();

  expect(received).toHaveLength(1);
  expect(received[0]).toBeInstanceOf(Uint8Array);
  expect(Array.from(received[0] as Uint8Array)).toEqual(Array.from(frame));
});

test("poll() reads a binary frame whose size would exceed Node's max string length (never stringified)", async () => {
  // The old read path .toString()'d every frame before parsing, so a frame above
  // Node's maximum string length (~512 MiB) could not be read at all regardless
  // of memory -- the ceiling MAX_FRAME_SIZE_BYTES was anchored to. The binary
  // read path never stringifies a frame, lifting that artificial ceiling. A true
  // >512 MiB allocation is too heavy for CI, so this proxies the failure mode: a
  // frame buffer whose toString() throws exactly as Buffer.prototype.toString()
  // does above the string limit. If a regression reintroduced a .toString() on
  // the frame, this delivery would throw instead of succeeding.
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client);
  const peerId = "peer-sender";
  conn.peerId = peerId;

  const frame = Uint8Array.from([0x01, 0x02, 0x03, 0x04]);
  const body = binaryMessage(frame);
  Object.defineProperty(body, "toString", {
    value: () => {
      throw new RangeError(
        "Cannot create a string longer than 0x1fffffe8 characters",
      );
    },
  });
  files.set(`/test/${peerId}-${body.length}.json`, body);

  const received: unknown[] = [];
  const errors: unknown[] = [];
  let notify!: () => void;
  const settled = new Promise<void>((r) => (notify = r));
  conn.on("data", (m) => {
    received.push(m);
    notify();
  });
  conn.on("error", (e) => {
    errors.push(e);
    notify();
  });
  conn.start();
  await Promise.race([
    settled,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timed out waiting for frame")), 2_000),
    ),
  ]);
  conn.stop();

  expect(errors).toEqual([]);
  expect(received).toHaveLength(1);
  expect(received[0]).toBeInstanceOf(Uint8Array);
  expect(Array.from(received[0] as Uint8Array)).toEqual(Array.from(frame));
});

test("poll() terminal: a message envelope seq above MAX_SAFE_INTEGER is rejected", async () => {
  // The 8-byte seq field is read as BigInt and range-checked before narrowing to
  // a Number, mirroring the AEAD decorator's inbound-seq guard: a hostile peer
  // writing a seq above 2^53 is rejected as a malformed envelope rather than
  // narrowed to a precision-lost value the retain-mode cross-check would have to
  // fail-safe on.
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client);
  const peerId = "peer-sender";
  conn.peerId = peerId;

  const body = binaryMessage(
    Uint8Array.from([1, 2, 3, 4]),
    Number.MAX_SAFE_INTEGER + 1,
  );
  files.set(`/test/${peerId}-${body.length}.json`, body);

  const errors: unknown[] = [];
  const received: unknown[] = [];
  let notify!: () => void;
  const settled = new Promise<void>((r) => (notify = r));
  conn.on("data", (m) => {
    received.push(m);
    notify();
  });
  conn.on("error", (e) => {
    errors.push(e);
    notify();
  });
  conn.start();
  await Promise.race([
    settled,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timed out waiting for error")), 2_000),
    ),
  ]);
  conn.stop();

  expect(received).toEqual([]);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toBeInstanceOf(UsageError);
  expect((errors[0] as Error).message).toContain("exceeds safe range");
});

test("retain mode: send() honors an ack already on disk even when the TTL has elapsed", async () => {
  // Regression guard for the ack-gate ordering: the loop checks for the
  // qualifying ack BEFORE the deadline, so an ack present when send() is entered
  // is honored rather than discarded as a spurious timeout.
  const { client, files } = makeMockClient();
  const id = "sender-me";
  const peerId = "peer-receiver";
  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    // TTL already in the past: a deadline-first loop would throw immediately.
    timeToLive: new Date(Date.now() - 1),
    verbose: -1,
    locklessRendezvous: true,
    timestampInFilename: true,
    retainFiles: true,
  });
  conn.connected = true;
  conn.path = "/test";
  conn.id = id;
  conn.peerId = peerId;

  // First send (seq=0) proceeds without the gate even with an elapsed TTL, and
  // records the sent message as lastSentFile. Plant the ack of that message so
  // the next send's gate finds it on its first check.
  await conn.send({ n: 1 });
  const stem = lastSentStem(files, "/test", id);
  files.set(`/test/${peerId}-${stem}-ack.json`, Buffer.alloc(0));

  // Must not throw a timeout: the ack is present, so send() proceeds and writes
  // the next message even though the TTL has already elapsed.
  await expect(conn.send({ n: 2 })).resolves.toBeUndefined();
  expect(conn.seq).toBe(2);
});

// --- unified ack marker: determinism, grammar routing, construct-and-match ---

test("retain mode: writeAck is deterministic and idempotent by name (hyphen-containing id)", async () => {
  // The marker name is a pure function of this party's id and the acknowledged
  // file's fixed name, so two writes for the same message yield the identical
  // name and a single zero-length file -- no duplicate even if the per-message
  // write guard is bypassed. `site-a` exercises a hyphen-containing id, proving
  // the name is built by concatenation and never split back into ids.
  const { client, files } = makeMockClient();
  const conn = makeRetainConn(client, "site-a", "b"); // path "/shared"
  const writeAck = (
    conn as unknown as {
      writeAck: (dir: string, originalName: string) => Promise<string>;
    }
  ).writeAck.bind(conn);

  const messageName = "b-20260101T000000-000-42.json";
  const originalName = messageName.slice(0, -".json".length);

  const first = await writeAck("/shared", originalName);
  const second = await writeAck("/shared", originalName);

  expect(first).toBe("site-a-b-20260101T000000-000-42-ack.json");
  expect(second).toBe(first);
  const acks = [...files.keys()].filter((p) => p.endsWith("-ack.json"));
  expect(acks).toHaveLength(1);
  expect(files.get(`/shared/${first}`)!.length).toBe(0);
});

test("poll(): a message-ack with an all-digit embedded byte count is not routed as a message", async () => {
  // Grammar routing keys on the terminal segment only. A message-ack's embedded
  // <byteCount> (42) is all digits, but the terminal segment is `ack`, so poll()
  // never delivers it and recvSeq does not advance.
  const { client, files } = makeMockClient();
  const peerId = "peer-sender";
  const id = "receiver-me";
  files.set(
    `/shared/${peerId}-${id}-20260101T000000-000-42-ack.json`,
    Buffer.alloc(0),
  );
  const conn = makeRetainConn(client, id, peerId); // path "/shared"

  const received: unknown[] = [];
  conn.on("data", (m) => received.push(m));
  conn.on("error", () => {});

  conn.start();
  await new Promise((r) => setTimeout(r, 60));
  conn.stop();

  expect(received).toHaveLength(0);
  expect((conn as unknown as { recvSeq: number }).recvSeq).toBe(0);
});

test("delete mode: hasOutstandingMessage ignores a `<id>-...-ack.json` file (numeric mid-name)", async () => {
  // The delete-mode sender's outstanding-message scan uses the grammar
  // discriminant, so a marker this party wrote -- whose embedded byte count (42)
  // is all digits but whose terminal segment is `ack` -- is not mistaken for an
  // unconsumed message. send() proceeds rather than spinning to the TTL.
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { timeToLiveMs: 300 });
  conn.id = "me";
  conn.peerId = "peer";
  files.set(`/test/me-peer-20260101T000000-000-42-ack.json`, Buffer.alloc(0));

  await expect(conn.send({ n: 1 })).resolves.toBeUndefined();
});

test.each([
  { a: "site-a", b: "b" }, // hyphen-containing id
  { a: "ack", b: "b" }, // id equal to a type word
])(
  "lockless+retain construct-and-match: ids $a / $b complete rendezvous and exchange messages",
  async ({ a, b }) => {
    // Both the rendezvous ack and the message ack are matched by constructing the
    // expected name from the ids and filenames each end already holds -- never by
    // splitting the two concatenated ids out of a marker. A hyphen-containing id
    // (`site-a`) and an id equal to a type word (`ack`) both round-trip.
    const sharedFiles = new Map<string, Buffer>();
    const makeClient = (): FileTransportClient => ({
      connect: async () => {},
      end: async () => {},
      list: async (dir: string): Promise<FileInfo[]> => {
        const prefix = dir.endsWith("/") ? dir : `${dir}/`;
        return [...sharedFiles.entries()]
          .filter(
            ([p]) =>
              p.startsWith(prefix) && !p.slice(prefix.length).includes("/"),
          )
          .map(([p, buf]) => ({
            name: p.slice(prefix.length),
            modifyTime: 0,
            size: buf.length,
          }));
      },
      get: async (path: string) => {
        const data = sharedFiles.get(path);
        if (data === undefined) throw new Error(`${path}: not found`);
        return data as Buffer<ArrayBufferLike>;
      },
      put: async (
        src: string | Buffer | Uint8Array[] | NodeJS.ReadableStream,
        dest: string,
      ) => {
        sharedFiles.set(dest, await putSrcBytes(src));
      },
      delete: async () => {
        throw new Error("delete not supported on this transport");
      },
      safeDelete: async () => {},
      rename: async (from: string, to: string) => {
        const data = sharedFiles.get(from);
        if (data === undefined) throw new Error(`${from}: no such file`);
        sharedFiles.delete(from);
        sharedFiles.set(to, data);
      },
      createExclusive: async () => {
        throw new Error("createExclusive not supported on this transport");
      },
      exists: async (path: string) => sharedFiles.has(path),
    });

    const makeConn = (id: string) => {
      const c = new FileSyncConnection(makeClient(), {
        pollingFrequency: 10,
        timeToLive: new Date(Date.now() + 5_000),
        verbose: -1,
        locklessRendezvous: true,
        timestampInFilename: true,
        retainFiles: true,
      });
      c.id = id;
      c.connected = true;
      c.path = "/shared";
      return c;
    };

    const connA = makeConn(a);
    const connB = makeConn(b);

    await Promise.all([connA.synchronize(), connB.synchronize()]);
    expect(connA.peerId).toBe(b);
    expect(connB.peerId).toBe(a);

    // B receives two messages from A; the ack gate serializes them with no
    // id-splitting of any marker name.
    const received: unknown[] = [];
    let resolveAll!: () => void;
    const allReceived = new Promise<void>((r) => (resolveAll = r));
    connB.on("data", (m) => {
      received.push(m);
      if (received.length === 2) resolveAll();
    });

    const sending = (async () => {
      await connA.send({ n: 1 });
      await connA.send({ n: 2 });
    })();

    await runPoller(connB, allReceived);
    await sending;

    expect(received).toHaveLength(2);
    expect((received[0] as { n: number }).n).toBe(1);
    expect((received[1] as { n: number }).n).toBe(2);
  },
);

// --- unexpected files mid-exchange (enforcement site 3) ----------------------
//
// poll() classifies every file in the listing: a peer message, a file
// recognized for the loop (both hellos, both acks, the lock, both parties'
// messages and message-acks, our own writes, in-flight temp), or an unexpected
// foreign file handled per `unexpectedFiles`. Separately, a peer-prefixed
// retain-mode message with a byte-count terminal but no parseable NNN is a
// terminal malformed-protocol error regardless of `unexpectedFiles`.

test("poll(): an unrecognized file mid-loop is a terminal UsageError under the default error policy (plain transport)", async () => {
  // makeConnectedConn yields a plain delete-mode filedrop conn (no retain or
  // lockless, unexpectedFiles unset), so the effective policy resolves to error.
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.peerId = "peer-test";

  // A net-new foreign file appears during the loop.
  files.set("/test/intruder.json", Buffer.from("x"));

  const errors: unknown[] = [];
  let notifyError!: () => void;
  const errorArrived = new Promise<void>((r) => (notifyError = r));
  // Do NOT call stop() -- a terminal error must stop the poller on its own.
  conn.on("error", (err) => {
    errors.push(err);
    notifyError();
  });

  conn.start();
  await Promise.race([
    errorArrived,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("timed out waiting for poll error")),
        2_000,
      ),
    ),
  ]);

  expect(errors).toHaveLength(1);
  expect(errors[0]).toBeInstanceOf(UsageError);
  expect((errors[0] as Error).message).toContain("intruder.json");
  expect((errors[0] as Error).message).toContain("/test");
  // The poller stopped itself before emitting (UsageError is terminal).
  expect((conn as unknown as { pollerActive: boolean }).pollerActive).toBe(
    false,
  );
});

// The foreign/unexpected-file handler is the highest-priority live injection
// vector: a foreign filename passes every existing guard (length, count,
// protocol grammar) and was interpolated raw into the terminal error. These pin
// that its partner-controlled name is now routed through sanitizeForDisplay,
// mirroring the sanitizeForDisplay categories. Driven through the default error
// policy, the same path the ordinary-name test above exercises.
async function pollForeignFileError(hostileName: string): Promise<Error> {
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.peerId = "peer-test";
  files.set(`/test/${hostileName}`, Buffer.from("x"));

  const errors: unknown[] = [];
  let notifyError!: () => void;
  const errorArrived = new Promise<void>((r) => (notifyError = r));
  conn.on("error", (err) => {
    errors.push(err);
    notifyError();
  });
  conn.start();
  await Promise.race([
    errorArrived,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("timed out waiting for poll error")),
        2_000,
      ),
    ),
  ]);
  conn.stop();
  expect(errors).toHaveLength(1);
  expect(errors[0]).toBeInstanceOf(UsageError);
  return errors[0] as Error;
}

test("poll(): the unexpected-file error escapes control/ANSI in a foreign filename", async () => {
  const err = await pollForeignFileError("\x1b[2J\x1b[31mEVIL.json");
  // The raw ESC that drives the sequence never reaches the operator's terminal;
  // it survives only as the inert escaped text.
  expect(err.message).not.toContain("\x1b");
  expect(err.message).toContain("\\x1b");
});

test("poll(): the unexpected-file error escapes a newline in a foreign filename", async () => {
  const err = await pollForeignFileError("ok.json\nFAKE: all clear");
  expect(err.message).not.toContain("\n");
  expect(err.message).toContain("\\x0a");
});

test("poll(): the unexpected-file error neutralizes deceptive Unicode in a foreign filename", async () => {
  // A bidi override (RLO), a zero-width char, and a Cyrillic homoglyph -- all
  // invisible or misleading rendered raw, all escaped here.
  const err = await pollForeignFileError("a‮b​cаd.json");
  expect(err.message).not.toContain("‮");
  expect(err.message).not.toContain("​");
  expect(err.message).not.toContain("а");
  expect(err.message).toContain("\\u202e");
  expect(err.message).toContain("\\u200b");
  expect(err.message).toContain("\\u0430");
});

test("poll(): the unexpected-file error passes an ordinary printable filename through unchanged", async () => {
  const err = await pollForeignFileError("conflicted-copy.json");
  expect(err.message).toContain("conflicted-copy.json");
});

test("poll(): a peer-derived peerId with control/ANSI is escaped in a terminal error", async () => {
  // The duplicate-message guard names the peer id but no filename, so it
  // isolates peerId neutralization. The id is sliced from a hello filename
  // prefix at rendezvous, so it carries the partner's bytes.
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  const hostilePeerId = "peer\x1b[31m";
  conn.peerId = hostilePeerId;
  // Two delete-mode peer messages (distinct byte-count terminals) trip the
  // "more than one message file from <peerId>" terminal UsageError.
  files.set(`/test/${hostilePeerId}-5.json`, Buffer.from("12345"));
  files.set(`/test/${hostilePeerId}-6.json`, Buffer.from("123456"));

  const errors: unknown[] = [];
  let notifyError!: () => void;
  const errorArrived = new Promise<void>((r) => (notifyError = r));
  conn.on("error", (err) => {
    errors.push(err);
    notifyError();
  });
  conn.start();
  await Promise.race([
    errorArrived,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("timed out waiting for poll error")),
        2_000,
      ),
    ),
  ]);

  expect(errors).toHaveLength(1);
  expect(errors[0]).toBeInstanceOf(UsageError);
  const message = (errors[0] as Error).message;
  // The peer id is the only hostile content in this message (the path is the
  // ASCII /test), so a clean message proves peerId is routed through sanitize.
  expect(message).toContain("more than one message file");
  expect(message).not.toContain("\x1b");
  expect(message).toContain("\\x1b");
});

test("poll(): an unrecognized file mid-loop warns once per name under the warn policy", async () => {
  let listCount = 0;
  const errors: unknown[] = [];
  const [, logs] = await withCapturedLogs(async () => {
    const { client, files } = makeMockClient();
    const conn = await makeConnectedConn(client, { pollingFrequency: 5 });
    conn.peerId = "peer-test";
    conn.options.unexpectedFiles = "warn";
    files.set("/test/intruder.json", Buffer.from("x"));
    conn.on("error", (err) => errors.push(err));

    // Resolve after several poll cycles so the once-per-name dedup is exercised
    // across multiple passes, not just one.
    let notifyEnough!: () => void;
    const enough = new Promise<void>((r) => (notifyEnough = r));
    const origList = client.list.bind(client);
    client.list = async (p: string) => {
      if (++listCount === 5) notifyEnough();
      return origList(p);
    };
    conn.start();
    try {
      await Promise.race([
        enough,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("timed out waiting for poll cycles")),
            2_000,
          ),
        ),
      ]);
    } finally {
      conn.stop();
    }
  });

  // warn does not abort the exchange.
  expect(errors).toHaveLength(0);
  // Several poll cycles ran...
  expect(listCount).toBeGreaterThanOrEqual(5);
  // ...but the file was warned about exactly once, not every cycle.
  const warns = logs.filter((l) => l.message.includes("intruder.json"));
  expect(warns).toHaveLength(1);
});

test("poll(): an unrecognized file mid-loop is silently skipped under the ignore policy", async () => {
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 5 });
  conn.peerId = "peer-test";
  conn.options.unexpectedFiles = "ignore";
  files.set("/test/intruder.json", Buffer.from("x"));

  const errors: unknown[] = [];
  conn.on("error", (err) => errors.push(err));

  let listCount = 0;
  let notifyEnough!: () => void;
  const enough = new Promise<void>((r) => (notifyEnough = r));
  const origList = client.list.bind(client);
  client.list = async (p: string) => {
    if (++listCount === 5) notifyEnough();
    return origList(p);
  };
  conn.start();
  try {
    await Promise.race([
      enough,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("timed out waiting for poll cycles")),
          2_000,
        ),
      ),
    ]);
    // The poller is still running -- the foreign file did not stop it...
    expect((conn as unknown as { pollerActive: boolean }).pollerActive).toBe(
      true,
    );
  } finally {
    conn.stop();
  }
  // ...and no error was emitted.
  expect(errors).toHaveLength(0);
});

test("poll(): with retain_files set and unexpected_files unset, a mid-session conflict file warns rather than aborts", async () => {
  const errors: unknown[] = [];
  let listCount = 0;
  const [, logs] = await withCapturedLogs(async () => {
    const { client, files } = makeMockClient();
    // retainFiles set, unexpectedFiles unset -> effective default resolves to warn.
    const conn = new FileSyncConnection(client, {
      pollingFrequency: 5,
      timeToLive: new Date(Date.now() + 5_000),
      verbose: -1,
      locklessRendezvous: true,
      timestampInFilename: true,
      retainFiles: true,
    });
    conn.id = "me";
    conn.connected = true;
    conn.path = "/test";
    conn.peerId = "peer";
    conn.on("error", (err) => errors.push(err));

    // A cloud-sync conflict copy: peer-prefixed but a non-grammar terminal.
    files.set("/test/peer-100 (conflicted copy).json", Buffer.from("x"));

    let notifyEnough!: () => void;
    const enough = new Promise<void>((r) => (notifyEnough = r));
    const origList = client.list.bind(client);
    client.list = async (p: string) => {
      if (++listCount === 5) notifyEnough();
      return origList(p);
    };
    conn.start();
    try {
      await Promise.race([
        enough,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("timed out waiting for poll cycles")),
            2_000,
          ),
        ),
      ]);
    } finally {
      conn.stop();
    }
  });

  expect(errors).toHaveLength(0);
  const warns = logs.filter((l) => l.message.includes("conflicted copy"));
  expect(warns).toHaveLength(1);
});

test("poll(): with lockless_rendezvous set (retain off) and unexpected_files unset, the warn default still applies", async () => {
  // Isolates the lockless-only branch of the mode-coupled default: with
  // retainFiles false, the `retainFiles || locklessRendezvous` resolution must
  // still yield warn. An `||` -> `&&` regression would resolve to error here.
  const errors: unknown[] = [];
  let listCount = 0;
  const [, logs] = await withCapturedLogs(async () => {
    const { client, files } = makeMockClient();
    const conn = new FileSyncConnection(client, {
      pollingFrequency: 5,
      timeToLive: new Date(Date.now() + 5_000),
      verbose: -1,
      locklessRendezvous: true,
    });
    conn.id = "me";
    conn.connected = true;
    conn.path = "/test";
    conn.peerId = "peer";
    conn.on("error", (err) => errors.push(err));

    files.set("/test/intruder.json", Buffer.from("x"));

    let notifyEnough!: () => void;
    const enough = new Promise<void>((r) => (notifyEnough = r));
    const origList = client.list.bind(client);
    client.list = async (p: string) => {
      if (++listCount === 5) notifyEnough();
      return origList(p);
    };
    conn.start();
    try {
      await Promise.race([
        enough,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("timed out waiting for poll cycles")),
            2_000,
          ),
        ),
      ]);
    } finally {
      conn.stop();
    }
  });

  expect(errors).toHaveLength(0);
  const warns = logs.filter((l) => l.message.includes("intruder.json"));
  expect(warns).toHaveLength(1);
});

test("retain mode: a peer message with a valid byte count but unparseable NNN is a terminal error regardless of unexpected_files", async () => {
  for (const policy of ["error", "warn", "ignore"] as const) {
    const { client, files } = makeMockClient();
    const conn = new FileSyncConnection(client, {
      pollingFrequency: 10,
      timeToLive: new Date(Date.now() + 5_000),
      verbose: -1,
      locklessRendezvous: true,
      timestampInFilename: true,
      retainFiles: true,
      unexpectedFiles: policy,
    });
    conn.id = "me";
    conn.connected = true;
    conn.path = "/test";
    conn.peerId = "peer";

    // Byte-count terminal (5) but the NNN segment ("foo") is non-numeric.
    files.set("/test/peer-foo-5.json", Buffer.from("xxxxx"));

    const errors: unknown[] = [];
    let notifyError!: () => void;
    const errorArrived = new Promise<void>((r) => (notifyError = r));
    conn.on("error", (err) => {
      errors.push(err);
      notifyError();
    });

    conn.start();
    await Promise.race([
      errorArrived,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`timed out (policy=${policy})`)),
          2_000,
        ),
      ),
    ]);

    expect(errors).toHaveLength(1);
    // A malformed-protocol UsageError, NOT a bilateral-mismatch: both sides
    // already agreed on retain/timestamp at rendezvous, so a "your settings
    // disagree" message would misdirect the operator.
    expect(errors[0]).toBeInstanceOf(UsageError);
    expect(errors[0]).not.toBeInstanceOf(BilateralModeMismatchError);
    expect((errors[0] as Error).message).toContain("peer-foo-5.json");
    expect((errors[0] as Error).message).toContain("NNN");
    expect((conn as unknown as { pollerActive: boolean }).pollerActive).toBe(
      false,
    );
  }
});

test("poll(): recognized loop files (hellos, acks, lock, our writes, temp) never trip the foreign-file path", async () => {
  // Under the strictest policy (plain default = error), plant every file kind
  // legal during the loop plus a real peer message. None must be misclassified
  // as foreign, and the real message must still be delivered.
  const errors: unknown[] = [];
  const received: unknown[] = [];
  const [, logs] = await withCapturedLogs(async () => {
    const { client, files } = makeMockClient();
    const conn = await makeConnectedConn(client, { pollingFrequency: 5 });
    conn.id = "me";
    conn.peerId = "peer";

    const recognized = [
      "me-hello.json", // our hello
      "peer-hello.json", // peer hello
      "me-peer-lock.json", // lock tiebreaker (we arrived first)
      "peer-me-lock.json", // lock tiebreaker, reverse arrival order (peer first)
      "me-peer-hello-ack.json", // our rendezvous ack of the peer hello
      "peer-me-hello-ack.json", // peer rendezvous ack of our hello
      "me-peer-20260101T000000-000-42-ack.json", // our message-ack
      "peer-me-20260101T000000-000-42-ack.json", // peer message-ack
      "temp-66666666-6666-4666-8666-666666666666.tmp", // in-flight write
    ];
    for (const name of recognized) files.set(`/test/${name}`, Buffer.alloc(0));

    // A real, fully-synced delete-mode peer message that must be delivered.
    const message = objectMessage({ ok: true });
    files.set(`/test/peer-${message.length}.json`, message);

    conn.on("error", (err) => errors.push(err));
    let notifyReceived!: () => void;
    const delivered = new Promise<void>((r) => (notifyReceived = r));
    conn.on("data", (m) => {
      received.push(m);
      notifyReceived();
    });

    conn.start();
    await Promise.race([
      delivered,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("timed out waiting for message")),
          2_000,
        ),
      ),
    ]);
    // Let a few more poll cycles run over the persisting recognized files.
    await new Promise((r) => setTimeout(r, 40));
    conn.stop();
  });

  expect(errors).toHaveLength(0);
  expect(received).toHaveLength(1);
  expect((received[0] as { ok: boolean }).ok).toBe(true);
  // No foreign-file warnings either: recognized files produce no per-cycle noise.
  expect(logs).toHaveLength(0);
});

test("poll(): retain mode recognizes our own accumulated message files rather than flagging them", async () => {
  // In retain mode our own sent messages are never deleted, so they are
  // re-listed on every poll cycle. Under the strict default (error) they must
  // be recognized via the own-prefix numeric-terminal branch, never flagged as
  // unexpected -- which would terminate the exchange on our own transcript.
  const errors: unknown[] = [];
  let listCount = 0;
  const [, logs] = await withCapturedLogs(async () => {
    const { client, files } = makeMockClient();
    const conn = new FileSyncConnection(client, {
      pollingFrequency: 5,
      timeToLive: new Date(Date.now() + 5_000),
      verbose: -1,
      locklessRendezvous: true,
      timestampInFilename: true,
      retainFiles: true,
      unexpectedFiles: "error",
    });
    conn.id = "me";
    conn.connected = true;
    conn.path = "/test";
    conn.peerId = "peer";
    conn.on("error", (err) => errors.push(err));

    // Our own retained, already-sent messages and a message-ack accumulate.
    files.set("/test/me-20260101T000000-000-42.json", Buffer.alloc(42));
    files.set("/test/me-20260101T000100-001-37.json", Buffer.alloc(37));
    files.set("/test/me-peer-20260101T000000-000-10-ack.json", Buffer.alloc(0));

    let notifyEnough!: () => void;
    const enough = new Promise<void>((r) => (notifyEnough = r));
    const origList = client.list.bind(client);
    client.list = async (p: string) => {
      if (++listCount === 5) notifyEnough();
      return origList(p);
    };
    conn.start();
    try {
      await Promise.race([
        enough,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("timed out waiting for poll cycles")),
            2_000,
          ),
        ),
      ]);
    } finally {
      conn.stop();
    }
  });

  // No terminal error from the strict policy, and no per-cycle warn noise:
  // every own file was classified as recognized across all cycles.
  expect(errors).toHaveLength(0);
  expect(listCount).toBeGreaterThanOrEqual(5);
  expect(logs).toHaveLength(0);
});

test("poll(): an ack-shaped foreign file whose target is not a real protocol file is flagged, not recognized", async () => {
  // `me-peer-x-ack.json` has a known-party prefix and >=4 dash segments, so the
  // old segment-count floor admitted it. Its embedded target `peer-x` is neither
  // a hello nor a message name, so it is not a real ack and must fall to the
  // unexpected-file policy (default error) rather than being recognized.
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 5 });
  conn.id = "me";
  conn.peerId = "peer";
  files.set("/test/me-peer-x-ack.json", Buffer.alloc(0));

  const errors: unknown[] = [];
  let notifyError!: () => void;
  const errorArrived = new Promise<void>((r) => (notifyError = r));
  conn.on("error", (err) => {
    errors.push(err);
    notifyError();
  });

  conn.start();
  try {
    await Promise.race([
      errorArrived,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timed out")), 2_000),
      ),
    ]);
  } finally {
    conn.stop();
  }

  expect(errors).toHaveLength(1);
  expect(errors[0]).toBeInstanceOf(UsageError);
  expect((errors[0] as Error).message).toContain("me-peer-x-ack.json");
  expect((conn as unknown as { pollerActive: boolean }).pollerActive).toBe(
    false,
  );
});

// --- cancellable waits: close() cancels in-flight waits (D1-D6) ---------------

test("close() cancels an in-flight retain ack-wait promptly (site 4)", async () => {
  const { client } = makeMockClient();
  const HUGE_TTL = 60_000;
  const conn = makeRetainConn(client, "me", "peer", HUGE_TTL);
  // seq>0 with a recorded lastSentFile drives send() into the ack-wait loop; the
  // peer never writes the ack, so it parks in this.wait (site 4).
  conn.seq = 1;
  (conn as unknown as { lastSentFile: string }).lastSentFile =
    "me-20260101T000000-000-10.json";

  // Barrier: resolve once the ack-wait has polled list() at least once, so we
  // close() with the loop committed to the wait rather than before it begins.
  let parked!: () => void;
  const reachedWait = new Promise<void>((r) => (parked = r));
  const origList = client.list;
  client.list = async (p: string) => {
    const result = await origList(p);
    parked();
    return result;
  };

  const start = Date.now();
  const outcome = conn.send({ blocked: true }).then(
    () => null,
    (err: unknown) => err,
  );

  await reachedWait;
  await conn.close();

  const err = await outcome;
  expect(err).toBeInstanceOf(ConnectionClosedError);
  // Cancellation, not the deadline, unblocked the wait.
  expect(Date.now() - start).toBeLessThan(HUGE_TTL / 2);
});

test("close() cancels an in-flight delete-mode consume-wait promptly (site 5)", async () => {
  const { client, files } = makeMockClient();
  const HUGE_TTL = 60_000;
  const conn = await makeConnectedConn(client, {
    pollingFrequency: 10,
    timeToLiveMs: HUGE_TTL,
    peerTimeoutMs: 50,
  });
  conn.peerId = "peer";
  // An outstanding message nobody consumes drives send() into the consume-wait.
  // The drain waits for the exact lastSentFile, so point it at the planted name.
  const outName = `${conn.id}-99.json`;
  files.set(`/test/${outName}`, Buffer.from(JSON.stringify({ stale: true })));
  (conn as unknown as { lastSentFile?: string }).lastSentFile = outName;

  let parked!: () => void;
  const reachedWait = new Promise<void>((r) => (parked = r));
  const origList = client.list;
  client.list = async (p: string) => {
    const result = await origList(p);
    parked();
    return result;
  };

  const start = Date.now();
  const outcome = conn.send({ blocked: true }).then(
    () => null,
    (err: unknown) => err,
  );

  await reachedWait;
  await conn.close();

  const err = await outcome;
  expect(err).toBeInstanceOf(ConnectionClosedError);
  expect(Date.now() - start).toBeLessThan(HUGE_TTL / 2);
});

test("close() cancels a parked rendezvous wait promptly (site 3)", async () => {
  const { client } = makeMockClient();
  const HUGE_TTL = 60_000;
  const conn = await makeConnectedConn(client, {
    pollingFrequency: 10,
    timeToLiveMs: HUGE_TTL,
    peerTimeoutMs: 50,
  });

  // The peer hello never appears, so waitForPeer parks in this.wait every poll.
  let parked!: () => void;
  const reachedWait = new Promise<void>((r) => (parked = r));
  let listCalls = 0;
  client.list = async () => {
    listCalls++;
    // entry list (1) + first waitForPeer poll (2): now parked in this.wait.
    if (listCalls >= 2) parked();
    return [];
  };

  const start = Date.now();
  const outcome = conn.synchronize().then(
    () => null,
    (err: unknown) => err,
  );

  await reachedWait;
  await conn.close();

  const err = await outcome;
  expect(err).toBeInstanceOf(ConnectionClosedError);
  // Not the TTL "synchronization timed out" path.
  expect((err as Error).message).not.toContain("timed out");
  expect(Date.now() - start).toBeLessThan(HUGE_TTL / 2);
});

test("close() during a parked poll delete-retry emits no spurious error (site 6 + D5)", async () => {
  const errors: unknown[] = [];
  const [, logs] = await withCapturedLogs(async () => {
    const { client, files } = makeMockClient();
    // Large polling frequency so the site-6 backoff parks until the abort,
    // never elapsing into the second delete attempt on its own.
    const conn = await makeConnectedConn(client, {
      pollingFrequency: 10_000,
      timeToLiveMs: 60_000,
      peerTimeoutMs: 50,
    });
    const peerId = "peer";
    conn.peerId = peerId;

    // A valid peer message the poller reads and then tries to delete.
    const body = objectMessage({ hi: 1 });
    files.set(`/test/${peerId}-${body.length}.json`, body);

    // The first delete attempt fails AND signals the test, guaranteeing close()
    // fires while the loop is parked inside the site-6 wait (not at list/get).
    let reachedDeleteRetry!: () => void;
    const parked = new Promise<void>((r) => (reachedDeleteRetry = r));
    client.delete = async () => {
      reachedDeleteRetry();
      throw new Error("delete failed");
    };

    conn.on("error", (err) => errors.push(err));
    conn.start();

    await parked;
    await conn.close();
    // Let any erroneously-rescheduled poll cycle run (it must not).
    await new Promise((r) => setTimeout(r, 30));

    // (b) nothing buffered either.
    expect(conn.takeBufferedError()).toBeUndefined();
  });

  // (a) no error surfaced on the event channel.
  expect(errors).toHaveLength(0);
  // (c) the second delete was skipped, so its warn never fired.
  expect(logs.some((l) => l.message.includes("failed to delete"))).toBe(false);
});

test("cancellableDelay resolves after the delay when never aborted", async () => {
  const controller = new AbortController();
  const start = Date.now();
  await expect(
    cancellableDelay(20, controller.signal),
  ).resolves.toBeUndefined();
  expect(Date.now() - start).toBeGreaterThanOrEqual(15);
});

test("cancellableDelay rejects synchronously when the signal is already aborted", async () => {
  const controller = new AbortController();
  const reason = new ConnectionClosedError("already aborted");
  controller.abort(reason);
  await expect(cancellableDelay(1_000, controller.signal)).rejects.toBe(reason);
});

test("cancellableDelay rejects with signal.reason and clears its timer when aborted mid-wait", async () => {
  const controller = new AbortController();
  const reason = new ConnectionClosedError("aborted mid-wait");
  const clearSpy = vi.spyOn(globalThis, "clearTimeout");
  try {
    const pending = cancellableDelay(10_000, controller.signal);
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    // The pending timer was cleared on abort (no dangling handle).
    expect(clearSpy).toHaveBeenCalled();
  } finally {
    clearSpy.mockRestore();
  }
});

test("synchronize() re-arms a fresh controller per session so a retry's waits stay live (D1)", async () => {
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    pollingFrequency: 10,
    timeToLiveMs: 60_000,
    peerTimeoutMs: 50,
  });
  conn.id = "starter";

  // Simulate a controller left aborted by a prior life (the state a failed-then-
  // retried session must recover from). Without the re-arm at synchronize()
  // entry, waitForPeer's first this.wait would observe this aborted signal and
  // reject immediately instead of polling for the peer.
  (
    conn as unknown as { abortController: AbortController }
  ).abortController.abort(new ConnectionClosedError("stale"));

  // The peer hello appears after a few empty polls, so the rendezvous parks in
  // this.wait (against the re-armed controller) before completing.
  setTimeout(() => {
    files.set("/test/other-hello.json", LOCK_HELLO_BODY);
  }, 40);

  await expect(conn.synchronize()).resolves.toBeUndefined();
  expect(conn.peerId).toBe("other");
});

test("wait() reads the controller fresh per call so a swapped-in controller is independent (do-not-hoist, D4)", async () => {
  // Weak but cheap proxy for the do-not-hoist invariant: the real regression is
  // a hoisted `const signal` above a loop, which a unit test cannot fully catch
  // (the guard is the comment on wait()); this pins "fresh signal per call".
  const { client } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  const internals = conn as unknown as {
    wait(ms: number): Promise<void>;
    abortController: AbortController;
  };

  const controllerA = internals.abortController;
  // Swap in a fresh controller, as synchronize() does at session start.
  internals.abortController = new AbortController();

  // A wait started against the NEW controller must not be cancelled by aborting
  // the OLD one -- proving wait() did not cache controllerA's signal.
  const waitB = internals.wait(20);
  controllerA.abort(new ConnectionClosedError("old controller"));
  await expect(waitB).resolves.toBeUndefined();

  // And a wait against the current controller still cancels when IT aborts.
  const waitC = internals.wait(10_000);
  internals.abortController.abort(new ConnectionClosedError("current"));
  await expect(waitC).rejects.toBeInstanceOf(ConnectionClosedError);
});

test("close() during a parked rendezvous gate read completes teardown cleanly despite the sweep (site 1b)", async () => {
  const errors: unknown[] = [];
  const { client, files } = makeMockClient();
  const conn = new FileSyncConnection(client, {
    // Large frequency: the gate's retry backoff parks until the abort.
    pollingFrequency: 10_000,
    timeToLive: new Date(Date.now() + 60_000),
    verbose: -1,
    locklessRendezvous: true,
  });
  conn.id = "me";
  conn.connected = true;
  conn.path = "/test";
  conn.on("error", (err) => errors.push(err));

  // A peer hello is present (so the lockless barrier enters the gate read at
  // site 1b), but get() always fails, so the gate retries via cancellableDelay
  // and parks. This read IS under the rendezvous outer catch, so an abort drives
  // its safeDelete sweep during teardown. The hello body is never read (get()
  // always throws), so its contents are irrelevant.
  files.set("/test/peer-hello.json", LOCK_HELLO_BODY);
  let reachedGate!: () => void;
  const parked = new Promise<void>((r) => (reachedGate = r));
  client.get = async () => {
    reachedGate();
    throw new Error("partial sync; retry");
  };

  const outcome = conn.synchronize().then(
    () => null,
    (err: unknown) => err,
  );

  await parked;
  // (a) close() resolves without throwing even though the aborted rendezvous
  // issues its sweep safeDelete()s concurrently.
  await expect(conn.close()).resolves.toBeUndefined();

  const err = await outcome;
  expect(err).toBeInstanceOf(ConnectionClosedError);
  // (c) no spurious error surfaced/buffered despite the teardown-side
  // safeDeletes.
  expect(errors).toHaveLength(0);
  expect(conn.takeBufferedError()).toBeUndefined();
});

test("poll refuses an over-cap message before reading it into memory", async () => {
  // A hostile server admin writes an oversized file. The poll loop must refuse
  // it based on the size known from list() -- before get() loads the body into
  // memory -- and stop terminally rather than allocating proportionally to the
  // attacker-chosen size or looping on it.
  const peerId = "peer-test";
  const oversize = MAX_FRAME_SIZE_BYTES + 1;
  let getCount = 0;
  const errors: unknown[] = [];
  let notifyError!: () => void;
  const errorArrived = new Promise<void>((resolve) => (notifyError = resolve));

  await withCapturedLogs(async () => {
    const { client } = makeMockClient();
    // The filename encodes the (attacker-declared) byte count and the listing
    // reports the same on-disk size; no buffer is ever allocated for it.
    client.list = async () => [
      { name: `${peerId}-${oversize}.json`, modifyTime: 0, size: oversize },
    ];
    client.get = async () => {
      getCount++;
      throw new Error("get() must not be called for an over-cap file");
    };
    const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
    conn.peerId = peerId;
    conn.on("error", (err) => {
      errors.push(err);
      notifyError();
    });
    conn.start();
    await Promise.race([
      errorArrived,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("timed out waiting for error")),
          2_000,
        ),
      ),
    ]);
    // The over-cap refusal must be terminal, not just typed: the poller stops
    // itself before emitting. Do NOT stop it here, so a wrong reschedule -- which
    // would re-list the still-present over-cap file and re-emit every
    // pollingFrequency -- surfaces instead of being hidden by an immediate stop().
    expect((conn as unknown as { pollerActive: boolean }).pollerActive).toBe(
      false,
    );
    // Several poll intervals; a rescheduled poll would emit a second error.
    await new Promise((resolve) => setTimeout(resolve, 50));
    conn.stop();
  });

  expect(getCount).toBe(0);
  // Exactly one error after the settle above: refused once and stopped, not
  // re-emitted on the never-deleted over-cap file each cycle.
  expect(errors).toHaveLength(1);
  expect(errors[0]).toBeInstanceOf(FrameSizeExceededError);
  // FrameSizeExceededError is a UsageError, so the failure is the terminal,
  // exit-64 family rather than a retryable transport error.
  expect(errors[0]).toBeInstanceOf(UsageError);
  expect((errors[0] as Error).message).toContain("maximum inbound frame size");
});

test("poll surfaces an adapter frame-size cap as a terminal error", async () => {
  // A server that under-reports a file's size in its directory listing slips
  // past the pre-get() size check, so the adapter's hard read cap fires during
  // get() instead. That FrameSizeExceededError must be terminal -- the poller
  // must not re-read the same file every cycle (which would re-incur the very
  // allocation the cap prevents).
  const peerId = "peer-test";
  let getCount = 0;
  const errors: unknown[] = [];
  let notifyError!: () => void;
  const errorArrived = new Promise<void>((resolve) => (notifyError = resolve));

  await withCapturedLogs(async () => {
    const { client } = makeMockClient();
    // Listing reports a small, under-cap size (the lie), so the pre-check passes
    // and poll() proceeds to get().
    client.list = async () => [
      { name: `${peerId}-5.json`, modifyTime: 0, size: 5 },
    ];
    client.get = async () => {
      getCount++;
      throw new FrameSizeExceededError(
        "inbound file exceeds the maximum frame size of 5 bytes",
      );
    };
    const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
    conn.peerId = peerId;
    conn.on("error", (err) => {
      errors.push(err);
      notifyError();
    });
    conn.start();
    await Promise.race([
      errorArrived,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("timed out waiting for error")),
          2_000,
        ),
      ),
    ]);
    // Give the poller a chance to (wrongly) reschedule before asserting it did
    // not: wait a few polling intervals and confirm get() ran exactly once.
    await new Promise((resolve) => setTimeout(resolve, 60));
    conn.stop();
  });

  expect(errors).toHaveLength(1);
  expect(errors[0]).toBeInstanceOf(FrameSizeExceededError);
  expect(getCount).toBe(1);
});

// --- normalizeFiledropPath ---------------------------------------------------

test("normalizeFiledropPath: strips all trailing slashes", () => {
  expect(normalizeFiledropPath("/mnt/share/")).toBe("/mnt/share");
  expect(normalizeFiledropPath("/mnt/share//")).toBe("/mnt/share");
  expect(normalizeFiledropPath("/mnt/share")).toBe("/mnt/share");
});

test("normalizeFiledropPath: folds backslashes to forward slashes", () => {
  expect(normalizeFiledropPath("C:\\share\\drop")).toBe("C:/share/drop");
  expect(normalizeFiledropPath("C:\\share\\drop\\")).toBe("C:/share/drop");
});

test("normalizeFiledropPath: preserves root-like paths", () => {
  // A Unix root or a fully-stripped path stays "/", and a Windows drive root
  // keeps its trailing slash ("C:" is not a valid path argument on Windows).
  expect(normalizeFiledropPath("/")).toBe("/");
  expect(normalizeFiledropPath("//")).toBe("/");
  expect(normalizeFiledropPath("")).toBe("/");
  expect(normalizeFiledropPath("C:/")).toBe("C:/");
  expect(normalizeFiledropPath("C:\\")).toBe("C:/");
});

test("normalizeFiledropPath: leaves interior segments and case untouched", () => {
  // Only backslashes and trailing slashes are normalized; interior "//", "."
  // and ".." segments and letter case are preserved verbatim. The CLI filedrop
  // path-equality check relies on this: collapsing interior segments here would
  // make two genuinely different drops compare equal and silently skip a real
  // "wrong drop" conflict. Pin it so a future regex tidy-up cannot regress it.
  expect(normalizeFiledropPath("/a//b")).toBe("/a//b");
  expect(normalizeFiledropPath("/mnt/share/.")).toBe("/mnt/share/.");
  expect(normalizeFiledropPath("/mnt/share/../other")).toBe(
    "/mnt/share/../other",
  );
  expect(normalizeFiledropPath("/MNT/Share")).toBe("/MNT/Share");
});

// --- synchronize(): session-start directory hygiene (195255994) --------------
//
// Entry-guard classification (foreign vs protocol), the foreign-file snapshot,
// the opt-in --sweep-exchange-files sweep, and its pre-sweep retain-signal
// inspection / --force-retain-sweep guard.

// A hello body advertising retain mode (lockless + retain), planted as a peer
// hello so the pre-sweep inspection reads it as a retain signal.
const RETAIN_HELLO_BODY = Buffer.from(
  JSON.stringify({ locklessRendezvous: true, retainFiles: true }),
);

test("synchronize() default: an unexpected protocol file is exit-64 and points at --sweep-exchange-files", async () => {
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = "me";
  // A stale rendezvous hello-ack: a protocol-grammar file that is not the one
  // tolerated peer hello, so the default entry guard rejects it.
  files.set("/test/old-peer-old-hello-ack.json", Buffer.alloc(0));

  const err = await conn.synchronize().then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(UsageError);
  expect((err as Error).message).toContain("old-peer-old-hello-ack.json");
  expect((err as Error).message).toContain("--sweep-exchange-files");
  // Rejected, not swept: the file is untouched.
  expect(files.has("/test/old-peer-old-hello-ack.json")).toBe(true);
});

test("synchronize() default: a message-shaped <id>-<digits>.json is rejected at entry, not snapshotted (Reading A)", async () => {
  // A message-shaped name MATCHES the protocol grammar, so it is a protocol
  // file, not a foreign file: the default guard rejects it at entry rather than
  // snapshotting it and letting it reach poll().
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = "me";
  files.set("/test/peer-12345.json", Buffer.from("stale"));

  const err = await conn.synchronize().then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(UsageError);
  expect((err as Error).message).toContain("peer-12345.json");
  // Grammar-matching names are never recorded in the foreign snapshot.
  const snapshot = (conn as unknown as { foreignFileSnapshot: Set<string> })
    .foreignFileSnapshot;
  expect(snapshot.has("peer-12345.json")).toBe(false);
});

test("synchronize() default: a foreign file is tolerated, snapshotted, and not deleted", async () => {
  const peerId = "00000000-0000-4000-8000-000000000001";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const peerHelloName = `${peerId}-hello.json`;
  files.set(`/test/${peerHelloName}`, LOCK_HELLO_BODY);
  files.set("/test/notes.txt", Buffer.from("unrelated"));
  client.list = async () => [
    {
      name: peerHelloName,
      modifyTime: Date.now(),
      size: LOCK_HELLO_BODY.length,
    },
    { name: "notes.txt", modifyTime: Date.now(), size: 9 },
  ];

  await conn.synchronize();

  expect(conn.handshakeRole).toBe("initiator");
  // The foreign file survived rendezvous untouched...
  expect(files.has("/test/notes.txt")).toBe(true);
  // ...and was recorded in the entry snapshot so the loop tolerates it.
  const snapshot = (conn as unknown as { foreignFileSnapshot: Set<string> })
    .foreignFileSnapshot;
  expect(snapshot.has("notes.txt")).toBe(true);
});

test("poll(): a foreign file snapshotted at entry does not warn, but a new foreign file warns once (195255994 + 194800733)", async () => {
  const errors: unknown[] = [];
  let listCount = 0;
  const [, logs] = await withCapturedLogs(async () => {
    const { client, files } = makeMockClient();
    const conn = await makeConnectedConn(client, { pollingFrequency: 5 });
    conn.peerId = "peer-test";
    conn.options.unexpectedFiles = "warn";
    // Simulate the entry snapshot: one foreign file was present at entry.
    (
      conn as unknown as { foreignFileSnapshot: Set<string> }
    ).foreignFileSnapshot = new Set(["preexisting.json"]);
    files.set("/test/preexisting.json", Buffer.from("old"));
    files.set("/test/newcomer.json", Buffer.from("new"));
    conn.on("error", (err) => errors.push(err));

    let notifyEnough!: () => void;
    const enough = new Promise<void>((r) => (notifyEnough = r));
    const origList = client.list.bind(client);
    client.list = async (p: string) => {
      if (++listCount === 5) notifyEnough();
      return origList(p);
    };
    conn.start();
    try {
      await Promise.race([
        enough,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timed out")), 2_000),
        ),
      ]);
    } finally {
      conn.stop();
    }
  });
  expect(errors).toHaveLength(0);
  // The snapshotted file is tolerated -- never warned.
  expect(
    logs.filter((l) => l.message.includes("preexisting.json")),
  ).toHaveLength(0);
  // The newcomer is warned exactly once.
  expect(logs.filter((l) => l.message.includes("newcomer.json"))).toHaveLength(
    1,
  );
});

test("synchronize() --sweep-exchange-files: sweeps stale delete-mode protocol files and passes the entry guard", async () => {
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    pollingFrequency: 10,
    timeToLiveMs: 120,
  });
  conn.id = "me";
  conn.options.sweepExchangeFiles = true;
  // Stale delete-mode residue: a lock and a rendezvous hello-ack (NOT a retain
  // signal -- the pre-`ack` segment is `hello`, not a numeric byte count).
  files.set("/test/x-y-lock.json", Buffer.alloc(0));
  files.set("/test/a-b-hello-ack.json", Buffer.alloc(0));

  const deleted: string[] = [];
  const origDelete = client.delete.bind(client);
  client.delete = async (p: string) => {
    deleted.push(p);
    return origDelete(p);
  };

  const err = await conn.synchronize().then(
    () => undefined,
    (e: unknown) => e,
  );
  // Got past the entry guard (no UsageError); the initiator then timed out
  // waiting for a peer on the swept-clean directory.
  expect(err).toBeInstanceOf(Error);
  expect(err).not.toBeInstanceOf(UsageError);
  expect(deleted).toContain("/test/x-y-lock.json");
  expect(deleted).toContain("/test/a-b-hello-ack.json");
  expect(files.has("/test/x-y-lock.json")).toBe(false);
  expect(files.has("/test/a-b-hello-ack.json")).toBe(false);
});

test("synchronize() --sweep-exchange-files: refuses (exit 64) on a peer hello advertising retain_files=true, without deleting it", async () => {
  const peerId = "peer-uuid";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = "me";
  conn.options.sweepExchangeFiles = true; // delete-mode party, bare flag
  const peerHelloName = `${peerId}-hello.json`;
  files.set(`/test/${peerHelloName}`, RETAIN_HELLO_BODY);

  const deleted: string[] = [];
  const origDelete = client.delete.bind(client);
  client.delete = async (p: string) => {
    deleted.push(p);
    return origDelete(p);
  };

  const err = await conn.synchronize().then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(UsageError);
  expect((err as Error).message).toMatch(/retain/i);
  expect((err as Error).message).toContain("--force-retain-sweep");
  // The retain peer's transcript hello is preserved -- nothing was deleted.
  expect(deleted).toHaveLength(0);
  expect(files.has(`/test/${peerHelloName}`)).toBe(true);
});

test("synchronize() --sweep-exchange-files: refuses (exit 64) on a retain-only message ack, without deleting it", async () => {
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = "me";
  conn.options.sweepExchangeFiles = true;
  // A retain-only message ack the peer wrote for a message this party sent. A
  // retain message is always timestamped (<id>-<ts>-<NNN>-<byteCount>.json), so
  // its ack ends in two all-digit segments (NNN then byte count) -- both
  // required, vs `hello` for a rendezvous hello-ack, which is not a retain
  // signal.
  const ackName = "peer-me-20260101T000000-000-100-ack.json";
  files.set(`/test/${ackName}`, Buffer.alloc(0));

  const deleted: string[] = [];
  const origDelete = client.delete.bind(client);
  client.delete = async (p: string) => {
    deleted.push(p);
    return origDelete(p);
  };

  const err = await conn.synchronize().then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(UsageError);
  expect((err as Error).message).toContain(ackName);
  expect((err as Error).message).toContain("--force-retain-sweep");
  expect(deleted).toHaveLength(0);
  expect(files.has(`/test/${ackName}`)).toBe(true);
});

test("synchronize() --sweep-exchange-files: a `-ack.json` lacking two trailing digit segments is swept, not read as a retain signal", async () => {
  // Regression for the isRetainMessageAck false positive. A real retain message
  // ack ends in <NNN>-<byteCount>, two digit segments. Neither of these is one:
  // notes-5-ack.json has a non-digit leading segment, and 100-ack.json has only
  // ONE segment before -ack.json (the off-by-one case where the lastIndexOf
  // arithmetic mis-sliced "100" -> "10" and wrongly matched). Both match the
  // broad `-ack.json` grammar (so they are unexpected protocol files, swept
  // under the flag) but neither is a retain signal: the bare flag must proceed
  // and delete them, not refuse for --force-retain-sweep.
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    pollingFrequency: 10,
    timeToLiveMs: 120,
  });
  conn.id = "me";
  conn.options.sweepExchangeFiles = true; // delete-mode party, bare flag
  files.set("/test/notes-5-ack.json", Buffer.alloc(0));
  files.set("/test/100-ack.json", Buffer.alloc(0));

  const deleted: string[] = [];
  const origDelete = client.delete.bind(client);
  client.delete = async (p: string) => {
    deleted.push(p);
    return origDelete(p);
  };

  const err = await conn.synchronize().then(
    () => undefined,
    (e: unknown) => e,
  );
  // No retain refusal: it swept both files and then timed out waiting for a peer
  // (a transport Error, never a UsageError).
  expect(err).not.toBeInstanceOf(UsageError);
  expect(deleted).toContain("/test/notes-5-ack.json");
  expect(deleted).toContain("/test/100-ack.json");
  expect(files.has("/test/notes-5-ack.json")).toBe(false);
  expect(files.has("/test/100-ack.json")).toBe(false);
});

test("synchronize() --sweep-exchange-files: refuses (exit 64) when this party is in retain mode", async () => {
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = "me";
  conn.options.sweepExchangeFiles = true;
  // Local retain mode is itself a retain signal; set the flags it implies so the
  // synchronize() retain preconditions do not fire first.
  conn.options.retainFiles = true;
  conn.options.locklessRendezvous = true;
  conn.options.timestampInFilename = true;
  files.set("/test/me-100-0-50.json", Buffer.from("stale transcript"));

  const deleted: string[] = [];
  const origDelete = client.delete.bind(client);
  client.delete = async (p: string) => {
    deleted.push(p);
    return origDelete(p);
  };

  const err = await conn.synchronize().then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(UsageError);
  expect((err as Error).message).toMatch(/retain/i);
  expect((err as Error).message).toContain("--force-retain-sweep");
  expect(deleted).toHaveLength(0);
});

test("synchronize() --sweep-exchange-files --force-retain-sweep: wipes the retain transcript with a danger warning", async () => {
  const peerId = "peer-uuid";
  const deleted: string[] = [];
  const [, logs] = await withCapturedLogs(async () => {
    const { client, files } = makeMockClient();
    const conn = await makeConnectedConn(client, {
      pollingFrequency: 10,
      timeToLiveMs: 120,
    });
    conn.id = "me";
    conn.options.sweepExchangeFiles = true;
    conn.options.forceRetainSweep = true; // delete-mode party forcing a retain sweep
    const peerHelloName = `${peerId}-hello.json`;
    files.set(`/test/${peerHelloName}`, RETAIN_HELLO_BODY);

    const origDelete = client.delete.bind(client);
    client.delete = async (p: string) => {
      deleted.push(p);
      return origDelete(p);
    };

    // The wipe succeeds; the delete-mode initiator then times out waiting for a
    // peer on the now-empty directory.
    await conn.synchronize().catch(() => {});
    expect(files.has(`/test/${peerHelloName}`)).toBe(false);
  });
  // The retain peer hello was swept...
  expect(deleted.some((p) => p.includes(`${peerId}-hello.json`))).toBe(true);
  // ...and the destructive action was loudly warned.
  const warning = logs.find((l) =>
    /force-retain-sweep|destructive and irreversible/i.test(l.message),
  );
  expect(warning).toBeDefined();
  // The warning identifies the party by id, not the pre-rendezvous sentinel
  // (the sweep runs before this.role is assigned).
  expect(warning?.message).toContain("[me]");
  expect(warning?.message).not.toContain("unknown role");
});

test("synchronize() --sweep-exchange-files: a delete failure surfaces as a transport error (exit 69), not silent success", async () => {
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = "me";
  conn.options.sweepExchangeFiles = true;
  files.set("/test/x-y-lock.json", Buffer.alloc(0)); // stale, no retain signal
  // Transport cannot delete: client.delete rejects (unlike safeDelete, which
  // swallows). The sweep must surface that, not silently claim a clean slate.
  client.delete = async () => {
    throw new Error("transport refused delete");
  };

  const err = await conn.synchronize().then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Error);
  expect(err).not.toBeInstanceOf(UsageError); // -> CLI exit 69, not 64
  expect((err as Error).message).toContain("transport refused delete");
});

test("synchronize() --sweep-exchange-files: one delete failure still attempts every other delete and names the failure", async () => {
  // allSettled, not all: a single rejection must not abandon the other deletes
  // mid-flight. Every delete is attempted, and the surfaced error names the file
  // that failed (and is a transport error -> exit 69, not a UsageError).
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = "me";
  conn.options.sweepExchangeFiles = true;
  // Three stale protocol files, no retain signal. The middle one cannot be
  // deleted; the other two must still be attempted and removed.
  files.set("/test/a-b-lock.json", Buffer.alloc(0));
  files.set("/test/peerA-hello.json", LOCK_HELLO_BODY);
  files.set("/test/peerB-hello.json", LOCK_HELLO_BODY);

  const attempted: string[] = [];
  const origDelete = client.delete.bind(client);
  client.delete = async (p: string) => {
    attempted.push(p);
    if (p.endsWith("a-b-lock.json"))
      throw new Error("transport refused delete");
    return origDelete(p);
  };

  const err = await conn.synchronize().then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Error);
  expect(err).not.toBeInstanceOf(UsageError);
  expect((err as Error).message).toContain("a-b-lock.json");
  // Every delete was attempted despite the one failure...
  expect(attempted).toHaveLength(3);
  // ...and the deletable files were actually removed.
  expect(files.has("/test/peerA-hello.json")).toBe(false);
  expect(files.has("/test/peerB-hello.json")).toBe(false);
});

test("synchronize() --sweep-exchange-files: a non-resolving peer hello is retain-uncertain and refuses the bare flag (bounded)", async () => {
  const peerId = "peer-uuid";
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = "me";
  conn.options.sweepExchangeFiles = true;
  const peerHelloName = `${peerId}-hello.json`;
  files.set(`/test/${peerHelloName}`, RETAIN_HELLO_BODY); // present in the listing...
  // ...but its body never finishes syncing: every get() for it throws, so the
  // bounded gate exhausts its budget and the read is treated as retain-uncertain.
  const origGet = client.get.bind(client);
  client.get = async (p: string) => {
    if (p.endsWith(peerHelloName)) throw new Error("partial sync");
    return origGet(p);
  };

  const deleted: string[] = [];
  const origDelete = client.delete.bind(client);
  client.delete = async (p: string) => {
    deleted.push(p);
    return origDelete(p);
  };

  const start = Date.now();
  const err = await conn.synchronize().then(
    () => undefined,
    (e: unknown) => e,
  );
  const elapsed = Date.now() - start;
  expect(err).toBeInstanceOf(UsageError);
  expect((err as Error).message).toMatch(/retain-uncertain|did not resolve/i);
  expect(deleted).toHaveLength(0);
  // Bounded: it refused within a couple of poll cycles, not the peer timeout.
  expect(elapsed).toBeLessThan(2_000);
});

test("synchronize() --sweep-exchange-files: the retain inspection stops at the first unreadable hello", async () => {
  // Short-circuit: once a hello body cannot be read, retain-uncertainty is sticky
  // and the decision (refuse on the bare flag, warn under --force) is fixed, so
  // the inspection must not read later hellos -- a hostile directory of
  // unreadable hellos cannot be made to cost one network read apiece.
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = "me";
  conn.options.sweepExchangeFiles = true;
  const firstHello = "peerA-hello.json";
  const secondHello = "peerB-hello.json";
  files.set(`/test/${firstHello}`, RETAIN_HELLO_BODY);
  files.set(`/test/${secondHello}`, RETAIN_HELLO_BODY);

  const bodyReads: string[] = [];
  const origGet = client.get.bind(client);
  client.get = async (p: string) => {
    bodyReads.push(p);
    if (p.endsWith(firstHello)) throw new Error("partial sync"); // never resolves
    return origGet(p);
  };

  const err = await conn.synchronize().then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(UsageError);
  expect((err as Error).message).toMatch(/retain-uncertain|did not resolve/i);
  // The loop broke on the first unreadable hello: the second was never read.
  expect(bodyReads.some((p) => p.endsWith(firstHello))).toBe(true);
  expect(bodyReads.some((p) => p.endsWith(secondHello))).toBe(false);
});

test("synchronize() --sweep-exchange-files --force-retain-sweep: an earlier unreadable hello shadows a later malformed one and the forced sweep proceeds", async () => {
  // The one behavior the break changes: under --force the operator has authorized
  // the wipe, so breaking on the first unreadable hello means a later malformed
  // hello is never read and cannot veto the forced sweep (the old read-every-
  // hello behavior would have thrown a terminal UsageError on it and aborted).
  // Both hellos are swept and the danger warning still fires.
  const peerA = "peerA-hello.json"; // unreadable: body never finishes syncing
  const peerB = "peerB-hello.json"; // fully synced but malformed (not a HelloEnvelope)
  const deleted: string[] = [];
  const [, logs] = await withCapturedLogs(async () => {
    const { client, files } = makeMockClient();
    const conn = await makeConnectedConn(client, {
      pollingFrequency: 10,
      timeToLiveMs: 120,
    });
    conn.id = "me";
    conn.options.sweepExchangeFiles = true;
    conn.options.forceRetainSweep = true;
    files.set(`/test/${peerA}`, RETAIN_HELLO_BODY);
    files.set(`/test/${peerB}`, Buffer.from("{}")); // missing required flags

    const origGet = client.get.bind(client);
    client.get = async (p: string) => {
      if (p.endsWith(peerA)) throw new Error("partial sync"); // never resolves
      return origGet(p);
    };
    const origDelete = client.delete.bind(client);
    client.delete = async (p: string) => {
      deleted.push(p);
      return origDelete(p);
    };

    // Proceeds past the malformed peerB instead of aborting, then times out
    // waiting for a real peer on the now-clean directory.
    await conn.synchronize().catch(() => {});
  });
  expect(deleted.some((p) => p.endsWith(peerA))).toBe(true);
  expect(deleted.some((p) => p.endsWith(peerB))).toBe(true);
  expect(
    logs.some((l) =>
      /force-retain-sweep|destructive and irreversible/i.test(l.message),
    ),
  ).toBe(true);
});

test("synchronize() --sweep-exchange-files: sweeps a second peer hello, overriding the I1 concurrent-session guard", async () => {
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    pollingFrequency: 10,
    timeToLiveMs: 120,
  });
  conn.id = "me";
  conn.options.sweepExchangeFiles = true;
  // Two peer hellos -- without the flag this is the I1 "other sessions using
  // this path?" error. Both advertise delete mode, so there is no retain signal
  // and the bare flag sweeps them.
  files.set("/test/peerA-hello.json", LOCK_HELLO_BODY);
  files.set("/test/peerB-hello.json", LOCK_HELLO_BODY);

  const deleted: string[] = [];
  const origDelete = client.delete.bind(client);
  client.delete = async (p: string) => {
    deleted.push(p);
    return origDelete(p);
  };

  const err = await conn.synchronize().then(
    () => undefined,
    (e: unknown) => e,
  );
  // No I1 error: both peer hellos were swept and the initiator then timed out.
  expect(err).not.toBeInstanceOf(UsageError);
  expect(deleted).toContain("/test/peerA-hello.json");
  expect(deleted).toContain("/test/peerB-hello.json");
});

test("synchronize() --sweep-exchange-files: a bare empty-id hello is swept, not adopted as the peer hello", async () => {
  // A planted "-hello.json" has an empty id. It must be treated as an unexpected
  // protocol file (swept under the flag), never adopted as a peer hello -- which
  // would otherwise commit rendezvous to peerId="".
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    pollingFrequency: 10,
    timeToLiveMs: 120,
  });
  conn.id = "me";
  conn.options.sweepExchangeFiles = true;
  files.set("/test/-hello.json", Buffer.alloc(0));

  const deleted: string[] = [];
  const origDelete = client.delete.bind(client);
  client.delete = async (p: string) => {
    deleted.push(p);
    return origDelete(p);
  };

  const err = await conn.synchronize().then(
    () => undefined,
    (e: unknown) => e,
  );
  // Swept (not adopted), then the initiator timed out waiting for a real peer.
  expect(err).not.toBeInstanceOf(UsageError);
  expect(deleted).toContain("/test/-hello.json");
  expect(files.has("/test/-hello.json")).toBe(false);
});

test("synchronize() --sweep-exchange-files --force-retain-sweep: no danger warning when there is nothing to delete", async () => {
  // Local retain mode is the only retain signal and the directory holds no peer
  // protocol files, so the sweep deletes nothing. The danger warning must not
  // fire (it would otherwise claim to permanently delete 0 protocol files).
  const deleted: string[] = [];
  const [, logs] = await withCapturedLogs(async () => {
    const { client } = makeMockClient();
    const conn = await makeConnectedConn(client, {
      pollingFrequency: 10,
      timeToLiveMs: 120,
    });
    conn.id = "me";
    conn.options.sweepExchangeFiles = true;
    conn.options.forceRetainSweep = true;
    // Local retain mode (the lone signal); set the flags it implies so the
    // synchronize() retain preconditions do not fire first.
    conn.options.retainFiles = true;
    conn.options.locklessRendezvous = true;
    conn.options.timestampInFilename = true;

    const origDelete = client.delete.bind(client);
    client.delete = async (p: string) => {
      deleted.push(p);
      return origDelete(p);
    };

    // Empty directory: nothing to sweep, then the initiator times out.
    await conn.synchronize().catch(() => {});
  });
  expect(deleted).toHaveLength(0);
  expect(
    logs.filter((l) =>
      /permanently deleting|destructive and irreversible/i.test(l.message),
    ),
  ).toHaveLength(0);
});

test("synchronize() --sweep-exchange-files: a close() during the retain-signal inspection surfaces as a clean shutdown, not retain-uncertain", async () => {
  // A close() racing the bounded hello-body inspection aborts the gate read with
  // the ConnectionClosedError reason. That must propagate as a clean shutdown
  // (exit 69), NOT be masked as a retain-uncertain UsageError (exit 64).
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    // Large frequency so the gate parks on its retry backoff until the abort.
    pollingFrequency: 10_000,
    timeToLiveMs: 60_000,
  });
  conn.id = "me";
  conn.options.sweepExchangeFiles = true; // bare flag, delete-mode party
  // A peer hello is present, so the inspection enters the gate read; get() parks
  // (always throws) so the gate retries via cancellableDelay until the abort.
  files.set("/test/peer-hello.json", RETAIN_HELLO_BODY);
  let reachedGate!: () => void;
  const parked = new Promise<void>((r) => (reachedGate = r));
  client.get = async () => {
    reachedGate();
    throw new Error("partial sync; retry");
  };

  const outcome = conn.synchronize().then(
    () => undefined,
    (e: unknown) => e,
  );
  await parked;
  await expect(conn.close()).resolves.toBeUndefined();

  const err = await outcome;
  expect(err).toBeInstanceOf(ConnectionClosedError);
  expect(err).not.toBeInstanceOf(UsageError);
});

// --- split inbound/outbound directories --------------------------------------

// Helper: a retain/lockless split connection placed directly into the
// post-open, pre-rendezvous state (mirrors makeRetainConn but with distinct
// inbound and outbound directories and without a pre-set peerId, so
// synchronize() runs).
function makeSplitConn(
  client: FileTransportClient,
  id: string,
  inbound: string,
  outbound: string,
  timeToLiveMs = 1_000,
): FileSyncConnection {
  const conn = new FileSyncConnection(client, {
    pollingFrequency: 5,
    timeToLive: new Date(Date.now() + timeToLiveMs),
    verbose: -1,
    locklessRendezvous: true,
    timestampInFilename: true,
    retainFiles: true,
    peerId: id,
  });
  conn.connected = true;
  conn.path = inbound;
  conn.outbound = outbound;
  return conn;
}

test("synchronize() (split): a non-fresh OUTBOUND directory fails the clean-start guard", async () => {
  // The fresh-directory enforcement applies to BOTH halves: a leftover self
  // message in the outbound directory is a terminal usage error even though the
  // inbound directory is clean.
  const { client, files } = makeMockClient();
  files.set("/out/me-20260101T000000-000-12.json", Buffer.from("x".repeat(12)));
  const conn = makeSplitConn(client, "me", "/in", "/out");

  await expect(conn.synchronize()).rejects.toBeInstanceOf(UsageError);
});

test("synchronize() (split): an orphaned temp in the OUTBOUND directory is swept, not rejected", async () => {
  // A crashed in-flight write (temp-<uuidv4()>.tmp) in outbound is swept at
  // entry like the inbound one, so it never trips the clean-start guard; the
  // rendezvous then times out only because no peer arrives.
  const { client, files } = makeMockClient();
  const tempName = "temp-00000000-0000-4000-8000-000000000000.tmp";
  files.set(`/out/${tempName}`, Buffer.alloc(0));
  const conn = makeSplitConn(client, "me", "/in", "/out", 80);

  const err = await conn.synchronize().then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Error);
  expect(err).not.toBeInstanceOf(UsageError);
  expect((err as Error).message).toContain("timed out");
  expect(files.has(`/out/${tempName}`)).toBe(false);
});

test("split directories: a full retain-mode exchange between two bridged parties", async () => {
  // Acceptance integration test. Two parties each have DISTINCT inbound and
  // outbound directories, bridged by a single in-memory store keyed by
  // directory: A writes to "/a2b" (= B's inbound) and reads "/b2a" (= B's
  // outbound); B is the mirror. The exchange runs rendezvous, a three-message
  // send/ack cycle, and a clean close end to end -- every peer read coming from
  // a party's inbound and every self write landing in its outbound.
  const store = new Map<string, Buffer>();
  const makeClient = (): FileTransportClient => ({
    connect: async () => {},
    end: async () => {},
    list: async (dir: string): Promise<FileInfo[]> => {
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      return [...store.entries()]
        .filter(
          ([p]) =>
            p.startsWith(prefix) && !p.slice(prefix.length).includes("/"),
        )
        .map(([p, buf]) => ({
          name: p.slice(prefix.length),
          modifyTime: 0,
          size: buf.length,
        }));
    },
    get: async (p: string) => {
      const data = store.get(p);
      if (!data)
        throw Object.assign(new Error(`${p}: not found`), { code: "ENOENT" });
      return data as Buffer<ArrayBufferLike>;
    },
    put: async (
      src: string | Buffer | Uint8Array[] | NodeJS.ReadableStream,
      dest: string,
    ) => {
      store.set(dest, await putSrcBytes(src));
    },
    delete: async (p: string) => {
      store.delete(p);
    },
    safeDelete: async (p: string) => {
      store.delete(p);
    },
    rename: async (from: string, to: string) => {
      const data = store.get(from);
      if (data === undefined) throw new Error(`${from}: no such file`);
      store.delete(from);
      store.set(to, data);
    },
    createExclusive: async () => {},
    exists: async (p: string) => store.has(p),
  });

  const mk = (
    id: string,
    inbound: string,
    outbound: string,
  ): FileSyncConnection => {
    const conn = new FileSyncConnection(makeClient(), {
      pollingFrequency: 5,
      timeToLive: new Date(Date.now() + 5_000),
      verbose: -1,
      locklessRendezvous: true,
      timestampInFilename: true,
      retainFiles: true,
      peerId: id,
    });
    conn.connected = true;
    conn.path = inbound;
    conn.outbound = outbound;
    return conn;
  };

  const connA = mk("party-a", "/b2a", "/a2b");
  const connB = mk("party-b", "/a2b", "/b2a");

  await Promise.all([connA.synchronize(), connB.synchronize()]);
  expect(connA.peerId).toBe("party-b");
  expect(connB.peerId).toBe("party-a");

  const received: unknown[] = [];
  let resolveAll!: () => void;
  const allReceived = new Promise<void>((r) => (resolveAll = r));
  connB.on("data", (m) => {
    received.push(m);
    if (received.length === 3) resolveAll();
  });

  const sending = (async () => {
    await connA.send({ n: 1 });
    await connA.send({ n: 2 });
    await connA.send({ n: 3 });
  })();

  await runPoller(connB, allReceived);
  await sending;

  expect(received).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);

  const namesIn = (dir: string): string[] =>
    [...store.keys()]
      .filter((p) => p.startsWith(`${dir}/`))
      .map((p) => p.slice(dir.length + 1));
  const isAMessage = (n: string): boolean =>
    n.startsWith("party-a-") &&
    n.endsWith(".json") &&
    !n.endsWith("-ack.json") &&
    !n.endsWith("-hello.json");

  // A's three messages live only in its outbound; B's acks live only in its
  // outbound. Nothing crossed directories in EITHER direction, and no in-flight
  // temp leaked.
  expect(namesIn("/a2b").filter(isAMessage)).toHaveLength(3);
  // B's outbound holds B's acks: the rendezvous ack of A's hello plus one per
  // message (3) = 4. None of A's messages are there.
  expect(namesIn("/b2a").filter((n) => n.endsWith("-ack.json")).length).toBe(4);
  expect(namesIn("/b2a").filter(isAMessage)).toHaveLength(0);
  // Symmetric no-cross invariant: every file in a directory was written by the
  // party whose OUTBOUND it is, so it carries that party's id prefix -- a write
  // that leaked into the peer's directory (e.g. an ack mis-routed to inbound)
  // would show up here as a wrong-prefixed name. A's own rendezvous ack of B's
  // hello (party-a-...-ack.json) correctly lives in A's outbound, so an
  // ack-absence check would be wrong; the prefix invariant is the right one.
  expect(namesIn("/a2b").every((n) => n.startsWith("party-a-"))).toBe(true);
  expect(namesIn("/b2a").every((n) => n.startsWith("party-b-"))).toBe(true);
  expect(namesIn("/a2b").every((n) => !n.endsWith(".tmp"))).toBe(true);
  expect(namesIn("/b2a").every((n) => !n.endsWith(".tmp"))).toBe(true);

  // Clean close: retain mode deletes nothing, so the split transcript persists
  // in both directories.
  await connA.close();
  await connB.close();
  expect(namesIn("/a2b").length).toBeGreaterThan(0);
  expect(namesIn("/b2a").length).toBeGreaterThan(0);
});

test("synchronize() (split): a configured outbound without retain mode is rejected", async () => {
  // Library-level defense-in-depth: the config schema rejects split-without-
  // retain, but a direct caller that sets conn.outbound without retainFiles must
  // still be stopped before reaching a lock/delete path that would rename across
  // the two directories.
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 1_000),
    verbose: -1,
    locklessRendezvous: true,
    timestampInFilename: true,
    // retainFiles intentionally omitted (defaults to false)
  });
  conn.connected = true;
  conn.path = "/in";
  conn.outbound = "/out";

  await expect(conn.synchronize()).rejects.toBeInstanceOf(UsageError);
});

test("open() (split filedrop) rejects inbound/outbound that normalize to one directory", async () => {
  // open() applies the same distinctness rule the schema does, so a caller that
  // builds a config directly and bypasses parseConnectionConfig is still guarded:
  // "/x" and "/x/" normalize to the same directory and must be rejected so split
  // mode does not silently collapse into a shared directory.
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, { verbose: -1 });
  const config: FileDropConnectionConfig = {
    channel: "filedrop",
    inboundPath: "/x",
    outboundPath: "/x/",
    options: {
      locklessRendezvous: true,
      timestampInFilename: true,
      retainFiles: true,
    },
  };

  await expect(conn.open(config)).rejects.toBeInstanceOf(UsageError);
});

test("open() (split sftp) rejects a same-directory pair BEFORE dialing the server", async () => {
  // SFTP open()-time backstop for a caller that bypasses the schema: "in" and
  // "in//" resolve to the same directory and are rejected by the same rule the
  // schema applies. The check must run before the SSH connect -- a same-directory
  // misconfig must not cause a real dial -- so spy on connect and assert it never
  // fired.
  const { client } = makeMockClient();
  let dialed = false;
  client.connect = async () => {
    dialed = true;
  };
  const conn = new FileSyncConnection(client, { verbose: -1 });
  const config: SFTPConnectionConfig = {
    channel: "sftp",
    server: { host: "h", inboundPath: "in", outboundPath: "in//" },
    options: {
      locklessRendezvous: true,
      timestampInFilename: true,
      retainFiles: true,
    },
  };

  await expect(conn.open(config)).rejects.toBeInstanceOf(UsageError);
  expect(dialed).toBe(false);
});

// Textual same-directory pairs that open()'s pathsResolveToSameDir must reject
// when a caller bypasses the schema (which now applies the identical rule).
// Covers the internal-slash and "." cases that the stored-path normalization
// alone does not collapse (filedrop normalizeFiledropPath strips only trailing
// slashes; the sftp stored path strips only one trailing "/").
const SAME_DIR_PAIRS: Array<[string, string]> = [
  ["/a/in", "/a//in"], // internal repeated slash
  ["/a/in", "/a/./in"], // interior "." segment
  ["/a/in", "/a/in/"], // trailing slash
];
for (const [a, b] of SAME_DIR_PAIRS) {
  test(`open() (split filedrop) rejects "${a}" vs "${b}" as the same directory`, async () => {
    const { client } = makeMockClient();
    const conn = new FileSyncConnection(client, { verbose: -1 });
    await expect(
      conn.open({
        channel: "filedrop",
        inboundPath: a,
        outboundPath: b,
        options: {
          locklessRendezvous: true,
          timestampInFilename: true,
          retainFiles: true,
        },
      }),
    ).rejects.toBeInstanceOf(UsageError);
  });
}
