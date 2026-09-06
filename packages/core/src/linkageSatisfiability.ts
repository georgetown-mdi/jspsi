// Whether a set of declared linkage terms can ever produce a value -- the
// static, data-free half of standardization. These refusals judge agreed
// terms: prepareForExchange and runExchange call them inside an exchange,
// and the apps call them ahead of one to ask whether terms would work, by
// compiling the declared pipelines and running probe values through them.
//
// The execution half is standardization.ts, which owns the compiler and the key
// builder this reads; the value-level companion, which judges values an actual
// input file holds, is valueConstraints.ts.

import {
  chainDetailCauses,
  LinkageTermsUnsatisfiableError,
  OperatorConfigError,
  StandardizationTermsError,
  UsageError,
} from "./errors.js";
import type { Standardization } from "./config/standardizationSchema.js";
import type {
  LinkageField,
  LinkageKey,
  LinkageTerms,
  TransformStep,
} from "./config/linkageTermsSchema.js";
import { inferMetadata } from "./config/metadata.js";
import type { ColumnMetadata } from "./config/metadata.js";
import { DEFAULT_DATE_OUTPUT_FORMAT } from "./keyElementWidth.js";
import { declaredFanOutFunction } from "./fanOutFunctions.js";
import { redactPrivateKeyMaterial } from "./utils/sanitizeErrorForDisplay.js";
import {
  applyStep,
  commitCompiledTransforms,
  compileSteps,
  fanOutDeclaredMessage,
  parseDateFormat,
  renderDateOutput,
  resolveFieldColumns,
  STANDARDIZATION_FUNCTION_NAMES,
  stepCompileBudgetRefusalMessage,
  stepCompileRefusalMessage,
  stepCountRefusalMessage,
  uncompilableStepLabel,
  valueOverCeiling,
  YEAR_FORMAT_TOKENS,
} from "./standardization.js";
import type {
  CompiledStep,
  FieldValue,
  Params,
  PendingCompiledTransforms,
} from "./standardization.js";

/**
 * Validate that every standardization transformation output name corresponds to
 * a linkage field defined in the provided terms, and that every step function
 * name is known.
 *
 * Returns a list of error messages; an empty array means the standardization
 * spec is consistent with these terms. The output and function names embedded in
 * each message are interpolated raw -- consistent with the sibling
 * `assertPayloadSendDisclosed` / `validateCompatibility` guards -- because the
 * in-repo caller composes them into a {@link StandardizationTermsError}, where
 * the display boundary escapes them once. A caller that instead renders a
 * message directly owns that escape.
 */
export function validateStandardizationAgainstTerms(
  standardization: Standardization,
  terms: LinkageTerms,
): string[] {
  const errors: string[] = [];
  const fieldNames = new Set(terms.linkageFields.map((f) => f.name));

  for (const t of standardization) {
    if (!fieldNames.has(t.output)) {
      errors.push(
        `standardization output "${t.output}" does not match any linkage ` +
          "field name",
      );
    }
    for (const step of t.steps ?? []) {
      if (!STANDARDIZATION_FUNCTION_NAMES.includes(step.function)) {
        errors.push(
          `unknown standardization function ` +
            `"${step.function}" in transformation for ` +
            `"${t.output}"`,
        );
      }
    }
  }

  return errors;
}

/**
 * Fail closed when an AUTHORED ("authoritative") standardization contradicts its
 * linkage terms -- the throwing wrapper around
 * {@link validateStandardizationAgainstTerms}, so the mint boundary
 * (`psilink invite`) and {@link prepareForExchange} refuse an inconsistent config
 * with one identical, actionable error rather than each inlining the check. The
 * standardization sibling of `assertPayloadSendDisclosed`.
 *
 * Both classes the validator reports -- a transform output naming no declared
 * linkage field, and an unknown standardization function -- are structurally fatal
 * for an authoritative config; it reports no advisory class a config might
 * legitimately hold as a note. Callers gate this on
 * `standardization !== undefined`: an absent standardization is the
 * terms-only path, reconstructed FROM the terms
 * (via `getDefaultStandardization`) and so unable to contradict them, and is
 * not gated.
 *
 * Throws {@link StandardizationTermsError} (a {@link UsageError} subclass: the CLI
 * classifies it as a configuration error, exit 64; on the web it is the one
 * prepare-time fault whose message -- naming only the authoring party's own outputs
 * and functions -- is safe to show).
 */
export function assertStandardizationMatchesTerms(
  standardization: Standardization,
  terms: LinkageTerms,
): void {
  const inconsistencies = validateStandardizationAgainstTerms(
    standardization,
    terms,
  );
  if (inconsistencies.length > 0)
    throw new StandardizationTermsError(
      "this configuration's standardization is inconsistent with its linkage " +
        `terms: ${inconsistencies.join("; ")}. Correct the standardization or ` +
        "the linkage terms so every transform output names a declared linkage " +
        "field and every step function is known.",
    );
}

/**
 * Refuse transforms that declare a fan-out step under a linkage strategy that
 * matches a single value per record, before any matching begins.
 *
 * Fan-out matching is specified for the single-pass strategy and for it alone
 * (docs/spec/PROTOCOL.md, Fan-out runs under single-pass only), so terms naming
 * anything else are refused here: the cascade -- the schema default -- has no
 * fan-out realization, and a candidate set reaching it would be narrowed to less
 * than the terms declare. The gate is an ALLOWLIST rather than a cascade-named
 * denylist, so a strategy later added to `LinkageStrategySchema` refuses a
 * fan-out until it too realizes one. It is the fan-out sibling of
 * `assertAlgorithmImplemented` and `assertDeduplicateImplemented` in
 * `exchange.ts`, and it runs at the three points those use: when terms are
 * authored or minted, at the local prepare step, and at the agreed-terms run
 * boundary.
 *
 * Both authoring surfaces a fan-out step can reach are checked, because both
 * realize a candidate set: a standardization transformation feeds
 * {@link StandardizedField}, and a linkage-key element transform feeds
 * {@link buildKeyStrings}; either way the candidates cross into the key's
 * candidate set. `standardization` is omitted where the caller no longer holds one
 * (the run boundary reads a prepared exchange, which retains the built dataset
 * rather than the spec); what covers that half there is
 * {@link fanOutReachedMatchingRefusal} on the cascade, and on single-pass the
 * declared-width check its table build runs -- both at the point of harm, but
 * after this party's terms have gone on the wire.
 *
 * The asymmetry that half holds is why the local surface is refused here at all
 * rather than left to the strategy: an element-transform fan-out rides the agreed
 * terms and both parties refuse it in lockstep, while a standardization is
 * per-party and local, so a partner cannot derive its refusal and would be left
 * waiting on a run this party is about to abort.
 *
 * The two surfaces share the same message under DIFFERENT error classes,
 * because they differ in whose content the fault is. A `standardization` is
 * only ever this party's own: no invitation holds one (it is per-party and
 * local), and the
 * accept path derives its own from the adopted terms through
 * `getDefaultStandardization`, whose steps come from the fixed per-type pipelines
 * and never include a fan-out function. So that half is an
 * {@link OperatorConfigError} -- the membership rule for the actionable "config"
 * category both front ends key off -- like `assertSigningModeImplemented`, and
 * raised as the base class because no narrower member fits (this is an
 * unimplemented-feature refusal, not the terms inconsistency
 * {@link StandardizationTermsError} names). A linkage-key element transform is
 * adopted verbatim from the partner's invitation on the accept path, so that half
 * stays a plain {@link UsageError} whose message the web's generic alert swallows,
 * for the same reason as `assertAlgorithmImplemented`. Either way the message names
 * only the fan-out functions this module recognizes -- a declared name reaches it
 * having already matched one -- so no partner free text is interpolated, and the
 * CLI classifies both as a usage error (exit 64) through the base class.
 */
export function assertFanOutImplemented(
  terms: LinkageTerms,
  standardization?: Standardization,
): void {
  if (terms.linkageStrategy === "single-pass") return;
  for (const transformation of standardization ?? []) {
    const declared = declaredFanOutFunction(transformation.steps);
    if (declared !== undefined)
      throw new OperatorConfigError(fanOutDeclaredMessage(declared));
  }
  for (const key of terms.linkageKeys) {
    for (const element of key.elements) {
      const declared = declaredFanOutFunction(element.transform);
      if (declared !== undefined)
        throw new UsageError(fanOutDeclaredMessage(declared));
    }
  }
}

