import { useMemo } from "react";

import { VisuallyHidden } from "@mantine/core";

import { SEMANTIC_TYPE_LABELS } from "@psi/metadataEditing";
import { isSilentEmpty } from "@psi/nonEmptyAggregate";

import { CleaningErrorBoundary } from "@components/CleaningErrorBoundary";
import { FieldCoverage } from "@components/FieldCoverage";
import { StandardizationCards } from "@components/StandardizationCards";

import { declaredFieldsFor } from "./inviterModel";
import styles from "./bench.module.css";

import type { AcquiredCsv, InviterEditor } from "./inviterModel";
import type { LinkageField, StandardizationStep } from "@psilink/core";
import type { FieldValueCoverage } from "@psi/nonEmptyAggregate";

/**
 * The Cleaning tab: per-field pipelines with previews and whole-file coverage,
 * mounted from the shared standardization workbench over the bench's draft.
 * Add/remove same-typed fields is the expert affordance, gated with the keys
 * tab's expert switch.
 */
export function CleaningTab({
  editor,
  csv,
  expertMode,
  rates,
  pending,
  onFieldSteps,
  onFieldInput,
  onFieldAdded,
  onFieldRemoved,
  onResetCleaning,
  cleaningError,
  onBack,
}: {
  editor: InviterEditor;
  csv: AcquiredCsv;
  expertMode: boolean;
  /** The full-CSV per-field coverage, swept once at the bench and shared with the
   * Customize fact and the coverage Problems entry (`null` before the first sweep
   * settles). Lifted so the fact and the create gate render regardless of the
   * active section. */
  rates: ReadonlyMap<string, FieldValueCoverage> | null;
  /** Whether a coverage recompute is in flight (drives the per-card "Checking..."
   * placeholder before the first result). */
  pending: boolean;
  onFieldSteps: (output: string, steps: Array<StandardizationStep>) => void;
  onFieldInput: (output: string, input: string) => void;
  onFieldAdded: (type: LinkageField["type"]) => void;
  onFieldRemoved: (output: string) => void;
  onResetCleaning: () => void;
  /** The validation message for the cleaning, rendered inline (the work
   * column's Problems block carries it too). */
  cleaningError: string | undefined;
  onBack: () => void;
}) {
  const declaredFields = useMemo(
    () => declaredFieldsFor(editor.draft),
    [editor.draft],
  );
  const resetKey = editor.draft.standardization
    .map((transformation) => `${transformation.output}=${transformation.input}`)
    .join(",");

  // The per-card coverage alarm is presentational by contract (FieldCoverage
  // announces nothing itself); this region makes the one editor-wide
  // announcement it defers to. Safe type labels, never the partner-controlled
  // field names.
  const fieldTypeByName = useMemo(
    () => new Map(declaredFields.map((field) => [field.name, field.type])),
    [declaredFields],
  );
  const silentEmptyLabels = useMemo(() => {
    if (rates === null) return [];
    const labels = new Set<string>();
    for (const transformation of editor.draft.standardization) {
      const rate = rates.get(transformation.output);
      if (rate !== undefined && isSilentEmpty(rate)) {
        const type = fieldTypeByName.get(transformation.output);
        if (type !== undefined) labels.add(SEMANTIC_TYPE_LABELS[type]);
      }
    }
    return [...labels];
  }, [rates, editor.draft.standardization, fieldTypeByName]);
  const coverageAnnouncement =
    silentEmptyLabels.length === 0
      ? ""
      : `Coverage warning: ${silentEmptyLabels.join(", ")} ${
          silentEmptyLabels.length === 1 ? "produces" : "produce"
        } no value for any row and cannot match. Check the cleaning steps.`;
  return (
    <>
      <button type="button" className={styles.backlink} onClick={onBack}>
        {"\u2190"} Back to Review &amp; create
      </button>
      <p className={styles.eyebrow}>Customize</p>
      <h1 tabIndex={-1}>Cleaning</h1>
      <p>
        Each field below is cleaned before matching so small differences -
        spacing, case, accents, date styles - do not hide a match. These steps
        came from your file; change them only if you know your data needs it.
      </p>
      {cleaningError !== undefined && (
        <p
          role="alert"
          className={`${styles.small} ${styles.statusLine} ${styles.statusLineDanger}`}
        >
          {cleaningError}
        </p>
      )}
      <VisuallyHidden>
        <p role="status" aria-live="polite" aria-atomic="true">
          {coverageAnnouncement}
        </p>
      </VisuallyHidden>
      <CleaningErrorBoundary onReset={onResetCleaning} resetKey={resetKey}>
        <StandardizationCards
          standardization={editor.draft.standardization}
          declaredFields={declaredFields}
          metadata={editor.draft.metadata}
          rawRows={csv.rawRows}
          onStepsChange={(output, _input, steps) => onFieldSteps(output, steps)}
          onInputColumnChange={onFieldInput}
          onAddField={expertMode ? onFieldAdded : undefined}
          onRemoveField={expertMode ? onFieldRemoved : undefined}
          renderCoverage={(output) => (
            <FieldCoverage
              rate={rates?.get(output)}
              pending={rates !== null && pending}
            />
          )}
          isFieldSilentEmpty={(output) => {
            const rate = rates?.get(output);
            return rate !== undefined && isSilentEmpty(rate);
          }}
          onMissingField="skip"
        />
      </CleaningErrorBoundary>
    </>
  );
}
