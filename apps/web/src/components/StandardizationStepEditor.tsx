import { useEffect, useRef, useState } from "react";

import { Select, Stack, Text, VisuallyHidden } from "@mantine/core";

import { sanitizeForDisplay } from "@psilink/core";

import { functionDisplay } from "@psi/standardizationAuthoring";

import { StepListEditor } from "@components/StepListEditor";

import type { StandardizationStep } from "@psilink/core";

/** Debounce (ms) before the step-list summary is announced to assistive tech, so a
 * burst of add/remove/reorder edits announces once rather than on every action. The
 * visible list updates synchronously; only the announcement is debounced. Matches
 * the metadata grid's announce debounce. */
const STEP_ANNOUNCE_DEBOUNCE_MS = 600;

/**
 * The per-field standardization step editor: one card holding an ordered, editable
 * list of the cleaning steps applied to one linkage field, plus the input-column
 * header. The one-card-per-field layout makes per-output uniqueness structural --
 * each card edits exactly one field's transformation, so two cards can never name
 * the same `output`.
 *
 * The step-editing UX (descriptor-driven typed param inputs, keyboard reorder/remove
 * with focus restoration, the grouped add menu) lives in {@link StepListEditor},
 * shared with the expert linkage-terms transform editor so the two cannot drift.
 * This component adds the standardization framing -- the field label, the column the
 * pipeline reads, and a debounced live-region summary of the step list (an
 * announcement specific to this per-party data-prep surface, not the shared editor).
 * Presentational -- it holds no step state of its own; it renders `steps` and emits
 * the next array through {@link onStepsChange}, so the host owns the model and
 * decides what an edit means (the host docks the `StandardizationPreview` beside it).
 */
export function StandardizationStepEditor({
  fieldLabel,
  hideFieldLabel = false,
  inputColumn,
  steps,
  onStepsChange,
  inputColumnOptions,
  onInputColumnChange,
}: {
  /** Human-readable label for the field this pipeline produces (a safe
   * semantic-type label, never the partner-controlled field name). */
  fieldLabel: string;
  /** Suppress the in-card field-label line. Set when the host wraps this editor in a
   * collapsible card whose header already carries the label (see the per-field card
   * in {@link StandardizationCards}), so it is not shown twice. Defaults to showing
   * it (the standalone layout). */
  hideFieldLabel?: boolean;
  /** The operator's own input column the pipeline reads. */
  inputColumn: string;
  /** The ordered pipeline steps. */
  steps: Array<StandardizationStep>;
  /** Emit the next step array on any add, remove, reorder, or param edit. */
  onStepsChange: (steps: Array<StandardizationStep>) => void;
  /** The columns this field MAY bind to -- the operator's `role: linkage` columns
   * of the field's semantic type. When more than one is offered and
   * {@link onInputColumnChange} is set, the input column becomes a selectable
   * control (so two fields of one type can take distinct columns); otherwise the
   * single bound column is shown read-only. */
  inputColumnOptions?: Array<string>;
  /** Rebind this field to the chosen input column. Omitted where binding is fixed. */
  onInputColumnChange?: (column: string) => void;
}) {
  // Announce the step-list summary on a debounce: a burst of add/remove/reorder
  // edits announces once, not per action, and a reorder (which leaves the count
  // unchanged) is still announced because the summary names the steps in order. The
  // visible list is not debounced. Only a CHANGE is announced, never the initial
  // pipeline (each field card seeds one, so a mount-time announcement would be a
  // chorus) -- comparing against the last announced summary rather than a first-run
  // flag stays correct under StrictMode's double-invoked mount effect. The timer is
  // cleared on every change and unmount so none leaks.
  const stepSummary =
    steps.length === 0
      ? "No cleaning steps; values are used as-is."
      : `${steps.length} cleaning step${steps.length === 1 ? "" : "s"}: ${steps
          .map((step) => functionDisplay(step.function).label)
          .join(", ")}.`;
  const [stepAnnouncement, setStepAnnouncement] = useState("");
  const lastAnnouncedRef = useRef(stepSummary);
  useEffect(() => {
    if (stepSummary === lastAnnouncedRef.current) return;
    const handle = setTimeout(() => {
      lastAnnouncedRef.current = stepSummary;
      setStepAnnouncement(stepSummary);
    }, STEP_ANNOUNCE_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [stepSummary]);

  return (
    <Stack gap="xs">
      <div>
        {!hideFieldLabel && (
          <Text size="sm" fw={600}>
            {fieldLabel}
          </Text>
        )}
        {onInputColumnChange !== undefined &&
        (inputColumnOptions?.length ?? 0) > 1 ? (
          // More than one of the operator's columns has this field's type, so the
          // binding is a real choice: let the operator pick which column feeds this
          // field. This is what gives two same-typed fields distinct columns (the
          // default binds both to the first). Column names are the operator's own
          // CSV headers; the value stays raw (it must match for the binding) while
          // the visible label is sanitized, matching this surface's display rule.
          <Select
            size="xs"
            label="Column to clean"
            data={(inputColumnOptions ?? []).map((column) => ({
              value: column,
              label: sanitizeForDisplay(column),
            }))}
            value={inputColumn}
            allowDeselect={false}
            onChange={(next) => next !== null && onInputColumnChange(next)}
          />
        ) : (
          <Text size="xs" c="dimmed">
            from your column {sanitizeForDisplay(inputColumn)}
          </Text>
        )}
      </div>

      <StepListEditor
        steps={steps}
        onStepsChange={onStepsChange}
        // The per-party cleaning surface: raw patterns are authorable here, local to
        // this party and changing only its own match rate. The cross-party
        // element-transform editor does NOT use this component -- it drives
        // StepListEditor directly and omits allowRawPatterns, so a token-embedded
        // (partner-authored) regex stays read-only.
        allowRawPatterns
      />

      {/* One polite, atomic live region for this field's step list: announces the
          debounced summary after an add, remove, or reorder, never the whole card
          per keystroke. */}
      <VisuallyHidden role="status" aria-live="polite" aria-atomic="true">
        {stepAnnouncement}
      </VisuallyHidden>
    </Stack>
  );
}
