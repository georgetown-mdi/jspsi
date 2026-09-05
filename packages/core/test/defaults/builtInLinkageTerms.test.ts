import { expect, test, describe } from "vitest";

import { getDefaultLinkageTerms } from "../../src/defaults/builtInLinkageTerms";
import type { ColumnMetadata } from "../../src/config/metadata";

// --- getDefaultLinkageTerms: role: ignored -----------------------------------

describe("getDefaultLinkageTerms — ignored columns", () => {
  const linkageCol = (
    name: string,
    type: ColumnMetadata["type"],
  ): ColumnMetadata => ({ name, type, role: "linkage", isPayload: false });

  test("a type supplied only by an ignored column is excluded from the keys", () => {
    // ssn is present in the input but marked ignored; every other linkage type is
    // a normal linkage column. No surviving key may reference ssn/ssn4, and ssn
    // must not appear among the derived linkage fields.
    const metadata: ColumnMetadata[] = [
      { name: "SSN", type: "ssn", role: "ignored", isPayload: false },
      linkageCol("FN", "first_name"),
      linkageCol("LN", "last_name"),
      linkageCol("DOB", "date_of_birth"),
    ];
    const terms = getDefaultLinkageTerms("Agency A", metadata);

    const referencesSsn = terms.linkageKeys.some((k) =>
      k.elements.some((el) => el.field === "ssn" || el.field === "ssn4"),
    );
    expect(referencesSsn).toBe(false);
    expect(terms.linkageFields.some((f) => f.name === "ssn")).toBe(false);
    // The pure-name key (LN + FN + DOB) needs no ssn, so it still survives.
    expect(terms.linkageKeys.length).toBeGreaterThan(0);
  });

  test("marking a type ignored drops the keys an equivalent linkage column would keep", () => {
    const base: ColumnMetadata[] = [
      linkageCol("FN", "first_name"),
      linkageCol("LN", "last_name"),
      linkageCol("DOB", "date_of_birth"),
    ];
    const withSsnLinkage = getDefaultLinkageTerms("Agency A", [
      linkageCol("SSN", "ssn"),
      ...base,
    ]);
    const withSsnIgnored = getDefaultLinkageTerms("Agency A", [
      { name: "SSN", type: "ssn", role: "ignored", isPayload: false },
      ...base,
    ]);
    expect(withSsnIgnored.linkageKeys.length).toBeLessThan(
      withSsnLinkage.linkageKeys.length,
    );
  });
});
