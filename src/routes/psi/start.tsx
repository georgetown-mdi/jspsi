
import { createFileRoute } from '@tanstack/react-router';
import { Center, Paper, Title, Text, Stack } from '@mantine/core';

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
    const response = await fetch(`../api/psi/${id}`)
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

  const url = `${window.location.protocol}//${window.location.host}/api/psi/${id}/join`;
  
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
        </Paper>
      </Stack>
    </Center>
  );
}
