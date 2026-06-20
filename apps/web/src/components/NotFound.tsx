import { Link } from "@tanstack/react-router";

import { Button, Group, Stack, Text } from "@mantine/core";

import type { ReactNode } from "react";

export function NotFound({ children }: { children?: ReactNode }) {
  return (
    <Stack gap="sm" p="sm">
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
  );
}
