import {
  countOnlyTransmitsColumn,
  decideLinkageTermsVerdict,
  inferMetadata,
  overlongDisclosedColumnPositions,
  sanitizeForDisplay,
} from "@psilink/core";

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

import { OFFLINE_EXCHANGE_REASON } from "./offlineExchangeGate";

import type {
  CSVRow,
  Displayable,
  LinkageField,
  LinkageTerms,
  Metadata,
  Standardization,
} from "@psilink/core";

import type { AcceptorDataEdits } from "@psi/acceptInvitation";
import type { FieldStepOverride } from "@psi/standardizationAuthoring";
import type { FieldValueCoverage } from "@psi/nonEmptyAggregate";

/**
 * The pure, React-free model behind the acceptor bench's "Confirm your columns"
 * step -- a port of the hardened legacy column editor's derivations, moved out
 * of the component so the verdict, mapper, cleaning-attention, launch-payload,
 * and gate logic are the one
 * tested boundary and React stays thin. No I/O and no state; every consent/verdict
 * semantic re-surfaces the existing logic layer ({@link decideLinkageTermsVerdict},
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
  /** The file's row total, held explicitly so display surfaces never read
   * `rawRows.length` (the console profiles the count server-side). */
  rowCount: number;
  /** A pre-inferred date-of-birth input layout
   * ({@link dateInputFormatForColumns}), set only by sources that profile it
   * without rows (the console); when absent, derivations infer it from the
   * rows as before. */
  dateInputFormat?: string;
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
 * faithful (see {@link normalizeForEditor}). "Reset to defaults" restores exactly
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
  dateInputFormat?: string,
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
    dateInputFormat,
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
   * partner-controlled key names. */
  deadKeyCount: number;
  /** Whether this file may be run under the adopted terms at all: core's own
   * grading, which the launch gate reads rather than re-deriving a threshold from
   * the counts above. `false` on any shortfall -- an unproducible key, a dead one,
   * or terms declaring none. */
  fullySatisfied: boolean;
}

/**
 * The live linkage-terms verdict over the EDITED `{ metadata, standardization }`.
 * Re-surfaces {@link decideLinkageTermsVerdict} against the adopted terms -- never
 * a re-derivation -- and maps its result to the mockup's exact copy and the spoken
 * announcement. Blocked when no key can match, partial when some but not all can,
 * all-clear when every key is covered.
 *
 * The three display kinds are a reading of coverage, not the launch decision: the
 * gate is `fullySatisfied`, core's own, which an all-clear coverage reading can
 * still fail when a covered key's declared cleaning drops every record.
 */
export function acceptorVerdict(
  columns: Array<string>,
  linkageTerms: LinkageTerms,
  editorState: { metadata: Metadata; standardization: Standardization },
): AcceptorVerdictViewModel {
  const verdict = decideLinkageTermsVerdict(
    columns,
    linkageTerms,
    editorState.standardization,
    editorState.metadata,
  );
  const totalKeys = linkageTerms.linkageKeys.length;
  const satisfiable = verdict.keys.length - verdict.unsatisfiableKeys.length;
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
    fullySatisfied: verdict.fullySatisfied,
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
  const verdict = decideLinkageTermsVerdict(
    columns,
    linkageTerms,
    editorState.standardization,
    editorState.metadata,
  );
  const seen = new Map<LinkageField["type"], string>();
  for (const field of verdict.unsatisfiedFields)
    seen.set(field.type, SEMANTIC_TYPE_LABELS[field.type]);
  return [...seen.entries()].map(([type, label]) => ({ type, label }));
}

/**
 * The gates the columns step itself contributes, which the model cannot derive from
 * the terms and the editor state: the transport connection an SFTP accept must have
 * authored, and a file-handling combination core refuses. Passed in so the whole
 * launch chain -- model-side and step-side -- resolves in one place.
 */
export interface AcceptorLaunchStepBlocks {
  /** Whether the browser reports no network. Every accept ends in a live
   * two-party session -- in this browser, or on the console appliance -- so an
   * offline device blocks the launch outright. Only this direction is a block:
   * a device reporting online is no promise the partner is reachable (see
   * `apps/web/src/utils/networkStatus.ts`). */
  offline: boolean;
  /** An SFTP accept whose transport connection is not authored yet. */
  connectionBlocked: boolean;
  /** A file-handling combination core refuses. */
  exchangeFilesBlocked: boolean;
  /** A connection-tuning value the run would refuse. Separate from
   * {@link exchangeFilesBlocked} because the two are separate cards: folding them
   * together would send the operator to the wrong one. */
  connectionTuningBlocked: boolean;
  /** An unconfirmed recovery sweep on the diagnostics-and-recovery card. A third
   * separate card, gated separately for the same reason. */
  runDiagnosticsBlocked: boolean;
  /** A receipt-signing or retention choice the run itself would refuse. A fourth
   * separate card, gated separately for the same reason. */
  receiptsBlocked: boolean;
  /** The requirement a split rendezvous makes of the file-handling choices, in the
   * console's own words, or undefined when it is met. Carried as its own SENTENCE
   * rather than a flag, because the remedy is the one control to turn on and the
   * blocked-launch line is where the operator meets it. */
  splitDirectoryProblem?: string;
}

