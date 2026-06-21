import { Alert, Text } from "@mantine/core";
import { IconAlertCircle } from "@tabler/icons-react";

import { isSilentEmpty } from "@psi/nonEmptyAggregate";

import type { FieldValueCoverage } from "@psi/nonEmptyAggregate";

/** Format the share of rows that produce a key. A non-zero rate that rounds to 0% is
 * shown as "<1%" rather than "0%", so the readout never reads like the silent-empty
 * alarm (a true 0%) when a few rows do produce a value. */
function formatRate(coverage: FieldValueCoverage): string {
  const percent = coverage.rate * 100;
  const shown = percent > 0 && percent < 1 ? "<1%" : `${Math.round(percent)}%`;
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
 * for the whole editor, by {@link PrepareData}'s coverage live region (so N field
 * cards do not each fire their own region). An `unavailable` rate (steps left
 * mid-edit) renders nothing -- the offending step already carries its own inline error.
 */
export function FieldCoverage({
  rate,
  pending,
}: {
  /** This field's coverage, or `undefined` before the first sweep settles. */
  rate: FieldValueCoverage | undefined;
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
