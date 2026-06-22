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
