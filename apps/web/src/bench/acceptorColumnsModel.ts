import { assessLinkageSatisfiability, inferMetadata } from "@psilink/core";

import {
  SEMANTIC_TYPE_LABELS,
  disclosedColumnNames,
  hasMultipleIdentifiers,
  normalizeForEditor,
} from "@psi/metadataEditing";

import {
  applyInputOverrides,
  applyStepOverrides,
  isStepValid,
} from "@psi/standardizationAuthoring";

import { defaultStandardizationForRows } from "@psi/advancedInvite";

import { isSilentEmpty } from "@psi/nonEmptyAggregate";

import type {
  CSVRow,
  LinkageField,
  LinkageTerms,
  Metadata,
  Standardization,
} from "@psilink/core";

import type { AcceptorDataEdits } from "@psi/acceptInvitation";
import type { AlertContent } from "@components/csvIntake";
import type { FieldStepOverride } from "@psi/standardizationAuthoring";
import type { FieldValueCoverage } from "@psi/nonEmptyAggregate";

/**
 * The pure, React-free model behind the acceptor bench's "Confirm your columns"
 * step -- a port of the hardened legacy column editor's derivations, moved out
 * of the component so the verdict, mapper, cleaning-attention, launch-payload,
 * and gate logic are the one
 * tested boundary and React stays thin. No I/O and no state; every consent/verdict
 * semantic re-surfaces the existing logic layer ({@link assessLinkageSatisfiability},
 * {@link normalizeForEditor}/{@link inferMetadata}, {@link defaultStandardizationForRows},
 * the override-layering helpers, {@link isStepValid}, {@link hasMultipleIdentifiers}),
 * never a re-derivation.
 *
 * The verdict and the launch payload derive from the SAME `{ metadata, standardization }`
 * pair ({@link acceptorColumnsEditorState} produces it once; {@link acceptorVerdict}
 * and {@link acceptorLaunchPayload} both read it), so the gate the operator sees and
 * the exchange that runs cannot disagree -- the invariant the legacy editor held.
 *
 * The acceptor cannot edit fields or keys: they are adopted verbatim from the
 * invitation's `linkageTerms`. Satisfiability is assessed against those exact terms.
 */

/**
 * The acceptor's own parsed CSV, held in bench state on a passing parse (instead of
 * discarded): the column list and raw rows the columns step and its verdict consume,
 * plus the file's name and byte size for display. The run package feeds `columns` /
 * `rawRows` straight into the exchange with no re-parse.
 */
export interface AcceptorAcquiredCsv {
  fileName: string;
  sizeBytes: number;
  columns: Array<string>;
  rawRows: Array<CSVRow>;
}

/**
 * The acceptor's column-step working state, layered exactly as the legacy editor
 * held it: the seed metadata, plus two override LAYERS (input-column rebinds and
 * authored step edits) over the standardization derived from the current
 * metadata. Held as
 * layers rather than a whole standardization so the binding is always re-derived and
 * the verdict stays honest; an empty override map means the effective standardization
 * equals the derived default byte for byte.
 */
export interface AcceptorColumnsState {
  metadata: Metadata;
  /** Per-field input-column overrides, keyed by field name (the transformation
   * `output`). */
  inputOverrides: ReadonlyMap<string, string>;
  /** Per-field authored step overrides, keyed by field name and paired with the
   * input column they were authored against. */
  stepOverrides: ReadonlyMap<string, FieldStepOverride>;
}

/**
 * The seed metadata for a freshly-acquired file: {@link inferMetadata} over the
 * file's columns, normalized for the editor so the collapsed disclosure control is
 * faithful (see {@link normalizeForEditor}). "Reset to recommended" restores exactly
 * this, and the override layers start empty.
 */
export function acceptorInitialColumnsState(
  columns: Array<string>,
): AcceptorColumnsState {
  return {
    metadata: normalizeForEditor(inferMetadata(columns)),
    inputOverrides: new Map(),
    stepOverrides: new Map(),
  };
}

/**
 * The effective `{ metadata, standardization }` the verdict and the launch consume,
 * derived from {@link AcceptorColumnsState} in a fixed order:
 *
 * 1. The base standardization is the recommended per-type cleaning for the current
 *    metadata, with the date-of-birth input format inferred from the operator's own
 *    rows ({@link defaultStandardizationForRows}) -- so an ISO-dated file is not
 *    parsed as US-format and under-matched.
 * 2. Input-column overrides are applied FIRST, but only the ones that still bind to a
 *    `role: linkage` column of the field's type (a stale override is dropped so it
 *    never drives a column the core would refuse).
 * 3. Authored step overrides are applied over that; {@link applyStepOverrides} gates
 *    each on the current input column, so a step authored against the old column is
 *    seen as stale and dropped after a remap rather than silently cleaning a different
 *    column.
 *
 * The input rebind running before the step layer is load-bearing: it is what makes a
 * post-remap step override stale. With no overrides the result equals the derived
 * default.
 */
