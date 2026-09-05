import { describe, expect, test, vi } from "vitest";

import {
  CONNECTION_CLOSE_TIMEOUT_MS,
  FileSyncConnection,
  normalizeFiledropPath,
  TERMINAL_FRAME_DRAIN_TIMEOUT_MS,
} from "../src/connection/fileSyncConnection";
import {
  serializeFileSyncMessage,
  MESSAGE_TYPE_OBJECT,
  MESSAGE_TYPE_BINARY,
  MESSAGE_HEADER_BYTES,
} from "../src/connection/fileSyncFraming";
import {
  ADVERTISE_HELLO_RETRY_ATTEMPTS,
  cancellableDelay,
} from "../src/connection/fileSyncConstants";
import type { FileTransportClient } from "../src/connection/fileSyncConnection";
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
  TransportPublishIndeterminateError,
} from "../src/errors";
import { MAX_FRAME_SIZE_BYTES } from "../src/connection/frameSize";
import { isHelloTempName } from "../src/connection/fileSyncNames";
import { computeHostKeyFingerprint } from "../src/utils/sshHostKey";
import { sanitizeForDisplay } from "../src/utils/sanitizeForDisplay";
import { sanitizeErrorForDisplay } from "../src/utils/sanitizeErrorForDisplay";
import {
  fromEventConnection,
  ConnectionError,
} from "../src/connection/messageConnection";
import { withCapturedLogs } from "../src/testing";
import logLibrary from "loglevel";
import {
  driveUntilError,
  LOCK_HELLO_BODY,
  makeConnectedConn,
  makeMockClient,
  makeRendezvousPair,
  makeRetainConn,
  messageLoopInternals,
  responsibleFilesOf,
  runPoller,
  type MockClientOptions,
} from "./utils/fileSyncConnectionFixture";

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

test("close() ends no client while the first dial is still in flight", async () => {
  // `connected` is set only once connect() resolves, and close() drives end()
  // only under it, so a close landing over an unfinished first dial ends
  // nothing. The SFTP transport leans on that ordering: its own teardown
  // destroys the socket beneath an in-flight session transition, which would
  // otherwise expose the destroy's rejection to open()'s caller as a
  // partner-side connect failure. Pinned here since nothing else checks it.
  const { client } = makeMockClient();
  let endCalls = 0;
  client.end = async () => {
    endCalls += 1;
  };
  let dialing!: () => void;
  const dialStarted = new Promise<void>((resolve) => {
    dialing = resolve;
  });
  let settleDial!: () => void;
  client.connect = () =>
    new Promise<void>((resolve) => {
      settleDial = resolve;
      dialing();
    });

  const conn = new FileSyncConnection(client, { verbose: -1 });
  const opening = conn.open({
    channel: "sftp",
    server: { host: "sftp.example.org", path: "/exchanges" },
  });
  await dialStarted;
  expect(conn.connected).toBe(false);

  await expect(conn.close()).resolves.toBeUndefined();
  expect(endCalls).toBe(0);

  // Once that dial lands the same close does end the client, so the case above is
  // the gate rather than a client this close could never have ended.
  settleDial();
  await opening;
  expect(conn.connected).toBe(true);
  await expect(conn.close()).resolves.toBeUndefined();
  expect(endCalls).toBe(1);
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
  // The configured SFTP username is a credential component; the connect debug
  // log must record only that one is set, never the value. Observing it needs
  // (1) the root level raised to "trace" (a named logger is never more
  // verbose than the root), restored in finally, and (2) the connection
  // constructed inside withCapturedLogs so its logger binds to the capture.
  // Teeth: reverting to `as ${username}` would show "alice" on this line.
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
    // would make the credential assertion vacuous), holds the presence marker,
    // and never the username value.
    expect(debugLines).toContain("connecting to sftp.example.org");
    expect(debugLines).toContain("as a configured user");
    expect(debugLines).not.toContain("alice");
  } finally {
    logLibrary.setLevel(prevLevel);
  }
});

