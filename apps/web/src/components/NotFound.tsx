import { Link } from "@tanstack/react-router";

import { Button, Group, Stack, Text } from "@mantine/core";

import { BenchPage } from "@bench/BenchPage";

import type { ReactNode } from "react";

export function NotFound({ children }: { children?: ReactNode }) {
  // A root-level error surface: with the legacy Shell gone, it renders itself on
  // the bench page ground and supplies its own <main> landmark and padding so it
  // reads acceptably in the bench world.
  return (
    <BenchPage>
      <Stack component="main" gap="sm" p="xl">
        {children ?? (
          <Text c="dimmed">The page you are looking for does not exist.</Text>
        )}
        <Group gap="sm">
          <Button variant="default" onClick={() => window.history.back()}>
            Go back
          </Button>
          <Button component={Link} to="/">
            Start over
          </Button>
        </Group>
      </Stack>
    </BenchPage>
  );
}
