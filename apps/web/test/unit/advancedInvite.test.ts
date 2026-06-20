import { describe, expect, test } from "vitest";

import {
  MAX_INVITATION_LIFETIME_SECONDS,
  getDefaultLinkageTerms,
  inferMetadata,
  safeParseLinkageTerms,
} from "@psilink/core";

import {
  buildAdvancedTerms,
  seedAdvancedInvite,
  validateAdvancedInvite,
} from "../../src/psi/advancedInvite.js";

import type { AdvancedInviteDraft } from "../../src/psi/advancedInvite.js";

// Columns carrying every default linkage type, and a partial set missing ssn4
// (like the bundled fake data): keys referencing ssn4 drop from the seed.
const ALL_COLUMNS = ["ssn", "ssn4", "first_name", "last_name", "dob"];
const PARTIAL_COLUMNS = ["ssn", "first_name", "last_name", "dob"];

/** Disable every key except the named one. */
function onlyKeyEnabled(
  draft: AdvancedInviteDraft,
  name: string,
): AdvancedInviteDraft {
  return {
    ...draft,
    keys: draft.keys.map((entry) => ({
      ...entry,
      enabled: entry.key.name === name,
    })),
  };
}

describe("seedAdvancedInvite + buildAdvancedTerms", () => {
  test("(a) building an unedited seed equals the auto-derived terms", () => {
    const { draft, seed } = seedAdvancedInvite(
      "County Health Dept",
      ALL_COLUMNS,
    );
    // Generating with no changes produces terms equivalent to today's quick-path
    // auto-derived output for the same inputs.
    expect(buildAdvancedTerms(draft, seed)).toStrictEqual(
      getDefaultLinkageTerms("County Health Dept", inferMetadata(ALL_COLUMNS)),
    );
    // The seed itself is that auto-derived set, so it opens valid, never blank.
    expect(seed.terms).toStrictEqual(
      getDefaultLinkageTerms("County Health Dept", inferMetadata(ALL_COLUMNS)),
    );
  });

  test("(b) metadata-aware seeding drops keys the columns cannot satisfy", () => {
    const full = seedAdvancedInvite("Org", ALL_COLUMNS).seed.terms;
    const { seed } = seedAdvancedInvite("Org", PARTIAL_COLUMNS);

    // No ssn4-referencing key survives a file without an ssn4 column, and the set
    // is genuinely smaller than the all-columns one.
    expect(
      seed.terms.linkageKeys.some((k) =>
        k.elements.some((e) => e.field === "ssn4"),
      ),
    ).toBe(false);
    expect(seed.terms.linkageKeys.length).toBeGreaterThan(0);
    expect(seed.terms.linkageKeys.length).toBeLessThan(full.linkageKeys.length);
    // The dropped field is no longer declared either.
    expect(seed.terms.linkageFields.some((f) => f.name === "ssn4")).toBe(false);
  });

  test("reordering keys reorders the built linkage keys in place", () => {
    const { draft, seed } = seedAdvancedInvite("Org", ALL_COLUMNS);
    const reversed = { ...draft, keys: [...draft.keys].reverse() };
    const built = buildAdvancedTerms(reversed, seed);
    expect(built.linkageKeys.map((k) => k.name)).toEqual(
      [...seed.terms.linkageKeys].reverse().map((k) => k.name),
    );
  });

  test("disabling the keys that use a field drops that field too", () => {
    const { draft, seed } = seedAdvancedInvite("Org", ALL_COLUMNS);
    const withoutSsn4Keys = {
      ...draft,
      keys: draft.keys.map((entry) => ({
        ...entry,
        enabled: !entry.key.elements.some((e) => e.field === "ssn4"),
      })),
    };
    const built = buildAdvancedTerms(withoutSsn4Keys, seed);
    expect(built.linkageKeys.length).toBeGreaterThan(0);
    expect(built.linkageFields.some((f) => f.name === "ssn4")).toBe(false);
  });

  test("free text in identity and legal agreement is NFC-normalized and trimmed", () => {
    const { draft, seed } = seedAdvancedInvite("Org", ALL_COLUMNS);
    const edited: AdvancedInviteDraft = {
      ...draft,
      // "Café" (NFD) must normalize to "Café" (NFC); surrounding
      // whitespace is trimmed.
      identity: "  Café Org  ",
      legalAgreement: {
        reference: "  MOU-1  ",
        purpose: "  Audit  ",
        expirationDate: "2030-01-01",
      },
    };
    const built = buildAdvancedTerms(edited, seed);
    expect(built.identity).toBe("Café Org");
    expect(built.legalAgreement?.reference).toBe("MOU-1");
    expect(built.legalAgreement?.purpose).toBe("Audit");
  });
});

