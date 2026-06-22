import { describe, expect, test } from "vitest";

import {
  MAX_INVITATION_LIFETIME_SECONDS,
  assessLinkageSatisfiability,
  canonicalString,
  deriveAcceptedLinkageTerms,
  getDefaultLinkageTerms,
  inferMetadata,
  prepareForExchange,
  safeParseLinkageTerms,
  validateCompatibility,
} from "@psilink/core";

import {
  buildAdvancedTerms,
  defaultStandardizationForRows,
  draftFromTerms,
  outputForDirection,
  seedAdvancedInvite,
  setDraftMetadata,
  validateAdvancedInvite,
} from "../../src/psi/advancedInvite.js";
import {
  setColumnDisclosure,
  setColumnType,
} from "../../src/psi/metadataEditing.js";

import type {
  AdvancedInviteDraft,
  AdvancedInviteSeed,
  OutputDirection,
} from "../../src/psi/advancedInvite.js";

import type { Metadata } from "@psilink/core";

/** The names of the draft keys that reference an `ssn` field. */
function ssnKeyNames(draft: AdvancedInviteDraft): Array<string> {
  return draft.keys
    .filter((entry) => entry.key.elements.some((el) => el.field === "ssn"))
    .map((entry) => entry.key.name);
}

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
    expect(buildAdvancedTerms(draft)).toStrictEqual(
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
    const built = buildAdvancedTerms(reversed);
    expect(built.linkageKeys.map((k) => k.name)).toEqual(
      [...seed.terms.linkageKeys].reverse().map((k) => k.name),
    );
  });

  test("disabling the keys that use a field drops that field too", () => {
    const { draft } = seedAdvancedInvite("Org", ALL_COLUMNS);
    const withoutSsn4Keys = {
      ...draft,
      keys: draft.keys.map((entry) => ({
        ...entry,
        enabled: !entry.key.elements.some((e) => e.field === "ssn4"),
      })),
    };
    const built = buildAdvancedTerms(withoutSsn4Keys);
    expect(built.linkageKeys.length).toBeGreaterThan(0);
    expect(built.linkageFields.some((f) => f.name === "ssn4")).toBe(false);
  });

  test("free text in identity and legal agreement is NFC-normalized and trimmed", () => {
    const { draft } = seedAdvancedInvite("Org", ALL_COLUMNS);
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
    const built = buildAdvancedTerms(edited);
    expect(built.identity).toBe("Café Org");
    expect(built.legalAgreement?.reference).toBe("MOU-1");
    expect(built.legalAgreement?.purpose).toBe("Audit");
  });
});

