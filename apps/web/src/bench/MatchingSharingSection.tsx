import { Button, NativeSelect } from "@mantine/core";

import {
  DISCLOSURE_LABELS,
  SEMANTIC_TYPE_LABELS,
  disclosureChoicesForType,
  disclosureOf,
} from "@psi/metadataEditing";

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
                <td className={styles.mono}>{column.name}</td>
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
        Only one column can be the row identifier. Choose a single identifier.
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
