import { expect, test } from 'vitest'

import log from 'loglevel';

import { PSIParticipant } from "src/psi/participant";

import { PassthroughConnection } from './passthroughConnection';

log.setLevel('DEBUG');

async function psiLoader() {
  // @ts-ignore not implementing types
  const module = await import('scripts/psi_wasm_node.cjs');
  return await module.default();
}

// @ts-ignore top level await enabled by tsconfig module: "ESNext
const psiLibrary = await psiLoader();

const serverConn = new PassthroughConnection();
const clientConn = new PassthroughConnection(serverConn);
serverConn.setOther(clientConn);

const server = new PSIParticipant(
  'server', psiLibrary, { role: 'either', verbose: 1 }
);

const client = new PSIParticipant(
  'client', psiLibrary, { role: 'either', verbose: 1 }
);

const serverData = [
  'Alice', 'Bob', 'Carol', 'David', 'Elizabeth', 'Frank', 'Greta',
];

const clientData = [ 'Carol', 'Elizabeth', 'Henry' ];


await (async() => {
  await Promise.all([
    server.exchangeRoles(serverConn, true),
    client.exchangeRoles(clientConn, false),
  ])
})();

let [serverResult, clientResult] = await (async () => {
  return await Promise.all([
    server.identifyIntersection(serverConn, serverData),
    client.identifyIntersection(clientConn, clientData)
  ]);
})();

test('server and client yield identical results', () => {
  expect(serverResult[0].sort()).toStrictEqual(clientResult[1].sort());
  expect(serverResult[1].sort()).toStrictEqual(clientResult[0].sort());
});

test('psi yields correct results', () => {
  expect(serverResult[0].sort()).toStrictEqual([2, 4]);
  expect(serverResult[1].sort()).toStrictEqual([0, 1]);
});

test('listeners removed correctly', () => {
  expect(serverConn.listenerCount('data')).toBe(0);
  expect(clientConn.listenerCount('data')).toBe(0);
});

[clientResult, serverResult] = await (async () => {
  return await Promise.all([
    client.identifyIntersection(clientConn, clientData),
    server.identifyIntersection(serverConn, serverData)
  ]);
})();

test('order doesn\'t matter', () => {
  expect(serverResult[0]).toStrictEqual(clientResult[1]);
  expect(serverResult[1]).toStrictEqual(clientResult[0]);
  expect(serverResult[0].sort()).toStrictEqual([2, 4]);
  expect(serverResult[1].sort()).toStrictEqual([0, 1]);
});
