import { Grid, Title } from "@mantine/core";

import AcceptForm from "@components/AcceptForm";
import { InvitePanel } from "@components/InvitePanel";

/**
 * The home route's page: a single `<h1>` framing the two ways to start an
 * exchange -- invite a partner, or accept an invitation you were sent -- above
 * the two panels. Kept as a component (rather than inline in the route file) so
 * it can be mounted in a render test, mirroring {@link AcceptInvitation}.
 *
 * The two panels are weighted rather than equal-width: the invite panel is the
 * primary, file-bearing flow (~2/3), the accept form a compact paste box (~1/3),
 * top-aligned so each sizes to its own content rather than being stretched to the
 * taller one. On a narrow viewport the columns stack (the `base: 12` span).
 *
 * The content width (wide) is declared by the route and supplied by the shell's
 * container, so this page renders only its content -- no `Container` of its own.
 */
export function HomePage() {
  return (
    <>
      <Title order={1}>Start a private data exchange</Title>
      <Grid mt="md" align="flex-start">
        <Grid.Col span={{ base: 12, md: 8 }}>
          <InvitePanel />
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 4 }}>
          <AcceptForm />
        </Grid.Col>
      </Grid>
    </>
  );
}
