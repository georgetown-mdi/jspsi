import { Readable } from "node:stream";

import { describe, expect, test } from "vitest";

import {
  decodeInvitation,
  getDefaultLinkageTerms,
  inferMetadata,
  safeParseLinkageTerms,
} from "@psilink/core";

import {
  addElement,
  addKey,
  buildAdvancedTerms,
  gatedActiveSettingMessage,
  removeElement,
  removeKey,
  seedAdvancedInvite,
  updateElementAt,
  updateKeyAt,
} from "../../src/psi/advancedInvite.js";
import { generateInvitation } from "../../src/psi/invitation.js";

import type { LinkageKeyElement, LinkageTerms } from "@psilink/core";

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
  // These pin the gating WHILE the applied-flags are false (their state today).
  // When an applied-flag flips (the engine wires the feature in), the clamp stops
  // firing and these fail loudly, forcing the gating copy and tests to be updated
  // in lockstep -- the "fail if a control is wired ahead of engine support" guard.
  test("buildAdvancedTerms clamps psi-c, deduplicate, and fuzzy", () => {
    const { draft } = seedAdvancedInvite("Org", ALL_COLUMNS);
    // Force every gated setting on, bypassing the disabled controls, to prove the
    // build clamps regardless of how the draft reached this state.
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
                elements: entry.key.elements.map(
                  (el, j): LinkageKeyElement =>
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
    expect(terms.algorithm).toBe("psi");
    expect(terms.deduplicate).toBe(false);
    expect(
      terms.linkageKeys.every((key) =>
        key.elements.every((el) => el.generateFuzzyComparisons === undefined),
      ),
    ).toBe(true);
  });

  test("gatedActiveSettingMessage refuses an import that turns a gated setting on", () => {
    const base = getDefaultLinkageTerms("Org", inferMetadata(ALL_COLUMNS));
    expect(gatedActiveSettingMessage(base)).toBeUndefined();
    expect(gatedActiveSettingMessage({ ...base, algorithm: "psi-c" })).toMatch(
      /psi-c/,
    );
    expect(gatedActiveSettingMessage({ ...base, deduplicate: true })).toMatch(
      /duplicate/i,
    );
    expect(gatedActiveSettingMessage(withFuzzyOnFirstElement(base))).toMatch(
      /fuzzy/i,
    );
  });
});

describe("expert authoring round-trips", () => {
  test("a key authored element-by-element decodes back equal through generateInvitation", async () => {
    const { draft } = seedAdvancedInvite("County Health Dept", ALL_COLUMNS);
    // Author one key from scratch: two elements referencing declared fields, a
    // substring transform on the first, and a swap matching them in either order.
    let d: AdvancedInviteDraft = { ...draft, keys: [] };
    d = addKey(d, "first_name");
    d = addElement(d, 0, "last_name");
    d = updateElementAt(d, 0, 0, (el) => ({
      ...el,
      transform: [{ function: "substring", params: { start: 1, length: 1 } }],
    }));
    d = updateKeyAt(d, 0, (key) => ({
      ...key,
      swap: ["first_name", "last_name"],
    }));

    const authored = buildAdvancedTerms(d);
    // It is valid and satisfiable so generateInvitation accepts it.
    expect(safeParseLinkageTerms(authored).success).toBe(true);

    const { encoded } = await generateInvitation({
      inviterName: authored.identity,
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

describe("addElement keeps element identifiers unique within a key", () => {
  test("a second element of the same field gets a distinct alias, not a colliding identifier", () => {
    const { draft } = seedAdvancedInvite("Org", ALL_COLUMNS);
    // The repro that tore down the editor: a fresh key carries one element of the
    // first declared field, and the picker defaults the next element to that same
    // field -- so both took the bare "first_name" identifier. addElement now aliases
    // the second so the two are told apart.
    let d: AdvancedInviteDraft = { ...draft, keys: [] };
    d = addKey(d, "first_name");
    d = addElement(d, 0, "first_name");

    const elements = d.keys[0].key.elements;
    expect(elements).toHaveLength(2);
    expect(elements[0]).toEqual({ field: "first_name" });
    expect(elements[1].field).toBe("first_name");
    expect(elements[1].name).toBe("first_name_2");

    // The identifiers (`name ?? field`) the schema requires unique -- and the values
    // the swap control offers -- carry no duplicate, so no Select is ever fed a
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

  test("two elements sharing an identifier are schema-invalid, so the alias is load-bearing", () => {
    const { draft } = seedAdvancedInvite("Org", ALL_COLUMNS);
    let d: AdvancedInviteDraft = { ...draft, keys: [] };
    d = addKey(d, "first_name");
    // Force the collision addElement now avoids: a second bare first_name element.
    d = updateKeyAt(d, 0, (key) => ({
      ...key,
      elements: [...key.elements, { field: "first_name" }],
    }));
    expect(safeParseLinkageTerms(buildAdvancedTerms(d)).success).toBe(false);
  });
});
