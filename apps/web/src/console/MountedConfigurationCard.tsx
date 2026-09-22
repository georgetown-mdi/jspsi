import { Alert, Button, Stack, Text, VisuallyHidden } from "@mantine/core";
import { IconAlertCircle, IconAlertTriangle } from "@tabler/icons-react";

import { sanitizeForDisplay } from "@psilink/core";

import { useDeferredAnnouncement } from "@components/useDeferredAnnouncement";

import {
  CLOSE_CONFIGURATION_LABEL,
  CONFIGURATION_LOAD_SEALED,
  CONFIGURATION_READ_UNAVAILABLE,
  NO_CONFIGURATION_IN_FOLDER,
  OPEN_CONFIGURATION_INVITATION,
  OPEN_CONFIGURATION_LABEL,
  configurationOpenedMessage,
  divergedCommitmentNotice,
  mountedConfigurationNotices,
  mountedConfigurationOfferable,
} from "./mountedConfiguration";

import type {
  MountedConfigurationState,
  RunDisclosure,
} from "./mountedConfiguration";

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

/** The notices an open configuration puts beside a step, in one alert.
 * Renders nothing where there are none. */
function NoticesAlert({ notices }: { notices: ReadonlyArray<string> }) {
  if (notices.length === 0) return null;
  return (
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
  );
}

/**
 * The diverged-commitment warning on its own, for the columns step the warning
 * tells the operator to change: the remedy and the report of whether it worked
 * stand together, rather than the report staying on the file step. Nothing else
 * the load says renders here -- each of those is about the load itself.
 */
export function DivergedCommitmentNotice({
  state,
  disclosure,
}: {
  state: MountedConfigurationState;
  /** What the draft this step edits would send to the partner, beside the
   * commitments the open configuration holds. Absent until a file is read. */
  disclosure?: RunDisclosure;
}) {
  const warning = divergedCommitmentNotice(state, disclosure);
  return <NoticesAlert notices={warning === undefined ? [] : [warning]} />;
}

/** The console's load offer and the notices beside it. */
export function MountedConfigurationCard({
  state,
  sealed,
  disclosure,
  onOpen,
  onClose,
}: {
  state: MountedConfigurationState;
  /** Whether an invitation is already minted from the terms the steps below
   * hold, which withholds the offer. */
  sealed: boolean;
  /** What the draft below would send to the partner, beside the commitments the
   * open configuration holds, for the notice that reports a run core refuses.
   * Absent until a file is read, where no draft settles a disclosed set. */
  disclosure?: RunDisclosure;
  /** Read the mounted configuration. Offered while nothing is open, so a read
   * that did not answer can be tried again without a page reload. */
  onOpen: () => void;
  /** Close the open configuration, dropping everything the load put into the
   * steps below and returning the offer. */
  onClose: () => void;
}) {
  const announcement = useDeferredAnnouncement(announcementFor(state));
  const notices = mountedConfigurationNotices(state, disclosure);
  const offerable = mountedConfigurationOfferable(state, sealed);
  const withheld =
    sealed && (state.status === "unread" || state.status === "unavailable");
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
      {withheld && <Text size="sm">{CONFIGURATION_LOAD_SEALED}</Text>}
      {state.status === "reading" && (
        <Button size="xs" variant="default" loading disabled>
          {OPEN_CONFIGURATION_LABEL}
        </Button>
      )}
      {state.status === "absent" && (
        <Text size="sm">{NO_CONFIGURATION_IN_FOLDER}</Text>
      )}
      {state.status === "opened" && (
        <>
          <Alert color="blue" role="presentation" title={OPENED_TITLE}>
            <Text size="sm">{configurationOpenedMessage(state)}</Text>
          </Alert>
          {!sealed && (
            <Button size="xs" variant="default" onClick={onClose}>
              {CLOSE_CONFIGURATION_LABEL}
            </Button>
          )}
        </>
      )}
      <NoticesAlert notices={notices} />
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