/**
 * Upper bound on the transform steps one document may declare in total, across
 * its standardization and every linkage-key element, checked by
 * {@link assertTransformsCompile} before anything is compiled.
 *
 * This is the bound an author acts on, because it is a property of the document
 * alone: the wall-clock budget below answers differently on a fast machine than
 * on a loaded one, so it cannot be what a refusal's "declare fewer steps" remedy
 * refers to. 1024 is far above what a party mints (the bundled terms declare
 * steps in the tens across every key) and far below what the wire schema admits,
 * which is `MAX_TRANSFORM_STEPS` steps per element over `MAX_KEY_ELEMENTS`
 * elements per key (`config/linkageTermsSchema.ts`). Measured on the most
 * expensive step this build compiles, a `parse_date` with a distinct
 * 256-character format: 1024 of them compile in about 0.7 s on an idle
 * container against the 2 s budget, and 2560 -- which this bound refuses
 * outright -- in about 1.96 s, close enough to the budget that the same
 * document minted on a loaded machine is refused instead.
 */
const TRANSFORM_COMPILE_MAX_STEPS = 1024;

/**
 * Total wall-clock budget, in milliseconds, for compiling every declared step of
 * one document in {@link assertTransformsCompile}. The count bound above holds
 * how many steps reach the walk; this holds the walk's cost for a document under
 * that bound whose steps are individually expensive, a partner-authored
 * `parse_date` format or raw pattern compiling under the linear-time engine at a
 * cost the wire bounds do not hold down. Once the budget is spent the remaining
 * steps are refused unchecked (fail closed), the same shape the dialect walk
 * takes (`config/transformRegexDialect.ts`). A document a party would actually
 * mint finishes in single-digit milliseconds.
 */
const TRANSFORM_COMPILE_TOTAL_BUDGET_MS = 2000;

/** Optional overrides for the compile walk's bounds; both defaulted. Exposed so
 * tests can drive the two refusal paths deterministically. */
interface TransformCompileBudget {
  /** Total wall-clock budget across all steps; see
   * {@link TRANSFORM_COMPILE_TOTAL_BUDGET_MS}. */
  totalBudgetMs?: number;
  /** Total declared steps the document may hold; see
   * {@link TRANSFORM_COMPILE_MAX_STEPS}. */
  maxSteps?: number;
}

/**
 * The refusal for a document declaring more than `maxSteps` transform steps in
 * total, or `undefined` for one within the bound. Counted before any step is
 * compiled, so what it answers is the document's own shape and nothing about the
 * machine it is minted on.
 *
 * The class follows the surface whose steps take the total past the bound, in
 * the order {@link assertTransformsCompile} walks them -- whose content the
 * fault is, the split the compile refusals keep. The message states the whole
 * document's count, since the remedy spans both surfaces.
 */
function stepCountRefusal(
  terms: LinkageTerms,
  standardization: Standardization | undefined,
  maxSteps: number,
): Error | undefined {
  const standardizationSteps = (standardization ?? []).reduce(
    (total, transformation) => total + (transformation.steps ?? []).length,
    0,
  );
  const elementSteps = terms.linkageKeys.reduce(
    (total, key) =>
      total +
      key.elements.reduce(
        (keyTotal, element) => keyTotal + (element.transform ?? []).length,
        0,
      ),
    0,
  );
  const declaredSteps = standardizationSteps + elementSteps;
  if (declaredSteps <= maxSteps) return undefined;
  return standardizationSteps > maxSteps
    ? new OperatorConfigError(stepCountRefusalMessage(declaredSteps, maxSteps))
    : new UsageError(stepCountRefusalMessage(declaredSteps, maxSteps));
}

/**
 * Refuse a declared pipeline whose compile throws, where the terms are authored
 * or minted rather than where the run reaches it.
 *
 * A step's factory reads its parameters once, before the first row
 * ({@link compileSteps}), and a `pad_left` with no `length`, a multi-character
 * fill, a `phonetic` naming an unimplemented algorithm, or a function name this
 * build does not recognize throws there. Without this the throw lands after the
 * invitation is sealed and accepted, so the partner has spent its setup effort
 * before the authoring fault shows -- and the remedy the run boundary can offer
 * by then is out-of-band renegotiation rather than an edit. The message here is
 * the author's: correct the parameters, or remove the step.
 *
 * The fan-out sibling {@link assertFanOutImplemented} runs at the same points and
 * checks the same two pipeline surfaces, for the same reason both realize what a
 * key is built from: a standardization transformation feeds
 * {@link StandardizedField}, and a linkage-key element transform feeds
 * {@link buildKeyStrings}. `standardization` is omitted where the caller holds
 * none.
 *
 * The two surfaces share one message under DIFFERENT error classes, by whose
 * content the fault is -- as the fan-out refusal splits them. A
 * `standardization` is only ever this party's own, so that half is an
 * {@link OperatorConfigError}, the actionable "config" category both front ends
 * key off. A linkage-key element transform is adopted verbatim from the
 * partner's invitation on the accept path, so that half stays a plain
 * {@link UsageError}. Either way the message names only a function label this
 * build recognizes, so no partner free text is interpolated, and the CLI
 * classifies both as a usage error (exit 64) through the base class.
 *
 * This is the safety check at the mint boundary, not the authoring surface: the
 * web element editor marks a malformed param on the input that has to change
 * (`StepListEditor`). What reaches here is what that does not cover -- an
 * imported document, or a caller that mints without the editor. It runs once
 * per mint rather than on every editor pass, because compiling a whole
 * document's transforms costs enough to need bounding.
 *
 * Two bounds hold that cost. The declared step count
 * ({@link TRANSFORM_COMPILE_MAX_STEPS}) is checked before anything compiles, so
 * a document over it takes the same refusal on every machine and every retry;
 * the wall-clock budget ({@link TRANSFORM_COMPILE_TOTAL_BUDGET_MS}) stands
 * behind it for a document under the count whose steps are expensive. The
 * compiles are memoized ({@link uncompilableStepLabel}) once the walk has
 * finished, so a repeated mint of one document pays for them once, while a
 * refused one leaves nothing behind for a retry to build on.
 */
export function assertTransformsCompile(
  terms: LinkageTerms,
  standardization?: Standardization,
  budget: TransformCompileBudget = {},
): void {
  const totalBudgetMs =
    budget.totalBudgetMs ?? TRANSFORM_COMPILE_TOTAL_BUDGET_MS;
  const overCount = stepCountRefusal(
    terms,
    standardization,
    budget.maxSteps ?? TRANSFORM_COMPILE_MAX_STEPS,
  );
  if (overCount !== undefined) throw overCount;
  // Compiled steps are held aside and committed only where the whole walk
  // finished, so a refused document is refused again unchanged. Committing them
  // as the walk went would let the next walk over the same arrays resume past
  // what this one paid for, admitting after enough retries a document no edit
  // had touched.
  const pending: PendingCompiledTransforms = new Map();
  const startedAt = Date.now();
  for (const transformation of standardization ?? []) {
    if (Date.now() - startedAt >= totalBudgetMs)
      throw new OperatorConfigError(
        stepCompileBudgetRefusalMessage(totalBudgetMs),
      );
    const label = uncompilableStepLabel(transformation.steps, pending);
    if (label !== undefined)
      throw new OperatorConfigError(stepCompileRefusalMessage(label));
  }
  for (const key of terms.linkageKeys) {
    for (const element of key.elements) {
      if (Date.now() - startedAt >= totalBudgetMs)
        throw new UsageError(stepCompileBudgetRefusalMessage(totalBudgetMs));
      const label = uncompilableStepLabel(element.transform, pending);
      if (label !== undefined)
        throw new UsageError(stepCompileRefusalMessage(label));
    }
  }
  commitCompiledTransforms(pending);
}

/**
 * The linkage fields in `terms` that the input `columns` cannot satisfy through
 * the available data standardizations. The verdict is derived from the same
 * {@link resolveFieldColumns} binding the exchange's {@link buildStandardizedDataset}
 * uses: a field is producible exactly when the shared resolution bound it to a
 * column that is present in `columns`. The checker does not re-derive the
 * binding itself, so it cannot diverge from the runtime: there is one
 * resolution rather than two, leaving the HIGH-severity direction (a field the
 * builder cannot produce but the checker passes) no second reading to arise
 * from.
 *
 * Because the binding is shared, the resolution rules apply unchanged: an
 * explicit standardization preempts the type fallback (a field whose explicit
 * source column is absent is unsatisfiable even when a same-typed column exists),
 * and the type fallback binds to the FIRST `role: linkage` metadata column of the
 * field's type. An empty result means every configured field can be produced; a
 * non-empty result names the fields that cannot.
 *
 * Pass `metadata` to match an exchange that runs from an explicit metadata block
 * (`prepareForExchange` resolves the type fallback against
 * `metadata ?? inferMetadata`); omit it to fall back to name-based inference, the
 * accept-path default.
 */
