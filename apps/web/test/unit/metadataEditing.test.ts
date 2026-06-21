import { describe, expect, test } from "vitest";

import { inferMetadata, isDisclosedToPartner } from "@psilink/core";

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
    const { metadata: next, demotedIdentifier } = setColumnDisclosure(
      md,
      "b",
      "identifier",
    );
    expect(demotedIdentifier).toBe("a");
    expect(next.find((c) => c.name === "a")?.role).toBe("ignored");
    expect(next.find((c) => c.name === "b")?.role).toBe("identifier");
    // The displaced identifier is not silently disclosed.
    expect(disclosedColumnNames(next)).toEqual([]);
    expect(hasMultipleIdentifiers(next)).toBe(false);
  });
});

describe("setColumnType keeps disclosure intent", () => {
  test("a not-sent column does not start being sent when its type changes", () => {
    const md: Metadata = [
      col({ name: "x", type: "first_name", role: "linkage", isPayload: false }),
    ];
    const next = setColumnType(md, "x", "other");
    expect(disclosureOf(next[0])).not.toBe("payload");
    expect(isDisclosedToPartner(next[0])).toBe(false);
  });

  test("a sent column stays sent when its type changes", () => {
    const md: Metadata = [
      col({ name: "y", type: "first_name", role: "payload", isPayload: true }),
    ];
    const next = setColumnType(md, "y", "other");
    expect(disclosureOf(next[0])).toBe("payload");
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
