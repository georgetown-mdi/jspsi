import { describe, expect, test } from "vitest";

import { editorFromCsv, editorWithIncludeOwnColumns } from "@psi/inviterEditor";
import { configurationHandBack } from "@console/configurationHandBack";
import { jobConfigurationHandBackSchema } from "@jobs/intentSchemas";
import { reviewValidation } from "@psi/inviterModel";

import { RECEIPTS_DEFAULT } from "@psi/receiptsModel";

import type { AcquiredCsv, InviterEditor } from "@psi/inviterEditor";

// What the review step sends when it saves an opened configuration back: the
// settings the steps hold, as a mint would compose them, in a body the route's
// own schema admits.

const columns = ["client_id", "first_name", "last_name", "dob", "program_code"];

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

function reviewed(editor: InviterEditor) {
  const terms = reviewValidation(editor).terms;
  if (terms === undefined)
    throw new Error("the fixture's terms did not validate");
  return terms;
}

describe("the hand-back the review step sends", () => {
  test("holds the reviewed terms and the draft's column settings", () => {
    const editor = editorFromCsv("County Health", acquired());
    const terms = reviewed(editor);
    const handBack = configurationHandBack({
      editor,
      terms,
      csvDelimiter: "|",
      receipts: RECEIPTS_DEFAULT,
    });
    expect(handBack.linkageTerms).toBe(terms);
    expect(handBack.metadata).toBe(editor.draft.metadata);
    expect(handBack.csvDelimiter).toBe("|");
    expect(handBack.signing).toEqual({ mode: "none" });
    expect(handBack.retentionDisposition).toBeUndefined();
    expect(jobConfigurationHandBackSchema.safeParse(handBack).success).toBe(
      true,
    );
  });

  test("narrows the own-column choice to the terms, as a mint does", () => {
    const editor = editorWithIncludeOwnColumns(
      editorFromCsv("County Health", acquired()),
      "all",
    );
    const terms = reviewed(editor);
    expect(
      configurationHandBack({
        editor,
        terms,
        csvDelimiter: undefined,
        receipts: RECEIPTS_DEFAULT,
      }).includeOwnColumns,
    ).toBe("all");
    expect(
      configurationHandBack({
        editor,
        terms: { ...terms, algorithm: "psi-c" },
        csvDelimiter: undefined,
        receipts: RECEIPTS_DEFAULT,
      }).includeOwnColumns,
    ).toBeUndefined();
  });

  test("states the receipt card's mode, a disabled one included, with its pin and note", () => {
    const editor = editorFromCsv("County Health", acquired());
    const terms = reviewed(editor);
    const pin = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCA";
    expect(
      configurationHandBack({
        editor,
        terms,
        csvDelimiter: undefined,
        receipts: {
          ...RECEIPTS_DEFAULT,
          mode: "certificate",
          partnerFingerprint: ` ${pin} `,
          retentionDisposition: " Filed. ",
        },
      }),
    ).toMatchObject({
      signing: { mode: "certificate", partnerFingerprint: pin },
      retentionDisposition: "Filed.",
    });
    expect(
      configurationHandBack({
        editor,
        terms,
        csvDelimiter: undefined,
        receipts: {
          ...RECEIPTS_DEFAULT,
          mode: "session-derived",
          partnerFingerprint: pin,
        },
      }).signing,
    ).toEqual({ mode: "session-derived" });
  });
});