export function unsatisfiedLinkageFields(
  columns: string[],
  terms: LinkageTerms,
  standardization?: Standardization,
  metadata?: ColumnMetadata[],
): LinkageField[] {
  const present = new Set(columns);
  const resolution = resolveFieldColumns(
    terms,
    standardization,
    metadata ?? inferMetadata(columns),
  );
  // A field is producible iff the shared resolution bound it to a column present
  // in the input. The binding rules (explicit-preempts-fallback, first-match type
  // fallback) live in resolveFieldColumns, not here, so this verdict cannot drift
  // from the builder's.
  return terms.linkageFields.filter((f) => {
    const column = resolution.get(f.name)?.column;
    return column === undefined || !present.has(column);
  });
}

/**
 * Whether a `parse_date` step's INPUT format omits a date component the factory
 * requires, making {@link parseDateFactory} return null for EVERY value -- the
 * record is dropped regardless of its data. The motivating example is
 * `input_format: "MM/DD"` (no year): with no year token, the factory's `year`
 * component is never set and its all-three-components guard drops every value.
 *
 * The year component is supplied by EITHER year token ({@link YEAR_FORMAT_TOKENS}:
 * `YYYY` or `YY`), matching the factory, which populates `year` from whichever it
 * tokenizes; month needs `MM`, day needs `DD`.
 *
 * This mirrors {@link parseDateFactory}'s coercion exactly so the verdict cannot
 * drift from the runtime. A nullish input format falls back to the factory's
 * complete `"MM/DD/YYYY"`, which drops nothing. A non-nullish NON-string (wire
 * params are `z.unknown()`, so a partner can supply one) never yields a value at
 * runtime -- the factory coerces any non-string to an empty format that tokenizes
 * to an all-dropping pattern -- so it is dead, and is reported so WITHOUT calling
 * {@link parseDateFormat} on the non-string (which would throw on an array). For a
 * string input format the present component set is recovered from core's OWN
 * tokenizer ({@link parseDateFormat}), not a re-implemented scan -- the
 * encode-the-runtime-invariant-as-a-check rule, here over a "this never produces a
 * value" claim.
 */
export function parseDateInputDropsEveryRecord(
  params: Params | undefined,
): boolean {
  const raw = params?.inputFormat;
  if (raw === null || raw === undefined) return false;
  if (typeof raw !== "string") return true;
  const present = new Set(parseDateFormat(raw).order);
  const hasYear = YEAR_FORMAT_TOKENS.some((token) => present.has(token));
  return !hasYear || !present.has("MM") || !present.has("DD");
}

/**
 * The functions whose compiled step returns a value for EVERY value it is handed:
 * it may fold, erase to the empty string, pad, or expand that value, but it never
 * returns null (and never empties a candidate set, since erasing every candidate
 * to the empty string leaves the set non-empty). Every other function can leave a
 * realized value empty, which is the only way the substituting branch of a later
 * `coalesce` is ever reached.
 *
 * An ALLOWLIST rather than a list of the emptying functions, so a function added
 * to {@link STANDARDIZING_FUNCTIONS} without a decision here is treated as able
 * to empty a value -- as does a name this build does not recognize at all. That
 * over-states a `coalesce`'s reach on a consent surface, where understating it is
 * the harmful direction.
 *
 * Name-only, not params-aware: a `null_if` with an empty exclusion list and a
 * `filter_regex` matching everything drop nothing in practice, and each is still
 * classified as able to. Pinned to the real functions by a drift test that drives
 * every one of them over a value corpus.
 */
const VALUE_PRESERVING_FUNCTION_NAMES: ReadonlySet<string> = new Set([
  "remove_non_ascii",
  "replace_separators_with_spaces",
  "squash_spaces",
  "remove_punctuation",
  "remove_dashes",
  "trim_whitespace",
  "to_upper_case",
  "to_lower_case",
  "remove_accents",
  "remove_affixes",
  "pad_left",
  "replace_regex",
  "split_on",
  "coalesce",
]);

/**
 * Whether `step` can leave a value the record realized empty -- the position half
 * of {@link coalesceSubstitutesConstant}, since a `coalesce` substitutes only
 * where some earlier step has emptied the value.
 *
 * @internal exported so the drift test can hold this classification to the real
 * functions: each is driven over a value corpus, and one classified
 * value-preserving that returns null for any of them fails.
 */
export function stepCanEmptyRealizedValue(step: TransformStep): boolean {
  return !VALUE_PRESERVING_FUNCTION_NAMES.has(step.function);
}

/**
 * Whether the `coalesce` step at a given position actually substitutes its
 * fallback there. Two conditions, both necessary:
 *
 * - Its declared `default` is a string, the only shape {@link compileStep} turns
 *   into a substitution value. Wire params are `z.unknown()` with no per-function
 *   shape, so a partner can declare `default` as any JSON value (or omit it);
 *   every non-string behaves as an absent default, which {@link applyStep}'s
 *   coalesce branch runs as a pass-through.
 * - Some step BEFORE it can empty the value ({@link stepCanEmptyRealizedValue}).
 *   The branch that substitutes fires on a null value or an empty candidate set,
 *   and a pipeline starts from a non-null string -- {@link applyElementTransform}
 *   and {@link runCompiledPipeline} both take one -- so a coalesce reached with a
 *   value still in hand returns that value untouched. An ABSENT field never
 *   reaches the step either: {@link buildKeyStrings} drops the whole row for the
 *   key when the field realizes no value, and a field whose column is missing
 *   realizes none without running its pipeline at all. So the records a
 *   substituting coalesce puts on one constant are the ones an earlier RULE
 *   emptied, never the ones whose field is absent.
 *
 * `precedingSteps` are the steps that run before `step` in the same pipeline,
 * required rather than defaulted: the verdict is a property of the position, not
 * of the step alone.
 *
 * Shared so every terms-level reading of a coalesce's effect -- the dead-pipeline
 * rescue in {@link pipelineAlwaysDrops}, and the consent header's collapse marker
 * and per-step detail copy in `invitationSummary.ts` -- turns on one predicate
 * rather than a restated test that could drift from the runtime.
 */
export function coalesceSubstitutesConstant(
  step: TransformStep,
  precedingSteps: ReadonlyArray<TransformStep>,
): boolean {
  return (
    step.function === "coalesce" &&
    typeof step.params?.default === "string" &&
    precedingSteps.some(stepCanEmptyRealizedValue)
  );
}

/**
 * Whether a `substring` step's declared bounds read NOTHING out of a value of
 * ANY length -- the value-INDEPENDENT drop {@link pipelineAlwaysDrops} is built
 * from, as opposed to a window that merely overshoots the values one input
 * happens to hold. The motivating shape is a bound the operator never filled or
 * cleared mid-edit (`substring` with no `start`), which the terms schema admits
 * as well-formed while {@link substringFactory} nulls every row.
 *
 * The conditions, each a case where {@link substringWindow} returns no window
 * whatever `valueLength` it is handed:
 *
 * - `start` is not an integer, or is `0`. Both are the guard `substringWindow`
 *   opens with, which never consults the value.
 * - `length` is not an integer. Same guard.
 * - `length` is `0`: the end argument lands exactly on the start bound, and a
 *   window closing where it opens slices `""`.
 * - `length` is negative AND the composed end argument cannot outrun the start
 *   bound for any value. Two shapes reach that. A positive `start` whose
 *   `start + length >= 1` leaves the end argument at or above zero and at or
 *   below the start bound, so the window is empty at every length. A `start` of
 *   `-1` reads from the last character onward, and no negative `length` puts an
 *   end past it -- the end argument counting back from the value's own end
 *   lands at or before that last character for every length.
 *
 * A negative `length` in any OTHER combination reads a real window once the
 * value is long enough (`slice` counts a below-zero end argument back from the
 * end of the value), so it is the data's to decide and is not claimed here.
 * Whether a value is ever that long is the acceptor's data, which the terms do
 * not contain.
 *
 * The arithmetic is a second reading of {@link substringWindow}'s, which is what
 * a differential sweep in `linkageSatisfiability.test.ts` exists for: it drives
 * the shipped key builder over every bound pair in a grid and every value
 * length a window could open at, and fails on any pair where this verdict and
 * the measured one disagree in either direction.
 *
 * @internal exported so that sweep can compare the two readings, and so the
 * rescue-equivalence sweep can model the same drop source the shipped predicate
 * reads.
 */
