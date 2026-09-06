import { Readable } from "node:stream";

import { describe, expect, test } from "vitest";

import {
  decodeInvitation,
  getDefaultLinkageTerms,
  inferMetadata,
} from "@psilink/core";

import {
  OWN_COLUMNS_DEFAULT,
  OWN_COLUMNS_EMPTY_ALL_NOTICE,
  OWN_COLUMNS_EMPTY_DISCLOSED_NOTICE,
  OWN_COLUMNS_LABELS,
  OWN_COLUMNS_ORDER,
  ownColumnsActionable,
  ownColumnsEmptySelectionNotice,
  ownColumnsField,
  ownColumnsPreview,
} from "@psi/ownColumnsModel";
import {
  editorFromCsv,
  editorWithImportedTerms,
  editorWithIncludeOwnColumns,
} from "@psi/inviterEditor";
import { generateInvitation } from "@psi/invitation";

import type { LinkageTerms, Output } from "@psilink/core";
import type { AcquiredCsv } from "@psi/inviterEditor";
import type { InvitationLocation } from "@psi/invitation";

// The authoring control's own model: which of this party's columns its result
// file holds, when the choice is offered at all, and the one place a choice is
// narrowed to terms that can act on it (the mint).

const columns = ["client_id", "first_name", "last_name", "dob", "program_code"];
// client_id/first_name/last_name/dob infer matching roles; program_code is not
// in the alias map, so it infers a disclosed payload column -- the one column
// that separates the `disclosed` selection from `all`.
const metadata = inferMetadata(columns, []);

const BOTH_RECEIVE: Output = { expectsOutput: true, shareWithPartner: true };
const PARTNER_ONLY: Output = { expectsOutput: false, shareWithPartner: true };

const location: InvitationLocation = {
  origin: "https://example.org:8443",
  hostname: "example.org",
  port: "8443",
};

const CSV = `${columns.join(",")}\n17,Alice,Smith,1990-01-02,A7\n`;

function csvStream(): Readable {
  return Readable.from(CSV);
}

function acquired(): AcquiredCsv {
  return {
    fileName: "clients.csv",
    sizeBytes: 4096,
    rawRows: [
      {
        client_id: "17",
        first_name: "Alice",
        last_name: "Smith",
        dob: "1990-01-02",
        program_code: "A7",
      },
    ],
    columns,
    rowCount: 1,
  };
}

function termsWith(overrides: Partial<LinkageTerms>): LinkageTerms {
  return { ...getDefaultLinkageTerms("County Health", metadata), ...overrides };
}

describe("the control's three states", () => {
  test("the default is the file the partner's values alone make up", () => {
    expect(OWN_COLUMNS_DEFAULT).toBe("none");
    expect(ownColumnsPreview(metadata, OWN_COLUMNS_DEFAULT)).toEqual([]);
  });

  test("every offered state has a label, in least-to-most order", () => {
    expect([...OWN_COLUMNS_ORDER]).toEqual(["none", "disclosed", "all"]);
    for (const choice of OWN_COLUMNS_ORDER)
      expect(OWN_COLUMNS_LABELS[choice].length).toBeGreaterThan(0);
  });

  test("`disclosed` previews the columns this party sends its partner", () => {
    // program_code is the inferred payload column; the identifier is left out of
    // both selections because the result's first column already holds it.
    expect(ownColumnsPreview(metadata, "disclosed")).toEqual(["program_code"]);
  });

  test("`all` previews every declared column but the identifier", () => {
    expect(ownColumnsPreview(metadata, "all")).toEqual([
      "first_name",
      "last_name",
      "dob",
      "program_code",
    ]);
  });
});

describe("a selection that resolves to no column", () => {
  // A file whose only column is the record identifier the result already begins
  // with, and a file of matching columns and nothing else.
  const identifierOnly = inferMetadata(["client_id"], []);
  const linkageOnly = inferMetadata(
    ["client_id", "first_name", "last_name", "dob"],
    [],
  );

  test("`all` finds nothing where the identifier is the only column", () => {
    expect(ownColumnsPreview(identifierOnly, "all")).toEqual([]);
    expect(ownColumnsEmptySelectionNotice("all")).toBe(
      OWN_COLUMNS_EMPTY_ALL_NOTICE,
    );
  });

  test("`disclosed` finds nothing where no column is marked as sent", () => {
    // The columns are there; matching is what they are for, so none of them is
    // sent -- a different reason than the file having no other column, and the
    // notice says so.
    expect(ownColumnsPreview(linkageOnly, "all")).toEqual([
      "first_name",
      "last_name",
      "dob",
    ]);
    expect(ownColumnsPreview(linkageOnly, "disclosed")).toEqual([]);
    expect(ownColumnsEmptySelectionNotice("disclosed")).toBe(
      OWN_COLUMNS_EMPTY_DISCLOSED_NOTICE,
    );
    expect(OWN_COLUMNS_EMPTY_DISCLOSED_NOTICE).not.toBe(
      OWN_COLUMNS_EMPTY_ALL_NOTICE,
    );
  });
});