test("open (sftp): the connect debug log escapes control bytes in the host and path", async () => {
  // The host and remote path are server-controlled and, because the CLI
  // decodes percent-encoded URL components, can hold CR/LF or other control
  // bytes. An unescaped newline at debug level would let a hostile host or
  // path forge an extra log line, so this site routes both through
  // sanitizeForDisplay. Same logger-capture setup as the username test above.
  // Teeth: dropping sanitizeForDisplay from either value would show the raw
  // newline and split this into a forged line.
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
  // from the dirPath interpolation would show the raw CR/LF on this line.
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
  // escaping would show the raw CR/LF in this line.
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
// The connection is constructed inside withCapturedLogs to suppress open()'s
// per-dropped-key WARNs from the suite output. The dropped-key logging tests
// below wrap this helper in their own capture, so this suppression does not
// hide those WARNs from them.
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

// --- open (sftp keyboard-interactive) ----------------------------------------

test("keyboard_interactive with a password sets tryKeyboard", async () => {
  const opts = await captureSftpConnectOptions({
    channel: "sftp",
    server: {
      host: "sftp.example.org",
      password: "real-password",
      keyboardInteractive: true,
    },
  });
  expect(opts["tryKeyboard"]).toBe(true);
  // The password stays in the options too, so ssh2 offers the direct password
  // method alongside keyboard-interactive (the robust GUI-client behavior).
  expect(opts["password"]).toBe("real-password");
});

test("tryKeyboard is not set when keyboard_interactive is absent", async () => {
  const opts = await captureSftpConnectOptions({
    channel: "sftp",
    server: { host: "sftp.example.org", password: "real-password" },
  });
  expect(opts["tryKeyboard"]).toBeUndefined();
});

test("tryKeyboard is not set when keyboard_interactive has no password", async () => {
  // The schema refine rejects this combination, but buildConnectOptions
  // guards it independently: with no password there is nothing to answer prompts
  // with, so tryKeyboard is withheld rather than enabling an un-answerable method
  // (defends a direct library caller that bypasses the schema).
  const opts = await captureSftpConnectOptions({
    channel: "sftp",
    server: { host: "sftp.example.org", keyboardInteractive: true },
  });
  expect(opts["tryKeyboard"]).toBeUndefined();
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
  // orchestrator can advertise it for cross-party reconciliation.
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
  const err = await conn
    .open({ channel: "sftp", server: { host: "sftp.example.org" } })
    .catch((e: unknown) => e);
  expect((err as Error).message).toMatch(/no host_key_fingerprint is pinned/);
  // The no-pin refusal is the other host-identity trust failure: the same
  // security-kind ConnectionError as the pinned mismatch, cause preserved.
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("security");
  expect((err as ConnectionError).cause).toBeInstanceOf(Error);
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
  const err = await conn
    .open({
      channel: "sftp",
      server: { host: "sftp.example.org", hostKeyFingerprint: pin },
    })
    .catch((e: unknown) => e);
  expect((err as Error).message).toMatch(/SFTP host-key verification failed/);
  // A host-identity mismatch is a trust-boundary failure: a security-kind
  // ConnectionError (the classification the web classifier and the CLI event
  // stream key on), with the underlying connect rejection preserved as cause.
  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("security");
  expect((err as ConnectionError).cause).toBeInstanceOf(Error);
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
    // The mismatch message names how many pins were compared; the set itself
    // rides its own cause link, asserted at the rendered boundary in
    // sftpSession.test.ts.
  ).rejects.toThrow(/does not match any of the 2 pinned fingerprints/);
  expect(conn.connected).toBe(false);
  expect(conn.observedHostKey).toBeUndefined();
});

test("open (sftp) with no pin fails closed (the no-pin default)", async () => {
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

test("probeHostKeyFingerprint sends no credential, so an unresolved @path never reaches ssh2", async () => {
  // Regression: the probe refuses before authenticating and runs before @path
  // credential refs are resolved, so it must pass NO credential to ssh2. A
  // literal "@/secrets/id_rsa" left in privateKey would otherwise hit ssh2's
  // eager privateKey parse at connect time and abort with "Unsupported key
  // format" -- showing as "could not read the server's host key" -- before the
  // host key is ever read.
  const blob = ed25519Blob();
  const { client } = makeMockClient();
  let captured: Record<string, unknown> | undefined;
  client.connect = (options: Record<string, unknown>) => {
    captured = options;
    const verifier = options["hostVerifier"] as (
      b: Buffer,
      verify: (permitted: boolean) => void,
    ) => void;
    return new Promise<void>((resolve, reject) => {
      verifier(blob, (permitted: boolean) =>
        permitted
          ? resolve()
          : reject(new Error("Host denied (verification failed)")),
      );
    });
  };
  const conn = new FileSyncConnection(client, { verbose: -1 });
  const presented = await conn.probeHostKeyFingerprint({
    channel: "sftp",
    server: {
      host: "sftp.example.org",
      username: "roberts",
      privateKey: "@/secrets/id_rsa",
      privateKeyPassphrase: "@/secrets/pass",
    },
  });
  // The host key is still read: dropping credentials leaves host-key negotiation
  // unchanged.
  expect(presented.keyType).toBe("ssh-ed25519");
  expect(captured).toBeDefined();
  expect(captured?.["privateKey"]).toBeUndefined();
  expect(captured?.["passphrase"]).toBeUndefined();
  expect(captured?.["password"]).toBeUndefined();
  expect(captured?.["tryKeyboard"]).toBeUndefined();
  expect(captured?.["host"]).toBe("sftp.example.org");
  expect(captured?.["username"]).toBe("roberts");
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

test("probeHostKeyFingerprint reports the connect failure cause when no key is presented", async () => {
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
  // presented no key. It must show as "failed to read", holding the cause,
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
  // otherwise it shows up as a stray unhandled rejection (a flaky failure).
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
  // 30000 ms default (supplied at the connect site even for a config with no
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

test("a marker in a dropped providerOptions key does not delete the guidance", async () => {
  // The key is the operator's own config, but it is composed AHEAD of the
  // default-deny explanation, and the log prefixer's per-argument pass fails
  // closed from a BEGIN marker to the end of the argument. Redacting the key
  // where it is interpolated is what keeps the explanation the operator has to
  // act on; without it this line renders as the label and nothing else.
  const [, logs] = await withCapturedLogs(async () => {
    await captureSftpConnectOptions({
      channel: "sftp",
      server: { host: "sftp.example.org" },
      providerOptions: { "-----BEGIN A PRIVATE KEY-----": "x" },
    });
  });
  const line = logs.find(
    (l) => l.level === "WARN" && l.message.includes("providerOptions"),
  );
  expect(line).toBeDefined();
  expect(line?.message).toContain("[redacted private key]");
  expect(line?.message).toContain("not in the allowed set of SFTP");
  expect(line?.message).toContain("default-deny precaution");
});

test("a marker in a dropped algorithms sub-key does not delete the guidance", async () => {
  // The same ordering hazard one level down: the sub-key filter composes the
  // rejected sub-key ahead of the list of what may be tuned and of the reason
  // host-key-type negotiation is not among them. A key reaching the top-level
  // allowlist branch never enters this filter, so this composition needs its
  // own delivery to pin it.
  const [, logs] = await withCapturedLogs(async () => {
    await captureSftpConnectOptions({
      channel: "sftp",
      server: { host: "sftp.example.org" },
      providerOptions: {
        algorithms: { "-----BEGIN A PRIVATE KEY-----": ["aes256-ctr"] },
      },
    });
  });
  const line = logs.find(
    (l) =>
      l.level === "WARN" && l.message.includes("providerOptions.algorithms."),
  );
  expect(line).toBeDefined();
  expect(line?.message).toContain("[redacted private key]");
  expect(line?.message).toContain("may be tuned");
  expect(line?.message).toContain("not operator-overridable");
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
  // temp file has a `.tmp` extension; only the atomic rename target ends
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
  const { client } = makeMockClient();
  const conn = await makeConnectedConn(client);
  conn.peerId = "stub-peer";

  let putSrc:
    string | Buffer | Uint8Array[] | NodeJS.ReadableStream | undefined;
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

  expect(Array.isArray(putSrc)).toBe(true);
  const parts = putSrc as Uint8Array[];
  expect(parts).toHaveLength(2);
  expect(parts[0].length).toBe(MESSAGE_HEADER_BYTES);
  // (b) The payload chunk IS the caller's array, not a copy -- the ~1x proof.
  expect(parts[1]).toBe(frame);
  const expected = serializeFileSyncMessage(MESSAGE_TYPE_BINARY, 0, frame);
  expect(Buffer.concat(parts).equals(expected)).toBe(true);
  expect(renamedTo).toBe(`/test/${conn.id}-${expected.length}.json`);
  expect(expected.length).toBe(MESSAGE_HEADER_BYTES + frame.length);
});

test("a binary frame sent through the new framing is read back byte-exactly by a peer", async () => {
  // End-to-end guard the shape-only test above does not give: it stops at the
  // mock's file store. Here a SENDER writes a binary frame through send()'s
  // [header, payload] framing and a PEER polls the same directory and decodes
  // it, so a header/payload reorder, a wrong seq/version byte, or a
  // byte-count/on-disk-size mismatch would corrupt or drop the read-back
  // rather than pass silently, and exercises byteLength = header + payload
  // against the receiver's size gate.
  const { client } = makeMockClient();
  const sender = await makeConnectedConn(client, { pollingFrequency: 10 });
  const receiver = await makeConnectedConn(client, {
    pollingFrequency: 10,
    peerTimeoutMs: 2_000,
  });
  // send() needs a committed peerId; the receiver polls for `${peerId}-<n>.json`,
  // so point it at the sender's id to consume the sender's message.
  sender.peerId = "sender-peer";
  receiver.peerId = sender.id;

  // A plain Uint8Array (the binary-frame case send() passes by reference),
  // larger than one part and with a non-uniform pattern so a reorder or a
  // truncated tail cannot coincidentally compare equal.
  const frame = new Uint8Array(500);
  for (let i = 0; i < frame.length; i += 1) frame[i] = (i * 37 + 5) & 0xff;

  await sender.send(frame);

  const delivered = new Promise<unknown>((resolve) =>
    receiver.on("data", resolve),
  );
  receiver.start();
  const msg = await Promise.race([
    delivered,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("no frame within budget")), 2_000),
    ),
  ]);
  receiver.stop();

  expect(msg).toBeInstanceOf(Uint8Array);
  expect(Buffer.from(msg as Uint8Array).equals(Buffer.from(frame))).toBe(true);
});

// --- Race condition: consecutive sends ---------------------------------------

test("send waits for a previous unconsumed message before writing the next", async () => {
  const { client, files } = makeMockClient();
  // A peer budget well clear of the 50 ms consumption delay below. The wait is
  // armed with that budget at send() entry, so leaving the helper's 50 ms
  // default in place would race the wait against the very delay it must sit
  // through and fail the send with a spurious timeout on a slow run.
  const conn = await makeConnectedConn(client, { peerTimeoutMs: 2_000 });
  conn.peerId = "stub-peer";

  // Simulate a message this connection sent that is still on disk (the peer's
  // poller hasn't consumed it yet). send() waits for the EXACT lastSentFile, so
  // point that at the planted name as a real prior send() would have.
  const outName = `${conn.id}-99.json`;
  const outPath = `/test/${outName}`;
  files.set(outPath, Buffer.from(JSON.stringify({ stale: true })));
  messageLoopInternals(conn).lastSentFile = outName;

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
  // Short peer budget -- what the wait for the previous message is armed with --
  // so the test doesn't take long.
  const conn = await makeConnectedConn(client, {
    peerTimeoutMs: 150,
    pollingFrequency: 10,
  });
  conn.peerId = "stub-peer";

  // Plant a message this party sent that nobody will ever delete, and point
  // lastSentFile at it (the drain waits for that exact name to disappear).
  const outName = `${conn.id}-99.json`;
  files.set(`/test/${outName}`, Buffer.from(JSON.stringify({ stale: true })));
  messageLoopInternals(conn).lastSentFile = outName;

  await expect(conn.send({ next: true })).rejects.toThrow("timed out");
});

// --- TOCTOU race: ENOENT from get() ------------------------------------------

test("poll does not emit error when get() throws ENOENT after list() showed the file", async () => {
  // Simulate the TOCTOU window: list() shows the peer's message file, but by
  // the time get() runs the peer has already deleted it (their cleanup() raced
  // with our poll()). The poller must swallow ENOENT and reschedule rather than
  // emitting "error" and killing the connection.
  let getCount = 0;
  const peerId = "peer-test";
  let listCount = 0;
  const errors: unknown[] = [];

  // Resolved on list()'s 3rd call, confirming the poller rescheduled at least
  // twice after the ENOENT -- without relying on a fixed wall-clock wait.
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
  expect(getCount).toBe(1);
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
  // Resolved when the first message arrives -- no fixed wall-clock wait.
  let notifyReceived!: () => void;
  const firstMessage = new Promise<void>((r) => {
    notifyReceived = r;
  });

  const [, logs] = await withCapturedLogs(async () => {
    const { client, files } = makeMockClient();
    const originalGet = client.get.bind(client);
    client.list = async () => {
      listCount++;
      // First cycle shows a phantom file (get() throws ENOENT); second cycle
      // is empty (resets the consecutive-ENOENT counter); third cycle shows a
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
  // The cap can only tighten, never widen, the static cap: a value above
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
  // list() always shows a matching file (size matches declared count);
  // get() always throws ENOENT. After 3 consecutive ENOENT cycles the poller
  // must emit an error instead of warning indefinitely.
  const peerId = "peer-test";
  let errors: unknown[] = [];

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
    // Stop the poller in the handler, mirroring real protocol behavior where the
    // error handler calls doCleanup()/conn.stop().
    ({ errors } = await driveUntilError(conn, { stopInHandler: true }));
  });
  expect(logs).toHaveLength(2);
  expect(logs[0].message).toContain("disappeared between list and get");

  expect(errors).toHaveLength(1);
});

test("poll emits error immediately when list() throws ENOENT (not a TOCTOU race)", async () => {
  // reachedGet is false when list() throws, so ENOENT from the detection scan
  // is a hard error that must be emitted immediately -- not tolerated as a
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

  const { errors } = await driveUntilError(conn, { stopInHandler: true });

  expect(errors).toHaveLength(1);
});

// --- createExclusive() mock semantics ----------------------------------------

test("createExclusive throws EEXIST when destination already exists", async () => {
  const { client, files } = makeMockClient();
  files.set("/existing", Buffer.from("y"));
  await expect(client.createExclusive("/existing")).rejects.toMatchObject({
    code: "EEXIST",
  });
  expect(files.get("/existing")).toEqual(Buffer.from("y"));
});

test("createExclusive creates an empty entry and does not affect other files", async () => {
  const { client, files } = makeMockClient();
  files.set("/other", Buffer.from("data"));
  await client.createExclusive("/new");
  expect(files.has("/new")).toBe(true);
  expect(files.get("/new")).toEqual(Buffer.alloc(0));
  expect(files.get("/other")).toEqual(Buffer.from("data"));
});

// --- synchronize(): lock-file race cleanup ------------------------------------

test("poll() stops the poller on a UsageError from a transport read, not retried", async () => {
  // Companion to the synchronize() propagation tests above, for the OTHER
  // transport-read retry consumer: the background poll loop. A UsageError from a
  // message read -- here a stalled get() -- is terminal: poll() stops the poller
  // and emits the error rather than rescheduling into the same stall. (A transient
  // non-UsageError read failure reschedules instead; the ENOENT poll tests above
  // cover that half.) With readControlFileWithGate's gate tests, this pins
  // terminal-on-UsageError behaviorally at both real consumers of a transport read.
  const peerId = "peer-test";
  let getCount = 0;

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
  // itself on a UsageError. A terminal poller schedules no next cycle, so
  // getCount is already final at 1 the moment the error fires -- the settle
  // cannot make a stopped poller fail. It only gives a WRONG reschedule (which
  // fires every pollingFrequency = 10 ms) several intervals to show up and bump
  // getCount past 1.
  const { errors } = await driveUntilError(conn, { settleMs: 60 });

  expect(errors).toHaveLength(1);
  expect(errors[0]).toBeInstanceOf(UsageError);
  expect(errors[0]).toBeInstanceOf(TransportOperationStalledError);
  // Terminal: read once and the poller stopped, not retried at the poll cadence.
  expect(getCount).toBe(1);
});

test("poll() stops the poller on a stalled consume-delete, not swallowed-and-re-emitted", async () => {
  // The delete-mode consume path deletes a validated message (the go-ahead
  // signal to the sender) before emitting it. A TRANSIENT delete failure is
  // swallowed and the file re-read next cycle, but a terminal UsageError (the
  // per-op stall deadline a withheld delete callback trips) must NOT be: that
  // would emit the message while its consume-delete never landed, leaving the
  // file on disk to be re-emitted as a duplicate every cycle. Companion to
  // the read-stall poll test above, for the consume-delete consumer.
  const peerId = "peer-test";
  const validMessage = objectMessage({ hello: "world" });
  const peerName = `${peerId}-${validMessage.length}.json`;
  const peerPath = `/test/${peerName}`;

  const received: unknown[] = [];
  let deleteCount = 0;

  const { client, files } = makeMockClient();
  // Pre-seed the message so the default get() reads it; it parses and validates,
  // reaching the consume-delete.
  files.set(peerPath, validMessage);
  client.list = async () => [
    { name: peerName, modifyTime: 0, size: validMessage.length },
  ];
  // The consume-delete stalls terminally (a withheld callback the adapter's per-op
  // deadline shows up as this typed UsageError).
  client.delete = async () => {
    deleteCount++;
    throw new TransportOperationStalledError(
      "SFTP file delete stalled: did not complete within 60000 ms",
    );
  };
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.peerId = peerId;
  conn.on("data", (msg) => received.push(msg));
  // Do NOT stop the poller in the handler: it must stop itself on the UsageError.
  // The settle gives a wrong reschedule several poll intervals to show up (bump
  // deleteCount or deliver a duplicate); a terminal poller does neither.
  const { errors } = await driveUntilError(conn, { settleMs: 60 });

  expect(errors).toHaveLength(1);
  expect(errors[0]).toBeInstanceOf(UsageError);
  expect(errors[0]).toBeInstanceOf(TransportOperationStalledError);
  // Terminal: the consume-delete ran once and the poller stopped -- not retried at
  // the poll cadence -- and the un-consumed message was NOT delivered.
  expect(deleteCount).toBe(1);
  expect(received).toHaveLength(0);
});

test("poll() stops the poller on a stalled retain-mode ack-write, not advanced-and-re-emitted", async () => {
  // Retain mode never deletes the message; the consumption signal is a
  // zero-length ack marker writeAck() publishes (a put then a rename) BEFORE
  // poll() emits the payload and advances recvSeq/lastAckedNNN. A TRANSIENT
  // ack-write failure reschedules and reprocesses the message next cycle,
  // but a terminal UsageError must NOT be swallowed: advancing past it would
  // emit a message whose ack never landed, blocking the sender forever.
  // Retain sibling of the read-stall and consume-delete poll tests above;
  // its harness is adapted from the retain-mode tests below.
  const peerId = "peer-sender";
  const id = "receiver-me";
  const validMessage = objectMessage({ hello: "world" });
  // Retain filename grammar: <peerId>-<timestamp>-<NNN>-<byteCount>.json, with
  // NNN === recvSeq (0) so poll() selects it as this cycle's message.
  const peerName = `${peerId}-20260101T000000-000-${validMessage.length}.json`;
  const peerPath = `/test/${peerName}`;

  const received: unknown[] = [];
  let putCount = 0;

  const { client, files } = makeMockClient();
  // Pre-seed the message so the default get() reads it; it parses and validates
  // (body seq matches the filename NNN), reaching the ack-write before emit.
  files.set(peerPath, validMessage);
  // The ack-write stalls terminally. put is writeAck()'s first transport op, so
  // a stall there is the ack-write itself failing (a withheld callback the
  // adapter's per-op deadline shows up as this typed UsageError). poll() does
  // no other put on this path, so putCount counts ack-write attempts exactly.
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
  conn.on("data", (msg) => received.push(msg));
  // Do NOT stop the poller in the handler: it must stop itself on the UsageError.
  // The settle gives a wrong reschedule several poll intervals to show up (bump
  // putCount or deliver the message); a terminal poller does neither.
  const { errors } = await driveUntilError(conn, { settleMs: 60 });

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

// --- whole-exchange liveness fallback (write/stat/delete + slow-drip read) ---
//
// Write-path analogue of the read-path liveness test above: the CLI adapter's
// per-operation bounds cover read ops only, so FileSyncConnection's own
// peer-inactivity budget is the sole guard behind a stalled write/stat/delete
// op, and must fail the exchange with TransportOperationStalledError instead
// of hanging. The mock withholds its callback rather than throwing, so the
// failure can only come from that budget. timeToLiveMs is left large so the
// rendezvous loop cannot fire first and confound the cause.

test("send() fails within the peer budget when the server withholds the put callback", async () => {
  const { client } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    peerTimeoutMs: 100,
    timeToLiveMs: 60_000,
  });
  conn.peerId = "stub-peer";
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

// The rename builder names two transport paths, each with its own labelled
// link, so a marker in the source cannot reach into the destination link.
// Driven through the bound transport directly because every rename the
// exchange itself issues today has a self-generated temp source -- a
// property of today's callers, not this builder, and exactly what a future
// caller must not silently break. Short paths keep each label inside one
// link, so the display cap is not what ends it.
test("a private-key-shaped rename source does not take the destination with it", async () => {
  const { client } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    peerTimeoutMs: 100,
    timeToLiveMs: 60_000,
  });
  // The server accepts the rename but never invokes its callback, so the
  // consumer-layer budget is what composes and renders the failure.
  client.rename = () => new Promise<void>(() => {});
  const bound = (conn as unknown as { client: FileTransportClient }).client;

  const err = await bound
    .rename("/rv/-----BEGIN RSA PRIVATE KEY-----src", "/rv/dest.json")
    .then(
      () => undefined,
      (e: unknown) => e,
    );
  const rendered = sanitizeErrorForDisplay(err);

  expect(rendered).toContain("rename source: /rv/[redacted private key]");
  // The destination and the first-party label introducing it, both composed on
  // the link behind the marker.
  expect(rendered).toContain("rename destination: /rv/dest.json");
  expect(rendered).toContain("peer-inactivity budget");
});

test("poll() fails within the peer budget when the server withholds (slow-drips) the get callback", async () => {
  // The S2 slow-drip read: a server that trickles under-cap bytes forever (or
  // withholds the transfer entirely) never trips the adapter's per-chunk idle
  // window -- each chunk resets it -- so the capped get() never settles. To the
  // consumer that is simply a get() promise that never resolves; total
  // elapsed crosses the budget and the poll loop fails terminally instead of
  // draining forever. (A mock has no adapter idle window at all, which is exactly
  // the LocalFSClient / filedrop case the same fallback also covers -- S3.)
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
  // peer message filename containing control/ANSI bytes would otherwise reach the
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
  const rendered = sanitizeErrorForDisplay(err);
  expect(rendered).not.toContain("\x1b");
  expect(rendered).toContain("\\x1b");
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
  await expect(conn.close()).resolves.toBeUndefined();
  expect(endCalls).toBe(1);
  // Second close() neither throws nor re-enters the end() branch: `connected` was
  // cleared despite the rejection.
  await expect(conn.close()).resolves.toBeUndefined();
  expect(endCalls).toBe(1);
});

test("close() bounds a withheld end() by the teardown budget, not the peer budget", async () => {
  // The transport's own close is not a peer round trip the exchange depends on:
  // the result is already computed and persisted by teardown, so core's wait for
  // it is the short CONNECTION_CLOSE_TIMEOUT_MS rather than a fresh
  // peerTimeoutMs. With a peer budget far above it, a transport whose end() never
  // settles must not park teardown for the peer budget.
  const peerTimeoutMs = CONNECTION_CLOSE_TIMEOUT_MS * 10;
  const { client } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    peerTimeoutMs,
    timeToLiveMs: 60_000,
  });
  conn.peerId = "stub-peer";
  client.end = () => new Promise<void>(() => {});
  vi.useFakeTimers();
  try {
    let closed = false;
    const closing = conn.close().then(() => {
      closed = true;
    });
    await vi.advanceTimersByTimeAsync(CONNECTION_CLOSE_TIMEOUT_MS - 1);
    expect(closed).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await closing;
    expect(closed).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

test("close() applies the teardown budget as min(budget, peerTimeoutMs)", async () => {
  // An operator who configures a peer budget SMALLER than the teardown budget
  // asked for a shorter wait, not a longer one, so the smaller of the two wins --
  // the same min() rule the terminal-frame drain follows.
  const peerTimeoutMs = 100;
  expect(peerTimeoutMs).toBeLessThan(CONNECTION_CLOSE_TIMEOUT_MS);
  const { client } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    peerTimeoutMs,
    timeToLiveMs: 60_000,
  });
  conn.peerId = "stub-peer";
  client.end = () => new Promise<void>(() => {});
  const started = Date.now();
  await expect(conn.close()).resolves.toBeUndefined();
  expect(Date.now() - started).toBeLessThan(CONNECTION_CLOSE_TIMEOUT_MS);
});

test("the cycle-boundary signals are forwarded unwrapped, unlike end()", async () => {
  // releaseForIdle and ensureConnected are local session-lifecycle calls, not
  // peer round trips, so neither is raced against a fresh peer-inactivity
  // budget or given end()'s teardown budget -- whatever bounds them is the
  // transport's own. A connection-per-poll transport's idle release bounds
  // its own close, so a budget imposed here would abandon core's wait
  // mid-close on a session only that release can finish tearing down. Pinned
  // by driving both against a transport that never settles either one.
  const peerTimeoutMs = 100;
  const { client } = makeMockClient();
  // Installed BEFORE the connection is constructed: the forwarding binds each
  // optional signal once, at construction, so a transport that gains one later
  // is not reached (the connectionless transports never implement them at all).
  client.releaseForIdle = () => new Promise<void>(() => {});
  client.ensureConnected = () => new Promise<boolean>(() => {});
  const conn = await makeConnectedConn(client, {
    peerTimeoutMs,
    timeToLiveMs: 60_000,
  });
  const forwarded = (conn as unknown as { client: FileTransportClient }).client;
  vi.useFakeTimers();
  try {
    let releaseSettled = false;
    let readySettled = false;
    void forwarded.releaseForIdle?.().then(
      () => {
        releaseSettled = true;
      },
      () => {
        releaseSettled = true;
      },
    );
    void forwarded.ensureConnected?.().then(
      () => {
        readySettled = true;
      },
      () => {
        readySettled = true;
      },
    );

    await vi.advanceTimersByTimeAsync(peerTimeoutMs * 100);

    expect(releaseSettled).toBe(false);
    expect(readySettled).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

test("close() ends the client LAST, after the drain and cleanup()", async () => {
  // The ordering the adapter-side forced close rests on: nothing this teardown
  // still needs the transport for may run after end(), because end() can destroy
  // the socket beneath it. Pinned as a check rather than asserted in a comment.
  const order: string[] = [];
  const { client, files } = makeMockClient();
  const listed = client.list.bind(client);
  client.list = async (path: string) => {
    order.push("list");
    return listed(path);
  };
  const safeDeleted = client.safeDelete.bind(client);
  client.safeDelete = async (path: string) => {
    order.push("safeDelete");
    return safeDeleted(path);
  };
  client.end = async () => {
    order.push("end");
  };
  const conn = await makeConnectedConn(client, {
    peerTimeoutMs: 500,
    timeToLiveMs: 60_000,
  });
  (conn as unknown as { client: FileTransportClient }).client.beginTeardown =
    () => {
      order.push("beginTeardown");
    };
  conn.peerId = "stub-peer";
  // A sent-but-unconsumed terminal frame, so the drain actually lists, and a
  // responsible file for cleanup() to sweep.
  await conn.send({ hello: 1 });
  expect([...files.keys()].some((p) => p.startsWith(`/test/${conn.id}-`))).toBe(
    true,
  );
  // Only teardown's own ordering is under test; send() has already listed.
  order.length = 0;

  await conn.close();

  expect(order[0]).toBe("beginTeardown");
  expect(order.at(-1)).toBe("end");
  expect(order.filter((step) => step === "end")).toHaveLength(1);
  expect(order.indexOf("list")).toBeGreaterThan(-1);
  expect(order.indexOf("safeDelete")).toBeGreaterThan(order.indexOf("list"));
});

test("a failing end() reaches no caller, and the teardown before it still ran", async () => {
  // The other half of that ordering, and the property the SFTP adapter's
  // teardown line states to the operator: the connection's close is teardown's
  // last step, so however it goes it changes neither what the run produced nor
  // what the run reports. Everything teardown owed the transport -- the drain's
  // fallback delete and cleanup()'s sweep -- has landed by the time end() is
  // reached, and end()'s failure is logged at debug rather than reported.
  const order: string[] = [];
  const { client, files } = makeMockClient();
  const listed = client.list.bind(client);
  client.list = async (path: string) => {
    order.push("list");
    return listed(path);
  };
  const safeDeleted = client.safeDelete.bind(client);
  client.safeDelete = async (path: string) => {
    order.push("safeDelete");
    return safeDeleted(path);
  };
  const conn = await makeConnectedConn(client, {
    peerTimeoutMs: 500,
    timeToLiveMs: 60_000,
  });
  conn.peerId = "stub-peer";
  await conn.send({ hello: 1 });
  const mine = (): string[] =>
    [...files.keys()].filter((p) => p.startsWith(`/test/${conn.id}-`));
  expect(mine()).not.toEqual([]);
  let ended = 0;
  client.end = async () => {
    order.push("end");
    ended += 1;
    throw new Error("Unexpected close event");
  };
  // Only teardown's own ordering is under test; send() has already listed.
  order.length = 0;

  await expect(conn.close()).resolves.toBeUndefined();

  expect(ended).toBe(1);
  expect(mine()).toEqual([]);
  // Recorded rather than inferred from the swept files: their absence once
  // close() returns says nothing about whether the sweep preceded the throwing
  // end(), and the sibling test above pins that order only for one that resolves.
  expect(order.at(-1)).toBe("end");
  expect(order.indexOf("list")).toBeGreaterThan(-1);
  expect(order.indexOf("safeDelete")).toBeGreaterThan(order.indexOf("list"));
});

// --- synchronize(): empty-id hello/joining sentinels are rejected in the
// in-flight rendezvous scans (defense in depth; the entry guard already
// rejected them at entry, these cover a mid-rendezvous injection) -------------

test("ENOENT counter resets after a clean poll cycle, allowing a fresh set of retries", async () => {
  // Two ENOENTs (below threshold of 3), then exists() returns false (counter
  // resets), then two more ENOENTs. Four total ENOENTs -- but split across two
  // groups -- must never reach the threshold and must not emit an error.
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
    // smaller size and is absent from the store, so any premature
    // get() would throw "not found" and show up as an error below.
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
  // the post-entry policy it is a foreign file (terminal under the default
  // `error`); the `ignore` policy instead preserves the silent-skip behavior,
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

  const msgPath = [...files.keys()].find((p) =>
    new RegExp(`^/test/${sender.id}-\\d+\\.json$`).test(p),
  );
  expect(msgPath).toBeDefined();

  // Kick off close() - the drain holds cleanup until the file disappears.
  const closePromise = sender.close();

  // Let the drain poll at least once (pollingFrequency = 5 ms) before the
  // "receiver" consumes the file.
  await new Promise((r) => setTimeout(r, 20));

  receiverConsumed = true;
  files.delete(msgPath!);

  await closePromise;

  expect(deletedBeforeConsumed).toBe(false);
});

test("close() emits an info log at drain entry when the last sent file is still present", async () => {
  // Verifies the info-level breadcrumb that lets an operator running at
  // default verbosity (verbose:0 = INFO) tell close() is in a non-trivial drain
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
        messageLoopInternals(conn).lastSentFile = outName;

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
    expect(logs.some((l) => l.message.includes("drain deadline reached"))).toBe(
      false,
    );
  } finally {
    logLibrary.setLevel(prevLevel);
  }
});

test("close() emits an info log when the drain deadline fires", async () => {
  // Verifies the info-level breadcrumb that lets an operator distinguish a
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
        messageLoopInternals(conn).lastSentFile = outName;

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
  // Teeth for the deadline-log gate: it must key on the LAST OBSERVED
  // presence, not the clock. A clock-only check (`Date.now() >= deadline`)
  // mislabels a clean drain whose final filePresent() returns "absent"
  // at/after the deadline as a fallback-delete timeout. That straddle is a
  // sub-millisecond boundary with real timers, so this forces it with fake
  // timers: setSystemTime() advances Date.now() past the deadline without
  // firing the unref'd budget setTimeout (which advanceTimers would),
  // leaving the mocked list() to resolve "consumed" on a microtask that
  // still wins the budget race.
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
        messageLoopInternals(conn).lastSentFile = outName;

        // First list() (the entry filePresent at deadline-time 0) shows the
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
        messageLoopInternals(conn).lastSentFile = outName;

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

// --- send(): hasOutstandingMessage excludes typed protocol files ---------------

test("send() completes without spinning when a <id>-hello.json file is present in the store", async () => {
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
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    pollingFrequency: 10,
    // The budget a send arms for its wait, so a regression that counted the
    // foreign file as outstanding fails fast here instead of hanging the run.
    peerTimeoutMs: 200,
  });
  conn.peerId = "stub-peer";

  const foreignPath = `/test/${conn.id}-99.json`;
  files.set(foreignPath, Buffer.from("not ours"));

  await expect(conn.send({ check: true })).resolves.toBeUndefined();

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
  expect(files.has(peerLockPath)).toBe(true);
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

// --- UsageError taxonomy -------------------------------------------------------

test("send() message timeout throws UsageError", async () => {
  // A stale unconsumed message that outlasts the peer-inactivity budget this
  // send armed is a send-timeout usage error: the caller is responsible for
  // ensuring the peer is polling.
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, {
    peerTimeoutMs: 150,
    pollingFrequency: 10,
  });
  conn.peerId = "stub-peer";
  // Plant a stale outbound message that nobody will consume, and point
  // lastSentFile at it (the drain waits for that exact name).
  const outName = `${conn.id}-99.json`;
  files.set(`${conn.path}/${outName}`, Buffer.from("stale"));
  messageLoopInternals(conn).lastSentFile = outName;
  await expect(conn.send({ next: true })).rejects.toBeInstanceOf(UsageError);
});

// --- bilateral mode flags: advertise + symmetric fast-fail -------------------

// Two sortable UUIDs reused across the bilateral-flag tests. idLow < idHigh
// lexicographically, so the lower one is the "arrived first" party.
const ID_LOW = "00000000-0000-4000-8000-000000000001";
const ID_HIGH = "ffffffff-ffff-4fff-bfff-ffffffffffff";

// (a) Each rendezvous branch writes the hello with the advertised flags. Drive
// the lock joiner fast-path against a matched peer so the hello it writes
// survives (the joiner keeps its own hello) and can be inspected.
test("(a) hello payload has both bilateral flags", async () => {
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
    // Distinct from the generic peer-timeout fallback.
    expect(reason.message).not.toMatch(/timed out|synchronization has timed/);
  }
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
  expect(files.has(`${conn.path}/${conn.id}-hello.json`)).toBe(true);
  expect(files.has(`${conn.path}/${peerHelloName}`)).toBe(true);
});

test("(c) lock joiner fast-path retries a transient advertise-hello write, then leaves the durable hello", async () => {
  // The symmetric-detection floor is best-effort and contingent on this
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
  // the hello publish's in-flight temp (the hello is published temp-then-rename,
  // so its final name never appears under a failing write); on a mismatch this
  // branch issues no other put.
  const helloPath = `${conn.path}/${conn.id}-hello.json`;
  const originalPut = client.put;
  let helloPutAttempts = 0;
  client.put = async (src, dest, options) => {
    if (isHelloTempName(dest.slice(`${conn.path}/`.length))) {
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
    if (isHelloTempName(dest.slice(`${conn.path}/`.length))) {
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
  // the joiner fast-path, so both parties report it.
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

  // The durable-hello guarantee is critical: the outer catch must clear
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
  // to cover the safeDelete(lock)-then-throw code path. The lock is a transient,
  // not an advertisement, so it is swept; both hellos remain as the directory's
  // terminal state.
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

// (d) A fully-synced hello that parses as JSON but is missing a flag or has
// an out-of-type value fails the required-field schema as a terminal usage
// error on the reading party -- no crash, no silent default.

test("(d) a fully-synced hello missing a flag is a terminal usage error", async () => {
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = ID_HIGH;
  const peerHelloName = `${ID_LOW}-hello.json`;
  files.set(
    `${conn.path}/${peerHelloName}`,
    Buffer.from(JSON.stringify({ locklessRendezvous: true })),
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

// --- close() resets session counters -----------------------------------------

test("close() resets seq, recvSeq, and lastAckedNNN to their initial values", async () => {
  // A closed connection must not hold stale counters into a hypothetical
  // re-open. Set each to a non-zero value, close(), then assert they reset.
  const { client } = makeMockClient();
  const conn = await makeConnectedConn(client);
  conn.peerId = "stub-peer";

  // Drive counters to non-initial values by sending a message and manipulating
  // internal state directly (the fields are internal but accessible in tests).
  await conn.send({ n: 1 });
  expect(conn.seq).toBe(1);
  messageLoopInternals(conn).recvSeq = 3;
  messageLoopInternals(conn).lastAckedNNN = 2;

  await conn.close();

  expect(conn.seq).toBe(0);
  expect(messageLoopInternals(conn).recvSeq).toBe(0);
  expect(messageLoopInternals(conn).lastAckedNNN).toBe(-1);
});

// --- terminal poll errors stop the poller ------------------------------------

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

  files.set(`/test/${peerId}-10.json`, Buffer.from("a".repeat(10)));
  files.set(`/test/${peerId}-20.json`, Buffer.from("b".repeat(20)));

  // Do NOT stop the poller in the handler: a terminal error must stop it on its
  // own. The settle gives a wrong reschedule time to trigger a second error.
  const { errors, pollerActiveBeforeDriverStop } = await driveUntilError(conn, {
    settleMs: 50,
  });

  expect(errors).toHaveLength(1);
  expect(errors[0]).toBeInstanceOf(UsageError);
  expect((errors[0] as Error).message).toContain("more than one message file");
  expect(pollerActiveBeforeDriverStop).toBe(false);
});

// --- send() not-synchronized guard applies to non-retain mode ----------------

test("non-retain send() before synchronize() (peerId unset) throws 'not synchronized'", async () => {
  // The not-synchronized guard is hoisted to the top of send() and
  // fires for both retain and non-retain modes.
  const { client } = makeMockClient();
  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    timeToLive: new Date(Date.now() + 5_000),
    verbose: -1,
    retainFiles: false,
  });
  conn.connected = true;
  conn.path = "/test";
  // peerId is NOT set (synchronize() was not called).

  await expect(conn.send({ n: 1 })).rejects.toThrow("not synchronized");
});

// --- I8 counter boundary: error-injection tests -------------------------------
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

  expect(conn.seq).toBe(seqBefore);

  expect(tempPath).toBeDefined();
  expect(tempPath!.endsWith(".tmp")).toBe(true);
  expect(safeDeleted).toContain(tempPath!);
  const tmpFiles = [...files.keys()].filter((p) => p.endsWith(".tmp"));
  expect(tmpFiles).toEqual([]);
});

test("I8: retain send() ack-gate list throws -- send rejects rather than spinning", async () => {
  // Rule (a) + gateway liveness: when list() throws inside the ack-gate loop
  // (waiting for the peer's ack after the first send), send() must expose the
  // error rather than looping silently.
  const { client } = makeMockClient();
  const id = "sender-me";
  const peerId = "peer-receiver";

  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    verbose: -1,
    locklessRendezvous: true,
    timestampInFilename: true,
    retainFiles: true,
  });
  // Opened with a short peer budget so a swallowed list error shows up as a
  // prompt send timeout rather than spinning: what bounds this wait is the
  // budget the send arms, which an un-opened connection takes as the one-hour
  // default.
  await conn.open({
    channel: "filedrop",
    path: "/test",
    options: { peerTimeoutMs: 200 },
  });
  conn.id = id;
  conn.peerId = peerId;

  // First send: proceeds immediately (seq=0, no ack wait).
  await conn.send({ first: true });

  // Now stub list() to throw so the second send's ack-gate list fails.
  // The gate loop exits when list() rejects and the caught error is rethrown.
  client.list = async () => {
    throw new Error("synthetic list failure");
  };

  // Second send must reject with the list failure, not spin out its budget.
  await expect(conn.send({ second: true })).rejects.toThrow(
    "synthetic list failure",
  );
});

test("I8: poll() list throws -- error reaches the error event, recvSeq unchanged", async () => {
  // Rule (b): when list() throws inside poll(), the error must be emitted on
  // the "error" channel. recvSeq must not advance (no message was consumed).
  const { client } = makeMockClient();
  const peerId = "peer-sender";

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

  const recvSeqBefore = messageLoopInternals(conn).recvSeq;

  const { errors } = await driveUntilError(conn, { stopInHandler: true });

  expect(errors).toHaveLength(1);
  expect((errors[0] as Error).message).toContain("synthetic list failure");

  // recvSeq must not have advanced -- no message was processed.
  const recvSeqAfter = messageLoopInternals(conn).recvSeq;
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

  expect(ackRenameAttempts).toBe(2);
  expect(errors.length).toBeGreaterThanOrEqual(1);
  expect(received).toHaveLength(1);
  expect(messageLoopInternals(conn).recvSeq).toBe(1);
  expect(ackRenames).toHaveLength(1);
  const onDiskAcks = [...files.keys()].filter((p) => p.endsWith("-ack.json"));
  expect(onDiskAcks).toHaveLength(1);
});

// --- synchronize() entry precondition matrix ---------------------------------
// One mode-agnostic rule: at synchronize() entry the directory must be empty
// except for at most one peer hello. The matrix is the full (file-kind x
// mode) cross-product of that rule, generated rather than hand-listed so a
// missing combination is structurally impossible; every other file kind is
// legal only AFTER entry, in both modes.
// If a kind below is not a direct consequence of the rule, the rule -- not
// the matrix -- is wrong.

const ENTRY_SELF_ID = "00000000-0000-4000-8000-000000000001";
const ENTRY_PEER_ID = "ffffffff-ffff-4fff-bfff-ffffffffffff";
const ENTRY_PEER_ID_2 = "11111111-1111-4111-8111-111111111111";

// One row per file kind. `present` is what sits in the directory at entry. A
// peer hello on a proceed row is read through the HelloEnvelope gate, so the
// test body (below) gives it a full mode-matched envelope; every other kind is
// rejected on filename before any body read, so those bodies stay "{}". Outcome
// does not vary by mode (the rule is mode-agnostic), so each kind has a
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
  // entry guard: deleted via safeDelete and added to the guard's `ignored` set,
  // so it proceeds past the guard rather than being rejected as a strict-empty
  // violation.
  {
    kind: "temp file",
    present: ["temp-00000000-0000-4000-8000-00000000abcd.tmp"],
    outcome: "proceed",
  },
  // A foreign temp-*.tmp whose stem is NOT a v4 UUID is not the protocol's temp
  // shape: it fails the grammar, so it is snapshotted and tolerated
  // like any other foreign file rather than swept. It proceeds past the guard
  // (then times out waiting for a peer), exactly as notes.txt does below.
  {
    kind: "foreign temp file",
    present: ["temp-export.tmp"],
    outcome: "proceed",
  },
  // A foreign (non-protocol) file is snapshotted and tolerated at entry:
  // names that FAIL the protocol grammar are not rejected, so it
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
    // so it must advertise flags matching this conn's mode; other
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
      // joiner fast-path with one peer hello), enters the rendezvous wait and
      // times out with a transport Error, or -- lockless with a peer hello
      // already present at entry -- fails on the bounded entry-hello window.
      // What it must never be is the precondition rejection, so that message,
      // not the shared UsageError class, is the discriminator.
      expect(err instanceof Error ? err.message : "").not.toContain(
        "must be empty except for a single peer hello",
      );
    }
  },
);

// --- entry guard: orphaned temp-*.tmp sweep ----------------------------------
// At the I0 strict-empty entry guard the message loop has not started, so any
// temp-<uuid>.tmp (a send()/writeAck() in-flight write whose process was
// hard-killed before the rename to <id>.json) is necessarily orphaned. The
// guard sweeps it -- safeDelete then add to `ignored` -- rather than rejecting
// the directory as non-empty, so a prior crash's temp artifact is removed and
// entry is not aborted on its account.

test("poll(): the loop recognizes a real temp-<uuid>.tmp but treats a non-UUID temp-*.tmp as foreign", async () => {
  // isRecognizedLoopFile narrows its temp branch to the protocol's
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
  expect(logs.filter((l) => l.message.includes("temp-77777777"))).toHaveLength(
    0,
  );
  expect(
    logs.filter((l) => l.message.includes("temp-export.tmp")),
  ).toHaveLength(1);
});

// --- poll() error classification: terminal vs retryable ----------------------
// poll() stops the poller on a terminal error (re-reading the same bytes
// cannot help) and reschedules on a retryable one (a later attempt may
// succeed). A fully-synced message that fails to parse or validate is
// terminal -- otherwise a corrupt, never-deleted retain-mode message re-reads
// until the peer timeout. A transient transport hiccup is retryable.
// (Seq/NNN-mismatch and duplicate-NNN terminal cases are covered above.)

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

  const received: unknown[] = [];
  conn.on("data", (msg) => received.push(msg));
  // Do NOT stop the poller in the handler: a terminal error must stop it on its
  // own. The settle gives a wrong reschedule time to trigger a second error.
  const { errors, pollerActiveBeforeDriverStop } = await driveUntilError(conn, {
    settleMs: 50,
  });

  expect(errors).toHaveLength(1);
  expect(errors[0]).toBeInstanceOf(UsageError);
  expect((errors[0] as Error).message).toContain("not valid JSON");
  expect(pollerActiveBeforeDriverStop).toBe(false);
  expect(received).toHaveLength(0);
  expect([...files.keys()].some((p) => p.endsWith("-ack.json"))).toBe(false);
});

// The JSON.parse error itself contains peer bytes: V8 quotes a span of the
// offending input in its message (`Unexpected token 'x', "...." is not valid
// JSON`). The message body is fully peer-controlled (`payload: z.json()`), so
// that quoted span is a control/ANSI/Unicode injection vector one interpolation
// over from the filename -- it must be escaped like the filename and peerId.
async function pollUnparseableBodyError(payload: Buffer): Promise<Error> {
  const { client, files } = makeMockClient();
  const peerId = "peer-sender";
  // Wrap the malformed JSON payload in a valid envelope so the envelope parse
  // passes and the failure occurs at the bounded JSON parse, where the peer's
  // payload bytes can be echoed back by V8's error and must be escaped.
  const body = serializeFileSyncMessage(MESSAGE_TYPE_OBJECT, 0, payload);
  files.set(`/shared/${peerId}-20260101T000000-000-${body.length}.json`, body);
  const conn = makeRetainConn(client, "receiver-me", peerId);

  const { errors } = await driveUntilError(conn);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toBeInstanceOf(UsageError);
  return errors[0] as Error;
}

test("poll() terminal: the unparseable-body error escapes control/ANSI bytes echoed by the JSON parser", async () => {
  const err = await pollUnparseableBodyError(
    Buffer.from("\x1b[2J\x1b[31mEVIL not json"),
  );
  const rendered = sanitizeErrorForDisplay(err);
  expect(rendered).toContain("not valid JSON");
  expect(rendered).not.toContain("\x1b");
  expect(rendered).toContain("\\x1b");
});

test("poll() terminal: the unparseable-body error neutralizes deceptive Unicode echoed by the JSON parser", async () => {
  // Leading bidi-override (RLO), zero-width, and Cyrillic homoglyph -- all
  // invalid JSON starts, all quoted raw in V8's parse error, all escaped here.
  const err = await pollUnparseableBodyError(
    Buffer.from("\u202e\u200b\u0430 not json"),
  );
  const rendered = sanitizeErrorForDisplay(err);
  expect(rendered).toContain("not valid JSON");
  expect(rendered).not.toContain("\u202e");
  expect(rendered).not.toContain("\u200b");
  expect(rendered).not.toContain("\u0430");
  expect(rendered).toContain("\\u202e");
});

test("poll() terminal: an old-format JSON message shows a likely-incompatible-version hint", async () => {
  const { client, files } = makeMockClient();
  const peerId = "peer-sender";
  // An old-format JSON message body from a peer that predates the binary
  // envelope: its first byte is `{` (0x7b), not the envelope's version marker, so
  // the reader keys on that foreign version byte and names the real cause -- a
  // version-mismatched partner -- rather than the raw "malformed envelope" text.
  // This is the retroactive half: a current-or-newer reader
  // translates a JSON-text-where-a-binary-envelope-was-expected frame into the
  // actionable hint.
  const body = Buffer.from(JSON.stringify({ not: "a message" }));
  files.set(`/shared/${peerId}-20260101T000000-000-${body.length}.json`, body);
  const conn = makeRetainConn(client, "receiver-me", peerId);

  const received: unknown[] = [];
  conn.on("data", (msg) => received.push(msg));
  const { errors, pollerActiveBeforeDriverStop } = await driveUntilError(conn);

  expect(errors).toHaveLength(1);
  expect(errors[0]).toBeInstanceOf(UsageError);
  const message = (errors[0] as Error).message;
  expect(message).toContain("incompatible psilink version");
  expect(message).toContain("both parties must run the same version");
  // The reframed message replaces the raw envelope-corruption text, not appends.
  expect(message).not.toContain("malformed envelope");
  expect(pollerActiveBeforeDriverStop).toBe(false);
  expect(received).toHaveLength(0);
  expect([...files.keys()].some((p) => p.endsWith("-ack.json"))).toBe(false);
});

test("poll() terminal: a foreign envelope version byte shows the same version hint", async () => {
  const { client, files } = makeMockClient();
  const peerId = "peer-sender";
  // The forward-looking half of the same reader hint: a future build that raises
  // MESSAGE_ENVELOPE_VERSION writes a byte-0 our reader does not recognize. Take a
  // well-formed message and flip byte 0 to a foreign version (2) so only the
  // version marker differs -- the reader still names the likely-incompatible
  // partner rather than "malformed envelope".
  const body = serializeFileSyncMessage(
    MESSAGE_TYPE_OBJECT,
    0,
    Buffer.from(JSON.stringify({ v: 1 })),
  );
  body[0] = 2;
  files.set(`/shared/${peerId}-20260101T000000-000-${body.length}.json`, body);
  const conn = makeRetainConn(client, "receiver-me", peerId);

  const { errors } = await driveUntilError(conn);

  expect(errors).toHaveLength(1);
  expect(errors[0]).toBeInstanceOf(UsageError);
  const message = (errors[0] as Error).message;
  expect(message).toContain("incompatible psilink version");
  expect(message).toContain("envelope version byte 2");
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

  expect(errors.length).toBeGreaterThanOrEqual(1);
  expect(errors[0]).not.toBeInstanceOf(UsageError);
  expect(received).toHaveLength(1);
  expect(messageLoopInternals(conn).recvSeq).toBe(1);
});

test("composed via fromEventConnection: the first transient poll() error is terminal -- receive() fails once naming the cause, and the poller does not reschedule", async () => {
  // The isolation test directly above proves a transient list() failure is
  // retryable: poll() reschedules and delivers on a later cycle, a property
  // of poll() STANDALONE. In the CLI a FileSyncConnection is never consumed
  // directly -- apps/cli/src/protocol.ts bridges it through
  // fromEventConnection (-> conn.start() -> mc.receive()), whose error
  // listener routes every emitted poll() error into
  // QueuedMessageConnection.fail(), which synchronously calls hooks.close()
  // -> conn.close(), whose first statement is conn.stop(), clearing
  // pollerActive before poll()'s finally runs. The first emitted error is
  // therefore terminal. See the "Production composition note" under I8 in
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

  // The reported error names the underlying cause (the injected transport
  // failure), wrapped as a transport ConnectionError with that cause attached
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
  expect(messageLoopInternals(conn).pollerActive).toBe(false);

  // The poller did not reschedule: across several polling intervals the message
  // is never reprocessed -- list() ran exactly once (the failed call) and
  // recvSeq never advanced, so the message was neither read nor delivered. (In
  // isolation this same setup advances recvSeq to 1 and delivers the message.)
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(listCalls).toBe(1);
  expect(messageLoopInternals(conn).recvSeq).toBe(0);
});

// The ack publish poll() writes in retain mode is the one publish a transport can
// leave undetermined from inside the poll loop, so TransportPublishIndeterminateError
// -- a plain Error, not a UsageError -- is reachable at poll()'s catch. The pair
// below measures what that classification does and does not buy, in isolation and
// under the production composition.

// Stage the retain-mode ack publish as undetermined on its first attempt: the ack
// name is re-derived identically each cycle, so a later attempt republishes it.
function undeterminedFirstAck(client: FileTransportClient): () => number {
  let renames = 0;
  const realRename = client.rename.bind(client);
  client.rename = async (from: string, to: string) => {
    renames += 1;
    if (renames > 1) return realRename(from, to);
    throw new TransportPublishIndeterminateError(
      "the publish may or may not have reached the partner",
      { cause: new Error("_rename: No such file or directory") },
    );
  };
  return () => renames;
}

test("poll() retryable: an undetermined ack publish reschedules and the ack lands on a later cycle", async () => {
  const { client, files } = makeMockClient();
  const peerId = "peer-sender";
  const body = objectMessage({ v: 1 });
  files.set(`/shared/${peerId}-20260101T000000-000-${body.length}.json`, body);
  const conn = makeRetainConn(client, "receiver-me", peerId);
  const renameCount = undeterminedFirstAck(client);

  const errors: unknown[] = [];
  const received: unknown[] = [];
  let notifyReceived!: () => void;
  const delivered = new Promise<void>((r) => (notifyReceived = r));
  conn.on("data", (msg) => {
    received.push(msg);
    notifyReceived();
  });
  conn.on("error", (err) => errors.push(err));

  await runPoller(conn, delivered);

  // Not a UsageError, so poll()'s catch leaves pollerActive set: the next cycle
  // re-derives the same ack name, republishes it, and delivers the message.
  expect(errors[0]).toBeInstanceOf(TransportPublishIndeterminateError);
  expect(errors[0]).not.toBeInstanceOf(UsageError);
  expect(renameCount()).toBeGreaterThan(1);
  expect(received).toHaveLength(1);
  expect(messageLoopInternals(conn).recvSeq).toBe(1);
  expect([...files.keys()].some((p) => p.endsWith("-ack.json"))).toBe(true);
});

test("composed via fromEventConnection: an undetermined ack publish ends the exchange, so the reschedule above never runs", async () => {
  // The measurement that determines what the plain-Error classification is
  // worth to an EXCHANGE. The reschedule the test above measures is a property
  // of poll() standalone; in the CLI a FileSyncConnection is always bridged
  // through fromEventConnection, whose error listener fails the
  // MessageConnection on the first emitted poll error. So a publish this class
  // leaves undetermined ends the exchange whether or not it is classified
  // terminal -- the classification buys the loop's own retry, not a surviving
  // exchange.
  const { client, files } = makeMockClient();
  const peerId = "peer-sender";
  const body = objectMessage({ v: 1 });
  files.set(`/shared/${peerId}-20260101T000000-000-${body.length}.json`, body);
  const conn = makeRetainConn(client, "receiver-me", peerId);
  const renameCount = undeterminedFirstAck(client);

  const mc = fromEventConnection(conn);
  conn.start();

  const err = await mc.receive(1_000).then(
    () => {
      throw new Error(
        "receive() resolved; expected the poll error to reject it",
      );
    },
    (e: unknown) => e,
  );

  expect(err).toBeInstanceOf(ConnectionError);
  expect((err as ConnectionError).kind).toBe("transport");
  expect((err as Error).message).toContain("may or may not have reached");
  expect((err as ConnectionError).cause).toBeInstanceOf(
    TransportPublishIndeterminateError,
  );
  expect(messageLoopInternals(conn).pollerActive).toBe(false);

  // No later cycle: the ack was never republished and the message was never
  // delivered, where the isolation test above republishes and delivers.
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(renameCount()).toBe(1);
  expect(messageLoopInternals(conn).recvSeq).toBe(0);
  expect([...files.keys()].some((p) => p.endsWith("-ack.json"))).toBe(false);
});

test("poll() terminal: delete mode also stops the poller on a fully-synced corrupt message", async () => {
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

  const received: unknown[] = [];
  conn.on("data", (msg) => received.push(msg));
  // The settle gives a wrong reschedule time to trigger a second error.
  const { errors, pollerActiveBeforeDriverStop } = await driveUntilError(conn, {
    settleMs: 50,
  });

  expect(errors).toHaveLength(1);
  expect(errors[0]).toBeInstanceOf(UsageError);
  expect((errors[0] as Error).message).toContain("not valid JSON");
  expect(pollerActiveBeforeDriverStop).toBe(false);
  expect(received).toHaveLength(0);
  // parse-before-delete: the corrupt file is left on disk for inspection.
  expect(files.has(`/test/${msgName}`)).toBe(true);
});

test("poll() delivers a binary frame as raw bytes (no base64, no JSON wrapper)", async () => {
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client);
  const peerId = "peer-sender";
  conn.peerId = peerId;

  // A raw binary frame -- the shape an encrypted AEAD envelope takes on the wire
  // -- included verbatim in the binary message envelope. The 0x7b (`{`) byte
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

// --- unified ack marker: determinism, grammar routing, construct-and-match ---

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
  expect(messageLoopInternals(conn).recvSeq).toBe(0);
});

