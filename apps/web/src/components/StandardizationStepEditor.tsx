import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Menu,
  NumberInput,
  Paper,
  Select,
  Stack,
  TagsInput,
  Text,
  TextInput,
} from "@mantine/core";
import {
  IconArrowDown,
  IconArrowUp,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";

import { sanitizeForDisplay } from "@psilink/core";

import {
  STANDARDIZATION_FUNCTION_GROUPS,
  describeParamFields,
  descriptorFor,
  functionDisplay,
  validateParamValue,
} from "@psi/standardizationAuthoring";

import type {
  StandardizationFunctionDescriptor,
  StandardizationStep,
} from "@psilink/core";

import type { ParamField } from "@psi/standardizationAuthoring";

/** Build a step's initial params from its descriptor: every param that declares a
 * default is seeded with it (so a `parse_date` opens on `MM/DD/YYYY`, a `phonetic`
 * on `soundex`); a param with no default is left unset for the operator to fill. A
 * step with no seeded params omits the `params` key entirely, matching the shape
 * core's own default pipelines use. */
function newStep(functionName: string): StandardizationStep {
  const descriptor = descriptorFor(functionName);
  const params: Record<string, unknown> = {};
  if (descriptor !== undefined)
    for (const field of describeParamFields(descriptor))
      if (field.defaultValue !== undefined)
        params[field.key] = field.defaultValue;
  return Object.keys(params).length > 0
    ? { function: functionName, params }
    : { function: functionName };
}

/** A single typed parameter input, rendered as the widget kind the descriptor
 * declares (a number, a select, a tag list, or text) and validated against the
 * descriptor's own schema so an out-of-type value surfaces an inline error -- never
 * a raw, untyped text box. */
function ParamInput({
  descriptor,
  paramField,
  value,
  onChange,
}: {
  descriptor: StandardizationFunctionDescriptor;
  paramField: ParamField;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const isEmpty =
    value === undefined ||
    value === "" ||
    (Array.isArray(value) && value.length === 0);
  // An unset optional param is fine; anything else is validated against the
  // descriptor's declared type, so the control accepts or rejects exactly what core
  // would.
  const validation =
    paramField.optional && isEmpty
      ? { ok: true as const }
      : validateParamValue(descriptor, paramField.key, value);
  const error = validation.ok ? undefined : validation.message;
  const common = {
    label: paramField.label,
    error,
    errorProps: { role: "alert" as const },
    size: "xs" as const,
  };

  switch (paramField.kind) {
    case "number":
      return (
        <NumberInput
          {...common}
          value={value as number | string | undefined}
          onChange={(next) => onChange(next)}
          allowDecimal={false}
        />
      );
    case "enum":
      return (
        <Select
          {...common}
          data={paramField.enumOptions ?? []}
          value={(value as string | undefined) ?? null}
          allowDeselect={false}
          onChange={(next) => next !== null && onChange(next)}
        />
      );
    case "stringArray":
      return (
        <TagsInput
          {...common}
          value={(value as Array<string> | undefined) ?? []}
          onChange={(next) => onChange(next)}
          placeholder="Type a value and press Enter"
        />
      );
    default:
      return (
        <TextInput
          {...common}
          value={(value as string | undefined) ?? ""}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      );
  }
}

/** One step row: its plain-language function label, typed param inputs (or a
 * read-only note for the deferred raw-pattern tier), and reorder/remove controls. */
function StepRow({
  step,
  index,
  count,
  onParam,
  onMove,
  onRemove,
}: {
  step: StandardizationStep;
  index: number;
  count: number;
  onParam: (key: string, value: unknown) => void;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
}) {
  const descriptor = descriptorFor(step.function);
  const { label } = functionDisplay(step.function);
  // The raw-pattern family (`tier: "regex"`) and any unrecognized function are
  // shown read-only: authoring a raw pattern from scratch is the deferred expert
  // tier (board item 202533670). A default pipeline's existing regex steps still
  // render here and stay reorderable and removable -- only their pattern is not
  // editable in this slice. `editableDescriptor` narrows to the standard-tier
  // descriptor (or undefined), so the typed param branch passes a non-optional one.
  const editableDescriptor =
    descriptor !== undefined && descriptor.tier === "standard"
      ? descriptor
      : undefined;

  return (
    <Paper withBorder p="xs" component="li">
      <Group justify="space-between" wrap="nowrap" align="flex-start">
        <Stack gap="xs" style={{ flex: 1, minWidth: 0 }}>
          <Group gap="xs">
            <Text size="sm" fw={500}>
              {label}
            </Text>
            {editableDescriptor === undefined && (
              <Badge size="xs" variant="light" color="gray">
                advanced
              </Badge>
            )}
          </Group>
          {editableDescriptor !== undefined
            ? describeParamFields(editableDescriptor).map((paramField) => (
                <ParamInput
                  key={paramField.key}
                  descriptor={editableDescriptor}
                  paramField={paramField}
                  value={step.params?.[paramField.key]}
                  onChange={(value) => onParam(paramField.key, value)}
                />
              ))
            : Object.entries(step.params ?? {}).map(([key, raw]) => (
                <Text key={key} size="xs" c="dimmed" ff="monospace">
                  {sanitizeForDisplay(`${key}: ${describeReadonlyParam(raw)}`)}
                </Text>
              ))}
        </Stack>
        <Group gap={2} wrap="nowrap">
          <ActionIcon
            variant="subtle"
            disabled={index === 0}
            onClick={() => onMove(-1)}
            aria-label={`Move ${label} earlier`}
          >
            <IconArrowUp size={16} />
          </ActionIcon>
          <ActionIcon
            variant="subtle"
            disabled={index === count - 1}
            onClick={() => onMove(1)}
            aria-label={`Move ${label} later`}
          >
            <IconArrowDown size={16} />
          </ActionIcon>
          <ActionIcon
            variant="subtle"
            color="red"
            onClick={onRemove}
            aria-label={`Remove ${label}`}
          >
            <IconTrash size={16} />
          </ActionIcon>
        </Group>
      </Group>
    </Paper>
  );
}

/** Render a read-only param value for the deferred-tier note. Best-effort: a
 * structured value is JSON-encoded; the caller sanitizes the whole line. */
function describeReadonlyParam(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

/**
 * The per-field standardization step editor: one card holding an ordered, editable
 * list of the cleaning steps applied to one linkage field, plus a grouped menu for
 * adding a step. The one-card-per-field layout makes per-output uniqueness
 * structural -- each card edits exactly one field's transformation, so two cards
 * can never name the same `output`.
 *
 * Steps are added from {@link STANDARDIZATION_FUNCTION_GROUPS} (the standard tier,
 * grouped by intent), removed, and reordered; their params render as typed inputs
 * driven by the descriptor table. Presentational -- it holds no step state of its
 * own; it renders `steps` and emits the next array through {@link onStepsChange},
 * so the host owns the model and decides what an edit means (the host docks the
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
  const addStep = (functionName: string) =>
    onStepsChange([...steps, newStep(functionName)]);

  const removeStep = (index: number) =>
    onStepsChange(steps.filter((_, i) => i !== index));

  const moveStep = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= steps.length) return;
    const next = [...steps];
    [next[index], next[target]] = [next[target], next[index]];
    onStepsChange(next);
  };

  const setParam = (index: number, key: string, value: unknown) =>
    onStepsChange(
      steps.map((step, i) =>
        i === index
          ? { ...step, params: { ...step.params, [key]: value } }
          : step,
      ),
    );

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

      {steps.length === 0 ? (
        <Text size="xs" c="dimmed">
          No steps: the value is used as-is. Add a step to clean it.
        </Text>
      ) : (
        <Stack
          gap="xs"
          component="ol"
          style={{ listStyle: "none", padding: 0, margin: 0 }}
        >
          {steps.map((step, index) => (
            <StepRow
              key={index}
              step={step}
              index={index}
              count={steps.length}
              onParam={(key, value) => setParam(index, key, value)}
              onMove={(direction) => moveStep(index, direction)}
              onRemove={() => removeStep(index)}
            />
          ))}
        </Stack>
      )}

      <Menu position="bottom-start" withinPortal>
        <Menu.Target>
          <Button
            variant="light"
            size="xs"
            leftSection={<IconPlus size={14} aria-hidden />}
            style={{ alignSelf: "flex-start" }}
          >
            Add a step
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          {STANDARDIZATION_FUNCTION_GROUPS.map((group) => (
            <div key={group.label}>
              <Menu.Label>{group.label}</Menu.Label>
              {group.functionNames.map((functionName) => (
                <Menu.Item
                  key={functionName}
                  onClick={() => addStep(functionName)}
                >
                  {functionDisplay(functionName).label}
                </Menu.Item>
              ))}
            </div>
          ))}
        </Menu.Dropdown>
      </Menu>
    </Stack>
  );
}