export function acceptorColumnsEditorState(
  state: AcceptorColumnsState,
  linkageTerms: LinkageTerms,
  rawRows: ReadonlyArray<CSVRow>,
): { metadata: Metadata; standardization: Standardization } {
  const { metadata } = state;
  const fieldByName = new Map(
    linkageTerms.linkageFields.map((field) => [field.name, field]),
  );
  const effectiveInputOverrides = new Map<string, string>();
  for (const [output, column] of state.inputOverrides) {
    const field = fieldByName.get(output);
    if (
      field !== undefined &&
      metadata.some(
        (c) =>
          c.name === column && c.role === "linkage" && c.type === field.type,
      )
    )
      effectiveInputOverrides.set(output, column);
  }
  const baseStandardization = defaultStandardizationForRows(
    metadata,
    linkageTerms,
    rawRows,
  );
  const standardization = applyStepOverrides(
    applyInputOverrides(baseStandardization, effectiveInputOverrides),
    state.stepOverrides,
  );
  return { metadata, standardization };
}

/** Which of the three verdict states holds. */
export type AcceptorVerdictKind = "blocked" | "partial" | "allClear";

/**
 * The verdict view-model: which alert to render, its exact visible title, and the
 * deferred announcement string (worded distinctly from the visible title, per the
 * announcement contract). The dead-key count is carried here too, since it is
 * derived from the same satisfiability assessment.
 */
export interface AcceptorVerdictViewModel {
  kind: AcceptorVerdictKind;
  /** The visible alert title, exact per the mockup. */
  title: string;
  /** The number of linkage keys whose columns can all be produced. */
  satisfiableKeyCount: number;
  /** The total number of adopted linkage keys. */
  totalKeys: number;
  /** The spoken announcement for the deferred polite region, distinct from the
   * visible title. Always non-empty (one of the three states always holds). */
  announcement: string;
  /** Shape-satisfiable keys whose declared cleaning can never produce a value (a
   * self-defeating rule in the adopted terms). A count only -- never the
   * partner-controlled key names. Warns, never blocks. */
  deadKeyCount: number;
}

/**
 * The live linkage-satisfiability verdict over the EDITED `{ metadata, standardization }`.
 * Re-surfaces {@link assessLinkageSatisfiability} against the adopted terms -- never
 * a re-derivation -- and maps its result to the mockup's exact copy and the spoken
 * announcement. Blocked when no key can match, partial when some but not all can,
 * all-clear when every key is covered.
 */
export function acceptorVerdict(
  columns: Array<string>,
  linkageTerms: LinkageTerms,
  editorState: { metadata: Metadata; standardization: Standardization },
): AcceptorVerdictViewModel {
  const verdict = assessLinkageSatisfiability(
    columns,
    linkageTerms,
    editorState.standardization,
    editorState.metadata,
  );
  const totalKeys = linkageTerms.linkageKeys.length;
  const satisfiable = verdict.satisfiableKeyCount;
  const blocked = satisfiable === 0;
  const partial = satisfiable > 0 && satisfiable < totalKeys;
  const kind: AcceptorVerdictKind = blocked
    ? "blocked"
    : partial
      ? "partial"
      : "allClear";
  const title = blocked
    ? "This file cannot match yet"
    : partial
      ? `${satisfiable} of ${totalKeys} keys can match`
      : `All ${totalKeys} keys can match`;
  const announcement = blocked
    ? "No agreed linkage key can be satisfied by your columns yet."
    : partial
      ? `${satisfiable} of ${totalKeys} linkage keys can be satisfied by your columns.`
      : `All ${totalKeys} linkage keys can be satisfied by your columns.`;
  return {
    kind,
    title,
    satisfiableKeyCount: satisfiable,
    totalKeys,
    announcement,
    deadKeyCount: verdict.deadKeys.length,
  };
}

/** One row of the quick-fix mapper: a missing field type and its human label. */
export interface AcceptorUnsatisfiedType {
  type: LinkageField["type"];
  label: string;
}

/**
 * The field types the file cannot currently produce, de-duplicated by type (several
 * fields can share a type). `LinkageField["type"]` is a closed semantic-type enum,
 * so its label is safe; the partner-controlled field NAME is never surfaced. The
 * quick-fix mapper renders one Select per entry, and ONLY when this list is
 * non-empty.
 */
export function acceptorUnsatisfiedTypes(
  columns: Array<string>,
  linkageTerms: LinkageTerms,
  editorState: { metadata: Metadata; standardization: Standardization },
): Array<AcceptorUnsatisfiedType> {
  const verdict = assessLinkageSatisfiability(
    columns,
    linkageTerms,
    editorState.standardization,
    editorState.metadata,
  );
  const seen = new Map<LinkageField["type"], string>();
  for (const field of verdict.unsatisfied)
    seen.set(field.type, SEMANTIC_TYPE_LABELS[field.type]);
  return [...seen.entries()].map(([type, label]) => ({ type, label }));
}

/**
 * The launch gate's `disabled` predicate, ported from the legacy editor:
 * disabled when no key can match (`satisfiableKeyCount === 0`), OR the metadata
 * carries more than one identifier column, OR any authored cleaning step is
 * invalid/mid-edit. Partial coverage does NOT gate -- it threads a warning instead.
 */