export function substringWindowDropsEveryValue(
  params: Params | undefined,
): boolean {
  const start = params?.start;
  const length = params?.length;
  if (typeof start !== "number" || !Number.isInteger(start) || start === 0)
    return true;
  if (typeof length !== "number" || !Number.isInteger(length)) return true;
  if (length > 0) return false;
  return length === 0 || start === -1 || start + length >= 1;
}

/**
 * The dates {@link substringCollapsesParsedDateToConstant} measures a pipeline
 * over. Chosen so that the first two differ in EVERY digit of every rendered
 * component -- 1971 against 2068 in all four year digits, 01 against 12 in both
 * month digits, 02 against 31 in both day digits -- which is what makes "the
 * windows agree" the property the verdict claims rather than a coincidence of
 * one sample: a window reading any character the date supplied differs between
 * those two wherever the layout put it. The other two add digit variety for a
 * step that rewrites characters rather than moving them. Every year is inside
 * the `YY` pivot window (1969-2068, {@link TWO_DIGIT_YEAR_PIVOT}) and every date
 * is a real calendar date, so each probe is a value the factory can actually
 * emit whichever input format parsed it.
 *
 * These dates are public whether or not they are exported -- they ship in source
 * an inviter can read -- which is why a probe a declared step drops leaves the
 * verdict to the surviving ones rather than withdrawing it.
 *
 * @internal exported so the test that authors a step naming a probe's rendered
 * value names a real one rather than a date it assumes is probed.
 */
export const DATE_COLLAPSE_PROBES: ReadonlyArray<{
  year: string;
  month: string;
  day: string;
}> = [
  { year: "1971", month: "01", day: "02" },
  { year: "2068", month: "12", day: "31" },
  { year: "1990", month: "05", day: "13" },
  { year: "2007", month: "11", day: "24" },
];

// What a compiled run leaves one starting value on. The shapes are read apart
// because the verdicts below turn on WHICH of them was reached, not merely on
// whether a value was:
//
// - `value`: the characters the run holds, which is what a collapse compares
//   across probes.
// - `dropped`: the run produced no value, which is the opposite of a collapse
//   and, where the run is layout-determined, is every record's fate.
// - `candidates`: a non-empty candidate set, so the record still keys -- which
//   is what a collapsed constant needs of the pipeline's TAIL. A fan-out INSIDE a
//   measured run is a can't-measure that resolves upward like `unread`, and the
//   element declares a fan-out, so the consent header ranks that breadth above
//   this verdict regardless.
// - `unread`: the run could not be reduced to one of the readings above. A step
//   that leaves the value over the per-value ceiling
//   ({@link MAX_TRANSFORMED_VALUE_LENGTH}) reports it here, as does an empty
//   candidate set or an empty string -- shapes a window neither holds as a value
//   nor drops as null. The caller resolves an `unread` probe UPWARD to the
//   broader breadth word ({@link readParsedDateRun}): an inviter could otherwise
//   inflate one probe past the ceiling to buy a milder marker while every real
//   date still collapses.
type MeasuredRunOutcome =
  | { kind: "value"; value: string }
  | { kind: "dropped" }
  | { kind: "candidates" }
  | { kind: "unread" };

// The per-VALUE ceiling ({@link MAX_TRANSFORMED_VALUE_LENGTH}) is charged here as
// the runtime does; the per-ROW assembled charge
// ({@link MAX_ASSEMBLED_KEY_LENGTH_PER_ROW}) is not, because `applyStep` runs
// without a `site`. That charge binds the candidates a single row accumulates
// across a key's elements, which this per-element, per-probe measurement never
// assembles -- one probe date cannot reach it -- so its absence changes no
// reading. A measured limit, not an omission: the ceiling the marker rests on is
// checked; the row-assembly bound the exchange also enforces is out of this
// measurement's scope.
function runCompiledSteps(
  input: string,
  compiled: ReadonlyArray<CompiledStep>,
): MeasuredRunOutcome {
  let current: FieldValue = input;
  for (const step of compiled) {
    current = applyStep(current, step);
    if (valueOverCeiling(current) !== undefined) return { kind: "unread" };
  }
  if (current === null) return { kind: "dropped" };
  if (current instanceof Set)
    return current.size > 0 ? { kind: "candidates" } : { kind: "unread" };
  return current === ""
    ? { kind: "unread" }
    : { kind: "value", value: current };
}

/**
 * The functions whose effect on a value a `parse_date` rendered is fixed by
 * the output LAYOUT alone. Every date the factory renders under one output
 * format has the same length, and the format's own characters land in the same
 * places -- only the digits differ ({@link renderDateOutput} substitutes
 * fixed-width components) -- and each function here maps any two such values to
 * values that again share a length and are null together, so a window read after
 * it lands on the same characters for every date. That composes: a run built
 * only from these leaves every date holding a value, or drops every date.
 *
 * Membership is what parts a measured all-probes drop that is really DEAD from
 * one the data decides, and its converse is the safe side: a function absent
 * from the set makes such a run report a value-DEPENDENT drop, which announces
 * the wider breadth word rather than claiming an element matches nothing. So
 * only functions that read no content are here. `null_if`, `filter_regex`,
 * `extract_regex` and `replace_regex` turn on the value's own characters;
 * `remove_affixes` and `phonetic` match word content; a nested `parse_date` can
 * parse one rendering and not another; and `split_on` leaves a candidate set
 * rather than a value.
 *
 * @internal exported so the drift test can hold this classification to the real
 * functions: each name is driven over a corpus of dates under several output
 * formats, and one whose outputs differ in length or in null-ness between two
 * dates fails. That drives one params shape per function, so it catches a listed
 * function that starts reading content, not a listed function some other params
 * shape would expose; the membership decision itself stays a review call.
 */
export const LAYOUT_DETERMINED_FUNCTION_NAMES: ReadonlySet<string> = new Set([
  "remove_non_ascii",
  "replace_separators_with_spaces",
  "squash_spaces",
  "remove_punctuation",
  "remove_dashes",
  "trim_whitespace",
  "to_upper_case",
  "to_lower_case",
  "remove_accents",
  "substring",
  "pad_left",
  "coalesce",
]);

// What running a substring run's measured steps over {@link DATE_COLLAPSE_PROBES}
// establishes about the window the run reads.
//
// `undetermined` and `cannotMeasure` are read APART because they resolve in
// opposite directions on a consent surface:
//
// - `undetermined`: the shape conditions for a measurement are not met (the index
//   is not a run end, no live `parse_date` lies ahead, or the `parse_date` drops
//   every record), or the measurement COMPLETED and the surviving probes hold
//   distinct values -- a determinate coarsening. Nothing here understates a
//   collapse, so the caller resolves it to the milder / no-marker side.
// - `cannotMeasure`: the measurement could not be completed -- a step crossed the
//   per-value ceiling ({@link MAX_TRANSFORMED_VALUE_LENGTH}), expanded into a
//   candidate set, or a step this build cannot compile or run threw -- so the
//   window's breadth is unknown. An unknown breadth resolves UP to the collapse
//   word: understating breadth is the only harmful direction on a consent
//   surface, and an inviter must not buy the milder marker by making one probe
//   unmeasurable while every real date still collapses.
type ParsedDateRunReading =
  | { kind: "collapsed"; value: string }
  | { kind: "valueDependentDrop" }
  | { kind: "layoutDeterminedDrop" }
  | { kind: "undetermined" }
  | { kind: "cannotMeasure" };

const UNDETERMINED: ParsedDateRunReading = { kind: "undetermined" };
const CANNOT_MEASURE: ParsedDateRunReading = { kind: "cannotMeasure" };

