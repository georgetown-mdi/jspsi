import { useEffect, useRef, useState } from "react";

import { Button, NativeSelect, VisuallyHidden } from "@mantine/core";

import {
  DISCLOSURE_LABELS,
  SEMANTIC_TYPE_LABELS,
  disclosureChoicesForType,
  disclosureOf,
  hasMultipleIdentifiers,
} from "@psi/metadataEditing";

import { useDeferredAnnouncement } from "@components/useDeferredAnnouncement";

import { disclosedColumnNames } from "@psilink/core";

import styles from "./bench.module.css";

import type { Metadata, SemanticType } from "@psilink/core";
import type { DisclosureChoice } from "@psi/metadataEditing";

const SEMANTIC_TYPES = Object.keys(SEMANTIC_TYPE_LABELS) as Array<SemanticType>;

/**
 * Step 2 of the inviter spine -- the one mandatory review: what each column is
 * and what it is used for, which together decide exactly what the partner can
 * ever see. Presentational over the host's metadata; edits go up through the
 * two callbacks and the single-identifier rule's demotions come back down as
 * `announcement`.
 */
export function MatchingSharingSection({
  metadata,
  onColumnType,
  onColumnDisclosure,
  announcement,
  onContinue,
}: {
  metadata: Metadata;
  onColumnType: (columnName: string, type: SemanticType) => void;
  onColumnDisclosure: (columnName: string, choice: DisclosureChoice) => void;
  /** The demotion notice from the last edit, announced politely and rendered
   * under the table; empty when the last edit displaced nothing. */
  announcement: string;
  onContinue: () => void;
}) {
  const sent = disclosedColumnNames(metadata);

  // The visible send set lives in the ledger and the extra-data block, which
  // cannot speak for the selects; this debounced region voices the new set as
  // it changes, computed from the same predicate the run transmits on. The
  // timer clears on every change and on unmount, so an edit burst announces
  // once.
  const summary =
    sent.length === 0
      ? "No columns will be sent to your partner."
      : `Columns sent to your partner: ${sent.join(", ")}.`;
  const [summaryAnnouncement, setSummaryAnnouncement] = useState("");
  const summaryRef = useRef(summary);
  summaryRef.current = summary;
  useEffect(() => {
    const handle = setTimeout(
      () => setSummaryAnnouncement(summaryRef.current),
      600,
    );
    return () => clearTimeout(handle);
  }, [summary]);

  // The two-identifier conflict's visible surfaces are the standing hint and
  // the work column's Problems entry, per the design; this deferred region is
  // its audible half, voiced even when a seed mounts already in conflict.
  const conflictAnnouncement = useDeferredAnnouncement(
    hasMultipleIdentifiers(metadata)
      ? "Problem: choose a single record identifier."
      : "",
  );
  return (
    <>
      <p className={styles.eyebrow}>Step 2 of 3</p>
      <h1 tabIndex={-1}>Matching &amp; sharing</h1>
      <p>
        Confirm what each column is and what it is used for. This is the one
        review every exchange needs: it decides exactly what your partner can
        ever see.
      </p>
      <div className={styles.tableScroll}>
        <table className={styles.benchTable}>
          <caption className={styles.visuallyHidden}>
            Your columns: type and use
          </caption>
          <thead>
            <tr>
              <th scope="col">Column</th>
              <th scope="col">Type</th>
              <th scope="col">How it is used</th>
            </tr>
          </thead>
          <tbody>
            {metadata.map((column) => (
              <tr key={column.name}>
                <th
                  scope="row"
                  className={`${styles.mono} ${styles.rowHeader}`}
                >
                  {column.name}
                </th>
                <td>
                  <NativeSelect
                    aria-label={`Type for ${column.name}`}
                    value={column.type}
                    data={SEMANTIC_TYPES.map((type) => ({
                      value: type,
                      label: SEMANTIC_TYPE_LABELS[type],
                    }))}
                    onChange={(event) =>
                      onColumnType(
                        column.name,
                        event.currentTarget.value as SemanticType,
                      )
                    }
                  />
                </td>
                <td>
                  <NativeSelect
                    aria-label={`How ${column.name} is used`}
                    value={disclosureOf(column)}
                    data={disclosureChoicesForType(column.type).map(
                      (choice) => ({
                        value: choice,
                        label: DISCLOSURE_LABELS[choice],
                      }),
                    )}
                    onChange={(event) =>
                      onColumnDisclosure(
                        column.name,
                        event.currentTarget.value as DisclosureChoice,
                      )
                    }
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className={`${styles.small} ${styles.sub}`}>
        Only one column can be the record identifier. Choose a single
        identifier.
      </p>
      {/* Always mounted so assistive tech observes content changes; kept
          separate from the hint above so clearing a notice never re-announces
          the hint. */}
      <p
        className={`${styles.small} ${styles.sub}`}
        aria-live="polite"
        aria-atomic="true"
      >
        {announcement}
      </p>
      <VisuallyHidden role="status" aria-live="polite" aria-atomic="true">
        {summaryAnnouncement}
      </VisuallyHidden>
      <VisuallyHidden role="status" aria-live="polite" aria-atomic="true">
        {conflictAnnouncement}
      </VisuallyHidden>
      <h2>Extra data for matched records</h2>
      <p className={styles.small}>
        <strong>You will send:</strong>{" "}
        {sent.length > 0 ? (
          <span className={styles.mono}>{sent.join(", ")}</span>
        ) : (
          "nothing"
        )}
        <br />
        <strong>You will receive:</strong> the columns your partner marks as
        sent, for each matched row.
      </p>
      {sent.length > 0 ? (
        <>
          <p>
            For each row in your file that matches, you will send your partner
            these elements:
          </p>
          <ul className={styles.columnChips}>
            {sent.map((column) => (
              <li key={column} className={styles.mono}>
                {column}
              </li>
            ))}
          </ul>
          <p className={`${styles.small} ${styles.sub}`}>
            You can change these with the &quot;How it is used&quot; selects
            above. Your partner never receives the values in your non-matching
            rows.
          </p>
        </>
      ) : (
        <div className={styles.stateInset}>
          <p className={styles.stateLabel}>
            No columns marked &quot;sent to your partner&quot;
          </p>
          <p className={styles.small} style={{ margin: 0 }}>
            No values will be sent to your partner. Your file&apos;s columns are
            used only to find matches.
          </p>
        </div>
      )}
      <div className={styles.workFoot}>
        <Button onClick={onContinue}>Continue to review &amp; create</Button>
      </div>
    </>
  );
}
