import { describe, expect, test } from "vitest";

import { buildAdvancedTerms } from "@psi/authoring/advancedInviteTerms";
import { seedAdvancedInvite } from "@psi/authoring/advancedInviteDraft";
import { setColumnDisclosure } from "@psi/metadataEditing";
import { validateAdvancedInvite } from "@psi/authoring/advancedInviteValidation";

import type { AdvancedInviteDraft } from "@psi/authoring/advancedInviteTypes";

// The count-only shape gate at the web AUTHORING boundary. Each of the five rules
// is reached through `buildAdvancedTerms`, which clamps only the settings whose
// applied-flag is false; the rules themselves read the algorithm and the document.
// The accept and import gates are the same rules at the other two boundaries, in
// countOnlyAcceptGates.test.ts.

const LINKAGE_COLUMNS = ["ssn", "first_name", "last_name", "dob"];
const NOW = new Date("2026-01-01T00:00:00Z");

/** A count-only draft in exactly the shape the specification admits: the seeded
 * draft narrowed to one enabled linkage key, which is the only one of the five
 * rules the defaults break. */
function countOnlyDraft(columns: Array<string> = LINKAGE_COLUMNS) {
  const { draft, seed } = seedAdvancedInvite("Org", columns);
  return {
    seed,
    draft: {
      ...draft,
      algorithm: "psi-c" as const,
      keys: draft.keys.map((entry, index) => ({
        ...entry,
        enabled: index === 0,
      })),
    },
  };
}

describe("the count-only shape gate at the Generate boundary", () => {
  test("the draft's psi-c really does reach the built terms", () => {
    // Without this the cases below could pass on a `psi` document, which every rule
    // leaves alone -- they would gate nothing and still be green.
    const { draft } = countOnlyDraft();
    expect(buildAdvancedTerms(draft).algorithm).toBe("psi-c");
  });

  test("a count-only draft in the specified shape can still be generated", () => {
    const { draft, seed } = countOnlyDraft();
    const result = validateAdvancedInvite(draft, seed, NOW);
    expect(result.errors).toEqual({});
    expect(result.canGenerate).toBe(true);
  });

  test.each([
    {
      rule: "more than one linkage key",
      edit: (draft: AdvancedInviteDraft): AdvancedInviteDraft => ({
        ...draft,
        keys: draft.keys.map((entry, index) => ({
          ...entry,
          enabled: index < 2,
        })),
      }),
      field: "keys" as const,
      expected: /single linkage key/,
    },
    {
      rule: "single-pass",
      edit: (draft: AdvancedInviteDraft): AdvancedInviteDraft => ({
        ...draft,
        linkageStrategy: "single-pass",
      }),
      field: "keys" as const,
      expected: /Set Linkage strategy to Cascade/,
    },
    {
      rule: "duplicate matches",
      edit: (draft: AdvancedInviteDraft): AdvancedInviteDraft => ({
        ...draft,
        deduplicate: true,
      }),
      field: "keys" as const,
      expected: /several of your records cannot match one partner record/,
    },
  ])(
    "blocks Generate on a count-only draft declaring $rule",
    ({ edit, field, expected }) => {
      const { draft, seed } = countOnlyDraft();
      const result = validateAdvancedInvite(edit(draft), seed, NOW);
      expect(result.canGenerate).toBe(false);
      expect(result.terms).toBeUndefined();
      // The rule broken and what to change, not the generic schema-failure message
      // the issue path would otherwise map this control to.
      expect(result.errors[field]).toMatch(expected);
    },
  );

  test("blocks Generate on a count-only draft whose columns are marked to send", () => {
    // The rule this editor's own metadata holds: a marked column authors a
    // payload send AND is what the run would transmit, and a count-only exchange
    // has room for neither. The payload control names the marks, since clearing
    // them is what the operator does about it.
    const { draft, seed } = countOnlyDraft([...LINKAGE_COLUMNS, "notes"]);
    const sending = {
      ...draft,
      metadata: setColumnDisclosure(draft.metadata, "notes", "payload")
        .metadata,
    };
    const result = validateAdvancedInvite(sending, seed, NOW);
    expect(result.canGenerate).toBe(false);
    expect(result.errors.payload).toMatch(/sends no data columns/);
    expect(result.errors.payload).toMatch(/so they are not sent/);
  });

  test("under psi the identical draft generates, so every refusal above was the count-only rules'", () => {
    // Every rule above is the count-only algorithm's: under psi the same draft
    // keeps its several keys, its single-pass strategy, its deduplicating term
    // and its marked column, and generates. Nothing here was a rule the
    // identifier-revealing algorithm holds too.
    const { draft, seed } = countOnlyDraft([...LINKAGE_COLUMNS, "notes"]);
    const asPsi: AdvancedInviteDraft = {
      ...draft,
      algorithm: "psi",
      deduplicate: true,
      linkageStrategy: "single-pass",
      keys: draft.keys.map((entry) => ({ ...entry, enabled: true })),
      metadata: setColumnDisclosure(draft.metadata, "notes", "payload")
        .metadata,
    };
    const result = validateAdvancedInvite(asPsi, seed, NOW);
    expect(result.errors).toEqual({});
    expect(result.canGenerate).toBe(true);
    expect(result.terms?.deduplicate).toBe(true);
  });
});

