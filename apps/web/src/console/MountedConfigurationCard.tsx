import { Alert, Button, Stack, Text, VisuallyHidden } from "@mantine/core";
import { IconAlertCircle, IconAlertTriangle } from "@tabler/icons-react";

import { sanitizeForDisplay } from "@psilink/core";

import { useDeferredAnnouncement } from "@components/useDeferredAnnouncement";

import {
  CONFIGURATION_OPENED,
  CONFIGURATION_READ_UNAVAILABLE,
  NO_CONFIGURATION_IN_FOLDER,
  OPEN_CONFIGURATION_INVITATION,
  OPEN_CONFIGURATION_LABEL,
  mountedConfigurationNotices,
} from "./mountedConfiguration";

import type { MountedConfigurationState } from "./mountedConfiguration";

/**
 * The console's offer to open the command-line configuration in its mounted
 * working folder, shown on the file step so the delimiter that configuration
 * states is in force before the input file is read.
 *
 * What it shows is decided by {@link mountedConfiguration}, which is where the
 * copy lives; this holds the rendering and the live region. The polite region
 * announces the state's own heading alone -- the notices stay in reading order
 * below it -- and each visible Alert takes `role="presentation"` to displace
 * Mantine's `role="alert"` default, which would announce the same text twice.
 *
 * The refusal text is the console's own, composed around setting names taken
 * from the operator's file, so it is escaped once here at the sink it is
 * displayed at.
 */

/** The heading each state announces and titles its alert with. */
const OPENED_TITLE = "Configuration opened";
const NOTICES_TITLE = "What this configuration needs from you";
const REFUSED_TITLE = "This configuration cannot be opened";

/** What the polite region announces for each state; the empty string announces
 * nothing, which is what an unread offer and an in-flight read are. */
function announcementFor(state: MountedConfigurationState): string {
  switch (state.status) {
    case "opened":
      return OPENED_TITLE;
    case "refused":
      return REFUSED_TITLE;
    case "absent":
      return NO_CONFIGURATION_IN_FOLDER;
    case "unavailable":
      return CONFIGURATION_READ_UNAVAILABLE;
    default:
      return "";
  }
}

/** The console's load offer and the notices beside it. */
export function MountedConfigurationCard({
  state,
  onOpen,
}: {
  state: MountedConfigurationState;
  /** Read the mounted configuration. Offered while nothing is open, so a read
   * that did not answer can be tried again without a page reload. */
  onOpen: () => void;
}) {
  const announcement = useDeferredAnnouncement(announcementFor(state));
  const notices = mountedConfigurationNotices(state);
  const offerable = state.status === "unread" || state.status === "unavailable";
  return (
    <Stack gap="xs">
      <VisuallyHidden
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="mounted-configuration-announcement"
      >
        {announcement}
      </VisuallyHidden>
      {offerable && (
        <>
          <Text size="sm">
            {state.status === "unavailable"
              ? CONFIGURATION_READ_UNAVAILABLE
              : OPEN_CONFIGURATION_INVITATION}
          </Text>
          <Button size="xs" variant="default" onClick={onOpen}>
            {OPEN_CONFIGURATION_LABEL}
          </Button>
        </>
      )}
      {state.status === "reading" && (
        <Button size="xs" variant="default" loading disabled>
          {OPEN_CONFIGURATION_LABEL}
        </Button>
      )}
      {state.status === "absent" && (
        <Text size="sm">{NO_CONFIGURATION_IN_FOLDER}</Text>
      )}
      {state.status === "opened" && (
        <Alert color="blue" role="presentation" title={OPENED_TITLE}>
          <Text size="sm">{CONFIGURATION_OPENED}</Text>
        </Alert>
      )}
      {notices.length > 0 && (
        <Alert
          color="yellow"
          role="presentation"
          icon={<IconAlertTriangle aria-hidden />}
          title={NOTICES_TITLE}
        >
          <Stack gap={4}>
            {notices.map((notice, index) => (
              <Text key={index} size="sm">
                {notice}
              </Text>
            ))}
          </Stack>
        </Alert>
      )}
      {state.status === "refused" && (
        <Alert
          color="red"
          role="presentation"
          icon={<IconAlertCircle aria-hidden />}
          title={REFUSED_TITLE}
        >
          <Text size="sm">{sanitizeForDisplay(state.error)}</Text>
        </Alert>
      )}
    </Stack>
  );
}
