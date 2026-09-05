/**
 * The inviter spine's own view model: the quiet facts the Customize menu shows,
 * the problems each step raises, what holds Create back, and the answers table
 * the review step renders. The editor it reads is `inviterEditor`. No React.
 */

import {
  authoredLinkageFields,
  disclosedColumnNames,
  sanitizeForDisplay,
} from "@psilink/core";

import { isolatedColumnName } from "@components/ColumnName";

import { validateAdvancedInvite } from "./authoring/advancedInvite";

import { SEMANTIC_TYPE_LABELS } from "./metadataEditing";

import { isSilentEmpty } from "./workers/nonEmptyAggregate";

import { OFFLINE_EXCHANGE_REASON } from "./offlineExchangeGate";

import { TRANSPORT_ANSWER_LABELS } from "./transportChooser";

import { enabledKeys, identifierProblem } from "./inviterEditor";

import { RESULTS_DIRECTION_LABELS, lifetimeNoun } from "./formatting";

import type {
  AdvancedField,
  AdvancedInviteDraft,
  AdvancedValidation,
} from "./authoring/advancedInvite";

import type { LinkageField } from "@psilink/core";

import type { FieldValueCoverage } from "./workers/nonEmptyAggregate";

import type { AcquiredCsv, InviterEditor } from "./inviterEditor";

/** One quiet fact for the Customize menu; `target` is the tab the
 * fact's label opens. `tone` colors the fact only when the surface needs
 * attention (a failing cleaning pipeline); never conveyed by color alone. */
