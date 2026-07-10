import { useMemo } from "react";

import {
  ActionIcon,
  Alert,
  Checkbox,
  NativeSelect,
  Radio,
  Switch,
} from "@mantine/core";
import { IconArrowDown, IconArrowUp } from "@tabler/icons-react";

import {
  AlgorithmSchema,
  LinkageStrategySchema,
  sanitizeForDisplay,
} from "@psilink/core";

import { APPLIED_SETTINGS } from "@psi/appliedSettings";
import { buildAdvancedTerms } from "@psi/advancedInvite";

import { ExpertKeyEditor } from "@components/ExpertKeyEditor";
import { TermsImportExport } from "@components/TermsImportExport";

import { declaredFieldsFor, keySatisfiabilityFor } from "./inviterModel";
import styles from "./bench.module.css";

import type { AcquiredCsv, InviterEditor } from "./inviterModel";
import type { Algorithm, LinkageStrategy, LinkageTerms } from "@psilink/core";
import type { AdvancedInviteDraft } from "@psi/advancedInvite";

/**
 * The Matching keys tab: the guided ordered key list (enable + reorder, with
 * satisfiability badges), the expert switch that opens element-by-element
 * authoring and terms import/export, and the matching settings -- the live
 * linkage strategy plus the gated method and deduplication controls, held
 * visible but inert until the run honors them.
 */
