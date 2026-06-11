import { Container, Group } from "@mantine/core";
import { createFileRoute } from "@tanstack/react-router";

import AcceptForm from "@components/AcceptForm";
import { InvitePanel } from "@components/InvitePanel";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return (
    <Container>
      <Group justify="space-between" align="flex-start" grow mt="md">
        <InvitePanel />
        <AcceptForm />
      </Group>
    </Container>
  );
}
