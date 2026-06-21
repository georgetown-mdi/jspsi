import { describe, expect, test } from "vitest";

import {
  SEMANTIC_TYPES,
  inferMetadata,
  isDisclosedToPartner,
} from "@psilink/core";

import {
  applyDisclosure,
  disclosedColumnNames,
  disclosureChoicesForType,
  disclosureOf,
  hasMultipleIdentifiers,
  normalizeForEditor,
  setColumnDisclosure,
  setColumnType,
} from "../../src/psi/metadataEditing.js";

import type { ColumnMetadata, Metadata } from "@psilink/core";

import type { DisclosureChoice } from "../../src/psi/metadataEditing.js";

function col(over: Partial<ColumnMetadata> & { name: string }): ColumnMetadata {
  return {
    type: "other",
    role: "payload",
    isPayload: true,
    ...over,
  };
}

describe("disclosure choice <-> {role, isPayload}", () => {
  // The single security-relevant mapping: each choice sets BOTH fields, and only
  // `payload` sends, so disclosedColumnNames (the preparePayload predicate) tracks
  // the control exactly.
  const cases: Array<[DisclosureChoice, ColumnMetadata["role"], boolean]> = [
    ["match", "linkage", false],
    ["identifier", "identifier", false],
    ["payload", "payload", true],
    ["ignored", "ignored", false],
  ];

  test.each(cases)(
    "applyDisclosure(%s) sets role and isPayload",
    (choice, role, isPayload) => {
      const out = applyDisclosure(col({ name: "x" }), choice);
      expect(out.role).toBe(role);
      expect(out.isPayload).toBe(isPayload);
      // Only the payload choice is disclosed to the partner.
      expect(isDisclosedToPartner(out)).toBe(choice === "payload");
    },
  );

  test.each(cases)("disclosureOf inverts applyDisclosure(%s)", (choice) => {
    expect(disclosureOf(applyDisclosure(col({ name: "x" }), choice))).toBe(
      choice,
    );
  });
});

describe("normalizeForEditor collapses off-diagonal inferred metadata", () => {
  test("an inferred identifier column is no longer silently disclosed", () => {
    // inferMetadata marks a sole `_id` column role:identifier yet isPayload:true --
    // an off-diagonal state preparePayload would transmit. Normalizing collapses it
    // to identifier + not-sent.
    const inferred = inferMetadata(["patient_id", "first_name", "notes"]);
    expect(disclosedColumnNames(inferred)).toContain("patient_id");

    const normalized = normalizeForEditor(inferred);
    expect(disclosedColumnNames(normalized)).not.toContain("patient_id");
    const idCol = normalized.find((c) => c.name === "patient_id");
    expect(idCol?.role).toBe("identifier");
    expect(idCol?.isPayload).toBe(false);
  });

  test("an inferred payload (other) column stays sent, a linkage column does not", () => {
    const normalized = normalizeForEditor(
      inferMetadata(["first_name", "notes"]),
    );
    // `notes` -> other/payload: still sent (and now visible). `first_name`: matched,
    // not sent.
    expect(disclosedColumnNames(normalized)).toEqual(["notes"]);
  });

  test("normalization is idempotent (already on the diagonal)", () => {
    const once = normalizeForEditor(inferMetadata(["patient_id", "ssn"]));
    expect(normalizeForEditor(once)).toEqual(once);
  });
});

describe("disclosedColumnNames mirrors what is sent", () => {
  test("lists exactly the payload, non-ignored columns in order", () => {
    const md: Metadata = [
      col({ name: "a", type: "first_name", role: "linkage", isPayload: false }),
      col({ name: "b", role: "payload", isPayload: true }),
      col({ name: "c", role: "ignored", isPayload: true }), // ignored wins
      col({ name: "d", role: "payload", isPayload: true }),
    ];
    expect(disclosedColumnNames(md)).toEqual(["b", "d"]);
  });
});

