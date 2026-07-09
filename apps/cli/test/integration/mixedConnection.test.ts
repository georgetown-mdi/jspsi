import fs from "node:fs/promises";
import path from "node:path";

import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { FileSyncConnection } from "@psilink/core";

import { LocalFSClient } from "../../src/connection/localFSClient";
import { SSH2SFTPClientAdapter } from "../../src/connection/ssh2SftpAdapter";
import {
  ensureNamespace,
  localPath,
  remotePath,
  serverAuth,
  sftpServer,
} from "../sftpServer/testContext";

import log from "loglevel";

log.setLevel(log.levels.DEBUG);

// This file mixes a real SFTP party with a filedrop party sharing one rendezvous
// directory: SFTP_LOCAL_DIRECTORY is the host directory the SFTP server serves,
// which the filedrop LocalFSClient also points at, so the two transports meet in
// the same `mixed` namespace. ensureNamespace creates that directory before
// either party connects (the SFTP connection does not create remote directories),
// and LocalFSClient needs the absolute host path.
const srv = sftpServer();
const NS = "mixed";
const SFTP_LOCAL_DIRECTORY = localPath(srv, NS);
const SFTP_PATH = remotePath(srv, NS);

async function cleanServer() {
  for (const file of await fs.readdir(SFTP_LOCAL_DIRECTORY)) {
    try {
      await fs.unlink(path.join(SFTP_LOCAL_DIRECTORY, file));
    } catch {
      // ignore
    }
  }
}

function desynchronize(conn: FileSyncConnection) {
  conn.peerId = undefined;
  conn.handshakeRole = undefined;
  conn.role = "unknown";
}

const sftpAdapter = new SSH2SFTPClientAdapter();
const sftpConn = new FileSyncConnection(sftpAdapter, {
  verbose: -1,
  pollingFrequency: 10,
});
const localConn = new FileSyncConnection(new LocalFSClient(), {
  verbose: -1,
  pollingFrequency: 10,
});

sftpConn.on("error", (err: unknown) => {
  throw new Error(String(err));
});
localConn.on("error", (err: unknown) => {
  throw new Error(String(err));
});

beforeAll(async () => {
  await ensureNamespace(srv, NS);
  await cleanServer();
  await Promise.all([
    sftpConn.open({
      channel: "sftp",
      server: {
        host: srv.host,
        port: srv.port,
        ...serverAuth(srv.usera),
        path: SFTP_PATH,
      },
    }),
    localConn.open({ channel: "filedrop", path: SFTP_LOCAL_DIRECTORY }),
  ]);
});

// to test race condition, Promise.all is used when synchronizing
// to set an explicit order, one party is delayed a tick by using setImmediate

// All tests in this file share one SFTP_PATH rendezvous directory and reuse the
// module-level connections. A test that crashes mid-protocol -- e.g. a transient
// SFTP rename failure in the joiner fast-path -- intentionally leaves its
// <uuid>-joining.json sentinel behind (it is the peer's cross-process recovery
// signal; see fileSyncConnection synchronize()). Without per-test cleanup that
// stray sentinel trips the next test's session-start hygiene guard, turning one
// transient flake into three red tests. Reset the directory and the shared
// connection state after every test so a single failure cannot cascade to its
// siblings.
afterEach(async () => {
  // Quiesce any poller before touching the directory. The message-exchange
  // tests call start() then stop() inline, but a failure between the two -- the
  // flaky scenario this branch targets -- would leave a poller running. stop()
  // (idempotent, and a no-op for the tests that never start one) clears
  // pollerActive, so the next scheduled poll does not fire and any in-flight
  // poll swallows its result instead of racing the cleanServer() below and
  // re-throwing through the module-level on("error") handlers into the next
  // test (see fileSyncConnection poll()'s shutdown guard).
  sftpConn.stop();
  localConn.stop();
  await cleanServer();
  desynchronize(sftpConn);
  desynchronize(localConn);
});

afterAll(async () => {
  await Promise.all([sftpConn.close(), localConn.close()]);
  await cleanServer();
});

