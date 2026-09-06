import { describe, expect, test } from "vitest";

import {
  canonicalString,
  getDefaultLinkageTerms,
  inferMetadata,
  safeParseLinkageTerms,
} from "@psilink/core";

import {
  addElement,
  addKey,
  draftFromTerms,
  draftWithFieldAdded,
  draftWithKeyEnabled,
  moveElement,
  removeElement,
  removeKey,
  seedAdvancedInvite,
  setDraftMetadata,
  setDraftMetadataKeepingKeys,
} from "../../../src/psi/authoring/advancedInviteDraft.js";
import {
  buildAdvancedTerms,
  gradeAuthoredKeys,
} from "../../../src/psi/authoring/advancedInviteTerms.js";
import { setColumnType } from "../../../src/psi/metadataEditing.js";

import type { AdvancedInviteDraft } from "../../../src/psi/authoring/advancedInviteTypes.js";

const ALL_COLUMNS = ["ssn", "ssn4", "first_name", "last_name", "dob"];

describe("gradeAuthoredKeys", () => {
  test("grades every seeded key satisfiable when the columns supply them all", () => {
    const { draft, seed } = seedAdvancedInvite("Org", ALL_COLUMNS);
    const fitness = gradeAuthoredKeys(
      draft.metadata,
      draft.standardization,
      seed.columns,
      draft.keys.map((entry) => entry.key),
    );
    expect(fitness).toHaveLength(draft.keys.length);
    expect(fitness.every((grade) => grade === "satisfiable")).toBe(true);
  });

  test("grades only the keys needing an absent column unsatisfiable", () => {
    const { draft } = seedAdvancedInvite("Org", ALL_COLUMNS);
    // The draft still declares an ssn field, but the operator's actual file no
    // longer has the ssn column, so every key referencing it collapses -- and
    // nothing else does, so the grade is specific to the missing column rather than
    // a blanket failure.
    const columnsMissingSsn = ALL_COLUMNS.filter((name) => name !== "ssn");
    const keys = draft.keys.map((entry) => entry.key);
    const fitness = gradeAuthoredKeys(
      draft.metadata,
      draft.standardization,
      columnsMissingSsn,
      keys,
    );
    const needsSsn = keys.map((key) =>
      key.elements.some((element) => element.field === "ssn"),
    );
    expect(needsSsn.some((needs) => needs)).toBe(true);
    expect(needsSsn.some((needs) => !needs)).toBe(true);
    expect(fitness).toEqual(
      needsSsn.map((needs) => (needs ? "unsatisfiable" : "satisfiable")),
    );
  });
});

describe("no draft edit builds terms holding an explicitly-undefined property", () => {
  // The canonical encoding rejects a property stated as `undefined` where it
  // accepts an absent one, so terms built from such a draft fail the Generate
  // gate. No draft-editing operation or import produces that shape; the expert
  // editor's own key, alias, transform, and fuzzy handlers clear optionals with
  // `delete` and are covered by review and the encode gate, not here.

  /** Every path in `value` whose property is present and stated as `undefined`. */
  function explicitUndefinedPaths(value: unknown, at = "$"): Array<string> {
    if (typeof value !== "object" || value === null) return [];
    if (Array.isArray(value))
      return value.flatMap((entry, index) =>
        entry === undefined
          ? [`${at}[${index}]`]
          : explicitUndefinedPaths(entry, `${at}[${index}]`),
      );
    return Object.entries(value).flatMap(([property, child]) =>
      child === undefined
        ? [`${at}.${property}`]
        : explicitUndefinedPaths(child, `${at}.${property}`),
    );
  }

  test("the helper finds the shape it is looking for", () => {
    // Without this the sweep below could pass by finding nothing anywhere.
    expect(explicitUndefinedPaths({ a: { b: [{ c: undefined }] } })).toEqual([
      "$.a.b[0].c",
    ]);
    expect(
      explicitUndefinedPaths({ a: [undefined, { b: undefined }] }),
    ).toEqual(["$.a[0]", "$.a[1].b"]);
    expect(explicitUndefinedPaths({ a: { b: 1 } })).toEqual([]);
  });

  test("every draft-editing operation and the import build encodable terms", () => {
    const { draft, seed } = seedAdvancedInvite("Org", ALL_COLUMNS);
    const lastKey = draft.keys.length - 1;
    const withNewKey = addKey(draft, "first_name");
    const withTwoElements = addElement(
      withNewKey,
      withNewKey.keys.length - 1,
      "last_name",
    );

    const metadata = inferMetadata(ALL_COLUMNS, []);
    const document = getDefaultLinkageTerms("Author", metadata);
    const parsed = safeParseLinkageTerms(
      JSON.parse(JSON.stringify(document)) as unknown,
    );
    if (!parsed.success) throw new Error("the exported document did not parse");

    const edited: Record<string, AdvancedInviteDraft> = {
      seeded: draft,
      keyEnabled: draftWithKeyEnabled(draft, lastKey, true),
      keyDisabled: draftWithKeyEnabled(draft, lastKey, false),
      keyAdded: withNewKey,
      keyRemoved: removeKey(withTwoElements, 0),
      elementAdded: withTwoElements,
      elementMoved: moveElement(
        withTwoElements,
        withTwoElements.keys.length - 1,
        0,
        1,
      ),
      elementRemoved: removeElement(
        withTwoElements,
        withTwoElements.keys.length - 1,
        1,
      ),
      fieldAdded: draftWithFieldAdded(draft, "first_name"),
      retyped: setDraftMetadata(
        draft,
        setColumnType(draft.metadata, "dob", "other").metadata,
        [],
      ),
      retypedKeepingKeys: setDraftMetadataKeepingKeys(
        draft,
        setColumnType(draft.metadata, "ssn4", "other").metadata,
        [],
      ),
      imported: draftFromTerms(parsed.data, seed),
    };

    for (const [label, candidate] of Object.entries(edited)) {
      const terms = buildAdvancedTerms(candidate);
      expect([label, explicitUndefinedPaths(terms)]).toEqual([label, []]);
      expect(() => canonicalString(terms), label).not.toThrow();
    }
  });
});
