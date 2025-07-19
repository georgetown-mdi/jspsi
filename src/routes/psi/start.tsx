
import { createFileRoute, useRouter} from '@tanstack/react-router';
import { Center, Paper, Title, Stack, Button } from '@mantine/core';
import { useClipboard } from '@mantine/hooks';

import type { Session } from '../../utils/sessions';
import { SessionDetails } from '../../components/SessionDetails';

export const Route = createFileRoute('/psi/start')({
  validateSearch: (search: Record<string, unknown>): { id: string } => {
    // validate and parse the search params into a typed state
    return {
      id: (search.id as string) || '',
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

  let url: URL;
  const searchParams = new URLSearchParams({id: session['id']});
  if (router.isServer) {
    url = new URL(`http://localhost:3000/psi/join?${searchParams}`);
    // TODO: figure out how to lookup the host from something, anything
    console.log('is server');
  } else {
    url = new URL(`${window.location.protocol}//${window.location.host}/psi/join?${searchParams}`);
  }
  
  return (
    <Center>
      <Stack>
        <SessionDetails session={session}/>
        <Paper shadow="xs" p="xl">
          <Title order={1}>Sharable Link</Title>
          <pre>{url.toString()}</pre>
          <Button
            color={clipboard.copied ? 'teal' : 'blue'}
            onClick={() => clipboard.copy(url.toString())}
          >{clipboard.copied ? 'Copied' : 'Copy'}
          </Button>
        </Paper>
      </Stack>
    </Center>
  );
}
