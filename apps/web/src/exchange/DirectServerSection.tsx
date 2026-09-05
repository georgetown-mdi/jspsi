import { useId } from "react";

import { Alert, Button, Group, Radio, Stack, Text } from "@mantine/core";
import { IconAlertCircle, IconAlertTriangle } from "@tabler/icons-react";

import { runDiagnosticsProblems } from "@psi/runDiagnosticsModel";

import {
  FILEDROP_CONNECTION_TUNING,
  SFTP_CONNECTION_TUNING,
  connectionTuningProblems,
} from "@console/connectionTuningModel";
import {
  ZERO_SETUP_EXCHANGE_FILES,
  exchangeFilesProblems,
} from "@console/exchangeFilesModel";
import { ConnectionTuningCard } from "@console/ConnectionTuningCard";
import { ExchangeFilesCard } from "@console/ExchangeFilesCard";
import { RunDiagnosticsCard } from "@console/RunDiagnosticsCard";
import { SftpConnectionCard } from "@console/SftpConnectionCard";
import { splitDirectoryRetainProblem } from "@console/sftpConnectionChoice";
import { splitRendezvousRetainProblem } from "@console/filedropRendezvousChoice";
import styles from "@styles/app.module.css";

import { directServerBlockedReason } from "./directExchangeModel";

import type { ConnectionTuningDraft } from "@console/connectionTuningModel";
import type { DirectTransport } from "./directExchangeModel";
import type { ExchangeFilesDraft } from "@console/exchangeFilesModel";
import type { JobRendezvousConfig } from "@psi/jobClient/workInputClient";
import type { RunDiagnosticsDraft } from "@psi/runDiagnosticsModel";
import type { SftpConnectionProjection } from "@jobs/jobManager";

