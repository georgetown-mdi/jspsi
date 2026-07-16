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

import type { AcquiredCsv, InviterEditor, KeyVerdict } from "./inviterModel";
import type { Algorithm, LinkageStrategy, LinkageTerms } from "@psilink/core";
import type { AdvancedInviteDraft } from "@psi/advancedInvite";

/** The guided-list badge copy and CSS class for each per-key verdict
 * ({@link KeyVerdict}). A dead key warns ("won't match", amber) rather than
 * blocking: its columns resolve but a self-defeating transform would run it to
 * a silent empty result, so the author is nudged to fix the terms. */
const KEY_VERDICT_BADGES: Record<
  KeyVerdict,
  {
    label: string;
    className: "keyBadgeSatisfiable" | "keyBadgeUnsatisfiable" | "keyBadgeDead";
    ariaLabel?: string;
  }
> = {
  satisfiable: { label: "satisfiable", className: "keyBadgeSatisfiable" },
  unsatisfiable: {
    label: "not satisfiable",
    className: "keyBadgeUnsatisfiable",
  },
  dead: {
    label: "won't match",
    className: "keyBadgeDead",
    ariaLabel:
      "This key's cleaning can never produce a value; review the transform",
  },
};

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
  keysError,
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
  /** The validation message for the key set, rendered inline beside the list
   * it names (the work column's Problems block carries it too). */
  keysError: string | undefined;
  announce: (message: string) => void;
  onBack: () => void;
}) {
  const keyVerdict = useMemo(() => keySatisfiabilityFor(editor), [editor]);
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
      <p id="bench-key-order-help">
        Records are matched on these keys, tried in order. Earlier keys match
        first, so order the most precise keys first.
      </p>
      <ol className={styles.guidedKeys} aria-describedby="bench-key-order-help">
        {editor.draft.keys.map((entry, index) => {
          const displayName = sanitizeForDisplay(entry.key.name);
          const badge = KEY_VERDICT_BADGES[keyVerdict(index)];
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
                      className={`${styles.keyBadge} ${styles[badge.className]}`}
                      {...(badge.ariaLabel
                        ? { role: "img", "aria-label": badge.ariaLabel }
                        : {})}
                    >
                      {badge.label}
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
      {keysError !== undefined && (
        <p
          role="alert"
          className={`${styles.small} ${styles.statusLine} ${styles.statusLineDanger}`}
        >
          {keysError}
        </p>
      )}
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
          keyVerdict={keyVerdict}
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
          label="Cascade"
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
          // Pinned so the consent-critical warning is announced on selection
          // even if Mantine's default role changes.
          role="alert"
          mt="sm"
        >
          Every record meets every key, so the receiving side observes matches
          on weaker keys that the cascade would have filtered out. The linked
          output file is identical either way; the difference is what a partner
          can observe while matching runs. Choose it only when both of you
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
