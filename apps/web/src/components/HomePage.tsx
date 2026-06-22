import { useState } from "react";

import { Box, Grid, Title } from "@mantine/core";

import AcceptForm from "@components/AcceptForm";
import { EXCHANGE_READING_WIDTH } from "@components/contentWidth";
import { InvitePanel } from "@components/InvitePanel";

import type { InviterSession } from "@components/InvitePanel";

/**
 * The home route's page: a single `<h1>` framing the two ways to start an
 * exchange -- invite a partner, or accept an invitation you were sent -- above
 * the panels. Kept as a component (rather than inline in the route file) so it
 * can be mounted in a render test, mirroring {@link AcceptInvitation}.
 *
 * The inviter session is held here rather than inside {@link InvitePanel} so this
 * page can change the whole layout once an invitation is generated. While none
 * exists the two compose panels sit side by side, equal-width and top-aligned so
 * each sizes to its own content (the invite flow is the taller of the two); on a
 * narrow viewport they stack (the `base: 12` span). Once {@link InvitePanel}
 * generates an invitation it stores the session here, and the page drops the grid
 * and the accept form to render the panel -- now showing the {@link ExchangeView}
 * -- as a single centered reading column (see {@link EXCHANGE_READING_WIDTH}), so
 * the exchange screen takes over the view the way the accept route does rather than
 * sitting in one half of the grid.
 *
 * The constraint wraps the heading too, so once it engages the `<h1>` shares the
 * panel's edge (matching the accept route's in-Paper h1) instead of spanning full
 * width above a narrower panel; while composing it is absent and the heading and
 * grid keep the full route width.
 *
 * The content width (wide) is declared by the route and supplied by the shell's
 * container, so this page renders only its content -- no `Container` of its own.
 */
export function HomePage() {
  const [session, setSession] = useState<InviterSession>();

  return (
    <Box
      style={
        session === undefined
          ? undefined
          : { width: EXCHANGE_READING_WIDTH, marginInline: "auto" }
      }
    >
      <Title order={1}>Start a private data exchange</Title>
      {session === undefined ? (
        <Grid mt="md" align="flex-start">
          <Grid.Col span={{ base: 12, md: 6 }}>
            <InvitePanel session={session} setSession={setSession} />
          </Grid.Col>
          <Grid.Col span={{ base: 12, md: 6 }}>
            <AcceptForm />
          </Grid.Col>
        </Grid>
      ) : (
        // Takeover: the same panel, now rendering the exchange screen, with the
        // accept form dropped. The wrapping Box (above) centers it and the heading
        // in the reading column; `mt="md"` matches the grid's top gap so the spacing
        // under the h1 is unchanged across the transition.
        <Box mt="md">
          <InvitePanel session={session} setSession={setSession} />
        </Box>
      )}
    </Box>
  );
}