test("delete mode: hasOutstandingMessage ignores a `<id>-...-ack.json` file (numeric mid-name)", async () => {
  // The delete-mode sender's outstanding-message scan uses the grammar
  // discriminant, so a marker this party wrote -- whose embedded byte count (42)
  // is all digits but whose terminal segment is `ack` -- is not mistaken for an
  // unconsumed message. send() proceeds rather than spinning out the budget it
  // armed for the wait.
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { peerTimeoutMs: 300 });
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
    const clientOpts: MockClientOptions = {
      files: sharedFiles,
      deleteBehavior: "throw",
      createExclusiveBehavior: "throw",
    };

    const makeConn = (id: string) => {
      const c = new FileSyncConnection(makeMockClient(clientOpts).client, {
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

  files.set("/test/intruder.json", Buffer.from("x"));

  // Do NOT stop the poller in the handler: a terminal error must stop it on its
  // own.
  const { errors, pollerActiveBeforeDriverStop } = await driveUntilError(conn);

  expect(errors).toHaveLength(1);
  expect(errors[0]).toBeInstanceOf(UsageError);
  expect((errors[0] as Error).message).toContain("intruder.json");
  expect((errors[0] as Error).message).toContain("/test");
  // The poller stopped itself before emitting (UsageError is terminal).
  expect(pollerActiveBeforeDriverStop).toBe(false);
});

// The foreign/unexpected-file handler is the highest-priority live injection
// vector: a foreign filename passes every existing guard (length, count,
// protocol grammar) and rides into the terminal error. These pin that it reaches
// the operator only in escaped form, asserted at the rendered boundary (the
// altitude the escape happens at) rather than on the raw message, and covering
// the sanitizeForDisplay categories. Driven through the default error policy, the
// same path the ordinary-name test above exercises.
async function pollForeignFileError(hostileName: string): Promise<Error> {
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.peerId = "peer-test";
  files.set(`/test/${hostileName}`, Buffer.from("x"));

  const { errors } = await driveUntilError(conn);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toBeInstanceOf(UsageError);
  return errors[0] as Error;
}

test("poll(): the unexpected-file error escapes control/ANSI in a foreign filename", async () => {
  const rendered = sanitizeErrorForDisplay(
    await pollForeignFileError("\x1b[2J\x1b[31mEVIL.json"),
  );
  // The raw ESC that drives the sequence never reaches the operator's terminal;
  // it survives only as the inert escaped text.
  expect(rendered).not.toContain("\x1b");
  expect(rendered).toContain("\\x1b");
});

test("poll(): the unexpected-file error escapes a newline in a foreign filename", async () => {
  const rendered = sanitizeErrorForDisplay(
    await pollForeignFileError("ok.json\nFAKE: all clear"),
  );
  expect(rendered).not.toContain("\n");
  expect(rendered).toContain("\\x0a");
});

test("poll(): the unexpected-file error neutralizes deceptive Unicode in a foreign filename", async () => {
  // A bidi override (RLO), a zero-width char, and a Cyrillic homoglyph -- all
  // invisible or misleading rendered raw, all escaped here.
  const rendered = sanitizeErrorForDisplay(
    await pollForeignFileError("a\u202eb\u200bc\u0430d.json"),
  );
  expect(rendered).not.toContain("\u202e");
  expect(rendered).not.toContain("\u200b");
  expect(rendered).not.toContain("\u0430");
  expect(rendered).toContain("\\u202e");
  expect(rendered).toContain("\\u200b");
  expect(rendered).toContain("\\u0430");
});

test("poll(): a foreign filename with one literal backslash renders with one", async () => {
  // The tell that escaping happens at one altitude and not two: sanitizeForDisplay
  // doubles a backslash on every pass, so a second pass would show the operator
  // four backslashes for the one on disk -- a name they cannot match to the file.
  const hostile = "conflicted\\copy.json";
  const rendered = sanitizeErrorForDisplay(await pollForeignFileError(hostile));
  expect(rendered).toContain(sanitizeForDisplay(hostile));
  expect(rendered).not.toContain(
    sanitizeForDisplay(sanitizeForDisplay(hostile)),
  );
});

test("poll(): the unexpected-file error passes an ordinary printable filename through unchanged", async () => {
  const err = await pollForeignFileError("conflicted-copy.json");
  expect(err.message).toContain("conflicted-copy.json");
});

test("poll(): a peer-derived peerId with control/ANSI is escaped in a terminal error", async () => {
  // The duplicate-message guard names the peer id but no filename, so it
  // isolates peerId neutralization. The id is sliced from a hello filename
  // prefix at rendezvous, so it contains the partner's bytes.
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  const hostilePeerId = "peer\x1b[31m";
  conn.peerId = hostilePeerId;
  // Two delete-mode peer messages (distinct byte-count terminals) trip the
  // "more than one message file from <peerId>" terminal UsageError.
  files.set(`/test/${hostilePeerId}-5.json`, Buffer.from("12345"));
  files.set(`/test/${hostilePeerId}-6.json`, Buffer.from("123456"));

  const { errors } = await driveUntilError(conn);

  expect(errors).toHaveLength(1);
  expect(errors[0]).toBeInstanceOf(UsageError);
  const rendered = sanitizeErrorForDisplay(errors[0]);
  // The peer id is the only hostile content in this message (the path is the
  // ASCII /test), so a clean rendering proves peerId reaches the operator escaped.
  expect(rendered).toContain("more than one message file");
  expect(rendered).not.toContain("\x1b");
  expect(rendered).toContain("\\x1b");
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

  expect(errors).toHaveLength(0);
  expect(listCount).toBeGreaterThanOrEqual(5);
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
    expect(messageLoopInternals(conn).pollerActive).toBe(true);
  } finally {
    conn.stop();
  }
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

  expect(errors).toHaveLength(0);
  expect(listCount).toBeGreaterThanOrEqual(5);
  expect(logs).toHaveLength(0);
});

test("poll(): an ack-shaped foreign file whose target is not a real protocol file is flagged, not recognized", async () => {
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 5 });
  conn.id = "me";
  conn.peerId = "peer";
  files.set("/test/me-peer-x-ack.json", Buffer.alloc(0));

  const { errors, pollerActiveBeforeDriverStop } = await driveUntilError(conn);

  expect(errors).toHaveLength(1);
  expect(errors[0]).toBeInstanceOf(UsageError);
  expect((errors[0] as Error).message).toContain("me-peer-x-ack.json");
  expect(pollerActiveBeforeDriverStop).toBe(false);
});