test("lock synchronization with race condition", async () => {
  await Promise.all([sftpConn.synchronize(), localConn.synchronize()]);

  expect(sftpConn.peerId).toEqual(localConn.id);
  expect(localConn.peerId).toEqual(sftpConn.id);
  expect(sftpConn.handshakeRole !== localConn.handshakeRole).toBe(true);

  const currentFiles = await sftpAdapter.list(SFTP_PATH);
  expect(currentFiles.length).toEqual(0);

  desynchronize(sftpConn);
  desynchronize(localConn);
});

test("basic synchronization", async () => {
  await sftpAdapter.put(
    // The planted peer hello must advertise the bilateral mode flags
    // (193901017); an empty {} body now fails the HelloEnvelope schema. Both
    // parties run default lock mode, so both flags are false.
    Buffer.from(
      JSON.stringify({ locklessRendezvous: false, retainFiles: false }),
    ),
    `${SFTP_PATH}/${localConn.id}-hello.json`,
  );

  await sftpConn.synchronize();

  const currentFiles = await sftpAdapter.list(SFTP_PATH);
  await sftpAdapter.safeDelete(`${SFTP_PATH}/${sftpConn.id}-hello.json`);

  expect(sftpConn.peerId).toBe(localConn.id);
  expect(sftpConn.handshakeRole).toBe("initiator");

  expect(currentFiles.length).toBe(1);
  expect(currentFiles[0].name).toBe(`${sftpConn.id}-hello.json`);

  desynchronize(sftpConn);
});

test("joiner rendezvous recovers from a transient rename failure", async () => {
  // End-to-end guard for acceptance criterion (a): a transient SSH_FX_FAILURE on
  // the joiner's atomic <id>-joining.json -> <id>-hello.json rename must recover
  // transparently rather than crash the rendezvous (the original flake). The
  // mocked unit tests pin the adapter's retry contract in isolation; this drives
  // it through the real adapter and a real server so an adapter<->core wiring
  // regression (e.g. the predicate stops matching the real numeric code) is
  // caught here, where the unit tests would not see it.
  await sftpAdapter.put(
    Buffer.from(
      JSON.stringify({ locklessRendezvous: false, retainFiles: false }),
    ),
    `${SFTP_PATH}/${localConn.id}-hello.json`,
  );

  // Inject one status-4 failure at the ssh2-sftp-client layer -- below the
  // adapter's retry -- then delegate to the real rename so the retry's second
  // attempt actually succeeds against the server.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = (sftpAdapter as any).client;
  const realRename = client.rename.bind(client);
  let injectedFailure = false;
  client.rename = (from: string, to: string) => {
    if (!injectedFailure) {
      injectedFailure = true;
      return Promise.reject(Object.assign(new Error("Failure"), { code: 4 }));
    }
    return realRename(from, to);
  };

  try {
    await sftpConn.synchronize();
  } finally {
    client.rename = realRename;
  }

  const currentFiles = await sftpAdapter.list(SFTP_PATH);
  await sftpAdapter.safeDelete(`${SFTP_PATH}/${sftpConn.id}-hello.json`);

  // The failure path was actually exercised (guards against a false green), and
  // the rendezvous still completed.
  expect(injectedFailure).toBe(true);
  expect(sftpConn.peerId).toBe(localConn.id);
  expect(sftpConn.handshakeRole).toBe("initiator");
  expect(currentFiles.length).toBe(1);
  expect(currentFiles[0].name).toBe(`${sftpConn.id}-hello.json`);

  desynchronize(sftpConn);
});

test.each([
  {
    label: "sftp sends, local receives",
    sender: sftpConn,
    receiver: localConn,
  },
  {
    label: "local sends, sftp receives",
    sender: localConn,
    receiver: sftpConn,
  },
])("$label", async ({ sender, receiver }) => {
  const sftpSyncPromise = sftpConn.synchronize();
  const localSyncPromise = new Promise<void>((resolve, reject) => {
    setImmediate(() => void localConn.synchronize().then(resolve, reject));
  });
  await Promise.all([sftpSyncPromise, localSyncPromise]);

  receiver.start();

  const messagePromise = new Promise((resolve) => {
    receiver.once("data", (data: unknown) => {
      resolve(data);
    });
  });

  const payload = {
    message: `hello from ${sender === sftpConn ? "sftp" : "local"}`,
  };
  await sender.send(payload);
  const message = await messagePromise;

  receiver.stop();

  desynchronize(sftpConn);
  desynchronize(localConn);

  expect(message).toEqual(payload);
});