/**
 * Run the steps from the `parse_date` that laid out the value to the end of the
 * substring run at `index` over the probe dates, and report what they leave the
 * window holding. Both terms-level verdicts below read this one measurement.
 *
 * The shape conditions, all necessary before anything is run:
 *
 * - `index` is the END of a maximal run of consecutive `substring` steps. A
 *   reading taken at a link INSIDE a run describes a window the run's later
 *   links can slice back out of range; the value a run leaves is the value its
 *   last link leaves.
 * - Some `parse_date` runs ahead of that run. The NEAREST one laid out the value
 *   the run reads; steps before it are unconstrained, since they can only change
 *   whether a value parses, never the layout a parsed date renders to.
 * - That `parse_date`'s input format can parse a date at all
 *   ({@link parseDateInputDropsEveryRecord}); one that cannot supplies no value
 *   to slice, and the drop is already the one {@link pipelineAlwaysDrops} names
 *   at the `parse_date` itself.
 *
 * A DROPPED probe does not defeat the reading. The probe dates are baked into
 * shipped public source, so requiring every one of them to survive would let a
 * single authored step naming one probe's rendered value -- a `null_if` on
 * "ACME-19710102" under an `ACME-YYYYMMDD` layout -- withdraw the verdict while
 * the pipeline still put every other date on one constant. The surviving probes
 * decide instead, and where NONE survives the reading turns on whether the run
 * is layout-determined ({@link LAYOUT_DETERMINED_FUNCTION_NAMES}): a run that
 * reads no content drops every date it will ever see, while one containing a
 * value-dependent step has told the measurement nothing, and the consent
 * direction there is the wider breadth word rather than the narrower one.
 *
 * A probe the measurement cannot READ -- one a step inflates past the per-value
 * ceiling, or expands into a candidate set -- and a step this build cannot
 * compile or run yield `cannotMeasure`, distinct from the determinate readings
 * above. Both resolve upward at the caller: the window's breadth is unknown, and
 * an inviter must not be able to buy a milder marker by making one probe
 * unmeasurable (a `replace_regex` that inflates a future-dated probe over the
 * ceiling, an unrecognized function name) while every real date still collapses
 * onto one constant.
 */
function readParsedDateRun(
  steps: ReadonlyArray<TransformStep>,
  index: number,
): ParsedDateRunReading {
  if (steps[index]?.function !== "substring") return UNDETERMINED;
  if (steps[index + 1]?.function === "substring") return UNDETERMINED;
  let runStart = index;
  while (runStart > 0 && steps[runStart - 1].function === "substring")
    runStart -= 1;
  let parseDateIndex = runStart - 1;
  while (parseDateIndex >= 0 && steps[parseDateIndex].function !== "parse_date")
    parseDateIndex -= 1;
  if (parseDateIndex < 0) return UNDETERMINED;
  const parseDateStep = steps[parseDateIndex];
  if (parseDateInputDropsEveryRecord(parseDateStep.params)) return UNDETERMINED;
  const rawOutputFormat = parseDateStep.params?.outputFormat;
  const outputFormat =
    typeof rawOutputFormat === "string"
      ? rawOutputFormat
      : DEFAULT_DATE_OUTPUT_FORMAT;
  const measuredSteps = steps.slice(parseDateIndex + 1, index + 1);
  try {
    // Only the steps up to the run's end are compiled here; the rest of the
    // pipeline is compiled by the caller that needs it, and only once a collapse
    // is established, so an element that collapses nowhere costs one pass over
    // each of its runs rather than one over its whole tail.
    const compiled = compileSteps([...measuredSteps]);
    const survivors = new Set<string>();
    for (const probe of DATE_COLLAPSE_PROBES) {
      const outcome = runCompiledSteps(
        renderDateOutput(outputFormat, probe.year, probe.month, probe.day),
        compiled,
      );
      // A probe the run cannot reduce to a value -- one inflated past the ceiling
      // or expanded into a candidate set -- leaves the window's breadth unknown,
      // so the reading resolves upward rather than falling to the milder word.
      if (outcome.kind === "unread" || outcome.kind === "candidates")
        return CANNOT_MEASURE;
      if (outcome.kind === "value") survivors.add(outcome.value);
      if (survivors.size > 1) return UNDETERMINED;
    }
    const [collapsed] = survivors;
    if (collapsed !== undefined) return { kind: "collapsed", value: collapsed };
    return measuredSteps.every((step) =>
      LAYOUT_DETERMINED_FUNCTION_NAMES.has(step.function),
    )
      ? { kind: "layoutDeterminedDrop" }
      : { kind: "valueDependentDrop" };
  } catch {
    // A step this build cannot compile or run gives no reading of what the window
    // holds. That is a can't-measure, not a determinate coarsening: the caller
    // resolves it up to the collapse word so an unrecognized function name cannot
    // buy the milder marker.
    return CANNOT_MEASURE;
  }
}

/**
 * Whether the `substring` at `index` of `steps` leaves every record that
 * survives an earlier `parse_date` holding the SAME constant -- the maximal
 * match breadth, not the truncation the step's name suggests. The motivating
 * shape is a window sliced wholly inside an output format's literal region
 * (`ACME-YYYYMMDD` read as `ACME`) or onto a bare separator, where the sliced
 * value holds no character the date supplied.
 *
 * MEASURED, not derived from the step names: the steps between the `parse_date`
 * and the run are compiled and RUN over {@link DATE_COLLAPSE_PROBES}, and the
 * verdict is that every probe still holding a value leaves the run on one
 * identical, non-empty one. Whether a step preserves what a window reads is a
 * property of the function AND of the window -- `remove_dashes` collapses a
 * four-character window of `ACME-YYYYMMDD` but not a five-character one -- so a
 * name allowlist of "layout-preserving" functions decides it wrongly in both
 * directions, and a layout-preservation table is a second reading of behavior
 * the factories already define. Running the shipped steps is the reading that
 * cannot drift from them, the same reason {@link coalesceSubstitutesConstant}
 * reads a step's params and position rather than its name. The one name set the
 * measurement does consult ({@link LAYOUT_DETERMINED_FUNCTION_NAMES}) answers a
 * different question -- whether a step can read the value's CONTENT at all --
 * and only to choose which way an undecided measurement falls.
 *
 * The conditions:
 *
 * - The run reads a layout some live `parse_date` ahead of it rendered, taken at
 *   the run's END -- the shape {@link readParsedDateRun} establishes and where
 *   the reasons for each of those live.
 * - Every probe that SURVIVES the run leaves it on one identical, non-empty
 *   value. A dropped probe does not withdraw the verdict: the probe dates ship
 *   in public source, so a single step naming one of their rendered values would
 *   otherwise buy the milder word for a pipeline that still puts every other
 *   date on the constant.
 * - Where no probe survives at all, the run is announced as a collapse unless it
 *   is layout-determined ({@link LAYOUT_DETERMINED_FUNCTION_NAMES}), in which
 *   case it drops every date and is the dead pipeline
 *   {@link substringRunDropsEveryParsedDate} names instead. A value-dependent
 *   step that drops all four probes has told the measurement nothing, and on a
 *   consent surface an undecided measurement takes the wider breadth word rather
 *   than the reassuring one.
 * - The collapsed value survives the REST of the pipeline. Every surviving
 *   record holds the same value by then, so what the remaining steps do to it is
 *   determinate with no probing at all: a later step that drops that one value
 *   drops every record still in hand, and an element matching nothing is not one
 *   matching every date. The all-probes-dropped case has no such value, so it
 *   takes the wider word without a tail reading.
 *
 * The measurement is bounded by the terms the schema already bounds: the steps
 * up to the run's end run once per probe and the rest of the pipeline once, on
 * values held to the same per-value ceiling the runtime enforces. A step it
 * cannot measure -- a function name this build does not recognize, a pattern that
 * fails to compile, or one that inflates a probe past that ceiling -- takes the
 * COLLAPSE word rather than the milder one: the window's breadth is unknown, and
 * understating it is the only harmful direction on a consent surface. That closes
 * the milder-word evasion -- an inviter cannot make one probe unmeasurable to
 * drop the marker while every real date still collapses onto one constant (a
 * probe inflated past the ceiling is driven in linkageSatisfiability.test.ts).
 * A legitimate partial-date transform does not cross the ceiling and is not an
 * unknown function, so it still measures cleanly and keeps its true milder
 * word; only a pathological or exchange-time-throwing pipeline takes the wider
 * one.
 *
 * The limit it keeps is a value-DEPENDENT drop the terms cannot determine, and
 * it runs in the over-claiming direction alone. A `filter_regex` or `null_if`
 * between the `parse_date` and the run is measured over the probes alone, so
 * one that passes them and drops a real record leaves the verdict standing;
 * one BEFORE the `parse_date` reads the acceptor's own values, which the terms
 * do not contain, so it is not measured at all; and one that drops every probe
 * hands the run the collapse word outright. Each can leave an element earning
 * "any date" while it in fact drops records it would have collapsed. Reading a
 * drop off such a step instead is the claim {@link pipelineAlwaysDrops}
 * declines for the same reason -- it would flag a legitimate pipeline as dead
 * -- so the residual is kept where it understates nothing.
 *
 * Shared so the consent header's collapse marker in `invitationSummary.ts` turns
 * on core's own steps rather than a restated reading of them.
 */