export function acceptorLaunchDisabled(
  verdict: AcceptorVerdictViewModel,
  editorState: { metadata: Metadata; standardization: Standardization },
): boolean {
  return (
    verdict.satisfiableKeyCount === 0 ||
    hasMultipleIdentifiers(editorState.metadata) ||
    !acceptorStandardizationValid(editorState.standardization)
  );
}

/** Whether every authored cleaning step is well-formed, gating launch so a
 * malformed pipeline (which core would run as a silent full-field exclusion or throw
 * at compile) never reaches the exchange. Re-surfaces {@link isStepValid}. */
export function acceptorStandardizationValid(
  standardization: Standardization,
): boolean {
  return standardization.every((transformation) =>
    (transformation.steps ?? []).every(isStepValid),
  );
}

/**
 * The launch payload: the edited `{ metadata, standardization }` (the exact shape
 * {@link AcceptorDataEdits} expects), plus an optional partial-coverage advisory the
 * run package surfaces. The pair is the SAME one the verdict consumed, so the gate
 * and the run cannot disagree. The warning is present only when coverage is partial.
 */
export function acceptorLaunchPayload(
  verdict: AcceptorVerdictViewModel,
  editorState: { metadata: Metadata; standardization: Standardization },
): { edits: AcceptorDataEdits; warning?: AlertContent } {
  const warning: AlertContent | undefined =
    verdict.kind === "partial"
      ? {
          title: "Partial coverage",
          message:
            `Only ${verdict.satisfiableKeyCount} of ${verdict.totalKeys} linkage keys can match with ` +
            "this file. Keys that need the missing fields will be inactive; the " +
            "others will proceed normally.",
        }
      : undefined;
  return {
    edits: {
      metadata: editorState.metadata,
      standardization: editorState.standardization,
    },
    warning,
  };
}

/** The disclosed columns ("What you will send to your partner"), the same predicate
 * the run transmits on. */
export function acceptorDisclosedColumns(metadata: Metadata): Array<string> {
  return disclosedColumnNames(metadata);
}

/** Whether the metadata carries more than one identifier column, surfaced as the
 * identifier-conflict hint and gated on at launch. Re-surfaces
 * {@link hasMultipleIdentifiers}. */
export function acceptorHasIdentifierConflict(metadata: Metadata): boolean {
  return hasMultipleIdentifiers(metadata);
}

/**
 * The Cleaning tab's rail attention state. The tab keeps its em-dash placeholder
 * until there is a REASON to review cleaning -- a silent-empty field (a transform
 * that drops every row), a dead key (a self-defeating adopted rule), or an
 * invalid/mid-edit step -- then it shows an amber attention value naming the failing
 * field count. Warns via colour; never blocks (except through the standardization
 * gate a mid-edit step already trips).
 *
 * `rates` is the host's full-CSV coverage (null before the first sweep settles); a
 * pending sweep contributes no silent-empty count -- attention is computed only
 * from a resolved map.
 */
export interface AcceptorCleaningAttention {
  /** Whether the tab needs attention (any failing reason present). */
  needsAttention: boolean;
  /** The number of fields failing (silent-empty or invalid), for the amber value.
   * Zero when only a dead key drives attention (dead keys are counted separately and
   * are the partner's to fix). */
  failingFieldCount: number;
  /** The rail fact string: undefined (em-dash) when no attention is needed, else the
   * amber "N field(s) failing" value. */
  railValue: string | undefined;
}

/**
 * Derive the Cleaning tab's attention state from the effective standardization, the
 * full-CSV coverage, and the dead-key count. A field is "failing" when its transform
 * drops every row ({@link isSilentEmpty}) or an authored step is invalid; the count
 * de-duplicates by field name. A dead key alone still raises attention (there is a
 * reason to open the tab -- the dead-key advisory renders there) but contributes no
 * failing-FIELD count, since the acceptor cannot fix it.
 */
export function acceptorCleaningAttention(
  standardization: Standardization,
  rates: ReadonlyMap<string, FieldValueCoverage> | null,
  deadKeyCount: number,
): AcceptorCleaningAttention {
  const failing = new Set<string>();
  for (const transformation of standardization) {
    const rate = rates?.get(transformation.output);
    const silentEmpty = rate !== undefined && isSilentEmpty(rate);
    const invalid = (transformation.steps ?? []).some(
      (step) => !isStepValid(step),
    );
    if (silentEmpty || invalid) failing.add(transformation.output);
  }
  const failingFieldCount = failing.size;
  const needsAttention = failingFieldCount > 0 || deadKeyCount > 0;
  const railValue = !needsAttention
    ? undefined
    : failingFieldCount > 0
      ? `${failingFieldCount} field${failingFieldCount === 1 ? "" : "s"} failing`
      : `${deadKeyCount} key${deadKeyCount === 1 ? "" : "s"} to review`;
  return { needsAttention, failingFieldCount, railValue };
}
