import { Alert, Button, Group, Loader, Stack, Text } from "@mantine/core";
import { IconAlertCircle, IconRefresh } from "@tabler/icons-react";

import type { ReactNode } from "react";

/**
 * The shared listing-shell discipline for the console's mounted-directory
 * surfaces (the work-input picker and the secrets-credential picker): the
 * loading, informational config-gap, transient-fault, and refresh presentation,
 * factored out so the two pickers cannot drift on it. Each caller supplies its own
 * copy -- the mount and the env var differ -- but the state shapes, colors, and
 * the refresh affordance live here once.
 */

/** A small refresh control shared by the mount listing surfaces. */
export function RefreshButton({
  onRefresh,
  label = "Refresh",
}: {
  onRefresh: () => void;
  label?: string;
}) {
  return (
    <Button
      size="xs"
      variant="default"
      leftSection={<IconRefresh size={14} aria-hidden />}
      onClick={onRefresh}
    >
      {label}
    </Button>
  );
}

/**
 * A mount listing state notice: an informational (`blue`, a stable config state)
 * or fault (`red`, a transient error to retry) alert with a title and body, plus
 * an optional action row (typically a {@link RefreshButton}). Blue names what to
 * set; red says to check the mount and retry -- the copy discipline both pickers
 * share.
 */
export function MountStateNotice({
  color,
  title,
  children,
  action,
}: {
  color: "blue" | "red";
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Stack gap="sm">
      <Alert color={color} icon={<IconAlertCircle />} title={title}>
        {children}
      </Alert>
      {action}
    </Stack>
  );
}

/** The mount listing loading state: a spinner and a dimmed message. */
export function MountLoading({ message }: { message: string }) {
  return (
    <Group gap="xs">
      <Loader size="sm" />
      <Text size="sm" c="dimmed">
        {message}
      </Text>
    </Group>
  );
}
