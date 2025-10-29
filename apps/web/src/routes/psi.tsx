import log from 'loglevel';

import { createFileRoute,  useSearch} from '@tanstack/react-router';

import { useState } from 'react';

import {
  ActionIcon,
  Code,
  Container,
  CopyButton,
  Group,
  Paper,
  Stack,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';

import { IconCheck, IconCopy } from '@tabler/icons-react';

import { getHostname as getHttpServerHostname } from '@httpServer';

// @ts-ignore this is really there
import PSI from '@openmined/psi.js/psi_wasm_web'

import {
  PSIParticipant,
  ProcessState,
  getDataForFixedRuleLink,
  linkViaPSI,
  linkageKeys
} from 'base-lib'
import { openPeerConnection,  waitForPeerId } from '@psi/server';
import { createAndSharePeerId } from '@psi/client';

import FileSelect from '@components/FileSelect';
import SessionDetails from '@components/SessionDetails';
import { StatusFactory } from '@components/Status';

import type { PSILibrary } from '@openmined/psi.js/implementation/psi.d.ts'

import type { Config as PSIConfig } from 'base-lib';

import type { LinkSession } from '@utils/sessions';
// import { sortAssociationTable } from 'test/utils/associationTable';


export const Route = createFileRoute('/psi')({
  validateSearch: (search: Record<string, unknown>): { uuid: string, start?: boolean } => {
    // validate and parse the search params into a typed state
    return {
      uuid: (search.uuid as string) || '',
      start: (search.start as boolean) || false
    };
  },
  loaderDeps: ({ search: { uuid } }) => ({ uuid }),
  loader: async ({ deps: { uuid } }) =>  {
    // as a curiosity, this sometimes runs on the server
    // return sessions[id];
    const response = await fetch(`/api/psi/${uuid}`)
    if (!response.ok) {
      throw new Error(`failed to lookup PSI with id ${uuid} with error: ${response.statusText}`);
    }
    return await response.json() as LinkSession;
  },
  component: Home,
});

function Home() {
  const session = Route.useLoaderData();
  const role = useSearch({
    strict: false,
    select: (search) => search.start
  }) ? 'server' : 'client';

  const stages =
    role === 'server' ?
    [
      ...[
        {id: 'before start', label: 'Before start', state: ProcessState.BeforeStart},
        {id: 'waiting for peer', label: 'Waiting for peer', state: ProcessState.Waiting},
        {id: 'confirming protocol', label: 'Confirming protocol', state: ProcessState.Working},
        ...linkageKeys.map(
          (_, i) => { return {
            id: `stage ${i + 1} / ${linkageKeys.length}`,
            label: `Linking key ${i + 1} / ${linkageKeys.length}`,
            state: ProcessState.Working
          }}
        ),
        {id: 'done', label: 'Done', state: ProcessState.Done},
      ],
    ] :
    [
      ...[
          {id: 'before start', label: 'Before start', state: ProcessState.BeforeStart},
          {id: 'confirming protocol', label: 'Confirming protocol', state: ProcessState.Working},
          ...linkageKeys.map(
          (_, i) => { return {
            id: `stage ${i + 1} / ${linkageKeys.length}`,
            label: `Linking key ${i + 1} / ${linkageKeys.length}`,
            state: ProcessState.Working
          }}
        ),
        {id: 'done', label: 'Done', state: ProcessState.Done}
      ],
    ];
  

  const Status = StatusFactory(stages);
  const stagesById = Object.fromEntries(stages.map((value) => [value['id'], value]));

  const [files, setFiles] = useState<Array<File>>([]);
  const [submitted, setSubmitted] = useState(false);
  const [stageId, setStageById] = useState<typeof stages[number]['id']>('before start')
  const [resultURL, setResultURL] = useState<string>();

  const handleSubmit = () => {
    setSubmitted(true);
    
    if (role === 'server') {
      setStageById('waiting for peer');
      waitForPeerId(session.uuid)
      .then((peerId) => {
        Promise.all([
          PSI() as Promise<PSILibrary>,
          getDataForFixedRuleLink(files[0], true),
          openPeerConnection(peerId)
        ]).then(async (values) => {
        const [ psi, data, [peer, conn] ] = values;
          conn.once('data', () => peer.disconnect());

          const psiConfig: PSIConfig = {role: 'starter'};
          const participant = new PSIParticipant(
            'server',
            psi,
            psiConfig,
            (id: any) => {if (stagesById.hasOwnProperty(id)) setStageById(id)}
          );

          log.info(`${psiConfig.role}: exchanging config`);
          await participant.exchangeRoles(conn, true);
          log.info(`${psiConfig.role}: identifying intersection`);
          const associationTable = await linkViaPSI(
            {cardinality: 'one-to-one'},
            participant,
            conn,
            data,
            1,
            (id: any) => {if (stagesById.hasOwnProperty(id)) setStageById(id)}
          );
          conn.close()

          const result = 'our_row_id,their_row_id' +
            associationTable[0].map((ours, i) => `\n${ours},${associationTable[1][i]}`)
            .join('');
          
          const fileData = new Blob([result], {type: 'text/plain'});
          const newResultURL = window.URL.createObjectURL(fileData);

          if (resultURL !== undefined)
            window.URL.revokeObjectURL(resultURL);
          
          setResultURL(newResultURL);
        });
      }).catch((error) => {
        console.error(error);
      });
    } else {
      // role is client
      setStageById('before start');
      Promise.all([
        PSI() as PSILibrary,
        getDataForFixedRuleLink(files[0], false)
      ]).then(async (values) => {
        const [ psi, data ] = values;
        const peer = await createAndSharePeerId(session);

        peer.on('connection', (conn) => {
          conn.on('open', async () => {
            conn.once('data', () => peer.disconnect());

            const psiConfig: PSIConfig = {role: 'joiner'};
            const participant = new PSIParticipant(
              'client',
              psi,
              psiConfig,
              (id: any) => {if (stagesById.hasOwnProperty(id)) setStageById(id)}
            );
            log.info(`${psiConfig.role}: exchanging config`);

            await participant.exchangeRoles(conn, false);
            log.info(`${psiConfig.role}: identifying intersection`);
            const associationTable = await linkViaPSI(
              {cardinality: 'one-to-one'},
              participant,
              conn,
              data,
              1,
              (id: any) => {if (stagesById.hasOwnProperty(id)) setStageById(id)}
            );
            conn.close();

            const result = 'our_row_id,their_row_id' +
              associationTable[0].map((ours, i) => `\n${ours},${associationTable[1][i]}`)
              .join('');
            
            const fileData = new Blob([result], {type: 'text/plain'});
            const newResultURL = window.URL.createObjectURL(fileData);

            if (resultURL !== undefined)
              window.URL.revokeObjectURL(resultURL);
            
            setResultURL(newResultURL);
          });
        });
      })
    }
  };

  let url: URL | undefined;
  if (role === 'server') {
    const searchParams = new URLSearchParams({uuid: session.uuid});
    if (typeof window !== 'undefined') {
      url = new URL(`${window.location.protocol}//${window.location.host}/psi?${searchParams}`);
    } else {
      url = new URL(`${getHttpServerHostname()}/psi?${searchParams}`);
    }
  }
  
  return (
    <Container>
      <Stack>
        <Group justify="space-between" align="stretch" grow>
          <SessionDetails session={session} />
          <Status session={session} stageId={stageId} resultsFileURL={resultURL} />
        </Group>
        { url && (
          <Paper>
            <Title order={2}>Sharable Link</Title>
            <Code block={false} style={{ whiteSpace: 'pre', flex: 1 }}>
              {url.toString()}
            </Code>
            {
              // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
              navigator.clipboard ?
              (
                <CopyButton value={url.toString()} timeout={100}>
                  {({ copied, copy }) => (
                    <Tooltip label="Copy to clipboard">
                      <ActionIcon onClick={copy} variant={copied ? 'light' : 'filled'}>
                        {copied ? <IconCheck size={18} /> : <IconCopy size={18} />}
                      </ActionIcon>
                    </Tooltip>
                  )}
                </CopyButton>
              ) :
              (
                <Text>No cliboard available</Text>
              )
            }
            
          </Paper>
        )}
        <FileSelect handleSubmit={handleSubmit} submitted={submitted} files={files} setFiles={setFiles}/>
      </Stack>
    </Container>
  );
}
