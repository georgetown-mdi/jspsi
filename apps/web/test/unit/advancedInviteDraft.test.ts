import { describe, expect, test } from "vitest";

import {
  seedAdvancedInvite,
  setDraftMetadata,
  setDraftMetadataKeepingKeys,
} from "../../src/psi/advancedInviteDraft.js";

import type { Metadata } from "@psilink/core";

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

  test("differs from setDraftMetadata only in that it does not reconcile keys", () => {
    const { draft } = seedAdvancedInvite("Org", ALL_COLUMNS);
    const metadata = retypeSsnToFirstName(draft.metadata);

    const kept = setDraftMetadataKeepingKeys(draft, metadata);
    const reconciled = setDraftMetadata(draft, metadata);

    // The full setDraftMetadata re-derives the offerable key set (dropping keys the
    // retype makes unofferable), so it ends with fewer keys; the keep-keys variant
    // preserves the count.
    expect(kept.keys.length).toBe(draft.keys.length);
    expect(reconciled.keys.length).toBeLessThan(draft.keys.length);
    // Both reconcile the standardization identically -- the difference is purely in
    // the key handling.
    expect(kept.standardization).toStrictEqual(reconciled.standardization);
  });
});
