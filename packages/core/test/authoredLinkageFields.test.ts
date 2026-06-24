import { describe, expect, test } from "vitest";

import {
  authoredLinkageFields,
  getDefaultLinkageTerms,
} from "../src/defaults/linkageTerms";

import type { ColumnMetadata, Metadata } from "../src/config/metadata";
import type { Standardization } from "../src/config/standardization";
import type { SemanticType } from "../src/types";

const col = (
  name: string,
  type: SemanticType,
  role: ColumnMetadata["role"] = "linkage",
): ColumnMetadata => ({ name, type, role, isPayload: false });

const NAME_CONSTRAINTS = { affixesAllowed: false, allowedCharacters: "A-Z " };

describe("authoredLinkageFields", () => {
  test("with no standardization, returns the present types' default fields in default order", () => {
    const metadata: Metadata = [
      col("a", "first_name"),
      col("b", "ssn"),
      col("c", "date_of_birth"),
    ];
    const fields = authoredLinkageFields(metadata);
    // DEFAULT_LINKAGE_FIELDS order is ssn, ssn4, first_name, last_name,
    // date_of_birth; ssn4 and last_name are absent here.
    expect(fields.map((f) => f.name)).toEqual([
      "ssn",
      "first_name",
      "date_of_birth",
    ]);
    expect(fields.find((f) => f.name === "first_name")?.constraints).toEqual(
      NAME_CONSTRAINTS,
    );
  });

  test("coincides with the guided default field set when every present type is referenced", () => {
    // With the full PII set present every default field is referenced by a
    // surviving key, so the candidate set the producer returns equals
    // getDefaultLinkageTerms' reference-filtered fields -- the byte-identical
    // guided path when no standardization exists.
    const metadata: Metadata = [
      col("s", "ssn"),
      col("f", "first_name"),
      col("l", "last_name"),
      col("d", "date_of_birth"),
    ];
    expect(authoredLinkageFields(metadata)).toEqual(
      getDefaultLinkageTerms("", metadata).linkageFields,
    );
  });

  test("emits two distinct fields for two columns of one type, each with that type's constraints", () => {
    const metadata: Metadata = [
      col("maiden", "first_name"),
      col("current", "first_name"),
      col("dob", "date_of_birth"),
    ];
    const standardization: Standardization = [
      { output: "maiden_name", input: "maiden", steps: [] },
      { output: "current_name", input: "current", steps: [] },
    ];
    const fields = authoredLinkageFields(metadata, standardization);
    // Both first_name fields are declared by their distinct output names rather than
    // collapsed to one; the date_of_birth column with no explicit binding keeps its
    // default field, at the date_of_birth position.
    expect(fields.map((f) => f.name)).toEqual([
      "maiden_name",
      "current_name",
      "date_of_birth",
    ]);
    expect(fields.filter((f) => f.type === "first_name")).toHaveLength(2);
    for (const name of ["maiden_name", "current_name"])
      expect(fields.find((f) => f.name === name)?.constraints).toEqual(
        NAME_CONSTRAINTS,
      );
    // The default "first_name" field is not also emitted -- the explicit bindings
    // supersede it.
    expect(fields.some((f) => f.name === "first_name")).toBe(false);
  });

  test("a transformation bound to an ignored column declares no field (ignored wins)", () => {
    const metadata: Metadata = [
      col("maiden", "first_name", "ignored"),
      col("current", "first_name"),
    ];
    const standardization: Standardization = [
      { output: "maiden_name", input: "maiden", steps: [] },
      { output: "current_name", input: "current", steps: [] },
    ];
    // maiden is ignored, so its transformation declares nothing -- mirroring
    // resolveFieldColumns, where ignored wins over an explicit binding.
    expect(
      authoredLinkageFields(metadata, standardization).map((f) => f.name),
    ).toEqual(["current_name"]);
  });

  test("a transformation bound to a payload or identifier column declares no field (role wins)", () => {
    // Matching participation requires role: linkage, so a transformation naming a
    // payload- or identifier-roled column declares nothing -- mirroring
    // resolveFieldColumns, where the role wins over an explicit binding for any
    // non-linkage column, not only ignored.
    const metadata: Metadata = [
      col("sent", "first_name", "payload"),
      col("rowid", "last_name", "identifier"),
      col("current", "first_name"),
    ];
    const standardization: Standardization = [
      { output: "sent_name", input: "sent", steps: [] },
      { output: "rowid_name", input: "rowid", steps: [] },
      { output: "current_name", input: "current", steps: [] },
    ];
    expect(
      authoredLinkageFields(metadata, standardization).map((f) => f.name),
    ).toEqual(["current_name"]);
  });

  test("an explicit binding for a type with no default field declares a constraint-free field", () => {
    const metadata: Metadata = [col("ph", "phone_number")];
    const standardization: Standardization = [
      { output: "phone", input: "ph", steps: [] },
    ];
    expect(authoredLinkageFields(metadata, standardization)).toEqual([
      { name: "phone", type: "phone_number" },
    ]);
  });

  test("a single renamed binding replaces its type's default field in place", () => {
    const metadata: Metadata = [
      col("given", "first_name"),
      col("d", "date_of_birth"),
    ];
    const standardization: Standardization = [
      { output: "given_name", input: "given", steps: [] },
    ];
    const fields = authoredLinkageFields(metadata, standardization);
    expect(fields.map((f) => f.name)).toEqual(["given_name", "date_of_birth"]);
    expect(fields.find((f) => f.name === "given_name")).toMatchObject({
      type: "first_name",
      constraints: NAME_CONSTRAINTS,
    });
  });

  test("a present matchable type with no default field and no binding declares a synthetic field", () => {
    // zip_code is matchable but absent from DEFAULT_LINKAGE_FIELDS, so with no
    // authored cleaning it would previously declare nothing and be unpickable in the
    // key editor. It now declares one synthetic, constraint-free field named for the
    // type, which resolveFieldColumns binds to the column by type.
    const metadata: Metadata = [col("zip", "zip_code")];
    expect(authoredLinkageFields(metadata)).toEqual([
      { name: "zip_code", type: "zip_code" },
    ]);
  });

  test("synthetic non-default fields follow the default fields, in metadata order", () => {
    const metadata: Metadata = [
      col("zip", "zip_code"),
      col("f", "first_name"),
      col("email", "email_address"),
    ];
    // Default types first (first_name), then the present non-default matchable types
    // in metadata order (zip_code before email_address).
    expect(authoredLinkageFields(metadata).map((f) => f.name)).toEqual([
      "first_name",
      "zip_code",
      "email_address",
    ]);
  });

  test("an explicit binding supersedes the synthetic field for a non-default type", () => {
    const metadata: Metadata = [col("zip", "zip_code")];
    const standardization: Standardization = [
      { output: "zip5", input: "zip", steps: [] },
    ];
    // The authored output is the only zip_code field -- no synthetic "zip_code"
    // field is also emitted alongside it.
    expect(authoredLinkageFields(metadata, standardization)).toEqual([
      { name: "zip5", type: "zip_code" },
    ]);
  });

  test("a matchable column not roled linkage, and a non-matchable type, declare no field", () => {
    const metadata: Metadata = [
      col("zip", "zip_code", "payload"), // matchable type, but not roled linkage
      col("rowid", "identifier"), // roled linkage, but a non-matchable type
      col("misc", "other"), // roled linkage, but a non-matchable type
      col("f", "first_name"),
    ];
    // Only the linkage-roled, matchable-typed column declares a field.
    expect(authoredLinkageFields(metadata).map((f) => f.name)).toEqual([
      "first_name",
    ]);
  });
});
