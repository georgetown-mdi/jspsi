import { describe, expect, test } from "vitest";

import {
  DEFAULT_LINKAGE_FIELD_SET_NAME,
  DEFAULT_LINKAGE_FIELD_SET_VERSION,
  DEFAULT_LINKAGE_KEY_SET_NAME,
  DEFAULT_LINKAGE_KEY_SET_VERSION,
  DEFAULT_LINKAGE_RULE_SET,
  checkLinkageRuleSetCitation,
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

/** The whole set, as a terms document's rules would hold it. */
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
    // encoded, so it cannot be compared -- and rules holding one are not the
    // built-in set, which holds no such value.
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
    // from the named set, and a document declaring none holds no provenance.
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
    // The derivation reaches the same answer on its own output: it emits the
    // citation it was asked to draw, so a run that emits no key emits no
    // citation either, rather than leaving the vacuous one to the downstream
    // rejection.
    expect(noSupplyableKey.linkageRuleSet).toBeUndefined();
  });
});

describe("checkLinkageRuleSetCitation", () => {
  const cite = (
    rules: Pick<LinkageTerms, "linkageFields" | "linkageKeys">,
    citation = DEFAULT_LINKAGE_RULE_SET.reference,
  ) => checkLinkageRuleSetCitation(citation, rules);

  test("reads a truthful citation as consistent on both halves", () => {
    expect(cite(wholeSet())).toStrictEqual({
      fieldSet: "consistent",
      keySet: "consistent",
    });
    // A narrowed emission is still drawn from the set: what an input file cannot
    // supply is left out, and nothing is added.
    const narrowed = getDefaultLinkageTerms("Party A", [
      col("s", "ssn"),
      col("l", "last_name"),
      col("d", "date_of_birth"),
    ]);
    expect(narrowed.linkageKeys.length).toBeLessThan(
      DEFAULT_LINKAGE_RULE_SET.linkageKeys.length,
    );
    expect(cite(narrowed)).toStrictEqual({
      fieldSet: "consistent",
      keySet: "consistent",
    });
  });

  test("reads rules the build can prove are not the set as contradicted", () => {
    // An added key, an edited field, and a reordered cascade: three of the edits
    // the drawn-from predicate refuses, each landing on the half it belongs to.
    const added = wholeSet();
    added.linkageKeys.push({
      name: "LN only",
      elements: [{ field: "last_name" }],
    });
    expect(cite(added)).toStrictEqual({
      fieldSet: "consistent",
      keySet: "contradicted",
    });

    const edited = wholeSet();
    delete edited.linkageFields[0].constraints;
    expect(cite(edited)).toStrictEqual({
      fieldSet: "contradicted",
      keySet: "consistent",
    });

    const reordered = wholeSet();
    reordered.linkageKeys.reverse();
    expect(cite(reordered).keySet).toBe("contradicted");
  });

  test("reads a set this build does not ship as unchecked, never contradicted", () => {
    // Nothing here resolves a partner's set name: an unresolvable name is not
    // compared against anything, whatever the declared rules turn out to be.
    const foreign = {
      fieldSet: { name: "county-pii", version: "3.1.0" },
      keySet: { name: "county-keys", version: "3.1.0" },
    };
    const edited = wholeSet();
    edited.linkageKeys.reverse();
    expect(cite(edited, foreign)).toStrictEqual({
      fieldSet: "unchecked",
      keySet: "unchecked",
    });
    expect(cite(wholeSet(), foreign)).toStrictEqual({
      fieldSet: "unchecked",
      keySet: "unchecked",
    });
  });

  test("resolves each half on its own name AND version", () => {
    // A half is resolvable only at the exact version this build ships: the name
    // alone identifies no fixed content, so a version it does not ship is a set
    // it cannot check.
    const shipped = DEFAULT_LINKAGE_RULE_SET.reference;
    expect(
      cite(wholeSet(), {
        fieldSet: shipped.fieldSet,
        keySet: { name: shipped.keySet.name, version: "2.3.0" },
      }),
    ).toStrictEqual({ fieldSet: "consistent", keySet: "unchecked" });
    expect(
      cite(wholeSet(), {
        fieldSet: { name: "county-pii", version: "3.1.0" },
        keySet: shipped.keySet,
      }),
    ).toStrictEqual({ fieldSet: "unchecked", keySet: "consistent" });
  });

  test("agrees with the whole-set predicate wherever both halves resolve", () => {
    // The verdict IS the drawn-from predicate, taken per half: it widens and
    // narrows that notion nowhere.
    const addedKey = wholeSet();
    addedKey.linkageKeys.push({
      name: "LN only",
      elements: [{ field: "last_name" }],
    });
    const reordered = wholeSet();
    reordered.linkageKeys.reverse();
    const editedField = wholeSet();
    delete editedField.linkageFields[0].constraints;
    for (const rules of [wholeSet(), addedKey, reordered, editedField]) {
      const verdicts = cite(rules);
      const bothConsistent =
        verdicts.fieldSet === "consistent" && verdicts.keySet === "consistent";
      expect(bothConsistent).toBe(
        isDrawnFromLinkageRuleSet(DEFAULT_LINKAGE_RULE_SET, rules),
      );
    }
  });
});

