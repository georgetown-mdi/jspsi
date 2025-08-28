import { expect, test } from 'vitest'

import log from 'loglevel';

import { PSIParticipant } from "src/psi/participant";
import { linkViaPSI } from "src/psi/psiLink";

import { PassthroughConnection } from './passthroughConnection';

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
  ['Alice', 'Bob', 'Carol', 'David', 'Elizabeth', 'Frank', 'Greta'],
  ['1',     '1',   '1',     '1',     '1'        , '2',     '1']
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

serverResult = serverResult[0]
  .map((x, i) => ({ x: x, y: serverResult[1][i]}))
  .sort((a, b) => a.x - b.x)
  .reduce((acc, v) => {
      acc[0].push(v.x);
      acc[1].push(v.y);
      return acc
    },
    [[], []] as [Array<number>, Array<number>]
  );

clientResult = clientResult[1]
  .map((x, i) => ({ x: x, y: clientResult[0][i]}))
  .sort((a, b) => a.x - b.x)
  .reduce((acc, v) => {
      acc[1].push(v.x);
      acc[0].push(v.y);
      return acc
    },
    [[], []] as [Array<number>, Array<number>]
  );

test('server and client yield identical results', () => {
  expect(serverResult[0]).toStrictEqual(clientResult[1]);
  expect(serverResult[1]).toStrictEqual(clientResult[0]);
});
