import { useState } from "react";

import { Alert, Badge, Button, Group, Stack, Text } from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";

import { sanitizeForDisplay } from "@psilink/core";

import {
  sftpBootServerMismatch,
  sftpConnectionLabel,
} from "./sftpConnectionChoice";
import { SftpAuthoringForm } from "./SftpAuthoringForm";
import { sftpFormFromLocator } from "./sftpConnectionForm";
import styles from "./bench.module.css";

import type { SftpConnectionProjection } from "@jobs/jobManager";
import type { SftpEndpointLocator } from "./sftpConnectionForm";

/**
 * The accept-side SFTP connection surface: the operator authors the connection to
 * the SFTP server the PARTNER named in the invitation, before the console
 * appliance can run the accept. The partner-supplied locator (host/port/path) is
 * shown read-only and pre-fills the authoring request; the operator supplies the
 * username, the required host-key fingerprint, and the credential -- none of which
 * an invitation can carry or override (an {@link SFTPEndpoint} is credential- and
 * fingerprint-free by construction, and {@link sftpFormFromLocator} reads only the
 * locator).
 *
 * Load-bearing control: the fingerprint is pinned BEFORE any credentialed connect,
 * so a partner who redirects to a host they control is refused before the
 * credential is sent. It is operator-supplied and required (the form and
 * `PUT /api/jobs/sftp` both reject a missing or malformed one), never sourced from
 * the invitation.
 *
 * States mirror the invite card minus the save-a-file alternative (the accept
 * transport is fixed by the invitation): a boot-provisioned server shown read-only,
 * an authored connection with edit/clear affordances, and the authoring prompt when
 * none is set up yet.
 */
export function AcceptorSftpConnectionCard({
  locator,
  connection,
  bootPinned,
  onAuthored,
  onCleared,
}: {
  /** The partner-supplied SFTP locator from the accepted invitation's endpoint:
   * where to connect, and nothing more. */
  locator: SftpEndpointLocator;
  /** The effective connection: the operator-authored (or boot-provisioned)
   * credential-free locator, or null until the operator authors one. */
  connection: SftpConnectionProjection | null;
  /** Whether the effective connection is a deploy-time boot server (read-only, no
   * authoring offered). Meaningful only when `connection` is set. */
  bootPinned: boolean;
  /** An in-app authored connection landed (its credential-free projection). */
  onAuthored: (connection: SftpConnectionProjection) => void;
  /** The operator cleared the authored connection. */
  onCleared: () => void;
}) {
  const [formOpen, setFormOpen] = useState(false);

  if (connection !== null && bootPinned)
    return (
      <Stack gap="xs" mt="xs">
        <Text size="sm" c="dimmed">
          Your partner named{" "}
          <span className={styles.mono}>
            {sanitizeForDisplay(sftpConnectionLabel(locator))}
          </span>
          ; this appliance is provisioned with{" "}
          <span className={styles.mono}>
            {sanitizeForDisplay(sftpConnectionLabel(connection))}
          </span>
          . Confirm they are the same server. Credentials stay on this machine.
        </Text>
        {sftpBootServerMismatch(locator, connection) && (
          <Alert
            color="orange"
            icon={<IconAlertTriangle aria-hidden />}
            title="This appliance's server is not the one your partner named"
          >
            The server provisioned on this appliance does not match the one your
            partner named. Unless both parties connect to the same server, the
            exchange will not meet. Confirm this appliance&apos;s server is an
            alias or address of your partner&apos;s before you start.
          </Alert>
        )}
      </Stack>
    );

  if (connection !== null && !formOpen)
    return (
      <Stack gap="xs" mt="xs">
        <Group gap="xs" align="center">
          <Badge color="teal" variant="light">
            Ready to try
          </Badge>
          <Text size="sm">
            Signs in to{" "}
            <span className={styles.mono}>
              {sanitizeForDisplay(sftpConnectionLabel(connection))}
            </span>
            , set up on this machine.
          </Text>
        </Group>
        <Text size="sm" c="dimmed">
          The connection is not verified until the exchange runs -- psilink
          checks the server against the fingerprint you gave and signs in then.
          Credentials stay on this machine.
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

  if (!formOpen)
    return (
      <Stack gap="xs" mt="xs">
        <Text size="sm">
          Your partner named this server:{" "}
          <span className={styles.mono}>
            {sanitizeForDisplay(sftpConnectionLabel(locator))}
          </span>
          . Set up your connection before you start -- you sign in with your own
          account and confirm the server&apos;s identity fingerprint.
        </Text>
        <Button
          size="xs"
          style={{ alignSelf: "flex-start" }}
          onClick={() => setFormOpen(true)}
        >
          Set up connection
        </Button>
      </Stack>
    );

  return (
    <SftpAuthoringForm
      initial={sftpFormFromLocator(locator)}
      isEdit={connection !== null}
      reviewLocator={locator}
      onAuthored={(authored) => {
        setFormOpen(false);
        onAuthored(authored);
      }}
      onCancel={() => setFormOpen(false)}
    />
  );
}
