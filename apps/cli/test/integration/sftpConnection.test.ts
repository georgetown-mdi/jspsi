import fs from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, expect, test } from "vitest";
import { FileSyncConnection, UsageError } from "@psilink/core";

import { SSH2SFTPClientAdapter } from "../../src/connection/ssh2SftpAdapter";
import { sftpPort } from "../container/env";

import log from "loglevel";

log.setLevel(log.levels.DEBUG);

// compose.yaml mounts apps/cli/test/container/sftp/srv/ as /home/{user}/psi
// inside the container, so subdirectories of srv/ are served as subdirectories
// of /psi via SFTP. beforeAll creates SFTP_LOCAL_DIRECTORY with { recursive:
// true } before opening connections, so the host directory exists when the
// server needs it.
const SFTP_LOCAL_DIRECTORY = "test/container/sftp/srv/sftp";
const SFTP_PATH = "/psi/sftp";
const SFTP_PORT = sftpPort();

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

// Poll a predicate until it holds (no fixed sleep), failing if it never does.
async function waitFor(
  predicate: () => Promise<boolean>,
  { timeoutMs = 5_000, intervalMs = 25 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("waitFor: condition not met within timeout");
}

const serverSFTP = new SSH2SFTPClientAdapter();
const serverConn = new FileSyncConnection(serverSFTP, { verbose: -1 });
const clientSFTP = new SSH2SFTPClientAdapter();
const clientConn = new FileSyncConnection(clientSFTP, { verbose: -1 });

serverConn.on("error", (err: unknown) => {
  throw new Error(String(err));
});
clientConn.on("error", (err: unknown) => {
  throw new Error(String(err));
});

beforeAll(async () => {
  await fs.mkdir(SFTP_LOCAL_DIRECTORY, { recursive: true });
  await cleanServer();
  await Promise.all([
    serverConn.open({
      channel: "sftp",
      server: {
        host: "localhost",
        port: SFTP_PORT,
        username: "usera",
        password: "usera",
        path: SFTP_PATH,
      },
    }),
    clientConn.open({
      channel: "sftp",
      server: {
        host: "localhost",
        port: SFTP_PORT,
        username: "userb",
        password: "userb",
        path: SFTP_PATH,
      },
    }),
  ]);
});

afterAll(async () => {
  await Promise.all([clientConn.close(), serverConn.close()]);
  await cleanServer();
});

// to test race condition, Promise.all is used when synchronizing
// to set an explicit order, one party is delayed a tick by using setImmediate

test("wave synchronization with race condition", async () => {
  await Promise.all([serverConn.synchronize(), clientConn.synchronize()]);

  const currentFiles = await serverSFTP.list(SFTP_PATH);

  expect(serverConn.peerId).toEqual(clientConn.id);
  expect(clientConn.peerId).toEqual(serverConn.id);
  expect(serverConn.handshakeRole !== clientConn.handshakeRole).toBe(true);

  expect(currentFiles.length).toEqual(0);

  desynchronize(serverConn);
  desynchronize(clientConn);
});

test("basic synchronization", async () => {
  await serverSFTP.put(
    // The planted peer hello must advertise the bilateral mode flags
    // (193901017); an empty {} body now fails the HelloEnvelope schema. Both
    // parties run default wave mode, so both flags are false.
    Buffer.from(
      JSON.stringify({ locklessRendezvous: false, retainFiles: false }),
    ),
    `${SFTP_PATH}/${clientConn.id}-hello.json`,
  );

  await serverConn.synchronize();

  const currentFiles = await serverSFTP.list(SFTP_PATH);

  await serverSFTP.safeDelete(`${SFTP_PATH}/${serverConn.id}-hello.json`);

  expect(serverConn.peerId).toBe(clientConn.id);
  expect(serverConn.handshakeRole).toBe("initiator");

  expect(currentFiles.length).toBe(1);
  expect(currentFiles[0].name === `${serverConn.id}-hello.json`).toBe(true);

  desynchronize(serverConn);
});

test("message deliverable", async () => {
  const serverSyncPromise = serverConn.synchronize();
  setImmediate(async () => {
    await clientConn.synchronize();
  });
  await serverSyncPromise;

  serverConn.start();

  const serverMessagePromise = new Promise((resolve) => {
    serverConn.once("data", (data: unknown) => {
      resolve(data);
    });
  });

  await clientConn.send({ message: "hello world" });
  const message = await serverMessagePromise;

  serverConn.stop();

  desynchronize(serverConn);
  desynchronize(clientConn);

  expect(message).toEqual({ message: "hello world" });
});

test("terminal frame is received when sender closes before receiver polls", async () => {
  // Regression guard for the terminal-frame deletion race: the sender's
  // close() must drain (wait for the receiver to consume the last sent file)
  // before running cleanup. This test sends a message, starts the receiver
  // polling concurrently with sender close(), and verifies the message arrives.
  // Without the drain, cleanup() deletes the file before the receiver polls and
  // the message is lost.

  const senderSFTP = new SSH2SFTPClientAdapter();
  const senderConn = new FileSyncConnection(senderSFTP, { verbose: -1 });
  const receiverSFTP = new SSH2SFTPClientAdapter();
  const receiverConn = new FileSyncConnection(receiverSFTP, { verbose: -1 });

  const base = {
    channel: "sftp" as const,
    server: { host: "localhost", port: SFTP_PORT, path: SFTP_PATH },
  };

  await Promise.all([
    senderConn.open({
      ...base,
      server: { ...base.server, username: "usera", password: "usera" },
    }),
    receiverConn.open({
      ...base,
      server: { ...base.server, username: "userb", password: "userb" },
    }),
  ]);

  await Promise.all([senderConn.synchronize(), receiverConn.synchronize()]);

  await senderConn.send({ terminal: true });

  const received = new Promise<unknown>((resolve) => {
    receiverConn.once("data", resolve);
  });

  // Start the receiver polling concurrently with sender close().
  // The drain in close() holds cleanup until the receiver consumes the file.
  receiverConn.start();
  await senderConn.close();

  const message = await received;

  receiverConn.stop();
  await receiverConn.close();

  expect(message).toEqual({ terminal: true });
});

test("wave starter aborts on a stuck mid-arrival joiner over real SFTP", async () => {
  // End-to-end recovery path on the real SFTP transport. A joiner writes its
  // sentinel and deletes the starter's hello, then crashes before renaming the
  // sentinel to its own hello. The starter must observe the orphaned sentinel
  // over real SFTP and abort on the bounded recovery window with the actionable
  // error -- not poll to the full peer timeout. (The happy-path sentinel
  // put/delete/rename runs under the hood whenever a real joiner arrives second
  // in the wave tests above; this exercises the failure side, which those do
  // not.)
  await cleanServer();

  const abortSFTP = new SSH2SFTPClientAdapter();
  // joinerRecoveryMs well under the peer timeout so the bounded-window abort
  // fires first; the 100 ms default poll keeps the abort prompt.
  const abortConn = new FileSyncConnection(abortSFTP, {
    verbose: -1,
    joinerRecoveryMs: 400,
  });
  await abortConn.open({
    channel: "sftp",
    server: {
      host: "localhost",
      port: SFTP_PORT,
      username: "usera",
      password: "usera",
      path: SFTP_PATH,
    },
    options: { peerTimeoutMs: 8_000 },
  });

  const fakeJoinerId = "00000000-0000-4000-8000-0000000000aa";
  const sentinelName = `${fakeJoinerId}-joining.json`;
  const helloName = `${abortConn.id}-hello.json`;

  // Start the starter without awaiting: it writes its hello and begins polling.
  const syncPromise = abortConn.synchronize();

  try {
    // Wait until the starter's hello has landed, then simulate the stuck joiner
    // using the already-connected serverSFTP session (a separate SFTP client, so
    // it does not contend with the starter's own polling on abortSFTP): delete
    // the hello and drop a sentinel from a different id in its place.
    await waitFor(async () =>
      (await serverSFTP.list(SFTP_PATH)).some((f) => f.name === helloName),
    );
    await serverSFTP.safeDelete(`${SFTP_PATH}/${helloName}`);
    await serverSFTP.put(
      Buffer.from(
        JSON.stringify({ locklessRendezvous: false, retainFiles: false }),
      ),
      `${SFTP_PATH}/${sentinelName}`,
    );

    const err = await syncPromise.catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(
      /did not complete within the recovery window/,
    );
    // Transport failure (CLI exit 69), not a usage error (exit 64) -- mirrors
    // the unit-test assertion so a regression that reclassified the abort would
    // be caught over the real transport too.
    expect(err).not.toBeInstanceOf(UsageError);
  } finally {
    await serverSFTP.safeDelete(`${SFTP_PATH}/${sentinelName}`);
    await abortConn.close();
    await cleanServer();
  }
});
