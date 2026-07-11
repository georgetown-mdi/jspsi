import { Link } from "@tanstack/react-router";

import { Button, Group, Stack, Text } from "@mantine/core";

import { BenchPage } from "@bench/BenchPage";

import type { ReactNode } from "react";

export function NotFound({ children }: { children?: ReactNode }) {
  // A root-level error surface outside any route layout: it renders itself on
  // the bench page ground and supplies its own <main> landmark and padding.
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