export function substringCollapsesParsedDateToConstant(
  steps: ReadonlyArray<TransformStep>,
  index: number,
): boolean {
  const reading = readParsedDateRun(steps, index);
  // A run whose breadth cannot be measured, and a value-dependent all-probes
  // drop, both resolve UP to the collapse word (see readParsedDateRun): the safe
  // direction on a consent surface.
  if (reading.kind === "cannotMeasure" || reading.kind === "valueDependentDrop")
    return true;
  if (reading.kind !== "collapsed") return false;
  try {
    const tail = runCompiledSteps(
      reading.value,
      compileSteps([...steps.slice(index + 1)]),
    );
    // Every surviving record holds `reading.value` by the run's end, so the tail
    // is determinate with no probing. Only a measured DROP withdraws the collapse
    // -- the element then matches nothing, which the dead-key advisory speaks for.
    // A tail that keeps a value or expands it to candidates keeps the collapse;
    // and a tail this build cannot measure (an over-ceiling value, an unknown
    // function) takes the collapse word too rather than the milder one, on the
    // same can't-measure-resolves-up rule the run itself follows.
    return tail.kind !== "dropped";
  } catch {
    return true;
  }
}

/**
 * Whether the `substring` run ending at `index` drops EVERY date an earlier
 * `parse_date` can render, whatever the acceptor's data -- the value-independent
 * certainty {@link pipelineAlwaysDrops} is built from, measured rather than
 * derived from the step names. The motivating shape is a run whose composed
 * window falls back out of range (`ACME-YYYYMMDD` sliced to `ACME`, then sliced
 * again from its fifth character), which reads nothing for any record while its
 * last link is still a `substring` a breadth marker would call a truncation.
 *
 * Claimed only where the measured steps are layout-determined
 * ({@link LAYOUT_DETERMINED_FUNCTION_NAMES}), so what the probes did is what
 * every date does. A run containing a value-dependent step that happens to drop
 * all four probes is NOT dead: the data decides it, which is the residual
 * {@link pipelineAlwaysDrops} declines to read from the terms.
 *
 * @internal exported so the rescue-equivalence sweep can model the same drop
 * source the shipped predicate reads.
 */
export function substringRunDropsEveryParsedDate(
  steps: ReadonlyArray<TransformStep>,
  index: number,
): boolean {
  return readParsedDateRun(steps, index).kind === "layoutDeterminedDrop";
}

/**
 * The transform params a CONSENT VERDICT reads, by function name: the values
 * that decide what the always-visible breadth marker says about an element,
 * rather than ones that only describe the step. A consent surface shows these
 * ahead of a step's other declared params, so neither the number of entries a
 * partner declares nor what it puts in them can displace the row a marker's
 * stated limits send the reader to.
 *
 * Each entry is the params some predicate here reads. `parse_date`'s two formats
 * decide {@link parseDateInputDropsEveryRecord} and the layout
 * {@link substringCollapsesParsedDateToConstant} measures; `substring`'s bounds
 * decide the window that measurement slices, and whether it opens at all
 * ({@link substringWindowDropsEveryValue}); `coalesce`'s `default` decides
 * {@link coalesceSubstitutesConstant}. These are the params whose value can push
 * the marker toward a MILDER word, so a partner must not be able to displace their
 * detail rows past the display cap.
 *
 * The collapse measurement also compiles and RUNS every step between the
 * `parse_date` and the substring run, so a `null_if`, `filter_regex`, or other
 * content step in that span participates in the reading -- its params (the values
 * a `null_if` drops on) change which probes survive. Those functions are still
 * absent here, by design: such a step can only move the reading toward the
 * BROADER word or leave a genuine coarsening, never toward an understatement. The
 * milder-versus-collapse boundary is whether the surviving probes are one value or
 * distinct, which is fixed by the LAYOUT the window reads -- the `parse_date`
 * formats and the `substring` bounds already listed -- and a content step run over
 * an already-identical set cannot manufacture distinct survivors from a collapse.
 * A drop it adds only widens the word (an all-probes drop is treated as
 * `valueDependentDrop`, "any date") or narrows real records the acceptor is not
 * harmed by not-seeing. So the ordering guarantee holds where it matters: no param
 * that could hide breadth is droppable. A function whose marker turns on its NAME
 * alone (`phonetic`, `replace_regex`, `pad_left`, and the rest) likewise has no
 * entry -- its name alone shows its marker.
 *
 * Held to those predicates by a test that moves each listed param and requires
 * the verdict to move with it, so a name listed here names a real verdict. What
 * that cannot see is the other direction -- a NEW param that could move the marker
 * toward the milder word arriving with no entry here -- which is a review call, as
 * the coercion table beside {@link describeTransformCoercions} has the same
 * shape of gap.
 */
export const CONSENT_VERDICT_PARAM_NAMES: Readonly<
  Record<string, ReadonlyArray<string>>
> = {
  parse_date: ["inputFormat", "outputFormat"],
  substring: ["start", "length"],
  coalesce: ["default"],
};

/**
 * Whether a transform/standardization pipeline produces NO value for every
 * possible input -- a self-defeating "dead" pipeline, determinable from the terms
 * alone without any data. Three value-INDEPENDENT drops are recognized: a
 * `parse_date` whose input format omits a required component
 * ({@link parseDateInputDropsEveryRecord}); a `substring` whose declared bounds
 * read no window out of a value of any length
 * ({@link substringWindowDropsEveryValue}), which needs no layout ahead of it
 * because the bounds settle it alone; and a `substring` run whose composed
 * window falls outside every layout an earlier live `parse_date` can render
 * ({@link substringRunDropsEveryParsedDate}), which is measured over probe dates
 * rather than composed arithmetically. A later `coalesce` with a string default
 * RESCUES a dropped value to that constant (see {@link applyStep}'s coalesce
 * branch), so a pipeline ending in such a coalesce is NOT dead -- it yields a
 * constant key, which the linkage layer treats as benign (a duplicated key
 * contributes no match but is no silent-empty hazard, the same reason the
 * coverage sweep does not flag a constant field). A coalesce BEFORE the drop, or
 * one with no string default, does not rescue.
 *
 * Steps whose drop behavior depends on the VALUE -- a `substring` whose window
 * overshoots the short values one input happens to hold and reads a real one
 * out of longer values, a `filter_regex` no value matches -- are NOT treated as
 * always-dropping, by design: that is the data-dependent residual the
 * satisfiability layer leaves to the runtime coverage sweep, and assuming it here
 * could wrongly flag a legitimate pipeline. Each claim above is held to that line:
 * a declared window is claimed only where NO value length opens it, and a run
 * measured over the probes only where every step in it reads the layout rather
 * than the content ({@link LAYOUT_DETERMINED_FUNCTION_NAMES}), so this still
 * reports a value-independent certainty alone and can never claim a producible
 * pipeline is dead.
 */
export function pipelineAlwaysDrops(
  steps: ReadonlyArray<TransformStep> | undefined,
): boolean {
  if (steps === undefined) return false;
  let dropped = false;
  for (const [index, step] of steps.entries()) {
    if (step.function === "coalesce") {
      // A string default substitutes a constant for a dropped value, rescuing it;
      // an undefined or non-string default leaves a dropped value dropped. The
      // shared predicate also tests a position half this loop's own reasoning does
      // not need; that it withholds no rescue here is held by the differential
      // sweep in linkageSatisfiability.test.ts ("pipelineAlwaysDrops rescue
      // equivalence") rather than asserted in this comment.
      if (dropped && coalesceSubstitutesConstant(step, steps.slice(0, index)))
        dropped = false;
      continue;
    }
    // A non-coalesce step null-propagates a dropped value, so once dropped the
    // pipeline stays dropped until a rescuing coalesce.
    if (dropped) continue;
    if (
      (step.function === "parse_date" &&
        parseDateInputDropsEveryRecord(step.params)) ||
      (step.function === "substring" &&
        substringWindowDropsEveryValue(step.params)) ||
      substringRunDropsEveryParsedDate(steps, index)
    )
      dropped = true;
  }
  return dropped;
}

/** How an input's columns fare against a set of linkage terms: which fields it
 * cannot produce, how many of the terms' linkage keys remain usable as a result,
 * and which otherwise-usable keys are self-defeating. A per-key coverage readout
 * for a surface that reports it; whether a run may proceed under these terms is
 * {@link LinkageTermsVerdict.fullySatisfied}, not a threshold read off
 * {@link satisfiableKeyCount}. */