const NO_STEP_BLOCKS: AcceptorLaunchStepBlocks = {
  offline: false,
  connectionBlocked: false,
  exchangeFilesBlocked: false,
  connectionTuningBlocked: false,
  runDiagnosticsBlocked: false,
  receiptsBlocked: false,
};

/**
 * The launch gate, expressed as the sentence the step shows beside the disabled
 * button and points its `aria-describedby` at -- `undefined` exactly when nothing
 * blocks, which is what the step disables on. Ported from the legacy editor's
 * predicate and widened to core's own grading: the file cannot be run under the
 * adopted terms (`verdict.fullySatisfied` is false), OR a count-only
 * invitation meets a marked column ({@link countOnlyTransmitsColumn}) -- an
 * arrangement the algorithm forecloses whatever the declaration says -- OR the
 * marked columns disagree with the payload set the invitation declares for this
 * party
 * ({@link acceptorPayloadDeclarationConflict}) -- a pair the exchange refuses to run
 * on -- OR a marked column's name is too long to carry
 * ({@link acceptorOverlongDisclosedColumns}) -- a name the partner's parse refuses
 * once the frame is already sent -- OR the metadata carries more than one identifier
 * column, OR an authored cleaning step is invalid/mid-edit, OR one of the step's own
 * blocks.
 *
 * The linkage clause is three sentences over one gate, because the three shortfalls
 * have three different remedies: missing coverage is remapped in the quick-fix
 * mapper above, partial coverage is remapped there or settled with the partner, and
 * a dead key is the partner's to correct -- it came with the invitation and no edit
 * on this screen clears it. Each states the remedy in the words of the notice it
 * sits under, and none names a partner-controlled key.
 *
 * The gate and the explanation are ONE derivation rather than two that agree, so a
 * state that disables the button while telling a screen-reader operator nothing is
 * unrepresentable rather than merely tested against. The declaration conflict holds
 * that shape across its own variants too: the sentence is the one the conflict
 * itself carries, so the notice's title and the button's reason are chosen in a
 * single place and cannot name different directions of the same disagreement.
 *
 * The chain opens with the one blocker that is not on the screen at all -- a
 * device reporting no network, which no edit here clears -- and then follows the
 * step's own reading order, so the sentence names the topmost unresolved surface
 * and an operator working down the screen is sent to the first thing they meet:
 * the verdict, then the count-only refusal, then the declaration conflict, then
 * the over-long name notice, then the grid's identifier rule, then the cleaning
 * steps, then the connection, the split rendezvous's retain-mode requirement, and
 * the file-handling and connection-tuning cards below them. Each names what to fix
 * on this screen, in the words of the notice it points at -- naming the card it is
 * about, since the collapsed cards below show no problem of their own until
 * opened.
 */