describe("single-identifier rule", () => {
  test("choosing identifier demotes any prior identifier to ignored (not sent)", () => {
    const md: Metadata = [
      col({
        name: "a",
        type: "identifier",
        role: "identifier",
        isPayload: false,
      }),
      col({ name: "b", type: "identifier", role: "payload", isPayload: true }),
    ];
    const { metadata: next, demotedIdentifiers } = setColumnDisclosure(
      md,
      "b",
      "identifier",
    );
    expect(demotedIdentifiers).toEqual(["a"]);
    expect(next.find((c) => c.name === "a")?.role).toBe("ignored");
    expect(next.find((c) => c.name === "b")?.role).toBe("identifier");
    // The displaced identifier is not silently disclosed.
    expect(disclosedColumnNames(next)).toEqual([]);
    expect(hasMultipleIdentifiers(next)).toBe(false);
  });

  test("demotes every prior identifier and names them all, not just the last", () => {
    // inferMetadata can seed two identifiers (an `id` and an `identifier` column),
    // so choosing identifier on a third column must demote both -- and report both,
    // or a screen-reader user hears only one displacement.
    const md: Metadata = [
      col({
        name: "a",
        type: "identifier",
        role: "identifier",
        isPayload: false,
      }),
      col({
        name: "b",
        type: "identifier",
        role: "identifier",
        isPayload: false,
      }),
      col({ name: "c", type: "first_name", role: "linkage", isPayload: false }),
    ];
    const { metadata: next, demotedIdentifiers } = setColumnDisclosure(
      md,
      "c",
      "identifier",
    );
    expect(demotedIdentifiers).toEqual(["a", "b"]);
    expect(next.find((x) => x.name === "a")?.role).toBe("ignored");
    expect(next.find((x) => x.name === "b")?.role).toBe("ignored");
    expect(next.find((x) => x.name === "c")?.role).toBe("identifier");
    expect(hasMultipleIdentifiers(next)).toBe(false);
  });

  test("editing a non-identifier column leaves a seeded identifier pair untouched", () => {
    // The rule only fires when an edit LANDS a column on the identifier role; it
    // never auto-resolves an inferred two-identifier seed (which would silently
    // pick one of two equally-valid identifiers). Editing an unrelated column must
    // leave both standing, so the grid error and launch gate still bite.
    const md: Metadata = [
      col({
        name: "a",
        type: "identifier",
        role: "identifier",
        isPayload: false,
      }),
      col({
        name: "b",
        type: "identifier",
        role: "identifier",
        isPayload: false,
      }),
      col({ name: "c", type: "first_name", role: "linkage", isPayload: false }),
    ];
    expect(
      hasMultipleIdentifiers(setColumnDisclosure(md, "c", "payload").metadata),
    ).toBe(true);
    expect(
      hasMultipleIdentifiers(setColumnType(md, "c", "last_name").metadata),
    ).toBe(true);
  });
});

describe("setColumnDisclosure discloses only on an explicit payload choice", () => {
  // The disclosure-path counterpart to the setColumnType safety property: a
  // disclosure edit sends the edited column iff the operator explicitly chose
  // `payload`, and never raises a bystander column's disclosure.
  const CHOICES: Array<DisclosureChoice> = [
    "match",
    "identifier",
    "payload",
    "ignored",
  ];
  for (const from of CHOICES)
    for (const to of CHOICES)
      test(`${from} -> ${to}`, () => {
        const target = applyDisclosure(col({ name: "x" }), from);
        const bystander = col({
          name: "y",
          type: "first_name",
          role: "linkage",
          isPayload: false,
        });
        const { metadata } = setColumnDisclosure([target, bystander], "x", to);
        expect(
          isDisclosedToPartner(metadata.find((c) => c.name === "x")!),
        ).toBe(to === "payload");
        expect(
          isDisclosedToPartner(metadata.find((c) => c.name === "y")!),
        ).toBe(false);
      });
});