interface LinkageSatisfiability {
  /** The linkage fields the columns cannot produce (see
   * {@link unsatisfiedLinkageFields}); empty when the input satisfies every field. */
  unsatisfied: LinkageField[];
  /** The number of linkage keys all of whose element fields are satisfiable.
   * This is the column-SHAPE verdict only -- it does not subtract
   * {@link deadKeys}, so it stays the count the differential test pins against the
   * builder's column resolution. */
  satisfiableKeyCount: number;
  /**
   * Keys the column-shape verdict PASSES (every element field resolves to a
   * present column) yet that still cannot match, because an element's declared
   * standardization can never produce a value regardless of the data -- a
   * self-defeating rule such as a `parse_date` whose input format omits a required
   * component (`input_format: "MM/DD"`, no year). Distinct from {@link unsatisfied},
   * which is about MISSING columns: here the columns are present but the rule is
   * dead, so the key would run to a silent empty result. Empty when no
   * shape-satisfiable key is self-defeating. Reported separately rather than
   * folded into {@link satisfiableKeyCount} so the count stays the column-shape
   * verdict and a surface can label the key with the right remedy (fix the terms,
   * not the CSV); the caller sanitizes the partner-controlled key names itself, as
   * it does for {@link unsatisfied}. Detection is value-independent only (see
   * {@link pipelineAlwaysDrops}): a data-dependent all-null collapse is left to
   * the runtime coverage sweep, not reported here. */
  deadKeys: LinkageKey[];
}

/**
 * Assess whether an input's `columns` can satisfy `terms`, for the surfaces that
 * report per-key coverage rather than decide whether a run may proceed. A key is
 * satisfiable only when EVERY element field is producible -- both declared in
 * `linkageFields` and resolvable from the columns -- since a single empty field
 * collapses the whole key for that record.
 *
 * This is a projection of {@link decideLinkageTermsVerdict}, which is where the
 * grading lives and which is what a run is held to: whether the terms may be run
 * at all is that verdict's `fullySatisfied`, not a threshold read off
 * {@link LinkageSatisfiability.satisfiableKeyCount} here. Callers own their own
 * message wording and display sanitization.
 *
 * `standardization` and `metadata` are the spec's explicit overrides, forwarded to
 * {@link unsatisfiedLinkageFields} so the verdict matches an exchange that runs
 * from them (the CLI `exchange` path passes both from its committed config; the
 * accept and web paths pass neither and rely on name inference).
 *
 * The satisfiability check is over column SHAPE, not row VALUES: a field whose
 * same-typed column exists but whose every row standardizes to empty (e.g. an
 * all-invalid date column) is reported satisfiable yet yields no key strings at
 * runtime. That residual is data-dependent and unavoidable from columns alone;
 * it can only over-claim "satisfiable", never wrongly block. The one exception is
 * value-INDEPENDENT: a key element whose declared standardization can never
 * produce a value (a self-defeating `parse_date` input format) is reported in
 * {@link LinkageSatisfiability.deadKeys}, derivable from the terms without data.
 * That is reported separately, not subtracted from {@link satisfiableKeyCount}:
 * the count stays the column-shape verdict, and a surface can label a dead key
 * with the right remedy (fix the terms, not the CSV).
 */
export function assessLinkageSatisfiability(
  columns: string[],
  terms: LinkageTerms,
  standardization?: Standardization,
  metadata?: ColumnMetadata[],
): LinkageSatisfiability {
  const verdict = decideLinkageTermsVerdict(
    columns,
    terms,
    standardization,
    metadata,
  );
  return {
    unsatisfied: verdict.unsatisfiedFields,
    satisfiableKeyCount: verdict.keys.length - verdict.unsatisfiableKeys.length,
    deadKeys: verdict.deadKeys,
  };
}

/**
 * How one declared linkage key fares against an input's columns:
 *
 * - `satisfiable` -- every element field resolves to a present column and no
 *   element declares cleaning that drops every record, so the key can produce key
 *   strings from this input.
 * - `unsatisfiable` -- at least one element field cannot be produced from the
 *   columns, so the key collapses to nothing for every record.
 * - `dead` -- every element field resolves, but an element's declared cleaning can
 *   never produce a value whatever the data (see {@link pipelineAlwaysDrops}), so
 *   the key passes the column check and still contributes nothing. Its remedy is a
 *   correction to the terms rather than a different input file, which is why it is
 *   graded apart from `unsatisfiable`.
 */
export type LinkageKeyFitness = "satisfiable" | "unsatisfiable" | "dead";

/** One declared linkage key beside the {@link LinkageKeyFitness} this input gives
 * it. */
interface GradedLinkageKey {
  /** The declared key, verbatim from the terms. */
  key: LinkageKey;
  /** How it fares against the input's columns. */
  fitness: LinkageKeyFitness;
}

/**
 * Whether an input may be run under a set of agreed linkage terms, and everything
 * a surface needs to say why not. This is the one home of that grading: a run is
 * refused unless the terms declare at least one linkage key and EVERY declared key
 * is `satisfiable`.
 *
 * All three failing shapes are the same fault -- the run would contribute nothing
 * for a key both parties agreed to match on -- so they are one rule rather than a
 * block beside a warning. Terms declaring no key are included because a derivation
 * can produce them: `linkageTermsFromRuleSet` narrows the built-in set to the keys
 * the columns support and narrows all the way to none, which a per-key threshold
 * would pass vacuously.
 */
export interface LinkageTermsVerdict {
  /** Whether the input may be run under these terms: at least one key declared,
   * and every declared key `satisfiable`. */
  fullySatisfied: boolean;
  /** Every declared key with its grade, in declaration order. Empty when the terms
   * declare no key. */
  keys: GradedLinkageKey[];
  /** The declared keys graded `unsatisfiable`, in declaration order. */
  unsatisfiableKeys: LinkageKey[];
  /** The declared keys graded `dead`, in declaration order. */
  deadKeys: LinkageKey[];
  /** The linkage fields the columns cannot produce (see
   * {@link unsatisfiedLinkageFields}). Empty when the input satisfies every
   * declared field -- including when keys are still unsatisfiable, which happens
   * when a key element references a field the terms never declare. */
  unsatisfiedFields: LinkageField[];
}

/**
 * Grade an input's `columns` against the linkage `terms` an exchange has agreed
 * to, and decide whether it may run under them. The fail-closed gate in
 * {@link prepareForExchange} enforces this verdict, and every front end that
 * checks earlier gives advance notice of the same decision rather than holding a
 * threshold of its own.
 *
 * `standardization` and `metadata` are the spec's explicit overrides, forwarded to
 * {@link unsatisfiedLinkageFields} so the grade matches an exchange that runs from
 * them. Pass the AUTHORED pair (both `undefined` where nothing is authored), which
 * is what a run resolves its own defaults from, so the advance notice and the gate
 * grade identical inputs.
 *
 * The grade is over column SHAPE, not row VALUES, with the one value-independent
 * exception `dead` covers; see {@link assessLinkageSatisfiability} for that
 * residual and why it can only over-accept, never wrongly refuse.
 */