// --- cancellable waits: close() cancels in-flight waits (D1-D6) ---------------

test("close() cancels an in-flight retain ack-wait promptly (site 4)", async () => {
  const { client } = makeMockClient();
  // The deadline cancellation has to beat is the peer-inactivity budget this
  // send arms, so it is set through open() (a hand-flagged connection would
  // silently take the one-hour default) and set large: retain mode skips
  // close()'s terminal-frame drain, so a large budget costs the test nothing.
  const HUGE_BUDGET_MS = 60_000;
  const conn = new FileSyncConnection(client, {
    pollingFrequency: 10,
    verbose: -1,
    locklessRendezvous: true,
    timestampInFilename: true,
    retainFiles: true,
  });
  await conn.open({
    channel: "filedrop",
    path: "/shared",
    options: { peerTimeoutMs: HUGE_BUDGET_MS },
  });
  conn.id = "me";
  conn.peerId = "peer";
  // seq>0 with a recorded lastSentFile drives send() into the ack-wait loop; the
  // peer never writes the ack, so it parks in this.wait (site 4).
  conn.seq = 1;
  messageLoopInternals(conn).lastSentFile = "me-20260101T000000-000-10.json";

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
  expect(Date.now() - start).toBeLessThan(HUGE_BUDGET_MS / 2);
});

