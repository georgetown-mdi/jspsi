import { NativeSelect, TextInput } from "@mantine/core";

import {
  CSV_DELIMITER_OPTIONS,
  CSV_DELIMITER_OTHER,
  resolveCsvDelimiter,
} from "@components/csvDelimiterChoice";

import styles from "@styles/app.module.css";

import type { CsvDelimiterChoice } from "@components/csvDelimiterChoice";

/** The one sentence every surface offering the control states about its reach: the
 * choice governs this party's own file and result, and nothing the partner does. */
export const CSV_DELIMITER_LOCAL_NOTICE =
  "This is how your own file is read and your own result file written. Your partner sets theirs separately.";

/**
 * The "How your file separates fields" control, offered beside a file picker: a
 * compact select of the four common delimiters, a detect option for a file whose
 * separator the operator would rather have taken from the file itself, and
 * "Other" revealing a field for any other accepted character. It starts on the
 * comma, the delimiter a read takes when nobody chooses.
 *
 * It sits at the picker rather than under an advanced heading because a delimiter
 * read wrongly puts every field of a row in one column, which fails the whole run.
 *
 * Presentational over the choice; the rule and the refusal are
 * {@link resolveCsvDelimiter}'s, so this control and the command line refuse the
 * same values in the same words. A refused choice renders the refusal at the field
 * -- the caller blocks its own action on the same resolution.
 */
export function CsvDelimiterField({
  choice,
  onChange,
  disabled,
  note,
}: {
  choice: CsvDelimiterChoice;
  onChange: (choice: CsvDelimiterChoice) => void;
  /** Set while a read is in flight, so the file being parsed and the delimiter it
   * is parsed by cannot disagree. */
  disabled?: boolean;
  /** A line under the control stating what this surface does with the choice --
   * {@link CSV_DELIMITER_LOCAL_NOTICE} where a result file is written by it.
   * Omitted where the surface only reads. */
  note?: string;
}) {
  const resolution = resolveCsvDelimiter(choice);
  return (
    <>
      <NativeSelect
        mt="md"
        label="How your file separates fields"
        value={choice.option}
        data={CSV_DELIMITER_OPTIONS.map((option) => ({
          value: option.value,
          label: option.label,
        }))}
        disabled={disabled}
        onChange={(event) =>
          onChange({ ...choice, option: event.currentTarget.value })
        }
      />
      {choice.option === CSV_DELIMITER_OTHER && (
        <TextInput
          mt="xs"
          w="20rem"
          label="Field separator character"
          description="One character; write a tab as tab, or detect to take it from the file."
          value={choice.other}
          disabled={disabled}
          error={resolution.ok ? undefined : resolution.refusal}
          onChange={(event) =>
            onChange({ ...choice, other: event.currentTarget.value })
          }
        />
      )}
      {note !== undefined && (
        <p className={`${styles.small} ${styles.sub}`}>{note}</p>
      )}
    </>
  );
}
