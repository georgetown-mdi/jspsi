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

import { useDeferredAnnouncement } from "@components/useDeferredAnnouncement";

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

/** The single-identifier conflict text, shared by the visible error and its
 * announcement so the two cannot drift. */
const SINGLE_IDENTIFIER_MESSAGE =
  "Only one column can be the record identifier. Choose a single identifier.";

/**
 * The shared metadata grid: a real table mapping each input column to a semantic
 * type and a single consequence-labeled disclosure choice. Presentational -- it
 * holds no metadata state of its own; it renders `metadata` and emits the next
 * array through {@link onChange}, so the host (the acceptor's Confirm-your-columns
 * step) owns the model and decides what
 * the edit means.
 *
 * The grid does not paint the disclosed-columns list itself: the host already
 * shows it visibly as the "What you will send to your partner" chips beside the
 * agreed terms, so a second text copy here would be a same-screen duplicate. What
 * the grid keeps is the aria-live ANNOUNCEMENT of that list -- computed
 * synchronously from {@link disclosedColumnNames}, the same predicate
 * `preparePayload` transmits on, so it cannot over- or under-state what leaves the
 * machine -- debounced and voiced right at the disclosure control the static chips
 * cannot speak for.
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
  // landing a column on the identifier role displaces any prior identifier to
  // `ignored` (no longer sent), a state change a sighted user sees in the
  // displaced row but assistive tech would otherwise miss. It is its own region
  // (not folded into the debounced summary) deliberately: the demotion is set
  // synchronously here while the summary updates 600ms later, so the two never
  // write in the same render tick -- which is what avoids two polite regions
  // coalescing. Cleared on a non-demoting edit so it does not linger.
  const [actionAnnouncement, setActionAnnouncement] = useState("");

  // Both mutators can demote now: a type change that lands a column on the
  // identifier role displaces the others just as a disclosure change does, so both
  // route through here to announce it.
  const applyEdit = (result: {
    metadata: Metadata;
    demotedIdentifiers: Array<string>;
  }) => {
    setActionAnnouncement(
      result.demotedIdentifiers.length === 0
        ? ""
        : `${result.demotedIdentifiers.join(", ")} ${
            result.demotedIdentifiers.length === 1 ? "is" : "are"
          } no longer the record identifier and will not be sent; only one ` +
            "column can be the record identifier.",
    );
    onChange(result.metadata);
  };
  const onType = (columnName: string, type: SemanticType) =>
    applyEdit(setColumnType(metadata, columnName, type));
  const onDisclosure = (columnName: string, choice: DisclosureChoice) =>
    applyEdit(setColumnDisclosure(metadata, columnName, choice));

  const multipleIdentifiers = hasMultipleIdentifiers(metadata);

  // The conflict announcement is deferred one commit (see useDeferredAnnouncement),
  // so a seed that mounts ALREADY in the two-identifier state is announced as an
  // empty -> non-empty transition rather than skipped as present-on-mount content;
  // a conflict that appears later (e.g. Reset restoring such a seed) announces the
  // same way. The visible error below is NOT deferred, so sighted users see it on
  // the first paint.
  const conflictAnnouncement = useDeferredAnnouncement(
    multipleIdentifiers ? SINGLE_IDENTIFIER_MESSAGE : "",
  );

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

      {/* The single-identifier conflict is conveyed on two decoupled surfaces. The
          VISIBLE red error renders immediately for sighted users and carries no
          ARIA role of its own -- it is not the live region, so it neither
          announces on mount (fighting focus) nor double-announces with the region
          below, and being conditional it adds no empty in-flow box when there is
          no conflict. The deferred polite region (last child, visually hidden) is
          what reaches assistive tech: see the conflictAnnouncement note above for
          why it is deferred. Both read the same message constant so they cannot
          drift; tests query the visible error by its data-testid (the announcement
          carries the same text, so a getByText would be ambiguous). */}
      {multipleIdentifiers && (
        <Text size="sm" c="red" data-testid="identifier-conflict">
          {SINGLE_IDENTIFIER_MESSAGE}
        </Text>
      )}

      {/* The disclosure readout is shown VISIBLY by the host's column chips
          (the "What you will send to your partner" list beside the agreed
          terms), so the grid no longer repeats it as text -- that was a
          duplicate on the same screen. What stays here is the announcement: a
          screen-reader user toggling a disclosure Select above gets no spoken
          feedback from the static chips, so this single debounced live region --
          computed from the same disclosedColumnNames predicate the run transmits
          on -- voices the new set as it changes, right at the control. */}
      <VisuallyHidden role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </VisuallyHidden>
      {/* The demotion is announced immediately (the summary above is debounced),
          so a single-identifier change is heard as it happens. aria-atomic so the
          whole sentence is read, never a fragment. */}
      <VisuallyHidden role="status" aria-live="polite" aria-atomic="true">
        {actionAnnouncement}
      </VisuallyHidden>
      {/* The single-identifier conflict's announcement channel (see the visible
          error above and conflictAnnouncement): a stable, always-present polite
          region whose deferred text reaches assistive tech without fighting mount
          focus. */}
      <VisuallyHidden
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="identifier-conflict-announcement"
      >
        {conflictAnnouncement}
      </VisuallyHidden>
    </Stack>
  );
}
