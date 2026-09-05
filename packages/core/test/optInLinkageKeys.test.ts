import { describe, expect, test } from "vitest";

import {
  DEFAULT_LINKAGE_RULE_SET,
  OPT_IN_LINKAGE_FIELD_TYPES,
  authoredLinkageFields,
  getDefaultLinkageTerms,
  isOptInLinkageKey,
  linkageRuleSetReferenceFor,
  optInLinkageKeys,
} from "../src/defaults/builtInLinkageTerms";
import { SEMANTIC_TYPES } from "../src/types";

import type { ColumnMetadata } from "../src/config/metadata";
import type { SemanticType } from "../src/types";

const col = (
  name: string,
  type: SemanticType,
  role: ColumnMetadata["role"] = "linkage",
): ColumnMetadata => ({ name, type, role, isPayload: false });

/** The columns every offered key's backbone rests on, so a test that is about
 * the offer's own type is not silently answering the backbone's question. */
const BACKBONE = [
  col("fn", "first_name"),
  col("ln", "last_name"),
  col("dob", "date_of_birth"),
];

/** A file holding the backbone and one column of every offered type. */
const EVERY_TYPE = [
  ...BACKBONE,
  ...OPT_IN_LINKAGE_FIELD_TYPES.map((type) => col(type, type)),
];

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
  test("offers no key built from one element", () => {
    // A key over a single identifier is a membership oracle -- a party holding a
    // candidate value learns whether its holder is in the other file -- and a
    // contact value shared across a household or an organization makes it report
    // different people as one. Neither is a property of a particular type, so the
    // check is over whatever the offer holds rather than over today's three.
    const offered = optInLinkageKeys(EVERY_TYPE);
    expect(offered).toHaveLength(OPT_IN_LINKAGE_FIELD_TYPES.length);
    for (const key of offered)
      expect(key.elements.length).toBeGreaterThanOrEqual(2);
  });

  test("offers one key per present type, in a fixed order the columns do not set", () => {
    const offered = ["LN + FN + DOB + PHONE", "LN + FN + DOB + ZIP"];
    expect(
      optInLinkageKeys([
        col("zip", "zip_code"),
        ...BACKBONE,
        col("cell", "phone_number"),
      ]).map((key) => key.name),
    ).toEqual(offered);
    expect(
      optInLinkageKeys([
        col("cell", "phone_number"),
        ...BACKBONE,
        col("zip", "zip_code"),
      ]).map((key) => key.name),
    ).toEqual(offered);
  });

  test("offers a type only once, however many columns hold it", () => {
    expect(
      optInLinkageKeys([
        ...BACKBONE,
        col("home_zip", "zip_code"),
        col("work_zip", "zip_code"),
      ]).map((key) => key.name),
    ).toEqual(["LN + FN + DOB + ZIP"]);
  });

  test("offers nothing for a type the columns do not supply", () => {
    expect(optInLinkageKeys([col("ssn", "ssn"), ...BACKBONE])).toEqual([]);
  });

  test("offers nothing when a column the compound's backbone needs is missing", () => {
    // Satisfiability runs over EVERY element, so a file holding the offered
    // type but not the rest of the key is offered no key at all rather than a
    // thinner one: the compound shape is the offer.
    expect(
      optInLinkageKeys([
        col("ln", "last_name"),
        col("dob", "date_of_birth"),
        col("zip", "zip_code"),
        col("cell", "phone_number"),
      ]),
    ).toEqual([]);
    expect(
      optInLinkageKeys([
        col("fn", "first_name"),
        col("mail", "email_address"),
      ]).map((key) => key.name),
    ).toEqual(["FN + EMAIL"]);
  });

  test("offers nothing on a column of the type that is not role: linkage", () => {
    // The same rule the built-in keys are narrowed by: only a `role: linkage`
    // column supplies a matchable type, so a key offered on an identifier,
    // payload, or ignored column would bind nothing at exchange time.
    for (const role of ["identifier", "payload", "ignored"] as const)
      expect(
        optInLinkageKeys([...BACKBONE, col("zip", "zip_code", role)]),
      ).toEqual([]);
  });

  test("offers nothing on a backbone column that is not role: linkage", () => {
    expect(
      optInLinkageKeys([
        col("fn", "first_name"),
        col("ln", "last_name"),
        col("dob", "date_of_birth", "payload"),
        col("zip", "zip_code"),
      ]),
    ).toEqual([]);
  });

  test("references the fields authoredLinkageFields declares for the columns", () => {
    // Every element dangles unless the field it names is the one the editor's own
    // field derivation declares for a column of that type.
    const declared = new Set(
      authoredLinkageFields(EVERY_TYPE).map((field) => field.name),
    );
    for (const key of optInLinkageKeys(EVERY_TYPE))
      for (const element of key.elements)
        expect(declared.has(element.field)).toBe(true);
  });

  test("each offered key holds its own type once, over built-in fields", () => {
    const fieldByName = new Map(
      authoredLinkageFields(EVERY_TYPE).map((field) => [
        field.name,
        field.type,
      ]),
    );
    const builtInTypes = new Set(
      DEFAULT_LINKAGE_RULE_SET.linkageFields.map((field) => field.type),
    );
    for (const [index, key] of optInLinkageKeys(EVERY_TYPE).entries()) {
      const types = key.elements.map((element) =>
        fieldByName.get(element.field),
      );
      expect(
        types.filter((type) => type === OPT_IN_LINKAGE_FIELD_TYPES[index]),
      ).toHaveLength(1);
      for (const type of types)
        expect(
          type === OPT_IN_LINKAGE_FIELD_TYPES[index] ||
            (type !== undefined && builtInTypes.has(type)),
        ).toBe(true);
    }
  });

  test("no element holds a transform the standardization has not already run", () => {
    // The offered shapes are the standardized fields themselves -- a five-digit
    // ZIP, a ten-digit phone -- so an element transform here would be a rule of
    // its own rather than the shape the evidence measured.
    for (const key of optInLinkageKeys(EVERY_TYPE))
      for (const element of key.elements)
        expect(element.transform).toBeUndefined();
  });

  test("adding one to the built-in keys costs the rules their citation", () => {
    // An offered key is an addition to the built-in set, not part of it, so rules
    // holding one are not drawn from that set and may not cite it. This is what
    // makes the departure clear on the acceptor's side rather than only in the
    // copy beside the control.
    const metadata = [...BACKBONE, col("zip", "zip_code")];
    const terms = getDefaultLinkageTerms("Inviter", metadata);
    expect(linkageRuleSetReferenceFor(terms)).toEqual(
      DEFAULT_LINKAGE_RULE_SET.reference,
    );

    const [zip] = optInLinkageKeys(metadata);
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

describe("the offer resists mutation", () => {
  test("an offered key is frozen through its contents, arrays and elements alike", () => {
    // optInLinkageKeys hands the one declared offer out BY REFERENCE, into an
    // editor draft and from there into the terms a party generates, so a single
    // in-place edit would redefine what is offered for the rest of the process --
    // the same aliasing DEFAULT_LINKAGE_RULE_SET is frozen against. Module code is
    // strict, so each attempt throws rather than silently failing.
    const [, , zip] = optInLinkageKeys(EVERY_TYPE);
    const mutable = zip as {
      name: string;
      elements: Array<{
        field: string;
        transform?: Array<{
          function: string;
          params: { start: number; length: number };
        }>;
      }>;
    };

    expect(() => {
      mutable.name = "LN + FN + DOB";
    }).toThrow(TypeError);
    expect(() => {
      mutable.elements[0].field = "poisoned";
    }).toThrow(TypeError);
    expect(() => {
      mutable.elements[3].transform = [
        { function: "substring", params: { start: 1, length: 3 } },
      ];
    }).toThrow(TypeError);
    expect(() => {
      mutable.elements.push({ field: "ssn" });
    }).toThrow(TypeError);
    expect(() => {
      mutable.elements.reverse();
    }).toThrow(TypeError);
  });

  test("the encodings the offer is recognized by are the declared shapes", () => {
    // isOptInLinkageKey compares against encodings built once at load, so an edit
    // that landed would leave the key the editor is holding answering `false`:
    // the outside-the-default-set badge and its departure guidance would drop off
    // a key that is still an addition to the built-in set. Asserted against
    // literal shapes as well as the returned objects, which would agree with
    // themselves however far they had drifted.
    for (const key of optInLinkageKeys(EVERY_TYPE))
      expect(isOptInLinkageKey(key)).toBe(true);
    expect(
      isOptInLinkageKey({
        name: "LN + FN + DOB + ZIP",
        elements: [
          { field: "last_name" },
          { field: "first_name" },
          { field: "date_of_birth" },
          { field: "zip_code" },
        ],
      }),
    ).toBe(true);
    expect(
      isOptInLinkageKey({
        name: "FN + EMAIL",
        elements: [{ field: "first_name" }, { field: "email_address" }],
      }),
    ).toBe(true);
  });

  test("the offered list is the caller's own, so a caller can still build on it", () => {
    // The freeze reaches the declared keys, not the array optInLinkageKeys
    // returns: its callers place the offers among their own entries.
    const offered = optInLinkageKeys(EVERY_TYPE);
    expect(() => offered.reverse()).not.toThrow();
    expect(optInLinkageKeys(EVERY_TYPE).map((key) => key.name)).toEqual([
      "LN + FN + DOB + PHONE",
      "FN + EMAIL",
      "LN + FN + DOB + ZIP",
    ]);
  });
});

describe("isOptInLinkageKey", () => {
  test("holds for every key optInLinkageKeys offers", () => {
    const offered = optInLinkageKeys(EVERY_TYPE);
    expect(offered).toHaveLength(OPT_IN_LINKAGE_FIELD_TYPES.length);
    for (const key of offered) expect(isOptInLinkageKey(key)).toBe(true);
  });

  test("does not hold for a built-in key", () => {
    for (const key of DEFAULT_LINKAGE_RULE_SET.linkageKeys)
      expect(isOptInLinkageKey(key)).toBe(false);
  });

  test("does not hold for a key that only borrows the name", () => {
    // Compared through the canonical encoding, so a key an expert editor renamed
    // to an offer's name -- or one an imported document declares under it -- is
    // not marked as the offer, and the offer's own key is not mistaken for an
    // edit.
    expect(
      isOptInLinkageKey({
        name: "LN + FN + DOB + ZIP",
        elements: [{ field: "last_name" }],
      }),
    ).toBe(false);
    expect(
      isOptInLinkageKey({
        name: "LN + FN + DOB + ZIP",
        elements: [{ field: "zip_code" }, { field: "last_name" }],
      }),
    ).toBe(false);
  });

  test("does not hold for the offered type on its own", () => {
    for (const type of OPT_IN_LINKAGE_FIELD_TYPES)
      expect(
        isOptInLinkageKey({ name: "ZIP", elements: [{ field: type }] }),
      ).toBe(false);
  });

  test("does not hold for an offered key an edit has changed", () => {
    const [zip] = optInLinkageKeys([...BACKBONE, col("zip", "zip_code")]);
    expect(
      isOptInLinkageKey({
        ...zip,
        elements: zip.elements.map((element) =>
          element.field === "zip_code"
            ? {
                ...element,
                transform: [
                  { function: "substring", params: { start: 1, length: 3 } },
                ],
              }
            : element,
        ),
      }),
    ).toBe(false);
    expect(isOptInLinkageKey({ ...zip, name: "ZIP 5" })).toBe(false);
    expect(
      isOptInLinkageKey({
        ...zip,
        elements: zip.elements.filter(
          (element) => element.field !== "first_name",
        ),
      }),
    ).toBe(false);
  });
});