export function decideLinkageTermsVerdict(
  columns: string[],
  terms: LinkageTerms,
  standardization?: Standardization,
  metadata?: ColumnMetadata[],
): LinkageTermsVerdict {
  const unsatisfiedFields = unsatisfiedLinkageFields(
    columns,
    terms,
    standardization,
    metadata,
  );
  const unsatisfiedNames = new Set(unsatisfiedFields.map((f) => f.name));
  // The set of field names that are BOTH declared and producible. A key element
  // referencing a name absent from this set is unsatisfiable -- whether the field
  // is declared-but-unproducible (in `unsatisfiedFields`) or not declared at all.
  // The latter is rejected upstream by LinkageTermsSchema's referential-integrity
  // refine (a key element `field` must name a declared linkage field), so a
  // schema-validated terms set cannot reach here with an undeclared reference;
  // this filter is kept as defense-in-depth for any terms not built through that
  // schema, since at exchange time an undeclared reference resolves to no values
  // (buildStandardizedDataset only builds declared fields, so getField returns
  // undefined and the key collapses to null) and grading such a key satisfiable
  // would let an incoherent terms set defeat the refusal this grading exists to
  // raise.
  const producibleNames = new Set(
    terms.linkageFields
      .map((f) => f.name)
      .filter((name) => !unsatisfiedNames.has(name)),
  );
  // The dead scan walks a key's element transform steps; each maximal substring
  // run re-measures a growing prefix per DATE_COLLAPSE_PROBES probe, so the
  // cost is QUADRATIC in an element's step count, not linear. Needs no separate
  // budget: both bounds it depends on are capped (an element's transform at
  // MAX_TRANSFORM_STEPS, the whole partner-supplied token at
  // MAX_ENCODED_INVITATION_LENGTH), and the operator's own committed-config
  // path already drives heavier per-row compile and RE2 work at exchange time,
  // so this scan is never the dominant cost.
  // parseDateInputDropsEveryRecord never calls parseDateFormat on a non-string, so
  // a hostile param shape cannot make it throw, and the measured run catches
  // whatever its own compile or run raises.
  const keys: GradedLinkageKey[] = terms.linkageKeys.map((key) => ({
    key,
    fitness: !key.elements.every((e) => producibleNames.has(e.field))
      ? "unsatisfiable"
      : key.elements.some((e) => pipelineAlwaysDrops(e.transform))
        ? "dead"
        : "satisfiable",
  }));
  const withFitness = (fitness: LinkageKeyFitness): LinkageKey[] =>
    keys.filter((graded) => graded.fitness === fitness).map((g) => g.key);
  const unsatisfiableKeys = withFitness("unsatisfiable");
  const deadKeys = withFitness("dead");
  return {
    fullySatisfied:
      keys.length > 0 &&
      unsatisfiableKeys.length === 0 &&
      deadKeys.length === 0,
    keys,
    unsatisfiableKeys,
    deadKeys,
    unsatisfiedFields,
  };
}

/**
 * Where the terms a shortfall is stated against stand between the two parties, so
 * the shared fragment fits the seat that renders it:
 *
 * - `"agreed"` -- both parties are held to these terms: an acceptor's adopted
 *   invitation, or a configuration an established exchange runs under. The keys
 *   are named as agreed, because narrowing them is an out-of-band step rather
 *   than an edit this operator can make.
 * - `"draft"` -- the operator's own terms, which no partner holds yet: the
 *   pre-invitation mint seats, where there is nobody to have agreed anything and
 *   the keys are the operator's own to change.
 */
export type LinkageTermsStanding = "agreed" | "draft";

/**
 * State, in one sentence fragment, how a verdict falls short of its terms: which
 * of the declared linkage keys the input's columns cannot produce, and which of
 * them declare cleaning that drops every record.
 *
 * Every surface that refuses on {@link decideLinkageTermsVerdict} phrases the
 * shortfall through this, so the run-boundary refusal and the pre-flight notice
 * ahead of it cannot describe the same fault in different words. Each clause
 * counts against the whole declared set rather than the other clause's remainder,
 * so a refusal holding one clause reads as well as one holding both.
 *
 * `standing` is the one thing the fragment takes from its seat: it is required
 * rather than defaulted so a new caller states where its terms stand instead of
 * inheriting a partnership it may not have (see {@link LinkageTermsStanding}).
 *
 * The fragment is fixed copy and counts only. Names are terms content --
 * partner-authored on every accept path -- and each caller places them on cause
 * links of its own.
 *
 * Terms declaring no key are not its case and yield nothing: that refusal names
 * the absent declaration itself, in copy each caller owns.
 */
export function summarizeLinkageShortfall(
  verdict: LinkageTermsVerdict,
  standing: LinkageTermsStanding,
): string {
  const total = verdict.keys.length;
  const qualifier = standing === "agreed" ? "agreed " : "";
  const keysPhrase = (count: number): string =>
    total === 1
      ? `the one ${qualifier}linkage key`
      : count === total
        ? `all ${total} ${qualifier}linkage keys`
        : `${count} of the ${total} ${qualifier}linkage keys`;
  const shortfalls: string[] = [];
  if (verdict.unsatisfiableKeys.length > 0)
    shortfalls.push(
      `${keysPhrase(verdict.unsatisfiableKeys.length)} cannot be produced ` +
        "from this input's columns",
    );
  if (verdict.deadKeys.length > 0)
    shortfalls.push(
      `the cleaning declared for ${keysPhrase(verdict.deadKeys.length)} ` +
        "drops every record",
    );
  return shortfalls.join(", and ");
}

/**
 * Fail closed, before any credential, terms, or data are sent, on an input that
 * cannot fully satisfy the agreed linkage terms -- the run-boundary enforcement of
 * {@link decideLinkageTermsVerdict}, called from {@link prepareForExchange}.
 *
 * Terms declaring no linkage key at all are refused here too: the run would
 * have nothing to match on and would produce a result indistinguishable from an
 * empty intersection, so it is refused before any credential, terms, or data
 * are sent.
 *
 * The terms name the keys both parties consented to match on. A run that
 * contributes nothing for one of them matches on fewer keys than were agreed while
 * its exchange record still names every field the terms declare, so the shortfall
 * is settled with the partner out of band rather than run anyway. The remedy is
 * therefore stated as new terms or a conforming input, never as a retry: the same
 * input refuses identically every time.
 *
 * The summary is stated on the `"agreed"` standing: this is the boundary of a run,
 * and a run is held to the terms its partner is held to, whoever authored them.
 * The seats that hold terms no partner has yet state the same shortfall in their
 * own first-party copy, ahead of this.
 *
 * The summary holds only fixed copy and counts. The field and key names are
 * terms content -- partner-authored on every accept path -- so each category rides
 * a labelled cause link of its own, raw: the display boundary that renders the
 * chain caps each link independently and is the one altitude that escapes them, so
 * a name can only ever spend the budget of the link it shares with its own kind,
 * and the count leads each link so a truncated one still reports how much is
 * unread. Each name is also redacted ({@link redactPrivateKeyMaterial}) where it
 * is composed into its link, so a marker planted in one name cannot take the
 * names enumerated after it.
 */
export function assertLinkageTermsSatisfiable(
  columns: string[],
  terms: LinkageTerms,
  standardization?: Standardization,
  metadata?: ColumnMetadata[],
): void {
  const verdict = decideLinkageTermsVerdict(
    columns,
    terms,
    standardization,
    metadata,
  );
  if (verdict.fullySatisfied) return;

  if (verdict.keys.length === 0)
    throw new LinkageTermsUnsatisfiableError(
      "the agreed linkage terms declare no linkage key, so this exchange has " +
        "nothing to match on and is refused before any credential, terms, or " +
        "data are sent. Run it with an input whose columns can supply at " +
        "least one linkage key, or agree terms declaring one with your " +
        "partner and run the exchange under those.",
    );

  // Every name below is agreed-terms content -- partner-authored on every
  // accept path -- redacted where it is composed into its link so a planted
  // marker's fail-closed reach stays inside that name's own run rather than
  // taking the names behind it with it (see redactPrivateKeyMaterial).
  const details: string[] = [];
  if (verdict.unsatisfiedFields.length > 0)
    details.push(
      `unsatisfied linkage fields (${verdict.unsatisfiedFields.length}): ` +
        verdict.unsatisfiedFields
          .map(
            (field) =>
              `${redactPrivateKeyMaterial(field.name)} (${field.type})`,
          )
          .join(", "),
    );
  if (verdict.deadKeys.length > 0)
    details.push(
      `linkage keys whose cleaning drops every record ` +
        `(${verdict.deadKeys.length}): ` +
        verdict.deadKeys
          .map((key) => redactPrivateKeyMaterial(key.name))
          .join(", "),
    );
  if (verdict.unsatisfiableKeys.length > 0)
    details.push(
      `linkage keys this input cannot produce ` +
        `(${verdict.unsatisfiableKeys.length}): ` +
        verdict.unsatisfiableKeys
          .map((key) => redactPrivateKeyMaterial(key.name))
          .join(", "),
    );

  throw new LinkageTermsUnsatisfiableError(
    `this input cannot satisfy every linkage key the agreed terms declare: ` +
      `${summarizeLinkageShortfall(verdict, "agreed")}. The exchange is ` +
      "refused before any credential, terms, or data are sent: it would match " +
      "on fewer keys than both parties agreed to while its exchange record " +
      "still names every field those terms declare. Settle the shortfall with " +
      "your partner out of band -- agree terms over the keys and fields both " +
      "files can supply, and run the exchange under those -- or run it with " +
      "an input file that satisfies the terms already agreed.",
    details.length > 0
      ? { cause: chainDetailCauses(details as [string, ...string[]]) }
      : undefined,
  );
}
