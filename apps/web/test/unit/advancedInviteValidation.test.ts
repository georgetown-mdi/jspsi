import { describe, expect, test } from "vitest";

import {
  APPLIED_SETTINGS,
  FAN_OUT_FUNCTION_NAMES,
  MAX_INVITATION_LIFETIME_SECONDS,
} from "@psilink/core";

import {
  DEDUPLICATE_NOT_ON_INVITATION_MESSAGE,
  INVITATION_CARRIES_DEDUPLICATE,
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
  // Core refuses a `deduplicate: true` term under `single-pass` on both parties
  // before matching begins, so terms authored on that pair are ones both sides
  // abort on. These pin the refusal at the moment of authoring, and pin that it
  // is the PAIR it names: a single-pass draft that does not deduplicate
  // generates, and the deduplicating half is refused by the invitation gate
  // below rather than by this one.
  const now = new Date("2026-01-01T00:00:00Z");

  test("blocks Generate on a deduplicating draft under single-pass", () => {
    const { draft, seed } = seedAdvancedInvite("Org", ALL_COLUMNS);
    const result = validateAdvancedInvite(
      { ...draft, deduplicate: true, linkageStrategy: "single-pass" },
      seed,
      now,
    );
    expect(result.canGenerate).toBe(false);
    expect(result.terms).toBeUndefined();
    // Both ways out, each named as the control that carries it, rather than the
    // config-file wording core's own refusal uses.
    expect(result.errors.keys).toMatch(/Set Linkage strategy to Cascade/);
    expect(result.errors.keys).toMatch(/Allow several of your records/);
  });

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

describe("the invitation gate on a deduplicating term", () => {
  // This editor mints invitations, and acceptance adopts the inviting party's
  // deduplicate rather than mirroring it, so a deduplicating invitation reaches
  // the run as the both-sided pair and is refused there -- after the partner has
  // consented and connected. The control is disabled to match; these pin the
  // gate behind it, which holds for a draft that reached the state by another
  // route.
  const now = new Date("2026-01-01T00:00:00Z");

  test("the setting is held back from the invitation path", () => {
    // The gate is the invitation's, not the engine's: what the exchange applies
    // is a separate question, answered `true`, and reading this off
    // APPLIED_SETTINGS would state the wrong ground.
    expect(INVITATION_CARRIES_DEDUPLICATE).toBe(false);
    expect(APPLIED_SETTINGS.deduplicate).toBe(true);
  });

  test("blocks Generate on a deduplicating draft under cascade, the strategy that matches it", () => {
    const { draft, seed } = seedAdvancedInvite("Org", ALL_COLUMNS);
    const result = validateAdvancedInvite(
      { ...draft, deduplicate: true, linkageStrategy: "cascade" },
      seed,
      now,
    );
    expect(result.canGenerate).toBe(false);
    expect(result.terms).toBeUndefined();
    expect(result.errors.keys).toBe(DEDUPLICATE_NOT_ON_INVITATION_MESSAGE);
  });

  test("both obstacles are reported for a deduplicating single-pass draft", () => {
    // Neither remedy alone unblocks generation, so showing one would send the
    // operator to move a setting that leaves the other standing.
    const { draft, seed } = seedAdvancedInvite("Org", ALL_COLUMNS);
    const result = validateAdvancedInvite(
      { ...draft, deduplicate: true, linkageStrategy: "single-pass" },
      seed,
      now,
    );
    expect(result.errors.keys).toContain(DEDUPLICATE_NOT_ON_INVITATION_MESSAGE);
    expect(result.errors.keys).toMatch(/Set Linkage strategy to Cascade/);
  });

  test("refuses an import that turns the setting on, with the same ground", () => {
    // The one door the disabled control cannot close: without this an imported
    // document could leave the draft holding a setting the operator has no
    // control to clear.
    const { draft } = seedAdvancedInvite("Org", ALL_COLUMNS);
    const terms = buildAdvancedTerms({ ...draft, deduplicate: true });
    expect(gatedActiveSettingMessage(terms)).toMatch(
      /An invitation cannot carry/,
    );
    expect(gatedActiveSettingMessage(terms)).toMatch(/import again/);
    expect(
      gatedActiveSettingMessage({ ...terms, deduplicate: false }),
    ).toBeUndefined();
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
    expect(result.errors.output).toMatch(
      /Who receives the matched results|Allow several of your records/,
    );
    expect(result.errors.keys).not.toMatch(/Enable at least one linkage key/);
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
