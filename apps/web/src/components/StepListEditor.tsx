import { useRef } from "react";

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

import type { StandardizationFunctionDescriptor } from "@psilink/core";

import type { ParamField } from "@psi/standardizationAuthoring";
import type { ReactNode } from "react";

/**
 * A function step the editor edits: a function name plus its parameters. Both the
 * per-party `StandardizationStep` (data cleaning) and the cross-party
 * `TransformStep` (a linkage-key element transform embedded in the token) are
 * exactly this shape and use the same function vocabulary, so one editor drives
 * both. Structurally identical to those core types, so a host holding either can
 * pass its array here and read the emitted array back without a cast.
 */
export interface EditableStep {
  function: string;
  params?: Record<string, unknown>;
}

/** Build a step's initial params from its descriptor: every param that declares a
 * default is seeded with it (so a `parse_date` opens on `MM/DD/YYYY`, a `phonetic`
 * on `soundex`); a param with no default is left unset for the operator to fill. A
 * step with no seeded params omits the `params` key entirely, matching the shape
 * core's own default pipelines use. */
export function newStep(functionName: string): EditableStep {
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
          // A cleared NumberInput reports `""`; store it as an unset param
          // (undefined), not the empty string, so a required numeric param reads
          // as missing -- the inline error fires and launch is gated -- rather than
          // a string that core coerces to a silent full-field exclusion at runtime.
          onChange={(next) => onChange(next === "" ? undefined : next)}
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
  step: EditableStep;
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
  // tier (board item 202533670). An existing pipeline's regex steps -- a default
  // standardization pipeline's, or an imported set of linkage terms' -- still
  // render here and stay reorderable and removable; only their pattern is not
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
  // A null/undefined param has no value to show; render it blank rather than the
  // literal strings "null"/"undefined", which would read as data to the operator.
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

/**
 * The shared lower-level step-list editor: an ordered, editable list of function
 * steps with typed param inputs, keyboard-operable reorder/remove, and a grouped
 * "add a step" menu driven by the standard-tier functions. Presentational -- it
 * holds no step state of its own; it renders `steps` and emits the next array
 * through {@link onStepsChange}, so the host owns the model.
 *
 * Both editors that touch the shared standardization-function vocabulary drive
 * this: the per-party {@link StandardizationStepEditor} (data cleaning) and the
 * expert linkage-terms transform editor (a token-embedded key-element transform).
 * Each wraps this with its own header/framing and copy; the step-editing UX,
 * descriptor-driven param forms, and reorder/identity logic live here once so the
 * two cannot drift.
 */
export function StepListEditor({
  steps,
  onStepsChange,
  addStepLabel = "Add a step",
  emptyHint = "No steps: the value is used as-is. Add a step to clean it.",
}: {
  /** The ordered pipeline steps. */
  steps: Array<EditableStep>;
  /** Emit the next step array on any add, remove, reorder, or param edit. */
  onStepsChange: (steps: Array<EditableStep>) => void;
  /** Label for the add-step button (e.g. "Add a transform"). */
  addStepLabel?: string;
  /** Hint shown when the list is empty. */
  emptyHint?: ReactNode;
}) {
  // A stable React key per step, tracked by object identity so a reorder follows
  // the logical step (rather than its array position) and a param edit keeps the
  // same row mounted -- the move/remove handlers preserve each step's object
  // reference, and setParam carries the id across its immutable replacement, so a
  // controlled input never loses focus or a transient value on an edit. A
  // WeakMap so an id is released when its step is dropped; lazily assigning during
  // render is idempotent (same object -> same id) and safe under StrictMode.
  const stepIds = useRef(new WeakMap<EditableStep, string>());
  const nextStepId = useRef(0);
  const keyFor = (step: EditableStep): string => {
    let id = stepIds.current.get(step);
    if (id === undefined) {
      id = String(nextStepId.current++);
      stepIds.current.set(step, id);
    }
    return id;
  };

  // Removing a step unmounts the row that held focus, which would otherwise fall
  // to document.body. The "add a step" button is always present and not in the
  // removed row, so move focus there after a removal.
  const addButtonRef = useRef<HTMLButtonElement>(null);

  const addStep = (functionName: string) =>
    onStepsChange([...steps, newStep(functionName)]);

  const removeStep = (index: number) => {
    onStepsChange(steps.filter((_, i) => i !== index));
    addButtonRef.current?.focus();
  };

  const moveStep = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= steps.length) return;
    const next = [...steps];
    [next[index], next[target]] = [next[target], next[index]];
    onStepsChange(next);
  };

  const setParam = (index: number, key: string, value: unknown) =>
    onStepsChange(
      steps.map((step, i) => {
        if (i !== index) return step;
        const params = { ...step.params };
        // A cleared param (NumberInput reports an empty input as undefined) drops
        // the key rather than writing an explicit `undefined` own-property, so the
        // step's shape matches core's default pipelines (absent keys omitted) and
        // survives a JSON round-trip. An emptied params object is dropped entirely,
        // matching a no-param step.
        if (value === undefined) delete params[key];
        else params[key] = value;
        const next: EditableStep =
          Object.keys(params).length > 0
            ? { ...step, params }
            : { function: step.function };
        // Carry the row's identity across the immutable replacement so the edited
        // input stays mounted (keeps focus) rather than remounting on each change.
        const id = stepIds.current.get(step);
        if (id !== undefined) stepIds.current.set(next, id);
        return next;
      }),
    );

  return (
    <Stack gap="xs">
      {steps.length === 0 ? (
        <Text size="xs" c="dimmed">
          {emptyHint}
        </Text>
      ) : (
        <Stack
          gap="xs"
          component="ol"
          style={{ listStyle: "none", padding: 0, margin: 0 }}
        >
          {steps.map((step, index) => (
            <StepRow
              key={keyFor(step)}
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
            ref={addButtonRef}
            variant="light"
            size="xs"
            leftSection={<IconPlus size={14} aria-hidden />}
            style={{ alignSelf: "flex-start" }}
          >
            {addStepLabel}
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          {STANDARDIZATION_FUNCTION_GROUPS.map((group) => (
            <div key={group.label}>
              <Menu.Label>{group.label}</Menu.Label>
              {group.functionNames.map((functionName) => {
                const display = functionDisplay(functionName);
                return (
                  <Menu.Item
                    key={functionName}
                    onClick={() => addStep(functionName)}
                  >
                    <Stack gap={0}>
                      <Text size="sm">{display.label}</Text>
                      {/* The descriptor's plain-language consequence -- e.g.
                          coalesce's "can create matches that would not otherwise
                          occur" -- shown at the moment of choice, not just the
                          bare label. */}
                      <Text
                        size="xs"
                        c="dimmed"
                        maw={320}
                        style={{ whiteSpace: "normal" }}
                      >
                        {display.blurb}
                      </Text>
                    </Stack>
                  </Menu.Item>
                );
              })}
            </div>
          ))}
        </Menu.Dropdown>
      </Menu>
    </Stack>
  );
}
