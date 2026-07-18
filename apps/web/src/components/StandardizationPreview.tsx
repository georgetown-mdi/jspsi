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
  runPipeline,
  sanitizeForDisplay,
} from "@psilink/core";

import { isStepValid } from "@psi/standardizationAuthoring";

import type { ColumnSamples } from "@psi/columnSamples";

import type {
  FieldValue,
  LinkageField,
  StandardizationStep,
} from "@psilink/core";

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
 * beside its step list. Runs the operator's CURRENT steps over the field's input
 * column's preview sample (looked up from {@link ColumnSamples}) and renders each
 * row's outcome distinctly by its three pipeline shapes -- a cleaned value, a
 * "dropped" (null) chip, or a fan-out into several candidates (a Set) -- so the
 * operator sees exactly what each step does to real rows, in pipeline order. A value
 * that does not meet the field's declared constraints is flagged with a
 * warn-not-enforce badge ({@link checkValueConstraints}); the badge surfaces the
 * violation without blocking.
 *
 * The sample is passed in, not derived from rows, so the console (which never holds
 * the rows) can feed the same map from its server-side profile. Pure over its inputs:
 * it runs core's `runPipeline`, so reordering or editing a step re-runs the pipeline
 * and the preview tracks it.
 */
export function StandardizationPreview({
  field,
  inputColumn,
  steps,
  columnSamples,
}: {
  /** The linkage field this pipeline produces, for the constraint check. */
  field: LinkageField;
  /** The raw input column the field's transformation reads. */
  inputColumn: string;
  /** The current pipeline steps, in order. */
  steps: Array<StandardizationStep>;
  /** The per-column preview samples; the field's `inputColumn` entry is sampled. */
  columnSamples: ColumnSamples;
}) {
  const sample = useMemo(
    () => columnSamples.get(inputColumn) ?? [],
    [columnSamples, inputColumn],
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
