import { useEffect, useId, useRef, useState } from "react";

import { Select, Stack, Table, Text, VisuallyHidden } from "@mantine/core";

import {
  OUTBOUND_SEND_NO_PAYLOAD_SENTENCE,
  SEMANTIC_TYPES,
} from "@psilink/core";

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

import { ColumnName, isolatedColumnName } from "@components/ColumnName";
import { useDeferredAnnouncement } from "@components/useDeferredAnnouncement";

import type { SelectProps } from "@mantine/core";

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
  "Only one column can be the record identifier. Choose a single column that you can use to import the data back into your system.";

/**
 * The error-association props for a Type control offending a single-identifier
 * conflict: `aria-invalid` plus `aria-describedby` anchored to the visible
 * error (`errorId`). `withAria: false` because Mantine's Select otherwise
 * drives both attributes itself off its `error`/context props, overriding
 * these; `error` is not the alternative since it also paints a red border,
 * an appearance change this control must not make. `withAria` is a real
 * Input prop Select forwards but omits from its public type, hence the
 * assertion.
 */
function conflictTypeControlAria(
  errorId: string,
): SelectProps<SemanticType> & { withAria: boolean } {
  return {
    "aria-invalid": true,
    "aria-describedby": errorId,
    withAria: false,
  };
}

/**
 * The shared metadata grid: a real table mapping each input column to a
 * semantic type and a single consequence-labeled disclosure choice.
 * Presentational -- holds no metadata state; renders `metadata` and emits the
 * next array through {@link onChange}, so the host owns the model.
 *
 * The grid does not paint the disclosed-columns list itself (the host shows
 * it visibly beside the agreed terms); it keeps only the aria-live
 * announcement of that list, computed from {@link disclosedColumnNames} (the
 * same predicate `preparePayload` transmits on) and gated by
 * {@link partnerReceivesResult}, since a live region and the visible panel
 * beside it must state the same account.
 *
 * Every column name the grid emits goes through {@link ColumnName} /
 * {@link isolatedColumnName}, matching the host's own column-name surfaces.
 */
export function MetadataGrid({
  metadata,
  onChange,
  caption,
  partnerReceivesResult = true,
}: {
  metadata: Metadata;
  onChange: (next: Metadata) => void;
  /** A visually-hidden table caption naming this grid for assistive tech (e.g.
   * "Your columns and how each is used"). */
  caption: string;
  /** Whether the viewer's partner receives a result, i.e. whether the payload
   * step transmits anything from this machine at all: it sends only to a
   * partner entitled to the result, so no column leaves regardless of what is
   * marked here otherwise. The grid holds no linkage terms, so the host
   * resolves this for its own viewer. Defaults to a partner that receives,
   * since announcing the disclosed set is the safer default over silence. */
  partnerReceivesResult?: boolean;
}) {
  const disclosed = disclosedColumnNames(metadata);
  const summary = !partnerReceivesResult
    ? OUTBOUND_SEND_NO_PAYLOAD_SENTENCE
    : disclosed.length === 0
      ? "No columns will be sent to your partner."
      : `Columns sent to your partner: ${disclosed
          .map(isolatedColumnName)
          .join(", ")}.`;

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
  // `ignored` (no longer sent), a change assistive tech would otherwise miss.
  // Kept apart from the debounced summary by design -- the demotion is set
  // synchronously while the summary updates 600ms later, avoiding two polite
  // regions coalescing in one tick. Cleared on a non-demoting edit.
  const [actionAnnouncement, setActionAnnouncement] = useState("");

  // Both mutators can demote: a type change that lands a column on the
  // identifier role displaces the others just as a disclosure change does, so
  // both route through here to announce it.
  const applyEdit = (result: {
    metadata: Metadata;
    demotedIdentifiers: Array<string>;
  }) => {
    setActionAnnouncement(
      result.demotedIdentifiers.length === 0
        ? ""
        : `${result.demotedIdentifiers.map(isolatedColumnName).join(", ")} ${
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
  // The visible error's id, so each conflicting Type control can point its
  // aria-describedby at it -- useId keeps it unique if two grids mount.
  const conflictErrorId = useId();

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
            // Only the identifier-roled columns are the offenders in a
            // single-identifier conflict, so the control-level error signal
            // rides exactly those Type controls and clears on every other.
            const inConflict =
              multipleIdentifiers && column.role === "identifier";
            return (
              <Table.Tr key={column.name}>
                <Table.Th scope="row" style={{ fontWeight: 500 }}>
                  <ColumnName name={column.name} />
                </Table.Th>
                <Table.Td>
                  <Select
                    data={TYPE_OPTIONS}
                    value={column.type}
                    allowDeselect={false}
                    aria-label={`Type for column ${isolatedColumnName(
                      column.name,
                    )}`}
                    {...(inConflict
                      ? conflictTypeControlAria(conflictErrorId)
                      : {})}
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
                    aria-label={`How column ${isolatedColumnName(
                      column.name,
                    )} is used`}
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

      {/* The single-identifier conflict is conveyed on two decoupled surfaces:
          the VISIBLE red error (immediate, no ARIA role of its own, not the
          live region) and the deferred polite region (last child, visually
          hidden) that reaches assistive tech -- see the conflictAnnouncement
          note above for why it is deferred. Both read the same message
          constant; tests query the visible error by its data-testid since the
          announcement holds the same text. Its id also anchors the offending
          Type controls' aria-describedby (see conflictTypeControlAria). */}
      {multipleIdentifiers && (
        <Text
          size="sm"
          c="red"
          id={conflictErrorId}
          data-testid="identifier-conflict"
        >
          {SINGLE_IDENTIFIER_MESSAGE}
        </Text>
      )}

      {/* The disclosure readout is shown VISIBLY by the host's column chips;
          what stays here is the announcement, since toggling a disclosure
          Select gets no spoken feedback from the static chips otherwise. This
          debounced live region is computed from the same
          disclosedColumnNames predicate the run transmits on. The testid
          distinguishes this region's copy from the host's identical visible
          sentence. */}
      <VisuallyHidden
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="disclosure-summary-announcement"
      >
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
