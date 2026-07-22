import { Alert, Button, Group, Radio, Stack, Text } from "@mantine/core";
import { IconAlertCircle } from "@tabler/icons-react";

import { SftpConnectionCard } from "./SftpConnectionCard";
import { rendezvousLocatorName } from "./inviterModel";
import styles from "./bench.module.css";

import type { DirectTransport } from "./directExchangeModel";
import type { JobRendezvousConfig } from "@psi/workInputClient";
import type { SftpConnectionProjection } from "@jobs/jobManager";

/**
 * The direct-exchange server step: choose the agreed transport, then author (or
 * confirm) the server both parties settled on out of band. SFTP is authored
 * free-hand -- inviter-style, never prefilled from a partner locator (a direct
 * exchange carries no invitation) -- through the shared {@link SftpConnectionCard},
 * with the save-a-file affordance dropped since this flow always runs on the
 * appliance. Filedrop runs through the appliance's configured rendezvous mount and
 * is offered only when one is mounted.
 *
 * The host-key fingerprint is captured and pinned here, in the SFTP authoring form,
 * exactly as the inviter path does -- it is not folded into the trust affirmation on
 * the confirm screen, since the fingerprint pin is where the real host-key defense
 * lives.
 */
export function DirectServerSection({
  transport,
  onTransport,
  sftpConnection,
  rendezvous,
  onAuthorConnection,
  onClearConnection,
  onContinue,
  onBack,
}: {
  transport: DirectTransport;
  onTransport: (transport: DirectTransport) => void;
  /** The appliance's authored SFTP connection, or null when none is set up yet. */
  sftpConnection: SftpConnectionProjection | null;
  /** The appliance's rendezvous mount, or undefined before it resolves. */
  rendezvous: JobRendezvousConfig | undefined;
  onAuthorConnection: (connection: SftpConnectionProjection) => void;
  onClearConnection: () => void;
  onContinue: () => void;
  onBack: () => void;
}) {
  const rendezvousConfigured = rendezvous?.configured === true;
  const sftpReady = sftpConnection != null;
  const canContinue = transport === "sftp" ? sftpReady : rendezvousConfigured;

  return (
    <Stack gap="lg">
      <div>
        <h1 tabIndex={-1}>The agreed server</h1>
        <Text size="sm" c="dimmed">
          You and your partner agreed on a server out of band. Set it up here;
          your partner sets up the same server on their own console.
        </Text>
      </div>

      <Radio.Group
        label="How the exchange connects"
        value={transport}
        onChange={(value) =>
          onTransport(value === "filedrop" ? "filedrop" : "sftp")
        }
      >
        <Stack gap="xs" mt="xs">
          <Radio value="sftp" label="An SFTP server" />
          <Radio
            value="filedrop"
            disabled={!rendezvousConfigured}
            label={
              rendezvousConfigured
                ? "A shared directory on this appliance"
                : "A shared directory (no directory is mounted on this appliance)"
            }
          />
        </Stack>
      </Radio.Group>

      {transport === "sftp" ? (
        <SftpConnectionCard
          connection={sftpConnection}
          saveFilePreferred={false}
          offerSaveFile={false}
          onAuthored={onAuthorConnection}
          onCleared={onClearConnection}
        />
      ) : rendezvousConfigured && rendezvous.path !== undefined ? (
        <Text size="sm">
          Runs through the shared directory{" "}
          <span className={styles.mono}>
            {rendezvousLocatorName(rendezvous.path)}
          </span>{" "}
          on this appliance. Point your partner's console at the same synced
          folder.
        </Text>
      ) : (
        <Alert
          color="blue"
          icon={<IconAlertCircle aria-hidden />}
          title="No shared directory is mounted"
        >
          This appliance has no rendezvous directory mounted, so a
          shared-directory exchange cannot run here. Choose SFTP, or mount a
          rendezvous directory and restart the appliance.
        </Alert>
      )}

      <Group>
        <Button onClick={onContinue} disabled={!canContinue}>
          Continue to confirm and run
        </Button>
        <Button variant="default" onClick={onBack}>
          Back
        </Button>
      </Group>
    </Stack>
  );
}