describe("ownColumnsActionable", () => {
  test("terms that give this party a result table admit the choice", () => {
    expect(
      ownColumnsActionable({ algorithm: "psi", output: BOTH_RECEIVE }),
    ).toBe(true);
  });

  test("a count-only exchange writes no result file for anyone", () => {
    expect(
      ownColumnsActionable({ algorithm: "psi-c", output: BOTH_RECEIVE }),
    ).toBe(false);
  });

  test("terms handing the result to the partner alone leave this party none", () => {
    expect(
      ownColumnsActionable({ algorithm: "psi", output: PARTNER_ONLY }),
    ).toBe(false);
  });
});

describe("ownColumnsField", () => {
  test("each selection reaches the config as the key's own value", () => {
    const terms = termsWith({});
    expect(ownColumnsField("disclosed", terms)).toEqual({
      includeOwnColumns: "disclosed",
    });
    expect(ownColumnsField("all", terms)).toEqual({ includeOwnColumns: "all" });
  });

  test("`none` composes no key at all, not an explicit value", () => {
    const field = ownColumnsField("none", termsWith({}));
    expect(field).toEqual({});
    expect(field).not.toHaveProperty("includeOwnColumns");
  });

  test("a selection the terms cannot act on composes no key", () => {
    // The schema refuses the key beside a count-only algorithm outright, and
    // ignores it on a party with no result table; neither reaches a document.
    expect(ownColumnsField("all", termsWith({ algorithm: "psi-c" }))).toEqual(
      {},
    );
    expect(ownColumnsField("all", termsWith({ output: PARTNER_ONLY }))).toEqual(
      {},
    );
  });
});

describe("editorWithIncludeOwnColumns", () => {
  test("a selection lands on the draft and turning it off drops the field", () => {
    const editor = editorFromCsv("County Health", acquired());
    expect(editor.draft.includeOwnColumns).toBeUndefined();

    const chosen = editorWithIncludeOwnColumns(editor, "all");
    expect(chosen.draft.includeOwnColumns).toBe("all");

    const cleared = editorWithIncludeOwnColumns(chosen, "none");
    // Absent, not an explicit value: the key's own third state, so a draft turned
    // back off is indistinguishable from one that never set it.
    expect(cleared.draft).not.toHaveProperty("includeOwnColumns");
  });

  test("a sealed session refuses the edit like every other mutator", () => {
    const sealed = {
      ...editorFromCsv("County Health", acquired()),
      sealed: true,
    };
    expect(editorWithIncludeOwnColumns(sealed, "all")).toBe(sealed);
  });

  test("importing a terms document keeps the choice the operator set", () => {
    // The choice is per-party and local -- no terms document states it -- so an
    // import rebuilds the draft around it rather than over it.
    const chosen = editorWithIncludeOwnColumns(
      editorFromCsv("County Health", acquired()),
      "disclosed",
    );
    const imported = editorWithImportedTerms(chosen, acquired(), termsWith({}));
    expect(imported.draft.includeOwnColumns).toBe("disclosed");
  });

  test("importing over an untouched control leaves the field absent", () => {
    const imported = editorWithImportedTerms(
      editorFromCsv("County Health", acquired()),
      acquired(),
      termsWith({}),
    );
    expect(imported.draft).not.toHaveProperty("includeOwnColumns");
  });
});

describe("generateInvitation narrows the choice once, at the mint", () => {
  test("a chosen selection rides the mint and never the token", async () => {
    const minted = await generateInvitation({
      inviterName: "County Health",
      file: csvStream(),
      location,
      metadata,
      includeOwnColumns: "all",
    });

    expect(minted.includeOwnColumns).toBe("all");
    // Local: the partner's copy of the terms holds nothing about it, so neither
    // the consent display nor the agreed-terms hash moves.
    const token = await decodeInvitation(minted.encoded);
    expect(JSON.stringify(token)).not.toContain("includeOwnColumns");
    expect(JSON.stringify(token)).not.toContain("include_own_columns");
  });

  test("terms that hand the result to the partner alone mint no selection", async () => {
    const minted = await generateInvitation({
      inviterName: "County Health",
      file: csvStream(),
      location,
      linkageTerms: termsWith({ output: PARTNER_ONLY }),
      metadata,
      includeOwnColumns: "all",
    });
    expect(minted.includeOwnColumns).toBeUndefined();
  });

  test("an omitted choice mints no selection", async () => {
    const minted = await generateInvitation({
      inviterName: "County Health",
      file: csvStream(),
      location,
      metadata,
    });
    expect(minted.includeOwnColumns).toBeUndefined();
  });
});
