import { describe, expect, test } from "vitest";

import {
  DEFAULT_LINKAGE_RULE_SET,
  MAX_INVITATION_LIFETIME_SECONDS,
  MAX_NAME_LENGTH,
  assertPayloadSendDisclosed,
  assessLinkageSatisfiability,
  authoredLinkageFields,
  canonicalString,
  deriveAcceptedLinkageTerms,
  getDefaultLinkageTerms,
  getDefaultStandardization,
  inferMetadata,
  linkageRuleSetReferenceFor,
  prepareForExchange,
  safeParseLinkageTerms,
  validateCompatibility,
  validateStandardizationAgainstTerms,
} from "@psilink/core";

import {
  addKey,
  buildAdvancedTerms,
  dateInputFormatForColumns,
  defaultStandardizationForRows,
  draftFromTerms,
  draftWithFieldAdded,
  draftWithKeyEnabled,
  gatedActiveSettingMessage,
  importedCitationDropCause,
  importedCitationDropNotice,
  importedConstraintDivergenceMessage,
  inviterExchangeDataSpec,
  outputForDirection,
  seedAdvancedInvite,
  setDraftMetadata,
  setDraftMetadataKeepingKeys,
  standardizationForTerms,
  validateAdvancedInvite,
} from "../../../src/psi/authoring/advancedInvite.js";
import {
  disclosedColumnNames,
  setColumnDisclosure,
  setColumnType,
} from "../../../src/psi/metadataEditing.js";

import type {
  AdvancedInviteDraft,
  AdvancedInviteSeed,
  OutputDirection,
} from "../../../src/psi/authoring/advancedInvite.js";

import type { LinkageTerms, Metadata } from "@psilink/core";

/** The names of the draft keys that reference an `ssn` field. */
function ssnKeyNames(draft: AdvancedInviteDraft): Array<string> {
  return draft.keys
    .filter((entry) => entry.key.elements.some((el) => el.field === "ssn"))
    .map((entry) => entry.key.name);
}

// Columns with every default linkage type, and a partial set missing ssn4
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

// Two columns of one semantic type (a maiden and a current name) and a date, so
// the inviter can bind each name column to its own field. MULTI_FIELD_NAME_STEPS
// uppercases, so a row whose two name columns differ yields two distinct cleaned
// values.
const MULTI_FIELD_NAME_STEPS = [{ function: "to_upper_case" }];
const multiFieldMetadata: Metadata = [
  { name: "maiden_col", type: "first_name", role: "linkage", isPayload: false },
  {
    name: "current_col",
    type: "first_name",
    role: "linkage",
    isPayload: false,
  },
  { name: "dob_col", type: "date_of_birth", role: "linkage", isPayload: false },
];
const multiFieldColumns = ["maiden_col", "current_col", "dob_col"];
const multiFieldRawRows = [
  { maiden_col: "Smith", current_col: "Jones", dob_col: "X" },
];