/**
 * The direct-exchange server step: choose the agreed transport, then author (or
 * confirm) the server both parties settled on out of band. SFTP is authored
 * free-hand -- inviter-style, never prefilled from a partner locator (a direct
 * exchange has no invitation) -- through the shared {@link SftpConnectionCard},
 * with the save-a-file affordance dropped since this flow always runs on the
 * console. Filedrop runs through the console's configured rendezvous mount and
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
  connectionTuning,
  connectionTuningOpen,
  onConnectionTuning,
  onConnectionTuningOpen,
  runDiagnostics,
  runDiagnosticsOpen,
  onRunDiagnostics,
  onRunDiagnosticsOpen,
  onAuthorConnection,
  onClearConnection,
  onContinue,
  onBack,
}: {
  transport: DirectTransport;
  onTransport: (transport: DirectTransport) => void;
  /** The console's authored SFTP connection, or null when none is set up yet. */
  sftpConnection: SftpConnectionProjection | null;
  /** The console's rendezvous mount, or undefined before it resolves. */
  rendezvous: JobRendezvousConfig | undefined;
  /** The operator's file-handling choices, authored here because both parties
   * settle them out of band alongside the server itself. */
  exchangeFiles: ExchangeFilesDraft;
  exchangeFilesOpen: boolean;
  onExchangeFiles: (draft: ExchangeFilesDraft) => void;
  onExchangeFilesOpen: (open: boolean) => void;
  /** The operator's connection-tuning choices, authored here for the same reason
   * the file-handling ones are. */
  connectionTuning: ConnectionTuningDraft;
  connectionTuningOpen: boolean;
  onConnectionTuning: (draft: ConnectionTuningDraft) => void;
  onConnectionTuningOpen: (open: boolean) => void;
  /** The operator's per-run diagnostic and recovery choices. Authored here, with
   * the other pre-run cards, because the sweep is a decision about the very
   * directory this step determines. */
  runDiagnostics: RunDiagnosticsDraft;
  runDiagnosticsOpen: boolean;
  onRunDiagnostics: (draft: RunDiagnosticsDraft) => void;
  onRunDiagnosticsOpen: (open: boolean) => void;
  onAuthorConnection: (connection: SftpConnectionProjection) => void;
  onClearConnection: () => void;
  onContinue: () => void;
  onBack: () => void;
}) {
  const blockedReasonId = useId();
  const rendezvousConfigured = rendezvous?.configured === true;
  const sftpReady = sftpConnection != null;
  const transportReady =
    transport === "sftp" ? sftpReady : rendezvousConfigured;
  // The SFTP session mode applies only where a session exists, so the tuning card
  // withholds it on the shared-directory transport.
  const tuningCapabilities =
    transport === "sftp" ? SFTP_CONNECTION_TUNING : FILEDROP_CONNECTION_TUNING;
  // The rendezvous and the retain-mode toggle are settled on separate cards here,
  // so the split precondition is re-asked at the step's exit, where both are
  // known, rather than only inside the authoring form the operator has already
  // left -- or, on the shared-directory transport, nowhere at all, since the
  // console's two mounts are provisioning the operator never authors here.
  const splitDirectoryProblem =
    transport === "sftp"
      ? splitDirectoryRetainProblem(sftpConnection, exchangeFiles.retainFiles)
      : splitRendezvousRetainProblem(rendezvous, exchangeFiles.retainFiles);
  // A value either card's run would refuse is a form problem here, on the step
  // that authors it, rather than a run that fails at rendezvous. The two cards
  // block separately so the sentence below names the one to open.
  const blockedReason = directServerBlockedReason({
    transport,
    transportReady,
    exchangeFilesBlocked:
      exchangeFilesProblems(exchangeFiles, ZERO_SETUP_EXCHANGE_FILES).length >
      0,
    connectionTuningBlocked:
      connectionTuningProblems(connectionTuning).length > 0,
    runDiagnosticsBlocked: runDiagnosticsProblems(runDiagnostics).length > 0,
    splitDirectoryBlocked: splitDirectoryProblem !== undefined,
  });
  const canContinue = blockedReason === undefined;

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
                ? "A shared directory on this console"
                : "A shared directory (no directory is mounted on this console)"
            }
          />
        </Stack>
      </Radio.Group>

      {transport === "sftp" ? (
        <SftpConnectionCard
          connection={sftpConnection}
          saveFilePreferred={false}
          retainFiles={exchangeFiles.retainFiles}
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
          {rendezvous.split === true ? (
            <>
              Runs through the two shared folders mounted on this console: it
              reads your partner&apos;s files out of one and writes yours into
              the other.{" "}
              {rendezvous.folderName !== undefined &&
              rendezvous.outboundFolderName !== undefined ? (
                <>
                  You read from{" "}
                  <span className={styles.mono}>{rendezvous.folderName}</span>{" "}
                  and write to{" "}
                  <span className={styles.mono}>
                    {rendezvous.outboundFolderName}
                  </span>
                  .{" "}
                </>
              ) : null}
              Point your partner&apos;s console at the same two folders, the
              other way round.
            </>
          ) : (
            <>
              {rendezvous.folderName === undefined ? (
                <>Runs through the shared directory mounted on this console.</>
              ) : (
                <>
                  Runs through the shared directory{" "}
                  <span className={styles.mono}>{rendezvous.folderName}</span>{" "}
                  on this console.
                </>
              )}{" "}
              Point your partner&apos;s console at the same synced folder.
            </>
          )}
        </Text>
      ) : (
        <Alert
          color="blue"
          icon={<IconAlertCircle aria-hidden />}
          title="No shared directory is mounted"
        >
          {/* The console's own reason wins where it has one: an incoherent
              pair of mounts reports itself unconfigured, and the generic
              sentence would send an operator who already mounted two folders to
              add a third. */}
          {rendezvous?.problem ??
            "This console has no rendezvous directory mounted, so a shared-directory exchange cannot run here. Choose SFTP, or mount a rendezvous directory and restart the console."}
        </Alert>
      )}

      <ExchangeFilesCard
        draft={exchangeFiles}
        capabilities={ZERO_SETUP_EXCHANGE_FILES}
        open={exchangeFilesOpen}
        onToggleOpen={onExchangeFilesOpen}
        onChange={onExchangeFiles}
      />

      <ConnectionTuningCard
        draft={connectionTuning}
        capabilities={tuningCapabilities}
        open={connectionTuningOpen}
        onToggleOpen={onConnectionTuningOpen}
        onChange={onConnectionTuning}
      />

      <RunDiagnosticsCard
        draft={runDiagnostics}
        open={runDiagnosticsOpen}
        onToggleOpen={onRunDiagnosticsOpen}
        onChange={onRunDiagnostics}
      />

      {splitDirectoryProblem !== undefined && (
        <Alert
          color="red"
          icon={<IconAlertTriangle aria-hidden />}
          title="This connection needs retain mode"
        >
          {splitDirectoryProblem}
        </Alert>
      )}

      <Group>
        <Button
          onClick={onContinue}
          disabled={!canContinue}
          aria-describedby={canContinue ? undefined : blockedReasonId}
        >
          Continue to confirm and run
        </Button>
        <Button variant="default" onClick={onBack}>
          Back
        </Button>
      </Group>
      {/* Mounted whether or not it currently has content, so a reason that
          appears mid-session is an empty -> non-empty transition assistive tech
          announces, rather than a region mounting with its text already set. */}
      <Text id={blockedReasonId} size="sm" c="dimmed" role="status">
        {blockedReason}
      </Text>
    </Stack>
  );
}