describe("validateAdvancedInvite", () => {
  const NOW = new Date("2026-06-20T00:00:00.000Z");

  test("a seeded draft generates cleanly and round-trips through the schema", () => {
    const { draft, seed } = seedAdvancedInvite("Org", ALL_COLUMNS);
    const result = validateAdvancedInvite(draft, seed, NOW);
    expect(result.canGenerate).toBe(true);
    expect(result.errors).toEqual({});
    expect(result.terms).toBeDefined();
    // (f, schema-side) the built terms parse back through the core schema.
    expect(safeParseLinkageTerms(result.terms).success).toBe(true);
  });

  test("(c) blocks Generate on an empty identity, against the identity control", () => {
    const { draft, seed } = seedAdvancedInvite("Org", ALL_COLUMNS);
    const result = validateAdvancedInvite(
      { ...draft, identity: "   " },
      seed,
      NOW,
    );
    expect(result.canGenerate).toBe(false);
    expect(result.errors.identity).toBeDefined();
    expect(result.terms).toBeUndefined();
  });

  test("(c) blocks Generate when no key is enabled, against the key control", () => {
    const { draft, seed } = seedAdvancedInvite("Org", ALL_COLUMNS);
    const noneEnabled = {
      ...draft,
      keys: draft.keys.map((entry) => ({ ...entry, enabled: false })),
    };
    const result = validateAdvancedInvite(noneEnabled, seed, NOW);
    expect(result.canGenerate).toBe(false);
    expect(result.errors.keys).toBeDefined();
  });

  test("(c) blocks Generate when no enabled key is column-satisfiable", () => {
    const { draft, seed } = seedAdvancedInvite("Org", ALL_COLUMNS);
    const ssn4Key = seed.terms.linkageKeys.find((k) =>
      k.elements.some((e) => e.field === "ssn4"),
    );
    expect(ssn4Key).toBeDefined();
    // Enable only an ssn4 key, then validate against columns that lack ssn4.
    const result = validateAdvancedInvite(
      onlyKeyEnabled(draft, ssn4Key!.name),
      { ...seed, columns: PARTIAL_COLUMNS },
      NOW,
    );
    expect(result.canGenerate).toBe(false);
    expect(result.errors.keys).toBeDefined();
  });

  test("(c) blocks Generate on an incomplete legal agreement, per field", () => {
    const { draft, seed } = seedAdvancedInvite("Org", ALL_COLUMNS);
    const result = validateAdvancedInvite(
      {
        ...draft,
        legalAgreement: { reference: "", purpose: "", expirationDate: "" },
      },
      seed,
      NOW,
    );
    expect(result.canGenerate).toBe(false);
    expect(result.errors.legalReference).toBeDefined();
    expect(result.errors.legalPurpose).toBeDefined();
    expect(result.errors.legalExpiration).toBeDefined();
  });

  test("(c) blocks Generate on a non-future legal-agreement expiry", () => {
    const { draft, seed } = seedAdvancedInvite("Org", ALL_COLUMNS);
    const result = validateAdvancedInvite(
      {
        ...draft,
        legalAgreement: {
          reference: "MOU-1",
          purpose: "Audit",
          // Equal to NOW's date -> not in the future.
          expirationDate: "2026-06-20",
        },
      },
      seed,
      NOW,
    );
    expect(result.canGenerate).toBe(false);
    expect(result.errors.legalExpiration).toContain("future");
  });

  test("accepts a complete, future-dated legal agreement", () => {
    const { draft, seed } = seedAdvancedInvite("Org", ALL_COLUMNS);
    const result = validateAdvancedInvite(
      {
        ...draft,
        legalAgreement: {
          reference: "MOU-2025-0042",
          purpose: "Program evaluation",
          expirationDate: "2027-01-01",
        },
      },
      seed,
      NOW,
    );
    expect(result.canGenerate).toBe(true);
    expect(result.terms?.legalAgreement?.reference).toBe("MOU-2025-0042");
  });

  test("blocks Generate on an out-of-bounds lifetime", () => {
    const { draft, seed } = seedAdvancedInvite("Org", ALL_COLUMNS);
    expect(
      validateAdvancedInvite({ ...draft, lifetimeSeconds: 0 }, seed, NOW).errors
        .lifetime,
    ).toBeDefined();
    expect(
      validateAdvancedInvite(
        { ...draft, lifetimeSeconds: MAX_INVITATION_LIFETIME_SECONDS + 1 },
        seed,
        NOW,
      ).errors.lifetime,
    ).toBeDefined();
  });
});

describe("controls the editor does not expose stay at their safe defaults", () => {
  // Several drafts exercising every control the editor DOES offer.
  const variants = (): Array<AdvancedInviteDraft> => {
    const { draft } = seedAdvancedInvite("Org", ALL_COLUMNS);
    return [
      draft,
      { ...draft, identity: "Renamed Org" },
      { ...draft, keys: [...draft.keys].reverse() },
      {
        ...draft,
        keys: draft.keys.map((e, i) => ({ ...e, enabled: i % 2 === 0 })),
      },
      {
        ...draft,
        legalAgreement: {
          reference: "MOU-1",
          purpose: "Audit",
          expirationDate: "2030-01-01",
        },
      },
    ].filter((d) => d.keys.some((k) => k.enabled));
  };

  test("(d) output is always both-receive and never a forbidden combination", () => {
    const { seed } = seedAdvancedInvite("Org", ALL_COLUMNS);
    for (const draft of variants()) {
      const built = buildAdvancedTerms(draft, seed);
      expect(built.output).toStrictEqual({
        expectsOutput: true,
        shareWithPartner: true,
      });
    }
  });

  test("(e) algorithm stays psi, deduplicate stays off, no fuzzy is added", () => {
    const { seed } = seedAdvancedInvite("Org", ALL_COLUMNS);
    for (const draft of variants()) {
      const built = buildAdvancedTerms(draft, seed);
      expect(built.algorithm).toBe("psi");
      expect(built.deduplicate).toBe(false);
      expect(
        built.linkageKeys.every((k) =>
          k.elements.every((e) => e.generateFuzzyComparisons === undefined),
        ),
      ).toBe(true);
      // No payload is authored either.
      expect(built.payload).toBeUndefined();
    }
  });
});