test("close() cancels an in-flight delete-mode consume-wait promptly (site 5)", async () => {
  const { client, files } = makeMockClient();
  // The same deadline cancellation must beat, on the delete-mode wait. It is
  // kept modest rather than huge because this mode DOES run close()'s
  // terminal-frame drain, whose own budget is min(fixed drain, this) and which
  // this planted-and-never-consumed message makes spend the whole of it.
  const PEER_BUDGET_MS = 500;
  const conn = await makeConnectedConn(client, {
    pollingFrequency: 10,
    peerTimeoutMs: PEER_BUDGET_MS,
  });
  conn.peerId = "peer";
  // An outstanding message nobody consumes drives send() into the consume-wait.
  // The drain waits for the exact lastSentFile, so point it at the planted name.
  const outName = `${conn.id}-99.json`;
  files.set(`/test/${outName}`, Buffer.from(JSON.stringify({ stale: true })));
  messageLoopInternals(conn).lastSentFile = outName;

  let parked!: () => void;
  const reachedWait = new Promise<void>((r) => (parked = r));
  const origList = client.list;
  client.list = async (p: string) => {
    const result = await origList(p);
    parked();
    return result;
  };

  const start = Date.now();
  // Timed at the rejection rather than after close(): close()'s own drain spends
  // the rest of the budget here, and it is the WAIT that cancellation had to
  // unblock.
  let rejectedAt = 0;
  const outcome = conn.send({ blocked: true }).then(
    () => null,
    (err: unknown) => {
      rejectedAt = Date.now();
      return err;
    },
  );

  await reachedWait;
  await conn.close();

  const err = await outcome;
  expect(err).toBeInstanceOf(ConnectionClosedError);
  expect(rejectedAt - start).toBeLessThan(PEER_BUDGET_MS / 2);
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

    expect(conn.takeBufferedError()).toBeUndefined();
  });

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
  let errors: unknown[] = [];

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
    // The over-cap refusal must be terminal, not just typed: the poller stops
    // itself before emitting. Do NOT stop it in the handler, so a wrong
    // reschedule -- which would re-list the still-present over-cap file and
    // re-emit every pollingFrequency -- shows up during the settle instead of
    // being hidden by an immediate stop().
    const { errors: driveErrors, pollerActiveBeforeDriverStop } =
      await driveUntilError(conn, { settleMs: 50 });
    errors = driveErrors;
    expect(pollerActiveBeforeDriverStop).toBe(false);
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

