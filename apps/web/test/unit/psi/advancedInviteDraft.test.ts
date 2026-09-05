import { describe, expect, test } from "vitest";

import { deriveAcceptedLinkageTerms, prepareForExchange } from "@psilink/core";

import {
  addKey,
  buildAdvancedTerms,
  inviterExchangeDataSpec,
} from "../../../src/psi/authoring/advancedInvite.js";
import {
  draftWithFieldAdded,
  seedAdvancedInvite,
  setDraftMetadata,
  setDraftMetadataKeepingKeys,
} from "../../../src/psi/authoring/advancedInviteDraft.js";

import type { CSVRow, Metadata } from "@psilink/core";

const ALL_COLUMNS = ["ssn", "ssn4", "first_name", "last_name", "dob"];

/** Retype the `ssn` column to `first_name`, so its standardization transformation
 * is no longer valid for its column's type. */
function retypeSsnToFirstName(metadata: Metadata): Metadata {
  return metadata.map((column) =>
    column.name === "ssn" ? { ...column, type: "first_name" } : column,
  );
}

describe("setDraftMetadataKeepingKeys", () => {
  test("leaves the key set untouched while swapping in the new metadata", () => {
    const { draft } = seedAdvancedInvite("Org", ALL_COLUMNS);
    const metadata = retypeSsnToFirstName(draft.metadata);
    const kept = setDraftMetadataKeepingKeys(draft, metadata);

    // The key set is byte-identical -- this variant is for an authored/imported key
    // set, where the template-driven key reconciliation must NOT run and silently
    // drop keys the operator authored.
    expect(kept.keys).toStrictEqual(draft.keys);
    expect(kept.metadata).toBe(metadata);
  });

  test("reconciles the standardization even though it keeps the keys", () => {
    const { draft } = seedAdvancedInvite("Org", ALL_COLUMNS);
    expect(draft.standardization.some((t) => t.output === "ssn")).toBe(true);

    const metadata = retypeSsnToFirstName(draft.metadata);
    const kept = setDraftMetadataKeepingKeys(draft, metadata);

    // The ssn column was retyped, so its stale transformation is dropped -- the
    // standardization reconciliation is orthogonal to the key set and applies here
    // exactly as it does on the key-reconciling path.
    expect(kept.standardization.some((t) => t.output === "ssn")).toBe(false);
  });

  test("keeps the keys setDraftMetadata re-derives away, on the same standardization", () => {
    const { draft } = seedAdvancedInvite("Org", ALL_COLUMNS);
    const metadata = retypeSsnToFirstName(draft.metadata);

    const kept = setDraftMetadataKeepingKeys(draft, metadata);
    const reconciled = setDraftMetadata(draft, metadata);

    // The full setDraftMetadata re-derives the offerable key set (dropping keys the
    // retype makes unofferable), so it ends with fewer keys; the keep-keys variant
    // preserves the count.
    expect(kept.keys.length).toBe(draft.keys.length);
    expect(reconciled.keys.length).toBeLessThan(draft.keys.length);
    // Both run the same standardization reconciliation over the keys they end
    // with. The key-reconciling path also withdraws the cleaning an opt-in offer
    // minted for a key it just dropped; no column here is of an opt-in type, so
    // there is none to withdraw and the two standardizations agree.
    expect(kept.standardization).toStrictEqual(reconciled.standardization);
  });
});

describe("draftWithFieldAdded", () => {
  // Two columns of one opt-in type, so the type's FIRST field and its second are
  // both reachable, and a guided draft has cleaning for neither (the offers
  // arrive off).
  const ZIP_COLUMNS = ["first_name", "last_name", "dob", "zip", "zipcode"];
  const ZIP_ROWS: Array<CSVRow> = [
    {
      first_name: "Ada",
      last_name: "Lovelace",
      dob: "12/10/1815",
      zip: "20001-1234",
      zipcode: "20002-5678",
    },
  ];

  test("the first field of a type takes the type's own name and its recommended cleaning", () => {
    const { draft } = seedAdvancedInvite("Org", ZIP_COLUMNS, ZIP_ROWS);
    expect(draft.standardization.some((t) => t.output === "zip_code")).toBe(
      false,
    );

    const added = draftWithFieldAdded(draft, "zip_code");
    const first = added.standardization.at(-1);
    // The bare type name, not `zip_code_2`: a first field named for a second is
    // treated as one of a pair whose other half does not exist, and is the name no
    // key picker offers a field under.
    expect(first?.output).toBe("zip_code");
    expect(first?.input).toBe("zip");
    // With the recommended pipeline, so keying it matches what the accepting party
    // -- deriving its cleaning from these same terms -- matches.
    const keyed = addKey(added, "zip_code");
    const terms = buildAdvancedTerms(keyed);
    const inviter = prepareForExchange(
      inviterExchangeDataSpec(terms, {
        metadata: keyed.metadata,
        standardization: keyed.standardization,
      }),
      "Org",
      ZIP_ROWS,
      ZIP_COLUMNS,
    );
    const acceptor = prepareForExchange(
      { linkageTerms: deriveAcceptedLinkageTerms(terms, "Acceptor") },
      "Acceptor",
      ZIP_ROWS,
      ZIP_COLUMNS,
    );
    expect(inviter.dataset.getField("zip_code")?.get(0)).toEqual(["20001"]);
    expect(acceptor.dataset.getField("zip_code")?.get(0)).toEqual(["20001"]);
  });

  test("the second field of a type is suffixed and starts from the first's steps", () => {
    const { draft } = seedAdvancedInvite("Org", ZIP_COLUMNS, ZIP_ROWS);
    const first = draftWithFieldAdded(draft, "zip_code");
    const edited = {
      ...first,
      standardization: first.standardization.map((transformation) =>
        transformation.output === "zip_code"
          ? { ...transformation, steps: [{ function: "trim_whitespace" }] }
          : transformation,
      ),
    };

    const second = draftWithFieldAdded(edited, "zip_code");
    const added = second.standardization.at(-1);
    expect(added?.output).toBe("zip_code_2");
    expect(added?.input).toBe("zipcode");
    // The sibling's own steps, not the recommended ones: a second field of a type
    // starts from what the operator cleans the first with.
    expect(added?.steps).toEqual([{ function: "trim_whitespace" }]);
  });

  test("a sibling with steps omitted mirrors as raw, not the recommended pipeline", () => {
    const { draft } = seedAdvancedInvite("Org", ZIP_COLUMNS, ZIP_ROWS);
    // Not reachable through the UI: a sibling transformation whose `steps` is
    // omitted entirely (raw/no cleaning), built directly rather than through
    // draftWithFieldAdded, which always seeds either the recommended pipeline or
    // the sibling's own steps.
    const withRawSibling = {
      ...draft,
      standardization: [
        ...draft.standardization,
        { output: "zip_code", input: "zip" },
      ],
    };

    const second = draftWithFieldAdded(withRawSibling, "zip_code");
    const added = second.standardization.at(-1);
    expect(added?.output).toBe("zip_code_2");
    expect(added?.input).toBe("zipcode");
    // Mirrors the sibling as raw, not silently upgraded to the recommended
    // pipeline.
    expect(added?.steps).toEqual([]);
  });

  test("a type whose columns are all bound leaves the draft untouched", () => {
    const { draft } = seedAdvancedInvite("Org", ZIP_COLUMNS, ZIP_ROWS);
    // One free column left after the first add, none after the second.
    const bound = draftWithFieldAdded(
      draftWithFieldAdded(draft, "zip_code"),
      "zip_code",
    );
    expect(draftWithFieldAdded(bound, "zip_code")).toBe(bound);
  });
});
