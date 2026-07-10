import { useMemo } from "react";

import { isSilentEmpty } from "@psi/nonEmptyAggregate";

import { CleaningErrorBoundary } from "@components/CleaningErrorBoundary";
import { FieldCoverage } from "@components/FieldCoverage";
import { StandardizationCards } from "@components/StandardizationCards";
import { useNonEmptyRates } from "@components/useNonEmptyRates";

import { declaredFieldsFor } from "./inviterModel";
import styles from "./bench.module.css";

import type { AcquiredCsv, InviterEditor } from "./inviterModel";
import type { LinkageField, StandardizationStep } from "@psilink/core";

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
  onFieldSteps,
  onFieldInput,
  onFieldAdded,
  onFieldRemoved,
  onResetCleaning,
  onBack,
}: {
  editor: InviterEditor;
  csv: AcquiredCsv;
  expertMode: boolean;
  onFieldSteps: (output: string, steps: Array<StandardizationStep>) => void;
  onFieldInput: (output: string, input: string) => void;
  onFieldAdded: (type: LinkageField["type"]) => void;
  onFieldRemoved: (output: string) => void;
  onResetCleaning: () => void;
  onBack: () => void;
}) {
  const declaredFields = useMemo(
    () => declaredFieldsFor(editor.draft),
    [editor.draft],
  );
  const { rates, pending } = useNonEmptyRates(
    csv.rawRows,
    editor.draft.standardization,
  );
  const resetKey = editor.draft.standardization
    .map((transformation) => `${transformation.output}=${transformation.input}`)
    .join(",");
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
