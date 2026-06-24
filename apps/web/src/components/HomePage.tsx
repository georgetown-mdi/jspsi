import { useState } from "react";

import { Box, Grid, Paper, Stack, Text, Title } from "@mantine/core";

import AcceptForm from "@components/AcceptForm";
import { DefaultExchangeColumns } from "@components/DefaultExchangeColumns";
import { EXCHANGE_READING_WIDTH } from "@components/contentWidth";
import FileDropzone from "@components/FileDropzone";
import { InvitePanel } from "@components/InvitePanel";

import type { InviterSession } from "@components/InvitePanel";

/**
 * The home route's page: a single `<h1>` framing the two ways to start an
 * exchange -- invite a partner, or accept an invitation you were sent -- above
 * the panels. Kept as a component (rather than inline in the route file) so it
 * can be mounted in a render test, mirroring {@link AcceptInvitation}.
 *
 * The page owns BOTH the inviter session and the shared data-file selection. The
 * file drop sits once, below both compose panels, and feeds whichever path the
 * user takes: {@link InvitePanel} gates "Generate invitation" on a file (and shows
 * what it will send), while {@link AcceptForm}'s "Review invitation" does not
 * require one but carries it to the consent screen if present. Lifting the
 * selection here is what lets a single drop serve both panels; lifting the session
 * here is what lets the page change the whole layout once an invitation is
 * generated.
 *
 * While no session exists the two compose panels sit side by side, equal-width and
 * top-aligned so each sizes to its own content (the invite flow is the taller of
 * the two), with the shared drop below; on a narrow viewport they stack (the
 * `base: 12` span). Once {@link InvitePanel} generates an invitation it stores the
 * session here, and the page drops the grid, the accept form, and the shared drop
 * to render the panel -- now showing the {@link ExchangeView} -- across the full
 * route width, so the exchange screen takes over the view the way the accept route
 * does (in its own two columns: the agreed terms beside the run's Status) rather
 * than sitting in one half of the grid.
 *
 * The page `<h1>` frames the compose panels only: while composing it spans the full
 * route width above the grid and shared drop; once a session exists the takeover
 * drops it along with the grid, accept form, and drop, so the panel (whose own
 * `<h2>` leads the exchange screen, matching the accept route's in-Paper heading)
 * stands alone.
 *
 * The content width (wide) is declared by the route and supplied by the shell's
 * container, so this page renders only its content -- no `Container` of its own.
 */
export function HomePage() {
  const [session, setSession] = useState<InviterSession>();
  // The shared data-file selection, fed to both compose panels by the single drop
  // below them. Held here, not in either panel, so one drop serves both paths.
  const [files, setFiles] = useState<Array<File>>([]);

  return (
    <Box>
      {/* The page heading frames the two compose panels; once an invitation is
          generated the exchange takes over the view and the heading is dropped
          (the panel's own h2 leads from there), so it renders only while
          composing. */}
      {session === undefined && (
        <Title order={1}>Start a private data exchange</Title>
      )}
      {session === undefined ? (
        <Stack mt="md">
          <Grid align="flex-start">
            <Grid.Col span={{ base: 12, md: 6 }}>
              <InvitePanel
                session={session}
                setSession={setSession}
                files={files}
              />
            </Grid.Col>
            <Grid.Col span={{ base: 12, md: 6 }}>
              <AcceptForm files={files} />
            </Grid.Col>
          </Grid>
          {/* One shared drop below both panels. Required to send an invitation
              (it gates Generate above) and optional when accepting one, where it
              simply rides along to the consent screen. Read in the browser only --
              never uploaded -- in either case.

              Unlike the two panels (which split the route width via the grid), the
              drop is a single full-bleed element, so it self-caps to the same
              reading measure the exchange column uses (EXCHANGE_READING_WIDTH,
              centered) rather than stretching a lone dropzone across a wide route:
              it fills the width on a narrow window and stops growing -- leaving a
              gap at the edges -- once past the cap. */}
          <Paper
            style={{ width: EXCHANGE_READING_WIDTH, marginInline: "auto" }}
          >
            <Title order={2}>Your data file</Title>
            <Stack mt="md">
              <Text size="sm" c="dimmed">
                Choose the CSV for this exchange. You can review an invitation
                without specifying a file using the form above. Your file is
                processed entirely in your browser and it is never uploaded to
                our server.
              </Text>
              <FileDropzone files={files} setFiles={setFiles} />
              {/* The file's default exchange columns surface here, under the file
                  they come from -- shared by both paths -- rather than inside the
                  invite panel, so they do not pop up when the operator only means to
                  accept. The invite panel's "Advanced options" changes them. */}
              <DefaultExchangeColumns files={files} />
            </Stack>
          </Paper>
        </Stack>
      ) : (
        // Takeover: the same panel, now rendering the exchange screen, with the
        // page heading, the accept form, and the shared drop dropped. It fills the
        // route width (no reading-column cap) so the exchange screen can lay out its
        // two columns; `mt="md"` keeps the same top gap the grid had, so the panel
        // does not jump up against the shell's top edge across the transition.
        <Box mt="md">
          <InvitePanel
            session={session}
            setSession={setSession}
            files={files}
          />
        </Box>
      )}
    </Box>
  );
}
