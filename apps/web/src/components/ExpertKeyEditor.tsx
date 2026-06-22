import { useRef } from "react";

import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Divider,
  Group,
  MultiSelect,
  Paper,
  Select,
  Stack,
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
  addElement,
  addKey,
  moveElement,
  removeElement,
  removeKey,
  updateElementAt,
  updateKeyAt,
} from "@psi/advancedInvite";
import { SEMANTIC_TYPE_LABELS } from "@psi/metadataEditing";

import { StepListEditor } from "@components/StepListEditor";

import type {
  LinkageField,
  LinkageKey,
  LinkageKeyElement,
} from "@psilink/core";

import type { AdvancedInviteDraft, FuzzyComparison } from "@psi/advancedInvite";

/** The fuzzy-comparison expansions an element can declare, with plain-language
 * labels. Disabled wholesale until the run applies fuzzy comparisons (see
 * APPLIED_SETTINGS); shown so the capability is discoverable. */
const FUZZY_OPTIONS: Array<{ value: FuzzyComparison; label: string }> = [
  { value: "transpositions", label: "Two-digit transpositions" },
  { value: "edit_distances", label: "Single-character edits" },
  { value: "adjacent_years", label: "Adjacent years (+/- 1)" },
];

/** The effective identifier of an element within its key -- its alias if set,
 * otherwise the field name. This is what a swap target names and what must be
 * unique within a key (the schema enforces both). */
function elementIdentifier(element: LinkageKeyElement): string {
  return element.name ?? element.field;
}

/**
 * The expert key-authoring surface: an ordered list of linkage keys, each fully
 * editable element-by-element. A key carries a name, an ordered list of elements
 * (each a field reference chosen from the declared list, an optional alias, a
 * transform pipeline, and a gated fuzzy expansion), and an optional two-of-N swap
 * over its own element identifiers. Keys and elements add, remove, and reorder
 * with keyboard-operable controls.
 *
 * Presentational over the draft: it computes the next draft with the pure helpers
 * in {@link advancedInvite} and emits it through {@link onChange}; the host owns
 * the state and the live-region announcements. Field references are chosen from
 * {@link declaredFields} (never free-typed) and swap targets from the key's own
 * element identifiers (never free text), so a dangling reference cannot be
 * authored here -- the core schema stays the single validation source.
 */
