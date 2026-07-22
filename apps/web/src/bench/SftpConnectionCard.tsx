import { useState } from "react";

import { Badge, Button, Group, Stack, Text } from "@mantine/core";

import { EMPTY_SFTP_FORM } from "./sftpConnectionForm";
import { SftpAuthoringForm } from "./SftpAuthoringForm";
import { sftpConnectionLabel } from "./sftpConnectionChoice";
import styles from "./bench.module.css";

import type { SftpConnectionFormValues } from "./sftpConnectionForm";
import type { SftpConnectionProjection } from "@jobs/jobManager";

/**
 * The console's SFTP connection surface under the SFTP transport card: it shows
 * whichever connection is effective and, when the operator may author one, drives
 * `PUT /api/jobs/sftp` from a credential source.
 *
 * Three states:
 * - boot-pinned: a deploy-time `JOB_SFTP_SERVER` -- shown read-only (a `PUT` would
 *   409), no authoring offered.
 * - authored: an in-app connection -- shown with edit/clear affordances and the
 *   honest "Ready to try" label (authored, not yet verified against a real run).
 * - authoring required: no connection yet -- the empty state invites authoring, or
 *   a deliberate switch to save-a-file for the operator's own command-line tool.
 *
 * The credential is a FILE by default -- one the operator picks from the secrets
 * mount (a locator the server resolves) or a typed `@path`; no absolute container
 * path is shown for a picker selection, only `secrets / <relative subPath>`. A
 * de-emphasized fallback pastes the value, held in component state only (never
 * persisted) and the server materializes it to a file on the appliance.
 */
export function SftpConnectionCard({
  connection,
  bootPinned,
  saveFilePreferred,
  onAuthored,
  onCleared,
  onUseCli,
  onRunHere,
}: {
  connection: SftpConnectionProjection | null;
  bootPinned: boolean;
  /** The operator chose to run SFTP through their own command-line tool
   * (save-a-file) instead of authoring a connection here. */
  saveFilePreferred: boolean;
  onAuthored: (connection: SftpConnectionProjection) => void;
  onCleared: () => void;
  /** The operator chose the save-a-file alternative. */
  onUseCli: () => void;
  /** The operator undid the save-a-file choice to set up a connection here. */
  onRunHere: () => void;
}) {
  const [formOpen, setFormOpen] = useState(false);

  if (connection !== null && bootPinned)
    return (
      <p className={`${styles.small} ${styles.sub}`}>
        Runs through{" "}
        <span className={styles.mono}>{sftpConnectionLabel(connection)}</span>,
        provisioned on this appliance. Connection details and credentials stay
        on this machine; the invitation carries only where to meet.
      </p>
    );

  if (connection !== null && !formOpen)
    return (
      <Stack gap="xs" mt="xs">
        <Group gap="xs" align="center">
          <Badge color="teal" variant="light">
            Ready to try
          </Badge>
          <Text size="sm">
            Runs through{" "}
            <span className={styles.mono}>
              {sftpConnectionLabel(connection)}
            </span>
            , set up on this machine.
          </Text>
        </Group>
        <Text size="sm" c="dimmed">
          The connection is not verified until the exchange runs -- psilink
          checks the server's host key and signs in then. Credentials stay on
          this machine; the invitation carries only where to meet.
        </Text>
        <Group gap="sm">
          <Button size="xs" variant="default" onClick={() => setFormOpen(true)}>
            Edit connection
          </Button>
          <Button size="xs" variant="subtle" color="red" onClick={onCleared}>
            Clear connection
          </Button>
        </Group>
      </Stack>
    );

  if (!formOpen && saveFilePreferred)
    return (
      <Stack gap="xs" mt="xs">
        <Text size="sm">
          This exchange will run over SFTP in your own psilink command-line tool
          -- it saves an exchange file to run there.
        </Text>
        <Button
          size="xs"
          variant="subtle"
          style={{ alignSelf: "flex-start" }}
          onClick={() => {
            onRunHere();
            setFormOpen(true);
          }}
        >
          Set up a connection to run it here instead
        </Button>
      </Stack>
    );

  if (!formOpen)
    return (
      <Stack gap="xs" mt="xs">
        <Text size="sm">No SFTP connection set up for this exchange yet.</Text>
        <Group gap="sm">
          <Button size="xs" onClick={() => setFormOpen(true)}>
            Add connection
          </Button>
          <Button size="xs" variant="subtle" onClick={onUseCli}>
            Run it in my own command-line tool instead
          </Button>
        </Group>
      </Stack>
    );

  return (
    <SftpAuthoringForm
      initial={initialFormFor(connection)}
      isEdit={connection !== null}
      onAuthored={(authored) => {
        setFormOpen(false);
        onAuthored(authored);
      }}
      onCancel={() => setFormOpen(false)}
    />
  );
}

/** Seed the form from an existing connection's locator (host/port/path); the
 * username and credential are not recoverable from the credential-free projection,
 * so an edit re-enters them. */
function initialFormFor(
  connection: SftpConnectionProjection | null,
): SftpConnectionFormValues {
  if (connection === null) return EMPTY_SFTP_FORM;
  return {
    ...EMPTY_SFTP_FORM,
    host: connection.host,
    port: connection.port !== undefined ? String(connection.port) : "",
    remoteDirectory: connection.path ?? "",
  };
}
