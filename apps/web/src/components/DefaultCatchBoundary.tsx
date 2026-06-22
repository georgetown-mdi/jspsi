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
    <Stack gap="sm" p="sm">
      <ErrorComponent error={error} />
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
  );
}
