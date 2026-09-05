import { describe, expect, test } from "vitest";

import {
  APPLIED_SETTINGS,
  CanonicalEncodingError,
  DEDUPLICATE_IMPLEMENTED_BY_STRATEGY,
  FAN_OUT_FUNCTION_NAMES,
  MAX_INVITATION_LIFETIME_SECONDS,
  authoredLinkageFields,
  canonicalString,
  pipelineAlwaysDrops,
  safeParseLinkageTerms,
} from "@psilink/core";

import {
  draftFromTerms,
  draftWithFieldAdded,
  seedAdvancedInvite,
} from "../../src/psi/advancedInviteDraft.js";
import {
  gatedActiveSettingMessage,
  inertCoalesceNotice,
  validateAdvancedInvite,
} from "../../src/psi/advancedInviteValidation.js";
import { SEMANTIC_TYPE_LABELS } from "../../src/psi/metadataEditing.js";
import { buildAdvancedTerms } from "../../src/psi/advancedInviteTerms.js";
import { isStepValid } from "../../src/psi/standardizationAuthoring.js";

import type {
  LinkageStrategy,
  StandardizationStep,
  TransformStep,
} from "@psilink/core";

import type { AdvancedInviteDraft } from "../../src/psi/advancedInviteTypes.js";

const ALL_COLUMNS = ["ssn", "ssn4", "first_name", "last_name", "dob"];

/** `draft` with `transform` on the first element of its first key, enabled. */
function withFirstElementTransform(
  draft: AdvancedInviteDraft,
  transform: Array<TransformStep>,
): AdvancedInviteDraft {
  return {
    ...draft,
    keys: draft.keys.map((entry, index) =>
      index === 0
        ? {
            ...entry,
            enabled: true,
            key: {
              ...entry.key,
              elements: entry.key.elements.map((element, position) =>
                position === 0 ? { ...element, transform } : element,
              ),
            },
          }
        : entry,
    ),
  };
}

describe("the fan-out gate (the run refuses what the schema admits)", () => {
  // Core refuses an exchange whose standardization or linkage-key transforms
  // declare a fan-out step, so an invitation holding one is refused at its own
  // run. These pin the refusal at the moment of authoring instead: the operator
  // learns the capability is missing before minting, not after the partner has
  // the token. The declaring function is read from core's list, so a fan-out
  // function added there is gated without a web edit.
  const [fanOutFunction] = FAN_OUT_FUNCTION_NAMES;
  const fanOutStep = {
    function: fanOutFunction,
    params: { delimiter: "-" },
  };
  const now = new Date("2026-01-01T00:00:00Z");

  test("blocks Generate on an authored cleaning step that fans out", () => {
    const { draft, seed } = seedAdvancedInvite("Org", ALL_COLUMNS);
    expect(validateAdvancedInvite(draft, seed, now).canGenerate).toBe(true);
    const fanning = {
      ...draft,
      standardization: draft.standardization.map((transformation, i) =>
        i === 0
          ? {
              ...transformation,
              steps: [...(transformation.steps ?? []), fanOutStep],
            }
          : transformation,
      ),
    };
    const result = validateAdvancedInvite(fanning, seed, now);
    expect(result.canGenerate).toBe(false);
    expect(result.terms).toBeUndefined();
    // The message names the surface that does author a fan-out rather than
    // reporting a schema fault -- the step is well-formed, and this editor is
    // what does not author it.
    expect(result.errors.standardization).toMatch(
      /this editor does not author/,
    );
    expect(result.errors.standardization).toMatch(/several values/);
  });

  test("blocks Generate on a linkage-key element transform that fans out", () => {
    const { draft, seed } = seedAdvancedInvite("Org", ALL_COLUMNS);
    const fanning = {
      ...draft,
      keys: draft.keys.map((entry, i) =>
        i === 0
          ? {
              ...entry,
              enabled: true,
              key: {
                ...entry.key,
                elements: entry.key.elements.map((element, j) =>
                  j === 0 ? { ...element, transform: [fanOutStep] } : element,
                ),
              },
            }
          : entry,
      ),
    };
    const result = validateAdvancedInvite(fanning, seed, now);
    expect(result.canGenerate).toBe(false);
    expect(result.errors.keys).toMatch(/this editor does not author/);
  });

  test("a disabled key's fan-out transform does not block Generate", () => {
    // A disabled key is dropped from the built terms, so it declares nothing the
    // run would refuse; blocking on it would refuse an exchange that is fine.
    const { draft, seed } = seedAdvancedInvite("Org", ALL_COLUMNS);
    const parked = {
      ...draft,
      keys: draft.keys.map((entry, i) =>
        i === draft.keys.length - 1
          ? {
              ...entry,
              enabled: false,
              key: {
                ...entry.key,
                elements: entry.key.elements.map((element, j) =>
                  j === 0 ? { ...element, transform: [fanOutStep] } : element,
                ),
              },
            }
          : entry,
      ),
    };
    const result = validateAdvancedInvite(parked, seed, now);
    expect(result.errors.keys).toBeUndefined();
    expect(result.canGenerate).toBe(true);
  });
});

