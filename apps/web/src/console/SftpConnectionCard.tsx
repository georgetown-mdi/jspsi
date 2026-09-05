import { useState } from "react";

import { Badge, Button, Group, Stack, Text } from "@mantine/core";

import styles from "@styles/app.module.css";

import {
  EMPTY_SFTP_FORM,
  SPLIT_DIRECTORY_RETAIN_SUMMARY,
} from "./sftpConnectionForm";
import {
  sftpConnectionLabel,
  splitDirectoryRetainProblem,
} from "./sftpConnectionChoice";
import { SftpAuthoringForm } from "./SftpAuthoringForm";
import { SftpCredentialWarnings } from "./SftpCredentialWarnings";

import type { ProbeCeremony } from "./SftpAuthoringForm";
import type { SftpConnectionFormValues } from "./sftpConnectionForm";
import type { SftpConnectionProjection } from "@jobs/jobManager";

/**
 * The console's SFTP connection surface under the SFTP transport card: shows
 * whichever connection is effective and, when the operator may author one,
 * drives `PUT /api/jobs/sftp` from a credential source.
 *
 * With a connection: edit/clear affordances and the accurate "Ready to try"
 * label (authored, not yet verified), plus any non-blocking credential
 * warnings; a split-directory connection whose retain mode has since been
 * turned off is labelled as needing it back instead. Without one: the empty
 * state invites authoring, or a switch to save-a-file for the operator's own
 * command-line tool.
 *
 * The credential is a FILE by default -- picked from the secrets mount or a
 * typed `@path`; a picker selection shows only `secrets / <relative
 * subPath>`, never the absolute container path. A de-emphasized fallback
 * pastes the value, held in component state only (never persisted), and the
 * server materializes it to a file on the console.
 */
export function SftpConnectionCard({
  connection,
  saveFilePreferred,
  retainFiles,
  offerSaveFile = true,
  probeCeremony = "exchange",
  onAuthored,
  onCleared,
  onUseCli,
  onRunHere,
}: {
  connection: SftpConnectionProjection | null;
  /** The operator chose to run SFTP through their own command-line tool
   * (save-a-file) instead of authoring a connection here. */
  saveFilePreferred: boolean;
  /** The exchange's retain-mode choice, forwarded to the authoring form for the
   * split-directory precondition. */
  retainFiles: boolean;
  /** The host-key confirmation ceremony the authoring form's probe presents,
   * forwarded to {@link SftpAuthoringForm} (default `exchange`; `direct` on the
   * direct-exchange path). */
  probeCeremony?: ProbeCeremony;
  /** Whether to offer the save-a-file alternative at all. True (the default) on the
   * inviter path, which can mint an exchange file for the command-line tool. False
   * on the direct-exchange path, which always runs here on the console -- there
   * the empty state offers only authoring, and the save-a-file state is never
   * reachable. */
  offerSaveFile?: boolean;
  onAuthored: (connection: SftpConnectionProjection) => void;
  onCleared: () => void;
  /** The operator chose the save-a-file alternative. Unused when
   * {@link offerSaveFile} is false. */
  onUseCli?: () => void;
  /** The operator undid the save-a-file choice to set up a connection here. Unused
   * when {@link offerSaveFile} is false. */
  onRunHere?: () => void;
}) {
  const [formOpen, setFormOpen] = useState(false);

  // The retain-mode toggle lives on a card of its own and can be turned off after
  // this connection was authored, so the summary re-asks the split-directory
  // precondition rather than calling a connection the run would refuse ready.
  const retainProblem = splitDirectoryRetainProblem(connection, retainFiles);

  if (connection !== null && !formOpen)
    return (
      <Stack gap="xs" mt="xs">
        <Group gap="xs" align="center">
          <Badge
            color={retainProblem === undefined ? "teal" : "orange"}
            variant="light"
          >
            {retainProblem === undefined ? "Ready to try" : "Needs retain mode"}
          </Badge>
          <Text size="sm">
            {retainProblem === undefined
              ? "Runs through "
              : "Set up on this machine, through "}
            <span className={styles.mono}>
              {sftpConnectionLabel(connection)}
            </span>
            {retainProblem === undefined ? ", set up on this machine." : "."}
          </Text>
        </Group>
        {retainProblem !== undefined && (
          <Text size="sm">{SPLIT_DIRECTORY_RETAIN_SUMMARY}</Text>
        )}
        <Text size="sm" c="dimmed">
          The connection is not verified until the exchange runs -- psilink
          checks the server's host key and signs in then. Credentials stay on
          this machine; the invitation carries only where to meet.
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

  if (!formOpen && offerSaveFile && saveFilePreferred)
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
            onRunHere?.();
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
          {offerSaveFile && (
            <Button size="xs" variant="subtle" onClick={onUseCli}>
              Run it in my own command-line tool instead
            </Button>
          )}
        </Group>
      </Stack>
    );

  return (
    <SftpAuthoringForm
      initial={initialFormFor(connection)}
      isEdit={connection !== null}
      retainFiles={retainFiles}
      probeCeremony={probeCeremony}
      onAuthored={(authored) => {
        setFormOpen(false);
        onAuthored(authored);
      }}
      onCancel={() => setFormOpen(false)}
    />
  );
}

/** Seed the form from an existing connection's locator (host, port, and whichever
 * remote-directory form it holds -- the shared `path`, or the split pair, whose
 * inbound half seeds the remote-directory field); the username and credential are
 * not recoverable from the credential-free projection, so an edit re-enters them. */
function initialFormFor(
  connection: SftpConnectionProjection | null,
): SftpConnectionFormValues {
  if (connection === null) return EMPTY_SFTP_FORM;
  return {
    ...EMPTY_SFTP_FORM,
    host: connection.host,
    port: connection.port !== undefined ? String(connection.port) : "",
    remoteDirectory: connection.inboundPath ?? connection.path ?? "",
    outboundDirectory: connection.outboundPath ?? "",
  };
}
