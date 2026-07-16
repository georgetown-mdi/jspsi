import { useMemo } from "react";

import {
  Badge,
  Group,
  Stack,
  Table,
  Text,
  Tooltip,
  VisuallyHidden,
} from "@mantine/core";

import {
  checkValueConstraints,
  readRowColumn,
  runPipeline,
  sanitizeForDisplay,
} from "@psilink/core";

import { isStepValid } from "@psi/standardizationAuthoring";

import type {
  CSVRow,
  FieldValue,
  LinkageField,
  StandardizationStep,
} from "@psilink/core";

/**
 * Row-sample size for the before->after preview: the first few rows with a non-empty
 * value for the field's input column. The preview is for inspecting the transform on
 * representative values, so a small fixed window keeps it cheap and legible; the
 * whole-file coverage question (does the transform collapse the field?) is answered
 * separately and exhaustively by the off-main-thread non-empty-rate aggregate
 * ({@link ../psi/nonEmptyAggregate}), not by widening this sample. Settled at 5,
 * coordinated with that aggregate and its row threshold.
 */
export const PREVIEW_SAMPLE_SIZE = 5;

/** Pick up to `limit` non-empty raw values for `inputColumn`, in row order. A row
 * whose value is missing or blank after trimming carries no signal for the
 * preview, so it is skipped rather than shown as an empty before->after pair. */
function sampleInputValues(
  rawRows: ReadonlyArray<CSVRow>,
  inputColumn: string,
  limit: number,
): Array<string> {
  const values: Array<string> = [];
  for (const row of rawRows) {
    // Read by own-property so a short row lacking the column reads as absent even
    // when the column is named an Object.prototype member (readRowColumn); a bare
    // row[inputColumn] would surface the inherited function past the check below.
    const raw = readRowColumn(row, inputColumn);
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
      {value === "" ? (
        // An empty string is NOT a drop: the pipeline returned a value, so it
        // becomes an (empty) PSI key and participates in matching. Render it
        // distinctly from the grey "dropped" chip so the operator does not read a
        // degenerate empty key as an excluded record.
        <Tooltip
          label="Cleaned to an empty value. It is not dropped -- it still participates in matching, as an empty key."
          multiline
          w={240}
        >
          <Badge
            variant="light"
            color="orange"
            role="img"
            aria-label="Cleaned to an empty value, which still participates in matching"
          >
            empty value
          </Badge>
        </Tooltip>
      ) : (
        <Badge
          variant="light"
          color="blue"
          styles={{ label: { textTransform: "none" } }}
        >
          {sanitizeForDisplay(value)}
        </Badge>
      )}
      {violations.map((violation) => (
        <Tooltip
          key={violation.kind}
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
 * reordering or editing a step re-runs the pipeline and the preview tracks it.
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
  rawRows: ReadonlyArray<CSVRow>;
  /** Override the provisional sample size (testing/aesthetics). */
  sampleSize?: number;
}) {
  const sample = useMemo(
    () => sampleInputValues(rawRows, inputColumn, sampleSize),
    [rawRows, inputColumn, sampleSize],
  );
  // Recompute the outcomes whenever the steps or sample change; `steps` is a new
  // array on every edit/reorder, so the pipeline re-runs and the preview tracks
  // the current pipeline order. A step the editor flags invalid is never compiled:
  // this guards two cases at once. A step factory can throw while a param is still
  // being authored (e.g. `pad_left` with no length yet) -- caught below; and an
  // in-dialect but over-length regex source, which `regexPatternSchema`'s length
  // cap rejects (so `isStepValid` is false) yet RE2 would still compile, paying the
  // super-linear-in-length compile cost the cap exists to bound, on the main thread
  // per keystroke. Gating on `isStepValid` keeps that paste off the compile path
  // (the throw-catch alone would not, since an oversized pattern does not throw).
  // Both cases show the same guidance; the offending step carries its own inline error.
  const rows = useMemo<Array<{
    raw: string;
    result: FieldValue;
  }> | null>(() => {
    if (!steps.every(isStepValid)) return null;
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
      <VisuallyHidden component="caption">
        A sample of your rows, before and after this field&apos;s cleaning
        steps.
      </VisuallyHidden>
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
