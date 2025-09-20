
import { afterAll, beforeAll, expect, test,  } from 'vitest'

import { SFTPConnection } from 'src/psi/connection/sftpConnection';

import log from 'loglevel';

log.setLevel(log.levels.DEBUG);

function asynchronize(conn: SFTPConnection) {
  conn.peerId = undefined;
  conn.firstToParty = undefined;
  conn.role = 'unknown'
}

const serverConn = new SFTPConnection({verbose: 0});
const clientConn = new SFTPConnection({verbose: 0});

serverConn.on('error', (err: any) => { throw new Error(err) })
clientConn.on('error', (err: any) => { throw new Error(err) })

beforeAll(async () => {
  await Promise.all([
    serverConn.open('sftp://usera:usera@localhost:2222/psi'),
    clientConn.open('sftp://userb:userb@localhost:2222/psi')
  ]);
});

afterAll(async () => {
  await Promise.all([
    clientConn.close(),
    serverConn.close()
  ]);
});

test('wave synchronization with race condition', async () => {
  await Promise.all([
    serverConn.synchronize(),
    clientConn.synchronize()
  ]);

  const currentFiles = await serverConn.sftp.list('/psi');

  expect(serverConn.peerId).toEqual(clientConn.id);
  expect(clientConn.peerId).toEqual(serverConn.id);
  expect(serverConn.firstToParty !== clientConn.firstToParty).toBe(true)

  expect(currentFiles.length).toEqual(0);

  asynchronize(serverConn);
  asynchronize(clientConn);
});

test('basic synchronization', async () => {
  await serverConn.sftp.put(
    Buffer.from(new ArrayBuffer(0)),
    `/psi/${clientConn.id}.hello`
  );

  await serverConn.synchronize();

  const currentFiles = await serverConn.sftp.list('/psi');

  await serverConn.sftp.delete(`/psi/${serverConn.id}.hello`, true);

  expect(serverConn.peerId).toBe(clientConn.id);
  expect(serverConn.firstToParty).toBe(false);

  expect(currentFiles.length).toBe(1);
  expect(currentFiles[0].name === `${serverConn.id}.hello`);

  asynchronize(serverConn);
  asynchronize(clientConn);
});

test('message deliverable', async () => {
  const serverSyncPromise = serverConn.synchronize();
  setImmediate(async () => { await clientConn.synchronize() });
  await serverSyncPromise;

  serverConn.start()

  const serverMessagePromise = new Promise((resolve) => {
    serverConn.once('data', (data: unknown) => {
      resolve(data);
    });
  });

  await clientConn.send({message: 'hello world'});
  const message = await serverMessagePromise;

  serverConn.stop();

  asynchronize(serverConn);
  asynchronize(clientConn);

  expect(message).toEqual({message: 'hello world'});
});
