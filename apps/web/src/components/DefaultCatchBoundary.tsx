import { Button, Group, Stack } from "@mantine/core";

import { sanitizeErrorForDisplay } from "@psilink/core";

import {
  ErrorComponent,
  Link,
  rootRouteId,
  useMatch,
  useRouter,
} from "@tanstack/react-router";

import { AppPage } from "@components/AppPage";
import { whenDiagnostic } from "@utils/diagnostics";

import { useOnlineStatus } from "./useOnlineStatus";

import type { ErrorComponentProps } from "@tanstack/react-router";

export function DefaultCatchBoundary({ error }: ErrorComponentProps) {
  const router = useRouter();
  const online = useOnlineStatus();
  const isRoot = useMatch({
    strict: false,
    select: (state) => state.id === rootRouteId,
  });

  // Dev-gated: the raw Error's message, cause chain, and `.stack` can hold
  // partner- or server-controlled bytes, so a production browser console logs
  // none of it, while a developer (or a deployed client with the diagnostics
  // toggle on) gets the whole object for debugging. The on-screen render below
  // is sanitized separately.
  whenDiagnostic(() => console.error("DefaultCatchBoundary Error:", error));

  // Rendered outside any route layout, so it supplies its own <main> landmark
  // and padding.
  return (
    <AppPage>
      <Stack component="main" gap="sm" p="xl">
        {/* The sanitized error alone ("Failed to fetch") does not say the browser
            is offline, the likeliest cause here, so name that state and its
            recovery. */}
        {!online && (
          <p>
            This device is offline. A part of psilink this browser has not
            stored yet cannot be opened without a connection -- reconnect and
            open it once, and it will open offline after that.
          </p>
        )}
        {/* ErrorComponent renders only `error.message` (auto-shown in dev, behind
            a toggle in production), never `.stack`. Pass it a sanitized message
            rather than the raw Error so the at-the-sink escaping and the
            key-redaction safety check apply before anything reaches the DOM. */}
        <ErrorComponent error={new Error(sanitizeErrorForDisplay(error))} />
        <Group gap="sm">
          <Button
            onClick={() => {
              router.invalidate();
            }}
          >
            Try again
          </Button>
          {isRoot ? (
            <Button component={Link} to="/" variant="default">
              Home
            </Button>
          ) : (
            <Button variant="default" onClick={() => window.history.back()}>
              Go back
            </Button>
          )}
        </Group>
      </Stack>
    </AppPage>
  );
}
