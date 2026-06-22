import { Stack, Text } from "@mantine/core";

import { sanitizeForDisplay } from "@psilink/core";

import { StepListEditor } from "@components/StepListEditor";

import type { StandardizationStep } from "@psilink/core";

/**
 * The per-field standardization step editor: one card holding an ordered, editable
 * list of the cleaning steps applied to one linkage field, plus the input-column
 * header. The one-card-per-field layout makes per-output uniqueness structural --
 * each card edits exactly one field's transformation, so two cards can never name
 * the same `output`.
 *
 * A thin wrapper over {@link StepListEditor}, which owns the step-editing UX
 * (descriptor-driven typed param inputs, keyboard reorder/remove, the grouped add
 * menu) shared with the expert linkage-terms transform editor. This component adds
 * only the standardization framing: the field label and the column the pipeline
 * reads. Presentational -- it holds no step state of its own; it renders `steps`
 * and emits the next array through {@link onStepsChange}, so the host owns the
 * model and decides what an edit means (the host docks the
 * {@link StandardizationPreview} beside this card).
 */
export function StandardizationStepEditor({
  fieldLabel,
  inputColumn,
  steps,
  onStepsChange,
}: {
  /** Human-readable label for the field this pipeline produces (a safe
   * semantic-type label, never the partner-controlled field name). */
  fieldLabel: string;
  /** The operator's own input column the pipeline reads. */
  inputColumn: string;
  /** The ordered pipeline steps. */
  steps: Array<StandardizationStep>;
  /** Emit the next step array on any add, remove, reorder, or param edit. */
  onStepsChange: (steps: Array<StandardizationStep>) => void;
}) {
  return (
    <Stack gap="xs">
      <div>
        <Text size="sm" fw={600}>
          {fieldLabel}
        </Text>
        <Text size="xs" c="dimmed">
          from your column {sanitizeForDisplay(inputColumn)}
        </Text>
      </div>

      <StepListEditor steps={steps} onStepsChange={onStepsChange} />
    </Stack>
  );
}
