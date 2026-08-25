import { describe, expect, test } from "vitest";

import {
  DEFAULT_LINKAGE_FIELD_SET_NAME,
  DEFAULT_LINKAGE_FIELD_SET_VERSION,
  DEFAULT_LINKAGE_KEY_SET_NAME,
  DEFAULT_LINKAGE_KEY_SET_VERSION,
  DEFAULT_LINKAGE_RULE_SET,
  getDefaultLinkageTerms,
  isDrawnFromLinkageRuleSet,
  linkageRuleSetReferenceFor,
  linkageTermsFromRuleSet,
} from "../src/defaults/linkageTerms";

import type { ColumnMetadata, Metadata } from "../src/config/metadata";
import type { LinkageKey, LinkageTerms } from "../src/config/linkageTerms";
import type { SemanticType } from "../src/types";

const col = (
  name: string,
  type: SemanticType,
  role: ColumnMetadata["role"] = "linkage",
): ColumnMetadata => ({ name, type, role, isPayload: false });

/** The whole set, as a terms document's rules would carry it. */
const wholeSet = (): Pick<LinkageTerms, "linkageFields" | "linkageKeys"> => ({
  linkageFields: structuredClone([...DEFAULT_LINKAGE_RULE_SET.linkageFields]),
  linkageKeys: structuredClone([...DEFAULT_LINKAGE_RULE_SET.linkageKeys]),
});

describe("DEFAULT_LINKAGE_RULE_SET", () => {
  test("cites the declarations the built-in sets' drift checks read", () => {
    // The citation and the pinned content are the same artifact: a set whose
    // reference drifted from the declarations `scripts/lib/builtInRuleSets.mjs`
    // reads would publish a version no pin covers.
    expect(DEFAULT_LINKAGE_RULE_SET.reference).toStrictEqual({
      fieldSet: {
        name: DEFAULT_LINKAGE_FIELD_SET_NAME,
        version: DEFAULT_LINKAGE_FIELD_SET_VERSION,
      },
      keySet: {
        name: DEFAULT_LINKAGE_KEY_SET_NAME,
        version: DEFAULT_LINKAGE_KEY_SET_VERSION,
      },
    });
    expect(DEFAULT_LINKAGE_RULE_SET.linkageKeys.length).toBeGreaterThan(1);
    expect(DEFAULT_LINKAGE_RULE_SET.linkageFields.length).toBeGreaterThan(1);
  });
});

describe("linkageTermsFromRuleSet", () => {
  test("cites the set it drew from, with and without metadata", () => {
    expect(getDefaultLinkageTerms("Party A").linkageRuleSet).toStrictEqual(
      DEFAULT_LINKAGE_RULE_SET.reference,
    );
    const metadata: Metadata = [
      col("s", "ssn"),
      col("l", "last_name"),
      col("d", "date_of_birth"),
    ];
    expect(
      getDefaultLinkageTerms("Party A", metadata).linkageRuleSet,
    ).toStrictEqual(DEFAULT_LINKAGE_RULE_SET.reference);
  });

  test("cites the set even where the input narrows the emitted keys", () => {
    // The citation is an upper bound on what was tried, not a claim that every
    // key ran: a file with no first name drops the keys that need one, and the
    // narrowed document still cites the set those keys came from.
    const narrowed = getDefaultLinkageTerms("Party A", [
      col("s", "ssn"),
      col("l", "last_name"),
      col("d", "date_of_birth"),
    ]);
    expect(narrowed.linkageKeys.length).toBeLessThan(
      DEFAULT_LINKAGE_RULE_SET.linkageKeys.length,
    );
    expect(narrowed.linkageRuleSet).toStrictEqual(
      DEFAULT_LINKAGE_RULE_SET.reference,
    );
    expect(isDrawnFromLinkageRuleSet(DEFAULT_LINKAGE_RULE_SET, narrowed)).toBe(
      true,
    );
  });

  test("draws its rules from the set it is given, not from the default", () => {
    const ruleSet = {
      reference: {
        fieldSet: { name: "probe-pii", version: "3.1.0" },
        keySet: { name: "probe-keys", version: "3.1.0" },
      },
      linkageFields: [{ name: "ssn", type: "ssn" as const }],
      linkageKeys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
    };
    const terms = linkageTermsFromRuleSet(ruleSet, "Party A");
    expect(terms.linkageKeys).toEqual(ruleSet.linkageKeys);
    expect(terms.linkageFields).toEqual(ruleSet.linkageFields);
    expect(terms.linkageRuleSet).toStrictEqual(ruleSet.reference);
  });
});

