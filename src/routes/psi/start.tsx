
import { createFileRoute, useRouter} from '@tanstack/react-router';
import { Center, Paper, Title, Text, Stack, Button } from '@mantine/core';
import { useClipboard } from '@mantine/hooks';

import type { Session } from '../../utils/sessions';

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
  const { id } = Route.useSearch();
  const session = Route.useLoaderData();
  const clipboard = useClipboard();
  const router = useRouter();

  let url: string;
  if (router.isServer) {
    url = `http://localhost:3000/api/psi/${id}/join`;
    // TODO: figure out how to lookup the host from something, anything
    console.log('is server');
  } else {
    url = `${window.location.protocol}//${window.location.host}/api/psi/${id}/join`;
  }
  
  return (
    <Center>
      <Stack>
        <Paper shadow="xs" p="xl">
          <Title order={1}>Session Details</Title>
          <Title order={2}>Initiated By:</Title>
          <Text>{ session['initiatedName'] }</Text>
          <Title order={2}>Agency/Person Invited:</Title>
          <Text>{ session['invitedName'] }</Text>
          <Title order={2}>Description:</Title>
          <Text>{ session['description'] }</Text>
          <Title order={2}>Session ID</Title>
          <Text>{ id }</Text>
        </Paper>
        <Paper shadow="xs" p="xl">
          <Title order={1}>Sharable Link</Title>
          <pre>{url}</pre>
          <Button
            color={clipboard.copied ? 'teal' : 'blue'}
            onClick={() => clipboard.copy(url)}
          >{clipboard.copied ? 'Copied' : 'Copy'}
          </Button>
        </Paper>
      </Stack>
    </Center>
  );
}