export function acceptorLaunchBlockedReason(
  verdict: AcceptorVerdictViewModel,
  editorState: { metadata: Metadata; standardization: Standardization },
  invitationTerms: LinkageTerms,
  stepBlocks: AcceptorLaunchStepBlocks = NO_STEP_BLOCKS,
): string | undefined {
  if (stepBlocks.offline) return OFFLINE_EXCHANGE_REASON;
  if (!verdict.fullySatisfied) {
    if (verdict.satisfiableKeyCount === 0)
      return "Set your columns to the missing field types above before you can start.";
    if (verdict.satisfiableKeyCount < verdict.totalKeys)
      return (
        "Cover the remaining agreed linkage keys above before you can start, " +
        "or agree terms with your partner over the keys both files can supply."
      );
    return (
      "Ask your partner for a corrected invitation before you can start: " +
      "cleaning declared in the agreed terms drops every record for a key, so " +
      "it can never match."
    );
  }
  // A count-only invitation answers the payload question outright, ahead of the
  // declaration conflict below: the algorithm carries no data column in either
  // direction whichever party the terms entitle to the count, so a marked column
  // is refused rather than reconciled against a declaration -- and an invitation
  // that declares no `payload.receive` at all leaves that comparison with nothing
  // to say. Core's own refusal at accept holds the same fact
  // (`assertCountOnlyTransmitsNoColumn`); this is the sentence that lets the
  // operator clear it here.
  if (countOnlyTransmitsColumn(invitationTerms.algorithm, editorState.metadata))
    return "Unmark the columns you send above before you can start: a count-only exchange sends none.";
  const declarationConflict = acceptorPayloadDeclarationConflict(
    invitationTerms,
    editorState.metadata,
  );
  if (declarationConflict !== undefined)
    return declarationConflict.launchBlockedReason;
  const overlong = acceptorOverlongDisclosedColumns(
    invitationTerms,
    editorState.metadata,
  );
  if (overlong.length > 0)
    return overlong.length === 1
      ? "Resolve the column name that is too long to send above before you can start."
      : "Resolve the column names that are too long to send above before you can start.";
  if (hasMultipleIdentifiers(editorState.metadata))
    return "Choose a single record identifier column above before you can start.";
  if (!acceptorStandardizationValid(editorState.standardization))
    return "Finish or fix the highlighted cleaning steps above before you can start.";
  if (stepBlocks.connectionBlocked)
    return "Set up the SFTP connection above before you can start.";
  if (stepBlocks.splitDirectoryProblem !== undefined)
    return stepBlocks.splitDirectoryProblem;
  if (stepBlocks.exchangeFilesBlocked)
    return "Resolve the file-handling settings above before you can start.";
  if (stepBlocks.connectionTuningBlocked)
    return "Resolve the connection-tuning settings above before you can start.";
  if (stepBlocks.runDiagnosticsBlocked)
    return "Resolve the diagnostics-and-recovery settings above before you can start.";
  if (stepBlocks.receiptsBlocked)
    return "Resolve the receipts-and-record-keeping settings above before you can start.";
  return undefined;
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
 * The launch payload: the edited `{ metadata, standardization }`, the exact shape
 * {@link AcceptorDataEdits} expects. The pair is the SAME one the verdict consumed,
 * so the gate and the run cannot disagree.
 *
 * It carries no coverage advisory: partial coverage stops the launch
 * ({@link acceptorLaunchBlockedReason}), so an exchange that reaches this payload is
 * one whose every agreed key the file can produce, and there is nothing left to warn
 * the run surface about.
 */
export function acceptorLaunchPayload(editorState: {
  metadata: Metadata;
  standardization: Standardization;
}): { edits: AcceptorDataEdits } {
  return {
    edits: {
      metadata: editorState.metadata,
      standardization: editorState.standardization,
    },
  };
}

/** The disclosed columns ("What you will send to your partner"), the same predicate
 * the run transmits on. */
export function acceptorDisclosedColumns(metadata: Metadata): Array<string> {
  return disclosedColumnNames(metadata);
}

/**
 * The 1-based positions of the marked columns whose name is too long to carry to
 * the partner, gated on at launch and named in its own notice. Re-surfaces
 * {@link overlongDisclosedColumnPositions}, the same predicate core's prepare-time
 * refusal reads, so this screen refuses exactly the names the run would -- the
 * acceptor's metadata is seeded by {@link inferMetadata} over its own header, which
 * no schema bounds, so without this gate an oversized marked header would reach the
 * partner's parse and be refused only after the frame was sent.
 *
 * Empty when the inviting party is entitled to no result: the payload step then
 * transmits nothing whatever the operator marks, so there is no carried name to
 * bound -- and a refusal here would contradict the panel beside it, which states
 * that nothing is sent. The same gate {@link acceptorPayloadDeclarationConflict}
 * applies to the empty declaration, and core's own refusal applies to this bound.
 */
export function acceptorOverlongDisclosedColumns(
  invitationTerms: LinkageTerms,
  metadata: Metadata,
): Array<number> {
  if (!invitationTerms.output.expectsOutput) return [];
  return overlongDisclosedColumnPositions(metadata);
}

/**
 * One column the invitation's declared payload set names that this party's marks do
 * not send -- core's OVER-declaration. The remedy for it is mostly the partner's, so
 * the entry carries what decides which remedies exist rather than the name alone.
 */
export interface AcceptorDeclaredColumnGap {
  /**
   * The declared name as the notice shows it: partner-controlled text, escaped
   * ({@link sanitizeForDisplay}) at this boundary because this view-model IS its
   * display sink -- the step renders the string as given. The operator's own column
   * names in the same notice take the opposite treatment (`ColumnName`'s bidi
   * isolation, applied where they are rendered), so the two provenances stay
   * distinguishable: only the half the operator cannot inspect is escaped.
   */
  displayName: Displayable;
  /**
   * Whether the operator's own file has a column of that name, which is what decides
   * whether marking it to send exists as a remedy at all. Read from the metadata,
   * which carries one entry per column of the chosen file.
   */
  inFile: boolean;
}

/**
 * Whether the invitation declares no payload column at all for this party
 * (`acceptsNothing`) or declares a set that disagrees with the marks
 * (`setMismatch`). The two are one refusal in core but not one remedy: an empty
 * declaration cannot be satisfied locally by disclosing more, since widening the
 * marks cannot make the partner accept a column it declared it takes none of.
 */
export type AcceptorPayloadDeclarationConflictKind =
  "acceptsNothing" | "setMismatch";

/**
 * The disagreement between the payload set the invitation declares for this party
 * and the columns the operator's marks disclose: the pair
 * `assertPayloadSendDisclosed` refuses inside `prepareForExchange`, surfaced before
 * the operator launches into it. Both directions can hold at once -- core reports
 * them in one refusal -- so both are carried here and stated together, rather than
 * one being revealed after the other is cleared.
 */
export interface AcceptorPayloadDeclarationConflict {
  kind: AcceptorPayloadDeclarationConflictKind;
  /** The notice's visible title, naming the direction(s) that hold. */
  title: string;
  /**
   * The launch gate's sentence for this conflict, carried beside the title so the
   * button's reason and the notice it points at are chosen in one place.
   */
  launchBlockedReason: string;
  /**
   * Columns the marks disclose that the declaration does not name -- core's
   * UNDER-declaration. The operator's OWN CSV headers, raw: the step renders them
   * through `ColumnName`, the isolation every column-name sink on that screen uses.
   * Non-empty is the direction with a local remedy, cleared by re-marking those
   * columns on this screen.
   */
  sentButNotDeclared: Array<string>;
  /**
   * Columns the declaration names that the marks do not send -- core's
   * OVER-declaration, in the order the declaration lists them. Partner-controlled
   * names ({@link AcceptorDeclaredColumnGap}), whose remedy leads with a corrected
   * invitation or a different file.
   */
  declaredButNotSent: Array<AcceptorDeclaredColumnGap>;
}

/**
 * The disagreement between the invitation's declared payload set for this party and
 * the operator's marks, or `undefined` when there is nothing to state -- so the
 * notice and the launch gate read ONE derivation and cannot disagree, and it clears
 * as the operator re-marks.
 *
 * Mirrors {@link assertPayloadSendDisclosed} exactly: an exact-set comparison in
 * both directions, with the ONE gate core has. Read from the INVITATION's own
 * perspective, which is the terms this step holds. An ABSENT `payload.receive` is
 * the lazy direction -- reconciled against this party's own disclosure when the
 * exchange runs, never held to equality -- while a PRESENT one mirrors onto this
 * party as the `payload.send` core enforces (`deriveAcceptedLinkageTerms`).
 *
 * Only the EMPTY declaration is gated on the inviting party's `output.expectsOutput`
 * (core's `shareWithPartner` on the mirrored side): an inviting party entitled to no
 * result is sent no payload at all, so the run transmits nothing whatever the
 * operator marks, core refuses nothing, and stating a conflict would contradict the
 * panel beside it -- which renders core's no-payload sentence off that same fact. A
 * NON-EMPTY declaration is ungated in both directions, exactly as core leaves it: it
 * is an accuracy control over a dictionary that is exchanged, consented to, and
 * written into the exchange record whatever the output direction. That cannot
 * contradict the same panel either, and by construction rather than by a second
 * gate here -- `LinkageTermsSchema` refuses a non-empty `payload.receive` alongside
 * `expectsOutput: false`, so an invitation carrying one never reaches this step
 * (packages/core/test/linkageTerms.test.ts drives that refusal, which is what
 * keeps this ungated).
 */
export function acceptorPayloadDeclarationConflict(
  invitationTerms: LinkageTerms,
  metadata: Metadata,
): AcceptorPayloadDeclarationConflict | undefined {
  const declared = invitationTerms.payload?.receive;
  if (declared === undefined) return undefined;
  if (declared.length === 0 && !invitationTerms.output.expectsOutput)
    return undefined;
  const declaredNames = declared.map((column) => column.name);
  const disclosed = acceptorDisclosedColumns(metadata);
  const declaredSet = new Set(declaredNames);
  const disclosedSet = new Set(disclosed);
  const sentButNotDeclared = disclosed.filter((name) => !declaredSet.has(name));
  const declaredButNotSent = declaredNames
    .filter((name) => !disclosedSet.has(name))
    .map((name) => ({
      displayName: sanitizeForDisplay(name),
      inFile: metadata.some((column) => column.name === name),
    }));
  if (sentButNotDeclared.length === 0 && declaredButNotSent.length === 0)
    return undefined;
  return {
    ...declarationConflictWording(
      declaredNames.length === 0,
      sentButNotDeclared.length,
      declaredButNotSent.length,
    ),
    sentButNotDeclared,
    declaredButNotSent,
  };
}

/**
 * The title and the launch sentence for a conflict, chosen together so the button's
 * reason is always the words of the notice it points at. Each variant names the
 * direction(s) that actually hold, since they send the operator to different
 * remedies: an empty declaration is the partner's to widen, an unexpected column is
 * the operator's to re-mark here, and a column the partner expects but this file
 * does not send may have no local remedy at all.
 */
function declarationConflictWording(
  declaresNothing: boolean,
  sentButNotDeclaredCount: number,
  declaredButNotSentCount: number,
): Pick<
  AcceptorPayloadDeclarationConflict,
  "kind" | "title" | "launchBlockedReason"
> {
  if (declaresNothing)
    return {
      kind: "acceptsNothing",
      title:
        sentButNotDeclaredCount === 1
          ? "Your partner will not accept this column"
          : "Your partner will not accept these columns",
      launchBlockedReason:
        "Resolve the columns your partner will not accept above before you can start.",
    };
  if (declaredButNotSentCount === 0)
    return {
      kind: "setMismatch",
      title:
        sentButNotDeclaredCount === 1
          ? "Your partner does not expect this column"
          : "Your partner does not expect these columns",
      launchBlockedReason:
        "Resolve the columns your partner does not expect above before you can start.",
    };
  if (sentButNotDeclaredCount === 0)
    return {
      kind: "setMismatch",
      title:
        declaredButNotSentCount === 1
          ? "Your partner expects a column you are not sending"
          : "Your partner expects columns you are not sending",
      launchBlockedReason:
        "Resolve the columns your partner expects above before you can start.",
    };
  return {
    kind: "setMismatch",
    title: "Your columns do not match what your partner expects",
    launchBlockedReason:
      "Resolve the columns that do not match what your partner expects above before you can start.",
  };
}

/** Whether the metadata carries more than one identifier column, surfaced as the
 * identifier-conflict hint and gated on at launch. Re-surfaces
 * {@link hasMultipleIdentifiers}. */
export function acceptorHasIdentifierConflict(metadata: Metadata): boolean {
  return hasMultipleIdentifiers(metadata);
}

/**
 * The Cleaning tab's Customize-menu attention state. The tab keeps its em-dash
 * placeholder until there is a REASON to review cleaning -- a silent-empty field (a transform
 * that drops every row), a dead key (a self-defeating adopted rule), or an
 * invalid/mid-edit step -- then it shows an amber attention value naming the failing
 * field count. The attention value itself decides nothing: what closes the launch is
 * the standardization gate a mid-edit step trips, and the linkage verdict a dead key
 * fails.
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
  /** The Customize-menu fact string: undefined (em-dash) when no attention is
   * needed, else the amber value naming the reason -- the failing-field count, the
   * dead-key count, or the coverage-unavailable state. */
  railValue: string | undefined;
}

