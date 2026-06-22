import { useEffect, useRef, useState } from "react";

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
  VisuallyHidden,
} from "@mantine/core";
import {
  IconArrowDown,
  IconArrowUp,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";
import { useIsomorphicEffect } from "@mantine/hooks";

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

/** Debounce (ms) before the step-list summary is announced to assistive tech, so a
 * burst of add/remove/reorder edits announces once rather than on every action. The
 * visible list updates synchronously; only the announcement is debounced. Matches
 * the metadata grid's announce debounce. */
const STEP_ANNOUNCE_DEBOUNCE_MS = 600;

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
            data-step-action="up"
          >
            <IconArrowUp size={16} />
          </ActionIcon>
          <ActionIcon
            variant="subtle"
            disabled={index === count - 1}
            onClick={() => onMove(1)}
            aria-label={`Move ${label} later`}
            data-step-action="down"
          >
            <IconArrowDown size={16} />
          </ActionIcon>
          <ActionIcon
            variant="subtle"
            color="red"
            onClick={onRemove}
            aria-label={`Remove ${label}`}
            data-step-action="remove"
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
  // A stable React key per step, tracked by object identity so a reorder follows
  // the logical step (rather than its array position) and a param edit keeps the
  // same row mounted -- the move/remove handlers preserve each step's object
  // reference, and setParam carries the id across its immutable replacement, so a
  // controlled input never loses focus or a transient value on an edit. A
  // WeakMap so an id is released when its step is dropped; lazily assigning during
  // render is idempotent (same object -> same id) and safe under StrictMode.
  const stepIds = useRef(new WeakMap<StandardizationStep, string>());
  const nextStepId = useRef(0);
  const keyFor = (step: StandardizationStep): string => {
    let id = stepIds.current.get(step);
    if (id === undefined) {
      id = String(nextStepId.current++);
      stepIds.current.set(step, id);
    }
    return id;
  };

  // Where to land focus after a structural edit commits. A removed or moved step's
  // control vanishes (remove) or disables at an edge (move), which otherwise drops
  // focus to <body>; this records the intended target, and the layout effect below
  // applies it against the committed list -- matching the focus guard the rest of
  // the app's editors use on removal.
  // Typed HTMLDivElement to match Mantine's polymorphic Stack ref (it does not
  // narrow to <ol> from `component`); the element is the rendered `<ol>` at runtime
  // and only its base `.children` / `.querySelector` are used.
  const listRef = useRef<HTMLDivElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const pendingFocusRef = useRef<{
    action: "remove" | "move";
    index: number;
    direction?: -1 | 1;
  } | null>(null);

  const addStep = (functionName: string) =>
    onStepsChange([...steps, newStep(functionName)]);

  const removeStep = (index: number) => {
    // Land focus on the step that slides into this slot, or the last one if this was
    // the tail; on the Add button when the list empties.
    pendingFocusRef.current = { action: "remove", index };
    onStepsChange(steps.filter((_, i) => i !== index));
  };

  const moveStep = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= steps.length) return;
    const next = [...steps];
    [next[index], next[target]] = [next[target], next[index]];
    // Keep focus on the moved step at its new position; the layout effect picks the
    // same-direction control, or the opposite one when the move reached an edge and
    // disabled it.
    pendingFocusRef.current = { action: "move", index: target, direction };
    onStepsChange(next);
  };

  // Apply the pending focus once the new list is in the DOM. A layout effect (not a
  // passive one) so focus lands synchronously before paint -- otherwise a removed or
  // moved control leaves focus on <body> for a frame, a visible flicker. Keyed on the
  // step array, so it also fires on a param edit (which produces a new array); that is
  // a no-op because only the move/remove handlers set pendingFocusRef -- the null
  // guard below exits at once when no structural edit queued a target. (Isomorphic so
  // it degrades to a passive effect under SSR rather than warning.)
  useIsomorphicEffect(() => {
    const pending = pendingFocusRef.current;
    if (pending === null) return;
    pendingFocusRef.current = null;
    const rows = listRef.current?.children;
    if (pending.action === "remove") {
      if (rows === undefined || rows.length === 0) {
        addButtonRef.current?.focus();
        return;
      }
      const landing = rows[Math.min(pending.index, rows.length - 1)];
      landing
        .querySelector<HTMLButtonElement>('[data-step-action="remove"]')
        ?.focus();
      return;
    }
    const row = rows?.[pending.index];
    const sameDirection = pending.direction === -1 ? "up" : "down";
    const same = row?.querySelector<HTMLButtonElement>(
      `[data-step-action="${sameDirection}"]`,
    );
    // The control is disabled when the moved step reached the first/last slot; fall
    // back to the opposite-direction control, which is always enabled there.
    if (same !== null && same !== undefined && !same.disabled) {
      same.focus();
      return;
    }
    row
      ?.querySelector<HTMLButtonElement>(
        `[data-step-action="${pending.direction === -1 ? "down" : "up"}"]`,
      )
      ?.focus();
  }, [steps]);

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
        const next: StandardizationStep =
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
          ref={listRef}
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
            Add a step
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

      {/* One polite, atomic live region for this field's step list: announces the
          debounced summary after an add, remove, or reorder, never the whole card
          per keystroke. */}
      <VisuallyHidden role="status" aria-live="polite" aria-atomic="true">
        {stepAnnouncement}
      </VisuallyHidden>
    </Stack>
  );
}
