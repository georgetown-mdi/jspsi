import { useState } from "react";

import { Badge, Button, Group, Stack, Text } from "@mantine/core";

import { sanitizeForDisplay } from "@psilink/core";

import { SftpAuthoringForm } from "./SftpAuthoringForm";
import { SftpCredentialWarnings } from "./SftpCredentialWarnings";
import { sftpConnectionLabel } from "./sftpConnectionChoice";
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
 * transport is fixed by the invitation): an authored connection with edit/clear
 * affordances, and the authoring prompt when none is set up yet.
 */
export function AcceptorSftpConnectionCard({
  locator,
  connection,
  onAuthored,
  onCleared,
}: {
  /** The partner-supplied SFTP locator from the accepted invitation's endpoint:
   * where to connect, and nothing more. */
  locator: SftpEndpointLocator;
  /** The effective connection: the operator-authored credential-free locator, or
   * null until the operator authors one. */
  connection: SftpConnectionProjection | null;
  /** An in-app authored connection landed (its credential-free projection). */
  onAuthored: (connection: SftpConnectionProjection) => void;
  /** The operator cleared the authored connection. */
  onCleared: () => void;
}) {
  const [formOpen, setFormOpen] = useState(false);

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
        <SftpCredentialWarnings
          warnings={connection.credentialWarnings ?? []}
        />
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
      probeCeremony="exchange"
      onAuthored={(authored) => {
        setFormOpen(false);
        onAuthored(authored);
      }}
      onCancel={() => setFormOpen(false)}
    />
  );
}
