import { useState } from "react";

import { Button, Group, Paper, Stack } from "@mantine/core";
import { IconPlus } from "@tabler/icons-react";

import { SEMANTIC_TYPE_LABELS } from "@psi/metadataEditing";

import { DisclosureSection } from "@components/DisclosureSection";
import { StandardizationPreview } from "@components/StandardizationPreview";
import { StandardizationStepEditor } from "@components/StandardizationStepEditor";

import type {
  LinkageField,
  Metadata,
  Standardization,
  StandardizationStep,
} from "@psilink/core";
import type { ReactNode } from "react";

/**
 * The shared, presentational per-field cleaning card loop, used by BOTH the inviter's
 * advanced-options editor and the acceptor's "Prepare your data" screen. It holds NO
 * model state: it renders the effective {@link Standardization} the host passes and
 * emits each edit through GRANULAR, intent-shaped callbacks -- never a whole-array
 * `onChange`. That granularity is what lets the two hosts keep opposite data-flow
 * models behind one component: the inviter mutates `draft.standardization` directly,
 * the acceptor derives it from metadata and layers per-field overrides. The component
 * is blind to which.
 *
 * The load-bearing contract point: {@link onStepsChange} carries the transformation's
 * `input` column AS RENDERED (the effective, post-override binding), echoed back
 * unchanged. The acceptor's override layer detects a stale step-edit by comparing the
 * stored override's input against the current binding; passing any other notion of
 * input would silently drop the operator's edit on the next render.
 *
 * Each card stacks the step editor over an always-visible coverage readout (the
 * host's {@link renderCoverage}, the silent-empty safety signal) and a collapsible
 * sample before/after preview (a design-time aid, collapsed by default so a section
 * of many cards is not a wall). Add/remove-field affordances render only when the
 * matching callback is supplied (the inviter, in expert mode); the acceptor omits
 * them. The field LABEL is always the safe semantic-type label, never the
 * partner-controlled field name.
 */
export function StandardizationCards({
  standardization,
  declaredFields,
  metadata,
  rawRows,
  onStepsChange,
  onInputColumnChange,
  onAddField,
  onRemoveField,
  renderCoverage,
  onMissingField,
}: {
  /** The effective standardization: one transformation per declared field. */
  standardization: Standardization;
  /** The fields the standardization declares, for the type label, the preview's
   * constraint check, and the field resolved per card. MUST describe the same
   * effective binding as `metadata` (the host keeps them in sync upstream; the
   * component does not reconcile them). */
  declaredFields: Array<LinkageField>;
  /** The operator's column metadata, for the per-type input-column options. */
  metadata: Metadata;
  /** The parsed rows the preview samples. */
  rawRows: Array<Record<string, string>>;
  /** Emit a step edit: `output` names the field, `input` is the transformation's
   * input column AS RENDERED (echoed for the acceptor's stale-override check), and
   * `steps` is the next pipeline. */
  onStepsChange: (
    output: string,
    input: string,
    steps: Array<StandardizationStep>,
  ) => void;
  /** Rebind a field to a chosen input column (only offered when its type has more
   * than one `role: linkage` column). */
  onInputColumnChange: (output: string, column: string) => void;
  /** Append a same-typed field. Supplied by the inviter (expert mode) only; the
   * affordance renders only when this is present and a free column exists. The
   * behavior lives in the host (it mutates the host's authoritative array). */
  onAddField?: (type: LinkageField["type"]) => void;
  /** Remove an added same-typed field. Supplied by the inviter only; the affordance
   * renders only on a same-typed pair (never the recommended single field). */
  onRemoveField?: (output: string) => void;
  /** Render the per-card full-CSV coverage readout (the host owns `useNonEmptyRates`
   * and the editor-wide announcer; this is the visible per-card half). A render-prop,
   * not a boolean, so the worker-backed hook stays out of this presentational
   * component. */
  renderCoverage?: (output: string) => ReactNode;
  /** What to do when a transformation's output does not resolve to a declared field:
   * `"skip"` (the inviter -- a transformation bound to an ignored/non-matchable column
   * declares none) or `"throw"` (the acceptor -- every output is a declared field, so
   * a miss is an invariant violation, asserted as a check). No default: each host
   * declares intent. */
  onMissingField: "skip" | "throw";
}) {
  const fieldByName = new Map(
    declaredFields.map((field) => [field.name, field]),
  );

  // The operator's `role: linkage` columns of a semantic type, in metadata order --
  // the columns a field of that type MAY bind to. Only a linkage column participates
  // in matching, so a column roled identifier/payload/ignored is never offered as a
  // match input the core would refuse. More than one makes the input column a real
  // choice (and lets two same-typed fields each take their own).
  const columnsForType = (type: LinkageField["type"]): Array<string> =>
    metadata
      .filter((column) => column.role === "linkage" && column.type === type)
      .map((column) => column.name);

  // The rendered-card count per type, so the add control offers only a type with a
  // free column and the remove control appears only on a same-typed pair. Counted
  // over declared fields (one card each), so a transformation that declares no field
  // never inflates the tally past what is on screen.
  const boundByType = new Map<LinkageField["type"], number>();
  for (const transformation of standardization) {
    const field = fieldByName.get(transformation.output);
    if (field !== undefined)
      boundByType.set(field.type, (boundByType.get(field.type) ?? 0) + 1);
  }
  const addableTypes =
    onAddField === undefined
      ? []
      : [...boundByType.keys()].filter(
          (type) => columnsForType(type).length > (boundByType.get(type) ?? 0),
        );

  return (
    <Stack gap="sm">
      {standardization.map((transformation) => {
        const field = fieldByName.get(transformation.output);
        // A transformation bound to an ignored/non-matchable column declares no field.
        // The inviter skips it (no card); the acceptor asserts it cannot happen (its
        // standardization and fields both derive from the same linkageFields). The
        // message names no partner-controlled value (the output is partner-supplied).
        if (field === undefined) {
          if (onMissingField === "throw")
            throw new Error(
              "standardization output does not resolve to a declared linkage field",
            );
          return null;
        }
        const steps = transformation.steps ?? [];
        const siblingsOfType = boundByType.get(field.type) ?? 0;
        return (
          <StandardizationCard
            key={transformation.output}
            field={field}
            inputColumn={transformation.input}
            steps={steps}
            rawRows={rawRows}
            inputColumnOptions={columnsForType(field.type)}
            onInputColumnChange={(column) =>
              onInputColumnChange(transformation.output, column)
            }
            onStepsChange={(next) =>
              onStepsChange(transformation.output, transformation.input, next)
            }
            coverage={renderCoverage?.(transformation.output)}
            // Removing is offered only for an added same-typed field, so the
            // recommended single field per type cannot be removed by accident.
            onRemove={
              onRemoveField !== undefined && siblingsOfType > 1
                ? () => onRemoveField(transformation.output)
                : undefined
            }
          />
        );
      })}

      {addableTypes.length > 0 && (
        <Group gap="xs">
          {addableTypes.map((type) => (
            <Button
              key={type}
              variant="light"
              size="xs"
              leftSection={<IconPlus size={14} aria-hidden />}
              onClick={() => onAddField?.(type)}
            >
              Add another {SEMANTIC_TYPE_LABELS[type].toLowerCase()} field
            </Button>
          ))}
        </Group>
      )}
    </Stack>
  );
}

