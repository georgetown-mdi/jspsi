import {
  Alert,
  Checkbox,
  Group,
  NativeSelect,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { IconAlertTriangle, IconInfoCircle } from "@tabler/icons-react";

import { DEFAULT_MAX_RECONNECT_ATTEMPTS } from "@psilink/core";

import { DisclosureSection } from "../components/DisclosureSection";

import {
  POLL_INTERVAL_UNITS,
  TIMEOUT_UNITS,
  TUNING_DEFAULT_MS,
  connectionTuningAdvisories,
  connectionTuningProblems,
  connectionTuningSummary,
  defaultPlaceholder,
} from "./connectionTuningModel";

import type {
  ConnectionTuningCapabilities,
  ConnectionTuningDraft,
  DurationField,
  DurationUnit,
} from "./connectionTuningModel";

const UNIT_LABELS: Record<DurationUnit, string> = {
  ms: "milliseconds",
  s: "seconds",
  m: "minutes",
  h: "hours",
};

/** One duration control: the magnitude beside the unit it is authored in. The
 * unit select has no visible label -- the pairing is visual -- so its accessible
 * name names the field it belongs to. */
function DurationRow({
  label,
  description,
  units,
  defaultMs,
  value,
  onChange,
}: {
  label: string;
  description: string;
  units: ReadonlyArray<DurationUnit>;
  defaultMs: number;
  value: DurationField;
  onChange: (next: DurationField) => void;
}) {
  return (
    <Group align="flex-end" gap="xs" wrap="nowrap">
      <TextInput
        style={{ flex: 1 }}
        label={label}
        description={description}
        inputMode="numeric"
        placeholder={defaultPlaceholder(defaultMs, value.unit)}
        value={value.magnitude}
        onChange={(event) =>
          onChange({ ...value, magnitude: event.currentTarget.value })
        }
      />
      <NativeSelect
        aria-label={`${label}: unit`}
        value={value.unit}
        data={units.map((unit) => ({ value: unit, label: UNIT_LABELS[unit] }))}
        onChange={(event) =>
          onChange({
            ...value,
            unit: event.currentTarget.value as DurationUnit,
          })
        }
      />
    </Group>
  );
}

/**
 * The console's "Connection tuning" card: how often the exchange checks for the
 * partner's files, how long it waits for the partner and for each connection
 * attempt, how many times it retries, and -- on SFTP -- whether it opens a fresh
 * session for each check. Offered as a closed disclosure beside the file-handling
 * card, since the defaults are right for a first run and these are the settings an
 * operator reaches for in a specific situation: a slow peer, a firewalled link, or
 * a server that caps how long a session may last.
 *
 * Two behaviors belong to {@link connectionTuningModel}, not to this component:
 * the unit conversion into the milliseconds the job intent
 * speaks, and the two advisories the CLI raises at run time, raised here while the
 * operator can still act on them. The advisories never block -- both values are
 * legitimate against a server the operator controls, and the command line refuses
 * neither -- while a malformed magnitude is a form problem, before the run.
 */
export function ConnectionTuningCard({
  draft,
  capabilities,
  open,
  onToggleOpen,
  onChange,
}: {
  draft: ConnectionTuningDraft;
  /** Which controls this flow supports; a shared-directory flow omits the SFTP
   * session mode rather than accepting a value its client cannot honour. */
  capabilities: ConnectionTuningCapabilities;
  open: boolean;
  onToggleOpen: (open: boolean) => void;
  onChange: (draft: ConnectionTuningDraft) => void;
}) {
  const problems = connectionTuningProblems(draft);
  const advisories = connectionTuningAdvisories(draft, capabilities);
  const set = <TField extends keyof ConnectionTuningDraft>(
    key: TField,
    value: ConnectionTuningDraft[TField],
  ): void => onChange({ ...draft, [key]: value });

  return (
    <DisclosureSection
      label="Connection tuning"
      summary={connectionTuningSummary(draft, capabilities)}
      open={open}
      onToggle={onToggleOpen}
      headingOrder={2}
    >
      <Stack gap="md" mt="sm">
        <Text size="sm" c="dimmed">
          The defaults suit a first run. Change these for a partner who runs
          their half hours later, a link that drops often, or a server that
          limits how long a connection may stay open. Leave a field blank to use
          the default shown in it.
        </Text>

        <DurationRow
          label="How often to check for your partner's files"
          description="Each check lists the shared directory. Checking less often is gentler on the server; checking more often finds your partner's files sooner."
          units={POLL_INTERVAL_UNITS}
          defaultMs={TUNING_DEFAULT_MS.pollInterval}
          value={draft.pollInterval}
          onChange={(next) => set("pollInterval", next)}
        />

        <DurationRow
          label="How long to wait for your partner"
          description="How long this side waits for the other to appear, and for each step of the exchange, before it gives up."
          units={TIMEOUT_UNITS}
          defaultMs={TUNING_DEFAULT_MS.peerTimeout}
          value={draft.peerTimeout}
          onChange={(next) => set("peerTimeout", next)}
        />

        <DurationRow
          label="How long to wait for each connection attempt"
          description="How long one attempt to reach the server may take before it counts as failed. Applies to each attempt, not to all of them together."
          units={TIMEOUT_UNITS}
          defaultMs={TUNING_DEFAULT_MS.serverConnectTimeout}
          value={draft.serverConnectTimeout}
          onChange={(next) => set("serverConnectTimeout", next)}
        />

        <TextInput
          label="How many times to retry a failed connection"
          description={
            "Raise it for a link that drops often. The command-line " +
            "reference for --max-reconnect-attempts explains how this budget " +
            "interacts with opening a new connection for each check."
          }
          inputMode="numeric"
          placeholder={String(DEFAULT_MAX_RECONNECT_ATTEMPTS)}
          value={draft.maxReconnectAttempts}
          onChange={(event) =>
            set("maxReconnectAttempts", event.currentTarget.value)
          }
        />

        {capabilities.connectionPerPoll && (
          <Checkbox
            checked={draft.connectionPerPoll}
            onChange={(event) =>
              set("connectionPerPoll", event.currentTarget.checked)
            }
            label="Open a new connection for each check"
            description={
              "Connect to the SFTP server afresh for each check and disconnect " +
              "in between, instead of holding one connection for the whole " +
              "exchange. Use it when the server limits how long a connection " +
              "may stay open and your exchange spans long waits. This side's " +
              "choice alone -- your partner neither sees it nor has to match it."
            }
          />
        )}

        {advisories.length > 0 && (
          <Alert
            color="blue"
            icon={<IconInfoCircle aria-hidden />}
            title="Worth knowing about these settings"
          >
            <ul>
              {advisories.map((advisory) => (
                <li key={advisory}>{advisory}</li>
              ))}
            </ul>
          </Alert>
        )}

        {problems.length > 0 && (
          <Alert
            color="red"
            icon={<IconAlertTriangle aria-hidden />}
            title="These settings cannot be used"
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
