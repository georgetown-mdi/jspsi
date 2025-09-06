import fs from 'node:fs';
import logLibrary from 'loglevel';

import PSI from '@openmined/psi.js'

import { PSIParticipant } from "psi-link"
import { SFTPConnection } from "../src/psi/connection/sftpConnection";


logLibrary.setDefaultLevel(logLibrary.levels.DEBUG);

const conn = new SFTPConnection({verbose: 2});

const args = process.argv.slice(2);

if (args.length < 2) {
  console.error("usage: node --import=tsx psi.ts CONNECTION_URL CSV_FILE")
  process.exit(64);
}

const data =
  fs.readFileSync(args[1])
  .toString()
  .split("\n")
  .slice(1)
  .filter(row => row.trim())
  .map(row => row.split(',')[0])
  .filter(row => row.trim())

console.log('opening connection')
await conn.open(args[0]);

console.log('synchronizing')
await conn.synchronize();

console.log('synchronized to firstToParty', conn.firstToParty);

console.log('starting polling')
conn.start();

const participant = new PSIParticipant(
  conn.firstToParty ? 'server' : 'client',
  await PSI(),
  { role: conn.firstToParty ? 'starter' : 'joiner', verbose: 2 }
)

console.log('exchanging roles')
await participant.exchangeRoles(conn, conn.firstToParty!);

console.log('identifying intersection')
const associationTable = await participant.identifyIntersection(conn, data);

console.log('stopping polling')
conn.stop();

console.log('closing connection')
conn.close();

console.log(associationTable);