test("poll reports an adapter frame-size cap as a terminal error", async () => {
  // A server that under-reports a file's size in its directory listing slips
  // past the pre-get() size check, so the adapter's hard read cap fires during
  // get() instead. That FrameSizeExceededError must be terminal -- the poller
  // must not re-read the same file every cycle (which would re-incur the very
  // allocation the cap prevents).
  const peerId = "peer-test";
  let getCount = 0;
  let errors: unknown[] = [];

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
    // The settle gives the poller a chance to (wrongly) reschedule before the
    // assertions below confirm it did not (get() ran exactly once).
    ({ errors } = await driveUntilError(conn, { settleMs: 60 }));
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
  // make two different drops compare equal and silently skip a real
  // "wrong drop" conflict. Pin it so a future regex tidy-up cannot regress it.
  expect(normalizeFiledropPath("/a//b")).toBe("/a//b");
  expect(normalizeFiledropPath("/mnt/share/.")).toBe("/mnt/share/.");
  expect(normalizeFiledropPath("/mnt/share/../other")).toBe(
    "/mnt/share/../other",
  );
  expect(normalizeFiledropPath("/MNT/Share")).toBe("/MNT/Share");
});

// --- synchronize(): session-start directory hygiene --------------------------
//
// Entry-guard classification (foreign vs protocol), the foreign-file snapshot,
// the opt-in --sweep-exchange-files sweep, and its pre-sweep retain-signal
// inspection / --force-retain-sweep guard.

