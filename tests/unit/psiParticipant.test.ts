import { expect, test } from 'vitest'

import { PSIParticipant } from "src/psi/participant";

import { PassthroughConnection } from '../utils/passthroughConnection';
import { sortAssociationTable } from '../utils/associationTable';


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
  'server', psiLibrary, { role: 'either', verbose: 0 }
);

const client = new PSIParticipant(
  'client', psiLibrary, { role: 'either', verbose: 0 }
);

const serverData = [
  'Alice', 'Bob', 'Carol', 'David', 'Elizabeth', 'Frank', 'Greta',
];

const clientData = [ 'Carol', 'Elizabeth', 'Henry' ];


await (async () => {
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

serverResult = sortAssociationTable(serverResult);
clientResult = sortAssociationTable(clientResult, true);

test('server and client yield identical results', () => {
  expect(serverResult[0]).toStrictEqual(clientResult[1]);
  expect(serverResult[1]).toStrictEqual(clientResult[0]);
});

test('psi yields correct results', () => {
  expect(serverResult[0]).toStrictEqual([2, 4]);
  expect(serverResult[1]).toStrictEqual([0, 1]);
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

serverResult = sortAssociationTable(serverResult);
clientResult = sortAssociationTable(clientResult, true);

test('order doesn\'t matter', () => {
  expect(serverResult[0]).toStrictEqual(clientResult[1]);
  expect(serverResult[1]).toStrictEqual(clientResult[0]);
  expect(serverResult[0]).toStrictEqual([2, 4]);
  expect(serverResult[1]).toStrictEqual([0, 1]);
});