describe("setDraftMetadata re-derives offerable keys", () => {
  const COLS = ["first_name", "last_name", "dob", "extra"];

  test("editing a column type adds the keys its type makes offerable", () => {
    // No ssn column: no ssn-referencing key is offerable.
    const { draft } = seedAdvancedInvite("Org", COLS);
    expect(ssnKeyNames(draft)).toEqual([]);

    // Remap `extra` -> ssn: ssn keys become offerable and appear in the draft.
    const next = setDraftMetadata(
      draft,
      setColumnType(draft.metadata, "extra", "ssn").metadata,
    );
    expect(ssnKeyNames(next).length).toBeGreaterThan(0);
    // The terms built from the new draft now declare ssn, so the run can produce
    // it -- the metadata that re-derived the keys is the metadata the run binds on.
    expect(
      buildAdvancedTerms(next).linkageFields.some((f) => f.name === "ssn"),
    ).toBe(true);
  });

  test("remapping a previously-ignored column promotes it so its key becomes offerable", () => {
    // The inviter-side analogue of the acceptor remap fix: an `ignored` column
    // retyped to a linkage type is promoted to a usable role, so the key it now
    // supplies is offerable -- it does not silently fail to satisfy the field.
    const { draft } = seedAdvancedInvite("Org", COLS);
    const ignored = setColumnDisclosure(
      draft.metadata,
      "extra",
      "ignored",
    ).metadata;
    const next = setDraftMetadata(
      draft,
      setColumnType(ignored, "extra", "ssn").metadata,
    );
    expect(ssnKeyNames(next).length).toBeGreaterThan(0);
  });

  test("a remap that only adds keys preserves the enabled/order of existing keys", () => {
    const { draft } = seedAdvancedInvite("Org", COLS);
    // Disable the first key, then remap to add ssn keys (which does not drop any
    // existing key, since no default key references the `other`-typed `extra`).
    const firstName = draft.keys[0].key.name;
    const withDisabled: AdvancedInviteDraft = {
      ...draft,
      keys: draft.keys.map((entry, i) =>
        i === 0 ? { ...entry, enabled: false } : entry,
      ),
    };
    const next = setDraftMetadata(
      withDisabled,
      setColumnType(withDisabled.metadata, "extra", "ssn").metadata,
    );
    // The disabled key kept its position and disabled flag; the new ssn keys are
    // appended enabled.
    expect(next.keys[0].key.name).toBe(firstName);
    expect(next.keys[0].enabled).toBe(false);
    expect(ssnKeyNames(next).length).toBeGreaterThan(0);
    expect(
      next.keys
        .filter((e) => e.key.elements.some((el) => el.field === "ssn"))
        .every((e) => e.enabled),
    ).toBe(true);
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

  test("(c) blocks Generate on a past legal-agreement expiry", () => {
    const { draft, seed } = seedAdvancedInvite("Org", ALL_COLUMNS);
    const result = validateAdvancedInvite(
      {
        ...draft,
        legalAgreement: {
          reference: "MOU-1",
          purpose: "Audit",
          // The day before NOW -> already expired.
          expirationDate: "2026-06-19",
        },
      },
      seed,
      NOW,
    );
    expect(result.canGenerate).toBe(false);
    expect(result.errors.legalExpiration).toContain("past");
  });

  test("accepts a same-day legal-agreement expiry, matching the exchange", () => {
    // The exchange rejects only an expirationDate strictly before today, so a
    // same-day expiry is still honored there; the editor must not refuse an
    // invitation the exchange would accept.
    const { draft, seed } = seedAdvancedInvite("Org", ALL_COLUMNS);
    const result = validateAdvancedInvite(
      {
        ...draft,
        legalAgreement: {
          reference: "MOU-1",
          purpose: "Audit",
          // Equal to NOW's date.
          expirationDate: "2026-06-20",
        },
      },
      seed,
      NOW,
    );
    expect(result.canGenerate).toBe(true);
    expect(result.errors.legalExpiration).toBeUndefined();
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

  test("(d) output defaults to both-receive when the direction is left at its default", () => {
    // The variants exercise every control EXCEPT the output direction, which they
    // leave at the seed default ("both"), so the built output stays the symmetric
    // both-receive pair. The 3-way control's own mapping is covered separately
    // below.
    for (const draft of variants()) {
      const built = buildAdvancedTerms(draft);
      expect(built.output).toStrictEqual({
        expectsOutput: true,
        shareWithPartner: true,
      });
    }
  });

  test("(e) algorithm stays psi, deduplicate stays off, no fuzzy is added", () => {
    for (const draft of variants()) {
      const built = buildAdvancedTerms(draft);
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

describe("the 3-way output direction control", () => {
  const DIRECTIONS: ReadonlyArray<{
    direction: OutputDirection;
    output: { expectsOutput: boolean; shareWithPartner: boolean };
  }> = [
    {
      direction: "both",
      output: { expectsOutput: true, shareWithPartner: true },
    },
    {
      direction: "inviter",
      output: { expectsOutput: true, shareWithPartner: false },
    },
    {
      direction: "partner",
      output: { expectsOutput: false, shareWithPartner: true },
    },
  ];

  test("each choice maps to the correct expectsOutput/shareWithPartner pair", () => {
    const { draft } = seedAdvancedInvite("Org", ALL_COLUMNS);
    for (const { direction, output } of DIRECTIONS) {
      // Both the pure mapping and the built terms agree on the pair.
      expect(outputForDirection(direction)).toStrictEqual(output);
      expect(
        buildAdvancedTerms({ ...draft, outputDirection: direction }).output,
      ).toStrictEqual(output);
    }
  });

  test("no choice can yield the forbidden 'neither receives' combination", () => {
    const pairs = DIRECTIONS.map((d) => outputForDirection(d.direction));
    // None of the three valid directions maps to {false, false}, and the type has
    // no fourth value -- so the forbidden pair is unrepresentable, not merely
    // validated after the fact.
    expect(pairs).not.toContainEqual({
      expectsOutput: false,
      shareWithPartner: false,
    });
    // The three are distinct, so the control offers three genuinely different pairs.
    expect(new Set(pairs.map((p) => JSON.stringify(p))).size).toBe(3);
  });

  test("every direction's built terms parse and pass the cross-party mirror check", () => {
    const { draft } = seedAdvancedInvite("Org", ALL_COLUMNS);
    for (const { direction } of DIRECTIONS) {
      const terms = buildAdvancedTerms({
        ...draft,
        outputDirection: direction,
      });
      // The inviter's terms parse through the core schema...
      expect(safeParseLinkageTerms(terms).success).toBe(true);
      // ...and an acceptor that mirrors them agrees under validateCompatibility, so
      // the one-sided invitation would not abort the exchange on an output mismatch.
      const acceptor = deriveAcceptedLinkageTerms(terms, "Accepting Org");
      expect(validateCompatibility(terms, acceptor).errors).toEqual([]);
    }
  });
});

describe("inviter standardization: per-field column binding and multi-field", () => {
  // Two columns of one semantic type (a maiden and a current name) and a date, so
  // the inviter can bind each name column to its own field. NAME_STEPS uppercases,
  // so a row whose two name columns differ yields two distinct cleaned values.
  const NAME_STEPS = [{ function: "to_upper_case" }];
  const metadata: Metadata = [
    {
      name: "maiden_col",
      type: "first_name",
      role: "linkage",
      isPayload: false,
    },
    {
      name: "current_col",
      type: "first_name",
      role: "linkage",
      isPayload: false,
    },
    {
      name: "dob_col",
      type: "date_of_birth",
      role: "linkage",
      isPayload: false,
    },
  ];
  const columns = ["maiden_col", "current_col", "dob_col"];
  const rawRows = [{ maiden_col: "Smith", current_col: "Jones", dob_col: "X" }];

  // A draft binding the two first_name columns to two distinct fields, each
  // referenced by its own key -- what the workbench's "add another field" + the
  // expert key editor produce.
  function multiFieldDraft(): AdvancedInviteDraft {
    return {
      identity: "Inviter",
      lifetimeSeconds: 3600,
      outputDirection: "both",
      algorithm: "psi",
      deduplicate: false,
      metadata,
      standardization: [
        { output: "first_name", input: "maiden_col", steps: NAME_STEPS },
        { output: "first_name_2", input: "current_col", steps: NAME_STEPS },
      ],
      keys: [
        {
          key: { name: "maiden", elements: [{ field: "first_name" }] },
          enabled: true,
        },
        {
          key: { name: "current", elements: [{ field: "first_name_2" }] },
          enabled: true,
        },
      ],
    };
  }

  test("buildAdvancedTerms declares two distinct fields of the one type", () => {
    const terms = buildAdvancedTerms(multiFieldDraft());
    const firstNameFields = terms.linkageFields.filter(
      (field) => field.type === "first_name",
    );
    expect(firstNameFields.map((field) => field.name)).toEqual([
      "first_name",
      "first_name_2",
    ]);
    // The built terms are valid and a mirroring acceptor agrees, so the multi-field
    // invitation is well-formed cross-party.
    expect(safeParseLinkageTerms(terms).success).toBe(true);
    const acceptor = deriveAcceptedLinkageTerms(terms, "Acceptor");
    expect(validateCompatibility(terms, acceptor).errors).toEqual([]);
  });

  test("each same-typed field round-trips through prepareForExchange to its own column's distinct value", () => {
    const draft = multiFieldDraft();
    const terms = buildAdvancedTerms(draft);
    // The exact { linkageTerms, metadata, standardization } the editor hands the
    // inviter's exchange, run through the exchange's own preparation: each field
    // reads its bound column, so the differing name columns produce distinct values
    // rather than the collapsed identical pair a one-field-per-type default gives.
    const prepared = prepareForExchange(
      { linkageTerms: terms, metadata, standardization: draft.standardization },
      "Inviter",
      rawRows,
      columns,
    );
    expect(prepared.dataset.getField("first_name")?.get(0)).toEqual(["SMITH"]);
    expect(prepared.dataset.getField("first_name_2")?.get(0)).toEqual([
      "JONES",
    ]);
  });

  test("a per-party cleaning edit does not move the cross-party terms (local-only invariant)", () => {
    // Editing a field's cleaning steps or input-column binding changes only this
    // party's local standardization -- the cross-party LinkageTerms carry the field
    // name/type/constraints, never the cleaning -- so the agreement (and its hash)
    // is byte-identical. This is the inviter mirror of the acceptor's cross-party
    // hash-invariance test.
    const { draft } = seedAdvancedInvite("Inviter", ALL_COLUMNS);
    const baseline = canonicalString(buildAdvancedTerms(draft));
    const edited = canonicalString(
      buildAdvancedTerms({
        ...draft,
        standardization: draft.standardization.map((transformation) =>
          transformation.output === "first_name"
            ? { ...transformation, steps: [{ function: "to_lower_case" }] }
            : transformation,
        ),
      }),
    );
    expect(edited).toEqual(baseline);
  });

  test("the satisfiability gate binds each field through the authored standardization, not the type fallback", () => {
    // A single key referencing the SECOND same-typed field, bound to current_col. If
    // the file lacks current_col, that field is unproducible and the only key is
    // unsatisfiable -- the exchange would emit no key strings and yield a silent
    // empty result. The gate sees this only by resolving first_name_2 through the
    // standardization (to current_col); the bare type fallback binds every first_name
    // field to the first such column (maiden_col, present) and would wrongly pass.
    const draft: AdvancedInviteDraft = {
      identity: "Inviter",
      lifetimeSeconds: 3600,
      outputDirection: "both",
      algorithm: "psi",
      deduplicate: false,
      metadata,
      standardization: [
        { output: "first_name", input: "maiden_col", steps: NAME_STEPS },
        { output: "first_name_2", input: "current_col", steps: NAME_STEPS },
      ],
      keys: [
        {
          key: { name: "current", elements: [{ field: "first_name_2" }] },
          enabled: true,
        },
      ],
    };
    // The file carries maiden_col but not current_col (the second field's column).
    const seed: AdvancedInviteSeed = {
      terms: getDefaultLinkageTerms("Inviter", metadata),
      metadata,
      columns: ["maiden_col", "dob_col"],
    };
    const result = validateAdvancedInvite(
      draft,
      seed,
      new Date("2026-06-20T00:00:00.000Z"),
    );
    expect(result.errors.keys).toBeDefined();
    expect(result.canGenerate).toBe(false);
  });

  test("seeding infers the date-of-birth input format from the rows, not the MM/DD/YYYY default", () => {
    // The advanced path always supplies an explicit standardization, so the exchange
    // no longer infers the date layout for it; the seed must, or an ISO-dated file
    // would be parsed as MM/DD/YYYY and under-match every dob key. Dashed dates with
    // a day past 12 parse only as YYYY-MM-DD, so the inference is unambiguous.
    const isoRows = [
      {
        ssn: "123456789",
        ssn4: "6789",
        first_name: "A",
        last_name: "B",
        dob: "1990-01-31",
      },
      {
        ssn: "987654321",
        ssn4: "4321",
        first_name: "C",
        last_name: "D",
        dob: "1985-12-25",
      },
    ];
    const { draft } = seedAdvancedInvite("Org", ALL_COLUMNS, isoRows);
    const dob = draft.standardization.find((t) => t.output === "date_of_birth");
    expect(dob?.steps).toContainEqual({
      function: "parse_date",
      params: { inputFormat: "YYYY-MM-DD", outputFormat: "YYYYMMDD" },
    });
  });

  test("the seeded default standardization yields the same terms as no standardization (guided path unchanged)", () => {
    // authoredLinkageFields over getDefaultStandardization reproduces the default
    // per-type field set, so seeding the draft with the recommended cleaning does
    // not move the terms the guided path would build.
    const { draft } = seedAdvancedInvite("Inviter", ALL_COLUMNS);
    const seeded = canonicalString(buildAdvancedTerms(draft));
    const empty = canonicalString(
      buildAdvancedTerms({ ...draft, standardization: [] }),
    );
    expect(seeded).toEqual(empty);
  });
});

describe("draftFromTerms reconstructs multi-field bindings on import", () => {
  // Two first_name columns (a maiden and a current name) and a date: enough for the
  // inviter to bind two distinct first_name fields. NAME_STEPS uppercases, so two
  // differing name columns yield two distinct cleaned values.
  const NAME_STEPS = [{ function: "to_upper_case" }];
  const metadata: Metadata = [
    {
      name: "maiden_col",
      type: "first_name",
      role: "linkage",
      isPayload: false,
    },
    {
      name: "current_col",
      type: "first_name",
      role: "linkage",
      isPayload: false,
    },
    {
      name: "dob_col",
      type: "date_of_birth",
      role: "linkage",
      isPayload: false,
    },
  ];
  const columns = ["maiden_col", "current_col", "dob_col"];
  const rawRows = [{ maiden_col: "Smith", current_col: "Jones", dob_col: "X" }];

  /** The exported terms a multi-field draft produces: two first_name fields bound
   * to distinct columns, each referenced by its own key. */
  function multiFieldDraft(): AdvancedInviteDraft {
    return {
      identity: "Inviter",
      lifetimeSeconds: 3600,
      outputDirection: "both",
      algorithm: "psi",
      deduplicate: false,
      metadata,
      standardization: [
        { output: "first_name", input: "maiden_col", steps: NAME_STEPS },
        { output: "first_name_2", input: "current_col", steps: NAME_STEPS },
      ],
      keys: [
        {
          key: { name: "maiden", elements: [{ field: "first_name" }] },
          enabled: true,
        },
        {
          key: { name: "current", elements: [{ field: "first_name_2" }] },
          enabled: true,
        },
      ],
    };
  }

  /** A fresh editor seed over the given columns, the import target. */
  function seedFor(forColumns: Array<string>, m: Metadata): AdvancedInviteSeed {
    return {
      terms: getDefaultLinkageTerms("Inviter", m),
      metadata: m,
      columns: forColumns,
    };
  }

  test("a two-fields-of-one-type document round-trips: both bindings and both distinct values are reconstructed", () => {
    const exported = buildAdvancedTerms(multiFieldDraft());
    // The export carries both declared fields (the binding itself is local and does
    // not travel), so this is the document an operator would re-import.
    expect(
      exported.linkageFields
        .filter((field) => field.type === "first_name")
        .map((field) => field.name),
    ).toEqual(["first_name", "first_name_2"]);

    const seed = seedFor(columns, metadata);
    const imported = draftFromTerms(exported, seed, 3600, rawRows);

    // The reconstructed standardization binds each first_name field to its OWN
    // column (the second to the next free one), not both to the first.
    const firstNameBindings = imported.standardization
      .filter((t) =>
        metadata.some((c) => c.name === t.input && c.type === "first_name"),
      )
      .map((t) => ({ output: t.output, input: t.input }));
    expect(firstNameBindings).toEqual([
      { output: "first_name", input: "maiden_col" },
      { output: "first_name_2", input: "current_col" },
    ]);

    // Both keys are satisfiable and the draft can generate again.
    const validation = validateAdvancedInvite(
      imported,
      seed,
      new Date("2026-06-20T00:00:00.000Z"),
    );
    expect(validation.errors.keys).toBeUndefined();
    expect(validation.canGenerate).toBe(true);

    // Each field reads its own column, so the two name columns produce distinct
    // values rather than the collapsed identical pair a one-field-per-type rebuild
    // would give.
    const prepared = prepareForExchange(
      {
        linkageTerms: buildAdvancedTerms(imported),
        metadata,
        standardization: imported.standardization,
      },
      "Inviter",
      rawRows,
      columns,
    );
    expect(prepared.dataset.getField("first_name")?.get(0)).toEqual(["SMITH"]);
    expect(prepared.dataset.getField("first_name_2")?.get(0)).toEqual([
      "JONES",
    ]);
  });

  test("reconstructing the local binding on import does not change the agreement (cross-party-hash invariant)", () => {
    // The import side rebuilds only the LOCAL standardization; the cross-party terms
    // -- field names/types/constraints and keys -- are reproduced byte-for-byte, so
    // the agreement and its receipt are unchanged. The import mirror of the
    // local-only invariance test above.
    const exported = buildAdvancedTerms(multiFieldDraft());
    const seed = seedFor(columns, metadata);
    const imported = draftFromTerms(exported, seed, 3600, rawRows);
    expect(canonicalString(buildAdvancedTerms(imported))).toEqual(
      canonicalString(exported),
    );
  });

  test("a field no column can supply stays unsatisfiable (fail-closed; never binds an absent column)", () => {
    // The importer's file has only ONE first_name column, so the second field's
    // binding cannot be reconstructed.
    const oneNameMetadata: Metadata = [
      {
        name: "maiden_col",
        type: "first_name",
        role: "linkage",
        isPayload: false,
      },
      {
        name: "dob_col",
        type: "date_of_birth",
        role: "linkage",
        isPayload: false,
      },
    ];
    const exported = buildAdvancedTerms(multiFieldDraft());
    const seed = seedFor(["maiden_col", "dob_col"], oneNameMetadata);
    const imported = draftFromTerms(exported, seed, 3600, []);

    // No binding was invented: first_name_2 has no transformation, and nothing binds
    // to a column the file does not have.
    expect(
      imported.standardization.some((t) => t.output === "first_name_2"),
    ).toBe(false);
    expect(
      imported.standardization.every((t) =>
        oneNameMetadata.some((c) => c.name === t.input),
      ),
    ).toBe(true);

    // The first_name field still binds; only the second-field key is unsatisfiable.
    expect(
      buildAdvancedTerms(imported).linkageFields.map((field) => field.name),
    ).toEqual(["first_name"]);
    const { satisfiableKeyCount } = assessLinkageSatisfiability(
      seed.columns,
      buildAdvancedTerms(imported),
      imported.standardization,
      imported.metadata,
    );
    expect(satisfiableKeyCount).toBe(1);
  });

  test("never reconstructs a binding to an ignored column", () => {
    // The second name column is present but role: ignored, so it must not back the
    // second field -- ignored means "never participates in linkage".
    const ignoredMetadata: Metadata = [
      {
        name: "maiden_col",
        type: "first_name",
        role: "linkage",
        isPayload: false,
      },
      {
        name: "current_col",
        type: "first_name",
        role: "ignored",
        isPayload: false,
      },
      {
        name: "dob_col",
        type: "date_of_birth",
        role: "linkage",
        isPayload: false,
      },
    ];
    const exported = buildAdvancedTerms(multiFieldDraft());
    const seed = seedFor(columns, ignoredMetadata);
    const imported = draftFromTerms(exported, seed, 3600, rawRows);
    expect(
      imported.standardization.some((t) => t.input === "current_col"),
    ).toBe(false);
    expect(
      imported.standardization.some((t) => t.output === "first_name_2"),
    ).toBe(false);
  });

  test("a single-field import reconstructs the seed's default standardization byte-for-byte", () => {
    // No multi-field fields means no extras, so the reconstruction is exactly the
    // default per-type standardization the import path has always opened on.
    const { draft, seed } = seedAdvancedInvite("Inviter", ALL_COLUMNS);
    const exported = buildAdvancedTerms(draft);
    const imported = draftFromTerms(exported, seed);
    expect(imported.standardization).toEqual(
      defaultStandardizationForRows(seed.metadata, seed.terms, []),
    );
    // And the round-trip preserves the agreement.
    expect(canonicalString(buildAdvancedTerms(imported))).toEqual(
      canonicalString(exported),
    );
  });
});
