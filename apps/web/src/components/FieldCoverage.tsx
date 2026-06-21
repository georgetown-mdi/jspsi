import { Alert, Text } from "@mantine/core";
import { IconAlertCircle } from "@tabler/icons-react";

import { isSilentEmpty } from "@psi/nonEmptyAggregate";

import type { FieldNonEmptyRate } from "@psi/nonEmptyAggregate";

/** Format the share of rows that produce a usable value. A non-zero rate that
 * rounds to 0% is shown as "<1%" rather than "0%", so the readout never reads like
 * the silent-empty alarm (a true 0%) when a few rows do produce a value. */
function formatRate(rate: FieldNonEmptyRate): string {
  const percent = rate.rate * 100;
  const shown = percent > 0 && percent < 1 ? "<1%" : `${Math.round(percent)}%`;
  return (
    `${rate.nonEmpty.toLocaleString()} of ${rate.total.toLocaleString()} ` +
    `rows produce a value (${shown})`
  );
}

/**
 * The per-field full-CSV coverage readout: the visible half of the silent-empty
 * defense. Computed over the WHOLE file (not the preview's row sample), so it sees
 * a collapse the sample cannot. When the field's transform drops every row
 * ({@link isSilentEmpty}) it shows a prominent alarm; otherwise it states the share
 * of rows that yield a usable value -- which, because the sweep observes empties,
 * rises when a `coalesce` fills blanks.
 *
 * The alarm here is `role="presentation"`: the assistive-tech announcement is made
 * once, for the whole editor, by {@link PrepareData}'s single coverage live region
 * (so N field cards do not each fire their own region). An `unavailable` rate (steps
 * left mid-edit) renders nothing -- the offending step already carries its own inline
 * error and a false 0% would be noise.
 */
export function FieldCoverage({
  rate,
  pending,
}: {
  /** This field's rate, or `undefined` before the first sweep settles. */
  rate: FieldNonEmptyRate | undefined;
  /** Whether a recompute is in flight (debounce pending or worker running). */
  pending: boolean;
}) {
  if (rate === undefined)
    return pending ? (
      <Text size="xs" c="dimmed" data-testid="coverage-pending">
        Checking how many of your rows produce a value...
      </Text>
    ) : null;

  if (rate.unavailable) return null;

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
