import { Readable } from "node:stream";

import { describe, expect, test } from "vitest";

import {
  decodeInvitation,
  deriveAcceptedLinkageTerms,
  getDefaultLinkageTerms,
  inferMetadata,
  prepareForExchange,
  safeParseLinkageTerms,
  validateStandardizationAgainstTerms,
} from "@psilink/core";

import {
  addElement,
  addKey,
  buildAdvancedTerms,
  draftWithKeyEnabled,
  gatedActiveSettingMessage,
  inviterExchangeDataSpec,
  removeElement,
  removeKey,
  seedAdvancedInvite,
  updateElementAt,
  updateKeyAt,
  validateAdvancedInvite,
} from "../../src/psi/advancedInvite.js";
import { generateInvitation } from "../../src/psi/invitation.js";

import type { CSVRow, LinkageKeyElement, LinkageTerms } from "@psilink/core";

import type { AdvancedInviteDraft } from "../../src/psi/advancedInvite.js";
import type { InvitationLocation } from "../../src/psi/invitation.js";

const ALL_COLUMNS = ["ssn", "ssn4", "first_name", "last_name", "dob"];
const ALL_COLUMNS_CSV =
  "ssn,ssn4,first_name,last_name,dob\n123456789,6789,Alice,Smith,1990-01-02\n";
const location: InvitationLocation = {
  origin: "https://example.org:8443",
  hostname: "example.org",
  port: "8443",
};
function csvStream(content: string = ALL_COLUMNS_CSV): Readable {
  return Readable.from(content);
}

/** Set `generateFuzzyComparisons` on element 0 of key 0 of a terms object. */
function withFuzzyOnFirstElement(terms: LinkageTerms): LinkageTerms {
  return {
    ...terms,
    linkageKeys: terms.linkageKeys.map((key, ki) =>
      ki === 0
        ? {
            ...key,
            elements: key.elements.map((el, ei) =>
              ei === 0
                ? { ...el, generateFuzzyComparisons: "transpositions" }
                : el,
            ),
          }
        : key,
    ),
  };
}

