import {
  Alert,
  Checkbox,
  NativeSelect,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { IconAlertTriangle, IconInfoCircle } from "@tabler/icons-react";

import { MAX_PEER_ID_LENGTH } from "@jobs/intentSchemas";

import { DisclosureSection } from "../components/DisclosureSection";

import {
  RETAIN_MODE_BILATERAL_NOTICE,
  exchangeFilesProblems,
} from "./exchangeFilesModel";

import type {
  ExchangeFilesCapabilities,
  ExchangeFilesDraft,
  FileSyncToggle,
  UnexpectedFilesChoice,
} from "./exchangeFilesModel";

const TOGGLE_CHOICES: ReadonlyArray<{ value: FileSyncToggle; label: string }> =
  [
    { value: "auto", label: "Automatic" },
    { value: "on", label: "On" },
    { value: "off", label: "Off" },
  ];

const UNEXPECTED_FILES_CHOICES: ReadonlyArray<{
  value: UnexpectedFilesChoice;
  label: string;
}> = [
  { value: "auto", label: "Automatic" },
  { value: "error", label: "Stop the exchange" },
  { value: "warn", label: "Warn and continue" },
  { value: "ignore", label: "Ignore" },
];

/** The collapsed summary, so a closed card is not a blind box: it names the one
 * choice that changes what the exchange leaves behind. */
function draftSummary(draft: ExchangeFilesDraft): string {
  return draft.retainFiles ? "Keeping every file" : "Default";
}

/**
 * The console's "How files are handled" card: retain mode and the file-sync
 * toggles that travel with it, for an SFTP or shared-directory exchange. Offered
 * as a closed disclosure, since the defaults are right for a first run and these
 * are the settings an operator reaches for in a specific situation -- a durable
 * transcript, or a synced folder whose behaviour needs the lockless rendezvous.
 *
 * Two behaviors belong to {@link exchangeFilesModel}, not to this component:
 * retain mode's implications are resolved by core (so the card
 * states no rule of its own), and an inadmissible combination is reported in
 * core's own words as a form problem, before the run, rather than as a failed
 * job. The card renders the retain-mode bilateral notice the moment retain is
 * switched on, so the operator learns their partner must match while they can
 * still tell them.
 */
export function ExchangeFilesCard({
  draft,
  capabilities,
  open,
  onToggleOpen,
  onChange,
}: {
  draft: ExchangeFilesDraft;
  /** Which controls this flow supports; a flow that composes no configuration
   * document omits the unexpected-files control rather than accepting a value it
   * would drop. */
  capabilities: ExchangeFilesCapabilities;
  open: boolean;
  onToggleOpen: (open: boolean) => void;
  onChange: (draft: ExchangeFilesDraft) => void;
}) {
  const problems = exchangeFilesProblems(draft, capabilities);
  const set = <TField extends keyof ExchangeFilesDraft>(
    key: TField,
    value: ExchangeFilesDraft[TField],
  ): void => onChange({ ...draft, [key]: value });

  return (
    <DisclosureSection
      label="How files are handled"
      summary={draftSummary(draft)}
      open={open}
      onToggle={onToggleOpen}
      headingOrder={2}
    >
      <Stack gap="md" mt="sm">
        <Text size="sm" c="dimmed">
          The defaults suit a first run. Change these when you need a permanent
          record of the exchange, or when the shared folder is kept in step by a
          sync tool.
        </Text>

        <Checkbox
          checked={draft.retainFiles}
          onChange={(event) => set("retainFiles", event.currentTarget.checked)}
          label="Keep every exchange file"
          description={
            "Leave the exchange's files in place as a permanent transcript " +
            "instead of deleting each one once it has been read. They stay " +
            "where the exchange runs: in the remote directory on the SFTP " +
            "server, which you may not administer, or in the shared folder, " +
            "which your partner keeps a synced copy of. Nothing clears them " +
            "afterwards. Also switches on timestamped filenames and the " +
            "lockless rendezvous, which it requires."
          }
        />

        {draft.retainFiles && (
          <Alert
            color="blue"
            icon={<IconInfoCircle aria-hidden />}
            title="Both sides must set this"
          >
            {RETAIN_MODE_BILATERAL_NOTICE}
          </Alert>
        )}

        <NativeSelect
          label="Timestamped filenames"
          description={
            "Adds a timestamp and a counter to each file this side writes. " +
            "Required by keeping every file, and by naming this party below."
          }
          value={draft.timestampInFilename}
          data={TOGGLE_CHOICES.map((choice) => ({
            value: choice.value,
            label: choice.label,
          }))}
          onChange={(event) =>
            set(
              "timestampInFilename",
              event.currentTarget.value as FileSyncToggle,
            )
          }
        />

        <NativeSelect
          label="Lockless rendezvous"
          description={
            "Meets your partner with an acknowledgement handshake instead of a " +
            "lock file. Needed on folders kept in step by a sync tool, which " +
            "may not create a file exclusively or pass a deletion on promptly."
          }
          value={draft.locklessRendezvous}
          data={TOGGLE_CHOICES.map((choice) => ({
            value: choice.value,
            label: choice.label,
          }))}
          onChange={(event) =>
            set(
              "locklessRendezvous",
              event.currentTarget.value as FileSyncToggle,
            )
          }
        />

        <TextInput
          label="Name for this side"
          description={
            "A stable name for this party, used as the prefix of every file it " +
            "writes and in the logs. Leave it blank for a generated one. The " +
            "two sides must choose different names."
          }
          placeholder="clinic-a"
          maxLength={MAX_PEER_ID_LENGTH}
          value={draft.peerId}
          onChange={(event) => set("peerId", event.currentTarget.value)}
        />

        {capabilities.unexpectedFiles && (
          <NativeSelect
            label="If an unrecognised file appears"
            description={
              "What to do when a file that is not part of this exchange turns " +
              "up in the shared directory mid-run. Automatic stops the " +
              "exchange on a plain directory and warns when the settings above " +
              "mark it as kept in step by a sync tool."
            }
            value={draft.unexpectedFiles}
            data={UNEXPECTED_FILES_CHOICES.map((choice) => ({
              value: choice.value,
              label: choice.label,
            }))}
            onChange={(event) =>
              set(
                "unexpectedFiles",
                event.currentTarget.value as UnexpectedFilesChoice,
              )
            }
          />
        )}

        {problems.length > 0 && (
          <Alert
            color="red"
            icon={<IconAlertTriangle aria-hidden />}
            title="These settings cannot be used together"
          >
            <ul>
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </Alert>
        )}
      </Stack>
    </DisclosureSection>
  );
}