test("poll(): a foreign file snapshotted at entry does not warn, but a new foreign file warns once", async () => {
  const errors: unknown[] = [];
  let listCount = 0;
  const [, logs] = await withCapturedLogs(async () => {
    const { client, files } = makeMockClient();
    const conn = await makeConnectedConn(client, { pollingFrequency: 5 });
    conn.peerId = "peer-test";
    conn.options.unexpectedFiles = "warn";
    // Simulate the entry snapshot: one foreign file was present at entry. Mutate
    // the shared snapshot Set in place (as rendezvous does at entry) rather than
    // replacing it, so the message loop -- which holds the same Set by reference
    // -- observes the entry.
    (
      conn as unknown as { foreignFileSnapshot: Set<string> }
    ).foreignFileSnapshot.add("preexisting.json");
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
  expect(logs.filter((l) => l.message.includes("newcomer.json"))).toHaveLength(
    1,
  );
});

// --- split inbound/outbound directories --------------------------------------

test("split directories: a full retain-mode exchange between two bridged parties", async () => {
  // Acceptance integration test. Two parties each have DISTINCT inbound and
  // outbound directories, bridged by a single in-memory store keyed by
  // directory: A writes to "/a2b" (= B's inbound) and reads "/b2a" (= B's
  // outbound); B is the mirror. The exchange runs rendezvous, a three-message
  // send/ack cycle, and a clean close end to end -- every peer read coming from
  // a party's inbound and every self write landing in its outbound.
  const store = new Map<string, Buffer>();
  // Throwing createExclusive forces the lockless ack-handshake barrier; the two
  // parties share one store keyed by directory (each reads its inbound, writes
  // its outbound).
  const clientOpts: MockClientOptions = {
    files: store,
    createExclusiveBehavior: "throw",
  };

  const mk = (
    id: string,
    inbound: string,
    outbound: string,
  ): FileSyncConnection => {
    const conn = new FileSyncConnection(makeMockClient(clientOpts).client, {
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
  // party whose OUTBOUND it is, so it contains that party's id prefix -- a
  // write that leaked into the peer's directory (e.g. an ack mis-routed to
  // inbound) would show up here as a wrong-prefixed name. A's own rendezvous
  // ack of B's hello (party-a-...-ack.json) correctly lives in A's outbound, so
  // an ack-absence check would be wrong; the prefix invariant is the right one.
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
  // SFTP open()-time safety check for a caller that bypasses the schema: "in"
  // and "in//" resolve to the same directory and are rejected by the same rule
  // the schema applies. The check must run before the SSH connect -- a
  // same-directory misconfig must not cause a real dial -- so spy on connect
  // and assert it never fired.
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
// when a caller bypasses the schema (which applies the identical rule).
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

// --- connection-per-poll idle-boundary signal --------------------------------
//
// A transport that implements the optional releaseForIdle()/ensureConnected()
// methods (the SFTP adapter in ephemeral mode) is driven by the core loop at its
// idle boundaries: ensureConnected() at the start of each poll cycle and before
// close()'s drain, releaseForIdle() at the inter-poll reschedule. A transport
// that omits them (the default; LocalFSClient) is unaffected. These pin the
// call sites, the transient-vs-fatal dial handling, and the ensure-connected
// -before-drain teardown, all against a mock client with the optional methods.

describe("connection-per-poll idle-boundary signal", () => {
  test("the poll loop ensures a connection at cycle start and releases it at the idle boundary", async () => {
    const { client } = makeMockClient();
    const seq: string[] = [];
    // Set the optional methods BEFORE constructing the connection: the
    // constructor's boundTransport wrap binds them once, so a later assignment
    // would not be forwarded.
    client.ensureConnected = async () => {
      seq.push("ensure");
      return true;
    };
    client.releaseForIdle = async () => {
      seq.push("release");
    };
    const origList = client.list.bind(client);
    client.list = async (dir: string) => {
      seq.push("list");
      return origList(dir);
    };
    const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
    conn.peerId = "stub-peer";
    conn.start();
    await new Promise((r) => setTimeout(r, 40));
    conn.stop();

    // Multiple cycles ran, each bracketed ensure -> list -> release.
    expect(seq.filter((s) => s === "ensure").length).toBeGreaterThanOrEqual(2);
    expect(seq.filter((s) => s === "release").length).toBeGreaterThanOrEqual(1);
    expect(seq.indexOf("ensure")).toBeLessThan(seq.indexOf("list"));
    expect(seq.indexOf("list")).toBeLessThan(seq.indexOf("release"));
  });

  test("a transient re-dial failure skips the cycle and retries on the next tick", async () => {
    const { client } = makeMockClient();
    let listCalls = 0;
    let ensureCalls = 0;
    // ensureConnected reports a transient dial failure every cycle (false): the
    // ops must be skipped and the loop must keep retrying, not fail the exchange.
    client.ensureConnected = async () => {
      ensureCalls += 1;
      return false;
    };
    client.releaseForIdle = async () => {};
    const origList = client.list.bind(client);
    client.list = async (dir: string) => {
      listCalls += 1;
      return origList(dir);
    };
    const errors: unknown[] = [];
    const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
    conn.peerId = "stub-peer";
    conn.on("error", (e) => errors.push(e));
    conn.start();
    await new Promise((r) => setTimeout(r, 40));
    const active = messageLoopInternals(conn).pollerActive;
    conn.stop();

    // Every cycle skipped its ops, emitted no terminal error, and rescheduled.
    expect(listCalls).toBe(0);
    expect(errors).toEqual([]);
    expect(ensureCalls).toBeGreaterThanOrEqual(2);
    expect(active).toBe(true);
  });

  test("a fatal re-dial failure terminates the exchange and stops the poller", async () => {
    const { client } = makeMockClient();
    client.ensureConnected = async () => {
      throw new Error("SFTP host-key verification failed: Host denied");
    };
    client.releaseForIdle = async () => {};
    const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
    conn.peerId = "stub-peer";

    const { errors, pollerActiveBeforeDriverStop } =
      await driveUntilError(conn);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toContain("Host denied");
    // The fatal dial stopped the poller itself (no reschedule into the same
    // rejection).
    expect(pollerActiveBeforeDriverStop).toBe(false);
  });

  test("a close() interrupting an in-flight poll cycle performs no idle release", async () => {
    // The release and the reschedule sit inside the same poller-active guard,
    // and close() clears that flag through stop() before it drives anything on
    // the transport, so a cycle still running when close() lands never reaches
    // a boundary at all: its session is moved into teardown rather than
    // released and re-established.
    const { client } = makeMockClient();
    const trace: string[] = [];
    let openCycleList!: () => void;
    let notifyCycleInFlight!: () => void;
    const cycleInFlight = new Promise<void>((r) => (notifyCycleInFlight = r));
    const heldList = new Promise<void>((r) => (openCycleList = r));
    let heldOnce = false;
    client.ensureConnected = async () => {
      trace.push("ensure");
      return true;
    };
    client.releaseForIdle = async () => {
      trace.push("release");
    };
    const origList = client.list.bind(client);
    client.list = async (dir: string) => {
      if (!heldOnce) {
        heldOnce = true;
        notifyCycleInFlight();
        await heldList;
      }
      return origList(dir);
    };

    const conn = await makeConnectedConn(client, { pollingFrequency: 5 });
    conn.peerId = "stub-peer";
    const errors: unknown[] = [];
    conn.on("error", (e) => errors.push(e));
    conn.start();
    await cycleInFlight;

    // close() runs stop() synchronously, so the parked cycle's finally reads an
    // inactive poller when the list below lets it resume.
    const closeP = conn.close();
    openCycleList();
    await closeP;

    // No boundary ran over that teardown. Moving the release outside the
    // poller-active guard puts a "release" in this trace.
    expect(trace).not.toContain("release");
    // The cycle really was in flight and teardown really did drive the
    // transport, so the absence above is the route's property and not a run
    // that never got going.
    expect(heldOnce).toBe(true);
    expect(trace).toContain("ensure");
    expect(errors).toEqual([]);
  });

  test("a close() from the inter-poll gap finds the session the last boundary released", async () => {
    // The mirror route: the boundary was reached with the poller still active,
    // so it released, and teardown is what establishes a session again.
    const { client } = makeMockClient();
    const trace: string[] = [];
    let notifyBoundary!: () => void;
    const boundaryReached = new Promise<void>((r) => (notifyBoundary = r));
    client.ensureConnected = async () => {
      trace.push("ensure");
      return true;
    };
    client.releaseForIdle = async () => {
      trace.push("release");
      notifyBoundary();
    };

    // Long enough that the next cycle cannot start before close() does.
    const conn = await makeConnectedConn(client, { pollingFrequency: 500 });
    conn.peerId = "stub-peer";
    const errors: unknown[] = [];
    conn.on("error", (e) => errors.push(e));
    conn.start();
    await boundaryReached;
    // Let the loop arm its reschedule, so close() is reached from the gap
    // rather than from inside the boundary itself.
    await new Promise((r) => setTimeout(r, 5));

    trace.push("close");
    await conn.close();

    // A release at the boundary, then a real re-establishment at teardown, in
    // that order. Dropping teardown's establish leaves no "ensure" past the
    // marker.
    const closeIdx = trace.indexOf("close");
    expect(trace.lastIndexOf("release")).toBeGreaterThanOrEqual(0);
    expect(trace.lastIndexOf("release")).toBeLessThan(closeIdx);
    expect(trace.indexOf("ensure", closeIdx)).toBeGreaterThan(closeIdx);
    expect(errors).toEqual([]);
  });

  test("the abort-marker write is not preceded by the teardown re-establishment", async () => {
    // The two teardown writes are asymmetric on purpose: the drain's session is
    // established for it, the marker's is recovered under it. An establish
    // issued ahead of the marker write would race that write's own re-dial on
    // the one shared session.
    const { client, files } = makeMockClient();
    const trace: string[] = [];
    client.ensureConnected = async () => {
      trace.push("ensure");
      return true;
    };
    client.releaseForIdle = async () => {
      trace.push("release");
    };
    const origRename = client.rename.bind(client);
    client.rename = async (from: string, to: string) => {
      trace.push(`rename ${to}`);
      return origRename(from, to);
    };

    const conn = await makeConnectedConn(client, {
      pollingFrequency: 500,
      peerTimeoutMs: 200,
    });
    conn.peerId = "stub-peer";
    conn.armAbort(new Uint8Array(32).fill(7), new Uint8Array(32).fill(9));

    // close() parks on the abort decision; the write resolves it, and close()
    // awaits that write before it reaches anything else.
    const closeP = conn.close();
    await conn.writeAbortMarker().catch(() => {});
    await closeP;

    const markerIdx = trace.findIndex(
      (entry) => entry.startsWith("rename ") && entry.endsWith("-abort.json"),
    );
    expect(markerIdx).toBeGreaterThanOrEqual(0);
    expect(files.has(`/test/${conn.id}-abort.json`)).toBe(true);
    // Nothing established a session ahead of the marker write, and teardown
    // established one after it -- so the ordering is not vacuous.
    expect(trace.slice(0, markerIdx)).not.toContain("ensure");
    expect(trace.indexOf("ensure")).toBeGreaterThan(markerIdx);
  });

  test("close() re-establishes a session before the drain deadline starts", async () => {
    const { client, files } = makeMockClient();
    const calls: string[] = [];
    let recording = false;
    client.ensureConnected = async () => {
      if (recording) calls.push("ensure");
      return true;
    };
    client.releaseForIdle = async () => {
      if (recording) calls.push("release");
    };
    const origList = client.list.bind(client);
    client.list = async (dir: string) => {
      if (recording) calls.push("list");
      return origList(dir);
    };

    const conn = await makeConnectedConn(client, {
      pollingFrequency: 5,
      peerTimeoutMs: 200,
    });
    conn.peerId = "stub-peer";
    await conn.send({ terminal: true });
    const msgPath = [...files.keys()].find((p) =>
      new RegExp(`^/test/${conn.id}-\\d+\\.json$`).test(p),
    );
    expect(msgPath).toBeDefined();

    // Record only the close() phase, so send()'s own list calls do not confound
    // the ordering assertion.
    recording = true;
    const closeP = conn.close();
    // Let the drain poll at least once before the peer "consumes" the frame.
    await new Promise((r) => setTimeout(r, 15));
    files.delete(msgPath!);
    await closeP;

    // The teardown re-dial ran, and it ran BEFORE the first drain list() -- so a
    // re-dial handshake is not billed to the drain budget.
    expect(calls).toContain("ensure");
    expect(calls).toContain("list");
    expect(calls.indexOf("ensure")).toBeLessThan(calls.indexOf("list"));
  });

  test("close() re-establishes the released session in retain mode too", async () => {
    // The re-establishment sits ABOVE the retain skip, not inside it, and must
    // stay there. Retain mode skips the terminal-frame drain below this call and
    // cleanup() is a global no-op in it, but a transport that could not perform a
    // cleanup delete across an idle boundary re-issues it at this re-dial -- and
    // an in-flight `temp-*.tmp` is a failed write rather than transcript, so a
    // retain run must not end holding one either.
    const { client } = makeMockClient();
    let ensured = 0;
    // Set before constructing: the constructor's boundTransport wrap forwards
    // the optional cycle-boundary signals only when the transport implements
    // them, and it reads that once.
    client.ensureConnected = async () => {
      ensured += 1;
      return true;
    };
    client.releaseForIdle = async () => {};
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
    conn.peerId = "stub-peer";

    await conn.close();

    expect(ensured).toBe(1);
  });

  test("a transport without the optional methods polls unchanged (default mode)", async () => {
    // The default mock omits releaseForIdle/ensureConnected; the loop's optional
    // calls must no-op and the cycle must run exactly as before.
    const { client } = makeMockClient();
    expect(client.ensureConnected).toBeUndefined();
    expect(client.releaseForIdle).toBeUndefined();
    let listCalls = 0;
    const origList = client.list.bind(client);
    client.list = async (dir: string) => {
      listCalls += 1;
      return origList(dir);
    };
    const errors: unknown[] = [];
    const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
    conn.peerId = "stub-peer";
    conn.on("error", (e) => errors.push(e));
    conn.start();
    await new Promise((r) => setTimeout(r, 30));
    conn.stop();

    expect(listCalls).toBeGreaterThanOrEqual(2);
    expect(errors).toEqual([]);
  });

  test("a cycle-boundary release and re-dial does not reset the in-memory session state", async () => {
    const { client, files } = makeMockClient();
    let dials = 0;
    let releases = 0;
    client.ensureConnected = async () => {
      dials += 1;
      return true;
    };
    client.releaseForIdle = async () => {
      releases += 1;
    };
    const conn = new FileSyncConnection(client, {
      pollingFrequency: 5,
      timeToLive: new Date(Date.now() + 5_000),
      verbose: -1,
      locklessRendezvous: true,
    });
    conn.id = "aaa";
    conn.connected = true;
    conn.path = "/test";
    // A peer hello (the one file the entry guard tolerates) and a foreign file
    // the entry scan snapshots; the peer's ack of this party's hello arrives
    // only after that scan, so the lockless barrier completes on a later poll.
    files.set(
      "/test/zzz-hello.json",
      Buffer.from(
        JSON.stringify({ locklessRendezvous: true, retainFiles: false }),
      ),
    );
    files.set("/test/notes.txt", Buffer.from("unrelated"));
    let listCalls = 0;
    const origList = client.list.bind(client);
    client.list = async (dir: string) => {
      if (listCalls++ === 1)
        files.set("/test/zzz-aaa-hello-ack.json", Buffer.alloc(0));
      return origList(dir);
    };

    await conn.synchronize();

    const snapshotOf = (c: FileSyncConnection): Set<string> =>
      (c as unknown as { foreignFileSnapshot: Set<string> })
        .foreignFileSnapshot;
    const capture = () => ({
      role: conn.role,
      peerId: conn.peerId,
      handshakeRole: conn.handshakeRole,
      seq: conn.seq,
      recvSeq: messageLoopInternals(conn).recvSeq,
      lastAckedNNN: messageLoopInternals(conn).lastAckedNNN,
      responsible: [...responsibleFilesOf(conn)].sort(),
      snapshot: [...snapshotOf(conn)].sort(),
    });
    const before = capture();
    // Rendezvous really did commit, so the comparison below is over live state
    // rather than an untouched blank.
    expect(before.peerId).toBe("zzz");
    expect(before.role).toBe("starter");
    expect(before.responsible).toEqual([
      "aaa-hello.json",
      "aaa-zzz-hello-ack.json",
    ]);
    expect(before.snapshot).toEqual(["notes.txt"]);
    expect(dials).toBe(0);

    const errors: unknown[] = [];
    conn.on("error", (err) => errors.push(err));
    conn.start();
    await new Promise((r) => setTimeout(r, 40));
    conn.stop();

    expect(errors).toEqual([]);
    expect(dials).toBeGreaterThanOrEqual(3);
    expect(releases).toBeGreaterThanOrEqual(2);
    expect(capture()).toEqual(before);
  });

  test("the idle-boundary release never falls inside a publish the poll loop performs", async () => {
    const { client, files } = makeMockClient();
    const trace: string[] = [];
    client.ensureConnected = async () => {
      trace.push("dial");
      return true;
    };
    client.releaseForIdle = async () => {
      trace.push("release");
    };
    const origPut = client.put.bind(client);
    client.put = async (src, dest, options) => {
      trace.push(`put ${dest}`);
      return origPut(src, dest, options);
    };
    const origRename = client.rename.bind(client);
    client.rename = async (from: string, to: string) => {
      trace.push(`rename ${to}`);
      return origRename(from, to);
    };

    const conn = new FileSyncConnection(client, {
      pollingFrequency: 5,
      timeToLive: new Date(Date.now() + 5_000),
      verbose: -1,
      locklessRendezvous: true,
      timestampInFilename: true,
      retainFiles: true,
    });
    conn.id = "receiver-me";
    conn.connected = true;
    conn.path = "/test";
    conn.peerId = "peer-sender";

    const message = objectMessage({ v: 1 });
    files.set(
      `/test/peer-sender-20260101T000000-000-${message.length}.json`,
      message,
    );

    let notifyReceived!: () => void;
    const delivered = new Promise<void>((r) => (notifyReceived = r));
    conn.on("data", () => notifyReceived());
    conn.start();
    await Promise.race([
      delivered,
      new Promise<void>((r) => setTimeout(r, 2_000)),
    ]);
    // Keep polling past the delivery so the run brackets the publish with a
    // boundary on both sides rather than stopping at the first one.
    await new Promise((r) => setTimeout(r, 25));
    conn.stop();

    // The retain ack is the publish the poll loop itself performs: a temp put
    // followed by the rename that commits the final name. The only release site
    // is the cycle's own finally, so the two ops are contiguous and no boundary
    // can leave the temp orphaned with the peer's go-ahead signal missing.
    const tempPut = trace.findIndex(
      (entry) => entry.startsWith("put ") && entry.endsWith(".tmp"),
    );
    const ackRename = trace.findIndex(
      (entry) => entry.startsWith("rename ") && entry.endsWith("-ack.json"),
    );
    expect(tempPut).toBeGreaterThanOrEqual(0);
    expect(ackRename).toBeGreaterThan(tempPut);
    expect(trace.slice(tempPut, ackRename)).not.toContain("release");
    // The boundaries are live in this run, so the exclusion above is real: the
    // first release lands after the publish committed, and further cycles
    // dialed again.
    expect(trace.indexOf("release")).toBeGreaterThan(ackRename);
    expect(trace.filter((entry) => entry === "dial").length).toBeGreaterThan(1);
  });
});

// --- unconfirmed entry-present peer hello ------------------------------------
//
// The lock joiner fast path consumes an entry-present hello and commits
// role/peerId with no observation attributable to a live peer, so a consumer
// that later attributes silence to "the peer" would be asserting a fact this
// side never established. The connection exposes exactly what it does hold.

test("unconfirmedEntryPeerHello is undefined when no peer hello predated the run", async () => {
  const { connA, connB } = makeRendezvousPair(
    ID_LOW,
    { locklessRendezvous: true },
    ID_HIGH,
    { locklessRendezvous: true },
  );

  await Promise.all([connA.synchronize(), connB.synchronize()]);

  // Whichever party saw the other's hello saw it appear AFTER its own entry
  // scan, and each observed the other's ack of its own hello besides.
  expect(connA.unconfirmedEntryPeerHello).toBeUndefined();
  expect(connB.unconfirmedEntryPeerHello).toBeUndefined();
});

test("a delivered peer message clears unconfirmedEntryPeerHello", async () => {
  const { client, files } = makeMockClient();
  const conn = await makeConnectedConn(client, { pollingFrequency: 10 });
  conn.id = ID_HIGH;
  const peerHelloName = `${ID_LOW}-hello.json`;
  files.set(`${conn.path}/${peerHelloName}`, LOCK_HELLO_BODY);
  await conn.synchronize();
  expect(conn.unconfirmedEntryPeerHello).toBe(peerHelloName);

  // A peer message reaching the application is an observation attributable to a
  // live peer, so the entry-time hello counts as confirmed from then on.
  const payload = objectMessage({ hello: "world" });
  files.set(`${conn.path}/${ID_LOW}-${payload.length}.json`, payload);
  const received = new Promise<unknown>((resolve) =>
    conn.once("data", resolve),
  );
  conn.start();
  await received;
  conn.stop();

  expect(conn.unconfirmedEntryPeerHello).toBeUndefined();
});
