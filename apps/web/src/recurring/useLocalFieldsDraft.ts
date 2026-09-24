import { useState } from "react";

import {
  labelWithinCap,
  maxAgeDaysError,
  retentionNoteError,
} from "@exchange/manageOfferModel";
import { OPT_IN_TOKEN_MAX_AGE_DAYS } from "@psi/tokenMaxAge";
import { resolveCsvDelimiter } from "@components/csvDelimiterChoice";

import {
  changedCsvDelimiter,
  localDocumentFieldEdits,
  localDocumentFieldValuesFrom,
  ownColumnsOffered,
} from "./localDocumentFieldsModel";
import { useDelimiterRecheck } from "./useDelimiterRecheck";

import type {
  DelimiterRecheck,
  LocalDocumentFieldEdits,
  LocalDocumentFieldValues,
} from "./localDocumentFieldsModel";
import type { CsvDelimiterChoice } from "@components/csvDelimiterChoice";
import type { ExchangeSpec } from "@alcove/core";
import type { OwnColumnsChoice } from "@psi/ownColumnsModel";

/** The record fields this draft edits: what a surface seeds it from. */
interface LocalFieldsSource {
  label: string;
  tokenMaxAgeDays?: number;
  exchangeFile: ExchangeSpec;
  inputFileHandle?: FileSystemFileHandle;
}

/** The label, max-age, and document-settings draft a surface edits, and what
 * it needs to show and save it. */
export interface LocalFieldsDraft {
  /** The label as typed. */
  label: string;
  /** The max-age policy the operator has opted into. */
  maxAgeEnabled: boolean;
  /** The day count as the NumberInput reports it. */
  maxAgeDays: number | string;
  editLabel: (label: string) => void;
  editMaxAgeEnabled: (enabled: boolean) => void;
  editMaxAgeDays: (days: number | string) => void;
  /** Which of this party's own columns its result file holds. */
  ownColumns: OwnColumnsChoice;
  /** Whether the document's terms give the own-columns choice a result file
   * to act on; the control is shown only where they do. */
  ownColumnsOffered: boolean;
  editOwnColumns: (choice: OwnColumnsChoice) => void;
  /** How this party's input file separates fields. */
  delimiter: CsvDelimiterChoice;
  editDelimiter: (choice: CsvDelimiterChoice) => void;
  /** What re-reading the stored input file under a changed delimiter found,
   * absent where the delimiter is unchanged or there is no file to re-read. */
  delimiterRecheck: DelimiterRecheck | undefined;
  /** The retention note as typed. */
  retentionNote: string;
  editRetentionNote: (note: string) => void;
  /** The field error the retention note shows, absent where there is none. */
  retentionError: string | undefined;
  /** What the save writes for the document's settings: only the ones the
   * operator changed. */
  documentEdits: LocalDocumentFieldEdits;
  /** Note an edit to a field the surface holds itself, so a save already
   * reported stops being reported as this draft's state. */
  markEdited: () => void;
  /** The field error the max-age input shows, absent where there is none or the
   * policy is off. */
  maxAgeError: string | undefined;
  /** The day count to save, absent where the policy is off or the value is not
   * one yet. */
  tokenMaxAgeDays: number | undefined;
  /** What the save writes for the policy: the day count, or `null` to drop a
   * stored one. */
  tokenMaxAgeDaysEdit: number | null;
  /** Whether the label is within its cap; the label field shows the error. */
  labelValid: boolean;
  /** Whether THESE fields can be saved. A surface holding fields of its own
   * requires this and its own validity. */
  canSave: boolean;
  saving: boolean;
  saved: boolean;
  failed: boolean;
  /** Run a save, holding {@link saving}, {@link saved} and {@link failed} around
   * it. What `write` writes is the surface's own. */
  submit: (write: () => Promise<unknown>) => void;
}

