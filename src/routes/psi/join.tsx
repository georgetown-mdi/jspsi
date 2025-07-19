
import { createFileRoute, useRouter} from '@tanstack/react-router';
import { Center, Paper, Title, Text, Stack, Button } from '@mantine/core';

import type { Session } from '../../utils/sessions';
import { SessionDetails  } from '../../components/SessionDetails';

export const Route = createFileRoute('/psi/join')({
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

  return (
    <Center>
      <Stack>
        <SessionDetails session={session}/>
      </Stack>
    </Center>
  );
}