// A draft binding the two first_name columns to two distinct fields, each
// referenced by its own key -- what the workbench's "add another field" + the
// expert key editor produce, and the exported terms a re-import reconstructs.
function multiFieldDraft(): AdvancedInviteDraft {
  return {
    identity: "Inviter",
    lifetimeSeconds: 3600,
    outputDirection: "both",
    algorithm: "psi",
    deduplicate: false,
    linkageStrategy: "cascade",
    metadata: multiFieldMetadata,
    standardization: [
      {
        output: "first_name",
        input: "maiden_col",
        steps: MULTI_FIELD_NAME_STEPS,
      },
      {
        output: "first_name_2",
        input: "current_col",
        steps: MULTI_FIELD_NAME_STEPS,
      },
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

/** Set (or, with `null`, strip) a named field's constraints in a document -- a
 * hand-edit an external author could make that the editor has no control to
 * produce. Mutates a clone via a localized cast: the constraint shape is per-type
 * in the union, which the test deliberately violates to model an arbitrary input. */
function withFieldConstraints(
  terms: LinkageTerms,
  fieldName: string,
  constraints: Record<string, unknown> | null,
): LinkageTerms {
  const clone = structuredClone(terms);
  for (const field of clone.linkageFields) {
    if (field.name !== fieldName) continue;
    if (constraints === null)
      delete (field as { constraints?: unknown }).constraints;
    else (field as { constraints?: unknown }).constraints = constraints;
  }
  return clone;
}

// Columns for the four default-constrained types plus a date, hand-built so a test
// does not lean on inferMetadata's column-name heuristics.
const constrainedMetadata: Metadata = [
  { name: "ssn_col", type: "ssn", role: "linkage", isPayload: false },
  { name: "ssn4_col", type: "ssn4", role: "linkage", isPayload: false },
  { name: "fn_col", type: "first_name", role: "linkage", isPayload: false },
  { name: "ln_col", type: "last_name", role: "linkage", isPayload: false },
  {
    name: "dob_col",
    type: "date_of_birth",
    role: "linkage",
    isPayload: false,
  },
];
const constrainedColumns = [
  "ssn_col",
  "ssn4_col",
  "fn_col",
  "ln_col",
  "dob_col",
];
const constrainedRawRows = [
  {
    ssn_col: "123456789",
    ssn4_col: "6789",
    fn_col: "A",
    ln_col: "B",
    dob_col: "01/01/2000",
  },
];

/** A fresh editor seed over those columns -- the import target. */
function constrainedSeed(): AdvancedInviteSeed {
  return {
    terms: getDefaultLinkageTerms("Inviter", constrainedMetadata),
    metadata: constrainedMetadata,
    columns: constrainedColumns,
  };
}

/** The default document the editor exports for those columns: the same draft shape
 * seedAdvancedInvite builds, so its fields have exactly the type-default
 * constraints a rebuild re-stamps, in the canonical DEFAULT_LINKAGE_FIELDS order.
 * The round-trip-faithful baseline a divergence refusal must NOT trip. */
function constrainedDefaultExport(): LinkageTerms {
  const terms = getDefaultLinkageTerms("Inviter", constrainedMetadata);
  return buildAdvancedTerms({
    identity: "Inviter",
    lifetimeSeconds: 3600,
    outputDirection: "both",
    algorithm: "psi",
    deduplicate: false,
    linkageStrategy: "cascade",
    metadata: constrainedMetadata,
    standardization: defaultStandardizationForRows(
      constrainedMetadata,
      terms,
      constrainedRawRows,
    ),
    keys: terms.linkageKeys.map((key) => ({ key, enabled: true })),
  });
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
    // is smaller than the all-columns one.
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

  test("standardizationForTerms drops a disabled key's orphaned transformation", () => {
    // Regression: disabling every ssn4 key drops the ssn4 field from the emitted
    // terms (buildAdvancedTerms), but the draft's standardization keeps the ssn4
    // transformation so re-enabling would restore its cleaning. Feeding that
    // unfiltered pair into the inviter's own prepareForExchange fails closed on an
    // authoritative standardization whose output names no linkage field.
    const { draft } = seedAdvancedInvite("Org", ALL_COLUMNS);
    const withoutSsn4Keys = {
      ...draft,
      keys: draft.keys.map((entry) => ({
        ...entry,
        enabled: !entry.key.elements.some((e) => e.field === "ssn4"),
      })),
    };
    const terms = buildAdvancedTerms(withoutSsn4Keys);
    // The emitted terms no longer declare ssn4, yet the draft still has its
    // (now inert) transformation -- the inconsistency the fix reconciles.
    expect(terms.linkageFields.some((f) => f.name === "ssn4")).toBe(false);
    expect(
      withoutSsn4Keys.standardization.some((t) => t.output === "ssn4"),
    ).toBe(true);
    expect(
      validateStandardizationAgainstTerms(
        withoutSsn4Keys.standardization,
        terms,
      ).length,
    ).toBeGreaterThan(0);

    // Reconciled to the emitted terms, every remaining output names a declared
    // field, so the pairing is consistent and the inviter's exchange prepares.
    const reconciled = standardizationForTerms(
      withoutSsn4Keys.standardization,
      terms,
    );
    expect(reconciled.some((t) => t.output === "ssn4")).toBe(false);
    expect(validateStandardizationAgainstTerms(reconciled, terms)).toEqual([]);

    // End to end: the reconciled spec prepares, the raw draft spec fails closed.
    const rows = [
      {
        ssn: "123456789",
        ssn4: "6789",
        first_name: "Ada",
        last_name: "Lovelace",
        dob: "2000-01-01",
      },
    ];
    expect(() =>
      prepareForExchange(
        {
          linkageTerms: terms,
          metadata: withoutSsn4Keys.metadata,
          standardization: reconciled,
        },
        "Org",
        rows,
        ALL_COLUMNS,
      ),
    ).not.toThrow();
    expect(() =>
      prepareForExchange(
        {
          linkageTerms: terms,
          metadata: withoutSsn4Keys.metadata,
          standardization: withoutSsn4Keys.standardization,
        },
        "Org",
        rows,
        ALL_COLUMNS,
      ),
    ).toThrow(/ssn4/);
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

describe("inviterExchangeDataSpec", () => {
  test("reconciles the authored standardization to the emitted terms", () => {
    // The structural enforcement point: disabling every ssn4 key drops ssn4 from
    // the emitted terms while the draft keeps its (now orphaned) transformation.
    // The spec builder reconciles at assembly, so the spec handed to
    // prepareForExchange is self-consistent regardless of how the caller produced
    // the standardization.
    const { draft } = seedAdvancedInvite("Org", ALL_COLUMNS);
    const withoutSsn4Keys = {
      ...draft,
      keys: draft.keys.map((entry) => ({
        ...entry,
        enabled: !entry.key.elements.some((e) => e.field === "ssn4"),
      })),
    };
    const terms = buildAdvancedTerms(withoutSsn4Keys);
    expect(
      withoutSsn4Keys.standardization.some((t) => t.output === "ssn4"),
    ).toBe(true);
    expect(terms.linkageFields.some((f) => f.name === "ssn4")).toBe(false);

    const spec = inviterExchangeDataSpec(terms, {
      metadata: withoutSsn4Keys.metadata,
      standardization: withoutSsn4Keys.standardization,
    });

    // The orphan is dropped, so the assembled spec passes the same consistency
    // check prepareForExchange fails closed on.
    expect(spec.standardization?.some((t) => t.output === "ssn4")).toBe(false);
    expect(
      validateStandardizationAgainstTerms(spec.standardization ?? [], terms),
    ).toEqual([]);
    expect(spec.metadata).toBe(withoutSsn4Keys.metadata);
    expect(spec.linkageTerms).toBe(terms);

    // End to end: prepareForExchange accepts the assembled spec (it would have
    // thrown on the raw draft standardization).
    const rows = [
      {
        ssn: "123456789",
        ssn4: "6789",
        first_name: "Ada",
        last_name: "Lovelace",
        dob: "2000-01-01",
      },
    ];
    expect(() =>
      prepareForExchange(spec, "Org", rows, ALL_COLUMNS),
    ).not.toThrow();
  });

  test("omits metadata and standardization on the quick path (none authored)", () => {
    const { draft } = seedAdvancedInvite("Org", ALL_COLUMNS);
    const terms = buildAdvancedTerms(draft);
    const spec = inviterExchangeDataSpec(terms);
    expect("metadata" in spec).toBe(false);
    expect("standardization" in spec).toBe(false);
    expect(spec.linkageTerms).toBe(terms);
  });
});

describe("setDraftMetadata re-derives offerable keys", () => {
  const COLS = ["first_name", "last_name", "dob", "extra"];

  test("retyping then rolling a column for matching adds the keys its type makes offerable", () => {
    // No ssn column: no ssn-referencing key is offerable.
    const { draft } = seedAdvancedInvite("Org", COLS);
    expect(ssnKeyNames(draft)).toEqual([]);

    // Remap `extra` -> ssn alone: a type change keeps its inferred `payload`
    // disclosure (a sent column stays sent), and a payload column is not matched,
    // so no ssn key is offerable yet -- matching participation is the explicit
    // `linkage` role, not the type alone.
    const retyped = setColumnType(draft.metadata, "extra", "ssn").metadata;
    expect(ssnKeyNames(setDraftMetadata(draft, retyped))).toEqual([]);

    // Rolling `extra` for matching (role: linkage) makes its ssn keys offerable.
    const matched = setColumnDisclosure(retyped, "extra", "match").metadata;
    const next = setDraftMetadata(draft, matched);
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
    // Disable the first key, then remap+roll `extra` to add ssn keys (which does
    // not drop any existing key, since no default key references the `other`-typed
    // `extra`). The type change keeps `payload`; rolling it `match` (role: linkage)
    // is what makes its keys offerable.
    const firstName = draft.keys[0].key.name;
    const withDisabled: AdvancedInviteDraft = {
      ...draft,
      keys: draft.keys.map((entry, i) =>
        i === 0 ? { ...entry, enabled: false } : entry,
      ),
    };
    const matched = setColumnDisclosure(
      setColumnType(withDisabled.metadata, "extra", "ssn").metadata,
      "extra",
      "match",
    ).metadata;
    const next = setDraftMetadata(withDisabled, matched);
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

  test("re-rolling a column off linkage drops its standardization transformation", () => {
    // first_name seeds as role: linkage with a default cleaning transform. Re-rolling
    // it to payload (sent, not matched) drops that transform on reconcile, since
    // matching participation requires role: linkage -- a stale transform must not
    // clean a column the core would no longer bind.
    const { draft } = seedAdvancedInvite("Org", COLS);
    expect(draft.standardization.some((t) => t.input === "first_name")).toBe(
      true,
    );
    const repurposed = setColumnDisclosure(
      draft.metadata,
      "first_name",
      "payload",
    ).metadata;
    const next = setDraftMetadata(draft, repurposed);
    expect(next.standardization.some((t) => t.input === "first_name")).toBe(
      false,
    );
  });

  test("retyping a column between two linkage types re-derives its cleaning", () => {
    // The first_name column seeds a first_name-named transformation cleaned with
    // the name pipeline. Retyping it to ssn (a distinct linkage type with a
    // distinct pipeline, and no other ssn column present) must drop that stale
    // transformation and re-derive the ssn default, so the column's committed
    // cleaning and field type follow its new type rather than lingering as a
    // first_name-named field typed ssn.
    const { draft } = seedAdvancedInvite("Org", COLS);
    const seeded = draft.standardization.find((t) => t.input === "first_name");
    expect(seeded?.output).toBe("first_name");

    const retyped = setColumnType(draft.metadata, "first_name", "ssn").metadata;
    const next = setDraftMetadata(draft, retyped);

    const rederived = next.standardization.find(
      (t) => t.input === "first_name",
    );
    expect(rederived?.output).toBe("ssn");
    // The stale name-typed field name is gone, so the built terms declare the
    // column as ssn, not as a first_name-named field typed ssn.
    expect(
      next.standardization.some(
        (t) => t.output === "first_name" && t.input === "first_name",
      ),
    ).toBe(false);
    const fields = authoredLinkageFields(next.metadata, next.standardization);
    expect(
      fields.some((f) => f.name === "first_name" && f.type === "ssn"),
    ).toBe(false);
    expect(fields.some((f) => f.name === "ssn" && f.type === "ssn")).toBe(true);
  });

  test("retyping between two name types commits no name/type-mismatched field", () => {
    // Retyping the first_name column to last_name: both share the name pipeline, so
    // a step comparison would miss the change. A last_name column is already
    // present, so the retyped column's type is covered and its stale first_name
    // transformation clears rather than re-deriving a second field -- either way no
    // first_name-named field typed last_name reaches the committed terms.
    const { draft } = seedAdvancedInvite("Org", COLS);
    const retyped = setColumnType(
      draft.metadata,
      "first_name",
      "last_name",
    ).metadata;
    const next = setDraftMetadata(draft, retyped);

    expect(
      next.standardization.some(
        (t) => t.output === "first_name" && t.input === "first_name",
      ),
    ).toBe(false);
    const terms = buildAdvancedTerms(next);
    expect(
      terms.linkageFields.some(
        (f) => f.name === "first_name" && f.type === "last_name",
      ),
    ).toBe(false);
    expect(terms.linkageFields.some((f) => f.name === "first_name")).toBe(
      false,
    );
  });

  test("a non-type metadata edit re-derives byte-identical standardization", () => {
    // Guard the byte-identity criterion: an edit that does NOT change any column's
    // type (here toggling extra's disclosure) leaves every kept transformation's
    // type in agreement with its column, so the reconcile drops nothing new and
    // reproduces the standardization unchanged.
    const { draft } = seedAdvancedInvite("Org", COLS);
    const toggled = setColumnDisclosure(
      draft.metadata,
      "extra",
      "ignored",
    ).metadata;
    const next = setDraftMetadata(draft, toggled);
    expect(next.standardization).toStrictEqual(draft.standardization);
  });

  test("a non-type edit keeps an imported field whose name mismatches its type", () => {
    // An imported field's name and type are independent (the schema names and types
    // fields separately), so an operator can import a second first_name field NAMED
    // `ssn_2`. A non-type edit (toggling extra's disclosure) must not read the type
    // out of that name and drop the still-first_name binding: the reconcile compares
    // each column's type across the edit, and this column's type did not change, so
    // its transformation and its authored name-pipeline cleaning both survive.
    const metadata: Metadata = [
      { name: "fn_a", type: "first_name", role: "linkage", isPayload: false },
      { name: "fn_b", type: "first_name", role: "linkage", isPayload: false },
      {
        name: "dob_col",
        type: "date_of_birth",
        role: "linkage",
        isPayload: false,
      },
      { name: "extra", type: "other", role: "payload", isPayload: true },
    ];
    const columns = ["fn_a", "fn_b", "dob_col", "extra"];
    const seed: AdvancedInviteSeed = {
      terms: getDefaultLinkageTerms("Org", metadata),
      metadata,
      columns,
    };
    const nameConstraints = {
      affixesAllowed: false,
      allowedCharacters: "A-Z ",
    };
    const imported: LinkageTerms = {
      ...getDefaultLinkageTerms("Org", metadata),
      linkageFields: [
        {
          name: "first_name",
          type: "first_name",
          constraints: nameConstraints,
        },
        { name: "ssn_2", type: "first_name", constraints: nameConstraints },
        { name: "date_of_birth", type: "date_of_birth" },
      ],
      linkageKeys: [
        {
          name: "K",
          elements: [{ field: "ssn_2" }, { field: "date_of_birth" }],
        },
      ],
    };
    const draft = draftFromTerms(imported, seed);
    const before = draft.standardization.find((t) => t.output === "ssn_2");
    expect(before).toBeDefined();

    const toggled = setColumnDisclosure(
      draft.metadata,
      "extra",
      "ignored",
    ).metadata;
    const next = setDraftMetadata(draft, toggled);
    const after = next.standardization.find((t) => t.output === "ssn_2");
    expect(after).toStrictEqual(before);
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

  test("(c) blocks Generate when only SOME enabled keys are column-satisfiable", () => {
    // An exchange runs every key its terms declare, so an editor that minted here
    // would hand out an invitation the inviter's own run refuses -- after the
    // partner has accepted it. The keys the columns DO cover are what a per-key
    // threshold would have passed on.
    const { draft, seed } = seedAdvancedInvite("Org", ALL_COLUMNS);
    const result = validateAdvancedInvite(
      draft,
      { ...seed, columns: PARTIAL_COLUMNS },
      NOW,
    );
    expect(result.canGenerate).toBe(false);
    expect(result.errors.keys).toContain(
      "These terms cannot be run against your file",
    );
    // The shortfall wording is core's shared fragment, counts only.
    expect(result.errors.keys).toContain(
      "cannot be produced from this input's columns",
    );
  });

  test("(c) blocks Generate on a dead-key-only shortfall with the cleaning remedy", () => {
    // Shape-satisfiable and still refused: every element field resolves, but the
    // key's declared parse_date can never yield a value. The columns are fine, so
    // the remedy is the cleaning rather than the column mapping -- the split the
    // acceptor's launch gate keeps.
    const { draft, seed } = seedAdvancedInvite("Org", ALL_COLUMNS);
    const onlyDobKey = onlyKeyEnabled(draft, "SSN + LN + DOB");
    const deadDraft = {
      ...onlyDobKey,
      keys: onlyDobKey.keys.map((entry) =>
        entry.key.name === "SSN + LN + DOB"
          ? {
              ...entry,
              key: {
                ...entry.key,
                elements: entry.key.elements.map((element) =>
                  element.field === "date_of_birth"
                    ? {
                        ...element,
                        transform: [
                          {
                            function: "parse_date",
                            params: { inputFormat: "MM/DD" },
                          },
                        ],
                      }
                    : element,
                ),
              },
            }
          : entry,
      ),
    };
    const result = validateAdvancedInvite(deadDraft, seed, NOW);
    expect(result.canGenerate).toBe(false);
    // The editor's terms are the inviter's own draft, so the shared fragment
    // counts the keys without calling them agreed: nobody has agreed to anything
    // until Generate hands them out.
    expect(result.errors.keys).toContain(
      "the cleaning declared for the one linkage key drops every record",
    );
    expect(result.errors.keys).toContain(
      'Review the cleaning on the keys badged "won\'t match"',
    );
    // The column-mapping remedy would misdirect here: the columns produce every
    // field this key references.
    expect(result.errors.keys).not.toContain("map a column to");
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

  test("(c) blocks Generate on a malformed cleaning step, against the standardization control", () => {
    // The launch gate that catches ungated raw-pattern authoring: a step left
    // mid-edit (here a filter_regex with no pattern) must block Generate via
    // errors.standardization, so a malformed pattern never reaches the exchange,
    // where core would run it as a silent full-field exclusion or throw at compile.
    const { draft, seed } = seedAdvancedInvite("Org", ALL_COLUMNS);
    const withBadStep: AdvancedInviteDraft = {
      ...draft,
      standardization: draft.standardization.map((transformation, i) =>
        i === 0
          ? { ...transformation, steps: [{ function: "filter_regex" }] }
          : transformation,
      ),
    };
    const blocked = validateAdvancedInvite(withBadStep, seed, NOW);
    expect(blocked.canGenerate).toBe(false);
    expect(blocked.errors.standardization).toBeDefined();
    expect(blocked.terms).toBeUndefined();

    // The gate keys on step validity, not on the presence of a raw pattern: a
    // well-formed, in-dialect pattern is accepted on the same ungated path, so
    // completing the step clears errors.standardization and unblocks Generate.
    const withValidStep: AdvancedInviteDraft = {
      ...draft,
      standardization: draft.standardization.map((transformation, i) =>
        i === 0
          ? {
              ...transformation,
              steps: [
                { function: "filter_regex", params: { pattern: "[A-Z]" } },
              ],
            }
          : transformation,
      ),
    };
    const ok = validateAdvancedInvite(withValidStep, seed, NOW);
    expect(ok.errors.standardization).toBeUndefined();
    expect(ok.canGenerate).toBe(true);
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

describe("the linkage-strategy control", () => {
  test("(a) an unedited draft authors cascade, byte-identical to before the control", () => {
    const { draft } = seedAdvancedInvite("Org", ALL_COLUMNS);
    // The draft seeds from the default terms' strategy, and the build passes it
    // through, so a draft no one touched still authors cascade.
    expect(draft.linkageStrategy).toBe("cascade");
    expect(buildAdvancedTerms(draft).linkageStrategy).toBe("cascade");
  });

  test("(b) selecting single-pass flows straight through into the built terms", () => {
    const { draft } = seedAdvancedInvite("Org", ALL_COLUMNS);
    const built = buildAdvancedTerms({
      ...draft,
      linkageStrategy: "single-pass",
    });
    // Written straight through -- not clamped like deduplicate/fuzzyComparisons --
    // and the built terms still parse through the core schema.
    expect(built.linkageStrategy).toBe("single-pass");
    expect(safeParseLinkageTerms(built).success).toBe(true);
  });

  test("(c) single-pass round-trips through export -> import and is not refused as gated", () => {
    const { draft, seed } = seedAdvancedInvite("Org", ALL_COLUMNS);
    const exported = buildAdvancedTerms({
      ...draft,
      linkageStrategy: "single-pass",
    });
    // Unlike a gated deduplicate/fuzzyComparisons setting, an imported single-pass
    // document is adopted rather than refused: single-pass is honored end-to-end,
    // so it has no gatedActiveSettingMessage. This is the lie-proof encoding of
    // "not gated".
    expect(gatedActiveSettingMessage(exported)).toBeUndefined();
    const imported = draftFromTerms(exported, seed);
    expect(imported.linkageStrategy).toBe("single-pass");
    // Re-building the imported draft preserves the strategy, so an export round-trips
    // it.
    expect(buildAdvancedTerms(imported).linkageStrategy).toBe("single-pass");
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
    // The three are distinct, so the control offers three different pairs.
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

describe("payload authoring", () => {
  // "notes" and "comments" infer as `other` columns -> disclosed (sent) by default;
  // the linkage columns are not.
  const PAYLOAD_COLUMNS = [...ALL_COLUMNS, "notes", "comments"];

  test("terms.payload.send is exactly the disclosed columns; receive is never authored", () => {
    const { draft } = seedAdvancedInvite("Org", PAYLOAD_COLUMNS);
    const disclosed = disclosedColumnNames(draft.metadata);
    expect(disclosed).toEqual(["notes", "comments"]);
    const built = buildAdvancedTerms(draft);
    expect(built.payload?.send?.map((c) => c.name)).toEqual(disclosed);
    // The inviter does not know the partner's schema, so it authors no receive and
    // takes whatever the partner discloses (validateCompatibility is lazy on it).
    expect(built.payload?.receive).toBeUndefined();
  });

  test("payload.send never over-declares: it is a subset of the disclosed set, and core's reject agrees", () => {
    // Disclose one linkage column explicitly; the rest stay not-sent.
    const { draft } = seedAdvancedInvite("Org", PAYLOAD_COLUMNS);
    const metadata = setColumnDisclosure(
      draft.metadata,
      "last_name",
      "payload",
    ).metadata;
    const built = buildAdvancedTerms({ ...draft, metadata });
    const disclosed = new Set(disclosedColumnNames(metadata));
    for (const column of built.payload?.send ?? [])
      expect(disclosed.has(column.name)).toBe(true);
    // A not-disclosed linkage column is never placed into send.
    expect(built.payload?.send?.some((c) => c.name === "ssn")).toBe(false);
    // The exact core reject this guard keeps the operator clear of accepts the
    // editor's send against the same metadata, in the direction the editor built.
    expect(() =>
      assertPayloadSendDisclosed(built.payload, metadata, built.output),
    ).not.toThrow();
  });

  test("the editor never authors payload.receive, so receive-while-no-output is unrepresentable", () => {
    // The one combination the schema forbids (a non-empty receive with
    // expectsOutput false) cannot be expressed through the guided editor, in any
    // output direction, because the editor authors no receive at all.
    const { draft } = seedAdvancedInvite("Org", PAYLOAD_COLUMNS);
    for (const direction of ["both", "inviter", "partner"] as const)
      expect(
        buildAdvancedTerms({ ...draft, outputDirection: direction }).payload
          ?.receive,
      ).toBeUndefined();
  });

  test("sending while only the inviter receives is blocked live and the acceptor cannot derive it", () => {
    const { draft, seed } = seedAdvancedInvite("Org", PAYLOAD_COLUMNS);
    const inviterOnly = { ...draft, outputDirection: "inviter" as const };
    const result = validateAdvancedInvite(inviterOnly, seed);
    expect(result.errors.payload).toBeDefined();
    expect(result.canGenerate).toBe(false);
    // The live block mirrors the schema reject the acceptor would otherwise hit.
    expect(() =>
      deriveAcceptedLinkageTerms(buildAdvancedTerms(inviterOnly), "Acceptor"),
    ).toThrow();
    // Sharing the result with the partner ("both") clears the conflict.
    expect(
      validateAdvancedInvite({ ...draft, outputDirection: "both" }, seed).errors
        .payload,
    ).toBeUndefined();
  });

  test("a schema payload error is reported even behind the direction conflict, not masked", () => {
    // A disclosed (sent) column whose name exceeds the schema's MAX_NAME_LENGTH is a
    // payload-path schema failure; choosing inviter-only output while disclosing
    // columns is the direction conflict. Both attach to the payload control, where a
    // first-message-wins guard would otherwise drop the schema error behind the (more
    // common) direction conflict -- hiding a second obstacle that still blocks Generate.
    const overLong = "x".repeat(MAX_NAME_LENGTH + 1);
    // The over-long header infers as an `other` column, disclosed (sent) by default.
    const { draft, seed } = seedAdvancedInvite("Org", [
      ...ALL_COLUMNS,
      overLong,
    ]);
    expect(disclosedColumnNames(draft.metadata)).toContain(overLong);

    // Single-problem baselines, so the both-problems assertion compares against the
    // actual messages rather than hard-coding the copy.
    // (1) Schema-payload-error only: output shared, so no direction conflict.
    const schemaOnly = validateAdvancedInvite(
      { ...draft, outputDirection: "both" },
      seed,
    );
    const schemaMessage = schemaOnly.errors.payload ?? "";
    expect(schemaMessage.length).toBeGreaterThan(0);
    expect(schemaOnly.canGenerate).toBe(false);

    // (2) Direction-conflict only: a normally-named disclosed column, inviter-only.
    const conflict = seedAdvancedInvite("Org", [...ALL_COLUMNS, "notes"]);
    const conflictOnly = validateAdvancedInvite(
      { ...conflict.draft, outputDirection: "inviter" },
      conflict.seed,
    );
    const directionMessage = conflictOnly.errors.payload ?? "";
    expect(directionMessage.length).toBeGreaterThan(0);
    expect(conflictOnly.canGenerate).toBe(false);

    // The single-problem cases stay clean: neither has the other's message.
    expect(schemaMessage).not.toContain(directionMessage);
    expect(directionMessage).not.toContain(schemaMessage);

    // (3) Both problems at once: the payload message reports BOTH, so the schema
    // error is no longer masked by the direction conflict. They are newline-separated
    // (the editor renders them as a stacked list) with the more-persistent schema
    // error leading -- it is the obstacle that remains after the one-click direction
    // choice is reversed.
    const both = validateAdvancedInvite(
      { ...draft, outputDirection: "inviter" },
      seed,
    );
    const bothMessage = both.errors.payload ?? "";
    expect(bothMessage.split("\n")).toEqual([schemaMessage, directionMessage]);
    expect(both.canGenerate).toBe(false);
  });

  test("a disclosed-payload invitation round-trips through the acceptor mirror", () => {
    const { draft } = seedAdvancedInvite("Org", PAYLOAD_COLUMNS);
    const built = buildAdvancedTerms(draft); // both-receive, sends notes+comments
    const acceptor = deriveAcceptedLinkageTerms(built, "Acceptor");
    // The acceptor's receive is the inviter's send (validated exactly); its send
    // stays open (the inviter's absent receive), so it is not forced to declare one.
    expect(acceptor.payload).toStrictEqual({ receive: built.payload?.send });
    expect(acceptor.payload?.send).toBeUndefined();
    expect(validateCompatibility(built, acceptor).errors).toEqual([]);
    expect(validateCompatibility(acceptor, built).errors).toEqual([]);
  });
});

describe("inviter standardization: per-field column binding and multi-field", () => {
  const NAME_STEPS = MULTI_FIELD_NAME_STEPS;
  const metadata = multiFieldMetadata;
  const columns = multiFieldColumns;
  const rawRows = multiFieldRawRows;

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
    // party's local standardization -- the cross-party LinkageTerms hold the field
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
      linkageStrategy: "cascade",
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
    // The file has maiden_col but not current_col (the second field's column).
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

  test("a seed from (columns + pre-inferred format) deep-equals one from full rows", () => {
    // The console has no rows: it seeds from the columns plus the date format its
    // server-side profile inferred. That must reproduce the hosted seed byte for byte,
    // since the rows feed the model only through that one inferred value.
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
    const format = dateInputFormatForColumns(ALL_COLUMNS, isoRows);
    expect(format).toBe("YYYY-MM-DD");
    expect(seedAdvancedInvite("Org", ALL_COLUMNS, [], format)).toEqual(
      seedAdvancedInvite("Org", ALL_COLUMNS, isoRows),
    );
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
  const metadata = multiFieldMetadata;
  const columns = multiFieldColumns;
  const rawRows = multiFieldRawRows;

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
    // The export has both declared fields (the binding itself is local and does
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
    // the agreement and its receipt are unchanged. Scope: this covers terms the
    // editor itself produced. An externally-authored document with custom field
    // constraints is refused at the import door (see the
    // importedConstraintDivergenceMessage tests below); field order and
    // declared-but-unreferenced fields are preserved on rebuild (see the "import
    // round-trip preserves field order" tests below), not exercised here.
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

  // The consent restriction's negative arm: an imported document (which is
  // attacker-influenceable -- any schema-valid document is accepted) can declare an
  // extra same-typed field, but the reconstruction binds it only to a column the
  // operator marked for matching (`role: linkage`), never one they roled `identifier`
  // (row-identifier) or `payload` (sent-to-partner). The positive arm -- a
  // `role: linkage` second column still binds and generates unchanged -- is the
  // round-trip test above (current_col is `linkage` there). "Member 007" is the value
  // the confirmed first_name_2 -> identifier column case hashed into a key; these
  // assert it is no longer pulled in.
  test.each(["identifier", "payload"] as const)(
    "never reconstructs an extra binding to a role: %s column; its value is not pulled into a key",
    (blockedRole) => {
      // The second first_name-typed column is present and non-ignored but roled
      // identifier/payload, so it must not back the import-declared second field.
      const blockedMetadata: Metadata = [
        {
          name: "maiden_col",
          type: "first_name",
          role: "linkage",
          isPayload: false,
        },
        {
          name: "current_col",
          type: "first_name",
          role: blockedRole,
          isPayload: blockedRole === "payload",
        },
        {
          name: "dob_col",
          type: "date_of_birth",
          role: "linkage",
          isPayload: false,
        },
      ];
      const blockedRows = [
        { maiden_col: "Smith", current_col: "Member 007", dob_col: "X" },
      ];
      const exported = buildAdvancedTerms(multiFieldDraft());
      const seed = seedFor(columns, blockedMetadata);
      const imported = draftFromTerms(exported, seed, 3600, blockedRows);

      // The binding is restricted, not silently established: first_name_2 gets no
      // transformation, and nothing binds the identifier/payload column.
      expect(
        imported.standardization.some((t) => t.output === "first_name_2"),
      ).toBe(false);
      expect(
        imported.standardization.some((t) => t.input === "current_col"),
      ).toBe(false);

      // The identifier/payload column's cleaned value ("MEMBER 007") is never pulled
      // into a key: the run declares no first_name_2 field, and the one name field it
      // does build reads maiden_col ("SMITH"), not current_col.
      const built = buildAdvancedTerms(imported);
      const prepared = prepareForExchange(
        {
          linkageTerms: built,
          metadata: blockedMetadata,
          standardization: imported.standardization,
        },
        "Inviter",
        blockedRows,
        columns,
      );
      expect(prepared.dataset.getField("first_name_2")).toBeUndefined();
      expect(prepared.dataset.getField("first_name")?.get(0)).toEqual([
        "SMITH",
      ]);

      // Fail-closed: the key that referenced the unbound second field cannot generate,
      // while the first-name key still can. The operator re-establishes the second
      // binding deliberately -- in the workbench, or by roling the column `linkage` --
      // rather than having the import do it for them.
      const { satisfiableKeyCount } = assessLinkageSatisfiability(
        seed.columns,
        built,
        imported.standardization,
        blockedMetadata,
      );
      expect(satisfiableKeyCount).toBe(1);
    },
  );

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

describe("draftFromTerms binds an imported field of a type no built-in key uses", () => {
  // The opt-in matchable types (phone_number, email_address, zip_code) have no
  // default field, so a document declaring one names it whatever its author chose.
  // The inviter's own columns must still supply it: the reconstruction reads the
  // document's field NAMES, and nothing may claim the column ahead of them.
  const NOW = new Date("2026-06-20T00:00:00.000Z");

  /** `role: linkage` columns of the given names and types, the shape both the
   * document's author and the importing inviter are described by here. */
  function linkageColumns(
    columns: Array<[string, Metadata[number]["type"]]>,
  ): Metadata {
    return columns.map(([name, type]) => ({
      name,
      type,
      role: "linkage",
      isPayload: false,
    }));
  }

  /** A fresh editor seed over the given metadata, the import target. */
  function seedFor(m: Metadata): AdvancedInviteSeed {
    return {
      terms: getDefaultLinkageTerms("Inviter", m),
      metadata: m,
      columns: m.map((column) => column.name),
    };
  }

  /**
   * A document whose phone fields have the author's own names rather than the
   * bare type. `phoneFields` names one per author-side phone column; a `last_name`
   * field and key ride along so the document also has a built-in key.
   */
  function phoneDocument(phoneFields: Array<string>): LinkageTerms {
    const authorMetadata = linkageColumns([
      ...phoneFields.map((_, index): [string, Metadata[number]["type"]] => [
        `author_phone_${index + 1}`,
        "phone_number",
      ]),
      ["author_surname", "last_name"],
    ]);
    return buildAdvancedTerms({
      identity: "Author",
      lifetimeSeconds: 3600,
      outputDirection: "both",
      algorithm: "psi",
      deduplicate: false,
      linkageStrategy: "cascade",
      metadata: authorMetadata,
      standardization: [
        ...phoneFields.map((output, index) => ({
          output,
          input: `author_phone_${index + 1}`,
          steps: [],
        })),
        { output: "last_name", input: "author_surname", steps: [] },
      ],
      keys: [
        ...phoneFields.map((field) => ({
          key: { name: field.toUpperCase(), elements: [{ field }] },
          enabled: true,
        })),
        {
          key: { name: "NAME", elements: [{ field: "last_name" }] },
          enabled: true,
        },
      ],
    });
  }

  /** Each transformation binding one of `metadata`'s phone columns, in order. */
  function phoneBindings(
    standardization: AdvancedInviteDraft["standardization"],
    metadata: Metadata,
  ): Array<{ output: string; input: string }> {
    return standardization
      .filter((t) =>
        metadata.some((c) => c.name === t.input && c.type === "phone_number"),
      )
      .map((t) => ({ output: t.output, input: t.input }));
  }

  test("the document names it cell_phone; the inviter's only phone column supplies it", () => {
    const document = phoneDocument(["cell_phone"]);
    expect(document.linkageFields).toContainEqual({
      name: "cell_phone",
      type: "phone_number",
    });

    const metadata = linkageColumns([
      ["phone_col", "phone_number"],
      ["last_col", "last_name"],
    ]);
    const rawRows = [{ phone_col: "(312) 555-0142", last_col: "Alvarez" }];
    const seed = seedFor(metadata);
    const imported = draftFromTerms(document, seed, 3600, rawRows);

    expect(phoneBindings(imported.standardization, metadata)).toEqual([
      { output: "cell_phone", input: "phone_col" },
    ]);

    // Declarable, so the key referencing it is supplyable and arrives enabled
    // alongside the built-in one -- not disabled as unsatisfiable.
    expect(
      imported.keys.map((entry) => [entry.key.name, entry.enabled]),
    ).toEqual([
      ["CELL_PHONE", true],
      ["NAME", true],
    ]);
    const built = buildAdvancedTerms(imported);
    expect(built.linkageFields).toContainEqual({
      name: "cell_phone",
      type: "phone_number",
    });
    const validation = validateAdvancedInvite(imported, seed, NOW);
    expect(validation.errors.keys).toBeUndefined();
    expect(validation.canGenerate).toBe(true);

    // It matches through its type's pipeline, and through the SAME pipeline the
    // accepting party derives from these terms -- two parties cleaning one field
    // differently match almost nothing.
    const prepared = prepareForExchange(
      {
        linkageTerms: built,
        metadata,
        standardization: imported.standardization,
      },
      "Inviter",
      rawRows,
      seed.columns,
    );
    expect(prepared.dataset.getField("cell_phone")?.get(0)).toEqual([
      "3125550142",
    ]);
    const stepsFor = (standardization: typeof imported.standardization) =>
      standardization.find((t) => t.output === "cell_phone")?.steps;
    expect(stepsFor(imported.standardization)).toEqual(
      stepsFor(
        getDefaultStandardization(
          metadata,
          deriveAcceptedLinkageTerms(built, "Acceptor"),
        ),
      ),
    );
    expect(stepsFor(imported.standardization)).not.toEqual([]);
  });

  test("with two phone columns it takes the first and leaves the second free", () => {
    const metadata = linkageColumns([
      ["phone_a", "phone_number"],
      ["phone_b", "phone_number"],
      ["last_col", "last_name"],
    ]);
    const imported = draftFromTerms(
      phoneDocument(["cell_phone"]),
      seedFor(metadata),
      3600,
      [],
    );
    expect(phoneBindings(imported.standardization, metadata)).toEqual([
      { output: "cell_phone", input: "phone_a" },
    ]);
  });

  test("two differently-named phone fields take a column each", () => {
    const metadata = linkageColumns([
      ["phone_a", "phone_number"],
      ["phone_b", "phone_number"],
      ["last_col", "last_name"],
    ]);
    const rawRows = [
      {
        phone_a: "(312) 555-0142",
        phone_b: "312-555-9876",
        last_col: "Alvarez",
      },
    ];
    const seed = seedFor(metadata);
    const imported = draftFromTerms(
      phoneDocument(["cell_phone", "home_phone"]),
      seed,
      3600,
      rawRows,
    );

    expect(phoneBindings(imported.standardization, metadata)).toEqual([
      { output: "cell_phone", input: "phone_a" },
      { output: "home_phone", input: "phone_b" },
    ]);
    expect(imported.keys.every((entry) => entry.enabled)).toBe(true);

    // Each field reads its own column, so the two phone columns produce distinct
    // values rather than one collapsed pair.
    const prepared = prepareForExchange(
      {
        linkageTerms: buildAdvancedTerms(imported),
        metadata,
        standardization: imported.standardization,
      },
      "Inviter",
      rawRows,
      seed.columns,
    );
    expect(prepared.dataset.getField("cell_phone")?.get(0)).toEqual([
      "3125550142",
    ]);
    expect(prepared.dataset.getField("home_phone")?.get(0)).toEqual([
      "3125559876",
    ]);
  });

  test("a metadata edit after the import leaves the field on its column", () => {
    // The other door the widened default serves, `reconcileStandardization`: it adds
    // a default binding only for a semantic type the kept set does not cover, so the
    // freshly-typed column gains its own cleaning while the imported field keeps both
    // its name and its column.
    const metadata: Metadata = [
      ...linkageColumns([
        ["phone_col", "phone_number"],
        ["first_col", "first_name"],
        ["last_col", "last_name"],
      ]),
      { name: "birthday", type: "other", role: "ignored", isPayload: false },
    ];
    const seed = seedFor(metadata);
    const imported = draftFromTerms(
      phoneDocument(["cell_phone"]),
      seed,
      3600,
      [],
    );
    const edited = setDraftMetadataKeepingKeys(
      imported,
      setColumnType(imported.metadata, "birthday", "date_of_birth").metadata,
      [],
    );

    expect(phoneBindings(edited.standardization, metadata)).toEqual([
      { output: "cell_phone", input: "phone_col" },
    ]);
    expect(
      edited.standardization.find((t) => t.output === "date_of_birth")?.input,
    ).toBe("birthday");
  });
});

describe("the offered-type withdrawal is the key-reconciling path's alone", () => {
  // The guided path re-derives the key set, so an edit that drops an enabled offer
  // withdraws the cleaning that offer minted -- the column keeps a card in the
  // data-prep workbench otherwise, over a field the draft's terms no longer
  // declare. The keep-keys path serves an authored or imported key set, whose keys
  // the edit leaves in place still referencing that field, so the same withdrawal
  // there would leave the draft's own key unsupplyable.
  const ZIP_KEY = "LN + FN + DOB + ZIP";
  const columns = ["ssn", "first_name", "last_name", "dob", "zip"];
  const rawRows = [
    {
      ssn: "900-31-2245",
      first_name: "Maria",
      last_name: "Alvarez",
      dob: "03/07/1988",
      zip: "60614-1234",
    },
  ];

  test("one edit withdraws the offer's cleaning on one path and retains it on the other", () => {
    const { draft } = seedAdvancedInvite("Org", columns, rawRows);
    const on = draftWithKeyEnabled(
      draft,
      draft.keys.findIndex((entry) => entry.key.name === ZIP_KEY),
      true,
    );
    expect(on.standardization.find((t) => t.output === "zip_code")?.input).toBe(
      "zip",
    );

    // A backbone column off matching, with the ZIP column itself untouched: the
    // offer is no longer satisfiable, but nothing about its own column changed.
    const metadata = setColumnType(on.metadata, "dob", "other").metadata;

    const guided = setDraftMetadata(on, metadata, rawRows);
    expect(guided.keys.some((entry) => entry.key.name === ZIP_KEY)).toBe(false);
    expect(guided.standardization.some((t) => t.output === "zip_code")).toBe(
      false,
    );

    const kept = setDraftMetadataKeepingKeys(on, metadata, rawRows);
    expect(kept.keys).toStrictEqual(on.keys);
    expect(
      kept.standardization.find((t) => t.output === "zip_code")?.input,
    ).toBe("zip");
  });
});

describe("importedConstraintDivergenceMessage refuses a non-representable-constraints import", () => {
  const columns = constrainedColumns;
  const rawRows = constrainedRawRows;
  const seedFor = constrainedSeed;
  const defaultExport = constrainedDefaultExport;

  test("a non-default ssn exclude denylist is refused, not silently rebuilt to the default", () => {
    const seed = seedFor();
    // The acceptance-criteria example: a different denylist, validOnly off.
    const imported = withFieldConstraints(defaultExport(), "ssn", {
      exclude: ["999999999"],
      validOnly: false,
    });

    // The rebuild WOULD normalize it straight back to the type default -- the silent
    // divergence the refusal exists to stop.
    const rebuiltSsn = buildAdvancedTerms(
      draftFromTerms(imported, seed, 3600, rawRows),
    ).linkageFields.find((field) => field.name === "ssn");
    expect(rebuiltSsn?.constraints).toEqual({
      exclude: ["111111111", "123456789"],
      validOnly: true,
    });

    // So the import door refuses it rather than generate a divergent agreement.
    expect(
      importedConstraintDivergenceMessage(imported, seed, rawRows),
    ).toBeDefined();
    // The refusal is critical, not cosmetic: accepting this import would
    // regenerate a different cross-party agreement than the document declared.
    expect(
      canonicalString(
        buildAdvancedTerms(draftFromTerms(imported, seed, 3600, rawRows)),
      ),
    ).not.toEqual(canonicalString(imported));
  });

  test.each([
    ["a name allowedCharacters", "first_name"],
    ["a name affixesAllowed", "last_name"],
    ["a validOnly on a type with no default constraint", "date_of_birth"],
    ["an ssn4 validOnly", "ssn4"],
  ] as const)(
    "%s deviating from the type default is refused",
    (_label, fieldName) => {
      const seed = seedFor();
      // A non-default value for each remaining constraint facet, per field type.
      // ssn4's default is { validOnly: true }, so validOnly: false is a deviation
      // -- it exercises a second DEFAULT_LINKAGE_FIELDS entry than ssn does.
      const byField: Record<string, Record<string, unknown>> = {
        first_name: { affixesAllowed: false, allowedCharacters: "A-Za-z " },
        last_name: { affixesAllowed: true, allowedCharacters: "A-Z " },
        date_of_birth: { validOnly: true },
        ssn4: { validOnly: false },
      };
      const imported = withFieldConstraints(
        defaultExport(),
        fieldName,
        byField[fieldName],
      );
      expect(
        importedConstraintDivergenceMessage(imported, seed, rawRows),
      ).toBeDefined();
    },
  );

  test("stripping a default constraint is refused -- the rebuild adds it back", () => {
    const seed = seedFor();
    const imported = withFieldConstraints(defaultExport(), "ssn", null);
    expect(
      importedConstraintDivergenceMessage(imported, seed, rawRows),
    ).toBeDefined();
  });

  test("the refusal names no partner-controlled constraint value", () => {
    const seed = seedFor();
    const imported = withFieldConstraints(defaultExport(), "ssn", {
      exclude: ["999999999"],
      validOnly: false,
    });
    const message = importedConstraintDivergenceMessage(
      imported,
      seed,
      rawRows,
    );
    expect(message).toBeDefined();
    expect(message).not.toContain("999999999");
  });

  test("a type-default import is accepted and rebuilds byte-for-byte (no refusal, agreement unchanged)", () => {
    const seed = seedFor();
    const exported = defaultExport();
    // The editor's own export has only type-default constraints, so the refusal
    // does not fire ...
    expect(
      importedConstraintDivergenceMessage(exported, seed, rawRows),
    ).toBeUndefined();
    // ... and the accepted import regenerates the same agreement the document declared.
    expect(
      canonicalString(
        buildAdvancedTerms(draftFromTerms(exported, seed, 3600, rawRows)),
      ),
    ).toEqual(canonicalString(exported));
  });

  test("a multi-field editor export (two same-typed fields) is accepted and round-trips", () => {
    // The editor's own multi-field export: two first_name fields bound to distinct
    // columns. Both have the type-default name constraints, so the rebuild reproduces
    // them and the guard must NOT refuse a legitimate export it can faithfully rebuild
    // -- the precision counterpart of the refusal tests. Guards against a future
    // change to authoredLinkageFields/buildAdvancedTerms that began refusing real
    // multi-field exports.
    const mfMetadata: Metadata = [
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
    const mfColumns = ["maiden_col", "current_col", "dob_col"];
    const mfRows = [
      { maiden_col: "Smith", current_col: "Jones", dob_col: "01/01/2000" },
    ];
    const NAME_STEPS = [{ function: "to_upper_case" }];
    const exported = buildAdvancedTerms({
      identity: "Inviter",
      lifetimeSeconds: 3600,
      outputDirection: "both",
      algorithm: "psi",
      deduplicate: false,
      linkageStrategy: "cascade",
      metadata: mfMetadata,
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
    });
    const mfSeed: AdvancedInviteSeed = {
      terms: getDefaultLinkageTerms("Inviter", mfMetadata),
      metadata: mfMetadata,
      columns: mfColumns,
    };
    expect(
      importedConstraintDivergenceMessage(exported, mfSeed, mfRows),
    ).toBeUndefined();
    expect(
      canonicalString(
        buildAdvancedTerms(draftFromTerms(exported, mfSeed, 3600, mfRows)),
      ),
    ).toEqual(canonicalString(exported));
  });

  test("the verdict is insensitive to the rows and the threaded date format", () => {
    // The console runs this check with no rows -- it threads the profiled date format
    // over an empty row set. The verdict must match the hosted (full-rows) result: the
    // comparison is over the field DECLARATIONS, which the date format (a cleaning
    // step) never touches. Pinned here rather than trusting the doc comment.
    const seed = seedFor();
    const format = dateInputFormatForColumns(columns, rawRows);
    const refused = withFieldConstraints(defaultExport(), "ssn", {
      exclude: ["999999999"],
      validOnly: false,
    });
    for (const terms of [refused, defaultExport()]) {
      const fromRows = importedConstraintDivergenceMessage(
        terms,
        seed,
        rawRows,
      );
      expect(
        importedConstraintDivergenceMessage(terms, seed, [], format),
      ).toEqual(fromRows);
      expect(importedConstraintDivergenceMessage(terms, seed, [])).toEqual(
        fromRows,
      );
    }
  });
});

describe("import round-trip preserves field order and declared-but-unreferenced fields", () => {
  const rawRows = constrainedRawRows;
  const seedFor = constrainedSeed;
  const defaultExport = constrainedDefaultExport;

  /** What an import-then-regenerate produces for `terms` against these columns. */
  function rebuild(terms: LinkageTerms): LinkageTerms {
    return buildAdvancedTerms(draftFromTerms(terms, seedFor(), 3600, rawRows));
  }

  test("a cross-type out-of-order field declaration round-trips with order (and hash) preserved", () => {
    const exported = defaultExport();
    // The editor's own export is in canonical DEFAULT_LINKAGE_FIELDS order.
    expect(exported.linkageFields.map((f) => f.name)).toEqual([
      "ssn",
      "ssn4",
      "first_name",
      "last_name",
      "date_of_birth",
    ]);
    // Reorder two types out of that canonical order: move date_of_birth to the front and
    // swap first_name/last_name. Schema-valid (field order is free; referential
    // integrity holds regardless), and different from what authoredLinkageFields emits.
    const reordered = structuredClone(exported);
    const byName = new Map(reordered.linkageFields.map((f) => [f.name, f]));
    const order = ["date_of_birth", "ssn", "ssn4", "last_name", "first_name"];
    reordered.linkageFields = order.map((name) => byName.get(name)!);
    expect(reordered.linkageFields.map((f) => f.name)).not.toEqual(
      exported.linkageFields.map((f) => f.name),
    );
    expect(safeParseLinkageTerms(reordered).success).toBe(true);

    // A clean import (only type-default constraints), so the constraint guard does not
    // fire ...
    expect(
      importedConstraintDivergenceMessage(reordered, seedFor(), rawRows),
    ).toBeUndefined();
    // ... and the rebuild re-emits the fields in the IMPORTED order, so the
    // receipt/agreement hash is unchanged across the round-trip.
    const rebuilt = rebuild(reordered);
    expect(rebuilt.linkageFields.map((f) => f.name)).toEqual(order);
    expect(canonicalString(rebuilt)).toEqual(canonicalString(reordered));
  });

  test("a canonically-ordered import rebuilds byte-for-byte unchanged", () => {
    const exported = defaultExport();
    expect(canonicalString(rebuild(exported))).toEqual(
      canonicalString(exported),
    );
  });

  test("a declared-but-unreferenced field with a non-default constraint is preserved, not dropped", () => {
    // Append a zip_code field NO key references, with a non-default exclude denylist. The
    // referential-integrity refine forbids only a dangling key->field reference, not a
    // declared-but-unreferenced field, so this is schema-valid.
    const exported = defaultExport();
    const withExtra = structuredClone(exported);
    const extra: LinkageTerms["linkageFields"][number] = {
      name: "zip_extra",
      type: "zip_code",
      constraints: { exclude: ["00000"] },
    };
    withExtra.linkageFields = [...withExtra.linkageFields, extra];
    expect(safeParseLinkageTerms(withExtra).success).toBe(true);

    // The unreferenced field is inert (no key references it), so it survives generation
    // unchanged rather than being dropped by the key-referenced filter -- and the guard
    // does not refuse it (the rebuild now preserves it, so its canonical form matches).
    expect(
      importedConstraintDivergenceMessage(withExtra, seedFor(), rawRows),
    ).toBeUndefined();
    const rebuilt = rebuild(withExtra);
    expect(rebuilt.linkageFields.find((f) => f.name === "zip_extra")).toEqual(
      extra,
    );
    // The field and its constraint survive, and so does every other term -- but not
    // the citation the export had: the document cites the built-in set while
    // declaring a field that set does not, and a citation naming the one set this
    // build ships is checked against that set rather than against the rules the
    // document claimed for it.
    expect(rebuilt.linkageRuleSet).toBeUndefined();
    const uncited = structuredClone(withExtra);
    delete uncited.linkageRuleSet;
    expect(canonicalString(rebuilt)).toEqual(canonicalString(uncited));

    // The realistic flow still generates: the inert extra field neither blocks the
    // satisfiability gate (no key references it) nor fails the schema parse.
    const validation = validateAdvancedInvite(
      draftFromTerms(withExtra, seedFor(), 3600, rawRows),
      seedFor(),
      new Date("2026-06-20T00:00:00.000Z"),
    );
    expect(validation.canGenerate).toBe(true);
    expect(safeParseLinkageTerms(validation.terms).success).toBe(true);
  });

  test("a document with no out-of-order or extra unreferenced field is byte-for-byte unchanged", () => {
    // The acceptance-criteria no-op baseline: the editor's own default export rebuilds
    // identically, so the common import is untouched by the faithful-round-trip change.
    const exported = defaultExport();
    const rebuilt = rebuild(exported);
    expect(rebuilt.linkageFields).toEqual(exported.linkageFields);
    expect(canonicalString(rebuilt)).toEqual(canonicalString(exported));
  });

  test("a benign empty constraints object on a no-default-constraint field round-trips verbatim, not over-refused", () => {
    // date_of_birth has no default constraint, so a from-defaults rebuild emits no
    // constraints key -- diverging from an imported empty {} and tripping the
    // refuse-on-import guard even though {} is behaviorally identical to absent.
    // Preserving the {} keeps the field declarations equal: neither a silent
    // divergence nor an over-refusal.
    const imported = withFieldConstraints(defaultExport(), "date_of_birth", {});
    expect(
      imported.linkageFields.find((f) => f.name === "date_of_birth"),
    ).toHaveProperty("constraints", {});

    expect(
      importedConstraintDivergenceMessage(imported, seedFor(), rawRows),
    ).toBeUndefined();
    const rebuilt = rebuild(imported);
    expect(
      rebuilt.linkageFields.find((f) => f.name === "date_of_birth"),
    ).toHaveProperty("constraints", {});
    // The built-in citation the export had does not survive with it: the {} is
    // behaviorally inert but canonically distinct, and the set this build ships
    // declares that field without it, so the document no longer describes the set
    // it names. Everything else round-trips byte for byte.
    expect(rebuilt.linkageRuleSet).toBeUndefined();
    const uncited = structuredClone(imported);
    delete uncited.linkageRuleSet;
    expect(canonicalString(rebuilt)).toEqual(canonicalString(uncited));
  });

  test("a name/type-confused referenced field with an empty {} stays refused, not preserved", () => {
    // The empty-{} preservation must not become a hole for TYPE confusion: the
    // referential-integrity refine checks a field NAME only, so a schema-valid document
    // can name a field "date_of_birth" yet type it "ssn" and have constraints: {} (a
    // valid SsnField named date_of_birth). Keyed on name alone, the rebuild would commit
    // that ssn-typed field verbatim -- the inviter binds date_of_birth by name while an
    // acceptor type-falls-back to its ssn column, a cross-party under-match -- and slip
    // the import guard, which refused it before the faithful round-trip. Requiring the
    // imported type to match the authored (column) type keeps it refused.
    const confusedField: LinkageTerms["linkageFields"][number] = {
      name: "date_of_birth",
      type: "ssn",
      constraints: {},
    };
    const confused = structuredClone(defaultExport());
    confused.linkageFields = confused.linkageFields.map((f) =>
      f.name === "date_of_birth" ? confusedField : f,
    );
    expect(safeParseLinkageTerms(confused).success).toBe(true);
    expect(
      importedConstraintDivergenceMessage(confused, seedFor(), rawRows),
    ).toBeDefined();
    // The fallthrough re-derives the field at its authored (column) type, so even if the
    // guard were bypassed the rebuild never commits the confused ssn type.
    expect(
      rebuild(confused).linkageFields.find((f) => f.name === "date_of_birth")
        ?.type,
    ).toBe("date_of_birth");
  });

  test("an imported document's own rule-set citation survives the round trip", () => {
    // The imported citation is re-emitted rather than re-derived, on the same
    // fidelity grounds the field order is: a document may cite a set this build
    // does not ship, and re-deriving would silently relabel it as the built-in
    // one over rules that happen to match.
    const imported = structuredClone(defaultExport());
    imported.linkageRuleSet = {
      fieldSet: { name: "partner-pii", version: "4.2.0" },
      keySet: { name: "partner-keys", version: "4.2.0" },
    };
    expect(rebuild(imported).linkageRuleSet).toEqual(imported.linkageRuleSet);
    expect(canonicalString(rebuild(imported))).toEqual(
      canonicalString(imported),
    );
  });

  test("an imported document that cites nothing round-trips citing nothing", () => {
    // The mirror of the case above, and the same fidelity question: declining to
    // cite a set is a claim too. Re-deriving here would stamp the built-in
    // citation on a document whose author left it out -- asserting a provenance
    // in the outgoing invitation and record that the source declined, and moving
    // the terms hash the two parties compare.
    const uncited = structuredClone(defaultExport());
    expect(uncited.linkageRuleSet).toBeDefined();
    delete uncited.linkageRuleSet;
    expect(safeParseLinkageTerms(uncited).success).toBe(true);
    // Its rules ARE the built-in set's byte for byte, which is what would earn the
    // citation on content alone.
    expect(
      linkageRuleSetReferenceFor({
        linkageFields: uncited.linkageFields,
        linkageKeys: uncited.linkageKeys,
      }),
    ).toBeDefined();
    expect(rebuild(uncited).linkageRuleSet).toBeUndefined();
    expect(canonicalString(rebuild(uncited))).toEqual(canonicalString(uncited));
  });

  test("an uncited import stays uncited through an edit that keeps the rules drawn from the built-in set", () => {
    // Narrowing keeps the rules drawn from the set, so content alone would cite
    // it. The import's own answer governs instead, for as long as the draft
    // has it: the operator adopted a document that claimed no provenance.
    const uncited = structuredClone(defaultExport());
    delete uncited.linkageRuleSet;
    const draft = draftFromTerms(uncited, seedFor(), 3600, rawRows);
    const narrowed = {
      ...draft,
      keys: draft.keys.map((entry, index) =>
        index === 0 ? { ...entry, enabled: false } : entry,
      ),
    };
    const terms = buildAdvancedTerms(narrowed);
    expect(terms.linkageKeys.length).toBe(uncited.linkageKeys.length - 1);
    expect(terms.linkageRuleSet).toBeUndefined();
  });

  test("an imported citation is dropped once the draft edits its way out of the cited rules", () => {
    const imported = structuredClone(defaultExport());
    imported.linkageRuleSet = {
      fieldSet: { name: "partner-pii", version: "4.2.0" },
      keySet: { name: "partner-keys", version: "4.2.0" },
    };
    const draft = draftFromTerms(imported, seedFor(), 3600, rawRows);
    // Reversing the cascade keeps every key and changes which one claims a record
    // more than one would match, so the imported citation does not describe
    // these rules -- and they are not the built-in set's either.
    const reordered = { ...draft, keys: [...draft.keys].reverse() };
    expect(buildAdvancedTerms(reordered).linkageRuleSet).toBeUndefined();
  });

  test("an imported citation is dropped once the draft disables every key", () => {
    // Rules declaring no key and no field are drawn from every set vacuously, so
    // re-emitting the import's citation here would name rules the document has
    // none of. The draft reaches this state as an intermediate, and the terms
    // export can take it out of the browser from there.
    const imported = structuredClone(defaultExport());
    imported.linkageRuleSet = {
      fieldSet: { name: "partner-pii", version: "4.2.0" },
      keySet: { name: "partner-keys", version: "4.2.0" },
    };
    const draft = draftFromTerms(imported, seedFor(), 3600, rawRows);
    const allOff = {
      ...draft,
      keys: draft.keys.map((entry) => ({ ...entry, enabled: false })),
    };
    const emptied = buildAdvancedTerms(allOff);
    expect(emptied.linkageKeys).toEqual([]);
    expect(emptied.linkageFields).toEqual([]);
    expect(emptied.linkageRuleSet).toBeUndefined();

    // Narrowing to ONE enabled key still declares rules drawn from the cited set,
    // so that import keeps its citation verbatim.
    const oneOn = {
      ...draft,
      keys: draft.keys.map((entry, index) =>
        index === 0 ? entry : { ...entry, enabled: false },
      ),
    };
    const narrowed = buildAdvancedTerms(oneOn);
    expect(narrowed.linkageKeys).toHaveLength(1);
    expect(narrowed.linkageRuleSet).toEqual(imported.linkageRuleSet);
  });

  test("an imported citation is dropped by a keyless draft whatever field declarations outlive the keys", () => {
    // A keyless draft is not an empty document: the round trip preserves a field
    // no key references, so field declarations outlive the keys that referenced
    // them. The citation asserts where the KEYS came from, so it goes on the keys
    // alone -- and the terms export takes this state out of the browser without
    // passing validation, which is what would otherwise refuse a keyless document.
    const imported = structuredClone(defaultExport());
    imported.linkageRuleSet = {
      fieldSet: { name: "partner-pii", version: "4.2.0" },
      keySet: { name: "partner-keys", version: "4.2.0" },
    };
    imported.linkageFields = [
      ...imported.linkageFields,
      { name: "zip_extra", type: "zip_code", constraints: { exclude: ["0"] } },
    ];
    expect(safeParseLinkageTerms(imported).success).toBe(true);

    const draft = draftFromTerms(imported, seedFor(), 3600, rawRows);
    const allOff = {
      ...draft,
      keys: draft.keys.map((entry) => ({ ...entry, enabled: false })),
    };
    const emptied = buildAdvancedTerms(allOff);
    expect(emptied.linkageKeys).toEqual([]);
    expect(emptied.linkageFields.map((field) => field.name)).toEqual([
      "zip_extra",
    ]);
    expect(emptied.linkageRuleSet).toBeUndefined();
  });

  test("an import citing the built-in set over rules that are not it emits no citation", () => {
    // The one reference this build can resolve is checked against the SET, not
    // against the rules the importing document claimed for it. A partner document
    // is free to put psilink's own set name over anything; re-emitting it would
    // have psilink vouch for a misdescription of rules it ships and knows.
    const misdescribed = structuredClone(defaultExport());
    expect(misdescribed.linkageRuleSet).toEqual(
      DEFAULT_LINKAGE_RULE_SET.reference,
    );
    misdescribed.linkageKeys[0] = {
      ...misdescribed.linkageKeys[0],
      name: `${misdescribed.linkageKeys[0].name} (house rules)`,
    };
    expect(safeParseLinkageTerms(misdescribed).success).toBe(true);
    // Unedited by the operator: the rebuild of the import as it arrived already
    // declines the citation.
    expect(rebuild(misdescribed).linkageRuleSet).toBeUndefined();
  });

  test("a citation half-naming the built-in key set is still checked against those keys", () => {
    // Each half is named and versioned on its own, so each resolves on its own:
    // pairing a field-set name this build cannot resolve with psilink's own key
    // set buys the key half no pass. Those keys are checked against the set this
    // build ships, and one edited key costs the citation.
    const halfMatched = structuredClone(defaultExport());
    halfMatched.linkageRuleSet = {
      fieldSet: { name: "attacker-pii", version: "9.9.9" },
      keySet: DEFAULT_LINKAGE_RULE_SET.reference.keySet,
    };
    halfMatched.linkageKeys[0] = {
      ...halfMatched.linkageKeys[0],
      name: `${halfMatched.linkageKeys[0].name} (house rules)`,
    };
    expect(safeParseLinkageTerms(halfMatched).success).toBe(true);
    // Unedited by the operator: the rebuild of the import as it arrived already
    // declines it, so psilink never re-emits its own key-set name over keys that
    // are provably not that set.
    expect(rebuild(halfMatched).linkageRuleSet).toBeUndefined();
  });

  test("a citation half-naming the built-in field set is still checked against those fields", () => {
    // The mirror half. The document declares a field the built-in field set does
    // not, so the half citing that set does not describe these fields -- however
    // unresolvable the key-set name it is paired with.
    const halfMatched = structuredClone(defaultExport());
    halfMatched.linkageRuleSet = {
      fieldSet: DEFAULT_LINKAGE_RULE_SET.reference.fieldSet,
      keySet: { name: "attacker-keys", version: "9.9.9" },
    };
    halfMatched.linkageFields = [
      ...halfMatched.linkageFields,
      { name: "zip_extra", type: "zip_code", constraints: { exclude: ["0"] } },
    ];
    expect(safeParseLinkageTerms(halfMatched).success).toBe(true);
    const rebuilt = rebuild(halfMatched);
    // The extra field is inert and survives the round trip, which is exactly what
    // the resolved field half is judged on.
    expect(rebuilt.linkageFields.map((f) => f.name)).toContain("zip_extra");
    expect(rebuilt.linkageRuleSet).toBeUndefined();
  });

  test("a half-matched citation accurate in both halves keeps it", () => {
    // Per-half resolution is not a refusal of half-matched references: the
    // built-in key half is checked against the keys this build ships and covers
    // them, while the field half names a set this build cannot resolve and is
    // checked against the declaration the document made for it -- including a
    // field the built-in set does not declare, which is that other set's business.
    const halfMatched = structuredClone(defaultExport());
    halfMatched.linkageRuleSet = {
      fieldSet: { name: "partner-pii", version: "4.2.0" },
      keySet: DEFAULT_LINKAGE_RULE_SET.reference.keySet,
    };
    halfMatched.linkageFields = [
      ...halfMatched.linkageFields,
      { name: "zip_extra", type: "zip_code", constraints: { exclude: ["0"] } },
    ];
    expect(safeParseLinkageTerms(halfMatched).success).toBe(true);
    const rebuilt = rebuild(halfMatched);
    expect(rebuilt.linkageRuleSet).toEqual(halfMatched.linkageRuleSet);
    expect(canonicalString(rebuilt)).toEqual(canonicalString(halfMatched));
  });

  test("the built-in sets at another version are not the resolvable reference, and round-trip verbatim", () => {
    // Resolution is per half, on an exact match of that half's name AND version:
    // a set this build does not ship is one it cannot check rules against, however
    // familiar the name, so the half citing it keeps the round-trip fidelity
    // behavior -- the same edited key that costs the resolvable citation above
    // leaves this key half standing, while the field half, citing the set this
    // build does ship, describes it faithfully.
    const otherVersion = structuredClone(defaultExport());
    otherVersion.linkageRuleSet = {
      fieldSet: DEFAULT_LINKAGE_RULE_SET.reference.fieldSet,
      keySet: {
        name: DEFAULT_LINKAGE_RULE_SET.reference.keySet.name,
        version: "9.9.9",
      },
    };
    otherVersion.linkageKeys[0] = {
      ...otherVersion.linkageKeys[0],
      name: `${otherVersion.linkageKeys[0].name} (house rules)`,
    };
    expect(safeParseLinkageTerms(otherVersion).success).toBe(true);
    expect(rebuild(otherVersion).linkageRuleSet).toEqual(
      otherVersion.linkageRuleSet,
    );
  });

  test("a guided draft that edits nothing still cites the built-in set", () => {
    // The no-op baseline: the editor's own default export has the citation and
    // rebuilds with it, so the guided path's terms -- and the cross-party hash --
    // are what the quick path would have embedded.
    const exported = defaultExport();
    expect(exported.linkageRuleSet).toBeDefined();
    expect(rebuild(exported).linkageRuleSet).toEqual(exported.linkageRuleSet);
  });

  test("disabling a key narrows the rules and keeps the citation", () => {
    // The resolvable citation over the rules it names: narrowing leaves
    // the rules drawn from the built-in set, so the set's own content -- what the
    // citation is checked against -- still covers them.
    const exported = defaultExport();
    expect(exported.linkageRuleSet).toEqual(DEFAULT_LINKAGE_RULE_SET.reference);
    const draft = draftFromTerms(exported, seedFor(), 3600, rawRows);
    const narrowed = {
      ...draft,
      keys: draft.keys.map((entry, index) =>
        index === 0 ? { ...entry, enabled: false } : entry,
      ),
    };
    const terms = buildAdvancedTerms(narrowed);
    expect(terms.linkageKeys.length).toBe(exported.linkageKeys.length - 1);
    expect(terms.linkageRuleSet).toEqual(exported.linkageRuleSet);
  });

  test("an empty constraints object that STRIPS a type default (ssn) stays refused", () => {
    // ssn's default is { exclude, validOnly }, so an empty {} is NOT a benign no-op -- it
    // drops the SSN validity checks the editor would author. That is a real,
    // non-representable change on a field a key references, so it stays refused: the
    // benign-{} preservation is scoped to a type with NO default constraint.
    const imported = withFieldConstraints(defaultExport(), "ssn", {});
    expect(
      importedConstraintDivergenceMessage(imported, seedFor(), rawRows),
    ).toBeDefined();
  });
});

describe("the editor says when an imported citation will not be re-emitted", () => {
  const rawRows = constrainedRawRows;
  const seedFor = constrainedSeed;
  const defaultExport = constrainedDefaultExport;

  /** A citation naming a set this build does not ship, so the rules the citing
   * document declared for it are what it is checked against. */
  const FOREIGN_REFERENCE = {
    fieldSet: { name: "partner-pii", version: "4.2.0" },
    keySet: { name: "partner-keys", version: "4.2.0" },
  };

  /** The editor's own export, re-citing `reference` over those same rules. */
  function citing(
    reference: NonNullable<LinkageTerms["linkageRuleSet"]>,
  ): LinkageTerms {
    const terms = structuredClone(defaultExport());
    terms.linkageRuleSet = reference;
    return terms;
  }

  /** The draft an import of `terms` against these columns loads. */
  function draftFor(terms: LinkageTerms): AdvancedInviteDraft {
    return draftFromTerms(terms, seedFor(), 3600, rawRows);
  }

  function withKeys(
    draft: AdvancedInviteDraft,
    keys: AdvancedInviteDraft["keys"],
  ): AdvancedInviteDraft {
    return { ...draft, keys };
  }

  /** A document citing the set this build ships over a key renamed out of it -- the
   * citation that fails against the real built-in rules on arrival. */
  function misdescribingShippedSet(): LinkageTerms {
    const terms = structuredClone(defaultExport());
    terms.linkageKeys[0] = {
      ...terms.linkageKeys[0],
      name: `${terms.linkageKeys[0].name} (house rules)`,
    };
    return terms;
  }

  /** A foreign-cited import whose cascade the operator then reversed -- the drop an
   * edit here reaches. */
  function reorderedForeignImport(): AdvancedInviteDraft {
    const draft = draftFor(citing(FOREIGN_REFERENCE));
    return withKeys(draft, [...draft.keys].reverse());
  }

  test("no notice while the rebuild has the citation the import made", () => {
    // The unedited round trip, both resolvable and not: the built-in citation over
    // the set's own rules, and a foreign citation over the rules its document
    // claimed. Each survives the rebuild, so there is nothing to tell the operator.
    for (const imported of [defaultExport(), citing(FOREIGN_REFERENCE)]) {
      expect(imported.linkageRuleSet).toBeDefined();
      const draft = draftFor(imported);
      expect(buildAdvancedTerms(draft).linkageRuleSet).toEqual(
        imported.linkageRuleSet,
      );
      expect(importedCitationDropNotice(draft)).toBeUndefined();
    }
  });

  test("no notice for a narrowing that leaves the rules drawn from the cited set", () => {
    // Disabling a key narrows the rules without editing them, so the citation
    // stands -- the notice must not fire on the edit an operator makes most.
    const imported = citing(FOREIGN_REFERENCE);
    const draft = draftFor(imported);
    const narrowed = withKeys(
      draft,
      draft.keys.map((entry, index) =>
        index === 0 ? { ...entry, enabled: false } : entry,
      ),
    );
    expect(buildAdvancedTerms(narrowed).linkageRuleSet).toEqual(
      FOREIGN_REFERENCE,
    );
    expect(importedCitationDropNotice(narrowed)).toBeUndefined();
  });

  test("no notice, and no drop, for an unmet citation the editor's own narrowing repairs", () => {
    // The document cites the set this build ships over a key that set does not
    // declare -- but the key references a field these columns cannot supply, so the
    // import disables it and the rebuilt rules ARE drawn from the set. The citation
    // stands, exactly as it did before there was a notice: naming a cause must never
    // become a fourth reason to drop one, since the drop moves what goes on the wire.
    const imported = structuredClone(defaultExport());
    imported.linkageFields = [
      ...imported.linkageFields,
      { name: "phone_number", type: "phone_number" },
    ];
    imported.linkageKeys = [
      ...imported.linkageKeys,
      { name: "Phone", elements: [{ field: "phone_number" }] },
    ];
    expect(safeParseLinkageTerms(imported).success).toBe(true);
    // The document's own rules are not the shipped set's: the extra key and field
    // are additions to it, so the citation as it arrived is unmet.
    expect(
      linkageRuleSetReferenceFor({
        linkageFields: imported.linkageFields,
        linkageKeys: imported.linkageKeys,
      }),
    ).toBeUndefined();

    const draft = draftFor(imported);
    expect(
      draft.keys.find((entry) => entry.key.name === "Phone")?.enabled,
    ).toBe(false);
    expect(buildAdvancedTerms(draft).linkageRuleSet).toEqual(
      DEFAULT_LINKAGE_RULE_SET.reference,
    );
    expect(importedCitationDropNotice(draft)).toBeUndefined();
  });

  test("no notice for a draft with no imported citation to lose", () => {
    // A document that cited nothing declined the claim rather than losing it, and a
    // draft that imported nothing re-derives its citation on content, so neither is
    // the operator's to be told about.
    const uncited = structuredClone(defaultExport());
    delete uncited.linkageRuleSet;
    expect(importedCitationDropNotice(draftFor(uncited))).toBeUndefined();
    expect(
      importedCitationDropNotice(
        seedAdvancedInvite("Inviter", [...ALL_COLUMNS]).draft,
      ),
    ).toBeUndefined();
  });

  test("a notice when the draft edits its rules out of the cited set", () => {
    // Reversing the cascade keeps every key and changes which one claims a record
    // more than one would match, so the rules are no longer the cited set's. The
    // cause is the edit, whether the citation resolves to the shipped set or not.
    for (const imported of [defaultExport(), citing(FOREIGN_REFERENCE)]) {
      const draft = draftFor(imported);
      expect(importedCitationDropNotice(draft)).toBeUndefined();
      const reordered = withKeys(draft, [...draft.keys].reverse());
      expect(buildAdvancedTerms(reordered).linkageRuleSet).toBeUndefined();
      expect(importedCitationDropCause(reordered)).toBe("rules-not-drawn");
      expect(importedCitationDropNotice(reordered)).toContain(
        "no longer drawn from the rule set",
      );
    }
  });

  test("a notice when a citation of the shipped set never described the document's own rules", () => {
    // The other cause, and the one no edit here reaches: the document names the set
    // this build ships over rules that are not it, so the citation fails against the
    // real built-in rules at the import itself. The operator is told before touching
    // anything, and told something different from the edited-out-of-it case.
    const misdescribed = misdescribingShippedSet();
    expect(misdescribed.linkageRuleSet).toEqual(
      DEFAULT_LINKAGE_RULE_SET.reference,
    );
    expect(safeParseLinkageTerms(misdescribed).success).toBe(true);

    const draft = draftFor(misdescribed);
    expect(buildAdvancedTerms(draft).linkageRuleSet).toBeUndefined();
    expect(importedCitationDropCause(draft)).toBe("shipped-set-unmet");
    const notice = importedCitationDropNotice(draft);
    expect(notice).toContain("cannot be verified");
    expect(notice).not.toEqual(
      importedCitationDropNotice(reorderedForeignImport()),
    );
  });

  test("the unmet-shipped-set cause outlives an edit made after the import", () => {
    // A citation the document's own rules never met is not something the operator
    // did, so an edit on top of it must not re-attribute the drop to that edit --
    // "undo the key edits" would be an instruction that cannot work.
    const draft = draftFor(misdescribingShippedSet());
    const reordered = withKeys(draft, [...draft.keys].reverse());
    expect(importedCitationDropCause(reordered)).toBe("shipped-set-unmet");
  });

  test("a keyless draft is told the citation goes with the keys", () => {
    // Turning every key off is an intermediate the terms export can take out of the
    // browser, and the citation goes with the keys it asserts provenance for. Its own
    // cause: the remedy is to turn a key back on, not to undo an edit to one.
    const draft = draftFor(citing(FOREIGN_REFERENCE));
    const allOff = withKeys(
      draft,
      draft.keys.map((entry) => ({ ...entry, enabled: false })),
    );
    expect(buildAdvancedTerms(allOff).linkageRuleSet).toBeUndefined();
    expect(importedCitationDropCause(allOff)).toBe("no-keys");
    expect(importedCitationDropNotice(allOff)).toContain(
      "Turn a linkage key back on",
    );
  });

  test("a repaired import's later reorder is the operator's edit, not the document's fault", () => {
    // The document cites the set this build ships plus one extra key these columns
    // cannot supply, so the editor disables that key on arrival and the citation
    // SURVIVES the import. A later ordinary reorder of the surviving keys drops it:
    // the proximate cause is that edit, and reversing it restores the citation, so
    // the cause is rules-not-drawn ("undo the edit"), not shipped-set-unmet -- whose
    // "no edit restores it" would be false here.
    const imported = structuredClone(defaultExport());
    imported.linkageFields = [
      ...imported.linkageFields,
      { name: "phone_number", type: "phone_number" },
    ];
    imported.linkageKeys = [
      ...imported.linkageKeys,
      { name: "Phone", elements: [{ field: "phone_number" }] },
    ];
    const draft = draftFor(imported);
    // Survived import: the unsupplyable extra key is disabled and the rebuilt rules
    // still cite the shipped set.
    expect(buildAdvancedTerms(draft).linkageRuleSet).toEqual(
      DEFAULT_LINKAGE_RULE_SET.reference,
    );
    expect(importedCitationDropNotice(draft)).toBeUndefined();

    const reordered = withKeys(draft, [...draft.keys].reverse());
    expect(buildAdvancedTerms(reordered).linkageRuleSet).toBeUndefined();
    expect(importedCitationDropCause(reordered)).toBe("rules-not-drawn");
    expect(importedCitationDropNotice(reordered)).toContain(
      "no longer drawn from the rule set",
    );

    // Reversing the reorder restores the citation -- proof the drop was the edit's,
    // which shipped-set-unmet would have denied.
    const restored = withKeys(reordered, [...reordered.keys].reverse());
    expect(buildAdvancedTerms(restored).linkageRuleSet).toEqual(
      DEFAULT_LINKAGE_RULE_SET.reference,
    );
    expect(importedCitationDropNotice(restored)).toBeUndefined();
  });

  test("an import whose keys no column can supply is not told to turn a key on", () => {
    // Every imported key references a field these columns cannot supply, so the
    // editor disables them all on arrival -- the operator turned nothing off.
    // "Turn a linkage key back on" would only trade the notice for the blocking
    // unsupplyable-key error, so the notice names the real obstacle: no key is
    // supplyable. The drop cause is still no-keys; only the notice differs.
    const phoneOnlyMetadata: Metadata = [
      {
        name: "phone_col",
        type: "phone_number",
        role: "linkage",
        isPayload: false,
      },
    ];
    const phoneOnlySeed: AdvancedInviteSeed = {
      terms: getDefaultLinkageTerms("Inviter", phoneOnlyMetadata),
      metadata: phoneOnlyMetadata,
      columns: ["phone_col"],
    };
    const imported = defaultExport();
    expect(imported.linkageRuleSet).toEqual(DEFAULT_LINKAGE_RULE_SET.reference);
    const draft = draftFromTerms(imported, phoneOnlySeed, 3600, [
      { phone_col: "5551234567" },
    ]);
    expect(draft.keys.every((entry) => !entry.enabled)).toBe(true);
    expect(buildAdvancedTerms(draft).linkageRuleSet).toBeUndefined();
    expect(importedCitationDropCause(draft)).toBe("no-keys");

    const notice = importedCitationDropNotice(draft);
    expect(notice).not.toContain("Turn a linkage key back on");
    expect(notice).toContain("supplied by your file's columns");
  });

  test("the notice does not block generating", () => {
    // The drop stays the behavior: the operator is told what the outgoing document
    // will say, not stopped from creating it.
    for (const dropping of [
      draftFor(misdescribingShippedSet()),
      reorderedForeignImport(),
    ]) {
      expect(importedCitationDropNotice(dropping)).toBeDefined();
      const validation = validateAdvancedInvite(
        dropping,
        seedFor(),
        new Date("2026-06-20T00:00:00.000Z"),
      );
      expect(validation.errors).toEqual({});
      expect(validation.canGenerate).toBe(true);
      expect(validation.terms?.linkageRuleSet).toBeUndefined();
    }
  });
});

describe("draftFromTerms degrades gracefully on an unsupplyable key", () => {
  const NOW = new Date("2026-06-20T00:00:00.000Z");
  const NAME_STEPS = [{ function: "to_upper_case" }];

  /** A fresh editor seed over the given columns, the import target. */
  function seedFor(forColumns: Array<string>, m: Metadata): AdvancedInviteSeed {
    return {
      terms: getDefaultLinkageTerms("Inviter", m),
      metadata: m,
      columns: forColumns,
    };
  }

  /** A document declaring THREE same-typed (first_name) fields, each referenced by
   * its own key, plus a date column the keys do not use. The export has all
   * three field declarations; the binding is local and does not travel. */
  function threeNameDocument(): LinkageTerms {
    const threeNameMetadata: Metadata = [
      { name: "n1", type: "first_name", role: "linkage", isPayload: false },
      { name: "n2", type: "first_name", role: "linkage", isPayload: false },
      { name: "n3", type: "first_name", role: "linkage", isPayload: false },
      {
        name: "dob_col",
        type: "date_of_birth",
        role: "linkage",
        isPayload: false,
      },
    ];
    return buildAdvancedTerms({
      identity: "Inviter",
      lifetimeSeconds: 3600,
      outputDirection: "both",
      algorithm: "psi",
      deduplicate: false,
      linkageStrategy: "cascade",
      metadata: threeNameMetadata,
      standardization: [
        { output: "first_name", input: "n1", steps: NAME_STEPS },
        { output: "first_name_2", input: "n2", steps: NAME_STEPS },
        { output: "first_name_3", input: "n3", steps: NAME_STEPS },
      ],
      keys: [
        {
          key: { name: "k1", elements: [{ field: "first_name" }] },
          enabled: true,
        },
        {
          key: { name: "k2", elements: [{ field: "first_name_2" }] },
          enabled: true,
        },
        {
          key: { name: "k3", elements: [{ field: "first_name_3" }] },
          enabled: true,
        },
      ],
    });
  }

  /** Two first_name columns and a date: the import target for the 3-field document
   * supplies only two of its three same-typed fields. */
  const twoNameMetadata: Metadata = [
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
  const twoNameColumns = ["maiden_col", "current_col", "dob_col"];

  const enabledByName = (draft: AdvancedInviteDraft): Record<string, boolean> =>
    Object.fromEntries(
      draft.keys.map((entry) => [entry.key.name, entry.enabled]),
    );

  test("a partially-satisfiable import disables only the unsupplyable key and generates the rest", () => {
    // Three same-typed fields into a two-column file: two bind, the third has no free
    // column. The import disables the third key so the two satisfiable keys generate,
    // while the unsupplyable key stays visible (disabled) to re-enable later.
    const exported = threeNameDocument();
    const seed = seedFor(twoNameColumns, twoNameMetadata);
    const imported = draftFromTerms(exported, seed, 3600, []);

    // Two of the three same-typed fields were reconstructed; the third was not.
    expect(
      imported.standardization.some((t) => t.output === "first_name_2"),
    ).toBe(true);
    expect(
      imported.standardization.some((t) => t.output === "first_name_3"),
    ).toBe(false);

    // The two supplyable keys stay enabled; only the unsupplyable one is disabled
    // (kept, not dropped, so the operator sees what the document asked for).
    expect(enabledByName(imported)).toEqual({ k1: true, k2: true, k3: false });

    // The satisfiable subset generates cleanly -- no keys error.
    const validation = validateAdvancedInvite(imported, seed, NOW);
    expect(validation.errors.keys).toBeUndefined();
    expect(validation.canGenerate).toBe(true);
    expect(safeParseLinkageTerms(validation.terms).success).toBe(true);
  });

  test("re-enabling the unsupplyable key blocks with the field-cannot-be-supplied message, not the no-keys message", () => {
    // The operator can turn the disabled key back on; generation then blocks (the key
    // dangles the built terms), but with a message that names the real obstacle rather
    // than the misleading "Enable at least one linkage key." This is the residual
    // fully-blocked case the message fix handles regardless of the disable choice.
    const exported = threeNameDocument();
    const seed = seedFor(twoNameColumns, twoNameMetadata);
    const imported = draftFromTerms(exported, seed, 3600, []);
    const reEnabled: AdvancedInviteDraft = {
      ...imported,
      keys: imported.keys.map((entry) =>
        entry.key.name === "k3" ? { ...entry, enabled: true } : entry,
      ),
    };

    const validation = validateAdvancedInvite(reEnabled, seed, NOW);
    expect(validation.canGenerate).toBe(false);
    expect(validation.errors.keys).toMatch(/cannot supply/);
    expect(validation.errors.keys).not.toContain("Enable at least one");
  });

  test("an import referencing a semantic type the inviter wholly lacks fails closed with an accurate message", () => {
    // A document whose every key references first_name, imported into a file that has
    // no first_name column at all: no key is supplyable, so all are disabled. The
    // import still refuses to generate (fail-closed), but the message names the missing
    // field rather than telling the operator to enable a key -- which would not help,
    // since no key the columns can supply exists.
    const document = buildAdvancedTerms({
      identity: "Inviter",
      lifetimeSeconds: 3600,
      outputDirection: "both",
      algorithm: "psi",
      deduplicate: false,
      linkageStrategy: "cascade",
      metadata: [
        { name: "n1", type: "first_name", role: "linkage", isPayload: false },
        { name: "n2", type: "first_name", role: "linkage", isPayload: false },
      ],
      standardization: [
        { output: "first_name", input: "n1", steps: NAME_STEPS },
        { output: "first_name_2", input: "n2", steps: NAME_STEPS },
      ],
      keys: [
        {
          key: { name: "k1", elements: [{ field: "first_name" }] },
          enabled: true,
        },
        {
          key: { name: "k2", elements: [{ field: "first_name_2" }] },
          enabled: true,
        },
      ],
    });
    const dobOnlyMetadata: Metadata = [
      {
        name: "dob_col",
        type: "date_of_birth",
        role: "linkage",
        isPayload: false,
      },
    ];
    const seed = seedFor(["dob_col"], dobOnlyMetadata);
    const imported = draftFromTerms(document, seed, 3600, []);

    // No key is supplyable, so every key is disabled on import.
    expect(imported.keys.every((entry) => !entry.enabled)).toBe(true);

    const validation = validateAdvancedInvite(imported, seed, NOW);
    expect(validation.canGenerate).toBe(false);
    expect(validation.terms).toBeUndefined();
    expect(validation.errors.keys).toMatch(/cannot supply/);
    expect(validation.errors.keys).not.toContain("Enable at least one");
  });

  test("a fully satisfiable import is unchanged: every key stays enabled and generates", () => {
    // Both same-typed fields bind against the two columns, so no key is disabled.
    const document = buildAdvancedTerms({
      identity: "Inviter",
      lifetimeSeconds: 3600,
      outputDirection: "both",
      algorithm: "psi",
      deduplicate: false,
      linkageStrategy: "cascade",
      metadata: twoNameMetadata,
      standardization: [
        { output: "first_name", input: "maiden_col", steps: NAME_STEPS },
        { output: "first_name_2", input: "current_col", steps: NAME_STEPS },
      ],
      keys: [
        {
          key: { name: "k1", elements: [{ field: "first_name" }] },
          enabled: true,
        },
        {
          key: { name: "k2", elements: [{ field: "first_name_2" }] },
          enabled: true,
        },
      ],
    });
    const seed = seedFor(twoNameColumns, twoNameMetadata);
    const imported = draftFromTerms(document, seed, 3600, []);

    expect(imported.keys.every((entry) => entry.enabled)).toBe(true);
    const validation = validateAdvancedInvite(imported, seed, NOW);
    expect(validation.errors.keys).toBeUndefined();
    expect(validation.canGenerate).toBe(true);
  });

  test("turning off supplyable keys still reports the genuine no-keys-enabled message", () => {
    // The new message must not regress the real "you turned all keys off" case: when
    // every key IS supplyable, disabling them all keeps the original wording, which is
    // the actionable advice (re-enable one).
    const { draft, seed } = seedAdvancedInvite("Org", ALL_COLUMNS);
    const allOff: AdvancedInviteDraft = {
      ...draft,
      keys: draft.keys.map((entry) => ({ ...entry, enabled: false })),
    };
    const validation = validateAdvancedInvite(allOff, seed, NOW);
    expect(validation.canGenerate).toBe(false);
    expect(validation.errors.keys).toBe("Enable at least one linkage key.");
  });

  test("a composite key is disabled when ANY one of its elements is unsupplyable", () => {
    // keyIsSupplyable is all-or-nothing over a key's elements (.every): a multi-element
    // key with one supplyable and one unsupplyable element must be disabled as a whole,
    // since the unsupplyable element would still dangle the built terms. Reachable via
    // expert key editing (a second element bound to a field the columns cannot supply).
    // Three first_name fields are referenced so they compete for the importer's two
    // first_name columns: first_name and first_name_2 bind, first_name_3 cannot, and the
    // composite key references first_name (supplyable) AND first_name_3 (not).
    const document = buildAdvancedTerms({
      identity: "Inviter",
      lifetimeSeconds: 3600,
      outputDirection: "both",
      algorithm: "psi",
      deduplicate: false,
      linkageStrategy: "cascade",
      metadata: [
        { name: "n1", type: "first_name", role: "linkage", isPayload: false },
        { name: "n2", type: "first_name", role: "linkage", isPayload: false },
        { name: "n3", type: "first_name", role: "linkage", isPayload: false },
      ],
      standardization: [
        { output: "first_name", input: "n1", steps: NAME_STEPS },
        { output: "first_name_2", input: "n2", steps: NAME_STEPS },
        { output: "first_name_3", input: "n3", steps: NAME_STEPS },
      ],
      keys: [
        {
          key: { name: "solo", elements: [{ field: "first_name" }] },
          enabled: true,
        },
        {
          key: { name: "second", elements: [{ field: "first_name_2" }] },
          enabled: true,
        },
        {
          // One supplyable element, one not -- the key as a whole is unsupplyable.
          key: {
            name: "composite",
            elements: [{ field: "first_name" }, { field: "first_name_3" }],
          },
          enabled: true,
        },
      ],
    });
    const seed = seedFor(twoNameColumns, twoNameMetadata);
    const imported = draftFromTerms(document, seed, 3600, []);

    expect(enabledByName(imported)).toEqual({
      solo: true,
      second: true,
      composite: false,
    });
    // The supplyable keys still generate; re-enabling the composite key blocks with the
    // accurate message, not the misleading no-keys one.
    expect(validateAdvancedInvite(imported, seed, NOW).canGenerate).toBe(true);
    const reEnabled: AdvancedInviteDraft = {
      ...imported,
      keys: imported.keys.map((entry) =>
        entry.key.name === "composite" ? { ...entry, enabled: true } : entry,
      ),
    };
    const blocked = validateAdvancedInvite(reEnabled, seed, NOW);
    expect(blocked.canGenerate).toBe(false);
    expect(blocked.errors.keys).toMatch(/cannot supply/);
  });

  test("import enables a key iff building it alone yields schema-valid terms (disable/build lockstep)", () => {
    // The disable-on-import predicate (declarableFieldNames + keyIsSupplyable) and the
    // field set buildAdvancedTerms declares both derive from the SAME
    // (metadata, standardization) pair, so a key is imported enabled exactly when it
    // does not dangle the built terms. Pin that lockstep executably: a refactor that let
    // buildAdvancedTerms derive its linkageFields differently from declarableFieldNames
    // would re-block a partial import (an enabled key dangling) or silently drop a usable
    // one (a satisfiable key disabled), and this assertion would fail rather than the
    // regression shipping silently.
    const exported = threeNameDocument();
    const seed = seedFor(twoNameColumns, twoNameMetadata);
    const imported = draftFromTerms(exported, seed, 3600, []);
    expect(imported.keys.length).toBeGreaterThan(0);
    for (const entry of imported.keys) {
      const builtAlone = buildAdvancedTerms({
        ...imported,
        keys: imported.keys.map((other) => ({
          ...other,
          enabled: other.key.name === entry.key.name,
        })),
      });
      expect(safeParseLinkageTerms(builtAlone).success).toBe(entry.enabled);
    }
  });
});

describe("matchable columns the default keys omit are pickable as linkage fields", () => {
  const COLUMNS = [
    "ssn",
    "first_name",
    "last_name",
    "date_of_birth",
    "zipcode",
  ];

  test("a zip_code column roled used-to-match becomes a declared field for the picker", () => {
    // The reported gap: a column inferred as zip_code (role linkage) was absent from
    // the expert key editor's field picker, because zip_code is not one of the
    // default-key field types. The picker's options are authoredLinkageFields over
    // the draft's metadata + standardization, so assert that source now declares it.
    const { draft } = seedAdvancedInvite("Org", COLUMNS);
    expect(draft.metadata.find((c) => c.name === "zipcode")).toMatchObject({
      type: "zip_code",
      role: "linkage",
    });
    const declared = authoredLinkageFields(
      draft.metadata,
      draft.standardization,
    );
    expect(declared.some((f) => f.type === "zip_code")).toBe(true);
  });

  test("a key matching on the zip_code field builds, validates, and is satisfiable", () => {
    const { draft, seed } = seedAdvancedInvite("Org", COLUMNS);
    const zipField = authoredLinkageFields(
      draft.metadata,
      draft.standardization,
    ).find((f) => f.type === "zip_code");
    expect(zipField).toBeDefined();
    // Author a key that matches solely on the zip_code field, the way an operator
    // would in expert mode once the field is offered.
    const withZipKey: AdvancedInviteDraft = {
      ...draft,
      keys: [
        {
          key: { name: "ZIP", elements: [{ field: zipField!.name }] },
          enabled: true,
        },
      ],
    };
    const terms = buildAdvancedTerms(withZipKey);
    // The zip_code field rides into the built terms (referenced by the enabled key),
    // the terms are schema-valid, and the key resolves to the present zip_code
    // column -- so the editor clears it for generation.
    expect(terms.linkageFields.some((f) => f.type === "zip_code")).toBe(true);
    expect(safeParseLinkageTerms(terms).success).toBe(true);
    const { satisfiableKeyCount } = assessLinkageSatisfiability(
      seed.columns,
      terms,
      withZipKey.standardization,
      withZipKey.metadata,
    );
    expect(satisfiableKeyCount).toBe(1);
    expect(validateAdvancedInvite(withZipKey, seed).canGenerate).toBe(true);
  });
});

// Linkage key elements reference a field by its bare NAME STRING, and core resolves
// that reference by last-wins name lookup, so two linkage fields sharing one name
// would silently rebind a key to whichever field's column happens to win -- a
// cross-party mismatch with no error. safeParseLinkageTerms' name-uniqueness refine
// blocks the collision at Generate, but only once the draft already has the
// duplicate; these lock the editor mutators that must never produce one.
describe("no two linkage fields ever share a name (reconcileImportedFields dedup guard)", () => {
  // ssn_col2 and extra_col are free role: linkage columns of types the default keys
  // do not bind by default, letting a retype or an added field pick up a second
  // same-typed binding without disturbing the other default-key types' offerable
  // set.
  const metadata: Metadata = [
    { name: "ssn_col", type: "ssn", role: "linkage", isPayload: false },
    { name: "fn_col", type: "first_name", role: "linkage", isPayload: false },
    { name: "ln_col", type: "last_name", role: "linkage", isPayload: false },
    {
      name: "dob_col",
      type: "date_of_birth",
      role: "linkage",
      isPayload: false,
    },
    { name: "extra_col", type: "ssn4", role: "linkage", isPayload: false },
    { name: "ssn_col2", type: "ssn", role: "linkage", isPayload: false },
  ];
  const columns = [
    "ssn_col",
    "fn_col",
    "ln_col",
    "dob_col",
    "extra_col",
    "ssn_col2",
  ];

  function seedFor(): AdvancedInviteSeed {
    return {
      terms: getDefaultLinkageTerms("Inviter", metadata),
      metadata,
      columns,
    };
  }

  /** The editor's own default export for these columns -- the baseline an operator
   * (or a partner reflecting terms back) would import. */
  function defaultExport(): LinkageTerms {
    const terms = getDefaultLinkageTerms("Inviter", metadata);
    const standardization = defaultStandardizationForRows(metadata, terms, []);
    return buildAdvancedTerms({
      identity: "Inviter",
      lifetimeSeconds: 3600,
      outputDirection: "both",
      algorithm: "psi",
      deduplicate: false,
      linkageStrategy: "cascade",
      metadata,
      standardization,
      keys: terms.linkageKeys.map((key) => ({ key, enabled: true })),
    });
  }

  /** The adversarial import: the field named "ssn" is TYPED first_name instead --
   * a name/type-confused field, still referenced by its key -- while the columns
   * also have a genuine ssn-typed linkage column (ssn_col). This is the shape where
   * the confused import name collides with the inviter's own authored field name,
   * which reconcileImportedFields' `emitted` guard must resolve to one field. */
  function typeConfusedSsnImport(): LinkageTerms {
    const exported = defaultExport();
    const crafted = structuredClone(exported);
    crafted.linkageFields = crafted.linkageFields.map((field) =>
      field.name === "ssn" ? { name: "ssn", type: "first_name" } : field,
    );
    expect(safeParseLinkageTerms(crafted).success).toBe(true);
    return crafted;
  }

  /** No two fields in built terms share a name -- equivalently, the terms parse
   * (the schema's own name-uniqueness refine would otherwise reject them). */
  function assertNoDuplicateFieldNames(terms: LinkageTerms): void {
    const names = terms.linkageFields.map((field) => field.name);
    expect(names.length).toEqual(new Set(names).size);
    expect(safeParseLinkageTerms(terms).success).toBe(true);
  }

  test("importing the type-confused document alone never yields a duplicate name", () => {
    const imported = draftFromTerms(
      typeConfusedSsnImport(),
      seedFor(),
      3600,
      [],
    );
    assertNoDuplicateFieldNames(buildAdvancedTerms(imported));
  });

  test("import, then retype a second column to the confused field's type (setDraftMetadata)", () => {
    // importedLinkageFields is set by draftFromTerms and never cleared by any
    // mutator (setDraftMetadata included), so the draft stays on the
    // reconcileImportedFields path through the retype -- the case this guard exists
    // for.
    const imported = draftFromTerms(
      typeConfusedSsnImport(),
      seedFor(),
      3600,
      [],
    );
    expect(imported.importedLinkageFields).toBeDefined();

    const retypedMetadata = metadata.map((column) =>
      column.name === "extra_col"
        ? { ...column, type: "ssn" as const }
        : column,
    );
    const retyped = setDraftMetadata(imported, retypedMetadata, []);
    expect(retyped.importedLinkageFields).toBeDefined();
    assertNoDuplicateFieldNames(buildAdvancedTerms(retyped));
  });

  test("import, retype, then add a same-typed field and key it (draftWithFieldAdded + addKey)", () => {
    const imported = draftFromTerms(
      typeConfusedSsnImport(),
      seedFor(),
      3600,
      [],
    );
    const retypedMetadata = metadata.map((column) =>
      column.name === "extra_col"
        ? { ...column, type: "ssn" as const }
        : column,
    );
    const retyped = setDraftMetadata(imported, retypedMetadata, []);
    const withAddedField = draftWithFieldAdded(retyped, "ssn");
    // The added field's output/name is bound to extra_col; find it so a key can
    // reference it and it actually materializes in the built linkageFields (an
    // unreferenced added field would otherwise be filtered out, which would not
    // exercise the collision this guard prevents).
    const addedOutput = withAddedField.standardization.find(
      (t) => t.input === "extra_col",
    )?.output;
    expect(addedOutput).toBeDefined();
    const keyed = addKey(withAddedField, addedOutput!);
    assertNoDuplicateFieldNames(buildAdvancedTerms(keyed));
  });

  test("re-importing the same adversarial document over an already-imported draft", () => {
    const crafted = typeConfusedSsnImport();
    const firstImport = draftFromTerms(crafted, seedFor(), 3600, []);
    assertNoDuplicateFieldNames(buildAdvancedTerms(firstImport));
    // A second import replaces importedLinkageFields wholesale (draftFromTerms is
    // not incremental), but re-runs the same reconciliation -- re-importing must be
    // as safe as the first import.
    const secondImport = draftFromTerms(crafted, seedFor(), 3600, []);
    assertNoDuplicateFieldNames(buildAdvancedTerms(secondImport));
  });

  test("a fresh (non-imported) draft that adds and keys a same-typed field never collides either", () => {
    // The non-import path: draftWithFieldAdded's uniquified `${base}_${n}` naming is
    // the guard that keeps this path collision-free (buildAdvancedTerms'
    // importedLinkageFields === undefined branch, so reconcileImportedFields never
    // runs). Built directly from the typed metadata (not seedAdvancedInvite's
    // inferMetadata, which reads column NAMES and would not recognize these as
    // linkage types), the same pattern the multi-field draft fixture above uses.
    const terms = getDefaultLinkageTerms("Inviter", metadata);
    const draft: AdvancedInviteDraft = {
      identity: "Inviter",
      lifetimeSeconds: 3600,
      outputDirection: "both",
      algorithm: "psi",
      deduplicate: false,
      linkageStrategy: "cascade",
      metadata,
      standardization: defaultStandardizationForRows(metadata, terms, []),
      keys: terms.linkageKeys.map((key) => ({ key, enabled: true })),
    };
    expect(draft.importedLinkageFields).toBeUndefined();
    const withAddedField = draftWithFieldAdded(draft, "ssn");
    const addedOutput = withAddedField.standardization.find(
      (t) => t.input === "ssn_col2",
    )?.output;
    expect(addedOutput).toBeDefined();
    const keyed = addKey(withAddedField, addedOutput!);
    assertNoDuplicateFieldNames(buildAdvancedTerms(keyed));
  });
});
