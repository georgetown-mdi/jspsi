import { expect, test } from 'vitest'

import log from 'loglevel';

import PSI from '@openmined/psi.js';

import { PSIParticipant } from "../src/participant";
import { linkViaPSI } from "../src/link";

import { PassthroughConnection } from './utils/passthroughConnection';
import { sortAssociationTable } from './utils/associationTable';

const psiLibrary = await PSI();

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
  ['Alice', 'Bob', 'Carol', 'David', 'Elizabeth', 'Frank', 'Greta'],
  ['1',     '2',   '1',     '1',     '1'        , '1',     '1']
];

const clientData = [
  ['Carol', 'Elizabeth', 'Henry'],
  ['3'    , '3'        , '2']
];

log.setLevel('DEBUG');

await (async() => {
  await Promise.all([
    server.exchangeRoles(serverConn, true),
    client.exchangeRoles(clientConn, false),
  ])
})();

let [serverResult, clientResult] = await (async() => {
  return await Promise.all([
    linkViaPSI({cardinality: 'one-to-one'}, server, serverConn, serverData, 0),
    linkViaPSI({cardinality: 'one-to-one'}, client, clientConn, clientData, 0)
  ]);
})();

serverResult = sortAssociationTable(serverResult);
clientResult = sortAssociationTable(clientResult, true);

test('server and client yield identical results', () => {
  expect(serverResult[0]).toStrictEqual(clientResult[1]);
  expect(serverResult[1]).toStrictEqual(clientResult[0]);
});

test('results are correct', () => {
  expect(serverResult[0]).toStrictEqual([1, 2, 4]);
  expect(serverResult[1]).toStrictEqual([2, 0, 1]);
});
