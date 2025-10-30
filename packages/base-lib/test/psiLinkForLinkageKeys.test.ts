import { Readable } from 'node:stream'

import { expect, test } from 'vitest'
import PSI from '@openmined/psi.js';
import log from 'loglevel';

import { getLinkageKeys } from '../src/linkageKeys'
import { PSIParticipant } from "../src/participant";
import { linkViaPSI } from "../src/link";

import { PassthroughConnection } from './utils/passthroughConnection';
// import { sortAssociationTable } from './utils/associationTable';


import type { KeyAliases, LinkageKeyDefinition } from '../src/types'

const formatters: Record<string, (x: any) => string> = {
  'ssn': (x: string | undefined) => x ? x.replaceAll('-', '') : '',
  'first_name': (x: string | undefined) => x ? x.toUpperCase() : '',
  'last_name': (x: string | undefined) => x ? x.toUpperCase() : '',
  'date_of_birth': (x: Date) =>  isNaN(x.getDate()) ? '' : x.toISOString().substring(0, 10)
};

const keyAliases: KeyAliases = {
  'ssn': ['social_security_number', 'social'],
  'first_name': ['firstname', 'fname'],
  'last_name': ['lastname', 'lname'],
  'date_of_birth': ['dateofbirth', 'dob'],
};

const linkageKeyDefinitions: Array<LinkageKeyDefinition> = [
  [
    {outputFieldName: 'ssn', inputFieldName: 'ssn', formatter: formatters['ssn']},
    {outputFieldName: 'last_name', inputFieldName: 'last_name', formatter: formatters['last_name']},
    {outputFieldName: 'date_of_birth', inputFieldName: 'date_of_birth', formatter: formatters['date_of_birth']}
  ],
  [
    {outputFieldName: 'ssn', inputFieldName: 'ssn', formatter: formatters['ssn']},
    {outputFieldName: 'last_name', inputFieldName: 'last_name', formatter: formatters['last_name']},
    {outputFieldName: 'first_name_1', inputFieldName: 'first_name', formatter: (x: string) => formatters['first_name'](x).substring(0, 1)}
  ],
];

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

log.setLevel('DEBUG');

await (async() => {
  await Promise.all([
    server.exchangeRoles(serverConn, true),
    client.exchangeRoles(clientConn, false),
  ])
})();

test('rules match in order', async () => {
  const serverInputData = [
    ['id,first_name,last_name,ssn,date_of_birth\n'],
    ['159859483,James,Heard,559-81-1301,7/16/1975\n'],
    ['165562801,Albert,Iorio,322-84-2281,8/17/1975']
  ];
  const serverData = await getLinkageKeys(
    Readable.from(serverInputData),
    linkageKeyDefinitions,
    keyAliases
  );

  /* client input 0 matches rule 1, while input 1 matches rule 0 using rule 0
     should consume the potential client input so that it can't be used for the
     first input.
   */
   

  const clientInputData = [
    ['id,first_name,last_name,ssn,date_of_birth\n'],
    ['159859483,Jim,Heard,559-81-1301,7/17/1975\n'], // wrong dob
    ['159859483,Jim,Heard,559-81-1301,7/16/1975\n'],
    ['165562801,Albert,Iorio,322-84-2281,8/17/1976'], // wrong dob
  ];

  const clientData = await getLinkageKeys(
    Readable.from(clientInputData),
    linkageKeyDefinitions,
    keyAliases
  );

  let [serverResult, clientResult] = await (async() => {
    return await Promise.all([
      linkViaPSI({cardinality: 'one-to-one'}, server, serverConn, serverData, 0),
      linkViaPSI({cardinality: 'one-to-one'}, client, clientConn, clientData, 0)
      ]);
    }
  )();
  
  expect(serverResult).toEqual([[0, 1], [1, 2]]);
  expect(clientResult).toEqual([[1, 2], [0, 1]]);
});



