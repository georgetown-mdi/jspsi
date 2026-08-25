import { describe, expect, test } from "vitest";

import {
  DEFAULT_LINKAGE_RULE_SET,
  OPT_IN_LINKAGE_FIELD_TYPES,
  authoredLinkageFields,
  getDefaultLinkageTerms,
  isOptInLinkageKey,
  linkageRuleSetReferenceFor,
  optInLinkageKeys,
} from "../src/defaults/linkageTerms";
import { SEMANTIC_TYPES } from "../src/types";

import type { ColumnMetadata } from "../src/config/metadata";
import type { SemanticType } from "../src/types";

const col = (
  name: string,
  type: SemanticType,
  role: ColumnMetadata["role"] = "linkage",
): ColumnMetadata => ({ name, type, role, isPayload: false });

describe("OPT_IN_LINKAGE_FIELD_TYPES", () => {
  test("is exactly the matchable types the built-in field set does not cover", () => {
    // The list is written out so a type is offered because it was decided on, not
    // because it arrived in the enum -- which leaves a new matchable type able to
    // go silently unoffered. This is the check that closes that: adding one to
    // SEMANTIC_TYPES fails here until it is either offered or the built-in field
    // set covers it.
    const covered = new Set(
      DEFAULT_LINKAGE_RULE_SET.linkageFields.map((field) => field.type),
    );
    const uncoveredMatchable = SEMANTIC_TYPES.filter(
      (type) => type !== "identifier" && type !== "other" && !covered.has(type),
    );
    expect([...OPT_IN_LINKAGE_FIELD_TYPES].sort()).toEqual(
      [...uncoveredMatchable].sort(),
    );
  });

  test("names no type a built-in key already matches on", () => {
    const builtIn = new Set(
      DEFAULT_LINKAGE_RULE_SET.linkageKeys.flatMap((key) =>
        key.elements.map((element) => element.field),
      ),
    );
    for (const type of OPT_IN_LINKAGE_FIELD_TYPES)
      expect(builtIn.has(type)).toBe(false);
  });
});

describe("optInLinkageKeys", () => {
  test("offers one key per present type, in a fixed order the columns do not set", () => {
    const offered = ["PHONE", "ZIP"];
    expect(
      optInLinkageKeys([
        col("zip", "zip_code"),
        col("ln", "last_name"),
        col("cell", "phone_number"),
      ]).map((key) => key.name),
    ).toEqual(offered);
    expect(
      optInLinkageKeys([
        col("cell", "phone_number"),
        col("ln", "last_name"),
        col("zip", "zip_code"),
      ]).map((key) => key.name),
    ).toEqual(offered);
  });

  test("offers a type only once, however many columns carry it", () => {
    expect(
      optInLinkageKeys([
        col("home_zip", "zip_code"),
        col("work_zip", "zip_code"),
      ]).map((key) => key.name),
    ).toEqual(["ZIP"]);
  });

  test("offers nothing for a type the columns do not supply", () => {
    expect(
      optInLinkageKeys([col("ssn", "ssn"), col("ln", "last_name")]),
    ).toEqual([]);
  });

  test("offers nothing on a column of the type that is not role: linkage", () => {
    // The same rule the built-in keys are narrowed by: only a `role: linkage`
    // column supplies a matchable type, so a key offered on an identifier,
    // payload, or ignored column would bind nothing at exchange time.
    for (const role of ["identifier", "payload", "ignored"] as const)
      expect(optInLinkageKeys([col("zip", "zip_code", role)])).toEqual([]);
  });

  test("references the field authoredLinkageFields declares for the column", () => {
    // The offered key dangles unless the field it names is the one the editor's
    // own field derivation declares for a column of that type.
    const metadata = [col("cell", "phone_number"), col("zip", "zip_code")];
    const declared = new Set(
      authoredLinkageFields(metadata).map((field) => field.name),
    );
    for (const key of optInLinkageKeys(metadata))
      for (const element of key.elements)
        expect(declared.has(element.field)).toBe(true);
  });

  test("each offered key matches on exactly its own type", () => {
    const metadata = OPT_IN_LINKAGE_FIELD_TYPES.map((type) => col(type, type));
    const fieldByName = new Map(
      authoredLinkageFields(metadata).map((field) => [field.name, field.type]),
    );
    for (const [index, key] of optInLinkageKeys(metadata).entries()) {
      expect(key.elements).toHaveLength(1);
      expect(fieldByName.get(key.elements[0].field)).toBe(
        OPT_IN_LINKAGE_FIELD_TYPES[index],
      );
    }
  });

  test("adding one to the built-in keys costs the rules their citation", () => {
    // An offered key is an addition to the built-in set, not part of it, so rules
    // carrying one are not drawn from that set and may not cite it. This is what
    // makes the departure legible on the acceptor's side rather than only in the
    // copy beside the control.
    const metadata = [
      col("fn", "first_name"),
      col("ln", "last_name"),
      col("dob", "date_of_birth"),
      col("zip", "zip_code"),
    ];
    const terms = getDefaultLinkageTerms("Inviter", metadata);
    expect(linkageRuleSetReferenceFor(terms)).toEqual(
      DEFAULT_LINKAGE_RULE_SET.reference,
    );

    const zip = optInLinkageKeys(metadata)[0];
    expect(
      linkageRuleSetReferenceFor({
        linkageFields: [
          ...terms.linkageFields,
          { name: "zip_code", type: "zip_code" },
        ],
        linkageKeys: [...terms.linkageKeys, zip],
      }),
    ).toBeUndefined();
  });
});

describe("isOptInLinkageKey", () => {
  test("holds for every key optInLinkageKeys offers", () => {
    const metadata = OPT_IN_LINKAGE_FIELD_TYPES.map((type) => col(type, type));
    const offered = optInLinkageKeys(metadata);
    expect(offered).toHaveLength(OPT_IN_LINKAGE_FIELD_TYPES.length);
    for (const key of offered) expect(isOptInLinkageKey(key)).toBe(true);
  });

  test("does not hold for a built-in key", () => {
    for (const key of DEFAULT_LINKAGE_RULE_SET.linkageKeys)
      expect(isOptInLinkageKey(key)).toBe(false);
  });

  test("does not hold for a key that only borrows the name", () => {
    // Compared through the canonical encoding, so a key an expert editor renamed
    // to "ZIP" -- or one an imported document declares under that name -- is not
    // marked as the offer, and the offer's own key is not mistaken for an edit.
    expect(
      isOptInLinkageKey({ name: "ZIP", elements: [{ field: "last_name" }] }),
    ).toBe(false);
    expect(
      isOptInLinkageKey({
        name: "ZIP",
        elements: [{ field: "zip_code" }, { field: "last_name" }],
      }),
    ).toBe(false);
  });

  test("does not hold for an offered key an edit has changed", () => {
    const [zip] = optInLinkageKeys([col("zip", "zip_code")]);
    expect(
      isOptInLinkageKey({
        ...zip,
        elements: [
          {
            field: "zip_code",
            transform: [
              { function: "substring", params: { start: 1, length: 3 } },
            ],
          },
        ],
      }),
    ).toBe(false);
    expect(isOptInLinkageKey({ ...zip, name: "ZIP 5" })).toBe(false);
  });
});
