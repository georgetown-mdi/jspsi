import { Alert, Text } from "@mantine/core";
import { IconAlertCircle } from "@tabler/icons-react";

import { isSilentEmpty } from "@psi/nonEmptyAggregate";

import type { FieldValueCoverage } from "@psi/nonEmptyAggregate";

/** The default coverage pending copy: the hosted sweep runs in the browser, so it
 * reads as the near-instant local check it is. */
export const COVERAGE_PENDING_LABEL =
  "Checking how many of your rows produce a value...";

/** The console coverage pending copy: the sweep is a streaming pass over the whole
 * mounted file on the appliance -- honestly seconds, and tens of seconds at CLI
 * scale -- so the copy says so rather than reading as instant-local (the register of
 * the picker's profile-loading copy). */
export const CONSOLE_COVERAGE_PENDING_LABEL =
  "Checking how many of your rows produce a value. The appliance reads the " +
  "whole file, so this can take a while on a large file.";

/** The explicit "coverage unavailable" copy: a deterministic coverage failure (or a
 * worker error) settled the sweep without a result, so the host says the check could
 * not run rather than hanging on the pending placeholder or going blank. */
export const COVERAGE_UNAVAILABLE_MESSAGE =
  "We could not check how many of your rows produce a value. Your cleaning " +
  "steps still apply; this check just did not run.";

/** Format the share of rows that produce a key. The ends are guarded so the percent
 * never overstates the extremes: a non-zero rate that rounds to 0% shows "<1%"
 * (never a "0%" that reads like the silent-empty alarm), and a sub-100% rate that
 * rounds to 100% shows ">99%" (never a "100%" while a row is in fact dropped). */
function formatRate(coverage: FieldValueCoverage): string {
  const percent = coverage.rate * 100;
  const shown =
    percent > 0 && percent < 1
      ? "<1%"
      : percent > 99 && percent < 100
        ? ">99%"
        : `${Math.round(percent)}%`;
  return (
    `${coverage.produced.toLocaleString()} of ${coverage.total.toLocaleString()} ` +
    `rows produce a value (${shown})`
  );
}

/**
 * The per-field full-CSV coverage readout: the visible half of the silent-empty
 * defense, computed over the WHOLE file (not the preview's row sample), so it sees a
 * collapse the sample cannot. When the field's transform drops every row
 * ({@link isSilentEmpty}) it shows a prominent alarm -- shape is satisfiable yet no
 * key is produced, byte-equivalent to a real empty intersection. Otherwise it states
 * the share of rows that yield a value, which (because the sweep observes empties)
 * rises when a `coalesce` fills blanks. An empty cleaned value counts as produced --
 * a participating key, distinct from a dropped value, consistent with the per-row
 * preview -- so an all-empty field is not mislabelled as zero coverage.
 *
 * The alarm is `role="presentation"`: the assistive-tech announcement is made once,
 * for the whole editor, by the host editor's coverage live region ({@link CleaningTab}
 * and {@link AcceptorCleaningStep} each own one), so N field cards do not each fire
 * their own region. An `unavailable` rate (steps left
 * mid-edit) renders nothing -- the offending step already carries its own inline error.
 */
export function FieldCoverage({
  rate,
  pending,
  pendingLabel = COVERAGE_PENDING_LABEL,
}: {
  /** This field's coverage, or `undefined` before the first sweep settles. */
  rate: FieldValueCoverage | undefined;
  /** Whether a recompute is in flight. Consulted only before the first result: it
   * drives the "Checking..." placeholder while `rate` is still `undefined`. Once a
   * rate exists it is shown across later recomputes with no staleness treatment --
   * the background sweep is debounced precisely so the readout does not flicker on
   * every keystroke. */
  pending: boolean;
  /** The pending-placeholder copy, provider-aware: the console passes
   * {@link CONSOLE_COVERAGE_PENDING_LABEL} because its sweep is a whole-file pass on
   * the appliance, not the near-instant local compute the default copy implies. */
  pendingLabel?: string;
}) {
  if (rate === undefined)
    return pending ? (
      <Text size="xs" c="dimmed" data-testid="coverage-pending">
        {pendingLabel}
      </Text>
    ) : null;

  if (rate.unavailable) return null;

  // An empty file has nothing to measure: "0 of 0 rows produce a value (0%)" would
  // read like the silent-empty alarm (which {@link formatRate} is careful never to
  // emit), so render nothing. Emptiness is conveyed upstream, not by this readout.
  if (rate.total === 0) return null;

  if (isSilentEmpty(rate))
    return (
      <Alert
        role="presentation"
        color="red"
        variant="light"
        icon={<IconAlertCircle size={16} aria-hidden />}
        data-testid="coverage-silent-empty"
        p="xs"
      >
        <Text size="xs">
          Across your whole file, <strong>no row</strong> produces a value for
          this field, so it cannot match. A cleaning step above is likely
          dropping every value -- check it before continuing.
        </Text>
      </Alert>
    );

  return (
    <Text size="xs" c="dimmed" data-testid="coverage-rate">
      Across your whole file: {formatRate(rate)}.
    </Text>
  );
}
