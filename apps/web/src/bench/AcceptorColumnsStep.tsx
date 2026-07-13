import { useEffect, useRef } from "react";

import {
  Alert,
  Button,
  NativeSelect,
  Paper,
  Stack,
  Text,
  VisuallyHidden,
} from "@mantine/core";
import {
  IconAlertCircle,
  IconAlertTriangle,
  IconCircleCheck,
} from "@tabler/icons-react";

import { sanitizeForDisplay } from "@psilink/core";

import { MetadataGrid } from "@components/MetadataGrid";
import { useDeferredAnnouncement } from "@components/useDeferredAnnouncement";

import {
  acceptorDisclosedColumns,
  acceptorLaunchDisabled,
  acceptorStandardizationValid,
  acceptorUnsatisfiedTypes,
} from "./acceptorColumnsModel";
import styles from "./bench.module.css";

import type {
  AcceptorColumnsState,
  AcceptorVerdictViewModel,
} from "./acceptorColumnsModel";
import type {
  LinkageField,
  LinkageTerms,
  Metadata,
  SemanticType,
  Standardization,
} from "@psilink/core";

/**
 * The acceptor's "Confirm your columns" work surface (step 3 of 3): a port of the
 * hardened legacy column editor's primary column, reseated in the bench
 * furniture. Presentational over the shared column-step state the bench owns -- the
 * verdict, mapper, and gate view-models come in derived from
 * {@link acceptorColumnsModel}, and edits go up through the callbacks; the pure logic
 * and the launch payload live in the bench and the model, not here.
 *
 * The verdict and the launch consume the SAME `editorState`, so the visible gate and
 * the exchange that runs cannot disagree. The mapper appears only when a required
 * field type is still missing; a remap re-roles the chosen column for matching (it
 * calls the bench's `onRemap`, which forces role linkage), never a bare retype.
 */