describe("isDrawnFromLinkageRuleSet", () => {
  test("accepts the whole set and any order-preserving narrowing of it", () => {
    expect(
      isDrawnFromLinkageRuleSet(DEFAULT_LINKAGE_RULE_SET, wholeSet()),
    ).toBe(true);
    const rules = wholeSet();
    expect(
      isDrawnFromLinkageRuleSet(DEFAULT_LINKAGE_RULE_SET, {
        linkageFields: rules.linkageFields,
        linkageKeys: rules.linkageKeys.filter((_, index) => index % 2 === 0),
      }),
    ).toBe(true);
    expect(
      isDrawnFromLinkageRuleSet(DEFAULT_LINKAGE_RULE_SET, {
        linkageFields: [],
        linkageKeys: [],
      }),
    ).toBe(true);
  });

  test("refuses a reordered cascade", () => {
    // Key order is cascade order, so moving one changes which key claims a
    // record more than one would match -- different rules, not the same set.
    const rules = wholeSet();
    const [first, second, ...rest] = rules.linkageKeys;
    expect(
      isDrawnFromLinkageRuleSet(DEFAULT_LINKAGE_RULE_SET, {
        linkageFields: rules.linkageFields,
        linkageKeys: [second, first, ...rest],
      }),
    ).toBe(false);
  });

  test("refuses an added, repeated, or edited key", () => {
    const rules = wholeSet();
    const foreign: LinkageKey = {
      name: "SSN alone",
      elements: [{ field: "ssn" }],
    };
    expect(
      isDrawnFromLinkageRuleSet(DEFAULT_LINKAGE_RULE_SET, {
        linkageFields: rules.linkageFields,
        linkageKeys: [...rules.linkageKeys, foreign],
      }),
    ).toBe(false);
    expect(
      isDrawnFromLinkageRuleSet(DEFAULT_LINKAGE_RULE_SET, {
        linkageFields: rules.linkageFields,
        linkageKeys: [rules.linkageKeys[0], rules.linkageKeys[0]],
      }),
    ).toBe(false);
    const edited = structuredClone(rules.linkageKeys);
    edited[0].elements.push({ field: "ssn4" });
    expect(
      isDrawnFromLinkageRuleSet(DEFAULT_LINKAGE_RULE_SET, {
        linkageFields: rules.linkageFields,
        linkageKeys: edited,
      }),
    ).toBe(false);
  });

  test("refuses a repeated field, as it refuses a repeated key", () => {
    // Each declaration answers for one field: a candidate that names the same
    // declared field twice declares more than the set does. The terms schema
    // refines field names unique, so this is the predicate holding its own line
    // rather than a shape a valid document reaches.
    const rules = wholeSet();
    expect(
      isDrawnFromLinkageRuleSet(DEFAULT_LINKAGE_RULE_SET, {
        linkageFields: [...rules.linkageFields, rules.linkageFields[0]],
        linkageKeys: rules.linkageKeys,
      }),
    ).toBe(false);
  });

  test("refuses an edited or undeclared field", () => {
    const rules = wholeSet();
    const loosened = structuredClone(rules.linkageFields);
    const ssn = loosened.find((field) => field.name === "ssn");
    if (ssn === undefined) throw new Error("the built-in set declares no ssn");
    ssn.constraints = {};
    expect(
      isDrawnFromLinkageRuleSet(DEFAULT_LINKAGE_RULE_SET, {
        linkageFields: loosened,
        linkageKeys: rules.linkageKeys,
      }),
    ).toBe(false);
    expect(
      isDrawnFromLinkageRuleSet(DEFAULT_LINKAGE_RULE_SET, {
        linkageFields: [
          ...rules.linkageFields,
          { name: "phone", type: "phone_number" },
        ],
        linkageKeys: rules.linkageKeys,
      }),
    ).toBe(false);
  });

  test("answers false for rules outside the canonical encoding domain", () => {
    // A transform param beyond the safe integer range cannot be canonically
    // encoded, so it cannot be compared -- and rules carrying one are not the
    // built-in set, which carries no such value.
    const rules = wholeSet();
    const unencodable = structuredClone(rules.linkageKeys);
    unencodable[0].elements[0].transform = [
      { function: "substring", params: { start: Number.MAX_VALUE } },
    ];
    expect(
      isDrawnFromLinkageRuleSet(DEFAULT_LINKAGE_RULE_SET, {
        linkageFields: rules.linkageFields,
        linkageKeys: unencodable,
      }),
    ).toBe(false);
  });
});

describe("linkageRuleSetReferenceFor", () => {
  test("returns the built-in citation for rules drawn from it, and nothing otherwise", () => {
    expect(linkageRuleSetReferenceFor(wholeSet())).toStrictEqual(
      DEFAULT_LINKAGE_RULE_SET.reference,
    );
    expect(
      linkageRuleSetReferenceFor({
        linkageFields: [{ name: "ssn", type: "ssn" }],
        linkageKeys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
      }),
    ).toBeUndefined();
  });

  test("cites nothing over rules that declare no key", () => {
    // Keyless rules are drawn from every set vacuously -- the predicate says so
    // -- so the citation is decided here instead: it asserts that the keys came
    // from the named set, and a document declaring none carries no provenance.
    const empty = { linkageFields: [], linkageKeys: [] };
    expect(isDrawnFromLinkageRuleSet(DEFAULT_LINKAGE_RULE_SET, empty)).toBe(
      true,
    );
    expect(linkageRuleSetReferenceFor(empty)).toBeUndefined();
    // Field declarations left behind by the keys that referenced them do not
    // rescue the citation: they name none of the keys the set is cited for.
    expect(
      linkageRuleSetReferenceFor({
        linkageFields: [...DEFAULT_LINKAGE_RULE_SET.linkageFields],
        linkageKeys: [],
      }),
    ).toBeUndefined();
    // One key alone is enough to be judged on its content.
    expect(
      linkageRuleSetReferenceFor({
        linkageFields: [],
        linkageKeys: [DEFAULT_LINKAGE_RULE_SET.linkageKeys[0]],
      }),
    ).toStrictEqual(DEFAULT_LINKAGE_RULE_SET.reference);
  });

  test("reads the same over rules derived from the set, which drop a keyless derivation's fields", () => {
    // A derivation filters its fields to the ones its emitted keys reference, so
    // one that emits no key declares no field either -- which is what makes
    // deciding on the keys alone leave every derived document's citation where
    // it was.
    const noSupplyableKey = getDefaultLinkageTerms("Party A", [
      col("record_id", "identifier", "identifier"),
    ]);
    expect(noSupplyableKey.linkageKeys).toStrictEqual([]);
    expect(noSupplyableKey.linkageFields).toStrictEqual([]);
    expect(linkageRuleSetReferenceFor(noSupplyableKey)).toBeUndefined();
  });
});
