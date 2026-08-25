import { useMemo } from "react";

import {
  ActionIcon,
  Alert,
  Checkbox,
  NativeSelect,
  Radio,
  Switch,
  VisuallyHidden,
} from "@mantine/core";
import {
  IconAlertCircle,
  IconArrowDown,
  IconArrowUp,
} from "@tabler/icons-react";

import {
  APPLIED_SETTINGS,
  AlgorithmSchema,
  LinkageStrategySchema,
  sanitizeForDisplay,
} from "@psilink/core";

import {
  buildAdvancedTerms,
  importedCitationDropNotice,
} from "@psi/advancedInvite";

import { ExpertKeyEditor } from "@components/ExpertKeyEditor";
import { TermsImportExport } from "@components/TermsImportExport";

import {
  declaredFieldsFor,
  keySatisfiabilityFor,
  seedRows,
} from "./inviterModel";
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
 * authoring and terms import/export, and the matching settings -- the linkage
 * strategy, matching method, and deduplication controls, each live while the
 * exchange applies what it writes.
 *
 * It also carries the one notice about the terms the editor will emit that refuses
 * nothing: an imported document's rule-set citation the rebuild will not carry
 * ({@link importedCitationDropNotice}), read live from the draft so it appears the
 * moment the import lands or an edit costs the citation.
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
  const citationDrop = useMemo(
    () => importedCitationDropNotice(editor.draft, currentTerms),
    [editor.draft, currentTerms],
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
      {/* Rendered against the key list rather than beside the import control
        below: the list is what costs the citation and what restores it, and the
        drop outlives the Expert switch the import hides behind. It states a
        consequence and blocks nothing -- creating without the citation is the
        right outcome -- so it is not a Problems entry, whose every member holds
        the create gate shut. The announcement rides the persistent region below:
        a conditionally-mounted live region is missed by screen readers that watch
        only regions already in the DOM. */}
      {citationDrop !== undefined && (
        <Alert
          role="note"
          color="yellow"
          icon={<IconAlertCircle aria-hidden />}
          title="The imported rule-set citation will not be carried"
          mt="md"
        >
          {citationDrop}
        </Alert>
      )}
      <VisuallyHidden role="status" aria-live="polite" aria-atomic="true">
        {citationDrop ?? ""}
      </VisuallyHidden>
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
          Turn on Expert authoring to edit keys element by element and to import
          or export the terms.
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
        description="Reveal the matched identifiers, or only the count."
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
      {/* Gated on the same applied flag as the terms clamp and the import refusal,
      so a control an operator can turn on is one the run honors. The accepting
      party's own side of the cardinality is not this control's to set: acceptance
      derives it as false, so what this authors is one-sided by construction. */}
      <Checkbox
        label="Allow several of your records to match one partner record"
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
            rawRows={seedRows(csv)}
            dateInputFormat={csv.dateInputFormat}
            onImport={onImport}
          />
        </>
      )}
    </>
  );
}
