import {
  CSV_DELIMITER_DETECT,
  DEFAULT_CSV_DELIMITER,
  csvDelimiterRefusal,
  isCsvDelimiterChoice,
  normalizeCsvDelimiter,
} from "@psilink/core";

/**
 * The field-delimiter choice an intake surface offers beside its file picker, and
 * the resolution of that choice into the delimiter a read and a result write take.
 *
 * The accepted values are core's ({@link isCsvDelimiterChoice}), stated in core's
 * own words ({@link csvDelimiterRefusal}), so this app and the command line refuse
 * the same values with the same sentence. The choice is local to this party: it
 * is not a linkage term, rides no invitation, and the partner reads their own
 * file by their own.
 */

/** The select value revealing the free-text field, for a delimiter outside the
 * named options. */
export const CSV_DELIMITER_OTHER = "other";

/** One entry of the delimiter select: the value it stores and the label it shows.
 * The named characters are the four common ones; detection reaches past them, which
 * is what the {@link CSV_DELIMITER_DETECT} entry's own label states. */
export interface CsvDelimiterOption {
  value: string;
  label: string;
}

/** The delimiter select's options, in the order they are offered: the comma a read
 * takes when nobody chooses, the other common characters, detection, and the
 * free-text field. */
export const CSV_DELIMITER_OPTIONS: ReadonlyArray<CsvDelimiterOption> = [
  { value: DEFAULT_CSV_DELIMITER, label: "Comma" },
  { value: "\t", label: "Tab" },
  { value: "|", label: "Pipe" },
  { value: ";", label: "Semicolon" },
  {
    value: CSV_DELIMITER_DETECT,
    label: "Detect (comma, tab, pipe, semicolon, and others)",
  },
  { value: CSV_DELIMITER_OTHER, label: "Other" },
];

/** What the operator has selected: the select's value, plus what they typed in the
 * field {@link CSV_DELIMITER_OTHER} reveals (kept while another option is selected,
 * so switching away and back does not lose it). */
export interface CsvDelimiterChoice {
  option: string;
  other: string;
}

/** The choice an intake surface starts on: the comma, with nothing typed. Detection
 * is offered beside it as a choice the operator makes rather than one they are
 * started on, so a file read a way nobody chose is not the default. */
export const INITIAL_CSV_DELIMITER_CHOICE: CsvDelimiterChoice = {
  option: DEFAULT_CSV_DELIMITER,
  other: "",
};

/**
 * What a choice resolves to. A refused choice yields no delimiter at all, so a
 * surface cannot read a file by a value the rule rejects: it has only the refusal
 * to show and an action to block.
 */
export type CsvDelimiterResolution =
  { ok: true; delimiter: string } | { ok: false; refusal: string };

/**
 * What a refusal adds when a file's whole header read as ONE column: the
 * reading, and the delimiter to change. A file separated by something other than
 * the delimiter it was read by reaches a column check that way, so the column
 * refusals state this rather than leaving the operator with terms to renegotiate.
 *
 * Every intake surface of both builds offers the control this names
 * ({@link CsvDelimiterField}), the console's mounted-file picker included, so the
 * remedy is one sentence rather than a per-build pair.
 */
export const CSV_DELIMITER_SINGLE_COLUMN_REMEDY =
  "This file read as a single column, so its fields may be separated by a " +
  "character other than the one it was read with. Set " +
  '"How your file separates fields" to your file\'s separator, or choose ' +
  "Detect to take it from the file.";

/**
 * Resolve `choice` into the delimiter a read and the result write take: the
 * character itself for a named option, {@link CSV_DELIMITER_DETECT} for the detect
 * option -- the value core's read takes for detection and a record stores for it --
 * and for {@link CSV_DELIMITER_OTHER} the typed value resolved through
 * {@link normalizeCsvDelimiter} (so the tab spellings and the detect word are taken
 * here as they are on the command line) and graded by
 * {@link isCsvDelimiterChoice}, which is the grade every authoring boundary
 * applies.
 */
export function resolveCsvDelimiter(
  choice: CsvDelimiterChoice,
): CsvDelimiterResolution {
  if (choice.option !== CSV_DELIMITER_OTHER)
    return { ok: true, delimiter: choice.option };
  const resolved = normalizeCsvDelimiter(choice.other);
  return isCsvDelimiterChoice(resolved)
    ? { ok: true, delimiter: resolved }
    : { ok: false, refusal: csvDelimiterRefusal(choice.other) };
}