export function AcceptorColumnsStep({
  linkageTerms,
  columns,
  columnsState,
  editorState,
  verdict,
  onMetadataChange,
  onRemap,
  onReset,
  onLaunch,
  onBack,
}: {
  linkageTerms: LinkageTerms;
  /** The acceptor's own CSV column names. */
  columns: Array<string>;
  columnsState: AcceptorColumnsState;
  /** The effective `{ metadata, standardization }` the verdict and launch consume. */
  editorState: { metadata: Metadata; standardization: Standardization };
  verdict: AcceptorVerdictViewModel;
  onMetadataChange: (next: Metadata) => void;
  /** Bind a missing field type to a chosen column, forcing role linkage. */
  onRemap: (type: SemanticType, columnName: string) => void;
  onReset: () => void;
  onLaunch: () => void;
  /** Return to the consent step to choose a different file. */
  onBack: () => void;
}) {
  // Focus the heading on entry so a keyboard/screen-reader user who pressed
  // "Accept and continue" lands on this step rather than an unmounted button. The
  // bench also drives step-heading focus, but this step owns the verdict focus
  // target below, so it manages its own heading too.
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  // The verdict is one stable node; it is also the focus target after a quick-fix
  // remap, whose Select unmounts the moment its field becomes satisfiable -- focus
  // lands on the verdict (the result) rather than falling to <body>.
  const verdictRef = useRef<HTMLDivElement>(null);

  const deferredVerdictAnnouncement = useDeferredAnnouncement(
    verdict.announcement,
  );

  const unsatisfiedTypes = acceptorUnsatisfiedTypes(
    columns,
    linkageTerms,
    editorState,
  );
  const disclosed = acceptorDisclosedColumns(editorState.metadata);
  const standardizationValid = acceptorStandardizationValid(
    editorState.standardization,
  );
  const launchDisabled = acceptorLaunchDisabled(verdict, editorState);

  const remap = (type: LinkageField["type"], columnName: string) => {
    // Move focus to the verdict before the chosen Select unmounts (it does as soon
    // as the field is satisfied), so a keyboard/screen-reader user lands on the
    // result instead of being dropped to <body>. The verdict node is stable, so
    // focusing it here -- ahead of the re-render -- is safe.
    verdictRef.current?.focus();
    onRemap(type, columnName);
  };

  return (
    <>
      <button type="button" className={styles.backlink} onClick={onBack}>
        {"←"} Choose a different file
      </button>
      <p className={styles.eyebrow}>Step 3 of 3</p>
      <h1 tabIndex={-1} ref={headingRef}>
        Confirm your columns
      </h1>
      <p className={`${styles.small} ${styles.sub}`}>
        Tell us what each column in your file is and what should be done with
        it. Nothing here is sent to your partner except the columns you mark as
        shared; these settings stay on your device.
      </p>

      <Stack>
        {/* The verdict's VISIBLE alert renders immediately (no flash or layout
            shift). This wrapper is NOT a live region and its inner Alert is
            role="presentation", so nothing here announces directly; the spoken
            verdict is voiced by the deferred polite region below, decoupled so a
            verdict already present on mount is announced as an empty -> non-empty
            transition. tabIndex=-1 keeps this the focus target after a remap. */}
        <div ref={verdictRef} tabIndex={-1} data-testid="verdict">
          {verdict.kind === "blocked" ? (
            <Alert
              role="presentation"
              color="red"
              icon={<IconAlertCircle aria-hidden />}
              title={verdict.title}
            >
              None of the agreed linkage keys can be satisfied by your columns,
              so no matches are possible. Set the columns below to the missing
              field types, then this will clear.
            </Alert>
          ) : verdict.kind === "partial" ? (
            <Alert
              role="presentation"
              color="yellow"
              icon={<IconAlertTriangle aria-hidden />}
              title={verdict.title}
            >
              Some linkage keys cannot be satisfied by your columns and will be
              inactive for this exchange. The other keys will proceed normally.
              You can map more columns below to enable additional keys.
            </Alert>
          ) : (
            <Alert
              role="presentation"
              color="green"
              icon={<IconCircleCheck aria-hidden />}
              title={verdict.title}
            >
              Every key in the invitation is covered by your columns.
            </Alert>
          )}
        </div>
        {/* The verdict's announcement channel: a stable polite region whose deferred
            text reaches assistive tech without fighting the heading focus on mount. */}
        <VisuallyHidden
          role="status"
          aria-live="polite"
          aria-atomic="true"
          data-testid="verdict-announcement"
        >
          {deferredVerdictAnnouncement}
        </VisuallyHidden>

        {/* A dead key the column verdict cannot see: the columns are present, but a
            cleaning rule in the partner's terms drops every record, so the key can
            never match. Its own advisory -- role="note", amber not red -- because the
            remedy is the partner's (a corrected invitation), not a column remap here.
            A count only, never the partner-controlled key names. Static (the terms'
            rules do not change as the operator edits), so not a live region. */}
        {verdict.deadKeyCount > 0 && (
          <Alert
            role="note"
            color="orange"
            icon={<IconAlertTriangle aria-hidden />}
            title={
              verdict.deadKeyCount === 1
                ? "A linkage key's rule drops every record"
                : `${verdict.deadKeyCount} linkage keys have a rule that drops every record`
            }
          >
            {verdict.deadKeyCount === 1 ? "A key has" : "Some keys have"} a
            cleaning rule in the agreed terms that drops every record, so{" "}
            {verdict.deadKeyCount === 1 ? "it" : "they"} would contribute no
            matches no matter what your file contains. The key came with the
            invitation, so you cannot edit it here - ask your partner for a
            corrected invitation.
          </Alert>
        )}

        {/* Directly under the verdict, co-located because it is what the operator
            acts on next: while a field type is still missing, the quick-fix remap;
            once every type is mappable, the static "what you'll send" summary. */}
        {unsatisfiedTypes.length > 0 ? (
          <Paper withBorder p="md">
            <Text size="sm" fw={600} mb="xs">
              Map a column to each missing field
            </Text>
            <Stack gap="sm">
              {unsatisfiedTypes.map(({ type, label }) => (
                // A native <select> (like the inviter's Matching & sharing table),
                // not a Mantine portal dropdown: the mockup shows a native select
                // here, and the bench's responsive grid drives a ResizeObserver loop
                // that mispositions a portalled dropdown. The first option is a
                // disabled placeholder so no column is preselected.
                <NativeSelect
                  key={type}
                  label={label}
                  description={`No column is set to ${label.toLowerCase()} yet`}
                  value=""
                  data={[
                    { value: "", label: "Choose a column", disabled: true },
                    ...columns.map((column) => ({
                      value: column,
                      label: column,
                    })),
                  ]}
                  onChange={(event) => {
                    const columnName = event.currentTarget.value;
                    if (columnName !== "") remap(type, columnName);
                  }}
                />
              ))}
            </Stack>
          </Paper>
        ) : (
          <Paper withBorder p="md">
            <Text size="sm" fw={600} mb={4}>
              What you will send to your partner
            </Text>
            {disclosed.length === 0 ? (
              <Text size="xs" c="dimmed">
                No additional columns. Your columns are used only to find
                matches; for each matched row you receive the columns your
                partner marks as sent.
              </Text>
            ) : (
              <Text size="xs">
                {/* These are the operator's OWN CSV headers, not a sanitized
                    summary value, so sanitize them for display like every other
                    column-name surface -- a header carrying bidi/zero-width/
                    homoglyph characters must not misrepresent to the operator
                    what leaves their machine. */}
                For each matched row:{" "}
                {disclosed
                  .map((column) => sanitizeForDisplay(column))
                  .join(", ")}
                .
              </Text>
            )}
          </Paper>
        )}

        <MetadataGrid
          metadata={columnsState.metadata}
          onChange={onMetadataChange}
          caption="Your columns: type and use"
        />
        <p className={`${styles.small} ${styles.sub}`}>
          Only one column can be the row identifier. Choose a single identifier.
        </p>

        {!standardizationValid && (
          <Text size="xs" c="red" role="alert">
            Finish or fix the highlighted cleaning steps before continuing.
          </Text>
        )}
      </Stack>

      <div className={styles.workFoot}>
        <Button onClick={onLaunch} disabled={launchDisabled}>
          Start the exchange
        </Button>
        <Button variant="subtle" onClick={onReset}>
          Reset to defaults
        </Button>
      </div>
    </>
  );
}
