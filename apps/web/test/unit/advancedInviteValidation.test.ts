import { describe, expect, test } from "vitest";

import {
  APPLIED_SETTINGS,
  DEDUPLICATE_IMPLEMENTED_BY_STRATEGY,
  FAN_OUT_FUNCTION_NAMES,
  MAX_INVITATION_LIFETIME_SECONDS,
  authoredLinkageFields,
} from "@psilink/core";

import {
  gatedActiveSettingMessage,
  inertCoalesceNotice,
  validateAdvancedInvite,
} from "../../src/psi/advancedInviteValidation.js";
import { SEMANTIC_TYPE_LABELS } from "../../src/psi/metadataEditing.js";
import { buildAdvancedTerms } from "../../src/psi/advancedInviteTerms.js";
import { seedAdvancedInvite } from "../../src/psi/advancedInviteDraft.js";

import type {
  LinkageStrategy,
  StandardizationStep,
  TransformStep,
} from "@psilink/core";

import type { AdvancedInviteDraft } from "../../src/psi/advancedInviteTypes.js";

const ALL_COLUMNS = ["ssn", "ssn4", "first_name", "last_name", "dob"];

describe("the fan-out gate (the run refuses what the schema admits)", () => {
  // Core refuses an exchange whose standardization or linkage-key transforms
  // declare a fan-out step, so an invitation carrying one is refused at its own
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
      // that settle it and no strategy -- which one cannot run a deduplicating
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
    // pair, which without its own mapping collapses to the key list and reads as
    // "Enable at least one linkage key."
    const { draft, seed } = seedAdvancedInvite("Org", ALL_COLUMNS);
    const result = validateAdvancedInvite(
      { ...draft, deduplicate: true, outputDirection: "partner" },
      seed,
      now,
    );
    expect(result.canGenerate).toBe(false);
    expect(result.errors.output).toMatch(/needs you to receive the matched/);
    expect(result.errors.output).toMatch(/Who receives the matched results/);
    // Both halves settle it, and both are live controls, so both are named.
    expect(result.errors.output).toMatch(/Allow several of your records/);
    // Against the output pair alone: the key list is not where this reports.
    expect(result.errors.keys).toBeUndefined();
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
  // pass-through instead. It refuses nothing -- terms carrying this shape are
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
});
