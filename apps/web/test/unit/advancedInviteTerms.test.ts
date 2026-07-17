import { describe, expect, test } from "vitest";

import { authoredLinkageFields } from "@psilink/core";

import { producibleFieldNames } from "../../src/psi/advancedInviteTerms.js";
import { seedAdvancedInvite } from "../../src/psi/advancedInviteDraft.js";

const ALL_COLUMNS = ["ssn", "ssn4", "first_name", "last_name", "dob"];

describe("producibleFieldNames", () => {
  test("returns every default field when the columns supply them all", () => {
    const { draft, seed } = seedAdvancedInvite("Org", ALL_COLUMNS);
    const producible = producibleFieldNames(
      draft.metadata,
      draft.standardization,
      seed.columns,
    );
    const authored = new Set(
      authoredLinkageFields(draft.metadata, draft.standardization).map(
        (field) => field.name,
      ),
    );
    // With every column present, the producible set is exactly the authored
    // universe -- nothing is judged unsatisfiable.
    expect(producible).toStrictEqual(authored);
  });

  test("omits a field whose bound column is absent from the operator's file", () => {
    const { draft } = seedAdvancedInvite("Org", ALL_COLUMNS);
    // The draft still declares an ssn field, but the operator's actual file no
    // longer carries the ssn column, so ssn cannot be produced.
    const columnsMissingSsn = ALL_COLUMNS.filter((name) => name !== "ssn");
    const producible = producibleFieldNames(
      draft.metadata,
      draft.standardization,
      columnsMissingSsn,
    );
    expect(producible.has("ssn")).toBe(false);
    // A field whose column is still present stays producible, so the omission is
    // specific to the missing column, not a blanket failure.
    expect(producible.has("first_name")).toBe(true);
  });
});