describe("the count-only candidate-set gate at the Generate boundary", () => {
  // The rule the shape rules above do not hold: a count-only round counts
  // matched values where the matching pairs each record at most once, so a key
  // expanding a record into several candidates is refused at prepare and again
  // at the agreed-terms run boundary.

  /** The seeded count-only draft narrowed to the one built-in key declaring a
   * swap -- an expansion, and the reason the gate is reachable through the keys
   * the editor seeds rather than an authored one. It satisfies every count-only
   * shape rule: one key, cascade, no deduplication, no payload. */
  function swappedKeyDraft() {
    const { draft, seed } = countOnlyDraft();
    const swapIndex = draft.keys.findIndex(
      (entry) => entry.key.swap !== undefined,
    );
    expect(swapIndex).toBeGreaterThanOrEqual(0);
    return {
      seed,
      draft: {
        ...draft,
        keys: draft.keys.map((entry, index) => ({
          ...entry,
          enabled: index === swapIndex,
        })),
      },
    };
  }

  test("the swap really does reach the built terms", () => {
    // Without this the case below could pass on a draft whose enabled key
    // declares no swap, gating nothing and still being green.
    const { draft } = swappedKeyDraft();
    const terms = buildAdvancedTerms(draft);
    expect(terms.algorithm).toBe("psi-c");
    expect(terms.linkageKeys.every((key) => key.swap !== undefined)).toBe(true);
  });

  test("blocks Generate on a count-only draft whose key declares a swap", () => {
    const { draft, seed } = swappedKeyDraft();
    const result = validateAdvancedInvite(draft, seed, NOW);
    expect(result.canGenerate).toBe(false);
    expect(result.terms).toBeUndefined();
    // What is wrong and what to change, against the key list that holds both
    // remedies -- not the generic schema-failure message, and not the alert the
    // mint would otherwise raise after the operator pressed Generate.
    expect(result.errors.keys).toMatch(/matches one value per record/);
    expect(result.errors.keys).toMatch(/either-order swap/);
    expect(result.errors.keys).toMatch(/Reveal the matched identifiers/);
  });

  test("under psi the identical draft generates, so the refusal was the count-only algorithm's", () => {
    // The identifier-revealing algorithm resolves a candidate set under both
    // linkage strategies, so the same swapped key generates there.
    const { draft, seed } = swappedKeyDraft();
    const asPsi: AdvancedInviteDraft = { ...draft, algorithm: "psi" };
    const result = validateAdvancedInvite(asPsi, seed, NOW);
    expect(result.errors).toEqual({});
    expect(result.canGenerate).toBe(true);
  });
});
