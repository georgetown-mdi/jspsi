import { useEffect, useRef, useState } from "react";

import { Select, Stack, Table, Text, VisuallyHidden } from "@mantine/core";

import { SEMANTIC_TYPES } from "@psilink/core";

import {
  DISCLOSURE_LABELS,
  SEMANTIC_TYPE_LABELS,
  disclosedColumnNames,
  disclosureChoicesForType,
  disclosureOf,
  hasMultipleIdentifiers,
  setColumnDisclosure,
  setColumnType,
} from "@psi/metadataEditing";

import type { Metadata, SemanticType } from "@psilink/core";

import type { DisclosureChoice } from "@psi/metadataEditing";

/** Type-select options, every semantic type with its human label (never raw
 * snake_case). Stable across renders -- the option set does not depend on state. */
const TYPE_OPTIONS = SEMANTIC_TYPES.map((type) => ({
  value: type,
  label: SEMANTIC_TYPE_LABELS[type],
}));

/** Debounce (ms) before the disclosure summary is announced to assistive tech, so
 * a burst of edits announces once rather than on every keystroke. The visible
 * summary updates synchronously; only the announcement is debounced. */
const ANNOUNCE_DEBOUNCE_MS = 600;

/**
 * The shared metadata grid: a real table mapping each input column to a semantic
 * type and a single consequence-labeled disclosure choice, with a running summary
 * of the columns disclosed to the partner. Presentational -- it holds no metadata
 * state of its own; it renders `metadata` and emits the next array through
 * {@link onChange}, so each host (the acceptor "Prepare your data" screen and the
 * inviter Advanced-options editor) owns the model and decides what the edit means.
 *
 * The disclosure summary is computed synchronously from {@link disclosedColumnNames}
 * -- the same predicate `preparePayload` transmits on -- so it cannot over- or
 * under-state what leaves the machine. The single aria-live region announces that
 * summary, debounced; the visible summary and the grid update immediately.
 */
export function MetadataGrid({
  metadata,
  onChange,
  caption,
}: {
  metadata: Metadata;
  onChange: (next: Metadata) => void;
  /** A visually-hidden table caption naming this grid for assistive tech (e.g.
   * "Your columns and how each is used"). */
  caption: string;
}) {
  const disclosed = disclosedColumnNames(metadata);
  const summary =
    disclosed.length === 0
      ? "No columns will be sent to your partner."
      : `Columns sent to your partner: ${disclosed.join(", ")}.`;

  // Announce the disclosure summary on a debounce. The timer is cleared on every
  // change and on unmount, so a rapid edit burst announces once and a teardown
  // mid-debounce leaks no timer (StrictMode double-invokes this effect). The
  // visible summary below is NOT debounced.
  const [announcement, setAnnouncement] = useState("");
  const summaryRef = useRef(summary);
  summaryRef.current = summary;
  useEffect(() => {
    const handle = setTimeout(
      () => setAnnouncement(summaryRef.current),
      ANNOUNCE_DEBOUNCE_MS,
    );
    return () => clearTimeout(handle);
  }, [summary]);

  // A separate, immediate live region for the single-identifier demotion:
  // choosing `identifier` for one column displaces any prior identifier to
  // `ignored` (no longer sent), a state change a sighted user sees in the
  // displaced row but assistive tech would otherwise miss. Cleared on the next
  // edit so it does not linger (the same idiom the inviter editor uses).
  const [actionAnnouncement, setActionAnnouncement] = useState("");

  const onType = (columnName: string, type: SemanticType) => {
    setActionAnnouncement("");
    onChange(setColumnType(metadata, columnName, type));
  };
  const onDisclosure = (columnName: string, choice: DisclosureChoice) => {
    const { metadata: next, demotedIdentifier } = setColumnDisclosure(
      metadata,
      columnName,
      choice,
    );
    setActionAnnouncement(
      demotedIdentifier === undefined
        ? ""
        : `${demotedIdentifier} is no longer the row identifier and will ` +
            "not be sent; only one column can be the row identifier.",
    );
    onChange(next);
  };

  const multipleIdentifiers = hasMultipleIdentifiers(metadata);

  return (
    <Stack gap="xs">
      <Table withTableBorder withColumnBorders verticalSpacing="xs">
        <VisuallyHidden component="caption">{caption}</VisuallyHidden>
        <Table.Thead>
          <Table.Tr>
            <Table.Th scope="col">Column</Table.Th>
            <Table.Th scope="col">Type</Table.Th>
            <Table.Th scope="col">How it is used</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {metadata.map((column) => {
            const choices = disclosureChoicesForType(column.type);
            return (
              <Table.Tr key={column.name}>
                <Table.Th scope="row" style={{ fontWeight: 500 }}>
                  {column.name}
                </Table.Th>
                <Table.Td>
                  <Select
                    data={TYPE_OPTIONS}
                    value={column.type}
                    allowDeselect={false}
                    aria-label={`Type for column ${column.name}`}
                    onChange={(value) =>
                      value !== null && onType(column.name, value)
                    }
                  />
                </Table.Td>
                <Table.Td>
                  <Select
                    data={choices.map((choice) => ({
                      value: choice,
                      label: DISCLOSURE_LABELS[choice],
                    }))}
                    value={disclosureOf(column)}
                    allowDeselect={false}
                    aria-label={`How column ${column.name} is used`}
                    onChange={(value) =>
                      value !== null && onDisclosure(column.name, value)
                    }
                  />
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>

      {multipleIdentifiers && (
        <Text size="sm" c="red" role="alert">
          Only one column can be the row identifier. Choose a single identifier.
        </Text>
      )}

      {/* The running disclosure summary, the security-relevant readout of what
          leaves the machine. Synchronous so it tracks the grid exactly; the
          aria-live region below announces it on a debounce. */}
      <Text size="sm" fw={disclosed.length > 0 ? 600 : 400}>
        {summary}
      </Text>
      <VisuallyHidden role="status" aria-live="polite">
        {announcement}
      </VisuallyHidden>
      {/* The demotion is announced immediately (the summary above is debounced),
          so a single-identifier change is heard as it happens. */}
      <VisuallyHidden role="status" aria-live="polite">
        {actionAnnouncement}
      </VisuallyHidden>
    </Stack>
  );
}
