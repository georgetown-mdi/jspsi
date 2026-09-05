import { useMemo } from "react";

import {
  ActionIcon,
  Alert,
  Checkbox,
  List,
  NativeSelect,
  Radio,
  Switch,
  VisuallyHidden,
} from "@mantine/core";
import { IconArrowDown, IconArrowUp } from "@tabler/icons-react";

import {
  APPLIED_SETTINGS,
  AlgorithmSchema,
  LinkageStrategySchema,
  sanitizeForDisplay,
} from "@psilink/core";

import {
  LINKAGE_STRATEGY_LABEL,
  LINKAGE_STRATEGY_OPTION_COPY,
  SINGLE_PASS_DISCLOSURE_BODY,
  SINGLE_PASS_DISCLOSURE_TITLE,
} from "@psi/linkageStrategyChoice";
import {
  buildAdvancedTerms,
  importedCitationDropNotice,
  isOptInDraftKey,
} from "@psi/advancedInvite";

import { ExpertKeyEditor } from "@components/ExpertKeyEditor";
import { TermsImportExport } from "@components/TermsImportExport";

import {
  declaredFieldsFor,
  keySatisfiabilityFor,
  seedRows,
} from "@psi/inviterModel";

import { CITATION_DROP_TITLE, CitationDropNotice } from "./CitationDropNotice";

import styles from "./bench.module.css";

import type { AcquiredCsv, InviterEditor, KeyVerdict } from "@psi/inviterModel";
import type { Algorithm, LinkageStrategy, LinkageTerms } from "@psilink/core";
import type { AdvancedInviteDraft } from "@psi/advancedInvite";

/** The guided-list badge copy and CSS class for each per-key verdict
 * ({@link KeyVerdict}). A dead key displays amber ("won't match") rather than red:
 * its columns resolve, so the remedy is the transform rather than the file. It
 * closes Generate as an unsatisfiable key does -- an exchange runs every key its
 * terms declare, and this one can never match. */
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

/** The heading of {@link OPT_IN_KEYS_GUIDANCE_LEAD}, and the marker on each guided-list
 * entry the guidance is about, so the two read as one statement. */
const OPT_IN_BADGE_LABEL = "outside the default set";

/**
 * What turning on an offered key the built-in set does not declare costs the
 * operator, stated where the offer is. Rendered whenever the list holds one, so
 * the three types it names are offered on identical terms -- none is offered
 * with a caveat the others are spared, and none is offered silently.
 */
const OPT_IN_KEYS_GUIDANCE_LEAD =
  "Phone number, email address and ZIP code are not part of the default set, " +
  "so the testing behind the defaults says nothing about how well these " +
  "match. Turning one on means this exchange no longer matches on the default " +
  "set alone.";

/**
 * The points under {@link OPT_IN_KEYS_GUIDANCE_LEAD}. Each type is offered only
 * inside a compound key, never on its own. The last two points cover behavior
 * not otherwise visible: a metadata edit can leave a badge on an offer the file
 * no longer supplies a column for, and turning a lost key back on restores the
 * recommended cleaning steps rather than an operator's own edits.
 */
const OPT_IN_KEYS_GUIDANCE_POINTS = [
  "Each is offered only inside a compound key, never on its own: a single " +
    "identifier both over-matches and tells anyone holding a value whether its " +
    "holder is in the other file.",
  "A phone number or an email address is often shared, covering a household " +
    "or the organization that helped with an application.",
  "Offers appear for the keys your file can supply; one marked not satisfiable " +
    "lost its column to a later edit.",
  "Cleaning follows the key: turning an offer off, or losing a column its key " +
    "needs, withdraws the cleaning that came with it, and turning it back on " +
    "restores the recommended steps rather than any you had changed.",
];

/**
 * The Matching keys tab: the guided ordered key list (enable + reorder, with
 * satisfiability badges), the expert switch that opens element-by-element
 * authoring and terms import/export, and the matching settings -- the linkage
 * strategy, matching method, and deduplication controls, each live while the
 * exchange applies what it writes.
 *
 * The list holds the built-in keys for these columns and, turned off and in the
 * cascade position each belongs at, any `optInLinkageKeys` offers for matchable
 * types the built-in set uses in none of its keys. Both use the same control --
 * a checkbox and the reorder pair -- with an opt-in entry marked and its cost
 * stated in the guidance below the list ({@link OPT_IN_KEYS_GUIDANCE_LEAD}).
 *
 * Also renders {@link importedCitationDropNotice} live from the draft, so a
 * rule-set citation the rebuild drops is flagged as soon as the import lands
 * or an edit costs it. Review & create restates the same notice, for an
 * operator who imports here and leaves without reading it.
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
   * it names (the work column's Problems block shows it too). */
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
  const offersOptInKey = editor.draft.keys.some((entry) =>
    isOptInDraftKey(entry.key),
  );
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
                    {isOptInDraftKey(entry.key) && (
                      <span
                        className={`${styles.keyBadge} ${styles.keyBadgeOptIn}`}
                      >
                        {OPT_IN_BADGE_LABEL}
                      </span>
                    )}
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
      {offersOptInKey && (
        <Alert
          variant="light"
          color="yellow"
          title={`Some keys are ${OPT_IN_BADGE_LABEL}`}
          my="md"
        >
          {OPT_IN_KEYS_GUIDANCE_LEAD}
          <List size="sm" mt="xs">
            {OPT_IN_KEYS_GUIDANCE_POINTS.map((point) => (
              <List.Item key={point}>{point}</List.Item>
            ))}
          </List>
        </Alert>
      )}
      {keysError !== undefined && (
        <p
          role="alert"
          className={`${styles.small} ${styles.statusLine} ${styles.statusLineDanger}`}
        >
          {keysError}
        </p>
      )}
      {/* Rendered against the key list, not beside the import control: the list
        is what costs and restores the citation, and the drop outlives the
        Expert switch the import hides behind. The persistent region announces
        only the notice's title, not its body: a conditionally-mounted region
        is missed by screen readers watching only what is already in the DOM,
        and repeating the whole body would voice it twice -- once live, once in
        reading order. */}
      {citationDrop !== undefined && (
        <CitationDropNotice notice={citationDrop} />
      )}
      <VisuallyHidden role="status" aria-live="polite" aria-atomic="true">
        {citationDrop !== undefined ? CITATION_DROP_TITLE : ""}
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
        label={LINKAGE_STRATEGY_LABEL}
        value={editor.draft.linkageStrategy}
        // Parsed rather than trusted so a Radio value literal drifting from
        // the enum throws loudly instead of typechecking clean.
        onChange={(value) => onStrategy(LinkageStrategySchema.parse(value))}
      >
        <Radio
          value="cascade"
          label={LINKAGE_STRATEGY_OPTION_COPY.cascade.label}
          description={LINKAGE_STRATEGY_OPTION_COPY.cascade.description}
          mt="xs"
        />
        <Radio
          value="single-pass"
          label={LINKAGE_STRATEGY_OPTION_COPY["single-pass"].label}
          description={LINKAGE_STRATEGY_OPTION_COPY["single-pass"].description}
          mt="xs"
        />
      </Radio.Group>
      {editor.draft.linkageStrategy === "single-pass" && (
        <Alert
          color="yellow"
          title={SINGLE_PASS_DISCLOSURE_TITLE}
          // Pinned so the consent-critical warning is announced on selection
          // even if Mantine's default role changes.
          role="alert"
          mt="sm"
        >
          {SINGLE_PASS_DISCLOSURE_BODY}
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
            Reuse these terms between exchanges, or keep them under version
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
