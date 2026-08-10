import { Alert, Button, Group, Radio, Stack, Text } from "@mantine/core";
import { IconAlertCircle } from "@tabler/icons-react";

import {
  ZERO_SETUP_EXCHANGE_FILES,
  exchangeFilesProblems,
} from "./exchangeFilesModel";
import { ExchangeFilesCard } from "./ExchangeFilesCard";
import { SftpConnectionCard } from "./SftpConnectionCard";
import styles from "./bench.module.css";

import type { DirectTransport } from "./directExchangeModel";
import type { ExchangeFilesDraft } from "./exchangeFilesModel";
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
  exchangeFiles,
  exchangeFilesOpen,
  onExchangeFiles,
  onExchangeFilesOpen,
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
  /** The operator's file-handling choices, authored here because both parties
   * settle them out of band alongside the server itself. */
  exchangeFiles: ExchangeFilesDraft;
  exchangeFilesOpen: boolean;
  onExchangeFiles: (draft: ExchangeFilesDraft) => void;
  onExchangeFilesOpen: (open: boolean) => void;
  onAuthorConnection: (connection: SftpConnectionProjection) => void;
  onClearConnection: () => void;
  onContinue: () => void;
  onBack: () => void;
}) {
  const rendezvousConfigured = rendezvous?.configured === true;
  const sftpReady = sftpConnection != null;
  const transportReady =
    transport === "sftp" ? sftpReady : rendezvousConfigured;
  // A combination core refuses is a form problem here, on the step that authors
  // it, rather than a run that fails at rendezvous.
  const exchangeFilesBlocked =
    exchangeFilesProblems(exchangeFiles, ZERO_SETUP_EXCHANGE_FILES).length > 0;
  const canContinue = transportReady && !exchangeFilesBlocked;

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
          probeCeremony="direct"
          onAuthored={onAuthorConnection}
          onCleared={onClearConnection}
        />
      ) : rendezvousConfigured ? (
        <Text size="sm">
          {/* Named only where the console can name the shared folder: where the
              rendezvous mount point was chosen by a launcher rather than by the
              operator, it names the launcher's layout, not their folder. */}
          {rendezvous.folderName === undefined ? (
            <>Runs through the shared directory mounted on this appliance.</>
          ) : (
            <>
              Runs through the shared directory{" "}
              <span className={styles.mono}>{rendezvous.folderName}</span> on
              this appliance.
            </>
          )}{" "}
          Point your partner's console at the same synced folder.
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

      <ExchangeFilesCard
        draft={exchangeFiles}
        capabilities={ZERO_SETUP_EXCHANGE_FILES}
        open={exchangeFilesOpen}
        onToggleOpen={onExchangeFilesOpen}
        onChange={onExchangeFiles}
      />

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
