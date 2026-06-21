import { useMemo } from "react";

import { Badge, Group, Stack, Table, Text, Tooltip } from "@mantine/core";

import { runPipeline, sanitizeForDisplay } from "@psilink/core";

import { checkValueConstraints } from "@psi/standardizationAuthoring";

import type {
  FieldValue,
  LinkageField,
  StandardizationStep,
} from "@psilink/core";

/**
 * Provisional row-sample size for the before->after preview: the first few rows
 * with a non-empty value for the field's input column. Slice 3 settles the sample
 * size empirically (coordinated with the full-CSV non-empty-rate aggregate and the
 * off-main-thread threshold); until then a small fixed window keeps the preview
 * cheap and legible.
 */
export const PREVIEW_SAMPLE_SIZE = 5;

/** Pick up to `limit` non-empty raw values for `inputColumn`, in row order. A row
 * whose value is missing or blank after trimming carries no signal for the
 * preview, so it is skipped rather than shown as an empty before->after pair. */
function sampleInputValues(
  rawRows: ReadonlyArray<Record<string, string>>,
  inputColumn: string,
  limit: number,
): Array<string> {
  const values: Array<string> = [];
  for (const row of rawRows) {
    // `Record<string, string>` types a missing column as `string`, but a row may
    // lack the column; widen so the absence check is honest.
    const raw = row[inputColumn] as string | undefined;
    if (raw !== undefined && raw.trim() !== "") {
      values.push(raw);
      if (values.length >= limit) break;
    }
  }
  return values;
}

/** Render one cleaned value as a chip with any warn-not-enforce constraint badges
 * beside it. The value is the operator's own data (local CSV), shown sanitized for
 * uniformity with the rest of the app's value display. */
function CleanedValue({
  field,
  value,
}: {
  field: LinkageField;
  value: string;
}) {
  const violations = checkValueConstraints(field, value);
  return (
    <Group gap={4} wrap="wrap">
      <Badge
        variant="light"
        color="blue"
        styles={{ label: { textTransform: "none" } }}
      >
        {sanitizeForDisplay(value) || "(empty)"}
      </Badge>
      {violations.map((violation) => (
        <Tooltip
          key={violation.label}
          label={violation.detail}
          multiline
          w={220}
        >
          <Badge
            variant="light"
            color="yellow"
            role="img"
            aria-label={`Constraint warning: ${violation.detail}`}
          >
            {violation.label}
          </Badge>
        </Tooltip>
      ))}
    </Group>
  );
}

/** Render a pipeline outcome distinctly by its three shapes: a single value, a
 * dropped (null) chip, or a fan-out into several candidate values (a Set). */
function Outcome({
  field,
  result,
}: {
  field: LinkageField;
  result: string | null | Set<string>;
}) {
  if (result === null)
    return (
      <Badge variant="light" color="gray" data-testid="outcome-dropped">
        dropped
      </Badge>
    );
  if (result instanceof Set) {
    const values = [...result];
    return (
      <Stack gap={2} data-testid="outcome-fanout">
        <Text size="xs" c="dimmed">
          splits into {values.length} value{values.length === 1 ? "" : "s"}
        </Text>
        <Group gap={4} wrap="wrap">
          {values.map((value) => (
            <CleanedValue key={value} field={field} value={value} />
          ))}
        </Group>
      </Stack>
    );
  }
  return (
    <span data-testid="outcome-value">
      <CleanedValue field={field} value={result} />
    </span>
  );
}

/**
 * The before->after value preview for one field's standardization pipeline, docked
 * beside its step list. Runs the operator's CURRENT steps over a small sample of
 * the field's input column ({@link sampleInputValues}) and renders each row's
 * outcome distinctly by its three pipeline shapes -- a cleaned value, a "dropped"
 * (null) chip, or a fan-out into several candidates (a Set) -- so the operator sees
 * exactly what each step does to real rows, in pipeline order. A value that does
 * not meet the field's declared constraints is flagged with a warn-not-enforce
 * badge ({@link checkValueConstraints}); the badge surfaces the violation without
 * blocking.
 *
 * Pure over its inputs: it derives the sample and runs core's `runPipeline`, so
 * reordering or editing a step re-runs the pipeline and the preview tracks it. The
 * sample size is provisional ({@link PREVIEW_SAMPLE_SIZE}); Slice 3 settles it.
 */
export function StandardizationPreview({
  field,
  inputColumn,
  steps,
  rawRows,
  sampleSize = PREVIEW_SAMPLE_SIZE,
}: {
  /** The linkage field this pipeline produces, for the constraint check. */
  field: LinkageField;
  /** The raw input column the field's transformation reads. */
  inputColumn: string;
  /** The current pipeline steps, in order. */
  steps: Array<StandardizationStep>;
  /** The parsed CSV rows the sample is drawn from. */
  rawRows: ReadonlyArray<Record<string, string>>;
  /** Override the provisional sample size (testing/aesthetics). */
  sampleSize?: number;
}) {
  const sample = useMemo(
    () => sampleInputValues(rawRows, inputColumn, sampleSize),
    [rawRows, inputColumn, sampleSize],
  );
  // Recompute the outcomes whenever the steps or sample change; `steps` is a new
  // array on every edit/reorder, so the pipeline re-runs and the preview tracks
  // the current pipeline order. A step factory can throw while a param is still
  // being authored (e.g. `pad_left` with no length yet), so compile/run is guarded
  // and an incomplete pipeline shows guidance rather than crashing the preview --
  // the offending step's own typed input already carries the inline error.
  const rows = useMemo<Array<{
    raw: string;
    result: FieldValue;
  }> | null>(() => {
    try {
      return sample.map((raw) => ({ raw, result: runPipeline(raw, steps) }));
    } catch {
      return null;
    }
  }, [sample, steps]);

  if (rows === null)
    return (
      <Text size="sm" c="dimmed">
        Finish configuring the steps above to see the preview.
      </Text>
    );

  if (rows.length === 0)
    return (
      <Text size="sm" c="dimmed">
        No sample values in this column to preview.
      </Text>
    );

  return (
    <Table verticalSpacing="xs" withRowBorders={false}>
      <Table.Thead>
        <Table.Tr>
          <Table.Th scope="col">Original</Table.Th>
          <Table.Th scope="col">Cleaned</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {rows.map(({ raw, result }, index) => (
          <Table.Tr key={`${index}-${raw}`}>
            <Table.Td>
              <Text size="sm" style={{ wordBreak: "break-word" }}>
                {sanitizeForDisplay(raw)}
              </Text>
            </Table.Td>
            <Table.Td>
              <Outcome field={field} result={result} />
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}