export function ExpertKeyEditor({
  draft,
  declaredFields,
  keyIsSatisfiable,
  fuzzyApplied,
  onChange,
  announce,
}: {
  draft: AdvancedInviteDraft;
  /** The fields a key element may reference, in offer order (metadata-derived). */
  declaredFields: Array<LinkageField>;
  /** Whether the inviter's columns can satisfy the key at this index. */
  keyIsSatisfiable: (keyIndex: number) => boolean;
  /** Whether the per-element fuzzy control is enabled (the run applies fuzzy). */
  fuzzyApplied: boolean;
  onChange: (next: AdvancedInviteDraft) => void;
  /** Emit a message to the host's polite live region. */
  announce: (message: string) => void;
}) {
  // Stable React keys for keys and elements, tracked by object identity so a
  // reorder follows the logical row and a text edit keeps the same input mounted
  // (no focus loss mid-typing). The pure edit helpers replace the edited key /
  // element object, so editKey / editElement carry its id across the replacement
  // -- the same idiom StepListEditor uses for a step. Reorder and the sibling
  // map() preserve object references, so those ids carry automatically.
  const keyIds = useRef(new WeakMap<LinkageKey, string>());
  const elementIds = useRef(new WeakMap<LinkageKeyElement, string>());
  const nextId = useRef(0);
  const idFor = <T extends object>(map: WeakMap<T, string>, obj: T): string => {
    let id = map.get(obj);
    if (id === undefined) {
      id = String(nextId.current++);
      map.set(obj, id);
    }
    return id;
  };
  const carry = <T extends object>(
    map: WeakMap<T, string>,
    from: T,
    to: T,
  ): void => {
    const id = map.get(from);
    if (id !== undefined) map.set(to, id);
  };

  // Removing a key or element unmounts the row that held focus, which would
  // otherwise fall to document.body. Move focus to a stable, always-present
  // control in the same scope instead: the "Add a key" button after a key
  // removal, and the owning key's "Add an element" button after an element
  // removal. Both buttons survive the removal (they are not in the removed row),
  // so focusing them synchronously after the change keeps focus where the next
  // action lives. Per-key add-element buttons are tracked by the key's stable id.
  const addKeyRef = useRef<HTMLButtonElement>(null);
  const addElementRefs = useRef(new Map<string, HTMLButtonElement>());

  const fieldOptions = declaredFields.map((field) => ({
    value: field.name,
    // The type label, qualified by the field name only when it differs (an
    // imported custom-named field); the name is sanitized as it may not be a
    // safe type token.
    label:
      field.name === field.type
        ? SEMANTIC_TYPE_LABELS[field.type]
        : `${SEMANTIC_TYPE_LABELS[field.type]} (${sanitizeForDisplay(field.name)})`,
  }));
  // `.at(0)` (not `[0]`) so the type is genuinely `string | undefined` -- the
  // declared field list can be empty (a file with no linkage columns), which the
  // guard below handles.
  const firstField = declaredFields.at(0)?.name;

  // A key edit replaces the key object; carry its id so its card stays mounted.
  const editKey = (
    keyIndex: number,
    fn: (key: LinkageKey) => LinkageKey,
  ): void => {
    const before = draft.keys[keyIndex].key;
    const next = updateKeyAt(draft, keyIndex, fn);
    carry(keyIds.current, before, next.keys[keyIndex].key);
    onChange(next);
  };

  // An element edit replaces both the element and its containing key object;
  // carry both ids so the element row and its card stay mounted.
  const editElement = (
    keyIndex: number,
    elementIndex: number,
    fn: (element: LinkageKeyElement) => LinkageKeyElement,
  ): void => {
    const beforeKey = draft.keys[keyIndex].key;
    const beforeEl = beforeKey.elements[elementIndex];
    const next = updateElementAt(draft, keyIndex, elementIndex, fn);
    const afterKey = next.keys[keyIndex].key;
    carry(keyIds.current, beforeKey, afterKey);
    carry(elementIds.current, beforeEl, afterKey.elements[elementIndex]);
    onChange(next);
  };

  // A structural element edit (add/remove/move) produced by the pure helpers
  // replaces the containing key object; carry the key's id so its card stays
  // mounted across the edit (otherwise the whole card -- and every element row,
  // and the "Add an element" button focus lands on -- remounts). Surviving element
  // objects keep their identity through the helpers, so their ids carry on their
  // own; only the replaced key object needs the carry.
  const applyKeyStructureEdit = (
    keyIndex: number,
    next: AdvancedInviteDraft,
  ): void => {
    carry(keyIds.current, draft.keys[keyIndex].key, next.keys[keyIndex].key);
    onChange(next);
  };

  const moveKey = (keyIndex: number, direction: -1 | 1): void => {
    const target = keyIndex + direction;
    if (target < 0 || target >= draft.keys.length) return;
    const keys = [...draft.keys];
    [keys[keyIndex], keys[target]] = [keys[target], keys[keyIndex]];
    onChange({ ...draft, keys });
    announce(
      `Moved ${keys[target].key.name} to position ${target + 1} of ${keys.length}. ` +
        "Keys earlier in the list match first.",
    );
  };

  if (firstField === undefined)
    return (
      <Text size="sm" c="red" role="alert">
        Your columns declare no linkage fields to build a key from. Set a
        column&apos;s type under Your columns above.
      </Text>
    );

  return (
    <Stack gap="sm">
      <Stack
        gap="sm"
        component="ol"
        aria-label="Linkage keys"
        style={{ listStyle: "none", padding: 0, margin: 0 }}
      >
        {draft.keys.map((entry, keyIndex) => {
          const key = entry.key;
          const satisfiable = keyIsSatisfiable(keyIndex);
          const swapData = key.elements.map((el) => ({
            value: elementIdentifier(el),
            label: sanitizeForDisplay(elementIdentifier(el)),
          }));
          return (
            <Paper
              key={idFor(keyIds.current, key)}
              withBorder
              p="sm"
              component="li"
            >
              <Stack gap="xs">
                <Group justify="space-between" wrap="nowrap" align="flex-start">
                  <TextInput
                    label="Key name"
                    value={key.name}
                    onChange={(e) =>
                      editKey(keyIndex, (k) => ({ ...k, name: e.target.value }))
                    }
                    style={{ flex: 1 }}
                  />
                  <Group gap={2} wrap="nowrap" mt={24}>
                    <Badge
                      size="xs"
                      variant="light"
                      color={satisfiable ? "green" : "red"}
                      role="img"
                      aria-label={
                        satisfiable
                          ? "Your columns can satisfy this key"
                          : "Your columns cannot satisfy this key"
                      }
                    >
                      {satisfiable ? "satisfiable" : "not satisfiable"}
                    </Badge>
                    <ActionIcon
                      variant="subtle"
                      disabled={keyIndex === 0}
                      onClick={() => moveKey(keyIndex, -1)}
                      aria-label={`Move ${key.name} earlier`}
                    >
                      <IconArrowUp size={16} />
                    </ActionIcon>
                    <ActionIcon
                      variant="subtle"
                      disabled={keyIndex === draft.keys.length - 1}
                      onClick={() => moveKey(keyIndex, 1)}
                      aria-label={`Move ${key.name} later`}
                    >
                      <IconArrowDown size={16} />
                    </ActionIcon>
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      onClick={() => {
                        onChange(removeKey(draft, keyIndex));
                        announce(`Removed key ${key.name}.`);
                        // Keep focus in the editor (the removed card held it).
                        addKeyRef.current?.focus();
                      }}
                      aria-label={`Remove key ${key.name}`}
                    >
                      <IconTrash size={16} />
                    </ActionIcon>
                  </Group>
                </Group>

                <Stack
                  gap="xs"
                  component="ol"
                  aria-label={`Elements of ${key.name}`}
                  style={{ listStyle: "none", padding: 0, margin: 0 }}
                >
                  {key.elements.map((element, elementIndex) => {
                    // The element's own identifier (alias or field), named in its
                    // controls and announcements -- matching the key/step controls,
                    // which name their item rather than its bare ordinal.
                    const elementLabel = sanitizeForDisplay(
                      elementIdentifier(element),
                    );
                    return (
                      <Paper
                        key={idFor(elementIds.current, element)}
                        withBorder
                        p="xs"
                        component="li"
                        bg="var(--mantine-color-default-hover)"
                      >
                        <Stack gap="xs">
                          <Group
                            justify="space-between"
                            wrap="nowrap"
                            align="flex-end"
                          >
                            <Select
                              label="Field"
                              data={fieldOptions}
                              value={element.field}
                              allowDeselect={false}
                              onChange={(value) =>
                                value !== null &&
                                editElement(keyIndex, elementIndex, (el) => ({
                                  ...el,
                                  field: value,
                                }))
                              }
                              style={{ flex: 1 }}
                            />
                            <Group gap={2} wrap="nowrap">
                              <ActionIcon
                                variant="subtle"
                                disabled={elementIndex === 0}
                                onClick={() => {
                                  applyKeyStructureEdit(
                                    keyIndex,
                                    moveElement(
                                      draft,
                                      keyIndex,
                                      elementIndex,
                                      -1,
                                    ),
                                  );
                                  // Name + new position so each announcement differs
                                  // (a repeated identical string is not re-announced).
                                  announce(
                                    `Moved ${elementLabel} to position ${elementIndex} of ${key.elements.length}.`,
                                  );
                                }}
                                aria-label={`Move element ${elementIndex + 1} (${elementLabel}) earlier`}
                              >
                                <IconArrowUp size={16} />
                              </ActionIcon>
                              <ActionIcon
                                variant="subtle"
                                disabled={
                                  elementIndex === key.elements.length - 1
                                }
                                onClick={() => {
                                  applyKeyStructureEdit(
                                    keyIndex,
                                    moveElement(
                                      draft,
                                      keyIndex,
                                      elementIndex,
                                      1,
                                    ),
                                  );
                                  announce(
                                    `Moved ${elementLabel} to position ${elementIndex + 2} of ${key.elements.length}.`,
                                  );
                                }}
                                aria-label={`Move element ${elementIndex + 1} (${elementLabel}) later`}
                              >
                                <IconArrowDown size={16} />
                              </ActionIcon>
                              <ActionIcon
                                variant="subtle"
                                color="red"
                                disabled={key.elements.length === 1}
                                onClick={() => {
                                  applyKeyStructureEdit(
                                    keyIndex,
                                    removeElement(
                                      draft,
                                      keyIndex,
                                      elementIndex,
                                    ),
                                  );
                                  announce(`Removed ${elementLabel}.`);
                                  // Keep focus in the key (the removed row held it).
                                  addElementRefs.current
                                    .get(idFor(keyIds.current, key))
                                    ?.focus();
                                }}
                                aria-label={`Remove element ${elementIndex + 1} (${elementLabel})`}
                              >
                                <IconTrash size={16} />
                              </ActionIcon>
                            </Group>
                          </Group>

                          <TextInput
                            label="Alias (optional)"
                            description="A name for this element, needed only to tell two elements of the same field apart or to target a swap"
                            value={element.name ?? ""}
                            onChange={(e) =>
                              editElement(keyIndex, elementIndex, (el) => {
                                const name = e.target.value;
                                const next = { ...el };
                                if (name === "") delete next.name;
                                else next.name = name;
                                return next;
                              })
                            }
                          />

                          <div>
                            <Text size="xs" fw={600} mb={4}>
                              Transform before matching
                            </Text>
                            <StepListEditor
                              steps={element.transform ?? []}
                              addStepLabel="Add a transform"
                              emptyHint="No transforms: the field value is matched as-is."
                              onStepsChange={(steps) =>
                                editElement(keyIndex, elementIndex, (el) => {
                                  const next = { ...el };
                                  if (steps.length === 0) delete next.transform;
                                  else next.transform = steps;
                                  return next;
                                })
                              }
                            />
                          </div>

                          <Select
                            label="Fuzzy comparison"
                            data={FUZZY_OPTIONS}
                            value={element.generateFuzzyComparisons ?? null}
                            clearable
                            disabled={!fuzzyApplied}
                            description={
                              fuzzyApplied
                                ? "Expand this value into near-matches before hashing"
                                : "Not available: this version of the exchange does not yet apply fuzzy comparisons"
                            }
                            onChange={(value) =>
                              editElement(keyIndex, elementIndex, (el) => {
                                const next = { ...el };
                                // Mantine infers the value type from the typed
                                // FUZZY_OPTIONS data, so it is a FuzzyComparison
                                // (or null) without an assertion.
                                if (value === null)
                                  delete next.generateFuzzyComparisons;
                                else next.generateFuzzyComparisons = value;
                                return next;
                              })
                            }
                          />
                        </Stack>
                      </Paper>
                    );
                  })}
                </Stack>

                <Group justify="space-between" wrap="nowrap" align="flex-end">
                  <Button
                    variant="light"
                    size="xs"
                    leftSection={<IconPlus size={14} aria-hidden />}
                    ref={(el) => {
                      const id = idFor(keyIds.current, key);
                      if (el) addElementRefs.current.set(id, el);
                      else addElementRefs.current.delete(id);
                    }}
                    onClick={() => {
                      applyKeyStructureEdit(
                        keyIndex,
                        addElement(draft, keyIndex, firstField),
                      );
                      announce("Added an element.");
                    }}
                  >
                    Add an element
                  </Button>
                  <MultiSelect
                    label="Swap (match in either order)"
                    description="Choose exactly two elements that may be matched in either order"
                    data={swapData}
                    value={key.swap ?? []}
                    maxValues={2}
                    clearable
                    size="xs"
                    style={{ flex: 1, maxWidth: 360 }}
                    onChange={(value) =>
                      editKey(keyIndex, (k) => {
                        const next = { ...k };
                        if (value.length === 2)
                          next.swap = [value[0], value[1]];
                        else delete next.swap;
                        return next;
                      })
                    }
                  />
                </Group>
              </Stack>
            </Paper>
          );
        })}
      </Stack>

      <Divider />
      <Box>
        <Button
          ref={addKeyRef}
          variant="light"
          leftSection={<IconPlus size={16} aria-hidden />}
          onClick={() => {
            onChange(addKey(draft, firstField));
            announce("Added a key.");
          }}
        >
          Add a key
        </Button>
      </Box>
    </Stack>
  );
}