/**
 * Derive the Cleaning tab's attention state from the effective standardization, the
 * full-CSV coverage, the dead-key count, and whether the coverage sweep failed for
 * good. A field is "failing" when its transform drops every row ({@link isSilentEmpty})
 * or an authored step is invalid; the count de-duplicates by field name. A dead key
 * alone still raises attention (there is a reason to open the tab -- the dead-key
 * advisory renders there) but contributes no failing-FIELD count, since the acceptor
 * cannot fix it. A `coverageUnavailable` sweep (a deterministic coverage failure)
 * raises attention as the lowest-priority reason -- with no field or key count -- so
 * the rail flags that the check could not run rather than staying silent.
 */
export function acceptorCleaningAttention(
  standardization: Standardization,
  rates: ReadonlyMap<string, FieldValueCoverage> | null,
  deadKeyCount: number,
  coverageUnavailable: boolean,
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
  const needsAttention =
    failingFieldCount > 0 || deadKeyCount > 0 || coverageUnavailable;
  const railValue = !needsAttention
    ? undefined
    : failingFieldCount > 0
      ? `${failingFieldCount} field${failingFieldCount === 1 ? "" : "s"} failing`
      : deadKeyCount > 0
        ? `${deadKeyCount} key${deadKeyCount === 1 ? "" : "s"} to review`
        : "Coverage unavailable";
  return { needsAttention, failingFieldCount, railValue };
}
