
import { createFileRoute, useRouter, useSearch} from '@tanstack/react-router';

import { ActionIcon, Button, Container, Group, Paper, Stack, Title, Tooltip } from '@mantine/core';
import { useClipboard } from '@mantine/hooks';

import { IconCopy } from '@tabler/icons-react';

import type { Session } from '../utils/sessions';

import SessionDetails from '../components/SessionDetails';
import FileSelect from '../components/FileSelect';
import StatusIndicator from '../components/StatusIndicator';

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
    const response = await fetch(`/api/psi/${id}`)
      if (!response.ok) {
        throw new Error(`failed to lookup PSI with id ${id} with error: ${response.statusText}`);
      }
      return await response.json() as Session;
  },
  component: Home
});

function Home() {
  const session = Route.useLoaderData();
  const clipboard = useClipboard();
  const router = useRouter();
  const role = useSearch({
    strict: false,
    select: (search) => search.start
  }) ? 'start' : 'join';

  let url: URL;
  if (role === 'start') {
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
        <Group justify="space-between" grow>
          <SessionDetails session={session} />
          <StatusIndicator session={session} grow />
        </Group>
        { 
          role === 'start' ? (
            <Paper>
              <Title order={1}>Sharable Link</Title>
              <pre>{url!.toString()}</pre>
              <Tooltip label="Copy to clipboard">
                <ActionIcon onClick={() => clipboard.copy(url.toString())} variant="light" color="blue">
                  <IconCopy size={18} />
                </ActionIcon>
              </Tooltip>
            </Paper>
          )
          : (
            <></>
          )
        }
        <FileSelect />
      </Stack>
    </Container>
  );
}
