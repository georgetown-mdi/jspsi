import { useMemo, useState } from "react";

import { Button, Group, Paper, Stack, Text } from "@mantine/core";
import { IconAlertCircle, IconPlus } from "@tabler/icons-react";

import { SEMANTIC_TYPE_LABELS } from "@psi/metadataEditing";

import { DisclosureSection } from "@components/DisclosureSection";
import { StandardizationPreview } from "@components/StandardizationPreview";
import { StandardizationStepEditor } from "@components/StandardizationStepEditor";

import type {
  CSVRow,
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
 * Each card is collapsed by default to its semantic-type label, so a section of many
 * fields reads as a scannable index; expanding reveals the step editor, the coverage
 * readout (the host's {@link renderCoverage}, the silent-empty safety signal), and a
 * further-collapsible before/after sample preview. A silent-empty collapse
 * ({@link isFieldSilentEmpty}) is flagged in the collapsed header too, so the safety
 * signal is not hidden with the body. Add/remove-field affordances render only when
 * the matching callback is supplied (the inviter, in expert mode); the acceptor omits
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
  isFieldSilentEmpty,
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
  rawRows: Array<CSVRow>;
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
  /** Whether a field's whole-file coverage is a silent-empty collapse, so the card
   * shows a compact warning in its collapsed header (the body alarm renders through
   * {@link renderCoverage}). A predicate, not a node, for the same reason: the
   * worker-backed rates stay in the host. */
  isFieldSilentEmpty?: (output: string) => boolean;
  /** What to do when a transformation's output does not resolve to a declared field:
   * `"skip"` (the inviter -- a transformation bound to an ignored/non-matchable column
   * declares none) or `"throw"` (the acceptor -- every output is a declared field, so
   * a miss is an invariant violation, asserted as a check). No default: each host
   * declares intent. */
  onMissingField: "skip" | "throw";
}) {
  const fieldByName = useMemo(
    () => new Map(declaredFields.map((field) => [field.name, field])),
    [declaredFields],
  );

  // The operator's `role: linkage` columns per semantic type, in metadata order --
  // the columns a field of that type MAY bind to. Only a linkage column participates
  // in matching, so a column roled identifier/payload/ignored is never offered as a
  // match input the core would refuse. Built once per metadata so each card's input
  // options and the add-affordance check are lookups, not a metadata scan per card per
  // render.
  const columnsByType = useMemo(() => {
    // Keyed by the column's own (broader) semantic type; lookups by a field's
    // narrower linkage type are a subset, so non-linkage-typed entries are never read.
    const map = new Map<Metadata[number]["type"], Array<string>>();
    for (const column of metadata) {
      if (column.role !== "linkage") continue;
      const list = map.get(column.type);
      if (list === undefined) map.set(column.type, [column.name]);
      else list.push(column.name);
    }
    return map;
  }, [metadata]);
  // More than one column of a type makes the input column a real choice (and lets two
  // same-typed fields each take their own).
  const columnsForType = (type: LinkageField["type"]): Array<string> =>
    columnsByType.get(type) ?? [];

  // The rendered-card count per type, so the add control offers only a type with a
  // free column and the remove control appears only on a same-typed pair. Counted
  // over declared fields (one card each), so a transformation that declares no field
  // never inflates the tally past what is on screen.
  const boundByType = useMemo(() => {
    const counts = new Map<LinkageField["type"], number>();
    for (const transformation of standardization) {
      const field = fieldByName.get(transformation.output);
      if (field !== undefined)
        counts.set(field.type, (counts.get(field.type) ?? 0) + 1);
    }
    return counts;
  }, [standardization, fieldByName]);
  const addableTypes = useMemo(
    () =>
      onAddField === undefined
        ? []
        : [...boundByType.keys()].filter(
            (type) =>
              (columnsByType.get(type)?.length ?? 0) >
              (boundByType.get(type) ?? 0),
          ),
    [onAddField, boundByType, columnsByType],
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
            silentEmpty={isFieldSilentEmpty?.(transformation.output) ?? false}
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

/** One field's card: collapsed by default to its semantic-type label, so a long
 * list of fields reads as a scannable index. Expanding reveals the step editor, the
 * coverage readout, and a further-collapsible sample preview. When the field's
 * whole-file coverage is a silent-empty collapse, a compact warning is shown in the
 * collapsed header (the card's `summary`), so the safety signal is not buried while
 * the body is closed -- the full coverage alarm sits inside, and the editor-wide
 * live region announces it for assistive tech. The card header carries the type
 * label, so the step editor's own label is suppressed (`hideFieldLabel`). */
function StandardizationCard({
  field,
  inputColumn,
  steps,
  rawRows,
  inputColumnOptions,
  onInputColumnChange,
  onStepsChange,
  coverage,
  silentEmpty,
  onRemove,
}: {
  field: LinkageField;
  inputColumn: string;
  steps: Array<StandardizationStep>;
  rawRows: Array<CSVRow>;
  inputColumnOptions: Array<string>;
  onInputColumnChange: (column: string) => void;
  onStepsChange: (steps: Array<StandardizationStep>) => void;
  coverage: ReactNode;
  /** Whether this field's whole-file coverage is a silent-empty collapse; shown as a
   * compact warning in the collapsed card header so it is not hidden with the body. */
  silentEmpty: boolean;
  onRemove?: () => void;
}) {
  const [cardOpen, setCardOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  return (
    <Paper withBorder p="md">
      <DisclosureSection
        label={SEMANTIC_TYPE_LABELS[field.type]}
        open={cardOpen}
        onToggle={setCardOpen}
        toggleTestId="field-card-toggle"
        // Shown beside the label only while collapsed (DisclosureSection's summary
        // slot), so a silent-empty field is flagged without expanding the card. The
        // marker is inline (a span, not a block) so it nests validly in the summary's
        // text wrapper; it is aria-hidden because the editor-wide live region already
        // announces the collapse.
        summary={
          silentEmpty ? (
            <Text
              span
              c="red"
              fw={500}
              aria-hidden
              data-testid="field-card-coverage-warning"
            >
              <IconAlertCircle
                size={14}
                style={{ verticalAlign: "text-bottom" }}
                aria-hidden
              />{" "}
              No rows produce a value
            </Text>
          ) : undefined
        }
      >
        <Stack gap="sm" pt="sm">
          <StandardizationStepEditor
            fieldLabel={SEMANTIC_TYPE_LABELS[field.type]}
            hideFieldLabel
            inputColumn={inputColumn}
            steps={steps}
            inputColumnOptions={inputColumnOptions}
            onInputColumnChange={onInputColumnChange}
            onStepsChange={onStepsChange}
          />
          {/* Full-CSV coverage, visible once the card is open: the silent-empty
              safety net (also flagged in the collapsed card header). */}
          {coverage}
          {/* The before/after sample preview: a design-time aid, collapsed by default
              so an opened card stays compact. */}
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
      </DisclosureSection>
    </Paper>
  );
}