describe("the built-in citation resists mutation", () => {
  test("the reference and its halves are frozen, in place and by replacement", () => {
    // The one object is aliased into every derived terms document and from there
    // into each party's exchange record, so an in-place edit would rewrite the
    // built-in citation process-wide. Module code is strict, so each attempt
    // throws rather than silently failing.
    const reference = DEFAULT_LINKAGE_RULE_SET.reference as {
      keySet: { name: string; version: string };
      fieldSet: { name: string; version: string };
    };
    expect(() => {
      reference.keySet.name = "poisoned-keys";
    }).toThrow(TypeError);
    expect(() => {
      reference.fieldSet.version = "9.9.9";
    }).toThrow(TypeError);
    expect(() => {
      reference.keySet = { name: "poisoned-keys", version: "9.9.9" };
    }).toThrow(TypeError);
    expect(() => {
      (DEFAULT_LINKAGE_RULE_SET as { reference: unknown }).reference = {
        fieldSet: { name: "poisoned-pii", version: "9.9.9" },
        keySet: { name: "poisoned-keys", version: "9.9.9" },
      };
    }).toThrow(TypeError);

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
    // And a document derived after those attempts still cites the real set.
    expect(getDefaultLinkageTerms("Party A").linkageRuleSet).toStrictEqual(
      DEFAULT_LINKAGE_RULE_SET.reference,
    );
  });

  test("the declared rules are frozen through their contents, arrays and members alike", () => {
    // The same aliasing as the reference, over what the citation is CHECKED
    // against: an in-place edit of a field's constraints or of a key's elements
    // would move what counts as drawn from the built-in set for every later
    // verdict, while the declarations the drift checks pin stayed put.
    const set = DEFAULT_LINKAGE_RULE_SET as unknown as {
      linkageFields: Array<{
        name: string;
        constraints?: { exclude?: Array<string>; validOnly?: boolean };
      }>;
      linkageKeys: Array<{
        name: string;
        elements: Array<{
          field: string;
          transform?: Array<{ function: string; params: { start?: number } }>;
        }>;
      }>;
    };
    const [firstField] = set.linkageFields;
    const [firstKey] = set.linkageKeys;

    expect(() => {
      set.linkageFields.push({ name: "poisoned", type: "ssn" } as never);
    }).toThrow(TypeError);
    expect(() => {
      firstField.name = "poisoned";
    }).toThrow(TypeError);
    expect(() => {
      if (firstField.constraints !== undefined)
        firstField.constraints.validOnly = false;
    }).toThrow(TypeError);
    expect(() => {
      firstField.constraints?.exclude?.push("999999999");
    }).toThrow(TypeError);
    expect(() => {
      set.linkageKeys.reverse();
    }).toThrow(TypeError);
    expect(() => {
      firstKey.elements[0].field = "poisoned";
    }).toThrow(TypeError);
    expect(() => {
      const [transform] = firstKey.elements
        .map((element) => element.transform)
        .filter((entry) => entry !== undefined);
      transform[0].params.start = 99;
    }).toThrow(TypeError);

    // The verdict a citation of the set reaches is what those edits were aimed
    // at, and it is the one the untouched set gives.
    expect(
      checkLinkageRuleSetCitation(DEFAULT_LINKAGE_RULE_SET.reference, {
        linkageFields: [...DEFAULT_LINKAGE_RULE_SET.linkageFields],
        linkageKeys: [...DEFAULT_LINKAGE_RULE_SET.linkageKeys],
      }),
    ).toStrictEqual({ fieldSet: "consistent", keySet: "consistent" });
  });
});
