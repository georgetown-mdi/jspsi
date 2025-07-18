
import { createFileRoute } from '@tanstack/react-router';
import CreatePSIForm from '../components/CreatePSIForm';
import JoinPSIForm from '../components/JoinPSIForm';
import { Center, Group, Paper } from '@mantine/core';

export const Route = createFileRoute('/')({
  component: Home
});

function Home() {
  return (
    <Center>
      <Group>
        <Paper shadow="xs" p="xl">
          <CreatePSIForm />
        </Paper>
        <Paper shadow="xs" p="xl">
          <JoinPSIForm />
        </Paper>
      </Group>
    </Center>
  );
}
