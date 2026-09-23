/**
 * The pure model behind the stored exchange's editor for the three settings of
 * its document that are this party's alone -- which of its own columns its
 * result file holds (`includeOwnColumns`), how its input file separates fields
 * (`csvDelimiter`), and the retention note filed with its exchange record
 * (`retentionDisposition`): what each control starts on for a stored document,
 * what a save writes, and what re-reading the input file under a changed
 * delimiter found. No React and no I/O.
 *
 * None of the three is a term: nothing about them is sent to the partner or
 * folded into the agreed-terms hash, so each edits in place on a stored record
 * (docs/spec/MANAGED_EXCHANGE_RECORD.md, "Local settings of the document").
 */

import { DEFAULT_CSV_DELIMITER } from "@psilink/core";

import {
  CSV_DELIMITER_OPTIONS,
  CSV_DELIMITER_OTHER,
  INITIAL_CSV_DELIMITER_CHOICE,
  resolveCsvDelimiter,
} from "@components/csvDelimiterChoice";
import { assessManagedInputColumns } from "@psi/managed/managedInputGuard";
import { ownColumnsActionable } from "@psi/ownColumnsModel";
import { retentionNoteValue } from "@exchange/manageOfferModel";

import type { CsvDelimiterChoice } from "@components/csvDelimiterChoice";
import type { ExchangeSpec } from "@psilink/core";
import type { ManagedExchangeLocalEdits } from "@psi/managed/managedExchangeRecord";
import type { OwnColumnsChoice } from "@psi/ownColumnsModel";

/** The three controls' values as the operator has them. */
export interface LocalDocumentFieldValues {
  ownColumns: OwnColumnsChoice;
  delimiter: CsvDelimiterChoice;
  /** The retention note as typed. */
  retentionNote: string;
}

/** The edits a save of the three controls writes. */
export type LocalDocumentFieldEdits = Pick<
  ManagedExchangeLocalEdits,
  "includeOwnColumns" | "csvDelimiter" | "retentionDisposition"
>;

/**
 * The delimiter choice that shows a stored `csvDelimiter`: the named option
 * where the value is one, "Other" holding the value where it is not, and the
 * comma a document without the field is read by.
 */
export function csvDelimiterChoiceFrom(
  stored: string | undefined,
): CsvDelimiterChoice {
  if (stored === undefined) return INITIAL_CSV_DELIMITER_CHOICE;
  const named = CSV_DELIMITER_OPTIONS.some(
    (option) => option.value !== CSV_DELIMITER_OTHER && option.value === stored,
  );
  return named
    ? { option: stored, other: "" }
    : { option: CSV_DELIMITER_OTHER, other: stored };
}

/** What each control starts on for a stored document: the values it holds. */
export function localDocumentFieldValuesFrom(
  exchangeFile: ExchangeSpec,
): LocalDocumentFieldValues {
  return {
    ownColumns: exchangeFile.includeOwnColumns ?? "none",
    delimiter: csvDelimiterChoiceFrom(exchangeFile.csvDelimiter),
    retentionNote: exchangeFile.retentionDisposition ?? "",
  };
}

/**
 * Whether the own-columns control is offered for a document: only where its
 * terms write this party a result file for the choice to act on, the rule
 * setup applies ({@link ownColumnsActionable}). Where it is not offered, a save
 * leaves the stored value as it is.
 */
export function ownColumnsOffered(exchangeFile: ExchangeSpec): boolean {
  return ownColumnsActionable(exchangeFile.linkageTerms);
}

/**
 * The delimiter the stored document is read by: its `csvDelimiter`, or the
 * comma where it holds none.
 */
export function storedCsvDelimiter(exchangeFile: ExchangeSpec): string {
  return exchangeFile.csvDelimiter ?? DEFAULT_CSV_DELIMITER;
}

/**
 * The delimiter a changed choice resolves to, or `undefined` where the choice
 * is unchanged from the stored document or refused. The editor re-reads the
 * input file only for a delimiter this returns.
 */
