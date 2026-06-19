import { Container, Group, Title } from "@mantine/core";

import AcceptForm from "@components/AcceptForm";
import { InvitePanel } from "@components/InvitePanel";

/**
 * The home route's page: a single `<h1>` framing the two ways to start an
 * exchange -- invite a partner, or accept an invitation you were sent -- above
 * the two side-by-side panels. Kept as a component (rather than inline in the
 * route file) so it can be mounted in a render test, mirroring
 * {@link AcceptInvitation}.
 */
export function HomePage() {
  return (
    <Container size="xl">
      <Title order={1}>Start a private data exchange</Title>
      <Group justify="space-between" align="flex-start" grow mt="md">
        <InvitePanel />
        <AcceptForm />
      </Group>
    </Container>
  );
}