describe("setColumnType keeps disclosure intent", () => {
  test("a not-sent column does not start being sent when its type changes", () => {
    const md: Metadata = [
      col({ name: "x", type: "first_name", role: "linkage", isPayload: false }),
    ];
    const next = setColumnType(md, "x", "other").metadata;
    expect(disclosureOf(next[0])).not.toBe("payload");
    expect(isDisclosedToPartner(next[0])).toBe(false);
  });

  test("a sent column stays sent when its type changes", () => {
    const md: Metadata = [
      col({ name: "y", type: "first_name", role: "payload", isPayload: true }),
    ];
    const next = setColumnType(md, "y", "other").metadata;
    expect(disclosureOf(next[0])).toBe("payload");
  });

  test("a sent column survives a retype to a matchable type (it is not demoted)", () => {
    // The highest-risk keep-branch case: retyping a deliberately-sent column to a
    // linkage or identifier type must KEEP it sent, not drop it to a not-sent
    // fallback. The "never starts disclosing" property below does not cover this
    // (staying sent), so pin it explicitly.
    const md: Metadata = [
      col({ name: "y", type: "other", role: "payload", isPayload: true }),
    ];
    expect(disclosureOf(setColumnType(md, "y", "first_name").metadata[0])).toBe(
      "payload",
    );
    expect(disclosureOf(setColumnType(md, "y", "identifier").metadata[0])).toBe(
      "payload",
    );
  });

  // The disclosure-safety invariant, as a property over the whole space rather
  // than two examples: changing a column's type must NEVER yield a sent column
  // unless it was already sent. This is the line the editor cannot cross.
  describe("a type change never starts disclosing a column", () => {
    const CHOICES: Array<DisclosureChoice> = [
      "match",
      "identifier",
      "payload",
      "ignored",
    ];
    for (const from of CHOICES)
      for (const type of SEMANTIC_TYPES)
        test(`${from} -> ${type}`, () => {
          const start = applyDisclosure(col({ name: "x" }), from);
          const out = setColumnType([start], "x", type).metadata[0];
          if (isDisclosedToPartner(out))
            expect(isDisclosedToPartner(start)).toBe(true);
        });
  });

  test("retyping a not-yet-usable column to a linkage type promotes it to match", () => {
    // The remap fix: an `ignored` column retyped to satisfy a field must actually
    // become usable (resolveFieldColumns skips `role: ignored`), not silently stay
    // ignored -- and `match` is not sent, so disclosure does not increase.
    const md: Metadata = [
      col({ name: "x", type: "other", role: "ignored", isPayload: false }),
    ];
    const out = setColumnType(md, "x", "first_name").metadata[0];
    expect(disclosureOf(out)).toBe("match");
    expect(isDisclosedToPartner(out)).toBe(false);
  });

  test("retyping an ignored column to other leaves it ignored", () => {
    // `other` cannot be matched, so there is nothing to promote it to: it stays
    // not-participating rather than being forced into a linkage role.
    const md: Metadata = [
      col({ name: "x", type: "first_name", role: "ignored", isPayload: false }),
    ];
    expect(disclosureOf(setColumnType(md, "x", "other").metadata[0])).toBe(
      "ignored",
    );
  });

  test("retyping to identifier lands on identifier and demotes the prior one", () => {
    // The single-identifier rule is enforced on the type path too: a retype that
    // mints a new identifier displaces the old one and reports it.
    const md: Metadata = [
      col({
        name: "old",
        type: "identifier",
        role: "identifier",
        isPayload: false,
      }),
      col({ name: "x", type: "first_name", role: "linkage", isPayload: false }),
    ];
    const { metadata, demotedIdentifiers } = setColumnType(
      md,
      "x",
      "identifier",
    );
    expect(disclosureOf(metadata.find((c) => c.name === "x")!)).toBe(
      "identifier",
    );
    expect(metadata.find((c) => c.name === "old")?.role).toBe("ignored");
    expect(demotedIdentifiers).toEqual(["old"]);
    expect(hasMultipleIdentifiers(metadata)).toBe(false);
  });
});

describe("disclosureChoicesForType gates nonsensical pairings", () => {
  test("identifier type offers identifier, not match", () => {
    expect(disclosureChoicesForType("identifier")).toEqual([
      "identifier",
      "payload",
      "ignored",
    ]);
  });
  test("other type can only be sent or ignored", () => {
    expect(disclosureChoicesForType("other")).toEqual(["payload", "ignored"]);
  });
  test("a linkage type offers match", () => {
    expect(disclosureChoicesForType("first_name")).toContain("match");
  });
});