/** One field's card: the step editor, the always-visible coverage readout, and a
 * collapsible sample preview. The preview holds no focusable controls, so its
 * collapse cannot strand focus; the always-visible coverage above it is the
 * silent-empty safety signal regardless of the preview's state. */
function StandardizationCard({
  field,
  inputColumn,
  steps,
  rawRows,
  inputColumnOptions,
  onInputColumnChange,
  onStepsChange,
  coverage,
  onRemove,
}: {
  field: LinkageField;
  inputColumn: string;
  steps: Array<StandardizationStep>;
  rawRows: Array<Record<string, string>>;
  inputColumnOptions: Array<string>;
  onInputColumnChange: (column: string) => void;
  onStepsChange: (steps: Array<StandardizationStep>) => void;
  coverage: ReactNode;
  onRemove?: () => void;
}) {
  const [previewOpen, setPreviewOpen] = useState(false);
  return (
    <Paper withBorder p="md">
      <Stack gap="sm">
        <StandardizationStepEditor
          fieldLabel={SEMANTIC_TYPE_LABELS[field.type]}
          inputColumn={inputColumn}
          steps={steps}
          inputColumnOptions={inputColumnOptions}
          onInputColumnChange={onInputColumnChange}
          onStepsChange={onStepsChange}
        />
        {/* Always-visible full-CSV coverage: the silent-empty safety net. */}
        {coverage}
        {/* The before/after sample preview: a design-time aid, collapsed by default
            so a section of many cards stays compact. */}
        <DisclosureSection
          label="Preview a sample of your rows"
          open={previewOpen}
          onToggle={setPreviewOpen}
        >
          <StandardizationPreview
            field={field}
            inputColumn={inputColumn}
            steps={steps}
            rawRows={rawRows}
          />
        </DisclosureSection>
        {onRemove !== undefined && (
          <Group justify="flex-end">
            <Button variant="subtle" color="red" size="xs" onClick={onRemove}>
              Remove this field
            </Button>
          </Group>
        )}
      </Stack>
    </Paper>
  );
}
