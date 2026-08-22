import { describe, expect, test } from "vitest";

import {
  APPLIED_SETTINGS,
  FAN_OUT_FUNCTION_NAMES,
  MAX_INVITATION_LIFETIME_SECONDS,
} from "@psilink/core";

import {
  gatedActiveSettingMessage,
  validateAdvancedInvite,
} from "../../src/psi/advancedInviteValidation.js";
import { buildAdvancedTerms } from "../../src/psi/advancedInviteTerms.js";
import { seedAdvancedInvite } from "../../src/psi/advancedInviteDraft.js";

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
  // what these pin is that the pairs the run does honor generate here.
  const now = new Date("2026-01-01T00:00:00Z");

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
