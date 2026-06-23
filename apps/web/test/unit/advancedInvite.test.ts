import { describe, expect, test } from "vitest";

import {
  MAX_INVITATION_LIFETIME_SECONDS,
  assertPayloadSendDisclosed,
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
  disclosedColumnNames,
  setColumnDisclosure,
  setColumnType,
} from "../../src/psi/metadataEditing.js";

import type {
  AdvancedInviteDraft,
  AdvancedInviteSeed,
  OutputDirection,
} from "../../src/psi/advancedInvite.js";

import type { LinkageTerms, Metadata } from "@psilink/core";

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
    // The exact core reject this guard keeps the operator clear of (202710475)
    // accepts the editor's send against the same metadata.
    expect(() =>
      assertPayloadSendDisclosed(built.payload, metadata),
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
    // local-only invariance test above. Scope: this covers terms the editor itself
    // produced (default constraints, default field order). An externally-authored
    // document carrying custom field constraints or a different cross-type field order
    // is normalized by authoredLinkageFields on rebuild -- a separate, pre-existing
    // limitation tracked on its own, not exercised here.
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
   * its own key, plus a date column the keys do not use. The export carries all
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
    // column. Before this change satisfiableKeyCount was 2 yet canGenerate was false
    // with the misleading "Enable at least one linkage key." -- the third key dangled
    // the built terms and the referential-integrity failure masked the satisfiable
    // subset. Now the import disables the third key so the two satisfiable keys
    // generate, while the unsupplyable key stays visible (disabled) to re-enable later.
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
    // Both same-typed fields bind against the two columns, so no key is disabled --
    // the import behaves exactly as before this change.
    const document = buildAdvancedTerms({
      identity: "Inviter",
      lifetimeSeconds: 3600,
      outputDirection: "both",
      algorithm: "psi",
      deduplicate: false,
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