/**
 * The local fields every managed exchange has -- the label this browser shows
 * it under, the max-age policy bounding its secret, and the three settings of
 * its document that are this party's alone ({@link
 * ./localDocumentFieldsModel.ts}) -- as one editing draft: the state, the
 * validation both surfaces gate their save on, and the save's own reported
 * state.
 *
 * A changed delimiter re-reads the stored input file under it
 * ({@link useDelimiterRecheck}), and the save waits for that read, so the
 * editor states how the file reads before the new delimiter is stored.
 *
 * Shared because both surfaces that edit local fields ({@link
 * ./ManagedExchangeDetail.tsx} for a browser-run exchange, {@link
 * ./ManagedConfigurationSurface.tsx} for a configuration-only one) edit them
 * on the same terms, while what each SAVES differs: the detail surface also
 * writes a schedule, and each reaches the store its own way. So this holds the
 * draft and the save's state, and `submit` takes the write.
 *
 * An invalid day count is representable here -- the NumberInput reports a string
 * when cleared or mid-edit -- and blocks the save through {@link
 * LocalFieldsDraft.canSave}, rather than being coerced to a sentinel that
 * silently drops the opted-in bound.
 */
export function useLocalFieldsDraft(
  record: LocalFieldsSource,
): LocalFieldsDraft {
  const [label, setLabel] = useState(record.label);
  const [maxAgeEnabled, setMaxAgeEnabled] = useState(
    record.tokenMaxAgeDays !== undefined,
  );
  const [maxAgeDays, setMaxAgeDays] = useState<number | string>(
    record.tokenMaxAgeDays ?? OPT_IN_TOKEN_MAX_AGE_DAYS,
  );
  const [documentFields, setDocumentFields] =
    useState<LocalDocumentFieldValues>(() =>
      localDocumentFieldValuesFrom(record.exchangeFile),
    );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState(false);

  const maxAgeError = maxAgeEnabled ? maxAgeDaysError(maxAgeDays) : undefined;
  const tokenMaxAgeDays =
    maxAgeEnabled && maxAgeError === undefined && typeof maxAgeDays === "number"
      ? maxAgeDays
      : undefined;
  const labelValid = labelWithinCap(label);
  const delimiterRecheck = useDelimiterRecheck(
    record.exchangeFile,
    record.inputFileHandle,
    changedCsvDelimiter(record.exchangeFile, documentFields.delimiter),
  );
  const retentionError = retentionNoteError(documentFields.retentionNote);
  const documentFieldsValid =
    resolveCsvDelimiter(documentFields.delimiter).ok &&
    retentionError === undefined &&
    delimiterRecheck?.kind !== "reading";

  function editDocumentFields(edit: Partial<LocalDocumentFieldValues>) {
    setDocumentFields((current) => ({ ...current, ...edit }));
    setSaved(false);
  }

  return {
    label,
    maxAgeEnabled,
    maxAgeDays,
    editLabel: (edited) => {
      setLabel(edited);
      setSaved(false);
    },
    editMaxAgeEnabled: (enabled) => {
      setMaxAgeEnabled(enabled);
      setSaved(false);
    },
    editMaxAgeDays: (days) => {
      setMaxAgeDays(days);
      setSaved(false);
    },
    ownColumns: documentFields.ownColumns,
    ownColumnsOffered: ownColumnsOffered(record.exchangeFile),
    editOwnColumns: (ownColumns) => editDocumentFields({ ownColumns }),
    delimiter: documentFields.delimiter,
    editDelimiter: (delimiter) => editDocumentFields({ delimiter }),
    delimiterRecheck,
    retentionNote: documentFields.retentionNote,
    editRetentionNote: (retentionNote) => editDocumentFields({ retentionNote }),
    retentionError,
    documentEdits: localDocumentFieldEdits(record.exchangeFile, documentFields),
    markEdited: () => setSaved(false),
    maxAgeError,
    tokenMaxAgeDays,
    tokenMaxAgeDaysEdit: maxAgeEnabled ? (tokenMaxAgeDays ?? null) : null,
    labelValid,
    canSave:
      labelValid && !saving && maxAgeError === undefined && documentFieldsValid,
    saving,
    saved,
    failed,
    submit: (write) => {
      setSaving(true);
      setSaved(false);
      setFailed(false);
      void write()
        .then(() => setSaved(true))
        .catch(() => setFailed(true))
        .finally(() => setSaving(false));
    },
  };
}
