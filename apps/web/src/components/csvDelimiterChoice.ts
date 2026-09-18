import {
  csvDelimiterRefusal,
  isCsvDelimiter,
  normalizeCsvDelimiter,
} from "@psilink/core";

/**
 * The field-delimiter choice an intake surface offers beside its file picker, and
 * the resolution of that choice into the delimiter a read and a result write take.
 *
 * The accepted characters are core's ({@link isCsvDelimiter}), stated in core's own
 * words ({@link csvDelimiterRefusal}), so this app and the command line refuse the
 * same values with the same sentence. The choice is local to this party: it is not
 * a linkage term, rides no invitation, and the partner reads their own file by
 * their own.
 */

/** The select value standing for no chosen delimiter: the read detects one from the
 * file, among the four the parser considers. */
export const CSV_DELIMITER_AUTO = "auto";

/** The select value revealing the free-text field, for a delimiter outside the
 * named options. */
export const CSV_DELIMITER_OTHER = "other";

/** One entry of the delimiter select: the value it stores and the label it shows.
 * The named characters are the four the detection considers, so the option list and
 * {@link CSV_DELIMITER_AUTO}'s own label name the same set. */
export interface CsvDelimiterOption {
  value: string;
  label: string;
}

/** The delimiter select's options, in the order they are offered. */
export const CSV_DELIMITER_OPTIONS: ReadonlyArray<CsvDelimiterOption> = [
  { value: CSV_DELIMITER_AUTO, label: "Detect (comma, tab, pipe, semicolon)" },
  { value: ",", label: "Comma" },
  { value: "\t", label: "Tab" },
  { value: "|", label: "Pipe" },
  { value: ";", label: "Semicolon" },
  { value: CSV_DELIMITER_OTHER, label: "Other" },
];

/** What the operator has selected: the select's value, plus what they typed in the
 * field {@link CSV_DELIMITER_OTHER} reveals (kept while another option is selected,
 * so switching away and back does not lose it). */
export interface CsvDelimiterChoice {
  option: string;
  other: string;
}

/** The choice an intake surface starts on: detection, with nothing typed. */
export const DETECTED_CSV_DELIMITER_CHOICE: CsvDelimiterChoice = {
  option: CSV_DELIMITER_AUTO,
  other: "",
};

/**
 * What a choice resolves to. A refused choice yields no delimiter at all, so a
 * surface cannot read a file by a value the rule rejects: it has only the refusal
 * to show and an action to block.
 */
export type CsvDelimiterResolution =
  { ok: true; delimiter: string | undefined } | { ok: false; refusal: string };

/**
 * Resolve `choice` into the delimiter a read and the result write take: `undefined`
 * for detection, the character itself for a named option, and for
 * {@link CSV_DELIMITER_OTHER} the typed value resolved through
 * {@link normalizeCsvDelimiter} (so the tab spellings are taken here as they are on
 * the command line) and graded by {@link isCsvDelimiter}.
 */
export function resolveCsvDelimiter(
  choice: CsvDelimiterChoice,
): CsvDelimiterResolution {
  if (choice.option === CSV_DELIMITER_AUTO)
    return { ok: true, delimiter: undefined };
  if (choice.option !== CSV_DELIMITER_OTHER)
    return { ok: true, delimiter: choice.option };
  const resolved = normalizeCsvDelimiter(choice.other);
  return isCsvDelimiter(resolved)
    ? { ok: true, delimiter: resolved }
    : { ok: false, refusal: csvDelimiterRefusal(choice.other) };
}

/**
 * The choice that shows `delimiter`: a named option where one holds that
 * character, {@link CSV_DELIMITER_OTHER} holding it otherwise, and detection for an
 * absent one. Restores a stored delimiter (a managed record's) onto the surface
 * that offers it.
 */
export function csvDelimiterChoiceFor(
  delimiter: string | undefined,
): CsvDelimiterChoice {
  if (delimiter === undefined) return DETECTED_CSV_DELIMITER_CHOICE;
  const named = CSV_DELIMITER_OPTIONS.find(
    (option) => option.value === delimiter,
  );
  return named !== undefined
    ? { option: named.value, other: "" }
    : { option: CSV_DELIMITER_OTHER, other: delimiter };
}
