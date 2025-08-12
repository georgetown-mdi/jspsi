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

import { PSIAsClient, stages as clientStages, createAndSharePeerId } from '@utils/psi_client';
import { PSIAsServer, openPeerConnection, stages as serverStages, waitForPeerId } from '@utils/psi_server';
import { PeerConnectionProtocol } from '@utils/PeerConnectionProtocol';
import { loadPSILibrary } from '@utils/psi'

import FileSelect from '@components/FileSelect';
import SessionDetails from '@components/SessionDetails';
import { StatusFactory } from '@components/Status';

import type { ProtocolStage } from '@components/Status';
import type { Session } from '@utils/sessions';

export const Route = createFileRoute('/psi')({
  validateSearch: (search: Record<string, unknown>): { id: string, start?: boolean } => {
    // validate and parse the search params into a typed state
    return {
      id: (search.id as string) || '',
      start: (search.start as boolean) || false
    };
  },
  loaderDeps: ({ search: { id } }) => ({ id }),
  loader: async ({ deps: { id } }) =>  {
    // as a curiosity, this sometimes runs on the server
    // return sessions[id];
    const response = await fetch(`/api/psi/${id}`)
    if (!response.ok) {
      throw new Error(`failed to lookup PSI with id ${id} with error: ${response.statusText}`);
    }
    return await response.json() as Session;
  },
  component: Home,
  head: () => {
    return {
      scripts: [ { src: '/js/peerjs.min.js'} , { src: '/js/psi_wasm_web.js' } ]
    }
  }
});

const loadFile = (file: File): Promise<Array<string>> =>  {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = (_event) => {
      if (reader.result === null) reject(new Error(file.name + ' is empty'))

      let result = (reader.result! as string).split('\n');
      if (file.type === "text/csv") result = result.slice(1);
      result = result.filter(function(entry) { return entry.trim() != ''; });
      
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

  const stages: Array<ProtocolStage> = role === 'server' ? serverStages : clientStages;
  const Status = StatusFactory(stages);

  const [files, setFiles] = useState<Array<File>>([]);
  const [submitted, setSubmitted] = useState(false);
  const [stage, setStage] = useState(stages[0][0]);
  const [resultURL, setResultURL] = useState<string>();

  const handleSubmit = () => {
    setSubmitted(true);
    
    if (role === 'server') {
      // wait for peer no matter what
      setStage(stages[1][0]);
      waitForPeerId(session).then((peerId) => {
        Promise.all([
          loadPSILibrary(),
          loadFile(files[0]),
          openPeerConnection(peerId)
        ]).then(async (values) => {
          const [ psi, data, [peer, conn] ] = values;
          
          const server = new PSIAsServer(psi, data, setStage);
          const protocolHandler = new PeerConnectionProtocol(
            peer,
            conn,
            server.startupHandler,
            server.messageHandlers,
            server.closeHandler
          )
          await protocolHandler.runProtocol();
          
          const fileData = new Blob([server.result.join('\n')], {type: 'text/plain'});
          const newResultURL = window.URL.createObjectURL(fileData);

          if (resultURL !== undefined)
            window.URL.revokeObjectURL(resultURL);
          
          setResultURL(newResultURL);
        });
      })
    } else {
      setStage(stages[1][0]);
      Promise.all([
        loadPSILibrary(),
        loadFile(files[0]),
      ]).then(async (values) => {
        const [ psi, data ] = values;
        const peer = await createAndSharePeerId(session);

        peer.on('connection', async (conn) => {
          const client = new PSIAsClient(psi, data, setStage);
          const protocolHandler = new PeerConnectionProtocol(
            peer,
            conn,
            undefined,
            client.messageHandlers,
            client.closeHandler
          )

          await protocolHandler.runProtocol();

          const fileData = new Blob([client.result.join('\n')], {type: 'text/plain'});
          const newResultURL = window.URL.createObjectURL(fileData);

          if (resultURL !== undefined)
            window.URL.revokeObjectURL(resultURL);
          
          setResultURL(newResultURL);
        });
      })
    }
  };

  let url: URL | undefined;
  if (role === 'server') {
    const searchParams = new URLSearchParams({id: session['id']});
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
          <Status session={session} stageName={stage} resultsFileURL={resultURL} />
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
