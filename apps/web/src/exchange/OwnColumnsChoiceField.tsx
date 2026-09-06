import { NativeSelect, VisuallyHidden } from "@mantine/core";

import { ColumnName, isolatedColumnName } from "@components/ColumnName";
import { useDeferredAnnouncement } from "@components/useDeferredAnnouncement";

import {
  OWN_COLUMNS_LABELS,
  OWN_COLUMNS_LOCAL_NOTICE,
  OWN_COLUMNS_ORDER,
  ownColumnsEmptySelectionNotice,
  ownColumnsPreview,
} from "@psi/ownColumnsModel";

import styles from "@styles/app.module.css";

import type { Metadata } from "@psilink/core";
import type { OwnColumnsChoice } from "@psi/ownColumnsModel";

/**
 * The "Your own columns in the result" control: which of this party's own input
 * columns its result file holds beside the partner's values, and the list of
 * the columns the current choice writes.
 *
 * Presentational over the choice and this party's metadata; the choice goes up
 * through `onChange`. Whether the control is offered at all is the caller's --
 * an exchange with no result table for this party has nothing for the choice to
 * act on ({@link ownColumnsActionable}), and the caller renders nothing there.
 *
 * The copy says what the operator's OWN file holds and states, at the control,
 * that nothing about the partner changes: the control's neighbours all govern
 * what the partner sees, so the one that does not says so where it is set
 * rather than in a reference the operator may not open.
 *
 * Column names go through {@link ColumnName}, the treatment every column-name
 * display on these screens uses, so a header reads the same here as in the grid
 * row above it.
 */
export function OwnColumnsChoiceField({
  metadata,
  choice,
  onChange,
}: {
  metadata: Metadata;
  choice: OwnColumnsChoice;
  onChange: (choice: OwnColumnsChoice) => void;
}) {
  const kept = ownColumnsPreview(metadata, choice);
  // The visible list below states the same set, but a select's own change event
  // announces only the option label; this voices what the label resolves to for
  // this file. Deferred so a burst of changes announces once.
  const keptAnnouncement = useDeferredAnnouncement(
    choice === "none"
      ? "Your result file will hold your partner's values only."
      : kept.length === 0
        ? "No column of yours is left to add to your result file."
        : `Columns added to your result file: ${kept
            .map(isolatedColumnName)
            .join(", ")}.`,
  );
  return (
    <>
      <h2>Your own columns in the result</h2>
      <NativeSelect
        label="What your result file holds beside your partner's values"
        description="Your result file already begins with your record identifier and your partner's row number."
        value={choice}
        data={OWN_COLUMNS_ORDER.map((option) => ({
          value: option,
          label: OWN_COLUMNS_LABELS[option],
        }))}
        onChange={(event) =>
          onChange(event.currentTarget.value as OwnColumnsChoice)
        }
      />
      <p className={`${styles.small} ${styles.sub}`}>
        {OWN_COLUMNS_LOCAL_NOTICE}
      </p>
      {choice !== "none" &&
        (kept.length > 0 ? (
          <>
            <p>
              For each row that matches, your result file will also hold these
              columns of your own:
            </p>
            <ul className={styles.columnChips}>
              {kept.map((column) => (
                <li key={column} className={styles.mono}>
                  <ColumnName name={column} />
                </li>
              ))}
            </ul>
          </>
        ) : (
          <div className={styles.stateInset}>
            <p className={styles.stateLabel}>No column left to add</p>
            <p className={styles.small} style={{ margin: 0 }}>
              {ownColumnsEmptySelectionNotice(choice)}
            </p>
          </div>
        ))}
      <VisuallyHidden role="status" aria-live="polite" aria-atomic="true">
        {keptAnnouncement}
      </VisuallyHidden>
    </>
  );
}
