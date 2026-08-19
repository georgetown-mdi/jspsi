import { describe, expect, test, vi } from "vitest";

import { buildAdvancedTerms } from "@psi/advancedInviteTerms";
import { seedAdvancedInvite } from "@psi/advancedInviteDraft";
import { setColumnDisclosure } from "@psi/metadataEditing";
import { validateAdvancedInvite } from "@psi/advancedInviteValidation";

import type * as PsilinkCore from "@psilink/core";
import type { AdvancedInviteDraft } from "@psi/advancedInviteTypes";

// The count-only shape gate at the web AUTHORING boundary. `buildAdvancedTerms`
// clamps the algorithm (and deduplication) to the applied behavior while their
// APPLIED_SETTINGS flags are false, so a draft cannot put `psi-c` into the built
// terms today. Both flags are forced here to reach the gate that has to hold once
// they flip -- the same reason core's fuzzy-expansion suite forces its own flag.
// The rules themselves are untouched by the mock: they read the algorithm, not
// whether a run path exists. The mock is file-scoped, which is why the authoring
// gate lives here and the accept and import gates -- which need no forced flag --
// stay on the unmocked path in countOnlyAcceptGates.test.ts.
vi.mock("@psilink/core", async (importOriginal) => {
  const actual = await importOriginal<typeof PsilinkCore>();
  return {
    ...actual,
    APPLIED_SETTINGS: {
      psiC: true,
      deduplicate: true,
      fuzzyComparisons: false,
    },
  };
});

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
  test("the forced flags really do put psi-c into the built terms", () => {
    // Without this the cases below would pass on a clamped `psi` document, which
    // every rule leaves alone -- they would gate nothing and still be green.
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
    // The rule this editor's own metadata carries: a marked column authors a
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

  test("the identical draft under psi generates, so every gate is the algorithm's", () => {
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
  });
});
