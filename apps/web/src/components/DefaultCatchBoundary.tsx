import { Button, Group, Stack } from "@mantine/core";
import {
  ErrorComponent,
  Link,
  rootRouteId,
  useMatch,
  useRouter,
} from "@tanstack/react-router";

import type { ErrorComponentProps } from "@tanstack/react-router";

export function DefaultCatchBoundary({ error }: ErrorComponentProps) {
  const router = useRouter();
  const isRoot = useMatch({
    strict: false,
    select: (state) => state.id === rootRouteId,
  });

  console.error("DefaultCatchBoundary Error:", error);

  return (
    <Stack align="center" gap="xl" p="md">
      <ErrorComponent error={error} />
      <Group gap="2xs">
        <Button
          color="gray"
          size="compact-sm"
          tt="uppercase"
          fw={800}
          onClick={() => {
            router.invalidate();
          }}
        >
          Try Again
        </Button>
        {isRoot ? (
          <Button
            component={Link}
            to="/"
            color="gray"
            size="compact-sm"
            tt="uppercase"
            fw={800}
          >
            Home
          </Button>
        ) : (
          <Button
            color="gray"
            size="compact-sm"
            tt="uppercase"
            fw={800}
            onClick={() => window.history.back()}
          >
            Go Back
          </Button>
        )}
      </Group>
    </Stack>
  );
}