export function changedCsvDelimiter(
  exchangeFile: ExchangeSpec,
  choice: CsvDelimiterChoice,
): string | undefined {
  const resolution = resolveCsvDelimiter(choice);
  if (!resolution.ok) return undefined;
  return resolution.delimiter === storedCsvDelimiter(exchangeFile)
    ? undefined
    : resolution.delimiter;
}

/**
 * What a save writes for the three controls: an edit for each value that
 * differs from the stored document, and nothing for one that does not, so a
 * save that changed only the label leaves the document as it was imported. A
 * `null` drops the field: "Nothing of mine" for the own-columns choice, and an
 * empty retention note. A refused delimiter writes nothing; the editor blocks
 * the save on it.
 */
export function localDocumentFieldEdits(
  exchangeFile: ExchangeSpec,
  values: LocalDocumentFieldValues,
): LocalDocumentFieldEdits {
  const edits: LocalDocumentFieldEdits = {};
  if (
    ownColumnsOffered(exchangeFile) &&
    values.ownColumns !== (exchangeFile.includeOwnColumns ?? "none")
  )
    edits.includeOwnColumns =
      values.ownColumns === "none" ? null : values.ownColumns;
  const delimiter = changedCsvDelimiter(exchangeFile, values.delimiter);
  if (delimiter !== undefined) edits.csvDelimiter = delimiter;
  if (values.retentionNote !== (exchangeFile.retentionDisposition ?? ""))
    edits.retentionDisposition =
      retentionNoteValue(values.retentionNote) ?? null;
  return edits;
}

/**
 * What re-reading the stored input file under a changed delimiter found:
 *
 * - `reading` -- the read is under way; the save waits for it.
 * - `fits` -- the file reads into columns that cover every agreed key.
 * - `short` -- the file reads, but its columns do not cover every agreed key;
 *   `singleColumn` where it read as one column, the shape of a file separated
 *   by some other character.
 * - `unreadable` -- this browser could not read the file without asking for
 *   permission, or the file is missing or does not parse.
 */
export type DelimiterRecheck =
  | { kind: "reading" }
  | { kind: "fits"; columnCount: number }
  | { kind: "short"; singleColumn: boolean }
  | { kind: "unreadable" };

/** Grade the columns a re-read found against the document's agreed terms, the
 * grade every run applies before it connects ({@link assessManagedInputColumns}). */
export function delimiterRecheckFrom(
  exchangeFile: ExchangeSpec,
  columns: ReadonlyArray<string>,
): DelimiterRecheck {
  const rejection = assessManagedInputColumns(exchangeFile, columns);
  if (rejection === undefined)
    return { kind: "fits", columnCount: columns.length };
  return {
    kind: "short",
    singleColumn: rejection.reason === "columns" && rejection.singleColumn,
  };
}

/** What the editor states about a re-read, or `undefined` while it runs. */
export function delimiterRecheckNote(
  recheck: DelimiterRecheck,
): { tone: "ok" | "warning"; message: string } | undefined {
  switch (recheck.kind) {
    case "reading":
      return undefined;
    case "fits":
      return {
        tone: "ok",
        message:
          `Your input file reads as ${recheck.columnCount} ` +
          (recheck.columnCount === 1 ? "column" : "columns") +
          " with this separator, covering every agreed key.",
      };
    case "short":
      return {
        tone: "warning",
        message: recheck.singleColumn
          ? "Your input file reads as a single column with this separator, " +
            "so its fields are likely separated by another character. " +
            "Choose your file's separator, or Detect to take it from the file."
          : "Your input file reads with this separator, but its columns do " +
            "not cover every agreed key, so a run would be refused before it " +
            "connects. Check that this is your file's separator.",
      };
    case "unreadable":
      return {
        tone: "warning",
        message:
          "This browser could not read your input file to check it with " +
          "this separator. The next run reads it this way; check that this " +
          "is your file's separator.",
      };
  }
}
