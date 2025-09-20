
import { Center, Group, Paper } from '@mantine/core';
import { createFileRoute } from '@tanstack/react-router';

import CreatePSIForm from '@components/CreatePSIForm';
import JoinPSIForm from '@components/JoinPSIForm';

export const Route = createFileRoute('/')({
  component: Home
});

function Home() {
  return (
    <Center>
      <Group justify="space-between" align="stretch" grow>
        <Paper>
          <CreatePSIForm />
        </Paper>
        <Paper>
          <JoinPSIForm />
        </Paper>
      </Group>
    </Center>
  );
}
