import { useEffect, useMemo, useRef } from "react";

import { Alert, VisuallyHidden } from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";

import { SEMANTIC_TYPE_LABELS } from "@psi/metadataEditing";
import { isSilentEmpty } from "@psi/nonEmptyAggregate";

import { CleaningErrorBoundary } from "@components/CleaningErrorBoundary";
import { FieldCoverage } from "@components/FieldCoverage";
import { StandardizationCards } from "@components/StandardizationCards";

import styles from "./bench.module.css";

import type {
  LinkageField,
  Metadata,
  Standardization,
  StandardizationStep,
} from "@psilink/core";
import type { ColumnSamples } from "@psi/columnSamples";
import type { FieldValueCoverage } from "@psi/nonEmptyAggregate";

/**
 * The acceptor's Cleaning tab: per-field pipelines with previews and whole-file
 * coverage over its OWN standardization. Adopted from the inviter's {@link CleaningTab}
 * idiom, but the acceptor edits only its own cleaning -- the keys and fields came from
 * the invitation and are not editable here, so there is no add/remove-field
 * affordance. The dead-key advisory (a self-defeating adopted rule) surfaces here,
 * amber not red, routing the fix to the partner.
 *
 * Presentational over the shared column-step state the bench owns; the full-CSV
 * coverage (`rates`) and the per-column preview samples are computed by the bench
 * (from the browser rows on the hosted build, read from the server-side profile on
 * the console) and passed in, so one sweep drives both this tab and the Customize
 * menu's Cleaning-attention value and the console never reads rows it does not hold.
 */
export function AcceptorCleaningStep({
  declaredFields,
  metadata,
  standardization,
  columnSamples,
  rates,
  ratesPending,
  deadKeyCount,
  cleaningResetKey,
  coveragePendingLabel,
  onFieldSteps,
  onFieldInput,
  onReset,
  onBack,
}: {
  /** The adopted linkage fields (from the invitation), for the per-card labels and
   * the input-column options. */
  declaredFields: Array<LinkageField>;
  metadata: Metadata;
  standardization: Standardization;
  /** The per-column preview samples, keyed by input-column name: the browser rows'
   * samples on the hosted build, the profiled samples on the console. */
  columnSamples: ColumnSamples;
  /** Full-CSV per-field coverage, or null before the first sweep settles. */
  rates: ReadonlyMap<string, FieldValueCoverage> | null;
  ratesPending: boolean;
  /** The count of self-defeating adopted keys, for the dead-key advisory. */
  deadKeyCount: number;
  /** A signature of each field's input binding, so a remap or reset auto-recovers
   * the cleaning error boundary. */
  cleaningResetKey: string;
  /** The coverage pending-placeholder copy: the console passes the whole-file
   * appliance-sweep phrasing, so the readout does not read as an instant local
   * check. Undefined keeps the default local copy. */
  coveragePendingLabel?: string;
  onFieldSteps: (output: string, steps: Array<StandardizationStep>) => void;
  onFieldInput: (output: string, column: string) => void;
  onReset: () => void;
  onBack: () => void;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const fieldByName = useMemo(
    () => new Map(declaredFields.map((field) => [field.name, field])),
    [declaredFields],
  );

  // The safe labels of the fields whose transform drops every row, for the one
  // editor-wide coverage announcement. Built from the field's semantic-type label
  // (the partner-controlled `output` is never announced raw), de-duplicated by label
  // in standardization order so the read is stable.
  const silentEmptyLabels = useMemo(() => {
    if (rates === null) return [];
    const labels = new Set<string>();
    for (const transformation of standardization) {
      const rate = rates.get(transformation.output);
      const field = fieldByName.get(transformation.output);
      if (rate !== undefined && field !== undefined && isSilentEmpty(rate))
        labels.add(SEMANTIC_TYPE_LABELS[field.type]);
    }
    return [...labels];
  }, [rates, standardization, fieldByName]);
  const coverageAnnouncement =
    silentEmptyLabels.length === 0
      ? ""
      : `Coverage warning: ${silentEmptyLabels.join(", ")} ${
          silentEmptyLabels.length === 1 ? "produces" : "produce"
        } no value for any row and cannot match. Check the cleaning steps.`;

  return (
    <>
      <button type="button" className={styles.backlink} onClick={onBack}>
        {"←"} Back to Confirm your columns
      </button>
      <p className={styles.eyebrow}>Customize</p>
      <h1 tabIndex={-1} ref={headingRef}>
        Cleaning
      </h1>
      <p className={`${styles.small} ${styles.sub}`}>
        Each field below is cleaned before matching so small differences -
        spacing, case, accents, date styles - do not hide a match. Cleaning runs
        on your device and changes only your own match rate; it is never sent to
        your partner.
      </p>

      {/* A dead key the acceptor cannot fix: a cleaning rule in the adopted terms
          drops every record. Amber not red -- the exchange proceeds on live keys, and
          the fix is the partner's. A count only, never the partner-controlled key
          names. Static, so not a live region. */}
      {deadKeyCount > 0 && (
        <Alert
          role="note"
          color="orange"
          icon={<IconAlertTriangle aria-hidden />}
          title={
            deadKeyCount === 1
              ? "A linkage key's rule drops every record"
              : `${deadKeyCount} linkage keys have a rule that drops every record`
          }
          mb="md"
        >
          {deadKeyCount === 1 ? "A key" : "Some keys"} produced no usable rows
          from your file after cleaning. The key came with the invitation, so
          you cannot edit it here - ask your partner for a corrected invitation.
        </Alert>
      )}

      <CleaningErrorBoundary onReset={onReset} resetKey={cleaningResetKey}>
        <StandardizationCards
          standardization={standardization}
          declaredFields={declaredFields}
          metadata={metadata}
          columnSamples={columnSamples}
          onStepsChange={(output, _input, steps) => onFieldSteps(output, steps)}
          onInputColumnChange={onFieldInput}
          renderCoverage={(output) => (
            <FieldCoverage
              rate={rates?.get(output)}
              pending={rates !== null && ratesPending}
              {...(coveragePendingLabel !== undefined
                ? { pendingLabel: coveragePendingLabel }
                : {})}
            />
          )}
          isFieldSilentEmpty={(output) => {
            const rate = rates?.get(output);
            return rate !== undefined && isSilentEmpty(rate);
          }}
          onMissingField="throw"
        />
      </CleaningErrorBoundary>
      {/* One polite, atomic region announces a silent-empty collapse for the whole
          tab (the visible per-card alarms are role="presentation"). */}
      <VisuallyHidden role="status" aria-live="polite" aria-atomic="true">
        {coverageAnnouncement}
      </VisuallyHidden>
    </>
  );
}
