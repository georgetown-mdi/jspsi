import { Alert, Checkbox, Stack, Text } from "@mantine/core";
import { IconAlertTriangle, IconInfoCircle } from "@tabler/icons-react";

import { DisclosureSection } from "../components/DisclosureSection";

import {
  DIAGNOSTIC_LOG_NOTICE,
  SWEEP_CONFIRMATION_LABEL,
  SWEEP_CONFIRMATION_NOTICE,
  SWEEP_CONTROL_LABEL,
  SWEEP_RETAIN_ESCALATION_NOTICE,
  runDiagnosticsProblems,
  runDiagnosticsWithControl,
} from "./runDiagnosticsModel";

import type { RunDiagnosticsDraft } from "./runDiagnosticsModel";

/** The collapsed summary, so a closed card is not a blind box: it names whichever
 * of the two controls is on, since either changes what this run does. */
function draftSummary(draft: RunDiagnosticsDraft): string {
  if (draft.diagnosticRun && draft.sweepExchangeFiles)
    return "Detailed log, clearing leftovers first";
  if (draft.sweepExchangeFiles) return "Clearing leftovers first";
  if (draft.diagnosticRun) return "Detailed log";
  return "Default";
}

/**
 * The console's "Diagnostics and recovery" card: the two per-run controls an
 * operator reaches for when a run misbehaves. A closed disclosure, since a first
 * run needs neither: they are the CLI's diagnostic and recovery options, offered
 * here so a failed prototype run does not send the operator back to the command
 * line.
 *
 * Both choices are this run's alone; nothing here is remembered for the next
 * one. The rules behind them belong to {@link runDiagnosticsModel}: the sweep is
 * emitted only once confirmed, and an unconfirmed sweep is a form problem the
 * calling flow blocks the run on rather than a request the console receives.
 *
 * What the sweep DOES belongs to the CLI: this card passes
 * `--sweep-exchange-files` and nothing else, so which files count as the
 * exchange's own, and whether a retain-mode transcript may be deleted, are
 * decided there. The escalation past that guard is named here in fixed copy and
 * not offered; nothing a run says decides what this card tells the operator.
 */
export function RunDiagnosticsCard({
  draft,
  open,
  onToggleOpen,
  onChange,
}: {
  draft: RunDiagnosticsDraft;
  open: boolean;
  onToggleOpen: (open: boolean) => void;
  onChange: (draft: RunDiagnosticsDraft) => void;
}) {
  const problems = runDiagnosticsProblems(draft);
  const set = <TField extends keyof RunDiagnosticsDraft>(
    key: TField,
    value: RunDiagnosticsDraft[TField],
  ): void => onChange(runDiagnosticsWithControl(draft, key, value));

  return (
    <DisclosureSection
      label="Diagnostics and recovery"
      summary={draftSummary(draft)}
      open={open}
      onToggle={onToggleOpen}
      headingOrder={2}
    >
      <Stack gap="md" mt="sm">
        <Text size="sm" c="dimmed">
          Reach for these when a run has already gone wrong: to capture what the
          exchange did, or to clear out what a crashed run left in the shared
          directory. Both apply to this run only.
        </Text>

        <Checkbox
          checked={draft.diagnosticRun}
          onChange={(event) =>
            set("diagnosticRun", event.currentTarget.checked)
          }
          label="Record a detailed log of this run"
          description={
            "Runs the exchange at its most detailed logging level and keeps " +
            "the log with this run's files, to download from the run screen. " +
            "Leave it off for an ordinary run."
          }
        />

        {draft.diagnosticRun && (
          <Alert
            color="blue"
            icon={<IconInfoCircle aria-hidden />}
            title="What the log holds"
          >
            {DIAGNOSTIC_LOG_NOTICE}
          </Alert>
        )}

        <Checkbox
          checked={draft.sweepExchangeFiles}
          onChange={(event) =>
            set("sweepExchangeFiles", event.currentTarget.checked)
          }
          label={SWEEP_CONTROL_LABEL}
          description={
            "Use this when a previous run crashed or stopped mismatched and " +
            "left the shared directory in a state the next run cannot meet a " +
            "partner in."
          }
        />

        {draft.sweepExchangeFiles && (
          <>
            <Alert
              color="yellow"
              icon={<IconAlertTriangle aria-hidden />}
              title="Before you clear them"
            >
              {SWEEP_CONFIRMATION_NOTICE}
            </Alert>
            <Checkbox
              checked={draft.sweepConfirmed}
              onChange={(event) =>
                set("sweepConfirmed", event.currentTarget.checked)
              }
              label={SWEEP_CONFIRMATION_LABEL}
            />
            <Text size="sm" c="dimmed">
              {SWEEP_RETAIN_ESCALATION_NOTICE}
            </Text>
          </>
        )}

        {problems.length > 0 && (
          <Alert
            color="red"
            icon={<IconAlertTriangle aria-hidden />}
            title="This run cannot start yet"
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
