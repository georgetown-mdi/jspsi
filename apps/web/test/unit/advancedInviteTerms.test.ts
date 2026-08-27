import { describe, expect, test } from "vitest";

import { gradeAuthoredKeys } from "../../src/psi/advancedInviteTerms.js";
import { seedAdvancedInvite } from "../../src/psi/advancedInviteDraft.js";

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
    // longer carries the ssn column, so every key referencing it collapses -- and
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