describe("the deduplicating-pair gate (the run refuses what the schema admits)", () => {
  // Core refuses a `deduplicate: true` term under a strategy that cannot run one,
  // on both parties before matching begins, so terms authored on that pair are
  // ones both sides abort on. The gate reads core's own verdict rather than
  // restating the pair, and every strategy this build offers can run one -- so
  // these pin both halves: the pairs the run does honor generate here, and the
  // refusal fires with its own message where the verdict says it cannot.
  const now = new Date("2026-01-01T00:00:00Z");

  // The gate is what a strategy declaring it cannot match a group is stopped at,
  // and no shipped strategy declares that -- so the verdict is driven to `false`
  // here, over the same table core drives its own refusal from, rather than left
  // as a branch nothing reaches. Synchronous throughout, so no other test observes
  // the flipped table.
  function withDeduplicateUnimplemented<T>(
    strategy: LinkageStrategy,
    read: () => T,
  ): T {
    const shipped = DEDUPLICATE_IMPLEMENTED_BY_STRATEGY[strategy];
    DEDUPLICATE_IMPLEMENTED_BY_STRATEGY[strategy] = false;
    try {
      return read();
    } finally {
      DEDUPLICATE_IMPLEMENTED_BY_STRATEGY[strategy] = shipped;
    }
  }

  test.each(["cascade", "single-pass"] as const)(
    "a deduplicating draft under %s generates",
    (linkageStrategy) => {
      const { draft, seed } = seedAdvancedInvite("Org", ALL_COLUMNS);
      const result = validateAdvancedInvite(
        { ...draft, deduplicate: true, linkageStrategy },
        seed,
        now,
      );
      expect(result.errors).toEqual({});
      expect(result.canGenerate).toBe(true);
      expect(result.terms?.deduplicate).toBe(true);
      expect(result.terms?.linkageStrategy).toBe(linkageStrategy);
    },
  );

  test("a single-pass draft that does not deduplicate generates", () => {
    const { draft, seed } = seedAdvancedInvite("Org", ALL_COLUMNS);
    const result = validateAdvancedInvite(
      { ...draft, deduplicate: false, linkageStrategy: "single-pass" },
      seed,
      now,
    );
    expect(result.errors).toEqual({});
    expect(result.canGenerate).toBe(true);
  });

  test.each(["cascade", "single-pass"] as const)(
    "blocks Generate where %s declares no deduplicating match",
    (linkageStrategy) => {
      const { draft, seed } = seedAdvancedInvite("Org", ALL_COLUMNS);
      const deduplicating = { ...draft, deduplicate: true, linkageStrategy };
      const refused = withDeduplicateUnimplemented(linkageStrategy, () =>
        validateAdvancedInvite(deduplicating, seed, now),
      );
      expect(refused.canGenerate).toBe(false);
      expect(refused.terms).toBeUndefined();
      // Against the key list, in this editor's own words, naming the two controls
      // that decide it and no strategy -- which one cannot run a deduplicating
      // match is core's verdict rather than this message's.
      expect(refused.errors.keys).toMatch(/cannot run a deduplicating/);
      expect(refused.errors.keys).toMatch(/Choose another Linkage strategy/);
      expect(refused.errors.keys).toMatch(/Allow several of your records/);
      expect(refused.errors.keys).not.toMatch(new RegExp(linkageStrategy));
      // A draft that does not ask for the match is untouched by the verdict.
      expect(
        withDeduplicateUnimplemented(
          linkageStrategy,
          () =>
            validateAdvancedInvite(
              { ...deduplicating, deduplicate: false },
              seed,
              now,
            ).canGenerate,
        ),
      ).toBe(true);
      // Restored, so the pair the shipped table admits generates again.
      expect(validateAdvancedInvite(deduplicating, seed, now).canGenerate).toBe(
        true,
      );
    },
  );
});

