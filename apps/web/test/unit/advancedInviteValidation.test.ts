import { describe, expect, test } from "vitest";

import {
  FAN_OUT_FUNCTION_NAMES,
  MAX_INVITATION_LIFETIME_SECONDS,
  getDefaultLinkageTerms,
  inferMetadata,
} from "@psilink/core";

import {
  gatedActiveSettingMessage,
  validateAdvancedInvite,
} from "../../src/psi/advancedInviteValidation.js";
import { buildAdvancedTerms } from "../../src/psi/advancedInviteTerms.js";
import { seedAdvancedInvite } from "../../src/psi/advancedInviteDraft.js";

import type { LinkageKeyElement } from "@psilink/core";

const ALL_COLUMNS = ["ssn", "ssn4", "first_name", "last_name", "dob"];

// These pin the mint-time gating guards to their post-split module homes -- the
// buildAdvancedTerms clamp (terms module) and the gatedActiveSettingMessage import
// refusal (validation module) -- so a later reshape of either module cannot drop a
// guard while the barrel-level tests still pass. They pin the gating WHILE the
// applied-flags are false (their state today); when an applied-flag flips the clamp
// stops firing and these fail loudly.
describe("mint-time gating guards", () => {
  test("buildAdvancedTerms clamps a forced-on psi-c to psi", () => {
    const { draft } = seedAdvancedInvite("Org", ALL_COLUMNS);
    // Force psi-c on, bypassing the disabled control, to prove the build clamps
    // regardless of how the draft reached this state -- the structural half of the
    // defense-in-depth that holds even if the UI gate and import refusal are bypassed.
    const terms = buildAdvancedTerms({ ...draft, algorithm: "psi-c" });
    expect(terms.algorithm).toBe("psi");
  });

  test("buildAdvancedTerms clamps forced-on deduplicate and per-element fuzzy", () => {
    const { draft } = seedAdvancedInvite("Org", ALL_COLUMNS);
    const forced = {
      ...draft,
      deduplicate: true,
      keys: draft.keys.map((entry, i) =>
        i === 0
          ? {
              ...entry,
              key: {
                ...entry.key,
                elements: entry.key.elements.map((el, j): LinkageKeyElement =>
                  j === 0
                    ? { ...el, generateFuzzyComparisons: "edit_distances" }
                    : el,
                ),
              },
            }
          : entry,
      ),
    };
    const terms = buildAdvancedTerms(forced);
    expect(terms.deduplicate).toBe(false);
    expect(
      terms.linkageKeys.every((key) =>
        key.elements.every((el) => el.generateFuzzyComparisons === undefined),
      ),
    ).toBe(true);
  });

  test("gatedActiveSettingMessage refuses an import that turns psi-c on", () => {
    const base = getDefaultLinkageTerms("Org", inferMetadata(ALL_COLUMNS));
    // A clean terms document is accepted (no message)...
    expect(gatedActiveSettingMessage(base)).toBeUndefined();
    // ...but one carrying the gated count-only algorithm is refused, naming psi-c.
    expect(gatedActiveSettingMessage({ ...base, algorithm: "psi-c" })).toMatch(
      /psi-c/,
    );
  });
});

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
    // The message names the missing capability rather than reporting a schema
    // fault -- the step is well-formed, and the run is what cannot honor it.
    expect(result.errors.standardization).toMatch(/not built yet/);
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
    expect(result.errors.keys).toMatch(/not built yet/);
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

describe("the invitation-lifetime gate (validation-only, not a schema rule)", () => {
  test("blocks Generate on a non-positive or over-a-year lifetime", () => {
    const { draft, seed } = seedAdvancedInvite("Org", ALL_COLUMNS);
    const now = new Date("2026-01-01T00:00:00Z");
    expect(
      validateAdvancedInvite({ ...draft, lifetimeSeconds: 0 }, seed, now).errors
        .lifetime,
    ).toBeDefined();
    expect(
      validateAdvancedInvite(
        { ...draft, lifetimeSeconds: MAX_INVITATION_LIFETIME_SECONDS + 1 },
        seed,
        now,
      ).errors.lifetime,
    ).toBeDefined();
  });

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