interface InviterRailFact {
  label: string;
  fact?: string;
  tone?: "attention";
  target: Extract<SpineTarget, "cleaning" | "keys" | "agreement">;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * The Cleaning tab's Customize-menu attention state, from the effective
 * standardization and the full-CSV coverage. A field is "failing" when its
 * transform drops every row ({@link isSilentEmpty}); the count de-duplicates
 * by field name. Invalid authored steps are NOT counted here -- {@link
 * validateAdvancedInvite} reports those, so counting them here would
 * double-report. `rates` is null before the first sweep settles, contributing
 * no failing fields.
 */
interface InviterCleaningAttention {
  /** Whether the Cleaning tab needs attention (any failing field present). */
  needsAttention: boolean;
  /** The number of fields whose pipeline produces no value in any row, for the
   * amber "N field(s) failing" value. */
  failingFieldCount: number;
  /** The Customize-menu fact string: undefined (em-dash) when no attention is
   * needed, else the amber value -- the failing-field count, or the
   * coverage-unavailable state (both matching the acceptor's). */
  railValue: string | undefined;
}

/**
 * Derive the Cleaning tab's attention state from the session's standardization,
 * the full-CSV coverage, and whether the coverage sweep failed for good. A
 * silent-empty field ({@link isSilentEmpty}) is failing; the count de-duplicates
 * by field name. No file, or a null (pending) rate map, raises nothing --
 * coverage is not yet known, not a collapse. A `coverageUnavailable` sweep over
 * a loaded file raises attention with no field count.
 */
export function inviterCleaningAttention(
  editor: InviterEditor | undefined,
  rates: ReadonlyMap<string, FieldValueCoverage> | null,
  coverageUnavailable: boolean,
): InviterCleaningAttention {
  const failing = new Set<string>();
  if (editor !== undefined && rates !== null)
    for (const transformation of editor.draft.standardization) {
      const rate = rates.get(transformation.output);
      if (rate !== undefined && isSilentEmpty(rate))
        failing.add(transformation.output);
    }
  const failingFieldCount = failing.size;
  const unavailable = editor !== undefined && coverageUnavailable;
  return {
    needsAttention: failingFieldCount > 0 || unavailable,
    failingFieldCount,
    railValue:
      failingFieldCount > 0
        ? `${plural(failingFieldCount, "field")} failing`
        : unavailable
          ? "Coverage unavailable"
          : undefined,
  };
}

/** The cleaning summary ("3 fields") shared by the Customize fact and the
 * check-your-answers row, so the two surfaces cannot disagree. */
function cleaningFact(draft: AdvancedInviteDraft): string {
  return plural(draft.standardization.length, "field");
}

/** The key-count summary ("2 keys") shared by the Customize fact and the
 * check-your-answers row. */
function keysFact(draft: AdvancedInviteDraft): string {
  return plural(enabledKeys(draft).length, "key");
}

/**
 * The Customize group's quiet facts, read live from the draft: cleaning
 * pipeline count, authored key count, and the agreement reference. Undefined
 * facts render as the em-dash "nothing yet" mark. When cleaning coverage is
 * failing ({@link inviterCleaningAttention}), the Cleaning fact turns amber
 * and names the failing-field count instead, matching the acceptor.
 */
export function inviterRailFacts(
  editor: InviterEditor | undefined,
  attention?: InviterCleaningAttention,
): Array<InviterRailFact> {
  const cleaningAttention =
    editor !== undefined && attention?.needsAttention === true;
  return [
    {
      label: "Cleaning",
      fact:
        editor === undefined
          ? undefined
          : cleaningAttention
            ? attention.railValue
            : cleaningFact(editor.draft),
      tone: cleaningAttention ? "attention" : undefined,
      target: "cleaning",
    },
    {
      label: "Matching on",
      fact: editor === undefined ? undefined : keysFact(editor.draft),
      target: "keys",
    },
    {
      label: "Legal agreement",
      fact: editor?.draft.legalAgreement?.reference,
      target: "agreement",
    },
  ];
}

/** A console section a Problems entry or a Change link can navigate to: a spine
 * step or a Customize tab. */
export type SpineTarget =
  "file" | "columns" | "review" | "cleaning" | "keys" | "agreement";

/** The section that owns each validation field, so a Problems entry can link
 * to where the fix lives. */
const FIELD_TARGETS: Record<AdvancedField, SpineTarget> = {
  identity: "file",
  output: "review",
  payload: "columns",
  keys: "keys",
  standardization: "cleaning",
  lifetime: "review",
  legalReference: "agreement",
  legalPurpose: "agreement",
  legalExpiration: "agreement",
};

/** One entry in the work column's Problems block: the message and the section
 * that can resolve it. `key` is a stable per-entry render key for entries whose
 * messages may repeat (two same-typed failing fields bound to one column);
 * absent, the message is the key. */
export interface SpineProblem {
  message: string;
  target: SpineTarget;
  key?: string;
}

/** Validate the draft for the create gate -- the AdvancedInvite model's own
 * validation over the console's session. */
export function reviewValidation(
  editor: InviterEditor,
  now: Date = new Date(),
): AdvancedValidation {
  return validateAdvancedInvite(editor.draft, editor.seed, now);
}

/**
 * The work column's Problems entries for a failing cleaning pipeline: one per
 * field whose transform produces no value in any row of the loaded file
 * ({@link isSilentEmpty}), de-duplicated by field name (the same key
 * {@link inviterCleaningAttention} counts by, so the rail count and the entry
 * count agree). Each entry names the field's safe semantic-type label -- never
 * the partner-controlled field name -- plus the input column when the draft
 * authors more than one field of that type. File-dependent (needs the
 * full-CSV coverage), so it lives beside {@link spineProblems} rather than
 * inside {@link validateAdvancedInvite}; the console merges the two. Empty
 * before a file is read, before the first sweep settles, or when nothing
 * collapses.
 */
export function cleaningCoverageProblems(
  editor: InviterEditor | undefined,
  rates: ReadonlyMap<string, FieldValueCoverage> | null,
): Array<SpineProblem> {
  if (editor === undefined || rates === null) return [];
  const typeByName = new Map(
    authoredLinkageFields(
      editor.draft.metadata,
      editor.draft.standardization,
    ).map((field) => [field.name, field.type]),
  );
  const authoredPerType = new Map<LinkageField["type"], number>();
  for (const transformation of editor.draft.standardization) {
    const type = typeByName.get(transformation.output);
    if (type !== undefined)
      authoredPerType.set(type, (authoredPerType.get(type) ?? 0) + 1);
  }
  const seen = new Set<string>();
  const problems: Array<SpineProblem> = [];
  for (const transformation of editor.draft.standardization) {
    const rate = rates.get(transformation.output);
    if (rate === undefined || !isSilentEmpty(rate)) continue;
    if (seen.has(transformation.output)) continue;
    seen.add(transformation.output);
    const type = typeByName.get(transformation.output);
    if (type === undefined) continue;
    const label =
      (authoredPerType.get(type) ?? 0) > 1
        ? `"${SEMANTIC_TYPE_LABELS[type]}" (from ${transformation.input})`
        : `"${SEMANTIC_TYPE_LABELS[type]}"`;
    problems.push({
      key: transformation.output,
      message: `Cleaning: ${label} produces no value in any row`,
      target: "cleaning",
    });
  }
  return problems;
}

/**
 * The work column's Problems block as an error summary: the single-identifier
 * conflict (which only inference can seed) plus every validation error, each
 * pointing at the section that owns the fix. Empty when the draft can mint.
 */
export function spineProblems(
  editor: InviterEditor | undefined,
  now: Date = new Date(),
): Array<SpineProblem> {
  if (editor === undefined) return [];
  const problems: Array<SpineProblem> = [];
  if (identifierProblem(editor.draft))
    problems.push({
      message: "Choose a single record identifier",
      target: "columns",
    });
  const { errors } = reviewValidation(editor, now);
  for (const [field, message] of Object.entries(errors)) {
    problems.push({ message, target: FIELD_TARGETS[field as AdvancedField] });
  }
  return problems;
}

/** What holds the create on the review step, in the reading order of the screen
 * itself: the blocker no edit here clears, then the transport's own setup, then
 * the cards below it, and the spine's outstanding problems last. */
export interface InviterCreateGates {
  /** The device reports no network and the chosen transport begins a live run
   * (a save-a-file transport connects to nothing, so it is never held). */
  offlineBlocked: boolean;
  /** An SFTP exchange chosen to run here has no connection authored yet. */
  connectionIncomplete: boolean;
  /** Why the split rendezvous and the retain choice disagree, `undefined` when
   * they do not. Already a complete, remedy-naming sentence, used as-is. */
  splitDirectoryProblem: string | undefined;
  /** Whether the file-handling card holds a combination core refuses. */
  exchangeFilesBlocked: boolean;
  /** Whether the connection-tuning card holds a value the run would refuse. */
  connectionTuningBlocked: boolean;
  /** Whether the diagnostics-and-recovery card holds an unconfirmed sweep. */
  runDiagnosticsBlocked: boolean;
  /** Whether the receipts card holds a combination the run would refuse. */
  receiptsBlocked: boolean;
  /** How many spine problems the draft holds; they are named last because the
   * cards above are collapsed disclosures whose own notice is invisible until
   * opened, while a spine problem is already listed in the work column. */
  problemCount: number;
}

/** The create gate and the two sentences that state it: what the step shows
 * beside the button, and what it announces to assistive tech at the button. */
interface InviterCreateStatus {
  /** Whether every gate is clear, which is what the create action enables on. */
  ready: boolean;
  /** The visible line under the create action. */
  statusLine: string;
  /** The live-region sentence, which names the action in full because it is read
   * apart from the button it sits beside. */
  announcement: string;
}

function heldCreate(
  statusLine: string,
  announcement: string,
): InviterCreateStatus {
  return { ready: false, statusLine, announcement };
}

/**
 * The review step's create gate with both of its sentences, derived together
 * so the button's enabled state, the line beside it, and the announcement
 * cannot disagree -- a gate reachable by only one of the three is
 * unrepresentable here. The visible line and the announcement differ in
 * wording alone: the line sits beside an action that names itself, the
 * announcement is read on its own.
 *
 * The chain follows the screen's reading order: an operator working down it
 * meets the first unresolved card first. Every gate but the offline one is
 * cleared on this step.
 */
export function inviterCreateStatus(
  gates: InviterCreateGates,
): InviterCreateStatus {
  if (gates.offlineBlocked)
    return heldCreate(OFFLINE_EXCHANGE_REASON, OFFLINE_EXCHANGE_REASON);
  if (gates.connectionIncomplete)
    return heldCreate(
      "Set up the SFTP connection above to continue.",
      "Set up the SFTP connection above before you can create.",
    );
  if (gates.splitDirectoryProblem !== undefined)
    return heldCreate(gates.splitDirectoryProblem, gates.splitDirectoryProblem);
  if (gates.exchangeFilesBlocked)
    return heldCreate(
      "Resolve the file-handling settings above to continue.",
      "Resolve the file-handling settings above before you can create.",
    );
  if (gates.connectionTuningBlocked)
    return heldCreate(
      "Resolve the connection-tuning settings above to continue.",
      "Resolve the connection-tuning settings above before you can create.",
    );
  if (gates.runDiagnosticsBlocked)
    return heldCreate(
      "Resolve the diagnostics-and-recovery settings above to continue.",
      "Resolve the diagnostics-and-recovery settings above before you can create.",
    );
  if (gates.receiptsBlocked)
    return heldCreate(
      "Resolve the receipts-and-record-keeping settings above to continue.",
      "Resolve the receipts-and-record-keeping settings above before you can create.",
    );
  if (gates.problemCount > 0)
    return heldCreate(
      `Resolve ${gates.problemCount === 1 ? "the problem" : `the ${gates.problemCount} problems`} above to continue.`,
      `${gates.problemCount === 1 ? "A problem" : `${gates.problemCount} problems`} above must be resolved before you can create.`,
    );
  return {
    ready: true,
    statusLine: "Ready to create.",
    announcement: "Ready to create the invitation.",
  };
}

/** One check-your-answers row: the term, its display value, and either the
 * section its Change link navigates to or the "set above" mark for the terms
 * owned by step 3 itself. */
interface AnswersRow {
  label: string;
  value: string;
  mono?: boolean;
  changeTarget?: SpineTarget;
  setAbove?: boolean;
}

/** The check-your-answers table: the full proposal restated before the point
 * of no return, each row's Change link navigating to the spine step or
 * Customize tab that owns the term. */
export function answersRows(
  editor: InviterEditor,
  csv: AcquiredCsv,
): Array<AnswersRow> {
  const sent = disclosedColumnNames(editor.draft.metadata);
  return [
    {
      label: "Your name",
      value: editor.draft.identity,
      changeTarget: "file",
    },
    {
      label: "Your file",
      value: `${sanitizeForDisplay(csv.fileName)} - ${new Intl.NumberFormat("en-US").format(csv.rowCount)} rows`,
      mono: true,
      changeTarget: "file",
    },
    {
      label: "Columns shared",
      value: sent.length > 0 ? sent.map(isolatedColumnName).join(", ") : "None",
      mono: sent.length > 0,
      changeTarget: "columns",
    },
    {
      label: "Cleaning",
      value: `${cleaningFact(editor.draft)}, filled in from your file`,
      changeTarget: "cleaning",
    },
    {
      label: "Matching on",
      value: `${keysFact(editor.draft)}, tried in order`,
      changeTarget: "keys",
    },
    {
      label: "Legal agreement",
      value: editor.draft.legalAgreement?.reference ?? "None",
      mono: editor.draft.legalAgreement?.reference !== undefined,
      changeTarget: "agreement",
    },
    {
      label: "Invitation duration",
      value: lifetimeNoun(editor.draft.lifetimeSeconds),
      setAbove: true,
    },
    {
      label: "Results go to",
      value: RESULTS_DIRECTION_LABELS[editor.draft.outputDirection],
      setAbove: true,
    },
    {
      label: "How it runs",
      value: TRANSPORT_ANSWER_LABELS[editor.transport ?? "browser"],
      setAbove: true,
    },
  ];
}