describe("gated settings cannot reach the built terms", () => {
  // These pin the gating WHILE an applied-flag is false. When one flips (the
  // engine wires the feature in), the clamp stops firing and these fail loudly,
  // forcing the gating copy and tests to be updated in lockstep -- the "fail if a
  // control is wired ahead of engine support" guard. Two settings sit outside
  // that set because the exchange honors them: the algorithm, and deduplicate.
  test("buildAdvancedTerms clamps fuzzy, and writes the algorithm and deduplicate through", () => {
    const { draft } = seedAdvancedInvite("Org", ALL_COLUMNS);
    // Force the gated setting on, bypassing the disabled control, to prove the
    // build clamps regardless of how the draft reached this state. The other two
    // are set alongside it to prove the clamp is per setting rather than a blanket
    // one: each reaches the built terms and is judged there by the rules that
    // apply to it.
    const forced: AdvancedInviteDraft = {
      ...draft,
      algorithm: "psi-c",
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
    expect(terms.algorithm).toBe("psi-c");
    expect(terms.deduplicate).toBe(true);
    expect(
      terms.linkageKeys.every((key) =>
        key.elements.every((el) => el.generateFuzzyComparisons === undefined),
      ),
    ).toBe(true);
  });

  test("gatedActiveSettingMessage refuses an import that turns a held-back setting on", () => {
    const base = getDefaultLinkageTerms("Org", inferMetadata(ALL_COLUMNS));
    expect(gatedActiveSettingMessage(base)).toBeUndefined();
    // The algorithm is not held back at all: an imported count-only document is
    // judged by the count-only shape rules, which validateAdvancedInvite applies.
    expect(
      gatedActiveSettingMessage({ ...base, algorithm: "psi-c" }),
    ).toBeUndefined();
    // Nor is a deduplicating term, which the exchange does apply -- this door is
    // closed against a setting the run would silently drop, not against every
    // setting an editor control gates.
    expect(
      gatedActiveSettingMessage({ ...base, deduplicate: true }),
    ).toBeUndefined();
    // The one that is held back: the exchange applies no fuzzy expansion.
    expect(gatedActiveSettingMessage(withFuzzyOnFirstElement(base))).toMatch(
      /fuzzy/i,
    );
  });
});

describe("expert authoring round-trips", () => {
  test("a key authored element-by-element decodes back equal through generateInvitation", async () => {
    const { draft } = seedAdvancedInvite("County Health Dept", ALL_COLUMNS);
    // Author one key from scratch: two elements referencing declared fields, a
    // substring transform, and a swap matching them in either order. The swapped
    // pair holds ONE transform across both positions, which is what the terms
    // admit -- a swap moves the field references and leaves each transform where
    // it is, so a pair whose transforms differ is refused.
    const initial = [
      { function: "substring", params: { start: 1, length: 1 } },
    ];
    let d: AdvancedInviteDraft = { ...draft, keys: [] };
    d = addKey(d, "first_name");
    d = addElement(d, 0, "last_name");
    d = updateElementAt(d, 0, 0, (el) => ({ ...el, transform: initial }));
    d = updateElementAt(d, 0, 1, (el) => ({ ...el, transform: initial }));
    d = updateKeyAt(d, 0, (key) => ({
      ...key,
      swap: ["first_name", "last_name"],
    }));

    const authored = buildAdvancedTerms(d);
    // It is valid and satisfiable so generateInvitation accepts it.
    expect(safeParseLinkageTerms(authored).success).toBe(true);

    const { encoded } = await generateInvitation({
      inviterName: d.identity,
      file: csvStream(),
      location,
      linkageTerms: authored,
      metadata: d.metadata,
    });
    const token = await decodeInvitation(encoded);
    // The authored fields, the element transform, and the swap survive the encode
    // and decode byte-for-byte -- the cross-party contract is exactly what was
    // authored.
    expect(token.linkageTerms).toStrictEqual(authored);
  });

  test("removing a swapped element prunes the now-orphaned swap", () => {
    const { draft } = seedAdvancedInvite("Org", ALL_COLUMNS);
    let d: AdvancedInviteDraft = { ...draft, keys: [] };
    d = addKey(d, "first_name");
    d = addElement(d, 0, "last_name");
    d = updateKeyAt(d, 0, (key) => ({
      ...key,
      swap: ["first_name", "last_name"],
    }));
    expect(d.keys[0].key.swap).toEqual(["first_name", "last_name"]);
    // Removing last_name orphans its swap target, so the swap is pruned rather
    // than left dangling to block Generate.
    d = removeElement(d, 0, 1);
    expect(d.keys[0].key.swap).toBeUndefined();
  });

  test("re-pointing a swapped element's field prunes the now-orphaned swap", () => {
    const { draft } = seedAdvancedInvite("Org", ALL_COLUMNS);
    let d: AdvancedInviteDraft = { ...draft, keys: [] };
    d = addKey(d, "first_name");
    d = addElement(d, 0, "last_name");
    d = updateKeyAt(d, 0, (key) => ({
      ...key,
      swap: ["first_name", "last_name"],
    }));
    // Changing element 0's field from first_name to ssn changes its identifier,
    // orphaning the "first_name" swap target.
    d = updateElementAt(d, 0, 0, (el) => ({ ...el, field: "ssn" }));
    expect(d.keys[0].key.swap).toBeUndefined();
  });

  test("removeKey and the element helpers keep the terms schema-valid", () => {
    const { draft } = seedAdvancedInvite("Org", ALL_COLUMNS);
    // Field references are the declared field names (type-derived, e.g.
    // "date_of_birth"), not the column names ("dob") -- the field-pickers offer
    // exactly these, so an authored element is referentially valid.
    let d = addKey(draft, "ssn");
    d = addElement(d, d.keys.length - 1, "date_of_birth");
    d = removeKey(d, 0);
    expect(safeParseLinkageTerms(buildAdvancedTerms(d)).success).toBe(true);
  });
});

describe("an expert-authored key over a recognized type cleans as its partner does", () => {
  // The expert editor offers a field for every matchable column, including
  // types no built-in key uses (phone_number, email_address, zip_code); the
  // authored-field derivation declares each under the type's own name whether
  // or not the draft cleans it. Without a cleaning pipeline for the column,
  // this party would hash the raw cell while the accepting party hashes the
  // cleaned one, and the key would match nothing.
  const COLUMNS = ["first_name", "last_name", "dob", "zip", "phone", "email"];
  const ROWS: Array<CSVRow> = [
    {
      first_name: "Ada",
      last_name: "Lovelace",
      dob: "12/10/1815",
      zip: "20001-1234",
      phone: "(202) 555-0143",
      email: "  Ada@Example.ORG  ",
    },
  ];

  /** A compound key over last name and `field`, authored through the expert
   * editor's own operations on a draft holding no keys -- the "Add a key" button
   * followed by "Add an element", with the field picked from the declared list. */
  function expertKeyed(field: string): AdvancedInviteDraft {
    const { draft } = seedAdvancedInvite("Inviter", COLUMNS, ROWS);
    return addElement(addKey({ ...draft, keys: [] }, "last_name"), 0, field);
  }

  /** What each party's own preparation produces for `field` from the same row: the
   * inviter through the standardization it authored, the acceptor through the one
   * it derives from the terms alone (it holds none of its own). */
  function cleanedByBothParties(
    draft: AdvancedInviteDraft,
    field: string,
  ): [unknown, unknown] {
    const terms = buildAdvancedTerms(draft);
    const inviter = prepareForExchange(
      inviterExchangeDataSpec(terms, {
        metadata: draft.metadata,
        standardization: draft.standardization,
      }),
      "Inviter",
      ROWS,
      COLUMNS,
    );
    const acceptor = prepareForExchange(
      { linkageTerms: deriveAcceptedLinkageTerms(terms, "Acceptor") },
      "Acceptor",
      ROWS,
      COLUMNS,
    );
    return [
      inviter.dataset.getField(field)?.get(0),
      acceptor.dataset.getField(field)?.get(0),
    ];
  }

  test.each([
    ["zip_code", "20001-1234", "20001"],
    ["phone_number", "(202) 555-0143", "2025550143"],
    ["email_address", "  Ada@Example.ORG  ", "ada@example.org"],
  ])("%s matches cleaned on both sides, not raw", (field, raw, cleaned) => {
    const draft = expertKeyed(field);
    const [inviterValue, acceptorValue] = cleanedByBothParties(draft, field);
    expect(inviterValue).toEqual([cleaned]);
    expect(acceptorValue).toEqual(inviterValue);
    // The assumption: the two would have disagreed. The raw cell is not the
    // cleaned value, so a party matching on it matches nothing the other offers.
    expect(cleaned).not.toEqual(raw);
  });

  test("the authored key generates and mints holding its cleaning", async () => {
    const { seed } = seedAdvancedInvite("Inviter", COLUMNS, ROWS);
    const draft = expertKeyed("zip_code");
    const terms = buildAdvancedTerms(draft);
    expect(safeParseLinkageTerms(terms).success).toBe(true);
    expect(
      validateAdvancedInvite(draft, seed, new Date("2026-06-20T00:00:00.000Z"))
        .errors,
    ).toEqual({});

    const minted = await generateInvitation({
      inviterName: draft.identity,
      profiledColumns: COLUMNS,
      location,
      lifetimeSeconds: draft.lifetimeSeconds,
      linkageTerms: terms,
      metadata: draft.metadata,
      standardization: draft.standardization,
    });
    // The mint reconciles the cleaning to the terms it embeds, so what an
    // invitation hands its keeper holds the pipeline rather than dropping it.
    expect(
      validateStandardizationAgainstTerms(
        minted.standardization ?? [],
        minted.linkageTerms,
      ),
    ).toEqual([]);
    const mintedZip = minted.standardization?.find(
      (t) => t.output === "zip_code",
    );
    expect(mintedZip?.input).toBe("zip");
    expect(mintedZip?.steps?.length).toBeGreaterThan(0);
  });

  test("keying a type the guided offer already turned on adds no second pipeline", () => {
    // The offer's checkbox binds the same type-named field this key references, so
    // the expert edit must find the cleaning already there and leave it -- including
    // any steps the operator edited into it -- rather than appending a duplicate
    // output the built terms could not declare twice.
    const { draft } = seedAdvancedInvite("Inviter", COLUMNS, ROWS);
    const offered = draft.keys.findIndex((entry) =>
      entry.key.elements.some((element) => element.field === "zip_code"),
    );
    expect(offered).toBeGreaterThan(-1);
    const on = draftWithKeyEnabled(draft, offered, true);
    const edited: AdvancedInviteDraft = {
      ...on,
      standardization: on.standardization.map((transformation) =>
        transformation.output === "zip_code"
          ? { ...transformation, steps: [{ function: "trim_whitespace" }] }
          : transformation,
      ),
    };

    const keyed = addElement(
      addKey(edited, "last_name"),
      edited.keys.length,
      "zip_code",
    );
    const zip = keyed.standardization.filter((t) => t.output === "zip_code");
    expect(zip).toHaveLength(1);
    expect(zip[0].steps).toEqual([{ function: "trim_whitespace" }]);
  });
});

describe("addElement keeps element identifiers unique within a key", () => {
  test("a second element of the same field gets a distinct alias, not a colliding identifier", () => {
    const { draft } = seedAdvancedInvite("Org", ALL_COLUMNS);
    // A fresh key holds one element of the first declared field, and the picker
    // defaults the next element to that same field -- both would take the bare
    // "first_name" identifier, so addElement aliases the second to tell them apart.
    let d: AdvancedInviteDraft = { ...draft, keys: [] };
    d = addKey(d, "first_name");
    d = addElement(d, 0, "first_name");

    const elements = d.keys[0].key.elements;
    expect(elements).toHaveLength(2);
    expect(elements[0]).toEqual({ field: "first_name" });
    expect(elements[1].field).toBe("first_name");
    expect(elements[1].name).toBe("first_name_2");

    // The identifiers (`name ?? field`) the schema requires unique -- and the values
    // the swap control offers -- contain no duplicate, so no Select is ever fed a
    // colliding option set.
    const ids = elements.map((el) => el.name ?? el.field);
    expect(new Set(ids).size).toBe(ids.length);
    // The built terms are schema-valid: the duplicate-identifier refine passes.
    expect(safeParseLinkageTerms(buildAdvancedTerms(d)).success).toBe(true);
  });

  test("a second element of a different field needs no alias", () => {
    const { draft } = seedAdvancedInvite("Org", ALL_COLUMNS);
    let d: AdvancedInviteDraft = { ...draft, keys: [] };
    d = addKey(d, "first_name");
    d = addElement(d, 0, "last_name");
    // No identifier collision, so the element stays a bare field reference with no
    // spurious alias (the round-trip and swap tests above rely on this shape).
    expect(d.keys[0].key.elements[1]).toEqual({ field: "last_name" });
  });

  test("the alias steps past an existing alias that already holds the next name", () => {
    const { draft } = seedAdvancedInvite("Org", ALL_COLUMNS);
    let d: AdvancedInviteDraft = { ...draft, keys: [] };
    d = addKey(d, "first_name");
    // Two existing elements: the bare field ("first_name") and one already aliased
    // "first_name_2". The next first_name element collides with the bare field AND
    // its first candidate alias is taken, so it must step to "first_name_3".
    d = updateKeyAt(d, 0, (key) => ({
      ...key,
      elements: [
        { field: "first_name" },
        { field: "first_name", name: "first_name_2" },
      ],
    }));
    d = addElement(d, 0, "first_name");
    expect(d.keys[0].key.elements[2].name).toBe("first_name_3");
    const ids = d.keys[0].key.elements.map((el) => el.name ?? el.field);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("two elements sharing an identifier are schema-invalid, so the alias is required", () => {
    const { draft } = seedAdvancedInvite("Org", ALL_COLUMNS);
    let d: AdvancedInviteDraft = { ...draft, keys: [] };
    d = addKey(d, "first_name");
    // Force the collision addElement avoids: a second bare first_name element.
    d = updateKeyAt(d, 0, (key) => ({
      ...key,
      elements: [...key.elements, { field: "first_name" }],
    }));
    expect(safeParseLinkageTerms(buildAdvancedTerms(d)).success).toBe(false);
  });
});
