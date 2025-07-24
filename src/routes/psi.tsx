
import { createFileRoute, useRouter, useSearch} from '@tanstack/react-router';

import { useState } from 'react';

import { ActionIcon, Code, Container, Group, Paper, Stack, Title, Tooltip } from '@mantine/core';
import { useClipboard } from '@mantine/hooks';

import { IconCopy } from '@tabler/icons-react';

import type { Session } from '../utils/sessions';

import SessionDetails from '../components/SessionDetails';
import FileSelect from '../components/FileSelect';
import { StatusFactory, ProtocolStage } from '../components/Status';

import { loadPSILibrary } from '../utils/psi'
import { waitForPeerId, openPeerConnection, PSIAsServer, stages as serverStages } from '../utils/psi_server';
import { createAndSharePeerId, PSIAsClient, stages as clientStages } from '../utils/psi_client';
import { PeerConnectionProtocol } from '../utils/PeerConnectionProtocol';

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
    console.log(`looking up session ${id}`)
    const response = await fetch(`/api/psi/${id}`)
    if (!response.ok) {
      throw new Error(`failed to lookup PSI with id ${id} with error: ${response.statusText}`);
    }
    return await response.json() as Session;
  },
  component: Home,
  head: (ctx) => {
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
      
      console.log("loaded server data: " + result.slice(0, Math.min(result.length, 5)));

      resolve(result);
    }

    reader.onerror = (error) => reject(error);

    reader.readAsText(file);
  })
}

function Home() {
  const session = Route.useLoaderData();
  const clipboard = useClipboard();
  const router = useRouter();
  const role = useSearch({
    strict: false,
    select: (search) => search.start
  }) ? 'server' : 'client';

  const stages: ProtocolStage[] = (role === 'server' ? serverStages : clientStages) as ProtocolStage[];
  const Status = StatusFactory(stages);

  const [files, setFiles] = useState<File[]>([]);
  const [submitted, setSubmitted] = useState(false);
  const [stage, setStage] = useState(stages[0][0]);
  const [resultURL, setResultURL] = useState<string>();

  const handleSubmit = async () => {
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
          
          const server = new PSIAsServer(psi, data, (stage) => { console.log("setting to stage: " + stage); setStage(stage); });
          const protocolHandler = new PeerConnectionProtocol(
            peer,
            conn,
            server.startupHandler,
            server.messageHandlers,
            server.closeHandler
          )
          await protocolHandler.runProtocol();
          
          const fileData = new Blob(server.result, {type: 'text/plain'});
          const newResultURL = window.URL.createObjectURL(fileData);

          if (resultURL !== undefined)
            window.URL.revokeObjectURL(resultURL);
          
          console.log('setting result url to ' + newResultURL);
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
          const client = new PSIAsClient(psi, data, (stage) => { console.log("setting to stage: " + stage); setStage(stage); });
          const protocolHandler = new PeerConnectionProtocol(
            peer,
            conn,
            undefined,
            client.messageHandlers,
            client.closeHandler
          )

          await protocolHandler.runProtocol();

          const fileData = new Blob(client.result, {type: 'text/plain'});
          const newResultURL = window.URL.createObjectURL(fileData);

          if (resultURL !== undefined)
            window.URL.revokeObjectURL(resultURL);
          
          console.log('setting result url to ' + newResultURL);
          setResultURL(newResultURL);
        });
      })
    }
  };

  let url: URL;
  if (role === 'server') {
    const searchParams = new URLSearchParams({id: session['id']});
    if (router.isServer) {
      url = new URL(`http://localhost:3000/psi?${searchParams}`);
      // TODO: figure out how to lookup the host from something, anything
      console.log('is server');
    } else {
      url = new URL(`${window.location.protocol}//${window.location.host}/psi?${searchParams}`);
    }
  }
  
  return (
    <Container>
      <Stack>
        <Group justify="space-between" align="stretch" grow>
          <SessionDetails session={session} />
          <Status session={session} stageName={stage} resultsFileURL={resultURL} />
        </Group>
        { role === 'server' && (
          <Paper>
            <Title order={2}>Sharable Link</Title>
            <Code block={false} style={{ whiteSpace: 'pre', flex: 1 }}>
              {url!.toString()}
            </Code>
            <Tooltip label="Copy to clipboard">
              <ActionIcon onClick={() => clipboard.copy(url.toString())} variant="light" color="blue">
                <IconCopy size={18} />
              </ActionIcon>
            </Tooltip>
          </Paper>
        )}
        <FileSelect handleSubmit={handleSubmit} submitted={submitted} files={files} setFiles={setFiles}/>
      </Stack>
    </Container>
  );
}
