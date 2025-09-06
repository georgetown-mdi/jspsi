import log from 'loglevel';

import { createFileRoute, useSearch} from '@tanstack/react-router';

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

import PSI from '@openmined/psi.js/psi_wasm_web'

import { PSIParticipant, ProcessState, joinerProtocolStages, starterProtocolStages } from 'psi-link'
import { openPeerConnection,  waitForPeerId } from '@psi/server';
import { createAndSharePeerId } from '@psi/client';

import FileSelect from '@components/FileSelect';
import SessionDetails from '@components/SessionDetails';
import { StatusFactory } from '@components/Status';

import type { PSILibrary } from '@openmined/psi.js/implementation/psi.d.ts'

import type { Config as PSIConfig } from 'psi-link';

import type { LinkSession } from '@utils/sessions';


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

const loadFile = (file: File): Promise<Array<string>> =>  {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = (_event) => {
      if (reader.result === null) reject(new Error(file.name + ' is empty'))

      let result = (reader.result! as string).split('\n');
      if (file.type === "text/csv") result = result.slice(1);
      result = result.filter(function(entry) { return entry.trim() != ''; });

      result = result
        .map(function(row) { return row.split(',')[0]; })
        .filter((row) => { return row.trim() != ''; })

      resolve(result);
    }

    reader.onerror = (error) => reject(error);

    reader.readAsText(file);
  })
}

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
      ] as const,
      ...starterProtocolStages
    ] :
    [
      ...[
          {id: 'before start', label: 'Before start', state: ProcessState.BeforeStart},
      ] as const,
      ...joinerProtocolStages
    ];
  

  const Status = StatusFactory(stages);

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
          loadFile(files[0]),
          openPeerConnection(peerId)
        ]).then(async (values) => {
        const [ psi, data, [peer, conn] ] = values;
          conn.once('data', () => peer.disconnect());

          const psiConfig: PSIConfig = {role: 'starter'};
          const participant = new PSIParticipant(
            'server',
            psi,
            psiConfig,
            (id: typeof stageId) => setStageById(id)
          );

          log.info(`${psiConfig.role}: exchanging config`);
          await participant.exchangeRoles(conn, true);
          log.info(`${psiConfig.role}: identifying intersection`);
          const associationTable = await participant.identifyIntersection(conn, data);
          conn.close()

          const result = associationTable[0].map(i => data[i]);
          
          const fileData = new Blob([result.join('\n')], {type: 'text/plain'});
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
        loadFile(files[0]),
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
              (id: typeof stageId) => setStageById(id)
            );
            log.info(`${psiConfig.role}: exchanging config`);
            await participant.exchangeRoles(conn, false);
            log.info(`${psiConfig.role}: identifying intersection`);
            const associationTable = await participant.identifyIntersection(conn, data);
            conn.close();

            const result = associationTable[0].map(i => data[i]);
            
            const fileData = new Blob([result.join('\n')], {type: 'text/plain'});
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
