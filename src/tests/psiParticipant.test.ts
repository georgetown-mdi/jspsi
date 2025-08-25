import { expect, test } from 'vitest'

import { default as EventEmitter } from 'eventemitter3';

import { PSIParticipant } from "src/psi/participant";

import log from 'loglevel';

import type { DataConnection } from "peerjs";

async function psiLoader() {
  // @ts-ignore not implementing types
  const module = await import('scripts/psi_wasm_node.cjs');
  return await module.default();
}

// @ts-ignore top level await enabled by tsconfig module: "ESNext
const psiLibrary = await psiLoader();

interface ConnectionEvents {
    close: () => void;
    data: (data: any) => void;
    open: () => void;
}

class PassthroughConnection extends EventEmitter<ConnectionEvents, never> {
  other: PassthroughConnection | undefined;

  constructor(other?: PassthroughConnection) {
    super();
    this.other = other;
  }

  send(data: any) {
    setImmediate(() => { this.other!.emit('data', data); });
  }
  setOther(other: PassthroughConnection) {
    this.other = other;
  }
}

const conn1 = new PassthroughConnection();
const conn2 = new PassthroughConnection(conn1);
conn1.setOther(conn2);

const server = new PSIParticipant(
  'server',
  psiLibrary,
  conn1 as unknown as DataConnection,
  { role: 'either' }
);

const client = new PSIParticipant(
  'client',
  psiLibrary,
  conn2 as unknown as DataConnection,
  { role: 'either' }
);

const serverData = [
  'Alice', 'Bob', 'Carol', 'David', 'Elizabeth', 'Frank', 'Greta'
];

const clientData = [ 'Carol', 'Elizabeth', 'Henry' ];

log.setLevel('DEBUG');

await (async() => {
  await Promise.all([
    server.exchangeRoles(true),
    client.exchangeRoles(false),
  ])
})();

let [serverResult, clientResult] = await (async () => {
  return await Promise.all([
    server.identifyIntersection(serverData),
    client.identifyIntersection(clientData)
  ]);
})();

test('server and client yield identical results', () => {
  expect(serverResult[0]).toBe(clientResult[1]);
  expect(serverResult[1]).toBe(clientResult[0]);
});

test('psi yields correct results', () => {
  expect(serverResult[0].sort()).toStrictEqual([2, 4]);
  expect(serverResult[1].sort()).toStrictEqual([0, 1]);
});

test('listeners removed correctly', () => {
  // @ts-ignore accessing private member
  expect(server.conn.listenerCount('data')).toBe(0);
  // @ts-ignore accessing private member
  expect(client.conn.listenerCount('data')).toBe(0);
});

[clientResult, serverResult] = await (async () => {
  return await Promise.all([
    client.identifyIntersection(clientData),
    server.identifyIntersection(serverData)
  ]);
})();

test('order doesn\'t matter', () => {
  expect(serverResult[0]).toBe(clientResult[1]);
  expect(serverResult[1]).toBe(clientResult[0]);
  expect(serverResult[0].sort()).toStrictEqual([2, 4]);
  expect(serverResult[1].sort()).toStrictEqual([0, 1]);
});