describe("the strategy gate on a deduplicating term", () => {
  // Acceptance derives the accepting party's own deduplicate as false rather than
  // adopting the inviting party's, so a deduplicating invitation reaches the run
  // as the one-sided pair both strategies match. What stays refused is the pair
  // no strategy matches, and this editor refuses it where the operator still
  // holds both controls.
  const now = new Date("2026-01-01T00:00:00Z");

  test("a deduplicating draft generates, the exchange applying the setting", () => {
    const { draft, seed } = seedAdvancedInvite("Org", ALL_COLUMNS);
    const result = validateAdvancedInvite(
      { ...draft, deduplicate: true, linkageStrategy: "cascade" },
      seed,
      now,
    );
    expect(result.errors).toEqual({});
    expect(result.canGenerate).toBe(true);
    // The setting reaches the built terms rather than being clamped away: the
    // exchange applies it, which is the one question this control is gated on.
    expect(APPLIED_SETTINGS.deduplicate).toBe(true);
    expect(result.terms?.deduplicate).toBe(true);
  });

  test("an import that turns the setting on is not refused", () => {
    // The import door is closed against a setting the RUN does not apply, and
    // this one it does, so the document loads rather than being turned away.
    const { draft } = seedAdvancedInvite("Org", ALL_COLUMNS);
    const terms = buildAdvancedTerms({ ...draft, deduplicate: true });
    expect(terms.deduplicate).toBe(true);
    expect(gatedActiveSettingMessage(terms)).toBeUndefined();
  });

  test("a draft that deduplicates without receiving results names that obstacle on the output control", () => {
    // The schema's deduplicate-requires-output refine reports against the output
    // pair, which without its own mapping collapses to the key list and displays
    // as "Enable at least one linkage key."
    const { draft, seed } = seedAdvancedInvite("Org", ALL_COLUMNS);
    const result = validateAdvancedInvite(
      { ...draft, deduplicate: true, outputDirection: "partner" },
      seed,
      now,
    );
    expect(result.canGenerate).toBe(false);
    expect(result.errors.output).toMatch(/needs you to receive the matched/);
    expect(result.errors.output).toMatch(/Who receives the matched results/);
    // Both halves determine it, and both are live controls, so both are named.
    expect(result.errors.output).toMatch(/Allow several of your records/);
    // Against the output pair alone: the key list is not where this reports.
    expect(result.errors.keys).toBeUndefined();
  });
});

