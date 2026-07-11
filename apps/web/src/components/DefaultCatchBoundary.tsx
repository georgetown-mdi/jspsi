import { Button, Group, Stack } from "@mantine/core";

import { sanitizeErrorForDisplay } from "@psilink/core";

import {
  ErrorComponent,
  Link,
  rootRouteId,
  useMatch,
  useRouter,
} from "@tanstack/react-router";

import { BenchPage } from "@bench/BenchPage";
import { whenDiagnostic } from "@utils/diagnostics";

import type { ErrorComponentProps } from "@tanstack/react-router";

export function DefaultCatchBoundary({ error }: ErrorComponentProps) {
  const router = useRouter();
  const isRoot = useMatch({
    strict: false,
    select: (state) => state.id === rootRouteId,
  });

  // Dev-gated: the raw Error's message, cause chain, and `.stack` can embed
  // partner-/server-controlled bytes, so a production console carries none of
  // it, while a developer (or a deployed client with the diagnostics toggle on)
  // keeps the full object -- expandable stack and `.cause` chain -- for
  // debugging. The on-screen render below is separately sanitized.
  whenDiagnostic(() => console.error("DefaultCatchBoundary Error:", error));

  // A root-level error surface: with the legacy Shell gone, it renders itself on
  // the bench page ground and supplies its own <main> landmark and padding so it
  // reads acceptably in the bench world.
  return (
    <BenchPage>
      <Stack component="main" gap="sm" p="xl">
        {/* ErrorComponent renders only `error.message` (auto-shown in dev, behind
            a toggle in production), never `.stack`. Hand it a sanitized message
            rather than the raw Error so the at-the-sink escaping and the
            key-redaction backstop apply before anything reaches the DOM. */}
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
    </BenchPage>
  );
}
