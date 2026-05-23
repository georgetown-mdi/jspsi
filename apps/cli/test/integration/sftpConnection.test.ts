import fs from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, expect, test } from "vitest";
import { FileSyncConnection } from "@psilink/core";

import { SSH2SFTPClientAdapter } from "../../src/connection/ssh2SftpAdapter";

import log from "loglevel";

log.setLevel(log.levels.DEBUG);

// compose.yaml mounts apps/cli/test/container/sftp/srv/ as /home/{user}/psi
// inside the container, so subdirectories of srv/ are served as subdirectories
// of /psi via SFTP. beforeAll creates SFTP_LOCAL_DIRECTORY with { recursive:
// true } before opening connections, so the host directory exists when the
// server needs it.
const SFTP_LOCAL_DIRECTORY = "test/container/sftp/srv/sftp";
const SFTP_PATH = "/psi/sftp";

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
        port: 2222,
        username: "usera",
        password: "usera",
        path: SFTP_PATH,
      },
    }),
    clientConn.open({
      channel: "sftp",
      server: {
        host: "localhost",
        port: 2222,
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
    Buffer.from(new ArrayBuffer(0)),
    `${SFTP_PATH}/${clientConn.id}.hello`,
  );

  await serverConn.synchronize();

  const currentFiles = await serverSFTP.list(SFTP_PATH);

  await serverSFTP.safeDelete(`${SFTP_PATH}/${serverConn.id}.hello`);

  expect(serverConn.peerId).toBe(clientConn.id);
  expect(serverConn.handshakeRole).toBe("initiator");

  expect(currentFiles.length).toBe(1);
  expect(currentFiles[0].name === `${serverConn.id}.hello`).toBe(true);

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