describe("the canonical-encode gate (the byte form both parties hash)", () => {
  // The terms are hashed into the cross-party agreement in their canonical form,
  // so a value outside that domain has to be refused at authoring rather than at
  // the exchange. What these pin is which message the refusal has: the gate
  // predates them and already blocked, but it named nothing and offered only
  // "reset to defaults" -- discarding the operator's whole draft over one value.
  const now = new Date("2026-01-01T00:00:00Z");

  test("names the transform for a param the element editor itself can author", () => {
    // The element editor offers `substring`, and its NumberInput writes an
    // out-of-range value into the draft beside the inline error rather than
    // withholding it -- so this is the operator's own controls, not an import.
    const { draft, seed } = seedAdvancedInvite("Org", ALL_COLUMNS);
    const authored = withFirstElementTransform(draft, [
      { function: "substring", params: { start: 2 ** 53, length: 4 } },
    ]);
    // The assumptions: the terms schema admits the value (a transform param is
    // `z.unknown()` there), and the encoder is what refuses it -- so the message
    // below is this gate's answer rather than one the schema would have given.
    const terms = buildAdvancedTerms(authored);
    expect(safeParseLinkageTerms(terms).success).toBe(true);
    expect(() => canonicalString(terms)).toThrow(CanonicalEncodingError);

    const result = validateAdvancedInvite(authored, seed, now);
    expect(result.canGenerate).toBe(false);
    expect(result.terms).toBeUndefined();
    expect(result.errors.keys).toMatch(/transform has a parameter/);
    expect(result.errors.keys).toMatch(/correct that transform's parameters/);
    // The remedy it must not be: discarding everything the operator authored.
    expect(result.errors.keys).not.toMatch(/reset to defaults/);
  });

  test("names the transform for a non-finite param the schema does reject", () => {
    // A non-finite param IS a schema issue, but on the linkageKeys path, which the
    // generic mapping collapses to "Enable at least one linkage key." -- wrong on a
    // draft whose keys are all enabled. The gate runs ahead of that mapping so the
    // accurate message is the one that survives.
    const { draft, seed } = seedAdvancedInvite("Org", ALL_COLUMNS);
    const infinite = withFirstElementTransform(draft, [
      { function: "substring", params: { start: Number.POSITIVE_INFINITY } },
    ]);
    expect(safeParseLinkageTerms(buildAdvancedTerms(infinite)).success).toBe(
      false,
    );
    const result = validateAdvancedInvite(infinite, seed, now);
    expect(result.canGenerate).toBe(false);
    expect(result.errors.keys).toMatch(/transform has a parameter/);
    expect(result.errors.keys).not.toMatch(/Enable at least one linkage key/);
  });

  test("a disabled key's un-encodable transform does not block Generate", () => {
    // A disabled key is dropped from the built terms, so it is encoded by nothing
    // and blocks nothing -- the same rule the fan-out gate keeps.
    const { draft, seed } = seedAdvancedInvite("Org", ALL_COLUMNS);
    const parked = {
      ...draft,
      keys: draft.keys.map((entry, index) =>
        index === draft.keys.length - 1
          ? {
              ...entry,
              enabled: false,
              key: {
                ...entry.key,
                elements: entry.key.elements.map((element, position) =>
                  position === 0
                    ? {
                        ...element,
                        transform: [
                          { function: "substring", params: { start: 2 ** 53 } },
                        ],
                      }
                    : element,
                ),
              },
            }
          : entry,
      ),
    };
    const result = validateAdvancedInvite(parked, seed, now);
    expect(result.errors.keys).toBeUndefined();
    expect(result.canGenerate).toBe(true);
  });

  test("an un-encodable value outside every transform names a remedy of its own", () => {
    // The residual: a draft whose enabled keys state an optional property as an
    // explicit `undefined` -- the shape a spread rebuild produces, which the
    // rule-set compares prune (linkageComparison) and the canonical encoding
    // rejects. No control in this editor writes it (each clears an optional with
    // `delete`) and a parsed document cannot hold it, so it takes the message for
    // a fault this editor cannot locate rather than the transform one.
    const { draft, seed } = seedAdvancedInvite("Org", ALL_COLUMNS);
    const spread: AdvancedInviteDraft = {
      ...draft,
      keys: draft.keys.map((entry) => ({
        ...entry,
        key: {
          ...entry.key,
          swap: entry.key.swap,
          elements: entry.key.elements.map((element) => ({
            ...element,
            transform: element.transform,
          })),
        },
      })),
    };
    // The assumption: these keys really are outside the canonical domain, so the
    // refusal below is this shape's and not something else in the draft.
    const terms = buildAdvancedTerms(spread);
    expect(() => canonicalString(terms)).toThrow(CanonicalEncodingError);

    const result = validateAdvancedInvite(spread, seed, now);
    expect(result.canGenerate).toBe(false);
    expect(result.errors.keys).toMatch(/cannot be recorded in the exact form/);
    expect(result.errors.keys).toMatch(
      /rebuild the key list from your columns/,
    );
    expect(result.errors.keys).not.toMatch(/reset to defaults/);
  });

  test("the gate consults no descriptor for a key-element transform param", () => {
    // The gate is the encoder's, not the authoring descriptors': a param value
    // core tolerates at runtime (a `coalesce` default that is not text runs as a
    // pass-through) encodes, so it keeps generating and is left to the notice
    // that names it. A descriptor-shaped gate would refuse it instead.
    const step = { function: "coalesce", params: { default: 7 } };
    // The assumption: the descriptors DO judge and reject this param, so what the
    // case measures is that the gate does not ask them -- not that there is
    // nothing here for them to say.
    expect(isStepValid(step)).toBe(false);
    const { draft, seed } = seedAdvancedInvite("Org", ALL_COLUMNS);
    const tolerated = withFirstElementTransform(draft, [step]);
    expect(validateAdvancedInvite(tolerated, seed, now).canGenerate).toBe(true);
  });
});

describe("the swap pair whose two elements clean differently", () => {
  // A swap has only the receiver read the pair in the other order and leaves each
  // element's steps on its own position, so a pair whose steps differ cleans a
  // column one way on the party that swaps and another on the party that does
  // not. The terms refuse it; the editor can author it, so it needs a message
  // that names it rather than the generic "Enable at least one linkage key."

  const now = new Date("2026-01-01T00:00:00Z");

  /** `draft` with a swap over its first key's first two elements, enabled. */
  function withSwappedFirstPair(
    draft: AdvancedInviteDraft,
    transforms: Array<Array<TransformStep> | undefined>,
  ): AdvancedInviteDraft {
    return {
      ...draft,
      keys: draft.keys.map((entry, index) =>
        index === 0
          ? {
              ...entry,
              enabled: true,
              key: {
                ...entry.key,
                // An absent transform is written by OMITTING the property, the
                // way the editor's controls clear an optional; an explicit
                // `undefined` is outside the canonical domain and would be
                // refused by the encode gate before this rule is reached.
                elements: entry.key.elements.map((element, position) => {
                  const transform = transforms[position];
                  if (position >= 2) return element;
                  return transform === undefined
                    ? element
                    : { ...element, transform };
                }),
                swap: [
                  entry.key.elements[0].name ?? entry.key.elements[0].field,
                  entry.key.elements[1].name ?? entry.key.elements[1].field,
                ] as [string, string],
              },
            }
          : entry,
      ),
    };
  }

  const trim: Array<TransformStep> = [{ function: "trim_whitespace" }];

  test("differing steps on the pair are named rather than reported as no keys", () => {
    const { draft, seed } = seedAdvancedInvite("Org", ALL_COLUMNS);
    const mismatched = withSwappedFirstPair(draft, [trim, undefined]);
    // The assumption: the terms really are refused, so the message below answers
    // this rule and not another obstacle in the draft.
    expect(safeParseLinkageTerms(buildAdvancedTerms(mismatched)).success).toBe(
      false,
    );

    const result = validateAdvancedInvite(mismatched, seed, now);
    expect(result.canGenerate).toBe(false);
    expect(result.errors.keys).toMatch(/different cleaning steps/);
    expect(result.errors.keys).not.toMatch(/Enable at least one linkage key/);
  });

  test("the same steps on both positions of the pair generate", () => {
    const { draft, seed } = seedAdvancedInvite("Org", ALL_COLUMNS);
    const matched = withSwappedFirstPair(draft, [trim, [...trim]]);
    const result = validateAdvancedInvite(matched, seed, now);
    expect(result.errors.keys).toBeUndefined();
    expect(result.canGenerate).toBe(true);
  });
});

describe("the dead-key gate on a key-element transform that matches nothing", () => {
  // The gate one describe up -- the encoder, not the descriptors -- covers a
  // param core tolerates at runtime, not one the pipeline drops regardless of
  // the value: a `substring` whose window reads nothing at any length nulls
  // every row for both parties, so the key matches nothing while the
  // invitation mints green. Core grades such an element dead
  // (`pipelineAlwaysDrops`), pinned here at both doors -- authoring and import.
  const now = new Date("2026-01-01T00:00:00Z");

  /** The declared windows the factory reads nothing out of, by how an operator
   * reaches each: the element editor drops a cleared NumberInput's key rather
   * than writing an empty string, so an unfilled bound is simply absent. */
  const DEGENERATE_WINDOWS: ReadonlyArray<
    [string, Record<string, unknown> | undefined]
  > = [
    ["a step added and left unfilled", undefined],
    ["a cleared start", { length: 4 }],
    ["a cleared length", { start: 2 }],
    ["a start of 0", { start: 0, length: 4 }],
    ["a length of 0", { start: 2, length: 0 }],
  ];

  const substringStep = (
    params: Record<string, unknown> | undefined,
  ): TransformStep => ({
    function: "substring",
    ...(params !== undefined && { params }),
  });

  test("blocks Generate on an authored element whose window reads nothing", () => {
    for (const [label, params] of DEGENERATE_WINDOWS) {
      const { draft, seed } = seedAdvancedInvite("Org", ALL_COLUMNS);
      // The assumption the refusal has to be measured against: this draft
      // generates before the step is added.
      expect([
        label,
        validateAdvancedInvite(draft, seed, now).canGenerate,
      ]).toEqual([label, true]);
      const authored = withFirstElementTransform(draft, [
        substringStep(params),
      ]);
      const terms = buildAdvancedTerms(authored);
      // And the assumptions that make this the dead-key grading's refusal rather
      // than another gate's: the terms schema admits the step, and the value
      // encodes, so neither the schema mapping nor the canonical-encode gate is
      // what closes Generate below.
      expect([label, safeParseLinkageTerms(terms).success]).toEqual([
        label,
        true,
      ]);
      expect(() => canonicalString(terms), label).not.toThrow();

      const result = validateAdvancedInvite(authored, seed, now);
      expect([label, result.canGenerate]).toEqual([label, false]);
      expect([label, result.terms]).toEqual([label, undefined]);
      // The dead-key half of the shortfall, whose remedy sends the operator to
      // the key list rather than to their own columns or a discarded draft.
      expect(result.errors.keys, label).toMatch(/drops every record/);
      expect(result.errors.keys, label).toMatch(/badged "won't match"/);
      expect(result.errors.keys, label).not.toMatch(
        /cannot be produced from this input's columns/,
      );
      expect(result.errors.keys, label).not.toMatch(/reset to defaults/);
    }
  });

  test("an imported document with the same window reaches the same verdict", () => {
    for (const [label, params] of DEGENERATE_WINDOWS) {
      const { draft, seed } = seedAdvancedInvite("Org", ALL_COLUMNS);
      const document = buildAdvancedTerms(
        withFirstElementTransform(draft, [substringStep(params)]),
      );
      // Arrive by the import door rather than the editing one: serialize and
      // re-parse the document, then rebuild the draft from it, so the step is
      // one the operator never authored here.
      const parsed = safeParseLinkageTerms(
        JSON.parse(JSON.stringify(document)) as unknown,
      );
      expect([label, parsed.success]).toEqual([label, true]);
      if (!parsed.success) continue;
      const imported = draftFromTerms(parsed.data, seed);
      // The assumption: the import passed the step through rather than
      // normalizing it away, so what follows is a verdict on this window.
      const rebuilt = buildAdvancedTerms(imported);
      expect([label, rebuilt.linkageKeys[0].elements[0].transform]).toEqual([
        label,
        [substringStep(params)],
      ]);

      const result = validateAdvancedInvite(imported, seed, now);
      expect([label, result.canGenerate]).toEqual([label, false]);
      expect(result.errors.keys, label).toMatch(/drops every record/);
      expect(result.errors.keys, label).toMatch(/badged "won't match"/);
    }
  });

  test("a window that reads something still generates, by either door", () => {
    // Not vacuous: the block above is this window's, not every substring's.
    const live = [{ function: "substring", params: { start: 2, length: 3 } }];
    const { draft, seed } = seedAdvancedInvite("Org", ALL_COLUMNS);
    const authored = withFirstElementTransform(draft, live);
    expect(validateAdvancedInvite(authored, seed, now).canGenerate).toBe(true);
    const parsed = safeParseLinkageTerms(
      JSON.parse(JSON.stringify(buildAdvancedTerms(authored))) as unknown,
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(
      validateAdvancedInvite(draftFromTerms(parsed.data, seed), seed, now)
        .canGenerate,
    ).toBe(true);
  });

  test("every window core grades dead is one the element editor marks inline", () => {
    // The badge and blocking message name the key; the step editor's own
    // per-param error (ParamInput -> validateParamValue -> isStepValid) marks
    // the offending input (render half pinned in stepListEditor.test.ts). That
    // depends on every window core marks dead also being one the descriptors
    // reject -- two independently-edited rules -- so it is swept here rather
    // than asserted in a comment.
    const bounds: Array<number | undefined> = [undefined];
    for (let bound = -8; bound <= 8; bound++) bounds.push(bound);
    let dead = 0;
    let live = 0;
    for (const start of bounds)
      for (const length of bounds) {
        const step = substringStep({
          ...(start !== undefined && { start }),
          ...(length !== undefined && { length }),
        });
        if (!pipelineAlwaysDrops([step])) {
          live += 1;
          continue;
        }
        dead += 1;
        expect([step, isStepValid(step)]).toEqual([step, false]);
      }
    // Not vacuous: the sweep reaches both verdicts.
    expect(dead).toBeGreaterThan(0);
    expect(live).toBeGreaterThan(0);
  });
});

describe("the invitation-lifetime gate (validation-only, not a schema rule)", () => {
  test("accepts a lifetime at the boundary and lets a valid draft generate", () => {
    const { draft, seed } = seedAdvancedInvite("Org", ALL_COLUMNS);
    const now = new Date("2026-01-01T00:00:00Z");
    const result = validateAdvancedInvite(
      { ...draft, lifetimeSeconds: MAX_INVITATION_LIFETIME_SECONDS },
      seed,
      now,
    );
    expect(result.errors.lifetime).toBeUndefined();
    expect(result.canGenerate).toBe(true);
    expect(result.terms).toBeDefined();
  });
});

describe("the inert-coalesce notice (a declared default the run will not substitute)", () => {
  // The failure it names is silent under-matching: the author declares a default
  // expecting blank-ish records to participate, and the step runs as a
  // pass-through instead. It refuses nothing -- terms with this shape are
  // valid, mint, and run -- so the cases below also check Generate stays open.
  const now = new Date("2026-01-01T00:00:00Z");
  const coalesce = { function: "coalesce", params: { default: "UNKNOWN" } };
  const nullIf = { function: "null_if", params: { values: ["N/A"] } };

  function withFirstFieldSteps(
    draft: AdvancedInviteDraft,
    steps: Array<StandardizationStep>,
  ): AdvancedInviteDraft {
    return {
      ...draft,
      standardization: draft.standardization.map((transformation, index) =>
        index === 0 ? { ...transformation, steps } : transformation,
      ),
    };
  }

  function labelForOutput(draft: AdvancedInviteDraft, output: string): string {
    const field = authoredLinkageFields(
      draft.metadata,
      draft.standardization,
    ).find((candidate) => candidate.name === output);
    if (field === undefined) throw new Error("no field for the transformation");
    return SEMANTIC_TYPE_LABELS[field.type];
  }

  test("says nothing about a draft that declares no default value", () => {
    const { draft } = seedAdvancedInvite("Org", ALL_COLUMNS);
    expect(
      inertCoalesceNotice(draft, buildAdvancedTerms(draft)),
    ).toBeUndefined();
  });

  test("names the field of a coalesce nothing ahead of it can empty, and blocks nothing", () => {
    const { draft, seed } = seedAdvancedInvite("Org", ALL_COLUMNS);
    const declared = withFirstFieldSteps(draft, [coalesce]);
    const notice = inertCoalesceNotice(declared, buildAdvancedTerms(declared));
    // The field is named by its safe semantic-type label, never the field name,
    // and the sentence states the real condition rather than the absent-input
    // framing that invites the misauthoring.
    expect(notice).toContain(
      labelForOutput(declared, declared.standardization[0].output),
    );
    expect(notice).toMatch(/earlier rule in the same pipeline left it empty/);
    expect(validateAdvancedInvite(declared, seed, now).canGenerate).toBe(true);
  });

  test("a coalesce preceded only by value-preserving steps is named too", () => {
    const { draft, seed } = seedAdvancedInvite("Org", ALL_COLUMNS);
    const declared = withFirstFieldSteps(draft, [
      { function: "trim_whitespace" },
      { function: "to_upper_case" },
      coalesce,
    ]);
    expect(
      inertCoalesceNotice(declared, buildAdvancedTerms(declared)),
    ).toBeDefined();
    expect(validateAdvancedInvite(declared, seed, now).canGenerate).toBe(true);
  });

  test("moving the coalesce after a rule that can drop a value clears it", () => {
    const { draft } = seedAdvancedInvite("Org", ALL_COLUMNS);
    const inert = withFirstFieldSteps(draft, [coalesce, nullIf]);
    expect(inertCoalesceNotice(inert, buildAdvancedTerms(inert))).toBeDefined();
    const rescued = withFirstFieldSteps(draft, [nullIf, coalesce]);
    expect(
      inertCoalesceNotice(rescued, buildAdvancedTerms(rescued)),
    ).toBeUndefined();
  });

  test("a declared default on a field the built terms do not hold says nothing", () => {
    // A second column of the same type (`fname` aliases to `first_name`) so
    // draftWithFieldAdded has a free column to bind: the added field
    // (`first_name_2`) is declared in the draft's standardization but no
    // enabled key references it, so the built terms do not hold it -- the
    // exact split between authoredLinkageFields and terms.linkageFields this
    // notice must read from the latter to get right.
    const { draft } = seedAdvancedInvite("Org", [...ALL_COLUMNS, "fname"]);
    const added = draftWithFieldAdded(draft, "first_name");
    const unreferenced = {
      ...added,
      standardization: added.standardization.map((transformation) =>
        transformation.output === "first_name_2"
          ? { ...transformation, steps: [coalesce] }
          : transformation,
      ),
    };
    const terms = buildAdvancedTerms(unreferenced);
    expect(
      terms.linkageFields.some((field) => field.name === "first_name_2"),
    ).toBe(false);
    expect(inertCoalesceNotice(unreferenced, terms)).toBeUndefined();
  });

  test("an imported key transform whose coalesce declares no text default is named", () => {
    // The editor's own `default` control is a text input, so an absent or
    // non-string default arrives only on an imported document, whose transform
    // params are `z.unknown()`. Core runs both as a pass-through.
    const { draft, seed } = seedAdvancedInvite("Org", ALL_COLUMNS);
    for (const step of [
      { function: "coalesce" },
      { function: "coalesce", params: { default: 7 } },
    ]) {
      const imported = withFirstElementTransform(draft, [nullIf, step]);
      const terms = buildAdvancedTerms(imported);
      const element = terms.linkageKeys[0].elements[0];
      const field = terms.linkageFields.find(
        (candidate) => candidate.name === element.field,
      );
      if (field === undefined)
        throw new Error("the element's field is not declared");
      expect(inertCoalesceNotice(imported, terms)).toContain(
        SEMANTIC_TYPE_LABELS[field.type],
      );
      expect(validateAdvancedInvite(imported, seed, now).canGenerate).toBe(
        true,
      );
    }
  });

  test("a key transform whose coalesce does substitute says nothing", () => {
    const { draft } = seedAdvancedInvite("Org", ALL_COLUMNS);
    const substituting = withFirstElementTransform(draft, [nullIf, coalesce]);
    expect(
      inertCoalesceNotice(substituting, buildAdvancedTerms(substituting)),
    ).toBeUndefined();
  });

  test("a field declared with an Object.prototype key resolves no label, not a stringified function", () => {
    const { draft } = seedAdvancedInvite("Org", ALL_COLUMNS);
    const declared = withFirstFieldSteps(draft, [coalesce]);
    const terms = buildAdvancedTerms(declared);
    const fieldName = declared.standardization[0].output;
    const hazardous = {
      ...terms,
      linkageFields: terms.linkageFields.map((field) =>
        field.name === fieldName
          ? { ...field, type: "constructor" as never }
          : field,
      ),
    };
    expect(inertCoalesceNotice(declared, hazardous)).toBeUndefined();
  });
});