export function KeysTab({
  editor,
  csv,
  expertMode,
  onExpertMode,
  onKeyEnabled,
  onKeyMoved,
  onAuthoredDraft,
  onStrategy,
  onAlgorithm,
  onDeduplicate,
  onImport,
  announce,
  onBack,
}: {
  editor: InviterEditor;
  csv: AcquiredCsv;
  expertMode: boolean;
  onExpertMode: (on: boolean) => void;
  onKeyEnabled: (index: number, enabled: boolean) => void;
  onKeyMoved: (index: number, offset: -1 | 1) => void;
  onAuthoredDraft: (draft: AdvancedInviteDraft) => void;
  onStrategy: (strategy: LinkageStrategy) => void;
  onAlgorithm: (algorithm: Algorithm) => void;
  onDeduplicate: (deduplicate: boolean) => void;
  onImport: (terms: LinkageTerms) => void;
  announce: (message: string) => void;
  onBack: () => void;
}) {
  const keyIsSatisfiable = useMemo(
    () => keySatisfiabilityFor(editor),
    [editor],
  );
  const declaredFields = useMemo(
    () => declaredFieldsFor(editor.draft),
    [editor.draft],
  );
  const currentTerms = useMemo(
    () => buildAdvancedTerms(editor.draft),
    [editor.draft],
  );
  const keyCount = editor.draft.keys.length;
  return (
    <>
      <button type="button" className={styles.backlink} onClick={onBack}>
        {"\u2190"} Back to Review &amp; create
      </button>
      <p className={styles.eyebrow}>Customize</p>
      <h1 tabIndex={-1}>Matching keys</h1>
      <p>
        Records are matched on these keys, tried in order. Earlier keys match
        first, so order the most precise keys first.
      </p>
      <ol className={styles.guidedKeys}>
        {editor.draft.keys.map((entry, index) => {
          const displayName = sanitizeForDisplay(entry.key.name);
          const satisfiable = keyIsSatisfiable(index);
          return (
            <li key={entry.key.name}>
              <Checkbox
                checked={entry.enabled}
                onChange={(event) =>
                  onKeyEnabled(index, event.currentTarget.checked)
                }
                label={
                  <>
                    Key {index + 1} -{" "}
                    <span className={styles.mono}>{displayName}</span>
                    <span
                      className={
                        satisfiable
                          ? `${styles.keyBadge} ${styles.keyBadgeSatisfiable}`
                          : `${styles.keyBadge} ${styles.keyBadgeUnsatisfiable}`
                      }
                    >
                      {satisfiable ? "satisfiable" : "not satisfiable"}
                    </span>
                  </>
                }
              />
              <span className={styles.movers}>
                <ActionIcon
                  variant="default"
                  aria-label={`Move ${displayName} earlier`}
                  disabled={index === 0}
                  onClick={() => onKeyMoved(index, -1)}
                >
                  <IconArrowUp size={15} />
                </ActionIcon>
                <ActionIcon
                  variant="default"
                  aria-label={`Move ${displayName} later`}
                  disabled={index === keyCount - 1}
                  onClick={() => onKeyMoved(index, 1)}
                >
                  <IconArrowDown size={15} />
                </ActionIcon>
              </span>
            </li>
          );
        })}
      </ol>
      <Switch
        label="Expert authoring"
        description="Build linkage keys element by element, edit transforms and swaps, and import or export the terms as JSON or YAML."
        checked={expertMode}
        onChange={(event) => onExpertMode(event.currentTarget.checked)}
        my="md"
      />
      {expertMode ? (
        <ExpertKeyEditor
          draft={editor.draft}
          declaredFields={declaredFields}
          keyIsSatisfiable={keyIsSatisfiable}
          fuzzyApplied={APPLIED_SETTINGS.fuzzyComparisons}
          onChange={onAuthoredDraft}
          announce={announce}
        />
      ) : (
        <Alert variant="light" color="gray">
          Fixed in this version. Turn on Expert authoring to edit keys element
          by element and to import or export the terms.
        </Alert>
      )}
      <h2>Matching settings</h2>
      <Radio.Group
        label="Linkage strategy"
        value={editor.draft.linkageStrategy}
        // Parsed rather than trusted so a Radio value literal drifting from
        // the enum throws loudly instead of typechecking clean.
        onChange={(value) => onStrategy(LinkageStrategySchema.parse(value))}
      >
        <Radio
          value="cascade"
          label="Cascade (recommended)"
          description="Keys run in order; a record matched by an earlier key is settled and never re-exposed to later, broader keys."
          mt="xs"
        />
        <Radio
          value="single-pass"
          label="Single-pass"
          description="All keys run over all records at once."
          mt="xs"
        />
      </Radio.Group>
      {editor.draft.linkageStrategy === "single-pass" && (
        <Alert
          color="yellow"
          title="Single-pass widens what one of you can observe"
          mt="sm"
        >
          Every record meets every key, so a partner can learn more about
          near-misses than under the cascade. Choose it only when both of you
          accept that.
        </Alert>
      )}
      <NativeSelect
        label="Matching method"
        description={
          APPLIED_SETTINGS.psiC
            ? "Reveal the matched identifiers, or only the count."
            : '"Reveal only the count (psi-c)" is not available yet; the standard method applies.'
        }
        disabled={!APPLIED_SETTINGS.psiC}
        value={editor.draft.algorithm}
        data={[
          { value: "psi", label: "Reveal the matched identifiers (standard)" },
          { value: "psi-c", label: "Reveal only the count (psi-c)" },
        ]}
        onChange={(event) =>
          onAlgorithm(AlgorithmSchema.parse(event.currentTarget.value))
        }
        mt="md"
      />
      <Checkbox
        label="Allow several of your records to match one partner record"
        description={
          APPLIED_SETTINGS.deduplicate
            ? undefined
            : "Deduplication of your own inputs is not available yet; each record matches at most once."
        }
        disabled={!APPLIED_SETTINGS.deduplicate}
        checked={editor.draft.deduplicate}
        onChange={(event) => onDeduplicate(event.currentTarget.checked)}
        mt="md"
      />
      {expertMode && (
        <>
          <h2>Import or export</h2>
          <p className={`${styles.small} ${styles.sub}`}>
            Carry these terms between exchanges, or keep them under version
            control.
          </p>
          <TermsImportExport
            currentTerms={currentTerms}
            seed={editor.seed}
            rawRows={csv.rawRows}
            onImport={onImport}
          />
        </>
      )}
    </>
  );
}
