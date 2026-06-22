import { Button, Grid, Group, Paper, Stack, Text } from "@mantine/core";
import { IconPlus } from "@tabler/icons-react";

import { SEMANTIC_TYPE_LABELS } from "@psi/metadataEditing";

import { StandardizationPreview } from "@components/StandardizationPreview";
import { StandardizationStepEditor } from "@components/StandardizationStepEditor";

import type {
  LinkageField,
  Metadata,
  Standardization,
  StandardizationStep,
} from "@psilink/core";

/**
 * The role-agnostic per-party standardization workbench: an ordered, editable card
 * per field-cleaning transformation, each pairing the shared
 * {@link StandardizationStepEditor} (cleaning steps + input-column binding) with a
 * live {@link StandardizationPreview} over a sample of the operator's rows. Shared
 * by the acceptor's "Prepare your data" editor's intent and hosted here by the
 * inviter's Advanced-options editor.
 *
 * It edits the effective {@link Standardization} directly (the host owns the model
 * and re-derives the declared fields from it via `authoredLinkageFields`). The
 * input-column binding is what lets two transformations of one semantic type take
 * DISTINCT columns -- the "add another field" control appends a transformation bound
 * to the next free column of a type that has one, declaring a second same-typed
 * field (e.g. a maiden and a current name). Removing a field drops its transformation;
 * a key that referenced it then reports unsatisfiable through the host's badges
 * rather than silently mis-binding.
 *
 * The field LABEL is the safe semantic-type label, never the field name (which the
 * inviter authors and the partner sees in the terms); two same-typed fields show the
 * same label and are told apart by their bound column.
 */
export function StandardizationWorkbench({
  standardization,
  declaredFields,
  metadata,
  rawRows,
  onChange,
}: {
  /** The effective standardization: one transformation per declared field. */
  standardization: Standardization;
  /** The fields the standardization declares (host's `authoredLinkageFields`
   * output), for each transformation's type label, constraint check, and the field
   * the preview validates against. */
  declaredFields: Array<LinkageField>;
  /** The operator's column metadata, for the per-type input-column options. */
  metadata: Metadata;
  /** The parsed rows the preview samples. */
  rawRows: Array<Record<string, string>>;
  /** Emit the next standardization on any step, binding, add, or remove edit. */
  onChange: (next: Standardization) => void;
}) {
  const fieldByName = new Map(
    declaredFields.map((field) => [field.name, field]),
  );
  // A transformation's declared field, or undefined when it declares none (its
  // input column is ignored/absent or a non-matchable type, so authoredLinkageFields
  // emitted no field and it renders no card). Keying the counts below on this -- not
  // on the raw column type -- keeps the component's internal tallies equal to what it
  // actually renders, and yields a `LinkageField["type"]` with no cast.
  const fieldForTransform = (output: string): LinkageField | undefined =>
    fieldByName.get(output);

  // The operator's non-ignored columns of a semantic type, in metadata order -- the
  // columns a field of that type MAY bind to. More than one makes the input column a
  // real choice (and lets two same-typed fields each take their own).
  const columnsForType = (type: LinkageField["type"]): Array<string> =>
    metadata
      .filter((column) => column.role !== "ignored" && column.type === type)
      .map((column) => column.name);

  const setSteps = (output: string, steps: Array<StandardizationStep>) =>
    onChange(
      standardization.map((t) => (t.output === output ? { ...t, steps } : t)),
    );

  const setInputColumn = (output: string, column: string) =>
    onChange(
      standardization.map((t) =>
        t.output === output ? { ...t, input: column } : t,
      ),
    );

  const removeField = (output: string) =>
    onChange(standardization.filter((t) => t.output !== output));

  // Append a transformation for `type`, bound to its first column not already bound
  // by another transformation, named uniquely off the type's first field and carrying
  // that field's current cleaning steps (so the second field starts from the same
  // recommended pipeline). The caller only offers this when a free column exists.
  const addFieldForType = (type: LinkageField["type"]) => {
    const bound = new Set(standardization.map((t) => t.input));
    const freeColumn = columnsForType(type).find((c) => !bound.has(c));
    if (freeColumn === undefined) return;
    const sibling = standardization.find(
      (t) => fieldForTransform(t.output)?.type === type,
    );
    const base = sibling?.output ?? type;
    const taken = new Set(standardization.map((t) => t.output));
    let n = 2;
    let output = `${base}_${n}`;
    while (taken.has(output)) output = `${base}_${++n}`;
    onChange([
      ...standardization,
      { output, input: freeColumn, steps: sibling?.steps ?? [] },
    ]);
  };

  // The rendered-card count per type, so the add control offers only a type with a
  // column still free to bind and the remove control appears only on a same-typed
  // pair. Counted over declared fields (one card each), so a transformation that
  // declares no field -- ignored/non-matchable input column -- never inflates the
  // tally past what is on screen.
  const boundByType = new Map<LinkageField["type"], number>();
  for (const t of standardization) {
    const field = fieldForTransform(t.output);
    if (field !== undefined)
      boundByType.set(field.type, (boundByType.get(field.type) ?? 0) + 1);
  }
  const addableTypes = [...boundByType.keys()].filter(
    (type) => columnsForType(type).length > (boundByType.get(type) ?? 0),
  );

  return (
    <Stack gap="sm">
      {standardization.map((transformation) => {
        const field = fieldByName.get(transformation.output);
        // A transformation bound to an ignored/non-matchable column declares no
        // field (authoredLinkageFields skips it); it has no card here.
        if (field === undefined) return null;
        const steps = transformation.steps ?? [];
        const siblingsOfType = boundByType.get(field.type) ?? 0;
        return (
          <Paper withBorder p="md" key={transformation.output}>
            <Stack gap="sm">
              <Grid gap="lg" align="flex-start">
                <Grid.Col span={{ base: 12, md: 7 }}>
                  <StandardizationStepEditor
                    fieldLabel={SEMANTIC_TYPE_LABELS[field.type]}
                    inputColumn={transformation.input}
                    steps={steps}
                    inputColumnOptions={columnsForType(field.type)}
                    onInputColumnChange={(column) =>
                      setInputColumn(transformation.output, column)
                    }
                    onStepsChange={(next) =>
                      setSteps(transformation.output, next)
                    }
                  />
                </Grid.Col>
                <Grid.Col span={{ base: 12, md: 5 }}>
                  <Text size="xs" fw={600} mb="xs">
                    Preview
                  </Text>
                  <StandardizationPreview
                    field={field}
                    inputColumn={transformation.input}
                    steps={steps}
                    rawRows={rawRows}
                  />
                </Grid.Col>
              </Grid>
              {/* Removing is offered only for an added same-typed field (more than
                  one of this type), so the recommended single field per type cannot
                  be removed by accident, leaving its key unsatisfiable. */}
              {siblingsOfType > 1 && (
                <Group justify="flex-end">
                  <Button
                    variant="subtle"
                    color="red"
                    size="xs"
                    onClick={() => removeField(transformation.output)}
                  >
                    Remove this field
                  </Button>
                </Group>
              )}
            </Stack>
          </Paper>
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
              onClick={() => addFieldForType(type)}
            >
              Add another {SEMANTIC_TYPE_LABELS[type].toLowerCase()} field
            </Button>
          ))}
        </Group>
      )}
    </Stack>
  );
}
