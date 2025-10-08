import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { configSchema, flattenObject, schemaToYargs, unflattenObject } from './config';

import fs from 'node:fs';
import logLibrary from 'loglevel';
import YAML from 'yaml';

import PSI from '@openmined/psi.js'

import { PSIParticipant, SFTPConnection, getDataForFixedRuleLink, linkViaPSI } from "base-lib"

import { SSH2SFTPClientAdapter } from "./connection/ssh2SftpAdapter";


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
        cmd = cmd.option('config', {type: 'string', describe: 'optional yaml config file'});

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
  Object.entries(newAliases).forEach(([key, _value]) => {
    delete argv[key];
  });
  ['h', 'v', 'p', 't'].forEach(key => {
    delete argv[key];
  });

  const positionalArgs = Object.fromEntries(argv._.map((x, i) => { return [positionals[i].key, x] }));
  const optionPathMap = Object.fromEntries(options.map(x => [x.key, x.meta.optionPath]));
  const otherArgs = Object.fromEntries(Object
    .entries(argv)
    .filter(([key]) => key !== '_' && key !== '$0')
    .map(([key, value]) => {
      return [ optionPathMap[key] || key, value  ]
    }));

  let allArgs = { ...positionalArgs, ...otherArgs };

  const configFile = allArgs['config'];
  delete allArgs['config'];

  if (configFile && typeof configFile === 'string') {
    const configOptions = Object.fromEntries(Object.entries(
      flattenObject(YAML.parse(fs.readFileSync(configFile, 'utf8')), "", '-')
    ).map(([key, value]) => {
      return [ optionPathMap[key] || key, value  ]
    }));
    allArgs = {...allArgs, ...configOptions};
  }

  let cliOptions = configSchema.safeParse(unflattenObject(allArgs));
  if (!cliOptions.success) {
    console.error('unable to parse input:', cliOptions.error);
    cli.showHelp();
    process.exit(64);
  }

  logLibrary.setDefaultLevel(logLibrary.levels.DEBUG);

  const conn = new SFTPConnection(new SSH2SFTPClientAdapter(), { verbose: 0 });
  conn.on('error', (err: any) => {
    console.error('sftp error:', err);
    process.exit(69);
  });
  process.on('SIGINT', async function() {
    console.log('caught SIGINT, exiting');
    if (conn.connected) {
      await conn.cleanup();
      await conn.close();
    }
    
    process.exit(0);
  });

  console.log('opening connection to', cliOptions.data.server, 'with options', cliOptions.data.serverOptions)
  await conn.open(cliOptions.data.server, cliOptions.data.serverOptions);

  console.log('synchronizing')
  await conn.synchronize();

  console.log('synchronized to firstToParty', conn.firstToParty);

  const data = await getDataForFixedRuleLink(
    fs.createReadStream(cliOptions.data.input),
    conn.firstToParty!
  )

  console.log('starting polling')
  conn.start();

  const participant = new PSIParticipant(
    conn.firstToParty ? 'server' : 'client',
    await PSI(),
    { role: conn.firstToParty ? 'starter' : 'joiner', verbose: 1 }
  )

  console.log('exchanging roles')
  await participant.exchangeRoles(conn, conn.firstToParty!);

  console.log('identifying intersection')
  const associationTable = await linkViaPSI(
    {cardinality: 'one-to-one'},
    participant,
    conn,
    data
  )
  // const associationTable = await participant.identifyIntersection(conn, data);

  console.log('stopping polling')
  conn.stop();

  console.log('closing connection')
  conn.close();

  const out = cliOptions.data.output
    ? fs.createWriteStream(cliOptions.data.output, {encoding: 'utf8'})
    : process.stdout;

  out.write('our_row_id,their_row_id');
  associationTable[0].forEach((ours, i) => {
    out.write(`\n${ours},${associationTable[1][i]}`);
  });
  // @ts-expect-error
  if (cliOptions.data.output) out.close();
}

run();
