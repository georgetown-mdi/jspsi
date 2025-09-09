import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { configSchema, schemaToYargs } from './config';

import fs from 'node:fs';
import logLibrary from 'loglevel';

import PSI from '@openmined/psi.js'

import { PSIParticipant, SFTPConnection } from "base-lib"

import { SSH2SFTPClientAdapter } from "./connection/ssh2SftpAdapter";

import type {PositionalOptions} from 'yargs';


async function run() {
  const { positionals, options, groups } = schemaToYargs(configSchema);

  const positionalsForUsage = positionals.map((p) => { return !p.meta.demandOption ? '[' + p.key + ']' : p.key }).join(' ');

  const cli = yargs()
    .scriptName('psi-link')
    .command('invite', 'Generate an invitation and wait to execute exchange')
    .command('join', 'View details and choose to execute exchange')
    .command(
      [`exchange`, '$0'],
      'Link data using private set intersection',
      (cmd) => {
        let numRequiredPositionals = 0;
        for (const { key, meta } of positionals) {
          cmd = cmd.positional(key, meta);
          if (meta.demandOption) numRequiredPositionals++;
        }
        for (const { key, meta } of options) {
          cmd = cmd.option(key, meta);
        }
        for (const [key, groupName] of groups) {
          cmd = cmd.group(key, groupName);
        }
        return cmd.demand(numRequiredPositionals);
      }
    )
    .usage(`$0 <command> [options] ${positionalsForUsage}`)
    .help('h')
    .alias('h', 'help')
    .alias('v', 'version')
    .alias('p', 'passkey')
    .alias('t', 'timeout');

  const argv = cli.parseSync(hideBin(process.argv));
  // @ts-ignore it does exists
  const newAliases = cli.parsed.newAliases as { [key: string]: boolean };
  Object.entries(newAliases).forEach(([key, value]) => {
    delete argv[key];
  });
  ['h', 'v', 'p', 't'].forEach(key => {
    delete argv[key];
  })

  const positionalArgs = Object.fromEntries(argv._.map((x, i) => { return [positionals[i].key, x] }));
  const optionPathMap = Object.fromEntries(options.map(x => [x.key, x.meta.optionPath]));
  const otherArgs = Object.fromEntries(Object
    .entries(argv)
    .filter(([key]) => key !== '_' && key !== '$0')
    .map(([key, value]) => {
      return [ optionPathMap[key] || key, value  ]
    }));

  const allArgs = { ...positionalArgs, ...otherArgs };

  const cliOptions = configSchema.safeParse(allArgs);

  if (!cliOptions.success) {
    console.error('unable to parse input:', cliOptions.error);
    cli.showHelp();
    process.exit(64);
  }

  logLibrary.setDefaultLevel(logLibrary.levels.DEBUG);


  const data =
    fs.readFileSync(cliOptions.data.input)
    .toString()
    .split("\n")
    .slice(1)
    .filter(row => row.trim())
    .map(row => row.split(',')[0])
    .filter(row => row.trim())

  const conn = new SFTPConnection(new SSH2SFTPClientAdapter(), { verbose: 2 });
  conn.on('error', (err: any) => {
    console.error('sftp error:', err);
    process.exit(69);
  })

  console.log('opening connection to', cliOptions.data.server, 'with options', cliOptions.data.serverOptions)
  await conn.open(cliOptions.data.server, cliOptions.data.serverOptions);

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
}

run();
