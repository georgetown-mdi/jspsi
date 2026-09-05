import { Link } from "@tanstack/react-router";

import { Button, Group, Stack, Text } from "@mantine/core";

import { AppPage } from "@components/AppPage";

import type { ReactNode } from "react";

export function NotFound({ children }: { children?: ReactNode }) {
  // Rendered outside any route layout, so it supplies its own <main> landmark
  // and padding.
  return (
    <AppPage>
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
    </AppPage>
  );
}
